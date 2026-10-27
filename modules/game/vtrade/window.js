'use strict';

// The VTrade 对决 window: the page is served by the VTrade plugin on VCPToolBox. The window has its own session;
// the administrator Authorization header is added only to that session's requests for the VTrade pages, so other
// windows and other sites never receive it. Navigation stays inside VTrade.
const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:vcp-vtrade';
let current = null;

function within(url, origin) {
    try {
        const target = new URL(url);
        return target.origin === origin && target.pathname.startsWith('/admin_api/vtrade/');
    } catch { return false; }
}

async function open(client) {
    const { url, origin, authorization } = await client.pageUrl();
    if (current && !current.isDestroyed()) {
        if (current.isMinimized()) current.restore();
        current.show();
        current.focus();
        return current;
    }
    const scoped = session.fromPartition(PARTITION);
    scoped.webRequest.onBeforeSendHeaders({ urls: [`${origin}/admin_api/vtrade/*`] }, (details, callback) => {
        callback({ requestHeaders: { ...details.requestHeaders, Authorization: authorization } });
    });
    const win = new BrowserWindow({
        width: 1440, height: 900, minWidth: 720, minHeight: 520,
        title: 'VTrade 对决', backgroundColor: '#0b0d10', show: false,
        webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    current = win;
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, target) => { if (!within(target, origin)) event.preventDefault(); });
    win.on('closed', () => { if (current === win) current = null; });
    try {
        await win.loadURL(url);
        if (win.isDestroyed()) throw new Error('游戏窗口已关闭。');
        win.show();
        win.focus();
        return win;
    } catch (error) {
        if (!win.isDestroyed()) win.destroy();
        throw new Error(`VTrade 页面加载失败：${error.message}`);
    }
}

const isOpen = () => Boolean(current && !current.isDestroyed());

module.exports = { open, isOpen, within, PARTITION };
