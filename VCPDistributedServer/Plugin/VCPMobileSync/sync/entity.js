/**
 * 实体上传下载核心逻辑
 */

const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const {
  getDb,
  getEntityIndex,
  upsertEntityIndex,
  upsertAttachmentIndex,
  upsertAvatarIndex,
  upsertEntityTombstone,
  softDeleteMessageIndex,
  softDeleteAvatarIndex,
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
const { getLogger } = require("../core/logger");
const {
  createSyncError,
  normalizeSyncError,
  withSyncErrorContext,
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
  applyTopicDTO,
  extractAgentTopicDTO,
  extractGroupTopicDTO,
  applyAgentTopicDTO,
  applyGroupTopicDTO,
  AGENT_TOPIC_SYNC_FIELDS,
  GROUP_TOPIC_SYNC_FIELDS,
} = require("../dto/topic.dto");

const writeIntentLock = new Set();

function entityStage(type) {
  return ["topic", "agent_topic", "group_topic"].includes(type)
    ? "topic_metadata"
    : "owner_metadata";
}

function entityFailure(error, fallback, fields = {}) {
  return {
    success: false,
    ...fields,
    error: normalizeSyncError(error, fallback),
  };
}

/**
 * 下载实体 - 从桌面端配置提取 DTO
 * @param {object} params
 * @param {string} params.id - 实体 ID
 * @param {string} params.type - 实体类型 (agent/group/topic/avatar)
 * @returns {Promise<object|null>} DTO
 */
async function downloadEntity({ id, type }) {
  const db = getDb();
  const logger = getLogger();
  if (!db) {
    throw createSyncError("SYNC_DB_UNAVAILABLE", "Database not initialized", {
      stage: entityStage(type),
    });
  }

  const safeId = sanitizeId(id);
  if (
    !safeId ||
    safeId !== id ||
    !["agent", "group", "topic", "agent_topic", "group_topic"].includes(type)
  ) {
    throw createSyncError("SYNC_REQUEST_INVALID", "Invalid entity identity", {
      stage: entityStage(type),
    });
  }
  const phase = (type === "topic" || type === "agent_topic" || type === "group_topic") ? "topic_metadata" : "owner_metadata";

  const row = getEntityIndex(safeId, type);

  if (!row) {
    logger.logOperation(phase, "download", safeId, "error", `${type} not found in index`);
    return null;
  }

  try {
    const content = await fs.readFile(row.file_path, "utf-8");
    const config = JSON.parse(content);
    const isGroup = row.file_path.includes("AgentGroups");
    const ownerId = config.id || path.basename(path.dirname(row.file_path));
    const ownerType = isGroup ? "group" : "agent";

    if (type === "topic" || type === "agent_topic" || type === "group_topic") {
      const topic = (config.topics || []).find((t) => t.id === safeId);
      if (!topic) return null;

      if (isGroup) {
        return extractGroupTopicDTO(topic, ownerId);
      } else {
        return extractAgentTopicDTO(topic, ownerId);
      }
    } else if (type === "agent") {
      logger.logOperation(phase, "download", safeId, "success", `type=${type}`);
      return extractAgentDTO(config);
    } else if (type === "group") {
      logger.logOperation(phase, "download", safeId, "success", `type=${type}`);
      return extractGroupDTO(config);
    }
  } catch (e) {
    logger.logOperation(phase, "download", safeId, "error", e.message);
    throw withSyncErrorContext(e, {
      code: "SYNC_ENTITY_READ_FAILED",
      stage: phase,
      failedTopicIds: entityStage(type) === "topic_metadata" ? [safeId] : [],
    });
  }
}

/**
 * 批量下载实体
 * @param {object[]} requests - 请求列表 [{id, type}]
 * @returns {Promise<object[]>} DTO 列表
 */
async function downloadEntities(requests) {
  if (!Array.isArray(requests)) return [];

  // 按 file_path 分组，每个 config.json 只读取一次
  const fileGroups = new Map();
  const results = [];
  const seen = new Set();
  for (const req of requests) {
    const safeId = sanitizeId(req.id);
    const key = `${req.type || ""}:${safeId}`;
    const validType = [
      "agent",
      "group",
      "topic",
      "agent_topic",
      "group_topic",
    ].includes(req.type);
    if (
      !safeId ||
      safeId !== req.id ||
      !validType ||
      seen.has(key)
    ) {
      results.push(entityFailure(
        seen.has(key) ? "duplicate entity request" : "invalid entity identity",
        { code: "SYNC_REQUEST_INVALID", stage: entityStage(req.type) },
        { id: req.id, type: req.type },
      ));
      continue;
    }
    seen.add(key);
    const row = getEntityIndex(safeId, req.type);
    if (!row) {
      results.push(entityFailure("entity not found", {
        code: "SYNC_ENTITY_NOT_FOUND",
        stage: entityStage(req.type),
        failedTopicIds:
          entityStage(req.type) === "topic_metadata" ? [safeId] : [],
      }, { id: req.id, type: req.type }));
      continue;
    }

    if (!fileGroups.has(row.file_path)) {
      fileGroups.set(row.file_path, {
        isGroup: row.file_path.includes("AgentGroups"),
        reqs: [],
      });
    }
    fileGroups.get(row.file_path).reqs.push({ req, safeId });
  }

  const logger = getLogger();

  for (const [filePath, { isGroup, reqs }] of fileGroups) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const config = JSON.parse(content);
      const ownerId = config.id || path.basename(path.dirname(filePath));

      for (const { req, safeId } of reqs) {
        let dto = null;
        const type = req.type;
        const phase = (type === "topic" || type === "agent_topic" || type === "group_topic") ? "topic_metadata" : "owner_metadata";

        if (type === "topic" || type === "agent_topic" || type === "group_topic") {
          const topic = (config.topics || []).find((t) => t.id === safeId);
          if (topic) {
            dto = isGroup
              ? extractGroupTopicDTO(topic, ownerId)
              : extractAgentTopicDTO(topic, ownerId);
          }
        } else if (type === "agent") {
          logger.logOperation(phase, "download", safeId, "success", `type=${type}`);
          dto = extractAgentDTO(config);
        } else if (type === "group") {
          logger.logOperation(phase, "download", safeId, "success", `type=${type}`);
          dto = extractGroupDTO(config);
        }

        if (dto) {
          results.push({ id: req.id, type, success: true, data: dto });
        } else {
          results.push(entityFailure(
            "entity data was not found in its config",
            {
              code: "SYNC_ENTITY_NOT_FOUND",
              stage: entityStage(type),
              failedTopicIds:
                entityStage(type) === "topic_metadata" ? [safeId] : [],
            },
            { id: req.id, type },
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
        }, { id: req.id, type: req.type }));
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
  const fileGroups = new Map(); // Map<configPath, { isTopic, items: [] }>
  const addedIntentLocks = new Set();
  const seenIds = new Set();

  for (const item of items) {
    const { id, type, data } = item;
    const safeId = sanitizeId(id);
    if (
      !safeId ||
      safeId !== id ||
      seenIds.has(safeId) ||
      !["agent_topic", "group_topic"].includes(type) ||
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      typeof data.ownerId !== "string" ||
      sanitizeId(data.ownerId) !== data.ownerId
    ) {
      results.push(entityFailure(
        seenIds.has(safeId)
          ? "Duplicate entity id"
          : "Batch upload only accepts valid agent_topic/group_topic items",
        {
          code: "SYNC_REQUEST_INVALID",
          stage: "topic_metadata",
          failedTopicIds: safeId ? [safeId] : [],
        },
        { id },
      ));
      continue;
    }
    seenIds.add(safeId);
    if (safeId) {
      writeIntentLock.add(safeId);
      addedIntentLocks.add(safeId);
    }
    const isTopic = true;

    let configPath;
    let row = getEntityIndex(safeId, type);

    if (row) {
      configPath = row.file_path;
    } else if (isTopic && data.ownerId) {
      const parentBaseDir = (type === "group_topic" || data.ownerType === "group") ? "AgentGroups" : "Agents";
      configPath = path.join(appDataPath, parentBaseDir, data.ownerId, "config.json");
    }

    if (!configPath) {
      results.push(entityFailure("Cannot resolve config path", {
        code: "SYNC_ENTITY_NOT_FOUND",
        stage: "topic_metadata",
        failedTopicIds: [safeId],
      }, { id }));
      continue;
    }
    const actualOwnerId = path.basename(path.dirname(configPath));
    const actualIsGroup = configPath.includes(`${path.sep}AgentGroups${path.sep}`);
    if (
      actualOwnerId !== data.ownerId ||
      actualIsGroup !== (type === "group_topic")
    ) {
      results.push(entityFailure("Topic owner identity conflict", {
        code: "SYNC_OWNER_CONFLICT",
        stage: "topic_metadata",
        failedTopicIds: [safeId],
      }, { id }));
      continue;
    }

    if (!fileGroups.has(configPath)) {
      fileGroups.set(configPath, { items: [] });
    }
    fileGroups.get(configPath).items.push({ id: safeId, type, data });
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
          const isTopic = type === "topic" || type === "agent_topic" || type === "group_topic";

          try {
            if (isTopic) {
              config = await handleTopicUpload({
                config,
                id,
                entityType: type,
                data,
                configPath,
                appDataPath,
              });
            }

            results.push({ id, success: true });
            successfulIds.add(id);
          } catch (e) {
            results.push(entityFailure(e, {
              code: "SYNC_ENTITY_WRITE_FAILED",
              stage: "topic_metadata",
              failedTopicIds: [id],
            }, { id }));
          }
        }

        if (successfulIds.size === 0) continue;

        // 原子写入
        const tmpPath = `${configPath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
        await fs.rename(tmpPath, configPath);

        // 批量更新索引
        for (const item of group.items.filter((item) => successfulIds.has(item.id))) {
          const { id, type } = item;
          const isTopic = type === "topic" || type === "agent_topic" || type === "group_topic";
          if (isTopic) {
            updateTopicIndex(db, id, configPath, config, type);
          } else {
            const dto = type === "agent" ? extractAgentDTO(config) : extractGroupDTO(config);
            const hash = computeDtoHash(dto, type === "agent" ? AGENT_SYNC_FIELDS : GROUP_SYNC_FIELDS);
            upsertEntityIndex(id, type, configPath, hash);
          }
        }
      } catch (e) {
        // 文件级错误，标记该组所有 item 为失败。
        // 缺口 D：父 config 不存在（ENOENT）时与单条路径（entity.js:497-510）
        // 对齐为 SYNC_ENTITY_NOT_FOUND——手机端可据此区分"先补建父 Agent"与
        // 真正的写入失败；其余错误保持 SYNC_ENTITY_BATCH_FAILED。
        const isMissingParent = e && e.code === "ENOENT";
        logger.logOperation("topic_metadata", "batch_upload", configPath, "error", e.message);
        const groupIds = new Set(group.items.map((item) => item.id));
        for (let index = results.length - 1; index >= 0; index -= 1) {
          if (groupIds.has(results[index].id)) results.splice(index, 1);
        }
        for (const item of group.items) {
          results.push(entityFailure(e, {
            code: isMissingParent ? "SYNC_ENTITY_NOT_FOUND" : "SYNC_ENTITY_BATCH_FAILED",
            stage: "topic_metadata",
            failedTopicIds: [item.id],
          }, { id: item.id }));
        }
      } finally {
        release();
      }
    }
  } finally {
    setTimeout(() => {
      for (const id of addedIntentLocks) {
        writeIntentLock.delete(id);
      }
    }, 1000);
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
async function uploadEntity({ id, type, data, appDataPath }) {
  const db = getDb();
  const logger = getLogger();
  if (!db) {
    return entityFailure("Database not initialized", {
      code: "SYNC_DB_UNAVAILABLE",
      stage: entityStage(type),
    });
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
    }, { id });
  }
  const isTopic =
    type === "topic" || type === "agent_topic" || type === "group_topic";
  const isGroup = type === "group";
  const baseDirName = isGroup ? "AgentGroups" : "Agents";
  const phase = isTopic ? "topic_metadata" : "owner_metadata";

  // 1. 查找现有配置文件路径
  let row = getEntityIndex(safeId, type);
  let configPath;
  let isNewEntity = false;

  if (!row && !isTopic) {
    // 新建 Agent/Group
    const newEntityDir = path.join(appDataPath, baseDirName, safeId);
    configPath = path.join(newEntityDir, "config.json");
    await fs.mkdir(newEntityDir, { recursive: true });
    isNewEntity = true;
  } else if (row) {
    configPath = row.file_path;
  } else if (isTopic && data.ownerId) {
    // 新建 Topic: 根据归属信息反推父级路径
    const parentBaseDir =
      type === "group_topic" || data.ownerType === "group"
        ? "AgentGroups"
        : "Agents";
    configPath = path.join(
      appDataPath,
      parentBaseDir,
      data.ownerId,
      "config.json",
    );
    try {
      await fs.access(configPath);
    } catch {
      logger.logOperation(phase, "upload", safeId, "error", `parent entity ${data.ownerId} not found`);
      return entityFailure(
        `Parent entity ${data.ownerId} not found on desktop`,
        {
          code: "SYNC_ENTITY_NOT_FOUND",
          stage: "topic_metadata",
          failedTopicIds: [safeId],
        },
        { id: safeId },
      );
    }
  } else {
    logger.logOperation(phase, "upload", safeId, "error", "topic parent entity metadata missing");
    return entityFailure("Topic parent entity metadata missing", {
      code: "SYNC_REQUEST_INVALID",
      stage: "topic_metadata",
      failedTopicIds: [safeId],
    }, { id: safeId });
  }

  if (isTopic) {
    const actualOwnerId = path.basename(path.dirname(configPath));
    const actualIsGroup = configPath.includes(`${path.sep}AgentGroups${path.sep}`);
    if (
      typeof data.ownerId !== "string" ||
      sanitizeId(data.ownerId) !== data.ownerId ||
      data.ownerId !== actualOwnerId ||
      actualIsGroup !== (type === "group_topic")
    ) {
      return entityFailure("Topic owner identity conflict", {
        code: "SYNC_OWNER_CONFLICT",
        stage: "topic_metadata",
        failedTopicIds: [safeId],
      }, { id: safeId });
    }
  }

  writeIntentLock.add(safeId);

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
      updateTopicIndex(db, safeId, configPath, config, type);
    } else {
      const dto = type === "agent" ? extractAgentDTO(config) : extractGroupDTO(config);
      const hash = computeDtoHash(
        dto,
        type === "agent" ? AGENT_SYNC_FIELDS : GROUP_SYNC_FIELDS,
      );
      upsertEntityIndex(safeId, type, configPath, hash);
    }

    logger.logOperation(phase, "upload", safeId, "success", `type=${type}, isNewEntity=${isNewEntity}, fileReadSuccess=${fileReadSuccess}`);
    return { success: true, id: safeId };
  } catch (e) {
    logger.logOperation(phase, "upload", safeId, "error", e.message);
    return entityFailure(e, {
      code: "SYNC_ENTITY_WRITE_FAILED",
      stage: phase,
      failedTopicIds: isTopic ? [safeId] : [],
    }, { id: safeId });
  } finally {
    release();
    setTimeout(() => writeIntentLock.delete(safeId), 1000);
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
function updateTopicIndex(db, id, configPath, config, entityType) {
  const isGroupTopic = entityType === "group_topic";
  const topicObj = (config.topics || []).find((t) => t.id === id);

  if (topicObj) {
    // V2: 使用 DTO 提取以对齐默认值处理
    const parentId = path.basename(path.dirname(configPath));
    const ownerType = isGroupTopic ? "group" : "agent";
    const topicDto = extractTopicDTO(topicObj, parentId, ownerType);
    
    const hash = computeDtoHash(
      topicDto,
      isGroupTopic ? GROUP_TOPIC_SYNC_FIELDS : AGENT_TOPIC_SYNC_FIELDS,
    );
    upsertEntityIndex(id, "topic", configPath, hash);
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

async function readConfigForRepair(configPath) {
  try {
    return {
      config: parseJsonObject(await fs.readFile(configPath, "utf-8"), configPath),
      source: "primary",
    };
  } catch {}

  const backupPath = `${configPath}.backup`;
  try {
    return {
      config: parseJsonObject(await fs.readFile(backupPath, "utf-8"), backupPath),
      source: "backup",
    };
  } catch {
    return {
      config: null,
      source: null,
    };
  }
}

async function writeJsonAtomic(filePath, value) {
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
      await fs.writeFile(backupTemporary, expectedCurrent, "utf-8");
      await fs.rename(backupTemporary, backupPath);
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
      throw new Error(`Config changed while updating ${filePath}`);
    }
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    await fs.unlink(backupTemporary).catch(() => {});
    throw error;
  }
}

function recoveryTimestamp(history) {
  return history.reduce((oldest, message) => {
    const timestamp = message?.timestamp;
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) return oldest;
    return oldest === null || timestamp < oldest ? timestamp : oldest;
  }, null) ?? Date.now();
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

async function readRecoveryHistory(historyPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(historyPath, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function repairOwnerTopicProjection({
  appDataPath,
  ownerId,
  ownerType,
  physicalTopics,
}) {
  const ownerRoot = ownerType === "group" ? "AgentGroups" : "Agents";
  const configPath = path.join(appDataPath, ownerRoot, ownerId, "config.json");
  const release = await acquireLock(configPath);
  try {
    const recovered = await readConfigForRepair(configPath);
    let config = recovered.config;
    let configRecovered = false;
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
    const projectedTopics = [];
    const projectedIds = new Set();
    for (const topic of previousTopics) {
      const topicId = topic?.id;
      if (
        typeof topicId === "string" &&
        !projectedIds.has(topicId) &&
        (topicId === "default" || physicalTopics.has(topicId))
      ) {
        projectedTopics.push(topic);
        projectedIds.add(topicId);
      }
    }

    let added = 0;
    for (const topicId of [...physicalTopics].sort()) {
      if (projectedIds.has(topicId)) continue;
      const history = await readRecoveryHistory(
        path.join(
          appDataPath,
          "UserData",
          ownerId,
          "topics",
          topicId,
          "history.json",
        ),
      );
      const topicData = {
        id: topicId,
        name: `Recovered: ${topicId}`,
        createdAt: recoveryTimestamp(history),
      };
      projectedTopics.push(
        ownerType === "group"
          ? createGroupTopic(topicData)
          : createAgentTopic(topicData),
      );
      projectedIds.add(topicId);
      added += 1;
    }

    const removed = previousTopics.length - (projectedTopics.length - added);
    const changed =
      configRecovered ||
      recovered.source === "backup" ||
      !Array.isArray(config.topics) ||
      JSON.stringify(previousTopics) !== JSON.stringify(projectedTopics);
    if (changed) {
      config.topics = projectedTopics;
      await writeJsonAtomic(configPath, config);
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
  for (const [ownerType, rootName] of [
    ["agent", "Agents"],
    ["group", "AgentGroups"],
  ]) {
    for (const ownerId of await listDirectories(path.join(appDataPath, rootName))) {
      if (!ownerId || sanitizeId(ownerId) !== ownerId) continue;
      const existing = owners.get(ownerId);
      if (existing && existing.ownerType !== ownerType) {
        throw new Error(`Physical owner ${ownerId} is ambiguous between agent and group`);
      }
      owners.set(ownerId, { ownerType, physicalTopics: new Set() });
    }
  }

  const userDataPath = path.join(appDataPath, "UserData");
  for (const ownerId of await listDirectories(userDataPath)) {
    if (!ownerId || sanitizeId(ownerId) !== ownerId) continue;
    const topicsPath = path.join(userDataPath, ownerId, "topics");
    const topicIds = (await listDirectories(topicsPath))
      .filter((topicId) => topicId !== "default" && sanitizeId(topicId) === topicId);
    const owner = owners.get(ownerId);
    if (!owner) {
      if (topicIds.length > 0) {
        getLogger().logOperation(
          "reconcile",
          "repair_projection",
          ownerId,
          "error",
          "UserData owner has no unambiguous Agents/AgentGroups directory; skipped",
        );
      }
      continue;
    }
    for (const topicId of topicIds) {
      owner.physicalTopics.add(topicId);
    }
    owners.set(ownerId, owner);
  }
  return owners;
}

/**
 * 启动 reconcile 前，把 UserData 的物理 Topic 集合投影回 Agent/Group config。
 * 物理目录存在即为 live；旧索引墓碑不参与本步骤。
 */
async function repairTopicProjectionsFromDisk(
  appDataPath,
  physicalOwners = null,
) {
  const owners = physicalOwners || await scanPhysicalTopicTree(appDataPath);

  const stats = { ownersChanged: 0, topicsAdded: 0, topicsRemoved: 0 };
  for (const ownerId of [...owners.keys()].sort()) {
    const owner = owners.get(ownerId);
    const result = await repairOwnerTopicProjection({
      appDataPath,
      ownerId,
      ownerType: owner.ownerType,
      physicalTopics: owner.physicalTopics,
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
 * legacy 索引只保留物理树仍存在的 live 行。删除墓碑在同一事务中级联到消息，
 * 用于收敛“物理删除完成、进程在索引写入前退出”的窗口。
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
  for (const [ownerId, owner] of owners) {
    liveOwners.add(`${owner.ownerType}:${ownerId}`);
    for (const topicId of owner.physicalTopics) {
      const previous = liveTopics.get(topicId);
      if (previous) {
        throw new Error(
          `Physical topic ${topicId} is ambiguous between ${previous.ownerId} and ${ownerId}`,
        );
      }
      liveTopics.set(topicId, { ownerId, ownerType: owner.ownerType });
    }
  }

  const ownerRows = database.prepare(
    `SELECT id, type, file_path, deleted_at FROM entity_index
     WHERE type = 'agent' OR type = 'group'`,
  ).all();
  const topicRows = database.prepare(
    `SELECT id, type, file_path, deleted_at FROM entity_index
     WHERE id <> 'default'
       AND (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic')`,
  ).all();
  const staleOwners = ownerRows.filter(
    (row) => !liveOwners.has(`${row.type}:${row.id}`),
  );
  const staleOwnerDeletedAtByPath = new Map(
    staleOwners.map((row) => [
      row.file_path,
      Number.isSafeInteger(row.deleted_at)
        ? Math.min(row.deleted_at, deletedAt)
        : deletedAt,
    ]),
  );
  const staleOwnerPaths = new Set(
    staleOwners.map((row) => row.file_path),
  );

  const staleTopicRows = topicRows.filter((row) => {
    if (staleOwnerPaths.has(row.file_path)) return true;
    const physical = liveTopics.get(row.id);
    if (!physical) return true;
    const normalized = row.file_path.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    const ownerId = parts.at(-2);
    const ownerType = parts.includes("AgentGroups")
      ? "group"
      : parts.includes("Agents")
        ? "agent"
        : null;
    if (!ownerId || !ownerType) {
      throw new Error(`Topic ${row.id} has an invalid indexed owner path`);
    }
    return ownerId !== physical.ownerId || ownerType !== physical.ownerType;
  });

  const stats = { ownersDeleted: 0, topicsDeleted: 0, messagesDeleted: 0 };
  database.exec("BEGIN IMMEDIATE");
  try {
    const deleteOwner = database.prepare(
      `UPDATE entity_index
       SET deleted_at = ?
       WHERE id = ? AND type = ? AND deleted_at IS NULL`,
    );
    const deleteAvatar = database.prepare(
      `UPDATE avatar_index
       SET deleted_at = ?
       WHERE owner_id = ? AND owner_type = ? AND deleted_at IS NULL`,
    );
    const deleteTopic = database.prepare(
      `UPDATE entity_index
       SET deleted_at = ?
       WHERE id = ? AND type = ? AND deleted_at IS NULL`,
    );
    const deleteMessages = database.prepare(
      `UPDATE message_index
       SET deleted_at = ?
       WHERE topic_id = ? AND deleted_at IS NULL`,
    );

    for (const owner of staleOwners) {
      const effectiveDeletedAt = staleOwnerDeletedAtByPath.get(owner.file_path);
      stats.ownersDeleted += deleteOwner.run(
        effectiveDeletedAt,
        owner.id,
        owner.type,
      ).changes;
      deleteAvatar.run(effectiveDeletedAt, owner.id, owner.type);
    }
    for (const topic of staleTopicRows) {
      const effectiveDeletedAt = Math.min(
        Number.isSafeInteger(topic.deleted_at) ? topic.deleted_at : deletedAt,
        staleOwnerDeletedAtByPath.get(topic.file_path) ?? deletedAt,
      );
      stats.topicsDeleted += deleteTopic.run(
        effectiveDeletedAt,
        topic.id,
        topic.type,
      ).changes;
      stats.messagesDeleted += deleteMessages.run(
        effectiveDeletedAt,
        topic.id,
      ).changes;
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return stats;
}

/**
 * 下载头像
 * @param {string} id - 所有者 ID
 * @param {string} type - 所有者类型 (agent/group)
 * @returns {Promise<{filePath: string}|null>}
 */
async function downloadAvatar(id, type) {
  const db = getDb();
  const logger = getLogger();
  if (!db) return null;

  const safeId = sanitizeId(id);
  if (
    !safeId ||
    safeId !== id ||
    !["agent", "group", "user"].includes(type) ||
    (type === "user" && safeId !== "user_avatar")
  ) {
    throw new Error("Invalid avatar owner identity");
  }
  const row = db
    .prepare(
      "SELECT file_path FROM avatar_index WHERE owner_type = ? AND owner_id = ? AND deleted_at IS NULL",
    )
    .get(type, safeId);
  if (!row) {
    logger.logOperation("owner_metadata", "download_avatar", id, "error", `type=${type} not found`);
    return null;
  }
  const stats = await fs.stat(row.file_path);
  if (!stats.isFile()) throw new Error("Avatar index does not point to a file");

  logger.logOperation("owner_metadata", "download_avatar", id, "success", `type=${type}`);
  return { filePath: row.file_path };
}

/**
 * 上传头像
 * @param {object} params
 * @param {string} params.id - 所有者 ID
 * @param {string} params.type - 所有者类型 (agent/group)
 * @param {Buffer} params.data - 头像二进制数据
 * @param {string} params.appDataPath - AppData 路径
 */
async function uploadAvatar({ id, type, data, appDataPath }) {
  const logger = getLogger();
  const safeId = sanitizeId(id);
  if (
    !safeId ||
    safeId !== id ||
    !["agent", "group", "user"].includes(type) ||
    !Buffer.isBuffer(data) ||
    data.length > 20 * 1024 * 1024 ||
    (type === "user" && safeId !== "user_avatar")
  ) {
    throw new Error("Avatar upload has an invalid owner or exceeds 20 MiB");
  }
  const isGroup = type === "group";
  const isUser = type === "user";
  if (!isUser) {
    const parent = getEntityIndex(safeId, type);
    if (!parent || parent.deleted_at != null) {
      throw new Error(`Avatar owner ${type}/${safeId} is missing or deleted`);
    }
  }
  const baseDirName = isGroup ? "AgentGroups" : "Agents";
  const entityDir = isUser
    ? path.join(appDataPath, "UserData")
    : path.join(appDataPath, baseDirName, safeId);

  // 默认保存为 png
  const avatarFileName = isUser ? "user_avatar.png" : "avatar.png";
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

  const hash = computeBinaryHash(data);
  upsertAvatarIndex(safeId, type, avatarPath, hash);

  // Group 头像需要额外更新 config.json 的 avatar 字段
  if (isGroup) {
    const configPath = path.join(entityDir, "config.json");
    writeIntentLock.add(safeId);
    const release = await acquireLock(configPath);
    try {
      const content = await fs.readFile(configPath, "utf-8");
      const config = JSON.parse(content);
      config.avatar = avatarFileName;
      
      const tmpPath = `${configPath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
      await fs.rename(tmpPath, configPath);

      // 更新实体索引 (V2: 使用 DTO 提取)
      const groupHash = computeDtoHash(extractGroupDTO(config), GROUP_SYNC_FIELDS);
      upsertEntityIndex(safeId, "group", configPath, groupHash);
    } catch (e) {
      logger.logOperation("owner_metadata", "upload_avatar", safeId, "error", `update group config failed: ${e.message}`);
      throw e;
    } finally {
      release();
      setTimeout(() => writeIntentLock.delete(safeId), 1000);
    }
  }

  logger.logOperation("owner_metadata", "upload_avatar", safeId, "success", `type=${type}`);
  return { success: true, id: safeId };
}

/**
 * 检查写入意图锁
 * @param {string} id - 实体 ID
 * @returns {boolean}
 */
function isWriteLocked(id) {
  return writeIntentLock.has(sanitizeId(id));
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
}) {
  const db = getDb();
  const logger = getLogger();
  if (!db) {
    return entityFailure("Database not initialized", {
      code: "SYNC_DB_UNAVAILABLE",
      stage: entityStage(type),
    });
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
    }, { id });
  }
  const actualPhase = isTopic ? "topic_metadata" : "owner_metadata";

  if (isTopic) {
    writeIntentLock.add(safeId);
  }

  const row = getEntityIndex(safeId, type);

  try {
    if (type === "avatar") {
      if (!["agent", "group", "user"].includes(ownerType)) {
        throw new Error("Avatar deletion requires a valid ownerType");
      }
      softDeleteAvatarIndex(safeId, ownerType, deletedAt);
      logger.logOperation(
        actualPhase,
        "delete",
        safeId,
        "success",
        "type=avatar, soft deleted",
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
        row?.file_path &&
        path.resolve(row.file_path) !== path.resolve(configPath)
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
      await fs.rm(topicDir, { recursive: true, force: true });
      upsertEntityTombstone(
        safeId,
        row?.type || type,
        configPath,
        deletedAt,
      );
      db.prepare(
        `UPDATE message_index
         SET deleted_at = CASE
           WHEN deleted_at IS NULL THEN ? ELSE MIN(deleted_at, ?) END
         WHERE topic_id = ?`,
      ).run(deletedAt, deletedAt, safeId);

      // config.topics 是被动投影；损坏或暂时不可写都不能反向阻塞物理删除。
      try {
        const releaseProjection = await acquireLock(configPath);
        try {
          const recovered = await readConfigForRepair(configPath);
          if (recovered.config) {
            const previousTopics = Array.isArray(recovered.config.topics)
              ? recovered.config.topics
              : [];
            const topics = previousTopics.filter((topic) => topic?.id !== safeId);
            if (
              recovered.source === "backup" ||
              !Array.isArray(recovered.config.topics) ||
              topics.length !== previousTopics.length
            ) {
              recovered.config.topics = topics;
              await writeJsonAtomic(configPath, recovered.config);
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
      logger.logOperation(
        actualPhase,
        "delete",
        safeId,
        "success",
        `type=${type}, physical topic removed before config projection`,
      );
      return {
        success: true,
        id: safeId,
        ownerType,
        ownerId: safeOwnerId,
      };
    }

    const entityDir = row?.file_path
      ? path.dirname(row.file_path)
      : path.join(
          appDataPath,
          type === "group" ? "AgentGroups" : "Agents",
          safeId,
        );
    const userDataDir = path.join(appDataPath, "UserData", safeId);

    // Owner 目录先形成删除事实；遗留 UserData 即使清理中断也不会被猜测成 Agent。
    await fs.rm(entityDir, { recursive: true, force: true });
    const configPath = row?.file_path || path.join(entityDir, "config.json");
    upsertEntityTombstone(safeId, row?.type || type, configPath, deletedAt);
    softDeleteAvatarIndex(safeId, type, deletedAt);
    db.prepare(
      `UPDATE message_index
       SET deleted_at = CASE
         WHEN deleted_at IS NULL THEN ? ELSE MIN(deleted_at, ?) END
       WHERE topic_id IN (
         SELECT id FROM entity_index
         WHERE file_path = ?
           AND (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic')
       )`,
    ).run(deletedAt, deletedAt, configPath);
    db.prepare(
      `UPDATE entity_index
       SET deleted_at = CASE
         WHEN deleted_at IS NULL THEN ? ELSE MIN(deleted_at, ?) END
       WHERE file_path = ?
         AND (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic')`,
    ).run(deletedAt, deletedAt, configPath);
    await fs.rm(userDataDir, { recursive: true, force: true });
    logger.logOperation(
      actualPhase,
      "delete",
      safeId,
      "success",
      `type=${type}, physical owner history removed before config projection`,
    );

    return { success: true, id: safeId };
  } catch (e) {
    logger.logOperation(actualPhase, "delete", safeId, "error", e.message);
    return entityFailure(e, {
      code: "SYNC_DELETE_FAILED",
      stage: actualPhase,
      failedTopicIds: isTopic ? [safeId] : [],
    });
  } finally {
    if (isTopic) {
      setTimeout(() => writeIntentLock.delete(safeId), 1000);
    }
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
async function deleteMessage({ msgId, deletedAt, topicId, appDataPath }) {
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
      !Number.isSafeInteger(deletedAt) ||
      deletedAt < 0
    ) {
      throw new Error("Invalid message deletion payload");
    }
    softDeleteMessageIndex(safeMsgId, deletedAt, safeTopicId);
    if (safeTopicId && appDataPath) {
      const { pruneMessageFromPhysicalHistory } = require("./message");
      await pruneMessageFromPhysicalHistory(safeTopicId, safeMsgId, appDataPath);
    }
    logger.logOperation("messages", "delete", safeMsgId, "success", `soft deleted in topic ${safeTopicId || 'all'}`);
    return { success: true, topicId: safeTopicId, msgId: safeMsgId };
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
  downloadEntity,
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
  writeIntentLock,
  deleteEntity,
  deleteMessage,
};
