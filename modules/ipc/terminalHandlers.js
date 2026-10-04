// modules/ipc/terminalHandlers.js
// 侧栏「终端」标签的主进程桥。它不自带 shell，而是把 VCPChat 自带的终端（PowerShellExecutor 插件的 PTY 会话，
// 即托盘「终端」与 AI 工具 PowerShellExecutor 共用的那一个）镜像到主窗口侧栏：
// - 输出同时送往终端窗口和侧栏；侧栏里的输入 / 调整大小直接落到同一个 PTY。
// - 仅放行主窗口页面（与 Git / 源码侧栏同样按调用页面 URL 校验）。
// - 会话归属于创建镜像的 webContents：页面销毁 / 刷新时只取消镜像，不结束终端会话（它可能正被 AI 使用）。
// - 「跳转到工作区」只接收 workspaceId，路径由主进程按工作区列表解析。
'use strict';

const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const { createApplicationSenderGuard, resolveWindowWebContents } = require('./applicationSender');
let getMainWindow = () => null;

const CHANNELS = [
    'terminal:create',
    'terminal:write',
    'terminal:resize',
    'terminal:kill',
    'terminal:restart',
    'terminal:cd',
    'terminal:command-runs',
    'terminal:command-run',
    'terminal:watch-command-runs',
];

const EXECUTOR_PATH = path.join(__dirname, '..', '..', 'VCPDistributedServer', 'Plugin', 'PowerShellExecutor', 'PowerShellExecutor.js');
const MAX_VIEWS = 8;
const MAX_WRITE_CHARS = 1024 * 1024;
const MIN_COLS = 2;
const MIN_ROWS = 1;
const MAX_COLS = 500;
const MAX_ROWS = 200;
const RUN_NOTIFY_INTERVAL_MS = 120;

let workspaceServiceRef = null;
let loadExecutor = () => require(EXECUTOR_PATH);
let sequence = 0;
/** @type {Map<string, { id: string, sender: Electron.WebContents, detach: Function }>} */
const views = new Map();
const trackedSenders = new WeakSet();
/** @type {Map<Electron.WebContents, { unsubscribe: Function, pending: Map<string, object>, timer: NodeJS.Timeout|null }>} */
const runWatchers = new Map();

const isAllowedSender = createApplicationSenderGuard({ getMainWebContents: () => resolveWindowWebContents(getMainWindow) });

function clampInt(value, min, max, fallback) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function safeSend(sender, channel, payload) {
    if (!sender || sender.isDestroyed?.()) return;
    try {
        sender.send(channel, payload);
    } catch (_error) {
        // 窗口正在销毁，忽略
    }
}

function detachView(view) {
    if (!view) return;
    views.delete(view.id);
    try {
        view.detach();
    } catch (_error) {
        // 已取消
    }
}

function detachViewsOf(sender) {
    for (const view of [...views.values()]) {
        if (view.sender === sender) detachView(view);
    }
}

function stopRunWatcher(sender) {
    const watcher = runWatchers.get(sender);
    if (!watcher) return;
    runWatchers.delete(sender);
    if (watcher.timer) clearTimeout(watcher.timer);
    try {
        watcher.unsubscribe();
    } catch (_error) {
        // 已取消
    }
}

function startRunWatcher(sender) {
    if (runWatchers.has(sender)) return;
    const watcher = { unsubscribe: () => {}, pending: new Map(), timer: null };
    const flush = () => {
        watcher.timer = null;
        for (const summary of watcher.pending.values()) safeSend(sender, 'terminal:command-run-changed', summary);
        watcher.pending.clear();
    };
    // 输出很碎，按运行记录合并后再通知，渲染端只需要知道「这条变了」
    watcher.unsubscribe = loadExecutor().subscribeCommandRuns((summary) => {
        watcher.pending.set(summary.id, summary);
        if (!watcher.timer) watcher.timer = setTimeout(flush, RUN_NOTIFY_INTERVAL_MS);
    });
    runWatchers.set(sender, watcher);
    trackSender(sender);
}

function trackSender(sender) {
    if (trackedSenders.has(sender)) return;
    trackedSenders.add(sender);
    // 刷新页面或关闭窗口都会让渲染端丢失 xterm，镜像必须一并取消，否则主进程会一直往已销毁的页面推数据
    const release = () => {
        detachViewsOf(sender);
        stopRunWatcher(sender);
    };
    sender.on('destroyed', release);
    sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) release();
    });
}

function getOwnedView(event, id) {
    const view = typeof id === 'string' ? views.get(id) : null;
    if (!view || view.sender !== event.sender) return null;
    return view;
}

function resolveWorkspacePath(workspaceId) {
    if (typeof workspaceId !== 'string' || !workspaceId) throw new Error('工作区参数无效。');
    const ws = (workspaceServiceRef?.list() || []).find((item) => item.id === workspaceId);
    if (!ws) throw new Error('工作区不存在，可能已被移除。');
    if (!ws.enabled) throw new Error(`工作区 "${ws.alias}" 已停用。`);
    if (!fs.existsSync(ws.path)) throw new Error(`工作区目录不存在: ${ws.path}`);
    return ws.path;
}

// 终端窗口用的是 PowerShell（Windows）/ bash（其它平台）
function buildChangeDirectoryCommand(dir) {
    if (process.platform === 'win32') return `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'\r`;
    return `cd '${dir.replace(/'/g, "'\\''")}'\r`;
}

function createView(event, options = {}) {
    if (views.size >= MAX_VIEWS) {
        throw new Error(`终端视图数量已达上限（${MAX_VIEWS}），请先关闭不用的终端。`);
    }
    const opts = options && typeof options === 'object' ? options : {};
    const executor = loadExecutor();
    // 先定尺寸再启动：PowerShell 的首屏按 PTY 当时的宽度排版，事后再改会留下错位的提示符
    if (opts.cols !== undefined || opts.rows !== undefined) {
        const current = executor.getSessionState();
        executor.resizeSession(
            clampInt(opts.cols, MIN_COLS, MAX_COLS, current.cols),
            clampInt(opts.rows, MIN_ROWS, MAX_ROWS, current.rows),
        );
    }
    const state = executor.ensureMirrorSession();

    const sender = event.sender;
    const id = `term-${Date.now().toString(36)}-${(sequence += 1)}`;
    // 挂载时会回放已有输出；渲染端要拿到 create 的返回值才认得这个 id，所以先攒着，返回之后再一并发出
    const pending = [];
    let released = false;
    const emit = (channel, payload) => (released ? safeSend(sender, channel, payload) : pending.push([channel, payload]));
    const detach = executor.attachMirror({
        onData: (data) => emit('terminal:data', { id, data }),
        onClear: () => emit('terminal:clear', { id }),
        onExit: (exitCode) => emit('terminal:exit', { id, exitCode: exitCode ?? null }),
    });
    setImmediate(() => {
        released = true;
        for (const [channel, payload] of pending.splice(0)) safeSend(sender, channel, payload);
    });
    views.set(id, { id, sender, detach });
    trackSender(sender);

    return { id, pid: state.pid, shared: true };
}

function initialize({ workspaceService = null, executorLoader = null, mainWindow = null, getMainWindow: getWindow = null } = {}) {
    getMainWindow = typeof getWindow === 'function' ? getWindow : () => mainWindow;
    workspaceServiceRef = workspaceService;
    if (typeof executorLoader === 'function') loadExecutor = executorLoader;
    CHANNELS.forEach((channel) => ipcMain.removeHandler(channel));

    const denied = { success: false, error: '当前窗口无权使用终端。' };
    const missing = { success: false, error: '终端视图不存在或已关闭。' };
    const failure = (error) => ({ success: false, error: error?.message || String(error) });

    ipcMain.handle('terminal:create', (event, options) => {
        if (!isAllowedSender(event)) return denied;
        try {
            return { success: true, data: createView(event, options) };
        } catch (error) {
            return failure(error);
        }
    });

    ipcMain.handle('terminal:write', (event, id, data) => {
        if (!isAllowedSender(event)) return denied;
        if (!getOwnedView(event, id)) return missing;
        if (typeof data !== 'string' || data.length > MAX_WRITE_CHARS) return { success: false, error: '输入内容无效。' };
        try {
            return loadExecutor().writeSessionInput(data)
                ? { success: true }
                : { success: false, error: '终端会话已结束，请重新启动。' };
        } catch (error) {
            return failure(error);
        }
    });

    ipcMain.handle('terminal:resize', (event, id, cols, rows) => {
        if (!isAllowedSender(event)) return denied;
        if (!getOwnedView(event, id)) return missing;
        try {
            loadExecutor().resizeSession(clampInt(cols, MIN_COLS, MAX_COLS, 80), clampInt(rows, MIN_ROWS, MAX_ROWS, 24));
            return { success: true };
        } catch (error) {
            return failure(error);
        }
    });

    // 仅关闭这个侧栏视图；终端会话本身属于 VCPChat 的终端，继续保留
    ipcMain.handle('terminal:kill', (event, id) => {
        if (!isAllowedSender(event)) return denied;
        detachView(getOwnedView(event, id));
        return { success: true };
    });

    ipcMain.handle('terminal:restart', (event, id) => {
        if (!isAllowedSender(event)) return denied;
        if (!getOwnedView(event, id)) return missing;
        try {
            const state = loadExecutor().restartSession();
            return { success: true, data: { pid: state.pid } };
        } catch (error) {
            return failure(error);
        }
    });

    // AI 命令运行记录：「命令输出」侧栏标签与状态面板的终端章节读取这里
    ipcMain.handle('terminal:command-runs', (event) => {
        if (!isAllowedSender(event)) return denied;
        try {
            return { success: true, data: loadExecutor().listCommandRuns() };
        } catch (error) {
            return failure(error);
        }
    });

    ipcMain.handle('terminal:command-run', (event, id, options) => {
        if (!isAllowedSender(event)) return denied;
        if (typeof id !== 'string' || !id) return { success: false, error: '命令记录参数无效。' };
        try {
            const run = loadExecutor().getCommandRun(id, { maxChars: options?.maxChars });
            return run ? { success: true, data: run } : { success: false, error: '这条命令记录已被清理。' };
        } catch (error) {
            return failure(error);
        }
    });

    ipcMain.handle('terminal:watch-command-runs', (event) => {
        if (!isAllowedSender(event)) return denied;
        try {
            startRunWatcher(event.sender);
            return { success: true };
        } catch (error) {
            return failure(error);
        }
    });

    ipcMain.handle('terminal:cd', (event, id, workspaceId) => {
        if (!isAllowedSender(event)) return denied;
        if (!getOwnedView(event, id)) return missing;
        try {
            const dir = resolveWorkspacePath(workspaceId);
            const executor = loadExecutor();
            const state = executor.getSessionState();
            if (!state.running) return { success: false, error: '终端会话已结束，请先重新启动。' };
            if (state.busy) return { success: false, error: '终端正在执行命令，请等它结束后再切换目录。' };
            executor.writeSessionInput(buildChangeDirectoryCommand(dir));
            return { success: true, data: { cwd: dir } };
        } catch (error) {
            return failure(error);
        }
    });
}

function disposeAll() {
    for (const view of [...views.values()]) detachView(view);
    for (const sender of [...runWatchers.keys()]) stopRunWatcher(sender);
}

module.exports = { initialize, disposeAll };
