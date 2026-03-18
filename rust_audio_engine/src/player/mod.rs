//! VCP Hi-Fi Audio Engine - Audio Player Module
//!
//! Native audio playback using cpal with WASAPI exclusive mode support.
//! Upgraded to f64 full-stack path for maximum transparency.

mod state;
mod gapless;
mod callback;
mod audio_thread;
mod spectrum;

// Re-exports
pub use state::{AudioCommand, PlayerState, SharedState, AudioDeviceInfo};
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
    Equalizer, VolumeController, NoiseShaper, SpectrumAnalyzer,
    LoudnessNormalizer, LoudnessInfo, AtomicLoudnessState, PeakLimiter,
    Saturation, Crossfeed, FirEq, FFTConvolver,
    DynamicLoudness, AtomicDynamicLoudnessState,
};

// Import internal modules
use state::{save_cache_with_header, load_cache_with_header};
use audio_thread::audio_thread_main;
use spectrum::spectrum_thread_main;

// Re-export wasapi for downstream use
#[cfg(windows)]
pub use crate::wasapi_output::WasapiState;

/// The main audio player - thread-safe wrapper
pub struct AudioPlayer {
    shared_state: Arc<SharedState>,
    cmd_tx: Sender<AudioCommand>,
    audio_thread: Option<JoinHandle<()>>,

    // Processors (shared with audio callback)
    eq: Arc<Mutex<Equalizer>>,
    volume: Arc<Mutex<VolumeController>>,
    noise_shaper: Arc<Mutex<NoiseShaper>>,
    spectrum_analyzer: Arc<SpectrumAnalyzer>,
    loudness_normalizer: Arc<Mutex<LoudnessNormalizer>>,
    loudness_state: Arc<AtomicLoudnessState>,

    // Peak limiter for audio thread
    peak_limiter: Arc<Mutex<PeakLimiter>>,

    // FIR Convolver for IR-based processing (user-loaded IR)
    convolver: Arc<Mutex<Option<FFTConvolver>>>,

    // FIR EQ generator and convolver (separate from user IR)
    fir_eq: Arc<Mutex<Option<FirEq>>>,
    fir_convolver: Arc<Mutex<Option<FFTConvolver>>>,

    // Saturation for analog warmth (Mutex for HPF state)
    saturation: Arc<Mutex<Saturation>>,

    // Crossfeed for headphone listening
    crossfeed: Arc<Mutex<Crossfeed>>,

    // Dynamic Loudness Compensation (ISO 226 Fletcher-Munson)
    dynamic_loudness: Arc<Mutex<DynamicLoudness>>,
    dynamic_loudness_state: Arc<AtomicDynamicLoudnessState>,

    // Config
    pub exclusive_mode: bool,
    pub target_sample_rate: Option<u32>,
    pub dither_enabled: bool,
    pub replaygain_enabled: bool,
    pub loudness_enabled: bool,

    config: AppConfig,
    device_id: Option<usize>,
}

impl AudioPlayer {
    pub fn new(config: AppConfig) -> Self {
        log::info!("Initializing AudioPlayer...");
        let shared_state = Arc::new(SharedState::new());
        let (cmd_tx, cmd_rx) = unbounded::<AudioCommand>();

        let thread_state = Arc::clone(&shared_state);

        let eq = Arc::new(Mutex::new(Equalizer::new(2, 44100.0)));
        let volume = Arc::new(Mutex::new(VolumeController::new()));
        let noise_shaper = Arc::new(Mutex::new(NoiseShaper::new(2, 44100, 24)));
        let spectrum_analyzer = Arc::new(SpectrumAnalyzer::new(2048, 64));

        let loudness_normalizer = Arc::new(Mutex::new(LoudnessNormalizer::new(
            2,
            44100,
            config.loudness.clone(),
        )));
        let loudness_state = loudness_normalizer.lock().atomic_state();

        let peak_limiter = Arc::new(Mutex::new(PeakLimiter::new(
            2,
            44100,
            config.loudness.true_peak_limit_db,
            10.0,
            150.0,
        )));

        let convolver = Arc::new(Mutex::new(None::<FFTConvolver>));

        // Initialize FIR EQ (disabled by default)
        let fir_eq = Arc::new(Mutex::new(None::<FirEq>));
        let fir_convolver = Arc::new(Mutex::new(None::<FFTConvolver>));

        // Initialize saturation processor (wrapped in Mutex for HPF state)
        let mut saturation = Saturation::new();
        if config.saturation.enabled {
            saturation.set_enabled(true);
            saturation.set_drive(config.saturation.drive);
            saturation.set_threshold(config.saturation.threshold);
            saturation.set_mix(config.saturation.mix);
            saturation.set_input_gain(config.saturation.input_gain_db);
            saturation.set_output_gain(config.saturation.output_gain_db);
        }
        let saturation = Arc::new(Mutex::new(saturation));

        // Initialize crossfeed processor for headphone listening
        let crossfeed = Arc::new(Mutex::new(Crossfeed::new(44100.0)));

        // Initialize Dynamic Loudness Compensation (ISO 226 Fletcher-Munson)
        let dynamic_loudness = Arc::new(Mutex::new(DynamicLoudness::new(2, 44100.0)));
        let dynamic_loudness_state = Arc::new(AtomicDynamicLoudnessState::new());
        
        // Apply config settings
        {
            let mut dl = dynamic_loudness.lock();
            dl.set_enabled(config.dynamic_loudness.enabled);
            dl.set_strength(config.dynamic_loudness.strength);
            dl.set_reference_volume_db(config.dynamic_loudness.ref_volume_db);
            dl.set_transition_db(config.dynamic_loudness.transition_db);
        }

        let thread_eq = Arc::clone(&eq);
        let thread_volume = Arc::clone(&volume);
        let thread_noise_shaper = Arc::clone(&noise_shaper);
        let thread_loudness_state = Arc::clone(&loudness_state);
        let thread_peak_limiter = Arc::clone(&peak_limiter);
        let thread_convolver = Arc::clone(&convolver);
        let thread_fir_convolver = Arc::clone(&fir_convolver);
        let thread_saturation = Arc::clone(&saturation);
        let thread_crossfeed = Arc::clone(&crossfeed);
        let thread_dynamic_loudness = Arc::clone(&dynamic_loudness);
        let phase_response = config.phase_response;

        let (spectrum_tx, spectrum_rx) = crossbeam::channel::bounded::<f64>(4096);

        let spec_state = Arc::clone(&shared_state);
        let spec_analyzer = Arc::clone(&spectrum_analyzer);
        thread::spawn(move || {
            spectrum_thread_main(spectrum_rx, spec_state, spec_analyzer);
        });

        let audio_thread = thread::spawn(move || {
            audio_thread_main(
                cmd_rx,
                thread_state,
                thread_eq,
                thread_volume,
                thread_noise_shaper,
                thread_loudness_state,
                thread_peak_limiter,
                thread_convolver,
                thread_fir_convolver,
                thread_saturation,
                thread_crossfeed,
                thread_dynamic_loudness,
                spectrum_tx,
                phase_response,
            );
        });

        let loudness_enabled = config.loudness.enabled;

        Self {
            shared_state,
            cmd_tx,
            audio_thread: Some(audio_thread),
            eq,
            volume,
            noise_shaper,
            spectrum_analyzer,
            loudness_normalizer,
            loudness_state,
            peak_limiter,
            convolver,
            fir_eq,
            fir_convolver,
            saturation,
            crossfeed,
            dynamic_loudness,
            dynamic_loudness_state,
            exclusive_mode: false,
            target_sample_rate: config.target_samplerate,
            dither_enabled: true,
            replaygain_enabled: true,
            loudness_enabled,
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
            }    pub fn select_device(&mut self, device_id: Option<usize>) -> Result<(), String> {
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
        use crate::decoder::StreamingDecoder;
        use crate::processor::StreamingResampler;

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
        // This is useful when you want to minimize load time at the cost of real-time resampling
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
            // Add phase_response to hash
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
                        loudness_info: None, // Will be analyzed separately
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
        // FIX for Defect 46: Clamp volume to [0.0, 1.0] before storing to atomic u64
        // to prevent integer wraparound with negative values which would cause
        // get_volume() to report incorrect values.
        let clamped_vol = vol.clamp(0.0, 1.0);
        self.volume.lock().set_target(clamped_vol);
        self.shared_state.volume.store((clamped_vol * 1_000_000.0) as u64, Ordering::Relaxed);
        
        // Update Dynamic Loudness with current volume
        self.dynamic_loudness.lock().set_volume(clamped_vol);
        self.dynamic_loudness_state.set_volume(clamped_vol as f32);
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

    pub fn eq(&self) -> Arc<Mutex<Equalizer>> {
        Arc::clone(&self.eq)
    }

    pub fn noise_shaper(&self) -> Arc<Mutex<NoiseShaper>> {
        Arc::clone(&self.noise_shaper)
    }

    pub fn loudness_normalizer(&self) -> Arc<Mutex<LoudnessNormalizer>> {
        Arc::clone(&self.loudness_normalizer)
    }

    pub fn crossfeed(&self) -> Arc<Mutex<Crossfeed>> {
        Arc::clone(&self.crossfeed)
    }

    pub fn saturation(&self) -> Arc<Mutex<Saturation>> {
        Arc::clone(&self.saturation)
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
        self.saturation.lock().get_settings()
    }

    /// Set saturation enabled
    pub fn set_saturation_enabled(&self, enabled: bool) {
        self.saturation.lock().set_enabled(enabled);
        log::info!("Saturation {}", if enabled { "enabled" } else { "disabled" });
    }

    /// Set saturation drive (0.0 - 2.0)
    pub fn set_saturation_drive(&self, drive: f64) {
        self.saturation.lock().set_drive(drive);
        log::info!("Saturation drive set to: {}", drive);
    }

    /// Set saturation mix (0.0 - 1.0)
    pub fn set_saturation_mix(&self, mix: f64) {
        self.saturation.lock().set_mix(mix);
        log::info!("Saturation mix set to: {}", mix);
    }

    /// Get crossfeed settings
    pub fn get_crossfeed_info(&self) -> crate::processor::CrossfeedSettings {
        self.crossfeed.lock().get_settings()
    }

    /// Set crossfeed enabled
    pub fn set_crossfeed_enabled(&self, enabled: bool) {
        self.crossfeed.lock().set_enabled(enabled);
        log::info!("Crossfeed {}", if enabled { "enabled" } else { "disabled" });
    }

    /// Set crossfeed mix (0.0 - 1.0)
    pub fn set_crossfeed_mix(&self, mix: f64) {
        self.crossfeed.lock().set_mix(mix);
        log::info!("Crossfeed mix set to: {}", mix);
    }

    // ============ Dynamic Loudness Methods ============

    /// Get Dynamic Loudness enabled state
    pub fn is_dynamic_loudness_enabled(&self) -> bool {
        self.dynamic_loudness.lock().is_enabled()
    }

    /// Set Dynamic Loudness enabled
    pub fn set_dynamic_loudness_enabled(&self, enabled: bool) {
        self.dynamic_loudness.lock().set_enabled(enabled);
        self.dynamic_loudness_state.set_enabled(enabled);
        log::info!("Dynamic Loudness {}", if enabled { "enabled" } else { "disabled" });
    }

    /// Get Dynamic Loudness strength (0.0 - 1.0)
    pub fn get_dynamic_loudness_strength(&self) -> f64 {
        self.dynamic_loudness.lock().strength()
    }

    /// Set Dynamic Loudness strength (0.0 - 1.0)
    pub fn set_dynamic_loudness_strength(&self, strength: f64) {
        self.dynamic_loudness.lock().set_strength(strength);
        self.dynamic_loudness_state.set_strength(strength as f32);
        log::info!("Dynamic Loudness strength: {:.0}%", strength * 100.0);
    }

    /// Get current loudness factor (for display)
    pub fn get_dynamic_loudness_factor(&self) -> f64 {
        self.dynamic_loudness.lock().loudness_factor()
    }

    /// Get current band gains (for display/metering)
    pub fn get_dynamic_loudness_gains(&self) -> [f64; 7] {
        self.dynamic_loudness.lock().get_band_gains()
    }

    /// Get noise shaper curve name
    pub fn get_noise_shaper_curve(&self) -> String {
        let ns = self.noise_shaper.lock();
        match ns.curve() {
            crate::processor::NoiseShaperCurve::Lipshitz5 => "Lipshitz5".to_string(),
            crate::processor::NoiseShaperCurve::FWeighted9 => "FWeighted9".to_string(),
            crate::processor::NoiseShaperCurve::ModifiedE9 => "ModifiedE9".to_string(),
            crate::processor::NoiseShaperCurve::ImprovedE9 => "ImprovedE9".to_string(),
            crate::processor::NoiseShaperCurve::TpdfOnly => "TpdfOnly".to_string(),
        }
    }

    /// Get output bit depth
    pub fn get_output_bits(&self) -> u32 {
        self.noise_shaper.lock().bits()
    }

    /// Get normalization mode
    pub fn get_normalization_mode(&self) -> crate::config::NormalizationMode {
        self.config.loudness.mode
    }

    /// Get target LUFS
    pub fn get_target_lufs(&self) -> f64 {
        self.config.loudness.target_lufs
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

    pub fn load_ir(&self, path: &str) -> Result<(), String> {
        use crate::decoder::StreamingDecoder;
        use crate::processor::StreamingResampler;

        log::info!("Loading IR file: {}", path);

        let channels = self.shared_state.channels.load(Ordering::Relaxed) as usize;
        let channels = if channels == 0 { 2 } else { channels };
        let target_sr = self.shared_state.sample_rate.load(Ordering::Relaxed) as u32;

        let mut decoder = StreamingDecoder::open(path)
            .map_err(|e| format!("IR load failed: {}", e))?;

        let ir_channels = decoder.info.channels;
        let ir_sample_rate = decoder.info.sample_rate;

        let mut ir_samples = decoder.decode_all()
            .map_err(|e| format!("IR decode failed: {}", e))?;

        if ir_sample_rate != target_sr && target_sr > 0 {
            log::info!("IR resampling: {} Hz -> {} Hz", ir_sample_rate, target_sr);
            let mut resampler = StreamingResampler::new(ir_channels, ir_sample_rate, target_sr)
                .map_err(|e| format!("Failed to create IR resampler: {}", e))?;
            ir_samples = resampler.process_chunk(&ir_samples);
            ir_samples.extend(resampler.flush());
        }

        // FIX for Defect 35: Handle all channel conversion cases, not just 1ch↔2ch
        if ir_channels != channels {
            log::info!("IR channel conversion: {} ch -> {} ch", ir_channels, channels);
            
            let ir_frames = ir_samples.len() / ir_channels;
            
            if ir_channels == 1 && channels > 1 {
                // Mono to multi-channel: duplicate mono to all channels
                let mono = ir_samples.clone();
                ir_samples = Vec::with_capacity(ir_frames * channels);
                for &sample in &mono {
                    for _ in 0..channels {
                        ir_samples.push(sample);
                    }
                }
            } else if ir_channels > 1 && channels == 1 {
                // Multi-channel to mono: average all channels
                let mut mono = Vec::with_capacity(ir_frames);
                for frame in 0..ir_frames {
                    let mut sum = 0.0;
                    for ch in 0..ir_channels {
                        sum += ir_samples[frame * ir_channels + ch];
                    }
                    mono.push(sum / ir_channels as f64);
                }
                ir_samples = mono;
            } else {
                // Both multi-channel but different counts: use matrix conversion
                // For simplicity, we convert to mono first then expand
                // This is not ideal for true multi-channel convolution but prevents crashes
                log::warn!(
                    "IR has {} channels but player has {} channels. Converting via mono.",
                    ir_channels, channels
                );
                
                // Convert IR to mono
                let mut mono = Vec::with_capacity(ir_frames);
                for frame in 0..ir_frames {
                    let mut sum = 0.0;
                    for ch in 0..ir_channels {
                        sum += ir_samples[frame * ir_channels + ch];
                    }
                    mono.push(sum / ir_channels as f64);
                }
                
                // Expand mono to target channels
                ir_samples = Vec::with_capacity(ir_frames * channels);
                for &sample in &mono {
                    for _ in 0..channels {
                        ir_samples.push(sample);
                    }
                }
            }
        }

        let taps = ir_samples.len() / channels;
        if taps == 0 {
            return Err("IR file is empty or too short".to_string());
        }

        let conv = crate::processor::FFTConvolver::new(&ir_samples, channels);
        *self.convolver.lock() = Some(conv);

        log::info!("IR loaded: {} taps, {} channels", taps, channels);
        Ok(())
    }

    pub fn unload_ir(&self) {
        *self.convolver.lock() = None;
        log::info!("IR unloaded, convolver bypassed");
    }

    pub fn is_ir_loaded(&self) -> bool {
        self.convolver.lock().is_some()
    }

    pub fn reset_convolver(&self) {
        if let Some(mut guard) = self.convolver.try_lock() {
            if let Some(ref mut conv) = *guard {
                conv.reset();
            }
        }
    }

    pub fn queue_next(&self, path: &str) -> Result<(), String> {
        self.queue_next_with_credentials(path, None)
    }

    pub fn queue_next_with_credentials(
        &self,
        path: &str,
        credentials: Option<crate::decoder::HttpCredentials>,
    ) -> Result<(), String> {
        // Get current normalization mode from config
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
    
    /// Set output bit depth for NoiseShaper (Defect 37 fix)
    /// Call this when the audio device format is known (e.g., 16, 24, or 32 bits)
    pub fn set_output_bits(&self, bits: u32) {
        self.shared_state.output_bits.store(bits, Ordering::Relaxed);
        self.noise_shaper.lock().set_bits(bits);
        log::info!("Output bit depth set to {} bits", bits);
    }
    
    // ============ FIR EQ Methods ============
    
    /// Enable FIR EQ with specified number of taps
    /// 
    /// # Arguments
    /// * `num_taps` - Number of FIR taps (will be forced to odd for linear phase)
    /// 
    /// # Returns
    /// Ok(()) on success, Err on failure
    pub fn enable_fir_eq(&mut self, num_taps: usize) -> Result<(), String> {
        let sr = self.shared_state.sample_rate.load(Ordering::Relaxed) as f64;
        let channels = self.shared_state.channels.load(Ordering::Relaxed) as usize;
        let channels = if channels == 0 { 2 } else { channels };
        
        let mut fir = FirEq::new(sr, num_taps);
        let ir = fir.get_ir(channels);
        let conv = FFTConvolver::new(&ir, channels);
        
        *self.fir_eq.lock() = Some(fir);
        *self.fir_convolver.lock() = Some(conv);
        *self.shared_state.eq_type.write() = "FIR".to_string();
        
        log::info!("FIR EQ enabled: {} taps @ {} Hz, {} channels", num_taps, sr, channels);
        Ok(())
    }
    
    /// Disable FIR EQ (revert to IIR)
    pub fn disable_fir_eq(&mut self) {
        *self.fir_eq.lock() = None;
        *self.fir_convolver.lock() = None;
        *self.shared_state.eq_type.write() = "IIR".to_string();
        log::info!("FIR EQ disabled, reverted to IIR");
    }
    
    /// Check if FIR EQ is enabled
    pub fn is_fir_eq_enabled(&self) -> bool {
        self.fir_eq.lock().is_some()
    }
    
    /// Set FIR EQ band gain
    /// 
    /// # Arguments
    /// * `band_idx` - Band index (0-9 for standard 10-band EQ)
    /// * `gain_db` - Gain in dB (-15 to +15)
    pub fn set_fir_band_gain(&mut self, band_idx: usize, gain_db: f64) -> Result<(), String> {
        let channels = self.shared_state.channels.load(Ordering::Relaxed) as usize;
        let channels = if channels == 0 { 2 } else { channels };
        
        let mut fir_guard = self.fir_eq.lock();
        let fir = fir_guard.as_mut().ok_or("FIR EQ not enabled")?;
        
        fir.set_band(band_idx, gain_db);
        
        // Regenerate IR and update convolver
        let ir = fir.get_ir(channels);
        let conv = FFTConvolver::new(&ir, channels);
        
        drop(fir_guard);  // Release lock before acquiring another
        
        *self.fir_convolver.lock() = Some(conv);
        Ok(())
    }
    
    /// Set all FIR EQ band gains at once (more efficient than individual calls)
    pub fn set_fir_bands(&mut self, gains_db: &[f64; 10]) -> Result<(), String> {
        let channels = self.shared_state.channels.load(Ordering::Relaxed) as usize;
        let channels = if channels == 0 { 2 } else { channels };
        
        let mut fir_guard = self.fir_eq.lock();
        let fir = fir_guard.as_mut().ok_or("FIR EQ not enabled")?;
        
        fir.set_bands(gains_db);
        
        let ir = fir.get_ir(channels);
        let conv = FFTConvolver::new(&ir, channels);
        
        drop(fir_guard);
        
        *self.fir_convolver.lock() = Some(conv);
        log::info!("FIR EQ bands updated: {:?}", gains_db);
        Ok(())
    }
    
    /// Get current FIR EQ band gains
    pub fn get_fir_bands(&self) -> Option<[(f64, f64); 10]> {
        self.fir_eq.lock().as_ref().map(|fir| fir.get_bands())
    }
    
    /// Set FIR EQ phase mode
    pub fn set_fir_phase_mode(&mut self, mode: crate::processor::FirPhaseMode) -> Result<(), String> {
        let channels = self.shared_state.channels.load(Ordering::Relaxed) as usize;
        let channels = if channels == 0 { 2 } else { channels };
        
        let mut fir_guard = self.fir_eq.lock();
        let fir = fir_guard.as_mut().ok_or("FIR EQ not enabled")?;
        
        fir.set_phase_mode(mode);
        
        let ir = fir.get_ir(channels);
        let conv = FFTConvolver::new(&ir, channels);
        
        drop(fir_guard);
        
        *self.fir_convolver.lock() = Some(conv);
        log::info!("FIR EQ phase mode set to: {:?}", mode);
        Ok(())
    }
    
    /// Reset FIR convolver state (call when seeking or changing tracks)
    pub fn reset_fir_convolver(&self) {
        if let Some(mut guard) = self.fir_convolver.try_lock() {
            if let Some(ref mut conv) = *guard {
                conv.reset();
            }
        }
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