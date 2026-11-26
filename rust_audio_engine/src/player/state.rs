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
use std::io::{Read, Write};
use crate::processor::NoiseShaperCurve;
use super::track_buffer::TrackBuffer;

// ============ Cache System ============

const CACHE_MAGIC: &[u8; 4] = b"VCP1";
const CACHE_VERSION: u32 = 1;
const CACHE_HEADER_SIZE: usize = 32;

fn read_u32_from_bytes(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset+4].try_into().unwrap())
}

fn read_u64_from_bytes(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset+8].try_into().unwrap())
}

/// Save a completed track buffer to the resample cache with header validation.
///
/// The on-disk format is unchanged: 32-byte header, then little-endian f64
/// samples, CRC32 over the sample bytes.
pub fn save_cache_with_header(
    path: &Path,
    buffer: &TrackBuffer,
    sample_rate: u32,
    channels: u32,
) -> std::io::Result<()> {
    if channels == 0 || buffer.ready_frames() == 0 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid cache frame dimensions"));
    }
    let frame_count = buffer.ready_frames();
    let mut hasher = crc32fast::Hasher::new();
    buffer.for_each_chunk(|chunk| {
        for sample in chunk {
            hasher.update(&sample.to_bits().to_le_bytes());
        }
    });
    let checksum = hasher.finalize();

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    // Write to a temporary name first so a crash never leaves a truncated
    // file that would only be rejected on the next load.
    let temporary = path.with_extension("bin.partial");
    let file = fs::File::create(&temporary)?;
    let mut writer = std::io::BufWriter::with_capacity(1 << 20, file);

    let mut header_bytes = [0u8; CACHE_HEADER_SIZE];
    header_bytes[0..4].copy_from_slice(CACHE_MAGIC);
    header_bytes[4..8].copy_from_slice(&CACHE_VERSION.to_le_bytes());
    header_bytes[8..12].copy_from_slice(&sample_rate.to_le_bytes());
    header_bytes[12..16].copy_from_slice(&channels.to_le_bytes());
    header_bytes[16..24].copy_from_slice(&frame_count.to_le_bytes());
    header_bytes[24..28].copy_from_slice(&checksum.to_le_bytes());
    writer.write_all(&header_bytes)?;

    let mut result = Ok(());
    buffer.for_each_chunk(|chunk| {
        if result.is_err() {
            return;
        }
        for sample in chunk {
            if let Err(error) = writer.write_all(&sample.to_le_bytes()) {
                result = Err(error);
                return;
            }
        }
    });
    result?;
    writer.flush()?;
    drop(writer);
    fs::rename(&temporary, path)?;

    log::info!("Saved {} frames to cache with header validation", frame_count);
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
) -> Option<Arc<TrackBuffer>> {
    let file = fs::File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    let mut file = std::io::BufReader::with_capacity(1 << 20, file);
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

    // Checked arithmetic: a corrupt header must not overflow into a size
    // that happens to match, or ask for an impossible allocation.
    let count = frame_count.checked_mul(u64::from(channels))?;
    let expected_size = count.checked_mul(8)?.checked_add(CACHE_HEADER_SIZE as u64)?;
    if channels == 0 || file_size != expected_size {
        log::warn!("Cache file size mismatch: expected {}, got {}", expected_size, file_size);
        return None;
    }

    // FIX for Defect 6: Stream CRC32 computation while reading samples
    // in a single pass, straight into the chunked track buffer (no second
    // full-size copy).
    let sample_count = usize::try_from(count).ok()?;
    let (buffer, mut writer) = TrackBuffer::new(channels as usize, Some(frame_count));
    let mut hasher = crc32fast::Hasher::new();
    let mut bytes = vec![0u8; 8 * 8192];
    let mut block: Vec<f64> = Vec::with_capacity(8192);
    let mut remaining = sample_count;
    while remaining > 0 {
        let take = remaining.min(8192);
        if file.read_exact(&mut bytes[..take * 8]).is_err() {
            log::warn!("Failed to read all samples from cache");
            return None;
        }
        hasher.update(&bytes[..take * 8]);
        block.clear();
        block.extend(
            bytes[..take * 8]
                .chunks_exact(8)
                .map(|b| f64::from_le_bytes(b.try_into().unwrap())),
        );
        writer.push(&block).ok()?;
        remaining -= take;
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

    writer.finish();
    log::info!("Loaded {} samples from validated cache (streaming checksum verified)", sample_count);
    Some(buffer)
}

// ============ Event Flag Constants (Task E) ============

pub const EVENT_LOAD_COMPLETE:       u32 = 1 << 0;
pub const EVENT_LOAD_ERROR:          u32 = 1 << 1;
pub const EVENT_TRACK_CHANGED:       u32 = 1 << 2;
pub const EVENT_PLAYBACK_ENDED:      u32 = 1 << 3;
pub const EVENT_NEEDS_PRELOAD:       u32 = 1 << 4;
pub const EVENT_NEEDS_PRELOAD_RESET: u32 = 1 << 5;
/// A control command finished on the audio thread (`applied_seq` moved).
pub const EVENT_COMMAND_APPLIED:     u32 = 1 << 6;
/// The current track's buffer finished decoding (duration is now exact).
pub const EVENT_DECODE_COMPLETE:     u32 = 1 << 7;

// ============ Commands & State ============

/// Load result for async loading
#[derive(Debug, Clone)]
pub struct LoadResult {
    /// Progressive buffer; may still be filling when the load completes.
    pub buffer: Arc<TrackBuffer>,
    pub sample_rate: u32,
    pub channels: usize,
    /// Estimated length until the buffer completes.
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
    /// Integrated loudness measured while streaming a track that has no
    /// ReplayGain tags; applied only if `generation` is still current.
    LoudnessMeasured { generation: u64, integrated_lufs: f64 },
    /// Marker queued after a control command; the audio thread publishes it
    /// as `applied_seq` once every earlier command has taken effect.
    Applied(u64),
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

/// Exclusive mode was asked for but could not be opened; playing in shared mode.
pub const OUTPUT_FELL_BACK_FROM_EXCLUSIVE: u8 = 1;
/// The chosen output device is gone (unplugged, renumbered); playing on the default.
pub const OUTPUT_FELL_BACK_TO_DEFAULT_DEVICE: u8 = 2;

/// Names for the `output_fallback` bits, as reported in `/state`.
pub fn output_fallback_names(bits: u8) -> Vec<&'static str> {
    let mut names = Vec::new();
    if bits & OUTPUT_FELL_BACK_FROM_EXCLUSIVE != 0 { names.push("exclusive"); }
    if bits & OUTPUT_FELL_BACK_TO_DEFAULT_DEVICE != 0 { names.push("device"); }
    names
}

/// Where the chosen output device is in the current list. A name, when known,
/// wins over the saved position (positions shift as devices come and go).
/// Returns the index to open and whether the chosen device was missing.
pub fn resolve_output_device(names: &[String], wanted_name: Option<&str>, wanted_id: Option<usize>) -> (Option<usize>, bool) {
    if let Some(name) = wanted_name {
        return match names.iter().position(|n| n == name) {
            Some(i) => (Some(i), false),
            None => (None, true),
        };
    }
    match wanted_id {
        Some(id) if id < names.len() => (Some(id), false),
        Some(_) => (None, true),
        None => (None, false),
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
    pub audio_buffer: ArcSwap<TrackBuffer>,
    /// Set by the callback while it is starved waiting for the decoder.
    pub buffering: AtomicBool,
    /// Output fade for pause/resume (f32 bits). The control thread sets the
    /// target; only the audio callback moves `fade_gain` toward it.
    pub fade_target: std::sync::atomic::AtomicU32,
    pub fade_gain: std::sync::atomic::AtomicU32,
    pub exclusive_mode: AtomicBool,
    /// What the last stream open had to fall back from (`OUTPUT_FELL_BACK_*` bits).
    /// Without this the UI keeps showing exclusive mode / the chosen device
    /// while the engine is actually playing shared / on the default device.
    pub output_fallback: AtomicU8,
    pub device_id: std::sync::atomic::AtomicI64,
    /// Name of the chosen device; when set, the stream is opened on the device
    /// with this name wherever it now sits in the list (`device_id` is updated).
    pub device_name: RwLock<Option<String>>,
    pub volume: std::sync::atomic::AtomicU64,
    pub file_path: RwLock<Option<String>>,
    pub eq_type: RwLock<String>,
    pub noise_shaper_curve: RwLock<NoiseShaperCurve>,

    // Gapless playback fields
    /// Pending audio buffer for gapless transition — lock-free via ArcSwap.
    /// The preload thread stores the decoded next-track samples here;
    /// the audio callback atomically swaps it into audio_buffer at track boundary.
    pub pending_buffer: ArcSwapOption<TrackBuffer>,
    /// Buffers swapped out by the realtime callback are sent here so they are
    /// freed on a non-realtime thread (the spectrum thread drains it).
    pub retired_buffers_tx: crossbeam::channel::Sender<Arc<TrackBuffer>>,
    pub retired_buffers_rx: crossbeam::channel::Receiver<Arc<TrackBuffer>>,
    pub pending_total_frames: AtomicU64,
    pub pending_sample_rate: AtomicU64,
    pub pending_channels: AtomicU64,
    pub pending_file_path: RwLock<Option<String>>,
    pub needs_preload: AtomicBool,
    /// Crossfade length in milliseconds (0 = off: plain gapless join).
    pub crossfade_ms: AtomicU64,
    /// Frame of the current buffer where a crossfade into the pending track began
    /// (u64::MAX = none). Latched at the window start so the incoming track always
    /// starts from its first frame.
    pub crossfade_from: AtomicU64,
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

    // Command sequencing: every control command gets the next `cmd_seq`;
    // the audio thread stores it in `applied_seq` after the command ran.
    pub cmd_seq: AtomicU64,
    pub applied_seq: AtomicU64,

    // WebSocket event flags — unified bitmask (Task E)
    // Writers: audio thread or async tasks use fetch_or(EVENT_*, Release)
    // Reader: WebSocket pusher uses swap(0, AcqRel) to atomically take all events
    pub event_flags: std::sync::atomic::AtomicU32,
    /// Wakes the WebSocket hub right away for events raised off the realtime
    /// thread (load done, command applied), instead of at its next 50 ms tick.
    pub event_notify: tokio::sync::Notify,
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
        let (retired_buffers_tx, retired_buffers_rx) = crossbeam::channel::bounded(8);
        Self {
            state: AtomicPlayerState::new(PlayerState::Stopped),
            position_frames: AtomicU64::new(0),
            sample_rate: AtomicU64::new(44100),
            channels: AtomicU64::new(2),
            total_frames: AtomicU64::new(0),
            spectrum_data: Mutex::new(vec![0.0; 64]),
            audio_buffer: ArcSwap::new(Arc::new(TrackBuffer::empty())),
            buffering: AtomicBool::new(false),
            fade_target: std::sync::atomic::AtomicU32::new(1.0f32.to_bits()),
            fade_gain: std::sync::atomic::AtomicU32::new(1.0f32.to_bits()),
            exclusive_mode: AtomicBool::new(false),
            output_fallback: AtomicU8::new(0),
            device_id: std::sync::atomic::AtomicI64::new(-1),
            device_name: RwLock::new(None),
            volume: std::sync::atomic::AtomicU64::new(1_000_000),
            file_path: RwLock::new(None),
            eq_type: RwLock::new("IIR".to_string()),
            noise_shaper_curve: RwLock::new(NoiseShaperCurve::Lipshitz5),

            pending_buffer: ArcSwapOption::empty(),
            retired_buffers_tx,
            retired_buffers_rx,
            pending_total_frames: AtomicU64::new(0),
            pending_sample_rate: AtomicU64::new(44100),
            pending_channels: AtomicU64::new(2),
            pending_file_path: RwLock::new(None),
            needs_preload: AtomicBool::new(false),
            crossfade_ms: AtomicU64::new(0),
            crossfade_from: AtomicU64::new(u64::MAX),
            pending_ready: AtomicBool::new(false),
            dsp_reset_pending: AtomicBool::new(false),
            cancel_preload_signal: AtomicBool::new(false),
            pending_target_gain_db: std::sync::atomic::AtomicU64::new(0_f64.to_bits()),

            gapless_swap_pending: AtomicBool::new(false),

            is_loading: AtomicBool::new(false),
            load_generation: AtomicU64::new(0),
            load_progress: AtomicU64::new(0),
            load_error: RwLock::new(None),
            cmd_seq: AtomicU64::new(0),
            applied_seq: AtomicU64::new(0),

            event_flags: std::sync::atomic::AtomicU32::new(0),
            event_notify: tokio::sync::Notify::new(),
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

    /// Track length. While a streamed track is still decoding this is the
    /// container estimate; it becomes exact once decoding finishes.
    pub fn duration_secs(&self) -> f64 {
        let total = self.audio_buffer.load().duration_frames();
        let sr = self.sample_rate.load(Ordering::Relaxed).max(1);
        total as f64 / sr as f64
    }

    /// Seconds of the current track that are decoded and playable.
    pub fn buffered_secs(&self) -> f64 {
        let ready = self.audio_buffer.load().ready_frames();
        let sr = self.sample_rate.load(Ordering::Relaxed).max(1);
        ready as f64 / sr as f64
    }

    /// Whether the current track has finished decoding.
    pub fn decode_complete(&self) -> bool {
        self.audio_buffer.load().is_complete()
    }
}

impl SharedState {
    /// Allocate the next command sequence number.
    pub fn next_cmd_seq(&self) -> u64 {
        self.cmd_seq.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// Raise events from a non-realtime thread and wake the pusher.
    /// (The audio callback only sets `event_flags`; it must not touch Notify.)
    pub fn raise_events(&self, flags: u32) {
        self.event_flags.fetch_or(flags, Ordering::Release);
        self.event_notify.notify_one();
    }

    /// Free retired track buffers. Call only from non-realtime threads.
    pub fn reclaim_retired_buffers(&self) {
        while self.retired_buffers_rx.try_recv().is_ok() {}
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

    struct Scratch(std::path::PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
    }
    fn scratch() -> Scratch {
        Scratch(std::env::temp_dir().join(format!("vcp-cache-test-{}-{}.bin", std::process::id(), rand::random::<u64>())))
    }

    fn legacy_bytes(samples: &[f64]) -> Vec<u8> {
        let mut h = b"VCP1".to_vec();
        for v in [1u32, 48000, 2] { h.extend(v.to_le_bytes()); }
        h.extend(((samples.len() / 2) as u64).to_le_bytes());
        let mut crc = crc32fast::Hasher::new();
        for s in samples { crc.update(&s.to_le_bytes()); }
        h.extend(crc.finalize().to_le_bytes());
        h.extend([0; 4]);
        for s in samples { h.extend(s.to_le_bytes()); }
        h
    }

    #[test]
    fn legacy_bytes_roundtrip_and_reject_corruption() {
        let path = scratch();
        // The track buffer holds f32 samples, so use values f32 represents exactly
        // (including -0.0); the on-disk format stays little-endian f64.
        let data: Vec<f64> = (0..8194u32).map(|i| if i % 3 == 0 { -0.0 } else { f64::from(i as f32 * 0.25 - 1000.0) }).collect();
        let mut legacy = legacy_bytes(&data);
        fs::write(&path.0, &legacy).unwrap();
        let got = load_cache_with_header(&path.0, 48000, 2).unwrap().to_vec();
        assert!(got.iter().map(|v| v.to_bits()).eq(data.iter().map(|v| v.to_bits())));
        save_cache_with_header(&path.0, &TrackBuffer::from_samples(data.clone(), 2), 48000, 2).unwrap();
        assert_eq!(fs::read(&path.0).unwrap(), legacy);
        *legacy.last_mut().unwrap() ^= 1;
        fs::write(&path.0, &legacy).unwrap();
        assert!(load_cache_with_header(&path.0, 48000, 2).is_none());
        legacy.pop();
        fs::write(&path.0, &legacy).unwrap();
        assert!(load_cache_with_header(&path.0, 48000, 2).is_none());
    }

    #[test]
    fn header_with_overflowing_frame_count_is_rejected() {
        let path = scratch();
        let mut bytes = legacy_bytes(&[0.0; 4]);
        bytes[16..24].copy_from_slice(&u64::MAX.to_le_bytes());
        fs::write(&path.0, &bytes).unwrap();
        assert!(load_cache_with_header(&path.0, 48000, 2).is_none());
    }
}
