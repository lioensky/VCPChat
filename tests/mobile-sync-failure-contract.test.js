"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  resolveCentralIndexPreference,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/config/defaults");
const entityDatabase = require("../VCPDistributedServer/Plugin/VCPMobileSync/core/db");
const issue20EntityIndex = new Map();
entityDatabase.getDb = () => ({});
entityDatabase.getEntityIndex = (id, type) =>
  issue20EntityIndex.get(`${type}:${id}`) || null;
entityDatabase.upsertEntityIndex = (id, type, filePath, hash) => {
  issue20EntityIndex.set(`${type}:${id}`, {
    id,
    type,
    file_path: filePath,
    hash,
    deleted_at: null,
  });
};
const {
  handleSyncTopicHashBatch,
  handleSyncTopicHashBatchV2,
  handleSyncMessageDiffBatch,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/sync/diff");
const {
  checkIdempotency,
  recordOperation,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/core/idempotency");
const {
  readHistoryStrict,
  writeHistoryAtomic,
  resolveMessageUpdatedAt,
  markHistoryTopicUnhealthy,
  clearHistoryTopicUnhealthy,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/sync/message");
const {
  getLocalManifest,
  handleSyncManifest,
  handleMessageManifest,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/sync/manifest");
const {
  uploadEntity,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/sync/entity");

function fakeDiffDatabase({ topics = {}, messages = {}, fail = false } = {}) {
  return {
    prepare(sql) {
      if (fail) throw new Error("injected database failure");
      if (sql.includes("FROM entity_index")) {
        return { get: (topicId) => topics[topicId] };
      }
      if (sql.includes("FROM message_index")) {
        return { all: (topicId) => messages[topicId] || [] };
      }
      throw new Error(`unexpected SQL in fake database: ${sql}`);
    },
  };
}

function fakeManifestDatabase({ entities = [], avatars = [], messages = [] } = {}) {
  return {
    prepare(sql) {
      if (sql.includes("FROM avatar_index")) {
        return { all: () => avatars };
      }
      if (sql.includes("FROM entity_index") && sql.includes("type = ?")) {
        return { all: (type) => entities.filter((row) => row.type === type) };
      }
      if (sql.includes("FROM entity_index")) {
        return {
          all: () => entities.filter((row) =>
            ["topic", "agent_topic", "group_topic"].includes(row.type)),
        };
      }
      if (sql.includes("FROM message_index")) {
        return { all: (topicId) => messages.filter((row) => row.topic_id === topicId) };
      }
      throw new Error(`unexpected SQL in fake manifest database: ${sql}`);
    },
  };
}

function version(hash, updatedAt = 1) {
  return { hash, updatedAt };
}

test("中央索引配置优先级是插件显式值 > Facade > 默认 true", () => {
  assert.equal(
    resolveCentralIndexPreference(
      { MobileSyncUseCentralIndex: false },
      { mobileSyncUseCentralIndex: true },
    ),
    false,
  );
  assert.equal(
    resolveCentralIndexPreference(
      { MobileSyncUseCentralIndex: true },
      { mobileSyncUseCentralIndex: false },
    ),
    true,
  );
  assert.equal(
    resolveCentralIndexPreference({}, { mobileSyncUseCentralIndex: false }),
    false,
  );
  assert.equal(resolveCentralIndexPreference({}, {}), true);
});

test("Phase 3 decision 只返回严格判别联合且不在 diff 中执行删除", () => {
  const remoteHash = "a".repeat(64);
  const result = handleSyncMessageDiffBatch(
    {
      topics: {
        "topic-live": {
          topicHash: "c".repeat(64),
          ownerType: "agent",
          ownerId: "agent-a",
          messages: { "message-1": version("DELETED") },
        },
        "topic-missing": {
          topicHash: "",
          ownerType: "agent",
          ownerId: "agent-a",
          messages: {},
        },
      },
    },
    fakeDiffDatabase({
      topics: {
        "topic-live": {
          aggregated_hash: "desktop",
          file_path: "/app/Agents/agent-a/config.json",
        },
      },
      messages: {
        "topic-live": [{ msg_id: "message-1", hash: remoteHash }],
      },
    }),
  );

  assert.deepEqual(result.results["topic-live"], {
    ok: true,
    toPull: [],
    toPush: true,
    toDelete: [],
  });
  assert.deepEqual(result.results["topic-missing"], {
    ok: false,
    error: {
      code: "TOPIC_NOT_FOUND",
      origin: "desktop_plugin",
      stage: "messages",
      kind: "data",
      retry: "manual",
      message: "Topic topic-missing was not found in the desktop index",
      failedTopicIds: ["topic-missing"],
    },
  });
});

test("Phase 3 墓碑四象限显式区分 delete、push 与 pull", () => {
  const hashes = {
    desktopOnly: "a".repeat(64),
    desktopLive: "b".repeat(64),
    mobileLive: "c".repeat(64),
    mismatchDesktop: "d".repeat(64),
    mismatchMobile: "e".repeat(64),
    matched: "f".repeat(64),
  };
  const topicId = "topic-tombstones";
  const result = handleSyncMessageDiffBatch(
    {
      topics: {
        [topicId]: {
          topicHash: "9".repeat(64),
          ownerType: "agent",
          ownerId: "agent-a",
          messages: {
            "desktop-live-mobile-deleted": version("DELETED"),
            "desktop-deleted-mobile-live": version(hashes.mobileLive),
            "both-deleted": version("DELETED"),
            "hash-mismatch": version(hashes.mismatchMobile, 1),
            matched: version(hashes.matched),
            "mobile-only-live": version(hashes.mobileLive),
            "mobile-only-deleted": version("DELETED"),
          },
        },
      },
    },
    fakeDiffDatabase({
      topics: {
        [topicId]: {
          aggregated_hash: "desktop-root",
          file_path: "/app/Agents/agent-a/config.json",
        },
      },
      messages: {
        [topicId]: [
          {
            msg_id: "desktop-live-mobile-deleted",
            hash: hashes.desktopLive,
            updated_at: 1,
            deleted_at: null,
          },
          {
            msg_id: "desktop-deleted-mobile-live",
            hash: "0".repeat(64),
            updated_at: 123,
            deleted_at: 123,
          },
          {
            msg_id: "both-deleted",
            hash: "0".repeat(64),
            updated_at: 456,
            deleted_at: 456,
          },
          {
            msg_id: "desktop-only-live",
            hash: hashes.desktopOnly,
            updated_at: 1,
            deleted_at: null,
          },
          {
            msg_id: "hash-mismatch",
            hash: hashes.mismatchDesktop,
            updated_at: 2,
            deleted_at: null,
          },
          {
            msg_id: "matched",
            hash: hashes.matched,
            updated_at: 1,
            deleted_at: null,
          },
        ],
      },
    }),
  );

  assert.deepEqual(result.results[topicId], {
    ok: true,
    toPull: ["desktop-only-live", "hash-mismatch"],
    toPush: true,
    toDelete: [{ msgId: "desktop-deleted-mobile-live", deletedAt: 123 }],
  });
});

test("Phase 3 live 冲突按时间优胜并以 Hash 打破同时间平局", () => {
  const topicId = "topic-lww";
  const low = "1".repeat(64);
  const high = "e".repeat(64);
  const result = handleSyncMessageDiffBatch(
    {
      topics: {
        [topicId]: {
          topicHash: "9".repeat(64),
          ownerType: "agent",
          ownerId: "agent-a",
          messages: {
            "mobile-newer": version(low, 20),
            "desktop-newer": version(high, 10),
            "mobile-tie-wins": version(high, 30),
            "desktop-tie-wins": version(low, 40),
          },
        },
      },
    },
    fakeDiffDatabase({
      topics: {
        [topicId]: {
          aggregated_hash: "desktop-root",
          file_path: "/app/Agents/agent-a/config.json",
        },
      },
      messages: {
        [topicId]: [
          { msg_id: "mobile-newer", hash: high, updated_at: 10, deleted_at: null },
          { msg_id: "desktop-newer", hash: low, updated_at: 20, deleted_at: null },
          { msg_id: "mobile-tie-wins", hash: low, updated_at: 30, deleted_at: null },
          { msg_id: "desktop-tie-wins", hash: high, updated_at: 40, deleted_at: null },
        ],
      },
    }),
  );

  assert.deepEqual(result.results[topicId], {
    ok: true,
    toPull: ["desktop-newer", "desktop-tie-wins"],
    toPush: true,
    toDelete: [],
  });
});

test("Legacy 检测更新时间覆盖物理、创建、稳定与变更四分支", () => {
  const hash = "a".repeat(64);
  assert.equal(resolveMessageUpdatedAt({ timestamp: 10, updatedAt: 11 }, hash, null, 99), 11);
  assert.equal(resolveMessageUpdatedAt({ timestamp: 10 }, hash, null, 99), 10);
  assert.equal(
    resolveMessageUpdatedAt({ timestamp: 10 }, hash, { hash, updated_at: 12 }, 99),
    12,
  );
  assert.equal(
    resolveMessageUpdatedAt(
      { timestamp: 10 },
      hash,
      { hash: "b".repeat(64), updated_at: 12 },
      99,
    ),
    99,
  );
});

test("Phase 3 相同 live root 仍会上传 Mobile-only 墓碑", () => {
  const topicHash = "a".repeat(64);
  const result = handleSyncMessageDiffBatch(
    {
      topics: {
        "topic-equal-root": {
          topicHash,
          ownerType: "agent",
          ownerId: "agent-a",
          messages: { "mobile-only-deleted": version("DELETED") },
        },
      },
    },
    fakeDiffDatabase({
      topics: {
        "topic-equal-root": {
          aggregated_hash: topicHash,
          file_path: "/app/Agents/agent-a/config.json",
        },
      },
    }),
  );

  assert.deepEqual(result.results["topic-equal-root"], {
    ok: true,
    toPull: [],
    toPush: true,
    toDelete: [],
  });
});

test("Phase 3 malformed hash 与 DB 查询错误都不能伪装成 no-op 完成", () => {
  assert.throws(
    () =>
      handleSyncMessageDiffBatch(
        {
          topics: {
            topic: {
              topicHash: "",
              ownerType: "agent",
              ownerId: "agent-a",
              messages: { message: version("not-a-hash") },
            },
          },
        },
        fakeDiffDatabase(),
      ),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );

  const result = handleSyncMessageDiffBatch(
    {
      topics: {
        topic: {
          topicHash: "",
          ownerType: "agent",
          ownerId: "agent-a",
          messages: {},
        },
      },
    },
    fakeDiffDatabase({ fail: true }),
  );
  assert.equal(result.results.topic.ok, false);
  assert.equal(result.results.topic.error.code, "MESSAGE_DIFF_FAILED");
  assert.match(result.results.topic.error.message, /injected database failure/);
});

test("Phase 2.5 topic hash 对错误类型和超预算 fail closed", () => {
  assert.throws(
    () => handleSyncTopicHashBatch({ hashes: { topic: null } }),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );
  assert.throws(
    () =>
      handleSyncTopicHashBatchV2({
        hashes: { topic: { configHash: "bad", contentHash: "" } },
      }),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );
  const hashes = Object.fromEntries(
    Array.from({ length: 10_001 }, (_, index) => [`topic-${index}`, ""]),
  );
  assert.throws(
    () => handleSyncTopicHashBatch({ hashes }),
    (error) => error.code === "SYNC_BUDGET_EXCEEDED",
  );
});

test("issue #20: 未初始化数据库不会伪装成无变化 topic", () => {
  const hash = "a".repeat(64);
  assert.throws(
    () =>
      handleSyncTopicHashBatchV2(
        {
          hashes: {
            "topic-issue-20": { configHash: hash, contentHash: hash },
          },
          topics: [
            {
              topicId: "topic-issue-20",
              ownerType: "agent",
              ownerId: "agent-issue-20",
              configHash: hash,
              contentHash: hash,
            },
          ],
        },
        null,
      ),
    (error) => error.code === "SYNC_DB_UNAVAILABLE",
  );
});

test("issue #20: 手机新建 Agent/Group 时先创建桌面目标目录", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-issue-20-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  issue20EntityIndex.clear();

  const agentId = "agent_issue_20";
  const groupId = "group_issue_20";
  const agentResult = await uploadEntity({
    id: agentId,
    type: "agent",
    data: { name: "Mobile Agent" },
    appDataPath: directory,
  });
  const groupResult = await uploadEntity({
    id: groupId,
    type: "group",
    data: { name: "Mobile Group", members: [] },
    appDataPath: directory,
  });

  assert.deepEqual(agentResult, { success: true, id: agentId });
  assert.deepEqual(groupResult, { success: true, id: groupId });
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(directory, "Agents", agentId, "config.json"),
        "utf8",
      ),
    ).name,
    "Mobile Agent",
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(directory, "AgentGroups", groupId, "config.json"),
        "utf8",
      ),
    ).name,
    "Mobile Group",
  );
});

test("Topic manifest 使用复合 Owner 身份且不做路径模糊匹配", () => {
  const hash = "a".repeat(64);
  const database = fakeManifestDatabase({
    entities: [
      {
        id: "topic-a",
        type: "topic",
        file_path: "/app/Agents/agent-a/config.json",
        hash,
        aggregated_hash: "",
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: "topic-b",
        type: "topic",
        file_path: "/app/Agents/agent-aa/config.json",
        hash,
        aggregated_hash: "",
        updated_at: 1,
        deleted_at: null,
      },
    ],
  });

  assert.deepEqual(
    getLocalManifest("topic", ["agent-a"], database).map((item) => item.id),
    ["topic-a"],
  );
  const result = handleSyncManifest(
    {
      dataType: "topic",
      phase: 2,
      targetedOwners: ["agent-a"],
      data: [{
        id: "topic-a",
        hash,
        configHash: hash,
        contentHash: "",
        ts: 1,
        ownerType: "agent",
        ownerId: "agent-a",
      }],
    },
    database,
  );
  assert.deepEqual(result.data, []);

  assert.throws(
    () => handleSyncManifest(
      {
        dataType: "topic",
        phase: 2,
        targetedOwners: ["agent-a", "agent-b"],
        data: [{
          id: "topic-a",
          hash,
          configHash: hash,
          contentHash: "",
          ts: 1,
          ownerType: "agent",
          ownerId: "agent-b",
        }],
      },
      database,
    ),
    (error) => error.code === "SYNC_OWNER_CONFLICT",
  );
});

test("legacy manifest、hash 与 message diff 全部排除 default", () => {
  const hash = "a".repeat(64);
  const database = fakeManifestDatabase({
    entities: [
      {
        id: "default",
        type: "topic",
        file_path: "/app/Agents/agent-a/config.json",
        hash,
        aggregated_hash: hash,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: "topic-live",
        type: "topic",
        file_path: "/app/Agents/agent-a/config.json",
        hash,
        aggregated_hash: hash,
        updated_at: 1,
        deleted_at: null,
      },
    ],
  });

  assert.deepEqual(
    getLocalManifest("topic", null, database).map((item) => item.id),
    ["topic-live"],
  );
  assert.deepEqual(
    handleSyncTopicHashBatch({ hashes: { default: hash } }, database),
    { type: "SYNC_TOPIC_HASH_RESULTS", changedTopics: [] },
  );
  assert.deepEqual(
    handleSyncMessageDiffBatch({
      topics: {
        default: {
          topicHash: hash,
          ownerType: "agent",
          ownerId: "agent-a",
          messages: {},
        },
      },
    }, database),
    {
      type: "SYNC_DIFF_RESULTS_BATCH",
      results: {
        default: { ok: true, toPull: [], toPush: false, toDelete: [] },
      },
    },
  );
  assert.deepEqual(
    handleMessageManifest({ topicId: "default" }, database),
    { type: "MESSAGE_MANIFEST_RESULTS", topicId: "default", messages: [] },
  );
  assert.deepEqual(
    handleSyncManifest({
      dataType: "topic",
      phase: 2,
      targetedOwners: ["agent-a"],
      data: [{
        id: "default",
        hash,
        configHash: hash,
        contentHash: hash,
        ts: 1,
        ownerType: "agent",
        ownerId: "agent-a",
      }],
    }, database),
    { type: "SYNC_DIFF_RESULTS", data: [{
      id: "topic-live",
      action: "PULL",
      ownerType: "agent",
      ownerId: "agent-a",
    }], dataType: "topic", phase: 2 },
  );
});

test("实体 manifest 墓碑四象限保持动作方向", () => {
  const hash = "b".repeat(64);
  const localItem = (id, deletedAt) => ({
    id,
    type: "agent",
    file_path: `/app/Agents/${id}/config.json`,
    hash,
    aggregated_hash: "",
    updated_at: 1,
    deleted_at: deletedAt,
  });
  const remoteItem = (id, deletedAt = null) => ({
    id,
    hash,
    configHash: hash,
    contentHash: "",
    ts: 1,
    ...(deletedAt === null ? {} : { deletedAt }),
  });
  const database = fakeManifestDatabase({
    entities: [
      localItem("mobile-deleted-desktop-live", null),
      localItem("desktop-deleted-mobile-live", 21),
      localItem("desktop-deleted-mobile-missing", 22),
    ],
  });

  const result = handleSyncManifest(
    {
      dataType: "agent",
      phase: 1,
      data: [
        remoteItem("mobile-deleted-desktop-live", 11),
        remoteItem("mobile-deleted-desktop-missing", 12),
        remoteItem("desktop-deleted-mobile-live"),
      ],
    },
    database,
  );

  assert.deepEqual(result.data, [
    {
      id: "mobile-deleted-desktop-live",
      action: "PUSH_DELETE",
      deletedAt: 11,
    },
    {
      id: "mobile-deleted-desktop-missing",
      action: "PUSH_DELETE",
      deletedAt: 12,
    },
    {
      id: "desktop-deleted-mobile-live",
      action: "DELETE",
      deletedAt: 21,
    },
    {
      id: "desktop-deleted-mobile-missing",
      action: "DELETE",
      deletedAt: 22,
    },
  ]);
});

test("Manifest 错型、重复 ID 和 deletedAt=0 均按硬切契约处理", () => {
  const hash = "b".repeat(64);
  const database = fakeManifestDatabase();
  assert.throws(
    () => handleSyncManifest({ dataType: "agent", phase: 1, data: {} }, database),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );
  const item = {
    id: "agent-a",
    hash,
    configHash: hash,
    contentHash: "",
    ts: 1,
  };
  assert.throws(
    () => handleSyncManifest(
      { dataType: "agent", phase: 1, data: [item, item] },
      database,
    ),
    /duplicate id/,
  );
  const result = handleSyncManifest(
    {
      dataType: "agent",
      phase: 1,
      data: [{ ...item, deletedAt: 0 }],
    },
    database,
  );
  assert.deepEqual(result.data, [
    { id: "agent-a", action: "PUSH_DELETE", deletedAt: 0 },
  ]);
});

test("损坏 history 的旧索引不能走 topic hash 或消息 manifest 快速成功", () => {
  const topicId = "topic-unhealthy";
  markHistoryTopicUnhealthy(topicId, new Error("invalid JSON"));
  try {
    assert.throws(
      () => handleSyncTopicHashBatch(
        { hashes: { [topicId]: "" } },
        fakeDiffDatabase({ topics: { [topicId]: { aggregated_hash: "" } } }),
      ),
      (error) => error.code === "HISTORY_SOURCE_INVALID",
    );
    assert.throws(
      () => handleMessageManifest(
        { topicId },
        fakeManifestDatabase(),
      ),
      (error) => error.code === "HISTORY_SOURCE_INVALID",
    );
  } finally {
    clearHistoryTopicUnhealthy(topicId);
  }
});

test("幂等失败重放保留原 HTTP 状态", () => {
  const operationId = `failure-${process.pid}-${Date.now()}`;
  recordOperation(operationId, { success: false, error: "durable failure" }, 409);
  assert.deepEqual(checkIdempotency(operationId), {
    duplicate: true,
    result: { success: false, error: "durable failure" },
    statusCode: 409,
  });
});

test("history.json 只有不存在可视为空，损坏内容绝不被覆盖", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-history-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const historyPath = path.join(directory, "history.json");

  assert.deepEqual(await readHistoryStrict(historyPath), {
    history: [],
    sourceHash: null,
  });

  fs.writeFileSync(historyPath, "", "utf8");
  await assert.rejects(() => readHistoryStrict(historyPath), /Invalid history JSON/);
  fs.writeFileSync(historyPath, '{"messages":[]}', "utf8");
  await assert.rejects(() => readHistoryStrict(historyPath), /expected an array/);
});

test("history 原子提交在 source hash 变化时保留并发写入", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-cas-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const historyPath = path.join(directory, "history.json");
  fs.writeFileSync(historyPath, '[{"id":"base"}]', "utf8");
  const snapshot = await readHistoryStrict(historyPath);
  fs.writeFileSync(historyPath, '[{"id":"chat-writer"}]', "utf8");

  await assert.rejects(
    () =>
      writeHistoryAtomic(
        historyPath,
        [{ id: "mobile-writer" }],
        snapshot.sourceHash,
      ),
    /changed concurrently/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(historyPath, "utf8")), [
    { id: "chat-writer" },
  ]);
  assert.equal(
    fs.readdirSync(directory).some((name) => name.includes("mobile-sync")),
    false,
  );
});
