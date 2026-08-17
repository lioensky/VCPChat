import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const dom = new JSDOM(`<!doctype html><html data-ui-mode="next"><body>
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
let embeddedStateListener = null;
let deferNextOverlayHide = false;
let resolveDeferredOverlayHide = null;
const authoritativeSessions = new Set();
window.chatAPI = {
    desktopCreateEmbeddedVchatApp: async action => {
        creates += 1;
        lifecycleEvents.push('create');
        authoritativeSessions.add(action);
        return { success: true };
    },
    desktopListEmbeddedVchatApps: async () => ({
        sessions: [...authoritativeSessions].map(action => ({ action })),
        activeAction: null,
    }),
    desktopActivateEmbeddedVchatApp: async action => {
        activates += 1;
        lifecycleEvents.push(`activate:${action ?? 'none'}`);
        if (action == null && deferNextOverlayHide) {
            deferNextOverlayHide = false;
            await new Promise(resolve => { resolveDeferredOverlayHide = resolve; });
        }
        return { success: true };
    },
    desktopSetEmbeddedVchatAppBounds: async () => ({ success: true }),
    desktopCloseEmbeddedVchatApp: async action => {
        closes += 1;
        authoritativeSessions.delete(action);
        return { success: true };
    },
    desktopCloseAllEmbeddedVchatApps: async () => {
        closes += 1;
        lifecycleEvents.push('close-all:start');
        await new Promise(resolve => { resolveDeferredClose = resolve; });
        authoritativeSessions.clear();
        lifecycleEvents.push('close-all:done');
        return { success: true };
    },
    onEmbeddedVchatAppState: listener => {
        embeddedStateListener = listener;
        return () => { embeddedStateListener = null; };
    },
};
window.trayManager = {
    getApps: () => [{ id: 'translator', action: 'open-translator-window', name: '翻译', icon: 'translator', embed: true }],
    getIcon: () => '<svg></svg>',
};
const failingInternalApp = {
    id: 'failing-cleanup',
    title: 'Failing cleanup fixture',
    icon: 'warning',
    kind: 'internal',
    mount: () => () => { throw new Error('expected fixture cleanup failure'); },
    unmount() {}
};
window.nextUiApps = {
    list: () => [failingInternalApp],
    get: id => id === failingInternalApp.id ? failingInternalApp : null,
};
window.sessionStorage.setItem('vcpchat.nextUi.openTabs.v1', JSON.stringify({
    activeViewId: 'app:translator',
    tabs: [{ kind: 'embedded', id: 'translator' }],
}));

window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/lifecycle-scope.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/next-shell/overlay-coordinator.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/next-shell/embedded-app-controller.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/next-shell/app-tab-host.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/next-shell/assistant-search-controller.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/next-shell/account-menu-controller.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/next-shell/launchpad-controller.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/next-shell/creation-controller.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/next-shell/next-shell-controller.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/topTabManager.js'), 'utf8'));
window.topTabManager.init();
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(window.topTabManager.isMounted(), true, 'the canonical shell must mount the tab host');
assert.equal(window.VCPLifecycle.diagnostics.find('next:tab-host').length, 1, 'the canonical shell must have exactly one tab-host owner');
assert.equal(window.VCPLifecycle.diagnostics.find('next:app-grid').length, 1, 'the canonical shell must own one app-grid render lifetime');
window.dispatchEvent(new window.CustomEvent('next-ui-apps-changed', { detail: { action: 'registered', id: 'fixture' } }));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(window.VCPLifecycle.diagnostics.find('next:app-grid').length, 1, 'app-grid rerenders must retract the previous render owner');
assert.equal(creates, 1, 'the canonical shell may restore the saved embedded session once');
embeddedStateListener?.({ action: 'open-translator-window', state: 'closed' });
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(
    window.document.querySelector('[data-view-id="app:translator"]'),
    'a stale close event must not remove a session that Main still reports as open',
);
const restoredTab = window.document.querySelector('#nextUiDynamicTabs [role="tab"]');
assert.equal(restoredTab?.tagName, 'DIV', 'dynamic tab hosts must not be nested buttons');
assert.equal(restoredTab?.querySelector('.next-ui-tab-close')?.tagName, 'BUTTON', 'tab close must remain a native button');
assert.equal(restoredTab?.getAttribute('aria-selected'), 'true');
assert.equal(restoredTab?.tabIndex, 0);
const activationsBeforeKeyboard = activates;
restoredTab.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(activates > activationsBeforeKeyboard, 'Enter must activate a focused dynamic tab');

const overlayOwner = Symbol('test-overlay');
await window.topTabManager.acquireOverlay(overlayOwner);
assert.equal(lifecycleEvents.at(-1), 'activate:none', 'DOM overlays must hide native WebContentsViews before mounting');
window.topTabManager.setView('app:translator');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(lifecycleEvents.at(-1), 'activate:none', 'view changes must not reactivate native content while an overlay lease is held');
window.topTabManager.releaseOverlay(overlayOwner);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(lifecycleEvents.at(-1), 'activate:open-translator-window', 'releasing the final overlay lease must restore the active embedded view');

deferNextOverlayHide = true;
const delayedOverlayOwner = Symbol('delayed-overlay');
const delayedAcquire = window.topTabManager.acquireOverlay(delayedOverlayOwner);
await new Promise(resolve => setTimeout(resolve, 0));
window.topTabManager.releaseOverlay(delayedOverlayOwner);
resolveDeferredOverlayHide?.();
await delayedAcquire;
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(
    lifecycleEvents.at(-1),
    'activate:open-translator-window',
    'a hide IPC that settles after lease release must reconcile back to the active embedded view'
);

const lifecycleUnmount = window.topTabManager.unmount();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(window.topTabManager.isMounted(), false, 'explicit lifecycle teardown must unmount the tab host');
assert.equal(window.VCPLifecycle.diagnostics.find('next:tab-host').length, 0, 'teardown must dispose the tab-host owner');
assert.equal(window.VCPLifecycle.diagnostics.find('next:app-grid').length, 0, 'teardown must dispose app-grid listeners');
assert.ok(closes >= 1, 'teardown must close native embedded sessions');
assert.ok(
    lifecycleEvents.indexOf('activate:none') < lifecycleEvents.indexOf('close-all:start'),
    'teardown must hide the native view before closing its session',
);

const lifecycleRemount = window.topTabManager.mount();
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(creates, 1, 'remount must wait for the previous native teardown');
resolveDeferredClose?.();
await lifecycleUnmount;
await lifecycleRemount;
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(creates, 2, 'remount must restore the preserved tab session once');
assert.equal(window.VCPLifecycle.diagnostics.find('next:tab-host').length, 1, 'remount must create one fresh owner');

window.topTabManager.openInternalApp(failingInternalApp.id);
const originalConsoleError = window.console.error;
const expectedTeardownErrors = [];
window.console.error = (...args) => expectedTeardownErrors.push(args);
const finalUnmount = window.topTabManager.unmount();
await new Promise(resolve => setTimeout(resolve, 0));
resolveDeferredClose?.();
await assert.doesNotReject(finalUnmount, 'one failing app disposer must not block canonical lifecycle teardown');
window.console.error = originalConsoleError;
assert.ok(expectedTeardownErrors.length >= 1, 'cleanup failures must remain observable after transition recovery');
assert.equal(window.VCPLifecycle.diagnostics.find('next:tab-host').length, 0, 'final teardown must leave no tab-host owner');

console.log('Next UI tab lifecycle checks passed.');
