'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { createTopicMessageAdmissionStore } = require('../modules/services/topicMessageAdmissionStore');

test('journal missing, roundtrip, replacement and corrupt data', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-admission-'));
    t.after(() => fs.remove(root));
    const file = path.join(root, 'journal.json');
    const store = createTopicMessageAdmissionStore(file);
    assert.deepEqual(await store.load(), []);
    const entries = [{ entryId: 'one', message: { content: '中文\n消息' } }];
    await store.save(entries);
    assert.deepEqual(await store.load(), entries);
    await store.save([]);
    assert.deepEqual(await store.load(), []);
    assert.deepEqual(await fs.readdir(root), ['journal.json']);
    await fs.writeFile(file, '{broken');
    await assert.rejects(store.load());
    await fs.writeJson(file, { version: 3, entries: [] });
    await assert.rejects(store.load(), /corrupt/);
    await fs.writeJson(file, { version: 2, entries: [] });
    await assert.rejects(store.loadState(), /lease journal/);
});

test('journal refuses relative path', () => {
    assert.throws(() => createTopicMessageAdmissionStore('journal.json'), /absolute/);
});

test('v2 atomically preserves frozen messages and standalone leases; v1 migrates on write', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-admission-v2-'));
    t.after(() => fs.remove(root));
    const file = path.join(root, 'journal.json');
    const store = createTopicMessageAdmissionStore(file);
    const entries = [{ entryId: 'one', message: { content: 'original' } }];
    await fs.outputJson(file, { version: 1, entries });
    assert.deepEqual(await store.loadState(), { entries, standaloneLeases: [] });
    const leases = [{
        scope: { itemType: 'group', itemId: 'g', topicId: 't' },
        token: 'exact-lease',
    }];
    const expected = structuredClone({ entries, standaloneLeases: leases });
    const saving = store.save(entries, leases);
    entries[0].message.content = 'mutated';
    leases[0].token = 'mutated';
    await saving;
    assert.deepEqual(await store.loadState(), expected);
    assert.equal((await fs.readJson(file)).version, 2);
    await assert.rejects(store.save([], [...expected.standaloneLeases, ...expected.standaloneLeases]),
        /duplicate/);
    await assert.rejects(store.save([], [{ scope: { itemId: '../bad', topicId: 't' }, token: 'x' }]),
        /identifier/);
    assert.deepEqual(await store.loadState(), expected);
    assert.deepEqual(await fs.readdir(root), ['journal.json']);
});

test('central v2 recovery converts standalone ownership to durable diagnostics without execution', async t => {
    const { TopicMessageAdmission } = require('../modules/services/topicMessageAdmission');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-lease-recover-'));
    t.after(() => fs.remove(root));
    const file = path.join(root, 'journal.json');
    const store = createTopicMessageAdmissionStore(file);
    const scope = { itemType: 'group', itemId: 'g', topicId: 't' };
    await store.save([], [{ scope, token: 'interrupted', acquiredAt: 100 }]);
    const service = new TopicMessageAdmission({
        store, validate: async () => {},
        commit: async () => assert.fail('recovery must not append messages'),
        advance: async () => assert.fail('recovery must not generate'),
    });
    t.after(() => service.dispose());
    await service.initialize();
    assert.equal(service.leases.size, 0);
    const entry = service.snapshot(scope)[0];
    assert.equal(entry.kind, 'lease-diagnostic');
    assert.equal(entry.state, 'uncertain');
    assert.equal(entry.leaseToken, 'interrupted');
    assert.equal((await service.resume(scope)).code, 'TERMINAL_UNCONFIRMED');
    const disk = await store.loadState();
    assert.deepEqual(disk.standaloneLeases, []);
    assert.equal(disk.entries[0].leaseToken, 'interrupted');
    await service.submit({ scope, message: { id: 'later', role: 'user', content: 'wait' } });
    await service.tail;
    assert.equal(service.snapshot(scope).length, 2);
    assert.equal((await store.loadState()).entries[0].state, 'uncertain');
});

test('actual acquisition survives disk restart without failure reporting and reconciles exact terminal', async t => {
    const { TopicMessageAdmission } = require('../modules/services/topicMessageAdmission');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-acquired-restart-'));
    t.after(() => fs.remove(root));
    const store = createTopicMessageAdmissionStore(path.join(root, 'journal.json'));
    const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
    const other = { ...scope, topicId: 'other' };
    const create = () => new TopicMessageAdmission({
        store, validate: async () => {},
        commit: async () => assert.fail('no recovery chat writes'),
        advance: async () => assert.fail('no recovery generation'),
        verifyTerminal: async (target, token) => ({
            verified: target.topicId === 't' && token === 'actual-owner',
            messageId: 'durable-terminal',
        }),
    });
    const first = create();
    t.after(() => first.dispose());
    await first.initialize();
    await first.acquire(scope, 'actual-owner');
    await first.submit({ scope: other, message: { id: 'other-message', role: 'assistant', content: 'other' } });
    await first.tail;
    assert.equal((await store.loadState()).standaloneLeases[0].token, 'actual-owner');
    // No reportUncertain/release: simulate the ownership journal left by process exit.
    await first.dispose();
    const recovered = create();
    t.after(() => recovered.dispose());
    await recovered.initialize();
    const diagnostic = recovered.snapshot(scope)[0];
    assert.equal(diagnostic.state, 'uncertain');
    assert.equal(diagnostic.leaseToken, 'actual-owner');
    assert.equal(recovered.leases.size, 0);
    assert.equal((await recovered.resume(scope)).code, 'TERMINAL_UNCONFIRMED');
    assert.equal((await recovered.reconcile(scope, diagnostic.entryId)).messageId, 'durable-terminal');
    assert.deepEqual(recovered.snapshot(scope), []);
    const disk = await store.loadState();
    assert.deepEqual(disk.standaloneLeases, []);
    assert.equal(disk.entries.some(entry => entry.leaseToken === 'actual-owner'), false);
});