use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock},
    time::{Duration, UNIX_EPOCH},
};

use crate::{
    config::ServiceConfig,
    domain::{
        AvatarKey, AvatarOwnerType, AvatarRecord, NormalizedMessage, OwnerKey, OwnerRecord,
        OwnerType, TopicDefinition, TopicKey, TopicSource,
    },
    storage::{now_ms, Database, IngestCommit, OwnerHashMode, SearchUpdate},
    sync::{mobile_owner_config_hash_from_value, mobile_topic_config_hash},
    sync_wire::{canonicalize_message, message_fingerprint, WireWarnings},
};
use anyhow::{Context, Result};
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tokio::time::sleep;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct SnapshotStale(pub String);

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileStats {
    pub owners_seen: usize,
    pub owners_deleted: usize,
    pub avatars_seen: usize,
    pub avatars_deleted: usize,
    pub topics_seen: usize,
    pub files_checked: usize,
    pub files_skipped: usize,
    pub files_ingested: usize,
    pub files_deleted: usize,
    pub files_invalid: usize,
    pub messages_ingested: usize,
    pub messages_deleted: usize,
    pub duration_ms: i64,
}

#[derive(Clone)]
pub struct Reconciler {
    config: Arc<ServiceConfig>,
    database: Database,
}

impl Reconciler {
    pub fn new(config: Arc<ServiceConfig>, database: Database) -> Self {
        Self { config, database }
    }

    pub fn config(&self) -> &Arc<ServiceConfig> {
        &self.config
    }

    pub fn database(&self) -> &Database {
        &self.database
    }

    pub async fn reconcile(&self) -> Result<ReconcileStats> {
        let started = now_ms();
        let owners = self.scan_owner_registry()?;
        let mut live_owner_keys = HashSet::new();
        let mut stats = ReconcileStats {
            owners_seen: owners.len(),
            ..Default::default()
        };

        for configured_owner in owners.values() {
            if let Some(key) = self
                .reconcile_owner_record(configured_owner, &mut stats)
                .await?
            {
                live_owner_keys.insert(key);
            }
        }

        let active_owner_keys = owners.keys().cloned().collect::<HashSet<_>>();
        stats.owners_deleted = self.database.reconcile_missing_owners(&active_owner_keys)?;
        let (avatars_seen, avatars_deleted) = self.reconcile_avatars(&live_owner_keys)?;
        stats.avatars_seen = avatars_seen;
        stats.avatars_deleted = avatars_deleted;

        self.database.set_last_reconcile_at(now_ms())?;
        stats.duration_ms = now_ms() - started;
        Ok(stats)
    }

    async fn reconcile_owner_record(
        &self,
        configured_owner: &OwnerRecord,
        stats: &mut ReconcileStats,
    ) -> Result<Option<OwnerKey>> {
        let owner = self.effective_owner(configured_owner)?;
        if !self
            .database
            .upsert_owner(&owner, OwnerHashMode::Deferred)?
        {
            return Ok(None);
        }
        for topic in &owner.topics {
            let source = self.topic_source(&owner, topic);
            stats.topics_seen += 1;
            stats.files_checked += 1;

            match self
                .ingest_source_if_changed(&source, OwnerHashMode::Deferred)
                .await
            {
                Ok(Some(commit)) => {
                    stats.files_ingested += usize::from(commit.changed);
                    stats.files_skipped += usize::from(!commit.changed);
                    stats.messages_ingested += commit.message_count;
                }
                Ok(None) => {
                    if self
                        .database
                        .mark_history_source_missing(&source, OwnerHashMode::Deferred)?
                    {
                        stats.files_invalid += 1;
                        tracing::warn!(
                            owner_type = %source.key.owner_type,
                            owner_id = %source.key.owner_id,
                            topic_id = %source.key.topic_id,
                            "previously indexed history source is missing"
                        );
                    } else {
                        stats.files_skipped += 1;
                    }
                }
                Err(error) => {
                    stats.files_invalid += 1;
                    self.database.mark_source_invalid(
                        &source,
                        &format!("{error:#}"),
                        OwnerHashMode::Deferred,
                    )?;
                    tracing::warn!(
                        owner_type = %source.key.owner_type,
                        owner_id = %source.key.owner_id,
                        topic_id = %source.key.topic_id,
                        error = ?error,
                        "history source was not ingested"
                    );
                }
            }
        }
        self.database.refresh_owner_content_hash(&owner.key)?;
        Ok(Some(owner.key))
    }

    pub async fn reconcile_owner_key(&self, key: &OwnerKey) -> Result<ReconcileStats> {
        let started = now_ms();
        let mut stats = ReconcileStats::default();
        match self.configured_owner_for_key(key)? {
            Some(owner) => {
                stats.owners_seen = 1;
                self.reconcile_owner_record(&owner, &mut stats).await?;
            }
            None => {
                stats.owners_deleted = usize::from(self.database.reconcile_missing_owner(key)?);
            }
        }
        stats.duration_ms = now_ms() - started;
        Ok(stats)
    }

    pub fn reconcile_avatar_key(&self, key: &AvatarKey) -> Result<bool> {
        if self.physical_avatar_path(key).is_some() {
            self.commit_avatar(key)?;
            return Ok(true);
        }
        self.database.mark_physical_avatar_missing(key, now_ms())?;
        Ok(false)
    }

    pub fn commit_avatar(&self, key: &AvatarKey) -> Result<AvatarRecord> {
        if self.database.avatar_parent_is_tombstoned(key)? {
            anyhow::bail!("avatar parent is deleted");
        }
        if let Some(owner_type) = key.owner_type.owner_type() {
            let parent_is_committed = self
                .database
                .owner_by_id(owner_type, &key.owner_id)?
                .is_some();
            if !parent_is_committed {
                let config_path = match key.owner_type {
                    AvatarOwnerType::Agent => self.config.agents_dir.join(&key.owner_id),
                    AvatarOwnerType::Group => self.config.groups_dir.join(&key.owner_id),
                    AvatarOwnerType::User => unreachable!(),
                }
                .join("config.json");
                anyhow::ensure!(
                    config_path.is_file(),
                    "avatar parent has not been committed and has no physical config"
                );
            }
        }

        let path = self
            .physical_avatar_path(key)
            .with_context(|| format!("avatar file is missing for {}", key.wire_id()))?;
        let hash = sha256_hex(
            &fs::read(&path).with_context(|| format!("failed to read {}", path.display()))?,
        );
        anyhow::ensure!(
            self.database.upsert_avatar(key, &path, &hash, now_ms())?,
            "avatar is tombstoned"
        );
        self.database
            .avatar_state(key)?
            .context("committed avatar state is missing")
    }

    fn reconcile_avatars(&self, live_owners: &HashSet<OwnerKey>) -> Result<(usize, usize)> {
        let detected_at = now_ms();
        let mut active = HashSet::new();
        let mut seen = 0;

        let user_key = AvatarKey {
            owner_type: AvatarOwnerType::User,
            owner_id: "user_avatar".to_string(),
        };
        if self.commit_physical_avatar(&user_key, detected_at)? {
            active.insert(user_key);
            seen += 1;
        }

        for owner in live_owners {
            let key = AvatarKey {
                owner_type: match owner.owner_type {
                    OwnerType::Agent => AvatarOwnerType::Agent,
                    OwnerType::Group => AvatarOwnerType::Group,
                },
                owner_id: owner.owner_id.clone(),
            };
            if self.commit_physical_avatar(&key, detected_at)? {
                active.insert(key);
                seen += 1;
            }
        }

        let deleted = self
            .database
            .reconcile_missing_avatars(&active, detected_at)?;
        Ok((seen, deleted))
    }

    fn commit_physical_avatar(&self, key: &AvatarKey, detected_at: i64) -> Result<bool> {
        let Some(path) = self.physical_avatar_path(key) else {
            return Ok(false);
        };
        let bytes =
            fs::read(&path).with_context(|| format!("failed to read avatar {}", path.display()))?;
        let hash = sha256_hex(&bytes);
        self.database
            .upsert_avatar(key, &path, &hash, detected_at)?;
        Ok(true)
    }

    fn physical_avatar_path(&self, key: &AvatarKey) -> Option<std::path::PathBuf> {
        if key.owner_type == AvatarOwnerType::User {
            let path = self.config.user_data_dir.join("user_avatar.png");
            return path.is_file().then_some(path);
        }
        let directory = match key.owner_type {
            AvatarOwnerType::Agent => self.config.agents_dir.join(&key.owner_id),
            AvatarOwnerType::Group => self.config.groups_dir.join(&key.owner_id),
            AvatarOwnerType::User => unreachable!(),
        };
        for extension in ["png", "jpg", "jpeg", "webp", "gif"] {
            let path = directory.join(format!("avatar.{extension}"));
            if path.is_file() {
                return Some(path);
            }
        }
        None
    }

    pub async fn ingest_path(&self, path: &Path, _origin: &str) -> Result<Option<IngestCommit>> {
        self.ingest_path_with_owner_hash_mode(path, OwnerHashMode::Immediate)
            .await
    }

    pub async fn ingest_path_with_owner_hash_mode(
        &self,
        path: &Path,
        owner_hash_mode: OwnerHashMode,
    ) -> Result<Option<IngestCommit>> {
        let Some((owner_id, topic_id)) = parse_history_path(&self.config.user_data_dir, path)
        else {
            return Ok(None);
        };
        if !path.is_file() {
            return Ok(None);
        }

        if let Some(source) = self.database.live_topic_source_by_path(path)? {
            return match self
                .ingest_source_if_changed(&source, owner_hash_mode)
                .await
            {
                Ok(commit) => Ok(commit),
                Err(error) => {
                    self.database.mark_source_invalid(
                        &source,
                        &format!("{error:#}"),
                        OwnerHashMode::Immediate,
                    )?;
                    Err(error)
                }
            };
        }

        let configured_owner = self.configured_owner_by_id(&owner_id)?;
        let owner = self.effective_owner(&configured_owner)?;

        let topic = owner
            .topics
            .iter()
            .find(|topic| topic.topic_id == topic_id)
            .cloned()
            .with_context(|| {
                format!("physical history topic {topic_id} disappeared while preparing ingestion")
            })?;
        let source = self.topic_source(&owner, &topic);
        if !self
            .database
            .upsert_owner(&owner, OwnerHashMode::Deferred)?
        {
            return Ok(None);
        }
        match self
            .ingest_source_if_changed(&source, owner_hash_mode)
            .await
        {
            Ok(commit) => Ok(commit),
            Err(error) => {
                self.database.mark_source_invalid(
                    &source,
                    &format!("{error:#}"),
                    OwnerHashMode::Immediate,
                )?;
                Err(error)
            }
        }
    }

    fn effective_owner(&self, configured_owner: &OwnerRecord) -> Result<OwnerRecord> {
        let physical_topic_ids = self.physical_topic_ids(&configured_owner.key.owner_id)?;
        let physical_topic_set = physical_topic_ids.iter().cloned().collect::<HashSet<_>>();
        let mut recovered_topics = Vec::new();
        let mut configured_topics = Vec::new();
        let mut active_topic_ids = HashSet::new();
        for topic in &configured_owner.topics {
            if !physical_topic_set.contains(&topic.topic_id)
                || !active_topic_ids.insert(topic.topic_id.clone())
            {
                continue;
            }
            let key = TopicKey {
                owner_type: configured_owner.key.owner_type,
                owner_id: configured_owner.key.owner_id.clone(),
                topic_id: topic.topic_id.clone(),
            };
            if self.database.topic_is_tombstoned(&key)? {
                continue;
            }
            let normalized = self.normalize_recovered_timestamp(&key, topic.clone())?;
            if is_synthetic_recovered_topic(&normalized) {
                recovered_topics.push(normalized);
            } else {
                configured_topics.push(normalized);
            }
        }

        for topic_id in physical_topic_ids {
            if active_topic_ids.contains(&topic_id) {
                continue;
            }
            let key = TopicKey {
                owner_type: configured_owner.key.owner_type,
                owner_id: configured_owner.key.owner_id.clone(),
                topic_id: topic_id.clone(),
            };
            if self.database.topic_is_tombstoned(&key)? {
                continue;
            }
            if let Some(mut recovered) = self.database.topic_recovery_definition(&key)? {
                if mobile_topic_config_hash(&key, &recovered.metadata) == recovered.config_hash {
                    recovered = self.normalize_recovered_timestamp(&key, recovered)?;
                    recovered_topics.push(recovered);
                    active_topic_ids.insert(topic_id);
                    continue;
                }
                tracing::warn!(
                    owner_type = %key.owner_type,
                    owner_id = %key.owner_id,
                    topic_id = %key.topic_id,
                    "stored topic recovery hash is inconsistent; using minimal metadata"
                );
            }
            let recovered_name = format!("Recovered: {topic_id}");
            let created_at = self.recovery_timestamp(&key)?;
            let metadata = if key.owner_type == OwnerType::Agent {
                serde_json::json!({
                    "id": topic_id.clone(),
                    "name": recovered_name.clone(),
                    "createdAt": created_at,
                    "locked": true,
                    "unread": false,
                    "creatorSource": "recovery"
                })
            } else {
                serde_json::json!({
                    "id": topic_id.clone(),
                    "name": recovered_name.clone(),
                    "createdAt": created_at
                })
            };
            recovered_topics.push(TopicDefinition {
                topic_id,
                display_name: Some(recovered_name),
                created_at: Some(created_at),
                ordinal: 0,
                config_hash: mobile_topic_config_hash(&key, &metadata),
                metadata,
            });
            active_topic_ids.insert(key.topic_id);
        }

        // 只把恢复分区前置，不按时间重排用户已有的 Topic 顺序。
        recovered_topics.extend(configured_topics);
        for (ordinal, topic) in recovered_topics.iter_mut().enumerate() {
            topic.ordinal = ordinal as i64;
        }
        let mut effective = configured_owner.clone();
        effective.topics = recovered_topics;
        Ok(effective)
    }

    fn normalize_recovered_timestamp(
        &self,
        key: &TopicKey,
        mut topic: TopicDefinition,
    ) -> Result<TopicDefinition> {
        if !is_synthetic_recovered_topic(&topic) {
            return Ok(topic);
        }
        let created_at = self.recovery_timestamp(key)?;
        topic.created_at = Some(created_at);
        let metadata = topic
            .metadata
            .as_object_mut()
            .context("recovered topic metadata must be an object")?;
        metadata.insert("createdAt".to_string(), Value::Number(created_at.into()));
        topic.config_hash = mobile_topic_config_hash(key, &topic.metadata);
        Ok(topic)
    }

    fn recovery_timestamp(&self, key: &TopicKey) -> Result<i64> {
        if let Some(timestamp) = topic_timestamp_from_id(&key.topic_id) {
            return Ok(timestamp);
        }
        let history_path = self
            .config
            .user_data_dir
            .join(&key.owner_id)
            .join("topics")
            .join(&key.topic_id)
            .join("history.json");
        let metadata = match fs::metadata(&history_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(0),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to inspect {}", history_path.display()));
            }
        };
        if !metadata.is_file() {
            return Ok(0);
        }
        Ok(metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
            .unwrap_or(0))
    }

    fn physical_topic_ids(&self, owner_id: &str) -> Result<Vec<String>> {
        let topics_directory = self.config.user_data_dir.join(owner_id).join("topics");
        let metadata = match fs::metadata(&topics_directory) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to inspect {}", topics_directory.display()));
            }
        };
        anyhow::ensure!(
            metadata.is_dir(),
            "physical topics path is not a directory: {}",
            topics_directory.display()
        );

        let mut topic_ids = Vec::new();
        for entry in fs::read_dir(&topics_directory)
            .with_context(|| format!("failed to read {}", topics_directory.display()))?
        {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                topic_ids.push(entry.file_name().to_string_lossy().to_string());
            }
        }
        topic_ids.sort();
        Ok(topic_ids)
    }

    pub fn scan_owner_registry(&self) -> Result<HashMap<OwnerKey, OwnerRecord>> {
        let mut owners = HashMap::new();
        self.scan_owner_directory(OwnerType::Agent, &self.config.agents_dir, &mut owners)?;
        self.scan_owner_directory(OwnerType::Group, &self.config.groups_dir, &mut owners)?;
        Ok(owners)
    }

    fn configured_owner_by_id(&self, owner_id: &str) -> Result<OwnerRecord> {
        for owner_type in [OwnerType::Agent, OwnerType::Group] {
            let key = OwnerKey {
                owner_type,
                owner_id: owner_id.to_string(),
            };
            if let Some(owner) = self.configured_owner_for_key(&key)? {
                return Ok(owner);
            }
        }
        anyhow::bail!("history owner {owner_id} has no Agent or Group config")
    }

    fn configured_owner_for_key(&self, key: &OwnerKey) -> Result<Option<OwnerRecord>> {
        let directory = match key.owner_type {
            OwnerType::Agent => &self.config.agents_dir,
            OwnerType::Group => &self.config.groups_dir,
        };
        let owner_directory = directory.join(&key.owner_id);
        if !owner_directory.is_dir() {
            return Ok(None);
        }
        let config_path = owner_directory.join("config.json");
        if config_path.is_file() {
            match parse_owner_config(key.owner_type, key.owner_id.clone(), &config_path) {
                Ok(owner) => return Ok(Some(owner)),
                Err(error) => {
                    tracing::warn!(
                        owner_type = %key.owner_type,
                        owner_id = %key.owner_id,
                        config_path = %config_path.display(),
                        error = ?error,
                        "owner config is invalid; checking physical topics for recovery"
                    );
                    if let Some(owner) =
                        self.recovery_owner(key.owner_type, key.owner_id.clone(), config_path)?
                    {
                        return Ok(Some(owner));
                    }
                    return Err(error);
                }
            }
        }
        self.recovery_owner(key.owner_type, key.owner_id.clone(), config_path)
    }

    fn scan_owner_directory(
        &self,
        owner_type: OwnerType,
        directory: &Path,
        owners: &mut HashMap<OwnerKey, OwnerRecord>,
    ) -> Result<()> {
        if !directory.exists() {
            return Ok(());
        }

        for entry in fs::read_dir(directory)
            .with_context(|| format!("failed to read {}", directory.display()))?
        {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let owner_id = entry.file_name().to_string_lossy().to_string();
            let config_path = entry.path().join("config.json");
            if !config_path.is_file() {
                tracing::warn!(
                    owner_type = %owner_type,
                    owner_id,
                    config_path = %config_path.display(),
                    "owner config is missing; checking physical topics for recovery"
                );
                if let Some(owner) = self.recovery_owner(owner_type, owner_id, config_path)? {
                    owners.insert(owner.key.clone(), owner);
                }
                continue;
            }

            match parse_owner_config(owner_type, owner_id.clone(), &config_path) {
                Ok(owner) => {
                    owners.insert(owner.key.clone(), owner);
                }
                Err(error) => {
                    tracing::warn!(
                        owner_type = %owner_type,
                        owner_id,
                        config_path = %config_path.display(),
                        error = ?error,
                        "owner config is invalid; checking physical topics for recovery"
                    );
                    if let Some(owner) = self.recovery_owner(owner_type, owner_id, config_path)? {
                        owners.insert(owner.key.clone(), owner);
                    }
                }
            }
        }
        Ok(())
    }

    fn recovery_owner(
        &self,
        owner_type: OwnerType,
        owner_id: String,
        config_path: impl Into<std::path::PathBuf>,
    ) -> Result<Option<OwnerRecord>> {
        if self.physical_topic_ids(&owner_id)?.is_empty() {
            return Ok(None);
        }
        let display_name = self
            .database
            .owner_by_id(owner_type, &owner_id)?
            .map(|(_, display_name)| display_name)
            .unwrap_or_else(|| owner_id.clone());
        let recovery_config = serde_json::json!({ "name": display_name.clone() });
        Ok(Some(OwnerRecord {
            key: OwnerKey {
                owner_type,
                owner_id,
            },
            display_name,
            config_path: config_path.into(),
            config_hash: mobile_owner_config_hash_from_value(owner_type, &recovery_config)?,
            source_config_hash: None,
            topics: Vec::new(),
        }))
    }

    fn topic_source(&self, owner: &OwnerRecord, topic: &TopicDefinition) -> TopicSource {
        TopicSource {
            key: TopicKey {
                owner_type: owner.key.owner_type,
                owner_id: owner.key.owner_id.clone(),
                topic_id: topic.topic_id.clone(),
            },
            source_path: self
                .config
                .user_data_dir
                .join(&owner.key.owner_id)
                .join("topics")
                .join(&topic.topic_id)
                .join("history.json"),
        }
    }

    async fn ingest_source_if_changed(
        &self,
        source: &TopicSource,
        owner_hash_mode: OwnerHashMode,
    ) -> Result<Option<IngestCommit>> {
        if !source.source_path.exists() {
            return Ok(None);
        }

        let metadata = fs::metadata(&source.source_path)?;
        if !metadata.is_file() || metadata.len() == 0 {
            anyhow::bail!("history source is empty or not a regular file");
        }
        let mtime_ns = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos().min(i64::MAX as u128) as i64)
            .unwrap_or(0);
        let file_size = metadata.len().min(i64::MAX as u64) as i64;

        if let Some(previous) = self.database.source_metadata(&source.source_path)? {
            anyhow::ensure!(
                previous.matches_topic(&source.key),
                "history source identity conflict at {}: stored={}/{}/{}, expected={}/{}/{}",
                source.source_path.display(),
                previous.owner_type,
                previous.owner_id,
                previous.topic_id,
                source.key.owner_type.as_str(),
                source.key.owner_id,
                source.key.topic_id,
            );
            if mtime_ns != 0
                && previous.mtime_ns == mtime_ns
                && previous.file_size == file_size
                && previous.status == "ready"
                && previous.last_error.is_none()
                && is_internal_sha256(previous.source_hash.as_deref())
            {
                let (revision, indexed_revision) = self
                    .database
                    .topic_revision_state(&source.key)?
                    .unwrap_or((0, 0));
                return Ok(Some(IngestCommit {
                    topic: source.key.clone(),
                    revision,
                    changed: false,
                    owner_hash_dirty: false,
                    search_update: SearchUpdate::for_revision_gap(revision, indexed_revision),
                    message_count: 0,
                }));
            }
        }

        let (mut bytes, mut mtime_ns, mut file_size) =
            read_stable_file(&source.source_path, (mtime_ns, file_size)).await?;
        let mut source_hash = sha256_hex(&bytes);
        let tombstoned_ids = self.database.message_tombstone_ids(&source.key)?;
        if !tombstoned_ids.is_empty() {
            let mut history: Vec<Value> =
                serde_json::from_slice(&bytes).context("history root must be an array")?;
            let previous_len = history.len();
            history.retain(|message| {
                message
                    .get("id")
                    .and_then(Value::as_str)
                    .is_none_or(|id| !tombstoned_ids.contains(id))
            });
            let removed = previous_len - history.len();
            if removed > 0 {
                let repaired = serde_json::to_vec_pretty(&history)?;
                let committed =
                    write_history_atomic(&source.source_path, &repaired, Some(&source_hash))?
                        .context("tombstone repair did not commit")?;
                bytes = repaired;
                mtime_ns = committed.mtime_ns;
                file_size = committed.file_size;
                source_hash = committed.source_hash;
                tracing::warn!(
                    owner_type = %source.key.owner_type,
                    owner_id = %source.key.owner_id,
                    topic_id = %source.key.topic_id,
                    removed,
                    "removed tombstoned messages from physical history"
                );
            }
        }
        if let Some(commit) = self.database.refresh_unchanged_history_source(
            source,
            mtime_ns,
            file_size,
            &source_hash,
            owner_hash_mode,
        )? {
            return Ok(Some(commit));
        }
        let messages = normalize_history(&bytes, source.key.owner_type, &source.key.topic_id)?;

        self.database
            .ingest_topic(
                source,
                &messages,
                mtime_ns,
                file_size,
                &source_hash,
                owner_hash_mode,
            )
            .map(Some)
    }
}

fn topic_timestamp_from_id(topic_id: &str) -> Option<i64> {
    ["topic_", "group_topic_"]
        .into_iter()
        .find_map(|prefix| topic_id.strip_prefix(prefix))
        .filter(|timestamp| {
            !timestamp.is_empty() && timestamp.bytes().all(|byte| byte.is_ascii_digit())
        })
        .and_then(|timestamp| timestamp.parse::<i64>().ok())
        .filter(|timestamp| (0..=((1_i64 << 53) - 1)).contains(timestamp))
}

fn is_synthetic_recovered_topic(topic: &TopicDefinition) -> bool {
    topic
        .display_name
        .as_deref()
        .and_then(|name| name.strip_prefix("Recovered: "))
        == Some(topic.topic_id.as_str())
}

pub fn parse_owner_config(
    owner_type: OwnerType,
    owner_id: String,
    config_path: &Path,
) -> Result<OwnerRecord> {
    let bytes = fs::read(config_path)
        .with_context(|| format!("failed to read {}", config_path.display()))?;
    let root: Value = serde_json::from_slice(&bytes)
        .with_context(|| format!("invalid JSON in {}", config_path.display()))?;
    let object = root
        .as_object()
        .context("owner config root must be an object")?;
    let display_name = object
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&owner_id)
        .to_string();

    let topics = object
        .get("topics")
        .and_then(Value::as_array)
        .map(|topics| {
            topics
                .iter()
                .enumerate()
                .filter_map(|(ordinal, value)| {
                    let topic = value.as_object()?;
                    let topic_id = string_value(topic.get("id"))?;
                    let key = TopicKey {
                        owner_type,
                        owner_id: owner_id.clone(),
                        topic_id: topic_id.clone(),
                    };
                    Some(TopicDefinition {
                        topic_id,
                        display_name: string_value(topic.get("name")),
                        created_at: integer_value(topic.get("createdAt")),
                        ordinal: ordinal as i64,
                        config_hash: mobile_topic_config_hash(&key, value),
                        metadata: value.clone(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let source_config_hash = sha256_hex(&bytes);
    Ok(OwnerRecord {
        key: OwnerKey {
            owner_type,
            owner_id,
        },
        display_name,
        config_path: config_path.to_path_buf(),
        config_hash: mobile_owner_config_hash_from_value(owner_type, &root)?,
        source_config_hash: Some(source_config_hash),
        topics,
    })
}

pub fn normalize_history(
    bytes: &[u8],
    owner_type: OwnerType,
    topic_id: &str,
) -> Result<Vec<NormalizedMessage>> {
    let history: Vec<Value> =
        serde_json::from_slice(bytes).context("history root must be an array")?;
    normalize_history_values(history, owner_type, topic_id)
}

pub fn normalize_history_values(
    history: Vec<Value>,
    owner_type: OwnerType,
    topic_id: &str,
) -> Result<Vec<NormalizedMessage>> {
    let mut seen_ids = HashSet::new();

    history
        .into_iter()
        .enumerate()
        .map(|(ordinal, value)| {
            let Value::Object(object) = value else {
                anyhow::bail!("message at ordinal {ordinal} must be an object");
            };
            normalize_message(object, ordinal, owner_type, topic_id, &mut seen_ids)
        })
        .collect()
}

fn normalize_message(
    object: Map<String, Value>,
    ordinal: usize,
    owner_type: OwnerType,
    topic_id: &str,
    seen_ids: &mut HashSet<String>,
) -> Result<NormalizedMessage> {
    let metadata_json = serde_json::to_string(&object)?;
    let speaker_name_fallback = string_value(object.get("speakerName"));
    let speaker_agent_id_fallback = string_value(object.get("agentID"));
    let raw_message = Value::Object(object);
    let mut warnings = WireWarnings::default();
    let canonical = canonicalize_message(raw_message, topic_id, &mut warnings)
        .with_context(|| format!("message at ordinal {ordinal} is not syncable"))?;
    let message_hash = message_fingerprint(&canonical)?;
    let canonical = canonical
        .as_object()
        .context("canonical message must be an object")?;

    let msg_id = canonical
        .get("id")
        .and_then(Value::as_str)
        .context("canonical message id is missing")?
        .to_string();
    anyhow::ensure!(
        seen_ids.insert(msg_id.clone()),
        "history contains duplicate message id {msg_id}"
    );
    let role = canonical
        .get("role")
        .and_then(Value::as_str)
        .context("canonical message role is missing")?
        .to_string();
    let content_raw = canonical
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let content_text = clean_search_text(&content_raw);
    let timestamp = canonical
        .get("timestamp")
        .and_then(Value::as_u64)
        .and_then(|value| i64::try_from(value).ok());
    let speaker_name = canonical
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or(speaker_name_fallback);
    let speaker_agent_id = if owner_type == OwnerType::Group {
        canonical
            .get("agentId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or(speaker_agent_id_fallback)
    } else {
        None
    };

    Ok(NormalizedMessage {
        msg_id,
        ordinal: ordinal as i64,
        role,
        speaker_name,
        speaker_agent_id,
        content_raw,
        content_text,
        timestamp,
        updated_at: canonical
            .get("updatedAt")
            .and_then(Value::as_i64)
            .filter(|value| (0..=9_007_199_254_740_991).contains(value)),
        message_hash,
        metadata_json,
    })
}

pub fn parse_history_path(user_data_dir: &Path, path: &Path) -> Option<(String, String)> {
    let relative = path.strip_prefix(user_data_dir).ok()?;
    let components: Vec<String> = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect();
    if components.len() == 4
        && components[1] == "topics"
        && components[3].eq_ignore_ascii_case("history.json")
    {
        Some((components[0].clone(), components[2].clone()))
    } else {
        None
    }
}

pub fn is_avatar_path(
    path: &Path,
    agents_dir: &Path,
    groups_dir: &Path,
    user_data_dir: &Path,
) -> bool {
    if path == user_data_dir.join("user_avatar.png") {
        return true;
    }
    [agents_dir, groups_dir].into_iter().any(|root| {
        let Ok(relative) = path.strip_prefix(root) else {
            return false;
        };
        let components = relative.components().collect::<Vec<_>>();
        if components.len() != 2 {
            return false;
        }
        let file_name = components[1].as_os_str().to_string_lossy();
        [
            "avatar.png",
            "avatar.jpg",
            "avatar.jpeg",
            "avatar.webp",
            "avatar.gif",
        ]
        .iter()
        .any(|candidate| file_name.eq_ignore_ascii_case(candidate))
    })
}

async fn read_stable_file(path: &Path, initial: (i64, i64)) -> Result<(Vec<u8>, i64, i64)> {
    let mut delay = Duration::from_millis(75);
    let mut before = Some(initial);
    let mut last_error = None;

    for _ in 0..6 {
        let current = match before.take() {
            Some(current) => Ok(current),
            None => source_file_version(path),
        };
        match current {
            Ok((mtime_ns, file_size)) if file_size > 0 => match fs::read(path) {
                Ok(bytes) => match source_file_version(path) {
                    Ok(after)
                        if after == (mtime_ns, file_size) && bytes.len() == file_size as usize =>
                    {
                        return Ok((bytes, mtime_ns, file_size));
                    }
                    Ok(_) => {}
                    Err(error) => last_error = Some(error),
                },
                Err(error) => last_error = Some(error),
            },
            Ok(_) => anyhow::bail!("history source is empty or not a regular file"),
            Err(error) => last_error = Some(error),
        }
        sleep(delay).await;
        delay = (delay * 2).min(Duration::from_millis(800));
    }

    if let Some(error) = last_error {
        Err(error).with_context(|| format!("failed to read stable file {}", path.display()))
    } else {
        anyhow::bail!("file did not become stable: {}", path.display())
    }
}

fn source_file_version(path: &Path) -> std::io::Result<(i64, i64)> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() {
        return Ok((0, 0));
    }
    let mtime_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(i64::MAX as u128) as i64)
        .unwrap_or(0);
    let file_size = metadata.len().min(i64::MAX as u64) as i64;
    Ok((mtime_ns, file_size))
}

fn clean_search_text(value: &str) -> String {
    static STYLE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?is)<style[^>]*>.*?</style>").expect("valid style regex"));
    static SCRIPT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?is)<script[^>]*>.*?</script>").expect("valid script regex")
    });
    static WHITESPACE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\s+").expect("valid whitespace regex"));

    let without_style = STYLE.replace_all(value, "");
    let without_script = SCRIPT.replace_all(&without_style, "");
    let escaped_text = ammonia::clean_text(&without_script);
    let clean = html_escape::decode_html_entities(&escaped_text);
    WHITESPACE.replace_all(clean.trim(), " ").to_string()
}

fn string_value(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn integer_value(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(value) => value.as_i64().or_else(|| value.as_f64().map(|v| v as i64)),
        Value::String(value) => value.parse().ok(),
        _ => None,
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn is_internal_sha256(value: Option<&str>) -> bool {
    value.is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

pub(crate) struct CommittedHistoryVersion {
    pub(crate) mtime_ns: i64,
    pub(crate) file_size: i64,
    pub(crate) source_hash: String,
}

pub(crate) fn write_history_atomic(
    path: &Path,
    bytes: &[u8],
    expected_source_hash: Option<&str>,
) -> Result<Option<CommittedHistoryVersion>> {
    let parent = path.parent().context("history path has no parent")?;
    fs::create_dir_all(parent)?;
    let temporary = temporary_path(path);
    let source_hash = sha256_hex(bytes);
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .context("failed to create unique history temporary file")?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(error).context("failed to durably write history temporary file");
    }
    drop(file);
    let metadata = match fs::metadata(&temporary) {
        Ok(metadata) => metadata,
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(error).context("failed to read committed history temporary metadata");
        }
    };

    let current_hash = match fs::read(path) {
        Ok(current) => Some(sha256_hex(&current)),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(error).context("failed to revalidate history before commit");
        }
    };
    if current_hash.as_deref() != expected_source_hash {
        let _ = fs::remove_file(&temporary);
        return Err(SnapshotStale(
            "history changed concurrently; retry the sync topic".to_string(),
        )
        .into());
    }
    if Some(source_hash.as_str()) == expected_source_hash {
        fs::remove_file(&temporary)?;
        return Ok(None);
    }

    if let Err(error) = atomic_replace(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error).context("failed to atomically replace history");
    }
    sync_parent_directory(parent)?;
    let mtime_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(i64::MAX as u128) as i64)
        .unwrap_or(0);
    Ok(Some(CommittedHistoryVersion {
        mtime_ns,
        file_size: metadata.len().min(i64::MAX as u64) as i64,
        source_hash,
    }))
}

fn temporary_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("history.json");
    path.with_file_name(format!("{name}.cds-{}.tmp", uuid::Uuid::new_v4()))
}

#[cfg(not(windows))]
fn atomic_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

#[cfg(windows)]
fn atomic_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let from = from
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let to = to
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> Result<()> {
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, fs, sync::Arc, time::UNIX_EPOCH};

    use tempfile::TempDir;

    use super::{
        normalize_history, parse_owner_config, sha256_hex, topic_timestamp_from_id, Reconciler,
    };
    use crate::{
        config::{Cli, ServiceConfig},
        domain::{OwnerType, TopicKey},
        error::ServiceError,
        identity::{IdentityResolver, OwnerResolution, OwnerSelector},
        search::{MessageSearchRequest, SearchIndex},
        storage::Database,
    };
    use serde_json::Value;

    fn fixture() -> (TempDir, Arc<ServiceConfig>, Database, Reconciler) {
        let temp = TempDir::new().expect("create temp directory");
        let app_data = temp.path().join("AppData");
        fs::create_dir_all(app_data.join("Agents")).expect("create Agents");
        fs::create_dir_all(app_data.join("AgentGroups")).expect("create AgentGroups");
        fs::create_dir_all(app_data.join("UserData")).expect("create UserData");

        let config = Arc::new(
            ServiceConfig::from_cli(Cli {
                app_data,
                host: "127.0.0.1".to_string(),
                port: 0,
                notify_enabled: false,
                tantivy_enabled: false,
                raw_event_capacity: 64,
                coalesced_path_capacity: 64,
                ingest_capacity: 16,
            })
            .expect("create config"),
        );
        let database = Database::open(&config.database_path).expect("open database");
        let reconciler = Reconciler::new(config.clone(), database.clone());
        (temp, config, database, reconciler)
    }

    fn write_owner(
        config: &ServiceConfig,
        owner_type: OwnerType,
        owner_id: &str,
        display_name: &str,
        topic_ids: &[&str],
    ) {
        let base = match owner_type {
            OwnerType::Agent => &config.agents_dir,
            OwnerType::Group => &config.groups_dir,
        };
        let directory = base.join(owner_id);
        fs::create_dir_all(&directory).expect("create owner directory");
        let topics = topic_ids
            .iter()
            .enumerate()
            .map(|(index, id)| {
                serde_json::json!({
                    "id": id,
                    "name": format!("Topic {index}"),
                    "createdAt": 1_700_000_000_000_i64 + index as i64
                })
            })
            .collect::<Vec<_>>();
        fs::write(
            directory.join("config.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "id": owner_id,
                "name": display_name,
                "topics": topics
            }))
            .expect("serialize config"),
        )
        .expect("write config");
    }

    fn write_history(
        config: &ServiceConfig,
        owner_id: &str,
        topic_id: &str,
        history: serde_json::Value,
    ) {
        let directory = config
            .user_data_dir
            .join(owner_id)
            .join("topics")
            .join(topic_id);
        fs::create_dir_all(&directory).expect("create topic directory");
        fs::write(
            directory.join("history.json"),
            serde_json::to_vec_pretty(&history).expect("serialize history"),
        )
        .expect("write history");
    }

    #[test]
    fn group_normalization_preserves_speaker_agent_identity() {
        let history = serde_json::json!([
            {
                "id": "msg_1",
                "role": "assistant",
                "name": "Nova",
                "agentId": "agent_nova",
                "content": "群聊消息",
                "timestamp": 100,
                "isGroupMessage": true
            }
        ]);
        let messages = normalize_history(
            &serde_json::to_vec(&history).expect("serialize"),
            OwnerType::Group,
            "topic_group",
        )
        .expect("normalize");
        assert_eq!(messages[0].speaker_name.as_deref(), Some("Nova"));
        assert_eq!(messages[0].speaker_agent_id.as_deref(), Some("agent_nova"));
    }

    #[test]
    fn recovery_timestamp_parses_agent_and_group_topic_ids() {
        assert_eq!(
            topic_timestamp_from_id("topic_1700000000123"),
            Some(1_700_000_000_123)
        );
        assert_eq!(
            topic_timestamp_from_id("group_topic_1700000000456"),
            Some(1_700_000_000_456)
        );
        assert_eq!(topic_timestamp_from_id("legacy-topic"), None);
        assert_eq!(topic_timestamp_from_id("topic_12_extra"), None);
    }

    #[tokio::test]
    async fn branch_topics_can_reuse_message_ids_without_collision() {
        let (_temp, config, database, reconciler) = fixture();
        write_owner(
            &config,
            OwnerType::Agent,
            "agent_nova",
            "vcp小助手Nova",
            &["topic_original", "topic_branch"],
        );
        let shared = serde_json::json!([
            {
                "id": "shared_message",
                "role": "user",
                "content": "分支前共同消息",
                "timestamp": 100
            }
        ]);
        write_history(&config, "agent_nova", "topic_original", shared.clone());
        write_history(&config, "agent_nova", "topic_branch", shared);

        reconciler.reconcile().await.expect("reconcile");
        let original = database
            .active_messages_for_topic(&TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent_nova".to_string(),
                topic_id: "topic_original".to_string(),
            })
            .expect("load original");
        let branch = database
            .active_messages_for_topic(&TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent_nova".to_string(),
                topic_id: "topic_branch".to_string(),
            })
            .expect("load branch");

        assert_eq!(original.len(), 1);
        assert_eq!(branch.len(), 1);
        assert_eq!(original[0].msg_id, "shared_message");
        assert_eq!(branch[0].msg_id, "shared_message");
        assert_ne!(original[0].row_id, branch[0].row_id);
    }

    #[tokio::test]
    async fn reconcile_removes_tombstoned_messages_reintroduced_into_physical_history() {
        let (_temp, config, database, reconciler) = fixture();
        let owner_id = "agent_tombstone_repair";
        let topic_id = "topic_tombstone_repair";
        let deleted_message = serde_json::json!({
            "id": "message_deleted",
            "role": "user",
            "content": "stale",
            "timestamp": 1
        });
        let live_message = serde_json::json!({
            "id": "message_live",
            "role": "assistant",
            "content": "keep",
            "timestamp": 2
        });
        write_owner(
            &config,
            OwnerType::Agent,
            owner_id,
            "Repair Agent",
            &[topic_id],
        );
        write_history(
            &config,
            owner_id,
            topic_id,
            serde_json::json!([deleted_message.clone(), live_message.clone()]),
        );
        reconciler.reconcile().await.expect("index initial history");

        write_history(
            &config,
            owner_id,
            topic_id,
            serde_json::json!([live_message.clone()]),
        );
        reconciler
            .reconcile()
            .await
            .expect("persist message tombstone");

        write_history(
            &config,
            owner_id,
            topic_id,
            serde_json::json!([deleted_message, live_message]),
        );
        reconciler
            .reconcile()
            .await
            .expect("repair stale physical message");

        let history_path = config
            .user_data_dir
            .join(owner_id)
            .join("topics")
            .join(topic_id)
            .join("history.json");
        let history: Vec<Value> =
            serde_json::from_slice(&fs::read(history_path).expect("read repaired history"))
                .expect("parse repaired history");
        assert_eq!(
            history
                .iter()
                .filter_map(|message| message.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            vec!["message_live"],
        );
        assert!(database
            .message_tombstone_ids(&TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: owner_id.to_string(),
                topic_id: topic_id.to_string(),
            })
            .expect("load message tombstones")
            .contains("message_deleted"));
    }

    #[tokio::test]
    async fn config_hash_transition_and_content_changes_keep_clock_semantics() {
        let (_temp, config, database, reconciler) = fixture();
        write_owner(
            &config,
            OwnerType::Agent,
            "agent_stable",
            "Stable Agent",
            &["topic_stable"],
        );
        write_history(
            &config,
            "agent_stable",
            "topic_stable",
            serde_json::json!([
                {"id":"message_stable","role":"user","content":"stable","timestamp":1}
            ]),
        );
        reconciler.reconcile().await.expect("initial reconcile");

        let config_path = config.agents_dir.join("agent_stable/config.json");
        let legacy_raw_hash = sha256_hex(&fs::read(&config_path).expect("read config"));
        {
            let connection = database.connection.lock();
            connection
                .execute(
                    "UPDATE owners SET config_hash=?1, updated_at=123
                     WHERE owner_type='agent' AND owner_id='agent_stable'",
                    [&legacy_raw_hash],
                )
                .expect("set owner timestamp sentinel");
            connection
                .execute(
                    "UPDATE topics SET config_hash=?1, updated_at=456
                     WHERE owner_type='agent' AND owner_id='agent_stable'
                       AND topic_id='topic_stable'",
                    [&legacy_raw_hash],
                )
                .expect("set topic timestamp sentinel");
        }

        let stats = reconciler
            .reconcile()
            .await
            .expect("legacy hash transition");
        assert_eq!(stats.files_ingested, 0);
        assert_eq!(stats.files_skipped, 1);
        let parsed = parse_owner_config(OwnerType::Agent, "agent_stable".to_string(), &config_path)
            .expect("parse canonical hashes");
        let (owner_hash, topic_hash, owner_updated_at, topic_updated_at) = {
            let connection = database.connection.lock();
            let owner = connection
                .query_row(
                    "SELECT config_hash, updated_at FROM owners
                     WHERE owner_type='agent' AND owner_id='agent_stable'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .expect("read owner state");
            let topic = connection
                .query_row(
                    "SELECT config_hash, updated_at FROM topics
                     WHERE owner_type='agent' AND owner_id='agent_stable'
                       AND topic_id='topic_stable'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .expect("read topic state");
            (owner.0, topic.0, owner.1, topic.1)
        };
        assert_eq!(owner_hash, parsed.config_hash);
        assert_eq!(topic_hash, parsed.topics[0].config_hash);
        assert_eq!(owner_updated_at, 123);
        assert_eq!(topic_updated_at, 456);

        let mut physical: Value = serde_json::from_slice(
            &fs::read(&config_path).expect("read config before private update"),
        )
        .expect("parse config before private update");
        physical["current_topic_id"] = Value::String("topic_stable".to_string());
        physical["topics"][0]["unreadSource"] = Value::String("manual".to_string());
        fs::write(
            &config_path,
            serde_json::to_vec_pretty(&physical).expect("serialize private update"),
        )
        .expect("write private update");
        reconciler
            .reconcile()
            .await
            .expect("private-only reconcile");
        {
            let connection = database.connection.lock();
            let state: (i64, i64, String) = connection
                .query_row(
                    "SELECT o.updated_at, t.updated_at, t.metadata_json FROM owners o JOIN topics t
                       ON t.owner_type=o.owner_type AND t.owner_id=o.owner_id
                     WHERE o.owner_type='agent' AND o.owner_id='agent_stable'
                       AND t.topic_id='topic_stable'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("read private-only state");
            assert_eq!((state.0, state.1), (123, 456));
            assert_eq!(
                serde_json::from_str::<Value>(&state.2).expect("parse stored metadata")
                    ["unreadSource"],
                "manual"
            );
        }

        physical["topics"][0]["unread"] = Value::Bool(true);
        fs::write(
            &config_path,
            serde_json::to_vec_pretty(&physical).expect("serialize topic update"),
        )
        .expect("write topic update");
        reconciler.reconcile().await.expect("topic DTO reconcile");
        let (owner_after_topic, topic_after_dto): (i64, i64) = {
            let connection = database.connection.lock();
            connection
                .query_row(
                    "SELECT o.updated_at, t.updated_at FROM owners o JOIN topics t
                       ON t.owner_type=o.owner_type AND t.owner_id=o.owner_id
                     WHERE o.owner_type='agent' AND o.owner_id='agent_stable'
                       AND t.topic_id='topic_stable'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("read topic DTO times")
        };
        assert_eq!(owner_after_topic, 123);
        assert!(topic_after_dto > 456);

        let revision_before: i64 = {
            let connection = database.connection.lock();
            connection
                .execute(
                    "UPDATE topics SET updated_at=789
                     WHERE owner_type='agent' AND owner_id='agent_stable'
                       AND topic_id='topic_stable'",
                    [],
                )
                .expect("set content-path timestamp sentinel");
            connection
                .query_row(
                    "SELECT content_revision FROM topics
                     WHERE owner_type='agent' AND owner_id='agent_stable'
                       AND topic_id='topic_stable'",
                    [],
                    |row| row.get(0),
                )
                .expect("read content revision")
        };
        write_history(
            &config,
            "agent_stable",
            "topic_stable",
            serde_json::json!([
                {"id":"message_stable","role":"user","content":"changed","timestamp":1}
            ]),
        );
        reconciler.reconcile().await.expect("content reconcile");
        let (content_time, revision_after): (i64, i64) = {
            let connection = database.connection.lock();
            connection
                .query_row(
                    "SELECT updated_at, content_revision FROM topics
                     WHERE owner_type='agent' AND owner_id='agent_stable'
                       AND topic_id='topic_stable'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("read content state")
        };
        assert_eq!(content_time, 789);
        assert!(revision_after > revision_before);

        write_history(
            &config,
            "agent_stable",
            "topic_stable",
            serde_json::json!([
                {
                    "id":"message_stable",
                    "role":"user",
                    "content":"changed",
                    "timestamp":1,
                    "updatedAt":999
                }
            ]),
        );
        reconciler
            .reconcile()
            .await
            .expect("sync-only message reconcile");
        let (revision_after_sync_only, message_updated_at): (i64, i64) = database
            .connection
            .lock()
            .query_row(
                "SELECT t.content_revision, m.updated_at
                 FROM topics t JOIN messages m
                   ON m.owner_type=t.owner_type AND m.owner_id=t.owner_id
                  AND m.topic_id=t.topic_id
                 WHERE t.owner_type='agent' AND t.owner_id='agent_stable'
                   AND t.topic_id='topic_stable' AND m.msg_id='message_stable'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read sync-only message state");
        assert_eq!(revision_after_sync_only, revision_after);
        assert_eq!(message_updated_at, 999);
    }

    #[tokio::test]
    async fn ready_source_without_a_valid_hash_is_reingested_and_repaired() {
        let (_temp, config, database, reconciler) = fixture();
        let owner_id = "agent_ready_repair";
        let topic_id = "topic_ready_repair";
        write_owner(
            &config,
            OwnerType::Agent,
            owner_id,
            "Ready Repair",
            &[topic_id],
        );
        write_history(
            &config,
            owner_id,
            topic_id,
            serde_json::json!([
                {"id":"message_ready","role":"user","content":"stable","timestamp":1}
            ]),
        );
        reconciler.reconcile().await.expect("initial reconcile");

        let history_path = config
            .user_data_dir
            .join(owner_id)
            .join("topics")
            .join(topic_id)
            .join("history.json");
        database
            .connection
            .lock()
            .execute(
                "UPDATE history_sources SET source_hash=NULL WHERE source_path=?1",
                [history_path.to_string_lossy().as_ref()],
            )
            .expect("clear committed source hash");

        let stats = reconciler.reconcile().await.expect("repair ready source");
        assert_eq!(stats.files_ingested, 1);
        assert_eq!(stats.files_skipped, 0);
        let repaired: (String, String, Option<String>) = database
            .connection
            .lock()
            .query_row(
                "SELECT source_hash, status, last_error
                 FROM history_sources WHERE source_path=?1",
                [history_path.to_string_lossy().as_ref()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read repaired source state");
        assert_eq!(
            repaired.0,
            sha256_hex(&fs::read(history_path).expect("read repaired history"))
        );
        assert_eq!(repaired.1, "ready");
        assert_eq!(repaired.2, None);
    }

    #[tokio::test]
    async fn empty_history_is_ready_and_keeps_the_metadata_fast_path() {
        let (_temp, config, database, reconciler) = fixture();
        let owner_id = "agent_empty_history";
        let topic_id = "topic_empty_history";
        write_owner(
            &config,
            OwnerType::Agent,
            owner_id,
            "Empty History",
            &[topic_id],
        );
        write_history(&config, owner_id, topic_id, serde_json::json!([]));

        let initial = reconciler.reconcile().await.expect("ingest empty history");
        assert_eq!(initial.files_ingested, 1);
        assert_eq!(database.stats().expect("empty history stats").messages, 0);
        let unchanged = reconciler
            .reconcile()
            .await
            .expect("reconcile unchanged empty history");
        assert_eq!(unchanged.files_ingested, 0);
        assert_eq!(unchanged.files_skipped, 1);
    }

    #[tokio::test]
    async fn config_deletion_preserves_tombstone_and_ignores_config_only_topic() {
        let (_temp, config, database, reconciler) = fixture();
        write_owner(
            &config,
            OwnerType::Agent,
            "agent_stale_topic",
            "Stale Topic Agent",
            &["topic_deleted", "topic_never_physical"],
        );
        write_history(
            &config,
            "agent_stale_topic",
            "topic_deleted",
            serde_json::json!([
                {"id":"message_deleted","role":"user","content":"delete me","timestamp":1}
            ]),
        );
        let initial = reconciler.reconcile().await.expect("initial reconcile");
        assert_eq!(initial.topics_seen, 1);

        let key = TopicKey {
            owner_type: OwnerType::Agent,
            owner_id: "agent_stale_topic".to_string(),
            topic_id: "topic_deleted".to_string(),
        };
        database
            .apply_sync_topic_tombstone(&key, 321)
            .expect("apply explicit topic tombstone");
        let topic_directory = config
            .user_data_dir
            .join("agent_stale_topic/topics/topic_deleted");
        let stale_history_path = topic_directory.join("history.json");
        fs::remove_dir_all(&topic_directory).expect("delete physical topic directory");
        write_owner(
            &config,
            OwnerType::Agent,
            "agent_stale_topic",
            "Stale Topic Agent",
            &["topic_never_physical"],
        );

        assert!(reconciler
            .ingest_path(&stale_history_path, "notify")
            .await
            .expect("ignore missing physical history")
            .is_none());
        let stats = reconciler
            .reconcile()
            .await
            .expect("reconcile stale config");
        assert_eq!(stats.topics_seen, 0);
        assert!(database
            .active_messages_for_topic(&key)
            .expect("load messages after reconcile")
            .is_empty());

        let connection = database.connection.lock();
        let topic_deleted_at = connection
            .query_row(
                "SELECT deleted_at FROM topics
                 WHERE owner_type='agent' AND owner_id='agent_stale_topic'
                   AND topic_id='topic_deleted'",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )
            .expect("load topic tombstone");
        let message_deleted_at = connection
            .query_row(
                "SELECT deleted_at FROM messages
                 WHERE owner_type='agent' AND owner_id='agent_stale_topic'
                   AND topic_id='topic_deleted' AND msg_id='message_deleted'",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )
            .expect("load message tombstone");
        let config_only_topics: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM topics
                 WHERE owner_type='agent' AND owner_id='agent_stale_topic'
                   AND topic_id='topic_never_physical'",
                [],
                |row| row.get(0),
            )
            .expect("count config-only topic");
        assert_eq!(topic_deleted_at, Some(321));
        assert_eq!(message_deleted_at, Some(321));
        assert_eq!(config_only_topics, 0);
    }

    #[tokio::test]
    async fn physical_topic_missing_from_valid_config_is_recovered() {
        let (_temp, config, database, reconciler) = fixture();
        write_owner(
            &config,
            OwnerType::Agent,
            "agent_orphan_topic",
            "Orphan Topic Agent",
            &[],
        );
        write_history(
            &config,
            "agent_orphan_topic",
            "topic_orphan",
            serde_json::json!([
                {"id":"message_orphan","role":"user","content":"physical truth","timestamp":1}
            ]),
        );

        let stats = reconciler.reconcile().await.expect("reconcile");
        assert_eq!(stats.topics_seen, 1);
        assert_eq!(stats.files_ingested, 1);
        assert_eq!(stats.messages_ingested, 1);
        let key = TopicKey {
            owner_type: OwnerType::Agent,
            owner_id: "agent_orphan_topic".to_string(),
            topic_id: "topic_orphan".to_string(),
        };
        assert_eq!(
            database
                .active_messages_for_topic(&key)
                .expect("load orphan messages")
                .len(),
            1
        );
        let indexed: i64 = database
            .connection
            .lock()
            .query_row(
                "SELECT COUNT(*) FROM topics
                 WHERE owner_type='agent' AND owner_id='agent_orphan_topic'
                   AND topic_id='topic_orphan' AND deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count orphan topic");
        assert_eq!(indexed, 1);
    }

    #[tokio::test]
    async fn recovered_topics_use_id_or_history_mtime_and_precede_configured_topics() {
        let (_temp, config, database, reconciler) = fixture();
        let owner_id = "agent_recovery_time";
        let existing_id = "topic_1700000000999";
        let already_recovered_id = "topic_1700000000789";
        let timestamp_id = "topic_1700000000123";
        let legacy_id = "legacy-topic";
        write_owner(
            &config,
            OwnerType::Agent,
            owner_id,
            "Recovery Time Agent",
            &[existing_id, already_recovered_id],
        );
        let owner_config = config.agents_dir.join(owner_id).join("config.json");
        let mut root: Value =
            serde_json::from_slice(&fs::read(&owner_config).expect("read recovery owner config"))
                .expect("parse recovery owner config");
        root["topics"][1]["name"] = Value::String(format!("Recovered: {already_recovered_id}"));
        root["topics"][1]["createdAt"] = Value::Number(0.into());
        fs::write(
            &owner_config,
            serde_json::to_vec_pretty(&root).expect("serialize recovery owner config"),
        )
        .expect("rewrite recovery owner config");

        write_history(&config, owner_id, existing_id, serde_json::json!([]));
        let write_empty_history = |topic_id: &str| {
            let directory = config
                .user_data_dir
                .join(owner_id)
                .join("topics")
                .join(topic_id);
            fs::create_dir_all(&directory).expect("create recovered topic directory");
            let history_path = directory.join("history.json");
            fs::write(&history_path, []).expect("write empty recovered history");
            history_path
        };
        write_empty_history(already_recovered_id);
        write_empty_history(timestamp_id);
        let legacy_history = write_empty_history(legacy_id);
        let legacy_mtime = fs::metadata(&legacy_history)
            .expect("read legacy history metadata")
            .modified()
            .expect("read legacy history mtime")
            .duration_since(UNIX_EPOCH)
            .expect("legacy history mtime after epoch")
            .as_millis()
            .min(i64::MAX as u128) as i64;

        let stats = reconciler
            .reconcile()
            .await
            .expect("reconcile recovered topics");
        assert_eq!(stats.topics_seen, 4);
        assert_eq!(stats.files_invalid, 3);

        let connection = database.connection.lock();
        let rows = connection
            .prepare(
                "SELECT topic_id, created_at, topic_ordinal FROM topics
                 WHERE owner_type='agent' AND owner_id=?1 AND deleted_at IS NULL
                 ORDER BY topic_ordinal ASC",
            )
            .expect("prepare recovered topic query")
            .query_map([owner_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .expect("query recovered topics")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect recovered topics");
        assert_eq!(
            rows.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(),
            vec![already_recovered_id, legacy_id, timestamp_id, existing_id]
        );
        let by_id = rows
            .iter()
            .map(|(topic_id, created_at, ordinal)| (topic_id.as_str(), (*created_at, *ordinal)))
            .collect::<HashMap<_, _>>();
        assert_eq!(by_id[already_recovered_id].0, Some(1_700_000_000_789));
        assert_eq!(by_id[timestamp_id].0, Some(1_700_000_000_123));
        assert_eq!(by_id[legacy_id].0, Some(legacy_mtime));
    }

    #[tokio::test]
    async fn missing_or_invalid_owner_config_keeps_physical_history_live() {
        let (_temp, config, database, reconciler) = fixture();
        write_owner(
            &config,
            OwnerType::Agent,
            "agent_recovery",
            "Recovery Agent",
            &["topic_recovery"],
        );
        write_history(
            &config,
            "agent_recovery",
            "topic_recovery",
            serde_json::json!([
                {"id":"message_recovery","role":"user","content":"must stay live","timestamp":1}
            ]),
        );
        reconciler.reconcile().await.expect("initial reconcile");

        let owner_config = config.agents_dir.join("agent_recovery/config.json");
        fs::remove_file(&owner_config).expect("remove owner config");
        let missing = reconciler
            .reconcile()
            .await
            .expect("reconcile missing owner config");
        assert_eq!(missing.owners_deleted, 0);
        assert_eq!(missing.topics_seen, 1);
        assert_eq!(missing.files_skipped, 1);

        fs::write(&owner_config, br#"{"name":"broken""#).expect("write invalid owner config");
        let invalid = reconciler
            .reconcile()
            .await
            .expect("reconcile invalid owner config");
        assert_eq!(invalid.owners_deleted, 0);
        assert_eq!(invalid.topics_seen, 1);
        assert_eq!(invalid.files_skipped, 1);

        let key = TopicKey {
            owner_type: OwnerType::Agent,
            owner_id: "agent_recovery".to_string(),
            topic_id: "topic_recovery".to_string(),
        };
        let messages = database
            .active_messages_for_topic(&key)
            .expect("load messages after recovery reconciles");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content_text, "must stay live");
        assert_eq!(
            database
                .owner_by_id(OwnerType::Agent, "agent_recovery")
                .expect("load recovered owner")
                .expect("owner remains live")
                .1,
            "Recovery Agent"
        );

        let connection = database.connection.lock();
        let deleted_state = connection
            .query_row(
                "SELECT o.deleted_at, t.deleted_at, m.deleted_at
                 FROM owners o
                 JOIN topics t ON t.owner_type=o.owner_type AND t.owner_id=o.owner_id
                 JOIN messages m ON m.owner_type=t.owner_type AND m.owner_id=t.owner_id
                                AND m.topic_id=t.topic_id
                 WHERE o.owner_type='agent' AND o.owner_id='agent_recovery'
                   AND t.topic_id='topic_recovery' AND m.msg_id='message_recovery'",
                [],
                |row| {
                    Ok((
                        row.get::<_, Option<i64>>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .expect("load recovered deletion state");
        assert_eq!(deleted_state, (None, None, None));
    }

    #[tokio::test]
    async fn missing_or_invalid_config_without_physical_topics_is_not_recovered() {
        let (_temp, config, database, reconciler) = fixture();
        fs::create_dir_all(config.agents_dir.join("agent_missing"))
            .expect("create missing-config owner directory");
        let invalid_owner = config.groups_dir.join("group_invalid");
        fs::create_dir_all(&invalid_owner).expect("create invalid-config owner directory");
        fs::write(invalid_owner.join("config.json"), br#"{"name":"broken""#)
            .expect("write invalid config");

        let stats = reconciler
            .reconcile()
            .await
            .expect("reconcile empty owners");
        assert_eq!(stats.owners_seen, 0);
        assert_eq!(stats.owners_deleted, 0);

        let connection = database.connection.lock();
        let owners: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM owners
                 WHERE owner_id IN ('agent_missing', 'group_invalid')",
                [],
                |row| row.get(0),
            )
            .expect("count ghost owners");
        assert_eq!(owners, 0);
    }

    #[tokio::test]
    async fn legacy_maid_uses_unique_contains_but_rejects_ambiguity() {
        let (_temp, config, database, reconciler) = fixture();
        write_owner(
            &config,
            OwnerType::Agent,
            "agent_nova",
            "vcp小助手Nova",
            &["topic_1"],
        );
        reconciler.reconcile().await.expect("reconcile");

        let resolver = IdentityResolver::new(database.clone());
        let resolved = resolver
            .resolve(&OwnerSelector {
                owner_type: OwnerType::Agent,
                owner_id: None,
                owner_name: None,
                maid: Some("Nova".to_string()),
            })
            .expect("resolve unique contains");
        assert_eq!(resolved.owner_id, "agent_nova");
        assert_eq!(resolved.resolution, OwnerResolution::UniqueContains);

        write_owner(
            &config,
            OwnerType::Agent,
            "agent_nova_alt",
            "Nova助手",
            &["topic_2"],
        );
        reconciler
            .reconcile()
            .await
            .expect("reconcile second owner");
        let error = resolver
            .resolve(&OwnerSelector {
                owner_type: OwnerType::Agent,
                owner_id: None,
                owner_name: None,
                maid: Some("Nova".to_string()),
            })
            .expect_err("ambiguous contains must fail");
        assert!(matches!(error, ServiceError::Ambiguous(_)));
    }

    #[tokio::test]
    async fn invalid_history_preserves_last_valid_messages() {
        let (_temp, config, database, reconciler) = fixture();
        write_owner(
            &config,
            OwnerType::Agent,
            "agent_invalid_history",
            "Invalid History",
            &["topic_1"],
        );
        write_history(
            &config,
            "agent_invalid_history",
            "topic_1",
            serde_json::json!([
                {
                    "id": "msg_1",
                    "role": "user",
                    "content": "last valid content",
                    "timestamp": 1
                }
            ]),
        );
        reconciler.reconcile().await.expect("initial reconcile");
        let before = database.stats().expect("stats before invalid source");

        let history_path = config
            .user_data_dir
            .join("agent_invalid_history/topics/topic_1/history.json");
        fs::write(&history_path, br#"[{"id":"msg_1","content":"partial"#)
            .expect("write incomplete JSON");
        let result = reconciler.reconcile().await.expect("invalid reconcile");

        assert_eq!(result.files_invalid, 1);
        let after = database.stats().expect("stats after invalid source");
        assert_eq!(after.messages, 1);
        assert_eq!(after.content_revision, before.content_revision);
        let messages = database
            .active_messages_for_topic(&TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent_invalid_history".to_string(),
                topic_id: "topic_1".to_string(),
            })
            .expect("load preserved messages");
        assert_eq!(messages[0].content_text, "last valid content");
        assert_eq!(
            database
                .source_metadata(&history_path)
                .expect("load source metadata")
                .expect("source exists")
                .status,
            "invalid"
        );
    }

    #[tokio::test]
    async fn missing_history_preserves_tantivy_and_revisions_converge() {
        let (_temp, config, database, reconciler) = fixture();
        write_owner(
            &config,
            OwnerType::Agent,
            "agent_search_delete",
            "Search Delete",
            &["topic_1"],
        );
        write_history(
            &config,
            "agent_search_delete",
            "topic_1",
            serde_json::json!([
                {
                    "id": "msg_1",
                    "role": "user",
                    "content": "独特删除检索词",
                    "timestamp": 1
                }
            ]),
        );
        reconciler.reconcile().await.expect("initial reconcile");

        let index = SearchIndex::open(&config.index_dir, database.clone()).expect("open index");
        index
            .reconcile_revisions()
            .expect("build initial search index");
        let request = MessageSearchRequest {
            query: "独特删除检索词".to_string(),
            owner_type: OwnerType::Agent,
            owner_id: "agent_search_delete".to_string(),
            topic_id: None,
            exclude_topic_id: None,
            limit: 10,
        };
        assert_eq!(
            index
                .search_messages(&request)
                .expect("search before delete")
                .len(),
            1
        );

        fs::remove_file(
            config
                .user_data_dir
                .join("agent_search_delete/topics/topic_1/history.json"),
        )
        .expect("delete history");
        let missing = reconciler.reconcile().await.expect("missing reconcile");
        assert_eq!(missing.files_invalid, 1);
        assert_eq!(
            index
                .reconcile_revisions()
                .expect("reconcile missing search topic"),
            0
        );
        assert_eq!(
            index
                .search_messages(&request)
                .expect("search after source loss")
                .len(),
            1
        );

        let stats = database.stats().expect("revision stats");
        assert_eq!(stats.content_revision, stats.indexed_revision);
    }

    #[tokio::test]
    async fn missing_history_keeps_messages_and_marks_source_unhealthy() {
        let (_temp, config, database, reconciler) = fixture();
        write_owner(
            &config,
            OwnerType::Agent,
            "agent_delete_history",
            "Delete History",
            &["topic_1"],
        );
        write_history(
            &config,
            "agent_delete_history",
            "topic_1",
            serde_json::json!([
                {
                    "id": "msg_1",
                    "role": "user",
                    "content": "will be removed",
                    "timestamp": 1
                },
                {
                    "id": "msg_2",
                    "role": "assistant",
                    "content": "will also be removed",
                    "timestamp": 2
                }
            ]),
        );

        reconciler.reconcile().await.expect("initial reconcile");
        let before = database.stats().expect("stats before deletion");
        assert_eq!(before.owners, 1);
        assert_eq!(before.topics, 1);
        assert_eq!(before.messages, 2);

        fs::remove_file(
            config
                .user_data_dir
                .join("agent_delete_history/topics/topic_1/history.json"),
        )
        .expect("delete history");
        let result = reconciler.reconcile().await.expect("deletion reconcile");

        assert_eq!(result.files_invalid, 1);
        assert_eq!(result.files_deleted, 0);
        assert_eq!(result.messages_deleted, 0);
        let after = database.stats().expect("stats after deletion");
        assert_eq!(after.owners, 1);
        assert_eq!(after.topics, 1);
        assert_eq!(after.messages, 2);
        assert_eq!(after.content_revision, before.content_revision);
        assert_eq!(
            database
                .source_metadata(
                    &config
                        .user_data_dir
                        .join("agent_delete_history/topics/topic_1/history.json"),
                )
                .expect("load missing source state")
                .expect("missing source remains indexed")
                .status,
            "missing"
        );
    }

    #[tokio::test]
    async fn deleting_owner_config_soft_deletes_its_namespace() {
        let (_temp, config, database, reconciler) = fixture();
        write_owner(
            &config,
            OwnerType::Agent,
            "agent_deleted",
            "Deleted Agent",
            &["topic_1"],
        );
        write_history(
            &config,
            "agent_deleted",
            "topic_1",
            serde_json::json!([
                {
                    "id": "msg_1",
                    "role": "user",
                    "content": "owner will be removed"
                }
            ]),
        );
        reconciler.reconcile().await.expect("initial reconcile");

        fs::remove_dir_all(config.agents_dir.join("agent_deleted"))
            .expect("delete owner config directory");
        let result = reconciler
            .reconcile()
            .await
            .expect("owner deletion reconcile");

        assert_eq!(result.owners_deleted, 1);
        let stats = database.stats().expect("stats after owner deletion");
        assert_eq!(stats.owners, 0);
        assert_eq!(stats.topics, 0);
        assert_eq!(stats.messages, 0);
        assert!(database
            .owner_by_id(OwnerType::Agent, "agent_deleted")
            .expect("query deleted owner")
            .is_none());
    }
}
