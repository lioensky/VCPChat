import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSharedSource, sharedSourceDiagnostics } from '../modules/ui-system/shared-source.js';
import { getCommandRunsSource, mergeCommandRun } from '../modules/ui-system/sources/terminal-command-runs.js';
import '../modules/ui-system/lifecycle-scope.js';

const { LifecycleScope } = globalThis.VCPLifecycle;
const { StateChannel } = globalThis.VCPStateChannels;
const tick = () => new Promise(resolve => setImmediate(resolve));

function countingSource(options = {}) {
    const calls = { starts: 0, stops: 0, fetches: 0 };
    let value = 0;
    const source = createSharedSource('test.counting', {
        graceMs: 0,
        start({ signal }) {
            calls.starts += 1;
            signal.addEventListener('abort', () => { calls.stops += 1; });
        },
        async fetch() {
            calls.fetches += 1;
            value += 1;
            return value;
        },
        ...options
    });
    return { source, calls };
}

test('the first holder starts the source and fetches once; the last one stops it', async () => {
    const { source, calls } = countingSource();
    assert.equal(source.get().status, 'idle');
    const seen = [];
    const releaseA = source.subscribe(({ data }) => seen.push(data));
    const releaseB = source.retain();
    await source.settled();
    assert.deepEqual(calls, { starts: 1, stops: 0, fetches: 1 }, 'two holders share one start and one fetch');
    assert.equal(source.get().status, 'ready');
    assert.equal(seen.at(-1), 1);

    releaseA();
    releaseA();
    assert.equal(source.running, true, 'one holder left');
    releaseB();
    assert.equal(source.running, false);
    assert.equal(calls.stops, 1);
    assert.equal(source.data, 1, 'the last snapshot stays readable after stopping');
    assert.equal(source.get().status, 'idle', 'but it is no longer kept up to date, so it is not ready');

    // 下一个持有者先看到旧数据加 loading，新结果回来才是 ready
    const states = [];
    const releaseC = source.subscribe(({ status, data }) => states.push([status, data]));
    await source.settled();
    assert.deepEqual(states, [['loading', 1], ['ready', 2]]);
    releaseC();
    source.dispose();
});

test('releasing inside the grace period keeps the source running; afterwards it stops', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { source, calls } = countingSource({ graceMs: 30_000 });
    try {
        source.retain()();
        mock.timers.tick(10_000);
        const release = source.retain();
        assert.equal(calls.starts, 1, 'switching tabs inside the grace period does not restart');
        release();
        assert.equal(source.diagnostics().pendingStop, true);
        mock.timers.tick(30_000);
        assert.equal(source.running, false);
        assert.equal(calls.stops, 1);
    } finally {
        source.dispose();
        mock.timers.reset();
    }
});

test('a holder tied to a scope is released with it', async () => {
    const { source } = countingSource();
    const scope = new LifecycleScope('consumer');
    source.subscribe(() => {}, { scope });
    assert.equal(source.holders, 1);
    await scope.dispose();
    assert.equal(source.holders, 0);
    assert.equal(source.running, false);
    source.dispose();
});

test('invalidate merges concurrent requests and does nothing without holders', async () => {
    let resolve;
    let fetches = 0;
    const source = createSharedSource('test.merge', {
        graceMs: 0,
        fetch: () => { fetches += 1; return new Promise(r => { resolve = r; }); }
    });
    await source.invalidate();
    assert.equal(fetches, 0, 'nobody holds the source, nothing to fetch');

    const release = source.retain();
    assert.equal(fetches, 1);
    const a = source.invalidate();
    const b = source.invalidate();
    assert.equal(fetches, 1, 'a request is already running: queue a single follow-up');
    resolve('first');
    await tick();
    assert.equal(fetches, 2);
    resolve('second');
    assert.equal((await a).data, 'second');
    assert.equal((await b).data, 'second');
    release();
    source.dispose();
});

test('pushes that arrive while a fetch is in flight are not overwritten by the older list', async () => {
    let resolve;
    let push;
    const source = createSharedSource('test.replay', {
        initial: [],
        graceMs: 0,
        start({ update }) { push = summary => update(runs => mergeCommandRun(runs, summary)); },
        fetch: () => new Promise(r => { resolve = r; })
    });
    const release = source.retain();
    push({ id: 'new', status: 'running' });
    resolve([{ id: 'old', status: 'completed' }]);
    await source.settled();
    assert.deepEqual(source.data.map(run => run.id), ['new', 'old']);
    release();
    source.dispose();
});

test('a failed fetch is reported and the next invalidate retries', async () => {
    let fail = true;
    const source = createSharedSource('test.error', {
        graceMs: 0,
        fetch: async () => { if (fail) throw new Error('offline'); return 'ok'; }
    });
    const release = source.retain();
    await source.settled();
    assert.equal(source.get().status, 'error');
    assert.equal(source.get().error, 'offline');
    fail = false;
    await source.invalidate();
    assert.equal(source.get().status, 'ready');
    assert.equal(source.data, 'ok');
    release();
    fail = true;
    const again = source.retain();
    await source.settled();
    again();
    assert.equal(source.get().status, 'idle', 'an error is not kept once the source stops');
    assert.equal(source.get().error, null);
    source.dispose();
});

test('the poll runs once per source and only while some holder is visible', async () => {
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
    const { source, calls } = countingSource({ pollMs: 1000 });
    const visibleA = new StateChannel('test.visible-a', false);
    const visibleB = new StateChannel('test.visible-b', false);
    try {
        source.retain(null, { visible: visibleA });
        source.retain(null, { visible: visibleB });
        await tick();
        assert.equal(calls.fetches, 1, 'the initial fetch');
        mock.timers.tick(10 * 60_000);
        assert.equal(calls.fetches, 1, 'hidden: no polling');
        assert.equal(source.diagnostics().polling, false);

        visibleA.publish(true);
        visibleB.publish(true);
        assert.equal(calls.fetches, 2, 'shown after a long time: catch up once, not once per holder');
        await tick();
        mock.timers.tick(1000);
        assert.equal(calls.fetches, 3, 'two visible holders still share one poll');

        visibleA.publish(false);
        await tick();
        mock.timers.tick(1000);
        assert.equal(calls.fetches, 4, 'one holder still visible');
        visibleB.publish(false);
        await tick();
        mock.timers.tick(10_000);
        assert.equal(calls.fetches, 4);
    } finally {
        source.dispose();
        visibleA.dispose();
        visibleB.dispose();
        mock.timers.reset();
    }
});

test('diagnostics list live sources and forget disposed ones', () => {
    const source = createSharedSource('Test Diag', { key: 'WS/1', graceMs: 0 });
    assert.equal(source.name, 'test-diag.ws-1', 'names are made safe for StateChannel');
    const release = source.retain(null, { label: 'git-view' });
    const entry = sharedSourceDiagnostics().find(item => item.name === source.name);
    assert.equal(entry.holders, 1);
    assert.deepEqual(entry.holderLabels, ['git-view'], 'who still holds the source is visible by label');
    assert.equal(globalThis.VCPSharedSources.diagnostics().some(item => item.name === source.name), true);
    release();
    source.dispose();
    assert.equal(sharedSourceDiagnostics().some(item => item.name === source.name), false);
    assert.throws(() => source.retain(), /disposed/);
});

test('command runs: one source per api, watch on first holder, unwatch after the last one leaves', async () => {
    const calls = [];
    let push = null;
    const api = {
        terminalListCommandRuns: async () => { calls.push('list'); return { success: true, data: [{ id: 'r1', status: 'completed' }] }; },
        terminalWatchCommandRuns: async () => { calls.push('watch'); return { success: true }; },
        terminalUnwatchCommandRuns: async () => { calls.push('unwatch'); return { success: true }; },
        onTerminalCommandRunChanged: cb => { push = cb; return () => { push = null; }; }
    };
    const source = getCommandRunsSource(api, { graceMs: 0 });
    assert.equal(getCommandRunsSource(api), source);
    assert.equal(getCommandRunsSource({}), null, 'no terminal API, no source');
    assert.deepEqual(calls, [], 'creating the source does not touch the terminal');

    const panel = source.subscribe(() => {});
    const tab = source.subscribe(() => {});
    await source.settled();
    assert.deepEqual(calls, ['watch', 'list']);
    push({ id: 'r2', status: 'running' });
    push({ id: 'r1', status: 'completed', endedAt: 5 });
    assert.deepEqual(source.data.map(run => [run.id, run.status]), [['r2', 'running'], ['r1', 'completed']]);
    assert.equal(source.data[1].endedAt, 5);

    panel();
    assert.equal(calls.includes('unwatch'), false);
    tab();
    await tick();
    assert.deepEqual(calls, ['watch', 'list', 'unwatch']);
    assert.equal(push, null);
    source.dispose();
});

test('mergeCommandRun keeps untouched entries as the same objects', () => {
    const a = { id: 'a', status: 'running' };
    const b = { id: 'b', status: 'completed' };
    const merged = mergeCommandRun([a, b], { id: 'a', status: 'completed' });
    assert.notEqual(merged[0], a);
    assert.equal(merged[1], b);
    assert.deepEqual(mergeCommandRun([a], null), [a]);
});

test('mergeCommandRun keeps the same number of runs as the main process', async () => {
    const { COMMAND_RUN_LIMIT } = await import('../modules/ui-system/sources/terminal-command-runs.js');
    let runs = [];
    for (let i = 0; i < COMMAND_RUN_LIMIT + 5; i++) runs = mergeCommandRun(runs, { id: `r${i}`, status: 'running' });
    assert.equal(runs.length, COMMAND_RUN_LIMIT);
    assert.equal(runs[0].id, `r${COMMAND_RUN_LIMIT + 4}`);
    assert.equal(runs.some(run => run.id === 'r0'), false, 'runs the main process evicted are dropped');
});
