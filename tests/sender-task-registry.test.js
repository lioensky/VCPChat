const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SenderTaskRegistry } = require('../modules/services/senderTaskRegistry');

function sender(id = 1) {
    const value = new EventEmitter();
    value.id = id;
    return value;
}

test('sender task registry rejects duplicate identities and settles once', async () => {
    const registry = new SenderTaskRegistry({ label: 'test' });
    const owner = sender();
    let resolve;
    const running = registry.run(owner, 'request-1', 'embedded:create', signal => {
        assert.equal(signal.aborted, false);
        return new Promise(done => { resolve = done; });
    });
    await assert.rejects(
        registry.run(owner, 'request-1', 'embedded:create', async () => null),
        /Duplicate IPC task/
    );
    assert.equal(registry.snapshot().length, 1);
    resolve({ success: true });
    assert.deepEqual(await running, { success: true });
    assert.deepEqual(registry.snapshot(), []);
    assert.equal(owner.listenerCount('destroyed'), 0);
});

test('cancel is idempotent and sender destruction aborts all owned work', async () => {
    const registry = new SenderTaskRegistry();
    const owner = sender(2);
    let firstSignal;
    let secondSignal;
    let finishFirst;
    let finishSecond;
    const first = registry.run(owner, 'first', 'embedded:create', signal => {
        firstSignal = signal;
        return new Promise(resolve => { finishFirst = resolve; });
    });
    const second = registry.run(owner, 'second', 'embedded:detach', signal => {
        secondSignal = signal;
        return new Promise(resolve => { finishSecond = resolve; });
    });
    assert.equal(registry.cancel(owner, 'first', 'closed'), true);
    assert.equal(registry.cancel(owner, 'first', 'closed-again'), true);
    assert.equal(firstSignal.aborted, true);
    assert.equal(firstSignal.reason, 'closed');
    owner.emit('destroyed');
    assert.equal(secondSignal.aborted, true);
    finishFirst({ cancelled: true });
    finishSecond({ cancelled: true });
    await Promise.all([first, second]);
    assert.deepEqual(registry.snapshot(), []);
});

test('invalid task descriptors and reused numeric sender identities are rejected', async () => {
    const registry = new SenderTaskRegistry();
    const owner = sender(3);
    assert.throws(() => registry.begin(owner, '../bad', 'embedded:create'), /Invalid IPC task requestId/);
    const task = registry.begin(owner, 'valid', 'embedded:create');
    assert.ok(task.controller);
    assert.throws(() => registry.begin(sender(3), 'other', 'embedded:create'), /sender identity changed/);
    registry.finish(owner, 'valid');
});
