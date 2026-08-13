/**
 * 主入口 - 模块化同步插件
 */

const fs = require("fs").promises;
const path = require("path");
const {
  initDb,
  getDb,
  getEntityIndex,
  upsertEntityIndex,
  upsertAttachmentIndex,
  upsertAvatarIndex,
  cleanupOldDeletedRecords,
} = require("./core/db");
const {
  computeBinaryHash,
  computeDtoHash,
  computeAggregatedHash,
} = require("./core/hash");
const {
  startWsServer,
} = require("./transport/websocket");
const {
  registerRoutes: registerHttpRoutes,
} = require("./transport/routes");
const {
  handleSyncManifest,
  handleMessageManifest,
} = require("./sync/manifest");
const { handleSyncTopicHashBatch, handleSyncMessageDiffBatch } = require("./sync/diff");
const { ingestHistoryToDb } = require("./sync/message");
const { createCentralSyncAdapter } = require("./sync/central");
const { isWriteLocked, sanitizeId, deleteEntity, deleteMessage } = require("./sync/entity");
const { getLogger, resetLogger } = require("./core/logger");
const { createPhaseAck, createVersionAck } = require("./protocol");
const { withSyncErrorContext } = require("./error-contract");
const {
  AGENT_SYNC_FIELDS,
  GROUP_SYNC_FIELDS,
  AGENT_TOPIC_SYNC_FIELDS,
  GROUP_TOPIC_SYNC_FIELDS,
  extractAgentDTO,
  extractGroupDTO,
  extractTopicDTO,
} = require("./dto");
const {
  resolveCentralIndexPreference,
} = require("./config/defaults");

let chokidar = null;

try {
  chokidar = require("chokidar");
} catch {}

/**
 * 注册插件
 */
async function registerRoutes(app, pluginConfig, projectBasePath, services = {}) {
  const syncToken = pluginConfig.MobileSyncToken;
  // 最终修正：AppData 位于 projectBasePath (VCPDistributedServer) 的上一级目录
  const appDataPath = path.resolve(projectBasePath, "..", "AppData");
  const wsPort = parseInt(pluginConfig.MobileSyncPort) || 5975;
  const centralRequested = resolveCentralIndexPreference(
    pluginConfig,
    services.chatDataService,
  );

  // 中央模式存在两个配置入口：Electron 全局 settings.json 与插件 config.env。
  // 若只有插件配置启用，主进程会把 CDS 当作普通 shadow service 后台启动，
  // 此时插件初始化可能早于 READY。由真正请求中央数据面的插件显式等待 Facade，
  // 避免因 client 暂时为空而永久漏注册 HTTP Router 与 WebSocket 端口。
  if (
    centralRequested &&
    !services.chatDataService?.client &&
    typeof services.chatDataService?.startShadowMode === "function"
  ) {
    await services.chatDataService.startShadowMode();
  }

  const useCentralIndex =
    centralRequested && services.chatDataService?.client;
  if (centralRequested && !useCentralIndex) {
    throw new Error(
      "MobileSyncUseCentralIndex is enabled but VCP-CDS is unavailable; disable the flag to roll back",
    );
  }
  const centralSync = useCentralIndex
    ? createCentralSyncAdapter({
        chatDataService: services.chatDataService,
        appDataPath,
      })
    : null;

  const logger = resetLogger();
  logger.startSession("system");

  // 中央模式不再打开持久化 sync_state.db。保留一个仅服务于附件、头像和
  // 配置 DTO 文件定位的进程内目录；消息索引、墓碑与历史指纹绝不写入其中。
  if (centralSync) {
    initDb(":memory:");
    await centralSync.reconcile();
    await reconcileCompatibilityAssets(appDataPath);
    centralSync.logEnabled();
  } else {
    const dbPath = path.join(__dirname, "sync_state.db");
    initDb(dbPath);
    await reconcileLocalFiles(appDataPath);
  }

  // 启动 WebSocket（仅在索引完成后开放，防止手机端提前连接）
  startWsServer({
    port: wsPort,
    syncToken,
    onMessage: async (payload) => {
      const logger = getLogger();

      switch (payload.type) {
        case "SYNC_MANIFEST": {
          logger.logOperation("websocket", "message", payload.type, "info", `dataType=${payload.dataType}`);

          // VCP-CDS 只持有 Agent、Group、Topic 与 Message 的中央索引。
          // Avatar 仍由本插件的兼容资产目录（内存 avatar_index + 物理文件）
          // 负责。不能把 avatar Manifest 转给 CDS，否则 CDS 会把本地清单
          // 视为空集，生成错误的全量 PUSH，并破坏 Owner Metadata 阶段。
          if (centralSync && payload.dataType !== "avatar") {
            return centralSync.handleSyncManifest(payload);
          }
          return handleSyncManifest(payload);
        }
        case "GET_MESSAGE_MANIFEST": {
          logger.logOperation("websocket", "message", payload.type, "info", `topicId=${payload.topicId}`);
          return centralSync
            ? centralSync.handleMessageManifest(payload)
            : handleMessageManifest(payload);
        }
        case "SYNC_TOPIC_HASH_BATCH": {
          const topicCount = Object.keys(payload.hashes || {}).length;
          logger.logOperation("websocket", "message", payload.type, "info", `topics=${topicCount}`);
          return centralSync
            ? centralSync.handleTopicHashBatch(payload)
            : handleSyncTopicHashBatch(payload);
        }
        case "SYNC_TOPIC_HASH_BATCH_V2": {
          const topicCount = Object.keys(payload.hashes || {}).length;
          logger.logOperation("websocket", "message", payload.type, "info", `topics=${topicCount}`);
          if (centralSync) {
            return centralSync.handleTopicHashBatch(payload);
          }
          const { handleSyncTopicHashBatchV2 } = require("./sync/diff");
          return handleSyncTopicHashBatchV2(payload);
        }
        case "SYNC_MESSAGE_DIFF_BATCH": {
          const topicCount = Object.keys(payload.topics || {}).length;
          logger.logOperation("websocket", "message", payload.type, "info", `topics=${topicCount}`);
          return centralSync
            ? centralSync.handleMessageDiffBatch(payload)
            : handleSyncMessageDiffBatch(payload);
        }
        case "PHASE_START": {
          const phase = payload.phase || "owner_metadata";
          logger.startPhase(phase, 0);

          // 所有 manifest 已在 SYNC_MANIFEST 阶段由手机端主动发送并处理完毕。
          // PHASE_START 仅作为阶段确认，不再返回冗余的 PHASE_MANIFESTS。
          return createPhaseAck(payload);
        }
        case "PHASE_COMPLETED": {
          const phase = payload.phase || "owner_metadata";
          if (
            centralSync &&
            (phase === "owner_metadata" || phase === "topic_metadata")
          ) {
            // Entity/topic files are written by the plugin while CDS owns the
            // central SQLite view. Do not acknowledge the phase until that view
            // has durably observed the parent records needed by later messages.
            await centralSync.reconcile();
          }
          logger.completePhase(phase);
          return createPhaseAck(payload, { echoFinalIdentity: true });
        }
        case "SYNC_ENTITY_UPDATE": {
          const { id, dataType, hash, ts } = payload;
          if (
            typeof id !== "string" ||
            sanitizeId(id) !== id ||
            !["agent", "group", "topic", "agent_topic", "group_topic"].includes(dataType) ||
            typeof hash !== "string" ||
            !/^[a-f0-9]{64}$/.test(hash) ||
            !Number.isSafeInteger(ts) ||
            ts < 0
          ) {
            throw Object.assign(new Error("SYNC_ENTITY_UPDATE contains invalid fields"), {
              code: "SYNC_PROTOCOL_INVALID",
            });
          }
          logger.logOperation("websocket", "entity_update", id, "info", `type=${dataType}`);

          // 旧通知只携带派生哈希，无法更新 CDS 完整数据；中央模式等待
          // 随后的实体 HTTP 上传或消息 Push，不再双写私有数据库。
          if (!centralSync) {
            const existing = getEntityIndex(id, dataType);
            if (!existing?.file_path) {
              throw Object.assign(
                new Error(`Cannot update missing local entity ${dataType}/${id}`),
                { code: "SYNC_ENTITY_NOT_FOUND" },
              );
            }
            upsertEntityIndex(id, dataType, existing.file_path, hash, ts);
          }

          return { type: "SYNC_ACK", id };
        }
        case "VERSION_CHECK": {
          const manifest = require("./plugin-manifest.json");
          logger.logOperation("websocket", "version_check", "mobile", "info", `mobileVersion=${payload.mobileVersion}, pluginVersion=${manifest.version}`);
          return createVersionAck(payload, manifest.version);
        }
        case "SYNC_ENTITY_DELETE": {
          const { id: rawId, dataType, topicId } = payload;
          const deletedAt = payload.deletedAt;
          let safeId = "";
          let avatarOwnerType = null;
          if (dataType === "avatar" && typeof rawId === "string") {
            const separator = rawId.indexOf(":");
            if (separator > 0 && separator === rawId.lastIndexOf(":")) {
              avatarOwnerType = rawId.slice(0, separator);
              const ownerId = rawId.slice(separator + 1);
              if (
                ["agent", "group", "user"].includes(avatarOwnerType) &&
                sanitizeId(ownerId) === ownerId &&
                (avatarOwnerType !== "user" || ownerId === "user_avatar")
              ) {
                safeId = ownerId;
              }
            }
          } else if (typeof rawId === "string" && sanitizeId(rawId) === rawId) {
            safeId = rawId;
          }

          if (
            !safeId ||
            ![
              "agent",
              "group",
              "topic",
              "agent_topic",
              "group_topic",
              "avatar",
              "message",
            ].includes(dataType) ||
            !Number.isSafeInteger(deletedAt) ||
            deletedAt < 0
          ) {
            const error = new Error(
              "SYNC_ENTITY_DELETE requires id, dataType and non-negative integer deletedAt",
            );
            error.code = "SYNC_DELETE_INVALID";
            throw error;
          }

          if (centralSync) {
            if (dataType === "message") {
              if (
                typeof topicId !== "string" ||
                !sanitizeId(topicId) ||
                sanitizeId(topicId) !== topicId
              ) {
                const error = new Error(
                  "Message delete requires a non-empty topicId",
                );
                error.code = "SYNC_DELETE_INVALID";
                throw error;
              }
              await centralSync.deleteMessage({
                topicId: sanitizeId(topicId),
                msgId: safeId,
                deletedAt,
              });
            } else {
              const result = await deleteEntity({
                id: safeId,
                type: dataType,
                ownerType: avatarOwnerType,
                deletedAt,
                appDataPath,
              });
              if (!result?.success) {
                throw withSyncErrorContext(
                  result?.error || "entity delete failed",
                  { code: "SYNC_DELETE_FAILED", stage: "owner_metadata" },
                );
              }
              await centralSync.reconcile();
            }
            return { type: "SYNC_ACK", id: safeId };
          }

          if (dataType === "message") {
            const safeTopicId = sanitizeId(topicId);
            if (!safeTopicId || safeTopicId !== topicId) {
              const error = new Error("Message delete requires a non-empty topicId");
              error.code = "SYNC_DELETE_INVALID";
              throw error;
            }
            const result = await deleteMessage({
              msgId: safeId,
              deletedAt,
              topicId: safeTopicId,
              appDataPath,
            });
            if (!result?.success) {
              throw withSyncErrorContext(
                result?.error || "message delete failed",
                {
                  code: "SYNC_DELETE_FAILED",
                  stage: "messages",
                  failedTopicIds: [safeTopicId],
                },
              );
            }
            logger.logOperation("websocket", "delete_notify", safeId, "success", "type=message");
          } else if (dataType === "avatar") {
            const result = await deleteEntity({
              id: safeId,
              type: "avatar",
              ownerType: avatarOwnerType,
              deletedAt,
              appDataPath,
            });
            if (!result?.success) {
              throw withSyncErrorContext(
                result?.error || "avatar delete failed",
                { code: "SYNC_DELETE_FAILED", stage: "owner_metadata" },
              );
            }
            logger.logOperation("websocket", "delete_notify", rawId, "success", "type=avatar");
          } else {
            const result = await deleteEntity({ id: safeId, type: dataType, deletedAt, appDataPath });
            if (!result?.success) {
              throw withSyncErrorContext(
                result?.error || "entity delete failed",
                {
                  code: "SYNC_DELETE_FAILED",
                  stage: ["topic", "agent_topic", "group_topic"].includes(dataType)
                    ? "topic_metadata"
                    : "owner_metadata",
                  failedTopicIds: ["topic", "agent_topic", "group_topic"].includes(dataType)
                    ? [safeId]
                    : [],
                },
              );
            }
            logger.logOperation("websocket", "delete_notify", safeId, "success", `type=${dataType}`);
          }

          return { type: "SYNC_ACK", id: rawId };
        }
        default:
          logger.logOperation("websocket", "unknown_message", payload.type, "warn");
          throw Object.assign(
            new Error(`Unsupported sync frame type: ${payload.type || "missing"}`),
            { code: "SYNC_PROTOCOL_INVALID" },
          );
      }
    },
  });

  // HTTP/NDJSON 传输层保持兼容，消息数据面由所选后端提供。
  registerHttpRoutes(app, { syncToken, appDataPath, centralSync });

  // 中央模式由 CDS 的 notify/reconcile 独占历史监听和消息墓碑持久化。
  if (!centralSync && chokidar) {
    startFileWatcher(appDataPath);
  }

  if (!centralSync) {
    setInterval(
      () => {
        cleanupOldDeletedRecords();
      },
      60 * 60 * 1000,
    );
    cleanupOldDeletedRecords();
  }
}

/**
 * 中央模式兼容目录：只定位配置 DTO、头像和附件二进制。
 * history.json、message_index、消息墓碑和聚合历史哈希全部由 CDS 负责。
 */
async function reconcileCompatibilityAssets(appDataPath) {
  const db = getDb();
  if (!db) return;

  const logger = getLogger();
  const userDataDir = path.join(appDataPath, "UserData");
  const attachmentsDir = path.join(userDataDir, "attachments");
  const now = Date.now();

  try {
    const files = await fs.readdir(attachmentsDir);
    for (const file of files) {
      const filePath = path.join(attachmentsDir, file);
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) continue;
      let hash = file.split(".")[0].toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(hash)) {
        hash = computeBinaryHash(await fs.readFile(filePath));
      }
      upsertAttachmentIndex(hash, filePath, now);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  try {
    const avatar = path.join(userDataDir, "user_avatar.png");
    upsertAvatarIndex(
      "user_avatar",
      "user",
      avatar,
      computeBinaryHash(await fs.readFile(avatar)),
      now,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await scanEntities(
    path.join(appDataPath, "Agents"),
    "agent",
    db,
    now,
    appDataPath,
    logger,
  );
  await scanEntities(
    path.join(appDataPath, "AgentGroups"),
    "group",
    db,
    now,
    appDataPath,
    logger,
  );
}

/**
 * 扫描本地文件并建立索引
 */
async function reconcileLocalFiles(appDataPath) {
  const db = getDb();
  if (!db) return;

  const logger = getLogger();
  logger.startPhase("reconcile", 0);
  logger.logInfo("reconcile", "正在执行轻量级索引扫描...");

  // 物理清除任何残留的 default 脏话题索引以及冗余的 agent_topic / group_topic 类型记录
  db.prepare("DELETE FROM entity_index WHERE id = 'default'").run();
  db.prepare("DELETE FROM message_index WHERE topic_id = 'default'").run();
  db.prepare("DELETE FROM entity_index WHERE type = 'agent_topic' OR type = 'group_topic'").run();

  const agentsDir = path.join(appDataPath, "Agents");
  const groupsDir = path.join(appDataPath, "AgentGroups");
  const userDataDir = path.join(appDataPath, "UserData");
  const attachmentsDir = path.join(userDataDir, "attachments");
  const now = Date.now();

  let attachmentCount = 0;
  let agentCount = 0;
  let groupCount = 0;
  let topicCount = 0;
  let messageCount = 0;

  // 1. 扫描附件
  let attachmentFiles = [];
  try {
    attachmentFiles = await fs.readdir(attachmentsDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    logger.logInfo("reconcile", `附件目录不存在: ${attachmentsDir}`, "warn");
  }
  for (const file of attachmentFiles) {
    const filePath = path.join(attachmentsDir, file);
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) continue;

    let hash = file.split('.')[0].toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      const buffer = await fs.readFile(filePath);
      hash = computeBinaryHash(buffer);
    }

    upsertAttachmentIndex(hash, filePath, now);
    attachmentCount++;
  }

  // 2. 扫描系统级头像 (用户头像)
  const userAvatarPath = path.join(userDataDir, "user_avatar.png");
  try {
    const buffer = await fs.readFile(userAvatarPath);
    const hash = computeBinaryHash(buffer);
    upsertAvatarIndex("user_avatar", "user", userAvatarPath, hash, now);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  // 3. 扫描智能体与群组
  const agentResult = await scanEntities(agentsDir, "agent", db, now, appDataPath, logger);
  agentCount = agentResult.count;
  topicCount += agentResult.topicCount;

  const groupResult = await scanEntities(groupsDir, "group", db, now, appDataPath, logger);
  groupCount = groupResult.count;
  topicCount += groupResult.topicCount;

  // 4. 扫描历史记录
  messageCount = await scanHistory(userDataDir, db, logger);

  // 5. 计算层级聚合指纹
  const aggregatedCount = computeAggregatedHashes(db, logger);

  logger.logOperation("reconcile", "summary", "reconcile", "success", `agents=${agentCount} groups=${groupCount} topics=${topicCount} messages=${messageCount} attachments=${attachmentCount} aggregated=${aggregatedCount}`);
  logger.completePhase("reconcile");
  logger.logInfo("reconcile", "索引扫描完成。");
  logger.endSession();
}

const SYSTEM_FOLDERS = [
  "UserData",
  "AppData",
  "avatarimage",
  "canvas",
  "DesktopData",
  "DesktopWidgets",
  "generated_lists",
  "lyric",
  "MusicCoverCache",
  "Notemodules",
  "ResampleCache",
  "systemPromptPresets",
  "Translatormodules",
  "tts_cache",
  "WallpaperThumbnailCache",
  "attachments",
  "notes_attachments_agent",
  "notes_attachments_group",
  "user_avatar.png",
  "forum.config.json",
  "emoticon_library.json",
  "global_prompt_warehouse.json",
  "model_favorites.json",
  "model_usage_stats.json",
  "rust-assistant-config.json",
  "settings.json",
  "settings.json.backup",
  "songlist.json",
  "sovits_models.json",
  ".git",
  ".idea",
  ".vscode",
  "node_modules",
];

/**
 * 扫描实体目录
 */
async function scanEntities(baseDir, type, db, now, appDataPath, logger) {
  let count = 0;
  let topicCount = 0;
  let entries;
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { count, topicCount };
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SYSTEM_FOLDERS.includes(entry.name)) continue;

    const entityDir = path.join(baseDir, entry.name);
    const configPath = path.join(entityDir, "config.json");

    try {
      const content = await fs.readFile(configPath, "utf-8");
      const config = JSON.parse(content);
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error("Entity config root must be an object");
      }
      const id = config.id || entry.name;

      // 索引主实体 (V2: 使用 DTO 提取以对齐默认值处理)
      const dto = type === "agent" ? extractAgentDTO(config) : extractGroupDTO(config);
      const hash = computeDtoHash(
        dto,
        type === "agent" ? AGENT_SYNC_FIELDS : GROUP_SYNC_FIELDS,
      );
      upsertEntityIndex(id, type, configPath, hash, now);
      count++;

      const topicLen = Array.isArray(config.topics) ? config.topics.length : 0;
      if (topicLen > 0) topicCount += topicLen;
      const avatarExts = ["png", "jpg", "jpeg", "webp", "gif"];
      for (const ext of avatarExts) {
        const avatarPath = path.join(entityDir, `avatar.${ext}`);
        try {
          const buffer = await fs.readFile(avatarPath);
          const avatarHash = computeBinaryHash(buffer);
          upsertAvatarIndex(id, type, avatarPath, avatarHash, now);
          break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }

      if (Array.isArray(config.topics)) {
        for (const topic of config.topics) {
          if (topic.id === "default") continue;
          const topicDto = extractTopicDTO(topic, id, type);
          const topicHash = computeDtoHash(
            topicDto,
            type === "group"
              ? GROUP_TOPIC_SYNC_FIELDS
              : AGENT_TOPIC_SYNC_FIELDS,
          );
          upsertEntityIndex(topic.id, "topic", configPath, topicHash, now);
        }
      }
    } catch (error) {
      logger.logOperation("reconcile", type, entry.name, "error", error.message);
      throw error;
    }
  }
  return { count, topicCount };
}

/**
 * 扫描历史记录
 */
async function scanHistory(userDataDir, db, logger) {
  let totalMessages = 0;
  let entries;
  try {
    entries = await fs.readdir(userDataDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SYSTEM_FOLDERS.includes(entry.name)) continue;

    const topicsDir = path.join(userDataDir, entry.name, "topics");
    let topicFolders;
    try {
      topicFolders = await fs.readdir(topicsDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const topicEntry of topicFolders) {
      if (!topicEntry.isDirectory() || topicEntry.name === "default") continue;
      const topicId = topicEntry.name;
      const historyPath = path.join(topicsDir, topicId, "history.json");
      try {
        const { history } = await readHistoryStrict(historyPath);
        totalMessages += history.length;
        await ingestHistoryToDb(historyPath, topicId, "reconcile");
      } catch (error) {
        logger.logOperation("reconcile", "history", topicId, "error", error.message);
        throw error;
      }
    }
  }
  return totalMessages;
}

/**
 * 计算层级聚合指纹
 */
function computeAggregatedHashes(db, logger) {
  let updatedCount = 0;
  const entities = db
    .prepare(
      "SELECT id, type, hash, aggregated_hash, file_path FROM entity_index WHERE deleted_at IS NULL",
    )
    .all();

  // 1. 预加载所有 Topic 并按 Parent ID 分组，消除 N+1 查询
  const topicMap = new Map(); // Map<parentId, Array<{hash, aggregated_hash}>>
  entities
    .filter((e) => e.type === "topic" || e.type === "agent_topic" || e.type === "group_topic")
    .forEach((t) => {
      if (t.file_path) {
        const parts = t.file_path.split(/[\\/]/);
        const parentId = parts[parts.length - 2];
        if (!topicMap.has(parentId)) topicMap.set(parentId, []);
        topicMap.get(parentId).push(t);
      }
    });

  // 2. 为 Agent 和 Group 计算聚合指纹 (V2: 聚合子话题的 config_hash 和 content_hash)
  for (const e of entities) {
    if (e.type === "agent" || e.type === "group") {
      const topicsOfEntity = topicMap.get(e.id) || [];

      const childHashes = [];
      topicsOfEntity.forEach((t) => {
        childHashes.push(t.hash);
        childHashes.push(t.aggregated_hash || "");
      });
      const rootHash = computeAggregatedHash(childHashes);

      if (rootHash !== e.aggregated_hash) {
        db.prepare(
          "UPDATE entity_index SET aggregated_hash = ?, updated_at = ? WHERE id = ? AND type = ?",
        ).run(rootHash, Date.now(), e.id, e.type);
        updatedCount++;
      }
    }
  }

  // 3. 兜底：为所有缺失 aggregated_hash 的 topic 写入标准空聚合值 (V2: 对齐手机端 computeAggregatedHash([]))
  const nullTopics = entities.filter(e => (e.type === "topic" || e.type === "agent_topic" || e.type === "group_topic") && (e.aggregated_hash === null || e.aggregated_hash === ""));
  if (nullTopics.length > 0) {
    const { computeAggregatedHash } = require("./core/hash");
    const emptyContentHash = computeAggregatedHash([]);
    
    for (const t of nullTopics) {
      if (t.aggregated_hash !== emptyContentHash) {
        db.prepare(
          "UPDATE entity_index SET aggregated_hash = ?, updated_at = ? WHERE id = ? AND (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic')",
        ).run(emptyContentHash, Date.now(), t.id);
        updatedCount++;
      }
    }
  }

  return updatedCount;
}

/**
 * 启动文件监听
 */
function startFileWatcher(appDataPath) {
  const watcher = chokidar.watch(appDataPath, {
    persistent: true,
    ignoreInitial: true,
    depth: 5,
  });

  const logger = getLogger();
  logger.logInfo("watcher", `文件监听已启动: path=${appDataPath}`);

  watcher.on("all", async (event, filePath) => {
    const fileName = path.basename(filePath);
    const isHistory = fileName === "history.json";
    const isConfig = fileName === "config.json";
    if (!isHistory && !isConfig) return;

    // 严格限制合法目录：必须在 Agents 或 AgentGroups 目录下
    const isAgentPath = filePath.includes(`${path.sep}Agents${path.sep}`);
    const isGroupPath = filePath.includes(`${path.sep}AgentGroups${path.sep}`);
    const isUserDataPath = filePath.includes(`${path.sep}UserData${path.sep}`);

    if (!isAgentPath && !isGroupPath && !isUserDataPath) return;

    let id = isHistory
      ? getTopicIdFromPath(filePath)
      : path.basename(path.dirname(filePath));
    id = sanitizeId(id);
    if (!id || isWriteLocked(id)) return;

    logger.logOperation("watcher", "file", id, "info", `${event}: ${filePath}`);

    try {
      if (isConfig) {
        // 只有 Agents 或 AgentGroups 目录下的 config.json 才作为实体索引
        if (isAgentPath || isGroupPath) {
          const type = isAgentPath ? "agent" : "group";
          await ingestConfigToDb(filePath, type);
        }
      } else if (isHistory) {
        await ingestHistoryToDb(filePath, id);
      }
    } catch (e) {
      logger.logOperation("watcher", "file", id, "error", `${event} failed: ${e.message}`);
    }
  });
}

/**
 * 从路径提取 Topic ID
 */
function getTopicIdFromPath(filePath) {
  const parts = filePath.split(path.sep);
  const topicIdx = parts.lastIndexOf("topics");
  if (topicIdx !== -1 && parts[topicIdx + 1]) {
    return parts[topicIdx + 1];
  }
  return null;
}

/**
 * 摄取配置文件到索引
 */
async function ingestConfigToDb(configPath, type) {
  const db = getDb();
  if (!db) return;

  const logger = getLogger();

  try {
    const content = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(content);
    const now = Date.now();
    const id = config.id || path.basename(path.dirname(configPath));

    // 索引主实体
    const hash = computeDtoHash(
      config,
      type === "agent" ? AGENT_SYNC_FIELDS : GROUP_SYNC_FIELDS,
    );
    upsertEntityIndex(id, type, configPath, hash, now);

    // 索引子话题
    let topicLen = 0;
    if (Array.isArray(config.topics)) {
      topicLen = config.topics.length;
      for (const topic of config.topics) {
        if (topic.id === "default") continue;
        const topicHash = computeDtoHash(
          topic,
          type === "group" ? GROUP_TOPIC_SYNC_FIELDS : AGENT_TOPIC_SYNC_FIELDS,
        );
        upsertEntityIndex(topic.id, "topic", configPath, topicHash, now);
      }
    }

    // V2: 触发层级冒泡
    computeAggregatedHashes(db, logger);

    logger.logOperation("watcher", type, id, "success", `hash updated, topics=${topicLen}`);
  } catch (e) {
    logger.logOperation("watcher", type, configPath, "error", e.message);
  }
}

module.exports = {
  registerRoutes,
  computeAggregatedHashes,
};
