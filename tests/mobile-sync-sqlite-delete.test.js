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
const MANIFEST_PATH = path.join(
  ROOT,
  "VCPDistributedServer",
  "Plugin",
  "VCPMobileSync",
  "sync",
  "manifest.js",
);
const MESSAGE_PATH = path.join(
  ROOT,
  "VCPDistributedServer",
  "Plugin",
  "VCPMobileSync",
  "sync",
  "message.js",
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

function TestDatabase(filename) {
  const database = new DatabaseSync(filename);
  database.transaction = (callback) => (...args) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback(...args);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };
  return database;
}

function loadSqliteModules({ captureOnMessage = null } = {}) {
  const modulePaths = [
    DB_PATH,
    ENTITY_PATH,
    INDEX_PATH,
    MANIFEST_PATH,
    MESSAGE_PATH,
    path.join(path.dirname(ENTITY_PATH), "central.js"),
  ];
  const savedModules = new Map(
    modulePaths.map((modulePath) => [modulePath, require.cache[modulePath]]),
  );
  for (const modulePath of modulePaths) delete require.cache[modulePath];

  const originalLoad = Module._load;
  Module._load = function loadTestDependency(request, parent, isMain) {
    if (request === "better-sqlite3") return TestDatabase;
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
    const manifest = require(MANIFEST_PATH);
    const message = require(MESSAGE_PATH);
    return { database, entity, index, manifest, message };
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
  ownerType = null,
  ownerId = null,
  filePath = null,
}) {
  const pathParts = String(filePath || "").replace(/\\/g, "/").split("/");
  const inferredOwnerType = pathParts.includes("AgentGroups") ? "group" : "agent";
  const inferredOwnerId = pathParts.at(-2);
  const resolvedOwnerType = ownerType ||
    (type === "group" || type === "group_topic" ? "group" : inferredOwnerType);
  const resolvedOwnerId = ownerId ||
    (["topic", "agent_topic", "group_topic"].includes(type)
      ? inferredOwnerId || "owner-a"
      : id);
  const resolvedFilePath = filePath ||
    `/virtual/${resolvedOwnerType === "group" ? "AgentGroups" : "Agents"}/${resolvedOwnerId}/config.json`;
  const isTopic = ["topic", "agent_topic", "group_topic"].includes(type);
  db.prepare(
    `INSERT OR IGNORE INTO owners
       (owner_type, owner_id, config_path, config_hash, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    resolvedOwnerType,
    resolvedOwnerId,
    resolvedFilePath,
    "a".repeat(64),
    1,
  );
  if (isTopic) {
    db.prepare(
      `INSERT INTO topics
         (owner_type, owner_id, topic_id, config_hash, content_hash, updated_at)
       VALUES (?, ?, ?, ?, '', ?)`,
    ).run(
      resolvedOwnerType,
      resolvedOwnerId,
      id,
      "a".repeat(64),
      1,
    );
  }
}

function entityRow(db, id, type, ownerType = null, ownerId = null) {
  const isTopic = ["topic", "agent_topic", "group_topic"].includes(type);
  if (!isTopic) {
    return db.prepare(
      `SELECT * FROM owners WHERE owner_type = ? AND owner_id = ?`,
    ).get(type, id);
  }
  if (ownerType !== null && ownerId !== null) {
    return db.prepare(
      `SELECT * FROM topics
       WHERE owner_type = ? AND owner_id = ? AND topic_id = ?`,
    ).get(ownerType, ownerId, id);
  }
  return db.prepare("SELECT * FROM topics WHERE topic_id = ?").get(id);
}

test("Legacy 普通 Owner/Topic upsert 不会清除墓碑", () => {
  const { database } = loadSqliteModules();
  const db = database.initDb(":memory:");

  try {
    for (const identity of [
      {
        id: "agent-a",
        type: "agent",
        ownerType: "agent",
        ownerId: "agent-a",
        filePath: "/virtual/Agents/agent-a/config.json",
      },
      {
        id: "topic-a",
        type: "topic",
        ownerType: "agent",
        ownerId: "agent-a",
        filePath: "/virtual/Agents/agent-a/config.json",
      },
    ]) {
      if (identity.type === "topic") {
        database.upsertTopicTombstone({
          ownerType: identity.ownerType,
          ownerId: identity.ownerId,
          topicId: identity.id,
          deletedAt: 200,
        });
        assert.throws(
          () => database.upsertTopicState({
            ownerType: identity.ownerType,
            ownerId: identity.ownerId,
            topicId: identity.id,
            configHash: "f".repeat(64),
          }),
          /tombstoned/,
        );
      } else {
        database.upsertOwnerTombstone({
          ownerType: identity.ownerType,
          ownerId: identity.ownerId,
          configPath: identity.filePath,
          deletedAt: 200,
        });
        assert.throws(
          () => database.upsertOwnerState({
            ownerType: identity.ownerType,
            ownerId: identity.ownerId,
            configPath: identity.filePath,
            configHash: "f".repeat(64),
          }),
          /tombstoned/,
        );
      }
      assert.equal(
        entityRow(
          db,
          identity.id,
          identity.type,
          identity.ownerType,
          identity.ownerId,
        ).deleted_at,
        200,
      );
    }
  } finally {
    db.close();
  }
});

test("Legacy 摄取会从物理 history 清除已持久化的消息墓碑", async (t) => {
  const { database, message } = loadSqliteModules();
  const db = database.initDb(":memory:");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-history-repair-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const ownerId = "agent-history-repair";
  const topicId = "topic-history-repair";
  const historyPath = path.join(
    directory,
    "UserData",
    ownerId,
    "topics",
    topicId,
    "history.json",
  );
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });

  try {
    insertEntity(db, {
      id: topicId,
      type: "topic",
      ownerType: "agent",
      ownerId,
    });
    database.upsertMessageTombstone({
      ownerType: "agent",
      ownerId,
      topicId,
      msgId: "message-deleted",
      deletedAt: 42,
    });
    fs.writeFileSync(
      historyPath,
      JSON.stringify([
        {
          id: "message-deleted",
          role: "user",
          content: "stale",
          timestamp: 1,
        },
        {
          id: "message-live",
          role: "assistant",
          content: "keep",
          timestamp: 2,
        },
      ]),
    );

    await message.ingestHistoryToDb(historyPath, {
      ownerType: "agent",
      ownerId,
      topicId,
    });

    assert.deepEqual(
      JSON.parse(fs.readFileSync(historyPath, "utf8")).map((item) => item.id),
      ["message-live"],
    );
    assert.equal(
      db.prepare(
        `SELECT deleted_at FROM messages
         WHERE owner_type = ? AND owner_id = ? AND topic_id = ? AND msg_id = ?`,
      ).get("agent", ownerId, topicId, "message-deleted").deleted_at,
      42,
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
      `INSERT INTO messages
         (owner_type, owner_id, topic_id, msg_id, message_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("agent", "agent-cascade", "topic-cascade", "message-cascade", "b".repeat(64), 1);
    database.upsertHistorySourceState({
      ownerType: "agent",
      ownerId: "agent-cascade",
      topicId: "topic-cascade",
      filePath: path.join(historyDir, "history.json"),
      fileSize: 2,
      mtimeMs: 1,
      sourceHash: "a".repeat(64),
    });

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
    assert.equal(database.getHistorySourceState({
      ownerType: "agent",
      ownerId: "agent-cascade",
      topicId: "topic-cascade",
    }), null);
    assert.equal(
      db.prepare(
        "SELECT deleted_at FROM messages WHERE topic_id = ? AND msg_id = ?",
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
      id: "agent-topic-delete",
      type: "agent",
      filePath: configPath,
    });
    insertEntity(db, {
      id: "topic-delete",
      type: "topic",
      filePath: configPath,
    });
    db.prepare(
      `INSERT INTO messages
         (owner_type, owner_id, topic_id, msg_id, message_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("agent", "agent-topic-delete", "topic-delete", "message-delete", "c".repeat(64), 1);

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
        "SELECT deleted_at FROM messages WHERE topic_id = ? AND msg_id = ?",
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
    insertEntity(db, { id: ownerId, type: "agent", filePath: configPath });
    insertEntity(db, { id: topicId, type: "topic", filePath: configPath });

    const upload = (name) => entity.uploadEntity({
      id: topicId,
      type: "agent_topic",
      ownerType: "agent",
      ownerId,
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
    insertEntity(db, { id: "group-owner", type: "group" });
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
    assert.equal(tombstone.config_hash, "0".repeat(64));
    assert.equal(tombstone.owner_type, "group");
    assert.equal(tombstone.owner_id, "group-owner");

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

test("启动 repair 用普通 backup 补回物理 Topic 元数据", async (t) => {
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
  const backupConfig = {
    name: "Existing Agent",
    topics: [
      { id: topicId, name: "Recovered From Backup", createdAt: 42 },
      { id: "topic-old-ghost", name: "Old Ghost", createdAt: 2 },
    ],
  };
  fs.writeFileSync(`${configPath}.backup`, JSON.stringify(backupConfig));
  fs.writeFileSync(
    path.join(topicDir, "history.json"),
    JSON.stringify([{ id: "message-repair", timestamp: 42 }]),
  );

  assert.deepEqual(await entity.repairTopicProjectionsFromDisk(directory), {
    ownersChanged: 1,
    topicsAdded: 1,
    topicsRemoved: 2,
  });
  const repaired = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(repaired.topics, [
    { id: topicId, name: "Recovered From Backup", createdAt: 42 },
  ]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(`${configPath}.backup`, "utf8")),
    backupConfig,
  );
});

test("启动 repair 从有效 backup 恢复配置并服从 Topic 墓碑", async (t) => {
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
      topics: [
        { id: topicId, name: "Recovered From Backup", createdAt: 73 },
        { id: "topic-backup-ghost", name: "Ghost", createdAt: 1 },
        { id: "topic-tombstoned", name: "Deleted", createdAt: 2 },
      ],
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
    database.upsertTopicTombstone({
      ownerType: "agent",
      ownerId,
      topicId: tombstonedTopicId,
      deletedAt: 99,
    });

    await entity.repairTopicProjectionsFromDisk(directory);
    const repaired = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(repaired.name, "Backed Up Agent");
    assert.deepEqual(
      repaired.topics.map((topic) => topic.id),
      [topicId],
    );
    assert.equal(repaired.topics[0].name, "Recovered From Backup");
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
      const ownerType = topicId === "topic-owner-stale" ? "group" : "agent";
      const ownerId = topicId === "topic-owner-stale" ? "group-stale" : "agent-live";
      db.prepare(
        `INSERT INTO messages
           (owner_type, owner_id, topic_id, msg_id, message_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(ownerType, ownerId, topicId, `message-${topicId}`, "c".repeat(64), 1);
      database.upsertHistorySourceState({
        ownerType,
        ownerId,
        topicId,
        filePath: `/virtual/${topicId}/history.json`,
        fileSize: 2,
        mtimeMs: 1,
        sourceHash: "a".repeat(64),
      });
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
        "SELECT topic_id FROM history_source_state ORDER BY topic_id",
      ).all().map((row) => row.topic_id),
      ["topic-live"],
    );
    assert.deepEqual(
      db.prepare(
        "SELECT topic_id, deleted_at FROM messages ORDER BY topic_id",
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

test("运行时 config 摄取按有效 Topic 配置收敛旧索引", async (t) => {
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
    database.upsertTopicTombstone({
      ownerType: "agent",
      ownerId,
      topicId: "topic-stale-deleted",
      deletedAt: 123,
    });
    db.prepare(
      `INSERT INTO messages
         (owner_type, owner_id, topic_id, msg_id, message_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "agent",
      ownerId,
      "topic-stale-live",
      "message-topic-stale-live",
      "c".repeat(64),
      1,
    );

    await index.ingestConfigToDb(configPath, "agent", directory);

    assert.equal(entityRow(db, "topic-live", "topic").deleted_at, null);
    assert.ok(Number.isSafeInteger(entityRow(db, "topic-stale-live", "topic").deleted_at));
    assert.equal(entityRow(db, "topic-stale-deleted", "topic").deleted_at, 123);
    assert.equal(
      db.prepare(
        "SELECT deleted_at FROM messages WHERE topic_id = ?",
      ).get("topic-stale-live").deleted_at,
      entityRow(db, "topic-stale-live", "topic").deleted_at,
    );
  } finally {
    db.close();
  }
});

test("legacy Topic root 内容变化不推进配置 updated_at", () => {
  const { database } = loadSqliteModules();
  const db = database.initDb(":memory:");
  try {
    insertEntity(db, { id: "topic-root", type: "topic" });
    db.prepare(
      "UPDATE topics SET content_hash = ?, updated_at = ? WHERE topic_id = ?",
    ).run("a".repeat(64), 100, "topic-root");

    database.updateTopicContentHash(
      { topicId: "topic-root", ownerType: "agent", ownerId: "owner-a" },
      "a".repeat(64),
    );
    assert.equal(entityRow(db, "topic-root", "topic").updated_at, 100);
    database.updateTopicContentHash(
      { topicId: "topic-root", ownerType: "agent", ownerId: "owner-a" },
      "b".repeat(64),
    );
    assert.equal(entityRow(db, "topic-root", "topic").updated_at, 100);
  } finally {
    db.close();
  }
});

test("legacy Owner root 持久化全部 live Topic 并包含 default", () => {
  const { database, manifest } = loadSqliteModules();
  const { computeAggregatedHash, computeTopicLeafHash } = require(
    path.join(ROOT, "VCPDistributedServer", "Plugin", "VCPMobileSync", "core", "hash.js"),
  );
  const db = database.initDb(":memory:");
  try {
    const configPath = "/app/Agents/agent-root/config.json";
    insertEntity(db, { id: "agent-root", type: "agent", filePath: configPath });
    insertEntity(db, { id: "default", type: "topic", filePath: configPath });
    insertEntity(db, { id: "topic-live", type: "topic", filePath: configPath });
    db.prepare(
      "UPDATE topics SET config_hash = ?, content_hash = '', updated_at = 10 WHERE topic_id = ?",
    ).run("d".repeat(64), "default");
    db.prepare(
      "UPDATE topics SET config_hash = ?, content_hash = ?, updated_at = 20 WHERE topic_id = ?",
    ).run("a".repeat(64), "b".repeat(64), "topic-live");
    db.prepare(
      "UPDATE owners SET updated_at = 30 WHERE owner_id = 'agent-root'",
    ).run();
    assert.equal(database.refreshAllOwnerContentHashes(db), 1);

    const expected = computeAggregatedHash([
      computeTopicLeafHash("default", "d".repeat(64), ""),
      computeTopicLeafHash("topic-live", "a".repeat(64), "b".repeat(64)),
    ]);
    assert.equal(
      manifest.getLocalManifest("owner", null, db)[0].contentHash,
      expected,
    );
    assert.equal(entityRow(db, "agent-root", "agent").updated_at, 30);
    assert.equal(entityRow(db, "default", "topic").content_hash, "");

    db.prepare(
      "UPDATE topics SET config_hash = ?, content_hash = ? WHERE topic_id = 'default'",
    ).run("e".repeat(64), "f".repeat(64));
    assert.equal(
      manifest.getLocalManifest("owner", null, db)[0].contentHash,
      expected,
    );
    database.refreshOwnerContentHash({
      ownerType: "agent",
      ownerId: "agent-root",
    });
    assert.equal(
      manifest.getLocalManifest("owner", null, db)[0].contentHash,
      computeAggregatedHash([
        computeTopicLeafHash("default", "e".repeat(64), "f".repeat(64)),
        computeTopicLeafHash("topic-live", "a".repeat(64), "b".repeat(64)),
      ]),
    );
    assert.equal(entityRow(db, "agent-root", "agent").updated_at, 30);
  } finally {
    db.close();
  }
});

test("legacy watcher 与全量扫描共用 DTO 默认值", async (t) => {
  const { database, index } = loadSqliteModules({ captureOnMessage() {} });
  const { extractAgentDTO, extractTopicDTO, AGENT_SYNC_FIELDS, AGENT_TOPIC_SYNC_FIELDS } =
    require(path.join(ROOT, "VCPDistributedServer", "Plugin", "VCPMobileSync", "dto"));
  const { computeDtoHash } = require(
    path.join(ROOT, "VCPDistributedServer", "Plugin", "VCPMobileSync", "core", "hash.js"),
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-watcher-dto-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ownerId = "agent-defaults";
  const topicId = "topic-defaults";
  const configPath = path.join(directory, "Agents", ownerId, "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.join(directory, "UserData", ownerId, "topics", topicId), {
    recursive: true,
  });
  const config = {
    name: "Defaults",
    temperature: "0.704",
    contextTokenLimit: "1000",
    maxOutputTokens: "2000",
    topics: [{ id: topicId, name: "Topic", createdAt: "3" }],
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const db = database.initDb(":memory:");
  t.after(() => db.close());

  await index.ingestConfigToDb(configPath, "agent", directory);

  assert.equal(
    entityRow(db, ownerId, "agent").config_hash,
    computeDtoHash(extractAgentDTO(config), AGENT_SYNC_FIELDS),
  );
  assert.equal(
    entityRow(db, topicId, "topic").config_hash,
    computeDtoHash(
      extractTopicDTO(config.topics[0], ownerId, "agent"),
      AGENT_TOPIC_SYNC_FIELDS,
    ),
  );
});

test("中央 Owner Phase 在 ACK 前刷新 CDS 提交视图", async (t) => {
  let onMessage = null;
  let reconcileCalls = 0;
  let releasePhaseReconcile;
  const phaseReconcileGate = new Promise((resolve) => {
    releasePhaseReconcile = resolve;
  });
  const { database, index } = loadSqliteModules({
    captureOnMessage(handler) {
      onMessage = handler;
    },
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-phase-barrier-"));
  const projectBasePath = path.join(directory, "VCPDistributedServer");
  fs.mkdirSync(projectBasePath, { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  t.after(() => releasePhaseReconcile?.());

  await index.registerRoutes(
    { use() {} },
    {
      MobileSyncToken: "phase-barrier-test-token",
      MobileSyncPort: "15976",
      MobileSyncUseCentralIndex: true,
    },
    projectBasePath,
    {
      chatDataService: {
        client: {
          async reconcile() {
            reconcileCalls += 1;
            if (reconcileCalls === 1) await phaseReconcileGate;
            return { stats: {} };
          },
        },
        mobileSyncUseCentralIndex: true,
      },
    },
  );

  assert.equal(typeof onMessage, "function");
  assert.equal(reconcileCalls, 0, "CDS 自有启动扫描不应被插件重复执行");
  const db = database.getDb();
  t.after(() => db.close());

  const phaseAckPromise = onMessage({
    type: "PHASE_START",
    phase: "owner_metadata",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reconcileCalls, 1);
  assert.equal(
    await Promise.race([
      phaseAckPromise.then(() => "settled"),
      new Promise((resolve) => setImmediate(() => resolve("pending"))),
    ]),
    "pending",
    "reconcile 完成前不得返回 Phase ACK",
  );

  releasePhaseReconcile();
  assert.deepEqual(await phaseAckPromise, {
    type: "PHASE_ACK",
    phase: "owner_metadata",
  });
  assert.deepEqual(
    await onMessage({ type: "PHASE_START", phase: "topic_metadata" }),
    { type: "PHASE_ACK", phase: "topic_metadata" },
  );
  assert.deepEqual(
    await onMessage({ type: "PHASE_COMPLETED", phase: "owner_metadata" }),
    { type: "PHASE_ACK", phase: "owner_metadata" },
  );
  assert.deepEqual(
    await onMessage({ type: "PHASE_COMPLETED", phase: "topic_metadata" }),
    { type: "PHASE_ACK", phase: "topic_metadata" },
  );
  assert.equal(reconcileCalls, 1, "后续 Phase 不应重复 reconcile");
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
        targetType: "topic",
        ownerType: "agent",
        ownerId: "agent-stage",
        deletedAt: 800,
      }),
      (error) => error.code === "SYNC_DELETE_INVALID",
    );
    await assert.rejects(
      () => onMessage({
        type: "SYNC_ENTITY_DELETE",
        targetType: "agent_topic",
        ownerType: "group",
        ownerId: "agent-stage",
        topicId: "topic-stage",
        deletedAt: 800,
      }),
      (error) => error.code === "SYNC_DELETE_INVALID",
    );
    await assert.rejects(
      () => onMessage({
        type: "SYNC_ENTITY_DELETE",
        targetType: "topic",
        ownerType: "agent",
        ownerId: "agent-stage",
        topicId: "topic-stage",
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
