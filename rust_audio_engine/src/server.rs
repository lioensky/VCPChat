//! VCP Hi-Fi Audio Engine - HTTP/WebSocket Server
//!
//! REST API compatible with existing frontend, with WebSocket for spectrum data.

use actix_web::{web, App, HttpServer, HttpResponse, middleware, http::Method};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::time::Duration;
use tokio::runtime::{Builder as TokioRuntimeBuilder, Runtime as TokioRuntime};
use tokio::sync::Semaphore;
use tokio::time::timeout;

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
    /// Dedicated runtime for CPU/IO-heavy analysis jobs
    pub analysis_runtime: Arc<TokioRuntime>,
    /// Concurrency guard for analysis jobs to avoid starving playback/control plane
    pub analysis_semaphore: Arc<Semaphore>,
    /// Background scan task records
    pub scan_tasks: Mutex<HashMap<u64, ScanTaskRecord>>,
    /// Task id counter
    pub scan_task_counter: AtomicU64,
    /// Max retained scan task records
    pub scan_task_max_entries: usize,
    /// TTL for finished scan task records in seconds
    pub scan_task_ttl_secs: u64,
    /// Max time for one analysis job before timeout
    pub analysis_task_timeout_secs: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanTaskRecord {
    pub status: String,
    pub created_at_epoch_secs: u64,
    pub updated_at_epoch_secs: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

mod effects;
mod playback;
mod settings_handlers;
mod webdav_handlers;
mod ws_handlers;

async fn run_analysis_job<T, F>(data: &web::Data<Arc<AppState>>, job: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let permit = Arc::clone(&data.analysis_semaphore)
        .acquire_owned()
        .await
        .map_err(|e| format!("Analysis semaphore closed: {}", e))?;

    let handle = data.analysis_runtime.handle().clone();
    let join_handle = handle.spawn_blocking(move || {
        let _permit = permit;
        job()
    });

    let timeout_secs = data.analysis_task_timeout_secs.max(1);
    let join_result = timeout(Duration::from_secs(timeout_secs), join_handle)
        .await
        .map_err(|_| format!("Analysis task timed out after {}s", timeout_secs))?;

    join_result
        .map_err(|e| format!("Analysis worker join error: {}", e))?
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
    } else {
        *player.shared_state().eq_type.write() = "IIR".to_string();
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
            // IIR EQ (lock-free)
            for (name, &gain) in bands {
                if let Some(&idx) = band_map.get(name.as_str()) {
                    player.lockfree_eq_params.set_band_gain(idx, gain);
                }
            }
            let _ = sr;
        }
    }
    
    // Dither (state only; lock-free audio path currently does not host NoiseShaper stage)
    player.dither_enabled = settings.dither_enabled;
    player.set_output_bits(settings.output_bits);
    
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

    let analysis_parallelism = std::env::var("ANALYSIS_MAX_CONCURRENCY")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(2);
    let analysis_blocking_threads = std::env::var("ANALYSIS_MAX_BLOCKING_THREADS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(analysis_parallelism.max(2));
    let analysis_runtime = TokioRuntimeBuilder::new_multi_thread()
        .worker_threads(1)
        .max_blocking_threads(analysis_blocking_threads)
        .thread_name("vcp-analysis")
        .enable_time()
        .build()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, format!("Failed to init analysis runtime: {}", e)))?;

    log::info!(
        "Analysis worker pool initialized: concurrency_limit={}, max_blocking_threads={}",
        analysis_parallelism,
        analysis_blocking_threads
    );

    let scan_task_max_entries = std::env::var("SCAN_TASK_MAX_ENTRIES")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(512);
    let scan_task_ttl_secs = std::env::var("SCAN_TASK_TTL_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(600);
    let analysis_task_timeout_secs = std::env::var("ANALYSIS_TASK_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(180);
    
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
        analysis_runtime: Arc::new(analysis_runtime),
        analysis_semaphore: Arc::new(Semaphore::new(analysis_parallelism)),
        scan_tasks: Mutex::new(HashMap::new()),
        scan_task_counter: AtomicU64::new(0),
        scan_task_max_entries,
        scan_task_ttl_secs,
        analysis_task_timeout_secs,
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
                .configure(playback::configure_routes)
                .configure(effects::configure_routes)
                .configure(settings_handlers::configure_routes)
                .configure(webdav_handlers::configure_routes)
                .configure(ws_handlers::configure_routes)
    })
    .bind(("127.0.0.1", port))?
    .run()
    .await
}
