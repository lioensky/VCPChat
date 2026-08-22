"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createCentralSyncAdapter,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/sync/central");
const {
  ChatDataServiceClient,
} = require("../modules/services/chatDataService/client");

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
    syncEntityDelete: async () => ({ success: true }),
    syncMessagesPush: async () => ({ results: [] }),
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

  const result = await adapter.handleSyncManifest({
    dataType: "topic",
    data: [{ id: "topic_1", hash: "remote" }],
    targetedOwners: ["agent_1"],
    phase: 2,
  });

  assert.deepEqual(captured, {
    dataType: "topic",
    data: [{ id: "topic_1", hash: "remote" }],
    targetedOwners: ["agent_1"],
  });
  // 移动端 diff_handler 对 SYNC_DIFF_RESULTS.phase 是硬门禁，中央路径必须回填
  assert.equal(result.phase, 2);
});

test("中央适配器拒绝 phase 与 dataType 不匹配的 Manifest", async () => {
  const adapter = createCentralSyncAdapter({
    client: createClient(),
  });

  await assert.rejects(
    adapter.handleSyncManifest({
      dataType: "topic",
      data: [],
      targetedOwners: ["agent_1"],
      phase: 1,
    }),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );
  await assert.rejects(
    adapter.handleSyncManifest({
      dataType: "agent",
      data: [],
      phase: 2,
    }),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );
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

test("中央启动门禁可在 SERVICE_BUSY 时持续等待既有 reconcile", async () => {
  let attempts = 0;
  const adapter = createCentralSyncAdapter({
    client: createClient({
      reconcile: async () => {
        attempts += 1;
        if (attempts <= 31) {
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
    maxAttempts: Number.POSITIVE_INFINITY,
    retryDelayMs: 0,
  });

  assert.deepEqual(result, { stats: {} });
  assert.equal(attempts, 32);
});

test("中央启动门禁不会把其他 429 错误误当成索引繁忙", async () => {
  let attempts = 0;
  const expected = Object.assign(new Error("rate limited"), {
    code: "UPSTREAM_RATE_LIMITED",
    status: 429,
    retryable: true,
  });
  const adapter = createCentralSyncAdapter({
    client: createClient({
      reconcile: async () => {
        attempts += 1;
        throw expected;
      },
    }),
  });

  await assert.rejects(
    () => adapter.reconcile({
      maxAttempts: Number.POSITIVE_INFINITY,
      retryDelayMs: 0,
    }),
    (error) => error === expected,
  );
  assert.equal(attempts, 1);
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

test("中央适配器严格保留 Phase 3 message tombstone 决策", async () => {
  const adapter = createCentralSyncAdapter({
    client: createClient({
      syncMessageDiff: async () => ({
        type: "SYNC_DIFF_RESULTS_BATCH",
        results: {
          "topic-a": {
            ok: true,
            toPull: ["message-pull"],
            toPush: false,
            toDelete: [{ msgId: "message-delete", deletedAt: 321 }],
          },
        },
      }),
    }),
  });

  const response = await adapter.handleMessageDiffBatch({
    topics: { "topic-a": {} },
  });
  assert.deepEqual(response.results["topic-a"], {
    ok: true,
    toPull: ["message-pull"],
    toPush: false,
    toDelete: [{ msgId: "message-delete", deletedAt: 321 }],
  });
});

test("中央适配器拒绝缺失 toDelete 的漂移 CDS 成功帧", async () => {
  const adapter = createCentralSyncAdapter({
    client: createClient({
      syncMessageDiff: async () => ({
        type: "SYNC_DIFF_RESULTS_BATCH",
        results: {
          "topic-a": {
            ok: true,
            toPull: [],
            toPush: false,
          },
        },
      }),
    }),
  });

  await assert.rejects(
    () => adapter.handleMessageDiffBatch({ topics: { "topic-a": {} } }),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );
});

test("中央适配器按复合 owner 身份转发 topic 实体墓碑", async () => {
  let captured;
  const adapter = createCentralSyncAdapter({
    client: createClient({
      syncEntityDelete: async (request) => {
        captured = request;
        return { success: true };
      },
    }),
  });

  const result = await adapter.deleteEntityTombstone({
    dataType: "topic",
    id: "topic-a",
    ownerType: "group",
    ownerId: "group-a",
    deletedAt: 123,
  });

  assert.deepEqual(captured, {
    dataType: "topic",
    id: "topic-a",
    ownerType: "group",
    ownerId: "group-a",
    deletedAt: 123,
  });
  assert.deepEqual(result, { success: true });
});

test("中央适配器转发 owner 墓碑时不携带 topic owner 字段", async () => {
  let captured;
  const adapter = createCentralSyncAdapter({
    client: createClient({
      syncEntityDelete: async (request) => {
        captured = request;
        return { success: true };
      },
    }),
  });

  const result = await adapter.deleteEntityTombstone({
    dataType: "agent",
    id: "agent-a",
    deletedAt: 456,
  });

  assert.deepEqual(captured, {
    dataType: "agent",
    id: "agent-a",
    deletedAt: 456,
  });
  assert.deepEqual(result, { success: true });
});

test("中央适配器在调用 CDS 前拒绝缺失 owner 身份的 topic 墓碑", async () => {
  let called = false;
  const adapter = createCentralSyncAdapter({
    client: createClient({
      syncEntityDelete: async () => {
        called = true;
      },
    }),
  });

  await assert.rejects(
    () => adapter.deleteEntityTombstone({
      dataType: "topic",
      id: "topic-a",
      ownerType: "agent",
      deletedAt: 123,
    }),
    (error) => error?.code === "SYNC_DELETE_INVALID",
  );
  assert.equal(called, false);
});

test("中央适配器把畸形 CDS 墓碑响应归为协议错误", async () => {
  const adapter = createCentralSyncAdapter({
    client: createClient({
      syncEntityDelete: async () => ({ success: false }),
    }),
  });

  await assert.rejects(
    () => adapter.deleteEntityTombstone({
      dataType: "group",
      id: "group-a",
      deletedAt: 123,
    }),
    (error) => error?.code === "SYNC_PROTOCOL_INVALID",
  );
});

test("CDS Node client 使用受保护的实体墓碑端点", async () => {
  const client = new ChatDataServiceClient({ port: 1, authToken: "test" });
  let captured;
  client.request = async (...args) => {
    captured = args;
    return { success: true };
  };
  const request = {
    dataType: "topic",
    id: "topic-a",
    ownerType: "agent",
    ownerId: "agent-a",
    deletedAt: 123,
  };

  await client.syncEntityDelete(request, { signal: "signal" });

  assert.deepEqual(captured, [
    "POST",
    "/v1/sync/entity-delete",
    request,
    { signal: "signal" },
  ]);
});
