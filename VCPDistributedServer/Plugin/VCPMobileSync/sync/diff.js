/**
 * 批量消息差异计算
 * 手机端发送所有 topic 的本地消息哈希，桌面端直接返回需要 pull/push 的结果
 */

const { getDb } = require("../core/db");
const { getLogger } = require("../core/logger");

/**
 * 处理 SYNC_TOPIC_HASH_BATCH
 * @param {object} payload - { hashes: { topicId: contentHash } }
 * @returns {object} { type: "SYNC_TOPIC_HASH_RESULTS", changedTopics: [topicId, ...] }
 */
function handleSyncTopicHashBatch(payload) {
  const db = getDb();
  const logger = getLogger();
  if (!db) {
    logger.logOperation("topic_metadata", "diff_batch", "global", "error", "database not initialized");
    throw Object.assign(new Error("Database not initialized"), {
      code: "SYNC_DB_UNAVAILABLE",
    });
  }

  const hashes = payload.hashes || {};
  const changedTopics = [];
  let matchCount = 0;

  for (const [topicId, localHash] of Object.entries(hashes)) {
    if (topicId === "default") continue;
    try {
      const topicRow = db
        .prepare("SELECT aggregated_hash FROM entity_index WHERE id = ? AND (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic') AND deleted_at IS NULL")
        .get(topicId);

      if (topicRow && topicRow.aggregated_hash !== null && topicRow.aggregated_hash === localHash) {
        matchCount++;
        continue;
      }
      changedTopics.push(topicId);
    } catch (e) {
      throw Object.assign(
        new Error(`Topic hash lookup failed for ${topicId}: ${e.message}`),
        { code: "SYNC_DB_QUERY_FAILED" },
      );
    }
  }

  const total = Object.keys(hashes).length;
  logger.logOperation("topic_metadata", "diff_batch", "summary", "success", `total=${total} match=${matchCount} changed=${changedTopics.length}`);

  return {
    type: "SYNC_TOPIC_HASH_RESULTS",
    changedTopics,
  };
}

/**
 * 处理 SYNC_TOPIC_HASH_BATCH_V2 (V2: 支持双哈希对比)
 * @param {object} payload - { hashes: { topicId: { configHash, contentHash } } }
 */
function handleSyncTopicHashBatchV2(payload) {
  const db = getDb();
  const logger = getLogger();
  if (!db) {
    logger.logOperation("topic_metadata", "diff_batch_v2", "global", "error", "database not initialized");
    throw Object.assign(new Error("Database not initialized"), {
      code: "SYNC_DB_UNAVAILABLE",
    });
  }

  const hashes = payload.hashes || {};
  const changedTopics = [];
  let matchCount = 0;

  for (const [topicId, remoteHashes] of Object.entries(hashes)) {
    if (topicId === "default") continue;
    try {
      const topicRow = db
        .prepare("SELECT hash, aggregated_hash FROM entity_index WHERE id = ? AND (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic') AND deleted_at IS NULL")
        .get(topicId);

      if (!topicRow) {
        changedTopics.push(topicId);
        continue;
      }

      const localConfig = topicRow.hash || "";
      const remoteConfig = remoteHashes.configHash || "";
      const localContent = topicRow.aggregated_hash || "";
      const remoteContent = remoteHashes.contentHash || "";

      if (localConfig === remoteConfig && localContent === remoteContent) {
        matchCount++;
      } else {
        changedTopics.push(topicId);
      }
    } catch (e) {
      throw Object.assign(
        new Error(`Topic hash lookup failed for ${topicId}: ${e.message}`),
        { code: "SYNC_DB_QUERY_FAILED" },
      );
    }
  }

  const total = Object.keys(hashes).length;
  logger.logOperation("topic_metadata", "diff_batch_v2", "summary", "success", `total=${total} match=${matchCount} changed=${changedTopics.length}`);

  return {
    type: "SYNC_TOPIC_HASH_RESULTS",
    changedTopics,
  };
}

/**
 * 处理 SYNC_MESSAGE_DIFF_BATCH
 * @param {object} payload - { topics: { topicId: { topicHash, messages: { msgId: hash } } } }
 * @returns {object} { type: "SYNC_DIFF_RESULTS_BATCH", results: { topicId: { toPull, toPush } } }
 */
function handleSyncMessageDiffBatch(payload, database = getDb()) {
  const db = database;
  const logger = getLogger();
  if (!db) {
    logger.logOperation("messages", "diff_batch", "global", "error", "database not initialized");
    throw Object.assign(new Error("Database not initialized"), {
      code: "SYNC_DB_UNAVAILABLE",
    });
  }

  const results = {};
  const topics = payload?.topics;
  if (
    !topics ||
    typeof topics !== "object" ||
    Array.isArray(topics)
  ) {
    throw Object.assign(new Error("SYNC_MESSAGE_DIFF_BATCH.topics must be an object"), {
      code: "SYNC_PROTOCOL_INVALID",
    });
  }
  const topicIds = Object.keys(topics);
  if (topicIds.length > 10_000) {
    throw Object.assign(new Error("Message diff exceeds 10000 topics"), {
      code: "SYNC_BUDGET_EXCEEDED",
    });
  }
  let fastPathCount = 0;
  let detailedCount = 0;
  let messageCount = 0;

  for (const [topicId, localState] of Object.entries(topics)) {
    if (
      !topicId ||
      topicId === "default" ||
      !localState ||
      typeof localState !== "object" ||
      Array.isArray(localState) ||
      typeof localState.topicHash !== "string" ||
      !localState.messages ||
      typeof localState.messages !== "object" ||
      Array.isArray(localState.messages)
    ) {
      throw Object.assign(new Error(`Invalid message diff state for topic ${topicId}`), {
        code: "SYNC_PROTOCOL_INVALID",
      });
    }
    const localEntries = Object.entries(localState.messages);
    messageCount += localEntries.length;
    if (localEntries.length > 10_000 || messageCount > 100_000) {
      throw Object.assign(new Error("Message diff exceeds its message count budget"), {
        code: "SYNC_BUDGET_EXCEEDED",
      });
    }
    for (const [msgId, hash] of localEntries) {
      if (
        !msgId ||
        typeof hash !== "string" ||
        (hash !== "DELETED" && !/^[a-f0-9]{64}$/.test(hash))
      ) {
        throw Object.assign(
          new Error(`Invalid message diff entry ${topicId}/${msgId}`),
          { code: "SYNC_PROTOCOL_INVALID" },
        );
      }
    }
    try {
      // 1. 快速路径：比较 topic 级 aggregated_hash
      const topicRow = db
        .prepare("SELECT aggregated_hash FROM entity_index WHERE id = ? AND (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic') AND deleted_at IS NULL")
        .get(topicId);

      if (!topicRow) {
        results[topicId] = {
          ok: false,
          error: {
            code: "TOPIC_NOT_FOUND",
            message: `Topic ${topicId} was not found in the desktop index`,
          },
        };
        continue;
      }

      if (topicRow.aggregated_hash !== null && topicRow.aggregated_hash === localState.topicHash) {
        results[topicId] = { ok: true, toPull: [], toPush: false };
        fastPathCount++;
        // fast-path 的 topic 不输出单条日志，避免日志噪音
        continue;
      }

      // 2. 详细比较：读取桌面端 message_index (过滤已被软删除的消息指纹)
      const remoteRows = db
        .prepare("SELECT msg_id, hash FROM message_index WHERE topic_id = ? AND deleted_at IS NULL")
        .all(topicId);

      const remoteMap = new Map(remoteRows.map((r) => [r.msg_id, r.hash]));
      const localMap = localState.messages;

      const toPull = [];
      let toPush = false;

      for (const [msgId, remoteHash] of remoteMap) {
        const localHash = localMap[msgId];
        
        if (localHash === "DELETED") continue;

        if (!localHash) {
          toPull.push(msgId);
        } else if (localHash !== remoteHash) {
          toPull.push(msgId);
        }
      }

      // 本地有而远程没有的 → push
      for (const msgId of Object.keys(localMap)) {
        if (localMap[msgId] !== "DELETED" && !remoteMap.has(msgId)) {
          toPush = true;
          break;
        }
      }

      results[topicId] = { ok: true, toPull, toPush };
      detailedCount++;
      logger.logOperation("messages", "diff", topicId, "success", `toPull=${toPull.length} toPush=${toPush}`);
    } catch (e) {
      logger.logOperation("messages", "diff", topicId, "error", e.message);
      results[topicId] = {
        ok: false,
        error: {
          code: "MESSAGE_DIFF_FAILED",
          message: e.message,
        },
      };
    }
  }

  logger.logOperation("messages", "diff_batch", "summary", "success", `topics=${topicIds.length} fast_path=${fastPathCount} detailed=${detailedCount}`);

  return {
    type: "SYNC_DIFF_RESULTS_BATCH",
    results,
  };
}

module.exports = {
  handleSyncTopicHashBatch,
  handleSyncTopicHashBatchV2,
  handleSyncMessageDiffBatch,
};
