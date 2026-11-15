'use strict';
// Async ProjectForge metadata/history adapter over the Rust storage service.
// No better-sqlite3, no local DB handle, and no JS transaction closure lives here.
const crypto = require('crypto');
const { ProjectServiceClient } = require('./serviceClient');

const READ_PAGE_SIZE = 500;

function newProjectId() {
    const value = crypto.randomBytes(3).readUIntBE(0, 3).toString(36).padStart(4, '0').slice(-4);
    return `p${value}`;
}

function toBuffer(content) {
    if (Buffer.isBuffer(content)) return content;
    if (content instanceof Uint8Array) return Buffer.from(content);
    return Buffer.from(String(content), 'utf8');
}

function encodeContent(content) {
    if (content === null || content === undefined) return null;
    const bytes = toBuffer(content);
    return {
        hash: crypto.createHash('sha256').update(bytes).digest('hex'),
        base64: bytes.toString('base64'),
    };
}

class RustProjectStore {
    constructor({ dbPath, configPath = null, binaryPath, client } = {}) {
        if (!dbPath) throw new Error('RustProjectStore 需要 dbPath。');
        this.dbPath = dbPath;
        this.configPath = configPath;
        this.binaryPath = binaryPath;
        this.ownsClient = !client;
        this.client = client || new ProjectServiceClient({ dbPath, configPath, binaryPath });
        this.closed = false;
    }

    _ensureOpen() {
        if (this.closed) throw new Error('RustProjectStore 已关闭。');
    }

    _request(method, params = {}) {
        this._ensureOpen();
        return this.client.request(method, params);
    }

    _mutate(method, params = {}) {
        this._ensureOpen();
        const { operationId, ...rest } = params;
        return this.client.request(method, {
            ...rest,
            operationId: operationId || crypto.randomUUID(),
        });
    }

    start() {
        this._ensureOpen();
        return typeof this.client.start === 'function' ? this.client.start() : Promise.resolve();
    }

    async close({ closeClient = this.ownsClient } = {}) {
        if (this.closed) return;
        this.closed = true;
        if (closeClient && typeof this.client.close === 'function') await this.client.close();
    }

    operationStatus(operationId) {
        return this._request('operation.status', { operationId });
    }

    info() {
        return this._request('store.info', {});
    }

    // ---------- projects ----------

    async createProject({
        name, workspaceId = null, workspaceAlias = null, root,
        subpath = '', createdBy = null, projectId = null, operationId, createRoot = false,
    } = {}) {
        return this._mutate('store.createProject', {
            createRoot,
            projectId: projectId || newProjectId(),
            name,
            workspaceId: workspaceId || null,
            workspaceAlias: workspaceAlias || null,
            root,
            subpath: subpath || '',
            createdBy,
            operationId,
        });
    }

    getProject(id, { includeDeleted = false } = {}) {
        return this._request('store.getProject', { projectId: id, includeDeleted });
    }

    async listProjects({ workspaceId = null, workspaceAlias = null, includeDeleted = false, query = null, limit = null, offset = 0 } = {}) {
        const base = { workspaceId, workspaceAlias, includeDeleted, query };
        const cursor = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
        if (limit !== null && limit !== undefined) {
            return this._request('store.listProjects', { ...base, limit, offset: cursor });
        }
        const all = [];
        let nextOffset = cursor;
        for (;;) {
            const page = await this._request('store.listProjects', {
                ...base, limit: READ_PAGE_SIZE, offset: nextOffset,
            });
            all.push(...page);
            if (page.length < READ_PAGE_SIZE) break;
            nextOffset += page.length;
        }
        return all;
    }

    listProjectSummaries({ workspaceId = null, workspaceAlias = null, includeDeleted = false, query = null, limit = 100, offset = 0 } = {}) {
        return this._request('store.listProjectSummaries', {
            workspaceId,
            workspaceAlias,
            includeDeleted,
            query,
            limit: limit === null || limit === undefined ? 100 : limit,
            offset: Number.isSafeInteger(offset) && offset > 0 ? offset : 0,
        });
    }

    async listAllProjectSummaries({ workspaceId = null, workspaceAlias = null, includeDeleted = false, query = null } = {}) {
        const all = [];
        let offset = 0;
        let total = 0;
        for (;;) {
            const page = await this.listProjectSummaries({
                workspaceId, workspaceAlias, includeDeleted, query,
                limit: READ_PAGE_SIZE, offset,
            });
            all.push(...page.items);
            total = page.total;
            if (!page.hasMore) break;
            offset += page.items.length;
        }
        return { items: all, total, offset: 0, limit: all.length, hasMore: false };
    }

    updateProject(id, patch = {}, { touch = true, operationId } = {}) {
        return this._mutate('store.updateProject', { projectId: id, patch, touch, operationId });
    }

    async touchProject(id, { operationId } = {}) {
        await this.updateProject(id, {}, { touch: true, operationId });
    }

    softDeleteProjects(ids, maid = null, { operationId } = {}) {
        return this._mutate('store.softDeleteProjects', { ids, maid, operationId });
    }

    restoreProjects(ids, { operationId } = {}) {
        return this._mutate('store.restoreProjects', { ids, operationId });
    }

    purgeProjects(ids, { operationId } = {}) {
        return this._mutate('store.purgeProjects', { ids, operationId });
    }

    // ---------- todos ----------

    listTodos(projectId) {
        return this._request('store.listTodos', { projectId });
    }

    addTodos(projectId, titles, maid = null, { operationId } = {}) {
        return this._mutate('store.addTodos', { projectId, titles, maid, operationId });
    }

    updateTodo(projectId, seq, patch = {}, { operationId } = {}) {
        const normalized = { ...patch };
        if (normalized.updatedBy === undefined && normalized.maid !== undefined) {
            normalized.updatedBy = normalized.maid;
        }
        delete normalized.maid;
        return this._mutate('store.updateTodo', { projectId, seq, patch: normalized, operationId });
    }

    removeTodo(projectId, seq, { operationId } = {}) {
        return this._mutate('store.removeTodo', { projectId, seq, operationId });
    }

    getTodoBySeq(projectId, seq) {
        return this._request('store.getTodoBySeq', { projectId, seq });
    }

    // ---------- file state / snapshots ----------

    async getFileState(projectId, filePath) {
        const row = await this._request('store.getFileState', { projectId, filePath });
        return row.known ? row.hash : undefined;
    }

    async getBlob(hash) {
        if (!hash) return null;
        const row = await this._request('store.getBlob', { hash });
        return Buffer.from(row.base64, 'base64');
    }

    diffBlobs({ beforeHash = null, afterHash = null, oldLabel = 'a', newLabel = 'b', context = 3, maxLines = 400, maxBytes } = {}) {
        const params = { beforeHash: beforeHash || null, afterHash: afterHash || null, oldLabel, newLabel, context, maxLines };
        if (maxBytes !== undefined) params.maxBytes = maxBytes;
        return this._request('store.diffBlobs', params);
    }

    // ---------- batches & nodes ----------

    getBatch(projectId, batchId) {
        return this._request('store.getBatch', { projectId, batchId });
    }

    getNode(projectId, nodeId) {
        return this._request('store.getNode', { projectId, nodeId });
    }

    getBatchNodes(projectId, batchId) {
        return this._request('store.getBatchNodes', { projectId, batchId });
    }

    nodesAfter(projectId, nodeId, filePath = null) {
        return this._request('store.nodesAfter', { projectId, nodeId, filePath });
    }

    async fileHashAt(projectId, filePath, nodeId) {
        const row = await this._request('store.fileHashAt', { projectId, filePath, nodeId });
        return row.known ? row.hash : undefined;
    }

    lastBatch(projectId) {
        return this._request('store.lastBatch', { projectId });
    }

    async exportSnapshot(projectId) {
        return this._request('store.exportSnapshot', { projectId });
    }

    async exportHistory(projectId) {
        const snapshot = await this.exportSnapshot(projectId);
        return snapshot.history;
    }

    timeline(projectId, { limit = 20, beforeBatch = null } = {}) {
        return this._request('store.timeline', { projectId, limit, beforeBatch });
    }

    searchNodes(filters = {}) {
        return this._request('store.searchNodes', {
            projectId: filters.projectId || null,
            filePattern: filters.filePattern || null,
            since: filters.since || null,
            until: filters.until || null,
            todoId: filters.todoId || null,
            op: filters.op || null,
            batchId: filters.batchId || null,
            maid: filters.maid || null,
            keyword: filters.keyword || null,
            limit: filters.limit === undefined || filters.limit === null ? 50 : filters.limit,
            offset: Number.isSafeInteger(filters.offset) && filters.offset > 0 ? filters.offset : 0,
        });
    }

    projectStats(projectId) {
        return this._request('store.projectStats', { projectId });
    }

    contributors(projectId) {
        return this._request('store.contributors', { projectId });
    }

    changedFiles(projectId) {
        return this._request('store.changedFiles', { projectId });
    }

    /**
     * Explicit old-history transaction command. Native file edits must not call this to
     * persist a JS plan; it exists for the legacy history writers that already have all
     * blobs/nodes ready and need one atomic Rust metadata transaction.
     *
     * blobs: Buffer | Uint8Array | string | { content } | { hash, base64 }
     * nodes: old addNode fields; beforeContent/afterContent are hashed and added to blobs.
     */
    async recordBatch({
        projectId, kind, reason = null, maid = null,
        blobs = [], nodes = [], operationId,
    } = {}) {
        if (!Array.isArray(blobs) || !Array.isArray(nodes)) {
            throw new Error('recordBatch 的 blobs/nodes 必须是数组。');
        }
        const encoded = new Map();
        const addEncoded = (blob, source) => {
            if (!blob) return null;
            const existing = encoded.get(blob.hash);
            if (existing && existing.base64 !== blob.base64) {
                throw new Error(`recordBatch blob hash 冲突：${source}`);
            }
            encoded.set(blob.hash, blob);
            return blob.hash;
        };

        for (const blob of blobs) {
            if (blob === null || blob === undefined) continue;
            if (Buffer.isBuffer(blob) || blob instanceof Uint8Array || typeof blob === 'string') {
                addEncoded(encodeContent(blob), 'content');
                continue;
            }
            if (typeof blob !== 'object' || Array.isArray(blob)) {
                throw new Error('recordBatch blob 必须是 Buffer、字符串或 {hash,base64}。');
            }
            if (Object.prototype.hasOwnProperty.call(blob, 'content')) {
                const next = encodeContent(blob.content);
                if (blob.hash && next && blob.hash !== next.hash) {
                    throw new Error('recordBatch blob content/hash 不一致。');
                }
                addEncoded(next, blob.hash || 'content');
                continue;
            }
            if (typeof blob.hash !== 'string' || typeof blob.base64 !== 'string') {
                throw new Error('recordBatch blob 需要 content 或 {hash,base64}。');
            }
            addEncoded({ hash: blob.hash, base64: blob.base64 }, blob.hash);
        }

        const normalizedNodes = nodes.map((node, index) => {
            if (!node || typeof node !== 'object' || Array.isArray(node)) {
                throw new Error(`recordBatch node[${index}] 必须是对象。`);
            }
            const next = { ...node };
            if (Object.prototype.hasOwnProperty.call(node, 'beforeContent')) {
                const before = encodeContent(node.beforeContent);
                addEncoded(before, 'beforeContent');
                next.beforeHash = before ? before.hash : null;
            } else if (!Object.prototype.hasOwnProperty.call(next, 'beforeHash')) {
                next.beforeHash = null;
            }
            if (Object.prototype.hasOwnProperty.call(node, 'afterContent')) {
                const after = encodeContent(node.afterContent);
                addEncoded(after, 'afterContent');
                next.afterHash = after ? after.hash : null;
            } else if (!Object.prototype.hasOwnProperty.call(next, 'afterHash')) {
                next.afterHash = null;
            }
            delete next.beforeContent;
            delete next.afterContent;
            return next;
        });

        return this._mutate('store.recordBatch', {
            projectId,
            kind,
            reason,
            maid,
            blobs: [...encoded.values()],
            nodes: normalizedNodes,
            operationId,
        });
    }
}

module.exports = { RustProjectStore };
