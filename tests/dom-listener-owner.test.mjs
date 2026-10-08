import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomListenerOwner } from '../modules/renderer/domListenerOwner.js';

test('DOM listener owner removes registrations and ignores late adds', () => {
    const added = []; const removed = []; const target = { addEventListener: (...args) => added.push(args), removeEventListener: (...args) => removed.push(args) };
    const owner = createDomListenerOwner(); const handler = () => {};
    assert.equal(owner.add(target, 'click', handler), true); owner.dispose(); owner.dispose(); assert.equal(owner.add(target, 'click', handler), false);
    assert.equal(added.length, 1); assert.equal(removed.length, 1); assert.equal(removed[0][1], handler);
});

test('fired timeouts and once listeners drop out of the owner; dispose still clears the rest', async () => {
    const owner = createDomListenerOwner();
    const target = new EventTarget();
    let fired = 0, persistent = 0, late = 0;
    owner.add(target, 'ping', () => { persistent += 1; });
    owner.add(target, 'once', () => { fired += 1; }, { once: true });
    owner.timeout(() => { fired += 1; }, 5);
    owner.timeout(() => { late += 1; }, 60000);
    assert.equal(owner.size(), 4);

    target.dispatchEvent(new Event('once'));
    target.dispatchEvent(new Event('once'));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fired, 2);
    assert.equal(owner.size(), 2);

    owner.dispose();
    target.dispatchEvent(new Event('ping'));
    assert.equal(persistent, 0);
    assert.equal(late, 0);
    assert.equal(owner.size(), 0);
});
