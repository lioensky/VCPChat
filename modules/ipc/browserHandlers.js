// modules/ipc/browserHandlers.js
// 侧栏「浏览器」标签的主进程部分。页面本身由渲染进程里的 <webview> 承载，这里只负责把它关进笼子：
// - 只允许固定的 persist 分区，并强制去掉 preload / Node 集成，开启沙箱与上下文隔离；
// - 只放行 http / https / file / about / data 地址，其它协议（vcp:// 等自定义协议）一律拦截；
// - 网页里的 window.open / target=_blank 转成「在侧栏新开一个浏览器标签」；
// - 页面权限请求（摄像头、定位、通知等）默认拒绝，下载交给系统默认浏览器处理；
// - 「在默认浏览器中打开」「清除浏览数据」两个命令只接受主窗口页面调用。
'use strict';

const { ipcMain, session, shell } = require('electron');
const { createApplicationSenderGuard } = require('./applicationSender');
let mainWindowRef = null;

const BROWSER_PARTITION = 'persist:vcp-side-browser';
const ALLOWED_GUEST_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'about:', 'data:']);
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);
const CHANNELS = ['browser:open-external', 'browser:clear-data'];

let guestSession = null;

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

const isAllowedSender = createApplicationSenderGuard({ getMainWebContents: () => mainWindowRef?.webContents });

function getGuestSession() {
    if (!guestSession) guestSession = session.fromPartition(BROWSER_PARTITION);
    return guestSession;
}

function configureGuestSession(ses) {
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
        guest.setWindowOpenHandler(({ url }) => {
            if (isAllowedGuestUrl(url) && !host.isDestroyed()) host.send('browser:open-tab', { url });
            return { action: 'deny' };
        });
        const blockForeignProtocol = (event, url) => {
            if (!isAllowedGuestUrl(url)) event.preventDefault();
        };
        guest.on('will-navigate', blockForeignProtocol);
        guest.on('will-redirect', blockForeignProtocol);
    });
}

function initialize({ mainWindow = null } = {}) {
    mainWindowRef = mainWindow;
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
    attachToWindow,
    initialize,
    dispose,
    isAllowedGuestUrl,
};
