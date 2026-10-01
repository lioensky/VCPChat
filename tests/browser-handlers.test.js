'use strict';

// 侧栏浏览器主进程部分：锁定 <webview> 的分区与权限、popup 转发、来源校验与外部打开命令。
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const handlers = new Map();
const opened = [];
const guestSession = new EventEmitter();
guestSession.cleared = 0;
guestSession.setPermissionRequestHandler = (fn) => { guestSession.requestHandler = fn; };
guestSession.setPermissionCheckHandler = (fn) => { guestSession.checkHandler = fn; };
guestSession.clearStorageData = async () => { guestSession.cleared += 1; };
guestSession.clearCache = async () => { guestSession.cleared += 1; };

const originalLoad = Module._load;
Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === 'electron') {
        return {
            ipcMain: {
                handle: (channel, fn) => handlers.set(channel, fn),
                removeHandler: (channel) => handlers.delete(channel),
                on: () => {},
            },
            session: { fromPartition: () => guestSession },
            shell: { openExternal: async (url) => { opened.push(url); } },
            BrowserWindow: class {},
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const browserHandlers = require('../modules/ipc/browserHandlers');
Module._load = originalLoad;

const mainPage = require('./helpers/trusted-main-sender.cjs').createTrustedMainSender().event;
const foreignPage = { senderFrame: { url: 'https://evil.example/' } };

test('guest URL allowlist keeps custom protocols out', () => {
    for (const ok of ['http://localhost:3000/', 'https://example.com', 'file:///tmp/a.html', 'about:blank', 'data:text/html,hi']) {
        assert.equal(browserHandlers.isAllowedGuestUrl(ok), true, ok);
    }
    for (const bad of ['javascript:alert(1)', 'vcp://x', 'chrome://gpu', 'ftp://host/a', '', null, 'not a url']) {
        assert.equal(browserHandlers.isAllowedGuestUrl(bad), false, String(bad));
    }
});

test('attachToWindow locks the partition and strips privileged web preferences', () => {
    const host = new EventEmitter();
    host.isDestroyed = () => false;
    host.sent = [];
    host.send = (channel, payload) => host.sent.push([channel, payload]);
    browserHandlers.attachToWindow({ webContents: host });

    let prevented = 0;
    const event = { preventDefault: () => { prevented += 1; } };
    host.emit('will-attach-webview', event, {}, { partition: 'persist:other', src: 'https://a.example' });
    host.emit('will-attach-webview', event, {}, { partition: browserHandlers.BROWSER_PARTITION, src: 'vcp://x' });
    assert.equal(prevented, 2);

    const prefs = { preload: 'x.js', preloadURL: 'file:///x.js', nodeIntegration: true, sandbox: false };
    host.emit('will-attach-webview', event, prefs, { partition: browserHandlers.BROWSER_PARTITION, src: 'https://a.example' });
    assert.equal(prevented, 2);
    assert.equal('preload' in prefs, false);
    assert.equal('preloadURL' in prefs, false);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.contextIsolation, true);

    const guest = new EventEmitter();
    guest.setWindowOpenHandler = (fn) => { guest.openHandler = fn; };
    host.emit('did-attach-webview', {}, guest);
    assert.deepEqual(guest.openHandler({ url: 'https://a.example/x' }), { action: 'deny' });
    assert.deepEqual(guest.openHandler({ url: 'vcp://x' }), { action: 'deny' });
    assert.deepEqual(host.sent, [['browser:open-tab', { url: 'https://a.example/x' }]]);

    let blocked = 0;
    guest.emit('will-navigate', { preventDefault: () => { blocked += 1; } }, 'vcp://x');
    guest.emit('will-redirect', { preventDefault: () => { blocked += 1; } }, 'https://ok.example');
    assert.equal(blocked, 1);
});

test('initialize denies guest permissions and only serves the main window', async () => {
    browserHandlers.initialize();
    let granted = null;
    guestSession.requestHandler({}, 'media', (value) => { granted = value; });
    assert.equal(granted, false);
    assert.equal(guestSession.checkHandler(), false);

    const openExternal = handlers.get('browser:open-external');
    assert.deepEqual(await openExternal(foreignPage, 'https://a.example'), { success: false, error: 'Unauthorized sender' });
    assert.equal((await openExternal(mainPage, 'javascript:alert(1)')).success, false);
    assert.equal((await openExternal(mainPage, 'file:///etc/passwd')).success, false);
    assert.deepEqual(await openExternal(mainPage, 'https://a.example/p'), { success: true });
    assert.deepEqual(opened, ['https://a.example/p']);

    const clear = handlers.get('browser:clear-data');
    assert.equal((await clear(foreignPage)).success, false);
    assert.equal(guestSession.cleared, 0);
    assert.deepEqual(await clear(mainPage), { success: true });
    assert.equal(guestSession.cleared, 2);

    browserHandlers.dispose();
    assert.equal(handlers.size, 0);
});
