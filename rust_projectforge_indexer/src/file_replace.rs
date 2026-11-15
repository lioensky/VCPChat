//! Low-level replacement only: caller MUST persist recovery intent first.
//! Rechecking a hash is optimistic concurrency, not an OS-level compare-and-swap.
//! External writers can race after recheck; handle coordination remains required.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use sha2::{Digest,Sha256};
use crate::{project_path::ProjectPath, text_snapshot::{TextSnapshot, MAX_EDIT_BYTES}};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
/// Raw image budget mirrors the storage blob ceiling so every committed byte can be restored.
pub const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;

struct Staged { path: PathBuf }
impl Drop for Staged {
    fn drop(&mut self) {
        // Failure cleanup never removes the live target.
        let _ = fs::remove_file(&self.path);
    }
}

fn stage(target: &Path, bytes: &[u8]) -> Result<Staged,String> {
    stage_with_limit(target,bytes,MAX_EDIT_BYTES,"replacement exceeds edit budget")
}

fn stage_image(target: &Path, bytes: &[u8]) -> Result<Staged,String> {
    stage_with_limit(target,bytes,MAX_IMAGE_BYTES,"image exceeds commit budget")
}

fn stage_with_limit(target: &Path, bytes: &[u8], limit: usize, message: &str) -> Result<Staged,String> {
    if bytes.len()>limit {return Err(message.into());}
    let parent=target.parent().ok_or("target has no parent")?;
    for _ in 0..32 {
        let n=SEQUENCE.fetch_add(1,Ordering::Relaxed);
        let temp=parent.join(format!(".projectforge-stage-{}-{n}.tmp",std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(mut file)=>{
                let staged=Staged{path:temp};
                file.write_all(bytes).and_then(|_|file.sync_all()).map_err(|e|e.to_string())?;
                drop(file);
                return Ok(staged);
            }
            Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists=>continue,
            Err(e)=>return Err(e.to_string()),
        }
    }
    Err("temporary path collision budget exceeded".into())
}

/// For existing UTF-8 files only. An error after replacement means outcome
/// may be unknown; recovery must inspect hashes rather than blindly retry.
pub fn replace_existing(path:&ProjectPath,expected_hash:&str,bytes:&[u8])->Result<(),String> {
    // Validate before staging or touching the live file. This primitive only
    // supports editable text, exactly like its read-back verification.
    let proposed=TextSnapshot::decode(bytes.to_vec())?;
    let staged=stage(&path.absolute,&proposed.original)?;
    let checked=crate::project_path::resolve(&path.root,&path.relative,false)?;
    if checked.absolute!=path.absolute {return Err("path identity changed".into());}
    let current=TextSnapshot::read(&checked.absolute)?;
    if current.hash!=expected_hash {return Err("file changed since planning".into());}
    // Preserve basic permissions. ACLs, xattrs and hard-link semantics need
    // dedicated platform acceptance before this primitive becomes production.
    let permissions=fs::metadata(&checked.absolute).map_err(|e|e.to_string())?.permissions();
    fs::set_permissions(&staged.path,permissions).map_err(|e|e.to_string())?;
    // Sync again after metadata adjustment.
    OpenOptions::new().read(true).write(true).open(&staged.path)
        .and_then(|f|f.sync_all()).map_err(|e|e.to_string())?;
    atomic_replace(&staged.path,&checked.absolute).map_err(|e|e.to_string())?;
    sync_parent(checked.absolute.parent().ok_or("missing parent")?).map_err(|e|e.to_string())?;
    let after=TextSnapshot::read(&checked.absolute)?;
    if after.original!=bytes {return Err("post-replacement contents differ; recovery required".into());}
    Ok(())
}

fn image_hash(bytes:&[u8])->String {format!("{:x}",Sha256::digest(bytes))}

fn read_image_file(path:&Path)->Result<Vec<u8>,String> {
    let meta=fs::symlink_metadata(path).map_err(|e|e.to_string())?;
    if meta.file_type().is_symlink()||!meta.file_type().is_file() {
        return Err("target is not a regular file".into());
    }
    if meta.len()>MAX_IMAGE_BYTES as u64 {return Err("target exceeds commit image budget".into());}
    fs::read(path).map_err(|e|e.to_string())
}

/// Replace any existing regular file from raw bytes. Callers must persist the
/// before/after snapshots first; this primitive only performs the checked write.
pub fn replace_image(path:&ProjectPath,expected_hash:&str,bytes:&[u8])->Result<(),String> {
    if bytes.len()>MAX_IMAGE_BYTES {return Err("image exceeds commit budget".into());}
    let staged=stage_image(&path.absolute,bytes)?;
    let checked=crate::project_path::resolve(&path.root,&path.relative,false)?;
    if checked.absolute!=path.absolute {return Err("path identity changed".into());}
    let current=read_image_file(&checked.absolute)?;
    if image_hash(&current)!=expected_hash {return Err("file changed since planning".into());}
    let permissions=fs::metadata(&checked.absolute).map_err(|e|e.to_string())?.permissions();
    fs::set_permissions(&staged.path,permissions).map_err(|e|e.to_string())?;
    OpenOptions::new().read(true).write(true).open(&staged.path)
        .and_then(|f|f.sync_all()).map_err(|e|e.to_string())?;
    atomic_replace(&staged.path,&checked.absolute).map_err(|e|e.to_string())?;
    sync_parent(checked.absolute.parent().ok_or("missing parent")?).map_err(|e|e.to_string())?;
    let after=read_image_file(&checked.absolute)?;
    if after.as_slice()!=bytes {return Err("post-replacement contents differ; recovery required".into());}
    Ok(())
}

/// Create a new file through a same-directory staged image. Existing targets are
/// never overwritten, including when another writer creates one during the move.
pub fn create_image(path:&ProjectPath,bytes:&[u8])->Result<(),String> {
    if bytes.len()>MAX_IMAGE_BYTES {return Err("image exceeds commit budget".into());}
    let parent=path.absolute.parent().ok_or("target has no parent")?;
    fs::create_dir_all(parent).map_err(|e|e.to_string())?;
    let checked=crate::project_path::resolve(&path.root,&path.relative,true)?;
    if checked.absolute!=path.absolute {return Err("path identity changed".into());}
    match fs::symlink_metadata(&checked.absolute) {
        Ok(_)=>return Err("file already exists; create will not overwrite".into()),
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{}
        Err(e)=>return Err(e.to_string()),
    }
    let staged=stage_image(&checked.absolute,bytes)?;
    let verified=crate::project_path::resolve(&path.root,&path.relative,true)?;
    if verified.absolute!=checked.absolute {return Err("path identity changed before create".into());}
    match fs::symlink_metadata(&verified.absolute) {
        Ok(_)=>return Err("file already exists; create will not overwrite".into()),
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{}
        Err(e)=>return Err(e.to_string()),
    }
    atomic_create(&staged.path,&verified.absolute).map_err(|e|e.to_string())?;
    sync_parent(verified.absolute.parent().ok_or("missing parent")?).map_err(|e|e.to_string())?;
    let after=read_image_file(&verified.absolute)?;
    if after.as_slice()!=bytes {return Err("post-create contents differ; recovery required".into());}
    Ok(())
}

/// Remove a checked regular file directly. The database snapshot written by the
/// commit journal is the rollback source; this primitive does not use the OS
/// recycle bin, so removal semantics differ from the legacy RemoveFile UI.
pub fn remove_image(path:&ProjectPath,expected_hash:&str)->Result<(),String> {
    let checked=crate::project_path::resolve(&path.root,&path.relative,false)?;
    if checked.absolute!=path.absolute {return Err("path identity changed".into());}
    let current=read_image_file(&checked.absolute)?;
    if image_hash(&current)!=expected_hash {return Err("file changed since planning".into());}
    fs::remove_file(&checked.absolute).map_err(|e|e.to_string())?;
    sync_parent(checked.absolute.parent().ok_or("missing parent")?).map_err(|e|e.to_string())?;
    Ok(())
}

#[cfg(windows)]
fn atomic_replace(from:&Path,to:&Path)->std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW,MOVEFILE_REPLACE_EXISTING,MOVEFILE_WRITE_THROUGH,
    };
    let from:Vec<u16>=from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to:Vec<u16>=to.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: both buffers are NUL-terminated and live for the duration of this call.
    let result=unsafe{MoveFileExW(from.as_ptr(),to.as_ptr(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)};
    if result==0 {Err(std::io::Error::last_os_error())} else {Ok(())}
}
#[cfg(not(windows))]
fn atomic_replace(from:&Path,to:&Path)->std::io::Result<()> {fs::rename(from,to)}

#[cfg(windows)]
fn atomic_create(from:&Path,to:&Path)->std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW,MOVEFILE_WRITE_THROUGH};
    let from:Vec<u16>=from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to:Vec<u16>=to.as_os_str().encode_wide().chain(Some(0)).collect();
    // No MOVEFILE_REPLACE_EXISTING: a concurrently created target must win.
    // SAFETY: both buffers are NUL-terminated and live for the duration of this call.
    let result=unsafe{MoveFileExW(from.as_ptr(),to.as_ptr(),MOVEFILE_WRITE_THROUGH)};
    if result==0 {Err(std::io::Error::last_os_error())} else {Ok(())}
}
#[cfg(not(windows))]
fn atomic_create(from:&Path,to:&Path)->std::io::Result<()> {
    // hard_link is the portable no-replace primitive at this same-directory stage.
    fs::hard_link(from,to)?;
    fs::remove_file(from)
}

#[cfg(unix)]
fn sync_parent(parent:&Path)->std::io::Result<()> {fs::File::open(parent)?.sync_all()}
#[cfg(not(unix))]
fn sync_parent(_parent:&Path)->std::io::Result<()> {Ok(())}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_plan_replaces_existing_file_without_js() {
        let dir=tempfile::tempdir().unwrap();
        let file=dir.path().join("a.txt");
        fs::write(&file,b"\xef\xbb\xbfbefore\r\n").unwrap();
        let steps=serde_json::from_value::<Vec<crate::edit::Step>>(serde_json::json!([
            {"step":1,"op":"target","target":"before","replace":"after"}
        ])).unwrap();
        let crate::edit_pipeline::Preparation::Ready(ready)=crate::edit_pipeline::prepare(
            dir.path(),"a.txt",&[dir.path().to_path_buf()],&steps,false).unwrap()
            else {panic!("expected native plan")};
        replace_existing(&ready.path,&ready.plan.expected_hash,&ready.plan.bytes).unwrap();
        assert_eq!(fs::read(&file).unwrap(),b"\xef\xbb\xbfafter\r\n");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(),1);
    }
    #[test]
    fn invalid_output_never_touches_existing_file() {
        let dir=tempfile::tempdir().unwrap();
        let file=dir.path().join("a.txt");
        fs::write(&file,b"before").unwrap();
        let snapshot=TextSnapshot::read(&file).unwrap();
        let path=crate::project_path::resolve(dir.path(),"a.txt",false).unwrap();
        for invalid in [vec![0xff],vec![b'a',0],vec![0xff,0xfe]] {
            assert!(replace_existing(&path,&snapshot.hash,&invalid).is_err());
            assert_eq!(fs::read(&file).unwrap(),b"before");
            assert_eq!(fs::read_dir(dir.path()).unwrap().count(),1);
        }
    }

    #[test]
    fn drift_preserves_external_bytes_and_cleans_temporary_file() {
        let dir=tempfile::tempdir().unwrap();
        let file=dir.path().join("a.txt");
        fs::write(&file,b"before").unwrap();
        let snapshot=TextSnapshot::read(&file).unwrap();
        let path=crate::project_path::resolve(dir.path(),"a.txt",false).unwrap();
        fs::write(&file,b"external").unwrap();
        assert!(replace_existing(&path,&snapshot.hash,b"after").is_err());
        assert_eq!(fs::read(file).unwrap(),b"external");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(),1);
    }
}