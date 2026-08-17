import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { mountWebAwesomeSelectProxy } from '../modules/ui-system/select-webawesome-proxy.js';

function createController(element, state, render, cleanup) {
    const listeners = [];
    let destroyed = false;
    const controller = {
        element,
        update(patch = {}) {
            Object.assign(state, patch);
            render(state);
            return controller;
        },
        _listen(target, type, handler, options) {
            target.addEventListener(type, handler, options);
            listeners.push(() => target.removeEventListener(type, handler, options));
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            listeners.splice(0).reverse().forEach(dispose => dispose());
            cleanup();
            element.remove();
        },
    };
    render(state);
    return controller;
}

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

test('queued mutation work cannot resurrect a destroyed proxy', async () => {
    const dom = new JSDOM('<!doctype html><div id="host"><select id="choice"><option value="a">A</option></select></div>');
    const { document } = dom.window;
    const source = document.querySelector('select');
    const wa = document.createElement('wa-select');
    wa.value = 'a';
    const remembered = new WeakMap();
    const controller = mountWebAwesomeSelectProxy({
        element: source,
        wa,
        providerDecision: Object.freeze({ provider: 'webawesome-proxy' }),
        makeController: createController,
        attachControlApi() {},
        waSize() {},
        waFocus: current => current,
        rememberController: (element, current) => remembered.set(element, current),
        forgetController: element => remembered.delete(element),
    });
    await Promise.resolve();
    source.append(new dom.window.Option('B', 'b'));
    // Let MutationObserver enqueue its own follow-up microtask, then destroy
    // before that follow-up is allowed to commit.
    await Promise.resolve();
    controller.destroy();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(document.querySelector('wa-select'), null);
    assert.equal(source.hidden, false);
    assert.equal(remembered.has(source), false);
});

test('a source setter failure cannot leave proxy synchronization locked', async () => {
    const dom = new JSDOM('<!doctype html><div><select><option value="a">A</option><option value="b">B</option></select></div>');
    const { document } = dom.window;
    const source = document.querySelector('select');
    const wa = document.createElement('wa-select');
    wa.value = 'a';
    const remembered = new WeakMap();
    const controller = mountWebAwesomeSelectProxy({
        element: source,
        wa,
        providerDecision: Object.freeze({ provider: 'webawesome-proxy' }),
        makeController: createController,
        attachControlApi() {},
        waSize() {},
        waFocus: current => current,
        rememberController: (element, current) => remembered.set(element, current),
        forgetController: element => remembered.delete(element),
    });
    await Promise.resolve();

    const nativeValue = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value');
    Object.defineProperty(source, 'value', {
        configurable: true,
        get: () => nativeValue.get.call(source),
        set: () => { throw new Error('controlled source setter failure'); },
    });
    wa.value = 'b';
    const errors = [];
    const onError = event => {
        errors.push(event.error);
        event.preventDefault();
    };
    dom.window.addEventListener('error', onError);
    wa.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    dom.window.removeEventListener('error', onError);
    assert.equal(errors.some(error => error?.message === 'controlled source setter failure'), true);

    delete source.value;
    source.value = 'b';
    controller.refresh();
    assert.equal(wa.value, 'b', 'syncing lock is released after a failed source write');
    controller.destroy();
});
