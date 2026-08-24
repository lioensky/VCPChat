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
  isHistorySourceCurrent,
} = require("./core/db");
const {
  computeBinaryHash,
  computeDtoHash,
  computeAggregatedHash,
  computeTopicLeafHash,
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
const { handleSyncMessageDiffBatch } = require("./sync/diff");
const { ingestHistoryToDb, readHistoryStrict, markHistoryTopicUnhealthy } = require("./sync/message");
const { createCentralSyncAdapter } = require("./sync/central");
const {
  isWriteLocked,
  repairTopicProjectionsFromDisk,
  reconcileMissingPhysicalIndexes,
  sanitizeId,
  deleteEntity,
  deleteMessage,
} = require("./sync/entity");
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

  // 仅在配置不可恢复时才用历史目录重建 Topic；有效的空列表保持不变。
  await repairTopicProjectionsFromDisk(appDataPath);

  // 中央模式不再打开持久化 Legacy 索引。保留一个仅服务于附件、头像和
  // 配置 DTO 文件定位的进程内目录；消息索引、墓碑与历史指纹绝不写入其中。
  if (centralSync) {
    initDb(":memory:");
    // CDS 会在 READY 后自行启动一次 reconcile；若它已持有锁，启动门禁就
    // 继续等待同一既有动作完成。只有非 SERVICE_BUSY 的真实失败才终止注册，
    // 因而 CDS 缺席或索引失败时不会提前开放 MobileSync 端口。
    await centralSync.reconcile({ maxAttempts: Number.POSITIVE_INFINITY });
    centralSync.logEnabled();
    await reconcileCompatibilityAssets(appDataPath);
  } else {
    // 复合身份索引与旧裸 ID 索引不兼容，直接使用新的派生索引库重建。
    const dbPath = path.join(__dirname, "sync_state_v2.db");
    initDb(dbPath);
    await reconcileLocalFiles(appDataPath);
  }

  // 启动 WebSocket（仅在索引完成后开放，防止手机端提前连接）
  await startWsServer({
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
        case "SYNC_TOPIC_HASH_BATCH_V2": {
          const topicCount = Array.isArray(payload.topics) ? payload.topics.length : 0;
          logger.logOperation("websocket", "message", payload.type, "info", `topics=${topicCount}`);
          if (centralSync) {
            return centralSync.handleTopicHashBatch(payload);
          }
          const { handleSyncTopicHashBatchV2 } = require("./sync/diff");
          return handleSyncTopicHashBatchV2(payload);
        }
        case "SYNC_MESSAGE_DIFF_BATCH": {
          const topicCount = Array.isArray(payload.topics) ? payload.topics.length : 0;
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
        case "VERSION_CHECK": {
          const manifest = require("./plugin-manifest.json");
          logger.logOperation("websocket", "version_check", "mobile", "info", `mobileVersion=${payload.mobileVersion}, pluginVersion=${manifest.version}`);
          return createVersionAck(payload, manifest.version);
        }
        case "SYNC_ENTITY_DELETE": {
          const {
            id: rawId,
            dataType,
            topicId,
            ownerType: rawOwnerType,
            ownerId: rawOwnerId,
          } = payload;
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

          const isTopicDelete = [
            "topic",
            "agent_topic",
            "group_topic",
          ].includes(dataType);
          if (
            isTopicDelete &&
            (
              !["agent", "group"].includes(rawOwnerType) ||
              typeof rawOwnerId !== "string" ||
              rawOwnerId.length === 0 ||
              sanitizeId(rawOwnerId) !== rawOwnerId ||
              (dataType === "agent_topic" && rawOwnerType !== "agent") ||
              (dataType === "group_topic" && rawOwnerType !== "group")
            )
          ) {
            const error = new Error(
              "Topic delete ownerType/ownerId must be a complete valid identity",
            );
            error.code = "SYNC_DELETE_INVALID";
            throw error;
          }
          const entityDeleteContext = {
            code: "SYNC_DELETE_FAILED",
            stage: isTopicDelete ? "topic_metadata" : "owner_metadata",
            failedTopicIds: isTopicDelete ? [safeId] : [],
          };

          if (centralSync) {
            if (dataType === "message") {
              if (
                typeof topicId !== "string" ||
                !sanitizeId(topicId) ||
                sanitizeId(topicId) !== topicId ||
                !["agent", "group"].includes(rawOwnerType) ||
                typeof rawOwnerId !== "string" ||
                sanitizeId(rawOwnerId) !== rawOwnerId
              ) {
                const error = new Error(
                  "Message delete requires a non-empty topicId",
                );
                error.code = "SYNC_DELETE_INVALID";
                throw error;
              }
              await centralSync.deleteMessage({
                topicId: sanitizeId(topicId),
                ownerType: rawOwnerType,
                ownerId: rawOwnerId,
                msgId: safeId,
                deletedAt,
              });
            } else {
              const result = await deleteEntity({
                id: safeId,
                type: dataType,
                ownerType: isTopicDelete ? rawOwnerType : avatarOwnerType,
                ownerId: isTopicDelete ? rawOwnerId : null,
                deletedAt,
                appDataPath,
              });
              if (!result?.success) {
                throw withSyncErrorContext(
                  result?.error || "entity delete failed",
                  entityDeleteContext,
                );
              }
              if (dataType !== "avatar") {
                await centralSync.deleteEntityTombstone({
                  dataType: isTopicDelete ? "topic" : dataType,
                  id: safeId,
                  deletedAt,
                  ...(isTopicDelete
                    ? {
                        ownerType: result.ownerType,
                        ownerId: result.ownerId,
                      }
                  : {}),
                });
              }
            }
            return { type: "SYNC_ACK", id: safeId };
          }

          if (dataType === "message") {
            const safeTopicId = sanitizeId(topicId);
            if (
              !safeTopicId ||
              safeTopicId !== topicId ||
              !["agent", "group"].includes(rawOwnerType) ||
              typeof rawOwnerId !== "string" ||
              sanitizeId(rawOwnerId) !== rawOwnerId
            ) {
              const error = new Error("Message delete requires a non-empty topicId");
              error.code = "SYNC_DELETE_INVALID";
              throw error;
            }
            const result = await deleteMessage({
              msgId: safeId,
              deletedAt,
              topicId: safeTopicId,
              ownerType: rawOwnerType,
              ownerId: rawOwnerId,
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
                entityDeleteContext,
              );
            }
            logger.logOperation("websocket", "delete_notify", rawId, "success", "type=avatar");
          } else {
            const result = await deleteEntity({
              id: safeId,
              type: dataType,
              ownerType: isTopicDelete ? rawOwnerType : null,
              ownerId: isTopicDelete ? rawOwnerId : null,
              deletedAt,
              appDataPath,
            });
            if (!result?.success) {
              throw withSyncErrorContext(
                result?.error || "entity delete failed",
                entityDeleteContext,
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
  let historyChangedCount = 0;
  let historySkippedCount = 0;
  let legacyAttachmentWarningCount = 0;

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

  // 4. 增量扫描历史记录。未变化文件只做 stat，不读取和解析正文。
  const historyResult = await scanHistory(userDataDir, db, logger);
  messageCount = historyResult.messageCount;
  historyChangedCount = historyResult.changedCount;
  historySkippedCount = historyResult.skippedCount;
  legacyAttachmentWarningCount = historyResult.warningCount;

  // 5. 以扫描结束时的物理树清理 stale live 索引，闭合删除中断窗口。
  const deleted = await reconcileMissingPhysicalIndexes(appDataPath);

  // 6. 计算层级聚合指纹
  const aggregatedCount = computeAggregatedHashes(db, logger);

  if (legacyAttachmentWarningCount > 0) {
    logger.logOperation(
      "reconcile",
      "legacy_attachment_summary",
      "history",
      "warn",
      `attachments=${legacyAttachmentWarningCount} topics=${historyResult.warningTopicCount}; 旧附件缺少有效或一致的 SHA-256，同步投影已忽略，原始 history.json 未修改`,
    );
  }
  logger.logOperation(
    "reconcile",
    "summary",
    "reconcile",
    "success",
    `agents=${agentCount} groups=${groupCount} topics=${topicCount} changedHistories=${historyChangedCount} skippedHistories=${historySkippedCount} indexedMessages=${messageCount} attachments=${attachmentCount} staleOwners=${deleted.ownersDeleted} staleTopics=${deleted.topicsDeleted} staleMessages=${deleted.messagesDeleted} aggregated=${aggregatedCount}`,
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
      const id = entry.name;

      // 索引主实体 (V2: 使用 DTO 提取以对齐默认值处理)
      const dto = type === "agent" ? extractAgentDTO(config) : extractGroupDTO(config);
      const hash = computeDtoHash(
        dto,
        type === "agent" ? AGENT_SYNC_FIELDS : GROUP_SYNC_FIELDS,
      );
      upsertEntityIndex({
        id,
        type,
        ownerType: type,
        ownerId: id,
        filePath: configPath,
        hash,
        updatedAt: now,
      });
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
          const topicDto = extractTopicDTO(topic, id, type);
          const topicHash = computeDtoHash(
            topicDto,
            type === "group"
              ? GROUP_TOPIC_SYNC_FIELDS
              : AGENT_TOPIC_SYNC_FIELDS,
          );
          upsertEntityIndex({
            id: topic.id,
            type: "topic",
            ownerType: type,
            ownerId: id,
            filePath: configPath,
            hash: topicHash,
            updatedAt: now,
          });
        }
      }
    } catch (error) {
      // 条目级降级：单个实体 config 损坏不应中止整个 reconcile；
      // 该实体缺席索引后，其磁盘历史目录会在 scanHistory 按孤儿话题跳过
      logger.logOperation("reconcile", type, entry.name, "error", error.message);
      continue;
    }
  }
  return { count, topicCount };
}

/**
 * 增量扫描历史记录。
 *
 * history_source_state 保存最近一次成功摄取的 mtime + size。二者未变化时
 * 不再读取 history.json；变化文件只读取一次，并把快照传给摄取函数复用。
 */
async function scanHistory(userDataDir, db, logger) {
  const result = {
    messageCount: 0,
    changedCount: 0,
    skippedCount: 0,
    warningCount: 0,
    warningTopicCount: 0,
  };
  const ownerTypes = new Map();
  for (const owner of db
    .prepare(
      `SELECT owner_type, owner_id FROM entity_index
       WHERE (type = 'agent' OR type = 'group') AND deleted_at IS NULL`,
    )
    .all()) {
    if (!ownerTypes.has(owner.owner_id)) ownerTypes.set(owner.owner_id, []);
    ownerTypes.get(owner.owner_id).push(owner.owner_type);
  }
  let visitedCount = 0;
  let entries;
  try {
    entries = await fs.readdir(userDataDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SYSTEM_FOLDERS.includes(entry.name)) continue;
    const ownerId = entry.name;
    const matchingOwnerTypes = ownerTypes.get(ownerId) || [];
    const ownerType = matchingOwnerTypes.length === 1
      ? matchingOwnerTypes[0]
      : null;

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
      const topicId = topicEntry.name;
      const historyPath = path.join(topicsDir, topicId, "history.json");
      try {
        if (!ownerType) {
          throw new Error(
            matchingOwnerTypes.length === 0
              ? `History owner ${ownerId} has no live Agent or Group index`
              : `Physical history owner ${ownerId} is ambiguous between Agent and Group`,
          );
        }
        const sourceStats = await fs.stat(historyPath);
        if (!sourceStats.isFile()) continue;
        if (
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

        const { history } = await readHistoryStrict(historyPath);
        const ingestResult = await ingestHistoryToDb(
          historyPath,
          { topicId, ownerType, ownerId },
          "reconcile",
          { history, sourceStats },
        );
        result.changedCount += 1;
        result.messageCount += ingestResult.messageCount;
        result.warningCount += ingestResult.warningCount;
        if (ingestResult.warningCount > 0) {
          result.warningTopicCount += 1;
        }
      } catch (error) {
        if (error.code === "ENOENT") {
          result.skippedCount += 1;
          continue;
        }
        // 条目级降级：孤儿话题、损坏 JSON 等单话题故障不应中止整批。
        // 失败时不更新 history_source_state，保证后续启动仍会重试。
        for (const candidateOwnerType of matchingOwnerTypes) {
          markHistoryTopicUnhealthy(
            { topicId, ownerType: candidateOwnerType, ownerId },
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
  }
  return result;
}

/**
 * 计算层级聚合指纹
 */
function computeAggregatedHashes(db, logger) {
  let updatedCount = 0;
  const emptyContentHash = computeAggregatedHash([]);
  const entities = db
    .prepare(
      `SELECT id, type, owner_type, owner_id, hash, aggregated_hash, file_path
       FROM entity_index WHERE deleted_at IS NULL`,
    )
    .all();

  // 1. 预加载所有 Topic 并按 Parent ID 分组，消除 N+1 查询
  const topicMap = new Map(); // Map<ownerKey, Array<{hash, aggregated_hash}>>
  entities
    .filter(
      (e) => e.type === "topic",
    )
    .forEach((t) => {
      const ownerKey = `${t.owner_type}\0${t.owner_id}`;
      if (!topicMap.has(ownerKey)) topicMap.set(ownerKey, []);
      topicMap.get(ownerKey).push(t);
    });

  // 2. 为 Agent 和 Group 计算聚合指纹 (V2: 聚合子话题的 config_hash 和 content_hash)
  for (const e of entities) {
    if (e.type === "agent" || e.type === "group") {
      const topicsOfEntity = topicMap.get(`${e.owner_type}\0${e.owner_id}`) || [];

      const childHashes = topicsOfEntity.map((topic) =>
        computeTopicLeafHash(
          topic.id,
          topic.hash,
          topic.aggregated_hash || emptyContentHash,
        ),
      );
      const rootHash = computeAggregatedHash(childHashes);

      if (rootHash !== e.aggregated_hash) {
        db.prepare(
          `UPDATE entity_index SET aggregated_hash = ?
           WHERE type = ? AND owner_type = ? AND owner_id = ? AND id = ?`,
        ).run(rootHash, e.type, e.owner_type, e.owner_id, e.id);
        updatedCount++;
      }
    }
  }

  // 3. 兜底：为所有缺失 aggregated_hash 的 topic 写入标准空聚合值 (V2: 对齐手机端 computeAggregatedHash([]))
  const nullTopics = entities.filter(
    (e) =>
      e.type === "topic" &&
      (e.aggregated_hash === null || e.aggregated_hash === ""),
  );
  if (nullTopics.length > 0) {
    for (const t of nullTopics) {
      if (t.aggregated_hash !== emptyContentHash) {
        db.prepare(
          `UPDATE entity_index SET aggregated_hash = ?
           WHERE type = 'topic' AND owner_type = ? AND owner_id = ? AND id = ?`,
        ).run(emptyContentHash, t.owner_type, t.owner_id, t.id);
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
            const owners = getDb()
              .prepare(
                `SELECT owner_type FROM entity_index
                 WHERE owner_id = ? AND (type = 'agent' OR type = 'group')
                   AND deleted_at IS NULL`,
              )
              .all(ownerId);
            if (
              owners.length === 1 &&
              isWriteLocked({
                id: topicId,
                type: "topic",
                ownerType: owners[0].owner_type,
                ownerId,
              })
            ) {
              return;
            }
          }
          const deleted = await reconcileMissingPhysicalIndexes(appDataPath);
          computeAggregatedHashes(getDb(), logger);
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
        // 只有 Agents 或 AgentGroups 目录下的 config.json 才作为实体索引
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
            const ownerCount = getDb()
              .prepare(
                `SELECT COUNT(*) AS n FROM entity_index
                 WHERE owner_id = ? AND (type = 'agent' OR type = 'group')
                   AND deleted_at IS NULL`,
              )
              .get(id).n;
            if (ownerCount === 1) {
              for (const topic of newTopics) {
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
                }
              }
            }
          }
        }
      } else if (isHistory) {
        const ownerId = sanitizeId(getHistoryOwnerIdFromPath(filePath));
        const owners = ownerId
          ? getDb()
              .prepare(
                `SELECT owner_type FROM entity_index
                 WHERE owner_id = ? AND (type = 'agent' OR type = 'group')
                   AND deleted_at IS NULL`,
              )
              .all(ownerId)
          : [];
        if (owners.length !== 1) {
          const error = new Error(
            `History owner ${ownerId || "unknown"} is ${owners.length === 0 ? "missing" : "ambiguous"}`,
          );
          for (const owner of owners) {
            markHistoryTopicUnhealthy(
              { topicId: id, ownerType: owner.owner_type, ownerId },
              error,
            );
          }
          throw error;
        }
        const ownerType = owners[0].owner_type;
        if (isWriteLocked({
          id,
          type: "topic",
          ownerType,
          ownerId,
        })) {
          return;
        }
        let topic = getEntityIndex({
          id,
          type: "topic",
          ownerType,
          ownerId,
        });
        if (!topic || topic.deleted_at !== null) {
          const ownerRoot = ownerType === "group" ? "AgentGroups" : "Agents";
          await ingestConfigToDb(
            path.join(appDataPath, ownerRoot, ownerId, "config.json"),
            ownerType,
            appDataPath,
          );
          topic = getEntityIndex({
            id,
            type: "topic",
            ownerType,
            ownerId,
          });
        }
        if (!topic || topic.deleted_at !== null) {
          throw new Error(
            `History topic ${ownerType}/${ownerId}/${id} has no live config index`,
          );
        }
        logger.logOperation("watcher", "file", id, "info", `${event}: ${filePath}`);
        await ingestHistoryToDb(filePath, {
          topicId: id,
          ownerType,
          ownerId,
        });
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
  const db = getDb();
  if (!db) return [];

  const logger = getLogger();
  const newTopics = [];

  try {
    const content = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(content);
    const now = Date.now();
    const id = path.basename(path.dirname(configPath));
    const ownerId = path.basename(path.dirname(configPath));
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

    // 索引主实体
    const dto = type === "agent" ? extractAgentDTO(config) : extractGroupDTO(config);
    const hash = computeDtoHash(
      dto,
      type === "agent" ? AGENT_SYNC_FIELDS : GROUP_SYNC_FIELDS,
    );
    upsertEntityIndex({
      id,
      type,
      ownerType: type,
      ownerId: id,
      filePath: configPath,
      hash,
      updatedAt: now,
    });

    // 索引子话题
    let topicLen = 0;
    if (Array.isArray(config.topics)) {
      topicLen = config.topics.length;
      for (const topic of config.topics) {
        if (sanitizeId(topic.id) !== topic.id) {
          continue;
        }
        const topicDto = extractTopicDTO(topic, id, type);
        const topicHash = computeDtoHash(
          topicDto,
          type === "group" ? GROUP_TOPIC_SYNC_FIELDS : AGENT_TOPIC_SYNC_FIELDS,
        );
        const previous = getEntityIndex({
          id: topic.id,
          type: "topic",
          ownerType: type,
          ownerId: id,
        });
        upsertEntityIndex({
          id: topic.id,
          type: "topic",
          ownerType: type,
          ownerId: id,
          filePath: configPath,
          hash: topicHash,
          updatedAt: now,
        });
        if (
          (!previous || previous.deleted_at !== null) &&
          physicalTopics.has(topic.id)
        ) {
          const historyPath = path.join(topicsDir, topic.id, "history.json");
          try {
            if ((await fs.stat(historyPath)).isFile()) {
              newTopics.push({
                topicId: topic.id,
                ownerType: type,
                ownerId: id,
                historyPath,
              });
            }
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
      }
    }

    // 配置中的空 Topic 也属于 live；同时收敛此前漏掉的删除事件。
    await reconcileMissingPhysicalIndexes(appDataPath, null, db, now);

    // V2: 触发层级冒泡
    computeAggregatedHashes(db, logger);

    logger.logOperation("watcher", type, id, "success", `hash updated, topics=${topicLen}`);
    return newTopics;
  } catch (e) {
    logger.logOperation("watcher", type, configPath, "error", e.message);
    return [];
  }
}

module.exports = {
  registerRoutes,
  computeAggregatedHashes,
  ingestConfigToDb,
};
