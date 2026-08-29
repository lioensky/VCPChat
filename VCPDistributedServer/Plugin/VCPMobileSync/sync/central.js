"use strict";

const { getDb } = require("../core/db");
const { getLogger } = require("../core/logger");
const { parseJsonWithoutDuplicateKeys } = require("../protocol");
const { SyncProtocolError, canonicalizeTopicFrame } = require("./canonical");
const {
  requireCompoundTopicStates,
  requireMessageDiffStates,
} = require("./diff");
const { validateSyncManifestRequest } = require("./manifest");
const { projectMobileTopic } = require("./projection");
const {
  createSyncError,
  normalizeSyncError,
  withSyncErrorContext,
} = require("../error-contract");
const {
  MAX_NDJSON_MESSAGES,
  MAX_NDJSON_TOPICS,
  NdjsonWriter,
  decodeNdjsonLine,
  readNdjsonLines,
} = require("../transport/ndjson");

function withCdsErrorContext(error, fallback = {}) {
  let root = error;
  if (error?.code === "PROTOCOL_MISMATCH") {
    root = Object.assign(new Error(error.message), error, {
      code: "CDS_PROTOCOL_MISMATCH",
    });
  }
  // CDS 错误层会把根因剥离后才上 HTTP（wire 上只剩 code/message/retryable）。
  // 在翻译前把边界可见的全部证据（HTTP status / retryable / 原始 message）
  // 落进插件日志，否则桌面侧无从区分"数据状态异常"与"CDS 内部故障"。
  try {
    const rawMessage = typeof root?.message === "string" ? root.message : "";
    getLogger().logOperation(
      fallback.stage || "central",
      "cds_error",
      String(root?.code || fallback.code || "UNKNOWN"),
      "error",
      `status=${root?.status ?? "n/a"} retryable=${root?.retryable ?? "n/a"} ${rawMessage.slice(0, 300)}`,
    );
  } catch {
    // 日志通道失败不得影响错误传播
  }
  return withSyncErrorContext(root, {
    ...fallback,
    origin: "desktop_cds",
  });
}

function cdsProtocolError(message, stage, failedTopicIds = []) {
  return createSyncError("SYNC_PROTOCOL_INVALID", message, {
    origin: "desktop_cds",
    stage,
    failedTopicIds,
  });
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCdsItemError(value) {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean" &&
    Object.keys(value).length === 3
  );
}

function mapCdsItemError(error, code, context = {}) {
  if (!isCdsItemError(error)) {
    throw cdsProtocolError(
      "CDS returned an invalid item error",
      context.stage || "startup",
      context.failedTopicIds || [],
    );
  }
  return normalizeSyncError(
    { code, message: error.message },
    { ...context, code },
  );
}

function topicIdentityKey(value) {
  if (
    !isRecord(value) ||
    typeof value.topicId !== "string" ||
    value.topicId.length === 0 ||
    !["agent", "group"].includes(value.ownerType) ||
    typeof value.ownerId !== "string" ||
    value.ownerId.length === 0
  ) {
    return null;
  }
  return `${value.ownerType}\0${value.ownerId}\0${value.topicId}`;
}

function entityIdentityKey(value) {
  if (
    !isRecord(value) ||
    !["agent", "group"].includes(value.ownerType) ||
    typeof value.ownerId !== "string" ||
    value.ownerId.length === 0
  ) {
    return null;
  }
  if (value.entityType === "owner" && value.topicId === undefined) {
    return `owner\0${value.ownerType}\0${value.ownerId}`;
  }
  if (
    value.entityType === "topic" &&
    typeof value.topicId === "string" &&
    value.topicId.length > 0
  ) {
    return `topic\0${value.ownerType}\0${value.ownerId}\0${value.topicId}`;
  }
  return null;
}

function isAvatarIdentity(ownerType, ownerId) {
  return (
    ["agent", "group", "user"].includes(ownerType) &&
    typeof ownerId === "string" &&
    /^[a-zA-Z0-9_-]+$/.test(ownerId) &&
    (ownerType !== "user" || ownerId === "user_avatar")
  );
}

function validateAvatarState(value, ownerType, ownerId, { requireLive = false } = {}) {
  if (
    !isRecord(value) ||
    value.ownerType !== ownerType ||
    value.ownerId !== ownerId ||
    typeof value.filePath !== "string" ||
    typeof value.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.hash) ||
    !Number.isSafeInteger(value.updatedAt) ||
    value.updatedAt < 0 ||
    (value.deletedAt !== null && value.deletedAt !== undefined &&
      (!Number.isSafeInteger(value.deletedAt) || value.deletedAt < 0)) ||
    (requireLive && (value.deletedAt != null || value.filePath.length === 0))
  ) {
    throw cdsProtocolError(
      "CDS returned an invalid avatar state",
      "owner_metadata",
    );
  }
  return value;
}

class CentralSyncAdapter {
  constructor(options = {}) {
    this.chatDataService = options?.chatDataService || null;
    this.appDataPath = options?.appDataPath || null;
    this.compatibilityDb = options?.compatibilityDb || null;
  }

  get client() {
    return this.chatDataService?.client || null;
  }

  requireClient() {
    const client = this.client;
    if (!client) {
      throw createSyncError("CDS_UNAVAILABLE", "VCP-CDS is unavailable", {
        origin: "desktop_cds",
        stage: "startup",
      });
    }
    return client;
  }

  async reconcile({ maxAttempts = 30, retryDelayMs = 500 } = {}) {
    const client = this.requireClient();

    // VCP-CDS 在发布 READY 后会启动一次后台 reconcile。MobileSync 紧接着
    // 初始化时可能与该任务争用 reconcile_lock，并收到可重试的 SERVICE_BUSY
    // (HTTP 429)。不能让这个瞬时状态阻止整个 HTTP/WS 同步路由注册。
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await client.reconcile();
      } catch (error) {
        const isBusy = error?.code === "SERVICE_BUSY";
        if (!isBusy || attempt === maxAttempts) {
          throw error;
        }

        getLogger().logInfo(
          "central",
          `VCP-CDS reconcile 正忙，等待后重试 (${attempt}/${maxAttempts})`,
          "warn",
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    throw new Error("VCP-CDS reconcile retry loop exhausted");
  }

  async reconcileOwners(owners, stage = "owner_metadata") {
    if (
      !Array.isArray(owners) ||
      owners.length === 0 ||
      owners.length > 1_000
    ) {
      throw createSyncError(
        "SYNC_REQUEST_INVALID",
        "Targeted CDS reconcile requires 1 to 1000 owners",
        { origin: "desktop_plugin", stage },
      );
    }
    const seen = new Set();
    for (const owner of owners) {
      const key = entityIdentityKey({ entityType: "owner", ...owner });
      if (!key || seen.has(key)) {
        throw createSyncError(
          "SYNC_REQUEST_INVALID",
          "Targeted CDS reconcile requires unique complete owner identities",
          { origin: "desktop_plugin", stage },
        );
      }
      seen.add(key);
    }
    try {
      const response = await this.requireClient().request(
        "POST",
        "/v3/sync/owners/reconcile",
        { owners },
        { timeoutMs: 270_000 },
      );
      if (
        !isRecord(response) ||
        response.ok !== true ||
        response.ownersReconciled !== owners.length ||
        !Number.isSafeInteger(response.indexedTopics) ||
        response.indexedTopics < 0 ||
        Object.keys(response).sort().join("\0") !==
          "indexedTopics\0ok\0ownersReconciled"
      ) {
        throw cdsProtocolError(
          "CDS returned an invalid targeted owner reconcile response",
          stage,
        );
      }
      return response;
    } catch (error) {
      throw withCdsErrorContext(error, {
        code: "SYNC_ENTITY_WRITE_FAILED",
        origin: "desktop_cds",
        stage,
      });
    }
  }

  async loadTopicRecoveryStates({
    ownerType,
    ownerId,
    topicIds,
    metadataTopicIds = topicIds,
  }) {
    const requested = new Set(topicIds);
    const metadataRequested = new Set(metadataTopicIds);
    const manifest = await this.handleSyncManifest({
      type: "SYNC_MANIFEST_REQUEST",
      manifestType: "topic",
      items: [],
      targetedOwners: [{ ownerType, ownerId }],
    });

    const states = new Map();
    const liveIds = [];
    for (const item of manifest.results) {
      if (!requested.has(item.topicId)) continue;
      if (item.ownerType !== ownerType || item.ownerId !== ownerId) {
        throw cdsProtocolError(
          "CDS recovery manifest returned a mismatched owner",
          "topic_metadata",
        );
      }
      if (item.action === "PULL_DELETE") {
        states.set(item.topicId, { deleted: true, topic: null });
      } else if (item.action === "PULL" && metadataRequested.has(item.topicId)) {
        liveIds.push(item.topicId);
      } else if (item.action === "PULL") {
        states.set(item.topicId, { deleted: false, topic: null });
      } else {
        throw cdsProtocolError(
          "CDS recovery manifest returned an unexpected action",
          "topic_metadata",
        );
      }
    }

    if (liveIds.length === 0) return states;
    const results = await this.pullEntities(
      liveIds.map((topicId) => ({
        entityType: "topic",
        ownerType,
        ownerId,
        topicId,
      })),
    );
    if (results.length !== liveIds.length) {
      throw cdsProtocolError(
        "CDS recovery pull returned an incomplete topic set",
        "topic_metadata",
        liveIds.slice(0, 8),
      );
    }
    for (const result of results) {
      if (result.ok !== true || !isRecord(result.data)) {
        throw cdsProtocolError(
          "CDS recovery pull could not read committed topic metadata",
          "topic_metadata",
          liveIds.slice(0, 8),
        );
      }
      states.set(result.topicId, { deleted: false, topic: result.data });
    }
    return states;
  }

  async handleSyncManifest(payload) {
    const validated = validateSyncManifestRequest(payload);
    const stage = validated.manifestType === "topic"
      ? "topic_metadata"
      : "owner_metadata";
    try {
      const response = await this.requireClient().request(
        "POST",
        "/v3/sync/manifest",
        {
          manifestType: validated.manifestType,
          items: validated.normalizedRemoteItems,
          ...(validated.targetedOwners === undefined
            ? {}
            : { targetedOwners: validated.targetedOwners }),
        },
      );
      if (
        !isRecord(response) ||
        response.type !== "SYNC_MANIFEST_RESULT" ||
        response.manifestType !== payload.manifestType ||
        !Array.isArray(response.results) ||
        (payload.manifestType === "owner" && response.results.some((item) =>
          !isRecord(item) ||
          !["agent", "group"].includes(item.ownerType) ||
          typeof item.ownerId !== "string" ||
          item.ownerId.length === 0
        ))
      ) {
        throw cdsProtocolError("CDS returned an invalid manifest response", stage);
      }
      return response;
    } catch (error) {
      throw withCdsErrorContext(error, {
        code: "SYNC_DB_QUERY_FAILED",
        origin: "desktop_cds",
        stage,
      });
    }
  }

  async pullEntities(items) {
    const stage = items.some((item) => item?.entityType === "topic")
      ? "topic_metadata"
      : "owner_metadata";
    try {
      const response = await this.requireClient().request(
        "POST",
        "/v3/sync/entities/pull",
        { items },
      );
      if (!isRecord(response) || !Array.isArray(response.results)) {
        throw cdsProtocolError("CDS returned an invalid entity pull response", stage);
      }
      const expected = new Set(items.map(entityIdentityKey));
      if (expected.has(null) || expected.size !== items.length) {
        throw cdsProtocolError("Entity pull request contains an invalid identity", stage);
      }
      const seen = new Set();
      const results = response.results.map((result) => {
        const key = entityIdentityKey(result);
        if (!key || !expected.has(key) || seen.has(key)) {
          throw cdsProtocolError("CDS entity pull returned an invalid identity", stage);
        }
        seen.add(key);
        if (result.ok === true && isRecord(result.data) && result.error === undefined) {
          return result;
        }
        if (
          result.ok === false &&
          result.data === undefined &&
          isCdsItemError(result.error)
        ) {
          return {
            entityType: result.entityType,
            ownerType: result.ownerType,
            ownerId: result.ownerId,
            ...(result.entityType === "topic" ? { topicId: result.topicId } : {}),
            ok: false,
            error: mapCdsItemError(
              result.error,
              result.error.code === "ENTITY_NOT_FOUND"
                ? "SYNC_ENTITY_NOT_FOUND"
                : result.error.code === "SNAPSHOT_STALE"
                  ? "SYNC_SNAPSHOT_STALE"
                  : "SYNC_ENTITY_READ_FAILED",
              {
                origin: "desktop_cds",
                stage,
                failedTopicIds:
                  result.entityType === "topic" ? [result.topicId] : [],
              },
            ),
          };
        }
        throw cdsProtocolError("CDS entity pull returned an invalid result", stage);
      });
      if (seen.size !== expected.size) {
        throw cdsProtocolError("CDS entity pull omitted requested items", stage);
      }
      return results;
    } catch (error) {
      throw withCdsErrorContext(error, {
        code: "SYNC_ENTITY_READ_FAILED",
        origin: "desktop_cds",
        stage,
      });
    }
  }

  async loadAvatarState(ownerType, ownerId) {
    if (!isAvatarIdentity(ownerType, ownerId)) {
      throw createSyncError(
        "SYNC_REQUEST_INVALID",
        "Avatar state requires a valid owner identity",
        { origin: "desktop_plugin", stage: "owner_metadata" },
      );
    }
    try {
      const value = await this.requireClient().request(
        "POST",
        "/v3/sync/avatars/state",
        { ownerType, ownerId },
      );
      return validateAvatarState(value, ownerType, ownerId);
    } catch (error) {
      if (error?.code === "NOT_FOUND") return null;
      throw withCdsErrorContext(error, {
        code: "SYNC_AVATAR_READ_FAILED",
        origin: "desktop_cds",
        stage: "owner_metadata",
      });
    }
  }

  async commitAvatar(ownerType, ownerId, expectedHash) {
    if (
      !isAvatarIdentity(ownerType, ownerId) ||
      typeof expectedHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(expectedHash)
    ) {
      throw createSyncError(
        "SYNC_REQUEST_INVALID",
        "Avatar commit requires a valid owner identity and expected hash",
        { origin: "desktop_plugin", stage: "owner_metadata" },
      );
    }
    try {
      const value = validateAvatarState(
        await this.requireClient().request(
          "POST",
          "/v3/sync/avatars/commit",
          { ownerType, ownerId },
        ),
        ownerType,
        ownerId,
        { requireLive: true },
      );
      if (value.hash !== expectedHash) {
        throw cdsProtocolError(
          "Avatar changed before CDS committed it",
          "owner_metadata",
        );
      }
      return value;
    } catch (error) {
      throw withCdsErrorContext(error, {
        code: "SYNC_AVATAR_WRITE_FAILED",
        origin: "desktop_cds",
        stage: "owner_metadata",
      });
    }
  }

  async handleTopicDiff(payload) {
    const topics = requireCompoundTopicStates(payload);
    const expected = new Set(topics.map(topicIdentityKey));
    try {
      const response = await this.requireClient().request(
        "POST",
        "/v3/sync/topic-diff",
        { topics },
        { timeoutMs: 270_000 },
      );
      const changedKeys = Array.isArray(response?.changedTopics)
        ? response.changedTopics.map(topicIdentityKey)
        : [];
      if (
        !isRecord(response) ||
        response.type !== "SYNC_TOPIC_DIFF_RESULT" ||
        !Array.isArray(response.changedTopics) ||
        changedKeys.some((key) => key === null || !expected.has(key)) ||
        new Set(changedKeys).size !== changedKeys.length
      ) {
        throw cdsProtocolError(
          "CDS returned an invalid topic hash response",
          "topic_validation",
        );
      }
      return response;
    } catch (error) {
      throw withCdsErrorContext(error, {
        code: "SYNC_DB_QUERY_FAILED",
        origin: "desktop_cds",
        stage: "topic_validation",
      });
    }
  }

  async handleMessageDiff(payload) {
    const topics = requireMessageDiffStates(payload);
    const expected = new Set(topics.map(topicIdentityKey));
    try {
      const response = await this.requireClient().request(
        "POST",
        "/v3/sync/message-diff",
        { topics },
        { timeoutMs: 270_000 },
      );
      if (
        !isRecord(response) ||
        response.type !== "SYNC_MESSAGE_DIFF_RESULT" ||
        !Array.isArray(response.results)
      ) {
        throw cdsProtocolError(
          "CDS returned an invalid message diff response",
          "messages",
        );
      }
      const actual = new Set();
      if (response.results.some((result) => {
        const key = topicIdentityKey(result);
        if (!key || !expected.has(key) || actual.has(key)) return true;
        actual.add(key);
        return false;
      }) || actual.size !== expected.size) {
        throw cdsProtocolError(
          "CDS message diff response does not cover the requested topics",
          "messages",
          topics.map((topic) => topic.topicId).slice(0, 8),
        );
      }
      const results = [];
      for (const decision of response.results) {
        const topicId = decision.topicId;
        const resultIdentity = {
          topicId,
          ownerType: decision.ownerType,
          ownerId: decision.ownerId,
        };
        if (!isRecord(decision)) {
          throw cdsProtocolError(
            `CDS returned an invalid message diff decision for ${topicId}`,
            "messages",
            [topicId],
          );
        }
        if (decision.ok === false) {
          if (
            Object.keys(decision).sort().join("\0") !==
              "error\0ok\0ownerId\0ownerType\0topicId" ||
            !isCdsItemError(decision.error) ||
            decision.pullMessageIds !== undefined ||
            decision.pushTopic !== undefined ||
            decision.deleteMessages !== undefined
          ) {
            throw cdsProtocolError(
              `CDS returned an invalid rejected decision for ${topicId}`,
              "messages",
              [topicId],
            );
          }
          results.push({
            ...resultIdentity,
            ok: false,
            error: normalizeSyncError(decision.error, {
              code: "MESSAGE_DIFF_FAILED",
              origin: "desktop_cds",
              stage: "messages",
              failedTopicIds: [topicId],
            }),
          });
          continue;
        }
        const deleteMessages = decision.deleteMessages;
        const deleteIds = Array.isArray(deleteMessages)
          ? deleteMessages.map((item) => item?.msgId)
          : [];
        if (
          Object.keys(decision).sort().join("\0") !==
            "deleteMessages\0ok\0ownerId\0ownerType\0pullMessageIds\0pushTopic\0topicId" ||
          decision.ok !== true ||
          !Array.isArray(decision.pullMessageIds) ||
          decision.pullMessageIds.some((id) => typeof id !== "string" || id.length === 0) ||
          new Set(decision.pullMessageIds).size !== decision.pullMessageIds.length ||
          typeof decision.pushTopic !== "boolean" ||
          !Array.isArray(deleteMessages) ||
          deleteMessages.some(
            (item) =>
              !isRecord(item) ||
              typeof item.msgId !== "string" ||
              item.msgId.length === 0 ||
              !Number.isSafeInteger(item.deletedAt) ||
              item.deletedAt < 0,
          ) ||
          new Set(deleteIds).size !== deleteIds.length ||
          deleteIds.some((msgId) => decision.pullMessageIds.includes(msgId)) ||
          decision.error !== undefined
        ) {
          throw cdsProtocolError(
            `CDS returned an invalid successful decision for ${topicId}`,
            "messages",
            [topicId],
          );
        }
        results.push({
          ...resultIdentity,
          ok: true,
          pullMessageIds: decision.pullMessageIds,
          pushTopic: decision.pushTopic,
          deleteMessages: deleteMessages.map((item) => ({
            msgId: item.msgId,
            deletedAt: item.deletedAt,
          })),
        });
      }
      return { ...response, results };
    } catch (error) {
      throw withCdsErrorContext(error, {
        code: "MESSAGE_DIFF_FAILED",
        origin: "desktop_cds",
        stage: "messages",
        failedTopicIds:
          topics.map((topic) => topic.topicId).slice(0, 8),
      });
    }
  }

  async pullMessagesStreamRaw(topics, res) {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.flushHeaders();

    if (!Array.isArray(topics) || topics.length > MAX_NDJSON_TOPICS) {
      throw createSyncError(
        "SYNC_REQUEST_INVALID",
        "Central pull requires at most 10000 topic selectors",
        { stage: "messages" },
      );
    }
    const expected = new Map();
    let requestedMessages = 0;
    const normalizedTopics = topics.map((topic) => {
      if (
        !topic ||
        typeof topic.topicId !== "string" ||
        topic.topicId.length === 0 ||
        !["agent", "group"].includes(topic.ownerType) ||
        typeof topic.ownerId !== "string" ||
        topic.ownerId.length === 0 ||
        !Array.isArray(topic.messageIds)
      ) {
        throw createSyncError(
          "SYNC_REQUEST_INVALID",
          "Central pull request requires exact topic owner identity",
          { stage: "messages" },
        );
      }
      const requestKey = topicIdentityKey(topic);
      if (expected.has(requestKey)) {
        throw createSyncError(
          "SYNC_REQUEST_INVALID",
          `Central pull contains duplicate topic identity ${topic.topicId}`,
          { stage: "messages", failedTopicIds: [topic.topicId] },
        );
      }
      const uniqueIds = new Set(topic.messageIds);
      if (
        uniqueIds.size !== topic.messageIds.length ||
        topic.messageIds.some((id) => typeof id !== "string" || id.length === 0)
      ) {
        throw createSyncError(
          "SYNC_REQUEST_INVALID",
          `Central pull ${topic.topicId} has invalid message ids`,
          { stage: "messages", failedTopicIds: [topic.topicId] },
        );
      }
      requestedMessages += topic.messageIds.length;
      if (
        topic.messageIds.length > 10_000 ||
        requestedMessages > MAX_NDJSON_MESSAGES
      ) {
        throw createSyncError(
          "SYNC_BUDGET_EXCEEDED",
          "Central pull exceeds the message count budget",
          { stage: "messages", failedTopicIds: [topic.topicId] },
        );
      }
      expected.set(requestKey, topic);
      return {
        topicId: topic.topicId,
        ownerType: topic.ownerType,
        ownerId: topic.ownerId,
        messageIds: topic.messageIds,
      };
    });

    const writer = new NdjsonWriter(res);
    const seen = new Set();
    for await (const rawFrame of this.requireClient().requestNdjson(
      "POST",
      "/v3/sync/messages/pull",
      { topics: normalizedTopics },
      { timeoutMs: 270_000 },
    )) {
      if (rawFrame?.kind === "streamError") {
        if (!isCdsItemError(rawFrame.error) || Object.keys(rawFrame).length !== 2) {
          throw cdsProtocolError("CDS returned an invalid stream error frame", "messages");
        }
        throw withCdsErrorContext(mapCdsItemError(
          rawFrame.error,
          "SYNC_STREAM_FAILED",
          {
            origin: "desktop_cds",
            stage: "messages",
          },
        ), {
          code: "SYNC_STREAM_FAILED",
          origin: "desktop_cds",
          stage: "messages",
        });
      }
      if (!isRecord(rawFrame) || rawFrame.kind !== "topic" || typeof rawFrame.ok !== "boolean") {
        throw cdsProtocolError("CDS returned an invalid message pull frame", "messages");
      }
      const topicId = rawFrame.topicId;
      const responseKey = topicIdentityKey(rawFrame);
      if (!responseKey) {
        throw createSyncError(
          "SYNC_PROTOCOL_INVALID",
          `CDS pull returned unexpected topic ${topicId}`,
          { origin: "desktop_cds", stage: "messages", failedTopicIds: [topicId] },
        );
      }
      if (!expected.has(responseKey)) {
        const ownerConflict = [...expected.values()].some(
          (request) => request.topicId === topicId,
        );
        throw createSyncError(
          ownerConflict ? "SYNC_OWNER_CONFLICT" : "SYNC_PROTOCOL_INVALID",
          ownerConflict
            ? `CDS pull returned conflicting owner identity for ${topicId}`
            : `CDS pull returned unexpected topic ${topicId}`,
          { origin: "desktop_cds", stage: "messages", failedTopicIds: [topicId] },
        );
      }
      if (seen.has(responseKey)) {
        throw createSyncError(
          "SYNC_PROTOCOL_INVALID",
          `CDS pull returned duplicate topic ${topicId}`,
          { origin: "desktop_cds", stage: "messages", failedTopicIds: [topicId] },
        );
      }
      seen.add(responseKey);
      if (!rawFrame.ok) {
        if (!isCdsItemError(rawFrame.error) || rawFrame.messages !== undefined) {
          throw cdsProtocolError(
            `CDS returned an invalid message pull error for ${topicId}`,
            "messages",
            [topicId],
          );
        }
        await writer.write({
          kind: "topic",
          topicId,
          ownerType: rawFrame.ownerType,
          ownerId: rawFrame.ownerId,
          ok: false,
          error: mapCdsItemError(rawFrame.error, "SYNC_MESSAGE_READ_FAILED", {
            code: "SYNC_MESSAGE_READ_FAILED",
            origin: "desktop_cds",
            stage: "messages",
            failedTopicIds: [topicId],
          }),
        });
        continue;
      }
      if (rawFrame.error !== undefined || !Array.isArray(rawFrame.messages)) {
        throw cdsProtocolError(
          `CDS returned an invalid successful message pull for ${topicId}`,
          "messages",
          [topicId],
        );
      }
      const canonical = canonicalizeTopicFrame(rawFrame, {
        includeContentHash: false,
      });
      if (canonical.topicIdRewrites > 0) {
        getLogger().logInfo(
          "central",
          `topicId 归一化：${topicId} 有 ${canonical.topicIdRewrites} 条消息重写为 frame topic（${canonical.topicIdRewriteSamples.join("; ")}）`,
          "warn",
        );
      }
      await writer.write({
        kind: "topic",
        topicId,
        ownerType: canonical.frame.ownerType,
        ownerId: canonical.frame.ownerId,
        ok: true,
        messages: canonical.frame.messages,
        ...(canonical.frame.legacyAttachmentWarnings === undefined
          ? {}
          : {
              legacyAttachmentWarnings:
                canonical.frame.legacyAttachmentWarnings,
              warningSamples: canonical.frame.warningSamples,
            }),
      });
    }
    if (seen.size !== expected.size) {
      const missing = [...expected.entries()]
        .filter(([key]) => !seen.has(key))
        .map(([, request]) => request.topicId);
      throw createSyncError(
        "SYNC_MESSAGE_READ_FAILED",
        `CDS pull omitted topics: ${missing.slice(0, 8).join(", ")}`,
        { origin: "desktop_cds", stage: "messages", failedTopicIds: missing },
      );
    }
    res.end();
  }

  async pushMessagesStreamRaw(req, res) {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.flushHeaders();

    if (!this.appDataPath) {
      throw new Error("Central message projection requires appDataPath");
    }
    const db = this.compatibilityDb || getDb();
    if (!db) throw new Error("Central compatibility index is unavailable");

    const client = this.requireClient();
    const writer = new NdjsonWriter(res);
    const seen = new Set();
    const avatarPaths = new Map();
    const resolveAgentAvatarPath = (agentId) => {
      if (!avatarPaths.has(agentId)) {
        avatarPaths.set(
          agentId,
          this.loadAvatarState("agent", agentId).then((avatar) =>
            avatar?.deletedAt == null ? avatar?.filePath || null : null
          ),
        );
      }
      return avatarPaths.get(agentId);
    };
    let topicCount = 0;
    let messageCount = 0;
    for await (const line of readNdjsonLines(req)) {
      let topicId = null;
      let ownerType = null;
      let ownerId = null;
      try {
        const frame = parseJsonWithoutDuplicateKeys(decodeNdjsonLine(line));
        if (
          !isRecord(frame) ||
          Object.keys(frame).sort().join("\0") !==
            ["deletedMessages", "kind", "messages", "ownerId", "ownerType", "topicId"]
              .sort()
              .join("\0") ||
          frame.kind !== "topic"
        ) {
          throw new SyncProtocolError(
            "Central message push requires the exact Topic frame contract",
          );
        }
        topicId = frame?.topicId;
        ownerType = frame?.ownerType;
        ownerId = frame?.ownerId;
        if (
          typeof topicId !== "string" ||
          topicId.length === 0 ||
          !["agent", "group"].includes(frame.ownerType) ||
          typeof frame.ownerId !== "string" ||
          frame.ownerId.length === 0 ||
          !Array.isArray(frame.messages) ||
          !Array.isArray(frame.deletedMessages)
        ) {
          throw new SyncProtocolError(
            "Central message push requires exact topic owner identity and messages",
          );
        }
        topicCount += 1;
        const liveIds = new Set();
        for (const message of frame.messages) {
          if (
            !isRecord(message) ||
            typeof message.id !== "string" ||
            message.id.length === 0 ||
            liveIds.has(message.id)
          ) {
            throw new SyncProtocolError(
              "Central message push requires unique live message IDs",
            );
          }
          liveIds.add(message.id);
        }
        const deletedIds = new Set();
        for (const tombstone of frame.deletedMessages) {
          if (
            !isRecord(tombstone) ||
            Object.keys(tombstone).sort().join("\0") !== "deletedAt\0msgId" ||
            typeof tombstone.msgId !== "string" ||
            tombstone.msgId.length === 0 ||
            !Number.isSafeInteger(tombstone.deletedAt) ||
            tombstone.deletedAt < 0 ||
            deletedIds.has(tombstone.msgId) ||
            liveIds.has(tombstone.msgId)
          ) {
            throw new SyncProtocolError(
              "Central message push requires unique valid tombstones disjoint from live messages",
            );
          }
          deletedIds.add(tombstone.msgId);
        }
        const topicMessageCount =
          frame.messages.length + frame.deletedMessages.length;
        messageCount += topicMessageCount;
        if (
          topicCount > MAX_NDJSON_TOPICS ||
          topicMessageCount > 10_000 ||
          messageCount > MAX_NDJSON_MESSAGES
        ) {
          throw new SyncProtocolError(
            "Central message push exceeds its count budget",
            "SYNC_BUDGET_EXCEEDED",
          );
        }
        const requestKey = topicIdentityKey(frame);
        if (seen.has(requestKey)) {
          throw new SyncProtocolError(
            `Central message push contains duplicate topic identity ${topicId}`,
          );
        }
        seen.add(requestKey);

        let projected;
        try {
          projected = await projectMobileTopic({
            topicId,
            ownerType: frame.ownerType,
            ownerId: frame.ownerId,
            messages: frame.messages,
            db,
            appDataPath: this.appDataPath,
            resolveAgentAvatarPath,
          });
        } catch (projectionError) {
          await writer.write({
            kind: "topic",
            topicId,
            ownerType,
            ownerId,
            ok: false,
            error: normalizeSyncError(projectionError, {
              code: "SYNC_MESSAGE_WRITE_FAILED",
              origin: "desktop_cds",
              stage: "messages",
              failedTopicIds: [topicId],
            }),
          });
          continue;
        }
        const result = await client.request(
          "POST",
          "/v3/sync/messages/push",
          {
            topicId,
            ownerType: frame.ownerType,
            ownerId: frame.ownerId,
            messages: projected.messages,
            deletedMessages: frame.deletedMessages,
          },
          { timeoutMs: 270_000 },
        );
        if (
          result?.topicId !== topicId ||
          result?.ownerType !== ownerType ||
          result?.ownerId !== ownerId ||
          typeof result?.ok !== "boolean" ||
          Object.keys(result).length !== (result.ok ? 4 : 5) ||
          (result.ok ? result.error !== undefined : !isCdsItemError(result.error))
        ) {
          throw createSyncError(
            "SYNC_PROTOCOL_INVALID",
            `CDS returned an invalid push result for ${topicId}`,
            { origin: "desktop_cds", stage: "messages", failedTopicIds: [topicId] },
          );
        }
        if (!result.ok) {
          throw withCdsErrorContext(
            mapCdsItemError(
              result.error,
              result.error.code === "SNAPSHOT_STALE"
                ? "SYNC_SNAPSHOT_STALE"
                : "SYNC_MESSAGE_WRITE_FAILED",
              {
                origin: "desktop_cds",
                stage: "messages",
                failedTopicIds: [topicId],
              },
            ),
            {
              code: "SYNC_MESSAGE_WRITE_FAILED",
              origin: "desktop_cds",
              stage: "messages",
              failedTopicIds: [topicId],
            },
          );
        }
        await writer.write({
          kind: "topic",
          topicId,
          ownerType,
          ownerId,
          ok: true,
        });
      } catch (error) {
        if (
          error?.name === "SyncProtocolError" ||
          error?.code === "SYNC_PROTOCOL_INVALID" ||
          error?.code === "SYNC_BUDGET_EXCEEDED" ||
          String(error?.code || "").startsWith("PROTOCOL_")
        ) {
          throw error;
        }
        if (typeof topicId !== "string" || topicId.length === 0) throw error;
        await writer.write({
          kind: "topic",
          topicId,
          ownerType,
          ownerId,
          ok: false,
          error: normalizeSyncError(error, {
            code: "SYNC_MESSAGE_WRITE_FAILED",
            origin: "desktop_cds",
            stage: "messages",
            failedTopicIds: [topicId],
          }),
        });
      }
    }
    res.end();
  }

  async deleteEntityTombstone(target) {
    const {
      targetType,
      ownerType,
      ownerId,
      topicId,
      deletedAt,
    } = isRecord(target) ? target : {};
    const isTopic = targetType === "topic";
    const isAvatar = targetType === "avatar";
    const stage = isTopic ? "topic_metadata" : "owner_metadata";
    const failedTopicIds = isTopic && typeof topicId === "string" ? [topicId] : [];
    const expectedKeys = isTopic
      ? ["targetType", "ownerType", "ownerId", "topicId", "deletedAt"]
      : ["targetType", "ownerType", "ownerId", "deletedAt"];
    const validOwner =
      typeof ownerId === "string" &&
      ownerId.length > 0 &&
      /^[a-zA-Z0-9_-]+$/.test(ownerId) &&
      (isAvatar
        ? isAvatarIdentity(ownerType, ownerId)
        : ["agent", "group"].includes(ownerType));
    if (
      !["owner", "topic", "avatar"].includes(targetType) ||
      !validOwner ||
      (isTopic &&
        (typeof topicId !== "string" ||
          topicId.length === 0 ||
          !/^[a-zA-Z0-9_-]+$/.test(topicId))) ||
      !Number.isSafeInteger(deletedAt) ||
      deletedAt < 0 ||
      !isRecord(target) ||
      Object.keys(target).sort().join("\0") !== expectedKeys.sort().join("\0")
    ) {
      throw createSyncError(
        "SYNC_DELETE_INVALID",
        "Central entity deletion requires targetType, complete identity and deletedAt",
        {
          origin: "desktop_plugin",
          stage,
          failedTopicIds,
        },
      );
    }

    try {
      const result = await this.requireClient().request(
        "POST",
        "/v3/sync/entities/delete",
        target,
      );
      if (
        !isRecord(result) ||
        result.ok !== true ||
        Object.keys(result).length !== 1
      ) {
        throw cdsProtocolError(
          "CDS returned an invalid entity delete response",
          stage,
          failedTopicIds,
        );
      }
      return result;
    } catch (error) {
      throw withCdsErrorContext(error, {
        code: "SYNC_DELETE_FAILED",
        origin: "desktop_cds",
        stage,
        failedTopicIds,
      });
    }
  }

  async deleteMessage({ topicId, ownerType, ownerId, msgId, deletedAt }) {
    if (
      typeof topicId !== "string" ||
      topicId.length === 0 ||
      !["agent", "group"].includes(ownerType) ||
      typeof ownerId !== "string" ||
      ownerId.length === 0 ||
      typeof msgId !== "string" ||
      msgId.length === 0 ||
      !Number.isSafeInteger(deletedAt) ||
      deletedAt < 0
    ) {
      throw new Error(
        "Central message deletion requires valid owner, topicId, msgId, and deletedAt",
      );
    }
    const client = this.requireClient();
    const result = await client.request(
      "POST",
      "/v3/sync/messages/push",
      {
        topicId,
        ownerType,
        ownerId,
        messages: [],
        deletedMessages: [{ msgId, deletedAt }],
      },
      { timeoutMs: 270_000 },
    );
    if (
      result?.topicId !== topicId ||
      result?.ownerType !== ownerType ||
      result?.ownerId !== ownerId ||
      result?.ok !== true ||
      result?.error !== undefined ||
      Object.keys(result).length !== 4
    ) {
      throw withCdsErrorContext(
        result?.error
          ? mapCdsItemError(
            result.error,
            result.error.code === "SNAPSHOT_STALE"
              ? "SYNC_SNAPSHOT_STALE"
              : "SYNC_DELETE_FAILED",
            {
              origin: "desktop_cds",
              stage: "messages",
              failedTopicIds: [topicId],
            },
          )
          : `CDS rejected message deletion for ${topicId}`,
        {
          code: "SYNC_DELETE_FAILED",
          origin: "desktop_cds",
          stage: "messages",
          failedTopicIds: [topicId],
        },
      );
    }
  }

  logEnabled() {
    getLogger().logInfo(
      "central",
      "VCPMobileSync 提交索引已切换到 VCP-CDS；Legacy 持久索引和 watcher 已停用。",
    );
  }
}

function createCentralSyncAdapter(options) {
  return new CentralSyncAdapter(options);
}

module.exports = {
  createCentralSyncAdapter,
};
