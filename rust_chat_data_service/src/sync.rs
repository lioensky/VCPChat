use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    str::FromStr,
};

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{
    domain::{OwnerType, TopicKey},
    ingest::{sha256_hex, Reconciler},
    storage::{Database, IngestCommit},
    sync_wire::{canonicalize_for_wire, canonicalize_message, message_fingerprint, WireWarnings},
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestRequest {
    pub data_type: String,
    pub data: Vec<RemoteManifestItem>,
    #[serde(default)]
    pub targeted_owners: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteManifestItem {
    pub id: String,
    pub hash: String,
    #[serde(default)]
    pub config_hash: Option<String>,
    #[serde(default)]
    pub content_hash: Option<String>,
    pub ts: i64,
    #[serde(default)]
    pub deleted_at: Option<i64>,
    #[serde(default)]
    pub owner_type: Option<OwnerType>,
    #[serde(default)]
    pub owner_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestItem {
    pub id: String,
    pub hash: String,
    pub config_hash: String,
    pub content_hash: String,
    pub ts: i64,
    pub deleted_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_type: Option<OwnerType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestAction {
    pub id: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_type: Option<OwnerType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub mismatched_content: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestResponse {
    #[serde(rename = "type")]
    pub response_type: &'static str,
    pub data: Vec<ManifestAction>,
    pub data_type: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicSelector {
    pub topic_id: String,
    #[serde(default)]
    pub owner_type: Option<OwnerType>,
    #[serde(default)]
    pub owner_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicIdentityResponse {
    pub topic_id: String,
    pub owner_type: OwnerType,
    pub owner_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageManifestItem {
    pub msg_id: String,
    pub content_hash: String,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageManifestResponse {
    #[serde(rename = "type")]
    pub response_type: &'static str,
    pub topic_id: String,
    pub owner_type: OwnerType,
    pub owner_id: String,
    pub messages: Vec<MessageManifestItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicHashDiffRequest {
    #[serde(default)]
    pub hashes: HashMap<String, Value>,
    #[serde(default)]
    pub topics: Vec<TopicHashState>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicHashState {
    pub topic_id: String,
    #[serde(default)]
    pub owner_type: Option<OwnerType>,
    #[serde(default)]
    pub owner_id: Option<String>,
    #[serde(default)]
    pub config_hash: String,
    #[serde(default)]
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicHashDiffResponse {
    #[serde(rename = "type")]
    pub response_type: &'static str,
    pub changed_topics: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDiffRequest {
    #[serde(default)]
    pub topics: HashMap<String, MessageDiffState>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDiffState {
    #[serde(default)]
    pub owner_type: Option<OwnerType>,
    #[serde(default)]
    pub owner_id: Option<String>,
    #[serde(default)]
    pub topic_hash: String,
    #[serde(default)]
    pub messages: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDiffResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_pull: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_push: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SyncDecisionError>,
}

impl MessageDiffResult {
    fn success(to_pull: Vec<String>, to_push: bool) -> Self {
        Self {
            ok: true,
            to_pull: Some(to_pull),
            to_push: Some(to_push),
            error: None,
        }
    }

    fn failure(code: &str, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            to_pull: None,
            to_push: None,
            error: Some(SyncDecisionError {
                code: code.to_string(),
                message: message.into(),
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDecisionError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDiffResponse {
    #[serde(rename = "type")]
    pub response_type: &'static str,
    pub results: HashMap<String, MessageDiffResult>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagesPullRequest {
    pub requests: Vec<MessagesPullTopic>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagesPullTopic {
    pub topic_id: String,
    #[serde(default)]
    pub owner_type: Option<OwnerType>,
    #[serde(default)]
    pub owner_id: Option<String>,
    #[serde(default)]
    pub msg_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagesPullFrame {
    pub topic_id: String,
    pub owner_type: OwnerType,
    pub owner_id: String,
    pub messages: Vec<Value>,
    #[serde(skip_serializing_if = "is_zero")]
    pub legacy_attachment_warnings: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warning_samples: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagesPushRequest {
    pub topics: Vec<MessagesPushTopic>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagesPushTopic {
    pub topic_id: String,
    #[serde(default)]
    pub owner_type: Option<OwnerType>,
    #[serde(default)]
    pub owner_id: Option<String>,
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub deleted_message_ids: Vec<String>,
    #[serde(default)]
    pub deleted_message_tombstones: Vec<MessageTombstoneInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageTombstoneInput {
    pub msg_id: String,
    pub deleted_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagesPushResult {
    pub topic_id: String,
    pub success: bool,
    pub changed: bool,
    pub revision: Option<i64>,
    pub message_count: usize,
    pub needed_attachment_hashes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagesPushResponse {
    pub results: Vec<MessagesPushResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRecord {
    pub sequence: i64,
    pub entity_type: String,
    pub operation: String,
    pub owner_type: Option<OwnerType>,
    pub owner_id: Option<String>,
    pub topic_id: Option<String>,
    pub entity_id: Option<String>,
    pub revision: i64,
    pub origin: String,
    pub changed_at: i64,
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeFeedResponse {
    pub changes: Vec<ChangeRecord>,
    pub next_sequence: i64,
    pub has_more: bool,
}

const MAX_SYNC_ITEMS: usize = 10_000;
const MAX_SAFE_JSON_INTEGER: i64 = (1_i64 << 53) - 1;

fn is_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_manifest_request(request: &ManifestRequest) -> Result<()> {
    anyhow::ensure!(
        matches!(request.data_type.as_str(), "agent" | "group" | "topic"),
        "unsupported manifest dataType {}",
        request.data_type
    );
    anyhow::ensure!(
        request.data.len() <= MAX_SYNC_ITEMS,
        "manifest exceeds {MAX_SYNC_ITEMS} items"
    );

    let targeted_owners = request.targeted_owners.as_deref();
    if request.data_type == "topic" {
        let owners = targeted_owners.context("topic manifest requires targetedOwners")?;
        anyhow::ensure!(
            owners.len() <= MAX_SYNC_ITEMS,
            "targetedOwners exceeds {MAX_SYNC_ITEMS} items"
        );
        let unique = owners.iter().collect::<HashSet<_>>();
        anyhow::ensure!(
            unique.len() == owners.len() && owners.iter().all(|owner| !owner.is_empty()),
            "targetedOwners contains empty or duplicate owner IDs"
        );
    } else {
        anyhow::ensure!(
            targeted_owners.is_none(),
            "targetedOwners is only valid for topic manifests"
        );
    }

    let mut seen_ids = HashSet::new();
    for item in &request.data {
        anyhow::ensure!(!item.id.is_empty(), "manifest item id must not be empty");
        anyhow::ensure!(
            seen_ids.insert(item.id.as_str()),
            "manifest contains duplicate id {}",
            item.id
        );
        anyhow::ensure!(
            is_lower_sha256(&item.hash),
            "manifest item {} hash must be lowercase SHA-256",
            item.id
        );
        let config_hash = item
            .config_hash
            .as_deref()
            .context("manifest configHash is required")?;
        anyhow::ensure!(
            is_lower_sha256(config_hash),
            "manifest item {} configHash must be lowercase SHA-256",
            item.id
        );
        let content_hash = item
            .content_hash
            .as_deref()
            .context("manifest contentHash is required")?;
        anyhow::ensure!(
            content_hash.is_empty() || is_lower_sha256(content_hash),
            "manifest item {} contentHash must be empty or lowercase SHA-256",
            item.id
        );
        anyhow::ensure!(
            (0..=MAX_SAFE_JSON_INTEGER).contains(&item.ts),
            "manifest item {} timestamp must be a non-negative safe integer",
            item.id
        );
        if let Some(deleted_at) = item.deleted_at {
            anyhow::ensure!(
                (0..=MAX_SAFE_JSON_INTEGER).contains(&deleted_at),
                "manifest item {} deletedAt must be a non-negative safe integer",
                item.id
            );
        }
        if request.data_type == "topic" {
            let owner_type = item
                .owner_type
                .context("topic manifest item requires ownerType")?;
            let owner_id = item
                .owner_id
                .as_deref()
                .filter(|owner_id| !owner_id.is_empty())
                .context("topic manifest item requires ownerId")?;
            anyhow::ensure!(
                targeted_owners.is_some_and(|owners| owners.iter().any(|id| id == owner_id)),
                "topic manifest item {} has unexpected owner {}:{}",
                item.id,
                owner_type.as_str(),
                owner_id
            );
        }
    }
    Ok(())
}

pub fn manifest(database: &Database, request: ManifestRequest) -> Result<ManifestResponse> {
    validate_manifest_request(&request)?;
    let local = local_manifest(
        database,
        &request.data_type,
        request.targeted_owners.as_deref(),
    )?;
    anyhow::ensure!(
        local.len() <= MAX_SYNC_ITEMS,
        "local manifest exceeds {MAX_SYNC_ITEMS} items"
    );
    let mut local_by_key = HashMap::new();
    let mut local_ids = HashSet::new();
    for item in local {
        anyhow::ensure!(
            local_ids.insert(item.id.clone()),
            "local manifest contains ambiguous topic id {}",
            item.id
        );
        local_by_key.insert(
            manifest_key(&item.id, item.owner_type, item.owner_id.as_deref()),
            item,
        );
    }

    let mut actions = Vec::new();
    let mut processed = HashSet::new();
    for remote in &request.data {
        let key = manifest_key(&remote.id, remote.owner_type, remote.owner_id.as_deref());
        let exact = local_by_key.get(&key);
        if request.data_type == "topic"
            && exact.is_none()
            && unique_manifest_item_by_id(&local_by_key, &remote.id).is_some()
        {
            anyhow::bail!("topic {} owner conflicts with the CDS index", remote.id);
        }
        let local = if request.data_type == "topic" {
            exact
        } else {
            exact.or_else(|| unique_manifest_item_by_id(&local_by_key, &remote.id))
        };
        processed.insert(local.map_or(key, |item| {
            manifest_key(&item.id, item.owner_type, item.owner_id.as_deref())
        }));

        if let Some(deleted_at) = remote.deleted_at {
            if local.is_none_or(|item| item.deleted_at.is_none()) {
                actions.push(manifest_action(remote, "DELETE", Some(deleted_at), false));
            }
            continue;
        }

        let Some(local) = local else {
            actions.push(manifest_action(remote, "PUSH", None, false));
            continue;
        };
        if let Some(deleted_at) = local.deleted_at {
            actions.push(ManifestAction {
                id: local.id.clone(),
                action: "PUSH_DELETE".to_string(),
                deleted_at: Some(deleted_at),
                owner_type: local.owner_type,
                owner_id: local.owner_id.clone(),
                mismatched_content: false,
            });
            continue;
        }

        let remote_config = remote.config_hash.as_deref().unwrap_or(&remote.hash);
        let remote_content = remote.content_hash.as_deref().unwrap_or_default();
        let config_changed = local.config_hash != remote_config;
        let content_changed = local.content_hash != remote_content;
        if config_changed {
            actions.push(ManifestAction {
                id: local.id.clone(),
                action: if remote.ts > local.ts { "PUSH" } else { "PULL" }.to_string(),
                deleted_at: None,
                owner_type: local.owner_type,
                owner_id: local.owner_id.clone(),
                mismatched_content: content_changed,
            });
        } else if content_changed && (request.data_type == "agent" || request.data_type == "group")
        {
            actions.push(ManifestAction {
                id: local.id.clone(),
                action: "SKIP".to_string(),
                deleted_at: None,
                owner_type: local.owner_type,
                owner_id: local.owner_id.clone(),
                mismatched_content: true,
            });
        }
    }

    for (key, local) in local_by_key {
        if processed.contains(&key) {
            continue;
        }
        actions.push(ManifestAction {
            id: local.id,
            action: if local.deleted_at.is_some() {
                "PUSH_DELETE"
            } else {
                "PULL"
            }
            .to_string(),
            deleted_at: local.deleted_at,
            owner_type: local.owner_type,
            owner_id: local.owner_id,
            mismatched_content: false,
        });
    }

    Ok(ManifestResponse {
        response_type: "SYNC_DIFF_RESULTS",
        data: actions,
        data_type: request.data_type,
    })
}

pub fn message_manifest(
    database: &Database,
    selector: &TopicSelector,
) -> Result<MessageManifestResponse> {
    let key = resolve_topic(database, selector)?;
    let connection = database.connection.lock();
    let mut statement = connection.prepare(
        "SELECT msg_id, metadata_json, updated_at, deleted_at
         FROM messages
         WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3
         ORDER BY ordinal ASC",
    )?;
    let rows = statement
        .query_map(
            params![key.owner_type.as_str(), key.owner_id, key.topic_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    drop(connection);
    ensure_topic_sync_source_healthy(database, &key)?;
    let messages = rows
        .into_iter()
        .map(|(msg_id, metadata, updated_at, deleted_at)| {
            let content_hash = mobile_message_hash_from_json(&metadata, &key.topic_id)
                .with_context(|| format!("message {msg_id} cannot cross sync wire"))?;
            Ok(MessageManifestItem {
                msg_id,
                content_hash,
                updated_at,
                deleted_at,
            })
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(MessageManifestResponse {
        response_type: "MESSAGE_MANIFEST_RESULTS",
        topic_id: key.topic_id,
        owner_type: key.owner_type,
        owner_id: key.owner_id,
        messages,
    })
}

pub fn topic_identity(
    database: &Database,
    selector: &TopicSelector,
) -> Result<TopicIdentityResponse> {
    let key = resolve_topic(database, selector)?;
    Ok(TopicIdentityResponse {
        topic_id: key.topic_id,
        owner_type: key.owner_type,
        owner_id: key.owner_id,
    })
}

pub fn topic_hash_diff(
    database: &Database,
    request: TopicHashDiffRequest,
) -> Result<TopicHashDiffResponse> {
    anyhow::ensure!(
        request.topics.len().saturating_add(request.hashes.len()) <= 10_000,
        "topic hash diff exceeds 10000 topics"
    );
    let mut states = request.topics;
    let mut seen_topic_ids = states
        .iter()
        .map(|state| state.topic_id.clone())
        .collect::<HashSet<_>>();
    anyhow::ensure!(
        seen_topic_ids.len() == states.len(),
        "topic hash diff contains duplicate topic ids"
    );
    for (topic_id, value) in request.hashes {
        anyhow::ensure!(
            seen_topic_ids.insert(topic_id.clone()),
            "topic hash diff contains duplicate topic {topic_id}"
        );
        let (config_hash, content_hash) = match value {
            Value::Object(object) => {
                let config_hash = object
                    .get("configHash")
                    .and_then(Value::as_str)
                    .context("topic hash configHash must be a string")?
                    .to_string();
                let content_hash = object
                    .get("contentHash")
                    .and_then(Value::as_str)
                    .context("topic hash contentHash must be a string")?
                    .to_string();
                (config_hash, content_hash)
            }
            Value::String(content_hash) => (String::new(), content_hash),
            _ => anyhow::bail!("topic hash state must be a string or object"),
        };
        states.push(TopicHashState {
            topic_id,
            owner_type: None,
            owner_id: None,
            config_hash,
            content_hash,
        });
    }

    let mut changed_topics = Vec::new();
    for state in states {
        anyhow::ensure!(
            !state.topic_id.is_empty(),
            "topic hash diff topicId is empty"
        );
        anyhow::ensure!(
            state.owner_type.is_some() == state.owner_id.is_some(),
            "topic hash diff ownerType and ownerId must be supplied together"
        );
        anyhow::ensure!(
            state
                .owner_id
                .as_deref()
                .is_none_or(|owner_id| !owner_id.is_empty()),
            "topic hash diff ownerId must be non-empty"
        );
        anyhow::ensure!(
            (state.config_hash.is_empty() || canonical_wire_hash(&state.config_hash).is_some())
                && (state.content_hash.is_empty()
                    || canonical_wire_hash(&state.content_hash).is_some()),
            "topic hash diff contains an invalid hash for {}",
            state.topic_id
        );
        let selector = TopicSelector {
            topic_id: state.topic_id.clone(),
            owner_type: state.owner_type,
            owner_id: state.owner_id,
        };
        let Ok(key) = resolve_topic(database, &selector) else {
            changed_topics.push(state.topic_id);
            continue;
        };
        let local = topic_manifest(database, &key)?;
        if (!state.config_hash.is_empty() && local.config_hash != state.config_hash)
            || local.content_hash != state.content_hash
        {
            changed_topics.push(state.topic_id);
        }
    }
    changed_topics.sort();

    Ok(TopicHashDiffResponse {
        response_type: "SYNC_TOPIC_HASH_RESULTS",
        changed_topics,
    })
}

pub fn message_diff(
    database: &Database,
    request: MessageDiffRequest,
) -> Result<MessageDiffResponse> {
    anyhow::ensure!(
        request.topics.len() <= 10_000,
        "message diff exceeds 10000 topics"
    );
    let mut results = HashMap::new();
    let mut total_messages = 0_usize;
    for (topic_id, state) in request.topics {
        anyhow::ensure!(
            !topic_id.is_empty(),
            "message diff topicId must be non-empty"
        );
        let owner_type = state
            .owner_type
            .context("message diff ownerType is required")?;
        let owner_id = state
            .owner_id
            .as_deref()
            .filter(|owner_id| !owner_id.is_empty())
            .context("message diff ownerId is required")?;
        anyhow::ensure!(
            state.topic_hash.is_empty() || canonical_wire_hash(&state.topic_hash).is_some(),
            "message diff topicHash is invalid for {topic_id}"
        );
        anyhow::ensure!(
            state.messages.len() <= 10_000,
            "message diff topic exceeds 10000 messages"
        );
        total_messages = total_messages
            .checked_add(state.messages.len())
            .context("message diff count overflow")?;
        anyhow::ensure!(
            total_messages <= 100_000,
            "message diff exceeds 100000 messages"
        );
        for (message_id, hash) in &state.messages {
            anyhow::ensure!(
                !message_id.is_empty(),
                "message diff message id must be non-empty"
            );
            anyhow::ensure!(
                hash == "DELETED" || canonical_wire_hash(hash).is_some(),
                "message diff contains an invalid content hash for {topic_id}/{message_id}"
            );
        }
        let selector = TopicSelector {
            topic_id: topic_id.clone(),
            owner_type: Some(owner_type),
            owner_id: Some(owner_id.to_string()),
        };
        let key = match resolve_topic(database, &selector) {
            Ok(key) => key,
            Err(error) => {
                results.insert(
                    topic_id,
                    MessageDiffResult::failure("TOPIC_NOT_FOUND", format!("{error:#}")),
                );
                continue;
            }
        };

        let local_topic = match topic_manifest(database, &key) {
            Ok(local_topic) => local_topic,
            Err(error) => {
                results.insert(
                    topic_id,
                    MessageDiffResult::failure("TOPIC_HASH_FAILED", format!("{error:#}")),
                );
                continue;
            }
        };
        if !state.topic_hash.is_empty() && state.topic_hash == local_topic.content_hash {
            results.insert(topic_id, MessageDiffResult::success(Vec::new(), false));
            continue;
        }

        let manifest = match message_manifest(database, &selector) {
            Ok(manifest) => manifest,
            Err(error) => {
                results.insert(
                    topic_id,
                    MessageDiffResult::failure("MESSAGE_MANIFEST_FAILED", format!("{error:#}")),
                );
                continue;
            }
        };
        let active = manifest
            .messages
            .into_iter()
            .filter(|item| item.deleted_at.is_none())
            .map(|item| (item.msg_id, item.content_hash))
            .collect::<HashMap<_, _>>();
        let mut to_pull = active
            .iter()
            .filter_map(|(id, hash)| {
                let remote = state.messages.get(id);
                (remote.is_none()
                    || remote.is_some_and(|value| value != hash && value != "DELETED"))
                .then_some(id.clone())
            })
            .collect::<Vec<_>>();
        to_pull.sort();
        let to_push = state
            .messages
            .iter()
            .any(|(id, hash)| hash != "DELETED" && !active.contains_key(id));
        results.insert(topic_id, MessageDiffResult::success(to_pull, to_push));
    }

    Ok(MessageDiffResponse {
        response_type: "SYNC_DIFF_RESULTS_BATCH",
        results,
    })
}

pub fn pull_messages(
    database: &Database,
    request: MessagesPullRequest,
) -> Result<Vec<MessagesPullFrame>> {
    let mut frames = Vec::with_capacity(request.requests.len());
    for topic in request.requests {
        frames.push(pull_topic_messages(database, topic)?);
    }
    Ok(frames)
}

pub fn pull_topic_messages(
    database: &Database,
    topic: MessagesPullTopic,
) -> Result<MessagesPullFrame> {
    let selector = TopicSelector {
        topic_id: topic.topic_id.clone(),
        owner_type: topic.owner_type,
        owner_id: topic.owner_id,
    };
    let key = resolve_topic(database, &selector)?;
    ensure_topic_sync_source_healthy(database, &key)?;
    anyhow::ensure!(
        topic.msg_ids.len() <= 10_000,
        "topic message request exceeds 10000 ids"
    );
    let wanted = topic.msg_ids.into_iter().collect::<HashSet<_>>();
    let connection = database.connection.lock();
    let mut statement = connection.prepare(
        "SELECT metadata_json FROM messages
         WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3 AND deleted_at IS NULL
         ORDER BY ordinal ASC",
    )?;
    let rows = statement
        .query_map(
            params![key.owner_type.as_str(), key.owner_id, key.topic_id],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    drop(connection);

    let mut warnings = WireWarnings::default();
    let mut messages = Vec::new();
    let mut seen = HashSet::new();
    for raw in rows {
        let value =
            serde_json::from_str::<Value>(&raw).context("stored message JSON is invalid")?;
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .context("stored message id is missing")?;
        if !wanted.is_empty() && !wanted.contains(id) {
            continue;
        }
        anyhow::ensure!(
            seen.insert(id.to_string()),
            "duplicate stored message id {id}"
        );
        messages.push(canonicalize_for_wire(value, &key.topic_id, &mut warnings)?);
    }
    if !wanted.is_empty() {
        anyhow::ensure!(
            seen == wanted,
            "requested message set is incomplete for topic {}",
            key.topic_id
        );
    }
    Ok(MessagesPullFrame {
        topic_id: key.topic_id,
        owner_type: key.owner_type,
        owner_id: key.owner_id,
        messages,
        legacy_attachment_warnings: warnings.count,
        warning_samples: warnings.samples,
    })
}

pub async fn push_messages(
    reconciler: &Reconciler,
    request: MessagesPushRequest,
) -> MessagesPushResponse {
    let mut results = Vec::with_capacity(request.topics.len());
    for topic in request.topics {
        let result = push_topic(reconciler, &topic).await;
        results.push(match result {
            Ok(commit) => MessagesPushResult {
                topic_id: topic.topic_id,
                success: true,
                changed: commit.changed,
                revision: Some(commit.revision),
                message_count: commit.message_count,
                needed_attachment_hashes: Vec::new(),
                error: None,
            },
            Err(error) => MessagesPushResult {
                topic_id: topic.topic_id,
                success: false,
                changed: false,
                revision: None,
                message_count: 0,
                needed_attachment_hashes: Vec::new(),
                error: Some(format!("{error:#}")),
            },
        });
    }
    MessagesPushResponse { results }
}

async fn push_topic(reconciler: &Reconciler, topic: &MessagesPushTopic) -> Result<IngestCommit> {
    anyhow::ensure!(
        topic.owner_type.is_some() == topic.owner_id.is_some(),
        "pushed topic ownerType and ownerId must be supplied together"
    );
    anyhow::ensure!(
        topic
            .owner_id
            .as_deref()
            .is_none_or(|owner_id| !owner_id.is_empty()),
        "pushed topic ownerId must be non-empty"
    );
    let mut deleted = topic
        .deleted_message_ids
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    anyhow::ensure!(
        deleted.len() == topic.deleted_message_ids.len()
            && deleted.iter().all(|message_id| !message_id.is_empty()),
        "deleted message ids must be non-empty and unique"
    );
    let mut explicit_tombstones = Vec::with_capacity(topic.deleted_message_tombstones.len());
    for tombstone in &topic.deleted_message_tombstones {
        anyhow::ensure!(
            !tombstone.msg_id.is_empty() && deleted.insert(tombstone.msg_id.clone()),
            "deleted message tombstones must have non-empty unique ids"
        );
        anyhow::ensure!(
            (0..=9_007_199_254_740_991).contains(&tombstone.deleted_at),
            "deleted message tombstone timestamp must be a non-negative safe integer"
        );
        explicit_tombstones.push((tombstone.msg_id.clone(), tombstone.deleted_at));
    }
    let mut live_ids = HashSet::new();
    for message in &topic.messages {
        let id = message
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .context("pushed message id is required")?;
        anyhow::ensure!(
            live_ids.insert(id.to_string()),
            "duplicate pushed message id {id}"
        );
        anyhow::ensure!(
            !deleted.contains(id),
            "message {id} is both live and deleted"
        );
        let mut warnings = WireWarnings::default();
        canonicalize_message(message.clone(), &topic.topic_id, &mut warnings)
            .with_context(|| format!("pushed message {id} is invalid"))?;
        anyhow::ensure!(
            warnings.count == 0,
            "pushed message {id} contains an invalid attachment"
        );
    }
    let key = resolve_topic(
        reconciler.database(),
        &TopicSelector {
            topic_id: topic.topic_id.clone(),
            owner_type: topic.owner_type,
            owner_id: topic.owner_id.clone(),
        },
    )?;
    let history_path = reconciler
        .config()
        .user_data_dir
        .join(&key.owner_id)
        .join("topics")
        .join(&topic.topic_id)
        .join("history.json");

    let (mut current, expected_source_hash) = read_history_snapshot(&history_path)?;
    current.retain(|value| {
        value
            .get("id")
            .and_then(Value::as_str)
            .is_none_or(|id| !deleted.contains(id))
    });
    let mut positions: HashMap<String, usize> = current
        .iter()
        .enumerate()
        .filter_map(|(index, value)| {
            value
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (id.to_string(), index))
        })
        .collect();

    for message in &topic.messages {
        let id = message
            .get("id")
            .and_then(Value::as_str)
            .context("pushed message id is required")?;
        if let Some(index) = positions.get(id).copied() {
            current[index] = message.clone();
        } else {
            positions.insert(id.to_string(), current.len());
            current.push(message.clone());
        }
    }

    write_json_atomic(
        &history_path,
        &Value::Array(current),
        expected_source_hash.as_deref(),
    )?;
    let mut commit = reconciler
        .ingest_path(&history_path, "mobile_sync")
        .await?
        .context("projected history path was not accepted by CDS")?;
    if let Some(revision) = reconciler.database().apply_explicit_message_tombstones(
        &key,
        &explicit_tombstones,
        "mobile_sync",
    )? {
        commit.changed = true;
        commit.revision = revision;
    }
    Ok(commit)
}

pub fn changes(database: &Database, after: i64, limit: usize) -> Result<ChangeFeedResponse> {
    let fetch_limit = limit.clamp(1, 1000);
    let connection = database.connection.lock();
    let mut statement = connection.prepare(
        "SELECT sequence, entity_type, operation, owner_type, owner_id, topic_id,
                entity_id, revision, origin, changed_at, payload_json
         FROM change_log WHERE sequence>?1 ORDER BY sequence ASC LIMIT ?2",
    )?;
    let mut changes = statement
        .query_map(params![after, fetch_limit as i64 + 1], |row| {
            let owner_type = row
                .get::<_, Option<String>>(3)?
                .and_then(|value| OwnerType::from_str(&value).ok());
            let payload = row
                .get::<_, Option<String>>(10)?
                .and_then(|value| serde_json::from_str(&value).ok());
            Ok(ChangeRecord {
                sequence: row.get(0)?,
                entity_type: row.get(1)?,
                operation: row.get(2)?,
                owner_type,
                owner_id: row.get(4)?,
                topic_id: row.get(5)?,
                entity_id: row.get(6)?,
                revision: row.get(7)?,
                origin: row.get(8)?,
                changed_at: row.get(9)?,
                payload,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = changes.len() > fetch_limit;
    changes.truncate(fetch_limit);
    let next_sequence = changes.last().map_or(after, |change| change.sequence);
    Ok(ChangeFeedResponse {
        changes,
        next_sequence,
        has_more,
    })
}

fn local_manifest(
    database: &Database,
    data_type: &str,
    targeted_owners: Option<&[String]>,
) -> Result<Vec<ManifestItem>> {
    match data_type {
        "agent" => owner_manifest(database, OwnerType::Agent),
        "group" => owner_manifest(database, OwnerType::Group),
        "topic" => topic_manifests(database, targeted_owners),
        _ => Ok(Vec::new()),
    }
}

fn owner_manifest(database: &Database, owner_type: OwnerType) -> Result<Vec<ManifestItem>> {
    let connection = database.connection.lock();
    let mut statement = connection.prepare(
        "SELECT owner_id, config_path, updated_at, deleted_at
         FROM owners WHERE owner_type=?1",
    )?;
    let rows = statement
        .query_map([owner_type.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    drop(connection);

    rows.into_iter()
        .map(|(owner_id, config_path, ts, deleted_at)| {
            let config_hash = mobile_owner_config_hash(owner_type, Path::new(&config_path))?;
            let content_hash = owner_content_hash(database, owner_type, &owner_id)?;
            Ok(ManifestItem {
                id: owner_id.clone(),
                hash: config_hash.clone(),
                config_hash,
                content_hash,
                ts,
                deleted_at,
                owner_type: Some(owner_type),
                owner_id: Some(owner_id),
            })
        })
        .collect()
}

fn topic_manifests(
    database: &Database,
    targeted_owners: Option<&[String]>,
) -> Result<Vec<ManifestItem>> {
    let connection = database.connection.lock();
    let mut statement = connection.prepare(
        "SELECT owner_type, owner_id, topic_id
         FROM topics ORDER BY owner_type, owner_id, topic_ordinal",
    )?;
    let keys = statement
        .query_map([], |row| {
            let raw: String = row.get(0)?;
            Ok(TopicKey {
                owner_type: if raw == "group" {
                    OwnerType::Group
                } else {
                    OwnerType::Agent
                },
                owner_id: row.get(1)?,
                topic_id: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    drop(connection);

    keys.into_iter()
        .filter(|key| targeted_owners.is_none_or(|owners| owners.contains(&key.owner_id)))
        .map(|key| topic_manifest(database, &key))
        .collect()
}

fn topic_manifest(database: &Database, key: &TopicKey) -> Result<ManifestItem> {
    let connection = database.connection.lock();
    let (metadata_json, updated_at, deleted_at): (String, i64, Option<i64>) = connection
        .query_row(
            "SELECT metadata_json, updated_at, deleted_at FROM topics
         WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3",
            params![key.owner_type.as_str(), key.owner_id, key.topic_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
    drop(connection);
    let metadata =
        serde_json::from_str::<Value>(&metadata_json).context("topic metadata is invalid")?;
    let config_hash = mobile_topic_config_hash(key, &metadata);
    let content_hash = topic_content_hash(database, key)?;
    Ok(ManifestItem {
        id: key.topic_id.clone(),
        hash: config_hash.clone(),
        config_hash,
        content_hash,
        ts: updated_at,
        deleted_at,
        owner_type: Some(key.owner_type),
        owner_id: Some(key.owner_id.clone()),
    })
}

fn owner_content_hash(
    database: &Database,
    owner_type: OwnerType,
    owner_id: &str,
) -> Result<String> {
    let connection = database.connection.lock();
    let mut statement = connection.prepare(
        "SELECT topic_id FROM topics
         WHERE owner_type=?1 AND owner_id=?2 AND deleted_at IS NULL",
    )?;
    let topic_ids = statement
        .query_map(params![owner_type.as_str(), owner_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    drop(connection);
    let mut hashes = Vec::new();
    for topic_id in topic_ids {
        hashes.push(topic_content_hash(
            database,
            &TopicKey {
                owner_type,
                owner_id: owner_id.to_string(),
                topic_id,
            },
        )?);
    }
    Ok(aggregate_hash(hashes))
}

fn topic_content_hash(database: &Database, key: &TopicKey) -> Result<String> {
    ensure_topic_sync_source_healthy(database, key)?;
    let connection = database.connection.lock();
    let mut statement = connection.prepare(
        "SELECT metadata_json FROM messages
         WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3 AND deleted_at IS NULL",
    )?;
    let rows = statement
        .query_map(
            params![key.owner_type.as_str(), key.owner_id, key.topic_id],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    drop(connection);
    let hashes = rows
        .into_iter()
        .map(|raw| mobile_message_hash_from_json(&raw, &key.topic_id))
        .collect::<Result<Vec<_>>>()?;
    Ok(aggregate_hash(hashes))
}

fn ensure_topic_sync_source_healthy(database: &Database, key: &TopicKey) -> Result<()> {
    let connection = database.connection.lock();
    let (source_path, status, last_error): (String, Option<String>, Option<String>) = connection
        .query_row(
            "SELECT t.source_path, hs.status, hs.last_error
             FROM topics t
             LEFT JOIN history_sources hs ON hs.source_path=t.source_path
             WHERE t.owner_type=?1 AND t.owner_id=?2 AND t.topic_id=?3
               AND t.deleted_at IS NULL",
            params![key.owner_type.as_str(), key.owner_id, key.topic_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
    drop(connection);
    if let Some(status) = status {
        anyhow::ensure!(
            status == "ready",
            "history source is not ready for sync: {}",
            last_error.unwrap_or(status)
        );
    } else if Path::new(&source_path).exists() {
        anyhow::bail!("history source exists but has not been ingested");
    }
    Ok(())
}

fn resolve_topic(database: &Database, selector: &TopicSelector) -> Result<TopicKey> {
    let connection = database.connection.lock();
    if let (Some(owner_type), Some(owner_id)) = (selector.owner_type, selector.owner_id.as_deref())
    {
        let exists = connection
            .query_row(
                "SELECT 1 FROM topics
                 WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3
                   AND deleted_at IS NULL",
                params![owner_type.as_str(), owner_id, selector.topic_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        anyhow::ensure!(exists, "topic was not found");
        return Ok(TopicKey {
            owner_type,
            owner_id: owner_id.to_string(),
            topic_id: selector.topic_id.clone(),
        });
    }

    let mut statement = connection.prepare(
        "SELECT owner_type, owner_id FROM topics
         WHERE topic_id=?1 AND deleted_at IS NULL",
    )?;
    let matches = statement
        .query_map([&selector.topic_id], |row| {
            let raw: String = row.get(0)?;
            Ok((
                if raw == "group" {
                    OwnerType::Group
                } else {
                    OwnerType::Agent
                },
                row.get::<_, String>(1)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    match matches.as_slice() {
        [(owner_type, owner_id)] => Ok(TopicKey {
            owner_type: *owner_type,
            owner_id: owner_id.clone(),
            topic_id: selector.topic_id.clone(),
        }),
        [] => anyhow::bail!("topic was not found"),
        _ => anyhow::bail!("topic id is ambiguous; ownerType and ownerId are required"),
    }
}

fn read_history_snapshot(path: &Path) -> Result<(Vec<Value>, Option<String>)> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), None));
        }
        Err(error) => return Err(error).context("failed to read existing history"),
    };
    let history = serde_json::from_slice::<Vec<Value>>(&bytes)
        .context("existing history is invalid or has a non-array root")?;
    Ok((history, Some(sha256_hex(&bytes))))
}

fn write_json_atomic(path: &Path, value: &Value, expected_source_hash: Option<&str>) -> Result<()> {
    let parent = path.parent().context("history path has no parent")?;
    fs::create_dir_all(parent)?;
    let temporary = temporary_path(path);
    let bytes = serde_json::to_vec_pretty(value)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .context("failed to create unique history temporary file")?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(error).context("failed to durably write history temporary file");
    }
    drop(file);

    let current_hash = match fs::read(path) {
        Ok(current) => Some(sha256_hex(&current)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(error).context("failed to revalidate history before commit");
        }
    };
    if current_hash.as_deref() != expected_source_hash {
        let _ = fs::remove_file(&temporary);
        anyhow::bail!("history changed concurrently; retry the sync topic");
    }

    if let Err(error) = atomic_replace(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error).context("failed to atomically replace history");
    }
    sync_parent_directory(parent)?;
    Ok(())
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
    File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> Result<()> {
    Ok(())
}

fn mobile_message_hash_from_json(raw: &str, topic_id: &str) -> Result<String> {
    let value = serde_json::from_str::<Value>(raw).context("stored message JSON is invalid")?;
    let mut warnings = WireWarnings::default();
    let canonical = canonicalize_message(value, topic_id, &mut warnings)?;
    message_fingerprint(&canonical)
}

fn canonical_wire_hash(value: &str) -> Option<String> {
    let normalized = value.to_ascii_lowercase();
    (normalized.len() == 64
        && normalized.bytes().all(|byte| byte.is_ascii_hexdigit())
        && normalized == value)
        .then_some(normalized)
}

fn mobile_owner_config_hash(owner_type: OwnerType, path: &Path) -> Result<String> {
    let root = serde_json::from_slice::<Value>(&fs::read(path)?)
        .with_context(|| format!("invalid owner config {}", path.display()))?;
    let object = root.as_object().context("owner config must be an object")?;
    let mut dto = Map::new();

    match owner_type {
        OwnerType::Agent => {
            insert_defaulted(
                &mut dto,
                object,
                "name",
                Value::String("Unnamed Agent".into()),
            );
            insert_defaulted(
                &mut dto,
                object,
                "systemPrompt",
                Value::String(String::new()),
            );
            insert_defaulted(
                &mut dto,
                object,
                "model",
                Value::String("gemini-2.5-flash".into()),
            );
            insert_defaulted(
                &mut dto,
                object,
                "temperature",
                serde_json::Number::from_f64(1.0)
                    .map(Value::Number)
                    .unwrap_or(Value::Null),
            );
            insert_defaulted(
                &mut dto,
                object,
                "contextTokenLimit",
                Value::Number(1_000_000.into()),
            );
            insert_defaulted(
                &mut dto,
                object,
                "maxOutputTokens",
                Value::Number(64_000.into()),
            );
            insert_defaulted(&mut dto, object, "streamOutput", Value::Bool(true));
        }
        OwnerType::Group => {
            insert_defaulted(
                &mut dto,
                object,
                "name",
                Value::String("Unnamed Group".into()),
            );
            insert_defaulted(&mut dto, object, "members", Value::Array(Vec::new()));
            insert_defaulted(&mut dto, object, "mode", Value::String("sequential".into()));
            insert_defaulted(&mut dto, object, "memberTags", Value::Object(Map::new()));
            insert_defaulted(
                &mut dto,
                object,
                "groupPrompt",
                Value::String(String::new()),
            );
            insert_defaulted(
                &mut dto,
                object,
                "invitePrompt",
                Value::String("现在轮到你{{VCPChatAgentName}}发言了。系统已经为大家添加[xxx的发言：]这样的标记头，以用于区分不同发言来自谁。大家不用自己再输出自己的发言标记头，也不需要讨论发言标记系统，正常聊天即可。".into()),
            );
            insert_defaulted(&mut dto, object, "useUnifiedModel", Value::Bool(false));
            insert_defaulted(
                &mut dto,
                object,
                "unifiedModel",
                Value::String(String::new()),
            );
            insert_defaulted(
                &mut dto,
                object,
                "tagMatchMode",
                Value::String("strict".into()),
            );
            if let Some(value) = object.get("createdAt").filter(|value| !value.is_null()) {
                dto.insert("createdAt".into(), normalize_integer(value));
            }
        }
    }
    Ok(hash_stable_object(&dto))
}

fn mobile_topic_config_hash(key: &TopicKey, metadata: &Value) -> String {
    let source = metadata.as_object().cloned().unwrap_or_default();
    let mut dto = Map::new();
    dto.insert("id".into(), Value::String(key.topic_id.clone()));
    dto.insert(
        "name".into(),
        source.get("name").cloned().unwrap_or(Value::Null),
    );
    dto.insert(
        "createdAt".into(),
        source
            .get("createdAt")
            .map(normalize_integer)
            .unwrap_or(Value::Null),
    );
    if key.owner_type == OwnerType::Agent {
        dto.insert(
            "locked".into(),
            source.get("locked").cloned().unwrap_or(Value::Bool(true)),
        );
        dto.insert(
            "unread".into(),
            source.get("unread").cloned().unwrap_or(Value::Bool(false)),
        );
    }
    hash_stable_object(&dto)
}

fn insert_defaulted(
    target: &mut Map<String, Value>,
    source: &Map<String, Value>,
    key: &str,
    default: Value,
) {
    let value = source
        .get(key)
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or(default);
    target.insert(key.to_string(), value);
}

fn normalize_integer(value: &Value) -> Value {
    match value {
        Value::String(value) => value
            .parse::<i64>()
            .map(|number| Value::Number(number.into()))
            .unwrap_or(Value::Null),
        Value::Number(value) => value
            .as_i64()
            .map(|number| Value::Number(number.into()))
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

fn hash_stable_object(object: &Map<String, Value>) -> String {
    sha256_hex(stable_stringify(&Value::Object(object.clone()), "").as_bytes())
}

fn stable_stringify(value: &Value, key: &str) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) if key == "temperature" => value
            .as_f64()
            .map(|number| {
                if number.fract() == 0.0 {
                    format!("{number:.1}")
                } else {
                    number.to_string()
                }
            })
            .unwrap_or_else(|| value.to_string()),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_default(),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(|value| stable_stringify(value, ""))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        stable_stringify(&object[key], key)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn aggregate_hash(mut hashes: Vec<String>) -> String {
    if hashes.is_empty() {
        return String::new();
    }
    hashes.sort();
    let mut digest = Sha256::new();
    for hash in hashes {
        digest.update(hash.as_bytes());
    }
    hex::encode(digest.finalize())
}

fn unique_manifest_item_by_id<'a>(
    local_by_key: &'a HashMap<String, ManifestItem>,
    id: &str,
) -> Option<&'a ManifestItem> {
    let mut matches = local_by_key.values().filter(|item| item.id == id);
    let first = matches.next();

    // 仅在 Topic ID 跨 Owner 唯一时允许旧协议省略 Owner 上下文。
    // 不使用 bool::then_some(matches[0])：then_some 会立即求值参数，
    // 即使集合为空也会访问下标 0 并导致 Tokio worker panic。
    match (first, matches.next()) {
        (Some(item), None) => Some(item),
        _ => None,
    }
}

fn manifest_key(id: &str, owner_type: Option<OwnerType>, owner_id: Option<&str>) -> String {
    format!(
        "{}:{}:{}",
        owner_type.map_or("", OwnerType::as_str),
        owner_id.unwrap_or_default(),
        id
    )
}

fn manifest_action(
    remote: &RemoteManifestItem,
    action: &str,
    deleted_at: Option<i64>,
    mismatched_content: bool,
) -> ManifestAction {
    ManifestAction {
        id: remote.id.clone(),
        action: action.to_string(),
        deleted_at,
        owner_type: remote.owner_type,
        owner_id: remote.owner_id.clone(),
        mismatched_content,
    }
}

const fn is_false(value: &bool) -> bool {
    !*value
}

const fn is_zero(value: &usize) -> bool {
    *value == 0
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, fs, sync::Arc};

    use super::{
        aggregate_hash, message_manifest, pull_topic_messages, push_messages, topic_hash_diff,
        topic_identity, unique_manifest_item_by_id, validate_manifest_request, ManifestItem,
        ManifestRequest, MessagesPullTopic, MessagesPushRequest, MessagesPushTopic,
        RemoteManifestItem, TopicHashDiffRequest, TopicHashState, TopicSelector,
    };
    use crate::{
        config::{Cli, ServiceConfig},
        domain::OwnerType,
        ingest::Reconciler,
        storage::Database,
        sync_wire::{canonicalize_message, message_fingerprint, WireWarnings},
    };
    use serde_json::json;
    use tempfile::TempDir;

    fn sync_fixture() -> (TempDir, Arc<ServiceConfig>, Database, Reconciler) {
        let temp = TempDir::new().expect("create temp directory");
        let app_data = temp.path().join("AppData");
        fs::create_dir_all(app_data.join("Agents/agent-a")).expect("create agent");
        fs::create_dir_all(app_data.join("AgentGroups")).expect("create groups");
        fs::create_dir_all(app_data.join("UserData/agent-a/topics/topic-a"))
            .expect("create history directory");
        fs::write(
            app_data.join("Agents/agent-a/config.json"),
            serde_json::to_vec(&json!({
                "name": "Agent A",
                "topics": [{"id":"topic-a","name":"Topic A","createdAt":1}]
            }))
            .expect("serialize config"),
        )
        .expect("write config");
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

    fn manifest_item(id: &str, owner_type: OwnerType, owner_id: &str) -> ManifestItem {
        ManifestItem {
            id: id.to_string(),
            hash: String::new(),
            config_hash: String::new(),
            content_hash: String::new(),
            ts: 0,
            deleted_at: None,
            owner_type: Some(owner_type),
            owner_id: Some(owner_id.to_string()),
        }
    }

    #[test]
    fn legacy_manifest_lookup_handles_zero_matches_without_panicking() {
        let items = HashMap::new();
        assert!(unique_manifest_item_by_id(&items, "missing-topic").is_none());
    }

    #[test]
    fn legacy_manifest_lookup_accepts_one_ownerless_match() {
        let mut items = HashMap::new();
        items.insert(
            "agent:agent-1:topic-1".to_string(),
            manifest_item("topic-1", OwnerType::Agent, "agent-1"),
        );

        let found = unique_manifest_item_by_id(&items, "topic-1").expect("unique topic");
        assert_eq!(found.owner_id.as_deref(), Some("agent-1"));
    }

    #[test]
    fn legacy_manifest_lookup_rejects_ambiguous_cross_owner_topic_id() {
        let mut items = HashMap::new();
        items.insert(
            "agent:agent-1:shared-topic".to_string(),
            manifest_item("shared-topic", OwnerType::Agent, "agent-1"),
        );
        items.insert(
            "group:group-1:shared-topic".to_string(),
            manifest_item("shared-topic", OwnerType::Group, "group-1"),
        );

        assert!(unique_manifest_item_by_id(&items, "shared-topic").is_none());
    }

    #[test]
    fn mobile_fingerprint_matches_content_only_contract() {
        let value = json!({"id":"m1","content":"hello"});
        let mut value = value;
        value["role"] = json!("user");
        value["timestamp"] = json!(1);
        let mut warnings = WireWarnings::default();
        let canonical = canonicalize_message(value, "topic", &mut warnings).expect("canonical");
        let hash = message_fingerprint(&canonical).expect("hash");
        assert_eq!(
            hash,
            "20b2dda940d741d9780897200aaef2ef356ab32b38c7de0d94306fb5a66b4a8e"
        );
    }

    #[test]
    fn aggregate_hash_is_order_independent() {
        assert_eq!(
            aggregate_hash(vec!["b".to_string(), "a".to_string()]),
            aggregate_hash(vec!["a".to_string(), "b".to_string()])
        );
    }

    #[test]
    fn manifest_requires_exact_topic_owner_and_safe_wire_fields() {
        let hash = "a".repeat(64);
        let valid = ManifestRequest {
            data_type: "topic".to_string(),
            data: vec![RemoteManifestItem {
                id: "topic-a".to_string(),
                hash: hash.clone(),
                config_hash: Some(hash),
                content_hash: Some(String::new()),
                ts: 1,
                deleted_at: Some(0),
                owner_type: Some(OwnerType::Agent),
                owner_id: Some("agent-a".to_string()),
            }],
            targeted_owners: Some(vec!["agent-a".to_string()]),
        };
        validate_manifest_request(&valid).expect("valid topic manifest");

        let mut missing_owner = valid.clone();
        missing_owner.data[0].owner_id = None;
        assert!(validate_manifest_request(&missing_owner)
            .expect_err("missing owner must fail")
            .to_string()
            .contains("ownerId"));

        let mut unsafe_timestamp = valid;
        unsafe_timestamp.data[0].ts = (1_i64 << 53) + 1;
        assert!(validate_manifest_request(&unsafe_timestamp)
            .expect_err("unsafe timestamp must fail")
            .to_string()
            .contains("safe integer"));
    }

    #[test]
    fn topic_hash_diff_rejects_duplicate_and_malformed_states_before_db_work() {
        let (_temp, _config, database, _reconciler) = sync_fixture();
        let duplicate = topic_hash_diff(
            &database,
            TopicHashDiffRequest {
                hashes: HashMap::from([(
                    "topic-a".to_string(),
                    json!({"configHash":"", "contentHash":""}),
                )]),
                topics: vec![TopicHashState {
                    topic_id: "topic-a".to_string(),
                    owner_type: Some(OwnerType::Agent),
                    owner_id: Some("agent-a".to_string()),
                    config_hash: String::new(),
                    content_hash: String::new(),
                }],
            },
        )
        .expect_err("duplicate topic state must fail");
        assert!(duplicate.to_string().contains("duplicate topic"));

        let malformed = topic_hash_diff(
            &database,
            TopicHashDiffRequest {
                hashes: HashMap::from([(
                    "topic-a".to_string(),
                    json!({"configHash":1, "contentHash":""}),
                )]),
                topics: Vec::new(),
            },
        )
        .expect_err("malformed topic hash must fail");
        assert!(malformed
            .to_string()
            .contains("configHash must be a string"));
    }

    #[tokio::test]
    async fn ingest_pull_canonicalize_push_round_trip_is_sync_only_and_strict() {
        let (_temp, config, database, reconciler) = sync_fixture();
        let valid_hash = "A".repeat(64);
        let history_path = config
            .user_data_dir
            .join("agent-a/topics/topic-a/history.json");
        fs::write(
            &history_path,
            serde_json::to_vec_pretty(&json!([
                {
                    "id":"m1",
                    "role":"user",
                    "content":"legacy",
                    "timestamp":"1",
                    "attachments":[{
                        "type":"text/plain",
                        "name":"legacy.txt",
                        "size":3,
                        "src":"file:///desktop/private",
                        "_fileManagerData":{
                            "hash":valid_hash,
                            "internalPath":"file:///desktop/private"
                        }
                    }]
                },
                {
                    "id":"m2",
                    "role":"assistant",
                    "content":"keep message, omit bad attachment",
                    "timestamp":2,
                    "attachments":[{"type":"text/plain","name":"bad.txt","size":1}]
                }
            ]))
            .expect("serialize history"),
        )
        .expect("write history");
        reconciler.reconcile().await.expect("reconcile history");

        let frame = pull_topic_messages(
            &database,
            MessagesPullTopic {
                topic_id: "topic-a".to_string(),
                owner_type: None,
                owner_id: None,
                msg_ids: Vec::new(),
            },
        )
        .expect("pull canonical frame");
        assert_eq!(frame.owner_type, OwnerType::Agent);
        assert_eq!(frame.owner_id, "agent-a");
        assert_eq!(frame.legacy_attachment_warnings, 1);
        assert_eq!(frame.messages.len(), 2);
        assert_eq!(frame.messages[0]["attachments"][0]["hash"], "a".repeat(64));
        assert!(frame.messages[0]["attachments"][0]
            .get("_fileManagerData")
            .is_none());
        assert!(frame.messages[1].get("attachments").is_none());

        let response = push_messages(
            &reconciler,
            MessagesPushRequest {
                topics: vec![MessagesPushTopic {
                    topic_id: "topic-a".to_string(),
                    owner_type: Some(OwnerType::Agent),
                    owner_id: Some("agent-a".to_string()),
                    messages: vec![json!({
                        "id":"m3",
                        "role":"user",
                        "content":"projected native",
                        "timestamp":3,
                        "attachments":[{
                            "type":"text/plain",
                            "src":"file:///actual/app-data/attachment.txt",
                            "name":"attachment.txt",
                            "size":1,
                            "_fileManagerData":{
                                "hash":"b".repeat(64),
                                "internalPath":"file:///actual/app-data/attachment.txt"
                            }
                        }]
                    })],
                    deleted_message_ids: Vec::new(),
                    deleted_message_tombstones: Vec::new(),
                }],
            },
        )
        .await;
        assert!(response.results[0].success);
        assert!(response.results[0].needed_attachment_hashes.is_empty());
        let persisted: Vec<serde_json::Value> =
            serde_json::from_slice(&fs::read(&history_path).expect("read history"))
                .expect("parse history");
        assert_eq!(persisted.len(), 3);
        assert_eq!(
            persisted[2]["attachments"][0]["_fileManagerData"]["hash"],
            "b".repeat(64)
        );

        let manifest = message_manifest(
            &database,
            &TopicSelector {
                topic_id: "topic-a".to_string(),
                owner_type: Some(OwnerType::Agent),
                owner_id: Some("agent-a".to_string()),
            },
        )
        .expect("message manifest after push");
        assert_eq!(manifest.messages.len(), 3);
        assert!(manifest
            .messages
            .iter()
            .all(|message| message.content_hash.len() == 64));
    }

    #[tokio::test]
    async fn explicit_message_tombstones_preserve_wire_time_and_cover_absent_rows() {
        let (_temp, config, database, reconciler) = sync_fixture();
        let history_path = config
            .user_data_dir
            .join("agent-a/topics/topic-a/history.json");
        fs::write(
            &history_path,
            br#"[{"id":"m1","role":"user","content":"delete me","timestamp":1}]"#,
        )
        .expect("write initial history");
        reconciler.reconcile().await.expect("initial reconcile");

        let delete = |m1_deleted_at, missing_deleted_at| MessagesPushRequest {
            topics: vec![MessagesPushTopic {
                topic_id: "topic-a".to_string(),
                owner_type: Some(OwnerType::Agent),
                owner_id: Some("agent-a".to_string()),
                messages: Vec::new(),
                deleted_message_ids: Vec::new(),
                deleted_message_tombstones: vec![
                    super::MessageTombstoneInput {
                        msg_id: "m1".to_string(),
                        deleted_at: m1_deleted_at,
                    },
                    super::MessageTombstoneInput {
                        msg_id: "never-seen".to_string(),
                        deleted_at: missing_deleted_at,
                    },
                ],
            }],
        };

        let first = push_messages(&reconciler, delete(42, 43)).await;
        assert!(first.results[0].success);
        assert!(first.results[0].changed);
        let persisted: Vec<serde_json::Value> =
            serde_json::from_slice(&fs::read(&history_path).expect("read history"))
                .expect("parse history");
        assert!(persisted.is_empty());

        let tombstone_times = {
            let connection = database.connection.lock();
            let mut statement = connection
                .prepare(
                    "SELECT entity_id, deleted_at FROM tombstones
                     WHERE entity_type='message' AND owner_type='agent'
                       AND owner_id='agent-a' AND topic_id='topic-a'
                     ORDER BY entity_id",
                )
                .expect("prepare tombstone query");
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .expect("query tombstones")
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("collect tombstones")
        };
        assert_eq!(
            tombstone_times,
            vec![("m1".to_string(), 42), ("never-seen".to_string(), 43)]
        );

        let replay = push_messages(&reconciler, delete(99, 100)).await;
        assert!(replay.results[0].success);
        assert!(!replay.results[0].changed);
        let replay_times = {
            let connection = database.connection.lock();
            let mut statement = connection
                .prepare(
                    "SELECT entity_id, deleted_at FROM tombstones
                     WHERE entity_type='message' AND owner_type='agent'
                       AND owner_id='agent-a' AND topic_id='topic-a'
                     ORDER BY entity_id",
                )
                .expect("prepare replay query");
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .expect("query replay tombstones")
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("collect replay tombstones")
        };
        assert_eq!(replay_times, tombstone_times);
    }

    #[tokio::test]
    async fn invalid_history_source_is_never_served_from_stale_sqlite() {
        let (_temp, config, database, reconciler) = sync_fixture();
        let history_path = config
            .user_data_dir
            .join("agent-a/topics/topic-a/history.json");
        fs::write(
            &history_path,
            br#"[{"id":"m1","role":"user","content":"valid","timestamp":1}]"#,
        )
        .expect("write valid history");
        reconciler.reconcile().await.expect("initial reconcile");
        fs::write(&history_path, b"{").expect("corrupt history");
        let stats = reconciler
            .reconcile()
            .await
            .expect("invalid reconcile completes");
        assert_eq!(stats.files_invalid, 1);

        let error = pull_topic_messages(
            &database,
            MessagesPullTopic {
                topic_id: "topic-a".to_string(),
                owner_type: None,
                owner_id: None,
                msg_ids: Vec::new(),
            },
        )
        .expect_err("invalid source must fail closed");
        assert!(error.to_string().contains("history source is not ready"));
    }

    #[tokio::test]
    async fn topic_identity_rejects_cross_owner_ambiguity() {
        let (_temp, config, database, reconciler) = sync_fixture();
        fs::create_dir_all(config.groups_dir.join("group-a")).expect("create group");
        fs::create_dir_all(config.user_data_dir.join("group-a/topics/topic-a"))
            .expect("create group history");
        fs::write(
            config.groups_dir.join("group-a/config.json"),
            serde_json::to_vec(&json!({
                "id":"group-a",
                "name":"Group A",
                "topics":[{"id":"topic-a","name":"Shared","createdAt":1}]
            }))
            .expect("serialize group"),
        )
        .expect("write group");
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-a/history.json"),
            b"[]",
        )
        .expect("write agent history");
        fs::write(
            config
                .user_data_dir
                .join("group-a/topics/topic-a/history.json"),
            b"[]",
        )
        .expect("write group history");
        reconciler.reconcile().await.expect("reconcile owners");

        assert!(topic_identity(
            &database,
            &TopicSelector {
                topic_id: "topic-a".to_string(),
                owner_type: None,
                owner_id: None,
            }
        )
        .is_err());
        let identity = topic_identity(
            &database,
            &TopicSelector {
                topic_id: "topic-a".to_string(),
                owner_type: Some(OwnerType::Group),
                owner_id: Some("group-a".to_string()),
            },
        )
        .expect("resolve compound identity");
        assert_eq!(identity.owner_type, OwnerType::Group);
        assert_eq!(identity.owner_id, "group-a");
    }
}
