/**
 * Group DTO 定义与操作
 */

const { GROUP_DEFAULTS } = require("../config/defaults");

// Group 同步字段白名单
const GROUP_SYNC_FIELDS = [
  "name",
  "members",
  "mode",
  "memberTags",
  "groupPrompt",
  "invitePrompt",
  "useUnifiedModel",
  "unifiedModel",
  "tagMatchMode",
  "createdAt",
];

/**
 * 从完整配置提取 DTO
 * 对于缺失的字段，使用 GROUP_DEFAULTS 默认值填充，确保双端 hash 一致
 * @param {object} config - 桌面端完整配置
 * @returns {object} DTO
 */
function extractGroupDTO(config) {
  const dto = {};
  GROUP_SYNC_FIELDS.forEach((field) => {
    let val = config[field] ?? GROUP_DEFAULTS[field];
    if (field === "createdAt") {
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
function applyGroupDTO(config, dto) {
  GROUP_SYNC_FIELDS.forEach((field) => {
    if (dto[field] !== undefined) {
      config[field] = dto[field];
    }
  });
  return config;
}

module.exports = {
  GROUP_SYNC_FIELDS,
  extractGroupDTO,
  applyGroupDTO,
};
