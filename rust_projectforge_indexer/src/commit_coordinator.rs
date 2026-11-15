//! Internal single-file recovery coordinator. Not a production RPC.
//! Optimistic external-writer race and platform metadata acceptance remain open.
use std::path::{Path,PathBuf};
use serde_json::Value;
use crate::{storage::{Store,Result},commit_journal::{Intent,RecoveryPosition,inspect_intent},
    text_snapshot::TextSnapshot};

pub fn resume(store:&mut Store,intent:&Intent,allowed_roots:&[PathBuf])->Result<Value> {
    // Input contributes only an ID. Paths, hashes and state come from durable storage.
    let durable=store.load_intent(&intent.operation_id)?;
    let intent=&durable;
    if intent.state!="prepared" {return Err("intent is not prepared".into());}
    if let Err(error)=store.verify_intent_receipt(&intent.operation_id) {
        store.conflict_intent(&intent.operation_id,"validation receipt missing, invalid or incompatible")?;
        return Err(format!("recovery validation evidence rejected: {error}").into());
    }
    let active:bool=store.db.query_row(
        "SELECT EXISTS(SELECT 1 FROM file_commit_intents i JOIN projects p ON p.id=i.project_id
         WHERE i.operation_id=? AND p.deleted_at IS NULL)",
        [&intent.operation_id],|r|r.get(0))?;
    if !active {
        store.conflict_intent(&intent.operation_id,"project deleted before recovery application")?;
        return Err("project deleted; file contents preserved".into());
    }
    let position=inspect_intent(intent,allowed_roots)?;
    if position==RecoveryPosition::Conflict {
        store.conflict_intent(&intent.operation_id,"recovery path unauthorized, missing or changed")?;
        return Err("file commit conflict; current contents preserved".into());
    }
    let path=crate::project_path::resolve(Path::new(&intent.root),&intent.file_path,false)?;
    // Use the durable target bytes, never a newly calculated edit result.
    let bytes=Store::blob(&store.db,&intent.after_hash)?;
    let proposed=TextSnapshot::decode(bytes)?;
    if proposed.hash!=intent.after_hash {return Err("durable target identity mismatch".into());}
    if position==RecoveryPosition::Before {
        // A failed replacement can have happened after rename. If the planned bytes
        // did not land, preserve the audit snapshots, release the lock and report the
        // conflict; an After image stays prepared for database catch-up on restart.
        if let Err(error)=crate::file_replace::replace_existing(&path,&intent.before_hash,&proposed.original) {
            if inspect_intent(intent,allowed_roots)? != RecoveryPosition::After {
                store.conflict_intent(&intent.operation_id,
                    "file replacement failed before planned bytes became durable")?;
            }
            return Err(format!("file replacement failed: {error}").into());
        }
    }
    let checked=crate::project_path::resolve(Path::new(&intent.root),&intent.file_path,false)?;
    if !allowed_roots.iter().any(|r|r.canonicalize().is_ok_and(|r|checked.root.starts_with(r))) {
        store.conflict_intent(&intent.operation_id,"authorization changed before finalization")?;
        return Err("authorization changed; recovery required".into());
    }
    let current=TextSnapshot::read(&checked.absolute)?;
    if current.hash!=intent.after_hash {
        store.conflict_intent(&intent.operation_id,"file changed before database finalization")?;
        return Err("file changed; current contents preserved".into());
    }
    store.finish_intent(&intent.operation_id,&current.hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest,Sha256};

    #[test]
    fn restart_resumes_before_and_after_windows_without_replanning() {
        for already_applied in [false,true] {
            let dir=tempfile::tempdir().unwrap();
            let db=dir.path().join("pf.db");
            let file=dir.path().join("a.txt");
            std::fs::write(&file,b"before\n").unwrap();
            let mut store=Store::open(&db).unwrap();
            store.mutate("store.createProject",&json!({
                "operationId":"create","projectId":"p1","name":"test","root":dir.path().to_str().unwrap()
            })).unwrap();
            let steps:Vec<crate::edit::Step>=serde_json::from_value(json!([
                {"step":1,"op":"target","target":"before","replace":"after"}
            ])).unwrap();
            let roots=vec![dir.path().to_path_buf()];
            let crate::edit_pipeline::Preparation::Ready(ready)=crate::edit_pipeline::prepare(
                dir.path(),"a.txt",&roots,&steps,false).unwrap() else {panic!("plan")};
            store.prepare_intent("edit",&format!("{:x}",Sha256::digest(b"request")),"p1",&ready,"test",None).unwrap();
            if already_applied {
                crate::file_replace::replace_existing(&ready.path,&ready.plan.expected_hash,&ready.plan.bytes).unwrap();
            }
            drop(store);
            let mut store=Store::open(&db).unwrap();
            let mut intent=store.pending_intents().unwrap().remove(0);
            // Stale/tampered in-memory metadata cannot redirect recovery.
            intent.file_path="not-the-authoritative-file.txt".into();
            intent.before_hash="wrong".into();
            let result=resume(&mut store,&intent,&roots).unwrap();
            assert_eq!(std::fs::read(&file).unwrap(),b"after\n");
            assert_eq!(store.query("operation.status",&json!({"operationId":"edit"})).unwrap()["result"],result);
            assert!(store.pending_intents().unwrap().is_empty());
            // Stale recovery work may not create another history node.
            assert!(resume(&mut store,&intent,&roots).is_err());
            assert_eq!(store.query("store.projectStats",&json!({"projectId":"p1"})).unwrap()["nodeCount"],1);
        }
    }

    #[test]
    fn invalid_validation_evidence_never_applies_durable_bytes() {
        for mode in ["missing", "malformed", "wrong-path", "missing-context", "malformed-context"] {
            let dir=tempfile::tempdir().unwrap();
            let file=dir.path().join("a.txt");
            std::fs::write(&file,b"before").unwrap();
            let mut store=Store::open(&dir.path().join("pf.db")).unwrap();
            store.mutate("store.createProject",&json!({
                "operationId":"create","projectId":"p1","name":"test",
                "root":dir.path().to_str().unwrap()
            })).unwrap();
            let roots=vec![dir.path().to_path_buf()];
            let steps=serde_json::from_value::<Vec<crate::edit::Step>>(json!([
                {"step":1,"op":"target","target":"before","replace":"after"}
            ])).unwrap();
            let crate::edit_pipeline::Preparation::Ready(ready)=crate::edit_pipeline::prepare(
                dir.path(),"a.txt",&roots,&steps,false).unwrap() else {panic!("plan")};
            store.prepare_intent("edit",&format!("{:x}",Sha256::digest(b"request")),
                "p1",&ready,"test",None).unwrap();
            let damaged:Option<String>=match mode {
                "missing"=>None,
                "malformed"=>Some("{".into()),
                "missing-context"|"malformed-context"=>Some(store.db.query_row(
                    "SELECT validation_receipt FROM file_commit_intents WHERE operation_id='edit'",
                    [],|r|r.get(0)).unwrap()),
                _=>{
                    let encoded:String=store.db.query_row(
                        "SELECT validation_receipt FROM file_commit_intents WHERE operation_id='edit'",
                        [],|r|r.get(0)).unwrap();
                    let mut receipt:serde_json::Value=serde_json::from_str(&encoded).unwrap();
                    receipt["review"]["file_path"]=json!("other.txt");
                    Some(serde_json::to_string(&receipt).unwrap())
                }
            };
            store.db.execute("UPDATE file_commit_intents SET validation_receipt=? WHERE operation_id='edit'",
                [damaged]).unwrap();
            if matches!(mode,"missing-context"|"malformed-context") {
                let context:Option<&str>=if mode=="missing-context" {None} else {Some("{")};
                store.db.execute("UPDATE file_commit_intents SET commit_context=? WHERE operation_id='edit'",
                    [context]).unwrap();
            }
            let intent=store.load_intent("edit").unwrap();
            assert!(resume(&mut store,&intent,&roots).is_err(),"{mode}");
            assert_eq!(std::fs::read(&file).unwrap(),b"before");
            assert_eq!(store.intent_status("edit").unwrap().unwrap()["state"],"conflict");
            assert_eq!(store.query("store.projectStats",&json!({"projectId":"p1"})).unwrap()["nodeCount"],0);
        }
    }

    #[test]
    fn todo_identity_and_finalization_are_recovery_safe() {
        for deleted in [false,true] {
            let dir=tempfile::tempdir().unwrap();
            let file=dir.path().join("a.txt");
            std::fs::write(&file,b"before").unwrap();
            let mut store=Store::open(&dir.path().join("pf.db")).unwrap();
            store.mutate("store.createProject",&json!({
                "operationId":"create","projectId":"p1","name":"test",
                "root":dir.path().to_str().unwrap()
            })).unwrap();
            store.db.execute("INSERT INTO todos(project_id,seq,title,status,updated_at)
                VALUES ('p1',1,'bound','pending','t')",[]).unwrap();
            let todo_id=store.db.last_insert_rowid();
            let roots=vec![dir.path().to_path_buf()];
            let steps:Vec<crate::edit::Step>=serde_json::from_value(json!([
                {"step":1,"op":"target","target":"before","replace":"after"}
            ])).unwrap();
            let crate::edit_pipeline::Preparation::Ready(ready)=crate::edit_pipeline::prepare(
                dir.path(),"a.txt",&roots,&steps,false).unwrap() else {panic!("plan")};
            store.prepare_intent("edit",&format!("{:x}",Sha256::digest(b"request")),
                "p1",&ready,"test",Some("Kerr")).unwrap();
            let mut context=store.load_commit_context("edit").unwrap();
            context.todos.push(crate::commit_journal::TodoBinding{id:todo_id,seq:1});
            store.db.execute("UPDATE file_commit_intents SET commit_context=? WHERE operation_id='edit'",
                [serde_json::to_string(&context).unwrap()]).unwrap();
            let intent=store.load_intent("edit").unwrap();
            if deleted {
                store.db.execute("DELETE FROM todos WHERE id=?",[todo_id]).unwrap();
                store.db.execute("INSERT INTO todos(project_id,seq,title,status,updated_at)
                    VALUES ('p1',1,'replacement','pending','t')",[]).unwrap();
                assert_ne!(store.db.last_insert_rowid(),todo_id);
                assert!(resume(&mut store,&intent,&roots).is_err());
                assert_eq!(std::fs::read(&file).unwrap(),b"before");
                assert_eq!(store.intent_status("edit").unwrap().unwrap()["state"],"conflict");
            } else {
                // Fail after todo UPDATE, verifying the whole DB finalization rolls back.
                store.db.execute_batch("CREATE TRIGGER fail_state BEFORE INSERT ON file_state
                    BEGIN SELECT RAISE(ABORT,'injected state failure'); END;").unwrap();
                assert!(resume(&mut store,&intent,&roots).is_err());
                assert_eq!(std::fs::read(&file).unwrap(),b"after");
                let status:String=store.db.query_row("SELECT status FROM todos WHERE id=?",
                    [todo_id],|r|r.get(0)).unwrap();
                assert_eq!(status,"pending");
                assert_eq!(store.query("store.projectStats",&json!({"projectId":"p1"}))
                    .unwrap()["nodeCount"],0);
                assert_eq!(store.intent_status("edit").unwrap().unwrap()["state"],"prepared");
                store.db.execute_batch("DROP TRIGGER fail_state").unwrap();
                let result=resume(&mut store,&intent,&roots).unwrap();
                let row:(String,Option<String>)=store.db.query_row(
                    "SELECT status,updated_by FROM todos WHERE id=?",
                    [todo_id],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
                assert_eq!(row,("doing".into(),Some("Kerr".into())));
                let node=store.query("store.getNode",&json!({
                    "projectId":"p1","nodeId":result["nodeId"]
                })).unwrap();
                assert_eq!(node["todo_id"],todo_id);
            }
        }
    }

    #[test]
    fn deleted_project_is_blocked_before_file_replacement() {
        let dir=tempfile::tempdir().unwrap();
        let mut store=Store::open(&dir.path().join("pf.db")).unwrap();
        let file=dir.path().join("a.txt");
        std::fs::write(&file,b"before").unwrap();
        store.mutate("store.createProject",&json!({
            "operationId":"create","projectId":"p1","name":"test","root":dir.path().to_str().unwrap()
        })).unwrap();
        let steps:Vec<crate::edit::Step>=serde_json::from_value(json!([
            {"step":1,"op":"target","target":"before","replace":"after"}
        ])).unwrap();
        let roots=vec![dir.path().to_path_buf()];
        let crate::edit_pipeline::Preparation::Ready(ready)=crate::edit_pipeline::prepare(
            dir.path(),"a.txt",&roots,&steps,false).unwrap() else {panic!("plan")};
        store.prepare_intent("edit",&format!("{:x}",Sha256::digest(b"request")),"p1",&ready,"test",None).unwrap();
        store.db.execute("UPDATE projects SET deleted_at='deleted' WHERE id='p1'",[]).unwrap();
        let intent=store.pending_intents().unwrap().remove(0);
        assert!(resume(&mut store,&intent,&roots).is_err());
        assert_eq!(std::fs::read(file).unwrap(),b"before");
        assert_eq!(store.intent_status("edit").unwrap().unwrap()["state"],"conflict");
        assert_eq!(store.query("store.projectStats",&json!({"projectId":"p1"})).unwrap()["nodeCount"],0);
    }
    #[test]
    fn external_content_is_preserved_and_resource_lock_is_released() {
        let dir=tempfile::tempdir().unwrap();
        let mut store=Store::open(&dir.path().join("pf.db")).unwrap();
        let file=dir.path().join("a.txt");
        std::fs::write(&file,b"before").unwrap();
        store.mutate("store.createProject",&json!({
            "operationId":"create","projectId":"p1","name":"test","root":dir.path().to_str().unwrap()
        })).unwrap();
        let steps:Vec<crate::edit::Step>=serde_json::from_value(json!([
            {"step":1,"op":"target","target":"before","replace":"after"}
        ])).unwrap();
        let roots=vec![dir.path().to_path_buf()];
        let crate::edit_pipeline::Preparation::Ready(ready)=crate::edit_pipeline::prepare(
            dir.path(),"a.txt",&roots,&steps,false).unwrap() else {panic!("plan")};
        store.prepare_intent("edit",&format!("{:x}",Sha256::digest(b"request")),"p1",&ready,"test",None).unwrap();
        std::fs::write(&file,b"external").unwrap();
        let intent=store.prepared_intents().unwrap().remove(0);
        assert!(resume(&mut store,&intent,&roots).is_err());
        assert_eq!(std::fs::read(&file).unwrap(),b"external");
        let conflict=store.load_intent("edit").unwrap();
        assert_eq!(conflict.state,"conflict");
        assert_eq!(Store::blob(&store.db,&conflict.before_hash).unwrap(),b"before");
        store.verify_intent_receipt("edit").unwrap();
        assert!(store.prepared_intents().unwrap().is_empty());
        assert!(store.pending_intents().unwrap().is_empty());
        assert_eq!(store.query("store.projectStats",&json!({"projectId":"p1"})).unwrap()["nodeCount"],0);
        // The conflict was released immediately; the same file can be prepared anew.
        let next_steps:Vec<crate::edit::Step>=serde_json::from_value(json!([
            {"step":1,"op":"target","target":"external","replace":"repaired"}
        ])).unwrap();
        let crate::edit_pipeline::Preparation::Ready(next)=crate::edit_pipeline::prepare(
            dir.path(),"a.txt",&roots,&next_steps,false).unwrap() else {panic!("next plan")};
        store.prepare_intent("edit-2",&format!("{:x}",Sha256::digest(b"other request")),
            "p1",&next,"test",None).unwrap();
        assert_eq!(store.load_intent("edit-2").unwrap().state,"prepared");
        assert_eq!(std::fs::read(&file).unwrap(),b"external");
    }
}