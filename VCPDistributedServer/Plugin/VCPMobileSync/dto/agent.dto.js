/**
 * Agent DTO 定义与操作
 */

const { AGENT_DEFAULTS } = require("../config/defaults");

// Agent 同步字段白名单
const AGENT_SYNC_FIELDS = [
  "name",
  "systemPrompt",
  "model",
  "temperature",
  "contextTokenLimit",
  "maxOutputTokens",
  "streamOutput",
];

/**
 * 从完整配置提取 DTO
 * 对于缺失的字段，使用 AGENT_DEFAULTS 默认值填充，确保双端 hash 一致
 * @param {object} config - 桌面端完整配置
 * @returns {object} DTO
 */
function extractAgentDTO(config) {
  const dto = {};
  AGENT_SYNC_FIELDS.forEach((field) => {
    let val = config[field] ?? AGENT_DEFAULTS[field];

    // 强制类型归一化：对齐手机端 Rust 类型
    if (field === "temperature") {
      val = parseFloat(val);
    } else if (field === "contextTokenLimit" || field === "maxOutputTokens") {
      val = parseInt(val);
    }

    dto[field] = val;
  });
  return dto;
}

/**
 * 将 DTO 应用到配置 (更新场景)
 * @param {object} config - 桌面端完整配置
 * @param {object} dto - 同步 DTO
 * @returns {object} 更新后的配置
 */
function applyAgentDTO(config, dto) {
  AGENT_SYNC_FIELDS.forEach((field) => {
    if (dto[field] !== undefined) {
      config[field] = dto[field];
    }
  });
  return config;
}

module.exports = {
  AGENT_SYNC_FIELDS,
  extractAgentDTO,
  applyAgentDTO,
};
