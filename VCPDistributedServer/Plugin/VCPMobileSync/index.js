/**
 * 主入口 - 模块化同步插件
 */

const fs = require("fs").promises;
const path = require("path");
const {
  initDb,
  getDb,
  getOwnerState,
  getTopicState,
  upsertOwnerState,
  upsertTopicState,
  upsertAttachmentIndex,
  upsertAvatarIndex,
  softDeleteAvatarIndex,
  getHistorySourceState,
  isHistorySourceCurrent,
  refreshOwnerContentHash,
  refreshAllOwnerContentHashes,
} = require("./core/db");
const {
  computeBinaryHash,
  computeDtoHash,
} = require("./core/hash");
const {
  startWsServer,
} = require("./transport/websocket");
const {
  registerRoutes: registerHttpRoutes,
} = require("./transport/routes");
const {
  handleSyncManifest,
} = require("./sync/manifest");
const { handleSyncMessageDiff, handleSyncTopicDiff } = require("./sync/diff");
const {
  ingestHistoryToDb,
  readHistoryStrict,
  markHistoryTopicUnhealthy,
  isHistoryTopicUnhealthy,
  clearHistoryTopicUnhealthy,
} = require("./sync/message");
const { createCentralSyncAdapter } = require("./sync/central");
const {
  isWriteLocked,
  scanPhysicalTopicTree,
  repairTopicProjectionsFromDisk,
  reconcileMissingPhysicalIndexes,
  sanitizeId,
  deleteEntity,
  deleteMessage,
} = require("./sync/entity");
const { getLogger, resetLogger } = require("./core/logger");
const { createPhaseAck, createVersionAck } = require("./protocol");
const { withSyncErrorContext } = require("./error-contract");
const { acquireLock } = require("./utils/lock");
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
const AVATAR_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
// Legacy config 损坏只影响当前进程中的该 Owner：保留最后一次提交索引，
// 但本轮 Manifest 不对其做 Pull/Push/Delete，避免旧状态冒充有效物理配置。
const unhealthyLegacyOwners = new Set();

try {
  chokidar = require("chokidar");
} catch {}

/**
 * 注册插件
 */
async function registerRoutes(app, pluginConfig, projectBasePath, services = {}) {
  const syncToken = pluginConfig.MobileSyncToken;
  if (typeof syncToken !== "string" || syncToken.trim().length === 0) {
    throw new Error("MobileSyncToken must be configured before starting VCPMobileSync");
  }
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

  const centralSync = centralRequested
    ? createCentralSyncAdapter({
        chatDataService: services.chatDataService ?? { client: null },
        appDataPath,
      })
    : null;

  const logger = resetLogger();
  logger.startSession("system");

  // 中央模式不再打开持久化 Legacy 索引。保留一个仅服务于附件、头像和
  // 配置 DTO 文件定位的进程内目录；消息索引、墓碑与历史指纹绝不写入其中。
  if (centralSync) {
    centralSync.requireClient();
    const physicalOwners = await scanPhysicalTopicTree(appDataPath);
    await repairTopicProjectionsFromDisk(
      appDataPath,
      physicalOwners,
      (request) => centralSync.loadTopicRecoveryStates(request),
    );
    initDb(":memory:");
    // CDS 在 READY 后自行完成启动 reconcile。MobileSync 的真实一致性门禁
    // 位于 owner_metadata PHASE_START；这里不再紧跟着重复扫描同一份 AppData。
    centralSync.logEnabled();
    await reconcileCompatibilityAssets(appDataPath, physicalOwners);
  } else {
    // 复合身份索引与旧裸 ID 索引不兼容，直接使用新的派生索引库重建。
    const dbPath = path.join(__dirname, "sync_state_v2.db");
    initDb(dbPath);
    const physicalOwners = await scanPhysicalTopicTree(appDataPath);
    await repairTopicProjectionsFromDisk(appDataPath, physicalOwners);
    await reconcileLocalFiles(appDataPath, physicalOwners);
  }

  // 启动 WebSocket（仅在索引完成后开放，防止手机端提前连接）
  await startWsServer({
    port: wsPort,
    syncToken,
    onMessage: async (payload) => {
      const logger = getLogger();

      switch (payload.type) {
        case "SYNC_MANIFEST_REQUEST": {
          logger.logOperation("websocket", "message", payload.type, "info", `manifestType=${payload.manifestType}`);

          if (payload.manifestType === "avatar" && !centralSync) {
            await reconcileAvatarFiles(appDataPath);
          }

          if (centralSync) {
            return centralSync.handleSyncManifest(payload);
          }
          const response = handleSyncManifest(payload);
          if (
            ["owner", "avatar"].includes(payload.manifestType) &&
            unhealthyLegacyOwners.size > 0
          ) {
            const before = response.results.length;
            response.results = response.results.filter(
              (item) => !unhealthyLegacyOwners.has(`${item.ownerType}\0${item.ownerId}`),
            );
            const skipped = before - response.results.length;
            if (skipped > 0) {
              logger.logInfo(
                "owner_metadata",
                `本轮已跳过 ${skipped} 个损坏 Owner 的同步动作`,
                "warn",
              );
            }
          }
          return response;
        }
        case "SYNC_TOPIC_DIFF_REQUEST": {
          const topicCount = Array.isArray(payload.topics) ? payload.topics.length : 0;
          logger.logOperation("websocket", "message", payload.type, "info", `topics=${topicCount}`);
          if (centralSync) {
            return centralSync.handleTopicDiff(payload);
          }
          return handleSyncTopicDiff(payload);
        }
        case "SYNC_MESSAGE_DIFF_REQUEST": {
          const topicCount = Array.isArray(payload.topics) ? payload.topics.length : 0;
          logger.logOperation("websocket", "message", payload.type, "info", `topics=${topicCount}`);
          return centralSync
            ? centralSync.handleMessageDiff(payload)
            : handleSyncMessageDiff(payload);
        }
        case "PHASE_START": {
          const ack = createPhaseAck(payload);
          const phase = ack.phase;
          logger.startPhase(phase, 0);

          // Mobile 会在首批 Owner Manifest 前发送 owner_metadata PHASE_START。
          // WebSocket 的单一 messageChain 会让后续帧等待此处完成，因此在 ACK
          // 前刷新 CDS，后续 Manifest 只能读取已经观察到桌面业务写入的提交视图。
          if (centralSync && phase === "owner_metadata") {
            try {
              await centralSync.reconcile();
            } catch (error) {
              throw withSyncErrorContext(error, {
                origin: "desktop_cds",
                stage: "owner_metadata",
              });
            }
          } else if (!centralSync && phase === "owner_metadata") {
            try {
              const stats = await refreshLegacyCommitView(appDataPath);
              logger.logOperation(
                "owner_metadata",
                "pre_manifest_reconcile",
                "legacy",
                "success",
                `agents=${stats.agentCount} groups=${stats.groupCount} topics=${stats.topicCount} changedHistories=${stats.historyChangedCount} skippedHistories=${stats.historySkippedCount} staleOwners=${stats.deleted.ownersDeleted} staleTopics=${stats.deleted.topicsDeleted} staleMessages=${stats.deleted.messagesDeleted}`,
              );
            } catch (error) {
              throw withSyncErrorContext(error, {
                origin: "desktop_plugin",
                stage: "owner_metadata",
              });
            }
          }

          return ack;
        }
        case "PHASE_COMPLETED": {
          const ack = createPhaseAck(payload, { echoFinalIdentity: true });
          const phase = ack.phase;
          logger.completePhase(phase);
          return ack;
        }
        case "VERSION_CHECK": {
          const manifest = require("./plugin-manifest.json");
          logger.logOperation("websocket", "version_check", "mobile", "info", `mobileVersion=${payload.mobileVersion}, pluginVersion=${manifest.version}`);
          return createVersionAck(payload, manifest.version);
        }
        case "SYNC_ENTITY_DELETE": {
          const {
            targetType,
            topicId,
            msgId,
            ownerType,
            ownerId,
            deletedAt,
          } = payload;
          const validOwnerType = targetType === "avatar"
            ? ["agent", "group", "user"].includes(ownerType)
            : ["agent", "group"].includes(ownerType);
          if (
            !["owner", "topic", "avatar", "message"].includes(targetType) ||
            !validOwnerType ||
            typeof ownerId !== "string" ||
            !ownerId ||
            sanitizeId(ownerId) !== ownerId ||
            (ownerType === "user" && ownerId !== "user_avatar") ||
            !Number.isSafeInteger(deletedAt) ||
            deletedAt < 0
          ) {
            const error = new Error(
              "SYNC_ENTITY_DELETE requires targetType, full owner identity and deletedAt",
            );
            error.code = "SYNC_DELETE_INVALID";
            throw error;
          }
          const isTopicDelete = targetType === "topic";
          const isMessageDelete = targetType === "message";
          if (
            (isTopicDelete || isMessageDelete) &&
            (typeof topicId !== "string" || !topicId || sanitizeId(topicId) !== topicId)
          ) {
            const error = new Error(
              "Topic and message deletion require a complete topic identity",
            );
            error.code = "SYNC_DELETE_INVALID";
            throw error;
          }
          if (
            isMessageDelete &&
            (typeof msgId !== "string" || !msgId || sanitizeId(msgId) !== msgId)
          ) {
            const error = new Error("Message deletion requires a valid msgId");
            error.code = "SYNC_DELETE_INVALID";
            throw error;
          }
          const entityDeleteContext = {
            code: "SYNC_DELETE_FAILED",
            stage: isMessageDelete
              ? "messages"
              : isTopicDelete
                ? "topic_metadata"
                : "owner_metadata",
            failedTopicIds: isTopicDelete || isMessageDelete ? [topicId] : [],
          };

          if (centralSync) {
            if (isMessageDelete) {
              await centralSync.deleteMessage({
                topicId,
                ownerType,
                ownerId,
                msgId,
                deletedAt,
              });
            } else {
              const physicalType = targetType === "owner" ? ownerType : targetType;
              const result = await deleteEntity({
                id: isTopicDelete ? topicId : ownerId,
                type: physicalType,
                ownerType: isTopicDelete || targetType === "avatar" ? ownerType : null,
                ownerId: isTopicDelete ? ownerId : null,
                deletedAt,
                appDataPath,
                persistAvatarIndex: false,
              });
              if (!result?.success) {
                throw withSyncErrorContext(
                  result?.error || "entity delete failed",
                  entityDeleteContext,
                );
              }
              await centralSync.deleteEntityTombstone({
                targetType,
                ownerType: isTopicDelete ? result.ownerType : ownerType,
                ownerId: isTopicDelete ? result.ownerId : ownerId,
                ...(isTopicDelete ? { topicId } : {}),
                deletedAt,
              });
            }
            return null;
          }

          if (isMessageDelete) {
            const result = await deleteMessage({
              msgId,
              deletedAt,
              topicId,
              ownerType,
              ownerId,
              appDataPath,
            });
            if (!result?.success) {
              throw withSyncErrorContext(
                  result?.error || "message delete failed",
                  {
                    code: "SYNC_DELETE_FAILED",
                    stage: "messages",
                    failedTopicIds: [topicId],
                  },
                );
            }
            logger.logOperation("websocket", "delete_notify", msgId, "success", "type=message");
          } else if (targetType === "avatar") {
            const result = await deleteEntity({
              id: ownerId,
              type: "avatar",
              ownerType,
              deletedAt,
              appDataPath,
            });
            if (!result?.success) {
              throw withSyncErrorContext(
                result?.error || "avatar delete failed",
                entityDeleteContext,
              );
            }
            logger.logOperation("websocket", "delete_notify", ownerId, "success", "type=avatar");
          } else {
            const physicalType = targetType === "owner" ? ownerType : "topic";
            const result = await deleteEntity({
              id: isTopicDelete ? topicId : ownerId,
              type: physicalType,
              ownerType: isTopicDelete ? ownerType : null,
              ownerId: isTopicDelete ? ownerId : null,
              deletedAt,
              appDataPath,
            });
            if (!result?.success) {
              throw withSyncErrorContext(
                result?.error || "entity delete failed",
                entityDeleteContext,
              );
            }
            logger.logOperation(
              "websocket",
              "delete_notify",
              isTopicDelete ? topicId : ownerId,
              "success",
              `type=${targetType}`,
            );
          }

          return null;
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
}

/**
 * 中央模式兼容目录：只定位配置 DTO 和本机附件文件。
 * history.json、消息提交状态、消息墓碑和 Topic 内容 Hash 全部由 CDS 负责。
 */
async function reconcileCompatibilityAssets(appDataPath, physicalOwners = null) {
  const db = getDb();
  if (!db) return;

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
      upsertAttachmentIndex(hash, filePath);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await refreshCompatibilityOwners(appDataPath, now, physicalOwners);
}

async function refreshCompatibilityOwners(
  appDataPath,
  updatedAt = Date.now(),
  physicalOwners = null,
) {
  const db = getDb();
  if (!db) throw new Error("Database not initialized");
  const logger = getLogger();
  await scanEntities(
    path.join(appDataPath, "Agents"),
    "agent",
    db,
    updatedAt,
    appDataPath,
    logger,
    physicalOwners,
  );
  await scanEntities(
    path.join(appDataPath, "AgentGroups"),
    "group",
    db,
    updatedAt,
    appDataPath,
    logger,
    physicalOwners,
  );
}

async function reconcileAvatarFiles(appDataPath, updatedAt = Date.now()) {
  const database = getDb();
  if (!database) throw new Error("Avatar database not initialized");

  const physicalAvatars = new Set();
  let indexedCount = 0;
  const indexFile = async (ownerType, ownerId, filePath) => {
    const hash = computeBinaryHash(await fs.readFile(filePath));
    upsertAvatarIndex(ownerId, ownerType, filePath, hash, updatedAt);
    physicalAvatars.add(`${ownerType}\0${ownerId}`);
    indexedCount += 1;
  };

  const userAvatarPath = path.join(appDataPath, "UserData", "user_avatar.png");
  try {
    await indexFile("user", "user_avatar", userAvatarPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  for (const [ownerType, rootName] of [
    ["agent", "Agents"],
    ["group", "AgentGroups"],
  ]) {
    const root = path.join(appDataPath, rootName);
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || sanitizeId(entry.name) !== entry.name) continue;
      for (const extension of AVATAR_EXTENSIONS) {
        const avatarPath = path.join(root, entry.name, `avatar${extension}`);
        try {
          await indexFile(ownerType, entry.name, avatarPath);
          break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
  }

  let tombstonedCount = 0;
  const liveRows = database.prepare(
    `SELECT owner_id, owner_type, file_path FROM avatar_index
     WHERE deleted_at IS NULL`,
  ).all();
  for (const row of liveRows) {
    if (physicalAvatars.has(`${row.owner_type}\0${row.owner_id}`)) continue;
    tombstonedCount += softDeleteAvatarIndex(
      row.owner_id,
      row.owner_type,
      updatedAt,
      row.file_path,
    ).changes;
  }

  return { indexedCount, tombstonedCount };
}

async function refreshLegacyCommitView(appDataPath, physicalOwners = null) {
  const db = getDb();
  if (!db) throw new Error("Database not initialized");

  const logger = getLogger();
  const now = Date.now();
  const agentsDir = path.join(appDataPath, "Agents");
  const groupsDir = path.join(appDataPath, "AgentGroups");
  const userDataDir = path.join(appDataPath, "UserData");
  const physical = physicalOwners || await scanPhysicalTopicTree(appDataPath);
  for (const key of unhealthyLegacyOwners) {
    if (!physical.has(key)) unhealthyLegacyOwners.delete(key);
  }

  const agentResult = await scanEntities(
    agentsDir,
    "agent",
    db,
    now,
    appDataPath,
    logger,
    physical,
  );
  const groupResult = await scanEntities(
    groupsDir,
    "group",
    db,
    now,
    appDataPath,
    logger,
    physical,
  );
  const historyResult = await scanHistory(userDataDir, db, logger, physical);
  const deleted = await reconcileMissingPhysicalIndexes(appDataPath, physical);
  refreshAllOwnerContentHashes(db);

  return {
    agentCount: agentResult.count,
    groupCount: groupResult.count,
    topicCount: agentResult.topicCount + groupResult.topicCount,
    messageCount: historyResult.messageCount,
    historyChangedCount: historyResult.changedCount,
    historySkippedCount: historyResult.skippedCount,
    legacyAttachmentWarningCount: historyResult.warningCount,
    legacyAttachmentWarningTopicCount: historyResult.warningTopicCount,
    deleted,
  };
}

/**
 * 扫描本地文件并建立索引
 */
async function reconcileLocalFiles(appDataPath, physicalOwners = null) {
  const db = getDb();
  if (!db) return;

  const logger = getLogger();
  logger.startPhase("reconcile", 0);
  logger.logInfo("reconcile", "正在执行轻量级索引扫描...");

  const userDataDir = path.join(appDataPath, "UserData");
  const attachmentsDir = path.join(userDataDir, "attachments");
  const now = Date.now();

  let attachmentCount = 0;

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

    upsertAttachmentIndex(hash, filePath);
    attachmentCount++;
  }

  // 2. 刷新 Owner/Topic/Message 提交视图；未变化 history 只做 stat。
  const stats = await refreshLegacyCommitView(appDataPath, physicalOwners);

  // 3. Avatar 使用独立持久兼容视图，不混入 Owner/Topic 扫描。
  await reconcileAvatarFiles(appDataPath, now);

  if (stats.legacyAttachmentWarningCount > 0) {
    logger.logOperation(
      "reconcile",
      "legacy_attachment_summary",
      "history",
      "warn",
      `attachments=${stats.legacyAttachmentWarningCount} topics=${stats.legacyAttachmentWarningTopicCount}; 旧附件缺少有效或一致的 SHA-256，同步投影已忽略，原始 history.json 未修改`,
    );
  }
  logger.logOperation(
    "reconcile",
    "summary",
    "reconcile",
    "success",
    `agents=${stats.agentCount} groups=${stats.groupCount} topics=${stats.topicCount} changedHistories=${stats.historyChangedCount} skippedHistories=${stats.historySkippedCount} indexedMessages=${stats.messageCount} attachments=${attachmentCount} staleOwners=${stats.deleted.ownersDeleted} staleTopics=${stats.deleted.topicsDeleted} staleMessages=${stats.deleted.messagesDeleted}`,
  );
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
async function scanEntities(
  baseDir,
  type,
  db,
  now,
  appDataPath,
  logger,
  physicalOwners = null,
) {
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

    const id = entry.name;
    const ownerKey = `${type}\0${id}`;
    const previousOwner = getOwnerState({ ownerType: type, ownerId: id });
    if (previousOwner?.deleted_at != null) {
      unhealthyLegacyOwners.delete(ownerKey);
      continue;
    }

    const entityDir = path.join(baseDir, entry.name);
    const configPath = path.join(entityDir, "config.json");

    let config;
    let hash;
    let physicalTopics;
    try {
      const content = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(content);
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error("Entity config root must be an object");
      }
      // 索引主实体 (V2: 使用 DTO 提取以对齐默认值处理)
      const dto = type === "agent" ? extractAgentDTO(config) : extractGroupDTO(config);
      hash = computeDtoHash(
        dto,
        type === "agent" ? AGENT_SYNC_FIELDS : GROUP_SYNC_FIELDS,
      );
      const topicsDir = path.join(appDataPath, "UserData", id, "topics");
      physicalTopics = physicalOwners
        ?.get(`${type}\0${id}`)
        ?.physicalTopics;
      if (!physicalTopics) {
        let topicEntries = [];
        try {
          topicEntries = await fs.readdir(topicsDir, { withFileTypes: true });
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        physicalTopics = new Set(
          topicEntries
            .filter((topicEntry) => topicEntry.isDirectory())
            .map((topicEntry) => topicEntry.name),
        );
      }
    } catch (error) {
      // 只有当前 Owner 的物理来源不可读时才降级；数据库事务错误必须中止刷新。
      unhealthyLegacyOwners.add(ownerKey);
      logger.logOperation("reconcile", type, entry.name, "error", error.message);
      logger.logInfo(
        "owner_metadata",
        `已跳过损坏的 ${type} Owner：${entry.name}`,
        "warn",
      );
      continue;
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      let indexedTopics = 0;
      upsertOwnerState({
        ownerType: type,
        ownerId: id,
        configPath,
        configHash: hash,
        updatedAt: now,
      });

      if (Array.isArray(config.topics)) {
        for (const topic of config.topics) {
          if (
            sanitizeId(topic?.id) !== topic?.id ||
            !physicalTopics.has(topic.id)
          ) {
            continue;
          }
          const previous = getTopicState({
            ownerType: type,
            ownerId: id,
            topicId: topic.id,
          });
          if (previous?.deleted_at != null) continue;
          const topicDto = extractTopicDTO(topic, id, type);
          const configHash = computeDtoHash(
            topicDto,
            type === "group"
              ? GROUP_TOPIC_SYNC_FIELDS
              : AGENT_TOPIC_SYNC_FIELDS,
          );
          upsertTopicState({
            ownerType: type,
            ownerId: id,
            topicId: topic.id,
            configHash,
            updatedAt: now,
          });
          indexedTopics += 1;
        }
      }
      db.exec("COMMIT");
      unhealthyLegacyOwners.delete(ownerKey);
      count += 1;
      topicCount += indexedTopics;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return { count, topicCount };
}

/**
 * 增量扫描历史记录。
 *
 * history_source_state 先用 mtime + size 跳过未变文件；元数据变化后再用原始
 * SHA-256 排除 touch/等价替换，只有真实 bytes 变化才进入 canonical 摄取。
 */
async function scanHistory(userDataDir, db, logger, physicalOwners = null) {
  const result = {
    messageCount: 0,
    changedCount: 0,
    skippedCount: 0,
    warningCount: 0,
    warningTopicCount: 0,
  };
  const liveOwnerRows = db
    .prepare(
      `SELECT owner_type, owner_id FROM owners WHERE deleted_at IS NULL`,
    )
    .all();
  const liveOwnerKeys = new Set(
    liveOwnerRows.map((owner) => `${owner.owner_type}\0${owner.owner_id}`),
  );
  const sources = [];
  if (physicalOwners) {
    for (const owner of physicalOwners.values()) {
      for (const topicId of owner.physicalTopics) {
        sources.push({
          ownerType: liveOwnerKeys.has(`${owner.ownerType}\0${owner.ownerId}`)
            ? owner.ownerType
            : null,
          ownerId: owner.ownerId,
          topicId,
          historyPath: path.join(
            userDataDir,
            owner.ownerId,
            "topics",
            topicId,
            "history.json",
          ),
        });
      }
    }
  } else {
    const ownerTypes = new Map();
    for (const owner of liveOwnerRows) {
      ownerTypes.set(owner.owner_id, owner.owner_type);
    }
    let entries;
    try {
      entries = await fs.readdir(userDataDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return result;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SYSTEM_FOLDERS.includes(entry.name)) continue;
      const ownerId = entry.name;
      const ownerType = ownerTypes.get(ownerId) || null;
      const topicsDir = path.join(userDataDir, ownerId, "topics");
      let topicFolders;
      try {
        topicFolders = await fs.readdir(topicsDir, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      for (const topicEntry of topicFolders) {
        if (!topicEntry.isDirectory()) continue;
        sources.push({
          ownerType,
          ownerId,
          topicId: topicEntry.name,
          historyPath: path.join(topicsDir, topicEntry.name, "history.json"),
        });
      }
    }
  }
  let visitedCount = 0;
  for (const { ownerType, ownerId, topicId, historyPath } of sources) {
      try {
        if (!ownerType) {
          throw new Error(`History owner ${ownerId} has no live Agent or Group index`);
        }
        const sourceStats = await fs.stat(historyPath);
        if (!sourceStats.isFile()) continue;
        if (
          !isHistoryTopicUnhealthy({ ownerType, ownerId, topicId }) &&
          isHistorySourceCurrent({
            ownerType,
            ownerId,
            topicId,
            filePath: historyPath,
            fileSize: sourceStats.size,
            mtimeMs: sourceStats.mtimeMs,
          })
        ) {
          result.skippedCount += 1;
          continue;
        }

        const { history, sourceHash } = await readHistoryStrict(historyPath);
        const ingestResult = await ingestHistoryToDb(
          historyPath,
          { topicId, ownerType, ownerId },
          "reconcile",
          { history, sourceStats, sourceHash },
        );
        result.changedCount += Number(ingestResult.changed);
        result.skippedCount += Number(!ingestResult.changed);
        result.messageCount += ingestResult.messageCount;
        result.warningCount += ingestResult.warningCount;
        if (ingestResult.warningCount > 0) {
          result.warningTopicCount += 1;
        }
      } catch (error) {
        if (error.code === "ENOENT") {
          const previousSource = ownerType
            ? getHistorySourceState({ ownerType, ownerId, topicId })
            : null;
          if (previousSource) {
            const missingError = new Error(
              `Previously indexed history source is missing: ${historyPath}`,
            );
            markHistoryTopicUnhealthy(
              { topicId, ownerType, ownerId },
              missingError,
            );
            logger.logOperation(
              "reconcile",
              "history",
              topicId,
              "error",
              missingError.message,
            );
          }
          result.skippedCount += 1;
          continue;
        }
        // 条目级降级：孤儿话题、损坏 JSON 等单话题故障不应中止整批。
        // 失败时不更新 history_source_state，保证后续启动仍会重试。
        if (ownerType) {
          markHistoryTopicUnhealthy(
            { topicId, ownerType, ownerId },
            error,
          );
        }
        logger.logOperation("reconcile", "history", topicId, "error", error.message);
      } finally {
        visitedCount += 1;
        // better-sqlite3、JSON 规范化和哈希均运行在 Electron 主线程。
        // 周期性让出事件循环，避免首次全量建表长时间饿死窗口消息。
        if (visitedCount % 25 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
  }
  return result;
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
    if (event === "unlinkDir") {
      const relative = path.relative(appDataPath, filePath);
      const parts = relative.split(path.sep).filter(Boolean);
      const isOwnerDirectory =
        ["Agents", "AgentGroups"].includes(parts[0]) && parts.length === 2;
      const isTopicDirectory =
        parts[0] === "UserData" &&
        (
          parts.length === 2 ||
          (parts[2] === "topics" && [3, 4].includes(parts.length))
        );
      if (
        relative &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative) &&
        (isOwnerDirectory || isTopicDirectory)
      ) {
        try {
          if (
            parts[0] === "UserData" &&
            parts[2] === "topics" &&
            parts.length === 4 &&
            sanitizeId(parts[1]) === parts[1] &&
            sanitizeId(parts[3]) === parts[3]
          ) {
            const ownerId = parts[1];
            const topicId = parts[3];
            const owner = getDb()
              .prepare(
                `SELECT owner_type FROM owners
                 WHERE owner_id = ? AND deleted_at IS NULL`,
              )
              .get(ownerId);
            if (
              owner &&
              isWriteLocked({
                id: topicId,
                type: "topic",
                ownerType: owner.owner_type,
                ownerId,
              })
            ) {
              return;
            }
          }
          const deleted = await reconcileMissingPhysicalIndexes(appDataPath);
          logger.logOperation(
            "watcher",
            "unlinkDir",
            relative,
            "success",
            `owners=${deleted.ownersDeleted} topics=${deleted.topicsDeleted} messages=${deleted.messagesDeleted}`,
          );
        } catch (error) {
          logger.logOperation(
            "watcher",
            "unlinkDir",
            relative,
            "error",
            error.message,
          );
        }
      }
      return;
    }

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
    if (!id) return;

    try {
      if (isConfig) {
        // 只有 Agents 或 AgentGroups 目录下的 config.json 才作为 Owner 提交状态
        if (isAgentPath || isGroupPath) {
          const type = isAgentPath ? "agent" : "group";
          if (isWriteLocked({
            id,
            type,
            ownerType: type,
            ownerId: id,
          })) {
            return;
          }
          logger.logOperation("watcher", "file", id, "info", `${event}: ${filePath}`);
          const newTopics = await ingestConfigToDb(filePath, type, appDataPath);
          if (newTopics.length > 0) {
            for (const topic of newTopics) {
              const release = await acquireLock(topic.historyPath);
              try {
                await ingestHistoryToDb(
                  topic.historyPath,
                  {
                    topicId: topic.topicId,
                    ownerType: topic.ownerType,
                    ownerId: topic.ownerId,
                  },
                );
              } catch {
                // ingestHistoryToDb 已记录并标记精确 Topic 的错误；继续处理同批其他 Topic。
              } finally {
                release();
              }
            }
          }
        }
      } else if (isHistory) {
        const ownerId = sanitizeId(getHistoryOwnerIdFromPath(filePath));
        const owner = ownerId
          ? getDb()
              .prepare(
                `SELECT owner_type FROM owners
                 WHERE owner_id = ? AND deleted_at IS NULL`,
              )
              .get(ownerId)
          : null;
        if (!owner) {
          throw new Error(`History owner ${ownerId || "unknown"} is missing`);
        }
        const ownerType = owner.owner_type;
        if (isWriteLocked({
          id,
          type: "topic",
          ownerType,
          ownerId,
        })) {
          return;
        }
        let topic = getTopicState({
          ownerType,
          ownerId,
          topicId: id,
        });
        if (!topic || topic.deleted_at !== null) {
          const ownerRoot = ownerType === "group" ? "AgentGroups" : "Agents";
          await ingestConfigToDb(
            path.join(appDataPath, ownerRoot, ownerId, "config.json"),
            ownerType,
            appDataPath,
          );
          topic = getTopicState({
            ownerType,
            ownerId,
            topicId: id,
          });
        }
        if (!topic || topic.deleted_at !== null) {
          throw new Error(
            `History topic ${ownerType}/${ownerId}/${id} has no live config index`,
          );
        }
        logger.logOperation("watcher", "file", id, "info", `${event}: ${filePath}`);
        const release = await acquireLock(filePath);
        try {
          await ingestHistoryToDb(filePath, {
            topicId: id,
            ownerType,
            ownerId,
          });
        } finally {
          release();
        }
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

function getHistoryOwnerIdFromPath(filePath) {
  const parts = filePath.split(path.sep);
  const topicIdx = parts.lastIndexOf("topics");
  if (topicIdx > 0 && parts[topicIdx - 1]) {
    return parts[topicIdx - 1];
  }
  return null;
}

/**
 * 摄取配置文件到索引
 */
async function ingestConfigToDb(configPath, type, appDataPath) {
  const release = await acquireLock(configPath);
  try {
    return await ingestConfigToDbUnlocked(configPath, type, appDataPath);
  } finally {
    release();
  }
}

async function ingestConfigToDbUnlocked(configPath, type, appDataPath) {
  const db = getDb();
  if (!db) return [];

  const logger = getLogger();
  const ownerId = path.basename(path.dirname(configPath));
  const ownerKey = `${type}\0${ownerId}`;
  try {
    const content = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(content);
    const now = Date.now();
    const id = path.basename(path.dirname(configPath));
    const topicsDir = path.join(appDataPath, "UserData", ownerId, "topics");
    let topicEntries = [];
    try {
      topicEntries = await fs.readdir(topicsDir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const physicalTopics = new Set(
      topicEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );

    const dto = type === "agent" ? extractAgentDTO(config) : extractGroupDTO(config);
    const ownerConfigHash = computeDtoHash(
      dto,
      type === "agent" ? AGENT_SYNC_FIELDS : GROUP_SYNC_FIELDS,
    );
    const topicUpdates = [];
    if (Array.isArray(config.topics)) {
      for (const topic of config.topics) {
        if (
          sanitizeId(topic?.id) !== topic?.id ||
          !physicalTopics.has(topic.id)
        ) {
          continue;
        }
        const topicDto = extractTopicDTO(topic, id, type);
        const configHash = computeDtoHash(
          topicDto,
          type === "group" ? GROUP_TOPIC_SYNC_FIELDS : AGENT_TOPIC_SYNC_FIELDS,
        );
        topicUpdates.push({ topicId: topic.id, configHash });
      }
    }

    const applyConfigIndex = db.transaction(() => {
      const previousOwner = getOwnerState({ ownerType: type, ownerId });
      if (previousOwner?.deleted_at != null) {
        return { newTopicIds: [], deletedTopicIds: [] };
      }
      if (
        !previousOwner ||
        previousOwner.config_path !== configPath ||
        previousOwner.config_hash !== ownerConfigHash
      ) {
        upsertOwnerState({
          ownerType: type,
          ownerId: id,
          configPath,
          configHash: ownerConfigHash,
          updatedAt: now,
        });
      }

      const existingRows = db
        .prepare(
          `SELECT topic_id, config_hash, deleted_at FROM topics
           WHERE owner_type = ? AND owner_id = ?`,
        )
        .all(type, ownerId);
      const existingById = new Map(
        existingRows.map((row) => [row.topic_id, row]),
      );
      const newTopicIds = [];
      let ownerContentDirty = !previousOwner;
      for (const topic of topicUpdates) {
        const previous = existingById.get(topic.topicId);
        if (previous?.deleted_at != null) continue;
        if (!previous || previous.config_hash !== topic.configHash) {
          upsertTopicState({
            ownerType: type,
            ownerId: id,
            topicId: topic.topicId,
            configHash: topic.configHash,
            updatedAt: now,
          });
          ownerContentDirty = true;
        }
        if (!previous) newTopicIds.push(topic.topicId);
      }

      const deleteTopic = db.prepare(
        `UPDATE topics SET deleted_at = ?
         WHERE owner_type = ? AND owner_id = ? AND topic_id = ?
           AND deleted_at IS NULL`,
      );
      const deleteMessages = db.prepare(
        `UPDATE messages SET deleted_at = ?
         WHERE owner_type = ? AND owner_id = ? AND topic_id = ?
           AND deleted_at IS NULL`,
      );
      const deleteSource = db.prepare(
        `DELETE FROM history_source_state
         WHERE owner_type = ? AND owner_id = ? AND topic_id = ?`,
      );
      const deletedTopicIds = [];
      for (const row of existingRows) {
        if (row.deleted_at !== null || physicalTopics.has(row.topic_id)) continue;
        deleteTopic.run(now, type, ownerId, row.topic_id);
        deleteMessages.run(now, type, ownerId, row.topic_id);
        deleteSource.run(type, ownerId, row.topic_id);
        deletedTopicIds.push(row.topic_id);
        ownerContentDirty = true;
      }
      if (ownerContentDirty) {
        refreshOwnerContentHash({ ownerType: type, ownerId }, db);
      }
      return { newTopicIds, deletedTopicIds };
    });
    const { newTopicIds, deletedTopicIds } = applyConfigIndex();
    for (const topicId of deletedTopicIds) {
      clearHistoryTopicUnhealthy({ topicId, ownerType: type, ownerId });
    }

    const newTopics = [];
    for (const topicId of newTopicIds) {
      const historyPath = path.join(topicsDir, topicId, "history.json");
      try {
        if ((await fs.stat(historyPath)).isFile()) {
          newTopics.push({ topicId, ownerType: type, ownerId: id, historyPath });
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }

    logger.logOperation(
      "watcher",
      type,
      id,
      "success",
      `hash updated, topics=${topicUpdates.length}`,
    );
    unhealthyLegacyOwners.delete(ownerKey);
    return newTopics;
  } catch (e) {
    unhealthyLegacyOwners.add(ownerKey);
    logger.logOperation("watcher", type, configPath, "error", e.message);
    logger.logInfo(
      "owner_metadata",
      `已跳过损坏的 ${type} Owner：${ownerId}`,
      "warn",
    );
    return [];
  }
}

module.exports = {
  registerRoutes,
  ingestConfigToDb,
};
