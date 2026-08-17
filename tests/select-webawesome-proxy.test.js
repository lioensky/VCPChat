import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { mountWebAwesomeSelectProxy } from '../modules/ui-system/select-webawesome-proxy.js';

test('proxy mount failure atomically restores the business Select', () => {
    const dom = new JSDOM('<!doctype html><label for="choice">Choice</label><select id="choice" class="business"><option value="a">A</option></select>');
    const { document } = dom.window;
    const source = document.querySelector('select');
    const wa = document.createElement('wa-select');
    const remembered = new WeakMap();

    assert.throws(() => mountWebAwesomeSelectProxy({
        element: source,
        wa,
        providerDecision: Object.freeze({ provider: 'webawesome-proxy' }),
        makeController() { throw new Error('controlled mount failure'); },
        attachControlApi() {},
        waSize() {},
        waFocus() {},
        rememberController: (element, controller) => remembered.set(element, controller),
        forgetController: element => remembered.delete(element),
    }), /controlled mount failure/);

    assert.equal(source.hidden, false);
    assert.equal(source.getAttribute('aria-hidden'), null);
    assert.equal(source.getAttribute('tabindex'), null);
    assert.equal(source.className, 'business');
    assert.equal(Object.hasOwn(source, 'value'), false);
    assert.equal(Object.hasOwn(source, 'selectedIndex'), false);
    assert.equal(Object.hasOwn(source, 'add'), false);
    assert.equal(Object.hasOwn(source, 'remove'), false);
    assert.equal(Object.hasOwn(source, 'focus'), false);
    assert.equal(wa.isConnected, false);
    assert.equal(remembered.has(source), false);
});
