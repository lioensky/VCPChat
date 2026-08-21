use std::{
    collections::{HashMap, HashSet},
    fs,
    io::ErrorKind,
    path::Path,
    sync::Arc,
    time::{Duration, UNIX_EPOCH},
};

use crate::{
    config::ServiceConfig,
    domain::{
        NormalizedAttachment, NormalizedMessage, OwnerKey, OwnerRecord, OwnerType, TopicDefinition,
        TopicKey, TopicSource,
    },
    storage::{now_ms, Database, IngestCommit},
};
use anyhow::{Context, Result};
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tokio::time::sleep;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileStats {
    pub owners_seen: usize,
    pub owners_deleted: usize,
    pub topics_seen: usize,
    pub files_checked: usize,
    pub files_skipped: usize,
    pub files_ingested: usize,
    pub files_deleted: usize,
    pub files_invalid: usize,
    pub messages_ingested: usize,
    pub messages_deleted: usize,
    pub duplicate_owner_ids: usize,
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
        let (owners, duplicate_owner_ids) = self.scan_owner_registry()?;
        let mut stats = ReconcileStats {
            owners_seen: owners.len(),
            duplicate_owner_ids,
            ..Default::default()
        };

        for configured_owner in owners.values() {
            let owner = self.effective_owner(configured_owner)?;
            self.database.upsert_owner(&owner)?;
            for topic in &owner.topics {
                stats.topics_seen += 1;
                let source = self.topic_source(&owner, topic);
                self.database.upsert_topic_source(&source)?;
                stats.files_checked += 1;

                match self.ingest_source_if_changed(&source, "reconcile").await {
                    Ok(Some(commit)) => {
                        stats.files_ingested += usize::from(commit.changed);
                        stats.files_skipped += usize::from(!commit.changed);
                        stats.messages_ingested += commit.message_count;
                    }
                    Ok(None) => {
                        // A physical topic directory (or configured default) with no prior
                        // valid source is a legitimate empty topic. Only a previously
                        // ingested source can become missing.
                        if let Some(commit) = self
                            .database
                            .mark_history_source_missing(&source, "reconcile")?
                        {
                            stats.files_deleted += 1;
                            stats.messages_deleted += commit.removed_row_ids.len();
                        } else {
                            stats.files_skipped += 1;
                        }
                    }
                    Err(error) => {
                        stats.files_invalid += 1;
                        self.database
                            .mark_source_invalid(&source, &format!("{error:#}"))?;
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
        }

        let active_owner_keys = owners.keys().cloned().collect::<HashSet<_>>();
        stats.owners_deleted = self
            .database
            .reconcile_missing_owners(&active_owner_keys, "reconcile")?;

        self.database.set_last_reconcile_at(now_ms())?;
        stats.duration_ms = now_ms() - started;
        Ok(stats)
    }

    pub async fn ingest_path(&self, path: &Path, origin: &str) -> Result<Option<IngestCommit>> {
        let Some((owner_id, topic_id)) = parse_history_path(&self.config.user_data_dir, path)
        else {
            return Ok(None);
        };
        if !path.is_file() {
            return Ok(None);
        }

        let registry = self.scan_owner_registry()?.0;
        let matching: Vec<&OwnerRecord> = registry
            .values()
            .filter(|owner| owner.key.owner_id == owner_id)
            .collect();

        let configured_owner = match matching.as_slice() {
            [owner] => *owner,
            [] => anyhow::bail!("history owner {owner_id} has no Agent or Group config"),
            _ => anyhow::bail!("history owner {owner_id} is ambiguous between Agent and Group"),
        };
        let owner = self.effective_owner(configured_owner)?;

        let topic = owner
            .topics
            .iter()
            .find(|topic| topic.topic_id == topic_id)
            .cloned()
            .with_context(|| {
                format!("physical history topic {topic_id} disappeared while preparing ingestion")
            })?;
        let source = self.topic_source(&owner, &topic);
        self.database.upsert_owner(&owner)?;
        self.database.upsert_topic_source(&source)?;
        self.ingest_source_if_changed(&source, origin).await
    }

    fn effective_owner(&self, configured_owner: &OwnerRecord) -> Result<OwnerRecord> {
        let physical_topic_ids = self.physical_topic_ids(&configured_owner.key.owner_id)?;

        let physical_topic_id_set = physical_topic_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let configured_topic_ids = configured_owner
            .topics
            .iter()
            .map(|topic| topic.topic_id.as_str())
            .collect::<HashSet<_>>();
        let mut topics = configured_owner
            .topics
            .iter()
            .filter(|topic| {
                topic.topic_id == "default"
                    || physical_topic_id_set.contains(topic.topic_id.as_str())
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut next_ordinal = configured_owner
            .topics
            .iter()
            .map(|topic| topic.ordinal)
            .max()
            .unwrap_or(-1)
            + 1;

        for topic_id in physical_topic_ids {
            if configured_topic_ids.contains(topic_id.as_str()) {
                continue;
            }
            topics.push(TopicDefinition {
                topic_id,
                display_name: None,
                created_at: None,
                ordinal: next_ordinal,
                metadata: serde_json::json!({
                    "orphanHistory": true,
                    "compatibilityStatus": "history_not_listed_in_config"
                }),
            });
            next_ordinal += 1;
        }

        let mut effective = configured_owner.clone();
        effective.topics = topics;
        Ok(effective)
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

    pub fn scan_owner_registry(&self) -> Result<(HashMap<OwnerKey, OwnerRecord>, usize)> {
        let mut owners = HashMap::new();
        self.scan_owner_directory(OwnerType::Agent, &self.config.agents_dir, &mut owners)?;
        self.scan_owner_directory(OwnerType::Group, &self.config.groups_dir, &mut owners)?;

        let agent_ids: HashSet<&str> = owners
            .keys()
            .filter(|key| key.owner_type == OwnerType::Agent)
            .map(|key| key.owner_id.as_str())
            .collect();
        let duplicate_owner_ids = owners
            .keys()
            .filter(|key| {
                key.owner_type == OwnerType::Group && agent_ids.contains(key.owner_id.as_str())
            })
            .count();

        Ok((owners, duplicate_owner_ids))
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
        Ok(Some(OwnerRecord {
            key: OwnerKey {
                owner_type,
                owner_id,
            },
            display_name,
            config_path: config_path.into(),
            config_hash: "physical-owner-recovery".to_string(),
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
            display_name: topic.display_name.clone(),
            created_at: topic.created_at,
            topic_ordinal: topic.ordinal,
            source_path: self
                .config
                .user_data_dir
                .join(&owner.key.owner_id)
                .join("topics")
                .join(&topic.topic_id)
                .join("history.json"),
            config_hash: owner.config_hash.clone(),
            topic_metadata: topic.metadata.clone(),
        }
    }

    async fn ingest_source_if_changed(
        &self,
        source: &TopicSource,
        origin: &str,
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
            if previous.mtime_ns == mtime_ns
                && previous.file_size == file_size
                && previous.status == "ready"
            {
                return Ok(Some(IngestCommit {
                    topic: source.key.clone(),
                    revision: self.database.topic_revision(&source.key)?.unwrap_or(0),
                    changed: false,
                    removed_row_ids: Vec::new(),
                    message_count: 0,
                }));
            }
        }

        let bytes = read_stable_file(&source.source_path).await?;
        let content_hash = sha256_hex(&bytes);
        let messages = normalize_history(&bytes, source.key.owner_type)?;

        self.database
            .ingest_topic(
                source,
                &messages,
                mtime_ns,
                file_size,
                &content_hash,
                origin,
            )
            .map(Some)
    }
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
                    Some(TopicDefinition {
                        topic_id,
                        display_name: string_value(topic.get("name")),
                        created_at: integer_value(topic.get("createdAt")),
                        ordinal: ordinal as i64,
                        metadata: value.clone(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(OwnerRecord {
        key: OwnerKey {
            owner_type,
            owner_id,
        },
        display_name,
        config_path: config_path.to_path_buf(),
        config_hash: sha256_hex(&bytes),
        topics,
    })
}

pub fn normalize_history(bytes: &[u8], owner_type: OwnerType) -> Result<Vec<NormalizedMessage>> {
    let root: Value = serde_json::from_slice(bytes).context("history is not valid JSON")?;
    let history = root.as_array().context("history root must be an array")?;
    let mut seen_ids = HashMap::<String, usize>::new();

    history
        .iter()
        .enumerate()
        .map(|(ordinal, value)| {
            let object = value
                .as_object()
                .with_context(|| format!("message at ordinal {ordinal} must be an object"))?;
            normalize_message(object, ordinal, owner_type, &mut seen_ids)
        })
        .collect()
}

fn normalize_message(
    object: &Map<String, Value>,
    ordinal: usize,
    owner_type: OwnerType,
    seen_ids: &mut HashMap<String, usize>,
) -> Result<NormalizedMessage> {
    let content_value = object.get("content").cloned().unwrap_or(Value::Null);
    let content_raw = match &content_value {
        Value::String(value) => value.clone(),
        value => serde_json::to_string(value)?,
    };
    let content_text = clean_search_text(&extract_content_text(&content_value));

    let natural_id = string_value(object.get("id"));
    let base_id = natural_id.clone().unwrap_or_else(|| {
        let digest = sha256_hex(
            format!(
                "{}\0{}\0{}\0{}",
                ordinal,
                string_value(object.get("role")).unwrap_or_default(),
                integer_value(object.get("timestamp")).unwrap_or_default(),
                content_raw
            )
            .as_bytes(),
        );
        format!("synthetic_{}", &digest[..24])
    });
    let occurrence = seen_ids.entry(base_id.clone()).or_default();
    let msg_id = if *occurrence == 0 {
        base_id.clone()
    } else {
        // Malformed legacy files may contain duplicate IDs inside one topic. Preserve
        // the original in metadata while assigning a deterministic mirror-only key.
        format!("{base_id}#duplicate_{}", *occurrence)
    };
    *occurrence += 1;

    let role = string_value(object.get("role")).unwrap_or_else(|| "unknown".to_string());
    let speaker_name =
        string_value(object.get("name")).or_else(|| string_value(object.get("speakerName")));
    let speaker_agent_id = if owner_type == OwnerType::Group {
        string_value(object.get("agentId")).or_else(|| string_value(object.get("agentID")))
    } else {
        None
    };

    let attachments = object
        .get("attachments")
        .and_then(Value::as_array)
        .map(|attachments| {
            attachments
                .iter()
                .enumerate()
                .filter_map(|(order, value)| normalize_attachment(value, order).transpose())
                .collect::<Result<Vec<_>>>()
        })
        .transpose()?
        .unwrap_or_default();

    let metadata_json = serde_json::to_string(&Value::Object(object.clone()))?;
    let message_hash = sha256_hex(
        canonical_message_hash_input(
            &role,
            speaker_name.as_deref(),
            speaker_agent_id.as_deref(),
            &content_value,
            integer_value(object.get("timestamp")),
            object.get("attachments"),
        )
        .as_bytes(),
    );

    Ok(NormalizedMessage {
        msg_id,
        ordinal: ordinal as i64,
        role,
        speaker_name,
        speaker_agent_id,
        content_raw,
        content_text,
        timestamp: integer_value(object.get("timestamp")),
        message_hash,
        metadata_json,
        attachments,
    })
}

fn normalize_attachment(value: &Value, order: usize) -> Result<Option<NormalizedAttachment>> {
    let Some(object) = value.as_object() else {
        return Ok(None);
    };
    let nested = object.get("_fileManagerData").and_then(Value::as_object);
    let select = |key: &str| {
        nested
            .and_then(|map| map.get(key))
            .or_else(|| object.get(key))
    };

    Ok(Some(NormalizedAttachment {
        attachment_order: order as i64,
        content_hash: string_value(select("hash")),
        display_name: string_value(object.get("name"))
            .or_else(|| string_value(select("displayName"))),
        mime_type: string_value(object.get("type")).or_else(|| string_value(select("type"))),
        file_path: string_value(select("internalPath"))
            .or_else(|| string_value(object.get("localPath")))
            .or_else(|| string_value(object.get("src"))),
        metadata_json: serde_json::to_string(value)?,
        created_at: integer_value(select("createdAt")),
    }))
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

async fn read_stable_file(path: &Path) -> Result<Vec<u8>> {
    let mut delay = Duration::from_millis(75);
    let mut previous: Option<(u64, i64)> = None;
    let mut last_error = None;

    for _ in 0..6 {
        match fs::metadata(path).map(|metadata| {
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos().min(i64::MAX as u128) as i64)
                .unwrap_or(0);
            (metadata.len(), modified)
        }) {
            Ok(current) if previous == Some(current) && current.0 > 0 => {
                let bytes = fs::read(path)?;
                let after = fs::metadata(path)?;
                if after.len() == current.0 {
                    return Ok(bytes);
                }
            }
            Ok(current) => previous = Some(current),
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

fn extract_content_text(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| {
                let object = part.as_object()?;
                let part_type = object.get("type").and_then(Value::as_str);
                if part_type.is_none() || part_type == Some("text") {
                    string_value(object.get("text"))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(object) => string_value(object.get("text")).unwrap_or_default(),
        Value::Null => String::new(),
        value => value.to_string(),
    }
}

fn clean_search_text(value: &str) -> String {
    let without_style = Regex::new(r"(?is)<style[^>]*>.*?</style>")
        .expect("valid style regex")
        .replace_all(value, "");
    let without_script = Regex::new(r"(?is)<script[^>]*>.*?</script>")
        .expect("valid script regex")
        .replace_all(&without_style, "");
    let escaped_text = ammonia::clean_text(&without_script);
    let clean = html_escape::decode_html_entities(&escaped_text);
    Regex::new(r"\s+")
        .expect("valid whitespace regex")
        .replace_all(clean.trim(), " ")
        .to_string()
}

fn canonical_message_hash_input(
    role: &str,
    speaker_name: Option<&str>,
    speaker_agent_id: Option<&str>,
    content: &Value,
    timestamp: Option<i64>,
    attachments: Option<&Value>,
) -> String {
    serde_json::json!({
        "role": role,
        "speakerName": speaker_name,
        "speakerAgentId": speaker_agent_id,
        "content": content,
        "timestamp": timestamp,
        "attachments": attachments,
    })
    .to_string()
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

#[cfg(test)]
mod tests {
    use std::{fs, sync::Arc};

    use tempfile::TempDir;

    use super::{normalize_history, Reconciler};
    use crate::{
        config::{Cli, ServiceConfig},
        domain::{OwnerKey, OwnerType, TopicKey},
        error::ServiceError,
        identity::{IdentityResolver, OwnerResolution, OwnerSelector},
        search::{MessageSearchRequest, SearchIndex},
        storage::Database,
    };

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
        )
        .expect("normalize");
        assert_eq!(messages[0].speaker_name.as_deref(), Some("Nova"));
        assert_eq!(messages[0].speaker_agent_id.as_deref(), Some("agent_nova"));
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
    async fn noop_reconcile_preserves_owner_and_topic_updated_at() {
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

        {
            let connection = database.connection.lock();
            connection
                .execute(
                    "UPDATE owners SET updated_at=123
                     WHERE owner_type='agent' AND owner_id='agent_stable'",
                    [],
                )
                .expect("set owner timestamp sentinel");
            connection
                .execute(
                    "UPDATE topics SET updated_at=456
                     WHERE owner_type='agent' AND owner_id='agent_stable'
                       AND topic_id='topic_stable'",
                    [],
                )
                .expect("set topic timestamp sentinel");
        }

        let stats = reconciler.reconcile().await.expect("no-op reconcile");
        assert_eq!(stats.files_ingested, 0);
        assert_eq!(stats.files_skipped, 1);
        let (owner_updated_at, topic_updated_at) = {
            let connection = database.connection.lock();
            let owner_updated_at = connection
                .query_row(
                    "SELECT updated_at FROM owners
                     WHERE owner_type='agent' AND owner_id='agent_stable'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("read owner timestamp");
            let topic_updated_at = connection
                .query_row(
                    "SELECT updated_at FROM topics
                     WHERE owner_type='agent' AND owner_id='agent_stable'
                       AND topic_id='topic_stable'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("read topic timestamp");
            (owner_updated_at, topic_updated_at)
        };
        assert_eq!(owner_updated_at, 123);
        assert_eq!(topic_updated_at, 456);
    }

    #[tokio::test]
    async fn stale_config_cannot_resurrect_topic_after_physical_delete() {
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
            .apply_sync_topic_tombstone(&key, 321, "mobile_sync")
            .expect("apply explicit topic tombstone");
        let topic_directory = config
            .user_data_dir
            .join("agent_stale_topic/topics/topic_deleted");
        let stale_history_path = topic_directory.join("history.json");
        fs::remove_dir_all(&topic_directory).expect("delete physical topic directory");

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
        let persisted_tombstone = connection
            .query_row(
                "SELECT deleted_at FROM tombstones
                 WHERE entity_type='topic' AND owner_type='agent'
                   AND owner_id='agent_stale_topic' AND topic_id='topic_deleted'
                   AND entity_id='topic_deleted'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("load persisted topic tombstone");
        let never_created: i64 = connection
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
        assert_eq!(persisted_tombstone, 321);
        assert_eq!(never_created, 0);
    }

    #[tokio::test]
    async fn physical_topic_missing_from_config_is_ingested_as_stable_orphan() {
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

        let first = reconciler.reconcile().await.expect("initial reconcile");
        assert_eq!(first.topics_seen, 1);
        assert_eq!(first.files_ingested, 1);
        assert_eq!(first.messages_ingested, 1);
        let key = TopicKey {
            owner_type: OwnerType::Agent,
            owner_id: "agent_orphan_topic".to_string(),
            topic_id: "topic_orphan".to_string(),
        };
        let messages = database
            .active_messages_for_topic(&key)
            .expect("load orphan messages");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content_text, "physical truth");

        let before = {
            let connection = database.connection.lock();
            connection
                .query_row(
                    "SELECT topic_ordinal, metadata_json, updated_at FROM topics
                     WHERE owner_type='agent' AND owner_id='agent_orphan_topic'
                       AND topic_id='topic_orphan' AND deleted_at IS NULL",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )
                .expect("load orphan topic")
        };
        assert_eq!(before.0, 0);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&before.1).expect("parse orphan metadata"),
            serde_json::json!({
                "orphanHistory": true,
                "compatibilityStatus": "history_not_listed_in_config"
            })
        );

        let second = reconciler.reconcile().await.expect("repeat reconcile");
        assert_eq!(second.files_ingested, 0);
        assert_eq!(second.files_skipped, 1);
        let after = {
            let connection = database.connection.lock();
            connection
                .query_row(
                    "SELECT topic_ordinal, metadata_json, updated_at FROM topics
                     WHERE owner_type='agent' AND owner_id='agent_orphan_topic'
                       AND topic_id='topic_orphan' AND deleted_at IS NULL",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )
                .expect("reload orphan topic")
        };
        assert_eq!(after, before);
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
                    "content": "last valid content"
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
    async fn deleting_history_is_removed_from_tantivy_and_revisions_converge() {
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
                    "content": "独特删除检索词"
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
        reconciler.reconcile().await.expect("deletion reconcile");
        assert_eq!(
            index
                .reconcile_revisions()
                .expect("reconcile deleted search topic"),
            1
        );
        assert!(index
            .search_messages(&request)
            .expect("search after delete")
            .is_empty());

        let stats = database.stats().expect("revision stats");
        assert_eq!(stats.content_revision, stats.indexed_revision);
    }

    #[tokio::test]
    async fn deleting_history_soft_deletes_messages_but_keeps_configured_topic() {
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
                    "content": "will be removed"
                },
                {
                    "id": "msg_2",
                    "role": "assistant",
                    "content": "will also be removed"
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

        assert_eq!(result.files_deleted, 1);
        assert_eq!(result.messages_deleted, 2);
        let after = database.stats().expect("stats after deletion");
        assert_eq!(after.owners, 1);
        assert_eq!(after.topics, 1);
        assert_eq!(after.messages, 0);
        assert!(after.content_revision > before.content_revision);
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

    #[tokio::test]
    async fn deleting_same_id_group_does_not_delete_agent_namespace() {
        let (_temp, config, database, reconciler) = fixture();
        write_owner(
            &config,
            OwnerType::Agent,
            "shared_id",
            "Agent",
            &["agent_topic"],
        );
        write_owner(
            &config,
            OwnerType::Group,
            "shared_id",
            "Group",
            &["group_topic"],
        );
        write_history(
            &config,
            "shared_id",
            "agent_topic",
            serde_json::json!([
                {"id":"agent_message","role":"user","content":"agent namespace"}
            ]),
        );
        reconciler.reconcile().await.expect("initial reconcile");

        fs::remove_dir_all(config.groups_dir.join("shared_id"))
            .expect("delete group config directory");
        let result = reconciler
            .reconcile()
            .await
            .expect("group deletion reconcile");

        assert_eq!(result.owners_deleted, 1);
        assert!(database
            .owner_by_id(OwnerType::Agent, "shared_id")
            .expect("query agent")
            .is_some());
        assert!(database
            .owner_by_id(OwnerType::Group, "shared_id")
            .expect("query group")
            .is_none());
        let stats = database.stats().expect("namespace stats");
        assert_eq!(stats.owners, 1);
        assert_eq!(stats.topics, 1);
    }

    #[test]
    fn owner_registry_keeps_agent_and_group_namespaces_separate() {
        let (_temp, config, _database, reconciler) = fixture();
        write_owner(
            &config,
            OwnerType::Agent,
            "same_owner_id",
            "Agent",
            &["topic_agent"],
        );
        write_owner(
            &config,
            OwnerType::Group,
            "same_owner_id",
            "Group",
            &["topic_group"],
        );

        let (owners, duplicate_count) = reconciler.scan_owner_registry().expect("scan registry");
        assert_eq!(duplicate_count, 1);
        assert!(owners.contains_key(&OwnerKey {
            owner_type: OwnerType::Agent,
            owner_id: "same_owner_id".to_string(),
        }));
        assert!(owners.contains_key(&OwnerKey {
            owner_type: OwnerType::Group,
            owner_id: "same_owner_id".to_string(),
        }));
    }
}
