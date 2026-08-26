"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const manifest = require("../VCPDistributedServer/Plugin/VCPMobileSync/plugin-manifest.json");
const {
  createPhaseAck,
  createVersionAck,
  parseJsonWithoutDuplicateKeys,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/protocol");

test("VCPMobileSync Wire 1.4 握手与插件版本对齐", () => {
  assert.equal(manifest.version, "1.4.0");
  assert.deepEqual(
    createVersionAck(
      {
        type: "VERSION_CHECK",
        mobileVersion: "1.1.4",
        protocolVersion: "1.4",
      },
      manifest.version,
    ),
    {
      type: "VERSION_ACK",
      pluginVersion: "1.4.0",
      protocolVersion: "1.4",
    },
  );
});

test("VERSION_CHECK 缺字段或协议漂移时 fail closed", () => {
  assert.throws(
    () =>
      createVersionAck(
        { type: "VERSION_CHECK", mobileVersion: "1.1.4" },
        manifest.version,
      ),
    /protocolVersion/,
  );
  assert.throws(
    () =>
      createVersionAck(
        {
          type: "VERSION_CHECK",
          mobileVersion: "1.1.4",
          protocolVersion: "1.0",
        },
        manifest.version,
      ),
    (error) => error.code === "PROTOCOL_MISMATCH",
  );
});

test("严格 JSON parser 拒绝重复 topic 与嵌套重复字段", () => {
  assert.throws(
    () =>
      parseJsonWithoutDuplicateKeys(
        '{"type":"SYNC_MESSAGE_DIFF_REQUEST","topics":[{"ownerType":"agent","ownerId":"agent-a","topicId":"topic","contentHash":"","messages":{"message":{"messageHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","updatedAt":1},"message":{"messageHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","updatedAt":2}}}]}',
      ),
    (error) => error.code === "PROTOCOL_DUPLICATE_KEY",
  );
  assert.throws(
    () => parseJsonWithoutDuplicateKeys('{"outer":{"id":"a","id":"b"}}'),
    (error) => error.code === "PROTOCOL_DUPLICATE_KEY",
  );
  assert.deepEqual(
    parseJsonWithoutDuplicateKeys('{"text":"\\u4e2d\\n文","values":[1,true,null]}'),
    { text: "中\n文", values: [1, true, null] },
  );
});

test("最终阶段 ACK 原样回显会话、attempt 与 nonce", () => {
  const payload = {
    type: "PHASE_COMPLETED",
    phase: "messages",
    sessionId: 17,
    attemptId: 4,
    nonce: "final-ack-nonce",
  };

  assert.deepEqual(createPhaseAck(payload, { echoFinalIdentity: true }), {
    type: "PHASE_ACK",
    phase: "messages",
    sessionId: 17,
    attemptId: 4,
    nonce: "final-ack-nonce",
  });
});

test("最终身份字段缺失时 fail closed", () => {
  assert.throws(
    () => createPhaseAck(
      { type: "PHASE_COMPLETED", phase: "messages", sessionId: 0 },
      { echoFinalIdentity: true },
    ),
    /requires sessionId, attemptId and nonce/,
  );
});

test("普通阶段 ACK 保持既有 phase-only 协议", () => {
  assert.deepEqual(createPhaseAck({ type: "PHASE_START", phase: "topic_metadata" }), {
    type: "PHASE_ACK",
    phase: "topic_metadata",
  });
});
