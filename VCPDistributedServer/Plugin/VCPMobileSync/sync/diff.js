/**
 * 批量消息差异计算
 * 手机端发送所有 topic 的本地消息哈希，桌面端直接返回需要 pull/push 的结果
 */

const { getDb } = require("../core/db");
const { getLogger } = require("../core/logger");
const { assertHistoryTopicHealthy } = require("./message");
const {
  normalizeSyncError,
  withSyncErrorContext,
} = require("../error-contract");

const CONTENT_HASH_PATTERN = /^(?:|[a-f0-9]{64})$/;

function topicIdentity(value) {
  return `${value.ownerType}\0${value.ownerId}\0${value.topicId}`;
}

function requireCompoundTopicStates(payload) {
  if (!Array.isArray(payload?.topics)) {
    throw Object.assign(
      new Error("SYNC_TOPIC_HASH_BATCH_V2.topics must be an array"),
      { code: "SYNC_PROTOCOL_INVALID" },
    );
  }
  const topicStates = payload.topics;
  if (topicStates.length > 10_000) {
    throw Object.assign(new Error("Topic hash batch exceeds 10000 topics"), {
      code: "SYNC_BUDGET_EXCEEDED",
    });
  }
  const states = new Map();
  for (const state of topicStates) {
    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      typeof state.topicId !== "string" ||
      state.topicId.length === 0 ||
      !["agent", "group"].includes(state.ownerType) ||
      typeof state.ownerId !== "string" ||
      state.ownerId.length === 0 ||
      typeof state.configHash !== "string" ||
      typeof state.contentHash !== "string" ||
      !CONTENT_HASH_PATTERN.test(state.configHash) ||
      !CONTENT_HASH_PATTERN.test(state.contentHash)
    ) {
      throw Object.assign(new Error("Invalid compound topic hash state"), {
        code: "SYNC_PROTOCOL_INVALID",
      });
    }
    const identity = topicIdentity(state);
    if (states.has(identity)) {
      throw Object.assign(new Error("Duplicate compound topic hash state"), {
        code: "SYNC_PROTOCOL_INVALID",
      });
    }
    states.set(identity, state);
  }
  return [...states.values()];
}

/**
 * 处理 SYNC_TOPIC_HASH_BATCH_V2 (V2: 支持双哈希对比)
 * @param {object} payload - { topics: [{topicId,ownerType,ownerId,configHash,contentHash}] }
 */
function handleSyncTopicHashBatchV2(payload, database = getDb()) {
  const topicStates = requireCompoundTopicStates(payload);
  const db = database;
  const logger = getLogger();
  if (!db) {
    logger.logOperation("topic_metadata", "diff_batch_v2", "global", "error", "database not initialized");
    throw Object.assign(new Error("Database not initialized"), {
      code: "SYNC_DB_UNAVAILABLE",
    });
  }

  const changedTopics = [];
  let matchCount = 0;

  for (const state of topicStates) {
    const topicId = state.topicId;
    try {
      assertHistoryTopicHealthy({
        topicId,
        ownerType: state.ownerType,
        ownerId: state.ownerId,
      });
      const topicRow = db
        .prepare(
          `SELECT hash, aggregated_hash FROM entity_index
           WHERE type = 'topic' AND owner_type = ? AND owner_id = ? AND id = ?
             AND deleted_at IS NULL`,
        )
        .get(state.ownerType, state.ownerId, topicId);

      if (!topicRow) {
        changedTopics.push({
          topicId,
          ownerType: state.ownerType,
          ownerId: state.ownerId,
        });
        continue;
      }

      const localConfig = topicRow.hash || "";
      const remoteConfig = state.configHash || "";
      const localContent = topicRow.aggregated_hash || "";
      const remoteContent = state.contentHash || "";

      if (localConfig === remoteConfig && localContent === remoteContent) {
        matchCount++;
      } else {
        changedTopics.push({
          topicId,
          ownerType: state.ownerType,
          ownerId: state.ownerId,
        });
      }
    } catch (e) {
      throw withSyncErrorContext(e, {
        code: "SYNC_DB_QUERY_FAILED",
        stage: "topic_validation",
        failedTopicIds: [topicId],
      });
    }
  }

  changedTopics.sort((left, right) =>
    topicIdentity(left).localeCompare(topicIdentity(right))
  );
  const total = topicStates.length;
  logger.logOperation("topic_metadata", "diff_batch_v2", "summary", "success", `total=${total} match=${matchCount} changed=${changedTopics.length}`);

  return {
    type: "SYNC_TOPIC_HASH_RESULTS",
    changedTopics,
  };
}

/**
 * 处理 SYNC_MESSAGE_DIFF_BATCH
 * @param {object} payload - { topics: [{topicId,ownerType,ownerId,topicHash,messages}] }
 * @returns {object} strict per-topic results carrying the full topic identity
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

  const results = [];
  const topics = payload?.topics;
  if (!Array.isArray(topics)) {
    throw Object.assign(new Error("SYNC_MESSAGE_DIFF_BATCH.topics must be an array"), {
      code: "SYNC_PROTOCOL_INVALID",
    });
  }
  if (topics.length > 10_000) {
    throw Object.assign(new Error("Message diff exceeds 10000 topics"), {
      code: "SYNC_BUDGET_EXCEEDED",
    });
  }
  const seenTopics = new Set();
  let fastPathCount = 0;
  let detailedCount = 0;
  let messageCount = 0;

  for (const localState of topics) {
    const topicId = localState?.topicId;
    if (
      !topicId ||
      !localState ||
      typeof localState !== "object" ||
      Array.isArray(localState) ||
      typeof localState.topicHash !== "string" ||
      !CONTENT_HASH_PATTERN.test(localState.topicHash) ||
      !["agent", "group"].includes(localState.ownerType) ||
      typeof localState.ownerId !== "string" ||
      localState.ownerId.length === 0 ||
      !localState.messages ||
      typeof localState.messages !== "object" ||
      Array.isArray(localState.messages)
    ) {
      throw Object.assign(new Error(`Invalid message diff state for topic ${topicId}`), {
        code: "SYNC_PROTOCOL_INVALID",
      });
    }
    const identity = topicIdentity(localState);
    if (seenTopics.has(identity)) {
      throw Object.assign(new Error("Duplicate message diff topic identity"), {
        code: "SYNC_PROTOCOL_INVALID",
      });
    }
    seenTopics.add(identity);
    const resultIdentity = {
      topicId,
      ownerType: localState.ownerType,
      ownerId: localState.ownerId,
    };
    const localEntries = Object.entries(localState.messages);
    messageCount += localEntries.length;
    if (localEntries.length > 10_000 || messageCount > 100_000) {
      throw Object.assign(new Error("Message diff exceeds its message count budget"), {
        code: "SYNC_BUDGET_EXCEEDED",
      });
    }
    for (const [msgId, state] of localEntries) {
      if (
        !msgId ||
        !state ||
        typeof state !== "object" ||
        Array.isArray(state) ||
        typeof state.hash !== "string" ||
        (state.hash !== "DELETED" && !/^[a-f0-9]{64}$/.test(state.hash)) ||
        !Number.isSafeInteger(state.updatedAt) ||
        state.updatedAt < 0
      ) {
        throw Object.assign(
          new Error(`Invalid message diff entry ${topicId}/${msgId}`),
          { code: "SYNC_PROTOCOL_INVALID" },
        );
      }
    }
    try {
      assertHistoryTopicHealthy({
        topicId,
        ownerType: localState.ownerType,
        ownerId: localState.ownerId,
      });
      // 1. 快速路径：比较 topic 级 aggregated_hash
      const topicRow = db
        .prepare(
          `SELECT aggregated_hash FROM entity_index
           WHERE type = 'topic' AND owner_type = ? AND owner_id = ? AND id = ?
             AND deleted_at IS NULL`,
        )
        .get(localState.ownerType, localState.ownerId, topicId);

      if (!topicRow) {
        results.push({
          ...resultIdentity,
          ok: false,
          error: normalizeSyncError(
            `Topic ${topicId} was not found in the desktop index`,
            {
              code: "TOPIC_NOT_FOUND",
              stage: "messages",
              failedTopicIds: [topicId],
            },
          ),
        });
        continue;
      }

      const mobileHasTombstones = Object.values(localState.messages).some(
        (state) => state.hash === "DELETED",
      );
      if (
        topicRow.aggregated_hash !== null &&
        topicRow.aggregated_hash === localState.topicHash &&
        !mobileHasTombstones
      ) {
        results.push({
          ...resultIdentity,
          ok: true,
          toPull: [],
          toPush: false,
          toDelete: [],
        });
        fastPathCount++;
        // fast-path 的 topic 不输出单条日志，避免日志噪音
        continue;
      }

      // 2. 详细比较：墓碑必须参与四象限裁决，不能被 live-only 查询吞掉。
      const remoteRows = db
        .prepare(
          `SELECT msg_id, hash, updated_at, deleted_at FROM message_index
           WHERE owner_type = ? AND owner_id = ? AND topic_id = ?`,
        )
        .all(localState.ownerType, localState.ownerId, topicId);

      const remoteMap = new Map(remoteRows.map((row) => [row.msg_id, row]));
      const localMap = localState.messages;

      const toPull = [];
      const toDelete = [];
      let toPush = false;

      for (const [msgId, remote] of remoteMap) {
        const local = localMap[msgId];
        const localHash = local?.hash;
        const remoteDeleted = remote.deleted_at !== null && remote.deleted_at !== undefined;
        if (
          remoteDeleted &&
          (!Number.isSafeInteger(remote.deleted_at) || remote.deleted_at < 0)
        ) {
          throw new Error(`Invalid desktop tombstone for ${topicId}/${msgId}`);
        }

        if (remoteDeleted) {
          if (local && localHash !== "DELETED") {
            toDelete.push({ msgId, deletedAt: remote.deleted_at });
          }
          continue;
        }

        if (localHash === "DELETED") {
          // Mobile owns the tombstone timestamp, so let the existing push path
          // send its durable delete instead of reviving the desktop live row.
          toPush = true;
          continue;
        }

        if (!local) {
          toPull.push(msgId);
        } else if (localHash !== remote.hash) {
          if (!Number.isSafeInteger(remote.updated_at) || remote.updated_at < 0) {
            throw new Error(`Invalid desktop update time for ${topicId}/${msgId}`);
          }
          if (
            remote.updated_at > local.updatedAt ||
            (remote.updated_at === local.updatedAt && remote.hash > localHash)
          ) {
            toPull.push(msgId);
          } else {
            toPush = true;
          }
        }
      }

      // Desktop missing cannot absorb a Mobile tombstone silently: push it so
      // the desktop persists the deletion fact for later peers.
      for (const msgId of Object.keys(localMap)) {
        if (!remoteMap.has(msgId)) {
          toPush = true;
        }
      }

      toPull.sort((left, right) => left.localeCompare(right));
      toDelete.sort((left, right) => left.msgId.localeCompare(right.msgId));
      results.push({ ...resultIdentity, ok: true, toPull, toPush, toDelete });
      detailedCount++;
      logger.logOperation(
        "messages",
        "diff",
        topicId,
        "success",
        `toPull=${toPull.length} toPush=${toPush} toDelete=${toDelete.length}`,
      );
    } catch (e) {
      logger.logOperation("messages", "diff", topicId, "error", e.message);
      results.push({
        ...resultIdentity,
        ok: false,
        error: normalizeSyncError(e, {
          code: "MESSAGE_DIFF_FAILED",
          stage: "messages",
          failedTopicIds: [topicId],
        }),
      });
    }
  }

  logger.logOperation("messages", "diff_batch", "summary", "success", `topics=${topics.length} fast_path=${fastPathCount} detailed=${detailedCount}`);

  return {
    type: "SYNC_DIFF_RESULTS_BATCH",
    results,
  };
}

module.exports = {
  handleSyncTopicHashBatchV2,
  handleSyncMessageDiffBatch,
};
