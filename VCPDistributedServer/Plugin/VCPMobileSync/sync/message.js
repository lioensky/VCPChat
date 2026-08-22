/**
 * 消息历史同步
 */

const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const { TextDecoder } = require("node:util");
const {
  getDb,
  getEntityIndex,
  upsertMessageIndex,
  upsertAttachmentIndex,
  upsertMessageAttachment,
  upsertHistorySourceState,
} = require("../core/db");
const { computeMessageFingerprint, computeAggregatedHash } = require("../core/hash");
const { sanitizeId, writeIntentLock } = require("./entity");
const { getExtensionFromType } = require("../utils/mime");
const { getLogger } = require("../core/logger");
const { acquireLock } = require("../utils/lock");
const { parseJsonWithoutDuplicateKeys } = require("../protocol");
const { canonicalizeHistory } = require("./canonical");
const { projectMobileTopic } = require("./projection");
const {
  createHttpErrorBody,
  createStreamErrorFrame,
  createSyncError,
  normalizeSyncError,
} = require("../error-contract");
const {
  MAX_NDJSON_MESSAGES,
  MAX_NDJSON_TOPICS,
  NdjsonWriter,
  decodeNdjsonLine,
  readNdjsonLines,
} = require("../transport/ndjson");

const unhealthyHistoryTopics = new Map();

function markHistoryTopicUnhealthy(topicId, error) {
  if (typeof topicId === "string" && topicId.length > 0) {
    unhealthyHistoryTopics.set(topicId, String(error?.message || error));
  }
}

function clearHistoryTopicUnhealthy(topicId) {
  unhealthyHistoryTopics.delete(topicId);
}

function assertHistoryTopicHealthy(topicId) {
  const reason = unhealthyHistoryTopics.get(topicId);
  if (reason !== undefined) {
    throw Object.assign(
      new Error(`History source for topic ${topicId} is invalid: ${reason}`),
      { code: "HISTORY_SOURCE_INVALID" },
    );
  }
}

async function readHistoryStrict(filePath) {
  let bytes;
  try {
    bytes = await fs.readFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return { history: [], sourceHash: null };
    throw error;
  }
  let history;
  try {
    history = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`Invalid history JSON: ${error.message}`);
  }
  if (!Array.isArray(history)) {
    throw new Error("Invalid history root: expected an array");
  }
  return {
    history,
    sourceHash: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

async function writeHistoryAtomic(filePath, history, expectedSourceHash) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `${path.basename(filePath)}.mobile-sync-${crypto.randomUUID()}.tmp`,
  );
  const file = await fs.open(temporary, "wx");
  try {
    await file.writeFile(JSON.stringify(history, null, 2), "utf8");
    await file.sync();
  } finally {
    await file.close();
  }

  try {
    let currentHash = null;
    try {
      const current = await fs.readFile(filePath);
      currentHash = crypto.createHash("sha256").update(current).digest("hex");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (currentHash !== expectedSourceHash) {
      throw new Error("History changed concurrently; retry this topic");
    }
    await fs.rename(temporary, filePath);
    if (process.platform !== "win32") {
      const parent = await fs.open(directory, "r");
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
}

/**
 * 流式批量下载消息 (NDJSON) — 对标 Phase 3 万级话题 Pull
 *
 * 一次 HTTP 请求承载多个 topic 的 pull，响应以 NDJSON 逐 topic 分帧。
 * 每个 topic 独立读取 history.json 后立即 flush，手机端逐行消费，
 * 不缓冲整个响应。单 topic 失败只影响自身，不中断流。
 *
 * @param {object[]} requests - [{ topicId, msgIds: string[] }]
 * @param {string} appDataPath - AppData 路径
 * @param {object} res - Express response (用于流式写入)
 */
async function downloadMessagesStreamRaw(requests, appDataPath, res) {
  const logger = getLogger();
  const db = getDb();
  if (!db) {
    res.status(500).json(createHttpErrorBody("Database not initialized", {
      code: "SYNC_DB_UNAVAILABLE",
      stage: "messages",
    }));
    return;
  }
  if (
    !Array.isArray(requests) ||
    requests.length === 0 ||
    requests.some((request) => !request || typeof request !== "object")
  ) {
    throw createSyncError(
      "SYNC_REQUEST_INVALID",
      "Message pull requires non-empty object requests",
      { stage: "messages" },
    );
  }

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");
  res.flushHeaders();

  let successCount = 0;
  let errorCount = 0;

  const writer = new NdjsonWriter(res);
  const seenTopics = new Set();
  let requestedMessages = 0;
  if (requests.length > MAX_NDJSON_TOPICS) {
    throw createSyncError(
      "SYNC_BUDGET_EXCEEDED",
      "Message pull exceeds 10000 topics",
      { stage: "messages" },
    );
  }
  for (const { topicId, ownerType, ownerId, msgIds = [] } of requests) {
    const safeTopicId = sanitizeId(topicId);
    try {
      if (!safeTopicId || safeTopicId !== topicId || seenTopics.has(safeTopicId)) {
        throw createSyncError(
          "SYNC_REQUEST_INVALID",
          "Message pull topic IDs must be non-empty and unique",
          { stage: "messages", failedTopicIds: [topicId] },
        );
      }
      if (
        !Array.isArray(msgIds) ||
        new Set(msgIds).size !== msgIds.length ||
        msgIds.some((id) => typeof id !== "string" || id.length === 0)
      ) {
        throw createSyncError(
          "SYNC_REQUEST_INVALID",
          "Message pull IDs must be non-empty strings and unique",
          { stage: "messages", failedTopicIds: [safeTopicId] },
        );
      }
      if (
        !["agent", "group"].includes(ownerType) ||
        typeof ownerId !== "string" ||
        ownerId.length === 0
      ) {
        throw createSyncError(
          "SYNC_REQUEST_INVALID",
          "Message pull requires exact ownerType and ownerId",
          { stage: "messages", failedTopicIds: [safeTopicId] },
        );
      }
      seenTopics.add(safeTopicId);
      assertHistoryTopicHealthy(safeTopicId);
      requestedMessages += msgIds.length;
      if (msgIds.length > 10_000 || requestedMessages > MAX_NDJSON_MESSAGES) {
        throw createSyncError(
          "SYNC_BUDGET_EXCEEDED",
          "Message pull exceeds message count budget",
          { stage: "messages", failedTopicIds: [safeTopicId] },
        );
      }
      const row = getEntityIndex(safeTopicId, "topic");
      if (!row) {
        await writer.write({
          topicId,
          ownerType,
          ownerId,
          messages: [],
          _error: normalizeSyncError("topic not found", {
            code: "TOPIC_NOT_FOUND",
            stage: "messages",
            failedTopicIds: [safeTopicId],
          }),
        });
        errorCount++;
        continue;
      }

      const parentId = path.basename(path.dirname(row.file_path));
      const actualOwnerType = row.file_path.includes("AgentGroups") ? "group" : "agent";
      if (
        ownerType !== actualOwnerType ||
        ownerId !== parentId
      ) {
        throw createSyncError(
          "SYNC_OWNER_CONFLICT",
          "topic owner identity conflicts with desktop index",
          { stage: "messages", failedTopicIds: [safeTopicId] },
        );
      }
      const historyPath = path.join(
        appDataPath,
        "UserData",
        parentId,
        "topics",
        safeTopicId,
        "history.json",
      );

      const { history } = await readHistoryStrict(historyPath);
      const canonical = canonicalizeHistory(history, safeTopicId);
      if (canonical.topicIdRewrites > 0) {
        getLogger().logInfo(
          "message",
          `topicId 归一化：${safeTopicId} 有 ${canonical.topicIdRewrites} 条消息重写为 frame topic（${canonical.topicIdRewriteSamples.join("; ")}）`,
          "warn",
        );
      }
      const wanted = new Set(msgIds);
      const messages = wanted.size === 0
        ? canonical.frame.messages
        : canonical.frame.messages.filter((message) => wanted.has(message.id));
      if (wanted.size > 0) {
        const actual = new Set(messages.map((message) => message.id));
        if (actual.size !== wanted.size || [...wanted].some((id) => !actual.has(id))) {
          throw createSyncError(
            "SYNC_MESSAGE_READ_FAILED",
            "requested message set is incomplete",
            { stage: "messages", failedTopicIds: [safeTopicId] },
          );
        }
      }
      await writer.write({
        topicId: safeTopicId,
        ownerType: actualOwnerType,
        ownerId: parentId,
        messages,
        ...(canonical.warningCount > 0
          ? {
              legacyAttachmentWarnings: canonical.warningCount,
              warningSamples: canonical.warningSamples,
            }
          : {}),
      });
      if (canonical.warningCount > 0) {
        logger.logOperation(
          "messages",
          "legacy_attachment_warning",
          safeTopicId,
          "warn",
          `count=${canonical.warningCount}`,
        );
      }
      successCount++;
    } catch (e) {
      // 单 topic 失败写错误帧，不中断流
      await writer.write({
        topicId,
        ownerType,
        ownerId,
        messages: [],
        _error: normalizeSyncError(e, {
          code: "SYNC_MESSAGE_READ_FAILED",
          stage: "messages",
          failedTopicIds: [safeTopicId],
        }),
      });
      errorCount++;
    }
  }

  res.end();
  logger.logOperation("messages", "download_messages_stream", "batch", "success",
    `topics=${requests.length} success=${successCount} error=${errorCount}`);
}

/**
 * 单 topic 上传纯逻辑 — 从 uploadMessages 提取（不含幂等性、writeIntentLock、ingestHistoryToDb）
 * 批量场景下由外层统一管理并发控制
 *
 * @param {string} safeTopicId - 已 sanitized 的 topic ID
 * @param {object[]} messages - 消息列表
 * @param {string} appDataPath - AppData 路径
 * @param {object} row - entity_index 行
 * @returns {Promise<{success: boolean, neededAttachmentHashes?: string[], error?: string}>}
 */
async function doUploadSingleTopic(safeTopicId, messages, appDataPath, row) {
  const db = getDb();
  const parentId = path.basename(path.dirname(row.file_path));
  const isGroup = row.file_path.includes("AgentGroups");
  const historyDir = path.join(
    appDataPath,
    "UserData",
    parentId,
    "topics",
    safeTopicId,
  );
  const historyPath = path.join(historyDir, "history.json");

  const release = await acquireLock(historyPath);

  try {
    await fs.mkdir(historyDir, { recursive: true });

    const { history: localHistory, sourceHash } = await readHistoryStrict(historyPath);

    const msgMap = new Map(localHistory.map((m) => [m.id, m]));
    const projected = await projectMobileTopic({
      topicId: safeTopicId,
      ownerType: isGroup ? "group" : "agent",
      ownerId: parentId,
      messages,
      db,
      appDataPath,
    });

    for (const desktopMessage of projected.messages) {
      msgMap.set(desktopMessage.id, desktopMessage);
    }

    const finalHistory = Array.from(msgMap.values()).sort(
      (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
    );

    await writeHistoryAtomic(historyPath, finalHistory, sourceHash);

    return {
      success: true,
      neededAttachmentHashes: projected.neededAttachmentHashes,
      historyPath,
    };
  } finally {
    release();
  }
}

/**
 * 全流式批量上传消息 (NDJSON Request & Response)
 * 解决 10000+ 消息同步时的 OOM 问题
 *
 * @param {object} req - Express request (读取 NDJSON 流)
 * @param {string} appDataPath - AppData 路径
 * @param {object} res - Express response (用于流式写入结果)
 */
async function uploadMessagesBatchRaw(req, appDataPath, res) {
  const logger = getLogger();
  const db = getDb();
  if (!db) {
    res.status(500).json(createHttpErrorBody("Database not initialized", {
      code: "SYNC_DB_UNAVAILABLE",
      stage: "messages",
    }));
    return;
  }

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");
  res.flushHeaders();

  let successCount = 0;
  let errorCount = 0;
  const addedIntentLocks = new Set();
  const writer = new NdjsonWriter(res);
  const seenTopics = new Set();
  let topicCount = 0;
  let messageCount = 0;

  try {
    for await (const line of readNdjsonLines(req)) {
      let topicId = null;
      let streamFatal = false;
      try {
        const frame = parseJsonWithoutDuplicateKeys(decodeNdjsonLine(line));
        topicId = frame.topicId;
        const { messages, ownerType, ownerId } = frame;
        const safeTopicId = sanitizeId(topicId);
        if (!safeTopicId || safeTopicId !== topicId) {
          throw createSyncError(
            "SYNC_REQUEST_INVALID",
            "topicId is missing or contains unsupported characters",
            { stage: "messages" },
          );
        }
        if (!Array.isArray(messages)) {
          throw createSyncError(
            "SYNC_REQUEST_INVALID",
            "messages must be an array",
            { stage: "messages", failedTopicIds: [safeTopicId] },
          );
        }
        if (
          !["agent", "group"].includes(ownerType) ||
          typeof ownerId !== "string" ||
          ownerId.length === 0
        ) {
          throw createSyncError(
            "SYNC_REQUEST_INVALID",
            "Message push requires exact ownerType and ownerId",
            { stage: "messages", failedTopicIds: [safeTopicId] },
          );
        }
        topicCount += 1;
        messageCount += messages.length;
        if (
          topicCount > MAX_NDJSON_TOPICS ||
          messages.length > 10_000 ||
          messageCount > MAX_NDJSON_MESSAGES
        ) {
          streamFatal = true;
          throw createSyncError(
            "SYNC_BUDGET_EXCEEDED",
            "Message push exceeds topic or message count budget",
            { stage: "messages", failedTopicIds: [safeTopicId] },
          );
        }
        if (seenTopics.has(safeTopicId)) {
          streamFatal = true;
          throw createSyncError(
            "SYNC_REQUEST_INVALID",
            "Message push contains a duplicate topic identity",
            { stage: "messages", failedTopicIds: [safeTopicId] },
          );
        }
        seenTopics.add(safeTopicId);

        const row = getEntityIndex(safeTopicId, "topic");
        if (!row) {
          await writer.write({
            topicId,
            success: false,
            neededAttachmentHashes: [],
            error: normalizeSyncError("topic not found", {
              code: "TOPIC_NOT_FOUND",
              stage: "messages",
              failedTopicIds: [safeTopicId],
            }),
          });
          errorCount++;
          continue;
        }
        const actualOwnerId = path.basename(path.dirname(row.file_path));
        const actualOwnerType = row.file_path.includes("AgentGroups")
          ? "group"
          : "agent";
        if (
          ownerType !== actualOwnerType ||
          ownerId !== actualOwnerId
        ) {
          throw createSyncError(
            "SYNC_OWNER_CONFLICT",
            "topic owner identity conflicts with desktop index",
            { stage: "messages", failedTopicIds: [safeTopicId] },
          );
        }

        writeIntentLock.add(safeTopicId);
        addedIntentLocks.add(safeTopicId);
        const result = await doUploadSingleTopic(safeTopicId, messages, appDataPath, row);
        await ingestHistoryToDb(result.historyPath, safeTopicId, "batch_push");
        await writer.write({
          topicId: safeTopicId,
          success: true,
          neededAttachmentHashes: result.neededAttachmentHashes,
        });
        successCount++;
      } catch (e) {
        logger.logOperation("messages", "upload_batch_stream", "line_parse", "error", e.message);
        if (streamFatal) throw e;
        if (typeof topicId === "string" && topicId.length > 0) {
          await writer.write({
            topicId,
            success: false,
            neededAttachmentHashes: [],
            error: normalizeSyncError(e, {
              code: "SYNC_MESSAGE_WRITE_FAILED",
              stage: "messages",
              failedTopicIds: [topicId],
            }),
          });
        } else {
          throw e;
        }
        errorCount++;
      }
    }

    logger.logOperation("messages", "upload_messages_batch_stream", "batch", "success",
      `topics=${topicCount} success=${successCount} error=${errorCount}`);
  } catch (e) {
    logger.logOperation("messages", "upload_messages_batch_stream", "global", "error", e.message);
    if (!res.writableEnded) {
      await writer.write(createStreamErrorFrame(e, {
        code: "SYNC_STREAM_FAILED",
        stage: "messages",
      })).catch(() => {});
    }
  } finally {
    res.end();
    // 延迟 1000ms 释放所有 writeIntentLock（文件监控器此时可安全摄入）
    setTimeout(() => {
      for (const tid of addedIntentLocks) {
        writeIntentLock.delete(tid);
      }
    }, 1000);
  }
}

/**
 * 将 history.json 摄入到消息索引。
 *
 * reconcile 调用方可传入已读取的 history 与 stat，避免同一文件先校验、
 * 后摄取时发生第二次完整读取。普通 watcher/push 调用仍保持向后兼容。
 */
async function ingestHistoryToDb(
  filePath,
  topicId,
  source = "watcher",
  { history: suppliedHistory, sourceStats: suppliedStats } = {},
) {
  if (topicId === "default") return { messageCount: 0, warningCount: 0 };
  const db = getDb();
  const logger = getLogger();
  if (!db) throw new Error("Database not initialized");

  try {
    const history = suppliedHistory ?? (await readHistoryStrict(filePath)).history;
    const sourceStats = suppliedStats ?? await fs.stat(filePath);
    const canonical = canonicalizeHistory(history, topicId);
    if (canonical.topicIdRewrites > 0) {
      logger.logInfo(
        "message",
        `topicId 归一化：${topicId} 有 ${canonical.topicIdRewrites} 条消息重写为 frame topic（${canonical.topicIdRewriteSamples.join("; ")}）`,
        "warn",
      );
    }
    const now = Date.now();
    const fingerprints = [];
    let attachmentCount = 0;

    // Canonical messages are the only values allowed to influence wire hashes.
    const validMessages = canonical.frame.messages
      .sort((a, b) => {
        const tsDiff = (a.timestamp || 0) - (b.timestamp || 0);
        return tsDiff !== 0 ? tsDiff : (a.id || "").localeCompare(b.id || "");
      });

    const liveIds = new Set(validMessages.map((message) => message.id));
    const applyIndex = db.transaction(() => {
      const existing = db
        .prepare(
          "SELECT msg_id FROM message_index WHERE topic_id = ? AND deleted_at IS NULL",
        )
        .all(topicId);
      for (const m of validMessages) {
        const hash = computeMessageFingerprint(m);
        upsertMessageIndex(m.id, topicId, hash, now);
        fingerprints.push(hash);

        if (Array.isArray(m.attachments)) {
          m.attachments.forEach((att, index) => {
            if (att.hash) {
              upsertMessageAttachment(
                m.id,
                att.hash,
                index,
                att.name || "unnamed",
                att.createdAt ?? now,
              );
              attachmentCount++;
            }
          });
        }
      }
      for (const row of existing) {
        if (!liveIds.has(row.msg_id)) {
          const removed = db
            .prepare(
              "UPDATE message_index SET deleted_at = ? WHERE topic_id = ? AND msg_id = ? AND deleted_at IS NULL",
            )
            .run(now, topicId, row.msg_id);
          if (removed.changes !== 1) {
            throw new Error(`Message tombstone missed ${topicId}/${row.msg_id}`);
          }
        }
      }

      const topicRootHash = computeAggregatedHash(fingerprints);
      const updated = db.prepare(
        "UPDATE entity_index SET aggregated_hash = ?, updated_at = ? WHERE id = ? AND (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic') AND deleted_at IS NULL",
      ).run(topicRootHash, now, topicId);
      if (updated.changes !== 1) {
        // 区分 0 行（孤儿话题：磁盘历史在、config 索引缺席）与 >1 行（跨 owner 歧义）
        const matches = db
          .prepare(
            "SELECT COUNT(*) AS n FROM entity_index WHERE id = ? AND (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic') AND deleted_at IS NULL",
          )
          .get(topicId).n;
        throw new Error(
          `Topic ${topicId} is ${matches === 0 ? "missing" : "ambiguous"} in the local index (matches=${matches})`,
        );
      }

      if (source !== "reconcile") {
        const { computeAggregatedHashes } = require("../index");
        computeAggregatedHashes(db, logger);
      }
    });
    applyIndex();
    upsertHistorySourceState(
      topicId,
      filePath,
      sourceStats.size,
      sourceStats.mtimeMs,
    );
    clearHistoryTopicUnhealthy(topicId);

    if (source !== "reconcile") {
      logger.logOperation(
        "messages",
        "ingest",
        topicId,
        "success",
        `msgs=${validMessages.length} attachments=${attachmentCount}`,
      );
    }
    // 启动 reconcile 由外层合并输出摘要，避免数十个话题分别触发
    // console、日志文件和 WebSocket 三路写入。
    if (canonical.warningCount > 0 && source !== "reconcile") {
      logger.logOperation(
        "messages",
        "legacy_attachment_warning",
        topicId,
        "warn",
        `count=${canonical.warningCount}`,
      );
    }
    return {
      messageCount: validMessages.length,
      warningCount: canonical.warningCount,
    };
  } catch (e) {
    markHistoryTopicUnhealthy(topicId, e);
    // 启动 reconcile 由外层统一按 history 话题记录错误，避免同一故障
    // 同时产生 ingest 与 history 两条控制台/文件/WS 日志。
    if (source !== "reconcile") {
      logger.logOperation("messages", "ingest", topicId, "error", e.message);
    }
    throw e;
  }
}

/**
 * 上传附件
 * @param {object} params
 * @param {string} params.hash - 附件哈希
 * @param {Buffer} params.data - 附件二进制数据
 * @param {string} params.name - 文件名
 * @param {string} params.type - MIME 类型
 * @param {string} params.appDataPath - AppData 路径
 */
async function uploadAttachment({ hash, data, name, type, appDataPath }) {
  if (!Buffer.isBuffer(data)) {
    throw new Error("Attachment upload requires a Buffer");
  }
  const { Readable } = require("stream");
  return uploadAttachmentStream({
    hash,
    input: Readable.from([data]),
    declaredLength: data.length,
    name,
    type,
    appDataPath,
  });
}

const MAX_ATTACHMENT_UPLOAD_BYTES = 512 * 1024 * 1024;

async function uploadAttachmentStream({
  hash,
  input,
  declaredLength,
  name,
  type,
  appDataPath,
  indexAttachment = upsertAttachmentIndex,
}) {
  const logger = getLogger();
  if (
    typeof hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(hash)
  ) {
    throw new Error("Attachment upload requires a lowercase SHA-256 hash");
  }
  if (
    declaredLength !== undefined &&
    (!Number.isSafeInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > MAX_ATTACHMENT_UPLOAD_BYTES)
  ) {
    throw new Error("Attachment upload exceeds the 512 MiB limit");
  }
  const attachmentsDir = path.join(appDataPath, "UserData", "attachments");
  await fs.mkdir(attachmentsDir, { recursive: true });

  const ext = getExtensionFromType(type);
  const filePath = path.join(attachmentsDir, `${hash}${ext}`);
  const temporary = path.join(
    attachmentsDir,
    `.${hash}.${crypto.randomUUID()}.upload`,
  );
  const file = await fs.open(temporary, "wx");
  const hasher = crypto.createHash("sha256");
  let total = 0;

  try {
    let position = 0;
    for await (const rawChunk of input) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      total += chunk.length;
      if (total > MAX_ATTACHMENT_UPLOAD_BYTES) {
        throw new Error("Attachment upload exceeds the 512 MiB limit");
      }
      hasher.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(
          chunk,
          offset,
          chunk.length - offset,
          position,
        );
        if (bytesWritten <= 0) throw new Error("Attachment upload made no write progress");
        offset += bytesWritten;
        position += bytesWritten;
      }
    }
    if (declaredLength !== undefined && total !== declaredLength) {
      throw new Error(
        `Attachment Content-Length mismatch: expected ${declaredLength}, received ${total}`,
      );
    }
    const actualHash = hasher.digest("hex");
    if (actualHash !== hash) {
      throw new Error(
        `Attachment content hash mismatch: expected ${hash}, received ${actualHash}`,
      );
    }
    await file.sync();
    await file.close();
    await fs.rename(temporary, filePath);
    if (process.platform !== "win32") {
      const parent = await fs.open(attachmentsDir, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
    indexAttachment(hash, filePath);
  } catch (error) {
    await file.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }

  logger.logOperation("messages", "upload_attachment", hash.substring(0, 16), "success", `name=${name}, size=${total} bytes`);
  return { success: true, hash };
}

/**
 * 下载附件
 * @param {string} hash - 附件哈希
 * @returns {Promise<{filePath: string}|null>}
 */
async function downloadAttachment(hash) {
  const db = getDb();
  const logger = getLogger();
  if (!db) return null;

  const row = db
    .prepare("SELECT file_path FROM attachment_index WHERE hash = ?")
    .get(hash);
  if (!row) {
    logger.logOperation("messages", "download_attachment", hash.substring(0, 16), "error", "not found");
    return null;
  }

  logger.logOperation("messages", "download_attachment", hash.substring(0, 16), "success");
  return { filePath: row.file_path };
}

/**
 * 物理修剪 history.json 中的被删除消息
 * @param {string} topicId 
 * @param {string} msgId 
 */
async function pruneMessageFromPhysicalHistory(topicId, msgId, appDataPath) {
  const safeTopicId = sanitizeId(topicId);
  const row = getEntityIndex(safeTopicId, "topic");
  if (!row) return;

  const parentId = path.basename(path.dirname(row.file_path));

  const historyPath = path.join(
    appDataPath,
    "UserData",
    parentId,
    "topics",
    safeTopicId,
    "history.json"
  );

  const release = await acquireLock(historyPath);
  try {
    const { history, sourceHash } = await readHistoryStrict(historyPath);

    const filtered = history.filter((m) => m.id !== msgId);
    if (filtered.length !== history.length) {
      await writeHistoryAtomic(historyPath, filtered, sourceHash);
      await ingestHistoryToDb(historyPath, safeTopicId, "batch_push");
    }
  } finally {
    release();
  }
}

module.exports = {
  downloadMessagesStreamRaw,
  uploadMessagesBatchRaw,
  uploadAttachment,
  uploadAttachmentStream,
  downloadAttachment,
  ingestHistoryToDb,
  pruneMessageFromPhysicalHistory,
  readHistoryStrict,
  writeHistoryAtomic,
  assertHistoryTopicHealthy,
  markHistoryTopicUnhealthy,
  clearHistoryTopicUnhealthy,
};
