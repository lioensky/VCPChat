'use strict';

// 双曲场图（应用功能模块，见 feature.json 和 docs/app-features.md）的主进程入口。
// - 开窗口：双曲场图与备忘、论坛一样，使用独立窗口。主窗口的应用入口只负责打开它。
// - 取数据：界面不直接碰后端的文件，也拿不到后端密钥。它把要读的路径交过来，这里带上设置里的地址和密钥去问后端插件
//   WarpedFieldAtlas（VCPToolBox 的 Plugin/WarpedFieldAtlas），只放行这几种只读路径。
// 删掉整个 modules/warpedFieldAtlas 目录，或在插件管理器里停用，Chat 照常运行。

const path = require('path');

const CHANNEL = 'warped-field-atlas:get';
const OPEN = 'warped-field-atlas:open';
const ROUTE = /^\/(?:status|messages(?:\?q=[^&#\s]{0,600})?|field\/(?:tag|chunk)(?:\/node\/\d{1,15}|\/query\?(?:node=\d{1,15}|message=[A-Za-z0-9_-]{8,128}(?:&radius=0\.\d{1,4})?))?)$/;

/** allowed(event)：这次请求是不是来自允许的页面（主窗口，或双曲场图自己的窗口）。 */
function createHandler({ allowed, readSettings, fetchImpl = globalThis.fetch }) {
    return async (event, route) => {
        if (!allowed(event)) return { success: false, message: '此页面不能读取双曲场。' };
        if (typeof route !== 'string' || !ROUTE.test(route)) return { success: false, message: '请求不对。' };
        try {
            const settings = await readSettings();
            const base = new URL(settings.vcpServerUrl);
            if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('invalid base');
            const response = await fetchImpl(new URL(`/api/plugins/WarpedFieldAtlas${route}`, base.origin), {
                headers: { Authorization: `Bearer ${settings.vcpApiKey}` },
                signal: AbortSignal.timeout(60000),
                redirect: 'error',
            });
            const body = await response.json().catch(() => null);
            if (!response.ok || body == null) {
                const fallback = response.status === 404 ? '后端的双曲场图插件尚未加载。' : '读取双曲场失败。';
                return { success: false, message: (body && typeof body.message === 'string' && body.message) || fallback };
            }
            return { success: true, data: body };
        } catch {
            return { success: false, message: '无法连接后端。' };
        }
    };
}

const isMainFrameOf = (win, event) => Boolean(win) && !win.isDestroyed()
    && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;

function register(host) {
    const { app, BrowserWindow, ipcMain } = require('electron');
    const { PRELOAD_ROLES, resolveAppPreload } = require('../services/preloadPaths');
    let atlasWindow = null;

    function openWindow() {
        if (atlasWindow && !atlasWindow.isDestroyed()) {
            if (atlasWindow.isMinimized()) atlasWindow.restore();
            atlasWindow.show();
            atlasWindow.focus();
            return;
        }
        const win = new BrowserWindow({
            width: 1440,
            height: 900,
            minWidth: 960,
            minHeight: 600,
            title: '双曲场图',
            frame: false,
            ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
            backgroundColor: '#14110e',
            show: false,
            icon: path.join(host.projectRoot, 'assets', 'icon.png'),
            webPreferences: {
                preload: resolveAppPreload(app.getAppPath(), PRELOAD_ROLES.UTILITY),
                sandbox: false, // preloads/* 需要 require 本地模块，见 preloads/README.md
                contextIsolation: true,
                nodeIntegration: false,
            },
        });
        atlasWindow = win;
        win.setMenu(null);
        win.loadFile(path.join(__dirname, 'renderer', 'window.html'));
        win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
        win.on('closed', () => { if (atlasWindow === win) atlasWindow = null; });
    }

    ipcMain.handle(CHANNEL, createHandler({
        allowed: event => isMainFrameOf(host.mainWindow, event) || isMainFrameOf(atlasWindow, event),
        readSettings: host.readSettings,
    }));
    ipcMain.handle(OPEN, event => {
        if (!isMainFrameOf(host.mainWindow, event)) return { success: false };
        openWindow();
        return { success: true };
    });
    return {
        dispose() {
            ipcMain.removeHandler(CHANNEL);
            ipcMain.removeHandler(OPEN);
            if (atlasWindow && !atlasWindow.isDestroyed()) atlasWindow.close();
        },
    };
}

module.exports = { register, createHandler, isMainFrameOf, CHANNEL, OPEN, ROUTE };
