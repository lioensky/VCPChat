mod config;
mod domain;
mod error;
mod identity;
mod ingest;
mod protocol;
mod search;
mod storage;
mod sync;
mod watcher;

use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    net::IpAddr,
    sync::{atomic::AtomicU64, Arc},
};

use anyhow::{Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use clap::Parser;
use fs2::FileExt;
use rand::RngCore;
use tokio::{net::TcpListener, sync::Mutex};
use tokio_util::sync::CancellationToken;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};
use uuid::Uuid;

use crate::{
    config::{Cli, ServiceConfig, PROTOCOL_VERSION, SCHEMA_VERSION},
    identity::IdentityResolver,
    ingest::Reconciler,
    protocol::{AppState, ReadyHandshake},
    search::SearchIndex,
    storage::{now_ms, Database},
    watcher::WatcherRuntime,
};

struct InstanceLock {
    file: File,
}

impl InstanceLock {
    fn acquire(config: &ServiceConfig, instance_id: Uuid) -> Result<Self> {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&config.lock_path)
            .with_context(|| format!("failed to open lock file {}", config.lock_path.display()))?;

        file.try_lock_exclusive().with_context(|| {
            format!(
                "another VCP-CDS instance already owns AppData {}",
                config.app_data.display()
            )
        })?;

        file.set_len(0)?;
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "instanceId": instance_id,
                "pid": std::process::id(),
                "appData": config.app_data,
                "startedAt": now_ms()
            })
        )?;
        file.sync_data()?;
        Ok(Self { file })
    }
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[tokio::main]
async fn main() {
    init_tracing();
    if let Err(error) = run().await {
        tracing::error!(error = ?error, "VCP-CDS terminated with an error");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();
    let config = Arc::new(ServiceConfig::from_cli(cli)?);
    fs::create_dir_all(&config.agents_dir)?;
    fs::create_dir_all(&config.groups_dir)?;
    fs::create_dir_all(&config.user_data_dir)?;

    let instance_id = Uuid::new_v4();
    let _instance_lock = InstanceLock::acquire(&config, instance_id)?;
    let auth_token = generate_auth_token();

    let database = Database::open(&config.database_path)?;
    tracing::info!(
        database = %database.path().display(),
        schema_version = SCHEMA_VERSION,
        "database is ready"
    );

    let reconciler = Reconciler::new(config.clone(), database.clone());

    // Opening the durable mirror is part of readiness; scanning every owner and
    // history file is not. The watcher recovery worker performs the initial
    // metadata-based reconcile after the HTTP service has become available.
    let search = if config.tantivy_enabled {
        match SearchIndex::open(&config.index_dir, database.clone()) {
            Ok(index) => {
                tracing::info!("search index opened");
                Some(index)
            }
            Err(error) => {
                let isolated = config
                    .database_dir
                    .join(format!("chat_search_index.corrupt.{}", now_ms()));
                if config.index_dir.exists() {
                    fs::rename(&config.index_dir, &isolated).with_context(|| {
                        format!(
                            "failed to isolate unusable search index at {}",
                            isolated.display()
                        )
                    })?;
                }
                tracing::error!(
                    error = ?error,
                    isolated_path = %isolated.display(),
                    "isolated unusable search index and rebuilding"
                );
                let index = SearchIndex::open(&config.index_dir, database.clone())?;
                tracing::info!("replacement search index opened; rebuild queued");
                Some(index)
            }
        }
    } else {
        None
    };

    let cancellation = CancellationToken::new();
    let reconcile_lock = Arc::new(Mutex::new(()));
    let watcher_runtime = if config.notify_enabled {
        Some(WatcherRuntime::start(
            reconciler.clone(),
            search.clone(),
            cancellation.clone(),
            reconcile_lock.clone(),
        )?)
    } else {
        None
    };
    let watcher_metrics = watcher_runtime
        .as_ref()
        .map(|runtime| runtime.metrics.clone());

    let state = AppState {
        instance_id,
        auth_token: Arc::from(auth_token.clone()),
        started_at: now_ms(),
        reconciler: reconciler.clone(),
        search,
        identity: IdentityResolver::new(database.clone()),
        cancellation: cancellation.clone(),
        watcher_metrics,
        reconcile_lock,
        pending_index: Arc::new(AtomicU64::new(0)),
    };

    let bind_ip: IpAddr = config
        .host
        .parse()
        .or_else(|_| {
            if config.host == "localhost" {
                Ok::<IpAddr, std::net::AddrParseError>(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST))
            } else {
                config.host.parse()
            }
        })
        .context("invalid bind address")?;
    if !bind_ip.is_loopback() {
        anyhow::bail!("refusing to bind VCP-CDS to a non-loopback address");
    }

    let listener = TcpListener::bind((bind_ip, config.port))
        .await
        .context("failed to bind local HTTP listener")?;
    let address = listener.local_addr()?;

    // stdout is reserved for the one-time machine-readable handshake.
    println!(
        "{}",
        serde_json::to_string(&ReadyHandshake {
            message_type: "ready",
            protocol_version: PROTOCOL_VERSION,
            schema_version: SCHEMA_VERSION,
            port: address.port(),
            instance_id,
            auth_token,
        })?
    );
    std::io::stdout().flush()?;

    tracing::info!(
        address = %address,
        instance_id = %instance_id,
        protocol_version = PROTOCOL_VERSION,
        "VCP-CDS is ready"
    );

    // Run consistency work only after publishing readiness. The persisted
    // source metadata makes this a cheap stat-based pass for unchanged files;
    // file reads, JSON parsing, hashing and Tantivy updates are limited to
    // sources whose mtime or size changed. This task also runs when filesystem
    // notifications are disabled.
    let startup_reconciler = reconciler.clone();
    let startup_search = state.search.clone();
    let startup_reconcile_lock = state.reconcile_lock.clone();
    let startup_watcher_metrics = state.watcher_metrics.clone();
    tokio::spawn(async move {
        // Give the HTTP server its first poll before beginning blocking
        // filesystem/SQLite work, so the health probe following the handshake
        // cannot race with background reconciliation.
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let _guard = startup_reconcile_lock.lock().await;
        match startup_reconciler.reconcile().await {
            Ok(stats) => {
                tracing::info!(?stats, "background startup reconcile completed");
                if let Some(index) = startup_search {
                    if let Err(error) = index.reconcile_revisions() {
                        tracing::error!(error = ?error, "background startup index reconcile failed");
                        if let Some(metrics) = startup_watcher_metrics {
                            metrics
                                .reconcile_required
                                .store(true, std::sync::atomic::Ordering::Release);
                        }
                    }
                }
            }
            Err(error) => {
                tracing::error!(error = ?error, "background startup reconcile failed");
                if let Some(metrics) = startup_watcher_metrics {
                    metrics
                        .reconcile_required
                        .store(true, std::sync::atomic::Ordering::Release);
                }
            }
        }
    });

    let signal_cancellation = cancellation.clone();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal_cancellation.cancel();
        }
    });

    let shutdown = cancellation.clone();
    axum::serve(listener, protocol::router(state))
        .with_graceful_shutdown(async move {
            shutdown.cancelled().await;
        })
        .await
        .context("HTTP server failed")?;

    cancellation.cancel();
    if let Some(runtime) = watcher_runtime {
        runtime.shutdown().await;
    }
    database.checkpoint()?;
    tracing::info!("VCP-CDS shutdown completed");
    Ok(())
}

fn init_tracing() {
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("vcp_chat_data_service=info,tower_http=warn"));
    tracing_subscriber::registry()
        .with(env_filter)
        .with(
            fmt::layer()
                .json()
                .with_writer(std::io::stderr)
                .with_current_span(false),
        )
        .init();
}

fn generate_auth_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
