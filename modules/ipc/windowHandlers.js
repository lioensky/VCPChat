// modules/ipc/windowHandlers.js
const { ipcMain, app, BrowserWindow } = require('electron');
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

    ipcMain.on('open-image-viewer', (event, { src, title, theme }) => {
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

        const url = `file://${path.join(__dirname, '../../modules/image-viewer.html')}?src=${encodeURIComponent(src)}&title=${encodeURIComponent(title)}&theme=${encodeURIComponent(theme || 'dark')}`;
        imageViewerWindow.loadURL(url);
 
         imageViewerWindow.once('ready-to-show', () => {
            imageViewerWindow.show();
        });

        // Add to the list of open windows to receive theme updates
        openChildWindows.push(imageViewerWindow);

        imageViewerWindow.on('closed', () => {
            // Remove from the list when closed
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

    ipcHandlersRegistered = true;
}

module.exports = {
    initialize
};
