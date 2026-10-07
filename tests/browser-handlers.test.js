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
guestSession.webRequest = { onBeforeRequest: (fn) => { guestSession.beforeRequest = fn; } };

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
    for (const ok of ['http://localhost:3000/', 'https://example.com', 'about:blank']) {
        assert.equal(browserHandlers.isAllowedGuestUrl(ok), true, ok);
    }
    for (const bad of ['file:///tmp/a.html', 'file:///C:/Users/me/.ssh/id_rsa', 'data:text/html,hi', 'javascript:alert(1)', 'vcp://x', 'chrome://gpu', 'ftp://host/a', '', null, 'not a url']) {
        assert.equal(browserHandlers.isAllowedGuestUrl(bad), false, String(bad));
    }
});

test('popups only open web pages', () => {
    const allowed = browserHandlers.isAllowedPopupUrl;
    assert.equal(allowed('https://a.example/', 'https://b.example/'), true);
    assert.equal(allowed('http://localhost:3000/'), true);
    assert.equal(allowed('file:///tmp/b.html', 'file:///tmp/a.html'), false);
    assert.equal(allowed('file:///C:/Windows/win.ini', 'https://evil.example/'), false);
    assert.equal(allowed('about:blank', 'https://a.example/'), false);
    assert.equal(allowed('data:text/html,<h1>login</h1>', 'https://a.example/'), false);
    assert.equal(allowed('javascript:alert(1)', 'https://a.example/'), false);
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

    const prefs = { preload: 'x.js', preloadURL: 'file:///x.js', nodeIntegration: true, sandbox: false, experimentalFeatures: true, disablePopups: false };
    const params = { partition: browserHandlers.BROWSER_PARTITION, src: 'https://a.example', disablewebsecurity: '', plugins: '', blinkfeatures: 'X' };
    host.emit('will-attach-webview', event, prefs, params);
    assert.equal(prevented, 2);
    assert.equal('experimentalFeatures' in prefs, false, 'unknown preferences from the page are dropped');
    assert.equal(prefs.disablePopups, false, 'allowpopups still reaches the window-open handler');
    assert.equal(prefs.webviewTag, false);
    assert.equal(prefs.plugins, false);
    assert.deepEqual(Object.keys(params).sort(), ['partition', 'src']);
    assert.equal('preload' in prefs, false);
    assert.equal('preloadURL' in prefs, false);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.disableDialogs, true, 'pages cannot raise native dialogs titled as the app');
    assert.equal(prefs.contextIsolation, true);

    const guest = new EventEmitter();
    guest.setWindowOpenHandler = (fn) => { guest.openHandler = fn; };
    guest.getURL = () => 'https://a.example/';
    host.emit('did-attach-webview', {}, guest);
    const nested = { prevented: false, preventDefault() { this.prevented = true; } };
    guest.emit('will-attach-webview', nested);
    assert.equal(nested.prevented, true, 'a page cannot nest its own webview');
    // 没有用户输入的弹窗不开标签，鼠标移动也不算
    assert.deepEqual(guest.openHandler({ url: 'https://a.example/x' }), { action: 'deny' });
    guest.emit('input-event', {}, { type: 'mouseMove' });
    assert.deepEqual(guest.openHandler({ url: 'https://a.example/x' }), { action: 'deny' });
    assert.deepEqual(host.sent, []);
    // 一次点击只换一个标签，网页紧接着连开的第二个被吞掉
    guest.emit('input-event', {}, { type: 'mouseDown' });
    assert.deepEqual(guest.openHandler({ url: 'https://a.example/x' }), { action: 'deny' });
    assert.deepEqual(guest.openHandler({ url: 'https://a.example/y' }), { action: 'deny' });
    assert.deepEqual(host.sent, [['browser:open-tab', { url: 'https://a.example/x' }]]);
    // 不允许的地址不消耗这次输入
    guest.emit('input-event', {}, { type: 'keyDown' });
    assert.deepEqual(guest.openHandler({ url: 'vcp://x' }), { action: 'deny' });
    assert.deepEqual(guest.openHandler({ url: 'data:text/html,hi' }), { action: 'deny' });
    assert.deepEqual(guest.openHandler({ url: 'https://a.example/z' }), { action: 'deny' });
    assert.deepEqual(host.sent, [
        ['browser:open-tab', { url: 'https://a.example/x' }],
        ['browser:open-tab', { url: 'https://a.example/z' }]
    ]);
    host.sent.length = 0;

    let blocked = 0;
    guest.emit('will-navigate', { preventDefault: () => { blocked += 1; } }, 'vcp://x');
    guest.emit('will-redirect', { preventDefault: () => { blocked += 1; } }, 'https://ok.example');
    guest.emit('will-navigate', { preventDefault: () => { blocked += 1; } }, 'data:text/html,<h1>login</h1>');
    assert.equal(blocked, 2);

    // 焦点在网页里时，副屏快捷键被截下转给主窗口，其他按键照常交给网页
    host.sent.length = 0;
    let swallowed = 0;
    const keyEvent = { preventDefault: () => { swallowed += 1; } };
    const ctrl = process.platform === 'darwin' ? { meta: true } : { control: true };
    guest.emit('before-input-event', keyEvent, { type: 'keyDown', ...ctrl, alt: true, code: 'KeyB', key: 'b' });
    guest.emit('before-input-event', keyEvent, { type: 'keyDown', control: true, key: 'PageDown', code: 'PageDown' });
    guest.emit('before-input-event', keyEvent, { type: 'keyDown', control: true, key: 'c', code: 'KeyC' });
    guest.emit('before-input-event', keyEvent, { type: 'keyUp', ...ctrl, alt: true, code: 'KeyB', key: 'b' });
    assert.equal(swallowed, 2);
    assert.deepEqual(host.sent, [
        ['browser:side-pane-shortcut', { action: 'toggle' }],
        ['browser:side-pane-shortcut', { action: 'cycle', delta: 1 }]
    ]);
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

test('a reopened main window is trusted and the closed one is not', async () => {
    const createSender = require('./helpers/trusted-main-sender.cjs').createTrustedMainSender;
    const first = createSender();
    const second = createSender();
    let current = { webContents: first.sender, isDestroyed: () => false };
    browserHandlers.initialize({ getMainWindow: () => current });
    const openExternal = handlers.get('browser:open-external');
    assert.equal((await openExternal(first.event, 'https://a.example')).success, true);

    // macOS：主窗口关掉后点 Dock 图标重建
    current = { webContents: second.sender, isDestroyed: () => false };
    assert.equal((await openExternal(second.event, 'https://a.example')).success, true);
    assert.deepEqual(await openExternal(first.event, 'https://a.example'), { success: false, error: 'Unauthorized sender' });
    browserHandlers.dispose();
});

test('re-initializing does not stack another download listener on the guest session', () => {
    browserHandlers.initialize();
    browserHandlers.initialize();
    assert.equal(guestSession.listenerCount('will-download'), 1);
    browserHandlers.dispose();
});

test('side pane shortcut matcher ignores AltGr, repeats and extra modifiers', () => {
    const match = browserHandlers.matchSidePaneShortcut;
    const toggle = { type: 'keyDown', control: true, alt: true, code: 'KeyB', key: 'b' };
    assert.deepEqual(match(toggle, { mac: false }), { action: 'toggle' });
    assert.equal(match({ ...toggle, control: false, meta: true }, { mac: false }), null);
    assert.deepEqual(match({ ...toggle, control: false, meta: true }, { mac: true }), { action: 'toggle' });
    assert.equal(match({ ...toggle, modifiers: ['control', 'alt', 'altgraph'] }, { mac: false }), null);
    assert.equal(match({ ...toggle, isAutoRepeat: true }, { mac: false }), null);
    assert.equal(match({ ...toggle, shift: true }, { mac: false }), null);
    assert.deepEqual(match({ type: 'keyDown', control: true, key: 'PageUp' }, { mac: false }), { action: 'cycle', delta: -1 });
    assert.equal(match({ type: 'keyDown', control: true, shift: true, key: 'PageUp' }, { mac: false }), null);
});

test('guest requests for local files are canceled, web and inline resources pass', () => {
    browserHandlers.initialize();
    const decide = (url) => {
        let result = null;
        guestSession.beforeRequest({ url }, (value) => { result = value; });
        return result.cancel;
    };
    for (const url of ['file:///etc/passwd', 'file:///C:/Users/me/AppData/Roaming/VCPChat/settings.json', 'vcp://x', 'chrome://gpu']) {
        assert.equal(decide(url), true, url);
    }
    for (const url of ['https://a.example/app.js', 'http://localhost:3000/', 'wss://a.example/ws', 'data:image/png;base64,AA==', 'blob:https://a.example/1', 'about:blank']) {
        assert.equal(decide(url), false, url);
    }
});

test('downloads only reach the system browser right after a real input on that page', () => {
    browserHandlers.initialize();
    const host = new EventEmitter();
    host.isDestroyed = () => false;
    host.send = () => {};
    browserHandlers.attachToWindow({ webContents: host });
    const guest = new EventEmitter();
    guest.setWindowOpenHandler = () => {};
    host.emit('did-attach-webview', {}, guest);
    const download = (url) => {
        let prevented = false;
        guestSession.emit('will-download', { preventDefault: () => { prevented = true; } }, { getURL: () => url }, guest);
        assert.equal(prevented, true);
    };
    opened.length = 0;
    download('https://evil.example/a.exe');
    assert.deepEqual(opened, [], 'a download the page started by itself is dropped');
    guest.emit('input-event', {}, { type: 'mouseDown' });
    download('https://ok.example/file.zip');
    download('https://evil.example/b.exe');
    assert.deepEqual(opened, ['https://ok.example/file.zip'], 'one click hands over one download');
});
