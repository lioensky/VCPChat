import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

test('uiManager dispose is idempotent and revokes reinitialization', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div class="sidebar"></div><div id="notificationsSidebar"></div></body></html>', {
        url: 'https://vcpchat.local/',
    });
    const previous = { window: globalThis.window, document: globalThis.document };
    Object.assign(globalThis, { window: dom.window, document: dom.window.document });
    const moduleUrl = `${pathToFileURL(path.join(process.cwd(), 'modules/uiManager.js')).href}?lifecycle=${Date.now()}`;
    try {
        const { default: _unused, ...namespace } = await import(moduleUrl).catch(error => {
            throw error;
        });
        void namespace;
        const manager = dom.window.uiManager;
        assert.ok(manager, 'uiManager should expose its public facade');
        const api = {
            setTheme() {},
            onThemeUpdated() { return () => {}; },
            getCurrentTheme: async () => 'light',
            saveSettings: async () => ({ success: true }),
        };
        await manager.init({
            electronAPI: api,
            refs: { globalSettingsRef: { get: () => ({ currentThemeMode: 'light' }), set() {} } },
            listenerOwner: { capture: () => () => {}, timeout: () => null },
            elements: {
                leftSidebar: dom.window.document.querySelector('.sidebar'),
                rightNotificationsSidebar: dom.window.document.getElementById('notificationsSidebar'),
                resizerLeft: null, resizerRight: null,
                digitalClockElement: null, dateDisplayElement: null, notificationTitleElement: null,
                sidebarTabButtons: [], sidebarTabContents: [],
            },
        });
        await manager.dispose();
        await manager.dispose();
        await assert.rejects(() => manager.init({}), /disposed/i);
    } finally {
        if (previous.window === undefined) delete globalThis.window;
        else globalThis.window = previous.window;
        if (previous.document === undefined) delete globalThis.document;
        else globalThis.document = previous.document;
        dom.window.close();
    }
});

test('uiManager unsubscribes theme updates and suppresses a late initial theme result', async () => {
    const dom = new JSDOM('<!doctype html><html><body class="light-theme"><div class="sidebar"></div><div id="notificationsSidebar"></div></body></html>', {
        url: 'https://vcpchat.local/',
    });
    const previous = { window: globalThis.window, document: globalThis.document };
    Object.assign(globalThis, { window: dom.window, document: dom.window.document });
    let resolveTheme;
    const pendingTheme = new Promise(resolve => { resolveTheme = resolve; });
    let themeListener;
    let released = 0;
    try {
        dom.window.eval(fs.readFileSync(path.join(process.cwd(), 'modules/uiManager.js'), 'utf8'));
        const manager = dom.window.uiManager;
        const initializing = manager.init({
            electronAPI: {
                onThemeUpdated(listener) { themeListener = listener; return () => { released += 1; }; },
                getCurrentTheme: () => pendingTheme,
                saveSettings: async () => ({ success: true }),
            },
            refs: { globalSettingsRef: { get: () => ({}), set() {} } },
            listenerOwner: { capture: () => () => {}, timeout: () => null },
            elements: {
                leftSidebar: dom.window.document.querySelector('.sidebar'),
                rightNotificationsSidebar: dom.window.document.getElementById('notificationsSidebar'),
                resizerLeft: null, resizerRight: null,
                digitalClockElement: null, dateDisplayElement: null, notificationTitleElement: null,
                sidebarTabButtons: [], sidebarTabContents: [],
            },
        });
        await new Promise(resolve => setImmediate(resolve));
        let disposed = false;
        const disposal = manager.dispose().then(() => { disposed = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(disposed, false);
        resolveTheme('dark');
        await Promise.all([initializing, disposal]);
        themeListener?.('dark');
        assert.equal(released, 1);
        assert.equal(dom.window.document.body.classList.contains('dark-theme'), false);
    } finally {
        if (previous.window === undefined) delete globalThis.window;
        else globalThis.window = previous.window;
        if (previous.document === undefined) delete globalThis.document;
        else globalThis.document = previous.document;
        dom.window.close();
    }
});
