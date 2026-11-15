//! Trusted host configuration. Never deserialize this from an edit RPC.
use std::{path::{Path,PathBuf}, io::Read, time::Duration};
use serde::Deserialize;
use crate::storage::DEFAULT_MAX_READ_CONCURRENCY;
use crate::validation_process::ValidatorProcess;

/// Default number of callers allowed to wait for one of the bounded read slots.
pub const DEFAULT_MAX_QUERY_QUEUE: usize = 32;

/// Bounded read/query budget of the storage service process. The single writer connection
/// is not part of this budget: it stays the only handle allowed to mutate the database.
#[derive(Clone, Copy, Debug)]
pub struct QueryBudget {
    pub max_read_concurrency: usize,
    pub max_query_queue: usize,
}
impl Default for QueryBudget {
    fn default() -> Self {
        Self { max_read_concurrency: DEFAULT_MAX_READ_CONCURRENCY, max_query_queue: DEFAULT_MAX_QUERY_QUEUE }
    }
}
impl QueryBudget {
    pub fn new(max_read_concurrency: u64, max_query_queue: u64) -> Result<Self, String> {
        if !(1..=16).contains(&max_read_concurrency) || !(1..=256).contains(&max_query_queue) {
            return Err("invalid service configuration query budget".into());
        }
        Ok(Self { max_read_concurrency: max_read_concurrency as usize, max_query_queue: max_query_queue as usize })
    }
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Wire {
    version:u32,
    allowed_roots:Vec<PathBuf>,
    node_executable:PathBuf,
    validation_worker:PathBuf,
    validation_cwd:PathBuf,
    validation_timeout_ms:u64,
    /// Optional bounded read budget: 1..=16 connections (default 4), 1..=256 waiters (32).
    #[serde(default)]
    max_read_concurrency:Option<u64>,
    #[serde(default)]
    max_query_queue:Option<u64>,
}
pub struct Config {
    pub allowed_roots:Vec<PathBuf>,
    pub query_budget:QueryBudget,
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
        let query_budget=QueryBudget::new(
            wire.max_read_concurrency.unwrap_or(DEFAULT_MAX_READ_CONCURRENCY as u64),
            wire.max_query_queue.unwrap_or(DEFAULT_MAX_QUERY_QUEUE as u64))?;
        let mut roots=Vec::new();
        for root in wire.allowed_roots {
            let root=absolute_existing(&root,true)?;
            if !roots.contains(&root) {roots.push(root);}
        }
        Ok(Self {
            query_budget,
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