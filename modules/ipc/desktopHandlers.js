/**
 * modules/ipc/desktopHandlers.js
 * VCPdesktop IPC 处理模块
 * 负责：桌面窗口创建管理、流式推送转发、未来桌面图标等高级功能
 */

const { BrowserWindow, ipcMain, app, screen } = require('electron');
const path = require('path');

// --- 模块状态 ---
let desktopWindow = null;
let mainWindow = null;
let openChildWindows = [];
let appSettingsManager = null;

/**
 * 初始化桌面处理模块
 */
function initialize(params) {
    mainWindow = params.mainWindow;
    openChildWindows = params.openChildWindows;
    appSettingsManager = params.settingsManager;

    // --- IPC: 打开桌面窗口 ---
    ipcMain.handle('open-desktop-window', async () => {
        await openDesktopWindow();
    });

    // --- IPC: 主窗口 → 桌面画布的流式推送 ---
    // 防御性设计：如果桌面窗口不存在，静默忽略（不打印警告，因为流式推送可能每秒触发很多次）
    ipcMain.on('desktop-push', (event, data) => {
        if (desktopWindow && !desktopWindow.isDestroyed()) {
            desktopWindow.webContents.send('desktop-push-to-canvas', data);
        }
        // 桌面窗口不存在时无事发生，这是预期行为
    });

    console.log('[DesktopHandlers] Initialized.');
}

/**
 * 打开或聚焦桌面画布窗口
 */
async function openDesktopWindow() {
    if (desktopWindow && !desktopWindow.isDestroyed()) {
        if (!desktopWindow.isVisible()) desktopWindow.show();
        desktopWindow.focus();
        return desktopWindow;
    }

    // 读取设置获取主题模式
    let currentThemeMode = 'dark';
    try {
        if (appSettingsManager) {
            const settings = await appSettingsManager.readSettings();
            currentThemeMode = settings.currentThemeMode || 'dark';
        }
    } catch (e) {
        console.error('[Desktop] Failed to read theme settings:', e);
    }

    desktopWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 600,
        minHeight: 400,
        title: 'VCPdesktop',
        frame: false,
        ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
        webPreferences: {
            preload: path.join(app.getAppPath(), 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
        show: false,
    });

    const desktopUrl = `file://${path.join(app.getAppPath(), 'Desktopmodules', 'desktop.html')}?currentThemeMode=${encodeURIComponent(currentThemeMode)}`;
    desktopWindow.loadURL(desktopUrl);
    desktopWindow.setMenu(null);

    desktopWindow.once('ready-to-show', () => {
        desktopWindow.show();
        // 通知桌面窗口自身连接状态
        if (desktopWindow && !desktopWindow.isDestroyed()) {
            desktopWindow.webContents.send('desktop-status', { connected: true, message: '已连接' });
        }
        // 关键：通知主窗口桌面画布已就绪，让主窗口的streamManager知道可以推送了
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('desktop-status', { connected: true, message: '桌面画布已就绪' });
        }
    });

    if (openChildWindows) {
        openChildWindows.push(desktopWindow);
    }

    desktopWindow.on('close', (event) => {
        if (process.platform === 'darwin' && !app.isQuitting) {
            event.preventDefault();
            desktopWindow.hide();
        }
    });

    desktopWindow.on('closed', () => {
        if (openChildWindows) {
            const index = openChildWindows.indexOf(desktopWindow);
            if (index > -1) openChildWindows.splice(index, 1);
        }
        desktopWindow = null;
        console.log('[Desktop] Desktop window closed.');
        // 通知主窗口桌面画布已关闭
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('desktop-status', { connected: false, message: '桌面画布已关闭' });
        }
    });

    return desktopWindow;
}

/**
 * 向桌面画布推送数据
 * 可被其他模块直接调用（不经过IPC）
 */
function pushToDesktop(data) {
    if (desktopWindow && !desktopWindow.isDestroyed()) {
        desktopWindow.webContents.send('desktop-push-to-canvas', data);
        return true;
    }
    return false;
}

/**
 * 获取桌面窗口实例
 */
function getDesktopWindow() {
    return desktopWindow;
}

module.exports = {
    initialize,
    openDesktopWindow,
    pushToDesktop,
    getDesktopWindow,
};