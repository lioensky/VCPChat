'use strict';

const { BrowserWindow, ipcMain, app, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const http = require('http');
const https = require('https');
const { fileURLToPath } = require('url');
const { execFile } = require('child_process');
const windowService = require('../services/windowService');
const WINDOW_APP_IDS = require('../services/windowAppIds');
const { PRELOAD_ROLES, resolveAppPreload } = require('../services/preloadPaths');
const scriptoriumImportService = require('../services/scriptoriumImportService');
const {
    ScriptoriumFontCacheService,
} = require('../services/scriptoriumFontCacheService');

const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 80 * 1024 * 1024;
const RESOURCE_TIMEOUT_MS = 30000;
const MAX_RESOURCE_REDIRECTS = 5;
const PROJECT_EXTENSIONS = new Set(['.vdocx', '.vpptx']);
const EXPORT_FORMATS = new Set(['html-flow', 'html-paged', 'pdf']);
const IMPORT_EXTENSIONS = new Set(scriptoriumImportService.SUPPORTED_EXTENSIONS);
const OPEN_EXTENSIONS = new Set([...PROJECT_EXTENSIONS, ...IMPORT_EXTENSIONS]);
const LIBRARY_EXTENSIONS = new Set([
    '.vdocx', '.vpptx', '.docx', '.pptx', '.txt', '.html', '.md',
]);
const RECENT_LIMIT = 12;
const AGENT_REQUEST_TIMEOUT_MS = 30000;
const AGENT_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;
const AGENT_ENDPOINT_METHODS = Object.freeze({
    common: new Set([
        'getDocumentInfo', 'getRenderedText', 'getOutline', 'getSource',
        'searchSource', 'getViewportSource', 'getVisualContext', 'getPrHistory',
        'listStylePacks', 'getStylePack', 'upsertStylePack',
        'deleteStylePack', 'listSvgAssetPacks', 'listSvgAssets',
        'getSvgAsset', 'getSvgAssetPack', 'upsertSvgAssetPack',
        'deleteSvgAssetPack', 'submitSourcePr', 'buildProjectArtifact',
    ]),
    docx: new Set([
        'getDocumentInfo', 'getRenderedText', 'getOutline', 'getSource',
        'searchSource', 'getViewportSource', 'getVisualContext', 'getPrHistory',
        'listStylePacks', 'getStylePack', 'upsertStylePack',
        'deleteStylePack', 'listSvgAssetPacks', 'listSvgAssets',
        'getSvgAsset', 'getSvgAssetPack', 'upsertSvgAssetPack',
        'deleteSvgAssetPack', 'submitSourcePr', 'buildProjectArtifact',
        'getFullText', 'getSection',
    ]),
    pptx: new Set([
        'getDocumentInfo', 'getRenderedText', 'getOutline', 'getSource',
        'searchSource', 'getViewportSource', 'getVisualContext', 'getPrHistory',
        'listStylePacks', 'getStylePack', 'upsertStylePack',
        'deleteStylePack', 'listSvgAssetPacks', 'listSvgAssets',
        'getSvgAsset', 'getSvgAssetPack', 'upsertSvgAssetPack',
        'deleteSvgAssetPack', 'submitSourcePr', 'buildProjectArtifact',
        'getSlideCount', 'getSlide', 'getActiveSlide', 'selectSlide',
        'addSlide', 'insertSlide', 'deleteSlide',
        'updatePresentationConfig', 'updateSceneConfig',
    ]),
});
const AGENT_MUTATION_METHODS = new Set([
    'submitSourcePr', 'addSlide', 'insertSlide', 'deleteSlide',
    'updatePresentationConfig', 'updateSceneConfig',
]);
const AGENT_DIRECT_MUTATION_METHODS = new Set([
    'upsertStylePack', 'deleteStylePack',
    'upsertSvgAssetPack', 'deleteSvgAssetPack',
]);

let docxWindow = null;
let mainWindow = null;
let openChildWindows = [];
let projectRoot = null;
let recentFilePath = null;
let stylePackFilePath = null;
let svgAssetFilePath = null;
let documentLibraryRoots = [];
let initialized = false;
let fontCache = null;
let networkFontCache = null;
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
    } else if (AGENT_DIRECT_MUTATION_METHODS.has(method)) {
        const maid = normalizeAgentAuthor(
            payload.maid || payload.author || request.author
        );
        if (!maid) {
            throw new Error('Agent 样式包写操作必须提供 maid 署名字段。');
        }
        payload.maid = maid;
        payload.author = maid;
        payload.requestId = String(
            payload.requestId || request.requestId || ''
        );
        if (!payload.requestId) {
            throw new Error('Agent 样式包写操作必须提供幂等键 requestId。');
        }
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
        '    $inspectInternalNames = $registryRoot -like "*HKEY_CURRENT_USER*";',
        '    $properties = Get-ItemProperty -LiteralPath $registryRoot;',
        '    $properties.PSObject.Properties | Where-Object { $_.Name -notmatch "^PS" } | ForEach-Object {',
        '      $registryName = ($_.Name -replace "\\s+\\((?:TrueType|OpenType|Variable)\\)\\s*$", "").Trim();',
        '      $fontPath = [Environment]::ExpandEnvironmentVariables([string]$_.Value);',
        '      if ($fontPath -and -not [IO.Path]::IsPathRooted($fontPath)) {',
        '        $fontPath = Join-Path (Join-Path $env:WINDIR "Fonts") $fontPath;',
        '      }',
        '      $internalNamesFound = $false;',
        '      $shouldInspectFile = $inspectInternalNames -or $registryName -match "[^\\x00-\\x7F]";',
        '      if ($shouldInspectFile -and $fontPath -and [IO.File]::Exists($fontPath)) {',
        '        try {',
        '          $glyph = New-Object System.Windows.Media.GlyphTypeface ([Uri]$fontPath);',
        '          $aliases = New-Object "System.Collections.Generic.List[string]";',
        '          $preferredCultures = @(',
        '            [System.Globalization.CultureInfo]::CurrentUICulture,',
        '            [System.Globalization.CultureInfo]::GetCultureInfo("zh-CN"),',
        '            [System.Globalization.CultureInfo]::GetCultureInfo("en-US")',
        '          );',
        '          foreach ($culture in $preferredCultures) {',
        '            $familyName = ([string]$glyph.FamilyNames[$culture]).Trim();',
        '            if ($familyName -and -not $aliases.Contains($familyName)) {',
        '              $aliases.Add($familyName);',
        '            }',
        '          }',
        '          $glyph.FamilyNames.Values | ForEach-Object {',
        '            $familyName = ([string]$_).Trim();',
        '            if ($familyName -and -not $aliases.Contains($familyName)) {',
        '              $aliases.Add($familyName);',
        '            }',
        '          };',
        '          if ($aliases.Count) {',
        '            $cssStack = ($aliases | ForEach-Object {',
        '              [char]34 + $_.Replace([char]34, "\\" + [char]34) + [char]34',
        '            }) -join ", ";',
        '            [void]$names.Add($cssStack);',
        '            $internalNamesFound = $true;',
        '          }',
        '        } catch {}',
        '      }',
        // 注册表名称经常是 full name，例如“霞鹜文楷 Regular”，而 CSS
        // font-family 只接受内部 family“霞鹜文楷”。这里不能把 JavaScript
        // 注释写进 PowerShell 字符串：脚本最终拼成单行，# 会吞掉后续所有代码。
        '      if (-not $internalNamesFound -and $registryName) {',
        '        [void]$names.Add($registryName);',
        '      }',
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
    ], {
        // 首次读取 HKCU 第三方字体的 OpenType family 表会触发 WPF 字体缓存。
        // 不能沿用普通辅助命令的 15 秒限制，否则超时后只显示七个兜底字体。
        timeout: 60000,
    });
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

    if (discovered.length) {
        fontCache = normalizeFontNames(discovered);
        return fontCache;
    }

    // 只有本轮真实枚举失败时才使用最小兜底集；兜底结果仅保存在当前进程。
    fontCache = normalizeFontNames([
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

async function readStylePacks() {
    try {
        if (!stylePackFilePath || !await fs.pathExists(stylePackFilePath)) {
            return [];
        }
        const stored = await fs.readJson(stylePackFilePath);
        return Array.isArray(stored?.packs) ? stored.packs : [];
    } catch (error) {
        console.warn(
            '[Scriptorium] Failed to read style packs:',
            error.message
        );
        return [];
    }
}

async function writeStylePacks(_event, packs = []) {
    if (!Array.isArray(packs)) {
        throw new Error('高级样式包持久化内容必须是数组。');
    }
    const documentValue = {
        format: 'vcp-scriptorium-style-pack-storage',
        version: 1,
        updatedAt: new Date().toISOString(),
        packs,
    };
    const content = JSON.stringify(documentValue, null, 2);
    if (Buffer.byteLength(content, 'utf8') > 20 * 1024 * 1024) {
        throw new Error('高级样式库超过 20 MB 持久化上限。');
    }
    await fs.ensureDir(path.dirname(stylePackFilePath));
    const temporaryPath =
        `${stylePackFilePath}.writing-${process.pid}-${Date.now()}`;
    try {
        await fs.writeFile(temporaryPath, content, 'utf8');
        await fs.move(temporaryPath, stylePackFilePath, {
            overwrite: true,
        });
    } finally {
        await fs.remove(temporaryPath).catch(() => {});
    }
    return {
        success: true,
        count: packs.length,
        size: Buffer.byteLength(content, 'utf8'),
    };
}

async function readSvgAssetPacks() {
    try {
        if (!svgAssetFilePath || !await fs.pathExists(svgAssetFilePath)) {
            return [];
        }
        const stored = await fs.readJson(svgAssetFilePath);
        return Array.isArray(stored?.packs) ? stored.packs : [];
    } catch (error) {
        console.warn(
            '[Scriptorium] Failed to read SVG asset packs:',
            error.message
        );
        return [];
    }
}

async function writeSvgAssetPacks(_event, packs = []) {
    if (!Array.isArray(packs)) {
        throw new Error('SVG 资产持久化内容必须是数组。');
    }
    const documentValue = {
        format: 'vcp-scriptorium-svg-asset-storage',
        version: 1,
        updatedAt: new Date().toISOString(),
        packs,
    };
    const content = JSON.stringify(documentValue, null, 2);
    if (Buffer.byteLength(content, 'utf8') > 20 * 1024 * 1024) {
        throw new Error('SVG 资产库超过 20 MB 持久化上限。');
    }
    await fs.ensureDir(path.dirname(svgAssetFilePath));
    const temporaryPath =
        `${svgAssetFilePath}.writing-${process.pid}-${Date.now()}`;
    try {
        await fs.writeFile(temporaryPath, content, 'utf8');
        await fs.move(temporaryPath, svgAssetFilePath, {
            overwrite: true,
        });
    } finally {
        await fs.remove(temporaryPath).catch(() => {});
    }
    return {
        success: true,
        count: packs.length,
        size: Buffer.byteLength(content, 'utf8'),
    };
}

function compareLibraryEntries(left, right) {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
    return left.name.localeCompare(right.name, 'zh-CN', {
        sensitivity: 'base',
        numeric: true,
    });
}

async function scanDocumentLibraryDirectory(directoryPath) {
    let directoryEntries = [];
    try {
        directoryEntries = await fs.readdir(directoryPath, {
            withFileTypes: true,
        });
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EACCES') return [];
        throw error;
    }

    const entries = [];
    for (const entry of directoryEntries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            const children = await scanDocumentLibraryDirectory(entryPath);
            if (children.length) {
                entries.push({
                    type: 'directory',
                    name: entry.name,
                    path: entryPath,
                    children,
                });
            }
            continue;
        }
        const extension = path.extname(entry.name).toLowerCase();
        if (!entry.isFile() || !LIBRARY_EXTENSIONS.has(extension)) continue;
        const stat = await fs.stat(entryPath);
        entries.push({
            type: 'file',
            name: entry.name,
            path: entryPath,
            extension: extension.slice(1),
            size: stat.size,
            modifiedAt: stat.mtimeMs,
        });
    }
    return entries.sort(compareLibraryEntries);
}

async function readDocumentLibrary() {
    const roots = [];
    for (const root of documentLibraryRoots) {
        await fs.ensureDir(root.path);
        const children = await scanDocumentLibraryDirectory(root.path);
        roots.push({
            id: root.id,
            label: root.label,
            description: root.description,
            path: root.path,
            children,
        });
    }
    return {
        success: true,
        extensions: [...LIBRARY_EXTENSIONS].map((item) => item.slice(1)),
        roots,
    };
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

function resourceNameFromUrl(resourceUrl, headers = {}) {
    const disposition = String(headers['content-disposition'] || '');
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const plain = disposition.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
    if (encoded) {
        try {
            return path.basename(decodeURIComponent(encoded));
        } catch {}
    }
    if (plain?.[1] || plain?.[2]) {
        return path.basename(String(plain[1] || plain[2]).trim());
    }
    try {
        return path.basename(decodeURIComponent(new URL(resourceUrl).pathname)) || 'resource.bin';
    } catch {
        return 'resource.bin';
    }
}

function classifyCollectableResource(bytes, suppliedMime = '', name = '') {
    const data = Buffer.from(bytes || []);
    const mime = String(suppliedMime || '').trim().toLowerCase();
    const normalizedMime = mime.split(';', 1)[0];
    const extension = path.extname(String(name || '')).toLowerCase();
    const ascii = (start, length) => data.subarray(start, start + length).toString('ascii');
    const starts = (...values) => values.every((value, index) => data[index] === value);
    const recognizedMime = /^(?:image|audio|video|font)\//.test(normalizedMime)
        || new Set([
            'application/font-woff',
            'application/font-sfnt',
            'application/vnd.ms-fontobject',
            'application/x-font-ttf',
            'application/x-font-opentype',
        ]).has(normalizedMime);
    const htmlMime = normalizedMime === 'text/html'
        || normalizedMime === 'application/xhtml+xml';
    if (htmlMime) {
        return {
            collectable: false,
            reason: '目标返回 HTML 网页，不作为工程资源收纳。',
            mime: normalizedMime,
            category: null,
        };
    }

    let detectedMime = '';
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
        detectedMime = 'image/png';
    } else if (starts(0xff, 0xd8, 0xff)) {
        detectedMime = 'image/jpeg';
    } else if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') {
        detectedMime = 'image/gif';
    } else if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
        detectedMime = 'image/webp';
    } else if (ascii(0, 2) === 'BM') {
        detectedMime = 'image/bmp';
    } else if (starts(0x00, 0x00, 0x01, 0x00)) {
        detectedMime = 'image/x-icon';
    } else if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') {
        detectedMime = 'audio/wav';
    } else if (ascii(0, 4) === 'fLaC') {
        detectedMime = 'audio/flac';
    } else if (ascii(0, 4) === 'OggS') {
        detectedMime = extension === '.ogv' ? 'video/ogg' : 'audio/ogg';
    } else if (ascii(0, 3) === 'ID3'
        || (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) {
        detectedMime = 'audio/mpeg';
    } else if (ascii(4, 4) === 'ftyp') {
        detectedMime = extension === '.m4a' ? 'audio/mp4' : 'video/mp4';
    } else if (starts(0x1a, 0x45, 0xdf, 0xa3)) {
        detectedMime = extension === '.weba' ? 'audio/webm' : 'video/webm';
    } else if (ascii(0, 4) === 'wOFF') {
        detectedMime = 'font/woff';
    } else if (ascii(0, 4) === 'wOF2') {
        detectedMime = 'font/woff2';
    } else if (ascii(0, 4) === 'OTTO') {
        detectedMime = 'font/otf';
    } else if (starts(0x00, 0x01, 0x00, 0x00) || ascii(0, 4) === 'true') {
        detectedMime = 'font/ttf';
    } else {
        const prefix = data.subarray(0, Math.min(data.length, 1024))
            .toString('utf8')
            .replace(/^\uFEFF/, '')
            .trimStart();
        if (/^<svg(?:\s|>)/i.test(prefix)
            || /^<\?xml[\s\S]{0,400}<svg(?:\s|>)/i.test(prefix)) {
            detectedMime = 'image/svg+xml';
        } else if (/^(?:<!doctype\s+html|<html(?:\s|>))/i.test(prefix)) {
            return {
                collectable: false,
                reason: '目标内容是 HTML 网页，不作为工程资源收纳。',
                mime: normalizedMime || 'text/html',
                category: null,
            };
        }
    }

    const effectiveMime = detectedMime || (recognizedMime ? normalizedMime : '');
    if (!effectiveMime) {
        return {
            collectable: false,
            reason: '无法确认该 URL 指向受支持的媒体或字体文件，保留为通用 URL。',
            mime: normalizedMime || 'application/octet-stream',
            category: null,
        };
    }
    return {
        collectable: true,
        reason: '',
        mime: effectiveMime,
        category: effectiveMime.startsWith('font/')
            || effectiveMime.startsWith('application/font')
            || effectiveMime.includes('font-')
            ? 'fonts'
            : 'media',
    };
}

function downloadExternalResource(resourceUrl, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > MAX_RESOURCE_REDIRECTS) {
            reject(new Error('网络资源重定向次数过多。'));
            return;
        }
        const parsed = new URL(resourceUrl);
        const transport = parsed.protocol === 'https:' ? https : http;
        const request = transport.get(parsed, {
            timeout: RESOURCE_TIMEOUT_MS,
            headers: {
                'User-Agent': 'VCP-Scriptorium/2',
                Accept: '*/*',
            },
        }, (response) => {
            const status = Number(response.statusCode) || 0;
            if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
                response.resume();
                const redirected = new URL(response.headers.location, parsed).href;
                resolve(downloadExternalResource(redirected, redirects + 1));
                return;
            }
            if (status < 200 || status >= 300) {
                response.resume();
                reject(new Error(`网络资源读取失败：HTTP ${status}`));
                return;
            }
            const declaredLength = Number(response.headers['content-length']);
            if (Number.isFinite(declaredLength) && declaredLength > MAX_RESOURCE_BYTES) {
                response.resume();
                reject(new Error('网络资源超过 80 MB 安全上限。'));
                return;
            }
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_RESOURCE_BYTES) {
                    request.destroy(new Error('网络资源超过 80 MB 安全上限。'));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                const bytes = Buffer.concat(chunks);
                resolve({
                    bytes,
                    name: resourceNameFromUrl(parsed.href, response.headers),
                    mime: String(response.headers['content-type'] || '')
                        .split(';', 1)[0].trim(),
                    finalUrl: parsed.href,
                });
            });
            response.on('error', reject);
        });
        request.on('timeout', () => request.destroy(new Error('网络资源读取超时。')));
        request.on('error', reject);
    });
}

async function readExternalResource(_event, payload = {}) {
    const supplied = String(payload.url || '').trim();
    if (!supplied) throw new Error('缺少资源 URL。');
    let parsed;
    try {
        parsed = new URL(supplied);
    } catch {
        throw new Error('资源地址必须是完整的 file、http 或 https URL。');
    }
    if (!['file:', 'http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`不允许读取 ${parsed.protocol || '未知'} 协议资源。`);
    }

    let result;
    if (parsed.protocol === 'file:') {
        const filePath = fileURLToPath(parsed);
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) throw new Error('本地资源不是有效文件。');
        if (stat.size > MAX_RESOURCE_BYTES) {
            throw new Error('本地资源超过 80 MB 安全上限。');
        }
        result = {
            bytes: await fs.readFile(filePath),
            name: path.basename(filePath),
            mime: '',
            finalUrl: parsed.href,
        };
    } else {
        result = await downloadExternalResource(parsed.href);
    }
    const classification = classifyCollectableResource(
        result.bytes,
        result.mime,
        result.name
    );
    if (!classification.collectable) {
        return {
            success: true,
            collectable: false,
            reason: classification.reason,
            url: supplied,
            finalUrl: result.finalUrl,
            name: result.name,
            mime: classification.mime,
            category: null,
            size: result.bytes.length,
            bytes: null,
        };
    }
    return {
        success: true,
        collectable: true,
        reason: '',
        url: supplied,
        finalUrl: result.finalUrl,
        name: result.name,
        mime: classification.mime || result.mime || 'application/octet-stream',
        category: classification.category,
        size: result.bytes.length,
        bytes: Uint8Array.from(result.bytes),
    };
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
        source: imported.source,
        sourceFormat: imported.sourceFormat,
        lineEnding: imported.lineEnding,
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

function escapeInlineScriptSource(source) {
    return String(source || '').replace(/<\/script/gi, '<\\/script');
}

function libraryForExternalScriptUrl(value) {
    const url = String(value || '').trim();
    if (
        /^https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/three\.js(?:\/|$)/i.test(url)
        || /^https?:\/\/cdn\.jsdelivr\.net\/npm\/three(?:@[^/]+)?(?:\/|$)/i.test(url)
        || /^https?:\/\/unpkg\.com\/three(?:@[^/]+)?(?:\/|$)/i.test(url)
        || /(?:^|\/)vendor\/three(?:\.min)?\.js(?:[?#].*)?$/i.test(url)
    ) return 'three';
    if (
        /^https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/animejs(?:\/|$)/i.test(url)
        || /^https?:\/\/cdn\.jsdelivr\.net\/npm\/animejs(?:@[^/]+)?(?:\/|$)/i.test(url)
        || /^https?:\/\/unpkg\.com\/animejs(?:@[^/]+)?(?:\/|$)/i.test(url)
        || /(?:^|\/)vendor\/anime(?:\.min)?\.js(?:[?#].*)?$/i.test(url)
    ) return 'anime';
    return null;
}

function collectMarkedDependencies(html) {
    const dependencies = new Set();
    const scriptPattern = /<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi;
    let match;
    while ((match = scriptPattern.exec(String(html || '')))) {
        const attributes = match[1] || '';
        const libraryMatch = attributes.match(
            /\bdata-vdoc-library\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i
        );
        const library = String(
            libraryMatch?.[1] || libraryMatch?.[2] || libraryMatch?.[3] || ''
        ).toLowerCase();
        if (['anime', 'three'].includes(library)) dependencies.add(library);

        const sourceMatch = attributes.match(
            /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i
        );
        const source = sourceMatch?.[1] || sourceMatch?.[2] || sourceMatch?.[3] || '';
        const externalLibrary = libraryForExternalScriptUrl(source);
        if (externalLibrary) dependencies.add(externalLibrary);
    }
    return dependencies;
}

async function inlineProgrammableDependencies(html, requestedDependencies = []) {
    const dependencies = collectMarkedDependencies(html);
    (Array.isArray(requestedDependencies) ? requestedDependencies : [])
        .map((item) => String(item || '').toLowerCase())
        .filter((item) => ['anime', 'three'].includes(item))
        .forEach((item) => dependencies.add(item));

    // 依赖声明和被忽略的外链仅用于 VDOCX/VPPTX 工程审计，
    // 导出的可执行 HTML 中由本地内联库取代，不保留这些占位节点。
    let output = String(html || '')
        // 兼容旧工程和导入 HTML：所有带 src 的脚本都不会原样进入导出文件；
        // Anime/Three 已在上方识别并改为内联本地库，其他外链直接忽略。
        .replace(
            /<script\b(?=[^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script\s*>/gi,
            ''
        )
        .replace(
            /<script\b(?=[^>]*\bdata-vdoc-library\s*=)[^>]*>[\s\S]*?<\/script\s*>/gi,
            ''
        )
        .replace(
            /<script\b(?=[^>]*\bdata-vdoc-ignored-src\s*=)[^>]*>[\s\S]*?<\/script\s*>/gi,
            ''
        )
        .replace(
            /<script\b[^>]*type\s*=\s*(?:"application\/x-vdoc-ignored-external"|'application\/x-vdoc-ignored-external')[^>]*>[\s\S]*?<\/script\s*>/gi,
            ''
        );

    const sources = [];
    for (const library of ['anime', 'three']) {
        if (!dependencies.has(library)) continue;
        const fileName = library === 'anime' ? 'anime.min.js' : 'three.min.js';
        const sourcePath = path.join(projectRoot, 'vendor', fileName);
        const source = await fs.readFile(sourcePath, 'utf8');
        sources.push(
            `<script data-vdoc-embedded-library="${library}">\n${
                escapeInlineScriptSource(source)
            }\n</script>`
        );
    }

    if (!sources.length) return output;
    const embedded = sources.join('\n');
    if (/<\/head\s*>/i.test(output)) {
        // 必须使用函数型替换。Three.js 压缩源码包含大量 `$&`、`$'`
        // 等字符序列；若直接作为 replace 的 replacement string，
        // JavaScript 会将其解释为匹配引用并把 `</head>` 写进库源码，
        // 最终导致导出页面报 Unexpected token '<'。
        return output.replace(
            /<\/head\s*>/i,
            () => `${embedded}\n</head>`
        );
    }
    return `${embedded}\n${output}`;
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
    const html = await inlineProgrammableDependencies(
        String(payload.html || ''),
        payload.programmableDependencies
    );
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
    networkFontCache = new ScriptoriumFontCacheService({
        appDataRoot: params.appDataRoot,
    });
    void networkFontCache.initialize().catch((error) => {
        console.warn(
            '[Scriptorium] Network font cache initialization failed:',
            error.message
        );
    });
    openChildWindows = params.openChildWindows || [];
    projectRoot = params.projectRoot;
    recentFilePath = path.join(
        params.appDataRoot,
        'Scriptorium',
        'recent.json'
    );
    stylePackFilePath = path.join(
        params.appDataRoot,
        'Scriptorium',
        'style-packs.json'
    );
    svgAssetFilePath = path.join(
        params.appDataRoot,
        'Scriptorium',
        'svg-assets.json'
    );
    documentLibraryRoots = [
        {
            id: 'documents',
            label: '用户文档',
            description: 'VDOCX 与导入文档',
            path: path.join(
                params.appDataRoot,
                'ScriptoriumDocument',
                'VDOCX'
            ),
        },
        {
            id: 'presentations',
            label: '用户演示',
            description: 'VPPTX 与 PowerPoint 演示',
            path: path.join(
                params.projectRoot,
                'ScriptoriumDocument',
                'VPPTX'
            ),
        },
        {
            id: 'notes',
            label: '用户笔记',
            description: 'Markdown 与纯文本笔记',
            path: path.join(params.appDataRoot, 'Notemodules'),
        },
    ];

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
    ipcMain.handle('docx:read-external-resource', readExternalResource);
    ipcMain.handle(
        'scriptorium:resolve-font-stylesheet',
        (_event, payload = {}) =>
            networkFontCache.resolveStylesheet(payload.url)
    );
    ipcMain.handle(
        'scriptorium:resolve-font-url',
        (_event, payload = {}) =>
            networkFontCache.resolveFont(payload.url)
    );
    ipcMain.handle('docx:save', saveDocument);
    ipcMain.handle('scriptorium:export-rich-document', exportRichDocument);
    ipcMain.handle('scriptorium:document-library', readDocumentLibrary);
    ipcMain.handle('docx:recent-list', readRecentFiles);
    ipcMain.handle('scriptorium:style-packs-load', readStylePacks);
    ipcMain.handle('scriptorium:style-packs-save', writeStylePacks);
    ipcMain.handle('scriptorium:svg-assets-load', readSvgAssetPacks);
    ipcMain.handle('scriptorium:svg-assets-save', writeSvgAssetPacks);
    ipcMain.handle('docx:fonts-list', (_event, forceRefresh = false) => getSystemFonts(forceRefresh));
}

module.exports = {
    initialize,
    openDocxWindow,
    requestAgentOperation,
    scanDocumentLibraryDirectory,
    readDocumentLibrary,
    writeProjectArtifact: (filePath, bytes) =>
        atomicWrite(filePath, Buffer.from(bytes || [])),
    getDocxWindow: () => docxWindow,
    getSystemFonts,
};