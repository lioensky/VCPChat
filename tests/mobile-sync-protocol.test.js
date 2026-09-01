"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const manifest = require("../VCPDistributedServer/Plugin/VCPMobileSync/plugin-manifest.json");
const {
  createPhaseAck,
  createVersionAck,
  parseJsonWithoutDuplicateKeys,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/protocol");

test("VCPMobileSync Wire 1.5 握手声明插件版本与桌面后端", () => {
  assert.equal(manifest.version, "1.5.0");
  assert.deepEqual(
    createVersionAck(
      {
        type: "VERSION_CHECK",
        mobileVersion: "1.1.6",
        protocolVersion: "1.5",
      },
      manifest.version,
      "cds",
    ),
    {
      type: "VERSION_ACK",
      pluginVersion: "1.5.0",
      protocolVersion: "1.5",
      backendMode: "cds",
    },
  );
  assert.equal(
    createVersionAck(
      {
        type: "VERSION_CHECK",
        mobileVersion: "1.1.6",
        protocolVersion: "1.5",
      },
      manifest.version,
      "legacy",
    ).backendMode,
    "legacy",
  );
  assert.throws(
    () => createVersionAck(
      {
        type: "VERSION_CHECK",
        mobileVersion: "1.1.6",
        protocolVersion: "1.5",
      },
      manifest.version,
      "fallback",
    ),
    (error) => error.code === "PROTOCOL_INVALID",
  );
});

test("VERSION_CHECK 缺字段或协议漂移时 fail closed", () => {
  assert.throws(
    () =>
      createVersionAck(
        { type: "VERSION_CHECK", mobileVersion: "1.1.4" },
        manifest.version,
        "legacy",
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
        "legacy",
      ),
    (error) => error.code === "PROTOCOL_MISMATCH",
  );
});

test("CDS Rust 与 Electron lifecycle 的 protocol/schema 常量一致", () => {
  const root = path.resolve(__dirname, "..");
  const rust = fs.readFileSync(
    path.join(root, "rust_chat_data_service", "src", "config.rs"),
    "utf8",
  );
  const lifecycle = fs.readFileSync(
    path.join(root, "modules", "services", "chatDataService", "lifecycle.js"),
    "utf8",
  );
  const rustProtocol = rust.match(/PROTOCOL_VERSION: u32 = (\d+)/)?.[1];
  const rustSchema = rust.match(/SCHEMA_VERSION: u32 = (\d+)/)?.[1];
  const jsProtocol = lifecycle.match(/PROTOCOL_VERSION = (\d+)/)?.[1];
  const jsSchema = lifecycle.match(/SCHEMA_VERSION = (\d+)/)?.[1];
  assert.ok(rustProtocol && rustSchema && jsProtocol && jsSchema);
  assert.equal(jsProtocol, rustProtocol);
  assert.equal(jsSchema, rustSchema);
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
