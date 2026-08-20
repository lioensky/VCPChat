import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnedPreloadSubscription } from '../modules/renderer/ownedPreloadSubscription.js';

test('owned preload subscription forwards payloads and revokes late delivery', () => {
    let listener;
    let released = 0;
    const seen = [];
    const owner = createOwnedPreloadSubscription({
        subscribe(handler) { listener = handler; return () => { released += 1; }; },
        consume(value) { seen.push(value); },
    });
    listener('first');
    owner.dispose();
    listener('late');
    owner.dispose();
    assert.deepEqual(seen, ['first']);
    assert.equal(released, 1);
});

test('consumer errors are reported without destroying the subscription owner', () => {
    let listener;
    const errors = [];
    const owner = createOwnedPreloadSubscription({
        subscribe(handler) { listener = handler; return () => {}; },
        consume() { throw new Error('controlled'); },
        reportError(...args) { errors.push(args); },
    });
    listener('payload');
    assert.equal(errors.length, 1);
    owner.dispose();
});
