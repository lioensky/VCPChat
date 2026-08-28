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
let messageUpsertStatement = null;
let messageTombstoneStatement = null;
const HISTORY_INDEX_VERSION = 3;
const LOWERCASE_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MESSAGE_TOMBSTONE_HASH = "0".repeat(64);
const ENTITY_TOMBSTONE_HASH = "0".repeat(64);
const AVATAR_TOMBSTONE_HASH = "0".repeat(64);

function normalizeOwnerIdentity({ ownerType, ownerId }) {
  if (!["agent", "group"].includes(ownerType) || typeof ownerId !== "string" || ownerId.length === 0) {
    throw new Error("Owner index requires a complete owner identity");
  }
  return { ownerType, ownerId };
}

function normalizeTopicIdentity({ ownerType, ownerId, topicId }) {
  const owner = normalizeOwnerIdentity({ ownerType, ownerId });
  if (typeof topicId !== "string" || topicId.length === 0) {
    throw new Error("Topic index requires a complete topic identity");
  }
  return { ...owner, topicId };
}

function normalizeMessageIdentity({ ownerType, ownerId, topicId, msgId }) {
  if (
    !["agent", "group"].includes(ownerType) ||
    typeof ownerId !== "string" ||
    ownerId.length === 0 ||
    typeof topicId !== "string" ||
    topicId.length === 0 ||
    typeof msgId !== "string" ||
    msgId.length === 0
  ) {
    throw new Error("Message state requires a complete message identity");
  }
  return { ownerType, ownerId, topicId, msgId };
}

function createSyncStateTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owners (
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      config_path TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER DEFAULT NULL,
      PRIMARY KEY (owner_type, owner_id),
      CHECK (owner_type IN ('agent', 'group'))
    );

    CREATE TABLE IF NOT EXISTS topics (
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER DEFAULT NULL,
      PRIMARY KEY (owner_type, owner_id, topic_id),
      FOREIGN KEY (owner_type, owner_id)
        REFERENCES owners(owner_type, owner_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      message_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER DEFAULT NULL,
      PRIMARY KEY (owner_type, owner_id, topic_id, msg_id),
      FOREIGN KEY (owner_type, owner_id, topic_id)
        REFERENCES topics(owner_type, owner_id, topic_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS history_source_state (
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      source_hash TEXT NOT NULL,
      index_version INTEGER NOT NULL,
      PRIMARY KEY (owner_type, owner_id, topic_id),
      FOREIGN KEY (owner_type, owner_id, topic_id)
        REFERENCES topics(owner_type, owner_id, topic_id)
        ON DELETE CASCADE
    );
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
 * @returns {object|null} 数据库实例
 */
function initDb(dbPath) {
  if (!Database) return null;

  db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");

  // 1. Legacy 同步提交视图。Owner/Topic 根均随提交视图持久化。
  createSyncStateTables();
  messageUpsertStatement = db.prepare(`
    INSERT INTO messages (
      owner_type, owner_id, topic_id, msg_id, message_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_type, owner_id, topic_id, msg_id) DO UPDATE SET
      message_hash = excluded.message_hash,
      updated_at = excluded.updated_at,
      deleted_at = NULL
    WHERE messages.deleted_at IS NULL
      AND (messages.message_hash <> excluded.message_hash
        OR messages.updated_at <> excluded.updated_at)
  `);
  messageTombstoneStatement = db.prepare(
    `INSERT INTO messages (
       owner_type, owner_id, topic_id, msg_id, message_hash, updated_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_type, owner_id, topic_id, msg_id) DO UPDATE SET
       deleted_at = CASE
         WHEN messages.deleted_at IS NULL THEN excluded.deleted_at
         ELSE MIN(messages.deleted_at, excluded.deleted_at)
       END`,
  );

  // 2. 附件本地路径索引
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachment_index (
      hash TEXT PRIMARY KEY,
      file_path TEXT NOT NULL
    )
  `);

  // 3. Legacy Avatar 提交视图。中央模式的持久状态由 CDS 自己维护；
  // 此表只会随中央模式的其余兼容目录一起存在于内存中。
  createAvatarIndexTable(db);

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

function upsertOwnerState({
  ownerType,
  ownerId,
  configPath,
  configHash,
  updatedAt = Date.now(),
}) {
  if (!db) return;
  const identity = normalizeOwnerIdentity({ ownerType, ownerId });
  const result = db.prepare(
    `INSERT INTO owners (
       owner_type, owner_id, config_path, config_hash, updated_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner_type, owner_id) DO UPDATE SET
       config_path = excluded.config_path,
       config_hash = excluded.config_hash,
       updated_at = CASE
         WHEN owners.config_hash <> excluded.config_hash THEN excluded.updated_at
         ELSE owners.updated_at
       END
     WHERE owners.deleted_at IS NULL`,
  ).run(
    identity.ownerType,
    identity.ownerId,
    configPath,
    configHash,
    updatedAt,
  );
  if (result.changes !== 1) {
    throw new Error(`Owner state is tombstoned for ${ownerType}/${ownerId}`);
  }
  return result;
}

function upsertTopicState({
  ownerType,
  ownerId,
  topicId,
  configHash,
  updatedAt = Date.now(),
}) {
  if (!db) return;
  const identity = normalizeTopicIdentity({ ownerType, ownerId, topicId });
  const result = db.prepare(
    `INSERT INTO topics (
       owner_type, owner_id, topic_id, config_hash, content_hash, updated_at
     ) VALUES (?, ?, ?, ?, '', ?)
     ON CONFLICT(owner_type, owner_id, topic_id) DO UPDATE SET
       config_hash = excluded.config_hash,
       updated_at = CASE
         WHEN topics.config_hash <> excluded.config_hash THEN excluded.updated_at
         ELSE topics.updated_at
       END
     WHERE topics.deleted_at IS NULL`,
  ).run(
    identity.ownerType,
    identity.ownerId,
    identity.topicId,
    configHash,
    updatedAt,
  );
  if (result.changes !== 1) {
    throw new Error(
      `Topic state is tombstoned for ${ownerType}/${ownerId}/${topicId}`,
    );
  }
  return result;
}

function pathIdentity(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * 更新消息提交状态。
 */
function upsertMessageState({
  ownerType,
  ownerId,
  topicId,
  msgId,
  hash,
  updatedAt = Date.now(),
}) {
  if (!db) return;
  const identity = normalizeMessageIdentity({
    ownerType,
    ownerId,
    topicId,
    msgId,
  });

  messageUpsertStatement.run(
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
  const database = db;
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
  const database = db;
  if (!database) return null;
  return database.prepare(
    `SELECT owner_id, owner_type, file_path, hash, updated_at, deleted_at
     FROM avatar_index WHERE owner_id = ? AND owner_type = ?`,
  ).get(ownerId, ownerType) || null;
}

/**
 * 获取 Owner 提交状态。
 */
function getOwnerState({ ownerType, ownerId }) {
  if (!db) return null;
  const identity = normalizeOwnerIdentity({ ownerType, ownerId });
  return db
    .prepare(
      `SELECT owner_type, owner_id, config_path, config_hash,
              updated_at, deleted_at
       FROM owners
       WHERE owner_type = ? AND owner_id = ?`,
    )
    .get(identity.ownerType, identity.ownerId) || null;
}

/**
 * 获取 Topic 提交状态，并带出唯一的父 config 路径。
 */
function getTopicState({ ownerType, ownerId, topicId }) {
  if (!db) return null;
  const identity = normalizeTopicIdentity({ ownerType, ownerId, topicId });
  return db
    .prepare(
      `SELECT t.owner_type, t.owner_id, t.topic_id,
              t.config_hash, t.content_hash, t.updated_at, t.deleted_at,
              o.config_path
       FROM topics t
       JOIN owners o
         ON o.owner_type = t.owner_type AND o.owner_id = t.owner_id
       WHERE t.owner_type = ? AND t.owner_id = ? AND t.topic_id = ?`,
    )
    .get(identity.ownerType, identity.ownerId, identity.topicId) || null;
}

/**
 * 获取 history.json 最近一次成功索引时的文件版本。
 */
function getHistorySourceState({ ownerType, ownerId, topicId }) {
  if (!db) return null;
  const identity = normalizeTopicIdentity({ ownerType, ownerId, topicId });
  return db
    .prepare(
      `SELECT owner_type, owner_id, topic_id, file_path, file_size,
              mtime_ms, source_hash, index_version
       FROM history_source_state
       WHERE owner_type = ? AND owner_id = ? AND topic_id = ?`,
    )
    .get(identity.ownerType, identity.ownerId, identity.topicId) || null;
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
  sourceHash,
}) {
  if (!db) return;
  const identity = normalizeTopicIdentity({ ownerType, ownerId, topicId });
  if (typeof sourceHash !== "string" || !LOWERCASE_SHA256_PATTERN.test(sourceHash)) {
    throw new Error("History source state requires a lowercase SHA-256 hash");
  }
  db.prepare(`
    INSERT INTO history_source_state (
      owner_type, owner_id, topic_id, file_path, file_size,
      mtime_ms, source_hash, index_version
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_type, owner_id, topic_id) DO UPDATE SET
      file_path = excluded.file_path,
      file_size = excluded.file_size,
      mtime_ms = excluded.mtime_ms,
      source_hash = excluded.source_hash,
      index_version = excluded.index_version
  `).run(
    identity.ownerType,
    identity.ownerId,
    identity.topicId,
    filePath,
    fileSize,
    mtimeMs,
    sourceHash,
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
    Number.isFinite(state.file_size) &&
    state.file_size > 0 &&
    Number.isFinite(state.mtime_ms) &&
    state.mtime_ms > 0 &&
    typeof state.source_hash === "string" &&
    LOWERCASE_SHA256_PATTERN.test(state.source_hash) &&
    pathIdentity(state.file_path) === pathIdentity(filePath) &&
    state.file_size === fileSize &&
    state.mtime_ms === mtimeMs
  );
}

function upsertOwnerTombstone({
  ownerType,
  ownerId,
  configPath,
  deletedAt = Date.now(),
}) {
  if (!db) return;
  const identity = normalizeOwnerIdentity({ ownerType, ownerId });
  return db.prepare(
    `INSERT INTO owners (
       owner_type, owner_id, config_path, config_hash, content_hash,
       updated_at, deleted_at
     ) VALUES (?, ?, ?, ?, '', ?, ?)
     ON CONFLICT(owner_type, owner_id) DO UPDATE SET
       content_hash = '',
       deleted_at = CASE
         WHEN owners.deleted_at IS NULL THEN excluded.deleted_at
         ELSE MIN(owners.deleted_at, excluded.deleted_at)
       END`,
  ).run(
    identity.ownerType,
    identity.ownerId,
    configPath,
    ENTITY_TOMBSTONE_HASH,
    deletedAt,
    deletedAt,
  );
}

function upsertTopicTombstone({
  ownerType,
  ownerId,
  topicId,
  deletedAt = Date.now(),
}) {
  if (!db) return;
  const identity = normalizeTopicIdentity({ ownerType, ownerId, topicId });
  const result = db.prepare(
    `INSERT INTO topics (
       owner_type, owner_id, topic_id, config_hash, content_hash,
       updated_at, deleted_at
     ) VALUES (?, ?, ?, ?, '', ?, ?)
     ON CONFLICT(owner_type, owner_id, topic_id) DO UPDATE SET
       deleted_at = CASE
         WHEN topics.deleted_at IS NULL THEN excluded.deleted_at
         ELSE MIN(topics.deleted_at, excluded.deleted_at)
       END`,
  ).run(
    identity.ownerType,
    identity.ownerId,
    identity.topicId,
    ENTITY_TOMBSTONE_HASH,
    deletedAt,
    deletedAt,
  );
  db.prepare(
    `DELETE FROM history_source_state
     WHERE owner_type = ? AND owner_id = ? AND topic_id = ?`,
  ).run(identity.ownerType, identity.ownerId, identity.topicId);
  const ownerIsLive = db.prepare(
    `SELECT 1 FROM owners
     WHERE owner_type = ? AND owner_id = ? AND deleted_at IS NULL`,
  ).get(identity.ownerType, identity.ownerId);
  if (ownerIsLive) refreshOwnerContentHash(identity);
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
  const identity = normalizeMessageIdentity({
    ownerType,
    ownerId,
    topicId,
    msgId,
  });
  return messageTombstoneStatement.run(
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
  const database = db;
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

function updateTopicContentHash({ ownerType, ownerId, topicId }, contentHash) {
  if (!db) throw new Error("Database not initialized");
  const identity = normalizeTopicIdentity({ ownerType, ownerId, topicId });
  return db.prepare(
    `UPDATE topics
     SET content_hash = ?
     WHERE owner_type = ? AND owner_id = ? AND topic_id = ?
       AND deleted_at IS NULL`,
  ).run(contentHash, identity.ownerType, identity.ownerId, identity.topicId);
}

const STORED_HASH_PATTERN = /^[a-f0-9]{64}$/;

function ownerContentHashFromTopics(topics) {
  const leaves = topics.map((topic) => {
    if (typeof topic.topic_id !== "string" || topic.topic_id.length === 0) {
      throw new Error("Owner content hash encountered an empty Topic id");
    }
    if (!STORED_HASH_PATTERN.test(topic.config_hash)) {
      throw new Error(`Topic ${topic.topic_id} has an invalid config hash`);
    }
    if (
      topic.content_hash !== "" &&
      !STORED_HASH_PATTERN.test(topic.content_hash)
    ) {
      throw new Error(`Topic ${topic.topic_id} has an invalid content hash`);
    }
    return computeTopicLeafHash(
      topic.topic_id,
      topic.config_hash,
      topic.content_hash,
    );
  });
  return computeAggregatedHash(leaves);
}

function refreshOwnerContentHash(
  { ownerType, ownerId },
  database = db,
) {
  if (!database) throw new Error("Database not initialized");
  const identity = normalizeOwnerIdentity({ ownerType, ownerId });
  const topics = database.prepare(
    `SELECT topic_id, config_hash, content_hash
     FROM topics
     WHERE owner_type = ? AND owner_id = ? AND deleted_at IS NULL`,
  ).all(identity.ownerType, identity.ownerId);
  const contentHash = ownerContentHashFromTopics(topics);
  const result = database.prepare(
    `UPDATE owners SET content_hash = ?
     WHERE owner_type = ? AND owner_id = ? AND deleted_at IS NULL`,
  ).run(contentHash, identity.ownerType, identity.ownerId);
  if (result.changes !== 1) {
    throw new Error(
      `Owner content hash target is missing or tombstoned for ${ownerType}/${ownerId}`,
    );
  }
  return contentHash;
}

function refreshAllOwnerContentHashes(database = db) {
  if (!database) throw new Error("Database not initialized");
  const owners = database.prepare(
    `SELECT owner_type, owner_id FROM owners
     WHERE deleted_at IS NULL`,
  ).all();
  const topics = database.prepare(
    `SELECT owner_type, owner_id, topic_id, config_hash, content_hash
     FROM topics
     WHERE deleted_at IS NULL`,
  ).all();
  const topicsByOwner = new Map(
    owners.map((owner) => [`${owner.owner_type}\0${owner.owner_id}`, []]),
  );
  for (const topic of topics) {
    const key = `${topic.owner_type}\0${topic.owner_id}`;
    const ownerTopics = topicsByOwner.get(key);
    if (!ownerTopics) {
      throw new Error(
        `Topic ${topic.owner_type}/${topic.owner_id}/${topic.topic_id} has no live Owner`,
      );
    }
    ownerTopics.push(topic);
  }

  const update = database.prepare(
    `UPDATE owners SET content_hash = ?
     WHERE owner_type = ? AND owner_id = ? AND deleted_at IS NULL`,
  );
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const owner of owners) {
      const key = `${owner.owner_type}\0${owner.owner_id}`;
      const result = update.run(
        ownerContentHashFromTopics(topicsByOwner.get(key)),
        owner.owner_type,
        owner.owner_id,
      );
      if (result.changes !== 1) {
        throw new Error(
          `Owner content hash target disappeared for ${owner.owner_type}/${owner.owner_id}`,
        );
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return owners.length;
}

module.exports = {
  initDb,
  getDb,
  upsertOwnerState,
  upsertTopicState,
  upsertMessageState,
  upsertAttachmentIndex,
  upsertAvatarIndex,
  getAvatarIndex,
  getOwnerState,
  getTopicState,
  getHistorySourceState,
  upsertHistorySourceState,
  isHistorySourceCurrent,
  upsertOwnerTombstone,
  upsertTopicTombstone,
  upsertMessageTombstone,
  softDeleteAvatarIndex,
  updateTopicContentHash,
  refreshOwnerContentHash,
  refreshAllOwnerContentHashes,
};
