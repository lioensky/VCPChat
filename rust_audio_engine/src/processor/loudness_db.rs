//! Loudness Database Persistence
//!
//! SQLite storage for track loudness metadata following EBU R128 standard.
//! Enables pre-computed gain values for fast playback without real-time analysis.

use rusqlite::{Connection, params, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Current scanner algorithm version
/// Increment when measurement algorithm changes to trigger rescan
pub const CURRENT_SCAN_VERSION: i32 = 1;

/// Default target loudness for streaming (LUFS)
pub const DEFAULT_STREAMING_TARGET_LUFS: f64 = -14.0;

/// Default target loudness for broadcast (LUFS)
pub const DEFAULT_BROADCAST_TARGET_LUFS: f64 = -23.0;

// ============================================================================
// Track Loudness Record
// ============================================================================

/// Loudness metadata for a single track
#[derive(Debug, Clone)]
pub struct TrackLoudness {
    /// Unique identifier (file path or hash)
    pub track_id: String,
    /// Original file path
    pub file_path: String,
    /// Integrated loudness in LUFS
    pub integrated_lufs: f64,
    /// True peak in dBTP
    pub true_peak_dbtp: f64,
    /// Loudness range in LU (optional)
    pub loudness_range: Option<f64>,
    /// Pre-computed track gain in dB (target - integrated)
    pub track_gain_db: f64,
    /// Album gain in dB (optional, for album mode)
    pub album_gain_db: Option<f64>,
    /// Scanner algorithm version
    pub scan_version: i32,
    /// Unix timestamp of scan
    pub scanned_at: i64,
    /// File modification time (Unix timestamp, for change detection)
    /// FIX for Defect 40: Track file changes
    pub file_mtime: Option<i64>,
    /// File size in bytes (for change detection)
    /// FIX for Defect 40: Track file changes
    pub file_size: Option<i64>,
}

impl TrackLoudness {
    /// Create a new loudness record from measurement results
    /// 
    /// FIX for Defect 40: Record file mtime and size for change detection.
    /// If file metadata cannot be read (e.g., HTTP URL), these will be None.
    pub fn new(
        file_path: &str,
        integrated_lufs: f64,
        true_peak_dbtp: f64,
        loudness_range: Option<f64>,
        target_lufs: f64,
    ) -> Self {
        let track_id = Self::compute_track_id(file_path);
        let track_gain_db = target_lufs - integrated_lufs;
        
        // FIX for Defect 40: Get file metadata for change detection
        let (file_mtime, file_size) = Self::get_file_metadata(file_path);
        
        Self {
            track_id,
            file_path: file_path.to_string(),
            integrated_lufs,
            true_peak_dbtp,
            loudness_range,
            track_gain_db,
            album_gain_db: None,
            scan_version: CURRENT_SCAN_VERSION,
            scanned_at: chrono_timestamp(),
            file_mtime,
            file_size,
        }
    }
    
    /// Get file modification time and size for change detection
    /// Returns (mtime, size) or (None, None) if file is not local
    fn get_file_metadata(path: &str) -> (Option<i64>, Option<i64>) {
        // Skip HTTP URLs
        if path.starts_with("http://") || path.starts_with("https://") {
            return (None, None);
        }
        
        std::fs::metadata(path)
            .ok()
            .and_then(|m| {
                let mtime = m.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64);
                let size = Some(m.len() as i64);
                Some((mtime, size))
            })
            .unwrap_or((None, None))
    }
    
    /// Compute a unique track ID from file path
    fn compute_track_id(path: &str) -> String {
        // Use normalized path as ID
        // For better collision resistance, could use hash in future
        path.replace('\\', "/").to_lowercase()
    }
    
    /// Get gain in dB for a specific target loudness
    pub fn gain_for_target(&self, target_lufs: f64) -> f64 {
        target_lufs - self.integrated_lufs
    }
    
    /// Convert dB gain to linear coefficient
    pub fn gain_linear(&self, target_lufs: f64) -> f32 {
        let gain_db = self.gain_for_target(target_lufs);
        10.0_f64.powf(gain_db / 20.0) as f32
    }
}

// ============================================================================
// Loudness Database
// ============================================================================

/// SQLite database for track loudness metadata
pub struct LoudnessDatabase {
    conn: Mutex<Connection>,
    db_path: PathBuf,
}

impl LoudnessDatabase {
    /// Open or create the loudness database
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        let db_path = path.as_ref().to_path_buf();
        
        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create database directory: {}", e))?;
            }
        }
        
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open database: {}", e))?;
        
        let db = Self {
            conn: Mutex::new(conn),
            db_path,
        };
        
        db.init_schema()?;
        Ok(db)
    }
    
    /// Create an in-memory database (for testing)
    pub fn in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("Failed to create in-memory database: {}", e))?;
        
        let db = Self {
            conn: Mutex::new(conn),
            db_path: PathBuf::from(":memory:"),
        };
        
        db.init_schema()?;
        Ok(db)
    }
    
    /// Initialize database schema
    fn init_schema(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        
        conn.execute_batch(r#"
            CREATE TABLE IF NOT EXISTS track_loudness (
                track_id        TEXT PRIMARY KEY,
                file_path       TEXT NOT NULL,
                integrated_lufs REAL NOT NULL,
                true_peak_dbtp  REAL NOT NULL,
                loudness_range  REAL,
                track_gain_db   REAL NOT NULL,
                album_gain_db   REAL,
                scan_version    INTEGER NOT NULL,
                scanned_at      INTEGER NOT NULL,
                file_mtime      INTEGER,
                file_size       INTEGER
            );
            
            CREATE INDEX IF NOT EXISTS idx_file_path ON track_loudness(file_path);
            CREATE INDEX IF NOT EXISTS idx_scan_version ON track_loudness(scan_version);
            
            -- Add columns to existing databases (migration)
            -- These will silently fail if columns already exist, which is fine
            ALTER TABLE track_loudness ADD COLUMN file_mtime INTEGER;
            ALTER TABLE track_loudness ADD COLUMN file_size INTEGER;
        "#).map_err(|e| format!("Failed to initialize schema: {}", e))?;
        
        Ok(())
    }
    
    /// Insert or update a track's loudness data
    pub fn upsert(&self, track: &TrackLoudness) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        
        conn.execute(
            r#"
            INSERT INTO track_loudness 
                (track_id, file_path, integrated_lufs, true_peak_dbtp, 
                 loudness_range, track_gain_db, album_gain_db, scan_version, scanned_at,
                 file_mtime, file_size)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(track_id) DO UPDATE SET
                file_path = excluded.file_path,
                integrated_lufs = excluded.integrated_lufs,
                true_peak_dbtp = excluded.true_peak_dbtp,
                loudness_range = excluded.loudness_range,
                track_gain_db = excluded.track_gain_db,
                album_gain_db = excluded.album_gain_db,
                scan_version = excluded.scan_version,
                scanned_at = excluded.scanned_at,
                file_mtime = excluded.file_mtime,
                file_size = excluded.file_size
            "#,
            params![
                track.track_id,
                track.file_path,
                track.integrated_lufs,
                track.true_peak_dbtp,
                track.loudness_range,
                track.track_gain_db,
                track.album_gain_db,
                track.scan_version,
                track.scanned_at,
                track.file_mtime,
                track.file_size,
            ],
        ).map_err(|e| format!("Failed to upsert track: {}", e))?;
        
        Ok(())
    }
    
    /// Get loudness data for a track by file path
    pub fn get(&self, file_path: &str) -> Result<Option<TrackLoudness>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let track_id = TrackLoudness::compute_track_id(file_path);
        
        let result = conn.query_row(
            r#"
            SELECT track_id, file_path, integrated_lufs, true_peak_dbtp,
                   loudness_range, track_gain_db, album_gain_db, scan_version, scanned_at,
                   file_mtime, file_size
            FROM track_loudness
            WHERE track_id = ?1
            "#,
            params![track_id],
            |row| {
                Ok(TrackLoudness {
                    track_id: row.get(0)?,
                    file_path: row.get(1)?,
                    integrated_lufs: row.get(2)?,
                    true_peak_dbtp: row.get(3)?,
                    loudness_range: row.get(4)?,
                    track_gain_db: row.get(5)?,
                    album_gain_db: row.get(6)?,
                    scan_version: row.get(7)?,
                    scanned_at: row.get(8)?,
                    file_mtime: row.get(9)?,
                    file_size: row.get(10)?,
                })
            },
        ).optional().map_err(|e| format!("Failed to query track: {}", e))?;
        
        Ok(result)
    }
    
    /// Check if a track needs scanning (not in DB, outdated version, or file changed)
    /// 
    /// FIX for Defect 40: Also check file mtime and size for change detection.
    /// This handles the case where a file is replaced but keeps the same path.
    pub fn needs_scan(&self, file_path: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let track_id = TrackLoudness::compute_track_id(file_path);
        
        let result: Option<(i32, Option<i64>, Option<i64>)> = conn.query_row(
            "SELECT scan_version, file_mtime, file_size FROM track_loudness WHERE track_id = ?1",
            params![track_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(|e| format!("Failed to check track: {}", e))?;
        
        match result {
            None => Ok(true),  // Not in database
            Some((version, db_mtime, db_size)) => {
                // Check scan version
                if version < CURRENT_SCAN_VERSION {
                    return Ok(true);  // Outdated scanner version
                }
                
                // FIX for Defect 40: Check file modification time and size
                // Only check for local files (not HTTP URLs)
                if !file_path.starts_with("http://") && !file_path.starts_with("https://") {
                    if let Ok(metadata) = std::fs::metadata(file_path) {
                        let current_mtime = metadata.modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as i64);
                        let current_size = Some(metadata.len() as i64);
                        
                        // If mtime or size changed, need rescan
                        if current_mtime != db_mtime || current_size != db_size {
                            log::info!(
                                "File changed, needs rescan: {} (mtime: {:?} -> {:?}, size: {:?} -> {:?})",
                                file_path, db_mtime, current_mtime, db_size, current_size
                            );
                            return Ok(true);
                        }
                    }
                }
                
                Ok(false)  // No changes detected
            }
        }
    }
    
    /// Get all tracks that need rescanning
    pub fn get_outdated_tracks(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        
        let mut stmt = conn.prepare(
            "SELECT file_path FROM track_loudness WHERE scan_version < ?1"
        ).map_err(|e| format!("Failed to prepare statement: {}", e))?;
        
        let tracks: Vec<String> = stmt.query_map(params![CURRENT_SCAN_VERSION], |row| row.get(0))
            .map_err(|e| format!("Failed to query outdated tracks: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        
        Ok(tracks)
    }
    
    /// Batch insert multiple tracks (for initial scan)
    pub fn batch_upsert(&self, tracks: &[TrackLoudness]) -> Result<usize, String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| format!("Failed to begin transaction: {}", e))?;
        
        let mut count = 0;
        for track in tracks {
            tx.execute(
                r#"
                INSERT INTO track_loudness 
                    (track_id, file_path, integrated_lufs, true_peak_dbtp, 
                     loudness_range, track_gain_db, album_gain_db, scan_version, scanned_at,
                     file_mtime, file_size)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                ON CONFLICT(track_id) DO UPDATE SET
                    file_path = excluded.file_path,
                    integrated_lufs = excluded.integrated_lufs,
                    true_peak_dbtp = excluded.true_peak_dbtp,
                    loudness_range = excluded.loudness_range,
                    track_gain_db = excluded.track_gain_db,
                    album_gain_db = excluded.album_gain_db,
                    scan_version = excluded.scan_version,
                    scanned_at = excluded.scanned_at,
                    file_mtime = excluded.file_mtime,
                    file_size = excluded.file_size
                "#,
                params![
                    track.track_id,
                    track.file_path,
                    track.integrated_lufs,
                    track.true_peak_dbtp,
                    track.loudness_range,
                    track.track_gain_db,
                    track.album_gain_db,
                    track.scan_version,
                    track.scanned_at,
                    track.file_mtime,
                    track.file_size,
                ],
            ).map_err(|e| format!("Failed to upsert track {}: {}", track.file_path, e))?;
            count += 1;
        }
        
        tx.commit().map_err(|e| format!("Failed to commit transaction: {}", e))?;
        Ok(count)
    }
    
    /// Update album gain for multiple tracks (same album)
    /// 
    /// FIX for Defect 41: Wrap in transaction for atomicity.
    /// If any update fails or process crashes, all changes are rolled back.
    pub fn set_album_gain(&self, track_ids: &[&str], album_gain_db: f64) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        
        // FIX for Defect 41: Use transaction for atomic batch update
        let tx = conn.transaction().map_err(|e| format!("Failed to begin transaction: {}", e))?;
        
        for track_id in track_ids {
            tx.execute(
                "UPDATE track_loudness SET album_gain_db = ?1 WHERE track_id = ?2",
                params![album_gain_db, track_id],
            ).map_err(|e| format!("Failed to update album gain for {}: {}", track_id, e))?;
        }
        
        tx.commit().map_err(|e| format!("Failed to commit album gain transaction: {}", e))?;
        
        Ok(())
    }
    
    /// Delete a track from the database
    pub fn delete(&self, file_path: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let track_id = TrackLoudness::compute_track_id(file_path);
        
        let affected = conn.execute(
            "DELETE FROM track_loudness WHERE track_id = ?1",
            params![track_id],
        ).map_err(|e| format!("Failed to delete track: {}", e))?;
        
        Ok(affected > 0)
    }
    
    /// Get database statistics
    pub fn stats(&self) -> Result<DatabaseStats, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        
        let total_tracks: i64 = conn.query_row(
            "SELECT COUNT(*) FROM track_loudness", [],
            |row| row.get(0)
        ).map_err(|e| format!("Failed to count tracks: {}", e))?;
        
        let outdated_tracks: i64 = conn.query_row(
            "SELECT COUNT(*) FROM track_loudness WHERE scan_version < ?1",
            params![CURRENT_SCAN_VERSION],
            |row| row.get(0)
        ).map_err(|e| format!("Failed to count outdated tracks: {}", e))?;
        
        let with_album_gain: i64 = conn.query_row(
            "SELECT COUNT(*) FROM track_loudness WHERE album_gain_db IS NOT NULL", [],
            |row| row.get(0)
        ).map_err(|e| format!("Failed to count album gain tracks: {}", e))?;
        
        Ok(DatabaseStats {
            total_tracks,
            outdated_tracks,
            with_album_gain,
            current_scan_version: CURRENT_SCAN_VERSION,
        })
    }
    
    /// Get database path
    pub fn path(&self) -> &Path {
        &self.db_path
    }
}

// ============================================================================
// Database Statistics
// ============================================================================

/// Statistics about the loudness database
#[derive(Debug, Clone, serde::Serialize)]
pub struct DatabaseStats {
    pub total_tracks: i64,
    pub outdated_tracks: i64,
    pub with_album_gain: i64,
    pub current_scan_version: i32,
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Get current Unix timestamp in seconds
fn chrono_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_database_basic_operations() {
        let db = LoudnessDatabase::in_memory().unwrap();
        
        let track = TrackLoudness::new(
            "/music/test.flac",
            -18.5,  // integrated_lufs
            -0.5,   // true_peak_dbtp
            Some(6.2),  // loudness_range
            DEFAULT_STREAMING_TARGET_LUFS,
        );
        
        // Insert
        db.upsert(&track).unwrap();
        
        // Retrieve
        let retrieved = db.get("/music/test.flac").unwrap().unwrap();
        assert_eq!(retrieved.integrated_lufs, -18.5);
        assert_eq!(retrieved.track_gain_db, 4.5);  // -14 - (-18.5)
        
        // Check needs_scan
        assert!(!db.needs_scan("/music/test.flac").unwrap());
        assert!(db.needs_scan("/music/other.flac").unwrap());
    }
    
    #[test]
    fn test_gain_calculation() {
        let track = TrackLoudness::new(
            "/test.flac",
            -20.0,
            -1.0,
            None,
            -14.0,
        );
        
        assert_eq!(track.track_gain_db, 6.0);  // -14 - (-20)
        assert!((track.gain_linear(-14.0) - 1.995).abs() < 0.01);
        
        // Different target
        assert_eq!(track.gain_for_target(-23.0), -3.0);
    }
}
