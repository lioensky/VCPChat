//! Trusted host configuration. Never deserialize this from an edit RPC.
use std::{path::{Path,PathBuf}, io::Read, time::Duration};
use serde::Deserialize;
use crate::validation_process::ValidatorProcess;

#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Wire {
    version:u32,
    allowed_roots:Vec<PathBuf>,
    node_executable:PathBuf,
    validation_worker:PathBuf,
    validation_cwd:PathBuf,
    validation_timeout_ms:u64,
}
pub struct Config {
    pub allowed_roots:Vec<PathBuf>,
    pub validator:ValidatorProcess,
}
fn absolute_existing(path:&Path,directory:bool)->Result<PathBuf,String> {
    if !path.is_absolute() {return Err("configuration paths must be absolute".into());}
    let canonical=path.canonicalize().map_err(|e|e.to_string())?;
    if if directory {!canonical.is_dir()} else {!canonical.is_file()} {
        return Err("configuration path has wrong filesystem type".into());
    }
    Ok(canonical)
}
impl Config {
    pub fn load(path:&Path)->Result<Self,String> {
        let path=absolute_existing(path,false)?;
        let mut bytes=Vec::new();
        std::fs::File::open(path).map_err(|e|e.to_string())?
            .take(64*1024+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
        if bytes.len()>64*1024 {return Err("service configuration budget exceeded".into());}
        let wire:Wire=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
        if wire.version!=1 || wire.allowed_roots.is_empty() || wire.allowed_roots.len()>128
            || !(1..=60_000).contains(&wire.validation_timeout_ms) {
            return Err("invalid service configuration version or budget".into());
        }
        let mut roots=Vec::new();
        for root in wire.allowed_roots {
            let root=absolute_existing(&root,true)?;
            if !roots.contains(&root) {roots.push(root);}
        }
        Ok(Self {
            allowed_roots:roots,
            validator:ValidatorProcess {
                executable:absolute_existing(&wire.node_executable,false)?,
                worker:absolute_existing(&wire.validation_worker,false)?,
                cwd:absolute_existing(&wire.validation_cwd,true)?,
                timeout:Duration::from_millis(wire.validation_timeout_ms),
            },
        })
    }
}