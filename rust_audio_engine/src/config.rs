use std::env;
use std::path::PathBuf;

// M-4 fix: Import SaturationType from processor module (single source of truth).
// Previously defined identically in both config.rs and saturation.rs.
pub use crate::processor::SaturationType;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ResampleQuality {
    Low,
    Standard,
    High,
    UltraHigh,
}

/// Phase response for resampling filter
/// - Minimum: Lowest latency, some pre-echo reduction (value = 0)
/// - Linear: Default, symmetric impulse response (value = 50)  
/// - Maximum: Maximum phase linearization (value = 100)
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum PhaseResponse {
    #[default]
    Linear,     // 50 - default, symmetric
    Minimum,    // 0 - lowest latency
    Maximum,    // 100 - maximum phase linearization
}

impl PhaseResponse {
    /// Convert to soxr phase_response value
    pub fn to_soxr_value(&self) -> f64 {
        match self {
            PhaseResponse::Minimum => 0.0,
            PhaseResponse::Linear => 50.0,
            PhaseResponse::Maximum => 100.0,
        }
    }
}

/// Loudness normalization mode
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum NormalizationMode {
    #[default]
    Track,          // Track-based: analyze whole track on load (EBU R128)
    Album,          // Album mode: preserve relative loudness within album
    Streaming,      // Streaming: real-time adaptive adjustment
    ReplayGainTrack, // Use ReplayGain track gain from tags
    ReplayGainAlbum, // Use ReplayGain album gain from tags (fallback to track)
}

/// Loudness normalization configuration
#[derive(Debug, Clone)]
pub struct LoudnessConfig {
    /// Target loudness in LUFS
    /// - -23 LUFS: EBU R128 broadcast standard
    /// - -14 LUFS: Spotify/YouTube streaming standard  
    /// - -16 LUFS: Apple Music/Amazon standard
    pub target_lufs: f64,
    
    /// True peak limit in dBTP (default: -1.0)
    pub true_peak_limit_db: f64,
    
    /// Gain smoothing time in milliseconds (default: 100-500ms)
    pub smoothing_time_ms: f64,
    
    /// Normalization mode
    pub mode: NormalizationMode,
    
    /// Enable loudness normalization
    pub enabled: bool,

    /// ReplayGain reference loudness in LUFS
    /// - -18 LUFS: ReplayGain 2.0 reference
    /// - -14 LUFS: common legacy ReplayGain 1.0 tagging practice
    pub replaygain_reference_lufs: f64,
}

impl Default for LoudnessConfig {
    fn default() -> Self {
        Self {
            target_lufs: -12.0,  // Closer to domestic streaming platforms
            true_peak_limit_db: -0.5,  // Safer headroom while preserving transients
            smoothing_time_ms: 200.0,
            mode: NormalizationMode::Track,
            enabled: true,
            replaygain_reference_lufs: -18.0,
        }
    }
}

// M-4 fix: SaturationType is now imported from processor::saturation (single definition).
// The duplicate definition that was here has been removed.

/// Saturation configuration for analog warmth
#[derive(Debug, Clone)]
pub struct SaturationConfig {
    /// Saturation type (Tape, Tube, Transistor)
    pub sat_type: SaturationType,
    /// Drive amount (0.0 - 2.0)
    pub drive: f64,
    /// Threshold where saturation begins (0.0 - 1.0)
    pub threshold: f64,
    /// Mix between dry and wet (0.0 - 1.0)
    pub mix: f64,
    /// Input gain applied before saturation (dB)
    pub input_gain_db: f64,
    /// Output gain compensation applied after saturation (dB)
    pub output_gain_db: f64,
    /// Enable/disable saturation
    pub enabled: bool,
}

impl Default for SaturationConfig {
    fn default() -> Self {
        Self {
            sat_type: SaturationType::Tube,
            drive: 0.25,        // Lower drive for subtle warmth
            threshold: 0.88,    // Higher threshold, only affect loud transients
            mix: 0.2,           // Lower mix for transparent effect
            input_gain_db: 0.0,
            output_gain_db: 0.0,
            enabled: true,      // Enabled by default for analog warmth
        }
    }
}

/// Dynamic Loudness Compensation configuration
/// Based on ISO 226:2003 Equal-Loudness Contours (Fletcher-Munson effect)
#[derive(Debug, Clone)]
pub struct DynamicLoudnessConfig {
    /// Reference volume level in dB (above this, no compensation)
    /// Typical values: -15 dB (50% perceived loudness) to -20 dB
    pub ref_volume_db: f64,
    
    /// Transition range in dB (compensation range from ref to max)
    /// At ref_volume - transition_db, compensation is at maximum
    /// Typical: 25 dB (e.g., -15 to -40 dB)
    pub transition_db: f64,
    
    /// Strength multiplier (0.0 - 1.0)
    /// 0.0 = disabled, 1.0 = full compensation
    pub strength: f64,
    
    /// Pre-gain in dB to prevent clipping from bass boost
    /// Default: -3 dB headroom
    pub pre_gain_db: f64,
    
    /// Enable/disable dynamic loudness compensation
    pub enabled: bool,
}

impl Default for DynamicLoudnessConfig {
    fn default() -> Self {
        Self {
            ref_volume_db: -15.0,   // ~50% perceived loudness
            transition_db: 25.0,    // Full compensation at -40 dB
            strength: 1.0,          // Full strength by default
            pre_gain_db: -3.0,      // Headroom for bass boost
            enabled: true,          // Enabled by default
        }
    }
}

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub target_samplerate: Option<u32>,
    pub resample_quality: ResampleQuality,
    pub phase_response: PhaseResponse,
    pub use_cache: bool,
    pub preemptive_resample: bool,
    pub cache_dir: Option<PathBuf>,
    pub eq_type: String,
    pub loudness: LoudnessConfig,
    pub dynamic_loudness: DynamicLoudnessConfig,
    pub saturation: SaturationConfig,
    /// Output bit depth for noise shaper (M-1 fix: was hardcoded to 24)
    pub output_bits: Option<u32>,
}

impl Default for ResampleQuality {
    fn default() -> Self {
        Self::High
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            target_samplerate: None,
            resample_quality: ResampleQuality::default(),
            phase_response: PhaseResponse::default(),
            use_cache: false,
            preemptive_resample: true,
            cache_dir: None,
            eq_type: "IIR".to_string(),
            loudness: LoudnessConfig::default(),
            dynamic_loudness: DynamicLoudnessConfig::default(),
            saturation: SaturationConfig::default(),
            output_bits: None,  // Will default to 24 if not set
        }
    }
}

impl AppConfig {
    pub fn load() -> Self {
        // Load .env file if it exists
        dotenv::dotenv().ok();
        
        let target_samplerate = env::var("VCP_AUDIO_TARGET_SAMPLERATE")
            .ok()
            .and_then(|s| s.parse().ok());
            
        let resample_quality = match env::var("VCP_AUDIO_RESAMPLE_QUALITY").unwrap_or_default().as_str() {
            "low" => ResampleQuality::Low,
            "std" => ResampleQuality::Standard,
            "uhq" => ResampleQuality::UltraHigh,
            _ => ResampleQuality::High, // Default to High (hq)
        };
        
        let use_cache = env::var("VCP_AUDIO_USE_CACHE")
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(false);
            
        let preemptive_resample = env::var("VCP_AUDIO_PREEMPTIVE_RESAMPLE")
            .map(|s| s.to_lowercase() == "true")
            .unwrap_or(true); 
            
        let cache_dir = env::var("VCP_AUDIO_CACHE_DIR")
            .ok()
            .map(PathBuf::from);
            
        let eq_type = env::var("VCP_AUDIO_EQ_TYPE").unwrap_or_else(|_| "IIR".to_string());
        
        // Load loudness configuration with range validation (FIX for Defect 29)
        let loudness = LoudnessConfig {
            // target_lufs: typical range -30 to -6 LUFS (EBU R128: -23, streaming: -14 to -16)
            target_lufs: env::var("VCP_AUDIO_TARGET_LUFS")
                .ok()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(-12.0)
                .clamp(-30.0, -6.0),
            // true_peak_limit_db: must be <= 0 to prevent clipping, >= -3 for reasonable headroom
            true_peak_limit_db: env::var("VCP_AUDIO_TRUE_PEAK_LIMIT")
                .ok()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(-0.5)
                .clamp(-3.0, 0.0),
            // smoothing_time_ms: minimum 10ms to avoid audio artifacts, max 2000ms
            smoothing_time_ms: env::var("VCP_AUDIO_LOUDNESS_SMOOTHING_MS")
                .ok()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(200.0)
                .clamp(10.0, 2000.0),
            mode: match env::var("VCP_AUDIO_NORMALIZATION_MODE").unwrap_or_default().to_lowercase().as_str() {
                "album" => NormalizationMode::Album,
                "streaming" => NormalizationMode::Streaming,
                "replaygain_track" | "rg_track" => NormalizationMode::ReplayGainTrack,
                "replaygain_album" | "rg_album" => NormalizationMode::ReplayGainAlbum,
                _ => NormalizationMode::Track,
            },
            enabled: env::var("VCP_AUDIO_LOUDNESS_NORMALIZATION")
                .map(|s| s.to_lowercase() == "true")
                .unwrap_or(true),
            replaygain_reference_lufs: env::var("VCP_AUDIO_REPLAYGAIN_REFERENCE_LUFS")
                .ok()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(-18.0)
                .clamp(-23.0, -12.0),
        };
        
        // Load phase response setting
        let phase_response = match env::var("VCP_AUDIO_PHASE_RESPONSE").unwrap_or_default().to_lowercase().as_str() {
            "minimum" | "min" => PhaseResponse::Minimum,
            "maximum" | "max" => PhaseResponse::Maximum,
            _ => PhaseResponse::Linear, // Default
        };
        
        // Load saturation configuration with range validation (FIX for Defect 29)
        let saturation = SaturationConfig {
            sat_type: match env::var("VCP_AUDIO_SATURATION_TYPE").unwrap_or_default().to_lowercase().as_str() {
                "tape" => SaturationType::Tape,
                "transistor" => SaturationType::Transistor,
                _ => SaturationType::Tube,  // Default
            },
            // drive: 0.0 (no saturation) to 2.0 (heavy saturation)
            drive: env::var("VCP_AUDIO_SATURATION_DRIVE")
                .ok()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.25)
                .clamp(0.0, 2.0),
            // threshold: 0.0 to 1.0 (normalized signal level)
            threshold: env::var("VCP_AUDIO_SATURATION_THRESHOLD")
                .ok()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.88)
                .clamp(0.0, 1.0),
            // mix: 0.0 (dry) to 1.0 (wet)
            mix: env::var("VCP_AUDIO_SATURATION_MIX")
                .ok()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.2)
                .clamp(0.0, 1.0),
            // input_gain_db: -20 to +20 dB
            input_gain_db: env::var("VCP_AUDIO_SATURATION_INPUT_GAIN")
                .ok()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0)
                .clamp(-20.0, 20.0),
            // output_gain_db: -20 to +20 dB
            output_gain_db: env::var("VCP_AUDIO_SATURATION_OUTPUT_GAIN")
                .ok()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0)
                .clamp(-20.0, 20.0),
            enabled: env::var("VCP_AUDIO_SATURATION_ENABLED")
                .map(|s| s.to_lowercase() == "true")
                .unwrap_or(true),      // Enabled by default
        };
        
        // Load dynamic loudness compensation configuration
        let dynamic_loudness = DynamicLoudnessConfig {
            // ref_volume_db: -30 to 0 dB (typical: -15 to -20)
            ref_volume_db: env::var("VCP_AUDIO_DYNAMIC_LOUDNESS_REF_DB")
                .ok()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(-15.0)
                .clamp(-30.0, 0.0),
            // transition_db: 10 to 40 dB (compensation range)
            transition_db: env::var("VCP_AUDIO_DYNAMIC_LOUDNESS_TRANSITION_DB")
                .ok()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(25.0)
                .clamp(10.0, 40.0),
            // strength: 0.0 to 1.0
            strength: env::var("VCP_AUDIO_DYNAMIC_LOUDNESS_STRENGTH")
                .ok()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(1.0)
                .clamp(0.0, 1.0),
            // pre_gain_db: -6 to 0 dB (headroom for bass boost)
            pre_gain_db: env::var("VCP_AUDIO_DYNAMIC_LOUDNESS_PRE_GAIN_DB")
                .ok()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(-3.0)
                .clamp(-6.0, 0.0),
            enabled: env::var("VCP_AUDIO_DYNAMIC_LOUDNESS_ENABLED")
                .map(|s| s.to_lowercase() == "true")
                .unwrap_or(true),  // Enabled by default
        };
        
        // Load output bit depth for noise shaper (M-1 fix)
        let output_bits = env::var("VCP_AUDIO_OUTPUT_BITS")
            .ok()
            .and_then(|s| s.parse::<u32>().ok())
            .map(|b| b.clamp(8, 32));

        log::info!("Loaded config: Quality={:?}, Phase={:?}, Cache={}, Preemptive={}, EQ={}, Loudness={} LUFS, DynamicLoudness={} (ref={}dB), Saturation={}",
            resample_quality, phase_response, use_cache, preemptive_resample, eq_type, loudness.target_lufs,
            dynamic_loudness.enabled, dynamic_loudness.ref_volume_db, saturation.enabled);

        Self {
            target_samplerate,
            resample_quality,
            phase_response,
            use_cache,
            preemptive_resample,
            cache_dir,
            eq_type,
            loudness,
            dynamic_loudness,
            saturation,
            output_bits,
        }
    }
}
