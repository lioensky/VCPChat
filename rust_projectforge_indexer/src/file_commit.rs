//! Durable multi-file commit journal for create/remove/replace and rollback plans.
//! SQLite history is written once, after every target has reached its planned image.
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use flate2::{write::GzEncoder, Compression};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::file_replace::MAX_IMAGE_BYTES;
use crate::project_path::{self, ProjectPath};
use crate::storage::{Result, Store};

const MAX_CHANGES: usize = 200;
const MAX_REVIEW_BYTES: usize = 1024 * 1024;
const MAX_RESULT_BYTES: usize = 2 * 1024 * 1024;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS file_commit_plans (
    operation_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    root TEXT NOT NULL,
    kind TEXT NOT NULL,
    reason TEXT NOT NULL,
    maid TEXT,
    review TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared','conflict','committed')),
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_commit_plans_project
ON file_commit_plans(project_id, created_at);
CREATE TABLE IF NOT EXISTS file_commit_changes (
    operation_id TEXT NOT NULL REFERENCES file_commit_plans(operation_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    resource_key TEXT NOT NULL,
    op TEXT NOT NULL,
    before_hash TEXT REFERENCES blobs(hash),
    after_hash TEXT REFERENCES blobs(hash),
    summary TEXT,
    todo_id INTEGER,
    state TEXT NOT NULL CHECK(state IN ('prepared','applied','conflict','committed')),
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(operation_id, ordinal),
    UNIQUE(operation_id, file_path)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_commit_change_resource_active
ON file_commit_changes(resource_key)
WHERE state IN ('prepared','applied');
CREATE INDEX IF NOT EXISTS idx_file_commit_changes_project
ON file_commit_changes(project_id, file_path);
CREATE TRIGGER IF NOT EXISTS file_commit_change_guard_single
BEFORE INSERT ON file_commit_changes
WHEN EXISTS (
    SELECT 1 FROM file_commit_intents
    WHERE resource_key=NEW.resource_key AND state='prepared'
)
BEGIN
    SELECT RAISE(ABORT,'resource is locked by a pending file intent');
END;
CREATE TRIGGER IF NOT EXISTS file_commit_intent_guard_multi
BEFORE INSERT ON file_commit_intents
WHEN EXISTS (
    SELECT 1 FROM file_commit_changes
    WHERE resource_key=NEW.resource_key AND state IN ('prepared','applied')
)
BEGIN
    SELECT RAISE(ABORT,'resource is locked by a pending multi-file commit');
END;
"#;

#[derive(Debug)]
pub struct Change {
    pub path: String,
    pub before: Option<Vec<u8>>,
    pub after: Option<Vec<u8>>,
    pub op: String,
    pub summary: Option<String>,
    pub todo_id: Option<i64>,
}

#[derive(Debug)]
pub struct Plan {
    pub project_id: String,
    pub root: PathBuf,
    pub kind: String,
    pub reason: String,
    pub maid: Option<String>,
    pub changes: Vec<Change>,
    pub review: Value,
}

#[derive(Debug)]
struct PlanRow {
    request_hash: String,
    project_id: String,
    root: String,
    kind: String,
    reason: String,
    maid: Option<String>,
    review: String,
    state: String,
    result: Option<String>,
}

#[derive(Debug)]
struct ChangeRow {
    ordinal: i64,
    file_path: String,
    op: String,
    before_hash: Option<String>,
    after_hash: Option<String>,
    summary: Option<String>,
    todo_id: Option<i64>,
    state: String,
}

#[derive(Debug)]
struct PreparedChange {
    path: String,
    resource_key: String,
    op: String,
    before: Option<Vec<u8>>,
    after: Option<Vec<u8>>,
    before_hash: Option<String>,
    after_hash: Option<String>,
    summary: Option<String>,
    todo_id: Option<i64>,
}

#[derive(Debug, PartialEq, Eq)]
enum RecoveryPosition {
    Before,
    After,
    Conflict,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn put_blob(db: &Connection, bytes: &[u8]) -> Result<String> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("commit image exceeds byte budget".into());
    }
    let hash = digest(bytes);
    let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
    gzip.write_all(bytes)?;
    let compressed = gzip.finish()?;
    db.execute(
        "INSERT OR IGNORE INTO blobs(hash,size,data) VALUES (?,?,?)",
        params![hash, bytes.len() as i64, compressed],
    )?;
    let stored = Store::blob(db, &hash)?;
    if stored.as_slice() != bytes {
        return Err("blob hash collision or corrupt durable snapshot".into());
    }
    Ok(hash)
}

fn now(db: &Connection) -> Result<String> {
    Ok(db.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |r| {
        r.get(0)
    })?)
}

fn plan_header(store: &Store, operation_id: &str) -> Result<Option<PlanRow>> {
    Ok(store
        .db
        .query_row(
            "SELECT request_hash,project_id,root,kind,reason,maid,review,state,result
             FROM file_commit_plans WHERE operation_id=?",
            [operation_id],
            |r| {
                Ok(PlanRow {
                    request_hash: r.get(0)?,
                    project_id: r.get(1)?,
                    root: r.get(2)?,
                    kind: r.get(3)?,
                    reason: r.get(4)?,
                    maid: r.get(5)?,
                    review: r.get(6)?,
                    state: r.get(7)?,
                    result: r.get(8)?,
                })
            },
        )
        .optional()?)
}

fn change_rows_db(db: &Connection, operation_id: &str) -> Result<Vec<ChangeRow>> {
    let mut query = db.prepare(
        "SELECT ordinal,file_path,op,before_hash,after_hash,summary,todo_id,state
         FROM file_commit_changes WHERE operation_id=? ORDER BY ordinal",
    )?;
    let changes = query
        .query_map([operation_id], |r| {
            Ok(ChangeRow {
                ordinal: r.get(0)?,
                file_path: r.get(1)?,
                op: r.get(2)?,
                before_hash: r.get(3)?,
                after_hash: r.get(4)?,
                summary: r.get(5)?,
                todo_id: r.get(6)?,
                state: r.get(7)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(changes)
}

fn change_rows(store: &Store, operation_id: &str) -> Result<Vec<ChangeRow>> {
    change_rows_db(&store.db, operation_id)
}

fn read_image(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.file_type().is_file() {
                return Err("target is not a regular file".into());
            }
            if meta.len() > MAX_IMAGE_BYTES as u64 {
                return Err("target exceeds commit image budget".into());
            }
            Ok(Some(fs::read(path)?))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn allowed_path(path: &ProjectPath, allowed_roots: &[PathBuf]) -> bool {
    allowed_roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| path.absolute.starts_with(root))
}

fn allowed_root(root: &Path, allowed_roots: &[PathBuf]) -> bool {
    allowed_roots
        .iter()
        .filter_map(|candidate| candidate.canonicalize().ok())
        .any(|candidate| root.starts_with(candidate))
}

fn checked_project_root(
    store: &Store,
    plan: &Plan,
    allowed_roots: &[PathBuf],
) -> Result<PathBuf> {
    if !plan.root.is_absolute() {
        return Err("plan root must be absolute".into());
    }
    let project: Option<(String, Option<String>)> = store
        .db
        .query_row(
            "SELECT root,deleted_at FROM projects WHERE id=?",
            [&plan.project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (db_root, deleted) = project.ok_or("project missing")?;
    if deleted.is_some() {
        return Err("project is deleted".into());
    }
    let expected = Path::new(&db_root).canonicalize()?;
    let root = plan.root.canonicalize()?;
    if root != expected {
        return Err("plan root differs from the durable project root".into());
    }
    if !allowed_root(&root, allowed_roots) {
        return Err("project root is outside trusted allowed roots".into());
    }
    Ok(root)
}

fn resource_key(path: &ProjectPath) -> Result<String> {
    let value = path
        .absolute
        .to_str()
        .ok_or("project path is not UTF-8")?;
    #[cfg(windows)]
    {
        Ok(value.to_lowercase())
    }
    #[cfg(not(windows))]
    {
        Ok(value.to_string())
    }
}

fn classify_image(
    before_hash: Option<&str>,
    after_hash: Option<&str>,
    actual: Option<&[u8]>,
) -> RecoveryPosition {
    let current = actual.map(digest);
    match (before_hash, after_hash, actual) {
        (None, Some(_), None) => RecoveryPosition::Before,
        (None, Some(after), Some(_)) if current.as_deref() == Some(after) => {
            RecoveryPosition::After
        }
        (Some(_), None, None) => RecoveryPosition::After,
        (Some(before), None, Some(_)) if current.as_deref() == Some(before) => {
            RecoveryPosition::Before
        }
        (Some(_), Some(after), Some(_)) if current.as_deref() == Some(after) => {
            RecoveryPosition::After
        }
        (Some(before), Some(_), Some(_)) if current.as_deref() == Some(before) => {
            RecoveryPosition::Before
        }
        _ => RecoveryPosition::Conflict,
    }
}

fn classify(change: &ChangeRow, actual: Option<&[u8]>) -> RecoveryPosition {
    classify_image(
        change.before_hash.as_deref(),
        change.after_hash.as_deref(),
        actual,
    )
}

fn normalize_changes(
    plan: &Plan,
    root: &Path,
    allowed_roots: &[PathBuf],
) -> Result<Vec<PreparedChange>> {
    if plan.changes.len() > MAX_CHANGES {
        return Err("file commit change budget exceeded".into());
    }
    let mut seen = HashSet::<String>::new();
    let mut prepared = Vec::new();
    for change in &plan.changes {
        if change.before.is_none() && change.after.is_none() {
            return Err("change requires before or after image".into());
        }
        if change
            .before
            .as_ref()
            .is_some_and(|bytes| bytes.len() > MAX_IMAGE_BYTES)
            || change
                .after
                .as_ref()
                .is_some_and(|bytes| bytes.len() > MAX_IMAGE_BYTES)
        {
            return Err("change image exceeds byte budget".into());
        }
        if !token(change.op.trim(), 32) {
            return Err("invalid change operation".into());
        }
        if change
            .summary
            .as_ref()
            .is_some_and(|summary| summary.len() > 2000)
        {
            return Err("change summary budget exceeded".into());
        }
        if change.todo_id.is_some_and(|todo| todo <= 0) {
            return Err("invalid todo identifier".into());
        }
        let path = project_path::resolve(root, &change.path, true)
            .map_err(|error| format!("invalid change path {}: {error}", change.path))?;
        if !allowed_path(&path, allowed_roots) {
            return Err("change path is outside trusted allowed roots".into());
        }
        if change.before.is_some() && change.before == change.after {
            continue;
        }
        if !seen.insert(path.relative.clone()) {
            return Err("duplicate path in one file commit".into());
        }
        // Counts are part of the durable plan budget. Reject impossible diffs
        // before blobs or file intents are written and before any disk mutation.
        diff_counts(change.before.as_deref(),change.after.as_deref())
            .map_err(|error|format!("change {}: {error}",path.relative))?;
        let before_hash = change.before.as_ref().map(|bytes| digest(bytes));
        let after_hash = change.after.as_ref().map(|bytes| digest(bytes));
        let key = resource_key(&path)?;
        prepared.push(PreparedChange {
            path: path.relative,
            resource_key: key,
            op: change.op.trim().to_string(),
            before: change.before.clone(),
            after: change.after.clone(),
            before_hash,
            after_hash,
            summary: change.summary.clone(),
            todo_id: change.todo_id,
        });
    }
    Ok(prepared)
}

fn preflight_changes(
    root: &Path,
    allowed_roots: &[PathBuf],
    changes: &[PreparedChange],
) -> Result<()> {
    for change in changes {
        let path = project_path::resolve(root, &change.path, true)
            .map_err(|error| format!("pre-flight path {} is invalid: {error}", change.path))?;
        if !allowed_path(&path, allowed_roots) {
            return Err(format!(
                "pre-flight path {} is outside trusted allowed roots",
                change.path
            )
            .into());
        }
        let actual = read_image(&path.absolute)
            .map_err(|error| format!("pre-flight target {} cannot be read: {error}", change.path))?;
        if classify_image(
            change.before_hash.as_deref(),
            change.after_hash.as_deref(),
            actual.as_deref(),
        ) != RecoveryPosition::Before
        {
            return Err(format!(
                "file commit pre-flight conflict at {}: target differs from planning snapshot",
                change.path
            )
            .into());
        }
    }
    Ok(())
}

fn operation_occupied(db: &Connection, operation_id: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM file_commit_plans WHERE operation_id=?1
            UNION ALL SELECT 1 FROM service_operations WHERE id=?1
            UNION ALL SELECT 1 FROM file_commit_intents WHERE operation_id=?1
        )",
        [operation_id],
        |r| r.get(0),
    )?)
}

fn active_project(db: &Connection, project_id: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL)",
        [project_id],
        |r| r.get(0),
    )?)
}

fn claim(
    store: &mut Store,
    operation_id: &str,
    request_hash: &str,
    plan: &Plan,
    root: &Path,
    changes: &[PreparedChange],
) -> Result<()> {
    let tx = store
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    if operation_occupied(&tx, operation_id)? {
        return Err("operation already exists; query status instead of replanning".into());
    }
    if !active_project(&tx, &plan.project_id)? {
        return Err("project missing or deleted".into());
    }
    let mut todos = HashSet::new();
    for change in changes {
        if let Some(todo_id) = change.todo_id {
            if !todos.insert(todo_id) {
                continue;
            }
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM todos WHERE project_id=? AND id=?)",
                params![plan.project_id.as_str(), todo_id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err("change references a todo from another project".into());
            }
        }
    }
    let review = serde_json::to_string(&plan.review)?;
    if review.len() > MAX_REVIEW_BYTES {
        return Err("review budget exceeded".into());
    }
    let root = root.to_str().ok_or("project root is not UTF-8")?;
    let ts = now(&tx)?;
    tx.execute(
        "INSERT INTO file_commit_plans(operation_id,request_hash,project_id,root,kind,reason,maid,review,
            state,result,error,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,'prepared',NULL,NULL,?,?)",
        params![
            operation_id,
            request_hash,
            plan.project_id.as_str(),
            root,
            plan.kind.as_str(),
            plan.reason.as_str(),
            plan.maid.as_deref(),
            review,
            ts,
            ts
        ],
    )?;
    for (index, change) in changes.iter().enumerate() {
        let before = change
            .before
            .as_deref()
            .map(|bytes| put_blob(&tx, bytes))
            .transpose()?;
        let after = change
            .after
            .as_deref()
            .map(|bytes| put_blob(&tx, bytes))
            .transpose()?;
        if before.as_deref() != change.before_hash.as_deref()
            || after.as_deref() != change.after_hash.as_deref()
        {
            return Err("durable image hash changed while planning".into());
        }
        tx.execute(
            "INSERT INTO file_commit_changes(operation_id,project_id,ordinal,file_path,resource_key,op,
                before_hash,after_hash,summary,todo_id,state,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,'prepared',?,?)",
            params![
                operation_id,
                plan.project_id.as_str(),
                (index + 1) as i64,
                change.path.as_str(),
                change.resource_key.as_str(),
                change.op.as_str(),
                before.as_deref(),
                after.as_deref(),
                change.summary.as_deref(),
                change.todo_id,
                ts,
                ts
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn mark_applied(store: &mut Store, operation_id: &str, ordinal: i64) -> Result<()> {
    let tx = store
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let ts = now(&tx)?;
    tx.execute(
        "UPDATE file_commit_changes SET state='applied',error=NULL,updated_at=?
         WHERE operation_id=? AND ordinal=? AND state='prepared'",
        params![ts, operation_id, ordinal],
    )?;
    tx.execute(
        "UPDATE file_commit_plans SET updated_at=? WHERE operation_id=? AND state='prepared'",
        params![ts, operation_id],
    )?;
    tx.commit()?;
    Ok(())
}

fn compensate_and_fail(
    store: &mut Store,
    operation_id: &str,
    root: &Path,
    allowed_roots: &[PathBuf],
    trigger_ordinal: Option<i64>,
    message: &str,
) -> Result<Value> {
    let changes = change_rows(store, operation_id)?;
    let mut preserved = Vec::<String>::new();
    // Undo only changes that are durably marked applied, newest first. A path
    // whose bytes are no longer this plan's after image belongs to a third party
    // and is never overwritten.
    for change in changes.iter().rev() {
        if change.state != "applied" {
            continue;
        }
        let path = match project_path::resolve(root, &change.file_path, true) {
            Ok(path) if allowed_path(&path, allowed_roots) => path,
            Ok(_) => {
                preserved.push(format!(
                    "{}: path is no longer authorized; bytes preserved",
                    change.file_path
                ));
                continue;
            }
            Err(error) => {
                preserved.push(format!(
                    "{}: path is unavailable; bytes preserved ({error})",
                    change.file_path
                ));
                continue;
            }
        };
        let actual = match read_image(&path.absolute) {
            Ok(actual) => actual,
            Err(error) => {
                preserved.push(format!(
                    "{}: current bytes cannot be inspected ({error})",
                    change.file_path
                ));
                continue;
            }
        };
        if classify(&change, actual.as_deref()) != RecoveryPosition::After {
            preserved.push(format!(
                "{}: third-party bytes preserved",
                change.file_path
            ));
            continue;
        }
        let restored = match (change.before_hash.as_deref(), change.after_hash.as_deref()) {
            (None, Some(after)) => crate::file_replace::remove_image(&path, after),
            (Some(before), None) => match Store::blob(&store.db, before) {
                Ok(bytes) => crate::file_replace::create_image(&path, &bytes),
                Err(error) => Err(error.to_string()),
            },
            (Some(before), Some(after)) => match Store::blob(&store.db, before) {
                Ok(bytes) => crate::file_replace::replace_image(&path, after, &bytes),
                Err(error) => Err(error.to_string()),
            },
            _ => Err("change has no filesystem image transition".into()),
        };
        if let Err(error) = restored {
            preserved.push(format!(
                "{}: rollback failed; bytes preserved ({error})",
                change.file_path
            ));
        }
    }

    let mut detail = format!("file commit conflict: {message}");
    if let Some(ordinal) = trigger_ordinal {
        detail.push_str(&format!(" (change {ordinal})"));
    }
    for note in preserved {
        detail.push_str("; ");
        detail.push_str(&note);
    }
    let detail: String = detail.chars().take(2000).collect();
    let tx = store
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let ts = now(&tx)?;
    tx.execute(
        "UPDATE file_commit_plans SET state='conflict',error=?,updated_at=?
         WHERE operation_id=? AND state='prepared'",
        params![detail, ts, operation_id],
    )?;
    tx.execute(
        "UPDATE file_commit_changes SET state='conflict',error=?,updated_at=?
         WHERE operation_id=? AND state IN ('prepared','applied')",
        params![detail, ts, operation_id],
    )?;
    tx.commit()?;
    Err(detail.into())
}

fn apply_change(
    change: &ChangeRow,
    path: &ProjectPath,
    after: Option<&[u8]>,
) -> std::result::Result<(), String> {
    match (change.before_hash.as_deref(), change.after_hash.as_deref()) {
        (None, Some(_)) => crate::file_replace::create_image(
            path,
            after.ok_or("create image snapshot missing")?,
        ),
        (Some(expected), None) => crate::file_replace::remove_image(path, expected),
        (Some(expected), Some(_)) => crate::file_replace::replace_image(
            path,
            expected,
            after.ok_or("replacement image snapshot missing")?,
        ),
        _ => Err("change has no filesystem image transition".into()),
    }
}

fn resume_plan(
    store: &mut Store,
    operation_id: &str,
    allowed_roots: &[PathBuf],
) -> Result<Value> {
    let header = plan_header(store, operation_id)?.ok_or("file commit plan missing")?;
    if header.state == "committed" {
        return Ok(serde_json::from_str(
            header
                .result
                .as_deref()
                .ok_or("committed file commit plan missing result")?,
        )?);
    }
    if header.state == "conflict" {
        return Err(
            "file commit failed due to conflict; before snapshot preserved and resource lock released"
                .into(),
        );
    }
    if header.state != "prepared" {
        return Err("unknown file commit state".into());
    }
    let project_root: Option<String> = store
        .db
        .query_row(
            "SELECT root FROM projects WHERE id=? AND deleted_at IS NULL",
            [&header.project_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(project_root) = project_root else {
        return compensate_and_fail(
            store,
            operation_id,
            Path::new(&header.root),
            allowed_roots,
            None,
            "project deleted before recovery",
        );
    };
    let root = match Path::new(&header.root).canonicalize() {
        Ok(root) => root,
        Err(error) => {
            return compensate_and_fail(
                store,
                operation_id,
                Path::new(&header.root),
                allowed_roots,
                None,
                &format!("commit root is no longer accessible: {error}"),
            );
        }
    };
    let expected_root = match Path::new(&project_root).canonicalize() {
        Ok(root) => root,
        Err(error) => {
            return compensate_and_fail(
                store,
                operation_id,
                &root,
                allowed_roots,
                None,
                &format!("project root is no longer accessible: {error}"),
            );
        }
    };
    if root != expected_root || !allowed_root(&root, allowed_roots) {
        return compensate_and_fail(
            store,
            operation_id,
            &root,
            allowed_roots,
            None,
            "project root changed or is no longer authorized",
        );
    }

    let changes = change_rows(store, operation_id)?;
    if changes.is_empty() {
        return compensate_and_fail(
            store,
            operation_id,
            &root,
            allowed_roots,
            None,
            "prepared commit has no file changes",
        );
    }
    let mut order: Vec<usize> = (0..changes.len()).collect();
    // Create/replace first and removals last: a move or rollback must not delete
    // its source before the target image is durable and applied.
    order.sort_by_key(|index| usize::from(changes[*index].after_hash.is_none()));

    for index in order {
        let change = &changes[index];
        let path = match project_path::resolve(&root, &change.file_path, true) {
            Ok(path) if allowed_path(&path, allowed_roots) => path,
            Ok(_) => {
                return compensate_and_fail(
                    store,
                    operation_id,
                    &root,
                    allowed_roots,
                    Some(change.ordinal),
                    "commit path is outside trusted allowed roots",
                );
            }
            Err(error) => {
                return compensate_and_fail(
                    store,
                    operation_id,
                    &root,
                    allowed_roots,
                    Some(change.ordinal),
                    &format!("commit path is no longer valid: {error}"),
                );
            }
        };
        let actual = match read_image(&path.absolute) {
            Ok(actual) => actual,
            Err(error) => {
                return compensate_and_fail(
                    store,
                    operation_id,
                    &root,
                    allowed_roots,
                    Some(change.ordinal),
                    &format!("current target cannot be inspected safely: {error}"),
                );
            }
        };
        match classify(change, actual.as_deref()) {
            RecoveryPosition::After => {
                if let Err(error) = mark_applied(store, operation_id, change.ordinal) {
                    return compensate_and_fail(
                        store,
                        operation_id,
                        &root,
                        allowed_roots,
                        Some(change.ordinal),
                        &format!("applied change could not be recorded: {error}"),
                    );
                }
            }
            RecoveryPosition::Conflict => {
                return compensate_and_fail(
                    store,
                    operation_id,
                    &root,
                    allowed_roots,
                    Some(change.ordinal),
                    "current target is a third version; external contents preserved",
                );
            }
            RecoveryPosition::Before => {
                let after = match change.after_hash.as_deref() {
                    Some(hash) => match Store::blob(&store.db, hash) {
                        Ok(bytes) => Some(bytes),
                        Err(error) => {
                            return compensate_and_fail(
                                store,
                                operation_id,
                                &root,
                                allowed_roots,
                                Some(change.ordinal),
                                &format!("after snapshot cannot be loaded: {error}"),
                            );
                        }
                    },
                    None => None,
                };
                if let Err(apply_error) = apply_change(change, &path, after.as_deref()) {
                    return compensate_and_fail(
                        store,
                        operation_id,
                        &root,
                        allowed_roots,
                        Some(change.ordinal),
                        &format!("apply failed at {}: {apply_error}", change.file_path),
                    );
                }
                let actual = match read_image(&path.absolute) {
                    Ok(actual) => actual,
                    Err(error) => {
                        return compensate_and_fail(
                            store,
                            operation_id,
                            &root,
                            allowed_roots,
                            Some(change.ordinal),
                            &format!("applied target cannot be verified: {error}"),
                        );
                    }
                };
                if classify(change, actual.as_deref()) != RecoveryPosition::After {
                    return compensate_and_fail(
                        store,
                        operation_id,
                        &root,
                        allowed_roots,
                        Some(change.ordinal),
                        "post-apply image differs from durable plan",
                    );
                }
                if let Err(error) = mark_applied(store, operation_id, change.ordinal) {
                    return compensate_and_fail(
                        store,
                        operation_id,
                        &root,
                        allowed_roots,
                        Some(change.ordinal),
                        &format!("applied change could not be recorded: {error}"),
                    );
                }
            }
        }
    }

    let final_changes = change_rows(store, operation_id)?;
    for change in &final_changes {
        if change.state != "applied" {
            return compensate_and_fail(
                store,
                operation_id,
                &root,
                allowed_roots,
                Some(change.ordinal),
                "file commit has an unapplied change after recovery",
            );
        }
        let path = match project_path::resolve(&root, &change.file_path, true) {
            Ok(path) if allowed_path(&path, allowed_roots) => path,
            Ok(_) => {
                return compensate_and_fail(
                    store,
                    operation_id,
                    &root,
                    allowed_roots,
                    Some(change.ordinal),
                    "authorization changed before finalization",
                );
            }
            Err(error) => {
                return compensate_and_fail(
                    store,
                    operation_id,
                    &root,
                    allowed_roots,
                    Some(change.ordinal),
                    &format!("target path became invalid before finalization: {error}"),
                );
            }
        };
        let actual = match read_image(&path.absolute) {
            Ok(actual) => actual,
            Err(error) => {
                return compensate_and_fail(
                    store,
                    operation_id,
                    &root,
                    allowed_roots,
                    Some(change.ordinal),
                    &format!("target cannot be verified before finalization: {error}"),
                );
            }
        };
        if classify(change, actual.as_deref()) != RecoveryPosition::After {
            return compensate_and_fail(
                store,
                operation_id,
                &root,
                allowed_roots,
                Some(change.ordinal),
                "target changed before history finalization; current contents preserved",
            );
        }
    }
    if !active_project(&store.db, &header.project_id)? {
        return compensate_and_fail(
            store,
            operation_id,
            &root,
            allowed_roots,
            None,
            "project deleted before finalization",
        );
    }
    // Once every file is durably at its after image, a database-only finalize
    // failure leaves prepared/applied states intact for restart recovery.
    finalize(store, operation_id)
}

fn diff_counts(before: Option<&[u8]>, after: Option<&[u8]>) -> Result<(i64, i64)> {
    let before = match before {
        Some(bytes) => match std::str::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => return Ok((0, 0)),
        },
        None => "",
    };
    let after = match after {
        Some(bytes) => match std::str::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => return Ok((0, 0)),
        },
        None => "",
    };
    let stats=crate::line_diff::stats_bounded(before,after)
        .map_err(|error|format!("line count rejected: {error}"))?;
    let added=i64::try_from(stats.added)
        .map_err(|_|"line count exceeds i64 range")?;
    let removed=i64::try_from(stats.removed)
        .map_err(|_|"line count exceeds i64 range")?;
    Ok((added,removed))
}

fn node_summary(change: &ChangeRow) -> Option<String> {
    if change.summary.is_some() {
        return change.summary.clone();
    }
    match (&change.before_hash, &change.after_hash) {
        (None, Some(_)) => Some("新建文件".into()),
        (Some(_), None) => Some("删除文件".into()),
        (Some(_), Some(_)) => Some("替换文件".into()),
        (None, None) => None,
    }
}

pub(crate) fn record_external_snapshot(
    db: &Connection, project: &str, file: &str, before: Option<&str>, ts: &str,
) -> Result<()> {
    let recorded: Option<Option<String>> = db.query_row(
        "SELECT hash FROM file_state WHERE project_id=? AND file_path=?",
        params![project, file], |row| row.get(0),
    ).optional()?;
    let Some(recorded) = recorded else { return Ok(()); };
    if recorded.as_deref() == before { return Ok(()); }
    let old = recorded.as_deref().map(|hash| Store::blob(db, hash)).transpose()?;
    let current = before.map(|hash| Store::blob(db, hash)).transpose()?;
    let (added, removed) = diff_counts(old.as_deref(), current.as_deref())?;
    db.execute(
        "INSERT INTO batches(project_id,kind,reason,summary,created_at) VALUES (?,'external',?,?,?)",
        params![project, "外部修改（提交前快照）", file, ts],
    )?;
    let batch = db.last_insert_rowid();
    db.execute(
        "INSERT INTO nodes(project_id,batch_id,file_path,op,before_hash,after_hash,summary,added,removed,created_at)
         VALUES (?,?,?,'external',?,?,?,?,?,?)",
        params![project, batch, file, recorded.as_deref(), before, "外部修改（提交前快照）", added, removed, ts],
    )?;
    Ok(())
}

fn finalize(store: &mut Store, operation_id: &str) -> Result<Value> {
    let tx = store
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    let plan: Option<PlanRow> = tx
        .query_row(
            "SELECT request_hash,project_id,root,kind,reason,maid,review,state,result
             FROM file_commit_plans WHERE operation_id=?",
            [operation_id],
            |r| {
                Ok(PlanRow {
                    request_hash: r.get(0)?,
                    project_id: r.get(1)?,
                    root: r.get(2)?,
                    kind: r.get(3)?,
                    reason: r.get(4)?,
                    maid: r.get(5)?,
                    review: r.get(6)?,
                    state: r.get(7)?,
                    result: r.get(8)?,
                })
            },
        )
        .optional()?;
    let plan = plan.ok_or("file commit plan missing during finalization")?;
    if plan.state == "committed" {
        let result = serde_json::from_str(
            plan.result
                .as_deref()
                .ok_or("committed file commit plan missing result")?,
        )?;
        tx.commit()?;
        return Ok(result);
    }
    if plan.state != "prepared" {
        return Err("only a prepared file commit can finalize".into());
    }
    if !active_project(&tx, &plan.project_id)? {
        return Err("project deleted while file commit pending".into());
    }
    let changes = change_rows_db(&tx, operation_id)?;
    if changes.is_empty() || changes.iter().any(|change| change.state != "applied") {
        return Err("all file changes must be applied before finalization".into());
    }
    let review: Value = serde_json::from_str(&plan.review)?;
    let ts = now(&tx)?;
    for change in &changes {
        record_external_snapshot(&tx, &plan.project_id, &change.file_path, change.before_hash.as_deref(), &ts)?;
    }
    // Todo ownership is rechecked in the terminal transaction. Only the final
    // history commit claims pending work; planning never mutates Todo status.
    let mut todo_ids=HashSet::new();
    for change in &changes {
        let Some(todo_id)=change.todo_id else {continue;};
        if !todo_ids.insert(todo_id) {continue;}
        let owner:Option<String>=tx.query_row(
            "SELECT project_id FROM todos WHERE id=?",
            [todo_id],
            |r|r.get(0),
        ).optional()?;
        if owner.as_deref()!=Some(plan.project_id.as_str()) {
            return Err("change todo no longer belongs to the project".into());
        }
        tx.execute(
            "UPDATE todos SET status='doing',updated_by=?,updated_at=?
             WHERE project_id=? AND id=? AND status='pending'",
            params![plan.maid.as_deref(),ts,plan.project_id.as_str(),todo_id],
        )?;
    }
    tx.execute(
        "INSERT INTO batches(project_id,kind,reason,maid,summary,created_at)
         VALUES (?,?,?,?,?,?)",
        params![
            plan.project_id.as_str(),
            plan.kind.as_str(),
            plan.reason.as_str(),
            plan.maid.as_deref(),
            format!("{} 个文件", changes.len()),
            ts
        ],
    )?;
    let batch_id = tx.last_insert_rowid();
    let mut node_ids = Vec::<i64>::new();
    let mut files = Vec::<Value>::new();
    for change in &changes {
        let before = match change.before_hash.as_deref() {
            Some(hash) => Some(Store::blob(&tx, hash)?),
            None => None,
        };
        let after = match change.after_hash.as_deref() {
            Some(hash) => Some(Store::blob(&tx, hash)?),
            None => None,
        };
        let (added, removed) = diff_counts(before.as_deref(), after.as_deref())?;
        let summary = node_summary(change);
        tx.execute(
            "INSERT INTO nodes(project_id,batch_id,file_path,op,before_hash,after_hash,todo_id,
                reason,summary,added,removed,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                plan.project_id.as_str(),
                batch_id,
                change.file_path.as_str(),
                change.op.as_str(),
                change.before_hash.as_deref(),
                change.after_hash.as_deref(),
                change.todo_id,
                plan.reason.as_str(),
                summary.as_deref(),
                added,
                removed,
                ts
            ],
        )?;
        let node_id = tx.last_insert_rowid();
        node_ids.push(node_id);
        // NULL hash is the durable deleted tombstone; it must differ from a
        // file path that has never appeared in file_state.
        tx.execute(
            "INSERT INTO file_state(project_id,file_path,hash) VALUES (?,?,?)
             ON CONFLICT(project_id,file_path) DO UPDATE SET hash=excluded.hash",
            params![
                plan.project_id.as_str(),
                change.file_path.as_str(),
                change.after_hash.as_deref()
            ],
        )?;
        files.push(json!({
            "filePath": change.file_path,
            "beforeHash": change.before_hash,
            "afterHash": change.after_hash,
            "op": change.op,
            "summary": change.summary,
        }));
    }
    tx.execute(
        "UPDATE projects SET updated_at=? WHERE id=?",
        params![ts, plan.project_id.as_str()],
    )?;
    let result = json!({
        "operationId": operation_id,
        "status": "ok",
        "batchId": batch_id,
        "nodeIds": node_ids,
        "files": files,
        "review": review,
    });
    let encoded = serde_json::to_string(&result)?;
    if encoded.len() > MAX_RESULT_BYTES {
        return Err("file commit result budget exceeded".into());
    }
    tx.execute(
        "INSERT INTO service_operations(id,request_hash,result,created_at) VALUES (?,?,?,?)",
        params![operation_id, plan.request_hash.as_str(), encoded, ts],
    )?;
    let updated = tx.execute(
        "UPDATE file_commit_plans SET state='committed',result=?,error=NULL,updated_at=?
         WHERE operation_id=? AND state='prepared'",
        params![encoded, ts, operation_id],
    )?;
    if updated != 1 {
        return Err("file commit state changed during finalization".into());
    }
    let released = tx.execute(
        "UPDATE file_commit_changes SET state='committed',error=NULL,updated_at=?
         WHERE operation_id=? AND state='applied'",
        params![ts, operation_id],
    )?;
    if released != changes.len() {
        return Err("not every applied file change was released".into());
    }
    tx.commit()?;
    Ok(result)
}

fn persist_unchanged(
    store: &mut Store,
    operation_id: &str,
    request_hash: &str,
    plan: &Plan,
    root: &Path,
) -> Result<Value> {
    let tx = store
        .db
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    if operation_occupied(&tx, operation_id)? {
        return Err("operation already exists; query status instead of replanning".into());
    }
    if !active_project(&tx, &plan.project_id)? {
        return Err("project missing or deleted".into());
    }
    let review = serde_json::to_string(&plan.review)?;
    if review.len() > MAX_REVIEW_BYTES {
        return Err("review budget exceeded".into());
    }
    let result = json!({
        "operationId": operation_id,
        "status": "unchanged",
        "files": [],
        "review": plan.review,
    });
    let encoded = serde_json::to_string(&result)?;
    if encoded.len() > MAX_RESULT_BYTES {
        return Err("file commit result budget exceeded".into());
    }
    let root = root.to_str().ok_or("project root is not UTF-8")?;
    let ts = now(&tx)?;
    tx.execute(
        "INSERT INTO file_commit_plans(operation_id,request_hash,project_id,root,kind,reason,maid,review,
            state,result,error,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,'committed',?,NULL,?,?)",
        params![
            operation_id,
            request_hash,
            plan.project_id.as_str(),
            root,
            plan.kind.as_str(),
            plan.reason.as_str(),
            plan.maid.as_deref(),
            review,
            encoded,
            ts,
            ts
        ],
    )?;
    tx.execute(
        "INSERT INTO service_operations(id,request_hash,result,created_at) VALUES (?,?,?,?)",
        params![operation_id, request_hash, encoded, ts],
    )?;
    tx.commit()?;
    Ok(result)
}

pub fn commit(
    store: &mut Store,
    operation_id: &str,
    request_hash: &str,
    plan: Plan,
    allowed_roots: &[PathBuf],
) -> Result<Value> {
    if operation_id.is_empty() || operation_id.len() > 128 {
        return Err("invalid file commit operationId".into());
    }
    if !valid_hash(request_hash) {
        return Err("invalid file commit request hash".into());
    }
    if !token(&plan.project_id, 64) {
        return Err("invalid projectId".into());
    }
    if !token(&plan.kind, 64) {
        return Err("invalid file commit kind".into());
    }
    if plan.reason.trim().is_empty() || plan.reason.len() > 2000 {
        return Err("invalid file commit reason".into());
    }
    if plan
        .maid
        .as_ref()
        .is_some_and(|maid| maid.trim().is_empty() || maid.len() > 128)
    {
        return Err("invalid maid".into());
    }
    if !plan.review.is_object() {
        return Err("review must be an object".into());
    }
    if serde_json::to_vec(&plan.review)?.len() > MAX_REVIEW_BYTES {
        return Err("review budget exceeded".into());
    }
    if let Some(existing) = plan_header(store, operation_id)? {
        if existing.request_hash != request_hash {
            return Err("operationId reused with a different request".into());
        }
        return match existing.state.as_str() {
            "committed" => Ok(serde_json::from_str(
                existing
                    .result
                    .as_deref()
                    .ok_or("committed file commit plan missing result")?,
            )?),
            "prepared" => resume_plan(store, operation_id, allowed_roots),
            "conflict" => Err(
                "operation ended in conflict (before snapshot preserved, resource lock released); retry with a new operationId"
                    .into(),
            ),
            _ => Err("unknown file commit state".into()),
        };
    }

    let existing = store.query(
        "operation.status",
        &json!({"operationId": operation_id}),
    )?;
    let existing_state = existing
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if existing_state != "unknown" {
        if existing.get("requestHash").and_then(Value::as_str) != Some(request_hash) {
            return Err("operationId reused with a different request".into());
        }
        if let Some(result) = existing.get("result").filter(|value| !value.is_null()) {
            return Ok(result.clone());
        }
        return Err("operation is pending in another native flow; query its status there".into());
    }

    let root = checked_project_root(store, &plan, allowed_roots)?;
    let changes = normalize_changes(&plan, &root, allowed_roots)?;
    if changes.is_empty() {
        return persist_unchanged(store, operation_id, request_hash, &plan, &root);
    }
    preflight_changes(&root, allowed_roots, &changes)?;
    claim(store, operation_id, request_hash, &plan, &root, &changes)?;
    resume_plan(store, operation_id, allowed_roots)
}

pub fn operation_status(store: &Store, operation_id: &str) -> Result<Option<Value>> {
    if operation_id.is_empty() || operation_id.len() > 128 {
        return Err("invalid operationId".into());
    }
    if let Some(plan) = plan_header(store, operation_id)? {
        let result = match plan.result.as_deref() {
            Some(encoded) => serde_json::from_str::<Value>(encoded)?,
            None => Value::Null,
        };
        return Ok(Some(json!({
            "state": plan.state,
            "requestHash": plan.request_hash,
            "result": result,
        })));
    }
    Ok(None)
}

pub fn resume_all(store: &mut Store, allowed_roots: &[PathBuf]) -> Result<()> {
    let operations = {
        let mut query = store.db.prepare(
            "SELECT operation_id FROM file_commit_plans
             WHERE state='prepared' ORDER BY created_at,operation_id LIMIT 201",
        )?;
        let ids = query
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ids
    };
    if operations.len() > 200 {
        return Err("prepared file commit budget exceeded; manual inspection required".into());
    }
    for operation_id in operations {
        resume_plan(store, &operation_id, allowed_roots)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count(db: &Connection, sql: &str) -> i64 {
        db.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn text(db: &Connection, sql: &str) -> String {
        db.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn open_project(dir: &Path) -> (Store, PathBuf, Vec<PathBuf>) {
        let root = dir.canonicalize().unwrap();
        let mut store = Store::open(&dir.join("pf.db")).unwrap();
        store
            .mutate(
                "store.createProject",
                &json!({
                    "operationId":"create","projectId":"p1","name":"test",
                    "root":root.to_str().unwrap()
                }),
            )
            .unwrap();
        (store, root.clone(), vec![root])
    }

    fn change(path: &str, before: Option<&str>, after: Option<&str>, op: &str) -> Change {
        Change {
            path: path.to_string(),
            before: before.map(|value| value.as_bytes().to_vec()),
            after: after.map(|value| value.as_bytes().to_vec()),
            op: op.to_string(),
            summary: None,
            todo_id: None,
        }
    }

    fn build_plan(root: &Path, changes: Vec<Change>) -> Plan {
        Plan {
            project_id: "p1".into(),
            root: root.to_path_buf(),
            kind: "edit".into(),
            reason: "multi-file commit recovery test".into(),
            maid: Some("Kerr".into()),
            changes,
            review: json!({"files":[],"syntaxRejected":false}),
        }
    }

    /// Replace + create + remove in one plan: the removal must run last.
    fn mixed_changes() -> Vec<Change> {
        vec![
            change("a.txt", Some("alpha\n"), Some("beta\n"), "edit"),
            change("b.txt", None, Some("new\n"), "create"),
            change("c.txt", Some("old\n"), None, "remove"),
        ]
    }

    #[test]
    fn multi_file_commit_writes_history_once_and_replay_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, root, roots) = open_project(dir.path());
        fs::write(root.join("a.txt"), b"alpha\n").unwrap();
        fs::write(root.join("c.txt"), b"old\n").unwrap();
        let request = digest(b"multi-file request");
        let first = commit(
            &mut store,
            "commit-1",
            &request,
            build_plan(&root, mixed_changes()),
            &roots,
        )
        .unwrap();
        assert_eq!(first["status"], "ok");
        assert_eq!(first["operationId"], "commit-1");
        assert_eq!(first["files"].as_array().unwrap().len(), 3);
        assert_eq!(first["nodeIds"].as_array().unwrap().len(), 3);
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"beta\n");
        assert_eq!(fs::read(root.join("b.txt")).unwrap(), b"new\n");
        assert!(!root.join("c.txt").exists());
        assert_eq!(count(&store.db, "SELECT COUNT(*) FROM batches"), 1);
        assert_eq!(count(&store.db, "SELECT COUNT(*) FROM nodes"), 3);
        assert_eq!(
            count(
                &store.db,
                "SELECT COUNT(*) FROM service_operations WHERE id='commit-1'"
            ),
            1
        );
        assert_eq!(
            count(
                &store.db,
                "SELECT COUNT(*) FROM file_commit_changes WHERE state='committed'"
            ),
            3
        );
        // Every target gets one file_state row; the removal keeps a NULL tombstone.
        assert_eq!(count(&store.db, "SELECT COUNT(*) FROM file_state"), 3);
        assert_eq!(
            count(&store.db, "SELECT COUNT(*) FROM file_state WHERE hash IS NULL"),
            1
        );
        assert_eq!(
            text(
                &store.db,
                "SELECT hash FROM file_state WHERE file_path='a.txt'"
            ),
            digest(b"beta\n")
        );

        // A restart must reuse the durable history instead of writing a new one.
        drop(store);
        let mut store = Store::open(&dir.path().join("pf.db")).unwrap();
        assert_eq!(
            text(
                &store.db,
                "SELECT state FROM file_commit_plans WHERE operation_id='commit-1'"
            ),
            "committed"
        );
        let replay = commit(
            &mut store,
            "commit-1",
            &request,
            build_plan(&root, mixed_changes()),
            &roots,
        )
        .unwrap();
        assert_eq!(replay, first);
        assert_eq!(count(&store.db, "SELECT COUNT(*) FROM batches"), 1);
        assert_eq!(count(&store.db, "SELECT COUNT(*) FROM nodes"), 3);
        assert_eq!(
            count(
                &store.db,
                "SELECT COUNT(*) FROM service_operations WHERE id='commit-1'"
            ),
            1
        );
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"beta\n");
        // Reusing the operationId for a different request must never commit silently.
        assert!(commit(
            &mut store,
            "commit-1",
            &digest(b"other request"),
            build_plan(&root, mixed_changes()),
            &roots
        )
        .is_err());
        resume_all(&mut store, &roots).unwrap();
        assert_eq!(count(&store.db, "SELECT COUNT(*) FROM batches"), 1);
        assert_eq!(
            count(
                &store.db,
                "SELECT COUNT(*) FROM file_commit_plans WHERE state='prepared'"
            ),
            0
        );
        let status = operation_status(&store, "commit-1").unwrap().unwrap();
        assert_eq!(status["state"], "committed");
        assert_eq!(status["result"], first);
    }

    #[test]
    fn partial_applied_plan_finishes_after_reopen_resume_all() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, root, roots) = open_project(dir.path());
        fs::write(root.join("a.txt"), b"alpha\n").unwrap();
        let plan = build_plan(
            &root,
            vec![
                change("a.txt", Some("alpha\n"), Some("beta\n"), "edit"),
                change("c.txt", None, Some("fresh\n"), "create"),
            ],
        );
        let prepared = normalize_changes(&plan, &root, &roots).unwrap();
        assert_eq!(prepared.len(), 2);
        let request = digest(b"partial request");
        claim(&mut store, "commit-partial", &request, &plan, &root, &prepared).unwrap();
        // The first target reached its planned image and was durably marked applied;
        // the process died before the second target was touched.
        fs::write(root.join("a.txt"), b"beta\n").unwrap();
        mark_applied(&mut store, "commit-partial", 1).unwrap();
        assert_eq!(
            text(
                &store.db,
                "SELECT state FROM file_commit_plans WHERE operation_id='commit-partial'"
            ),
            "prepared"
        );
        assert_eq!(
            count(
                &store.db,
                "SELECT COUNT(*) FROM file_commit_changes
                 WHERE operation_id='commit-partial' AND state='applied'"
            ),
            1
        );
        assert_eq!(
            text(
                &store.db,
                "SELECT state FROM file_commit_changes
                 WHERE operation_id='commit-partial' AND ordinal=2"
            ),
            "prepared"
        );
        assert!(!root.join("c.txt").exists());
        assert_eq!(count(&store.db, "SELECT COUNT(*) FROM batches"), 0);

        // Startup recovery must finish the plan from disk state alone.
        drop(store);
        let mut store = Store::open(&dir.path().join("pf.db")).unwrap();
        assert_eq!(
            count(
                &store.db,
                "SELECT COUNT(*) FROM file_commit_plans WHERE state='prepared'"
            ),
            1
        );
        assert_eq!(
            count(
                &store.db,
                "SELECT COUNT(*) FROM service_operations WHERE id='commit-partial'"
            ),
            0
        );
        resume_all(&mut store, &roots).unwrap();
        // Already-applied bytes stay untouched; only the pending create is executed.
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"beta\n");
        assert_eq!(fs::read(root.join("c.txt")).unwrap(), b"fresh\n");
        assert_eq!(
            text(
                &store.db,
                "SELECT state FROM file_commit_plans WHERE operation_id='commit-partial'"
            ),
            "committed"
        );
        assert_eq!(
            count(
                &store.db,
                "SELECT COUNT(*) FROM file_commit_changes
                 WHERE operation_id='commit-partial' AND state='committed'"
            ),
            2
        );
        assert_eq!(count(&store.db, "SELECT COUNT(*) FROM batches"), 1);
        assert_eq!(count(&store.db, "SELECT COUNT(*) FROM nodes"), 2);
        assert_eq!(
            count(
                &store.db,
                "SELECT COUNT(*) FROM service_operations WHERE id='commit-partial'"
            ),
            1
        );
        // Recovery is single-shot: a second pass must not duplicate history.
        resume_all(&mut store, &roots).unwrap();
        assert_eq!(count(&store.db, "SELECT COUNT(*) FROM batches"), 1);
        assert_eq!(count(&store.db, "SELECT COUNT(*) FROM nodes"), 2);
    }

    #[test]
    fn third_party_conflict_preserves_bytes_and_fabricates_no_history() {
        let dir = tempfile::tempdir().unwrap();
        let (mut store, root, roots) = open_project(dir.path());
        fs::write(root.join("a.txt"), b"alpha\n").unwrap();
        let request = digest(b"conflict request");
        let plan = build_plan(
            &root,
            vec![
                change("a.txt", Some("alpha\n"), Some("beta\n"), "edit"),
                change("d.txt", None, Some("created\n"), "create"),
            ],
        );
        let prepared = normalize_changes(&plan, &root, &roots).unwrap();
        claim(&mut store, "commit-conflict", &request, &plan, &root, &prepared).unwrap();
        // The first target was written and durably marked applied; then a third
        // party created the second target before recovery reached it.
        fs::write(root.join("a.txt"), b"beta\n").unwrap();
        mark_applied(&mut store, "commit-conflict", 1).unwrap();
        fs::write(root.join("d.txt"), b"external\n").unwrap();

        drop(store);
        let mut store = Store::open(&dir.path().join("pf.db")).unwrap();
        let message = resume_all(&mut store, &roots).unwrap_err().to_string();
        assert!(message.contains("conflict"), "{message}");
        // The third version is preserved, while the applied file is compensated
        // back to its before image.
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"alpha\n");
        assert_eq!(fs::read(root.join("d.txt")).unwrap(), b"external\n");
        assert_eq!(
            text(
                &store.db,
                "SELECT state FROM file_commit_plans WHERE operation_id='commit-conflict'"
            ),
            "conflict"
        );
        assert_eq!(
            count(
                &store.db,
                "SELECT COUNT(*) FROM file_commit_plans WHERE result IS NOT NULL"
            ),
            0
        );
        assert_eq!(count(&store.db, "SELECT COUNT(*) FROM batches"), 0);
        assert_eq!(count(&store.db, "SELECT COUNT(*) FROM nodes"), 0);
        assert_eq!(count(&store.db, "SELECT COUNT(*) FROM file_state"), 0);
        assert_eq!(
            count(
                &store.db,
                "SELECT COUNT(*) FROM service_operations WHERE id='commit-conflict'"
            ),
            0
        );
        assert_eq!(
            count(
                &store.db,
                "SELECT COUNT(*) FROM file_commit_changes
                 WHERE operation_id='commit-conflict' AND state='conflict'"
            ),
            2
        );
        assert_eq!(
            count(
                &store.db,
                "SELECT COUNT(*) FROM file_commit_changes
                 WHERE operation_id='commit-conflict' AND state IN ('prepared','applied')"
            ),
            0
        );
        let (before, after): (Option<String>, Option<String>) = store
            .db
            .query_row(
                "SELECT before_hash,after_hash FROM file_commit_changes
                 WHERE operation_id='commit-conflict' AND ordinal=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(before.as_deref(), Some(digest(b"alpha\n").as_str()));
        assert_eq!(after.as_deref(), Some(digest(b"beta\n").as_str()));
        let (before, after): (Option<String>, Option<String>) = store
            .db
            .query_row(
                "SELECT before_hash,after_hash FROM file_commit_changes
                 WHERE operation_id='commit-conflict' AND ordinal=2",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(before, None);
        assert_eq!(after.as_deref(), Some(digest(b"created\n").as_str()));
        let status = operation_status(&store, "commit-conflict").unwrap().unwrap();
        assert_eq!(status["state"], "conflict");
        assert_eq!(status["result"], json!(null));

        // Replaying the original request cannot turn a conflict into a commit.
        let replay = commit(
            &mut store,
            "commit-conflict",
            &request,
            build_plan(
                &root,
                vec![
                    change("a.txt", Some("alpha\n"), Some("beta\n"), "edit"),
                    change("d.txt", None, Some("created\n"), "create"),
                ],
            ),
            &roots,
        )
        .unwrap_err()
        .to_string();
        assert!(replay.contains("resource lock released"), "{replay}");
        assert_eq!(count(&store.db, "SELECT COUNT(*) FROM batches"), 0);
        assert_eq!(count(&store.db, "SELECT COUNT(*) FROM nodes"), 0);

        // Conflict state releases the path immediately: the same target can be
        // committed under a new operationId without any reconciliation step.
        let second = commit(
            &mut store,
            "commit-conflict-2",
            &digest(b"retry request"),
            build_plan(
                &root,
                vec![change("a.txt", Some("alpha\n"), Some("gamma\n"), "edit")],
            ),
            &roots,
        )
        .unwrap();
        assert_eq!(second["status"], "ok");
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"gamma\n");
        assert_eq!(fs::read(root.join("d.txt")).unwrap(), b"external\n");
        assert_eq!(count(&store.db, "SELECT COUNT(*) FROM batches"), 1);
        assert_eq!(count(&store.db, "SELECT COUNT(*) FROM nodes"), 1);
    }
}
