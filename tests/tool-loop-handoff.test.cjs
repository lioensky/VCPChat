'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolLoopHandoff } = require('../modules/services/toolLoopHandoff');
const scope = { itemType: 'agent', itemId: 'a', topicId: 't' };
const entry = id => ({ scope, entryId: id, state: 'queued' });
function fixture(supported = true) {
    const calls = [];
    const coordinator = createToolLoopHandoff({
        sendControl: async payload => { calls.push(payload); return { success: true }; },
    });
    const handle = coordinator.register({ requestId: 'real-id', scope, supported });
    return { calls, coordinator, handle };
}
test('many entries share one ready; only last withdrawal cancels', async () => {
    const { calls, coordinator: c, handle: h } = fixture();
    c.updateEntries([entry('1')]); await h.idle();
    c.updateEntries([entry('1'), entry('2')]); await h.idle();
    c.updateEntries([entry('2')]); await h.idle();
    assert.equal(calls.length, 1);
    c.updateEntries([]); await h.idle();
    assert.deepEqual(calls.map(x => x.action), ['prepare_handoff', 'cancel_handoff']);
    assert.equal(calls[0].handoffId, calls[1].handoffId);
    assert.ok(calls.every(x => x.requestId === 'real-id'));
});
test('compression retains reservation after queue empties', async () => {
    const { calls, coordinator: c, handle: h } = fixture();
    c.updateEntries([entry('1')]); await h.idle();
    await h.setCompression(true);
    c.updateEntries([]); await h.idle();
    assert.equal(calls.length, 1);
    await h.setCompression(false);
    assert.equal(calls[1].action, 'cancel_handoff');
});
test('unsupported backend remains silent until explicit capability', async () => {
    const { calls, coordinator: c, handle: h } = fixture(false);
    c.updateEntries([entry('1')]); await h.idle();
    assert.equal(calls.length, 0);
    await h.setSupported(true);
    assert.equal(calls.length, 1);
});
test('seal prevents consumption from resuming old loop', async () => {
    const { calls, coordinator: c, handle: h } = fixture();
    c.updateEntries([entry('1')]); await h.idle();
    h.seal(); c.updateEntries([]); await h.idle();
    assert.equal(calls.length, 1);
    h.finish();
    c.updateEntries([entry('2')]);
    assert.equal(calls.length, 1);
});
test('request scopes are isolated and rearming creates a fresh ID', async () => {
    const { calls, coordinator: c, handle: h } = fixture();
    const other = c.register({ requestId: 'other', scope: { ...scope, topicId: 'other' }, supported: true });
    c.updateEntries([entry('1')]); await h.idle(); await other.idle();
    c.updateEntries([]); await h.idle();
    c.updateEntries([entry('2')]); await h.idle();
    assert.equal(calls.length, 3);
    assert.notEqual(calls[0].handoffId, calls[2].handoffId);
    assert.ok(calls.every(x => x.requestId === 'real-id'));
});
test('controls remain serial during rapid withdrawal and rearm', async () => {
    const calls = [];
    let release;
    const c = createToolLoopHandoff({ sendControl: async payload => {
        calls.push(payload);
        if (calls.length === 1) await new Promise(resolve => { release = resolve; });
        return { success: true };
    } });
    const h = c.register({ requestId: 'r', scope, supported: true });
    c.updateEntries([entry('1')]);
    await new Promise(resolve => setImmediate(resolve));
    c.updateEntries([]); c.updateEntries([entry('2')]);
    assert.equal(calls.length, 1);
    release(); await h.idle();
    assert.deepEqual(calls.map(x => x.action), ['prepare_handoff', 'cancel_handoff', 'prepare_handoff']);
    assert.deepEqual(calls.map(x => x.revision), [1, 2, 3]);
});