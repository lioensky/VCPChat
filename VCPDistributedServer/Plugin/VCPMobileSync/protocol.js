"use strict";

const FINAL_ACK_IDENTITY_FIELDS = ["sessionId", "attemptId", "nonce"];
const WIRE_PROTOCOL_VERSION = "1.2";
const EXPECTED_PLUGIN_VERSION = "1.2.0";

function parseJsonWithoutDuplicateKeys(text) {
  if (typeof text !== "string") {
    const error = new Error("JSON frame must be text");
    error.code = "PROTOCOL_INVALID";
    throw error;
  }
  let offset = 0;
  const fail = (message, code = "PROTOCOL_INVALID") => {
    const error = new Error(`${message} at byte ${offset}`);
    error.code = code;
    throw error;
  };
  const skipWhitespace = () => {
    while (/\s/.test(text[offset] || "")) offset += 1;
  };
  const scanString = () => {
    if (text[offset] !== '"') fail("expected JSON string");
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code === 0x22) {
        offset += 1;
        return JSON.parse(text.slice(start, offset));
      }
      if (code < 0x20) fail("unescaped control character in JSON string");
      if (code === 0x5c) {
        offset += 1;
        const escape = text[offset];
        if (!'"\\/bfnrtu'.includes(escape || "")) {
          fail("invalid JSON escape");
        }
        if (escape === "u") {
          const hex = text.slice(offset + 1, offset + 5);
          if (!/^[a-f0-9]{4}$/i.test(hex)) fail("invalid Unicode escape");
          offset += 4;
        }
      }
      offset += 1;
    }
    fail("unterminated JSON string");
  };
  const scanValue = () => {
    skipWhitespace();
    const current = text[offset];
    if (current === "{") {
      offset += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        const key = scanString();
        if (keys.has(key)) {
          fail(`duplicate JSON object key ${JSON.stringify(key)}`, "PROTOCOL_DUPLICATE_KEY");
        }
        keys.add(key);
        skipWhitespace();
        if (text[offset] !== ":") fail("expected ':' after JSON object key");
        offset += 1;
        scanValue();
        skipWhitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") fail("expected ',' in JSON object");
        offset += 1;
        skipWhitespace();
      }
      fail("unterminated JSON object");
    }
    if (current === "[") {
      offset += 1;
      skipWhitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        scanValue();
        skipWhitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") fail("expected ',' in JSON array");
        offset += 1;
      }
      fail("unterminated JSON array");
    }
    if (current === '"') {
      scanString();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }
    const match = text.slice(offset).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!match) fail("invalid JSON value");
    offset += match[0].length;
  };

  scanValue();
  skipWhitespace();
  if (offset !== text.length) fail("unexpected trailing JSON data");
  return JSON.parse(text);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    const error = new Error(`${field} must be a non-empty string`);
    error.code = "PROTOCOL_INVALID";
    throw error;
  }
  return value;
}

function createVersionAck(payload, pluginVersion) {
  if (!payload || payload.type !== "VERSION_CHECK") {
    const error = new Error("expected VERSION_CHECK");
    error.code = "VERSION_CHECK_INVALID";
    throw error;
  }
  requireNonEmptyString(payload.mobileVersion, "VERSION_CHECK.mobileVersion");
  const protocolVersion = requireNonEmptyString(
    payload.protocolVersion,
    "VERSION_CHECK.protocolVersion",
  );
  if (protocolVersion !== WIRE_PROTOCOL_VERSION) {
    const error = new Error(
      `wire protocol mismatch: expected ${WIRE_PROTOCOL_VERSION}, received ${protocolVersion}`,
    );
    error.code = "PROTOCOL_MISMATCH";
    throw error;
  }
  if (pluginVersion !== EXPECTED_PLUGIN_VERSION) {
    const error = new Error(
      `plugin package mismatch: expected ${EXPECTED_PLUGIN_VERSION}, received ${pluginVersion}`,
    );
    error.code = "PLUGIN_VERSION_MISMATCH";
    throw error;
  }
  return {
    type: "VERSION_ACK",
    pluginVersion,
    protocolVersion: WIRE_PROTOCOL_VERSION,
  };
}

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
  EXPECTED_PLUGIN_VERSION,
  WIRE_PROTOCOL_VERSION,
  createPhaseAck,
  createVersionAck,
  parseJsonWithoutDuplicateKeys,
};
