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
  "protocol_1_1_golden.json",
);
const EXPECTED_FIXTURE_SHA256 =
  "3b5f56d0731c1babede9aba001d9664117fae6bbc8d97cae56882f12a48e8e60";

test("协议 1.1 golden bundle 与 Mobile 字节一致", () => {
  const bytes = fs.readFileSync(FIXTURE_PATH);
  assert.equal(
    crypto.createHash("sha256").update(bytes).digest("hex"),
    EXPECTED_FIXTURE_SHA256,
  );
});

test("canonicalizer 与 Mobile golden 输出和消息指纹一致", () => {
  const bundle = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  assert.equal(bundle.wireProtocol, "1.1");

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
