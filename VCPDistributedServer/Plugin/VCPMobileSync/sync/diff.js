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

function requireTopicHashMap(payload, { doubleHash = false } = {}) {
  const hashes = payload?.hashes;
  if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) {
    throw Object.assign(new Error("SYNC_TOPIC_HASH_BATCH.hashes must be an object"), {
      code: "SYNC_PROTOCOL_INVALID",
    });
  }
  const receivedEntries = Object.entries(hashes);
  if (receivedEntries.length > 10_000) {
    throw Object.assign(new Error("Topic hash batch exceeds 10000 topics"), {
      code: "SYNC_BUDGET_EXCEEDED",
    });
  }
  const entries = receivedEntries.filter(([topicId]) => topicId !== "default");
  for (const [topicId, value] of entries) {
    if (!topicId) {
      throw Object.assign(new Error("Topic hash batch contains an invalid topic id"), {
        code: "SYNC_PROTOCOL_INVALID",
      });
    }
    const valid = doubleHash
      ? value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof value.configHash === "string" &&
        typeof value.contentHash === "string" &&
        CONTENT_HASH_PATTERN.test(value.configHash) &&
        CONTENT_HASH_PATTERN.test(value.contentHash)
      : typeof value === "string" && CONTENT_HASH_PATTERN.test(value);
    if (!valid) {
      throw Object.assign(new Error(`Invalid topic hash state for ${topicId}`), {
        code: "SYNC_PROTOCOL_INVALID",
      });
    }
  }
  return { hashes: Object.fromEntries(entries), entries };
}

function requireCompoundTopicStates(payload, entries) {
  if (!Array.isArray(payload?.topics)) {
    throw Object.assign(
      new Error("SYNC_TOPIC_HASH_BATCH_V2.topics must exactly cover hashes"),
      { code: "SYNC_PROTOCOL_INVALID" },
    );
  }
  const topicStates = payload.topics.filter((state) => state?.topicId !== "default");
  if (topicStates.length !== entries.length) {
    throw Object.assign(
      new Error("SYNC_TOPIC_HASH_BATCH_V2.topics must exactly cover hashes"),
      { code: "SYNC_PROTOCOL_INVALID" },
    );
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
      !CONTENT_HASH_PATTERN.test(state.contentHash) ||
      states.has(state.topicId)
    ) {
      throw Object.assign(new Error("Invalid or duplicate compound topic hash state"), {
        code: "SYNC_PROTOCOL_INVALID",
      });
    }
    states.set(state.topicId, state);
  }
  for (const [topicId, hashes] of entries) {
    const state = states.get(topicId);
    if (
      !state ||
      state.configHash !== hashes.configHash ||
      state.contentHash !== hashes.contentHash
    ) {
      throw Object.assign(
        new Error(`Compound topic hash state conflicts for ${topicId}`),
        { code: "SYNC_PROTOCOL_INVALID" },
      );
    }
  }
  return states;
}

function indexedTopicOwner(filePath) {
  const parts = String(filePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  const ownerId = parts.at(-2);
  const ownerType = parts.includes("AgentGroups")
    ? "group"
    : parts.includes("Agents")
      ? "agent"
      : null;
  if (!ownerType || !ownerId) {
    throw Object.assign(new Error("Topic index has an invalid owner path"), {
      code: "SYNC_INDEX_INVALID",
    });
  }
  return { ownerType, ownerId };
}

/**
 * 处理 SYNC_TOPIC_HASH_BATCH
 * @param {object} payload - { hashes: { topicId: contentHash } }
 * @returns {object} { type: "SYNC_TOPIC_HASH_RESULTS", changedTopics: [topicId, ...] }
 */
function handleSyncTopicHashBatch(payload, database = getDb()) {
  const { hashes, entries } = requireTopicHashMap(payload);
  const db = database;
  const logger = getLogger();
  if (!db) {
    logger.logOperation("topic_metadata", "diff_batch", "global", "error", "database not initialized");
    throw Object.assign(new Error("Database not initialized"), {
      code: "SYNC_DB_UNAVAILABLE",
    });
  }

  const changedTopics = [];
  let matchCount = 0;

  for (const [topicId, localHash] of entries) {
    if (topicId === "default") continue;
    assertHistoryTopicHealthy(topicId);
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
      throw withSyncErrorContext(e, {
        code: "SYNC_DB_QUERY_FAILED",
        stage: "topic_validation",
        failedTopicIds: [topicId],
      });
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
function handleSyncTopicHashBatchV2(payload, database = getDb()) {
  const { hashes, entries } = requireTopicHashMap(payload, {
    doubleHash: true,
  });
  const topicStates = requireCompoundTopicStates(payload, entries);
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

  for (const [topicId, remoteHashes] of entries) {
    if (topicId === "default") continue;
    assertHistoryTopicHealthy(topicId);
    try {
      const topicRow = db
        .prepare("SELECT hash, aggregated_hash, file_path FROM entity_index WHERE id = ? AND (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic') AND deleted_at IS NULL")
        .get(topicId);

      if (!topicRow) {
        changedTopics.push(topicId);
        continue;
      }

      const expectedOwner = topicStates.get(topicId);
      const actualOwner = indexedTopicOwner(topicRow.file_path);
      if (
        actualOwner.ownerType !== expectedOwner.ownerType ||
        actualOwner.ownerId !== expectedOwner.ownerId
      ) {
        throw Object.assign(
          new Error(`Topic hash owner identity conflicts for ${topicId}`),
          { code: "SYNC_OWNER_CONFLICT" },
        );
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
      throw withSyncErrorContext(e, {
        code: "SYNC_DB_QUERY_FAILED",
        stage: "topic_validation",
        failedTopicIds: [topicId],
      });
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
 * @param {object} payload - { topics: { topicId: { topicHash, messages: { msgId: {hash,updatedAt} } } } }
 * @returns {object} strict discriminated results: `{ok:true,toPull,toPush,toDelete}` or `{ok:false,error}`
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
    if (topicId === "default") {
      results[topicId] = {
        ok: true,
        toPull: [],
        toPush: false,
        toDelete: [],
      };
      continue;
    }
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
      assertHistoryTopicHealthy(topicId);
      // 1. 快速路径：比较 topic 级 aggregated_hash
      const topicRow = db
        .prepare("SELECT aggregated_hash, file_path FROM entity_index WHERE id = ? AND (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic') AND deleted_at IS NULL")
        .get(topicId);

      if (!topicRow) {
        results[topicId] = {
          ok: false,
          error: normalizeSyncError(
            `Topic ${topicId} was not found in the desktop index`,
            {
              code: "TOPIC_NOT_FOUND",
              stage: "messages",
              failedTopicIds: [topicId],
            },
          ),
        };
        continue;
      }

      const actualOwner = indexedTopicOwner(topicRow.file_path);
      if (
        actualOwner.ownerType !== localState.ownerType ||
        actualOwner.ownerId !== localState.ownerId
      ) {
        throw Object.assign(
          new Error(`Message diff owner identity conflicts for ${topicId}`),
          { code: "SYNC_OWNER_CONFLICT" },
        );
      }

      const mobileHasTombstones = Object.values(localState.messages).some(
        (state) => state.hash === "DELETED",
      );
      if (
        topicRow.aggregated_hash !== null &&
        topicRow.aggregated_hash === localState.topicHash &&
        !mobileHasTombstones
      ) {
        results[topicId] = {
          ok: true,
          toPull: [],
          toPush: false,
          toDelete: [],
        };
        fastPathCount++;
        // fast-path 的 topic 不输出单条日志，避免日志噪音
        continue;
      }

      // 2. 详细比较：墓碑必须参与四象限裁决，不能被 live-only 查询吞掉。
      const remoteRows = db
        .prepare("SELECT msg_id, hash, updated_at, deleted_at FROM message_index WHERE topic_id = ?")
        .all(topicId);

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
      results[topicId] = { ok: true, toPull, toPush, toDelete };
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
      results[topicId] = {
        ok: false,
        error: normalizeSyncError(e, {
          code: "MESSAGE_DIFF_FAILED",
          stage: "messages",
          failedTopicIds: [topicId],
        }),
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
