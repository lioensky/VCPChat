/**
 * DTO 模块导出
 */

const {
  AGENT_SYNC_FIELDS,
  extractAgentDTO,
  applyAgentDTO,
} = require("./agent.dto");
const {
  GROUP_SYNC_FIELDS,
  extractGroupDTO,
  applyGroupDTO,
} = require("./group.dto");
const {
  AGENT_TOPIC_SYNC_FIELDS,
  GROUP_TOPIC_SYNC_FIELDS,
  extractTopicDTO,
  applyTopicDTO,
} = require("./topic.dto");

module.exports = {
  // Agent
  AGENT_SYNC_FIELDS,
  extractAgentDTO,
  applyAgentDTO,

  // Group
  GROUP_SYNC_FIELDS,
  extractGroupDTO,
  applyGroupDTO,

  // Topic
  AGENT_TOPIC_SYNC_FIELDS,
  GROUP_TOPIC_SYNC_FIELDS,
  extractTopicDTO,
  applyTopicDTO,
};
