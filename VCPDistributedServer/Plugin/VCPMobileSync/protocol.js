"use strict";

const FINAL_ACK_IDENTITY_FIELDS = ["sessionId", "attemptId", "nonce"];

/**
 * 构造阶段确认帧。
 *
 * 最终 messages 阶段必须原样回显移动端提供的会话身份；字段缺失时不伪造
 * 默认值，让移动端的精确 ACK 门禁保持 fail-closed。
 */
function createPhaseAck(payload, { echoFinalIdentity = false } = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const ack = {
    type: "PHASE_ACK",
    phase: source.phase || "owner_metadata",
  };

  if (echoFinalIdentity) {
    for (const field of FINAL_ACK_IDENTITY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(source, field)) {
        ack[field] = source[field];
      }
    }
  }

  return ack;
}

module.exports = {
  createPhaseAck,
};
