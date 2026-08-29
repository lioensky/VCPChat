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

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CONTENT_HASH_PATTERN = /^(?:|[a-f0-9]{64})$/;

function topicIdentity(value) {
  return `${value.ownerType}\0${value.ownerId}\0${value.topicId}`;
}

function requireCompoundTopicStates(payload) {
  if (!Array.isArray(payload?.topics)) {
    throw Object.assign(
      new Error("SYNC_TOPIC_DIFF_REQUEST.topics must be an array"),
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
      !HASH_PATTERN.test(state.configHash) ||
      !CONTENT_HASH_PATTERN.test(state.contentHash) ||
      Object.keys(state).sort().join("\0") !==
        "configHash\0contentHash\0ownerId\0ownerType\0topicId"
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
 * 处理 SYNC_TOPIC_DIFF_REQUEST
 * @param {object} payload - { topics: [{topicId,ownerType,ownerId,configHash,contentHash}] }
 */
function handleSyncTopicDiff(payload, database = getDb()) {
  const topicStates = requireCompoundTopicStates(payload);
  const db = database;
  const logger = getLogger();
  if (!db) {
    logger.logOperation("topic_metadata", "topic_diff", "global", "error", "database not initialized");
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
          `SELECT config_hash, content_hash FROM topics
           WHERE owner_type = ? AND owner_id = ? AND topic_id = ?
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

      const localConfig = topicRow.config_hash || "";
      const remoteConfig = state.configHash || "";
      const localContent = topicRow.content_hash || "";
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
  logger.logOperation("topic_metadata", "topic_diff", "summary", "success", `total=${total} match=${matchCount} changed=${changedTopics.length}`);

  return {
    type: "SYNC_TOPIC_DIFF_RESULT",
    changedTopics,
  };
}

function isMessageTombstone(state) {
  return Object.prototype.hasOwnProperty.call(state, "deletedAt");
}

function validateMessageState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const keys = Object.keys(state);
  if (isMessageTombstone(state)) {
    return keys.length === 1 && Number.isSafeInteger(state.deletedAt) && state.deletedAt >= 0;
  }
  return (
    keys.length === 2 &&
    keys.includes("messageHash") &&
    keys.includes("updatedAt") &&
    typeof state.messageHash === "string" &&
    /^[a-f0-9]{64}$/.test(state.messageHash) &&
    Number.isSafeInteger(state.updatedAt) &&
    state.updatedAt >= 0
  );
}

function requireMessageDiffStates(payload) {
  if (!Array.isArray(payload?.topics)) {
    throw Object.assign(new Error("SYNC_MESSAGE_DIFF_REQUEST.topics must be an array"), {
      code: "SYNC_PROTOCOL_INVALID",
    });
  }
  const topics = payload.topics;
  if (topics.length > 10_000) {
    throw Object.assign(new Error("Message diff exceeds 10000 topics"), {
      code: "SYNC_BUDGET_EXCEEDED",
    });
  }
  const seenTopics = new Set();
  let messageCount = 0;
  for (const localState of topics) {
    const topicId = localState?.topicId;
    if (
      !topicId ||
      !localState ||
      typeof localState !== "object" ||
      Array.isArray(localState) ||
      typeof localState.contentHash !== "string" ||
      !CONTENT_HASH_PATTERN.test(localState.contentHash) ||
      !["agent", "group"].includes(localState.ownerType) ||
      typeof localState.ownerId !== "string" ||
      localState.ownerId.length === 0 ||
      !localState.messages ||
      typeof localState.messages !== "object" ||
      Array.isArray(localState.messages) ||
      Object.keys(localState).sort().join("\0") !==
        "contentHash\0messages\0ownerId\0ownerType\0topicId"
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
    const localEntries = Object.entries(localState.messages);
    messageCount += localEntries.length;
    if (localEntries.length > 10_000 || messageCount > 100_000) {
      throw Object.assign(new Error("Message diff exceeds its message count budget"), {
        code: "SYNC_BUDGET_EXCEEDED",
      });
    }
    for (const [msgId, state] of localEntries) {
      if (!msgId || !validateMessageState(state)) {
        throw Object.assign(
          new Error(`Invalid message diff entry ${topicId}/${msgId}`),
          { code: "SYNC_PROTOCOL_INVALID" },
        );
      }
    }
  }
  return topics;
}

/**
 * 处理 SYNC_MESSAGE_DIFF_REQUEST
 * @param {object} payload - { topics: [{topicId,ownerType,ownerId,contentHash,messages}] }
 * @returns {object} strict per-topic results carrying the full topic identity
 */
function handleSyncMessageDiff(payload, database = getDb()) {
  const topics = requireMessageDiffStates(payload);
  const db = database;
  const logger = getLogger();
  if (!db) {
    logger.logOperation("messages", "diff_batch", "global", "error", "database not initialized");
    throw Object.assign(new Error("Database not initialized"), {
      code: "SYNC_DB_UNAVAILABLE",
    });
  }

  const results = [];
  let fastPathCount = 0;
  let detailedCount = 0;

  for (const localState of topics) {
    const topicId = localState.topicId;
    const resultIdentity = {
      topicId,
      ownerType: localState.ownerType,
      ownerId: localState.ownerId,
    };
    try {
      assertHistoryTopicHealthy({
        topicId,
        ownerType: localState.ownerType,
        ownerId: localState.ownerId,
      });
      // 1. 快速路径：比较 Topic 内容 Hash
      const topicRow = db
        .prepare(
          `SELECT content_hash FROM topics
           WHERE owner_type = ? AND owner_id = ? AND topic_id = ?
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
        isMessageTombstone,
      );
      if (
        topicRow.content_hash !== null &&
        topicRow.content_hash === localState.contentHash &&
        !mobileHasTombstones
      ) {
        results.push({
          ...resultIdentity,
          ok: true,
          pullMessageIds: [],
          pushTopic: false,
          deleteMessages: [],
        });
        fastPathCount++;
        // fast-path 的 topic 不输出单条日志，避免日志噪音
        continue;
      }

      // 2. 详细比较：墓碑必须参与四象限裁决，不能被 live-only 查询吞掉。
      const remoteRows = db
        .prepare(
          `SELECT msg_id, message_hash AS hash, updated_at, deleted_at FROM messages
           WHERE owner_type = ? AND owner_id = ? AND topic_id = ?`,
        )
        .all(localState.ownerType, localState.ownerId, topicId);

      const remoteMap = new Map(remoteRows.map((row) => [row.msg_id, row]));
      const localMap = localState.messages;

      const pullMessageIds = [];
      const deleteMessages = [];
      let pushTopic = false;

      for (const [msgId, remote] of remoteMap) {
        const local = localMap[msgId];
        const localDeleted = local ? isMessageTombstone(local) : false;
        const localHash = local?.messageHash;
        const remoteDeleted = remote.deleted_at !== null && remote.deleted_at !== undefined;
        if (
          remoteDeleted &&
          (!Number.isSafeInteger(remote.deleted_at) || remote.deleted_at < 0)
        ) {
          throw new Error(`Invalid desktop tombstone for ${topicId}/${msgId}`);
        }

        if (remoteDeleted) {
          if (local && !localDeleted) {
            deleteMessages.push({ msgId, deletedAt: remote.deleted_at });
          }
          continue;
        }

        if (localDeleted) {
          // Mobile owns the tombstone timestamp, so let the existing push path
          // send its durable delete instead of reviving the desktop live row.
          pushTopic = true;
          continue;
        }

        if (!local) {
          pullMessageIds.push(msgId);
        } else if (localHash !== remote.hash) {
          if (!Number.isSafeInteger(remote.updated_at) || remote.updated_at < 0) {
            throw new Error(`Invalid desktop update time for ${topicId}/${msgId}`);
          }
          if (
            remote.updated_at > local.updatedAt ||
            (remote.updated_at === local.updatedAt && remote.hash > localHash)
          ) {
            pullMessageIds.push(msgId);
          } else {
            pushTopic = true;
          }
        }
      }

      // Desktop missing cannot absorb a Mobile tombstone silently: push it so
      // the desktop persists the deletion fact for later peers.
      for (const msgId of Object.keys(localMap)) {
        if (!remoteMap.has(msgId)) {
          pushTopic = true;
        }
      }

      pullMessageIds.sort((left, right) => left.localeCompare(right));
      deleteMessages.sort((left, right) => left.msgId.localeCompare(right.msgId));
      results.push({
        ...resultIdentity,
        ok: true,
        pullMessageIds,
        pushTopic,
        deleteMessages,
      });
      detailedCount++;
      logger.logOperation(
        "messages",
        "diff",
        topicId,
        "success",
        `pull=${pullMessageIds.length} pushTopic=${pushTopic} delete=${deleteMessages.length}`,
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
    type: "SYNC_MESSAGE_DIFF_RESULT",
    results,
  };
}

module.exports = {
  handleSyncTopicDiff,
  handleSyncMessageDiff,
  requireCompoundTopicStates,
  requireMessageDiffStates,
};
