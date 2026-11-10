'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TopicMessageAdmission } = require('../modules/services/topicMessageAdmission');
const scope = { itemType: 'group', itemId: 'g', topicId: 't' };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(beforeSave = async () => {}) {
    let disk = { entries: [], standaloneLeases: [] };
    let writes = 0;
    const store = {
        load: async () => structuredClone(disk.entries),
        loadState: async () => structuredClone(disk),
        save: async (entries, standaloneLeases) => {
            writes++;
            await beforeSave(entries, standaloneLeases);
            disk = structuredClone({ entries, standaloneLeases });
        },
    };
    const create = () => new TopicMessageAdmission({
        store, validate: async () => {}, commit: async () => {},
    });
    const service = create();
    await service.initialize();
    return { service, create, disk: () => disk, writes: () => writes };
}

test('acquisition waits for durable journal; reentry does not duplicate ownership', async t => {
    let unblock;
    const gate = new Promise(resolve => { unblock = resolve; });
    const f = await fixture(() => gate);
    t.after(() => f.service.dispose());
    let acquired = false;
    const pending = f.service.acquire(scope, 'owner').then(result => { acquired = true; return result; });
    await tick();
    assert.equal(acquired, false);
    assert.equal(f.service.leases.size, 0);
    unblock();
    assert.equal((await pending).success, true);
    assert.equal(f.disk().standaloneLeases[0].token, 'owner');
    const writes = f.writes();
    assert.equal((await f.service.acquire(scope, 'owner')).success, true);
    assert.equal(f.writes(), writes);
    assert.equal((await f.service.acquire(scope, 'intruder')).code, 'TOPIC_BUSY');
    await f.service.release(scope, 'owner');
    assert.deepEqual(f.disk().standaloneLeases, []);
});

test('acquisition failure grants no execution and remains visibly paused', async t => {
    const failure = new Error('journal unknown');
    const f = await fixture(async () => { throw failure; });
    t.after(() => f.service.dispose());
    await assert.rejects(f.service.acquire(scope, 'owner'), error => error === failure);
    assert.equal(f.service.leases.size, 0);
    assert.equal(f.service.snapshot(scope)[0].state, 'uncertain');
    assert.equal((await f.service.acquire(scope, 'intruder')).code, 'MESSAGES_PENDING');
    assert.equal((await f.service.resume(scope)).code, 'TERMINAL_UNCONFIRMED');
});

test('release failure retains memory and durable ownership until successful retry', async t => {
    let reject = false;
    const f = await fixture(async () => { if (reject) throw new Error('release disk failed'); });
    t.after(() => f.service.dispose());
    await f.service.acquire(scope, 'owner');
    reject = true;
    await assert.rejects(f.service.release(scope, 'owner'), /release disk failed/);
    assert.equal(f.disk().standaloneLeases[0].token, 'owner');
    assert.equal((await f.service.acquire(scope, 'intruder')).code, 'TOPIC_BUSY');
    reject = false;
    await f.service.release(scope, 'owner');
    assert.deepEqual(f.disk().standaloneLeases, []);
});

test('standalone transfer persists new token and restart restores diagnostics only', async t => {
    const f = await fixture();
    t.after(() => f.service.dispose());
    await f.service.acquire(scope, 'owner');
    await f.service.transfer(scope, 'owner', 'receiver');
    assert.equal(f.disk().standaloneLeases[0].token, 'receiver');
    assert.equal((await f.service.release(scope, 'owner')).code, 'STALE_LEASE');
    const recovered = f.create();
    t.after(() => recovered.dispose());
    await recovered.initialize();
    assert.equal(recovered.leases.size, 0);
    assert.equal(recovered.snapshot(scope)[0].leaseToken, 'receiver');
    assert.equal(recovered.snapshot(scope)[0].state, 'uncertain');
    assert.deepEqual(f.disk().standaloneLeases, []);
    assert.equal((await recovered.resume(scope)).code, 'TERMINAL_UNCONFIRMED');
});

test('waiting handoff cancellation restores both messages and standalone lease token', async t => {
    const controller = new AbortController();
    let cancel = false;
    const f = await fixture(async () => {
        if (cancel) { cancel = false; controller.abort(); }
    });
    t.after(() => f.service.dispose());
    await f.service.acquire(scope, 'owner');
    const waiting = f.service.acquireWhenIdle(scope, 'receiver', {
        signal: controller.signal, handoffOwner: 'run',
    });
    const rejected = assert.rejects(waiting, error => error.code === 'ABORT_ERR');
    await tick();
    cancel = true;
    assert.equal((await f.service.transferToWaiting(scope, 'owner', 'run')).code, 'HANDOFF_CANCELLED');
    await rejected;
    assert.equal(f.disk().standaloneLeases[0].token, 'owner');
    assert.equal(f.service.standaloneLeases[0].token, 'owner');
    assert.equal((await f.service.acquire(scope, 'intruder')).code, 'TOPIC_BUSY');
    await f.service.release(scope, 'owner');
});

for (const cleanupFails of [false, true]) {
    test(`cancellation during acquire journal never grants execution; cleanup fails=${cleanupFails}`, async t => {
        const controller = new AbortController();
        let count = 0;
        let rejectCleanup = cleanupFails;
        const f = await fixture(async () => {
            count++;
            if (count === 1) controller.abort();
            else if (rejectCleanup) throw new Error('cancel cleanup journal failed');
        });
        t.after(() => f.service.dispose());
        await assert.rejects(
            f.service.acquireWhenIdle(scope, 'cancelled-owner', { signal: controller.signal }),
            error => cleanupFails
                ? /cancel cleanup journal failed/.test(error.message)
                : error.code === 'ABORT_ERR',
        );
        assert.equal(f.service.waiters.size, 0);
        if (cleanupFails) {
            assert.equal(f.disk().standaloneLeases[0].token, 'cancelled-owner');
            assert.equal((await f.service.acquire(scope, 'intruder')).code, 'TOPIC_BUSY');
            rejectCleanup = false;
            await f.service.release(scope, 'cancelled-owner');
        }
        assert.equal(f.service.leases.size, 0);
        assert.deepEqual(f.disk().standaloneLeases, []);
    });
}

test('cancelled same-token reentry cannot revoke the original execution lease', async t => {
    const f = await fixture();
    t.after(() => f.service.dispose());
    await f.service.acquire(scope, 'owner');
    const controller = new AbortController();
    const acquireNow = f.service.acquireNow.bind(f.service);
    f.service.acquireNow = async (...args) => {
        const result = await acquireNow(...args);
        controller.abort();
        return result;
    };
    await assert.rejects(f.service.acquireWhenIdle(scope, 'owner', { signal: controller.signal }),
        error => error.code === 'ABORT_ERR');
    assert.equal(f.disk().standaloneLeases[0].token, 'owner');
    assert.equal((await f.service.acquire(scope, 'intruder')).code, 'TOPIC_BUSY');
    await f.service.release(scope, 'owner');
    assert.deepEqual(f.disk().standaloneLeases, []);
});