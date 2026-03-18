//! Audio thread implementation
//!
//! Contains the main audio thread that handles commands and manages playback.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use parking_lot::Mutex;
use crossbeam::channel::{Sender, Receiver};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Stream, StreamConfig};

#[cfg(debug_assertions)]
use assert_no_alloc::assert_no_alloc;

use super::state::{AudioCommand, PlayerState, SharedState};
use super::callback::audio_callback;
use crate::config::PhaseResponse;
use crate::processor::{
    Equalizer, VolumeController, NoiseShaper,
    AtomicLoudnessState, PeakLimiter, StreamingResampler,
    Saturation, Crossfeed, FFTConvolver, DynamicLoudness,
};

#[cfg(windows)]
use crate::wasapi_output::{WasapiExclusivePlayer, WasapiState};

/// Main audio thread entry point
///
/// Handles:
/// - Command processing (Play/Pause/Stop/Seek/Shutdown)
/// - Device enumeration and selection
/// - Stream creation and management
/// - WASAPI exclusive mode (Windows only)
#[allow(clippy::too_many_arguments)]
pub fn audio_thread_main(
    cmd_rx: Receiver<AudioCommand>,
    shared_state: Arc<SharedState>,
    eq: Arc<Mutex<Equalizer>>,
    volume: Arc<Mutex<VolumeController>>,
    noise_shaper: Arc<Mutex<NoiseShaper>>,
    loudness_state: Arc<AtomicLoudnessState>,
    peak_limiter: Arc<Mutex<PeakLimiter>>,
    convolver: Arc<Mutex<Option<FFTConvolver>>>,
    fir_convolver: Arc<Mutex<Option<FFTConvolver>>>,
    saturation: Arc<Mutex<Saturation>>,
    crossfeed: Arc<Mutex<Crossfeed>>,
    dynamic_loudness: Arc<Mutex<DynamicLoudness>>,
    spectrum_tx: Sender<f64>,
    phase_response: PhaseResponse,
) {
    log::info!("Audio thread started, initializing cpal host...");
    let mut stream: Option<Stream> = None;

    loop {
        match cmd_rx.recv() {
            Ok(AudioCommand::Play) => {
                log::info!("Received Play command");
                if *shared_state.state.read() == PlayerState::Paused {
                    if let Some(ref s) = stream { let _ = s.play(); }
                    *shared_state.state.write() = PlayerState::Playing;
                    continue;
                }

                let use_exclusive = shared_state.exclusive_mode.load(Ordering::Relaxed);

                // === WASAPI EXCLUSIVE MODE (Windows only) ===
                #[cfg(windows)]
                if use_exclusive {
                    if handle_wasapi_exclusive(
                        &cmd_rx,
                        &shared_state,
                        &spectrum_tx,
                        &eq,
                        &volume,
                        &noise_shaper,
                        &loudness_state,
                        &peak_limiter,
                        &convolver,
                        &fir_convolver,
                        &saturation,
                        &crossfeed,
                        &dynamic_loudness,
                    ) {
                        continue; // Playback finished, wait for next command
                    }
                    // If WASAPI failed, fall through to cpal
                }

                // === CPAL SHARED MODE (default) ===
                let host = cpal::default_host();

                // Get device_id from shared state
                let device_id_value = shared_state.device_id.load(Ordering::Relaxed);
                let requested_device_id = if device_id_value >= 0 {
                    Some(device_id_value as usize)
                } else {
                    None
                };

                // Select device
                let device = if let Some(id) = requested_device_id {
                    log::info!("Attempting to select device by ID: {}", id);
                    host.output_devices()
                        .ok()
                        .and_then(|mut devices| devices.nth(id))
                        .or_else(|| {
                            log::warn!("Device ID {} not found, falling back to default", id);
                            host.default_output_device()
                        })
                } else {
                    host.default_output_device()
                };

                let device = match device {
                    Some(d) => {
                        let name = d.name().unwrap_or_else(|_| "Unknown".to_string());
                        log::info!("Using audio device: {}", name);
                        d
                    }
                    None => {
                        log::error!("Failed to play: No audio output device found");
                        *shared_state.state.write() = PlayerState::Stopped;
                        continue;
                    }
                };

                let requested_sample_rate = shared_state.sample_rate.load(Ordering::Relaxed) as u32;
                let channels = shared_state.channels.load(Ordering::Relaxed) as u16;

                if channels == 0 {
                    log::error!("Failed to play: Invalid channel count (0)");
                    *shared_state.state.write() = PlayerState::Stopped;
                    continue;
                }

                // Query device configurations with same-family sample rate preference
                const MAX_DAC_RATE: u32 = 384000;
                
                /// Get sample rate family (44.1kHz or 48kHz based)
                fn get_rate_family(rate: u32) -> u32 {
                    match rate {
                        44100 | 88200 | 176400 | 352800 => 44100,
                        48000 | 96000 | 192000 | 384000 => 48000,
                        _ => rate,
                    }
                }
                
                let (actual_sample_rate, buffer_size) = match device.supported_output_configs() {
                    Ok(configs) => {
                        let configs: Vec<_> = configs.collect();
                        log::info!("Device supports {} output configurations", configs.len());

                        let mut best_rate = None;
                        let mut max_supported_rate = 0u32;

                        for config in &configs {
                            let min_rate = config.min_sample_rate().0;
                            let max_rate = config.max_sample_rate().0;
                            log::debug!("  Config: {} ch, {}-{} Hz", config.channels(), min_rate, max_rate);

                            if config.channels() == channels {
                                if max_rate > max_supported_rate {
                                    max_supported_rate = max_rate;
                                }
                                
                                // Priority 1: Exact match
                                if requested_sample_rate >= min_rate && requested_sample_rate <= max_rate {
                                    best_rate = Some(requested_sample_rate);
                                    break;  // Found exact match, stop searching
                                }
                                
                                // Priority 2: Same-family integer multiple (avoid SRC)
                                if best_rate.is_none() {
                                    for multiplier in [2u32, 4u32] {
                                        if let Some(candidate) = requested_sample_rate.checked_mul(multiplier) {
                                            if candidate >= min_rate && candidate <= max_rate && candidate <= MAX_DAC_RATE {
                                                best_rate = Some(candidate);
                                                log::debug!(
                                                    "Found same-family rate: {} Hz ({}x requested)",
                                                    candidate, multiplier
                                                );
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        let final_rate = best_rate.unwrap_or_else(|| {
                            if max_supported_rate > 0 {
                                log::warn!(
                                    "Requested {} Hz not supported, using device max {} Hz",
                                    requested_sample_rate, max_supported_rate
                                );
                                max_supported_rate
                            } else {
                                device.default_output_config()
                                    .map(|c| c.sample_rate().0)
                                    .unwrap_or(48000)
                            }
                        });

                        let buf = if use_exclusive && best_rate.is_some() {
                            cpal::BufferSize::Fixed(512)
                        } else {
                            cpal::BufferSize::Default
                        };

                        (final_rate, buf)
                    }
                    Err(e) => {
                        log::warn!("Failed to query device configs: {}. Using default.", e);
                        let rate = device.default_output_config()
                            .map(|c| c.sample_rate().0)
                            .unwrap_or(48000);
                        (rate, cpal::BufferSize::Default)
                    }
                };

                log::info!(
                    "Opening stream: {} Hz (requested {}), {} channels, exclusive={}",
                    actual_sample_rate, requested_sample_rate, channels, use_exclusive
                );

                let config = StreamConfig {
                    channels,
                    sample_rate: cpal::SampleRate(actual_sample_rate),
                    buffer_size,
                };

                // Initialize resampler if needed
                let mut resampler = if actual_sample_rate != requested_sample_rate {
                    match StreamingResampler::with_phase(
                        channels as usize,
                        requested_sample_rate,
                        actual_sample_rate,
                        phase_response
                    ) {
                        Ok(rs) => Some(rs),
                        Err(e) => {
                            log::error!("Failed to create resampler: {}. Playback aborted.", e);
                            *shared_state.state.write() = PlayerState::Stopped;
                            continue;
                        }
                    }
                } else {
                    None
                };

                let cb_shared = Arc::clone(&shared_state);
                let cb_eq = Arc::clone(&eq);
                let cb_volume = Arc::clone(&volume);
                let cb_ns = Arc::clone(&noise_shaper);
                let cb_loudness_state = Arc::clone(&loudness_state);
                let cb_peak_limiter = Arc::clone(&peak_limiter);
                let cb_convolver = Arc::clone(&convolver);
                let cb_fir_convolver = Arc::clone(&fir_convolver);
                let cb_saturation = Arc::clone(&saturation);
                let cb_crossfeed = Arc::clone(&crossfeed);
                let cb_dynamic_loudness = Arc::clone(&dynamic_loudness);
                let cb_spectrum_tx = spectrum_tx.clone();

                let mut process_buffer = Vec::with_capacity(8192 * channels as usize);
                process_buffer.resize(8192 * channels as usize, 0.0);  // Pre-fill to avoid allocation
                let mut resample_buffer = Vec::new();
                // FIX for RISK-08: Pre-allocated output buffer for process_chunk_into()
                let mut resample_output = Vec::with_capacity(16384 * channels as usize);

                log::info!("Building output stream...");
                let new_stream = device.build_output_stream(
                    &config,
                    move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                        #[cfg(debug_assertions)]
                        assert_no_alloc(|| {
                            audio_callback(
                                data,
                                &cb_shared,
                                &cb_eq,
                                &cb_volume,
                                &cb_ns,
                                &cb_loudness_state,
                                &cb_peak_limiter,
                                &cb_convolver,
                                &cb_fir_convolver,
                                &cb_saturation,
                                &cb_crossfeed,
                                &cb_dynamic_loudness,
                                &cb_spectrum_tx,
                                channels as usize,
                                &mut process_buffer,
                                &mut resampler,
                                &mut resample_buffer,
                                &mut resample_output,
                            );
                        });
                        
                        #[cfg(not(debug_assertions))]
                        audio_callback(
                            data,
                            &cb_shared,
                            &cb_eq,
                            &cb_volume,
                            &cb_ns,
                            &cb_loudness_state,
                            &cb_peak_limiter,
                            &cb_convolver,
                            &cb_fir_convolver,
                            &cb_saturation,
                            &cb_crossfeed,
                            &cb_dynamic_loudness,
                            &cb_spectrum_tx,
                            channels as usize,
                            &mut process_buffer,
                            &mut resampler,
                            &mut resample_buffer,
                            &mut resample_output,
                        );
                    },
                    |err| log::error!("Stream error: {}", err),
                    None,
                );

                match new_stream {
                    Ok(s) => {
                        let _ = s.play();
                        stream = Some(s);
                        *shared_state.state.write() = PlayerState::Playing;
                        
                        // FIX for Defect-37: Detect output bit depth from device config
                        // cpal outputs f32 by default, but the actual DAC bit depth matters for noise shaping
                        // We infer from the sample format:
                        // - F32: Float output, typically 24-bit DAC (dither less critical)
                        // - I16: 16-bit output
                        // - I32: Could be 24-bit or 32-bit DAC (assume 24-bit, most common)
                        let detected_bits: u32 = match device.default_output_config() {
                            Ok(cfg) => match cfg.sample_format() {
                                cpal::SampleFormat::I16 => 16,
                                cpal::SampleFormat::I32 => 24,  // Usually 24-bit in 32-bit container
                                cpal::SampleFormat::F32 => 24,  // Float output, assume 24-bit DAC
                                _ => 24,  // Default
                            },
                            Err(_) => 24,  // Default fallback
                        };
                        
                        shared_state.output_bits.store(detected_bits, Ordering::Relaxed);
                        noise_shaper.lock().set_bits(detected_bits);
                        log::info!("Stream started successfully at {} Hz, {}-bit output", actual_sample_rate, detected_bits);
                    }
                    Err(e) => {
                        log::error!("Failed to build stream: {}. Trying device default config...", e);

                        // Fallback to device default config
                        if let Ok(default_config) = device.default_output_config() {
                            let fallback_config: StreamConfig = default_config.clone().into();
                            let fallback_sr = fallback_config.sample_rate.0;
                            let fallback_channels = fallback_config.channels as usize;

                            let mut fallback_resampler = if fallback_sr != requested_sample_rate {
                                match StreamingResampler::with_phase(
                                    fallback_channels,
                                    requested_sample_rate,
                                    fallback_sr,
                                    phase_response
                                ) {
                                    Ok(rs) => Some(rs),
                                    Err(e) => {
                                        log::error!("Failed to create fallback resampler: {}", e);
                                        None
                                    }
                                }
                            } else {
                                None
                            };

                            let cb_shared = Arc::clone(&shared_state);
                            let cb_eq = Arc::clone(&eq);
                            let cb_volume = Arc::clone(&volume);
                            let cb_ns = Arc::clone(&noise_shaper);
                            let cb_loudness_state = Arc::clone(&loudness_state);
                            let cb_peak_limiter = Arc::clone(&peak_limiter);
                            let cb_convolver = Arc::clone(&convolver);
                            let cb_fir_convolver = Arc::clone(&fir_convolver);
                            let cb_saturation = Arc::clone(&saturation);
                            let cb_crossfeed = Arc::clone(&crossfeed);
                            let cb_dynamic_loudness = Arc::clone(&dynamic_loudness);
                            let cb_spectrum_tx = spectrum_tx.clone();
                            let mut process_buffer = Vec::with_capacity(8192 * fallback_channels);
                            process_buffer.resize(8192 * fallback_channels, 0.0);  // Pre-fill
                            let mut fallback_resample_buffer = Vec::new();
                            // FIX for RISK-08: Pre-allocated output buffer for process_chunk_into()
                            let mut fallback_resample_output = Vec::with_capacity(16384 * fallback_channels);

                            match device.build_output_stream(
                                &fallback_config,
                                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                                    #[cfg(debug_assertions)]
                                    assert_no_alloc(|| {
                                        audio_callback(
                                            data,
                                            &cb_shared,
                                            &cb_eq,
                                            &cb_volume,
                                            &cb_ns,
                                            &cb_loudness_state,
                                            &cb_peak_limiter,
                                            &cb_convolver,
                                            &cb_fir_convolver,
                                            &cb_saturation,
                                            &cb_crossfeed,
                                            &cb_dynamic_loudness,
                                            &cb_spectrum_tx,
                                            fallback_channels,
                                            &mut process_buffer,
                                            &mut fallback_resampler,
                                            &mut fallback_resample_buffer,
                                            &mut fallback_resample_output,
                                        );
                                    });
                                    
                                    #[cfg(not(debug_assertions))]
                                    audio_callback(
                                        data,
                                        &cb_shared,
                                        &cb_eq,
                                        &cb_volume,
                                        &cb_ns,
                                        &cb_loudness_state,
                                        &cb_peak_limiter,
                                        &cb_convolver,
                                        &cb_fir_convolver,
                                        &cb_saturation,
                                        &cb_crossfeed,
                                        &cb_dynamic_loudness,
                                        &cb_spectrum_tx,
                                        fallback_channels,
                                        &mut process_buffer,
                                        &mut fallback_resampler,
                                        &mut fallback_resample_buffer,
                                        &mut fallback_resample_output,
                                    );
                                },
                                |err| log::error!("Stream error: {}", err),
                                None,
                            ) {
                                Ok(s) => {
                                    let _ = s.play();
                                    stream = Some(s);
                                    *shared_state.state.write() = PlayerState::Playing;
                                    
                                    // FIX for Defect-37 residual: Detect output bit depth in fallback path
                                    let detected_bits: u32 = match device.default_output_config() {
                                        Ok(cfg) => match cfg.sample_format() {
                                            cpal::SampleFormat::I16 => 16,
                                            cpal::SampleFormat::I32 => 24,
                                            cpal::SampleFormat::F32 => 24,
                                            _ => 24,
                                        },
                                        Err(_) => 24,
                                    };
                                    shared_state.output_bits.store(detected_bits, Ordering::Relaxed);
                                    noise_shaper.lock().set_bits(detected_bits);
                                    
                                    log::info!("Stream started with device default config, {}-bit output", detected_bits);
                                }
                                Err(e2) => {
                                    log::error!("Failed to start stream even with device default: {}", e2);
                                    *shared_state.state.write() = PlayerState::Stopped;
                                }
                            }
                        } else {
                            log::error!("Cannot get device default config");
                            *shared_state.state.write() = PlayerState::Stopped;
                        }
                    }
                }
            }
            Ok(AudioCommand::Pause) => {
                if let Some(ref s) = stream { let _ = s.pause(); }
                *shared_state.state.write() = PlayerState::Paused;
            }
            Ok(AudioCommand::Seek(time)) => {
                let sr = shared_state.sample_rate.load(Ordering::Relaxed) as f64;
                let total = shared_state.total_frames.load(Ordering::Relaxed);
                let new_pos = ((time * sr) as u64).min(total);
                shared_state.position_frames.store(new_pos, Ordering::Relaxed);
            }
            Ok(AudioCommand::Stop) => {
                stream = None;
                shared_state.position_frames.store(0, Ordering::Relaxed);
                *shared_state.state.write() = PlayerState::Stopped;
            }
            Ok(AudioCommand::LoadComplete(result)) => {
                log::info!("Async load complete: {} frames @ {} Hz", result.total_frames, result.sample_rate);
                shared_state.sample_rate.store(result.sample_rate as u64, Ordering::Relaxed);
                shared_state.channels.store(result.channels as u64, Ordering::Relaxed);
                shared_state.total_frames.store(result.total_frames, Ordering::Relaxed);
                shared_state.position_frames.store(0, Ordering::Relaxed);
                *shared_state.state.write() = PlayerState::Stopped;
                *shared_state.audio_buffer.write() = result.samples.clone();
                *shared_state.file_path.write() = Some(result.file_path.clone());
                
                // Store track metadata
                *shared_state.track_metadata.write() = result.metadata.clone();
                *shared_state.current_track_path.write() = Some(result.file_path);

                // Re-initialize ALL processors for new sample rate (fixes DEFECT-16)
                let channels = result.channels;
                let sr = result.sample_rate as f64;
                let sr_u32 = result.sample_rate;
                
                // 1. Equalizer - already updated
                *eq.lock() = Equalizer::new(channels, sr);
                
                // 2. NoiseShaper - FIX for Defect-37: Read bit depth from SharedState
                // This value is set by /configure_output_bits API or auto-detected at Play time
                let output_bits = shared_state.output_bits.load(Ordering::Relaxed);
                *noise_shaper.lock() = NoiseShaper::new(channels, sr_u32, output_bits);
                log::debug!("NoiseShaper initialized with {} bits", output_bits);
                
                // 3. Crossfeed - update HPF coefficients for correct cutoff frequency
                crossfeed.lock().set_sample_rate(sr, 700.0);
                
                // 4. PeakLimiter - update time constants (lookahead frames, release coeff)
                *peak_limiter.lock() = PeakLimiter::new(
                    channels,
                    sr_u32,
                    -1.0,   // threshold dB
                    10.0,   // lookahead ms
                    150.0,  // release ms
                );
                
                // 5. Saturation - update HPF coefficient for exciter mode
                saturation.lock().set_sample_rate(sr);
                
                // 6. LoudnessState - update smoothing coefficient
                loudness_state.set_smoothing(200.0, sr_u32);  // 200ms smoothing time
                
                // 7. Apply ReplayGain if mode is ReplayGainTrack or ReplayGainAlbum
                // Mode values: 0=Track, 1=Album, 2=Streaming, 3=ReplayGainTrack, 4=ReplayGainAlbum
                let mode_val = loudness_state.mode.load(Ordering::Relaxed);
                let preamp = loudness_state.preamp_gain_db.load(Ordering::Relaxed);
                
                // Helper: Calculate safe gain with peak protection
                // If gain is positive and peak value would cause clipping, reduce gain
                let calc_safe_gain = |rg_gain_db: f64, peak: Option<f64>, preamp_db: f64| -> f64 {
                    let requested_gain = rg_gain_db + preamp_db;
                    
                    if requested_gain <= 0.0 {
                        // No gain boost, no clipping risk
                        return requested_gain;
                    }
                    
                    if let Some(peak_val) = peak {
                        if peak_val > 0.0 {
                            // Calculate the maximum gain we can apply without clipping
                            // peak * linear_gain <= 0.99 (leave 1% headroom)
                            const HEADROOM: f64 = 0.99;
                            let max_linear = HEADROOM / peak_val;
                            let max_gain_db = 20.0 * max_linear.log10();
                            
                            if requested_gain > max_gain_db {
                                log::info!(
                                    "Peak protection: peak={:.4}, requested={:.2} dB, limited to {:.2} dB",
                                    peak_val, requested_gain, max_gain_db
                                );
                                return max_gain_db;
                            }
                        }
                    }
                    
                    requested_gain
                };
                
                match mode_val {
                    3 => { // ReplayGainTrack
                        if let Some(rg_gain) = result.metadata.rg_track_gain {
                            let peak = result.metadata.rg_track_peak;
                            let effective_gain = calc_safe_gain(rg_gain, peak, preamp);
                            loudness_state.set_target_gain(effective_gain);
                            log::info!("ReplayGain Track: {:.2} dB + preamp {:.2} dB -> {:.2} dB (peak: {:?})", 
                                rg_gain, preamp, effective_gain, peak);
                        } else {
                            // Fallback to EBU R128 analysis
                            log::warn!("No ReplayGain track gain found, falling back to EBU R128 analysis");
                            let mut meter = crate::processor::LoudnessMeter::new(channels, sr_u32);
                            meter.process(&result.samples);
                            let loudness = meter.integrated_loudness();
                            if loudness.is_finite() {
                                let gain = -12.0 - loudness + preamp;  // Default target -12 LUFS
                                loudness_state.set_target_gain(gain);
                                log::info!("EBU R128 fallback: {:.2} LUFS -> gain {:.2} dB", loudness, gain);
                            } else {
                                loudness_state.set_target_gain(preamp);
                                log::warn!("EBU R128 analysis failed, using preamp only: {:.2} dB", preamp);
                            }
                        }
                    }
                    4 => { // ReplayGainAlbum
                        // Prefer album gain, fallback to track gain
                        let rg_gain = result.metadata.rg_album_gain
                            .or(result.metadata.rg_track_gain);
                        let peak = result.metadata.rg_album_peak
                            .or(result.metadata.rg_track_peak);
                        if let Some(gain) = rg_gain {
                            let effective_gain = calc_safe_gain(gain, peak, preamp);
                            loudness_state.set_target_gain(effective_gain);
                            log::info!("ReplayGain Album: {:.2} dB + preamp {:.2} dB -> {:.2} dB (peak: {:?})", 
                                gain, preamp, effective_gain, peak);
                        } else {
                            // Fallback to EBU R128 analysis
                            log::warn!("No ReplayGain gain found, falling back to EBU R128 analysis");
                            let mut meter = crate::processor::LoudnessMeter::new(channels, sr_u32);
                            meter.process(&result.samples);
                            let loudness = meter.integrated_loudness();
                            if loudness.is_finite() {
                                let gain = -12.0 - loudness + preamp;
                                loudness_state.set_target_gain(gain);
                                log::info!("EBU R128 fallback: {:.2} LUFS -> gain {:.2} dB", loudness, gain);
                            } else {
                                loudness_state.set_target_gain(preamp);
                            }
                        }
                    }
                    _ => {
                        // Existing modes (Track, Album, Streaming) will be handled elsewhere
                        // or already have their gain set via LoudnessNormalizer
                    }
                }
                
                log::debug!("All processors re-initialized for {} Hz sample rate", sr_u32);
            }
            Ok(AudioCommand::LoadError(e)) => {
                log::error!("Async load failed: {}", e);
                *shared_state.state.write() = PlayerState::Stopped;
            }
            Ok(AudioCommand::Shutdown) | Err(_) => break,
        }
    }
}

/// WASAPI exclusive mode playback handler (Windows only)
#[cfg(windows)]
#[allow(clippy::too_many_arguments)]
fn handle_wasapi_exclusive(
    cmd_rx: &Receiver<AudioCommand>,
    shared_state: &Arc<SharedState>,
    spectrum_tx: &Sender<f64>,
    eq: &Arc<Mutex<Equalizer>>,
    volume: &Arc<Mutex<VolumeController>>,
    noise_shaper: &Arc<Mutex<NoiseShaper>>,
    loudness_state: &Arc<AtomicLoudnessState>,
    peak_limiter: &Arc<Mutex<PeakLimiter>>,
    convolver: &Arc<Mutex<Option<crate::processor::FFTConvolver>>>,
    fir_convolver: &Arc<Mutex<Option<crate::processor::FFTConvolver>>>,
    saturation: &Arc<Mutex<Saturation>>,
    crossfeed: &Arc<Mutex<Crossfeed>>,
    dynamic_loudness: &Arc<Mutex<DynamicLoudness>>,
) -> bool {
    log::info!("Starting TRUE WASAPI exclusive mode playback...");

    let sample_rate = shared_state.sample_rate.load(Ordering::Relaxed) as u32;
    let channels = shared_state.channels.load(Ordering::Relaxed) as usize;

    if channels == 0 {
        log::error!("Invalid channels");
        *shared_state.state.write() = PlayerState::Stopped;
        return true;
    }

    // Construct the live DSP callback
    let cb_shared = Arc::clone(shared_state);
    let cb_eq = Arc::clone(eq);
    let cb_volume = Arc::clone(volume);
    let cb_ns = Arc::clone(noise_shaper);
    let cb_loudness_state = Arc::clone(loudness_state);
    let cb_peak_limiter = Arc::clone(peak_limiter);
    let cb_convolver = Arc::clone(convolver);
    let cb_fir_convolver = Arc::clone(fir_convolver);
    let cb_saturation = Arc::clone(saturation);
    let cb_crossfeed = Arc::clone(crossfeed);
    let cb_dynamic_loudness = Arc::clone(dynamic_loudness);
    let cb_spectrum_tx = spectrum_tx.clone();

    // Allocate persistent buffers for the closure
    let mut process_buffer = Vec::with_capacity(8192 * channels);
    process_buffer.resize(8192 * channels, 0.0);
    
    // WASAPI inner loop handles resampling now, so `audio_callback` resampler args are unused!
    let mut unused_resampler = None;
    let mut unused_leftover = Vec::new();
    let mut unused_output = Vec::new();

    let dsp_callback = Box::new(move |data: &mut [f32], cb_channels: usize| -> bool {
        let mut is_eof = false;
        
        crate::player::callback::audio_callback(
            data,
            &cb_shared,
            &cb_eq,
            &cb_volume,
            &cb_ns,
            &cb_loudness_state,
            &cb_peak_limiter,
            &cb_convolver,
            &cb_fir_convolver,
            &cb_saturation,
            &cb_crossfeed,
            &cb_dynamic_loudness,
            &cb_spectrum_tx,
            cb_channels,
            &mut process_buffer,
            &mut unused_resampler,
            &mut unused_leftover,
            &mut unused_output,
        );
        
        if *cb_shared.state.read() == PlayerState::Stopped {
            is_eof = true;
        }
        
        is_eof
    });

    let device_id_value = shared_state.device_id.load(Ordering::Relaxed);
    let wasapi_device_id = if device_id_value >= 0 {
        Some(device_id_value as usize)
    } else {
        None
    };

    match WasapiExclusivePlayer::new(wasapi_device_id, sample_rate, channels, dsp_callback) {
        Ok(wasapi_player) => {
            if let Err(e) = wasapi_player.play() {
                log::error!("Failed to start WASAPI playback: {}", e);
                *shared_state.state.write() = PlayerState::Stopped;
                return true;
            }

            *shared_state.state.write() = PlayerState::Playing;

            // Wait for WASAPI to start
            let mut wait_count = 0;
            while wasapi_player.get_state() == WasapiState::Stopped && wait_count < 300 {
                std::thread::sleep(std::time::Duration::from_millis(10));
                wait_count += 1;
            }

            if wasapi_player.get_state() == WasapiState::Stopped {
                log::error!("WASAPI: Failed to start playback after waiting");
                *shared_state.state.write() = PlayerState::Stopped;
                return true;
            }

            log::info!("WASAPI: Playback started, entering monitoring loop");

            loop {
                // Check for commands
                if let Ok(cmd) = cmd_rx.try_recv() {
                    match cmd {
                        AudioCommand::Pause => {
                            let _ = wasapi_player.pause();
                            *shared_state.state.write() = PlayerState::Paused;
                        }
                        AudioCommand::Play => {
                            let _ = wasapi_player.play();
                            *shared_state.state.write() = PlayerState::Playing;
                        }
                        AudioCommand::Seek(time) => {
                            let sr = shared_state.sample_rate.load(Ordering::Relaxed) as f64;
                            let frame = (time * sr) as u64;
                            let total = shared_state.total_frames.load(Ordering::Relaxed);
                            // Update PlayerSharedState position so audio_callback jumps immediately
                            shared_state.position_frames.store(frame.min(total), Ordering::Relaxed);
                            // Tell WASAPI thread to clear its internal hardware buffer
                            let _ = wasapi_player.seek(frame);
                        }
                        AudioCommand::Stop => {
                            let _ = wasapi_player.stop();
                            shared_state.position_frames.store(0, Ordering::Relaxed);
                            *shared_state.state.write() = PlayerState::Stopped;
                            break;
                        }
                        AudioCommand::Shutdown => {
                            drop(wasapi_player);
                            return false; // Signal shutdown
                        }
                        _ => {}
                    }
                }

                // Check if finished (detected by audio_callback hitting EOF)
                if *shared_state.state.read() == PlayerState::Stopped {
                    log::info!("WASAPI playback finished");
                    let _ = wasapi_player.stop();
                    break;
                }

                std::thread::sleep(std::time::Duration::from_millis(50));
            }

            true // Playback finished normally
        }
        Err(e) => {
            log::error!("Failed to create WASAPI player: {}. Falling back to cpal.", e);
            false // Fall through to cpal
        }
    }
}
