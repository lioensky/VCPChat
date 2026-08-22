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
        MessageView, NormalizedMessage, OwnerKey, OwnerRecord, OwnerType, TopicKey, TopicSource,
    },
};

const MIGRATION_V1: &str = r#"
CREATE TABLE IF NOT EXISTS owners (
    owner_type TEXT NOT NULL CHECK(owner_type IN ('agent', 'group')),
    owner_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    config_path TEXT NOT NULL,
    config_hash TEXT NOT NULL,
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
    content_hash TEXT,
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

CREATE INDEX IF NOT EXISTS idx_messages_topic_timestamp
ON messages(owner_type, owner_id, topic_id, timestamp);

CREATE INDEX IF NOT EXISTS idx_messages_hash
ON messages(message_hash);

CREATE INDEX IF NOT EXISTS idx_messages_speaker_agent
ON messages(speaker_agent_id);

CREATE TABLE IF NOT EXISTS history_sources (
    source_path TEXT PRIMARY KEY,
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    mtime_ns INTEGER NOT NULL,
    file_size INTEGER NOT NULL,
    content_hash TEXT,
    last_revision INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    last_error TEXT,
    FOREIGN KEY (owner_type, owner_id, topic_id)
        REFERENCES topics(owner_type, owner_id, topic_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_attachments (
    message_row_id INTEGER NOT NULL,
    attachment_order INTEGER NOT NULL,
    content_hash TEXT,
    display_name TEXT,
    mime_type TEXT,
    file_path TEXT,
    metadata_json TEXT NOT NULL,
    created_at INTEGER,
    PRIMARY KEY (message_row_id, attachment_order),
    FOREIGN KEY (message_row_id)
        REFERENCES messages(row_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tombstones (
    entity_type TEXT NOT NULL,
    owner_type TEXT NOT NULL DEFAULT '',
    owner_id TEXT NOT NULL DEFAULT '',
    topic_id TEXT NOT NULL DEFAULT '',
    entity_id TEXT NOT NULL,
    deleted_at INTEGER NOT NULL,
    expires_at INTEGER,
    origin TEXT NOT NULL,
    PRIMARY KEY (entity_type, owner_type, owner_id, topic_id, entity_id)
);

CREATE TABLE IF NOT EXISTS change_log (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    operation TEXT NOT NULL,
    owner_type TEXT,
    owner_id TEXT,
    topic_id TEXT,
    entity_id TEXT,
    revision INTEGER NOT NULL,
    origin TEXT NOT NULL,
    changed_at INTEGER NOT NULL,
    payload_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_change_log_owner_sequence
ON change_log(owner_type, owner_id, sequence);

CREATE TABLE IF NOT EXISTS service_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

#[derive(Debug, Clone)]
pub struct SourceMetadata {
    pub mtime_ns: i64,
    pub file_size: i64,
    pub status: String,
}

#[derive(Debug, Clone)]
pub struct IngestCommit {
    pub topic: TopicKey,
    pub revision: i64,
    pub changed: bool,
    pub removed_row_ids: Vec<i64>,
    pub message_count: usize,
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
        transaction.execute_batch(MIGRATION_V1)?;
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

    pub fn upsert_owner(&self, owner: &OwnerRecord) -> Result<()> {
        let now = now_ms();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        transaction.execute(
            "INSERT INTO owners(
                owner_type, owner_id, display_name, config_path, config_hash, updated_at, deleted_at
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, NULL)
             ON CONFLICT(owner_type, owner_id) DO UPDATE SET
                display_name=excluded.display_name,
                config_path=excluded.config_path,
                config_hash=excluded.config_hash,
                updated_at=CASE
                    WHEN owners.display_name IS NOT excluded.display_name
                      OR owners.config_path IS NOT excluded.config_path
                      OR owners.config_hash IS NOT excluded.config_hash
                      OR owners.deleted_at IS NOT NULL
                    THEN excluded.updated_at
                    ELSE owners.updated_at
                END,
                deleted_at=NULL",
            params![
                owner.key.owner_type.as_str(),
                owner.key.owner_id,
                owner.display_name,
                owner.config_path.to_string_lossy(),
                owner.config_hash,
                now,
            ],
        )?;
        transaction.execute(
            "DELETE FROM tombstones
             WHERE entity_type='owner' AND owner_type=?1 AND owner_id=?2
               AND topic_id='' AND entity_id=?2",
            params![owner.key.owner_type.as_str(), owner.key.owner_id],
        )?;

        let active_topic_ids: HashSet<&str> = owner
            .topics
            .iter()
            .map(|topic| topic.topic_id.as_str())
            .collect();
        for topic in &owner.topics {
            let source_path = owner
                .config_path
                .parent()
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
                    updated_at=CASE
                        WHEN topics.display_name IS NOT excluded.display_name
                          OR topics.created_at IS NOT excluded.created_at
                          OR topics.topic_ordinal IS NOT excluded.topic_ordinal
                          OR topics.config_hash IS NOT excluded.config_hash
                          OR topics.metadata_json IS NOT excluded.metadata_json
                          OR topics.deleted_at IS NOT NULL
                        THEN excluded.updated_at
                        ELSE topics.updated_at
                    END,
                    deleted_at=NULL",
                params![
                    owner.key.owner_type.as_str(),
                    owner.key.owner_id,
                    topic.topic_id,
                    topic.display_name,
                    topic.created_at,
                    topic.ordinal,
                    owner.config_hash,
                    topic.metadata.to_string(),
                    source_path.to_string_lossy(),
                    now,
                ],
            )?;
            transaction.execute(
                "DELETE FROM tombstones
                 WHERE entity_type='topic' AND owner_type=?1 AND owner_id=?2
                   AND topic_id=?3 AND entity_id=?3",
                params![
                    owner.key.owner_type.as_str(),
                    owner.key.owner_id,
                    topic.topic_id,
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
                    "reconcile",
                    now,
                )?;
            }
        }

        transaction.commit()?;
        Ok(())
    }

    pub fn upsert_topic_source(&self, source: &TopicSource) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
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
                    WHEN topics.display_name IS NOT excluded.display_name
                      OR topics.created_at IS NOT excluded.created_at
                      OR topics.topic_ordinal IS NOT excluded.topic_ordinal
                      OR topics.config_hash IS NOT excluded.config_hash
                      OR topics.metadata_json IS NOT excluded.metadata_json
                      OR topics.source_path IS NOT excluded.source_path
                      OR topics.deleted_at IS NOT NULL
                    THEN excluded.updated_at
                    ELSE topics.updated_at
                END,
                deleted_at=NULL",
            params![
                source.key.owner_type.as_str(),
                source.key.owner_id,
                source.key.topic_id,
                source.display_name,
                source.created_at,
                source.topic_ordinal,
                source.config_hash,
                source.topic_metadata.to_string(),
                source.source_path.to_string_lossy(),
                now_ms(),
            ],
        )?;
        transaction.execute(
            "DELETE FROM tombstones
             WHERE entity_type='topic' AND owner_type=?1 AND owner_id=?2
               AND topic_id=?3 AND entity_id=?3",
            params![
                source.key.owner_type.as_str(),
                source.key.owner_id,
                source.key.topic_id,
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn reconcile_missing_owners(
        &self,
        active: &HashSet<OwnerKey>,
        origin: &str,
    ) -> Result<usize> {
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

            let topic_ids = {
                let mut statement = transaction.prepare(
                    "SELECT topic_id FROM topics
                     WHERE owner_type=?1 AND owner_id=?2 AND deleted_at IS NULL",
                )?;
                let rows = statement
                    .query_map(params![owner.owner_type.as_str(), owner.owner_id], |row| {
                        row.get(0)
                    })?;
                rows.collect::<rusqlite::Result<Vec<String>>>()?
            };
            for topic_id in topic_ids {
                mark_topic_deleted(
                    &transaction,
                    &TopicKey {
                        owner_type: owner.owner_type,
                        owner_id: owner.owner_id.clone(),
                        topic_id,
                    },
                    origin,
                    now,
                )?;
            }

            // Owner metadata itself has no Tantivy documents. Topic deletions above
            // already advance the searchable content revision; an owner with no
            // topics can reuse the current revision without creating a permanent
            // content/index revision gap.
            let revision = current_global_revision(&transaction)?;
            transaction.execute(
                "UPDATE owners SET deleted_at=?3, updated_at=?3
                 WHERE owner_type=?1 AND owner_id=?2 AND deleted_at IS NULL",
                params![owner.owner_type.as_str(), owner.owner_id, now],
            )?;
            transaction.execute(
                "INSERT INTO tombstones(
                    entity_type, owner_type, owner_id, topic_id, entity_id,
                    deleted_at, expires_at, origin
                 ) VALUES('owner', ?1, ?2, '', ?2, ?3, ?4, ?5)
                 ON CONFLICT(entity_type, owner_type, owner_id, topic_id, entity_id)
                 DO UPDATE SET deleted_at=excluded.deleted_at,
                               expires_at=excluded.expires_at,
                               origin=excluded.origin",
                params![
                    owner.owner_type.as_str(),
                    owner.owner_id,
                    now,
                    tombstone_expiry(now),
                    origin,
                ],
            )?;
            transaction.execute(
                "INSERT INTO change_log(
                    entity_type, operation, owner_type, owner_id, topic_id,
                    entity_id, revision, origin, changed_at, payload_json
                 ) VALUES('owner', 'delete', ?1, ?2, NULL, ?2, ?3, ?4, ?5, NULL)",
                params![
                    owner.owner_type.as_str(),
                    owner.owner_id,
                    revision,
                    origin,
                    now,
                ],
            )?;
            deleted += 1;
        }

        transaction.commit()?;
        Ok(deleted)
    }

    pub fn source_metadata(&self, source_path: &Path) -> Result<Option<SourceMetadata>> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT mtime_ns, file_size, status
                 FROM history_sources WHERE source_path=?1",
                [source_path.to_string_lossy().as_ref()],
                |row| {
                    Ok(SourceMetadata {
                        mtime_ns: row.get(0)?,
                        file_size: row.get(1)?,
                        status: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn mark_history_source_missing(
        &self,
        source: &TopicSource,
        origin: &str,
    ) -> Result<Option<IngestCommit>> {
        let now = now_ms();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let previous: Option<(Option<String>, String)> = transaction
            .query_row(
                "SELECT content_hash, status FROM history_sources WHERE source_path=?1",
                [source.source_path.to_string_lossy().as_ref()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((previous_hash, previous_status)) = previous else {
            transaction.commit()?;
            return Ok(None);
        };
        if previous_hash.is_none() || previous_status == "missing" {
            transaction.commit()?;
            return Ok(None);
        }

        let revision = next_global_revision(&transaction)?;
        let existing = load_active_message_ids(&transaction, &source.key)?;
        let mut removed_row_ids = Vec::with_capacity(existing.len());
        for (msg_id, row_id) in existing {
            transaction.execute(
                "UPDATE messages SET deleted_at=?2, updated_at=?2 WHERE row_id=?1",
                params![row_id, now],
            )?;
            upsert_message_tombstone(&transaction, &source.key, &msg_id, origin, now)?;
            append_change(
                &transaction,
                "message",
                "delete",
                &source.key,
                Some(&msg_id),
                revision,
                origin,
                now,
                Some(r#"{"reason":"history_source_missing"}"#),
            )?;
            removed_row_ids.push(row_id);
        }

        transaction.execute(
            "UPDATE topics SET
                content_hash=NULL,
                content_revision=?4,
                updated_at=?5
             WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3",
            params![
                source.key.owner_type.as_str(),
                source.key.owner_id,
                source.key.topic_id,
                revision,
                now,
            ],
        )?;
        transaction.execute(
            "UPDATE history_sources SET
                mtime_ns=0,
                file_size=0,
                content_hash=NULL,
                last_revision=?2,
                indexed_at=?3,
                status='missing',
                last_error=NULL
             WHERE source_path=?1",
            params![source.source_path.to_string_lossy(), revision, now,],
        )?;
        append_change(
            &transaction,
            "topic",
            "update",
            &source.key,
            Some(&source.key.topic_id),
            revision,
            origin,
            now,
            Some(r#"{"historyStatus":"missing","messageCount":0}"#),
        )?;

        transaction.commit()?;
        Ok(Some(IngestCommit {
            topic: source.key.clone(),
            revision,
            changed: true,
            removed_row_ids,
            message_count: 0,
        }))
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
        origin: &str,
    ) -> Result<Option<i64>> {
        if tombstones.is_empty() {
            return Ok(None);
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

        let now = now_ms();
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
            let message_deleted_at = message_state.flatten();
            let stored_deleted_at: Option<i64> = transaction
                .query_row(
                    "SELECT deleted_at FROM tombstones
                     WHERE entity_type='message' AND owner_type=?1 AND owner_id=?2
                       AND topic_id=?3 AND entity_id=?4",
                    params![key.owner_type.as_str(), key.owner_id, key.topic_id, msg_id],
                    |row| row.get(0),
                )
                .optional()?;
            let effective_at = stored_deleted_at
                .into_iter()
                .chain(message_deleted_at)
                .fold(*requested_at, i64::min);
            let needs_update = stored_deleted_at != Some(effective_at)
                || (message_state.is_some() && message_deleted_at != Some(effective_at));
            if needs_update {
                updates.push((msg_id.clone(), effective_at, message_state.is_some()));
            }
        }

        if updates.is_empty() {
            transaction.commit()?;
            return Ok(None);
        }

        let revision = next_global_revision(&transaction)?;
        for (msg_id, deleted_at, message_exists) in updates {
            if message_exists {
                let changed = transaction.execute(
                    "UPDATE messages SET deleted_at=?5, updated_at=?6
                     WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3 AND msg_id=?4
                       AND deleted_at IS NOT NULL",
                    params![
                        key.owner_type.as_str(),
                        key.owner_id,
                        key.topic_id,
                        msg_id,
                        deleted_at,
                        now,
                    ],
                )?;
                anyhow::ensure!(
                    changed == 1,
                    "explicit message tombstone {msg_id} did not update exactly one deleted row"
                );
            }
            upsert_message_tombstone(&transaction, key, &msg_id, origin, deleted_at)?;
            append_change(
                &transaction,
                "message",
                "delete",
                key,
                Some(&msg_id),
                revision,
                origin,
                deleted_at,
                Some(r#"{"reason":"explicit_mobile_sync"}"#),
            )?;
        }
        let changed = transaction.execute(
            "UPDATE topics SET content_revision=?4, updated_at=?5
             WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3
               AND deleted_at IS NULL",
            params![
                key.owner_type.as_str(),
                key.owner_id,
                key.topic_id,
                revision,
                now,
            ],
        )?;
        anyhow::ensure!(
            changed == 1,
            "explicit message tombstones did not update exactly one live topic"
        );
        transaction.commit()?;
        Ok(Some(revision))
    }

    /// Persists an owner tombstone received from MobileSync and cascades it to
    /// every topic/message row currently known to CDS.
    pub fn apply_sync_owner_tombstone(
        &self,
        owner_type: OwnerType,
        owner_id: &str,
        deleted_at: i64,
        origin: &str,
    ) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let topic_ids = {
            let mut statement = transaction.prepare(
                "SELECT topic_id FROM topics
                 WHERE owner_type=?1 AND owner_id=?2
                 UNION
                 SELECT topic_id FROM tombstones
                 WHERE entity_type IN ('topic', 'message')
                   AND owner_type=?1 AND owner_id=?2
                   AND topic_id<>''
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
                origin,
                deleted_at,
            )?;
        }

        let owner_state: Option<Option<i64>> = transaction
            .query_row(
                "SELECT deleted_at FROM owners WHERE owner_type=?1 AND owner_id=?2",
                params![owner_type.as_str(), owner_id],
                |row| row.get(0),
            )
            .optional()?;
        let stored_tombstone: Option<i64> = transaction
            .query_row(
                "SELECT deleted_at FROM tombstones
                 WHERE entity_type='owner' AND owner_type=?1 AND owner_id=?2
                   AND topic_id='' AND entity_id=?2",
                params![owner_type.as_str(), owner_id],
                |row| row.get(0),
            )
            .optional()?;
        let effective_at = stored_tombstone
            .into_iter()
            .chain(owner_state.flatten())
            .fold(deleted_at, i64::min);
        let owner_changed = owner_state.is_some_and(|state| state != Some(effective_at))
            || stored_tombstone != Some(effective_at);

        if owner_changed {
            transaction.execute(
                "UPDATE owners SET
                    deleted_at=?3,
                    updated_at=MAX(updated_at, ?3)
                 WHERE owner_type=?1 AND owner_id=?2",
                params![owner_type.as_str(), owner_id, effective_at],
            )?;
            upsert_sync_delete_tombstone(
                &transaction,
                "owner",
                owner_type,
                owner_id,
                "",
                owner_id,
                effective_at,
                origin,
            )?;
            transaction.execute(
                "INSERT INTO change_log(
                    entity_type, operation, owner_type, owner_id, topic_id,
                    entity_id, revision, origin, changed_at, payload_json
                 ) VALUES('owner', 'delete', ?1, ?2, NULL, ?2, ?3, ?4, ?5, NULL)",
                params![
                    owner_type.as_str(),
                    owner_id,
                    current_global_revision(&transaction)?,
                    origin,
                    effective_at,
                ],
            )?;
        }

        transaction.commit()?;
        Ok(())
    }

    /// Persists a topic tombstone received from MobileSync. The exact owner is
    /// mandatory at the protocol boundary.
    pub fn apply_sync_topic_tombstone(
        &self,
        key: &TopicKey,
        deleted_at: i64,
        origin: &str,
    ) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        mark_topic_deleted(&transaction, key, origin, deleted_at)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn mark_source_invalid(&self, source: &TopicSource, error: &str) -> Result<()> {
        let connection = self.connection.lock();
        connection.execute(
            "INSERT INTO history_sources(
                source_path, owner_type, owner_id, topic_id, mtime_ns, file_size,
                content_hash, last_revision, indexed_at, status, last_error
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
        Ok(())
    }

    pub fn ingest_topic(
        &self,
        source: &TopicSource,
        messages: &[NormalizedMessage],
        mtime_ns: i64,
        file_size: i64,
        content_hash: &str,
        origin: &str,
    ) -> Result<IngestCommit> {
        let now = now_ms();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let previous_hash: Option<String> = transaction
            .query_row(
                "SELECT content_hash FROM topics
                 WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3",
                params![
                    source.key.owner_type.as_str(),
                    source.key.owner_id,
                    source.key.topic_id
                ],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        if previous_hash.as_deref() == Some(content_hash) {
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
            let revision = transaction
                .query_row(
                    "SELECT content_revision FROM topics
                     WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3",
                    params![
                        source.key.owner_type.as_str(),
                        source.key.owner_id,
                        source.key.topic_id,
                    ],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(0);
            transaction.commit()?;
            return Ok(IngestCommit {
                topic: source.key.clone(),
                revision,
                changed: false,
                removed_row_ids: Vec::new(),
                message_count: messages.len(),
            });
        }

        let revision = next_global_revision(&transaction)?;
        let existing = load_active_message_ids(&transaction, &source.key)?;
        let incoming_ids: HashSet<&str> = messages
            .iter()
            .map(|message| message.msg_id.as_str())
            .collect();
        let mut removed_row_ids = Vec::new();

        for (msg_id, row_id) in existing {
            if !incoming_ids.contains(msg_id.as_str()) {
                transaction.execute(
                    "UPDATE messages SET deleted_at=?2, updated_at=?2 WHERE row_id=?1",
                    params![row_id, now],
                )?;
                upsert_message_tombstone(&transaction, &source.key, &msg_id, origin, now)?;
                append_change(
                    &transaction,
                    "message",
                    "delete",
                    &source.key,
                    Some(&msg_id),
                    revision,
                    origin,
                    now,
                    None,
                )?;
                removed_row_ids.push(row_id);
            }
        }

        for message in messages {
            transaction.execute(
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
                params![
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
                    now,
                ],
            )?;

            let row_id: i64 = transaction.query_row(
                "SELECT row_id FROM messages
                 WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3 AND msg_id=?4",
                params![
                    source.key.owner_type.as_str(),
                    source.key.owner_id,
                    source.key.topic_id,
                    message.msg_id,
                ],
                |row| row.get(0),
            )?;
            transaction.execute(
                "DELETE FROM message_attachments WHERE message_row_id=?1",
                [row_id],
            )?;
            for attachment in &message.attachments {
                transaction.execute(
                    "INSERT INTO message_attachments(
                        message_row_id, attachment_order, content_hash, display_name,
                        mime_type, file_path, metadata_json, created_at
                     ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        row_id,
                        attachment.attachment_order,
                        attachment.content_hash,
                        attachment.display_name,
                        attachment.mime_type,
                        attachment.file_path,
                        attachment.metadata_json,
                        attachment.created_at,
                    ],
                )?;
            }

            transaction.execute(
                "DELETE FROM tombstones
                 WHERE entity_type='message' AND owner_type=?1 AND owner_id=?2
                   AND topic_id=?3 AND entity_id=?4",
                params![
                    source.key.owner_type.as_str(),
                    source.key.owner_id,
                    source.key.topic_id,
                    message.msg_id,
                ],
            )?;
        }

        transaction.execute(
            "UPDATE topics SET
                content_hash=?4,
                content_revision=?5,
                updated_at=?6,
                deleted_at=NULL
             WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3",
            params![
                source.key.owner_type.as_str(),
                source.key.owner_id,
                source.key.topic_id,
                content_hash,
                revision,
                now,
            ],
        )?;

        transaction.execute(
            "INSERT INTO history_sources(
                source_path, owner_type, owner_id, topic_id, mtime_ns, file_size,
                content_hash, last_revision, indexed_at, status, last_error
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'ready', NULL)
             ON CONFLICT(source_path) DO UPDATE SET
                owner_type=excluded.owner_type,
                owner_id=excluded.owner_id,
                topic_id=excluded.topic_id,
                mtime_ns=excluded.mtime_ns,
                file_size=excluded.file_size,
                content_hash=excluded.content_hash,
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
                content_hash,
                revision,
                now,
            ],
        )?;

        append_change(
            &transaction,
            "topic",
            "upsert",
            &source.key,
            Some(&source.key.topic_id),
            revision,
            origin,
            now,
            Some(&serde_json::json!({ "messageCount": messages.len() }).to_string()),
        )?;

        transaction.commit()?;
        Ok(IngestCommit {
            topic: source.key.clone(),
            revision,
            changed: true,
            removed_row_ids,
            message_count: messages.len(),
        })
    }

    pub fn mark_topic_indexed(&self, key: &TopicKey, revision: i64) -> Result<()> {
        let connection = self.connection.lock();
        connection.execute(
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
        connection.execute(
            "INSERT INTO service_meta(key, value) VALUES('tantivy_index_revision', ?1)
             ON CONFLICT(key) DO UPDATE SET
                value=CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)",
            [revision.to_string()],
        )?;
        Ok(())
    }

    pub fn topic_revision(&self, key: &TopicKey) -> Result<Option<i64>> {
        let connection = self.connection.lock();
        connection
            .query_row(
                "SELECT content_revision FROM topics
                 WHERE owner_type=?1 AND owner_id=?2 AND topic_id=?3",
                params![key.owner_type.as_str(), key.owner_id, key.topic_id],
                |row| row.get(0),
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

fn mark_topic_deleted(
    transaction: &Transaction<'_>,
    key: &TopicKey,
    origin: &str,
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
    let topic_tombstone: Option<i64> = transaction
        .query_row(
            "SELECT deleted_at FROM tombstones
             WHERE entity_type='topic' AND owner_type=?1 AND owner_id=?2
               AND topic_id=?3 AND entity_id=?3",
            params![key.owner_type.as_str(), key.owner_id, key.topic_id],
            |row| row.get(0),
        )
        .optional()?;
    let topic_effective_at = topic_tombstone
        .into_iter()
        .chain(topic_state.flatten())
        .fold(deleted_at, i64::min);
    let topic_row_changed = topic_state.is_some_and(|state| state != Some(topic_effective_at));
    let topic_changed = topic_row_changed || topic_tombstone != Some(topic_effective_at);
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
    for (msg_id, row_id) in active_messages {
        transaction.execute(
            "UPDATE messages SET deleted_at=?2, updated_at=MAX(updated_at, ?2)
             WHERE row_id=?1",
            params![row_id, topic_effective_at],
        )?;
        upsert_message_tombstone(transaction, key, &msg_id, origin, topic_effective_at)?;
        append_change(
            transaction,
            "message",
            "delete",
            key,
            Some(&msg_id),
            revision,
            origin,
            topic_effective_at,
            Some(r#"{"reason":"topic_deleted"}"#),
        )?;
    }

    if topic_state.is_some() && stored_rows_changed {
        transaction.execute(
            "UPDATE topics SET
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

    if topic_changed {
        upsert_sync_delete_tombstone(
            transaction,
            "topic",
            key.owner_type,
            &key.owner_id,
            &key.topic_id,
            &key.topic_id,
            topic_effective_at,
            origin,
        )?;
        append_change(
            transaction,
            "topic",
            "delete",
            key,
            Some(&key.topic_id),
            revision,
            origin,
            topic_effective_at,
            None,
        )?;
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn upsert_sync_delete_tombstone(
    transaction: &Transaction<'_>,
    entity_type: &str,
    owner_type: OwnerType,
    owner_id: &str,
    topic_id: &str,
    entity_id: &str,
    deleted_at: i64,
    origin: &str,
) -> Result<()> {
    transaction.execute(
        "INSERT INTO tombstones(
            entity_type, owner_type, owner_id, topic_id, entity_id,
            deleted_at, expires_at, origin
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(entity_type, owner_type, owner_id, topic_id, entity_id)
         DO UPDATE SET
            deleted_at=MIN(tombstones.deleted_at, excluded.deleted_at),
            expires_at=CASE
                WHEN tombstones.expires_at IS NULL THEN excluded.expires_at
                ELSE MAX(tombstones.expires_at, excluded.expires_at)
            END,
            origin=CASE
                WHEN excluded.deleted_at < tombstones.deleted_at THEN excluded.origin
                ELSE tombstones.origin
            END",
        params![
            entity_type,
            owner_type.as_str(),
            owner_id,
            topic_id,
            entity_id,
            deleted_at,
            tombstone_expiry(deleted_at),
            origin,
        ],
    )?;
    Ok(())
}

fn upsert_message_tombstone(
    transaction: &Transaction<'_>,
    key: &TopicKey,
    msg_id: &str,
    origin: &str,
    now: i64,
) -> Result<()> {
    transaction.execute(
        "INSERT INTO tombstones(
            entity_type, owner_type, owner_id, topic_id, entity_id,
            deleted_at, expires_at, origin
         ) VALUES('message', ?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(entity_type, owner_type, owner_id, topic_id, entity_id)
         DO UPDATE SET deleted_at=excluded.deleted_at,
                       expires_at=excluded.expires_at,
                       origin=excluded.origin",
        params![
            key.owner_type.as_str(),
            key.owner_id,
            key.topic_id,
            msg_id,
            now,
            tombstone_expiry(now),
            origin,
        ],
    )?;
    Ok(())
}

fn tombstone_expiry(now: i64) -> i64 {
    now.saturating_add(30 * 24 * 60 * 60 * 1000_i64)
}

#[allow(clippy::too_many_arguments)] // Mirrors the fixed change_log row contract at transaction call sites.
fn append_change(
    transaction: &Transaction<'_>,
    entity_type: &str,
    operation: &str,
    topic: &TopicKey,
    entity_id: Option<&str>,
    revision: i64,
    origin: &str,
    changed_at: i64,
    payload_json: Option<&str>,
) -> Result<()> {
    transaction.execute(
        "INSERT INTO change_log(
            entity_type, operation, owner_type, owner_id, topic_id,
            entity_id, revision, origin, changed_at, payload_json
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            entity_type,
            operation,
            topic.owner_type.as_str(),
            topic.owner_id,
            topic.topic_id,
            entity_id,
            revision,
            origin,
            changed_at,
            payload_json,
        ],
    )?;
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

    fn test_database() -> (tempfile::TempDir, Database) {
        let directory = tempfile::tempdir().expect("create temp database directory");
        let database =
            Database::open(&directory.path().join("chat.sqlite3")).expect("open test database");
        (directory, database)
    }

    #[test]
    fn sync_owner_tombstone_persists_missing_owner_and_keeps_earliest_time() {
        let (_directory, database) = test_database();

        database
            .apply_sync_owner_tombstone(OwnerType::Agent, "agent-a", 200, "mobile_sync")
            .expect("persist missing owner tombstone");

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
            assert_eq!(owners, 0);
            let tombstone: i64 = connection
                .query_row(
                    "SELECT deleted_at FROM tombstones
                     WHERE entity_type='owner' AND owner_type='agent'
                       AND owner_id='agent-a' AND entity_id='agent-a'",
                    [],
                    |row| row.get(0),
                )
                .expect("query owner tombstone");
            assert_eq!(tombstone, 200);
        }

        database
            .apply_sync_owner_tombstone(OwnerType::Agent, "agent-a", 300, "mobile_sync")
            .expect("replay owner tombstone");

        database
            .apply_sync_owner_tombstone(OwnerType::Agent, "agent-a", 100, "mobile_sync")
            .expect("apply earlier owner tombstone");
        let connection = database.connection.lock();
        let deleted_at: i64 = connection
            .query_row(
                "SELECT deleted_at FROM tombstones
                 WHERE entity_type='owner' AND owner_type='agent'
                   AND owner_id='agent-a' AND entity_id='agent-a'",
                [],
                |row| row.get(0),
            )
            .expect("query earliest owner tombstone");
        assert_eq!(deleted_at, 100);
        let changes: i64 = connection
            .query_row("SELECT COUNT(*) FROM change_log", [], |row| row.get(0))
            .expect("count owner changes");
        assert_eq!(changes, 2);
    }

    #[test]
    fn sync_topic_tombstone_persists_missing_topic_with_exact_owner() {
        let (_directory, database) = test_database();
        let key = TopicKey {
            owner_type: OwnerType::Group,
            owner_id: "group-a".to_string(),
            topic_id: "topic-a".to_string(),
        };

        database
            .apply_sync_topic_tombstone(&key, 321, "mobile_sync")
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
            assert_eq!(owner_rows, 0);
            let topic_rows: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM topics
                     WHERE owner_type='group' AND owner_id='group-a' AND topic_id='topic-a'",
                    [],
                    |row| row.get(0),
                )
                .expect("count topic rows");
            assert_eq!(topic_rows, 0);
            let tombstone: i64 = connection
                .query_row(
                    "SELECT deleted_at FROM tombstones
                     WHERE entity_type='topic' AND owner_type='group'
                       AND owner_id='group-a' AND topic_id='topic-a'",
                    [],
                    |row| row.get(0),
                )
                .expect("query topic tombstone");
            assert_eq!(tombstone, 321);
        }

        database
            .apply_sync_topic_tombstone(&key, 400, "mobile_sync")
            .expect("replay topic tombstone");
        let connection = database.connection.lock();
        let state: (i64, i64) = connection
            .query_row(
                "SELECT t.deleted_at, (SELECT COUNT(*) FROM change_log)
                 FROM tombstones t
                 WHERE t.entity_type='topic' AND t.owner_type='group'
                   AND t.owner_id='group-a' AND t.topic_id='topic-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("query idempotent topic tombstone");
        assert_eq!(state, (321, 1));
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
            .apply_sync_owner_tombstone(OwnerType::Agent, "agent-default", 200, "mobile_sync")
            .expect("apply owner tombstone");

        let connection = database.connection.lock();
        let state: (Option<i64>, Option<i64>) = connection
            .query_row(
                "SELECT t.deleted_at, m.deleted_at
                 FROM topics t JOIN messages m
                   USING(owner_type, owner_id, topic_id)
                 WHERE t.owner_type='agent' AND t.owner_id='agent-default'
                   AND t.topic_id='default'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("query default state");
        assert_eq!(state, (Some(200), Some(200)));
        let sync_tombstones: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tombstones
                 WHERE owner_id='agent-default' AND topic_id='default'",
                [],
                |row| row.get(0),
            )
            .expect("count default tombstones");
        assert_eq!(sync_tombstones, 2);
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
                        ('agent', 'agent-b', 'topic-other', 'message-other', 0, 'user',
                         'c', 'c', 'c', '{}', 10, NULL);
                     INSERT INTO tombstones(
                        entity_type, owner_type, owner_id, topic_id, entity_id,
                        deleted_at, expires_at, origin
                     ) VALUES(
                        'message', 'agent', 'agent-a', 'topic-a', 'message-missing',
                        250, 1000, 'seed'
                     );",
                )
                .expect("seed owner cascade rows");
        }

        database
            .apply_sync_owner_tombstone(OwnerType::Agent, "agent-a", 200, "mobile_sync")
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
            let missing_message_tombstone: i64 = connection
                .query_row(
                    "SELECT deleted_at FROM tombstones
                     WHERE entity_type='message' AND owner_id='agent-a'
                       AND topic_id='topic-a' AND entity_id='message-missing'",
                    [],
                    |row| row.get(0),
                )
                .expect("query tombstone-only message cascade");
            assert_eq!(missing_message_tombstone, 250);
            let tombstones: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM tombstones WHERE owner_id='agent-a'",
                    [],
                    |row| row.get(0),
                )
                .expect("count cascade tombstones");
            assert_eq!(tombstones, 5);
            let changes: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM change_log WHERE owner_id='agent-a'",
                    [],
                    |row| row.get(0),
                )
                .expect("count cascade changes");
            assert_eq!(changes, 4);
        }

        database
            .apply_sync_owner_tombstone(OwnerType::Agent, "agent-a", 400, "mobile_sync")
            .expect("replay cascade tombstone");
        let connection = database.connection.lock();
        let changes: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM change_log WHERE owner_id='agent-a'",
                [],
                |row| row.get(0),
            )
            .expect("count changes after idempotent replay");
        assert_eq!(changes, 4);
    }
}
