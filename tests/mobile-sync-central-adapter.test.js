"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createCentralSyncAdapter,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/sync/central");

function createClient(overrides = {}) {
  return {
    reconcile: async () => ({ stats: {} }),
    syncManifest: async (request) => ({ type: "SYNC_DIFF_RESULTS", data: [], ...request }),
    syncMessageManifest: async () => ({
      topicId: "topic_1",
      ownerType: "agent",
      ownerId: "agent_1",
      messages: [
        {
          msgId: "msg_1",
          contentHash: "hash_1",
          updatedAt: 100,
          deletedAt: null,
        },
      ],
    }),
    syncTopicDiff: async () => ({
      type: "SYNC_TOPIC_HASH_RESULTS",
      changedTopics: [],
    }),
    syncMessageDiff: async () => ({
      type: "SYNC_DIFF_RESULTS_BATCH",
      results: {},
    }),
    syncMessagesPull: async () => [],
    syncMessagesPush: async () => ({ results: [] }),
    changes: async () => ({ changes: [], nextSequence: 0, hasMore: false }),
    ...overrides,
  };
}

test("中央适配器保持旧消息 Manifest 字段格式", async () => {
  const adapter = createCentralSyncAdapter({
    client: createClient(),
  });

  const result = await adapter.handleMessageManifest({
    topicId: "topic_1",
  });

  assert.equal(result.type, "MESSAGE_MANIFEST_RESULTS");
  assert.deepEqual(result.messages, [
    {
      msg_id: "msg_1",
      content_hash: "hash_1",
      updated_at: 100,
      deleted_at: null,
    },
  ]);
});

test("中央适配器将 WebSocket Manifest 转发给 CDS", async () => {
  let captured;
  const adapter = createCentralSyncAdapter({
    client: createClient({
      syncManifest: async (request) => {
        captured = request;
        return { type: "SYNC_DIFF_RESULTS", data: [], dataType: request.dataType };
      },
    }),
  });

  await adapter.handleSyncManifest({
    dataType: "topic",
    data: [{ id: "topic_1", hash: "remote" }],
    targetedOwners: ["agent_1"],
  });

  assert.deepEqual(captured, {
    dataType: "topic",
    data: [{ id: "topic_1", hash: "remote" }],
    targetedOwners: ["agent_1"],
  });
});

test("中央适配器保留 Change Feed 游标", async () => {
  let captured;
  const adapter = createCentralSyncAdapter({
    client: createClient({
      changes: async (after, limit) => {
        captured = { after, limit };
        return {
          changes: [{ sequence: 42 }],
          nextSequence: 42,
          hasMore: false,
        };
      },
    }),
  });

  const result = await adapter.changes(41, 20);
  assert.deepEqual(captured, { after: 41, limit: 20 });
  assert.equal(result.nextSequence, 42);
});

test("中央适配器在启动 reconcile 遇到 SERVICE_BUSY 时退避重试", async () => {
  let attempts = 0;
  const adapter = createCentralSyncAdapter({
    client: createClient({
      reconcile: async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("service is busy");
          error.code = "SERVICE_BUSY";
          error.status = 429;
          error.retryable = true;
          throw error;
        }
        return { stats: {} };
      },
    }),
  });

  const result = await adapter.reconcile({
    maxAttempts: 2,
    retryDelayMs: 0,
  });

  assert.deepEqual(result, { stats: {} });
  assert.equal(attempts, 2);
});

test("CDS 不可用时中央适配器显式失败而非静默写旧库", async () => {
  const adapter = createCentralSyncAdapter(null);

  await assert.rejects(
    () => adapter.handleMessageDiffBatch({ topics: {} }),
    (error) => error.code === "CDS_UNAVAILABLE",
  );
});