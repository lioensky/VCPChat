const test = require('node:test');
const assert = require('node:assert/strict');

test('performance recorder is bounded, payload-safe and marks budgets', async () => {
    const path = require.resolve('../modules/ui-system/performance-recorder.js');
    delete require.cache[path];
    const recorder = require(path);
    const observed = [];
    const unsubscribe = recorder.subscribe(entry => observed.push(entry));
    recorder.record('next.mount', 501, { mode: 'next', nested: { secret: true } });
    assert.equal(observed[0].withinBudget, false);
    assert.deepEqual(observed[0].metadata, { mode: 'next' });
    assert.equal(await recorder.measure('embedded.activate', async () => 42), 42);
    for (let index = 0; index < 120; index += 1) recorder.record('probe', index);
    assert.equal(recorder.snapshot().length, 100);
    assert.equal(unsubscribe(), true);
    assert.equal(unsubscribe(), false);
});

test('performance recorder preserves sync return values and failure semantics', () => {
    const recorder = require('../modules/ui-system/performance-recorder.js');
    assert.equal(recorder.measure('settings.open', () => 'opened'), 'opened');
    assert.throws(() => recorder.measure('settings.open', () => { throw new Error('failed'); }), /failed/);
    assert.equal(recorder.snapshot().at(-1).metadata.status, 'rejected');
});
