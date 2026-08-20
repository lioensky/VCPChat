import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderSessionAuthority } from '../modules/renderer/renderSessionAuthority.js';

test('render session generations are isolated per Surface root', () => {
    const rootA = {};
    const rootB = {};
    const authority = createRenderSessionAuthority({ resolveDefaultRoot: () => rootA });
    const a1 = authority.capture(rootA);
    const b1 = authority.capture(rootB);

    const a2 = authority.invalidate(rootA);
    assert.equal(authority.isActive(a1), false);
    assert.equal(authority.isActive(a2), true);
    assert.equal(authority.isActive(b1), true);

    const b2 = authority.invalidate(rootB);
    assert.equal(authority.isActive(a2), true);
    assert.equal(authority.isActive(b1), false);
    assert.equal(authority.isActive(b2), true);
});

test('default root and detached sessions remain explicit and immutable', () => {
    const root = {};
    const authority = createRenderSessionAuthority({ resolveDefaultRoot: () => root });
    const initial = authority.capture();
    const next = authority.invalidate();
    assert.equal(authority.isActive(initial), false);
    assert.equal(authority.isActive(next), true);
    assert.equal(Object.isFrozen(next), true);

    const detached = createRenderSessionAuthority();
    const d1 = detached.capture();
    const d2 = detached.invalidate();
    assert.equal(detached.isActive(d1), false);
    assert.equal(detached.isActive(d2), true);
});
