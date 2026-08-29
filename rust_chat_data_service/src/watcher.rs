use std::{
    collections::{HashMap, HashSet},
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
    domain::{AvatarKey, AvatarOwnerType, OwnerKey, OwnerType},
    ingest::{is_avatar_path, parse_history_path, Reconciler},
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
                let mut paths = vec![path];
                while let Ok(path) = path_rx.try_recv() {
                    paths.push(path);
                }
                let _guard = reconcile_lock.lock().await;
                process_ingest_batch(&paths, &reconciler, search.as_ref(), &metrics).await;
            }
        }
    }
}

async fn process_ingest_batch(
    paths: &[PathBuf],
    reconciler: &Reconciler,
    search: Option<&SearchIndex>,
    metrics: &WatcherMetrics,
) {
    let config = reconciler.config();
    let mut owner_events = HashMap::<OwnerKey, Vec<&PathBuf>>::new();
    let mut avatar_events = Vec::<(&PathBuf, AvatarKey)>::new();
    let mut history_events = Vec::<&PathBuf>::new();

    for path in paths {
        if let Some(owner) = owner_config_key(path, &config.agents_dir, &config.groups_dir) {
            owner_events.entry(owner).or_default().push(path);
        } else if let Some(avatar) = avatar_key(
            path,
            &config.agents_dir,
            &config.groups_dir,
            &config.user_data_dir,
        ) {
            avatar_events.push((path, avatar));
        } else {
            history_events.push(path);
        }
    }

    for path in history_events.iter().copied().filter(|path| !path.exists()) {
        match reconciler.database().live_topic_source_by_path(path) {
            Ok(Some(source)) => {
                owner_events
                    .entry(OwnerKey {
                        owner_type: source.key.owner_type,
                        owner_id: source.key.owner_id,
                    })
                    .or_default()
                    .push(path);
            }
            Ok(None) => {
                metrics.reconcile_required.store(true, Ordering::Release);
            }
            Err(error) => {
                metrics.ingest_failure_total.fetch_add(1, Ordering::Relaxed);
                tracing::warn!(error = ?error, path = %path.display(), "deleted history lookup failed");
                metrics.reconcile_required.store(true, Ordering::Release);
            }
        }
    }

    let needs_revision_reconcile = !owner_events.is_empty();
    let mut reconciled_owner_ids = HashSet::new();
    for (owner, event_paths) in &owner_events {
        match reconciler.reconcile_owner_key(owner).await {
            Ok(_) => {
                reconciled_owner_ids.insert(owner.owner_id.as_str());
                metrics
                    .ingest_success_total
                    .fetch_add(event_paths.len() as u64, Ordering::Relaxed);
            }
            Err(error) => {
                metrics
                    .ingest_failure_total
                    .fetch_add(event_paths.len() as u64, Ordering::Relaxed);
                tracing::warn!(
                    error = ?error,
                    owner_type = %owner.owner_type,
                    owner_id = %owner.owner_id,
                    "owner reconcile failed"
                );
                metrics.reconcile_required.store(true, Ordering::Release);
            }
        }
    }

    for (path, avatar) in avatar_events {
        match reconciler.reconcile_avatar_key(&avatar) {
            Ok(_) => {
                metrics.ingest_success_total.fetch_add(1, Ordering::Relaxed);
            }
            Err(error) => {
                metrics.ingest_failure_total.fetch_add(1, Ordering::Relaxed);
                tracing::warn!(error = ?error, path = %path.display(), "avatar reconcile failed");
                metrics.reconcile_required.store(true, Ordering::Release);
            }
        }
    }

    let mut commits = Vec::new();
    let mut dirty_owners = HashSet::new();
    for path in history_events {
        let Some((owner_id, _)) = parse_history_path(&config.user_data_dir, path) else {
            continue;
        };
        if !path.exists() {
            continue;
        }
        if reconciled_owner_ids.contains(owner_id.as_str()) {
            metrics.ingest_success_total.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        match reconciler
            .ingest_path_with_owner_hash_mode(path, crate::storage::OwnerHashMode::Deferred)
            .await
        {
            Ok(Some(commit)) => {
                if commit.owner_hash_dirty {
                    dirty_owners.insert(OwnerKey {
                        owner_type: commit.topic.owner_type,
                        owner_id: commit.topic.owner_id.clone(),
                    });
                }
                commits.push(commit);
                metrics.ingest_success_total.fetch_add(1, Ordering::Relaxed);
            }
            Ok(None) => {}
            Err(error) => {
                metrics.ingest_failure_total.fetch_add(1, Ordering::Relaxed);
                tracing::warn!(error = ?error, path = %path.display(), "notify ingest failed");
                metrics.reconcile_required.store(true, Ordering::Release);
            }
        }
    }

    for owner in dirty_owners {
        if let Err(error) = reconciler.database().refresh_owner_content_hash(&owner) {
            tracing::error!(error = ?error, owner_type = %owner.owner_type, owner_id = %owner.owner_id, "owner hash refresh failed");
            metrics.reconcile_required.store(true, Ordering::Release);
        }
    }

    if let Some(index) = search {
        if let Err(error) = index.apply_ingest_commits(&commits) {
            tracing::error!(error = ?error, "watcher index batch update failed");
            metrics.reconcile_required.store(true, Ordering::Release);
        }
        if needs_revision_reconcile {
            if let Err(error) = index.reconcile_revisions() {
                tracing::error!(error = ?error, "watcher owner revision reconcile failed");
                metrics.reconcile_required.store(true, Ordering::Release);
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
    let mut retry_delay = Duration::from_secs(2);
    let mut retry_not_before = Instant::now();

    loop {
        tokio::select! {
            _ = cancellation.cancelled() => break,
            _ = ticker.tick() => {
                if !metrics.reconcile_required.swap(false, Ordering::AcqRel) {
                    continue;
                }
                if Instant::now() < retry_not_before {
                    metrics.reconcile_required.store(true, Ordering::Release);
                    continue;
                }

                // Serialize recovery with startup and API-triggered reconciles.
                // Filesystem events may arrive while the background startup pass
                // is running; they remain represented by reconcile_required and
                // are processed after that pass releases this lock.
                let _guard = reconcile_lock.lock().await;
                let recovered = match reconciler.reconcile().await {
                    Ok(stats) => {
                        tracing::info!(?stats, "watcher recovery reconcile completed");
                        if let Some(index) = &search {
                            if let Err(error) = index.reconcile_revisions() {
                                tracing::error!(error = ?error, "revision recovery failed");
                                false
                            } else {
                                true
                            }
                        } else {
                            true
                        }
                    }
                    Err(error) => {
                        tracing::error!(error = ?error, "watcher recovery reconcile failed");
                        false
                    }
                };
                if recovered {
                    retry_delay = Duration::from_secs(2);
                    retry_not_before = Instant::now();
                } else {
                    metrics.reconcile_required.store(true, Ordering::Release);
                    retry_not_before = Instant::now() + retry_delay;
                    retry_delay = (retry_delay * 2).min(Duration::from_secs(30));
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
        || is_avatar_path(path, agents_dir, groups_dir, user_data_dir)
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

fn owner_config_key(path: &Path, agents_dir: &Path, groups_dir: &Path) -> Option<OwnerKey> {
    for (owner_type, base) in [
        (OwnerType::Agent, agents_dir),
        (OwnerType::Group, groups_dir),
    ] {
        if !is_owner_config(path, base) {
            continue;
        }
        let owner_id = path
            .strip_prefix(base)
            .ok()?
            .components()
            .next()?
            .as_os_str()
            .to_string_lossy()
            .to_string();
        if !owner_id.is_empty() {
            return Some(OwnerKey {
                owner_type,
                owner_id,
            });
        }
    }
    None
}

fn avatar_key(
    path: &Path,
    agents_dir: &Path,
    groups_dir: &Path,
    user_data_dir: &Path,
) -> Option<AvatarKey> {
    if path == user_data_dir.join("user_avatar.png") {
        return Some(AvatarKey {
            owner_type: AvatarOwnerType::User,
            owner_id: "user_avatar".to_string(),
        });
    }
    for (owner_type, base) in [
        (AvatarOwnerType::Agent, agents_dir),
        (AvatarOwnerType::Group, groups_dir),
    ] {
        let Ok(relative) = path.strip_prefix(base) else {
            continue;
        };
        let components = relative.components().collect::<Vec<_>>();
        if components.len() != 2 {
            continue;
        }
        let file_name = components[1].as_os_str().to_string_lossy();
        if ![
            "avatar.png",
            "avatar.jpg",
            "avatar.jpeg",
            "avatar.webp",
            "avatar.gif",
        ]
        .iter()
        .any(|candidate| file_name.eq_ignore_ascii_case(candidate))
        {
            continue;
        }
        let owner_id = components[0].as_os_str().to_string_lossy().to_string();
        if !owner_id.is_empty() {
            return Some(AvatarKey {
                owner_type,
                owner_id,
            });
        }
    }
    None
}
