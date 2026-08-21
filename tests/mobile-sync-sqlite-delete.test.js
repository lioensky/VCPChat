"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(
  ROOT,
  "VCPDistributedServer",
  "Plugin",
  "VCPMobileSync",
  "core",
  "db.js",
);
const ENTITY_PATH = path.join(
  ROOT,
  "VCPDistributedServer",
  "Plugin",
  "VCPMobileSync",
  "sync",
  "entity.js",
);
const INDEX_PATH = path.join(
  ROOT,
  "VCPDistributedServer",
  "Plugin",
  "VCPMobileSync",
  "index.js",
);

const silentLogger = {
  completePhase() {},
  endSession() {},
  logInfo() {},
  logOperation() {},
  startPhase() {},
  startSession() {},
};
const fakeLoggerModule = {
  getLogger: () => silentLogger,
  resetLogger: () => silentLogger,
};

function loadSqliteModules({ captureOnMessage = null } = {}) {
  const modulePaths = [
    DB_PATH,
    ENTITY_PATH,
    INDEX_PATH,
    path.join(path.dirname(ENTITY_PATH), "central.js"),
  ];
  const savedModules = new Map(
    modulePaths.map((modulePath) => [modulePath, require.cache[modulePath]]),
  );
  for (const modulePath of modulePaths) delete require.cache[modulePath];

  const originalLoad = Module._load;
  Module._load = function loadTestDependency(request, parent, isMain) {
    if (request === "better-sqlite3") return DatabaseSync;
    if (
      request === "./logger" ||
      request === "./core/logger" ||
      request === "../core/logger"
    ) {
      return fakeLoggerModule;
    }
    if (request === "./transport/websocket") {
      return {
        startWsServer(options) {
          if (captureOnMessage) captureOnMessage(options.onMessage);
          return null;
        },
      };
    }
    if (request === "./transport/routes") {
      return { registerRoutes() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const database = require(DB_PATH);
    const entity = require(ENTITY_PATH);
    const index = captureOnMessage ? require(INDEX_PATH) : null;
    return { database, entity, index };
  } finally {
    Module._load = originalLoad;
    for (const modulePath of modulePaths) {
      delete require.cache[modulePath];
      const saved = savedModules.get(modulePath);
      if (saved) require.cache[modulePath] = saved;
    }
  }
}

function insertEntity(db, {
  id,
  type,
  filePath = `/virtual/${id}/${type}.json`,
}) {
  db.prepare(
    `INSERT INTO entity_index (id, type, file_path, hash, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, type, filePath, "a".repeat(64), 1);
}

function entityRow(db, id, type) {
  return db
    .prepare("SELECT * FROM entity_index WHERE id = ? AND type = ?")
    .get(id, type);
}

test("SQLite 墓碑绑定覆盖实体、Topic、消息和头像，并保留最早删除时间", () => {
  const { database } = loadSqliteModules();
  const db = database.initDb(":memory:");

  try {
    insertEntity(db, { id: "agent-a", type: "agent" });
    insertEntity(db, { id: "agent-a", type: "group" });
    insertEntity(db, { id: "topic-a", type: "agent_topic" });
    insertEntity(db, { id: "topic-b", type: "group_topic" });

    database.softDeleteEntityIndex("agent-a", "agent", 300);
    database.softDeleteEntityIndex("agent-a", "agent", 200);
    database.softDeleteEntityIndex("agent-a", "agent", 400);
    assert.equal(entityRow(db, "agent-a", "agent").deleted_at, 200);
    assert.equal(entityRow(db, "agent-a", "group").deleted_at, null);

    database.softDeleteEntityIndex("topic-a", "topic", 250);
    database.softDeleteEntityIndex("topic-a", "topic", 350);
    assert.equal(entityRow(db, "topic-a", "agent_topic").deleted_at, 250);
    assert.equal(entityRow(db, "topic-b", "group_topic").deleted_at, null);

    database.upsertEntityTombstone(
      "agent-missing",
      "agent",
      "/virtual/agent-missing/config.json",
      275,
    );
    database.upsertEntityTombstone(
      "agent-missing",
      "agent",
      "/virtual/agent-missing/config.json",
      325,
    );
    assert.deepEqual(
      {
        hash: entityRow(db, "agent-missing", "agent").hash,
        deleted_at: entityRow(db, "agent-missing", "agent").deleted_at,
      },
      { hash: "0".repeat(64), deleted_at: 275 },
    );

    db.prepare(
      `INSERT INTO message_index (msg_id, topic_id, hash, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run("message-a", "topic-a", "b".repeat(64), 1);
    db.prepare(
      `INSERT INTO message_index (msg_id, topic_id, hash, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run("message-a", "topic-b", "c".repeat(64), 1);
    database.softDeleteMessageIndex("message-a", 500, "topic-a");
    assert.equal(
      db.prepare(
        "SELECT deleted_at FROM message_index WHERE topic_id = ? AND msg_id = ?",
      ).get("topic-a", "message-a").deleted_at,
      500,
    );
    assert.equal(
      db.prepare(
        "SELECT deleted_at FROM message_index WHERE topic_id = ? AND msg_id = ?",
      ).get("topic-b", "message-a").deleted_at,
      null,
    );
    database.softDeleteMessageIndex("message-a", 450);
    assert.deepEqual(
      db.prepare(
        "SELECT topic_id, deleted_at FROM message_index WHERE msg_id = ? ORDER BY topic_id",
      ).all("message-a").map((row) => [row.topic_id, row.deleted_at]),
      [["topic-a", 450], ["topic-b", 450]],
    );

    database.softDeleteMessageIndex("message-missing", 425, "topic-a");
    database.softDeleteMessageIndex("message-missing", 475, "topic-a");
    assert.deepEqual(
      { ...db.prepare(
        `SELECT hash, updated_at, deleted_at FROM message_index
         WHERE topic_id = ? AND msg_id = ?`,
      ).get("topic-a", "message-missing") },
      { hash: "0".repeat(64), updated_at: 425, deleted_at: 425 },
    );

    db.prepare(
      `INSERT INTO avatar_index
       (owner_id, owner_type, file_path, hash, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("agent-a", "agent", "/virtual/agent-a/avatar.png", "d".repeat(64), 1);
    db.prepare(
      `INSERT INTO avatar_index
       (owner_id, owner_type, file_path, hash, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("agent-a", "group", "/virtual/group-a/avatar.png", "e".repeat(64), 1);
    database.softDeleteAvatarIndex("agent-a", "agent", 600);
    database.softDeleteAvatarIndex("agent-a", "agent", 550);
    assert.equal(
      db.prepare(
        "SELECT deleted_at FROM avatar_index WHERE owner_id = ? AND owner_type = ?",
      ).get("agent-a", "agent").deleted_at,
      550,
    );
    assert.equal(
      db.prepare(
        "SELECT deleted_at FROM avatar_index WHERE owner_id = ? AND owner_type = ?",
      ).get("agent-a", "group").deleted_at,
      null,
    );
  } finally {
    db.close();
  }
});

test("删除 Owner 会用同一最早墓碑时间级联其 Topic", async (t) => {
  const { database, entity } = loadSqliteModules();
  const db = database.initDb(":memory:");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-delete-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  try {
    const agentDir = path.join(directory, "Agents", "agent-cascade");
    const configPath = path.join(agentDir, "config.json");
    const userDataDir = path.join(directory, "UserData", "agent-cascade");
    const historyDir = path.join(userDataDir, "topics", "topic-cascade");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        id: "agent-cascade",
        topics: [{ id: "topic-cascade", name: "Cascade", createdAt: 1 }],
      }),
    );
    fs.writeFileSync(path.join(historyDir, "history.json"), "[]");
    insertEntity(db, {
      id: "agent-cascade",
      type: "agent",
      filePath: configPath,
    });
    insertEntity(db, {
      id: "topic-cascade",
      type: "agent_topic",
      filePath: configPath,
    });
    insertEntity(db, {
      id: "topic-unrelated",
      type: "agent_topic",
      filePath: path.join(directory, "Agents", "other", "config.json"),
    });
    db.prepare(
      `INSERT INTO message_index (msg_id, topic_id, hash, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run("message-cascade", "topic-cascade", "b".repeat(64), 1);

    assert.deepEqual(
      await entity.deleteEntity({
        id: "agent-cascade",
        type: "agent",
        deletedAt: 700,
        appDataPath: directory,
      }),
      { success: true, id: "agent-cascade" },
    );
    assert.equal(entityRow(db, "agent-cascade", "agent").deleted_at, 700);
    assert.equal(entityRow(db, "topic-cascade", "agent_topic").deleted_at, 700);
    assert.equal(entityRow(db, "topic-unrelated", "agent_topic").deleted_at, null);
    assert.equal(fs.existsSync(agentDir), false);
    assert.equal(fs.existsSync(userDataDir), false);
    assert.equal(
      db.prepare(
        "SELECT deleted_at FROM message_index WHERE topic_id = ? AND msg_id = ?",
      ).get("topic-cascade", "message-cascade").deleted_at,
      700,
    );
  } finally {
    db.close();
  }
});

test("删除 Topic 先移除物理 history，再更新 config 投影和索引", async (t) => {
  const { database, entity } = loadSqliteModules();
  const db = database.initDb(":memory:");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-topic-delete-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  try {
    const agentDir = path.join(directory, "Agents", "agent-topic-delete");
    const configPath = path.join(agentDir, "config.json");
    const topicDir = path.join(
      directory,
      "UserData",
      "agent-topic-delete",
      "topics",
      "topic-delete",
    );
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(topicDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        name: "Delete Test",
        topics: [
          { id: "topic-delete", name: "Delete", createdAt: 1 },
          { id: "topic-keep", name: "Keep", createdAt: 2 },
        ],
      }),
    );
    fs.writeFileSync(path.join(topicDir, "history.json"), "[]");
    insertEntity(db, {
      id: "topic-delete",
      type: "topic",
      filePath: configPath,
    });
    db.prepare(
      `INSERT INTO message_index (msg_id, topic_id, hash, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run("message-delete", "topic-delete", "c".repeat(64), 1);

    assert.deepEqual(
      await entity.deleteEntity({
        id: "topic-delete",
        type: "topic",
        ownerType: "agent",
        ownerId: "agent-topic-delete",
        deletedAt: 800,
        appDataPath: directory,
      }),
      {
        success: true,
        id: "topic-delete",
        ownerType: "agent",
        ownerId: "agent-topic-delete",
      },
    );
    assert.equal(fs.existsSync(topicDir), false);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(configPath, "utf8")).topics.map((topic) => topic.id),
      ["topic-keep"],
    );
    assert.equal(entityRow(db, "topic-delete", "topic").deleted_at, 800);
    assert.equal(
      db.prepare(
        "SELECT deleted_at FROM message_index WHERE topic_id = ? AND msg_id = ?",
      ).get("topic-delete", "message-delete").deleted_at,
      800,
    );
  } finally {
    db.close();
  }
});

test("Topic 上传会补建缺失 history，且更新既有 Topic 不覆盖真实消息", async (t) => {
  const { database, entity } = loadSqliteModules();
  const db = database.initDb(":memory:");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-topic-history-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  try {
    const ownerId = "agent-topic-history";
    const topicId = "topic-existing";
    const configPath = path.join(directory, "Agents", ownerId, "config.json");
    const historyPath = path.join(
      directory,
      "UserData",
      ownerId,
      "topics",
      topicId,
      "history.json",
    );
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        name: "History Owner",
        topics: [{ id: topicId, name: "Existing", createdAt: 1 }],
      }),
    );
    insertEntity(db, { id: topicId, type: "topic", filePath: configPath });

    const upload = (name) => entity.uploadEntity({
      id: topicId,
      type: "agent_topic",
      data: {
        id: topicId,
        ownerId,
        ownerType: "agent",
        name,
        createdAt: 1,
      },
      appDataPath: directory,
    });

    assert.equal((await upload("First update")).success, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(historyPath, "utf8")), []);

    const realHistory = JSON.stringify([
      { id: "message-keep", role: "user", content: "must survive", timestamp: 10 },
    ]);
    fs.writeFileSync(historyPath, realHistory);
    assert.equal((await upload("Second update")).success, true);
    assert.equal(fs.readFileSync(historyPath, "utf8"), realHistory);
  } finally {
    db.close();
  }
});

test("从未见过的 Topic 删除会用显式 Owner 身份保存墓碑", async (t) => {
  const { database, entity } = loadSqliteModules();
  const db = database.initDb(":memory:");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-topic-tombstone-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  try {
    assert.deepEqual(
      await entity.deleteEntity({
        id: "topic-never-seen",
        type: "topic",
        ownerType: "group",
        ownerId: "group-owner",
        deletedAt: 801,
        appDataPath: directory,
      }),
      {
        success: true,
        id: "topic-never-seen",
        ownerType: "group",
        ownerId: "group-owner",
      },
    );
    const tombstone = entityRow(db, "topic-never-seen", "topic");
    assert.equal(tombstone.deleted_at, 801);
    assert.equal(tombstone.hash, "0".repeat(64));
    assert.match(tombstone.file_path.replace(/\\/g, "/"), /AgentGroups\/group-owner\/config\.json$/u);

    const missingIdentity = await entity.deleteEntity({
      id: "topic-no-owner",
      type: "topic",
      deletedAt: 802,
      appDataPath: directory,
    });
    assert.equal(missingIdentity.success, false);
    assert.equal(missingIdentity.error.code, "SYNC_DELETE_INVALID");
  } finally {
    db.close();
  }
});

test("启动 repair 以物理目录补 Topic，并移除不存在的非-default 投影", async (t) => {
  const { entity } = loadSqliteModules();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-repair-topic-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const ownerId = "agent-repair";
  const topicId = "topic-repair";
  const agentDir = path.join(directory, "Agents", ownerId);
  const configPath = path.join(agentDir, "config.json");
  const topicDir = path.join(directory, "UserData", ownerId, "topics", topicId);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(topicDir, { recursive: true });
  const originalConfig = {
    name: "Existing Agent",
    topics: [
      { id: "default", name: "Default", createdAt: 0 },
      { id: "topic-ghost", name: "Ghost", createdAt: 1 },
    ],
  };
  fs.writeFileSync(configPath, JSON.stringify(originalConfig));
  fs.writeFileSync(
    path.join(topicDir, "history.json"),
    JSON.stringify([{ id: "message-repair", timestamp: 42 }]),
  );

  assert.deepEqual(await entity.repairTopicProjectionsFromDisk(directory), {
    ownersChanged: 1,
    topicsAdded: 1,
    topicsRemoved: 1,
  });
  const repaired = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(repaired.topics.map((topic) => topic.id), ["default", topicId]);
  assert.equal(repaired.topics[1].createdAt, 42);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(`${configPath}.backup`, "utf8")),
    originalConfig,
  );
});

test("启动 repair 从有效 backup 恢复损坏 config，且物理目录覆盖旧索引墓碑", async (t) => {
  const { database, entity } = loadSqliteModules();
  const db = database.initDb(":memory:");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-repair-corrupt-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  try {
    const ownerId = "agent-corrupt";
    const topicId = "topic-corrupt";
    const agentDir = path.join(directory, "Agents", ownerId);
    const configPath = path.join(agentDir, "config.json");
    const topicDir = path.join(directory, "UserData", ownerId, "topics", topicId);
    const historyPath = path.join(topicDir, "history.json");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(topicDir, { recursive: true });
    fs.writeFileSync(configPath, "{broken", "utf8");
    const backup = {
      name: "Backed Up Agent",
      topics: [{ id: "topic-backup-ghost", name: "Ghost", createdAt: 1 }],
    };
    fs.writeFileSync(`${configPath}.backup`, JSON.stringify(backup));
    fs.writeFileSync(
      historyPath,
      JSON.stringify([{
        id: "message-corrupt",
        role: "assistant",
        name: "Recovered Name",
        content: "restored",
        timestamp: 73,
      }]),
    );

    const tombstonedTopicId = "topic-tombstoned";
    const tombstonedDir = path.join(
      directory,
      "UserData",
      ownerId,
      "topics",
      tombstonedTopicId,
    );
    const tombstonedHistory = path.join(tombstonedDir, "history.json");
    fs.mkdirSync(tombstonedDir, { recursive: true });
    fs.writeFileSync(tombstonedHistory, "[]");
    insertEntity(db, {
      id: tombstonedTopicId,
      type: "topic",
      filePath: configPath,
    });
    database.softDeleteEntityIndex(tombstonedTopicId, "topic", 99);

    await entity.repairTopicProjectionsFromDisk(directory);
    const repaired = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(repaired.name, "Backed Up Agent");
    assert.deepEqual(
      repaired.topics.map((topic) => topic.id),
      [topicId, tombstonedTopicId],
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(`${configPath}.backup`, "utf8")),
      backup,
    );
    assert.equal(entityRow(db, tombstonedTopicId, "topic").deleted_at, 99);
  } finally {
    db.close();
  }
});

test("启动 repair 不会在没有物理 Topic 时覆盖损坏 config", async (t) => {
  const { entity } = loadSqliteModules();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-repair-empty-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const ownerId = "agent-corrupt-empty";
  const configPath = path.join(directory, "Agents", ownerId, "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, "{keep-for-manual-recovery", "utf8");

  assert.deepEqual(await entity.repairTopicProjectionsFromDisk(directory), {
    ownersChanged: 0,
    topicsAdded: 0,
    topicsRemoved: 0,
  });
  assert.equal(fs.readFileSync(configPath, "utf8"), "{keep-for-manual-recovery");
});

test("启动 repair 从物理 Topic 重建无可用 backup 的损坏 config", async (t) => {
  const { entity } = loadSqliteModules();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-repair-fail-closed-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const ownerId = "agent-corrupt-no-backup";
  const configPath = path.join(directory, "Agents", ownerId, "config.json");
  const topicDir = path.join(directory, "UserData", ownerId, "topics", "topic-live");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(topicDir, { recursive: true });
  fs.writeFileSync(configPath, "{preserve-corrupt", "utf8");
  fs.writeFileSync(path.join(topicDir, "history.json"), "[]");

  assert.deepEqual(await entity.repairTopicProjectionsFromDisk(directory), {
    ownersChanged: 1,
    topicsAdded: 1,
    topicsRemoved: 0,
  });
  const repaired = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(repaired.name, `Recovered ${ownerId}`);
  assert.equal(
    repaired._recoveredFrom,
    "VCPMobileSync physical topic projection",
  );
  assert.deepEqual(repaired.topics.map((topic) => topic.id), ["topic-live"]);
});

test("启动 repair 只在 Owner 类型可证明时重建缺失 config", async (t) => {
  const { entity } = loadSqliteModules();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-repair-owner-type-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const groupId = "group-known";
  const groupConfig = path.join(directory, "AgentGroups", groupId, "config.json");
  const groupTopic = path.join(directory, "UserData", groupId, "topics", "topic-known");
  fs.mkdirSync(path.dirname(groupConfig), { recursive: true });
  fs.mkdirSync(groupTopic, { recursive: true });
  fs.writeFileSync(path.join(groupTopic, "history.json"), "[]");

  const unknownId = "owner-unknown";
  const unknownTopic = path.join(directory, "UserData", unknownId, "topics", "topic-unknown");
  fs.mkdirSync(unknownTopic, { recursive: true });
  fs.writeFileSync(path.join(unknownTopic, "history.json"), "[]");

  assert.deepEqual(await entity.repairTopicProjectionsFromDisk(directory), {
    ownersChanged: 1,
    topicsAdded: 1,
    topicsRemoved: 0,
  });
  const rebuilt = JSON.parse(fs.readFileSync(groupConfig, "utf8"));
  assert.equal(rebuilt.id, groupId);
  assert.deepEqual(rebuilt.topics.map((topic) => topic.id), ["topic-known"]);
  assert.equal(
    fs.existsSync(path.join(directory, "Agents", unknownId, "config.json")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(directory, "AgentGroups", unknownId, "config.json")),
    false,
  );
});

test("legacy reconcile 把物理已消失的 Owner/Topic 及消息收敛为墓碑", async (t) => {
  const { database, entity } = loadSqliteModules();
  const db = database.initDb(":memory:");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-reconcile-stale-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  try {
    const liveConfig = path.join(directory, "Agents", "agent-live", "config.json");
    const liveTopicDir = path.join(
      directory,
      "UserData",
      "agent-live",
      "topics",
      "topic-live",
    );
    fs.mkdirSync(path.dirname(liveConfig), { recursive: true });
    fs.mkdirSync(liveTopicDir, { recursive: true });
    fs.writeFileSync(liveConfig, JSON.stringify({ name: "Live", topics: [] }));

    insertEntity(db, { id: "agent-live", type: "agent", filePath: liveConfig });
    insertEntity(db, { id: "topic-live", type: "topic", filePath: liveConfig });
    insertEntity(db, {
      id: "topic-stale",
      type: "topic",
      filePath: liveConfig,
    });
    const staleOwnerConfig = path.join(
      directory,
      "AgentGroups",
      "group-stale",
      "config.json",
    );
    insertEntity(db, {
      id: "group-stale",
      type: "group",
      filePath: staleOwnerConfig,
    });
    insertEntity(db, {
      id: "topic-owner-stale",
      type: "topic",
      filePath: staleOwnerConfig,
    });
    for (const topicId of ["topic-live", "topic-stale", "topic-owner-stale"]) {
      db.prepare(
        `INSERT INTO message_index (msg_id, topic_id, hash, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run(`message-${topicId}`, topicId, "c".repeat(64), 1);
    }

    assert.deepEqual(
      await entity.reconcileMissingPhysicalIndexes(directory, null, db, 900),
      { ownersDeleted: 1, topicsDeleted: 2, messagesDeleted: 2 },
    );
    assert.equal(entityRow(db, "agent-live", "agent").deleted_at, null);
    assert.equal(entityRow(db, "topic-live", "topic").deleted_at, null);
    assert.equal(entityRow(db, "group-stale", "group").deleted_at, 900);
    assert.equal(entityRow(db, "topic-stale", "topic").deleted_at, 900);
    assert.equal(entityRow(db, "topic-owner-stale", "topic").deleted_at, 900);
    assert.deepEqual(
      db.prepare(
        "SELECT topic_id, deleted_at FROM message_index ORDER BY topic_id",
      ).all().map((row) => [row.topic_id, row.deleted_at]),
      [
        ["topic-live", null],
        ["topic-owner-stale", 900],
        ["topic-stale", 900],
      ],
    );
  } finally {
    db.close();
  }
});

test("运行时 config 摄取不会从 stale 投影复活物理已删除 Topic", async (t) => {
  const { database, index } = loadSqliteModules({ captureOnMessage() {} });
  const db = database.initDb(":memory:");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-runtime-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  try {
    const ownerId = "agent-runtime";
    const configPath = path.join(directory, "Agents", ownerId, "config.json");
    const liveTopicDir = path.join(
      directory,
      "UserData",
      ownerId,
      "topics",
      "topic-live",
    );
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.mkdirSync(liveTopicDir, { recursive: true });
    fs.writeFileSync(path.join(liveTopicDir, "history.json"), "[]");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        name: "Runtime Owner",
        topics: [
          { id: "topic-live", name: "Live", createdAt: 1 },
          { id: "topic-stale-live", name: "Stale live row", createdAt: 2 },
          { id: "topic-stale-deleted", name: "Stale tombstone", createdAt: 3 },
        ],
      }),
    );
    insertEntity(db, {
      id: "topic-stale-live",
      type: "topic",
      filePath: configPath,
    });
    insertEntity(db, {
      id: "topic-stale-deleted",
      type: "topic",
      filePath: configPath,
    });
    database.softDeleteEntityIndex("topic-stale-deleted", "topic", 123);
    for (const topicId of ["topic-stale-live", "topic-stale-deleted"]) {
      db.prepare(
        `INSERT INTO message_index (msg_id, topic_id, hash, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run(`message-${topicId}`, topicId, "c".repeat(64), 1);
    }

    await index.ingestConfigToDb(configPath, "agent", directory);

    assert.equal(entityRow(db, "topic-live", "topic").deleted_at, null);
    assert.ok(Number.isSafeInteger(entityRow(db, "topic-stale-live", "topic").deleted_at));
    assert.equal(entityRow(db, "topic-stale-deleted", "topic").deleted_at, 123);
    assert.equal(
      db.prepare(
        "SELECT deleted_at FROM message_index WHERE topic_id = ?",
      ).get("topic-stale-deleted").deleted_at,
      123,
    );
  } finally {
    db.close();
  }
});

test("legacy Topic root 仅在内容哈希变化时推进 updated_at", () => {
  const { database } = loadSqliteModules();
  const db = database.initDb(":memory:");
  try {
    insertEntity(db, { id: "topic-root", type: "topic" });
    db.prepare(
      "UPDATE entity_index SET aggregated_hash = ?, updated_at = ? WHERE id = ? AND type = ?",
    ).run("a".repeat(64), 100, "topic-root", "topic");

    database.updateTopicAggregatedHash("topic-root", "a".repeat(64), 200);
    assert.equal(entityRow(db, "topic-root", "topic").updated_at, 100);
    database.updateTopicAggregatedHash("topic-root", "b".repeat(64), 300);
    assert.equal(entityRow(db, "topic-root", "topic").updated_at, 300);
  } finally {
    db.close();
  }
});

test("legacy Owner root 和 Topic 空根回填都排除 default", () => {
  const { database, index } = loadSqliteModules({ captureOnMessage() {} });
  const { computeAggregatedHash } = require(
    path.join(ROOT, "VCPDistributedServer", "Plugin", "VCPMobileSync", "core", "hash.js"),
  );
  const db = database.initDb(":memory:");
  try {
    const configPath = "/app/Agents/agent-root/config.json";
    insertEntity(db, { id: "agent-root", type: "agent", filePath: configPath });
    insertEntity(db, { id: "default", type: "topic", filePath: configPath });
    insertEntity(db, { id: "topic-live", type: "topic", filePath: configPath });
    db.prepare(
      "UPDATE entity_index SET hash = ?, aggregated_hash = ?, updated_at = 10 WHERE id = ? AND type = 'topic'",
    ).run("d".repeat(64), null, "default");
    db.prepare(
      "UPDATE entity_index SET hash = ?, aggregated_hash = ?, updated_at = 20 WHERE id = ? AND type = 'topic'",
    ).run("a".repeat(64), "b".repeat(64), "topic-live");

    index.computeAggregatedHashes(db, silentLogger);
    const expected = computeAggregatedHash(["a".repeat(64), "b".repeat(64)]);
    assert.equal(entityRow(db, "agent-root", "agent").aggregated_hash, expected);
    assert.equal(entityRow(db, "default", "topic").aggregated_hash, null);

    db.prepare(
      "UPDATE entity_index SET hash = ?, aggregated_hash = ? WHERE id = 'default' AND type = 'topic'",
    ).run("e".repeat(64), "f".repeat(64));
    index.computeAggregatedHashes(db, silentLogger);
    assert.equal(entityRow(db, "agent-root", "agent").aggregated_hash, expected);
  } finally {
    db.close();
  }
});

test("中央 Topic 删除错误保持 topic_metadata 阶段和失败 Topic", async (t) => {
  let onMessage = null;
  const { database, index } = loadSqliteModules({
    captureOnMessage(handler) {
      onMessage = handler;
    },
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-stage-"));
  const projectBasePath = path.join(directory, "VCPDistributedServer");
  fs.mkdirSync(projectBasePath, { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  await index.registerRoutes(
    { use() {} },
    {
      MobileSyncToken: "sqlite-delete-test-token",
      MobileSyncPort: "15975",
      MobileSyncUseCentralIndex: true,
    },
    projectBasePath,
    {
      chatDataService: {
        client: { reconcile: async () => ({ stats: {} }) },
        mobileSyncUseCentralIndex: true,
      },
    },
  );

  assert.equal(typeof onMessage, "function");
  const db = database.getDb();
  insertEntity(db, {
    id: "topic-stage",
    type: "agent_topic",
    filePath: path.join(directory, "missing", "config.json"),
  });

  try {
    await assert.rejects(
      () => onMessage({
        type: "SYNC_ENTITY_DELETE",
        id: "topic-stage",
        dataType: "topic",
        deletedAt: 800,
      }),
      (error) => error.code === "SYNC_DELETE_INVALID",
    );
    await assert.rejects(
      () => onMessage({
        type: "SYNC_ENTITY_DELETE",
        id: "topic-stage",
        dataType: "agent_topic",
        ownerType: "group",
        ownerId: "agent-stage",
        deletedAt: 800,
      }),
      (error) => error.code === "SYNC_DELETE_INVALID",
    );
    await assert.rejects(
      () => onMessage({
        type: "SYNC_ENTITY_DELETE",
        id: "topic-stage",
        dataType: "topic",
        ownerType: "agent",
        ownerId: "agent-stage",
        deletedAt: 800,
      }),
      (error) => {
        assert.equal(error.code, "SYNC_DELETE_FAILED");
        assert.equal(error.stage, "topic_metadata");
        assert.deepEqual(error.failedTopicIds, ["topic-stage"]);
        return true;
      },
    );
  } finally {
    db.close();
  }
});

test("MobileSync JavaScript 不再混用 SQLite 编号参数和位置绑定", () => {
  for (const filePath of [DB_PATH, ENTITY_PATH]) {
    assert.doesNotMatch(
      fs.readFileSync(filePath, "utf8"),
      /\?[1-9]\d*/u,
      `${path.relative(ROOT, filePath)} contains numbered SQLite parameters`,
    );
  }
});
