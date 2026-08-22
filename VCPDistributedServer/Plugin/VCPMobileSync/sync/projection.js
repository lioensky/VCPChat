"use strict";

const fs = require("fs").promises;
const path = require("path");

const { createDesktopAttachment } = require("../config/defaults");
const { getExtensionFromType } = require("../utils/mime");
const {
  BoundedWarnings,
  SyncProtocolError,
  canonicalizeMessage,
} = require("./canonical");

async function resolveAttachmentPath(db, hash, allowedRoot = null) {
  const row = db
    .prepare(
      "SELECT file_path FROM attachment_index WHERE hash = ? AND deleted_at IS NULL",
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

  const isGroup = ownerType === "group";
  const isUser = canonical.role === "user";
  const desktop = {
    id: canonical.id,
    role: canonical.role,
    name: canonical.name || (isUser ? "User" : "Assistant"),
    content: canonical.content,
    timestamp: canonical.timestamp,
    updatedAt: canonical.updatedAt,
  };
  const neededAttachmentHashes = new Set();
  const attachmentsDir = path.join(appDataPath, "UserData", "attachments");

  if (Array.isArray(canonical.attachments) && canonical.attachments.length > 0) {
    desktop.attachments = [];
    for (const attachment of canonical.attachments) {
      const existingPath = await resolveAttachmentPath(
        db,
        attachment.hash,
        attachmentsDir,
      );
      if (!existingPath) neededAttachmentHashes.add(attachment.hash);
      const extension = existingPath
        ? path.extname(existingPath)
        : getExtensionFromType(attachment.type);
      const expectedPath =
        existingPath || path.join(attachmentsDir, `${attachment.hash}${extension}`);
      desktop.attachments.push(
        createDesktopAttachment(
          attachment,
          expectedPath,
          extension,
          canonical.timestamp,
        ),
      );
    }
  }

  if (!isUser) {
    desktop.isThinking = canonical.isThinking ?? false;
    desktop.finishReason = canonical.finishReason || "completed";
    const agentId = canonical.agentId || (isGroup ? null : parentId);
    if (agentId) desktop.agentId = agentId;
    if (isGroup) {
      desktop.isGroupMessage = true;
      desktop.groupId = canonical.groupId || parentId;
      desktop.topicId = canonical.topicId || topicId;
    }
    if (agentId) {
      desktop.avatarUrl = `file://${path.join(appDataPath, "Agents", agentId, "avatar.png")}`;
    }
    desktop.avatarColor = canonical.avatarColor || "rgb(128, 128, 128)";
  }

  return {
    message: desktop,
    neededAttachmentHashes: [...neededAttachmentHashes],
  };
}

async function projectMobileTopic({
  topicId,
  ownerType,
  ownerId,
  messages,
  db,
  appDataPath,
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
  const needed = new Set();
  const seen = new Set();
  for (const rawMessage of messages) {
    const result = await projectMobileMessage({
      rawMessage,
      topicId,
      parentId: ownerId,
      ownerType,
      db,
      appDataPath,
    });
    if (seen.has(result.message.id)) {
      throw new SyncProtocolError(
        `Mobile push for ${topicId} contains duplicate message ${result.message.id}`,
      );
    }
    seen.add(result.message.id);
    projected.push(result.message);
    for (const hash of result.neededAttachmentHashes) needed.add(hash);
  }
  return {
    messages: projected,
    neededAttachmentHashes: [...needed].sort(),
  };
}

module.exports = {
  projectMobileMessage,
  projectMobileTopic,
  resolveAttachmentPath,
};
