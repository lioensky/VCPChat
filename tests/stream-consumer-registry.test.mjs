import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamConsumerRegistry } from '../modules/chat/streamConsumerRegistry.js';

test('stream consumer routes are exact-owner scoped and absent after release', () => {
    const registry = createStreamConsumerRegistry();
    const first = { kind: 'main-chat' };
    const releaseFirst = registry.register('m1', first);
    assert.equal(registry.claim('m1').suppressed, false);
    assert.throws(
        () => registry.register('m1', { kind: 'independent-surface' }),
        /already registered/,
    );
    assert.equal(registry.claim('m1').suppressed, false, 'duplicate registration must not replace the current owner');
    releaseFirst();
    assert.equal(registry.claim('m1'), null);
});

test('stream consumer registry rejects registration after owner dispose', () => {
    const registry = createStreamConsumerRegistry();
    registry.register('m2', { kind: 'main-chat' });
    registry.dispose();
    assert.equal(registry.claim('m2'), null);
    assert.throws(() => registry.register('late', {}), /disposed/);
});

test('owner retraction leaves a one-terminal tombstone for late stream events', () => {
    const registry = createStreamConsumerRegistry();
    const calls = [];
    const release = registry.register('late', { start: () => calls.push('start'), append: () => calls.push('append') });
    const captured = registry.claim('late');
    release.retract();
    const tombstone = registry.claim('late');
    assert.equal(tombstone.suppressed, true);
    captured.start();
    captured.append();
    assert.deepEqual(calls, [], 'a route captured before retraction must lose projection authority');
    tombstone.release();
    assert.equal(registry.claim('late'), null);
});
