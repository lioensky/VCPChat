/**
 * HTTP 路由注册
 */

const express = require("express");
const { checkIdempotency, recordOperation } = require("../core/idempotency");
const {
  downloadEntities,
  uploadEntity,
  uploadEntitiesBatch,
  downloadAvatar,
  uploadAvatar,
} = require("../sync/entity");
const {
  pullMessagesStreamRaw,
  pushMessagesStreamRaw,
} = require("../sync/message");
const { getLogger } = require("../core/logger");
const {
  createHttpErrorBody,
  createStreamErrorFrame,
  normalizeFailureResult,
} = require("../error-contract");
const { NdjsonWriter } = require("./ndjson");

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

function entityContractStage(items) {
  return items.some((item) => item?.entityType === "topic")
    ? "topic_metadata"
    : "owner_metadata";
}

function parseEntityItem(item, { requireData }) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("Entity item must be an object");
  }
  const isOwner = item.entityType === "owner";
  const isTopic = item.entityType === "topic";
  const expectedKeys = isOwner
    ? ["entityType", "ownerId", "ownerType", ...(requireData ? ["data"] : [])]
    : [
        "entityType",
        "ownerId",
        "ownerType",
        "topicId",
        ...(requireData ? ["data"] : []),
      ];
  if (
    (!isOwner && !isTopic) ||
    !["agent", "group"].includes(item.ownerType) ||
    typeof item.ownerId !== "string" ||
    item.ownerId.length === 0 ||
    (isTopic && (typeof item.topicId !== "string" || item.topicId.length === 0)) ||
    (requireData &&
      (!item.data || typeof item.data !== "object" || Array.isArray(item.data))) ||
    Object.keys(item).sort().join("\0") !== expectedKeys.sort().join("\0")
  ) {
    throw new Error("Entity item violates the owner/topic identity contract");
  }
  return {
    publicIdentity: {
      entityType: item.entityType,
      ownerType: item.ownerType,
      ownerId: item.ownerId,
      ...(isTopic ? { topicId: item.topicId } : {}),
    },
    internal: isTopic
      ? {
          id: item.topicId,
          type: `${item.ownerType}_topic`,
          ownerType: item.ownerType,
          ownerId: item.ownerId,
          ...(requireData ? { data: item.data } : {}),
        }
      : {
          id: item.ownerId,
          type: item.ownerType,
          ...(requireData ? { data: item.data } : {}),
        },
  };
}

function publicEntityIdentity(result) {
  if (
    result?.type === "agent" ||
    result?.type === "group"
  ) {
    return {
      entityType: "owner",
      ownerType: result.type,
      ownerId: result.id,
    };
  }
  if (
    result?.type === "agent_topic" ||
    result?.type === "group_topic"
  ) {
    return {
      entityType: "topic",
      ownerType: result.ownerType,
      ownerId: result.ownerId,
      topicId: result.id,
    };
  }
  throw new Error("Entity result contains an invalid identity");
}

function normalizePublicEntityResult(result, fallback) {
  const normalized = normalizeFailureResult(result, fallback);
  if (typeof normalized?.success !== "boolean") {
    throw new Error("Entity result requires boolean success");
  }
  const identity = publicEntityIdentity(normalized);
  return normalized.success
    ? { ...identity, ok: true, data: normalized.data }
    : { ...identity, ok: false, error: normalized.error };
}

function entityIdentityKey(identity) {
  return identity.entityType === "topic"
    ? `topic\0${identity.ownerType}\0${identity.ownerId}\0${identity.topicId}`
    : `owner\0${identity.ownerType}\0${identity.ownerId}`;
}

function parseUniqueEntityItems(items, options) {
  const parsed = items.map((item) => parseEntityItem(item, options));
  const seen = new Set();
  for (const item of parsed) {
    const key = entityIdentityKey(item.publicIdentity);
    if (seen.has(key)) throw new Error("Entity batch contains a duplicate identity");
    seen.add(key);
  }
  return parsed;
}

function parseAvatarQuery(query) {
  if (
    !query ||
    Object.keys(query).sort().join("\0") !== "ownerId\0ownerType" ||
    !["agent", "group", "user"].includes(query.ownerType) ||
    typeof query.ownerId !== "string" ||
    query.ownerId.length === 0 ||
    (query.ownerType === "user" && query.ownerId !== "user_avatar")
  ) {
    throw new Error("Avatar request requires the exact ownerType/ownerId identity");
  }
  return { ownerType: query.ownerType, ownerId: query.ownerId };
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

async function finishStreamWithError(res, error, fallback) {
  if (
    res.destroyed === true ||
    res.closed === true ||
    res.writableEnded === true ||
    res.writableFinished === true
  ) {
    return;
  }
  await new NdjsonWriter(res)
    .write(createStreamErrorFrame(error, fallback))
    .catch(() => {});
  if (
    !res.destroyed &&
    !res.closed &&
    !res.writableEnded &&
    !res.writableFinished
  ) {
    res.end();
  }
}

function requestStage(req) {
  const route = req.path || "";
  if (route.includes("message") || route.includes("attachment")) return "messages";
  if (route.startsWith("/avatars/")) {
    return "owner_metadata";
  }
  if (route.includes("entity") || route.includes("entities")) {
    return entityContractStage(Array.isArray(req.body?.items) ? req.body.items : []);
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
    res.header(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, X-Idempotency-Key",
    );
    if (req.method === "OPTIONS") return res.sendStatus(200);

    const authHeader = req.headers["authorization"];
    const providedToken = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.substring(7)
      : null;

    if (
      typeof syncToken !== "string" ||
      syncToken.trim().length === 0 ||
      providedToken !== syncToken
    ) {
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

  // 1. 批量 Pull 实体
  router.post("/entities/pull", express.json({ limit: "10mb" }), async (req, res) => {
    const { items } = req.body || {};
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      Object.keys(req.body).length !== 1 ||
      !Array.isArray(items) ||
      items.length > 1_000
    ) {
      return sendHttpError(
        res,
        400,
        "items must be an array of at most 1000 entities",
        { code: "SYNC_REQUEST_INVALID", stage: "owner_metadata" },
      );
    }

    let parsed;
    try {
      parsed = parseUniqueEntityItems(items, { requireData: false });
    } catch (error) {
      return sendHttpError(res, 400, error, {
        code: "SYNC_REQUEST_INVALID",
        stage: entityContractStage(items),
      });
    }
    try {
      const results = centralSync
        ? await centralSync.pullEntities(items)
        : (await downloadEntities(parsed.map(({ internal }) => internal))).map(
            (result) => normalizePublicEntityResult(result, {
              code: "SYNC_ENTITY_READ_FAILED",
              origin: "desktop_plugin",
              stage: entityStage(result?.type),
              failedTopicIds: failedTopicIds(result?.type, result?.id),
            }),
          );
      res.json({ results });
    } catch (e) {
      sendHttpError(res, 500, e, {
        code: "SYNC_ENTITY_READ_FAILED",
        origin: centralSync ? "desktop_cds" : "desktop_plugin",
        stage: "owner_metadata",
      });
    }
  });

  // 2. 批量 Push 实体；内部仍按 Owner 单写、Topic 按父 config 分组写。
  router.post(
    "/entities/push",
    express.json({ limit: "10mb" }),
    async (req, res) => {
      const { items } = req.body || {};
      if (
        !req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body) ||
        Object.keys(req.body).length !== 1 ||
        !Array.isArray(items)
      ) {
        return sendHttpError(res, 400, "items must be an array", {
          code: "SYNC_REQUEST_INVALID",
          stage: "owner_metadata",
        });
      }
      if (items.length > 10_000) {
        return sendHttpError(res, 413, "items exceed the 10000 item budget", {
          code: "SYNC_BUDGET_EXCEEDED",
          stage: entityContractStage(items),
        });
      }
      let parsed;
      try {
        parsed = parseUniqueEntityItems(items, { requireData: true });
      } catch (error) {
        return sendHttpError(res, 400, error, {
          code: "SYNC_REQUEST_INVALID",
          stage: entityContractStage(items),
        });
      }
      const opId = req.headers["x-idempotency-key"];
      const {
        duplicate,
        result: prevResult,
        statusCode: previousStatus = 200,
      } = checkIdempotency(opId);
      if (duplicate) {
        logger.logOperation("http", "idempotency", "entities/push", "warn", `duplicate detected: ${opId}`);
        return res.status(previousStatus).json(prevResult);
      }

      try {
        const ownerItems = parsed.filter(({ publicIdentity }) =>
          publicIdentity.entityType === "owner"
        );
        const topicItems = parsed.filter(({ publicIdentity }) =>
          publicIdentity.entityType === "topic"
        );
        const rawResults = [];
        for (const { internal } of ownerItems) {
          rawResults.push(await uploadEntity({ ...internal, appDataPath }));
        }
        if (topicItems.length > 0) {
          rawResults.push(...await uploadEntitiesBatch(
            topicItems.map(({ internal }) => internal),
            appDataPath,
          ));
        }
        const results = rawResults.map((result) =>
          normalizePublicEntityResult(result, {
            code: "SYNC_ENTITY_WRITE_FAILED",
            stage: entityStage(result?.type),
            failedTopicIds: failedTopicIds(result?.type, result?.id),
          }),
        );
        if (centralSync && results.some((item) => item.ok)) {
          // Owner/Topic 物理配置由插件写入，CDS 必须在本次 HTTP 提交返回前
          // 形成对应 SQLite 视图；成功项已经给出精确 Owner，无需扫描全库。
          const owners = new Map();
          for (const item of results) {
            if (!item.ok) continue;
            const key = `${item.ownerType}\0${item.ownerId}`;
            owners.set(key, {
              ownerType: item.ownerType,
              ownerId: item.ownerId,
            });
          }
          const reconcileStage = results.some(
            (item) => item.ok && item.entityType === "topic",
          )
            ? "topic_metadata"
            : "owner_metadata";
          await centralSync.reconcileOwners(
            [...owners.values()],
            reconcileStage,
          );
        }
        const response = { results };
        if (results.length === items.length && results.every((item) => item.ok)) {
          recordOperation(opId, response, 200);
        }
        res.json(response);
      } catch (e) {
        sendHttpError(res, 500, e, {
          code: "SYNC_ENTITY_WRITE_FAILED",
          stage: entityContractStage(items),
        });
      }
    },
  );

  // 3. 流式批量下载消息 (NDJSON) — Phase 3 万级话题 Pull 优化
  router.post("/messages/pull", express.json({ limit: "5mb" }), async (req, res) => {
    const { topics } = req.body || {};
    if (
      !req.body ||
      typeof req.body !== "object" ||
      Array.isArray(req.body) ||
      Object.keys(req.body).length !== 1 ||
      !Array.isArray(topics) ||
      topics.length === 0 ||
      topics.some((topic) =>
        !topic ||
        typeof topic !== "object" ||
        Array.isArray(topic) ||
        Object.keys(topic).sort().join("\0") !==
          "messageIds\0ownerId\0ownerType\0topicId"
      )
    ) {
      return sendHttpError(res, 400, "topics must be a non-empty array", {
        code: "SYNC_REQUEST_INVALID",
        stage: "messages",
      });
    }

    try {
      if (centralSync) {
        await centralSync.pullMessagesStreamRaw(topics, res);
      } else {
        await pullMessagesStreamRaw(topics, appDataPath, res);
      }
    } catch (e) {
      if (!res.headersSent) {
        sendHttpError(res, 500, e, streamErrorFallback(centralSync));
      } else {
        await finishStreamWithError(res, e, streamErrorFallback(centralSync));
      }
    }
  });

  // 4. 批量上传消息 (NDJSON 流式)
  router.post(
    "/messages/push",
    async (req, res) => {
      try {
        if (centralSync) {
          await centralSync.pushMessagesStreamRaw(req, res);
        } else {
          await pushMessagesStreamRaw(req, appDataPath, res);
        }
      } catch (e) {
        if (!res.headersSent) {
          sendHttpError(res, 500, e, streamErrorFallback(centralSync));
        } else {
          await finishStreamWithError(res, e, streamErrorFallback(centralSync));
        }
      }
    },
  );

  // 5. Pull 头像原始二进制
  router.get("/avatars/pull", async (req, res) => {
    let ownerType;
    let ownerId;
    try {
      ({ ownerType, ownerId } = parseAvatarQuery(req.query));
    } catch (error) {
      return sendHttpError(res, 400, error, {
        code: "SYNC_REQUEST_INVALID",
        stage: "owner_metadata",
      });
    }

    try {
      const result = await downloadAvatar(ownerId, ownerType, centralSync);
      if (!result) {
        return sendHttpError(res, 404, "Avatar not found", {
          code: "SYNC_AVATAR_NOT_FOUND",
          stage: "owner_metadata",
        });
      }
      res.type(result.mimeType).send(result.data);
    } catch (e) {
      sendHttpError(res, 500, e, {
        code: "SYNC_AVATAR_READ_FAILED",
        stage: "owner_metadata",
      });
    }
  });

  // 6. Push 头像原始二进制
  router.post(
    "/avatars/push",
    express.raw({ type: "*/*", limit: "20mb" }),
    async (req, res) => {
      let ownerType;
      let ownerId;
      try {
        ({ ownerType, ownerId } = parseAvatarQuery(req.query));
      } catch (error) {
        return sendHttpError(res, 400, error, {
          code: "SYNC_REQUEST_INVALID",
          stage: "owner_metadata",
        });
      }

      try {
        await uploadAvatar({
          id: ownerId,
          type: ownerType,
          data: req.body,
          appDataPath,
          mimeType: req.get("content-type"),
          centralSync,
        });
        res.json({ ownerType, ownerId, ok: true });
      } catch (e) {
        sendHttpError(res, 500, e, {
          code: "SYNC_AVATAR_WRITE_FAILED",
          stage: "owner_metadata",
        });
      }
    },
  );

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
