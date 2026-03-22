//! Player state management
//!
//! Contains shared state, commands, device info, and cache utilities.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use parking_lot::{Mutex, RwLock};
use arc_swap::ArcSwap;
use serde::Serialize;
use std::path::Path;
use std::fs;
use std::io::{Read, Write};
use crate::processor::NoiseShaperCurve;

// ============ Cache System ============

const CACHE_MAGIC: &[u8; 4] = b"VCP1";
const CACHE_VERSION: u32 = 1;
const CACHE_HEADER_SIZE: usize = 32;

/// Cache file header for validation
#[repr(C)]
struct CacheHeader {
    magic: [u8; 4],
    version: u32,
    sample_rate: u32,
    channels: u32,
    frame_count: u64,
    checksum: u32,
    _reserved: u32,
}

/// Calculate CRC32 checksum for cache validation
fn calculate_checksum(data: &[f64]) -> u32 {
    let mut hasher = crc32fast::Hasher::new();
    for sample in data {
        hasher.update(&sample.to_bits().to_le_bytes());
    }
    hasher.finalize()
}

fn read_u32_from_bytes(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap())
}

fn read_u64_from_bytes(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset+8].try_into().unwrap())
}

/// Save samples to cache with header validation
pub fn save_cache_with_header(
    path: &Path,
    samples: &[f64],
    sample_rate: u32,
    channels: u32,
) -> std::io::Result<()> {
    let frame_count = (samples.len() / channels as usize) as u64;
    let checksum = calculate_checksum(samples);

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let mut file = fs::File::create(path)?;

    // Write header explicitly (avoids unsafe transmute and padding issues)
    let mut header_bytes = [0u8; CACHE_HEADER_SIZE];
    header_bytes[0..4].copy_from_slice(CACHE_MAGIC);
    header_bytes[4..8].copy_from_slice(&CACHE_VERSION.to_le_bytes());
    header_bytes[8..12].copy_from_slice(&sample_rate.to_le_bytes());
    header_bytes[12..16].copy_from_slice(&channels.to_le_bytes());
    header_bytes[16..24].copy_from_slice(&frame_count.to_le_bytes());
    header_bytes[24..28].copy_from_slice(&checksum.to_le_bytes());
    // bytes 28..32 are reserved (already zero)
    file.write_all(&header_bytes)?;

    for sample in samples {
        file.write_all(&sample.to_le_bytes())?;
    }

    log::info!("Saved {} samples to cache with header validation", samples.len());
    Ok(())
}

/// Load samples from cache with header validation
///
/// FIX for Defect 34: Actually verify the CRC32 checksum instead of ignoring it.
/// FIX for Defect 6: Compute CRC32 incrementally while reading samples from file,
/// avoiding a separate full pass over potentially huge buffers (e.g., 1.8 GB for
/// 10 min 192kHz stereo). This eliminates the startup lag from the previous
/// two-pass approach (read all → checksum all).
pub fn load_cache_with_header(
    path: &Path,
    expected_sr: u32,
    expected_ch: u32,
) -> Option<Vec<f64>> {
    let mut file = fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    let file_size = metadata.len() as usize;

    if file_size < CACHE_HEADER_SIZE + 8 {
        log::warn!("Cache file too small: {} bytes", file_size);
        return None;
    }

    let mut header_bytes = [0u8; CACHE_HEADER_SIZE];
    file.read_exact(&mut header_bytes).ok()?;

    let magic = &header_bytes[0..4];
    let version = read_u32_from_bytes(&header_bytes, 4);
    let sample_rate = read_u32_from_bytes(&header_bytes, 8);
    let channels = read_u32_from_bytes(&header_bytes, 12);
    let frame_count = read_u64_from_bytes(&header_bytes, 16);
    let stored_checksum = read_u32_from_bytes(&header_bytes, 24);

    if magic != CACHE_MAGIC {
        log::warn!("Invalid cache magic: {:?}", magic);
        return None;
    }

    if version != CACHE_VERSION {
        log::warn!("Cache version mismatch: {} != {}", version, CACHE_VERSION);
        return None;
    }

    if sample_rate != expected_sr {
        log::warn!("Cache sample rate mismatch: {} != {}", sample_rate, expected_sr);
        return None;
    }

    if channels != expected_ch {
        log::warn!("Cache channel count mismatch: {} != {}", channels, expected_ch);
        return None;
    }

    let expected_data_size = frame_count as usize * channels as usize * 8;
    if file_size != CACHE_HEADER_SIZE + expected_data_size {
        log::warn!("Cache file size mismatch: expected {}, got {}",
            CACHE_HEADER_SIZE + expected_data_size, file_size);
        return None;
    }

    // FIX for Defect 6: Stream CRC32 computation while reading samples
    // in a single pass, instead of reading all then checksumming all.
    let sample_count = frame_count as usize * channels as usize;
    let mut samples = Vec::with_capacity(sample_count);
    let mut hasher = crc32fast::Hasher::new();
    let mut sample_bytes = [0u8; 8];

    for _ in 0..sample_count {
        if file.read_exact(&mut sample_bytes).is_err() {
            log::warn!("Failed to read all samples from cache");
            return None;
        }
        hasher.update(&sample_bytes);
        samples.push(f64::from_le_bytes(sample_bytes));
    }

    // Verify checksum computed during read
    let computed_checksum = hasher.finalize();
    if computed_checksum != stored_checksum {
        log::warn!(
            "Cache checksum mismatch: stored={}, computed={}. File may be corrupted.",
            stored_checksum, computed_checksum
        );
        return None;
    }

    log::info!("Loaded {} samples from validated cache (streaming checksum verified)", samples.len());
    Some(samples)
}

// ============ Event Flag Constants (Task E) ============

pub const EVENT_LOAD_COMPLETE:       u32 = 1 << 0;
pub const EVENT_LOAD_ERROR:          u32 = 1 << 1;
pub const EVENT_TRACK_CHANGED:       u32 = 1 << 2;
pub const EVENT_PLAYBACK_ENDED:      u32 = 1 << 3;
pub const EVENT_NEEDS_PRELOAD:       u32 = 1 << 4;
pub const EVENT_NEEDS_PRELOAD_RESET: u32 = 1 << 5;

// ============ Commands & State ============

/// Load result for async loading
#[derive(Debug, Clone)]
pub struct LoadResult {
    pub samples: Vec<f64>,
    pub sample_rate: u32,
    pub channels: usize,
    pub total_frames: u64,
    pub file_path: String,
    pub loudness_info: Option<crate::processor::LoudnessInfo>,
    /// Track metadata (title, artist, album, cover art)
    pub metadata: crate::decoder::TrackMetadata,
}

/// Commands sent to the audio thread
#[derive(Debug, Clone)]
pub enum AudioCommand {
    Play,
    Pause,
    Stop,
    Shutdown,
    Seek(f64),
    SetExternalIrConvolver { ir_data: Vec<f64>, channels: usize },
    ClearExternalIrConvolver,
    SetFirConvolver { ir_data: Vec<f64>, channels: usize },
    ClearFirConvolver,
    SetNoiseShaperCurve { curve: NoiseShaperCurve },
    LoadComplete(LoadResult),
    LoadError(String),
}

/// State of the audio player
#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(u8)]
pub enum PlayerState {
    Stopped = 0,
    Playing = 1,
    Paused = 2,
}

impl PlayerState {
    /// Convert from u8 (for atomic storage)
    pub fn from_u8(val: u8) -> Self {
        match val {
            1 => PlayerState::Playing,
            2 => PlayerState::Paused,
            _ => PlayerState::Stopped,
        }
    }
}

/// Atomic wrapper for PlayerState (P0 fix: replaces RwLock<PlayerState>)
///
/// Using AtomicU8 ensures that the audio callback can always update state
/// without risk of lock contention. This prevents EVENT_PLAYBACK_ENDED from
/// being silently dropped when try_write() would have failed.
pub struct AtomicPlayerState {
    inner: AtomicU8,
}

impl AtomicPlayerState {
    pub fn new(state: PlayerState) -> Self {
        Self {
            inner: AtomicU8::new(state as u8),
        }
    }

    #[inline]
    pub fn load(&self) -> PlayerState {
        PlayerState::from_u8(self.inner.load(Ordering::Acquire))
    }

    #[inline]
    pub fn store(&self, state: PlayerState) {
        self.inner.store(state as u8, Ordering::Release);
    }

    /// Compare-and-swap: only update if current state matches expected.
    /// Returns true if the swap was successful.
    #[inline]
    pub fn compare_exchange(&self, expected: PlayerState, new: PlayerState) -> bool {
        self.inner
            .compare_exchange(
                expected as u8,
                new as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }
}

/// Shared state between audio thread and main thread
pub struct SharedState {
    pub state: AtomicPlayerState,
    pub position_frames: AtomicU64,
    pub sample_rate: AtomicU64,
    pub channels: AtomicU64,
    pub total_frames: AtomicU64,
    pub spectrum_data: Mutex<Vec<f32>>,
    /// Audio sample buffer — lock-free via ArcSwap for realtime-safe reads
    /// from the audio callback. Writers (load, gapless swap) call .store()
    /// which is an atomic pointer swap; readers call .load() which never blocks.
    pub audio_buffer: ArcSwap<Vec<f64>>,
    pub exclusive_mode: AtomicBool,
    pub device_id: std::sync::atomic::AtomicI64,
    pub volume: std::sync::atomic::AtomicU64,
    pub file_path: RwLock<Option<String>>,
    pub eq_type: RwLock<String>,
    pub noise_shaper_curve: RwLock<NoiseShaperCurve>,

    // Gapless playback fields
    /// Pending audio buffer for gapless transition — lock-free via ArcSwap.
    /// The preload thread stores the decoded next-track samples here;
    /// the audio callback atomically swaps it into audio_buffer at track boundary.
    pub pending_buffer: ArcSwap<Option<Vec<f64>>>,
    pub pending_total_frames: AtomicU64,
    pub pending_sample_rate: AtomicU64,
    pub pending_channels: AtomicU64,
    pub pending_file_path: RwLock<Option<String>>,
    pub needs_preload: AtomicBool,
    pub pending_ready: AtomicBool,
    pub dsp_reset_pending: AtomicBool,
    /// Signal to cancel ongoing preload thread (Defect 31 fix)
    pub cancel_preload_signal: AtomicBool,
    /// Pending target gain for next track (set during gapless preload, applied after buffer swap)
    /// Fixes Defect 22: Prevents premature gain update during gapless preload
    pub pending_target_gain_db: std::sync::atomic::AtomicU64,  // Stored as bits of f64

    // Gapless: deferred metadata for main-thread pickup after track switch.
    // Audio callback sets gapless_swap_pending=true; main thread (WS pusher) reads these
    // and copies into file_path / track_metadata / current_track_path, then clears.
    pub gapless_swap_pending: AtomicBool,

    // Async loading state
    pub is_loading: AtomicBool,
    pub load_progress: AtomicU64,  // Percentage (0-100)
    pub load_error: RwLock<Option<String>>,

    // WebSocket event flags — unified bitmask (Task E)
    // Writers: audio thread or async tasks use fetch_or(EVENT_*, Release)
    // Reader: WebSocket pusher uses swap(0, AcqRel) to atomically take all events
    pub event_flags: std::sync::atomic::AtomicU32,
    pub current_track_path: RwLock<Option<String>>,  // Current track for notifications

    // Track metadata
    pub track_metadata: RwLock<crate::decoder::TrackMetadata>,
    pub pending_metadata: RwLock<Option<crate::decoder::TrackMetadata>>,
    
    // Output format info (Defect 37 fix: for NoiseShaper bit depth)
    pub output_bits: std::sync::atomic::AtomicU32,

    // H-channel fix: signal callback to rebuild DspChain when channels change
    pub dsp_needs_rebuild: AtomicBool,
}

impl SharedState {
    pub fn new() -> Self {
        Self {
            state: AtomicPlayerState::new(PlayerState::Stopped),
            position_frames: AtomicU64::new(0),
            sample_rate: AtomicU64::new(44100),
            channels: AtomicU64::new(2),
            total_frames: AtomicU64::new(0),
            spectrum_data: Mutex::new(vec![0.0; 64]),
            audio_buffer: ArcSwap::new(Arc::new(Vec::new())),
            exclusive_mode: AtomicBool::new(false),
            device_id: std::sync::atomic::AtomicI64::new(-1),
            volume: std::sync::atomic::AtomicU64::new(1_000_000),
            file_path: RwLock::new(None),
            eq_type: RwLock::new("IIR".to_string()),
            noise_shaper_curve: RwLock::new(NoiseShaperCurve::Lipshitz5),

            pending_buffer: ArcSwap::new(Arc::new(None)),
            pending_total_frames: AtomicU64::new(0),
            pending_sample_rate: AtomicU64::new(44100),
            pending_channels: AtomicU64::new(2),
            pending_file_path: RwLock::new(None),
            needs_preload: AtomicBool::new(false),
            pending_ready: AtomicBool::new(false),
            dsp_reset_pending: AtomicBool::new(false),
            cancel_preload_signal: AtomicBool::new(false),
            pending_target_gain_db: std::sync::atomic::AtomicU64::new(0_f64.to_bits()),

            gapless_swap_pending: AtomicBool::new(false),

            is_loading: AtomicBool::new(false),
            load_progress: AtomicU64::new(0),
            load_error: RwLock::new(None),

            event_flags: std::sync::atomic::AtomicU32::new(0),
            current_track_path: RwLock::new(None),

            track_metadata: RwLock::new(crate::decoder::TrackMetadata::default()),
            pending_metadata: RwLock::new(None),
            output_bits: std::sync::atomic::AtomicU32::new(24),  // Default 24-bit
            dsp_needs_rebuild: AtomicBool::new(false),
        }
    }

    pub fn current_time_secs(&self) -> f64 {
        let pos = self.position_frames.load(Ordering::Relaxed);
        let sr = self.sample_rate.load(Ordering::Relaxed).max(1);
        pos as f64 / sr as f64
    }

    pub fn duration_secs(&self) -> f64 {
        let total = self.total_frames.load(Ordering::Relaxed);
        let sr = self.sample_rate.load(Ordering::Relaxed).max(1);
        total as f64 / sr as f64
    }
}

impl Default for SharedState {
    fn default() -> Self {
        Self::new()
    }
}

/// Audio device info
#[derive(Debug, Clone, Serialize)]
pub struct AudioDeviceInfo {
    pub id: usize,
    pub name: String,
    pub is_default: bool,
    pub sample_rate: Option<u32>,
}
