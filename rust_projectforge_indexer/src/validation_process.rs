//! Isolated ecosystem validation. Configuration is service-owned, not tool input.
//! Only the fixed worker's non-spawning adapters are enabled here.
//! Python requires process-tree supervision before enabling this runner.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use crate::validation::{self, Review};

pub struct ValidatorProcess {
    pub executable: PathBuf,
    pub worker: PathBuf,
    pub cwd: PathBuf,
    pub timeout: Duration,
}

async fn bounded_read(reader: &mut (impl AsyncRead + Unpin), limit: usize) -> Result<Vec<u8>, String> {
    let mut result = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = reader.read(&mut buffer).await.map_err(|e|e.to_string())?;
        if n == 0 { return Ok(result); }
        if n > limit.saturating_sub(result.len()) {
            return Err("validation pipe output budget exceeded".into());
        }
        result.extend_from_slice(&buffer[..n]);
    }
}

impl ValidatorProcess {
    pub async fn review(&self, file_path:&str, before:&str, after:&str)->Result<Review,String> {
        if self.timeout.is_zero() || self.timeout > Duration::from_secs(60) {
            return Err("validation timeout must be within 1..60000ms".into());
        }
        if !self.executable.is_absolute() || !self.worker.is_absolute() || !self.cwd.is_absolute() {
            return Err("validation runtime paths must be absolute".into());
        }
        let ext=Path::new(file_path).extension().and_then(|s|s.to_str())
            .unwrap_or("").to_ascii_lowercase();
        if !matches!(ext.as_str(),"js"|"cjs"|"mjs"|"css"|"json") {
            return Err("adapter not enabled in native process runner; Python needs process-tree supervision".into());
        }
        let input=validation::request(file_path,before,after)?;
        if input.len()>64*1024*1024 {return Err("validation wire input budget exceeded".into());}
        let mut command=Command::new(&self.executable);
        command.arg(&self.worker).current_dir(&self.cwd)
            .env("ELECTRON_RUN_AS_NODE","1").env("NODE_OPTIONS","")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let mut child=command.spawn().map_err(|e|format!("validation spawn failed: {e}"))?;
        let mut stdin=child.stdin.take().ok_or("missing worker stdin")?;
        let mut stdout=child.stdout.take().ok_or("missing worker stdout")?;
        let mut stderr=child.stderr.take().ok_or("missing worker stderr")?;
        let operation=async {
            let write=async {
                stdin.write_all(&input).await.map_err(|e|e.to_string())?;
                stdin.shutdown().await.map_err(|e|e.to_string())?;
                drop(stdin); // worker reads to EOF before analysis
                Ok::<(),String>(())
            };
            let out=bounded_read(&mut stdout,2*1024*1024);
            let err=bounded_read(&mut stderr,64*1024);
            let wait=async {child.wait().await.map_err(|e|e.to_string())};
            let (_,out,err,status)=tokio::try_join!(write,out,err,wait)?;
            if !status.success() {
                return Err(format!("validation worker failed ({status}): {}",
                    String::from_utf8_lossy(&err[..err.len().min(2000)])));
            }
            validation::decode(&out,file_path,before,after)
        };
        match tokio::time::timeout(self.timeout,operation).await {
            Ok(Ok(review))=>Ok(review),
            failure=>{
                // Reap even on overflow/write/read errors. Cancelling this future
                // still drops Child with kill_on_drop enabled.
                let _=child.start_kill();
                let cleanup=tokio::time::timeout(Duration::from_secs(3),child.wait()).await;
                match cleanup {
                    Ok(Ok(_)) => {}
                    Ok(Err(error)) => return Err(format!("validation reaping failed; termination unconfirmed: {error}")),
                    Err(_) => return Err("validation cleanup deadline exceeded; worker termination unconfirmed".into()),
                }
                match failure {
                    Ok(Err(error))=>Err(error),
                    Err(_)=>Err("validation deadline exceeded; no successful review".into()),
                    Ok(Ok(_))=>unreachable!(),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires PF_VALIDATOR_NODE; run explicitly with --ignored"]
    fn actual_node_json_validation_is_hash_bound() {
        let executable=PathBuf::from(std::env::var_os("PF_VALIDATOR_NODE")
            .expect("PF_VALIDATOR_NODE must name an absolute Node executable"));
        let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let runner=ValidatorProcess {
            executable,
            worker:root.join("VCPDistributedServer/Plugin/ProjectForge/validationWorker.cjs"),
            cwd:root,timeout:Duration::from_secs(10),
        };
        let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let review=runner.review("fixture.json","{}","{\"broken\":").await.unwrap();
            assert!(review.supported);
            assert!(review.rejects_syntax(true));
            assert!(runner.review("fixture.py","x=1","x=2").await.is_err());
            let dir=tempfile::tempdir().unwrap();
            let file=dir.path().join("a.json");
            std::fs::write(&file,b"{\"value\":1}\n").unwrap();
            let roots=vec![dir.path().to_path_buf()];
            let broken:Vec<crate::edit::Step>=serde_json::from_value(serde_json::json!([
                {"step":1,"op":"replace","start":1,"end":1,"content":"{\"value\":"}
            ])).unwrap();
            let result=crate::edit_pipeline::prepare_validated(
                dir.path(),"a.json",&roots,&broken,false,true,&runner).await.unwrap();
            let crate::edit_pipeline::ValidatedPreparation::SyntaxRejected(review)=result
                else {panic!("new syntax error must be rejected before commit")};
            assert!(review.rejects_syntax(true));
            let valid:Vec<crate::edit::Step>=serde_json::from_value(serde_json::json!([
                {"step":1,"op":"target","target":"1","replace":"2"}
            ])).unwrap();
            let result=crate::edit_pipeline::prepare_validated(
                dir.path(),"a.json",&roots,&valid,false,true,&runner).await.unwrap();
            let crate::edit_pipeline::ValidatedPreparation::Ready{edit,review}=result
                else {panic!("valid edit must have a validated native plan")};
            assert!(review.supported);
            assert_eq!(edit.plan.bytes,b"{\"value\":2}\n");
            assert_eq!(std::fs::read(&file).unwrap(),b"{\"value\":1}\n");
            let failed=ValidatorProcess {
                executable:runner.executable.clone(),worker:dir.path().join("missing-worker.cjs"),
                cwd:runner.cwd.clone(),timeout:runner.timeout,
            };
            assert!(crate::edit_pipeline::prepare_validated(
                dir.path(),"a.json",&roots,&valid,false,true,&failed).await.is_err());
            assert_eq!(std::fs::read(&file).unwrap(),b"{\"value\":1}\n");
            let ambiguous:Vec<crate::edit::Step>=serde_json::from_value(serde_json::json!([
                {"step":1,"op":"target","target":"missing","replace":"2"}
            ])).unwrap();
            let result=crate::edit_pipeline::prepare_validated(
                dir.path(),"a.json",&roots,&ambiguous,false,true,&failed).await.unwrap();
            let crate::edit_pipeline::ValidatedPreparation::PlanningRejected(outcome)=result
                else {panic!("invalid plan must not invoke missing validator")};
            assert_eq!(outcome.status,"error");
            // Real ecosystem review -> durable receipt -> restart -> native commit.
            let receipt=crate::validation::Receipt::bind(&edit,&review,true).unwrap();
            let db=dir.path().join("pf.db");
            let mut store=crate::storage::Store::open(&db).unwrap();
            store.mutate("store.createProject",&serde_json::json!({
                "operationId":"create","projectId":"p1","name":"real-validation",
                "root":dir.path().to_str().unwrap()
            })).unwrap();
            use sha2::{Digest,Sha256};
            let context=crate::commit_journal::CommitContext::from_plan(&edit,&valid).unwrap();
            store.prepare_validated_intent("edit",&format!("{:x}",Sha256::digest(b"immutable request")),
                "p1",&edit,"real Node validated edit",Some("Kerr"),&receipt,&context).unwrap();
            assert_eq!(std::fs::read(&file).unwrap(),b"{\"value\":1}\n");
            drop(store);
            let mut store=crate::storage::Store::open(&db).unwrap();
            let intent=store.load_intent("edit").unwrap();
            crate::commit_coordinator::resume(&mut store,&intent,&roots).unwrap();
            assert_eq!(std::fs::read(&file).unwrap(),b"{\"value\":2}\n");
            assert_eq!(store.query("store.projectStats",&serde_json::json!({"projectId":"p1"}))
                .unwrap()["nodeCount"],1);
            assert!(store.pending_intents().unwrap().is_empty());
            let command=serde_json::json!({
                "operationId":"service-edit","projectId":"p1","filePath":"a.json",
                "reason":"native service composition","maid":"Kerr",
                "steps":[{"step":1,"op":"target","target":"2","replace":"3"}]
            });
            let result=crate::edit_service::execute(&mut store,&command,&roots,&runner).await.unwrap();
            assert_eq!(std::fs::read(&file).unwrap(),b"{\"value\":3}\n");
            // Replay must not search for the now-absent target or invoke validation.
            let replay=crate::edit_service::execute(&mut store,&command,&roots,&failed).await.unwrap();
            assert_eq!(replay,result);
            let mut changed=command.clone();
            changed["reason"]=serde_json::json!("different immutable request");
            assert!(crate::edit_service::execute(&mut store,&changed,&roots,&runner).await.is_err());
            assert_eq!(store.query("store.projectStats",&serde_json::json!({"projectId":"p1"}))
                .unwrap()["nodeCount"],2);
            let tiny=ValidatorProcess {timeout:Duration::from_millis(1),..runner};
            assert!(tiny.review("fixture.json","{}","{}").await.is_err());
        });
    }
}