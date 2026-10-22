import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import searchManager from '../modules/searchManager.js';
import overlayApi from '../modules/ui-system/next-shell/overlay-coordinator.js';

const { OverlayCoordinator } = overlayApi;

const searchTemplate = JSDOM.fragment(readFileSync(new URL('../main.html', import.meta.url), 'utf8'))
    .querySelector('#globalSearchModalTemplate').outerHTML;
const helperSource = readFileSync(new URL('../modules/ui-helpers.js', import.meta.url), 'utf8');

function setup(t) {
    const dom = new JSDOM(`<!doctype html><body><div id="modal-container"></div>${searchTemplate}</body>`, {
        runScripts: 'outside-only',
    });
    const previousGlobals = new Map(['window', 'document'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    dom.window.eval(helperSource);

    const events = [];
    const overlayEvents = [];
    let readyCount = 0;
    document.addEventListener('modal-ready', () => { readyCount += 1; });
    document.addEventListener('modal-visibility-changed', event => events.push(event.detail));
    document.addEventListener('next-ui-overlay-changed', event => overlayEvents.push(event.detail.active));
    const nativeView = { visible: true, hideCalls: 0, reconcileCalls: 0 };
    const coordinator = new OverlayCoordinator({
        document,
        hideEmbeddedView: async () => {
            nativeView.hideCalls += 1;
            nativeView.visible = false;
        },
        reconcileEmbeddedView: () => {
            nativeView.reconcileCalls += 1;
            nativeView.visible = !coordinator.active;
        },
    });
    coordinator.mount();

    const manager = { ...searchManager, elements: {}, state: structuredClone(searchManager.state) };
    manager.init({
        electronAPI: { getAgents: async () => [], getAgentGroups: async () => [] },
        chatRepository: {},
        uiHelper: dom.window.uiHelperFunctions,
        modules: { chatManager: {} },
        refs: { currentSelectedItemRef: { get: () => null }, currentTopicIdRef: { get: () => null } },
    });
    t.after(() => {
        coordinator.dispose();
        dom.window.close();
        for (const [name, descriptor] of previousGlobals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    });

    function keydown(key, options = {}) {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
        dom.window.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
    }
    return { manager, coordinator, nativeView, events, overlayEvents, keydown, readyCount: () => readyCount };
}

test('search opens the lazy template and reuses its cached modal with a balanced overlay lease each time', async t => {
    const { manager, coordinator, nativeView, events, overlayEvents, readyCount } = setup(t);
    let cachedModal;
    for (let cycle = 1; cycle <= 3; cycle += 1) {
        await manager.openModal();
        cachedModal ||= manager.elements.modal;
        assert.equal(manager.elements.modal, cachedModal);
        assert.equal(readyCount(), 1, 'cached opens must not require another modal-ready event');
        assert.equal(events.length, cycle * 2 - 1, 'every open, including a cached open, broadcasts visibility');
        assert.equal(events.at(-1).modalId, 'globalSearchModal');
        assert.equal(events.at(-1).active, true);
        assert.equal(events.at(-1).root.classList.contains('active'), true);
        assert.equal(manager.elements.modal.style.display, 'flex');
        assert.equal(coordinator.active, true);
        assert.equal(nativeView.visible, false);
        assert.equal(nativeView.hideCalls, cycle);

        manager.closeModal();
        assert.equal(events.length, cycle * 2);
        assert.equal(events.at(-1).active, false);
        // Check reconciliation before querying active: pruning on read must not
        // disguise a missing close event or a rejected close generation.
        assert.equal(nativeView.reconcileCalls, cycle);
        assert.equal(nativeView.visible, true);
        assert.equal(events.at(-1).root.classList.contains('active'), false);
        assert.equal(manager.elements.modal.style.display, 'none');
        assert.equal(coordinator.active, false);
    }
    assert.deepEqual(overlayEvents, [true, false, true, false, true, false]);
});

test('repeated Cmd+F while search is open keeps one lease and Escape releases the latest generation', async t => {
    const { manager, coordinator, nativeView, events, overlayEvents, keydown } = setup(t);
    for (let press = 0; press < 3; press += 1) {
        keydown('f', { metaKey: true, repeat: press > 0 });
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(events.length, 3);
    assert.deepEqual(events.map(event => event.generation), [1, 2, 3]);
    assert.equal(coordinator.snapshot().owners.length, 1);
    assert.equal(nativeView.hideCalls, 1, 'repeated Cmd+F must retain the existing native hide lease');
    assert.equal(nativeView.visible, false);
    manager.elements.input.value = 'old search';
    manager.state.currentQuery = 'old search';

    keydown('Escape');
    assert.equal(events.at(-1).active, false);
    assert.equal(events.at(-1).generation, 3);
    assert.equal(nativeView.reconcileCalls, 1, 'Escape must release the current generation without a later active read');
    assert.equal(nativeView.visible, true);
    assert.equal(coordinator.active, false);
    assert.equal(manager.elements.input.value, '');
    assert.equal(manager.state.currentQuery, '');
    assert.deepEqual(overlayEvents, [true, false]);
});

test('the real search close button releases the lease after reopening the cached modal', async t => {
    const { manager, nativeView, events, keydown } = setup(t);
    keydown('f', { ctrlKey: true });
    await new Promise(resolve => setImmediate(resolve));
    manager.elements.closeButton.click();
    assert.equal(events.at(-1).active, false);
    assert.equal(nativeView.reconcileCalls, 1);
    assert.equal(nativeView.visible, true);

    keydown('f', { metaKey: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nativeView.visible, false);
    manager.elements.closeButton.click();
    assert.equal(events.at(-1).active, false);
    assert.equal(nativeView.reconcileCalls, 2);
    assert.equal(nativeView.visible, true);
});
