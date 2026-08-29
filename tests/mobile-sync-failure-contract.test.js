"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const messageDiffMatrix = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "VCPDistributedServer",
      "Plugin",
      "VCPMobileSync",
      "fixtures",
      "message_diff_matrix.json",
    ),
    "utf8",
  ),
).cases;

const {
  resolveCentralIndexPreference,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/config/defaults");
const entityDatabase = require("../VCPDistributedServer/Plugin/VCPMobileSync/core/db");
const issue20EntityIndex = new Map();
entityDatabase.getDb = () => ({});
entityDatabase.getOwnerState = ({ ownerType, ownerId }) => {
  return issue20EntityIndex.get(`owner:${ownerType}:${ownerId}`) || null;
};
entityDatabase.getTopicState = ({ topicId, ownerType, ownerId }) => {
  return issue20EntityIndex.get(`topic:${ownerType}:${ownerId}:${topicId}`) || null;
};
entityDatabase.upsertOwnerState = ({
  ownerType,
  ownerId,
  configPath,
  configHash,
}) => {
  issue20EntityIndex.set(`owner:${ownerType}:${ownerId}`, {
    owner_type: ownerType,
    owner_id: ownerId,
    config_path: configPath,
    config_hash: configHash,
    deleted_at: null,
  });
  return { changes: 1 };
};
entityDatabase.upsertTopicState = ({
  topicId,
  ownerType,
  ownerId,
  configHash,
}) => {
  issue20EntityIndex.set(`topic:${ownerType}:${ownerId}:${topicId}`, {
    topic_id: topicId,
    owner_type: ownerType,
    owner_id: ownerId,
    config_hash: configHash,
    content_hash: "",
    deleted_at: null,
  });
  return { changes: 1 };
};
entityDatabase.refreshOwnerContentHash = () => "";
const {
  handleSyncTopicDiff,
  handleSyncMessageDiff,
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
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/sync/manifest");
const {
  uploadEntity,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/sync/entity");

function fakeDiffDatabase({ topics = {}, messages = {}, fail = false } = {}) {
  return {
    prepare(sql) {
      if (fail) throw new Error("injected database failure");
      if (sql.includes("FROM topics")) {
        return { get: (...args) => topics[args.at(-1)] };
      }
      if (sql.includes("FROM messages")) {
        return { all: (...args) => messages[args.at(-1)] || [] };
      }
      throw new Error(`unexpected SQL in fake database: ${sql}`);
    },
  };
}

function fakeManifestDatabase({ owners = [], topics = [], avatars = [], messages = [] } = {}) {
  return {
    prepare(sql) {
      if (sql.includes("FROM avatar_index")) {
        return { all: () => avatars };
      }
      if (sql.includes("FROM owners")) {
        return { all: () => owners };
      }
      if (sql.includes("FROM topics")) {
        return { all: () => topics };
      }
      if (sql.includes("FROM messages")) {
        return {
          all: (...args) =>
            messages.filter((row) => row.topic_id === args.at(-1)),
        };
      }
      throw new Error(`unexpected SQL in fake manifest database: ${sql}`);
    },
  };
}

function live(messageHash, updatedAt = 1) {
  return { messageHash, updatedAt };
}

function deleted(deletedAt = 1) {
  return { deletedAt };
}

function compoundTopics(topics) {
  return Object.entries(topics).map(([topicId, state]) => ({ topicId, ...state }));
}

function topicResult(response, topicId) {
  return response.results.find((result) => result.topicId === topicId);
}

function agentOwners(...ownerIds) {
  return ownerIds.map((ownerId) => ({ ownerType: "agent", ownerId }));
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
  const result = handleSyncMessageDiff(
    {
      topics: compoundTopics({
        "topic-live": {
          contentHash: "c".repeat(64),
          ownerType: "agent",
          ownerId: "agent-a",
          messages: { "message-1": deleted() },
        },
        "topic-missing": {
          contentHash: "",
          ownerType: "agent",
          ownerId: "agent-a",
          messages: {},
        },
      }),
    },
    fakeDiffDatabase({
      topics: {
        "topic-live": {
          content_hash: "desktop",
        },
      },
      messages: {
        "topic-live": [{ msg_id: "message-1", hash: remoteHash }],
      },
    }),
  );

  assert.deepEqual(topicResult(result, "topic-live"), {
    topicId: "topic-live",
    ownerType: "agent",
    ownerId: "agent-a",
    ok: true,
    pullMessageIds: [],
    pushTopic: true,
    deleteMessages: [],
  });
  assert.deepEqual(topicResult(result, "topic-missing"), {
    topicId: "topic-missing",
    ownerType: "agent",
    ownerId: "agent-a",
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

test("Legacy Phase 3 与 CDS 共用完整仲裁矩阵", () => {
  for (const scenario of messageDiffMatrix) {
    const desktopMessages = scenario.desktopMessages.map((message) => ({
      msg_id: message.msgId,
      hash: message.messageHash ?? "0".repeat(64),
      updated_at: message.updatedAt ?? message.deletedAt,
      deleted_at: message.deletedAt ?? null,
    }));
    const response = handleSyncMessageDiff(
      {
        topics: [{
          topicId: scenario.topicId,
          ownerType: scenario.ownerType,
          ownerId: scenario.ownerId,
          contentHash: scenario.mobileContentHash,
          messages: scenario.mobileMessages,
        }],
      },
      fakeDiffDatabase({
        topics: {
          [scenario.topicId]: { content_hash: scenario.desktopContentHash },
        },
        messages: { [scenario.topicId]: desktopMessages },
      }),
    );

    assert.deepEqual(
      topicResult(response, scenario.topicId),
      {
        topicId: scenario.topicId,
        ownerType: scenario.ownerType,
        ownerId: scenario.ownerId,
        ok: true,
        ...scenario.expected,
      },
      scenario.name,
    );
  }
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

test("Phase 3 malformed hash 与 DB 查询错误都不能伪装成 no-op 完成", () => {
  assert.throws(
    () =>
      handleSyncMessageDiff(
        {
          topics: compoundTopics({
            topic: {
              contentHash: "",
              ownerType: "agent",
              ownerId: "agent-a",
              messages: { message: live("not-a-hash") },
            },
          }),
        },
        fakeDiffDatabase(),
      ),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );

  const result = handleSyncMessageDiff(
    {
      topics: compoundTopics({
        topic: {
          contentHash: "",
          ownerType: "agent",
          ownerId: "agent-a",
          messages: {},
        },
      }),
    },
    fakeDiffDatabase({ fail: true }),
  );
  const failed = topicResult(result, "topic");
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "MESSAGE_DIFF_FAILED");
  assert.match(failed.error.message, /injected database failure/);
});

test("Phase 2.5 topic hash 对错误类型 fail closed", () => {
  assert.throws(
    () =>
      handleSyncTopicDiff({
        topics: [{
          topicId: "topic",
          ownerType: "agent",
          ownerId: "agent-a",
          configHash: "bad",
          contentHash: "",
        }],
      }),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );
});

test("issue #20: 未初始化数据库不会伪装成无变化 topic", () => {
  const hash = "a".repeat(64);
  assert.throws(
    () =>
      handleSyncTopicDiff(
        {
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

  assert.deepEqual(agentResult, { success: true, id: agentId, type: "agent" });
  assert.deepEqual(groupResult, { success: true, id: groupId, type: "group" });
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
    topics: [
      {
        topic_id: "topic-a",
        owner_type: "agent",
        owner_id: "agent-a",
        config_hash: hash,
        content_hash: "",
        updated_at: 1,
        deleted_at: null,
      },
      {
        topic_id: "topic-b",
        owner_type: "agent",
        owner_id: "agent-aa",
        config_hash: hash,
        content_hash: "",
        updated_at: 1,
        deleted_at: null,
      },
    ],
  });

  assert.deepEqual(
    getLocalManifest("topic", agentOwners("agent-a"), database).map((item) => item.topicId),
    ["topic-a"],
  );
  const result = handleSyncManifest(
    {
      manifestType: "topic",
      targetedOwners: agentOwners("agent-a"),
      items: [{
        topicId: "topic-a",
        configHash: hash,
        contentHash: "",
        updatedAt: 1,
        ownerType: "agent",
        ownerId: "agent-a",
      }],
    },
    database,
  );
  assert.deepEqual(result.results, []);

  const splitOwners = handleSyncManifest(
    {
      manifestType: "topic",
      targetedOwners: agentOwners("agent-a", "agent-b"),
      items: [{
        topicId: "topic-a",
        configHash: hash,
        contentHash: "",
        updatedAt: 1,
        ownerType: "agent",
        ownerId: "agent-b",
      }],
    },
    database,
  );
  assert.deepEqual(splitOwners.results, [
    { topicId: "topic-a", action: "PUSH", ownerType: "agent", ownerId: "agent-b" },
    { topicId: "topic-a", action: "PULL", ownerType: "agent", ownerId: "agent-a" },
  ]);
});

test("legacy manifest、hash 与 message diff 将 default 作为普通 Topic", () => {
  const hash = "a".repeat(64);
  const database = fakeManifestDatabase({
    topics: [
      {
        topic_id: "default",
        owner_type: "agent",
        owner_id: "agent-a",
        config_hash: hash,
        content_hash: hash,
        updated_at: 1,
        deleted_at: null,
      },
      {
        topic_id: "topic-live",
        owner_type: "agent",
        owner_id: "agent-a",
        config_hash: hash,
        content_hash: hash,
        updated_at: 1,
        deleted_at: null,
      },
    ],
  });

  assert.deepEqual(
    getLocalManifest("topic", null, database).map((item) => item.topicId),
    ["default", "topic-live"],
  );
  assert.deepEqual(
    handleSyncMessageDiff({
      topics: compoundTopics({
        default: {
          contentHash: hash,
          ownerType: "agent",
          ownerId: "agent-a",
          messages: {},
        },
      }),
    }, fakeDiffDatabase({ topics: { default: { content_hash: hash } } })),
    {
      type: "SYNC_MESSAGE_DIFF_RESULT",
      results: [{
        topicId: "default",
        ownerType: "agent",
        ownerId: "agent-a",
        ok: true,
        pullMessageIds: [],
        pushTopic: false,
        deleteMessages: [],
      }],
    },
  );
  const changedHash = "b".repeat(64);
  assert.deepEqual(
    handleSyncManifest({
      manifestType: "topic",
      targetedOwners: agentOwners("agent-a"),
      items: [{
        topicId: "default",
        configHash: changedHash,
        contentHash: changedHash,
        updatedAt: 1,
        ownerType: "agent",
        ownerId: "agent-a",
      }],
    }, database),
    { type: "SYNC_MANIFEST_RESULT", results: [
      {
        topicId: "default",
        action: "PULL",
        ownerType: "agent",
        ownerId: "agent-a",
      },
      {
        topicId: "topic-live",
        action: "PULL",
        ownerType: "agent",
        ownerId: "agent-a",
      },
    ], manifestType: "topic" },
  );
});

test("Owner manifest 墓碑四象限保持动作方向", () => {
  const hash = "b".repeat(64);
  const localItem = (ownerType, id, deletedAt) => ({
    owner_type: ownerType,
    owner_id: id,
    config_hash: hash,
    content_hash: "",
    updated_at: 1,
    deleted_at: deletedAt,
  });
  const remoteItem = (ownerType, ownerId, deletedAt = null) => deletedAt === null
    ? { ownerType, ownerId, configHash: hash, contentHash: "", updatedAt: 1 }
    : { ownerType, ownerId, deletedAt };
  const database = fakeManifestDatabase({
    owners: [
      localItem("agent", "mobile-deleted-desktop-live", null),
      localItem("group", "desktop-deleted-mobile-live", 21),
      localItem("group", "desktop-deleted-mobile-missing", 22),
    ],
  });

  const result = handleSyncManifest(
    {
      manifestType: "owner",
      items: [
        remoteItem("agent", "mobile-deleted-desktop-live", 11),
        remoteItem("group", "mobile-deleted-desktop-missing", 12),
        remoteItem("group", "desktop-deleted-mobile-live"),
      ],
    },
    database,
  );

  assert.deepEqual(result.results, [
    {
      ownerId: "mobile-deleted-desktop-live",
      action: "PUSH_DELETE",
      deletedAt: 11,
      ownerType: "agent",
    },
    {
      ownerId: "mobile-deleted-desktop-missing",
      action: "PUSH_DELETE",
      deletedAt: 12,
      ownerType: "group",
    },
    {
      ownerId: "desktop-deleted-mobile-live",
      action: "PULL_DELETE",
      deletedAt: 21,
      ownerType: "group",
    },
    {
      ownerId: "desktop-deleted-mobile-missing",
      action: "PULL_DELETE",
      deletedAt: 22,
      ownerType: "group",
    },
  ]);
});

test("Manifest 错型、重复身份和 deletedAt=0 均按硬切契约处理", () => {
  const hash = "b".repeat(64);
  const database = fakeManifestDatabase();
  assert.throws(
    () => handleSyncManifest({ manifestType: "owner", items: {} }, database),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );
  const item = {
    ownerId: "agent-a",
    configHash: hash,
    contentHash: "",
    updatedAt: 1,
    ownerType: "agent",
  };
  assert.throws(
    () => handleSyncManifest(
      { manifestType: "owner", items: [item, item] },
      database,
    ),
    /duplicate entity identity/,
  );
  const result = handleSyncManifest(
    {
      manifestType: "owner",
      items: [{ ownerType: "agent", ownerId: "agent-a", deletedAt: 0 }],
    },
    database,
  );
  assert.deepEqual(result.results, [
    { ownerId: "agent-a", action: "PUSH_DELETE", deletedAt: 0, ownerType: "agent" },
  ]);

  assert.throws(
    () => handleSyncManifest({
      manifestType: "owner",
      items: [{ ...item, ownerType: undefined }],
    }, database),
    /requires agent\/group ownerType/,
  );
  assert.throws(
    () => handleSyncManifest({
      manifestType: "owner",
      items: [{ ...item, id: "agent-a" }],
    }, database),
    /unexpected or missing fields/,
  );
});

test("损坏 history 的已提交索引不能走 topic hash 快速成功", () => {
  const topicId = "topic-unhealthy";
  const identity = {
    topicId,
    ownerType: "agent",
    ownerId: "agent-a",
  };
  markHistoryTopicUnhealthy(identity, new Error("invalid JSON"));
  try {
    assert.throws(
      () => handleSyncTopicDiff(
        {
          topics: [{
            topicId,
            ownerType: "agent",
            ownerId: "agent-a",
            configHash: "a".repeat(64),
            contentHash: "",
          }],
        },
        fakeDiffDatabase({ topics: { [topicId]: { content_hash: "" } } }),
      ),
      (error) => error.code === "HISTORY_SOURCE_INVALID",
    );
  } finally {
    clearHistoryTopicUnhealthy(identity);
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
