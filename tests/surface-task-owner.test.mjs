import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSurfaceTaskOwner } from '../modules/renderer/surfaceTaskOwner.js';

function createControlledScheduler() {
    let id = 0;
    const callbacks = new Map();
    return {
        requestAnimationFrame(callback) { callbacks.set(++id, callback); return id; },
        cancelAnimationFrame(handle) { callbacks.delete(handle); },
        requestIdleCallback(callback) { callbacks.set(++id, callback); return id; },
        cancelIdleCallback(handle) { callbacks.delete(handle); },
        flush() { const work = [...callbacks.values()]; callbacks.clear(); work.forEach(callback => callback(0)); },
        get size() { return callbacks.size; },
    };
}

test('revoking one JSDOM Surface does not revoke another root', async () => {
    const dom = new JSDOM('<main><section id="a"></section><section id="b"></section></main>');
    const rootA = dom.window.document.getElementById('a');
    const rootB = dom.window.document.getElementById('b');
    const scheduler = createControlledScheduler();
    const owner = createSurfaceTaskOwner({ environmentForRoot: () => scheduler });
    const workA = owner.animationFrame(rootA, () => rootA.append('A complete'));
    const workB = owner.animationFrame(rootB, () => rootB.append('B should not appear'));

    owner.revoke(rootB);
    scheduler.flush();
    await Promise.all([workA, workB]);
    assert.equal(rootA.textContent, 'A complete');
    assert.equal(rootB.textContent, '');
});

test('dispose cancels scheduled work and waits for already-started work', async () => {
    const dom = new JSDOM('<main><section id="a"></section></main>');
    const root = dom.window.document.getElementById('a');
    const scheduler = createControlledScheduler();
    const owner = createSurfaceTaskOwner({ environmentForRoot: () => scheduler });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const running = owner.animationFrame(root, async () => { await gate; root.append('finished'); });
    scheduler.flush();
    let disposed = false;
    const disposal = owner.dispose(root).then(() => { disposed = true; });
    await Promise.resolve();
    assert.equal(disposed, false);
    release();
    await Promise.all([running, disposal]);
    assert.equal(disposed, true);

    const late = owner.animationFrame(root, () => root.append('late'));
    await assert.rejects(late, /disposed/);
    assert.equal(root.textContent, 'finished');
    assert.equal(scheduler.size, 0);
});

test('frame fallback owns and clears its timeout handle', async () => {
    let callback = null;
    let cleared = null;
    const environment = {
        setTimeout(next) { callback = next; return 41; },
        clearTimeout(handle) { cleared = handle; callback = null; },
    };
    const owner = createSurfaceTaskOwner({ environmentForRoot: () => environment });
    const root = {};
    const work = owner.animationFrame(root, () => assert.fail('revoked fallback must not run'));
    owner.revoke(root);
    assert.equal(cleared, 41);
    assert.equal(callback, null);
    assert.deepEqual(await work, { status: 'revoked' });
});
