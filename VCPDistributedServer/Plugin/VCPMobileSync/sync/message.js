/**
 * 消息历史同步
 */

const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const {
  getDb,
  getEntityIndex,
  upsertMessageIndex,
  upsertAttachmentIndex,
  upsertMessageAttachment,
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
  MAX_NDJSON_MESSAGES,
  MAX_NDJSON_TOPICS,
  NdjsonWriter,
  decodeNdjsonLine,
  readNdjsonLines,
} = require("../transport/ndjson");

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
    history = JSON.parse(bytes.toString("utf8"));
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
    res.status(500).json({ error: "Database not initialized" });
    return;
  }
  if (
    !Array.isArray(requests) ||
    requests.length === 0 ||
    requests.some((request) => !request || typeof request !== "object")
  ) {
    throw new Error("Message pull requires non-empty object requests");
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
    throw new Error("Message pull exceeds 10000 topics");
  }
  for (const { topicId, ownerType, ownerId, msgIds = [] } of requests) {
    const safeTopicId = sanitizeId(topicId);
    try {
      if (!safeTopicId || safeTopicId !== topicId || seenTopics.has(safeTopicId)) {
        throw new Error("Message pull topic IDs must be non-empty and unique");
      }
      if (
        !Array.isArray(msgIds) ||
        new Set(msgIds).size !== msgIds.length ||
        msgIds.some((id) => typeof id !== "string" || id.length === 0)
      ) {
        throw new Error("Message pull IDs must be non-empty strings and unique");
      }
      if (
        (ownerType == null) !== (ownerId == null) ||
        (ownerType != null && !["agent", "group"].includes(ownerType)) ||
        (ownerId != null && (typeof ownerId !== "string" || ownerId.length === 0))
      ) {
        throw new Error("Message pull ownerType and ownerId must be valid together");
      }
      seenTopics.add(safeTopicId);
      requestedMessages += msgIds.length;
      if (msgIds.length > 10_000 || requestedMessages > MAX_NDJSON_MESSAGES) {
        throw new Error("Message pull exceeds message count budget");
      }
      const row = getEntityIndex(safeTopicId, "topic");
      if (!row) {
        await writer.write({ topicId, ownerType, ownerId, messages: [], _error: "topic not found" });
        errorCount++;
        continue;
      }

      const parentId = path.basename(path.dirname(row.file_path));
      const actualOwnerType = row.file_path.includes("AgentGroups") ? "group" : "agent";
      if (
        (ownerType && ownerType !== actualOwnerType) ||
        (ownerId && ownerId !== parentId)
      ) {
        throw new Error("topic owner identity conflicts with desktop index");
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
      const wanted = new Set(msgIds);
      const messages = wanted.size === 0
        ? canonical.frame.messages
        : canonical.frame.messages.filter((message) => wanted.has(message.id));
      if (wanted.size > 0) {
        const actual = new Set(messages.map((message) => message.id));
        if (actual.size !== wanted.size || [...wanted].some((id) => !actual.has(id))) {
          throw new Error("requested message set is incomplete");
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
      await writer.write({ topicId, ownerType, ownerId, messages: [], _error: e.message });
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
    res.status(500).json({ error: "Database not initialized" });
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
      try {
        const frame = parseJsonWithoutDuplicateKeys(decodeNdjsonLine(line));
        topicId = frame.topicId;
        const { messages, ownerType, ownerId } = frame;
        const safeTopicId = sanitizeId(topicId);
        if (!safeTopicId || safeTopicId !== topicId) {
          throw new Error("topicId is missing or contains unsupported characters");
        }
        if (!Array.isArray(messages)) {
          throw new Error("messages must be an array");
        }
        topicCount += 1;
        messageCount += messages.length;
        if (
          topicCount > MAX_NDJSON_TOPICS ||
          messages.length > 10_000 ||
          messageCount > MAX_NDJSON_MESSAGES
        ) {
          throw new Error("Message push exceeds topic or message count budget");
        }
        const identity = `${ownerType || ""}:${ownerId || ""}:${safeTopicId}`;
        if (seenTopics.has(identity)) {
          throw new Error("Message push contains a duplicate topic identity");
        }
        seenTopics.add(identity);

        const row = getEntityIndex(safeTopicId, "topic");
        if (!row) {
          await writer.write({
            topicId,
            success: false,
            neededAttachmentHashes: [],
            error: "topic not found",
          });
          errorCount++;
          continue;
        }
        const actualOwnerId = path.basename(path.dirname(row.file_path));
        const actualOwnerType = row.file_path.includes("AgentGroups")
          ? "group"
          : "agent";
        if (
          (ownerType && ownerType !== actualOwnerType) ||
          (ownerId && ownerId !== actualOwnerId)
        ) {
          throw new Error("topic owner identity conflicts with desktop index");
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
        if (typeof topicId === "string" && topicId.length > 0) {
          await writer.write({
            topicId,
            success: false,
            neededAttachmentHashes: [],
            error: e.message,
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
      await writer.write({ _stream_error: e.message }).catch(() => {});
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
 * 将 history.json 摄入到消息索引
 */
async function ingestHistoryToDb(filePath, topicId, source = "watcher") {
  if (topicId === "default") return;
  const db = getDb();
  const logger = getLogger();
  if (!db) throw new Error("Database not initialized");

  try {
    const { history } = await readHistoryStrict(filePath);
    const canonical = canonicalizeHistory(history, topicId);
    const now = Date.now();
    const fingerprints = [];
    let msgCount = 0;
    let attachmentCount = 0;

    // Canonical messages are the only values allowed to influence wire hashes.
    const validMessages = canonical.frame.messages
      .sort((a, b) => {
        const tsDiff = (a.timestamp || 0) - (b.timestamp || 0);
        return tsDiff !== 0 ? tsDiff : (a.id || "").localeCompare(b.id || "");
      });

    for (const m of validMessages) {
      const hash = computeMessageFingerprint(m);
      upsertMessageIndex(m.id, topicId, hash, now);
      fingerprints.push(hash);
      msgCount++;

      // 提取并索引附件关联 (核心修复)
      if (Array.isArray(m.attachments)) {
        m.attachments.forEach((att, index) => {
          const attHash = att.hash;
          if (attHash) {
            upsertMessageAttachment(
              m.id,
              attHash,
              index,
              att.name || "unnamed",
              att.createdAt || now,
            );
            attachmentCount++;
          }
        });
      }
    }

    // 更新 Topic 聚合哈希 (V2: 统一使用 computeAggregatedHash，确保空列表结果一致)
    const topicRootHash = computeAggregatedHash(fingerprints);
    const updated = db.prepare(
      "UPDATE entity_index SET aggregated_hash = ?, updated_at = ? WHERE id = ? AND (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic')",
    ).run(topicRootHash, now, topicId);
    if (updated.changes !== 1) {
      throw new Error(`Topic ${topicId} is missing or ambiguous in the local index`);
    }

    // V2: 触发层级冒泡 (Agent/Group content_hash 更新)
    if (source !== "reconcile") {
      const { computeAggregatedHashes } = require("../index");
      computeAggregatedHashes(db, logger);

      logger.logOperation("messages", "ingest", topicId, "success", `msgs=${msgCount} attachments=${attachmentCount}`);
    }
    if (canonical.warningCount > 0) {
      logger.logOperation(
        "messages",
        "legacy_attachment_warning",
        topicId,
        "warn",
        `count=${canonical.warningCount}`,
      );
    }
  } catch (e) {
    logger.logOperation("messages", "ingest", topicId, "error", e.message);
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
};
