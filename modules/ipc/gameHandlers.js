'use strict';

const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { fileURLToPath } = require('url');
const ROOT = path.resolve(__dirname, '../..');
const HALL = path.join(ROOT, 'Gamemodules/game.html');
let registered = false;
let gameRuntime = null;
let listGameAgents = null;
const gameWindows = new Map();
const LOCAL_GAMES = Object.freeze({
    neon: { title: 'VCP Neon Striker', page: 'Gamemodules/vcp-neon-game/index.html' },
    forgeTax: { title: 'ForgeTax · 锻造模拟器', page: 'Gamemodules/forge-tax/index.html' },
    doudizhu: { title: 'Vgame · 斗地主', page: 'Gamemodules/doudizhu/index.html' },
});

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
    if (gameId === 'forgeTax') {
        await require('../../Gamemodules/forge-tax/service.cjs').openWindow();
        return { success: true, gameId };
    }
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
    if (!Object.prototype.hasOwnProperty.call(LOCAL_GAMES, gameId)) return { success: false, error: '未知游戏。' };
    const game = LOCAL_GAMES[gameId];
    const existing = gameWindows.get(gameId);
    if (existing && !existing.isDestroyed()) {
        if (existing.isMinimized()) existing.restore();
        existing.show();
        existing.focus();
        return { success: true, gameId };
    }
    const win = new BrowserWindow({
        width: 1280, height: 860, minWidth: 640, minHeight: 480,
        title: game.title,
        backgroundColor: '#04040b', show: false,
        webPreferences: {
            contextIsolation: true, nodeIntegration: false, sandbox: gameId !== 'doudizhu',
            ...(gameId === 'doudizhu' ? { preload: path.join(ROOT, 'preloads/utility.js') } : {}),
        },
    });
    gameWindows.set(gameId, win);
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('closed', () => { if (gameWindows.get(gameId) === win) gameWindows.delete(gameId); });
    try {
        await win.loadFile(path.join(ROOT, game.page));
        if (win.isDestroyed()) throw new Error('游戏窗口已关闭。');
        win.show();
        win.focus();
        return { success: true, gameId };
    } catch (error) {
        if (!win.isDestroyed()) win.destroy();
        throw error;
    }
}

function configureRuntime({ gameService, groupChat, loadAgent, listAgents }) {
    listGameAgents = listAgents;
    if (gameRuntime) return gameRuntime;
    const { GameRuntime } = require('../game/gameRuntime');
    gameRuntime = new GameRuntime({
        gameService, groupChat, loadAgent,
        toolInstructions: async () => '',
        runAgent: async ({ groupId, topicId, agentId, invitePrompt }) => {
            let requestError = null;
            await groupChat.handleInviteAgentToSpeak(
                groupId, topicId, agentId,
                event => {
                    if (event.error || event.interrupted) {
                        requestError = new Error(String(event.error || '游戏请求已中止。'));
                    }
                },
                loadAgent,
                { invitePrompt, skipSummary: true },
            );
            if (requestError) throw requestError;
        },
    });
    return gameRuntime;
}
function isTableSender(event) {
    const win = gameWindows.get('doudizhu');
    if (!win || win.isDestroyed() || event?.sender !== win.webContents
        || event.senderFrame !== event.sender.mainFrame) return false;
    try {
        const url = new URL(event.senderFrame.url);
        return url.protocol === 'file:' && path.resolve(fileURLToPath(url))
            === path.join(ROOT, LOCAL_GAMES.doudizhu.page);
    } catch { return false; }
}
function scheduleMatch(matchId) {
    void gameRuntime.continue(matchId).catch(error => {
        console.warn('[Vgame] 对局推进暂停:', error?.message || error);
    });
}
function registerTableHandlers() {
    const handle = (channel, operation) => ipcMain.handle(channel, async (event, request = {}) => {
        if (!isTableSender(event)) return { success: false, error: '非法牌桌窗口请求。' };
        if (!gameRuntime) return { success: false, error: '游戏后台尚未就绪。' };
        try { return { success: true, ...await operation(request) }; }
        catch (error) { return { success: false, error: error.message, code: error.code }; }
    });
    handle('vcp-game:agents', async () => ({ agents: await listGameAgents() }));
    handle('vcp-game:create', async request => {
        const table = await gameRuntime.openTable(request);
        scheduleMatch(table.matchId);
        return table;
    });
    handle('vcp-game:next', async request => {
        const table = await gameRuntime.nextTable(request.matchId);
        scheduleMatch(table.matchId);
        return table;
    });
    handle('vcp-game:observe', async request => {
        const record = await gameRuntime.gameService.read(request.matchId);
        return {
            observation: {
                matchId: record.matchId,
                decisionId: `${record.matchId}:${record.state.revision}`,
                ...require('../game/doudizhu/rules').observation(record.state, 0),
            },
            seats: record.seats,
            runtime: gameRuntime.getState(request.matchId),
        };
    });
    handle('vcp-game:submit', async request => {
        const result = await gameRuntime.submitHuman(request.matchId, request);
        scheduleMatch(request.matchId);
        return { result };
    });
    handle('vcp-game:continue', async request => {
        await gameRuntime.gameService.read(request.matchId);
        scheduleMatch(request.matchId);
        return {};
    });
    handle('vcp-game:stop', async request => {
        await gameRuntime.gameService.read(request.matchId);
        gameRuntime.stop(request.matchId);
        return {};
    });
}
function initialize() {
    if (registered) return;
    ipcMain.handle('vcp-game:launch', async (event, gameId) => {
        if (!isHallSender(event)) return { success: false, error: '非法大厅请求。' };
        try { return await openGame(gameId); }
        catch (error) { return { success: false, error: error.message }; }
    });
    for (const [channel, operation] of [
        ['vcp-game:records', () => gameRuntime.gameService.listRecords()],
        ['vcp-game:record', request => gameRuntime.gameService.getPublicRecord(request.matchId)],
    ]) {
        ipcMain.handle(channel, async (event, request = {}) => {
            if (!isHallSender(event)) return { success: false, error: '非法大厅请求。' };
            if (!gameRuntime) return { success: false, error: '游戏后台尚未就绪。' };
            try { return { success: true, ...await operation(request) }; }
            catch (error) { return { success: false, error: error.message, code: error.code }; }
        });
    }
    registerTableHandlers();
    registered = true;
}

module.exports = { initialize, isHallSender, configureRuntime, getRuntime: () => gameRuntime };