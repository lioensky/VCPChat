'use strict';
// ProjectForge 数据层：better-sqlite3 + WAL，单连接常驻。
// blob 采用 sha256 内容寻址 + gzip 压缩，完整快照存储（回退不依赖 diff）。
// file_state 记录插件最后一次已知的文件 hash（NULL = 文件不存在），用于外部漂移检测。

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 2;

// 旧库自动补列：CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，这里按需 ALTER。
const MIGRATION_COLUMNS = {
    projects: { subpath: "TEXT NOT NULL DEFAULT ''", created_by: 'TEXT', deleted_by: 'TEXT', report_by: 'TEXT' },
    todos: { updated_by: 'TEXT' },
    batches: { reason: 'TEXT', maid: 'TEXT' },
    nodes: { reason: 'TEXT' },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS projects (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    workspace_id    TEXT,
    workspace_alias TEXT,
    root            TEXT NOT NULL,
    subpath         TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'active',
    report          TEXT,
    created_by      TEXT,
    deleted_by      TEXT,
    report_by       TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    deleted_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_ws ON projects(workspace_alias);

CREATE TABLE IF NOT EXISTS todos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    title      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    note       TEXT,
    updated_by TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id, seq);

CREATE TABLE IF NOT EXISTS batches (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    reason     TEXT,
    maid       TEXT,
    summary    TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batches_project ON batches(project_id, id);

CREATE TABLE IF NOT EXISTS nodes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    batch_id    INTEGER REFERENCES batches(id) ON DELETE CASCADE,
    file_path   TEXT NOT NULL,
    op          TEXT NOT NULL,
    before_hash TEXT,
    after_hash  TEXT,
    todo_id     INTEGER,
    reason      TEXT,
    summary     TEXT,
    added       INTEGER NOT NULL DEFAULT 0,
    removed     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id, id);
CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(project_id, file_path, id);
CREATE INDEX IF NOT EXISTS idx_nodes_batch ON nodes(batch_id);

CREATE TABLE IF NOT EXISTS blobs (
    hash TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    data BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS file_state (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_path  TEXT NOT NULL,
    hash       TEXT,
    PRIMARY KEY (project_id, file_path)
);
`;

function nowIso() {
    return new Date().toISOString();
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

class ProjectStore {
    constructor(dbPath) {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        this.dbPath = dbPath;
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('synchronous = NORMAL');
        this.db.exec(SCHEMA);
        this.migrate();
        this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    }

    migrate() {
        for (const [table, columns] of Object.entries(MIGRATION_COLUMNS)) {
            const existing = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
            for (const [column, type] of Object.entries(columns)) {
                if (!existing.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
            }
        }
        // 依赖新列的索引必须在补列之后创建
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_batches_maid ON batches(maid)');
    }

    close() {
        if (this.db && this.db.open) this.db.close();
        this.db = null;
    }

    transaction(fn) {
        return this.db.transaction(fn)();
    }

    // ---------- blobs ----------

    /** 存入内容并返回 hash；内容为 null 表示“文件不存在”，返回 null。 */
    putBlob(content) {
        if (content === null || content === undefined) return null;
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
        const hash = sha256(buffer);
        this.db.prepare('INSERT OR IGNORE INTO blobs(hash, size, data) VALUES (?, ?, ?)')
            .run(hash, buffer.length, zlib.gzipSync(buffer));
        return hash;
    }

    /** 取回原始 Buffer；hash 为 null 返回 null。 */
    getBlob(hash) {
        if (!hash) return null;
        const row = this.db.prepare('SELECT data FROM blobs WHERE hash = ?').get(hash);
        if (!row) throw new Error(`快照 ${hash.slice(0, 12)} 丢失，无法恢复。`);
        return zlib.gunzipSync(row.data);
    }

    /** 回收不再被任何节点引用的 blob。 */
    gcBlobs() {
        return this.db.prepare(`
            DELETE FROM blobs WHERE hash NOT IN (
                SELECT before_hash FROM nodes WHERE before_hash IS NOT NULL
                UNION SELECT after_hash FROM nodes WHERE after_hash IS NOT NULL
                UNION SELECT hash FROM file_state WHERE hash IS NOT NULL
            )`).run().changes;
    }

    // ---------- projects ----------

    newProjectId() {
        const exists = this.db.prepare('SELECT 1 FROM projects WHERE id = ?');
        for (let i = 0; i < 50; i++) {
            const id = `p${crypto.randomBytes(3).readUIntBE(0, 3).toString(36).padStart(4, '0').slice(-4)}`;
            if (!exists.get(id)) return id;
        }
        throw new Error('无法生成唯一工程 ID。');
    }

    /** subpath：工程根相对工作区根的 posix 路径；工作区搬家后按 workspace_id + subpath 重新定位。 */
    createProject({ name, workspaceId, workspaceAlias, root, subpath = '', createdBy = null }) {
        const id = this.newProjectId();
        const ts = nowIso();
        this.db.prepare(`INSERT INTO projects(id, name, workspace_id, workspace_alias, root, subpath, status, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`).run(id, name, workspaceId || null, workspaceAlias || null, root, subpath, createdBy, ts, ts);
        return this.getProject(id);
    }

    getProject(id, { includeDeleted = false } = {}) {
        const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(String(id || '').trim());
        if (!row || (!includeDeleted && row.deleted_at)) return null;
        return row;
    }

    listProjects({ workspaceAlias = null, includeDeleted = false, query = null } = {}) {
        const where = [];
        const params = [];
        if (!includeDeleted) where.push('deleted_at IS NULL');
        if (workspaceAlias) { where.push('workspace_alias = ?'); params.push(workspaceAlias); }
        if (query) { where.push('(name LIKE ? OR id = ?)'); params.push(`%${query}%`, query); }
        const sql = `SELECT * FROM projects ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`;
        return this.db.prepare(sql).all(...params);
    }

    updateProject(id, patch) {
        const fields = [];
        const params = [];
        for (const [key, column] of [['name', 'name'], ['status', 'status'], ['report', 'report'], ['reportBy', 'report_by'], ['root', 'root'], ['workspaceAlias', 'workspace_alias'], ['deletedAt', 'deleted_at']]) {
            if (Object.prototype.hasOwnProperty.call(patch, key)) { fields.push(`${column} = ?`); params.push(patch[key]); }
        }
        fields.push('updated_at = ?');
        params.push(nowIso(), id);
        this.db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...params);
        return this.getProject(id, { includeDeleted: true });
    }

    touchProject(id) {
        this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(nowIso(), id);
    }

    /** 软删：只写 deleted_at，不动磁盘。 */
    softDeleteProjects(ids, maid = null) {
        const stmt = this.db.prepare('UPDATE projects SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL');
        const ts = nowIso();
        return this.transaction(() => ids.filter(id => stmt.run(ts, maid, ts, id).changes > 0));
    }

    restoreProjects(ids) {
        const stmt = this.db.prepare('UPDATE projects SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL');
        const ts = nowIso();
        return this.transaction(() => ids.filter(id => stmt.run(ts, id).changes > 0));
    }

    /** 物理清除：级联删除 todo/节点/状态，再回收孤立 blob。不动磁盘文件。 */
    purgeProjects(ids) {
        const stmt = this.db.prepare('DELETE FROM projects WHERE id = ?');
        const purged = this.transaction(() => ids.filter(id => stmt.run(id).changes > 0));
        const freedBlobs = this.gcBlobs();
        return { purged, freedBlobs };
    }

    // ---------- todos ----------

    listTodos(projectId) {
        return this.db.prepare('SELECT * FROM todos WHERE project_id = ? ORDER BY seq, id').all(projectId);
    }

    addTodos(projectId, titles, maid = null) {
        const maxSeq = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM todos WHERE project_id = ?').get(projectId).m;
        const stmt = this.db.prepare('INSERT INTO todos(project_id, seq, title, status, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
        const ts = nowIso();
        return this.transaction(() => titles.map((title, i) => stmt.run(projectId, maxSeq + i + 1, title, 'pending', maid, ts).lastInsertRowid));
    }

    /** 按项目内序号(seq)更新；返回是否命中。 */
    updateTodo(projectId, seq, patch) {
        const fields = [];
        const params = [];
        for (const key of ['title', 'status', 'note']) {
            if (patch[key] !== undefined) { fields.push(`${key} = ?`); params.push(patch[key]); }
        }
        if (!fields.length) return false;
        if (patch.updatedBy) { fields.push('updated_by = ?'); params.push(patch.updatedBy); }
        fields.push('updated_at = ?');
        params.push(nowIso(), projectId, seq);
        return this.db.prepare(`UPDATE todos SET ${fields.join(', ')} WHERE project_id = ? AND seq = ?`).run(...params).changes > 0;
    }

    removeTodo(projectId, seq) {
        return this.db.prepare('DELETE FROM todos WHERE project_id = ? AND seq = ?').run(projectId, seq).changes > 0;
    }

    getTodoBySeq(projectId, seq) {
        return this.db.prepare('SELECT * FROM todos WHERE project_id = ? AND seq = ?').get(projectId, seq) || null;
    }

    // ---------- file state ----------

    /** 返回 undefined 表示插件从未见过该文件；null 表示已知不存在。 */
    getFileState(projectId, filePath) {
        const row = this.db.prepare('SELECT hash FROM file_state WHERE project_id = ? AND file_path = ?').get(projectId, filePath);
        return row ? row.hash : undefined;
    }

    setFileState(projectId, filePath, hash) {
        this.db.prepare(`INSERT INTO file_state(project_id, file_path, hash) VALUES (?, ?, ?)
            ON CONFLICT(project_id, file_path) DO UPDATE SET hash = excluded.hash`).run(projectId, filePath, hash);
    }

    // ---------- batches & nodes ----------

    /** reason：本次变动的原因（AI 必填），构成可查询的开发脉络。 */
    /** maid：操作者署名（中央注入字段）；外部修改批次为 null。 */
    createBatch(projectId, kind, reason = null, maid = null) {
        const id = Number(this.db.prepare('INSERT INTO batches(project_id, kind, reason, maid, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(projectId, kind, reason, maid, nowIso()).lastInsertRowid);
        this.touchProject(projectId);
        return id;
    }

    getBatch(projectId, batchId) {
        return this.db.prepare('SELECT * FROM batches WHERE project_id = ? AND id = ?').get(projectId, batchId) || null;
    }

    /** reason 为节点级原因（串内单步覆盖）；缺省继承批次 reason。 */
    addNode({ projectId, batchId = null, filePath, op, beforeHash, afterHash, todoId = null, reason = null, summary = null, added = 0, removed = 0 }) {
        const id = Number(this.db.prepare(`INSERT INTO nodes(project_id, batch_id, file_path, op, before_hash, after_hash, todo_id, reason, summary, added, removed, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(projectId, batchId, filePath, op, beforeHash ?? null, afterHash ?? null, todoId, reason, summary, added, removed, nowIso()).lastInsertRowid);
        this.setFileState(projectId, filePath, afterHash ?? null);
        return id;
    }

    getNode(projectId, nodeId) {
        return this.db.prepare('SELECT * FROM nodes WHERE project_id = ? AND id = ?').get(projectId, nodeId) || null;
    }

    getBatchNodes(projectId, batchId) {
        return this.db.prepare('SELECT * FROM nodes WHERE project_id = ? AND batch_id = ? ORDER BY id').all(projectId, batchId);
    }

    /** 某文件在指定节点之后（不含）的所有节点，用于回退预检。 */
    nodesAfter(projectId, nodeId, filePath = null) {
        if (filePath) {
            return this.db.prepare('SELECT * FROM nodes WHERE project_id = ? AND id > ? AND file_path = ? ORDER BY id').all(projectId, nodeId, filePath);
        }
        return this.db.prepare('SELECT * FROM nodes WHERE project_id = ? AND id > ? ORDER BY id').all(projectId, nodeId);
    }

    /** 某文件在 nodeId（含）时刻的状态 hash；该时刻前无记录返回 undefined。 */
    fileHashAt(projectId, filePath, nodeId) {
        const row = this.db.prepare('SELECT after_hash FROM nodes WHERE project_id = ? AND file_path = ? AND id <= ? ORDER BY id DESC LIMIT 1')
            .get(projectId, filePath, nodeId);
        if (row) return row.after_hash;
        // 该时刻前没有节点：取第一个节点的 before 作为“初始状态”
        const first = this.db.prepare('SELECT before_hash FROM nodes WHERE project_id = ? AND file_path = ? ORDER BY id LIMIT 1').get(projectId, filePath);
        return first ? first.before_hash : undefined;
    }

    /** 最近一个产生过节点的批次（含回退批次：回退一次回退 = 重做）。 */
    lastBatch(projectId) {
        return this.db.prepare(`SELECT b.* FROM batches b WHERE b.project_id = ?
            AND EXISTS (SELECT 1 FROM nodes n WHERE n.batch_id = b.id) ORDER BY b.id DESC LIMIT 1`).get(projectId) || null;
    }

    /**
     * 开发脉络：按批次倒序，每批附带 reason、类型、涉及文件与增删行数。
     * 只列出产生过节点的批次。
     */
    timeline(projectId, { limit = 20, beforeBatch = null } = {}) {
        const params = [projectId];
        let cond = '';
        if (beforeBatch) { cond = 'AND b.id < ?'; params.push(beforeBatch); }
        params.push(Math.min(Math.max(Number(limit) || 20, 1), 200));
        return this.db.prepare(`SELECT b.id, b.kind, b.reason, b.maid, b.created_at,
                GROUP_CONCAT(DISTINCT n.file_path) AS files,
                COUNT(n.id) AS node_count, COALESCE(SUM(n.added),0) AS added, COALESCE(SUM(n.removed),0) AS removed
            FROM batches b JOIN nodes n ON n.batch_id = b.id
            WHERE b.project_id = ? ${cond}
            GROUP BY b.id ORDER BY b.id DESC LIMIT ?`).all(...params);
    }

    /**
     * 历史搜索。filters: { projectId, filePattern(LIKE), since, until, todoId, op, keyword, limit }
     * keyword 匹配 summary 与文件路径；内容关键字由上层在 blob 中二次过滤。
     */
    searchNodes(filters = {}) {
        const where = ['p.deleted_at IS NULL'];
        const params = [];
        if (filters.projectId) { where.push('n.project_id = ?'); params.push(filters.projectId); }
        if (filters.filePattern) { where.push('n.file_path LIKE ?'); params.push(filters.filePattern); }
        if (filters.since) { where.push('n.created_at >= ?'); params.push(filters.since); }
        if (filters.until) { where.push('n.created_at <= ?'); params.push(filters.until); }
        if (filters.todoId) { where.push('n.todo_id = ?'); params.push(filters.todoId); }
        if (filters.op) { where.push('n.op = ?'); params.push(filters.op); }
        if (filters.batchId) { where.push('n.batch_id = ?'); params.push(filters.batchId); }
        if (filters.maid) { where.push('LOWER(b.maid) = LOWER(?)'); params.push(filters.maid); }
        if (filters.keyword) {
            // 关键字同时匹配节点原因、批次原因、摘要与文件路径
            where.push('(n.reason LIKE ? OR b.reason LIKE ? OR n.summary LIKE ? OR n.file_path LIKE ?)');
            const kw = `%${filters.keyword}%`;
            params.push(kw, kw, kw, kw);
        }
        const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 500);
        return this.db.prepare(`SELECT n.*, COALESCE(n.reason, b.reason) AS effective_reason, b.kind AS batch_kind, b.maid AS maid,
                p.name AS project_name
            FROM nodes n JOIN projects p ON p.id = n.project_id LEFT JOIN batches b ON b.id = n.batch_id
            WHERE ${where.join(' AND ')} ORDER BY n.id DESC LIMIT ${limit}`).all(...params);
    }

    projectStats(projectId) {
        const nodes = this.db.prepare('SELECT COUNT(*) AS c, COUNT(DISTINCT file_path) AS f, COALESCE(SUM(added),0) AS a, COALESCE(SUM(removed),0) AS r FROM nodes WHERE project_id = ?').get(projectId);
        const last = this.db.prepare('SELECT id, created_at FROM nodes WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(projectId);
        return { nodeCount: nodes.c, fileCount: nodes.f, added: nodes.a, removed: nodes.r, lastNodeId: last?.id ?? null, lastAt: last?.created_at ?? null };
    }

    /** 按 maid 汇总参与情况（只统计产生过节点的批次）。 */
    contributors(projectId) {
        return this.db.prepare(`SELECT b.maid AS maid, COUNT(DISTINCT b.id) AS batches,
                COALESCE(SUM(n.added),0) AS added, COALESCE(SUM(n.removed),0) AS removed, MAX(b.created_at) AS last_at
            FROM batches b JOIN nodes n ON n.batch_id = b.id
            WHERE b.project_id = ? GROUP BY b.maid ORDER BY batches DESC`).all(projectId);
    }

    changedFiles(projectId) {
        return this.db.prepare(`SELECT file_path, COUNT(*) AS edits, SUM(added) AS added, SUM(removed) AS removed, MAX(id) AS last_node
            FROM nodes WHERE project_id = ? GROUP BY file_path ORDER BY last_node DESC`).all(projectId);
    }
}

module.exports = { ProjectStore, sha256 };