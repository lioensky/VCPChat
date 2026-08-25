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
const {
  computeAggregatedHash,
  computeTopicLeafHash,
} = require("./hash");

let db = null;
let avatarDb = null;
const HISTORY_INDEX_VERSION = 1;
const MESSAGE_TOMBSTONE_HASH = "0".repeat(64);
const ENTITY_TOMBSTONE_HASH = "0".repeat(64);
const AVATAR_TOMBSTONE_HASH = "0".repeat(64);

function isTopicEntityType(type) {
  return ["topic", "agent_topic", "group_topic"].includes(type);
}

function normalizeEntityIndexIdentity({ id, type, ownerType, ownerId }) {
  const normalizedType = isTopicEntityType(type) ? "topic" : type;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Entity index id must be a non-empty string");
  }
  if (!["agent", "group", "topic"].includes(normalizedType)) {
    throw new Error(`Unsupported entity index type ${type}`);
  }
  if (!["agent", "group"].includes(ownerType) || typeof ownerId !== "string" || ownerId.length === 0) {
    throw new Error(`Entity index ${normalizedType}/${id} requires a complete owner identity`);
  }
  if (normalizedType !== "topic" && (ownerType !== normalizedType || ownerId !== id)) {
    throw new Error(`Owner entity index identity conflicts for ${normalizedType}/${id}`);
  }
  if (type === "agent_topic" && ownerType !== "agent") {
    throw new Error(`Agent topic ${id} cannot belong to ${ownerType}`);
  }
  if (type === "group_topic" && ownerType !== "group") {
    throw new Error(`Group topic ${id} cannot belong to ${ownerType}`);
  }
  return { id, type: normalizedType, ownerType, ownerId };
}

function normalizeMessageIndexIdentity({ ownerType, ownerId, topicId, msgId }) {
  if (
    !["agent", "group"].includes(ownerType) ||
    typeof ownerId !== "string" ||
    ownerId.length === 0 ||
    typeof topicId !== "string" ||
    topicId.length === 0 ||
    typeof msgId !== "string" ||
    msgId.length === 0
  ) {
    throw new Error("Message index requires a complete message identity");
  }
  return { ownerType, ownerId, topicId, msgId };
}

function createEntityIndexTable(tableName) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id TEXT NOT NULL,
      type TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      hash TEXT NOT NULL,
      aggregated_hash TEXT,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER DEFAULT NULL,
      PRIMARY KEY (type, owner_type, owner_id, id)
    )
  `);
}

function createMessageIndexTable(tableName) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER DEFAULT NULL,
      PRIMARY KEY (owner_type, owner_id, topic_id, msg_id)
    )
  `);
}

function createAvatarIndexTable(database) {
  database.exec(`
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
}

/**
 * 初始化数据库
 * @param {string} dbPath - 数据库文件路径
 * @param {object} [options]
 * @param {string|null} [options.avatarDbPath] - 可选的持久 Avatar 兼容索引
 * @returns {object|null} 数据库实例
 */
function initDb(dbPath, { avatarDbPath = null } = {}) {
  if (!Database) return null;

  db = new Database(dbPath);

  // 1. 实体索引表 (Agent, Group, Topic)
  createEntityIndexTable("entity_index");

  // 2. 消息索引表
  createMessageIndexTable("message_index");

  // 3. 附件索引表
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachment_index (
      hash TEXT PRIMARY KEY,
      file_path TEXT NOT NULL
    )
  `);

  // 4. 头像索引表。CDS 模式的其余兼容索引保持进程内派生视图，
  // Avatar 则复用已有 sync_state_v2.db 跨重启保存墓碑。
  avatarDb = avatarDbPath ? new Database(avatarDbPath) : db;
  createAvatarIndexTable(avatarDb);

  // 5. history.json 源文件版本。消息 updated_at 不能用于判断物理文件
  // 是否变化；保存 mtime + size 后，后续启动只需 stat，避免重复读取、
  // 解析和散列数千个未变化的历史文件。
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_source_state (
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      index_version INTEGER NOT NULL,
      PRIMARY KEY (owner_type, owner_id, topic_id)
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

function getAvatarDb() {
  return avatarDb || db;
}

/**
 * 更新实体索引
 * @param {object} params - 完整实体身份与索引数据
 */
function upsertEntityIndex({
  id,
  type,
  ownerType,
  ownerId,
  filePath,
  hash,
  updatedAt = Date.now(),
}) {
  if (!db) return;
  const identity = normalizeEntityIndexIdentity({ id, type, ownerType, ownerId });

  if (filePath === null) {
    // 仅更新已存在实体的哈希与时间戳 (用于 WS 通知等场景)
    const result = db.prepare(
      `
      UPDATE entity_index 
      SET hash = ?, updated_at = ?
      WHERE type = ? AND owner_type = ? AND owner_id = ? AND id = ?
        AND deleted_at IS NULL
    `,
    ).run(
      hash,
      updatedAt,
      identity.type,
      identity.ownerType,
      identity.ownerId,
      identity.id,
    );
    if (result.changes !== 1) {
      throw new Error(
        `Entity index update missed or found a tombstone for ${identity.type}/${identity.ownerType}/${identity.ownerId}/${identity.id}`,
      );
    }
    return result;
  } else {
    // 标准 upsert (含文件路径)
    const result = db.prepare(
      `
      INSERT INTO entity_index (
        id, type, owner_type, owner_id, file_path, hash, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(type, owner_type, owner_id, id) DO UPDATE SET
        file_path = excluded.file_path,
        hash = excluded.hash,
        updated_at = CASE WHEN entity_index.hash <> excluded.hash THEN excluded.updated_at ELSE entity_index.updated_at END
      WHERE entity_index.deleted_at IS NULL
    `,
    ).run(
      identity.id,
      identity.type,
      identity.ownerType,
      identity.ownerId,
      filePath,
      hash,
      updatedAt,
    );
    if (result.changes !== 1) {
      throw new Error(
        `Entity index is tombstoned for ${identity.type}/${identity.ownerType}/${identity.ownerId}/${identity.id}`,
      );
    }
    return result;
  }
}

function pathIdentity(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * 更新消息索引
 * @param {object} params - 完整消息身份与索引数据
 */
function upsertMessageIndex({
  ownerType,
  ownerId,
  topicId,
  msgId,
  hash,
  updatedAt = Date.now(),
}) {
  if (!db) return;
  const identity = normalizeMessageIndexIdentity({
    ownerType,
    ownerId,
    topicId,
    msgId,
  });

  db.prepare(
    `
    INSERT INTO message_index (
      owner_type, owner_id, topic_id, msg_id, hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_type, owner_id, topic_id, msg_id) DO UPDATE SET
      hash = excluded.hash,
      updated_at = excluded.updated_at,
      deleted_at = NULL
  `,
  ).run(
    identity.ownerType,
    identity.ownerId,
    identity.topicId,
    identity.msgId,
    hash,
    updatedAt,
  );
}

/**
 * 更新附件索引
 * @param {string} hash - 哈希值
 * @param {string} filePath - 文件路径
 */
function upsertAttachmentIndex(hash, filePath) {
  if (!db) throw new Error("Database not initialized");

  db.prepare(
    `
      INSERT INTO attachment_index (hash, file_path)
      VALUES (?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        file_path = excluded.file_path
    `,
  ).run(hash, filePath);
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
  const database = getAvatarDb();
  if (!database) return;

  return database.prepare(
    `
    INSERT INTO avatar_index (owner_id, owner_type, file_path, hash, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, owner_type) DO UPDATE SET 
      file_path = excluded.file_path,
      hash = excluded.hash,
      updated_at = CASE WHEN avatar_index.hash <> excluded.hash THEN excluded.updated_at ELSE avatar_index.updated_at END
    WHERE avatar_index.deleted_at IS NULL
  `,
  ).run(ownerId, ownerType, filePath, hash, updatedAt);
}

function getAvatarIndex(ownerId, ownerType) {
  const database = getAvatarDb();
  if (!database) return null;
  return database.prepare(
    `SELECT owner_id, owner_type, file_path, hash, updated_at, deleted_at
     FROM avatar_index WHERE owner_id = ? AND owner_type = ?`,
  ).get(ownerId, ownerType) || null;
}

/**
 * 获取实体索引
 * @param {object} identity - 完整实体身份
 * @returns {object|null}
 */
function getEntityIndex(identity) {
  if (!db) return null;
  const normalized = normalizeEntityIndexIdentity(identity);
  return db
    .prepare(
      `SELECT * FROM entity_index
       WHERE type = ? AND owner_type = ? AND owner_id = ? AND id = ?`,
    )
    .get(
      normalized.type,
      normalized.ownerType,
      normalized.ownerId,
      normalized.id,
    );
}

/**
 * 获取 history.json 最近一次成功索引时的文件版本。
 */
function getHistorySourceState({ ownerType, ownerId, topicId }) {
  if (!db) return null;
  const identity = normalizeEntityIndexIdentity({
    id: topicId,
    type: "topic",
    ownerType,
    ownerId,
  });
  return db
    .prepare(
      `SELECT owner_type, owner_id, topic_id, file_path, file_size,
              mtime_ms, index_version
       FROM history_source_state
       WHERE owner_type = ? AND owner_id = ? AND topic_id = ?`,
    )
    .get(identity.ownerType, identity.ownerId, identity.id) || null;
}

/**
 * 仅在一个话题完整摄取成功后记录文件版本。失败文件不写状态，
 * 以便下次启动继续验证并恢复，而不是把损坏内容误判为已索引。
 */
function upsertHistorySourceState({
  ownerType,
  ownerId,
  topicId,
  filePath,
  fileSize,
  mtimeMs,
}) {
  if (!db) return;
  const identity = normalizeEntityIndexIdentity({
    id: topicId,
    type: "topic",
    ownerType,
    ownerId,
  });
  db.prepare(`
    INSERT INTO history_source_state (
      owner_type, owner_id, topic_id, file_path, file_size,
      mtime_ms, index_version
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_type, owner_id, topic_id) DO UPDATE SET
      file_path = excluded.file_path,
      file_size = excluded.file_size,
      mtime_ms = excluded.mtime_ms,
      index_version = excluded.index_version
  `).run(
    identity.ownerType,
    identity.ownerId,
    identity.id,
    filePath,
    fileSize,
    mtimeMs,
    HISTORY_INDEX_VERSION,
  );
}

/**
 * 源路径也参与版本判断，避免相同 topicId 被移动或错误复用后沿用旧状态。
 */
function isHistorySourceCurrent({
  ownerType,
  ownerId,
  topicId,
  filePath,
  fileSize,
  mtimeMs,
}) {
  const state = getHistorySourceState({ ownerType, ownerId, topicId });
  return Boolean(
    state &&
    state.index_version === HISTORY_INDEX_VERSION &&
    pathIdentity(state.file_path) === pathIdentity(filePath) &&
    state.file_size === fileSize &&
    state.mtime_ms === mtimeMs
  );
}

/**
 * 软删除实体索引
 * @param {object} identity - 完整实体身份
 * @param {number} deletedAt - 删除时间戳
 */
function softDeleteEntityIndex(identity, deletedAt = Date.now()) {
  if (!db) return;
  const normalized = normalizeEntityIndexIdentity(identity);
  return db.prepare(
    `UPDATE entity_index
       SET deleted_at = CASE
         WHEN deleted_at IS NULL THEN ? ELSE MIN(deleted_at, ?) END
       WHERE type = ? AND owner_type = ? AND owner_id = ? AND id = ?`,
  ).run(
    deletedAt,
    deletedAt,
    normalized.type,
    normalized.ownerType,
    normalized.ownerId,
    normalized.id,
  );
}

/**
 * 持久化实体墓碑；即使本机从未见过该实体，也要保留删除事实供其他端收敛。
 */
function upsertEntityTombstone({
  id,
  type,
  ownerType,
  ownerId,
  filePath,
  deletedAt = Date.now(),
}) {
  if (!db) return;
  const identity = normalizeEntityIndexIdentity({ id, type, ownerType, ownerId });
  const updated = softDeleteEntityIndex(identity, deletedAt);
  const result = updated?.changes > 0
    ? updated
    : db.prepare(
        `INSERT INTO entity_index
           (id, type, owner_type, owner_id, file_path, hash, aggregated_hash, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)
         ON CONFLICT(type, owner_type, owner_id, id) DO UPDATE SET
           deleted_at = CASE
             WHEN entity_index.deleted_at IS NULL THEN excluded.deleted_at
             ELSE MIN(entity_index.deleted_at, excluded.deleted_at)
           END`,
      ).run(
        identity.id,
        identity.type,
        identity.ownerType,
        identity.ownerId,
        filePath,
        ENTITY_TOMBSTONE_HASH,
        deletedAt,
        deletedAt,
      );
  if (identity.type === "topic") {
    db.prepare(
      `DELETE FROM history_source_state
       WHERE owner_type = ? AND owner_id = ? AND topic_id = ?`,
    ).run(identity.ownerType, identity.ownerId, identity.id);
  }
  return result;
}

/**
 * 持久化消息墓碑；即使本机从未见过该消息，也保留精确删除事实。
 * @param {object} params - 完整消息身份与删除时间
 */
function upsertMessageTombstone({
  ownerType,
  ownerId,
  topicId,
  msgId,
  deletedAt = Date.now(),
}) {
  if (!db) return;
  const identity = normalizeMessageIndexIdentity({
    ownerType,
    ownerId,
    topicId,
    msgId,
  });
  return db
    .prepare(
      `INSERT INTO message_index (
         owner_type, owner_id, topic_id, msg_id, hash, updated_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_type, owner_id, topic_id, msg_id) DO UPDATE SET
         deleted_at = CASE
           WHEN message_index.deleted_at IS NULL THEN excluded.deleted_at
           ELSE MIN(message_index.deleted_at, excluded.deleted_at)
         END`,
    )
    .run(
      identity.ownerType,
      identity.ownerId,
      identity.topicId,
      identity.msgId,
      MESSAGE_TOMBSTONE_HASH,
      deletedAt,
      deletedAt,
    );
}

/**
 * 软删除头像索引
 * @param {string} ownerId - 所有者 ID
 * @param {string} ownerType - 所有者类型
 * @param {number} deletedAt - 删除时间戳
 */
function softDeleteAvatarIndex(
  ownerId,
  ownerType,
  deletedAt = Date.now(),
  filePath = "",
) {
  const database = getAvatarDb();
  if (!database) return;

  return database.prepare(
    `INSERT INTO avatar_index
       (owner_id, owner_type, file_path, hash, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, owner_type) DO UPDATE SET
       file_path = CASE
         WHEN avatar_index.file_path = '' THEN excluded.file_path
         ELSE avatar_index.file_path
       END,
       updated_at = CASE
         WHEN avatar_index.deleted_at IS NULL THEN excluded.deleted_at
         ELSE MIN(avatar_index.updated_at, excluded.deleted_at)
       END,
       deleted_at = CASE
         WHEN avatar_index.deleted_at IS NULL THEN excluded.deleted_at
         ELSE MIN(avatar_index.deleted_at, excluded.deleted_at)
       END`,
  ).run(
    ownerId,
    ownerType,
    filePath,
    AVATAR_TOMBSTONE_HASH,
    deletedAt,
    deletedAt,
  );
}

function updateTopicAggregatedHash({ ownerType, ownerId, topicId }, aggregatedHash) {
  if (!db) throw new Error("Database not initialized");
  const identity = normalizeEntityIndexIdentity({
    id: topicId,
    type: "topic",
    ownerType,
    ownerId,
  });
  return db.prepare(
    `UPDATE entity_index
     SET aggregated_hash = ?
     WHERE type = 'topic' AND owner_type = ? AND owner_id = ? AND id = ?
       AND deleted_at IS NULL`,
  ).run(aggregatedHash, identity.ownerType, identity.ownerId, identity.id);
}

function recomputeOwnerAggregatedHash(ownerType, ownerId) {
  if (!db) throw new Error("Database not initialized");
  if (!["agent", "group"].includes(ownerType) || !ownerId) {
    throw new Error("Owner aggregate requires a complete owner identity");
  }
  const emptyContentHash = computeAggregatedHash([]);
  const topics = db.prepare(
    `SELECT id, hash, aggregated_hash FROM entity_index
     WHERE type = 'topic' AND owner_type = ? AND owner_id = ?
       AND deleted_at IS NULL`,
  ).all(ownerType, ownerId);
  const aggregatedHash = computeAggregatedHash(
    topics.map((topic) =>
      computeTopicLeafHash(
        topic.id,
        topic.hash,
        topic.aggregated_hash || emptyContentHash,
      )
    ),
  );
  const updated = db.prepare(
    `UPDATE entity_index SET aggregated_hash = ?
     WHERE type = ? AND owner_type = ? AND owner_id = ? AND id = ?
       AND deleted_at IS NULL`,
  ).run(aggregatedHash, ownerType, ownerType, ownerId, ownerId);
  if (updated.changes !== 1) {
    throw new Error(`Owner index is missing or deleted for ${ownerType}/${ownerId}`);
  }
  return aggregatedHash;
}

module.exports = {
  initDb,
  getDb,
  getAvatarDb,
  upsertEntityIndex,
  upsertMessageIndex,
  upsertAttachmentIndex,
  upsertAvatarIndex,
  getAvatarIndex,
  getEntityIndex,
  getHistorySourceState,
  upsertHistorySourceState,
  isHistorySourceCurrent,
  upsertEntityTombstone,
  upsertMessageTombstone,
  softDeleteAvatarIndex,
  updateTopicAggregatedHash,
  recomputeOwnerAggregatedHash,
};
