// modules/ipc/terminalHandlers.js
// 侧栏「终端」标签的主进程桥。它不自带 shell，而是把 VCPChat 自带的终端（PowerShellExecutor 插件的 PTY 会话，
// 即托盘「终端」与 AI 工具 PowerShellExecutor 共用的那一个）镜像到主窗口侧栏：
// - 输出同时送往终端窗口和侧栏；侧栏里的输入 / 调整大小直接落到同一个 PTY。
// - 仅放行主窗口页面（与 Git / 源码侧栏同样按调用页面 URL 校验）。
// - 会话归属于创建镜像的 webContents：页面销毁 / 刷新时只取消镜像，不结束终端会话（它可能正被 AI 使用）。
// - 「跳转到工作区」只接收 workspaceId，路径由主进程按工作区列表解析。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ipcMain: defaultIpcMain } = require('electron');
const { createApplicationSenderGuard, resolveWindowWebContents } = require('./applicationSender');
const { onSenderGone } = require('./senderLifetime');
// initialize 可以传入领域激活器给的 ipcMain（见 domainActivator.js），不传就用 Electron 的
let ipcMain = defaultIpcMain;
let getMainWindow = () => null;

const CHANNELS = [
    'terminal:create',
    'terminal:write',
    'terminal:resize',
    'terminal:clear-screen',
    'terminal:kill',
    'terminal:restart',
    'terminal:cd',
    'terminal:command-runs',
    'terminal:command-run',
    'terminal:watch-command-runs',
    'terminal:unwatch-command-runs',
];

const EXECUTOR_PATH = path.join(__dirname, '..', '..', 'VCPDistributedServer', 'Plugin', 'PowerShellExecutor', 'PowerShellExecutor.js');
// 命令运行记录单独成模块、加载无副作用：只读记录（状态面板、命令输出标签）不会把整个执行器拉起来
const COMMAND_RUN_STORE_PATH = path.join(__dirname, '..', '..', 'VCPDistributedServer', 'Plugin', 'PowerShellExecutor', 'commandRunStore.js');
const MAX_VIEWS = 8;
const MAX_WRITE_CHARS = 1024 * 1024;
const MIN_COLS = 2;
const MIN_ROWS = 1;
const MAX_COLS = 500;
const MAX_ROWS = 200;
const RUN_NOTIFY_INTERVAL_MS = 120;
// 刷屏时按帧合并成一次 IPC：每秒上千个小块各发一次，渲染端主线程会被消息排满。静默后的第一块不等（按键回显不加 16ms）
const DATA_FLUSH_MS = 16;
const DATA_FLUSH_CHARS = 64 * 1024;

let workspaceServiceRef = null;
let loadExecutor = () => require(EXECUTOR_PATH);
let loadCommandRuns = () => require(COMMAND_RUN_STORE_PATH);
let sequence = 0;
/** @type {Map<string, { id: string, sender: Electron.WebContents, detach: Function }>} */
const views = new Map();
const trackedSenders = new WeakMap(); // sender → 取消离开登记
/** @type {Map<Electron.WebContents, { refs: number, unsubscribe: Function, pending: Map<string, object>, timer: NodeJS.Timeout|null }>} */
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

// 同一页面里可能有几处各自 watch，按次数计：最后一次 unwatch 才真正停止推送
function startRunWatcher(sender) {
    const existing = runWatchers.get(sender);
    if (existing) {
        existing.refs += 1;
        return;
    }
    const watcher = { refs: 1, unsubscribe: () => {}, pending: new Map(), timer: null };
    const flush = () => {
        watcher.timer = null;
        for (const summary of watcher.pending.values()) safeSend(sender, 'terminal:command-run-changed', summary);
        watcher.pending.clear();
    };
    // 输出很碎，按运行记录合并后再通知，渲染端只需要知道「这条变了」
    watcher.unsubscribe = loadCommandRuns().subscribeCommandRuns((summary) => {
        watcher.pending.set(summary.id, summary);
        if (!watcher.timer) watcher.timer = setTimeout(flush, RUN_NOTIFY_INTERVAL_MS);
    });
    runWatchers.set(sender, watcher);
    trackSender(sender);
}

function releaseRunWatcher(sender) {
    const watcher = runWatchers.get(sender);
    if (!watcher) return;
    watcher.refs -= 1;
    if (watcher.refs <= 0) stopRunWatcher(sender);
}

function trackSender(sender) {
    if (trackedSenders.has(sender)) return;
    // 刷新页面或关闭窗口都会让渲染端丢失 xterm，镜像必须一并取消，否则主进程会一直往已销毁的页面推数据。
    // 离开登记是一次性的：触发后从表里删掉，页面重新创建镜像时再登记
    trackedSenders.set(sender, onSenderGone(sender, () => {
        trackedSenders.delete(sender);
        detachViewsOf(sender);
        stopRunWatcher(sender);
    }));
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

// 终端窗口用的是 PowerShell（Windows）/ bash（其它平台）。
// 带回车直接执行：AI 命令写进共享 PTY 前不清输入行，只打字不回车的话，留在输入行的跳转会和下一条 AI 命令拼成一行，
// 结束标记出不来，AI 那边要等到超时（Linux 实测 `cd '…'echo …` → too many arguments）。
// PowerShell 把 ‘ ’ ‚ ‛（U+2018–U+201B）也当单引号，只转义 ASCII ' 的话，带弯引号的目录名会提前结束字符串。
// 换行会直接提交半条命令，这种路径不往终端里写
function buildChangeDirectoryCommand(dir, platform = process.platform) {
    if (/[\r\n]/.test(dir)) throw new Error('工作区路径包含换行，无法在终端里切换。');
    if (platform === 'win32') return `Set-Location -LiteralPath '${dir.replace(/['\u2018-\u201B]/g, '$&$&')}'\r`;
    return `cd '${dir.replace(/'/g, "'\\''")}'\r`;
}

function createView(event, options = {}) {
    if (views.size >= MAX_VIEWS) {
        throw new Error(`终端视图数量已达上限（${MAX_VIEWS}），请先关闭不用的终端。`);
    }
    const opts = options && typeof options === 'object' ? options : {};
    const executor = loadExecutor();
    // 先定尺寸再启动：PowerShell 的首屏按 PTY 当时的宽度排版，事后再改会留下错位的提示符。
    // 会话已经在跑（终端窗口或另一个视图正用着）就不改：只有拿着焦点的视图才定尺寸
    const current = executor.getSessionState();
    if (!current.running && (opts.cols !== undefined || opts.rows !== undefined)) {
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
    let dataBuffer = '';
    let dataTimer = null;
    const dropData = () => {
        if (dataTimer) clearTimeout(dataTimer);
        dataTimer = null;
        dataBuffer = '';
    };
    const flushData = () => {
        const data = dataBuffer;
        dropData();
        if (data) emit('terminal:data', { id, data });
    };
    // 静默之后的第一块（按键回显）立刻发；之后一个窗口内到的块攒成一次，窗口结束时有积压就发出并再开一个窗口
    const endWindow = () => {
        dataTimer = null;
        if (!dataBuffer) return;
        const data = dataBuffer;
        dataBuffer = '';
        emit('terminal:data', { id, data });
        dataTimer = setTimeout(endWindow, DATA_FLUSH_MS);
    };
    const detachMirror = executor.attachMirror({
        onData: (data) => {
            if (!dataTimer) {
                emit('terminal:data', { id, data });
                dataTimer = setTimeout(endWindow, DATA_FLUSH_MS);
                return;
            }
            dataBuffer += data;
            if (dataBuffer.length >= DATA_FLUSH_CHARS) {
                const burst = dataBuffer;
                dataBuffer = '';
                emit('terminal:data', { id, data: burst });
            }
        },
        // 清屏之前攒着的输出反正要被清掉；退出前先把剩下的发完，顺序不乱
        onClear: () => { dropData(); emit('terminal:clear', { id }); },
        onExit: (exitCode) => { flushData(); emit('terminal:exit', { id, exitCode: exitCode ?? null }); },
        // PTY 尺寸变了（哪个视图改的都算）：不持有尺寸的视图据此跟着画；之前的输出按旧宽度排的，先发完
        onResize: (cols, rows) => { flushData(); emit('terminal:resized', { id, cols, rows }); },
    });
    const detach = () => {
        dropData();
        detachMirror();
    };
    setImmediate(() => {
        released = true;
        for (const [channel, payload] of pending.splice(0)) safeSend(sender, channel, payload);
    });
    views.set(id, { id, sender, detach });
    trackSender(sender);

    return { id, pid: state.pid, cols: state.cols, rows: state.rows, shared: true, windowsPty: windowsPtyInfo() };
}

/**
 * Windows 上 PTY 后端自己会按新宽度重排可见区，xterm 得知道这点，不然 resize 时两边各排一次，
 * 行会重复、提示符错位。node-pty 在 build 18309 起用 ConPTY。
 */
function windowsPtyInfo() {
    if (process.platform !== 'win32') return null;
    const buildNumber = Number(os.release().split('.')[2]) || undefined;
    return { backend: buildNumber && buildNumber < 18309 ? 'winpty' : 'conpty', ...(buildNumber ? { buildNumber } : {}) };
}

function initialize({ workspaceService = null, executorLoader = null, commandRunStoreLoader = null, mainWindow = null, getMainWindow: getWindow = null, ipcMain: injectedIpcMain = null } = {}) {
    ipcMain = injectedIpcMain || defaultIpcMain;
    getMainWindow = typeof getWindow === 'function' ? getWindow : () => mainWindow;
    workspaceServiceRef = workspaceService;
    if (typeof executorLoader === 'function') loadExecutor = executorLoader;
    if (typeof commandRunStoreLoader === 'function') loadCommandRuns = commandRunStoreLoader;
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

    // 侧栏清屏：shell 也清一次，之后改尺寸时 Windows 的 ConPTY 不会把旧内容重绘回来。
    // 会话被 AI 命令占着时 shellCleared 为 false，只清了视图
    ipcMain.handle('terminal:clear-screen', (event, id) => {
        if (!isAllowedSender(event)) return denied;
        if (!getOwnedView(event, id)) return missing;
        try {
            return { success: true, data: { shellCleared: loadExecutor().clearSessionScreen() } };
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
            return { success: true, data: loadCommandRuns().listCommandRuns() };
        } catch (error) {
            return failure(error);
        }
    });

    ipcMain.handle('terminal:command-run', (event, id, options) => {
        if (!isAllowedSender(event)) return denied;
        if (typeof id !== 'string' || !id) return { success: false, error: '命令记录参数无效。' };
        try {
            const run = loadCommandRuns().getCommandRun(id, { maxChars: options?.maxChars });
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

    // 渲染端的命令记录源没人用了（宽限期过后）就取消推送；只减自己页面的计数
    ipcMain.handle('terminal:unwatch-command-runs', (event) => {
        if (!isAllowedSender(event)) return denied;
        releaseRunWatcher(event.sender);
        return { success: true };
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

module.exports = { CHANNELS, initialize, disposeAll, buildChangeDirectoryCommand };
