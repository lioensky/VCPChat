import test from 'node:test';
import assert from 'node:assert/strict';
import { getGitChangesSource, watchGitChanges, createGitChangesFollower, GIT_STATUS_TOPIC } from '../modules/ui-system/sources/git-changes.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

function fakeApi() {
    const calls = [];
    const listeners = new Set();
    const api = {
        onGitChanged: cb => { listeners.add(cb); return () => listeners.delete(cb); },
        subscribeMainState: async (topic, key) => { calls.push(['+', topic, key]); return { success: true }; },
        unsubscribeMainState: async (topic, key) => { calls.push(['-', topic, key]); return { success: true }; }
    };
    return { api, calls, listeners, push: payload => [...listeners].forEach(cb => cb(payload)) };
}

test('one source per workspace: watchers share one main-process subscription, and pushes are filtered by workspace', async () => {
    const { api, calls, listeners, push } = fakeApi();
    const ws1 = getGitChangesSource(api, 'ws1', { graceMs: 0 });
    assert.equal(getGitChangesSource(api, 'ws1'), ws1);
    assert.equal(getGitChangesSource(api, ''), null);
    assert.equal(getGitChangesSource({}, 'ws1'), null, 'no push API, no source');

    const seenA = [];
    const seenB = [];
    const offA = watchGitChanges(api, 'ws1', change => seenA.push(change.reason));
    const offB = watchGitChanges(api, 'ws1', change => seenB.push(change.reason));
    assert.deepEqual(calls, [['+', GIT_STATUS_TOPIC, 'ws1']]);
    assert.equal(listeners.size, 1);

    push({ workspaceId: 'ws1', reason: 'files' });
    push({ workspaceId: 'ws2', reason: 'files' });
    push({ workspaceId: 'ws1', reason: 'commit' });
    assert.deepEqual(seenA, ['files', 'commit']);
    assert.deepEqual(seenB, ['files', 'commit']);
    assert.equal(ws1.data.seq, 2);

    offA();
    offB();
    await tick();
    assert.deepEqual(calls.at(-1), ['-', GIT_STATUS_TOPIC, 'ws1']);
    assert.equal(listeners.size, 0);
});

test('a follower moves its subscription with the shown workspace', async () => {
    const { api, calls, push } = fakeApi();
    getGitChangesSource(api, 'a', { graceMs: 0 });
    getGitChangesSource(api, 'b', { graceMs: 0 });
    const seen = [];
    const follower = createGitChangesFollower(api, (id, change) => seen.push([id, change.reason]));
    follower.follow('a');
    follower.follow('a');
    assert.deepEqual(calls, [['+', 'git.status', 'a']], 'following the same workspace again changes nothing');
    follower.follow('b');
    await tick();
    assert.deepEqual(calls, [['+', 'git.status', 'a'], ['-', 'git.status', 'a'], ['+', 'git.status', 'b']]);
    push({ workspaceId: 'a', reason: 'files' });
    push({ workspaceId: 'b', reason: 'stage' });
    assert.deepEqual(seen, [['b', 'stage']]);
    follower.follow(null);
    await tick();
    assert.deepEqual(calls.at(-1), ['-', 'git.status', 'b']);
    assert.equal(follower.workspaceId, null);
    follower.release();
});

test('when the main process cannot see file edits, getting window focus counts as a change until the source stops', async () => {
    const { api, push } = fakeApi();
    const win = new EventTarget();
    const focus = () => win.dispatchEvent(new Event('focus'));
    getGitChangesSource(api, 'ws1', { graceMs: 0, win });
    const seen = [];
    const off = watchGitChanges(api, 'ws1', change => seen.push(change.reason));
    await tick();
    focus();
    assert.deepEqual(seen, [], 'a fully watched repository ignores focus');

    push({ workspaceId: 'ws1', reason: 'watch-degraded', degraded: true });
    focus();
    push({ workspaceId: 'ws1', reason: 'watch-degraded', degraded: true });
    focus();
    assert.deepEqual(seen, ['watch-degraded', 'focus', 'watch-degraded', 'focus'], 'one focus listener however often it is told');

    off();
    await tick();
    focus();
    assert.equal(seen.length, 4, 'released with the source');
});

test('a window that subscribes after the watch degraded learns it from the subscribe reply', async () => {
    const { api } = fakeApi();
    api.subscribeMainState = async () => ({ success: true, state: { degraded: true } });
    const win = new EventTarget();
    getGitChangesSource(api, 'late', { graceMs: 0, win });
    const seen = [];
    const off = watchGitChanges(api, 'late', change => seen.push(change.reason));
    await tick();
    win.dispatchEvent(new Event('focus'));
    assert.deepEqual(seen, ['focus']);
    off();
});
