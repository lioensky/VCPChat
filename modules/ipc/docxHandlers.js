'use strict';

const { BrowserWindow, ipcMain, app, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { execFile } = require('child_process');
const windowService = require('../services/windowService');
const WINDOW_APP_IDS = require('../services/windowAppIds');
const { PRELOAD_ROLES, resolveAppPreload } = require('../services/preloadPaths');
const scriptoriumImportService = require('../services/scriptoriumImportService');

const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
const PROJECT_EXTENSIONS = new Set(['.vdocx', '.vpptx']);
const EXPORT_FORMATS = new Set(['html-flow', 'html-paged', 'pdf']);
const IMPORT_EXTENSIONS = new Set(scriptoriumImportService.SUPPORTED_EXTENSIONS);
const OPEN_EXTENSIONS = new Set([...PROJECT_EXTENSIONS, ...IMPORT_EXTENSIONS]);
const RECENT_LIMIT = 12;
const AGENT_REQUEST_TIMEOUT_MS = 30000;
const AGENT_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;
const AGENT_ENDPOINT_METHODS = Object.freeze({
    common: new Set([
        'getDocumentInfo', 'getRenderedText', 'getOutline', 'getSource',
        'searchSource', 'getViewportSource', 'getVisualContext', 'getPrHistory',
        'submitSourcePr', 'buildProjectArtifact',
    ]),
    docx: new Set([
        'getDocumentInfo', 'getRenderedText', 'getOutline', 'getSource',
        'searchSource', 'getViewportSource', 'getVisualContext', 'getPrHistory',
        'submitSourcePr', 'buildProjectArtifact', 'getFullText', 'getSection',
    ]),
    pptx: new Set([
        'getDocumentInfo', 'getRenderedText', 'getOutline', 'getSource',
        'searchSource', 'getViewportSource', 'getVisualContext', 'getPrHistory',
        'submitSourcePr', 'buildProjectArtifact', 'getSlideCount', 'getSlide',
        'getActiveSlide', 'selectSlide', 'addSlide', 'insertSlide', 'deleteSlide',
    ]),
});
const AGENT_MUTATION_METHODS = new Set([
    'submitSourcePr', 'addSlide', 'insertSlide', 'deleteSlide',
]);

let docxWindow = null;
let mainWindow = null;
let openChildWindows = [];
let projectRoot = null;
let recentFilePath = null;
let initialized = false;
let fontCache = null;
const pendingAgentRequests = new Map();

function normalizeAgentAuthor(author) {
    if (typeof author === 'string' && author.trim()) {
        return { id: author.trim(), name: author.trim(), type: 'agent' };
    }
    if (!author || typeof author !== 'object') return null;
    const name = String(author.name || author.signature || author.id || '').trim();
    if (!name) return null;
    return {
        id: String(author.id || name),
        name,
        type: author.type === 'human' ? 'human' : 'agent',
    };
}

function validateAgentRequest(request = {}) {
    const endpoint = String(request.endpoint || '');
    const method = String(request.method || '');
    if (!AGENT_ENDPOINT_METHODS[endpoint]?.has(method)) {
        throw new Error(`不允许的 Scriptorium Agent 接口：${endpoint}.${method}`);
    }
    const payload = request.payload && typeof request.payload === 'object'
        ? { ...request.payload }
        : {};
    if (AGENT_MUTATION_METHODS.has(method)) {
        const author = normalizeAgentAuthor(payload.author || request.author);
        if (!author) throw new Error('Agent PR 必须提供署名字段 author。');
        const summary = String(payload.summary || request.summary || '').trim();
        if (!summary) throw new Error('Agent PR 必须提供摘要字段 summary。');
        payload.author = author;
        payload.summary = summary;
        payload.requestId = String(payload.requestId || request.requestId || '');
        if (!payload.requestId) throw new Error('Agent 写操作必须提供幂等键 requestId。');
    }
    return {
        requestId: String(request.requestId || payload.requestId
            || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
        endpoint,
        method,
        payload,
    };
}

function requestAgentOperation(request = {}) {
    const validated = validateAgentRequest(request);
    if (!docxWindow || docxWindow.isDestroyed()) {
        return Promise.reject(new Error('Scriptorium 窗口尚未打开。'));
    }
    if (pendingAgentRequests.has(validated.requestId)) {
        return pendingAgentRequests.get(validated.requestId).promise;
    }

    let resolveRequest;
    let rejectRequest;
    const promise = new Promise((resolve, reject) => {
        resolveRequest = resolve;
        rejectRequest = reject;
    });
    const waitsForReview = AGENT_MUTATION_METHODS.has(validated.method);
    const timeoutMs = waitsForReview
        ? AGENT_REVIEW_TIMEOUT_MS
        : AGENT_REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => {
        pendingAgentRequests.delete(validated.requestId);
        if (waitsForReview) {
            resolveRequest({
                success: false,
                code: 'PR_RECEIPT_TIMEOUT',
                message: '窗口编辑提案已成功提交并继续保留，但等待人类审批回执超时。人类之后仍可在 Scriptorium 右侧栏选择合并或拒绝。',
                submitted: true,
                pending: true,
                requestId: validated.requestId,
                method: validated.method,
                timeoutMs,
            });
            return;
        }
        rejectRequest(new Error('Scriptorium Agent 请求超时。'));
    }, timeoutMs);
    pendingAgentRequests.set(validated.requestId, {
        promise,
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
        method: validated.method,
        waitsForReview,
        webContentsId: docxWindow.webContents.id,
    });
    docxWindow.webContents.send('scriptorium:agent-request', validated);
    return promise;
}

function handleAgentResponse(event, payload = {}) {
    const requestId = String(payload.requestId || '');
    const pending = pendingAgentRequests.get(requestId);
    if (!pending || event.sender.id !== pending.webContentsId) return;
    clearTimeout(pending.timer);
    pendingAgentRequests.delete(requestId);
    if (payload.error) {
        const error = new Error(String(payload.error.message || 'Agent 请求失败。'));
        error.code = payload.error.code;
        pending.reject(error);
    } else {
        pending.resolve(payload.result);
    }
}

function removeChildWindow(win) {
    const index = openChildWindows.indexOf(win);
    if (index >= 0) openChildWindows.splice(index, 1);
}

function assertDocumentPath(filePath, options = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
        throw new Error('缺少文档文件路径。');
    }
    const resolved = path.resolve(filePath);
    const extension = path.extname(resolved).toLowerCase();
    const allowed = options.forSave ? PROJECT_EXTENSIONS.has(extension) : OPEN_EXTENSIONS.has(extension);
    if (!allowed) {
        throw new Error(options.forSave
            ? 'VCP 富文档工程必须保存为 .vdocx 或 .vpptx。'
            : '仅支持 VDOCX、VPPTX、HTML、Markdown、TXT、RTF、DOCX 或 PPTX。');
    }
    return resolved;
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
    // Word 使用的字体来源不只 System.Drawing/GDI。用户安装字体、部分
    // OpenType/可变字体通常只会出现在 DirectWrite(WPF) 或 HKCU 注册表中。
    // 合并三类来源，并使用 Base64(UTF-8) 穿过 Windows PowerShell 5 的
    // 非 UTF-8 stdout，避免中日韩及其他 Unicode 字体族名损坏。
    const script = [
        '$ErrorActionPreference = "SilentlyContinue";',
        '$utf8 = New-Object System.Text.UTF8Encoding($false);',
        '$names = New-Object "System.Collections.Generic.HashSet[string]" ([StringComparer]::OrdinalIgnoreCase);',
        'try {',
        '  Add-Type -AssemblyName PresentationCore;',
        '  [System.Windows.Media.Fonts]::SystemFontFamilies | ForEach-Object {',
        '    $localized = $_.FamilyNames[[System.Globalization.CultureInfo]::CurrentUICulture];',
        '    if (-not $localized) { $localized = $_.Source };',
        '    if ($localized) { [void]$names.Add([string]$localized) }',
        '  }',
        '} catch {}',
        'try {',
        '  Add-Type -AssemblyName System.Drawing;',
        '  $gdiFonts = New-Object System.Drawing.Text.InstalledFontCollection;',
        '  $gdiFonts.Families | ForEach-Object { if ($_.Name) { [void]$names.Add($_.Name) } }',
        '} catch {}',
        '$registryRoots = @(',
        '  "Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",',
        '  "Registry::HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"',
        ');',
        'foreach ($registryRoot in $registryRoots) {',
        '  try {',
        '    $properties = Get-ItemProperty -LiteralPath $registryRoot;',
        '    $properties.PSObject.Properties | Where-Object { $_.Name -notmatch "^PS" } | ForEach-Object {',
        '      $fontName = $_.Name -replace "\\s+\\((?:TrueType|OpenType|Variable)\\)\\s*$", "";',
        '      if ($fontName) { [void]$names.Add($fontName.Trim()) }',
        '    }',
        '  } catch {}',
        '}',
        '$names | Sort-Object | ForEach-Object {',
        '  [Convert]::ToBase64String($utf8.GetBytes($_))',
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
        console.warn('[Scriptorium] System font enumeration failed:', error.message);
    }

    // Windows 枚举结果必须保持真实：不要追加可能并未安装的字体。
    // Scriptorium 直接将该列表用于中日韩 CSS 字体栈与缺字回退诊断。
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
        console.warn('[Scriptorium] Failed to read recent documents:', error.message);
        return [];
    }
}

async function rememberRecentFile(filePath) {
    const resolved = assertDocumentPath(filePath);
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
    const resolved = assertDocumentPath(filePath);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error('目标不是有效文件。');
    if (stat.size > MAX_DOCUMENT_BYTES) throw new Error('文档超过 100 MB 安全上限。');

    const bytes = await fs.readFile(resolved);
    await rememberRecentFile(resolved);
    const extension = path.extname(resolved).toLowerCase();

    if (PROJECT_EXTENSIONS.has(extension)) {
        return {
            success: true,
            filePath: resolved,
            name: path.basename(resolved),
            kind: extension === '.vpptx' ? 'vpptx' : 'vdocx',
            bytes: Uint8Array.from(bytes),
            size: stat.size,
            modifiedAt: stat.mtimeMs,
        };
    }

    const imported = await scriptoriumImportService.importBuffer(resolved, bytes);
    return {
        success: true,
        filePath: resolved,
        name: path.basename(resolved),
        kind: 'imported',
        importedKind: imported.kind,
        html: imported.html,
        slides: imported.slides,
        page: imported.page,
        importMetadata: imported.importMetadata,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
    };
}

async function chooseAndReadDocument(event) {
    const owner = BrowserWindow.fromWebContents(event.sender) || docxWindow || mainWindow;
    const result = await dialog.showOpenDialog(owner, {
        title: '打开 VCP 富文档工程',
        properties: ['openFile'],
        filters: [
            { name: 'VCP 富文档工程', extensions: ['vdocx', 'vpptx'] },
        ],
    });
    if (result.canceled || !result.filePaths.length) {
        return { success: false, canceled: true };
    }
    return readDocument(result.filePaths[0]);
}

async function chooseAndImportDocument(event) {
    const owner = BrowserWindow.fromWebContents(event.sender) || docxWindow || mainWindow;
    const result = await dialog.showOpenDialog(owner, {
        title: '导入为 VDOCX 文稿',
        properties: ['openFile'],
        filters: [
            {
                name: '所有可导入文档',
                extensions: ['html', 'htm', 'md', 'markdown', 'txt', 'rtf', 'docx', 'pptx'],
            },
            { name: 'Markdown 文稿', extensions: ['md', 'markdown'] },
            { name: '纯文本', extensions: ['txt'] },
            { name: '富文本 RTF', extensions: ['rtf'] },
            { name: 'Word 文档（语义导入）', extensions: ['docx'] },
            { name: 'PowerPoint 演示（静态版式导入）', extensions: ['pptx'] },
            { name: 'HTML 文档', extensions: ['html', 'htm'] },
        ],
    });
    if (result.canceled || !result.filePaths.length) {
        return { success: false, canceled: true };
    }
    return readDocument(result.filePaths[0]);
}

async function atomicWrite(filePath, bytes) {
    const resolved = assertDocumentPath(filePath, { forSave: true });
    const data = Buffer.from(bytes || []);
    if (!data.length) throw new Error('拒绝保存空文档。');
    if (data.length > MAX_DOCUMENT_BYTES) throw new Error('文档超过 100 MB 安全上限。');

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
    const requestedExtension = path.extname(targetPath || payload.suggestedName || '').toLowerCase();
    const projectExtension = requestedExtension === '.vpptx' ? '.vpptx' : '.vdocx';
    if (!targetPath || payload.saveAs) {
        const owner = BrowserWindow.fromWebContents(event.sender) || docxWindow || mainWindow;
        const isDeck = projectExtension === '.vpptx';
        const result = await dialog.showSaveDialog(owner, {
            title: payload.saveAs
                ? `${projectExtension.toUpperCase()} 另存为`
                : `保存 ${projectExtension.toUpperCase()} 工程`,
            defaultPath: targetPath
                || payload.suggestedName
                || (isDeck ? '未命名演示.vpptx' : '未命名文稿.vdocx'),
            filters: [{
                name: isDeck ? 'VPPTX 演示工程' : 'VDOCX 共笔工程',
                extensions: [projectExtension.slice(1)],
            }],
        });
        if (result.canceled || !result.filePath) {
            return { success: false, canceled: true };
        }
        targetPath = result.filePath.toLowerCase().endsWith(projectExtension)
            ? result.filePath
            : `${result.filePath}${projectExtension}`;
    }
    return atomicWrite(targetPath, payload.bytes);
}

async function atomicWriteExport(filePath, data) {
    const resolved = path.resolve(filePath);
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
    if (!bytes.length) throw new Error('拒绝导出空文档。');
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('导出文档超过 100 MB 安全上限。');
    await fs.ensureDir(path.dirname(resolved));
    const temporaryPath = `${resolved}.vcp-exporting-${process.pid}-${Date.now()}`;
    try {
        await fs.writeFile(temporaryPath, bytes);
        await fs.move(temporaryPath, resolved, { overwrite: true });
    } finally {
        await fs.remove(temporaryPath).catch(() => {});
    }
    const stat = await fs.stat(resolved);
    return {
        success: true,
        filePath: resolved,
        name: path.basename(resolved),
        size: stat.size,
        modifiedAt: stat.mtimeMs,
    };
}

async function waitForExportLayout(win) {
    await win.webContents.executeJavaScript(`(async () => {
        await document.fonts?.ready;
        await Promise.all([...document.images].map((image) => {
            if (image.complete) return image.decode?.().catch(() => {});
            return new Promise((resolve) => {
                image.addEventListener('load', resolve, { once: true });
                image.addEventListener('error', resolve, { once: true });
            });
        }));
        document.documentElement.dataset.vdocPdf = 'true';
        await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
    })()`);
}

async function exportRichDocument(event, payload = {}) {
    const format = String(payload.format || '');
    if (!EXPORT_FORMATS.has(format)) throw new Error('不支持的富文档导出格式。');
    const html = String(payload.html || '');
    if (!html.trim()) throw new Error('拒绝导出空文档。');
    if (Buffer.byteLength(html, 'utf8') > MAX_DOCUMENT_BYTES) {
        throw new Error('导出文档超过 100 MB 安全上限。');
    }

    const owner = BrowserWindow.fromWebContents(event.sender) || docxWindow || mainWindow;
    const isPdf = format === 'pdf';
    const extension = isPdf ? '.pdf' : '.html';
    const suggestedName = String(payload.suggestedName || `Scriptorium${extension}`)
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
    const result = await dialog.showSaveDialog(owner, {
        title: isPdf ? '导出分页 PDF' : '导出富文档 HTML',
        defaultPath: suggestedName.toLowerCase().endsWith(extension)
            ? suggestedName
            : `${suggestedName}${extension}`,
        filters: [{
            name: isPdf ? 'PDF 文档' : 'HTML 富文档',
            extensions: [extension.slice(1)],
        }],
    });
    if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
    }
    const targetPath = result.filePath.toLowerCase().endsWith(extension)
        ? result.filePath
        : `${result.filePath}${extension}`;

    if (!isPdf) return atomicWriteExport(targetPath, html);

    const temporaryHtmlPath = path.join(
        app.getPath('temp'),
        `vcp-scriptorium-export-${process.pid}-${Date.now()}.html`
    );
    const exportWindow = new BrowserWindow({
        show: false,
        width: 1200,
        height: 900,
        backgroundColor: '#ffffff',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            javascript: true,
            webSecurity: true,
        },
    });
    try {
        await fs.writeFile(temporaryHtmlPath, html, 'utf8');
        await exportWindow.loadFile(temporaryHtmlPath);
        await waitForExportLayout(exportWindow);
        const pdf = await exportWindow.webContents.printToPDF({
            printBackground: true,
            preferCSSPageSize: true,
            displayHeaderFooter: false,
            margins: {
                marginType: 'none',
            },
        });
        return await atomicWriteExport(targetPath, pdf);
    } finally {
        if (!exportWindow.isDestroyed()) exportWindow.destroy();
        await fs.remove(temporaryHtmlPath).catch(() => {});
    }
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
        pendingAgentRequests.forEach((pending) => {
            clearTimeout(pending.timer);
            pending.reject(new Error('Scriptorium 窗口已关闭。'));
        });
        pendingAgentRequests.clear();
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
    recentFilePath = path.join(params.appDataRoot, 'Scriptorium', 'recent.json');

    windowService.register(WINDOW_APP_IDS.DOCX, {
        owner: 'docxHandlers',
        getWindow: () => docxWindow,
        open: openDocxWindow,
        readyTimeoutMs: 20000,
    });

    ipcMain.handle('open-docx-window', (_event, options = {}) => openDocxWindow(options));
    ipcMain.handle('scriptorium:agent-call', (_event, request = {}) =>
        requestAgentOperation(request));
    ipcMain.on('scriptorium:agent-response', handleAgentResponse);
    ipcMain.handle('docx:choose-open', chooseAndReadDocument);
    ipcMain.handle('scriptorium:choose-import', chooseAndImportDocument);
    ipcMain.handle('docx:read-path', (_event, filePath) => readDocument(filePath));
    ipcMain.handle('docx:save', saveDocument);
    ipcMain.handle('scriptorium:export-rich-document', exportRichDocument);
    ipcMain.handle('docx:recent-list', readRecentFiles);
    ipcMain.handle('docx:fonts-list', (_event, forceRefresh = false) => getSystemFonts(forceRefresh));
}

module.exports = {
    initialize,
    openDocxWindow,
    requestAgentOperation,
    writeProjectArtifact: (filePath, serialized) =>
        atomicWrite(filePath, Buffer.from(String(serialized || ''), 'utf8')),
    getDocxWindow: () => docxWindow,
    getSystemFonts,
};