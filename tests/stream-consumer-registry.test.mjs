import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamConsumerRegistry } from '../modules/chat/streamConsumerRegistry.js';

test('stream consumer routes are exact-owner scoped and absent after release', () => {
    const registry = createStreamConsumerRegistry();
    const first = { kind: 'main-chat' };
    const releaseFirst = registry.register('m1', first);
    assert.equal(registry.claim('m1'), first);
    const second = { kind: 'independent-surface' };
    const releaseSecond = registry.register('m1', second);
    releaseFirst();
    assert.equal(registry.claim('m1'), second);
    releaseSecond();
    assert.equal(registry.claim('m1'), null);
});

test('stream consumer registry rejects registration after owner dispose', () => {
    const registry = createStreamConsumerRegistry();
    registry.register('m2', { kind: 'main-chat' });
    registry.dispose();
    assert.equal(registry.claim('m2'), null);
    assert.throws(() => registry.register('late', {}), /disposed/);
});
