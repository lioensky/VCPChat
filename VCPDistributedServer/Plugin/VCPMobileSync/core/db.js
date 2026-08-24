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

function ownerFromLegacyConfigPath(filePath) {
  const parts = String(filePath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  if (parts.length < 3 || parts.at(-1).toLowerCase() !== "config.json") {
    throw new Error(`Legacy entity index has an invalid config path: ${filePath}`);
  }
  const root = parts.at(-3);
  const ownerId = parts.at(-2);
  const ownerType = root === "Agents" ? "agent" : root === "AgentGroups" ? "group" : null;
  if (!ownerType || !ownerId) {
    throw new Error(`Legacy entity index owner cannot be resolved from: ${filePath}`);
  }
  return { ownerType, ownerId };
}

function createEntityIndexTable(tableName) {
  db.exec(`
    CREATE TABLE ${tableName} (
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

function ensureEntityIndexSchema() {
  const columns = db.prepare("PRAGMA table_info(entity_index)").all();
  if (columns.length === 0) {
    createEntityIndexTable("entity_index");
    return false;
  }

  const names = new Set(columns.map((column) => column.name));
  const primaryKey = columns
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  const targetPrimaryKey = ["type", "owner_type", "owner_id", "id"];
  const targetColumns = [
    "id",
    "type",
    "owner_type",
    "owner_id",
    "file_path",
    "hash",
    "aggregated_hash",
    "updated_at",
    "deleted_at",
  ];
  if (
    columns.length === targetColumns.length &&
    targetColumns.every((name) => names.has(name)) &&
    primaryKey.length === targetPrimaryKey.length &&
    primaryKey.every((name, index) => name === targetPrimaryKey[index])
  ) {
    return false;
  }

  const legacyColumns = [
    "id",
    "type",
    "file_path",
    "hash",
    "aggregated_hash",
    "updated_at",
    "deleted_at",
  ];
  const legacyPrimaryKey = ["id", "type"];
  const isLegacySchema =
    columns.length === legacyColumns.length &&
    legacyColumns.every((name) => names.has(name)) &&
    primaryKey.length === legacyPrimaryKey.length &&
    primaryKey.every((name, index) => name === legacyPrimaryKey[index]);
  if (!isLegacySchema) {
    throw new Error("Unsupported entity_index schema; refusing an ambiguous upgrade");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const groups = new Map();
    for (const row of db.prepare("SELECT * FROM entity_index").all()) {
      const { ownerType, ownerId } = ownerFromLegacyConfigPath(row.file_path);
      const identity = normalizeEntityIndexIdentity({
        id: row.id,
        type: row.type,
        ownerType,
        ownerId,
      });
      const key = `${identity.type}\0${ownerType}\0${ownerId}\0${row.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...row, ...identity, sourceType: row.type });
    }

    db.exec("DROP TABLE IF EXISTS entity_index_next");
    createEntityIndexTable("entity_index_next");
    const insert = db.prepare(`
      INSERT INTO entity_index_next (
        id, type, owner_type, owner_id, file_path, hash,
        aggregated_hash, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const candidates of groups.values()) {
      const canonical = candidates.find((candidate) => candidate.sourceType === "topic");
      if (!canonical && candidates.length !== 1) {
        throw new Error(
          `Legacy topic index ${candidates[0].ownerType}/${candidates[0].ownerId}/${candidates[0].id} cannot be merged safely`,
        );
      }
      const selected = canonical || candidates[0];
      let deletedAt = selected.deleted_at;
      if (deletedAt !== null && deletedAt !== undefined) {
        const tombstoneTimes = candidates
          .map((candidate) => candidate.deleted_at)
          .filter((value) => value !== null && value !== undefined);
        deletedAt = Math.min(...tombstoneTimes);
      }
      insert.run(
        selected.id,
        selected.type,
        selected.ownerType,
        selected.ownerId,
        selected.file_path,
        selected.hash,
        selected.aggregated_hash,
        selected.updated_at,
        deletedAt,
      );
    }

    db.exec("DROP TABLE entity_index");
    db.exec("ALTER TABLE entity_index_next RENAME TO entity_index");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return true;
}

function createMessageIndexTable(tableName) {
  db.exec(`
    CREATE TABLE ${tableName} (
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

function ensureMessageIndexSchema() {
  const columns = db.prepare("PRAGMA table_info(message_index)").all();
  if (columns.length === 0) {
    createMessageIndexTable("message_index");
    return false;
  }

  const names = new Set(columns.map((column) => column.name));
  const primaryKey = columns
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  const targetColumns = [
    "owner_type",
    "owner_id",
    "topic_id",
    "msg_id",
    "hash",
    "updated_at",
    "deleted_at",
  ];
  const targetPrimaryKey = ["owner_type", "owner_id", "topic_id", "msg_id"];
  if (
    columns.length === targetColumns.length &&
    targetColumns.every((name) => names.has(name)) &&
    primaryKey.length === targetPrimaryKey.length &&
    primaryKey.every((name, index) => name === targetPrimaryKey[index])
  ) {
    return false;
  }

  const legacyColumns = ["msg_id", "topic_id", "hash", "updated_at", "deleted_at"];
  const legacyPrimaryKey = ["topic_id", "msg_id"];
  const isLegacySchema =
    columns.length === legacyColumns.length &&
    legacyColumns.every((name) => names.has(name)) &&
    primaryKey.length === legacyPrimaryKey.length &&
    primaryKey.every((name, index) => name === legacyPrimaryKey[index]);
  if (!isLegacySchema) {
    throw new Error("Unsupported message_index schema; refusing an ambiguous upgrade");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const topicsById = new Map();
    for (const topic of db
      .prepare(
        `SELECT id, owner_type, owner_id FROM entity_index WHERE type = 'topic'`,
      )
      .all()) {
      if (!topicsById.has(topic.id)) topicsById.set(topic.id, []);
      topicsById.get(topic.id).push(topic);
    }

    db.exec("DROP TABLE IF EXISTS message_index_next");
    createMessageIndexTable("message_index_next");
    const insert = db.prepare(`
      INSERT INTO message_index_next (
        owner_type, owner_id, topic_id, msg_id, hash, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of db.prepare("SELECT * FROM message_index").all()) {
      const topics = topicsById.get(row.topic_id) || [];
      if (topics.length !== 1) {
        throw new Error(
          `Legacy message index ${row.topic_id}/${row.msg_id} has ${topics.length === 0 ? "no owner" : "an ambiguous owner"}`,
        );
      }
      const topic = topics[0];
      insert.run(
        topic.owner_type,
        topic.owner_id,
        row.topic_id,
        row.msg_id,
        row.hash,
        row.updated_at,
        row.deleted_at,
      );
    }

    db.exec("DROP TABLE message_index");
    db.exec("ALTER TABLE message_index_next RENAME TO message_index");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return true;
}

/**
 * 初始化数据库
 * @param {string} dbPath - 数据库文件路径
 * @returns {object|null} 数据库实例
 */
function initDb(dbPath) {
  if (!Database) return null;

  db = new Database(dbPath);

  // 1. 实体索引表 (Agent, Group, Topic)
  const entityIndexMigrated = ensureEntityIndexSchema();

  // 2. 消息索引表
  const messageIndexMigrated = ensureMessageIndexSchema();

  // 3. 附件索引表
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachment_index (
      hash TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL
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
  if (entityIndexMigrated) {
    logger.logInfo("reconcile", "Legacy entity_index 已升级为复合身份结构。");
  }
  if (messageIndexMigrated) {
    logger.logInfo("reconcile", "Legacy message_index 已升级为复合身份结构。");
  }
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
        `Entity index update missed ${identity.type}/${identity.ownerType}/${identity.ownerId}/${identity.id}`,
      );
    }
    return result;
  } else {
    // 标准 upsert (含文件路径)
    db.prepare(
      `
      INSERT INTO entity_index (
        id, type, owner_type, owner_id, file_path, hash, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(type, owner_type, owner_id, id) DO UPDATE SET
        file_path = excluded.file_path,
        hash = excluded.hash,
        updated_at = CASE WHEN entity_index.hash <> excluded.hash THEN excluded.updated_at ELSE entity_index.updated_at END,
        deleted_at = NULL
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
        updated_at = excluded.updated_at
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
  const normalizedType = isTopicEntityType(type) ? "topic" : type;
  return db.prepare("SELECT * FROM entity_index WHERE type = ?").all(normalizedType);
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
    // history_source_state 仍在 A3 才升级复合键；暂时保留既有清理语义。
    db.prepare("DELETE FROM history_source_state WHERE topic_id = ?").run(identity.id);
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
  upsertEntityTombstone,
  upsertMessageTombstone,
  softDeleteAvatarIndex,
  updateTopicAggregatedHash,
};
