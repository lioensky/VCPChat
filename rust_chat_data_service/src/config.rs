use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::Parser;

pub const PROTOCOL_VERSION: u32 = 3;
pub const SCHEMA_VERSION: u32 = 3;

#[derive(Debug, Clone, Parser)]
#[command(name = "vcp-chat-data-service", version, about)]
pub struct Cli {
    /// VCPChat AppData directory.
    #[arg(long, env = "VCP_CDS_APP_DATA")]
    pub app_data: PathBuf,

    /// Loopback address. Non-loopback addresses are rejected.
    #[arg(long, default_value = "127.0.0.1")]
    pub host: String,

    /// Port 0 lets the operating system select an available port.
    #[arg(long, default_value_t = 0)]
    pub port: u16,

    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    pub notify_enabled: bool,

    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    pub tantivy_enabled: bool,

    #[arg(long, default_value_t = 8192)]
    pub raw_event_capacity: usize,

    #[arg(long, default_value_t = 4096)]
    pub coalesced_path_capacity: usize,

    #[arg(long, default_value_t = 256)]
    pub ingest_capacity: usize,
}

#[derive(Debug, Clone)]
pub struct ServiceConfig {
    pub app_data: PathBuf,
    pub agents_dir: PathBuf,
    pub groups_dir: PathBuf,
    pub user_data_dir: PathBuf,
    pub database_dir: PathBuf,
    pub database_path: PathBuf,
    pub index_dir: PathBuf,
    pub lock_path: PathBuf,
    pub host: String,
    pub port: u16,
    pub notify_enabled: bool,
    pub tantivy_enabled: bool,
    pub raw_event_capacity: usize,
    pub coalesced_path_capacity: usize,
    pub ingest_capacity: usize,
}

impl ServiceConfig {
    pub fn from_cli(cli: Cli) -> Result<Self> {
        if cli.host != "127.0.0.1" && cli.host != "::1" && cli.host != "localhost" {
            anyhow::bail!("VCP-CDS only permits loopback bind addresses");
        }

        std::fs::create_dir_all(&cli.app_data).with_context(|| {
            format!(
                "failed to create AppData directory {}",
                cli.app_data.display()
            )
        })?;
        let app_data = cli.app_data.canonicalize().with_context(|| {
            format!("failed to canonicalize AppData {}", cli.app_data.display())
        })?;

        let database_dir = app_data.join("databases");
        std::fs::create_dir_all(&database_dir)
            .with_context(|| format!("failed to create {}", database_dir.display()))?;

        Ok(Self {
            agents_dir: app_data.join("Agents"),
            groups_dir: app_data.join("AgentGroups"),
            user_data_dir: app_data.join("UserData"),
            database_path: database_dir.join("chat_data.sqlite3"),
            index_dir: database_dir.join("chat_search_index"),
            lock_path: database_dir.join("chat_data_service.lock"),
            database_dir,
            app_data,
            host: cli.host,
            port: cli.port,
            notify_enabled: cli.notify_enabled,
            tantivy_enabled: cli.tantivy_enabled,
            raw_event_capacity: cli.raw_event_capacity.max(64),
            coalesced_path_capacity: cli.coalesced_path_capacity.max(64),
            ingest_capacity: cli.ingest_capacity.max(16),
        })
    }

    pub fn validate_source_path(&self, path: &Path) -> Result<PathBuf> {
        let canonical = path
            .canonicalize()
            .with_context(|| format!("failed to canonicalize {}", path.display()))?;
        if !canonical.starts_with(&self.app_data) {
            anyhow::bail!("path is outside configured AppData");
        }
        Ok(canonical)
    }
}
