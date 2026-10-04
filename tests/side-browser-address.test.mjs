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
