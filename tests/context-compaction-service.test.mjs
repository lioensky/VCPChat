import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextCompactionService } from '../modules/chat/contextCompactionService.js';
import { createChatHistoryMutationAuthority } from '../modules/chat/chatHistoryMutationAuthority.js';
import { effectiveContextHistory } from '../modules/chat/contextCompactionState.js';

const scope = { itemId: 'agent', itemType: 'agent', topicId: 'topic' };
const settings = { enableContextCompaction: true, contextCompactionModel: 'compressor' };
const checkpoint = '<context_checkpoint>\n任务状态\n</context_checkpoint>'.replaceAll('<', '<').replaceAll('>', '>');
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

function fixture(options = {}) {
    let durable = [{ id: 'old', role: 'user', content: '任务', timestamp: 1 }];
    const events = [];
    const authority = createChatHistoryMutationAuthority({
        repository: {
            getHistory: async () => structuredClone(durable),
            async saveHistory(_id, _type, _topic, history) {
                events.push('save');
                if (options.saveFailure) throw new Error('save failed');
                durable = structuredClone(history);
                return { success: true };
            },
        },
    });
    const lease = {};
    const service = createContextCompactionService({
        historyMutationAuthority: authority,
        request: options.request || (async () => checkpoint),
        timeoutMs: options.timeoutMs || 1000,
        onBusyChanged: (_scope, busy) => events.push(`busy:${busy}`),
        flowlock: {
            suspendForContextCompaction() { events.push('suspend'); return lease; },
            resumeAfterContextCompaction(value) { assert.equal(value, lease); events.push('resume'); },
        },
    });
    return {
        service, events,
        history: () => structuredClone(durable),
        change: () => durable.push({ role: 'assistant', content: '新增' }),
        compact: () => service.compact({ scope, settings, history: structuredClone(durable) }),
    };
}

test('checkpoint appends without deleting history; heartbeat resumes only after durable commit', async () => {
    const f = fixture();
    const result = await f.compact();
    assert.deepEqual(f.events, ['suspend', 'busy:true', 'save', 'resume', 'busy:false']);
    assert.equal(f.history().length, 2);
    assert.equal(effectiveContextHistory(f.history()).length, 1);
    assert.equal(result.message.role, 'user');
});

test('busy topic rejects a duplicate; changed history cannot publish a stale checkpoint', async () => {
    const gate = deferred();
    const f = fixture({ request: () => gate.promise });
    const pending = f.compact();
    assert.equal(f.service.isBusy(scope), true);
    await assert.rejects(f.compact(), /正在压缩/);
    f.change();
    gate.resolve(checkpoint);
    await assert.rejects(pending, /历史已变化/);
    assert.equal(f.history().length, 2);
    assert.equal(f.events.includes('resume'), false);
    assert.equal(f.service.isBusy(scope), false);
});

for (const [name, options, pattern] of [
    ['save failure', { saveFailure: true }, /save failed/],
    ['empty response', { request: async () => '' }, /有效文本/],
    ['network failure', { request: async () => { throw new Error('offline'); } }, /offline/],
    ['timeout', { request: () => new Promise(() => {}), timeoutMs: 5 }, /取消|超时/],
]) {
    test(`${name} preserves history and leaves heartbeat suspended`, async () => {
        const f = fixture(options);
        await assert.rejects(f.compact(), pattern);
        assert.equal(f.history().length, 1);
        assert.equal(f.events.includes('resume'), false);
        assert.equal(f.service.isBusy(scope), false);
        assert.equal(f.events.at(-1), 'busy:false');
    });
}

test('group chats are rejected before acquiring a lease', async () => {
    const f = fixture();
    await assert.rejects(f.service.compact({
        scope: { ...scope, itemType: 'group' }, settings, history: f.history(),
    }), /仅支持单聊/);
    assert.deepEqual(f.events, []);
});

test('dispose cancels an in-flight request without committing', async () => {
    const f = fixture({ request: () => new Promise(() => {}) });
    const pending = f.compact();
    f.service.dispose();
    await assert.rejects(pending, /取消/);
    assert.equal(f.history().length, 1);
    assert.equal(f.events.includes('resume'), false);
});

test('HTTP compression response preserves text regardless of finish reason or tool metadata', async () => {
    const { requestContextCompaction } = await import('../modules/chat/contextCompactionService.js');
    const { validateCheckpoint } = await import('../modules/chat/contextCompactionState.js');
    const run = choice => requestContextCompaction({
        settings: { ...settings, vcpServerUrl: 'https://fixture.local/v1/chat/completions' },
        state: { messages: [{ role: 'user', content: '真实任务历史' }] },
        fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [choice] }) }),
    });
    const content = [{ type: 'text', text: `以下是结果：\n\`\`\`xml\n${checkpoint}\n\`\`\`` }];
    assert.equal(validateCheckpoint(await run({ message: { content }, finish_reason: 'stop' })), content[0].text);
    for (const choice of [
        { message: { content: checkpoint }, finish_reason: 'length' },
        { message: { content: checkpoint, refusal: 'refused' }, finish_reason: 'stop' },
        { message: { content: checkpoint, tool_calls: [{}] }, finish_reason: 'stop' },
        { message: { content: checkpoint, function_call: { name: 'tool' } }, finish_reason: 'stop' },
    ]) assert.equal(await run(choice), checkpoint);
    assert.equal(await run({ message: { refusal: '拒绝正文' }, finish_reason: 'content_filter' }), '拒绝正文');
});

test('unclosed report commits verbatim without tag parsing', async () => {
    const raw = '<context_checkpoint>只有开头的实际返回';
    const f = fixture({
        request: async ({ onResponse }) => {
            onResponse({ model: 'fixture-model', finishReason: 'stop', content: raw });
            return raw;
        },
    });
    const result = await f.compact();
    assert.equal(result.message.contextCompaction.checkpoint, raw);
    assert.equal(f.history().length, 2);
    assert.equal(f.service.isBusy(scope), false);
    assert.equal(f.events.includes('resume'), true);
});

test('HTTP request carries actual role-bearing history before the final instruction', async () => {
    const { requestContextCompaction } = await import('../modules/chat/contextCompactionService.js');
    const { prepareCompactionState } = await import('../modules/chat/contextCompactionState.js');
    const history = [
        { role: 'user', content: '修复 src/core/kbm.rs，expectedRevision: 12，不要删除文件。' },
        { role: 'assistant', content: { text: '已检查端口 8123，下一步运行测试。\n<literal>原文</literal>' } },
    ];
    for (const sendPrompt of ['', '自定义任务 {{conversation_history}}', '自定义任务，无占位符']) {
        let body;
        await requestContextCompaction({
            settings: { ...settings, vcpServerUrl: 'https://fixture.local/v1/chatvcp/completions',
                contextCompactionSendPrompt: sendPrompt },
            state: prepareCompactionState(history),
            fetchImpl: async (url, init) => {
                assert.equal(url, 'https://fixture.local/v1/chat/completions');
                body = JSON.parse(init.body);
                return { ok: true, json: async () => ({ choices: [{ message: { content: checkpoint } }] }) };
            },
        });
        assert.deepEqual(body.messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
        assert.equal(body.messages[1].content, history[0].content);
        assert.equal(body.messages[2].content, history[1].content.text);
        assert.match(body.messages.at(-1).content, /2 条独立消息/);
        assert.match(body.messages.at(-1).content, /禁止续写/);
        assert.ok(!body.messages.at(-1).content.includes('{{conversation_history}}'));
        assert.ok(!body.messages.at(-1).content.includes(history[0].content));
    }
});

test('second HTTP compaction sends latest checkpoint plus new history, not older history or diaries', async () => {
    const { requestContextCompaction } = await import('../modules/chat/contextCompactionService.js');
    const { prepareCompactionState } = await import('../modules/chat/contextCompactionState.js');
    const { createCheckpointMessage } = await import('../modules/chat/contextCompactionPrompts.js');
    const saved = createCheckpointMessage({
        diaries: [{ content: 'SECRET_DIARY' }], warnings: [], sourceCount: 1,
    }, '上一轮真实任务状态：修复 src/core/kbm.rs');
    let body;
    await requestContextCompaction({
        settings: { ...settings, vcpServerUrl: 'https://fixture.local/v1/chat/completions' },
        state: prepareCompactionState([
            { role: 'user', content: 'OBSOLETE_OLD_HISTORY' }, saved,
            { role: 'assistant', content: '中止前新增结果：Revision 13，待测试。' },
        ]),
        fetchImpl: async (_url, init) => {
            body = JSON.parse(init.body);
            return { ok: true, json: async () => ({ choices: [{ message: { content: checkpoint } }] }) };
        },
    });
    assert.equal(body.messages[1].content, saved.contextCompaction.checkpoint);
    assert.equal(body.messages[2].content, '中止前新增结果：Revision 13，待测试。');
    assert.ok(!JSON.stringify(body).includes('SECRET_DIARY'));
    assert.ok(!JSON.stringify(body).includes('OBSOLETE_OLD_HISTORY'));
});

test('cancel uses upstream Stop reply ID and rejects late reports without resuming heartbeat', async () => {
    const gate = deferred();
    const interrupts = [];
    let requestId;
    let signal;
    let durable = [{ role: 'user', content: '原始任务' }];
    const service = createContextCompactionService({
        historyMutationAuthority: createChatHistoryMutationAuthority({
            repository: {
                getHistory: async () => durable,
                saveHistory: async (_id, _type, _topic, history) => { durable = history; },
            },
        }),
        request: options => {
            requestId = options.requestId;
            signal = options.signal;
            return gate.promise;
        },
        interruptRequest: id => { interrupts.push(id); return new Promise(() => {}); },
        flowlock: { resumeAfterContextCompaction() { assert.fail('cancelled compression must not resume heartbeat'); } },
    });
    const pending = service.compact({ scope, settings, history: durable });
    const rejected = assert.rejects(pending, /取消/);
    assert.match(requestId, /^compaction_/);
    assert.equal(service.cancel({ ...scope, topicId: 'other' }), false);
    assert.equal(service.cancel(scope), true);
    assert.equal(service.cancel(scope), false);
    assert.deepEqual(interrupts, [requestId]);
    assert.equal(signal.aborted, true);
    await rejected;
    assert.equal(service.isBusy(scope), false);
    gate.resolve(checkpoint);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(durable.length, 1);
    service.dispose();
});

test('compression HTTP body carries the request ID used by Stop reply', async () => {
    const { requestContextCompaction } = await import('../modules/chat/contextCompactionService.js');
    await requestContextCompaction({
        settings: { ...settings, vcpServerUrl: 'https://fixture.local/v1/chat/completions' },
        state: { messages: [{ role: 'user', content: '任务' }] },
        requestId: 'compaction-interrupt-target',
        fetchImpl: async (_url, init) => {
            assert.equal(JSON.parse(init.body).requestId, 'compaction-interrupt-target');
            return { ok: true, json: async () => ({ choices: [{ message: { content: checkpoint } }] }) };
        },
    });
});