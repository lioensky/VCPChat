//! Durable intents precede filesystem changes. This is NOT a completed commit API.
use flate2::{write::GzEncoder, Compression};
use std::io::Write;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest,Sha256};
use crate::{storage::{Store,Result}, edit_pipeline::ReadyEdit};

pub const SCHEMA:&str = "
CREATE TABLE IF NOT EXISTS file_commit_intents (
    operation_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    root TEXT NOT NULL,
    file_path TEXT NOT NULL,
    resource_key TEXT NOT NULL,
    before_hash TEXT NOT NULL REFERENCES blobs(hash),
    after_hash TEXT NOT NULL REFERENCES blobs(hash),
    state TEXT NOT NULL CHECK(state IN ('prepared','conflict','committed','aborted')),
    reason TEXT NOT NULL,
    maid TEXT,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commit_resource_active
ON file_commit_intents(resource_key) WHERE state = 'prepared';
";

#[derive(Debug)]
pub struct Intent {
    pub operation_id:String,
    pub root:String,
    pub file_path:String,
    pub before_hash:String,
    pub after_hash:String,
    pub state:String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RecoveryPosition {
    Before,
    After,
    Conflict,
}

/// Inspection only. Does not authorize writing or finalize database records.
pub fn inspect_intent(intent:&Intent,allowed_roots:&[std::path::PathBuf])->Result<RecoveryPosition> {
    if intent.state=="conflict" {return Ok(RecoveryPosition::Conflict);}
    let root=std::path::Path::new(&intent.root);
    let inspected=(|| -> std::result::Result<RecoveryPosition,String> {
        let path=crate::project_path::resolve(root,&intent.file_path,false)?;
        if !allowed_roots.iter().any(|r|r.canonicalize().is_ok_and(|r|path.root.starts_with(r))) {
            return Err("recovery root is no longer writable".into());
        }
        let snapshot=crate::text_snapshot::TextSnapshot::read(&path.absolute)?;
        if snapshot.hash==intent.after_hash {Ok(RecoveryPosition::After)}
        else if snapshot.hash==intent.before_hash {Ok(RecoveryPosition::Before)}
        else {Ok(RecoveryPosition::Conflict)}
    })();
    // Missing, binary, invalid UTF8, linked and unauthorized paths require inspection;
    // none may be treated as the old version and blindly overwritten.
    Ok(inspected.unwrap_or(RecoveryPosition::Conflict))
}

fn digest(bytes:&[u8])->String {format!("{:x}",Sha256::digest(bytes))}
fn put_blob(db:&rusqlite::Connection,bytes:&[u8])->Result<String> {
    let hash=digest(bytes);
    let mut gzip=GzEncoder::new(Vec::new(),Compression::default());
    gzip.write_all(bytes)?;
    db.execute("INSERT OR IGNORE INTO blobs(hash,size,data) VALUES (?,?,?)",
        params![hash,bytes.len() as i64,gzip.finish()?])?;
    Ok(hash)
}

#[derive(serde::Serialize,serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitContext {
    #[serde(default)]
    pub todos:Vec<TodoBinding>,
    pub version:u32,
    pub node_reason:Option<String>,
    pub summary:String,
    pub outcome:Value,
}
#[derive(serde::Serialize,serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TodoBinding {
    pub id:i64,
    pub seq:i64,
}
impl CommitContext {
    pub fn verify_todos(&self,db:&rusqlite::Connection,project:&str)->Result<()> {
        let mut seen=std::collections::HashSet::new();
        if self.todos.len()>200 {return Err("todo binding budget exceeded".into());}
        for todo in &self.todos {
            if todo.id<=0 || todo.seq<=0 || !seen.insert(todo.id) {
                return Err("invalid or duplicate todo binding".into());
            }
            let exists:bool=db.query_row(
                "SELECT EXISTS(SELECT 1 FROM todos WHERE project_id=? AND id=? AND seq=?)",
                params![project,todo.id,todo.seq],|r|r.get(0))?;
            if !exists {return Err("bound todo missing or identity changed".into());}
        }
        Ok(())
    }
    pub fn from_plan(ready:&ReadyEdit,steps:&[crate::edit::Step])->Result<Self> {
        let applied=&ready.plan.outcome.applied;
        let reasons=steps.iter().filter(|s|applied.contains(&s.step))
            .filter_map(|s|s.reason.as_ref().map(|r|format!("步骤{}：{}",s.step,r)))
            .collect::<Vec<_>>().join("；");
        let context=Self {
            todos:vec![],version:1,node_reason:if reasons.is_empty(){None}else{Some(reasons)},
            summary:if steps.is_empty() {format!("{} 步",applied.len())} else {
                let names=steps.iter().filter(|s|applied.contains(&s.step)).map(|s|match &s.action {
                    crate::edit::Action::Replace{..}=>"replace",
                    crate::edit::Action::Delete{..}=>"delete",
                    crate::edit::Action::Symbol{..}=>"symbol",
                    crate::edit::Action::Insert{..}=>"insert",
                    crate::edit::Action::Target{..}=>"target",
                }).collect::<Vec<_>>();
                format!("{} 步：{}",applied.len(),names.join("/"))
            },
            outcome:serde_json::to_value(&ready.plan.outcome)?,
        };
        context.check()?;
        Ok(context)
    }
    fn verify_images(&self,before:&[u8],after:&[u8])->Result<()> {
        self.check()?;
        let before=crate::text_snapshot::TextSnapshot::decode(before.to_vec())?;
        let after=crate::text_snapshot::TextSnapshot::decode(after.to_vec())?;
        let a=&before.text;
        let b=&after.text;
        let applied=self.outcome["applied"].as_array().ok_or("missing applied steps")?;
        if applied.is_empty() || applied.len()>200 {return Err("invalid applied count".into());}
        let mut ids=std::collections::HashSet::new();
        for id in applied {
            let id=id.as_u64().filter(|n|*n>0).ok_or("invalid applied identifier")?;
            if !ids.insert(id) {return Err("duplicate applied identifier".into());}
        }
        let errors=self.outcome["errors"].as_array().ok_or("missing skipped errors")?;
        if errors.len()>200 {return Err("skipped error budget exceeded".into());}
        for error in errors {
            let id=error["step"].as_u64().filter(|n|*n>0).ok_or("invalid skipped identifier")?;
            if ids.contains(&id) || error["message"].as_str().is_none_or(|s|s.len()>32768) {
                return Err("invalid skipped error".into());
            }
        }
        if self.outcome["ambiguities"].as_array().is_none_or(|v|!v.is_empty())
            || self.outcome["changed"].as_bool()!=Some(a!=b) {
            return Err("commit outcome identity mismatch".into());
        }
        let placements=self.outcome["placements"].as_array().ok_or("missing placements")?;
        if placements.is_empty() || placements.len()>10_000 {return Err("placement count budget exceeded".into());}
        let starts=|text:&str| {
            let mut lines=vec![0usize];
            lines.extend(text.match_indices('\n').map(|(n,_)|n+1));
            lines
        };
        let old_lines=starts(a);
        let new_lines=starts(b);
        let mut old_cursor=0usize;
        let mut new_cursor=0usize;
        let mut witnessed=std::collections::HashSet::new();
        let mut operations=std::collections::HashMap::new();
        for p in placements {
            let id=p["step"].as_u64().ok_or("invalid placement step")?;
            if !ids.contains(&id) {return Err("placement belongs to unapplied step".into());}
            witnessed.insert(id);
            let op=p["op"].as_str().ok_or("missing placement operation")?;
            if !matches!(op,"replace"|"delete"|"insert"|"symbol"|"target")
                || operations.insert(id,op).is_some_and(|previous|previous!=op) {
                return Err("invalid placement operation".into());
            }
            let number=|key:&str|->Result<usize> {
                Ok(usize::try_from(p[key].as_u64().ok_or("invalid placement coordinate")?)?)
            };
            let start=number("originalStartByte")?;
            let end=number("originalEndByte")?;
            let new_start=number("newStartByte")?;
            let new_end=number("newEndByte")?;
            if start<old_cursor || end<start || end>a.len()
                || new_start<new_cursor || new_end<new_start || new_end>b.len()
                || !a.is_char_boundary(start) || !a.is_char_boundary(end)
                || !b.is_char_boundary(new_start) || !b.is_char_boundary(new_end) {
                return Err("placement boundary mismatch".into());
            }
            if a[old_cursor..start]!=b[new_cursor..new_start]
                || p["insertion"].as_bool()!=Some(start==end)
                || number("originalStartLine")?!=old_lines.partition_point(|&n|n<=start)
                || number("originalEndLine")?!=old_lines.partition_point(|&n|n<=if end>start {end-1}else{start}) {
                return Err("placement original image mismatch".into());
            }
            if new_start==new_end {
                if !p.get("newStartLine").is_some_and(Value::is_null)
                    || !p.get("newEndLine").is_some_and(Value::is_null) {
                    return Err("empty placement must have null output lines".into());
                }
            } else if number("newStartLine")?!=new_lines.partition_point(|&n|n<=new_start)
                || number("newEndLine")?!=new_lines.partition_point(|&n|n<new_end) {
                return Err("placement output line mismatch".into());
            }
            old_cursor=end;
            new_cursor=new_end;
        }
        if witnessed!=ids || a[old_cursor..]!=b[new_cursor..] {
            return Err("placements do not reconstruct durable after image".into());
        }
        Ok(())
    }

    fn check(&self)->Result<()> {
        if self.version!=1 || self.summary.len()>4096
            || self.node_reason.as_ref().is_some_and(|s|s.len()>128*1024)
            || self.outcome["status"]!="ok" || self.outcome.get("text").is_some() {
            return Err("invalid commit context".into());
        }
        if serde_json::to_vec(self)?.len()>512*1024 {return Err("commit context budget exceeded".into());}
        Ok(())
    }
}

impl Store {
    /// Caller supplies the hash of the ORIGINAL immutable request, not regenerated
    /// plan bytes. Replaying/recovering an operation must never replan current files.
    pub fn prepare_validated_intent(&mut self,operation:&str,request_hash:&str,project:&str,
        ready:&ReadyEdit,reason:&str,maid:Option<&str>,receipt:&crate::validation::Receipt,
        context:&CommitContext)->Result<()> {
        context.verify_images(&ready.snapshot.original,&ready.plan.bytes)?;
        let context_json=serde_json::to_string(context)?;
        receipt.verify(&ready.path.relative,&ready.snapshot.original,&ready.plan.bytes)?;
        let receipt_json=serde_json::to_string(receipt)?;
        if receipt_json.len()>2*1024*1024 {return Err("validation receipt budget exceeded".into());}
        if operation.is_empty()||operation.len()>128||reason.trim().is_empty()||reason.len()>2000 {
            return Err("invalid intent identity or reason".into());
        }
        if request_hash.len()!=64||!request_hash.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)) {
            return Err("invalid request hash".into());
        }
        if ready.snapshot.hash!=ready.plan.expected_hash
            || digest(&ready.snapshot.original)!=ready.plan.expected_hash
            || digest(&ready.plan.bytes)!=ready.plan.after_hash {
            return Err("plan/snapshot identity mismatch".into());
        }
        if ready.plan.expected_hash==ready.plan.after_hash {
            return Err("unchanged plan must not create a commit intent".into());
        }
        // All deterministic format and hard budget failures must happen before a
        // durable intent can authorize filesystem mutation. A large in-place
        // rewrite is priced with the bounded statistics, so it can no longer
        // block a commit that the byte/line ceilings already allowed.
        let proposed=crate::text_snapshot::TextSnapshot::decode(ready.plan.bytes.clone())?;
        crate::line_diff::stats_bounded(&ready.snapshot.text,&proposed.text)?;
        let root=ready.path.root.to_str().ok_or("root is not UTF8")?;
        let resource=ready.path.absolute.to_str().ok_or("path is not UTF8")?;
        #[cfg(windows)]
        let resource=resource.to_lowercase();
        #[cfg(not(windows))]
        let resource=resource.to_string();
        let tx=self.db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL)",[project],|r|r.get(0))?;
        if !exists {return Err("project missing or deleted".into());}
        context.verify_todos(&tx,project)?;
        // No replay here: callers must query status and resume the durable intent.
        let occupied:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM service_operations WHERE id=?
            UNION ALL SELECT 1 FROM file_commit_intents WHERE operation_id=?)",
            params![operation,operation],|r|r.get(0))?;
        if occupied {return Err("operation already exists; query status instead of replanning".into());}
        let before=put_blob(&tx,&ready.snapshot.original)?;
        let after=put_blob(&tx,&ready.plan.bytes)?;
        tx.execute("INSERT INTO file_commit_intents(operation_id,request_hash,project_id,root,file_path,resource_key,
            before_hash,after_hash,state,reason,maid,validation_receipt,commit_context,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,'prepared',?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            params![operation,request_hash,project,root,ready.path.relative,resource,before,after,reason,maid,receipt_json,context_json])?;
        tx.commit()?;
        Ok(())
    }

    /// Synthetic successful reviews belong only to storage/recovery unit fixtures.
    /// Production callers must obtain a real review and bind a receipt.
    #[cfg(test)]
    pub(crate) fn prepare_intent(&mut self,operation:&str,request_hash:&str,project:&str,
        ready:&ReadyEdit,reason:&str,maid:Option<&str>)->Result<()> {
        let after=crate::text_snapshot::TextSnapshot::decode(ready.plan.bytes.clone())?;
        let wire=json!({"ok":true,"result":{
            "protocolVersion":1,"validatorVersion":"pf-validation-v1",
            "filePath":ready.path.relative,
            "beforeHash":digest(ready.snapshot.text.as_bytes()),
            "afterHash":digest(after.text.as_bytes()),
            "state":"completed","before":[],"after":[]
        }});
        let review=crate::validation::decode(&serde_json::to_vec(&wire)?,
            &ready.path.relative,&ready.snapshot.text,&after.text)?;
        let receipt=crate::validation::Receipt::bind(ready,&review,true)?;
        let context=CommitContext::from_plan(ready,&[])?;
        self.prepare_validated_intent(operation,request_hash,project,ready,reason,maid,&receipt,&context)
    }

    pub(crate) fn load_commit_context(&self,operation:&str)->Result<CommitContext> {
        let encoded:Option<String>=self.db.query_row(
            "SELECT commit_context FROM file_commit_intents WHERE operation_id=?",
            [operation],|r|r.get(0))?;
        let encoded=encoded.ok_or("intent missing commit context")?;
        if encoded.len()>512*1024 {return Err("commit context budget exceeded".into());}
        let context:CommitContext=serde_json::from_str(&encoded)?;
        context.check()?;
        Ok(context)
    }

    pub(crate) fn verify_intent_receipt(&self,operation:&str)->Result<()> {
        let context=self.load_commit_context(operation)?;
        let project:String=self.db.query_row(
            "SELECT project_id FROM file_commit_intents WHERE operation_id=?",
            [operation],|r|r.get(0))?;
        context.verify_todos(&self.db,&project)?;
        let intent=self.load_intent(operation)?;
        let encoded:Option<String>=self.db.query_row(
            "SELECT validation_receipt FROM file_commit_intents WHERE operation_id=?",
            [operation],|r|r.get(0))?;
        let encoded=encoded.ok_or("intent has no validation receipt")?;
        if encoded.len()>2*1024*1024 {return Err("validation receipt budget exceeded".into());}
        let receipt:crate::validation::Receipt=serde_json::from_str(&encoded)?;
        let before=Self::blob(&self.db,&intent.before_hash)?;
        let after=Self::blob(&self.db,&intent.after_hash)?;
        receipt.verify(&intent.file_path,&before,&after)?;
        context.verify_images(&before,&after)?;
        Ok(())
    }

    pub(crate) fn load_intent(&self,operation:&str)->Result<Intent> {
        Ok(self.db.query_row(
            "SELECT operation_id,root,file_path,before_hash,after_hash,state
             FROM file_commit_intents WHERE operation_id=?",
            [operation],|r|Ok(Intent {
                operation_id:r.get(0)?,root:r.get(1)?,file_path:r.get(2)?,
                before_hash:r.get(3)?,after_hash:r.get(4)?,state:r.get(5)?,
            }))?)
    }

    /// Only prepared intents are pending recovery. Conflicts keep their audit snapshots
    /// but are terminal for recovery and hold no resource lock.
    #[cfg(test)]
    pub fn pending_intents(&self)->Result<Vec<Intent>> {
        self.prepared_intents()
    }

    /// Prepared intents are the only entries eligible for startup recovery.
    pub fn prepared_intents(&self)->Result<Vec<Intent>> {
        let mut query=self.db.prepare("SELECT operation_id,root,file_path,before_hash,after_hash,state
            FROM file_commit_intents WHERE state='prepared' ORDER BY created_at,operation_id LIMIT 201")?;
        let intents=query.query_map([],|r|Ok(Intent {
            operation_id:r.get(0)?,root:r.get(1)?,file_path:r.get(2)?,
            before_hash:r.get(3)?,after_hash:r.get(4)?,state:r.get(5)?,
        }))?.collect::<std::result::Result<Vec<_>,_>>()?;
        if intents.len()>200 {return Err("prepared recovery intent budget exceeded; manual inspection required".into());}
        Ok(intents)
    }

    pub fn intent_status(&self,operation:&str)->Result<Option<Value>> {
        let row:Option<(String,String,Option<String>,Option<String>)>=self.db.query_row(
            "SELECT state,request_hash,result,error FROM file_commit_intents WHERE operation_id=?",
            [operation],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        Ok(row.map(|(state,hash,result,error)|json!({
            "state":state,"requestHash":hash,"result":result,"error":error
        })))
    }

    /// Called only after the coordinator verified durable file bytes and authorization.
    /// This method is DB finalization, not filesystem verification or a public RPC.
    pub(crate) fn finish_intent(&mut self,operation:&str,verified_hash:&str)->Result<Value> {
        self.verify_intent_receipt(operation)?;
        let context=self.load_commit_context(operation)?;
        let receipt_json:String=self.db.query_row(
            "SELECT validation_receipt FROM file_commit_intents WHERE operation_id=?",
            [operation],|r|r.get(0))?;
        let receipt:Value=serde_json::from_str(&receipt_json)?;
        let tx=self.db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let row:(String,String,String,String,String,String,String,Option<String>,Option<String>)=
            tx.query_row("SELECT state,request_hash,project_id,file_path,before_hash,after_hash,reason,maid,result
                FROM file_commit_intents WHERE operation_id=?",[operation],|r|Ok((
                    r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?
                )))?;
        let (state,request_hash,project,file,before,after,reason,maid,old_result)=row;
        if state=="committed" {
            return Ok(serde_json::from_str(old_result.as_deref().ok_or("committed intent missing result")?)?);
        }
        if state!="prepared" {return Err("only a prepared intent can finalize".into());}
        if after!=verified_hash {return Err("verified file hash differs from durable plan".into());}
        let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL)",
            [&project],|r|r.get(0))?;
        if !active {return Err("project deleted while file commit pending; recovery required".into());}
        context.verify_todos(&tx,&project)?;
        // Derive statistics from verified durable images, never caller-supplied numbers.
        // Only the hard byte/line ceilings can still fail here and roll back
        // finalization; a large in-place rewrite is estimated instead.
        let before_image=crate::text_snapshot::TextSnapshot::decode(Self::blob(&tx,&before)?)?;
        let after_image=crate::text_snapshot::TextSnapshot::decode(Self::blob(&tx,&after)?)?;
        let stats=crate::line_diff::stats_bounded(&before_image.text,&after_image.text)?;
        let added=i64::try_from(stats.added)?;
        let removed=i64::try_from(stats.removed)?;
        let ts:String=tx.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')",[],|r|r.get(0))?;
        crate::file_commit::record_external_snapshot(&tx,&project,&file,Some(&before),&ts)?;
        tx.execute("INSERT INTO batches(project_id,kind,reason,maid,created_at) VALUES (?,'edit',?,?,?)",
            params![project,reason,maid,ts])?;
        let batch=tx.last_insert_rowid();
        let primary_todo=context.todos.first().map(|todo|todo.id);
        tx.execute("INSERT INTO nodes(project_id,batch_id,file_path,op,before_hash,after_hash,todo_id,reason,summary,added,removed,created_at)
            VALUES (?,?,?,'edit',?,?,?,?,?,?,?,?)",params![project,batch,file,before,after,
                primary_todo,context.node_reason,context.summary,added,removed,ts])?;
        let node=tx.last_insert_rowid();
        for todo in &context.todos {
            tx.execute("UPDATE todos SET status='doing',updated_by=?,updated_at=?
                WHERE project_id=? AND id=? AND seq=? AND status='pending'",
                params![maid,ts,project,todo.id,todo.seq])?;
        }
        tx.execute("INSERT INTO file_state(project_id,file_path,hash) VALUES (?,?,?)
            ON CONFLICT(project_id,file_path) DO UPDATE SET hash=excluded.hash",params![project,file,after])?;
        tx.execute("UPDATE projects SET updated_at=? WHERE id=?",params![ts,project])?;
        let result=json!({"operationId":operation,"status":"ok","batchId":batch,"nodeId":node,
            "projectId":project,"reason":reason,
            "afterHash":after,"filePath":file,"applied":context.outcome["applied"],
            "placements":context.outcome["placements"],
            "skipped":context.outcome["errors"],"review":receipt["review"]});
        let encoded=serde_json::to_string(&result)?;
        tx.execute("INSERT INTO service_operations(id,request_hash,result,created_at) VALUES (?,?,?,?)",
            params![operation,request_hash,encoded,ts])?;
        let updated=tx.execute("UPDATE file_commit_intents SET state='committed',result=?,error=NULL,updated_at=?
            WHERE operation_id=? AND state='prepared'",params![encoded,ts,operation])?;
        if updated!=1 {return Err("intent state changed during finalization".into());}
        tx.commit()?;
        Ok(result)
    }
    /// Conflicts retain the before/after snapshots and validation receipt, mark the
    /// intent as conflict, and release the resource lock immediately.
    pub fn conflict_intent(&mut self,operation:&str,message:&str)->Result<()> {
        let message:String=message.chars().take(2000).collect();
        let n=self.db.execute("UPDATE file_commit_intents SET state='conflict',error=?,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE operation_id=? AND state IN ('prepared','conflict')",params![message,operation])?;
        if n!=1 {return Err("intent is not recoverable".into());}
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn context_image_evidence_rejects_structurally_valid_corruption() {
        let dir=tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"),"甲\n乙\n").unwrap();
        let steps:Vec<crate::edit::Step>=serde_json::from_value(json!([
            {"step":1,"op":"target","target":"甲","replace":"猫"},
            {"step":2,"op":"target","target":"乙","replace":"末"}
        ])).unwrap();
        let crate::edit_pipeline::Preparation::Ready(ready)=crate::edit_pipeline::prepare(
            dir.path(),"a.txt",&[dir.path().to_path_buf()],&steps,false).unwrap()
            else {panic!("plan")};
        let context=CommitContext::from_plan(&ready,&steps).unwrap();
        context.verify_images(&ready.snapshot.original,&ready.plan.bytes).unwrap();
        let original=serde_json::to_value(&context).unwrap();
        for mode in ["boundary","line","missing","duplicate","step","gap","changed"] {
            let mut damaged=original.clone();
            match mode {
                "boundary"=>damaged["outcome"]["placements"][0]["originalEndByte"]=json!(1),
                "line"=>damaged["outcome"]["placements"][0]["newStartLine"]=json!(99),
                "missing"=>{damaged["outcome"]["placements"].as_array_mut().unwrap().pop();},
                "duplicate"=>damaged["outcome"]["applied"]=json!([1,1]),
                "step"=>damaged["outcome"]["placements"][0]["step"]=json!(99),
                "gap"=>damaged["outcome"]["placements"][0]["newStartByte"]=json!(3),
                _=>damaged["outcome"]["changed"]=json!(false),
            }
            let damaged:CommitContext=serde_json::from_value(damaged).unwrap();
            assert!(damaged.verify_images(&ready.snapshot.original,&ready.plan.bytes).is_err(),"{mode}");
        }
    }

    #[test]
    fn diff_budget_failure_precedes_intent_and_file_mutation() {
        let dir=tempfile::tempdir().unwrap();
        let mut store=Store::open(&dir.path().join("pf.db")).unwrap();
        store.mutate("store.createProject",&json!({
            "operationId":"create","projectId":"p1","name":"test","root":dir.path().to_str().unwrap()
        })).unwrap();
        // 1001-line mid-section rewrite now uses bounded linear stats instead of blocking commit.
        let medium="a\n".repeat(1001);
        std::fs::write(dir.path().join("mid.txt"),&medium).unwrap();
        let mid_steps:Vec<crate::edit::Step>=serde_json::from_value(json!([
            {"step":1,"op":"replace","start":1,"end":1001,"content":"b\n".repeat(1001)}
        ])).unwrap();
        let crate::edit_pipeline::Preparation::Ready(mid_ready)=crate::edit_pipeline::prepare(
            dir.path(),"mid.txt",&[dir.path().to_path_buf()],&mid_steps,false).unwrap() else {panic!("mid plan")};
        store.prepare_intent("mid-rewrite",&digest(b"mid-request"),"p1",&mid_ready,"test",None).unwrap();

        // Exceeding hard line ceiling (>200_000 lines) still fails before intent creation or file mutation.
        let original="a\n".repeat(200_001);
        std::fs::write(dir.path().join("a.txt"),&original).unwrap();
        let steps:Vec<crate::edit::Step>=serde_json::from_value(json!([
            {"step":1,"op":"replace","start":1,"end":2,"content":"b\n"}
        ])).unwrap();
        let crate::edit_pipeline::Preparation::Ready(ready)=crate::edit_pipeline::prepare(
            dir.path(),"a.txt",&[dir.path().to_path_buf()],&steps,false).unwrap() else {panic!("plan")};
        assert!(store.prepare_intent("oversized",&digest(b"request"),"p1",&ready,"test",None).is_err());
        assert!(store.intent_status("oversized").unwrap().is_none());
        assert_eq!(store.pending_intents().unwrap().len(),1);
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),original);
    }
    #[test]
    fn file_replacement_finalizes_once_and_db_failure_keeps_intent() {
        let dir=tempfile::tempdir().unwrap();
        let db=dir.path().join("pf.db");
        let mut store=Store::open(&db).unwrap();
        store.mutate("store.createProject",&json!({
            "operationId":"create","projectId":"p1","name":"test","root":dir.path().to_str().unwrap()
        })).unwrap();
        let file=dir.path().join("a.txt");
        std::fs::write(&file,b"before").unwrap();
        let steps=serde_json::from_value::<Vec<crate::edit::Step>>(json!([
            {"step":1,"op":"target","target":"before","replace":"after"}
        ])).unwrap();
        let crate::edit_pipeline::Preparation::Ready(ready)=crate::edit_pipeline::prepare(
            dir.path(),"a.txt",&[dir.path().to_path_buf()],&steps,false).unwrap() else {panic!("plan")};
        store.prepare_intent("edit",&digest(b"request"),"p1",&ready,"native edit",Some("Kerr")).unwrap();
        assert_eq!(store.query("operation.status",&json!({"operationId":"edit"})).unwrap()["state"],"prepared");
        assert!(store.mutate("store.createProject",&json!({
            "operationId":"edit","projectId":"p2","name":"bad","root":"root"
        })).is_err());
        assert!(store.finish_intent("edit","wrong").is_err());
        crate::file_replace::replace_existing(&ready.path,&ready.plan.expected_hash,&ready.plan.bytes).unwrap();
        // Inject SQL failure AFTER the batch INSERT, before the node can be recorded.
        store.db.execute_batch("CREATE TRIGGER fail_node BEFORE INSERT ON nodes
            BEGIN SELECT RAISE(ABORT,'injected finalization failure'); END;").unwrap();
        assert!(store.finish_intent("edit",&ready.plan.after_hash).is_err());
        assert_eq!(store.db.query_row("SELECT COUNT(*) FROM batches",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(store.pending_intents().unwrap().len(),1);
        assert_eq!(std::fs::read(&file).unwrap(),b"after");
        store.db.execute_batch("DROP TRIGGER fail_node").unwrap();
        drop(store);
        let mut store=Store::open(&db).unwrap();
        let result=store.finish_intent("edit",&ready.plan.after_hash).unwrap();
        assert_eq!(store.finish_intent("edit",&ready.plan.after_hash).unwrap(),result);
        let stats=store.query("store.projectStats",&json!({"projectId":"p1"})).unwrap();
        assert_eq!(stats["added"],1);
        assert_eq!(stats["removed"],1);
        assert!(store.pending_intents().unwrap().is_empty());
        let status=store.query("operation.status",&json!({"operationId":"edit"})).unwrap();
        assert_eq!(status["state"],"committed");
        assert_eq!(status["result"],result);
        assert_eq!(store.query("store.timeline",&json!({"projectId":"p1"})).unwrap().as_array().unwrap().len(),1);
    }
    #[test]
    fn durable_intent_survives_restart_and_excludes_conflicting_project() {
        let dir=tempfile::tempdir().unwrap();
        let file=dir.path().join("a.txt");
        std::fs::write(&file,b"before").unwrap();
        let db=dir.path().join("pf.db");
        let mut store=Store::open(&db).unwrap();
        for id in ["p1","p2"] {
            store.mutate("store.createProject",&json!({
                "operationId":format!("create-{id}"),"projectId":id,"name":id,"root":dir.path().to_str().unwrap()
            })).unwrap();
        }
        let steps=serde_json::from_value::<Vec<crate::edit::Step>>(json!([
            {"step":1,"op":"target","target":"before","replace":"after"}
        ])).unwrap();
        let crate::edit_pipeline::Preparation::Ready(ready)=crate::edit_pipeline::prepare(
            dir.path(),"a.txt",&[dir.path().to_path_buf()],&steps,false).unwrap() else {panic!("plan")};
        let request_hash=digest(b"immutable request");
        store.prepare_intent("edit-1",&request_hash,"p1",&ready,"test",Some("Kerr")).unwrap();
        assert!(store.prepare_intent("edit-2",&request_hash,"p2",&ready,"test",None).is_err());
        assert_eq!(std::fs::read(&file).unwrap(),b"before");
        drop(store);
        let mut store=Store::open(&db).unwrap();
        let pending=store.pending_intents().unwrap();
        assert_eq!(pending.len(),1);
        assert_eq!(pending[0].operation_id,"edit-1");
        assert_eq!(pending[0].file_path,"a.txt");
        assert_eq!(pending[0].root,ready.path.root.to_str().unwrap());
        assert_eq!(pending[0].before_hash,ready.snapshot.hash);
        assert_eq!(pending[0].after_hash,ready.plan.after_hash);
        assert_eq!(pending[0].state,"prepared");
        let roots=vec![dir.path().to_path_buf()];
        assert_eq!(inspect_intent(&pending[0],&roots).unwrap(),RecoveryPosition::Before);
        assert_eq!(inspect_intent(&pending[0],&[]).unwrap(),RecoveryPosition::Conflict);
        std::fs::write(&file,b"after").unwrap();
        assert_eq!(inspect_intent(&pending[0],&roots).unwrap(),RecoveryPosition::After);
        std::fs::write(&file,b"external content").unwrap();
        assert_eq!(inspect_intent(&pending[0],&roots).unwrap(),RecoveryPosition::Conflict);
        assert_eq!(std::fs::read(&file).unwrap(),b"external content");
        std::fs::remove_file(&file).unwrap();
        assert_eq!(inspect_intent(&pending[0],&roots).unwrap(),RecoveryPosition::Conflict);
        store.conflict_intent("edit-1","external content").unwrap();
        assert_eq!(store.intent_status("edit-1").unwrap().unwrap()["state"],"conflict");
        store.prepare_intent("edit-3",&request_hash,"p2",&ready,"test",None).unwrap();
    }

    /// Real-table row counts: durability claims are made against SQLite, never mocks.
    fn journal_count(store:&Store,table:&str)->i64 {
        store.db.query_row(&format!("SELECT COUNT(*) FROM {table}"),[],|r|r.get(0)).unwrap()
    }

    #[test]
    fn replayed_operation_id_never_replans_and_commit_releases_resource_lock() {
        let dir=tempfile::tempdir().unwrap();
        let db=dir.path().join("pf.db");
        let file=dir.path().join("a.txt");
        std::fs::write(&file,b"before").unwrap();
        let mut store=Store::open(&db).unwrap();
        store.mutate("store.createProject",&json!({
            "operationId":"create","projectId":"p1","name":"test","root":dir.path().to_str().unwrap()
        })).unwrap();
        let steps=serde_json::from_value::<Vec<crate::edit::Step>>(json!([
            {"step":1,"op":"target","target":"before","replace":"after"}
        ])).unwrap();
        let crate::edit_pipeline::Preparation::Ready(ready)=crate::edit_pipeline::prepare(
            dir.path(),"a.txt",&[dir.path().to_path_buf()],&steps,false).unwrap() else {panic!("plan")};
        let request_hash=digest(b"immutable request");
        store.prepare_intent("edit",&request_hash,"p1",&ready,"test",Some("Kerr")).unwrap();
        assert_eq!(journal_count(&store,"file_commit_intents"),1);
        assert_eq!(journal_count(&store,"blobs"),2);
        // A repeated operation identity must be answered from the durable intent:
        // no second row, no extra image and no second plan against current bytes.
        let replay=store.prepare_intent("edit",&request_hash,"p1",&ready,"test",None).unwrap_err().to_string();
        assert!(replay.contains("already exists"),"{replay}");
        assert_eq!(journal_count(&store,"file_commit_intents"),1);
        assert_eq!(journal_count(&store,"blobs"),2);
        assert_eq!(std::fs::read(&file).unwrap(),b"before");
        crate::file_replace::replace_existing(&ready.path,&ready.plan.expected_hash,&ready.plan.bytes).unwrap();
        let committed=store.finish_intent("edit",&ready.plan.after_hash).unwrap();
        // A committed operation is still single-truth: replay is refused, result is reused.
        let replay=store.prepare_intent("edit",&request_hash,"p1",&ready,"test",None).unwrap_err().to_string();
        assert!(replay.contains("already exists"),"{replay}");
        assert_eq!(journal_count(&store,"file_commit_intents"),1);
        let status=store.query("operation.status",&json!({"operationId":"edit"})).unwrap();
        assert_eq!(status["state"],"committed");
        assert_eq!(status["result"],committed);
        // Committed is terminal: a late conflict marker cannot reopen it.
        assert!(store.conflict_intent("edit","late conflict").is_err());
        assert_eq!(store.intent_status("edit").unwrap().unwrap()["state"],"committed");
        // The partial unique index must release the resource on commit, or the next
        // legitimate edit of this file would be blocked forever.
        let next_steps=serde_json::from_value::<Vec<crate::edit::Step>>(json!([
            {"step":1,"op":"target","target":"after","replace":"final"}
        ])).unwrap();
        let crate::edit_pipeline::Preparation::Ready(next)=crate::edit_pipeline::prepare(
            dir.path(),"a.txt",&[dir.path().to_path_buf()],&next_steps,false).unwrap() else {panic!("next plan")};
        store.prepare_intent("edit-2",&digest(b"second request"),"p1",&next,"test",None).unwrap();
        assert_eq!(journal_count(&store,"file_commit_intents"),2);
        assert_eq!(std::fs::read(&file).unwrap(),b"after");
    }

    #[test]
    fn conflict_retains_snapshots_and_receipt_and_releases_resource_lock() {
        let dir=tempfile::tempdir().unwrap();
        let db=dir.path().join("pf.db");
        let file=dir.path().join("a.txt");
        std::fs::write(&file,b"before").unwrap();
        let mut store=Store::open(&db).unwrap();
        store.mutate("store.createProject",&json!({
            "operationId":"create","projectId":"p1","name":"test","root":dir.path().to_str().unwrap()
        })).unwrap();
        let steps=serde_json::from_value::<Vec<crate::edit::Step>>(json!([
            {"step":1,"op":"target","target":"before","replace":"after"}
        ])).unwrap();
        let crate::edit_pipeline::Preparation::Ready(ready)=crate::edit_pipeline::prepare(
            dir.path(),"a.txt",&[dir.path().to_path_buf()],&steps,false).unwrap() else {panic!("plan")};
        store.prepare_intent("edit",&digest(b"request"),"p1",&ready,"test",Some("Kerr")).unwrap();
        // Third-party bytes: the intent becomes a conflict, but both snapshots, the
        // receipt and the commit context must stay intact for audit.
        std::fs::write(&file,b"external content").unwrap();
        store.conflict_intent("edit","external content").unwrap();
        assert_eq!(journal_count(&store,"blobs"),2);
        store.verify_intent_receipt("edit").unwrap();
        let intent=store.load_intent("edit").unwrap();
        assert_eq!(intent.state,"conflict");
        assert_eq!(intent.before_hash,ready.snapshot.hash);
        assert_eq!(intent.after_hash,ready.plan.after_hash);
        assert_eq!(Store::blob(&store.db,&intent.before_hash).unwrap(),b"before");
        assert_eq!(Store::blob(&store.db,&intent.after_hash).unwrap(),b"after");
        // A conflict can never finalize, and the refused attempt leaves no batch, node
        // or file_state row behind.
        assert!(store.finish_intent("edit",&ready.plan.after_hash).is_err());
        assert_eq!(journal_count(&store,"batches"),0);
        assert_eq!(journal_count(&store,"nodes"),0);
        assert_eq!(journal_count(&store,"file_state"),0);
        assert!(store.prepared_intents().unwrap().is_empty());
        assert!(store.pending_intents().unwrap().is_empty());
        // The conflict releases the lock immediately: a new operation may claim the
        // same resource without restarting or reconciling the old audit row.
        let next_steps=serde_json::from_value::<Vec<crate::edit::Step>>(json!([
            {"step":1,"op":"target","target":"external","replace":"repaired"}
        ])).unwrap();
        let crate::edit_pipeline::Preparation::Ready(next)=crate::edit_pipeline::prepare(
            dir.path(),"a.txt",&[dir.path().to_path_buf()],&next_steps,false).unwrap() else {panic!("next plan")};
        store.prepare_intent("edit-2",&digest(b"other request"),"p1",&next,"test",None).unwrap();
        assert_eq!(journal_count(&store,"file_commit_intents"),2);
        assert_eq!(std::fs::read(&file).unwrap(),b"external content");
        drop(store);
        let store=Store::open(&db).unwrap();
        let conflict=store.load_intent("edit").unwrap();
        assert_eq!(conflict.state,"conflict");
        assert_eq!(conflict.before_hash,ready.snapshot.hash);
        assert_eq!(conflict.after_hash,ready.plan.after_hash);
        assert_eq!(store.prepared_intents().unwrap()[0].operation_id,"edit-2");
        assert_eq!(store.pending_intents().unwrap()[0].operation_id,"edit-2");
        assert_eq!(journal_count(&store,"blobs"),4);
        store.verify_intent_receipt("edit").unwrap();
        assert_eq!(store.load_commit_context("edit").unwrap().outcome["applied"].as_array().unwrap().len(),1);
    }

    #[test]
    fn failure_at_last_finalization_write_rolls_back_whole_batch_then_recovers() {
        let dir=tempfile::tempdir().unwrap();
        let db=dir.path().join("pf.db");
        let file=dir.path().join("a.txt");
        std::fs::write(&file,b"before").unwrap();
        let mut store=Store::open(&db).unwrap();
        store.mutate("store.createProject",&json!({
            "operationId":"create","projectId":"p1","name":"test","root":dir.path().to_str().unwrap()
        })).unwrap();
        // A sentinel timestamp makes "did finalization touch the project row" decidable.
        store.db.execute("UPDATE projects SET updated_at='2000-01-01T00:00:00.000Z' WHERE id=?1",
            ["p1"]).unwrap();
        let steps=serde_json::from_value::<Vec<crate::edit::Step>>(json!([
            {"step":1,"op":"target","target":"before","replace":"after"}
        ])).unwrap();
        let crate::edit_pipeline::Preparation::Ready(ready)=crate::edit_pipeline::prepare(
            dir.path(),"a.txt",&[dir.path().to_path_buf()],&steps,false).unwrap() else {panic!("plan")};
        store.prepare_intent("edit",&digest(b"request"),"p1",&ready,"test",None).unwrap();
        crate::file_replace::replace_existing(&ready.path,&ready.plan.expected_hash,&ready.plan.bytes).unwrap();
        // Fail the LAST write of finalization (operation log), after batch, node,
        // todo and file_state were already written inside the same transaction.
        store.db.execute_batch("CREATE TRIGGER fail_operation BEFORE INSERT ON service_operations
            BEGIN SELECT RAISE(ABORT,'injected last write failure'); END;").unwrap();
        assert!(store.finish_intent("edit",&ready.plan.after_hash).is_err());
        assert_eq!(journal_count(&store,"batches"),0);
        assert_eq!(journal_count(&store,"nodes"),0);
        assert_eq!(journal_count(&store,"file_state"),0);
        assert_eq!(store.db.query_row("SELECT COUNT(*) FROM service_operations WHERE id='edit'",
            [],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(store.db.query_row("SELECT updated_at FROM projects WHERE id='p1'",
            [],|r|r.get::<_,String>(0)).unwrap(),"2000-01-01T00:00:00.000Z");
        // Only the durable intent survives as the recovery handle; bytes are already the
        // planned ones, so recovery must finish instead of replanning.
        assert_eq!(store.intent_status("edit").unwrap().unwrap()["state"],"prepared");
        assert_eq!(store.pending_intents().unwrap().len(),1);
        assert_eq!(std::fs::read(&file).unwrap(),b"after");
        store.db.execute_batch("DROP TRIGGER fail_operation").unwrap();
        drop(store);
        let mut store=Store::open(&db).unwrap();
        let result=store.finish_intent("edit",&ready.plan.after_hash).unwrap();
        assert_eq!(journal_count(&store,"batches"),1);
        assert_eq!(journal_count(&store,"nodes"),1);
        assert_eq!(journal_count(&store,"file_state"),1);
        // Replaying the recovery is idempotent: same receipt, still one batch and node.
        assert_eq!(store.finish_intent("edit",&ready.plan.after_hash).unwrap(),result);
        assert_eq!(journal_count(&store,"batches"),1);
        assert_eq!(journal_count(&store,"nodes"),1);
        assert_eq!(store.db.query_row("SELECT hash FROM file_state WHERE project_id='p1' AND file_path='a.txt'",
            [],|r|r.get::<_,String>(0)).unwrap(),ready.plan.after_hash);
        assert_ne!(store.db.query_row("SELECT updated_at FROM projects WHERE id='p1'",
            [],|r|r.get::<_,String>(0)).unwrap(),"2000-01-01T00:00:00.000Z");
        assert!(store.pending_intents().unwrap().is_empty());
    }
}