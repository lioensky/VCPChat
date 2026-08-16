const test = require('node:test');
const assert = require('node:assert/strict');
const { TaskHandle, createTaskId } = require('../modules/ui-system/task-handle.js');
const { LifecycleScope } = require('../modules/ui-system/lifecycle-scope.js');

test('task handle starts once and cancellation is idempotent', async () => {
    let starts = 0;
    let cancels = 0;
    let resolveTask;
    const task = new TaskHandle({
        id: 'request-1',
        start: () => { starts += 1; return new Promise(resolve => { resolveTask = resolve; }); },
        cancel: async id => { assert.equal(id, 'request-1'); cancels += 1; },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 1);
    const first = task.cancel();
    const second = task.cancel();
    assert.equal(first, second);
    await first;
    assert.equal(cancels, 1);
    resolveTask({ success: false, cancelled: true });
    await task.promise;
    assert.equal(task.cancelled, true);
});

test('scope disposal owns cancellation before late completion', async () => {
    let cancelled = 0;
    let resolveTask;
    const scope = new LifecycleScope('task-owner');
    const task = new TaskHandle({
        id: 'request-2',
        start: () => new Promise(resolve => { resolveTask = resolve; }),
        cancel: () => { cancelled += 1; },
    });
    const result = task.own(scope, 'owned-request');
    await new Promise(resolve => setImmediate(resolve));
    await scope.dispose('test');
    assert.equal(cancelled, 1);
    resolveTask({ success: false, cancelled: true });
    await result;
    assert.equal(scope.snapshot().resourceCount, 0);
});

test('settled tasks do not issue redundant cancellation', async () => {
    let cancelled = 0;
    const task = new TaskHandle({ id: 'request-3', start: async () => 42, cancel: () => { cancelled += 1; } });
    assert.equal(await task.promise, 42);
    assert.equal(await task.cancel(), false);
    assert.equal(cancelled, 0);
});

test('cancellation aborts the renderer token and settled tasks release teardown bookkeeping', async () => {
    let resolveTask;
    let observedSignal;
    const scope = new LifecycleScope('task-release');
    const task = new TaskHandle({
        id: 'request-4',
        start: (_id, signal) => {
            observedSignal = signal;
            return new Promise(resolve => { resolveTask = resolve; });
        },
    });
    const result = task.own(scope, 'short-task');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(observedSignal.aborted, false);
    await task.cancel('user-closed');
    assert.equal(observedSignal.aborted, true);
    assert.equal(observedSignal.reason, 'user-closed');
    resolveTask('late-result');
    assert.equal(await result, 'late-result');
    assert.equal(scope.snapshot().resourceCount, 0);
    await scope.dispose('test');
});

test('task ids are operation-scoped and unique', () => {
    const first = createTaskId('embedded create');
    const second = createTaskId('embedded create');
    assert.match(first, /^embedded-create:/);
    assert.notEqual(first, second);
});
