import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomListenerOwner } from '../modules/renderer/domListenerOwner.js';

test('DOM listener owner removes registrations and ignores late adds', () => {
    const added = []; const removed = []; const target = { addEventListener: (...args) => added.push(args), removeEventListener: (...args) => removed.push(args) };
    const owner = createDomListenerOwner(); const handler = () => {};
    assert.equal(owner.add(target, 'click', handler), true); owner.dispose(); owner.dispose(); assert.equal(owner.add(target, 'click', handler), false);
    assert.equal(added.length, 1); assert.equal(removed.length, 1); assert.equal(removed[0][1], handler);
});
