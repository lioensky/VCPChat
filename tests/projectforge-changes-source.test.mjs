import test from 'node:test';
import assert from 'node:assert/strict';
import { getProjectForgeChangesSource, watchProjectForgeChanges, PROJECT_FORGE_TOPIC } from '../modules/ui-system/sources/projectforge-changes.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

function fakeApi() {
    const calls = [];
    let push = null;
    const api = {
        onProjectForgeChanged: cb => { calls.push('listen'); push = cb; return () => { calls.push('unlisten'); push = null; }; },
        subscribeMainState: async (topic, key) => { calls.push(['subscribe', topic, key]); return { success: true }; },
        unsubscribeMainState: async (topic, key) => { calls.push(['unsubscribe', topic, key]); return { success: true }; }
    };
    return { api, calls, push: payload => push?.(payload) };
}

test('one source per window: the first watcher subscribes to the main process, the last one unsubscribes', async () => {
    const { api, calls, push } = fakeApi();
    const source = getProjectForgeChangesSource(api, { graceMs: 0 });
    assert.equal(getProjectForgeChangesSource(api), source);
    assert.equal(getProjectForgeChangesSource({}), null, 'no ProjectForge API, no source');
    assert.deepEqual(calls, [], 'creating the source does not subscribe');

    const seenA = [];
    const seenB = [];
    const offA = watchProjectForgeChanges(api, payload => seenA.push(payload));
    const offB = watchProjectForgeChanges(api, payload => seenB.push(payload));
    assert.deepEqual(calls, ['listen', ['subscribe', PROJECT_FORGE_TOPIC, undefined]], 'two watchers share one subscription');
    assert.deepEqual(seenA, [], 'watchers are not called with the initial snapshot');

    push({ projectId: 'p1' });
    push({ projectId: 'p1' });
    assert.equal(seenA.length, 2, 'identical pushes are still delivered');
    assert.deepEqual(seenB, [{ projectId: 'p1' }, { projectId: 'p1' }]);
    assert.equal(source.data.seq, 2);

    offA();
    assert.equal(calls.includes('unlisten'), false);
    offB();
    await tick();
    assert.deepEqual(calls.slice(2), ['unlisten', ['unsubscribe', PROJECT_FORGE_TOPIC, undefined]]);
    source.dispose();
});

test('watching without the ProjectForge API is a no-op', () => {
    const off = watchProjectForgeChanges({}, () => assert.fail('never called'));
    assert.equal(typeof off, 'function');
    off();
});
