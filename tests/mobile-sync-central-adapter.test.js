"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  createCentralSyncAdapter: createAdapter,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/sync/central");
function createClient(overrides = {}) {
  return {
    reconcile: async () => ({ stats: {} }),
    request: async (_method, path, body) => {
      if (path === "/v2/sync/manifest") {
        return {
          type: "SYNC_MANIFEST_RESULT",
          manifestType: body.manifestType,
          results: [],
        };
      }
      if (path === "/v2/sync/topic-diff") {
        return { type: "SYNC_TOPIC_DIFF_RESULT", changedTopics: [] };
      }
      if (path === "/v2/sync/message-diff") {
        return { type: "SYNC_MESSAGE_DIFF_RESULT", results: [] };
      }
      if (path === "/v2/sync/entities/pull") return { results: [] };
      if (path === "/v2/sync/entities/delete") return { ok: true };
      throw new Error(`unexpected request path ${path}`);
    },
    ...overrides,
  };
}

function createCentralSyncAdapter(chatDataService) {
  return createAdapter({ chatDataService });
}

function topicIdentity() {
  return {
    topicId: "topic-a",
    ownerType: "agent",
    ownerId: "agent-a",
  };
}

function topicState(overrides = {}) {
  return {
    ...topicIdentity(),
    contentHash: "",
    messages: {},
    ...overrides,
  };
}

test("中央适配器将 WebSocket Manifest 转发给 CDS", async () => {
  let captured;
  const adapter = createCentralSyncAdapter({
    client: createClient({
      request: async (...args) => {
        captured = args;
        return {
          type: "SYNC_MANIFEST_RESULT",
          manifestType: "topic",
          results: [],
        };
      },
    }),
  });

  const result = await adapter.handleSyncManifest({
    type: "SYNC_MANIFEST_REQUEST",
    manifestType: "topic",
    items: [],
    targetedOwners: [{ ownerType: "agent", ownerId: "agent_1" }],
  });

  assert.deepEqual(captured, [
    "POST",
    "/v2/sync/manifest",
    {
      manifestType: "topic",
      items: [],
      targetedOwners: [{ ownerType: "agent", ownerId: "agent_1" }],
    },
  ]);
  assert.deepEqual(result, {
    type: "SYNC_MANIFEST_RESULT",
    manifestType: "topic",
    results: [],
  });
});

test("中央实体 Pull 将复合身份原样转发给 CDS", async () => {
  let captured;
  const response = { results: [{
    entityType: "topic",
    ownerType: "agent",
    ownerId: "agent_1",
    topicId: "topic_1",
    ok: true,
    data: { id: "topic_1", name: "Topic", createdAt: 1, locked: true, unread: false, ownerId: "agent_1" },
  }] };
  const adapter = createCentralSyncAdapter({
    client: createClient({
      request: async (...args) => {
        captured = args;
        return response;
      },
    }),
  });
  const items = [{
    entityType: "topic",
    ownerType: "agent",
    ownerId: "agent_1",
    topicId: "topic_1",
  }];

  assert.deepEqual(await adapter.pullEntities(items), response.results);
  assert.deepEqual(captured, ["POST", "/v2/sync/entities/pull", { items }]);
});

test("中央适配器拒绝缺失 ownerType 的 CDS Owner action", async () => {
  const adapter = createCentralSyncAdapter({
    client: createClient({
      request: async () => ({
        type: "SYNC_MANIFEST_RESULT",
        manifestType: "owner",
        results: [{ ownerId: "agent-a", action: "PULL" }],
      }),
    }),
  });

  await assert.rejects(
    adapter.handleSyncManifest({ manifestType: "owner", items: [] }),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );
});

test("中央 Topic hash 转发使用复合 Owner 状态而不重复同一 Topic", async () => {
  let captured;
  const state = {
    topicId: "topic_1",
    ownerType: "agent",
    ownerId: "agent_1",
    configHash: "a".repeat(64),
    contentHash: "",
  };
  const adapter = createCentralSyncAdapter({
    client: createClient({
      request: async (...args) => {
        captured = args;
        return {
          type: "SYNC_TOPIC_DIFF_RESULT",
          changedTopics: [{
            topicId: state.topicId,
            ownerType: state.ownerType,
            ownerId: state.ownerId,
          }],
        };
      },
    }),
  });

  const result = await adapter.handleTopicDiff({
    topics: [state],
  });

  assert.deepEqual(captured, [
    "POST",
    "/v2/sync/topic-diff",
    { topics: [state] },
    { timeoutMs: 270_000 },
  ]);
  assert.deepEqual(result.changedTopics, [{
    topicId: "topic_1",
    ownerType: "agent",
    ownerId: "agent_1",
  }]);
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
    () => adapter.handleMessageDiff({ topics: [] }),
    (error) => error.code === "CDS_UNAVAILABLE",
  );
});

test("中央适配器保留未知 CDS 根因并补齐来源、阶段与 Topic", async () => {
  const root = Object.assign(new Error("new CDS failure"), {
    code: "UPSTREAM_EXTENSION_FAILED",
  });
  const adapter = createCentralSyncAdapter({
    client: createClient({
      request: async () => {
        throw root;
      },
    }),
  });

  await assert.rejects(
    () => adapter.handleMessageDiff({ topics: [topicState()] }),
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
      request: async () => {
        throw Object.assign(new Error("CDS timed out"), { code: "TIMEOUT" });
      },
    }),
  });

  await assert.rejects(
    () => adapter.handleTopicDiff({ topics: [] }),
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
      request: async () => {
        throw Object.assign(new Error("CDS protocol 2 mismatch"), {
          code: "PROTOCOL_MISMATCH",
        });
      },
    }),
  });

  await assert.rejects(
    () => adapter.handleTopicDiff({ topics: [] }),
    (error) => {
      assert.equal(error.code, "CDS_PROTOCOL_MISMATCH");
      assert.equal(error.origin, "desktop_cds");
      assert.equal(error.stage, "topic_validation");
      assert.equal(error.kind, "compatibility");
      return true;
    },
  );
});

test("中央 Phase 3 的 CDS item error 会在插件边界补全而不改写根因", async () => {
  const adapter = createCentralSyncAdapter({
    client: createClient({
      request: async () => ({
        type: "SYNC_MESSAGE_DIFF_RESULT",
        results: [
          {
            ...topicIdentity(),
            ok: false,
            error: {
              code: "TOPIC_HASH_FAILED",
              message: "failed to read topic hash",
              retryable: false,
            },
          },
        ],
      }),
    }),
  });

  const response = await adapter.handleMessageDiff({
    topics: [topicState()],
  });
  assert.deepEqual(response.results[0], {
    topicId: "topic-a",
    ownerType: "agent",
    ownerId: "agent-a",
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
      request: async () => ({
        type: "SYNC_MESSAGE_DIFF_RESULT",
        results: [
          {
            ...topicIdentity(),
            ok: true,
            pullMessageIds: [],
            pushTopic: false,
            deleteMessages: [],
            error: {
              code: "INTERNAL_ERROR",
              message: "contradictory",
              retryable: false,
            },
          },
        ],
      }),
    }),
  });

  await assert.rejects(
    () => adapter.handleMessageDiff({ topics: [topicState()] }),
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
      request: async () => ({
        type: "SYNC_MESSAGE_DIFF_RESULT",
        results: [
          {
            ...topicIdentity(),
            ok: true,
            pullMessageIds: ["message-pull"],
            pushTopic: false,
            deleteMessages: [{ msgId: "message-delete", deletedAt: 321 }],
          },
        ],
      }),
    }),
  });

  const response = await adapter.handleMessageDiff({
    topics: [topicState()],
  });
  assert.deepEqual(response.results[0], {
    topicId: "topic-a",
    ownerType: "agent",
    ownerId: "agent-a",
    ok: true,
    pullMessageIds: ["message-pull"],
    pushTopic: false,
    deleteMessages: [{ msgId: "message-delete", deletedAt: 321 }],
  });
});

test("中央适配器拒绝缺失 deleteMessages 的漂移 CDS 成功帧", async () => {
  const adapter = createCentralSyncAdapter({
    client: createClient({
      request: async () => ({
        type: "SYNC_MESSAGE_DIFF_RESULT",
        results: [
          {
            ...topicIdentity(),
            ok: true,
            pullMessageIds: [],
            pushTopic: false,
          },
        ],
      }),
    }),
  });

  await assert.rejects(
    () => adapter.handleMessageDiff({ topics: [topicState()] }),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );
});

test("中央适配器按复合 owner 身份转发 topic 实体墓碑", async () => {
  let captured;
  const adapter = createCentralSyncAdapter({
    client: createClient({
      request: async (...args) => {
        captured = args;
        return { ok: true };
      },
    }),
  });

  const target = {
    targetType: "topic",
    ownerType: "group",
    ownerId: "group-a",
    topicId: "topic-a",
    deletedAt: 123,
  };
  const result = await adapter.deleteEntityTombstone(target);

  assert.deepEqual(captured, [
    "POST",
    "/v2/sync/entities/delete",
    target,
  ]);
  assert.deepEqual(result, { ok: true });
});

test("中央适配器原样转发完整 owner 墓碑", async () => {
  let captured;
  const adapter = createCentralSyncAdapter({
    client: createClient({
      request: async (...args) => {
        captured = args;
        return { ok: true };
      },
    }),
  });

  const target = {
    targetType: "owner",
    ownerType: "agent",
    ownerId: "agent-a",
    deletedAt: 456,
  };
  const result = await adapter.deleteEntityTombstone(target);

  assert.deepEqual(captured, [
    "POST",
    "/v2/sync/entities/delete",
    target,
  ]);
  assert.deepEqual(result, { ok: true });
});

test("中央适配器在调用 CDS 前拒绝缺失 owner 身份的 topic 墓碑", async () => {
  let called = false;
  const adapter = createCentralSyncAdapter({
    client: createClient({
      request: async () => {
        called = true;
      },
    }),
  });

  await assert.rejects(
    () => adapter.deleteEntityTombstone({
      targetType: "topic",
      ownerType: "agent",
      topicId: "topic-a",
      deletedAt: 123,
    }),
    (error) => error?.code === "SYNC_DELETE_INVALID",
  );
  assert.equal(called, false);
});

test("中央适配器把畸形 CDS 墓碑响应归为协议错误", async () => {
  const adapter = createCentralSyncAdapter({
    client: createClient({
      request: async () => ({ ok: false }),
    }),
  });

  await assert.rejects(
    () => adapter.deleteEntityTombstone({
      targetType: "owner",
      ownerType: "group",
      ownerId: "group-a",
      deletedAt: 123,
    }),
    (error) => error?.code === "SYNC_PROTOCOL_INVALID",
  );
});
