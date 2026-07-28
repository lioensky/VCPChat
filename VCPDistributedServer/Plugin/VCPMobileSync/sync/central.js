"use strict";

const readline = require("readline");
const { getLogger } = require("../core/logger");

class CentralSyncAdapter {
  constructor(chatDataService) {
    this.chatDataService = chatDataService;
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

  async reconcile() {
    return this.requireClient().reconcile();
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
    const frames = await this.requireClient().syncMessagesPull({
      requests: requests.map((request) => ({
        topicId: request.topicId,
        ownerType: request.ownerType || null,
        ownerId: request.ownerId || null,
        msgIds: request.msgIds || [],
      })),
    });

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.flushHeaders();
    for (const frame of frames) {
      res.write(`${JSON.stringify(frame)}\n`);
    }
    res.end();
  }

  async uploadMessagesBatchRaw(req, res) {
    const topics = [];
    const parser = readline.createInterface({
      input: req,
      terminal: false,
    });

    for await (const line of parser) {
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      if (!frame.topicId) {
        throw new Error("Central message push requires topicId");
      }
      topics.push({
        topicId: frame.topicId,
        ownerType: frame.ownerType,
        ownerId: frame.ownerId,
        messages: Array.isArray(frame.messages) ? frame.messages : [],
        deletedMessageIds: Array.isArray(frame.deletedMessageIds)
          ? frame.deletedMessageIds
          : [],
      });
    }

    const result = await this.requireClient().syncMessagesPush({ topics });
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.flushHeaders();
    for (const item of result.results || []) {
      res.write(`${JSON.stringify(item)}\n`);
    }
    res.end();
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