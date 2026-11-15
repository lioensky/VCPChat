//! Isolated ecosystem validation. Configuration is service-owned, not tool input.
//! The fixed worker chooses the ecosystem adapter; this runner contains the
//! worker and every descendant it spawns, including Python's py_compile child.
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use crate::validation::{self, Review};

/// Owns OS-level containment for the worker and every descendant it creates.
/// Windows uses a kill-on-close Job Object; Unix uses a dedicated process group.
struct ProcessTree {
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
    #[cfg(unix)]
    pid: i32,
}

#[cfg(windows)]
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
unsafe impl Sync for ProcessTree {}

// POSIX kill(2): the Unix process-group leader is the worker itself.
#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}
#[cfg(unix)]
const UNIX_SIGKILL: i32 = 9;
#[cfg(unix)]
const UNIX_ESRCH: i32 = 3;

impl ProcessTree {
    fn attach(child: &Child) -> Result<Self, String> {
        #[cfg(windows)]
        {
            use std::ffi::c_void;
            use std::mem::{size_of, zeroed};
            use windows_sys::Win32::System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            };
            let process = child.raw_handle().ok_or("validation child handle unavailable")?;
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err("validation job creation failed".into());
                }
                let tree = Self { job };
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err("validation job configuration failed".into());
                }
                if AssignProcessToJobObject(job, process) == 0 {
                    return Err("validation process-tree assignment failed".into());
                }
                Ok(tree)
            }
        }
        #[cfg(unix)]
        {
            let pid = child.id().ok_or("validation child pid unavailable")?;
            Ok(Self {
                pid: i32::try_from(pid).map_err(|_| "validation child pid overflow")?,
            })
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = child;
            Err("validation process-tree supervision unsupported on this platform".into())
        }
    }

    fn terminate(&self) -> Result<(), String> {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::JobObjects::TerminateJobObject;
            if TerminateJobObject(self.job, 1) == 0 {
                return Err("validation job termination failed".into());
            }
            Ok(())
        }
        #[cfg(unix)]
        unsafe {
            if kill(-self.pid, UNIX_SIGKILL) == 0 {
                return Ok(());
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(UNIX_ESRCH) {
                Ok(())
            } else {
                Err(format!("validation process-group termination failed: {error}"))
            }
        }
        #[cfg(not(any(windows, unix)))]
        {
            Err("validation process-tree supervision unsupported on this platform".into())
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        if !self.job.is_null() {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.job);
            }
        }
    }
}

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
        // The fixed worker owns extension support and returns an explicit
        // `unsupported` review for non-code files. Do not reject here, or
        // ordinary .txt edits would lose their legacy no-validator path.
        let input=validation::request(file_path,before,after)?;
        if input.len()>64*1024*1024 {return Err("validation wire input budget exceeded".into());}
        let mut command=Command::new(&self.executable);
        command.arg(&self.worker).current_dir(&self.cwd)
            .env("ELECTRON_RUN_AS_NODE","1").env("NODE_OPTIONS","")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        #[cfg(unix)]
        command.process_group(0);
        let mut child=command.spawn().map_err(|e|format!("validation spawn failed: {e}"))?;
        // Assign before writing stdin: the worker cannot spawn py_compile until
        // it has received the request, so every descendant is already contained.
        let tree=match ProcessTree::attach(&child) {
            Ok(tree)=>tree,
            Err(error)=>{
                let _=child.start_kill();
                let _=tokio::time::timeout(Duration::from_secs(3),child.wait()).await;
                return Err(format!("{error}; validation worker termination is unconfirmed"));
            }
        };
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
                // Kill the whole contained tree, then reap the direct child.
                // Dropping ProcessTree also closes a kill-on-close Job Object.
                let terminate_error=tree.terminate().err();
                let cleanup=tokio::time::timeout(Duration::from_secs(3),child.wait()).await;
                if let Some(error)=terminate_error {
                    return Err(format!("validation process-tree termination failed; termination unconfirmed: {error}"));
                }
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
            assert_eq!(outcome.outcome.status,"error");
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
            // Python is enabled only behind the supervised runner: prove real
            // py_compile diagnostics, not an "adapter not enabled" shortcut.
            let python=runner.review("fixture.py","x=1\n","x=2\n").await.unwrap();
            assert!(python.supported);
            assert!(!python.rejects_syntax(true));
            let broken_python=runner.review("fixture.py","x=1\n","def broken(:\n").await.unwrap();
            assert!(broken_python.supported);
            assert!(broken_python.rejects_syntax(true));
            let plain_text=runner.review("fixture.txt","a","b").await.unwrap();
            assert!(!plain_text.supported);
            // A timed-out worker may have already spawned a grandchild. The job
            // object/process group must kill it before its delayed write lands.
            let tree_dir=tempfile::tempdir().unwrap();
            let tree_worker=tree_dir.path().join("tree-worker.cjs");
            std::fs::write(&tree_worker, r#"
const { spawn } = require('node:child_process');
const path = require('node:path');
const marker = path.join(__dirname, 'grandchild.marker');
spawn(process.execPath, ['-e',
  `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 1200)`
], { stdio: 'ignore', windowsHide: true });
setInterval(() => {}, 1000);
"#).unwrap();
            let marker=tree_dir.path().join("grandchild.marker");
            let tree_runner=ValidatorProcess {
                executable:runner.executable.clone(),worker:tree_worker,
                cwd:runner.cwd.clone(),timeout:Duration::from_millis(250),
            };
            let error=tree_runner.review("fixture.json","{}","{}").await.unwrap_err();
            assert!(error.contains("deadline exceeded"), "{error}");
            tokio::time::sleep(Duration::from_millis(1600)).await;
            assert!(!marker.exists(), "grandchild escaped the native process tree");
            let tiny=ValidatorProcess {timeout:Duration::from_millis(1),..runner};
            assert!(tiny.review("fixture.json","{}","{}").await.is_err());
        });
    }
}