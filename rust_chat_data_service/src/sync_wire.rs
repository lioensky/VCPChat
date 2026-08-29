use anyhow::{Context, Result};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{domain::TopicKey, ingest::sha256_hex};

pub const MAX_WARNING_SAMPLES: usize = 8;
const MAX_SAFE_JSON_INTEGER: u64 = (1_u64 << 53) - 1;

#[derive(Debug, Clone, Default)]
pub struct WireWarnings {
    pub count: usize,
    pub samples: Vec<String>,
}

impl WireWarnings {
    fn push(&mut self, message: String) {
        self.count += 1;
        if self.samples.len() < MAX_WARNING_SAMPLES {
            self.samples.push(message);
        }
    }
}

enum HashField {
    Missing,
    Valid(String),
    Invalid,
}

fn canonical_sha256(value: &str) -> Option<String> {
    let normalized = value.to_ascii_lowercase();
    (normalized.len() == 64 && normalized.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(normalized)
}

fn read_hash_field(object: &Map<String, Value>, key: &str) -> HashField {
    match object.get(key) {
        None | Some(Value::Null) => HashField::Missing,
        Some(Value::String(value)) => canonical_sha256(value)
            .map(HashField::Valid)
            .unwrap_or(HashField::Invalid),
        Some(_) => HashField::Invalid,
    }
}

fn required_string<'a>(value: Option<&'a Value>, field: &str) -> Result<&'a str> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .with_context(|| format!("{field} must be a non-empty string"))
}

fn normalize_integer(value: Option<&Value>, field: &str) -> Result<u64> {
    match value {
        Some(Value::Number(number)) => number
            .as_u64()
            .filter(|value| *value <= MAX_SAFE_JSON_INTEGER)
            .with_context(|| format!("{field} must be a non-negative safe integer")),
        Some(Value::String(value)) => value
            .parse::<u64>()
            .ok()
            .filter(|value| *value <= MAX_SAFE_JSON_INTEGER)
            .with_context(|| format!("{field} string must be a non-negative safe integer")),
        _ => anyhow::bail!("{field} must be a non-negative integer or integer string"),
    }
}

fn canonicalize_attachment(
    value: Value,
    message_id: &str,
    index: usize,
    warnings: &mut WireWarnings,
) -> Result<Option<Value>> {
    let mut object = value
        .as_object()
        .cloned()
        .with_context(|| format!("Message {message_id} attachment {index} must be an object"))?;
    let nested = match object.remove("_fileManagerData") {
        None | Some(Value::Null) => None,
        Some(Value::Object(nested)) => Some(nested),
        Some(_) => {
            warnings.push(format!(
                "message={message_id} attachment={index}: invalid _fileManagerData"
            ));
            return Ok(None);
        }
    };

    let top_hash = read_hash_field(&object, "hash");
    let nested_hash = nested
        .as_ref()
        .map(|nested| read_hash_field(nested, "hash"))
        .unwrap_or(HashField::Missing);
    let hash = match (top_hash, nested_hash) {
        (HashField::Valid(top), HashField::Valid(nested)) if top == nested => Some(top),
        (HashField::Valid(_), HashField::Valid(_)) => None,
        (HashField::Valid(hash), _) | (_, HashField::Valid(hash)) => Some(hash),
        _ => None,
    };
    let Some(hash) = hash else {
        warnings.push(format!(
            "message={message_id} attachment={index}: missing, invalid, or conflicting SHA-256"
        ));
        return Ok(None);
    };

    let selected = |key: &str| {
        object
            .get(key)
            .or_else(|| nested.as_ref().and_then(|nested| nested.get(key)))
    };
    let attachment_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("unnamed")
        .to_string();
    let size = match object.get("size") {
        None | Some(Value::Null) => 0,
        value => normalize_integer(
            value,
            &format!("Message {message_id} attachment {index} size"),
        )?,
    };

    let mut canonical = Map::new();
    canonical.insert("type".to_string(), Value::String(attachment_type));
    canonical.insert("name".to_string(), Value::String(name));
    canonical.insert("size".to_string(), Value::from(size));
    canonical.insert("hash".to_string(), Value::String(hash));

    if let Some(value) = selected("extractedText").filter(|value| !value.is_null()) {
        let text = value.as_str().with_context(|| {
            format!("Message {message_id} attachment {index} extractedText must be a string")
        })?;
        canonical.insert("extractedText".to_string(), Value::String(text.to_string()));
    }
    if let Some(value) = selected("imageFrames").filter(|value| !value.is_null()) {
        let frames = value.as_array().with_context(|| {
            format!("Message {message_id} attachment {index} imageFrames must be an array")
        })?;
        anyhow::ensure!(
            frames.iter().all(Value::is_string),
            "Message {message_id} attachment {index} imageFrames must contain strings"
        );
        canonical.insert("imageFrames".to_string(), Value::Array(frames.clone()));
    }
    if let Some(value) = selected("createdAt").filter(|value| !value.is_null()) {
        canonical.insert(
            "createdAt".to_string(),
            Value::from(normalize_integer(
                Some(value),
                &format!("Message {message_id} attachment {index} createdAt"),
            )?),
        );
    }

    Ok(Some(Value::Object(canonical)))
}

pub fn canonicalize_message(
    value: Value,
    topic_id: &str,
    warnings: &mut WireWarnings,
) -> Result<Value> {
    let object = value
        .as_object()
        .with_context(|| format!("Topic {topic_id} contains a non-object message"))?;
    let message_id = required_string(object.get("id"), &format!("Topic {topic_id} message id"))?;
    let role = required_string(object.get("role"), &format!("Message {message_id} role"))?;

    // topicId 是来源元数据而非消息身份：frame topic 才是双端存储权威，消息指纹
    // 也不含 topicId。话题分支会合法地让消息携带旧话题的 topicId（1.0 时代从未
    // 校验过），因此早期引入的"topicId 必须等于 frame topic"硬校验
    // 降级为 frame 权威归一化：不一致（或非字符串）时重写为 frame topic。
    // 这是分支话题的确定性正常处理路径，不是异常——按 debug 级记录，
    // 避免逐条消息刷 WARN 淹没真正的告警。
    let topic_id_override = match object.get("topicId") {
        None | Some(Value::Null) => None,
        Some(Value::String(message_topic)) if message_topic == topic_id => None,
        Some(original) => {
            tracing::debug!(
                message_id,
                frame_topic = topic_id,
                original_topic_id = ?original,
                "branch message topicId rewritten to frame topic (expected for branched topics)"
            );
            Some(Value::String(topic_id.to_string()))
        }
    };
    if object.get("status").and_then(Value::as_str) == Some("removed")
        || object
            .get("deletedAt")
            .is_some_and(|value| !value.is_null())
    {
        anyhow::bail!("Tombstoned message {message_id} must not appear in a live pull frame");
    }

    let mut canonical = Map::new();
    canonical.insert("id".to_string(), Value::String(message_id.to_string()));
    canonical.insert("role".to_string(), Value::String(role.to_string()));
    if let Some(value) = object.get("name").filter(|value| !value.is_null()) {
        canonical.insert(
            "name".to_string(),
            Value::String(
                value
                    .as_str()
                    .with_context(|| format!("Message {message_id} name must be a string"))?
                    .to_string(),
            ),
        );
    }
    let content = match object.get("content") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(content)) => content.clone(),
        Some(_) => anyhow::bail!("Message {message_id} content must be a string"),
    };
    canonical.insert("content".to_string(), Value::String(content));
    canonical.insert(
        "timestamp".to_string(),
        Value::from(normalize_integer(
            object.get("timestamp"),
            &format!("Message {message_id} timestamp"),
        )?),
    );
    if let Some(updated_at) = object
        .get("updatedAt")
        .and_then(Value::as_i64)
        .filter(|value| (0..=9_007_199_254_740_991).contains(value))
    {
        canonical.insert("updatedAt".to_string(), Value::from(updated_at));
    }

    for (key, expected) in [
        ("isThinking", "boolean"),
        ("agentId", "string"),
        ("groupId", "string"),
        ("topicId", "string"),
        ("isGroupMessage", "boolean"),
    ] {
        let value = match &topic_id_override {
            Some(override_value) if key == "topicId" => override_value.clone(),
            _ => object.get(key).cloned().unwrap_or(Value::Null),
        };
        let valid = value.is_null()
            || (expected == "boolean" && value.is_boolean())
            || (expected == "string" && value.is_string());
        anyhow::ensure!(valid, "Message {message_id} {key} must be a {expected}");
        canonical.insert(key.to_string(), value);
    }

    for key in ["finishReason"] {
        if let Some(value) = object.get(key).filter(|value| !value.is_null()) {
            anyhow::ensure!(
                value.is_string(),
                "Message {message_id} {key} must be a string"
            );
            canonical.insert(key.to_string(), value.clone());
        }
    }

    match object.get("attachments") {
        None | Some(Value::Null) => {}
        Some(Value::Array(attachments)) => {
            let mut output = Vec::with_capacity(attachments.len());
            for (index, attachment) in attachments.iter().cloned().enumerate() {
                if let Some(attachment) =
                    canonicalize_attachment(attachment, message_id, index, warnings)?
                {
                    output.push(attachment);
                }
            }
            if !output.is_empty() {
                canonical.insert("attachments".to_string(), Value::Array(output));
            }
        }
        Some(_) => anyhow::bail!("Message {message_id} attachments must be an array or null"),
    }

    Ok(Value::Object(canonical))
}

pub fn message_fingerprint(message: &Value) -> Result<String> {
    let object = message
        .as_object()
        .context("canonical message must be an object")?;
    let message_id = object
        .get("id")
        .and_then(Value::as_str)
        .context("canonical message id is missing")?;
    let role = object
        .get("role")
        .and_then(Value::as_str)
        .context("canonical message role is missing")?;
    let content = object
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let timestamp = object
        .get("timestamp")
        .and_then(Value::as_u64)
        .context("canonical message timestamp is missing")?;
    let mut hashes = object
        .get("attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|attachment| {
            attachment
                .get("hash")
                .and_then(Value::as_str)
                .and_then(canonical_sha256)
                .context("canonical attachment hash is invalid")
        })
        .collect::<Result<Vec<_>>>()?;
    hashes.sort();

    let mut input = Map::new();
    if let Some(agent_id) = object.get("agentId").filter(|value| !value.is_null()) {
        input.insert("agentId".to_string(), agent_id.clone());
    }
    if !hashes.is_empty() {
        input.insert(
            "attachmentHashes".to_string(),
            Value::Array(hashes.into_iter().map(Value::String).collect()),
        );
    }
    input.insert("content".to_string(), Value::String(content.to_string()));
    input.insert("id".to_string(), Value::String(message_id.to_string()));
    if let Some(name) = object.get("name").filter(|value| !value.is_null()) {
        input.insert("name".to_string(), name.clone());
    }
    input.insert("role".to_string(), Value::String(role.to_string()));
    input.insert("timestamp".to_string(), Value::Number(timestamp.into()));
    Ok(sha256_hex(Value::Object(input).to_string().as_bytes()))
}

pub(crate) fn stored_message_fingerprint(raw: &str, topic_id: &str) -> Result<String> {
    let value = serde_json::from_str::<Value>(raw).context("stored message JSON is invalid")?;
    let mut warnings = WireWarnings::default();
    let canonical = canonicalize_message(value, topic_id, &mut warnings)?;
    message_fingerprint(&canonical)
}

pub(crate) fn aggregate_hash(mut hashes: Vec<String>) -> String {
    if hashes.is_empty() {
        return String::new();
    }
    hashes.sort_unstable();
    let mut hasher = Sha256::new();
    for hash in hashes {
        hasher.update(hash.as_bytes());
    }
    hex::encode(hasher.finalize())
}

pub(crate) fn message_leaf_hash(message_id: &str, message_hash: &str) -> String {
    sha256_hex(
        serde_json::json!({
            "id": message_id,
            "hash": message_hash,
        })
        .to_string()
        .as_bytes(),
    )
}

pub(crate) fn topic_leaf_hash(topic_id: &str, config_hash: &str, content_hash: &str) -> String {
    sha256_hex(
        serde_json::json!({
            "topicId": topic_id,
            "configHash": config_hash,
            "contentHash": content_hash,
        })
        .to_string()
        .as_bytes(),
    )
}

pub(crate) fn unhealthy_topic_sentinel_hash(key: &TopicKey) -> String {
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

#[cfg(test)]
mod tests {
    use super::{canonicalize_message, message_fingerprint, normalize_integer, WireWarnings};

    const CONTRACT: &[u8] = include_bytes!(
        "../../VCPDistributedServer/Plugin/VCPMobileSync/fixtures/message_canonical_contract.json"
    );
    #[test]
    fn canonical_message_contract_matches_cds_projection_and_hashes() {
        let bundle: serde_json::Value =
            serde_json::from_slice(CONTRACT).expect("canonical contract JSON");

        for fixture in bundle["validFrames"].as_array().expect("valid frames") {
            let input = &fixture["input"];
            let topic_id = input["topicId"].as_str().expect("topic id");
            let mut warnings = WireWarnings::default();
            let messages = input["messages"]
                .as_array()
                .expect("messages")
                .iter()
                .cloned()
                .map(|message| canonicalize_message(message, topic_id, &mut warnings))
                .collect::<anyhow::Result<Vec<_>>>()
                .expect("canonical messages");
            let hashes = messages
                .iter()
                .map(message_fingerprint)
                .collect::<anyhow::Result<Vec<_>>>()
                .expect("content hashes");
            assert_eq!(
                serde_json::to_value(messages).expect("messages JSON"),
                fixture["expected"]["canonicalMessages"]
            );
            assert_eq!(
                serde_json::to_value(hashes).expect("hashes JSON"),
                fixture["expected"]["contentHashes"]
            );
            assert_eq!(
                warnings.count as u64,
                fixture["expected"]["warningCount"].as_u64().unwrap()
            );
        }

        for fixture in bundle["invalidFrames"].as_array().expect("invalid frames") {
            let input = &fixture["input"];
            let topic_id = input["topicId"].as_str().expect("topic id");
            let mut warnings = WireWarnings::default();
            let error = input["messages"]
                .as_array()
                .expect("messages")
                .iter()
                .cloned()
                .map(|message| canonicalize_message(message, topic_id, &mut warnings))
                .collect::<anyhow::Result<Vec<_>>>()
                .expect_err("invalid frame must fail");
            assert!(error
                .to_string()
                .contains(fixture["errorContains"].as_str().expect("error fragment")));
        }
    }

    #[test]
    fn wire_integer_range_matches_javascript_safe_integer_boundary() {
        let maximum = serde_json::Value::String("9007199254740991".to_string());
        let overflow = serde_json::Value::String("9007199254740992".to_string());
        assert_eq!(
            normalize_integer(Some(&maximum), "timestamp").expect("safe maximum"),
            9_007_199_254_740_991
        );
        assert!(normalize_integer(Some(&overflow), "timestamp").is_err());
    }
}
