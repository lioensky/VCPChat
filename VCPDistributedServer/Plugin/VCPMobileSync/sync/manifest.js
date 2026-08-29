/**
 * 清单生成与比对逻辑
 */

const { getDb } = require("../core/db");
const { getLogger } = require("../core/logger");

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

function requireTargetedOwners(manifestType, targetedOwners) {
  if (targetedOwners == null) return null;
  if (manifestType !== "topic" || !Array.isArray(targetedOwners)) {
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
  return `${item.ownerType}\0${item.ownerId}\0${item.topicId}`;
}

function manifestIdentity(item, manifestType) {
  if (manifestType === "topic") return topicIdentity(item);
  return `${item.ownerType}\0${item.ownerId}`;
}

function requireAvatarOwner(ownerType, ownerId) {
  if (
    !["agent", "group", "user"].includes(ownerType) ||
    typeof ownerId !== "string" ||
    ownerId.length === 0 ||
    (ownerType === "user" && ownerId !== "user_avatar")
  ) {
    throw syncContractError(`Avatar manifest owner ${ownerType}/${ownerId} is invalid`);
  }
  return { ownerType, ownerId };
}

function requireExactKeys(value, allowed, label) {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key)) || keys.length !== allowed.size) {
    throw syncContractError(`${label} has unexpected or missing fields`);
  }
}

/**
 * 获取本地清单
 * @param {string} manifestType - 清单类型 (owner/topic/avatar)
 * @param {object[]} targetedOwners - 仅针对特定所有者的复合身份列表
 * @returns {object[]} 本地实体列表
 */
function getLocalManifest(manifestType, targetedOwners = null, database = null) {
  const db = database || getDb();
  if (!db) {
    throw syncContractError("Database not initialized", "SYNC_DB_UNAVAILABLE");
  }
  if (!["owner", "topic", "avatar"].includes(manifestType)) {
    throw syncContractError(`Unsupported manifestType ${manifestType}`);
  }
  const ownerFilter = requireTargetedOwners(manifestType, targetedOwners);

  if (manifestType === "avatar") {
    const rows = db
      .prepare(
        "SELECT owner_id, owner_type, hash, updated_at, deleted_at FROM avatar_index",
      )
      .all();
    if (rows.length > MAX_MANIFEST_ITEMS) {
      throw syncContractError("Avatar manifest exceeds 10000 items", "SYNC_BUDGET_EXCEEDED");
    }
    return rows.map((row) => {
      const ownerType = row.owner_type;
      const ownerId = row.owner_id;
      requireAvatarOwner(ownerType, ownerId);
      const deletedAt = requireOptionalTombstone(
        row.deleted_at,
        `Avatar ${ownerType}/${ownerId} deletedAt`,
      );
      return deletedAt === null
        ? {
            ownerType,
            ownerId,
            binaryHash: requireHash(
              row.hash,
              `Avatar ${ownerType}/${ownerId} binaryHash`,
            ),
            updatedAt: requireTimestamp(
              row.updated_at,
              `Avatar ${ownerType}/${ownerId} updatedAt`,
            ),
          }
        : { ownerType, ownerId, deletedAt };
    });
  }

  if (manifestType === "owner") {
    const rows = db.prepare(
      `SELECT owner_type, owner_id, config_hash, content_hash,
              updated_at, deleted_at
       FROM owners`,
    ).all();
    if (rows.length > MAX_MANIFEST_ITEMS) {
      throw syncContractError(
        "owner manifest exceeds 10000 items",
        "SYNC_BUDGET_EXCEEDED",
      );
    }
    return rows.map((row) => {
      const ownerId = requireNonEmptyString(row.owner_id, "Owner manifest ownerId");
      const ownerType = requireNonEmptyString(
        row.owner_type,
        `Owner ${ownerId} ownerType`,
      );
      if (!matchesTopicOwnerType(ownerType)) {
        throw syncContractError(
          `Owner ${ownerId} has invalid ownerType ${ownerType}`,
          "SYNC_INDEX_INVALID",
        );
      }
      const deletedAt = requireOptionalTombstone(
        row.deleted_at,
        `Owner ${ownerId} deletedAt`,
      );
      return deletedAt === null
        ? {
            ownerType,
            ownerId,
            configHash: requireHash(
              row.config_hash,
              `Owner ${ownerId} configHash`,
            ),
            contentHash: requireHash(
              row.content_hash,
              `Owner ${ownerId} contentHash`,
              { allowEmpty: true },
            ),
            updatedAt: requireTimestamp(
              row.updated_at,
              `Owner ${ownerId} updatedAt`,
            ),
          }
        : { ownerType, ownerId, deletedAt };
    });
  }

  const rows = db.prepare(
    `SELECT owner_type, owner_id, topic_id, config_hash, content_hash,
            updated_at, deleted_at
     FROM topics`,
  ).all();
  const filteredRows = ownerFilter
    ? rows.filter((row) => ownerFilter.has(`${row.owner_type}\0${row.owner_id}`))
    : rows;
  if (filteredRows.length > MAX_MANIFEST_ITEMS) {
    throw syncContractError(
      "topic manifest exceeds 10000 items",
      "SYNC_BUDGET_EXCEEDED",
    );
  }
  return filteredRows.map((row) => {
    const topicId = requireNonEmptyString(row.topic_id, "Topic manifest topicId");
    const ownerType = requireNonEmptyString(
      row.owner_type,
      `Topic ${topicId} ownerType`,
    );
    const ownerId = requireNonEmptyString(
      row.owner_id,
      `Topic ${topicId} ownerId`,
    );
    if (!matchesTopicOwnerType(ownerType)) {
      throw syncContractError(
        `Topic ${topicId} has invalid ownerType ${ownerType}`,
        "SYNC_INDEX_INVALID",
      );
    }
    const deletedAt = requireOptionalTombstone(
      row.deleted_at,
      `Topic ${topicId} deletedAt`,
    );
    return deletedAt === null
      ? {
          ownerType,
          ownerId,
          topicId,
          configHash: requireHash(
            row.config_hash,
            `Topic ${topicId} configHash`,
          ),
          contentHash: requireHash(
            row.content_hash,
            `Topic ${topicId} contentHash`,
            { allowEmpty: true },
          ),
          updatedAt: requireTimestamp(
            row.updated_at,
            `Topic ${topicId} updatedAt`,
          ),
        }
      : { ownerType, ownerId, topicId, deletedAt };
  });
}

/**
 * 处理 SYNC_MANIFEST_REQUEST 消息
 * @param {object} payload - 消息载荷
 * @returns {object} 差异结果
 */
function normalizeRemoteManifestItem(item, manifestType, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw syncContractError(`Manifest item ${index} must be an object`);
  }
  if (!matchesTopicOwnerType(item.ownerType) && manifestType !== "avatar") {
    throw syncContractError(`Manifest item ${index} requires agent/group ownerType`);
  }
  const ownerId = requireNonEmptyString(
    item.ownerId,
    `Manifest item ${index} ownerId`,
  );
  if (manifestType === "avatar") {
    requireAvatarOwner(item.ownerType, ownerId);
  }
  const identity = { ownerType: item.ownerType, ownerId };
  if (manifestType === "topic") {
    identity.topicId = requireNonEmptyString(
      item.topicId,
      `Manifest item ${index} topicId`,
    );
  }

  if (Object.prototype.hasOwnProperty.call(item, "deletedAt")) {
    const identityFields = manifestType === "topic"
      ? ["ownerType", "ownerId", "topicId", "deletedAt"]
      : ["ownerType", "ownerId", "deletedAt"];
    requireExactKeys(item, new Set(identityFields), `Manifest item ${index}`);
    return {
      ...identity,
      deletedAt: requireTimestamp(
        item.deletedAt,
        `Manifest item ${index} deletedAt`,
      ),
    };
  }

  if (manifestType === "avatar") {
    requireExactKeys(
      item,
      new Set(["ownerType", "ownerId", "binaryHash", "updatedAt"]),
      `Manifest item ${index}`,
    );
    return {
      ...identity,
      binaryHash: requireHash(
        item.binaryHash,
        `Manifest item ${index} binaryHash`,
      ),
      updatedAt: requireTimestamp(
        item.updatedAt,
        `Manifest item ${index} updatedAt`,
      ),
    };
  }

  const liveFields = manifestType === "topic"
    ? ["ownerType", "ownerId", "topicId", "configHash", "contentHash", "updatedAt"]
    : ["ownerType", "ownerId", "configHash", "contentHash", "updatedAt"];
  requireExactKeys(item, new Set(liveFields), `Manifest item ${index}`);
  return {
    ...identity,
    configHash: requireHash(
      item.configHash,
      `Manifest item ${index} configHash`,
    ),
    contentHash: requireHash(
      item.contentHash,
      `Manifest item ${index} contentHash`,
      { allowEmpty: true },
    ),
    updatedAt: requireTimestamp(
      item.updatedAt,
      `Manifest item ${index} updatedAt`,
    ),
  };
}

function matchesTopicOwnerType(value) {
  return value === "agent" || value === "group";
}

function actionIdentity(item, manifestType) {
  return manifestType === "topic"
    ? {
        ownerType: item.ownerType,
        ownerId: item.ownerId,
        topicId: item.topicId,
      }
    : { ownerType: item.ownerType, ownerId: item.ownerId };
}

function validateSyncManifestRequest(payload) {
  const { manifestType, items: remoteItems, targetedOwners } = payload || {};
  if (!["owner", "avatar", "topic"].includes(manifestType)) {
    throw syncContractError(`Unsupported manifestType ${manifestType}`);
  }
  if (!Array.isArray(remoteItems)) {
    throw syncContractError("SYNC_MANIFEST_REQUEST.items must be an array");
  }
  if (remoteItems.length > MAX_MANIFEST_ITEMS) {
    throw syncContractError(
      `${manifestType} manifest exceeds 10000 items`,
      "SYNC_BUDGET_EXCEEDED",
    );
  }

  const ownerFilter = requireTargetedOwners(manifestType, targetedOwners);
  if (manifestType === "topic" && ownerFilter === null) {
    throw syncContractError("Topic manifest requires targetedOwners");
  }
  const normalizedRemoteItems = remoteItems.map((item, index) =>
    normalizeRemoteManifestItem(item, manifestType, index),
  );
  if (manifestType === "topic") {
    for (const item of normalizedRemoteItems) {
      if (!ownerFilter.has(`${item.ownerType}\0${item.ownerId}`)) {
        throw syncContractError(
          `Topic manifest ${item.topicId} has an unexpected owner`,
        );
      }
    }
  }
  const remoteByKey = new Map();
  for (const item of normalizedRemoteItems) {
    const identity = manifestIdentity(item, manifestType);
    if (remoteByKey.has(identity)) {
      throw syncContractError(
        `${manifestType} manifest contains a duplicate entity identity`,
      );
    }
    remoteByKey.set(identity, item);
  }
  return {
    manifestType,
    targetedOwners,
    normalizedRemoteItems,
    remoteByKey,
  };
}

function handleSyncManifest(payload, database = null) {
  const {
    manifestType,
    targetedOwners,
    normalizedRemoteItems,
    remoteByKey,
  } = validateSyncManifestRequest(payload);
  const logger = getLogger();
  const phase = (manifestType === "topic") ? "topic_metadata" : "owner_metadata";

  const localItems = getLocalManifest(manifestType, targetedOwners, database);
  const localByKey = new Map(
    localItems.map((item) => [manifestIdentity(item, manifestType), item]),
  );
  const results = [];
  const processedKeys = new Set();

  for (const remote of normalizedRemoteItems) {
    const identity = manifestIdentity(remote, manifestType);
    const local = localByKey.get(identity);
    const remoteDeletedAt = remote.deletedAt ?? null;

    if (remoteDeletedAt !== null) {
      if (!local || local.deletedAt === undefined) {
        results.push({
          ...actionIdentity(remote, manifestType),
          action: "PUSH_DELETE",
          deletedAt: remoteDeletedAt,
        });
      }
      processedKeys.add(identity);
    } else if (!local) {
      results.push({
        ...actionIdentity(remote, manifestType),
        action: "PUSH",
      });
      processedKeys.add(identity);
    } else if (local.deletedAt !== undefined) {
      results.push({
        ...actionIdentity(local, manifestType),
        action: "PULL_DELETE",
        deletedAt: local.deletedAt,
      });
      processedKeys.add(identity);
    } else {
      // V2: 双哈希比对
      const remoteStateHash = manifestType === "avatar" ? remote.binaryHash : remote.configHash;
      const remoteContent = remote.contentHash;
      const localStateHash = manifestType === "avatar" ? local.binaryHash : local.configHash;
      const localContent = local.contentHash;

      // 1. 比较实体自身指纹（Avatar 为二进制 Hash，其余为 configHash）
      if (localStateHash !== remoteStateHash) {
        if (remote.updatedAt > local.updatedAt) {
          results.push({
            ...actionIdentity(remote, manifestType),
            action: "PUSH",
          });
        } else {
          results.push({
            ...actionIdentity(local, manifestType),
            action: "PULL",
          });
        }
      }

      // 2. 比较 Owner 内容根
      if (manifestType === "owner" && localContent !== remoteContent) {
        const existingResult = results.find(
          (result) => manifestIdentity(result, manifestType) === identity,
        );
        if (existingResult) {
          existingResult.contentHashMismatch = true;
        } else {
          results.push({
            ...actionIdentity(remote, manifestType),
            action: "SKIP",
            contentHashMismatch: true,
          });
        }
      }
      
      processedKeys.add(identity);
    }
  }

  for (const local of localItems) {
    const identity = manifestIdentity(local, manifestType);
    if (
      !processedKeys.has(identity) &&
      !remoteByKey.has(identity)
    ) {
      if (local.deletedAt !== undefined) {
        results.push({
          ...actionIdentity(local, manifestType),
          action: "PULL_DELETE",
          deletedAt: local.deletedAt,
        });
      } else {
        results.push({
          ...actionIdentity(local, manifestType),
          action: "PULL",
        });
      }
    }
  }

  const pushCount = results.filter((r) => r.action === "PUSH").length;
  const pullCount = results.filter((r) => r.action === "PULL").length;
  const deleteCount = results.filter((r) => r.action === "PULL_DELETE").length;
  const skipCount = normalizedRemoteItems.filter((remote) => {
    const local = localByKey.get(manifestIdentity(remote, manifestType));
    if (!local || local.deletedAt !== undefined || remote.deletedAt !== undefined) return false;
    return manifestType === "avatar"
      ? local.binaryHash === remote.binaryHash
      : local.configHash === remote.configHash;
  }).length;

  logger.logOperation(phase, "diff", manifestType, "success", `push=${pushCount} pull=${pullCount} pull_delete=${deleteCount} skip=${skipCount}`);

  return {
    type: "SYNC_MANIFEST_RESULT",
    manifestType,
    results,
  };
}

module.exports = {
  getLocalManifest,
  handleSyncManifest,
  validateSyncManifestRequest,
};
