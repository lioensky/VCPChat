"use strict";

const assert = require("node:assert/strict");
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
  "message_canonical_contract.json",
);
test("canonicalizer 符合共享消息投影与指纹合同", () => {
  const bundle = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

  for (const fixture of bundle.validFrames) {
    const result = canonicalizeTopicFrame(fixture.input, {
      includeContentHash: false,
    });
    assert.equal(result.frame.topicId, fixture.expected.topicId);
    assert.equal(result.frame.messages.length, fixture.expected.messageCount);
    assert.equal(result.warningCount, fixture.expected.warningCount);
    assert.deepEqual(result.frame.messages, fixture.expected.canonicalMessages);
    assert.deepEqual(
      result.frame.messages.map(computeMessageFingerprint),
      fixture.expected.contentHashes,
    );
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
