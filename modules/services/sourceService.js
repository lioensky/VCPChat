// modules/services/sourceService.js
// ProjectForge「源码」侧栏的主进程实现：工作区文件枚举、读写与格式检查。
// - 文件一律用"工作区根相对路径"（posix 分隔符）传递；解析后必须落在工作区根目录之内，
//   父目录经符号链接逃出工作区时拒绝，符号链接本身不列出、不读写，.git 目录不可访问。
// - 只编辑已存在的普通文件（不新建 / 删除 / 重命名）。仅支持 UTF-8：BOM 与换行风格原样保留，
//   非 UTF-8 文本以只读方式打开，避免保存时破坏编码。
// - 保存带内容哈希做乐观并发校验：打开后被 Agent / 外部程序改过的文件，需要显式 force 才能覆盖。
//   写入采用同目录临时文件 + rename，同一文件串行写。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_FILES = 20000;
const MAX_DEPTH = 32;
const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_WRITE_CHARS = 5 * 1024 * 1024;
const MAX_CHECK_CHARS = 2 * 1024 * 1024;
const MAX_DIAGNOSTICS = 100;
const BINARY_SNIFF_BYTES = 8000;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// 版本库元数据与依赖 / 缓存目录体量巨大且不应手工编辑，不参与列举
const IGNORED_DIRS = new Set([
    '.git', '.svn', '.hg',
    'node_modules', '__pycache__', '.venv', '.pytest_cache', '.mypy_cache',
]);

const IS_WIN = process.platform === 'win32';

// ============================ 路径工具 ============================

function toPosix(p) {
    return String(p).split(path.sep).join('/');
}

function realpathSafe(p) {
    try {
        return fs.realpathSync.native(p);
    } catch (_error) {
        return path.resolve(p);
    }
}

function isInsideRelative(rel) {
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function isInside(root, target) {
    return isInsideRelative(path.relative(root, target));
}

function isIgnoredDir(name) {
    return IGNORED_DIRS.has(IS_WIN ? name.toLowerCase() : name);
}

function resolveRoot(workspaceRoot) {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) throw new Error('缺少工作区根目录。');
    return realpathSafe(path.resolve(workspaceRoot));
}

/** 工作区相对路径 → { root, abs, rel }；越界、绝对路径、.git、符号链接逃逸一律拒绝。 */
function resolveWorkspacePath(workspaceRoot, relPath) {
    if (typeof relPath !== 'string' || !relPath.trim() || relPath.includes('\0')) {
        throw new Error('无效的文件路径。');
    }
    const normalized = relPath.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || path.isAbsolute(normalized)) {
        throw new Error(`必须使用工作区相对路径: ${relPath}`);
    }
    const root = resolveRoot(workspaceRoot);
    const abs = path.resolve(root, ...normalized.split('/').filter(Boolean));
    const rel = path.relative(root, abs);
    if (rel === '' || !isInsideRelative(rel)) throw new Error(`路径不在工作区内: ${relPath}`);
    if (rel.split(path.sep).some(segment => segment.toLowerCase() === '.git')) {
        throw new Error(`不允许访问 .git 目录: ${relPath}`);
    }
    if (!isInside(root, realpathSafe(path.dirname(abs)))) {
        throw new Error(`路径经符号链接指向工作区之外: ${relPath}`);
    }
    return { root, abs, rel: toPosix(rel) };
}

// ============================ 列举 ============================

/** 广度优先列出工作区内的普通文件（不跟随符号链接），按路径排序。 */
async function listFiles(workspaceRoot, { limit = MAX_FILES } = {}) {
    const root = resolveRoot(workspaceRoot);
    const stat = await fs.promises.stat(root).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`工作区目录不存在: ${root}`);

    const max = Math.max(1, Math.min(MAX_FILES, Number(limit) || MAX_FILES));
    const files = [];
    const queue = [{ dir: root, rel: '', depth: 0 }];
    let truncated = false;

    for (let head = 0; head < queue.length && !truncated; head += 1) {
        const { dir, rel, depth } = queue[head];
        let entries;
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (_error) {
            continue; // 无权限等情况跳过该目录
        }
        for (const entry of entries) {
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (!isIgnoredDir(entry.name) && depth + 1 < MAX_DEPTH) {
                    queue.push({ dir: path.join(dir, entry.name), rel: childRel, depth: depth + 1 });
                }
            } else if (entry.isFile()) {
                if (files.length >= max) {
                    truncated = true;
                    break;
                }
                files.push(childRel);
            }
        }
    }

    files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { root, files, truncated, limit: max, ignoredDirs: [...IGNORED_DIRS] };
}

// ============================ 读取 ============================

function sha1(buffer) {
    return crypto.createHash('sha1').update(buffer).digest('hex');
}

function hasBom(buffer) {
    return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

function detectEol(text) {
    let crlf = 0;
    let lf = 0;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
        if (i > 0 && text.charCodeAt(i - 1) === 13) crlf += 1;
        else lf += 1;
    }
    return crlf > lf ? '\r\n' : '\n';
}

function decodeBuffer(buffer) {
    const hash = sha1(buffer);
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        return { binary: true, editable: false, text: '', hash, bom: false, eol: '\n' };
    }
    const bom = hasBom(buffer);
    const body = bom ? buffer.subarray(3) : buffer;
    try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
        return { binary: false, editable: true, text, hash, bom, eol: detectEol(text) };
    } catch (_error) {
        const text = body.toString('utf8');
        return { binary: false, editable: false, encodingError: true, text, hash, bom, eol: detectEol(text) };
    }
}

async function statRegularFile(abs, rel) {
    let stat;
    try {
        stat = await fs.promises.lstat(abs);
    } catch (error) {
        if (error.code === 'ENOENT') throw new Error(`文件不存在（可能已被移动或删除）: ${rel}`);
        throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`不支持打开符号链接: ${rel}`);
    if (!stat.isFile()) throw new Error(`不是普通文件: ${rel}`);
    return stat;
}

async function readFile(workspaceRoot, relPath) {
    const target = resolveWorkspacePath(workspaceRoot, relPath);
    const stat = await statRegularFile(target.abs, target.rel);
    const base = {
        path: target.rel,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        checkLanguage: languageForPath(target.rel)?.label || null,
    };
    if (stat.size > MAX_READ_BYTES) {
        return { ...base, tooLarge: true, binary: false, editable: false, text: '', hash: null, bom: false, eol: '\n', limit: MAX_READ_BYTES };
    }
    const buffer = await fs.promises.readFile(target.abs);
    return { ...base, size: buffer.length, ...decodeBuffer(buffer) };
}

// ============================ 写入 ============================

const fileLocks = new Map();

function withFileLock(abs, fn) {
    const key = IS_WIN ? abs.toLowerCase() : abs;
    const previous = fileLocks.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    fileLocks.set(key, tail);
    tail.then(() => {
        if (fileLocks.get(key) === tail) fileLocks.delete(key);
    });
    return run;
}

/**
 * 覆盖写入已存在的文本文件。
 * content 按 '\n' 规范化后再转换为 eol（'\n' | '\r\n'，缺省沿用磁盘文件的风格）；原文件有 BOM 则保留。
 * expectedHash 与磁盘当前内容不一致时抛出 code='CONFLICT'，除非 force。
 */
function writeFile(workspaceRoot, relPath, { content, expectedHash = null, eol = null, force = false } = {}) {
    if (typeof content !== 'string') return Promise.reject(new Error('文件内容必须是字符串。'));
    if (content.length > MAX_WRITE_CHARS) return Promise.reject(new Error('文件内容过大，无法保存。'));
    let target;
    try {
        target = resolveWorkspacePath(workspaceRoot, relPath);
    } catch (error) {
        return Promise.reject(error);
    }

    return withFileLock(target.abs, async () => {
        const stat = await statRegularFile(target.abs, target.rel);
        const current = await fs.promises.readFile(target.abs);
        const currentHash = sha1(current);
        if (!force && expectedHash && currentHash !== expectedHash) {
            const error = new Error('文件在打开之后已被其他程序修改。');
            error.code = 'CONFLICT';
            throw error;
        }
        if (!force && current.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
            throw new Error('磁盘上的文件是二进制内容，已拒绝以文本覆盖。');
        }

        const currentDecoded = decodeBuffer(current);
        const targetEol = eol === '\r\n' || eol === '\n' ? eol : currentDecoded.eol;
        const normalized = content.replace(/\r\n?/g, '\n');
        const text = targetEol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
        const body = Buffer.from(text, 'utf8');
        const buffer = hasBom(current) ? Buffer.concat([UTF8_BOM, body]) : body;
        const hash = sha1(buffer);

        if (hash === currentHash) {
            return { path: target.rel, changed: false, hash, size: buffer.length, mtimeMs: stat.mtimeMs };
        }

        const dir = path.dirname(target.abs);
        const temp = path.join(dir, `.${path.basename(target.abs)}.pf-${process.pid}-${Date.now()}.tmp`);
        try {
            await fs.promises.writeFile(temp, buffer, { flag: 'wx' });
            if (!IS_WIN) await fs.promises.chmod(temp, stat.mode & 0o7777).catch(() => {});
            await fs.promises.rename(temp, target.abs);
        } finally {
            await fs.promises.rm(temp, { force: true }).catch(() => {});
        }
        const after = await fs.promises.stat(target.abs);
        return { path: target.rel, changed: true, hash, size: buffer.length, mtimeMs: after.mtimeMs };
    });
}

// ============================ 格式检查 ============================

const LANGUAGES = {
    json: { label: 'JSON', kind: 'json' },
    jsonc: { label: 'JSONC', kind: 'json', jsonc: true },
    javascript: { label: 'JavaScript', kind: 'script', plugins: ['jsx'] },
    typescript: { label: 'TypeScript', kind: 'script', plugins: ['typescript', 'decorators-legacy'] },
    tsx: { label: 'TSX', kind: 'script', plugins: ['typescript', 'jsx', 'decorators-legacy'] },
    yaml: { label: 'YAML', kind: 'yaml' },
    toml: { label: 'TOML', kind: 'toml' },
    css: { label: 'CSS', kind: 'css' },
};

const EXT_LANGUAGE = {
    json: 'json', jsonc: 'jsonc',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
    yaml: 'yaml', yml: 'yaml',
    toml: 'toml',
    css: 'css',
};

/** 允许注释 / 尾逗号的常见 JSON 配置文件 */
function isJsoncPath(relPath) {
    const posix = String(relPath).replace(/\\/g, '/');
    const base = posix.split('/').pop().toLowerCase();
    return /^(tsconfig|jsconfig)(\..+)?\.json$/.test(base)
        || /(^|\/)\.vscode\/[^/]+\.json$/i.test(posix)
        || base === '.eslintrc.json' || base === '.babelrc' || base === 'devcontainer.json';
}

function languageForPath(relPath) {
    const base = String(relPath || '').split(/[\\/]/).pop();
    if (isJsoncPath(relPath)) return LANGUAGES.jsonc;
    const dot = base.lastIndexOf('.');
    if (dot <= 0 && !base.startsWith('.')) return null;
    const key = EXT_LANGUAGE[base.slice(dot + 1).toLowerCase()];
    return key ? LANGUAGES[key] : null;
}

function offsetToLineCol(text, offset) {
    const end = Math.max(0, Math.min(offset, text.length));
    let line = 1;
    let lineStart = 0;
    for (let i = text.indexOf('\n'); i !== -1 && i < end; i = text.indexOf('\n', i + 1)) {
        line += 1;
        lineStart = i + 1;
    }
    return { line, column: end - lineStart + 1 };
}

/**
 * 严格 JSON 扫描器：给出首个错误的精确偏移，并收集重复键警告。
 * jsonc=true 时允许 // 与 /* *\/ 注释以及尾逗号。
 */
function scanJson(text, { jsonc = false } = {}) {
    const n = text.length;
    const warnings = [];
    let i = 0;

    const fail = (message, at = i) => {
        const error = new Error(message);
        error.offset = at;
        throw error;
    };

    function skipWs() {
        for (;;) {
            const c = text.charCodeAt(i);
            if (c === 32 || c === 9 || c === 10 || c === 13 || (c === 0xfeff && i === 0)) {
                i += 1;
                continue;
            }
            if (c === 47 && jsonc) {
                const next = text[i + 1];
                if (next === '/') {
                    while (i < n && text[i] !== '\n') i += 1;
                    continue;
                }
                if (next === '*') {
                    const end = text.indexOf('*/', i + 2);
                    if (end === -1) fail('块注释未闭合');
                    i = end + 2;
                    continue;
                }
            }
            if (c === 47 && !jsonc && (text[i + 1] === '/' || text[i + 1] === '*')) {
                fail('标准 JSON 不允许注释');
            }
            return;
        }
    }

    function string() {
        const start = i;
        i += 1;
        while (i < n) {
            const c = text.charCodeAt(i);
            if (c === 34) {
                i += 1;
                return JSON.parse(text.slice(start, i));
            }
            if (c === 92) {
                const esc = text[i + 1];
                if (esc && '"\\/bfnrt'.includes(esc)) {
                    i += 2;
                    continue;
                }
                if (esc === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
                    i += 6;
                    continue;
                }
                fail('无效的转义序列');
            }
            if (c < 0x20) fail(c === 10 || c === 13 ? '字符串未闭合（字符串内不能直接换行）' : '字符串中含有未转义的控制字符');
            i += 1;
        }
        return fail('字符串未闭合', start);
    }

    const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    function number() {
        NUMBER.lastIndex = i;
        const match = NUMBER.exec(text);
        if (!match) fail('无效的数字');
        const next = text[i + match[0].length];
        if (next && /[0-9.eE+\-]/.test(next)) fail('无效的数字格式');
        i += match[0].length;
    }

    function value(depth) {
        if (depth > 512) fail('嵌套层级过深');
        skipWs();
        if (i >= n) fail('意外的文件结尾，此处应为值');
        const c = text[i];
        if (c === '{') return object(depth);
        if (c === '[') return array(depth);
        if (c === '"') return string();
        if (c === '-' || (c >= '0' && c <= '9')) return number();
        for (const literal of ['true', 'false', 'null']) {
            if (text.startsWith(literal, i)) {
                i += literal.length;
                return undefined;
            }
        }
        if (c === "'") return fail('JSON 字符串必须使用双引号');
        return fail(`意外的字符 ${JSON.stringify(c)}，此处应为值`);
    }

    function object(depth) {
        i += 1;
        const keys = new Set();
        skipWs();
        if (text[i] === '}') {
            i += 1;
            return;
        }
        for (;;) {
            skipWs();
            if (text[i] !== '"') {
                if (i >= n) fail('对象未闭合，缺少 }');
                fail(text[i] === "'" ? '属性名必须使用双引号' : '此处应为属性名（双引号字符串）');
            }
            const keyStart = i;
            const key = string();
            if (keys.has(key)) warnings.push({ offset: keyStart, message: `重复的键 "${key}"` });
            keys.add(key);
            skipWs();
            if (text[i] !== ':') fail(i >= n ? '对象未闭合，缺少 }' : '属性名之后应为冒号 :');
            i += 1;
            value(depth + 1);
            skipWs();
            if (text[i] === ',') {
                const comma = i;
                i += 1;
                skipWs();
                if (text[i] === '}') {
                    if (!jsonc) fail('对象末尾有多余的逗号', comma);
                    i += 1;
                    return;
                }
                continue;
            }
            if (text[i] === '}') {
                i += 1;
                return;
            }
            fail(i >= n ? '对象未闭合，缺少 }' : '此处应为逗号 , 或 }');
        }
    }

    function array(depth) {
        i += 1;
        skipWs();
        if (text[i] === ']') {
            i += 1;
            return;
        }
        for (;;) {
            value(depth + 1);
            skipWs();
            if (text[i] === ',') {
                const comma = i;
                i += 1;
                skipWs();
                if (text[i] === ']') {
                    if (!jsonc) fail('数组末尾有多余的逗号', comma);
                    i += 1;
                    return;
                }
                continue;
            }
            if (text[i] === ']') {
                i += 1;
                return;
            }
            fail(i >= n ? '数组未闭合，缺少 ]' : '此处应为逗号 , 或 ]');
        }
    }

    try {
        skipWs();
        if (i >= n) fail('文件为空，不是有效的 JSON');
        value(0);
        skipWs();
        if (i < n) fail('JSON 值之后存在多余内容');
        return { error: null, warnings };
    } catch (error) {
        if (typeof error.offset !== 'number') throw error;
        return { error: { offset: error.offset, message: error.message }, warnings };
    }
}

function checkJson(text, language) {
    const result = scanJson(text, { jsonc: Boolean(language.jsonc) });
    const diagnostics = result.warnings.map(w => ({ ...offsetToLineCol(text, w.offset), message: w.message, severity: 'warning' }));
    if (result.error) {
        diagnostics.push({ ...offsetToLineCol(text, result.error.offset), message: result.error.message, severity: 'error' });
    }
    return diagnostics;
}

function babelDiagnostic(error) {
    return {
        line: error.loc?.line || 1,
        column: (error.loc?.column ?? 0) + 1,
        message: String(error.message || error).replace(/\s*\(\d+:\d+\)\s*$/, ''),
        severity: 'error',
        code: error.reasonCode || null,
    };
}

function checkScript(text, language) {
    const { parse } = require('@babel/parser');
    const diagnostics = [];
    try {
        const ast = parse(text, {
            sourceType: 'unambiguous',
            errorRecovery: true,
            allowReturnOutsideFunction: true,
            allowAwaitOutsideFunction: true,
            allowImportExportEverywhere: true,
            allowSuperOutsideMethod: true,
            allowUndeclaredExports: true,
            allowNewTargetOutsideFunction: true,
            plugins: language.plugins,
        });
        for (const error of ast.errors || []) diagnostics.push(babelDiagnostic(error));
    } catch (error) {
        diagnostics.push(babelDiagnostic(error));
    }
    return diagnostics;
}

function checkYaml(text) {
    const yaml = require('js-yaml');
    try {
        if (typeof yaml.loadAll === 'function') yaml.loadAll(text, () => {});
        else yaml.load(text);
        return [];
    } catch (error) {
        return [{
            line: (error.mark?.line ?? 0) + 1,
            column: (error.mark?.column ?? 0) + 1,
            message: String(error.reason || error.message || error).split('\n')[0],
            severity: 'error',
        }];
    }
}

function checkToml(text) {
    const { parse } = require('smol-toml');
    try {
        parse(text);
        return [];
    } catch (error) {
        return [{
            line: Number(error.line) || 1,
            column: Number(error.column) || 1,
            message: String(error.message || error).split('\n')[0].replace(/^Invalid TOML document:\s*/i, ''),
            severity: 'error',
        }];
    }
}

function checkCss(text) {
    const csstree = require('css-tree');
    const diagnostics = [];
    try {
        csstree.parse(text, {
            positions: true,
            onParseError: error => diagnostics.push({
                line: error.line || 1,
                column: error.column || 1,
                message: String(error.message || error),
                severity: 'error',
            }),
        });
    } catch (error) {
        diagnostics.push({ line: error.line || 1, column: error.column || 1, message: String(error.message || error), severity: 'error' });
    }
    return diagnostics;
}

/** 按文件类型做语法 / 格式检查；不支持的类型返回 supported=false。 */
function checkSyntax(relPath, text) {
    const language = languageForPath(relPath);
    if (!language) return { supported: false, language: null, ok: true, errorCount: 0, warningCount: 0, diagnostics: [] };
    if (typeof text !== 'string') throw new Error('待检查内容必须是字符串。');
    if (text.length > MAX_CHECK_CHARS) throw new Error('文件过大，已跳过格式检查。');

    let diagnostics;
    if (language.kind === 'json') diagnostics = checkJson(text, language);
    else if (language.kind === 'script') diagnostics = checkScript(text, language);
    else if (language.kind === 'yaml') diagnostics = checkYaml(text);
    else if (language.kind === 'toml') diagnostics = checkToml(text);
    else diagnostics = checkCss(text);

    diagnostics.sort((a, b) => a.line - b.line || a.column - b.column);
    const errorCount = diagnostics.filter(d => d.severity === 'error').length;
    return {
        supported: true,
        language: language.label,
        ok: errorCount === 0,
        errorCount,
        warningCount: diagnostics.length - errorCount,
        diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
        truncated: diagnostics.length > MAX_DIAGNOSTICS,
    };
}

module.exports = {
    listFiles,
    readFile,
    writeFile,
    checkSyntax,
    languageForPath,
    // 供测试使用
    resolveWorkspacePath,
    scanJson,
    detectEol,
    IGNORED_DIRS,
    MAX_READ_BYTES,
};