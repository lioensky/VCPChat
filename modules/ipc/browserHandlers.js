// modules/ipc/browserHandlers.js
// 侧栏「浏览器」标签的主进程部分。页面本身由渲染进程里的 <webview> 承载，这里只负责把它关进笼子：
// - 只允许固定的 persist 分区，并强制去掉 preload / Node 集成，开启沙箱与上下文隔离；
// - 只放行 http / https / file / about 地址，其它协议（data: 钓鱼页、vcp:// 等自定义协议）一律拦截；
// - 网页里的 window.open / target=_blank 转成「在侧栏新开一个浏览器标签」，但必须紧跟一次真实点击或按键，
//   一次输入只换一个标签，网页自己连开弹窗刷不出标签；
// - 弹窗只能开 http / https，本地 file 页面还可以开 file 页面；
// - 页面权限请求（摄像头、定位、通知等）默认拒绝，下载交给系统默认浏览器处理；
// - 「在默认浏览器中打开」「清除浏览数据」两个命令只接受主窗口页面调用；
// - 焦点在网页里时按键到不了主窗口，副屏快捷键在这里截下转给主窗口。
'use strict';

const { ipcMain: defaultIpcMain, session, shell } = require('electron');
const { createApplicationSenderGuard, resolveWindowWebContents } = require('./applicationSender');
let getMainWindow = () => null;
// initialize 可以传入领域激活器给的 ipcMain（见 domainActivator.js），不传就用 Electron 的
let ipcMain = defaultIpcMain;

const BROWSER_PARTITION = 'persist:vcp-side-browser';
const ALLOWED_GUEST_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'about:']);
const POPUP_PROTOCOLS = new Set(['http:', 'https:']);
// 点击或按键之后这么久内允许开一个弹窗，和 Chromium 的瞬时用户激活差不多
const POPUP_ACTIVATION_MS = 3000;
const ACTIVATION_INPUTS = new Set(['mouseDown', 'keyDown', 'rawKeyDown', 'touchStart', 'gestureTap']);
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);
const CHANNELS = ['browser:open-external', 'browser:clear-data'];

let guestSession = null;
const configuredSessions = new WeakSet();

function parseUrl(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
        return new URL(raw);
    } catch (_error) {
        return null;
    }
}

function isAllowedGuestUrl(raw) {
    const url = parseUrl(raw);
    return Boolean(url && ALLOWED_GUEST_PROTOCOLS.has(url.protocol));
}

function isExternalUrl(raw) {
    const url = parseUrl(raw);
    return Boolean(url && EXTERNAL_PROTOCOLS.has(url.protocol));
}

// 弹窗地址：只认 http / https；本地 file 页面里的链接可以开另一个 file 页面
function isAllowedPopupUrl(raw, openerUrl = '') {
    const url = parseUrl(raw);
    if (!url) return false;
    if (POPUP_PROTOCOLS.has(url.protocol)) return true;
    return url.protocol === 'file:' && parseUrl(openerUrl)?.protocol === 'file:';
}

/**
 * 和渲染进程 side-pane-shortcuts.js 同一套按键：Ctrl/Cmd+Alt+B 展开或收起副屏，Ctrl+PageUp / PageDown 切标签。
 * input 是 before-input-event 的 Electron Input；返回要转发的动作，不是快捷键就返回 null。
 */
function matchSidePaneShortcut(input, { mac = process.platform === 'darwin' } = {}) {
    if (!input || input.type !== 'keyDown' || input.isComposing) return null;
    const primary = mac ? input.meta && !input.control : input.control && !input.meta;
    const altGraph = Array.isArray(input.modifiers) && input.modifiers.some(m => String(m).toLowerCase() === 'altgraph');
    if (primary && input.alt && !input.shift && !altGraph && !input.isAutoRepeat && input.code === 'KeyB') {
        return { action: 'toggle' };
    }
    if (input.control && !input.alt && !input.shift && !input.meta) {
        if (input.key === 'PageDown') return { action: 'cycle', delta: 1 };
        if (input.key === 'PageUp') return { action: 'cycle', delta: -1 };
    }
    return null;
}

const isAllowedSender = createApplicationSenderGuard({ getMainWebContents: () => resolveWindowWebContents(getMainWindow) });

function getGuestSession() {
    if (!guestSession) guestSession = session.fromPartition(BROWSER_PARTITION);
    return guestSession;
}

function configureGuestSession(ses) {
    if (configuredSessions.has(ses)) return;
    configuredSessions.add(ses);
    ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (event, item) => {
        const url = item.getURL();
        event.preventDefault();
        if (isExternalUrl(url)) shell.openExternal(url);
    });
}

/**
 * Locks down every <webview> created by the given main window.
 */
function attachToWindow(mainWindow) {
    const host = mainWindow?.webContents;
    if (!host) return;

    host.on('will-attach-webview', (event, webPreferences, params) => {
        if (params.partition !== BROWSER_PARTITION || (params.src && !isAllowedGuestUrl(params.src))) {
            event.preventDefault();
            return;
        }
        delete webPreferences.preload;
        delete webPreferences.preloadURL;
        Object.assign(webPreferences, {
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
        });
    });

    host.on('did-attach-webview', (_event, guest) => {
        // 最近一次真实输入的时间；开过一个弹窗就作废，下一个弹窗要等下一次输入
        let activatedAt = 0;
        guest.on('input-event', (_event, input) => {
            if (ACTIVATION_INPUTS.has(input?.type)) activatedAt = Date.now();
        });
        guest.setWindowOpenHandler(({ url }) => {
            const activated = activatedAt > 0 && Date.now() - activatedAt <= POPUP_ACTIVATION_MS;
            const openerUrl = typeof guest.getURL === 'function' ? guest.getURL() : '';
            if (activated && isAllowedPopupUrl(url, openerUrl) && !host.isDestroyed()) {
                activatedAt = 0;
                host.send('browser:open-tab', { url });
            }
            return { action: 'deny' };
        });
        const blockForeignProtocol = (event, url) => {
            if (!isAllowedGuestUrl(url)) event.preventDefault();
        };
        guest.on('will-navigate', blockForeignProtocol);
        guest.on('will-redirect', blockForeignProtocol);
        guest.on('before-input-event', (event, input) => {
            const shortcut = matchSidePaneShortcut(input);
            if (!shortcut || host.isDestroyed()) return;
            event.preventDefault();
            host.send('browser:side-pane-shortcut', shortcut);
        });
    });
}

function initialize({ mainWindow = null, getMainWindow: getWindow = null, ipcMain: injectedIpcMain = null } = {}) {
    ipcMain = injectedIpcMain || defaultIpcMain;
    getMainWindow = typeof getWindow === 'function' ? getWindow : () => mainWindow;
    dispose();
    configureGuestSession(getGuestSession());

    ipcMain.handle('browser:open-external', async (event, url) => {
        if (!isAllowedSender(event)) return { success: false, error: 'Unauthorized sender' };
        if (!isExternalUrl(url)) return { success: false, error: '仅支持在默认浏览器中打开 http / https 地址' };
        try {
            await shell.openExternal(url);
            return { success: true };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    });

    ipcMain.handle('browser:clear-data', async (event) => {
        if (!isAllowedSender(event)) return { success: false, error: 'Unauthorized sender' };
        try {
            const ses = getGuestSession();
            await ses.clearStorageData();
            await ses.clearCache();
            return { success: true };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    });
}

function dispose() {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
}

module.exports = {
    BROWSER_PARTITION,
    CHANNELS,
    attachToWindow,
    initialize,
    dispose,
    isAllowedGuestUrl,
    isAllowedPopupUrl,
    matchSidePaneShortcut,
};
