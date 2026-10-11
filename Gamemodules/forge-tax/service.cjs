'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SessionStore } = require('./session-store.cjs');
const PAGE = path.join(__dirname, 'index.html');
const HUMAN = 'human:local';
let store, initialized = false;
const windows = new Map(), bindings = new Map();
function identity(args = {}) {
    if (typeof args.maid !== 'string' || !args.maid.trim()) throw new Error('缺少maid名字');
    const name = args.maid.trim().normalize('NFC');
    if (name.length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error('maid名字过长或含控制字符');
    if (Object.keys(args).some(key => /^(maid|valet)[0-9]+$/i.test(key))) throw new Error('串指令仅使用顶层maid，不能逐步切换存档');
    return { owner: 'agent:' + name, name };
}
function getStore() {
    if (!store) store = new SessionStore(path.join(app.getPath('userData'), 'ForgeTax', 'sessions'));
    return store;
}
function senderOwner(event) {
    if (!event.senderFrame || event.senderFrame !== event.sender?.mainFrame
        || event.sender.isDestroyed() || event.senderFrame.url !== pathToFileURL(PAGE).href) throw new Error('非法ForgeTax窗口请求');
    const owner = bindings.get(event.sender.id);
    if (!owner) throw new Error('窗口未绑定对局');
    return owner;
}
function initialize() {
    if (initialized) return;
    initialized = true;
    getStore().subscribe((owner, output) => {
        const win = windows.get(owner);
        if (win && !win.isDestroyed()) win.webContents.send('forge-tax:update', output);
    });
    ipcMain.handle('forge-tax:query', async event => {
        try {
            const owner = senderOwner(event);
            const output = await getStore().execute(owner, { command: 'GetState' });
            return { ...output, readOnly: owner !== HUMAN };
        } catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.handle('forge-tax:command', async (event, args) => {
        try {
            const owner = senderOwner(event);
            if (owner !== HUMAN) throw new Error('AI对局为观看模式，请通过对应Agent工具操作');
            return await getStore().execute(owner, args);
        } catch (error) { return { ok: false, error: error.message }; }
    });
}
async function openWindow(owner = HUMAN) {
    initialize();
    const existing = windows.get(owner);
    if (existing && !existing.isDestroyed()) {
        if (existing.isMinimized()) existing.restore();
        existing.show(); existing.focus(); return;
    }
    // Opening the user's window may initialize an absent save, never replace an existing one.
    if (owner === HUMAN) {
        const output = await getStore().execute(owner, { command: 'GetState' });
        if (!output.state) {
            // load throws for corruption: such errors must not become a fresh game.
            await getStore().execute(owner, { command: 'StartGame', player: '莱恩' });
        }
    }
    const win = new BrowserWindow({
        width: 1280, height: 860, minWidth: 640, minHeight: 480,
        title: owner === HUMAN ? 'ForgeTax · 锻造模拟器' : `ForgeTax · ${owner} · 观看`,
        show: false, backgroundColor: '#111015',
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
            preload: path.join(__dirname, 'preload.cjs') }
    });
    const contentsId = win.webContents.id;
    windows.set(owner, win); bindings.set(contentsId, owner);
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('closed', () => {
        bindings.delete(contentsId);
        if (windows.get(owner) === win) windows.delete(owner);
    });
    try { await win.loadFile(PAGE); win.show(); win.focus(); }
    catch (error) { if (!win.isDestroyed()) win.destroy(); throw error; }
}
async function executeTool(args = {}) {
    initialize();
    const who = identity(args);
    if (args.command === 'OpenWindow') {
        await openWindow(who.owner);
        return { ok: true, message: '观看窗口已打开' };
    }
    // Identity cannot be overridden by any numbered step.
    const output = await getStore().execute(who.owner, { ...args, player: who.name });
    if (args.openWindow === true || args.openWindow === 'true') await openWindow(who.owner);
    return output;
}
async function processToolCall(args = {}) {
    const { formatResult } = require('./tool-result.cjs');
    return formatResult(await executeTool(args));
}
function cleanup() {
    for (const win of windows.values()) if (!win.isDestroyed()) win.destroy();
}
module.exports = { initialize, openWindow, processToolCall, cleanup, identity, executeTool };