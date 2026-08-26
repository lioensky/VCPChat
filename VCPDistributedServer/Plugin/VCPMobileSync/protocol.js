"use strict";

const FINAL_ACK_IDENTITY_FIELDS = ["sessionId", "attemptId", "nonce"];
const WIRE_PROTOCOL_VERSION = "1.4";
const SYNC_PHASES = new Set(["owner_metadata", "topic_metadata", "messages"]);

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

function requireExactKeys(payload, fields, label) {
  const expected = new Set(fields);
  const actual = Object.keys(payload);
  if (
    actual.length !== expected.size ||
    actual.some((field) => !expected.has(field))
  ) {
    const error = new Error(`${label} has unexpected or missing fields`);
    error.code = "PROTOCOL_INVALID";
    throw error;
  }
}

function validateSyncRequestFrame(payload) {
  switch (payload.type) {
    case "VERSION_CHECK":
      requireExactKeys(
        payload,
        ["type", "mobileVersion", "protocolVersion"],
        payload.type,
      );
      break;
    case "PHASE_START":
      requireExactKeys(payload, ["type", "phase"], payload.type);
      break;
    case "PHASE_COMPLETED":
      requireExactKeys(
        payload,
        payload.phase === "messages"
          ? ["type", "phase", "sessionId", "attemptId", "nonce"]
          : ["type", "phase"],
        payload.type,
      );
      break;
    case "SYNC_MANIFEST_REQUEST":
      if (!["owner", "topic", "avatar"].includes(payload.manifestType)) {
        throw Object.assign(new Error("Invalid manifestType"), {
          code: "PROTOCOL_INVALID",
        });
      }
      requireExactKeys(
        payload,
        payload.manifestType === "topic"
          ? ["type", "manifestType", "items", "targetedOwners"]
          : ["type", "manifestType", "items"],
        payload.type,
      );
      break;
    case "SYNC_TOPIC_DIFF_REQUEST":
    case "SYNC_MESSAGE_DIFF_REQUEST":
      requireExactKeys(payload, ["type", "topics"], payload.type);
      break;
    case "SYNC_ENTITY_DELETE": {
      const fields = {
        owner: ["type", "targetType", "ownerType", "ownerId", "deletedAt"],
        topic: [
          "type",
          "targetType",
          "ownerType",
          "ownerId",
          "topicId",
          "deletedAt",
        ],
        avatar: ["type", "targetType", "ownerType", "ownerId", "deletedAt"],
        message: [
          "type",
          "targetType",
          "ownerType",
          "ownerId",
          "topicId",
          "msgId",
          "deletedAt",
        ],
      }[payload.targetType];
      if (!fields) {
        throw Object.assign(new Error("Invalid delete targetType"), {
          code: "PROTOCOL_INVALID",
        });
      }
      requireExactKeys(payload, fields, payload.type);
      break;
    }
    case "SYNC_ERROR":
      requireExactKeys(payload, ["type", "error"], payload.type);
      break;
    default:
      break;
  }
  return payload;
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
  requireNonEmptyString(pluginVersion, "pluginVersion");
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
  if (!SYNC_PHASES.has(source.phase)) {
    const error = new Error("phase must be owner_metadata, topic_metadata or messages");
    error.code = "PROTOCOL_INVALID";
    throw error;
  }
  const ack = {
    type: "PHASE_ACK",
    phase: source.phase,
  };

  if (echoFinalIdentity) {
    if (source.phase === "messages") {
      if (
        !Number.isSafeInteger(source.sessionId) ||
        !Number.isSafeInteger(source.attemptId) ||
        typeof source.nonce !== "string" ||
        source.nonce.length === 0
      ) {
        const error = new Error(
          "messages PHASE_COMPLETED requires sessionId, attemptId and nonce",
        );
        error.code = "PROTOCOL_INVALID";
        throw error;
      }
    }
    for (const field of FINAL_ACK_IDENTITY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(source, field)) {
        ack[field] = source[field];
      }
    }
  }

  return ack;
}

module.exports = {
  WIRE_PROTOCOL_VERSION,
  createPhaseAck,
  createVersionAck,
  parseJsonWithoutDuplicateKeys,
  validateSyncRequestFrame,
};
