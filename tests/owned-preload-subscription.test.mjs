import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnedPreloadSubscription } from '../modules/renderer/ownedPreloadSubscription.js';

test('owned preload subscription forwards payloads and revokes late delivery', async () => {
    let listener;
    let released = 0;
    const seen = [];
    const owner = createOwnedPreloadSubscription({
        subscribe(handler) { listener = handler; return () => { released += 1; }; },
        consume(value) { seen.push(value); },
    });
    listener('first');
    await owner.dispose();
    listener('late');
    await owner.dispose();
    assert.deepEqual(seen, ['first']);
    assert.equal(released, 1);
});

test('consumer errors are reported without destroying the subscription owner', async () => {
    let listener;
    const errors = [];
    const owner = createOwnedPreloadSubscription({
        subscribe(handler) { listener = handler; return () => {}; },
        consume() { throw new Error('controlled'); },
        reportError(...args) { errors.push(args); },
    });
    listener('payload');
    assert.equal(errors.length, 1);
    await owner.dispose();
});

test('dispose waits for an in-flight async consumer and reports its rejection', async () => {
    let listener;
    let release;
    const errors = [];
    const pending = new Promise((resolve, reject) => { release = { resolve, reject }; });
    const owner = createOwnedPreloadSubscription({
        subscribe(handler) { listener = handler; return () => {}; },
        consume() { return pending; },
        reportError(...args) { errors.push(args); },
    });
    listener('payload');
    let disposed = false;
    const disposal = owner.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disposed, false);
    release.reject(new Error('controlled async failure'));
    await disposal;
    assert.equal(errors.length, 1);
});

test('consumer receives an aborted lifecycle after disposal begins', async () => {
    let listener;
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    let lifecycle;
    const owner = createOwnedPreloadSubscription({
        subscribe(handler) { listener = handler; return () => {}; },
        async consume(_payload, value) { lifecycle = value; await pending; },
    });
    listener('payload');
    const disposal = owner.dispose();
    assert.equal(lifecycle.isActive(), false);
    assert.equal(lifecycle.signal.aborted, true);
    release();
    await disposal;
});
