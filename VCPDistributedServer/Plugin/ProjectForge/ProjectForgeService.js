'use strict';
// ProjectForge：面向 Agent 的工程化代码施工插件（hybridservice / direct，常驻有状态）。
//
// - 工程（projectId）绑定工作区根目录，所有文件路径相对工程根书写；写入白名单 = 已启用工作区 + 配置目录。
// - 每次写入（创建/编辑/删除/移动/回退）都生成批次 + 节点，完整快照存入 SQLite，并强制记录 reason。
// - 行级编辑串：行号以原始快照为准；target 多处命中时签发票据，AI 用 ResolveEdit 只回传选择。
// - 删除一律移到系统回收站；删除工程只动数据库，从不触碰磁盘文件。
// 返回值遵循 direct 插件约定：{ content: [OpenAI content parts], details }，错误直接 throw。

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const EventEmitter = require('events');
const { ProjectStore, sha256 } = require('./store');
const { applyGuiRevert } = require('./gui-revert-file');
const engine = require('./engine');
const { WorkspaceResolver } = require('./workspace');
const { TicketStore, parsePickSpec } = require('./tickets');
const { IndexerClient } = require('./indexerClient');
const SR = require('./symbolResolver');
const LG = require('./linkGraph');
const { isPathInside, toPosixRelative } = require('../../shared/fileKit/paths');
const A = require('./args');
const T = require('../../shared/fileKit/text');
const { validateCode, diffDiagnostics, isValidatable } = require('../../shared/fileKit/validator');
const { unifiedDiff } = require('../../shared/fileKit/diff');
const { readFilesAsContent } = require('../../shared/fileKit/reader');
const { isBinaryExtension, parseBinaryBuffer } = require('../../shared/fileKit/binaryReader');
const { textResult, partsResult, formatDiagnostics } = require('../../shared/fileKit/output');

const P = '[ProjectForge]';
const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', '..', 'AppData', 'ProjectForge', 'projectforge.db');
const UTF8_BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

const projectEvents = new EventEmitter();
projectEvents.setMaxListeners(50);

function emitProjectChanged(payload = {}) {
    try {
        projectEvents.emit('changed', {
            timestamp: Date.now(),
            ...payload,
        });
    } catch (e) {
        runtime.logger?.warn?.(`${P} 广播工程变更事件失败:`, e?.message || e);
    }
}
function posInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** 配置布尔值容错解析：非法值不阻断插件初始化，按默认值处理并告警。 */
function configBool(value, fallback, name, logger) {
    try {
        return A.bool(value, fallback);
    } catch (_e) {
        logger?.warn?.(`${P} 配置 ${name}=${value} 无法识别为布尔值，按默认 ${fallback} 处理。`);
        return fallback;
    }
}

// 忽略目录唯一来源：主进程工作区索引的 DEFAULT_IGNORED_DIRS。
// 引用失败时不传 ignoreDirs，由索引器内置的同一份列表兜底（不影响施工）。
let ignoredDirsCache;
function astIgnoreDirs() {
    if (ignoredDirsCache === undefined) {
        try {
            const { DEFAULT_IGNORED_DIRS } = require('../../../modules/services/workspaceIndex');
            ignoredDirsCache = DEFAULT_IGNORED_DIRS ? [...DEFAULT_IGNORED_DIRS] : null;
        } catch (error) {
            ignoredDirsCache = null;
            runtime.logger?.warn?.(`${P} 无法载入工作区忽略目录列表，改用索引器内置列表：${error.message}`);
        }
    }
    return ignoredDirsCache || undefined;
}

function freshRuntime(overrides = {}) {
    return {
        store: null,
        resolver: new WorkspaceResolver(),
        tickets: new TicketStore(),
        logger: console,
        dbPath: DEFAULT_DB_PATH,
        maxEditSize: 5 * 1024 * 1024,
        readMaxFiles: 20,
        readMaxBytes: 30 * 1024 * 1024,
        trash: null, // 可注入（单测用）；为空时使用系统回收站
        indexer: null, // AST 符号索引客户端；只创建对象，首次需要符号时才启动进程
        initialized: false,
        ...overrides,
    };
}

let runtime = freshRuntime();
const locks = new Map();

// ============================ 生命周期 ============================

function initialize(options = {}) {
    closeStore();
    const previousIndexer = runtime.indexer;
    if (previousIndexer) previousIndexer.stop().catch(() => { /* 旧进程已退出 */ });
    const config = options.config || {};
    const logger = options.logger || console;
    runtime = freshRuntime({
        resolver: new WorkspaceResolver({
            workspaceService: options.services?.workspaceService || options.workspaceService || null,
            extraAllowed: String(config.ALLOWED_DIRECTORIES || '').split(','),
        }),
        logger,
        dbPath: config.PROJECTFORGE_DB_PATH ? path.resolve(config.PROJECTFORGE_DB_PATH) : (options.dbPath || DEFAULT_DB_PATH),
        maxEditSize: posInt(config.MAX_EDIT_FILE_SIZE, 5 * 1024 * 1024),
        readMaxFiles: posInt(config.READ_MAX_FILES, 20),
        readMaxBytes: posInt(config.READ_MAX_TOTAL_BYTES, 30 * 1024 * 1024),
        trash: typeof options.trash === 'function' ? options.trash : null,
        indexer: new IndexerClient({
            logger,
            binaryPath: options.indexerBinaryPath,
            disabled: !configBool(config.AST_INDEX_ENABLED, true, 'AST_INDEX_ENABLED', logger),
        }),
        initialized: true,
    });
}

/**
 * 供 VChat 主进程的 GUI 使用：分布式服务器未启用时插件不会被初始化，
 * 这里按同样的配置懒初始化；已初始化则保持插件自身的运行时不变。
 */
function ensureRuntime(options = {}) {
    if (!runtime.initialized) initialize(options);
    return runtime;
}

function closeStore() {
    try { runtime.store?.close(); } catch (_e) { /* 已关闭 */ }
    runtime.store = null;
    runtime.tickets?.clear();
}

async function stopIndexer() {
    const indexer = runtime.indexer;
    if (!indexer) return;
    try { await indexer.stop(); } catch (_e) { /* 已退出 */ }
}

async function cleanup() {
    closeStore();
    await stopIndexer();
}

function store() {
    if (!runtime.store) runtime.store = new ProjectStore(runtime.dbPath);
    return runtime.store;
}

/** 同一工程的写操作串行执行，避免并发 Agent 交错写入。 */
async function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const chain = prev.then(() => gate);
    locks.set(key, chain);
    await prev;
    try {
        return await fn();
    } finally {
        release();
        if (locks.get(key) === chain) locks.delete(key);
    }
}

// ============================ 通用辅助 ============================

function fmtTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function idNum(ref, prefix, label) {
    const raw = String(ref ?? '').trim();
    const n = Number(raw.replace(new RegExp(`^${prefix}`, 'i'), ''));
    if (!Number.isInteger(n) || n < 1) throw new Error(`${P} ${label} 无效：“${raw}”，应形如 ${prefix}12`);
    return n;
}

const TODO_ICON = { pending: '[ ]', doing: '[~]', done: '[x]', blocked: '[!]' };
const KIND_LABEL = { edit: '编辑', create: '新建', remove: '删除', move: '移动', rollback: '回退', external: '外部修改' };

function todoProgress(todos) {
    const done = todos.filter(t => t.status === 'done').length;
    return { done, total: todos.length, text: todos.length ? `${done}/${todos.length}` : '无' };
}

function renderTodos(todos) {
    if (!todos.length) return '- （暂无 todo）';
    return todos.map(t => `- ${TODO_ICON[t.status] || '[ ]'} #${t.seq} ${t.title}${t.note ? ` — ${t.note}` : ''}`).join('\n');
}

function whoOf(maid, kind) {
    if (maid) return `@${maid}`;
    return kind === 'external' ? '@外部' : '@未署名';
}

function renderTimeline(rows) {
    if (!rows.length) return '- （暂无改动）';
    return rows.map(r => {
        const files = String(r.files || '').split(',').filter(Boolean);
        const shown = files.slice(0, 5).map(f => `\`${f}\``).join('、') + (files.length > 5 ? ` 等 ${files.length} 个` : '');
        return `- \`b${r.id}\` · ${KIND_LABEL[r.kind] || r.kind} · ${whoOf(r.maid, r.kind)} · ${fmtTime(r.created_at)} · ${r.reason || '（未记录原因）'}\n  - ${shown} (+${r.added}/-${r.removed})`;
    }).join('\n');
}

function renderContributors(rows) {
    if (!rows.length) return '- （暂无）';
    return rows.map(r => `- ${whoOf(r.maid, r.maid ? null : 'external')}：${r.batches} 次改动 · +${r.added}/-${r.removed} · 最近 ${fmtTime(r.last_at)}`).join('\n');
}

function projectHeader(project, rootInfo) {
    return `- 工程：${project.name}（\`${project.id}\`）· 状态 ${project.status}\n- 根目录：${rootInfo.root}${rootInfo.workspaceAlias ? `（工作区 \`${rootInfo.workspaceAlias}\`）` : ''}${rootInfo.writable ? '' : `\n- ⚠️ ${rootInfo.blockedReason}`}`;
}

function projectOf(args, { write = false } = {}) {
    const id = A.str(args, 'projectId', 'project', 'id');
    if (!id) throw new Error(`${P} 缺少 projectId。可用 ListProjects 查询已有工程。`);
    const project = store().getProject(id);
    if (!project) throw new Error(`${P} 工程 ${id} 不存在或已删除。可用 ListProjects 查询。`);
    const rootInfo = runtime.resolver.projectRoot(project);
    if (write && !rootInfo.writable) throw new Error(`${P} ${rootInfo.blockedReason}`);
    return { project, rootInfo };
}

function fileOf(ctx, input, { write = false } = {}) {
    const file = runtime.resolver.resolveInProject(ctx.rootInfo, input);
    if (write && !runtime.resolver.isWritable(file.abs)) {
        throw new Error(`${P} 路径不在已启用工作区或允许目录内：${file.abs}`);
    }
    return file;
}

/**
 * 操作者署名：maid 为 VCP 中央注入字段，可能是字符串、{ name, id } 对象或其 JSON 字符串。
 * 注意：args.maid 是“调用者自己”，按操作者过滤历史请用 byMaid。
 */
function maidOf(args) {
    let raw = args.maid;
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw === 'string' && raw.trim().startsWith('{')) {
        try { raw = JSON.parse(raw); } catch (_e) { /* 按普通字符串处理 */ }
    }
    const name = typeof raw === 'object' ? (raw.name || raw.signature || raw.id || '') : raw;
    const value = String(name).trim();
    return value ? value.slice(0, 100) : null;
}

function todoOf(project, args) {
    const raw = A.pick(args, 'todo', 'todoId');
    if (raw === undefined) return null;
    const seq = Number(String(raw).replace(/^#/, '').trim());
    const todo = Number.isInteger(seq) ? store().getTodoBySeq(project.id, seq) : null;
    if (!todo) throw new Error(`${P} todo #${raw} 不存在。可用 GetProject 查看 todo 列表。`);
    if (todo.status === 'pending') store().updateTodo(project.id, seq, { status: 'doing' });
    return todo;
}

// ============================ 文件 IO ============================

async function readDisk(abs) {
    let buffer;
    try {
        const stat = await fsp.stat(abs);
        if (stat.isDirectory()) throw Object.assign(new Error(`${P} ${abs} 是目录，不是文件。`), { code: 'EISDIR_PF' });
        buffer = await fsp.readFile(abs);
    } catch (error) {
        if (error.code === 'ENOENT') return { exists: false, buffer: null, hash: null };
        throw error;
    }
    return { exists: true, buffer, hash: sha256(buffer) };
}

/**
 * 写盘前复核：读取与写入之间可能夹着 await（代码审查、回退规划），
 * 期间文件若被外部修改（编辑器、其他插件、另一个工程），直接写入会静默覆盖。
 * hash 不一致时放弃写入，交由调用方重新读取。
 */
async function assertDiskUnchanged(abs, expectedHash, rel) {
    const now = await readDisk(abs);
    if (now.hash !== expectedHash) {
        const short = h => (h ? String(h).slice(0, 8) : '不存在');
        throw new Error(`${P} ${rel} 在处理期间被外部修改（读取时 ${short(expectedHash)}，写入前 ${short(now.hash)}），为避免覆盖已放弃写入。请重新 ReadCode 后再操作。`);
    }
}

function decodeText(buffer, rel) {
    if (buffer.length > runtime.maxEditSize) {
        throw new Error(`${P} ${rel} 超过可编辑上限 ${T.formatFileSize(runtime.maxEditSize)}。`);
    }
    if (buffer.subarray(0, 8000).includes(0)) {
        throw new Error(`${P} ${rel} 是二进制或 UTF-16 文件，不能按文本编辑。`);
    }
    const bom = buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF;
    const raw = buffer.toString('utf8', bom ? 3 : 0);
    return { bom, lineEnding: T.detectLineEnding(raw), text: T.normalizeEol(raw) };
}

function encodeText(normalized, meta) {
    const body = Buffer.from(T.applyLineEnding(normalized, meta.lineEnding), 'utf8');
    return meta.bom ? Buffer.concat([UTF8_BOM, body]) : body;
}

async function moveToTrash(abs) {
    try {
        if (runtime.trash) {
            await runtime.trash(abs);
        } else {
            const { default: trash } = await import('trash');
            await trash(abs);
        }
    } catch (error) {
        throw new Error(`${P} 移到回收站失败，文件未删除：${abs}（${error.message}）`);
    }
}

/**
 * 外部漂移检测：磁盘 hash 与插件最后已知 hash 不一致时，自动记一个 external 节点，
 * 保证后续回退不会悄悄吞掉用户的手动修改。
 */
function recordExternalDrift(project, rel, disk) {
    const s = store();
    const known = s.getFileState(project.id, rel);
    if (known === undefined || known === disk.hash) return null;
    s.transaction(() => {
        const batchId = s.createBatch(project.id, 'external', '检测到非 ProjectForge 写入的外部修改（自动记录）');
        s.putBlob(disk.buffer);
        s.addNode({
            projectId: project.id, batchId, filePath: rel, op: 'external',
            beforeHash: known, afterHash: disk.hash, summary: disk.exists ? '外部修改' : '外部删除',
        });
    });
    return `检测到 \`${rel}\` 有外部修改，已自动记录为 external 节点（可回退）。`;
}

async function reviewCode(abs, before, after) {
    if (!isValidatable(abs)) return { supported: false, introduced: [], existing: 0 };
    const [b, a] = await Promise.all([validateCode(abs, before), validateCode(abs, after)]);
    return { supported: true, introduced: diffDiagnostics(b, a), existing: b.length };
}

function renderReview(review) {
    if (!review.supported) return '';
    if (!review.introduced.length) {
        return `### 代码审查\n- ✅ 未引入新问题${review.existing ? `（存量 ${review.existing} 项未计入）` : ''}`;
    }
    return `### 代码审查（本次新增 ${review.introduced.length} 项）\n${formatDiagnostics(review.introduced, '')}`;
}

function renderDiff(before, after, rel) {
    const d = unifiedDiff(before, after, { oldLabel: `a/${rel}`, newLabel: `b/${rel}` });
    return { ...d, block: d.text ? `### Diff (+${d.added} -${d.removed})\n${T.markdownFence(d.text, 'diff')}` : '' };
}

// ============================ 工作区与工程 ============================

async function listWorkspaces() {
    const list = runtime.resolver.list();
    const activeId = runtime.resolver.active()?.id;
    const lines = list.map(ws => `- \`${ws.alias}\`${ws.id === activeId ? '（当前）' : ''} · ${ws.enabled ? '启用' : '停用'} · ${ws.path}`);
    return textResult(`## 工作区\n${lines.join('\n') || '- （无）请先在“全局设置 → 工作区管理”中登记工作区。'}`, { command: 'ListWorkspaces', workspaces: list });
}

async function createProject(args) {
    const name = A.str(args, 'name', 'projectName');
    if (!name) throw new Error(`${P} CreateProject 需要 name。`);
    const target = runtime.resolver.resolveNewProjectRoot(A.str(args, 'workspace', 'workspaceAlias'), A.str(args, 'dir', 'directory', 'root'));
    await fsp.mkdir(target.root, { recursive: true });
    const s = store();
    const maid = maidOf(args);
    const project = s.createProject({
        createdBy: maid,
        name: name.slice(0, 200),
        workspaceId: target.workspace?.id,
        workspaceAlias: target.workspace?.alias,
        root: target.root,
        subpath: target.subpath,
    });
    const titles = A.list(A.pick(args, 'todos', 'todo'));
    if (titles.length) s.addTodos(project.id, titles, maid);
    const todos = s.listTodos(project.id);
    return textResult([
        `## ✅ 工程已创建：${project.name}`,
        `- projectId：\`${project.id}\`（后续所有施工命令只需传这个 ID）`,
        `- 创建者：${whoOf(maid)}`,
        `- 根目录：${target.root}${target.workspace ? `（工作区 \`${target.workspace.alias}\`）` : ''}`,
        '- 文件路径请相对根目录书写，例如 `src/index.js`',
        '### Todo',
        renderTodos(todos),
    ].join('\n'), { command: 'CreateProject', project, todos });
}

async function listProjects(args, command = 'ListProjects') {
    const ws = A.str(args, 'workspace', 'workspaceAlias');
    const all = !ws || ws.toLowerCase() === 'all';
    const workspace = all ? null : runtime.resolver.find(ws, { includeDisabled: true });
    const rawLimit = A.pick(args, 'limit');
    const limit = rawLimit === undefined ? 10 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`${P} limit 必须是正整数（默认 10）。`);
    const s = store();
    const rows = s.listProjects({
        workspaceId: workspace?.id || null,
        workspaceAlias: all ? null : (workspace?.alias || ws.toLowerCase()),
        includeDeleted: A.bool(A.pick(args, 'includeDeleted'), false),
        query: A.str(args, 'query') || null,
        limit,
    });
    const lines = rows.map(p => {
        const prog = todoProgress(s.listTodos(p.id));
        return `| \`${p.id}\` | ${p.name} | ${p.workspace_alias || '-'} | ${p.deleted_at ? '已删除' : p.status} | ${prog.text} | ${p.report ? '有' : '-'} | ${fmtTime(p.updated_at)} |`;
    });
    const text = rows.length
        ? `## 工程列表（${all ? '全部工作区' : `工作区 ${ws}`}，${rows.length} 个，按最近更新排序，最多 ${limit} 个）\n| ID | 名称 | 工作区 | 状态 | Todo | 报告 | 更新 |\n|---|---|---|---|---|---|---|\n${lines.join('\n')}\n- 默认显示最新 10 个；可用 limit 指定返回数量。`
        : `## 工程列表\n- 没有匹配的工程。可用 CreateProject 创建。`;
    return textResult(text, { command, count: rows.length, limit, projects: rows });
}

async function searchProjects(args) {
    const ws = A.str(args, 'workspace', 'workspaceAlias');
    if (!ws || ws.toLowerCase() === 'all') throw new Error(`${P} SearchProjects 需要 workspace（指定工作区别名或 ID，不能为 all）。`);
    if (!runtime.resolver.find(ws, { includeDisabled: true })) throw new Error(`${P} 工作区“${ws}”不存在。可用 ListWorkspaces 查询。`);
    const query = A.str(args, 'query', 'keyword');
    if (!query) throw new Error(`${P} SearchProjects 需要 query（工程名称关键字或完整工程 ID）。`);
    return listProjects({ ...args, query }, 'SearchProjects');
}

async function getProject(args) {
    const { project, rootInfo } = projectOf(args);
    const s = store();
    const todos = s.listTodos(project.id);
    const stats = s.projectStats(project.id);
    const limit = posInt(A.pick(args, 'timeline', 'limit'), 8);
    const parts = [
        `## 工程：${project.name}（\`${project.id}\`）`,
        projectHeader(project, rootInfo),
        `- 改动：${stats.nodeCount} 个节点 · ${stats.fileCount} 个文件 · +${stats.added}/-${stats.removed} · 最近 ${fmtTime(stats.lastAt)}`,
        `- 创建者：${whoOf(project.created_by)}${project.report_by ? ` · 报告提交者：@${project.report_by}` : ''}`,
        '### 参与者',
        renderContributors(s.contributors(project.id)),
        `### Todo（${todoProgress(todos).text}）`,
        renderTodos(todos),
        `### 最近开发脉络（${limit} 条）`,
        renderTimeline(s.timeline(project.id, { limit })),
    ];
    if (project.report) parts.push('### 验收报告', project.report);
    return textResult(parts.join('\n'), { command: 'GetProject', project, todos, stats });
}

async function updateTodos(args) {
    const { project } = projectOf(args);
    const s = store();
    const maid = maidOf(args);
    const changes = [];
    const titles = A.list(A.pick(args, 'add'));
    if (titles.length) { s.addTodos(project.id, titles, maid); changes.push(`新增 ${titles.length} 项`); }
    const seqs = key => A.list(A.pick(args, key)).map(v => Number(String(v).replace(/^#/, '')));
    const missing = [];
    for (const status of ['done', 'doing', 'pending', 'blocked']) {
        for (const seq of seqs(status)) {
            if (s.updateTodo(project.id, seq, { status, updatedBy: maid })) changes.push(`#${seq}→${status}`); else missing.push(seq);
        }
    }
    for (const seq of seqs('remove')) {
        if (s.removeTodo(project.id, seq)) changes.push(`删除 #${seq}`); else missing.push(seq);
    }
    const seq = A.pick(args, 'seq');
    if (seq !== undefined) {
        const patch = { updatedBy: maid };
        if (A.pick(args, 'title') !== undefined) patch.title = A.str(args, 'title');
        if (A.pick(args, 'note') !== undefined) patch.note = A.str(args, 'note');
        if (s.updateTodo(project.id, Number(seq), patch)) changes.push(`#${seq} 已更新`); else missing.push(seq);
    }
    if (!changes.length && !missing.length) {
        throw new Error(`${P} UpdateTodos 没有任何操作。可用参数：add（新增，换行或逗号分隔）、done/doing/pending/blocked/remove（序号列表）、seq + title/note。`);
    }
    s.touchProject(project.id);
    const todos = s.listTodos(project.id);
    return textResult([
        `## Todo 已更新 · ${project.name}（\`${project.id}\`）`,
        `- 变更：${changes.join('，') || '无'}`,
        missing.length ? `- ⚠️ 未找到的序号：${[...new Set(missing)].join('、')}` : '',
        `### Todo（${todoProgress(todos).text}）`,
        renderTodos(todos),
    ].filter(Boolean).join('\n'), { command: 'UpdateTodos', todos });
}

async function submitReport(args) {
    const { project, rootInfo } = projectOf(args);
    const conclusion = A.str(args, 'conclusion', 'summary', 'report');
    if (!conclusion) throw new Error(`${P} SubmitReport 需要 conclusion（验收结论）。`);
    const status = (A.str(args, 'status') || 'review').toLowerCase();
    if (!['review', 'accepted', 'active'].includes(status)) throw new Error(`${P} status 只能是 review、accepted 或 active。`);
    const s = store();
    const todos = s.listTodos(project.id);
    const files = s.changedFiles(project.id);
    const stats = s.projectStats(project.id);
    const issues = A.str(args, 'issues');
    const maid = maidOf(args);
    const report = [
        `# 验收报告：${project.name}（${project.id}）`,
        `- 生成时间：${fmtTime(new Date().toISOString())} · 状态：${status} · 提交者：${whoOf(maid)}`,
        `- 根目录：${rootInfo.root}`,
        `- 改动统计：${stats.nodeCount} 个节点 · ${stats.fileCount} 个文件 · +${stats.added}/-${stats.removed}`,
        `## Todo 完成情况（${todoProgress(todos).text}）`,
        renderTodos(todos),
        `## 改动文件（${files.length}）`,
        files.length ? `| 文件 | 改动次数 | 增删 |\n|---|---|---|\n${files.map(f => `| \`${f.file_path}\` | ${f.edits} | +${f.added}/-${f.removed} |`).join('\n')}` : '- 无',
        '## 参与者',
        renderContributors(s.contributors(project.id)),
        '## 开发脉络',
        renderTimeline(s.timeline(project.id, { limit: 100 })),
        '## 结论',
        conclusion,
        '## 遗留问题',
        issues || '- 无',
    ].join('\n');
    s.updateProject(project.id, { report, status, reportBy: maid });
    return textResult(report, { command: 'SubmitReport', projectId: project.id, status });
}

function projectIdsOf(args) {
    const ids = A.list(A.pick(args, 'projectIds', 'projectId', 'ids'));
    if (!ids.length) throw new Error(`${P} 需要 projectIds（多个用逗号或换行分隔）。`);
    return [...new Set(ids)];
}

async function deleteProjects(args) {
    const ids = projectIdsOf(args);
    const done = store().softDeleteProjects(ids, maidOf(args));
    const skipped = ids.filter(id => !done.includes(id));
    return textResult([
        `## 工程已删除（仅数据库记录）`,
        `- 已删除：${done.map(id => `\`${id}\``).join('、') || '无'}`,
        skipped.length ? `- 未找到或已删除：${skipped.join('、')}` : '',
        '- 磁盘上的任何文件都未改动。可用 RestoreProjects 恢复；PurgeProjects 可永久清除记录与历史快照。',
    ].filter(Boolean).join('\n'), { command: 'DeleteProjects', deleted: done, skipped });
}

async function restoreProjects(args) {
    const ids = projectIdsOf(args);
    const done = store().restoreProjects(ids);
    return textResult(`## 工程已恢复\n- ${done.map(id => `\`${id}\``).join('、') || '无（需先被 DeleteProjects 删除）'}`, { command: 'RestoreProjects', restored: done });
}

async function purgeProjects(args) {
    const ids = projectIdsOf(args);
    if (!A.bool(A.pick(args, 'confirm'), false)) {
        throw new Error(`${P} PurgeProjects 会永久清除工程记录、todo、报告与全部历史快照（无法回退），需要 confirm=true。磁盘文件不受影响。`);
    }
    const s = store();
    const notDeleted = ids.filter(id => {
        const p = s.getProject(id, { includeDeleted: true });
        return p && !p.deleted_at;
    });
    if (notDeleted.length) {
        throw new Error(`${P} 以下工程尚未删除：${notDeleted.join('、')}。请先 DeleteProjects，再 PurgeProjects。`);
    }
    const { purged, freedBlobs } = s.purgeProjects(ids);
    return textResult(`## 工程已永久清除（仅数据库）\n- 已清除：${purged.map(id => `\`${id}\``).join('、') || '无'}\n- 回收快照：${freedBlobs} 个\n- 磁盘文件未改动。`, { command: 'PurgeProjects', purged, freedBlobs });
}

// ============================ 读取 ============================

function splitPathRange(entry) {
    const m = String(entry).match(/^(.*?):(\d+(?:\s*-\s*\d+)?)$/);
    return m ? { path: m[1], lines: m[2].replace(/\s/g, '') } : { path: entry, lines: undefined };
}

function collectReadTargets(ctx, args) {
    const targets = [];
    const single = A.str(args, 'path', 'file', 'filePath');
    const symbolArg = A.str(args, 'symbol');
    if (single) {
        const { path: p0, lines } = splitPathRange(single);
        const { path: p, symbol } = SR.splitPathSymbol(p0);
        targets.push({ ...fileOf(ctx, p), lines: A.str(args, 'lines') || lines, symbol: symbol || symbolArg || null });
    } else if (symbolArg) {
        throw new Error(`${P} ReadCode 的 symbol= 需要配合 path（或直接写 path=文件#符号）。不知道在哪个文件时先用 FindSymbol。`);
    }
    for (const entry of A.list(A.pick(args, 'paths', 'files'))) {
        const { path: p0, lines } = splitPathRange(entry);
        const { path: p, symbol } = SR.splitPathSymbol(p0);
        targets.push({ ...fileOf(ctx, p), lines, symbol });
    }
    const pattern = A.str(args, 'glob', 'pattern');
    if (pattern) {
        const { globSync } = require('glob');
        const matches = globSync(pattern.replace(/\\/g, '/'), {
            cwd: ctx.rootInfo.root, nodir: true, dot: false, absolute: true,
            ignore: ['**/node_modules/**', '**/.git/**'],
        }).sort().slice(0, 200);
        for (const abs of matches) targets.push({ ...fileOf(ctx, abs), lines: A.str(args, 'lines') || undefined });
    }
    if (!targets.length) throw new Error(`${P} ReadCode 需要 path、paths 或 glob。`);
    const seen = new Set();
    const keyOf = t => `${t.rel}|${t.lines || ''}|${t.symbol || ''}`;
    return targets.filter(t => !seen.has(keyOf(t)) && seen.add(keyOf(t)));
}

async function findInFiles(ctx, targets, needle) {
    const query = T.normalizeEol(needle);
    const out = [];
    let total = 0;
    for (const t of targets) {
        const disk = await readDisk(t.abs);
        if (!disk.exists) { out.push(`- \`${t.rel}\`：文件不存在`); continue; }
        let meta;
        try { meta = decodeText(disk.buffer, t.rel); } catch (_e) { continue; }
        const idx = engine.buildIndex(meta.text);
        let hits;
        try { hits = engine.locateTarget(idx, query).hits; } catch (_e) { hits = []; } // 首尾锚定未命中视为 0 处
        total += hits.length;
        const outline = hits.length && out.length < 30 ? await outlineOf(t.rel, meta.text) : null;
        for (const h of hits.slice(0, Math.max(0, 30 - out.length))) {
            const scope = engine.enclosingScope(idx, h.startLine, outline?.symbols);
            out.push(`#### \`${t.rel}\` · L${h.startLine}-${h.endLine}${scope ? ` · in ${scope}` : ''}\n${T.markdownFence(engine.contextBlock(idx, h.startLine, h.endLine), T.languageOf(t.rel))}`);
        }
    }
    const head = `## Find “${String(needle).split('\n')[0].slice(0, 60)}” · 共 ${total} 处${total > 30 ? '（仅显示前 30 处）' : ''}\n${projectHeader(ctx.project, ctx.rootInfo)}`;
    return textResult(`${head}\n\n${out.join('\n\n') || '- 未找到。'}`, { command: 'ReadCode', mode: 'find', total });
}

async function readCode(args) {
    const ctx = projectOf(args);
    const targets = collectReadTargets(ctx, args);
    const needle = A.pick(args, 'find', 'search');
    if (needle !== undefined) return findInFiles(ctx, targets, String(needle));
    const showLine = A.bool(A.pick(args, 'showLine', 'showLines', 'lineNumbers'), true);

    // 符号目标：在本次读到的内容上解析为行区间，再交给通用 reader 按 lines 渲染
    const range = A.str(args, 'range') || 'full';
    const context = Math.max(0, Math.floor(Number(A.pick(args, 'context')) || 0));
    const symNotes = [];
    const misses = [];
    const symbols = [];
    const readable = [];
    for (const t of targets) {
        if (!t.symbol) { readable.push(t); continue; }
        try {
            const r = await resolveSymbolInFile(t, t.symbol, { pick: A.pick(args, 'pick'), line: A.pick(args, 'line') });
            if (r.res.status !== 'ok') { misses.push(renderSymbolMiss(t, r.res, 'ReadCode')); continue; }
            const sym = r.res.symbol;
            const rg = SR.symbolRange(sym, { range, context, lineCount: T.splitLines(r.meta.text).lines.length });
            symNotes.push(`- \`${t.rel}#${sym.qualified}\` · ${sym.kind} · 读取 L${rg.startLine}-${rg.endLine}（${rg.mode === 'body' ? '从签名行起' : '含前置注释'}${context ? `，上下文 ±${context} 行` : ''}）${r.res.note ? ` · ${r.res.note}` : ''}`);
            symbols.push({ path: t.rel, ...sym, readStart: rg.startLine, readEnd: rg.endLine });
            readable.push({ ...t, lines: `${rg.startLine}-${rg.endLine}` });
        } catch (error) {
            misses.push(`## ❌ \`${t.rel}#${t.symbol}\`\n- ${error.message}`);
        }
    }

    const result = await readFilesAsContent(
        readable.map(t => ({ absPath: t.abs, displayPath: t.symbol ? `${t.rel}#${t.symbol}` : t.rel, lines: t.lines })),
        { withLineNumbers: showLine, maxFiles: runtime.readMaxFiles, maxTotalBytes: runtime.readMaxBytes, maxFileSize: runtime.maxEditSize * 4 },
    );
    const head = {
        type: 'text',
        text: [
            `## ReadCode · ${result.read.length} 个文件`,
            projectHeader(ctx.project, ctx.rootInfo),
            showLine ? '- 行号前缀 `N | ` 仅供定位，EditCode 时可直接粘贴，插件会自动剥除。' : '',
            symNotes.length ? `### 符号\n${symNotes.join('\n')}` : '',
        ].filter(Boolean).join('\n'),
    };
    const parts = [head, ...result.parts];
    if (misses.length) parts.push({ type: 'text', text: misses.join('\n\n') });
    return partsResult(parts, { command: 'ReadCode', read: result.read, skipped: result.skipped, failed: result.failed, symbols, symbolMisses: misses.length });
}

// ============================ 符号（AST） ============================
// 区间以内容为准：每次都把本次读到的文本交给索引器现场解析（按 sha256+lang 缓存），
// 返回的行号与这份内容严格对应；索引器不可用时明确提示改用 lines / target，不做猜测。

function astStatusNote() {
    const indexer = runtime.indexer;
    if (!indexer) return '索引器未初始化';
    if (indexer.disabled) return '已通过配置 AST_INDEX_ENABLED=false 关闭';
    const st = indexer.status();
    if (st.circuit) return st.circuit;
    return null;
}

function astUnavailableReason(rel) {
    if (runtime.indexer && !runtime.indexer.supports(rel)) {
        return '该文件类型不支持 AST 符号（支持 JS/TS/TSX/Python/Rust），请用 lines / target 定位';
    }
    return `AST 索引器不可用（${astStatusNote() || '启动失败或暂时降级'}），请用 lines / target 定位`;
}

async function outlineOf(rel, text) {
    const indexer = runtime.indexer;
    if (!indexer || !indexer.supports(rel)) return null;
    return indexer.outline(text, rel);
}

/**
 * 读文件并在本次内容上解析符号地址。写操作必须在 withLock 内调用，
 * 之后用同一份 disk.hash 做 assertDiskUnchanged。
 * @returns {{ disk, meta, outline, res }} res 见 symbolResolver.resolveInOutline
 */
async function resolveSymbolInFile(file, ref, options = {}) {
    const disk = await readDisk(file.abs);
    if (!disk.exists) throw new Error(`${P} 文件不存在：${file.rel}`);
    const meta = decodeText(disk.buffer, file.rel);
    const outline = await outlineOf(file.rel, meta.text);
    if (!outline) throw new Error(`${P} ${file.rel}：${astUnavailableReason(file.rel)}。`);
    const res = SR.resolveInOutline(outline, ref, options);
    return { disk, meta, outline, res };
}

/** notFound / ambiguous 的统一提示（非票据场景：ReadCode / MoveCode / CopyCode）。 */
function renderSymbolMiss(file, res, command) {
    if (res.status === 'notFound') {
        return [
            `## ❌ 未找到符号 \`${res.query}\` · \`${file.rel}\``,
            '- 最相似的符号：',
            SR.renderSuggestions(res.suggestions),
            `- 可用 Outline path=${file.rel} 查看全部符号，或用 FindSymbol 在工程内查找。`,
        ].join('\n');
    }
    return [
        `## ⚠️ 符号 \`${res.query}\` 在 \`${file.rel}\` 中有 ${res.total} 处同名定义，未执行 ${command}${res.tooMany ? `（仅列出前 ${res.candidates.length} 处）` : ''}`,
        SR.renderCandidateLines(res.candidates),
        `- 下一步：保留原参数，加 pick=候选序号 或 line=近似行号 重发；也可写更完整的限定名（如 \`父级.${res.query.split('.').pop()}\`）。`,
    ].join('\n');
}

async function outlineCmd(args) {
    const ctx = projectOf(args);
    const inputs = [A.str(args, 'path', 'file', 'filePath'), ...A.list(A.pick(args, 'paths', 'files'))].filter(Boolean);
    if (!inputs.length) throw new Error(`${P} Outline 需要 path 或 paths（多个用换行或逗号分隔）。`);
    const depth = posInt(A.pick(args, 'depth'), undefined);
    const kinds = A.list(A.pick(args, 'kind', 'kinds'));
    const seen = new Set();
    const files = [];
    for (const input of inputs) {
        const p = SR.splitPathSymbol(splitPathRange(input).path).path;
        const file = fileOf(ctx, p);
        if (seen.has(file.rel)) continue;
        seen.add(file.rel);
        files.push(file);
    }
    const blocks = [];
    const details = [];
    for (const file of files.slice(0, runtime.readMaxFiles)) {
        const disk = await readDisk(file.abs);
        if (!disk.exists) { blocks.push(`### \`${file.rel}\`\n- 文件不存在`); continue; }

        if (isBinaryExtension(file.rel)) {
            let outline = await outlineOf(file.rel, null);
            if (!outline) {
                try {
                    outline = parseBinaryBuffer(disk.buffer, file.rel, disk.buffer.length);
                } catch {
                    // 安全忽略，后续判断统一报错
                }
            }
            if (!outline) { blocks.push(`### \`${file.rel}\`\n- ${astUnavailableReason(file.rel)}`); continue; }
            if (outline.isBinary) {
                const secLines = (outline.sections || []).map(s => `  - 节区 \`${s.name}\` · VAddr: ${s.virtualAddress} | Raw: ${(s.rawSize / 1024).toFixed(1)} KB | Perm: ${s.permissions} | Entropy: ${s.entropy} (${s.entropyStatus})`);
                const symLines = (outline.symbols || []).map(s => `  - 导出 \`${s.name}\` · RVA: ${s.rva}${s.demangled && s.demangled !== s.name ? ` (${s.demangled})` : ''}`);
                blocks.push([
                    `### \`${file.rel}\` · ${outline.format || 'Binary'} / ${outline.architecture || 'unknown'} · 节区 ${outline.sections?.length || 0} / 导出 ${outline.symbols?.length || 0}`,
                    secLines.length ? secLines.join('\n') : '- （无节区信息）',
                    symLines.length ? symLines.join('\n') : '- （无导出符号）',
                ].join('\n'));
                details.push({ path: file.rel, isBinary: true, format: outline.format, architecture: outline.architecture, sections: outline.sections, symbols: outline.symbols });
                continue;
            }
        }

        let meta;
        try { meta = decodeText(disk.buffer, file.rel); } catch (error) { blocks.push(`### \`${file.rel}\`\n- ${error.message}`); continue; }
        const outline = await outlineOf(file.rel, meta.text);
        if (!outline) { blocks.push(`### \`${file.rel}\`\n- ${astUnavailableReason(file.rel)}`); continue; }
        const r = SR.renderOutline(outline, { depth, kinds });
        blocks.push([
            `### \`${file.rel}\` · ${outline.lang} · ${outline.lineCount} 行 · 显示 ${r.shown}/${r.total} 个符号${outline.hasError ? ' · ⚠️ 文件存在语法错误，区间为尽力提取' : ''}`,
            r.text || '- （无符号）',
        ].join('\n'));
        details.push({ path: file.rel, lang: outline.lang, hasError: outline.hasError, lineCount: outline.lineCount, symbols: outline.symbols });
    }
    if (files.length > runtime.readMaxFiles) blocks.push(`- ⚠️ 仅处理前 ${runtime.readMaxFiles} 个文件（共 ${files.length} 个）。`);
    const head = [
        `## Outline · ${files.length} 个文件`,
        projectHeader(ctx.project, ctx.rootInfo),
        '- `L起-止` 为签名行到结束行，`注释自 L` 为含前置注释 / 装饰器的起点。可用 `path#限定名` 回填 ReadCode / EditCode / MoveCode / CopyCode。',
    ].join('\n');
    return textResult(`${head}\n\n${blocks.join('\n\n')}`, { command: 'Outline', files: details });
}

function swapQualifier(name) {
    if (name.includes('::')) return name.replace(/::/g, '.');
    if (name.includes('.')) return name.replace(/\./g, '::');
    return null;
}

async function findSymbolCmd(args) {
    const ctx = projectOf(args);
    const name = A.str(args, 'name', 'symbol', 'query');
    if (!name) throw new Error(`${P} FindSymbol 需要 name（符号名或限定名，如 commitEdit、Store.putBlob、Store::put_blob）。`);
    if (!runtime.indexer?.usable) {
        throw new Error(`${P} FindSymbol 需要 AST 索引器：${astStatusNote() || '不可用'}。可改用 ReadCode glob=… find=… 做文本查找。`);
    }
    const scopeArg = A.str(args, 'scope').toLowerCase();
    let root = ctx.rootInfo.root;
    let scopeLabel = '工程根';
    if (scopeArg === 'workspace') {
        const ws = runtime.resolver.list()
            .filter(item => isPathInside(root, item.path) || path.resolve(item.path) === path.resolve(root))
            .sort((a, b) => b.path.length - a.path.length)[0];
        if (ws) { root = path.resolve(ws.path); scopeLabel = `工作区 \`${ws.alias}\`（工程外的结果只读）`; }
        else scopeLabel = '工程根（未找到所属工作区）';
    } else if (scopeArg && scopeArg !== 'project') {
        throw new Error(`${P} scope 只能是 project（默认）或 workspace。`);
    }
    const query = {
        kind: A.str(args, 'kind') || undefined,
        glob: A.str(args, 'glob', 'pattern') || undefined,
        exact: A.bool(A.pick(args, 'exact'), false),
        limit: Math.min(posInt(A.pick(args, 'limit'), 20), 500),
        ignoreDirs: astIgnoreDirs(),
    };
    let usedName = name;
    let result = await runtime.indexer.findSymbols(root, { ...query, name });
    const alt = swapQualifier(name);
    if (result && !result.total && alt) {
        const retry = await runtime.indexer.findSymbols(root, { ...query, name: alt });
        if (retry && retry.total) { result = retry; usedName = alt; }
    }
    if (!result) throw new Error(`${P} FindSymbol 失败：${astStatusNote() || 'AST 索引器暂时不可用'}。可改用 ReadCode glob=… find=… 做文本查找。`);

    const hits = (result.hits || []).map(h => {
        const abs = path.resolve(root, ...String(h.path).split(/[\\/]+/));
        const inProject = isPathInside(abs, ctx.rootInfo.root);
        const rel = inProject ? toPosixRelative(ctx.rootInfo.root, abs) : toPosixRelative(root, abs);
        return { ...h, rel, inProject };
    });
    const lines = hits.map(h => `- \`${h.rel}#${h.qualified || h.name}\` · ${SR.lineLabel(h)} · ${h.kind}${h.inProject ? '' : ' · （工程外，只读）'} — ${SR.oneLine(h.signature)}`);
    const stats = `- 范围：${scopeLabel} · 扫描 ${result.scanned} 个文件 · 解析 ${result.parsed} · ${result.lines} 行 · 命中 ${result.total}${result.total > hits.length ? `（显示前 ${hits.length}）` : ''}${result.truncated ? ' · ⚠️ 扫描已截断（文件数或单文件大小超限），可用 glob 缩小范围' : ''}`;
    return textResult([
        `## FindSymbol “${usedName}”${usedName !== name ? `（按 ${usedName} 重试后命中）` : ''}${query.kind ? ` · kind=${query.kind}` : ''}${query.exact ? ' · exact' : ''}`,
        projectHeader(ctx.project, ctx.rootInfo),
        stats,
        lines.join('\n') || '- 未找到。可去掉 exact、换用更短的名称，或用 ReadCode find= 做文本查找。',
        hits.length ? '- 每条结果可直接写成 `path=文件#限定名` 交给 ReadCode / EditCode。' : '',
    ].filter(Boolean).join('\n'), {
        command: 'FindSymbol', total: result.total, scanned: result.scanned, parsed: result.parsed, truncated: result.truncated,
        hits: hits.map(({ rel, inProject, name: n, qualified, kind, fullStart, start, end, signature, lang }) => ({ path: rel, inProject, name: n, qualified, kind, fullStart, start, end, signature, lang })),
    });
}

const traceBridgeCache = new Map();

/** 扫描根：默认工程根；scope=workspace 时取工程所属的最深工作区根（只读）。 */
function scanRootOf(ctx, args) {
    const scopeArg = A.str(args, 'scope').toLowerCase();
    const root = ctx.rootInfo.root;
    if (!scopeArg || scopeArg === 'project') return { root, label: '工程根' };
    if (scopeArg !== 'workspace') throw new Error(`${P} scope 只能是 project（默认）或 workspace。`);
    const ws = runtime.resolver.list()
        .filter(item => isPathInside(root, item.path))
        .sort((a, b) => b.path.length - a.path.length)[0];
    return ws ? { root: path.resolve(ws.path), label: `工作区 \`${ws.alias}\`` } : { root, label: '工程根（未找到所属工作区）' };
}

async function traceCmd(args) {
    const ctx = projectOf(args);
    const raw = A.str(args, 'target', 'query');
    const target = LG.parseTarget(raw);
    if (!target) {
        throw new Error(`${P} Trace 需要 target，形如 ipc:通道名（或 API 名）、global:名称、page:xxx.html、file:相对路径。`);
    }
    if (!runtime.indexer?.usable) throw new Error(`${P} Trace 需要 AST 索引器：${astStatusNote() || '不可用'}。`);
    const scan = scanRootOf(ctx, args);
    const started = Date.now();
    const decls = await LG.loadPreloadDecls(scan.root);
    // 桥接名单 = 角色全局 + 顶层别名（如 `const api = window.utilityAPI || …`）。别名名单按根缓存，
    // 使后续调用一轮扫描即可、索引器 facts 缓存稳定命中；发现新别名时扩展名单并重扫一次。
    const base = LG.bridgeGlobalsOf(decls);
    const query = { glob: A.str(args, 'glob') || undefined, ignoreDirs: astIgnoreDirs() };
    let bridge = traceBridgeCache.get(scan.root) || base;
    let facts = await runtime.indexer.facts(scan.root, { ...query, bridgeGlobals: bridge });
    if (facts) {
        const extended = [...new Set([...base, ...LG.aliasNames(facts)])].sort();
        if (extended.some(n => !bridge.includes(n))) {
            bridge = [...new Set([...bridge, ...extended])].sort();
            traceBridgeCache.set(scan.root, bridge);
            facts = await runtime.indexer.facts(scan.root, { ...query, bridgeGlobals: bridge });
        }
    }
    if (!facts) throw new Error(`${P} Trace 失败：${astStatusNote() || 'AST 索引器暂时不可用'}。`);
    const graph = LG.buildGraph(scan.root, facts, decls);
    let value = target.value;
    if (target.kind === 'file' || target.kind === 'page') {
        const abs = path.isAbsolute(value) ? path.resolve(value) : path.resolve(ctx.rootInfo.root, ...value.split(/[\\/]+/));
        if (isPathInside(abs, scan.root)) value = toPosixRelative(scan.root, abs);
    }
    const r = LG.trace(graph, target.kind, value);
    const declNote = decls.status === 'ok'
        ? `preload 声明表 ${decls.apis.length} 个 API`
        : decls.status === 'absent' ? '无 preload 声明表（只有字面量边）' : `⚠️ preload 声明表读取失败：${decls.error}`;
    const head = [
        projectHeader(ctx.project, ctx.rootInfo),
        `- 范围：${scan.label} · ${graph.stats.scanned} 个 JS/HTML 文件 · ${graph.stats.pages} 个页面 · ${declNote} · ${Date.now() - started} ms${graph.stats.truncated ? ' · ⚠️ 扫描已截断' : ''}`,
        '- 置信度：literal / const 为字面量或同文件常量直连，declared 经 preload 声明表；动态参数不入边。结果中的 `路径:行` 可直接回填 ReadCode。',
    ].join('\n');
    const [title, ...rest] = r.text.split('\n');
    return textResult([title, head, ...rest].join('\n'), { command: 'Trace', kind: target.kind, found: r.found, ...r.details });
}

// ============================ 编辑 ============================

function editOptions(args) {
    const mode = A.str(args, 'mode').toLowerCase() === 'besteffort' ? 'bestEffort' : 'atomic';
    const drift = A.num(A.pick(args, 'drift'), 'drift');
    return { mode, drift: Number.isInteger(drift) ? drift : undefined, revertOnSyntaxError: A.bool(A.pick(args, 'revertOnSyntaxError'), false) };
}

function renderHints(hints) {
    if (!hints?.length) return '';
    return `\n  - 最相似的行：${hints.map(h => `L${h.line}（${h.score}%）\`${h.text}\``).join('；')}`;
}

function renderErrors(errors) {
    return errors.map(e => `- 步骤${e.step}（${e.op}）：${e.message}${renderHints(e.hints)}`).join('\n');
}

function renderAmbiguity(file, ambiguities, ticketId, notes, extraNote) {
    const lang = T.languageOf(file.rel);
    const blocks = ambiguities.map(a => [
        `### 步骤 ${a.step}：${a.kind === 'symbol' ? `符号 \`${a.query}\` 有 ${a.total} 处同名定义（只能单选）` : `target 共命中 ${a.total} 处`}${a.tooMany ? `（仅列出前 ${a.candidates.length} 处，建议${a.kind === 'symbol' ? '写更完整的限定名' : '加长 target'}或提供 line）` : ''}`,
        ...a.candidates.map(c => `#### 候选 ${c.index} · L${c.startLine}-${c.endLine}${c.scope ? ` · in ${c.scope}` : ''}\n${T.markdownFence(c.context, lang)}`),
    ].join('\n'));
    const example = ambiguities.length === 1
        ? `pick=1（单选）、pick=1,3（多选）或 pick=all`
        : `pick=${ambiguities.map(a => `${a.step}:1`).join(';')}（步骤:候选）`;
    return [
        `## ⚠️ 存在多处命中，未写入 · \`${file.rel}\``,
        extraNote ? `- ${extraNote}` : '',
        `- 票据：\`${ticketId}\`（30 分钟内有效）`,
        `- 下一步：调用 ResolveEdit，只需 ticketId=${ticketId} 与 ${example}，无需重发内容。`,
        notes.length ? `- 提示：${notes.join('；')}` : '',
        ...blocks,
    ].filter(Boolean).join('\n');
}

// ---------------- 符号步骤 → 行号步骤 ----------------
// 符号只在 Service 层解析：转换为普通 replace / delete / insert 步骤（行号 + expect=起始行原文），
// 与行号步骤一起交给 engine，复用原有的漂移校验与重叠检测；engine 不感知 AST。

const SYMBOL_POS_RE = /^\s*symbol\s*:\s*(.+?)\s*$/i;

function symbolPosOf(value) {
    const m = SYMBOL_POS_RE.exec(String(value ?? ''));
    return m ? m[1] : null;
}

function hasSymbolRef(st) {
    return st.symbol !== undefined && st.symbol !== null && String(st.symbol).trim() !== '';
}

function stepNeedsSymbol(st) {
    if (st.op === 'symbol' || hasSymbolRef(st)) return true;
    return st.op === 'insert' && Boolean(symbolPosOf(st.after) || symbolPosOf(st.before));
}

function symbolNotFoundMessage(res) {
    const near = res.suggestions.slice(0, 5).map(s => `\`${s.qualified}\`（L${s.start}）`).join('、');
    return `未找到符号 \`${res.query}\`${near ? `；相近的符号：${near}` : ''}。可用 Outline 查看全部符号`;
}

/** 与 engine target 歧义同构的条目（可进票据、可被 ResolveEdit 以 pick 选择）。 */
function symbolAmbiguity(idx, step, res) {
    return {
        step,
        kind: 'symbol',
        query: res.query,
        total: res.total,
        tooMany: res.tooMany,
        signature: res.signature,
        candidates: res.candidates.map(c => ({
            index: c.candidate,
            startLine: c.fullStart,
            endLine: c.end,
            scope: `${c.kind} ${c.qualified}${c.parent ? `（in ${c.parent}）` : ''}`,
            context: engine.contextBlock(idx, c.start, c.end),
        })),
    };
}

async function resolveSymbolSteps(file, text, steps) {
    const out = { steps: [], ambiguities: [], errors: [], notes: [], symbols: null };
    if (!steps.some(stepNeedsSymbol)) { out.steps = steps; return out; }
    const outline = await outlineOf(file.rel, text);
    out.symbols = outline?.symbols || null;
    const idx = engine.buildIndex(text);
    for (const st of steps) {
        if (!stepNeedsSymbol(st)) { out.steps.push(st); continue; }
        const fail = message => out.errors.push({ step: st.step, op: st.op, message, hints: [] });
        if (!outline) { fail(astUnavailableReason(file.rel)); continue; }
        try {
            if (st.op === 'insert') {
                const beforeRef = symbolPosOf(st.before);
                const ref = beforeRef || symbolPosOf(st.after) || String(st.symbol);
                const res = SR.resolveInOutline(outline, ref, { pick: st.pick, line: st.line });
                if (res.status === 'notFound') { fail(symbolNotFoundMessage(res)); continue; }
                if (res.status === 'ambiguous') { out.ambiguities.push(symbolAmbiguity(idx, st.step, res)); continue; }
                const sym = res.symbol;
                const next = { step: st.step, op: 'insert', content: st.content, reason: st.reason };
                if (beforeRef) next.before = sym.fullStart; else next.after = sym.end;
                out.steps.push(next);
                out.notes.push(`步骤${st.step}：插入到符号 \`${sym.qualified}\` ${beforeRef ? `之前（L${sym.fullStart} 前，含其前置注释）` : `之后（L${sym.end} 后）`}${res.note ? `，${res.note}` : ''}`);
                continue;
            }
            let op;
            if (st.op === 'delete') op = 'delete';
            else if (st.op === 'symbol' || st.op === 'replace') op = 'replace';
            else { fail(`op=${st.op} 不能配合 symbol 使用；可用 op=symbol（替换）、op=delete、op=insert + after/before=symbol:名称`); continue; }
            if (!hasSymbolRef(st)) { fail('op=symbol 需要 symbol（符号名或限定名）'); continue; }
            if (op === 'replace' && st.content === undefined) { fail('按符号替换需要 content（新的完整代码块）；删除请用 op=delete'); continue; }
            const res = SR.resolveInOutline(outline, st.symbol, { pick: st.pick, line: st.line });
            if (res.status === 'notFound') { fail(symbolNotFoundMessage(res)); continue; }
            if (res.status === 'ambiguous') { out.ambiguities.push(symbolAmbiguity(idx, st.step, res)); continue; }
            const sym = res.symbol;
            const rg = SR.symbolRange(sym, { range: st.range, lineCount: idx.count });
            out.steps.push({
                step: st.step, op, start: rg.startLine, end: rg.endLine,
                expect: idx.lines[rg.startLine - 1], content: st.content, reason: st.reason,
            });
            const span = rg.mode === 'body'
                ? (sym.fullStart < sym.start ? '（range=body，保留前置注释）' : '')
                : (sym.fullStart < sym.start ? '（含前置注释）' : '');
            out.notes.push(`步骤${st.step}：符号 \`${sym.qualified}\` → L${rg.startLine}-${rg.endLine}${span}${res.note ? `，${res.note}` : ''}`);
        } catch (error) {
            fail(error.message);
        }
    }
    return out;
}

/**
 * 规划一次编辑串：符号步骤先转换，再交给 engine；两边的错误 / 歧义合并。
 * 返回结构与 engine.runEditString 一致。EditCode 与票据复核共用，保证口径一致。
 */
async function planEdit(file, text, steps, engineOpts) {
    const sym = await resolveSymbolSteps(file, text, steps);
    const r = sym.steps.length
        ? engine.runEditString(text, sym.steps, { ...engineOpts, symbols: sym.symbols })
        : { status: 'error', errors: [], notes: [], ambiguities: [] };
    const byStep = (a, b) => a.step - b.step;
    const errors = [...sym.errors, ...(r.errors || [])].sort(byStep);
    const ambiguities = [...sym.ambiguities, ...(r.ambiguities || [])].sort(byStep);
    const notes = [...sym.notes, ...(r.notes || [])];
    if (ambiguities.length) {
        // target 歧义候选的所在符号：有 outline 就用 outline
        if (!sym.symbols && ambiguities.some(a => a.kind !== 'symbol')) {
            const outline = await outlineOf(file.rel, text);
            if (outline?.symbols) {
                const idx = engine.buildIndex(text);
                for (const a of ambiguities) {
                    if (a.kind === 'symbol') continue;
                    for (const c of a.candidates) c.scope = engine.enclosingScope(idx, c.startLine, outline.symbols) || c.scope;
                }
            }
        }
        return { status: 'ambiguous', ambiguities, errors, notes };
    }
    if (r.status !== 'ok' || (errors.length && engineOpts.mode !== 'bestEffort')) return { status: 'error', errors, notes };
    return { ...r, errors, notes };
}

/**
 * 执行一次文件编辑串（EditCode / ResolveEdit 共用）。
 * plan: { steps, mode, drift, revertOnSyntaxError, reason, todoId, ticket }
 */
async function commitEdit(ctx, file, plan) {
    const s = store();
    const disk = await readDisk(file.abs);
    if (!disk.exists) throw new Error(`${P} 文件不存在：${file.rel}。新建请用 CreateFile。`);
    const meta = decodeText(disk.buffer, file.rel);
    const notes = [];
    const drift = recordExternalDrift(ctx.project, file.rel, disk);
    if (drift) notes.push(drift);
    const engineOpts = { mode: plan.mode, drift: plan.drift };

    if (plan.ticket && plan.ticket.fileHash !== disk.hash) {
        const probe = await planEdit(file, meta.text, plan.ticket.steps, engineOpts);
        const expected = plan.ticket.signatures;
        const same = probe.status === 'ambiguous'
            && probe.ambiguities.length === Object.keys(expected).length
            && probe.ambiguities.every(a => expected[a.step] === a.signature);
        if (!same) {
            if (probe.status === 'ambiguous' && !probe.errors.length) {
                const ticketId = runtime.tickets.reissue(plan.ticket.id, {
                    ...plan.ticket, fileHash: disk.hash, ambiguities: probe.ambiguities,
                });
                return textResult(renderAmbiguity(file, probe.ambiguities, ticketId, probe.notes, '票据签发后文件已变化，候选已更新，请重新选择'),
                    { command: 'ResolveEdit', status: 'ambiguous', ticketId });
            }
            runtime.tickets.consume(plan.ticket.id);
            throw new Error(`${P} 票据 ${plan.ticket.id} 签发后文件已变化，原歧义已不存在。请用 ReadCode 查看最新内容后重新提交 EditCode。`);
        }
        notes.push('票据签发后文件有变化，但候选位置未变，按原选择执行');
    }

    const result = await planEdit(file, meta.text, plan.steps, engineOpts);
    notes.push(...result.notes);

    if (result.status === 'ambiguous') {
        if (result.errors.length) {
            return textResult([
                `## ❌ EditCode 未写入 · \`${file.rel}\``,
                '### 错误', renderErrors(result.errors),
                `### 另有 ${result.ambiguities.length} 个步骤存在多处命中`,
                '- 请先修正错误；歧义步骤可补 line（就近行号）或 pick（候选序号）后一并重发。',
            ].join('\n'), { command: 'EditCode', status: 'error', errors: result.errors });
        }
        const ticketId = runtime.tickets.issue({
            projectId: ctx.project.id, relPath: file.rel, fileHash: disk.hash, steps: plan.steps,
            mode: plan.mode, drift: plan.drift, revertOnSyntaxError: plan.revertOnSyntaxError,
            reason: plan.reason, maid: plan.maid, todoId: plan.todoId, ambiguities: result.ambiguities,
        });
        return textResult(renderAmbiguity(file, result.ambiguities, ticketId, notes), { command: 'EditCode', status: 'ambiguous', ticketId });
    }

    if (result.status === 'error') {
        return textResult([
            `## ❌ EditCode 未写入 · \`${file.rel}\``,
            renderErrors(result.errors),
            notes.length ? `- 提示：${notes.join('；')}` : '',
            plan.mode === 'atomic' ? '- atomic 模式下任一步失败整串不写。修正后重发，或使用 mode=bestEffort 跳过失败步骤。' : '',
        ].filter(Boolean).join('\n'), { command: 'EditCode', status: 'error', errors: result.errors });
    }

    if (!result.changed) {
        if (plan.ticket) runtime.tickets.consume(plan.ticket.id);
        return textResult(`## ℹ️ 内容无变化，未写入 · \`${file.rel}\``, { command: 'EditCode', status: 'unchanged' });
    }

    const review = await reviewCode(file.abs, meta.text, result.text);
    const diff = renderDiff(meta.text, result.text, file.rel);
    if (plan.revertOnSyntaxError && review.introduced.some(d => d.fatal)) {
        return textResult([
            `## ❌ 编辑会引入语法错误，已按 revertOnSyntaxError 放弃写入 · \`${file.rel}\``,
            renderReview(review),
            diff.block,
        ].filter(Boolean).join('\n'), { command: 'EditCode', status: 'rejected', review });
    }

    const outBuf = encodeText(result.text, meta);
    s.putBlob(disk.buffer);
    const afterHash = s.putBlob(outBuf);
    await assertDiskUnchanged(file.abs, disk.hash, file.rel);
    await fsp.writeFile(file.abs, outBuf);
    const stepReasons = plan.steps.filter(st => st.reason).map(st => `步骤${st.step}：${st.reason}`).join('；');
    let batchId;
    let nodeId;
    s.transaction(() => {
        batchId = s.createBatch(ctx.project.id, 'edit', plan.reason, plan.maid);
        nodeId = s.addNode({
            projectId: ctx.project.id, batchId, filePath: file.rel, op: 'edit',
            beforeHash: disk.hash, afterHash, todoId: plan.todoId, reason: stepReasons || null,
            summary: `${result.applied.length} 步：${result.applied.map(a => a.op).join('/')}`,
            added: diff.added, removed: diff.removed,
        });
    });
    if (plan.ticket) runtime.tickets.consume(plan.ticket.id);

    const applied = result.applied.map(a => `  - 步骤${a.step}（${a.op}）${a.origRanges.join(',')} → ${a.newRanges.join(',')}${a.note ? `；${a.note}` : ''}`);
    return textResult([
        `## ✅ 已写入 · \`${file.rel}\``,
        `- 节点 \`n${nodeId}\` · 批次 \`b${batchId}\` · 工程 \`${ctx.project.id}\` · ${whoOf(plan.maid)}`,
        `- reason：${plan.reason}`,
        `- 步骤（原始行号 → 新行号）：\n${applied.join('\n')}`,
        result.errors.length ? `### 跳过的步骤（bestEffort）\n${renderErrors(result.errors)}` : '',
        notes.length ? `- 提示：${notes.join('；')}` : '',
        `- 换行风格：${T.lineEndingName(meta.lineEnding)}（已保持）`,
        renderReview(review),
        diff.block,
    ].filter(Boolean).join('\n'), {
        command: 'EditCode', status: 'ok', nodeId, batchId, applied: result.applied, skipped: result.errors, review,
    });
}

async function editCode(args) {
    const reason = A.requireReason(args, 'EditCode');
    const ctx = projectOf(args, { write: true });
    const { path: filePath, symbol: pathSymbol } = SR.splitPathSymbol(A.str(args, 'path', 'file', 'filePath'));
    const file = fileOf(ctx, filePath, { write: true });
    // path=文件#符号：等价于平铺形式的 symbol=（编号串请用 symbolN）
    const stepArgs = pathSymbol && A.pick(args, 'symbol') === undefined ? { ...args, symbol: pathSymbol } : args;
    const steps = A.parseEditSteps(stepArgs);
    const todo = todoOf(ctx.project, args);
    return withLock(ctx.project.id, () => commitEdit(ctx, file, { ...editOptions(args), steps, reason, maid: maidOf(args), todoId: todo?.id ?? null }));
}

async function resolveEdit(args) {
    const ticketId = A.str(args, 'ticketId', 'ticket');
    const ticket = runtime.tickets.get(ticketId);
    if (!ticket) throw new Error(`${P} 票据 ${ticketId || '(空)'} 不存在或已过期（30 分钟有效，插件重启会清空）。请重新提交 EditCode。`);
    const picks = parsePickSpec(A.pick(args, 'pick'), ticket.ambiguities.map(a => a.step));
    const ctx = projectOf({ projectid: ticket.projectId }, { write: true });
    const file = fileOf(ctx, ticket.relPath, { write: true });
    const steps = ticket.steps.map(st => (picks.has(st.step) ? { ...st, pick: picks.get(st.step) } : st));
    return withLock(ctx.project.id, () => commitEdit(ctx, file, {
        steps, mode: ticket.mode, drift: ticket.drift, revertOnSyntaxError: ticket.revertOnSyntaxError,
        // 实际落盘者是做出选择的调用者；取不到时沿用签发票据时的署名
        reason: ticket.reason, maid: maidOf(args) || ticket.maid, todoId: ticket.todoId, ticket,
    }));
}

// ============================ 文件操作 ============================

async function createFile(args) {
    const reason = A.requireReason(args, 'CreateFile');
    const ctx = projectOf(args, { write: true });
    const file = fileOf(ctx, A.str(args, 'path', 'file', 'filePath'), { write: true });
    const content = String(A.pick(args, 'content') ?? '');
    const overwrite = A.bool(A.pick(args, 'overwrite'), false);
    const revert = A.bool(A.pick(args, 'revertOnSyntaxError'), false);
    const todo = todoOf(ctx.project, args);
    return withLock(ctx.project.id, async () => {
        const s = store();
        const disk = await readDisk(file.abs);
        if (disk.exists && !overwrite) {
            throw new Error(`${P} 文件已存在：${file.rel}。局部修改请用 EditCode；确需整体覆盖请加 overwrite=true。`);
        }
        const notes = [];
        const drift = disk.exists ? recordExternalDrift(ctx.project, file.rel, disk) : null;
        if (drift) notes.push(drift);
        const meta = disk.exists ? decodeText(disk.buffer, file.rel) : null;
        const newText = T.normalizeEol(content);
        const outBuf = meta ? encodeText(newText, meta) : Buffer.from(content, 'utf8');
        const review = await reviewCode(file.abs, meta ? meta.text : '', newText);
        const diff = meta ? renderDiff(meta.text, newText, file.rel) : { added: T.splitLines(newText).lines.length, removed: 0, block: '' };
        if (revert && review.introduced.some(d => d.fatal)) {
            return textResult(`## ❌ 内容存在语法错误，已按 revertOnSyntaxError 放弃写入 · \`${file.rel}\`\n${renderReview(review)}`, { command: 'CreateFile', status: 'rejected', review });
        }
        if (disk.exists) s.putBlob(disk.buffer);
        const afterHash = s.putBlob(outBuf);
        await assertDiskUnchanged(file.abs, disk.hash, file.rel);
        await fsp.mkdir(path.dirname(file.abs), { recursive: true });
        await fsp.writeFile(file.abs, outBuf);
        let batchId;
        let nodeId;
        s.transaction(() => {
            batchId = s.createBatch(ctx.project.id, disk.exists ? 'edit' : 'create', reason, maidOf(args));
            nodeId = s.addNode({
                projectId: ctx.project.id, batchId, filePath: file.rel, op: disk.exists ? 'edit' : 'create',
                beforeHash: disk.hash, afterHash, todoId: todo?.id ?? null,
                summary: disk.exists ? '整体覆盖' : '新建文件', added: diff.added, removed: diff.removed,
            });
        });
        return textResult([
            `## ✅ ${disk.exists ? '已覆盖' : '已新建'} · \`${file.rel}\`（${T.splitLines(newText).lines.length} 行，${T.formatFileSize(outBuf.length)}）`,
            `- 节点 \`n${nodeId}\` · 批次 \`b${batchId}\` · reason：${reason}`,
            notes.length ? `- 提示：${notes.join('；')}` : '',
            renderReview(review),
            diff.block,
        ].filter(Boolean).join('\n'), { command: 'CreateFile', status: 'ok', nodeId, batchId, review });
    });
}

async function removeFile(args) {
    const reason = A.requireReason(args, 'RemoveFile');
    const ctx = projectOf(args, { write: true });
    const inputs = [A.str(args, 'path', 'file', 'filePath'), ...A.list(A.pick(args, 'paths', 'files'))].filter(Boolean);
    if (!inputs.length) throw new Error(`${P} RemoveFile 需要 path 或 paths。`);
    const files = inputs.map(p => fileOf(ctx, p, { write: true }));
    const todo = todoOf(ctx.project, args);
    return withLock(ctx.project.id, async () => {
        const s = store();
        const batchId = s.createBatch(ctx.project.id, 'remove', reason, maidOf(args));
        const removed = [];
        const failed = [];
        for (const file of files) {
            try {
                const disk = await readDisk(file.abs);
                if (!disk.exists) { failed.push(`\`${file.rel}\`：文件不存在`); continue; }
                recordExternalDrift(ctx.project, file.rel, disk);
                s.putBlob(disk.buffer);
                await moveToTrash(file.abs);
                const nodeId = s.addNode({
                    projectId: ctx.project.id, batchId, filePath: file.rel, op: 'delete',
                    beforeHash: disk.hash, afterHash: null, todoId: todo?.id ?? null,
                    summary: '移到回收站', removed: T.splitLines(disk.buffer.toString('utf8')).lines.length,
                });
                removed.push(`\`${file.rel}\`（节点 \`n${nodeId}\`）`);
            } catch (error) {
                failed.push(`\`${file.rel}\`：${error.message}`);
            }
        }
        return textResult([
            `## ${removed.length ? '✅' : '❌'} RemoveFile · 批次 \`b${batchId}\``,
            `- reason：${reason}`,
            removed.length ? `- 已移到系统回收站：${removed.join('、')}` : '',
            failed.length ? `- 失败：\n${failed.map(f => `  - ${f}`).join('\n')}` : '',
            removed.length ? `- 快照已存入数据库，可用 Rollback batch=b${batchId} 恢复（即使回收站已清空）。` : '',
        ].filter(Boolean).join('\n'), { command: 'RemoveFile', batchId, removed: removed.length, failed });
    });
}

async function moveFile(args) {
    const reason = A.requireReason(args, 'MoveFile');
    const ctx = projectOf(args, { write: true });
    const from = fileOf(ctx, A.str(args, 'from', 'source', 'path'), { write: true });
    const to = fileOf(ctx, A.str(args, 'to', 'destination', 'target'), { write: true });
    const todo = todoOf(ctx.project, args);
    return withLock(ctx.project.id, async () => {
        const s = store();
        const src = await readDisk(from.abs);
        if (!src.exists) throw new Error(`${P} 源文件不存在：${from.rel}`);
        if ((await readDisk(to.abs)).exists) throw new Error(`${P} 目标已存在：${to.rel}，不会覆盖。`);
        recordExternalDrift(ctx.project, from.rel, src);
        s.putBlob(src.buffer);
        await fsp.mkdir(path.dirname(to.abs), { recursive: true });
        try {
            await fsp.rename(from.abs, to.abs);
        } catch (error) {
            if (error.code !== 'EXDEV') throw error;
            await fsp.writeFile(to.abs, src.buffer);
            await moveToTrash(from.abs);
        }
        let batchId;
        s.transaction(() => {
            batchId = s.createBatch(ctx.project.id, 'move', reason, maidOf(args));
            s.addNode({ projectId: ctx.project.id, batchId, filePath: from.rel, op: 'move', beforeHash: src.hash, afterHash: null, todoId: todo?.id ?? null, summary: `→ ${to.rel}` });
            s.addNode({ projectId: ctx.project.id, batchId, filePath: to.rel, op: 'move', beforeHash: null, afterHash: src.hash, todoId: todo?.id ?? null, summary: `← ${from.rel}` });
        });
        return textResult(`## ✅ 已移动 · \`${from.rel}\` → \`${to.rel}\`\n- 批次 \`b${batchId}\` · reason：${reason}`, { command: 'MoveFile', batchId });
    });
}

// ============================ 代码块搬运 ============================

/** 源代码块：symbol（或 from=文件#符号）优先；其次 target（支持首尾锚定）；否则 start/end、lines，最后取 from 里的 :M-N。 */
function blockSpecOf(args, rangeFromPath, symbolFromPath = null) {
    const spec = {};
    const symbol = A.str(args, 'symbol') || symbolFromPath;
    if (symbol) {
        spec.symbol = symbol;
        spec.range = A.str(args, 'range') || 'full';
        if (A.pick(args, 'line') !== undefined) spec.line = A.pick(args, 'line');
        if (A.pick(args, 'pick') !== undefined) spec.pick = A.pick(args, 'pick');
        return spec;
    }
    const target = A.pick(args, 'target', 'block');
    if (target !== undefined) {
        spec.target = String(target);
        if (A.pick(args, 'line') !== undefined) spec.line = A.pick(args, 'line');
        if (A.pick(args, 'pick') !== undefined) spec.pick = A.pick(args, 'pick');
        return spec;
    }
    if (A.pick(args, 'start') !== undefined) {
        spec.start = A.pick(args, 'start');
        spec.end = A.pick(args, 'end');
    } else if (A.str(args, 'lines')) {
        spec.lines = A.str(args, 'lines');
    } else if (rangeFromPath) {
        spec.lines = rangeFromPath;
    } else {
        throw new Error(`${P} 需要指定源代码块：from=文件:M-N、lines=M-N、start/end，或 target（支持“首行 … 尾行”首尾锚定）。`);
    }
    if (A.pick(args, 'expect') !== undefined) spec.expect = String(A.pick(args, 'expect'));
    return spec;
}

function indentLabel(ws) {
    if (!ws) return '无缩进';
    const tabs = (ws.match(/\t/g) || []).length;
    return tabs === ws.length ? `${tabs} 个 Tab` : `${ws.replace(/\t/g, '    ').length} 空格`;
}

function renderBlockAmbiguity(file, command, a, notes) {
    const lang = T.languageOf(file.rel);
    return [
        `## ⚠️ 源 target 共命中 ${a.total} 处，未执行 · \`${file.rel}\`${a.tooMany ? `（仅列出前 ${a.candidates.length} 处）` : ''}`,
        `- 下一步：保留原参数，加 pick=候选序号（或 line=近似行号）重发 ${command}。`,
        notes.length ? `- 提示：${notes.join('；')}` : '',
        ...a.candidates.map(c => `#### 候选 ${c.index} · L${c.startLine}-${c.endLine}${c.scope ? ` · in ${c.scope}` : ''}\n${T.markdownFence(c.context, lang)}`),
    ].filter(Boolean).join('\n');
}

function engineOk(result, rel) {
    if (result.status === 'ok') return result;
    const msg = result.errors.map(e => `${e.message}${renderHints(e.hints)}`).join('；') || '未知错误';
    throw new Error(`${P} ${rel}：${msg}`);
}

/**
 * MoveCode / CopyCode：把一段整行代码剪切或复制到（同一或另一文件的）目标行。
 * 所有行号都以本次调用前的原文为准；同文件时删除与插入在同一快照上一次完成。
 * 跨文件时两个文件的改动落在同一批次，Rollback batch=bX 可整体撤销。
 */
async function transferCode(args, kind) {
    const isMove = kind === 'move';
    const command = isMove ? 'MoveCode' : 'CopyCode';
    const reason = A.requireReason(args, command);
    const ctx = projectOf(args, { write: true });
    const fromRaw = A.str(args, 'from', 'source', 'path', 'file');
    if (!fromRaw) throw new Error(`${P} ${command} 需要 from（源文件，可写成 src/a.js:40-60）。`);
    const { path: fromPath0, lines: rangeFromPath } = splitPathRange(fromRaw);
    const { path: fromPath, symbol: fromSymbol } = SR.splitPathSymbol(fromPath0);
    const toRaw = A.str(args, 'to', 'dest', 'destination');
    const src = fileOf(ctx, fromPath, { write: isMove || !toRaw });
    const dst = toRaw ? fileOf(ctx, toRaw, { write: true }) : src;
    const spec = blockSpecOf(args, rangeFromPath, fromSymbol);
    let pos = { after: A.pick(args, 'after'), before: A.pick(args, 'before') };
    const indentSpec = A.str(args, 'indent') || 'auto';
    const opts = editOptions(args);
    const todo = todoOf(ctx.project, args);
    const maid = maidOf(args);

    return withLock(ctx.project.id, async () => {
        const s = store();
        const notes = [];
        const same = dst.rel === src.rel;

        const srcDisk = await readDisk(src.abs);
        if (!srcDisk.exists) throw new Error(`${P} 源文件不存在：${src.rel}`);
        const srcMeta = decodeText(srcDisk.buffer, src.rel);
        const srcOutline = await outlineOf(src.rel, srcMeta.text);
        let blockSpec = spec;
        if (spec.symbol) {
            if (!srcOutline) throw new Error(`${P} ${src.rel}：${astUnavailableReason(src.rel)}。`);
            let res;
            try { res = SR.resolveInOutline(srcOutline, spec.symbol, { pick: spec.pick, line: spec.line }); } catch (error) { throw new Error(`${P} ${src.rel}：${error.message}`); }
            if (res.status !== 'ok') return textResult(renderSymbolMiss(src, res, command), { command, status: res.status });
            let rg;
            try { rg = SR.symbolRange(res.symbol, { range: spec.range, lineCount: engine.buildIndex(srcMeta.text).count }); } catch (error) { throw new Error(`${P} ${error.message}`); }
            blockSpec = { start: rg.startLine, end: rg.endLine };
            notes.push(`源符号 \`${res.symbol.qualified}\` → L${rg.startLine}-${rg.endLine}${rg.mode === 'full' && res.symbol.fullStart < res.symbol.start ? '（含前置注释）' : ''}${res.note ? `，${res.note}` : ''}`);
        }
        let block;
        try {
            block = engine.resolveBlock(srcMeta.text, blockSpec, { drift: opts.drift, symbols: srcOutline?.symbols });
        } catch (error) {
            throw new Error(`${P} 源代码块定位失败 · ${src.rel}：${error.message}${renderHints(error.hints)}`);
        }
        notes.push(...block.notes);
        if (block.status === 'ambiguous') {
            return textResult(renderBlockAmbiguity(src, command, block.ambiguity, notes),
                { command, status: 'ambiguous', candidates: block.ambiguity.candidates.length });
        }
        if (block.note) notes.push(block.note);

        const dstDisk = same ? srcDisk : await readDisk(dst.abs);
        const dstMeta = dstDisk.exists ? (same ? srcMeta : decodeText(dstDisk.buffer, dst.rel)) : null;
        const dstText = dstMeta ? dstMeta.text : '';
        const dstIdx = engine.buildIndex(dstText);
        // 目标位置 after=symbol:Foo（插到符号之后）/ before=symbol:Foo（插到符号及其前置注释之前）
        const beforeRef = symbolPosOf(pos.before);
        const posRef = beforeRef || symbolPosOf(pos.after);
        if (posRef) {
            if (!dstMeta) throw new Error(`${P} 目标文件 ${dst.rel} 不存在，不能按符号定位插入点。`);
            const dstOutline = same ? srcOutline : await outlineOf(dst.rel, dstText);
            if (!dstOutline) throw new Error(`${P} ${dst.rel}：${astUnavailableReason(dst.rel)}。`);
            const res = SR.resolveInOutline(dstOutline, posRef);
            if (res.status === 'notFound') throw new Error(`${P} 目标位置：${symbolNotFoundMessage(res)}。`);
            if (res.status === 'ambiguous') {
                throw new Error(`${P} 目标位置符号 \`${res.query}\` 在 ${dst.rel} 中有 ${res.total} 处同名定义，请写更完整的限定名，或改用 after=N / before=N：\n${SR.renderCandidateLines(res.candidates)}`);
            }
            pos = beforeRef ? { before: res.symbol.fullStart } : { after: res.symbol.end };
            notes.push(`落点按符号 \`${res.symbol.qualified}\` 定位：${beforeRef ? `L${res.symbol.fullStart} 之前（含其前置注释）` : `L${res.symbol.end} 之后`}`);
        }
        if (!dstDisk.exists && pos.after === undefined && pos.before === undefined) pos.after = 0;
        if (pos.after === undefined && pos.before === undefined) {
            throw new Error(`${P} ${command} 需要目标位置：after=N（0 为文件开头、end 为末尾）或 before=N。行号以本次调用前的原文为准。`);
        }
        let point;
        try { point = engine.insertPoint(dstIdx, pos); } catch (error) { throw new Error(`${P} ${dst.rel}：${error.message}`); }
        const pointText = point.kind === 'before' ? `L${point.after + 1}之前` : `L${point.after}之后`;
        if (same && isMove && point.after >= block.startLine && point.after < block.endLine) {
            throw new Error(`${P} 目标位置 ${pointText} 位于源块 L${block.startLine}-${block.endLine} 内部。`);
        }

        const skip = same && isMove ? [block.startLine, block.endLine] : null;
        const refIndent = dstDisk.exists ? engine.autoIndent(dstIdx, point.after, skip) : '';
        let shifted;
        try { shifted = engine.shiftIndent(block.text, indentSpec, refIndent); } catch (error) { throw new Error(`${P} ${error.message}`); }
        if (shifted.from !== shifted.to) notes.push(`缩进已调整：${indentLabel(shifted.from)} → ${indentLabel(shifted.to)}`);

        const delStep = { step: 1, op: 'delete', start: block.startLine, end: block.endLine };
        const insStep = { step: 2, op: 'insert', after: point.after, content: shifted.text, raw: true };
        const changes = [];
        let placed;
        if (same) {
            const r = engineOk(engine.runEditString(srcMeta.text, isMove ? [delStep, insStep] : [insStep], { drift: opts.drift }), src.rel);
            placed = r.applied.find(a => a.step === 2)?.newRanges[0];
            changes.push({ file: src, disk: srcDisk, meta: srcMeta, before: srcMeta.text, after: r.text, op: 'edit' });
        } else {
            const r = engineOk(engine.runEditString(dstText, [insStep], { drift: opts.drift }), dst.rel);
            placed = r.applied[0]?.newRanges[0];
            changes.push({
                file: dst, disk: dstDisk, meta: dstMeta || { bom: false, lineEnding: srcMeta.lineEnding },
                before: dstText, after: r.text, op: dstDisk.exists ? 'edit' : 'create',
            });
            if (isMove) {
                const rs = engineOk(engine.runEditString(srcMeta.text, [delStep], { drift: opts.drift }), src.rel);
                changes.push({ file: src, disk: srcDisk, meta: srcMeta, before: srcMeta.text, after: rs.text, op: 'edit' });
            }
        }
        const effective = changes.filter(c => c.after !== c.before || !c.disk.exists);
        if (!effective.length) {
            return textResult(`## ℹ️ 内容无变化，未写入 · \`${src.rel}\` L${block.startLine}-${block.endLine} → ${pointText}`, { command, status: 'unchanged' });
        }

        for (const c of effective) {
            c.review = await reviewCode(c.file.abs, c.before, c.after);
            c.diff = renderDiff(c.before, c.after, c.file.rel);
        }
        if (opts.revertOnSyntaxError && effective.some(c => c.review.introduced.some(d => d.fatal))) {
            return textResult([
                `## ❌ ${command} 会引入语法错误，已按 revertOnSyntaxError 放弃写入`,
                ...effective.map(c => [`### \`${c.file.rel}\``, renderReview(c.review), c.diff.block].filter(Boolean).join('\n')),
            ].join('\n'), { command, status: 'rejected' });
        }

        // 外部修改先记账，保证回退不会吞掉手动改动
        for (const c of effective) {
            if (!c.disk.exists) continue;
            const note = recordExternalDrift(ctx.project, c.file.rel, c.disk);
            if (note) notes.push(note);
        }
        // 先写目标、后删源：中途失败时最多多出一份副本，不会丢代码
        for (const c of effective) {
            if (c.disk.exists) s.putBlob(c.disk.buffer);
            c.outBuf = encodeText(c.after, c.meta);
            c.afterHash = s.putBlob(c.outBuf);
            await fsp.mkdir(path.dirname(c.file.abs), { recursive: true });
            await fsp.writeFile(c.file.abs, c.outBuf);
        }
        const srcLabel = `${src.rel} L${block.startLine}-${block.endLine}`;
        const dstLabel = `${dst.rel} ${pointText}`;
        let batchId;
        s.transaction(() => {
            batchId = s.createBatch(ctx.project.id, 'edit', reason, maid);
            for (const c of effective) {
                let summary;
                if (same) summary = `${isMove ? '剪切' : '复制'} L${block.startLine}-${block.endLine} → ${pointText}`;
                else if (c.file === src) summary = `剪切 L${block.startLine}-${block.endLine} → ${dstLabel}`;
                else summary = `${isMove ? '移入' : '复制'} ← ${srcLabel}（${pointText}）`;
                c.nodeId = s.addNode({
                    projectId: ctx.project.id, batchId, filePath: c.file.rel, op: c.op,
                    beforeHash: c.disk.hash, afterHash: c.afterHash, todoId: todo?.id ?? null,
                    summary, added: c.diff.added, removed: c.diff.removed,
                });
            }
        });

        return textResult([
            `## ✅ 已${isMove ? '剪切' : '复制'} · \`${srcLabel}\` → \`${dstLabel}\``,
            `- 批次 \`b${batchId}\` · 节点 ${effective.map(c => `\`n${c.nodeId}\`（${c.file.rel}）`).join('、')} · 工程 \`${ctx.project.id}\` · ${whoOf(maid)}`,
            `- reason：${reason}`,
            `- 源块：L${block.startLine}-${block.endLine}（${block.lineCount} 行）${block.scope ? ` · in ${block.scope}` : ''}`,
            `- 落点：\`${dst.rel}\` ${placed || pointText}（新行号）${dstDisk.exists ? '' : '（新建文件）'}`,
            notes.length ? `- 提示：${notes.join('；')}` : '',
            `- 可用 Rollback batch=b${batchId} 整体撤销。`,
            ...effective.map(c => [`### \`${c.file.rel}\``, renderReview(c.review), c.diff.block].filter(Boolean).join('\n')),
        ].filter(Boolean).join('\n'), {
            command, status: 'ok', batchId, nodeIds: effective.map(c => c.nodeId),
            source: { path: src.rel, startLine: block.startLine, endLine: block.endLine }, placed,
        });
    });
}

const moveCode = args => transferCode(args, 'move');
const copyCode = args => transferCode(args, 'copy');

// ============================ 回退 ============================

function planBatchRollback(project, batch) {
    const s = store();
    const byFile = new Map();
    for (const node of s.getBatchNodes(project.id, batch.id)) {
        const item = byFile.get(node.file_path) || { rel: node.file_path, target: node.before_hash, expected: null, lastNode: 0 };
        item.expected = node.after_hash;
        item.lastNode = node.id;
        byFile.set(node.file_path, item);
    }
    return [...byFile.values()].map(item => ({ ...item, later: s.nodesAfter(project.id, item.lastNode, item.rel).length }));
}

function planNodeRollback(project, nodeId, relFilter) {
    const s = store();
    const files = [...new Set(s.nodesAfter(project.id, nodeId, relFilter).map(n => n.file_path))];
    return files.map(rel => ({ rel, target: s.fileHashAt(project.id, rel, nodeId) ?? null, expected: s.getFileState(project.id, rel) ?? null, later: 0 }));
}

async function rollback(args) {
    const ctx = projectOf(args, { write: true });
    const dryRun = A.bool(A.pick(args, 'dryRun'), false);
    const force = A.bool(A.pick(args, 'force'), false);
    const batchRef = A.str(args, 'batch', 'batchId');
    const nodeRef = A.str(args, 'toNode', 'node', 'nodeId');
    const pathArg = A.str(args, 'path', 'file');
    return withLock(ctx.project.id, async () => {
        const s = store();
        let items;
        let label;
        if (batchRef) {
            const batch = batchRef.toLowerCase() === 'last'
                ? s.lastBatch(ctx.project.id)
                : s.getBatch(ctx.project.id, idNum(batchRef, 'b', 'batch'));
            if (!batch) throw new Error(`${P} 批次 ${batchRef} 不存在或没有改动。可用 GetProject / SearchHistory 查看。`);
            items = planBatchRollback(ctx.project, batch);
            label = `回退批次 b${batch.id}（${batch.reason || KIND_LABEL[batch.kind] || batch.kind}）`;
        } else if (nodeRef) {
            const nodeId = idNum(nodeRef, 'n', 'toNode');
            if (!s.getNode(ctx.project.id, nodeId)) throw new Error(`${P} 节点 n${nodeId} 不存在。`);
            const rel = pathArg ? fileOf(ctx, pathArg).rel : null;
            items = planNodeRollback(ctx.project, nodeId, rel);
            label = rel ? `将 ${rel} 恢复到节点 n${nodeId} 时的状态` : `将工程恢复到节点 n${nodeId} 时的状态`;
        } else {
            throw new Error(`${P} Rollback 需要 batch（bX 或 last）或 toNode（nX，可配合 path 只回退单个文件）。`);
        }

        for (const item of items) {
            item.abs = fileOf(ctx, item.rel, { write: true }).abs;
            item.disk = await readDisk(item.abs);
            if (item.target === null) item.action = item.disk.exists ? '移到回收站' : '无需操作';
            else if (item.disk.hash === item.target) item.action = '无需操作';
            else item.action = item.disk.exists ? '恢复内容' : '重建文件';
            item.conflicts = [];
            if (item.disk.hash !== item.expected) item.conflicts.push('磁盘内容与记录不一致（外部修改）');
            if (item.later) item.conflicts.push(`此后该文件还有 ${item.later} 次改动`);
        }
        const conflicted = items.filter(i => i.conflicts.length && i.action !== '无需操作');
        const table = `| 文件 | 动作 | 冲突 |\n|---|---|---|\n${items.map(i => `| \`${i.rel}\` | ${i.action} | ${i.conflicts.join('；') || '-'} |`).join('\n')}`;

        if (dryRun || (conflicted.length && !force)) {
            const blocked = conflicted.length && !force && !dryRun;
            return textResult([
                `## ${blocked ? '❌ 存在冲突，未执行' : '🔍 回退预演（dryRun）'}：${label}`,
                table,
                blocked ? '- 确认覆盖请加 force=true（当前磁盘内容会先存快照，仍可再回退）。' : '- 去掉 dryRun 即可执行。',
            ].join('\n'), { command: 'Rollback', status: blocked ? 'conflict' : 'dryRun', items: items.map(({ disk, abs, ...rest }) => rest) });
        }

        const todo = items.filter(i => i.action !== '无需操作');
        if (!todo.length) return textResult(`## ℹ️ 无需回退：${label}\n${table}`, { command: 'Rollback', status: 'noop' });
        // 先写完所有文件，全部成功后再在一个事务里记批次与节点；
        // 中途失败（例如文件被编辑器占用）时按逆序把已写入的文件恢复为回退前内容，不留下"回退了一半"的状态。
        const applied = [];
        try {
            for (const item of todo) {
                await assertDiskUnchanged(item.abs, item.disk.hash, item.rel);
                if (item.disk.exists) s.putBlob(item.disk.buffer);
                if (item.target === null) {
                    await moveToTrash(item.abs);
                } else {
                    await fsp.mkdir(path.dirname(item.abs), { recursive: true });
                    await fsp.writeFile(item.abs, s.getBlob(item.target));
                }
                applied.push(item);
            }
        } catch (error) {
            const unrestored = [];
            for (const item of applied.slice().reverse()) {
                try {
                    if (item.disk.exists) {
                        await fsp.mkdir(path.dirname(item.abs), { recursive: true });
                        await fsp.writeFile(item.abs, item.disk.buffer);
                    } else {
                        await moveToTrash(item.abs);
                    }
                } catch (restoreError) {
                    unrestored.push(`\`${item.rel}\`（${restoreError.message}）`);
                }
            }
            const lines = [
                `${P} 回退中途失败，未记录回退批次：${error.message}`,
                `- 已写入的 ${applied.length} 个文件中，${applied.length - unrestored.length} 个已恢复为回退前内容。`,
            ];
            if (unrestored.length) lines.push(`- 以下文件未能自动恢复，请手动检查（回退前内容已存快照）：${unrestored.join('、')}`);
            throw new Error(lines.join('\n'));
        }
        let batchId;
        const done = [];
        s.transaction(() => {
            batchId = s.createBatch(ctx.project.id, 'rollback', A.str(args, 'reason') || label, maidOf(args));
            for (const item of applied) {
                const nodeId = s.addNode({
                    projectId: ctx.project.id, batchId, filePath: item.rel, op: 'rollback',
                    beforeHash: item.disk.hash, afterHash: item.target, summary: label,
                });
                done.push(`\`${item.rel}\`：${item.action}（节点 \`n${nodeId}\`）`);
            }
        });
        return textResult([
            `## ✅ 已回退：${label}`,
            `- 回退批次 \`b${batchId}\`（回退本身也可再回退：Rollback batch=b${batchId}）`,
            ...done.map(d => `- ${d}`),
        ].join('\n'), { command: 'Rollback', status: 'ok', batchId, count: done.length });
    });
}

// ============================ 历史 ============================

async function searchHistory(args) {
    const s = store();
    const projectId = A.str(args, 'projectId', 'project');
    if (projectId && !s.getProject(projectId)) throw new Error(`${P} 工程 ${projectId} 不存在。`);
    const glob = A.str(args, 'file', 'path', 'glob');
    const todoRaw = A.pick(args, 'todo');
    let todoId = null;
    if (todoRaw !== undefined) {
        if (!projectId) throw new Error(`${P} 按 todo 过滤时需要 projectId。`);
        todoId = s.getTodoBySeq(projectId, Number(String(todoRaw).replace(/^#/, '')))?.id ?? -1;
    }
    const contentKw = A.str(args, 'content');
    const limit = posInt(A.pick(args, 'limit'), 30);
    let rows = s.searchNodes({
        projectId: projectId || null,
        filePattern: glob ? glob.replace(/\\/g, '/').replace(/\*\*\/?/g, '%').replace(/\*/g, '%').replace(/\?/g, '_') : null,
        since: A.str(args, 'since') || null,
        until: A.str(args, 'until') || null,
        todoId,
        op: A.str(args, 'op') || null,
        batchId: A.pick(args, 'batch') !== undefined ? idNum(A.pick(args, 'batch'), 'b', 'batch') : null,
        maid: A.str(args, 'byMaid', 'author') || null,
        keyword: A.str(args, 'keyword', 'query') || null,
        limit: contentKw ? 500 : limit,
    });
    if (contentKw) {
        rows = rows.filter(r => {
            try { return r.after_hash && s.getBlob(r.after_hash).toString('utf8').includes(contentKw); } catch (_e) { return false; }
        }).slice(0, limit);
    }
    const lines = rows.map(r => `- \`n${r.id}\` · \`b${r.batch_id}\`${projectId ? '' : ` · \`${r.project_id}\``} · ${whoOf(r.maid, r.batch_kind)} · ${r.op} · \`${r.file_path}\` · +${r.added}/-${r.removed} · ${fmtTime(r.created_at)}\n  - ${r.effective_reason || r.summary || '（未记录原因）'}`);
    return textResult(`## 改动历史（${rows.length} 条）\n${lines.join('\n') || '- 没有匹配的记录。'}\n- 查看具体改动：GetNodeDiff node=nX 或 batch=bX`, { command: 'SearchHistory', count: rows.length, nodes: rows });
}

function blobText(hash) {
    if (!hash) return '';
    const buf = store().getBlob(hash);
    if (buf.subarray(0, 8000).includes(0)) return null;
    return T.normalizeEol(buf.toString('utf8').replace(/^\uFEFF/, ''));
}

async function getNodeDiff(args) {
    const { project } = projectOf(args);
    const s = store();
    let nodes;
    let title;
    const nodeRef = A.pick(args, 'node', 'nodeId');
    const batchRef = A.pick(args, 'batch', 'batchId');
    if (nodeRef !== undefined) {
        const node = s.getNode(project.id, idNum(nodeRef, 'n', 'node'));
        if (!node) throw new Error(`${P} 节点 ${nodeRef} 不存在。`);
        nodes = [node];
        title = `节点 n${node.id}`;
    } else if (batchRef !== undefined) {
        const batch = s.getBatch(project.id, idNum(batchRef, 'b', 'batch'));
        if (!batch) throw new Error(`${P} 批次 ${batchRef} 不存在。`);
        nodes = s.getBatchNodes(project.id, batch.id);
        title = `批次 b${batch.id} · ${batch.reason || batch.kind}`;
    } else {
        throw new Error(`${P} GetNodeDiff 需要 node（nX）或 batch（bX）。`);
    }
    const maxLines = posInt(A.pick(args, 'maxLines'), 400);
    const blocks = nodes.map(n => {
        const head = `### \`n${n.id}\` · ${n.op} · \`${n.file_path}\` · ${fmtTime(n.created_at)}${n.reason ? `\n- ${n.reason}` : ''}`;
        const before = blobText(n.before_hash);
        const after = blobText(n.after_hash);
        if (before === null || after === null) return `${head}\n- 二进制内容，省略 diff。`;
        const d = unifiedDiff(before, after, { oldLabel: `a/${n.file_path}`, newLabel: `b/${n.file_path}`, maxLines });
        return `${head}\n${d.text ? T.markdownFence(d.text, 'diff') : '- 内容无差异'}`;
    });
    return textResult(`## ${title}\n${blocks.join('\n\n')}`, { command: 'GetNodeDiff', count: nodes.length });
}

// ============================ 分发 ============================

const COMMANDS = {
    listworkspaces: listWorkspaces,
    createproject: createProject,
    listprojects: listProjects,
    searchprojects: searchProjects,
    getproject: getProject,
    updatetodos: updateTodos,
    submitreport: submitReport,
    deleteprojects: deleteProjects,
    restoreprojects: restoreProjects,
    purgeprojects: purgeProjects,
    readcode: readCode,
    editcode: editCode,
    resolveedit: resolveEdit,
    createfile: createFile,
    removefile: removeFile,
    movefile: moveFile,
    movecode: moveCode,
    copycode: copyCode,
    rollback,
    searchhistory: searchHistory,
    getnodediff: getNodeDiff,
    outline: outlineCmd,
    findsymbol: findSymbolCmd,
    trace: traceCmd,
};

const COMMAND_NAMES = 'ListWorkspaces、CreateProject、ListProjects、SearchProjects、GetProject、UpdateTodos、SubmitReport、DeleteProjects、RestoreProjects、PurgeProjects、ReadCode、EditCode、ResolveEdit、CreateFile、RemoveFile、MoveFile、MoveCode、CopyCode、Rollback、SearchHistory、GetNodeDiff、Outline、FindSymbol、Trace';

const MUTATING_COMMANDS = new Set([
    'createproject', 'updatetodos', 'submitreport', 'deleteprojects',
    'restoreprojects', 'purgeprojects', 'editcode', 'resolveedit',
    'createfile', 'removefile', 'movefile', 'movecode', 'copycode', 'rollback',
]);

async function processToolCall(rawArgs = {}, _executionContext = {}) {
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
        throw new Error(`${P} 无效的工具参数。`);
    }
    const args = A.lowerKeys(rawArgs);
    const command = A.str(args, 'command', 'action').toLowerCase();
    const handler = COMMANDS[command];
    if (!handler) throw new Error(`${P} 不支持的 command“${command || '(空)'}”。可用：${COMMAND_NAMES}。`);
    const result = await handler(args);
    if (MUTATING_COMMANDS.has(command)) {
        emitProjectChanged({
            action: command,
            projectId: result?.details?.projectId || args.projectid || null,
            details: result?.details || null,
        });
    }
    return result;
}

// ============================ GUI 门面 ============================
// 供 VChat 施工图 GUI 调用：除 revertFileChange 外全部只读，返回纯 JSON（经 IPC 结构化克隆）。

const GUI_TEXT_LIMIT = 2 * 1024 * 1024;

function guiRootInfo(project) {
    const info = runtime.resolver.projectRoot(project);
    return { root: info.root, writable: info.writable, blockedReason: info.blockedReason, workspaceAlias: info.workspaceAlias };
}

function guiProjectSummary(project) {
    const s = store();
    return {
        ...project,
        report: undefined,
        hasReport: Boolean(project.report),
        rootInfo: guiRootInfo(project),
        progress: todoProgress(s.listTodos(project.id)),
        stats: s.projectStats(project.id),
        maids: s.contributors(project.id).map(c => c.maid || null),
    };
}

function guiProjectOf(projectId) {
    const project = store().getProject(projectId, { includeDeleted: true });
    if (!project) throw new Error(`${P} 工程 ${projectId || '(空)'} 不存在。`);
    return project;
}

function guiBlobText(hash) {
    if (!hash) return { exists: false, binary: false, truncated: false, size: 0, text: '' };
    const buf = store().getBlob(hash);
    if (buf.subarray(0, 8000).includes(0)) return { exists: true, binary: true, truncated: false, size: buf.length, text: '' };
    const truncated = buf.length > GUI_TEXT_LIMIT;
    const text = T.normalizeEol(buf.subarray(0, truncated ? GUI_TEXT_LIMIT : buf.length).toString('utf8').replace(/^\uFEFF/, ''));
    return { exists: true, binary: false, truncated, size: buf.length, text };
}

const gui = {
    listProjects({ includeDeleted = false, query = '' } = {}) {
        return store().listProjects({ includeDeleted: Boolean(includeDeleted), query: String(query || '').trim() || null })
            .map(guiProjectSummary);
    },

    getProject(projectId, { timelineLimit = 200 } = {}) {
        const s = store();
        const project = guiProjectOf(projectId);
        return {
            project: { ...guiProjectSummary(project), report: project.report || null },
            todos: s.listTodos(project.id),
            contributors: s.contributors(project.id),
            files: s.changedFiles(project.id),
            timeline: s.timeline(project.id, { limit: timelineLimit }).map(r => ({
                ...r, files: String(r.files || '').split(',').filter(Boolean),
            })),
        };
    },

    searchHistory(filters = {}) {
        const s = store();
        const contentKw = String(filters.content || '').trim();
        const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 500);
        const glob = String(filters.file || '').trim();
        let rows = s.searchNodes({
            projectId: filters.projectId || null,
            filePattern: glob ? `%${glob.replace(/\\/g, '/').replace(/\*/g, '%').replace(/\?/g, '_')}%` : null,
            op: filters.op || null,
            batchId: filters.batchId ? Number(filters.batchId) : null,
            maid: String(filters.byMaid || '').trim() || null,
            keyword: String(filters.keyword || '').trim() || null,
            since: filters.since || null,
            until: filters.until || null,
            limit: contentKw ? 500 : limit,
        });
        if (contentKw) {
            rows = rows.filter(r => {
                try { return r.after_hash && s.getBlob(r.after_hash).toString('utf8').includes(contentKw); } catch (_e) { return false; }
            }).slice(0, limit);
        }
        return rows;
    },

    getBatchNodes(projectId, batchId) {
        const s = store();
        const batch = s.getBatch(projectId, Number(batchId));
        if (!batch) throw new Error(`${P} 批次 b${batchId} 不存在。`);
        return { batch, nodes: s.getBatchNodes(projectId, batch.id) };
    },

    /** 节点详情 + 改动前后全文（供 MergeView 渲染）+ 回退预检信息。 */
    getNodeDetail(projectId, nodeId) {
        const s = store();
        const node = s.getNode(projectId, Number(nodeId));
        if (!node) throw new Error(`${P} 节点 n${nodeId} 不存在。`);
        const batch = node.batch_id ? s.getBatch(projectId, node.batch_id) : null;
        return {
            node,
            batch,
            todo: node.todo_id ? s.listTodos(projectId).find(t => t.id === node.todo_id) || null : null,
            before: guiBlobText(node.before_hash),
            after: guiBlobText(node.after_hash),
            laterChanges: s.nodesAfter(projectId, node.id, node.file_path).length,
        };
    },

    /**
     * 回退单个文件变动（GUI 唯一的写操作），必须署名。
     * mode=before：撤销该节点，文件恢复到改动前；mode=after：文件恢复到该节点完成时的状态。
     * 与 Rollback 一致：外部修改或后续还有改动视为冲突，需 force；回退本身生成新批次，可再回退。
     */
    async revertFileChange({ projectId, nodeId, mode = 'before', signature, reason = '', dryRun = false, force = false, expectedHash } = {}) {
        const maid = String(signature || '').trim().slice(0, 100);
        if (!maid) throw new Error(`${P} 回退需要署名。`);
        if (expectedHash !== undefined && expectedHash !== null && (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash))) {
            throw new Error(`${P} 回退预检的文件 hash 无效，请重新预检。`);
        }
        const ctx = projectOf({ projectid: projectId }, { write: true });
        return withLock(ctx.project.id, async () => {
            const s = store();
            const node = s.getNode(ctx.project.id, Number(nodeId));
            if (!node) throw new Error(`${P} 节点 n${nodeId} 不存在。`);
            const useAfter = mode === 'after';
            const target = (useAfter ? node.after_hash : node.before_hash) ?? null;
            const file = fileOf(ctx, node.file_path, { write: true });
            const disk = await readDisk(file.abs);
            const expected = s.getFileState(ctx.project.id, node.file_path) ?? null;
            const later = s.nodesAfter(ctx.project.id, node.id, node.file_path).length;
            let action;
            if (target === null) action = disk.exists ? '移到回收站' : '无需操作';
            else if (disk.hash === target) action = '无需操作';
            else action = disk.exists ? '恢复内容' : '重建文件';
            const conflicts = [];
            if (disk.hash !== expected) conflicts.push('磁盘内容与记录不一致（外部修改）');
            if (later) conflicts.push(`此后该文件还有 ${later} 次改动，将一并被覆盖`);
            const label = `${useAfter ? '恢复到' : '撤销'}节点 n${node.id} · ${node.file_path}（GUI 人工回退）`;
            const plan = { label, file: node.file_path, action, conflicts, mode: useAfter ? 'after' : 'before', expectedHash: disk.hash };
            if (action === '无需操作') return { status: 'noop', ...plan };
            if (dryRun) return { status: 'dryRun', ...plan };
            // force 只确认预检时看到的冲突，不能顺带覆盖确认页打开后的新编辑。
            // null 表示预检时文件不存在；未传 expectedHash 的旧调用保留原有语义。
            if (expectedHash !== undefined && disk.hash !== expectedHash) {
                return { status: 'conflict', ...plan, conflicts: [...conflicts, '文件在预检后发生变化，请重新预检'] };
            }
            if (conflicts.length && !force) return { status: 'conflict', ...plan };

            let batchId;
            let newNodeId;
            await assertDiskUnchanged(file.abs, disk.hash, node.file_path);
            if (disk.exists) s.putBlob(disk.buffer);
            await applyGuiRevert({
                file: file.abs, disk, target, content: target === null ? null : s.getBlob(target),
                recoveryDir: path.join(path.dirname(runtime.dbPath), 'recovery'),
                readDisk, trash: moveToTrash, logger: runtime.logger,
                record: () => s.transaction(() => {
                    batchId = s.createBatch(ctx.project.id, 'rollback', String(reason || '').trim().slice(0, 500) || label, maid);
                    newNodeId = s.addNode({
                        projectId: ctx.project.id, batchId, filePath: node.file_path, op: 'rollback',
                        beforeHash: disk.hash, afterHash: target, summary: label,
                    });
                }),
            });
            runtime.logger?.log?.(`${P} GUI 回退 n${node.id} by @${maid} → b${batchId}`);
            emitProjectChanged({ action: 'gui:revert', projectId: ctx.project.id, batchId, nodeId: newNodeId, maid });
            return { status: 'ok', ...plan, batchId, nodeId: newNodeId, maid };
        });
    },
    deleteProject(projectId, maid = '') {
        const id = String(projectId || '').trim();
        if (!id) throw new Error(`${P} 删除工程需要指定 projectId。`);
        const done = store().softDeleteProjects([id], String(maid || '').trim());
        runtime.logger?.log?.(`${P} GUI 删除工程 ${id} by @${maid || 'anonymous'}`);
        emitProjectChanged({ action: 'gui:delete', projectId: id, maid: maid || null });
        return { deleted: done.includes(id), projectId: id };
    },
};
module.exports = {
    initialize,
    ensureRuntime,
    processToolCall,
    cleanup,
    gui,
    events: projectEvents,
    _test: {
        // 同步替换运行时（不 await 也不会覆盖随后的 initialize）；返回的 Promise 可选择等待旧索引器退出
        resetForTests: () => {
            closeStore();
            const old = runtime.indexer;
            runtime = freshRuntime();
            return old ? old.stop().catch(() => { /* 已退出 */ }) : Promise.resolve();
        },
        getRuntime: () => runtime,
        astIgnoreDirs,
    },
};
