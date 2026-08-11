"use strict";

const { getDb } = require("../core/db");
const { getLogger } = require("../core/logger");
const { parseJsonWithoutDuplicateKeys } = require("../protocol");
const { canonicalizeTopicFrame } = require("./canonical");
const { projectMobileTopic } = require("./projection");
const {
  MAX_NDJSON_MESSAGES,
  MAX_NDJSON_TOPICS,
  NdjsonWriter,
  decodeNdjsonLine,
  readNdjsonLines,
} = require("../transport/ndjson");

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
      const error = new Error("VCP-CDS is unavailable");
      error.code = "CDS_UNAVAILABLE";
      throw error;
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
        const isBusy =
          error?.code === "SERVICE_BUSY" ||
          (error?.status === 429 && error?.retryable === true);
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
    return this.requireClient().syncManifest({
      dataType: payload.dataType,
      data: payload.data || [],
      targetedOwners: payload.targetedOwners || null,
    });
  }

  async handleMessageManifest(payload) {
    const result = await this.requireClient().syncMessageManifest({
      topicId: payload.topicId,
      ownerType: payload.ownerType || null,
      ownerId: payload.ownerId || null,
    });
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
  }

  async handleTopicHashBatch(payload) {
    return this.requireClient().syncTopicDiff({
      hashes: payload.hashes || {},
      topics: payload.topics || [],
    });
  }

  async handleMessageDiffBatch(payload) {
    return this.requireClient().syncMessageDiff({
      topics: payload.topics || {},
    });
  }

  async downloadMessagesStreamRaw(requests, res) {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.flushHeaders();

    if (!Array.isArray(requests) || requests.length > MAX_NDJSON_TOPICS) {
      throw new Error("Central pull requires at most 10000 topic requests");
    }
    const expected = new Set();
    let requestedMessages = 0;
    const normalizedRequests = requests.map((request) => {
      if (
        !request ||
        typeof request.topicId !== "string" ||
        request.topicId.length === 0 ||
        !Array.isArray(request.msgIds)
      ) {
        throw new Error("Central pull request has an invalid topic frame");
      }
      if (expected.has(request.topicId)) {
        throw new Error(`Central pull contains duplicate topic ${request.topicId}`);
      }
      const uniqueIds = new Set(request.msgIds);
      if (
        uniqueIds.size !== request.msgIds.length ||
        request.msgIds.some((id) => typeof id !== "string" || id.length === 0)
      ) {
        throw new Error(`Central pull ${request.topicId} has invalid message ids`);
      }
      requestedMessages += request.msgIds.length;
      if (
        request.msgIds.length > 10_000 ||
        requestedMessages > MAX_NDJSON_MESSAGES
      ) {
        throw new Error("Central pull exceeds the message count budget");
      }
      expected.add(request.topicId);
      return {
        topicId: request.topicId,
        ownerType: request.ownerType || null,
        ownerId: request.ownerId || null,
        msgIds: request.msgIds,
      };
    });

    const writer = new NdjsonWriter(res);
    const seen = new Set();
    for await (const rawFrame of this.requireClient().syncMessagesPullStream({
      requests: normalizedRequests,
    })) {
      const canonical = canonicalizeTopicFrame(rawFrame);
      const topicId = canonical.frame.topicId;
      if (!expected.has(topicId)) {
        throw new Error(`CDS pull returned unexpected topic ${topicId}`);
      }
      if (seen.has(topicId)) {
        throw new Error(`CDS pull returned duplicate topic ${topicId}`);
      }
      seen.add(topicId);
      await writer.write(canonical.frame);
    }
    if (seen.size !== expected.size) {
      const missing = [...expected].filter((topicId) => !seen.has(topicId));
      throw new Error(`CDS pull omitted topics: ${missing.slice(0, 8).join(", ")}`);
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
          !Array.isArray(frame.messages)
        ) {
          throw new Error("Central message push requires topicId and messages");
        }
        topicCount += 1;
        messageCount += frame.messages.length;
        if (
          topicCount > MAX_NDJSON_TOPICS ||
          frame.messages.length > 10_000 ||
          messageCount > MAX_NDJSON_MESSAGES
        ) {
          throw new Error("Central message push exceeds its count budget");
        }
        if (seen.has(topicId)) {
          throw new Error(`Central message push contains duplicate topic ${topicId}`);
        }
        seen.add(topicId);

        const identity = await client.syncTopicIdentity({ topicId });
        if (
          identity?.topicId !== topicId ||
          !["agent", "group"].includes(identity?.ownerType) ||
          typeof identity?.ownerId !== "string" ||
          identity.ownerId.length === 0
        ) {
          throw new Error(`CDS returned an invalid identity for topic ${topicId}`);
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
          throw new Error(`CDS returned an invalid push result for ${topicId}`);
        }
        if (!result.success) {
          throw new Error(result.error || `CDS rejected topic ${topicId}`);
        }
        const needed = new Set(projected.neededAttachmentHashes);
        const cdsNeeded = result.neededAttachmentHashes;
        if (!Array.isArray(cdsNeeded)) {
          throw new Error(`CDS omitted neededAttachmentHashes for ${topicId}`);
        }
        for (const hash of cdsNeeded) needed.add(hash);
        await writer.write({
          topicId,
          success: true,
          neededAttachmentHashes: [...needed].sort(),
        });
      } catch (error) {
        if (typeof topicId !== "string" || topicId.length === 0) throw error;
        await writer.write({
          topicId,
          success: false,
          neededAttachmentHashes: [],
          error: error.message,
        });
      }
    }
    res.end();
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
      throw new Error(`CDS returned an invalid identity for topic ${topicId}`);
    }
    const result = await client.syncMessagesPushTopic({
      topicId,
      ownerType: identity.ownerType,
      ownerId: identity.ownerId,
      messages: [],
      deletedMessageIds: [],
      deletedMessageTombstones: [{ msgId, deletedAt }],
    });
    if (
      result?.topicId !== topicId ||
      result?.success !== true ||
      !Array.isArray(result?.neededAttachmentHashes)
    ) {
      throw new Error(result?.error || `CDS rejected message deletion for ${topicId}`);
    }
    return { success: true, topicId, msgId };
  }

  async changes(after = 0, limit = 200) {
    return this.requireClient().changes(after, limit);
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
