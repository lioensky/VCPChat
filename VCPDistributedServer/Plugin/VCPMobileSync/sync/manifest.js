/**
 * 清单生成与比对逻辑
 */

const { getDb } = require("../core/db");
const { getLogger } = require("../core/logger");
const { assertHistoryTopicHealthy } = require("./message");

const MAX_MANIFEST_ITEMS = 10_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CONTENT_HASH_PATTERN = /^(?:|[a-f0-9]{64})$/;

function syncContractError(message, code = "SYNC_PROTOCOL_INVALID") {
  return Object.assign(new Error(message), { code });
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw syncContractError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw syncContractError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireOptionalTombstone(value, label) {
  if (value === null || value === undefined) return null;
  return requireTimestamp(value, label);
}

function requireHash(value, label, { allowEmpty = false } = {}) {
  const pattern = allowEmpty ? CONTENT_HASH_PATTERN : HASH_PATTERN;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw syncContractError(`${label} must be ${allowEmpty ? "empty or " : ""}a lowercase SHA-256 hash`);
  }
  return value;
}

function requireTargetedOwners(dataType, targetedOwners) {
  if (targetedOwners == null) return null;
  if (dataType !== "topic" || !Array.isArray(targetedOwners)) {
    throw syncContractError("targetedOwners is only valid for topic manifests");
  }
  if (targetedOwners.length > MAX_MANIFEST_ITEMS) {
    throw syncContractError("targetedOwners exceeds 10000 owners", "SYNC_BUDGET_EXCEEDED");
  }
  const owners = targetedOwners.map((ownerId, index) =>
    requireNonEmptyString(ownerId, `targetedOwners[${index}]`),
  );
  if (new Set(owners).size !== owners.length) {
    throw syncContractError("targetedOwners contains duplicate owner IDs");
  }
  return new Set(owners);
}

function topicOwnerFromPath(filePath) {
  requireNonEmptyString(filePath, "topic file_path");
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const ownerId = parts.at(-2);
  if (!ownerId) {
    throw syncContractError("Topic index has no owner directory", "SYNC_INDEX_INVALID");
  }
  const ownerType = parts.includes("AgentGroups")
    ? "group"
    : parts.includes("Agents")
      ? "agent"
      : null;
  if (!ownerType) {
    throw syncContractError(
      `Topic ${ownerId} has a file path outside Agents/AgentGroups`,
      "SYNC_INDEX_INVALID",
    );
  }
  return { ownerId, ownerType };
}

function requireAvatarOwner(id) {
  const separator = id.indexOf(":");
  if (separator <= 0 || separator === id.length - 1) {
    throw syncContractError(`Avatar manifest id ${id} is invalid`);
  }
  const ownerType = id.slice(0, separator);
  const ownerId = id.slice(separator + 1);
  if (
    !["agent", "group", "user"].includes(ownerType) ||
    (ownerType === "user" && ownerId !== "user_avatar")
  ) {
    throw syncContractError(`Avatar manifest owner ${id} is invalid`);
  }
  return { ownerType, ownerId };
}


/**
 * 获取本地清单
 * @param {string} dataType - 数据类型 (agent/group/topic/avatar)
 * @param {string[]} targetedOwners - 仅针对特定所有者的过滤列表 (V2)
 * @returns {object[]} 本地实体列表
 */
function getLocalManifest(dataType, targetedOwners = null, database = getDb()) {
  const db = database;
  if (!db) {
    throw syncContractError("Database not initialized", "SYNC_DB_UNAVAILABLE");
  }
  if (!["agent", "group", "topic", "avatar"].includes(dataType)) {
    throw syncContractError(`Unsupported manifest dataType ${dataType}`);
  }
  const ownerFilter = requireTargetedOwners(dataType, targetedOwners);

  if (dataType === "avatar") {
    const rows = db
      .prepare(
        "SELECT owner_id, owner_type, hash, updated_at, deleted_at FROM avatar_index",
      )
      .all();
    if (rows.length > MAX_MANIFEST_ITEMS) {
      throw syncContractError("Avatar manifest exceeds 10000 items", "SYNC_BUDGET_EXCEEDED");
    }
    return rows.map((row) => {
      const id = `${row.owner_type}:${row.owner_id}`;
      requireAvatarOwner(id);
      return {
        id,
        hash: requireHash(row.hash, `Avatar ${id} hash`),
        ts: requireTimestamp(row.updated_at, `Avatar ${id} timestamp`),
        deletedAt: requireOptionalTombstone(
          row.deleted_at,
          `Avatar ${id} deletedAt`,
        ),
      };
    });
  }

  const rows = dataType === "topic"
    ? db
        .prepare(
          "SELECT * FROM entity_index WHERE id <> 'default' AND (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic')",
        )
        .all()
    : db.prepare("SELECT * FROM entity_index WHERE type = ?").all(dataType);

  const syncRows = dataType === "topic"
    ? rows.filter((row) => row.id !== "default")
    : rows;
  const filteredRows = dataType === "topic" && ownerFilter
    ? syncRows.filter((row) => ownerFilter.has(topicOwnerFromPath(row.file_path).ownerId))
    : syncRows;
  if (filteredRows.length > MAX_MANIFEST_ITEMS) {
    throw syncContractError(
      `${dataType} manifest exceeds 10000 items`,
      "SYNC_BUDGET_EXCEEDED",
    );
  }

  if (dataType === "topic" || dataType === "agent" || dataType === "group") {
    const seen = new Set();
    return filteredRows.map((row) => {
      const id = requireNonEmptyString(row.id, `${dataType} manifest id`);
      if (!seen.add(id)) {
        throw syncContractError(
          `${dataType} manifest contains duplicate id ${id}`,
          "SYNC_INDEX_INVALID",
        );
      }
      const result = {
        id,
        hash: requireHash(row.hash, `${dataType} ${id} hash`),
        configHash: requireHash(row.hash, `${dataType} ${id} configHash`),
        contentHash: requireHash(
          row.aggregated_hash ?? "",
          `${dataType} ${id} contentHash`,
          { allowEmpty: true },
        ),
        ts: requireTimestamp(row.updated_at, `${dataType} ${id} timestamp`),
        deletedAt: requireOptionalTombstone(
          row.deleted_at,
          `${dataType} ${id} deletedAt`,
        ),
      };
      if (dataType === "topic") {
        const owner = topicOwnerFromPath(row.file_path);
        result.ownerType = owner.ownerType;
        result.ownerId = owner.ownerId;
      }
      return result;
    });
  }

  return [];
}

/**
 * 处理 SYNC_MANIFEST 消息
 * @param {object} payload - 消息载荷
 * @returns {object} 差异结果
 */
function normalizeRemoteManifestItem(item, dataType, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw syncContractError(`Manifest item ${index} must be an object`);
  }
  const id = requireNonEmptyString(item.id, `Manifest item ${index} id`);
  const normalized = {
    id,
    hash: requireHash(item.hash, `Manifest item ${id} hash`),
    ts: requireTimestamp(item.ts, `Manifest item ${id} timestamp`),
    deletedAt: requireOptionalTombstone(
      item.deletedAt,
      `Manifest item ${id} deletedAt`,
    ),
  };

  if (dataType === "avatar") {
    requireAvatarOwner(id);
    return normalized;
  }

  normalized.configHash = requireHash(
    item.configHash,
    `Manifest item ${id} configHash`,
  );
  normalized.contentHash = requireHash(
    item.contentHash,
    `Manifest item ${id} contentHash`,
    { allowEmpty: true },
  );
  if (dataType === "topic") {
    if (!matchesTopicOwnerType(item.ownerType)) {
      throw syncContractError(`Topic manifest ${id} requires agent/group ownerType`);
    }
    normalized.ownerType = item.ownerType;
    normalized.ownerId = requireNonEmptyString(
      item.ownerId,
      `Topic manifest ${id} ownerId`,
    );
  }
  return normalized;
}

function matchesTopicOwnerType(value) {
  return value === "agent" || value === "group";
}

function assertSameTopicOwner(remote, local) {
  if (
    remote.ownerType !== local.ownerType ||
    remote.ownerId !== local.ownerId
  ) {
    throw syncContractError(
      `Topic ${remote.id} owner conflicts with the desktop index`,
      "SYNC_OWNER_CONFLICT",
    );
  }
}

function actionIdentity(item, dataType) {
  return dataType === "topic"
    ? { ownerType: item.ownerType, ownerId: item.ownerId }
    : {};
}

function handleSyncManifest(payload, database = getDb()) {
  const { dataType, data: remoteItems, targetedOwners } = payload;
  const logger = getLogger();
  const phase = (dataType === "topic") ? "topic_metadata" : "owner_metadata";

  if (
    dataType !== "agent" &&
    dataType !== "group" &&
    dataType !== "avatar" &&
    dataType !== "topic"
  ) {
    throw syncContractError(`Unsupported manifest dataType ${dataType}`);
  }

  if (!Array.isArray(remoteItems)) {
    throw syncContractError("SYNC_MANIFEST.data must be an array");
  }
  if (remoteItems.length > MAX_MANIFEST_ITEMS) {
    throw syncContractError(
      `${dataType} manifest exceeds 10000 items`,
      "SYNC_BUDGET_EXCEEDED",
    );
  }
  const expectedPhase = dataType === "topic" ? 2 : 1;
  if (payload.phase !== expectedPhase) {
    throw syncContractError(
      `${dataType} manifest phase must be ${expectedPhase}`,
    );
  }

  const ownerFilter = requireTargetedOwners(dataType, targetedOwners);
  if (dataType === "topic" && ownerFilter === null) {
    throw syncContractError("Topic manifest requires targetedOwners");
  }
  const normalizedRemoteItems = remoteItems
    .map((item, index) => normalizeRemoteManifestItem(item, dataType, index))
    .filter((item) => dataType !== "topic" || item.id !== "default");
  const remoteById = new Map();
  for (const item of normalizedRemoteItems) {
    if (remoteById.has(item.id)) {
      throw syncContractError(`${dataType} manifest contains duplicate id ${item.id}`);
    }
    remoteById.set(item.id, item);
  }

  const localItems = getLocalManifest(dataType, targetedOwners, database);
  const localById = new Map(localItems.map((item) => [item.id, item]));
  const results = [];
  const processedIds = new Set();

  for (const remote of normalizedRemoteItems) {
    const local = localById.get(remote.id);
    const remoteDeletedAt = remote.deletedAt;
    if (dataType === "topic" && local) {
      assertSameTopicOwner(remote, local);
    }

    if (remoteDeletedAt !== null) {
      if (!local || local.deletedAt === null) {
        results.push({
          id: remote.id,
          action: "PUSH_DELETE",
          deletedAt: remoteDeletedAt,
          ...actionIdentity(remote, dataType),
        });
      }
      processedIds.add(remote.id);
    } else if (!local) {
      results.push({
        id: remote.id,
        action: "PUSH",
        ...actionIdentity(remote, dataType),
      });
      processedIds.add(remote.id);
    } else if (local.deletedAt !== null) {
      results.push({
        id: local.id,
        action: "DELETE",
        deletedAt: local.deletedAt,
        ...actionIdentity(local, dataType),
      });
      processedIds.add(local.id);
    } else {
      // V2: 双哈希比对
      const remoteConfig = remote.configHash || remote.hash;
      const remoteContent = remote.contentHash || "";
      const localConfig = local.configHash || local.hash;
      const localContent = local.contentHash || "";

      // 1. 比较配置
      if (localConfig !== remoteConfig) {
        if (remote.ts > local.ts) {
          results.push({
            id: remote.id,
            action: "PUSH",
            ...actionIdentity(remote, dataType),
          });
        } else {
          results.push({
            id: local.id,
            action: "PULL",
            ...actionIdentity(local, dataType),
          });
        }
      }

      // 2. 比较内容 (仅 Agent/Group)
      if ((dataType === "agent" || dataType === "group") && localContent !== remoteContent) {
        // 如果内容不匹配，标记 mismatchedContent 引导手机端发起 targeted topic sync
        const existingResult = results.find(r => r.id === remote.id);
        if (existingResult) {
          existingResult.mismatchedContent = true;
        } else {
          results.push({ id: remote.id, action: "SKIP", mismatchedContent: true });
        }
      }
      
      processedIds.add(remote.id);
    }
  }

  for (const local of localItems) {
    if (
      !processedIds.has(local.id) &&
      !remoteById.has(local.id)
    ) {
      if (local.deletedAt !== null) {
        results.push({
          id: local.id,
          action: "DELETE",
          deletedAt: local.deletedAt,
          ...actionIdentity(local, dataType),
        });
      } else {
        results.push({
          id: local.id,
          action: "PULL",
          ...actionIdentity(local, dataType),
        });
      }
    }
  }

  const pushCount = results.filter((r) => r.action === "PUSH").length;
  const pullCount = results.filter((r) => r.action === "PULL").length;
  const deleteCount = results.filter((r) => r.action === "DELETE").length;
  const skipCount = normalizedRemoteItems.filter((remote) => {
    const local = localById.get(remote.id);
    return local && local.deletedAt === null && remote.deletedAt === null && local.hash === remote.hash;
  }).length;

  logger.logOperation(phase, "diff", dataType, "success", `push=${pushCount} pull=${pullCount} delete=${deleteCount} skip=${skipCount}`);

  return {
    type: "SYNC_DIFF_RESULTS",
    data: results,
    dataType,
    phase: payload.phase,
  };
}

/**
 * 处理 GET_MESSAGE_MANIFEST 消息
 * @param {object} payload - 消息载荷
 * @returns {object} 消息清单
 */
function handleMessageManifest(payload, database = getDb()) {
  const db = database;
  if (!db) {
    throw syncContractError("Database not initialized", "SYNC_DB_UNAVAILABLE");
  }

  const logger = getLogger();
  const topicId = sanitizeId(payload.topicId);
  if (!topicId || topicId !== payload.topicId) {
    throw syncContractError("GET_MESSAGE_MANIFEST.topicId is invalid");
  }
  if (topicId === "default") {
    return { type: "MESSAGE_MANIFEST_RESULTS", topicId, messages: [] };
  }
  assertHistoryTopicHealthy(topicId);

  const rows = db
    .prepare(
      "SELECT msg_id, hash as content_hash, updated_at, deleted_at FROM message_index WHERE topic_id = ?",
    )
    .all(topicId);
  if (rows.length > MAX_MANIFEST_ITEMS) {
    throw syncContractError(
      `Message manifest ${topicId} exceeds 10000 messages`,
      "SYNC_BUDGET_EXCEEDED",
    );
  }
  const seen = new Set();
  const messages = rows.map((row, index) => {
    const msgId = requireNonEmptyString(
      row.msg_id,
      `Message manifest ${topicId}[${index}] msg_id`,
    );
    if (!seen.add(msgId)) {
      throw syncContractError(
        `Message manifest ${topicId} contains duplicate message ${msgId}`,
        "SYNC_INDEX_INVALID",
      );
    }
    return {
      msg_id: msgId,
      content_hash: requireHash(
        row.content_hash,
        `Message manifest ${topicId}/${msgId} content_hash`,
      ),
      updated_at: requireTimestamp(
        row.updated_at,
        `Message manifest ${topicId}/${msgId} updated_at`,
      ),
      deleted_at: requireOptionalTombstone(
        row.deleted_at,
        `Message manifest ${topicId}/${msgId} deleted_at`,
      ),
    };
  });

  logger.logOperation("messages", "manifest", topicId, "success", `messages=${messages.length}`);

  return {
    type: "MESSAGE_MANIFEST_RESULTS",
    topicId,
    messages,
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
