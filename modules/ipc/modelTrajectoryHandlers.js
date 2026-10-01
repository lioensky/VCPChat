// modules/ipc/modelTrajectoryHandlers.js
// 侧栏「调用轨迹」标签的主进程桥：把 modules/modelTrajectory.js 记录下来的每次模型调用交给渲染端展示。
// 对照 ZCode 的 model-io 轨迹（packages/services/src，Apache-2.0）：按会话（话题）读取、清空、打开记录目录、实时变更通知。
// - 仅放行主窗口页面（与 Git / 终端侧栏同样按调用页面 URL 校验）。
// - 渲染端只传 sessionKey，文件路径永远由主进程按净化后的 key 解析。
// - 变更通知按 (会话, 调用) 合并，100ms 一发，渲染端只需要知道「这条调用变了」。
'use strict';

const fs = require('fs');
const { ipcMain, shell } = require('electron');
const { isAllowedSenderUrl } = require('./gitHandlers');
const { configureSharedRecorder, getSharedRecorder } = require('../modelTrajectory');

const CHANNELS = [
    'model-trajectory:list',
    'model-trajectory:clear',
    'model-trajectory:open-directory',
    'model-trajectory:watch'
];
const NOTIFY_INTERVAL_MS = 100;
const MAX_LIST_LIMIT = 500;

/** @type {Map<Electron.WebContents, { unsubscribe: Function, pending: Map<string, object>, timer: NodeJS.Timeout|null }>} */
const watchers = new Map();
const trackedSenders = new WeakSet();

function isAllowedSender(event) {
    const raw = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
    return isAllowedSenderUrl(raw);
}

function safeSend(sender, channel, payload) {
    if (!sender || sender.isDestroyed?.()) return;
    try {
        sender.send(channel, payload);
    } catch (_error) {
        // 窗口正在销毁，忽略
    }
}

function stopWatcher(sender) {
    const watcher = watchers.get(sender);
    if (!watcher) return;
    watchers.delete(sender);
    if (watcher.timer) clearTimeout(watcher.timer);
    try {
        watcher.unsubscribe();
    } catch (_error) {
        // 已取消
    }
}

function trackSender(sender) {
    if (trackedSenders.has(sender)) return;
    trackedSenders.add(sender);
    sender.on('destroyed', () => stopWatcher(sender));
    sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) stopWatcher(sender);
    });
}

function startWatcher(sender) {
    if (watchers.has(sender)) return;
    const recorder = getSharedRecorder();
    if (!recorder) throw new Error('调用轨迹尚未启用。');
    const watcher = { unsubscribe: () => {}, pending: new Map(), timer: null };
    const flush = () => {
        watcher.timer = null;
        for (const change of watcher.pending.values()) safeSend(sender, 'model-trajectory:changed', change);
        watcher.pending.clear();
    };
    watcher.unsubscribe = recorder.subscribe((change) => {
        watcher.pending.set(`${change.sessionKey}/${change.id || ''}`, change);
        if (!watcher.timer) watcher.timer = setTimeout(flush, NOTIFY_INTERVAL_MS);
    });
    watchers.set(sender, watcher);
    trackSender(sender);
}

function initialize({ rootDir } = {}) {
    CHANNELS.forEach((channel) => ipcMain.removeHandler(channel));
    if (rootDir) configureSharedRecorder({ rootDir });

    const denied = { success: false, error: '当前窗口无权查看调用轨迹。' };
    const failure = (error) => ({ success: false, error: error?.message || String(error) });
    const requireRecorder = () => {
        const recorder = getSharedRecorder();
        if (!recorder) throw new Error('调用轨迹尚未启用。');
        return recorder;
    };
    const validKey = (key) => typeof key === 'string' && key.length > 0 && key.length <= 300;

    ipcMain.handle('model-trajectory:list', async (event, sessionKey, options) => {
        if (!isAllowedSender(event)) return denied;
        if (!validKey(sessionKey)) return { success: false, error: '会话参数无效。' };
        try {
            const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(Number(options?.limit)) || 200));
            return { success: true, data: await requireRecorder().list(sessionKey, { limit }) };
        } catch (error) {
            return failure(error);
        }
    });

    ipcMain.handle('model-trajectory:clear', async (event, sessionKey) => {
        if (!isAllowedSender(event)) return denied;
        if (!validKey(sessionKey)) return { success: false, error: '会话参数无效。' };
        try {
            await requireRecorder().clear(sessionKey);
            return { success: true };
        } catch (error) {
            return failure(error);
        }
    });

    ipcMain.handle('model-trajectory:open-directory', async (event) => {
        if (!isAllowedSender(event)) return denied;
        try {
            const directory = requireRecorder().getDirectory();
            fs.mkdirSync(directory, { recursive: true });
            const problem = await shell.openPath(directory);
            return problem ? { success: false, error: problem } : { success: true, data: { directory } };
        } catch (error) {
            return failure(error);
        }
    });

    ipcMain.handle('model-trajectory:watch', (event) => {
        if (!isAllowedSender(event)) return denied;
        try {
            startWatcher(event.sender);
            return { success: true };
        } catch (error) {
            return failure(error);
        }
    });
}

function disposeAll() {
    for (const sender of [...watchers.keys()]) stopWatcher(sender);
}

module.exports = { initialize, disposeAll };
