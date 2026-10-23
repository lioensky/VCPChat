'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registerNativeIpc, registerGroupIpc, HistoryMutationQueue, quiet } = require('./helpers/nativeSyncFixture.cjs');
const { NativeSyncAdapter } = require('../modules/services/nativeSync/adapter');
const { startSyncService } = require('./helpers/nativeSyncHttpService.cjs');
const { durableJson } = require('../modules/services/nativeSync/durableJson');
const topic = { itemId: 'agent-a', itemType: 'agent', topicId: 'topic-a' };
const groupTopic = { itemId: 'group-a', itemType: 'group', topicId: 'topic-g' };
const message = (id, content = id) => ({ id, role: 'user', content, timestamp: 100 });
async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-sync-r2-'));
    let service = await startSyncService({ dbPath: path.join(dir, 'central.sqlite'), token: 'isolated-poc-token' });
    const clients = [];
    async function client(name, extra = {}) {
        const queue = new HistoryMutationQueue({ userDataDir: path.join(dir, name, 'UserData'), logger: quiet });
        const ipc = registerNativeIpc(queue.userDataDir, queue);
        const options = { queue, statePath: path.join(dir, name, 'sync.json'), deviceId: name, url: service.url, token: 'isolated-poc-token', topics: [topic, groupTopic], ...extra };
        const adapter = await NativeSyncAdapter.open(options);
        const c = { queue, ipc, adapter, options, async save(history, revision) {
            if (revision === undefined) revision = (await ipc.call('native-history:snapshot', topic.itemId, topic.itemType, topic.topicId)).revision;
            return ipc.call('save-chat-history', topic.itemId, topic.topicId, history, revision);
        } };
        clients.push(c); return c;
    }
    t.after(async () => { for (const c of clients) { await c.adapter.close(); await c.queue.dispose(); } await service?.close(); await fs.rm(dir, { recursive: true, force: true }); });
    return { dir, get service() { return service; }, client,
        async stop() { await service.close(); service = null; },
        async restart() { service = await startSyncService({ dbPath: path.join(dir, 'central.sqlite'), token: 'isolated-poc-token' }); for (const c of clients) { c.options.url = service.url; c.adapter.url = service.url; } },
    };
}
test('Step 1: real single-chat IPC persists committed snapshots and Outbox, without network in Queue', async t => {
    const x = await fixture(t), a = await x.client('Windows-A');
    const result = await a.save([message('one')]);
    assert.equal(result.success, true); assert.equal(result.sync.state, 'captured');
    assert.equal(a.adapter.state.outbox.length, 1);
    assert.equal(x.service.store.metrics().journalRows, 0);
    assert.deepEqual(await a.queue.read(topic), [message('one')]);
    const disk = JSON.parse(await fs.readFile(a.options.statePath, 'utf8'));
    assert.equal(disk.outbox.length, 1);
});
test('terminal IPC merges inside Queue, preserving concurrent durable metadata and messages', async t => {
    const x = await fixture(t), a = await x.client('Windows-A');
    await a.save([message('one', 'newer')]);
    await a.queue.mutate(topic, h => [...h, { ...message('terminal'), role: 'assistant', rating: 'newer local rating' }, message('remote')]);
    const result = await a.ipc.call('native-history:terminal', { messageId: 'terminal', context: { agentId: topic.itemId, topicId: topic.topicId }, history: [message('one', 'stale'), { ...message('terminal', 'finished'), role: 'assistant', rating: 'stale rating', finishReason: 'stop' }] });
    assert.equal(result.success, true);
    const history = await a.queue.read(topic);
    assert.equal(history.find(m => m.id === 'one').content, 'newer');
    assert.equal(history.find(m => m.id === 'terminal').rating, 'newer local rating');
    assert.equal(history.find(m => m.id === 'terminal').content, 'finished');
    assert.ok(history.some(m => m.id === 'remote'));
});
for (const kind of ['normal', 'error', 'stream']) test(`real group IPC automatic ${kind} terminal uses Queue and reaches second client`, async t => {
    const x = await fixture(t), a = await x.client('Windows-A'), b = await x.client('Windows-B');
    const fse = require('fs-extra'), appRoot = path.dirname(a.queue.userDataDir);
    await fse.outputJson(path.join(appRoot, 'settings.json'), { vcpServerUrl: 'http://127.0.0.1:1/v1/chat/completions', vcpApiKey: 'synthetic-only' });
    await fse.outputJson(path.join(appRoot, 'Agents', 'member', 'config.json'), { id: 'member', name: 'Member', model: 'fixture', streamOutput: kind === 'stream' });
    await fse.outputJson(path.join(appRoot, 'AgentGroups', groupTopic.itemId, 'config.json'), { id: groupTopic.itemId, name: 'Fixture Group', mode: 'sequential', members: ['member'], topics: [{ id: groupTopic.topicId }] });
    let calls = 0;
    const respond = async url => {
        assert.ok(url.startsWith('http://127.0.0.1:1/')); calls++;
        if (kind === 'error') throw new Error('synthetic provider failure');
        return kind === 'stream' ? new Response('data: {"choices":[{"delta":{"content":"streamed reply"}}]}\n\ndata: [DONE]\n\n') : new Response(JSON.stringify({ choices: [{ message: { content: 'normal reply' } }] }));
    };
    registerGroupIpc(appRoot, a.queue, a.ipc.ipcMain, respond);
    const sent = await a.ipc.call('send-group-chat-message', groupTopic.itemId, groupTopic.topicId, { id: 'user-g', content: { text: 'hello group' } });
    assert.equal(sent.success, true); assert.equal(calls, 1);
    const local = await a.queue.read(groupTopic);
    assert.equal(local.length, 2); assert.equal(local[1].role, 'assistant');
    assert.equal(a.adapter.state.outbox.filter(op => op.ownerType === 'group').length, 2);
    await a.adapter.flush(); await b.adapter.pull();
    assert.deepEqual(await b.queue.read(groupTopic), local.map(m => {
        const canonical = require('../modules/services/nativeSync/protocol').canonicalMessage(m, groupTopic.topicId); return canonical;
    }));
    if (kind === 'normal') {
        const oldId = local[1].id;
        await a.ipc.call('redo-group-chat-message', groupTopic.itemId, groupTopic.topicId, oldId, 'member');
        assert.ok(a.adapter.state.outbox.some(op => op.msgId === oldId && op.action === 'delete'));
        await a.adapter.flush(); await b.adapter.pull();
        assert.equal((await b.queue.read(groupTopic)).some(m => m.id === oldId), false);
    }
});
test('Step 1: capture failure preserves local IPC success and reports durable recoverable degradation', async t => {
    const x = await fixture(t); let fail = false;
    const a = await x.client('Windows-A', { persist: async (file, state) => { if (fail) throw Object.assign(new Error('injected disk failure'), { code: 'INJECTED_CAPTURE_FAILURE' }); return durableJson(file, state); } });
    fail = true;
    const result = await a.save([message('offline')]);
    assert.equal(result.success, true); assert.equal(result.sync.state, 'degraded');
    assert.equal(result.sync.recoverable, true);
    assert.equal((await a.queue.read(topic))[0].id, 'offline');
    assert.equal(JSON.parse(await fs.readFile(a.options.statePath + '.degraded', 'utf8')).recoverable, true);
    fail = false; await a.adapter.recover(); await a.adapter.flush();
    assert.equal(x.service.store.metrics().liveMessages, 1);
});
test('native A/HTTP/SQLite/B merge, repeated pull, stale whole save, tombstone and no echo', async t => {
    const x = await fixture(t), a = await x.client('Windows-A'), b = await x.client('Windows-B');
    const old = await b.ipc.call('native-history:snapshot', topic.itemId, topic.itemType, topic.topicId);
    await a.save([message('one')]); await a.adapter.flush(); await b.adapter.pull({ limit: 1 });
    assert.deepEqual(await b.queue.read(topic), [message('one')]); assert.equal(b.adapter.state.outbox.length, 0);
    const stale = await b.save([message('stale')], old.revision);
    assert.equal(stale.success, false); assert.equal(stale.error, 'HISTORY_REVISION_CONFLICT');
    await b.adapter.pull(); await b.adapter.flush(); assert.equal(x.service.store.metrics().journalRows, 1);
    await a.save([]); await a.adapter.flush(); await b.adapter.pull();
    assert.deepEqual(await b.queue.read(topic), []);
});
test('lost ACK and restarted persisted Outbox replays without duplicate journal', async t => {
    const x = await fixture(t), a = await x.client('Windows-A');
    await a.save([message('one')]);
    await a.adapter.request('/api/v1/sync/push', { body: a.adapter.state.outbox[0] });
    await a.adapter.close(); a.adapter = await NativeSyncAdapter.open(a.options);
    await a.adapter.flush(); assert.equal(x.service.store.metrics().journalRows, 1);
});
test('distinct offline additions merge; same-ID concurrent contents reject and retain Outbox', async t => {
    const x = await fixture(t), a = await x.client('Windows-A'), b = await x.client('Windows-B');
    await a.save([message('one')]); await b.save([message('two')]);
    await a.adapter.flush(); await b.adapter.flush(); await a.adapter.pull(); await b.adapter.pull();
    assert.deepEqual((await b.queue.read(topic)).map(m => m.id).sort(), ['one', 'two']);
    await a.save([message('one', 'A edit'), message('two')]);
    await b.save([message('one', 'B edit'), message('two')]);
    await a.adapter.flush(); await assert.rejects(b.adapter.flush(), { code: 'MESSAGE_CONFLICT' });
    assert.equal(b.adapter.state.outbox.length, 1);
});
test('Owner aliases of one physical history are rejected for sync writes', async t => {
    const x = await fixture(t), a = await x.client('Windows-A');
    await assert.rejects(a.queue.mutate({ ...topic, itemType: 'group' }, h => h), { code: 'OWNER_PATH_CONFLICT' });
    await assert.rejects(NativeSyncAdapter.open({ ...a.options, topics: [topic, { ...topic, itemType: 'group' }] }), { code: 'OWNER_PATH_CONFLICT' });
});
test('remote history written but cursor persistence fails: restart recovers without echo or loss', async t => {
    const x = await fixture(t), a = await x.client('Windows-A'); let rejectCommit = true;
    const b = await x.client('Windows-B', { persist: async (file, state) => { if (rejectCommit && state.cursor > 0 && !state.pending) throw Object.assign(new Error('injected cursor failure'), { code: 'INJECTED_CURSOR_FAILURE' }); return durableJson(file, state); } });
    await a.save([message('one')]); await a.adapter.flush();
    await assert.rejects(b.adapter.pull(), { code: 'SYNC_STATE_NOT_DURABLE' });
    assert.equal(b.adapter.state.cursor, 0); assert.equal((await b.queue.read(topic))[0].id, 'one');
    rejectCommit = false; await b.adapter.close(); b.adapter = await NativeSyncAdapter.open(b.options);
    assert.equal(b.adapter.state.cursor, 1); assert.equal(b.adapter.state.outbox.length, 0);
    await b.adapter.pull(); assert.equal(x.service.store.metrics().journalRows, 1);
});
test('sync disabled retains legacy IPC save behavior and has no observer/network', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-off-'));
    const queue = new HistoryMutationQueue({ userDataDir: dir });
    t.after(async () => { await queue.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
    const ipc = registerNativeIpc(dir, queue);
    assert.equal((await ipc.call('save-chat-history', 'agent-a', 'topic-a', [message('off')])).success, true);
    assert.equal((await queue.read(topic))[0].id, 'off');
});
test('offline native save persists across client and SQLite server restart', async t => {
    const x = await fixture(t), a = await x.client('Windows-A'), b = await x.client('Windows-B');
    await x.stop(); await a.save([message('offline-restart')]);
    await assert.rejects(a.adapter.flush(), { code: 'NETWORK_UNAVAILABLE' });
    await a.adapter.close(); a.adapter = await NativeSyncAdapter.open(a.options);
    assert.equal(a.adapter.state.outbox.length, 1);
    await x.restart(); await a.adapter.flush(); await b.adapter.pull();
    assert.equal((await b.queue.read(topic))[0].id, 'offline-restart');
});
test('Queue observer receives an isolated committed snapshot without a filesystem reread', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'observer-snapshot-'));
    let observed;
    const queue = new HistoryMutationQueue({ userDataDir: dir, commitObserver: event => { observed = structuredClone(event); event.history.length = 0; } });
    queue.read = async () => { throw new Error('observer must not reread'); };
    t.after(async () => { await queue.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
    await queue.replace(topic, [message('snapshot')]);
    assert.equal(observed.history[0].id, 'snapshot');
    assert.equal(JSON.parse(await fs.readFile(queue.getHistoryPath(topic.itemId, topic.topicId), 'utf8'))[0].id, 'snapshot');
});
test('POC runtime is inert by default and rejects activation without an isolated data root', async t => {
    const { createNativeSyncRuntime } = require('../modules/services/nativeSync/runtime');
    assert.equal(await createNativeSyncRuntime({ args: [] }), null);
    await assert.rejects(createNativeSyncRuntime({ args: ['--native-sync-poc'], isolated: false }), { code: 'ISOLATED_APP_DATA_REQUIRED' });
    const x = await fixture(t), a = await x.client('Windows-A');
    await assert.rejects(NativeSyncAdapter.open({ ...a.options, url: 'http://example.invalid' }), { code: 'PROTECTED_SYNC_ENDPOINT_REQUIRED' });
});
test('sync Owner paths reject filesystem junction/symlink aliases before reading or committing', async t => {
    const x = await fixture(t), a = await x.client('Windows-A');
    const alias = path.join(x.dir, 'alias-owner');
    await fs.mkdir(alias); await fs.mkdir(a.queue.userDataDir, { recursive: true });
    await fs.symlink(alias, path.join(a.queue.userDataDir, topic.itemId), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(a.queue.read(topic), { code: 'OWNER_PATH_ALIAS' });
    await assert.rejects(a.queue.mutate(topic, h => [...h, message('alias')]), { code: 'OWNER_PATH_ALIAS' });
    assert.equal(a.adapter.state.cursor, 0); assert.equal(a.adapter.state.outbox.length, 0);
});
