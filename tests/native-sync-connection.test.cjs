'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { readConnection } = require('../modules/services/nativeSync/connection');
const { createNativeSyncRuntime } = require('../modules/services/nativeSync/runtime');
const { HistoryMutationQueue } = require('../modules/services/historyMutationQueue');
const { durableJson } = require('../modules/services/nativeSync/durableJson');
const { messageHash, messageKey } = require('../modules/services/nativeSync/protocol');
const topic = { itemId: 'fixture-agent', itemType: 'agent', topicId: 'fixture-topic' };
const quiet = { log() {}, warn() {}, error() {} };
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-connection-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const config = { version: 1, enabled: true, historySelectionApproved: true, deviceId: 'fixture-desktop', topics: [topic], serverUrl: 'https://sync.example.invalid', credentialSource: 'existing-vcp-settings', publishCatalog: false };
    const settings = () => ({ vcpServerUrl: 'https://sync.example.invalid/v1/chat/completions', vcpApiKey: 'synthetic-desktop-key' });
    const file = path.join(root, '.native-sync', 'connection.json');
    const write = () => durableJson(file, config);
    return { root, config, settings, file, write };
}
test('no opt-in reads no credentials, creates no sync directory and changes no Queue policy', async t => {
    const f = await fixture(t);
    assert.equal(await readConnection({ appDataRoot: f.root, readSettings: () => assert.fail('credential read while disabled') }), null);
    assert.equal(await createNativeSyncRuntime({ appDataRoot: f.root, readSettings: () => assert.fail('credential read while disabled') }), null);
    assert.deepEqual(await fs.readdir(f.root), []);
    await assert.rejects(createNativeSyncRuntime({ appDataRoot: f.root, isolated: true, args: ['--native-sync-poc', '--native-sync-url=https://example.invalid'] }), { code: 'ISOLATED_LOOPBACK_REQUIRED' });
});
test('explicit connection uses only the existing same-origin HTTPS authority without persisting its key', async t => {
    const f = await fixture(t); await f.write();
    const result = await readConnection({ appDataRoot: f.root, readSettings: f.settings });
    assert.equal(result.url, f.config.serverUrl); assert.equal(result.token, f.settings().vcpApiKey);
    assert.equal((await fs.readFile(f.file, 'utf8')).includes(result.token), false);
    for (const serverUrl of ['http://sync.example.invalid', 'http://127.0.0.1:8888', 'https://user:password@sync.example.invalid', 'https://sync.example.invalid/path', 'https://sync.example.invalid/?key=x', 'https://sync.example.invalid/#x']) {
        f.config.serverUrl = serverUrl; await f.write();
        await assert.rejects(readConnection({ appDataRoot: f.root, readSettings: () => assert.fail('read before URL validation') }), { code: 'SYNC_HTTPS_REQUIRED' });
    }
    f.config.serverUrl = 'https://other.example.invalid'; await f.write();
    await assert.rejects(readConnection({ appDataRoot: f.root, readSettings: f.settings }), { code: 'DESKTOP_BACKEND_IDENTITY_MISMATCH' });
});
test('connection rejects embedded keys, private transport hooks and unapproved selection', async t => {
    const f = await fixture(t);
    for (const key of ['token', 'apiKey', 'ssh', 'transportUrl']) {
        f.config[key] = 'not-allowed'; await f.write();
        await assert.rejects(readConnection({ appDataRoot: f.root, readSettings: () => assert.fail('read before validation') }), { code: 'UNEXPECTED_SYNC_CONNECTION_FIELD' });
        delete f.config[key];
    }
    f.config.historySelectionApproved = false; await f.write();
    await assert.rejects(readConnection({ appDataRoot: f.root, readSettings: f.settings }), { code: 'INVALID_SYNC_CONNECTION' });
    f.config.historySelectionApproved = true; f.config.topics = [{ ...topic, itemType: 'group' }]; await f.write();
    await assert.rejects(readConnection({ appDataRoot: f.root, readSettings: f.settings }), { code: 'MOBILE_AGENT_TOPICS_ONLY' });
});
test('connection filesystem aliases are rejected before reading credentials', async t => {
    const f = await fixture(t); await f.write();
    const bytes = await fs.readFile(f.file); await fs.unlink(f.file);
    const target = path.join(f.root, 'synthetic-connection.json'); await fs.writeFile(target, bytes); await fs.symlink(target, f.file);
    await assert.rejects(readConnection({ appDataRoot: f.root, readSettings: () => assert.fail('read through alias') }), { code: 'SYNC_CONNECTION_ALIAS' });
});
test('cached shared state starts offline, captures Outbox under exclusion and reconnects once', async t => {
    const f = await fixture(t); await f.write();
    const queue = new HistoryMutationQueue({ userDataDir: path.join(f.root, 'UserData'), logger: quiet });
    t.after(() => queue.dispose());
    const old = { id: 'old', role: 'user', content: 'existing synthetic history', timestamp: 1 };
    await durableJson(queue.getHistoryPath(topic.itemId, topic.topicId), [old]);
    const statePath = path.join(f.root, '.native-sync', 'state.json');
    const key = messageKey({ ownerType: 'agent', ownerId: topic.itemId, topicId: topic.topicId, msgId: old.id });
    await durableJson(statePath, { version: 1, deviceId: f.config.deviceId, topics: [topic], cursor: 1, acked: { [key]: { hash: messageHash(old), deleted: false, seq: 1 } }, outbox: [], pending: null });
    let online = false, pushes = 0;
    const operations = new Map();
    const runtime = await createNativeSyncRuntime({ queue, appDataRoot: f.root, readSettings: f.settings, intervalMs: 10, request: async (route, { body } = {}) => {
        if (!online) throw Object.assign(Error('synthetic offline'), { code: 'NETWORK_UNAVAILABLE' });
        if (route.endsWith('/push')) { pushes++; const ack = { seq: 2, hash: messageHash(body.message), deleted: false }; operations.set(body.opId, ack); return ack; }
        return { events: [], headSeq: 2, nextSeq: 2, hasMore: false };
    } });
    t.after(() => runtime.close());
    assert.equal(queue.isSyncEnabled(topic), true);
    assert.throws(() => require('../modules/services/syncWriterBoundary').createSyncWriterBoundary(queue).assertWrite({ ownerType: 'agent', ownerId: topic.itemId }), { code: 'SYNC_WRITER_EXCLUDED' });
    await queue.mutate(topic, history => [...history, { id: 'offline', role: 'user', content: 'saved offline', timestamp: 2 }]);
    assert.equal(JSON.parse(await fs.readFile(statePath, 'utf8')).outbox.length, 1);
    await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(pushes, 0); assert.equal(runtime.adapter.degraded, 'NETWORK_UNAVAILABLE');
    online = true;
    const deadline = Date.now() + 3000;
    while (runtime.adapter.state.outbox.length || runtime.adapter.state.cursor !== 2 || runtime.adapter.busy) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(pushes, 1); assert.equal(operations.size, 1); assert.equal(runtime.adapter.state.pending, null);
    await runtime.close();
});
test('failed first attachment cannot publish local messages or create sync state', async t => {
    const f = await fixture(t); await f.write();
    const queue = new HistoryMutationQueue({ userDataDir: path.join(f.root, 'UserData'), logger: quiet }); t.after(() => queue.dispose());
    await assert.rejects(createNativeSyncRuntime({ queue, appDataRoot: f.root, readSettings: f.settings, request: () => assert.fail('unapproved source reached network') }), { code: 'APPROVED_HISTORY_SNAPSHOT_REQUIRED' });
    assert.equal(queue.syncPolicy, null);
    assert.deepEqual(await fs.readdir(path.join(f.root, '.native-sync')), ['connection.json']);
});
