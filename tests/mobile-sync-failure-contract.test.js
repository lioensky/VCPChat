"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  resolveCentralIndexPreference,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/config/defaults");
const {
  handleSyncMessageDiffBatch,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/sync/diff");
const {
  readHistoryStrict,
  writeHistoryAtomic,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/sync/message");

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
          topicHash: "different",
          messages: { "message-1": "DELETED" },
        },
        "topic-missing": {
          topicHash: "",
          messages: {},
        },
      },
    },
    fakeDiffDatabase({
      topics: { "topic-live": { aggregated_hash: "desktop" } },
      messages: {
        "topic-live": [{ msg_id: "message-1", hash: remoteHash }],
      },
    }),
  );

  assert.deepEqual(result.results["topic-live"], {
    ok: true,
    toPull: [],
    toPush: false,
  });
  assert.deepEqual(result.results["topic-missing"], {
    ok: false,
    error: {
      code: "TOPIC_NOT_FOUND",
      message: "Topic topic-missing was not found in the desktop index",
    },
  });
});

test("Phase 3 malformed hash 与 DB 查询错误都不能伪装成 no-op 完成", () => {
  assert.throws(
    () =>
      handleSyncMessageDiffBatch(
        {
          topics: {
            topic: { topicHash: "", messages: { message: "not-a-hash" } },
          },
        },
        fakeDiffDatabase(),
      ),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );

  const result = handleSyncMessageDiffBatch(
    {
      topics: {
        topic: { topicHash: "", messages: {} },
      },
    },
    fakeDiffDatabase({ fail: true }),
  );
  assert.equal(result.results.topic.ok, false);
  assert.equal(result.results.topic.error.code, "MESSAGE_DIFF_FAILED");
  assert.match(result.results.topic.error.message, /injected database failure/);
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
