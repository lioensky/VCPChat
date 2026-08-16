const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { OverlayCoordinator } = require('../modules/ui-system/next-shell/overlay-coordinator.js');

function createFixture(overrides = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="settings" class="modal active"></div></body>');
    const stateEvents = [];
    const calls = { hide: 0, reconcile: 0 };
    dom.window.document.addEventListener('next-ui-overlay-changed', event => stateEvents.push(event.detail.active));
    const coordinator = new OverlayCoordinator({
        document: dom.window.document,
        hideEmbeddedView: async () => { calls.hide += 1; },
        reconcileEmbeddedView: () => { calls.reconcile += 1; },
        ...overrides,
    });
    return { dom, coordinator, calls, stateEvents };
}

test('visible modals acquire one lease and close events release it', async () => {
    const { dom, coordinator, calls, stateEvents } = createFixture();
    coordinator.mount();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(coordinator.active, true);
    assert.equal(calls.hide, 1);
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
        detail: { modalId: 'settings', active: true },
    }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.hide, 1, 'duplicate visibility events must not duplicate a modal lease');
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
        detail: { modalId: 'settings', active: false },
    }));
    assert.equal(coordinator.active, false);
    assert.deepEqual(stateEvents, [true, false]);
    assert.equal(calls.reconcile, 1);
    coordinator.dispose();
});

test('a released lease reconciles after a delayed hide settles', async () => {
    let settleHide;
    const { coordinator, calls, stateEvents } = createFixture({
        hideEmbeddedView: () => new Promise(resolve => { settleHide = resolve; }),
    });
    coordinator.document.querySelector('.modal').classList.remove('active');
    coordinator.mount();
    const owner = Symbol('delayed');
    const pending = coordinator.acquire(owner);
    coordinator.release(owner);
    assert.equal(calls.reconcile, 1);
    settleHide();
    await pending;
    assert.equal(calls.reconcile, 2, 'late hide completion must reconcile the selected native view again');
    assert.deepEqual(stateEvents, [true, false]);
    coordinator.dispose();
});

test('dispose clears leases, retracts fallback listeners and is idempotent', async () => {
    const { dom, coordinator, calls, stateEvents } = createFixture();
    coordinator.document.querySelector('.modal').classList.remove('active');
    coordinator.mount();
    await coordinator.acquire(Symbol('owned'));
    coordinator.dispose();
    coordinator.dispose();
    assert.equal(coordinator.active, false);
    assert.deepEqual(stateEvents, [true, false]);
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
        detail: { modalId: 'late', active: true },
    }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.hide, 1, 'disposed coordinator must not respond to later modal events');
});
