// modules/ipc/minerUHandlers.js
// MinerU 论文工作台的 IPC 桥：
// - 只接受 MinerUmodules/mineru.html 顶层窗口的调用；
// - 解析/查重通过 VCPToolBox/Plugin/MinerUParser 的 Rust 二进制执行；
// - 进度由主进程轮询 state.json 后推送到工作台窗口。
'use strict';

const { ipcMain: defaultIpcMain, BrowserWindow, dialog, shell, app } = require('electron');
const path = require('path');
const service = require('../services/minerU/minerUService');
const protocolService = require('../services/minerU/minerUProtocol');
const { createApplicationSenderGuard } = require('./applicationSender');

const MINERU_PAGE = 'MinerUmodules/mineru.html';
const PAGES = [MINERU_PAGE];
const CHANNELS = [
    'mineru:status',
    'mineru:save-config',
    'mineru:pick-toolbox-root',
    'mineru:scan',
    'mineru:get-paper',
    'mineru:read-pdf',
    'mineru:pick-pdfs',
    'mineru:pick-folder',
    'mineru:pick-pdf-for-paper',
    'mineru:clear-pdf-mapping',
    'mineru:preflight',
    'mineru:parse',
    'mineru:continue',
    'mineru:cancel-job',
    'mineru:list-jobs',
    'mineru:duplicates',
    'mineru:reveal',
    'mineru:reveal-asset',
    'mineru:open-pdf',
    'mineru:open-dir',
    'mineru:open-external',
];

let ipc = defaultIpcMain;
let initialized = false;
let disposers = [];
const isAllowedSender = createApplicationSenderGuard({ pages: PAGES });

function senderWindow(event) {
    return BrowserWindow.fromWebContents(event?.sender) || null;
}

function sendToWorkbench(channel, payload) {
    for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
        try {
            if (win.webContents.getURL().includes(MINERU_PAGE)) {
                win.webContents.send(channel, payload);
            }
        } catch {
            // 窗口正在销毁
        }
    }
}

function wrap(fn) {
    return async (event, ...args) => {
        if (!isAllowedSender(event)) {
            return { success: false, error: '当前窗口无权调用 MinerU 工作台接口。' };
        }
        try {
            return { success: true, data: await fn(event, ...args) };
        } catch (error) {
            return { success: false, error: error?.message || String(error) };
        }
    };
}

function handle(channel, fn) {
    ipc.handle(channel, wrap(fn));
}

async function pickPdfFiles(event) {
    const win = senderWindow(event);
    const result = await dialog.showOpenDialog(win || undefined, {
        title: '选择 PDF 文件',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    return result.canceled ? [] : result.filePaths;
}

async function pickFolder(event) {
    const win = senderWindow(event);
    const result = await dialog.showOpenDialog(win || undefined, {
        title: '选择包含 PDF 的文件夹',
        properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] || null;
}

function registerChannels() {
    handle('mineru:status', () => service.getStatus());
    handle('mineru:save-config', (_event, patch) => {
        const saved = service.saveConfig(patch || {});
        return { config: saved, status: service.getStatus() };
    });
    handle('mineru:pick-toolbox-root', async event => {
        const win = senderWindow(event);
        const result = await dialog.showOpenDialog(win || undefined, {
            title: '选择 VCPToolBox 根目录（包含 Plugin/MinerUParser）',
            properties: ['openDirectory'],
        });
        if (result.canceled || !result.filePaths[0]) return null;
        const saved = service.saveConfig({ toolboxRoot: result.filePaths[0] });
        return { config: saved, status: service.getStatus() };
    });

    handle('mineru:scan', () => service.scanLibrary(true));
    handle('mineru:get-paper', (_event, paperId) => service.getPaperDetail(paperId));
    handle('mineru:read-pdf', (_event, paperId) => service.readPdf(paperId));

    handle('mineru:pick-pdfs', event => pickPdfFiles(event));
    handle('mineru:pick-folder', event => pickFolder(event));
    handle('mineru:pick-pdf-for-paper', async (event, paperId) => {
        const win = senderWindow(event);
        const result = await dialog.showOpenDialog(win || undefined, {
            title: '为该论文关联本地 PDF',
            properties: ['openFile'],
            filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });
        if (result.canceled || !result.filePaths[0]) return null;
        return service.setPdfMapping(paperId, result.filePaths[0]);
    });
    handle('mineru:clear-pdf-mapping', (_event, paperId) => service.clearPdfMapping(paperId));

    handle('mineru:preflight', (_event, payload) => service.preflight(
        payload?.paths || [],
        { recursive: payload?.recursive !== false },
    ));
    handle('mineru:parse', (_event, payload) => service.startParse(
        payload?.items || [],
        payload?.options || {},
    ));
    handle('mineru:continue', (_event, paperIds) => service.continuePapers(paperIds));
    handle('mineru:cancel-job', (_event, jobId) => service.cancelJob(jobId));
    handle('mineru:list-jobs', () => service.listJobs());
    handle('mineru:duplicates', (_event, options) => service.findDuplicates(options || {}));

    handle('mineru:reveal', (_event, paperId) => {
        const record = service.getRecord(paperId);
        if (!record) throw new Error('未找到论文。');
        shell.showItemInFolder(record.fileDir);
        return true;
    });
    handle('mineru:reveal-asset', (_event, paperId, assetDir) => {
        const dir = service.resolveAssetDir(paperId, assetDir);
        shell.showItemInFolder(dir);
        return true;
    });
    handle('mineru:open-pdf', async (_event, paperId) => {
        const record = service.getRecord(paperId);
        if (!record?.pdfPath) throw new Error('该论文还没有关联本地 PDF。');
        const error = await shell.openPath(record.pdfPath);
        if (error) throw new Error(error);
        return true;
    });
    handle('mineru:open-dir', async (_event, paperId) => {
        const record = service.getRecord(paperId);
        if (!record) throw new Error('未找到论文。');
        const error = await shell.openPath(record.fileDir);
        if (error) throw new Error(error);
        return true;
    });
    handle('mineru:open-external', async (_event, url) => {
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
            throw new Error('只允许打开 http(s) 链接。');
        }
        await shell.openExternal(url);
        return true;
    });
}

function initialize(options = {}) {
    if (initialized) return service.getStatus();
    initialized = true;
    ipc = options.ipcMain || defaultIpcMain;
    service.initialize({
        appDataRoot: options.appDataRoot,
        projectRoot: options.projectRoot || path.resolve(__dirname, '..', '..'),
    });
    protocolService.install(options);
    registerChannels();
    disposers = [
        service.on('job', payload => sendToWorkbench('mineru:job', payload)),
        service.on('library-changed', payload => sendToWorkbench('mineru:library-changed', payload)),
    ];
    app.once('will-quit', () => {
        service.cancelAll();
        for (const dispose of disposers) dispose();
        disposers = [];
    });
    return service.getStatus();
}

function registerScheme(protocol) {
    protocolService.registerScheme(protocol);
}

function dispose() {
    for (const disposeListener of disposers) disposeListener();
    disposers = [];
    service.cancelAll();
}

module.exports = {
    CHANNELS,
    MINERU_PAGE,
    initialize,
    registerScheme,
    dispose,
};
