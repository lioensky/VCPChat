//! Native `file.execute` planning for the remaining ProjectForge file commands.
//! This module never writes file bytes itself: every mutation is expressed as a
//! file_commit::Plan/Change and the durable commit/recovery owner applies it.

use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    edit::{self, Action, Position, Step},
    file_commit::{self, Change, Plan},
    lang::Lang,
    project_path::{self, ProjectPath},
    storage::{Result, Store},
    symbol_address::{self, Selection},
    text_snapshot::{PreparedTextEdit, TextSnapshot, MAX_EDIT_BYTES},
    validation_process::ValidatorProcess,
};

const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_TERMINAL_RESULT_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_DRIFT: usize = 20;

fn reject_default() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    operation_id: String,
    project_id: String,
    kind: String,
    reason: String,
    #[serde(default)]
    maid: Option<String>,
    #[serde(default, alias = "todoId")]
    todo: Option<Value>,
    #[serde(default)]
    file_path: Option<String>,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    overwrite: bool,
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    to: Option<String>,
    #[serde(default)]
    block: Option<BlockSpec>,
    #[serde(default)]
    after: Option<Value>,
    #[serde(default)]
    before: Option<Value>,
    #[serde(default)]
    indent: Option<Value>,
    #[serde(default)]
    create: bool,
    #[serde(default)]
    batch: Option<Value>,
    #[serde(default)]
    to_node: Option<i64>,
    #[serde(default)]
    node_id: Option<i64>,
    #[serde(default)]
    force: bool,
    #[serde(default)]
    dry_run: bool,
    #[serde(default = "reject_default")]
    reject_new_syntax: bool,
    #[serde(default)]
    expected_hash: Option<String>,
    // GUI parity for revertFile. The normalized public contract uses nodeId and
    // defaults to the pre-change image when no mode is supplied.
    #[serde(default)]
    mode: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlockSpec {
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    start: Option<Value>,
    #[serde(default)]
    end: Option<Value>,
    #[serde(default)]
    lines: Option<String>,
    #[serde(default)]
    symbol: Option<String>,
    #[serde(default)]
    range: Option<String>,
    #[serde(default)]
    line: Option<usize>,
    #[serde(default)]
    pick: Option<usize>,
    #[serde(default)]
    expect: Option<String>,
}

#[derive(Debug)]
struct TextReview {
    path: String,
    before: String,
    after: String,
}

#[derive(Debug)]
struct ConflictPreview {
    path: String,
    reasons: Vec<String>,
}

#[derive(Debug)]
struct Build {
    changes: Vec<Change>,
    text_reviews: Vec<TextReview>,
    conflicts: Vec<ConflictPreview>,
}

#[derive(Debug)]
enum BuildOutcome {
    Ready(Build),
    PlanningRejected {
        file_path: String,
        message: String,
        candidates: Vec<Value>,
    },
    PrecheckConflict {
        file_path: String,
        reason: String,
    },
}

#[derive(Debug)]
struct RestoreItem {
    change: Change,
    conflicts: Vec<String>,
    text_review: Option<TextReview>,
    precheck_conflict: Option<String>,
}

#[derive(Debug)]
struct BatchFile {
    target: Option<String>,
    expected: Option<String>,
    last_node: i64,
}

#[derive(Debug)]
struct BlockLineRange {
    start: usize,
    end: usize,
}

#[derive(Debug)]
enum BlockResolution {
    Found(BlockLineRange),
    Ambiguous {
        message: String,
        candidates: Vec<Value>,
    },
}

#[derive(Debug)]
struct InsertTarget {
    position: Position,
    before_side: bool,
    after_line: usize,
}

#[derive(Debug)]
enum InsertResolution {
    Found(InsertTarget),
    Ambiguous {
        message: String,
        candidates: Vec<Value>,
    },
}

enum StatusAction {
    Done(Value),
    Resume,
    Continue,
}

pub async fn execute(
    store: &mut Store,
    params: &Value,
    allowed_roots: &[PathBuf],
    validator: &ValidatorProcess,
) -> Result<Value> {
    let request: Request = serde_json::from_value(params.clone())?;
    validate_request(&request)?;
    let request_hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&json!({
            "method": "file.execute",
            "params": params,
        }))?)
    );

    // A file.commit intent owns the operation first. Never replan a prepared or
    // terminal operation; resume only from its persisted bytes and review.
    if let Some(status) = file_commit::operation_status(store, &request.operation_id)? {
        match inspect_status(&status, &request_hash)? {
            StatusAction::Done(result) => return Ok(result),
            StatusAction::Resume => {
                // file_commit::operation_status also falls back to the legacy
                // single-file intent table. Resume that intent in its own owner;
                // resume_all only knows multi-file file_commit_plans.
                let legacy = store.query(
                    "operation.status",
                    &json!({"operationId": request.operation_id}),
                )?;
                if legacy.get("state").and_then(Value::as_str) == Some("prepared") {
                    if legacy.get("requestHash").and_then(Value::as_str)
                        != Some(request_hash.as_str())
                    {
                        return Err("operationId reused with different request".into());
                    }
                    let intent = store.load_intent(&request.operation_id)?;
                    return crate::commit_coordinator::resume(store, &intent, allowed_roots);
                }
                file_commit::resume_all(store, allowed_roots)?;
                let recovered = file_commit::operation_status(store, &request.operation_id)?
                    .ok_or("prepared file operation disappeared after recovery")?;
                return match inspect_status(&recovered, &request_hash)? {
                    StatusAction::Done(result) => Ok(result),
                    StatusAction::Resume => {
                        Err("file operation remains prepared after recovery".into())
                    }
                    StatusAction::Continue => {
                        Err("file operation lost its durable status during recovery".into())
                    }
                };
            }
            StatusAction::Continue => {}
        }
    }

    // Legacy native edit operations used the same service_operations namespace.
    let legacy = store.query(
        "operation.status",
        &json!({"operationId": request.operation_id}),
    )?;
    match inspect_status(&legacy, &request_hash)? {
        StatusAction::Done(result) => return Ok(result),
        StatusAction::Resume => {
            let intent = store.load_intent(&request.operation_id)?;
            return crate::commit_coordinator::resume(store, &intent, allowed_roots);
        }
        StatusAction::Continue => {}
    }

    let project = store.query(
        "store.getProject",
        &json!({"projectId": request.project_id}),
    )?;
    let root_text = project["root"]
        .as_str()
        .ok_or("project missing or invalid root")?;
    if !project["deleted_at"].is_null() {
        return Err("project is deleted".into());
    }
    let root = Path::new(root_text).canonicalize()?;
    ensure_writable_root(&root, allowed_roots)?;
    let todo_id = verify_todo_binding(store, &request)?;
    let expected_precheck = if request.kind == "revertFile" {
        parse_expected_precheck(params)?
    } else {
        None
    };

    let built = build_plan(store, &request, &root, todo_id, expected_precheck)?;
    let build = match built {
        BuildOutcome::PrecheckConflict { file_path, reason } => {
            return Ok(json!({
                "operationId": request.operation_id,
                "status": "conflict",
                "conflicts": [{
                    "filePath": file_path,
                    "reasons": [reason],
                }],
            }));
        }
        BuildOutcome::PlanningRejected {
            file_path,
            message,
            candidates,
        } => {
            let result = json!({
                "operationId": request.operation_id,
                "state": "planningRejected",
                "status": "planningRejected",
                "filePath": file_path,
                "message": message,
                "candidates": candidates,
            });
            if request.dry_run {
                return Ok(result);
            }
            return persist_terminal_result(
                store,
                &request.operation_id,
                &request.project_id,
                &request_hash,
                result,
            );
        }
        BuildOutcome::Ready(build) => build,
    };

    if build.changes.is_empty() {
        if request.dry_run {
            return Ok(json!({
                "operationId": request.operation_id,
                "status": "unchanged",
                "files": [],
                "review": {"files": [], "syntaxRejected": false},
            }));
        }
        let plan = Plan {
            project_id: request.project_id.clone(),
            root,
            kind: plan_kind(&request.kind).to_string(),
            reason: request.reason.clone(),
            maid: request.maid.clone(),
            changes: Vec::new(),
            review: json!({"files": [], "syntaxRejected": false}),
        };
        return file_commit::commit(
            store,
            &request.operation_id,
            &request_hash,
            plan,
            allowed_roots,
        );
    }

    let change_preview = preview_changes(&build.changes);
    let conflict_preview = preview_conflicts(&build.conflicts);

    if !build.conflicts.is_empty() && !request.force {
        return Ok(json!({
            "operationId": request.operation_id,
            "status": "conflict",
            "changes": change_preview,
            "conflicts": conflict_preview,
        }));
    }
    if request.dry_run {
        return Ok(json!({
            "operationId": request.operation_id,
            "status": "dryRun",
            "changes": change_preview,
            "conflicts": conflict_preview,
            "review": {"files": [], "syntaxRejected": false, "skipped": "dryRun"},
        }));
    }

    let (review, syntax_rejected) =
        review_build(&build, validator, request.reject_new_syntax).await?;
    if syntax_rejected {
        let result = json!({
            "operationId": request.operation_id,
            "state": "syntaxRejected",
            "status": "syntaxRejected",
            "filePath": build.text_reviews.first().map(|item| item.path.clone()),
            "review": review,
        });
        return persist_terminal_result(
            store,
            &request.operation_id,
            &request.project_id,
            &request_hash,
            result,
        );
    }

    let plan = Plan {
        project_id: request.project_id.clone(),
        root,
        kind: plan_kind(&request.kind).to_string(),
        reason: request.reason.clone(),
        maid: request.maid.clone(),
        changes: build.changes,
        review,
    };
    ensure_target_parents(&plan.changes, &plan.root, allowed_roots)?;
    file_commit::commit(
        store,
        &request.operation_id,
        &request_hash,
        plan,
        allowed_roots,
    )
}

fn ensure_target_parents(
    changes: &[Change],
    root: &Path,
    allowed_roots: &[PathBuf],
) -> Result<()> {
    for change in changes {
        if change.before.is_some() || change.after.is_none() {
            continue;
        }
        let target = project_path::resolve(root, &change.path, true)?;
        let parent = target
            .absolute
            .parent()
            .ok_or("create target has no parent directory")?;
        if !parent.starts_with(&target.root)
            || !allowed_roots.iter().any(|allowed| {
                allowed
                    .canonicalize()
                    .is_ok_and(|allowed| parent.starts_with(allowed))
            })
        {
            return Err("create parent is outside trusted writable roots".into());
        }
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn validate_request(request: &Request) -> Result<()> {
    let token = |value: &str, max: usize| {
        !value.is_empty()
            && value.len() <= max
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
            })
    };
    if !token(&request.operation_id, 128)
        || !token(&request.project_id, 64)
        || request.reason.trim().is_empty()
        || request.reason.len() > 2000
        || !matches!(
            request.kind.as_str(),
            "create"
                | "remove"
                | "move"
                | "moveCode"
                | "copyCode"
                | "rollback"
                | "revertFile"
        )
    {
        return Err("invalid file.execute identity, kind or reason".into());
    }
    if let Some(maid) = &request.maid {
        if maid.trim().is_empty() || maid.len() > 128 {
            return Err("invalid maid signature".into());
        }
    }
    if request.after.is_some() && request.before.is_some() {
        return Err("file.execute accepts only one of after or before".into());
    }
    if let Some(content) = &request.content {
        if content.len() > MAX_EDIT_BYTES {
            return Err("file content exceeds edit budget".into());
        }
    }
    for path in request
        .file_path
        .iter()
        .chain(request.paths.iter())
        .chain(request.from.iter())
        .chain(request.to.iter())
    {
        if path.is_empty() || path.len() > 4096 || path.contains('\0') {
            return Err("invalid file path".into());
        }
    }
    if request
        .expected_hash
        .as_deref()
        .is_some_and(|hash| !valid_sha256(hash))
    {
        return Err("invalid expectedHash".into());
    }
    if !matches!(
        request.mode.as_deref().unwrap_or("before"),
        "before" | "after"
    ) {
        return Err("revertFile mode must be before or after".into());
    }
    Ok(())
}

fn plan_kind(kind: &str) -> &str {
    match kind {
        "moveCode" | "copyCode" => "edit",
        "revertFile" => "rollback",
        other => other,
    }
}

fn ensure_writable_root(root: &Path, allowed_roots: &[PathBuf]) -> Result<()> {
    let allowed = allowed_roots.iter().any(|allowed| {
        allowed
            .canonicalize()
            .is_ok_and(|allowed| root.starts_with(allowed))
    });
    if !allowed {
        return Err("project is not inside an enabled writable root".into());
    }
    Ok(())
}

fn verify_todo_binding(store: &Store, request: &Request) -> Result<Option<i64>> {
    let sequences = crate::todo_refs::parse(request.todo.as_ref())?;
    let mut primary = None;
    for seq in sequences {
        let todo = store.query(
            "store.getTodoBySeq",
            &json!({"projectId": request.project_id, "seq": seq}),
        )?;
        let id = todo["id"]
            .as_i64()
            .filter(|id| *id > 0)
            .ok_or("referenced todo does not exist in this project")?;
        if primary.is_none() {
            primary = Some(id);
        }
    }
    Ok(primary)
}

fn inspect_status(status: &Value, request_hash: &str) -> Result<StatusAction> {
    let state = status
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if state == "unknown" {
        return Ok(StatusAction::Continue);
    }
    let stored_hash = status
        .get("requestHash")
        .and_then(Value::as_str)
        .ok_or("operation status is missing its request hash")?;
    if stored_hash != request_hash {
        return Err("operationId reused with different request".into());
    }
    match state {
        "committed" | "ok" | "unchanged" | "planningRejected" | "syntaxRejected" => {
            let result = status_result(status)
                .ok_or("terminal operation status is missing its result")?;
            Ok(StatusAction::Done(result))
        }
        "prepared" => Ok(StatusAction::Resume),
        "conflict" => Err(
            "operation ended in conflict (before snapshot preserved, resource lock released); retry with a new operationId"
                .into(),
        ),
        other => Err(format!(
            "operation has an unrecognized state; refusing to replan ({other})"
        )
        .into()),
    }
}

fn status_result(status: &Value) -> Option<Value> {
    match status.get("result") {
        Some(Value::String(encoded)) => serde_json::from_str(encoded).ok(),
        Some(Value::Null) | None => None,
        Some(value) => Some(value.clone()),
    }
}

fn persist_terminal_result(
    store: &mut Store,
    operation_id: &str,
    project_id: &str,
    request_hash: &str,
    result: Value,
) -> Result<Value> {
    let encoded = serde_json::to_string(&result)?;
    if encoded.len() > MAX_TERMINAL_RESULT_BYTES {
        return Err("terminal result budget exceeded".into());
    }
    let tx = store
        .db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let active: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL)",
        [project_id],
        |row| row.get(0),
    )?;
    if !active {
        return Err("project missing or deleted".into());
    }
    let occupied: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM service_operations WHERE id=?
         UNION ALL SELECT 1 FROM file_commit_intents WHERE operation_id=?
         UNION ALL SELECT 1 FROM file_commit_plans WHERE operation_id=?)",
        rusqlite::params![operation_id, operation_id, operation_id],
        |row| row.get(0),
    )?;
    if occupied {
        return Err("operation already exists; query status".into());
    }
    tx.execute(
        "INSERT INTO service_operations(id,request_hash,result,created_at)
         VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        rusqlite::params![operation_id, request_hash, encoded],
    )?;
    tx.commit()?;
    Ok(result)
}

fn build_plan(
    store: &Store,
    request: &Request,
    root: &Path,
    todo_id: Option<i64>,
    expected_precheck: Option<Option<String>>,
) -> Result<BuildOutcome> {
    match request.kind.as_str() {
        "create" => Ok(BuildOutcome::Ready(build_create(
            request, root, todo_id,
        )?)),
        "remove" => Ok(BuildOutcome::Ready(build_remove(
            request, root, todo_id,
        )?)),
        "move" => Ok(BuildOutcome::Ready(build_move(
            request, root, todo_id,
        )?)),
        "moveCode" | "copyCode" => build_transfer(request, root, todo_id),
        "rollback" | "revertFile" => {
            build_rollback(store, request, root, todo_id, expected_precheck)
        }
        _ => Err("unsupported file.execute kind".into()),
    }
}

fn build_create(request: &Request, root: &Path, todo_id: Option<i64>) -> Result<Build> {
    let input = request
        .file_path
        .as_deref()
        .ok_or("create requires filePath")?;
    let target = project_path::resolve(root, input, true)?;
    let before = read_existing(&target.absolute)?;
    if before.is_some() && !request.overwrite {
        return Err("file already exists; pass overwrite=true to replace it".into());
    }
    let content = request.content.as_deref().unwrap_or("");
    let normalized = normalize_eol(content);
    let (after, before_text) = match before.as_ref() {
        Some(bytes) => match TextSnapshot::decode(bytes.clone()) {
            Ok(snapshot) => (snapshot.encode(&normalized)?, Some(snapshot.text)),
            Err(_) => (content.as_bytes().to_vec(), None),
        },
        None => (content.as_bytes().to_vec(), Some(String::new())),
    };
    if before.as_ref().is_some_and(|old| old == &after) {
        return Ok(Build {
            changes: Vec::new(),
            text_reviews: Vec::new(),
            conflicts: Vec::new(),
        });
    }
    let existed = before.is_some();
    let op = if existed { "edit" } else { "create" };
    let summary = if existed { "整体覆盖" } else { "新建文件" };
    let text_reviews = before_text
        .map(|before| {
            vec![TextReview {
                path: target.relative.clone(),
                before,
                after: normalized,
            }]
        })
        .unwrap_or_default();
    Ok(Build {
        changes: vec![Change {
            path: target.relative,
            before,
            after: Some(after),
            op: op.into(),
            summary: Some(summary.into()),
            todo_id,
        }],
        text_reviews,
        conflicts: Vec::new(),
    })
}

fn build_remove(request: &Request, root: &Path, todo_id: Option<i64>) -> Result<Build> {
    let mut inputs = Vec::<&str>::new();
    if let Some(path) = request.file_path.as_deref() {
        inputs.push(path);
    }
    inputs.extend(request.paths.iter().map(String::as_str));
    if inputs.is_empty() {
        return Err("remove requires filePath or paths".into());
    }
    let mut seen = HashSet::new();
    let mut changes = Vec::new();
    for input in inputs {
        let target = project_path::resolve(root, input, true)?;
        if !seen.insert(target.relative.clone()) {
            continue;
        }
        let Some(before) = read_existing(&target.absolute)? else {
            // Legacy RemoveFile continued past missing entries and removed the rest.
            continue;
        };
        changes.push(Change {
            path: target.relative,
            before: Some(before),
            after: None,
            op: "delete".into(),
            summary: Some("移除文件".into()),
            todo_id,
        });
    }
    Ok(Build {
        changes,
        text_reviews: Vec::new(),
        conflicts: Vec::new(),
    })
}

fn build_move(request: &Request, root: &Path, todo_id: Option<i64>) -> Result<Build> {
    let from = request.from.as_deref().ok_or("move requires from")?;
    let to = request.to.as_deref().ok_or("move requires to")?;
    let source = project_path::resolve(root, from, false)?;
    let target = project_path::resolve(root, to, true)?;
    if source.relative == target.relative {
        return Err("move source and target are the same file".into());
    }
    let source_bytes = read_existing(&source.absolute)?
        .ok_or("move source does not exist or is not a regular file")?;
    let target_before = read_existing(&target.absolute)?;
    if target_before.is_some() && !request.force {
        return Err("move target already exists; refusing to overwrite without force=true".into());
    }
    // Destination is planned before source deletion so a crash cannot lose the
    // only copy when the commit owner applies changes in plan order.
    let changes = vec![
        Change {
            path: target.relative.clone(),
            before: target_before,
            after: Some(source_bytes.clone()),
            op: "move".into(),
            summary: Some(format!("← {}", source.relative)),
            todo_id,
        },
        Change {
            path: source.relative,
            before: Some(source_bytes),
            after: None,
            op: "move".into(),
            summary: Some(format!("→ {}", target.relative)),
            todo_id,
        },
    ];
    Ok(Build {
        changes,
        text_reviews: Vec::new(),
        conflicts: Vec::new(),
    })
}

fn build_transfer(
    request: &Request,
    root: &Path,
    todo_id: Option<i64>,
) -> Result<BuildOutcome> {
    let is_move = request.kind == "moveCode";
    let from_raw = request
        .from
        .as_deref()
        .ok_or("moveCode/copyCode requires from")?;
    let (from_path, from_symbol, from_range) = parse_source_ref(from_raw)?;
    let source = project_path::resolve(root, &from_path, false)?;
    let source_snapshot = TextSnapshot::read(&source.absolute).map_err(|error| {
        format!(
            "moveCode/copyCode source must be an editable text file ({}): {error}",
            source.relative
        )
    })?;
    let target = match request.to.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(to) => project_path::resolve(root, to, true)?,
        None => project_path::resolve(root, &source.relative, true)?,
    };
    let same_file = target.relative == source.relative;
    let target_before = if same_file {
        None
    } else {
        read_existing(&target.absolute)?
    };
    if !same_file && target_before.is_none() && !request.create {
        return Err("code transfer target is missing; pass create=true to create it".into());
    }
    let target_snapshot = if same_file {
        None
    } else {
        match target_before.as_ref() {
            Some(bytes) => Some(TextSnapshot::decode(bytes.clone()).map_err(|error| {
                format!(
                    "code transfer target must be editable text ({}): {error}",
                    target.relative
                )
            })?),
            None => None,
        }
    };
    let target_exists = same_file || target_snapshot.is_some();
    let target_text = if same_file {
        source_snapshot.text.as_str()
    } else {
        target_snapshot
            .as_ref()
            .map(|snapshot| snapshot.text.as_str())
            .unwrap_or("")
    };
    let block = request.block.clone().unwrap_or_default();
    let resolution = resolve_source_block(
        &source,
        &source_snapshot,
        &block,
        from_symbol.as_deref(),
        from_range.as_deref(),
    )?;
    let range = match resolution {
        BlockResolution::Found(range) => range,
        BlockResolution::Ambiguous {
            message,
            candidates,
        } => {
            return Ok(BuildOutcome::PlanningRejected {
                file_path: source.relative,
                message,
                candidates,
            });
        }
    };
    let block_text = source_block_text(&source_snapshot.text, range.start, range.end)?;

    let mut after = request.after.clone();
    let before = request.before.clone();
    if !target_exists && before.is_none() && after.is_none() {
        after = Some(json!(0));
    }
    if before.is_none() && after.is_none() {
        return Err("moveCode/copyCode requires after or before at the destination".into());
    }
    let before_side = before.is_some();
    let raw_point = before.as_ref().or(after.as_ref()).expect("position checked");
    let target_line_count = source_lines(target_text).len();
    let insert = match resolve_insert_target(
        target_text,
        &target.relative,
        raw_point,
        before_side,
        target_exists,
        target_line_count,
    )? {
        InsertResolution::Found(target) => target,
        InsertResolution::Ambiguous {
            message,
            candidates,
        } => {
            return Ok(BuildOutcome::PlanningRejected {
                file_path: target.relative,
                message,
                candidates,
            });
        }
    };
    if same_file && is_move && insert.after_line >= range.start && insert.after_line < range.end {
        return Err("moveCode destination lies inside the source block".into());
    }

    let ref_indent = if target_exists {
        auto_indent(
            target_text,
            insert.after_line,
            if same_file && is_move {
                Some((range.start, range.end))
            } else {
                None
            },
        )
    } else {
        String::new()
    };
    let shifted = shift_indent(&block_text, request.indent.as_ref(), &ref_indent)?;
    let indent_note = if shifted != block_text { " · 缩进已调整" } else { "" };

    if same_file {
        let mut steps = Vec::new();
        if is_move {
            steps.push(Step {
                step: 1,
                reason: None,
                expect: None,
                drift: DEFAULT_DRIFT,
                action: Action::Delete {
                    start: range.start,
                    end: range.end,
                },
            });
            steps.push(insert_step(2, &insert, shifted));
        } else {
            steps.push(insert_step(1, &insert, shifted));
        }
        let prepared = prepared_edit(
            &source_snapshot,
            &steps,
            false,
            "code transfer planning",
        )?;
        if prepared.bytes == source_snapshot.original {
            return Ok(BuildOutcome::Ready(Build {
                changes: Vec::new(),
                text_reviews: Vec::new(),
                conflicts: Vec::new(),
            }));
        }
        let after_text = TextSnapshot::decode(prepared.bytes.clone())?.text;
        return Ok(BuildOutcome::Ready(Build {
            changes: vec![Change {
                path: source.relative.clone(),
                before: Some(source_snapshot.original.clone()),
                after: Some(prepared.bytes),
                op: "edit".into(),
                summary: Some(format!(
                    "{} L{}-{} → L{}{indent_note}",
                    if is_move { "剪切" } else { "复制" },
                    range.start,
                    range.end,
                    insert.after_line.saturating_add(1)
                )),
                todo_id,
            }],
            text_reviews: vec![TextReview {
                path: source.relative,
                before: source_snapshot.text,
                after: after_text,
            }],
            conflicts: Vec::new(),
        }));
    }

    let destination_op = if target_exists { "edit" } else { "create" };
    let destination_change = if let Some(snapshot) = target_snapshot.as_ref() {
        let step = insert_step(1, &insert, shifted);
        let prepared = prepared_edit(snapshot, &[step], false, "destination code insertion")?;
        (prepared.bytes, snapshot.text.clone())
    } else {
        (shifted.into_bytes(), String::new())
    };
    let destination_after_text =
        TextSnapshot::decode(destination_change.0.clone())?.text;
    let mut changes = vec![Change {
        path: target.relative.clone(),
        before: target_before,
        after: Some(destination_change.0),
        op: destination_op.into(),
        summary: Some(format!(
            "{} ← {} L{}-{}{indent_note}",
            if is_move { "移入" } else { "复制" },
            source.relative,
            range.start,
            range.end
        )),
        todo_id,
    }];
    let mut text_reviews = vec![TextReview {
        path: target.relative,
        before: destination_change.1,
        after: destination_after_text,
    }];
    if is_move {
        let step = Step {
            step: 1,
            reason: None,
            expect: None,
            drift: DEFAULT_DRIFT,
            action: Action::Delete {
                start: range.start,
                end: range.end,
            },
        };
        let prepared = prepared_edit(&source_snapshot, &[step], false, "source code deletion")?;
        let source_after_text = TextSnapshot::decode(prepared.bytes.clone())?.text;
        changes.push(Change {
            path: source.relative.clone(),
            before: Some(source_snapshot.original.clone()),
            after: Some(prepared.bytes),
            op: "edit".into(),
            summary: Some(format!(
                "剪切 L{}-{} → {}",
                range.start, range.end, source.relative
            )),
            todo_id,
        });
        text_reviews.push(TextReview {
            path: source.relative,
            before: source_snapshot.text,
            after: source_after_text,
        });
    }
    Ok(BuildOutcome::Ready(Build {
        changes,
        text_reviews,
        conflicts: Vec::new(),
    }))
}

fn insert_step(step: usize, insert: &InsertTarget, content: String) -> Step {
    let (after, before) = if insert.before_side {
        (None, Some(insert.position.clone()))
    } else {
        (Some(insert.position.clone()), None)
    };
    Step {
        step,
        reason: None,
        expect: None,
        drift: DEFAULT_DRIFT,
        action: Action::Insert {
            after,
            before,
            content,
            pick: None,
            line: None,
        },
    }
}

fn build_rollback(
    store: &Store,
    request: &Request,
    root: &Path,
    todo_id: Option<i64>,
    expected_precheck: Option<Option<String>>,
) -> Result<BuildOutcome> {
    if request.kind == "revertFile" {
        return build_revert_file(store, request, root, todo_id, expected_precheck);
    }
    match (request.batch.as_ref(), request.to_node.or(request.node_id)) {
        (Some(_), Some(_)) => Err("rollback accepts batch or toNode/nodeId, not both".into()),
        (Some(_), _) => Ok(BuildOutcome::Ready(build_batch_rollback(
            store, request, root, todo_id,
        )?)),
        (None, Some(node_id)) => Ok(BuildOutcome::Ready(build_to_node_rollback(
            store, request, root, node_id, todo_id,
        )?)),
        (None, None) => Ok(BuildOutcome::Ready(build_batch_rollback(
            store, request, root, todo_id,
        )?)),
    }
}

fn build_batch_rollback(
    store: &Store,
    request: &Request,
    root: &Path,
    todo_id: Option<i64>,
) -> Result<Build> {
    let batch_id = batch_id(store, request)?;
    let batch = store.query(
        "store.getBatch",
        &json!({"projectId": request.project_id, "batchId": batch_id}),
    )?;
    if batch.is_null() {
        return Err(format!("batch b{batch_id} does not exist").into());
    }
    let nodes = store.query(
        "store.getBatchNodes",
        &json!({"projectId": request.project_id, "batchId": batch_id}),
    )?;
    let nodes = nodes.as_array().ok_or("invalid batch node response")?;
    if nodes.is_empty() {
        return Err(format!("batch b{batch_id} has no file nodes").into());
    }
    let filter = request
        .file_path
        .as_deref()
        .map(|path| project_path::resolve(root, path, true))
        .transpose()?
        .map(|path| path.relative);

    let mut files: BTreeMap<String, BatchFile> = BTreeMap::new();
    for node in nodes {
        let path = node["file_path"]
            .as_str()
            .ok_or("batch node is missing file_path")?
            .to_string();
        if filter.as_ref().is_some_and(|filter| filter != &path) {
            continue;
        }
        let before = node["before_hash"].as_str().map(str::to_string);
        let after = node["after_hash"].as_str().map(str::to_string);
        let node_id = node["id"].as_i64().ok_or("batch node is missing id")?;
        let entry = files.entry(path).or_insert_with(|| BatchFile {
            target: before,
            expected: after.clone(),
            last_node: node_id,
        });
        entry.expected = after;
        entry.last_node = node_id;
    }
    if files.is_empty() {
        return Ok(Build {
            changes: Vec::new(),
            text_reviews: Vec::new(),
            conflicts: Vec::new(),
        });
    }

    let batch_reason = batch["reason"].as_str().unwrap_or("");
    let label = format!("回退批次 b{batch_id}（{batch_reason}）");
    let mut changes = Vec::new();
    let mut text_reviews = Vec::new();
    let mut conflicts = Vec::new();
    for (path, file) in files {
        let later = store.query(
            "store.nodesAfter",
            &json!({
                "projectId": request.project_id,
                "nodeId": file.last_node,
                "filePath": path,
            }),
        )?;
        let later = later.as_array().map(Vec::len).unwrap_or(0);
        let expected = recorded_file_state(store, &request.project_id, &path)?
            .or(file.expected);
        if let Some(item) = restore_item(
            store,
            root,
            &path,
            file.target,
            expected,
            None,
            later,
            todo_id,
            &label,
        )? {
            if !item.conflicts.is_empty() {
                conflicts.push(ConflictPreview {
                    path: item.change.path.clone(),
                    reasons: item.conflicts,
                });
            }
            changes.push(item.change);
            if let Some(review) = item.text_review {
                text_reviews.push(review);
            }
        }
    }
    Ok(Build {
        changes,
        text_reviews,
        conflicts,
    })
}

fn build_to_node_rollback(
    store: &Store,
    request: &Request,
    root: &Path,
    node_id: i64,
    todo_id: Option<i64>,
) -> Result<Build> {
    if node_id <= 0 {
        return Err("toNode must be a positive node id".into());
    }
    let node = store.query(
        "store.getNode",
        &json!({"projectId": request.project_id, "nodeId": node_id}),
    )?;
    if node.is_null() {
        return Err(format!("node n{node_id} does not exist").into());
    }
    let files = if let Some(path) = request.file_path.as_deref() {
        vec![project_path::resolve(root, path, true)?.relative]
    } else {
        let later = store.query(
            "store.nodesAfter",
            &json!({"projectId": request.project_id, "nodeId": node_id}),
        )?;
        let later = later.as_array().ok_or("invalid node-after response")?;
        let mut files = Vec::new();
        let mut seen = HashSet::new();
        for node in later {
            if let Some(path) = node["file_path"].as_str() {
                if seen.insert(path.to_string()) {
                    files.push(path.to_string());
                }
            }
        }
        files
    };
    let mut changes = Vec::new();
    let mut text_reviews = Vec::new();
    let mut conflicts = Vec::new();
    for path in files {
        let target = store.query(
            "store.fileHashAt",
            &json!({
                "projectId": request.project_id,
                "filePath": path,
                "nodeId": node_id,
            }),
        )?;
        let target = if target["known"].as_bool().unwrap_or(false) {
            target["hash"].as_str().map(str::to_string)
        } else {
            None
        };
        let expected = recorded_file_state(store, &request.project_id, &path)?;
        let label = format!("恢复到节点 n{node_id} · {path}");
        if let Some(item) = restore_item(
            store,
            root,
            &path,
            target,
            expected,
            None,
            0,
            todo_id,
            &label,
        )? {
            if !item.conflicts.is_empty() {
                conflicts.push(ConflictPreview {
                    path: item.change.path.clone(),
                    reasons: item.conflicts,
                });
            }
            changes.push(item.change);
            if let Some(review) = item.text_review {
                text_reviews.push(review);
            }
        }
    }
    Ok(Build {
        changes,
        text_reviews,
        conflicts,
    })
}

fn build_revert_file(
    store: &Store,
    request: &Request,
    root: &Path,
    todo_id: Option<i64>,
    expected_precheck: Option<Option<String>>,
) -> Result<BuildOutcome> {
    let node_id = request.node_id.ok_or("revertFile requires nodeId")?;
    if node_id <= 0 {
        return Err("revertFile nodeId must be positive".into());
    }
    let node = store.query(
        "store.getNode",
        &json!({"projectId": request.project_id, "nodeId": node_id}),
    )?;
    if node.is_null() {
        return Err(format!("node n{node_id} does not exist").into());
    }
    let path = node["file_path"]
        .as_str()
        .ok_or("node is missing file_path")?;
    if let Some(input) = request.file_path.as_deref() {
        let resolved = project_path::resolve(root, input, true)?;
        if resolved.relative != path {
            return Err("revertFile filePath does not match the node file".into());
        }
    }
    let use_after = request.mode.as_deref() == Some("after");
    let target = if use_after {
        node["after_hash"].as_str().map(str::to_string)
    } else {
        node["before_hash"].as_str().map(str::to_string)
    };
    let expected = recorded_file_state(store, &request.project_id, path)?;
    let later = store.query(
        "store.nodesAfter",
        &json!({
            "projectId": request.project_id,
            "nodeId": node_id,
            "filePath": path,
        }),
    )?;
    let later = later.as_array().map(Vec::len).unwrap_or(0);
    let label = format!(
        "{}节点 n{node_id} · {}（GUI 人工回退）",
        if use_after { "恢复到" } else { "撤销" },
        path
    );
    let mut build = Build {
        changes: Vec::new(),
        text_reviews: Vec::new(),
        conflicts: Vec::new(),
    };
    if let Some(item) = restore_item(
        store,
        root,
        path,
        target,
        expected,
        expected_precheck
            .as_ref()
            .map(|expected| expected.as_deref()),
        later,
        todo_id,
        &label,
    )? {
        if let Some(reason) = item.precheck_conflict {
            return Ok(BuildOutcome::PrecheckConflict {
                file_path: item.change.path.clone(),
                reason,
            });
        }
        if !item.conflicts.is_empty() {
            build.conflicts.push(ConflictPreview {
                path: item.change.path.clone(),
                reasons: item.conflicts,
            });
        }
        build.changes.push(item.change);
        if let Some(review) = item.text_review {
            build.text_reviews.push(review);
        }
    }
    Ok(BuildOutcome::Ready(build))
}

fn batch_id(store: &Store, request: &Request) -> Result<i64> {
    match request.batch.as_ref() {
        None => last_batch_id(store, &request.project_id),
        Some(Value::String(raw)) if raw.trim().eq_ignore_ascii_case("last") => {
            last_batch_id(store, &request.project_id)
        }
        Some(value) => parse_positive_id(value, "batch"),
    }
}

fn last_batch_id(store: &Store, project_id: &str) -> Result<i64> {
    let batch = store.query("store.lastBatch", &json!({"projectId": project_id}))?;
    batch["id"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or("no batch is available to roll back".into())
}

fn recorded_file_state(store: &Store, project_id: &str, path: &str) -> Result<Option<String>> {
    let state = store.query(
        "store.getFileState",
        &json!({"projectId": project_id, "filePath": path}),
    )?;
    Ok(if state["known"].as_bool().unwrap_or(false) {
        state["hash"].as_str().map(str::to_string)
    } else {
        None
    })
}

fn restore_item(
    store: &Store,
    root: &Path,
    path: &str,
    target_hash: Option<String>,
    expected_hash: Option<String>,
    precheck_expected: Option<Option<&str>>,
    later: usize,
    todo_id: Option<i64>,
    label: &str,
) -> Result<Option<RestoreItem>> {
    let resolved = project_path::resolve(root, path, true)?;
    let current = read_existing(&resolved.absolute)?;
    let current_hash = current.as_ref().map(|bytes| digest(bytes));
    if current_hash.as_deref() == target_hash.as_deref() {
        return Ok(None);
    }
    let precheck_conflict = match precheck_expected {
        Some(expected) if current_hash.as_deref() != expected => Some(format!(
            "file changed since precheck; expected {}, found {}",
            expected.unwrap_or("missing"),
            current_hash.as_deref().unwrap_or("missing")
        )),
        _ => None,
    };
    let target_bytes = match target_hash.as_deref() {
        Some(hash) => Some(load_blob(store, hash)?),
        None => None,
    };
    let mut conflicts = Vec::new();
    if current_hash.as_deref() != expected_hash.as_deref() {
        conflicts.push("disk content differs from recorded file state (external change)".into());
    }
    if later > 0 {
        conflicts.push(format!("{later} later node(s) still touch this file"));
    }
    let text_review = match (current.as_ref(), target_bytes.as_ref()) {
        (Some(before_bytes), Some(after_bytes)) => {
            match (
                TextSnapshot::decode(before_bytes.clone()),
                TextSnapshot::decode(after_bytes.clone()),
            ) {
                (Ok(before), Ok(after)) => Some(TextReview {
                    path: resolved.relative.clone(),
                    before: before.text,
                    after: after.text,
                }),
                _ => None,
            }
        }
        (None, Some(after_bytes)) => TextSnapshot::decode(after_bytes.clone())
            .ok()
            .map(|after| TextReview {
                path: resolved.relative.clone(),
                before: String::new(),
                after: after.text,
            }),
        _ => None,
    };
    Ok(Some(RestoreItem {
        change: Change {
            path: resolved.relative,
            before: current,
            after: target_bytes,
            op: "rollback".into(),
            summary: Some(label.to_string()),
            todo_id,
        },
        conflicts,
        text_review,
        precheck_conflict,
    }))
}

fn resolve_source_block(
    source: &ProjectPath,
    snapshot: &TextSnapshot,
    block: &BlockSpec,
    from_symbol: Option<&str>,
    from_range: Option<&str>,
) -> Result<BlockResolution> {
    let line_count = source_lines(&snapshot.text).len();
    if line_count == 0 {
        return Err(format!("source file is empty: {}", source.relative).into());
    }
    if let Some(reference) = block.symbol.as_deref().or(from_symbol) {
        let lang = Lang::from_path(Path::new(&source.relative))
            .ok_or("source symbol block language is not supported by native AST")?;
        let mut parser = tree_sitter::Parser::new();
        let outline = crate::symbols::outline(lang, &snapshot.text, &mut parser)?;
        if outline.has_error {
            return Err("symbol block requires a syntactically valid source snapshot".into());
        }
        match symbol_address::select(&outline.symbols, reference, block.pick, block.line)? {
            Selection::Found(index) => {
                let body = block.range.as_deref() == Some("body");
                let (start, end) = symbol_address::range(
                    &outline.symbols[index],
                    body,
                    0,
                    outline.line_count,
                )?;
                let (start, end) =
                    validate_line_selection(snapshot, start, end, block.expect.as_deref())?;
                Ok(BlockResolution::Found(BlockLineRange { start, end }))
            }
            Selection::Ambiguous(hits) => Ok(BlockResolution::Ambiguous {
                message: "source block symbol is ambiguous; provide block.pick".into(),
                candidates: hits
                    .iter()
                    .enumerate()
                    .map(|(index, &symbol)| {
                        json!({
                            "index": index + 1,
                            "startLine": outline.symbols[symbol].full_start,
                            "endLine": outline.symbols[symbol].end,
                            "symbol": outline.symbols[symbol].qualified,
                        })
                    })
                    .collect(),
            }),
            Selection::NotFound => Err(format!(
                "source block symbol not found in {}: {reference}",
                source.relative
            )
            .into()),
        }
    } else if let Some(target) = block.target.as_deref() {
        let step = Step {
            step: 1,
            reason: None,
            expect: None,
            drift: DEFAULT_DRIFT,
            action: Action::Target {
                target: target.to_string(),
                replace: String::new(),
                pick: block.pick.into_iter().collect(),
                all: false,
                line: block.line,
            },
        };
        let outcome = edit::run(&snapshot.text, &[step], false)?;
        if outcome.status == "ambiguous" {
            let candidates = outcome
                .ambiguities
                .first()
                .and_then(|ambiguity| serde_json::to_value(&ambiguity.candidates).ok())
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default();
            return Ok(BlockResolution::Ambiguous {
                message: "source block target is ambiguous; provide block.pick".into(),
                candidates,
            });
        }
        if outcome.status != "ok" {
            return Err(format!(
                "source block target could not be located: {}",
                issue_messages(&outcome)
            )
            .into());
        }
        let placement = outcome
            .placements
            .first()
            .ok_or("source block target produced no placement")?;
        Ok(BlockResolution::Found(BlockLineRange {
            start: placement.original_start_line,
            end: placement.original_end_line,
        }))
    } else {
        let (start, end) = if let Some(raw) = block.lines.as_deref().or(from_range) {
            parse_line_range(raw)?
        } else if let Some(start) = block.start.as_ref() {
            let start = parse_usize_value(start, "block.start")?;
            let end = match block.end.as_ref() {
                Some(value) => parse_usize_value(value, "block.end")?,
                None => start,
            };
            (start, end)
        } else {
            return Err("code transfer requires block.symbol/target/lines/start or from=file:M-N".into());
        };
        let (start, end) =
            validate_line_selection(snapshot, start, end, block.expect.as_deref())?;
        Ok(BlockResolution::Found(BlockLineRange { start, end }))
    }
}

fn validate_line_selection(
    snapshot: &TextSnapshot,
    start: usize,
    end: usize,
    expect: Option<&str>,
) -> std::result::Result<(usize, usize), String> {
    if start == 0 || start > end || end > source_lines(&snapshot.text).len() {
        return Err("source block line range is outside the snapshot".into());
    }
    let step = Step {
        step: 1,
        reason: None,
        expect: expect.map(str::to_string),
        drift: DEFAULT_DRIFT,
        action: Action::Replace {
            start,
            end,
            content: String::new(),
        },
    };
    let outcome = edit::run(&snapshot.text, &[step], false)?;
    if outcome.status != "ok" {
        return Err(format!(
            "source block anchoring failed: {}",
            issue_messages(&outcome)
        ));
    }
    let placement = outcome
        .placements
        .first()
        .ok_or("source block produced no placement")?;
    Ok((placement.original_start_line, placement.original_end_line))
}

fn resolve_insert_target(
    target_text: &str,
    target_path: &str,
    raw: &Value,
    before_side: bool,
    target_exists: bool,
    line_count: usize,
) -> Result<InsertResolution> {
    if let Some(number) = value_as_usize(raw) {
        if before_side {
            if number == 0 || number > line_count.saturating_add(1) {
                return Err("before insertion point is outside the target file".into());
            }
            return Ok(InsertResolution::Found(InsertTarget {
                position: Position::Line(number),
                before_side,
                after_line: number - 1,
            }));
        }
        if number > line_count {
            return Err("after insertion point is outside the target file".into());
        }
        return Ok(InsertResolution::Found(InsertTarget {
            position: Position::Line(number),
            before_side,
            after_line: number,
        }));
    }
    let raw = raw
        .as_str()
        .ok_or("insertion point must be a number, end or symbol:...")?;
    if raw.eq_ignore_ascii_case("end") || raw.eq_ignore_ascii_case("eof") || raw == "$" {
        return Ok(InsertResolution::Found(InsertTarget {
            position: Position::Address("end".into()),
            before_side,
            after_line: line_count,
        }));
    }
    if !raw
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("symbol:"))
    {
        return Err("insertion point must be a number, end or symbol:...".into());
    }
    if !target_exists {
        return Err("cannot resolve a symbol insertion point in a missing target file".into());
    }
    let lang = Lang::from_path(Path::new(target_path))
        .ok_or("destination symbol insertion requires native AST language support")?;
    let mut parser = tree_sitter::Parser::new();
    let outline = crate::symbols::outline(lang, target_text, &mut parser)?;
    if outline.has_error {
        return Err("destination symbol insertion requires a syntactically valid target".into());
    }
    match symbol_address::select(&outline.symbols, raw, None, None)? {
        Selection::Found(index) => {
            let symbol = &outline.symbols[index];
            if before_side {
                Ok(InsertResolution::Found(InsertTarget {
                    position: Position::Line(symbol.full_start),
                    before_side,
                    after_line: symbol.full_start.saturating_sub(1),
                }))
            } else {
                Ok(InsertResolution::Found(InsertTarget {
                    position: Position::Line(symbol.end),
                    before_side,
                    after_line: symbol.end,
                }))
            }
        }
        Selection::Ambiguous(hits) => Ok(InsertResolution::Ambiguous {
            message: "destination insertion symbol is ambiguous; use after=N or before=N".into(),
            candidates: hits
                .iter()
                .enumerate()
                .map(|(index, &symbol)| {
                    json!({
                        "index": index + 1,
                        "startLine": outline.symbols[symbol].full_start,
                        "endLine": outline.symbols[symbol].end,
                        "symbol": outline.symbols[symbol].qualified,
                    })
                })
                .collect(),
        }),
        Selection::NotFound => Err("destination insertion symbol was not found".into()),
    }
}

fn prepared_edit(
    snapshot: &TextSnapshot,
    steps: &[Step],
    best_effort: bool,
    context: &str,
) -> Result<PreparedTextEdit> {
    match snapshot.prepare(steps, best_effort)? {
        Ok(prepared) => Ok(prepared),
        Err(outcome) => {
            let detail = issue_messages(&outcome);
            Err(format!(
                "{context}: {}",
                if detail.is_empty() {
                    "planning rejected".to_string()
                } else {
                    detail
                }
            )
            .into())
        }
    }
}

fn issue_messages(outcome: &edit::Outcome) -> String {
    let mut messages = outcome
        .errors
        .iter()
        .map(|issue| issue.message.clone())
        .collect::<Vec<_>>();
    if let Some(ambiguity) = outcome.ambiguities.first() {
        messages.push(format!("ambiguous with {} candidates", ambiguity.total));
    }
    messages.join("; ")
}

fn source_block_text(text: &str, start: usize, end: usize) -> Result<String> {
    let lines = source_lines(text);
    if start == 0 || start > end || end > lines.len() {
        return Err("source block line range is outside the snapshot".into());
    }
    Ok(lines[start - 1..end].join("\n"))
}

fn source_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    text.strip_suffix('\n')
        .unwrap_or(text)
        .split('\n')
        .collect()
}

fn normalize_eol(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn parse_source_ref(raw: &str) -> Result<(String, Option<String>, Option<String>)> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("source reference is empty".into());
    }
    let (path_text, symbol) = match raw.rsplit_once('#') {
        Some((path, symbol)) if !path.is_empty() && !symbol.trim().is_empty() => {
            (path, Some(symbol.trim().to_string()))
        }
        _ => (raw, None),
    };
    if let Some((path, range)) = split_path_range(path_text) {
        if path.is_empty() {
            return Err("source path is empty".into());
        }
        return Ok((path.to_string(), symbol, Some(range)));
    }
    Ok((path_text.to_string(), symbol, None))
}

fn split_path_range(raw: &str) -> Option<(&str, String)> {
    let (path, range) = raw.rsplit_once(':')?;
    if path.is_empty() {
        return None;
    }
    if parse_line_range(range).is_ok() {
        Some((path, range.trim().to_string()))
    } else {
        None
    }
}

fn parse_line_range(raw: &str) -> std::result::Result<(usize, usize), String> {
    let raw = raw.trim();
    let raw = raw
        .strip_prefix('L')
        .or_else(|| raw.strip_prefix('l'))
        .unwrap_or(raw)
        .trim();
    let (start, end) = match raw.split_once('-') {
        Some((start, end)) => (start.trim(), end.trim()),
        None => (raw, raw),
    };
    let start = start
        .parse::<usize>()
        .map_err(|_| format!("invalid line range: {raw}"))?;
    let end = end
        .parse::<usize>()
        .map_err(|_| format!("invalid line range: {raw}"))?;
    if start == 0 || start > end {
        return Err(format!("invalid line range: {raw}"));
    }
    Ok((start, end))
}

fn parse_usize_value(value: &Value, field: &str) -> Result<usize> {
    value_as_usize(value).ok_or_else(|| format!("{field} must be a positive line number").into())
}

fn value_as_usize(value: &Value) -> Option<usize> {
    match value {
        Value::Number(number) => number
            .as_u64()
            .and_then(|number| usize::try_from(number).ok()),
        Value::String(text) => text.trim().parse::<usize>().ok(),
        _ => None,
    }
}

fn parse_positive_id(value: &Value, field: &str) -> Result<i64> {
    let id = match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => {
            let text = text.trim().trim_start_matches('b').trim_start_matches('#');
            text.parse::<i64>().ok()
        }
        _ => None,
    }
    .ok_or_else(|| format!("{field} must be a positive numeric id"))?;
    if id <= 0 {
        return Err(format!("{field} must be a positive numeric id").into());
    }
    Ok(id)
}

fn auto_indent(text: &str, after: usize, skip: Option<(usize, usize)>) -> String {
    let lines = source_lines(text);
    let count = lines.len();
    let skipped =
        |line: usize| skip.is_some_and(|(start, end)| line >= start && line <= end);
    let mut next = None;
    for line in (after + 1)..=count {
        if !skipped(line) && !lines[line - 1].trim().is_empty() {
            next = Some(line);
            break;
        }
    }
    let mut previous = None;
    for line in (1..=after).rev() {
        if !skipped(line) && !lines[line - 1].trim().is_empty() {
            previous = Some(line);
            break;
        }
    }
    let indent_of = |line: usize| leading_indent(lines[line - 1]).to_string();
    if let Some(next) = next {
        if !is_closer(lines[next - 1]) {
            return indent_of(next);
        }
    }
    if let (Some(previous), Some(_)) = (previous, next) {
        if is_opener(lines[previous - 1]) {
            let mut base = indent_of(previous);
            let unit = if base.starts_with('\t') { "\t" } else { "    " };
            base.push_str(unit);
            return base;
        }
    }
    if let Some(previous) = previous {
        return indent_of(previous);
    }
    next.map(indent_of).unwrap_or_default()
}

fn shift_indent(block: &str, spec: Option<&Value>, reference: &str) -> Result<String> {
    let normalized = normalize_eol(block);
    let body = normalized.strip_suffix('\n').unwrap_or(&normalized);
    let lines = body.split('\n').collect::<Vec<_>>();
    let from = common_indent(&lines);
    let raw = match spec {
        None | Some(Value::Null) => "auto".to_string(),
        Some(Value::String(text)) => text.trim().to_ascii_lowercase(),
        Some(Value::Number(number)) => number
            .as_u64()
            .ok_or("indent integer must be non-negative")?
            .to_string(),
        Some(_) => return Err("indent must be auto, none, an integer, or +N/-N".into()),
    };
    let to = if raw.is_empty() || raw == "auto" {
        reference.to_string()
    } else if raw == "none" || raw == "keep" {
        from.clone()
    } else if let Some(relative) = raw.strip_prefix('+') {
        let count = relative
            .parse::<usize>()
            .map_err(|_| "invalid relative indent")?;
        let unit = if from.starts_with('\t') { "\t" } else { " " };
        from.clone() + &unit.repeat(count)
    } else if let Some(relative) = raw.strip_prefix('-') {
        let count = relative
            .parse::<usize>()
            .map_err(|_| "invalid relative indent")?;
        from.chars()
            .take(from.chars().count().saturating_sub(count))
            .collect()
    } else {
        let count = raw.parse::<usize>().map_err(|_| "invalid indent")?;
        " ".repeat(count)
    };
    let text = if to == from {
        format!("{body}\n")
    } else {
        let mut output = Vec::with_capacity(lines.len());
        for line in lines {
            if line.trim().is_empty() {
                output.push(String::new());
            } else {
                output.push(format!("{to}{}", &line[from.len()..]));
            }
        }
        format!("{}\n", output.join("\n"))
    };
    Ok(text)
}

fn common_indent(lines: &[&str]) -> String {
    let mut common: Option<Vec<char>> = None;
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let current = leading_indent(line).chars().collect::<Vec<_>>();
        common = Some(match common {
            None => current,
            Some(previous) => previous
                .iter()
                .zip(current.iter())
                .take_while(|(left, right)| left == right)
                .map(|(left, _)| *left)
                .collect(),
        });
    }
    common
        .map(|chars| chars.into_iter().collect())
        .unwrap_or_default()
}

fn leading_indent(line: &str) -> &str {
    let length = line
        .bytes()
        .take_while(|byte| matches!(byte, b' ' | b'\t'))
        .count();
    &line[..length]
}

fn is_closer(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with('}')
        || trimmed.starts_with(']')
        || trimmed.starts_with(')')
        || trimmed.starts_with("</")
        || ["end", "fi", "done", "esac"].iter().any(|keyword| {
            trimmed == *keyword
                || trimmed
                    .strip_prefix(*keyword)
                    .and_then(|rest| rest.chars().next())
                    .is_some_and(char::is_whitespace)
        })
}

fn is_opener(line: &str) -> bool {
    let trimmed = line.trim_end();
    trimmed.ends_with('{')
        || trimmed.ends_with('(')
        || trimmed.ends_with('[')
        || trimmed.ends_with(':')
}

fn read_existing(path: &Path) -> Result<Option<Vec<u8>>> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() {
        return Err("path exists but is not a regular file".into());
    }
    if metadata.len() > MAX_FILE_BYTES as u64 {
        return Err("file exceeds byte snapshot budget".into());
    }
    let mut file = File::open(path)?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err("file exceeds byte snapshot budget".into());
    }
    Ok(Some(bytes))
}

fn load_blob(store: &Store, hash: &str) -> Result<Vec<u8>> {
    let value = store.query("store.getBlob", &json!({"hash": hash}))?;
    let encoded = value["base64"]
        .as_str()
        .ok_or("historical blob is missing")?;
    Ok(STANDARD.decode(encoded).map_err(|error| error.to_string())?)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_sha256(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_expected_precheck(params: &Value) -> Result<Option<Option<String>>> {
    let Some(object) = params.as_object() else {
        return Ok(None);
    };
    let Some(value) = object.get("expectedHash") else {
        return Ok(None);
    };
    match value {
        Value::Null => Ok(Some(None)),
        Value::String(hash) if valid_sha256(hash) => Ok(Some(Some(hash.clone()))),
        _ => Err("invalid expectedHash".into()),
    }
}

fn preview_changes(changes: &[Change]) -> Vec<Value> {
    changes
        .iter()
        .map(|change| {
            json!({
                "filePath": change.path,
                "beforeHash": change.before.as_ref().map(|bytes| digest(bytes)),
                "afterHash": change.after.as_ref().map(|bytes| digest(bytes)),
                "op": change.op,
                "summary": change.summary,
            })
        })
        .collect()
}

fn preview_conflicts(conflicts: &[ConflictPreview]) -> Vec<Value> {
    conflicts
        .iter()
        .map(|conflict| {
            json!({
                "filePath": conflict.path,
                "reasons": conflict.reasons,
            })
        })
        .collect()
}

fn validator_adapter_supported(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "js" | "cjs" | "mjs" | "css" | "json"
    )
}

async fn review_build(
    build: &Build,
    validator: &ValidatorProcess,
    reject_new_syntax: bool,
) -> Result<(Value, bool)> {
    let mut entries = Vec::new();
    let mut actual = Vec::<(String, Value)>::new();
    let mut unsupported = Vec::<String>::new();
    let mut not_applicable = Vec::<String>::new();
    let mut applicable = 0usize;
    let mut supported_count = 0usize;
    let mut syntax_rejected = false;

    for textual in &build.text_reviews {
        if validator_adapter_supported(&textual.path) {
            let review = validator
                .review(&textual.path, &textual.before, &textual.after)
                .await?;
            if review.rejects_syntax(reject_new_syntax) {
                syntax_rejected = true;
            }
            let value = serde_json::to_value(&review)?;
            applicable += 1;
            if review.supported {
                supported_count += 1;
            } else {
                unsupported.push(textual.path.clone());
            }
            let supported = review.supported;
            actual.push((textual.path.clone(), value.clone()));
            entries.push(json!({
                "filePath": textual.path,
                "applicable": true,
                "supported": supported,
                "review": value,
            }));
        } else {
            applicable += 1;
            unsupported.push(textual.path.clone());
            entries.push(json!({
                "filePath": textual.path,
                "applicable": true,
                "supported": false,
                "review": Value::Null,
                "note": "validator adapter not enabled for this extension; no lint was run",
            }));
        }
    }

    let mut seen = build
        .text_reviews
        .iter()
        .map(|textual| textual.path.clone())
        .collect::<HashSet<_>>();
    for change in &build.changes {
        if !seen.insert(change.path.clone()) {
            continue;
        }
        not_applicable.push(change.path.clone());
        entries.push(json!({
            "filePath": change.path,
            "applicable": false,
            "supported": false,
            "review": Value::Null,
            "note": "no text review was possible for this byte change; no lint was run",
        }));
    }

    let mut introduced = Vec::new();
    let mut existing = 0i64;
    for (_, value) in &actual {
        if let Some(items) = value["introduced"].as_array() {
            introduced.extend(items.iter().cloned());
        }
        existing = existing.saturating_add(value["existing"].as_i64().unwrap_or(0));
    }
    let file_path = if entries.len() == 1 {
        entries[0]
            .get("filePath")
            .cloned()
            .unwrap_or(Value::Null)
    } else {
        Value::String(String::new())
    };
    let review = json!({
        "filePath": file_path,
        "supported": applicable > 0 && supported_count == applicable,
        "validatorVersion": if actual.is_empty() { Value::Null } else { json!("pf-validation-v1") },
        "introduced": introduced,
        "existing": existing,
        "files": entries,
        "unsupported": unsupported,
        "notApplicable": not_applicable,
        "syntaxRejected": syntax_rejected,
    });
    Ok((review, syntax_rejected))
}
