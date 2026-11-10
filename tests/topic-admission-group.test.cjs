'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTopicAdmissionGroup } = require('../modules/services/topicAdmissionGroup');

const scope = { itemType: 'group', itemId: 'g1', topicId: 't1' };
const request = () => ({ scope: { ...scope }, token: 'lease1', messageId: 'm1' });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
    return createTopicAdmissionGroup({
        loadGroupConfig: async () => ({ topics: [{ id: 't1' }] }),
        readHistory: async () => [{
            id: 'm1', role: 'assistant', name: 'Guest', content: '真实留言',
            attachments: [{ name: 'asset' }],
        }],
        runGroup: async () => {},
        ...overrides,
    });
}

test('accepts without waiting for generation and freezes target and payload', async () => {
    let args;
    let finish;
    const history = [{ id: 'm1', role: 'assistant', name: 'Guest', content: '真实留言',
        attachments: [{ name: 'asset' }] }];
    const advance = fixture({
        readHistory: async () => history,
        runGroup: (...values) => { args = values; return new Promise(resolve => { finish = resolve; }); },
    });
    const input = request();
    const result = await advance(input);
    assert.equal(result.accepted, true);
    input.scope.itemId = 'other';
    history[0].attachments[0].name = 'changed';
    await tick();
    assert.deepEqual(args.slice(0, 2), ['g1', 't1']);
    assert.equal(args[2].attachments[0].name, 'asset');
    assert.equal(args[2].name, 'Guest');
    assert.equal(args[2].role, undefined);
    assert.deepEqual(args[3], { committedMessageId: 'm1', admissionToken: 'lease1' });
    finish();
});

test('rejects deleted, missing or game target without scheduling', async () => {
    for (const config of [null, { error: 'deleted' }, { topics: [] },
        { mode: 'game', topics: [{ id: 't1' }] }]) {
        let called = false;
        const advance = fixture({ loadGroupConfig: async () => config, runGroup: () => { called = true; } });
        await assert.rejects(advance(request()), /目标群聊话题/);
        assert.equal(called, false);
    }
    await assert.rejects(fixture()( { ...request(), scope: { ...scope, itemType: 'agent' } }), /Invalid/);
});

test('requires actual committed message rather than manufacturing a user message', async () => {
    for (const history of [[], [{ id: 'm1', role: 'system', content: 'not user' }]]) {
        await assert.rejects(fixture({ readHistory: async () => history })(request()), /消息不存在或角色无效/);
    }
});

test('background rejection reports retained lease diagnostics', async () => {
    const logs = [];
    const error = new Error('save status unknown');
    const result = await fixture({
        runGroup: async () => { throw error; },
        logger: { error: (...args) => logs.push(args) },
    })(request());
    assert.equal(result.accepted, true);
    await tick();
    assert.equal(logs.length, 1);
    assert.equal(logs[0][1].token, 'lease1');
    assert.equal(logs[0][1].error, error);
});
test('only human requests consume frozen expanded text while preserving original history text', async () => {
    for (const role of ['user', 'assistant']) {
        let payload;
        const advance = fixture({
            readHistory: async () => [{ id: 'm1', role, content: 'raw',
                _metadata: { groupRequestText: 'raw + expanded file' } }],
            runGroup: async (_group, _topic, value) => { payload = value; },
        });
        await advance(request());
        await tick();
        assert.equal(payload.originalUserText, 'raw');
        assert.equal(payload.content.text, role === 'user' ? 'raw + expanded file' : 'raw');
    }
});
test('background failure journals uncertainty and contains journal rejection', async () => {
    const reports = [];
    const logs = [];
    await fixture({
        runGroup: async () => { throw new Error('execution failed'); },
        reportUncertain: async (...args) => {
            reports.push(args);
            throw new Error('journal unavailable');
        },
        logger: { error: (...args) => logs.push(args) },
    })(request());
    await tick();
    assert.equal(reports.length, 1);
    assert.equal(reports[0][0].topicId, 't1');
    assert.equal(reports[0][1], 'lease1');
    assert.equal(reports[0][2].message, 'execution failed');
    assert.equal(logs.length, 2);
    assert.match(logs[1][0], /cannot journal/);
});