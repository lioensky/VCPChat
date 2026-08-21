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
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ id: "agent-cascade", topics: [] }));
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
