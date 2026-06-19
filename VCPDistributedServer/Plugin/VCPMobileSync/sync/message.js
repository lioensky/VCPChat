/**
 * 消息历史同步
 */

const fs = require("fs").promises;
const path = require("path");
const {
  getDb,
  getEntityIndex,
  upsertMessageIndex,
  upsertAttachmentIndex,
  upsertMessageAttachment,
} = require("../core/db");
const {
  stableStringify,
  computeMessageFingerprint,
  computeAggregatedHash,
} = require("../core/hash");
const { sanitizeId, writeIntentLock } = require("./entity");
const { getExtensionFromType } = require("../utils/mime");
const { createDesktopAttachment } = require("../config/defaults");
const { getLogger } = require("../core/logger");
const { acquireLock } = require("../utils/lock");

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

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");
  res.flushHeaders();

  let successCount = 0;
  let errorCount = 0;

  for (const { topicId, msgIds = [] } of requests) {
    const safeTopicId = sanitizeId(topicId);
    try {
      const row = getEntityIndex(safeTopicId, "topic");
      if (!row) {
        // topic 不存在，写入空消息数组让手机端跳过
        res.write(JSON.stringify({ topicId, messages: [], _error: "topic not found" }) + "\n");
        errorCount++;
        continue;
      }

      const parentId = path.basename(path.dirname(row.file_path));
      const historyPath = path.join(
        appDataPath,
        "UserData",
        parentId,
        "topics",
        safeTopicId,
        "history.json",
      );

      let history = [];
      try {
        const content = await fs.readFile(historyPath, "utf-8");
        history = JSON.parse(content);
      } catch (e) {
        // history.json 为空或不存在，视为无消息
      }

      const idSet = new Set(msgIds);
      const filtered = idSet.size === 0
        ? history
        : history.filter((m) => idSet.has(m.id));

      // 拍平附件结构并进行类型清洗，消除手机端二次解析负担
      const flattened = filtered.map((msg) => {
        // 数据标准化清洗
        msg.isThinking = !!(msg.isThinking ?? false);
        msg.isGroupMessage = !!(msg.isGroupMessage ?? false);
        if (msg.timestamp && typeof msg.timestamp === "string") {
          msg.timestamp = parseInt(msg.timestamp, 10) || 0;
        } else if (msg.timestamp) {
          msg.timestamp = Number(msg.timestamp) || 0;
        }

        if (msg.attachments && Array.isArray(msg.attachments)) {
          msg.attachments = msg.attachments.map((att) => {
            const data = att._fileManagerData || {};
            // 附件 size 强转数字
            let sizeNum = Number(att.size || 0);
            if (isNaN(sizeNum) || sizeNum < 0) sizeNum = 0;
            return {
              type: att.type || "",
              name: att.name || "unnamed",
              size: sizeNum,
              hash: data.hash || att.hash || null,
              extractedText: data.extractedText || att.extractedText || null,
              imageFrames: data.imageFrames || att.imageFrames || null,
              createdAt: data.createdAt || att.createdAt || null,
            };
          });
        }

        // 计算消息指纹下发，省去手机端重复自算算力
        msg.contentHash = computeMessageFingerprint(msg);

        return msg;
      });

      res.write(JSON.stringify({ topicId, messages: flattened }) + "\n");
      successCount++;
    } catch (e) {
      // 单 topic 失败写错误帧，不中断流
      res.write(JSON.stringify({ topicId, messages: [], _error: e.message }) + "\n");
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

    let localHistory = [];
    try {
      const content = await fs.readFile(historyPath, "utf-8");
      localHistory = JSON.parse(content);
    } catch {}

    const msgMap = new Map(localHistory.map((m) => [m.id, m]));
    const neededAttachmentHashes = new Set();

    for (const msg of messages) {
      const desktopMsg = reconstructMessage(
        msg,
        safeTopicId,
        parentId,
        isGroup,
        db,
        neededAttachmentHashes,
        appDataPath,
      );
      msgMap.set(msg.id, desktopMsg);
    }

    const finalHistory = Array.from(msgMap.values()).sort(
      (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
    );

    // V2: 原子写入，防止并发或异常导致 history.json 损坏
    const tmpPath = `${historyPath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await fs.writeFile(tmpPath, JSON.stringify(finalHistory, null, 2), "utf-8");
    await fs.rename(tmpPath, historyPath);

    return {
      success: true,
      neededAttachmentHashes: Array.from(neededAttachmentHashes),
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

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");
  res.flushHeaders();

  let successCount = 0;
  let errorCount = 0;
  const processedTopicIds = [];
  const addedIntentLocks = new Set();

  const readline = require("readline");
  const rl = readline.createInterface({
    input: req,
    terminal: false,
  });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      
      try {
        const { topicId, messages } = JSON.parse(line);
        const safeTopicId = sanitizeId(topicId);
        
        const row = getEntityIndex(safeTopicId, "topic");
        if (!row) {
          res.write(JSON.stringify({ topicId, success: false, error: "topic not found" }) + "\n");
          errorCount++;
          continue;
        }

        writeIntentLock.add(safeTopicId);
        addedIntentLocks.add(safeTopicId);
        const result = await doUploadSingleTopic(safeTopicId, messages, appDataPath, row);
        res.write(JSON.stringify({ topicId, ...result }) + "\n");
        
        successCount++;
        processedTopicIds.push(safeTopicId);
      } catch (e) {
        logger.logOperation("messages", "upload_batch_stream", "line_parse", "error", e.message);
        errorCount++;
      }
    }

    // 所有 topic 完成后，统一执行一次索引重建
    if (successCount > 0) {
      for (const safeTopicId of processedTopicIds) {
        const row = getEntityIndex(safeTopicId, "topic");
        if (row) {
          const parentId = path.basename(path.dirname(row.file_path));
          const historyPath = path.join(
            appDataPath,
            "UserData",
            parentId,
            "topics",
            safeTopicId,
            "history.json",
          );
          try {
            await ingestHistoryToDb(historyPath, safeTopicId, "batch_push");
          } catch {}
        }
      }

      // 统一触发一次聚合哈希更新
      try {
        const { computeAggregatedHashes } = require("../index");
        computeAggregatedHashes(db, logger);
      } catch {}
    }

    logger.logOperation("messages", "upload_messages_batch_stream", "batch", "success",
      `topics=${processedTopicIds.length} success=${successCount} error=${errorCount}`);
  } catch (e) {
    logger.logOperation("messages", "upload_messages_batch_stream", "global", "error", e.message);
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
 * 重建桌面端消息结构
 */
function reconstructMessage(
  msg,
  topicId,
  parentId,
  isGroup,
  db,
  neededAttachmentHashes,
  appDataPath,
) {
  const role = msg.role || "user";
  const isUser = role === "user";

  const desktopMsg = {
    id: msg.id,
    role: role,
    name: msg.name || (isUser ? "User" : "Assistant"),
    content: msg.content,
    timestamp: msg.timestamp,
  };

  if (isUser && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
    desktopMsg.attachments = msg.attachments.map((att) => {
      const hash = att.hash;
      if (hash) {
        const attRow = db
          .prepare("SELECT file_path FROM attachment_index WHERE hash = ?")
          .get(hash);
        if (!attRow) {
          neededAttachmentHashes.add(hash);
        }
        const desktopPath = attRow ? attRow.file_path : "";
        const ext = desktopPath
          ? path.extname(desktopPath)
          : getExtensionFromType(att.type);

        return createDesktopAttachment(att, desktopPath, ext);
      }
      return att;
    });
  }

  if (!isUser) {
    desktopMsg.isThinking = msg.isThinking ?? false;
    desktopMsg.finishReason = msg.finishReason || "completed";

    const msgAgentId = msg.agentId || (isGroup ? null : parentId);
    if (msgAgentId) desktopMsg.agentId = msgAgentId;

    if (isGroup) {
      desktopMsg.isGroupMessage = true;
      desktopMsg.groupId = msg.groupId || parentId;
      desktopMsg.topicId = msg.topicId || topicId;
    }

    if (msgAgentId) {
      const avatarPath = path.join(
        appDataPath,
        isGroup ? "Agents" : "Agents",
        msgAgentId,
        "avatar.png",
      );
      desktopMsg.avatarUrl = `file://${avatarPath}`;
    }
    desktopMsg.avatarColor = msg.avatarColor || "rgb(128, 128, 128)";
  }

  if (msg.extra && typeof msg.extra === "object") {
    Object.assign(desktopMsg, msg.extra);
  }

  return desktopMsg;
}

/**
 * 将 history.json 摄入到消息索引
 */
async function ingestHistoryToDb(filePath, topicId, source = "watcher") {
  if (topicId === "default") return;
  const db = getDb();
  const logger = getLogger();
  if (!db) return;

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const history = JSON.parse(content);
    const now = Date.now();
    const fingerprints = [];
    let msgCount = 0;
    let attachmentCount = 0;

    // 按 timestamp + id 排序，确保与手机端 ORDER BY timestamp ASC, msg_id ASC 对齐
    const validMessages = history
      .filter((m) => m.status !== "removed" && m.id)
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
          const fileData = att._fileManagerData || {};
          const attHash = fileData.hash || att.hash;
          if (attHash) {
            upsertMessageAttachment(
              m.id,
              attHash,
              index,
              att.name || "unnamed",
              fileData.createdAt || now,
            );
            attachmentCount++;
          }
        });
      }
    }

    // 更新 Topic 聚合哈希 (V2: 统一使用 computeAggregatedHash，确保空列表结果一致)
    const topicRootHash = computeAggregatedHash(fingerprints);
    db.prepare(
      "UPDATE entity_index SET aggregated_hash = ?, updated_at = ? WHERE id = ? AND (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic')",
    ).run(topicRootHash, now, topicId);

    // V2: 触发层级冒泡 (Agent/Group content_hash 更新)
    if (source !== "reconcile") {
      const { computeAggregatedHashes } = require("../index");
      computeAggregatedHashes(db, logger);

      logger.logOperation("messages", "ingest", topicId, "success", `msgs=${msgCount} attachments=${attachmentCount}`);
    }
  } catch (e) {
    logger.logOperation("messages", "ingest", topicId, "error", e.message);
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
  const logger = getLogger();
  const attachmentsDir = path.join(appDataPath, "UserData", "attachments");
  await fs.mkdir(attachmentsDir, { recursive: true });

  const ext = getExtensionFromType(type);
  const filePath = path.join(attachmentsDir, `${hash}${ext}`);

  await fs.writeFile(filePath, data);
  upsertAttachmentIndex(hash, filePath);

  logger.logOperation("messages", "upload_attachment", hash.substring(0, 16), "success", `name=${name}, size=${data.length} bytes`);
  return { success: true };
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
async function pruneMessageFromPhysicalHistory(topicId, msgId) {
  const safeTopicId = sanitizeId(topicId);
  const row = getEntityIndex(safeTopicId, "topic");
  if (!row) return;

  const historyPath = path.join(
    path.dirname(row.file_path),
    "topics",
    safeTopicId,
    "history.json"
  );

  const release = await acquireLock(historyPath);
  try {
    let history = [];
    try {
      const content = await fs.readFile(historyPath, "utf-8");
      history = JSON.parse(content);
    } catch (e) {
      return;
    }

    const filtered = history.filter((m) => m.id !== msgId);
    if (filtered.length !== history.length) {
      const tmpPath = `${historyPath}.tmp_${Date.now()}`;
      await fs.writeFile(tmpPath, JSON.stringify(filtered, null, 2), "utf-8");
      await fs.rename(tmpPath, historyPath);
    }
  } finally {
    release();
  }
}

module.exports = {
  downloadMessagesStreamRaw,
  uploadMessagesBatchRaw,
  uploadAttachment,
  downloadAttachment,
  ingestHistoryToDb,
  pruneMessageFromPhysicalHistory,
};
