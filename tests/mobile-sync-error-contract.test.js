"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const express = require("express");
const WebSocket = require("ws");

const {
  ERROR_DEFINITIONS,
  createHttpErrorBody,
  createStreamErrorFrame,
  createSyncError,
  createSyncErrorFrame,
  normalizeFailureResult,
  normalizeSyncError,
  parseSyncError,
  withSyncErrorContext,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/error-contract");
const {
  startWsServer,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/transport/websocket");
const {
  registerRoutes,
} = require("../VCPDistributedServer/Plugin/VCPMobileSync/transport/routes");

const fixturePath = path.join(
  __dirname,
  "..",
  "VCPDistributedServer",
  "Plugin",
  "VCPMobileSync",
  "fixtures",
  "error_contract_1_2_golden.json",
);
const fixtureBytes = fs.readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes);

function createWsFrameReader(socket) {
  const frames = [];
  let wake = null;
  socket.on("message", (bytes) => {
    frames.push(JSON.parse(String(bytes)));
    if (wake) {
      const resolve = wake;
      wake = null;
      resolve();
    }
  });
  return async (type) => {
    for (;;) {
      const index = frames.findIndex((frame) => frame.type === type);
      if (index >= 0) return frames.splice(index, 1)[0];
      await new Promise((resolve) => {
        wake = resolve;
      });
    }
  };
}

test("Wire 1.2 golden errors are strict and stable", () => {
  assert.equal(fixture.wireProtocol, "1.2");
  assert.equal(fixture.pluginVersion, "1.2.0");
  assert.equal(
    crypto.createHash("sha256").update(fixtureBytes).digest("hex"),
    "434279b33a86a2206c1e4f47caccb4e72f05b2f9d48e093af95d5ebae6947adb",
  );
  for (const entry of fixture.validErrors) {
    assert.deepEqual(parseSyncError(entry.error), entry.error);
  }
  for (const entry of fixture.invalidErrors) {
    assert.throws(() => parseSyncError(entry.error), /error/);
  }
  for (const [code, [kind, retry]] of Object.entries(fixture.registeredSemantics)) {
    assert.deepEqual(
      [ERROR_DEFINITIONS[code]?.kind, ERROR_DEFINITIONS[code]?.retry],
      [kind, retry],
      `registered semantics for ${code}`,
    );
  }
});

test("WebSocket, HTTP and NDJSON reuse the same error object", () => {
  const error = createSyncError("PLUGIN_VERSION_MISMATCH", "wrong package");
  const expected = normalizeSyncError(error);
  assert.deepEqual(createSyncErrorFrame(error), {
    type: "SYNC_ERROR",
    error: expected,
  });
  assert.deepEqual(createHttpErrorBody(error), { error: expected });
  assert.deepEqual(createStreamErrorFrame(error), {
    _stream_error: expected,
  });
  assert.deepEqual(
    normalizeFailureResult(
      { topicId: "topic-a", success: false, error: "query failed" },
      {
        code: "SYNC_DB_QUERY_FAILED",
        stage: "messages",
        failedTopicIds: ["topic-a"],
      },
    ),
    {
      topicId: "topic-a",
      success: false,
      error: {
        code: "SYNC_DB_QUERY_FAILED",
        origin: "desktop_plugin",
        stage: "messages",
        kind: "storage",
        retry: "manual",
        message: "query failed",
        failedTopicIds: ["topic-a"],
      },
    },
  );
});

test("catch boundaries preserve an existing root code and narrow its stage", () => {
  const root = Object.assign(new Error("owner conflict"), {
    code: "SYNC_OWNER_CONFLICT",
    origin: "desktop_plugin",
    stage: "topic_metadata",
  });
  const contextual = withSyncErrorContext(root, {
    code: "SYNC_DB_QUERY_FAILED",
    origin: "desktop_cds",
    stage: "topic_validation",
  });
  assert.equal(contextual.code, "SYNC_OWNER_CONFLICT");
  assert.equal(contextual.origin, "desktop_cds");
  assert.equal(contextual.stage, "topic_validation");
  assert.equal(contextual.kind, "data");
  assert.deepEqual(
    normalizeSyncError(
      {
        code: "SYNC_OWNER_CONFLICT",
        message: "root",
        failedTopicIds: [],
      },
      { failedTopicIds: ["topic-a"] },
    ).failedTopicIds,
    ["topic-a"],
  );
});

test("exact registry keeps device, version, lifecycle and storage layers separate", () => {
  const cases = [
    ["POWER_SAVE_MODE", "mobile_native", "preflight", "device"],
    ["VERSION_ACK_INVALID", "mobile_sync", "handshake", "protocol"],
    ["SYNC_VERSION_INCOMPATIBLE", "desktop_plugin", "handshake", "compatibility"],
    ["SYNC_PHASE_STALLED", "mobile_sync", "topic_metadata", "internal"],
    ["SYNC_DB_DRAIN_FAILED", "mobile_sync", "finalize", "storage"],
  ];

  for (const [code, origin, stage, kind] of cases) {
    assert.deepEqual(
      normalizeSyncError({ code, message: "diagnostic" }),
      {
        code,
        origin,
        stage,
        kind,
        retry: code === "POWER_SAVE_MODE" || code.includes("VERSION_")
          ? "after_user_action"
          : "manual",
        message: "diagnostic",
        failedTopicIds: [],
      },
    );
  }
});

test("timeout registry preserves the phase that actually timed out", () => {
  const cases = [
    ["VERSION_CHECK_TIMEOUT", "handshake"],
    ["MANIFEST_RESPONSE_TIMEOUT", "owner_metadata"],
    ["TOPIC_HASH_RESPONSE_TIMEOUT", "topic_validation"],
    ["PHASE3_RESPONSE_TIMEOUT", "messages"],
    ["FINAL_ACK_TIMEOUT", "finalize"],
  ];

  for (const [code, stage] of cases) {
    const error = normalizeSyncError({ code, message: "timeout" });
    assert.equal(error.kind, "connection");
    assert.equal(error.stage, stage);
  }
});

test("unknown stable codes survive while invalid codes use the boundary fallback", () => {
  assert.equal(
    normalizeSyncError(
      { code: "EXTENSIONFAILED", message: "unknown" },
      { stage: "finalize" },
    ).code,
    "EXTENSIONFAILED",
  );
  assert.equal(
    normalizeSyncError(
      { code: "UPSTREAM_EXTENSION_FAILED", message: "unknown" },
      { stage: "finalize" },
    ).code,
    "UPSTREAM_EXTENSION_FAILED",
  );
  assert.equal(
    normalizeSyncError(
      { code: "desktop raw code", message: "invalid" },
      { code: "SYNC_STREAM_FAILED", stage: "messages" },
    ).code,
    "SYNC_STREAM_FAILED",
  );
  assert.equal(
    normalizeSyncError(
      Object.assign(new Error("file missing"), { code: "ENOENT" }),
      { code: "SYNC_ENTITY_READ_FAILED", stage: "owner_metadata" },
    ).code,
    "SYNC_ENTITY_READ_FAILED",
  );
  const redacted = normalizeSyncError({
    code: "UPSTREAM_EXTENSION_FAILED",
    message: "Bearer desktop-secret token=second-secret C:\\Users\\Nova\\AppData\\history.json",
  }).message;
  assert.equal(redacted.includes("desktop-secret"), false);
  assert.equal(redacted.includes("second-secret"), false);
  assert.equal(redacted.includes("Nova"), false);
});

test("known codes cannot claim a different category or retry policy", () => {
  assert.throws(
    () => parseSyncError({
      code: "POWER_SAVE_MODE",
      origin: "mobile_native",
      stage: "preflight",
      kind: "compatibility",
      retry: "after_user_action",
      message: "wrong category",
      failedTopicIds: [],
    }),
    /conflicts with its registered code/,
  );
});

test("string bounds count Unicode code points consistently with Rust", () => {
  const valid = {
    code: "UPSTREAM_EXTENSION_FAILED",
    origin: "desktop_plugin",
    stage: "messages",
    kind: "internal",
    retry: "manual",
    message: "🙂".repeat(1024),
    failedTopicIds: ["🙂".repeat(512)],
  };
  assert.deepEqual(parseSyncError(valid), valid);
  assert.throws(
    () => parseSyncError({ ...valid, message: "🙂".repeat(1025) }),
    /message/,
  );
});

test("WebSocket transport emits the complete root-cause error envelope", async (t) => {
  const server = startWsServer({
    port: 0,
    syncToken: "wire-1.2-test-token",
    onMessage: async (payload) => {
      if (payload.type === "VERSION_CHECK") {
        return {
          type: "VERSION_ACK",
          pluginVersion: "1.2.0",
          protocolVersion: "1.2",
        };
      }
      throw Object.assign(new Error("owner identity conflict"), {
        code: "SYNC_OWNER_CONFLICT",
      });
    },
  });
  t.after(() => server.close());
  if (!server.address()) await once(server, "listening");
  const port = server.address().port;
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/ws-sync?token=wire-1.2-test-token`,
  );
  const nextFrame = createWsFrameReader(socket);
  t.after(() => socket.terminate());
  await once(socket, "open");

  socket.send(JSON.stringify({
    type: "VERSION_CHECK",
    mobileVersion: "1.1.4",
    protocolVersion: "1.2",
  }));
  assert.equal((await nextFrame("VERSION_ACK")).type, "VERSION_ACK");

  socket.send(JSON.stringify({ type: "SYNC_TOPIC_HASH_BATCH", hashes: {} }));
  assert.deepEqual(await nextFrame("SYNC_ERROR"), {
    type: "SYNC_ERROR",
    error: {
      code: "SYNC_OWNER_CONFLICT",
      origin: "desktop_plugin",
      stage: "topic_validation",
      kind: "data",
      retry: "manual",
      message: "owner identity conflict",
      failedTopicIds: [],
    },
  });
});

test("HTTP transport returns the same structured error contract", async (t) => {
  const app = express();
  registerRoutes(app, {
    syncToken: "wire-1.2-http-token",
    appDataPath: "/unused-in-validation-test",
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const port = server.address().port;

  const response = await fetch(
    `http://127.0.0.1:${port}/api/mobile-sync/download-entities`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sync-token": "wire-1.2-http-token",
      },
      body: JSON.stringify({ requests: "not-an-array" }),
    },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      code: "SYNC_REQUEST_INVALID",
      origin: "desktop_plugin",
      stage: "owner_metadata",
      kind: "protocol",
      retry: "after_user_action",
      message: "requests must be an array of at most 10000 items",
      failedTopicIds: [],
    },
  });

  const malformed = await fetch(
    `http://127.0.0.1:${port}/api/mobile-sync/download-entities`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sync-token": "wire-1.2-http-token",
      },
      body: "{not-json",
    },
  );
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), {
    error: {
      code: "SYNC_REQUEST_INVALID",
      origin: "desktop_plugin",
      stage: "owner_metadata",
      kind: "protocol",
      retry: "after_user_action",
      message: "Request body is not valid JSON",
      failedTopicIds: [],
    },
  });
});
