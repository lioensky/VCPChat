// modules/services/minerU/minerUService.js
// MinerU 论文工作台的主进程服务：
// - 定位 VCPToolBox/Plugin/MinerUParser，按平台选择 Rust 二进制；
// - 直接扫描 file/mineru 下的资产（index.json + state.json），供界面展示与阅读；
// - preflight / duplicates / parse / query 通过 stdio 调用插件，解析进度轮询 state.json；
// - 仅通过 IPC 暴露受控接口，页面来源由 minerUHandlers 校验。
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const dotenv = require('dotenv');

const PAPER_ID_RE = /^paper_[A-Za-z0-9_-]+$/;
const MAX_PDF_BYTES = 128 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 24 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_JOBS = 500;
const JOB_CONCURRENCY_MAX = 5;
const COMMAND_TIMEOUT_MS = 32 * 60 * 1000;
const DEFAULT_CONFIG = Object.freeze({
    toolboxRoot: '',
    workers: 3,
    modelVersion: 'vlm',
    isOcr: false,
    language: 'en',
    enableFormula: true,
    enableTable: true,
    recursive: true,
});

const events = new EventEmitter();
events.setMaxListeners(20);

let initialized = false;
let appDataRoot = '';
let projectRoot = '';
let configDir = '';
let configPath = '';
let pdfMapPath = '';
let config = { ...DEFAULT_CONFIG };
let toolboxRoot = '';
let pluginDir = '';
let binaryPath = '';
let pluginConfig = {};
let resolutionError = '';
let libraryCache = { at: 0, records: [] };
let pdfMapCache = { at: 0, map: {} };
let jobSeq = 0;
const jobs = new Map();
const internals = new Map();

function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

function readJson(filePath) {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function atomicWriteJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
}

function isPdfFile(filePath) {
    return typeof filePath === 'string'
        && path.extname(filePath).toLowerCase() === '.pdf';
}

function isExistingFile(filePath) {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function isExistingDir(filePath) {
    try {
        return fs.statSync(filePath).isDirectory();
    } catch {
        return false;
    }
}

function platformBinary() {
    const targets = {
        'win32:x64': { triple: 'x86_64-pc-windows-msvc', ext: '.exe' },
        'win32:arm64': { triple: 'aarch64-pc-windows-msvc', ext: '.exe' },
        'linux:x64': { triple: 'x86_64-unknown-linux-gnu', ext: '' },
        'linux:arm64': { triple: 'aarch64-unknown-linux-gnu', ext: '' },
        'darwin:x64': { triple: 'x86_64-apple-darwin', ext: '' },
        'darwin:arm64': { triple: 'aarch64-apple-darwin', ext: '' },
    };
    return targets[`${process.platform}:${process.arch}`] || null;
}

function binaryCandidates(dir) {
    const target = platformBinary();
    if (!target) return [];
    const name = `MinerUParser${target.ext}`;
    return [
        path.join(dir, 'bin', `MinerUParser-${target.triple}${target.ext}`),
        path.join(dir, 'src', 'target', target.triple, 'release', name),
        path.join(dir, 'src', 'target', 'release', name),
        path.join(dir, 'src', 'target', target.triple, 'debug', name),
        path.join(dir, 'src', 'target', 'debug', name),
    ];
}

function findBinary(dir) {
    return binaryCandidates(dir).find(candidate => {
        try {
            fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }) || null;
}

function workspaceToolboxCandidates() {
    const candidates = [];
    try {
        const settings = readJson(path.join(appDataRoot, 'settings.json'));
        for (const workspace of settings?.workspaces || []) {
            if (typeof workspace?.path !== 'string') continue;
            const root = path.resolve(workspace.path);
            candidates.push(root);
            candidates.push(path.join(root, 'VCPToolBox'));
        }
    } catch {
        // 设置不可读时继续用目录候选
    }
    return candidates;
}

function toolboxCandidates() {
    const roots = [];
    if (config.toolboxRoot) roots.push(config.toolboxRoot);
    if (process.env.VCPTOOLBOX_ROOT) roots.push(process.env.VCPTOOLBOX_ROOT);
    if (process.env.VCP_TOOLBOX_ROOT) roots.push(process.env.VCP_TOOLBOX_ROOT);
    roots.push(...workspaceToolboxCandidates());
    roots.push(path.resolve(projectRoot, '..', 'VCPToolBox'));
    roots.push(path.resolve(projectRoot, '..', '..', 'VCPToolBox'));
    roots.push(path.resolve(process.cwd(), 'VCPToolBox'));
    roots.push(path.resolve(process.cwd(), '..', 'VCPToolBox'));
    return roots;
}

function resolveEnvironment() {
    toolboxRoot = '';
    pluginDir = '';
    binaryPath = '';
    pluginConfig = {};
    resolutionError = '';

    for (const candidate of toolboxCandidates()) {
        if (!candidate) continue;
        const root = path.resolve(candidate);
        const dir = path.join(root, 'Plugin', 'MinerUParser');
        if (!fs.existsSync(path.join(dir, 'plugin-manifest.json'))) continue;
        toolboxRoot = root;
        pluginDir = dir;
        binaryPath = findBinary(dir) || '';
        break;
    }

    if (!toolboxRoot) {
        resolutionError = '未找到 VCPToolBox：请在设置中指定 VCPToolBox 根目录（其中应包含 Plugin/MinerUParser）。';
        return false;
    }

    try {
        if (fs.existsSync(path.join(pluginDir, 'config.env'))) {
            pluginConfig = dotenv.parse(fs.readFileSync(path.join(pluginDir, 'config.env')));
        }
    } catch (error) {
        resolutionError = `读取 MinerU 配置失败：${error.message}`;
        return false;
    }

    if (!binaryPath) {
        resolutionError = `未找到 MinerUParser 二进制（${process.platform}/${process.arch}）。请在 VCPToolBox/Plugin/MinerUParser/src 执行 cargo build --release。`;
        return false;
    }
    return true;
}

function loadConfig() {
    const saved = readJson(configPath);
    config = {
        ...DEFAULT_CONFIG,
        ...(saved && typeof saved === 'object' ? saved : {}),
    };
    config.workers = clamp(config.workers, 1, JOB_CONCURRENCY_MAX);
    config.modelVersion = config.modelVersion === 'pipeline' ? 'pipeline' : 'vlm';
    config.isOcr = Boolean(config.isOcr);
    config.enableFormula = config.enableFormula !== false;
    config.enableTable = config.enableTable !== false;
    config.recursive = config.recursive !== false;
    config.language = typeof config.language === 'string' && config.language.trim()
        ? config.language.trim()
        : 'en';
    config.toolboxRoot = typeof config.toolboxRoot === 'string' ? config.toolboxRoot : '';
    if (!config.toolboxRoot) delete config.toolboxRoot;
}

function toolboxEnv() {
    let port = '';
    let imageKey = '';
    let fileKey = '';
    try {
        const envPath = path.join(toolboxRoot, 'config.env');
        if (fs.existsSync(envPath)) {
            const rootEnv = dotenv.parse(fs.readFileSync(envPath));
            port = rootEnv.PORT || '';
            imageKey = rootEnv.Image_Key || rootEnv.IMAGESERVER_IMAGE_KEY || '';
            fileKey = rootEnv.File_Key || rootEnv.IMAGESERVER_FILE_KEY || '';
        }
    } catch {
        // URL 只是图片的备用渲染方式；读不到也不影响本地阅读
    }
    return {
        PROJECT_BASE_PATH: toolboxRoot,
        SERVER_PORT: port || process.env.PORT || '6005',
        IMAGESERVER_IMAGE_KEY: imageKey || process.env.IMAGESERVER_IMAGE_KEY || '',
        IMAGESERVER_FILE_KEY: fileKey || process.env.IMAGESERVER_FILE_KEY || '',
    };
}

function commandEnv() {
    return {
        ...process.env,
        ...toolboxEnv(),
        ...pluginConfig,
        ...(process.env.MINERU_TOKEN ? { MINERU_TOKEN: process.env.MINERU_TOKEN } : {}),
    };
}

function sanitizeError(error) {
    const token = pluginConfig.MINERU_TOKEN || process.env.MINERU_TOKEN || '';
    let message = String(error?.message || error || '未知错误');
    if (token) message = message.split(token).join('***');
    return message;
}

function parseStdout(stdout) {
    const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line.startsWith('{')) continue;
        try {
            return JSON.parse(line);
        } catch {
            // 继续尝试更早的一行
        }
    }
    return null;
}

function runCommand(request, { timeoutMs = COMMAND_TIMEOUT_MS, onChild = null } = {}) {
    return new Promise((resolve) => {
        if (!binaryPath) {
            resolve({ ok: false, error: resolutionError || 'MinerUParser 二进制未就绪。' });
            return;
        }
        let child;
        try {
            child = spawn(binaryPath, [], {
                cwd: toolboxRoot,
                env: commandEnv(),
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (error) {
            resolve({ ok: false, error: sanitizeError(error) });
            return;
        }
        onChild?.(child);

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        let killTimer = null;
        const timer = timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                try { child.kill('SIGTERM'); } catch { /* already gone */ }
                // 进程若忽略 SIGTERM，5 秒后强制结束，避免任务槽位永久占用
                killTimer = setTimeout(() => {
                    try { child.kill('SIGKILL'); } catch { /* already gone */ }
                }, 5000);
                killTimer.unref?.();
            }, timeoutMs)
            : null;

        child.stdout.on('data', data => {
            stdout += data.toString('utf8');
            if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(-4 * 1024 * 1024);
        });
        child.stderr.on('data', data => {
            stderr += data.toString('utf8');
            if (stderr.length > 16000) stderr = stderr.slice(-8000);
        });
        child.on('error', error => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (killTimer) clearTimeout(killTimer);
            resolve({ ok: false, error: sanitizeError(error) });
        });
        child.on('close', code => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (killTimer) clearTimeout(killTimer);
            const parsed = parseStdout(stdout);
            if (parsed?.status === 'success') {
                const content = Array.isArray(parsed.result?.content) ? parsed.result.content : [];
                const text = content.map(part => part?.text || '').filter(Boolean).join('\n');
                resolve({
                    ok: true,
                    data: parsed.result?.data ?? null,
                    text,
                    stderr: stderr.trim(),
                });
                return;
            }
            const error = parsed?.error
                || (timedOut
                    ? '命令执行超过 32 分钟，已停止等待。'
                    : `MinerUParser 退出码 ${code}${stderr.trim() ? `：${stderr.trim()}` : ''}`);
            resolve({ ok: false, error: sanitizeError(error), stderr: stderr.trim(), timedOut });
        });

        try {
            child.stdin.end(JSON.stringify(request));
        } catch (error) {
            if (!settled) {
                settled = true;
                if (timer) clearTimeout(timer);
                resolve({ ok: false, error: sanitizeError(error) });
            }
        }
    });
}

// 可替换的命令执行器：单元测试注入受控 Promise，生产环境始终是 runCommand。
let commandRunner = runCommand;

function invalidateLibrary() {
    libraryCache = { at: 0, records: [] };
}

function statusGroupOf(index, state) {
    if (index) return 'indexed';
    const raw = String(state?.state || '');
    if (raw === 'indexed') return 'indexed';
    if (raw === 'timeout') return 'timeout';
    if (raw === 'failed') return 'failed';
    if (['uploading', 'running', 'downloading', 'extracting', 'waiting-file', 'waiting', 'pending'].includes(raw)) {
        return 'running';
    }
    return 'unknown';
}

function statusLabel(group) {
    return {
        indexed: '已完成',
        running: '进行中',
        timeout: '待续查',
        failed: '失败',
        unknown: '未知',
    }[group] || group;
}

function progressOf(state) {
    if (!state) return null;
    if (Array.isArray(state.chunks) && state.chunks.length) {
        let extracted = 0;
        let total = 0;
        let done = 0;
        for (const chunk of state.chunks) {
            const start = Number(chunk.start_page) || 0;
            const end = Number(chunk.end_page) || 0;
            const chunkTotal = Math.max(0, end - start);
            total += chunkTotal;
            if (chunk.state === 'done') {
                extracted += chunkTotal;
                done += 1;
            } else {
                extracted += Math.min(Number(chunk.extracted) || 0, Number(chunk.total) || 0);
            }
        }
        return {
            extracted,
            total,
            chunksDone: done,
            chunksTotal: state.chunks.length,
        };
    }
    const last = state.last_progress;
    if (last && (last.total_pages || last.extracted_pages)) {
        return {
            extracted: Number(last.extracted_pages) || 0,
            total: Number(last.total_pages) || 0,
        };
    }
    return null;
}

function loadPdfMap() {
    if (Date.now() - pdfMapCache.at < 2000) return pdfMapCache.map;
    const raw = readJson(pdfMapPath) || {};
    const map = {};
    for (const [key, value] of Object.entries(raw)) {
        if (PAPER_ID_RE.test(key) && typeof value === 'string' && isExistingFile(value)) {
            map[key] = value;
        }
    }
    pdfMapCache = { at: Date.now(), map };
    return map;
}

function titleFromLeaf(leaf, paperId) {
    const suffix = `__${paperId}`;
    if (leaf.endsWith(suffix) && leaf.length > suffix.length) {
        return leaf.slice(0, -suffix.length);
    }
    return '';
}

function recordFromDir(dir, leaf) {
    const index = readJson(path.join(dir, 'index.json'));
    const state = readJson(path.join(dir, 'state.json'));
    if (!index && !state && !fs.existsSync(path.join(dir, 'index.json'))) return null;
    const paperId = String(index?.paper_id || state?.paper_id || leaf.split('__').pop() || '');
    if (!PAPER_ID_RE.test(paperId)) return null;
    const group = statusGroupOf(index, state);
    const title = String(
        index?.title
        || titleFromLeaf(leaf, paperId)
        || path.basename(String(index?.file_name || state?.file_name || ''), path.extname(String(index?.file_name || state?.file_name || '')))
        || paperId
    ).trim() || paperId;
    const fileDir = dir;
    const imageDir = path.join(toolboxRoot, 'image', 'mineru', leaf);
    const pdfMap = loadPdfMap();
    let sourcePath = index?.source_path || state?.source_path || null;
    let pdfPath = null;
    if (pdfMap[paperId] && isExistingFile(pdfMap[paperId])) {
        pdfPath = pdfMap[paperId];
    } else if (sourcePath && !/^https?:\/\//i.test(sourcePath) && isPdfFile(sourcePath) && isExistingFile(sourcePath)) {
        pdfPath = sourcePath;
    }
    const progress = progressOf(state);
    return {
        paperId,
        title,
        leaf,
        assetDir: leaf,
        fileDir,
        imageDir: isExistingDir(imageDir) ? imageDir : null,
        hasIndex: Boolean(index),
        hasState: Boolean(state),
        state: state?.state || null,
        group,
        status: statusLabel(group),
        legacyDir: !leaf.includes('__'),
        pages: Number(index?.pages) || 0,
        textChars: Number(index?.text_chars) || 0,
        imageCount: Number(index?.image_count) || 0,
        tableCount: Number(index?.table_count) || 0,
        formulaCount: Number(index?.formula_count) || 0,
        outlineCount: Array.isArray(index?.outline) ? index.outline.length : 0,
        fileSize: 0,
        sourcePath: sourcePath || null,
        pdfPath,
        pdfName: pdfPath ? path.basename(pdfPath) : '',
        pdfAvailable: Boolean(pdfPath),
        fileName: index?.file_name || state?.file_name || '',
        batchId: state?.batch_id || index?.batch_id || null,
        progress,
        error: state?.err_msg || null,
        warnings: Array.isArray(index?.warnings) ? index.warnings : [],
        errors: Array.isArray(index?.errors) ? index.errors : [],
        updatedAt: index?.created_at || state?.updated_at || '',
        createdAt: index?.created_at || state?.created_at || '',
        sourceDir: index?.source_dir || state?.source_dir || null,
        renderUrl: index?.render_url || null,
        duplicateDirs: [],
    };
}

function preferRecord(a, b) {
    if (a.hasIndex !== b.hasIndex) return a.hasIndex;
    if (a.legacyDir !== b.legacyDir) return !a.legacyDir;
    return String(a.updatedAt).localeCompare(String(b.updatedAt)) > 0;
}

function scanLibrary(force = false) {
    if (!force && Date.now() - libraryCache.at < 1500) return libraryCache.records;
    if (!toolboxRoot) return [];
    const root = path.join(toolboxRoot, 'file', 'mineru');
    let entries = [];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        libraryCache = { at: Date.now(), records: [] };
        return [];
    }
    const byPaper = new Map();
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const record = recordFromDir(path.join(root, entry.name), entry.name);
        if (!record) continue;
        const current = byPaper.get(record.paperId);
        if (!current) {
            byPaper.set(record.paperId, record);
            continue;
        }
        if (preferRecord(record, current)) {
            record.duplicateDirs = [current.assetDir, ...current.duplicateDirs];
            byPaper.set(record.paperId, record);
        } else {
            current.duplicateDirs.push(record.assetDir);
        }
    }
    const records = [...byPaper.values()].sort((a, b) => (
        String(b.updatedAt).localeCompare(String(a.updatedAt))
        || a.title.localeCompare(b.title)
    ));
    libraryCache = { at: Date.now(), records };
    return records;
}

function requirePaperId(paperId) {
    if (typeof paperId !== 'string' || !PAPER_ID_RE.test(paperId)) {
        throw new Error('论文 ID 格式不正确。');
    }
    return paperId;
}

function getRecord(paperId) {
    const id = requirePaperId(paperId);
    return scanLibrary().find(record => record.paperId === id) || null;
}

function getPaperDetail(paperId) {
    const record = getRecord(paperId);
    if (!record) throw new Error(`未找到论文 ${paperId}。`);
    const dir = record.fileDir;
    const index = readJson(path.join(dir, 'index.json')) || {};
    const state = readJson(path.join(dir, 'state.json')) || {};
    const mdCandidates = ['full.md', 'full.render.md'];
    let markdown = '';
    let markdownSource = '';
    for (const name of mdCandidates) {
        const candidate = path.join(dir, name);
        if (!isExistingFile(candidate)) continue;
        const stat = fs.statSync(candidate);
        if (stat.size > MAX_MARKDOWN_BYTES) {
            throw new Error(`${name} 超过 ${Math.round(MAX_MARKDOWN_BYTES / 1024 / 1024)}MB，无法在界面内完整加载。`);
        }
        markdown = fs.readFileSync(candidate, 'utf8');
        markdownSource = name;
        break;
    }
    const images = Array.isArray(index.images)
        ? index.images.map(image => ({
            rel: image.rel,
            caption: image.caption || '',
            pageIdx: Number.isInteger(image.page_idx) ? image.page_idx : null,
            url: image.url || '',
        }))
        : [];
    return {
        paper: record,
        index: {
            title: index.title || record.title,
            outline: Array.isArray(index.outline) ? index.outline : [],
            images,
            errors: Array.isArray(index.errors) ? index.errors : [],
            warnings: Array.isArray(index.warnings) ? index.warnings : [],
            mdPath: index.md_path || '',
            renderUrl: index.render_url || '',
            sourcePath: index.source_path || null,
            sourceDir: index.source_dir || null,
        },
        state,
        markdown,
        markdownSource,
        hasMarkdown: Boolean(markdown),
        imageDir: record.imageDir,
        pdfPath: record.pdfPath,
        pdfAvailable: record.pdfAvailable,
        pdfName: record.pdfPath ? path.basename(record.pdfPath) : '',
    };
}

function resolveAssetDir(paperId, assetDir) {
    const id = requirePaperId(paperId);
    const leaf = String(assetDir || '').trim();
    if (!leaf || leaf.includes('..') || /[\\/]/.test(leaf)) {
        throw new Error('资产目录名不合法。');
    }
    if (leaf !== id && !leaf.endsWith(`__${id}`)) {
        throw new Error('资产目录与 paper_id 不匹配。');
    }
    const dir = path.join(toolboxRoot, 'file', 'mineru', leaf);
    if (!isExistingDir(dir)) throw new Error('资产目录不存在。');
    return dir;
}

function resolveImagePath(paperId, relative) {
    const record = getRecord(paperId);
    if (!record?.imageDir) throw new Error('该论文没有图片目录。');
    let rel = String(relative || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.includes('\0')) throw new Error('图片路径为空。');
    if (rel.length > 4096) throw new Error('图片路径过长。');
    if (/^[A-Za-z]:/.test(rel)) throw new Error('图片路径不能是盘符绝对路径。');
    const segments = rel.split('/').filter(segment => segment && segment !== '.');
    if (segments.some(segment => segment === '..')) throw new Error('图片路径不能包含 ..。');
    const base = path.resolve(record.imageDir);
    const target = path.resolve(base, segments.join('/'));
    let realBase;
    let realTarget;
    try {
        realBase = fs.realpathSync(base);
        realTarget = fs.realpathSync(target);
    } catch {
        throw new Error('图片不存在。');
    }
    const relToBase = path.relative(realBase, realTarget);
    if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) {
        throw new Error('图片路径越界。');
    }
    if (!isExistingFile(realTarget)) throw new Error('图片不存在。');
    return realTarget;
}

function readPdf(paperId) {
    const record = getRecord(paperId);
    if (!record) throw new Error(`未找到论文 ${paperId}。`);
    if (!record.pdfPath) {
        return { available: false, reason: '该论文没有可用的本地 PDF，请在界面中选择 PDF 文件进行关联。' };
    }
    const stat = fs.statSync(record.pdfPath);
    if (!stat.isFile()) return { available: false, reason: '关联的 PDF 不是普通文件。' };
    if (stat.size > MAX_PDF_BYTES) {
        throw new Error(`PDF 为 ${Math.round(stat.size / 1024 / 1024)}MB，超过 ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB 上限；请用「打开 PDF」在系统阅读器中打开。`);
    }
    return {
        available: true,
        name: path.basename(record.pdfPath),
        path: record.pdfPath,
        size: stat.size,
        data: fs.readFileSync(record.pdfPath),
    };
}

function setPdfMapping(paperId, filePath) {
    const id = requirePaperId(paperId);
    const resolved = path.resolve(String(filePath || ''));
    if (!isPdfFile(resolved) || !isExistingFile(resolved)) {
        throw new Error('请选择存在的 PDF 文件。');
    }
    const map = { ...(readJson(pdfMapPath) || {}) };
    map[id] = resolved;
    atomicWriteJson(pdfMapPath, map);
    pdfMapCache = { at: 0, map: {} };
    invalidateLibrary();
    return { paperId: id, pdfPath: resolved, pdfName: path.basename(resolved) };
}

function clearPdfMapping(paperId) {
    const id = requirePaperId(paperId);
    const map = { ...(readJson(pdfMapPath) || {}) };
    delete map[id];
    atomicWriteJson(pdfMapPath, map);
    pdfMapCache = { at: 0, map: {} };
    invalidateLibrary();
    return { paperId: id };
}

function serializeJob(job) {
    return {
        id: job.id,
        type: job.type,
        paperId: job.paperId,
        path: job.path,
        title: job.title || '',
        state: job.state,
        message: job.message || '',
        error: job.error || null,
        batchId: job.batchId || null,
        progress: job.progress || null,
        chunks: job.chunks || null,
        createdAt: job.createdAt,
        startedAt: job.startedAt || null,
        finishedAt: job.finishedAt || null,
    };
}

function emitJob(job) {
    events.emit('job', serializeJob(job));
}

function listJobs() {
    return [...jobs.values()].map(serializeJob);
}

function isJobActive(job) {
    if (['starting', 'running', 'polling'].includes(job.state)) return true;
    // 已请求取消但子进程尚未退出：仍占用并发槽位
    return job.state === 'cancelled' && Boolean(internals.get(job.id)?.child);
}

function activeJobCount() {
    return [...jobs.values()].filter(isJobActive).length;
}

function terminalJob(job, state, patch = {}) {
    job.state = state;
    Object.assign(job, patch);
    job.finishedAt = Date.now();
    emitJob(job);
}

function findPaperDir(paperId, hintDir) {
    if (hintDir) {
        const state = readJson(path.join(hintDir, 'state.json'));
        if (state?.paper_id === paperId || fs.existsSync(path.join(hintDir, 'index.json'))) {
            return hintDir;
        }
    }
    const exact = path.join(toolboxRoot, 'file', 'mineru', paperId);
    if (isExistingDir(exact)) return exact;
    const root = path.join(toolboxRoot, 'file', 'mineru');
    try {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.endsWith(`__${paperId}`)) continue;
            return path.join(root, entry.name);
        }
    } catch {
        // 目录还没创建
    }
    return null;
}

function readJobProgress(job, internal) {
    if (!job.paperId) return null;
    const dir = findPaperDir(job.paperId, internal.dir);
    if (!dir) return null;
    internal.dir = dir;
    const state = readJson(path.join(dir, 'state.json'));
    if (!state) return null;
    const progress = progressOf(state);
    const chunks = Array.isArray(state.chunks) && state.chunks.length
        ? {
            done: state.chunks.filter(chunk => chunk.state === 'done').length,
            total: state.chunks.length,
        }
        : null;
    const raw = String(state.state || '');
    return {
        dir,
        raw,
        progress,
        chunks,
        error: state.err_msg || null,
    };
}

function buildRequest(job, options) {
    if (job.type === 'query') {
        return {
            command: 'query',
            paper_id: job.paperId,
        };
    }
    return {
        command: 'parse',
        file_path: job.path,
        model_version: options.modelVersion,
        is_ocr: Boolean(options.isOcr),
        language: options.language,
        enable_formula: options.enableFormula !== false,
        enable_table: options.enableTable !== false,
    };
}

async function runJob(job) {
    const internal = internals.get(job.id);
    if (!internal) {
        terminalJob(job, 'failed', { error: '任务上下文丢失，请重新提交。', message: '任务上下文丢失' });
        pump();
        return;
    }
    job.state = 'starting';
    job.startedAt = Date.now();
    emitJob(job);

    const options = { ...DEFAULT_CONFIG, ...config, ...internal.options };
    const request = buildRequest(job, options);

    try {
        internal.poll = setInterval(() => {
            if (!['starting', 'running', 'polling'].includes(job.state)) return;
            try {
                const info = readJobProgress(job, internal);
                if (!info) return;
                const changed = JSON.stringify(info.progress) !== JSON.stringify(job.progress)
                    || JSON.stringify(info.chunks) !== JSON.stringify(job.chunks)
                    || job.state !== 'running';
                // 云端 timeout / failed 先只记录信息，等子进程真正退出后再落终态，
                // 避免并发槽位被提前释放。
                job.state = 'running';
                if (!job.message || job.message === '等待开始' || job.message === '云端解析中') {
                    job.message = info.raw === 'timeout'
                        ? '本轮等待超时，进程正在收尾'
                        : info.raw === 'failed'
                            ? '云端报告失败，等待进程收尾'
                            : '云端解析中';
                }
                job.progress = info.progress || job.progress;
                job.chunks = info.chunks || job.chunks;
                if (info.error) job.message = info.error;
                if (changed) emitJob(job);
            } catch {
                // 状态文件正在原子替换时读失败，下一轮再读
            }
        }, 1800);
        internal.poll.unref?.();

        const result = await commandRunner(request, {
            onChild: child => {
                internal.child = child;
                job.pid = child.pid;
            },
        });

        if (job.cancelRequested) {
            terminalJob(job, 'cancelled', { message: '已停止本地等待；云端任务可能仍在运行，可稍后续查。' });
            return;
        }
        if (!result.ok) {
            terminalJob(job, 'failed', { error: result.error, message: result.error });
            return;
        }

        const info = readJobProgress(job, internal);
        scanLibrary(true);
        let record = job.paperId ? getRecord(job.paperId) : null;
        if (!record && job.path) {
            // 没有预检 paper_id 时，用源路径在刚刷新过的库里反查
            const normalized = path.resolve(job.path).toLowerCase();
            record = scanLibrary().find(item => (
                item.sourcePath && path.resolve(item.sourcePath).toLowerCase() === normalized
            )) || null;
            if (record) job.paperId = record.paperId;
        }
        const indexed = Boolean(record?.hasIndex) || info?.raw === 'indexed'
            || (internal.dir ? fs.existsSync(path.join(internal.dir, 'index.json')) : false);
        if (indexed) {
            terminalJob(job, 'done', {
                message: `解析完成${record?.pages ? `，${record.pages} 页` : ''}`,
                progress: info?.progress || job.progress,
                chunks: info?.chunks || job.chunks,
                batchId: result.data?.batch_id || job.batchId || null,
            });
            return;
        }
        if (result.data?.paper_id || info?.raw === 'timeout' || result.data?.state === 'running') {
            terminalJob(job, 'timeout', {
                message: result.data?.hint || '本轮等待超时，可稍后继续查询。',
                batchId: result.data?.batch_id || job.batchId || null,
                progress: info?.progress || job.progress,
                chunks: info?.chunks || job.chunks,
            });
            return;
        }
        terminalJob(job, 'failed', {
            error: '解析进程结束，但没有找到 index.json。请查看 VCPToolBox 日志或稍后续查。',
        });
    } catch (error) {
        if (job.cancelRequested) {
            terminalJob(job, 'cancelled', { message: '已停止本地等待。' });
        } else {
            const message = sanitizeError(error);
            terminalJob(job, 'failed', { error: message, message });
        }
    } finally {
        if (internal.poll) clearInterval(internal.poll);
        internal.poll = null;
        internal.child = null;
        invalidateLibrary();
        events.emit('library-changed', { paperId: job.paperId, reason: 'job-finished' });
        pump();
    }
}

function pump() {
    const concurrency = clamp(config.workers, 1, JOB_CONCURRENCY_MAX);
    let capacity = concurrency - activeJobCount();
    if (capacity <= 0) return;
    for (const job of jobs.values()) {
        if (capacity <= 0) break;
        if (job.state !== 'queued') continue;
        capacity -= 1;
        void runJob(job);
    }
}

function normalizeItems(items) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(items) ? items : []) {
        const source = typeof raw === 'string' ? { path: raw } : raw;
        if (!source?.path) continue;
        const filePath = path.resolve(String(source.path));
        if (!isPdfFile(filePath) || !isExistingFile(filePath)) continue;
        const paperId = typeof source.paperId === 'string' && PAPER_ID_RE.test(source.paperId)
            ? source.paperId
            : '';
        const key = (paperId || filePath).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ path: filePath, paperId, title: source.title || path.basename(filePath, path.extname(filePath)) });
    }
    return out;
}

function pruneJobs() {
    const finished = [...jobs.values()]
        .filter(job => !isJobActive(job))
        .sort((a, b) => (b.finishedAt || b.createdAt) - (a.finishedAt || a.createdAt));
    for (const job of finished.slice(80)) {
        jobs.delete(job.id);
        internals.delete(job.id);
    }
}

function createJobs(type, items, options = {}) {
    pruneJobs();
    if (jobs.size + items.length > MAX_JOBS) {
        throw new Error(`任务数超过 ${MAX_JOBS} 个上限，请分批解析。`);
    }
    const created = [];
    for (const item of items) {
        jobSeq += 1;
        const job = {
            id: `mineru-job-${Date.now()}-${jobSeq}`,
            type,
            paperId: item.paperId || '',
            path: item.path || '',
            title: item.title || '',
            state: 'queued',
            message: '等待开始',
            error: null,
            batchId: null,
            progress: null,
            chunks: null,
            createdAt: Date.now(),
            startedAt: null,
            finishedAt: null,
            cancelRequested: false,
            pid: null,
        };
        jobs.set(job.id, job);
        internals.set(job.id, { options: { ...options }, dir: '', child: null, poll: null });
        created.push(job);
        emitJob(job);
    }
    pump();
    return created.map(serializeJob);
}

function startParse(items, options = {}) {
    const normalized = normalizeItems(items);
    if (!normalized.length) throw new Error('没有可解析的 PDF。请先选择文件或文件夹。');
    const merged = {
        workers: clamp(options.workers ?? config.workers, 1, JOB_CONCURRENCY_MAX),
        modelVersion: options.modelVersion === 'pipeline' ? 'pipeline' : 'vlm',
        isOcr: Boolean(options.isOcr),
        language: typeof options.language === 'string' && options.language.trim() ? options.language.trim() : 'en',
        enableFormula: options.enableFormula !== false,
        enableTable: options.enableTable !== false,
    };
    config.workers = merged.workers;
    return createJobs('parse', normalized, merged);
}

function continuePapers(paperIds) {
    const ids = [...new Set((Array.isArray(paperIds) ? paperIds : []).filter(id => PAPER_ID_RE.test(id)))];
    if (!ids.length) throw new Error('请选择要续查的论文。');
    return createJobs('query', ids.map(paperId => ({
        paperId,
        title: getRecord(paperId)?.title || paperId,
    })), {});
}

function terminateChild(child) {
    if (!child) return;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    // 取消也要有强制兜底：忽略 SIGTERM 的进程不能永久占住并发槽位
    const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, 5000);
    timer.unref?.();
}

function cancelJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw new Error('任务不存在。');
    if (!['queued', 'starting', 'running', 'polling'].includes(job.state)) return serializeJob(job);
    job.cancelRequested = true;
    const internal = internals.get(job.id);
    if (job.state === 'queued') {
        terminalJob(job, 'cancelled', { message: '已取消排队。' });
        pump();
        return serializeJob(job);
    }
    terminateChild(internal?.child);
    terminalJob(job, 'cancelled', { message: '已停止本地等待。' });
    // 不在这里 pump：子进程尚未真正退出，提前释放槽位会让实际并发超过上限。
    // runJob 的 finally 会在进程收尾后统一调度下一个任务。
    return serializeJob(job);
}

function cancelAll() {
    for (const job of jobs.values()) {
        if (job.state !== 'queued' && !isJobActive(job)) continue;
        job.cancelRequested = true;
        const internal = internals.get(job.id);
        terminateChild(internal?.child);
        if (internal?.poll) {
            clearInterval(internal.poll);
            internal.poll = null;
        }
        terminalJob(job, 'cancelled', { message: '已停止本地等待。' });
    }
}

async function preflight(paths, options = {}) {
    const list = (Array.isArray(paths) ? paths : [paths])
        .filter(item => typeof item === 'string' && item.trim())
        .map(item => item.trim());
    if (!list.length) throw new Error('请先选择 PDF 文件或文件夹。');
    const result = await runCommand({
        command: 'preflight',
        file_paths: list,
        recursive: options.recursive !== false,
    }, { timeoutMs: 20 * 60 * 1000 });
    if (!result.ok) throw new Error(result.error);
    return { text: result.text, data: result.data };
}

async function findDuplicates(options = {}) {
    const result = await runCommand({
        command: 'duplicates',
        group_by: options.groupBy || 'all',
        query: options.query || undefined,
        limit: clamp(options.limit || 200, 1, 200),
    }, { timeoutMs: 5 * 60 * 1000 });
    if (!result.ok) throw new Error(result.error);
    return { text: result.text, data: result.data };
}

function getStatus() {
    const ok = resolveEnvironment();
    let version = '';
    try {
        version = readJson(path.join(pluginDir, 'plugin-manifest.json'))?.version || '';
    } catch {
        // ignore
    }
    return {
        ok,
        error: ok ? '' : resolutionError,
        toolboxRoot,
        pluginDir,
        binary: binaryPath,
        baseDir: toolboxRoot ? path.join(toolboxRoot, 'file', 'mineru') : '',
        version,
        tokenConfigured: Boolean(String(pluginConfig.MINERU_TOKEN || '').trim()),
        modelVersion: pluginConfig.MODEL_VERSION || 'vlm',
        config: {
            toolboxRoot: config.toolboxRoot || '',
            workers: config.workers,
            modelVersion: config.modelVersion,
            isOcr: config.isOcr,
            language: config.language,
            enableFormula: config.enableFormula,
            enableTable: config.enableTable,
            recursive: config.recursive,
        },
    };
}

function saveConfig(patch = {}) {
    if (patch.toolboxRoot) {
        const candidate = path.resolve(String(patch.toolboxRoot));
        if (!fs.existsSync(path.join(candidate, 'Plugin', 'MinerUParser', 'plugin-manifest.json'))) {
            throw new Error('所选目录不含 Plugin/MinerUParser，请选择 VCPToolBox 根目录。');
        }
        if (activeJobCount() > 0 && candidate !== path.resolve(toolboxRoot || '')) {
            throw new Error('有任务正在运行或排队，切换 VCPToolBox 目录前请先等待完成或停止全部任务。');
        }
    }
    const next = { ...config, ...patch };
    next.workers = clamp(next.workers, 1, JOB_CONCURRENCY_MAX);
    next.modelVersion = next.modelVersion === 'pipeline' ? 'pipeline' : 'vlm';
    next.isOcr = Boolean(next.isOcr);
    next.enableFormula = next.enableFormula !== false;
    next.enableTable = next.enableTable !== false;
    next.recursive = next.recursive !== false;
    next.language = typeof next.language === 'string' && next.language.trim() ? next.language.trim() : 'en';
    next.toolboxRoot = typeof next.toolboxRoot === 'string' ? next.toolboxRoot.trim() : '';
    atomicWriteJson(configPath, next);
    config = { ...DEFAULT_CONFIG, ...next };
    invalidateLibrary();
    resolveEnvironment();
    return config;
}

function initialize(options = {}) {
    if (initialized) return getStatus();
    initialized = true;
    projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..', '..');
    appDataRoot = options.appDataRoot || path.join(projectRoot, 'AppData');
    configDir = path.join(appDataRoot, 'MinerU');
    configPath = path.join(configDir, 'config.json');
    pdfMapPath = path.join(configDir, 'pdf-map.json');
    try {
        fs.mkdirSync(configDir, { recursive: true });
        loadConfig();
    } catch (error) {
        // AppData 只读或被同名文件占用时不能拖垮 VCPChat 启动；功能退化为默认配置。
        console.warn('[MinerU] 配置目录不可用：', sanitizeError(error));
        config = { ...DEFAULT_CONFIG };
    }
    resolveEnvironment();
    return getStatus();
}

function on(event, listener) {
    events.on(event, listener);
    return () => events.off(event, listener);
}

module.exports = {
    initialize,
    getStatus,
    saveConfig,
    scanLibrary,
    getRecord,
    getPaperDetail,
    readPdf,
    setPdfMapping,
    clearPdfMapping,
    resolveImagePath,
    resolveAssetDir,
    preflight,
    findDuplicates,
    startParse,
    continuePapers,
    cancelJob,
    cancelAll,
    listJobs,
    on,
    _events: events,
    _test: {
        setCommandRunner(fn) {
            commandRunner = typeof fn === 'function' ? fn : runCommand;
        },
        reset() {
            for (const internal of internals.values()) {
                if (internal.poll) clearInterval(internal.poll);
                try { internal.child?.kill('SIGKILL'); } catch { /* ignore */ }
            }
            jobs.clear();
            internals.clear();
            commandRunner = runCommand;
        },
        reinitialize(options = {}) {
            initialized = false;
            config = { ...DEFAULT_CONFIG };
            libraryCache = { at: 0, records: [] };
            pdfMapCache = { at: 0, map: {} };
            return initialize(options);
        },
        activeJobCount,
    },
};
