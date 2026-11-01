'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SessionStore } = require('./session-store.cjs');

const PAGE = path.join(__dirname, 'index.html');
const BOARD_ID = 'shared';
let store = null;
let initialized = false;
let activeWindow = null;

function getStore() {
    if (!store) {
        const baseDir = app?.getPath ? app.getPath('userData') : path.resolve(__dirname, '../../AppData/UserData');
        store = new SessionStore(path.join(baseDir, 'TavernSRPG', 'sessions'));
    }
    return store;
}

function assertValidSender(event) {
    if (!event?.senderFrame || event.senderFrame !== event.sender?.mainFrame
        || event.sender.isDestroyed()) {
        throw new Error('非法 SRPG 窗口请求');
    }
    const url = new URL(event.senderFrame.url);
    if (url.protocol !== 'file:' || pathToFileURL(PAGE).href !== url.origin + url.pathname) {
        throw new Error('非法 SRPG 窗口来源');
    }
}

function initialize() {
    if (initialized) return;
    initialized = true;
    getStore().subscribe((boardId, output) => {
        if (boardId !== BOARD_ID) return;
        if (activeWindow && !activeWindow.isDestroyed()) {
            activeWindow.webContents.send('srpg:update', output);
        }
    });
    ipcMain.handle('srpg:query', async event => {
        try {
            assertValidSender(event);
            return await getStore().execute(BOARD_ID, { command: 'GetState' });
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });
    ipcMain.handle('srpg:command', async (event, args = {}) => {
        try {
            assertValidSender(event);
            return await getStore().execute(BOARD_ID, args);
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });
    ipcMain.handle('srpg:sync', async (event, payload = {}) => {
        try {
            assertValidSender(event);
            return await getStore().syncFromUi(BOARD_ID, payload);
        } catch (error) {
            return { ok: false, error: error.message };
        }
    });
}

async function openWindow() {
    initialize();
    if (activeWindow && !activeWindow.isDestroyed()) {
        if (activeWindow.isMinimized()) activeWindow.restore();
        activeWindow.show();
        activeWindow.focus();
        return activeWindow;
    }
    await getStore().execute(BOARD_ID, { command: 'GetState' });
    const win = new BrowserWindow({
        width: 1380,
        height: 900,
        minWidth: 820,
        minHeight: 560,
        title: 'Tavern-SRPG · 万缕千丝战棋战术沙盘',
        show: false,
        backgroundColor: '#0f1420',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.cjs'),
        },
    });
    activeWindow = win;
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('closed', () => {
        if (activeWindow === win) activeWindow = null;
    });
    try {
        await win.loadFile(PAGE);
        if (!win.isDestroyed()) {
            win.show();
            win.focus();
        }
        return win;
    } catch (error) {
        if (!win.isDestroyed()) win.destroy();
        throw error;
    }
}

async function executeTool(args = {}) {
    initialize();
    if (args.command === 'OpenWindow') {
        await openWindow();
        const out = await getStore().execute(BOARD_ID, { command: 'GetState' });
        return { ...out, message: '战棋战术沙盘窗口已打开并聚焦' };
    }
    const output = await getStore().execute(BOARD_ID, args);
    if (args.openWindow === true || args.openWindow === 'true') {
        await openWindow();
    }
    return output;
}

async function processToolCall(args = {}) {
    const { formatResult } = require('./tool-result.cjs');
    return formatResult(await executeTool(args));
}

function cleanup() {
    if (activeWindow && !activeWindow.isDestroyed()) activeWindow.destroy();
    activeWindow = null;
}

module.exports = { initialize, openWindow, executeTool, processToolCall, cleanup, getStore };