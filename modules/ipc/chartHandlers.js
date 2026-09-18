'use strict';

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { ChartService } = require('../services/chartService');
const { ChartDataSourceService } = require('../services/chartDataSourceService');
const windowService = require('../services/windowService');
const WINDOW_APP_IDS = require('../services/windowAppIds');
const { PRELOAD_ROLES, resolveProjectPreload } = require('../services/preloadPaths');

let chartService = null;
let chartDataSourceService = null;
let workbenchWindow = null;
let projectRoot = null;
let openChildWindows = null;
let initialSelection = null;
let serviceChangeListener = null;

const previewWindows = new Set();
const floatingWindows = new Map();
const selectionByWebContents = new Map();
const runtimeStateByWebContents = new Map();
const stableWaiters = new Map();
const diagnosticsWaiters = new Map();

function removeChildWindow(win) {
    if (!win || !Array.isArray(openChildWindows)) return;
    const index = openChildWindows.indexOf(win);
    if (index >= 0) openChildWindows.splice(index, 1);
}

function senderIsKnown(sender) {
    if (!sender || sender.isDestroyed()) return false;
    if (workbenchWindow && !workbenchWindow.isDestroyed() && workbenchWindow.webContents.id === sender.id) {
        return true;
    }
    return [...previewWindows, ...floatingWindows.values()].some(win =>
        !win.isDestroyed() && win.webContents.id === sender.id
    );
}

function safeSend(win, channel, payload) {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload);
    }
}

async function getChartSnapshot(chartId) {
    const sources = await chartService.readSources(chartId);
    return {
        manifest: sources.manifest,
        template: sources.template,
        style: sources.style,
        runtime: sources.runtime,
        data: sources.data,
    };
}

function clearWaitersForWebContents(webContentsId, error = null) {
    const waiters = stableWaiters.get(webContentsId) || [];
    stableWaiters.delete(webContentsId);
    for (const waiter of waiters) {
        clearTimeout(waiter.timeoutId);
        if (error) waiter.reject(error);
        else waiter.resolve(null);
    }

    for (const [requestId, waiter] of diagnosticsWaiters) {
        if (waiter.webContentsId !== webContentsId) continue;
        diagnosticsWaiters.delete(requestId);
        clearTimeout(waiter.timeoutId);
        if (error) waiter.reject(error);
        else waiter.resolve(null);
    }
}

function attachWindowCleanup(win, { preview = false } = {}) {
    const webContentsId = win.webContents.id;
    win.webContents.once('destroyed', () => {
        selectionByWebContents.delete(webContentsId);
        runtimeStateByWebContents.delete(webContentsId);
        clearWaitersForWebContents(
            webContentsId,
            new Error('图表渲染窗口已销毁。')
        );
    });
    win.once('closed', () => {
        if (preview) previewWindows.delete(win);
        removeChildWindow(win);
        if (win === workbenchWindow) workbenchWindow = null;
    });
}

function createChartBrowserWindow(options = {}) {
    const preview = options.preview === true;
    const floating = options.floating === true;
    const targetDisplay = screen.getPrimaryDisplay();
    const workArea = targetDisplay?.workArea || { x: 0, y: 0, width: 1280, height: 800 };
    const width = Math.round(Math.min(1920, Math.max(640, Number(options.width) || 1100)));
    const height = Math.round(Math.min(1200, Math.max(420, Number(options.height) || 720)));
    const win = new BrowserWindow({
        width,
        height,
        minWidth: preview || floating ? 360 : 760,
        minHeight: preview || floating ? 280 : 480,
        title: preview ? 'VCP 图表预览' : floating ? 'VCP 悬浮图表' : 'VCP 图表工作台',
        alwaysOnTop: floating,
        frame: false,
        show: false,
        skipTaskbar: preview,
        focusable: !preview,
        x: preview ? workArea.x + workArea.width + 80 : undefined,
        y: preview ? workArea.y + 40 : undefined,
        backgroundColor: '#091017',
        webPreferences: {
            preload: resolveProjectPreload(projectRoot, PRELOAD_ROLES.CHART),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            devTools: !preview,
            backgroundThrottling: false,
        },
        icon: path.join(projectRoot, 'assets', 'icon.png'),
    });
    win.setMenu(null);
    if (preview) previewWindows.add(win);
    else if (Array.isArray(openChildWindows)) openChildWindows.push(win);
    attachWindowCleanup(win, { preview });
    return win;
}

async function loadChartWindow(win, chartId = null) {
    const webContentsId = win.webContents.id;
    if (chartId) selectionByWebContents.set(webContentsId, chartId);
    const floating = floatingWindows.get(chartId) === win;
    await win.loadFile(path.join(projectRoot, 'Chartmodules', 'chart.html'), {
        query: { mode: floating ? 'floating' : previewWindows.has(win) ? 'preview' : 'workbench' },
    });
    return win;
}

async function openWorkbench(chartId = null, options = {}) {
    if (chartId) {
        await chartService.readManifest(chartId);
        initialSelection = chartId;
    }

    if (workbenchWindow && !workbenchWindow.isDestroyed()) {
        if (chartId) {
            selectionByWebContents.set(workbenchWindow.webContents.id, chartId);
            safeSend(workbenchWindow, 'chart:select', chartId);
        }
        if (!workbenchWindow.isVisible()) workbenchWindow.show();
        if (workbenchWindow.isMinimized()) workbenchWindow.restore();
        if (options.focus !== false) workbenchWindow.focus();
        return workbenchWindow;
    }

    workbenchWindow = createChartBrowserWindow({
        width: options.width,
        height: options.height,
    });
    if (chartId) selectionByWebContents.set(workbenchWindow.webContents.id, chartId);
    windowService.attachWindow(WINDOW_APP_IDS.CHART, workbenchWindow);
    workbenchWindow.once('ready-to-show', () => {
        if (!workbenchWindow || workbenchWindow.isDestroyed()) return;
        workbenchWindow.show();
        if (options.focus !== false) workbenchWindow.focus();
    });
    await loadChartWindow(workbenchWindow, chartId);
    return workbenchWindow;
}

function broadcastFloatingState() {
    safeSend(workbenchWindow, 'chart:floating-changed', [...floatingWindows.keys()]);
}

async function openFloatingChart(chartId) {
    await chartService.readManifest(chartId);
    let win = floatingWindows.get(chartId);
    if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        return;
    }
    win = createChartBrowserWindow({ floating: true, width: 720, height: 520 });
    floatingWindows.set(chartId, win);
    win.once('closed', () => {
        if (floatingWindows.get(chartId) === win) floatingWindows.delete(chartId);
        broadcastFloatingState();
    });
    win.webContents.once('render-process-gone', () => {
        if (!win.isDestroyed()) win.destroy();
    });
    broadcastFloatingState();
    try {
        await loadChartWindow(win, chartId);
        if (!win.isDestroyed()) win.show();
    } catch (error) {
        if (!win.isDestroyed()) win.destroy();
        throw error;
    }
}

async function closeSelectedChart(chartId) {
    const floating = floatingWindows.get(chartId);
    if (floating && !floating.isDestroyed()) floating.destroy();
    if (!workbenchWindow || workbenchWindow.isDestroyed()) return;
    const selected = selectionByWebContents.get(workbenchWindow.webContents.id);
    if (selected !== chartId) return;
    selectionByWebContents.delete(workbenchWindow.webContents.id);
    safeSend(workbenchWindow, 'chart:select', null);
}

function waitForStable(win, chartId, options = {}) {
    const webContentsId = win.webContents.id;
    const expectedCodeRevision = Number(options.codeRevision || 0);
    const expectedDataRevision = Number(options.dataRevision || 0);
    const current = runtimeStateByWebContents.get(webContentsId);
    if (
        current?.chartId === chartId
        && current.status === 'stable'
        && (!expectedCodeRevision || current.codeRevision === expectedCodeRevision)
        && (!expectedDataRevision || current.dataRevision === expectedDataRevision)
    ) {
        return Promise.resolve(current);
    }

    return new Promise((resolve, reject) => {
        const timeoutMs = Math.min(20000, Math.max(500, Number(options.timeoutMs) || 7000));
        const waiter = {
            chartId,
            expectedCodeRevision,
            expectedDataRevision,
            resolve,
            reject,
            timeoutId: null,
        };
        waiter.timeoutId = setTimeout(() => {
            const waiters = stableWaiters.get(webContentsId) || [];
            stableWaiters.set(webContentsId, waiters.filter(item => item !== waiter));
            const latest = runtimeStateByWebContents.get(webContentsId);
            resolve({
                ...(latest || {}),
                chartId,
                status: latest?.status || 'timeout',
                stable: false,
                warning: 'stable-timeout',
            });
        }, timeoutMs);
        const waiters = stableWaiters.get(webContentsId) || [];
        waiters.push(waiter);
        stableWaiters.set(webContentsId, waiters);
    });
}

function settleStableWaiters(webContentsId, state) {
    const waiters = stableWaiters.get(webContentsId) || [];
    const pending = [];
    for (const waiter of waiters) {
        const revisionMatches = (
            (!waiter.expectedCodeRevision || state.codeRevision === waiter.expectedCodeRevision)
            && (!waiter.expectedDataRevision || state.dataRevision === waiter.expectedDataRevision)
        );
        if (
            state.chartId === waiter.chartId
            && state.status === 'stable'
            && revisionMatches
        ) {
            clearTimeout(waiter.timeoutId);
            waiter.resolve({ ...state, stable: true });
        } else {
            pending.push(waiter);
        }
    }
    if (pending.length) stableWaiters.set(webContentsId, pending);
    else stableWaiters.delete(webContentsId);
}

async function requestDiagnostics(win, chartId, timeoutMs = 1500) {
    const requestId = `chart-diagnostics-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise(resolve => {
        const waiter = {
            webContentsId: win.webContents.id,
            resolve,
            timeoutId: setTimeout(() => {
                diagnosticsWaiters.delete(requestId);
                resolve(runtimeStateByWebContents.get(win.webContents.id)?.diagnostics || null);
            }, timeoutMs),
        };
        diagnosticsWaiters.set(requestId, waiter);
        safeSend(win, 'chart:request-diagnostics', { chartId, requestId });
    });
}

async function getStageCaptureRect(win) {
    return win.webContents.executeJavaScript(`(() => {
        const frame = document.getElementById('chartFrame');
        if (!frame || frame.hidden) return null;
        const rect = frame.getBoundingClientRect();
        return {
            x: Math.max(0, Math.round(rect.x)),
            y: Math.max(0, Math.round(rect.y)),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height))
        };
    })()`, true);
}

async function captureWindow(win, options = {}) {
    const rect = options.region && typeof options.region === 'object'
        ? {
            x: Math.max(0, Math.round(Number(options.region.x) || 0)),
            y: Math.max(0, Math.round(Number(options.region.y) || 0)),
            width: Math.max(1, Math.round(Number(options.region.width) || 1)),
            height: Math.max(1, Math.round(Number(options.region.height) || 1)),
        }
        : await getStageCaptureRect(win);

    if (!rect) throw new Error('图表展示区当前不可用。');
    const image = await win.webContents.capturePage(rect);
    const format = String(options.format || 'png').toLowerCase() === 'jpeg' ? 'jpeg' : 'png';
    const buffer = format === 'jpeg'
        ? image.toJPEG(Math.min(100, Math.max(1, Number(options.quality) || 85)))
        : image.toPNG();
    return {
        dataUrl: `data:image/${format};base64,${buffer.toString('base64')}`,
        format,
        byteLength: buffer.length,
        captureRect: rect,
        outputSize: image.getSize(),
    };
}

async function createPreviewWindow(chartId, options = {}) {
    const width = Math.min(1920, Math.max(320, Number(options.width) || 800));
    const height = Math.min(1200, Math.max(240, Number(options.height) || 500));
    // Account for the 48px title bar, 54px stage toolbar and stage margins so
    // the requested dimensions approximately describe the rendered chart area.
    const win = createChartBrowserWindow({
        preview: true,
        width: width + 20,
        height: height + 122,
    });
    selectionByWebContents.set(win.webContents.id, chartId);
    await loadChartWindow(win, chartId);
    // Chromium can skip compositor frames for a never-shown window on some
    // GPU drivers. Showing it outside the work area preserves real rendering
    // without disturbing the user's current workspace.
    win.showInactive();
    return win;
}

async function observeChart(chartId, options = {}) {
    const manifest = await chartService.readManifest(chartId);
    const mode = String(options.mode || 'preview').toLowerCase();
    let win;
    let temporary = false;

    if (mode === 'current') {
        win = floatingWindows.get(chartId);
        if (!win || win.isDestroyed()) {
            win = await openWorkbench(chartId, { focus: options.focus !== false });
        } else if (options.focus !== false) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
        }
    } else {
        temporary = true;
        win = await createPreviewWindow(chartId, options);
    }

    try {
        const stableState = await waitForStable(win, chartId, {
            timeoutMs: options.timeoutMs,
            codeRevision: manifest.codeRevision,
            dataRevision: manifest.dataRevision,
        });
        const diagnostics = stableState?.diagnostics
            || await requestDiagnostics(win, chartId);
        const capture = await captureWindow(win, options);
        const warnings = [
            ...(diagnostics?.warnings || []),
            ...(!stableState?.stable ? [{
                code: 'STABLE_TIMEOUT',
                message: '图表未在等待期限内主动或自动报告稳定。',
            }] : []),
        ];
        return {
            content: [
                {
                    type: 'text',
                    text: [
                        `# 图表观察：${manifest.name} (${manifest.id})`,
                        '',
                        `- 模式：${temporary ? '隔离预览' : '当前工作台'}`,
                        `- 尺寸：${capture.outputSize.width}×${capture.outputSize.height}`,
                        `- 代码版本：${manifest.codeRevision}`,
                        `- 数据版本：${manifest.dataRevision}`,
                        `- 渲染状态：${stableState?.stable ? 'stable' : stableState?.status || 'unknown'}`,
                        `- 诊断警告：${warnings.length}`,
                    ].join('\n'),
                },
                {
                    type: 'image_url',
                    image_url: { url: capture.dataUrl },
                },
            ],
            details: {
                command: 'ObserveChart',
                chartId: manifest.id,
                mode: temporary ? 'preview' : 'current',
                stable: stableState?.stable === true,
                runtimeStatus: stableState?.status || 'unknown',
                codeRevision: manifest.codeRevision,
                dataRevision: manifest.dataRevision,
                capturedAt: new Date().toISOString(),
                captureRect: capture.captureRect,
                outputSize: capture.outputSize,
                format: capture.format,
                byteLength: capture.byteLength,
                diagnostics,
                warnings,
            },
        };
    } finally {
        if (temporary && win && !win.isDestroyed()) win.destroy();
    }
}

function broadcastChange(change) {
    if (change?.type === 'deleted') {
        const win = floatingWindows.get(change.chartId);
        if (win && !win.isDestroyed()) win.destroy();
    }
    for (const win of floatingWindows.values()) safeSend(win, 'chart:changed', change);
    safeSend(workbenchWindow, 'chart:changed', change);
    for (const win of previewWindows) safeSend(win, 'chart:changed', change);
}

function registerIpcHandlers() {
    [
        'chart:floating-state',
        'chart:detach',
        'chart:dock',
        'chart:focus-floating',
        'chart:toggle-pin',
        'chart:list',
        'chart:get-snapshot',
        'chart:get-initial-selection',
        'chart:read-data-source',
        'chart:delete',
        'chart:open-in-canvas',
    ].forEach(channel => ipcMain.removeHandler(channel));

    const authorize = event => {
        if (!senderIsKnown(event.sender)) throw new Error('未授权的图表窗口请求。');
    };
    ipcMain.handle('chart:floating-state', event => {
        authorize(event);
        return [...floatingWindows.keys()];
    });
    ipcMain.handle('chart:detach', async (event, chartId) => {
        authorize(event);
        if (event.sender.id !== workbenchWindow?.webContents.id) {
            throw new Error('只能从工作台分离图表。');
        }
        await openFloatingChart(String(chartId || ''));
    });
    ipcMain.handle('chart:focus-floating', (event, chartId) => {
        authorize(event);
        const win = floatingWindows.get(chartId);
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    });
    ipcMain.handle('chart:dock', async (event, chartId) => {
        authorize(event);
        const win = floatingWindows.get(chartId);
        if (event.sender.id !== workbenchWindow?.webContents.id
            && event.sender.id !== win?.webContents.id) throw new Error('图表窗口不匹配。');
        // Destroy the old renderer before allowing the workbench to mount.
        if (win && !win.isDestroyed()) win.destroy();
        await openWorkbench(chartId);
    });
    ipcMain.handle('chart:toggle-pin', event => {
        authorize(event);
        const win = [...floatingWindows.values()].find(item => item.webContents.id === event.sender.id);
        if (!win) throw new Error('当前窗口不是悬浮图表。');
        win.setAlwaysOnTop(!win.isAlwaysOnTop());
        return win.isAlwaysOnTop();
    });

    ipcMain.handle('chart:list', event => {
        if (!senderIsKnown(event.sender)) throw new Error('未授权的图表列表请求。');
        return chartService.listCharts();
    });
    ipcMain.handle('chart:get-snapshot', (event, chartId) => {
        if (!senderIsKnown(event.sender)) throw new Error('未授权的图表快照请求。');
        selectionByWebContents.set(event.sender.id, chartId);
        return getChartSnapshot(chartId);
    });
    ipcMain.handle('chart:get-initial-selection', event => {
        if (!senderIsKnown(event.sender)) return null;
        return selectionByWebContents.get(event.sender.id) || initialSelection || null;
    });
    ipcMain.handle('chart:delete', async (event, request = {}) => {
        if (!senderIsKnown(event.sender)) throw new Error('未授权的图表删除请求。');
        const chartId = String(request.chartId || '');
        return chartService.deleteChart(chartId, {
            expectedRevision: request.expectedRevision,
        }, {
            vcpContext: {
                agentId: 'chart-workbench-user',
                topicId: null,
            },
        });
    });
    ipcMain.handle('chart:open-in-canvas', async (event, request = {}) => {
        if (!senderIsKnown(event.sender)) throw new Error('未授权的图表编辑请求。');
        const chartId = String(request.chartId || '');
        const manifest = await chartService.readManifest(chartId);
        const rootDir = chartService.chartDir(manifest.id);
        const canvasHandlers = require('./canvasHandlers');
        await canvasHandlers.createCanvasWindow({
            filePath: path.join(rootDir, 'runtime.js'),
            rootDir,
            context: 'chart',
            metadata: {
                chartId: manifest.id,
                chartName: manifest.name,
                revision: manifest.revision,
                codeRevision: manifest.codeRevision,
            },
        });
        return { success: true, chartId: manifest.id };
    });
    ipcMain.handle('chart:read-data-source', async (event, request = {}) => {
        if (!senderIsKnown(event.sender)) {
            throw new Error('未授权的图表数据源请求。');
        }
        const selectedChartId = selectionByWebContents.get(event.sender.id);
        const requestedChartId = String(request.chartId || '');
        if (!selectedChartId || requestedChartId !== selectedChartId) {
            throw new Error('图表数据源请求与当前运行实例不匹配。');
        }
        // ChartDataSourceService 只实现读取协议；忽略 renderer 提交的任何
        // operation/method 字段，避免运行时代码把该桥转换成通用文件能力。
        return chartDataSourceService.read({
            type: request.type,
            source: request.source,
            path: request.path,
            url: request.url,
            sql: request.sql,
            params: request.params,
            headers: request.headers,
            timeoutMs: request.timeoutMs,
            encoding: request.encoding,
            delimiter: request.delimiter,
            header: request.header,
        });
    });

    [
        'chart:runtime-status',
        'chart:runtime-error',
        'chart:runtime-event',
        'chart:diagnostics',
    ].forEach(channel => ipcMain.removeAllListeners(channel));

    ipcMain.on('chart:runtime-status', async (event, payload = {}) => {
        if (!senderIsKnown(event.sender)) return;
        const chartId = String(payload.chartId || '');
        let manifest = null;
        try {
            manifest = chartId ? await chartService.readManifest(chartId) : null;
        } catch (_error) {
            // A deleted chart may still report its final destroyed state.
        }
        const state = {
            ...payload,
            chartId,
            stable: payload.status === 'stable' || payload.stable === true,
            codeRevision: manifest?.codeRevision || payload.codeRevision || null,
            dataRevision: manifest?.dataRevision || payload.dataRevision || null,
            updatedAt: new Date().toISOString(),
        };
        runtimeStateByWebContents.set(event.sender.id, state);
        settleStableWaiters(event.sender.id, state);
    });

    ipcMain.on('chart:runtime-error', (event, payload = {}) => {
        if (!senderIsKnown(event.sender)) return;
        const previous = runtimeStateByWebContents.get(event.sender.id) || {};
        runtimeStateByWebContents.set(event.sender.id, {
            ...previous,
            ...payload,
            status: 'error',
            stable: false,
            updatedAt: new Date().toISOString(),
        });
    });

    ipcMain.on('chart:runtime-event', (event, payload = {}) => {
        if (!senderIsKnown(event.sender)) return;
        chartService.emit('runtime-event', {
            ...payload,
            emittedAt: new Date().toISOString(),
        });
    });

    ipcMain.on('chart:diagnostics', (event, payload = {}) => {
        if (!senderIsKnown(event.sender)) return;
        const waiter = diagnosticsWaiters.get(payload.requestId);
        if (!waiter || waiter.webContentsId !== event.sender.id) return;
        diagnosticsWaiters.delete(payload.requestId);
        clearTimeout(waiter.timeoutId);
        waiter.resolve(payload.diagnostics || null);
    });
}

async function initialize(options = {}) {
    projectRoot = options.projectRoot || path.join(__dirname, '..', '..');
    openChildWindows = options.openChildWindows || [];
    chartService = options.chartService || new ChartService({
        appDataRoot: options.appDataRoot,
        logger: options.logger || console,
    });
    chartDataSourceService = options.chartDataSourceService
        || new ChartDataSourceService({ logger: options.logger || console });
    await chartService.initialize();
    chartService.setDataSourceAdapter(chartDataSourceService);
    chartService.setWindowAdapter({
        open: (chartId, openOptions) => openWorkbench(chartId, openOptions),
        close: chartId => closeSelectedChart(chartId),
        observe: (chartId, observeOptions) => observeChart(chartId, observeOptions),
        isOpen: chartId => floatingWindows.has(chartId) || Boolean(
            workbenchWindow
            && !workbenchWindow.isDestroyed()
            && selectionByWebContents.get(workbenchWindow.webContents.id) === chartId
        ),
        getRuntimeStatus: async chartId => {
            const win = floatingWindows.get(chartId) || workbenchWindow;
            if (!win || win.isDestroyed()) return { status: 'closed' };
            const state = runtimeStateByWebContents.get(win.webContents.id);
            return state?.chartId === chartId ? state : { status: 'not-selected' };
        },
        shutdown: async () => {
            for (const win of floatingWindows.values()) {
                if (!win.isDestroyed()) win.destroy();
            }
            floatingWindows.clear();
            for (const win of previewWindows) {
                if (!win.isDestroyed()) win.destroy();
            }
            previewWindows.clear();
            if (workbenchWindow && !workbenchWindow.isDestroyed()) workbenchWindow.destroy();
            workbenchWindow = null;
        },
    });

    serviceChangeListener = change => broadcastChange(change);
    chartService.on('change', serviceChangeListener);
    registerIpcHandlers();

    windowService.register(WINDOW_APP_IDS.CHART, {
        owner: 'chartHandlers',
        getWindow: () => workbenchWindow,
        open: options => openWorkbench(options?.chartId || null, options),
        readyTimeoutMs: 10000,
    });

    ipcMain.removeHandler('open-chart-window');
    ipcMain.handle('open-chart-window', (_event, request = {}) => (
        openWorkbench(request?.chartId || null)
            .then(() => ({ success: true, chartId: request?.chartId || null }))
            .catch(error => ({ success: false, error: error.message }))
    ));

    return chartService;
}

async function shutdown() {
    if (chartService && serviceChangeListener) {
        chartService.off('change', serviceChangeListener);
    }
    serviceChangeListener = null;
    await chartService?.shutdown?.();
    chartService = null;
    chartDataSourceService = null;
}

module.exports = {
    initialize,
    shutdown,
    openWorkbench,
    observeChart,
    getChartService: () => chartService,
    getChartWindow: () => workbenchWindow,
    _test: {
        getChartSnapshot,
        captureWindow,
        waitForStable,
    },
};