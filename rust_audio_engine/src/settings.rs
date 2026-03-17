//! Audio Engine Settings Persistence
//!
//! Handles saving and loading user preferences to a JSON file.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use parking_lot::Mutex;

/// Persistent settings that are saved between sessions
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistentSettings {
    // Volume
    pub volume: f32,
    
    // Device settings
    pub device_id: Option<usize>,
    pub exclusive_mode: bool,
    
    // EQ settings
    pub eq_type: String,
    pub eq_bands: Option<std::collections::HashMap<String, f64>>,
    pub fir_taps: Option<usize>,
    
    // Dither / Noise Shaper
    pub dither_enabled: bool,
    pub output_bits: u32,
    pub noise_shaper_curve: String,
    
    // Loudness normalization
    pub loudness_enabled: bool,
    pub loudness_mode: String,
    pub target_lufs: f64,
    pub preamp_db: f64,
    
    // Saturation
    pub saturation_enabled: bool,
    pub saturation_drive: f64,
    pub saturation_mix: f64,
    
    // Crossfeed
    pub crossfeed_enabled: bool,
    pub crossfeed_mix: f64,
    
    // Dynamic Loudness
    pub dynamic_loudness_enabled: bool,
    pub dynamic_loudness_strength: f64,
    
    // Resampling
    pub target_samplerate: Option<u32>,
    pub resample_quality: String,
    pub use_cache: bool,
    pub preemptive_resample: bool,
}

impl Default for PersistentSettings {
    fn default() -> Self {
        Self {
            volume: 0.7,
            device_id: None,
            exclusive_mode: false,
            eq_type: "IIR".to_string(),
            eq_bands: None,
            fir_taps: Some(1023),
            dither_enabled: true,
            output_bits: 24,
            noise_shaper_curve: "Lipshitz5".to_string(),
            loudness_enabled: true,
            loudness_mode: "track".to_string(),
            target_lufs: -12.0,
            preamp_db: 0.0,
            saturation_enabled: true,
            saturation_drive: 0.25,
            saturation_mix: 0.2,
            crossfeed_enabled: false,
            crossfeed_mix: 0.3,
            dynamic_loudness_enabled: false,
            dynamic_loudness_strength: 1.0,
            target_samplerate: None,
            resample_quality: "hq".to_string(),
            use_cache: false,
            preemptive_resample: true,
        }
    }
}

/// Settings manager that handles persistence
pub struct SettingsManager {
    settings: PersistentSettings,
    file_path: PathBuf,
}

impl SettingsManager {
    /// Create a new settings manager with the given file path
    pub fn new(file_path: PathBuf) -> Self {
        let settings = Self::load_from_file(&file_path).unwrap_or_else(|e| {
            log::info!("Using default settings: {}", e);
            PersistentSettings::default()
        });
        
        Self { settings, file_path }
    }
    
    /// Load settings from file
    fn load_from_file(path: &PathBuf) -> Result<PersistentSettings, String> {
        if !path.exists() {
            return Err("Settings file not found".to_string());
        }
        
        let content = fs::read_to_string(path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        
        let settings: PersistentSettings = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse settings: {}", e))?;
        
        log::info!("Loaded settings from {}", path.display());
        Ok(settings)
    }
    
    /// Save settings to file
    pub fn save(&self) -> Result<(), String> {
        // Ensure parent directory exists
        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create settings directory: {}", e))?;
        }
        
        let content = serde_json::to_string_pretty(&self.settings)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;
        
        fs::write(&self.file_path, content)
            .map_err(|e| format!("Failed to write settings: {}", e))?;
        
        log::debug!("Saved settings to {}", self.file_path.display());
        Ok(())
    }
    
    /// Get current settings
    pub fn get(&self) -> &PersistentSettings {
        &self.settings
    }
    
    /// Update settings and save to file
    pub fn update(&mut self, update: PersistentSettingsUpdate) -> Result<(), String> {
        if let Some(volume) = update.volume {
            self.settings.volume = volume;
        }
        if let Some(device_id) = update.device_id {
            self.settings.device_id = device_id;
        }
        if let Some(exclusive_mode) = update.exclusive_mode {
            self.settings.exclusive_mode = exclusive_mode;
        }
        if let Some(ref eq_type) = update.eq_type {
            self.settings.eq_type = eq_type.clone();
        }
        if let Some(ref eq_bands) = update.eq_bands {
            self.settings.eq_bands = Some(eq_bands.clone());
        }
        if let Some(fir_taps) = update.fir_taps {
            self.settings.fir_taps = Some(fir_taps);
        }
        if let Some(dither_enabled) = update.dither_enabled {
            self.settings.dither_enabled = dither_enabled;
        }
        if let Some(output_bits) = update.output_bits {
            self.settings.output_bits = output_bits;
        }
        if let Some(ref curve) = update.noise_shaper_curve {
            self.settings.noise_shaper_curve = curve.clone();
        }
        if let Some(loudness_enabled) = update.loudness_enabled {
            self.settings.loudness_enabled = loudness_enabled;
        }
        if let Some(ref mode) = update.loudness_mode {
            self.settings.loudness_mode = mode.clone();
        }
        if let Some(target_lufs) = update.target_lufs {
            self.settings.target_lufs = target_lufs;
        }
        if let Some(preamp_db) = update.preamp_db {
            self.settings.preamp_db = preamp_db;
        }
        if let Some(saturation_enabled) = update.saturation_enabled {
            self.settings.saturation_enabled = saturation_enabled;
        }
        if let Some(saturation_drive) = update.saturation_drive {
            self.settings.saturation_drive = saturation_drive;
        }
        if let Some(saturation_mix) = update.saturation_mix {
            self.settings.saturation_mix = saturation_mix;
        }
        if let Some(crossfeed_enabled) = update.crossfeed_enabled {
            self.settings.crossfeed_enabled = crossfeed_enabled;
        }
        if let Some(crossfeed_mix) = update.crossfeed_mix {
            self.settings.crossfeed_mix = crossfeed_mix;
        }
        if let Some(dynamic_loudness_enabled) = update.dynamic_loudness_enabled {
            self.settings.dynamic_loudness_enabled = dynamic_loudness_enabled;
        }
        if let Some(dynamic_loudness_strength) = update.dynamic_loudness_strength {
            self.settings.dynamic_loudness_strength = dynamic_loudness_strength;
        }
        if let Some(target_samplerate) = update.target_samplerate {
            self.settings.target_samplerate = target_samplerate;
        }
        if let Some(ref quality) = update.resample_quality {
            self.settings.resample_quality = quality.clone();
        }
        if let Some(use_cache) = update.use_cache {
            self.settings.use_cache = use_cache;
        }
        if let Some(preemptive_resample) = update.preemptive_resample {
            self.settings.preemptive_resample = preemptive_resample;
        }
        
        self.save()
    }
    
    /// Get current settings
    pub fn get_settings(&self) -> PersistentSettings {
        self.settings.clone()
    }
}

/// Partial update for settings (all fields optional)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PersistentSettingsUpdate {
    pub volume: Option<f32>,
    pub device_id: Option<Option<usize>>,
    pub exclusive_mode: Option<bool>,
    pub eq_type: Option<String>,
    pub eq_bands: Option<std::collections::HashMap<String, f64>>,
    pub fir_taps: Option<usize>,
    pub dither_enabled: Option<bool>,
    pub output_bits: Option<u32>,
    pub noise_shaper_curve: Option<String>,
    pub loudness_enabled: Option<bool>,
    pub loudness_mode: Option<String>,
    pub target_lufs: Option<f64>,
    pub preamp_db: Option<f64>,
    pub saturation_enabled: Option<bool>,
    pub saturation_drive: Option<f64>,
    pub saturation_mix: Option<f64>,
    pub crossfeed_enabled: Option<bool>,
    pub crossfeed_mix: Option<f64>,
    pub dynamic_loudness_enabled: Option<bool>,
    pub dynamic_loudness_strength: Option<f64>,
    pub target_samplerate: Option<Option<u32>>,
    pub resample_quality: Option<String>,
    pub use_cache: Option<bool>,
    pub preemptive_resample: Option<bool>,
}

/// Thread-safe settings manager wrapper
pub type SharedSettingsManager = Arc<Mutex<SettingsManager>>;

/// Create a shared settings manager
pub fn create_settings_manager(app_data_dir: &PathBuf) -> SharedSettingsManager {
    let settings_path = app_data_dir.join("audio_settings.json");
    Arc::new(Mutex::new(SettingsManager::new(settings_path)))
}
