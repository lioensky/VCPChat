'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('node:path');
const os = require('node:os');
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');
const { createTopicMessageAdmissionHost } = require('../modules/services/topicMessageAdmissionHost');

const tick = () => new Promise(resolve => setImmediate(resolve));
test('host IPC enforces sender, commits in admission order and acknowledges advancement', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-admission-host-'));
    t.after(() => fs.remove(root));
    const scope = { itemType: 'agent', itemId: 'a', topicId: 'topic_a' };
    const queue = new HistoryMutationQueue({ userDataDir: path.join(root, 'UserData') });
    const file = queue.getHistoryPath(scope.itemId, scope.topicId);
    await fs.outputJson(file, [{ id: 'previous', timestamp: Date.now() + 1000 }]);
    const handlers = new Map();
    const events = [];
    const contents = { id: 1, isDestroyed: () => false, send: (channel, payload) => events.push({ channel, payload }) };
    const host = await createTopicMessageAdmissionHost({
        appDataRoot: root, historyQueue: queue, validate: async () => {},
        getMainWindow: () => ({ isDestroyed: () => false, webContents: contents }),
        ipcMain: {
            handle: (channel, handler) => handlers.set(channel, handler),
            removeHandler: channel => handlers.delete(channel),
        },
    });
    t.after(async () => { await host.dispose(); await queue.dispose(); });
    const invoke = (name, ...args) => handlers.get(`topic-admission:${name}`)({ sender: contents }, ...args);
    assert.equal((await handlers.get('topic-admission:list')({ sender: {} })).code, 'FORBIDDEN');
    await invoke('acquire', scope, 'existing-round');
    const pending = await invoke('submit', {
        scope, message: { id: 'withdraw', role: 'user', timestamp: 1, content: '不要发送' },
    });
    assert.equal((await invoke('withdraw', scope, pending.entryId)).success, true);
    await invoke('submit', {
        scope, message: { id: 'human', role: 'user', timestamp: 1, content: '发送' }, triggerPolicy: 'reply',
    });
    await invoke('release', scope, 'existing-round');
    for (let i = 0; i < 100 && !events.some(event => event.channel === 'topic-admission:advance'); i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    const advance = events.find(event => event.channel === 'topic-admission:advance')?.payload;
    assert.ok(advance);
    const history = await fs.readJson(file);
    assert.deepEqual(history.map(message => message.id), ['previous', 'human']);
    assert.ok(history[1].timestamp > history[0].timestamp);
    assert.equal((await invoke('ack', advance.token)).success, true);
    await tick();
    assert.equal((await invoke('ack', advance.token)).code, 'STALE_REQUEST');
    assert.equal((await handlers.get('topic-admission:uncertain')({ sender: {} }, scope, advance.token, 'disk full')).code, 'FORBIDDEN');
    assert.equal((await invoke('uncertain', scope, 'old-token', 'late failure')).code, 'STALE_LEASE');
    assert.equal((await invoke('uncertain', scope, advance.token, 'disk full')).retained, true);
    assert.equal((await invoke('list', scope)).entries[0].state, 'uncertain');
    assert.equal((await invoke('acquire', scope, 'intruder')).code, 'TOPIC_BUSY');
    assert.equal((await invoke('resume', scope)).code, 'TOPIC_BUSY');
    assert.equal((await invoke('release', scope, advance.token)).success, true);
    assert.deepEqual((await invoke('list')).entries, []);
});
for (const connected of [false, true]) {
    test(`group advancement ${connected ? 'uses host adapter' : 'pauses when disconnected'} without renderer dispatch`, async t => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-admission-group-'));
        t.after(() => fs.remove(root));
        const queue = new HistoryMutationQueue({ userDataDir: path.join(root, 'UserData') });
        const scope = { itemType: 'group', itemId: 'g', topicId: 't' };
        await fs.outputJson(queue.getHistoryPath('g', 't'), []);
        const events = [];
        const calls = [];
        const contents = { id: 1, isDestroyed: () => false,
            send: (channel, payload) => events.push({ channel, payload }) };
        const host = await createTopicMessageAdmissionHost({
            appDataRoot: root, historyQueue: queue, validate: async () => {},
            getMainWindow: () => ({ isDestroyed: () => false, webContents: contents }),
            ipcMain: { handle() {}, removeHandler() {} },
            advanceGroup: connected ? async (request, admission) => {
                calls.push(request);
                assert.equal((await admission.acquire(scope, 'intruder')).code, 'TOPIC_BUSY');
                await admission.release(scope, request.token);
            } : null,
        });
        t.after(async () => { await host.dispose(); await queue.dispose(); });
        await host.service.submit({
            scope, message: { id: 'visitor', role: 'assistant', content: 'hello' },
            triggerPolicy: 'reply',
        });
        const deadline = Date.now() + 3000;
        while (connected ? !(calls.length && !host.service.snapshot().length)
            : host.service.snapshot()[0]?.state !== 'failed') {
            assert.ok(Date.now() < deadline, 'group routing must reach its terminal admission state');
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(events.some(event => event.channel === 'topic-admission:advance'), false);
        assert.equal((await queue.read(scope))[0].id, 'visitor');
        if (connected) {
            assert.equal(calls.length, 1);
            assert.deepEqual(host.service.snapshot(), []);
        } else {
            assert.equal(host.service.snapshot()[0].state, 'failed');
            assert.match(host.service.snapshot()[0].error, /群聊推进运行时尚未接通/);
        }
    });
}
test('assistant terminal IPC updates only its ID against latest history and refuses deleted topics', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-terminal-host-'));
    const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
    const queue = new HistoryMutationQueue({ userDataDir: path.join(root, 'users') });
    await queue.replace(scope, [
        { id: 'human', role: 'user', content: 'edited concurrently' },
        { id: 'reply', role: 'assistant', content: 'partial', feedback: 'preserve' },
    ]);
    const handlers = new Map();
    const contents = { id: 1, isDestroyed: () => false, send() {} };
    const host = await createTopicMessageAdmissionHost({
        appDataRoot: root, historyQueue: queue, validate: async () => {},
        getMainWindow: () => ({ isDestroyed: () => false, webContents: contents }),
        ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler() {} },
    });
    t.after(async () => { await host.dispose(); await queue.dispose(); await fs.remove(root); });
    const handler = handlers.get('topic-admission:persist-assistant');
    const invoke = message => handler({ sender: contents }, scope, message);
    const terminal = { id: 'reply', role: 'assistant', content: 'final', isThinking: false };
    assert.equal((await handler({ sender: {} }, scope, terminal)).code, 'FORBIDDEN');
    await queue.mutate(scope, history => [...history, { id: 'visitor', role: 'assistant', content: 'new visitor' }]);
    assert.equal((await invoke(terminal)).success, true);
    assert.equal((await invoke(terminal)).success, true);
    const history = await queue.read(scope);
    assert.deepEqual(history.map(message => message.id), ['human', 'reply', 'visitor']);
    assert.equal(history[0].content, 'edited concurrently');
    assert.equal(history[1].feedback, 'preserve');
    assert.equal(history[1].content, 'final');
    assert.equal((await invoke({ ...terminal, id: 'human' })).success, false);
    assert.equal((await invoke({ ...terminal, isPendingStream: true })).success, false);
    const directory = path.dirname(queue.getHistoryPath('a', 't'));
    await queue.run(scope, () => fs.remove(directory));
    assert.equal((await invoke(terminal)).success, false);
    assert.equal(await fs.pathExists(directory), false);
});

for (const mode of ['missing', 'wrong-token', 'thinking', 'ambiguous', 'valid']) {
    test(`reconcile host reads exact durable terminal evidence: ${mode}`, async t => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-reconcile-'));
        const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
        const queue = new HistoryMutationQueue({ userDataDir: path.join(root, 'users') });
        const terminal = {
            id: 'terminal', role: 'assistant', admissionToken: 'lease',
            admissionTerminal: true, isThinking: false, content: 'saved',
        };
        const history = mode === 'missing' ? []
            : mode === 'wrong-token' ? [{ ...terminal, admissionToken: 'another' }]
            : mode === 'thinking' ? [{ ...terminal, isThinking: true }]
            : mode === 'ambiguous' ? [terminal, { ...terminal, id: 'duplicate' }]
            : [terminal];
        await queue.replace(scope, history);
        await fs.outputJson(path.join(root, 'TopicMessageQueue', 'pending.json'), {
            version: 1, entries: [{
                entryId: 'batch', scope, state: 'advancing', committed: true,
                commitStarted: true, leaseToken: 'lease',
                message: { id: 'human', role: 'user', content: 'question' },
            }],
        });
        const handlers = new Map();
        const events = [];
        const contents = { id: 1, isDestroyed: () => false,
            send: (channel, payload) => events.push({ channel, payload }) };
        const host = await createTopicMessageAdmissionHost({
            appDataRoot: root, historyQueue: queue, validate: async () => {},
            getMainWindow: () => ({ isDestroyed: () => false, webContents: contents }),
            ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler() {} },
        });
        t.after(async () => { await host.dispose(); await queue.dispose(); await fs.remove(root); });
        const handler = handlers.get('topic-admission:reconcile');
        assert.equal((await handler({ sender: {} }, scope, 'batch')).code, 'FORBIDDEN');
        assert.equal((await handler({ sender: contents }, { ...scope, topicId: 'wrong' }, 'batch')).code,
            'NOT_UNCONFIRMED');
        const result = await handler({ sender: contents }, scope, 'batch');
        assert.equal(result.success, mode === 'valid');
        if (mode === 'valid') {
            assert.equal(result.messageId, 'terminal');
            assert.deepEqual(host.service.snapshot(scope), []);
        } else {
            assert.equal(result.code, 'TERMINAL_UNCONFIRMED');
            assert.equal(host.service.snapshot(scope)[0].state, 'uncertain');
        }
        assert.deepEqual(await queue.read(scope), history);
        assert.equal(events.some(event => event.channel === 'topic-admission:advance'), false);
        const journal = await fs.readJson(path.join(root, 'TopicMessageQueue', 'pending.json'));
        assert.equal(journal.entries.length, mode === 'valid' ? 0 : 1);
    });
}
test('relay IPC admits silent letters on disk and dispatches exactly one continuation under main-window authority', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-relay-host-'));
    t.after(() => fs.remove(root));
    const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
    const queue = new HistoryMutationQueue({ userDataDir: path.join(root, 'UserData') });
    await fs.outputJson(queue.getHistoryPath('a', 't'), [
        { id: 'old-terminal', role: 'assistant', content: 'tools returned',
            admissionToken: 'old', admissionTerminal: true },
    ]);
    const handlers = new Map(), events = [];
    const contents = { id: 1, isDestroyed: () => false,
        send: (channel, payload) => events.push({ channel, payload }) };
    const host = await createTopicMessageAdmissionHost({
        appDataRoot: root, historyQueue: queue, validate: async () => {},
        getMainWindow: () => ({ isDestroyed: () => false, webContents: contents }),
        ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler() {} },
    });
    t.after(async () => { await host.dispose(); await queue.dispose(); });
    const invoke = (name, ...args) => handlers.get(`topic-admission:${name}`)({ sender: contents }, ...args);
    await invoke('acquire', scope, 'old');
    await invoke('submit', { scope,
        message: { id: 'silent-letter', role: 'assistant', content: 'new information' },
        triggerPolicy: 'none',
    });
    assert.equal((await handlers.get('topic-admission:relay')(
        { sender: {} }, scope, 'old', { saved: true })).code, 'FORBIDDEN');
    assert.equal((await invoke('relay', scope, 'old', { saved: false })).code, 'UNSAVED_TERMINAL');
    assert.equal((await invoke('relay', scope, 'old', { saved: true })).success, true);
    const deadline = Date.now() + 3000;
    while (!events.some(event => event.channel === 'topic-admission:advance')) {
        assert.ok(Date.now() < deadline, 'relay must dispatch');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    const advances = events.filter(event => event.channel === 'topic-admission:advance');
    assert.equal(advances.length, 1);
    assert.equal(advances[0].payload.continuation, true);
    assert.equal((await invoke('ack', advances[0].payload.token)).success, true);
    assert.deepEqual((await queue.read(scope)).map(message => message.id), ['old-terminal', 'silent-letter']);
    assert.equal((await invoke('relay', scope, 'old', { saved: true })).code, 'STALE_LEASE');
    assert.equal((await invoke('acquire', scope, 'intruder')).code, 'TOPIC_BUSY');
    await invoke('release', scope, advances[0].payload.token, { saved: true });
});
test('host cancellation IPC bypasses an awaited relay journal and persists pause without dispatch', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-relay-cancel-'));
    const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
    const queue = new HistoryMutationQueue({ userDataDir: path.join(root, 'users') });
    await queue.replace(scope, [{ id: 'terminal', role: 'assistant', admissionToken: 'old', admissionTerminal: true }]);
    const handlers = new Map(), events = [];
    const contents = { id: 1, isDestroyed: () => false, send: (channel, payload) => events.push({ channel, payload }) };
    const host = await createTopicMessageAdmissionHost({
        appDataRoot: root, historyQueue: queue, validate: async () => {},
        getMainWindow: () => ({ isDestroyed: () => false, webContents: contents }),
        ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler() {} },
    });
    t.after(async () => { await host.dispose(); await queue.dispose(); await fs.remove(root); });
    const invoke = (name, ...args) => handlers.get(`topic-admission:${name}`)({ sender: contents }, ...args);
    await invoke('acquire', scope, 'old');
    await invoke('submit', { scope, message: { id: 'human', role: 'user', content: 'pending' } });
    let entered, unblock;
    const reached = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { unblock = resolve; });
    const save = host.service.store.save;
    let first = true;
    host.service.store.save = async (...args) => {
        if (first) { first = false; entered(); await gate; }
        return save(...args);
    };
    const relaying = invoke('relay', scope, 'old', { saved: true });
    await reached;
    assert.equal((await handlers.get('topic-admission:cancel-relay')(
        { sender: {} }, scope, 'old')).code, 'FORBIDDEN');
    assert.equal((await invoke('cancel-relay', scope, 'old')).accepted, true);
    unblock();
    assert.equal((await relaying).code, 'RELAY_CANCELLED');
    await tick();
    assert.equal(events.some(event => event.channel === 'topic-admission:advance'), false);
    assert.deepEqual((await queue.read(scope)).map(message => message.id), ['terminal']);
    const journal = await fs.readJson(path.join(root, 'TopicMessageQueue', 'pending.json'));
    assert.equal(journal.entries[0].state, 'recovered');
    assert.equal(journal.entries[0].relayFrom, 'old');
    assert.deepEqual(journal.standaloneLeases, []);
});