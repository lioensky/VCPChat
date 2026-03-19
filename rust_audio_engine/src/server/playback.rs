use super::*;
use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/load", web::post().to(load))
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
        .route("/configure_normalization", web::post().to(configure_normalization))
        .route("/loudness_info", web::get().to(get_loudness_info))
        .route("/scan_loudness", web::post().to(scan_track_loudness))
        .route("/scan_loudness_background", web::post().to(scan_loudness_background))
        .route("/scan_loudness_task/{task_id}", web::get().to(get_scan_loudness_task))
        .route("/scan_loudness_task/{task_id}/cancel", web::post().to(cancel_scan_loudness_task))
        .route("/queue_next", web::post().to(queue_next))
        .route("/cancel_preload", web::post().to(cancel_preload))
        .route("/load_ir", web::post().to(load_ir))
        .route("/unload_ir", web::post().to(unload_ir))
        .route("/loading_status", web::get().to(get_loading_status))
        .route("/ir_status", web::get().to(get_ir_status));
}

#[derive(Deserialize)]
struct ScanTaskPath {
    task_id: u64,
}

fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn cleanup_scan_tasks(data: &web::Data<Arc<AppState>>) {
    let now = now_epoch_secs();
    let ttl = data.scan_task_ttl_secs;
    let max_entries = data.scan_task_max_entries;

    let mut tasks = data.scan_tasks.lock();

    tasks.retain(|_, task| {
        let finished = task.status == "success" || task.status == "error";
        if !finished {
            return true;
        }
        now.saturating_sub(task.updated_at_epoch_secs) <= ttl
    });

    if tasks.len() > max_entries {
        let mut entries: Vec<(u64, bool, u64)> = tasks
            .iter()
            .map(|(id, task)| {
                let finished = task.status == "success" || task.status == "error";
                (*id, finished, task.updated_at_epoch_secs)
            })
            .collect();

        entries.sort_by_key(|(_, finished, updated_at)| (!*finished, *updated_at));
        let remove_count = tasks.len().saturating_sub(max_entries);

        for (id, _, _) in entries.into_iter().take(remove_count) {
            tasks.remove(&id);
        }
    }
}

fn task_is_canceled(data: &web::Data<Arc<AppState>>, task_id: u64) -> bool {
    data.scan_tasks
        .lock()
        .get(&task_id)
        .map(|task| task.status == "canceled")
        .unwrap_or(false)
}

fn analysis_error_response(e: &str) -> HttpResponse {
    if e.to_ascii_lowercase().contains("timed out") {
        HttpResponse::GatewayTimeout().json(ApiResponse::error(e))
    } else {
        HttpResponse::InternalServerError().json(ApiResponse::error(e))
    }
}

fn track_loudness_to_json(track_loudness: &crate::processor::TrackLoudness) -> serde_json::Value {
    serde_json::json!({
        "track_id": track_loudness.track_id,
        "file_path": track_loudness.file_path,
        "integrated_lufs": track_loudness.integrated_lufs,
        "true_peak_dbtp": track_loudness.true_peak_dbtp,
        "loudness_range": track_loudness.loudness_range,
        "track_gain_db": track_loudness.track_gain_db,
    })
}

fn try_get_cached_loudness(
    data: &web::Data<Arc<AppState>>,
    path: &str,
) -> Option<crate::processor::TrackLoudness> {
    let db_guard = data.loudness_db.lock();
    let db = db_guard.as_ref()?;

    match db.needs_scan(path) {
        Ok(false) => match db.get(path) {
            Ok(Some(track)) => {
                log::info!("Using cached loudness for: {}", path);
                Some(track)
            }
            Ok(None) => None,
            Err(e) => {
                log::warn!("Loudness cache read failed for '{}': {}", path, e);
                None
            }
        },
        Ok(true) => None,
        Err(e) => {
            log::warn!("Loudness cache validation failed for '{}': {}", path, e);
            None
        }
    }
}

fn try_store_loudness(data: &web::Data<Arc<AppState>>, track: &crate::processor::TrackLoudness) {
    let db_guard = data.loudness_db.lock();
    if let Some(db) = db_guard.as_ref() {
        if let Err(e) = db.upsert(track) {
            log::warn!("Failed to store loudness cache for '{}': {}", track.file_path, e);
        }
    }
}

fn analyze_track_loudness(
    path: String,
    credentials: Option<crate::decoder::HttpCredentials>,
) -> Result<crate::processor::TrackLoudness, String> {
    use crate::decoder::StreamingDecoder;
    use crate::processor::{LoudnessMeter, TrackLoudness, DEFAULT_STREAMING_TARGET_LUFS};

    let mut decoder = StreamingDecoder::open_with_credentials(&path, credentials.as_ref())
        .map_err(|e| format!("Failed to open file: {}", e))?;

    let sample_rate = decoder.info.sample_rate;
    let channels = decoder.info.channels;
    let mut meter = LoudnessMeter::new(channels, sample_rate);

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
        if loudness_range > 0.0 {
            Some(loudness_range)
        } else {
            None
        },
        DEFAULT_STREAMING_TARGET_LUFS,
    );

    log::info!(
        "Loudness scan complete: {} -> {:.1} LUFS, {:.1} dBTP, {} samples",
        path,
        integrated_lufs,
        true_peak_dbtp,
        total_samples
    );

    Ok(track_loudness)
}

async fn load(
    data: web::Data<Arc<AppState>>,
    body: web::Json<LoadRequest>,
) -> HttpResponse {
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
        return HttpResponse::InternalServerError().json(ApiResponse::error(&e));
    }

    if let Some(exclusive) = body.exclusive {
        player.exclusive_mode = exclusive;
        player
            .shared_state()
            .exclusive_mode
            .store(exclusive, std::sync::atomic::Ordering::Relaxed);
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
    const MIN_SAMPLE_RATE: u32 = 8000;
    const MAX_SAMPLE_RATE: u32 = 384000;

    if let Some(sr) = body.target_samplerate {
        if sr == 0 {
            return HttpResponse::BadRequest()
                .json(ApiResponse::error("Sample rate cannot be 0. Use null to disable upsampling."));
        }
        if sr < MIN_SAMPLE_RATE {
            return HttpResponse::BadRequest().json(ApiResponse::error(&format!(
                "Sample rate {} Hz is too low. Minimum: {} Hz.",
                sr, MIN_SAMPLE_RATE
            )));
        }
        if sr > MAX_SAMPLE_RATE {
            return HttpResponse::BadRequest().json(ApiResponse::error(&format!(
                "Sample rate {} Hz is too high. Maximum: {} Hz.",
                sr, MAX_SAMPLE_RATE
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
    quality: Option<String>,
    use_cache: Option<bool>,
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
            _ => {
                return HttpResponse::BadRequest()
                    .json(ApiResponse::error("Invalid quality. Use: low, std, hq, uhq"));
            }
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

async fn get_loudness_info(data: web::Data<Arc<AppState>>) -> HttpResponse {
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

async fn scan_track_loudness(
    data: web::Data<Arc<AppState>>,
    body: web::Json<LoadRequest>,
) -> HttpResponse {
    let path = match validate_path(&body.path) {
        Ok(p) => p,
        Err(e) => return HttpResponse::BadRequest().json(ApiResponse::error(&e)),
    };

    if let Some(track_loudness) = try_get_cached_loudness(&data, &path) {
        return HttpResponse::Ok().json(serde_json::json!({
            "status": "success",
            "source": "cache",
            "track_loudness": track_loudness_to_json(&track_loudness)
        }));
    }

    let credentials = {
        let cfg = data.webdav_config.lock();
        cfg.http_credentials()
    };

    let path_for_job = path.clone();
    let credentials_for_job = credentials.clone();

    let result = run_analysis_job(&data, move || {
        analyze_track_loudness(path_for_job, credentials_for_job)
    })
    .await;

    match result {
        Ok(track_loudness) => {
            try_store_loudness(&data, &track_loudness);
            HttpResponse::Ok().json(serde_json::json!({
            "status": "success",
            "source": "fresh",
            "track_loudness": track_loudness_to_json(&track_loudness)
        }))
        }
        Err(e) => analysis_error_response(&e),
    }
}

async fn scan_loudness_background(
    data: web::Data<Arc<AppState>>,
    body: web::Json<ScanBackgroundRequest>,
) -> HttpResponse {
    let path = match validate_path(&body.path) {
        Ok(p) => p,
        Err(e) => return HttpResponse::BadRequest().json(ApiResponse::error(&e)),
    };
    let store = body.store.unwrap_or(true);

    if data.analysis_semaphore.available_permits() == 0 {
        return HttpResponse::TooManyRequests().json(ApiResponse::error(
            "Too many scan tasks in progress, please retry later",
        ));
    }

    cleanup_scan_tasks(&data);

    let task_id = data.scan_task_counter.fetch_add(1, Ordering::Relaxed) + 1;
    let now = now_epoch_secs();
    data.scan_tasks.lock().insert(
        task_id,
        ScanTaskRecord {
            status: "queued".to_string(),
            created_at_epoch_secs: now,
            updated_at_epoch_secs: now,
            result: None,
            error: None,
        },
    );

    let data_for_task = data.clone();
    let path_for_task = path.clone();
    actix_rt::spawn(async move {
        {
            if let Some(task) = data_for_task.scan_tasks.lock().get_mut(&task_id) {
                task.status = "running".to_string();
                task.updated_at_epoch_secs = now_epoch_secs();
            }
        }

        if task_is_canceled(&data_for_task, task_id) {
            return;
        }

        if let Some(track_loudness) = try_get_cached_loudness(&data_for_task, &path_for_task) {
            if !task_is_canceled(&data_for_task, task_id) {
                if let Some(task) = data_for_task.scan_tasks.lock().get_mut(&task_id) {
                    task.status = "success".to_string();
                    task.result = Some(track_loudness_to_json(&track_loudness));
                    task.updated_at_epoch_secs = now_epoch_secs();
                }
            }
            return;
        }

        let path_for_analysis = path_for_task.clone();
        let result = run_analysis_job(&data_for_task, move || {
            analyze_track_loudness(path_for_analysis, None)
        })
        .await;

        match result {
            Ok(track_loudness) => {
                if store {
                    try_store_loudness(&data_for_task, &track_loudness);
                }
                if !task_is_canceled(&data_for_task, task_id) {
                    if let Some(task) = data_for_task.scan_tasks.lock().get_mut(&task_id) {
                        task.status = "success".to_string();
                        task.result = Some(track_loudness_to_json(&track_loudness));
                        task.updated_at_epoch_secs = now_epoch_secs();
                    }
                }
            }
            Err(e) => {
                if !task_is_canceled(&data_for_task, task_id) {
                    if let Some(task) = data_for_task.scan_tasks.lock().get_mut(&task_id) {
                        task.status = "error".to_string();
                        task.error = Some(e);
                        task.updated_at_epoch_secs = now_epoch_secs();
                    }
                }
            }
        }

        cleanup_scan_tasks(&data_for_task);
    });

    HttpResponse::Accepted().json(serde_json::json!({
        "status": "accepted",
        "task_id": task_id,
        "path": path
    }))
}

async fn get_scan_loudness_task(
    data: web::Data<Arc<AppState>>,
    path: web::Path<ScanTaskPath>,
) -> HttpResponse {
    cleanup_scan_tasks(&data);

    let task_id = path.task_id;
    let tasks = data.scan_tasks.lock();
    if let Some(task) = tasks.get(&task_id) {
        HttpResponse::Ok().json(serde_json::json!({
            "status": "success",
            "task_id": task_id,
            "task": task
        }))
    } else {
        HttpResponse::NotFound().json(ApiResponse::error("Scan task not found"))
    }
}

async fn cancel_scan_loudness_task(
    data: web::Data<Arc<AppState>>,
    path: web::Path<ScanTaskPath>,
) -> HttpResponse {
    cleanup_scan_tasks(&data);

    let task_id = path.task_id;
    let mut tasks = data.scan_tasks.lock();
    if let Some(task) = tasks.get_mut(&task_id) {
        match task.status.as_str() {
            "queued" | "running" => {
                task.status = "canceled".to_string();
                task.error = Some("Canceled by client".to_string());
                task.updated_at_epoch_secs = now_epoch_secs();
                HttpResponse::Ok().json(serde_json::json!({
                    "status": "success",
                    "task_id": task_id,
                    "message": "Scan task canceled"
                }))
            }
            _ => HttpResponse::Ok().json(serde_json::json!({
                "status": "success",
                "task_id": task_id,
                "message": "Task already finished"
            })),
        }
    } else {
        HttpResponse::NotFound().json(ApiResponse::error("Scan task not found"))
    }
}

async fn queue_next(
    data: web::Data<Arc<AppState>>,
    body: web::Json<QueueNextRequest>,
) -> HttpResponse {
    let path = match validate_path(&body.path) {
        Ok(p) => p,
        Err(e) => return HttpResponse::BadRequest().json(ApiResponse::error(&e)),
    };

    let credentials = match (&body.username, &body.password) {
        (Some(u), Some(p)) => Some(crate::decoder::HttpCredentials {
            username: u.clone(),
            password: p.clone(),
        }),
        _ => data.webdav_config.lock().http_credentials(),
    };

    let player = data.player.lock();
    match player.queue_next_with_credentials(&path, credentials) {
        Ok(()) => {
            player
                .shared_state()
                .needs_preload
                .store(false, std::sync::atomic::Ordering::Release);
            HttpResponse::Ok().json(ApiResponse::success("Queued for gapless playback"))
        }
        Err(e) => HttpResponse::InternalServerError().json(ApiResponse::error(&e)),
    }
}

async fn cancel_preload(data: web::Data<Arc<AppState>>) -> HttpResponse {
    data.player.lock().cancel_preload();
    HttpResponse::Ok().json(ApiResponse::success("Preload cancelled"))
}

async fn load_ir(
    data: web::Data<Arc<AppState>>,
    body: web::Json<LoadIrRequest>,
) -> HttpResponse {
    let path = match validate_path(&body.path) {
        Ok(p) => p,
        Err(e) => return HttpResponse::BadRequest().json(ApiResponse::error(&e)),
    };

    let mut player = data.player.lock();
    match player.load_ir(&path) {
        Ok(()) => HttpResponse::Ok().json(ApiResponse::success("IR loaded")),
        Err(e) => {
            if e.to_ascii_lowercase().contains("not yet implemented") {
                HttpResponse::NotImplemented().json(ApiResponse::error(&e))
            } else {
                HttpResponse::InternalServerError().json(ApiResponse::error(&e))
            }
        }
    }
}

async fn unload_ir(data: web::Data<Arc<AppState>>) -> HttpResponse {
    data.player.lock().unload_ir();
    HttpResponse::Ok().json(ApiResponse::success("IR unloaded"))
}

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

async fn get_ir_status(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let player = data.player.lock();

    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "ir": {
            "loaded": player.is_ir_loaded()
        }
    }))
}
