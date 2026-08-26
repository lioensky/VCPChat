"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  uploadEntitiesBatch,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/sync/entity");
const {
  ChatDataServiceLifecycle,
} = require("../modules/services/chatDataService/lifecycle");

// 测试环境下 better-sqlite3 原生绑定不可用（Electron ABI），在 index.js
// 加载前 stub initDb；本测试只验证 CDS 启动门禁，不触碰本地持久化索引。
const entityDatabase = require("../VCPDistributedServer/Plugin/VCPMobileSync/core/db");
entityDatabase.initDb = () => null;

const {
  registerRoutes,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/index");
const {
  getLogger,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/core/logger");

test("批量上传在父 Owner 未进入提交视图时返回实体缺失", async () => {
  const appDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-gap-d-"));
  try {
    const results = await uploadEntitiesBatch(
      [
        {
          id: "topicOrphan1",
          type: "agent_topic",
          ownerType: "agent",
          ownerId: "agentMissing1",
          data: { ownerId: "agentMissing1", name: "孤立话题" },
        },
      ],
      appDataPath,
    );

    assert.equal(results.length, 1);
    const byId = new Map(results.map((r) => [r.id, r]));

    const orphan = byId.get("topicOrphan1");
    assert.equal(orphan.success, false);
    assert.equal(orphan.error.code, "SYNC_ENTITY_NOT_FOUND");
    assert.deepEqual(orphan.error.failedTopicIds, ["topicOrphan1"]);
  } finally {
    fs.rmSync(appDataPath, { recursive: true, force: true });
  }
});

test("不可重试的 CDS 启动失败会熔断且不再排重启", () => {
  const errors = [];
  const logger = {
    error: (...args) => errors.push(args.map(String).join(" ")),
    log() {},
    info() {},
    warn() {},
  };
  const lifecycle = new ChatDataServiceLifecycle({
    appDataPath: "/tmp/vcp-f6",
    binaryPath: "/nonexistent/vcp-cds",
    logger,
  });
  let circuitEvent = null;
  lifecycle.on("circuit-open", (payload) => {
    circuitEvent = payload;
  });

  const blocked = lifecycle._blockNonRetryableRestart(
    Object.assign(new Error("wire protocol mismatch"), {
      code: "PROTOCOL_MISMATCH",
      retryable: false,
    }),
  );

  assert.equal(blocked, true);
  assert.equal(lifecycle.circuitOpen, true);
  assert.equal(circuitEvent && circuitEvent.reason, "PROTOCOL_MISMATCH");
  assert.ok(
    errors.some((line) => line.includes("PROTOCOL_MISMATCH") && line.includes("重建")),
    "熔断日志必须包含错误码与可操作的重建指引",
  );

  // 熔断后 _scheduleRestart 必须是 no-op：不排定时器、不计尝试次数。
  lifecycle._scheduleRestart();
  assert.equal(lifecycle.restartTimer, null);
  assert.equal(lifecycle.restartAttempts, 0);
});

test("可重试或未分类的 CDS 启动失败不会熔断", () => {
  const logger = { error() {}, log() {}, info() {}, warn() {} };
  const lifecycle = new ChatDataServiceLifecycle({
    appDataPath: "/tmp/vcp-f6",
    binaryPath: "/nonexistent/vcp-cds",
    logger,
  });

  assert.equal(lifecycle._blockNonRetryableRestart(null), false);
  assert.equal(lifecycle._blockNonRetryableRestart(new Error("boom")), false);
  assert.equal(
    lifecycle._blockNonRetryableRestart(
      Object.assign(new Error("busy"), { code: "SERVICE_BUSY", retryable: true }),
    ),
    false,
  );
  assert.equal(lifecycle.circuitOpen, false);
});

test("CDS 缺席时注册失败且不会挂载 MobileSync 路由", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-f7-"));
  const projectBasePath = path.join(tmp, "VCPDistributedServer");
  fs.mkdirSync(path.join(tmp, "AppData", "UserData", "attachments"), { recursive: true });
  fs.mkdirSync(projectBasePath, { recursive: true });

  const mounts = [];
  const fakeApp = { use: (...args) => mounts.push(args) };

  t.after(() => {
    try {
      getLogger().endSession();
    } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await assert.rejects(
    registerRoutes(
      fakeApp,
      { MobileSyncToken: "closed-gate-token", MobileSyncPort: "16987" },
      projectBasePath,
      { chatDataService: { client: null } },
    ),
    (error) => error.code === "CDS_UNAVAILABLE",
  );
  assert.equal(mounts.length, 0);
});
