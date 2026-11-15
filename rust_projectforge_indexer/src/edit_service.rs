//! Internal native EditCode command. Transport wiring is a separate acceptance step.
use std::path::{Path, PathBuf};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::{storage::{Store, Result}, edit::Step,
    edit_pipeline::{self, ValidatedPreparation}, validation::Receipt,
    validation_process::ValidatorProcess};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    operation_id: String,
    project_id: String,
    file_path: String,
    reason: String,
    maid: Option<String>,
    steps: Vec<Step>,
    #[serde(default, alias="todoId")]
    todo: Option<Value>,
    #[serde(default)]
    best_effort: bool,
    #[serde(default = "reject_default")]
    reject_new_syntax: bool,
    #[serde(default)]
    expected_hash: Option<String>,
}
fn reject_default() -> bool { true }

fn validate_operation_slot(tx: &rusqlite::Transaction<'_>, operation_id: &str,
    project_id: &str) -> Result<()> {
    let active: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL)",
        [project_id], |r| r.get(0))?;
    if !active { return Err("project missing or deleted".into()); }
    let occupied: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM service_operations WHERE id=?
         UNION ALL SELECT 1 FROM file_commit_intents WHERE operation_id=?)",
        rusqlite::params![operation_id, operation_id], |r| r.get(0))?;
    if occupied { return Err("operation already exists; query status".into()); }
    Ok(())
}

fn insert_operation(tx: &rusqlite::Transaction<'_>, operation_id: &str,
    request_hash: &str, result: &Value) -> Result<()> {
    let encoded = serde_json::to_string(result)?;
    if encoded.len() > 2 * 1024 * 1024 {
        return Err("terminal result budget exceeded".into());
    }
    tx.execute(
        "INSERT INTO service_operations(id,request_hash,result,created_at)
         VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        rusqlite::params![operation_id, request_hash, encoded])?;
    Ok(())
}

fn persist_terminal_result(store: &mut Store, operation_id: &str, project_id: &str,
    request_hash: &str, result: Value) -> Result<Value> {
    let tx = store.db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    validate_operation_slot(&tx, operation_id, project_id)?;
    insert_operation(&tx, operation_id, request_hash, &result)?;
    tx.commit()?;
    Ok(result)
}

pub async fn execute(store: &mut Store, params: &Value, allowed_roots: &[PathBuf],
    validator: &ValidatorProcess) -> Result<Value> {
    let request: Request = serde_json::from_value(params.clone())?;
    if request.operation_id.is_empty() || request.operation_id.len() > 128
        || request.project_id.is_empty() || request.project_id.len() > 64
        || request.file_path.is_empty() || request.file_path.len() > 4096
        || request.reason.trim().is_empty() || request.reason.len() > 2000
        || request.maid.as_ref().is_some_and(|s| s.trim().is_empty() || s.len() > 128)
        || request.steps.is_empty() || request.steps.len() > 200
        || request.expected_hash.as_ref().is_some_and(|hash| hash.len() != 64
            || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))) {
        return Err("invalid native edit request or budget".into());
    }
    let request_hash = format!("{:x}", Sha256::digest(
        serde_json::to_vec(&json!({"method":"edit.execute","params":params}))?));
    let status = store.query("operation.status", &json!({"operationId":request.operation_id}))?;
    if status["state"] != "unknown" {
        if status["requestHash"].as_str() != Some(&request_hash) {
            return Err("operationId reused with different request".into());
        }
        return match status["state"].as_str() {
            Some("committed") | Some("planningRejected") | Some("syntaxRejected") =>
                Ok(status["result"].clone()),
            Some("prepared") => {
                let intent = store.load_intent(&request.operation_id)?;
                crate::commit_coordinator::resume(store, &intent, allowed_roots)
            }
            _ => Err("previous attempt with this operationId ended in conflict (before snapshot preserved, resource lock released); retry with a new operationId".into()),
        };
    }
    let project = store.query("store.getProject", &json!({"projectId":request.project_id}))?;
    let root = project["root"].as_str().ok_or("project missing or invalid root")?;
    if !project["deleted_at"].is_null() {
        return Err("project is deleted".into());
    }
    let sequences=crate::todo_refs::parse(request.todo.as_ref())?;
    let mut todos=Vec::new();
    for seq in sequences {
        let todo=store.query("store.getTodoBySeq",
            &json!({"projectId":request.project_id,"seq":seq}))?;
        let id=todo["id"].as_i64().ok_or("referenced todo does not exist")?;
        todos.push(crate::commit_journal::TodoBinding{id,seq});
    }
    let prepared = edit_pipeline::prepare_validated_with_expected(
        Path::new(root), &request.file_path, allowed_roots, &request.steps,
        request.best_effort, request.reject_new_syntax, validator,
        request.expected_hash.as_deref(),
    ).await?;
    match prepared {
        ValidatedPreparation::PlanningRejected(rejected) => {
            if rejected.outcome.ambiguities.is_empty() {
                let result=json!({
                    "state":"planningRejected","outcome":rejected.outcome,
                    "sourceHash":rejected.snapshot_hash
                });
                return persist_terminal_result(store, &request.operation_id, &request.project_id,
                    &request_hash, result);
            }
            let tx=store.db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            validate_operation_slot(&tx, &request.operation_id, &request.project_id)?;
            let ticket_id=crate::edit_tickets::issue_rejection(
                &tx, &request.operation_id, &request.project_id, &request_hash,
                &rejected.snapshot_hash, params, &rejected.outcome.ambiguities,
            )?;
            let result=json!({
                "state":"planningRejected","outcome":rejected.outcome,
                "sourceHash":rejected.snapshot_hash,"ticketId":ticket_id
            });
            insert_operation(&tx, &request.operation_id, &request_hash, &result)?;
            tx.commit()?;
            Ok(result)
        }
        ValidatedPreparation::SyntaxRejected(review) => {
            let result=json!({"state":"syntaxRejected","review":review});
            persist_terminal_result(store, &request.operation_id, &request.project_id,
                &request_hash, result)
        }
        ValidatedPreparation::Ready { edit, review } => {
            if edit.plan.expected_hash == edit.plan.after_hash {
                edit_pipeline::revalidate(&edit, allowed_roots)?;
                let result=json!({
                    "operationId":request.operation_id,"status":"unchanged",
                    "filePath":edit.path.relative,"afterHash":edit.plan.after_hash,
                    "applied":edit.plan.outcome.applied,
                    "placements":edit.plan.outcome.placements,
                    "skipped":edit.plan.outcome.errors,"review":review
                });
                return persist_terminal_result(store, &request.operation_id,
                    &request.project_id, &request_hash, result);
            }
            let receipt = Receipt::bind(&edit, &review, request.reject_new_syntax)?;
            edit_pipeline::revalidate(&edit, allowed_roots)?;
            let mut context=crate::commit_journal::CommitContext::from_plan(&edit,&request.steps)?;
            context.todos=todos;
            store.prepare_validated_intent(&request.operation_id, &request_hash,
                &request.project_id, &edit, &request.reason, request.maid.as_deref(), &receipt,&context)?;
            let intent = store.load_intent(&request.operation_id)?;
            crate::commit_coordinator::resume(store, &intent, allowed_roots)
        }
    }
}