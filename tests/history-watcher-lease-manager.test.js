'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHistoryWatcherLeaseManager } = require('../modules/services/historyWatcherLeaseManager');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('a newer lease rejects an older queued watcher start', async () => {
    const calls = [];
    const manager = createHistoryWatcherLeaseManager({
        startWatching: async payload => { calls.push(`start:${payload.id}`); },
        stopWatching: async () => { calls.push('stop'); }
    });

    const first = manager.claim('renderer');
    const firstStart = manager.start('renderer', first.token, { id: 'first' });
    const second = manager.claim('renderer');
    const secondStart = manager.start('renderer', second.token, { id: 'second' });

    const [firstResult, secondResult] = await Promise.all([firstStart, secondStart]);
    assert.equal(firstResult.stale, true);
    assert.equal(secondResult.success, true);
    assert.deepEqual(calls, ['stop', 'start:second']);
    await manager.dispose();
});

test('a lease superseded during start cannot leave its watcher active', async () => {
    const firstStartGate = deferred();
    const firstStarted = deferred();
    const calls = [];
    const manager = createHistoryWatcherLeaseManager({
        startWatching: async payload => {
            calls.push(`start:${payload.id}`);
            if (payload.id === 'first') {
                firstStarted.resolve();
                await firstStartGate.promise;
            }
        },
        stopWatching: async () => { calls.push('stop'); }
    });

    const first = manager.claim('renderer');
    await first.stopped;
    const firstStart = manager.start('renderer', first.token, { id: 'first' });
    await firstStarted.promise;

    const second = manager.claim('renderer');
    const secondStart = manager.start('renderer', second.token, { id: 'second' });
    firstStartGate.resolve();

    assert.equal((await firstStart).stale, true);
    assert.equal((await secondStart).success, true);
    assert.deepEqual(calls, ['stop', 'start:first', 'stop', 'stop', 'start:second']);
    await manager.dispose();
});

test('revoking a destroyed renderer stops its watcher and rejects its token', async () => {
    let stops = 0;
    const manager = createHistoryWatcherLeaseManager({
        startWatching: async () => {},
        stopWatching: async () => { stops += 1; }
    });
    const lease = manager.claim('renderer-7');
    await lease.stopped;
    await manager.start('renderer-7', lease.token, { id: 'active' });
    assert.equal((await manager.revoke('renderer-7')).success, true);
    assert.equal((await manager.start('renderer-7', lease.token, { id: 'stale' })).stale, true);
    assert.equal(stops, 2);
    await manager.dispose();
});
