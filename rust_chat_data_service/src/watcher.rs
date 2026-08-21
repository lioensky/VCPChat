use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use tokio::{
    sync::{mpsc, Mutex as AsyncMutex},
    task::JoinHandle,
    time::{interval, MissedTickBehavior},
};
use tokio_util::sync::CancellationToken;

use crate::{
    ingest::{parse_history_path, Reconciler},
    search::SearchIndex,
};

#[derive(Debug, Default)]
pub struct WatcherMetrics {
    pub events_total: AtomicU64,
    pub events_coalesced: AtomicU64,
    pub overflow_total: AtomicU64,
    pub ingest_success_total: AtomicU64,
    pub ingest_failure_total: AtomicU64,
    pub pending_paths: AtomicU64,
    pub reconcile_required: AtomicBool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PathEventKind {
    Modify,
    Create,
    Remove,
    Rename,
}

#[derive(Debug, Clone)]
struct PendingPath {
    kind: PathEventKind,
    last_event_at: Instant,
}

pub struct WatcherRuntime {
    _watcher: RecommendedWatcher,
    tasks: Vec<JoinHandle<()>>,
    pub metrics: Arc<WatcherMetrics>,
}

impl WatcherRuntime {
    pub fn start(
        reconciler: Reconciler,
        search: Option<SearchIndex>,
        cancellation: CancellationToken,
        reconcile_lock: Arc<AsyncMutex<()>>,
    ) -> Result<Self> {
        let config = reconciler.config().clone();
        let metrics = Arc::new(WatcherMetrics::default());
        let (raw_tx, raw_rx) = mpsc::channel::<Event>(config.raw_event_capacity);
        let (path_tx, path_rx) = mpsc::channel::<PathBuf>(config.ingest_capacity);

        let callback_metrics = metrics.clone();
        let callback_reconcile = metrics.clone();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<Event>| match result {
                Ok(event) => {
                    callback_metrics
                        .events_total
                        .fetch_add(1, Ordering::Relaxed);
                    if raw_tx.try_send(event).is_err() {
                        callback_metrics
                            .overflow_total
                            .fetch_add(1, Ordering::Relaxed);
                        callback_reconcile
                            .reconcile_required
                            .store(true, Ordering::Release);
                    }
                }
                Err(error) => {
                    tracing::warn!(error = ?error, "filesystem watcher reported an error");
                    callback_reconcile
                        .reconcile_required
                        .store(true, Ordering::Release);
                }
            })
            .context("failed to create filesystem watcher")?;

        for directory in [
            &config.agents_dir,
            &config.groups_dir,
            &config.user_data_dir,
        ] {
            if directory.exists() {
                watcher
                    .watch(directory, RecursiveMode::Recursive)
                    .with_context(|| format!("failed to watch {}", directory.display()))?;
            }
        }

        let pending = Arc::new(Mutex::new(HashMap::<PathBuf, PendingPath>::new()));
        let coalescer_task = tokio::spawn(run_coalescer(
            raw_rx,
            path_tx,
            pending,
            config.coalesced_path_capacity,
            config.agents_dir.clone(),
            config.groups_dir.clone(),
            config.user_data_dir.clone(),
            metrics.clone(),
            cancellation.clone(),
        ));

        let ingest_task = tokio::spawn(run_ingest_worker(
            path_rx,
            reconciler.clone(),
            search.clone(),
            metrics.clone(),
            cancellation.clone(),
            reconcile_lock.clone(),
        ));

        let recovery_task = tokio::spawn(run_overflow_recovery(
            reconciler,
            search,
            metrics.clone(),
            cancellation,
            reconcile_lock,
        ));

        Ok(Self {
            _watcher: watcher,
            tasks: vec![coalescer_task, ingest_task, recovery_task],
            metrics,
        })
    }

    pub async fn shutdown(self) {
        for task in self.tasks {
            let _ = task.await;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_coalescer(
    mut raw_rx: mpsc::Receiver<Event>,
    path_tx: mpsc::Sender<PathBuf>,
    pending: Arc<Mutex<HashMap<PathBuf, PendingPath>>>,
    coalesced_path_capacity: usize,
    agents_dir: PathBuf,
    groups_dir: PathBuf,
    user_data_dir: PathBuf,
    metrics: Arc<WatcherMetrics>,
    cancellation: CancellationToken,
) {
    let mut ticker = interval(Duration::from_millis(50));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = cancellation.cancelled() => break,
            event = raw_rx.recv() => {
                let Some(event) = event else { break };
                let kind = normalize_event_kind(&event.kind);
                for path in event.paths {
                    if !is_relevant_path(&path, &agents_dir, &groups_dir, &user_data_dir) {
                        continue;
                    }
                    let mut map = pending.lock();
                    if let Some(state) = map.get_mut(&path) {
                        state.kind = kind;
                        state.last_event_at = Instant::now();
                        metrics.events_coalesced.fetch_add(1, Ordering::Relaxed);
                    } else if map.len() < coalesced_path_capacity {
                        map.insert(path, PendingPath {
                            kind,
                            last_event_at: Instant::now(),
                        });
                    } else {
                        metrics.overflow_total.fetch_add(1, Ordering::Relaxed);
                        metrics.reconcile_required.store(true, Ordering::Release);
                    }
                    metrics.pending_paths.store(map.len() as u64, Ordering::Relaxed);
                }
            }
            _ = ticker.tick() => {
                let now = Instant::now();
                let ready = {
                    let mut map = pending.lock();
                    let ready: Vec<PathBuf> = map
                        .iter()
                        .filter(|(_, state)| now.duration_since(state.last_event_at) >= stability_window(state.kind))
                        .map(|(path, _)| path.clone())
                        .collect();
                    for path in &ready {
                        map.remove(path);
                    }
                    metrics.pending_paths.store(map.len() as u64, Ordering::Relaxed);
                    ready
                };

                for path in ready {
                    if path_tx.try_send(path).is_err() {
                        metrics.overflow_total.fetch_add(1, Ordering::Relaxed);
                        metrics.reconcile_required.store(true, Ordering::Release);
                    }
                }
            }
        }
    }
}

async fn run_ingest_worker(
    mut path_rx: mpsc::Receiver<PathBuf>,
    reconciler: Reconciler,
    search: Option<SearchIndex>,
    metrics: Arc<WatcherMetrics>,
    cancellation: CancellationToken,
    reconcile_lock: Arc<AsyncMutex<()>>,
) {
    loop {
        tokio::select! {
            _ = cancellation.cancelled() => break,
            path = path_rx.recv() => {
                let Some(path) = path else { break };
                if is_owner_config(&path, &reconciler.config().agents_dir)
                    || is_owner_config(&path, &reconciler.config().groups_dir)
                {
                    metrics.reconcile_required.store(true, Ordering::Release);
                    continue;
                }

                if !path.exists() {
                    // Deletions need config-aware topic/message tombstones.
                    metrics.reconcile_required.store(true, Ordering::Release);
                    continue;
                }

                // Keep direct notification ingestion from interleaving with a
                // startup, recovery, or API-triggered consistency pass.
                let _guard = reconcile_lock.lock().await;
                match reconciler.ingest_path(&path, "notify").await {
                    Ok(Some(commit)) => {
                        if commit.changed {
                            if let Some(index) = &search {
                                if let Err(error) = index.update_topic(&commit.topic, commit.revision) {
                                    tracing::error!(error = ?error, path = %path.display(), "index update failed");
                                    metrics.reconcile_required.store(true, Ordering::Release);
                                }
                            }
                        }
                        metrics.ingest_success_total.fetch_add(1, Ordering::Relaxed);
                    }
                    Ok(None) => {}
                    Err(error) => {
                        metrics.ingest_failure_total.fetch_add(1, Ordering::Relaxed);
                        tracing::warn!(error = ?error, path = %path.display(), "notify ingest failed");
                    }
                }
            }
        }
    }
}

async fn run_overflow_recovery(
    reconciler: Reconciler,
    search: Option<SearchIndex>,
    metrics: Arc<WatcherMetrics>,
    cancellation: CancellationToken,
    reconcile_lock: Arc<AsyncMutex<()>>,
) {
    let mut ticker = interval(Duration::from_secs(2));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = cancellation.cancelled() => break,
            _ = ticker.tick() => {
                if !metrics.reconcile_required.swap(false, Ordering::AcqRel) {
                    continue;
                }

                // Serialize recovery with startup and API-triggered reconciles.
                // Filesystem events may arrive while the background startup pass
                // is running; they remain represented by reconcile_required and
                // are processed after that pass releases this lock.
                let _guard = reconcile_lock.lock().await;
                match reconciler.reconcile().await {
                    Ok(stats) => {
                        tracing::info!(?stats, "watcher recovery reconcile completed");
                        if let Some(index) = &search {
                            if let Err(error) = index.reconcile_revisions() {
                                tracing::error!(error = ?error, "revision recovery failed");
                                metrics.reconcile_required.store(true, Ordering::Release);
                            }
                        }
                    }
                    Err(error) => {
                        tracing::error!(error = ?error, "watcher recovery reconcile failed");
                        metrics.reconcile_required.store(true, Ordering::Release);
                    }
                }
            }
        }
    }
}

fn normalize_event_kind(kind: &EventKind) -> PathEventKind {
    match kind {
        EventKind::Create(_) => PathEventKind::Create,
        EventKind::Remove(_) => PathEventKind::Remove,
        EventKind::Modify(notify::event::ModifyKind::Name(_)) => PathEventKind::Rename,
        _ => PathEventKind::Modify,
    }
}

fn stability_window(kind: PathEventKind) -> Duration {
    match kind {
        PathEventKind::Modify => Duration::from_millis(150),
        PathEventKind::Create | PathEventKind::Rename | PathEventKind::Remove => {
            Duration::from_millis(250)
        }
    }
}

fn is_relevant_path(
    path: &Path,
    agents_dir: &Path,
    groups_dir: &Path,
    user_data_dir: &Path,
) -> bool {
    is_owner_config(path, agents_dir)
        || is_owner_config(path, groups_dir)
        || parse_history_path(user_data_dir, path).is_some()
}

fn is_owner_config(path: &Path, base: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(base) else {
        return false;
    };
    let components: Vec<_> = relative.components().collect();
    components.len() == 2
        && components[1]
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case("config.json")
}
