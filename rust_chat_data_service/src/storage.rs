use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::Value;

use crate::{
    config::SCHEMA_VERSION,
    domain::{
        AvatarKey, AvatarOwnerType, AvatarRecord, MessageView, NormalizedMessage, OwnerKey,
        OwnerRecord, OwnerType, TopicDefinition, TopicKey, TopicSource,
    },
    sync_wire::{
        aggregate_hash, message_leaf_hash, stored_message_fingerprint, topic_leaf_hash,
        unhealthy_topic_sentinel_hash,
    },
};

const SCHEMA_V3: &str = r#"
CREATE TABLE IF NOT EXISTS owners (
    owner_type TEXT NOT NULL CHECK(owner_type IN ('agent', 'group')),
    owner_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    config_path TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    content_hash TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY (owner_type, owner_id)
);

CREATE TABLE IF NOT EXISTS avatars (
    owner_type TEXT NOT NULL CHECK(owner_type IN ('agent', 'group', 'user')),
    owner_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY (owner_type, owner_id)
);

CREATE TABLE IF NOT EXISTS topics (
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    display_name TEXT,
    created_at INTEGER,
    topic_ordinal INTEGER NOT NULL DEFAULT 0,
    config_hash TEXT NOT NULL,
    metadata_json TEXT,
    content_hash TEXT NOT NULL DEFAULT '',
    source_path TEXT NOT NULL,
    content_revision INTEGER NOT NULL DEFAULT 0,
    indexed_revision INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY (owner_type, owner_id, topic_id),
    FOREIGN KEY (owner_type, owner_id)
        REFERENCES owners(owner_type, owner_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
    row_id INTEGER PRIMARY KEY,
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    msg_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    role TEXT NOT NULL,
    speaker_name TEXT,
    speaker_agent_id TEXT,
    content_raw TEXT NOT NULL,
    content_text TEXT NOT NULL,
    timestamp INTEGER,
    message_hash TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    UNIQUE (owner_type, owner_id, topic_id, msg_id),
    FOREIGN KEY (owner_type, owner_id, topic_id)
        REFERENCES topics(owner_type, owner_id, topic_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_topic_ordinal
ON messages(owner_type, owner_id, topic_id, ordinal);

DROP INDEX IF EXISTS idx_messages_topic_timestamp;
DROP INDEX IF EXISTS idx_messages_speaker_agent;

CREATE TABLE IF NOT EXISTS history_sources (
    source_path TEXT PRIMARY KEY,
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    mtime_ns INTEGER NOT NULL,
    file_size INTEGER NOT NULL,
    source_hash TEXT,
    last_revision INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    last_error TEXT,
    FOREIGN KEY (owner_type, owner_id, topic_id)
        REFERENCES topics(owner_type, owner_id, topic_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS service_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

const COLLAPSE_V1_TOMBSTONES: &str = r#"
INSERT INTO owners(
    owner_type, owner_id, display_name, config_path, config_hash, updated_at, deleted_at
)
SELECT owner_type, owner_id, '', '', '', deleted_at, deleted_at
FROM tombstones
WHERE entity_type='owner'
  AND owner_type IN ('agent', 'group')
  AND owner_id<>'' AND topic_id='' AND entity_id=owner_id
ON CONFLICT(owner_type, owner_id) DO UPDATE SET
    deleted_at=CASE
        WHEN owners.deleted_at IS NULL THEN excluded.deleted_at
        ELSE MIN(owners.deleted_at, excluded.deleted_at)
    END,
    updated_at=MAX(owners.updated_at, excluded.updated_at);

INSERT INTO topics(
    owner_type, owner_id, topic_id, display_name, created_at,
    topic_ordinal, config_hash, metadata_json, content_hash,
    source_path, content_revision, indexed_revision, updated_at, deleted_at
)
SELECT tombstone.owner_type, tombstone.owner_id, tombstone.topic_id,
       NULL, NULL, 0, '', '{}', '', '', 0, 0,
       tombstone.deleted_at, tombstone.deleted_at
FROM tombstones AS tombstone
WHERE tombstone.entity_type='topic'
  AND tombstone.owner_type IN ('agent', 'group')
  AND tombstone.owner_id<>''
  AND tombstone.topic_id<>''
  AND tombstone.entity_id=tombstone.topic_id
  AND EXISTS (
      SELECT 1 FROM owners
      WHERE owners.owner_type=tombstone.owner_type
        AND owners.owner_id=tombstone.owner_id
  )
ON CONFLICT(owner_type, owner_id, topic_id) DO UPDATE SET
    deleted_at=CASE
        WHEN topics.deleted_at IS NULL THEN excluded.deleted_at
        ELSE MIN(topics.deleted_at, excluded.deleted_at)
    END,
    updated_at=MAX(topics.updated_at, excluded.updated_at);

INSERT INTO messages(
    owner_type, owner_id, topic_id, msg_id, ordinal, role,
    speaker_name, speaker_agent_id, content_raw, content_text,
    timestamp, message_hash, metadata_json, updated_at, deleted_at
)
SELECT tombstone.owner_type, tombstone.owner_id, tombstone.topic_id,
       tombstone.entity_id, 0, '', NULL, NULL, '', '', NULL, '', '{}',
       tombstone.deleted_at, tombstone.deleted_at
FROM tombstones AS tombstone
WHERE tombstone.entity_type='message'
  AND tombstone.owner_type IN ('agent', 'group')
  AND tombstone.owner_id<>''
  AND tombstone.topic_id<>''
  AND tombstone.entity_id<>''
  AND EXISTS (
      SELECT 1 FROM topics
      WHERE topics.owner_type=tombstone.owner_type
        AND topics.owner_id=tombstone.owner_id
        AND topics.topic_id=tombstone.topic_id
  )
ON CONFLICT(owner_type, owner_id, topic_id, msg_id) DO UPDATE SET
    deleted_at=CASE
        WHEN messages.deleted_at IS NULL THEN excluded.deleted_at
        ELSE MIN(messages.deleted_at, excluded.deleted_at)
    END,
    updated_at=MAX(messages.updated_at, excluded.updated_at);

DROP TABLE tombstones;
"#;

const AVATAR_TOMBSTONE_HASH: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug, Clone)]
pub struct SourceMetadata {
    pub owner_type: String,
    pub owner_id: String,
    pub topic_id: String,
    pub mtime_ns: i64,
    pub file_size: i64,
    pub source_hash: Option<String>,
    pub status: String,
    pub last_error: Option<String>,
}

impl SourceMetadata {
    pub fn matches_topic(&self, key: &TopicKey) -> bool {
        self.owner_type == key.owner_type.as_str()
            && self.owner_id == key.owner_id
            && self.topic_id == key.topic_id
    }
}

#[derive(Debug, Clone)]
pub struct IngestCommit {
    pub topic: TopicKey,
    pub revision: i64,
    pub changed: bool,
    pub owner_hash_dirty: bool,
    pub search_update: SearchUpdate,
    pub message_count: usize,
}

#[derive(Debug, Clone)]
pub enum SearchUpdate {
    None,
    Append(Vec<i64>),
    Rewrite,
}

impl SearchUpdate {
    pub(crate) fn for_revision_gap(content_revision: i64, indexed_revision: i64) -> Self {
        if content_revision > indexed_revision {
            Self::Rewrite
        } else {
            Self::None
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerHashMode {
    Immediate,
    Deferred,
}

#[derive(Debug, Clone, Default)]
pub struct DatabaseStats {
    pub owners: i64,
    pub topics: i64,
    pub messages: i64,
    pub content_revision: i64,
    pub indexed_revision: i64,
    pub last_reconcile_at: Option<i64>,
}

#[derive(Clone)]
pub struct Database {
    pub(crate) connection: Arc<Mutex<Connection>>,
    path: PathBuf,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("failed to create database directory {}", parent.display())
            })?;
        }

        let connection = match Self::open_and_migrate(path) {
            Ok(connection) => connection,
            Err(error) => {
                if path.exists() {
                    let isolated = path.with_extension(format!("corrupt.{}.sqlite3", now_ms()));
                    fs::rename(path, &isolated).with_context(|| {
                        format!(
                            "database failed to open and could not be isolated at {}",
                            isolated.display()
                        )
                    })?;
                    tracing::error!(
                        error = ?error,
                        isolated_path = %isolated.display(),
                        "isolated unusable chat database"
                    );
                    Self::open_and_migrate(path)?
                } else {
                    return Err(error);
                }
            }
        };

        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            path: path.to_path_buf(),
        })
    }

    fn open_and_migrate(path: &Path) -> Result<Connection> {
        let mut connection = Connection::open(path)
            .with_context(|| format!("failed to open database {}", path.display()))?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA foreign_keys=ON;
             PRAGMA temp_store=MEMORY;",
        )?;

        let integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            anyhow::bail!("SQLite quick_check failed: {integrity}");
        }

        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(SCHEMA_V3)?;
        let has_v1_tombstones = transaction.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                WHERE type='table' AND name='tombstones'
             )",
            [],
            |row| row.get::<_, bool>(0),
        )?;
        if has_v1_tombstones {
            transaction.execute_batch(COLLAPSE_V1_TOMBSTONES)?;
        }
        migrate_sync_hash_contract(&transaction)?;
        transaction.execute(
            "INSERT INTO service_meta(key, value) VALUES('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [SCHEMA_VERSION.to_string()],
        )?;
        transaction.execute(
            "INSERT OR IGNORE INTO service_meta(key, value) VALUES
             ('global_content_revision', '0'),
             ('tantivy_index_revision', '0')",
            [],
        )?;
        transaction.commit()?;
        Ok(connection)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn upsert_owner(
        &self,
        owner: &OwnerRecord,
        owner_hash_mode: OwnerHashMode,
    ) -> Result<bool> {
        let now = now_ms();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if owner_is_tombstoned(&transaction, &owner.key)? {
            transaction.commit()?;
            return Ok(false);
        }

        transaction.execute(
            "INSERT INTO owners(
                owner_type, owner_id, display_name, config_path, config_hash, updated_at, deleted_at
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, NULL)
             ON CONFLICT(owner_type, owner_id) DO UPDATE SET
                display_name=excluded.display_name,
                config_path=excluded.config_path,
                config_hash=excluded.config_hash,
                updated_at=CASE
                    WHEN owners.config_hash IS excluded.config_hash THEN owners.updated_at
                    WHEN ?7 IS NOT NULL AND owners.config_hash IS ?7 THEN owners.updated_at
                    ELSE excluded.updated_at
                END
             WHERE owners.deleted_at IS NULL
               AND (owners.display_name IS NOT excluded.display_name
                 OR owners.config_path IS NOT excluded.config_path
                 OR owners.config_hash IS NOT excluded.config_hash)",
            params![
                owner.key.owner_type.as_str(),
                owner.key.owner_id,
                owner.display_name,
                owner.config_path.to_string_lossy(),
                owner.config_hash,
                now,
                owner.source_config_hash,
            ],
        )?;
        let mut active_topic_ids = HashSet::new();
        for topic in &owner.topics {
            let key = TopicKey {
                owner_type: owner.key.owner_type,
                owner_id: owner.key.owner_id.clone(),
                topic_id: topic.topic_id.clone(),
            };
            if topic_is_tombstoned_in_transaction(&transaction, &key)? {
                continue;
            }
            active_topic_ids.insert(topic.topic_id.as_str());
            let source_path = owner
                .config_path
                .parent()
                .and_then(Path::parent)
                .and_then(Path::parent)
                .unwrap_or_else(|| Path::new(""))
                .join("UserData")
                .join(&owner.key.owner_id)
                .join("topics")
                .join(&topic.topic_id)
                .join("history.json");
            transaction.execute(
                "INSERT INTO topics(
                    owner_type, owner_id, topic_id, display_name, created_at,
                    topic_ordinal, config_hash, metadata_json, source_path, updated_at, deleted_at
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)
                 ON CONFLICT(owner_type, owner_id, topic_id) DO UPDATE SET
                    display_name=excluded.display_name,
                    created_at=excluded.created_at,
                    topic_ordinal=excluded.topic_ordinal,
                    config_hash=excluded.config_hash,
                    metadata_json=excluded.metadata_json,
                    source_path=excluded.source_path,
                    updated_at=CASE
                        WHEN topics.config_hash IS excluded.config_hash THEN topics.updated_at
                        WHEN ?11 IS NOT NULL AND topics.config_hash IS ?11 THEN topics.updated_at
                        ELSE excluded.updated_at
                    END
                 WHERE topics.deleted_at IS NULL
                   AND (topics.display_name IS NOT excluded.display_name
                     OR topics.created_at IS NOT excluded.created_at
                     OR topics.topic_ordinal IS NOT excluded.topic_ordinal
                     OR topics.config_hash IS NOT excluded.config_hash
                     OR topics.metadata_json IS NOT excluded.metadata_json
                     OR topics.source_path IS NOT excluded.source_path)",
                params![
                    owner.key.owner_type.as_str(),
                    owner.key.owner_id,
                    topic.topic_id,
                    topic.display_name,
                    topic.created_at,
                    topic.ordinal,
                    topic.config_hash,
                    topic.metadata.to_string(),
                    source_path.to_string_lossy(),
                    now,
                    owner.source_config_hash,
                ],
            )?;
        }

        let mut statement = transaction.prepare(
            "SELECT topic_id FROM topics
             WHERE owner_type=?1 AND owner_id=?2 AND deleted_at IS NULL",
        )?;
        let known: Vec<String> = statement
            .query_map(
                params![owner.key.owner_type.as_str(), owner.key.owner_id],
                |row| row.get(0),
            )?
            .collect::<rusqlite::Result<_>>()?;
        drop(statement);

        for topic_id in known {
            if !active_topic_ids.contains(topic_id.as_str()) {
                mark_topic_deleted(
                    &transaction,
                    &TopicKey {
                        owner_type: owner.key.owner_type,
                        owner_id: owner.key.owner_id.clone(),
                        topic_id,
                    },
                    now,
                )?;
            }
        }

        if owner_hash_mode == OwnerHashMode::Immediate {
            recompute_owner_content_hash(&transaction, &owner.key)?;
        }
        transaction.commit()?;
        Ok(true)
    }

    pub fn live_topic_source_by_path(&self, source_path: &Path) -> Result<Option<TopicSource>> {
        let connection = self.connection.lock();
        let source_path_text = source_path.to_string_lossy();
        let indexed = connection
            .query_row(
                "SELECT t.owner_type, t.owner_id, t.topic_id
                 FROM history_sources hs
                 JOIN topics t
                   ON t.owner_type=hs.owner_type AND t.owner_id=hs.owner_id
                  AND t.topic_id=hs.topic_id
                  AND t.source_path=hs.source_path
                 JOIN owners o
                   ON o.owner_type=t.owner_type AND o.owner_id=t.owner_id
                 WHERE hs.source_path=?1
                   AND t.deleted_at IS NULL AND o.deleted_at IS NULL",
                [source_path_text.as_ref()],
                |row| {
                    Ok(TopicSource {
                        key: TopicKey {
                            owner_type: parse_owner_type(row.get::<_, String>(0)?),
                            owner_id: row.get(1)?,
                            topic_id: row.get(2)?,
                        },
                        source_path: source_path.to_path_buf(),
                    })
                },
            )
            .optional()?;
        if indexed.is_some() {
            return Ok(indexed);
        }
        connection
            .query_row(
                "SELECT t.owner_type, t.owner_id, t.topic_id
                 FROM topics t
                 JOIN owners o
                   ON o.owner_type=t.owner_type AND o.owner_id=t.owner_id
                 WHERE t.source_path=?1
                   AND t.deleted_at IS NULL AND o.deleted_at IS NULL",
                [source_path_text.as_ref()],
                |row| {
                    Ok(TopicSource {
                        key: TopicKey {
                            owner_type: parse_owner_type(row.get::<_, String>(0)?),
                            owner_id: row.get(1)?,
                            topic_id: row.get(2)?,
                        },
                        source_path: source_path.to_path_buf(),
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn upsert_avatar(
        &self,
        key: &AvatarKey,
        file_path: &Path,
        hash: &str,
        updated_at: i64,
    ) -> Result<bool> {
        let connection = self.connection.lock();
        let changed = connection.execute(
            "INSERT INTO avatars(
                owner_type, owner_id, file_path, hash, updated_at, deleted_at
             ) VALUES(?1, ?2, ?3, ?4, ?5, NULL)
             ON CONFLICT(owner_type, owner_id) DO UPDATE SET
                file_path=excluded.file_path,
                hash=excluded.hash,
                updated_at=CASE
                    WHEN avatars.hash IS excluded.hash THEN avatars.updated_at
                    ELSE excluded.updated_at
                END
             WHERE avatars.deleted_at IS NULL",
            params![
                key.owner_type.as_str(),
                key.owner_id,
                file_path.to_string_lossy(),
                hash,
                updated_at,
            ],
        )?;
        Ok(changed == 1)
    }

    pub fn avatar_state(&self, key: &AvatarKey) -> Result<Option<AvatarRecord>> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT owner_type, owner_id, file_path, hash, updated_at, deleted_at
                 FROM avatars
                 WHERE owner_type=?1 AND owner_id=?2",
                params![key.owner_type.as_str(), key.owner_id],
                |row| {
                    let owner_type = parse_avatar_owner_type(row.get::<_, String>(0)?);
                    Ok(AvatarRecord {
                        owner_type,
                        owner_id: row.get(1)?,
                        file_path: PathBuf::from(row.get::<_, String>(2)?),
                        hash: row.get(3)?,
                        updated_at: row.get(4)?,
                        deleted_at: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn avatar_parent_is_tombstoned(&self, key: &AvatarKey) -> Result<bool> {
        let Some(owner_type) = key.owner_type.owner_type() else {
            return Ok(false);
        };
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM owners
                    WHERE owner_type=?1 AND owner_id=?2 AND deleted_at IS NOT NULL
                 )",
                params![owner_type.as_str(), key.owner_id],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub fn reconcile_missing_avatars(
        &self,
        active: &HashSet<AvatarKey>,
        deleted_at: i64,
    ) -> Result<usize> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let known = {
            let mut statement = transaction
                .prepare("SELECT owner_type, owner_id FROM avatars WHERE deleted_at IS NULL")?;
            let rows = statement.query_map([], |row| {
                Ok(AvatarKey {
                    owner_type: parse_avatar_owner_type(row.get::<_, String>(0)?),
                    owner_id: row.get(1)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };

        let mut deleted = 0;
        for key in known {
            if active.contains(&key) {
                continue;
            }
            mark_avatar_deleted(&transaction, &key, deleted_at)?;
            deleted += 1;
        }
        transaction.commit()?;
        Ok(deleted)
    }

    pub fn apply_sync_avatar_tombstone(&self, key: &AvatarKey, deleted_at: i64) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        mark_avatar_deleted(&transaction, key, deleted_at)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn mark_physical_avatar_missing(&self, key: &AvatarKey, deleted_at: i64) -> Result<bool> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let live = transaction
            .query_row(
                "SELECT 1 FROM avatars
                 WHERE owner_type=?1 AND owner_id=?2 AND deleted_at IS NULL",
                params![key.owner_type.as_str(), key.owner_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if live {
            mark_avatar_deleted(&transaction, key, deleted_at)?;
        }
        transaction.commit()?;
        Ok(live)
    }

    pub fn reconcile_missing_owners(&self, active: &HashSet<OwnerKey>) -> Result<usize> {
        let now = now_ms();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let known = {
            let mut statement = transaction
                .prepare("SELECT owner_type, owner_id FROM owners WHERE deleted_at IS NULL")?;
            let rows = statement.query_map([], |row| {
                Ok(OwnerKey {
                    owner_type: parse_owner_type(row.get::<_, String>(0)?),
                    owner_id: row.get(1)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };

        let mut deleted = 0;
        for owner in known {
            if active.contains(&owner) {
                continue;
            }
            deleted += usize::from(mark_owner_deleted(&transaction, &owner, now)?);
        }

        transaction.commit()?;
        Ok(deleted)
    }

    pub fn reconcile_missing_owner(&self, key: &OwnerKey) -> Result<bool> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let deleted = mark_owner_deleted(&transaction, key, now_ms())?;
        transaction.commit()?;
        Ok(deleted)
    }

    pub fn source_metadata(&self, source_path: &Path) -> Result<Option<SourceMetadata>> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT owner_type, owner_id, topic_id, mtime_ns, file_size,
                        source_hash, status, last_error
                 FROM history_sources WHERE source_path=?1",
                [source_path.to_string_lossy().as_ref()],
                |row| {
                    Ok(SourceMetadata {
                        owner_type: row.get(0)?,
                        owner_id: row.get(1)?,
                        topic_id: row.get(2)?,
                        mtime_ns: row.get(3)?,
                        file_size: row.get(4)?,
                        source_hash: row.get(5)?,
                        status: row.get(6)?,
                        last_error: row.get(7)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn mark_history_source_missing(
        &self,
        source: &TopicSource,
        owner_hash_mode: OwnerHashMode,
    ) -> Result<bool> {
        let now = now_ms();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_history_source_identity_available(&transaction, source)?;

        let previous_status: Option<String> = transaction
            .query_row(
                "SELECT status FROM history_sources
                 WHERE source_path=?1 AND owner_type=?2 AND owner_id=?3 AND topic_id=?4",
                params![
                    source.source_path.to_string_lossy(),
                    source.key.owner_type.as_str(),
                    source.key.owner_id,
                    source.key.topic_id,
                ],
                |row| row.get(0),
            )
            .optional()?;
        let Some(previous_status) = previous_status else {
            transaction.commit()?;
            return Ok(false);
        };
        if previous_status == "missing" {
            transaction.commit()?;
            return Ok(false);
        }

        transaction.execute(
            "UPDATE history_sources SET
                mtime_ns=0,
                file_size=0,
                indexed_at=?2,
                status='missing',
                last_error='previously indexed history source is missing'
             WHERE source_path=?1 AND owner_type=?3 AND owner_id=?4 AND topic_id=?5",
            params![
                source.source_path.to_string_lossy(),
                now,
                source.key.owner_type.as_str(),
                source.key.owner_id,
                source.key.topic_id,
            ],
        )?;
        if owner_hash_mode == OwnerHashMode::Immediate {
            recompute_owner_content_hash(
                &transaction,
                &OwnerKey {
                    owner_type: source.key.owner_type,
                    owner_id: source.key.owner_id.clone(),
                },
            )?;
        }
        transaction.commit()?;
        Ok(true)
    }

    /// Reconciles deletion timestamps supplied by the sync wire after the
    /// corresponding native history projection has been durably ingested.
    ///
    /// A missing message is still recorded as a tombstone so an offline delete
    /// cannot be lost merely because this desktop never ingested the live row.
    /// Replays preserve the earliest durable deletion timestamp.
    pub fn apply_explicit_message_tombstones(
        &self,
        key: &TopicKey,
        tombstones: &[(String, i64)],
    ) -> Result<bool> {
        if tombstones.is_empty() {
            return Ok(false);
        }

        let mut seen = HashSet::with_capacity(tombstones.len());
        for (msg_id, deleted_at) in tombstones {
            anyhow::ensure!(
                !msg_id.is_empty() && seen.insert(msg_id.as_str()),
                "explicit message tombstones must have non-empty unique ids"
            );
            anyhow::ensure!(
                (0..=9_007_199_254_740_991).contains(deleted_at),
                "explicit message tombstone timestamp must be a non-negative safe integer"
            );
        }

        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let topic_exists = transaction
            .query_row(
                "SELECT 1 FROM topics
                 WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3
                   AND deleted_at IS NULL",
                params![key.owner_type.as_str(), key.owner_id, key.topic_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        anyhow::ensure!(
            topic_exists,
            "explicit message tombstone topic is missing or deleted"
        );

        let mut updates = Vec::with_capacity(tombstones.len());
        for (msg_id, requested_at) in tombstones {
            let message_state: Option<Option<i64>> = transaction
                .query_row(
                    "SELECT deleted_at FROM messages
                     WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3 AND msg_id=?4",
                    params![key.owner_type.as_str(), key.owner_id, key.topic_id, msg_id],
                    |row| row.get(0),
                )
                .optional()?;
            anyhow::ensure!(
                !matches!(message_state, Some(None)),
                "explicit message tombstone {msg_id} still has a live message row"
            );
            let effective_at = message_state
                .flatten()
                .map_or(*requested_at, |stored| stored.min(*requested_at));
            if message_state != Some(Some(effective_at)) {
                updates.push((msg_id.clone(), effective_at));
            }
        }

        if updates.is_empty() {
            transaction.commit()?;
            return Ok(false);
        }

        for (msg_id, deleted_at) in updates {
            transaction.execute(
                "INSERT INTO messages(
                    owner_type, owner_id, topic_id, msg_id, ordinal, role,
                    speaker_name, speaker_agent_id, content_raw, content_text,
                    timestamp, message_hash, metadata_json, updated_at, deleted_at
                 ) VALUES(?1, ?2, ?3, ?4, 0, '', NULL, NULL, '', '', NULL, '', '{}', ?5, ?5)
                 ON CONFLICT(owner_type, owner_id, topic_id, msg_id) DO UPDATE SET
                    message_hash='',
                    deleted_at=MIN(messages.deleted_at, excluded.deleted_at),
                    updated_at=MAX(messages.updated_at, excluded.updated_at)
                 WHERE messages.deleted_at IS NOT NULL",
                params![
                    key.owner_type.as_str(),
                    key.owner_id,
                    key.topic_id,
                    msg_id,
                    deleted_at,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(true)
    }

    /// Persists an owner tombstone received from MobileSync and cascades it to
    /// every topic/message row currently known to CDS.
    pub fn apply_sync_owner_tombstone(
        &self,
        owner_type: OwnerType,
        owner_id: &str,
        deleted_at: i64,
    ) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let owner_state: Option<Option<i64>> = transaction
            .query_row(
                "SELECT deleted_at FROM owners WHERE owner_type=?1 AND owner_id=?2",
                params![owner_type.as_str(), owner_id],
                |row| row.get(0),
            )
            .optional()?;
        let effective_at = owner_state
            .flatten()
            .map_or(deleted_at, |stored| stored.min(deleted_at));
        let topic_ids = {
            let mut statement = transaction.prepare(
                "SELECT topic_id FROM topics
                 WHERE owner_type=?1 AND owner_id=?2
                 ORDER BY topic_id",
            )?;
            let rows = statement.query_map(params![owner_type.as_str(), owner_id], |row| {
                row.get::<_, String>(0)
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };

        for topic_id in topic_ids {
            mark_topic_deleted(
                &transaction,
                &TopicKey {
                    owner_type,
                    owner_id: owner_id.to_string(),
                    topic_id,
                },
                effective_at,
            )?;
        }

        let owner_changed = owner_state != Some(Some(effective_at));

        if owner_changed {
            transaction.execute(
                "INSERT INTO owners(
                    owner_type, owner_id, display_name, config_path, config_hash, content_hash,
                    updated_at, deleted_at
                 ) VALUES(?1, ?2, '', '', '', '', ?3, ?3)
                 ON CONFLICT(owner_type, owner_id) DO UPDATE SET
                    content_hash='',
                    deleted_at=excluded.deleted_at,
                    updated_at=MAX(owners.updated_at, excluded.updated_at)",
                params![owner_type.as_str(), owner_id, effective_at],
            )?;
        }

        mark_avatar_deleted(
            &transaction,
            &AvatarKey {
                owner_type: avatar_owner_type_from_owner(owner_type),
                owner_id: owner_id.to_string(),
            },
            effective_at,
        )?;

        transaction.commit()?;
        Ok(())
    }

    /// Persists a topic tombstone received from MobileSync. The exact owner is
    /// mandatory at the protocol boundary.
    pub fn apply_sync_topic_tombstone(&self, key: &TopicKey, deleted_at: i64) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        mark_topic_deleted(&transaction, key, deleted_at)?;
        recompute_owner_content_hash(
            &transaction,
            &OwnerKey {
                owner_type: key.owner_type,
                owner_id: key.owner_id.clone(),
            },
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn mark_source_invalid(
        &self,
        source: &TopicSource,
        error: &str,
        owner_hash_mode: OwnerHashMode,
    ) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO history_sources(
                source_path, owner_type, owner_id, topic_id, mtime_ns, file_size,
                source_hash, last_revision, indexed_at, status, last_error
             ) VALUES(?1, ?2, ?3, ?4, 0, 0, NULL, 0, ?5, 'invalid', ?6)
             ON CONFLICT(source_path) DO UPDATE SET
                indexed_at=excluded.indexed_at,
                status='invalid',
                last_error=excluded.last_error",
            params![
                source.source_path.to_string_lossy(),
                source.key.owner_type.as_str(),
                source.key.owner_id,
                source.key.topic_id,
                now_ms(),
                truncate_error(error),
            ],
        )?;
        if owner_hash_mode == OwnerHashMode::Immediate {
            recompute_owner_content_hash(
                &transaction,
                &OwnerKey {
                    owner_type: source.key.owner_type,
                    owner_id: source.key.owner_id.clone(),
                },
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn refresh_unchanged_history_source(
        &self,
        source: &TopicSource,
        mtime_ns: i64,
        file_size: i64,
        source_hash: &str,
        owner_hash_mode: OwnerHashMode,
    ) -> Result<Option<IngestCommit>> {
        let now = now_ms();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous: Option<(Option<String>, String)> = transaction
            .query_row(
                "SELECT source_hash, status FROM history_sources
                 WHERE source_path=?1 AND owner_type=?2 AND owner_id=?3 AND topic_id=?4",
                params![
                    source.source_path.to_string_lossy(),
                    source.key.owner_type.as_str(),
                    source.key.owner_id,
                    source.key.topic_id,
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((Some(previous_hash), previous_status)) = previous else {
            transaction.commit()?;
            return Ok(None);
        };
        if previous_hash != source_hash || !matches!(previous_status.as_str(), "ready" | "missing")
        {
            transaction.commit()?;
            return Ok(None);
        }

        let updated = transaction.execute(
            "UPDATE history_sources SET
                mtime_ns=?2, file_size=?3, indexed_at=?4, status='ready', last_error=NULL
             WHERE source_path=?1 AND owner_type=?5 AND owner_id=?6 AND topic_id=?7",
            params![
                source.source_path.to_string_lossy(),
                mtime_ns,
                file_size,
                now,
                source.key.owner_type.as_str(),
                source.key.owner_id,
                source.key.topic_id,
            ],
        )?;
        anyhow::ensure!(
            updated == 1,
            "history source identity changed during refresh"
        );
        let (revision, indexed_revision) = transaction
            .query_row(
                "SELECT content_revision, indexed_revision FROM topics
                 WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3",
                params![
                    source.key.owner_type.as_str(),
                    source.key.owner_id,
                    source.key.topic_id,
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .unwrap_or((0, 0));
        if previous_status != "ready" && owner_hash_mode == OwnerHashMode::Immediate {
            recompute_owner_content_hash(
                &transaction,
                &OwnerKey {
                    owner_type: source.key.owner_type,
                    owner_id: source.key.owner_id.clone(),
                },
            )?;
        }
        transaction.commit()?;
        Ok(Some(IngestCommit {
            topic: source.key.clone(),
            revision,
            changed: false,
            owner_hash_dirty: previous_status != "ready",
            search_update: SearchUpdate::for_revision_gap(revision, indexed_revision),
            message_count: 0,
        }))
    }

    pub fn ingest_topic(
        &self,
        source: &TopicSource,
        messages: &[NormalizedMessage],
        mtime_ns: i64,
        file_size: i64,
        source_hash: &str,
        owner_hash_mode: OwnerHashMode,
    ) -> Result<IngestCommit> {
        let now = now_ms();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let owner_key = OwnerKey {
            owner_type: source.key.owner_type,
            owner_id: source.key.owner_id.clone(),
        };
        anyhow::ensure!(
            !owner_is_tombstoned(&transaction, &owner_key)?
                && !topic_is_tombstoned_in_transaction(&transaction, &source.key)?,
            "history source owner or topic is deleted"
        );
        ensure_history_source_identity_available(&transaction, source)?;

        let previous_source: Option<(Option<String>, String)> = transaction
            .query_row(
                "SELECT source_hash, status FROM history_sources
                 WHERE source_path=?1 AND owner_type=?2 AND owner_id=?3 AND topic_id=?4",
                params![
                    source.source_path.to_string_lossy(),
                    source.key.owner_type.as_str(),
                    source.key.owner_id,
                    source.key.topic_id,
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let previous_hash = previous_source
            .as_ref()
            .and_then(|(source_hash, _)| source_hash.as_deref());
        let source_was_ready = previous_source
            .as_ref()
            .is_some_and(|(_, status)| status == "ready");

        if previous_hash == Some(source_hash) && source_was_ready {
            transaction.execute(
                "UPDATE history_sources SET
                    mtime_ns=?2, file_size=?3, indexed_at=?4, status='ready', last_error=NULL
                 WHERE source_path=?1",
                params![
                    source.source_path.to_string_lossy(),
                    mtime_ns,
                    file_size,
                    now
                ],
            )?;
            let (revision, indexed_revision) = transaction
                .query_row(
                    "SELECT content_revision, indexed_revision FROM topics
                     WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3",
                    params![
                        source.key.owner_type.as_str(),
                        source.key.owner_id,
                        source.key.topic_id,
                    ],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .unwrap_or((0, 0));
            if !source_was_ready && owner_hash_mode == OwnerHashMode::Immediate {
                recompute_owner_content_hash(
                    &transaction,
                    &OwnerKey {
                        owner_type: source.key.owner_type,
                        owner_id: source.key.owner_id.clone(),
                    },
                )?;
            }
            transaction.commit()?;
            return Ok(IngestCommit {
                topic: source.key.clone(),
                revision,
                changed: false,
                owner_hash_dirty: !source_was_ready,
                search_update: SearchUpdate::for_revision_gap(revision, indexed_revision),
                message_count: messages.len(),
            });
        }

        let existing = load_active_message_states(&transaction, &source.key)?;
        // Physical history is detection input, not an undelete protocol.
        let tombstoned_ids = load_message_tombstone_ids(&transaction, &source.key)?;
        let incoming_ids: HashSet<&str> = messages
            .iter()
            .filter(|message| !tombstoned_ids.contains(message.msg_id.as_str()))
            .map(|message| message.msg_id.as_str())
            .collect();
        let mut search_requires_rewrite = existing
            .keys()
            .any(|message_id| !incoming_ids.contains(message_id.as_str()));
        let mut appended_row_ids = Vec::new();
        let search_changed = search_requires_rewrite
            || messages
                .iter()
                .filter(|message| incoming_ids.contains(message.msg_id.as_str()))
                .any(|message| {
                    existing.get(&message.msg_id).is_none_or(|previous| {
                        previous.content_text != message.content_text
                            || previous.speaker_name != message.speaker_name
                    })
                });
        let (previous_content_hash, previous_content_revision, previous_indexed_revision) =
            transaction.query_row(
                "SELECT content_hash, content_revision, indexed_revision FROM topics
             WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3",
                params![
                    source.key.owner_type.as_str(),
                    source.key.owner_id,
                    source.key.topic_id,
                ],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )?;
        let revision = if search_changed {
            next_global_revision(&transaction)?
        } else {
            previous_content_revision
        };
        {
            let mut delete_message = transaction.prepare_cached(
                "UPDATE messages SET message_hash='', deleted_at=?2, updated_at=?2 WHERE row_id=?1",
            )?;
            for (msg_id, previous) in &existing {
                if !incoming_ids.contains(msg_id.as_str()) {
                    delete_message.execute(params![previous.row_id, now])?;
                }
            }
        }

        {
            let mut upsert_message = transaction.prepare_cached(
                "INSERT INTO messages(
                    owner_type, owner_id, topic_id, msg_id, ordinal, role,
                    speaker_name, speaker_agent_id, content_raw, content_text,
                    timestamp, message_hash, metadata_json, updated_at, deleted_at
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL)
                 ON CONFLICT(owner_type, owner_id, topic_id, msg_id) DO UPDATE SET
                    ordinal=excluded.ordinal,
                    role=excluded.role,
                    speaker_name=excluded.speaker_name,
                    speaker_agent_id=excluded.speaker_agent_id,
                    content_raw=excluded.content_raw,
                    content_text=excluded.content_text,
                    timestamp=excluded.timestamp,
                    message_hash=excluded.message_hash,
                    metadata_json=excluded.metadata_json,
                    updated_at=excluded.updated_at,
                    deleted_at=NULL",
            )?;
            for message in messages {
                if tombstoned_ids.contains(message.msg_id.as_str()) {
                    continue;
                }
                let effective_updated_at = resolve_message_updated_at(
                    message,
                    existing
                        .get(&message.msg_id)
                        .map(|previous| (previous.message_hash.as_str(), previous.updated_at)),
                    now,
                );
                let previous = existing.get(&message.msg_id);
                let needs_write = previous.is_none_or(|previous| {
                    previous.ordinal != message.ordinal
                        || previous.speaker_name != message.speaker_name
                        || previous.content_text != message.content_text
                        || previous.message_hash != message.message_hash
                        || previous.metadata_json != message.metadata_json
                        || previous.updated_at != effective_updated_at
                });
                if !needs_write {
                    continue;
                }
                upsert_message.execute(params![
                    source.key.owner_type.as_str(),
                    source.key.owner_id,
                    source.key.topic_id,
                    message.msg_id,
                    message.ordinal,
                    message.role,
                    message.speaker_name,
                    message.speaker_agent_id,
                    message.content_raw,
                    message.content_text,
                    message.timestamp,
                    message.message_hash,
                    message.metadata_json,
                    effective_updated_at,
                ])?;
                if previous.is_none() {
                    appended_row_ids.push(transaction.last_insert_rowid());
                } else if previous.is_some_and(|previous| {
                    previous.content_text != message.content_text
                        || previous.speaker_name != message.speaker_name
                }) {
                    search_requires_rewrite = true;
                }
            }
        }

        let topic_content_hash = aggregate_hash(
            messages
                .iter()
                .filter(|message| incoming_ids.contains(message.msg_id.as_str()))
                .map(|message| message_leaf_hash(&message.msg_id, &message.message_hash))
                .collect(),
        );
        let topic_hash_changed = previous_content_hash != topic_content_hash;
        if topic_hash_changed || previous_content_revision != revision {
            let changed = transaction.execute(
                "UPDATE topics SET
                    content_hash=?4,
                    content_revision=?5
                 WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3
                   AND deleted_at IS NULL",
                params![
                    source.key.owner_type.as_str(),
                    source.key.owner_id,
                    source.key.topic_id,
                    topic_content_hash,
                    revision,
                ],
            )?;
            anyhow::ensure!(changed == 1, "history source topic is missing or deleted");
        }

        transaction.execute(
            "INSERT INTO history_sources(
                source_path, owner_type, owner_id, topic_id, mtime_ns, file_size,
                source_hash, last_revision, indexed_at, status, last_error
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'ready', NULL)
             ON CONFLICT(source_path) DO UPDATE SET
                owner_type=excluded.owner_type,
                owner_id=excluded.owner_id,
                topic_id=excluded.topic_id,
                mtime_ns=excluded.mtime_ns,
                file_size=excluded.file_size,
                source_hash=excluded.source_hash,
                last_revision=excluded.last_revision,
                indexed_at=excluded.indexed_at,
                status='ready',
                last_error=NULL",
            params![
                source.source_path.to_string_lossy(),
                source.key.owner_type.as_str(),
                source.key.owner_id,
                source.key.topic_id,
                mtime_ns,
                file_size,
                source_hash,
                revision,
                now,
            ],
        )?;

        let owner_hash_dirty = topic_hash_changed || !source_was_ready;
        if owner_hash_dirty && owner_hash_mode == OwnerHashMode::Immediate {
            recompute_owner_content_hash(
                &transaction,
                &OwnerKey {
                    owner_type: source.key.owner_type,
                    owner_id: source.key.owner_id.clone(),
                },
            )?;
        }

        transaction.commit()?;
        let search_update = if previous_content_revision > previous_indexed_revision {
            SearchUpdate::Rewrite
        } else if !search_changed {
            SearchUpdate::None
        } else if !search_requires_rewrite
            && !appended_row_ids.is_empty()
            && previous_indexed_revision == previous_content_revision
        {
            SearchUpdate::Append(appended_row_ids)
        } else {
            SearchUpdate::Rewrite
        };
        Ok(IngestCommit {
            topic: source.key.clone(),
            revision,
            changed: true,
            owner_hash_dirty,
            search_update,
            message_count: incoming_ids.len(),
        })
    }

    pub fn refresh_owner_content_hash(&self, key: &OwnerKey) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        recompute_owner_content_hash(&transaction, key)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn mark_topics_indexed(&self, topics: &[(TopicKey, i64)]) -> Result<()> {
        if topics.is_empty() {
            return Ok(());
        }
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for (key, revision) in topics {
            transaction.execute(
                "UPDATE topics SET indexed_revision=?4
                 WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3
                   AND content_revision<=?4",
                params![
                    key.owner_type.as_str(),
                    key.owner_id,
                    key.topic_id,
                    revision
                ],
            )?;
        }
        let revision = topics
            .iter()
            .map(|(_, revision)| *revision)
            .max()
            .unwrap_or(0);
        transaction.execute(
            "INSERT INTO service_meta(key, value) VALUES('tantivy_index_revision', ?1)
             ON CONFLICT(key) DO UPDATE SET
                value=CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)",
            [revision.to_string()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn topic_revision_state(&self, key: &TopicKey) -> Result<Option<(i64, i64)>> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT content_revision, indexed_revision FROM topics
                 WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3",
                params![key.owner_type.as_str(), key.owner_id, key.topic_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn topics_needing_index(&self) -> Result<Vec<(TopicKey, i64)>> {
        // Deleted topics must pass through update_topic once: it removes the
        // composite Topic term and writes no replacement documents.
        self.load_topic_revisions("WHERE content_revision > indexed_revision")
    }

    pub fn all_active_topic_revisions(&self) -> Result<Vec<(TopicKey, i64)>> {
        self.load_topic_revisions("WHERE deleted_at IS NULL")
    }

    fn load_topic_revisions(&self, filter: &str) -> Result<Vec<(TopicKey, i64)>> {
        let connection = self.connection.lock();
        let sql = format!(
            "SELECT owner_type, owner_id, topic_id, content_revision
             FROM topics {filter}"
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map([], |row| {
            Ok((
                TopicKey {
                    owner_type: parse_owner_type(row.get::<_, String>(0)?),
                    owner_id: row.get(1)?,
                    topic_id: row.get(2)?,
                },
                row.get(3)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    pub fn active_messages_for_topic(&self, key: &TopicKey) -> Result<Vec<MessageView>> {
        let connection = self.connection.lock();
        load_message_views(
            &connection,
            "WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3 AND deleted_at IS NULL
             ORDER BY ordinal ASC",
            params![key.owner_type.as_str(), key.owner_id, key.topic_id],
        )
    }

    pub fn messages_by_row_ids(&self, row_ids: &[i64]) -> Result<HashMap<i64, MessageView>> {
        if row_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let connection = self.connection.lock();
        let placeholders = std::iter::repeat_n("?", row_ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT row_id, owner_type, owner_id, topic_id, msg_id, ordinal, role,
                    speaker_name, speaker_agent_id, content_raw, content_text,
                    timestamp, metadata_json
             FROM messages
             WHERE row_id IN ({placeholders}) AND deleted_at IS NULL"
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(rusqlite::params_from_iter(row_ids), message_from_row)?;
        let messages: Vec<MessageView> = rows.collect::<rusqlite::Result<_>>()?;
        Ok(messages
            .into_iter()
            .map(|message| (message.row_id, message))
            .collect())
    }

    pub fn context_messages(
        &self,
        key: &TopicKey,
        start_ordinal: i64,
        end_ordinal: i64,
    ) -> Result<Vec<MessageView>> {
        let connection = self.connection.lock();
        load_message_views(
            &connection,
            "WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3
               AND ordinal BETWEEN ?4 AND ?5 AND deleted_at IS NULL
             ORDER BY ordinal ASC",
            params![
                key.owner_type.as_str(),
                key.owner_id,
                key.topic_id,
                start_ordinal,
                end_ordinal
            ],
        )
    }

    pub fn topic_name(&self, key: &TopicKey) -> Result<Option<String>> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT display_name FROM topics
                 WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3",
                params![key.owner_type.as_str(), key.owner_id, key.topic_id],
                |row| row.get(0),
            )
            .optional()
            .map(|value| value.flatten())
            .map_err(Into::into)
    }

    pub fn topic_is_tombstoned(&self, key: &TopicKey) -> Result<bool> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM topics
                    WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3
                      AND deleted_at IS NOT NULL
                 )",
                params![key.owner_type.as_str(), key.owner_id, key.topic_id],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    pub(crate) fn message_tombstone_ids(&self, key: &TopicKey) -> Result<HashSet<String>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT msg_id FROM messages
             WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3
               AND deleted_at IS NOT NULL",
        )?;
        let rows = statement.query_map(
            params![key.owner_type.as_str(), key.owner_id, key.topic_id],
            |row| row.get(0),
        )?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    pub fn topic_recovery_definition(&self, key: &TopicKey) -> Result<Option<TopicDefinition>> {
        let connection = self.connection.lock();
        let row = connection
            .query_row(
                "SELECT display_name, created_at, topic_ordinal, config_hash, metadata_json
                 FROM topics
                 WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3
                   AND deleted_at IS NULL",
                params![key.owner_type.as_str(), key.owner_id, key.topic_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((display_name, created_at, ordinal, config_hash, Some(metadata_json))) = row
        else {
            return Ok(None);
        };
        let metadata = serde_json::from_str(&metadata_json)
            .context("stored topic recovery metadata is invalid")?;
        Ok(Some(TopicDefinition {
            topic_id: key.topic_id.clone(),
            display_name,
            created_at,
            ordinal,
            config_hash,
            metadata,
        }))
    }

    pub fn owner_by_id(
        &self,
        owner_type: OwnerType,
        owner_id: &str,
    ) -> Result<Option<(String, String)>> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT owner_id, display_name FROM owners
                 WHERE owner_type=?1 AND owner_id=?2 AND deleted_at IS NULL",
                params![owner_type.as_str(), owner_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn resolve_owner_ids_by_name(
        &self,
        owner_type: OwnerType,
        name: &str,
    ) -> Result<Vec<(String, String)>> {
        let connection = self.connection.lock();
        let exact: Vec<(String, String)> = {
            let mut statement = connection.prepare(
                "SELECT owner_id, display_name FROM owners
                 WHERE owner_type=?1 AND deleted_at IS NULL AND display_name=?2",
            )?;
            let rows = statement.query_map(params![owner_type.as_str(), name], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        if !exact.is_empty() {
            return Ok(exact);
        }
        let pattern = format!("%{name}%");
        let mut statement = connection.prepare(
            "SELECT owner_id, display_name FROM owners
             WHERE owner_type=?1 AND deleted_at IS NULL AND display_name LIKE ?2",
        )?;
        let rows = statement.query_map(params![owner_type.as_str(), pattern], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
        let matches = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(matches)
    }

    pub fn stats(&self) -> Result<DatabaseStats> {
        let connection = self.connection.lock();
        Ok(DatabaseStats {
            owners: connection.query_row(
                "SELECT COUNT(*) FROM owners WHERE deleted_at IS NULL",
                [],
                |row| row.get(0),
            )?,
            topics: connection.query_row(
                "SELECT COUNT(*) FROM topics WHERE deleted_at IS NULL",
                [],
                |row| row.get(0),
            )?,
            messages: connection.query_row(
                "SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL",
                [],
                |row| row.get(0),
            )?,
            content_revision: meta_i64(&connection, "global_content_revision")?,
            indexed_revision: meta_i64(&connection, "tantivy_index_revision")?,
            last_reconcile_at: meta_optional_i64(&connection, "last_reconcile_at")?,
        })
    }

    pub fn set_last_reconcile_at(&self, timestamp: i64) -> Result<()> {
        let connection = self.connection.lock();
        connection.execute(
            "INSERT INTO service_meta(key, value) VALUES('last_reconcile_at', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [timestamp.to_string()],
        )?;
        Ok(())
    }

    pub fn checkpoint(&self) -> Result<()> {
        let connection = self.connection.lock();
        connection.execute_batch("PRAGMA wal_checkpoint(PASSIVE);")?;
        Ok(())
    }
}

fn compute_topic_content_hash(transaction: &Transaction<'_>, key: &TopicKey) -> Result<String> {
    let mut statement = transaction.prepare(
        "SELECT msg_id, message_hash FROM messages
         WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3 AND deleted_at IS NULL",
    )?;
    let leaves = statement
        .query_map(
            params![key.owner_type.as_str(), key.owner_id, key.topic_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .map(|row| {
            let (message_id, message_hash) = row?;
            Ok(message_leaf_hash(&message_id, &message_hash))
        })
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(aggregate_hash(leaves))
}

fn compute_owner_content_hash(transaction: &Transaction<'_>, key: &OwnerKey) -> Result<String> {
    let mut statement = transaction.prepare(
        "SELECT t.topic_id, t.config_hash, t.content_hash, t.source_path, hs.status
         FROM topics t
         LEFT JOIN history_sources hs
           ON hs.source_path=t.source_path
          AND hs.owner_type=t.owner_type
          AND hs.owner_id=t.owner_id
          AND hs.topic_id=t.topic_id
         WHERE t.owner_type=?1 AND t.owner_id=?2 AND t.deleted_at IS NULL",
    )?;
    let topics = statement
        .query_map(params![key.owner_type.as_str(), key.owner_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let leaves = topics
        .into_iter()
        .map(
            |(topic_id, config_hash, content_hash, source_path, source_status)| {
                let topic_key = TopicKey {
                    owner_type: key.owner_type,
                    owner_id: key.owner_id.clone(),
                    topic_id,
                };
                let effective_content_hash = match source_status.as_deref() {
                    Some("ready") => content_hash,
                    Some(_) => unhealthy_topic_sentinel_hash(&topic_key),
                    None if Path::new(&source_path).exists() => {
                        unhealthy_topic_sentinel_hash(&topic_key)
                    }
                    None => content_hash,
                };
                topic_leaf_hash(&topic_key.topic_id, &config_hash, &effective_content_hash)
            },
        )
        .collect();
    Ok(aggregate_hash(leaves))
}

fn recompute_owner_content_hash(transaction: &Transaction<'_>, key: &OwnerKey) -> Result<()> {
    let content_hash = compute_owner_content_hash(transaction, key)?;
    let changed = transaction.execute(
        "UPDATE owners SET content_hash=?3
         WHERE owner_type=?1 AND owner_id=?2 AND deleted_at IS NULL",
        params![key.owner_type.as_str(), key.owner_id, content_hash],
    )?;
    anyhow::ensure!(
        changed == 1,
        "owner content hash target is missing or deleted"
    );
    Ok(())
}

fn migrate_sync_hash_contract(transaction: &Transaction<'_>) -> Result<()> {
    let stored_version = transaction
        .query_row(
            "SELECT value FROM service_meta WHERE key='schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    anyhow::ensure!(
        stored_version <= SCHEMA_VERSION,
        "database schema {stored_version} is newer than runtime schema {SCHEMA_VERSION}"
    );
    if stored_version >= 3 {
        return Ok(());
    }

    if !table_has_column(transaction, "owners", "content_hash")? {
        transaction.execute_batch(
            "ALTER TABLE owners ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';",
        )?;
    }
    if !table_has_column(transaction, "history_sources", "source_hash")? {
        anyhow::ensure!(
            table_has_column(transaction, "history_sources", "content_hash")?,
            "history_sources is missing its physical source hash"
        );
        transaction.execute_batch(
            "ALTER TABLE history_sources RENAME COLUMN content_hash TO source_hash;",
        )?;
    }
    transaction.execute_batch("DROP INDEX IF EXISTS idx_messages_hash;")?;

    let messages = {
        let mut statement = transaction.prepare(
            "SELECT row_id, owner_type, owner_id, topic_id, metadata_json, deleted_at
             FROM messages",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    TopicKey {
                        owner_type: parse_owner_type(row.get::<_, String>(1)?),
                        owner_id: row.get(2)?,
                        topic_id: row.get(3)?,
                    },
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mut invalid_topics = HashMap::new();
    for (row_id, key, metadata_json, deleted_at) in messages {
        let message_hash = if deleted_at.is_some() {
            String::new()
        } else {
            match stored_message_fingerprint(&metadata_json, &key.topic_id) {
                Ok(hash) => hash,
                Err(error) => {
                    invalid_topics.entry(key.clone()).or_insert_with(|| {
                        truncate_error(&format!("stored message is not syncable: {error:#}"))
                    });
                    String::new()
                }
            }
        };
        transaction.execute(
            "UPDATE messages SET message_hash=?2 WHERE row_id=?1",
            params![row_id, message_hash],
        )?;
    }
    for (key, error) in invalid_topics {
        transaction.execute(
            "UPDATE history_sources SET indexed_at=?4, status='invalid', last_error=?5
             WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3",
            params![
                key.owner_type.as_str(),
                key.owner_id,
                key.topic_id,
                now_ms(),
                error,
            ],
        )?;
    }

    let topics = {
        let mut statement =
            transaction.prepare("SELECT owner_type, owner_id, topic_id, deleted_at FROM topics")?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    TopicKey {
                        owner_type: parse_owner_type(row.get::<_, String>(0)?),
                        owner_id: row.get(1)?,
                        topic_id: row.get(2)?,
                    },
                    row.get::<_, Option<i64>>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (key, deleted_at) in topics {
        let content_hash = if deleted_at.is_some() {
            String::new()
        } else {
            compute_topic_content_hash(transaction, &key)?
        };
        transaction.execute(
            "UPDATE topics SET content_hash=?4
             WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3",
            params![
                key.owner_type.as_str(),
                key.owner_id,
                key.topic_id,
                content_hash
            ],
        )?;
    }

    let owners = {
        let mut statement =
            transaction.prepare("SELECT owner_type, owner_id, deleted_at FROM owners")?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    OwnerKey {
                        owner_type: parse_owner_type(row.get::<_, String>(0)?),
                        owner_id: row.get(1)?,
                    },
                    row.get::<_, Option<i64>>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (key, deleted_at) in owners {
        if deleted_at.is_some() {
            transaction.execute(
                "UPDATE owners SET content_hash=''
                 WHERE owner_type=?1 AND owner_id=?2",
                params![key.owner_type.as_str(), key.owner_id],
            )?;
        } else {
            recompute_owner_content_hash(transaction, &key)?;
        }
    }
    Ok(())
}

fn table_has_column(transaction: &Transaction<'_>, table: &str, column: &str) -> Result<bool> {
    let mut statement = transaction.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(columns.iter().any(|name| name == column))
}

fn owner_is_tombstoned(transaction: &Transaction<'_>, key: &OwnerKey) -> Result<bool> {
    transaction
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM owners
                WHERE owner_type=?1 AND owner_id=?2 AND deleted_at IS NOT NULL
             )",
            params![key.owner_type.as_str(), key.owner_id],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn ensure_history_source_identity_available(
    transaction: &Transaction<'_>,
    source: &TopicSource,
) -> Result<()> {
    let existing: Option<(String, String, String)> = transaction
        .query_row(
            "SELECT owner_type, owner_id, topic_id
             FROM history_sources WHERE source_path=?1",
            [source.source_path.to_string_lossy().as_ref()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if let Some((owner_type, owner_id, topic_id)) = existing {
        anyhow::ensure!(
            owner_type == source.key.owner_type.as_str()
                && owner_id == source.key.owner_id
                && topic_id == source.key.topic_id,
            "history source identity conflict at {}: stored={owner_type}/{owner_id}/{topic_id}, expected={}/{}/{}",
            source.source_path.display(),
            source.key.owner_type.as_str(),
            source.key.owner_id,
            source.key.topic_id,
        );
    }
    Ok(())
}

fn topic_is_tombstoned_in_transaction(
    transaction: &Transaction<'_>,
    key: &TopicKey,
) -> Result<bool> {
    transaction
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM topics
                WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3
                  AND deleted_at IS NOT NULL
             )",
            params![key.owner_type.as_str(), key.owner_id, key.topic_id],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn mark_avatar_deleted(
    transaction: &Transaction<'_>,
    key: &AvatarKey,
    deleted_at: i64,
) -> Result<()> {
    transaction.execute(
        "INSERT INTO avatars(
            owner_type, owner_id, file_path, hash, updated_at, deleted_at
         ) VALUES(?1, ?2, '', ?3, ?4, ?4)
         ON CONFLICT(owner_type, owner_id) DO UPDATE SET
            updated_at=CASE
                WHEN avatars.deleted_at IS NULL THEN excluded.deleted_at
                ELSE MIN(avatars.updated_at, excluded.deleted_at)
            END,
            deleted_at=CASE
                WHEN avatars.deleted_at IS NULL THEN excluded.deleted_at
                ELSE MIN(avatars.deleted_at, excluded.deleted_at)
            END",
        params![
            key.owner_type.as_str(),
            key.owner_id,
            AVATAR_TOMBSTONE_HASH,
            deleted_at,
        ],
    )?;
    Ok(())
}

fn mark_owner_deleted(
    transaction: &Transaction<'_>,
    key: &OwnerKey,
    deleted_at: i64,
) -> Result<bool> {
    let live = transaction
        .query_row(
            "SELECT 1 FROM owners
             WHERE owner_type=?1 AND owner_id=?2 AND deleted_at IS NULL",
            params![key.owner_type.as_str(), key.owner_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !live {
        return Ok(false);
    }

    let topic_ids = {
        let mut statement = transaction.prepare(
            "SELECT topic_id FROM topics
             WHERE owner_type=?1 AND owner_id=?2 AND deleted_at IS NULL",
        )?;
        let rows = statement.query_map(params![key.owner_type.as_str(), key.owner_id], |row| {
            row.get(0)
        })?;
        rows.collect::<rusqlite::Result<Vec<String>>>()?
    };
    for topic_id in topic_ids {
        mark_topic_deleted(
            transaction,
            &TopicKey {
                owner_type: key.owner_type,
                owner_id: key.owner_id.clone(),
                topic_id,
            },
            deleted_at,
        )?;
    }
    transaction.execute(
        "UPDATE owners SET content_hash='', deleted_at=?3, updated_at=?3
         WHERE owner_type=?1 AND owner_id=?2 AND deleted_at IS NULL",
        params![key.owner_type.as_str(), key.owner_id, deleted_at],
    )?;
    mark_avatar_deleted(
        transaction,
        &AvatarKey {
            owner_type: avatar_owner_type_from_owner(key.owner_type),
            owner_id: key.owner_id.clone(),
        },
        deleted_at,
    )?;
    Ok(true)
}

fn mark_topic_deleted(
    transaction: &Transaction<'_>,
    key: &TopicKey,
    deleted_at: i64,
) -> Result<()> {
    let topic_state: Option<Option<i64>> = transaction
        .query_row(
            "SELECT deleted_at FROM topics
             WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3",
            params![key.owner_type.as_str(), key.owner_id, key.topic_id],
            |row| row.get(0),
        )
        .optional()?;
    let topic_effective_at = topic_state
        .flatten()
        .map_or(deleted_at, |stored| stored.min(deleted_at));
    let topic_row_changed = topic_state.is_some_and(|state| state != Some(topic_effective_at));
    let topic_changed = topic_state != Some(Some(topic_effective_at));
    let active_messages = load_active_message_ids(transaction, key)?;

    if !topic_changed && active_messages.is_empty() {
        return Ok(());
    }

    let stored_rows_changed = topic_row_changed || !active_messages.is_empty();
    let revision = if stored_rows_changed {
        next_global_revision(transaction)?
    } else {
        current_global_revision(transaction)?
    };
    for (_, row_id) in active_messages {
        transaction.execute(
            "UPDATE messages SET message_hash='', deleted_at=?2, updated_at=MAX(updated_at, ?2)
             WHERE row_id=?1",
            params![row_id, topic_effective_at],
        )?;
    }

    if topic_state.is_none() {
        let owner_exists = transaction
            .query_row(
                "SELECT 1 FROM owners WHERE owner_type=?1 AND owner_id=?2",
                params![key.owner_type.as_str(), key.owner_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        anyhow::ensure!(owner_exists, "topic tombstone owner is missing");
        transaction.execute(
            "INSERT INTO topics(
                owner_type, owner_id, topic_id, display_name, created_at,
                topic_ordinal, config_hash, metadata_json, content_hash,
                source_path, content_revision, indexed_revision, updated_at, deleted_at
             ) VALUES(?1, ?2, ?3, NULL, NULL, 0, '', '{}', '', '', ?4, ?4, ?5, ?5)",
            params![
                key.owner_type.as_str(),
                key.owner_id,
                key.topic_id,
                revision,
                topic_effective_at,
            ],
        )?;
    } else if stored_rows_changed {
        transaction.execute(
            "UPDATE topics SET
                content_hash='',
                deleted_at=?4,
                updated_at=MAX(updated_at, ?4),
                content_revision=?5
             WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3",
            params![
                key.owner_type.as_str(),
                key.owner_id,
                key.topic_id,
                topic_effective_at,
                revision,
            ],
        )?;
    }

    Ok(())
}

fn current_global_revision(transaction: &Transaction<'_>) -> Result<i64> {
    transaction
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM service_meta
             WHERE key='global_content_revision'",
            [],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn next_global_revision(transaction: &Transaction<'_>) -> Result<i64> {
    let current = current_global_revision(transaction)?;
    let next = current + 1;
    transaction.execute(
        "UPDATE service_meta SET value=?1 WHERE key='global_content_revision'",
        [next.to_string()],
    )?;
    Ok(next)
}

struct ActiveMessageState {
    row_id: i64,
    ordinal: i64,
    message_hash: String,
    updated_at: i64,
    content_text: String,
    speaker_name: Option<String>,
    metadata_json: String,
}

fn load_active_message_states(
    transaction: &Transaction<'_>,
    key: &TopicKey,
) -> Result<HashMap<String, ActiveMessageState>> {
    let mut statement = transaction.prepare(
        "SELECT msg_id, row_id, ordinal, message_hash, updated_at,
                content_text, speaker_name, metadata_json
         FROM messages
         WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3 AND deleted_at IS NULL",
    )?;
    let rows = statement.query_map(
        params![key.owner_type.as_str(), key.owner_id, key.topic_id],
        |row| {
            Ok((
                row.get(0)?,
                ActiveMessageState {
                    row_id: row.get(1)?,
                    ordinal: row.get(2)?,
                    message_hash: row.get(3)?,
                    updated_at: row.get(4)?,
                    content_text: row.get(5)?,
                    speaker_name: row.get(6)?,
                    metadata_json: row.get(7)?,
                },
            ))
        },
    )?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

fn load_message_tombstone_ids(
    transaction: &Transaction<'_>,
    key: &TopicKey,
) -> Result<HashSet<String>> {
    let mut statement = transaction.prepare(
        "SELECT msg_id FROM messages
         WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3 AND deleted_at IS NOT NULL",
    )?;
    let rows = statement.query_map(
        params![key.owner_type.as_str(), key.owner_id, key.topic_id],
        |row| row.get(0),
    )?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

fn resolve_message_updated_at(
    message: &NormalizedMessage,
    previous: Option<(&str, i64)>,
    detected_at: i64,
) -> i64 {
    if let Some(physical) = message.updated_at {
        return physical;
    }
    match previous {
        None => message
            .timestamp
            .filter(|value| *value >= 0)
            .unwrap_or(detected_at),
        Some((previous_hash, previous_updated_at)) if previous_hash == message.message_hash => {
            previous_updated_at
        }
        Some(_) => detected_at,
    }
}

fn load_active_message_ids(
    transaction: &Transaction<'_>,
    key: &TopicKey,
) -> Result<HashMap<String, i64>> {
    let mut statement = transaction.prepare(
        "SELECT msg_id, row_id FROM messages
         WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3 AND deleted_at IS NULL",
    )?;
    let rows = statement.query_map(
        params![key.owner_type.as_str(), key.owner_id, key.topic_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

fn load_message_views<P: rusqlite::Params>(
    connection: &Connection,
    suffix: &str,
    parameters: P,
) -> Result<Vec<MessageView>> {
    let sql = format!(
        "SELECT row_id, owner_type, owner_id, topic_id, msg_id, ordinal, role,
                speaker_name, speaker_agent_id, content_raw, content_text,
                timestamp, metadata_json
         FROM messages {suffix}"
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(parameters, message_from_row)?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

fn message_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MessageView> {
    let metadata_json: String = row.get(12)?;
    Ok(MessageView {
        row_id: row.get(0)?,
        owner_type: parse_owner_type(row.get::<_, String>(1)?),
        owner_id: row.get(2)?,
        topic_id: row.get(3)?,
        msg_id: row.get(4)?,
        ordinal: row.get(5)?,
        role: row.get(6)?,
        speaker_name: row.get(7)?,
        speaker_agent_id: row.get(8)?,
        content_raw: row.get(9)?,
        content_text: row.get(10)?,
        timestamp: row.get(11)?,
        metadata: serde_json::from_str(&metadata_json).unwrap_or(Value::Null),
    })
}

fn parse_owner_type(value: String) -> OwnerType {
    if value == "group" {
        OwnerType::Group
    } else {
        OwnerType::Agent
    }
}

fn parse_avatar_owner_type(value: String) -> AvatarOwnerType {
    match value.as_str() {
        "group" => AvatarOwnerType::Group,
        "user" => AvatarOwnerType::User,
        _ => AvatarOwnerType::Agent,
    }
}

const fn avatar_owner_type_from_owner(owner_type: OwnerType) -> AvatarOwnerType {
    match owner_type {
        OwnerType::Agent => AvatarOwnerType::Agent,
        OwnerType::Group => AvatarOwnerType::Group,
    }
}

fn meta_i64(connection: &Connection, key: &str) -> Result<i64> {
    let value: String = connection.query_row(
        "SELECT value FROM service_meta WHERE key=?1",
        [key],
        |row| row.get(0),
    )?;
    Ok(value.parse().unwrap_or(0))
}

fn meta_optional_i64(connection: &Connection, key: &str) -> Result<Option<i64>> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM service_meta WHERE key=?1",
            [key],
            |row| row.get(0),
        )
        .optional()?;
    Ok(value.and_then(|value| value.parse().ok()))
}

fn truncate_error(error: &str) -> String {
    error.chars().take(500).collect()
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normalized_message(
        hash: &str,
        timestamp: Option<i64>,
        updated_at: Option<i64>,
    ) -> NormalizedMessage {
        NormalizedMessage {
            msg_id: "message-a".to_string(),
            ordinal: 0,
            role: "user".to_string(),
            speaker_name: None,
            speaker_agent_id: None,
            content_raw: "content".to_string(),
            content_text: "content".to_string(),
            timestamp,
            updated_at,
            message_hash: hash.to_string(),
            metadata_json: "{}".to_string(),
        }
    }

    fn test_database() -> (tempfile::TempDir, Database) {
        let directory = tempfile::tempdir().expect("create temp database directory");
        let database =
            Database::open(&directory.path().join("chat.sqlite3")).expect("open test database");
        (directory, database)
    }

    #[test]
    fn v1_tombstones_collapse_into_natural_rows() {
        let directory = tempfile::tempdir().expect("create temp database directory");
        let path = directory.path().join("chat.sqlite3");
        {
            let connection = Connection::open(&path).expect("open v1 database");
            connection
                .execute_batch(
                    "CREATE TABLE tombstones (
                        entity_type TEXT NOT NULL,
                        owner_type TEXT NOT NULL DEFAULT '',
                        owner_id TEXT NOT NULL DEFAULT '',
                        topic_id TEXT NOT NULL DEFAULT '',
                        entity_id TEXT NOT NULL,
                        deleted_at INTEGER NOT NULL,
                        origin TEXT NOT NULL,
                        PRIMARY KEY (entity_type, owner_type, owner_id, topic_id, entity_id)
                     );
                     CREATE TABLE service_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                     INSERT INTO service_meta VALUES('schema_version', '1');
                     INSERT INTO tombstones VALUES
                        ('owner', 'agent', 'agent-a', '', 'agent-a', 90, 'sync'),
                        ('topic', 'agent', 'agent-a', 'topic-a', 'topic-a', 80, 'sync'),
                        ('message', 'agent', 'agent-a', 'topic-a', 'message-a', 70, 'sync'),
                        ('topic', 'group', 'missing-owner', 'orphan', 'orphan', 60, 'sync');",
                )
                .expect("seed v1 tombstones");
        }

        let database = Database::open(&path).expect("upgrade v1 database");
        let connection = database.connection.lock();
        let tombstone_table: bool = connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master
                    WHERE type='table' AND name='tombstones'
                 )",
                [],
                |row| row.get(0),
            )
            .expect("query legacy table");
        assert!(!tombstone_table);
        let state: (i64, i64, i64, String, i64) = connection
            .query_row(
                "SELECT
                    (SELECT deleted_at FROM owners
                     WHERE owner_type='agent' AND owner_id='agent-a'),
                    (SELECT deleted_at FROM topics
                     WHERE owner_type='agent' AND owner_id='agent-a' AND topic_id='topic-a'),
                    (SELECT deleted_at FROM messages
                     WHERE owner_type='agent' AND owner_id='agent-a'
                       AND topic_id='topic-a' AND msg_id='message-a'),
                    (SELECT value FROM service_meta WHERE key='schema_version'),
                    (SELECT COUNT(*) FROM topics
                     WHERE owner_type='group' AND owner_id='missing-owner' AND topic_id='orphan')",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .expect("query collapsed state");
        assert_eq!(state, (90, 80, 70, "3".to_string(), 0));
    }

    #[test]
    fn v2_hash_columns_migrate_to_wire_roots_without_touching_search_revisions() {
        let directory = tempfile::tempdir().expect("create temp database directory");
        let path = directory.path().join("chat.sqlite3");
        let metadata = r#"{"id":"message-a","role":"user","content":"hello","timestamp":1}"#;
        drop(Database::open(&path).expect("create current schema"));
        {
            let connection = Connection::open(&path).expect("open v2 database");
            connection
                .execute_batch(
                    "ALTER TABLE owners DROP COLUMN content_hash;
                     ALTER TABLE history_sources RENAME COLUMN source_hash TO content_hash;
                     CREATE INDEX idx_messages_hash ON messages(message_hash);
                     UPDATE service_meta SET value='2' WHERE key='schema_version';
                     UPDATE service_meta SET value='7' WHERE key='global_content_revision';
                     UPDATE service_meta SET value='7' WHERE key='tantivy_index_revision';
                     INSERT INTO owners VALUES(
                        'agent', 'agent-a', 'Agent', 'config.json', 'owner-config', 1, NULL
                     );
                     INSERT INTO topics(
                        owner_type, owner_id, topic_id, display_name, created_at, topic_ordinal,
                        config_hash, metadata_json, content_hash, source_path, content_revision,
                        indexed_revision, updated_at, deleted_at
                     ) VALUES('agent', 'agent-a', 'topic-a', 'Topic', 1, 0, 'topic-config', '{}',
                        'physical-history-hash', 'history.json', 7, 7, 1, NULL);
                     INSERT INTO history_sources VALUES('history.json', 'agent', 'agent-a',
                        'topic-a', 1, 1, 'physical-history-hash', 7, 1, 'ready', NULL);",
                )
                .expect("seed v2 schema");
            connection
                .execute(
                    "INSERT INTO messages(
                        owner_type, owner_id, topic_id, msg_id, ordinal, role,
                        content_raw, content_text, timestamp, message_hash, metadata_json,
                        updated_at, deleted_at
                     ) VALUES('agent', 'agent-a', 'topic-a', 'message-a', 0, 'user',
                        'hello', 'hello', 1, 'legacy-ingest-hash', ?1, 1, NULL)",
                    [metadata],
                )
                .expect("seed v2 message");
        }

        let database = Database::open(&path).expect("upgrade v2 database");
        let expected_message =
            stored_message_fingerprint(metadata, "topic-a").expect("wire message hash");
        let expected_topic =
            aggregate_hash(vec![message_leaf_hash("message-a", &expected_message)]);
        let expected_owner = aggregate_hash(vec![topic_leaf_hash(
            "topic-a",
            "topic-config",
            &expected_topic,
        )]);
        let connection = database.connection.lock();
        let state: (String, String, String, String, i64, i64, bool) = connection
            .query_row(
                "SELECT
                    (SELECT message_hash FROM messages WHERE msg_id='message-a'),
                    (SELECT content_hash FROM topics WHERE topic_id='topic-a'),
                    (SELECT content_hash FROM owners WHERE owner_id='agent-a'),
                    (SELECT source_hash FROM history_sources WHERE source_path='history.json'),
                    (SELECT content_revision FROM topics WHERE topic_id='topic-a'),
                    (SELECT indexed_revision FROM topics WHERE topic_id='topic-a'),
                    EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_messages_hash')",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .expect("read migrated hash state");
        assert_eq!(
            state,
            (
                expected_message,
                expected_topic,
                expected_owner,
                "physical-history-hash".to_string(),
                7,
                7,
                false,
            )
        );
    }

    #[test]
    fn message_update_time_uses_physical_timestamp_index_or_detection_in_order() {
        let detected_at = 400;
        assert_eq!(
            resolve_message_updated_at(
                &normalized_message("new", Some(100), Some(500)),
                Some(("old", 200)),
                detected_at,
            ),
            500
        );
        assert_eq!(
            resolve_message_updated_at(
                &normalized_message("new", Some(100), None),
                None,
                detected_at,
            ),
            100
        );
        assert_eq!(
            resolve_message_updated_at(
                &normalized_message("same", Some(100), None),
                Some(("same", 200)),
                detected_at,
            ),
            200
        );
        assert_eq!(
            resolve_message_updated_at(
                &normalized_message("new", Some(100), None),
                Some(("old", 200)),
                detected_at,
            ),
            400
        );
    }

    #[test]
    fn physical_ingest_does_not_revive_message_rows_or_tombstone_only_ids() {
        let (_directory, database) = test_database();
        let key = TopicKey {
            owner_type: OwnerType::Agent,
            owner_id: "agent-a".to_string(),
            topic_id: "topic-a".to_string(),
        };
        let source = TopicSource {
            key: key.clone(),
            source_path: PathBuf::from("topic-a/history.json"),
        };
        {
            let connection = database.connection.lock();
            connection
                .execute_batch(
                    "INSERT INTO owners(
                        owner_type, owner_id, display_name, config_path, config_hash,
                        updated_at, deleted_at
                     ) VALUES('agent', 'agent-a', 'Agent', 'config.json', 'owner-hash', 1, NULL);
                     INSERT INTO topics(
                        owner_type, owner_id, topic_id, config_hash, metadata_json,
                        source_path, updated_at, deleted_at
                     ) VALUES(
                        'agent', 'agent-a', 'topic-a', 'config-hash', '{}',
                        'topic-a/history.json', 1, NULL
                     );
                     INSERT INTO messages(
                        owner_type, owner_id, topic_id, msg_id, ordinal, role,
                        content_raw, content_text, message_hash, metadata_json,
                        updated_at, deleted_at
                     ) VALUES(
                        'agent', 'agent-a', 'topic-a', 'message-a', 0, 'user',
                        'old', 'old', 'old-hash', '{}', 10, 11
                     ), (
                        'agent', 'agent-a', 'topic-a', 'message-never-seen', 1, '',
                        '', '', '', '{}', 22, 22
                     );",
                )
                .expect("seed topic and message tombstones");
        }

        let mut restored = normalized_message("hash-restored", Some(1), Some(30));
        let mut never_seen = normalized_message("hash-never-seen", Some(2), Some(30));
        never_seen.msg_id = "message-never-seen".to_string();
        never_seen.ordinal = 1;
        let mut new_message = normalized_message("hash-new", Some(3), Some(30));
        new_message.msg_id = "message-new".to_string();
        new_message.ordinal = 2;
        restored.ordinal = 0;

        let commit = database
            .ingest_topic(
                &source,
                &[restored, never_seen, new_message],
                3,
                3,
                "source-stale-save",
                OwnerHashMode::Immediate,
            )
            .expect("ingest stale physical history");
        assert_eq!(commit.message_count, 1);

        let connection = database.connection.lock();
        let state: (Option<i64>, Option<i64>, i64, i64) = connection
            .query_row(
                "SELECT
                    (SELECT deleted_at FROM messages
                     WHERE owner_type='agent' AND owner_id='agent-a'
                       AND topic_id='topic-a' AND msg_id='message-a'),
                    (SELECT deleted_at FROM messages
                     WHERE owner_type='agent' AND owner_id='agent-a'
                       AND topic_id='topic-a' AND msg_id='message-never-seen'),
                    (SELECT COUNT(*) FROM messages
                     WHERE owner_type='agent' AND owner_id='agent-a'
                       AND topic_id='topic-a' AND msg_id='message-new'
                       AND deleted_at IS NULL),
                    (SELECT COUNT(*) FROM messages
                     WHERE owner_type='agent' AND owner_id='agent-a'
                       AND topic_id='topic-a' AND deleted_at IS NOT NULL)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("query post-ingest state");
        assert_eq!(
            state,
            (Some(11), Some(22), 1, 2),
            "physical ingest must preserve natural-row tombstones and accept only the new message"
        );
    }

    #[test]
    fn sync_owner_tombstone_persists_missing_owner_and_keeps_earliest_time() {
        let (_directory, database) = test_database();

        database
            .apply_sync_owner_tombstone(OwnerType::Agent, "agent-a", 200)
            .expect("persist missing owner tombstone");

        let accepted = database
            .upsert_owner(
                &OwnerRecord {
                    key: OwnerKey {
                        owner_type: OwnerType::Agent,
                        owner_id: "agent-a".to_string(),
                    },
                    display_name: "Agent".to_string(),
                    config_path: PathBuf::from("agent-a/config.json"),
                    config_hash: "owner-hash".to_string(),
                    source_config_hash: None,
                    topics: Vec::new(),
                },
                OwnerHashMode::Immediate,
            )
            .expect("attempt physical owner ingest");
        assert!(
            !accepted,
            "ordinary owner ingest must preserve the tombstone"
        );

        {
            let connection = database.connection.lock();
            let owners: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM owners
                     WHERE owner_type='agent' AND owner_id='agent-a'",
                    [],
                    |row| row.get(0),
                )
                .expect("count owner rows");
            assert_eq!(owners, 1);
            let deleted_at: i64 = connection
                .query_row(
                    "SELECT deleted_at FROM owners
                     WHERE owner_type='agent' AND owner_id='agent-a'",
                    [],
                    |row| row.get(0),
                )
                .expect("query owner tombstone");
            assert_eq!(deleted_at, 200);
        }

        database
            .apply_sync_owner_tombstone(OwnerType::Agent, "agent-a", 300)
            .expect("replay owner tombstone");

        database
            .apply_sync_owner_tombstone(OwnerType::Agent, "agent-a", 100)
            .expect("apply earlier owner tombstone");
        let connection = database.connection.lock();
        let deleted_at: i64 = connection
            .query_row(
                "SELECT deleted_at FROM owners
                 WHERE owner_type='agent' AND owner_id='agent-a'",
                [],
                |row| row.get(0),
            )
            .expect("query earliest owner tombstone");
        assert_eq!(deleted_at, 100);
    }

    #[test]
    fn sync_topic_tombstone_persists_missing_topic_with_exact_owner() {
        let (_directory, database) = test_database();
        let key = TopicKey {
            owner_type: OwnerType::Group,
            owner_id: "group-a".to_string(),
            topic_id: "topic-a".to_string(),
        };

        assert!(database
            .upsert_owner(
                &OwnerRecord {
                    key: OwnerKey {
                        owner_type: key.owner_type,
                        owner_id: key.owner_id.clone(),
                    },
                    display_name: "Group".to_string(),
                    config_path: PathBuf::from("group-a/config.json"),
                    config_hash: "owner-hash".to_string(),
                    source_config_hash: None,
                    topics: Vec::new(),
                },
                OwnerHashMode::Immediate
            )
            .expect("seed live owner"));

        database
            .apply_sync_topic_tombstone(&key, 321)
            .expect("persist missing topic tombstone");

        {
            let connection = database.connection.lock();
            let owner_rows: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM owners
                     WHERE owner_type='group' AND owner_id='group-a'",
                    [],
                    |row| row.get(0),
                )
                .expect("count owner rows");
            assert_eq!(owner_rows, 1);
            let topic_rows: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM topics
                     WHERE owner_type='group' AND owner_id='group-a' AND topic_id='topic-a'",
                    [],
                    |row| row.get(0),
                )
                .expect("count topic rows");
            assert_eq!(topic_rows, 1);
            let tombstone: i64 = connection
                .query_row(
                    "SELECT deleted_at FROM topics
                     WHERE owner_type='group' AND owner_id='group-a' AND topic_id='topic-a'",
                    [],
                    |row| row.get(0),
                )
                .expect("query topic tombstone");
            assert_eq!(tombstone, 321);
        }

        let topic = TopicDefinition {
            topic_id: key.topic_id.clone(),
            display_name: Some("Topic".to_string()),
            created_at: Some(1),
            ordinal: 0,
            config_hash: "topic-hash".to_string(),
            metadata: Value::Object(Default::default()),
        };
        assert!(database
            .upsert_owner(
                &OwnerRecord {
                    key: OwnerKey {
                        owner_type: key.owner_type,
                        owner_id: key.owner_id.clone(),
                    },
                    display_name: "Group".to_string(),
                    config_path: PathBuf::from("group-a/config.json"),
                    config_hash: "owner-hash".to_string(),
                    source_config_hash: None,
                    topics: vec![topic],
                },
                OwnerHashMode::Immediate
            )
            .expect("ingest live owner around tombstoned topic"));
        let source = TopicSource {
            key: key.clone(),
            source_path: PathBuf::from("topic-a/history.json"),
        };
        assert!(
            database
                .ingest_topic(&source, &[], 1, 0, "source-hash", OwnerHashMode::Immediate,)
                .is_err(),
            "history ingest must fail closed for a tombstoned topic"
        );

        database
            .apply_sync_topic_tombstone(&key, 400)
            .expect("replay topic tombstone");
        let connection = database.connection.lock();
        let deleted_at: i64 = connection
            .query_row(
                "SELECT deleted_at FROM topics
                 WHERE owner_type='group' AND owner_id='group-a' AND topic_id='topic-a'",
                [],
                |row| row.get(0),
            )
            .expect("query idempotent topic tombstone");
        assert_eq!(deleted_at, 321);
    }

    #[test]
    fn sync_owner_tombstone_cascades_into_default_topic_internally() {
        let (_directory, database) = test_database();
        {
            let connection = database.connection.lock();
            connection
                .execute_batch(
                    "INSERT INTO owners(
                        owner_type, owner_id, display_name, config_path, config_hash,
                        updated_at, deleted_at
                     ) VALUES('agent', 'agent-default', 'Agent', 'config.json', 'hash', 10, NULL);
                     INSERT INTO topics(
                        owner_type, owner_id, topic_id, config_hash, metadata_json,
                        source_path, updated_at, deleted_at
                     ) VALUES(
                        'agent', 'agent-default', 'default', 'hash', '{}',
                        'default/history.json', 10, NULL
                     );
                     INSERT INTO messages(
                        owner_type, owner_id, topic_id, msg_id, ordinal, role,
                        content_raw, content_text, message_hash, metadata_json,
                        updated_at, deleted_at
                     ) VALUES(
                        'agent', 'agent-default', 'default', 'message-default', 0, 'user',
                        'content', 'content', 'hash', '{}', 10, NULL
                     );",
                )
                .expect("seed default topic");
        }

        database
            .apply_sync_owner_tombstone(OwnerType::Agent, "agent-default", 200)
            .expect("apply owner tombstone");

        let connection = database.connection.lock();
        let state: (Option<i64>, Option<i64>, Option<i64>) = connection
            .query_row(
                "SELECT o.deleted_at, t.deleted_at, m.deleted_at
                 FROM owners o
                 JOIN topics t USING(owner_type, owner_id)
                 JOIN messages m
                   USING(owner_type, owner_id, topic_id)
                 WHERE t.owner_type='agent' AND t.owner_id='agent-default'
                   AND t.topic_id='default'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("query default state");
        assert_eq!(state, (Some(200), Some(200), Some(200)));
    }

    #[test]
    fn sync_owner_tombstone_cascades_atomically_without_touching_other_owner() {
        let (_directory, database) = test_database();
        {
            let connection = database.connection.lock();
            connection
                .execute_batch(
                    "INSERT INTO owners(
                        owner_type, owner_id, display_name, config_path, config_hash,
                        updated_at, deleted_at
                     ) VALUES
                        ('agent', 'agent-a', 'A', 'a.json', 'a', 10, NULL),
                        ('agent', 'agent-b', 'B', 'b.json', 'b', 10, NULL);
                     INSERT INTO topics(
                        owner_type, owner_id, topic_id, config_hash, metadata_json,
                        source_path, updated_at, deleted_at
                     ) VALUES
                        ('agent', 'agent-a', 'topic-a', 'a', '{}', 'a/history.json', 10, NULL),
                        ('agent', 'agent-a', 'topic-b', 'b', '{}', 'b/history.json', 300, 300),
                        ('agent', 'agent-b', 'topic-other', 'c', '{}', 'c/history.json', 10, NULL);
                     INSERT INTO messages(
                        owner_type, owner_id, topic_id, msg_id, ordinal, role,
                        content_raw, content_text, message_hash, metadata_json,
                        updated_at, deleted_at
                     ) VALUES
                        ('agent', 'agent-a', 'topic-a', 'message-a', 0, 'user',
                         'a', 'a', 'a', '{}', 10, NULL),
                        ('agent', 'agent-a', 'topic-b', 'message-b', 0, 'user',
                         'b', 'b', 'b', '{}', 250, 250),
                        ('agent', 'agent-a', 'topic-a', 'message-missing', 1, '',
                         '', '', '', '{}', 250, 250),
                        ('agent', 'agent-b', 'topic-other', 'message-other', 0, 'user',
                         'c', 'c', 'c', '{}', 10, NULL);",
                )
                .expect("seed owner cascade rows");
        }

        database
            .apply_sync_owner_tombstone(OwnerType::Agent, "agent-a", 200)
            .expect("cascade owner tombstone");

        {
            let connection = database.connection.lock();
            let owner_deleted: i64 = connection
                .query_row(
                    "SELECT deleted_at FROM owners
                     WHERE owner_type='agent' AND owner_id='agent-a'",
                    [],
                    |row| row.get(0),
                )
                .expect("query deleted owner");
            assert_eq!(owner_deleted, 200);
            let topic_states = {
                let mut statement = connection
                    .prepare(
                        "SELECT topic_id, deleted_at FROM topics
                         WHERE owner_type='agent' AND owner_id='agent-a'
                         ORDER BY topic_id",
                    )
                    .expect("prepare topic state query");
                statement
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    })
                    .expect("query topic states")
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .expect("collect topic states")
            };
            assert_eq!(
                topic_states,
                vec![("topic-a".to_string(), 200), ("topic-b".to_string(), 200)]
            );
            let message_states = {
                let mut statement = connection
                    .prepare(
                        "SELECT msg_id, deleted_at FROM messages
                         WHERE owner_type='agent' AND owner_id='agent-a'
                         ORDER BY msg_id",
                    )
                    .expect("prepare message state query");
                statement
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    })
                    .expect("query message states")
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .expect("collect message states")
            };
            assert_eq!(
                message_states,
                vec![
                    ("message-a".to_string(), 200),
                    // The owner tombstone already deletes the whole subtree; do not
                    // rewrite timestamps for messages already deleted independently.
                    ("message-b".to_string(), 250),
                    ("message-missing".to_string(), 250),
                ]
            );
            let other_state: (Option<i64>, Option<i64>, Option<i64>) = connection
                .query_row(
                    "SELECT o.deleted_at, t.deleted_at, m.deleted_at
                     FROM owners o
                     JOIN topics t USING(owner_type, owner_id)
                     JOIN messages m USING(owner_type, owner_id, topic_id)
                     WHERE o.owner_type='agent' AND o.owner_id='agent-b'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("query unrelated owner");
            assert_eq!(other_state, (None, None, None));
        }

        database
            .apply_sync_owner_tombstone(OwnerType::Agent, "agent-a", 400)
            .expect("replay cascade tombstone");
        let connection = database.connection.lock();
        let state: (i64, i64) = connection
            .query_row(
                "SELECT deleted_at,
                        (SELECT COUNT(*) FROM messages
                         WHERE owner_type='agent' AND owner_id='agent-a'
                           AND deleted_at IS NOT NULL)
                 FROM owners
                 WHERE owner_type='agent' AND owner_id='agent-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("query cascade after idempotent replay");
        assert_eq!(state, (200, 3));
    }
}
