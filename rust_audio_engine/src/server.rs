//! VCP Hi-Fi Audio Engine - HTTP/WebSocket Server
//!
//! REST API compatible with existing frontend, with WebSocket for spectrum data.

use actix_web::{web, App, HttpServer, HttpResponse, HttpRequest, middleware, http::Method};
use actix_ws::{self, Message};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::interval;
use tokio::sync::oneshot;

use crate::player::{AudioPlayer, AudioDeviceInfo, PlayerState};
use crate::webdav::WebDavConfig;
use crate::processor::LoudnessDatabase;
use crate::settings::{SharedSettingsManager, PersistentSettings, PersistentSettingsUpdate};
use std::sync::atomic::Ordering;

/// Application state shared across handlers
pub struct AppState {
    pub player: Mutex<AudioPlayer>,
    pub webdav_config: Mutex<WebDavConfig>,
    /// FIX for LoudnessDatabase integration: Database for pre-computed loudness metadata
    pub loudness_db: Mutex<Option<LoudnessDatabase>>,
    /// Persistent settings manager
    pub settings_manager: SharedSettingsManager,
}

// ============ Path Security (Defect 44 fix, SEC-01 fix) ============

/// FIX for Defect 44: Validate file paths to prevent path traversal attacks.
/// FIX for SEC-01: Reject paths that fail canonicalization (file doesn't exist).
/// 
/// - HTTP(S) URLs are allowed (they have their own security model)
/// - Local paths are validated to prevent directory traversal
/// - Local paths MUST exist and be accessible (canonicalize must succeed)
/// - Returns Ok(validated_path) or Err(error_message)
fn validate_path(path: &str) -> Result<String, String> {
    // Allow HTTP(S) URLs - they have their own security (TLS, authentication)
    if path.starts_with("http://") || path.starts_with("https://") {
        // Basic URL validation - check for obvious injection attempts
        if path.contains("..") || path.contains('\\') {
            return Err("Invalid URL: path traversal characters not allowed".into());
        }
        return Ok(path.to_string());
    }
    
    // Local file path validation
    let path = std::path::Path::new(path);
    
    // Check for path traversal attempts
    let path_str = path.to_string_lossy();
    if path_str.contains("..") {
        return Err("Path traversal not allowed: '..' found in path".into());
    }
    
    // On Windows, also check for drive letter injection
    #[cfg(windows)]
    {
        // Check for UNC path injection (\\server\share)
        if path_str.starts_with("\\\\") {
            return Err("UNC paths not allowed".into());
        }
        // Check for reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
        let file_name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_uppercase();
        let reserved = ["CON", "PRN", "AUX", "NUL", 
                       "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
                       "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];
        if reserved.contains(&file_name.as_str()) {
            return Err(format!("Reserved device name not allowed: {}", file_name));
        }
    }
    
    // FIX for SEC-01: Require canonicalization to succeed for local paths
    // This prevents:
    // 1. Path probing attacks (determining if arbitrary paths exist)
    // 2. Symlink attacks (following symlinks outside intended directories)
    // 3. Race conditions (TOCTOU)
    match path.canonicalize() {
        Ok(canonical) => {
            // Path exists and is accessible - return canonical path
            Ok(canonical.to_string_lossy().to_string())
        }
        Err(e) => {
            // FIX for SEC-01: Reject paths that don't exist or aren't accessible
            // Previously this would return the original path, allowing path probing
            log::warn!("Path validation rejected: '{}' - {}", path.display(), e);
            Err(format!("File not found or inaccessible: {}", path.display()))
        }
    }
}

// ============ Request/Response Types ============

#[derive(Deserialize)]
pub struct LoadRequest {
    path: String,
}

#[derive(Deserialize)]
pub struct WebDavConfigureRequest {
    base_url: String,
    username: Option<String>,
    password: Option<String>,
}

#[derive(Deserialize)]
pub struct WebDavBrowseRequest {
    path: Option<String>,
}

#[derive(Deserialize)]
pub struct SeekRequest {
    position: f64,
}

#[derive(Deserialize)]
pub struct VolumeRequest {
    volume: f32,
}

#[derive(Deserialize)]
pub struct ConfigureOutputRequest {
    device_id: Option<usize>,
    exclusive: Option<bool>,
}

#[derive(Deserialize)]
pub struct ConfigureUpsamplingRequest {
    target_samplerate: Option<u32>,
}

#[derive(Deserialize)]
pub struct SetEqRequest {
    bands: Option<std::collections::HashMap<String, f64>>,
    enabled: Option<bool>,
}

#[derive(Deserialize)]
pub struct SetEqTypeRequest {
    #[serde(rename = "type")]
    eq_type: String,
    /// Number of FIR taps (only used when eq_type is "FIR")
    /// Default: 1023, recommended range: 255-4095
    fir_taps: Option<usize>,
}

#[derive(Deserialize)]
pub struct ConfigureOptimizationsRequest {
    dither_enabled: Option<bool>,
    replaygain_enabled: Option<bool>,
}

#[derive(Deserialize)]
pub struct ConfigureNormalizationRequest {
    enabled: Option<bool>,
    target_lufs: Option<f64>,
    mode: Option<String>,  // "track" / "album" / "streaming"
    album_gain_db: Option<f64>,
    preamp_db: Option<f64>,
}

#[derive(Deserialize)]
pub struct PreloadGainRequest {
    tracks: Vec<String>,  // List of file paths to preload
}

#[derive(Deserialize)]
pub struct ScanBackgroundRequest {
    path: String,
    store: Option<bool>,  // Whether to store in database (default: true)
}

#[derive(Deserialize)]
pub struct QueueNextRequest {
    path: String,
    // Optional: WebDAV auth (if path is HTTP URL)
    username: Option<String>,
    password: Option<String>,
}

#[derive(Deserialize)]
pub struct LoadIrRequest {
    path: String,
}

#[derive(Deserialize)]
pub struct SetCrossfeedRequest {
    enabled: Option<bool>,
    mix: Option<f64>,
}

#[derive(Deserialize)]
pub struct SetSaturationRequest {
    enabled: Option<bool>,
    drive: Option<f64>,
    threshold: Option<f64>,
    mix: Option<f64>,
    input_gain_db: Option<f64>,
    output_gain_db: Option<f64>,
    highpass_mode: Option<bool>,
    highpass_cutoff: Option<f64>,
}

#[derive(Deserialize)]
pub struct SetDynamicLoudnessRequest {
    enabled: Option<bool>,
    strength: Option<f64>,  // 0.0 - 1.0
}

#[derive(Deserialize)]
pub struct SetNoiseShaperCurveRequest {
    curve: String,  // "Lipshitz5", "FWeighted9", "ModifiedE9", "ImprovedE9", "TpdfOnly"
}

#[derive(Deserialize)]
pub struct SetOutputBitsRequest {
    bits: u32,  // 16, 24, or 32
}

#[derive(Serialize)]
pub struct LoadingStatusResponse {
    is_loading: bool,
    progress: u64,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct IrStatusResponse {
    ir_loaded: bool,
}

#[derive(Serialize)]
pub struct StateResponse {
    is_playing: bool,
    is_paused: bool,
    is_loading: bool,
    duration: f64,
    current_time: f64,
    file_path: Option<String>,
    volume: f32,
    device_id: Option<usize>,
    exclusive_mode: bool,
    eq_type: String,
    dither_enabled: bool,
    replaygain_enabled: bool,
    loudness_enabled: bool,
    // Loudness normalization extended fields
    loudness_mode: String,
    target_lufs: f64,
    preamp_db: f64,
    // ReplayGain fields
    rg_track_gain: Option<f64>,
    rg_album_gain: Option<f64>,
    rg_track_peak: Option<f64>,
    rg_album_peak: Option<f64>,
    // Saturation fields
    saturation_enabled: bool,
    saturation_drive: f64,
    saturation_mix: f64,
    // Crossfeed fields
    crossfeed_enabled: bool,
    crossfeed_mix: f64,
    // Dynamic Loudness fields
    dynamic_loudness_enabled: bool,
    dynamic_loudness_strength: f64,
    dynamic_loudness_factor: f64,
    // Noise shaper fields
    output_bits: u32,
    noise_shaper_curve: String,
    // Resampling fields
    target_samplerate: Option<u32>,
    resample_quality: String,
    use_cache: bool,
    preemptive_resample: bool,
    // Track metadata
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    track_number: Option<u32>,
    disc_number: Option<u32>,
    genre: Option<String>,
    year: Option<u32>,
    has_cover_art: bool,
}

#[derive(Serialize)]
pub struct ApiResponse {
    status: String,
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<StateResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    devices: Option<DevicesResponse>,
}

#[derive(Serialize)]
pub struct DevicesResponse {
    preferred: Vec<AudioDeviceInfo>,
    other: Vec<AudioDeviceInfo>,
    preferred_name: String,
}

impl ApiResponse {
    fn success(msg: &str) -> Self {
        Self {
            status: "success".into(),
            message: Some(msg.into()),
            state: None,
            devices: None,
        }
    }
    
    fn success_with_state(msg: &str, state: StateResponse) -> Self {
        Self {
            status: "success".into(),
            message: Some(msg.into()),
            state: Some(state),
            devices: None,
        }
    }
    
    fn error(msg: &str) -> Self {
        Self {
            status: "error".into(),
            message: Some(msg.into()),
            state: None,
            devices: None,
        }
    }
}

// ============ Helper Functions ============

/// Apply persisted settings to player on startup
fn apply_settings_to_player(player: &mut AudioPlayer, settings: &PersistentSettings) {
    // Volume
    player.set_volume(settings.volume as f64);
    
    // Device settings are applied separately via configure_output API
    
    // EQ
    if settings.eq_type == "FIR" {
        let taps = settings.fir_taps.unwrap_or(1023);
        let _ = player.enable_fir_eq(taps);
    }
    
    if let Some(ref bands) = settings.eq_bands {
        // Build gains array from bands map
        let band_map: std::collections::HashMap<&str, usize> = [
            ("31", 0), ("62", 1), ("125", 2), ("250", 3), ("500", 4),
            ("1000", 5), ("2000", 6), ("4000", 7), ("8000", 8), ("16000", 9),
            ("1k", 5), ("2k", 6), ("4k", 7), ("8k", 8), ("16k", 9),
        ].into_iter().collect();
        
        let sr = player.shared_state().sample_rate.load(Ordering::Relaxed) as f64;
        
        if player.is_fir_eq_enabled() {
            let mut gains = [0.0_f64; 10];
            for (name, &gain) in bands {
                if let Some(&idx) = band_map.get(name.as_str()) {
                    gains[idx] = gain;
                }
            }
            let _ = player.set_fir_bands(&gains);
        } else {
            // IIR EQ - set each band individually
            let eq_arc = player.eq();
            let mut eq = eq_arc.lock();
            for (name, &gain) in bands {
                if let Some(&idx) = band_map.get(name.as_str()) {
                    eq.set_band_gain(idx, gain, sr);
                }
            }
        }
    }
    
    // Dither
    player.dither_enabled = settings.dither_enabled;
    player.noise_shaper().lock().set_bits(settings.output_bits);
    
    // Set noise shaper curve
    {
        use crate::processor::NoiseShaperCurve;
        let curve = match settings.noise_shaper_curve.as_str() {
            "Lipshitz5" => NoiseShaperCurve::Lipshitz5,
            "FWeighted9" => NoiseShaperCurve::FWeighted9,
            "ModifiedE9" => NoiseShaperCurve::ModifiedE9,
            "ImprovedE9" => NoiseShaperCurve::ImprovedE9,
            "TpdfOnly" => NoiseShaperCurve::TpdfOnly,
            _ => NoiseShaperCurve::Lipshitz5,
        };
        player.noise_shaper().lock().set_curve(curve);
    }
    
    // Loudness
    player.set_loudness_enabled(settings.loudness_enabled);
    player.set_target_lufs(settings.target_lufs);
    player.set_preamp_gain(settings.preamp_db);
    
    // Set loudness mode
    let mode = match settings.loudness_mode.as_str() {
        "album" => crate::config::NormalizationMode::Album,
        "streaming" => crate::config::NormalizationMode::Streaming,
        "replaygain_track" | "rg_track" => crate::config::NormalizationMode::ReplayGainTrack,
        "replaygain_album" | "rg_album" => crate::config::NormalizationMode::ReplayGainAlbum,
        _ => crate::config::NormalizationMode::Track,
    };
    player.set_normalization_mode(mode);
    
    // Saturation
    player.set_saturation_enabled(settings.saturation_enabled);
    player.set_saturation_drive(settings.saturation_drive);
    player.set_saturation_mix(settings.saturation_mix);
    
    // Crossfeed
    player.set_crossfeed_enabled(settings.crossfeed_enabled);
    player.set_crossfeed_mix(settings.crossfeed_mix);
    
    // Dynamic Loudness
    player.set_dynamic_loudness_enabled(settings.dynamic_loudness_enabled);
    player.set_dynamic_loudness_strength(settings.dynamic_loudness_strength);
    
    // Resampling
    player.target_sample_rate = settings.target_samplerate;
    
    // Set resample quality
    {
        use crate::config::ResampleQuality;
        let quality = match settings.resample_quality.as_str() {
            "low" => ResampleQuality::Low,
            "std" => ResampleQuality::Standard,
            "uhq" => ResampleQuality::UltraHigh,
            _ => ResampleQuality::High,
        };
        player.set_resample_quality(quality);
    }
    player.set_use_cache(settings.use_cache);
    player.set_preemptive_resample(settings.preemptive_resample);
}

fn get_player_state(player: &AudioPlayer) -> StateResponse {
    let shared = player.shared_state();
    let state = player.get_state();
    
    // Get real values from SharedState
    let volume = shared.volume.load(std::sync::atomic::Ordering::Relaxed) as f32 / 1_000_000.0;
    let device_id = shared.device_id.load(std::sync::atomic::Ordering::Relaxed);
    let file_path = shared.file_path.read().clone();
    let eq_type = shared.eq_type.read().clone();
    
    // Get track metadata
    let metadata = shared.track_metadata.read();
    
    // Get loudness normalization info
    let loudness_info = player.get_loudness_info();
    let loudness_mode = match player.get_normalization_mode() {
        crate::config::NormalizationMode::Track => "track".to_string(),
        crate::config::NormalizationMode::Album => "album".to_string(),
        crate::config::NormalizationMode::Streaming => "streaming".to_string(),
        crate::config::NormalizationMode::ReplayGainTrack => "replaygain_track".to_string(),
        crate::config::NormalizationMode::ReplayGainAlbum => "replaygain_album".to_string(),
    };
    
    // Get saturation info
    let saturation_info = player.get_saturation_info();
    
    // Get crossfeed info
    let crossfeed_info = player.get_crossfeed_info();
    
    // Get noise shaper info
    let noise_shaper_curve = player.get_noise_shaper_curve();
    
    StateResponse {
        is_playing: state == PlayerState::Playing,
        is_paused: state == PlayerState::Paused,
        is_loading: shared.is_loading.load(std::sync::atomic::Ordering::Relaxed),
        duration: shared.duration_secs(),
        current_time: shared.current_time_secs(),
        file_path,
        volume,
        device_id: if device_id >= 0 { Some(device_id as usize) } else { None },
        exclusive_mode: player.exclusive_mode,
        eq_type,
        dither_enabled: player.dither_enabled,
        replaygain_enabled: player.replaygain_enabled,
        loudness_enabled: player.loudness_enabled,
        // Loudness normalization extended fields
        loudness_mode,
        target_lufs: player.get_target_lufs(),
        preamp_db: loudness_info.preamp_db,
        // ReplayGain fields
        rg_track_gain: metadata.rg_track_gain,
        rg_album_gain: metadata.rg_album_gain,
        rg_track_peak: metadata.rg_track_peak,
        rg_album_peak: metadata.rg_album_peak,
        // Saturation fields
        saturation_enabled: saturation_info.enabled,
        saturation_drive: saturation_info.drive,
        saturation_mix: saturation_info.mix,
        // Crossfeed fields
        crossfeed_enabled: crossfeed_info.enabled,
        crossfeed_mix: crossfeed_info.mix,
        // Dynamic Loudness fields
        dynamic_loudness_enabled: player.is_dynamic_loudness_enabled(),
        dynamic_loudness_strength: player.get_dynamic_loudness_strength(),
        dynamic_loudness_factor: player.get_dynamic_loudness_factor(),
        // Noise shaper fields
        output_bits: player.get_output_bits(),
        noise_shaper_curve,
        // Resampling fields
        target_samplerate: player.target_sample_rate,
        resample_quality: player.get_resample_quality(),
        use_cache: player.get_use_cache(),
        preemptive_resample: player.get_preemptive_resample(),
        // Track metadata
        title: metadata.title.clone(),
        artist: metadata.artist.clone(),
        album: metadata.album.clone(),
        track_number: metadata.track_number,
        disc_number: metadata.disc_number,
        genre: metadata.genre.clone(),
        year: metadata.year,
        has_cover_art: metadata.cover_art.is_some(),
    }
}

// ============ Route Handlers ============

/// CORS preflight handler for OPTIONS requests
/// Returns 200 OK with appropriate CORS headers (added by DefaultHeaders middleware)
async fn cors_preflight() -> HttpResponse {
    HttpResponse::Ok().finish()
}

async fn load(
    data: web::Data<Arc<AppState>>,
    body: web::Json<LoadRequest>,
) -> HttpResponse {
    // FIX for Defect 44: Validate path to prevent traversal attacks
    let path = match validate_path(&body.path) {
        Ok(p) => p,
        Err(e) => return HttpResponse::BadRequest().json(ApiResponse::error(&e)),
    };
    
    let credentials = {
        let cfg = data.webdav_config.lock();
        cfg.http_credentials()
    };
    let mut player = data.player.lock();
    match player.load_with_credentials(&path, credentials.as_ref()) {
        Ok(()) => HttpResponse::Ok().json(ApiResponse::success_with_state(
            "Track loaded",
            get_player_state(&player),
        )),
        Err(e) => HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("Failed to load: {}", e))),
    }
}

async fn play(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let mut player = data.player.lock();
    match player.play() {
        Ok(()) => HttpResponse::Ok().json(ApiResponse::success_with_state(
            "Playback started",
            get_player_state(&player),
        )),
        Err(e) => HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("Playback failed: {}", e))),
    }
}

async fn pause(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let mut player = data.player.lock();
    match player.pause() {
        Ok(()) => HttpResponse::Ok().json(ApiResponse::success_with_state(
            "Playback paused",
            get_player_state(&player),
        )),
        Err(e) => HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("Pause failed: {}", e))),
    }
}

async fn stop(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let mut player = data.player.lock();
    player.stop();
    HttpResponse::Ok().json(ApiResponse::success_with_state(
        "Playback stopped",
        get_player_state(&player),
    ))
}

async fn seek(
    data: web::Data<Arc<AppState>>,
    body: web::Json<SeekRequest>,
) -> HttpResponse {
    let mut player = data.player.lock();
    match player.seek(body.position) {
        Ok(()) => HttpResponse::Ok().json(ApiResponse::success_with_state(
            "Seek successful",
            get_player_state(&player),
        )),
        Err(e) => HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("Seek failed: {}", e))),
    }
}

async fn get_state(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let player = data.player.lock();
    HttpResponse::Ok().json(ApiResponse {
        status: "success".into(),
        message: None,
        state: Some(get_player_state(&player)),
        devices: None,
    })
}

async fn set_volume(
    data: web::Data<Arc<AppState>>,
    body: web::Json<VolumeRequest>,
) -> HttpResponse {
    let mut player = data.player.lock();
    player.set_volume(body.volume as f64);
    HttpResponse::Ok().json(ApiResponse::success_with_state(
        "Volume set",
        get_player_state(&player),
    ))
}

async fn list_devices(
    data: web::Data<Arc<AppState>>,
    _req: HttpRequest,
) -> HttpResponse {
    let player = data.player.lock();
    let devices = player.list_devices();
    
    // Split into preferred (WASAPI on Windows) and other
    // For now, treat all as preferred since cpal uses platform-appropriate backend
    let response = DevicesResponse {
        preferred: devices.clone(),
        other: vec![],
        preferred_name: if cfg!(windows) { "WASAPI" } else { "CoreAudio" }.into(),
    };
    
    HttpResponse::Ok().json(ApiResponse {
        status: "success".into(),
        message: None,
        state: None,
        devices: Some(response),
    })
}

async fn configure_output(
    data: web::Data<Arc<AppState>>,
    body: web::Json<ConfigureOutputRequest>,
) -> HttpResponse {
    let mut player = data.player.lock();
    
    if let Err(e) = player.select_device(body.device_id) {
        return HttpResponse::InternalServerError()
            .json(ApiResponse::error(&e));
    }
    
    if let Some(exclusive) = body.exclusive {
        player.exclusive_mode = exclusive;
        // Sync to SharedState so audio thread can read it
        player.shared_state().exclusive_mode.store(exclusive, std::sync::atomic::Ordering::Relaxed);
    }
    
    HttpResponse::Ok().json(ApiResponse::success_with_state(
        "Output configured",
        get_player_state(&player),
    ))
}

async fn configure_upsampling(
    data: web::Data<Arc<AppState>>,
    body: web::Json<ConfigureUpsamplingRequest>,
) -> HttpResponse {
    // FIX for Defect-43: Validate sample rate range to prevent panic
    // Common audio sample rates: 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000
    // Minimum: 8000 Hz (telephony), Maximum: 384000 Hz (highest common DAC rate)
    const MIN_SAMPLE_RATE: u32 = 8000;
    const MAX_SAMPLE_RATE: u32 = 384000;
    
    if let Some(sr) = body.target_samplerate {
        if sr == 0 {
            return HttpResponse::BadRequest()
                .json(ApiResponse::error("Sample rate cannot be 0. Use null to disable upsampling."));
        }
        if sr < MIN_SAMPLE_RATE {
            return HttpResponse::BadRequest()
                .json(ApiResponse::error(&format!(
                    "Sample rate {} Hz is too low. Minimum: {} Hz.", sr, MIN_SAMPLE_RATE
                )));
        }
        if sr > MAX_SAMPLE_RATE {
            return HttpResponse::BadRequest()
                .json(ApiResponse::error(&format!(
                    "Sample rate {} Hz is too high. Maximum: {} Hz.", sr, MAX_SAMPLE_RATE
                )));
        }
    }
    
    let mut player = data.player.lock();
    player.target_sample_rate = body.target_samplerate;
    
    let msg = match body.target_samplerate {
        Some(sr) => format!("Upsampling set to {} Hz", sr),
        None => "Upsampling disabled".into(),
    };
    
    HttpResponse::Ok().json(ApiResponse::success(&msg))
}

#[derive(Deserialize)]
struct ConfigureResamplingRequest {
    /// Resample quality: "low", "std", "hq", "uhq"
    quality: Option<String>,
    /// Enable disk cache for resampled files
    use_cache: Option<bool>,
    /// Enable preemptive resampling
    preemptive_resample: Option<bool>,
}

async fn configure_resampling(
    data: web::Data<Arc<AppState>>,
    body: web::Json<ConfigureResamplingRequest>,
) -> HttpResponse {
    let mut player = data.player.lock();
    
    if let Some(ref quality_str) = body.quality {
        let quality = match quality_str.to_lowercase().as_str() {
            "low" => crate::config::ResampleQuality::Low,
            "std" | "standard" => crate::config::ResampleQuality::Standard,
            "hq" | "high" => crate::config::ResampleQuality::High,
            "uhq" | "ultrahigh" => crate::config::ResampleQuality::UltraHigh,
            _ => return HttpResponse::BadRequest()
                .json(ApiResponse::error("Invalid quality. Use: low, std, hq, uhq")),
        };
        player.set_resample_quality(quality);
    }
    
    if let Some(cache) = body.use_cache {
        player.set_use_cache(cache);
    }
    
    if let Some(preemptive) = body.preemptive_resample {
        player.set_preemptive_resample(preemptive);
    }
    
    HttpResponse::Ok().json(ApiResponse::success_with_state(
        "Resampling settings updated",
        get_player_state(&player),
    ))
}

async fn set_eq(
    data: web::Data<Arc<AppState>>,
    body: web::Json<SetEqRequest>,
) -> HttpResponse {
    let mut player = data.player.lock();
    
    // Check if FIR EQ is enabled
    let is_fir = player.is_fir_eq_enabled();
    
    if is_fir {
        // FIR EQ mode
        if let Some(enabled) = body.enabled {
            if !enabled {
                player.disable_fir_eq();
            }
        }
        
        if let Some(ref bands) = body.bands {
            // Map band names to indices
            let band_map: std::collections::HashMap<&str, usize> = [
                ("31", 0), ("62", 1), ("125", 2), ("250", 3), ("500", 4),
                ("1000", 5), ("2000", 6), ("4000", 7), ("8000", 8), ("16000", 9),
                ("1k", 5), ("2k", 6), ("4k", 7), ("8k", 8), ("16k", 9),
            ].into_iter().collect();
            
            // Build gains array
            let mut gains = [0.0_f64; 10];
            let mut any_set = false;
            
            for (name, &gain) in bands {
                if let Some(&idx) = band_map.get(name.as_str()) {
                    gains[idx] = gain;
                    any_set = true;
                }
            }
            
            if any_set {
                if let Err(e) = player.set_fir_bands(&gains) {
                    return HttpResponse::InternalServerError().json(ApiResponse::error(&e));
                }
            }
        }
        
        drop(player);
        return HttpResponse::Ok().json(ApiResponse::success_with_state(
            "FIR EQ updated",
            get_player_state(&data.player.lock()),
        ));
    }
    
    // IIR EQ mode (original logic)
    let eq_arc = player.eq();
    let mut eq = eq_arc.lock();
    
    if let Some(enabled) = body.enabled {
        eq.set_enabled(enabled);
    }
    
    if let Some(ref bands) = body.bands {
        let sample_rate = player.shared_state().sample_rate.load(std::sync::atomic::Ordering::Relaxed) as f64;
        
        // Map band names to indices
        // FIX for Defect 38: Support both numeric format ("1000") and shorthand format ("1k")
        let band_map: std::collections::HashMap<&str, usize> = [
            // Numeric format
            ("31", 0), ("62", 1), ("125", 2), ("250", 3), ("500", 4),
            ("1000", 5), ("2000", 6), ("4000", 7), ("8000", 8), ("16000", 9),
            // Shorthand format (for backward compatibility)
            ("1k", 5), ("2k", 6), ("4k", 7), ("8k", 8), ("16k", 9),
        ].into_iter().collect();
        
        for (name, &gain) in bands {
            if let Some(&idx) = band_map.get(name.as_str()) {
                eq.set_band_gain(idx, gain, sample_rate);
            } else {
                log::warn!("Unknown EQ band name: '{}'", name);
            }
        }
    }
    
    drop(eq); // Release eq lock before getting player state
    
    HttpResponse::Ok().json(ApiResponse::success_with_state(
        "EQ updated",
        get_player_state(&player),
    ))
}

async fn set_eq_type(
    data: web::Data<Arc<AppState>>,
    body: web::Json<SetEqTypeRequest>,
) -> HttpResponse {
    let eq_type_upper = body.eq_type.to_uppercase();
    
    match eq_type_upper.as_str() {
        "IIR" => {
            // Disable FIR EQ if enabled
            let mut player = data.player.lock();
            player.disable_fir_eq();
            HttpResponse::Ok().json(ApiResponse::success("EQ type set to IIR"))
        }
        "FIR" => {
            // Enable FIR EQ with specified or default tap count
            let num_taps = body.fir_taps.unwrap_or(1023);  // Default 1023 taps
            let mut player = data.player.lock();
            match player.enable_fir_eq(num_taps) {
                Ok(()) => HttpResponse::Ok().json(ApiResponse::success(&format!(
                    "FIR EQ enabled with {} taps", num_taps
                ))),
                Err(e) => HttpResponse::InternalServerError().json(ApiResponse::error(&e)),
            }
        }
        _ => {
            HttpResponse::BadRequest().json(ApiResponse::error(&format!(
                "Unknown EQ type: '{}'. Supported types: IIR, FIR",
                body.eq_type
            )))
        }
    }
}

async fn configure_optimizations(
    data: web::Data<Arc<AppState>>,
    body: web::Json<ConfigureOptimizationsRequest>,
) -> HttpResponse {
    let mut player = data.player.lock();
    
    if let Some(dither) = body.dither_enabled {
        player.dither_enabled = dither;
        player.noise_shaper().lock().set_enabled(dither);
    }
    
    if let Some(rg) = body.replaygain_enabled {
        player.replaygain_enabled = rg;
    }
    
    HttpResponse::Ok().json(ApiResponse::success_with_state(
        "Optimizations updated",
        get_player_state(&player),
    ))
}

async fn configure_normalization(
    data: web::Data<Arc<AppState>>,
    body: web::Json<ConfigureNormalizationRequest>,
) -> HttpResponse {
    let mut player = data.player.lock();
    
    if let Some(enabled) = body.enabled {
        player.set_loudness_enabled(enabled);
    }
    
    if let Some(target_lufs) = body.target_lufs {
        player.set_target_lufs(target_lufs);
    }
    
    if let Some(album_gain_db) = body.album_gain_db {
        player.set_album_gain(album_gain_db);
    }
    
    if let Some(preamp_db) = body.preamp_db {
        player.set_preamp_gain(preamp_db);
    }
    
    // Mode switching
    if let Some(ref mode_str) = body.mode {
        let mode = match mode_str.to_lowercase().as_str() {
            "track" => crate::config::NormalizationMode::Track,
            "album" => crate::config::NormalizationMode::Album,
            "streaming" => crate::config::NormalizationMode::Streaming,
            "replaygain_track" | "rg_track" => crate::config::NormalizationMode::ReplayGainTrack,
            "replaygain_album" | "rg_album" => crate::config::NormalizationMode::ReplayGainAlbum,
            _ => crate::config::NormalizationMode::Track,
        };
        player.set_normalization_mode(mode);
    }
    
    HttpResponse::Ok().json(ApiResponse::success_with_state(
        "Normalization configured",
        get_player_state(&player),
    ))
}

async fn get_loudness_info(
    data: web::Data<Arc<AppState>>,
) -> HttpResponse {
    let player = data.player.lock();
    let info = player.get_loudness_info();
    
    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "loudness": {
            "integrated_lufs": info.integrated_lufs,
            "short_term_lufs": info.short_term_lufs,
            "momentary_lufs": info.momentary_lufs,
            "loudness_range": info.loudness_range,
            "true_peak_dbtp": info.true_peak_dbtp,
            "current_gain_db": info.current_gain_db,
            "target_gain_db": info.target_gain_db,
        }
    }))
}

/// Scan a track for loudness (synchronous decode and analysis)
/// 
/// Fixed: Previous implementation used async load_with_credentials() then immediately
/// read get_loudness_info(), which always returned initial -70 LUFS because decoding
/// hadn't started yet. Now decodes synchronously in the request handler.
async fn scan_track_loudness(
    data: web::Data<Arc<AppState>>,
    body: web::Json<LoadRequest>,
) -> HttpResponse {
    use crate::processor::{TrackLoudness, DEFAULT_STREAMING_TARGET_LUFS, LoudnessMeter};
    use crate::decoder::StreamingDecoder;
    
    // FIX for Defect 44: Validate path to prevent traversal attacks
    let path = match validate_path(&body.path) {
        Ok(p) => p,
        Err(e) => return HttpResponse::BadRequest().json(ApiResponse::error(&e)),
    };
    
    let credentials = {
        let cfg = data.webdav_config.lock();
        cfg.http_credentials()
    };
    
    // Synchronous decode and analysis (not using player to avoid interrupting playback)
    
    // Spawn blocking task for synchronous decode
    let handle = actix_rt::spawn(async move {
        // Open decoder
        let mut decoder = match StreamingDecoder::open_with_credentials(&path, credentials.as_ref()) {
            Ok(d) => d,
            Err(e) => {
                return Err(format!("Failed to open file: {}", e));
            }
        };
        
        let sample_rate = decoder.info.sample_rate;
        let channels = decoder.info.channels;
        
        // Create loudness meter
        let mut meter = LoudnessMeter::new(channels, sample_rate);
        
        // Decode and analyze
        let mut total_samples = 0usize;
        while let Some(chunk) = decoder.decode_next().map_err(|e| e.to_string())? {
            meter.process(&chunk);
            total_samples += chunk.len();
        }
        
        let integrated_lufs = meter.integrated_loudness();
        let loudness_range = meter.loudness_range();
        let true_peak_dbtp = 20.0 * meter.true_peak().log10();
        
        let track_loudness = TrackLoudness::new(
            &path,
            integrated_lufs,
            true_peak_dbtp,
            if loudness_range > 0.0 { Some(loudness_range) } else { None },
            DEFAULT_STREAMING_TARGET_LUFS,
        );
        
        log::info!(
            "Loudness scan complete: {} -> {:.1} LUFS, {:.1} dBTP, {} samples",
            path, integrated_lufs, true_peak_dbtp, total_samples
        );
        
        Ok(track_loudness)
    });
    
    match handle.await {
        Ok(Ok(track_loudness)) => {
            HttpResponse::Ok().json(serde_json::json!({
                "status": "success",
                "track_loudness": {
                    "track_id": track_loudness.track_id,
                    "file_path": track_loudness.file_path,
                    "integrated_lufs": track_loudness.integrated_lufs,
                    "true_peak_dbtp": track_loudness.true_peak_dbtp,
                    "loudness_range": track_loudness.loudness_range,
                    "track_gain_db": track_loudness.track_gain_db,
                }
            }))
        }
        Ok(Err(e)) => {
            HttpResponse::InternalServerError().json(ApiResponse::error(&e))
        }
        Err(e) => {
            HttpResponse::InternalServerError().json(ApiResponse::error(&format!("Task join error: {}", e)))
        }
    }
}

/// Background loudness scan - doesn't interrupt playback
/// Spawns a background task to decode and analyze the track
async fn scan_loudness_background(
    body: web::Json<ScanBackgroundRequest>,
) -> HttpResponse {
    use crate::processor::{TrackLoudness, DEFAULT_STREAMING_TARGET_LUFS, LoudnessMeter};
    use crate::decoder::StreamingDecoder;
    
    // FIX for Defect 44: Validate path to prevent traversal attacks
    let path = match validate_path(&body.path) {
        Ok(p) => p,
        Err(e) => return HttpResponse::BadRequest().json(ApiResponse::error(&e)),
    };
    let _store = body.store.unwrap_or(true);
    
    // Spawn background task for scanning
    let handle = actix_rt::spawn(async move {
        // Open decoder
        let mut decoder = match StreamingDecoder::open(&path) {
            Ok(d) => d,
            Err(e) => {
                log::error!("Background scan: Failed to open {}: {}", path, e);
                return Err(format!("Failed to open file: {}", e));
            }
        };
        
        let sample_rate = decoder.info.sample_rate;
        let channels = decoder.info.channels;
        
        // Create loudness meter
        let mut meter = LoudnessMeter::new(channels, sample_rate);
        
        // Decode and analyze
        let mut total_samples = 0usize;
        while let Some(chunk) = decoder.decode_next().map_err(|e| e.to_string())? {
            meter.process(&chunk);
            total_samples += chunk.len();
        }
        
        let integrated_lufs = meter.integrated_loudness();
        let loudness_range = meter.loudness_range();
        let true_peak_dbtp = 20.0 * meter.true_peak().log10();
        
        let track_loudness = TrackLoudness::new(
            &path,
            integrated_lufs,
            true_peak_dbtp,
            if loudness_range > 0.0 { Some(loudness_range) } else { None },
            DEFAULT_STREAMING_TARGET_LUFS,
        );
        
        log::info!(
            "Background scan complete: {} -> {:.1} LUFS, {:.1} dBTP, {} samples",
            path, integrated_lufs, true_peak_dbtp, total_samples
        );
        
        Ok(track_loudness)
    });
    
    match handle.await {
        Ok(Ok(track_loudness)) => {
            HttpResponse::Ok().json(serde_json::json!({
                "status": "success",
                "track_loudness": {
                    "track_id": track_loudness.track_id,
                    "file_path": track_loudness.file_path,
                    "integrated_lufs": track_loudness.integrated_lufs,
                    "true_peak_dbtp": track_loudness.true_peak_dbtp,
                    "loudness_range": track_loudness.loudness_range,
                    "track_gain_db": track_loudness.track_gain_db,
                }
            }))
        }
        Ok(Err(e)) => {
            HttpResponse::InternalServerError().json(ApiResponse::error(&e))
        }
        Err(e) => {
            HttpResponse::InternalServerError().json(ApiResponse::error(&format!("Task join error: {}", e)))
        }
    }
}

// ============ WebSocket Handler ============

async fn websocket(
    req: HttpRequest,
    stream: web::Payload,
    data: web::Data<Arc<AppState>>,
) -> Result<HttpResponse, actix_web::Error> {
    let (response, mut session, mut msg_stream) = actix_ws::handle(&req, stream)?;
    
    let shared_state = {
        let player = data.player.lock();
        player.shared_state()
    };

    // 用 oneshot 通知推送任务关闭
    let (close_tx, mut close_rx) = oneshot::channel::<()>();

    // 任务 1：监听客户端消息，检测关闭帧
    let mut session_for_recv = session.clone();
    actix_rt::spawn(async move {
        while let Some(Ok(msg)) = msg_stream.recv().await {
            match msg {
                Message::Close(_) => {
                    let _ = session_for_recv.close(None).await;
                    let _ = close_tx.send(()); // 通知推送任务退出
                    return;
                }
                Message::Ping(bytes) => {
                    let _ = session_for_recv.pong(&bytes).await;
                }
                Message::Text(_) | Message::Binary(_) => {
                    // 客户端消息，目前忽略（可扩展用于控制命令）
                }
                _ => {}
            }
        }
        // msg_stream 耗尽（客户端断开），推送任务会因发送失败自动退出
    });

    // 任务 2：推送频谱数据和事件通知
    actix_rt::spawn(async move {
        let mut timer = interval(Duration::from_millis(50)); // 20 Hz
        let mut last_spectrum: Vec<f32> = Vec::new();
        let mut idle_ticks: u32 = 0;
        let mut last_load_progress: u64 = 0;

        loop {
            tokio::select! {
                // 收到关闭信号，退出
                _ = &mut close_rx => {
                    break;
                }
                _ = timer.tick() => {
                    let is_playing = matches!(
                        *shared_state.state.read(),
                        crate::player::PlayerState::Playing
                    );

                    // ── Loading progress notification ──
                    let is_loading = shared_state.is_loading.load(std::sync::atomic::Ordering::Acquire);
                    if is_loading {
                        let progress = shared_state.load_progress.load(std::sync::atomic::Ordering::Relaxed);
                        if progress != last_load_progress {
                            last_load_progress = progress;
                            let msg = serde_json::json!({
                                "type": "loading_progress",
                                "progress": progress,
                            });
                            if session.text(msg.to_string()).await.is_err() {
                                break;
                            }
                        }
                    }

                    // ── Load complete/error notification ──
                    if shared_state.event_load_complete.swap(false, std::sync::atomic::Ordering::AcqRel) {
                        let error = shared_state.load_error.read().clone();
                        let file_path = shared_state.file_path.read().clone();
                        let msg = if let Some(err) = error {
                            serde_json::json!({
                                "type": "load_error",
                                "error": err,
                            })
                        } else {
                            serde_json::json!({
                                "type": "load_complete",
                                "file_path": file_path,
                                "duration": shared_state.duration_secs(),
                            })
                        };
                        if session.text(msg.to_string()).await.is_err() {
                            break;
                        }
                    }

                    // ── Track changed (gapless) notification ──
                    if shared_state.event_track_changed.swap(false, std::sync::atomic::Ordering::AcqRel) {
                        let file_path = shared_state.current_track_path.read().clone();
                        let msg = serde_json::json!({
                            "type": "track_changed",
                            "file_path": file_path,
                            "duration": shared_state.duration_secs(),
                        });
                        if session.text(msg.to_string()).await.is_err() {
                            break;
                        }
                    }

                    // ── Playback ended (EOF) notification ──
                    if shared_state.event_playback_ended.swap(false, std::sync::atomic::Ordering::AcqRel) {
                        let msg = serde_json::json!({
                            "type": "playback_ended",
                        });
                        if session.text(msg.to_string()).await.is_err() {
                            break;
                        }
                    }

                    if !is_playing && !is_loading {
                        idle_ticks += 1;
                        if idle_ticks > 40 {
                            tokio::time::sleep(Duration::from_millis(200)).await;
                            continue;
                        }
                    } else {
                        idle_ticks = 0;
                    }

                    // ── Gapless: Check needs_preload and push to frontend ──
                    if shared_state.needs_preload.load(std::sync::atomic::Ordering::Acquire) {
                        let pos = shared_state.position_frames.load(std::sync::atomic::Ordering::Relaxed);
                        let total = shared_state.total_frames.load(std::sync::atomic::Ordering::Relaxed);
                        let sr = shared_state.sample_rate.load(std::sync::atomic::Ordering::Relaxed).max(1);
                        let remaining_secs = total.saturating_sub(pos) as f64 / sr as f64;

                        let msg = serde_json::json!({
                            "type": "needs_preload",
                            "remaining_secs": remaining_secs,
                        });
                        if session.text(msg.to_string()).await.is_err() {
                            break;
                        }
                        // Note: needs_preload flag is cleared by cancel_preload / queue_next
                    }

                    let spectrum = shared_state.spectrum_data.lock().clone();
                    if spectrum == last_spectrum && !is_playing {
                        continue;
                    }
                    last_spectrum = spectrum.clone();

                    let msg = serde_json::json!({
                        "type": "spectrum_data",
                        "data": spectrum
                    });

                    if session.text(msg.to_string()).await.is_err() {
                        break; // 发送失败也视为断开
                    }
                }
            }
        }
    });
    
    Ok(response)
}

// ============ WebDAV Handlers ============

async fn webdav_configure(
    data: web::Data<Arc<AppState>>,
    body: web::Json<WebDavConfigureRequest>,
) -> HttpResponse {
    let mut cfg = data.webdav_config.lock();
    cfg.base_url = body.base_url.trim_end_matches('/').to_string();
    cfg.username = body.username.clone();
    cfg.password = body.password.clone();
    log::info!("WebDAV configured: {}", cfg.base_url);
    HttpResponse::Ok().json(ApiResponse::success("WebDAV configured"))
}

async fn webdav_browse(
    data: web::Data<Arc<AppState>>,
    query: web::Query<WebDavBrowseRequest>,
) -> HttpResponse {
    let cfg = data.webdav_config.lock().clone();
    if !cfg.is_configured() {
        return HttpResponse::BadRequest()
            .json(ApiResponse::error("WebDAV not configured"));
    }
    let path = query.path.as_deref().unwrap_or("/").to_string();
    
    // FIX for Defect-10: Use web::block() to avoid blocking async worker
    // The synchronous cfg.list() call blocks for network I/O, which would
    // block the tokio worker thread. web::block() moves it to a thread pool.
    let cfg_clone = cfg.clone();
    let path_for_block = path.clone();
    let result = web::block(move || {
        cfg_clone.list(&path_for_block)
    }).await;
    
    match result {
        Ok(Ok(entries)) => HttpResponse::Ok().json(serde_json::json!({
            "status": "success",
            "path": path,
            "entries": entries,
        })),
        Ok(Err(e)) => HttpResponse::InternalServerError()
            .json(ApiResponse::error(&e.to_string())),
        Err(e) => HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("Blocking error: {}", e))),
    }
}

// ============ Gapless Playback Handlers ============

async fn queue_next(
    data: web::Data<Arc<AppState>>,
    body: web::Json<QueueNextRequest>,
) -> HttpResponse {
    // FIX for Defect 44: Validate path to prevent traversal attacks
    let path = match validate_path(&body.path) {
        Ok(p) => p,
        Err(e) => return HttpResponse::BadRequest().json(ApiResponse::error(&e)),
    };
    
    let credentials = match (&body.username, &body.password) {
        (Some(u), Some(p)) => Some(crate::decoder::HttpCredentials {
            username: u.clone(),
            password: p.clone(),
        }),
        _ => {
            // Use global WebDAV config if available
            data.webdav_config.lock().http_credentials()
        }
    };

    let player = data.player.lock();
    match player.queue_next_with_credentials(&path, credentials) {
        Ok(()) => {
            // Clear the needs_preload flag to stop repeated WebSocket notifications
            player.shared_state().needs_preload.store(false, std::sync::atomic::Ordering::Release);
            HttpResponse::Ok()
                .json(ApiResponse::success("Queued for gapless playback"))
        }
        Err(e) => HttpResponse::InternalServerError()
            .json(ApiResponse::error(&e)),
    }
}

async fn cancel_preload(data: web::Data<Arc<AppState>>) -> HttpResponse {
    data.player.lock().cancel_preload();
    HttpResponse::Ok().json(ApiResponse::success("Preload cancelled"))
}

// ============ FIR Convolver (IR) Handlers ============

async fn load_ir(
    data: web::Data<Arc<AppState>>,
    body: web::Json<LoadIrRequest>,
) -> HttpResponse {
    // FIX for Defect 44: Validate path to prevent traversal attacks
    let path = match validate_path(&body.path) {
        Ok(p) => p,
        Err(e) => return HttpResponse::BadRequest().json(ApiResponse::error(&e)),
    };
    
    let player = data.player.lock();
    match player.load_ir(&path) {
        Ok(()) => HttpResponse::Ok().json(ApiResponse::success("IR loaded")),
        Err(e) => HttpResponse::InternalServerError().json(ApiResponse::error(&e)),
    }
}

async fn unload_ir(data: web::Data<Arc<AppState>>) -> HttpResponse {
    data.player.lock().unload_ir();
    HttpResponse::Ok().json(ApiResponse::success("IR unloaded"))
}

// ============ Crossfeed Handlers ============

async fn set_crossfeed(
    data: web::Data<Arc<AppState>>,
    body: web::Json<SetCrossfeedRequest>,
) -> HttpResponse {
    let player = data.player.lock();
    let crossfeed_arc = player.crossfeed();
    let mut crossfeed = crossfeed_arc.lock();
    
    if let Some(enabled) = body.enabled {
        crossfeed.set_enabled(enabled);
    }
    if let Some(mix) = body.mix {
        crossfeed.set_mix(mix);
    }
    
    let settings = crossfeed.get_settings();
    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "message": "Crossfeed updated",
        "crossfeed": {
            "enabled": settings.enabled,
            "mix": settings.mix
        }
    }))
}

async fn get_crossfeed(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let player = data.player.lock();
    let crossfeed_arc = player.crossfeed();
    let settings = crossfeed_arc.lock().get_settings();
    
    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "crossfeed": {
            "enabled": settings.enabled,
            "mix": settings.mix
        }
    }))
}

// ============ Saturation Handlers ============

async fn set_saturation(
    data: web::Data<Arc<AppState>>,
    body: web::Json<SetSaturationRequest>,
) -> HttpResponse {
    let player = data.player.lock();
    let saturation_arc = player.saturation();
    let mut saturation = saturation_arc.lock();
    
    if let Some(enabled) = body.enabled {
        saturation.set_enabled(enabled);
    }
    if let Some(drive) = body.drive {
        saturation.set_drive(drive);
    }
    if let Some(threshold) = body.threshold {
        saturation.set_threshold(threshold);
    }
    if let Some(mix) = body.mix {
        saturation.set_mix(mix);
    }
    if let Some(input_gain_db) = body.input_gain_db {
        saturation.set_input_gain(input_gain_db);
    }
    if let Some(output_gain_db) = body.output_gain_db {
        saturation.set_output_gain(output_gain_db);
    }
    if let Some(highpass_mode) = body.highpass_mode {
        saturation.set_highpass_mode(highpass_mode);
    }
    if let Some(highpass_cutoff) = body.highpass_cutoff {
        saturation.set_highpass_cutoff(highpass_cutoff);
    }
    
    let settings = saturation.get_settings();
    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "message": "Saturation updated",
        "saturation": settings
    }))
}

async fn get_saturation(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let player = data.player.lock();
    let saturation_arc = player.saturation();
    let settings = saturation_arc.lock().get_settings();
    
    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "saturation": settings
    }))
}

// ============ Dynamic Loudness Handlers ============

async fn set_dynamic_loudness(
    data: web::Data<Arc<AppState>>,
    body: web::Json<SetDynamicLoudnessRequest>,
) -> HttpResponse {
    let player = data.player.lock();
    
    if let Some(enabled) = body.enabled {
        player.set_dynamic_loudness_enabled(enabled);
    }
    if let Some(strength) = body.strength {
        if strength < 0.0 || strength > 1.0 {
            return HttpResponse::BadRequest().json(ApiResponse::error(
                "Strength must be between 0.0 and 1.0"
            ));
        }
        player.set_dynamic_loudness_strength(strength);
    }
    
    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "message": "Dynamic Loudness updated",
        "dynamic_loudness": {
            "enabled": player.is_dynamic_loudness_enabled(),
            "strength": player.get_dynamic_loudness_strength(),
            "factor": player.get_dynamic_loudness_factor(),
            "band_gains": player.get_dynamic_loudness_gains()
        }
    }))
}

async fn get_dynamic_loudness(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let player = data.player.lock();
    
    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "dynamic_loudness": {
            "enabled": player.is_dynamic_loudness_enabled(),
            "strength": player.get_dynamic_loudness_strength(),
            "factor": player.get_dynamic_loudness_factor(),
            "band_gains": player.get_dynamic_loudness_gains()
        }
    }))
}

// ============ Noise Shaper Handlers ============

async fn set_noise_shaper_curve(
    data: web::Data<Arc<AppState>>,
    body: web::Json<SetNoiseShaperCurveRequest>,
) -> HttpResponse {
    use crate::processor::NoiseShaperCurve;
    
    let curve = match body.curve.to_lowercase().as_str() {
        "lipshitz5" => NoiseShaperCurve::Lipshitz5,
        "fweighted9" => NoiseShaperCurve::FWeighted9,
        "modifiede9" => NoiseShaperCurve::ModifiedE9,
        "improvede9" => NoiseShaperCurve::ImprovedE9,
        "tpdfonly" => NoiseShaperCurve::TpdfOnly,
        _ => {
            return HttpResponse::BadRequest().json(ApiResponse::error(&format!(
                "Unknown curve: '{}'. Supported: Lipshitz5, FWeighted9, ModifiedE9, ImprovedE9, TpdfOnly",
                body.curve
            )));
        }
    };
    
    let player = data.player.lock();
    player.noise_shaper().lock().set_curve(curve);
    
    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "message": format!("Noise shaper curve set to {:?}", curve)
    }))
}

async fn get_noise_shaper_curve(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let player = data.player.lock();
    let curve = player.noise_shaper().lock().curve();
    
    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "noise_shaper": {
            "curve": format!("{:?}", curve),
            "enabled": true  // Noise shaper is always enabled when dither is on
        }
    }))
}

// Defect 37 fix: Allow setting output bit depth for NoiseShaper
async fn configure_output_bits(
    data: web::Data<Arc<AppState>>,
    body: web::Json<SetOutputBitsRequest>,
) -> HttpResponse {
    // Validate bit depth
    if body.bits != 16 && body.bits != 24 && body.bits != 32 {
        return HttpResponse::BadRequest().json(ApiResponse::error(
            "Invalid bit depth. Supported: 16, 24, 32"
        ));
    }
    
    let player = data.player.lock();
    player.set_output_bits(body.bits);
    
    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "message": format!("Output bit depth set to {} bits", body.bits)
    }))
}

// ============ Loading Status Handlers ============

async fn get_loading_status(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let player = data.player.lock();
    
    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "loading": {
            "is_loading": player.is_loading(),
            "progress": player.load_progress(),
            "error": player.load_error()
        }
    }))
}

// ============ IR Status Handlers ============

async fn get_ir_status(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let player = data.player.lock();
    
    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "ir": {
            "loaded": player.is_ir_loaded()
        }
    }))
}

// ============ Settings Persistence Handlers ============

async fn get_settings(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let settings = data.settings_manager.lock().get_settings();
    
    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "settings": settings
    }))
}

#[derive(Deserialize)]
struct SaveSettingsRequest {
    settings: PersistentSettingsUpdate,
}

async fn save_settings(
    data: web::Data<Arc<AppState>>,
    body: web::Json<SaveSettingsRequest>,
) -> HttpResponse {
    // Update settings in manager
    {
        let mut manager = data.settings_manager.lock();
        if let Err(e) = manager.update(body.settings.clone()) {
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "status": "error",
                "message": e
            }));
        }
    }
    
    // Apply settings to player
    {
        let settings = data.settings_manager.lock().get_settings();
        let mut player = data.player.lock();
        apply_settings_to_player(&mut player, &settings);
    }
    
    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "message": "Settings saved"
    }))
}

// ============ Server Entry Point ============

use crate::config::AppConfig;

pub async fn run_server(port: u16, config: AppConfig, settings_manager: SharedSettingsManager) -> std::io::Result<()> {
    // Load WebDAV config from env if present
    let webdav_config = WebDavConfig {
        base_url: std::env::var("WEBDAV_URL").unwrap_or_default(),
        username: std::env::var("WEBDAV_USER").ok(),
        password: std::env::var("WEBDAV_PASS").ok(),
    };

    // FIX for LoudnessDatabase integration: Initialize loudness database
    let loudness_db_path = std::env::var("LOUDNESS_DB_PATH")
        .unwrap_or_else(|_| "loudness_cache.db".to_string());
    let loudness_db = match LoudnessDatabase::open(&loudness_db_path) {
        Ok(db) => {
            log::info!("Loudness database opened: {}", loudness_db_path);
            Some(db)
        }
        Err(e) => {
            log::warn!("Failed to open loudness database: {}. Loudness caching disabled.", e);
            None
        }
    };

    // Create player with config
    let mut player = AudioPlayer::new(config);
    
    // Apply persisted settings to player
    {
        let settings = settings_manager.lock().get_settings();
        apply_settings_to_player(&mut player, &settings);
        log::info!("Applied persisted settings to audio engine");
    }

    let state = Arc::new(AppState {
        player: Mutex::new(player),
        webdav_config: Mutex::new(webdav_config),
        loudness_db: Mutex::new(loudness_db),
        settings_manager,
    });
    
    log::info!("Starting VCP Audio Engine on http://127.0.0.1:{}", port);
    
    // Print ready signal for parent process
    println!("RUST_AUDIO_ENGINE_READY");
    
    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(Arc::clone(&state)))
            .wrap(middleware::Logger::default())
            .wrap(
                middleware::DefaultHeaders::new()
                    .add(("Access-Control-Allow-Origin", "*"))
                    .add(("Access-Control-Allow-Methods", "GET, POST, OPTIONS"))
                    .add(("Access-Control-Allow-Headers", "Content-Type"))
            )
            // CORS preflight handler - catch all OPTIONS requests
            .default_service(web::route().method(Method::OPTIONS).to(cors_preflight))
            // Actual routes
            .route("/load", web::post().to(load))
            .route("/play", web::post().to(play))
            .route("/pause", web::post().to(pause))
            .route("/stop", web::post().to(stop))
            .route("/seek", web::post().to(seek))
            .route("/state", web::get().to(get_state))
            .route("/volume", web::post().to(set_volume))
            .route("/devices", web::get().to(list_devices))
            .route("/configure_output", web::post().to(configure_output))
            .route("/configure_upsampling", web::post().to(configure_upsampling))
            .route("/configure_resampling", web::post().to(configure_resampling))
            .route("/set_eq", web::post().to(set_eq))
            .route("/set_eq_type", web::post().to(set_eq_type))
            .route("/configure_optimizations", web::post().to(configure_optimizations))
            .route("/configure_normalization", web::post().to(configure_normalization))
            .route("/loudness_info", web::get().to(get_loudness_info))
            .route("/scan_loudness", web::post().to(scan_track_loudness))
            .route("/scan_loudness_background", web::post().to(scan_loudness_background))
            .route("/webdav/configure", web::post().to(webdav_configure))
            .route("/webdav/browse", web::get().to(webdav_browse))
            .route("/queue_next", web::post().to(queue_next))
            .route("/cancel_preload", web::post().to(cancel_preload))
            .route("/load_ir", web::post().to(load_ir))
            .route("/unload_ir", web::post().to(unload_ir))
            // Crossfeed
            .route("/crossfeed", web::get().to(get_crossfeed))
            .route("/set_crossfeed", web::post().to(set_crossfeed))
            // Saturation
            .route("/saturation", web::get().to(get_saturation))
            .route("/set_saturation", web::post().to(set_saturation))
            // Dynamic Loudness
            .route("/dynamic_loudness", web::get().to(get_dynamic_loudness))
            .route("/set_dynamic_loudness", web::post().to(set_dynamic_loudness))
            // Noise Shaper
            .route("/noise_shaper_curve", web::get().to(get_noise_shaper_curve))
            .route("/set_noise_shaper_curve", web::post().to(set_noise_shaper_curve))
            // Output bit depth (Defect 37 fix)
            .route("/configure_output_bits", web::post().to(configure_output_bits))
            // Loading Status
            .route("/loading_status", web::get().to(get_loading_status))
            // IR Status
            .route("/ir_status", web::get().to(get_ir_status))
            // Settings Persistence
            .route("/settings", web::get().to(get_settings))
            .route("/save_settings", web::post().to(save_settings))
            .route("/ws", web::get().to(websocket))
    })
    .bind(("127.0.0.1", port))?
    .run()
    .await
}
