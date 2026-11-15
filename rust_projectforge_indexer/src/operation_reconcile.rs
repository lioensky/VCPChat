//! Explicit terminal disposition for durable single/multi-file commit conflicts.
//! Inspection is read-only. Reconciliation never writes file bytes and never
//! creates batch/node history; it only abandons unfinished intent records and
//! releases their resource locks after caller-supplied per-file hash checks.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::project_path;
use crate::storage::{Result, Store};

const MAX_FILES: usize = 200;
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn operation_id(params: &Value) -> Result<&str> {
    params
        .get("operationId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .ok_or_else(|| "operationId must be a nonempty string of at most 128 bytes".into())
}

#[derive(Clone)]
struct FileRecord {
    file_path: String,
    before_hash: Option<String>,
    after_hash: Option<String>,
    state: String,
    error: Option<String>,
}

struct OperationRecord {
    kind: &'static str,
    commit_kind: String,
    request_hash: String,
    project_id: String,
    root: String,
    state: String,
    result: Option<String>,
    error: Option<String>,
    files: Vec<FileRecord>,
}

fn load_single(store: &Store, id: &str) -> Result<Option<OperationRecord>> {
    let row: Option<(
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
    )> = store
        .db
        .query_row(
            "SELECT request_hash,project_id,root,file_path,before_hash,after_hash,state,result,error
             FROM file_commit_intents WHERE operation_id=?",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )
        .optional()?;
    Ok(row.map(
        |(request_hash, project_id, root, file_path, before_hash, after_hash, state, result, error)| {
            let files = vec![FileRecord {
                file_path,
                before_hash: Some(before_hash),
                after_hash: Some(after_hash),
                state: state.clone(),
                error: error.clone(),
            }];
            OperationRecord {
                kind: "single",
                commit_kind: "edit".into(),
                request_hash,
                project_id,
                root,
                state,
                result,
                error,
                files,
            }
        },
    ))
}

fn load_multi(store: &Store, id: &str) -> Result<Option<OperationRecord>> {
    let plan: Option<(String, String, String, String, String, Option<String>, Option<String>)> = store
        .db
        .query_row(
            "SELECT request_hash,project_id,root,kind,state,result,error
             FROM file_commit_plans WHERE operation_id=?",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let Some((request_hash, project_id, root, commit_kind, state, result, error)) = plan else {
        return Ok(None);
    };
    let mut statement = store.db.prepare(
        "SELECT file_path,before_hash,after_hash,state,error
         FROM file_commit_changes WHERE operation_id=? ORDER BY ordinal",
    )?;
    let files = statement
        .query_map([id], |row| {
            Ok(FileRecord {
                file_path: row.get(0)?,
                before_hash: row.get(1)?,
                after_hash: row.get(2)?,
                state: row.get(3)?,
                error: row.get(4)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(Some(OperationRecord {
        kind: "multi",
        commit_kind,
        request_hash,
        project_id,
        root,
        state,
        result,
        error,
        files,
    }))
}

fn load_operation(store: &Store, id: &str) -> Result<Option<OperationRecord>> {
    let single = load_single(store, id)?;
    let multi = load_multi(store, id)?;
    match (single, multi) {
        (None, None) => Ok(None),
        (Some(record), None) | (None, Some(record)) => Ok(Some(record)),
        (Some(_), Some(_)) => {
            Err("operation id is present in both single- and multi-file journals".into())
        }
    }
}

fn parse_reconciled(encoded: Option<&str>) -> Option<Value> {
    let value: Value = serde_json::from_str(encoded?).ok()?;
    if value.get("status").and_then(Value::as_str) == Some("reconciled") {
        Some(value)
    } else {
        None
    }
}

fn authorized_root(
    store: &Store,
    record: &OperationRecord,
    allowed_roots: &[PathBuf],
) -> Result<PathBuf> {
    let project: Option<(String, Option<String>)> = store
        .db
        .query_row(
            "SELECT root,deleted_at FROM projects WHERE id=?",
            [&record.project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (project_root, deleted) = project.ok_or("project missing")?;
    if deleted.is_some() {
        return Err("project is deleted; operation cannot be reconciled".into());
    }
    let expected = Path::new(&project_root).canonicalize()?;
    let stored = Path::new(&record.root).canonicalize()?;
    if expected != stored {
        return Err("operation root differs from the durable project root".into());
    }
    if !allowed_roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| expected.starts_with(root))
    {
        return Err("operation root is outside trusted allowed roots".into());
    }
    Ok(expected)
}

fn allowed_path(path: &project_path::ProjectPath, allowed_roots: &[PathBuf]) -> bool {
    allowed_roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| path.absolute.starts_with(root))
}

fn read_image(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.file_type().is_file() {
                return Err("target is not a regular file".into());
            }
            if meta.len() > MAX_IMAGE_BYTES {
                return Err("target exceeds inspection image budget".into());
            }
            Ok(Some(fs::read(path)?))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

struct InspectedFile {
    file_path: String,
    before_hash: Option<String>,
    after_hash: Option<String>,
    actual_hash: Option<String>,
    exists: bool,
    state: String,
    error: Option<String>,
    applied: bool,
    pending: bool,
}

fn position(file: &FileRecord, actual_hash: &Option<String>) -> (bool, bool) {
    let applied = match (&file.after_hash, actual_hash) {
        (Some(after), Some(current)) => after == current,
        (None, None) => file.before_hash.is_some(),
        _ => false,
    };
    let pending = match (&file.before_hash, actual_hash) {
        (Some(before), Some(current)) => before == current,
        (None, None) => file.after_hash.is_some(),
        _ => false,
    };
    (applied, pending)
}

fn inspect_files(
    store: &Store,
    record: &OperationRecord,
    allowed_roots: &[PathBuf],
) -> Result<(bool, Option<String>, Vec<InspectedFile>)> {
    let root = match authorized_root(store, record, allowed_roots) {
        Ok(root) => root,
        Err(error) => {
            let message = error.to_string();
            let files = record
                .files
                .iter()
                .map(|file| InspectedFile {
                    file_path: file.file_path.clone(),
                    before_hash: file.before_hash.clone(),
                    after_hash: file.after_hash.clone(),
                    actual_hash: None,
                    exists: false,
                    state: file.state.clone(),
                    error: Some(message.clone()),
                    applied: false,
                    pending: false,
                })
                .collect();
            return Ok((false, Some(message), files));
        }
    };
    let mut files = Vec::with_capacity(record.files.len());
    for file in &record.files {
        let resolved = project_path::resolve(&root, &file.file_path, true);
        let (actual_hash, exists, error) = match resolved {
            Ok(path) if allowed_path(&path, allowed_roots) => match read_image(&path.absolute) {
                Ok(bytes) => {
                    let actual = bytes.as_ref().map(|bytes| digest(bytes));
                    (actual.clone(), actual.is_some(), None)
                }
                Err(error) => (None, false, Some(error.to_string())),
            },
            Ok(_) => (
                None,
                false,
                Some("file is outside trusted allowed roots".into()),
            ),
            Err(error) => (None, false, Some(error.to_string())),
        };
        let (applied, pending) = if error.is_none() {
            position(file, &actual_hash)
        } else {
            (false, false)
        };
        files.push(InspectedFile {
            file_path: file.file_path.clone(),
            before_hash: file.before_hash.clone(),
            after_hash: file.after_hash.clone(),
            actual_hash,
            exists,
            state: file.state.clone(),
            error: error.or_else(|| file.error.clone()),
            applied,
            pending,
        });
    }
    Ok((true, None, files))
}

fn inspected_json(files: &[InspectedFile]) -> Vec<Value> {
    files
        .iter()
        .map(|file| {
            json!({
                "filePath": file.file_path,
                "beforeHash": file.before_hash,
                "afterHash": file.after_hash,
                "actualHash": file.actual_hash,
                "exists": file.exists,
                "state": file.state,
                "error": file.error,
                "applied": file.applied,
                "pending": file.pending,
            })
        })
        .collect()
}

fn expected_files(params: &Value) -> Result<Vec<(String, Option<String>)>> {
    let values = params
        .get("files")
        .and_then(Value::as_array)
        .ok_or("operation.reconcile requires a files array with filePath and expectedHash")?;
    if values.is_empty() || values.len() > MAX_FILES {
        return Err(format!("files must contain 1..={MAX_FILES} entries").into());
    }
    let mut seen = HashSet::new();
    let mut expected = Vec::with_capacity(values.len());
    for item in values {
        let object = item
            .as_object()
            .ok_or("each files entry must be an object with filePath and expectedHash")?;
        let file_path = object
            .get("filePath")
            .or_else(|| object.get("file_path"))
            .or_else(|| object.get("path"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .ok_or("each files entry requires a nonempty filePath")?;
        let raw = object
            .get("expectedHash")
            .or_else(|| object.get("expected_hash"))
            .ok_or("expectedHash is required for every file (null means the file is absent)")?;
        let expected_hash = match raw {
            Value::Null => None,
            Value::String(hash) if valid_hash(hash) => Some(hash.clone()),
            _ => {
                return Err(format!(
                    "expectedHash for {file_path} must be a lowercase sha256 or null"
                )
                .into())
            }
        };
        if !seen.insert(file_path.to_string()) {
            return Err(format!("duplicate filePath in files: {file_path}").into());
        }
        expected.push((file_path.to_string(), expected_hash));
    }
    Ok(expected)
}

pub fn inspect(store: &Store, params: &Value, allowed_roots: &[PathBuf]) -> Result<Value> {
    let id = operation_id(params)?;
    let Some(record) = load_operation(store, id)? else {
        let terminal: Option<(String, String)> = store
            .db
            .query_row(
                "SELECT request_hash,result FROM service_operations WHERE id=?",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((request_hash, result)) = terminal else {
            return Ok(json!({"operationId": id, "state": "unknown", "committed": false}));
        };
        let result: Value = serde_json::from_str(&result)?;
        let state = match result
            .get("state")
            .or_else(|| result.get("status"))
            .and_then(Value::as_str)
        {
            Some("planningRejected") => "planningRejected",
            Some("syntaxRejected") => "syntaxRejected",
            Some("reconciled") => "reconciled",
            _ => "committed",
        };
        return Ok(json!({
            "operationId": id,
            "state": state,
            "committed": state == "committed",
            "requestHash": request_hash,
            "result": result,
        }));
    };
    if let Some(result) = parse_reconciled(record.result.as_deref()) {
        return Ok(result);
    }
    if record.state == "committed" {
        let result = record
            .result
            .as_deref()
            .map(serde_json::from_str::<Value>)
            .transpose()?;
        return Ok(json!({
            "operationId": id,
            "state": "committed",
            "kind": record.kind,
            "commitKind": record.commit_kind,
            "projectId": record.project_id,
            "requestHash": record.request_hash,
            "committed": true,
            "result": result,
        }));
    }
    let (root_authorized, authorization_error, files) =
        inspect_files(store, &record, allowed_roots)?;
    Ok(json!({
        "operationId": id,
        "state": record.state,
        "kind": record.kind,
        "commitKind": record.commit_kind,
        "projectId": record.project_id,
        "requestHash": record.request_hash,
        "rootAuthorized": root_authorized,
        "authorizationError": authorization_error,
        "committed": false,
        "reconciled": false,
        "policy": "acceptCurrent",
        "files": inspected_json(&files),
        "intentError": record.error,
        "hint": "Inspection is read-only. To abandon this unfinished intent call operation.reconcile with policy=acceptCurrent and an explicit expectedHash for every file (null means absent). Reconciliation never writes file bytes and never creates batch/node history.",
    }))
}

pub fn reconcile(store: &mut Store, params: &Value, allowed_roots: &[PathBuf]) -> Result<Value> {
    let id = operation_id(params)?.to_string();
    let policy = params.get("policy").and_then(Value::as_str).unwrap_or("");
    if policy != "acceptCurrent" {
        return Err("operation.reconcile requires explicit policy=acceptCurrent".into());
    }
    let record = load_operation(store, &id)?
        .ok_or("operation not found; there is no durable intent to reconcile")?;
    if let Some(result) = parse_reconciled(record.result.as_deref()) {
        return Ok(result);
    }
    let expected = expected_files(params)?;
    if record.state == "committed" {
        return Err("operation is already committed; reconciliation is not allowed".into());
    }
    if record.state == "aborted" {
        return Err("operation has no unfinished intent to reconcile".into());
    }
    if record.files.is_empty() {
        return Err("operation has no durable file records to reconcile".into());
    }
    if record.files.len() > MAX_FILES {
        return Err("operation file budget exceeded; manual inspection required".into());
    }
    if expected.len() != record.files.len() {
        return Err(format!(
            "expectedHash must be supplied for every one of {} files",
            record.files.len()
        )
        .into());
    }
    for (file_path, _) in &expected {
        if !record.files.iter().any(|file| &file.file_path == file_path) {
            return Err(format!("unexpected filePath in reconciliation: {file_path}").into());
        }
    }
    for file in &record.files {
        if !expected.iter().any(|(file_path, _)| file_path == &file.file_path) {
            return Err(format!("missing expectedHash for {}", file.file_path).into());
        }
    }
    let root = authorized_root(store, &record, allowed_roots)?;
    let mut inspected = Vec::with_capacity(record.files.len());
    for file in &record.files {
        let expected_hash = expected
            .iter()
            .find(|(file_path, _)| file_path == &file.file_path)
            .map(|(_, hash)| hash.clone())
            .ok_or_else(|| format!("missing expectedHash for {}", file.file_path))?;
        let path = project_path::resolve(&root, &file.file_path, true)
            .map_err(|error| format!("invalid reconciliation path {}: {error}", file.file_path))?;
        if !allowed_path(&path, allowed_roots) {
            return Err(format!(
                "reconciliation path is outside trusted allowed roots: {}",
                file.file_path
            )
            .into());
        }
        let actual = read_image(&path.absolute)
            .map_err(|error| format!("cannot inspect {}: {error}", file.file_path))?;
        let actual_hash = actual.as_ref().map(|bytes| digest(bytes));
        if actual_hash != expected_hash {
            return Err(format!(
                "current hash does not match expectedHash for {}: expected {} actual {}",
                file.file_path,
                expected_hash.as_deref().unwrap_or("null"),
                actual_hash.as_deref().unwrap_or("null")
            )
            .into());
        }
        let (applied, pending) = position(file, &actual_hash);
        inspected.push(InspectedFile {
            file_path: file.file_path.clone(),
            before_hash: file.before_hash.clone(),
            after_hash: file.after_hash.clone(),
            actual_hash,
            exists: actual.is_some(),
            state: file.state.clone(),
            error: None,
            applied,
            pending,
        });
    }
    let applied_files = inspected
        .iter()
        .filter(|file| file.applied)
        .map(|file| file.file_path.clone())
        .collect::<Vec<_>>();
    let pending_files = inspected
        .iter()
        .filter(|file| file.pending)
        .map(|file| file.file_path.clone())
        .collect::<Vec<_>>();
    let tx = store
        .db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let ts: String = tx.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        [],
        |row| row.get(0),
    )?;
    let result = json!({
        "operationId": &id,
        "state": "reconciled",
        "status": "reconciled",
        "reconciled": true,
        "committed": false,
        "policy": "acceptCurrent",
        "kind": record.kind,
        "commitKind": &record.commit_kind,
        "projectId": &record.project_id,
        "requestHash": &record.request_hash,
        "files": inspected_json(&inspected),
        "appliedFiles": applied_files,
        "pendingFiles": pending_files,
        "intentAbandoned": true,
        "snapshotsRetained": true,
        "reconciledAt": &ts,
        "note": "Unfinished intent abandoned after caller-supplied per-file hashes matched the current disk. Current bytes were not overwritten and no batch/node/service_operations history was created; snapshots remain in the blob store.",
    });
    let encoded = serde_json::to_string(&result)?;
    match record.kind {
        "single" => {
            let updated = tx.execute(
                "UPDATE file_commit_intents SET state='aborted',result=?,error=NULL,updated_at=?
                 WHERE operation_id=? AND state IN ('prepared','conflict')",
                params![encoded, ts, id],
            )?;
            if updated != 1 {
                return Err("single-file intent state changed during reconciliation".into());
            }
        }
        "multi" => {
            let message =
                "reconciled by explicit acceptCurrent; unfinished intent abandoned; current bytes preserved";
            let updated = tx.execute(
                "UPDATE file_commit_plans SET state='conflict',result=?,error=?,updated_at=?
                 WHERE operation_id=? AND state IN ('prepared','conflict')",
                params![encoded, message, ts, id],
            )?;
            if updated != 1 {
                return Err("multi-file plan state changed during reconciliation".into());
            }
            // Resource locks are the partial unique index on active changes.
            // Rewriting each key to an operation-unique tombstone releases the
            // original path lock while keeping every durable change row/snapshot.
            let released = tx.execute(
                "UPDATE file_commit_changes
                 SET resource_key='reconciled:'||operation_id||':'||ordinal,error=?,updated_at=?
                 WHERE operation_id=?",
                params![message, ts, id],
            )?;
            if released != record.files.len() {
                return Err("multi-file change set changed during reconciliation".into());
            }
        }
        _ => return Err("unknown operation journal kind".into()),
    }
    tx.commit()?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_commit::{Change, Plan};

    fn setup() -> (tempfile::TempDir, Store, Vec<PathBuf>) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("pf.db")).unwrap();
        let roots = vec![dir.path().to_path_buf()];
        (dir, store, roots)
    }

    fn project(store: &mut Store, root: &Path) {
        store
            .mutate(
                "store.createProject",
                &json!({
                    "operationId": "create", "projectId": "p1", "name": "fixture",
                    "root": root.to_str().unwrap()
                }),
            )
            .unwrap();
    }

    /// Durable single-file intent whose target still holds the pre-edit image.
    fn prepare_single(
        store: &mut Store,
        root: &Path,
        roots: &[PathBuf],
        file: &str,
        operation: &str,
    ) -> crate::edit_pipeline::ReadyEdit {
        let steps: Vec<crate::edit::Step> = serde_json::from_value(json!([
            {"step":1,"op":"target","target":"before","replace":"after"}
        ]))
        .unwrap();
        let crate::edit_pipeline::Preparation::Ready(ready) =
            crate::edit_pipeline::prepare(root, file, roots, &steps, false).unwrap()
        else {
            panic!("fixture must plan a ready edit")
        };
        let request = format!("{:x}", Sha256::digest(operation.as_bytes()));
        store
            .prepare_intent(operation, &request, "p1", &ready, "fixture", None)
            .unwrap();
        ready
    }

    fn count(store: &Store, sql: &str) -> i64 {
        store.db.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn intent_row(store: &Store, operation: &str) -> (String, Option<String>, Option<String>) {
        store
            .db
            .query_row(
                "SELECT state,result,error FROM file_commit_intents WHERE operation_id=?",
                [operation],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
    }

    #[test]
    fn inspect_is_read_only_and_keeps_the_resource_locked() {
        let (dir, mut store, roots) = setup();
        let root = dir.path();
        project(&mut store, root);
        fs::write(root.join("a.txt"), b"before\n").unwrap();
        let ready = prepare_single(&mut store, root, &roots, "a.txt", "edit");
        let blobs_before = count(&store, "SELECT COUNT(*) FROM blobs");
        let writes_before = store.db.total_changes();

        let inspected = inspect(&store, &json!({"operationId":"edit"}), &roots).unwrap();

        // Inspection is strictly read-only: no row, blob or state is touched.
        assert_eq!(
            store.db.total_changes(),
            writes_before,
            "inspection must not write"
        );
        assert_eq!(count(&store, "SELECT COUNT(*) FROM blobs"), blobs_before);
        assert_eq!(inspected["state"], "prepared");
        assert_eq!(inspected["kind"], "single");
        assert_eq!(inspected["committed"], false);
        assert_eq!(inspected["reconciled"], false);
        assert_eq!(inspected["rootAuthorized"], true);
        assert_eq!(inspected["policy"], "acceptCurrent");
        let files = inspected["files"].as_array().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["filePath"], "a.txt");
        assert_eq!(files[0]["exists"], true);
        assert_eq!(files[0]["beforeHash"], digest(b"before\n"));
        assert_eq!(files[0]["actualHash"], digest(b"before\n"));
        assert_eq!(files[0]["pending"], true);
        assert_eq!(files[0]["applied"], false);
        // The durable intent stays prepared with no result and no error.
        assert_eq!(
            intent_row(&store, "edit"),
            ("prepared".to_string(), None, None)
        );
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"before\n");
        // The pending intent still owns the path: nothing released the lock.
        let second = format!("{:x}", Sha256::digest(b"second"));
        assert!(store
            .prepare_intent("second", &second, "p1", &ready, "lock probe", None)
            .is_err());
        assert_eq!(ready.path.relative, "a.txt");
    }

    #[test]
    fn reconcile_rejects_missing_policy_hash_or_drifted_bytes() {
        let (dir, mut store, roots) = setup();
        let root = dir.path();
        project(&mut store, root);
        fs::write(root.join("a.txt"), b"before\n").unwrap();
        let ready = prepare_single(&mut store, root, &roots, "a.txt", "edit");
        let writes_before = store.db.total_changes();

        let missing_policy =
            reconcile(&mut store, &json!({"operationId":"edit"}), &roots).unwrap_err();
        assert!(
            missing_policy.to_string().contains("policy=acceptCurrent"),
            "{missing_policy}"
        );

        let missing_files = reconcile(
            &mut store,
            &json!({"operationId":"edit","policy":"acceptCurrent"}),
            &roots,
        )
        .unwrap_err();
        assert!(
            missing_files.to_string().contains("files array"),
            "{missing_files}"
        );

        let missing_hash = reconcile(
            &mut store,
            &json!({
                "operationId":"edit","policy":"acceptCurrent",
                "files":[{"filePath":"a.txt"}]
            }),
            &roots,
        )
        .unwrap_err();
        assert!(
            missing_hash.to_string().contains("expectedHash is required"),
            "{missing_hash}"
        );

        // A hash for a version that is not on disk is refused outright.
        let drifted = reconcile(
            &mut store,
            &json!({
                "operationId":"edit","policy":"acceptCurrent",
                "files":[{"filePath":"a.txt","expectedHash": digest(b"third-party\n")}]
            }),
            &roots,
        )
        .unwrap_err();
        assert!(
            drifted.to_string().contains("does not match expectedHash"),
            "{drifted}"
        );

        // The correct hash with no trusted root still cannot authorize anything.
        let unauthorized = reconcile(
            &mut store,
            &json!({
                "operationId":"edit","policy":"acceptCurrent",
                "files":[{"filePath":"a.txt","expectedHash": digest(b"before\n")}]
            }),
            &[],
        )
        .unwrap_err();
        assert!(
            unauthorized
                .to_string()
                .contains("outside trusted allowed roots"),
            "{unauthorized}"
        );

        // Every rejection happened before any write, lock release or byte change.
        assert_eq!(store.db.total_changes(), writes_before);
        assert_eq!(
            intent_row(&store, "edit"),
            ("prepared".to_string(), None, None)
        );
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"before\n");
        let second = format!("{:x}", Sha256::digest(b"second"));
        assert!(store
            .prepare_intent("second", &second, "p1", &ready, "lock probe", None)
            .is_err());
    }

    #[test]
    fn accept_current_reconciles_idempotently_and_retains_audit_until_purge() {
        let (dir, mut store, roots) = setup();
        let root = dir.path();
        project(&mut store, root);
        fs::write(root.join("b.txt"), b"original\n").unwrap();
        fs::write(root.join("a.txt"), b"original\n").unwrap();
        // Third-party bytes land on a.txt between planning and applying.
        fs::write(root.join("a.txt"), b"third-party\n").unwrap();
        let change = |path: &str| Change {
            path: path.into(),
            before: Some(b"original\n".to_vec()),
            after: Some(b"planned\n".to_vec()),
            op: "edit".into(),
            summary: None,
            todo_id: None,
        };
        let plan = Plan {
            project_id: "p1".into(),
            root: root.to_path_buf(),
            kind: "edit".into(),
            reason: "multi-file conflict fixture".into(),
            maid: None,
            changes: vec![change("b.txt"), change("a.txt")],
            review: json!({"summary":"fixture"}),
        };
        let request = format!("{:x}", Sha256::digest(b"multi-request"));
        assert!(
            crate::file_commit::commit(&mut store, "multi", &request, plan, &roots).is_err(),
            "drifted bytes must never be overwritten by a multi-file commit"
        );
        // b.txt was applied; a.txt kept its third-party image.
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"third-party\n");
        assert_eq!(fs::read(root.join("b.txt")).unwrap(), b"planned\n");
        assert_eq!(
            count(
                &store,
                "SELECT COUNT(*) FROM file_commit_plans WHERE state='conflict'"
            ),
            1
        );

        let inspected = inspect(&store, &json!({"operationId":"multi"}), &roots).unwrap();
        assert_eq!(inspected["state"], "conflict");
        assert_eq!(inspected["committed"], false);
        assert_eq!(inspected["rootAuthorized"], true);
        let by_path: std::collections::HashMap<String, Value> = inspected["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| {
                (
                    file["filePath"].as_str().unwrap().to_string(),
                    file.clone(),
                )
            })
            .collect();
        assert_eq!(by_path.len(), 2);
        assert_eq!(by_path["a.txt"]["actualHash"], digest(b"third-party\n"));
        assert_eq!(by_path["a.txt"]["applied"], false);
        assert_eq!(by_path["a.txt"]["pending"], false);
        assert_eq!(by_path["b.txt"]["actualHash"], digest(b"planned\n"));
        assert_eq!(by_path["b.txt"]["applied"], true);

        // A stale hash is refused before any state or lock change.
        let refused = reconcile(
            &mut store,
            &json!({
                "operationId":"multi","policy":"acceptCurrent",
                "files":[
                    {"filePath":"a.txt","expectedHash": digest(b"original\n")},
                    {"filePath":"b.txt","expectedHash": digest(b"planned\n")}
                ]
            }),
            &roots,
        )
        .unwrap_err();
        assert!(
            refused.to_string().contains("does not match expectedHash"),
            "{refused}"
        );
        assert_eq!(
            count(
                &store,
                "SELECT COUNT(*) FROM file_commit_changes
                 WHERE state IN ('prepared','applied','conflict')"
            ),
            2
        );
        // The unfinished plan keeps both path locks, so re-planning is refused.
        let premature = crate::file_commit::commit(
            &mut store,
            "premature-reuse",
            &format!("{:x}", Sha256::digest(b"premature")),
            Plan {
                project_id: "p1".into(),
                root: root.to_path_buf(),
                kind: "edit".into(),
                reason: "lock probe".into(),
                maid: None,
                changes: vec![Change {
                    path: "a.txt".into(),
                    before: Some(b"third-party\n".to_vec()),
                    after: Some(b"must not land\n".to_vec()),
                    op: "edit".into(),
                    summary: None,
                    todo_id: None,
                }],
                review: json!({"summary":"lock probe"}),
            },
            &roots,
        );
        assert!(premature.is_err(), "an unresolved conflict owns its path");
        assert_eq!(count(&store, "SELECT COUNT(*) FROM file_commit_plans"), 1);
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"third-party\n");

        let reconciled = reconcile(
            &mut store,
            &json!({
                "operationId":"multi","policy":"acceptCurrent",
                "files":[
                    {"filePath":"a.txt","expectedHash": digest(b"third-party\n")},
                    {"filePath":"b.txt","expectedHash": digest(b"planned\n")}
                ]
            }),
            &roots,
        )
        .unwrap();
        assert_eq!(reconciled["state"], "reconciled");
        assert_eq!(reconciled["status"], "reconciled");
        assert_eq!(reconciled["committed"], false);
        assert_eq!(reconciled["reconciled"], true);
        assert_eq!(reconciled["intentAbandoned"], true);
        assert_eq!(reconciled["snapshotsRetained"], true);
        assert_eq!(reconciled["appliedFiles"], json!(["b.txt"]));
        assert_eq!(reconciled["pendingFiles"], json!([]));
        // Reconciliation never writes file bytes.
        assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"third-party\n");
        assert_eq!(fs::read(root.join("b.txt")).unwrap(), b"planned\n");
        // No batch/node/service_operations history was fabricated for this operation.
        assert_eq!(
            count(
                &store,
                "SELECT COUNT(*) FROM service_operations WHERE id='multi'"
            ),
            0
        );
        assert_eq!(count(&store, "SELECT COUNT(*) FROM nodes"), 0);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM batches"), 0);
        // Audit rows and snapshots survive; only the active-lock keys are rewritten.
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM file_commit_changes"),
            2
        );
        assert_eq!(
            count(
                &store,
                "SELECT COUNT(*) FROM file_commit_changes
                 WHERE resource_key LIKE 'reconciled:multi:%'"
            ),
            2
        );
        assert!(count(&store, "SELECT COUNT(*) FROM blobs") > 0);
        let audit_blobs = count(&store, "SELECT COUNT(*) FROM blobs");

        // Replay is idempotent and returns the durable result.
        let replay = reconcile(
            &mut store,
            &json!({"operationId":"multi","policy":"acceptCurrent"}),
            &roots,
        )
        .unwrap();
        assert_eq!(replay, reconciled);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM blobs"), audit_blobs);

        // The path locks are released: the same file can be planned again.
        crate::file_commit::commit(
            &mut store,
            "after-reconcile",
            &format!("{:x}", Sha256::digest(b"after")),
            Plan {
                project_id: "p1".into(),
                root: root.to_path_buf(),
                kind: "edit".into(),
                reason: "post-reconcile lock release probe".into(),
                maid: None,
                changes: vec![Change {
                    path: "a.txt".into(),
                    before: Some(b"third-party\n".to_vec()),
                    after: Some(b"after reconcile\n".to_vec()),
                    op: "edit".into(),
                    summary: None,
                    todo_id: None,
                }],
                review: json!({"summary":"after reconcile"}),
            },
            &roots,
        )
        .unwrap();
        assert_eq!(
            fs::read(root.join("a.txt")).unwrap(),
            b"after reconcile\n"
        );

        // The reconciled disposition is durable across a real reopen.
        let reconciled_at = reconciled["reconciledAt"].as_str().unwrap().to_string();
        drop(store);
        let mut store = Store::open(&dir.path().join("pf.db")).unwrap();
        let reread = inspect(&store, &json!({"operationId":"multi"}), &roots).unwrap();
        assert_eq!(reread, reconciled);
        assert_eq!(reread["reconciledAt"], reconciled_at.as_str());
        // The abandoned intent keeps both change rows; the later probe added its own.
        assert_eq!(
            count(
                &store,
                "SELECT COUNT(*) FROM file_commit_changes WHERE operation_id='multi'"
            ),
            2
        );

        // Only an explicit purge frees the retained audit rows and snapshots.
        let purged = store
            .mutate(
                "store.purgeProjects",
                &json!({"operationId":"purge","ids":["p1"]}),
            )
            .unwrap();
        assert_eq!(purged["purged"], json!(["p1"]));
        assert!(
            purged["freedBlobs"].as_i64().unwrap() > 0,
            "purge must reclaim the retained snapshots: {purged}"
        );
        assert_eq!(count(&store, "SELECT COUNT(*) FROM file_commit_plans"), 0);
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM file_commit_changes"),
            0
        );
        assert_eq!(count(&store, "SELECT COUNT(*) FROM blobs"), 0);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM nodes"), 0);
        // Purging history never touches disk bytes.
        assert_eq!(
            fs::read(root.join("a.txt")).unwrap(),
            b"after reconcile\n"
        );
        assert_eq!(fs::read(root.join("b.txt")).unwrap(), b"planned\n");
    }

    #[test]
    fn accept_current_reconciles_single_intent_across_restart_and_releases_path() {
        let (dir, mut store, roots) = setup();
        let root = dir.path();
        project(&mut store, root);
        fs::write(root.join("single.txt"), b"before\n").unwrap();
        prepare_single(&mut store, root, &roots, "single.txt", "single-edit");
        fs::write(root.join("single.txt"), b"third-party\n").unwrap();
        let blobs_before = count(&store, "SELECT COUNT(*) FROM blobs");

        let reconciled = reconcile(
            &mut store,
            &json!({
                "operationId":"single-edit","policy":"acceptCurrent",
                "files":[{
                    "filePath":"single.txt",
                    "expectedHash": digest(b"third-party\n")
                }]
            }),
            &roots,
        )
        .unwrap();
        assert_eq!(reconciled["state"], "reconciled");
        assert_eq!(reconciled["kind"], "single");
        assert_eq!(reconciled["committed"], false);
        assert_eq!(reconciled["intentAbandoned"], true);
        assert_eq!(fs::read(root.join("single.txt")).unwrap(), b"third-party\n");
        let (state, encoded, error) = intent_row(&store, "single-edit");
        assert_eq!(state, "aborted");
        assert_eq!(error, None);
        assert_eq!(serde_json::from_str::<Value>(encoded.as_deref().unwrap()).unwrap(), reconciled);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM batches"), 0);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM nodes"), 0);
        assert_eq!(
            count(
                &store,
                "SELECT COUNT(*) FROM service_operations WHERE id='single-edit'"
            ),
            0
        );
        assert_eq!(count(&store, "SELECT COUNT(*) FROM blobs"), blobs_before);

        // Replays return the durable disposition without requiring the file list again.
        assert_eq!(
            reconcile(
                &mut store,
                &json!({"operationId":"single-edit","policy":"acceptCurrent"}),
                &roots,
            )
            .unwrap(),
            reconciled
        );
        drop(store);

        let mut store = Store::open(&dir.path().join("pf.db")).unwrap();
        assert_eq!(
            inspect(&store, &json!({"operationId":"single-edit"}), &roots).unwrap(),
            reconciled
        );
        assert_eq!(fs::read(root.join("single.txt")).unwrap(), b"third-party\n");
        assert_eq!(intent_row(&store, "single-edit").0, "aborted");

        // Aborting the old intent releases its partial-unique resource lock.
        let steps: Vec<crate::edit::Step> = serde_json::from_value(json!([
            {"step":1,"op":"target","target":"third-party","replace":"next"}
        ]))
        .unwrap();
        let crate::edit_pipeline::Preparation::Ready(next) =
            crate::edit_pipeline::prepare(root, "single.txt", &roots, &steps, false).unwrap()
        else {
            panic!("post-reconcile edit must plan")
        };
        store
            .prepare_intent(
                "single-next",
                &digest(b"single-next"),
                "p1",
                &next,
                "path lock release probe",
                None,
            )
            .unwrap();
        assert_eq!(intent_row(&store, "single-next").0, "prepared");
        assert_eq!(count(&store, "SELECT COUNT(*) FROM file_commit_intents"), 2);
        assert_eq!(fs::read(root.join("single.txt")).unwrap(), b"third-party\n");
    }
}
