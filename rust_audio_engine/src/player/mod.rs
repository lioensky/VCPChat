//! VCP Hi-Fi Audio Engine - Audio Player Module
//!
//! Native audio playback using cpal with lock-free DSP processing.
//! Uses f64 full-stack path for maximum transparency.

mod state;
mod gapless;
mod callback;
mod audio_thread;
mod spectrum;
mod stream_decode;
mod track_buffer;

// Re-exports
pub use state::{AudioCommand, PlayerState, SharedState, AudioDeviceInfo,
    EVENT_LOAD_COMPLETE, EVENT_LOAD_ERROR, EVENT_TRACK_CHANGED,
    EVENT_PLAYBACK_ENDED, EVENT_NEEDS_PRELOAD_RESET, EVENT_COMMAND_APPLIED,
    EVENT_DECODE_COMPLETE, output_fallback_names, OUTPUT_FELL_BACK_FROM_EXCLUSIVE,
    OUTPUT_FELL_BACK_TO_DEFAULT_DEVICE, resolve_output_device};
pub use track_buffer::{TrackBuffer, CHUNK_FRAMES};
pub use gapless::GaplessManager;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::thread::{self, JoinHandle};
use std::path::PathBuf;

use parking_lot::Mutex;
use crossbeam::channel::{Sender, unbounded};
use cpal::traits::{HostTrait, DeviceTrait};

use crate::config::{AppConfig, ResampleQuality};
use crate::processor::{
    SpectrumAnalyzer,
    LoudnessNormalizer, LoudnessInfo,
    // Lock-free parameters
    AtomicEqParams, AtomicSaturationParams, AtomicCrossfeedParams,
    AtomicPeakLimiterParams, AtomicVolumeParams, AtomicNoiseShaperParams,
    AtomicDynamicLoudnessParams, AtomicDynamicLoudnessTelemetry,
    NoiseShaperCurve, SaturationTypeValue,
    FirPhaseMode, STANDARD_BANDS,
};

// Import internal modules
use state::{save_cache_with_header, load_cache_with_header};
use audio_thread::audio_thread_main;
use spectrum::{spectrum_thread_main, SpectrumTap};

/// The main audio player - thread-safe wrapper
pub struct AudioPlayer {
    shared_state: Arc<SharedState>,
    cmd_tx: Sender<AudioCommand>,
    audio_thread: Option<JoinHandle<()>>,

    // Loudness normalizer for main thread operations
    loudness_normalizer: Arc<Mutex<LoudnessNormalizer>>,
    // ═══════════════════════════════════════════════════════════════
    // Lock-free Parameter Structures
    // These allow main thread to set parameters without blocking audio thread
    // ═══════════════════════════════════════════════════════════════
    
    /// Lock-free EQ parameters - use this for real-time EQ updates
    pub lockfree_eq_params: Arc<AtomicEqParams>,
    /// Lock-free saturation parameters
    pub lockfree_saturation_params: Arc<AtomicSaturationParams>,
    /// Lock-free crossfeed parameters
    pub lockfree_crossfeed_params: Arc<AtomicCrossfeedParams>,
    /// Lock-free peak limiter parameters
    pub lockfree_limiter_params: Arc<AtomicPeakLimiterParams>,
    /// Lock-free volume parameters (includes mute)
    pub lockfree_volume_params: Arc<AtomicVolumeParams>,
    /// Lock-free noise shaper parameters
    pub lockfree_noise_shaper_params: Arc<AtomicNoiseShaperParams>,
    /// Lock-free dynamic loudness parameters
    pub lockfree_dynamic_loudness_params: Arc<AtomicDynamicLoudnessParams>,
    /// Real-time dynamic loudness telemetry from audio thread
    dynamic_loudness_telemetry: Arc<AtomicDynamicLoudnessTelemetry>,

    // Config
    pub exclusive_mode: bool,
    pub target_sample_rate: Option<u32>,
    pub dither_enabled: bool,
    pub replaygain_enabled: bool,
    pub loudness_enabled: bool,

    // FIR EQ emulation state (maps FIR API onto lock-free EQ runtime)
    fir_eq_enabled: bool,
    fir_taps: usize,
    fir_bands: [(f64, f64); 10],
    fir_phase_mode: FirPhaseMode,
    ir_loaded: bool,
    /// Measured loudness of untagged tracks, so the next play starts at the right level.
    loudness_cache: Option<Arc<crate::processor::LoudnessDatabase>>,
    ir_path: Option<String>,

    config: AppConfig,
    device_id: Option<usize>,
}

impl AudioPlayer {
    pub fn new(config: AppConfig) -> Self {
        log::info!("Initializing AudioPlayer (lock-free mode)...");
        let shared_state = Arc::new(SharedState::new());
        let (cmd_tx, cmd_rx) = unbounded::<AudioCommand>();

        let thread_state = Arc::clone(&shared_state);

        let spectrum_analyzer = Arc::new(Mutex::new(
            SpectrumAnalyzer::new(2048, 64)
                .expect("fixed spectrum analyzer geometry is valid"),
        ));

        let loudness_normalizer = Arc::new(Mutex::new(
            LoudnessNormalizer::new(2, 44100, config.loudness.clone())
                .expect("validated application loudness configuration is valid"),
        ));
        let loudness_state = loudness_normalizer.lock().atomic_state();

        let (spectrum_tap, spectrum_rx) = SpectrumTap::new();

        let spec_state = Arc::clone(&shared_state);
        let spec_analyzer = Arc::clone(&spectrum_analyzer);
        thread::spawn(move || {
            spectrum_thread_main(spectrum_rx, spec_state, spec_analyzer);
        });

        let loudness_enabled = config.loudness.enabled;

        // ═══════════════════════════════════════════════════════════════
        // Initialize lock-free parameter structures
        // ═══════════════════════════════════════════════════════════════
        let lockfree_eq_params = Arc::new(AtomicEqParams::new());
        let lockfree_saturation_params = Arc::new(AtomicSaturationParams::new());
        let lockfree_crossfeed_params = Arc::new(AtomicCrossfeedParams::new());
        let lockfree_limiter_params = Arc::new(AtomicPeakLimiterParams::new());
        let lockfree_volume_params = Arc::new(AtomicVolumeParams::new());
        let lockfree_noise_shaper_params = Arc::new(AtomicNoiseShaperParams::new());
        let lockfree_dynamic_loudness_params = Arc::new(AtomicDynamicLoudnessParams::new());
        let dynamic_loudness_telemetry = Arc::new(AtomicDynamicLoudnessTelemetry::new());

        // Sync initial saturation config to lockfree params
        {
            lockfree_saturation_params.set_drive(config.saturation.drive);
            lockfree_saturation_params.set_threshold(config.saturation.threshold);
            lockfree_saturation_params.set_mix(config.saturation.mix);
            lockfree_saturation_params.set_sat_type(SaturationTypeValue::from(config.saturation.sat_type));
            lockfree_saturation_params.set_input_gain(config.saturation.input_gain_db);
            lockfree_saturation_params.set_output_gain(config.saturation.output_gain_db);
            lockfree_saturation_params.set_enabled(config.saturation.enabled);
        }

        // Sync initial dynamic loudness config to lockfree params
        {
            lockfree_dynamic_loudness_params.set_enabled(config.dynamic_loudness.enabled);
            lockfree_dynamic_loudness_params.set_strength(config.dynamic_loudness.strength);
            lockfree_dynamic_loudness_params.set_ref_volume_db(config.dynamic_loudness.ref_volume_db);
            lockfree_dynamic_loudness_params.set_transition_db(config.dynamic_loudness.transition_db);
            lockfree_dynamic_loudness_params.set_pre_gain_db(config.dynamic_loudness.pre_gain_db);
        }

        {
            lockfree_noise_shaper_params.set_enabled(true);
            let bits = config.output_bits.unwrap_or(24).max(16);
            lockfree_noise_shaper_params.set_bits(bits);
            shared_state.output_bits.store(bits, Ordering::Relaxed);
            lockfree_noise_shaper_params.set_curve(NoiseShaperCurve::Lipshitz5);
        }

        // ═══════════════════════════════════════════════════════════════
        // Spawn audio thread (lock-free only)
        // ═══════════════════════════════════════════════════════════════
        let lf_eq = Arc::clone(&lockfree_eq_params);
        let lf_sat = Arc::clone(&lockfree_saturation_params);
        let lf_cross = Arc::clone(&lockfree_crossfeed_params);
        let lf_limiter = Arc::clone(&lockfree_limiter_params);
        let lf_vol = Arc::clone(&lockfree_volume_params);
        let lf_ns = Arc::clone(&lockfree_noise_shaper_params);
        let lf_dl = Arc::clone(&lockfree_dynamic_loudness_params);
        let lf_dl_telemetry = Arc::clone(&dynamic_loudness_telemetry);
        let lf_loudness_state = Arc::clone(&loudness_state);
        let phase_response = config.phase_response;

        let audio_thread = thread::spawn(move || {
            audio_thread_main(
                cmd_rx,
                thread_state,
                lf_eq,
                lf_sat,
                lf_cross,
                lf_limiter,
                lf_vol,
                lf_ns,
                lf_dl,
                lf_dl_telemetry,
                lf_loudness_state,
                config.output_bits.unwrap_or(24),  // M-1 fix: read from config instead of hardcoded 24
                spectrum_tap,
                phase_response,
            );
        });

        Self {
            shared_state,
            cmd_tx,
            audio_thread: Some(audio_thread),
            loudness_normalizer,
            // Lock-free parameters
            lockfree_eq_params,
            lockfree_saturation_params,
            lockfree_crossfeed_params,
            lockfree_limiter_params,
            lockfree_volume_params,
            lockfree_noise_shaper_params,
            lockfree_dynamic_loudness_params,
            dynamic_loudness_telemetry,
            exclusive_mode: false,
            target_sample_rate: config.target_samplerate,
            dither_enabled: true,
            replaygain_enabled: true,
            loudness_enabled,
            fir_eq_enabled: false,
            fir_taps: 1023,
            fir_bands: STANDARD_BANDS,
            fir_phase_mode: FirPhaseMode::Linear,
            ir_loaded: false,
            loudness_cache: None,
            ir_path: None,
            config,
            device_id: None,
        }
    }

    pub fn list_devices(&self) -> Vec<AudioDeviceInfo> {
        log::info!("Listing audio devices...");
        let host = cpal::default_host();
        let mut all_devices = Vec::new();
        let default_device = host.default_output_device();
        let default_name = default_device.as_ref().and_then(|d| d.name().ok());

        if let Ok(devices) = host.output_devices() {
            for (idx, device) in devices.enumerate() {
                if let Ok(name) = device.name() {
                    let config = device.default_output_config().ok();
                    let is_default = Some(&name) == default_name.as_ref();
                    all_devices.push(AudioDeviceInfo {
                        id: idx,
                        name,
                        is_default,
                        sample_rate: config.map(|c| c.sample_rate().0),
                    });
                }
            }
        }

        if all_devices.is_empty() {
            log::warn!("No audio output devices found!");
        } else {
            log::info!("Found {} audio devices", all_devices.len());
        }

        all_devices
    }

    pub fn select_device(&mut self, device_id: Option<usize>) -> Result<(), String> {
        self.device_id = device_id;
        let id_value = device_id.map(|i| i as i64).unwrap_or(-1);
        self.shared_state.device_id.store(id_value, Ordering::Relaxed);
        log::info!("Device selected: {:?}", device_id);
        Ok(())
    }

    /// Choose the output device by id (its position in `list_devices`) and
    /// remember its name, so the same device is found again after the list
    /// shifts. Returns the name that was recorded.
    pub fn select_device_by_list(&mut self, device_id: Option<usize>, names: &[String]) -> Option<String> {
        let name = device_id.and_then(|id| names.get(id).cloned());
        *self.shared_state.device_name.write() = name.clone();
        let _ = self.select_device(device_id);
        name
    }

    /// Put back a saved output choice: find the saved device by name in the
    /// current list (falls back to the saved position for settings written
    /// before names were kept).
    pub fn restore_device(&mut self, saved_name: Option<&str>, saved_id: Option<usize>, names: &[String]) {
        let (index, missing) = resolve_output_device(names, saved_name, saved_id);
        if missing {
            log::warn!("Saved output device {:?} / {:?} not present, using the default", saved_name, saved_id);
        }
        // Keep the name even when the device is away, so it is picked again once plugged back in.
        *self.shared_state.device_name.write() = saved_name.map(str::to_string)
            .or_else(|| index.and_then(|i| names.get(i).cloned()));
        let _ = self.select_device(index);
    }

    /// Names of the output devices, in list order (what `list_devices` ids index).
    pub fn output_device_names() -> Vec<String> {
        let host = cpal::default_host();
        host.output_devices()
            .map(|devices| devices.map(|d| d.name().unwrap_or_default()).collect())
            .unwrap_or_default()
    }

    /// Remember EBU R128 measurements across plays (and restarts).
    pub fn set_loudness_cache(&mut self, cache: Option<Arc<crate::processor::LoudnessDatabase>>) {
        self.loudness_cache = cache;
    }

    pub fn load(&mut self, path: &str) -> Result<(), String> {
        self.load_with_credentials(path, None)
    }

    /// Load audio file asynchronously in a background thread.
    /// Returns immediately with Ok(()) - check `is_loading()` for completion status.
    /// On completion, a `LoadComplete` command is sent to the audio thread.
    pub fn load_with_credentials(
        &mut self,
        path: &str,
        credentials: Option<&crate::decoder::HttpCredentials>,
    ) -> Result<(), String> {
        log::info!("Loading track async (credentials={}): {}", credentials.is_some(), path);
        self.stop();
        GaplessManager::cancel_preload(&self.shared_state);

        // Set loading state and publish a new load generation.
        // Slow decode/resample threads from older track changes must not be
        // allowed to overwrite the current track after a newer request starts.
        let load_generation = self.shared_state.load_generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.shared_state.is_loading.store(true, Ordering::Release);
        self.shared_state.load_progress.store(0, Ordering::Relaxed);
        *self.shared_state.load_error.write() = None;

        let path_owned = path.to_string();
        let credentials_owned = credentials.cloned();
        let shared_state = Arc::clone(&self.shared_state);
        let cmd_tx = self.cmd_tx.clone();
        let config = self.config.clone();
        let device_id = self.device_id;
        let loudness_state = self.loudness_normalizer.lock().atomic_state();
        let loudness_cache = self.loudness_cache.clone();

        // Decode on a background thread. The track is handed to the audio
        // thread as soon as about one second is decoded; decoding continues
        // into the same buffer while it plays.
        thread::Builder::new()
            .name("vcp-decode".into())
            .spawn(move || {
                Self::stream_load(
                    &path_owned,
                    credentials_owned.as_ref(),
                    &config,
                    device_id,
                    &shared_state,
                    &cmd_tx,
                    &loudness_state,
                    load_generation,
                    loudness_cache.as_deref(),
                );
            })
            .map_err(|e| format!("Failed to start decode thread: {e}"))?;

        Ok(())
    }

    fn output_sample_rate_for(config: &AppConfig, device_id: Option<usize>, original_sr: u32) -> u32 {
        config.target_samplerate.unwrap_or_else(|| {
            let host = cpal::default_host();
            let device = match device_id {
                Some(id) => host.output_devices().ok().and_then(|mut d| d.nth(id)),
                None => host.default_output_device(),
            };
            device
                .and_then(|d| d.default_output_config().ok())
                .map(|c| c.sample_rate().0)
                .unwrap_or(original_sr)
        })
    }

    fn resample_cache_path(
        config: &AppConfig,
        path: &str,
        target_sr: u32,
        estimated_input_frames: usize,
    ) -> Option<PathBuf> {
        if !config.use_cache {
            return None;
        }
        let cache_dir = config.cache_dir.clone().unwrap_or_else(|| PathBuf::from("resample_cache"));
        use sha2::{Sha256, Digest};
        let mut hasher = Sha256::new();
        hasher.update(path.as_bytes());
        hasher.update(target_sr.to_le_bytes());
        let q_byte = match config.resample_quality {
            ResampleQuality::Low => 0,
            ResampleQuality::Standard => 1,
            ResampleQuality::High => 2,
            ResampleQuality::UltraHigh => 3,
        };
        hasher.update(&[q_byte]);
        hasher.update(estimated_input_frames.to_le_bytes());
        hasher.update(&[config.phase_response as u8]);

        if !path.starts_with("http://") && !path.starts_with("https://") {
            if let Ok(metadata) = std::fs::metadata(path) {
                hasher.update(metadata.len().to_le_bytes());
                if let Ok(modified) = metadata.modified() {
                    if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                        hasher.update(duration.as_secs().to_le_bytes());
                        hasher.update(duration.subsec_nanos().to_le_bytes());
                    }
                }
            }
        }
        let hash = hex::encode(hasher.finalize());
        Some(cache_dir.join(format!("{}.bin", hash)))
    }

    /// Body of the decode thread for one load request.
    #[allow(clippy::too_many_arguments)]
    fn stream_load(
        path: &str,
        credentials: Option<&crate::decoder::HttpCredentials>,
        config: &AppConfig,
        device_id: Option<usize>,
        shared_state: &Arc<SharedState>,
        cmd_tx: &Sender<AudioCommand>,
        loudness_state: &Arc<crate::processor::AtomicLoudnessState>,
        generation: u64,
        loudness_cache: Option<&crate::processor::LoudnessDatabase>,
    ) {
        use crate::decoder::StreamingDecoder;
        use crate::processor::{LoudnessMeter, StreamingResampler};
        use stream_decode::{Pump, PumpOutcome};

        let is_current = || shared_state.load_generation.load(Ordering::Acquire) == generation;
        let send_error = |error: String| {
            log::error!("Async load failed: {}", error);
            let _ = cmd_tx.send(AudioCommand::LoadError { generation, error });
        };

        let mut decoder = match StreamingDecoder::open_with_credentials(path, credentials) {
            Ok(decoder) => decoder,
            Err(e) => {
                log::error!("Failed to open decoder for {}: {}", path, e);
                send_error(e.to_string());
                return;
            }
        };
        if !is_current() {
            return;
        }

        let info = decoder.info.clone();
        let original_sr = info.sample_rate;
        let channels = info.channels;
        let target_sr = Self::output_sample_rate_for(config, device_id, original_sr);
        let need_resample = target_sr != original_sr;
        let estimated_input_frames = info.total_frames.unwrap_or(0) as usize;

        // If preemptive_resample is false, skip pre-resampling and keep original sample rate
        let (final_target_sr, final_need_resample) = if need_resample && !config.preemptive_resample {
            log::info!("preemptive_resample=false: keeping original {} Hz (will resample at playback)", original_sr);
            (original_sr, false)
        } else {
            (target_sr, need_resample)
        };

        // Unless the mode takes this file's gain from a ReplayGain tag, its gain comes
        // from its EBU R128 loudness: measure while streaming (track mode included,
        // which used to leave a picked song at the previous song's gain).
        let needs_r128 = loudness_state.enabled()
            && !crate::processor::LoudnessNormalizer::has_tag_gain(loudness_state.get_mode(), &info.metadata);
        // Measured on an earlier play: apply it from the first second instead of
        // starting at preamp-only and jumping once the whole track is decoded.
        let cached_lufs = if needs_r128 { cached_loudness(loudness_cache, path) } else { None };
        let needs_r128 = needs_r128 && cached_lufs.is_none();

        let make_result = |buffer: Arc<TrackBuffer>, total_frames: u64| state::LoadResult {
            buffer,
            sample_rate: final_target_sr,
            channels,
            total_frames,
            file_path: path.to_string(),
            loudness_info: None,
            metadata: info.metadata.clone(),
        };

        let cache_path = if final_need_resample {
            Self::resample_cache_path(config, path, final_target_sr, estimated_input_frames)
        } else {
            None
        };

        // Cache hit: the file is already at the output rate.
        if let Some(ref cp) = cache_path {
            if cp.exists() {
                if let Some(buffer) = load_cache_with_header(cp, final_target_sr, channels as u32) {
                    let total_frames = buffer.ready_frames();
                    log::info!("Loaded from cache: {} frames", total_frames);
                    if !is_current() {
                        return;
                    }
                    shared_state.load_progress.store(100, Ordering::Relaxed);
                    let lufs = if needs_r128 {
                        LoudnessMeter::new(channels, final_target_sr).ok().map(|mut meter| {
                            buffer.for_each_chunk(|chunk| {
                                let _ = meter.process(chunk);
                            });
                            let lufs = meter.integrated_loudness();
                            store_loudness(loudness_cache, path, lufs);
                            lufs
                        })
                    } else {
                        cached_lufs
                    };
                    let _ = cmd_tx.send(AudioCommand::LoadComplete {
                        generation,
                        result: make_result(buffer, total_frames),
                    });
                    if let Some(integrated_lufs) = lufs {
                        let _ = cmd_tx.send(AudioCommand::LoudnessMeasured { generation, integrated_lufs });
                    }
                    shared_state.raise_events(EVENT_DECODE_COMPLETE);
                    return;
                }
                log::warn!("Cache validation failed, will re-decode");
            }
        }

        let resampler = if final_need_resample {
            log::info!(
                "Streaming {} resampling {} -> {} Hz",
                crate::processor::RESAMPLER_BACKEND_NAME,
                original_sr,
                final_target_sr
            );
            match StreamingResampler::with_phase(channels, original_sr, final_target_sr, config.phase_response) {
                Ok(rs) => Some(rs),
                Err(e) => {
                    send_error(format!("Failed to create resampler: {} -> {}: {}", original_sr, final_target_sr, e));
                    return;
                }
            }
        } else {
            None
        };

        let estimated_output_frames = if estimated_input_frames == 0 {
            None
        } else if final_need_resample {
            Some((estimated_input_frames as f64 * final_target_sr as f64 / original_sr as f64).ceil() as u64)
        } else {
            Some(estimated_input_frames as u64)
        };

        let (buffer, mut writer) = TrackBuffer::new(channels, estimated_output_frames);
        let mut pump = Pump {
            decoder: &mut decoder,
            resampler,
            source_channels: channels,
            output_channels: channels,
            meter: if needs_r128 { LoudnessMeter::new(channels, final_target_sr).ok() } else { None },
        };

        // Start playback once this much is decoded (about one second).
        let preroll_frames = (final_target_sr as u64).max(1);
        let total_estimate = estimated_output_frames.unwrap_or(0);
        let mut announced = false;
        let started = std::time::Instant::now();

        let mut decode_failed = false;
        let outcome = pump.run(
            &mut writer,
            || !is_current(),
            |writer, decoded_input_frames| {
                if estimated_input_frames > 0 {
                    let progress = ((decoded_input_frames as f64 / estimated_input_frames as f64) * 100.0).min(99.0) as u64;
                    shared_state.load_progress.store(progress, Ordering::Relaxed);
                }
                if !announced && writer.buffer().ready_frames() >= preroll_frames {
                    announced = true;
                    log::info!(
                        "Streaming start after {:?}: {} frames ready",
                        started.elapsed(),
                        writer.buffer().ready_frames()
                    );
                    let _ = cmd_tx.send(AudioCommand::LoadComplete {
                        generation,
                        result: make_result(Arc::clone(writer.buffer()), total_estimate),
                    });
                    if let Some(integrated_lufs) = cached_lufs {
                        let _ = cmd_tx.send(AudioCommand::LoudnessMeasured { generation, integrated_lufs });
                    }
                }
            },
        );

        match outcome {
            Ok(PumpOutcome::Cancelled) => {
                log::info!("Decode of {} abandoned: a newer load started", path);
                return;
            }
            Err(e) if !announced => {
                send_error(e);
                return;
            }
            Err(e) => {
                // Already playing: keep what was decoded and end the track there.
                log::error!("Decode error after playback started ({}): {}", path, e);
                decode_failed = true;
            }
            Ok(PumpOutcome::Finished) => {}
        }

        let integrated_lufs = pump.integrated_loudness();
        if let Some(lufs) = integrated_lufs.filter(|_| !decode_failed) {
            store_loudness(loudness_cache, path, lufs);
        }
        let total_frames = writer.finish();
        shared_state.load_progress.store(100, Ordering::Relaxed);
        log::info!(
            "Streaming decode complete in {:?}: {} frames ({}->{} Hz)",
            started.elapsed(),
            total_frames,
            original_sr,
            final_target_sr
        );

        if !announced && is_current() {
            if total_frames == 0 {
                send_error("Decoded track is empty".to_string());
                return;
            }
            let _ = cmd_tx.send(AudioCommand::LoadComplete {
                generation,
                result: make_result(Arc::clone(&buffer), total_frames),
            });
        }
        if is_current() {
            if let Some(integrated_lufs) = integrated_lufs.or(if announced { None } else { cached_lufs }) {
                let _ = cmd_tx.send(AudioCommand::LoudnessMeasured { generation, integrated_lufs });
            }
            shared_state.raise_events(EVENT_DECODE_COMPLETE);
        }

        // A track cut short by a read error is not cached: the cache would replay the cut
        // version every time, even once the file or the network is fine again. Its partial
        // loudness is not remembered either.
        if let Some(ref cp) = cache_path.as_ref().filter(|_| !decode_failed) {
            if let Err(e) = save_cache_with_header(cp, &buffer, final_target_sr, channels as u32) {
                log::warn!("Failed to save cache: {}", e);
            }
        }
    }

    /// Check if a file is currently being loaded
    pub fn is_loading(&self) -> bool {
        self.shared_state.is_loading.load(Ordering::Acquire)
    }

    /// Get loading progress (0-100)
    pub fn load_progress(&self) -> u64 {
        self.shared_state.load_progress.load(Ordering::Relaxed)
    }

    /// Get load error if any
    pub fn load_error(&self) -> Option<String> {
        self.shared_state.load_error.read().clone()
    }

    pub fn play(&mut self) -> Result<(), String> {
        let _ = self.cmd_tx.send(AudioCommand::Play);
        Ok(())
    }

    pub fn pause(&mut self) -> Result<(), String> {
        let _ = self.cmd_tx.send(AudioCommand::Pause);
        Ok(())
    }

    pub fn stop(&mut self) {
        let _ = self.cmd_tx.send(AudioCommand::Stop);
    }

    pub fn seek(&mut self, time_secs: f64) -> Result<(), String> {
        // `(NaN * rate) as u64` is 0: a bad position used to restart the song.
        if !time_secs.is_finite() || time_secs < 0.0 {
            return Err(format!("Invalid seek position: {time_secs}"));
        }
        self.cmd_tx.send(AudioCommand::Seek(time_secs))
            .map_err(|e| format!("Failed to send seek command: {}", e))
    }

    pub fn set_volume(&mut self, vol: f64) {
        let clamped_vol = vol.clamp(0.0, 1.0);
        self.shared_state.volume.store((clamped_vol * 1_000_000.0) as u64, Ordering::Relaxed);
        
        // Update lock-free volume params
        self.lockfree_volume_params.set_volume(clamped_vol);
        self.lockfree_dynamic_loudness_params.set_volume(clamped_vol);
    }

    pub fn get_volume(&self) -> f64 {
        self.shared_state.volume.load(Ordering::Relaxed) as f64 / 1_000_000.0
    }

    pub fn get_state(&self) -> PlayerState {
        self.shared_state.state.load()
    }

    /// Queue a sequence marker behind the commands sent so far. The audio
    /// thread publishes it as `applied_seq` once they have all run, so a
    /// client that sent command N can ignore any state with `applied_seq < N`.
    pub fn mark_applied(&self) -> u64 {
        let seq = self.shared_state.next_cmd_seq();
        let _ = self.cmd_tx.send(AudioCommand::Applied(seq));
        seq
    }

    pub fn shared_state(&self) -> Arc<SharedState> {
        Arc::clone(&self.shared_state)
    }

    pub fn loudness_normalizer(&self) -> Arc<Mutex<LoudnessNormalizer>> {
        Arc::clone(&self.loudness_normalizer)
    }

    pub fn set_loudness_enabled(&mut self, enabled: bool) {
        log::info!("set_loudness_enabled called with enabled={}", enabled);
        self.loudness_enabled = enabled;
        self.config.loudness.enabled = enabled;
        self.loudness_normalizer.lock().set_enabled(enabled);
    }

    pub fn set_target_lufs(&mut self, target_lufs: f64) {
        match self.loudness_normalizer.lock().set_target_lufs(target_lufs) {
            Ok(()) => self.config.loudness.target_lufs = target_lufs,
            Err(error) => log::warn!("Rejected target LUFS update: {}", error),
        }
    }

    pub fn set_album_gain(&self, gain_db: f64) {
        if let Err(error) = self.loudness_normalizer.lock().set_album_gain(gain_db) {
            log::warn!("Rejected album gain update: {}", error);
        }
    }

    pub fn set_preamp_gain(&self, gain_db: f64) {
        if let Err(error) = self.loudness_normalizer.lock().set_preamp_gain(gain_db) {
            log::warn!("Rejected preamp gain update: {}", error);
        }
    }

    pub fn set_normalization_mode(&mut self, mode: crate::config::NormalizationMode) {
        self.loudness_normalizer.lock().set_mode(mode);
        self.config.loudness.mode = mode;
    }

    pub fn get_loudness_info(&self) -> LoudnessInfo {
        self.loudness_normalizer.lock().get_loudness_info()
    }

    /// Get saturation settings
    pub fn get_saturation_info(&self) -> crate::processor::SaturationSettings {
        let snapshot = self.lockfree_saturation_params.read();
        crate::processor::SaturationSettings {
            sat_type: snapshot.sat_type.into(),
            quality: snapshot.quality.into(),
            drive: snapshot.drive,
            threshold: snapshot.threshold,
            mix: snapshot.mix,
            input_gain_db: snapshot.input_gain_db,
            output_gain_db: snapshot.output_gain_db,
            enabled: snapshot.enabled,
            highpass_mode: snapshot.highpass_mode,
            highpass_cutoff: snapshot.highpass_cutoff,
        }
    }

    /// Set saturation enabled
    pub fn set_saturation_enabled(&self, enabled: bool) {
        self.lockfree_saturation_params.set_enabled(enabled);
        log::info!("Saturation {}", if enabled { "enabled" } else { "disabled" });
    }

    /// Set saturation drive (0.0 - 2.0)
    pub fn set_saturation_drive(&self, drive: f64) {
        self.lockfree_saturation_params.set_drive(drive);
        log::info!("Saturation drive set to: {}", drive);
    }

    /// Set saturation mix (0.0 - 1.0)
    pub fn set_saturation_mix(&self, mix: f64) {
        self.lockfree_saturation_params.set_mix(mix);
        log::info!("Saturation mix set to: {}", mix);
    }

    /// Get crossfeed settings
    pub fn get_crossfeed_info(&self) -> crate::processor::CrossfeedSettings {
        let snapshot = self.lockfree_crossfeed_params.read();
        crate::processor::CrossfeedSettings {
            enabled: snapshot.enabled,
            mix: snapshot.mix,
            cutoff_hz: snapshot.cutoff_hz,
        }
    }

    /// Set crossfeed enabled
    pub fn set_crossfeed_enabled(&self, enabled: bool) {
        self.lockfree_crossfeed_params.set_enabled(enabled);
        log::info!("Crossfeed {}", if enabled { "enabled" } else { "disabled" });
    }

    /// Set crossfeed mix (0.0 - 1.0)
    pub fn set_crossfeed_mix(&self, mix: f64) {
        self.lockfree_crossfeed_params.set_mix(mix);
        log::info!("Crossfeed mix set to: {}", mix);
    }

    // ============ Dynamic Loudness Methods ============

    /// Get Dynamic Loudness enabled state
    pub fn is_dynamic_loudness_enabled(&self) -> bool {
        self.lockfree_dynamic_loudness_params.is_enabled()
    }

    /// Set Dynamic Loudness enabled
    pub fn set_dynamic_loudness_enabled(&self, enabled: bool) {
        self.lockfree_dynamic_loudness_params.set_enabled(enabled);
        log::info!("Dynamic Loudness {}", if enabled { "enabled" } else { "disabled" });
    }

    /// Get Dynamic Loudness strength (0.0 - 1.0)
    pub fn get_dynamic_loudness_strength(&self) -> f64 {
        self.lockfree_dynamic_loudness_params.strength()
    }

    /// Set Dynamic Loudness strength (0.0 - 1.0)
    pub fn set_dynamic_loudness_strength(&self, strength: f64) {
        self.lockfree_dynamic_loudness_params.set_strength(strength);
        log::info!("Dynamic Loudness strength: {:.0}%", strength * 100.0);
    }

    /// Get current loudness factor (for display)
    pub fn get_dynamic_loudness_factor(&self) -> f64 {
        self.dynamic_loudness_telemetry.factor()
    }

    /// Get current band gains (for display/metering)
    pub fn get_dynamic_loudness_gains(&self) -> [f64; 7] {
        self.dynamic_loudness_telemetry.band_gains()
    }

    // ============ Backward Compatibility Methods ============
    // These methods provide compatibility with legacy API

    /// Get a snapshot noise shaper instance for backward compatibility.
    ///
    /// Note: This instance is NOT wired into the real-time lock-free DSP chain.
    pub fn noise_shaper(&self) -> Arc<Mutex<crate::processor::NoiseShaper>> {
        let channels = self.shared_state.channels.load(Ordering::Relaxed).max(1) as usize;
        let sample_rate = self.shared_state.sample_rate.load(Ordering::Relaxed).max(1) as u32;
        let bits = self.get_output_bits();

        let mut shaper = crate::processor::NoiseShaper::new(channels, sample_rate, bits)
            .expect("player state always provides valid noise-shaper geometry");
        shaper.set_enabled(self.dither_enabled);
        Arc::new(Mutex::new(shaper))
    }

    /// Get noise shaper curve name.
    pub fn get_noise_shaper_curve(&self) -> String {
        format!("{:?}", *self.shared_state.noise_shaper_curve.read())
    }

    /// Set noise shaper curve.
    pub fn set_noise_shaper_curve(&self, curve: NoiseShaperCurve) -> Result<(), String> {
        self.lockfree_noise_shaper_params.set_curve(curve);
        *self.shared_state.noise_shaper_curve.write() = curve;
        self.cmd_tx
            .send(AudioCommand::SetNoiseShaperCurve { curve })
            .map_err(|e| format!("Failed to send SetNoiseShaperCurve command: {}", e))
    }

    /// Get an EQ snapshot instance for backward compatibility.
    ///
    /// Note: This instance is NOT wired into the real-time lock-free DSP chain.
    pub fn eq(&self) -> Arc<Mutex<crate::processor::Equalizer>> {
        let channels = self.shared_state.channels.load(Ordering::Relaxed).max(1) as usize;
        let sample_rate = self.shared_state.sample_rate.load(Ordering::Relaxed).max(1) as f64;
        let snapshot = self.lockfree_eq_params.read();

        let mut eq = crate::processor::Equalizer::new(channels, sample_rate);
        if let Err(error) = eq.set_all_bands(&snapshot.gains, sample_rate) {
            log::warn!("Failed to apply EQ snapshot: {}", error);
        }
        eq.set_enabled(snapshot.enabled);
        Arc::new(Mutex::new(eq))
    }

    /// Get a crossfeed snapshot instance for backward compatibility.
    ///
    /// Note: This instance is NOT wired into the real-time lock-free DSP chain.
    pub fn crossfeed(&self) -> Arc<Mutex<crate::processor::Crossfeed>> {
        let sample_rate = self.shared_state.sample_rate.load(Ordering::Relaxed).max(1) as f64;
        let snapshot = self.lockfree_crossfeed_params.read();

        let mut crossfeed = crate::processor::Crossfeed::new(sample_rate);
        crossfeed.set_mix(snapshot.mix);
        crossfeed.set_sample_rate(sample_rate, snapshot.cutoff_hz);
        crossfeed.set_enabled(snapshot.enabled);
        Arc::new(Mutex::new(crossfeed))
    }

    /// Get a saturation snapshot instance for backward compatibility.
    ///
    /// Note: This instance is NOT wired into the real-time lock-free DSP chain.
    pub fn saturation(&self) -> Arc<Mutex<crate::processor::Saturation>> {
        let sample_rate = self.shared_state.sample_rate.load(Ordering::Relaxed).max(1) as f64;
        let snapshot = self.lockfree_saturation_params.read();

        let mut saturation = crate::processor::Saturation::new();
        saturation.set_sample_rate(sample_rate);
        saturation.set_drive(snapshot.drive);
        saturation.set_threshold(snapshot.threshold);
        saturation.set_mix(snapshot.mix);
        saturation.set_input_gain(snapshot.input_gain_db);
        saturation.set_output_gain(snapshot.output_gain_db);
        saturation.set_highpass_mode(snapshot.highpass_mode);
        saturation.set_highpass_cutoff(snapshot.highpass_cutoff);
        saturation.set_enabled(snapshot.enabled);
        // M-4 fix: use From trait for type-safe conversion
        saturation.set_type(crate::processor::SaturationType::from(snapshot.sat_type));
        Arc::new(Mutex::new(saturation))
    }

    // ============ Resampling Config Methods ============

    /// Get resample quality as string
    pub fn get_resample_quality(&self) -> String {
        match self.config.resample_quality {
            crate::config::ResampleQuality::Low => "low".to_string(),
            crate::config::ResampleQuality::Standard => "std".to_string(),
            crate::config::ResampleQuality::High => "hq".to_string(),
            crate::config::ResampleQuality::UltraHigh => "uhq".to_string(),
        }
    }

    /// Get use_cache setting
    pub fn get_use_cache(&self) -> bool {
        self.config.use_cache
    }

    /// Get preemptive_resample setting
    pub fn get_preemptive_resample(&self) -> bool {
        self.config.preemptive_resample
    }

    /// Set resample quality
    pub fn set_resample_quality(&mut self, quality: crate::config::ResampleQuality) {
        self.config.resample_quality = quality;
        log::info!("Resample quality set to: {:?}", quality);
    }

    /// Set use_cache setting
    pub fn set_use_cache(&mut self, enabled: bool) {
        self.config.use_cache = enabled;
        log::info!("Resample cache {}", if enabled { "enabled" } else { "disabled" });
    }

    /// Set preemptive_resample setting
    pub fn set_preemptive_resample(&mut self, enabled: bool) {
        self.config.preemptive_resample = enabled;
        log::info!("Preemptive resample {}", if enabled { "enabled" } else { "disabled" });
    }

    pub fn load_ir(&mut self, path: &str) -> Result<(), String> {
        use crate::decoder::StreamingDecoder;

        const MAX_IR_BYTES: usize = 64 * 1024 * 1024;

        let mut decoder = StreamingDecoder::open(path)
            .map_err(|e| format!("Failed to open IR file '{}': {}", path, e))?;
        let info = decoder.info.clone();
        let ir_data = decoder
            .decode_all()
            .map_err(|e| format!("Failed to decode IR file '{}': {}", path, e))?;

        if ir_data.is_empty() {
            return Err("IR file decoded to empty buffer".to_string());
        }

        let ir_bytes = ir_data.len().saturating_mul(std::mem::size_of::<f64>());
        if ir_bytes > MAX_IR_BYTES {
            return Err(format!(
                "IR data too large: {:.1} MB (max: {:.1} MB)",
                ir_bytes as f64 / (1024.0 * 1024.0),
                MAX_IR_BYTES as f64 / (1024.0 * 1024.0)
            ));
        }

        self.cmd_tx
            .send(AudioCommand::SetExternalIrConvolver {
                ir_data,
                channels: info.channels.max(1),
            })
            .map_err(|e| format!("Failed to send IR command to audio thread: {}", e))?;

        self.ir_loaded = true;
        self.ir_path = Some(path.to_string());
        log::info!("IR loaded and activated: '{}'", path);
        Ok(())
    }

    pub fn unload_ir(&mut self) {
        if let Err(e) = self.cmd_tx.send(AudioCommand::ClearExternalIrConvolver) {
            log::warn!("Failed to send ClearExternalIrConvolver command: {}", e);
        }
        self.ir_loaded = false;
        self.ir_path = None;
        log::info!("IR unloaded");
    }

    pub fn is_ir_loaded(&self) -> bool {
        self.ir_loaded
    }

    pub fn queue_next(&self, path: &str) -> Result<(), String> {
        self.queue_next_with_credentials(path, None)
    }

    pub fn queue_next_with_credentials(
        &self,
        path: &str,
        credentials: Option<crate::decoder::HttpCredentials>,
    ) -> Result<(), String> {
        let mode = self.config.loudness.mode;
        GaplessManager::queue_next(
            &self.shared_state,
            &self.loudness_normalizer,
            &self.config,
            path,
            credentials,
            self.loudness_enabled,
            mode,
            self.loudness_cache.clone(),
        )
    }

    pub fn cancel_preload(&self) {
        GaplessManager::cancel_preload(&self.shared_state);
    }
    
    /// Set output bit depth for NoiseShaper
    pub fn set_output_bits(&self, bits: u32) {
        self.lockfree_noise_shaper_params.set_bits(bits);
        self.shared_state.output_bits.store(bits, Ordering::Relaxed);
        log::info!("Output bit depth set to {} bits", bits);
    }
    
    /// Get output bit depth
    pub fn get_output_bits(&self) -> u32 {
        self.shared_state.output_bits.load(Ordering::Relaxed)
    }
    
    /// Get normalization mode
    pub fn get_normalization_mode(&self) -> crate::config::NormalizationMode {
        self.config.loudness.mode
    }

    /// Get target LUFS
    pub fn get_target_lufs(&self) -> f64 {
        self.config.loudness.target_lufs
    }
    
    // ============ FIR EQ Methods ============
    
    /// Enable FIR EQ (real convolution backend)
    pub fn enable_fir_eq(&mut self, num_taps: usize) -> Result<(), String> {
        let normalized_taps = if num_taps == 0 {
            1023
        } else if num_taps % 2 == 0 {
            num_taps + 1
        } else {
            num_taps
        };

        self.fir_eq_enabled = true;
        self.fir_taps = normalized_taps;
        self.lockfree_eq_params.set_enabled(false);
        *self.shared_state.eq_type.write() = "FIR".to_string();
        self.apply_fir_convolver()?;

        log::info!("FIR EQ enabled (real convolution, taps={})", self.fir_taps);
        Ok(())
    }
    
    /// Disable FIR EQ
    /// Unload the FIR convolution backend (turn FIR EQ off).
    ///
    /// Deliberately does NOT rewrite `eq_type`: the selected *type* is the
    /// user's choice and is orthogonal to whether the EQ is currently enabled.
    /// Callers that switch the user's choice to IIR (`set_eq_type`) write the
    /// type themselves. Keeping this side-effect-free is what lets "turn EQ
    /// off, then back on" return to FIR instead of silently degrading to IIR.
    pub fn disable_fir_eq(&mut self) {
        self.fir_eq_enabled = false;
        if let Err(e) = self.cmd_tx.send(AudioCommand::ClearFirConvolver) {
            log::warn!("Failed to clear FIR convolver: {}", e);
        }
        log::info!("FIR EQ disabled");
    }
    
    /// Check if FIR EQ is enabled
    pub fn is_fir_eq_enabled(&self) -> bool {
        self.fir_eq_enabled
    }

    /// Current FIR tap count (normalized). Exposed for state reporting.
    pub fn get_fir_taps(&self) -> usize {
        self.fir_taps
    }
    
    /// Set FIR EQ band gain
    pub fn set_fir_band_gain(&mut self, band_idx: usize, gain_db: f64) -> Result<(), String> {
        if band_idx >= self.fir_bands.len() {
            return Err(format!("FIR band index out of range: {}", band_idx));
        }

        let clamped = gain_db.clamp(-15.0, 15.0);
        self.fir_bands[band_idx].1 = clamped;
        if self.fir_eq_enabled {
            self.apply_fir_convolver()?;
        }
        Ok(())
    }
    
    /// Set all FIR EQ band gains at once
    pub fn set_fir_bands(&mut self, gains_db: &[f64; 10]) -> Result<(), String> {
        for (idx, gain) in gains_db.iter().enumerate() {
            let clamped = gain.clamp(-15.0, 15.0);
            self.fir_bands[idx].1 = clamped;
        }
        if self.fir_eq_enabled {
            self.apply_fir_convolver()?;
        }
        Ok(())
    }
    
    /// Get current FIR EQ band gains
    pub fn get_fir_bands(&self) -> Option<[(f64, f64); 10]> {
        Some(self.fir_bands)
    }
    
    /// Set FIR EQ phase mode
    pub fn set_fir_phase_mode(&mut self, mode: crate::processor::FirPhaseMode) -> Result<(), String> {
        self.fir_phase_mode = mode;
        if self.fir_eq_enabled {
            self.apply_fir_convolver()?;
        }
        log::info!("FIR phase mode set to {:?}", self.fir_phase_mode);
        Ok(())
    }
    
    /// Reset FIR convolver state
    pub fn reset_fir_convolver(&self) {
        if self.fir_eq_enabled {
            if let Err(e) = self.apply_fir_convolver() {
                log::warn!("Failed to reset FIR convolver: {}", e);
            }
        }
    }

    fn current_output_channels(&self) -> usize {
        self.shared_state.channels.load(Ordering::Relaxed).max(1) as usize
    }

    fn build_fir_ir(&self, channels: usize) -> Vec<f64> {
        let sample_rate = self.shared_state.sample_rate.load(Ordering::Relaxed).max(1) as f64;
        let mut fir = crate::processor::FirEq::new(sample_rate, self.fir_taps);
        fir.set_phase_mode(self.fir_phase_mode);
        let gains = std::array::from_fn(|i| self.fir_bands[i].1);
        fir.set_bands(&gains);
        fir.get_ir(channels)
    }

    fn apply_fir_convolver(&self) -> Result<(), String> {
        let channels = self.current_output_channels();
        let ir_data = self.build_fir_ir(channels);
        self.cmd_tx
            .send(AudioCommand::SetFirConvolver { ir_data, channels })
            .map_err(|e| format!("Failed to send FIR convolver update: {}", e))
    }
}

impl Drop for AudioPlayer {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(AudioCommand::Shutdown);
        if let Some(handle) = self.audio_thread.take() {
            let _ = handle.join();
        }
    }
}

/// Integrated loudness from an earlier measurement of this unchanged local file.
fn cached_loudness(cache: Option<&crate::processor::LoudnessDatabase>, path: &str) -> Option<f64> {
    let db = cache?;
    if path.starts_with("http://") || path.starts_with("https://") {
        return None;
    }
    match db.needs_scan(path) {
        Ok(false) => db.get(path).ok().flatten().map(|t| t.integrated_lufs).filter(|l| l.is_finite()),
        _ => None,
    }
}

/// Keep a playback measurement for the next time this file is played.
fn store_loudness(cache: Option<&crate::processor::LoudnessDatabase>, path: &str, integrated_lufs: f64) {
    let Some(db) = cache else { return };
    if !integrated_lufs.is_finite() || path.starts_with("http://") || path.starts_with("https://") {
        return;
    }
    // True peak is not measured while streaming; 0 dBTP is the conservative "unknown".
    let track = crate::processor::TrackLoudness::new(
        path,
        integrated_lufs,
        0.0,
        None,
        crate::processor::DEFAULT_STREAMING_TARGET_LUFS,
    );
    if let Err(e) = db.upsert(&track) {
        log::warn!("Could not remember loudness of {}: {}", path, e);
    }
}

#[cfg(test)]
mod loudness_cache_tests {
    use super::*;
    use crate::processor::LoudnessDatabase;

    fn write_wav(path: &std::path::Path, seconds: f64) {
        let sr = 44_100u32;
        let frames = (sr as f64 * seconds) as u32;
        let mut data = Vec::with_capacity(frames as usize * 4);
        for i in 0..frames {
            let v = ((i as f64 * 0.0627).sin() * 0.3 * 32767.0) as i16;
            data.extend_from_slice(&v.to_le_bytes());
            data.extend_from_slice(&v.to_le_bytes());
        }
        let mut f = Vec::new();
        f.extend_from_slice(b"RIFF");
        f.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        f.extend_from_slice(b"WAVEfmt ");
        f.extend_from_slice(&16u32.to_le_bytes());
        f.extend_from_slice(&1u16.to_le_bytes());
        f.extend_from_slice(&2u16.to_le_bytes());
        f.extend_from_slice(&sr.to_le_bytes());
        f.extend_from_slice(&(sr * 4).to_le_bytes());
        f.extend_from_slice(&4u16.to_le_bytes());
        f.extend_from_slice(&16u16.to_le_bytes());
        f.extend_from_slice(b"data");
        f.extend_from_slice(&(data.len() as u32).to_le_bytes());
        f.extend_from_slice(&data);
        std::fs::write(path, f).unwrap();
    }

    /// Run one load and return the loudness the decode thread reported.
    fn load_once(path: &str, db: &LoudnessDatabase) -> Option<f64> {
        load_in_mode(path, db, crate::config::NormalizationMode::ReplayGainTrack)
    }

    fn load_in_mode(path: &str, db: &LoudnessDatabase, mode: crate::config::NormalizationMode) -> Option<f64> {
        let shared = Arc::new(SharedState::new());
        let generation = shared.load_generation.fetch_add(1, Ordering::AcqRel) + 1;
        let (tx, rx) = unbounded::<AudioCommand>();
        let loudness = Arc::new(crate::processor::AtomicLoudnessState::new(200.0, 44_100).unwrap());
        loudness.set_normalization_mode(mode);
        let config = AppConfig { target_samplerate: Some(44_100), ..AppConfig::default() };
        AudioPlayer::stream_load(path, None, &config, None, &shared, &tx, &loudness, generation, Some(db));
        drop(tx);
        let mut seen_complete = false;
        let mut measured = None;
        for cmd in rx.iter() {
            match cmd {
                AudioCommand::LoadComplete { .. } => seen_complete = true,
                AudioCommand::LoudnessMeasured { integrated_lufs, .. } => {
                    assert!(seen_complete, "gain is applied after the load, never overwritten by it");
                    measured = Some(integrated_lufs);
                }
                _ => {}
            }
        }
        measured
    }

    #[test]
    fn untagged_track_is_measured_once_then_starts_at_the_remembered_level() {
        let dir = std::env::temp_dir().join(format!("vcp-loudness-cache-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("untagged.wav");
        write_wav(&wav, 2.5);
        let path = wav.to_string_lossy().to_string();
        let db = LoudnessDatabase::in_memory().unwrap();

        let first = load_once(&path, &db).expect("measured while streaming");
        let stored = cached_loudness(Some(&db), &path).expect("measurement remembered");
        assert!((stored - first).abs() < 1e-9);

        // A remembered value is used as is (no second measurement): plant a marker.
        store_loudness(Some(&db), &path, -30.0);
        assert_eq!(load_once(&path, &db), Some(-30.0));

        // The file changes: the old value is not trusted any more.
        write_wav(&wav, 1.5);
        assert_eq!(cached_loudness(Some(&db), &path), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stream_that_had_to_fall_back_says_so() {
        // 独占打不开（这台机器根本没有独占）、选的设备不在了：都要能从 /state 看出来，
        // 不然界面一直显示「独占」「某某声卡」，实际在用共享模式、默认设备。
        let dir = std::env::temp_dir().join(format!("vcp-fallback-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("a.wav");
        write_wav(&wav, 1.0);
        let mut player = AudioPlayer::new(AppConfig::default());
        let shared = player.shared_state();
        player.exclusive_mode = true;
        shared.exclusive_mode.store(true, Ordering::Relaxed);
        player.select_device(Some(4096)).unwrap();
        player.load(&wav.to_string_lossy()).unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while player.is_loading() && std::time::Instant::now() < until {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        player.play().unwrap();
        while shared.output_fallback.load(Ordering::Relaxed) == 0 && std::time::Instant::now() < until {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let bits = shared.output_fallback.load(Ordering::Relaxed);
        let names = output_fallback_names(bits);
        assert!(names.contains(&"device"), "{names:?}");
        // 没有独占的平台上一定是退回了共享模式（Windows 上取决于声卡，这里不判）
        if !cfg!(windows) { assert!(names.contains(&"exclusive"), "{names:?}"); }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn track_mode_measures_a_picked_song_too() {
        let dir = std::env::temp_dir().join(format!("vcp-loudness-track-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("picked.wav");
        write_wav(&wav, 2.0);
        let path = wav.to_string_lossy().to_string();
        let db = LoudnessDatabase::in_memory().unwrap();
        for mode in [crate::config::NormalizationMode::Track, crate::config::NormalizationMode::Album] {
            assert!(load_in_mode(&path, &db, mode).is_some(), "{mode:?} left the gain unset");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_song_cut_short_by_a_read_error_is_not_cached() {
        // 3 s of 44.1 kHz WAV over HTTP; every chunk after the second fails for good, so the
        // decode stops after playback has started.
        let dir = std::env::temp_dir().join(format!("vcp-cut-cache-{}", std::process::id()));
        let cache_dir = dir.join("cache");
        std::fs::create_dir_all(&cache_dir).unwrap();
        let wav = dir.join("song.wav");
        write_wav(&wav, 3.0);
        let (url, _) = crate::decoder::range_retry_tests::serve(std::fs::read(&wav).unwrap(), |n| if n < 2 { 0 } else { 1 });

        let shared = Arc::new(SharedState::new());
        let generation = shared.load_generation.fetch_add(1, Ordering::AcqRel) + 1;
        let (tx, rx) = unbounded::<AudioCommand>();
        let loudness = Arc::new(crate::processor::AtomicLoudnessState::new(200.0, 44_100).unwrap());
        let config = AppConfig {
            target_samplerate: Some(48_000),
            use_cache: true,
            cache_dir: Some(cache_dir.clone()),
            ..AppConfig::default()
        };
        AudioPlayer::stream_load(&url, None, &config, None, &shared, &tx, &loudness, generation, None);
        drop(tx);
        assert!(rx.iter().any(|c| matches!(c, AudioCommand::LoadComplete { .. })), "playback started");
        let cached = std::fs::read_dir(&cache_dir).map(|d| d.count()).unwrap_or(0);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(cached, 0, "the cut-short decode was saved to the resample cache");
    }

    #[test]
    fn a_seek_to_nan_or_a_negative_time_is_refused() {
        let mut player = AudioPlayer::new(AppConfig::default());
        assert!(player.seek(f64::NAN).is_err());
        assert!(player.seek(-1.0).is_err());
        assert!(player.seek(f64::INFINITY).is_err());
        assert!(player.seek(12.5).is_ok());
    }
}
