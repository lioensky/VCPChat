/**
 * HTTP 路由注册
 */

const express = require("express");
const { checkIdempotency, recordOperation } = require("../core/idempotency");
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
  uploadAttachmentStream,
} = require("../sync/message");
const { getLogger } = require("../core/logger");
const {
  createHttpErrorBody,
  createStreamErrorFrame,
  normalizeFailureResult,
} = require("../error-contract");

function entityStage(type) {
  return ["topic", "agent_topic", "group_topic"].includes(type)
    ? "topic_metadata"
    : "owner_metadata";
}

function failedTopicIds(type, id) {
  return ["topic", "agent_topic", "group_topic"].includes(type) &&
    typeof id === "string" && id.length > 0
    ? [id]
    : [];
}

function sendHttpError(res, status, error, fallback) {
  return res.status(status).json(createHttpErrorBody(error, fallback));
}

function streamErrorFallback(centralSync, code = "SYNC_STREAM_FAILED") {
  return {
    code,
    origin: centralSync ? "desktop_cds" : "desktop_plugin",
    stage: "messages",
  };
}

function requestStage(req) {
  const route = req.path || "";
  if (route.includes("message") || route.includes("attachment")) return "messages";
  if (route === "/changes") return "history";
  if (route === "/upload-entities-batch") return "topic_metadata";
  if (route === "/download-avatar" || route === "/upload-avatar") {
    return "owner_metadata";
  }
  if (route.includes("entity") || route.includes("entities")) {
    return entityStage(req.body?.type || req.query?.type);
  }
  return "startup";
}

/**
 * 注册 HTTP 路由
 * @param {object} app - Express 应用
 * @param {object} params
 * @param {string} params.syncToken - 同步令牌
 * @param {string} params.appDataPath - AppData 路径
 */
function registerRoutes(app, { syncToken, appDataPath, centralSync = null }) {
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
      return sendHttpError(res, 401, "Unauthorized", {
        code: "SYNC_AUTH_FAILED",
        stage: "connect",
      });
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
      const result = level === "error" ? "error" : level === "warn" ? "warn" : "success";
      logger.logOperation("http", `${req.method}`, routePath, result, `status=${status} duration=${duration}ms`);
    });

    next();
  });

  // 1. 下载实体
  router.get("/download-entity", async (req, res) => {
    const { id, type } = req.query;

    try {
      const dto = await downloadEntity({ id, type });
      if (!dto) {
        return sendHttpError(res, 404, "Entity not found", {
          code: "SYNC_ENTITY_NOT_FOUND",
          stage: entityStage(type),
          failedTopicIds: failedTopicIds(type, id),
        });
      }
      res.json(dto);
    } catch (e) {
      sendHttpError(res, 500, e, {
        code: "SYNC_ENTITY_READ_FAILED",
        stage: entityStage(type),
        failedTopicIds: failedTopicIds(type, id),
      });
    }
  });

  // 1.1 批量下载实体
  router.post("/download-entities", express.json(), async (req, res) => {
    const { requests } = req.body;
    if (!Array.isArray(requests) || requests.length > 10_000) {
      return sendHttpError(
        res,
        400,
        "requests must be an array of at most 10000 items",
        { code: "SYNC_REQUEST_INVALID", stage: "owner_metadata" },
      );
    }

    try {
      const results = (await downloadEntities(requests)).map((result) =>
        normalizeFailureResult(result, {
          code: "SYNC_ENTITY_READ_FAILED",
          stage: entityStage(result?.type),
          failedTopicIds: failedTopicIds(result?.type, result?.id),
        }),
      );
      res.json(results);
    } catch (e) {
      sendHttpError(res, 500, e, {
        code: "SYNC_ENTITY_READ_FAILED",
        stage: "owner_metadata",
      });
    }
  });

  // 2. 上传实体
  router.post(
    "/upload-entity",
    express.json({ limit: "5mb" }),
    async (req, res) => {
      const opId = req.headers["x-idempotency-key"];
      const {
        duplicate,
        result: prevResult,
        statusCode: previousStatus = 200,
      } = checkIdempotency(opId);
      if (duplicate) {
        logger.logOperation("http", "idempotency", "upload-entity", "warn", `duplicate detected: ${opId}`);
        return res.status(previousStatus).json(
          normalizeFailureResult(prevResult, {
            code: "SYNC_ENTITY_WRITE_FAILED",
            stage: entityStage(prevResult?.type),
          }),
        );
      }

      const { id, type, data } = req.body;

      try {
        const result = normalizeFailureResult(
          await uploadEntity({ id, type, data, appDataPath }),
          {
            code: "SYNC_ENTITY_WRITE_FAILED",
            stage: entityStage(type),
            failedTopicIds: failedTopicIds(type, id),
          },
        );
        const statusCode = result?.success === true ? 200 : 409;
        recordOperation(opId, result, statusCode);
        res.status(statusCode).json(result);
      } catch (e) {
        sendHttpError(res, 500, e, {
          code: "SYNC_ENTITY_WRITE_FAILED",
          stage: entityStage(type),
          failedTopicIds: failedTopicIds(type, id),
        });
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
        return sendHttpError(res, 400, "items must be an array", {
          code: "SYNC_REQUEST_INVALID",
          stage: "topic_metadata",
        });
      }
      if (items.length > 10_000) {
        return sendHttpError(res, 413, "items exceed the 10000 item budget", {
          code: "SYNC_BUDGET_EXCEEDED",
          stage: "topic_metadata",
        });
      }

      try {
        const results = (await uploadEntitiesBatch(items, appDataPath)).map(
          (result) => normalizeFailureResult(result, {
            code: "SYNC_ENTITY_BATCH_FAILED",
            stage: "topic_metadata",
            failedTopicIds:
              typeof result?.id === "string" ? [result.id] : [],
          }),
        );
        const success =
          results.length === items.length &&
          results.every((result) => result?.success === true);
        res.json({ success, results });
      } catch (e) {
        sendHttpError(res, 500, e, {
          code: "SYNC_ENTITY_BATCH_FAILED",
          stage: "topic_metadata",
        });
      }
    },
  );

  // 3. 流式批量下载消息 (NDJSON) — Phase 3 万级话题 Pull 优化
  router.post("/download-messages-stream", express.json({ limit: "5mb" }), async (req, res) => {
    const { requests } = req.body;
    if (!Array.isArray(requests) || requests.length === 0) {
      return sendHttpError(res, 400, "requests must be a non-empty array", {
        code: "SYNC_REQUEST_INVALID",
        stage: "messages",
      });
    }

    try {
      if (centralSync) {
        await centralSync.downloadMessagesStreamRaw(requests, res);
      } else {
        await downloadMessagesStreamRaw(requests, appDataPath, res);
      }
    } catch (e) {
      if (!res.headersSent) {
        sendHttpError(res, 500, e, streamErrorFallback(centralSync));
      } else {
        // 流已经开始，写入错误帧并结束
        res.write(
          `${JSON.stringify(createStreamErrorFrame(
            e,
            streamErrorFallback(centralSync),
          ))}\n`,
        );
        res.end();
      }
    }
  });

  // 4. 批量上传消息 (NDJSON 流式)
  router.post(
    "/upload-messages-batch",
    async (req, res) => {
      try {
        if (centralSync) {
          await centralSync.uploadMessagesBatchRaw(req, res);
        } else {
          await uploadMessagesBatchRaw(req, appDataPath, res);
        }
      } catch (e) {
        if (!res.headersSent) {
          sendHttpError(res, 500, e, streamErrorFallback(centralSync));
        } else {
          res.write(
            `${JSON.stringify(createStreamErrorFrame(
              e,
              streamErrorFallback(centralSync),
            ))}\n`,
          );
          res.end();
        }
      }
    },
  );

  // 5. 上传附件
  router.post(
    "/upload-attachment",
    async (req, res) => {
      const { hash, name, type } = req.query;
      if (!hash) {
        return sendHttpError(res, 400, "Missing hash", {
          code: "MOBILE_ATTACHMENT_INVALID",
          stage: "messages",
        });
      }

      const rawLength = req.headers["content-length"];
      const declaredLength = rawLength === undefined
        ? undefined
        : Number(rawLength);

      try {
        const result = await uploadAttachmentStream({
          hash,
          input: req,
          declaredLength,
          name,
          type,
          appDataPath,
        });
        res.json(result);
      } catch (e) {
        sendHttpError(res, 500, e, {
          code: "SYNC_ATTACHMENT_WRITE_FAILED",
          stage: "messages",
        });
      }
    },
  );

  // 6. 下载附件
  router.get("/download-attachment", async (req, res) => {
    const { hash } = req.query;

    try {
      const result = await downloadAttachment(hash);
      if (!result) {
        return sendHttpError(res, 404, "Attachment not found", {
          code: "SYNC_ATTACHMENT_NOT_FOUND",
          stage: "messages",
        });
      }
      res.sendFile(result.filePath);
    } catch (e) {
      sendHttpError(res, 500, e, {
        code: "SYNC_ATTACHMENT_READ_FAILED",
        stage: "messages",
      });
    }
  });

  // 7. 下载头像
  router.get("/download-avatar", async (req, res) => {
    const id = req.query.id || null;
    const type = req.query.type || "agent";

    try {
      const result = await downloadAvatar(id, type);
      if (!result) {
        return sendHttpError(res, 404, "Avatar not found", {
          code: "SYNC_AVATAR_NOT_FOUND",
          stage: "owner_metadata",
        });
      }
      res.sendFile(result.filePath);
    } catch (e) {
      sendHttpError(res, 500, e, {
        code: "SYNC_AVATAR_READ_FAILED",
        stage: "owner_metadata",
      });
    }
  });

  // 8. 上传头像
  router.post(
    "/upload-avatar",
    express.raw({ type: "*/*", limit: "20mb" }),
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
        sendHttpError(res, 500, e, {
          code: "SYNC_AVATAR_WRITE_FAILED",
          stage: "owner_metadata",
        });
      }
    },
  );

  // 9. 删除实体
  router.post("/delete-entity", express.json(), async (req, res) => {
    const { id, type, ownerType = null, ownerId = null, deletedAt } = req.body;
    const allowedTypes = new Set([
      "agent",
      "group",
      "topic",
      "agent_topic",
      "group_topic",
      "avatar",
    ]);

    if (
      typeof id !== "string" ||
      id.length === 0 ||
      !allowedTypes.has(type) ||
      !Number.isSafeInteger(deletedAt) ||
      deletedAt < 0 ||
      (type === "avatar" && !["agent", "group", "user"].includes(ownerType)) ||
      (["topic", "agent_topic", "group_topic"].includes(type) &&
        (!["agent", "group"].includes(ownerType) ||
          typeof ownerId !== "string" ||
          ownerId.length === 0)) ||
      (type === "agent_topic" && ownerType !== "agent") ||
      (type === "group_topic" && ownerType !== "group")
    ) {
      return sendHttpError(res, 400, "Invalid delete entity fields", {
        code: "SYNC_DELETE_INVALID",
        stage: entityStage(type),
      });
    }

    try {
      const result = await deleteEntity({
        id,
        type,
        ownerType,
        ownerId,
        deletedAt,
        appDataPath,
      });
      const response = normalizeFailureResult(result, {
        code: "SYNC_DELETE_FAILED",
        stage: entityStage(type),
        failedTopicIds: failedTopicIds(type, id),
      });
      if (
        centralSync &&
        response?.success === true &&
        type !== "avatar"
      ) {
        const isTopic = ["topic", "agent_topic", "group_topic"].includes(type);
        await centralSync.deleteEntityTombstone({
          dataType: isTopic ? "topic" : type,
          id,
          deletedAt,
          ...(isTopic
            ? { ownerType: result.ownerType, ownerId: result.ownerId }
            : {}),
        });
      }
      res.status(response?.success === true ? 200 : 409).json(response);
    } catch (e) {
      sendHttpError(res, 500, e, {
        code: "SYNC_DELETE_FAILED",
        stage: entityStage(type),
        failedTopicIds: failedTopicIds(type, id),
      });
    }
  });

  // 10. 删除消息。中央模式通过 Push 的 deletedMessageIds 原子投影，
  // 避免旧私有墓碑与 CDS 墓碑发生双写。
  router.post("/delete-message", express.json(), async (req, res) => {
    const { msgId, deletedAt, topicId } = req.body;

    if (
      typeof msgId !== "string" ||
      msgId.length === 0 ||
      typeof topicId !== "string" ||
      topicId.length === 0 ||
      !Number.isSafeInteger(deletedAt) ||
      deletedAt < 0
    ) {
      return sendHttpError(res, 400, "Missing required fields", {
        code: "SYNC_DELETE_INVALID",
        stage: "messages",
        failedTopicIds:
          typeof topicId === "string" && topicId.length > 0 ? [topicId] : [],
      });
    }

    try {
      if (centralSync) {
        return res.json(
          await centralSync.deleteMessage({ topicId, msgId, deletedAt }),
        );
      }
      const result = await deleteMessage({
        msgId,
        deletedAt,
        topicId,
        appDataPath,
      });
      const response = normalizeFailureResult(result, {
        code: "SYNC_DELETE_FAILED",
        stage: "messages",
        failedTopicIds: [topicId],
      });
      res.status(response?.success === true ? 200 : 409).json(response);
    } catch (e) {
      sendHttpError(res, 500, e, {
        code: "SYNC_DELETE_FAILED",
        stage: "messages",
        failedTopicIds: [topicId],
      });
    }
  });

  // Change Feed 为移动端断线续传与删除事件提供中央游标。
  router.get("/changes", async (req, res) => {
    if (!centralSync) {
      return sendHttpError(res, 404, "Central sync is disabled", {
        code: "SYNC_CHANGE_FEED_UNAVAILABLE",
        stage: "history",
      });
    }
    try {
      const after = Number.parseInt(req.query.after || "0", 10) || 0;
      const limit = Number.parseInt(req.query.limit || "200", 10) || 200;
      res.json(await centralSync.changes(after, limit));
    } catch (e) {
      sendHttpError(res, 500, e, {
        code: "SYNC_CHANGE_FEED_FAILED",
        origin: "desktop_cds",
        stage: "history",
      });
    }
  });

  // Keep parser failures and unknown MobileSync routes inside the same Wire
  // contract. Route-level express.json() errors otherwise bypass the handlers
  // above and fall through to the host application's generic HTML response.
  router.use((req, res) => sendHttpError(res, 404, "Unknown MobileSync route", {
    code: "SYNC_REQUEST_INVALID",
    stage: requestStage(req),
  }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
      ? error.status
      : 500;
    const tooLarge = status === 413 || error?.type === "entity.too.large";
    const invalidJson = status === 400 || error?.type === "entity.parse.failed";
    return sendHttpError(
      res,
      tooLarge ? 413 : invalidJson ? 400 : status,
      tooLarge
        ? "Request body exceeds the endpoint byte budget"
        : invalidJson
          ? "Request body is not valid JSON"
          : error,
      {
        code: tooLarge
          ? "SYNC_BUDGET_EXCEEDED"
          : invalidJson
            ? "SYNC_REQUEST_INVALID"
            : "SYNC_ATTEMPT_FAILED",
        stage: requestStage(req),
      },
    );
  });

  app.use("/api/mobile-sync", router);
  logger.logInfo("http", `HTTP 路由已注册: /api/mobile-sync/*`);
}

module.exports = {
  registerRoutes,
};
