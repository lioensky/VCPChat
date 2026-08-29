"use strict";

const fs = require("fs").promises;
const path = require("path");
const { pathToFileURL } = require("node:url");

const { createDesktopAttachment } = require("../config/defaults");
const { getAvatarIndex } = require("../core/db");
const { getExtensionFromType } = require("../utils/mime");
const {
  BoundedWarnings,
  SyncProtocolError,
  canonicalizeMessage,
} = require("./canonical");

async function resolveAttachmentPath(db, hash, allowedRoot = null) {
  const row = db
    .prepare(
      "SELECT file_path FROM attachment_index WHERE hash = ?",
    )
    .get(hash);
  if (!row || typeof row.file_path !== "string" || row.file_path.length === 0) {
    return null;
  }
  if (allowedRoot) {
    const root = path.resolve(allowedRoot);
    const candidate = path.resolve(row.file_path);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      throw new SyncProtocolError(
        `Attachment ${hash} index points outside the desktop attachment store`,
        "ATTACHMENT_PATH_INVALID",
      );
    }
  }
  try {
    const stats = await fs.stat(row.file_path);
    return stats.isFile() ? row.file_path : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const MOBILE_MESSAGE_PATCH_FIELDS = [
  "id",
  "role",
  "name",
  "content",
  "timestamp",
  "updatedAt",
  "agentId",
  "groupId",
  "topicId",
  "isGroupMessage",
  "finishReason",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function desktopAttachmentHash(attachment) {
  if (!isRecord(attachment)) return null;
  const top = typeof attachment.hash === "string" ? attachment.hash : null;
  const nested = isRecord(attachment._fileManagerData) &&
    typeof attachment._fileManagerData.hash === "string"
    ? attachment._fileManagerData.hash
    : null;
  const valid = (value) =>
    typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
  if (valid(top) && valid(nested) && top.toLowerCase() !== nested.toLowerCase()) {
    return null;
  }
  const hash = valid(top) ? top : valid(nested) ? nested : null;
  return hash?.toLowerCase() ?? null;
}

function mergeDesktopAttachment(existing, incoming) {
  if (!isRecord(existing) || !isRecord(incoming)) return incoming;

  const merged = { ...existing, ...incoming };
  if (
    incoming.src === "" &&
    typeof existing.src === "string" &&
    existing.src.length > 0
  ) {
    merged.src = existing.src;
  }

  const existingData = isRecord(existing._fileManagerData)
    ? existing._fileManagerData
    : null;
  const incomingData = isRecord(incoming._fileManagerData)
    ? incoming._fileManagerData
    : null;
  if (existingData || incomingData) {
    merged._fileManagerData = {
      ...(existingData || {}),
      ...(incomingData || {}),
    };
    if (
      incomingData?.internalPath === "" &&
      typeof existingData?.internalPath === "string" &&
      existingData.internalPath.length > 0
    ) {
      merged._fileManagerData.internalPath = existingData.internalPath;
    }
  }
  return merged;
}

function mergeMobileAttachments(existing, incoming) {
  const existingByHash = new Map();
  for (const attachment of Array.isArray(existing) ? existing : []) {
    const hash = desktopAttachmentHash(attachment);
    if (!hash) continue;
    const matches = existingByHash.get(hash) || [];
    matches.push(attachment);
    existingByHash.set(hash, matches);
  }

  return incoming.map((attachment) => {
    const hash = desktopAttachmentHash(attachment);
    const matches = hash ? existingByHash.get(hash) : null;
    const existingAttachment = matches?.shift();
    return existingAttachment
      ? mergeDesktopAttachment(existingAttachment, attachment)
      : attachment;
  });
}

/**
 * Mobile Push carries a complete portable DTO, not a complete Desktop message.
 * Patch only portable fields and preserve Desktop-only/unknown extensions.
 */
function mergeMobileMessage(existing, incoming) {
  if (!isRecord(existing) || !isRecord(incoming)) return incoming;

  const merged = { ...existing };
  for (const key of MOBILE_MESSAGE_PATCH_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(incoming, key) &&
      incoming[key] !== null
    ) {
      merged[key] = incoming[key];
    } else {
      delete merged[key];
    }
  }

  // avatarUrl is rebuilt from the Desktop-local avatar index, never from Mobile.
  if (typeof incoming.avatarUrl === "string" && incoming.avatarUrl.length > 0) {
    merged.avatarUrl = incoming.avatarUrl;
  }

  if (Array.isArray(incoming.attachments) && incoming.attachments.length > 0) {
    merged.attachments = mergeMobileAttachments(
      existing.attachments,
      incoming.attachments,
    );
  } else {
    delete merged.attachments;
  }
  return merged;
}

async function projectMobileMessage({
  rawMessage,
  topicId,
  parentId,
  ownerType,
  db,
  appDataPath,
  resolveAgentAvatarPath = null,
}) {
  if (!Number.isSafeInteger(rawMessage?.updatedAt) || rawMessage.updatedAt < 0) {
    throw new SyncProtocolError(
      "Mobile message updatedAt must be a non-negative safe integer",
    );
  }
  const warnings = new BoundedWarnings();
  const canonical = canonicalizeMessage(rawMessage, topicId, warnings);
  if (warnings.count > 0) {
    throw new SyncProtocolError(
      `Mobile message ${canonical.id} contains ${warnings.count} invalid attachment(s)`,
      "MOBILE_ATTACHMENT_INVALID",
    );
  }

  const desktop = {
    id: canonical.id,
    role: canonical.role,
    content: canonical.content,
    timestamp: canonical.timestamp,
    updatedAt: canonical.updatedAt,
  };
  if (canonical.name !== undefined) desktop.name = canonical.name;
  for (const key of [
    "isThinking",
    "agentId",
    "groupId",
    "topicId",
    "isGroupMessage",
    "finishReason",
  ]) {
    if (canonical[key] !== undefined && canonical[key] !== null) {
      desktop[key] = canonical[key];
    }
  }
  const attachmentsDir = path.join(appDataPath, "UserData", "attachments");

  if (Array.isArray(canonical.attachments) && canonical.attachments.length > 0) {
    desktop.attachments = [];
    for (const attachment of canonical.attachments) {
      const existingPath = await resolveAttachmentPath(
        db,
        attachment.hash,
        attachmentsDir,
      );
      const extension = existingPath
        ? path.extname(existingPath)
        : getExtensionFromType(attachment.type);
      desktop.attachments.push(
        createDesktopAttachment(
          attachment,
          existingPath || "",
          extension,
          canonical.timestamp,
        ),
      );
    }
  }

  if (canonical.role !== "user") {
    const avatarAgentId = canonical.agentId || (ownerType === "agent" ? parentId : null);
    if (avatarAgentId) {
      const avatarPath = resolveAgentAvatarPath
        ? await resolveAgentAvatarPath(avatarAgentId)
        : (() => {
            const avatar = getAvatarIndex(avatarAgentId, "agent");
            return avatar?.deleted_at == null ? avatar?.file_path : null;
          })();
      if (avatarPath) {
        desktop.avatarUrl = pathToFileURL(avatarPath).href;
      }
    }
  }

  return desktop;
}

async function projectMobileTopic({
  topicId,
  ownerType,
  ownerId,
  messages,
  db,
  appDataPath,
  resolveAgentAvatarPath = null,
}) {
  if (
    typeof topicId !== "string" ||
    topicId.length === 0 ||
    typeof ownerId !== "string" ||
    ownerId.length === 0 ||
    !["agent", "group"].includes(ownerType)
  ) {
    throw new SyncProtocolError("Mobile topic projection requires a valid owner identity");
  }
  if (!Array.isArray(messages)) {
    throw new SyncProtocolError(
      `Mobile push for ${topicId} requires messages array`,
    );
  }
  if (messages.length > 10_000) {
    throw new SyncProtocolError(`Mobile push for ${topicId} exceeds 10000 messages`);
  }
  const projected = [];
  const seen = new Set();
  const avatarPaths = new Map();
  const cachedAvatarPathResolver = resolveAgentAvatarPath
    ? (agentId) => {
        if (!avatarPaths.has(agentId)) {
          avatarPaths.set(agentId, Promise.resolve(resolveAgentAvatarPath(agentId)));
        }
        return avatarPaths.get(agentId);
      }
    : null;
  for (const rawMessage of messages) {
    const message = await projectMobileMessage({
      rawMessage,
      topicId,
      parentId: ownerId,
      ownerType,
      db,
      appDataPath,
      resolveAgentAvatarPath: cachedAvatarPathResolver,
    });
    if (seen.has(message.id)) {
      throw new SyncProtocolError(
        `Mobile push for ${topicId} contains duplicate message ${message.id}`,
      );
    }
    seen.add(message.id);
    projected.push(message);
  }
  return {
    messages: projected,
  };
}

module.exports = {
  mergeMobileMessage,
  projectMobileMessage,
  projectMobileTopic,
  resolveAttachmentPath,
};
