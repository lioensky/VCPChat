use std::{fmt, path::PathBuf, str::FromStr};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::ServiceError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OwnerType {
    Agent,
    Group,
}

impl OwnerType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Group => "group",
        }
    }
}

impl fmt::Display for OwnerType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for OwnerType {
    type Err = ServiceError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "agent" => Ok(Self::Agent),
            "group" => Ok(Self::Group),
            _ => Err(ServiceError::InvalidRequest(format!(
                "unsupported owner type: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerKey {
    pub owner_type: OwnerType,
    pub owner_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicKey {
    pub owner_type: OwnerType,
    pub owner_id: String,
    pub topic_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageKey {
    pub owner_type: OwnerType,
    pub owner_id: String,
    pub topic_id: String,
    pub msg_id: String,
}

#[derive(Debug, Clone)]
pub struct OwnerRecord {
    pub key: OwnerKey,
    pub display_name: String,
    pub config_path: PathBuf,
    pub config_hash: String,
    pub topics: Vec<TopicDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicDefinition {
    pub topic_id: String,
    pub display_name: Option<String>,
    pub created_at: Option<i64>,
    pub ordinal: i64,
    pub metadata: Value,
}

#[derive(Debug, Clone)]
pub struct TopicSource {
    pub key: TopicKey,
    pub display_name: Option<String>,
    pub created_at: Option<i64>,
    pub topic_ordinal: i64,
    pub source_path: PathBuf,
    pub config_hash: String,
    pub topic_metadata: Value,
}

#[derive(Debug, Clone)]
pub struct NormalizedMessage {
    pub msg_id: String,
    pub ordinal: i64,
    pub role: String,
    pub speaker_name: Option<String>,
    /// Agent identity of a speaker inside a group conversation.
    pub speaker_agent_id: Option<String>,
    pub content_raw: String,
    pub content_text: String,
    pub timestamp: Option<i64>,
    pub message_hash: String,
    pub metadata_json: String,
    pub attachments: Vec<NormalizedAttachment>,
}

#[derive(Debug, Clone)]
pub struct NormalizedAttachment {
    pub attachment_order: i64,
    pub content_hash: Option<String>,
    pub display_name: Option<String>,
    pub mime_type: Option<String>,
    pub file_path: Option<String>,
    pub metadata_json: String,
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageView {
    pub row_id: i64,
    pub owner_type: OwnerType,
    pub owner_id: String,
    pub topic_id: String,
    pub msg_id: String,
    pub ordinal: i64,
    pub role: String,
    pub speaker_name: Option<String>,
    pub speaker_agent_id: Option<String>,
    pub content_raw: String,
    pub content_text: String,
    pub timestamp: Option<i64>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub message: MessageView,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWindow {
    pub owner_type: OwnerType,
    pub owner_id: String,
    pub topic_id: String,
    pub topic_name: Option<String>,
    pub start_ordinal: i64,
    pub end_ordinal: i64,
    pub score: f32,
    pub messages: Vec<MessageView>,
}
