"use strict";

/**
 * 第五轮修复（缺口 D / F6 / F7）回归测试。
 *
 * - 缺口 D：uploadEntitiesBatch 父 config 缺失（ENOENT）与单条上传对齐为
 *   SYNC_ENTITY_NOT_FOUND，其余文件级错误保持 SYNC_ENTITY_BATCH_FAILED。
 * - F6：ChatDataServiceLifecycle 对 retryable=false 的启动失败直接熔断，
 *   不再排重启定时器（杀-起循环修复）。
 * - F7：CDS 缺席时 registerRoutes 直接失败，不开放 MobileSync 端口。
 */

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

test("缺口D: 批量上传父 config 缺失报 SYNC_ENTITY_NOT_FOUND，损坏父 config 仍报 BATCH_FAILED", async () => {
  const appDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-gap-d-"));
  try {
    // 父 Agent 存在但 config.json 是坏 JSON → 非 ENOENT，保持 BATCH_FAILED。
    const brokenAgentDir = path.join(appDataPath, "Agents", "agentBroken1");
    fs.mkdirSync(brokenAgentDir, { recursive: true });
    fs.writeFileSync(path.join(brokenAgentDir, "config.json"), "{ not json", "utf-8");

    const results = await uploadEntitiesBatch(
      [
        // 父目录根本不存在 → ENOENT → 缺口 D 对齐为 NOT_FOUND。
        { id: "topicOrphan1", type: "agent_topic", data: { ownerId: "agentMissing1", name: "孤立话题" } },
        { id: "topicBroken1", type: "agent_topic", data: { ownerId: "agentBroken1", name: "坏父话题" } },
      ],
      appDataPath,
    );

    assert.equal(results.length, 2);
    const byId = new Map(results.map((r) => [r.id, r]));

    const orphan = byId.get("topicOrphan1");
    assert.equal(orphan.success, false);
    assert.equal(orphan.error.code, "SYNC_ENTITY_NOT_FOUND");
    assert.deepEqual(orphan.error.failedTopicIds, ["topicOrphan1"]);

    const broken = byId.get("topicBroken1");
    assert.equal(broken.success, false);
    assert.equal(broken.error.code, "SYNC_ENTITY_BATCH_FAILED");
    assert.deepEqual(broken.error.failedTopicIds, ["topicBroken1"]);
  } finally {
    fs.rmSync(appDataPath, { recursive: true, force: true });
  }
});

test("F6: retryable=false 的启动失败直接熔断并不再排重启", () => {
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

test("F6: 瞬态错误（retryable!==false）不触发熔断", () => {
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

test("F7: CDS 缺席时注册失败且不会挂载 MobileSync 路由", async (t) => {
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
