/**
 * 数据库初始化与查询
 */

let Database;
try {
  Database = require("better-sqlite3");
} catch (e) {
  // better-sqlite3 缺失时 logger 尚未初始化，保留 console.error
  console.error("[VCPMobileSync] 缺失 better-sqlite3:", e.message);
}

const { getLogger } = require("./logger");

let db = null;

/**
 * 初始化数据库
 * @param {string} dbPath - 数据库文件路径
 * @returns {object|null} 数据库实例
 */
function initDb(dbPath) {
  if (!Database) return null;

  db = new Database(dbPath);

  // 1. 实体索引表 (Agent, Group, Topic)
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_index (
      id TEXT NOT NULL,
      type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      aggregated_hash TEXT,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER DEFAULT NULL,
      PRIMARY KEY (id, type)
    )
  `);


  // 2. 消息索引表
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_index (
      msg_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER DEFAULT NULL,
      PRIMARY KEY (topic_id, msg_id)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_msg_topic ON message_index(topic_id)`,
  );

  // 3. 附件索引表
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachment_index (
      hash TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER DEFAULT NULL
    )
  `);

  // 4. 头像索引表
  db.exec(`
    CREATE TABLE IF NOT EXISTS avatar_index (
      owner_id TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER DEFAULT NULL,
      PRIMARY KEY (owner_id, owner_type)
    )
  `);

  // 5. 消息附件关联表 (与手机端对等)
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_attachments (
      msg_id TEXT NOT NULL,
      hash TEXT NOT NULL,
      attachment_order INTEGER NOT NULL,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (msg_id, attachment_order)
    )
  `);

  const logger = getLogger();
  logger.logInfo("reconcile", "数据库初始化完成。");
  return db;
}

/**
 * 获取数据库实例
 * @returns {object|null}
 */
function getDb() {
  return db;
}

/**
 * 更新实体索引
 * @param {string} id - 实体 ID
 * @param {string} type - 实体类型
 * @param {string} filePath - 文件路径
 * @param {string} hash - 哈希值
 * @param {number} updatedAt - 更新时间戳
 */
function upsertEntityIndex(id, type, filePath, hash, updatedAt = Date.now()) {
  if (!db) return;

  if (filePath === null) {
    // 仅更新已存在实体的哈希与时间戳 (用于 WS 通知等场景)
    db.prepare(
      `
      UPDATE entity_index 
      SET hash = ?, updated_at = ?
      WHERE id = ? AND type = ?
    `,
    ).run(hash, updatedAt, id, type);
  } else {
    // 标准 upsert (含文件路径)
    db.prepare(
      `
      INSERT INTO entity_index (id, type, file_path, hash, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id, type) DO UPDATE SET 
        hash = excluded.hash,
        updated_at = CASE WHEN entity_index.hash <> excluded.hash THEN excluded.updated_at ELSE entity_index.updated_at END
    `,
    ).run(id, type, filePath, hash, updatedAt);
  }
}

/**
 * 更新消息索引
 * @param {string} msgId - 消息 ID
 * @param {string} topicId - 话题 ID
 * @param {string} hash - 哈希值
 * @param {number} updatedAt - 更新时间戳
 */
function upsertMessageIndex(msgId, topicId, hash, updatedAt = Date.now()) {
  if (!db) return;

  db.prepare(
    `
    INSERT INTO message_index (msg_id, topic_id, hash, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(topic_id, msg_id) DO UPDATE SET 
      hash = excluded.hash,
      updated_at = CASE WHEN message_index.hash <> excluded.hash THEN excluded.updated_at ELSE message_index.updated_at END
  `,
  ).run(msgId, topicId, hash, updatedAt);
}

/**
 * 更新附件索引
 * @param {string} hash - 哈希值
 * @param {string} filePath - 文件路径
 * @param {number} updatedAt - 更新时间戳
 */
function upsertAttachmentIndex(hash, filePath, updatedAt = Date.now()) {
  if (!db) return;

  try {
    db.prepare(
      `
      INSERT INTO attachment_index (hash, file_path, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        file_path = excluded.file_path,
        updated_at = excluded.updated_at,
        deleted_at = NULL
    `,
    ).run(hash, filePath, updatedAt);
  } catch (e) {
    const logger = getLogger();
    if (logger) {
      logger.logOperation("reconcile", "attachment", hash.substring(0, 16), "error", e.message);
    } else {
      console.error(`[VCPMobileSync] 附件索引失败 [${hash}]:`, e.message);
    }
  }
}

/**
 * 更新消息附件关联
 */
function upsertMessageAttachment(msgId, hash, order, displayName, createdAt = Date.now()) {
  if (!db) return;

  db.prepare(`
    INSERT INTO message_attachments (msg_id, hash, attachment_order, display_name, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(msg_id, attachment_order) DO UPDATE SET
      hash = excluded.hash,
      display_name = excluded.display_name
  `).run(msgId, hash, order, displayName, createdAt);
}

/**
 * 更新头像索引
 * @param {string} ownerId - 所有者 ID
 * @param {string} ownerType - 所有者类型
 * @param {string} filePath - 文件路径
 * @param {string} hash - 哈希值
 * @param {number} updatedAt - 更新时间戳
 */
function upsertAvatarIndex(
  ownerId,
  ownerType,
  filePath,
  hash,
  updatedAt = Date.now(),
) {
  if (!db) return;

  db.prepare(
    `
    INSERT INTO avatar_index (owner_id, owner_type, file_path, hash, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, owner_type) DO UPDATE SET 
      hash = excluded.hash,
      updated_at = CASE WHEN avatar_index.hash <> excluded.hash THEN excluded.updated_at ELSE avatar_index.updated_at END
  `,
  ).run(ownerId, ownerType, filePath, hash, updatedAt);
}

/**
 * 获取实体索引
 * @param {string} id - 实体 ID
 * @param {string} type - 实体类型
 * @returns {object|null}
 */
function getEntityIndex(id, type) {
  if (!db) return null;

  // 支持 generic "topic" 查询时同时匹配 agent_topic 和 group_topic
  if (type === "topic") {
    return db
      .prepare(
        "SELECT * FROM entity_index WHERE id = ? AND (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic')",
      )
      .get(id);
  }

  // 支持 agent_topic/group_topic 查询时同时匹配旧的 "topic" 类型
  if (type === "agent_topic" || type === "group_topic") {
    return db
      .prepare(
        "SELECT * FROM entity_index WHERE id = ? AND (type = ? OR type = 'topic')",
      )
      .get(id, type);
  }

  return db
    .prepare("SELECT * FROM entity_index WHERE id = ? AND type = ?")
    .get(id, type);
}

/**
 * 获取所有指定类型的实体
 * @param {string} type - 实体类型
 * @returns {object[]}
 */
function getEntitiesByType(type) {
  if (!db) return [];
  if (type === "topic") {
    return db
      .prepare(
        "SELECT * FROM entity_index WHERE (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic')",
      )
      .all();
  }
  return db.prepare("SELECT * FROM entity_index WHERE type = ?").all(type);
}

/**
 * 获取话题的所有消息
 * @param {string} topicId - 话题 ID
 * @returns {object[]}
 */
function getMessagesByTopic(topicId) {
  if (!db) return [];
  return db
    .prepare("SELECT * FROM message_index WHERE topic_id = ?")
    .all(topicId);
}

/**
 * 软删除实体索引
 * @param {string} id - 实体 ID
 * @param {string} type - 实体类型
 * @param {number} deletedAt - 删除时间戳
 */
function softDeleteEntityIndex(id, type, deletedAt = Date.now()) {
  if (!db) return;

  db.prepare(
    `UPDATE entity_index SET deleted_at = ? WHERE id = ? AND type = ?`,
  ).run(deletedAt, id, type);
}

/**
 * 软删除消息索引
 * @param {string} msgId - 消息 ID
 * @param {number} deletedAt - 删除时间戳
 * @param {string} [topicId] - 话题 ID (可选，若提供则精确删除特定分支话题的消息)
 */
function softDeleteMessageIndex(msgId, deletedAt = Date.now(), topicId = null) {
  if (!db) return;

  if (topicId) {
    db.prepare(`UPDATE message_index SET deleted_at = ? WHERE topic_id = ? AND msg_id = ?`).run(
      deletedAt,
      topicId,
      msgId,
    );
  } else {
    db.prepare(`UPDATE message_index SET deleted_at = ? WHERE msg_id = ?`).run(
      deletedAt,
      msgId,
    );
  }
}

/**
 * 软删除头像索引
 * @param {string} ownerId - 所有者 ID
 * @param {string} ownerType - 所有者类型
 * @param {number} deletedAt - 删除时间戳
 */
function softDeleteAvatarIndex(ownerId, ownerType, deletedAt = Date.now()) {
  if (!db) return;

  db.prepare(
    `UPDATE avatar_index SET deleted_at = ? WHERE owner_id = ? AND owner_type = ?`,
  ).run(deletedAt, ownerId, ownerType);
}

/**
 * 清理过期的删除记录（超过 30 天）
 */
function cleanupOldDeletedRecords() {
  if (!db) return;

  const logger = getLogger();
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const entityResult = db
    .prepare(
      `DELETE FROM entity_index WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
    )
    .run(thirtyDaysAgo);
  const messageResult = db
    .prepare(
      `DELETE FROM message_index WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
    )
    .run(thirtyDaysAgo);
  const avatarResult = db
    .prepare(
      `DELETE FROM avatar_index WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
    )
    .run(thirtyDaysAgo);

  if (
    entityResult.changes > 0 ||
    messageResult.changes > 0 ||
    avatarResult.changes > 0
  ) {
    logger.logOperation("cleanup", "purge", "batch", "success", `entity=${entityResult.changes} message=${messageResult.changes} avatar=${avatarResult.changes}`);
  }
}

module.exports = {
  initDb,
  getDb,
  upsertEntityIndex,
  upsertMessageIndex,
  upsertAttachmentIndex,
  upsertMessageAttachment,
  upsertAvatarIndex,
  getEntityIndex,
  getEntitiesByType,
  getMessagesByTopic,
  softDeleteEntityIndex,
  softDeleteMessageIndex,
  softDeleteAvatarIndex,
  cleanupOldDeletedRecords,
};
