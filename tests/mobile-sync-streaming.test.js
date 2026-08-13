"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test } = require("node:test");

const {
  createCentralSyncAdapter,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/sync/central");
const {
  uploadAttachmentStream,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/sync/message");
const {
  readNdjsonLines,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/transport/ndjson");
const {
  ChatDataServiceClient,
} = require("../modules/services/chatDataService/client");

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

test("中央 pull 逐帧 canonicalize 并遵守响应背压", async () => {
  const response = new FakeResponse({ blockFirstWrite: true });
  let advancedBeforeDrain = null;
  const hash = "a".repeat(64);
  const client = {
    async *syncMessagesPullStream() {
      yield {
        topicId: "topic-a",
        ownerType: "agent",
        ownerId: "agent-a",
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
        topicId: "topic-b",
        ownerType: "group",
        ownerId: "group-b",
        messages: [],
      };
    },
  };
  const adapter = createCentralSyncAdapter({ client });

  await adapter.downloadMessagesStreamRaw(
    [
      {
        topicId: "topic-a",
        ownerType: "agent",
        ownerId: "agent-a",
        msgIds: [],
      },
      {
        topicId: "topic-b",
        ownerType: "group",
        ownerId: "group-b",
        msgIds: [],
      },
    ],
    response,
  );

  assert.equal(advancedBeforeDrain, false);
  assert.equal(response.ended, true);
  const frames = response.frames();
  assert.equal(frames.length, 2);
  assert.equal(frames[0].messages[0].attachments[0].hash, hash);
  assert.equal(frames[0].messages[0].attachments[0]._fileManagerData, undefined);
  assert.match(frames[0].messages[0].contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    [frames[0].ownerType, frames[0].ownerId, frames[1].ownerType, frames[1].ownerId],
    ["agent", "agent-a", "group", "group-b"],
  );
});

test("中央 pull 拒绝 CDS 返回的 Owner 身份漂移", async () => {
  const adapter = createCentralSyncAdapter({
    client: {
      async *syncMessagesPullStream() {
        yield {
          topicId: "topic-a",
          ownerType: "group",
          ownerId: "group-a",
          messages: [],
        };
      },
    },
  });
  await assert.rejects(
    () => adapter.downloadMessagesStreamRaw(
      [{
        topicId: "topic-a",
        ownerType: "agent",
        ownerId: "agent-a",
        msgIds: [],
      }],
      new FakeResponse(),
    ),
    /conflicting owner identity/,
  );
});

test("中央 pull 将 CDS 字符串错误补全为 Wire 1.2 对象", async () => {
  const adapter = createCentralSyncAdapter({
    client: {
      async *syncMessagesPullStream() {
        yield {
          topicId: "topic-a",
          ownerType: "agent",
          ownerId: "agent-a",
          messages: [],
          _error: "CDS message query failed",
        };
      },
    },
  });
  const response = new FakeResponse();

  await adapter.downloadMessagesStreamRaw(
    [{
      topicId: "topic-a",
      ownerType: "agent",
      ownerId: "agent-a",
      msgIds: [],
    }],
    response,
  );

  assert.deepEqual(response.frames(), [{
    topicId: "topic-a",
    ownerType: "agent",
    ownerId: "agent-a",
    messages: [],
    _error: {
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

test("中央 push 逐 topic 投影为 VCPChat 原生附件并回传 needed hash", async (t) => {
  const appDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-central-"));
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }));
  const hash = "b".repeat(64);
  let pushedTopic = null;
  const client = {
    async syncTopicIdentity(selector) {
      assert.deepEqual(selector, {
        topicId: "topic-a",
        ownerType: "agent",
        ownerId: "agent-a",
      });
      const { topicId } = selector;
      return { topicId, ownerType: "agent", ownerId: "agent-a" };
    },
    async syncMessagesPushTopic(topic) {
      pushedTopic = topic;
      return {
        topicId: topic.topicId,
        success: true,
        neededAttachmentHashes: [],
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
      topicId: "topic-a",
      ownerType: "agent",
      ownerId: "agent-a",
      messages: [
        {
          id: "m-a",
          role: "user",
          content: "mobile",
          timestamp: 2,
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
    })}\n`,
  ]);
  const response = new FakeResponse();

  await adapter.uploadMessagesBatchRaw(request, response);

  assert.equal(response.ended, true);
  assert.deepEqual(response.frames(), [
    { topicId: "topic-a", success: true, neededAttachmentHashes: [hash] },
  ]);
  assert.equal(pushedTopic.ownerType, "agent");
  assert.equal(pushedTopic.ownerId, "agent-a");
  const desktopAttachment = pushedTopic.messages[0].attachments[0];
  assert.equal(desktopAttachment.hash, undefined);
  assert.equal(desktopAttachment._fileManagerData.hash, hash);
  assert.equal(
    desktopAttachment._fileManagerData.internalPath,
    `file://${path.join(appDataPath, "UserData", "attachments", `${hash}.txt`)}`,
  );
});

test("中央 push 将 CDS 字符串错误补全为统一 NDJSON 错误对象", async (t) => {
  const appDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-error-"));
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }));
  const client = {
    async syncTopicIdentity({ topicId }) {
      return { topicId, ownerType: "agent", ownerId: "agent-a" };
    },
    async syncMessagesPushTopic({ topicId }) {
      return {
        topicId,
        success: false,
        error: "CDS write transaction failed",
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
      topicId: "topic-a",
      ownerType: "agent",
      ownerId: "agent-a",
      messages: [],
    })}\n`,
  ]);
  const response = new FakeResponse();

  await adapter.uploadMessagesBatchRaw(request, response);

  assert.deepEqual(response.frames(), [{
    topicId: "topic-a",
    success: false,
    neededAttachmentHashes: [],
    error: {
      code: "SYNC_MESSAGE_WRITE_FAILED",
      origin: "desktop_cds",
      stage: "messages",
      kind: "storage",
      retry: "manual",
      message: "CDS write transaction failed",
      failedTopicIds: ["topic-a"],
    },
  }]);
});

test("中央消息删除把稳定 deletedAt 作为逐消息墓碑交给 CDS", async () => {
  let pushedTopic = null;
  const client = {
    async syncTopicIdentity({ topicId }) {
      return { topicId, ownerType: "group", ownerId: "group-a" };
    },
    async syncMessagesPushTopic(topic) {
      pushedTopic = topic;
      return {
        topicId: topic.topicId,
        success: true,
        changed: true,
        neededAttachmentHashes: [],
      };
    },
  };
  const adapter = createCentralSyncAdapter({ client });

  assert.deepEqual(
    await adapter.deleteMessage({
      topicId: "topic-a",
      msgId: "message-a",
      deletedAt: 42,
    }),
    { success: true, topicId: "topic-a", msgId: "message-a" },
  );
  assert.deepEqual(pushedTopic, {
    topicId: "topic-a",
    ownerType: "group",
    ownerId: "group-a",
    messages: [],
    deletedMessageIds: [],
    deletedMessageTombstones: [{ msgId: "message-a", deletedAt: 42 }],
  });
});

test("附件上传流校验 SHA-256 后再原子落盘和提交索引", async (t) => {
  const appDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-attachment-"));
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }));
  const bytes = Buffer.from("verified attachment", "utf8");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  let indexed = null;

  const result = await uploadAttachmentStream({
    hash,
    input: Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]),
    declaredLength: bytes.length,
    name: "proof.txt",
    type: "text/plain",
    appDataPath,
    indexAttachment: (indexedHash, filePath) => {
      indexed = { hash: indexedHash, filePath };
      assert.equal(fs.readFileSync(filePath, "utf8"), bytes.toString("utf8"));
    },
  });

  assert.deepEqual(result, { success: true, hash });
  assert.equal(indexed.hash, hash);
  assert.equal(path.basename(indexed.filePath), `${hash}.txt`);
  assert.deepEqual(
    fs.readdirSync(path.dirname(indexed.filePath)),
    [`${hash}.txt`],
  );

  await assert.rejects(
    () =>
      uploadAttachmentStream({
        hash: "c".repeat(64),
        input: Readable.from([bytes]),
        declaredLength: bytes.length,
        name: "bad.txt",
        type: "text/plain",
        appDataPath,
        indexAttachment: () => assert.fail("mismatched bytes must not be indexed"),
      }),
    /content hash mismatch/,
  );
  assert.equal(
    fs.readdirSync(path.join(appDataPath, "UserData", "attachments")).some(
      (name) => name.endsWith(".upload"),
    ),
    false,
  );
});

test("NDJSON reader 在 JSON parse 前拒绝 32 MiB 以上单帧", async () => {
  const oversized = Buffer.alloc(32 * 1024 * 1024 + 1, 0x61);
  await assert.rejects(
    async () => {
      for await (const _line of readNdjsonLines(Readable.from([oversized]))) {
        assert.fail("oversized line must not be yielded");
      }
    },
    /32 MiB/,
  );
});

test("CDS Node client 以字节边界消费拆分 Unicode NDJSON", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const bytes = Buffer.from(`${JSON.stringify({ topicId: "主题", messages: [] })}\n`);
  const split = bytes.indexOf(Buffer.from("题")) + 1;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    body: Readable.from([bytes.subarray(0, split), bytes.subarray(split)]),
  });
  const client = new ChatDataServiceClient({ port: 1, authToken: "test" });
  const frames = [];
  for await (const frame of client.syncMessagesPullStream({ requests: [] })) {
    frames.push(frame);
  }
  assert.deepEqual(frames, [{ topicId: "主题", messages: [] }]);
});
