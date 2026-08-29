use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::Path,
};

use anyhow::{Context, Result};
use rusqlite::{params, params_from_iter, types::Value as SqlValue, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    domain::{AvatarKey, AvatarOwnerType, OwnerKey, OwnerType, TopicKey, TopicSource},
    ingest::{
        normalize_history_values, sha256_hex, write_history_atomic, Reconciler, SnapshotStale,
    },
    storage::{Database, IngestCommit, OwnerHashMode},
    sync_wire::{canonicalize_message, unhealthy_topic_sentinel_hash, WireWarnings},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManifestType {
    Owner,
    Topic,
    Avatar,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "manifestType", rename_all = "lowercase", deny_unknown_fields)]
pub enum ManifestRequest {
    Owner {
        items: Vec<OwnerManifestState>,
    },
    Topic {
        items: Vec<TopicManifestState>,
        #[serde(rename = "targetedOwners")]
        targeted_owners: Vec<OwnerKey>,
    },
    Avatar {
        items: Vec<AvatarManifestState>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum OwnerManifestState {
    Live(OwnerManifestLive),
    Deleted(OwnerManifestDeleted),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerManifestLive {
    owner_type: OwnerType,
    owner_id: String,
    config_hash: String,
    content_hash: String,
    updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerManifestDeleted {
    owner_type: OwnerType,
    owner_id: String,
    deleted_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum TopicManifestState {
    Live(TopicManifestLive),
    Deleted(TopicManifestDeleted),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TopicManifestLive {
    owner_type: OwnerType,
    owner_id: String,
    topic_id: String,
    config_hash: String,
    content_hash: String,
    updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TopicManifestDeleted {
    owner_type: OwnerType,
    owner_id: String,
    topic_id: String,
    deleted_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum AvatarManifestState {
    Live(AvatarManifestLive),
    Deleted(AvatarManifestDeleted),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AvatarManifestLive {
    owner_type: AvatarOwnerType,
    owner_id: String,
    binary_hash: String,
    updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AvatarManifestDeleted {
    owner_type: AvatarOwnerType,
    owner_id: String,
    deleted_at: i64,
}

#[derive(Debug, Clone)]
enum ManifestIdentity {
    Owner(OwnerKey),
    Topic(TopicKey),
    Avatar(AvatarKey),
}

#[derive(Debug, Clone)]
struct ManifestItem {
    identity: ManifestIdentity,
    config_hash: String,
    content_hash: String,
    updated_at: i64,
    deleted_at: Option<i64>,
}

#[derive(Debug, Clone)]
struct TopicManifestRow {
    key: TopicKey,
    config_hash: String,
    content_hash: String,
    updated_at: i64,
    deleted_at: Option<i64>,
    source_path: String,
    source_status: Option<String>,
    source_error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum ManifestActionKind {
    Pull,
    Push,
    PullDelete,
    PushDelete,
    Skip,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerManifestDecision {
    owner_type: OwnerType,
    owner_id: String,
    action: ManifestActionKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    deleted_at: Option<i64>,
    #[serde(skip_serializing_if = "is_false")]
    content_hash_mismatch: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicManifestDecision {
    owner_type: OwnerType,
    owner_id: String,
    topic_id: String,
    action: ManifestActionKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarManifestDecision {
    owner_type: AvatarOwnerType,
    owner_id: String,
    action: ManifestActionKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "manifestType", rename_all = "lowercase")]
pub enum ManifestResponse {
    Owner {
        #[serde(rename = "type")]
        response_type: &'static str,
        results: Vec<OwnerManifestDecision>,
    },
    Topic {
        #[serde(rename = "type")]
        response_type: &'static str,
        results: Vec<TopicManifestDecision>,
    },
    Avatar {
        #[serde(rename = "type")]
        response_type: &'static str,
        results: Vec<AvatarManifestDecision>,
    },
}

#[derive(Debug, Clone)]
struct IndexedMessageState {
    msg_id: String,
    message_hash: Option<String>,
    updated_at: i64,
    deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TopicDiffRequest {
    pub topics: Vec<TopicDiffState>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TopicDiffState {
    pub topic_id: String,
    pub owner_type: OwnerType,
    pub owner_id: String,
    pub config_hash: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicDiffResponse {
    #[serde(rename = "type")]
    pub response_type: &'static str,
    pub changed_topics: Vec<TopicKey>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageDiffRequest {
    pub topics: Vec<MessageDiffState>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageDiffState {
    pub topic_id: String,
    pub owner_type: OwnerType,
    pub owner_id: String,
    pub content_hash: String,
    pub messages: HashMap<String, MessageVersionState>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum MessageVersionState {
    Live(MessageLiveState),
    Deleted(MessageDeletedState),
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageLiveState {
    pub message_hash: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageDeletedState {
    pub deleted_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum MessageDiffResult {
    Success(MessageDiffSuccess),
    Failure(MessageDiffFailure),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDiffSuccess {
    pub topic_id: String,
    pub owner_type: OwnerType,
    pub owner_id: String,
    pub ok: bool,
    pub pull_message_ids: Vec<String>,
    pub push_topic: bool,
    pub delete_messages: Vec<MessageDeleteAction>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDiffFailure {
    pub topic_id: String,
    pub owner_type: OwnerType,
    pub owner_id: String,
    pub ok: bool,
    pub error: SyncItemError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDeleteAction {
    pub msg_id: String,
    pub deleted_at: i64,
}

impl MessageDiffResult {
    fn success(
        topic: &TopicKey,
        pull_message_ids: Vec<String>,
        push_topic: bool,
        delete_messages: Vec<MessageDeleteAction>,
    ) -> Self {
        Self::Success(MessageDiffSuccess {
            topic_id: topic.topic_id.clone(),
            owner_type: topic.owner_type,
            owner_id: topic.owner_id.clone(),
            ok: true,
            pull_message_ids,
            push_topic,
            delete_messages,
        })
    }

    fn failure(topic: &TopicKey, code: &str, message: impl Into<String>) -> Self {
        Self::Failure(MessageDiffFailure {
            topic_id: topic.topic_id.clone(),
            owner_type: topic.owner_type,
            owner_id: topic.owner_id.clone(),
            ok: false,
            error: SyncItemError {
                code: code.to_string(),
                message: message.into(),
                retryable: false,
            },
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncItemError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDiffResponse {
    #[serde(rename = "type")]
    pub response_type: &'static str,
    pub results: Vec<MessageDiffResult>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessagesPullRequest {
    pub topics: Vec<MessagesPullTopic>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessagesPullTopic {
    pub topic_id: String,
    pub owner_type: OwnerType,
    pub owner_id: String,
    #[serde(default)]
    pub message_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagesPullFrame {
    pub kind: &'static str,
    pub topic_id: String,
    pub owner_type: OwnerType,
    pub owner_id: String,
    pub ok: bool,
    pub messages: Vec<Value>,
    #[serde(skip_serializing_if = "is_zero")]
    pub legacy_attachment_warnings: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warning_samples: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntitiesPullRequest {
    pub items: Vec<EntityPullItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "entityType",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EntityPullItem {
    Owner {
        owner_type: OwnerType,
        owner_id: String,
    },
    Topic {
        owner_type: OwnerType,
        owner_id: String,
        topic_id: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "entityType",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum EntityPullResult {
    Owner {
        owner_type: OwnerType,
        owner_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<SyncItemError>,
    },
    Topic {
        owner_type: OwnerType,
        owner_id: String,
        topic_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<SyncItemError>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitiesPullResponse {
    pub results: Vec<EntityPullResult>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessagesPushTopic {
    pub topic_id: String,
    pub owner_type: OwnerType,
    pub owner_id: String,
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub deleted_messages: Vec<MessageTombstoneInput>,
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
    pub owner_type: OwnerType,
    pub owner_id: String,
    pub ok: bool,
    #[serde(skip)]
    pub ingest_commit: Option<IngestCommit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SyncItemError>,
}

const MAX_SYNC_ITEMS: usize = 10_000;
const MAX_SAFE_JSON_INTEGER: i64 = (1_i64 << 53) - 1;
fn is_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

struct NormalizedManifestRequest {
    manifest_type: ManifestType,
    items: Vec<ManifestItem>,
    targeted_owners: Option<Vec<OwnerKey>>,
}

#[derive(Debug, Clone)]
struct ManifestDecision {
    identity: ManifestIdentity,
    action: ManifestActionKind,
    deleted_at: Option<i64>,
    content_hash_mismatch: bool,
}

fn validate_manifest_time(value: i64, label: &str) -> Result<i64> {
    anyhow::ensure!(
        (0..=MAX_SAFE_JSON_INTEGER).contains(&value),
        "{label} must be a non-negative safe integer"
    );
    Ok(value)
}

fn validate_owner_key(key: &OwnerKey) -> Result<()> {
    anyhow::ensure!(!key.owner_id.is_empty(), "ownerId must not be empty");
    Ok(())
}

fn validate_topic_key(key: &TopicKey) -> Result<()> {
    validate_owner_key(&OwnerKey {
        owner_type: key.owner_type,
        owner_id: key.owner_id.clone(),
    })?;
    anyhow::ensure!(!key.topic_id.is_empty(), "topicId must not be empty");
    Ok(())
}

fn validate_avatar_key(key: &AvatarKey) -> Result<()> {
    AvatarKey::from_wire_id(&format!("{}:{}", key.owner_type, key.owner_id))?;
    Ok(())
}

fn normalize_manifest_request(request: ManifestRequest) -> Result<NormalizedManifestRequest> {
    let (manifest_type, items, targeted_owners) = match request {
        ManifestRequest::Owner { items } => {
            let items = items
                .into_iter()
                .map(|state| match state {
                    OwnerManifestState::Live(item) => {
                        let key = OwnerKey {
                            owner_type: item.owner_type,
                            owner_id: item.owner_id,
                        };
                        validate_owner_key(&key)?;
                        anyhow::ensure!(
                            is_lower_sha256(&item.config_hash),
                            "owner configHash must be lowercase SHA-256"
                        );
                        anyhow::ensure!(
                            item.content_hash.is_empty() || is_lower_sha256(&item.content_hash),
                            "owner contentHash must be empty or lowercase SHA-256"
                        );
                        Ok(ManifestItem {
                            identity: ManifestIdentity::Owner(key),
                            config_hash: item.config_hash,
                            content_hash: item.content_hash,
                            updated_at: validate_manifest_time(item.updated_at, "updatedAt")?,
                            deleted_at: None,
                        })
                    }
                    OwnerManifestState::Deleted(item) => {
                        let key = OwnerKey {
                            owner_type: item.owner_type,
                            owner_id: item.owner_id,
                        };
                        validate_owner_key(&key)?;
                        Ok(ManifestItem {
                            identity: ManifestIdentity::Owner(key),
                            config_hash: String::new(),
                            content_hash: String::new(),
                            updated_at: 0,
                            deleted_at: Some(validate_manifest_time(item.deleted_at, "deletedAt")?),
                        })
                    }
                })
                .collect::<Result<Vec<_>>>()?;
            (ManifestType::Owner, items, None)
        }
        ManifestRequest::Topic {
            items,
            targeted_owners,
        } => {
            anyhow::ensure!(
                targeted_owners.len() <= MAX_SYNC_ITEMS,
                "targetedOwners exceeds {MAX_SYNC_ITEMS} items"
            );
            let owner_set = targeted_owners.iter().cloned().collect::<HashSet<_>>();
            anyhow::ensure!(
                owner_set.len() == targeted_owners.len(),
                "targetedOwners contains a duplicate owner identity"
            );
            for owner in &targeted_owners {
                validate_owner_key(owner)?;
            }
            let items = items
                .into_iter()
                .map(|state| match state {
                    TopicManifestState::Live(item) => {
                        let key = TopicKey {
                            owner_type: item.owner_type,
                            owner_id: item.owner_id,
                            topic_id: item.topic_id,
                        };
                        validate_topic_key(&key)?;
                        anyhow::ensure!(
                            owner_set.contains(&OwnerKey {
                                owner_type: key.owner_type,
                                owner_id: key.owner_id.clone(),
                            }),
                            "topic manifest item has an unexpected owner"
                        );
                        anyhow::ensure!(
                            is_lower_sha256(&item.config_hash),
                            "topic configHash must be lowercase SHA-256"
                        );
                        anyhow::ensure!(
                            item.content_hash.is_empty() || is_lower_sha256(&item.content_hash),
                            "topic contentHash must be empty or lowercase SHA-256"
                        );
                        Ok(ManifestItem {
                            identity: ManifestIdentity::Topic(key),
                            config_hash: item.config_hash,
                            content_hash: item.content_hash,
                            updated_at: validate_manifest_time(item.updated_at, "updatedAt")?,
                            deleted_at: None,
                        })
                    }
                    TopicManifestState::Deleted(item) => {
                        let key = TopicKey {
                            owner_type: item.owner_type,
                            owner_id: item.owner_id,
                            topic_id: item.topic_id,
                        };
                        validate_topic_key(&key)?;
                        anyhow::ensure!(
                            owner_set.contains(&OwnerKey {
                                owner_type: key.owner_type,
                                owner_id: key.owner_id.clone(),
                            }),
                            "topic manifest item has an unexpected owner"
                        );
                        Ok(ManifestItem {
                            identity: ManifestIdentity::Topic(key),
                            config_hash: String::new(),
                            content_hash: String::new(),
                            updated_at: 0,
                            deleted_at: Some(validate_manifest_time(item.deleted_at, "deletedAt")?),
                        })
                    }
                })
                .collect::<Result<Vec<_>>>()?;
            (ManifestType::Topic, items, Some(targeted_owners))
        }
        ManifestRequest::Avatar { items } => {
            let items = items
                .into_iter()
                .map(|state| match state {
                    AvatarManifestState::Live(item) => {
                        let key = AvatarKey {
                            owner_type: item.owner_type,
                            owner_id: item.owner_id,
                        };
                        validate_avatar_key(&key)?;
                        anyhow::ensure!(
                            is_lower_sha256(&item.binary_hash),
                            "avatar binaryHash must be lowercase SHA-256"
                        );
                        Ok(ManifestItem {
                            identity: ManifestIdentity::Avatar(key),
                            config_hash: item.binary_hash,
                            content_hash: String::new(),
                            updated_at: validate_manifest_time(item.updated_at, "updatedAt")?,
                            deleted_at: None,
                        })
                    }
                    AvatarManifestState::Deleted(item) => {
                        let key = AvatarKey {
                            owner_type: item.owner_type,
                            owner_id: item.owner_id,
                        };
                        validate_avatar_key(&key)?;
                        Ok(ManifestItem {
                            identity: ManifestIdentity::Avatar(key),
                            config_hash: String::new(),
                            content_hash: String::new(),
                            updated_at: 0,
                            deleted_at: Some(validate_manifest_time(item.deleted_at, "deletedAt")?),
                        })
                    }
                })
                .collect::<Result<Vec<_>>>()?;
            (ManifestType::Avatar, items, None)
        }
    };
    anyhow::ensure!(
        items.len() <= MAX_SYNC_ITEMS,
        "manifest exceeds {MAX_SYNC_ITEMS} items"
    );
    let mut seen = HashSet::new();
    for item in &items {
        anyhow::ensure!(
            seen.insert(manifest_key(&item.identity)),
            "manifest contains a duplicate entity identity"
        );
    }
    Ok(NormalizedManifestRequest {
        manifest_type,
        items,
        targeted_owners,
    })
}

fn build_manifest_response(
    manifest_type: ManifestType,
    actions: Vec<ManifestDecision>,
) -> Result<ManifestResponse> {
    match manifest_type {
        ManifestType::Owner => Ok(ManifestResponse::Owner {
            response_type: "SYNC_MANIFEST_RESULT",
            results: actions
                .into_iter()
                .map(|action| match action.identity {
                    ManifestIdentity::Owner(key) => Ok(OwnerManifestDecision {
                        owner_type: key.owner_type,
                        owner_id: key.owner_id,
                        action: action.action,
                        deleted_at: action.deleted_at,
                        content_hash_mismatch: action.content_hash_mismatch,
                    }),
                    _ => anyhow::bail!("owner manifest produced a non-owner decision"),
                })
                .collect::<Result<Vec<_>>>()?,
        }),
        ManifestType::Topic => Ok(ManifestResponse::Topic {
            response_type: "SYNC_MANIFEST_RESULT",
            results: actions
                .into_iter()
                .map(|action| match action.identity {
                    ManifestIdentity::Topic(key) => Ok(TopicManifestDecision {
                        owner_type: key.owner_type,
                        owner_id: key.owner_id,
                        topic_id: key.topic_id,
                        action: action.action,
                        deleted_at: action.deleted_at,
                    }),
                    _ => anyhow::bail!("topic manifest produced a non-topic decision"),
                })
                .collect::<Result<Vec<_>>>()?,
        }),
        ManifestType::Avatar => Ok(ManifestResponse::Avatar {
            response_type: "SYNC_MANIFEST_RESULT",
            results: actions
                .into_iter()
                .map(|action| match action.identity {
                    ManifestIdentity::Avatar(key) => Ok(AvatarManifestDecision {
                        owner_type: key.owner_type,
                        owner_id: key.owner_id,
                        action: action.action,
                        deleted_at: action.deleted_at,
                    }),
                    _ => anyhow::bail!("avatar manifest produced a non-avatar decision"),
                })
                .collect::<Result<Vec<_>>>()?,
        }),
    }
}

pub fn manifest(database: &Database, request: ManifestRequest) -> Result<ManifestResponse> {
    let request = normalize_manifest_request(request)?;
    let local = local_manifest(
        database,
        request.manifest_type,
        request.targeted_owners.as_deref(),
    )?;
    anyhow::ensure!(
        local.len() <= MAX_SYNC_ITEMS,
        "local manifest exceeds {MAX_SYNC_ITEMS} items"
    );
    let mut local_by_key = HashMap::new();
    for item in local {
        let key = manifest_key(&item.identity);
        anyhow::ensure!(
            local_by_key.insert(key.clone(), item).is_none(),
            "local manifest contains duplicate entity key {key}"
        );
    }

    let mut actions = Vec::new();
    let mut processed = HashSet::new();
    for remote in &request.items {
        let key = manifest_key(&remote.identity);
        let local = local_by_key.get(&key);
        processed.insert(key);

        if let Some(deleted_at) = remote.deleted_at {
            if local.is_none_or(|item| item.deleted_at.is_none()) {
                actions.push(ManifestDecision {
                    identity: remote.identity.clone(),
                    action: ManifestActionKind::PushDelete,
                    deleted_at: Some(deleted_at),
                    content_hash_mismatch: false,
                });
            }
            continue;
        }

        let Some(local) = local else {
            actions.push(ManifestDecision {
                identity: remote.identity.clone(),
                action: ManifestActionKind::Push,
                deleted_at: None,
                content_hash_mismatch: false,
            });
            continue;
        };
        if let Some(deleted_at) = local.deleted_at {
            actions.push(ManifestDecision {
                identity: local.identity.clone(),
                action: ManifestActionKind::PullDelete,
                deleted_at: Some(deleted_at),
                content_hash_mismatch: false,
            });
            continue;
        }

        let config_changed = local.config_hash != remote.config_hash;
        let content_changed = local.content_hash != remote.content_hash;
        if config_changed {
            actions.push(ManifestDecision {
                identity: local.identity.clone(),
                action: if remote.updated_at > local.updated_at {
                    ManifestActionKind::Push
                } else {
                    ManifestActionKind::Pull
                },
                deleted_at: None,
                content_hash_mismatch: content_changed,
            });
        } else if content_changed && request.manifest_type == ManifestType::Owner {
            actions.push(ManifestDecision {
                identity: local.identity.clone(),
                action: ManifestActionKind::Skip,
                deleted_at: None,
                content_hash_mismatch: true,
            });
        }
    }

    for (key, local) in local_by_key {
        if processed.contains(&key) {
            continue;
        }
        actions.push(ManifestDecision {
            identity: local.identity,
            action: if local.deleted_at.is_some() {
                ManifestActionKind::PullDelete
            } else {
                ManifestActionKind::Pull
            },
            deleted_at: local.deleted_at,
            content_hash_mismatch: false,
        });
    }

    build_manifest_response(request.manifest_type, actions)
}

#[cfg(test)]
fn load_message_states(database: &Database, key: &TopicKey) -> Result<Vec<IndexedMessageState>> {
    ensure_topic_sync_source_healthy(database, key)?;
    load_message_states_committed(database, key)
}

fn load_message_states_committed(
    database: &Database,
    key: &TopicKey,
) -> Result<Vec<IndexedMessageState>> {
    let connection = database.connection.lock();
    let mut statement = connection.prepare(
        "SELECT msg_id, message_hash, updated_at, deleted_at
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
    let messages = rows
        .into_iter()
        .map(|(msg_id, stored_hash, updated_at, deleted_at)| {
            let message_hash = if deleted_at.is_some() {
                None
            } else {
                anyhow::ensure!(
                    canonical_wire_hash(&stored_hash).is_some(),
                    "live indexed message {msg_id} has an invalid persisted messageHash"
                );
                Some(stored_hash)
            };
            Ok(IndexedMessageState {
                msg_id,
                message_hash,
                updated_at,
                deleted_at,
            })
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(messages)
}

pub fn pull_entities(database: &Database, request: EntitiesPullRequest) -> EntitiesPullResponse {
    let results = request
        .items
        .into_iter()
        .map(|item| {
            let result = pull_entity(database, &item);
            let (ok, data, error) = match result {
                Ok(Some(data)) => (true, Some(data), None),
                Ok(None) => (
                    false,
                    None,
                    Some(SyncItemError {
                        code: "ENTITY_NOT_FOUND".to_string(),
                        message: "entity not found".to_string(),
                        retryable: false,
                    }),
                ),
                Err(error) => (
                    false,
                    None,
                    Some(SyncItemError {
                        code: if error.downcast_ref::<SnapshotStale>().is_some() {
                            "SNAPSHOT_STALE"
                        } else {
                            "ENTITY_READ_FAILED"
                        }
                        .to_string(),
                        message: error.to_string(),
                        retryable: false,
                    }),
                ),
            };
            match item {
                EntityPullItem::Owner {
                    owner_type,
                    owner_id,
                } => EntityPullResult::Owner {
                    owner_type,
                    owner_id,
                    ok,
                    data,
                    error,
                },
                EntityPullItem::Topic {
                    owner_type,
                    owner_id,
                    topic_id,
                } => EntityPullResult::Topic {
                    owner_type,
                    owner_id,
                    topic_id,
                    ok,
                    data,
                    error,
                },
            }
        })
        .collect();
    EntitiesPullResponse { results }
}

fn pull_entity(database: &Database, item: &EntityPullItem) -> Result<Option<Value>> {
    match item {
        EntityPullItem::Owner {
            owner_type,
            owner_id,
        } => {
            let connection = database.connection.lock();
            let row = connection
                .query_row(
                    "SELECT config_path, config_hash, deleted_at FROM owners
                     WHERE owner_type=?1 AND owner_id=?2",
                    params![owner_type.as_str(), owner_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<i64>>(2)?,
                        ))
                    },
                )
                .optional()?;
            drop(connection);
            let Some((config_path, committed_hash, None)) = row else {
                return Ok(None);
            };
            let root = serde_json::from_slice::<Value>(&fs::read(&config_path)?)
                .with_context(|| format!("invalid owner config {config_path}"))?;
            let dto = mobile_owner_sync_dto_from_value(*owner_type, &root)?;
            if hash_stable_object(&dto) != committed_hash {
                return Err(SnapshotStale(
                    "owner config changed after its manifest was committed".to_string(),
                )
                .into());
            }
            Ok(Some(Value::Object(dto)))
        }
        EntityPullItem::Topic {
            owner_type,
            owner_id,
            topic_id,
        } => {
            let connection = database.connection.lock();
            let row = connection
                .query_row(
                    "SELECT metadata_json, deleted_at FROM topics
                     WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3",
                    params![owner_type.as_str(), owner_id, topic_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<i64>>(1)?,
                        ))
                    },
                )
                .optional()?;
            drop(connection);
            let Some((Some(metadata_json), None)) = row else {
                return Ok(None);
            };
            let metadata = serde_json::from_str::<Value>(&metadata_json)
                .context("topic metadata is invalid")?;
            let key = TopicKey {
                owner_type: *owner_type,
                owner_id: owner_id.clone(),
                topic_id: topic_id.clone(),
            };
            let mut dto = mobile_topic_sync_dto(&key, &metadata);
            dto.insert("ownerId".to_string(), Value::String(owner_id.clone()));
            Ok(Some(Value::Object(dto)))
        }
    }
}

pub fn topic_diff(database: &Database, request: TopicDiffRequest) -> Result<TopicDiffResponse> {
    validate_topic_diff_states(&request.topics)?;
    if request.topics.is_empty() {
        return Ok(TopicDiffResponse {
            response_type: "SYNC_TOPIC_DIFF_RESULT",
            changed_topics: Vec::new(),
        });
    }
    let local_topics = load_topic_manifest_rows(database)?;
    let mut changed_topics = Vec::new();
    for state in request.topics {
        let requested_key = TopicKey {
            owner_type: state.owner_type,
            owner_id: state.owner_id,
            topic_id: state.topic_id,
        };
        let Some(local) = local_topics
            .get(&requested_key)
            .filter(|local| local.deleted_at.is_none())
        else {
            changed_topics.push(requested_key);
            continue;
        };
        ensure_topic_manifest_row_healthy(local).with_context(|| {
            format!(
                "topic hash diff could not read {}/{}/{}",
                requested_key.owner_type.as_str(),
                requested_key.owner_id,
                requested_key.topic_id
            )
        })?;
        if local.config_hash != state.config_hash || local.content_hash != state.content_hash {
            changed_topics.push(requested_key);
        }
    }
    changed_topics.sort_by(|left, right| {
        (left.owner_type.as_str(), &left.owner_id, &left.topic_id).cmp(&(
            right.owner_type.as_str(),
            &right.owner_id,
            &right.topic_id,
        ))
    });

    Ok(TopicDiffResponse {
        response_type: "SYNC_TOPIC_DIFF_RESULT",
        changed_topics,
    })
}

fn validate_topic_diff_states(topics: &[TopicDiffState]) -> Result<()> {
    anyhow::ensure!(
        topics.len() <= 10_000,
        "topic hash diff exceeds 10000 topics"
    );
    let mut seen_topics = HashSet::with_capacity(topics.len());
    for state in topics {
        anyhow::ensure!(
            !state.topic_id.is_empty(),
            "topic hash diff topicId is empty"
        );
        anyhow::ensure!(
            !state.owner_id.is_empty(),
            "topic hash diff ownerId must be non-empty"
        );
        anyhow::ensure!(
            canonical_wire_hash(&state.config_hash).is_some()
                && (state.content_hash.is_empty()
                    || canonical_wire_hash(&state.content_hash).is_some()),
            "topic hash diff contains an invalid hash for {}",
            state.topic_id
        );
        anyhow::ensure!(
            seen_topics.insert((state.owner_type, &state.owner_id, &state.topic_id)),
            "topic hash diff contains a duplicate topic identity"
        );
    }
    Ok(())
}

pub fn message_diff(
    database: &Database,
    request: MessageDiffRequest,
) -> Result<MessageDiffResponse> {
    validate_message_diff_states(&request.topics)?;
    if request.topics.is_empty() {
        return Ok(MessageDiffResponse {
            response_type: "SYNC_MESSAGE_DIFF_RESULT",
            results: Vec::new(),
        });
    }
    let local_topics = load_topic_manifest_rows(database)?;
    let mut results = Vec::with_capacity(request.topics.len());
    for state in request.topics {
        let requested_key = TopicKey {
            owner_type: state.owner_type,
            owner_id: state.owner_id.clone(),
            topic_id: state.topic_id.clone(),
        };
        let Some(local_topic) = local_topics
            .get(&requested_key)
            .filter(|local| local.deleted_at.is_none())
        else {
            results.push(MessageDiffResult::failure(
                &requested_key,
                "TOPIC_NOT_FOUND",
                "topic identity was not found".to_string(),
            ));
            continue;
        };
        if let Err(error) = ensure_topic_manifest_row_healthy(local_topic) {
            results.push(MessageDiffResult::failure(
                &requested_key,
                "MESSAGE_MANIFEST_FAILED",
                format!("{error:#}"),
            ));
            continue;
        }
        let key = requested_key.clone();
        let remote_has_tombstones = state
            .messages
            .values()
            .any(|version| matches!(version, MessageVersionState::Deleted(_)));
        if !state.content_hash.is_empty()
            && state.content_hash == local_topic.content_hash
            && !remote_has_tombstones
        {
            results.push(MessageDiffResult::success(
                &key,
                Vec::new(),
                false,
                Vec::new(),
            ));
            continue;
        }
        let indexed_messages = match load_message_states_committed(database, &key) {
            Ok(messages) => messages,
            Err(error) => {
                results.push(MessageDiffResult::failure(
                    &requested_key,
                    "MESSAGE_MANIFEST_FAILED",
                    format!("{error:#}"),
                ));
                continue;
            }
        };
        let mut active = HashMap::new();
        let mut tombstones = HashMap::new();
        for item in indexed_messages {
            if let Some(deleted_at) = item.deleted_at {
                tombstones.insert(item.msg_id, deleted_at);
            } else {
                let message_hash = item
                    .message_hash
                    .context("live indexed message is missing messageHash")?;
                active.insert(
                    item.msg_id,
                    MessageLiveState {
                        message_hash,
                        updated_at: item.updated_at,
                    },
                );
            }
        }
        let mut to_pull = active
            .iter()
            .filter_map(|(id, desktop)| {
                let remote = state.messages.get(id);
                match remote {
                    None => Some(id.clone()),
                    Some(MessageVersionState::Deleted(_)) => None,
                    Some(MessageVersionState::Live(mobile))
                        if mobile.message_hash == desktop.message_hash =>
                    {
                        None
                    }
                    Some(MessageVersionState::Live(mobile))
                        if desktop.updated_at > mobile.updated_at
                            || (desktop.updated_at == mobile.updated_at
                                && desktop.message_hash > mobile.message_hash) =>
                    {
                        Some(id.clone())
                    }
                    Some(_) => None,
                }
            })
            .collect::<Vec<_>>();
        to_pull.sort();

        let mut to_delete = tombstones
            .iter()
            .filter_map(|(id, deleted_at)| match state.messages.get(id) {
                Some(MessageVersionState::Live(_)) => Some(MessageDeleteAction {
                    msg_id: id.clone(),
                    deleted_at: *deleted_at,
                }),
                _ => None,
            })
            .collect::<Vec<_>>();
        to_delete.sort_by(|left, right| left.msg_id.cmp(&right.msg_id));

        let to_push = state.messages.iter().any(|(id, mobile)| match mobile {
            MessageVersionState::Deleted(_) => !tombstones.contains_key(id),
            MessageVersionState::Live(mobile) => {
                if let Some(desktop) = active.get(id) {
                    desktop.message_hash != mobile.message_hash
                        && (mobile.updated_at > desktop.updated_at
                            || (mobile.updated_at == desktop.updated_at
                                && mobile.message_hash > desktop.message_hash))
                } else {
                    !tombstones.contains_key(id)
                }
            }
        });
        results.push(MessageDiffResult::success(
            &key, to_pull, to_push, to_delete,
        ));
    }

    Ok(MessageDiffResponse {
        response_type: "SYNC_MESSAGE_DIFF_RESULT",
        results,
    })
}

fn validate_message_diff_states(topics: &[MessageDiffState]) -> Result<()> {
    anyhow::ensure!(topics.len() <= 10_000, "message diff exceeds 10000 topics");
    let mut seen_topics = HashSet::with_capacity(topics.len());
    let mut total_messages = 0_usize;
    for state in topics {
        anyhow::ensure!(
            !state.topic_id.is_empty(),
            "message diff topicId must be non-empty"
        );
        anyhow::ensure!(
            !state.owner_id.is_empty(),
            "message diff ownerId must be non-empty"
        );
        anyhow::ensure!(
            seen_topics.insert((state.owner_type, &state.owner_id, &state.topic_id)),
            "message diff contains a duplicate topic identity"
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
        anyhow::ensure!(
            state.content_hash.is_empty() || canonical_wire_hash(&state.content_hash).is_some(),
            "message diff contentHash is invalid for {}",
            state.topic_id
        );
        for (message_id, version) in &state.messages {
            anyhow::ensure!(
                !message_id.is_empty(),
                "message diff message id must be non-empty"
            );
            match version {
                MessageVersionState::Live(version) => {
                    anyhow::ensure!(
                        canonical_wire_hash(&version.message_hash).is_some(),
                        "message diff contains an invalid messageHash for {}/{message_id}",
                        state.topic_id
                    );
                    validate_manifest_time(version.updated_at, "message updatedAt")?;
                }
                MessageVersionState::Deleted(version) => {
                    validate_manifest_time(version.deleted_at, "message deletedAt")?;
                }
            }
        }
    }
    Ok(())
}

pub fn pull_topic_messages(
    database: &Database,
    topic: MessagesPullTopic,
) -> Result<MessagesPullFrame> {
    let requested_key = TopicKey {
        topic_id: topic.topic_id.clone(),
        owner_type: topic.owner_type,
        owner_id: topic.owner_id,
    };
    let key = resolve_topic(database, &requested_key)?;
    ensure_topic_sync_source_healthy(database, &key)?;
    anyhow::ensure!(
        topic.message_ids.len() <= 10_000,
        "topic message request exceeds 10000 ids"
    );
    let requested_ids = topic.message_ids;
    let wanted = requested_ids.iter().cloned().collect::<HashSet<_>>();
    let connection = database.connection.lock();
    let rows = if requested_ids.is_empty() {
        let mut statement = connection.prepare(
            "SELECT metadata_json, updated_at FROM messages
             WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3 AND deleted_at IS NULL
             ORDER BY ordinal ASC",
        )?;
        let rows = statement
            .query_map(
                params![key.owner_type.as_str(), key.owner_id, key.topic_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    } else {
        let placeholders = std::iter::repeat_n("?", requested_ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT metadata_json, updated_at FROM messages
             WHERE owner_type=? AND owner_id=? AND topic_id=? AND deleted_at IS NULL
               AND msg_id IN ({placeholders})
             ORDER BY ordinal ASC"
        );
        let mut bind = Vec::with_capacity(3 + requested_ids.len());
        bind.push(SqlValue::Text(key.owner_type.as_str().to_string()));
        bind.push(SqlValue::Text(key.owner_id.clone()));
        bind.push(SqlValue::Text(key.topic_id.clone()));
        bind.extend(requested_ids.iter().cloned().map(SqlValue::Text));
        let mut statement = connection.prepare(&sql)?;
        let rows = statement
            .query_map(params_from_iter(bind), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    drop(connection);

    let mut warnings = WireWarnings::default();
    let mut messages = Vec::new();
    let mut seen = HashSet::new();
    for (raw, updated_at) in rows {
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
        anyhow::ensure!(
            (0..=9_007_199_254_740_991).contains(&updated_at),
            "stored message update time is invalid for topic {}",
            key.topic_id
        );
        let mut canonical = canonicalize_message(value, &key.topic_id, &mut warnings)?;
        canonical
            .as_object_mut()
            .context("canonical message must be an object")?
            .insert("updatedAt".to_string(), Value::from(updated_at));
        messages.push(canonical);
    }
    if !wanted.is_empty() {
        anyhow::ensure!(
            seen == wanted,
            "requested message set is incomplete for topic {}",
            key.topic_id
        );
    }
    Ok(MessagesPullFrame {
        kind: "topic",
        topic_id: key.topic_id,
        owner_type: key.owner_type,
        owner_id: key.owner_id,
        ok: true,
        messages,
        legacy_attachment_warnings: warnings.count,
        warning_samples: warnings.samples,
    })
}

pub async fn push_topic_messages(
    reconciler: &Reconciler,
    topic: MessagesPushTopic,
) -> MessagesPushResult {
    match push_topic(reconciler, &topic).await {
        Ok(commit) => MessagesPushResult {
            topic_id: topic.topic_id,
            owner_type: topic.owner_type,
            owner_id: topic.owner_id,
            ok: true,
            ingest_commit: Some(commit),
            error: None,
        },
        Err(error) => MessagesPushResult {
            topic_id: topic.topic_id,
            owner_type: topic.owner_type,
            owner_id: topic.owner_id,
            ok: false,
            ingest_commit: None,
            error: Some(SyncItemError {
                code: if error.downcast_ref::<SnapshotStale>().is_some() {
                    "SNAPSHOT_STALE"
                } else {
                    "MESSAGE_WRITE_FAILED"
                }
                .to_string(),
                message: format!("{error:#}"),
                retryable: false,
            }),
        },
    }
}

const MOBILE_MESSAGE_PATCH_FIELDS: [&str; 11] = [
    "id",
    "role",
    "name",
    "content",
    "timestamp",
    "updatedAt",
    "agentId",
    "groupId",
    "topicId",
    "isGroupMessage",
    "finishReason",
];

fn desktop_attachment_hash(attachment: &Value) -> Option<String> {
    let object = attachment.as_object()?;
    let top = object.get("hash").and_then(Value::as_str);
    let nested = object
        .get("_fileManagerData")
        .and_then(Value::as_object)
        .and_then(|data| data.get("hash"))
        .and_then(Value::as_str);
    let valid =
        |value: &str| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
    match (
        top.filter(|value| valid(value)),
        nested.filter(|value| valid(value)),
    ) {
        (Some(left), Some(right)) if left.eq_ignore_ascii_case(right) => {
            Some(left.to_ascii_lowercase())
        }
        (Some(_), Some(_)) => None,
        (Some(hash), None) | (None, Some(hash)) => Some(hash.to_ascii_lowercase()),
        (None, None) => None,
    }
}

fn merge_desktop_attachment(existing: &Value, incoming: &Value) -> Value {
    let (Some(existing), Some(incoming)) = (existing.as_object(), incoming.as_object()) else {
        return incoming.clone();
    };
    let mut merged = existing.clone();
    merged.extend(incoming.clone());

    if incoming.get("src").and_then(Value::as_str) == Some("") {
        if let Some(src) = existing
            .get("src")
            .and_then(Value::as_str)
            .filter(|src| !src.is_empty())
        {
            merged.insert("src".to_string(), Value::String(src.to_string()));
        }
    }

    let existing_data = existing.get("_fileManagerData").and_then(Value::as_object);
    let incoming_data = incoming.get("_fileManagerData").and_then(Value::as_object);
    if existing_data.is_some() || incoming_data.is_some() {
        let mut merged_data = existing_data.cloned().unwrap_or_default();
        if let Some(incoming_data) = incoming_data {
            merged_data.extend(incoming_data.clone());
        }
        if incoming_data
            .and_then(|data| data.get("internalPath"))
            .and_then(Value::as_str)
            == Some("")
        {
            if let Some(internal_path) = existing_data
                .and_then(|data| data.get("internalPath"))
                .and_then(Value::as_str)
                .filter(|path| !path.is_empty())
            {
                merged_data.insert(
                    "internalPath".to_string(),
                    Value::String(internal_path.to_string()),
                );
            }
        }
        merged.insert("_fileManagerData".to_string(), Value::Object(merged_data));
    }
    Value::Object(merged)
}

fn merge_mobile_attachments(existing: Option<&Value>, incoming: &[Value]) -> Vec<Value> {
    let mut existing_by_hash: HashMap<String, VecDeque<&Value>> = HashMap::new();
    for attachment in existing.and_then(Value::as_array).into_iter().flatten() {
        if let Some(hash) = desktop_attachment_hash(attachment) {
            existing_by_hash
                .entry(hash)
                .or_default()
                .push_back(attachment);
        }
    }
    incoming
        .iter()
        .map(|attachment| {
            let existing = desktop_attachment_hash(attachment)
                .and_then(|hash| existing_by_hash.get_mut(&hash))
                .and_then(VecDeque::pop_front);
            existing
                .map(|existing| merge_desktop_attachment(existing, attachment))
                .unwrap_or_else(|| attachment.clone())
        })
        .collect()
}

fn merge_mobile_message(existing: &Value, incoming: &Value) -> Value {
    let (Some(existing), Some(incoming)) = (existing.as_object(), incoming.as_object()) else {
        return incoming.clone();
    };
    let mut merged = existing.clone();
    for key in MOBILE_MESSAGE_PATCH_FIELDS {
        if let Some(value) = incoming.get(key).filter(|value| !value.is_null()) {
            merged.insert(key.to_string(), value.clone());
        } else {
            merged.remove(key);
        }
    }
    if let Some(avatar_url) = incoming
        .get("avatarUrl")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        merged.insert(
            "avatarUrl".to_string(),
            Value::String(avatar_url.to_string()),
        );
    }
    if let Some(attachments) = incoming
        .get("attachments")
        .and_then(Value::as_array)
        .filter(|attachments| !attachments.is_empty())
    {
        merged.insert(
            "attachments".to_string(),
            Value::Array(merge_mobile_attachments(
                existing.get("attachments"),
                attachments,
            )),
        );
    } else {
        merged.remove("attachments");
    }
    Value::Object(merged)
}

async fn push_topic(reconciler: &Reconciler, topic: &MessagesPushTopic) -> Result<IngestCommit> {
    anyhow::ensure!(
        !topic.owner_id.is_empty(),
        "pushed topic ownerId must be non-empty"
    );
    let mut deleted = HashSet::with_capacity(topic.deleted_messages.len());
    let mut explicit_tombstones = Vec::with_capacity(topic.deleted_messages.len());
    for tombstone in &topic.deleted_messages {
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
        let updated_at = message
            .get("updatedAt")
            .and_then(Value::as_i64)
            .context("pushed message updatedAt is required")?;
        anyhow::ensure!(
            (0..=9_007_199_254_740_991).contains(&updated_at),
            "pushed message {id} updatedAt must be a non-negative safe integer"
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
        &TopicKey {
            topic_id: topic.topic_id.clone(),
            owner_type: topic.owner_type,
            owner_id: topic.owner_id.clone(),
        },
    )?;
    ensure_topic_sync_source_healthy(reconciler.database(), &key)?;
    let persisted_tombstones = reconciler.database().message_tombstone_ids(&key)?;
    if let Some(stale_live) = live_ids
        .iter()
        .find(|message_id| persisted_tombstones.contains(*message_id))
    {
        return Err(SnapshotStale(format!(
            "pushed live message {stale_live} is already tombstoned; rerun message diff"
        ))
        .into());
    }
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
            .is_none_or(|id| !deleted.contains(id) && !persisted_tombstones.contains(id))
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
            current[index] = merge_mobile_message(&current[index], message);
        } else {
            positions.insert(id.to_string(), current.len());
            current.push(message.clone());
        }
    }

    let history_bytes = serde_json::to_vec_pretty(&current)?;
    let normalized = normalize_history_values(current, key.owner_type, &key.topic_id)
        .context("projected history is not ingestible")?;
    let committed = write_history_atomic(
        &history_path,
        &history_bytes,
        expected_source_hash.as_deref(),
    )?;
    let mut commit = if let Some(committed) = committed {
        reconciler.database().ingest_topic(
            &TopicSource {
                key: key.clone(),
                source_path: history_path.clone(),
            },
            &normalized,
            committed.mtime_ns,
            committed.file_size,
            &committed.source_hash,
            OwnerHashMode::Immediate,
        )?
    } else {
        reconciler
            .ingest_path(&history_path, "mobile_sync")
            .await?
            .context("projected history path was not accepted by CDS")?
    };
    if reconciler
        .database()
        .apply_explicit_message_tombstones(&key, &explicit_tombstones)?
    {
        commit.changed = true;
    }
    Ok(commit)
}

fn local_manifest(
    database: &Database,
    manifest_type: ManifestType,
    targeted_owners: Option<&[OwnerKey]>,
) -> Result<Vec<ManifestItem>> {
    match manifest_type {
        ManifestType::Owner => owner_manifest(database),
        ManifestType::Topic => topic_manifests(database, targeted_owners),
        ManifestType::Avatar => avatar_manifest(database),
    }
}

fn avatar_manifest(database: &Database) -> Result<Vec<ManifestItem>> {
    let connection = database.connection.lock();
    let mut statement = connection.prepare(
        "SELECT owner_type, owner_id, hash, updated_at, deleted_at
         FROM avatars
         ORDER BY owner_type, owner_id",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|(owner_type, owner_id, hash, updated_at, deleted_at)| {
            let key = AvatarKey::from_wire_id(&format!("{owner_type}:{owner_id}"))?;
            Ok(ManifestItem {
                identity: ManifestIdentity::Avatar(key),
                config_hash: hash,
                content_hash: String::new(),
                updated_at,
                deleted_at,
            })
        })
        .collect()
}

fn owner_manifest(database: &Database) -> Result<Vec<ManifestItem>> {
    let connection = database.connection.lock();
    let mut statement = connection.prepare(
        "SELECT owner_type, owner_id, config_hash, content_hash, updated_at, deleted_at
         FROM owners
         ORDER BY owner_type, owner_id",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<i64>>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    drop(connection);

    rows.into_iter()
        .map(
            |(raw_owner_type, owner_id, config_hash, content_hash, updated_at, deleted_at)| {
                let owner_type = raw_owner_type.parse::<OwnerType>()?;
                // 墓碑条目短路：已删 owner 的目录已物理删除，
                // 磁盘读必然失败；删除信号不需要配置或内容指纹。
                if deleted_at.is_some() {
                    return Ok(ManifestItem {
                        identity: ManifestIdentity::Owner(OwnerKey {
                            owner_type,
                            owner_id,
                        }),
                        config_hash: String::new(),
                        content_hash: String::new(),
                        updated_at,
                        deleted_at,
                    });
                }
                Ok(ManifestItem {
                    identity: ManifestIdentity::Owner(OwnerKey {
                        owner_type,
                        owner_id,
                    }),
                    config_hash,
                    content_hash,
                    updated_at,
                    deleted_at,
                })
            },
        )
        .collect()
}

fn topic_manifests(
    database: &Database,
    targeted_owners: Option<&[OwnerKey]>,
) -> Result<Vec<ManifestItem>> {
    if targeted_owners.is_some_and(|owners| owners.is_empty()) {
        return Ok(Vec::new());
    }
    let targeted_owners =
        targeted_owners.map(|owners| owners.iter().cloned().collect::<HashSet<_>>());
    let mut rows = load_topic_manifest_rows(database)?
        .into_values()
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        (
            left.key.owner_type.as_str(),
            &left.key.owner_id,
            &left.key.topic_id,
        )
            .cmp(&(
                right.key.owner_type.as_str(),
                &right.key.owner_id,
                &right.key.topic_id,
            ))
    });
    rows.into_iter()
        .filter(|row| {
            targeted_owners.as_ref().is_none_or(|owners| {
                owners.contains(&OwnerKey {
                    owner_type: row.key.owner_type,
                    owner_id: row.key.owner_id.clone(),
                })
            })
        })
        .map(|row| topic_manifest_from_row(&row))
        .collect()
}

#[cfg(test)]
fn topic_manifest(database: &Database, key: &TopicKey) -> Result<ManifestItem> {
    let row = load_topic_manifest_row(database, key)?;
    topic_manifest_from_row(&row)
}

fn topic_manifest_from_row(row: &TopicManifestRow) -> Result<ManifestItem> {
    let key = &row.key;
    if row.deleted_at.is_some() {
        return Ok(ManifestItem {
            identity: ManifestIdentity::Topic(key.clone()),
            config_hash: String::new(),
            content_hash: String::new(),
            updated_at: row.updated_at,
            deleted_at: row.deleted_at,
        });
    }
    let content_hash = match ensure_topic_manifest_row_healthy(row) {
        Ok(()) => row.content_hash.clone(),
        Err(error) => {
            tracing::warn!(
                owner_type = %key.owner_type.as_str(),
                owner_id = %key.owner_id,
                topic_id = %key.topic_id,
                error = %format!("{error:#}"),
                "topic manifest content hash degraded"
            );
            unhealthy_topic_sentinel_hash(key)
        }
    };
    Ok(ManifestItem {
        identity: ManifestIdentity::Topic(key.clone()),
        config_hash: row.config_hash.clone(),
        content_hash,
        updated_at: row.updated_at,
        deleted_at: row.deleted_at,
    })
}

#[cfg(test)]
fn load_topic_manifest_row(database: &Database, key: &TopicKey) -> Result<TopicManifestRow> {
    let connection = database.connection.lock();
    connection
        .query_row(
            "SELECT t.config_hash, t.content_hash, t.updated_at, t.deleted_at,
                t.source_path, hs.status, hs.last_error
         FROM topics t
         LEFT JOIN history_sources hs
           ON hs.source_path=t.source_path
          AND hs.owner_type=t.owner_type
          AND hs.owner_id=t.owner_id
          AND hs.topic_id=t.topic_id
         WHERE t.owner_type=?1 AND t.owner_id=?2 AND t.topic_id=?3",
            params![key.owner_type.as_str(), key.owner_id, key.topic_id],
            |row| {
                Ok(TopicManifestRow {
                    key: key.clone(),
                    config_hash: row.get(0)?,
                    content_hash: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    updated_at: row.get(2)?,
                    deleted_at: row.get(3)?,
                    source_path: row.get(4)?,
                    source_status: row.get(5)?,
                    source_error: row.get(6)?,
                })
            },
        )
        .map_err(Into::into)
}

fn load_topic_manifest_rows(database: &Database) -> Result<HashMap<TopicKey, TopicManifestRow>> {
    let connection = database.connection.lock();
    let mut statement = connection.prepare(
        "SELECT t.owner_type, t.owner_id, t.topic_id, t.config_hash, t.content_hash,
                t.updated_at, t.deleted_at, t.source_path, hs.status, hs.last_error
         FROM topics t
         LEFT JOIN history_sources hs
           ON hs.source_path=t.source_path
          AND hs.owner_type=t.owner_type
          AND hs.owner_id=t.owner_id
          AND hs.topic_id=t.topic_id
         ORDER BY t.owner_type, t.owner_id, t.topic_id",
    )?;
    let rows = statement
        .query_map([], |row| {
            let raw_owner_type: String = row.get(0)?;
            let key = TopicKey {
                owner_type: if raw_owner_type == "group" {
                    OwnerType::Group
                } else {
                    OwnerType::Agent
                },
                owner_id: row.get(1)?,
                topic_id: row.get(2)?,
            };
            Ok(TopicManifestRow {
                key,
                config_hash: row.get(3)?,
                content_hash: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                updated_at: row.get(5)?,
                deleted_at: row.get(6)?,
                source_path: row.get(7)?,
                source_status: row.get(8)?,
                source_error: row.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().map(|row| (row.key.clone(), row)).collect())
}

fn ensure_topic_manifest_row_healthy(row: &TopicManifestRow) -> Result<()> {
    if let Some(status) = &row.source_status {
        anyhow::ensure!(
            status == "ready",
            "history source is not ready for sync: {}",
            row.source_error.clone().unwrap_or_else(|| status.clone())
        );
    } else if Path::new(&row.source_path).exists() {
        anyhow::bail!("history source exists but has not been ingested");
    }
    Ok(())
}

#[cfg(test)]
fn owner_content_hash(
    database: &Database,
    owner_type: OwnerType,
    owner_id: &str,
) -> Result<String> {
    let connection = database.connection.lock();
    connection
        .query_row(
            "SELECT content_hash FROM owners
             WHERE owner_type=?1 AND owner_id=?2 AND deleted_at IS NULL",
            params![owner_type.as_str(), owner_id],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn ensure_topic_sync_source_healthy(database: &Database, key: &TopicKey) -> Result<()> {
    let connection = database.connection.lock();
    let (source_path, status, last_error): (String, Option<String>, Option<String>) = connection
        .query_row(
            "SELECT t.source_path, hs.status, hs.last_error
             FROM topics t
             LEFT JOIN history_sources hs
               ON hs.source_path=t.source_path
              AND hs.owner_type=t.owner_type
              AND hs.owner_id=t.owner_id
              AND hs.topic_id=t.topic_id
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

fn resolve_topic(database: &Database, key: &TopicKey) -> Result<TopicKey> {
    let connection = database.connection.lock();
    let exists = connection
        .query_row(
            "SELECT 1 FROM topics
             WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3
               AND deleted_at IS NULL",
            params![key.owner_type.as_str(), key.owner_id, key.topic_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    anyhow::ensure!(exists, "topic was not found");
    Ok(key.clone())
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

fn canonical_wire_hash(value: &str) -> Option<String> {
    let normalized = value.to_ascii_lowercase();
    (normalized.len() == 64
        && normalized.bytes().all(|byte| byte.is_ascii_hexdigit())
        && normalized == value)
        .then_some(normalized)
}

pub(crate) fn mobile_owner_config_hash_from_value(
    owner_type: OwnerType,
    root: &Value,
) -> Result<String> {
    Ok(hash_stable_object(&mobile_owner_sync_dto_from_value(
        owner_type, root,
    )?))
}

fn mobile_owner_sync_dto_from_value(
    owner_type: OwnerType,
    root: &Value,
) -> Result<Map<String, Value>> {
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
            dto.insert(
                "temperature".into(),
                normalize_float(&defaulted_value(
                    object,
                    "temperature",
                    serde_json::Number::from_f64(1.0)
                        .map(Value::Number)
                        .unwrap_or(Value::Null),
                )),
            );
            dto.insert(
                "contextTokenLimit".into(),
                normalize_integer(&defaulted_value(
                    object,
                    "contextTokenLimit",
                    Value::Number(1_000_000.into()),
                )),
            );
            dto.insert(
                "maxOutputTokens".into(),
                normalize_integer(&defaulted_value(
                    object,
                    "maxOutputTokens",
                    Value::Number(64_000.into()),
                )),
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
            dto.insert(
                "memberTags".into(),
                normalize_member_tags(defaulted_value(
                    object,
                    "memberTags",
                    Value::Object(Map::new()),
                ))?,
            );
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
            dto.insert(
                "createdAt".into(),
                normalize_integer(&defaulted_value(
                    object,
                    "createdAt",
                    Value::Number(0.into()),
                )),
            );
        }
    }
    Ok(dto)
}

pub(crate) fn mobile_topic_config_hash(key: &TopicKey, metadata: &Value) -> String {
    hash_stable_object(&mobile_topic_sync_dto(key, metadata))
}

fn mobile_topic_sync_dto(key: &TopicKey, metadata: &Value) -> Map<String, Value> {
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
            .unwrap_or_else(|| Value::Number(0.into())),
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
    dto
}

fn insert_defaulted(
    target: &mut Map<String, Value>,
    source: &Map<String, Value>,
    key: &str,
    default: Value,
) {
    target.insert(key.to_string(), defaulted_value(source, key, default));
}

fn defaulted_value(source: &Map<String, Value>, key: &str, default: Value) -> Value {
    source
        .get(key)
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or(default)
}

fn normalize_member_tags(value: Value) -> Result<Value> {
    let member_tags = value
        .as_object()
        .context("memberTags must be an object of string values")?;
    for (agent_id, tags) in member_tags {
        anyhow::ensure!(
            !agent_id.is_empty(),
            "memberTags keys must be non-empty strings"
        );
        anyhow::ensure!(
            tags.is_string(),
            "memberTags[{agent_id:?}] must be a string"
        );
    }
    Ok(value)
}

fn normalize_float(value: &Value) -> Value {
    let number = match value {
        Value::String(value) => value.parse::<f64>().ok(),
        Value::Number(value) => value.as_f64(),
        _ => None,
    };
    number
        .and_then(serde_json::Number::from_f64)
        .map(Value::Number)
        .unwrap_or(Value::Null)
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
                let number = (number * 100.0).round() / 100.0;
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
            keys.sort_unstable_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
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

fn manifest_key(identity: &ManifestIdentity) -> String {
    match identity {
        ManifestIdentity::Owner(key) => {
            format!("owner:{}:{}", key.owner_type, key.owner_id)
        }
        ManifestIdentity::Topic(key) => {
            format!("topic:{}:{}:{}", key.owner_type, key.owner_id, key.topic_id)
        }
        ManifestIdentity::Avatar(key) => {
            format!("avatar:{}:{}", key.owner_type, key.owner_id)
        }
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
    use std::{
        collections::{HashMap, HashSet},
        fs,
        sync::Arc,
    };

    use super::{
        avatar_manifest, ensure_topic_manifest_row_healthy, load_message_states,
        load_topic_manifest_row, manifest, message_diff, mobile_owner_config_hash_from_value,
        owner_content_hash, owner_manifest, pull_entities, pull_topic_messages,
        push_topic_messages, stable_stringify, topic_diff, topic_manifest, topic_manifests,
        AvatarManifestState, EntitiesPullRequest, EntityPullItem, ManifestIdentity, ManifestItem,
        ManifestRequest, ManifestResponse, MessageDeletedState, MessageDiffRequest,
        MessageDiffResult, MessageDiffState, MessageLiveState, MessageVersionState,
        MessagesPullTopic, MessagesPushTopic, OwnerManifestState, TopicDiffRequest, TopicDiffState,
        TopicManifestState,
    };
    use crate::{
        config::{Cli, ServiceConfig},
        domain::{AvatarKey, AvatarOwnerType, OwnerKey, OwnerType, TopicKey, TopicSource},
        ingest::{sha256_hex, Reconciler},
        storage::Database,
        sync_wire::{
            aggregate_hash, canonicalize_message, message_fingerprint, stored_message_fingerprint,
            topic_leaf_hash, WireWarnings,
        },
    };
    use serde_json::{json, Value};
    use tempfile::TempDir;

    fn owner_key(owner_type: OwnerType, owner_id: &str) -> OwnerKey {
        OwnerKey {
            owner_type,
            owner_id: owner_id.to_string(),
        }
    }

    fn manifest_item_id(item: &ManifestItem) -> &str {
        match &item.identity {
            ManifestIdentity::Owner(key) => &key.owner_id,
            ManifestIdentity::Topic(key) => &key.topic_id,
            ManifestIdentity::Avatar(key) => &key.owner_id,
        }
    }

    fn manifest_item_owner_id(item: &ManifestItem) -> &str {
        match &item.identity {
            ManifestIdentity::Owner(key) => &key.owner_id,
            ManifestIdentity::Topic(key) => &key.owner_id,
            ManifestIdentity::Avatar(key) => &key.owner_id,
        }
    }

    #[test]
    fn canonical_hash_matches_the_shared_cross_language_vectors() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../VCPDistributedServer/Plugin/VCPMobileSync/fixtures/message_canonical_contract.json"
        ))
        .expect("parse canonical hash fixture");
        for case in fixture["canonicalHashCases"]
            .as_array()
            .expect("canonical hash cases")
        {
            let canonical = stable_stringify(&case["value"], "");
            assert_eq!(
                canonical,
                case["expectedCanonical"].as_str().expect("canonical bytes"),
                "case {}",
                case["name"].as_str().unwrap_or("unnamed")
            );
            assert_eq!(
                sha256_hex(canonical.as_bytes()),
                case["expectedHash"].as_str().expect("canonical hash"),
                "case {}",
                case["name"].as_str().unwrap_or("unnamed")
            );
        }
    }

    fn manifest_results(response: &ManifestResponse) -> Vec<serde_json::Value> {
        serde_json::to_value(response).expect("serialize manifest response")["results"]
            .as_array()
            .expect("manifest results")
            .clone()
    }

    fn successful_message_decision(result: &MessageDiffResult) -> &super::MessageDiffSuccess {
        let MessageDiffResult::Success(decision) = result else {
            panic!("expected successful message decision");
        };
        decision
    }

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

    fn mark_test_source_invalid(database: &Database, config: &ServiceConfig, key: TopicKey) {
        let source = TopicSource {
            source_path: config
                .user_data_dir
                .join(&key.owner_id)
                .join("topics")
                .join(&key.topic_id)
                .join("history.json"),
            key,
        };
        database
            .mark_source_invalid(&source, "boom", crate::storage::OwnerHashMode::Immediate)
            .expect("poison history source");
    }

    #[test]
    fn legacy_and_cds_share_the_message_diff_matrix() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../VCPDistributedServer/Plugin/VCPMobileSync/fixtures/message_diff_matrix.json"
        ))
        .expect("parse message diff matrix");
        for scenario in fixture["cases"].as_array().expect("matrix cases") {
            let temp = TempDir::new().expect("create matrix database directory");
            let database =
                Database::open(&temp.path().join("chat.sqlite3")).expect("open matrix database");
            let owner_type = match scenario["ownerType"].as_str().expect("ownerType") {
                "agent" => OwnerType::Agent,
                "group" => OwnerType::Group,
                other => panic!("unsupported matrix ownerType {other}"),
            };
            let owner_id = scenario["ownerId"].as_str().expect("ownerId");
            let topic_id = scenario["topicId"].as_str().expect("topicId");
            let source_path = temp.path().join(format!("missing-{topic_id}.json"));
            {
                let connection = database.connection.lock();
                connection
                    .execute(
                        "INSERT INTO owners (
                            owner_type, owner_id, display_name, config_path,
                            config_hash, content_hash, updated_at
                         ) VALUES (?1, ?2, '', '', ?3, '', 1)",
                        rusqlite::params![owner_type.as_str(), owner_id, "a".repeat(64)],
                    )
                    .expect("insert matrix owner");
                connection
                    .execute(
                        "INSERT INTO topics (
                            owner_type, owner_id, topic_id, config_hash, metadata_json,
                            content_hash, source_path, updated_at
                         ) VALUES (?1, ?2, ?3, ?4, '{}', ?5, ?6, 1)",
                        rusqlite::params![
                            owner_type.as_str(),
                            owner_id,
                            topic_id,
                            "b".repeat(64),
                            scenario["desktopContentHash"]
                                .as_str()
                                .expect("desktopContentHash"),
                            source_path.to_string_lossy(),
                        ],
                    )
                    .expect("insert matrix topic");
                for (ordinal, message) in scenario["desktopMessages"]
                    .as_array()
                    .expect("desktopMessages")
                    .iter()
                    .enumerate()
                {
                    let deleted_at = message.get("deletedAt").and_then(serde_json::Value::as_i64);
                    let updated_at = message
                        .get("updatedAt")
                        .and_then(serde_json::Value::as_i64)
                        .or(deleted_at)
                        .expect("desktop message time");
                    let message_hash = message
                        .get("messageHash")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| "0".repeat(64));
                    connection
                        .execute(
                            "INSERT INTO messages (
                                owner_type, owner_id, topic_id, msg_id, ordinal, role,
                                content_raw, content_text, timestamp, message_hash,
                                metadata_json, updated_at, deleted_at
                             ) VALUES (?1, ?2, ?3, ?4, ?5, 'user', '', '', ?6, ?7, '{}', ?6, ?8)",
                            rusqlite::params![
                                owner_type.as_str(),
                                owner_id,
                                topic_id,
                                message["msgId"].as_str().expect("msgId"),
                                ordinal as i64,
                                updated_at,
                                message_hash,
                                deleted_at,
                            ],
                        )
                        .expect("insert matrix message");
                }
            }

            let mobile_messages = scenario["mobileMessages"]
                .as_object()
                .expect("mobileMessages")
                .iter()
                .map(|(msg_id, state)| {
                    let version = if let Some(deleted_at) =
                        state.get("deletedAt").and_then(serde_json::Value::as_i64)
                    {
                        MessageVersionState::Deleted(MessageDeletedState { deleted_at })
                    } else {
                        MessageVersionState::Live(MessageLiveState {
                            message_hash: state["messageHash"]
                                .as_str()
                                .expect("messageHash")
                                .to_string(),
                            updated_at: state["updatedAt"].as_i64().expect("updatedAt"),
                        })
                    };
                    (msg_id.clone(), version)
                })
                .collect();
            let response = message_diff(
                &database,
                MessageDiffRequest {
                    topics: vec![MessageDiffState {
                        topic_id: topic_id.to_string(),
                        owner_type,
                        owner_id: owner_id.to_string(),
                        content_hash: scenario["mobileContentHash"]
                            .as_str()
                            .expect("mobileContentHash")
                            .to_string(),
                        messages: mobile_messages,
                    }],
                },
            )
            .expect("run message diff matrix");
            let decision = successful_message_decision(&response.results[0]);
            let actual = serde_json::to_value(decision).expect("serialize matrix decision");
            assert_eq!(
                actual["pullMessageIds"], scenario["expected"]["pullMessageIds"],
                "{} pullMessageIds",
                scenario["name"]
            );
            assert_eq!(
                actual["pushTopic"], scenario["expected"]["pushTopic"],
                "{} pushTopic",
                scenario["name"]
            );
            assert_eq!(
                actual["deleteMessages"], scenario["expected"]["deleteMessages"],
                "{} deleteMessages",
                scenario["name"]
            );
        }
    }

    #[test]
    fn owner_hash_normalizes_temperature_and_numeric_strings_like_mobile_legacy() {
        let base = json!({
            "name": "Nova",
            "systemPrompt": "system",
            "model": "model-a",
            "temperature": "0.704",
            "contextTokenLimit": "1000",
            "maxOutputTokens": "2000",
            "streamOutput": true
        });
        let rounded = json!({
            "name": "Nova",
            "systemPrompt": "system",
            "model": "model-a",
            "temperature": 0.70,
            "contextTokenLimit": 1000,
            "maxOutputTokens": 2000,
            "streamOutput": true
        });
        let changed = json!({
            "name": "Nova",
            "systemPrompt": "system",
            "model": "model-a",
            "temperature": 0.706,
            "contextTokenLimit": 1000,
            "maxOutputTokens": 2000,
            "streamOutput": true
        });
        let base_hash =
            mobile_owner_config_hash_from_value(OwnerType::Agent, &base).expect("hash base agent");
        assert_eq!(
            base_hash,
            "a0d2b840400413446fb02e237d21747e735ee35af2684c25667a83ac5e066c4a"
        );
        assert_eq!(
            base_hash,
            mobile_owner_config_hash_from_value(OwnerType::Agent, &rounded)
                .expect("hash rounded agent")
        );
        assert_ne!(
            base_hash,
            mobile_owner_config_hash_from_value(OwnerType::Agent, &changed)
                .expect("hash changed agent")
        );
    }

    #[test]
    fn group_owner_hash_requires_string_member_tags_with_non_empty_keys() {
        let valid = json!({
            "name": "Group",
            "members": ["agent-a"],
            "mode": "naturerandom",
            "memberTags": { "agent-a": "猫娘,科学", "历史成员": "" },
            "useUnifiedModel": false,
            "createdAt": 1
        });
        mobile_owner_config_hash_from_value(OwnerType::Group, &valid)
            .expect("hash string memberTags map");

        for member_tags in [json!({ "agent-a": ["猫娘"] }), json!({ "": "猫娘" })] {
            let invalid = json!({
                "name": "Group",
                "members": ["agent-a"],
                "mode": "naturerandom",
                "memberTags": member_tags,
                "useUnifiedModel": false,
                "createdAt": 1
            });
            assert!(mobile_owner_config_hash_from_value(OwnerType::Group, &invalid).is_err());
        }
    }

    #[test]
    fn avatar_commit_and_manifest_use_cds_state_before_owner_reconcile() {
        let (_temp, config, database, reconciler) = sync_fixture();
        let key = AvatarKey {
            owner_type: AvatarOwnerType::Agent,
            owner_id: "agent-a".to_string(),
        };
        fs::write(
            config.agents_dir.join("agent-a/avatar.png"),
            b"avatar-bytes",
        )
        .expect("write avatar");

        let committed = reconciler
            .commit_avatar(&key)
            .expect("commit avatar before owner reconcile");
        assert_eq!(committed.hash, sha256_hex(b"avatar-bytes"));
        assert_eq!(
            avatar_manifest(&database).expect("avatar manifest").len(),
            1
        );

        let remote = AvatarManifestState::Live(super::AvatarManifestLive {
            owner_type: key.owner_type,
            owner_id: key.owner_id.clone(),
            binary_hash: committed.hash,
            updated_at: committed.updated_at,
        });
        let equal = manifest(
            &database,
            ManifestRequest::Avatar {
                items: vec![remote.clone()],
            },
        )
        .expect("equal avatar manifest");
        assert!(manifest_results(&equal).is_empty());

        database
            .apply_sync_avatar_tombstone(&key, 7)
            .expect("tombstone avatar");
        assert!(reconciler.commit_avatar(&key).is_err());
        let deleted = manifest(
            &database,
            ManifestRequest::Avatar {
                items: vec![remote],
            },
        )
        .expect("deleted avatar manifest");
        let deleted = manifest_results(&deleted);
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0]["action"], "PULL_DELETE");
        assert_eq!(deleted[0]["deletedAt"], 7);
    }

    #[tokio::test]
    async fn entity_pull_uses_cds_dto_projection_and_exact_topic_owner() {
        let (_temp, config, database, reconciler) = sync_fixture();
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-a/history.json"),
            b"[]",
        )
        .expect("write history");
        reconciler.reconcile().await.expect("reconcile");

        let results = pull_entities(
            &database,
            EntitiesPullRequest {
                items: vec![
                    EntityPullItem::Owner {
                        owner_type: OwnerType::Agent,
                        owner_id: "agent-a".to_string(),
                    },
                    EntityPullItem::Topic {
                        owner_type: OwnerType::Agent,
                        owner_id: "agent-a".to_string(),
                        topic_id: "topic-a".to_string(),
                    },
                    EntityPullItem::Topic {
                        owner_type: OwnerType::Agent,
                        owner_id: "agent-missing".to_string(),
                        topic_id: "topic-a".to_string(),
                    },
                ],
            },
        );

        let results = serde_json::to_value(results).expect("serialize entity results");
        let results = results["results"].as_array().expect("entity results");
        assert_eq!(results.len(), 3);
        assert_eq!(results[0]["data"]["name"], "Agent A");
        let topic = &results[1]["data"];
        assert_eq!(topic["id"], "topic-a");
        assert_eq!(topic["ownerId"], "agent-a");
        assert_eq!(topic["locked"], true);
        assert_eq!(results[2]["ok"], false);
        assert_eq!(results[2]["error"]["code"], "ENTITY_NOT_FOUND");
    }

    fn version(hash: impl Into<String>, updated_at: i64) -> MessageVersionState {
        MessageVersionState::Live(MessageLiveState {
            message_hash: hash.into(),
            updated_at,
        })
    }

    fn deleted_version(deleted_at: i64) -> MessageVersionState {
        MessageVersionState::Deleted(MessageDeletedState { deleted_at })
    }

    #[test]
    fn mobile_fingerprint_binds_message_identity_and_state() {
        let value = json!({
            "id":"m1",
            "role":"user",
            "name":"User",
            "content":"hello",
            "timestamp":1
        });
        let mut warnings = WireWarnings::default();
        let canonical =
            canonicalize_message(value.clone(), "topic", &mut warnings).expect("canonical");
        let hash = message_fingerprint(&canonical).expect("hash");
        for (field, changed) in [
            ("id", json!("m2")),
            ("role", json!("assistant")),
            ("name", json!("Other")),
            ("timestamp", json!(2)),
        ] {
            let mut candidate = value.clone();
            candidate[field] = changed;
            let canonical = canonicalize_message(candidate, "topic", &mut warnings)
                .expect("changed canonical message");
            assert_ne!(hash, message_fingerprint(&canonical).expect("changed hash"));
        }
    }

    #[test]
    fn manifest_requires_exact_owner_identity_and_safe_wire_fields() {
        let hash = "a".repeat(64);
        let topic = |owner_type, owner_id: &str, updated_at| {
            TopicManifestState::Live(super::TopicManifestLive {
                owner_type,
                owner_id: owner_id.to_string(),
                topic_id: "topic-a".to_string(),
                config_hash: hash.clone(),
                content_hash: String::new(),
                updated_at,
            })
        };
        let split_owners = ManifestRequest::Topic {
            items: vec![
                topic(OwnerType::Agent, "agent-a", 1),
                topic(OwnerType::Group, "group-a", 1),
            ],
            targeted_owners: vec![
                owner_key(OwnerType::Agent, "agent-a"),
                owner_key(OwnerType::Group, "group-a"),
            ],
        };
        super::normalize_manifest_request(split_owners)
            .expect("same topic id under different owners is valid");

        let duplicate = ManifestRequest::Topic {
            items: vec![
                topic(OwnerType::Agent, "agent-a", 1),
                topic(OwnerType::Agent, "agent-a", 1),
            ],
            targeted_owners: vec![owner_key(OwnerType::Agent, "agent-a")],
        };
        let error = super::normalize_manifest_request(duplicate)
            .err()
            .expect("duplicate full topic identity must fail");
        assert!(error.to_string().contains("duplicate entity identity"));

        let unsafe_timestamp = ManifestRequest::Topic {
            items: vec![topic(OwnerType::Agent, "agent-a", (1_i64 << 53) + 1)],
            targeted_owners: vec![owner_key(OwnerType::Agent, "agent-a")],
        };
        let error = super::normalize_manifest_request(unsafe_timestamp)
            .err()
            .expect("unsafe timestamp must fail");
        assert!(error.to_string().contains("safe integer"));
    }

    #[tokio::test]
    async fn entity_manifest_tombstone_actions_cover_both_sources_and_presence_states() {
        let (_temp, config, database, reconciler) = sync_fixture();
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-a/history.json"),
            b"[]",
        )
        .expect("write history");
        reconciler.reconcile().await.expect("reconcile live owner");

        {
            let connection = database.connection.lock();
            for (owner_type, owner_id, deleted_at) in [
                ("group", "desktop-deleted-mobile-live", 21_i64),
                ("group", "desktop-deleted-mobile-missing", 22_i64),
            ] {
                connection
                    .execute(
                        "INSERT INTO owners (owner_type, owner_id, display_name, config_path,
                             config_hash, updated_at, deleted_at)
                         VALUES (?1, ?2, ?2, '/nonexistent/config.json', '', 1, ?3)",
                        rusqlite::params![owner_type, owner_id, deleted_at],
                    )
                    .expect("insert desktop tombstone");
            }
        }

        let hash = "a".repeat(64);
        let live = |owner_type: OwnerType, id: &str| {
            OwnerManifestState::Live(super::OwnerManifestLive {
                owner_type,
                owner_id: id.to_string(),
                config_hash: hash.clone(),
                content_hash: String::new(),
                updated_at: 1,
            })
        };
        let deleted = |owner_type: OwnerType, id: &str, deleted_at| {
            OwnerManifestState::Deleted(super::OwnerManifestDeleted {
                owner_type,
                owner_id: id.to_string(),
                deleted_at,
            })
        };
        let response = manifest(
            &database,
            ManifestRequest::Owner {
                items: vec![
                    deleted(OwnerType::Agent, "agent-a", 11),
                    deleted(OwnerType::Group, "mobile-deleted-desktop-missing", 12),
                    live(OwnerType::Group, "desktop-deleted-mobile-live"),
                ],
            },
        )
        .expect("manifest tombstone diff");
        let actions = manifest_results(&response)
            .into_iter()
            .map(|action| (action["ownerId"].as_str().unwrap().to_string(), action))
            .collect::<HashMap<_, _>>();
        assert_eq!(actions.len(), 4);

        for (owner_type, id, deleted_at) in [
            (OwnerType::Agent, "agent-a", 11_i64),
            (OwnerType::Group, "mobile-deleted-desktop-missing", 12_i64),
        ] {
            let action = &actions[id];
            assert_eq!(action["action"], "PUSH_DELETE");
            assert_eq!(action["deletedAt"], deleted_at);
            assert_eq!(action["ownerType"], owner_type.as_str());
        }
        for (owner_type, id, deleted_at) in [
            (OwnerType::Group, "desktop-deleted-mobile-live", 21_i64),
            (OwnerType::Group, "desktop-deleted-mobile-missing", 22_i64),
        ] {
            let action = &actions[id];
            assert_eq!(action["action"], "PULL_DELETE");
            assert_eq!(action["deletedAt"], deleted_at);
            assert_eq!(action["ownerType"], owner_type.as_str());
        }
    }

    #[test]
    fn topic_hash_diff_rejects_duplicate_and_malformed_states_before_db_work() {
        let (_temp, _config, database, _reconciler) = sync_fixture();
        let state = TopicDiffState {
            topic_id: "topic-a".to_string(),
            owner_type: OwnerType::Agent,
            owner_id: "agent-a".to_string(),
            config_hash: "a".repeat(64),
            content_hash: String::new(),
        };
        let duplicate = topic_diff(
            &database,
            TopicDiffRequest {
                topics: vec![state.clone(), state],
            },
        )
        .expect_err("duplicate topic state must fail");
        assert!(duplicate.to_string().contains("duplicate topic identity"));

        let malformed = topic_diff(
            &database,
            TopicDiffRequest {
                topics: vec![TopicDiffState {
                    topic_id: "topic-a".to_string(),
                    owner_type: OwnerType::Agent,
                    owner_id: "agent-a".to_string(),
                    config_hash: "not-a-hash".to_string(),
                    content_hash: String::new(),
                }],
            },
        )
        .expect_err("malformed topic hash must fail");
        assert!(malformed.to_string().contains("invalid hash"));
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
                    "finishReason":"completed",
                    "avatarUrl":"file://G:\\\\VCPChat\\\\avatar.png",
                    "avatarColor":"#desktop-local-only",
                    "model":"desktop-model",
                    "context":{"streamOperationId":"desktop-only"},
                    "attachments":[{
                        "type":"text/plain",
                        "name":"legacy.txt",
                        "size":3,
                        "src":"file:///desktop/private",
                        "_fileManagerData":{
                            "hash":valid_hash,
                            "internalPath":"file:///desktop/private",
                            "thumbnailPath":"file:///desktop/private-thumb"
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
        {
            let connection = database.connection.lock();
            connection
                .execute("UPDATE messages SET updated_at=77 WHERE msg_id='m1'", [])
                .expect("set indexed update time");
        }

        let frame = pull_topic_messages(
            &database,
            MessagesPullTopic {
                topic_id: "topic-a".to_string(),
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                message_ids: Vec::new(),
            },
        )
        .expect("pull canonical frame");
        assert_eq!(frame.owner_type, OwnerType::Agent);
        assert_eq!(frame.owner_id, "agent-a");
        assert_eq!(frame.legacy_attachment_warnings, 1);
        assert_eq!(frame.messages.len(), 2);
        assert_eq!(frame.messages[0]["updatedAt"], 77);
        assert_eq!(frame.messages[0]["attachments"][0]["hash"], "a".repeat(64));
        assert!(frame.messages[0]["attachments"][0]
            .get("_fileManagerData")
            .is_none());
        assert!(frame.messages[0].get("avatarColor").is_none());
        assert!(frame.messages[0].get("context").is_none());
        assert!(frame.messages[1].get("attachments").is_none());

        let response = push_topic_messages(
            &reconciler,
            MessagesPushTopic {
                topic_id: "topic-a".to_string(),
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                messages: vec![
                    json!({
                        "id":"m1",
                        "role":"user",
                        "content":"mobile edit",
                        "timestamp":1,
                        "updatedAt":78,
                        "avatarUrl":"file:///G:/VCPChat/avatar.png",
                        "attachments":[{
                            "type":"text/plain",
                            "src":"",
                            "name":"mobile-name.txt",
                            "size":4,
                            "_fileManagerData":{
                                "hash":"a".repeat(64),
                                "internalPath":"",
                                "extractedText":"mobile text"
                            }
                        }]
                    }),
                    json!({
                        "id":"m3",
                        "role":"user",
                        "content":"projected native",
                        "timestamp":3,
                        "updatedAt":4,
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
                    }),
                ],
                deleted_messages: Vec::new(),
            },
        )
        .await;
        assert!(response.ok);
        let persisted: Vec<serde_json::Value> =
            serde_json::from_slice(&fs::read(&history_path).expect("read history"))
                .expect("parse history");
        assert_eq!(persisted.len(), 3);
        assert_eq!(persisted[0]["content"], "mobile edit");
        assert_eq!(persisted[0]["updatedAt"], 78);
        assert_eq!(persisted[0]["avatarUrl"], "file:///G:/VCPChat/avatar.png");
        assert_eq!(persisted[0]["avatarColor"], "#desktop-local-only");
        assert_eq!(persisted[0]["model"], "desktop-model");
        assert_eq!(persisted[0]["context"]["streamOperationId"], "desktop-only");
        assert!(persisted[0].get("finishReason").is_none());
        assert_eq!(
            persisted[0]["attachments"][0]["src"],
            "file:///desktop/private"
        );
        assert_eq!(
            persisted[0]["attachments"][0]["_fileManagerData"]["internalPath"],
            "file:///desktop/private"
        );
        assert_eq!(
            persisted[0]["attachments"][0]["_fileManagerData"]["thumbnailPath"],
            "file:///desktop/private-thumb"
        );
        assert_eq!(
            persisted[0]["attachments"][0]["_fileManagerData"]["extractedText"],
            "mobile text"
        );
        assert_eq!(persisted[2]["updatedAt"], 4);
        assert_eq!(
            persisted[2]["attachments"][0]["_fileManagerData"]["hash"],
            "b".repeat(64)
        );

        let states = load_message_states(
            &database,
            &TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                topic_id: "topic-a".to_string(),
            },
        )
        .expect("message states after push");
        assert_eq!(states.len(), 3);
        assert!(states.iter().all(|message| {
            message
                .message_hash
                .as_deref()
                .is_some_and(|hash| hash.len() == 64)
        }));
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

        let delete = |m1_deleted_at, missing_deleted_at| MessagesPushTopic {
            topic_id: "topic-a".to_string(),
            owner_type: OwnerType::Agent,
            owner_id: "agent-a".to_string(),
            messages: Vec::new(),
            deleted_messages: vec![
                super::MessageTombstoneInput {
                    msg_id: "m1".to_string(),
                    deleted_at: m1_deleted_at,
                },
                super::MessageTombstoneInput {
                    msg_id: "never-seen".to_string(),
                    deleted_at: missing_deleted_at,
                },
            ],
        };

        let first = push_topic_messages(&reconciler, delete(42, 43)).await;
        assert!(first.ok);
        assert!(first
            .ingest_commit
            .as_ref()
            .is_some_and(|commit| commit.changed));
        let persisted: Vec<serde_json::Value> =
            serde_json::from_slice(&fs::read(&history_path).expect("read history"))
                .expect("parse history");
        assert!(persisted.is_empty());

        let tombstone_times = {
            let connection = database.connection.lock();
            let mut statement = connection
                .prepare(
                    "SELECT msg_id, deleted_at FROM messages
                     WHERE owner_type='agent' AND owner_id='agent-a'
                       AND topic_id='topic-a' AND deleted_at IS NOT NULL
                     ORDER BY msg_id",
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
        let states = load_message_states(
            &database,
            &TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                topic_id: "topic-a".to_string(),
            },
        )
        .expect("message states with absent-row tombstone");
        let never_seen = states
            .iter()
            .find(|message| message.msg_id == "never-seen")
            .expect("absent-row tombstone must remain visible to other clients");
        assert_eq!(never_seen.deleted_at, Some(43));
        assert!(never_seen.message_hash.is_none());

        let replay = push_topic_messages(&reconciler, delete(99, 100)).await;
        assert!(replay.ok);
        assert!(replay
            .ingest_commit
            .as_ref()
            .is_some_and(|commit| !commit.changed));
        let replay_times = {
            let connection = database.connection.lock();
            let mut statement = connection
                .prepare(
                    "SELECT msg_id, deleted_at FROM messages
                     WHERE owner_type='agent' AND owner_id='agent-a'
                       AND topic_id='topic-a' AND deleted_at IS NOT NULL
                     ORDER BY msg_id",
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

        let stale_live = push_topic_messages(
            &reconciler,
            MessagesPushTopic {
                topic_id: "topic-a".to_string(),
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                messages: vec![serde_json::json!({
                    "id": "m1",
                    "role": "user",
                    "content": "stale",
                    "timestamp": 1,
                    "updatedAt": 101
                })],
                deleted_messages: Vec::new(),
            },
        )
        .await;
        assert!(!stale_live.ok);
        assert_eq!(
            stale_live.error.as_ref().map(|error| error.code.as_str()),
            Some("SNAPSHOT_STALE")
        );
    }

    #[tokio::test]
    async fn message_diff_closes_desktop_and_mobile_tombstones_in_both_directions() {
        let (_temp, config, database, reconciler) = sync_fixture();
        let deleted_raw =
            r#"{"id":"desktop-deleted","role":"user","content":"gone","timestamp":1}"#;
        let live_raw = r#"{"id":"desktop-live","role":"assistant","content":"live","timestamp":2}"#;
        let history_path = config
            .user_data_dir
            .join("agent-a/topics/topic-a/history.json");
        fs::write(&history_path, format!("[{deleted_raw},{live_raw}]"))
            .expect("write initial history");
        reconciler.reconcile().await.expect("initial reconcile");
        fs::write(&history_path, format!("[{live_raw}]")).expect("remove desktop message");
        reconciler.reconcile().await.expect("deletion reconcile");

        let response = message_diff(
            &database,
            MessageDiffRequest {
                topics: vec![MessageDiffState {
                    topic_id: "topic-a".to_string(),
                    owner_type: OwnerType::Agent,
                    owner_id: "agent-a".to_string(),
                    content_hash: String::new(),
                    messages: HashMap::from([
                        (
                            "desktop-deleted".to_string(),
                            version(
                                stored_message_fingerprint(deleted_raw, "topic-a")
                                    .expect("mobile hash"),
                                1,
                            ),
                        ),
                        ("desktop-live".to_string(), deleted_version(1)),
                    ]),
                }],
            },
        )
        .expect("message diff");
        let decision = successful_message_decision(&response.results[0]);
        assert_eq!(decision.pull_message_ids, Vec::<String>::new());
        assert!(decision.push_topic);
        let to_delete = &decision.delete_messages;
        assert_eq!(to_delete.len(), 1);
        assert_eq!(to_delete[0].msg_id, "desktop-deleted");
        assert!(to_delete[0].deleted_at > 0);

        let wire = serde_json::to_value(decision).expect("serialize decision");
        assert_eq!(wire["deleteMessages"][0]["msgId"], "desktop-deleted");
        assert_eq!(
            wire["deleteMessages"][0]["deletedAt"],
            to_delete[0].deleted_at
        );
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
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                message_ids: Vec::new(),
            },
        )
        .expect_err("invalid source must fail closed");
        assert!(error.to_string().contains("history source is not ready"));
    }

    #[tokio::test]
    async fn ready_source_identity_mismatch_never_blesses_another_topic() {
        let (_temp, config, database, reconciler) = sync_fixture();
        let shared_topic_id = "topic-a";
        let primary_history = config
            .user_data_dir
            .join("agent-a/topics/topic-a/history.json");
        fs::write(
            &primary_history,
            br#"[{"id":"m1","role":"user","content":"primary","timestamp":1}]"#,
        )
        .expect("write primary history");
        fs::create_dir_all(config.agents_dir.join("agent-b")).expect("create second agent");
        fs::create_dir_all(config.user_data_dir.join("agent-b/topics/topic-a"))
            .expect("create second topic");
        fs::write(
            config.agents_dir.join("agent-b/config.json"),
            serde_json::to_vec(&json!({
                "name":"Agent B",
                "topics":[{"id":shared_topic_id,"name":"Shared ID","createdAt":2}]
            }))
            .expect("serialize second agent"),
        )
        .expect("write second agent config");
        fs::write(
            config
                .user_data_dir
                .join("agent-b/topics/topic-a/history.json"),
            br#"[{"id":"m2","role":"user","content":"secondary","timestamp":2}]"#,
        )
        .expect("write second history");
        reconciler.reconcile().await.expect("initial reconcile");

        database
            .connection
            .lock()
            .execute(
                "UPDATE history_sources SET owner_id='agent-b' WHERE source_path=?1",
                [primary_history.to_string_lossy().as_ref()],
            )
            .expect("misbind source identity");
        let primary_key = TopicKey {
            owner_type: OwnerType::Agent,
            owner_id: "agent-a".to_string(),
            topic_id: shared_topic_id.to_string(),
        };
        let row = load_topic_manifest_row(&database, &primary_key)
            .expect("load mismatched source manifest row");
        assert_eq!(row.source_status, None);
        assert!(ensure_topic_manifest_row_healthy(&row)
            .expect_err("mismatched ready source must be unhealthy")
            .to_string()
            .contains("exists but has not been ingested"));

        let stats = reconciler
            .reconcile()
            .await
            .expect("reconcile identity conflict");
        assert_eq!(stats.files_invalid, 1);
        let mismatched = database
            .source_metadata(&primary_history)
            .expect("load conflicted source")
            .expect("conflicted source remains visible");
        assert_eq!(mismatched.owner_id, "agent-b");
        assert_eq!(mismatched.status, "invalid");
    }

    #[tokio::test]
    async fn topic_resolution_uses_the_complete_owner_identity() {
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

        let identity = super::resolve_topic(
            &database,
            &TopicKey {
                topic_id: "topic-a".to_string(),
                owner_type: OwnerType::Group,
                owner_id: "group-a".to_string(),
            },
        )
        .expect("resolve compound identity");
        assert_eq!(identity.owner_type, OwnerType::Group);
        assert_eq!(identity.owner_id, "group-a");
    }

    /// 已删 topic 被短路（不再触碰 metadata/健康检查/content hash），
    /// 且 manifest diff 能产出 DELETE 删除信号；存活 topic 输出不变。
    #[tokio::test]
    async fn tombstoned_topic_is_short_circuited_and_emits_delete() {
        let (_temp, config, database, reconciler) = sync_fixture();
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-a/history.json"),
            br#"[{"id":"m1","role":"user","content":"alive","timestamp":1}]"#,
        )
        .expect("write history");
        reconciler.reconcile().await.expect("reconcile");

        // 直接插入墓碑 topic：source 已不存在、metadata 是坏 JSON——
        // 短路后这些都不应再被求值。
        {
            let connection = database.connection.lock();
            connection
                .execute(
                    "INSERT INTO topics (owner_type, owner_id, topic_id, topic_ordinal,
                         config_hash, metadata_json, source_path, updated_at, deleted_at)
                     VALUES ('agent','agent-a','topic-deleted',1,'','{corrupt json',
                             '/nonexistent/history.json',5,123)",
                    [],
                )
                .expect("insert tombstoned topic");
        }

        let items = topic_manifests(&database, None).expect("manifest with tombstone");
        let tombstone = items
            .iter()
            .find(|item| manifest_item_id(item) == "topic-deleted")
            .expect("tombstone entry");
        assert_eq!(tombstone.deleted_at, Some(123));
        assert!(tombstone.config_hash.is_empty());
        assert!(tombstone.content_hash.is_empty());
        let alive = items
            .iter()
            .find(|item| manifest_item_id(item) == "topic-a")
            .expect("alive entry");
        assert_eq!(alive.content_hash.len(), 64);
        assert_eq!(alive.deleted_at, None);

        // 端到端：Desktop 独有的墓碑条目让 Mobile 直接落 DELETE。
        let response = manifest(
            &database,
            ManifestRequest::Topic {
                items: Vec::new(),
                targeted_owners: vec![owner_key(OwnerType::Agent, "agent-a")],
            },
        )
        .expect("manifest diff");
        let results = manifest_results(&response);
        let action = results
            .iter()
            .find(|action| action["topicId"] == "topic-deleted")
            .expect("delete action");
        assert_eq!(action["action"], "PULL_DELETE");
        assert_eq!(action["deletedAt"], 123);
    }

    #[tokio::test]
    async fn default_topics_are_distinct_manifest_entities() {
        let (_temp, config, database, reconciler) = sync_fixture();
        // agent-a 追加 default 话题（fixture 原本只有 topic-a）。
        fs::create_dir_all(config.user_data_dir.join("agent-a/topics/default"))
            .expect("create agent-a default topic dir");
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/default/history.json"),
            br#"[{"id":"a1","role":"user","content":"hello from a","timestamp":1}]"#,
        )
        .expect("write agent-a default history");
        fs::write(
            config.app_data.join("Agents/agent-a/config.json"),
            serde_json::to_vec(&json!({
                "name": "Agent A",
                "topics": [
                    {"id":"topic-a","name":"Topic A","createdAt":1},
                    {"id":"default","name":"Default","createdAt":1}
                ]
            }))
            .expect("serialize agent-a config"),
        )
        .expect("rewrite agent-a config");
        // agent-b 只有 default 话题，与 agent-a 的 default 跨 owner 同名。
        fs::create_dir_all(config.app_data.join("Agents/agent-b")).expect("create agent-b");
        fs::create_dir_all(config.user_data_dir.join("agent-b/topics/default"))
            .expect("create agent-b default topic dir");
        fs::write(
            config.app_data.join("Agents/agent-b/config.json"),
            serde_json::to_vec(&json!({
                "name": "Agent B",
                "topics": [{"id":"default","name":"Default","createdAt":1}]
            }))
            .expect("serialize agent-b config"),
        )
        .expect("write agent-b config");
        fs::write(
            config
                .user_data_dir
                .join("agent-b/topics/default/history.json"),
            br#"[{"id":"b1","role":"user","content":"hello from b","timestamp":1}]"#,
        )
        .expect("write agent-b default history");
        reconciler.reconcile().await.expect("reconcile");

        let items = topic_manifests(
            &database,
            Some(&[
                owner_key(OwnerType::Agent, "agent-a"),
                owner_key(OwnerType::Agent, "agent-b"),
            ]),
        )
        .expect("topic manifests");
        let default_owners = items
            .iter()
            .filter(|item| manifest_item_id(item) == "default")
            .map(manifest_item_owner_id)
            .collect::<HashSet<_>>();
        assert_eq!(default_owners, HashSet::from(["agent-a", "agent-b"]));
        assert!(items.iter().any(|item| manifest_item_id(item) == "topic-a"));

        let hash = "a".repeat(64);
        let response = manifest(
            &database,
            ManifestRequest::Topic {
                items: vec![TopicManifestState::Live(super::TopicManifestLive {
                    owner_type: OwnerType::Agent,
                    owner_id: "agent-a".to_string(),
                    topic_id: "default".to_string(),
                    config_hash: hash.clone(),
                    content_hash: hash,
                    updated_at: 1,
                })],
                targeted_owners: vec![
                    owner_key(OwnerType::Agent, "agent-a"),
                    owner_key(OwnerType::Agent, "agent-b"),
                ],
            },
        )
        .expect("diff default topics");
        let default_actions = manifest_results(&response)
            .iter()
            .filter(|action| action["topicId"] == "default")
            .filter_map(|action| action["ownerId"].as_str())
            .map(str::to_string)
            .collect::<HashSet<_>>();
        assert_eq!(
            default_actions,
            HashSet::from(["agent-a".to_string(), "agent-b".to_string()])
        );
        let agent_a_messages = load_message_states(
            &database,
            &TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                topic_id: "default".to_string(),
            },
        )
        .expect("agent-a default messages");
        let agent_b_messages = load_message_states(
            &database,
            &TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent-b".to_string(),
                topic_id: "default".to_string(),
            },
        )
        .expect("agent-b default messages");
        assert_eq!(agent_a_messages[0].msg_id, "a1");
        assert_eq!(agent_b_messages[0].msg_id, "b1");
    }

    #[tokio::test]
    async fn owner_root_matches_mobile_topic_leaf_contract_with_default() {
        let (_temp, config, database, reconciler) = sync_fixture();
        fs::create_dir_all(config.user_data_dir.join("agent-a/topics/default"))
            .expect("create default topic");
        fs::create_dir_all(config.user_data_dir.join("agent-a/topics/topic-b"))
            .expect("create topic-b");
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-a/history.json"),
            br#"[{"id":"a","role":"user","content":"a","timestamp":1}]"#,
        )
        .expect("write topic-a");
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-b/history.json"),
            br#"[{"id":"b","role":"user","content":"b","timestamp":2}]"#,
        )
        .expect("write topic-b");
        let default_path = config
            .user_data_dir
            .join("agent-a/topics/default/history.json");
        fs::write(
            &default_path,
            br#"[{"id":"d","role":"user","content":"first","timestamp":3}]"#,
        )
        .expect("write default");
        fs::write(
            config.agents_dir.join("agent-a/config.json"),
            serde_json::to_vec(&json!({
                "name": "Agent A",
                "topics": [
                    {"id":"topic-b","name":"Topic B","createdAt":2},
                    {"id":"default","name":"Default","createdAt":3},
                    {"id":"topic-a","name":"Topic A","createdAt":1}
                ]
            }))
            .expect("serialize agent config"),
        )
        .expect("write agent config");

        reconciler.reconcile().await.expect("reconcile");
        let topic_a = topic_manifest(
            &database,
            &TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                topic_id: "topic-a".to_string(),
            },
        )
        .expect("topic-a manifest");
        let topic_b = topic_manifest(
            &database,
            &TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                topic_id: "topic-b".to_string(),
            },
        )
        .expect("topic-b manifest");
        let default_topic = topic_manifest(
            &database,
            &TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                topic_id: "default".to_string(),
            },
        )
        .expect("default manifest");
        let expected = aggregate_hash(vec![
            topic_leaf_hash("topic-a", &topic_a.config_hash, &topic_a.content_hash),
            topic_leaf_hash("topic-b", &topic_b.config_hash, &topic_b.content_hash),
            topic_leaf_hash(
                "default",
                &default_topic.config_hash,
                &default_topic.content_hash,
            ),
        ]);
        assert_eq!(
            owner_content_hash(&database, OwnerType::Agent, "agent-a").expect("agent root"),
            expected
        );
        fs::write(
            &default_path,
            br#"[{"id":"d","role":"user","content":"changed","timestamp":4}]"#,
        )
        .expect("change default");
        reconciler
            .reconcile()
            .await
            .expect("reconcile default change");
        assert_ne!(
            owner_content_hash(&database, OwnerType::Agent, "agent-a")
                .expect("agent root after default change"),
            expected
        );
    }

    /// 已删 owner（目录已物理删除）不再炸掉 owner manifest。
    #[tokio::test]
    async fn tombstoned_owner_is_short_circuited_without_disk_read() {
        let (_temp, config, database, reconciler) = sync_fixture();
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-a/history.json"),
            b"[]",
        )
        .expect("write history");
        reconciler.reconcile().await.expect("reconcile");

        {
            let connection = database.connection.lock();
            connection
                .execute(
                    "INSERT INTO owners (owner_type, owner_id, display_name, config_path,
                         config_hash, updated_at, deleted_at)
                     VALUES ('group','group-deleted','Deleted Group',
                             '/nonexistent/group/config.json','',7,321)",
                    [],
                )
                .expect("insert tombstoned owner");
        }

        let items = owner_manifest(&database).expect("owner manifest");
        let tombstone = items
            .iter()
            .find(|item| manifest_item_id(item) == "group-deleted")
            .expect("tombstone entry");
        assert_eq!(tombstone.deleted_at, Some(321));
        assert!(tombstone.config_hash.is_empty() && tombstone.content_hash.is_empty());

        // 存活 owner 路径不受影响。
        let agents = owner_manifest(&database).expect("owner manifest");
        let alive = agents
            .iter()
            .find(|item| manifest_item_id(item) == "agent-a")
            .expect("alive agent");
        assert_eq!(alive.config_hash.len(), 64);
    }

    /// Topic Validation 无法读取已提交状态时直接失败，与 Legacy 保持一致。
    #[tokio::test]
    async fn topic_hash_diff_fails_when_committed_topic_is_unhealthy() {
        let (_temp, config, database, reconciler) = sync_fixture();
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-a/history.json"),
            br#"[{"id":"m1","role":"user","content":"alive","timestamp":1}]"#,
        )
        .expect("write history");
        reconciler.reconcile().await.expect("reconcile");

        // 把 source 标记为 invalid → topic_manifest 必然失败。
        mark_test_source_invalid(
            &database,
            &config,
            TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                topic_id: "topic-a".to_string(),
            },
        );

        let error = topic_diff(
            &database,
            TopicDiffRequest {
                topics: vec![TopicDiffState {
                    topic_id: "topic-a".to_string(),
                    owner_type: OwnerType::Agent,
                    owner_id: "agent-a".to_string(),
                    config_hash: "a".repeat(64),
                    content_hash: "f".repeat(64),
                }],
            },
        )
        .expect_err("unhealthy topic must fail topic validation");
        assert!(error.to_string().contains("topic hash diff could not read"));
    }

    /// 墓碑行不再伪造 live Hash；残留的 removed metadata 也不会被解析。
    #[tokio::test]
    async fn message_states_keep_tombstones_separate_from_live_hashes() {
        let (_temp, config, database, reconciler) = sync_fixture();
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-a/history.json"),
            br#"[
                {"id":"m1","role":"user","content":"one","timestamp":1},
                {"id":"m2","role":"assistant","content":"two","timestamp":2}
            ]"#,
        )
        .expect("write history");
        reconciler.reconcile().await.expect("reconcile");

        {
            let connection = database.connection.lock();
            connection
                .execute("UPDATE messages SET deleted_at=99 WHERE msg_id='m1'", [])
                .expect("tombstone m1");
            // metadata 里残留 status:"removed"——canonicalize 必炸的形态，
            // 但 deleted 行短路后不应再被解析。
            connection
                .execute(
                    "INSERT INTO messages (owner_type, owner_id, topic_id, msg_id, ordinal,
                         role, content_raw, content_text, message_hash, metadata_json,
                         updated_at, deleted_at)
                     VALUES ('agent','agent-a','topic-a','m-gone',3,'user','','','x',
                             '{\"id\":\"m-gone\",\"role\":\"user\",\"content\":\"gone\",\"timestamp\":3,\"status\":\"removed\"}',
                             5,100)",
                    [],
                )
                .expect("insert removed tombstone row");
        }

        let states = load_message_states(
            &database,
            &TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                topic_id: "topic-a".to_string(),
            },
        )
        .expect("message states with tombstones");
        let by_id: HashMap<_, _> = states
            .iter()
            .map(|message| (message.msg_id.as_str(), message))
            .collect();
        assert!(by_id["m1"].message_hash.is_none());
        assert_eq!(by_id["m1"].deleted_at, Some(99));
        assert!(by_id["m-gone"].message_hash.is_none());
        assert_eq!(by_id["m-gone"].deleted_at, Some(100));
        assert_eq!(by_id["m2"].message_hash.as_deref().unwrap().len(), 64);
        assert_eq!(by_id["m2"].deleted_at, None);
    }

    /// 无法 wire 化的物理消息不能伪装成合法 messageHash；整份 history 保持未提交，
    /// 已有 source 健康状态负责阻止旧 SQLite 镜像参与同步。
    #[tokio::test]
    async fn live_poison_message_marks_source_invalid_without_fake_hash() {
        let (_temp, config, database, reconciler) = sync_fixture();
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-a/history.json"),
            br#"[{"id":"m1","role":"user","content":"healthy","timestamp":1},{"role":"user","content":"no id","timestamp":5}]"#,
        )
        .expect("write history with poison row");
        let stats = reconciler.reconcile().await.expect("reconcile");
        assert_eq!(stats.files_invalid, 1);

        let key = TopicKey {
            owner_type: OwnerType::Agent,
            owner_id: "agent-a".to_string(),
            topic_id: "topic-a".to_string(),
        };
        let connection = database.connection.lock();
        let (message_count, status): (i64, String) = connection
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM messages
                     WHERE owner_type='agent' AND owner_id='agent-a' AND topic_id='topic-a'),
                    (SELECT status FROM history_sources
                     WHERE owner_type='agent' AND owner_id='agent-a' AND topic_id='topic-a')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read rejected source state");
        drop(connection);
        assert_eq!(message_count, 0);
        assert_eq!(status, "invalid");
        assert!(load_message_states(&database, &key).is_err());
    }

    /// 活 topic 的 source 不健康时，topic_manifests 不再整批 500，
    /// 降级为哨兵条目；比对逻辑据此产出 PULL（ts 仲裁稳态偏向），健康 topic
    /// 输出逐字节不变。
    #[tokio::test]
    async fn unhealthy_live_topic_degrades_to_sentinel_and_pulls() {
        let (_temp, config, database, reconciler) = sync_fixture();
        // 第二个健康 topic 作为"零变化"对照。
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-a/history.json"),
            br#"[{"id":"m1","role":"user","content":"a","timestamp":1}]"#,
        )
        .expect("write topic-a history");
        fs::create_dir_all(config.user_data_dir.join("agent-a/topics/topic-b"))
            .expect("create topic-b dir");
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-b/history.json"),
            br#"[{"id":"m2","role":"user","content":"b","timestamp":2}]"#,
        )
        .expect("write topic-b history");
        fs::write(
            config.app_data.join("Agents/agent-a/config.json"),
            serde_json::to_vec(&json!({
                "name": "Agent A",
                "topics": [
                    {"id":"topic-a","name":"Topic A","createdAt":1},
                    {"id":"topic-b","name":"Topic B","createdAt":2}
                ]
            }))
            .expect("serialize config"),
        )
        .expect("write config");
        reconciler.reconcile().await.expect("reconcile");

        // 基线：毒化前健康 topic 的配置与内容指纹。
        let baseline = topic_manifests(&database, None).expect("baseline manifest");
        let baseline_a_config = baseline
            .iter()
            .find(|item| manifest_item_id(item) == "topic-a")
            .map(|item| item.config_hash.clone())
            .expect("baseline topic-a");
        let baseline_b = baseline
            .iter()
            .find(|item| manifest_item_id(item) == "topic-b")
            .map(|item| (item.config_hash.clone(), item.content_hash.clone()))
            .expect("baseline topic-b");

        // 毒化 topic-a 的 source（对齐 S5 的 invalid 毒态）。
        mark_test_source_invalid(
            &database,
            &config,
            TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                topic_id: "topic-a".to_string(),
            },
        );

        // 整批不再失败；topic-a 保留配置提交 Hash，仅内容降级为确定性哨兵。
        let items = topic_manifests(&database, None).expect("manifest must not 500");
        let degraded_a = items
            .iter()
            .find(|item| manifest_item_id(item) == "topic-a")
            .expect("degraded topic-a entry");
        let sentinel = sha256_hex(b"vcp-unhealthy-topic:agent:agent-a:topic-a");
        assert_eq!(degraded_a.config_hash, baseline_a_config);
        assert_eq!(degraded_a.content_hash, sentinel);
        assert_eq!(degraded_a.deleted_at, None);
        // 健康 topic 逐字节不变。
        let after_b = items
            .iter()
            .find(|item| manifest_item_id(item) == "topic-b")
            .map(|item| (item.config_hash.clone(), item.content_hash.clone()))
            .expect("topic-b after degradation");
        assert_eq!(after_b, baseline_b);

        // 端到端：remote 存活且 ts 旧 → 哨兵 config_hash 迫使出 PULL。
        let response = manifest(
            &database,
            ManifestRequest::Topic {
                items: vec![TopicManifestState::Live(super::TopicManifestLive {
                    owner_type: OwnerType::Agent,
                    owner_id: "agent-a".to_string(),
                    topic_id: "topic-a".to_string(),
                    config_hash: "a".repeat(64),
                    content_hash: "b".repeat(64),
                    updated_at: 1,
                })],
                targeted_owners: vec![owner_key(OwnerType::Agent, "agent-a")],
            },
        )
        .expect("manifest diff with unhealthy topic");
        let results = manifest_results(&response);
        let action = results
            .iter()
            .find(|action| action["topicId"] == "topic-a")
            .expect("topic-a action");
        assert_eq!(action["action"], "PULL");
        assert_eq!(action["ownerType"], "agent");
        assert_eq!(action["ownerId"], "agent-a");
    }

    /// 降级 topic 遇 Mobile 墓碑仍出 PUSH_DELETE（删除语义不被
    /// 哨兵吞掉）；手机没有该 topic 时尾部循环出 PULL（进入 per-topic 隔离管线）。
    #[tokio::test]
    async fn unhealthy_topic_delete_precedence_and_tail_pull() {
        let (_temp, config, database, reconciler) = sync_fixture();
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-a/history.json"),
            br#"[{"id":"m1","role":"user","content":"a","timestamp":1}]"#,
        )
        .expect("write history");
        reconciler.reconcile().await.expect("reconcile");
        mark_test_source_invalid(
            &database,
            &config,
            TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                topic_id: "topic-a".to_string(),
            },
        );

        // Mobile 已删 → PUSH_DELETE 优先于降级，随后由 Mobile NotifyDelete Desktop。
        let response = manifest(
            &database,
            ManifestRequest::Topic {
                items: vec![TopicManifestState::Deleted(super::TopicManifestDeleted {
                    owner_type: OwnerType::Agent,
                    owner_id: "agent-a".to_string(),
                    topic_id: "topic-a".to_string(),
                    deleted_at: 7,
                })],
                targeted_owners: vec![owner_key(OwnerType::Agent, "agent-a")],
            },
        )
        .expect("manifest with remote tombstone");
        let results = manifest_results(&response);
        let action = results
            .iter()
            .find(|action| action["topicId"] == "topic-a")
            .expect("push delete action");
        assert_eq!(action["action"], "PUSH_DELETE");
        assert_eq!(action["deletedAt"], 7);

        // remote 不含该 topic → 尾部循环对降级条目出 PULL。
        let response = manifest(
            &database,
            ManifestRequest::Topic {
                items: Vec::new(),
                targeted_owners: vec![owner_key(OwnerType::Agent, "agent-a")],
            },
        )
        .expect("manifest with empty remote");
        let results = manifest_results(&response);
        let action = results
            .iter()
            .find(|action| action["topicId"] == "topic-a")
            .expect("tail action");
        assert_eq!(action["action"], "PULL");
    }

    /// owner_content_hash 聚合内单 topic 失败降级为哨兵——
    /// owner manifest 不再整批 500；毒化经既有 content-only 分支转译为
    /// SKIP+contentHashMismatch；兄弟 owner 逐字节不变。
    #[tokio::test]
    async fn owner_content_hash_sentinel_keeps_owner_manifest_alive() {
        let (_temp, config, database, reconciler) = sync_fixture();
        // agent-a 增开 topic-b；另建健康 owner agent-b 作对照。
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-a/history.json"),
            br#"[{"id":"m1","role":"user","content":"a","timestamp":1}]"#,
        )
        .expect("write topic-a history");
        fs::create_dir_all(config.user_data_dir.join("agent-a/topics/topic-b"))
            .expect("create topic-b dir");
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-b/history.json"),
            br#"[{"id":"m2","role":"user","content":"b","timestamp":2}]"#,
        )
        .expect("write topic-b history");
        fs::write(
            config.app_data.join("Agents/agent-a/config.json"),
            serde_json::to_vec(&json!({
                "name": "Agent A",
                "topics": [
                    {"id":"topic-a","name":"Topic A","createdAt":1},
                    {"id":"topic-b","name":"Topic B","createdAt":2}
                ]
            }))
            .expect("serialize config"),
        )
        .expect("write agent-a config");
        fs::create_dir_all(config.app_data.join("Agents/agent-b")).expect("create agent-b");
        fs::create_dir_all(config.user_data_dir.join("agent-b/topics/topic-c"))
            .expect("create topic-c dir");
        fs::write(
            config.app_data.join("Agents/agent-b/config.json"),
            serde_json::to_vec(&json!({
                "name": "Agent B",
                "topics": [{"id":"topic-c","name":"Topic C","createdAt":3}]
            }))
            .expect("serialize config"),
        )
        .expect("write agent-b config");
        fs::write(
            config
                .user_data_dir
                .join("agent-b/topics/topic-c/history.json"),
            br#"[{"id":"m3","role":"user","content":"c","timestamp":3}]"#,
        )
        .expect("write topic-c history");
        reconciler.reconcile().await.expect("reconcile");

        let baseline_agents = owner_manifest(&database).expect("baseline");
        let baseline_a = baseline_agents
            .iter()
            .find(|item| manifest_item_id(item) == "agent-a")
            .map(|item| item.content_hash.clone())
            .expect("baseline agent-a");
        let baseline_b = baseline_agents
            .iter()
            .find(|item| manifest_item_id(item) == "agent-b")
            .map(|item| (item.config_hash.clone(), item.content_hash.clone()))
            .expect("baseline agent-b");

        mark_test_source_invalid(
            &database,
            &config,
            TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                topic_id: "topic-a".to_string(),
            },
        );

        // owner manifest 不再失败；毒 topic 的 keyed 叶子保留配置 Hash 并使用
        // content 哨兵，健康 topic 仍以 topicId + config/content 参与聚合。
        let agents = owner_manifest(&database).expect("manifest must not 500");
        let poisoned_a = agents
            .iter()
            .find(|item| manifest_item_id(item) == "agent-a")
            .expect("agent-a entry");
        let healthy_b = topic_manifest(
            &database,
            &TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                topic_id: "topic-b".to_string(),
            },
        )
        .expect("topic-b manifest");
        let degraded_a = topic_manifest(
            &database,
            &TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                topic_id: "topic-a".to_string(),
            },
        )
        .expect("topic-a degraded manifest");
        let sentinel = sha256_hex(b"vcp-unhealthy-topic:agent:agent-a:topic-a");
        let expected = aggregate_hash(vec![
            topic_leaf_hash("topic-a", &degraded_a.config_hash, &sentinel),
            topic_leaf_hash("topic-b", &healthy_b.config_hash, &healthy_b.content_hash),
        ]);
        assert_eq!(poisoned_a.content_hash, expected);
        assert_eq!(poisoned_a.config_hash.len(), 64);
        // 兄弟 owner 逐字节不变。
        let after_b = agents
            .iter()
            .find(|item| manifest_item_id(item) == "agent-b")
            .map(|item| (item.config_hash.clone(), item.content_hash.clone()))
            .expect("agent-b after");
        assert_eq!(after_b, baseline_b);

        // 效果链：config 相等 + content 毒化 → 既有分支出 SKIP+contentHashMismatch。
        let response = manifest(
            &database,
            ManifestRequest::Owner {
                items: vec![OwnerManifestState::Live(super::OwnerManifestLive {
                    owner_type: OwnerType::Agent,
                    owner_id: "agent-a".to_string(),
                    config_hash: poisoned_a.config_hash.clone(),
                    content_hash: "0".repeat(64),
                    updated_at: 1,
                })],
            },
        )
        .expect("owner manifest diff");
        let results = manifest_results(&response);
        let action = results
            .iter()
            .find(|action| action["ownerId"] == "agent-a")
            .expect("agent-a action");
        assert_eq!(action["action"], "SKIP");
        assert_eq!(action["contentHashMismatch"], true);

        reconciler.reconcile().await.expect("heal source state");
        let healed_a = owner_manifest(&database)
            .expect("healed owner manifest")
            .into_iter()
            .find(|item| manifest_item_id(item) == "agent-a")
            .expect("healed agent-a");
        assert_eq!(healed_a.content_hash, baseline_a);
    }

    /// Manifest 只使用 CDS 已提交的 DTO hash，不在读取阶段重算物理 config。
    #[tokio::test]
    async fn owner_manifest_uses_committed_config_hash() {
        let (_temp, config, database, reconciler) = sync_fixture();
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-a/history.json"),
            br#"[{"id":"m1","role":"user","content":"a","timestamp":1}]"#,
        )
        .expect("write history");
        reconciler.reconcile().await.expect("reconcile");

        let before = owner_manifest(&database)
            .expect("baseline manifest")
            .into_iter()
            .find(|item| manifest_item_id(item) == "agent-a")
            .expect("baseline owner");

        // reconcile 间隙删掉 config（目录还在、行还是活的）。
        fs::remove_file(config.app_data.join("Agents/agent-a/config.json")).expect("remove config");

        let agents = owner_manifest(&database).expect("manifest must not 500");
        let after = agents
            .iter()
            .find(|item| manifest_item_id(item) == "agent-a")
            .expect("owner after physical removal");
        assert_eq!(after.config_hash, before.config_hash);
        assert_eq!(after.content_hash, before.content_hash);
        assert_eq!(after.updated_at, before.updated_at);
    }

    /// 删除语义不依赖物理 config 是否仍可读取。
    #[tokio::test]
    async fn owner_delete_precedence_does_not_read_physical_config() {
        let (_temp, config, database, reconciler) = sync_fixture();
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-a/history.json"),
            br#"[{"id":"m1","role":"user","content":"a","timestamp":1}]"#,
        )
        .expect("write history");
        reconciler.reconcile().await.expect("reconcile");
        fs::remove_file(config.app_data.join("Agents/agent-a/config.json")).expect("remove config");

        let response = manifest(
            &database,
            ManifestRequest::Owner {
                items: vec![OwnerManifestState::Deleted(super::OwnerManifestDeleted {
                    owner_type: OwnerType::Agent,
                    owner_id: "agent-a".to_string(),
                    deleted_at: 9,
                })],
            },
        )
        .expect("manifest with remote tombstone");
        let results = manifest_results(&response);
        let action = results
            .iter()
            .find(|action| action["ownerId"] == "agent-a")
            .expect("push delete action");
        assert_eq!(action["action"], "PUSH_DELETE");
        assert_eq!(action["deletedAt"], 9);
    }
}
