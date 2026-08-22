const test = require('node:test');
const assert = require('node:assert/strict');
const { StateChannel } = require('../modules/ui-system/state-channel.js');
const { waitForSettlement } = require('../modules/ui-system/settlement.js');

test('settlement waits for both revision boundary and domain predicate', async () => {
    const channel = new StateChannel('test-settlement', { status: 'idle' });
    const pending = waitForSettlement({
        getSnapshot: () => channel.getSnapshot(),
        subscribe: (...args) => channel.subscribe(...args),
        afterRevision: 2,
        predicate: snapshot => snapshot.value.status === 'ready',
    });
    channel.publish({ status: 'ready' });
    channel.publish({ status: 'loading' });
    channel.publish({ status: 'ready' });
    const snapshot = await pending;
    assert.equal(snapshot.revision, 3);
    assert.equal(snapshot.value.status, 'ready');
    assert.equal(channel.listeners.size, 0);
});

test('settlement abort and timeout clean their subscription', async () => {
    const channel = new StateChannel('test-settlement-cleanup', { status: 'loading' });
    const controller = new AbortController();
    const aborted = waitForSettlement({
        getSnapshot: () => channel.getSnapshot(),
        subscribe: (...args) => channel.subscribe(...args),
        predicate: () => false,
        signal: controller.signal,
    });
    controller.abort('test');
    await assert.rejects(aborted, { name: 'AbortError' });
    assert.equal(channel.listeners.size, 0);
    await assert.rejects(waitForSettlement({
        getSnapshot: () => channel.getSnapshot(),
        subscribe: (...args) => channel.subscribe(...args),
        predicate: () => false,
        timeoutMs: 1,
        label: 'test owner',
    }), /test owner did not settle/);
    assert.equal(channel.listeners.size, 0);
});
