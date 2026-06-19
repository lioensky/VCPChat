/**
 * 实体上传下载核心逻辑
 */

const fs = require("fs").promises;
const path = require("path");
const {
  getDb,
  getEntityIndex,
  upsertEntityIndex,
  upsertAttachmentIndex,
  upsertAvatarIndex,
  softDeleteEntityIndex,
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
  if (!db) return null;

  const safeId = sanitizeId(id);
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
    return null;
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
  for (const req of requests) {
    const safeId = sanitizeId(req.id);
    const row = getEntityIndex(safeId, req.type);
    if (!row) continue;

    if (!fileGroups.has(row.file_path)) {
      fileGroups.set(row.file_path, {
        isGroup: row.file_path.includes("AgentGroups"),
        reqs: [],
      });
    }
    fileGroups.get(row.file_path).reqs.push({ req, safeId });
  }

  const results = [];
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
          results.push({ id: req.id, type, data: dto });
        }
      }
    } catch (e) {
      logger.logOperation("owner_metadata", "download", filePath, "error", e.message);
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

  for (const item of items) {
    const { id, type, data } = item;
    const safeId = sanitizeId(id);
    if (safeId) {
      writeIntentLock.add(safeId);
      addedIntentLocks.add(safeId);
    }
    const isTopic = type === "topic" || type === "agent_topic" || type === "group_topic";
    const isGroup = type === "group";
    const baseDirName = isGroup ? "AgentGroups" : "Agents";

    let configPath;
    let row = getEntityIndex(safeId, type);

    if (row) {
      configPath = row.file_path;
    } else if (isTopic && data.ownerId) {
      const parentBaseDir = (type === "group_topic" || data.ownerType === "group") ? "AgentGroups" : "Agents";
      configPath = path.join(appDataPath, parentBaseDir, data.ownerId, "config.json");
    } else if (!isTopic) {
      const newEntityDir = path.join(appDataPath, baseDirName, safeId);
      configPath = path.join(newEntityDir, "config.json");
      // 注意：批量上传暂不支持新建 Agent/Group（目录创建逻辑较复杂），仅支持已有实体的 Topic 批量更新
    }

    if (!configPath) {
      results.push({ id, success: false, error: "Cannot resolve config path" });
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
        let config = {};
        let fileReadSuccess = false;

        try {
          const content = await fs.readFile(configPath, "utf-8");
          if (content.trim()) {
            config = JSON.parse(content);
            fileReadSuccess = true;
          }
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }

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
            } else if (type === "agent") {
              config = handleAgentUpload({ config, id, data, isNewEntity: !fileReadSuccess, fileReadSuccess });
            } else if (type === "group") {
              config = handleGroupUpload({ config, id, data, isNewEntity: !fileReadSuccess, fileReadSuccess });
            }
            
            results.push({ id, success: true });
          } catch (e) {
            results.push({ id, success: false, error: e.message });
          }
        }

        // 原子写入
        const tmpPath = `${configPath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
        await fs.rename(tmpPath, configPath);

        // 批量更新索引
        for (const item of group.items) {
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
        // 文件级错误，标记该组所有 item 为失败
        logger.logOperation("topic_metadata", "batch_upload", configPath, "error", e.message);
        for (const item of group.items) {
          if (!results.find(r => r.id === item.id)) {
            results.push({ id: item.id, success: false, error: `File error: ${e.message}` });
          }
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
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function uploadEntity({ id, type, data, appDataPath }) {
  const db = getDb();
  const logger = getLogger();
  if (!db) return { success: false, error: "Database not initialized" };

  const safeId = sanitizeId(id);
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
    } catch (e) {
      logger.logOperation(phase, "upload", safeId, "error", `parent entity ${data.ownerId} not found`);
      return {
        success: false,
        error: `Parent entity ${data.ownerId} not found on desktop`,
      };
    }
  } else {
    logger.logOperation(phase, "upload", safeId, "error", "topic parent entity metadata missing");
    return { success: false, error: "Topic parent entity metadata missing" };
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
    return { success: true };
  } catch (e) {
    logger.logOperation(phase, "upload", safeId, "error", e.message);
    return { success: false, error: e.message };
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
    logger.logOperation("topic_metadata", "upload", id, "error", `invalid config, refusing to write`);
    throw new Error(`Invalid parent config for topic ${id}`);
  }

  if (!Array.isArray(config.topics)) {
    config.topics = [];
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

    // 确保 history.json 存在
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
      await fs.access(historyPath);
    } catch {
      await fs.writeFile(historyPath, "[]", "utf-8");

    }
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

  const row = db
    .prepare(
      "SELECT file_path FROM avatar_index WHERE owner_type = ? AND owner_id = ?",
    )
    .get(type, id);
  if (!row) {
    logger.logOperation("owner_metadata", "download_avatar", id, "error", `type=${type} not found`);
    return null;
  }

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
  const isGroup = type === "group";
  const baseDirName = isGroup ? "AgentGroups" : "Agents";
  const entityDir = path.join(appDataPath, baseDirName, safeId);

  // 默认保存为 png
  const avatarFileName = "avatar.png";
  const avatarPath = path.join(entityDir, avatarFileName);

  // 确保目录存在
  await fs.mkdir(entityDir, { recursive: true });

  await fs.writeFile(avatarPath, data);

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
    } finally {
      release();
      setTimeout(() => writeIntentLock.delete(safeId), 1000);
    }
  }

  logger.logOperation("owner_metadata", "upload_avatar", safeId, "success", `type=${type}`);
  return { success: true };
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
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteEntity({ id, type, deletedAt, appDataPath }) {
  const db = getDb();
  const logger = getLogger();
  if (!db) return { success: false, error: "Database not initialized" };

  const safeId = sanitizeId(id);
  const isTopic = type === "agent_topic" || type === "group_topic" || type === "topic";
  const actualPhase = isTopic ? "topic_metadata" : "owner_metadata";

  if (isTopic) {
    writeIntentLock.add(safeId);
  }

  const row = getEntityIndex(safeId, type);
  let configPath = null;
  if (row && row.file_path && isTopic) {
    configPath = row.file_path;
  }

  const release = configPath ? await acquireLock(configPath) : null;

  try {
    if (type === "avatar") {
      softDeleteAvatarIndex(safeId, "agent", deletedAt);
      logger.logOperation(actualPhase, "delete", safeId, "success", "type=avatar, soft deleted");
      return { success: true };
    }

    let entityDir = null;

    if (row && row.file_path) {
      if (type === "agent" || type === "group") {
        entityDir = path.dirname(row.file_path);
      }
    } else if (type === "agent" || type === "group") {
      const baseDirName = type === "group" ? "AgentGroups" : "Agents";
      entityDir = path.join(appDataPath, baseDirName, safeId);
    }

    softDeleteEntityIndex(safeId, type, deletedAt);

    if (entityDir && (type === "agent" || type === "group")) {
      try {
        await fs.rm(entityDir, { recursive: true, force: true });
        logger.logOperation(actualPhase, "delete", safeId, "success", `type=${type}, physical dir removed`);
      } catch (e) {
        logger.logOperation(actualPhase, "delete", safeId, "error", `physical removal failed: ${e.message}`);
      }
    }

    if (isTopic) {
      if (row && row.file_path) {
        try {
          const content = await fs.readFile(row.file_path, "utf-8");
          const config = JSON.parse(content);
          if (Array.isArray(config.topics)) {
            config.topics = config.topics.filter((t) => t.id !== safeId);

            const configPath = row.file_path;
            const tmpPath = `${configPath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
            await fs.rename(tmpPath, configPath);

            logger.logOperation(actualPhase, "delete", safeId, "success", `type=${type}, removed from parent config`);
          }
        } catch (e) {
          logger.logOperation(actualPhase, "delete", safeId, "error", `remove from parent config failed: ${e.message}`);
        }
      }
    }

    return { success: true };
  } catch (e) {
    logger.logOperation(actualPhase, "delete", safeId, "error", e.message);
    return { success: false, error: e.message };
  } finally {
    if (release) release();
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
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteMessage({ msgId, deletedAt, topicId }) {
  const db = getDb();
  const logger = getLogger();
  if (!db) return { success: false, error: "Database not initialized" };

  const safeMsgId = sanitizeId(msgId);
  const safeTopicId = topicId ? sanitizeId(topicId) : null;

  try {
    softDeleteMessageIndex(safeMsgId, deletedAt, safeTopicId);
    logger.logOperation("messages", "delete", safeMsgId, "success", `soft deleted in topic ${safeTopicId || 'all'}`);
    return { success: true };
  } catch (e) {
    logger.logOperation("messages", "delete", safeMsgId, "error", e.message);
    return { success: false, error: e.message };
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
  sanitizeId,
  writeIntentLock,
  deleteEntity,
  deleteMessage,
};
