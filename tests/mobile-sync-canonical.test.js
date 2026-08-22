"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const {
  canonicalizeTopicFrame,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/sync/canonical");
const {
  computeAggregatedHash,
  computeMessageLeafHash,
  computeMessageFingerprint,
  computeTopicLeafHash,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/core/hash");

const FIXTURE_PATH = path.join(
  __dirname,
  "..",
  "VCPDistributedServer",
  "Plugin",
  "VCPMobileSync",
  "fixtures",
  "protocol_1_2_golden.json",
);
const EXPECTED_FIXTURE_SHA256 =
  "187d599d33ef660de299aae77a68eb92313af3d603efe72f7f06ecb6ac1e0c1f";

test("协议 1.2 golden bundle 与 Mobile 字节一致", () => {
  const bytes = fs.readFileSync(FIXTURE_PATH);
  assert.equal(
    crypto.createHash("sha256").update(bytes).digest("hex"),
    EXPECTED_FIXTURE_SHA256,
  );
});

test("canonicalizer 与 Mobile golden 输出和消息指纹一致", () => {
  const bundle = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  assert.equal(bundle.wireProtocol, "1.2");

  for (const fixture of bundle.validFrames) {
    const result = canonicalizeTopicFrame(fixture.input, {
      includeContentHash: false,
    });
    assert.equal(result.frame.topicId, fixture.expected.topicId);
    assert.equal(result.frame.messages.length, fixture.expected.messageCount);
    assert.equal(result.warningCount, fixture.expected.warningCount);
    assert.deepEqual(result.frame.messages, fixture.expected.canonicalMessages);
    assert.deepEqual(result.contentHashes, fixture.expected.contentHashes);
  }
});

test("消息与 Owner 聚合绑定实体身份", () => {
  const message = {
    id: "message-a",
    role: "assistant",
    name: "Nova",
    agentId: "agent-a",
    content: "same",
    timestamp: 1,
  };
  assert.notEqual(
    computeMessageFingerprint(message),
    computeMessageFingerprint({ ...message, id: "message-b" }),
  );
  assert.notEqual(
    computeAggregatedHash([computeMessageLeafHash("message-a", "same")]),
    computeAggregatedHash([computeMessageLeafHash("message-b", "same")]),
  );

  const original = computeAggregatedHash([
    computeTopicLeafHash("topic-a", "config-a", "content-a"),
    computeTopicLeafHash("topic-b", "config-b", "content-b"),
  ]);
  const swapped = computeAggregatedHash([
    computeTopicLeafHash("topic-a", "config-a", "content-b"),
    computeTopicLeafHash("topic-b", "config-b", "content-a"),
  ]);
  assert.notEqual(original, swapped);
});

test("canonicalizer 拒绝 Owner/Topic 冲突与墓碑复活", () => {
  const bundle = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  for (const fixture of bundle.invalidFrames) {
    assert.throws(
      () => canonicalizeTopicFrame(fixture.input),
      (error) => error.message.includes(fixture.errorContains),
    );
  }
});

test("canonicalizer 保留完整复合 Owner 身份", () => {
  const result = canonicalizeTopicFrame({
    topicId: "shared-topic",
    ownerType: "group",
    ownerId: "group-1",
    messages: [],
  });
  assert.deepEqual(result.frame, {
    topicId: "shared-topic",
    ownerType: "group",
    ownerId: "group-1",
    messages: [],
  });
  assert.throws(
    () =>
      canonicalizeTopicFrame({
        topicId: "shared-topic",
        ownerType: "group",
        messages: [],
      }),
    /requires ownerType and ownerId together/,
  );
});

test("canonicalizer 只接受 Wire 1.2 结构化 topic 错误", () => {
  const error = {
    code: "TOPIC_NOT_FOUND",
    origin: "desktop_plugin",
    stage: "messages",
    kind: "data",
    retry: "manual",
    message: "topic not found",
    failedTopicIds: ["topic-missing"],
  };
  assert.deepEqual(
    canonicalizeTopicFrame({
      topicId: "topic-missing",
      ownerType: "agent",
      ownerId: "agent-a",
      messages: [],
      _error: error,
    }).frame,
    {
      topicId: "topic-missing",
      ownerType: "agent",
      ownerId: "agent-a",
      messages: [],
      _error: error,
    },
  );
  assert.throws(
    () => canonicalizeTopicFrame({
      topicId: "topic-missing",
      messages: [],
      _error: "legacy string error",
    }),
    /error must be an object/,
  );
  assert.throws(
    () => canonicalizeTopicFrame({
      topicId: "topic-a",
      messages: [{ id: "message-a" }],
      _error: error,
    }),
    /must not contain live messages/,
  );
});

test("分支话题消息的旧 topicId 归一化为 frame topic 而非拒绝", () => {
  // 话题分支（chatManager slice 复制）会让消息 JSON 携带旧话题的 topicId。
  // frame topic 才是存储权威、指纹不含 topicId，因此冲突必须重写而非炸批。
  const result = canonicalizeTopicFrame({
    topicId: "topic-branch",
    messages: [
      {
        id: "message-branched",
        role: "user",
        content: "branched",
        timestamp: 1700000002,
        topicId: "topic-origin",
      },
      {
        id: "message-non-string-topic",
        role: "assistant",
        content: "odd",
        timestamp: 1700000003,
        topicId: 42,
      },
      {
        id: "message-consistent",
        role: "user",
        content: "fine",
        timestamp: 1700000004,
        topicId: "topic-branch",
      },
    ],
  });
  assert.equal(result.topicIdRewrites, 2);
  assert.equal(result.topicIdRewriteSamples.length, 2);
  assert.deepEqual(
    result.frame.messages.map((message) => message.topicId),
    ["topic-branch", "topic-branch", "topic-branch"],
  );
  assert.equal(result.warningCount, 0);
});
