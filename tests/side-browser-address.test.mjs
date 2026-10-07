import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBrowserInput, resolveBrowserAddress } from '../modules/ui-system/side-pane/browserSideProvider.js';

test('addresses open as before', () => {
    assert.deepEqual(resolveBrowserAddress('example.com'), { url: 'https://example.com/' });
    assert.deepEqual(resolveBrowserAddress('localhost:3000'), { url: 'http://localhost:3000/' });
    assert.deepEqual(resolveBrowserAddress('https://a.test/x?y=1'), { url: 'https://a.test/x?y=1' });
    assert.equal(resolveBrowserAddress('   '), null);
});

test('plain text becomes a web search instead of an error', () => {
    assert.ok(normalizeBrowserInput('vcp 工具').error);
    assert.deepEqual(resolveBrowserAddress('vcp 工具'), { url: 'https://www.bing.com/search?q=vcp%20%E5%B7%A5%E5%85%B7' });
    assert.deepEqual(resolveBrowserAddress('electron'), { url: 'https://www.bing.com/search?q=electron' });
    assert.deepEqual(resolveBrowserAddress('what is: this'), { url: 'https://www.bing.com/search?q=what%20is%3A%20this' });
});

test('unsupported schemes stay errors rather than searches', () => {
    for (const text of ['javascript:alert(1)', 'chrome://settings', 'vbscript:x', 'data:text/html,<h1>login</h1>']) {
        assert.ok(resolveBrowserAddress(text).error, text);
    }
});

test('a typed address is written back to the tab payload so a restored tab reopens it', async () => {
    const { JSDOM } = await import('jsdom');
    const { createBrowserSideProvider } = await import('../modules/ui-system/side-pane/browserSideProvider.js');
    const dom = new JSDOM('<div id="view"></div>');
    const updates = [];
    const provider = createBrowserSideProvider({
        document: dom.window.document,
        api: null,
        sidePaneController: { updateTab: (id, patch) => updates.push({ id, ...patch }) },
        notify: () => {}
    });
    const handle = await provider.mountTab({ id: 'browser:1', kind: 'browser', payload: {} }, dom.window.document.getElementById('view'));
    handle.navigate('https://example.com/');
    assert.deepEqual(updates, [{ id: 'browser:1', payload: { url: 'https://example.com/' } }]);
    handle.dispose();
    dom.window.close();
});

test('web page popups stop opening tabs once there are already many browser tabs', async () => {
    const { JSDOM } = await import('jsdom');
    const { createBrowserSideProvider, MAX_POPUP_BROWSER_TABS } = await import('../modules/ui-system/side-pane/browserSideProvider.js');
    const dom = new JSDOM('<div id="view"></div>');
    const tabs = [];
    const toasts = [];
    let emitOpenTab = null;
    const provider = createBrowserSideProvider({
        document: dom.window.document,
        api: { onBrowserOpenTab: (fn) => { emitOpenTab = fn; return () => { emitOpenTab = null; }; } },
        sidePaneController: {
            getSnapshot: () => ({ tabs }),
            openTab: async (tab) => { tabs.push(tab); return null; },
            setVisible() {},
            updateTab() {}
        },
        notify: (message) => toasts.push(message)
    });
    const handle = await provider.mountTab({ id: 'browser:0', kind: 'browser', payload: {} }, dom.window.document.getElementById('view'));
    tabs.push({ id: 'browser:0', kind: 'browser' });
    assert.equal(typeof emitOpenTab, 'function');

    emitOpenTab({ url: 'data:text/html,<h1>login</h1>' });
    emitOpenTab({ url: 'vcp://x' });
    for (let i = 0; i < MAX_POPUP_BROWSER_TABS + 2; i++) {
        emitOpenTab({ url: `https://a.example/${i}` });
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.equal(tabs.length, MAX_POPUP_BROWSER_TABS);
    assert.ok(tabs.every(tab => !tab.payload || tab.payload.url.startsWith('https://')));
    assert.equal(toasts.length, 3);

    handle.dispose();
    dom.window.close();
});


async function browserFixture() {
    const { JSDOM } = await import('jsdom');
    const { createBrowserSideProvider } = await import('../modules/ui-system/side-pane/browserSideProvider.js');
    const { createSidePaneController } = await import('../modules/ui-system/side-pane/side-pane-controller.js');
    const dom = new JSDOM('<input id="mainInput"><aside><div class="side-pane-tabs"></div><div class="side-pane-content-container"></div></aside>');
    const doc = dom.window.document, root = doc.querySelector('aside');
    const controller = createSidePaneController({ root, tabListElement: root.querySelector('.side-pane-tabs'),
        contentContainer: root.querySelector('.side-pane-content-container') });
    let listener = null, subscriptions = 0, unsubscriptions = 0;
    const provider = createBrowserSideProvider({ document: doc, sidePaneController: controller,
        api: { onBrowserOpenTab(fn) {
            subscriptions++; listener = fn;
            return () => { unsubscriptions++; if (listener === fn) listener = null; };
        } } });
    controller.registerProvider('browser', provider);
    const tab = { id: 'browser:1', kind: 'browser', title: 'Browser', closable: true, scopeMode: 'global', payload: {} };
    return { controller, provider, doc, tab,
        get subscriptionCounts() { return { subscriptions, unsubscriptions, listening: Boolean(listener) }; },
        async cleanup() { await controller.dispose(); dom.window.close(); } };
}

test('a cancelled real browser mount cannot unregister its same-ID replacement', async () => {
    const h = await browserFixture();
    try {
        const first = h.controller.openTab(h.tab);
        const closing = h.controller.closeTab(h.tab.id);
        const replacement = h.controller.openTab(h.tab);
        const [oldHandle, , newHandle] = await Promise.all([first, closing, replacement]);
        assert.equal(oldHandle, null);
        assert.ok(newHandle);
        assert.deepEqual(h.subscriptionCounts, { subscriptions: 1, unsubscriptions: 0, listening: true });
        assert.equal(await h.provider.openBrowserTab(), newHandle, 'reuse the surviving blank page');
        assert.deepEqual(h.controller.getSnapshot().tabs.filter(tab => tab.kind === 'browser').map(tab => tab.id), ['browser:1']);
        await h.controller.closeTab(h.tab.id);
        assert.deepEqual(h.subscriptionCounts, { subscriptions: 1, unsubscriptions: 1, listening: false });
    } finally { await h.cleanup(); }
});

test('repeated disposal of an old browser handle preserves a fresh popup subscription', async () => {
    const h = await browserFixture();
    try {
        const oldHandle = await h.controller.openTab(h.tab);
        await h.controller.closeTab(h.tab.id);
        const newHandle = await h.controller.openTab(h.tab);
        oldHandle.dispose();
        assert.deepEqual(h.subscriptionCounts, { subscriptions: 2, unsubscriptions: 1, listening: true });
        assert.equal(await h.provider.openBrowserTab(), newHandle);
        await h.controller.closeTab(h.tab.id);
        assert.deepEqual(h.subscriptionCounts, { subscriptions: 2, unsubscriptions: 2, listening: false });
    } finally { await h.cleanup(); }
});

test('closing one of two distinct browser pages retains popup handling until the last closes', async () => {
    const h = await browserFixture();
    try {
        await h.controller.openTab(h.tab);
        const second = await h.controller.openTab({ ...h.tab, id: 'browser:2' });
        await h.controller.closeTab(h.tab.id);
        assert.deepEqual(h.subscriptionCounts, { subscriptions: 1, unsubscriptions: 0, listening: true });
        assert.equal(await h.provider.openBrowserTab(), second);
        await h.controller.closeTab('browser:2');
        assert.deepEqual(h.subscriptionCounts, { subscriptions: 1, unsubscriptions: 1, listening: false });
    } finally { await h.cleanup(); }
});

for (const reuse of [false, true]) {
    test('browser launcher completion preserves a later collapse and main-input focus (reuse=' + reuse + ')', async () => {
        const h = await browserFixture();
        try {
            if (reuse) await h.provider.openBrowserTab();
            const opening = h.provider.openBrowserTab();
            h.controller.setVisible(false);
            const input = h.doc.getElementById('mainInput'); input.focus();
            const handle = await opening;
            assert.ok(handle);
            assert.equal(h.controller.getSnapshot().visible, false);
            assert.equal(h.doc.activeElement, input);
        } finally { await h.cleanup(); }
    });
}

for (const readyBeforeFailure of [false, true]) {
    test(`failed-page retry retains its target across guest readiness (ready=${readyBeforeFailure})`, async () => {
        const h = await browserFixture();
        try {
            await h.controller.openTab({ ...h.tab, payload: { url: 'https://previous.test/' } });
            const guest = h.doc.querySelector('webview'), loaded = [];
            guest.getURL = () => 'https://previous.test/';
            guest.canGoBack = guest.canGoForward = () => false;
            guest.loadURL = url => { loaded.push(url); return Promise.resolve(); };
            guest.reload = () => { loaded.push('reload-previous-page'); };
            const emit = (type, detail = {}) => guest.dispatchEvent(Object.assign(new h.doc.defaultView.Event(type), detail));
            if (readyBeforeFailure) emit('dom-ready');
            emit('did-fail-load', { isMainFrame: true, errorCode: -324,
                errorDescription: 'ERR_EMPTY_RESPONSE', validatedURL: 'https://failed.test/target' });
            assert.equal(h.doc.querySelector('.side-browser-notice').hidden, false);
            h.doc.querySelector('.side-browser-notice-retry').click();
            if (!readyBeforeFailure) {
                assert.deepEqual(loaded, [], 'navigation waits until the guest can accept it');
                emit('dom-ready');
            }
            assert.deepEqual(loaded, ['https://failed.test/target']);
            assert.equal(h.doc.querySelector('.side-browser-notice').hidden, true);
        } finally { await h.cleanup(); }
    });
}

test('a page playing media stays busy even when muted, until it pauses or navigates away', async () => {
    const { JSDOM } = await import('jsdom');
    const { createBrowserSideProvider } = await import('../modules/ui-system/side-pane/browserSideProvider.js');
    const dom = new JSDOM('<div id="view"></div>');
    const provider = createBrowserSideProvider({
        document: dom.window.document,
        api: null,
        sidePaneController: { updateTab() {} },
        notify: () => {}
    });
    const view = dom.window.document.getElementById('view');
    const handle = await provider.mountTab({ id: 'browser:1', kind: 'browser', payload: { url: 'https://example.com/' } }, view);
    const guest = view.querySelector('webview');
    assert.ok(guest);
    guest.isCurrentlyAudible = () => false;
    const fire = (name, extra = {}) => guest.dispatchEvent(Object.assign(new dom.window.Event(name), extra));

    assert.equal(handle.isBusy(), false);
    fire('media-started-playing');
    assert.equal(handle.isBusy(), true);
    fire('media-paused');
    assert.equal(handle.isBusy(), false);
    fire('media-started-playing');
    fire('did-navigate', { url: 'https://example.com/next' });
    assert.equal(handle.isBusy(), false);

    handle.dispose();
    dom.window.close();
});
