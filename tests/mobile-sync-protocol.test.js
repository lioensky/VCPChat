"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const manifest = require("../VCPDistributedServer/Plugin/VCPMobileSync/plugin-manifest.json");
const versionFixture = require(
  "../VCPDistributedServer/Plugin/VCPMobileSync/fixtures/version_handshake_contract.json"
);
const {
  createFinalPhaseAck,
  negotiateVersionCheck,
  parseJsonWithoutDuplicateKeys,
  validateSyncRequestFrame,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/protocol");

test("VCPMobileSync Wire 1.5 握手使用唯一结构化版本合同", () => {
  assert.equal(manifest.version, "1.5.0");
  const result = negotiateVersionCheck(versionFixture.versionCheck, {
    desktopPluginVersion: manifest.version,
    backendMode: "cds",
  });
  assert.deepEqual(result.ack, versionFixture.versionAck);
  assert.deepEqual(result.peer, { mobileAppVersion: "1.1.6" });
  assert.equal(
    negotiateVersionCheck(
      {
        type: "VERSION_CHECK",
        versions: [...versionFixture.versionCheck.versions].reverse(),
      },
      { desktopPluginVersion: "9.9.9", backendMode: "legacy" },
    ).ack.backendMode,
    "legacy",
  );
  assert.throws(
    () => negotiateVersionCheck(versionFixture.versionCheck, {
      desktopPluginVersion: manifest.version,
      backendMode: "fallback",
    }),
    (error) => error.code === "PROTOCOL_INVALID",
  );
});

test("VERSION_CHECK 先校验完整结构，再裁决 Wire", () => {
  assert.throws(
    () =>
      negotiateVersionCheck(
        {
          type: "VERSION_CHECK",
          mobileVersion: "1.1.6",
          protocolVersion: "1.5",
        },
        { desktopPluginVersion: manifest.version, backendMode: "legacy" },
      ),
    (error) => error.code === "VERSION_CHECK_INVALID",
  );
  assert.throws(
    () =>
      negotiateVersionCheck(
        {
          type: "VERSION_CHECK",
          versions: [
            { component: "mobile_app", version: "1.1.6" },
            { component: "wire", version: "1.4" },
          ],
        },
        { desktopPluginVersion: manifest.version, backendMode: "legacy" },
      ),
    (error) => error.code === "WIRE_VERSION_MISMATCH",
  );

  for (const versions of [
    [{ component: "wire", version: "1.4" }],
    [
      { component: "wire", version: "1.4" },
      { component: "wire", version: "1.5" },
    ],
    [
      { component: "desktop_plugin", version: "1.5.0" },
      { component: "wire", version: "1.4" },
    ],
    [
      { component: "mobile_app", version: "bad version" },
      { component: "wire", version: "1.4" },
    ],
    [
      { component: "mobile_app", version: "1".repeat(65) },
      { component: "wire", version: "1.4" },
    ],
    [
      { component: "mobile_app", version: 116 },
      { component: "wire", version: "1.4" },
    ],
    [
      { component: "mobile_app", version: "1.1.6", extra: true },
      { component: "wire", version: "1.4" },
    ],
  ]) {
    assert.throws(
      () =>
        negotiateVersionCheck(
          { type: "VERSION_CHECK", versions },
          { desktopPluginVersion: manifest.version, backendMode: "legacy" },
        ),
      (error) => error.code === "VERSION_CHECK_INVALID",
    );
  }
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

  assert.deepEqual(createFinalPhaseAck(payload), {
    type: "PHASE_ACK",
    phase: "messages",
    sessionId: 17,
    attemptId: 4,
    nonce: "final-ack-nonce",
  });
});

test("最终身份字段缺失时 fail closed", () => {
  assert.throws(
    () => createFinalPhaseAck({
      type: "PHASE_COMPLETED",
      phase: "messages",
      sessionId: 0,
    }),
    /requires sessionId, attemptId and nonce/,
  );
});

test("阶段 marker 拒绝未知 phase", () => {
  for (const payload of [
    { type: "PHASE_START", phase: "unknown" },
    { type: "PHASE_COMPLETED", phase: "unknown" },
  ]) {
    assert.throws(
      () => validateSyncRequestFrame(payload),
      (error) => error.code === "PROTOCOL_INVALID" && /phase must be/.test(error.message),
    );
  }
});
