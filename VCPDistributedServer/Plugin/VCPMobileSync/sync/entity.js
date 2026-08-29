/**
 * 实体上传下载核心逻辑
 */

const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const {
  getDb,
  getOwnerState,
  getTopicState,
  getAvatarIndex,
  upsertOwnerState,
  upsertTopicState,
  upsertAttachmentIndex,
  upsertAvatarIndex,
  upsertOwnerTombstone,
  upsertTopicTombstone,
  softDeleteAvatarIndex,
  refreshOwnerContentHash,
} = require("../core/db");
const {
  computeBinaryHash,
  computeDtoHash,
} = require("../core/hash");

const {
  createAgentConfig,
  createGroupConfig,
  createAgentTopic,
  createGroupTopic,
} = require("../config/defaults");
const { acquireLock } = require("../utils/lock");
const { getExtensionFromType } = require("../utils/mime");
const { getLogger } = require("../core/logger");
const {
  normalizeSyncError,
} = require("../error-contract");

const {
  extractAgentDTO,
  applyAgentDTO,
  AGENT_SYNC_FIELDS,
} = require("../dto/agent.dto");
const {
  extractGroupDTO,
  applyGroupDTO,
  GROUP_SYNC_FIELDS,
} = require("../dto/group.dto");
const {
  extractTopicDTO,
  extractAgentTopicDTO,
  extractGroupTopicDTO,
  applyAgentTopicDTO,
  applyGroupTopicDTO,
  AGENT_TOPIC_SYNC_FIELDS,
  GROUP_TOPIC_SYNC_FIELDS,
} = require("../dto/topic.dto");

const AVATAR_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const MAX_AVATAR_BYTES = 20 * 1024 * 1024;
const AVATAR_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

function detectAvatarMime(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 6) {
    const signature = data.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  throw new Error("Avatar upload bytes are not png, jpeg, gif, or webp");
}

function resolveAvatarMime(rawMimeType, data) {
  const value = typeof rawMimeType === "string"
    ? rawMimeType.split(";", 1)[0].trim().toLowerCase()
    : "";
  if (!AVATAR_MIME_TYPES.has(value)) {
    throw new Error("Avatar upload requires png, jpeg, gif, or webp Content-Type");
  }
  const requestedMimeType = value === "image/jpg" ? "image/jpeg" : value;
  const mimeType = detectAvatarMime(data);
  return {
    mimeType,
    extension: getExtensionFromType(mimeType),
    mimeMismatch: requestedMimeType !== mimeType,
  };
}

const writeIntentLock = new Map();

function entityStage(type) {
  return ["topic", "agent_topic", "group_topic"].includes(type)
    ? "topic_metadata"
    : "owner_metadata";
}

function getEntityState(id, type, ownerType = null, ownerId = null) {
  if (["topic", "agent_topic", "group_topic"].includes(type)) {
    return getTopicState({ topicId: id, ownerType, ownerId });
  }
  return getOwnerState({ ownerType: type, ownerId: id });
}

function entityIdentityKey({ id, type, ownerType, ownerId }) {
  return ["topic", "agent_topic", "group_topic"].includes(type)
    ? `${ownerType}\0${ownerId}\0${id}`
    : `${type}\0${id}`;
}

function addWriteIntent(identity) {
  const key = entityIdentityKey(identity);
  writeIntentLock.set(key, (writeIntentLock.get(key) || 0) + 1);
  return key;
}

function releaseWriteIntent(key) {
  setTimeout(() => {
    const count = writeIntentLock.get(key);
    if (count === undefined) return;
    if (count <= 1) {
      writeIntentLock.delete(key);
    } else {
      writeIntentLock.set(key, count - 1);
    }
  }, 1000);
}

function entityFailure(error, fallback, fields = {}) {
  return {
    success: false,
    ...fields,
    error: normalizeSyncError(error, fallback),
  };
}

function entityResultIdentity(request) {
  return {
    id: request.id,
    type: request.type,
    ...(request.ownerType === undefined ? {} : { ownerType: request.ownerType }),
    ...(request.ownerId === undefined ? {} : { ownerId: request.ownerId }),
  };
}

function entityDtoHash(dto, type, ownerType = null) {
  if (["topic", "agent_topic", "group_topic"].includes(type)) {
    return computeDtoHash(
      dto,
      ownerType === "group"
        ? GROUP_TOPIC_SYNC_FIELDS
        : AGENT_TOPIC_SYNC_FIELDS,
    );
  }
  return computeDtoHash(
    dto,
    type === "group" ? GROUP_SYNC_FIELDS : AGENT_SYNC_FIELDS,
  );
}

function assertEntityDtoMatchesIndex(dto, row, type, id) {
  const actualHash = entityDtoHash(dto, type, row.owner_type);
  if (actualHash !== row.config_hash) {
    throw Object.assign(
      new Error(
        `Entity ${row.owner_type}/${row.owner_id}/${id} changed after its manifest was indexed`,
      ),
      { code: "SYNC_SNAPSHOT_STALE" },
    );
  }
}

function topicDtoMatchingIndex(candidates, topicId, row, type) {
  const isGroup = row.owner_type === "group";
  for (const config of [candidates.primary, candidates.backup, candidates.topicBackup]) {
    const topic = (Array.isArray(config?.topics) ? config.topics : [])
      .find((value) => value?.id === topicId);
    if (!topic) continue;
    const dto = isGroup
      ? extractGroupTopicDTO(topic, row.owner_id)
      : extractAgentTopicDTO(topic, row.owner_id);
    if (entityDtoHash(dto, type, row.owner_type) === row.config_hash) return dto;
  }
  return null;
}

function ownerDtoMatchingIndex(candidates, row, type) {
  for (const config of [candidates.primary, candidates.backup, candidates.topicBackup]) {
    if (!config) continue;
    const dto = type === "group" ? extractGroupDTO(config) : extractAgentDTO(config);
    if (entityDtoHash(dto, type) === row.config_hash) return dto;
  }
  return null;
}

async function isDirectory(directory) {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * 批量下载实体
 * @param {object[]} requests - 请求列表 [{id, type}]
 * @returns {Promise<object[]>} DTO 列表
 */
async function downloadEntities(requests) {
  if (!Array.isArray(requests)) return [];

  // 按 config_path 分组，每个 config.json 只读取一次
  const fileGroups = new Map();
  const results = [];
  const seen = new Set();
  for (const req of requests) {
    const safeId = sanitizeId(req.id);
    const key = entityIdentityKey({ ...req, id: safeId });
    const validType = [
      "agent",
      "group",
      "agent_topic",
      "group_topic",
    ].includes(req.type);
    const isTopic = ["agent_topic", "group_topic"].includes(req.type);
    const validOwner =
      !isTopic ||
      (["agent", "group"].includes(req.ownerType) &&
        typeof req.ownerId === "string" &&
        sanitizeId(req.ownerId) === req.ownerId &&
        (req.type !== "agent_topic" || req.ownerType === "agent") &&
        (req.type !== "group_topic" || req.ownerType === "group"));
    if (
      !safeId ||
      safeId !== req.id ||
      !validType ||
      !validOwner ||
      seen.has(key)
    ) {
      results.push(entityFailure(
        seen.has(key) ? "duplicate entity request" : "invalid entity identity",
        { code: "SYNC_REQUEST_INVALID", stage: entityStage(req.type) },
        entityResultIdentity(req),
      ));
      continue;
    }
    seen.add(key);
    const row = getEntityState(
      safeId,
      req.type,
      req.ownerType,
      req.ownerId,
    );
    if (!row || row.deleted_at != null) {
      results.push(entityFailure("entity not found", {
        code: "SYNC_ENTITY_NOT_FOUND",
        stage: entityStage(req.type),
        failedTopicIds:
          entityStage(req.type) === "topic_metadata" ? [safeId] : [],
      }, entityResultIdentity(req)));
      continue;
    }

    if (!fileGroups.has(row.config_path)) {
      fileGroups.set(row.config_path, {
        ownerType: row.owner_type,
        reqs: [],
      });
    }
    fileGroups.get(row.config_path).reqs.push({ req, safeId, row });
  }

  const logger = getLogger();

  for (const [filePath, { ownerType, reqs }] of fileGroups) {
    try {
      const candidates = await readConfigForRepair(filePath, ownerType);

      for (const { req, safeId, row } of reqs) {
        let dto = null;
        const type = req.type;
        const phase = (type === "agent_topic" || type === "group_topic")
          ? "topic_metadata"
          : "owner_metadata";

        if (type === "agent_topic" || type === "group_topic") {
          dto = topicDtoMatchingIndex(candidates, safeId, row, type);
        } else if (type === "agent") {
          logger.logOperation(phase, "download", safeId, "success", `type=${type}`);
          dto = ownerDtoMatchingIndex(candidates, row, type);
        } else if (type === "group") {
          logger.logOperation(phase, "download", safeId, "success", `type=${type}`);
          dto = ownerDtoMatchingIndex(candidates, row, type);
        }

        if (dto) {
          try {
            assertEntityDtoMatchesIndex(dto, row, type, safeId);
            results.push({
              ...entityResultIdentity(req),
              success: true,
              data: dto,
            });
          } catch (error) {
            results.push(entityFailure(error, {
              code: "SYNC_ENTITY_READ_FAILED",
              stage: entityStage(type),
              failedTopicIds:
                entityStage(type) === "topic_metadata" ? [safeId] : [],
            }, entityResultIdentity(req)));
          }
        } else {
          results.push(entityFailure(
            "entity data was not found in its config",
            {
              code: "SYNC_ENTITY_READ_FAILED",
              stage: entityStage(type),
              failedTopicIds:
                entityStage(type) === "topic_metadata" ? [safeId] : [],
            },
            entityResultIdentity(req),
          ));
        }
      }
    } catch (e) {
      logger.logOperation("owner_metadata", "download", filePath, "error", e.message);
      for (const { req } of reqs) {
        results.push(entityFailure(e, {
          code: "SYNC_ENTITY_READ_FAILED",
          stage: entityStage(req.type),
          failedTopicIds:
            entityStage(req.type) === "topic_metadata" ? [req.id] : [],
        }, entityResultIdentity(req)));
      }
    }
  }

  return results;
}

/**
 * 批量上传实体 (主要用于 Topic 归口优化)
 * @param {object[]} items - [{id, type, data}]
 * @param {string} appDataPath
 * @returns {Promise<object[]>} 结果列表
 */
async function uploadEntitiesBatch(items, appDataPath) {
  if (!Array.isArray(items)) return [];

  const db = getDb();
  const logger = getLogger();
  logger.logInfo("topic_metadata", `Received batch upload request with ${items.len || items.length} items`);
  const results = [];

  // 1. 预处理：按 configPath 分组
  const fileGroups = new Map(); // Map<configPath, { items: [] }>
  const addedIntentLocks = new Set();
  const seenTopics = new Set();

  for (const item of items) {
    const { id, type, ownerType, ownerId, data } = item;
    const safeId = sanitizeId(id);
    const identityKey = entityIdentityKey({ id: safeId, type, ownerType, ownerId });
    if (
      !safeId ||
      safeId !== id ||
      seenTopics.has(identityKey) ||
      !["agent_topic", "group_topic"].includes(type) ||
      !["agent", "group"].includes(ownerType) ||
      typeof ownerId !== "string" ||
      sanitizeId(ownerId) !== ownerId ||
      (type === "agent_topic" && ownerType !== "agent") ||
      (type === "group_topic" && ownerType !== "group") ||
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      data.ownerId !== ownerId ||
      (data.ownerType !== undefined && data.ownerType !== ownerType)
    ) {
      results.push(entityFailure(
        seenTopics.has(identityKey)
          ? "Duplicate entity identity"
          : "Batch upload only accepts valid agent_topic/group_topic items",
        {
          code: "SYNC_REQUEST_INVALID",
          stage: "topic_metadata",
          failedTopicIds: safeId ? [safeId] : [],
        },
        entityResultIdentity(item),
      ));
      continue;
    }
    seenTopics.add(identityKey);
    const expectedConfigPath = path.join(
      appDataPath,
      ownerType === "group" ? "AgentGroups" : "Agents",
      ownerId,
      "config.json",
    );
    let configPath;
    let row = getTopicState({ topicId: safeId, ownerType, ownerId });
    const parent = getOwnerState({ ownerType, ownerId });

    if (row?.deleted_at != null || !parent || parent.deleted_at != null) {
      results.push(entityFailure("Entity or its owner is deleted", {
        code: "SYNC_ENTITY_NOT_FOUND",
        stage: "topic_metadata",
        failedTopicIds: [safeId],
      }, entityResultIdentity(item)));
      continue;
    }

    if (row) {
      configPath = row.config_path;
    } else {
      configPath = expectedConfigPath;
    }

    if (!configPath) {
      results.push(entityFailure("Cannot resolve config path", {
        code: "SYNC_ENTITY_NOT_FOUND",
        stage: "topic_metadata",
        failedTopicIds: [safeId],
      }, entityResultIdentity(item)));
      continue;
    }
    if (path.resolve(configPath) !== path.resolve(expectedConfigPath)) {
      results.push(entityFailure("Topic owner identity conflict", {
        code: "SYNC_OWNER_CONFLICT",
        stage: "topic_metadata",
        failedTopicIds: [safeId],
      }, entityResultIdentity(item)));
      continue;
    }
    addedIntentLocks.add(addWriteIntent({
      id: safeId,
      type,
      ownerType,
      ownerId,
    }));

    if (!fileGroups.has(configPath)) {
      fileGroups.set(configPath, { items: [] });
    }
    fileGroups.get(configPath).items.push({
      id: safeId,
      type,
      ownerType,
      ownerId,
      data,
    });
  }

  try {
    // 2. 按文件顺序处理，每个文件执行一次读取-修改-写入
    for (const [configPath, group] of fileGroups) {
      const release = await acquireLock(configPath);
      try {
        const content = await fs.readFile(configPath, "utf-8");
        if (!content.trim()) {
          throw new Error("Parent config is empty");
        }
        let config = JSON.parse(content);
        if (!config || typeof config !== "object" || Array.isArray(config)) {
          throw new Error("Parent config root must be an object");
        }
        const successfulIds = new Set();

        // 依次应用该文件下的所有更新
        for (const item of group.items) {
          const { id, type, data } = item;

          try {
            config = await handleTopicUpload({
              config,
              id,
              entityType: type,
              data,
              configPath,
              appDataPath,
            });

            results.push({
              ...entityResultIdentity(item),
              success: true,
            });
            successfulIds.add(id);
          } catch (e) {
            results.push(entityFailure(e, {
              code: "SYNC_ENTITY_WRITE_FAILED",
              stage: "topic_metadata",
              failedTopicIds: [id],
            }, entityResultIdentity(item)));
          }
        }

        if (successfulIds.size === 0) continue;

        // 原子写入
        const tmpPath = `${configPath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
        await fs.rename(tmpPath, configPath);

        // 同一父 config 的 Topic 状态先全部提交，再只刷新一次 Owner root。
        const successfulItems = group.items.filter((item) => successfulIds.has(item.id));
        const commitIndex = db.transaction(() => {
          for (const item of successfulItems) {
            updateTopicStateFromConfig(
              item.id,
              config,
              item.ownerType,
              item.ownerId,
              { refreshOwner: false },
            );
          }
          const owner = successfulItems[0];
          refreshOwnerContentHash({
            ownerType: owner.ownerType,
            ownerId: owner.ownerId,
          });
        });
        commitIndex();
      } catch (e) {
        // 文件级错误会让该组所有 item 失败。父 config 不存在时返回
        // SYNC_ENTITY_NOT_FOUND，手机端可据此区分缺失父 Owner 与普通写入失败。
        const isMissingParent = e && e.code === "ENOENT";
        logger.logOperation("topic_metadata", "batch_upload", configPath, "error", e.message);
        const groupIds = new Set(group.items.map(entityIdentityKey));
        for (let index = results.length - 1; index >= 0; index -= 1) {
          if (groupIds.has(entityIdentityKey(results[index]))) results.splice(index, 1);
        }
        for (const item of group.items) {
          results.push(entityFailure(e, {
            code: isMissingParent ? "SYNC_ENTITY_NOT_FOUND" : "SYNC_ENTITY_BATCH_FAILED",
            stage: "topic_metadata",
            failedTopicIds: [item.id],
          }, entityResultIdentity(item)));
        }
      } finally {
        release();
      }
    }
  } finally {
    for (const key of addedIntentLocks) {
      releaseWriteIntent(key);
    }
  }

  return results;
}

/**
 * 上传实体 - 将 DTO 合并到桌面端配置
 * @param {object} params
 * @param {string} params.id - 实体 ID
 * @param {string} params.type - 实体类型 (agent/group/topic)
 * @param {object} params.data - DTO 数据
 * @param {string} params.appDataPath - AppData 路径
 * @returns {Promise<{success: boolean, error?: object}>}
 */
async function uploadEntity({ id, type, ownerType, ownerId, data, appDataPath }) {
  const db = getDb();
  const logger = getLogger();
  if (!db) {
    return entityFailure("Database not initialized", {
      code: "SYNC_DB_UNAVAILABLE",
      stage: entityStage(type),
    }, entityResultIdentity({ id, type, ownerType, ownerId }));
  }

  const safeId = sanitizeId(id);
  if (
    !safeId ||
    safeId !== id ||
    !["agent", "group", "agent_topic", "group_topic"].includes(type) ||
    !data ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    return entityFailure("Invalid entity upload payload", {
      code: "SYNC_REQUEST_INVALID",
      stage: entityStage(type),
    }, entityResultIdentity({ id, type, ownerType, ownerId }));
  }
  const isTopic = type === "agent_topic" || type === "group_topic";
  const topicOwnerType = isTopic ? ownerType : type;
  const topicOwnerId = isTopic ? ownerId : safeId;
  const resultIdentity = entityResultIdentity({
    id: safeId,
    type,
    ...(isTopic ? { ownerType: topicOwnerType, ownerId: topicOwnerId } : {}),
  });
  if (
    isTopic &&
    (
      !["agent", "group"].includes(topicOwnerType) ||
      typeof topicOwnerId !== "string" ||
      sanitizeId(topicOwnerId) !== topicOwnerId ||
      (type === "agent_topic" && topicOwnerType !== "agent") ||
      (type === "group_topic" && topicOwnerType !== "group") ||
      data.ownerId !== topicOwnerId ||
      (data.ownerType !== undefined && data.ownerType !== topicOwnerType)
    )
  ) {
    return entityFailure("Invalid topic owner identity", {
      code: "SYNC_REQUEST_INVALID",
      stage: "topic_metadata",
      failedTopicIds: [safeId],
    }, resultIdentity);
  }
  const phase = isTopic ? "topic_metadata" : "owner_metadata";

  // 1. 查找现有配置文件路径
  let row = getEntityState(
    safeId,
    type,
    topicOwnerType,
    topicOwnerId,
  );
  if (row?.deleted_at != null) {
    return entityFailure("Entity is deleted", {
      code: "SYNC_ENTITY_NOT_FOUND",
      stage: phase,
      failedTopicIds: isTopic ? [safeId] : [],
    }, resultIdentity);
  }
  if (isTopic) {
    const parent = getOwnerState({
      ownerType: topicOwnerType,
      ownerId: topicOwnerId,
    });
    if (!parent || parent.deleted_at != null) {
      return entityFailure("Topic owner is missing or deleted", {
        code: "SYNC_ENTITY_NOT_FOUND",
        stage: phase,
        failedTopicIds: [safeId],
      }, resultIdentity);
    }
  }
  let configPath;
  let isNewEntity = false;
  const expectedConfigPath = path.join(
    appDataPath,
    topicOwnerType === "group" ? "AgentGroups" : "Agents",
    topicOwnerId,
    "config.json",
  );

  if (!row && !isTopic) {
    // 新建 Agent/Group
    const newEntityDir = path.dirname(expectedConfigPath);
    configPath = expectedConfigPath;
    await fs.mkdir(newEntityDir, { recursive: true });
    isNewEntity = true;
  } else if (row) {
    configPath = row.config_path;
  } else if (isTopic && topicOwnerId) {
    // 新建 Topic: 根据归属信息反推父级路径
    configPath = expectedConfigPath;
    try {
      await fs.access(configPath);
    } catch {
      logger.logOperation(phase, "upload", safeId, "error", `parent entity ${topicOwnerId} not found`);
      return entityFailure(
        `Parent entity ${topicOwnerId} not found on desktop`,
        {
          code: "SYNC_ENTITY_NOT_FOUND",
          stage: "topic_metadata",
          failedTopicIds: [safeId],
        },
        resultIdentity,
      );
    }
  } else {
    logger.logOperation(phase, "upload", safeId, "error", "topic parent entity metadata missing");
    return entityFailure("Topic parent entity metadata missing", {
      code: "SYNC_REQUEST_INVALID",
      stage: "topic_metadata",
      failedTopicIds: [safeId],
    }, resultIdentity);
  }

  if (path.resolve(configPath) !== path.resolve(expectedConfigPath)) {
    return entityFailure("Entity owner identity conflict", {
      code: "SYNC_OWNER_CONFLICT",
      stage: phase,
      failedTopicIds: isTopic ? [safeId] : [],
    }, resultIdentity);
  }

  const writeIntentKey = addWriteIntent({
    id: safeId,
    type,
    ownerType: topicOwnerType,
    ownerId: topicOwnerId,
  });

  const release = await acquireLock(configPath);
  try {
    // 2. 读取现有配置或初始化
    let config = {};
    let fileReadSuccess = false;
    try {
      const content = await fs.readFile(configPath, "utf-8");
      if (content.trim() === "") {
        throw new Error("Empty config file");
      }
      config = JSON.parse(content);
      if (typeof config !== "object" || config === null || Array.isArray(config)) {
        throw new Error("Invalid config structure: not an object");
      }
      fileReadSuccess = true;
    } catch (e) {
      if (e.code === "ENOENT") {
        // 文件确实不存在，正常新建
        fileReadSuccess = false;
      } else {
        // 文件存在但损坏/空/不可读，拒绝覆盖以防止数据丢失
        logger.logOperation(phase, "upload", safeId, "error", `corrupted config at ${configPath}: ${e.message}`);
        throw new Error(`Cannot upload to corrupted config: ${e.message}`);
      }
    }

    // 3. 根据 type 处理
    if (isTopic) {
      config = await handleTopicUpload({
        config,
        id: safeId,
        entityType: type,
        data,
        configPath,
        appDataPath,
      });
    } else if (type === "agent") {
      config = handleAgentUpload({ config, id: safeId, data, isNewEntity, fileReadSuccess });
    } else if (type === "group") {
      config = handleGroupUpload({ config, id: safeId, data, isNewEntity, fileReadSuccess });
    }

    // 4. 写入前校验：确保 config 不为数组且包含正确的 id
    if (Array.isArray(config)) {
      throw new Error(`Refusing to write array as config for ${safeId}`);
    }
    // Group 配置必须包含 id 且匹配；Agent 配置不写入 id，由目录名推导
    if (type === "group" && config.id !== safeId) {
      logger.logOperation(phase, "upload", safeId, "error", `Config ID mismatch: expected ${safeId}, got ${config.id}`);
      throw new Error(`Config ID mismatch for ${safeId}`);
    }

    // V2: 原子写入，防止并发导致文件内容为空或损坏
    const tmpPath = `${configPath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    await fs.rename(tmpPath, configPath);

    // 5. 更新索引 (V2: 使用 DTO 提取以对齐默认值处理)
    if (isTopic) {
      updateTopicStateFromConfig(
        safeId,
        config,
        topicOwnerType,
        topicOwnerId,
      );
    } else {
      const dto = type === "agent" ? extractAgentDTO(config) : extractGroupDTO(config);
      const hash = computeDtoHash(
        dto,
        type === "agent" ? AGENT_SYNC_FIELDS : GROUP_SYNC_FIELDS,
      );
      upsertOwnerState({
        ownerType: type,
        ownerId: safeId,
        configPath,
        configHash: hash,
      });
    }

    logger.logOperation(phase, "upload", safeId, "success", `type=${type}, isNewEntity=${isNewEntity}, fileReadSuccess=${fileReadSuccess}`);
    return { success: true, ...resultIdentity };
  } catch (e) {
    logger.logOperation(phase, "upload", safeId, "error", e.message);
    return entityFailure(e, {
      code: "SYNC_ENTITY_WRITE_FAILED",
      stage: phase,
      failedTopicIds: isTopic ? [safeId] : [],
    }, resultIdentity);
  } finally {
    release();
    releaseWriteIntent(writeIntentKey);
  }
}

// 内部函数：处理 Agent 上传
function handleAgentUpload({ config, id, data, isNewEntity, fileReadSuccess }) {
  // 只有文件确实不存在时才调用 createAgentConfig
  // fileReadSuccess=false 且 isNewEntity=true：正常新建
  // fileReadSuccess=false 且 isNewEntity=false：索引与实际文件不一致，重建
  if (!fileReadSuccess) {
    config = createAgentConfig(id, data);
  } else {
    // 更新场景：DTO 局部覆盖，保留桌面端特有字段（包括 topics）
    // 注意：Agent 配置不写入 id 字段，id 由目录名推导
    applyAgentDTO(config, data);
    // Agent/Group 上传绝不触碰 topics 数组，topics 由 Phase 2 独立同步
  }
  return config;
}

// 内部函数：处理 Group 上传
function handleGroupUpload({ config, id, data, isNewEntity, fileReadSuccess }) {
  if (!fileReadSuccess) {
    config = createGroupConfig(id, data);
  } else {
    // 更新场景：DTO 局部覆盖，保留桌面端特有字段（包括 topics）
    config.id = id;
    applyGroupDTO(config, data);
    // Agent/Group 上传绝不触碰 topics 数组，topics 由 Phase 2 独立同步
  }
  return config;
}

// 内部函数：处理 Topic 上传
async function handleTopicUpload({
  config,
  id,
  entityType,
  data,
  configPath,
  appDataPath,
}) {
  // 防御：若 config 为数组或无效对象，说明文件读取异常，尝试重新读取父级 config
  if (Array.isArray(config) || config === null || typeof config !== 'object') {
    getLogger().logOperation("topic_metadata", "upload", id, "error", "invalid config, refusing to write");
    throw new Error(`Invalid parent config for topic ${id}`);
  }

  if (!Array.isArray(config.topics)) {
    config.topics = [];
  }

  // Topic 物理目录是生存性真源。无论 config 中是否已有该 Topic，都先确保
  // history.json 存在；wx 保证并发或既有历史绝不会被空数组覆盖。
  const parentId = path.basename(path.dirname(configPath));
  const historyDir = path.join(
    appDataPath,
    "UserData",
    parentId,
    "topics",
    id,
  );
  await fs.mkdir(historyDir, { recursive: true });
  const historyPath = path.join(historyDir, "history.json");
  try {
    await fs.writeFile(historyPath, "[]", { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const isGroupTopic = entityType === "group_topic";
  const topicIdx = config.topics.findIndex((t) => t.id === id);

  if (topicIdx > -1) {
    // 更新现有 topic
    if (isGroupTopic) {
      config.topics[topicIdx] = applyGroupTopicDTO(
        config.topics[topicIdx],
        data,
      );
    } else {
      config.topics[topicIdx] = applyAgentTopicDTO(
        config.topics[topicIdx],
        data,
      );
    }
  } else {
    // 新建 topic
    const newTopic = isGroupTopic
      ? createGroupTopic(data)
      : createAgentTopic(data);
    config.topics.push(newTopic);
  }

  // 按 createdAt 降序排序
  config.topics.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return config;
}

// 内部函数：更新 Topic 索引
function updateTopicStateFromConfig(
  id,
  config,
  ownerType,
  ownerId,
  { refreshOwner = true } = {},
) {
  const isGroupTopic = ownerType === "group";
  const topicObj = (config.topics || []).find((t) => t.id === id);

  if (topicObj) {
    // V2: 使用 DTO 提取以对齐默认值处理
    const topicDto = extractTopicDTO(topicObj, ownerId, ownerType);
    
    const hash = computeDtoHash(
      topicDto,
      isGroupTopic ? GROUP_TOPIC_SYNC_FIELDS : AGENT_TOPIC_SYNC_FIELDS,
    );
    upsertTopicState({
      ownerType,
      ownerId,
      topicId: id,
      configHash: hash,
    });
    if (refreshOwner) {
      refreshOwnerContentHash({ ownerType, ownerId });
    }
  }
}

function parseJsonObject(content, label) {
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error(`${label} root must be an object`), {
      code: "CONFIG_ROOT_INVALID",
    });
  }
  return parsed;
}

async function readOptionalConfig(filePath) {
  try {
    return parseJsonObject(await fs.readFile(filePath, "utf-8"), filePath);
  } catch {
    return null;
  }
}

async function readConfigForRepair(configPath, ownerType) {
  return {
    primary: await readOptionalConfig(configPath),
    backup: await readOptionalConfig(`${configPath}.backup`),
    topicBackup: ownerType === "agent"
      ? await readOptionalConfig(path.join(path.dirname(configPath), "config.topic.backup.json"))
      : null,
  };
}

async function writeJsonAtomic(filePath, value, { preserveBackup = false } = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const backupPath = `${filePath}.backup`;
  const backupTemporary = `${backupPath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), "utf-8");
    let expectedCurrent = null;
    try {
      expectedCurrent = await fs.readFile(filePath, "utf-8");
      parseJsonObject(expectedCurrent, filePath);
      if (!preserveBackup) {
        await fs.writeFile(backupTemporary, expectedCurrent, "utf-8");
        await fs.rename(backupTemporary, backupPath);
      }
    } catch (error) {
      if (
        error.code !== "ENOENT" &&
        error.code !== "CONFIG_ROOT_INVALID" &&
        !(error instanceof SyntaxError)
      ) {
        throw error;
      }
      await fs.unlink(backupTemporary).catch(() => {});
    }
    const observedCurrent = await fs.readFile(filePath, "utf-8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (observedCurrent !== expectedCurrent) {
      throw Object.assign(
        new Error(`Config changed while updating ${filePath}`),
        { code: "SYNC_SNAPSHOT_STALE" },
      );
    }
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    await fs.unlink(backupTemporary).catch(() => {});
    throw error;
  }
}

function topicTimestampFromId(topicId) {
  const match = /^(?:group_)?topic_(\d+)$/.exec(topicId);
  if (!match) return null;
  const timestamp = Number(match[1]);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

async function recoveryTimestamp(topicId, historyPath) {
  const idTimestamp = topicTimestampFromId(topicId);
  if (idTimestamp !== null) return idTimestamp;

  try {
    const stats = await fs.stat(historyPath);
    if (stats.isFile() && Number.isFinite(stats.mtimeMs) && stats.mtimeMs >= 0) {
      return Math.trunc(stats.mtimeMs);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return 0;
}

function isSyntheticRecoveredTopic(topic, topicId) {
  return topic?.name === `Recovered: ${topicId}`;
}

async function normalizeRecoveredTimestamp(topic, topicId, historyPath) {
  if (!isSyntheticRecoveredTopic(topic, topicId)) return topic;
  const createdAt = await recoveryTimestamp(topicId, historyPath);
  return topic.createdAt === createdAt ? topic : { ...topic, createdAt };
}

async function listDirectories(directory) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function repairOwnerTopicProjection({
  appDataPath,
  ownerId,
  ownerType,
  physicalTopics,
  recoverTopics,
}) {
  const ownerRoot = ownerType === "group" ? "AgentGroups" : "Agents";
  const configPath = path.join(appDataPath, ownerRoot, ownerId, "config.json");
  const release = await acquireLock(configPath);
  try {
    const candidates = await readConfigForRepair(configPath, ownerType);
    let config = candidates.primary || candidates.backup || candidates.topicBackup;
    let configRecovered = candidates.primary === null;
    if (!config) {
      // 没有任何物理 Topic 时不存在可恢复的数据，保留损坏文件供人工处理。
      if (physicalTopics.size === 0) {
        return { changed: false, added: 0, removed: 0 };
      }
      config = ownerType === "group"
        ? createGroupConfig(ownerId, { name: `Recovered ${ownerId}`, members: [] })
        : createAgentConfig(ownerId, { name: `Recovered ${ownerId}` });
      config._recoveredAt = Date.now();
      config._recoveredFrom = "VCPMobileSync physical topic projection";
      configRecovered = true;
    }

    const previousTopics = Array.isArray(config.topics) ? config.topics : [];
    const topicCandidates = (candidate) => new Map(
      (Array.isArray(candidate?.topics) ? candidate.topics : [])
        .filter((topic) =>
          topic &&
          typeof topic === "object" &&
          !Array.isArray(topic) &&
          typeof topic.id === "string" &&
          sanitizeId(topic.id) === topic.id &&
          topic.id.length > 0
        )
        .map((topic) => [topic.id, topic]),
    );
    const primaryTopics = topicCandidates(candidates.primary);
    const backupTopics = topicCandidates(candidates.backup);
    const topicBackupTopics = topicCandidates(candidates.topicBackup);
    const recoveryTopicIds = [...physicalTopics]
      .filter((topicId) => !primaryTopics.has(topicId))
      .sort();
    const metadataTopicIds = recoveryTopicIds.filter(
      (topicId) =>
        !backupTopics.has(topicId) && !topicBackupTopics.has(topicId),
    );
    const recoveredTopics = recoverTopics && recoveryTopicIds.length > 0
      ? await recoverTopics({
          ownerType,
          ownerId,
          topicIds: recoveryTopicIds,
          metadataTopicIds,
        })
      : new Map();
    if (!(recoveredTopics instanceof Map)) {
      throw new Error("Topic recovery provider must return a Map");
    }

    const database = getDb();
    const isTombstoned = (topicId) => {
      if (recoveredTopics.get(topicId)?.deleted === true) return true;
      const indexed = database
        ? getTopicState({
            ownerType,
            ownerId,
            topicId,
          })
        : null;
      return indexed?.deleted_at != null;
    };
    const recoveredProjection = [];
    const existingProjection = [];
    const projectedIds = new Set();
    for (const topic of previousTopics) {
      const topicId = topic?.id;
      if (
        typeof topicId === "string" &&
        sanitizeId(topicId) === topicId &&
        physicalTopics.has(topicId) &&
        !isTombstoned(topicId) &&
        !projectedIds.has(topicId) &&
        topicId.length > 0
      ) {
        const historyPath = path.join(
          appDataPath,
          "UserData",
          ownerId,
          "topics",
          topicId,
          "history.json",
        );
        const normalizedTopic = await normalizeRecoveredTimestamp(
          topic,
          topicId,
          historyPath,
        );
        if (isSyntheticRecoveredTopic(normalizedTopic, topicId)) {
          recoveredProjection.push(normalizedTopic);
        } else {
          existingProjection.push(normalizedTopic);
        }
        projectedIds.add(topicId);
      }
    }

    let added = 0;
    for (const topicId of [...physicalTopics].sort()) {
      if (projectedIds.has(topicId) || isTombstoned(topicId)) continue;
      const historyPath = path.join(
        appDataPath,
        "UserData",
        ownerId,
        "topics",
        topicId,
        "history.json",
      );
      let topicData = backupTopics.get(topicId);
      if (!topicData) {
        const recoveredTopic = recoveredTopics.get(topicId);
        if (recoveredTopic?.deleted === false && recoveredTopic.topic) {
          const { ownerId: _ownerId, ...topic } = recoveredTopic.topic;
          topicData = topic;
        }
      }
      if (!topicData) topicData = topicBackupTopics.get(topicId);
      if (!topicData) {
        const fallback = {
          id: topicId,
          name: `Recovered: ${topicId}`,
          createdAt: await recoveryTimestamp(topicId, historyPath),
        };
        topicData = ownerType === "group"
          ? createGroupTopic(fallback)
          : createAgentTopic(fallback);
      }
      const normalizedTopic = await normalizeRecoveredTimestamp(
        { ...topicData, id: topicId },
        topicId,
        historyPath,
      );
      recoveredProjection.push(normalizedTopic);
      projectedIds.add(topicId);
      added += 1;
    }

    // 恢复项只做稳定分区并整体前置；原有 Topic 的人工顺序保持不变。
    const projectedTopics = [...recoveredProjection, ...existingProjection];
    const removed = previousTopics.length - (projectedTopics.length - added);
    const changed =
      configRecovered ||
      !Array.isArray(config.topics) ||
      JSON.stringify(previousTopics) !== JSON.stringify(projectedTopics);
    if (changed) {
      config.topics = projectedTopics;
      // 修复写入不能把已知可读的恢复副本替换成刚刚检测到的损坏投影。
      await writeJsonAtomic(configPath, config, { preserveBackup: true });
    }
    return { changed, added, removed };
  } finally {
    release();
  }
}

/**
 * 一次枚举得到启动 repair 与 legacy reconcile 共用的物理真源。
 */
async function scanPhysicalTopicTree(appDataPath) {
  if (typeof appDataPath !== "string" || appDataPath.length === 0) {
    throw new Error("scanPhysicalTopicTree requires appDataPath");
  }

  const owners = new Map();
  const ownersById = new Map();
  for (const [ownerType, rootName] of [
    ["agent", "Agents"],
    ["group", "AgentGroups"],
  ]) {
    for (const ownerId of await listDirectories(path.join(appDataPath, rootName))) {
      if (!ownerId || sanitizeId(ownerId) !== ownerId) continue;
      const owner = {
        ownerType,
        ownerId,
        physicalTopics: new Set(),
      };
      owners.set(`${ownerType}\0${ownerId}`, owner);
      ownersById.set(ownerId, owner);
    }
  }

  const userDataPath = path.join(appDataPath, "UserData");
  for (const ownerId of await listDirectories(userDataPath)) {
    if (!ownerId || sanitizeId(ownerId) !== ownerId) continue;
    const topicsPath = path.join(userDataPath, ownerId, "topics");
    const topicIds = (await listDirectories(topicsPath))
      .filter((topicId) => sanitizeId(topicId) === topicId);
    const owner = ownersById.get(ownerId);
    if (!owner) {
      if (topicIds.length > 0) {
        getLogger().logOperation(
          "reconcile",
          "repair_projection",
          ownerId,
          "error",
          "UserData owner has no Agents/AgentGroups directory; skipped",
        );
      }
      continue;
    }
    for (const topicId of topicIds) {
      owner.physicalTopics.add(topicId);
    }
  }
  return owners;
}

/**
 * 启动 reconcile 前把物理 Topic 投影回 config 元数据。当前配置、普通
 * backup、CDS 已提交值和 TopicSponsor backup 均只提供元数据；物理目录
 * 与已有墓碑共同决定 Topic 是否存活。
 */
async function repairTopicProjectionsFromDisk(
  appDataPath,
  physicalOwners = null,
  recoverTopics = null,
) {
  const owners = physicalOwners || await scanPhysicalTopicTree(appDataPath);

  const stats = { ownersChanged: 0, topicsAdded: 0, topicsRemoved: 0 };
  for (const ownerKey of [...owners.keys()].sort()) {
    const owner = owners.get(ownerKey);
    const result = await repairOwnerTopicProjection({
      appDataPath,
      ownerId: owner.ownerId,
      ownerType: owner.ownerType,
      physicalTopics: owner.physicalTopics,
      recoverTopics,
    });
    if (result.changed) stats.ownersChanged += 1;
    stats.topicsAdded += result.added;
    stats.topicsRemoved += result.removed;
  }

  if (stats.ownersChanged > 0) {
    getLogger().logOperation(
      "reconcile",
      "repair_projection",
      "disk",
      "success",
      `owners=${stats.ownersChanged} added=${stats.topicsAdded} removed=${stats.topicsRemoved}`,
    );
  }
  return stats;
}

/**
 * Legacy Owner 与 Topic 均以物理目录为存活事实；config 只提供 Topic 元数据。
 * 删除墓碑在同一事务中级联到消息，用于收敛删除中断窗口。
 */
async function reconcileMissingPhysicalIndexes(
  appDataPath,
  physicalOwners = null,
  database = getDb(),
  deletedAt = Date.now(),
) {
  if (!database) throw new Error("Database not initialized");
  const owners = physicalOwners || await scanPhysicalTopicTree(appDataPath);
  const liveOwners = new Set();
  const liveTopics = new Map();
  for (const owner of owners.values()) {
    const ownerKey = `${owner.ownerType}\0${owner.ownerId}`;
    liveOwners.add(ownerKey);
    for (const topicId of owner.physicalTopics) {
      liveTopics.set(`${ownerKey}\0${topicId}`, true);
    }
  }

  const ownerRows = database.prepare(
    `SELECT owner_type, owner_id, config_path, deleted_at FROM owners`,
  ).all();
  const topicRows = database.prepare(
    `SELECT owner_type, owner_id, topic_id, deleted_at FROM topics`,
  ).all();
  const staleOwners = ownerRows.filter(
    (row) => !liveOwners.has(`${row.owner_type}\0${row.owner_id}`),
  );
  const staleOwnerDeletedAt = new Map(
    staleOwners.map((row) => [
      `${row.owner_type}\0${row.owner_id}`,
      Number.isSafeInteger(row.deleted_at)
        ? Math.min(row.deleted_at, deletedAt)
        : deletedAt,
    ]),
  );

  const staleTopicRows = topicRows.filter((row) => {
    const ownerKey = `${row.owner_type}\0${row.owner_id}`;
    return (
      staleOwnerDeletedAt.has(ownerKey) ||
      !liveTopics.has(`${ownerKey}\0${row.topic_id}`)
    );
  });
  const affectedLiveOwners = new Map();
  for (const topic of staleTopicRows) {
    const ownerKey = `${topic.owner_type}\0${topic.owner_id}`;
    if (topic.deleted_at === null && !staleOwnerDeletedAt.has(ownerKey)) {
      affectedLiveOwners.set(ownerKey, {
        ownerType: topic.owner_type,
        ownerId: topic.owner_id,
      });
    }
  }

  const stats = { ownersDeleted: 0, topicsDeleted: 0, messagesDeleted: 0 };
  database.exec("BEGIN IMMEDIATE");
  try {
    const deleteOwner = database.prepare(
      `UPDATE owners
       SET content_hash = '', deleted_at = ?
       WHERE owner_type = ? AND owner_id = ?
         AND deleted_at IS NULL`,
    );
    const deleteTopic = database.prepare(
      `UPDATE topics
       SET deleted_at = ?
       WHERE owner_type = ? AND owner_id = ? AND topic_id = ?
         AND deleted_at IS NULL`,
    );
    const deleteMessages = database.prepare(
      `UPDATE messages
       SET deleted_at = ?
       WHERE owner_type = ? AND owner_id = ? AND topic_id = ?
         AND deleted_at IS NULL`,
    );
    const deleteHistorySource = database.prepare(
      `DELETE FROM history_source_state
       WHERE owner_type = ? AND owner_id = ? AND topic_id = ?`,
    );

    for (const owner of staleOwners) {
      const effectiveDeletedAt = staleOwnerDeletedAt.get(
        `${owner.owner_type}\0${owner.owner_id}`,
      );
      stats.ownersDeleted += deleteOwner.run(
        effectiveDeletedAt,
        owner.owner_type,
        owner.owner_id,
      ).changes;
    }
    for (const topic of staleTopicRows) {
      const ownerKey = `${topic.owner_type}\0${topic.owner_id}`;
      const effectiveDeletedAt = Math.min(
        Number.isSafeInteger(topic.deleted_at) ? topic.deleted_at : deletedAt,
        staleOwnerDeletedAt.get(ownerKey) ?? deletedAt,
      );
      stats.topicsDeleted += deleteTopic.run(
        effectiveDeletedAt,
        topic.owner_type,
        topic.owner_id,
        topic.topic_id,
      ).changes;
      stats.messagesDeleted += deleteMessages.run(
        effectiveDeletedAt,
        topic.owner_type,
        topic.owner_id,
        topic.topic_id,
      ).changes;
      deleteHistorySource.run(topic.owner_type, topic.owner_id, topic.topic_id);
    }
    for (const owner of affectedLiveOwners.values()) {
      refreshOwnerContentHash(owner, database);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  for (const owner of staleOwners) {
    softDeleteAvatarIndex(
      owner.owner_id,
      owner.owner_type,
      staleOwnerDeletedAt.get(`${owner.owner_type}\0${owner.owner_id}`),
    );
  }

  const {
    clearHistoryOwnerUnhealthy,
    clearHistoryTopicUnhealthy,
  } = require("./message");
  for (const owner of staleOwners) {
    clearHistoryOwnerUnhealthy(owner.owner_type, owner.owner_id);
  }
  for (const topic of staleTopicRows) {
    clearHistoryTopicUnhealthy({
      topicId: topic.topic_id,
      ownerType: topic.owner_type,
      ownerId: topic.owner_id,
    });
  }

  return stats;
}

/**
 * 下载头像
 * @param {string} id - 所有者 ID
 * @param {string} type - 所有者类型 (agent/group)
 * @returns {Promise<{data: Buffer,mimeType: string}|null>}
 */
async function downloadAvatar(id, type, centralSync = null) {
  const logger = getLogger();

  const safeId = sanitizeId(id);
  if (
    !safeId ||
    safeId !== id ||
    !["agent", "group", "user"].includes(type) ||
    (type === "user" && safeId !== "user_avatar")
  ) {
    throw new Error("Invalid avatar owner identity");
  }
  const row = centralSync
    ? await centralSync.loadAvatarState(type, safeId)
    : getAvatarIndex(safeId, type);
  const filePath = row?.filePath || row?.file_path;
  const deletedAt = row?.deletedAt ?? row?.deleted_at;
  if (!row || deletedAt != null || !filePath) {
    logger.logOperation("owner_metadata", "download_avatar", id, "error", `type=${type} not found`);
    return null;
  }
  const stats = await fs.stat(filePath);
  if (!stats.isFile() || stats.size > MAX_AVATAR_BYTES) {
    throw new Error("Avatar index does not point to a supported file");
  }
  const data = await fs.readFile(filePath);
  if (computeBinaryHash(data) !== row.hash) {
    throw Object.assign(
      new Error("Avatar changed after its manifest was indexed"),
      { code: "SYNC_SNAPSHOT_STALE" },
    );
  }
  const mimeType = detectAvatarMime(data);

  logger.logOperation("owner_metadata", "download_avatar", id, "success", `type=${type}`);
  return { data, mimeType };
}

/**
 * 上传头像
 * @param {object} params
 * @param {string} params.id - 所有者 ID
 * @param {string} params.type - 所有者类型 (agent/group)
 * @param {Buffer} params.data - 头像二进制数据
 * @param {string} params.appDataPath - AppData 路径
 * @param {string} params.mimeType - HTTP Content-Type
 */
async function uploadAvatar({
  id,
  type,
  data,
  appDataPath,
  mimeType: rawMimeType,
  centralSync = null,
}) {
  const logger = getLogger();
  const safeId = sanitizeId(id);
  if (
    !safeId ||
    safeId !== id ||
    !["agent", "group", "user"].includes(type) ||
    !Buffer.isBuffer(data) ||
    data.length > MAX_AVATAR_BYTES ||
    (type === "user" && safeId !== "user_avatar")
  ) {
    throw new Error("Avatar upload has an invalid owner or exceeds 20 MiB");
  }
  const { extension, mimeMismatch } = resolveAvatarMime(rawMimeType, data);
  if (mimeMismatch) {
    logger.logOperation(
      "owner_metadata",
      "upload_avatar_mime",
      safeId,
      "warn",
      "Content-Type disagreed with avatar bytes; physical format was used",
    );
  }
  const isGroup = type === "group";
  const isUser = type === "user";
  if (!isUser && !centralSync) {
    const parent = getOwnerState({ ownerType: type, ownerId: safeId });
    if (!parent || parent.deleted_at != null) {
      throw new Error(`Avatar owner ${type}/${safeId} is missing or deleted`);
    }
  }
  if (!centralSync && getAvatarIndex(safeId, type)?.deleted_at != null) {
    throw new Error(`Avatar ${type}/${safeId} is deleted`);
  }
  const baseDirName = isGroup ? "AgentGroups" : "Agents";
  const entityDir = isUser
    ? path.join(appDataPath, "UserData")
    : path.join(appDataPath, baseDirName, safeId);

  const avatarFileName = isUser ? "user_avatar.png" : `avatar${extension}`;
  const avatarPath = path.join(entityDir, avatarFileName);

  // 确保目录存在
  await fs.mkdir(entityDir, { recursive: true });

  const temporary = path.join(
    entityDir,
    `.${avatarFileName}.${crypto.randomUUID()}.tmp`,
  );
  const file = await fs.open(temporary, "wx");
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }

  // Group 的 config.avatar 是业务投影：新二进制尚未发布时先提交投影，
  // 避免新文件已可见但 config 仍指向旧格式。
  if (isGroup) {
    const configPath = path.join(entityDir, "config.json");
    const writeIntentKey = addWriteIntent({
      id: safeId,
      type: "group",
      ownerType: "group",
      ownerId: safeId,
    });
    const release = await acquireLock(configPath);
    try {
      const content = await fs.readFile(configPath, "utf-8");
      const config = JSON.parse(content);
      config.avatar = avatarFileName;

      const tmpPath = `${configPath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
      await fs.rename(tmpPath, configPath);

      if (!centralSync) {
        // Legacy 的 Owner 提交视图与同一物理配置同步更新。
        const groupHash = computeDtoHash(extractGroupDTO(config), GROUP_SYNC_FIELDS);
        upsertOwnerState({
          ownerType: "group",
          ownerId: safeId,
          configPath,
          configHash: groupHash,
        });
      }
    } catch (e) {
      logger.logOperation("owner_metadata", "upload_avatar", safeId, "error", `update group config failed: ${e.message}`);
      await fs.unlink(temporary).catch(() => {});
      throw e;
    } finally {
      release();
      releaseWriteIntent(writeIntentKey);
    }
  }

  try {
    await fs.rename(temporary, avatarPath);
    if (process.platform !== "win32") {
      const parent = await fs.open(entityDir, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }

  // 旧格式清理仍属于本次文件提交；索引只在物理视图完整后发布新 Hash。
  if (!isUser) {
    for (const oldExtension of AVATAR_EXTENSIONS) {
      const oldPath = path.join(entityDir, `avatar${oldExtension}`);
      if (oldPath !== avatarPath) {
        try {
          await fs.unlink(oldPath);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          await fs.unlink(avatarPath).catch(() => {});
          throw error;
        }
      }
    }
  }

  const hash = computeBinaryHash(data);
  try {
    if (centralSync) {
      await centralSync.commitAvatar(type, safeId, hash);
    } else {
      const indexed = upsertAvatarIndex(safeId, type, avatarPath, hash);
      if (indexed?.changes !== 1) {
        throw new Error(`Avatar ${type}/${safeId} is deleted`);
      }
    }
  } catch (error) {
    await fs.unlink(avatarPath).catch(() => {});
    throw error;
  }

  logger.logOperation("owner_metadata", "upload_avatar", safeId, "success", `type=${type}`);
  return { success: true, id: safeId };
}

/**
 * 检查写入意图锁
 * @param {object} identity - 完整 Owner 或 Topic 身份
 * @returns {boolean}
 */
function isWriteLocked(identity) {
  return writeIntentLock.has(entityIdentityKey(identity));
}

/**
 * 删除实体 - 软删除索引并删除物理文件
 * @param {object} params
 * @param {string} params.id - 实体 ID
 * @param {string} params.type - 实体类型 (agent/group/agent_topic/group_topic/avatar)
 * @param {number} params.deletedAt - 删除时间戳
 * @param {string} params.appDataPath - AppData 路径
 * @returns {Promise<{success: boolean, error?: object}>}
 */
async function deleteEntity({
  id,
  type,
  ownerType = null,
  ownerId = null,
  deletedAt,
  appDataPath,
  persistAvatarIndex = true,
}) {
  const db = getDb();
  const logger = getLogger();
  if (!db) {
    return entityFailure("Database not initialized", {
      code: "SYNC_DB_UNAVAILABLE",
      stage: entityStage(type),
    }, entityResultIdentity({ id, type, ownerType, ownerId }));
  }

  const safeId = sanitizeId(id);
  const allowedTypes = new Set([
    "agent",
    "group",
    "topic",
    "agent_topic",
    "group_topic",
    "avatar",
  ]);
  const isTopic = type === "agent_topic" || type === "group_topic" || type === "topic";
  const safeOwnerId = typeof ownerId === "string" ? sanitizeId(ownerId) : "";
  const invalidTopicOwner =
    isTopic &&
    (
      !["agent", "group"].includes(ownerType) ||
      !safeOwnerId ||
      safeOwnerId !== ownerId ||
      (type === "agent_topic" && ownerType !== "agent") ||
      (type === "group_topic" && ownerType !== "group")
    );
  if (
    !safeId ||
    safeId !== id ||
    !allowedTypes.has(type) ||
    !Number.isSafeInteger(deletedAt) ||
    deletedAt < 0 ||
    invalidTopicOwner ||
    (type === "avatar" && !["agent", "group", "user"].includes(ownerType)) ||
    (type === "avatar" && ownerType === "user" && safeId !== "user_avatar")
  ) {
    return entityFailure("Invalid entity deletion payload", {
      code: "SYNC_DELETE_INVALID",
      stage: entityStage(type),
    }, entityResultIdentity({ id, type, ownerType, ownerId }));
  }
  const actualPhase = isTopic ? "topic_metadata" : "owner_metadata";

  const writeIntentKey = isTopic
    ? addWriteIntent({
        id: safeId,
        type,
        ownerType,
        ownerId: safeOwnerId,
      })
    : null;

  let row = null;
  try {
    if (type !== "avatar") {
      row = getEntityState(safeId, type, ownerType, safeOwnerId);
    }
    if (type === "avatar") {
      if (!["agent", "group", "user"].includes(ownerType)) {
        throw new Error("Avatar deletion requires a valid ownerType");
      }
      const indexedAvatar = persistAvatarIndex
        ? getAvatarIndex(safeId, ownerType)
        : null;
      const avatarPaths = ownerType === "user"
        ? [path.join(appDataPath, "UserData", "user_avatar.png")]
        : AVATAR_EXTENSIONS.map((extension) =>
            path.join(
              appDataPath,
              ownerType === "group" ? "AgentGroups" : "Agents",
              safeId,
              `avatar${extension}`,
            )
          );
      for (const avatarPath of avatarPaths) {
        await fs.unlink(avatarPath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      if (persistAvatarIndex) {
        softDeleteAvatarIndex(
          safeId,
          ownerType,
          deletedAt,
          indexedAvatar?.file_path || avatarPaths[0],
        );
      }
      logger.logOperation(
        actualPhase,
        "delete",
        safeId,
        "success",
        "type=avatar, physical file removed and tombstoned",
      );
      return { success: true, id: safeId };
    }

    if (isTopic) {
      const configPath = path.join(
        appDataPath,
        ownerType === "group" ? "AgentGroups" : "Agents",
        safeOwnerId,
        "config.json",
      );
      if (
        row?.config_path &&
        path.resolve(row.config_path) !== path.resolve(configPath)
      ) {
        throw new Error(`Topic ${safeId} owner identity conflicts with its index`);
      }

      const topicDir = path.join(
        appDataPath,
        "UserData",
        safeOwnerId,
        "topics",
        safeId,
      );
      const ownerDir = path.join(
        appDataPath,
        ownerType === "group" ? "AgentGroups" : "Agents",
        safeOwnerId,
      );
      const targetOwnerLive = await isDirectory(ownerDir);
      const topicDirExists = await isDirectory(topicDir);
      const removePhysicalTopic = topicDirExists;
      if (removePhysicalTopic) {
        await fs.rm(topicDir, { recursive: true, force: true });
      }
      upsertTopicTombstone({
        ownerType,
        ownerId: safeOwnerId,
        topicId: safeId,
        deletedAt,
      });
      db.prepare(
        `UPDATE messages
         SET deleted_at = CASE
           WHEN deleted_at IS NULL THEN ? ELSE MIN(deleted_at, ?) END
         WHERE owner_type = ? AND owner_id = ? AND topic_id = ?`,
      ).run(deletedAt, deletedAt, ownerType, safeOwnerId, safeId);
      const { clearHistoryTopicUnhealthy } = require("./message");
      clearHistoryTopicUnhealthy({
        topicId: safeId,
        ownerType,
        ownerId: safeOwnerId,
      });

      // config.topics 是被动投影；损坏或暂时不可写都不能反向阻塞物理删除。
      if (targetOwnerLive) {
        try {
          const releaseProjection = await acquireLock(configPath);
          try {
            const candidates = await readConfigForRepair(configPath, ownerType);
            const config =
              candidates.primary || candidates.backup || candidates.topicBackup;
            const recoveredFromFallback = !candidates.primary && Boolean(config);
            if (config) {
              const previousTopics = Array.isArray(config.topics)
                ? config.topics
                : [];
              const topics = previousTopics.filter((topic) => topic?.id !== safeId);
              if (
                recoveredFromFallback ||
                !Array.isArray(config.topics) ||
                topics.length !== previousTopics.length
              ) {
                config.topics = topics;
                await writeJsonAtomic(configPath, config, {
                  preserveBackup: recoveredFromFallback,
                });
              }
            }
          } finally {
            releaseProjection();
          }
        } catch (error) {
          logger.logOperation(
            actualPhase,
            "delete_projection",
            safeId,
            "error",
            error.message,
          );
        }
      }
      logger.logOperation(
        actualPhase,
        "delete",
        safeId,
        "success",
        `type=${type}, physicalTopicRemoved=${removePhysicalTopic}`,
      );
      return {
        success: true,
        id: safeId,
        ownerType,
        ownerId: safeOwnerId,
      };
    }

    const entityDir = row?.config_path
      ? path.dirname(row.config_path)
      : path.join(
          appDataPath,
          type === "group" ? "AgentGroups" : "Agents",
          safeId,
        );
    const userDataDir = path.join(appDataPath, "UserData", safeId);

    // Owner 目录先形成删除事实；遗留 UserData 即使清理中断也不会被猜测成 Agent。
    await fs.rm(entityDir, { recursive: true, force: true });
    const configPath = row?.config_path || path.join(entityDir, "config.json");
    upsertOwnerTombstone({
      ownerType: type,
      ownerId: safeId,
      configPath,
      deletedAt,
    });
    if (persistAvatarIndex) {
      softDeleteAvatarIndex(safeId, type, deletedAt);
    }
    db.prepare(
      `UPDATE messages
       SET deleted_at = CASE
         WHEN deleted_at IS NULL THEN ? ELSE MIN(deleted_at, ?) END
       WHERE owner_type = ? AND owner_id = ?`,
    ).run(deletedAt, deletedAt, type, safeId);
    db.prepare(
      `DELETE FROM history_source_state
       WHERE owner_type = ? AND owner_id = ?`,
    ).run(type, safeId);
    db.prepare(
      `UPDATE topics
       SET deleted_at = CASE
         WHEN deleted_at IS NULL THEN ? ELSE MIN(deleted_at, ?) END
       WHERE owner_type = ? AND owner_id = ?`,
    ).run(deletedAt, deletedAt, type, safeId);
    const removePhysicalHistory = await isDirectory(userDataDir);
    if (removePhysicalHistory) {
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
    const { clearHistoryOwnerUnhealthy } = require("./message");
    clearHistoryOwnerUnhealthy(type, safeId);
    logger.logOperation(
      actualPhase,
      "delete",
      safeId,
      "success",
      `type=${type}, physicalHistoryRemoved=${removePhysicalHistory}`,
    );

    return { success: true, id: safeId };
  } catch (e) {
    logger.logOperation(actualPhase, "delete", safeId, "error", e.message);
    return entityFailure(e, {
      code: "SYNC_DELETE_FAILED",
      stage: actualPhase,
      failedTopicIds: isTopic ? [safeId] : [],
    }, entityResultIdentity({
      id: safeId,
      type,
      ...(isTopic ? { ownerType, ownerId: safeOwnerId } : {}),
    }));
  } finally {
    if (writeIntentKey) releaseWriteIntent(writeIntentKey);
  }
}

/**
 * 删除消息 - 软删除消息索引
 * @param {object} params
 * @param {string} params.msgId - 消息 ID
 * @param {number} params.deletedAt - 删除时间戳
 * @param {string} [params.topicId] - 话题 ID
 * @returns {Promise<{success: boolean, error?: object}>}
 */
async function deleteMessage({
  msgId,
  deletedAt,
  topicId,
  ownerType,
  ownerId,
  appDataPath,
}) {
  const db = getDb();
  const logger = getLogger();
  if (!db) {
    return entityFailure("Database not initialized", {
      code: "SYNC_DB_UNAVAILABLE",
      stage: "messages",
      failedTopicIds: typeof topicId === "string" ? [topicId] : [],
    });
  }

  const safeMsgId = sanitizeId(msgId);
  const safeTopicId = topicId ? sanitizeId(topicId) : null;

  try {
    if (
      !safeMsgId ||
      safeMsgId !== msgId ||
      !safeTopicId ||
      safeTopicId !== topicId ||
      !["agent", "group"].includes(ownerType) ||
      typeof ownerId !== "string" ||
      sanitizeId(ownerId) !== ownerId ||
      !Number.isSafeInteger(deletedAt) ||
      deletedAt < 0
    ) {
      throw new Error("Invalid message deletion payload");
    }
    const topic = getTopicState({
      ownerType,
      ownerId,
      topicId: safeTopicId,
    });
    if (!topic || topic.deleted_at != null) {
      throw new Error(`Message topic ${ownerType}/${ownerId}/${safeTopicId} is missing`);
    }
    const { assertHistoryTopicHealthy } = require("./message");
    assertHistoryTopicHealthy({
      topicId: safeTopicId,
      ownerType,
      ownerId,
    });
    if (safeTopicId && appDataPath) {
      const { pruneMessageFromPhysicalHistory } = require("./message");
      await pruneMessageFromPhysicalHistory(
        safeTopicId,
        safeMsgId,
        ownerType,
        ownerId,
        deletedAt,
        appDataPath,
      );
    }
    logger.logOperation("messages", "delete", safeMsgId, "success", `soft deleted in topic ${safeTopicId || 'all'}`);
    return {
      success: true,
      topicId: safeTopicId,
      ownerType,
      ownerId,
      msgId: safeMsgId,
    };
  } catch (e) {
    logger.logOperation("messages", "delete", safeMsgId, "error", e.message);
    return entityFailure(e, {
      code: "SYNC_DELETE_FAILED",
      stage: "messages",
      failedTopicIds: safeTopicId ? [safeTopicId] : [],
    });
  }
}

/**
 * ID 清理
 */
function sanitizeId(id) {
  if (typeof id !== "string") return "";
  return id.replace(/[^a-zA-Z0-9_\-]/g, "");
}

module.exports = {
  downloadEntities,
  uploadEntity,
  uploadEntitiesBatch,
  downloadAvatar,
  uploadAvatar,
  isWriteLocked,
  scanPhysicalTopicTree,
  repairTopicProjectionsFromDisk,
  reconcileMissingPhysicalIndexes,
  sanitizeId,
  addWriteIntent,
  releaseWriteIntent,
  deleteEntity,
  deleteMessage,
};
