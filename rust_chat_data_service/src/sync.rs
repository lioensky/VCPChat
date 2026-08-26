use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{
    domain::{AvatarKey, AvatarOwnerType, OwnerKey, OwnerType, TopicKey},
    ingest::{sha256_hex, Reconciler},
    storage::{Database, IngestCommit},
    sync_wire::{canonicalize_for_wire, canonicalize_message, message_fingerprint, WireWarnings},
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicSelector {
    pub topic_id: String,
    #[serde(default)]
    pub owner_type: Option<OwnerType>,
    #[serde(default)]
    pub owner_id: Option<String>,
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
    pub changed: bool,
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

fn load_message_states(database: &Database, key: &TopicKey) -> Result<Vec<IndexedMessageState>> {
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
            let message_hash = if deleted_at.is_some() {
                None
            } else {
                // 存活行单条失败降级为哨兵哈希（永不匹配 → 保守重拉），
                // 不再单条毒化整个 topic 的 manifest。
                Some(message_hash_or_sentinel(&metadata, &key.topic_id, &msg_id))
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
                        code: "ENTITY_READ_FAILED".to_string(),
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
            anyhow::ensure!(
                hash_stable_object(&dto) == committed_hash,
                "owner config changed after its manifest was committed"
            );
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
    anyhow::ensure!(
        request.topics.len() <= 10_000,
        "topic hash diff exceeds 10000 topics"
    );
    let mut changed_topics = Vec::new();
    let mut seen_topics = HashSet::new();
    for state in request.topics {
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
        let requested_key = TopicKey {
            owner_type: state.owner_type,
            owner_id: state.owner_id,
            topic_id: state.topic_id,
        };
        anyhow::ensure!(
            seen_topics.insert(requested_key.clone()),
            "topic hash diff contains a duplicate topic identity"
        );
        let local_config_hash = {
            let connection = database.connection.lock();
            connection
                .query_row(
                    "SELECT config_hash FROM topics
                     WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3
                       AND deleted_at IS NULL",
                    params![
                        requested_key.owner_type.as_str(),
                        &requested_key.owner_id,
                        &requested_key.topic_id
                    ],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
        };
        let Some(local_config_hash) = local_config_hash else {
            changed_topics.push(requested_key);
            continue;
        };
        let local_content_hash =
            topic_content_hash(database, &requested_key).with_context(|| {
                format!(
                    "topic hash diff could not read {}/{}/{}",
                    requested_key.owner_type.as_str(),
                    requested_key.owner_id,
                    requested_key.topic_id
                )
            })?;
        if local_config_hash != state.config_hash || local_content_hash != state.content_hash {
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

pub fn message_diff(
    database: &Database,
    request: MessageDiffRequest,
) -> Result<MessageDiffResponse> {
    anyhow::ensure!(
        request.topics.len() <= 10_000,
        "message diff exceeds 10000 topics"
    );
    let mut results = Vec::with_capacity(request.topics.len());
    let mut seen_topics = HashSet::new();
    let mut total_messages = 0_usize;
    for state in request.topics {
        let requested_key = TopicKey {
            owner_type: state.owner_type,
            owner_id: state.owner_id.clone(),
            topic_id: state.topic_id.clone(),
        };
        anyhow::ensure!(
            !requested_key.topic_id.is_empty(),
            "message diff topicId must be non-empty"
        );
        anyhow::ensure!(
            !requested_key.owner_id.is_empty(),
            "message diff ownerId must be non-empty"
        );
        anyhow::ensure!(
            seen_topics.insert(requested_key.clone()),
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
            requested_key.topic_id
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
                        requested_key.topic_id
                    );
                    validate_manifest_time(version.updated_at, "message updatedAt")?;
                }
                MessageVersionState::Deleted(version) => {
                    validate_manifest_time(version.deleted_at, "message deletedAt")?;
                }
            }
        }
        let selector = TopicSelector {
            topic_id: requested_key.topic_id.clone(),
            owner_type: Some(requested_key.owner_type),
            owner_id: Some(requested_key.owner_id.clone()),
        };
        let key = match resolve_topic(database, &selector) {
            Ok(key) => key,
            Err(error) => {
                results.push(MessageDiffResult::failure(
                    &requested_key,
                    "TOPIC_NOT_FOUND",
                    format!("{error:#}"),
                ));
                continue;
            }
        };

        let local_topic = match topic_manifest(database, &key) {
            Ok(local_topic) => local_topic,
            Err(error) => {
                results.push(MessageDiffResult::failure(
                    &requested_key,
                    "TOPIC_HASH_FAILED",
                    format!("{error:#}"),
                ));
                continue;
            }
        };
        let indexed_messages = match load_message_states(database, &key) {
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

pub fn pull_topic_messages(
    database: &Database,
    topic: MessagesPullTopic,
) -> Result<MessagesPullFrame> {
    let selector = TopicSelector {
        topic_id: topic.topic_id.clone(),
        owner_type: Some(topic.owner_type),
        owner_id: Some(topic.owner_id),
    };
    let key = resolve_topic(database, &selector)?;
    ensure_topic_sync_source_healthy(database, &key)?;
    anyhow::ensure!(
        topic.message_ids.len() <= 10_000,
        "topic message request exceeds 10000 ids"
    );
    let wanted = topic.message_ids.into_iter().collect::<HashSet<_>>();
    let connection = database.connection.lock();
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
    drop(statement);
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
        let mut canonical = canonicalize_for_wire(value, &key.topic_id, &mut warnings)?;
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
            changed: commit.changed,
            error: None,
        },
        Err(error) => MessagesPushResult {
            topic_id: topic.topic_id,
            owner_type: topic.owner_type,
            owner_id: topic.owner_id,
            ok: false,
            changed: false,
            error: Some(SyncItemError {
                code: "MESSAGE_WRITE_FAILED".to_string(),
                message: format!("{error:#}"),
                retryable: false,
            }),
        },
    }
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
        &TopicSelector {
            topic_id: topic.topic_id.clone(),
            owner_type: Some(topic.owner_type),
            owner_id: Some(topic.owner_id.clone()),
        },
    )?;
    ensure_topic_sync_source_healthy(reconciler.database(), &key)?;
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
    if let Some(revision) = reconciler
        .database()
        .apply_explicit_message_tombstones(&key, &explicit_tombstones)?
    {
        commit.changed = true;
        commit.revision = revision;
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
        "SELECT owner_type, owner_id, config_hash, updated_at, deleted_at
         FROM owners
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
    drop(statement);
    drop(connection);

    rows.into_iter()
        .map(
            |(raw_owner_type, owner_id, config_hash, updated_at, deleted_at)| {
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
                let content_hash = match owner_content_hash(database, owner_type, &owner_id) {
                    Ok(content_hash) => content_hash,
                    Err(error) => {
                        tracing::warn!(
                            owner_type = %owner_type.as_str(),
                            owner_id = %owner_id,
                            error = %format!("{error:#}"),
                            "owner manifest content hash degraded"
                        );
                        String::new()
                    }
                };
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
    let connection = database.connection.lock();
    let mut statement = connection.prepare(
        "SELECT owner_type, owner_id, topic_id
         FROM topics
         ORDER BY owner_type, owner_id, topic_id",
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

    let targeted_owners =
        targeted_owners.map(|owners| owners.iter().cloned().collect::<HashSet<_>>());
    keys.into_iter()
        .filter(|key| {
            targeted_owners.as_ref().is_none_or(|owners| {
                owners.contains(&OwnerKey {
                    owner_type: key.owner_type,
                    owner_id: key.owner_id.clone(),
                })
            })
        })
        .map(|key| topic_manifest(database, &key))
        .collect()
}

fn topic_manifest(database: &Database, key: &TopicKey) -> Result<ManifestItem> {
    let connection = database.connection.lock();
    let (config_hash, updated_at, deleted_at): (String, i64, Option<i64>) = connection.query_row(
        "SELECT config_hash, updated_at, deleted_at
         FROM topics
         WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3",
        params![key.owner_type.as_str(), key.owner_id, key.topic_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    drop(connection);
    // 墓碑条目短路：删除信号只需要完整身份和 deleted_at，
    // manifest diff 与移动端均不消费墓碑的配置或内容指纹；跳过 metadata
    // 解析、健康检查与 content hash，避免已删 topic 炸掉整批 manifest。
    if deleted_at.is_some() {
        return Ok(ManifestItem {
            identity: ManifestIdentity::Topic(key.clone()),
            config_hash: "a".repeat(64),
            content_hash: String::new(),
            updated_at,
            deleted_at,
        });
    }
    let content_hash = match topic_content_hash(database, key) {
        Ok(content_hash) => content_hash,
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
        config_hash,
        content_hash,
        updated_at,
        deleted_at,
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
         WHERE owner_type=?1 AND owner_id=?2 AND deleted_at IS NULL
         ORDER BY topic_id ASC",
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
        let key = TopicKey {
            owner_type,
            owner_id: owner_id.to_string(),
            topic_id,
        };
        // topic_manifest 会保留已提交 config hash，并把不健康消息源降级为
        // content 哨兵；只有连 Topic 提交视图都无法读取时才使用双哨兵。
        // 两种情况都继续参与 Owner 聚合，不让单个 Topic 炸掉整表 Manifest。
        match topic_manifest(database, &key) {
            Ok(topic) => {
                hashes.push(topic_leaf_hash(
                    &key.topic_id,
                    &topic.config_hash,
                    &topic.content_hash,
                ));
            }
            Err(error) => {
                tracing::warn!(
                    owner_type = %owner_type.as_str(),
                    owner_id = %owner_id,
                    topic_id = %key.topic_id,
                    error = %format!("{error:#}"),
                    "topic manifest failed during owner aggregation; using sentinel hashes"
                );
                let sentinel = unhealthy_topic_sentinel_hash(&key);
                hashes.push(topic_leaf_hash(&key.topic_id, &sentinel, &sentinel));
            }
        }
    }
    Ok(aggregate_hash(hashes))
}

fn topic_content_hash(database: &Database, key: &TopicKey) -> Result<String> {
    ensure_topic_sync_source_healthy(database, key)?;
    let connection = database.connection.lock();
    let mut statement = connection.prepare(
        "SELECT msg_id, metadata_json FROM messages
         WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3 AND deleted_at IS NULL",
    )?;
    let rows = statement
        .query_map(
            params![key.owner_type.as_str(), key.owner_id, key.topic_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    drop(connection);
    // 单条毒消息降级为哨兵哈希参与聚合，不再炸掉 topic/owner 整表 manifest。
    // 哨兵永不可能等于移动端的诚实哈希 → topic 判定 changed → 经 diff/pull 暴露，
    // 实际传输层（pull）仍 fail-closed，毒数据不会到达手机。
    let hashes = rows
        .into_iter()
        .enumerate()
        .map(|(index, (message_id, raw))| {
            let message_hash = message_hash_or_sentinel(&raw, &key.topic_id, &index.to_string());
            message_leaf_hash(&message_id, &message_hash)
        })
        .collect::<Vec<_>>();
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

/// 存活行降级：一条无法 wire 化的消息在清单/聚合哈希中的哨兵值。
/// 哨兵 = sha256("vcp-invalid-message:" + raw)，保证：
/// - 64 位小写 hex，可通过 wire 哈希格式校验；
/// - 内容由 raw 派生 → 同一毒行每次同步得到同一哨兵，不会哈希抖动；
/// - 前驱带污染标记，实践中不可能等于诚实内容哈希 → 移动端永远判定
///   changed → 走 diff/pull 暴露问题（传输层 fail-closed 不变），而非静默一致。
fn message_hash_or_sentinel(raw: &str, topic_id: &str, msg_hint: &str) -> String {
    match mobile_message_hash_from_json(raw, topic_id) {
        Ok(hash) => hash,
        Err(error) => {
            tracing::warn!(
                topic_id = %topic_id,
                msg = %msg_hint,
                error = %format!("{error:#}"),
                "message cannot cross sync wire; emitting sentinel hash"
            );
            sha256_hex(format!("vcp-invalid-message:{raw}").as_bytes())
        }
    }
}

/// Topic 级哨兵哈希：活 topic 的 source 不健康时用于
/// manifest 条目（topic_manifests 降级）与 owner 聚合（owner_content_hash
/// 降级）。与消息级哨兵同理：确定性（同 topic 每轮同值）、64-hex 合规、
/// 永不可能等于移动端的诚实哈希 → 比对必判 changed → 进入 per-topic
/// 隔离管线暴露问题，而非静默一致或整表 500。
fn unhealthy_topic_sentinel_hash(key: &TopicKey) -> String {
    sha256_hex(
        format!(
            "vcp-unhealthy-topic:{}:{}:{}",
            key.owner_type.as_str(),
            key.owner_id,
            key.topic_id
        )
        .as_bytes(),
    )
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

fn message_leaf_hash(message_id: &str, message_hash: &str) -> String {
    sha256_hex(
        stable_stringify(
            &serde_json::json!({
                "id": message_id,
                "hash": message_hash,
            }),
            "",
        )
        .as_bytes(),
    )
}

fn topic_leaf_hash(topic_id: &str, config_hash: &str, content_hash: &str) -> String {
    sha256_hex(
        stable_stringify(
            &serde_json::json!({
                "topicId": topic_id,
                "configHash": config_hash,
                "contentHash": content_hash,
            }),
            "",
        )
        .as_bytes(),
    )
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
        aggregate_hash, avatar_manifest, load_message_states, manifest, message_diff,
        message_leaf_hash, mobile_message_hash_from_json, mobile_owner_config_hash_from_value,
        owner_content_hash, owner_manifest, pull_entities, pull_topic_messages,
        push_topic_messages, topic_content_hash, topic_diff, topic_leaf_hash, topic_manifest,
        topic_manifests, AvatarManifestState, EntitiesPullRequest, EntityPullItem,
        ManifestIdentity, ManifestItem, ManifestRequest, ManifestResponse, MessageDeletedState,
        MessageDiffRequest, MessageDiffResult, MessageDiffState, MessageLiveState,
        MessageVersionState, MessagesPullTopic, MessagesPushTopic, OwnerManifestState,
        TopicDiffRequest, TopicDiffState, TopicManifestState, TopicSelector,
    };
    use crate::{
        config::{Cli, ServiceConfig},
        domain::{AvatarKey, AvatarOwnerType, OwnerKey, OwnerType, TopicKey},
        ingest::{sha256_hex, Reconciler},
        storage::Database,
        sync_wire::{canonicalize_message, message_fingerprint, WireWarnings},
    };
    use serde_json::json;
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
    fn aggregate_hash_is_order_independent() {
        assert_eq!(
            aggregate_hash(vec!["b".to_string(), "a".to_string()]),
            aggregate_hash(vec!["a".to_string(), "b".to_string()])
        );
        assert_ne!(
            aggregate_hash(vec![
                topic_leaf_hash("topic-a", "config-a", "content-a"),
                topic_leaf_hash("topic-b", "config-b", "content-b"),
            ]),
            aggregate_hash(vec![
                topic_leaf_hash("topic-a", "config-a", "content-b"),
                topic_leaf_hash("topic-b", "config-b", "content-a"),
            ])
        );
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
            config_hash: String::new(),
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
        assert!(frame.messages[1].get("attachments").is_none());

        let response = push_topic_messages(
            &reconciler,
            MessagesPushTopic {
                topic_id: "topic-a".to_string(),
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                messages: vec![json!({
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
                })],
                deleted_messages: Vec::new(),
            },
        )
        .await;
        assert!(response.ok);
        let persisted: Vec<serde_json::Value> =
            serde_json::from_slice(&fs::read(&history_path).expect("read history"))
                .expect("parse history");
        assert_eq!(persisted.len(), 3);
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
        assert!(first.changed);
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
        assert!(!replay.changed);
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
                                mobile_message_hash_from_json(deleted_raw, "topic-a")
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
    async fn matching_live_root_does_not_hide_a_mobile_only_tombstone() {
        let (_temp, config, database, reconciler) = sync_fixture();
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-a/history.json"),
            br#"[{"id":"live","role":"user","content":"live","timestamp":1}]"#,
        )
        .expect("write history");
        reconciler.reconcile().await.expect("reconcile");

        let content_hash = topic_manifest(
            &database,
            &TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                topic_id: "topic-a".to_string(),
            },
        )
        .expect("topic manifest")
        .content_hash;
        let live_hash = load_message_states(
            &database,
            &TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                topic_id: "topic-a".to_string(),
            },
        )
        .expect("message states")
        .into_iter()
        .find(|message| message.msg_id == "live")
        .expect("live message")
        .message_hash
        .expect("live hash");

        let response = message_diff(
            &database,
            MessageDiffRequest {
                topics: vec![MessageDiffState {
                    topic_id: "topic-a".to_string(),
                    owner_type: OwnerType::Agent,
                    owner_id: "agent-a".to_string(),
                    content_hash,
                    messages: HashMap::from([
                        ("live".to_string(), version(live_hash, 1)),
                        ("mobile-only-deleted".to_string(), deleted_version(1)),
                    ]),
                }],
            },
        )
        .expect("message diff");
        let decision = successful_message_decision(&response.results[0]);
        assert!(decision.pull_message_ids.is_empty());
        assert!(decision.push_topic);
        assert!(decision.delete_messages.is_empty());
    }

    #[tokio::test]
    async fn message_diff_uses_time_then_hash_and_can_merge_both_winners_in_one_topic() {
        let (_temp, config, database, reconciler) = sync_fixture();
        let history_path = config
            .user_data_dir
            .join("agent-a/topics/topic-a/history.json");
        fs::write(
            &history_path,
            br#"[
                {"id":"mobile-newer","role":"user","content":"desktop-a","timestamp":1},
                {"id":"desktop-newer","role":"user","content":"desktop-b","timestamp":2},
                {"id":"mobile-tie","role":"user","content":"desktop-c","timestamp":3},
                {"id":"desktop-tie","role":"user","content":"desktop-d","timestamp":4}
            ]"#,
        )
        .expect("write history");
        reconciler.reconcile().await.expect("reconcile");

        let desktop_hashes = load_message_states(
            &database,
            &TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                topic_id: "topic-a".to_string(),
            },
        )
        .expect("message states")
        .into_iter()
        .map(|message| (message.msg_id, message.message_hash.expect("live hash")))
        .collect::<HashMap<_, _>>();
        {
            let connection = database.connection.lock();
            for (message_id, updated_at) in [
                ("mobile-newer", 10),
                ("desktop-newer", 20),
                ("mobile-tie", 30),
                ("desktop-tie", 40),
            ] {
                connection
                    .execute(
                        "UPDATE messages SET updated_at=?2 WHERE msg_id=?1",
                        rusqlite::params![message_id, updated_at],
                    )
                    .expect("set desktop update time");
            }
        }

        let response = message_diff(
            &database,
            MessageDiffRequest {
                topics: vec![MessageDiffState {
                    topic_id: "topic-a".to_string(),
                    owner_type: OwnerType::Agent,
                    owner_id: "agent-a".to_string(),
                    content_hash: String::new(),
                    messages: HashMap::from([
                        ("mobile-newer".to_string(), version("f".repeat(64), 20)),
                        ("desktop-newer".to_string(), version("f".repeat(64), 10)),
                        ("mobile-tie".to_string(), version("f".repeat(64), 30)),
                        ("desktop-tie".to_string(), version("0".repeat(64), 40)),
                    ]),
                }],
            },
        )
        .expect("message diff");
        let decision = successful_message_decision(&response.results[0]);
        assert_eq!(
            decision.pull_message_ids,
            vec!["desktop-newer".to_string(), "desktop-tie".to_string()]
        );
        assert!(decision.push_topic);
        assert_ne!(desktop_hashes["mobile-newer"], "f".repeat(64));
        assert!(desktop_hashes["desktop-tie"] > "0".repeat(64));
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
    async fn topic_resolution_rejects_cross_owner_ambiguity() {
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

        assert!(super::resolve_topic(
            &database,
            &TopicSelector {
                topic_id: "topic-a".to_string(),
                owner_type: None,
                owner_id: None,
            }
        )
        .is_err());
        let identity = super::resolve_topic(
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
        {
            let connection = database.connection.lock();
            connection
                .execute(
                    "UPDATE history_sources SET status='invalid', last_error='boom'
                     WHERE topic_id='topic-a'",
                    [],
                )
                .expect("poison history source");
        }

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

    /// 无法 wire 化的存活消息降级为确定性哨兵哈希，
    /// message manifest 与 topic content hash 都不再整批失败。
    #[tokio::test]
    async fn live_poison_message_degrades_to_deterministic_sentinel() {
        let (_temp, config, database, reconciler) = sync_fixture();
        fs::write(
            config
                .user_data_dir
                .join("agent-a/topics/topic-a/history.json"),
            br#"[{"id":"m1","role":"user","content":"healthy","timestamp":1}]"#,
        )
        .expect("write history");
        reconciler.reconcile().await.expect("reconcile");

        // 缺 id 的存活毒行（1.0 时代合法入库的形态）。
        let poison_raw = r#"{"role":"user","content":"no id","timestamp":5}"#;
        {
            let connection = database.connection.lock();
            connection
                .execute(
                    "INSERT INTO messages (owner_type, owner_id, topic_id, msg_id, ordinal,
                         role, content_raw, content_text, message_hash, metadata_json, updated_at)
                     VALUES ('agent','agent-a','topic-a','synthetic_1',2,'user','','','x',
                             ?1, 5)",
                    [poison_raw],
                )
                .expect("insert poison row");
        }

        let states = load_message_states(
            &database,
            &TopicKey {
                owner_type: OwnerType::Agent,
                owner_id: "agent-a".to_string(),
                topic_id: "topic-a".to_string(),
            },
        )
        .expect("message states with poison");
        let by_id: HashMap<_, _> = states
            .iter()
            .map(|message| (message.msg_id.as_str(), message))
            .collect();
        let expected_sentinel = sha256_hex(format!("vcp-invalid-message:{poison_raw}").as_bytes());
        assert_eq!(
            by_id["synthetic_1"].message_hash.as_deref(),
            Some(expected_sentinel.as_str())
        );
        // 健康消息的哈希与无哨兵时逐字节一致。
        assert_eq!(
            by_id["m1"].message_hash.as_deref().unwrap(),
            &mobile_message_hash_from_json(
                r#"{"id":"m1","role":"user","content":"healthy","timestamp":1}"#,
                "topic-a",
            )
            .expect("healthy hash")
        );

        // topic content hash 同样不再失败，且确定性（两次调用相等、包含哨兵）。
        let key = TopicKey {
            owner_type: OwnerType::Agent,
            owner_id: "agent-a".to_string(),
            topic_id: "topic-a".to_string(),
        };
        let first = topic_content_hash(&database, &key).expect("content hash with sentinel");
        let second = topic_content_hash(&database, &key).expect("deterministic");
        assert_eq!(first, second);
        assert_eq!(
            first,
            aggregate_hash(vec![
                message_leaf_hash("m1", by_id["m1"].message_hash.as_deref().unwrap()),
                message_leaf_hash("synthetic_1", &expected_sentinel),
            ])
        );
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
        {
            let connection = database.connection.lock();
            connection
                .execute(
                    "UPDATE history_sources SET status='invalid', last_error='boom'
                     WHERE topic_id='topic-a'",
                    [],
                )
                .expect("poison history source");
        }

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
        {
            let connection = database.connection.lock();
            connection
                .execute(
                    "UPDATE history_sources SET status='invalid', last_error='boom'
                     WHERE topic_id='topic-a'",
                    [],
                )
                .expect("poison history source");
        }

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
        let baseline_b = baseline_agents
            .iter()
            .find(|item| manifest_item_id(item) == "agent-b")
            .map(|item| (item.config_hash.clone(), item.content_hash.clone()))
            .expect("baseline agent-b");

        {
            let connection = database.connection.lock();
            connection
                .execute(
                    "UPDATE history_sources SET status='invalid', last_error='boom'
                     WHERE topic_id='topic-a'",
                    [],
                )
                .expect("poison history source");
        }

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
