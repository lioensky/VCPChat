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

test('disk restart clears interrupted ownership and staging without history replay', async t => {
    const { TopicMessageAdmission } = require('../modules/services/topicMessageAdmission');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-lease-recover-'));
    t.after(() => fs.remove(root));
    const store = createTopicMessageAdmissionStore(path.join(root, 'journal.json'));
    const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
    const other = { ...scope, topicId: 'other' };
    const create = () => new TopicMessageAdmission({
        store, validate: async () => {},
        commit: async () => assert.fail('recovery must not append messages'),
        advance: async () => assert.fail('recovery must not generate'),
    });
    const first = create();
    await first.initialize();
    await first.acquire(scope, 'interrupted');
    await first.submit({ scope, message: { id: 'pending', role: 'user' } });
    await first.dispose();
    const disk = await store.loadState();
    assert.equal(disk.standaloneLeases[0].token, 'interrupted');
    await store.save([...disk.entries, {
        entryId: 'other-entry', scope: other, message: { id: 'other-message', role: 'user' },
        state: 'queued',
    }], disk.standaloneLeases);
    const recovered = create();
    t.after(() => recovered.dispose());
    await recovered.initialize();
    assert.deepEqual(recovered.snapshot(scope), []);
    assert.equal(recovered.snapshot(other)[0].state, 'recovered');
    assert.equal(recovered.leases.size, 0);
    const cleaned = await store.loadState();
    assert.deepEqual(cleaned.standaloneLeases, []);
    assert.equal(cleaned.entries.length, 1);
    assert.equal(cleaned.entries[0].scope.topicId, 'other');
    assert.equal((await recovered.acquire(scope, 'retry')).success, true);
});