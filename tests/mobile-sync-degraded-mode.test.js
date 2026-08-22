"use strict";

/**
 * 第五轮修复（缺口 D / F6 / F7）回归测试。
 *
 * - 缺口 D：uploadEntitiesBatch 父 config 缺失（ENOENT）与单条上传对齐为
 *   SYNC_ENTITY_NOT_FOUND，其余文件级错误保持 SYNC_ENTITY_BATCH_FAILED。
 * - F6：ChatDataServiceLifecycle 对 retryable=false 的启动失败直接熔断，
 *   不再排重启定时器（杀-起循环修复）。
 * - F7：CDS 缺席时 registerRoutes 降级注册——WS/HTTP 照常开放，中央同步
 *   请求收到结构化 CDS_UNAVAILABLE（origin=desktop_cds）而非 TCP 拒绝。
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

// 测试环境下 better-sqlite3 原生绑定不可用（Electron ABI），真实的
// new Database() 会抛 bindings 错误。中央降级模式本就不需要本地持久化索引，
// 在 index.js 加载前 stub 掉 initDb，走 getDb() === null 的既有早退路径。
const entityDatabase = require("../VCPDistributedServer/Plugin/VCPMobileSync/core/db");
entityDatabase.initDb = () => null;

const {
  registerRoutes,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/index");
const {
  stopWsServer,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/transport/websocket");
const {
  getLogger,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/core/logger");
const WebSocket = require("ws");

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

function connectWs(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function connectWithRetry(port, token, attempts = 30) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await connectWs(port, token);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error("WS connect failed");
}

function nextFrameOfType(ws, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for frame ${type}`));
    }, timeoutMs);
    const onMessage = (raw) => {
      let frame = null;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!frame || frame.type !== type) return; // 过滤 SYNC_LOG_EVENT 等广播帧
      cleanup();
      resolve(frame);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
    };
    ws.on("message", onMessage);
  });
}

test("F7: CDS 缺席时插件降级注册，WS 可用且中央同步请求收到 CDS_UNAVAILABLE", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-f7-"));
  const projectBasePath = path.join(tmp, "VCPDistributedServer");
  fs.mkdirSync(path.join(tmp, "AppData", "UserData", "attachments"), { recursive: true });
  fs.mkdirSync(projectBasePath, { recursive: true });

  const port = 16987;
  const token = "degraded-test-token";
  const mounts = [];
  const fakeApp = { use: (...args) => mounts.push(args) };

  // CDS 缺席（client=null）：降级模式下注册必须成功而不是整体 throw。
  await registerRoutes(
    fakeApp,
    { MobileSyncToken: token, MobileSyncPort: String(port) },
    projectBasePath,
    { chatDataService: { client: null } },
  );

  let ws = null;
  t.after(async () => {
    try {
      if (ws) ws.terminate();
    } catch {}
    await stopWsServer();
    try {
      getLogger().endSession();
    } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  assert.ok(
    mounts.some((args) => args[0] === "/api/mobile-sync"),
    "降级模式下 HTTP 同步路由必须照常挂载",
  );

  ws = await connectWithRetry(port, token);

  const ackPromise = nextFrameOfType(ws, "VERSION_ACK");
  ws.send(
    JSON.stringify({
      type: "VERSION_CHECK",
      mobileVersion: "1.1.4",
      protocolVersion: "1.2",
    }),
  );
  const ack = await ackPromise;
  assert.equal(ack.protocolVersion, "1.2");

  const errorPromise = nextFrameOfType(ws, "SYNC_ERROR");
  ws.send(
    JSON.stringify({
      type: "SYNC_MANIFEST",
      dataType: "agent",
      data: [],
      phase: 1,
    }),
  );
  const errorFrame = await errorPromise;
  assert.equal(errorFrame.error.code, "CDS_UNAVAILABLE");
  assert.equal(errorFrame.error.origin, "desktop_cds");
  // withSyncErrorContext 允许边界收窄 stage：SYNC_MANIFEST(agent) 在
  // owner_metadata 阶段被观测，wire 上即为 owner_metadata（契约语义）。
  assert.equal(errorFrame.error.stage, "owner_metadata");
});
