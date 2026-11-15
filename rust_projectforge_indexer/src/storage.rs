//! ProjectForge storage kernel. No raw SQL RPC, no filesystem-edit claims.
//! Only an explicitly handed-over DB may be opened; the Rust lock does NOT fence legacy JS.
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use fs2::FileExt;
use rusqlite::{params, types::ValueRef, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub(crate) type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
const MAX_BLOB_BYTES: usize = 32 * 1024 * 1024;
const MAX_BATCH_NODES: usize = 200;
const SCHEMA: &str = include_str!("storage_schema.sql");

pub struct Store {
    pub(crate) db: Connection,
    _ownership: File,
}

fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

fn required<'a>(p: &'a Value, key: &str) -> Result<&'a str> {
    p.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
        .ok_or_else(|| format!("missing nonempty string: {key}").into())
}
fn nullable(p: &Value, key: &str) -> Result<Option<String>> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        _ => Err(format!("invalid string/null: {key}").into()),
    }
}
fn limit(p: &Value, fallback: u64, max: u64) -> Result<i64> {
    let n = match p.get("limit") {
        None => fallback,
        Some(v) => v.as_u64().ok_or("limit must be a positive integer")?,
    };
    if n == 0 || n > max { return Err(format!("limit must be 1..={max}").into()); }
    Ok(n as i64)
}
fn rows(db: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Vec<Value>> {
    let mut statement = db.prepare(sql)?;
    let names: Vec<String> = statement.column_names().iter().map(|s| (*s).into()).collect();
    let mapped = statement.query_map(args, |row| {
        let mut object = Map::new();
        for (i, name) in names.iter().enumerate() {
            let value = match row.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(n) => json!(n),
                ValueRef::Text(s) => Value::String(String::from_utf8_lossy(s).into_owned()),
                // BLOBs never belong in metadata responses.
                ValueRef::Blob(_) => return Err(rusqlite::Error::InvalidColumnType(i, name.clone(), rusqlite::types::Type::Blob)),
            };
            object.insert(name.clone(), value);
        }
        Ok(Value::Object(object))
    })?;
    Ok(mapped.collect::<std::result::Result<Vec<_>, _>>()?)
}
fn first(db: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Value> {
    Ok(rows(db, sql, args)?.into_iter().next().unwrap_or(Value::Null))
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if !path.is_absolute() { return Err("database path must be absolute".into()); }
        if let Some(parent) = path.parent() { fs::create_dir_all(parent)?; }
        // Canonical parent avoids relative aliases; inode aliases/symlinks remain a deployment concern.
        let path = path.parent().ok_or("missing database parent")?.canonicalize()?
            .join(path.file_name().ok_or("missing database name")?);
        let ownership = OpenOptions::new().read(true).write(true).create(true).truncate(false)
            .open(path.with_extension("service.lock"))?;
        ownership.try_lock_exclusive().map_err(|e| format!("database service already owned: {e}"))?;
        let mut db = Connection::open(&path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        let has_meta: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta')", [], |r| r.get(0))?;
        if has_meta {
            let version: Option<String> = db.query_row("SELECT value FROM meta WHERE key='schema_version'", [], |r| r.get(0)).optional()?;
            if let Some(version) = version {
                if !matches!(version.as_str(), "1" | "2") { return Err(format!("unsupported schema version: {version}").into()); }
            }
            let version: Option<String> = db.query_row("SELECT value FROM meta WHERE key='service_schema_version'", [], |r| r.get(0)).optional()?;
            if version.as_deref().is_some_and(|v| !matches!(v, "1" | "2" | "3")) {
                return Err("unsupported service schema version".into());
            }
        }
        db.pragma_update(None, "foreign_keys", "ON")?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        // Service operations must survive a power loss as far as SQLite/filesystem permits.
        db.pragma_update(None, "synchronous", "FULL")?;
        let tx = db.transaction()?;
        tx.execute_batch(SCHEMA)?;
        for (table, column, definition) in [
            ("projects", "subpath", "TEXT NOT NULL DEFAULT ''"),
            ("projects", "created_by", "TEXT"), ("projects", "deleted_by", "TEXT"),
            ("projects", "report_by", "TEXT"), ("todos", "updated_by", "TEXT"),
            ("batches", "reason", "TEXT"), ("batches", "maid", "TEXT"), ("nodes", "reason", "TEXT"),
        ] {
            let columns = rows(&tx, &format!("PRAGMA table_info({table})"), &[])?;
            if !columns.iter().any(|c| c["name"].as_str() == Some(column)) {
                tx.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"))?;
            }
        }
        tx.execute_batch("CREATE INDEX IF NOT EXISTS idx_batches_maid ON batches(maid);
            CREATE TABLE IF NOT EXISTS service_operations (
                id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
            );")?;
        tx.execute_batch(crate::commit_journal::SCHEMA)?;
        let columns = rows(&tx, "PRAGMA table_info(file_commit_intents)", &[])?;
        if !columns.iter().any(|c| c["name"].as_str() == Some("validation_receipt")) {
            tx.execute_batch("ALTER TABLE file_commit_intents ADD COLUMN validation_receipt TEXT")?;
        }
        if !columns.iter().any(|c| c["name"].as_str() == Some("commit_context")) {
            tx.execute_batch("ALTER TABLE file_commit_intents ADD COLUMN commit_context TEXT")?;
        }
        tx.execute("INSERT OR REPLACE INTO meta(key,value) VALUES ('schema_version','2')", [])?;
        tx.execute("INSERT OR REPLACE INTO meta(key,value) VALUES ('service_schema_version','3')", [])?;
        tx.commit()?;
        Ok(Self { db, _ownership: ownership })
    }

    pub fn query(&self, method: &str, p: &Value) -> Result<Value> {
        match method {
            "store.info" => Ok(json!({"schemaVersion":2,"serviceSchemaVersion":3,"maxBlobBytes":MAX_BLOB_BYTES})),
            "store.getProject" => {
                let id = required(p, "projectId")?;
                let deleted = p.get("includeDeleted").and_then(Value::as_bool).unwrap_or(false);
                first(&self.db, "SELECT * FROM projects WHERE id=? AND (? OR deleted_at IS NULL)", &[&id, &deleted])
            }
            "store.listProjects" => {
                let n = limit(p, 100, 500)?;
                let deleted = p.get("includeDeleted").and_then(Value::as_bool).unwrap_or(false);
                let ws = nullable(p, "workspaceAlias")?;
                let ws_id = nullable(p, "workspaceId")?;
                let query = nullable(p, "query")?;
                let like = query.as_ref().map(|s| format!("%{s}%"));
                Ok(json!(rows(&self.db, "SELECT * FROM projects WHERE (? OR deleted_at IS NULL)
                    AND ((? IS NOT NULL AND (workspace_id=? OR (workspace_id IS NULL AND workspace_alias=?)))
                      OR (? IS NULL AND (? IS NULL OR workspace_alias=?)))
                    AND (? IS NULL OR name LIKE ? OR id=?) ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT ?",
                    &[&deleted,&ws_id,&ws_id,&ws,&ws_id,&ws,&ws,&query,&like,&query,&n])?))
            }
            "store.listTodos" => Ok(json!(rows(&self.db, "SELECT * FROM todos WHERE project_id=? ORDER BY seq,id", &[&required(p,"projectId")?])?)),
            "store.getFileState" => {
                let row = first(&self.db, "SELECT hash FROM file_state WHERE project_id=? AND file_path=?",
                    &[&required(p,"projectId")?, &required(p,"filePath")?])?;
                Ok(if row.is_null() { json!({"known":false}) } else { json!({"known":true,"hash":row["hash"]}) })
            }
            "store.getNode" => first(&self.db, "SELECT * FROM nodes WHERE project_id=? AND id=?",
                &[&required(p,"projectId")?, &p.get("nodeId").and_then(Value::as_i64).ok_or("nodeId required")?]),
            "store.getBatch" => first(&self.db, "SELECT * FROM batches WHERE project_id=? AND id=?",
                &[&required(p,"projectId")?, &p.get("batchId").and_then(Value::as_i64).ok_or("batchId required")?]),
            "store.getBatchNodes" => Ok(json!(rows(&self.db, "SELECT * FROM nodes WHERE project_id=? AND batch_id=? ORDER BY id",
                &[&required(p,"projectId")?, &p.get("batchId").and_then(Value::as_i64).ok_or("batchId required")?])?)),
            "store.timeline" => {
                let n = limit(p, 20, 200)?;
                let cursor = match p.get("beforeBatch") {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(v.as_i64().filter(|v| *v > 0).ok_or("invalid beforeBatch")?),
                };
                Ok(json!(rows(&self.db, "SELECT b.id,b.kind,b.reason,b.maid,b.created_at,
                    GROUP_CONCAT(DISTINCT n.file_path) AS files,COUNT(n.id) AS node_count,
                    COALESCE(SUM(n.added),0) AS added,COALESCE(SUM(n.removed),0) AS removed
                    FROM batches b JOIN nodes n ON n.batch_id=b.id
                    WHERE b.project_id=? AND (? IS NULL OR b.id<?)
                    GROUP BY b.id ORDER BY b.id DESC LIMIT ?", &[&required(p,"projectId")?,&cursor,&cursor,&n])?))
            }
            "store.projectStats" => {
                let id = required(p,"projectId")?;
                let mut stats = first(&self.db,"SELECT COUNT(*) AS nodeCount,COUNT(DISTINCT file_path) AS fileCount,
                    COALESCE(SUM(added),0) AS added,COALESCE(SUM(removed),0) AS removed FROM nodes WHERE project_id=?", &[&id])?;
                let last=first(&self.db,"SELECT id,created_at FROM nodes WHERE project_id=? ORDER BY id DESC LIMIT 1",&[&id])?;
                stats["lastNodeId"]=last["id"].clone(); stats["lastAt"]=last["created_at"].clone();
                Ok(stats)
            }
            "store.contributors" => Ok(json!(rows(&self.db,"SELECT b.maid AS maid,COUNT(DISTINCT b.id) AS batches,
                COALESCE(SUM(n.added),0) AS added,COALESCE(SUM(n.removed),0) AS removed,MAX(b.created_at) AS last_at
                FROM batches b JOIN nodes n ON n.batch_id=b.id WHERE b.project_id=?
                GROUP BY b.maid ORDER BY batches DESC",&[&required(p,"projectId")?])?)),
            "store.changedFiles" => Ok(json!(rows(&self.db,"SELECT file_path,COUNT(*) AS edits,SUM(added) AS added,
                SUM(removed) AS removed,MAX(id) AS last_node FROM nodes WHERE project_id=? GROUP BY file_path ORDER BY last_node DESC",
                &[&required(p,"projectId")?])?)),
            "store.lastBatch" => first(&self.db,"SELECT b.* FROM batches b WHERE b.project_id=?
                AND EXISTS(SELECT 1 FROM nodes n WHERE n.batch_id=b.id) ORDER BY b.id DESC LIMIT 1",&[&required(p,"projectId")?]),
            "store.nodesAfter" => {
                let file=nullable(p,"filePath")?;
                Ok(json!(rows(&self.db,"SELECT * FROM nodes WHERE project_id=? AND id>? AND (? IS NULL OR file_path=?) ORDER BY id",
                    &[&required(p,"projectId")?,&p.get("nodeId").and_then(Value::as_i64).ok_or("nodeId required")?,&file,&file])?))
            }
            "store.fileHashAt" => {
                let id=required(p,"projectId")?;
                let file=required(p,"filePath")?;
                let node=p.get("nodeId").and_then(Value::as_i64).ok_or("nodeId required")?;
                let mut row=first(&self.db,"SELECT after_hash AS hash FROM nodes WHERE project_id=? AND file_path=? AND id<=? ORDER BY id DESC LIMIT 1",
                    &[&id,&file,&node])?;
                if row.is_null() {
                    row=first(&self.db,"SELECT before_hash AS hash FROM nodes WHERE project_id=? AND file_path=? ORDER BY id LIMIT 1",&[&id,&file])?;
                }
                Ok(if row.is_null() {json!({"known":false})} else {json!({"known":true,"hash":row["hash"]})})
            }
            "store.getTodoBySeq" => first(&self.db,"SELECT * FROM todos WHERE project_id=? AND seq=?",
                &[&required(p,"projectId")?,&p.get("seq").and_then(Value::as_i64).ok_or("seq required")?]),
            "store.searchNodes" => {
                let n=limit(p,50,500)?;
                let project=nullable(p,"projectId")?;
                let file=nullable(p,"filePattern")?;
                let since=nullable(p,"since")?;
                let until=nullable(p,"until")?;
                let op=nullable(p,"op")?;
                let maid=nullable(p,"maid")?;
                let keyword=nullable(p,"keyword")?;
                let kw=keyword.as_ref().map(|s|format!("%{s}%"));
                let optional_id=|key:&str|->Result<Option<i64>> {
                    match p.get(key) {
                        None|Some(Value::Null)=>Ok(None),
                        Some(v)=>Ok(Some(v.as_i64().filter(|v|*v>0).ok_or("invalid history id")?)),
                    }
                };
                let batch=optional_id("batchId")?;
                let todo=optional_id("todoId")?;
                Ok(json!(rows(&self.db,"SELECT n.*,COALESCE(n.reason,b.reason) AS effective_reason,b.kind AS batch_kind,
                    b.maid AS maid,p.name AS project_name FROM nodes n JOIN projects p ON p.id=n.project_id
                    LEFT JOIN batches b ON b.id=n.batch_id WHERE p.deleted_at IS NULL
                    AND (? IS NULL OR n.project_id=?) AND (? IS NULL OR n.file_path LIKE ?)
                    AND (? IS NULL OR n.created_at>=?) AND (? IS NULL OR n.created_at<=?)
                    AND (? IS NULL OR n.op=?) AND (? IS NULL OR LOWER(b.maid)=LOWER(?))
                    AND (? IS NULL OR n.batch_id=?) AND (? IS NULL OR n.todo_id=?)
                    AND (? IS NULL OR n.reason LIKE ? OR b.reason LIKE ? OR n.summary LIKE ? OR n.file_path LIKE ?)
                    ORDER BY n.id DESC LIMIT ?",
                    &[&project,&project,&file,&file,&since,&since,&until,&until,&op,&op,&maid,&maid,
                    &batch,&batch,&todo,&todo,&keyword,&kw,&kw,&kw,&kw,&n])?))
            }
            "store.exportSnapshot" => {
                // One SQLite read snapshot, not a sequence of potentially interleaved RPC reads.
                let tx=self.db.unchecked_transaction()?;
                let id=required(p,"projectId")?;
                let project=first(&tx,"SELECT * FROM projects WHERE id=?",&[&id])?;
                if project.is_null() {return Err("project missing".into());}
                let todos=rows(&tx,"SELECT * FROM todos WHERE project_id=? ORDER BY seq,id",&[&id])?;
                let mut batches=rows(&tx,"SELECT * FROM batches WHERE project_id=? ORDER BY created_at,id",&[&id])?;
                let nodes=rows(&tx,"SELECT * FROM nodes WHERE project_id=? ORDER BY created_at,id",&[&id])?;
                let mut by_batch=std::collections::HashMap::<i64,Vec<Value>>::new();
                for node in nodes {
                    if let Some(batch)=node["batch_id"].as_i64() {by_batch.entry(batch).or_default().push(node);}
                }
                for batch in &mut batches {
                    batch["nodes"]=json!(by_batch.remove(&batch["id"].as_i64().ok_or("invalid batch id")?).unwrap_or_default());
                }
                tx.commit()?;
                Ok(json!({"project":project,"todos":todos,"history":batches}))
            }
            "store.getBlob" => {
                let Some(h) = nullable(p,"hash")? else { return Ok(Value::Null); };
                let bytes = Self::blob(&self.db, &h)?;
                Ok(json!({"hash":h,"size":bytes.len(),"base64":STANDARD.encode(bytes)}))
            }
            "operation.status" => {
                let row = first(&self.db,"SELECT request_hash,result,created_at FROM service_operations WHERE id=?", &[&required(p,"operationId")?])?;
                if row.is_null() {
                    return Ok(self.intent_status(required(p,"operationId")?)?.unwrap_or_else(||json!({"state":"unknown"})));
                }
                Ok(json!({"state":"committed","requestHash":row["request_hash"],"createdAt":row["created_at"],
                    "result":serde_json::from_str::<Value>(row["result"].as_str().ok_or("invalid operation result")?)?}))
            }
            _ => Err(format!("unknown storage method: {method}").into()),
        }
    }

    pub(crate) fn blob(db: &Connection, h: &str) -> Result<Vec<u8>> {
        let (size, compressed): (i64, Vec<u8>) = db.query_row(
            "SELECT size,data FROM blobs WHERE hash=?", [h], |r| Ok((r.get(0)?,r.get(1)?)))?;
        if size < 0 || size as u64 > MAX_BLOB_BYTES as u64 { return Err("snapshot exceeds decompression budget".into()); }
        let mut bytes = Vec::new();
        GzDecoder::new(&compressed[..]).take(size as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() != size as usize || hash(&bytes) != h { return Err("snapshot size/hash integrity failure".into()); }
        Ok(bytes)
    }

    /// Explicit business transaction, not an open transaction spanning RPC calls.
    /// This records DB history only; durable multi-file commit is a later layer.
    pub fn mutate(&mut self, method: &str, p: &Value) -> Result<Value> {
        if !matches!(method,"store.createProject"|"store.recordBatch") { return Err("unknown mutation".into()); }
        let operation = required(p, "operationId")?;
        if operation.len() > 128 { return Err("operationId too long".into()); }
        let digest = hash(&serde_json::to_vec(&json!({"method":method,"params":p}))?);
        let tx = self.db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let old: Option<(String,String)> = tx.query_row("SELECT request_hash,result FROM service_operations WHERE id=?", [operation],
            |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((old_hash,result)) = old {
            if old_hash != digest { return Err("operationId reused with different request".into()); }
            return Ok(serde_json::from_str(&result)?);
        }
        let reserved: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM file_commit_intents WHERE operation_id=?)",
            [operation],|r|r.get(0))?;
        if reserved {return Err("operationId belongs to a file commit; query status".into());}
        let ts: String = tx.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')",[],|r| r.get(0))?;
        let result = match method {
            "store.createProject" => {
                let id = required(p,"projectId")?;
                if id.len()>64 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c==b'_' || c==b'-') {
                    return Err("invalid projectId".into());
                }
                tx.execute("INSERT INTO projects(id,name,workspace_id,workspace_alias,root,subpath,created_by,created_at,updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?)", params![id,required(p,"name")?,nullable(p,"workspaceId")?,
                    nullable(p,"workspaceAlias")?,required(p,"root")?,p.get("subpath").and_then(Value::as_str).unwrap_or(""),
                    nullable(p,"createdBy")?,ts,ts])?;
                first(&tx,"SELECT * FROM projects WHERE id=?", &[&id])?
            }
            "store.recordBatch" => {
                let project = required(p,"projectId")?;
                let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL)", [project], |r|r.get(0))?;
                if !exists { return Err("project missing or deleted".into()); }
                let nodes = p.get("nodes").and_then(Value::as_array).ok_or("nodes array required")?;
                if nodes.is_empty() || nodes.len()>MAX_BATCH_NODES { return Err("nodes count must be 1..=200".into()); }
                let mut total_bytes = 0usize;
                if let Some(blobs) = p.get("blobs") {
                    let blobs = blobs.as_array().ok_or("blobs must be an array")?;
                    if blobs.len() > MAX_BATCH_NODES * 2 { return Err("too many blobs".into()); }
                    for blob in blobs {
                        let encoded = blob.get("base64").and_then(Value::as_str).ok_or("base64 string required")?;
                        if encoded.len() > MAX_BLOB_BYTES.div_ceil(3) * 4 { return Err("snapshot too large".into()); }
                        let bytes = STANDARD.decode(encoded)?;
                        total_bytes = total_bytes.checked_add(bytes.len()).ok_or("blob budget overflow")?;
                        if total_bytes > MAX_BLOB_BYTES { return Err("batch snapshot budget exceeded".into()); }
                        let h = hash(&bytes);
                        if h != required(blob,"hash")? { return Err("supplied snapshot hash mismatch".into()); }
                        let mut gzip = GzEncoder::new(Vec::new(),Compression::default());
                        gzip.write_all(&bytes)?;
                        tx.execute("INSERT OR IGNORE INTO blobs(hash,size,data) VALUES (?,?,?)",params![h,bytes.len() as i64,gzip.finish()?])?;
                    }
                }
                tx.execute("INSERT INTO batches(project_id,kind,reason,maid,created_at) VALUES (?,?,?,?,?)",
                    params![project,required(p,"kind")?,nullable(p,"reason")?,nullable(p,"maid")?,ts])?;
                let batch = tx.last_insert_rowid();
                let mut ids = Vec::new();
                for node in nodes {
                    let before = nullable(node,"beforeHash")?;
                    let after = nullable(node,"afterHash")?;
                    for h in [&before,&after].into_iter().flatten() {
                        let present: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM blobs WHERE hash=?)",[h],|r|r.get(0))?;
                        if !present { return Err(format!("snapshot missing: {h}").into()); }
                    }
                    let file = required(node,"filePath")?;
                    let todo = match node.get("todoId") {
                        None | Some(Value::Null) => None,
                        Some(v) => Some(v.as_i64().filter(|v| *v>0).ok_or("invalid todoId")?),
                    };
                    if let Some(todo) = todo {
                        let owns: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM todos WHERE id=? AND project_id=?)",
                            params![todo,project],|r|r.get(0))?;
                        if !owns { return Err("todo does not belong to project".into()); }
                    }
                    let count = |key: &str| -> Result<i64> {
                        match node.get(key) {
                            None => Ok(0),
                            Some(v) => v.as_i64().filter(|v| *v>=0).ok_or_else(|| format!("invalid {key}").into()),
                        }
                    };
                    tx.execute("INSERT INTO nodes(project_id,batch_id,file_path,op,before_hash,after_hash,todo_id,reason,summary,added,removed,created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",params![project,batch,file,required(node,"op")?,before,after,todo,
                        nullable(node,"reason")?,nullable(node,"summary")?,count("added")?,count("removed")?,ts])?;
                    ids.push(tx.last_insert_rowid());
                    tx.execute("INSERT INTO file_state(project_id,file_path,hash) VALUES (?,?,?)
                        ON CONFLICT(project_id,file_path) DO UPDATE SET hash=excluded.hash",params![project,file,after])?;
                }
                tx.execute("UPDATE projects SET updated_at=? WHERE id=?",params![ts,project])?;
                json!({"batchId":batch,"nodeIds":ids})
            }
            _ => unreachable!(),
        };
        tx.execute("INSERT INTO service_operations(id,request_hash,result,created_at) VALUES (?,?,?,?)",
            params![operation,digest,serde_json::to_string(&result)?,ts])?;
        tx.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn open() -> (tempfile::TempDir,Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("pf.db")).unwrap();
        (dir,store)
    }
    fn project(store: &mut Store) {
        store.mutate("store.createProject",&json!({"operationId":"create","projectId":"ptest","name":"fixture","root":"test-root"})).unwrap();
    }
    #[test]
    fn ownership_and_unknown_schema_are_rejected() {
        let (dir,store)=open();
        assert!(Store::open(&dir.path().join("pf.db")).is_err());
        drop(store);
        let db=Connection::open(dir.path().join("pf.db")).unwrap();
        db.execute("UPDATE meta SET value='999' WHERE key='schema_version'",[]).unwrap();
        drop(db);
        assert!(Store::open(&dir.path().join("pf.db")).is_err());
        let db=Connection::open(dir.path().join("pf.db")).unwrap();
        assert_eq!(db.query_row("SELECT value FROM meta WHERE key='schema_version'",[],|r|r.get::<_,String>(0)).unwrap(),"999");
    }
    #[test]
    fn service_v1_pending_intent_migrates_without_fabricating_validation() {
        let (dir,mut store)=open();
        let root=dir.path();
        store.mutate("store.createProject",&json!({
            "operationId":"create","projectId":"p1","name":"migration",
            "root":root.to_str().unwrap()
        })).unwrap();
        let file=root.join("a.txt");
        fs::write(&file,b"before").unwrap();
        let roots=vec![root.to_path_buf()];
        let steps:Vec<crate::edit::Step>=serde_json::from_value(json!([
            {"step":1,"op":"target","target":"before","replace":"after"}
        ])).unwrap();
        let crate::edit_pipeline::Preparation::Ready(ready)=crate::edit_pipeline::prepare(
            root,"a.txt",&roots,&steps,false).unwrap() else {panic!("plan")};
        store.prepare_intent("edit",&hash(b"request"),"p1",&ready,"migration",None).unwrap();
        let before_hash=ready.plan.expected_hash.clone();
        let after_hash=ready.plan.after_hash.clone();
        // Reconstruct the actual pre-receipt development schema.
        store.db.execute_batch("ALTER TABLE file_commit_intents DROP COLUMN validation_receipt;
            UPDATE meta SET value='1' WHERE key='service_schema_version';").unwrap();
        drop(store);
        let mut store=Store::open(&root.join("pf.db")).unwrap();
        assert_eq!(store.query("store.info",&json!({})).unwrap()["serviceSchemaVersion"],3);
        assert_eq!(Store::blob(&store.db,&before_hash).unwrap(),b"before");
        assert_eq!(Store::blob(&store.db,&after_hash).unwrap(),b"after");
        let receipt:Option<String>=store.db.query_row(
            "SELECT validation_receipt FROM file_commit_intents WHERE operation_id='edit'",
            [],|r|r.get(0)).unwrap();
        assert!(receipt.is_none());
        let intent=store.load_intent("edit").unwrap();
        assert!(crate::commit_coordinator::resume(&mut store,&intent,&roots).is_err());
        assert_eq!(fs::read(&file).unwrap(),b"before");
        assert_eq!(store.intent_status("edit").unwrap().unwrap()["state"],"conflict");
        store.db.execute("UPDATE meta SET value='999' WHERE key='service_schema_version'",[]).unwrap();
        drop(store);
        assert!(Store::open(&root.join("pf.db")).is_err());
        let db=Connection::open(root.join("pf.db")).unwrap();
        assert_eq!(db.query_row("SELECT value FROM meta WHERE key='service_schema_version'",
            [],|r|r.get::<_,String>(0)).unwrap(),"999");
    }

    #[test]
    fn legacy_tables_migrate_without_losing_rows() {
        let dir=tempfile::tempdir().unwrap();
        let db=Connection::open(dir.path().join("pf.db")).unwrap();
        db.execute_batch("CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,workspace_id TEXT,workspace_alias TEXT,
            root TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',report TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
            CREATE TABLE batches(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,kind TEXT NOT NULL,summary TEXT,created_at TEXT NOT NULL);
            INSERT INTO projects(id,name,root,created_at,updated_at) VALUES ('old','legacy','root','t','t');").unwrap();
        drop(db);
        let store=Store::open(&dir.path().join("pf.db")).unwrap();
        let row=store.query("store.getProject",&json!({"projectId":"old"})).unwrap();
        assert_eq!(row["name"],"legacy"); assert_eq!(row["subpath"],""); assert!(row["created_by"].is_null());
    }
    #[test]
    fn record_is_atomic_idempotent_and_survives_restart() {
        let (dir,mut store)=open(); project(&mut store);
        let bytes=b"\xef\xbb\xbfhello\r\n\0";
        let h=hash(bytes);
        let p=json!({"operationId":"batch","projectId":"ptest","kind":"create","maid":"Kerr",
            "blobs":[{"hash":h,"base64":STANDARD.encode(bytes)}],
            "nodes":[{"filePath":"a","op":"create","afterHash":h,"added":1}]});
        let result=store.mutate("store.recordBatch",&p).unwrap();
        assert_eq!(store.mutate("store.recordBatch",&p).unwrap(),result);
        let mut other=p.clone(); other["maid"]=json!("Other");
        assert!(store.mutate("store.recordBatch",&other).is_err());
        assert_eq!(store.query("store.getBlob",&json!({"hash":h})).unwrap()["base64"],STANDARD.encode(bytes));
        assert_eq!(store.query("store.getFileState",&json!({"projectId":"ptest","filePath":"missing"})).unwrap(),json!({"known":false}));
        let bad=json!({"operationId":"bad","projectId":"ptest","kind":"edit","nodes":[
            {"filePath":"a","op":"edit","afterHash":h},{"filePath":"b","op":"edit","afterHash":"missing"}]});
        assert!(store.mutate("store.recordBatch",&bad).is_err());
        assert_eq!(store.query("operation.status",&json!({"operationId":"bad"})).unwrap()["state"],"unknown");
        assert_eq!(store.query("store.timeline",&json!({"projectId":"ptest"})).unwrap().as_array().unwrap().len(),1);
        drop(store);
        let mut store=Store::open(&dir.path().join("pf.db")).unwrap();
        assert_eq!(store.mutate("store.recordBatch",&p).unwrap(),result);
        assert_eq!(store.query("operation.status",&json!({"operationId":"batch"})).unwrap()["state"],"committed");
    }
    #[test]
    fn corrupt_snapshots_are_not_returned() {
        let (_dir,store)=open();
        store.db.execute("INSERT INTO blobs VALUES ('bad',1,?)",[vec![1u8,2,3]]).unwrap();
        assert!(store.query("store.getBlob",&json!({"hash":"bad"})).is_err());
        let mut gzip=GzEncoder::new(Vec::new(),Compression::default());
        gzip.write_all(b"too long").unwrap();
        store.db.execute("INSERT INTO blobs VALUES ('wrong',1,?)",[gzip.finish().unwrap()]).unwrap();
        assert!(store.query("store.getBlob",&json!({"hash":"wrong"})).is_err());
    }
}