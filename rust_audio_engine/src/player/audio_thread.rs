//! Audio thread implementation
//!
//! Contains the main audio thread that handles commands and manages playback.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use crossbeam::channel::{Receiver, Sender};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Stream, StreamConfig};

#[cfg(debug_assertions)]
use assert_no_alloc::assert_no_alloc;

use super::callback::{audio_callback_lockfree, LockfreeDspContext};
use super::state::{
    AudioCommand, PlayerState, SharedState,
    EVENT_LOAD_COMPLETE, EVENT_LOAD_ERROR,
};
use crate::config::PhaseResponse;
use crate::processor::{
    AtomicCrossfeedParams, AtomicDynamicLoudnessParams, AtomicDynamicLoudnessTelemetry,
    AtomicEqParams, AtomicLoudnessState, AtomicPeakLimiterParams, AtomicSaturationParams,
    AtomicVolumeParams, AtomicNoiseShaperParams, ConvolverProcessor, StreamingProcessor,
    StreamingResampler,
};

#[cfg(windows)]
use crate::wasapi_output::{
    DspCallbackOperation, WasapiExclusivePlayer, WasapiState,
};

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
    eq_params: Arc<AtomicEqParams>,
    saturation_params: Arc<AtomicSaturationParams>,
    crossfeed_params: Arc<AtomicCrossfeedParams>,
    limiter_params: Arc<AtomicPeakLimiterParams>,
    volume_params: Arc<AtomicVolumeParams>,
    noise_shaper_params: Arc<AtomicNoiseShaperParams>,
    dynamic_loudness_params: Arc<AtomicDynamicLoudnessParams>,
    dynamic_loudness_telemetry: Arc<AtomicDynamicLoudnessTelemetry>,
    loudness_state: Arc<AtomicLoudnessState>,
    noise_shaper_bits: u32,
    spectrum_tx: Sender<f64>,
    phase_response: PhaseResponse,
    target_lufs: f64,
) {
    log::info!("Audio thread started, initializing cpal host...");
    let mut stream: Option<Stream> = None;

    // Keep a default output bit-depth hint for downstream components.
    shared_state
        .output_bits
        .store(noise_shaper_bits.max(16), Ordering::Relaxed);
    noise_shaper_params.set_bits(noise_shaper_bits.max(16));

    let initial_channels = shared_state.channels.load(Ordering::Relaxed).max(1) as usize;
    let initial_sample_rate = shared_state.sample_rate.load(Ordering::Relaxed).max(1) as f64;

    let (dsp_ctx, _initial_pipeline) = LockfreeDspContext::new(
        initial_channels,
        initial_sample_rate,
        initial_sample_rate,
        Arc::clone(&eq_params),
        Arc::clone(&saturation_params),
        Arc::clone(&crossfeed_params),
        Arc::clone(&limiter_params),
        Arc::clone(&volume_params),
        Arc::clone(&noise_shaper_params),
        Arc::clone(&dynamic_loudness_params),
        Arc::clone(&dynamic_loudness_telemetry),
    );
    let dsp_ctx = Arc::new(dsp_ctx);

    loop {
        match cmd_rx.recv() {
            Ok(AudioCommand::Play) => {
                log::info!("Received Play command");
                if shared_state.state.load() == PlayerState::Paused {
                    if let Some(ref s) = stream {
                        let _ = s.play();
                    }
                    shared_state.state.store(PlayerState::Playing);
                    continue;
                }

                let use_exclusive = shared_state.exclusive_mode.load(Ordering::Relaxed);

                #[cfg(windows)]
                if use_exclusive {
                    if handle_wasapi_exclusive(
                        &cmd_rx,
                        &shared_state,
                        &dsp_ctx,
                        &loudness_state,
                        &spectrum_tx,
                    ) {
                        continue;
                    }
                }

                let host = cpal::default_host();

                let device_id_value = shared_state.device_id.load(Ordering::Relaxed);
                let requested_device_id = if device_id_value >= 0 {
                    Some(device_id_value as usize)
                } else {
                    None
                };

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
                        shared_state.state.store(PlayerState::Stopped);
                        continue;
                    }
                };

                let requested_sample_rate = shared_state.sample_rate.load(Ordering::Relaxed) as u32;
                let channels = shared_state.channels.load(Ordering::Relaxed) as u16;

                if channels == 0 {
                    log::error!("Failed to play: Invalid channel count (0)");
                    shared_state.state.store(PlayerState::Stopped);
                    continue;
                }

                const MAX_DAC_RATE: u32 = 384000;

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

                                if requested_sample_rate >= min_rate
                                    && requested_sample_rate <= max_rate
                                {
                                    best_rate = Some(requested_sample_rate);
                                    break;
                                }

                                if best_rate.is_none() {
                                    for multiplier in [2u32, 4u32] {
                                        if let Some(candidate) = requested_sample_rate.checked_mul(multiplier) {
                                            if candidate >= min_rate
                                                && candidate <= max_rate
                                                && candidate <= MAX_DAC_RATE
                                            {
                                                best_rate = Some(candidate);
                                                log::debug!(
                                                    "Found same-family rate: {} Hz ({}x requested)",
                                                    candidate,
                                                    multiplier
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
                                    requested_sample_rate,
                                    max_supported_rate
                                );
                                max_supported_rate
                            } else {
                                device
                                    .default_output_config()
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
                        let rate = device
                            .default_output_config()
                            .map(|c| c.sample_rate().0)
                            .unwrap_or(48000);
                        (rate, cpal::BufferSize::Default)
                    }
                };

                log::info!(
                    "Opening stream: {} Hz (requested {}), {} channels, exclusive={}",
                    actual_sample_rate,
                    requested_sample_rate,
                    channels,
                    use_exclusive
                );

                let config = StreamConfig {
                    channels,
                    sample_rate: cpal::SampleRate(actual_sample_rate),
                    buffer_size,
                };

                let mut resampler = if actual_sample_rate != requested_sample_rate {
                    match StreamingResampler::with_phase(
                        channels as usize,
                        requested_sample_rate,
                        actual_sample_rate,
                        phase_response,
                    ) {
                        Ok(rs) => Some(rs),
                        Err(e) => {
                            log::error!("Failed to create resampler: {}. Playback aborted.", e);
                            shared_state.state.store(PlayerState::Stopped);
                            continue;
                        }
                    }
                } else {
                    None
                };

                if let Err(error) = dsp_ctx.set_convolver_sample_rate(requested_sample_rate) {
                    log::error!("Failed to configure convolver source rate: {}", error);
                    shared_state.state.store(PlayerState::Stopped);
                    continue;
                }
                dsp_ctx.reclaim_retired_convolver();

                let cb_shared = Arc::clone(&shared_state);
                let cb_loudness_state = Arc::clone(&loudness_state);
                let cb_spectrum_tx = spectrum_tx.clone();

                // Build the callback-owned pipeline from the negotiated source
                // and device geometry before entering the realtime thread.
                let (_, mut cb_dsp_chain) = LockfreeDspContext::new(
                    channels as usize,
                    requested_sample_rate as f64,
                    actual_sample_rate as f64,
                    Arc::clone(&eq_params),
                    Arc::clone(&saturation_params),
                    Arc::clone(&crossfeed_params),
                    Arc::clone(&limiter_params),
                    Arc::clone(&volume_params),
                    Arc::clone(&noise_shaper_params),
                    Arc::clone(&dynamic_loudness_params),
                    Arc::clone(&dynamic_loudness_telemetry),
                );

                let mut process_buffer = Vec::with_capacity(8192 * channels as usize);
                process_buffer.resize(8192 * channels as usize, 0.0);
                let resample_capacity_frames = resampler
                    .as_ref()
                    .and_then(|rs| rs.process_output_capacity_frames(4096).ok())
                    .unwrap_or(4096);
                let mut resample_leftover =
                    Vec::with_capacity(resample_capacity_frames * channels as usize);
                let mut resample_leftover_pos = 0usize;
                let mut resample_output =
                    vec![0.0; resample_capacity_frames * channels as usize];
                let mut convolver =
                    match ConvolverProcessor::new(dsp_ctx.convolver_control.clone()) {
                        Ok(mut processor) => {
                            if processor.set_sample_rate(requested_sample_rate).is_err() {
                                shared_state.state.store(PlayerState::Stopped);
                                continue;
                            }
                            processor
                        }
                        Err(error) => {
                            log::error!("Failed to acquire convolver consumer: {}", error);
                            shared_state.state.store(PlayerState::Stopped);
                            continue;
                        }
                    };
                let mut callback_output_f64 = vec![0.0; 8192 * channels as usize];

                log::info!("Building output stream...");
                let new_stream = device.build_output_stream(
                    &config,
                    move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                        if data.len() > callback_output_f64.len() {
                            data.fill(0.0);
                            return;
                        }
                        let output = &mut callback_output_f64[..data.len()];

                        #[cfg(debug_assertions)]
                        assert_no_alloc(|| {
                            audio_callback_lockfree(
                                output,
                                &cb_shared,
                                &mut cb_dsp_chain,
                                &mut convolver,
                                &cb_loudness_state,
                                &cb_spectrum_tx,
                                channels as usize,
                                &mut process_buffer,
                                &mut resampler,
                                &mut resample_leftover,
                                &mut resample_leftover_pos,
                                &mut resample_output,
                                true,
                            );
                            for (destination, source) in data.iter_mut().zip(output.iter()) {
                                *destination = *source as f32;
                            }
                        });

                        #[cfg(not(debug_assertions))]
                        {
                            audio_callback_lockfree(
                                output,
                                &cb_shared,
                                &mut cb_dsp_chain,
                                &mut convolver,
                                &cb_loudness_state,
                                &cb_spectrum_tx,
                                channels as usize,
                                &mut process_buffer,
                                &mut resampler,
                                &mut resample_leftover,
                                &mut resample_leftover_pos,
                                &mut resample_output,
                                true,
                            );
                            for (destination, source) in data.iter_mut().zip(output.iter()) {
                                *destination = *source as f32;
                            }
                        }
                    },
                    |err| log::error!("Stream error: {}", err),
                    None,
                );

                match new_stream {
                    Ok(s) => {
                        let _ = s.play();
                        stream = Some(s);
                        shared_state.state.store(PlayerState::Playing);

                        let detected_bits: u32 = match device.default_output_config() {
                            Ok(cfg) => match cfg.sample_format() {
                                cpal::SampleFormat::I16 => 16,
                                cpal::SampleFormat::I32 => 24,
                                cpal::SampleFormat::F32 => 24,
                                _ => noise_shaper_bits.max(16),
                            },
                            Err(_) => noise_shaper_bits.max(16),
                        };

                        shared_state.output_bits.store(detected_bits, Ordering::Relaxed);
                        log::info!(
                            "Stream started successfully at {} Hz, {}-bit output",
                            actual_sample_rate,
                            detected_bits
                        );
                    }
                    Err(e) => {
                        log::error!("Failed to build stream: {}. Trying device default config...", e);

                        if let Ok(default_config) = device.default_output_config() {
                            let fallback_config: StreamConfig = default_config.clone().into();
                            let fallback_sr = fallback_config.sample_rate.0;
                            let fallback_channels = fallback_config.channels as usize;

                            let mut fallback_resampler = if fallback_sr != requested_sample_rate {
                                match StreamingResampler::with_phase(
                                    fallback_channels,
                                    requested_sample_rate,
                                    fallback_sr,
                                    phase_response,
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

                            dsp_ctx.reclaim_retired_convolver();
                            let cb_shared = Arc::clone(&shared_state);
                            let cb_loudness_state = Arc::clone(&loudness_state);
                            let cb_spectrum_tx = spectrum_tx.clone();
                            // Build a fresh DspChain for the fallback path
                            let (_, fallback_chain) = LockfreeDspContext::new(
                                fallback_channels,
                                requested_sample_rate as f64,
                                fallback_sr as f64,
                                Arc::clone(&eq_params),
                                Arc::clone(&saturation_params),
                                Arc::clone(&crossfeed_params),
                                Arc::clone(&limiter_params),
                                Arc::clone(&volume_params),
                                Arc::clone(&noise_shaper_params),
                                Arc::clone(&dynamic_loudness_params),
                                Arc::clone(&dynamic_loudness_telemetry),
                            );
                            let mut fb_dsp_chain = fallback_chain;
                            let mut process_buffer = Vec::with_capacity(8192 * fallback_channels);
                            process_buffer.resize(8192 * fallback_channels, 0.0);
                            let fallback_capacity_frames = fallback_resampler
                                .as_ref()
                                .and_then(|rs| rs.process_output_capacity_frames(4096).ok())
                                .unwrap_or(4096);
                            let mut fallback_resample_leftover =
                                Vec::with_capacity(fallback_capacity_frames * fallback_channels);
                            let mut fallback_resample_leftover_pos = 0usize;
                            let mut fallback_resample_output =
                                vec![0.0; fallback_capacity_frames * fallback_channels];
                            let mut fallback_convolver =
                                match ConvolverProcessor::new(dsp_ctx.convolver_control.clone()) {
                                    Ok(mut processor) => {
                                        if processor
                                            .set_sample_rate(requested_sample_rate)
                                            .is_err()
                                        {
                                            shared_state.state.store(PlayerState::Stopped);
                                            continue;
                                        }
                                        processor
                                    }
                                    Err(error) => {
                                        log::error!(
                                            "Failed to acquire fallback convolver consumer: {}",
                                            error
                                        );
                                        shared_state.state.store(PlayerState::Stopped);
                                        continue;
                                    }
                                };
                            let mut fallback_callback_output_f64 =
                                vec![0.0; 8192 * fallback_channels];

                            match device.build_output_stream(
                                &fallback_config,
                                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                                    if data.len() > fallback_callback_output_f64.len() {
                                        data.fill(0.0);
                                        return;
                                    }
                                    let output =
                                        &mut fallback_callback_output_f64[..data.len()];

                                    #[cfg(debug_assertions)]
                                    assert_no_alloc(|| {
                                        audio_callback_lockfree(
                                            output,
                                            &cb_shared,
                                            &mut fb_dsp_chain,
                                            &mut fallback_convolver,
                                            &cb_loudness_state,
                                            &cb_spectrum_tx,
                                            fallback_channels,
                                            &mut process_buffer,
                                            &mut fallback_resampler,
                                            &mut fallback_resample_leftover,
                                            &mut fallback_resample_leftover_pos,
                                            &mut fallback_resample_output,
                                            true,
                                        );
                                        for (destination, source) in
                                            data.iter_mut().zip(output.iter())
                                        {
                                            *destination = *source as f32;
                                        }
                                    });

                                    #[cfg(not(debug_assertions))]
                                    {
                                        audio_callback_lockfree(
                                            output,
                                            &cb_shared,
                                            &mut fb_dsp_chain,
                                            &mut fallback_convolver,
                                            &cb_loudness_state,
                                            &cb_spectrum_tx,
                                            fallback_channels,
                                            &mut process_buffer,
                                            &mut fallback_resampler,
                                            &mut fallback_resample_leftover,
                                            &mut fallback_resample_leftover_pos,
                                            &mut fallback_resample_output,
                                            true,
                                        );
                                        for (destination, source) in
                                            data.iter_mut().zip(output.iter())
                                        {
                                            *destination = *source as f32;
                                        }
                                    }
                                },
                                |err| log::error!("Stream error: {}", err),
                                None,
                            ) {
                                Ok(s) => {
                                    let _ = s.play();
                                    stream = Some(s);
                                    shared_state.state.store(PlayerState::Playing);

                                    let detected_bits: u32 = match device.default_output_config() {
                                        Ok(cfg) => match cfg.sample_format() {
                                            cpal::SampleFormat::I16 => 16,
                                            cpal::SampleFormat::I32 => 24,
                                            cpal::SampleFormat::F32 => 24,
                                            _ => noise_shaper_bits.max(16),
                                        },
                                        Err(_) => noise_shaper_bits.max(16),
                                    };
                                    shared_state.output_bits.store(detected_bits, Ordering::Relaxed);

                                    log::info!(
                                        "Stream started with device default config, {}-bit output",
                                        detected_bits
                                    );
                                }
                                Err(e2) => {
                                    log::error!(
                                        "Failed to start stream even with device default: {}",
                                        e2
                                    );
                                    shared_state.state.store(PlayerState::Stopped);
                                }
                            }
                        } else {
                            log::error!("Cannot get device default config");
                            shared_state.state.store(PlayerState::Stopped);
                        }
                    }
                }
            }
            Ok(AudioCommand::Pause) => {
                if let Some(ref s) = stream {
                    let _ = s.pause();
                }
                shared_state.state.store(PlayerState::Paused);
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
                shared_state.state.store(PlayerState::Stopped);
            }
            Ok(AudioCommand::SetExternalIrConvolver { ir_data, channels }) => {
                if let Err(e) = dsp_ctx.set_external_ir_convolver(&ir_data, channels) {
                    log::error!("Failed to set external IR convolver: {}", e);
                }
            }
            Ok(AudioCommand::ClearExternalIrConvolver) => {
                dsp_ctx.clear_external_ir_convolver();
            }
            Ok(AudioCommand::SetFirConvolver { ir_data, channels }) => {
                if let Err(e) = dsp_ctx.set_fir_convolver(&ir_data, channels) {
                    log::error!("Failed to set FIR convolver: {}", e);
                }
            }
            Ok(AudioCommand::ClearFirConvolver) => {
                dsp_ctx.clear_fir_convolver();
            }
            Ok(AudioCommand::SetNoiseShaperCurve { curve }) => {
                *shared_state.noise_shaper_curve.write() = curve;
                log::info!("Noise shaper curve set to {:?} (lock-free path)", curve);
            }
            Ok(AudioCommand::LoadComplete { generation, result }) => {
                let current_generation = shared_state.load_generation.load(Ordering::Acquire);
                if generation != current_generation {
                    log::info!(
                        "Ignoring stale async load complete: generation={} current={} path={}",
                        generation,
                        current_generation,
                        result.file_path
                    );
                    continue;
                }

                log::info!(
                    "Async load complete: {} frames @ {} Hz",
                    result.total_frames,
                    result.sample_rate
                );
                shared_state
                    .sample_rate
                    .store(result.sample_rate as u64, Ordering::Relaxed);
                shared_state
                    .channels
                    .store(result.channels as u64, Ordering::Relaxed);
                shared_state
                    .total_frames
                    .store(result.total_frames, Ordering::Relaxed);
                shared_state.position_frames.store(0, Ordering::Relaxed);
                shared_state.state.store(PlayerState::Stopped);
                let channels = result.channels;
                let _sr = result.sample_rate as f64;
                let sr_u32 = result.sample_rate;
                let metadata = result.metadata;
                let file_path = result.file_path;

                // Lock-free buffer swap via ArcSwap — move samples into Arc
                let samples_arc = Arc::new(result.samples);
                shared_state.audio_buffer.store(Arc::clone(&samples_arc));
                *shared_state.file_path.write() = Some(file_path.clone());

                *shared_state.track_metadata.write() = metadata.clone();
                *shared_state.current_track_path.write() = Some(file_path);

                // Note: DspChain is now exclusively owned by the callback closure.
                // Sample rate / reset is handled implicitly by the processors
                // reading atomic params on each callback. No dsp_ctx.set_sample_rate()
                // or dsp_ctx.reset() needed — those were only required when the chain
                // was behind a Mutex shared between command handler and callback.
                //
                // H-channel fix: Signal the callback to rebuild DspChain if channels changed.
                // The dsp_needs_rebuild flag tells the callback to create a fresh chain
                // with the correct channel count on its next invocation.
                shared_state.dsp_needs_rebuild.store(true, Ordering::Release);

                loudness_state.set_smoothing(200.0, sr_u32);

                let _mode = loudness_state.get_mode();
                let preamp = loudness_state.preamp_gain_db();

                let calc_safe_gain = |rg_gain_db: f64, peak: Option<f64>, preamp_db: f64| -> f64 {
                    let requested_gain = rg_gain_db + preamp_db;

                    if requested_gain <= 0.0 {
                        return requested_gain;
                    }

                    if let Some(peak_val) = peak {
                        if peak_val > 0.0 {
                            const HEADROOM: f64 = 0.99;
                            let max_linear = HEADROOM / peak_val;
                            let max_gain_db = 20.0 * max_linear.log10();

                            if requested_gain > max_gain_db {
                                log::info!(
                                    "Peak protection: peak={:.4}, requested={:.2} dB, limited to {:.2} dB",
                                    peak_val,
                                    requested_gain,
                                    max_gain_db
                                );
                                return max_gain_db;
                            }
                        }
                    }

                    requested_gain
                };

                match loudness_state.get_mode() {
                    crate::config::NormalizationMode::ReplayGainTrack => {
                        if let Some(rg_gain) = metadata.rg_track_gain {
                            let peak = metadata.rg_track_peak;
                            let effective_gain = calc_safe_gain(rg_gain, peak, preamp);
                            loudness_state.set_target_gain(effective_gain);
                            log::info!(
                                "ReplayGain Track: {:.2} dB + preamp {:.2} dB -> {:.2} dB (peak: {:?})",
                                rg_gain,
                                preamp,
                                effective_gain,
                                peak
                            );
                        } else {
                            log::warn!("No ReplayGain track gain found, falling back to EBU R128 analysis");
                            let loudness = crate::processor::LoudnessMeter::new(channels, sr_u32)
                                .and_then(|mut meter| {
                                    meter.process(&samples_arc)?;
                                    Ok(meter.integrated_loudness())
                                })
                                .unwrap_or(f64::NEG_INFINITY);
                            if loudness.is_finite() {
                                let gain = target_lufs - loudness + preamp;
                                loudness_state.set_target_gain(gain);
                                log::info!(
                                    "EBU R128 fallback: {:.2} LUFS -> gain {:.2} dB (target: {:.2} LUFS)",
                                    loudness,
                                    gain,
                                    target_lufs
                                );
                            } else {
                                loudness_state.set_target_gain(preamp);
                                log::warn!(
                                    "EBU R128 analysis failed, using preamp only: {:.2} dB",
                                    preamp
                                );
                            }
                        }
                    }
                    crate::config::NormalizationMode::ReplayGainAlbum => {
                        let rg_gain = metadata.rg_album_gain.or(metadata.rg_track_gain);
                        let peak = metadata.rg_album_peak.or(metadata.rg_track_peak);
                        if let Some(gain) = rg_gain {
                            let effective_gain = calc_safe_gain(gain, peak, preamp);
                            loudness_state.set_target_gain(effective_gain);
                            log::info!(
                                "ReplayGain Album: {:.2} dB + preamp {:.2} dB -> {:.2} dB (peak: {:?})",
                                gain,
                                preamp,
                                effective_gain,
                                peak
                            );
                        } else {
                            log::warn!("No ReplayGain gain found, falling back to EBU R128 analysis");
                            let loudness = crate::processor::LoudnessMeter::new(channels, sr_u32)
                                .and_then(|mut meter| {
                                    meter.process(&samples_arc)?;
                                    Ok(meter.integrated_loudness())
                                })
                                .unwrap_or(f64::NEG_INFINITY);
                            if loudness.is_finite() {
                                let gain = target_lufs - loudness + preamp;
                                loudness_state.set_target_gain(gain);
                                log::info!(
                                    "EBU R128 fallback: {:.2} LUFS -> gain {:.2} dB (target: {:.2} LUFS)",
                                    loudness,
                                    gain,
                                    target_lufs
                                );
                            } else {
                                loudness_state.set_target_gain(preamp);
                            }
                        }
                    }
                    _ => {}
                }

                log::debug!("DSP context updated for {} Hz sample rate", sr_u32);

                // Clear is_loading AFTER file_path and all state has been updated.
                // This prevents the race condition where the frontend sees
                // is_loading=false but file_path is still the old value.
                shared_state.is_loading.store(false, Ordering::Release);
                shared_state.event_flags.fetch_or(EVENT_LOAD_COMPLETE, Ordering::Release);
            }
            Ok(AudioCommand::LoadError { generation, error }) => {
                let current_generation = shared_state.load_generation.load(Ordering::Acquire);
                if generation != current_generation {
                    log::info!(
                        "Ignoring stale async load error: generation={} current={} error={}",
                        generation,
                        current_generation,
                        error
                    );
                    continue;
                }

                log::error!("Async load failed: {}", error);
                *shared_state.load_error.write() = Some(error);
                shared_state.is_loading.store(false, Ordering::Release);
                shared_state.state.store(PlayerState::Stopped);
                shared_state.event_flags.fetch_or(EVENT_LOAD_ERROR, Ordering::Release);
            }
            Ok(AudioCommand::Shutdown) | Err(_) => break,
        }
    }
}

#[cfg(windows)]
#[allow(clippy::too_many_arguments)]
fn handle_wasapi_exclusive(
    cmd_rx: &Receiver<AudioCommand>,
    shared_state: &Arc<SharedState>,
    dsp_ctx: &Arc<LockfreeDspContext>,
    loudness_state: &Arc<AtomicLoudnessState>,
    spectrum_tx: &Sender<f64>,
) -> bool {
    log::info!("Starting TRUE WASAPI exclusive mode playback...");

    let sample_rate = shared_state.sample_rate.load(Ordering::Relaxed) as u32;
    let channels = shared_state.channels.load(Ordering::Relaxed) as usize;

    if channels == 0 {
        log::error!("Invalid channels");
        shared_state.state.store(PlayerState::Stopped);
        return true;
    }

    if let Err(error) = dsp_ctx.set_convolver_sample_rate(sample_rate) {
        log::error!("Failed to configure WASAPI convolver source rate: {}", error);
        shared_state.state.store(PlayerState::Stopped);
        return true;
    }
    dsp_ctx.reclaim_retired_convolver();

    let cb_shared = Arc::clone(shared_state);
    let cb_loudness_state = Arc::clone(loudness_state);
    let cb_spectrum_tx = spectrum_tx.clone();

    let mut process_buffer = Vec::with_capacity(8192 * channels);
    process_buffer.resize(8192 * channels, 0.0);

    // Build a DspChain owned by the WASAPI callback
    let (_, wasapi_chain) = LockfreeDspContext::new(
        channels,
        sample_rate as f64,
        sample_rate as f64,
        Arc::clone(&dsp_ctx.eq_params),
        Arc::clone(&dsp_ctx.saturation_params),
        Arc::clone(&dsp_ctx.crossfeed_params),
        Arc::clone(&dsp_ctx.limiter_params),
        Arc::clone(&dsp_ctx.volume_params),
        Arc::clone(&dsp_ctx.noise_shaper_params),
        Arc::clone(&dsp_ctx.dynamic_loudness_params),
        Arc::new(crate::processor::AtomicDynamicLoudnessTelemetry::new()),
    );
    let mut wasapi_dsp_chain = wasapi_chain;

    let mut unused_resampler = None;
    let mut unused_leftover = Vec::new();
    let mut unused_leftover_pos = 0usize;
    let mut unused_output = Vec::new();
    let mut wasapi_convolver =
        match ConvolverProcessor::new(dsp_ctx.convolver_control.clone()) {
            Ok(mut processor) => {
                if processor.set_sample_rate(sample_rate).is_err() {
                    shared_state.state.store(PlayerState::Stopped);
                    return true;
                }
                processor
            }
            Err(error) => {
                log::error!("Failed to acquire WASAPI convolver consumer: {}", error);
                shared_state.state.store(PlayerState::Stopped);
                return true;
            }
        };

    let dsp_callback = Box::new(
        move |data: &mut [f64],
              cb_channels: usize,
              operation: DspCallbackOperation|
              -> bool {
            match operation {
                DspCallbackOperation::ConfigureOutput { sample_rate_hz } => {
                    if wasapi_dsp_chain
                        .set_output_sample_rate(sample_rate_hz)
                        .is_err()
                    {
                        data.fill(0.0);
                        return true;
                    }
                    false
                }
                DspCallbackOperation::RenderSource => {
                    audio_callback_lockfree(
                        data,
                        &cb_shared,
                        &mut wasapi_dsp_chain,
                        &mut wasapi_convolver,
                        &cb_loudness_state,
                        &cb_spectrum_tx,
                        cb_channels,
                        &mut process_buffer,
                        &mut unused_resampler,
                        &mut unused_leftover,
                        &mut unused_leftover_pos,
                        &mut unused_output,
                        false,
                    );
                    cb_shared.state.load() == PlayerState::Stopped
                }
                DspCallbackOperation::FinalizeOutput => {
                    if wasapi_dsp_chain
                        .process_output(data, cb_channels)
                        .is_err()
                    {
                        data.fill(0.0);
                        return true;
                    }
                    false
                }
            }
        },
    );

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
                shared_state.state.store(PlayerState::Stopped);
                return true;
            }

            shared_state.state.store(PlayerState::Playing);

            let mut wait_count = 0;
            while wasapi_player.get_state() == WasapiState::Stopped && wait_count < 300 {
                std::thread::sleep(std::time::Duration::from_millis(10));
                wait_count += 1;
            }

            if wasapi_player.get_state() == WasapiState::Stopped {
                log::error!("WASAPI: Failed to start playback after waiting");
                shared_state.state.store(PlayerState::Stopped);
                return true;
            }

            log::info!("WASAPI: Playback started, entering monitoring loop");

            loop {
                if let Ok(cmd) = cmd_rx.try_recv() {
                    match cmd {
                        AudioCommand::Pause => {
                            let _ = wasapi_player.pause();
                            shared_state.state.store(PlayerState::Paused);
                        }
                        AudioCommand::Play => {
                            let _ = wasapi_player.play();
                            shared_state.state.store(PlayerState::Playing);
                        }
                        AudioCommand::Seek(time) => {
                            let sr = shared_state.sample_rate.load(Ordering::Relaxed) as f64;
                            let frame = (time * sr) as u64;
                            let total = shared_state.total_frames.load(Ordering::Relaxed);
                            shared_state.position_frames.store(frame.min(total), Ordering::Relaxed);
                            let _ = wasapi_player.seek(frame);
                        }
                        AudioCommand::SetExternalIrConvolver { ir_data, channels } => {
                            if let Err(e) = dsp_ctx.set_external_ir_convolver(&ir_data, channels) {
                                log::error!("Failed to set external IR convolver in WASAPI path: {}", e);
                            }
                        }
                        AudioCommand::ClearExternalIrConvolver => {
                            dsp_ctx.clear_external_ir_convolver();
                        }
                        AudioCommand::SetFirConvolver { ir_data, channels } => {
                            if let Err(e) = dsp_ctx.set_fir_convolver(&ir_data, channels) {
                                log::error!("Failed to set FIR convolver in WASAPI path: {}", e);
                            }
                        }
                        AudioCommand::ClearFirConvolver => {
                            dsp_ctx.clear_fir_convolver();
                        }
                        AudioCommand::SetNoiseShaperCurve { curve } => {
                            *shared_state.noise_shaper_curve.write() = curve;
                            log::info!("Noise shaper curve set to {:?} (WASAPI path)", curve);
                        }
                        AudioCommand::Stop => {
                            let _ = wasapi_player.stop();
                            shared_state.position_frames.store(0, Ordering::Relaxed);
                            shared_state.state.store(PlayerState::Stopped);
                            break;
                        }
                        AudioCommand::Shutdown => {
                            drop(wasapi_player);
                            return false;
                        }
                        _ => {}
                    }
                }

                if shared_state.state.load() == PlayerState::Stopped {
                    log::info!("WASAPI playback finished");
                    let _ = wasapi_player.stop();
                    break;
                }

                std::thread::sleep(std::time::Duration::from_millis(50));
            }

            true
        }
        Err(e) => {
            log::error!("Failed to create WASAPI player: {}. Falling back to cpal.", e);
            false
        }
    }
}
