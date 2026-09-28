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
const { ProjectStore, sha256 } = require('./store');
const engine = require('./engine');
const { WorkspaceResolver } = require('./workspace');
const { TicketStore, parsePickSpec } = require('./tickets');
const A = require('./args');
const T = require('../../shared/fileKit/text');
const { validateCode, diffDiagnostics, isValidatable } = require('../../shared/fileKit/validator');
const { unifiedDiff } = require('../../shared/fileKit/diff');
const { readFilesAsContent } = require('../../shared/fileKit/reader');
const { textResult, partsResult, formatDiagnostics } = require('../../shared/fileKit/output');

const P = '[ProjectForge]';
const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', '..', 'AppData', 'ProjectForge', 'projectforge.db');
const UTF8_BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

function posInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
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
        initialized: false,
        ...overrides,
    };
}

let runtime = freshRuntime();
const locks = new Map();

// ============================ 生命周期 ============================

function initialize(options = {}) {
    closeStore();
    const config = options.config || {};
    runtime = freshRuntime({
        resolver: new WorkspaceResolver({
            workspaceService: options.services?.workspaceService || options.workspaceService || null,
            extraAllowed: String(config.ALLOWED_DIRECTORIES || '').split(','),
        }),
        logger: options.logger || console,
        dbPath: config.PROJECTFORGE_DB_PATH ? path.resolve(config.PROJECTFORGE_DB_PATH) : (options.dbPath || DEFAULT_DB_PATH),
        maxEditSize: posInt(config.MAX_EDIT_FILE_SIZE, 5 * 1024 * 1024),
        readMaxFiles: posInt(config.READ_MAX_FILES, 20),
        readMaxBytes: posInt(config.READ_MAX_TOTAL_BYTES, 30 * 1024 * 1024),
        trash: typeof options.trash === 'function' ? options.trash : null,
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

async function cleanup() {
    closeStore();
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
    if (runtime.resolver.extraAllowed.length) lines.push(...runtime.resolver.extraAllowed.map(d => `- （配置目录）${d}`));
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

async function listProjects(args) {
    const ws = A.str(args, 'workspace', 'workspaceAlias');
    const all = !ws || ws.toLowerCase() === 'all';
    const s = store();
    const rows = s.listProjects({
        workspaceAlias: all ? null : (runtime.resolver.find(ws, { includeDisabled: true })?.alias || ws.toLowerCase()),
        includeDeleted: A.bool(A.pick(args, 'includeDeleted'), false),
        query: A.str(args, 'query') || null,
    });
    const lines = rows.map(p => {
        const prog = todoProgress(s.listTodos(p.id));
        return `| \`${p.id}\` | ${p.name} | ${p.workspace_alias || '-'} | ${p.deleted_at ? '已删除' : p.status} | ${prog.text} | ${p.report ? '有' : '-'} | ${fmtTime(p.updated_at)} |`;
    });
    const text = rows.length
        ? `## 工程列表（${all ? '全部工作区' : `工作区 ${ws}`}，${rows.length} 个）\n| ID | 名称 | 工作区 | 状态 | Todo | 报告 | 更新 |\n|---|---|---|---|---|---|---|\n${lines.join('\n')}`
        : `## 工程列表\n- 没有匹配的工程。可用 CreateProject 创建。`;
    return textResult(text, { command: 'ListProjects', count: rows.length, projects: rows });
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
    if (single) {
        const { path: p, lines } = splitPathRange(single);
        targets.push({ ...fileOf(ctx, p), lines: A.str(args, 'lines') || lines });
    }
    for (const entry of A.list(A.pick(args, 'paths', 'files'))) {
        const { path: p, lines } = splitPathRange(entry);
        targets.push({ ...fileOf(ctx, p), lines });
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
    return targets.filter(t => !seen.has(`${t.rel}|${t.lines || ''}`) && seen.add(`${t.rel}|${t.lines || ''}`));
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
        const hits = engine.findTarget(idx, query);
        total += hits.length;
        for (const h of hits.slice(0, Math.max(0, 30 - out.length))) {
            const scope = engine.enclosingScope(idx, h.startLine);
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
    const result = await readFilesAsContent(
        targets.map(t => ({ absPath: t.abs, displayPath: t.rel, lines: t.lines })),
        { withLineNumbers: showLine, maxFiles: runtime.readMaxFiles, maxTotalBytes: runtime.readMaxBytes, maxFileSize: runtime.maxEditSize * 4 },
    );
    const head = {
        type: 'text',
        text: `## ReadCode · ${result.read.length} 个文件\n${projectHeader(ctx.project, ctx.rootInfo)}${showLine ? '\n- 行号前缀 `N | ` 仅供定位，EditCode 时可直接粘贴，插件会自动剥除。' : ''}`,
    };
    return partsResult([head, ...result.parts], { command: 'ReadCode', read: result.read, skipped: result.skipped, failed: result.failed });
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
        `### 步骤 ${a.step}：target 共命中 ${a.total} 处${a.tooMany ? `（仅列出前 ${a.candidates.length} 处，建议加长 target 或提供 line）` : ''}`,
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
        const probe = engine.runEditString(meta.text, plan.ticket.steps, engineOpts);
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

    const result = engine.runEditString(meta.text, plan.steps, engineOpts);
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
    const file = fileOf(ctx, A.str(args, 'path', 'file', 'filePath'), { write: true });
    const steps = A.parseEditSteps(args);
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
        const batchId = s.createBatch(ctx.project.id, 'rollback', A.str(args, 'reason') || label, maidOf(args));
        const done = [];
        for (const item of todo) {
            if (item.disk.exists) s.putBlob(item.disk.buffer);
            if (item.target === null) {
                await moveToTrash(item.abs);
            } else {
                await fsp.mkdir(path.dirname(item.abs), { recursive: true });
                await fsp.writeFile(item.abs, s.getBlob(item.target));
            }
            const nodeId = s.addNode({
                projectId: ctx.project.id, batchId, filePath: item.rel, op: 'rollback',
                beforeHash: item.disk.hash, afterHash: item.target, summary: label,
            });
            done.push(`\`${item.rel}\`：${item.action}（节点 \`n${nodeId}\`）`);
        }
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
    rollback,
    searchhistory: searchHistory,
    getnodediff: getNodeDiff,
};

const COMMAND_NAMES = 'ListWorkspaces、CreateProject、ListProjects、GetProject、UpdateTodos、SubmitReport、DeleteProjects、RestoreProjects、PurgeProjects、ReadCode、EditCode、ResolveEdit、CreateFile、RemoveFile、MoveFile、Rollback、SearchHistory、GetNodeDiff';

async function processToolCall(rawArgs = {}, _executionContext = {}) {
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
        throw new Error(`${P} 无效的工具参数。`);
    }
    const args = A.lowerKeys(rawArgs);
    const command = A.str(args, 'command', 'action').toLowerCase();
    const handler = COMMANDS[command];
    if (!handler) throw new Error(`${P} 不支持的 command“${command || '(空)'}”。可用：${COMMAND_NAMES}。`);
    return handler(args);
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
    async revertFileChange({ projectId, nodeId, mode = 'before', signature, reason = '', dryRun = false, force = false } = {}) {
        const maid = String(signature || '').trim().slice(0, 100);
        if (!maid) throw new Error(`${P} 回退需要署名。`);
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
            const plan = { label, file: node.file_path, action, conflicts, mode: useAfter ? 'after' : 'before' };
            if (action === '无需操作') return { status: 'noop', ...plan };
            if (dryRun) return { status: 'dryRun', ...plan };
            if (conflicts.length && !force) return { status: 'conflict', ...plan };

            let batchId;
            let newNodeId;
            if (disk.exists) s.putBlob(disk.buffer);
            if (target === null) {
                await moveToTrash(file.abs);
            } else {
                await fsp.mkdir(path.dirname(file.abs), { recursive: true });
                await fsp.writeFile(file.abs, s.getBlob(target));
            }
            s.transaction(() => {
                batchId = s.createBatch(ctx.project.id, 'rollback', String(reason || '').trim().slice(0, 500) || label, maid);
                newNodeId = s.addNode({
                    projectId: ctx.project.id, batchId, filePath: node.file_path, op: 'rollback',
                    beforeHash: disk.hash, afterHash: target, summary: label,
                });
            });
            runtime.logger?.log?.(`${P} GUI 回退 n${node.id} by @${maid} → b${batchId}`);
            return { status: 'ok', ...plan, batchId, nodeId: newNodeId, maid };
        });
    },
};

module.exports = {
    initialize,
    ensureRuntime,
    processToolCall,
    cleanup,
    gui,
    _test: {
        resetForTests: () => { closeStore(); runtime = freshRuntime(); },
        getRuntime: () => runtime,
    },
};