/**
 * HTTP 路由注册
 */

const express = require("express");
const { getDb } = require("../core/db");
const { checkIdempotency, recordOperation } = require("../core/idempotency");
const {
  handleSyncManifest,
  handleMessageManifest,
} = require("../sync/manifest");
const {
  downloadEntity,
  downloadEntities,
  uploadEntity,
  uploadEntitiesBatch,
  downloadAvatar,
  uploadAvatar,
  deleteEntity,
  deleteMessage,
} = require("../sync/entity");
const {
  downloadMessagesStreamRaw,
  uploadMessagesBatchRaw,
  downloadAttachment,
  uploadAttachment,
} = require("../sync/message");
const { getLogger } = require("../core/logger");

/**
 * 注册 HTTP 路由
 * @param {object} app - Express 应用
 * @param {object} params
 * @param {string} params.syncToken - 同步令牌
 * @param {string} params.appDataPath - AppData 路径
 */
function registerRoutes(app, { syncToken, appDataPath }) {
  const router = express.Router();
  const logger = getLogger();

  // CORS 和认证中间件
  router.use(async (req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "x-sync-token, Authorization, Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(200);

    let providedToken = req.headers["x-sync-token"] || req.query.token;

    // 支持标准的 Authorization: Bearer <token>
    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
      providedToken = authHeader.substring(7);
    }

    if (providedToken !== syncToken) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    next();
  });

  // 请求日志中间件
  router.use((req, res, next) => {
    const start = Date.now();
    const routePath = req.path;

    res.on("finish", () => {
      const duration = Date.now() - start;
      const status = res.statusCode;
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
      logger.logOperation("http", `${req.method}`, routePath, level === "error" ? "error" : "success", `status=${status} duration=${duration}ms`);
    });

    next();
  });

  // 1. 下载实体
  router.get("/download-entity", async (req, res) => {
    const { id, type } = req.query;

    try {
      const dto = await downloadEntity({ id, type });
      if (!dto) {
        return res.status(404).json({ error: "Not found" });
      }
      res.json(dto);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 1.1 批量下载实体
  router.post("/download-entities", express.json(), async (req, res) => {
    const { requests } = req.body;

    try {
      const results = await downloadEntities(requests);
      res.json(results);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 2. 上传实体
  router.post(
    "/upload-entity",
    express.json({ limit: "5mb" }),
    async (req, res) => {
      const opId = req.headers["x-idempotency-key"];
      const { duplicate, result: prevResult } = checkIdempotency(opId);
      if (duplicate) {
        logger.logOperation("http", "idempotency", "upload-entity", "warn", `duplicate detected: ${opId}`);
        return res.json(prevResult);
      }

      const { id, type, data } = req.body;

      try {
        const result = await uploadEntity({ id, type, data, appDataPath });
        recordOperation(opId, result);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  );

  // 2.1 批量上传实体 (主要用于 Topic 归口优化)
  router.post(
    "/upload-entities-batch",
    express.json({ limit: "10mb" }),
    async (req, res) => {
      const { items } = req.body;
      if (!Array.isArray(items)) {
        return res.status(400).json({ error: "items must be an array" });
      }

      try {
        const results = await uploadEntitiesBatch(items, appDataPath);
        res.json({ success: true, results });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  );

  // 3. 流式批量下载消息 (NDJSON) — Phase 3 万级话题 Pull 优化
  router.post("/download-messages-stream", express.json({ limit: "5mb" }), async (req, res) => {
    const { requests } = req.body;
    if (!Array.isArray(requests) || requests.length === 0) {
      return res.status(400).json({ error: "requests must be a non-empty array" });
    }

    try {
      await downloadMessagesStreamRaw(requests, appDataPath, res);
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({ error: e.message });
      } else {
        // 流已经开始，写入错误帧并结束
        res.write(JSON.stringify({ _stream_error: e.message }) + "\n");
        res.end();
      }
    }
  });

  // 4. 批量上传消息 (NDJSON 流式)
  router.post(
    "/upload-messages-batch",
    async (req, res) => {
      try {
        await uploadMessagesBatchRaw(req, appDataPath, res);
      } catch (e) {
        if (!res.headersSent) {
          res.status(500).json({ error: e.message });
        } else {
          res.write(JSON.stringify({ _stream_error: e.message }) + "\n");
          res.end();
        }
      }
    },
  );

  // 5. 上传附件
  router.post(
    "/upload-attachment",
    express.raw({ type: "*/*", limit: "100mb" }),

    async (req, res) => {
      const { hash, name, type } = req.query;
      if (!hash) return res.status(400).send("Missing hash");

      try {
        const result = await uploadAttachment({
          hash,
          data: req.body,
          name,
          type,
          appDataPath,
        });
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  );

  // 6. 下载附件
  router.get("/download-attachment", async (req, res) => {
    const { hash } = req.query;

    try {
      const result = await downloadAttachment(hash);
      if (!result) {
        return res.status(404).send("Not Found");
      }
      res.sendFile(result.filePath);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 7. 下载头像
  router.get("/download-avatar", async (req, res) => {
    const id = req.query.id || null;
    const type = req.query.type || "agent";

    try {
      const result = await downloadAvatar(id, type);
      if (!result) {
        return res.status(404).send("Not Found");
      }
      res.sendFile(result.filePath);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 8. 上传头像
  router.post(
    "/upload-avatar",
    express.raw({ type: "*/*", limit: "10mb" }),
    async (req, res) => {
      const { id, type } = req.query;

      try {
        const result = await uploadAvatar({
          id,
          type,
          data: req.body,
          appDataPath,
        });
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  );

  // 9. 删除实体
  router.post("/delete-entity", express.json(), async (req, res) => {
    const { id, type, deletedAt } = req.body;

    if (!id || !type || !deletedAt) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      const result = await deleteEntity({
        id,
        type,
        deletedAt,
        appDataPath,
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 10. 删除消息
  router.post("/delete-message", express.json(), async (req, res) => {
    const { msgId, deletedAt, topicId } = req.body;

    if (!msgId || !deletedAt) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      const result = await deleteMessage({ msgId, deletedAt, topicId });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.use("/api/mobile-sync", router);
  logger.logInfo("http", `HTTP 路由已注册: /api/mobile-sync/*`);
}

module.exports = {
  registerRoutes,
};
