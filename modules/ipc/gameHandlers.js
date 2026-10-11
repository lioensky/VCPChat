'use strict';

const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { fileURLToPath } = require('url');
const ROOT = path.resolve(__dirname, '../..');
const HALL = path.join(ROOT, 'Gamemodules/game.html');
let registered = false;
let neonWindow = null;

function isHallSender(event) {
    try {
        if (!event?.sender || event.sender.isDestroyed()) return false;
        if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
        const url = new URL(event.senderFrame.url);
        return url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === HALL;
    } catch {
        return false;
    }
}

async function openGame(gameId) {
    if (gameId === 'blade') {
        const service = require('../../VCPDistributedServer/Plugin/BladeGame/blade-service');
        service.initialize();
        const win = service.createOrFocusWindow();
        if (win.webContents.isLoading()) {
            await new Promise((resolve, reject) => {
                const contents = win.webContents;
                const clear = () => {
                    contents.removeListener('did-finish-load', loaded);
                    contents.removeListener('did-fail-load', failed);
                    win.removeListener('closed', closed);
                };
                const loaded = () => { clear(); resolve(); };
                const failed = (_event, code, description, _url, isMainFrame) => {
                    if (isMainFrame === false) return;
                    clear(); reject(new Error(`华山论剑加载失败：${code} ${description}`));
                };
                const closed = () => { clear(); reject(new Error('游戏窗口已关闭。')); };
                contents.once('did-finish-load', loaded);
                contents.on('did-fail-load', failed);
                win.once('closed', closed);
            });
        }
        return { success: true, gameId };
    }
    if (gameId !== 'neon') return { success: false, error: '未知游戏。' };
    if (neonWindow && !neonWindow.isDestroyed()) {
        if (neonWindow.isMinimized()) neonWindow.restore();
        neonWindow.show();
        neonWindow.focus();
        return { success: true, gameId };
    }
    const win = new BrowserWindow({
        width: 1280, height: 860, minWidth: 640, minHeight: 480,
        title: 'VCP Neon Striker',
        backgroundColor: '#04040b', show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    neonWindow = win;
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('closed', () => { if (neonWindow === win) neonWindow = null; });
    try {
        await win.loadFile(path.join(ROOT, 'Gamemodules/vcp-neon-game/index.html'));
        if (win.isDestroyed()) throw new Error('游戏窗口已关闭。');
        win.show();
        win.focus();
        return { success: true, gameId };
    } catch (error) {
        if (!win.isDestroyed()) win.destroy();
        throw error;
    }
}

function initialize() {
    if (registered) return;
    ipcMain.handle('vcp-game:launch', async (event, gameId) => {
        if (!isHallSender(event)) return { success: false, error: '非法大厅请求。' };
        try { return await openGame(gameId); }
        catch (error) { return { success: false, error: error.message }; }
    });
    registered = true;
}

module.exports = { initialize, isHallSender };