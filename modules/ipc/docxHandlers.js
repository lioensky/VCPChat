'use strict';

const { BrowserWindow, ipcMain, app, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { execFile } = require('child_process');
const windowService = require('../services/windowService');
const WINDOW_APP_IDS = require('../services/windowAppIds');
const { PRELOAD_ROLES, resolveAppPreload } = require('../services/preloadPaths');

const MAX_DOCX_BYTES = 100 * 1024 * 1024;
const RECENT_LIMIT = 12;

let docxWindow = null;
let mainWindow = null;
let openChildWindows = [];
let projectRoot = null;
let recentFilePath = null;
let initialized = false;
let fontCache = null;

function removeChildWindow(win) {
    const index = openChildWindows.indexOf(win);
    if (index >= 0) openChildWindows.splice(index, 1);
}

function assertDocxPath(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
        throw new Error('缺少 DOCX 文件路径。');
    }
    if (path.extname(filePath).toLowerCase() !== '.docx') {
        throw new Error('仅支持 .docx 文档。');
    }
    return path.resolve(filePath);
}

function runFile(executable, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(executable, args, {
            windowsHide: true,
            timeout: 15000,
            maxBuffer: 8 * 1024 * 1024,
            encoding: 'utf8',
            ...options,
        }, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout || '');
        });
    });
}

function normalizeFontNames(values) {
    const ignored = /^[@.]/;
    return [...new Set(values
        .map((value) => String(value || '').replace(/\s+\([^)]*\)$/g, '').trim())
        .filter((value) => value && !ignored.test(value))
    )].sort((a, b) => a.localeCompare(b, 'zh-CN', { sensitivity: 'base', numeric: true }));
}

async function listWindowsFonts() {
    // Windows PowerShell 5 的原生 stdout 编码取决于系统代码页，直接按 UTF-8
    // 读取会损坏中文、日文、韩文及其他 Unicode 字体族名。逐项转换为
    // Base64(UTF-8) 后只经过 ASCII stdout，再由 Node 明确解码，可无损支持
    // 任意用户安装的第三方多语言字体。
    const script = [
        'Add-Type -AssemblyName System.Drawing;',
        '$utf8 = New-Object System.Text.UTF8Encoding($false);',
        '$fonts = New-Object System.Drawing.Text.InstalledFontCollection;',
        '$fonts.Families | ForEach-Object {',
        '  [Convert]::ToBase64String($utf8.GetBytes($_.Name))',
        '}',
    ].join(' ');
    const output = await runFile('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command', script,
    ]);
    return output
        .split(/\r?\n/)
        .map((encoded) => encoded.trim())
        .filter(Boolean)
        .map((encoded) => {
            try {
                return Buffer.from(encoded, 'base64').toString('utf8');
            } catch {
                return '';
            }
        })
        .filter(Boolean);
}

async function listUnixFonts() {
    const output = await runFile('fc-list', [':', 'family']);
    return output
        .split(/\r?\n/)
        .flatMap((line) => line.split(','))
        .map((name) => name.trim());
}

async function listMacFonts() {
    try {
        return await listUnixFonts();
    } catch {
        const roots = [
            '/System/Library/Fonts',
            '/Library/Fonts',
            path.join(app.getPath('home'), 'Library', 'Fonts'),
        ];
        const names = [];
        for (const root of roots) {
            if (!await fs.pathExists(root)) continue;
            const entries = await fs.readdir(root);
            names.push(...entries.map((name) => path.basename(name, path.extname(name))));
        }
        return names;
    }
}

async function getSystemFonts(forceRefresh = false) {
    if (fontCache && !forceRefresh) return fontCache;

    let discovered = [];
    try {
        if (process.platform === 'win32') discovered = await listWindowsFonts();
        else if (process.platform === 'darwin') discovered = await listMacFonts();
        else discovered = await listUnixFonts();
    } catch (error) {
        console.warn('[DocxEditor] System font enumeration failed:', error.message);
    }

    // Windows 枚举结果必须保持真实：不要追加可能并未安装的字体，否则渲染器
    // 会把虚构的“可用字体”交给 SuperDoc，最终得到缺字方框。仅在系统枚举
    // 完全失败时提供最小安全列表。
    fontCache = normalizeFontNames(discovered.length ? discovered : [
        'Arial',
        'Calibri',
        'Cambria',
        'Consolas',
        'Courier New',
        'Georgia',
        'Times New Roman',
    ]);
    return fontCache;
}

async function readRecentFiles() {
    try {
        if (!recentFilePath || !await fs.pathExists(recentFilePath)) return [];
        const stored = await fs.readJson(recentFilePath);
        if (!Array.isArray(stored)) return [];
        const existing = [];
        for (const item of stored) {
            if (item?.path && await fs.pathExists(item.path)) existing.push(item);
        }
        return existing.slice(0, RECENT_LIMIT);
    } catch (error) {
        console.warn('[DocxEditor] Failed to read recent documents:', error.message);
        return [];
    }
}

async function rememberRecentFile(filePath) {
    const resolved = assertDocxPath(filePath);
    const current = await readRecentFiles();
    const next = [
        { path: resolved, name: path.basename(resolved), openedAt: Date.now() },
        ...current.filter((item) => path.resolve(item.path) !== resolved),
    ].slice(0, RECENT_LIMIT);
    await fs.ensureDir(path.dirname(recentFilePath));
    await fs.writeJson(recentFilePath, next, { spaces: 2 });
    return next;
}

async function readDocument(filePath) {
    const resolved = assertDocxPath(filePath);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error('目标不是有效文件。');
    if (stat.size > MAX_DOCX_BYTES) throw new Error('文档超过 100 MB 安全上限。');

    const bytes = await fs.readFile(resolved);
    await rememberRecentFile(resolved);
    return {
        success: true,
        filePath: resolved,
        name: path.basename(resolved),
        bytes: Uint8Array.from(bytes),
        size: stat.size,
        modifiedAt: stat.mtimeMs,
    };
}

async function chooseAndReadDocument(event) {
    const owner = BrowserWindow.fromWebContents(event.sender) || docxWindow || mainWindow;
    const result = await dialog.showOpenDialog(owner, {
        title: '打开 DOCX 文档',
        properties: ['openFile'],
        filters: [
            { name: 'Word 文档', extensions: ['docx'] },
        ],
    });
    if (result.canceled || !result.filePaths.length) {
        return { success: false, canceled: true };
    }
    return readDocument(result.filePaths[0]);
}

async function atomicWrite(filePath, bytes) {
    const resolved = assertDocxPath(filePath);
    const data = Buffer.from(bytes || []);
    if (!data.length) throw new Error('拒绝保存空文档。');
    if (data.length > MAX_DOCX_BYTES) throw new Error('文档超过 100 MB 安全上限。');

    await fs.ensureDir(path.dirname(resolved));
    const temporaryPath = `${resolved}.vcp-writing-${process.pid}-${Date.now()}`;
    try {
        await fs.writeFile(temporaryPath, data);
        await fs.move(temporaryPath, resolved, { overwrite: true });
    } finally {
        await fs.remove(temporaryPath).catch(() => {});
    }

    const stat = await fs.stat(resolved);
    await rememberRecentFile(resolved);
    return {
        success: true,
        filePath: resolved,
        name: path.basename(resolved),
        size: stat.size,
        modifiedAt: stat.mtimeMs,
    };
}

async function saveDocument(event, payload = {}) {
    let targetPath = payload.filePath;
    if (!targetPath || payload.saveAs) {
        const owner = BrowserWindow.fromWebContents(event.sender) || docxWindow || mainWindow;
        const result = await dialog.showSaveDialog(owner, {
            title: payload.saveAs ? '文档另存为' : '保存 DOCX 文档',
            defaultPath: targetPath || payload.suggestedName || '未命名文档.docx',
            filters: [{ name: 'Word 文档', extensions: ['docx'] }],
        });
        if (result.canceled || !result.filePath) {
            return { success: false, canceled: true };
        }
        targetPath = result.filePath.toLowerCase().endsWith('.docx')
            ? result.filePath
            : `${result.filePath}.docx`;
    }
    return atomicWrite(targetPath, payload.bytes);
}

function focusWindow(win) {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    return win;
}

async function openDocxWindow(options = {}) {
    if (docxWindow && !docxWindow.isDestroyed()) {
        focusWindow(docxWindow);
        if (options.filePath) {
            docxWindow.webContents.send('docx:open-path-request', options.filePath);
        }
        return docxWindow;
    }

    docxWindow = new BrowserWindow({
        width: 1480,
        height: 940,
        minWidth: 980,
        minHeight: 680,
        frame: false,
        ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
        backgroundColor: '#171A1D',
        show: false,
        title: 'VCP Scriptorium · 共笔文坊',
        icon: path.join(projectRoot, 'assets', 'icon.png'),
        webPreferences: {
            preload: resolveAppPreload(app.getAppPath(), PRELOAD_ROLES.DOCX),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            spellcheck: true,
            devTools: true,
        },
    });

    openChildWindows.push(docxWindow);
    windowService.attachWindow(WINDOW_APP_IDS.DOCX, docxWindow);

    docxWindow.once('ready-to-show', () => {
        if (!docxWindow || docxWindow.isDestroyed()) return;
        docxWindow.show();
        if (options.filePath) {
            docxWindow.webContents.send('docx:open-path-request', options.filePath);
        }
    });

    await docxWindow.loadFile(path.join(projectRoot, 'ScriptoriumModules', 'scriptorium.html'));

    docxWindow.on('closed', () => {
        removeChildWindow(docxWindow);
        docxWindow = null;
    });

    return docxWindow;
}

function initialize(params) {
    if (initialized) return;
    initialized = true;
    mainWindow = params.mainWindow;
    openChildWindows = params.openChildWindows || [];
    projectRoot = params.projectRoot;
    recentFilePath = path.join(params.appDataRoot, 'DocxEditor', 'recent.json');

    windowService.register(WINDOW_APP_IDS.DOCX, {
        owner: 'docxHandlers',
        getWindow: () => docxWindow,
        open: openDocxWindow,
        readyTimeoutMs: 20000,
    });

    ipcMain.handle('open-docx-window', (_event, options = {}) => openDocxWindow(options));
    ipcMain.handle('docx:choose-open', chooseAndReadDocument);
    ipcMain.handle('docx:read-path', (_event, filePath) => readDocument(filePath));
    ipcMain.handle('docx:save', saveDocument);
    ipcMain.handle('docx:recent-list', readRecentFiles);
    ipcMain.handle('docx:fonts-list', (_event, forceRefresh = false) => getSystemFonts(forceRefresh));
}

module.exports = {
    initialize,
    openDocxWindow,
    getDocxWindow: () => docxWindow,
    getSystemFonts,
};