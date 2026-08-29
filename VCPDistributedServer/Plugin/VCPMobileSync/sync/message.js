/**
 * 消息历史同步
 */

const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const { TextDecoder } = require("node:util");
const {
  getDb,
  getTopicState,
  getHistorySourceState,
  isHistorySourceCurrent,
  upsertMessageState,
  upsertMessageTombstone,
  upsertHistorySourceState,
  updateTopicContentHash,
  refreshOwnerContentHash,
} = require("../core/db");
const {
  computeMessageLeafHash,
  computeAggregatedHash,
} = require("../core/hash");
const {
  sanitizeId,
  addWriteIntent,
  releaseWriteIntent,
} = require("./entity");
const { getLogger } = require("../core/logger");
const { acquireLock } = require("../utils/lock");
const { parseJsonWithoutDuplicateKeys } = require("../protocol");
const { canonicalizeHistory } = require("./canonical");
const { mergeMobileMessage, projectMobileTopic } = require("./projection");
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

function topicIdentityKey(ownerType, ownerId, topicId) {
  return `${ownerType}\0${ownerId}\0${topicId}`;
}

function unhealthyHistoryHash({ topicId, ownerType, ownerId }) {
  return crypto
    .createHash("sha256")
    .update(`vcp-unhealthy-topic:${ownerType}:${ownerId}:${topicId}`)
    .digest("hex");
}

function publishUnhealthyHistoryHash({ topicId, ownerType, ownerId }) {
  const db = getDb();
  if (!db) return;
  const contentHash = unhealthyHistoryHash({ topicId, ownerType, ownerId });
  updateTopicContentHash({ topicId, ownerType, ownerId }, contentHash);
  refreshOwnerContentHash({ ownerType, ownerId });
}

function markHistoryTopicUnhealthy({ topicId, ownerType, ownerId }, error) {
  if (
    typeof topicId === "string" &&
    topicId.length > 0 &&
    ["agent", "group"].includes(ownerType) &&
    typeof ownerId === "string" &&
    ownerId.length > 0
  ) {
    const key = topicIdentityKey(ownerType, ownerId, topicId);
    const reason = String(error?.message || error);
    unhealthyHistoryTopics.set(key, reason);
    try {
      publishUnhealthyHistoryHash({ topicId, ownerType, ownerId });
    } catch (indexError) {
      unhealthyHistoryTopics.set(
        key,
        `${reason}; failed to publish unhealthy hash: ${indexError.message}`,
      );
    }
  }
}

function clearHistoryTopicUnhealthy({ topicId, ownerType, ownerId }) {
  unhealthyHistoryTopics.delete(topicIdentityKey(ownerType, ownerId, topicId));
}

function clearHistoryOwnerUnhealthy(ownerType, ownerId) {
  const prefix = `${ownerType}\0${ownerId}\0`;
  for (const key of unhealthyHistoryTopics.keys()) {
    if (key.startsWith(prefix)) unhealthyHistoryTopics.delete(key);
  }
}

function isHistoryTopicUnhealthy({ topicId, ownerType, ownerId }) {
  const key = topicIdentityKey(ownerType, ownerId, topicId);
  if (unhealthyHistoryTopics.has(key)) return true;
  return getTopicState({ ownerType, ownerId, topicId })?.content_hash ===
    unhealthyHistoryHash({ topicId, ownerType, ownerId });
}

function assertHistoryTopicHealthy({ topicId, ownerType, ownerId }) {
  const reason = unhealthyHistoryTopics.get(
    topicIdentityKey(ownerType, ownerId, topicId),
  );
  if (reason !== undefined) {
    throw Object.assign(
      new Error(
        `History source for topic ${ownerType}/${ownerId}/${topicId} is invalid: ${reason}`,
      ),
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
  const bytes = Buffer.from(JSON.stringify(history, null, 2), "utf8");
  const sourceHash = crypto.createHash("sha256").update(bytes).digest("hex");
  const file = await fs.open(temporary, "wx");
  let sourceStats;
  try {
    await file.writeFile(bytes);
    await file.sync();
    sourceStats = await file.stat();
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
      throw Object.assign(
        new Error("History changed concurrently; retry this topic"),
        { code: "SYNC_SNAPSHOT_STALE" },
      );
    }
    if (sourceHash === expectedSourceHash) {
      await fs.unlink(temporary);
      return { unchanged: true };
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
    return {
      unchanged: false,
      history,
      sourceHash,
      sourceStats: {
        size: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
      },
    };
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

function loadMessageTombstoneIds(db, { ownerType, ownerId, topicId }) {
  return new Set(
    db.prepare(
      `SELECT msg_id FROM messages
       WHERE owner_type = ? AND owner_id = ? AND topic_id = ?
         AND deleted_at IS NOT NULL`,
    )
      .all(ownerType, ownerId, topicId)
      .map((row) => row.msg_id),
  );
}

/**
 * 流式批量下载消息 (NDJSON) — 对标 Phase 3 万级话题 Pull
 *
 * 一次 HTTP 请求承载多个 topic 的 pull，响应以 NDJSON 逐 topic 分帧。
 * 每个 topic 独立读取 history.json 后立即 flush，手机端逐行消费，
 * 不缓冲整个响应。单 topic 失败只影响自身，不中断流。
 *
 * @param {object[]} topics - [{ ownerType, ownerId, topicId, messageIds }]
 * @param {string} appDataPath - AppData 路径
 * @param {object} res - Express response (用于流式写入)
 */
async function pullMessagesStreamRaw(topics, appDataPath, res) {
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
    !Array.isArray(topics) ||
    topics.length === 0 ||
    topics.some((topic) => !topic || typeof topic !== "object")
  ) {
    throw createSyncError(
      "SYNC_REQUEST_INVALID",
      "Message pull requires non-empty topic selectors",
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
  if (topics.length > MAX_NDJSON_TOPICS) {
    throw createSyncError(
      "SYNC_BUDGET_EXCEEDED",
      "Message pull exceeds 10000 topics",
      { stage: "messages" },
    );
  }
  for (const { topicId, ownerType, ownerId, messageIds } of topics) {
    const safeTopicId = sanitizeId(topicId);
    try {
      if (!safeTopicId || safeTopicId !== topicId) {
        throw createSyncError(
          "SYNC_REQUEST_INVALID",
          "Message pull topic ID is invalid",
          { stage: "messages", failedTopicIds: [topicId] },
        );
      }
      if (
        !Array.isArray(messageIds) ||
        new Set(messageIds).size !== messageIds.length ||
        messageIds.some((id) => typeof id !== "string" || id.length === 0)
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
      const topicKey = topicIdentityKey(ownerType, ownerId, safeTopicId);
      if (seenTopics.has(topicKey)) {
        throw createSyncError(
          "SYNC_REQUEST_INVALID",
          "Message pull contains a duplicate topic identity",
          { stage: "messages", failedTopicIds: [safeTopicId] },
        );
      }
      seenTopics.add(topicKey);
      assertHistoryTopicHealthy({ topicId: safeTopicId, ownerType, ownerId });
      requestedMessages += messageIds.length;
      if (messageIds.length > 10_000 || requestedMessages > MAX_NDJSON_MESSAGES) {
        throw createSyncError(
          "SYNC_BUDGET_EXCEEDED",
          "Message pull exceeds message count budget",
          { stage: "messages", failedTopicIds: [safeTopicId] },
        );
      }
      const row = getTopicState({
        ownerType,
        ownerId,
        topicId: safeTopicId,
      });
      if (!row) {
        await writer.write({
          kind: "topic",
          topicId,
          ownerType,
          ownerId,
          ok: false,
          error: normalizeSyncError("topic not found", {
            code: "TOPIC_NOT_FOUND",
            stage: "messages",
            failedTopicIds: [safeTopicId],
          }),
        });
        errorCount++;
        continue;
      }

      const parentId = row.owner_id;
      const actualOwnerType = row.owner_type;
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
      const wanted = new Set(messageIds);
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
      const indexedStates = new Map(
        db
          .prepare(
            `SELECT msg_id, message_hash AS hash, updated_at FROM messages
             WHERE owner_type = ? AND owner_id = ? AND topic_id = ?
               AND deleted_at IS NULL`,
          )
          .all(ownerType, ownerId, safeTopicId)
          .map((indexRow) => [indexRow.msg_id, indexRow]),
      );
      if (wanted.size === 0) {
        const physicalIds = new Set(messages.map((message) => message.id));
        if (
          physicalIds.size !== indexedStates.size ||
          [...indexedStates.keys()].some((id) => !physicalIds.has(id))
        ) {
          throw createSyncError(
            "SYNC_SNAPSHOT_STALE",
            `physical history changed after ${safeTopicId} was indexed`,
            { stage: "messages", failedTopicIds: [safeTopicId] },
          );
        }
      }
      for (const message of messages) {
        const indexed = indexedStates.get(message.id);
        if (
          !indexed ||
          !Number.isSafeInteger(indexed.updated_at) ||
          indexed.updated_at < 0 ||
          message.contentHash !== indexed.hash
        ) {
          throw createSyncError(
            "SYNC_SNAPSHOT_STALE",
            `message ${safeTopicId}/${message.id} changed after it was indexed`,
            { stage: "messages", failedTopicIds: [safeTopicId] },
          );
        }
        message.updatedAt = indexed.updated_at;
        delete message.contentHash;
      }
      await writer.write({
        kind: "topic",
        topicId: safeTopicId,
        ownerType: actualOwnerType,
        ownerId: parentId,
        ok: true,
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
        kind: "topic",
        topicId,
        ownerType,
        ownerId,
        ok: false,
        error: normalizeSyncError(e, {
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
    `topics=${topics.length} success=${successCount} error=${errorCount}`);
}

/**
 * 单 Topic 消息提交：在同一 history 锁内合并 live 消息、删除墓碑并刷新索引。
 * 批量场景下由外层统一管理并发控制
 *
 * @param {string} safeTopicId - 已 sanitized 的 topic ID
 * @param {object[]} messages - live 消息列表
 * @param {object[]} deletedMessages - [{msgId, deletedAt}]
 * @param {string} appDataPath - AppData 路径
 * @param {object} row - Topic 提交状态
 * @returns {Promise<void>}
 */
async function doPushSingleTopic(
  safeTopicId,
  messages,
  deletedMessages,
  appDataPath,
  row,
) {
  const db = getDb();
  const parentId = row.owner_id;
  const isGroup = row.owner_type === "group";
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

    const persistedTombstones = loadMessageTombstoneIds(db, {
      ownerType: row.owner_type,
      ownerId: parentId,
      topicId: safeTopicId,
    });
    const staleLive = messages.find((message) =>
      persistedTombstones.has(message.id)
    );
    if (staleLive) {
      throw createSyncError(
        "SYNC_SNAPSHOT_STALE",
        `Mobile push contains tombstoned message ${safeTopicId}/${staleLive.id}; rerun message diff`,
        { stage: "messages", failedTopicIds: [safeTopicId] },
      );
    }

    const msgMap = new Map(
      localHistory
        .filter((message) => !persistedTombstones.has(message?.id))
        .map((message) => [message.id, message]),
    );
    const projected = await projectMobileTopic({
      topicId: safeTopicId,
      ownerType: isGroup ? "group" : "agent",
      ownerId: parentId,
      messages,
      db,
      appDataPath,
    });

    for (const desktopMessage of projected.messages) {
      const existing = msgMap.get(desktopMessage.id);
      msgMap.set(
        desktopMessage.id,
        existing
          ? mergeMobileMessage(existing, desktopMessage)
          : desktopMessage,
      );
    }
    for (const tombstone of deletedMessages) {
      msgMap.delete(tombstone.msgId);
    }

    const finalHistory = Array.from(msgMap.values()).sort(
      (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
    );

    const committed = await writeHistoryAtomic(
      historyPath,
      finalHistory,
      sourceHash,
    );
    if (deletedMessages.length > 0) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const tombstone of deletedMessages) {
          upsertMessageTombstone({
            ownerType: row.owner_type,
            ownerId: parentId,
            topicId: safeTopicId,
            msgId: tombstone.msgId,
            deletedAt: tombstone.deletedAt,
          });
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    const identity = {
      topicId: safeTopicId,
      ownerType: row.owner_type,
      ownerId: parentId,
    };
    await ingestHistoryToDb(
      historyPath,
      identity,
      "batch_push",
      committed.unchanged
        ? undefined
        : {
            history: committed.history,
            sourceStats: committed.sourceStats,
            sourceHash: committed.sourceHash,
          },
    );

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
async function pushMessagesStreamRaw(req, appDataPath, res) {
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
      let ownerType = null;
      let ownerId = null;
      let streamFatal = false;
      try {
        const frame = parseJsonWithoutDuplicateKeys(decodeNdjsonLine(line));
        if (
          !frame ||
          typeof frame !== "object" ||
          Array.isArray(frame) ||
          Object.keys(frame).sort().join("\0") !==
            ["deletedMessages", "kind", "messages", "ownerId", "ownerType", "topicId"]
              .sort()
              .join("\0") ||
          frame.kind !== "topic"
        ) {
          streamFatal = true;
          throw createSyncError(
            "SYNC_REQUEST_INVALID",
            "Message push line requires the exact Topic frame contract",
            { stage: "messages" },
          );
        }
        topicId = frame.topicId;
        ownerType = frame.ownerType;
        ownerId = frame.ownerId;
        const { messages, deletedMessages } = frame;
        const safeTopicId = sanitizeId(topicId);
        if (!safeTopicId || safeTopicId !== topicId) {
          streamFatal = true;
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
        if (!Array.isArray(deletedMessages)) {
          throw createSyncError(
            "SYNC_REQUEST_INVALID",
            "deletedMessages must be an array",
            { stage: "messages", failedTopicIds: [safeTopicId] },
          );
        }
        if (
          !["agent", "group"].includes(ownerType) ||
          typeof ownerId !== "string" ||
          ownerId.length === 0
        ) {
          streamFatal = true;
          throw createSyncError(
            "SYNC_REQUEST_INVALID",
            "Message push requires exact ownerType and ownerId",
            { stage: "messages", failedTopicIds: [safeTopicId] },
          );
        }
        topicCount += 1;
        const liveIds = new Set();
        for (const message of messages) {
          if (
            !message ||
            typeof message !== "object" ||
            Array.isArray(message) ||
            typeof message.id !== "string" ||
            !message.id ||
            sanitizeId(message.id) !== message.id ||
            liveIds.has(message.id)
          ) {
            throw createSyncError(
              "SYNC_REQUEST_INVALID",
              "messages must carry unique valid IDs",
              { stage: "messages", failedTopicIds: [safeTopicId] },
            );
          }
          liveIds.add(message.id);
        }
        const deletedIds = new Set();
        for (const tombstone of deletedMessages) {
          if (
            !tombstone ||
            typeof tombstone !== "object" ||
            Array.isArray(tombstone) ||
            Object.keys(tombstone).sort().join("\0") !== "deletedAt\0msgId" ||
            typeof tombstone.msgId !== "string" ||
            !tombstone.msgId ||
            sanitizeId(tombstone.msgId) !== tombstone.msgId ||
            !Number.isSafeInteger(tombstone.deletedAt) ||
            tombstone.deletedAt < 0 ||
            deletedIds.has(tombstone.msgId) ||
            liveIds.has(tombstone.msgId)
          ) {
            throw createSyncError(
              "SYNC_REQUEST_INVALID",
              "deletedMessages must be unique valid tombstones disjoint from live messages",
              { stage: "messages", failedTopicIds: [safeTopicId] },
            );
          }
          deletedIds.add(tombstone.msgId);
        }
        const topicMessageCount = messages.length + deletedMessages.length;
        messageCount += topicMessageCount;
        if (
          topicCount > MAX_NDJSON_TOPICS ||
          topicMessageCount > 10_000 ||
          messageCount > MAX_NDJSON_MESSAGES
        ) {
          streamFatal = true;
          throw createSyncError(
            "SYNC_BUDGET_EXCEEDED",
            "Message push exceeds topic or message count budget",
            { stage: "messages", failedTopicIds: [safeTopicId] },
          );
        }
        const topicKey = topicIdentityKey(ownerType, ownerId, safeTopicId);
        if (seenTopics.has(topicKey)) {
          streamFatal = true;
          throw createSyncError(
            "SYNC_REQUEST_INVALID",
            "Message push contains a duplicate topic identity",
            { stage: "messages", failedTopicIds: [safeTopicId] },
          );
        }
        seenTopics.add(topicKey);

        const row = getTopicState({
          ownerType,
          ownerId,
          topicId: safeTopicId,
        });
        if (!row) {
          await writer.write({
            kind: "topic",
            topicId,
            ownerType,
            ownerId,
            ok: false,
            error: normalizeSyncError("topic not found", {
              code: "TOPIC_NOT_FOUND",
              stage: "messages",
              failedTopicIds: [safeTopicId],
            }),
          });
          errorCount++;
          continue;
        }
        const actualOwnerId = row.owner_id;
        const actualOwnerType = row.owner_type;
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
        assertHistoryTopicHealthy({
          topicId: safeTopicId,
          ownerType,
          ownerId,
        });

        addedIntentLocks.add(addWriteIntent({
          id: safeTopicId,
          type: "topic",
          ownerType,
          ownerId,
        }));
        await doPushSingleTopic(
          safeTopicId,
          messages,
          deletedMessages,
          appDataPath,
          row,
        );
        await writer.write({
          kind: "topic",
          topicId: safeTopicId,
          ownerType,
          ownerId,
          ok: true,
        });
        successCount++;
      } catch (e) {
        logger.logOperation("messages", "upload_batch_stream", "line_parse", "error", e.message);
        if (streamFatal) throw e;
        if (typeof topicId === "string" && topicId.length > 0) {
          await writer.write({
            kind: "topic",
            topicId,
            ownerType,
            ownerId,
            ok: false,
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
    for (const key of addedIntentLocks) {
      releaseWriteIntent(key);
    }
  }
}

/**
 * 将 history.json 摄入到消息索引。
 *
 * reconcile 调用方可传入已读取的 history 与 stat，避免同一文件先校验、
 * 后摄取时发生第二次完整读取；watcher/push 调用则自行读取文件。
 */
function resolveMessageUpdatedAt(message, hash, previous, detectedAt) {
  if (Number.isSafeInteger(message.updatedAt) && message.updatedAt >= 0) {
    return message.updatedAt;
  }
  if (!previous) return message.timestamp;
  if (previous.hash === hash) return previous.updated_at;
  return detectedAt;
}

async function ingestHistoryToDb(
  filePath,
  { topicId, ownerType, ownerId },
  source = "watcher",
  {
    history: suppliedHistory,
    sourceStats: suppliedStats,
    sourceHash: suppliedSourceHash,
  } = {},
) {
  const db = getDb();
  const logger = getLogger();
  if (!db) throw new Error("Database not initialized");

  try {
    const suppliedCount = [suppliedHistory, suppliedStats, suppliedSourceHash]
      .filter((value) => value !== undefined)
      .length;
    if (suppliedCount !== 0 && suppliedCount !== 3) {
      throw new Error("History, source stats, and source hash must be supplied together");
    }
    let history = suppliedHistory;
    let sourceStats = suppliedStats;
    let sourceHash = suppliedSourceHash;
    if (history === undefined) {
      sourceStats = await fs.stat(filePath);
      if (!isHistoryTopicUnhealthy({ topicId, ownerType, ownerId }) &&
        isHistorySourceCurrent({
        ownerType,
        ownerId,
        topicId,
        filePath,
        fileSize: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
        })) {
        return { messageCount: 0, warningCount: 0, changed: false };
      }
      const snapshot = await readHistoryStrict(filePath);
      history = snapshot.history;
      sourceHash = snapshot.sourceHash;
    }
    if (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceHash)) {
      throw new Error("History source hash must be a lowercase SHA-256 hash");
    }
    const persistedTombstones = loadMessageTombstoneIds(db, {
      ownerType,
      ownerId,
      topicId,
    });
    if (persistedTombstones.size > 0) {
      const repairedHistory = history.filter(
        (message) => !persistedTombstones.has(message?.id),
      );
      const removedCount = history.length - repairedHistory.length;
      if (removedCount > 0) {
        const committed = await writeHistoryAtomic(
          filePath,
          repairedHistory,
          sourceHash,
        );
        if (!committed || committed.unchanged) {
          throw new Error(`Tombstone repair did not commit for ${topicId}`);
        }
        history = repairedHistory;
        sourceStats = committed.sourceStats;
        sourceHash = committed.sourceHash;
        logger.logOperation(
          "messages",
          "repair_tombstoned_history",
          topicId,
          "success",
          `removed=${removedCount}`,
        );
      }
    }
    const previousSource = getHistorySourceState({ ownerType, ownerId, topicId });
    const sourceWasUnhealthy = isHistoryTopicUnhealthy({ topicId, ownerType, ownerId });
    if (previousSource?.source_hash === sourceHash && !sourceWasUnhealthy) {
      upsertHistorySourceState({
        ownerType,
        ownerId,
        topicId,
        filePath,
        fileSize: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
        sourceHash,
      });
      clearHistoryTopicUnhealthy({ topicId, ownerType, ownerId });
      return { messageCount: 0, warningCount: 0, changed: false };
    }
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
    const validMessages = canonical.frame.messages;

    const liveIds = new Set(validMessages.map((message) => message.id));
    const applyIndex = db.transaction(() => {
      const existing = db
        .prepare(
          `SELECT msg_id, message_hash AS hash, updated_at, deleted_at FROM messages
           WHERE owner_type = ? AND owner_id = ? AND topic_id = ?`,
        )
        .all(ownerType, ownerId, topicId);
      const existingById = new Map(existing.map((row) => [row.msg_id, row]));
      const topic = db
        .prepare(
          `SELECT content_hash FROM topics
           WHERE owner_type = ? AND owner_id = ? AND topic_id = ?
             AND deleted_at IS NULL`,
        )
        .get(ownerType, ownerId, topicId);
      if (!topic) {
        throw new Error(
          `Topic ${ownerType}/${ownerId}/${topicId} is missing in the local index`,
        );
      }
      const deleteMessage = db.prepare(
        `UPDATE messages SET deleted_at = ?
         WHERE owner_type = ? AND owner_id = ? AND topic_id = ? AND msg_id = ?
           AND deleted_at IS NULL`,
      );
      for (const m of validMessages) {
        const hash = m.contentHash;
        const previous = existingById.get(m.id);
        if (previous?.deleted_at !== null && previous?.deleted_at !== undefined) {
          continue;
        }
        const updatedAt = resolveMessageUpdatedAt(m, hash, previous, now);
        if (!previous || previous.hash !== hash || previous.updated_at !== updatedAt) {
          upsertMessageState({
            ownerType,
            ownerId,
            topicId,
            msgId: m.id,
            hash,
            updatedAt,
          });
        }
        fingerprints.push(computeMessageLeafHash(m.id, hash));

        attachmentCount += Array.isArray(m.attachments) ? m.attachments.length : 0;
      }
      for (const row of existing) {
        if (row.deleted_at === null && !liveIds.has(row.msg_id)) {
          const removed = deleteMessage.run(
            now,
            ownerType,
            ownerId,
            topicId,
            row.msg_id,
          );
          if (removed.changes !== 1) {
            throw new Error(`Message tombstone missed ${topicId}/${row.msg_id}`);
          }
        }
      }

      const topicRootHash = computeAggregatedHash(fingerprints);
      if (topic.content_hash !== topicRootHash) {
        const updated = updateTopicContentHash(
          { topicId, ownerType, ownerId },
          topicRootHash,
        );
        if (updated.changes !== 1) {
          throw Object.assign(
            new Error(
              `Topic ${ownerType}/${ownerId}/${topicId} disappeared during ingestion`,
            ),
            { code: "SYNC_SNAPSHOT_STALE" },
          );
        }
        if (source !== "reconcile") {
          refreshOwnerContentHash({ ownerType, ownerId });
        }
      }
      upsertHistorySourceState({
        ownerType,
        ownerId,
        topicId,
        filePath,
        fileSize: sourceStats.size,
        mtimeMs: sourceStats.mtimeMs,
        sourceHash,
      });
    });
    applyIndex();
    clearHistoryTopicUnhealthy({ topicId, ownerType, ownerId });

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
      changed: true,
    };
  } catch (e) {
    markHistoryTopicUnhealthy({ topicId, ownerType, ownerId }, e);
    // 启动 reconcile 由外层统一按 history 话题记录错误，避免同一故障
    // 同时产生 ingest 与 history 两条控制台/文件/WS 日志。
    if (source !== "reconcile") {
      logger.logOperation("messages", "ingest", topicId, "error", e.message);
    }
    throw e;
  }
}

/**
 * 在一个提交路径中删除消息：先替换物理 history，
 * 再持久化显式墓碑，最后重新摄取聚合视图。
 * @param {string} topicId 
 * @param {string} msgId 
 * @param {string} ownerType
 * @param {string} ownerId
 */
async function pruneMessageFromPhysicalHistory(
  topicId,
  msgId,
  ownerType,
  ownerId,
  deletedAt,
  appDataPath,
) {
  const safeTopicId = sanitizeId(topicId);
  const row = getTopicState({
    ownerType,
    ownerId,
    topicId: safeTopicId,
  });
  if (!row) return;

  const parentId = row.owner_id;

  const historyPath = path.join(
    appDataPath,
    "UserData",
    parentId,
    "topics",
    safeTopicId,
    "history.json"
  );

  const release = await acquireLock(historyPath);
  const writeIntentKey = addWriteIntent({
    id: safeTopicId,
    type: "topic",
    ownerType,
    ownerId,
  });
  try {
    const { history, sourceHash } = await readHistoryStrict(historyPath);
    const filtered = history.filter((m) => m.id !== msgId);
    let committed = null;
    if (filtered.length !== history.length) {
      committed = await writeHistoryAtomic(historyPath, filtered, sourceHash);
    }
    upsertMessageTombstone({
      ownerType,
      ownerId,
      topicId: safeTopicId,
      msgId,
      deletedAt,
    });
    await ingestHistoryToDb(
      historyPath,
      { topicId: safeTopicId, ownerType, ownerId },
      "batch_push",
      committed && !committed.unchanged
        ? {
            history: committed.history,
            sourceStats: committed.sourceStats,
            sourceHash: committed.sourceHash,
          }
        : undefined,
    );
  } finally {
    release();
    releaseWriteIntent(writeIntentKey);
  }
}

module.exports = {
  pullMessagesStreamRaw,
  pushMessagesStreamRaw,
  resolveMessageUpdatedAt,
  ingestHistoryToDb,
  pruneMessageFromPhysicalHistory,
  readHistoryStrict,
  writeHistoryAtomic,
  assertHistoryTopicHealthy,
  markHistoryTopicUnhealthy,
  clearHistoryTopicUnhealthy,
  clearHistoryOwnerUnhealthy,
  isHistoryTopicUnhealthy,
};
