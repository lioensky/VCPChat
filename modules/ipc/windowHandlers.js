// modules/ipc/windowHandlers.js
const { ipcMain, app, BrowserWindow } = require('electron');
const crypto = require('crypto');
const path = require('path');
const { PRELOAD_ROLES, resolveAppPreload } = require('../services/preloadPaths');

/**
 * Initializes window control IPC handlers.
 * @param {BrowserWindow} mainWindow The main window instance.
 * @param {BrowserWindow[]} openChildWindows - A reference to the array holding all open child windows.
 */
let ipcHandlersRegistered = false;
let forumWindowInstance = null;
let memoWindowInstance = null;
let logWindowInstance = null;
let taskWindowInstance = null;

/**
 * 大体积 payload（如截图 dataURL/Blob）通过 token 在主进程内一次性缓存，
 * 由目标窗口通过 IPC 拉取，避免走 URL 参数（Chromium 对 URL 长度有上限，
 * 长截图会被截断或彻底打不开窗口）。
 */
const imageViewerPayloads = new Map(); // token -> { src, title, theme, createdAt }
const IMAGE_PAYLOAD_TTL_MS = 10 * 60 * 1000; // 10 分钟兜底过期
const generateImagePayloadToken = () => `imgpld_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
const cleanupExpiredImagePayloads = () => {
    const now = Date.now();
    for (const [token, payload] of imageViewerPayloads.entries()) {
        if (now - payload.createdAt > IMAGE_PAYLOAD_TTL_MS) {
            imageViewerPayloads.delete(token);
        }
    }
};

function initialize(mainWindow, openChildWindows) {
    if (ipcHandlersRegistered) {
        return;
    }

    // --- Window Control IPC Handlers ---
    ipcMain.on('minimize-window', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            win.minimize();
        }
    });

    ipcMain.on('maximize-window', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            if (win.isMaximized()) {
                win.unmaximize();
            } else {
                win.maximize();
            }
        }
    });

    ipcMain.on('unmaximize-window', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            win.unmaximize();
        }
    });

    ipcMain.on('close-window', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            // If it's the main window, check if the desktop window is alive.
            // If so, hide the main window to tray instead of quitting.
            if (win === mainWindow) {
                const desktopHandlers = require('./desktopHandlers');
                const desktopWindow = desktopHandlers.getDesktopWindow();
                if (desktopWindow && !desktopWindow.isDestroyed()) {
                    // 桌面窗口存在时，主窗口关闭 → 最小化到托盘
                    console.log('[WindowHandlers] Desktop window is active. Hiding main window to tray instead of quitting.');
                    win.hide();
                } else {
                    // 桌面窗口不存在时，正常退出
                    // 优化：立即隐藏所有窗口提供即时反馈，因为主进程清理（如音频引擎、分布式服务器）可能耗时数秒
                    BrowserWindow.getAllWindows().forEach(w => {
                        if (!w.isDestroyed()) w.hide();
                    });
                    app.isQuitting = true; // 标记正在退出，允许窗口关闭事件通过
                    app.quit();
                }
            } else {
                win.close();
            }
        }
    });

    ipcMain.on('hide-window', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            win.hide();
        }
    });

    ipcMain.on('toggle-notifications-sidebar', () => {
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('do-toggle-notifications-sidebar');
        }
    });

    ipcMain.on('open-dev-tools', () => {
        console.log('[Main Process] Received open-dev-tools event.'); 
        if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.openDevTools({ mode: 'detach' });
            console.log('[Main Process] Attempting to open detached dev tools.'); 
        } else {
            console.error('[Main Process] Cannot open dev tools: mainWindow or webContents is not available or destroyed.'); 
            if (!mainWindow) console.error('[Main Process] mainWindow is null or undefined.');
            else if (!mainWindow.webContents) console.error('[Main Process] mainWindow.webContents is null or undefined.');
            else if (mainWindow.webContents.isDestroyed()) console.error('[Main Process] mainWindow.webContents is destroyed.');
        }
    });

    /**
     * 渲染进程把大 payload（如完整 dataURL/Blob 转成的 dataURL）注册到主进程，
     * 拿到一个一次性 token，用于在打开图片预览窗口时跨进程取数据，
     * 避免把超长字符串塞到 BrowserWindow.loadURL 的 query 参数里。
     */
    ipcMain.handle('image-viewer:register-payload', (event, payload = {}) => {
        cleanupExpiredImagePayloads();
        const { src, title = '图片预览', theme = 'dark' } = payload || {};
        if (typeof src !== 'string' || !src) {
            throw new Error('image-viewer:register-payload requires a non-empty "src" string.');
        }
        const token = generateImagePayloadToken();
        imageViewerPayloads.set(token, {
            src,
            title,
            theme,
            createdAt: Date.now(),
        });
        return token;
    });

    /**
     * 图片预览窗口加载完毕后通过此通道一次性拉走 payload，主进程随即清理引用。
     */
    ipcMain.handle('image-viewer:consume-payload', (event, token) => {
        if (!token || typeof token !== 'string') return null;
        const payload = imageViewerPayloads.get(token);
        if (!payload) return null;
        imageViewerPayloads.delete(token);
        return {
            src: payload.src,
            title: payload.title,
            theme: payload.theme,
        };
    });

    ipcMain.on('open-image-viewer', (event, payload = {}) => {
        const { src, title, theme } = payload || {};
        if (!src) {
            console.error('[WindowHandlers] open-image-viewer received empty src.');
            return;
        }

        // 自动判断是否需要走 token：dataURL/超长 URL 一律不进 query string，避免被截断。
        const isLargePayload = typeof src === 'string'
            && (src.startsWith('data:') || src.length > 1500);

        let token = null;
        if (isLargePayload) {
            cleanupExpiredImagePayloads();
            token = generateImagePayloadToken();
            imageViewerPayloads.set(token, {
                src,
                title: title || '图片预览',
                theme: theme || 'dark',
                createdAt: Date.now(),
            });
        }

        const imageViewerWindow = new BrowserWindow({
            width: 1000,
            height: 800,
            minWidth: 600,
            minHeight: 500,
            title: title || '图片预览',
            modal: false,
            frame: false, // 移除原生窗口框架
            ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }), // 隐藏标题栏
            webPreferences: {
                preload: resolveAppPreload(app.getAppPath(), PRELOAD_ROLES.UTILITY),
                contextIsolation: true,
                nodeIntegration: false,
            },
            icon: path.join(__dirname, '../../assets/icon.png'), // Correct path from this file's location
            show: false,
        });

        imageViewerWindow.setMenu(null);

        const queryParts = [];
        if (token) {
            queryParts.push(`token=${encodeURIComponent(token)}`);
            queryParts.push(`title=${encodeURIComponent(title || '图片预览')}`);
            queryParts.push(`theme=${encodeURIComponent(theme || 'dark')}`);
        } else {
            queryParts.push(`src=${encodeURIComponent(src)}`);
            queryParts.push(`title=${encodeURIComponent(title || '图片预览')}`);
            queryParts.push(`theme=${encodeURIComponent(theme || 'dark')}`);
        }
        const url = `file://${path.join(__dirname, '../../modules/image-viewer.html')}?${queryParts.join('&')}`;
        imageViewerWindow.loadURL(url);

        imageViewerWindow.once('ready-to-show', () => {
            imageViewerWindow.show();
        });

        // Add to the list of open windows to receive theme updates
        openChildWindows.push(imageViewerWindow);

        imageViewerWindow.on('closed', () => {
            // 兜底清理：万一渲染进程没拉走 payload，窗口关闭时也释放掉。
            if (token && imageViewerPayloads.has(token)) {
                imageViewerPayloads.delete(token);
            }
            const index = openChildWindows.indexOf(imageViewerWindow);
            if (index > -1) {
                openChildWindows.splice(index, 1);
            }
        });
    });

    ipcMain.on('open-forum-window', (event) => {
        if (forumWindowInstance && !forumWindowInstance.isDestroyed()) {
            if (!forumWindowInstance.isVisible()) {
                forumWindowInstance.show();
            }
            forumWindowInstance.focus();
            return;
        }

        const forumWindow = new BrowserWindow({
            width: 1200,
            height: 800,
            minWidth: 800,
            minHeight: 600,
            title: 'VCP 论坛',
            modal: false,
            frame: false,
            ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
            webPreferences: {
                preload: resolveAppPreload(app.getAppPath(), PRELOAD_ROLES.UTILITY),
                contextIsolation: true,
                nodeIntegration: false,
            },
            icon: path.join(__dirname, '../../assets/icon.png'),
            show: false,
        });

        forumWindowInstance = forumWindow;

        forumWindow.setMenu(null);

        const url = `file://${path.join(__dirname, '../../Forummodules/forum.html')}`;
        forumWindow.loadURL(url);

        forumWindow.once('ready-to-show', () => {
            forumWindow.show();
        });

        // Add to the list of open windows to receive theme updates
        openChildWindows.push(forumWindow);

        forumWindow.on('close', (event) => {
            if (process.platform === 'darwin') {
                event.preventDefault();
                forumWindow.hide();
            }
        });

        forumWindow.on('closed', () => {
            const index = openChildWindows.indexOf(forumWindow);
            if (index > -1) {
                openChildWindows.splice(index, 1);
            }
            forumWindowInstance = null;
        });
    });

    ipcMain.on('open-memo-window', (event) => {
        if (memoWindowInstance && !memoWindowInstance.isDestroyed()) {
            if (!memoWindowInstance.isVisible()) {
                memoWindowInstance.show();
            }
            memoWindowInstance.focus();
            return;
        }

        const memoWindow = new BrowserWindow({
            width: 1200,
            height: 800,
            minWidth: 800,
            minHeight: 600,
            title: 'VCP Memo 中心',
            modal: false,
            frame: false,
            ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
            webPreferences: {
                preload: resolveAppPreload(app.getAppPath(), PRELOAD_ROLES.UTILITY),
                contextIsolation: true,
                nodeIntegration: false,
            },
            icon: path.join(__dirname, '../../assets/icon.png'),
            show: false,
        });

        memoWindowInstance = memoWindow;

        memoWindow.setMenu(null);

        const url = `file://${path.join(__dirname, '../../Memomodules/memo.html')}`;
        memoWindow.loadURL(url);

        memoWindow.once('ready-to-show', () => {
            memoWindow.show();
        });

        // Add to the list of open windows to receive theme updates
        openChildWindows.push(memoWindow);

        memoWindow.on('close', (event) => {
            if (process.platform === 'darwin') {
                event.preventDefault();
                memoWindow.hide();
            }
        });

        memoWindow.on('closed', () => {
            const index = openChildWindows.indexOf(memoWindow);
            if (index > -1) {
                openChildWindows.splice(index, 1);
            }
        memoWindowInstance = null;
        });
    });

    ipcMain.on('open-log-window', (event) => {
        if (logWindowInstance && !logWindowInstance.isDestroyed()) {
            if (!logWindowInstance.isVisible()) {
                logWindowInstance.show();
            }
            logWindowInstance.focus();
            return;
        }

        const logWindow = new BrowserWindow({
            width: 450,
            height: 820,
            minWidth: 450,
            minHeight: 560,
            title: 'VCP日志中心',
            modal: false,
            frame: false,
            ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
            webPreferences: {
                preload: resolveAppPreload(app.getAppPath(), PRELOAD_ROLES.UTILITY),
                contextIsolation: true,
                nodeIntegration: false,
            },
            icon: path.join(__dirname, '../../assets/icon.png'),
            show: false,
        });

        logWindowInstance = logWindow;
        logWindow.setMenu(null);

        const url = `file://${path.join(__dirname, '../../Logmodules/log.html')}`;
        logWindow.loadURL(url);

        logWindow.once('ready-to-show', () => {
            logWindow.show();
        });

        openChildWindows.push(logWindow);

        logWindow.on('close', (event) => {
            if (process.platform === 'darwin') {
                event.preventDefault();
                logWindow.hide();
            }
        });

        logWindow.on('closed', () => {
            const index = openChildWindows.indexOf(logWindow);
            if (index > -1) {
                openChildWindows.splice(index, 1);
            }
            logWindowInstance = null;
        });
    });

    ipcMain.on('open-task-window', async (event) => {
        const windowService = require('../services/windowService');
        const WINDOW_APP_IDS = require('../services/windowAppIds');
        await windowService.open(WINDOW_APP_IDS.TASK);
    });

    ipcHandlersRegistered = true;
}

module.exports = {
    initialize
};
