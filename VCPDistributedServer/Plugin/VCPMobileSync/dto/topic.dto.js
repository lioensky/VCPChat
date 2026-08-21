/**
 * Topic DTO 定义与操作
 * 分离 Agent Topic 和 Group Topic，消除分类讨论
 */

const { AGENT_TOPIC_DEFAULTS } = require("../config/defaults");

const AGENT_TOPIC_SYNC_FIELDS = ["id", "name", "createdAt", "locked", "unread"];

const GROUP_TOPIC_SYNC_FIELDS = ["id", "name", "createdAt"];

function extractAgentTopicDTO(topic, ownerId) {
  if (!topic) return null;
  return {
    id: topic.id,
    name: topic.name,
    createdAt: parseInt(topic.createdAt),
    locked: topic.locked ?? AGENT_TOPIC_DEFAULTS.locked,
    unread: topic.unread ?? AGENT_TOPIC_DEFAULTS.unread,
    ownerId,
  };
}

function extractGroupTopicDTO(topic, ownerId) {
  if (!topic) return null;
  return {
    id: topic.id,
    name: topic.name,
    createdAt: parseInt(topic.createdAt),
    ownerId,
  };
}

function applyAgentTopicDTO(topic, dto) {
  if (!topic || !dto) return topic;
  topic.id = dto.id;
  topic.name = dto.name;
  topic.createdAt = dto.createdAt;
  topic.locked = dto.locked ?? topic.locked ?? true;
  topic.unread = dto.unread ?? topic.unread ?? false;
  topic.creatorSource = topic.creatorSource ?? "ui";

  return topic;
}

function applyGroupTopicDTO(topic, dto) {
  if (!topic || !dto) return topic;
  topic.id = dto.id;
  topic.name = dto.name;
  topic.createdAt = dto.createdAt;

  return topic;
}

function extractTopicDTO(topic, ownerId, ownerType) {
  if (ownerType === "group") {
    return extractGroupTopicDTO(topic, ownerId);
  }
  return extractAgentTopicDTO(topic, ownerId);
}

function applyTopicDTO(topic, dto, ownerType) {
  if (ownerType === "group") {
    return applyGroupTopicDTO(topic, dto);
  }
  return applyAgentTopicDTO(topic, dto);
}

module.exports = {
  AGENT_TOPIC_SYNC_FIELDS,
  GROUP_TOPIC_SYNC_FIELDS,
  extractAgentTopicDTO,
  extractGroupTopicDTO,
  applyAgentTopicDTO,
  applyGroupTopicDTO,
  extractTopicDTO,
  applyTopicDTO,
};
