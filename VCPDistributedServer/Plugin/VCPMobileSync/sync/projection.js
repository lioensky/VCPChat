"use strict";

const fs = require("fs").promises;
const path = require("path");

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
    "avatarColor",
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
        desktop.avatarUrl = `file://${avatarPath}`;
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
  projectMobileMessage,
  projectMobileTopic,
  resolveAttachmentPath,
};
