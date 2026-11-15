//! Dedicated storage process mode of the existing executable.
//! No automatic DB path: deployment must explicitly hand over ownership before launching.
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;
use rusqlite::Connection;
use serde_json::{json, Value};
use crate::service_config::QueryBudget;
use crate::{storage::Store, transport};

pub fn run(path: &Path, config_path: Option<&Path>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Validate host configuration before opening/migrating the database.
    let config=config_path.map(crate::service_config::Config::load).transpose()?;
    let runtime=if config.is_some() {
        Some(tokio::runtime::Builder::new_current_thread().enable_all().build()?)
    } else {None};
    // Trusted host configuration also carries the bounded read budget; without a config
    // file the documented defaults apply, so the pool is always bounded.
    let budget = config.as_ref().map(|config| config.query_budget).unwrap_or_default();
    let mut store = Store::open_with_read_concurrency(path, budget.max_read_concurrency)?;
    let reads = ReadPool::new(store.database_path().to_path_buf(), budget);
    // Finish durable edits before advertising readiness. A prepared intent or plan that
    // conflicts during recovery keeps its before snapshot, is marked conflict, releases
    // its lock immediately and returns an error; marked conflicts cannot block restart.
    match &config {
        Some(config) => {
            let intents=store.prepared_intents()?;
            for intent in intents {
                crate::commit_coordinator::resume(&mut store,&intent,&config.allowed_roots)
                    .map_err(|error| format!(
                        "startup recovery failed for operation {}: {error}",intent.operation_id))?;
            }
            crate::file_commit::resume_all(&mut store, &config.allowed_roots)?;
        }

        None => {
            let pending_files: bool = store.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM file_commit_plans WHERE state='prepared')", [], |row| row.get(0))?;
            if !store.prepared_intents()?.is_empty() || pending_files {
                return Err("prepared edit intents require trusted service configuration for startup recovery".into());
            }
        }
    }
    let output = Mutex::new(io::stdout());
    send_frame(&output, &json!({
        "type":"ready","service":"projectforge-storage","protocolVersion":1,
        "maxFrameBytes":transport::MAX_FRAME_BYTES,
        "capabilities":if config.is_some() {
            vec!["businessQueries","atomicHistory","operationStatus","nativeEditV1",
                "boundedConcurrentQueries"]
        } else {vec!["businessQueries","atomicHistory","operationStatus","boundedConcurrentQueries"]},
        "budgets":reads.budget_json(),
        "filesystemCommit":config.is_some()
    }))?;
    let (writer_tx, writer_rx) = std::sync::mpsc::sync_channel::<(Value, String, Value)>(budget.max_query_queue);
    let (read_tx, read_rx) = std::sync::mpsc::sync_channel::<(Value, String, Value)>(budget.max_query_queue);
    let read_rx = Mutex::new(read_rx);
    let rx_ref = &read_rx;
    let output_ref = &output;
    let reads_ref = &reads;
    std::thread::scope(|scope| -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let writer = scope.spawn(move || -> io::Result<()> {
            while let Ok((id, method, params)) = writer_rx.recv() {
                let result = match method.as_str() {
                    "store.createProject" => store.mutate_authorized(&method, &params,
                        config.as_ref().map(|config| config.allowed_roots.as_slice())),
                    "store.recordBatch" | "store.updateProject"
                        | "store.addTodos" | "store.updateTodo" | "store.removeTodo"
                        | "store.softDeleteProjects" | "store.restoreProjects" | "store.purgeProjects"
                        => store.mutate(&method, &params),
                    "edit.execute" | "edit.resolve" | "file.execute" => match (&config, &runtime) {
                        (Some(config), Some(runtime)) => if method == "file.execute" {
                            runtime.block_on(crate::file_service::execute(
                                &mut store, &params, &config.allowed_roots, &config.validator))
                        } else if method == "edit.resolve" {
                            runtime.block_on(crate::edit_tickets::resolve(
                                &mut store, &params, &config.allowed_roots, &config.validator))
                        } else {
                            runtime.block_on(crate::edit_service::execute(
                                &mut store, &params, &config.allowed_roots, &config.validator))
                        },
                        _ => Err("native editing requires explicit trusted service configuration".into()),
                    },
                    _ => store.query(&method, &params),
                };
                if result.is_ok() && is_mutation(&method) {
                    reads_ref.stats.completed_mutations.fetch_add(1, Ordering::SeqCst);
                }
                let response = match result {
                    Ok(result) => json!({"id":id,"ok":true,"result":result}),
                    Err(error) => json!({"id":id,"ok":false,"error":{"code":"STORE_ERROR","message":error.to_string()}}),
                };
                send_frame(output_ref, &response)?;
            }
            Ok(())
        });

        let mut readers = Vec::with_capacity(budget.max_read_concurrency);
        for _ in 0..budget.max_read_concurrency {
            readers.push(scope.spawn(move || -> io::Result<()> {
                loop {
                    let task = {
                        let guard = rx_ref.lock().unwrap_or_else(|e| e.into_inner());
                        guard.recv()
                    };
                    let Ok((id, method, params)) = task else { break; };
                    let response = match reads_ref.query(&method, &params) {
                        Ok(result) => json!({"id":id,"ok":true,"result":result}),
                        Err(error) => json!({"id":id,"ok":false,"error":{"code":"STORE_ERROR","message":error.to_string()}}),
                    };
                    send_frame(output_ref, &response)?;
                }
                Ok(())
            }));
        }

        let stdin = io::stdin();
        let mut input = stdin.lock();
        let mut shutdown_id: Option<Value> = None;
        while let Some(line) = transport::read_frame(&mut input, transport::MAX_FRAME_BYTES)? {
            if line.trim().is_empty() { continue; }
            let request: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(error) => {
                    send_frame(&output, &json!({
                        "id":null,"ok":false,"error":{"code":"INVALID_JSON","message":error.to_string()}
                    }))?;
                    continue;
                }
            };
            let id = match request.get("id") {
                Some(Value::Number(n)) if n.as_u64().is_some() => Value::Number(n.clone()),
                Some(Value::String(s)) if !s.is_empty() && s.len() <= 128 => Value::String(s.clone()),
                _ => {
                    send_frame(&output, &json!({
                        "id":null,"ok":false,"error":{"code":"INVALID_ID","message":"id must be a nonnegative integer or bounded string"}
                    }))?;
                    continue;
                }
            };
            let method = request.get("method").and_then(Value::as_str).unwrap_or("");
            if method == "shutdown" {
                shutdown_id = Some(id);
                break;
            }
            if method == "ping" {
                send_frame(&output, &json!({"id":id,"ok":true,"result":{"pong":true}}))?;
                continue;
            }
            if method == "service.budget" {
                send_frame(&output, &json!({"id":id,"ok":true,"result":reads.report()}))?;
                continue;
            }
            let params = request.get("params").cloned().unwrap_or(Value::Null);
            // Pure reads fan out to the bounded read-only worker pool; writes and writer-state queries stay on the single writer.
            if method.starts_with("store.") && method != "store.info" && !is_mutation(method) {
                if let Err(std::sync::mpsc::TrySendError::Full((id, _, _))) = read_tx.try_send((id, method.to_string(), params)) {
                    send_frame(&output, &json!({
                        "id":id,"ok":false,"error":{"code":"STORE_ERROR","message":format!(
                            "read query queue full: queue budget {}", budget.max_query_queue)}
                    }))?;
                }
            } else if let Err(std::sync::mpsc::TrySendError::Full((id, _, _))) = writer_tx.try_send((id, method.to_string(), params)) {
                send_frame(&output, &json!({
                    "id":id,"ok":false,"error":{"code":"STORE_ERROR","message":format!(
                        "mutation queue full: queue budget {}", budget.max_query_queue)}
                }))?;
            }
        }

        drop(read_tx);
        drop(writer_tx);
        writer.join().map_err(|_| io::Error::other("writer worker panicked"))??;
        for reader in readers {
            reader.join().map_err(|_| io::Error::other("read worker panicked"))??;
        }
        if let Some(id) = shutdown_id {
            send_frame(&output, &json!({"id":id,"ok":true,"result":{"bye":true}}))?;
        }
        Ok(())
    })
}

fn send_frame(output: &Mutex<io::Stdout>, value: &Value) -> io::Result<()> {
    let mut guard = output.lock().unwrap_or_else(|e| e.into_inner());
    transport::write_frame(&mut *guard, value)
}

/// Methods that must run on the single writer store; everything else that starts with
/// `store.` is a pure read and may use the bounded read-only pool.
fn is_mutation(method: &str) -> bool {
    matches!(method,
        "store.createProject" | "store.recordBatch" | "store.updateProject"
        | "store.addTodos" | "store.updateTodo" | "store.removeTodo"
        | "store.softDeleteProjects" | "store.restoreProjects" | "store.purgeProjects"
        | "edit.execute" | "edit.resolve" | "file.execute")
}

/// Bounded pool of read-only SQLite connections over the same WAL database. Reads never
/// borrow the writer connection, at most `max_read_concurrency` reads run at once, and at
/// most `max_query_queue` callers may wait for a slot before the request is rejected
/// instead of growing an unbounded backlog.
struct ReadPool {
    path: PathBuf,
    budget: QueryBudget,
    idle: Mutex<Vec<Connection>>,
    waiters: Mutex<usize>,
    wake: Condvar,
    stats: Stats,
}

struct Stats {
    active_read_queries: AtomicUsize,
    completed_read_queries: AtomicU64,
    completed_mutations: AtomicU64,
}

const READ_QUEUE_WAIT: Duration = Duration::from_secs(30);

impl ReadPool {
    fn new(path: PathBuf, budget: QueryBudget) -> Self {
        Self {
            path, budget,
            idle: Mutex::new(Vec::new()),
            waiters: Mutex::new(0),
            wake: Condvar::new(),
            stats: Stats {
                active_read_queries: AtomicUsize::new(0),
                completed_read_queries: AtomicU64::new(0),
                completed_mutations: AtomicU64::new(0),
            },
        }
    }

    /// Run one pure read on a pooled read-only connection.
    fn query(&self, method: &str, params: &Value) -> crate::storage::Result<Value> {
        let _slot = self.enter()?;
        let idle = self.idle.lock().unwrap_or_else(|error| error.into_inner()).pop();
        let connection = match idle {
            Some(connection) => connection,
            None => Store::open_read_only(&self.path)?,
        };
        let outcome = Store::query_with_connection(&connection, method, params);
        // A connection that failed is dropped instead of recycled.
        if outcome.is_ok() {
            self.idle.lock().unwrap_or_else(|error| error.into_inner()).push(connection);
        }
        self.stats.completed_read_queries.fetch_add(1, Ordering::SeqCst);
        outcome
    }

    /// Reserve one bounded read slot, queueing at most `max_query_queue` callers.
    fn enter(&self) -> crate::storage::Result<ReadSlot<'_>> {
        let mut waiters = self.waiters.lock().unwrap_or_else(|error| error.into_inner());
        loop {
            let active = self.stats.active_read_queries.load(Ordering::SeqCst);
            if active < self.budget.max_read_concurrency {
                self.stats.active_read_queries.fetch_add(1, Ordering::SeqCst);
                return Ok(ReadSlot(self));
            }
            if *waiters >= self.budget.max_query_queue {
                return Err(format!("read query queue full: {active} active reads, {} waiting, queue budget {}",
                    *waiters, self.budget.max_query_queue).into());
            }
            *waiters += 1;
            let (mut released, timeout) = self.wake.wait_timeout(waiters, READ_QUEUE_WAIT)
                .unwrap_or_else(|error| error.into_inner());
            *released -= 1;
            waiters = released;
            if timeout.timed_out() { return Err("read query queue wait timed out".into()); }
        }
    }

    fn budget_json(&self) -> Value {
        json!({"maxReadConcurrency":self.budget.max_read_concurrency,
            "maxQueryQueue":self.budget.max_query_queue})
    }

    /// `service.budget`: configured budgets plus the live counters.
    fn report(&self) -> Value {
        let mut report = self.budget_json();
        report["singleWriter"] = json!(true);
        report["readOnlyQueryPool"] = json!(true);
        report["activeReadQueries"] = json!(self.stats.active_read_queries.load(Ordering::SeqCst));
        report["completedReadQueries"] = json!(self.stats.completed_read_queries.load(Ordering::SeqCst));
        report["completedMutations"] = json!(self.stats.completed_mutations.load(Ordering::SeqCst));
        report
    }
}

/// One reserved read slot: released on drop, so a failing read cannot leak the budget.
struct ReadSlot<'a>(&'a ReadPool);
impl Drop for ReadSlot<'_> {
    fn drop(&mut self) {
        self.0.stats.active_read_queries.fetch_sub(1, Ordering::SeqCst);
        self.0.wake.notify_one();
    }
}