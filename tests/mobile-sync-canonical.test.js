"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const {
  canonicalizeTopicFrame,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/sync/canonical");

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
  "7226118ea55766f952575032efc8cfff883a19c9d196f637ac267cb8795fcef8";

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
