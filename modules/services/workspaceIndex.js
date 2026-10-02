// modules/services/workspaceIndex.js
// 工作区文件索引：只维护"有哪些文件路径"，文件内容由实时引用在发送时从磁盘重读，
// 因此这里只关心新增 / 删除 / 重命名。
//
// 更新策略：
// - 每个工作区一个 fs.watch(root, { recursive: true }) 句柄；
// - 事件先过默认忽略目录，再 debounce 批量做 stat 增量修正；
// - 事件风暴（git checkout / npm install）、.gitignore 变化、新增目录、监听失败
//   都只把工作区标脏，下一次查询时整树重扫；
// - 无法建立监听时退化为 TTL 过期重扫。
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const createIgnore = require('ignore');

// 默认忽略的目录名（大小写不敏感）。虚拟环境另外通过 pyvenv.cfg 识别。
const DEFAULT_IGNORED_DIRS = new Set([
    '.git', '.svn', '.hg',
    'node_modules', 'bower_components', 'jspm_packages', '.pnpm-store', '.yarn',
    '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox', '.hypothesis', '.ipynb_checkpoints',
    '.venv', 'venv', 'env', '.env', 'virtualenv', '.conda',
    '.next', '.nuxt', '.svelte-kit', '.angular', '.parcel-cache', '.turbo', '.vercel', '.cache', '.gradle',
    'dist', 'build', 'out', 'target', 'coverage', '.nyc_output',
    '.idea', '.vs', '.vscode-test',
    'assets', 'asset', 'appdata',
    'artifacts', 'artifact', 'vendor',
    'release', 'releases', 'temp', 'tmp',
]);
const DEFAULT_IGNORED_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const DEFAULT_IGNORED_FILE_EXTENSIONS = new Set(['.pyc', '.pyo', '.class', '.o', '.obj']);

const MAX_FILES_PER_WORKSPACE = 50000;
const WATCH_DEBOUNCE_MS = 250;
const WATCH_STORM_THRESHOLD = 300;
const FALLBACK_TTL_MS = 60_000;
const DEFAULT_SEARCH_LIMIT = 50;
const DEFAULT_TREE_MAX_CHARS = 20000;
const DEFAULT_TREE_MAX_DEPTH = 6;

const WORK_SLICE_SIZE = 256;
const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

function toPosix(p) {
    return String(p).split(path.sep).join('/').replace(/\\/g, '/');
}

function normalizeForCompare(p) {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInsideRoot(root, target) {
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isDefaultIgnoredDir(name) {
    const lower = String(name).toLowerCase();
    return DEFAULT_IGNORED_DIRS.has(lower) || lower.endsWith('.egg-info');
}

function isDefaultIgnoredFile(name) {
    const lower = String(name).toLowerCase();
    return DEFAULT_IGNORED_FILES.has(lower) || DEFAULT_IGNORED_FILE_EXTENSIONS.has(path.extname(lower));
}

function sanitizeAlias(raw) {
    return String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * 规范化 settings.workspaces：去重路径、生成唯一别名与稳定 id。
 * 接受字符串数组或对象数组 { id, alias, path, enabled }。
 */
function normalizeWorkspaceList(raw) {
    if (!Array.isArray(raw)) return [];
    const usedAliases = new Set();
    const seenPaths = new Set();
    const result = [];
    for (const item of raw) {
        const rawPath = typeof item === 'string' ? item : item?.path;
        if (typeof rawPath !== 'string' || !rawPath.trim()) continue;
        const resolved = path.resolve(rawPath.trim());
        const compareKey = normalizeForCompare(resolved);
        if (seenPaths.has(compareKey)) continue;
        seenPaths.add(compareKey);

        const baseAlias = sanitizeAlias(item?.alias) || sanitizeAlias(path.basename(resolved)) || 'workspace';
        let alias = baseAlias;
        let suffix = 2;
        while (usedAliases.has(alias)) alias = `${baseAlias}-${suffix++}`;
        usedAliases.add(alias);

        const id = typeof item?.id === 'string' && item.id.trim()
            ? item.id.trim()
            : `ws_${crypto.createHash('sha1').update(compareKey).digest('hex').slice(0, 12)}`;
        result.push({ id, alias, path: resolved, enabled: item?.enabled !== false });
    }
    return result;
}

function ancestorDirs(relPath) {
    // 'a/b/c.js' -> ['', 'a', 'a/b']
    const parts = relPath.split('/');
    const dirs = [''];
    for (let i = 1; i < parts.length; i += 1) dirs.push(parts.slice(0, i).join('/'));
    return dirs;
}

function matchesGitignore(ignoreByDir, relPath, isDirectory) {
    if (!ignoreByDir || ignoreByDir.size === 0) return false;
    for (const base of ancestorDirs(relPath)) {
        const matcher = ignoreByDir.get(base);
        if (!matcher) continue;
        const sub = base ? relPath.slice(base.length + 1) : relPath;
        if (!sub) continue;
        try {
            if (matcher.ignores(isDirectory ? `${sub}/` : sub)) return true;
        } catch {
            // 非法路径形式时忽略该规则，保持索引可用。
        }
    }
    return false;
}

function hasIgnoredSegment(relPath) {
    const parts = relPath.split('/');
    for (let i = 0; i < parts.length - 1; i += 1) {
        if (isDefaultIgnoredDir(parts[i])) return true;
    }
    return false;
}

function makeEntry(relPath) {
    const name = relPath.slice(relPath.lastIndexOf('/') + 1);
    return {
        name,
        relPath,
        lowerName: name.toLowerCase(),
        lowerRel: relPath.toLowerCase(),
        depth: relPath.split('/').length,
    };
}

/**
 * 全量扫描一个工作区。应用默认忽略、逐层 .gitignore、pyvenv.cfg 虚拟环境识别，
 * 不跟随符号链接，超过 maxFiles 时截断。
 */
async function scanWorkspace(root, { maxFiles = MAX_FILES_PER_WORKSPACE, shouldStop = () => false } = {}) {
    const files = new Map();
    const ignoreByDir = new Map();
    let truncated = false;
    const stack = [''];

    let processed = 0;

    while (stack.length > 0 && !truncated) {
        if (shouldStop()) return null;
        const relDir = stack.pop();
        const absDir = relDir ? path.join(root, ...relDir.split('/')) : root;
        let entries;
        try {
            entries = await fsp.readdir(absDir, { withFileTypes: true });
        } catch {
            continue;
        }

        if (shouldStop()) return null;
        // 目录内存在 pyvenv.cfg 即为 Python 虚拟环境，不论目录名。
        if (relDir && entries.some(entry => entry.isFile() && entry.name === 'pyvenv.cfg')) continue;

        if (entries.some(entry => entry.isFile() && entry.name === '.gitignore')) {
            try {
                const rules = await fsp.readFile(path.join(absDir, '.gitignore'), 'utf8');
                ignoreByDir.set(relDir, createIgnore().add(rules));
            } catch {
                // 读取失败时视为没有规则。
            }
        }

        for (const entry of entries) {
            if (++processed % WORK_SLICE_SIZE === 0) {
                await yieldToEventLoop();
                if (shouldStop()) return null;
            }
            if (entry.isSymbolicLink()) continue;
            const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (isDefaultIgnoredDir(entry.name)) continue;
                if (matchesGitignore(ignoreByDir, relPath, true)) continue;
                stack.push(relPath);
            } else if (entry.isFile()) {
                if (isDefaultIgnoredFile(entry.name)) continue;
                if (matchesGitignore(ignoreByDir, relPath, false)) continue;
                if (files.size >= maxFiles) {
                    truncated = true;
                    break;
                }
                files.set(relPath, makeEntry(relPath));
            }
        }
    }

    return { files, ignoreByDir, truncated };
}

// --- 目录树渲染（供 {{VCPChatWorkSpace}} 系统提示占位符使用） ---

function createTreeNode() {
    return { dirs: new Map(), files: [], count: 0 };
}

function buildTreeNodes(relPaths) {
    const root = createTreeNode();
    for (const relPath of relPaths) {
        const parts = relPath.split('/');
        let node = root;
        node.count += 1;
        for (let i = 0; i < parts.length - 1; i += 1) {
            let child = node.dirs.get(parts[i]);
            if (!child) {
                child = createTreeNode();
                node.dirs.set(parts[i], child);
            }
            child.count += 1;
            node = child;
        }
        node.files.push(parts[parts.length - 1]);
    }
    return root;
}

function compareTreeNames(a, b) {
    return a.localeCompare(b, 'en', { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * 深度优先渲染：目录在前、文件在后，均按名称排序。
 * maxDepth 为展示层数：1 = 只列顶层（顶层目录折叠为摘要），2 = 再展开一层，依此类推。
 */
function renderTreeLines(node, maxDepth, depth = 1, indent = '', out = { lines: [], collapsed: 0 }) {
    for (const name of [...node.dirs.keys()].sort(compareTreeNames)) {
        const child = node.dirs.get(name);
        if (depth >= maxDepth) {
            out.lines.push(`${indent}${name}/ (${child.count} 个文件，未展开)`);
            out.collapsed += 1;
        } else {
            out.lines.push(`${indent}${name}/`);
            renderTreeLines(child, maxDepth, depth + 1, `${indent}  `, out);
        }
    }
    for (const name of [...node.files].sort(compareTreeNames)) out.lines.push(`${indent}${name}`);
    return out;
}

/**
 * 在字符预算内渲染目录树：先按 maxDepth 渲染，超出预算时逐级降低展开深度，
 * 降到只剩顶层仍超出时按行硬截断。
 */
function renderWorkspaceTreeText(relPaths, { maxChars = DEFAULT_TREE_MAX_CHARS, maxDepth = DEFAULT_TREE_MAX_DEPTH } = {}) {
    const budget = Math.max(1, Math.floor(Number(maxChars) || DEFAULT_TREE_MAX_CHARS));
    const requestedDepth = Math.max(1, Math.floor(Number(maxDepth) || DEFAULT_TREE_MAX_DEPTH));
    const tree = buildTreeNodes(relPaths);

    for (let depth = requestedDepth; depth >= 1; depth -= 1) {
        const { lines, collapsed } = renderTreeLines(tree, depth);
        const text = lines.join('\n');
        if (text.length <= budget) {
            return { text, depth, requestedDepth, collapsedDirs: collapsed, omittedLines: 0 };
        }
    }

    const { lines, collapsed } = renderTreeLines(tree, 1);
    const kept = [];
    let used = 0;
    for (const line of lines) {
        const cost = line.length + (kept.length > 0 ? 1 : 0);
        if (used + cost > budget) break;
        kept.push(line);
        used += cost;
    }
    return {
        text: kept.join('\n'),
        depth: 1,
        requestedDepth,
        collapsedDirs: collapsed,
        omittedLines: lines.length - kept.length,
    };
}

function isSubsequence(needle, haystack) {
    let index = 0;
    for (const char of haystack) {
        if (char === needle[index]) index += 1;
        if (index === needle.length) return true;
    }
    return needle.length === 0;
}

function scoreEntry(entry, query) {
    if (!query) return 1;
    const { lowerName, lowerRel } = entry;
    if (query.includes('/')) {
        if (lowerRel === query) return 1000;
        if (lowerRel.endsWith(`/${query}`)) return 900;
        if (lowerRel.startsWith(query)) return 800;
        const index = lowerRel.indexOf(query);
        return index >= 0 ? 600 - Math.min(index, 100) : 0;
    }
    const stem = lowerName.replace(/\.[^.]+$/, '');
    if (lowerName === query || stem === query) return 1000;
    if (lowerName.startsWith(query)) return 800;
    const nameIndex = lowerName.indexOf(query);
    if (nameIndex >= 0) return 600 - Math.min(nameIndex, 50);
    const relIndex = lowerRel.indexOf(query);
    if (relIndex >= 0) return 300 - Math.min(relIndex, 100);
    if (query.length >= 2 && isSubsequence(query, lowerName)) return 100;
    return 0;
}

class WorkspaceIndex {
    constructor({ logger = console, maxFiles = MAX_FILES_PER_WORKSPACE, watch = true, scanConcurrency = 2 } = {}) {
        this.logger = logger;
        this.maxFiles = maxFiles;
        this.watchEnabled = watch;
        this.states = new Map(); // id -> state
        this.disposed = false;
        this.scanConcurrency = Math.max(1, Math.min(8, Math.floor(Number(scanConcurrency) || 2)));
        this.activeScans = 0;
        this.scanQueue = [];
    }

    configure(rawWorkspaces) {
        if (this.disposed) return [];
        const next = normalizeWorkspaceList(rawWorkspaces);
        const nextById = new Map(next.map(item => [item.id, item]));

        for (const [id, state] of this.states) {
            const replacement = nextById.get(id);
            if (!replacement
                || !replacement.enabled
                || normalizeForCompare(replacement.path) !== normalizeForCompare(state.config.path)) {
                this._disposeState(state);
                this.states.delete(id);
            }
        }

        for (const config of next) {
            const existing = this.states.get(config.id);
            if (existing) {
                existing.config = config;
                continue;
            }
            const state = {
                config,
                disposed: false,
                files: new Map(),
                ignoreByDir: new Map(),
                status: 'idle',
                dirty: true,
                truncated: false,
                error: null,
                scanPromise: null,
                watcher: null,
                pending: new Set(),
                flushTimer: null,
                lastScanAt: 0,
            };
            this.states.set(config.id, state);
            if (config.enabled) {
                // 后台预热，不阻塞调用方。
                void this._ensureReady(state).catch(() => {});
            }
        }
        return this.list();
    }

    list() {
        return [...this.states.values()].map(state => ({
            id: state.config.id,
            alias: state.config.alias,
            path: state.config.path,
            enabled: state.config.enabled,
            status: state.status,
            fileCount: state.files.size,
            truncated: state.truncated,
            watching: Boolean(state.watcher),
            error: state.error,
            lastScanAt: state.lastScanAt || null,
        }));
    }

    getEnabled() {
        return [...this.states.values()].filter(state => state.config.enabled);
    }

    findByAlias(alias) {
        const target = sanitizeAlias(alias);
        return this.getEnabled().find(state => state.config.alias === target) || null;
    }

    /**
     * 按"文件夹名"定位启用的工作区：先匹配别名（别名默认由文件夹名生成），
     * 再按根目录 basename 大小写不敏感匹配（用户改过别名时仍可用原文件夹名）。
     */
    findByName(name) {
        const raw = String(name || '').trim();
        if (!raw) return null;
        const byAlias = this.findByAlias(raw);
        if (byAlias) return byAlias;
        const lower = raw.toLowerCase();
        return this.getEnabled().find(state => path.basename(state.config.path).toLowerCase() === lower) || null;
    }

    /** 渲染某个启用工作区的目录树（会等待索引就绪）。未找到或已停用返回 null。 */
    async renderTree(workspaceId, options = {}) {
        const state = this.states.get(workspaceId);
        if (!state || !state.config.enabled) return null;
        await this._ensureReady(state).catch(() => {});
        const base = {
            id: state.config.id,
            alias: state.config.alias,
            path: state.config.path,
            status: state.status,
            error: state.error,
            fileCount: state.files.size,
            truncated: state.truncated,
        };
        if (state.status !== 'ready') return { ...base, text: '', depth: 0, requestedDepth: 0, collapsedDirs: 0, omittedLines: 0 };
        return { ...base, ...renderWorkspaceTreeText([...state.files.keys()], options) };
    }

    /** 判断一个绝对路径是否落在某个启用的工作区内（取最深的根目录）。 */
    resolveFile(absolutePath) {
        if (typeof absolutePath !== 'string' || !absolutePath) return null;
        let cleanPath = absolutePath.startsWith('file://') ? absolutePath.slice(7) : absolutePath;
        try { cleanPath = decodeURIComponent(cleanPath); } catch { /* keep raw */ }
        if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(cleanPath)) cleanPath = cleanPath.slice(1);
        const resolved = path.resolve(cleanPath);
        let best = null;
        for (const state of this.getEnabled()) {
            const root = state.config.path;
            if (!isInsideRoot(root, resolved) || normalizeForCompare(root) === normalizeForCompare(resolved)) continue;
            if (!best || root.length > best.config.path.length) best = state;
        }
        if (!best) return null;
        return {
            workspaceId: best.config.id,
            alias: best.config.alias,
            root: best.config.path,
            relPath: toPosix(path.relative(best.config.path, resolved)),
            absolutePath: resolved,
        };
    }

    /** 由 workspaceId/alias + relPath 重新定位绝对路径（工作区被移动后仍能解析）。 */
    resolveReference({ workspaceId, alias, relPath } = {}) {
        if (typeof relPath !== 'string' || !relPath) return null;
        const state = (workspaceId && this.states.get(workspaceId)) || (alias && this.findByAlias(alias));
        if (!state) return null;
        const absolutePath = path.resolve(state.config.path, ...relPath.split('/'));
        if (!isInsideRoot(state.config.path, absolutePath)) return null;
        return absolutePath;
    }

    async search(query, { alias = null, limit = DEFAULT_SEARCH_LIMIT } = {}) {
        const normalizedQuery = String(query || '').trim().toLowerCase().replace(/\\/g, '/').replace(/^\/+/, '');
        let targets = this.getEnabled();
        if (alias) {
            const state = this.findByAlias(alias);
            targets = state ? [state] : [];
        }
        await Promise.all(targets.map(state => this._ensureReady(state).catch(() => {})));

        const resultLimit = Math.max(1, Math.floor(Number(limit) || DEFAULT_SEARCH_LIMIT));
        const compare = (a, b) => (b.score - a.score)
            || (a.entry.depth - b.entry.depth)
            || a.entry.relPath.localeCompare(b.entry.relPath);
        const scored = [];
        let processed = 0;
        for (const state of targets) {
            if (!this._isStateActive(state)) continue;
            for (const entry of state.files.values()) {
                if (++processed % WORK_SLICE_SIZE === 0) {
                    // 仅排序当前候选集，避免对数十万匹配项做一次大排序。
                    scored.sort(compare);
                    scored.length = Math.min(scored.length, resultLimit);
                    await yieldToEventLoop();
                    if (this.disposed) return [];
                    if (!this._isStateActive(state)) break;
                }
                const score = scoreEntry(entry, normalizedQuery);
                if (score > 0) scored.push({ score, entry, state });
            }
        }
        scored.sort(compare);

        return scored.filter(item => this._isStateActive(item.state))
            .slice(0, resultLimit).map(({ entry, state }) => ({
            source: 'workspace',
            workspaceId: state.config.id,
            alias: state.config.alias,
            name: entry.name,
            relPath: entry.relPath,
            path: path.join(state.config.path, ...entry.relPath.split('/')),
        }));
    }

    async rebuild(workspaceId = null) {
        const targets = workspaceId
            ? [this.states.get(workspaceId)].filter(Boolean)
            : this.getEnabled();
        for (const state of targets) state.dirty = true;
        await Promise.all(targets.map(state => this._ensureReady(state).catch(() => {})));
        return this.list();
    }

    dispose() {
        this.disposed = true;
        for (const state of this.states.values()) this._disposeState(state);
        this.states.clear();
        this._drainScanQueue();
    }

    // --- internals ---

    _isStateActive(state) {
        return !this.disposed && !state.disposed && state.config.enabled
            && this.states.get(state.config.id) === state;
    }

    _scheduleScan(run) {
        return new Promise((resolve, reject) => {
            this.scanQueue.push({ run, resolve, reject });
            this._drainScanQueue();
        });
    }

    _drainScanQueue() {
        while (!this.disposed && this.activeScans < this.scanConcurrency && this.scanQueue.length) {
            const task = this.scanQueue.shift();
            this.activeScans++;
            // configure 只登记和排队，扫描不进入当前窗口初始化调用栈。
            void yieldToEventLoop().then(task.run).then(task.resolve, task.reject).finally(() => {
                this.activeScans--;
                this._drainScanQueue();
            });
        }
        if (this.disposed) {
            for (const task of this.scanQueue.splice(0)) task.resolve();
        }
    }

    async _ensureReady(state) {
        if (!this._isStateActive(state)) return;
        if (!state.watcher && state.status === 'ready' && Date.now() - state.lastScanAt > FALLBACK_TTL_MS) {
            state.dirty = true;
        }
        if (!state.dirty && state.status === 'ready') return;
        if (state.scanPromise) return state.scanPromise;

        state.status = 'queued';
        state.scanPromise = this._scheduleScan(async () => {
            if (!this._isStateActive(state)) return;
            state.status = 'scanning';
            state.dirty = false;
            const startedAt = Date.now();
            try {
                const stat = await fsp.stat(state.config.path);
                if (!stat.isDirectory()) throw new Error('工作区路径不是目录');
                if (!this._isStateActive(state)) return;
                const result = await scanWorkspace(state.config.path, {
                    maxFiles: this.maxFiles,
                    shouldStop: () => !this._isStateActive(state),
                });
                if (!result || !this._isStateActive(state)) return;
                state.files = result.files;
                state.ignoreByDir = result.ignoreByDir;
                state.truncated = result.truncated;
                state.error = null;
                state.status = 'ready';
                state.lastScanAt = Date.now();
                if (this.watchEnabled && !state.watcher) this._startWatcher(state);
                this.logger.log?.(`[WorkspaceIndex] ${state.config.alias}: ${state.files.size} files in ${Date.now() - startedAt}ms${state.truncated ? ' (truncated)' : ''}`);
            } catch (error) {
                if (!this._isStateActive(state)) return;
                state.status = 'error';
                state.error = error.message;
                state.files = new Map();
                this.logger.warn?.(`[WorkspaceIndex] Failed to scan ${state.config.path}:`, error.message);
            }
        }).finally(() => {
            state.scanPromise = null;
        });
        return state.scanPromise;
    }

    _startWatcher(state) {
        try {
            const watcher = fs.watch(state.config.path, { recursive: true, persistent: false }, (_eventType, filename) => {
                if (!filename) {
                    state.dirty = true;
                    return;
                }
                const relPath = toPosix(filename);
                if (hasIgnoredSegment(relPath) || isDefaultIgnoredDir(relPath.split('/').pop())) return;
                if (state.dirty) return; // 已标脏，下一次查询会整树重扫
                state.pending.add(relPath);
                if (state.pending.size > WATCH_STORM_THRESHOLD) {
                    state.pending.clear();
                    clearTimeout(state.flushTimer);
                    state.flushTimer = null;
                    state.dirty = true;
                    return;
                }
                clearTimeout(state.flushTimer);
                state.flushTimer = setTimeout(() => {
                    state.flushTimer = null;
                    void this._flushPending(state);
                }, WATCH_DEBOUNCE_MS);
            });
            watcher.on('error', error => {
                this.logger.warn?.(`[WorkspaceIndex] Watcher error for ${state.config.alias}:`, error?.message || error);
                try { watcher.close(); } catch { /* ignore */ }
                if (state.watcher === watcher) state.watcher = null;
                state.dirty = true;
            });
            state.watcher = watcher;
        } catch (error) {
            // 监听不可用时退化为 TTL 过期重扫。
            this.logger.warn?.(`[WorkspaceIndex] Cannot watch ${state.config.path}, using TTL rescans:`, error.message);
            state.watcher = null;
        }
    }

    async _flushPending(state) {
        const changed = [...state.pending];
        state.pending.clear();
        for (const relPath of changed) {
            if (state.dirty || this.states.get(state.config.id) !== state) return;
            const baseName = relPath.split('/').pop();
            if (baseName === '.gitignore' || baseName === 'pyvenv.cfg') {
                state.dirty = true;
                return;
            }
            const absPath = path.join(state.config.path, ...relPath.split('/'));
            let stat = null;
            try {
                stat = await fsp.lstat(absPath);
            } catch {
                stat = null;
            }
            if (!stat) {
                // 删除 / 重命名的旧名：移除文件本身及其子树。
                state.files.delete(relPath);
                const prefix = `${relPath}/`;
                for (const key of state.files.keys()) {
                    if (key.startsWith(prefix)) state.files.delete(key);
                }
                continue;
            }
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) {
                // 新目录（或目录重命名后的新名）交给下一次整树重扫，保证忽略规则一致。
                const prefix = `${relPath}/`;
                const known = [...state.files.keys()].some(key => key.startsWith(prefix));
                if (!known) state.dirty = true;
                continue;
            }
            if (stat.isFile()) {
                if (state.files.has(relPath)) continue;
                if (isDefaultIgnoredFile(baseName) || matchesGitignore(state.ignoreByDir, relPath, false)) continue;
                if (ancestorDirs(relPath).slice(1).some(dir => matchesGitignore(state.ignoreByDir, dir, true))) continue;
                if (state.files.size >= this.maxFiles) {
                    state.truncated = true;
                    continue;
                }
                state.files.set(relPath, makeEntry(relPath));
            }
        }
    }

    _disposeState(state) {
        state.disposed = true;
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
        state.pending.clear();
        if (state.watcher) {
            try { state.watcher.close(); } catch { /* ignore */ }
            state.watcher = null;
        }
    }
}

module.exports = {
    WorkspaceIndex,
    normalizeWorkspaceList,
    scanWorkspace,
    scoreEntry,
    renderWorkspaceTreeText,
    sanitizeAlias,
    DEFAULT_IGNORED_DIRS,
};