use std::{
    collections::{HashMap, HashSet},
    fs,
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
    storage::{now_ms, Database, IngestCommit},
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestRequest {
    pub data_type: String,
    #[serde(default)]
    pub data: Vec<RemoteManifestItem>,
    #[serde(default)]
    pub targeted_owners: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteManifestItem {
    pub id: String,
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub config_hash: Option<String>,
    #[serde(default)]
    pub content_hash: Option<String>,
    #[serde(default)]
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
    pub to_pull: Vec<String>,
    pub to_push: bool,
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagesPushResult {
    pub topic_id: String,
    pub success: bool,
    pub changed: bool,
    pub revision: Option<i64>,
    pub message_count: usize,
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

pub fn manifest(database: &Database, request: ManifestRequest) -> Result<ManifestResponse> {
    let local = local_manifest(
        database,
        &request.data_type,
        request.targeted_owners.as_deref(),
    )?;
    let mut local_by_key = HashMap::new();
    for item in local {
        local_by_key.insert(
            manifest_key(&item.id, item.owner_type, item.owner_id.as_deref()),
            item,
        );
    }

    let mut actions = Vec::new();
    let mut processed = HashSet::new();
    for remote in &request.data {
        let key = manifest_key(&remote.id, remote.owner_type, remote.owner_id.as_deref());
        let local = local_by_key
            .get(&key)
            .or_else(|| unique_manifest_item_by_id(&local_by_key, &remote.id));
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
    let messages = statement
        .query_map(
            params![key.owner_type.as_str(), key.owner_id, key.topic_id],
            |row| {
                let metadata: String = row.get(1)?;
                Ok(MessageManifestItem {
                    msg_id: row.get(0)?,
                    content_hash: mobile_message_hash_from_json(&metadata),
                    updated_at: row.get(2)?,
                    deleted_at: row.get(3)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(MessageManifestResponse {
        response_type: "MESSAGE_MANIFEST_RESULTS",
        topic_id: key.topic_id,
        owner_type: key.owner_type,
        owner_id: key.owner_id,
        messages,
    })
}

pub fn topic_hash_diff(
    database: &Database,
    request: TopicHashDiffRequest,
) -> Result<TopicHashDiffResponse> {
    let mut states = request.topics;
    for (topic_id, value) in request.hashes {
        let (config_hash, content_hash) = if let Some(object) = value.as_object() {
            (
                string_field(object, "configHash"),
                string_field(object, "contentHash"),
            )
        } else {
            (
                String::new(),
                value.as_str().unwrap_or_default().to_string(),
            )
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

    Ok(TopicHashDiffResponse {
        response_type: "SYNC_TOPIC_HASH_RESULTS",
        changed_topics,
    })
}

pub fn message_diff(
    database: &Database,
    request: MessageDiffRequest,
) -> Result<MessageDiffResponse> {
    let mut results = HashMap::new();
    for (topic_id, state) in request.topics {
        let selector = TopicSelector {
            topic_id: topic_id.clone(),
            owner_type: state.owner_type,
            owner_id: state.owner_id,
        };
        let Ok(key) = resolve_topic(database, &selector) else {
            results.insert(
                topic_id,
                MessageDiffResult {
                    to_pull: Vec::new(),
                    to_push: !state.messages.is_empty(),
                },
            );
            continue;
        };

        let local_topic = topic_manifest(database, &key)?;
        if !state.topic_hash.is_empty() && state.topic_hash == local_topic.content_hash {
            results.insert(
                topic_id,
                MessageDiffResult {
                    to_pull: Vec::new(),
                    to_push: false,
                },
            );
            continue;
        }

        let manifest = message_manifest(database, &selector)?;
        let active = manifest
            .messages
            .into_iter()
            .filter(|item| item.deleted_at.is_none())
            .map(|item| (item.msg_id, item.content_hash))
            .collect::<HashMap<_, _>>();
        let to_pull = active
            .iter()
            .filter_map(|(id, hash)| {
                let remote = state.messages.get(id);
                (remote.is_none()
                    || remote.is_some_and(|value| value != hash && value != "DELETED"))
                .then_some(id.clone())
            })
            .collect();
        let to_push = state
            .messages
            .iter()
            .any(|(id, hash)| hash != "DELETED" && !active.contains_key(id));
        results.insert(topic_id, MessageDiffResult { to_pull, to_push });
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
        let selector = TopicSelector {
            topic_id: topic.topic_id.clone(),
            owner_type: topic.owner_type,
            owner_id: topic.owner_id,
        };
        let key = resolve_topic(database, &selector)?;
        let wanted = topic.msg_ids.into_iter().collect::<HashSet<_>>();
        let connection = database.connection.lock();
        let mut statement = connection.prepare(
            "SELECT metadata_json FROM messages
             WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3 AND deleted_at IS NULL
             ORDER BY ordinal ASC",
        )?;
        let messages = statement
            .query_map(
                params![key.owner_type.as_str(), key.owner_id, key.topic_id],
                |row| row.get::<_, String>(0),
            )?
            .filter_map(|result| {
                let raw = result.ok()?;
                let mut message = serde_json::from_str::<Value>(&raw).ok()?;
                let id = message
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !wanted.is_empty() && !wanted.contains(id) {
                    return None;
                }
                if let Some(object) = message.as_object_mut() {
                    object.insert(
                        "contentHash".to_string(),
                        Value::String(mobile_message_hash(object)),
                    );
                }
                Some(message)
            })
            .collect();
        frames.push(MessagesPullFrame {
            topic_id: key.topic_id,
            owner_type: key.owner_type,
            owner_id: key.owner_id,
            messages,
        });
    }
    Ok(frames)
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
                error: None,
            },
            Err(error) => MessagesPushResult {
                topic_id: topic.topic_id,
                success: false,
                changed: false,
                revision: None,
                message_count: 0,
                error: Some(format!("{error:#}")),
            },
        });
    }
    MessagesPushResponse { results }
}

async fn push_topic(reconciler: &Reconciler, topic: &MessagesPushTopic) -> Result<IngestCommit> {
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

    let mut current = read_history_or_empty(&history_path)?;
    let deleted = topic
        .deleted_message_ids
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
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

    write_json_atomic(&history_path, &Value::Array(current))?;
    reconciler
        .ingest_path(&history_path, "mobile_sync")
        .await?
        .context("projected history path was not accepted by CDS")
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
    let connection = database.connection.lock();
    let mut statement = connection.prepare(
        "SELECT metadata_json FROM messages
         WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3 AND deleted_at IS NULL",
    )?;
    let hashes = statement
        .query_map(
            params![key.owner_type.as_str(), key.owner_id, key.topic_id],
            |row| {
                let raw: String = row.get(0)?;
                Ok(mobile_message_hash_from_json(&raw))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(aggregate_hash(hashes))
}

fn resolve_topic(database: &Database, selector: &TopicSelector) -> Result<TopicKey> {
    let connection = database.connection.lock();
    if let (Some(owner_type), Some(owner_id)) = (selector.owner_type, selector.owner_id.as_deref())
    {
        let exists = connection
            .query_row(
                "SELECT 1 FROM topics
                 WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3",
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

fn read_history_or_empty(path: &Path) -> Result<Vec<Value>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(path)?;
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_slice::<Vec<Value>>(&bytes).context("existing history is invalid")
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<()> {
    let parent = path.parent().context("history path has no parent")?;
    fs::create_dir_all(parent)?;
    let temporary = temporary_path(path);
    fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(&temporary, path)?;
    Ok(())
}

fn temporary_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("history.json");
    path.with_file_name(format!("{name}.cds-{}.tmp", now_ms()))
}

fn mobile_message_hash_from_json(raw: &str) -> String {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .map_or_else(String::new, |object| mobile_message_hash(&object))
}

fn mobile_message_hash(message: &Map<String, Value>) -> String {
    let content = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut attachment_hashes = message
        .get("attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|attachment| {
            attachment
                .get("hash")
                .and_then(Value::as_str)
                .or_else(|| {
                    attachment
                        .get("_fileManagerData")
                        .and_then(|data| data.get("hash"))
                        .and_then(Value::as_str)
                })
                .filter(|hash| !hash.is_empty())
                .map(ToString::to_string)
        })
        .collect::<Vec<_>>();
    attachment_hashes.sort();

    let canonical = if attachment_hashes.is_empty() {
        format!(
            r#"{{"content":{}}}"#,
            serde_json::to_string(content).unwrap_or_default()
        )
    } else {
        format!(
            r#"{{"attachmentHashes":{},"content":{}}}"#,
            serde_json::to_string(&attachment_hashes).unwrap_or_default(),
            serde_json::to_string(content).unwrap_or_default()
        )
    };
    sha256_hex(canonical.as_bytes())
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

fn string_field(object: &Map<String, Value>, key: &str) -> String {
    object
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

const fn is_false(value: &bool) -> bool {
    !*value
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{aggregate_hash, mobile_message_hash, unique_manifest_item_by_id, ManifestItem};
    use crate::domain::OwnerType;
    use serde_json::json;

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
        let hash = mobile_message_hash(value.as_object().expect("object"));
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
}
