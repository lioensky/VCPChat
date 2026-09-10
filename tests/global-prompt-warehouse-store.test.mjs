import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Store from '../modules/utils/globalPromptWarehouseStore.js';

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-warehouse-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'warehouse.json');
    return { file, store: new Store(file) };
}

test('read of missing warehouse does not create a file; only one initialization wins', async t => {
    const { file, store } = await fixture(t);
    assert.equal((await store.read()).currentRevision, 'missing');
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    const first = store.save({ data: ['first'], expectedRevision: 'missing' });
    const second = store.save({ data: ['second'], expectedRevision: 'missing' });
    assert.equal((await first).success, true);
    assert.equal((await second).status, 'conflict');
    assert.deepEqual((await store.read()).data, ['first']);
});

test('save freezes input and rejects stale revision without changing bytes', async t => {
    const { file, store } = await fixture(t);
    const data = [{ content: 'frozen' }];
    const pending = store.save({ data, expectedRevision: 'missing' });
    data[0].content = 'changed after submit';
    const saved = await pending;
    assert.deepEqual((await store.read()).data, [{ content: 'frozen' }]);
    const before = await fs.readFile(file);
    const conflict = await store.save({ data: [], expectedRevision: 'missing' });
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.currentRevision, saved.currentRevision);
    assert.deepEqual(await fs.readFile(file), before);
    await assert.rejects(store.save([]), /读取版本/);
});

test('successive warehouse saves preserve exact recovery bytes and allow explicit empty array', async t => {
    const { file, store } = await fixture(t);
    let revision = 'missing';
    const snapshots = [];
    for (const data of [['A'], ['B'], []]) {
        const result = await store.save({ data, expectedRevision: revision });
        assert.equal(result.success, true);
        revision = result.currentRevision;
        snapshots.push({ revision, bytes: await fs.readFile(file) });
    }
    assert.deepEqual((await store.read()).data, []);
    for (const snapshot of snapshots.slice(0, -1)) {
        assert.deepEqual(
            await fs.readFile(path.join(`${file}.versions`, `${snapshot.revision}.json`)),
            snapshot.bytes,
        );
    }
});

test('damaged warehouse fails closed instead of being replaced with an empty array', async t => {
    const { file, store } = await fixture(t);
    await fs.writeFile(file, '{ damaged');
    await assert.rejects(store.read());
    await assert.rejects(store.save({ data: [], expectedRevision: 'missing' }));
    assert.equal(await fs.readFile(file, 'utf8'), '{ damaged');
    await assert.rejects(fs.stat(`${file}.lock`), { code: 'ENOENT' });
});

test('another writer lock is preserved and a later retry succeeds', async t => {
    const { file, store } = await fixture(t);
    await fs.writeFile(`${file}.lock`, 'other-owner', { flag: 'wx' });
    await assert.rejects(
        store.save({ data: ['A'], expectedRevision: 'missing' }),
        { code: 'EEXIST' },
    );
    assert.equal(await fs.readFile(`${file}.lock`, 'utf8'), 'other-owner');
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    await fs.unlink(`${file}.lock`);
    assert.equal((await store.save({ data: ['A'], expectedRevision: 'missing' })).success, true);
});