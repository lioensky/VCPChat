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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AvatarOwnerType {
    Agent,
    Group,
    User,
}

impl AvatarOwnerType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Group => "group",
            Self::User => "user",
        }
    }

    pub const fn owner_type(self) -> Option<OwnerType> {
        match self {
            Self::Agent => Some(OwnerType::Agent),
            Self::Group => Some(OwnerType::Group),
            Self::User => None,
        }
    }
}

impl fmt::Display for AvatarOwnerType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for AvatarOwnerType {
    type Err = ServiceError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "agent" => Ok(Self::Agent),
            "group" => Ok(Self::Group),
            "user" => Ok(Self::User),
            _ => Err(ServiceError::InvalidRequest(format!(
                "unsupported avatar owner type: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarKey {
    pub owner_type: AvatarOwnerType,
    pub owner_id: String,
}

impl AvatarKey {
    pub fn wire_id(&self) -> String {
        format!("{}:{}", self.owner_type.as_str(), self.owner_id)
    }

    pub fn from_wire_id(value: &str) -> Result<Self, ServiceError> {
        let (owner_type, owner_id) = value.split_once(':').ok_or_else(|| {
            ServiceError::InvalidRequest("avatar id must be '<ownerType>:<ownerId>'".to_string())
        })?;
        if owner_id.is_empty()
            || owner_id.contains(':')
            || !owner_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(ServiceError::InvalidRequest(
                "avatar owner id must use only ASCII letters, digits, '_' or '-'".to_string(),
            ));
        }
        let owner_type = owner_type.parse::<AvatarOwnerType>()?;
        if owner_type == AvatarOwnerType::User && owner_id != "user_avatar" {
            return Err(ServiceError::InvalidRequest(
                "user avatar owner id must be user_avatar".to_string(),
            ));
        }
        Ok(Self {
            owner_type,
            owner_id: owner_id.to_string(),
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarRecord {
    pub owner_type: AvatarOwnerType,
    pub owner_id: String,
    pub file_path: PathBuf,
    pub hash: String,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
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

#[derive(Debug, Clone)]
pub struct OwnerRecord {
    pub key: OwnerKey,
    pub display_name: String,
    pub config_path: PathBuf,
    pub config_hash: String,
    pub source_config_hash: Option<String>,
    pub topics: Vec<TopicDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicDefinition {
    pub topic_id: String,
    pub display_name: Option<String>,
    pub created_at: Option<i64>,
    pub ordinal: i64,
    pub config_hash: String,
    pub metadata: Value,
}

#[derive(Debug, Clone)]
pub struct TopicSource {
    pub key: TopicKey,
    pub source_path: PathBuf,
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
    pub updated_at: Option<i64>,
    pub message_hash: String,
    pub metadata_json: String,
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
