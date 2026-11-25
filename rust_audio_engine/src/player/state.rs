//! Player state management
//!
//! Contains shared state, commands, device info, and cache utilities.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use parking_lot::{Mutex, RwLock};
use arc_swap::{ArcSwap, ArcSwapOption};
use serde::Serialize;
use std::path::Path;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use crate::processor::NoiseShaperCurve;

// ============ Cache System ============

const CACHE_MAGIC: &[u8; 4] = b"VCP1";
const CACHE_VERSION: u32 = 1;
const CACHE_HEADER_SIZE: usize = 32;

const CACHE_BLOCK_BYTES: usize = 64 * 1024;

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
    if channels == 0 || samples.is_empty() || samples.len() % channels as usize != 0 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid cache frame dimensions"));
    }
    let frame_count = (samples.len() / channels as usize) as u64;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::File::create(path)?;
    file.write_all(&[0; CACHE_HEADER_SIZE])?;
    let mut block = vec![0u8; CACHE_BLOCK_BYTES];
    let mut hasher = crc32fast::Hasher::new();
    for chunk in samples.chunks(CACHE_BLOCK_BYTES / 8) {
        let bytes = &mut block[..chunk.len() * 8];
        for (dst, sample) in bytes.chunks_exact_mut(8).zip(chunk) {
            dst.copy_from_slice(&sample.to_le_bytes());
        }
        hasher.update(bytes);
        file.write_all(bytes)?;
    }
    let checksum = hasher.finalize();
    file.seek(SeekFrom::Start(0))?;

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
    let file_size = metadata.len();

    if file_size < CACHE_HEADER_SIZE as u64 + 8 {
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

    let count = frame_count.checked_mul(u64::from(channels))?;
    let expected_size = count.checked_mul(8)?.checked_add(CACHE_HEADER_SIZE as u64)?;
    if file_size != expected_size || channels == 0 {
        log::warn!("Cache dimensions do not match file size");
        return None;
    }
    let sample_count = usize::try_from(count).ok()?;
    let mut samples = Vec::new();
    samples.try_reserve_exact(sample_count).ok()?;
    let mut hasher = crc32fast::Hasher::new();
    let mut block = vec![0u8; CACHE_BLOCK_BYTES];
    while samples.len() < sample_count {
        let n = (sample_count - samples.len()).min(CACHE_BLOCK_BYTES / 8);
        let bytes = &mut block[..n * 8];
        file.read_exact(bytes).ok()?;
        hasher.update(bytes);
        samples.extend(bytes.chunks_exact(8).map(|b| f64::from_le_bytes(b.try_into().unwrap())));
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
    LoadComplete { generation: u64, result: LoadResult },
    LoadError { generation: u64, error: String },
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
    pub pending_buffer: ArcSwapOption<Vec<f64>>,
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
    /// Monotonically increasing async load request id.
    /// Stale decode threads must not publish LoadComplete/LoadError for older ids.
    pub load_generation: AtomicU64,
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

            pending_buffer: ArcSwapOption::empty(),
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
            load_generation: AtomicU64::new(0),
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
#[cfg(test)]
mod cache_io_tests {
    use super::*;
    use std::time::Instant;

    struct Scratch(std::path::PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
    }
    fn scratch() -> Scratch {
        Scratch(std::env::temp_dir().join(format!("vcp-cache-test-{}-{}.bin", std::process::id(), rand::random::<u64>())))
    }

    fn legacy_header(samples: &[f64]) -> Vec<u8> {
        let mut h = b"VCP1".to_vec();
        for v in [1u32, 48000, 2] { h.extend(v.to_le_bytes()); }
        h.extend(((samples.len() / 2) as u64).to_le_bytes());
        let mut crc = crc32fast::Hasher::new();
        for s in samples { crc.update(&s.to_le_bytes()); }
        h.extend(crc.finalize().to_le_bytes());
        h.extend([0; 4]);
        h
    }

    #[test]
    fn legacy_bytes_roundtrip_and_reject_corruption() {
        let path = scratch();
        let data: Vec<_> = (0..8194).map(|i| f64::from_bits([0x8000000000000000, 0x7ff8000000000017, i][i as usize % 3])).collect();
        let mut legacy = legacy_header(&data);
        for s in &data { legacy.extend(s.to_le_bytes()); }
        fs::write(&path.0, &legacy).unwrap();
        let got = load_cache_with_header(&path.0, 48000, 2).unwrap();
        assert!(got.iter().map(|v| v.to_bits()).eq(data.iter().map(|v| v.to_bits())));
        save_cache_with_header(&path.0, &data, 48000, 2).unwrap();
        assert_eq!(fs::read(&path.0).unwrap(), legacy);
        *legacy.last_mut().unwrap() ^= 1;
        fs::write(&path.0, &legacy).unwrap();
        assert!(load_cache_with_header(&path.0, 48000, 2).is_none());
        legacy.pop();
        fs::write(&path.0, &legacy).unwrap();
        assert!(load_cache_with_header(&path.0, 48000, 2).is_none());
    }

    #[test]
    #[ignore = "manual filesystem timing; no timing threshold"]
    fn compare_cache_io() {
        let path = scratch();
        let data: Vec<_> = (0..262144).map(|i| i as f64).collect();
        let t = Instant::now();
        let mut f = fs::File::create(&path.0).unwrap();
        f.write_all(&legacy_header(&data)).unwrap();
        for s in &data { f.write_all(&s.to_le_bytes()).unwrap(); }
        drop(f);
        let old_write = t.elapsed();
        let t = Instant::now();
        let mut f = fs::File::open(&path.0).unwrap();
        let mut header = [0; 32];
        f.read_exact(&mut header).unwrap();
        let mut crc = crc32fast::Hasher::new();
        let mut decoded = Vec::with_capacity(data.len());
        for _ in &data {
            let mut b = [0; 8];
            f.read_exact(&mut b).unwrap();
            crc.update(&b);
            decoded.push(f64::from_le_bytes(b));
        }
        let old_read = t.elapsed();
        assert_eq!(crc.finalize(), read_u32_from_bytes(&header, 24));
        assert_eq!(decoded, data);
        drop(f);
        let t = Instant::now();
        save_cache_with_header(&path.0, &data, 48000, 2).unwrap();
        let new_write = t.elapsed();
        let t = Instant::now();
        let got = load_cache_with_header(&path.0, 48000, 2).unwrap();
        let new_read = t.elapsed();
        assert_eq!(got, data);
        println!("2 MiB payload | legacy write {old_write:?} read {old_read:?} | block write {new_write:?} read {new_read:?}");
    }
}
