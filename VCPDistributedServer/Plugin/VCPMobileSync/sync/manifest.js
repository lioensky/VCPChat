/**
 * 清单生成与比对逻辑
 */

const { getDb, getAvatarDb } = require("../core/db");
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
  const owners = targetedOwners.map((owner, index) => {
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
      throw syncContractError(`targetedOwners[${index}] must be an owner identity`);
    }
    if (!matchesTopicOwnerType(owner.ownerType)) {
      throw syncContractError(`targetedOwners[${index}] requires agent/group ownerType`);
    }
    const ownerId = requireNonEmptyString(
      owner.ownerId,
      `targetedOwners[${index}] ownerId`,
    );
    return `${owner.ownerType}\0${ownerId}`;
  });
  if (new Set(owners).size !== owners.length) {
    throw syncContractError("targetedOwners contains a duplicate owner identity");
  }
  return new Set(owners);
}

function topicIdentity(item) {
  return `${item.ownerType}\0${item.ownerId}\0${item.id}`;
}

function manifestIdentity(item, dataType) {
  return dataType === "topic" ? topicIdentity(item) : item.id;
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
 * @param {object[]} targetedOwners - 仅针对特定所有者的复合身份列表
 * @returns {object[]} 本地实体列表
 */
function getLocalManifest(dataType, targetedOwners = null, database = null) {
  const db = database || (dataType === "avatar" ? getAvatarDb() : getDb());
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

  const syncRows = db.prepare("SELECT * FROM entity_index WHERE type = ?").all(dataType);
  const filteredRows = dataType === "topic" && ownerFilter
    ? syncRows.filter((row) => {
        return ownerFilter.has(`${row.owner_type}\0${row.owner_id}`);
      })
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
      const owner = dataType === "topic"
        ? {
            ownerType: requireNonEmptyString(row.owner_type, `Topic ${id} ownerType`),
            ownerId: requireNonEmptyString(row.owner_id, `Topic ${id} ownerId`),
          }
        : null;
      if (owner && !matchesTopicOwnerType(owner.ownerType)) {
        throw syncContractError(
          `Topic ${id} has invalid ownerType ${owner.ownerType}`,
          "SYNC_INDEX_INVALID",
        );
      }
      const identity = dataType === "topic"
        ? `${owner.ownerType}\0${owner.ownerId}\0${id}`
        : id;
      if (!seen.add(identity)) {
        throw syncContractError(
          `${dataType} manifest contains a duplicate entity identity for ${id}`,
          "SYNC_INDEX_INVALID",
        );
      }
      const result = {
        id,
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
    ts: requireTimestamp(item.ts, `Manifest item ${id} timestamp`),
    deletedAt: requireOptionalTombstone(
      item.deletedAt,
      `Manifest item ${id} deletedAt`,
    ),
  };

  if (dataType === "avatar") {
    requireAvatarOwner(id);
    normalized.hash = requireHash(item.hash, `Manifest item ${id} hash`);
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

function actionIdentity(item, dataType) {
  return dataType === "topic"
    ? { ownerType: item.ownerType, ownerId: item.ownerId }
    : {};
}

function handleSyncManifest(payload, database = null) {
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
    .map((item, index) => normalizeRemoteManifestItem(item, dataType, index));
  if (dataType === "topic") {
    for (const item of normalizedRemoteItems) {
      if (!ownerFilter.has(`${item.ownerType}\0${item.ownerId}`)) {
        throw syncContractError(
          `Topic manifest ${item.id} has an unexpected owner`,
        );
      }
    }
  }
  const remoteByKey = new Map();
  for (const item of normalizedRemoteItems) {
    const identity = manifestIdentity(item, dataType);
    if (remoteByKey.has(identity)) {
      throw syncContractError(`${dataType} manifest contains a duplicate entity identity`);
    }
    remoteByKey.set(identity, item);
  }

  const localItems = getLocalManifest(dataType, targetedOwners, database);
  const localByKey = new Map(
    localItems.map((item) => [manifestIdentity(item, dataType), item]),
  );
  const results = [];
  const processedKeys = new Set();

  for (const remote of normalizedRemoteItems) {
    const identity = manifestIdentity(remote, dataType);
    const local = localByKey.get(identity);
    const remoteDeletedAt = remote.deletedAt;

    if (remoteDeletedAt !== null) {
      if (!local || local.deletedAt === null) {
        results.push({
          id: remote.id,
          action: "PUSH_DELETE",
          deletedAt: remoteDeletedAt,
          ...actionIdentity(remote, dataType),
        });
      }
      processedKeys.add(identity);
    } else if (!local) {
      results.push({
        id: remote.id,
        action: "PUSH",
        ...actionIdentity(remote, dataType),
      });
      processedKeys.add(identity);
    } else if (local.deletedAt !== null) {
      results.push({
        id: local.id,
        action: "DELETE",
        deletedAt: local.deletedAt,
        ...actionIdentity(local, dataType),
      });
      processedKeys.add(identity);
    } else {
      // V2: 双哈希比对
      const remoteStateHash = dataType === "avatar" ? remote.hash : remote.configHash;
      const remoteContent = remote.contentHash;
      const localStateHash = dataType === "avatar" ? local.hash : local.configHash;
      const localContent = local.contentHash;

      // 1. 比较实体自身指纹（Avatar 为二进制 Hash，其余为 configHash）
      if (localStateHash !== remoteStateHash) {
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
        const existingResult = results.find(
          (result) => manifestIdentity(result, dataType) === identity,
        );
        if (existingResult) {
          existingResult.mismatchedContent = true;
        } else {
          results.push({ id: remote.id, action: "SKIP", mismatchedContent: true });
        }
      }
      
      processedKeys.add(identity);
    }
  }

  for (const local of localItems) {
    const identity = manifestIdentity(local, dataType);
    if (
      !processedKeys.has(identity) &&
      !remoteByKey.has(identity)
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
    const local = localByKey.get(manifestIdentity(remote, dataType));
    if (!local || local.deletedAt !== null || remote.deletedAt !== null) return false;
    return dataType === "avatar"
      ? local.hash === remote.hash
      : local.configHash === remote.configHash;
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
  const ownerType = payload.ownerType;
  const ownerId = payload.ownerId;
  if (
    !matchesTopicOwnerType(ownerType) ||
    typeof ownerId !== "string" ||
    ownerId.length === 0
  ) {
    throw syncContractError(
      "GET_MESSAGE_MANIFEST requires ownerType and ownerId",
    );
  }
  assertHistoryTopicHealthy({ topicId, ownerType, ownerId });

  const rows = db
    .prepare(
      `SELECT msg_id, hash as content_hash, updated_at, deleted_at
       FROM message_index
       WHERE owner_type = ? AND owner_id = ? AND topic_id = ?`,
    )
    .all(ownerType, ownerId, topicId);
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
    ownerType,
    ownerId,
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
