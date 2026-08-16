const assert = require('node:assert/strict');
const test = require('node:test');
const { LifecycleScope, diagnostics } = require('../modules/ui-system/lifecycle-scope.js');

test('owned resources dispose once in reverse order and await async cleanup', async () => {
    const scope = new LifecycleScope('reverse-order');
    const calls = [];
    scope.own(() => calls.push('first'), 'first');
    scope.own(async () => {
        await Promise.resolve();
        calls.push('second');
    }, 'second');

    const firstDispose = scope.dispose();
    const secondDispose = scope.dispose();
    assert.strictEqual(firstDispose, secondDispose);
    await firstDispose;
    assert.deepEqual(calls, ['second', 'first']);
    assert.equal(scope.disposed, true);
    assert.equal(diagnostics.find('reverse-order').length, 0);
});

test('dispose waits for a cleanup already started by manual release', async () => {
    const scope = new LifecycleScope('manual-release-race');
    let finishCleanup;
    let cleanupFinished = false;
    const release = scope.own(() => new Promise(resolve => {
        finishCleanup = () => {
            cleanupFinished = true;
            resolve();
        };
    }), 'slow-cleanup');

    const releasePromise = release();
    await Promise.resolve();
    let disposeFinished = false;
    const disposePromise = scope.dispose().then(() => { disposeFinished = true; });
    await Promise.resolve();
    assert.equal(disposeFinished, false, 'scope cannot dispose before in-flight cleanup settles');
    finishCleanup();
    await Promise.all([releasePromise, disposePromise]);
    assert.equal(cleanupFinished, true);
    assert.equal(scope.disposed, true);
});

test('dispose reports a failure from cleanup already started by manual release', async () => {
    const scope = new LifecycleScope('manual-release-failure');
    let rejectCleanup;
    const release = scope.own(() => new Promise((_, reject) => { rejectCleanup = reject; }), 'failing-cleanup');
    const releasePromise = release();
    await Promise.resolve();
    const disposePromise = scope.dispose();
    rejectCleanup(new Error('late cleanup failure'));
    await assert.rejects(releasePromise, /late cleanup failure/);
    await assert.rejects(disposePromise, error => error instanceof AggregateError && /cleanup failed/.test(error.message));
});

test('one cleanup failure does not prevent remaining resources from releasing', async () => {
    const scope = new LifecycleScope('aggregate-errors');
    const calls = [];
    scope.own(() => calls.push('survived'), 'survived');
    scope.own(() => { throw new Error('expected cleanup failure'); }, 'failing');
    await assert.rejects(scope.dispose(), AggregateError);
    assert.deepEqual(calls, ['survived']);
    assert.equal(scope.disposed, true);
});

test('listeners, timers, observers and abort controllers share one owner', async () => {
    const scope = new LifecycleScope('resource-types');
    const target = new EventTarget();
    let events = 0;
    let ticks = 0;
    let disconnected = 0;
    scope.listen(target, 'ping', () => { events += 1; });
    scope.timeout(() => { ticks += 1; }, 50);
    const observer = { observe() {}, disconnect() { disconnected += 1; } };
    scope.observe(observer, {});
    const controller = scope.abortController();

    target.dispatchEvent(new Event('ping'));
    assert.equal(events, 1);
    assert.deepEqual(diagnostics.summary().resourcesByType, {
        listener: 1,
        timeout: 1,
        observer: 1,
        'abort-controller': 1,
    });

    await scope.dispose();
    target.dispatchEvent(new Event('ping'));
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(events, 1);
    assert.equal(ticks, 0);
    assert.equal(disconnected, 1);
    assert.equal(controller.signal.aborted, true);
});

test('generation guards suppress late work after replacement and disposal', async () => {
    const scope = new LifecycleScope('generation');
    let calls = 0;
    const oldGuard = scope.guard(() => { calls += 1; });
    oldGuard();
    scope.bumpGeneration();
    oldGuard();
    const currentGuard = scope.guard(() => { calls += 1; });
    currentGuard();
    await scope.dispose();
    currentGuard();
    assert.equal(calls, 2);
});

test('once listeners retract from diagnostics after firing', async () => {
    const scope = new LifecycleScope('once-listener');
    const target = new EventTarget();
    let calls = 0;
    scope.listen(target, 'once', () => { calls += 1; }, { once: true });
    target.dispatchEvent(new Event('once'));
    target.dispatchEvent(new Event('once'));
    assert.equal(calls, 1);
    assert.equal(scope.snapshot().resourceCount, 0);
    await scope.dispose();
});

test('child scopes collapse with their parent', async () => {
    const parent = new LifecycleScope('parent');
    const child = parent.child('child');
    let released = 0;
    child.own(() => { released += 1; });
    await parent.dispose();
    assert.equal(child.disposed, true);
    assert.equal(released, 1);
    assert.equal(diagnostics.find('child').length, 0);
});

test('disposing a child retracts its ownership record from the parent', async () => {
    const parent = new LifecycleScope('parent-with-short-child');
    const child = parent.child('short-child');
    assert.equal(parent.snapshot().resources[0].type, 'child-scope');
    await child.dispose();
    assert.equal(parent.snapshot().resourceCount, 0);
    await parent.dispose();
});

test('concurrent child and parent disposal releases shared ownership exactly once', async () => {
    const parent = new LifecycleScope('concurrent-parent');
    const child = parent.child('concurrent-child');
    let releases = 0;
    child.own(async () => {
        await Promise.resolve();
        releases += 1;
    });
    await Promise.all([child.dispose('direct'), parent.dispose('root')]);
    assert.equal(releases, 1);
    assert.equal(parent.disposed, true);
    assert.equal(child.disposed, true);
    assert.equal(diagnostics.find('concurrent-parent').length, 0);
    assert.equal(diagnostics.find('concurrent-child').length, 0);
});

test('settled timeouts and tracked tasks leave diagnostics', async () => {
    const scope = new LifecycleScope('settled-resources');
    let fired = 0;
    scope.timeout(() => { fired += 1; }, 0);
    await scope.track(Promise.resolve('done'));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fired, 1);
    assert.equal(scope.snapshot().resourceCount, 0);
    await scope.dispose();
});

test('owned resources can be forgotten after natural settlement without running cleanup', async () => {
    const scope = new LifecycleScope('forgotten-resource');
    let cleanup = 0;
    const release = scope.own(() => { cleanup += 1; }, 'settled-task', 'task-cancel');
    await release.forget();
    assert.equal(cleanup, 0);
    assert.equal(scope.snapshot().resourceCount, 0);
    await release();
    assert.equal(cleanup, 0, 'forgotten cleanup cannot run later');
    await scope.dispose();
});

test('animation frames are owned and suppressed after disposal', async () => {
    const scope = new LifecycleScope('animation-frame');
    let fired = 0;
    scope.animationFrame(() => { fired += 1; });
    await scope.dispose();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(fired, 0);
});
