/**
 * 清单生成与比对逻辑
 */

const crypto = require("crypto");
const { getDb, getEntitiesByType, getMessagesByTopic } = require("../core/db");
const { getLogger } = require("../core/logger");


/**
 * 获取本地清单
 * @param {string} dataType - 数据类型 (agent/group/topic/avatar)
 * @param {string[]} targetedOwners - 仅针对特定所有者的过滤列表 (V2)
 * @returns {object[]} 本地实体列表
 */
function getLocalManifest(dataType, targetedOwners = null) {
  const db = getDb();
  if (!db) return [];

  if (dataType === "avatar") {
    const rows = db
      .prepare(
        "SELECT owner_id, owner_type, hash, updated_at, deleted_at FROM avatar_index",
      )
      .all();
    return rows.map((r) => ({
      id: `${r.owner_type}:${r.owner_id}`,
      hash: r.hash,
      ts: r.updated_at,
      deletedAt: r.deleted_at,
    }));
  }

  let rows;
  if (dataType === "topic" && Array.isArray(targetedOwners) && targetedOwners.length > 0) {
    // 修复：使用更精确的路径匹配模式，防止 prefix 冲突 (例如 agent_1 匹配到 agent_11)
    // 路径结构通常为 .../Agents/owner_id/config.json
    // 使用 % 作为分隔符以对齐 Windows (\) 和 Unix (/)
    const likeClauses = targetedOwners.map(() => "(file_path LIKE ? OR file_path LIKE ?)").join(" OR ");
    const params = [];
    targetedOwners.forEach(id => {
      params.push(`%Agents%${id}%config.json`);
      params.push(`%AgentGroups%${id}%config.json`);
    });
    
    rows = db
      .prepare(
        `SELECT * FROM entity_index WHERE (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic') AND (${likeClauses})`,
      )
      .all(...params);
  } else {
    rows = getEntitiesByType(dataType);
  }

  if (dataType === "topic" || dataType === "agent" || dataType === "group") {
    return rows.map((r) => {
      const result = {
        id: r.id,
        hash: r.hash, // 兼容旧版
        configHash: r.hash,
        contentHash: r.aggregated_hash || "",
        ts: r.updated_at,
        deletedAt: r.deleted_at,
      };
      // Add ownerType for topics (derived from file_path)
      if (dataType === "topic" && r.file_path) {
        result.ownerType = r.file_path.includes("AgentGroups")
          ? "group"
          : "agent";
      }
      return result;
    });
  }

  return rows.map((r) => ({
    id: r.id,
    hash: r.hash,
    ts: r.updated_at,
    deletedAt: r.deleted_at,
  }));
}

/**
 * 处理 SYNC_MANIFEST 消息
 * @param {object} payload - 消息载荷
 * @returns {object} 差异结果
 */
function handleSyncManifest(payload) {
  const { dataType, data: remoteItems, targetedOwners } = payload;
  const logger = getLogger();
  const phase = (dataType === "topic") ? "topic_metadata" : "owner_metadata";

  if (
    dataType !== "agent" &&
    dataType !== "group" &&
    dataType !== "avatar" &&
    dataType !== "topic"
  ) {
    logger.logOperation(phase, "manifest", dataType, "warn", "invalid dataType ignored");
    return null;
  }

  if (!Array.isArray(remoteItems)) {
    logger.logOperation(phase, "manifest", dataType, "error", "payload.data is not an array");
    return null;
  }

  const localItems = getLocalManifest(dataType, targetedOwners);
  const results = [];
  const processedIds = new Set();

  for (const remote of remoteItems) {
    const local = localItems.find((it) => it.id === remote.id);
    const remoteDeletedAt = remote.deletedAt || null;

    if (remoteDeletedAt) {
      if (!local || !local.deletedAt) {
        results.push({
          id: remote.id,
          action: "DELETE",
          deletedAt: remoteDeletedAt,
        });
      }
      processedIds.add(remote.id);
    } else if (!local) {
      results.push({ id: remote.id, action: "PUSH", ownerType: remote.ownerType });
    } else if (local.deletedAt && !remoteDeletedAt) {
      results.push({
        id: local.id,
        action: "PUSH_DELETE",
        deletedAt: local.deletedAt,
        ownerType: local.ownerType,
      });
      processedIds.add(local.id);
    } else {
      // V2: 双哈希比对
      const remoteConfig = remote.configHash || remote.hash;
      const remoteContent = remote.contentHash || "";
      const localConfig = local.configHash || local.hash;
      const localContent = local.contentHash || "";

      let itemChanged = false;

      // 1. 比较配置
      if (localConfig !== remoteConfig) {
        if (remote.ts > local.ts) {
          results.push({ id: remote.id, action: "PUSH", ownerType: remote.ownerType });
        } else {
          results.push({ id: local.id, action: "PULL", ownerType: local.ownerType });
        }
        itemChanged = true;
      }

      // 2. 比较内容 (仅 Agent/Group)
      if ((dataType === "agent" || dataType === "group") && localContent !== remoteContent) {
        // 如果内容不匹配，标记 mismatchedContent 引导手机端发起 targeted topic sync
        const existingResult = results.find(r => r.id === remote.id);
        if (existingResult) {
          existingResult.mismatchedContent = true;
        } else {
          results.push({ id: remote.id, action: "SKIP", mismatchedContent: true, ownerType: remote.ownerType });
        }
      }
      
      processedIds.add(remote.id);
    }
  }

  for (const local of localItems) {
    if (
      !processedIds.has(local.id) &&
      !remoteItems.find((r) => r.id === local.id)
    ) {
      if (local.deletedAt) {
        results.push({
          id: local.id,
          action: "PUSH_DELETE",
          deletedAt: local.deletedAt,
          ownerType: local.ownerType,
        });
      } else {
        results.push({ id: local.id, action: "PULL", ownerType: local.ownerType });
      }
    }
  }

  const pushCount = results.filter((r) => r.action === "PUSH").length;
  const pullCount = results.filter((r) => r.action === "PULL").length;
  const deleteCount = results.filter((r) => r.action === "DELETE").length;
  const skipCount = remoteItems.filter((remote) => {
    const local = localItems.find((it) => it.id === remote.id);
    return local && !local.deletedAt && !remote.deletedAt && local.hash === remote.hash;
  }).length;

  logger.logOperation(phase, "diff", dataType, "success", `push=${pushCount} pull=${pullCount} delete=${deleteCount} skip=${skipCount}`);

  return {
    type: "SYNC_DIFF_RESULTS",
    data: results,
    dataType,
    phase: payload.phase || 0,
  };
}

/**
 * 处理 GET_MESSAGE_MANIFEST 消息
 * @param {object} payload - 消息载荷
 * @returns {object} 消息清单
 */
function handleMessageManifest(payload) {
  const db = getDb();
  if (!db) return null;

  const logger = getLogger();
  const topicId = sanitizeId(payload.topicId);

  const rows = db
    .prepare(
      "SELECT msg_id, hash as content_hash, updated_at FROM message_index WHERE topic_id = ?",
    )
    .all(topicId);

  logger.logOperation("messages", "manifest", topicId, "success", `messages=${rows.length}`);

  return {
    type: "MESSAGE_MANIFEST_RESULTS",
    topicId,
    messages: rows,
  };
}

/**
 * ID 清理
 * @param {string} id - 原始 ID
 * @returns {string} 清理后的 ID
 */
function sanitizeId(id) {
  if (typeof id !== "string") return "";
  return id.replace(/[^a-zA-Z0-9_\-]/g, "");
}

module.exports = {
  getLocalManifest,
  handleSyncManifest,
  handleMessageManifest,
  sanitizeId,
};
