/**
 * WebSocket 服务
 */

const { getLogger, setWss } = require("../core/logger");
const { parseJsonWithoutDuplicateKeys } = require("../protocol");
const {
  createSyncError,
  createSyncErrorFrame,
  parseSyncError,
  withSyncErrorContext,
} = require("../error-contract");
const { TextDecoder } = require("node:util");

let WebSocket;
try {
  WebSocket = require("ws");
} catch (e) {
  console.error("[VCPMobileSync] 缺失 ws:", e.message);
}

let wss = null;
let wsServerPort = null;

function errorStageForPayload(payload, versionAccepted, currentStage) {
  if (!versionAccepted || payload?.type === "VERSION_CHECK") return "handshake";
  if (payload?.type === "SYNC_ERROR") return "shutdown";
  if (payload?.type === "SYNC_MESSAGE_DIFF_BATCH") return "messages";
  if (payload?.type === "GET_MESSAGE_MANIFEST") return "messages";
  if (
    payload?.type === "SYNC_TOPIC_HASH_BATCH" ||
    payload?.type === "SYNC_TOPIC_HASH_BATCH_V2"
  ) {
    return "topic_validation";
  }
  if (payload?.type === "SYNC_MANIFEST") {
    return ["topic", "agent_topic", "group_topic"].includes(payload.dataType)
      ? "topic_metadata"
      : "owner_metadata";
  }
  if (payload?.type === "SYNC_ENTITY_UPDATE" || payload?.type === "SYNC_ENTITY_DELETE") {
    if (payload.dataType === "message") return "messages";
    return ["topic", "agent_topic", "group_topic"].includes(payload.dataType)
      ? "topic_metadata"
      : "owner_metadata";
  }
  if (
    (payload?.type === "PHASE_START" || payload?.type === "PHASE_COMPLETED") &&
    [
      "owner_metadata",
      "topic_metadata",
      "topic_validation",
      "messages",
      "finalize",
    ].includes(payload.phase)
  ) {
    if (
      payload.type === "PHASE_COMPLETED" &&
      Number.isSafeInteger(payload.sessionId) &&
      Number.isSafeInteger(payload.attemptId) &&
      typeof payload.nonce === "string"
    ) {
      return "finalize";
    }
    return payload.phase;
  }
  return currentStage;
}

/**
 * 启动 WebSocket 服务器
 * @param {object} params
 * @param {number} params.port - 端口
 * @param {string} params.syncToken - 同步令牌
 * @param {function} params.onMessage - 消息处理回调
 * @returns {object|null} WebSocket 服务器实例
 */
function startWsServer({ port, syncToken, onMessage }) {
  if (!WebSocket) {
    const logger = getLogger();
    logger.logOperation("websocket", "init", "wsServer", "error", "WebSocket module not available");
    return null;
  }

  // 关闭旧服务
  if (wss) {
    try {
      wss.close();
    } catch {}
    wss = null;
    wsServerPort = null;
  }

  wss = new WebSocket.Server({
    host: "0.0.0.0",
    port,
    maxPayload: 32 * 1024 * 1024,
  });
  wsServerPort = port;
  setWss(wss);

  wss.on("listening", () => {
    const logger = getLogger();
    logger.logInfo("websocket", `WebSocket 同步总线已启动: ws://0.0.0.0:${port}`);
  });

  wss.on("error", (err) => {
    const logger = getLogger();
    logger.logOperation("websocket", "error", "wsServer", "error", `port=${port}, ${err.message}`);
  });

  wss.on("connection", (ws, req) => {
    const requestUrl = req?.url || "/";
    const url = new URL(
      requestUrl,
      `http://${req.headers.host || "127.0.0.1"}`,
    );
    let pathname = url.pathname;

    // 移除末尾斜杠
    if (pathname.endsWith("/") && pathname.length > 1) {
      pathname = pathname.slice(0, -1);
    }

    // 验证路径
    if (pathname !== "/" && pathname !== "/ws-sync") {
      const logger = getLogger();
      logger.logOperation("websocket", "connection", req.socket?.remoteAddress || "unknown", "warn", `unknown path: ${pathname}`);
      ws.close(1008, "Unsupported path");
      return;
    }

    // 验证令牌
    const token = url.searchParams.get("token");
    if (token !== syncToken) {
      const logger = getLogger();
      logger.logOperation("websocket", "connection", req.socket?.remoteAddress || "unknown", "warn", "unauthorized");
      ws.close(4001, "Unauthorized");
      return;
    }

    const logger = getLogger();
    logger.startSession("sync");
    logger.logOperation(
      "websocket",
      "connection",
      req.socket?.remoteAddress || "unknown",
      "success",
      `token=ok, path=${pathname}`,
    );

    let versionAccepted = false;
    let currentStage = "handshake";
    let terminated = false;
    let messageChain = Promise.resolve();
    const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

    const handleMessage = async (message) => {
      if (terminated) return;
      let payload = null;
      try {
        const text =
          typeof message === "string" ? message : utf8Decoder.decode(message);
        payload = parseJsonWithoutDuplicateKeys(text);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw createSyncError(
            "PROTOCOL_INVALID",
            "WebSocket payload must be an object",
            { stage: "handshake" },
          );
        }
        if (!versionAccepted && payload.type !== "VERSION_CHECK") {
          throw createSyncError(
            "VERSION_CHECK_REQUIRED",
            "VERSION_CHECK must be the first business frame",
          );
        }
        if (versionAccepted && payload.type === "VERSION_CHECK") {
          throw createSyncError(
            "VERSION_CHECK_DUPLICATE",
            "VERSION_CHECK may only appear once per connection",
          );
        }
        if (payload.type === "SYNC_ERROR") {
          throw withSyncErrorContext(parseSyncError(payload.error), {
            code: "MOBILE_SYNC_ERROR",
            origin: "mobile_sync",
            stage: "shutdown",
          });
        }

        const response = await onMessage(payload);
        if (payload.type === "VERSION_CHECK") {
          versionAccepted = true;
          currentStage = "startup";
        } else {
          currentStage = errorStageForPayload(
            payload,
            versionAccepted,
            currentStage,
          );
        }
        if (response) {
          const responseText = JSON.stringify(response);
          const logger = getLogger();
          // 记录发送给手机端的响应摘要
          if (response.type === "SYNC_DIFF_RESULTS" && Array.isArray(response.data)) {
            const pullItems = response.data.filter(r => r.action === "PULL");
            const pushItems = response.data.filter(r => r.action === "PUSH");
            logger.logInfo("websocket", `→ 发送 ${response.type} (dataType=${response.dataType}): total=${response.data.length}, PULL=${pullItems.length}, PUSH=${pushItems.length}, bytes=${responseText.length}`);
          } else {
            logger.logInfo("websocket", `→ 发送 ${response.type || "unknown"}: bytes=${responseText.length}`);
          }
          await new Promise((resolve, reject) => {
            ws.send(responseText, (error) => (error ? reject(error) : resolve()));
          });
        }
      } catch (e) {
        terminated = true;
        const logger = getLogger();
        const error = withSyncErrorContext(e, {
          code: "SYNC_ATTEMPT_FAILED",
          origin: "desktop_plugin",
          stage: errorStageForPayload(payload, versionAccepted, currentStage),
        });
        logger.logOperation(
          "websocket",
          "message_handler",
          error.code,
          "error",
          `origin=${error.origin} stage=${error.stage} ${error.message}`,
        );
        if (ws.readyState === WebSocket.OPEN) {
          const frame = JSON.stringify(createSyncErrorFrame(error));
          try {
            await new Promise((resolve) => ws.send(frame, resolve));
          } catch {}
          ws.close(1002, "Sync protocol failure");
        }
      }
    };

    ws.on("message", (message) => {
      messageChain = messageChain.then(() => handleMessage(message));
    });

    ws.on("close", (code, reason) => {
      terminated = true;
      const logger = getLogger();
      logger.logOperation("websocket", "disconnection", req.socket?.remoteAddress || "unknown", "info", `code=${code}`);
      logger.endSession();
    });
  });

  return wss;
}

module.exports = {
  startWsServer,
};
