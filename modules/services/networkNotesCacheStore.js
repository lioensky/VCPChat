const path = require('path');
const fs = require('fs-extra');

class NetworkNotesCacheStore {
    constructor({ dbPath, legacyJsonPath, logger = console }) {
        this.dbPath = dbPath;
        this.legacyJsonPath = legacyJsonPath;
        this.logger = logger;
        this.db = null;
        this.Database = null;
    }

    initialize() {
        if (this.db) return true;

        try {
            this.Database = require('better-sqlite3');
        } catch (error) {
            this.logger.warn('[NetworkNotesCacheStore] better-sqlite3 is not available, falling back to legacy JSON cache:', error.message);
            return false;
        }

        fs.ensureDirSync(path.dirname(this.dbPath));
        this.db = new this.Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('busy_timeout = 5000');
        this.db.pragma('foreign_keys = ON');

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS network_note_roots (
                root_path TEXT PRIMARY KEY,
                root_id TEXT NOT NULL,
                name TEXT NOT NULL,
                tree_name TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS network_note_nodes (
                id TEXT PRIMARY KEY,
                root_path TEXT NOT NULL,
                parent_id TEXT NOT NULL,
                type TEXT NOT NULL CHECK(type IN ('folder', 'note')),
                name TEXT,
                title TEXT,
                username TEXT,
                timestamp INTEGER,
                content TEXT,
                file_name TEXT,
                path TEXT NOT NULL,
                sort_order INTEGER NOT NULL,
                mtime_ms INTEGER,
                size INTEGER,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(root_path) REFERENCES network_note_roots(root_path) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_network_note_nodes_root_parent_order
                ON network_note_nodes(root_path, parent_id, sort_order);

            CREATE INDEX IF NOT EXISTS idx_network_note_nodes_root_path
                ON network_note_nodes(root_path, path);
        `);

        return true;
    }

    isAvailable() {
        return Boolean(this.db);
    }

    readAllTrees() {
        if (!this.initialize()) {
            return this.readLegacyJsonCache();
        }

        const roots = this.db.prepare(`
            SELECT root_path, root_id, name, tree_name
            FROM network_note_roots
            ORDER BY tree_name COLLATE NOCASE, root_path COLLATE NOCASE
        `).all();

        if (roots.length === 0) return [];

        const getNodes = this.db.prepare(`
            SELECT id, parent_id, type, name, title, username, timestamp, content, file_name, path, sort_order, mtime_ms, size
            FROM network_note_nodes
            WHERE root_path = ?
            ORDER BY parent_id, sort_order
        `);

        return roots.map(root => {
            const rootNode = {
                id: root.root_id,
                type: 'folder',
                name: root.name,
                path: root.root_path,
                children: [],
                isNetwork: true,
                isRoot: true
            };

            const nodeMap = new Map([[rootNode.id, rootNode]]);
            const pendingChildren = new Map();

            for (const row of getNodes.all(root.root_path)) {
                const node = row.type === 'folder'
                    ? {
                        id: row.id,
                        type: 'folder',
                        name: row.name,
                        path: row.path,
                        children: []
                    }
                    : {
                        id: row.id,
                        type: 'note',
                        title: row.title,
                        username: row.username,
                        timestamp: row.timestamp,
                        content: row.content || '',
                        fileName: row.file_name,
                        path: row.path,
                        mtimeMs: row.mtime_ms,
                        size: row.size
                    };

                nodeMap.set(node.id, node);

                const waiting = pendingChildren.get(node.id);
                if (waiting && node.type === 'folder') {
                    node.children.push(...waiting);
                    pendingChildren.delete(node.id);
                }

                const parent = nodeMap.get(row.parent_id);
                if (parent && Array.isArray(parent.children)) {
                    parent.children.push(node);
                } else {
                    if (!pendingChildren.has(row.parent_id)) {
                        pendingChildren.set(row.parent_id, []);
                    }
                    pendingChildren.get(row.parent_id).push(node);
                }
            }

            return rootNode;
        });
    }

    getNodeSnapshotByPath(rootPath) {
        const snapshot = new Map();

        if (!this.initialize()) {
            return snapshot;
        }

        const rows = this.db.prepare(`
            SELECT id, type, name, title, username, timestamp, content, file_name, path, mtime_ms, size
            FROM network_note_nodes
            WHERE root_path = ?
        `).all(rootPath);

        for (const row of rows) {
            snapshot.set(row.path, row.type === 'folder'
                ? {
                    id: row.id,
                    type: 'folder',
                    name: row.name,
                    path: row.path
                }
                : {
                    id: row.id,
                    type: 'note',
                    title: row.title,
                    username: row.username,
                    timestamp: row.timestamp,
                    content: row.content || '',
                    fileName: row.file_name,
                    path: row.path,
                    mtimeMs: row.mtime_ms,
                    size: row.size
                });
        }

        return snapshot;
    }

    writeAllTrees(trees) {
        if (!Array.isArray(trees)) trees = [];

        if (!this.initialize()) {
            return this.writeLegacyJsonCache(trees);
        }

        const now = Date.now();
        const rootPaths = trees.map(tree => tree.path).filter(Boolean);

        const deleteMissingRoots = this.db.prepare(`
            DELETE FROM network_note_roots
            WHERE root_path NOT IN (${rootPaths.length > 0 ? rootPaths.map(() => '?').join(',') : "''"})
        `);

        const upsertRoot = this.db.prepare(`
            INSERT INTO network_note_roots (root_path, root_id, name, tree_name, updated_at)
            VALUES (@root_path, @root_id, @name, @tree_name, @updated_at)
            ON CONFLICT(root_path) DO UPDATE SET
                root_id = excluded.root_id,
                name = excluded.name,
                tree_name = excluded.tree_name,
                updated_at = excluded.updated_at
            WHERE network_note_roots.root_id != excluded.root_id
                OR network_note_roots.name != excluded.name
                OR network_note_roots.tree_name != excluded.tree_name
        `);

        const deleteStaleNodes = this.db.prepare(`
            DELETE FROM network_note_nodes
            WHERE root_path = ? AND id NOT IN (SELECT value FROM json_each(?))
        `);

        const upsertNode = this.db.prepare(`
            INSERT INTO network_note_nodes (
                id, root_path, parent_id, type, name, title, username, timestamp, content,
                file_name, path, sort_order, mtime_ms, size, updated_at
            )
            VALUES (
                @id, @root_path, @parent_id, @type, @name, @title, @username, @timestamp, @content,
                @file_name, @path, @sort_order, @mtime_ms, @size, @updated_at
            )
            ON CONFLICT(id) DO UPDATE SET
                root_path = excluded.root_path,
                parent_id = excluded.parent_id,
                type = excluded.type,
                name = excluded.name,
                title = excluded.title,
                username = excluded.username,
                timestamp = excluded.timestamp,
                content = excluded.content,
                file_name = excluded.file_name,
                path = excluded.path,
                sort_order = excluded.sort_order,
                mtime_ms = excluded.mtime_ms,
                size = excluded.size,
                updated_at = excluded.updated_at
            WHERE network_note_nodes.root_path IS NOT excluded.root_path
                OR network_note_nodes.parent_id IS NOT excluded.parent_id
                OR network_note_nodes.type IS NOT excluded.type
                OR network_note_nodes.name IS NOT excluded.name
                OR network_note_nodes.title IS NOT excluded.title
                OR network_note_nodes.username IS NOT excluded.username
                OR network_note_nodes.timestamp IS NOT excluded.timestamp
                OR network_note_nodes.content IS NOT excluded.content
                OR network_note_nodes.file_name IS NOT excluded.file_name
                OR network_note_nodes.path IS NOT excluded.path
                OR network_note_nodes.sort_order IS NOT excluded.sort_order
                OR network_note_nodes.mtime_ms IS NOT excluded.mtime_ms
                OR network_note_nodes.size IS NOT excluded.size
        `);

        const flattenTree = (rootPath, parentId, children, rows) => {
            (children || []).forEach((item, index) => {
                rows.push({
                    id: item.id,
                    root_path: rootPath,
                    parent_id: parentId,
                    type: item.type,
                    name: item.name || null,
                    title: item.title || null,
                    username: item.username || null,
                    timestamp: Number.isFinite(Number(item.timestamp)) ? Number(item.timestamp) : null,
                    content: item.content || '',
                    file_name: item.fileName || null,
                    path: item.path,
                    sort_order: index,
                    mtime_ms: Number.isFinite(Number(item.mtimeMs)) ? Number(item.mtimeMs) : null,
                    size: Number.isFinite(Number(item.size)) ? Number(item.size) : null,
                    updated_at: now
                });

                if (item.type === 'folder') {
                    flattenTree(rootPath, item.id, item.children || [], rows);
                }
            });
        };

        const tx = this.db.transaction(() => {
            deleteMissingRoots.run(...rootPaths);

            for (const tree of trees) {
                if (!tree || !tree.path || !tree.id) continue;

                upsertRoot.run({
                    root_path: tree.path,
                    root_id: tree.id,
                    name: tree.name,
                    tree_name: tree.name,
                    updated_at: now
                });

                const rows = [];
                flattenTree(tree.path, tree.id, tree.children || [], rows);
                const ids = rows.map(row => row.id);
                deleteStaleNodes.run(tree.path, JSON.stringify(ids));

                for (const row of rows) {
                    upsertNode.run(row);
                }
            }
        });

        tx();

        if (this.legacyJsonPath) {
            fs.remove(this.legacyJsonPath).catch(error => {
                this.logger.warn('[NetworkNotesCacheStore] Failed to remove legacy JSON cache:', error.message);
            });
        }

        return trees;
    }

    clear() {
        if (!this.initialize()) {
            if (this.legacyJsonPath) fs.removeSync(this.legacyJsonPath);
            return;
        }

        this.db.exec(`
            DELETE FROM network_note_nodes;
            DELETE FROM network_note_roots;
        `);

        if (this.legacyJsonPath) fs.removeSync(this.legacyJsonPath);
    }

    readLegacyJsonCache() {
        if (!this.legacyJsonPath || !fs.pathExistsSync(this.legacyJsonPath)) return [];
        try {
            const cached = fs.readJsonSync(this.legacyJsonPath);
            return Array.isArray(cached) ? cached : (cached ? [cached] : []);
        } catch (error) {
            this.logger.warn('[NetworkNotesCacheStore] Failed to read legacy JSON cache:', error.message);
            return [];
        }
    }

    writeLegacyJsonCache(trees) {
        if (!this.legacyJsonPath) return trees;
        if (Array.isArray(trees) && trees.length > 0) {
            fs.writeJsonSync(this.legacyJsonPath, trees);
        } else {
            fs.removeSync(this.legacyJsonPath);
        }
        return trees;
    }
}

module.exports = NetworkNotesCacheStore;