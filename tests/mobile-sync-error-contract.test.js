"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");

const {
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
  stopWsServer,
  registerRoutes,
} = (() => {
  class FakeRouter {
    constructor() {
      this.layers = [];
    }

    use(...handlers) {
      this.layers.push({ method: "USE", path: null, handlers });
      return this;
    }

    get(routePath, ...handlers) {
      this.layers.push({ method: "GET", path: routePath, handlers });
      return this;
    }

    post(routePath, ...handlers) {
      this.layers.push({ method: "POST", path: routePath, handlers });
      return this;
    }
  }

  class FakeWebSocketServer extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.clients = new Set();
      queueMicrotask(() => this.emit("listening"));
    }

    address() {
      return { address: "127.0.0.1", family: "IPv4", port: this.options.port };
    }

    close(callback) {
      this.emit("close");
      if (callback) callback();
    }
  }

  const fakeExpress = {
    Router: () => new FakeRouter(),
    json: () => (_req, _res, next) => next(),
    raw: () => (_req, _res, next) => next(),
  };
  const fakeWebSocket = {
    OPEN: 1,
    Server: FakeWebSocketServer,
  };
  const originalLoad = Module._load;
  Module._load = function loadTransportDependency(request, parent, isMain) {
    if (request === "express") return fakeExpress;
    if (request === "ws") return fakeWebSocket;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const websocket = require(
      "../VCPDistributedServer/Plugin/VCPMobileSync/transport/websocket"
    );
    const routes = require(
      "../VCPDistributedServer/Plugin/VCPMobileSync/transport/routes"
    );
    return {
      startWsServer: websocket.startWsServer,
      stopWsServer: websocket.stopWsServer,
      registerRoutes: routes.registerRoutes,
    };
  } finally {
    Module._load = originalLoad;
  }
})();

const fixturePath = path.join(
  __dirname,
  "..",
  "VCPDistributedServer",
  "Plugin",
  "VCPMobileSync",
  "fixtures",
  "wire_error_contract.json",
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

function createWsFrameReader(socket) {
  const frames = [];
  let wake = null;
  socket.on("sent", (bytes) => {
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

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
  }

  send(bytes, callback) {
    this.emit("sent", bytes);
    if (callback) callback();
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate() {
    if (this.readyState !== 3) this.close(1006, "terminated");
  }
}

class FakeHttpResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headersSent = false;
    this.body = undefined;
  }

  header() {
    return this;
  }

  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  }

  json(body) {
    this.body = body;
    this.headersSent = true;
    return this;
  }
}

test("Wire errors accept only complete envelopes", () => {
  for (const entry of fixture.validErrors) {
    assert.deepEqual(parseSyncError(entry.error), entry.error);
  }
  for (const entry of fixture.invalidErrors) {
    assert.throws(() => parseSyncError(entry.error), /error/);
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
    kind: "streamError",
    error: expected,
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
  const server = await startWsServer({
    port: 0,
    syncToken: "wire-test-token",
    onMessage: async (payload) => {
      if (payload.type === "VERSION_CHECK") {
        return {
          type: "VERSION_ACK",
          pluginVersion: "1.4.0",
          protocolVersion: "1.4",
        };
      }
      throw Object.assign(new Error("owner identity conflict"), {
        code: "SYNC_OWNER_CONFLICT",
      });
    },
  });
  t.after(async () => stopWsServer());
  const socket = new FakeWebSocket();
  const nextFrame = createWsFrameReader(socket);
  t.after(() => socket.terminate());
  server.emit("connection", socket, {
    url: "/ws-sync?token=wire-test-token",
    headers: { host: "127.0.0.1" },
    socket: { remoteAddress: "127.0.0.1" },
  });

  socket.emit("message", JSON.stringify({
    type: "VERSION_CHECK",
    mobileVersion: "1.1.4",
    protocolVersion: "1.4",
  }));
  assert.equal((await nextFrame("VERSION_ACK")).type, "VERSION_ACK");

  socket.emit(
    "message",
    JSON.stringify({ type: "SYNC_TOPIC_DIFF_REQUEST", topics: [] }),
  );
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

test("HTTP route handlers return the same structured error contract", async () => {
  const app = {
    use(mountPath, router) {
      this.mountPath = mountPath;
      this.router = router;
    },
  };
  registerRoutes(app, {
    syncToken: "wire-http-token",
    appDataPath: "/unused-in-validation-test",
  });
  assert.equal(app.mountPath, "/api/mobile-sync");
  const route = app.router.layers.find(
    (layer) => layer.method === "POST" && layer.path === "/entities/pull",
  );
  const response = new FakeHttpResponse();
  await route.handlers.at(-1)(
    { body: { items: "not-an-array" }, query: {}, path: route.path },
    response,
  );
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, {
    error: {
      code: "SYNC_REQUEST_INVALID",
      origin: "desktop_plugin",
      stage: "owner_metadata",
      kind: "protocol",
      retry: "after_user_action",
      message: "items must be an array of at most 1000 entities",
      failedTopicIds: [],
    },
  });

  const parserErrorHandler = app.router.layers.find(
    (layer) => layer.method === "USE" && layer.handlers[0].length === 4,
  );
  const malformed = new FakeHttpResponse();
  parserErrorHandler.handlers[0](
    Object.assign(new SyntaxError("invalid JSON"), {
      status: 400,
      type: "entity.parse.failed",
    }),
    { body: {}, query: {}, path: route.path },
    malformed,
    (error) => {
      throw error;
    },
  );
  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(malformed.body, {
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
