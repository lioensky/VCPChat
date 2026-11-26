//! Gapless playback support
//!
//! Provides seamless track transitions by preloading the next track
//! and swapping buffers at the sample boundary.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::thread;

use super::state::SharedState;
use super::stream_decode::{Pump, PumpOutcome};
use super::track_buffer::TrackBuffer;
use crate::config::AppConfig;
use crate::config::NormalizationMode;
use crate::decoder::StreamingDecoder;
use crate::processor::{LoudnessMeter, StreamingResampler};

/// Gapless playback methods
pub struct GaplessManager;

impl GaplessManager {
    /// Preload the next track for gapless playback
    ///
    /// Called by frontend after receiving WebSocket "needs_preload" event.
    /// Decodes the next track in a background thread and stores it in
    /// `pending_buffer` for seamless transition.
    pub fn queue_next(
        shared: &Arc<SharedState>,
        loudness_normalizer: &Arc<parking_lot::Mutex<crate::processor::LoudnessNormalizer>>,
        config: &AppConfig,
        path: &str,
        credentials: Option<crate::decoder::HttpCredentials>,
        loudness_enabled: bool,
        normalization_mode: NormalizationMode,
        loudness_cache: Option<Arc<crate::processor::LoudnessDatabase>>,
    ) -> Result<(), String> {
        // Ignore if pending buffer is already ready
        if shared.pending_ready.load(Ordering::Relaxed) {
            log::debug!("Gapless: pending already ready, ignoring queue_next");
            return Ok(());
        }

        let path = path.to_string();
        let shared_clone = Arc::clone(shared);
        let loudness_normalizer_clone = Arc::clone(loudness_normalizer);
        let config_clone = config.clone();
        let mode_for_thread = normalization_mode;

        // Get target sample rate and channels from current playback state
        let target_sr = shared.sample_rate.load(Ordering::Relaxed) as u32;
        let target_channels = shared.channels.load(Ordering::Relaxed) as usize;
        let target_channels = target_channels.max(1);

            // Clear needs_preload flag BEFORE spawning thread to prevent repeated WebSocket events
        shared.needs_preload.store(false, Ordering::Release);
        
        // Reset cancel signal before starting new preload (Defect 31 fix)
        shared.cancel_preload_signal.store(false, Ordering::Release);

        let shared_for_error = Arc::clone(shared);
        
        // Spawn background thread for decoding
        thread::spawn(move || {
            log::info!("Gapless preload started: {}", path);

            // Check for cancellation before starting (Defect 31 fix)
            if shared_clone.cancel_preload_signal.load(Ordering::Acquire) {
                log::info!("Gapless preload cancelled before decode: {}", path);
                return;
            }

            let result = stream_preload(
                &shared_clone,
                &loudness_normalizer_clone,
                &path,
                target_sr,
                target_channels,
                credentials.as_ref(),
                &config_clone,
                loudness_enabled,
                mode_for_thread,
                loudness_cache.as_deref(),
            );
            if let Err(e) = result {
                // Don't restore needs_preload if we were cancelled
                if !shared_for_error.cancel_preload_signal.load(Ordering::Acquire) {
                    log::error!("Gapless preload failed: {}", e);
                    // Restore needs_preload so frontend can retry
                    shared_for_error.needs_preload.store(true, Ordering::Release);
                } else {
                    log::info!("Gapless preload cancelled with error: {}", e);
                }
            }
        });

        Ok(())
    }

    /// Cancel pending preload
    ///
    /// Called when user manually changes track or seeks.
    pub fn cancel_preload(shared: &SharedState) {
        // Signal the preload thread to stop (Defect 31 fix)
        shared.cancel_preload_signal.store(true, Ordering::Release);
        // Clear pending buffer (lock-free atomic swap)
        shared.pending_buffer.store(None);
        shared.pending_ready.store(false, Ordering::Relaxed);
        shared.needs_preload.store(false, Ordering::Relaxed);
        log::info!("Gapless preload cancelled");
    }
}

/// Decode the next track into a progressive buffer and publish it as the
/// pending gapless buffer.
///
/// When the gain is known up front (normalization off, or a ReplayGain tag),
/// the buffer is published after about one second is decoded and keeps
/// filling while the current track finishes. When the gain needs an EBU R128
/// measurement of the whole track, it is published after decoding completes.
#[allow(clippy::too_many_arguments)]
fn stream_preload(
    shared: &Arc<SharedState>,
    loudness_normalizer: &Arc<parking_lot::Mutex<crate::processor::LoudnessNormalizer>>,
    path: &str,
    target_sr: u32,
    target_channels: usize,
    credentials: Option<&crate::decoder::HttpCredentials>,
    config: &AppConfig,
    loudness_enabled: bool,
    mode: NormalizationMode,
    loudness_cache: Option<&crate::processor::LoudnessDatabase>,
) -> Result<(), String> {
    let cancelled = || shared.cancel_preload_signal.load(Ordering::Acquire);

    let mut decoder = StreamingDecoder::open_with_credentials(path, credentials)
        .map_err(|e| e.to_string())?;
    let original_sr = decoder.info.sample_rate;
    let decoded_channels = decoder.info.channels;
    let metadata = decoder.info.metadata.clone();
    let need_resample = target_sr != original_sr;

    let estimated_frames = decoder.info.total_frames.unwrap_or(0);
    let estimated_output_frames = if estimated_frames == 0 {
        None
    } else if need_resample {
        Some((estimated_frames as f64 * target_sr as f64 / original_sr as f64).ceil() as u64)
    } else {
        Some(estimated_frames)
    };

    let resampler = if need_resample {
        Some(
            StreamingResampler::with_phase(decoded_channels, original_sr, target_sr, config.phase_response)
                .map_err(|e| format!("Failed to create gapless resampler: {}", e))?,
        )
    } else {
        None
    };

    // Same gain rules as a track that is picked by hand (`planned_gain_db`), so a song
    // is equally loud whether it was clicked or joined gaplessly. Known up front from a
    // tag or an earlier measurement; otherwise measured while decoding.
    let loudness_state = loudness_normalizer.lock().atomic_state();
    let plan = |measured: Option<f64>| {
        crate::processor::LoudnessNormalizer::planned_gain_db(
            mode,
            &metadata,
            measured,
            loudness_state.target_lufs(),
            loudness_state.reference_lufs(),
            loudness_state.preamp_gain_db(),
        )
    };
    let upfront_gain_db = if !loudness_enabled {
        Some(0.0)
    } else if crate::processor::LoudnessNormalizer::has_tag_gain(mode, &metadata) {
        plan(None)
    } else {
        super::cached_loudness(loudness_cache, path).and_then(|l| plan(Some(l)))
    };
    let needs_measurement = upfront_gain_db.is_none();

    if decoded_channels != target_channels {
        log::info!("Gapless: Channel normalize {} -> {}", decoded_channels, target_channels);
    }

    let (buffer, mut writer) = TrackBuffer::new(target_channels, estimated_output_frames);
    let mut pump = Pump {
        decoder: &mut decoder,
        resampler,
        source_channels: decoded_channels,
        output_channels: target_channels,
        meter: if needs_measurement {
            LoudnessMeter::new(target_channels, target_sr).ok()
        } else {
            None
        },
    };

    let publish = |buffer: &Arc<TrackBuffer>, total_frames: u64, gain_db: f64| {
        shared.pending_target_gain_db.store(gain_db.to_bits(), Ordering::Relaxed);
        shared.pending_total_frames.store(total_frames, Ordering::Relaxed);
        shared.pending_sample_rate.store(target_sr as u64, Ordering::Relaxed);
        shared.pending_channels.store(target_channels as u64, Ordering::Relaxed);
        *shared.pending_file_path.write() = Some(path.to_string());
        *shared.pending_metadata.write() = Some(metadata.clone());
        shared.pending_buffer.store(Some(Arc::clone(buffer)));
        // Release ordering makes the buffer and metadata visible first.
        shared.pending_ready.store(true, Ordering::Release);
    };

    let preroll_frames = target_sr as u64;
    let mut published = false;
    // Once the callback has swapped this buffer in, it is the current track:
    // a later cancel (for the following preload) must not cut it short.
    let is_playing_now = || Arc::ptr_eq(&shared.audio_buffer.load_full(), &buffer);
    let outcome = pump.run(
        &mut writer,
        || cancelled() && !is_playing_now(),
        |writer, _| {
            if let Some(gain_db) = upfront_gain_db {
                if !published && writer.buffer().ready_frames() >= preroll_frames && !cancelled() {
                    published = true;
                    publish(writer.buffer(), estimated_output_frames.unwrap_or(0), gain_db);
                    log::info!("Gapless preload ready to play (still decoding): {}", path);
                }
            }
        },
    )?;
    if matches!(outcome, PumpOutcome::Cancelled) {
        return Err("Preload cancelled".to_string());
    }

    let lufs = pump.integrated_loudness();
    let total_frames = writer.finish();
    if cancelled() {
        return Err("Preload cancelled".to_string());
    }
    if !published {
        if total_frames == 0 {
            return Err("Preloaded track is empty".to_string());
        }
        let gain_db = upfront_gain_db.unwrap_or_else(|| {
            if let Some(l) = lufs {
                super::store_loudness(loudness_cache, path, l);
            }
            lufs.and_then(|l| plan(Some(l))).unwrap_or(0.0)
        });
        publish(&buffer, total_frames, gain_db);
    }
    log::info!("Gapless preload complete: {} frames @ {} Hz", total_frames, target_sr);
    Ok(())
}
