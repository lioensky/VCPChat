import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const dom = new JSDOM(`<!doctype html><html data-ui-mode="classic"><body>
  <header class="next-ui-topbar vcp-ui-scope"></header>
  <button id="nextUiHomeTab"></button><button id="nextUiAddTabBtn"></button>
  <div id="nextUiDynamicTabs"></div><div id="nextUiAppGrid"></div>
  <section id="nextUiLaunchpad"></section><main class="container"></main>
</body></html>`, { url: 'http://vcpchat.local/main.html', runScripts: 'outside-only' });

const { window } = dom;
window.ResizeObserver = class {
    observe() {}
    disconnect() {}
};
window.VCPUI = { feedback: { cancelAll() {}, toast() {} } };
let creates = 0;
let activates = 0;
let closes = 0;
const lifecycleEvents = [];
let resolveDeferredClose = null;
window.chatAPI = {
    desktopCreateEmbeddedVchatApp: async () => { creates += 1; lifecycleEvents.push('create'); return { success: true }; },
    desktopActivateEmbeddedVchatApp: async action => {
        activates += 1;
        lifecycleEvents.push(`activate:${action ?? 'none'}`);
        return { success: true };
    },
    desktopSetEmbeddedVchatAppBounds: async () => ({ success: true }),
    desktopCloseEmbeddedVchatApp: async () => { closes += 1; return { success: true }; },
    desktopCloseAllEmbeddedVchatApps: async () => {
        closes += 1;
        lifecycleEvents.push('close-all:start');
        await new Promise(resolve => { resolveDeferredClose = resolve; });
        lifecycleEvents.push('close-all:done');
        return { success: true };
    },
    onEmbeddedVchatAppState: () => () => {},
};
window.trayManager = {
    getApps: () => [{ id: 'translator', action: 'open-translator-window', name: '翻译', icon: 'translator', embed: true }],
    getIcon: () => '<svg></svg>',
};
window.sessionStorage.setItem('vcpchat.nextUi.openTabs.v1', JSON.stringify({
    activeViewId: 'app:translator',
    tabs: [{ kind: 'embedded', id: 'translator' }],
}));

window.eval(fs.readFileSync(path.join(root, 'modules/topTabManager.js'), 'utf8'));
window.topTabManager.init();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(window.topTabManager.isMounted(), false, 'Classic must not mount the Next tab host');
assert.equal(creates, 0, 'Classic must not restore an embedded session');
assert.equal(activates, 0, 'Classic must not activate a native WebContentsView');

window.document.documentElement.dataset.uiMode = 'next';
window.dispatchEvent(new window.CustomEvent('ui-mode-changed', { detail: { mode: 'next', previousMode: 'classic' } }));
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(window.topTabManager.isMounted(), true, 'Next must mount the tab host');
assert.equal(creates, 1, 'Next may restore the saved embedded session once');

window.document.documentElement.dataset.uiMode = 'classic';
window.dispatchEvent(new window.CustomEvent('ui-mode-changed', { detail: { mode: 'classic', previousMode: 'next' } }));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(window.topTabManager.isMounted(), false, 'Leaving Next must unmount the tab host');
assert.ok(closes >= 1, 'Leaving Next must close native embedded sessions');
assert.ok(
    lifecycleEvents.indexOf('activate:none') < lifecycleEvents.indexOf('close-all:start'),
    'Leaving Next must hide the native view before closing its session',
);

window.document.documentElement.dataset.uiMode = 'next';
window.dispatchEvent(new window.CustomEvent('ui-mode-changed', { detail: { mode: 'next', previousMode: 'classic' } }));
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(creates, 1, 'Returning to Next must wait for the previous native teardown');
resolveDeferredClose?.();
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(creates, 2, 'Returning to Next must restore the preserved tab session once');

console.log('Next UI tab lifecycle checks passed.');
