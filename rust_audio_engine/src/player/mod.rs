//! VCP Hi-Fi Audio Engine - Audio Player Module
//!
//! Native audio playback using cpal with lock-free DSP processing.
//! Uses f64 full-stack path for maximum transparency.

mod state;
mod gapless;
mod callback;
mod audio_thread;
mod spectrum;

// Re-exports
pub use state::{AudioCommand, PlayerState, SharedState, AudioDeviceInfo};
pub use gapless::GaplessManager;
pub use callback::{LockfreeDspContext, audio_callback_lockfree, normalize_channels};

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
    LoudnessNormalizer, LoudnessInfo, AtomicLoudnessState,
    // Lock-free parameters
    AtomicEqParams, AtomicSaturationParams, AtomicCrossfeedParams,
    AtomicPeakLimiterParams, AtomicVolumeParams, AtomicNoiseShaperParams,
    AtomicDynamicLoudnessParams, AtomicDynamicLoudnessTelemetry,
    NoiseShaperCurve,
    FirPhaseMode, STANDARD_BANDS,
};

// Import internal modules
use state::{save_cache_with_header, load_cache_with_header};
use audio_thread::audio_thread_main;
use spectrum::spectrum_thread_main;

/// The main audio player - thread-safe wrapper
pub struct AudioPlayer {
    shared_state: Arc<SharedState>,
    cmd_tx: Sender<AudioCommand>,
    audio_thread: Option<JoinHandle<()>>,

    // Spectrum analyzer for visualization
    spectrum_analyzer: Arc<SpectrumAnalyzer>,
    
    // Loudness normalizer for main thread operations
    loudness_normalizer: Arc<Mutex<LoudnessNormalizer>>,
    loudness_state: Arc<AtomicLoudnessState>,

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

        let spectrum_analyzer = Arc::new(SpectrumAnalyzer::new(2048, 64));

        let loudness_normalizer = Arc::new(Mutex::new(LoudnessNormalizer::new(
            2,
            44100,
            config.loudness.clone(),
        )));
        let loudness_state = loudness_normalizer.lock().atomic_state();

        let (spectrum_tx, spectrum_rx) = crossbeam::channel::bounded::<f64>(4096);

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
            lockfree_saturation_params.set_enabled(config.saturation.enabled);
        }

        // Sync initial dynamic loudness config to lockfree params
        {
            lockfree_dynamic_loudness_params.set_enabled(config.dynamic_loudness.enabled);
            lockfree_dynamic_loudness_params.set_strength(config.dynamic_loudness.strength);
            lockfree_dynamic_loudness_params.set_ref_volume_db(config.dynamic_loudness.ref_volume_db);
        }

        {
            lockfree_noise_shaper_params.set_enabled(true);
            lockfree_noise_shaper_params.set_bits(24);
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
        let target_lufs = config.loudness.target_lufs;

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
                24,  // noise shaper bits
                spectrum_tx,
                phase_response,
                target_lufs,
            );
        });

        Self {
            shared_state,
            cmd_tx,
            audio_thread: Some(audio_thread),
            spectrum_analyzer,
            loudness_normalizer,
            loudness_state,
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

        // Set loading state
        self.shared_state.is_loading.store(true, Ordering::Release);
        self.shared_state.load_progress.store(0, Ordering::Relaxed);
        *self.shared_state.load_error.write() = None;

        let path_owned = path.to_string();
        let credentials_owned = credentials.cloned();
        let shared_state = Arc::clone(&self.shared_state);
        let cmd_tx = self.cmd_tx.clone();
        let config = self.config.clone();
        let device_id = self.device_id;
        let loudness_enabled = self.loudness_enabled;

        // Spawn background thread for decoding
        thread::spawn(move || {
            let result = Self::decode_file_internal(
                &path_owned,
                credentials_owned.as_ref(),
                &config,
                device_id,
                &shared_state,
                loudness_enabled,
            );

            shared_state.is_loading.store(false, Ordering::Release);

            match result {
                Ok(load_result) => {
                    let _ = cmd_tx.send(AudioCommand::LoadComplete(load_result));
                }
                Err(e) => {
                    log::error!("Async load failed: {}", e);
                    *shared_state.load_error.write() = Some(e.clone());
                    let _ = cmd_tx.send(AudioCommand::LoadError(e));
                }
            }
        });

        Ok(())
    }

    /// Internal decode function for async loading
    fn decode_file_internal(
        path: &str,
        credentials: Option<&crate::decoder::HttpCredentials>,
        config: &AppConfig,
        device_id: Option<usize>,
        shared_state: &Arc<SharedState>,
        loudness_enabled: bool,
    ) -> Result<state::LoadResult, String> {
        use crate::decoder::StreamingDecoder;
        use crate::processor::StreamingResampler;

        let mut decoder = StreamingDecoder::open_with_credentials(path, credentials)
            .map_err(|e| {
                log::error!("Failed to open decoder for {}: {}", path, e);
                e.to_string()
            })?;

        let info = decoder.info.clone();
        let original_sr = info.sample_rate;
        let channels = info.channels;

        let target_sr = config.target_samplerate
            .unwrap_or_else(|| {
                let host = cpal::default_host();
                let device = match device_id {
                    Some(id) => host.output_devices().ok().and_then(|mut d| d.nth(id)),
                    None => host.default_output_device(),
                };
                device
                    .and_then(|d| d.default_output_config().ok())
                    .map(|c| c.sample_rate().0)
                    .unwrap_or(original_sr)
            });

        let need_resample = target_sr != original_sr;
        let estimated_input_frames = info.total_frames.unwrap_or(0) as usize;
        
        // If preemptive_resample is false, skip pre-resampling and keep original sample rate
        let (final_target_sr, final_need_resample) = if need_resample && !config.preemptive_resample {
            log::info!("preemptive_resample=false: keeping original {} Hz (will resample at playback)", original_sr);
            (original_sr, false)
        } else {
            (target_sr, need_resample)
        };

        // Calculate cache path
        let cache_path = if config.use_cache && final_need_resample {
            let cache_dir = config.cache_dir.clone().unwrap_or_else(|| PathBuf::from("resample_cache"));
            use sha2::{Sha256, Digest};
            let mut hasher = Sha256::new();
            hasher.update(path.as_bytes());
            hasher.update(final_target_sr.to_le_bytes());
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
        } else {
            None
        };

        // Try cache first
        if let Some(ref cp) = cache_path {
            if cp.exists() {
                if let Some(cached_samples) = load_cache_with_header(cp, final_target_sr, channels as u32) {
                    let total_frames = cached_samples.len() / channels;
                    log::info!("Loaded from cache: {} frames", total_frames);
                    return Ok(state::LoadResult {
                        samples: cached_samples.clone(),
                        sample_rate: final_target_sr,
                        channels,
                        total_frames: total_frames as u64,
                        file_path: path.to_string(),
                        loudness_info: None,
                        metadata: info.metadata,
                    });
                } else {
                    log::warn!("Cache validation failed, will re-decode");
                }
            }
        }

        if final_need_resample {
            log::info!("Streaming SoX VHQ Resampling {} -> {} Hz", original_sr, final_target_sr);
        }

        let estimated_output_frames = if final_need_resample {
            (estimated_input_frames as f64 * final_target_sr as f64 / original_sr as f64).ceil() as usize
        } else {
            estimated_input_frames
        };
        let mut samples = Vec::with_capacity(estimated_output_frames * channels);

        let mut resampler = if final_need_resample {
            match StreamingResampler::with_phase(channels, original_sr, final_target_sr, config.phase_response) {
                Ok(rs) => Some(rs),
                Err(e) => {
                    return Err(format!("Failed to create resampler: {} -> {}: {}", original_sr, final_target_sr, e));
                }
            }
        } else {
            None
        };

        let total_estimated = estimated_input_frames.max(1);
        let mut chunk_count = 0;
        let mut decoded_frames = 0;

        while let Some(decoded_chunk) = decoder.decode_next().map_err(|e| e.to_string())? {
            decoded_frames += decoded_chunk.len() / channels;
            if let Some(ref mut rs) = resampler {
                let resampled = rs.process_chunk(&decoded_chunk);
                samples.extend(resampled);
            } else {
                samples.extend(decoded_chunk);
            }
            chunk_count += 1;

            // Update progress
            let progress = ((decoded_frames as f64 / total_estimated as f64) * 100.0).min(99.0) as u64;
            shared_state.load_progress.store(progress, Ordering::Relaxed);

            if chunk_count % 100 == 0 {
                log::debug!("Streaming progress: {} chunks, {} decoded frames, {}%",
                    chunk_count, decoded_frames, progress);
            }
        }

        if let Some(ref mut rs) = resampler {
            samples.extend(rs.flush());
        }

        shared_state.load_progress.store(100, Ordering::Relaxed);

        log::info!(
            "Streaming decode complete: {} chunks, {} output samples ({}→{} Hz)",
            chunk_count, samples.len(), original_sr, final_target_sr
        );

        // Save to cache
        if final_need_resample {
            if let Some(ref cp) = cache_path {
                if let Err(e) = save_cache_with_header(cp, &samples, final_target_sr, channels as u32) {
                    log::warn!("Failed to save cache: {}", e);
                }
            }
        }

        let total_frames = samples.len() / channels;

        Ok(state::LoadResult {
            samples,
            sample_rate: final_target_sr,
            channels,
            total_frames: total_frames as u64,
            file_path: path.to_string(),
            loudness_info: None,
            metadata: info.metadata,
        })
    }

    /// Check if a file is currently being loaded
    pub fn is_loading(&self) -> bool {
        self.shared_state.is_loading.load(Ordering::Relaxed)
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
        *self.shared_state.state.read()
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
        self.loudness_normalizer.lock().set_target_lufs(target_lufs);
        self.config.loudness.target_lufs = target_lufs;
    }

    pub fn set_album_gain(&self, gain_db: f64) {
        self.loudness_normalizer.lock().set_album_gain(gain_db);
    }

    pub fn set_preamp_gain(&self, gain_db: f64) {
        self.loudness_normalizer.lock().set_preamp_gain(gain_db);
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
        self.lockfree_saturation_params.get_settings()
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
        self.lockfree_crossfeed_params.get_settings()
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

        let mut shaper = crate::processor::NoiseShaper::new(channels, sample_rate, bits);
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
        eq.set_all_bands(&snapshot.gains, sample_rate);
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
        match snapshot.sat_type {
            crate::processor::SaturationTypeValue::Tape => {
                saturation.set_type(crate::processor::SaturationType::Tape)
            }
            crate::processor::SaturationTypeValue::Tube => {
                saturation.set_type(crate::processor::SaturationType::Tube)
            }
            crate::processor::SaturationTypeValue::Transistor => {
                saturation.set_type(crate::processor::SaturationType::Transistor)
            }
        }
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
    pub fn disable_fir_eq(&mut self) {
        self.fir_eq_enabled = false;
        if let Err(e) = self.cmd_tx.send(AudioCommand::ClearFirConvolver) {
            log::warn!("Failed to clear FIR convolver: {}", e);
        }
        *self.shared_state.eq_type.write() = "IIR".to_string();
        log::info!("FIR EQ disabled");
    }
    
    /// Check if FIR EQ is enabled
    pub fn is_fir_eq_enabled(&self) -> bool {
        self.fir_eq_enabled
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
