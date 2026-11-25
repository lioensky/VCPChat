'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, rm, readFile, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { openTopicReplyStore } = require('../modules/services/topicReplyStore');
const { createTopicReplyDispatcher } = require('../modules/services/topicReplyDispatcher');
const { createTopicReplyTransport } = require('../modules/services/topicReplyTransport');
const { createTopicReplyRuntime } = require('../modules/services/topicReplyRuntime');

const topicId = 'topic_example';
const sample = { topicId, requestId: 'request-1', message: '## Review\n\n- **Ready**' };
const queued = { success: true, queued: true, entryId: 'mock-entry' };

function credential(credentialId, flags = {}) {
    const token = randomBytes(32).toString('hex');
    return { token, auth: {
        credentialId, tokenDigest: createHash('sha256').update(token).digest(),
        senderId: 'agent_example', allowedTopicIds: new Set([topicId]), allowAdvance: false,
        defaultAdvance: false, ...flags
    } };
}

async function fixture(t, processToolCall, overrides = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'topic-reply-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, 'records.json');
    const store = await openTopicReplyStore(file);
    const dispatcher = createTopicReplyDispatcher({ store, processToolCall, ...overrides });
    return { file, dir, dispatcher };
}

test('HTTP authentication, identity isolation and advance authorization', async t => {
    const calls = [];
    const { dispatcher } = await fixture(t, (...args) => { calls.push(args); return queued; });
    const a = credential('a');
    const b = credential('b', { allowAdvance: true, defaultAdvance: true });
    const transport = createTopicReplyTransport({ dispatcher, credentials: [a.auth, b.auth], port: 0 });
    const port = await transport.start();
    t.after(() => transport.stop());
    async function post(token, value, suffix = '', extra = {}) {
        const response = await fetch(`http://127.0.0.1:${port}/v1/topic-replies${suffix}`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra },
            body: JSON.stringify(value)
        });
        return { status: response.status, body: await response.json() };
    }
    assert.deepEqual(await post('invalid', sample), { status: 401, body: { error: 'AUTH_REQUIRED' } });
    assert.equal((await post(a.token, sample, '', { Origin: 'null' })).status, 403);
    assert.equal((await post(a.token, { ...sample, senderId: 'spoof' })).status, 400);
    assert.equal((await post(a.token, { ...sample, topicId: 'topic_denied' })).body.error, 'TOPIC_DENIED');
    assert.equal((await post(a.token, { ...sample, advance: true })).body.error, 'ADVANCE_DENIED');
    assert.equal(calls.length, 0);
    const first = await post(a.token, sample);
    assert.deepEqual(first.body, { requestId: sample.requestId, state: 'queued',
        advanceRequested: null, advanceEffective: false, entryId: queued.entryId });
    const query = { requestId: sample.requestId };
    assert.deepEqual((await post(a.token, query, '/status')).body, first.body);
    assert.equal((await post(b.token, query, '/status')).body.state, 'not_found');
    assert.equal((await post(b.token, sample)).body.advanceEffective, true);
    assert.equal((await post(b.token, { ...sample, requestId: 'silent', advance: false })).body.advanceEffective, false);
    assert.deepEqual(calls.map(call => call[2].topicSponsorReplyPolicy), [false, true, false]
        .map(enabled => ({ enabled, prompt: '' })));
    assert.equal(calls[0][0], 'TopicSponsor');
    assert.equal(calls[0][1].sender_id, a.auth.senderId);
    assert.notEqual(calls[0][2].requestId, calls[1][2].requestId);
});

test('durable pre-reservation, concurrent dedupe, revocation and raw Markdown boundary', async t => {
    let release;
    let onEntered;
    const entered = new Promise(resolve => { onEntered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const calls = [];
    const { file, dispatcher } = await fixture(t, (...args) => { calls.push(args); onEntered(); return hold; });
    const { auth } = credential('a', { allowAdvance: true, defaultAdvance: true });
    const markers = ['TOOL_REQUEST', 'END_TOOL_REQUEST', 'DESKTOP_PUSH', 'DESKTOP_PUSH_END']
        .map(name => '<'.repeat(3) + `[${name}]` + '>'.repeat(3));
    markers.push('[[' + 'Flowlock::Start]]');
    const body = `${sample.message}\n\n\`\`\`text\n${markers.join('\n')}\n\`\`\``;
    const input = { ...sample, message: body };
    const first = dispatcher.dispatch(auth, input);
    await entered;
    const disk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(disk.records[0].state, 'inflight');
    assert.equal((await dispatcher.dispatch(auth, input)).state, 'inflight');
    await assert.rejects(dispatcher.dispatch(auth, { ...input, advance: true }), { code: 'REQUEST_CONFLICT' });
    const sent = calls[0][1].message;
    assert.ok(sent.includes(`${sample.message}\n\n\`\`\`text\n`));
    assert.ok(markers.every(marker => !sent.includes(marker)));
    release(queued);
    const saved = await first;
    const rotated = { ...auth, defaultAdvance: false };
    assert.deepEqual(await dispatcher.dispatch(rotated, input), saved);
    assert.equal(saved.advanceEffective, true);
    assert.equal((await dispatcher.inspect({ ...auth, allowedTopicIds: new Set() },
        { requestId: input.requestId })).state, 'not_found');
    assert.equal(calls.length, 1);
});

test('timeout and restart inflight recovery never repeat host call; invalid ledger stays closed', async t => {
    let calls = 0;
    let late;
    const { file, dir, dispatcher } = await fixture(t, () => {
        calls++;
        return new Promise(resolve => { late = resolve; });
    }, { timeoutMs: 15 });
    const { auth } = credential('a');
    assert.equal((await dispatcher.dispatch(auth, sample)).state, 'uncertain');
    late(queued);
    assert.equal((await dispatcher.inspect(auth, { requestId: sample.requestId })).state, 'uncertain');
    const snapshot = JSON.parse(await readFile(file, 'utf8'));
    snapshot.records[0].state = 'inflight'; // Simulate disk left between reservation and completion.
    await writeFile(file, JSON.stringify(snapshot));
    const restarted = createTopicReplyDispatcher({
        store: await openTopicReplyStore(file), processToolCall: () => { calls++; return queued; }
    });
    assert.equal((await restarted.dispatch(auth, sample)).state, 'uncertain');
    assert.equal(calls, 1);
    await writeFile(file, '{broken');
    await assert.rejects(openTopicReplyStore(file));
    assert.equal(await readFile(file, 'utf8'), '{broken');
    assert.equal(await createTopicReplyRuntime({ appDataRoot: dir }), null);
});