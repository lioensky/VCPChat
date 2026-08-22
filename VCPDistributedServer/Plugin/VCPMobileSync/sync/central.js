"use strict";

const { getDb } = require("../core/db");
const { getLogger } = require("../core/logger");
const { parseJsonWithoutDuplicateKeys } = require("../protocol");
const { SyncProtocolError, canonicalizeTopicFrame } = require("./canonical");
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

function translateCdsPullFrame(rawFrame) {
  if (!rawFrame || typeof rawFrame !== "object" || Array.isArray(rawFrame)) {
    return rawFrame;
  }
  if (
    Object.prototype.hasOwnProperty.call(rawFrame, "_stream_error") &&
    rawFrame._stream_error !== null
  ) {
    throw withCdsErrorContext(rawFrame._stream_error, {
      code: "SYNC_STREAM_FAILED",
      origin: "desktop_cds",
      stage: "messages",
    });
  }
  if (
    Object.prototype.hasOwnProperty.call(rawFrame, "_error") &&
    rawFrame._error !== null
  ) {
    const topicId = typeof rawFrame.topicId === "string" ? rawFrame.topicId : null;
    return {
      ...rawFrame,
      _error: normalizeSyncError(rawFrame._error, {
        code: "SYNC_MESSAGE_READ_FAILED",
        origin: "desktop_cds",
        stage: "messages",
        failedTopicIds: topicId ? [topicId] : [],
      }),
    };
  }
  return rawFrame;
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

class CentralSyncAdapter {
  constructor(options) {
    if (options?.chatDataService) {
      this.chatDataService = options.chatDataService;
      this.appDataPath = options.appDataPath || null;
      this.compatibilityDb = options.compatibilityDb || null;
    } else {
      // Backward-compatible constructor for the existing contract tests.
      this.chatDataService = options;
      this.appDataPath = null;
      this.compatibilityDb = null;
    }
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

  async handleSyncManifest(payload) {
    const stage = payload.dataType === "topic"
      ? "topic_metadata"
      : "owner_metadata";
    // 与 legacy 路径（sync/manifest.js）对齐：phase 必须与 dataType 对应
    // （topic=2，其余=1），且 SYNC_DIFF_RESULTS 必须回填 phase——
    // 移动端 diff_handler 对 phase 做硬门禁，缺失即中止整个 attempt。
    const expectedPhase = payload.dataType === "topic" ? 2 : 1;
    if (payload.phase !== expectedPhase) {
      throw createSyncError(
        "SYNC_PROTOCOL_INVALID",
        `${payload.dataType} manifest phase must be ${expectedPhase}`,
        { origin: "desktop_plugin", stage },
      );
    }
    try {
      const response = await this.requireClient().syncManifest({
        dataType: payload.dataType,
        data: payload.data,
        ...(payload.targetedOwners === undefined
          ? {}
          : { targetedOwners: payload.targetedOwners }),
      });
      if (
        !isRecord(response) ||
        response.type !== "SYNC_DIFF_RESULTS" ||
        response.dataType !== payload.dataType ||
        !Array.isArray(response.data)
      ) {
        throw cdsProtocolError("CDS returned an invalid manifest response", stage);
      }
      return { ...response, phase: payload.phase };
    } catch (error) {
      throw withCdsErrorContext(error, {
        code: "SYNC_DB_QUERY_FAILED",
        origin: "desktop_cds",
        stage,
      });
    }
  }

  async handleMessageManifest(payload) {
    try {
      const result = await this.requireClient().syncMessageManifest({
        topicId: payload.topicId,
        ...(payload.ownerType === undefined
          ? {}
          : { ownerType: payload.ownerType }),
        ...(payload.ownerId === undefined ? {} : { ownerId: payload.ownerId }),
      });
      const seenMessageIds = new Set();
      if (
        !isRecord(result) ||
        result.type !== "MESSAGE_MANIFEST_RESULTS" ||
        result.topicId !== payload.topicId ||
        !["agent", "group"].includes(result.ownerType) ||
        typeof result.ownerId !== "string" ||
        result.ownerId.length === 0 ||
        (payload.ownerType !== undefined && result.ownerType !== payload.ownerType) ||
        (payload.ownerId !== undefined && result.ownerId !== payload.ownerId) ||
        !Array.isArray(result.messages) ||
        result.messages.some((message) => {
          if (
            !isRecord(message) ||
            typeof message.msgId !== "string" ||
            message.msgId.length === 0 ||
            seenMessageIds.has(message.msgId) ||
            typeof message.contentHash !== "string" ||
            !/^[a-f0-9]{64}$/.test(message.contentHash) ||
            !Number.isSafeInteger(message.updatedAt) ||
            message.updatedAt < 0 ||
            (message.deletedAt !== null && message.deletedAt !== undefined &&
              (!Number.isSafeInteger(message.deletedAt) || message.deletedAt < 0))
          ) {
            return true;
          }
          seenMessageIds.add(message.msgId);
          return false;
        })
      ) {
        throw cdsProtocolError(
          "CDS returned an invalid message manifest response",
          "messages",
          typeof payload.topicId === "string" ? [payload.topicId] : [],
        );
      }
      return {
        type: "MESSAGE_MANIFEST_RESULTS",
        topicId: result.topicId,
        ownerType: result.ownerType,
        ownerId: result.ownerId,
        messages: result.messages.map((message) => ({
          msg_id: message.msgId,
          content_hash: message.contentHash,
          updated_at: message.updatedAt,
          deleted_at: message.deletedAt ?? null,
        })),
      };
    } catch (error) {
      throw withCdsErrorContext(error, {
        code: "SYNC_MESSAGE_READ_FAILED",
        origin: "desktop_cds",
        stage: "messages",
        failedTopicIds:
          typeof payload.topicId === "string" ? [payload.topicId] : [],
      });
    }
  }

  async handleTopicHashBatch(payload) {
    const hasCompoundStates = Array.isArray(payload.topics) && payload.topics.length > 0;
    try {
      const response = await this.requireClient().syncTopicDiff({
        hashes: hasCompoundStates ? {} : payload.hashes,
        ...(hasCompoundStates ? { topics: payload.topics } : {}),
      });
      const expected = new Set(
        hasCompoundStates
          ? payload.topics.map((topic) => topic?.topicId)
          : Object.keys(payload.hashes || {}),
      );
      if (
        !isRecord(response) ||
        response.type !== "SYNC_TOPIC_HASH_RESULTS" ||
        !Array.isArray(response.changedTopics) ||
        response.changedTopics.some(
          (topicId) => typeof topicId !== "string" || !expected.has(topicId),
        ) ||
        new Set(response.changedTopics).size !== response.changedTopics.length
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

  async handleMessageDiffBatch(payload) {
    try {
      const response = await this.requireClient().syncMessageDiff({
        topics: payload.topics,
      });
      if (
        !isRecord(response) ||
        response.type !== "SYNC_DIFF_RESULTS_BATCH" ||
        !isRecord(response.results)
      ) {
        throw cdsProtocolError(
          "CDS returned an invalid message diff response",
          "messages",
        );
      }
      const expectedTopicIds = Object.keys(
        isRecord(payload.topics) ? payload.topics : {},
      );
      const resultTopicIds = Object.keys(response.results);
      if (
        resultTopicIds.length !== expectedTopicIds.length ||
        resultTopicIds.some((topicId) => !expectedTopicIds.includes(topicId))
      ) {
        throw cdsProtocolError(
          "CDS message diff response does not cover the requested topics",
          "messages",
          expectedTopicIds,
        );
      }
      const results = {};
      for (const [topicId, decision] of Object.entries(response.results)) {
        if (!isRecord(decision)) {
          throw cdsProtocolError(
            `CDS returned an invalid message diff decision for ${topicId}`,
            "messages",
            [topicId],
          );
        }
        if (decision.ok === false) {
          if (
            decision.error === undefined ||
            decision.toPull !== undefined ||
            decision.toPush !== undefined ||
            decision.toDelete !== undefined
          ) {
            throw cdsProtocolError(
              `CDS returned an invalid rejected decision for ${topicId}`,
              "messages",
              [topicId],
            );
          }
          results[topicId] = {
            ok: false,
            error: normalizeSyncError(decision.error, {
              code: "MESSAGE_DIFF_FAILED",
              origin: "desktop_cds",
              stage: "messages",
              failedTopicIds: [topicId],
            }),
          };
          continue;
        }
        const toDelete = decision.toDelete;
        const deleteIds = Array.isArray(toDelete)
          ? toDelete.map((item) => item?.msgId)
          : [];
        if (
          decision.ok !== true ||
          !Array.isArray(decision.toPull) ||
          decision.toPull.some((id) => typeof id !== "string" || id.length === 0) ||
          new Set(decision.toPull).size !== decision.toPull.length ||
          typeof decision.toPush !== "boolean" ||
          !Array.isArray(toDelete) ||
          toDelete.some(
            (item) =>
              !isRecord(item) ||
              typeof item.msgId !== "string" ||
              item.msgId.length === 0 ||
              !Number.isSafeInteger(item.deletedAt) ||
              item.deletedAt < 0,
          ) ||
          new Set(deleteIds).size !== deleteIds.length ||
          deleteIds.some((msgId) => decision.toPull.includes(msgId)) ||
          decision.error !== undefined
        ) {
          throw cdsProtocolError(
            `CDS returned an invalid successful decision for ${topicId}`,
            "messages",
            [topicId],
          );
        }
        results[topicId] = {
          ok: true,
          toPull: decision.toPull,
          toPush: decision.toPush,
          toDelete: toDelete.map((item) => ({
            msgId: item.msgId,
            deletedAt: item.deletedAt,
          })),
        };
      }
      return { ...response, results };
    } catch (error) {
      throw withCdsErrorContext(error, {
        code: "MESSAGE_DIFF_FAILED",
        origin: "desktop_cds",
        stage: "messages",
        failedTopicIds:
          payload.topics && typeof payload.topics === "object"
            ? Object.keys(payload.topics).slice(0, 8)
            : [],
      });
    }
  }

  async downloadMessagesStreamRaw(requests, res) {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.flushHeaders();

    if (!Array.isArray(requests) || requests.length > MAX_NDJSON_TOPICS) {
      throw createSyncError(
        "SYNC_REQUEST_INVALID",
        "Central pull requires at most 10000 topic requests",
        { stage: "messages" },
      );
    }
    const expected = new Map();
    let requestedMessages = 0;
    const normalizedRequests = requests.map((request) => {
      if (
        !request ||
        typeof request.topicId !== "string" ||
        request.topicId.length === 0 ||
        !["agent", "group"].includes(request.ownerType) ||
        typeof request.ownerId !== "string" ||
        request.ownerId.length === 0 ||
        !Array.isArray(request.msgIds)
      ) {
        throw createSyncError(
          "SYNC_REQUEST_INVALID",
          "Central pull request requires exact topic owner identity",
          { stage: "messages" },
        );
      }
      if (expected.has(request.topicId)) {
        throw createSyncError(
          "SYNC_REQUEST_INVALID",
          `Central pull contains duplicate topic ${request.topicId}`,
          { stage: "messages", failedTopicIds: [request.topicId] },
        );
      }
      const uniqueIds = new Set(request.msgIds);
      if (
        uniqueIds.size !== request.msgIds.length ||
        request.msgIds.some((id) => typeof id !== "string" || id.length === 0)
      ) {
        throw createSyncError(
          "SYNC_REQUEST_INVALID",
          `Central pull ${request.topicId} has invalid message ids`,
          { stage: "messages", failedTopicIds: [request.topicId] },
        );
      }
      requestedMessages += request.msgIds.length;
      if (
        request.msgIds.length > 10_000 ||
        requestedMessages > MAX_NDJSON_MESSAGES
      ) {
        throw createSyncError(
          "SYNC_BUDGET_EXCEEDED",
          "Central pull exceeds the message count budget",
          { stage: "messages", failedTopicIds: [request.topicId] },
        );
      }
      expected.set(request.topicId, {
        ownerType: request.ownerType,
        ownerId: request.ownerId,
      });
      return {
        topicId: request.topicId,
        ownerType: request.ownerType,
        ownerId: request.ownerId,
        msgIds: request.msgIds,
      };
    });

    const writer = new NdjsonWriter(res);
    const seen = new Set();
    for await (const rawFrame of this.requireClient().syncMessagesPullStream({
      requests: normalizedRequests,
    })) {
      // CDS protocol 2 still uses a diagnostic string in pull `_error` frames.
      // Translate it here; only the complete Wire object may cross to Mobile.
      const canonical = canonicalizeTopicFrame(translateCdsPullFrame(rawFrame));
      const topicId = canonical.frame.topicId;
      if (canonical.topicIdRewrites > 0) {
        getLogger().logInfo(
          "central",
          `topicId 归一化：${topicId} 有 ${canonical.topicIdRewrites} 条消息重写为 frame topic（${canonical.topicIdRewriteSamples.join("; ")}）`,
          "warn",
        );
      }
      if (!expected.has(topicId)) {
        throw createSyncError(
          "SYNC_PROTOCOL_INVALID",
          `CDS pull returned unexpected topic ${topicId}`,
          { origin: "desktop_cds", stage: "messages", failedTopicIds: [topicId] },
        );
      }
      if (seen.has(topicId)) {
        throw createSyncError(
          "SYNC_PROTOCOL_INVALID",
          `CDS pull returned duplicate topic ${topicId}`,
          { origin: "desktop_cds", stage: "messages", failedTopicIds: [topicId] },
        );
      }
      const identity = expected.get(topicId);
      if (
        canonical.frame.ownerType !== identity.ownerType ||
        canonical.frame.ownerId !== identity.ownerId
      ) {
        throw createSyncError(
          "SYNC_OWNER_CONFLICT",
          `CDS pull returned conflicting owner identity for ${topicId}`,
          { origin: "desktop_cds", stage: "messages", failedTopicIds: [topicId] },
        );
      }
      seen.add(topicId);
      await writer.write(canonical.frame);
    }
    if (seen.size !== expected.size) {
      const missing = [...expected.keys()].filter((topicId) => !seen.has(topicId));
      throw createSyncError(
        "SYNC_MESSAGE_READ_FAILED",
        `CDS pull omitted topics: ${missing.slice(0, 8).join(", ")}`,
        { origin: "desktop_cds", stage: "messages", failedTopicIds: missing },
      );
    }
    res.end();
  }

  async uploadMessagesBatchRaw(req, res) {
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
    let topicCount = 0;
    let messageCount = 0;
    for await (const line of readNdjsonLines(req)) {
      let topicId = null;
      try {
        const frame = parseJsonWithoutDuplicateKeys(decodeNdjsonLine(line));
        topicId = frame?.topicId;
        if (
          typeof topicId !== "string" ||
          topicId.length === 0 ||
          !["agent", "group"].includes(frame.ownerType) ||
          typeof frame.ownerId !== "string" ||
          frame.ownerId.length === 0 ||
          !Array.isArray(frame.messages)
        ) {
          throw new SyncProtocolError(
            "Central message push requires exact topic owner identity and messages",
          );
        }
        topicCount += 1;
        messageCount += frame.messages.length;
        if (
          topicCount > MAX_NDJSON_TOPICS ||
          frame.messages.length > 10_000 ||
          messageCount > MAX_NDJSON_MESSAGES
        ) {
          throw new SyncProtocolError(
            "Central message push exceeds its count budget",
            "SYNC_BUDGET_EXCEEDED",
          );
        }
        if (seen.has(topicId)) {
          throw new SyncProtocolError(
            `Central message push contains duplicate topic ${topicId}`,
          );
        }
        seen.add(topicId);

        const identity = await client.syncTopicIdentity({
          topicId,
          ownerType: frame.ownerType,
          ownerId: frame.ownerId,
        });
        if (
          identity?.topicId !== topicId ||
          identity?.ownerType !== frame.ownerType ||
          identity?.ownerId !== frame.ownerId
        ) {
          throw createSyncError(
            "SYNC_PROTOCOL_INVALID",
            `CDS returned an invalid identity for topic ${topicId}`,
            { origin: "desktop_cds", stage: "messages", failedTopicIds: [topicId] },
          );
        }
        const projected = await projectMobileTopic({
          topicId,
          ownerType: identity.ownerType,
          ownerId: identity.ownerId,
          messages: frame.messages,
          db,
          appDataPath: this.appDataPath,
        });
        const result = await client.syncMessagesPushTopic({
          topicId,
          ownerType: identity.ownerType,
          ownerId: identity.ownerId,
          messages: projected.messages,
          deletedMessageIds: [],
          deletedMessageTombstones: [],
        });
        if (result?.topicId !== topicId || typeof result?.success !== "boolean") {
          throw createSyncError(
            "SYNC_PROTOCOL_INVALID",
            `CDS returned an invalid push result for ${topicId}`,
            { origin: "desktop_cds", stage: "messages", failedTopicIds: [topicId] },
          );
        }
        if (!result.success) {
          throw withCdsErrorContext(
            result.error || `CDS rejected topic ${topicId}`,
            {
              code: "SYNC_MESSAGE_WRITE_FAILED",
              origin: "desktop_cds",
              stage: "messages",
              failedTopicIds: [topicId],
            },
          );
        }
        await writer.write({
          topicId,
          success: true,
          neededAttachmentHashes: projected.neededAttachmentHashes,
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
          topicId,
          success: false,
          neededAttachmentHashes: [],
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

  async deleteEntityTombstone({
    dataType,
    id,
    ownerType,
    ownerId,
    deletedAt,
  }) {
    const isTopic = dataType === "topic";
    const stage = isTopic ? "topic_metadata" : "owner_metadata";
    const failedTopicIds = isTopic && typeof id === "string" ? [id] : [];
    const safeId =
      typeof id === "string" &&
      id.length > 0 &&
      /^[a-zA-Z0-9_-]+$/.test(id);
    const validOwnerFields = isTopic
      ? ["agent", "group"].includes(ownerType) &&
        typeof ownerId === "string" &&
        ownerId.length > 0 &&
        /^[a-zA-Z0-9_-]+$/.test(ownerId)
      : (ownerType === undefined || ownerType === null) &&
        (ownerId === undefined || ownerId === null);
    if (
      !["agent", "group", "topic"].includes(dataType) ||
      !safeId ||
      !validOwnerFields ||
      !Number.isSafeInteger(deletedAt) ||
      deletedAt < 0
    ) {
      throw createSyncError(
        "SYNC_DELETE_INVALID",
        "Central entity deletion requires a valid type, id, deletedAt, and exact topic owner",
        {
          origin: "desktop_plugin",
          stage,
          failedTopicIds,
        },
      );
    }

    const request = {
      dataType,
      id,
      deletedAt,
      ...(isTopic ? { ownerType, ownerId } : {}),
    };
    try {
      const result = await this.requireClient().syncEntityDelete(request);
      if (!isRecord(result) || result.success !== true) {
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

  async deleteMessage({ topicId, msgId, deletedAt }) {
    if (
      typeof topicId !== "string" ||
      topicId.length === 0 ||
      typeof msgId !== "string" ||
      msgId.length === 0 ||
      !Number.isSafeInteger(deletedAt) ||
      deletedAt < 0
    ) {
      throw new Error("Central message deletion requires valid topicId, msgId, and deletedAt");
    }
    const client = this.requireClient();
    const identity = await client.syncTopicIdentity({ topicId });
    if (
      identity?.topicId !== topicId ||
      !["agent", "group"].includes(identity?.ownerType) ||
      typeof identity?.ownerId !== "string" ||
      identity.ownerId.length === 0
    ) {
      throw createSyncError(
        "SYNC_PROTOCOL_INVALID",
        `CDS returned an invalid identity for topic ${topicId}`,
        { origin: "desktop_cds", stage: "messages", failedTopicIds: [topicId] },
      );
    }
    const result = await client.syncMessagesPushTopic({
      topicId,
      ownerType: identity.ownerType,
      ownerId: identity.ownerId,
      messages: [],
      deletedMessageIds: [],
      deletedMessageTombstones: [{ msgId, deletedAt }],
    });
    if (result?.topicId !== topicId || result?.success !== true) {
      throw withCdsErrorContext(
        result?.error || `CDS rejected message deletion for ${topicId}`,
        {
          code: "SYNC_DELETE_FAILED",
          origin: "desktop_cds",
          stage: "messages",
          failedTopicIds: [topicId],
        },
      );
    }
    return { success: true, topicId, msgId };
  }

  logEnabled() {
    getLogger().logInfo(
      "central",
      "VCPMobileSync 消息同步索引已切换到 VCP-CDS；旧消息扫描和 watcher 已停用。",
    );
  }
}

function createCentralSyncAdapter(chatDataService) {
  return new CentralSyncAdapter(chatDataService);
}

module.exports = {
  CentralSyncAdapter,
  createCentralSyncAdapter,
};
