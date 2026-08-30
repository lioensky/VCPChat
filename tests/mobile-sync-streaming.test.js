"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test } = require("node:test");

const {
  createCentralSyncAdapter,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/sync/central");
const {
  NdjsonWriter,
  readNdjsonLines,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/transport/ndjson");
const {
  startWsServer,
  stopWsServer,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/transport/websocket");
const {
  ChatDataServiceClient,
} = require("../modules/services/chatDataService/client");

function createClientAdapter(client) {
  return createCentralSyncAdapter({ chatDataService: { client } });
}

class FakeResponse extends EventEmitter {
  constructor({ blockFirstWrite = false } = {}) {
    super();
    this.blockFirstWrite = blockFirstWrite;
    this.blocked = false;
    this.headers = new Map();
    this.chunks = [];
    this.ended = false;
  }

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  flushHeaders() {}

  write(chunk) {
    this.chunks.push(String(chunk));
    if (this.blockFirstWrite) {
      this.blockFirstWrite = false;
      this.blocked = true;
      setTimeout(() => {
        this.blocked = false;
        this.emit("drain");
      }, 5);
      return false;
    }
    return true;
  }

  end() {
    this.ended = true;
    this.emit("finish");
  }

  frames() {
    return this.chunks
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

function assertWriterListenersClean(response) {
  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(response.listenerCount("error"), 0);
}

test("中央 pull 逐帧 canonicalize 并遵守响应背压", async () => {
  const response = new FakeResponse({ blockFirstWrite: true });
  let advancedBeforeDrain = null;
  const hash = "a".repeat(64);
  const client = {
    async *requestNdjson(method, route, body, options) {
      assert.equal(method, "POST");
      assert.equal(route, "/v3/sync/messages/pull");
      assert.deepEqual(body, {
        topics: [
          { topicId: "topic-a", ownerType: "agent", ownerId: "agent-a", messageIds: [] },
          { topicId: "topic-b", ownerType: "group", ownerId: "group-b", messageIds: [] },
        ],
      });
      assert.ok(options.signal instanceof AbortSignal);
      yield {
        kind: "topic",
        topicId: "topic-a",
        ownerType: "agent",
        ownerId: "agent-a",
        ok: true,
        messages: [
          {
            id: "m-a",
            role: "user",
            content: "hello",
            timestamp: "1",
            attachments: [
              {
                type: "text/plain",
                name: "legacy.txt",
                size: 5,
                _fileManagerData: {
                  hash: hash.toUpperCase(),
                  internalPath: "desktop-internal-path-must-not-cross-wire",
                },
              },
            ],
          },
        ],
      };
      advancedBeforeDrain = response.blocked;
      yield {
        kind: "topic",
        topicId: "topic-b",
        ownerType: "group",
        ownerId: "group-b",
        ok: true,
        messages: [],
      };
    },
  };
  const adapter = createClientAdapter(client);

  await adapter.pullMessagesStreamRaw(
    [
      {
        topicId: "topic-a",
        ownerType: "agent",
        ownerId: "agent-a",
        messageIds: [],
      },
      {
        topicId: "topic-b",
        ownerType: "group",
        ownerId: "group-b",
        messageIds: [],
      },
    ],
    response,
  );

  assert.equal(advancedBeforeDrain, false);
  assert.equal(response.ended, true);
  const frames = response.frames();
  assert.equal(frames.length, 2);
  assert.equal(frames[0].kind, "topic");
  assert.equal(frames[0].ok, true);
  assert.equal(frames[0].messages[0].attachments[0].hash, hash);
  assert.equal(frames[0].messages[0].attachments[0]._fileManagerData, undefined);
  assert.equal(frames[0].messages[0].contentHash, undefined);
  assert.deepEqual(
    [frames[0].ownerType, frames[0].ownerId, frames[1].ownerType, frames[1].ownerId],
    ["agent", "agent-a", "group", "group-b"],
  );
});

test("中央 pull 在 Mobile 断开时取消真实 CDS client 流", { timeout: 1_000 }, async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const response = new FakeResponse();
  let startUpstream;
  const upstreamStarted = new Promise((resolve) => {
    startUpstream = resolve;
  });
  global.fetch = async (_url, options) => ({
    ok: true,
    status: 200,
    body: Readable.from((async function* hangingBody() {
      startUpstream();
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("cancelled");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
      if (false) yield null;
    })()),
  });
  const client = new ChatDataServiceClient({ port: 1, authToken: "test" });
  const pending = createClientAdapter(client).pullMessagesStreamRaw([
    { topicId: "topic-a", ownerType: "agent", ownerId: "agent-a", messageIds: [] },
  ], response);

  await upstreamStarted;
  response.emit("close");

  await assert.rejects(
    pending,
    (error) => error?.code === "CANCELLED" && error.retryable === false,
  );
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(response.listenerCount("finish"), 0);
});

test("中央 pull 拒绝 CDS 返回的 Owner 身份漂移", async () => {
  const adapter = createClientAdapter({
    async *requestNdjson() {
      yield {
        kind: "topic",
        topicId: "topic-a",
        ownerType: "group",
        ownerId: "group-a",
        ok: true,
        messages: [],
      };
    },
  });
  await assert.rejects(
    () => adapter.pullMessagesStreamRaw(
      [{
        topicId: "topic-a",
        ownerType: "agent",
        ownerId: "agent-a",
        messageIds: [],
      }],
      new FakeResponse(),
    ),
    /conflicting owner identity/,
  );
});

test("中央 pull 将 CDS item error 补全为 WireSyncError", async () => {
  const adapter = createClientAdapter({
    async *requestNdjson() {
      yield {
        kind: "topic",
        topicId: "topic-a",
        ownerType: "agent",
        ownerId: "agent-a",
        ok: false,
        error: {
          code: "MESSAGE_READ_FAILED",
          message: "CDS message query failed",
          retryable: false,
        },
      };
    },
  });
  const response = new FakeResponse();

  await adapter.pullMessagesStreamRaw(
    [{
      topicId: "topic-a",
      ownerType: "agent",
      ownerId: "agent-a",
      messageIds: [],
    }],
    response,
  );

  assert.deepEqual(response.frames(), [{
    kind: "topic",
    topicId: "topic-a",
    ownerType: "agent",
    ownerId: "agent-a",
    ok: false,
    error: {
      code: "SYNC_MESSAGE_READ_FAILED",
      origin: "desktop_cds",
      stage: "messages",
      kind: "storage",
      retry: "manual",
      message: "CDS message query failed",
      failedTopicIds: ["topic-a"],
    },
  }]);
});

test("中央 pull 保留 CDS 单帧预算错误的公开语义", async () => {
  const adapter = createClientAdapter({
    async *requestNdjson() {
      yield {
        kind: "topic",
        topicId: "topic-a",
        ownerType: "agent",
        ownerId: "agent-a",
        ok: false,
        error: {
          code: "BUDGET_EXCEEDED",
          message: "CDS pull frame exceeds 32 MiB budget",
          retryable: false,
        },
      };
    },
  });
  const response = new FakeResponse();

  await adapter.pullMessagesStreamRaw(
    [{
      topicId: "topic-a",
      ownerType: "agent",
      ownerId: "agent-a",
      messageIds: [],
    }],
    response,
  );

  assert.deepEqual(response.frames()[0].error, {
    code: "SYNC_BUDGET_EXCEEDED",
    origin: "desktop_cds",
    stage: "messages",
    kind: "data",
    retry: "after_user_action",
    message: "CDS pull frame exceeds 32 MiB budget",
    failedTopicIds: ["topic-a"],
  });
});

test("中央 push 逐 topic 投影附件元数据且不传输二进制", async (t) => {
  const appDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-central-"));
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }));
  const hash = "b".repeat(64);
  let pushedTopic = null;
  const client = {
    async request(method, route, topic) {
      assert.equal(method, "POST");
      assert.equal(route, "/v3/sync/messages/push");
      pushedTopic = topic;
      return {
        topicId: topic.topicId,
        ownerType: topic.ownerType,
        ownerId: topic.ownerId,
        ok: true,
      };
    },
  };
  const compatibilityDb = {
    prepare() {
      return { get: () => undefined };
    },
  };
  const adapter = createCentralSyncAdapter({
    chatDataService: { client },
    appDataPath,
    compatibilityDb,
  });
  const request = Readable.from([
    `${JSON.stringify({
      kind: "topic",
      topicId: "topic-a",
      ownerType: "agent",
      ownerId: "agent-a",
      messages: [
        {
          id: "m-a",
          role: "user",
          content: "mobile",
          timestamp: 2,
          updatedAt: 3,
          attachments: [
            {
              type: "text/plain",
              name: "mobile.txt",
              size: 6,
              hash,
            },
          ],
        },
      ],
      deletedMessages: [],
    })}\n`,
  ]);
  const response = new FakeResponse();

  await adapter.pushMessagesStreamRaw(request, response);

  assert.equal(response.ended, true);
  assert.deepEqual(response.frames(), [
    {
      kind: "topic",
      topicId: "topic-a",
      ownerType: "agent",
      ownerId: "agent-a",
      ok: true,
    },
  ]);
  assert.equal(pushedTopic.ownerType, "agent");
  assert.equal(pushedTopic.ownerId, "agent-a");
  assert.equal(pushedTopic.messages[0].updatedAt, 3);
  const desktopAttachment = pushedTopic.messages[0].attachments[0];
  assert.equal(desktopAttachment.hash, undefined);
  assert.equal(desktopAttachment._fileManagerData.hash, hash);
  assert.equal(desktopAttachment._fileManagerData.internalPath, "");
  assert.equal(desktopAttachment.status, undefined);
});

test("中央 push 将 CDS 快照过期映射为可重新比对的统一错误", async (t) => {
  const appDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-error-"));
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }));
  const client = {
    async request(_method, _route, { topicId, ownerType, ownerId }) {
      return {
        topicId,
        ownerType,
        ownerId,
        ok: false,
        error: {
          code: "SNAPSHOT_STALE",
          message: "history changed concurrently",
          retryable: false,
        },
      };
    },
  };
  const adapter = createCentralSyncAdapter({
    chatDataService: { client },
    appDataPath,
    compatibilityDb: { prepare: () => ({ get: () => undefined }) },
  });
  const request = Readable.from([
    `${JSON.stringify({
      kind: "topic",
      topicId: "topic-a",
      ownerType: "agent",
      ownerId: "agent-a",
      messages: [],
      deletedMessages: [],
    })}\n`,
  ]);
  const response = new FakeResponse();

  await adapter.pushMessagesStreamRaw(request, response);

  assert.deepEqual(response.frames(), [{
    kind: "topic",
    topicId: "topic-a",
    ownerType: "agent",
    ownerId: "agent-a",
    ok: false,
    error: {
      code: "SYNC_SNAPSHOT_STALE",
      origin: "desktop_cds",
      stage: "messages",
      kind: "data",
      retry: "manual",
      message: "history changed concurrently",
      failedTopicIds: ["topic-a"],
    },
  }]);
});

test("中央消息删除把稳定 deletedAt 作为逐消息墓碑交给 CDS", async () => {
  let pushedTopic = null;
  const client = {
    async request(method, route, topic) {
      assert.equal(method, "POST");
      assert.equal(route, "/v3/sync/messages/push");
      pushedTopic = topic;
      return {
        topicId: topic.topicId,
        ownerType: topic.ownerType,
        ownerId: topic.ownerId,
        ok: true,
      };
    },
  };
  const adapter = createClientAdapter(client);

  assert.equal(
    await adapter.deleteMessage({
      topicId: "topic-a",
      ownerType: "group",
      ownerId: "group-a",
      msgId: "message-a",
      deletedAt: 42,
    }),
    undefined,
  );
  assert.deepEqual(pushedTopic, {
    topicId: "topic-a",
    ownerType: "group",
    ownerId: "group-a",
    messages: [],
    deletedMessages: [{ msgId: "message-a", deletedAt: 42 }],
  });
});

test("NDJSON reader 在 JSON parse 前拒绝越界单帧", async () => {
  await assert.rejects(
    async () => {
      for await (const _line of readNdjsonLines(Readable.from(["ab", "cd"]), {
        maxLineBytes: 3,
      })) {
        assert.fail("oversized line must not be yielded");
      }
    },
    (error) => error?.code === "SYNC_BUDGET_EXCEEDED",
  );
});

test("NDJSON writer 在已关闭或 write 内同步关闭时立即失败并清理监听", { timeout: 1000 }, async () => {
  const alreadyClosed = new EventEmitter();
  alreadyClosed.destroyed = true;
  alreadyClosed.write = () => assert.fail("closed response must not be written");
  await assert.rejects(
    () => new NdjsonWriter(alreadyClosed).write({ topicId: "closed" }),
    /consumer disconnected/,
  );
  assertWriterListenersClean(alreadyClosed);

  const closesDuringWrite = new EventEmitter();
  closesDuringWrite.destroyed = false;
  closesDuringWrite.write = () => {
    closesDuringWrite.destroyed = true;
    closesDuringWrite.emit("close");
    return false;
  };
  await assert.rejects(
    () => new NdjsonWriter(closesDuringWrite).write({ topicId: "late-close" }),
    /consumer disconnected/,
  );
  assertWriterListenersClean(closesDuringWrite);
});

test("NDJSON writer 的直写、背压和错误路径都只结算一次并清理监听", async () => {
  const direct = new EventEmitter();
  direct.write = () => true;
  await new NdjsonWriter(direct).write({ topicId: "direct" });
  assertWriterListenersClean(direct);

  const backpressured = new EventEmitter();
  backpressured.write = () => {
    queueMicrotask(() => backpressured.emit("drain"));
    return false;
  };
  await new NdjsonWriter(backpressured).write({ topicId: "backpressure" });
  assertWriterListenersClean(backpressured);

  const failed = new EventEmitter();
  failed.write = () => {
    failed.emit("error", new Error("injected write failure"));
    return false;
  };
  await assert.rejects(
    () => new NdjsonWriter(failed).write({ topicId: "error" }),
    /injected write failure/,
  );
  assertWriterListenersClean(failed);
});

test("WebSocket 启动等待 listening，并把端口绑定错误返回调用链", async (t) => {
  t.after(async () => {
    await stopWsServer();
  });

  const server = await startWsServer({
    port: 0,
    syncToken: "startup-test-token",
    onMessage: async () => null,
  });
  assert.equal(server.address().port > 0, true);
  await stopWsServer();

  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "0.0.0.0", resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        blocker.close(() => resolve());
      }),
  );
  const blockedPort = blocker.address().port;

  await assert.rejects(
    () =>
      startWsServer({
        port: blockedPort,
        syncToken: "startup-test-token",
        onMessage: async () => null,
      }),
    (error) => error?.code === "EADDRINUSE",
  );
});

test("CDS Node client 用非零偏移字节视图消费拆分 Unicode NDJSON", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const bytes = Buffer.from(`${JSON.stringify({ topicId: "主题", messages: [] })}\n`);
  const split = bytes.indexOf(Buffer.from("题")) + 1;
  const offsetView = (part) => {
    const backing = new Uint8Array(part.length + 4);
    backing.fill(0xff);
    backing.set(part, 2);
    return backing.subarray(2, 2 + part.length);
  };
  global.fetch = async () => ({
    ok: true,
    status: 200,
    body: (async function* body() {
      yield offsetView(bytes.subarray(0, split));
      yield offsetView(bytes.subarray(split));
    })(),
  });
  const client = new ChatDataServiceClient({ port: 1, authToken: "test" });
  const frames = [];
  for await (const frame of client.requestNdjson(
    "POST",
    "/v3/sync/messages/pull",
    { topics: [] },
  )) {
    frames.push(frame);
  }
  assert.deepEqual(frames, [{ topicId: "主题", messages: [] }]);
});

test("CDS Node client 的同步请求可显式禁用总时限", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (_url, options) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 20);
      options.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    };
  };
  const client = new ChatDataServiceClient({
    port: 1,
    authToken: "test",
    timeoutMs: 1,
  });

  const result = await client.request("POST", "/v3/sync/manifest", {}, {
    timeoutMs: null,
  });

  assert.deepEqual(result, { ok: true });
});

test("CDS Node client 不对 NDJSON 下载施加墙钟时限", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const bytes = Buffer.from(`${JSON.stringify({ topicId: "topic-a", messages: [] })}\n`);
  global.fetch = async (_url, options) => ({
    ok: true,
    status: 200,
    body: Readable.from((async function* delayedBody() {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 20);
        options.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
      yield bytes;
    })()),
  });
  const client = new ChatDataServiceClient({
    port: 1,
    authToken: "test",
    timeoutMs: 1,
  });
  const frames = [];

  for await (const frame of client.requestNdjson(
    "POST",
    "/v3/sync/messages/pull",
    { topics: [] },
  )) {
    frames.push(frame);
  }

  assert.deepEqual(frames, [{ topicId: "topic-a", messages: [] }]);
});
