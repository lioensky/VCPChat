import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createChatSurfaceSlots } from '../modules/chat/chatSurfaceSlots.js';

test('chat surface slots are named, disposable and receive readonly snapshots', () => {
    const root = new JSDOM('<div></div>').window.document.querySelector('div');
    const slots = createChatSurfaceSlots();
    const seen = [];
    const dispose = slots.register('header', 'skin', (host, snapshot) => { seen.push(snapshot.mode); host.textContent = 'skin'; });
    const owned = slots.mount('header', root, { mode: 'readonly', canSend: false });
    assert.deepEqual(seen, ['readonly']);
    assert.equal(root.querySelector('[data-chat-slot-owner="skin"]')?.textContent, 'skin');
    owned.forEach(unmount => unmount());
    dispose();
    slots.dispose();
    assert.equal(root.childElementCount, 0);
});

test('slot mount rolls back earlier contributions when a later consumer fails', () => {
    const root = new JSDOM('<div></div>').window.document.querySelector('div');
    const slots = createChatSurfaceSlots();
    let disposed = 0;
    slots.register('header', 'first', () => () => { disposed += 1; });
    slots.register('header', 'broken', () => { throw new Error('mount failed'); });
    assert.throws(() => slots.mount('header', root, {}), /mount failed/);
    assert.equal(root.childElementCount, 0);
    assert.equal(disposed, 1);
});
