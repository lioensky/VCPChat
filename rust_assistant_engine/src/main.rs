mod capture;
mod windows_event_source;
mod uia_selection_provider;
mod metrics;
#[cfg(target_os = "macos")]
mod capture_macos;
#[cfg(target_os = "linux")]
mod capture_linux_x11;
#[cfg(target_os = "linux")]
mod capture_linux_wayland;
#[cfg(target_os = "linux")]
mod capture_linux_x11_event;
#[cfg(target_os = "linux")]
mod linux_platform;

use actix_web::{web, App, HttpResponse, HttpServer};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use log::info;
use lazy_static::lazy_static;
use capture::{GuardRules, SelectionListener, SelectionEvent, current_timestamp};
use metrics::MetricsCollector;

lazy_static! {
    static ref SELECTION_LISTENER: Arc<SelectionListener> = {
        Arc::new(SelectionListener::new())
    };
    
    static ref METRICS: Arc<Mutex<MetricsCollector>> = {
        Arc::new(Mutex::new(MetricsCollector::new()))
    };
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
struct StatusResponse {
    listener_active: bool,
    platform: String,
    backend: String,
    capability_mode: String,
    limited: bool,
    capability_reason: String,
    session_kind: Option<String>,
    session_confidence: Option<u8>,
    window_info_available: Option<bool>,
    selection_read_mode: Option<String>,
    global_selection_event: Option<bool>,
}

#[derive(Deserialize)]
struct SuspendRequest {
    duration_ms: u64,
}

async fn health() -> HttpResponse {
    HttpResponse::Ok().json(HealthResponse {
        status: "ok",
        service: "assistant_core_server",
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn status() -> HttpResponse {
    let capability = SELECTION_LISTENER.get_capability();
    HttpResponse::Ok().json(StatusResponse {
        listener_active: SELECTION_LISTENER.is_active(),
        platform: capability.platform,
        backend: capability.backend,
        capability_mode: capability.mode,
        limited: capability.limited,
        capability_reason: capability.reason,
        session_kind: capability.session_kind,
        session_confidence: capability.session_confidence,
        window_info_available: capability.window_info_available,
        selection_read_mode: capability.selection_read_mode,
        global_selection_event: capability.global_selection_event,
    })
}

async fn start_listener() -> HttpResponse {
    let was_active = SELECTION_LISTENER.is_active();
    SELECTION_LISTENER.start();
    let status = if was_active { "already_running" } else { "started" };
    HttpResponse::Ok().json(serde_json::json!({"status": status, "success": true}))
}

async fn stop_listener() -> HttpResponse {
    let was_active = SELECTION_LISTENER.is_active();
    SELECTION_LISTENER.stop();
    let status = if was_active { "stopped" } else { "already_stopped" };
    HttpResponse::Ok().json(serde_json::json!({"status": status, "success": true}))
}

async fn suspend_listener(payload: web::Json<SuspendRequest>) -> HttpResponse {
    SELECTION_LISTENER.suspend(payload.duration_ms);
    HttpResponse::Ok().json(serde_json::json!({
        "status": "suspended",
        "duration_ms": payload.duration_ms,
        "success": true
    }))
}

async fn set_guard_rules(payload: web::Json<GuardRules>) -> HttpResponse {
    let rules = payload.into_inner();
    SELECTION_LISTENER.set_guard_rules(rules.clone());
    HttpResponse::Ok().json(serde_json::json!({
        "status": "guard_rules_updated",
        "success": true,
        "rules": rules
    }))
}

async fn get_guard_rules() -> HttpResponse {
    let rules = SELECTION_LISTENER.get_guard_rules();
    HttpResponse::Ok().json(rules)
}

async fn get_metrics() -> HttpResponse {
    let metrics = METRICS.lock().unwrap();
    let report = metrics.export_report();
    HttpResponse::Ok().json(report)
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    unsafe {
        // Enforce DPI awareness so that we capture real physical coordinates
        use winapi::um::winuser::SetProcessDPIAware;
        SetProcessDPIAware();
    }

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    let args: Vec<String> = std::env::args().collect();
    let port = args
        .iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(63791);

    let capability = SELECTION_LISTENER.get_capability();
    info!(
        "[Main] Capture capability platform={} backend={} mode={} limited={} session={:?} confidence={:?} window_info={:?} read_mode={:?} global_event={:?} reason={}",
        capability.platform,
        capability.backend,
        capability.mode,
        capability.limited,
        capability.session_kind,
        capability.session_confidence,
        capability.window_info_available,
        capability.selection_read_mode,
        capability.global_selection_event,
        capability.reason
    );

    // Start selection monitoring in background thread
    let listener_clone = Arc::clone(&SELECTION_LISTENER);
    let metrics_clone = Arc::clone(&METRICS);
    
    std::thread::spawn(move || {
        listener_clone.start();
        
        info!("[Main] Selection monitoring loop started");
        listener_clone.run_loop(
                |event: SelectionEvent| {
                // 记录指标（固定为0ms延迟，实际应该从事件创建时戳）
                {
                    let now_ms = current_timestamp();
                    let latency_ms = now_ms.saturating_sub(event.timestamp);
                    let mut metrics = metrics_clone.lock().unwrap();
                    metrics.record_latency(latency_ms);
                }
                
                // 输出事件到 stdout
                let json_str = match serde_json::to_string(&event) {
                    Ok(value) => value,
                    Err(error) => {
                        let mut metrics = metrics_clone.lock().unwrap();
                        metrics.record_error("event_serialize_failed", &error.to_string());
                        "{}".to_string()
                    }
                };
                println!("ASSISTANT_EVENT {}", json_str);

                let text_preview: String = event.text.chars().take(40).collect();
                
                info!("[Event] Text: '{}' at Window: {}", 
                    text_preview,
                    event.window_title
                );
            },
            100, // Poll every 100ms
        );
    });

    println!("RUST_ASSISTANT_READY");

    // Start HTTP server
    info!("[Main] Starting HTTP server on 127.0.0.1:{}", port);
    
    HttpServer::new(|| {
        App::new()
            .route("/health", web::get().to(health))
            .route("/status", web::get().to(status))
            .route("/listener/start", web::post().to(start_listener))
            .route("/listener/stop", web::post().to(stop_listener))
            .route("/listener/suspend", web::post().to(suspend_listener))
            .route("/guard/rules", web::get().to(get_guard_rules))
            .route("/guard/rules", web::post().to(set_guard_rules))
                .route("/metrics", web::get().to(get_metrics))
    })
    .bind(("127.0.0.1", port))?
    .run()
    .await
}
