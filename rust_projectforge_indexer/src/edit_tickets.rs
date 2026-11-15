//! Persistent source-hash-bound ambiguity tickets for the native edit pipeline.
use std::path::PathBuf;

use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    edit::Ambiguity,
    storage::{Result, Store},
    validation_process::ValidatorProcess,
};

pub const SCHEMA:&str = "
CREATE TABLE IF NOT EXISTS edit_tickets (
    ticket_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    request_hash TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    request_params TEXT NOT NULL,
    ambiguities TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    resolved_operation_id TEXT,
    resolved_request_hash TEXT,
    resolved_result TEXT,
    resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_edit_tickets_operation_id
ON edit_tickets(operation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edit_tickets_resolved_operation
ON edit_tickets(resolved_operation_id) WHERE resolved_operation_id IS NOT NULL;
";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolveRequest {
    operation_id: String,
    ticket_id: String,
    pick: Value,
    #[serde(default)]
    maid: Option<String>,
}

#[derive(Deserialize)]
struct StoredAmbiguity {
    step: usize,
    total: usize,
}

struct TicketRow {
    source_hash: String,
    request_params: String,
    ambiguities: String,
    live: bool,
    resolved_operation_id: Option<String>,
    resolved_request_hash: Option<String>,
    resolved_result: Option<String>,
}

/// Issue a durable ticket inside the caller's rejection transaction.
pub(crate) fn issue_rejection(
    tx: &rusqlite::Transaction<'_>,
    operation_id: &str,
    project_id: &str,
    request_hash: &str,
    source_hash: &str,
    params: &Value,
    ambiguities: &[Ambiguity],
) -> Result<String> {
    if ambiguities.is_empty() {
        return Err("ambiguity ticket requires at least one candidate set".into());
    }
    let params = serde_json::to_string(params)?;
    let ambiguities = serde_json::to_string(ambiguities)?;
    let active: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL)",
        [project_id],
        |row| row.get(0),
    )?;
    if !active {
        return Err("project missing or deleted".into());
    }
    let ticket_id: String = tx.query_row(
        "SELECT 't' || lower(hex(randomblob(16)))",
        [],
        |row| row.get(0),
    )?;
    tx.execute(
        "INSERT INTO edit_tickets(ticket_id,operation_id,project_id,request_hash,source_hash,
            request_params,ambiguities,created_at,expires_at)
         VALUES (?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes'))",
        rusqlite::params![
            ticket_id,
            operation_id,
            project_id,
            request_hash,
            source_hash,
            params,
            ambiguities
        ],
    )?;
    Ok(ticket_id)
}

/// Resolve one ambiguity ticket by explicitly selecting every ambiguous step.
/// The actual edit is submitted through the normal execute path with the
/// ticket's source hash as expectedHash, so drift is rejected before any write.
pub async fn resolve(
    store: &mut Store,
    params: &Value,
    allowed_roots: &[PathBuf],
    validator: &ValidatorProcess,
) -> Result<Value> {
    let request: ResolveRequest = serde_json::from_value(params.clone())?;
    if request.operation_id.is_empty() || request.operation_id.len() > 128
        || request.ticket_id.is_empty() || request.ticket_id.len() > 128
        || request.maid.as_ref().is_some_and(|s| s.trim().is_empty() || s.len() > 128)
    {
        return Err("invalid ambiguity resolution request or budget".into());
    }
    let pick = pick_text(&request.pick)?;
    if pick.len() > 4096 {
        return Err("pick spec exceeds budget".into());
    }

    let ticket: Option<TicketRow> = store.db.query_row(
        "SELECT source_hash,request_params,ambiguities,
            CASE WHEN expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 1 ELSE 0 END,
            resolved_operation_id,resolved_request_hash,resolved_result
         FROM edit_tickets WHERE ticket_id=?",
        [request.ticket_id.as_str()],
        |row| Ok(TicketRow {
            source_hash: row.get(0)?,
            request_params: row.get(1)?,
            ambiguities: row.get(2)?,
            live: row.get::<_, i64>(3)? != 0,
            resolved_operation_id: row.get(4)?,
            resolved_request_hash: row.get(5)?,
            resolved_result: row.get(6)?,
        }),
    ).optional()?;
    let ticket = ticket.ok_or("ambiguity ticket not found")?;

    if ticket.resolved_operation_id.as_deref()
        .is_some_and(|id| id != request.operation_id.as_str()) {
        return Err("ambiguity ticket was already resolved by another operation".into());
    }
    if ticket.resolved_operation_id.is_none() && !ticket.live {
        return Err("ambiguity ticket expired".into());
    }

    let stored: Vec<StoredAmbiguity> = serde_json::from_str(&ticket.ambiguities)?;
    if stored.is_empty() {
        return Err("ambiguity ticket has no candidate sets".into());
    }
    let mut steps = Vec::with_capacity(stored.len());
    for ambiguity in &stored {
        if ambiguity.step == 0 || ambiguity.total == 0 || steps.contains(&ambiguity.step) {
            return Err("ambiguity ticket candidate metadata is invalid".into());
        }
        steps.push(ambiguity.step);
    }
    let picks = parse_pick_spec(&pick, &steps)?;
    let mut submitted: Value = serde_json::from_str(&ticket.request_params)?;
    for (step, selection) in &picks {
        let total = stored.iter().find(|a| a.step == *step)
            .map(|a| a.total).ok_or("ambiguity step metadata missing")?;
        apply_pick(&mut submitted, *step, selection, total)?;
    }
    submitted["operationId"] = json!(request.operation_id);
    submitted["expectedHash"] = json!(ticket.source_hash);
    if let Some(maid) = request.maid.as_deref() {
        submitted["maid"] = json!(maid);
    }
    let resolve_hash = resolve_digest(&request.operation_id, &request.ticket_id, &submitted)?;

    if let Some(resolved_operation) = ticket.resolved_operation_id.as_deref() {
        if resolved_operation == request.operation_id.as_str()
            && ticket.resolved_request_hash.as_deref() == Some(resolve_hash.as_str())
        {
            return Ok(serde_json::from_str(
                ticket.resolved_result.as_deref().ok_or("resolved ticket result missing")?,
            )?);
        }
        return Err("ambiguity ticket already resolved with a different request".into());
    }

    let claimed: Option<String> = store.db.query_row(
        "SELECT ticket_id FROM edit_tickets
         WHERE resolved_operation_id=? AND ticket_id<>? LIMIT 1",
        rusqlite::params![request.operation_id, request.ticket_id],
        |row| row.get(0),
    ).optional()?;
    if claimed.is_some() {
        return Err("operationId already belongs to another ambiguity ticket".into());
    }

    let result = crate::edit_service::execute(store, &submitted, allowed_roots, validator).await?;
    if terminal_success(&result) {
        let encoded = serde_json::to_string(&result)?;
        let tx = store.db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let updated = tx.execute(
            "UPDATE edit_tickets
             SET resolved_operation_id=?,resolved_request_hash=?,resolved_result=?,
                 resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE ticket_id=? AND resolved_operation_id IS NULL",
            rusqlite::params![
                request.operation_id,
                resolve_hash,
                encoded,
                request.ticket_id
            ],
        )?;
        if updated != 1 {
            return Err("ambiguity ticket resolution state changed; query operation status".into());
        }
        tx.commit()?;
    }
    Ok(result)
}

fn pick_text(value: &Value) -> std::result::Result<String, String> {
    match value {
        Value::String(text) => Ok(text.trim().to_string()),
        Value::Number(number) => number.as_u64().filter(|n| *n > 0)
            .map(|n| n.to_string())
            .ok_or_else(|| "pick must be a positive integer".into()),
        _ => Err("pick must be a string or positive integer".into()),
    }
}

fn parse_pick_spec(
    pick: &str,
    ambiguous_steps: &[usize],
) -> std::result::Result<std::collections::BTreeMap<usize, String>, String> {
    let raw = pick.trim();
    if raw.is_empty() {
        return Err("missing pick".into());
    }
    let mut result = std::collections::BTreeMap::new();
    if !raw.contains(':') {
        if ambiguous_steps.len() != 1 {
            return Err(format!(
                "{} steps are ambiguous; use step:pick for each of {}",
                ambiguous_steps.len(),
                ambiguous_steps.iter().map(|step| step.to_string()).collect::<Vec<_>>().join(",")
            ));
        }
        result.insert(ambiguous_steps[0], raw.to_string());
        return Ok(result);
    }
    for part in split_pick_parts(raw) {
        let (step, selection) = part.split_once(':')
            .ok_or_else(|| format!("invalid pick fragment: {part}"))?;
        let step: usize = step.trim().parse()
            .map_err(|_| format!("invalid ambiguity step in pick fragment: {part}"))?;
        if !ambiguous_steps.contains(&step) {
            return Err(format!("step {step} has no ambiguity"));
        }
        let selection = selection.trim();
        if selection.is_empty() {
            return Err(format!("pick for step {step} is empty"));
        }
        result.insert(step, selection.to_string());
    }
    let missing: Vec<_> = ambiguous_steps.iter().filter(|step| !result.contains_key(step))
        .map(|step| step.to_string()).collect();
    if !missing.is_empty() {
        return Err(format!("missing pick for ambiguous step(s): {}", missing.join(",")));
    }
    Ok(result)
}

fn split_pick_parts(raw: &str) -> Vec<String> {
    let chars: Vec<(usize, char)> = raw.char_indices().collect();
    let mut parts = Vec::new();
    let mut start = 0usize;
    for index in 0..chars.len() {
        let (byte, current) = chars[index];
        let split = if current == ';' {
            true
        } else if current == ',' {
            let mut next = index + 1;
            while next < chars.len() && chars[next].1.is_whitespace() {
                next += 1;
            }
            let digits = next;
            while next < chars.len() && chars[next].1.is_ascii_digit() {
                next += 1;
            }
            if next == digits {
                false
            } else {
                while next < chars.len() && chars[next].1.is_whitespace() {
                    next += 1;
                }
                next < chars.len() && chars[next].1 == ':'
            }
        } else {
            false
        };
        if split {
            parts.push(raw[start..byte].trim().to_string());
            start = byte + current.len_utf8();
        }
    }
    parts.push(raw[start..].trim().to_string());
    parts.into_iter().filter(|part| !part.is_empty()).collect()
}

fn apply_pick(
    params: &mut Value,
    step: usize,
    selection: &str,
    total: usize,
) -> std::result::Result<(), String> {
    let steps = params.get_mut("steps").and_then(Value::as_array_mut)
        .ok_or("ticket request params missing steps")?;
    let indices: Vec<usize> = steps.iter().enumerate()
        .filter(|(_, entry)| entry.get("step").and_then(Value::as_u64) == Some(step as u64))
        .map(|(index, _)| index)
        .collect();
    if indices.len() != 1 {
        return Err(format!("ticket request step {step} is missing or duplicated"));
    }
    let object = steps[indices[0]].as_object_mut()
        .ok_or("ticket request step is not an object")?;
    let op = object.get("op").and_then(Value::as_str)
        .ok_or("ticket request step is missing op")?.to_string();
    let picks = parse_candidate_picks(selection, total)?;
    match op.as_str() {
        "target" => {
            object.insert("pick".into(), json!(picks));
        }
        "symbol" | "insert" => {
            if picks.len() != 1 {
                return Err("symbol ambiguity accepts exactly one explicit candidate".into());
            }
            object.insert("pick".into(), json!(picks[0]));
        }
        _ => return Err(format!("step {step} with op {op} cannot carry ambiguity candidates")),
    }
    Ok(())
}

fn parse_candidate_picks(
    selection: &str,
    total: usize,
) -> std::result::Result<Vec<usize>, String> {
    if total == 0 {
        return Err("candidate set is empty".into());
    }
    let raw = selection.trim();
    if raw.eq_ignore_ascii_case("all") || raw == "*" {
        return Ok((1..=total).collect());
    }
    let mut picks = Vec::new();
    for token in raw.split(|c: char| c == ',' || c.is_whitespace()) {
        if token.is_empty() {
            continue;
        }
        let pick: usize = token.parse()
            .map_err(|_| format!("invalid candidate {token}"))?;
        if pick == 0 || pick > total {
            return Err(format!("candidate {pick} outside 1..={total}"));
        }
        picks.push(pick);
    }
    if picks.is_empty() {
        return Err("missing candidate pick".into());
    }
    picks.sort_unstable();
    picks.dedup();
    Ok(picks)
}

fn resolve_digest(
    operation_id: &str,
    ticket_id: &str,
    submitted: &Value,
) -> std::result::Result<String, String> {
    let bytes = serde_json::to_vec(&json!({
        "method": "edit_tickets.resolve",
        "operationId": operation_id,
        "ticketId": ticket_id,
        "params": submitted
    })).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn terminal_success(result: &Value) -> bool {
    result.get("state").is_none()
        && matches!(result.get("status").and_then(Value::as_str), Some("ok") | Some("unchanged"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::{Ambiguity, Candidate};

    fn setup() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("pf.db")).unwrap();
        store
            .mutate(
                "store.createProject",
                &json!({
                    "operationId":"create","projectId":"p1","name":"fixture",
                    "root":dir.path().to_str().unwrap()
                }),
            )
            .unwrap();
        (dir, store)
    }

    fn ambiguity() -> Ambiguity {
        Ambiguity {
            step: 1,
            total: 2,
            kind: "exact",
            candidates: vec![
                Candidate {
                    index: 1,
                    start_line: 1,
                    end_line: 1,
                    kind: "exact",
                    scope: None,
                },
                Candidate {
                    index: 2,
                    start_line: 3,
                    end_line: 3,
                    kind: "exact",
                    scope: Some("module::second".into()),
                },
            ],
        }
    }

    fn issue(store: &mut Store, operation: &str) -> String {
        let tx = store
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        let ticket = issue_rejection(
            &tx,
            operation,
            "p1",
            &format!("{:x}", Sha256::digest(operation.as_bytes())),
            &format!("{:x}", Sha256::digest(b"source")),
            &json!({
                "operationId": operation,
                "projectId":"p1",
                "path":"a.txt",
                "steps":[{"step":1,"op":"target","target":"same","content":"new"}]
            }),
            &[ambiguity()],
        )
        .unwrap();
        tx.commit().unwrap();
        ticket
    }

    fn ticket_count(store: &Store) -> i64 {
        store
            .db
            .query_row("SELECT COUNT(*) FROM edit_tickets", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn ticket_issue_rolls_back_atomically_and_persists_hash_bound_payload() {
        let (dir, mut store) = setup();
        let source_hash = format!("{:x}", Sha256::digest(b"source"));
        let tx = store
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        let rolled_back = issue_rejection(
            &tx,
            "rejected",
            "p1",
            &format!("{:x}", Sha256::digest(b"request")),
            &source_hash,
            &json!({
                "operationId":"rejected","projectId":"p1","path":"a.txt",
                "steps":[{"step":1,"op":"target","target":"same","content":"new"}]
            }),
            &[ambiguity()],
        )
        .unwrap();
        assert_eq!(
            tx.query_row(
                "SELECT COUNT(*) FROM edit_tickets WHERE ticket_id=?",
                [&rolled_back],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
        tx.rollback().unwrap();
        assert_eq!(ticket_count(&store), 0);

        let committed = issue(&mut store, "rejected");
        assert_eq!(ticket_count(&store), 1);
        drop(store);

        let store = Store::open(&dir.path().join("pf.db")).unwrap();
        let (operation, project, stored_source, request_params, ambiguities, live): (
            String,
            String,
            String,
            String,
            String,
            i64,
        ) = store
            .db
            .query_row(
                "SELECT operation_id,project_id,source_hash,request_params,ambiguities,
                    expires_at > created_at FROM edit_tickets WHERE ticket_id=?",
                [&committed],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(operation, "rejected");
        assert_eq!(project, "p1");
        assert_eq!(stored_source, source_hash);
        assert_eq!(live, 1);
        let request: Value = serde_json::from_str(&request_params).unwrap();
        assert_eq!(request["path"], "a.txt");
        let stored: Vec<Value> = serde_json::from_str(&ambiguities).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0]["step"], 1);
        assert_eq!(stored[0]["total"], 2);
        assert_eq!(stored[0]["candidates"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn ticket_constraints_follow_project_lifecycle_and_resolution_owner_is_unique() {
        let (_dir, mut store) = setup();
        let first = issue(&mut store, "first");
        let second = issue(&mut store, "second");
        store
            .db
            .execute(
                "UPDATE edit_tickets
                 SET resolved_operation_id='resolve-1',resolved_request_hash='hash',
                     resolved_result='{}',resolved_at='t'
                 WHERE ticket_id=?",
                [&first],
            )
            .unwrap();
        assert!(store
            .db
            .execute(
                "UPDATE edit_tickets SET resolved_operation_id='resolve-1' WHERE ticket_id=?",
                [&second],
            )
            .is_err());
        assert_eq!(ticket_count(&store), 2);

        store
            .mutate(
                "store.softDeleteProjects",
                &json!({"operationId":"delete","ids":["p1"]}),
            )
            .unwrap();
        let tx = store
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        let rejected = issue_rejection(
            &tx,
            "third",
            "p1",
            &format!("{:x}", Sha256::digest(b"third")),
            &format!("{:x}", Sha256::digest(b"source")),
            &json!({"steps":[{"step":1,"op":"target"}]}),
            &[ambiguity()],
        )
        .unwrap_err();
        assert!(rejected.to_string().contains("missing or deleted"));
        tx.rollback().unwrap();
        assert_eq!(ticket_count(&store), 2);

        let purged = store
            .mutate(
                "store.purgeProjects",
                &json!({"operationId":"purge","ids":["p1"]}),
            )
            .unwrap();
        assert_eq!(purged["purged"], json!(["p1"]));
        assert_eq!(ticket_count(&store), 0);
    }
}
