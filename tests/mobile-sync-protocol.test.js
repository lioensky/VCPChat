"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const manifest = require("../VCPDistributedServer/Plugin/VCPMobileSync/plugin-manifest.json");
const {
  createPhaseAck,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/protocol");

test("VCPMobileSync 协议版本与移动端 1.1.0 对齐", () => {
  assert.equal(manifest.version, "1.1.0");
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

test("缺失的最终身份字段不会被默认值伪造", () => {
  assert.deepEqual(
    createPhaseAck(
      { type: "PHASE_COMPLETED", phase: "messages", sessionId: 0 },
      { echoFinalIdentity: true },
    ),
    {
      type: "PHASE_ACK",
      phase: "messages",
      sessionId: 0,
    },
  );
});

test("普通阶段 ACK 保持既有 phase-only 协议", () => {
  assert.deepEqual(createPhaseAck({ type: "PHASE_START", phase: "topic_metadata" }), {
    type: "PHASE_ACK",
    phase: "topic_metadata",
  });
});
