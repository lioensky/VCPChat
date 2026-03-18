//! Gapless playback support
//!
//! Provides seamless track transitions by preloading the next track
//! and swapping buffers at the sample boundary.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::thread;

use super::state::SharedState;
use super::callback::normalize_channels;
use crate::config::AppConfig;
use crate::config::NormalizationMode;
use crate::decoder::StreamingDecoder;
use crate::processor::StreamingResampler;

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

            match decode_to_buffer_with_cancel(
                &path,
                target_sr,
                target_channels,
                credentials.as_ref(),
                &config_clone,
                &shared_clone.cancel_preload_signal,
            ) {
                Ok((samples, sr, channels, metadata)) => {
                    // Check for cancellation after decode (Defect 31 fix)
                    if shared_clone.cancel_preload_signal.load(Ordering::Acquire) {
                        log::info!("Gapless preload cancelled after decode, discarding: {}", path);
                        return;
                    }
                    
                    let total_frames = samples.len() / channels;

                    // Analyze loudness (before move) - FIX for Defect 22 and Bug-4:
                    // Use calculate_gain_with_mode() to respect ReplayGain mode.
                    // Store in pending_target_gain_db for application after buffer swap.
                    if loudness_enabled {
                        let pending_gain_db = loudness_normalizer_clone.lock()
                            .calculate_gain_with_mode(&samples, mode_for_thread, &metadata);
                        shared_clone.pending_target_gain_db.store(pending_gain_db.to_bits(), Ordering::Relaxed);
                    } else {
                        shared_clone.pending_target_gain_db.store(0.0_f64.to_bits(), Ordering::Relaxed);
                    }

                    // Store pending metadata
                    shared_clone.pending_total_frames.store(total_frames as u64, Ordering::Relaxed);
                    shared_clone.pending_sample_rate.store(sr as u64, Ordering::Relaxed);
                    shared_clone.pending_channels.store(channels as u64, Ordering::Relaxed);
                    *shared_clone.pending_file_path.write() = Some(path.clone());
                    *shared_clone.pending_metadata.write() = Some(metadata);

                    // Move samples into pending buffer (zero-copy)
                    *shared_clone.pending_buffer.write() = Some(samples);

                    // Signal ready (Release ordering ensures buffer is visible)
                    shared_clone.pending_ready.store(true, Ordering::Release);
                    log::info!("Gapless preload complete: {} frames @ {} Hz", total_frames, sr);
                }
                Err(e) => {
                    // Don't restore needs_preload if we were cancelled
                    if !shared_clone.cancel_preload_signal.load(Ordering::Acquire) {
                        log::error!("Gapless preload failed: {}", e);
                        // Restore needs_preload so frontend can retry
                        shared_for_error.needs_preload.store(true, Ordering::Release);
                    } else {
                        log::info!("Gapless preload cancelled with error: {}", e);
                    }
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
        *shared.pending_buffer.write() = None;
        shared.pending_ready.store(false, Ordering::Relaxed);
        shared.needs_preload.store(false, Ordering::Relaxed);
        log::info!("Gapless preload cancelled");
    }
}

/// Decode audio file to f64 sample buffer
///
/// Auto-resamples to target_sr, normalizes channels to target_channels
fn decode_to_buffer(
    path: &str,
    target_sr: u32,
    target_channels: usize,
    credentials: Option<&crate::decoder::HttpCredentials>,
    config: &AppConfig,
) -> Result<(Vec<f64>, u32, usize, crate::decoder::TrackMetadata), String> {
    decode_to_buffer_with_cancel(path, target_sr, target_channels, credentials, config, &std::sync::atomic::AtomicBool::new(false))
}

/// Decode audio file to f64 sample buffer with cancellation support
///
/// Auto-resamples to target_sr, normalizes channels to target_channels.
/// Checks cancel_signal during decode loop for early termination (Defect 31 fix).
fn decode_to_buffer_with_cancel(
    path: &str,
    target_sr: u32,
    target_channels: usize,
    credentials: Option<&crate::decoder::HttpCredentials>,
    config: &AppConfig,
    cancel_signal: &std::sync::atomic::AtomicBool,
) -> Result<(Vec<f64>, u32, usize, crate::decoder::TrackMetadata), String> {
    let mut decoder = StreamingDecoder::open_with_credentials(path, credentials)
        .map_err(|e| e.to_string())?;

    let original_sr = decoder.info.sample_rate;
    let decoded_channels = decoder.info.channels;
    let need_resample = target_sr != original_sr;
    
    // Extract metadata before decoding
    let metadata = decoder.info.metadata.clone();

    let estimated_frames = decoder.info.total_frames.unwrap_or(0) as usize;
    let estimated_output_frames = if need_resample {
        (estimated_frames as f64 * target_sr as f64 / original_sr as f64).ceil() as usize
    } else {
        estimated_frames
    };

    let mut samples: Vec<f64> = Vec::with_capacity(estimated_output_frames * decoded_channels);
    let mut resampler = if need_resample {
        Some(StreamingResampler::with_phase(decoded_channels, original_sr, target_sr, config.phase_response)
            .map_err(|e| format!("Failed to create gapless resampler: {}", e))?)
    } else {
        None
    };

    while let Some(chunk) = decoder.decode_next().map_err(|e| e.to_string())? {
        // Check for cancellation every chunk (Defect 31 fix)
        if cancel_signal.load(Ordering::Acquire) {
            return Err("Preload cancelled".to_string());
        }
        
        if let Some(ref mut rs) = resampler {
            samples.extend(rs.process_chunk(&chunk));
        } else {
            samples.extend(chunk);
        }
    }

    if let Some(ref mut rs) = resampler {
        samples.extend(rs.flush());
    }

    // Channel normalization
    let samples = if decoded_channels != target_channels {
        log::info!("Gapless: Channel normalize {} -> {}", decoded_channels, target_channels);
        normalize_channels(samples, decoded_channels, target_channels)
    } else {
        samples
    };

    Ok((samples, target_sr, target_channels, metadata))
}
