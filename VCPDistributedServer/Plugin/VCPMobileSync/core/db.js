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
const HISTORY_INDEX_VERSION = 1;
const MESSAGE_TOMBSTONE_HASH = "0".repeat(64);
const ENTITY_TOMBSTONE_HASH = "0".repeat(64);

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

  // 6. history.json 源文件版本。消息 updated_at 不能用于判断物理文件
  // 是否变化；保存 mtime + size 后，后续启动只需 stat，避免重复读取、
  // 解析和散列数千个未变化的历史文件。
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_source_state (
      topic_id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      indexed_at INTEGER NOT NULL,
      index_version INTEGER NOT NULL
    )
  `);
  const historyStateColumns = db
    .prepare("PRAGMA table_info(history_source_state)")
    .all();
  if (!historyStateColumns.some((column) => column.name === "index_version")) {
    db.exec(
      "ALTER TABLE history_source_state ADD COLUMN index_version INTEGER NOT NULL DEFAULT 0",
    );
  }

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

  if (["topic", "agent_topic", "group_topic"].includes(type)) {
    const existing = db
      .prepare(
        "SELECT file_path FROM entity_index WHERE id = ? AND (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic')",
      )
      .get(id);
    if (
      existing?.file_path &&
      filePath &&
      pathIdentity(existing.file_path) !== pathIdentity(filePath)
    ) {
      throw new Error(`Topic id ${id} is ambiguous across desktop owners`);
    }
  }

  if (filePath === null) {
    // 仅更新已存在实体的哈希与时间戳 (用于 WS 通知等场景)
    const result = db.prepare(
      `
      UPDATE entity_index 
      SET hash = ?, updated_at = ?
      WHERE id = ? AND type = ?
    `,
    ).run(hash, updatedAt, id, type);
    if (result.changes !== 1) {
      throw new Error(`Entity index update missed ${type}/${id}`);
    }
    return result;
  } else {
    // 标准 upsert (含文件路径)
    db.prepare(
      `
      INSERT INTO entity_index (id, type, file_path, hash, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id, type) DO UPDATE SET 
        file_path = excluded.file_path,
        hash = excluded.hash,
        updated_at = CASE WHEN entity_index.hash <> excluded.hash THEN excluded.updated_at ELSE entity_index.updated_at END,
        deleted_at = NULL
    `,
    ).run(id, type, filePath, hash, updatedAt);
  }
}

function pathIdentity(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
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
      updated_at = excluded.updated_at,
      deleted_at = NULL
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
  if (!db) throw new Error("Database not initialized");

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
      file_path = excluded.file_path,
      hash = excluded.hash,
      updated_at = CASE WHEN avatar_index.hash <> excluded.hash THEN excluded.updated_at ELSE avatar_index.updated_at END,
      deleted_at = NULL
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
 * 获取 history.json 最近一次成功索引时的文件版本。
 */
function getHistorySourceState(topicId) {
  if (!db) return null;
  return db
    .prepare(
      "SELECT topic_id, file_path, file_size, mtime_ms, indexed_at, index_version FROM history_source_state WHERE topic_id = ?",
    )
    .get(topicId) || null;
}

/**
 * 仅在一个话题完整摄取成功后记录文件版本。失败文件不写状态，
 * 以便下次启动继续验证并恢复，而不是把损坏内容误判为已索引。
 */
function upsertHistorySourceState(
  topicId,
  filePath,
  fileSize,
  mtimeMs,
  indexedAt = Date.now(),
) {
  if (!db) return;
  db.prepare(`
    INSERT INTO history_source_state (
      topic_id, file_path, file_size, mtime_ms, indexed_at, index_version
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(topic_id) DO UPDATE SET
      file_path = excluded.file_path,
      file_size = excluded.file_size,
      mtime_ms = excluded.mtime_ms,
      indexed_at = excluded.indexed_at,
      index_version = excluded.index_version
  `).run(
    topicId,
    filePath,
    fileSize,
    mtimeMs,
    indexedAt,
    HISTORY_INDEX_VERSION,
  );
}

/**
 * 源路径也参与版本判断，避免相同 topicId 被移动或错误复用后沿用旧状态。
 */
function isHistorySourceCurrent(topicId, filePath, fileSize, mtimeMs) {
  const state = getHistorySourceState(topicId);
  return Boolean(
    state &&
    state.index_version === HISTORY_INDEX_VERSION &&
    pathIdentity(state.file_path) === pathIdentity(filePath) &&
    state.file_size === fileSize &&
    state.mtime_ms === mtimeMs
  );
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

  const topicType = ["topic", "agent_topic", "group_topic"].includes(type);
  const sql = topicType
    ? `UPDATE entity_index
       SET deleted_at = CASE
         WHEN deleted_at IS NULL THEN ? ELSE MIN(deleted_at, ?) END
       WHERE id = ?
         AND (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic')`
    : `UPDATE entity_index
       SET deleted_at = CASE
         WHEN deleted_at IS NULL THEN ? ELSE MIN(deleted_at, ?) END
       WHERE id = ? AND type = ?`;
  if (topicType) {
    const result = db.prepare(sql).run(deletedAt, deletedAt, id);
    db.prepare("DELETE FROM history_source_state WHERE topic_id = ?").run(id);
    return result;
  }
  return db.prepare(sql).run(deletedAt, deletedAt, id, type);
}

/**
 * 持久化实体墓碑；即使本机从未见过该实体，也要保留删除事实供其他端收敛。
 */
function upsertEntityTombstone(
  id,
  type,
  filePath,
  deletedAt = Date.now(),
) {
  if (!db) return;

  const normalizedType = ["topic", "agent_topic", "group_topic"].includes(type)
    ? "topic"
    : type;
  const updated = softDeleteEntityIndex(id, normalizedType, deletedAt);
  if (updated?.changes > 0) return updated;

  return db.prepare(
    `INSERT INTO entity_index
       (id, type, file_path, hash, aggregated_hash, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, '', ?, ?)
     ON CONFLICT(id, type) DO UPDATE SET
       deleted_at = CASE
         WHEN entity_index.deleted_at IS NULL THEN excluded.deleted_at
         ELSE MIN(entity_index.deleted_at, excluded.deleted_at)
       END`,
  ).run(
    id,
    normalizedType,
    filePath,
    ENTITY_TOMBSTONE_HASH,
    deletedAt,
    deletedAt,
  );
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
    return db
      .prepare(
        `INSERT INTO message_index
           (msg_id, topic_id, hash, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(topic_id, msg_id) DO UPDATE SET
           deleted_at = CASE
             WHEN message_index.deleted_at IS NULL THEN excluded.deleted_at
             ELSE MIN(message_index.deleted_at, excluded.deleted_at)
           END`,
      )
      .run(
        msgId,
        topicId,
        MESSAGE_TOMBSTONE_HASH,
        deletedAt,
        deletedAt,
      );
  } else {
    return db
      .prepare(
        `UPDATE message_index
         SET deleted_at = CASE
           WHEN deleted_at IS NULL THEN ? ELSE MIN(deleted_at, ?) END
         WHERE msg_id = ?`,
      )
      .run(deletedAt, deletedAt, msgId);
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

  return db
    .prepare(
      `UPDATE avatar_index
       SET deleted_at = CASE
         WHEN deleted_at IS NULL THEN ? ELSE MIN(deleted_at, ?) END
       WHERE owner_id = ? AND owner_type = ?`,
    )
    .run(deletedAt, deletedAt, ownerId, ownerType);
}

function updateTopicAggregatedHash(topicId, aggregatedHash) {
  if (!db) throw new Error("Database not initialized");

  return db.prepare(
    `UPDATE entity_index
     SET aggregated_hash = ?
     WHERE id = ?
       AND (type = 'topic' OR type = 'agent_topic' OR type = 'group_topic')
       AND deleted_at IS NULL`,
  ).run(aggregatedHash, topicId);
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
  getHistorySourceState,
  upsertHistorySourceState,
  isHistorySourceCurrent,
  getEntitiesByType,
  getMessagesByTopic,
  softDeleteEntityIndex,
  upsertEntityTombstone,
  softDeleteMessageIndex,
  softDeleteAvatarIndex,
  updateTopicAggregatedHash,
};
