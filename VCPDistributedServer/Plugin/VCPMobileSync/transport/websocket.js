/**
 * WebSocket 服务
 */

const { getLogger, setWss } = require("../core/logger");
const { parseJsonWithoutDuplicateKeys } = require("../protocol");

let WebSocket;
try {
  WebSocket = require("ws");
} catch (e) {
  console.error("[VCPMobileSync] 缺失 ws:", e.message);
}

let wss = null;
let wsServerPort = null;

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
    let messageChain = Promise.resolve();

    const handleMessage = async (message) => {
      try {
        const text =
          typeof message === "string" ? message : message.toString("utf8");
        const payload = parseJsonWithoutDuplicateKeys(text);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          const error = new Error("WebSocket payload must be an object");
          error.code = "PROTOCOL_INVALID";
          throw error;
        }
        if (!versionAccepted && payload.type !== "VERSION_CHECK") {
          const error = new Error("VERSION_CHECK must be the first business frame");
          error.code = "VERSION_CHECK_REQUIRED";
          throw error;
        }
        if (versionAccepted && payload.type === "VERSION_CHECK") {
          const error = new Error("VERSION_CHECK may only appear once per connection");
          error.code = "VERSION_CHECK_DUPLICATE";
          throw error;
        }
        if (payload.type === "SYNC_ERROR") {
          const code = payload.error?.code;
          const message = payload.error?.message;
          const error = new Error(
            typeof message === "string" && message.length > 0
              ? message
              : "Mobile reported a sync failure",
          );
          error.code =
            typeof code === "string" && code.length > 0
              ? code
              : "MOBILE_SYNC_ERROR";
          throw error;
        }

        const response = await onMessage(payload);
        if (payload.type === "VERSION_CHECK") versionAccepted = true;
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
        const logger = getLogger();
        logger.logOperation("websocket", "message_handler", "error", "error", e.message);
        if (ws.readyState === WebSocket.OPEN) {
          const frame = JSON.stringify({
            type: "SYNC_ERROR",
            error: {
              code: e.code || "SYNC_ATTEMPT_FAILED",
              message: e.message || "Desktop sync failed",
            },
          });
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
