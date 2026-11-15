CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_id TEXT, workspace_alias TEXT,
    root TEXT NOT NULL, subpath TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
    report TEXT, created_by TEXT, deleted_by TEXT, report_by TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_ws ON projects(workspace_alias);
CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    note TEXT, updated_by TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id, seq);
CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, reason TEXT, maid TEXT, summary TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batches_project ON batches(project_id, id);
CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    batch_id INTEGER REFERENCES batches(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL, op TEXT NOT NULL, before_hash TEXT, after_hash TEXT,
    todo_id INTEGER, reason TEXT, summary TEXT,
    added INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id, id);
CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(project_id, file_path, id);
CREATE INDEX IF NOT EXISTS idx_nodes_batch ON nodes(batch_id);
CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS file_state (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL, hash TEXT, PRIMARY KEY (project_id, file_path)
);