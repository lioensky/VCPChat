"use strict";

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const NON_WIRE_ERROR_CODE_PREFIXES = ["ERR_", "SQLITE_"];
const PLATFORM_ERROR_CODES = new Set([
  "E2BIG",
  "EACCES",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "EAGAIN",
  "EBADF",
  "EBUSY",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EEXIST",
  "EFAULT",
  "EHOSTUNREACH",
  "EINTR",
  "EINVAL",
  "EIO",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "EMSGSIZE",
  "ENAMETOOLONG",
  "ENETDOWN",
  "ENETUNREACH",
  "ENFILE",
  "ENOBUFS",
  "ENODEV",
  "ENOENT",
  "ENOMEM",
  "ENOSPC",
  "ENOTDIR",
  "ENOTEMPTY",
  "ENOTFOUND",
  "ENOTSUP",
  "EPERM",
  "EPIPE",
  "EROFS",
  "ETIMEDOUT",
]);
const MAX_ERROR_MESSAGE_LENGTH = 1024;
const MAX_FAILED_TOPIC_IDS = 8;
const ERROR_FIELDS = new Set([
  "code",
  "origin",
  "stage",
  "kind",
  "retry",
  "message",
  "failedTopicIds",
]);

const ERROR_ORIGINS = new Set([
  "mobile_ui",
  "mobile_native",
  "mobile_sync",
  "desktop_plugin",
  "desktop_cds",
]);

const ERROR_STAGES = new Set([
  "preflight",
  "startup",
  "connect",
  "handshake",
  "owner_metadata",
  "topic_metadata",
  "topic_validation",
  "messages",
  "finalize",
  "shutdown",
  "history",
]);

const ERROR_KINDS = new Set([
  "device",
  "configuration",
  "connection",
  "compatibility",
  "protocol",
  "data",
  "storage",
  "internal",
]);

const ERROR_RETRIES = new Set([
  "automatic",
  "after_user_action",
  "manual",
  "never",
]);

const definition = (stage, kind, retry, origin = "desktop_plugin") =>
  Object.freeze({ origin, stage, kind, retry });

// Exact-code registry. A code describes the cause; stage/origin may still be
// narrowed by the boundary that catches it. No substring classification is used.
const ERROR_DEFINITIONS = Object.freeze({
  POWER_SAVE_MODE: definition("preflight", "device", "after_user_action", "mobile_native"),
  BATTERY_TOO_LOW: definition("preflight", "device", "after_user_action", "mobile_native"),
  SYNC_ATTEMPT_FAILED: definition("startup", "internal", "manual"),
  CDS_ERROR: definition("startup", "internal", "manual", "desktop_cds"),
  CDS_PROTOCOL_MISMATCH: definition("startup", "compatibility", "after_user_action", "desktop_cds"),
  INVALID_CONFIGURATION: definition("startup", "configuration", "after_user_action", "desktop_cds"),
  INVALID_RESPONSE: definition("startup", "protocol", "after_user_action", "desktop_cds"),
  RESPONSE_TOO_LARGE: definition("messages", "data", "after_user_action", "desktop_cds"),
  CANCELLED: definition("shutdown", "internal", "never", "desktop_cds"),
  TIMEOUT: definition("connect", "connection", "manual", "desktop_cds"),
  UNAVAILABLE: definition("connect", "connection", "manual", "desktop_cds"),
  HTTP_ERROR: definition("connect", "connection", "manual", "desktop_cds"),
  HEALTH_CHECK_FAILED: definition("startup", "connection", "manual", "desktop_cds"),
  SYNC_PHASE_STALLED: definition("topic_metadata", "internal", "manual", "mobile_sync"),
  SYNC_PREVIOUS_SESSION_EXIT_FAILED: definition("shutdown", "internal", "manual", "mobile_sync"),
  SYNC_DB_DRAIN_FAILED: definition("finalize", "storage", "manual", "mobile_sync"),
  PROTOCOL_INVALID: definition("handshake", "protocol", "after_user_action"),
  PROTOCOL_DUPLICATE_KEY: definition("handshake", "protocol", "after_user_action"),
  VERSION_CHECK_REQUIRED: definition("handshake", "protocol", "after_user_action"),
  VERSION_CHECK_DUPLICATE: definition("handshake", "protocol", "after_user_action"),
  VERSION_CHECK_INVALID: definition("handshake", "protocol", "after_user_action"),
  VERSION_ACK_INVALID: definition("handshake", "protocol", "after_user_action", "mobile_sync"),
  SYNC_VERSION_INCOMPATIBLE: definition("handshake", "compatibility", "after_user_action"),
  VERSION_CHECK_TIMEOUT: definition("handshake", "connection", "manual", "mobile_sync"),
  MANIFEST_RESPONSE_TIMEOUT: definition("owner_metadata", "connection", "manual", "mobile_sync"),
  TOPIC_HASH_RESPONSE_TIMEOUT: definition("topic_validation", "connection", "manual", "mobile_sync"),
  FINAL_ACK_TIMEOUT: definition("finalize", "connection", "manual", "mobile_sync"),
  PROTOCOL_MISMATCH: definition("handshake", "compatibility", "after_user_action"),
  PLUGIN_VERSION_MISMATCH: definition("handshake", "compatibility", "after_user_action"),
  MOBILE_SYNC_ERROR: definition("shutdown", "internal", "manual", "mobile_sync"),
  SYNC_PROTOCOL_INVALID: definition("owner_metadata", "protocol", "after_user_action"),
  SYNC_BUDGET_EXCEEDED: definition("messages", "data", "after_user_action"),
  SYNC_INDEX_INVALID: definition("topic_metadata", "storage", "manual"),
  SYNC_DB_UNAVAILABLE: definition("startup", "storage", "manual"),
  SYNC_DB_QUERY_FAILED: definition("topic_validation", "storage", "manual"),
  TOPIC_HASH_FAILED: definition("messages", "storage", "manual", "desktop_cds"),
  MESSAGE_MANIFEST_FAILED: definition("messages", "storage", "manual", "desktop_cds"),
  SYNC_OWNER_CONFLICT: definition("topic_metadata", "data", "manual"),
  SYNC_ENTITY_NOT_FOUND: definition("owner_metadata", "data", "manual"),
  SYNC_DELETE_INVALID: definition("messages", "protocol", "after_user_action"),
  SYNC_DELETE_FAILED: definition("messages", "storage", "manual"),
  HISTORY_SOURCE_INVALID: definition("messages", "data", "after_user_action"),
  MESSAGE_DIFF_FAILED: definition("messages", "storage", "manual"),
  TOPIC_NOT_FOUND: definition("messages", "data", "manual"),
  ATTACHMENT_PATH_INVALID: definition("messages", "storage", "after_user_action"),
  MOBILE_ATTACHMENT_INVALID: definition("messages", "data", "after_user_action"),
  CDS_UNAVAILABLE: definition("startup", "internal", "manual", "desktop_cds"),
  INVALID_REQUEST: definition("startup", "protocol", "after_user_action", "desktop_cds"),
  UNAUTHORIZED: definition("connect", "configuration", "after_user_action", "desktop_cds"),
  NOT_FOUND: definition("startup", "data", "manual", "desktop_cds"),
  AMBIGUOUS_IDENTITY: definition("startup", "data", "manual", "desktop_cds"),
  SEARCH_UNAVAILABLE: definition("startup", "storage", "manual", "desktop_cds"),
  INTERNAL_ERROR: definition("startup", "internal", "manual", "desktop_cds"),
  SERVICE_BUSY: definition("startup", "connection", "manual", "desktop_cds"),
  SYNC_AUTH_FAILED: definition("connect", "configuration", "after_user_action"),
  SYNC_REQUEST_INVALID: definition("connect", "protocol", "after_user_action"),
  SYNC_ENTITY_READ_FAILED: definition("owner_metadata", "storage", "manual"),
  SYNC_ENTITY_WRITE_FAILED: definition("owner_metadata", "storage", "manual"),
  SYNC_ENTITY_BATCH_FAILED: definition("topic_metadata", "storage", "manual"),
  SYNC_MESSAGE_READ_FAILED: definition("messages", "storage", "manual"),
  SYNC_MESSAGE_WRITE_FAILED: definition("messages", "storage", "manual"),
  SYNC_STREAM_FAILED: definition("messages", "connection", "manual"),
  SYNC_ATTACHMENT_NOT_FOUND: definition("messages", "data", "manual"),
  SYNC_ATTACHMENT_READ_FAILED: definition("messages", "storage", "manual"),
  SYNC_ATTACHMENT_WRITE_FAILED: definition("messages", "storage", "manual"),
  SYNC_AVATAR_NOT_FOUND: definition("owner_metadata", "data", "manual"),
  SYNC_AVATAR_READ_FAILED: definition("owner_metadata", "storage", "manual"),
  SYNC_AVATAR_WRITE_FAILED: definition("owner_metadata", "storage", "manual"),
  SYNC_CHANGE_FEED_UNAVAILABLE: definition("history", "configuration", "after_user_action"),
  SYNC_CHANGE_FEED_FAILED: definition("history", "storage", "manual"),
});

function cleanMessage(value, fallback = "Desktop sync failed") {
  const safeFallback = typeof fallback === "string" && fallback.trim().length > 0
    ? fallback
    : "Desktop sync failed";
  const source = typeof value === "string" && value.trim().length > 0
    ? value
    : safeFallback;
  const redacted = source
    .replace(/\b(Bearer\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, "$1[redacted]")
    .replace(
      /(\b(?:token|x[_-]?sync[_-]?token|sync[_-]?token|access[_-]?token|api[_-]?key|vcp[_-]?key|secret|password)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&#]+)/gi,
      "$1[redacted]",
    )
    .replace(
      /([?&](?:token|sync(?:[_-]|%5f)?token|access(?:[_-]|%5f)?token|api(?:[_-]|%5f)?key|vcp(?:[_-]|%5f)?key|secret|password)=)[^&#\s]*/gi,
      "$1[redacted]",
    )
    .replace(/[A-Za-z]:[\\/][^\s"'<>|]+/g, "[path]");
  return Array.from(redacted
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim())
    .slice(0, MAX_ERROR_MESSAGE_LENGTH)
    .join("");
}

function codePointLength(value) {
  return Array.from(value).length;
}

function validEnum(value, allowed) {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function validWireCode(value) {
  return typeof value === "string" &&
    ERROR_CODE_PATTERN.test(value) &&
    !PLATFORM_ERROR_CODES.has(value) &&
    !value.startsWith("EAI_") &&
    !NON_WIRE_ERROR_CODE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function boundedTopicIds(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const id of value) {
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      codePointLength(id) > 512 ||
      seen.has(id)
    ) {
      continue;
    }
    seen.add(id);
    result.push(id);
    if (result.length === MAX_FAILED_TOPIC_IDS) break;
  }
  return result;
}

function normalizeSyncError(error, fallback = {}) {
  const source = error && typeof error === "object" ? error : {};
  const sourceMessage = typeof error === "string" ? error : source.message;
  const fallbackCode = validWireCode(fallback.code)
    ? fallback.code
    : "SYNC_ATTEMPT_FAILED";
  const code = validWireCode(source.code)
    ? source.code
    : fallbackCode;
  const registered = ERROR_DEFINITIONS[code] || {};

  return {
    code,
    origin:
      validEnum(source.origin, ERROR_ORIGINS) ||
      validEnum(fallback.origin, ERROR_ORIGINS) ||
      registered.origin ||
      "desktop_plugin",
    stage:
      validEnum(source.stage, ERROR_STAGES) ||
      validEnum(fallback.stage, ERROR_STAGES) ||
      registered.stage ||
      "startup",
    kind:
      registered.kind ||
      validEnum(source.kind, ERROR_KINDS) ||
      validEnum(fallback.kind, ERROR_KINDS) ||
      "internal",
    retry:
      registered.retry ||
      validEnum(source.retry, ERROR_RETRIES) ||
      validEnum(fallback.retry, ERROR_RETRIES) ||
      "manual",
    message: cleanMessage(sourceMessage, fallback.message),
    failedTopicIds: boundedTopicIds([
      ...(Array.isArray(source.failedTopicIds) ? source.failedTopicIds : []),
      ...(Array.isArray(fallback.failedTopicIds) ? fallback.failedTopicIds : []),
    ]),
  };
}

function parseSyncError(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createSyncError("PROTOCOL_INVALID", "error must be an object", {
      stage: "handshake",
    });
  }
  if (!validWireCode(value.code)) {
    throw createSyncError("PROTOCOL_INVALID", "error.code is invalid", {
      stage: "handshake",
    });
  }
  if (Object.keys(value).some((key) => !ERROR_FIELDS.has(key))) {
    throw createSyncError("PROTOCOL_INVALID", "error contains unknown fields", {
      stage: "handshake",
    });
  }
  if (!validEnum(value.origin, ERROR_ORIGINS)) {
    throw createSyncError("PROTOCOL_INVALID", "error.origin is invalid", {
      stage: "handshake",
    });
  }
  if (!validEnum(value.stage, ERROR_STAGES)) {
    throw createSyncError("PROTOCOL_INVALID", "error.stage is invalid", {
      stage: "handshake",
    });
  }
  if (!validEnum(value.kind, ERROR_KINDS)) {
    throw createSyncError("PROTOCOL_INVALID", "error.kind is invalid", {
      stage: "handshake",
    });
  }
  if (!validEnum(value.retry, ERROR_RETRIES)) {
    throw createSyncError("PROTOCOL_INVALID", "error.retry is invalid", {
      stage: "handshake",
    });
  }
  if (
    typeof value.message !== "string" ||
    value.message.trim().length === 0 ||
    codePointLength(value.message) > MAX_ERROR_MESSAGE_LENGTH
  ) {
    throw createSyncError("PROTOCOL_INVALID", "error.message is invalid", {
      stage: "handshake",
    });
  }
  if (
    !Array.isArray(value.failedTopicIds) ||
      value.failedTopicIds.length > MAX_FAILED_TOPIC_IDS ||
      value.failedTopicIds.some(
        (id) =>
          typeof id !== "string" ||
          id.length === 0 ||
          codePointLength(id) > 512,
      ) ||
      new Set(value.failedTopicIds).size !== value.failedTopicIds.length
  ) {
    throw createSyncError("PROTOCOL_INVALID", "error.failedTopicIds is invalid", {
      stage: "handshake",
    });
  }
  const registered = ERROR_DEFINITIONS[value.code];
  if (
    registered &&
    (value.kind !== registered.kind || value.retry !== registered.retry)
  ) {
    throw createSyncError(
      "PROTOCOL_INVALID",
      "error.kind or error.retry conflicts with its registered code",
      { stage: "handshake" },
    );
  }
  return normalizeSyncError(value);
}

function createSyncError(code, message, context = {}) {
  const normalized = normalizeSyncError(
    { ...context, code, message },
    context,
  );
  const error = new Error(normalized.message);
  Object.assign(error, normalized);
  return error;
}

function withSyncErrorContext(error, fallback = {}) {
  const normalized = normalizeSyncError(error, fallback);
  // This helper is used at a boundary that knows where the failure was
  // observed. Keep root code/kind/retry, but let that boundary narrow the two
  // contextual dimensions even when an inner layer supplied broader values.
  const boundaryOrigin = validEnum(fallback.origin, ERROR_ORIGINS);
  const boundaryStage = validEnum(fallback.stage, ERROR_STAGES);
  if (boundaryOrigin) normalized.origin = boundaryOrigin;
  if (boundaryStage) normalized.stage = boundaryStage;
  const target = error instanceof Error ? error : new Error(normalized.message);
  target.message = normalized.message;
  Object.assign(target, normalized);
  return target;
}

function createSyncErrorFrame(error, fallback = {}) {
  return {
    type: "SYNC_ERROR",
    error: normalizeSyncError(error, fallback),
  };
}

function createHttpErrorBody(error, fallback = {}) {
  return { error: normalizeSyncError(error, fallback) };
}

function createStreamErrorFrame(error, fallback = {}) {
  return { _stream_error: normalizeSyncError(error, fallback) };
}

function normalizeFailureResult(result, fallback = {}) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    result.success !== false
  ) {
    return result;
  }
  return {
    ...result,
    error: normalizeSyncError(result.error, fallback),
  };
}

module.exports = {
  ERROR_DEFINITIONS,
  ERROR_KINDS,
  ERROR_ORIGINS,
  ERROR_RETRIES,
  ERROR_STAGES,
  createHttpErrorBody,
  createStreamErrorFrame,
  createSyncError,
  createSyncErrorFrame,
  normalizeFailureResult,
  normalizeSyncError,
  parseSyncError,
  withSyncErrorContext,
};
