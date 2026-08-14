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
      type: "MESSAGE_MANIFEST_RESULTS",
      topicId: "topic_1",
      ownerType: "agent",
      ownerId: "agent_1",
      messages: [
        {
          msgId: "msg_1",
          contentHash: "a".repeat(64),
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
      content_hash: "a".repeat(64),
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

test("中央 Topic hash 转发使用复合 Owner 状态而不重复同一 Topic", async () => {
  let captured;
  const adapter = createCentralSyncAdapter({
    client: createClient({
      syncTopicDiff: async (request) => {
        captured = request;
        return { type: "SYNC_TOPIC_HASH_RESULTS", changedTopics: [] };
      },
    }),
  });
  const state = {
    topicId: "topic_1",
    ownerType: "agent",
    ownerId: "agent_1",
    configHash: "a".repeat(64),
    contentHash: "",
  };

  await adapter.handleTopicHashBatch({
    hashes: {
      topic_1: {
        configHash: state.configHash,
        contentHash: state.contentHash,
      },
    },
    topics: [state],
  });

  assert.deepEqual(captured, { hashes: {}, topics: [state] });
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

test("中央适配器保留未知 CDS 根因并补齐来源、阶段与 Topic", async () => {
  const root = Object.assign(new Error("new CDS failure"), {
    code: "UPSTREAM_EXTENSION_FAILED",
  });
  const adapter = createCentralSyncAdapter({
    client: createClient({
      syncMessageDiff: async () => {
        throw root;
      },
    }),
  });

  await assert.rejects(
    () => adapter.handleMessageDiffBatch({ topics: { "topic-a": {} } }),
    (error) => {
      assert.equal(error.code, "UPSTREAM_EXTENSION_FAILED");
      assert.equal(error.origin, "desktop_cds");
      assert.equal(error.stage, "messages");
      assert.equal(error.kind, "internal");
      assert.equal(error.retry, "manual");
      assert.deepEqual(error.failedTopicIds, ["topic-a"]);
      return true;
    },
  );
});

test("中央客户端通用 TIMEOUT 不会被误归为内部错误", async () => {
  const adapter = createCentralSyncAdapter({
    client: createClient({
      syncTopicDiff: async () => {
        throw Object.assign(new Error("CDS timed out"), { code: "TIMEOUT" });
      },
    }),
  });

  await assert.rejects(
    () => adapter.handleTopicHashBatch({ hashes: {}, topics: [] }),
    (error) => {
      assert.equal(error.code, "TIMEOUT");
      assert.equal(error.origin, "desktop_cds");
      assert.equal(error.stage, "topic_validation");
      assert.equal(error.kind, "connection");
      return true;
    },
  );
});

test("CDS internal protocol mismatch 不会冒充 Mobile wire mismatch", async () => {
  const adapter = createCentralSyncAdapter({
    client: createClient({
      syncTopicDiff: async () => {
        throw Object.assign(new Error("CDS protocol 2 mismatch"), {
          code: "PROTOCOL_MISMATCH",
        });
      },
    }),
  });

  await assert.rejects(
    () => adapter.handleTopicHashBatch({ hashes: {}, topics: [] }),
    (error) => {
      assert.equal(error.code, "CDS_PROTOCOL_MISMATCH");
      assert.equal(error.origin, "desktop_cds");
      assert.equal(error.stage, "topic_validation");
      assert.equal(error.kind, "compatibility");
      return true;
    },
  );
});

test("中央 Phase 3 的二字段错误会在插件边界补全而不改写根因", async () => {
  const adapter = createCentralSyncAdapter({
    client: createClient({
      syncMessageDiff: async () => ({
        type: "SYNC_DIFF_RESULTS_BATCH",
        results: {
          "topic-a": {
            ok: false,
            error: {
              code: "TOPIC_HASH_FAILED",
              message: "failed to read topic hash",
            },
          },
        },
      }),
    }),
  });

  const response = await adapter.handleMessageDiffBatch({
    topics: { "topic-a": {} },
  });
  assert.deepEqual(response.results["topic-a"], {
    ok: false,
    error: {
      code: "TOPIC_HASH_FAILED",
      origin: "desktop_cds",
      stage: "messages",
      kind: "storage",
      retry: "manual",
      message: "failed to read topic hash",
      failedTopicIds: ["topic-a"],
    },
  });
});

test("中央适配器将畸形 CDS Phase 3 成功帧归为上游协议错误", async () => {
  const adapter = createCentralSyncAdapter({
    client: createClient({
      syncMessageDiff: async () => ({
        type: "SYNC_DIFF_RESULTS_BATCH",
        results: {
          "topic-a": {
            ok: true,
            toPull: [],
            toPush: false,
            error: { code: "INTERNAL_ERROR", message: "contradictory" },
          },
        },
      }),
    }),
  });

  await assert.rejects(
    () => adapter.handleMessageDiffBatch({ topics: { "topic-a": {} } }),
    (error) => {
      assert.equal(error.code, "SYNC_PROTOCOL_INVALID");
      assert.equal(error.origin, "desktop_cds");
      assert.equal(error.stage, "messages");
      assert.equal(error.kind, "protocol");
      assert.deepEqual(error.failedTopicIds, ["topic-a"]);
      return true;
    },
  );
});
