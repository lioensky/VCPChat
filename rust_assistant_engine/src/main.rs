mod capture;
mod screenshot;
mod table_detection;
mod history;
mod metrics;

use actix_web::{web, App, HttpResponse, HttpServer};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use log::info;
use lazy_static::lazy_static;
use capture::{GuardRules, SelectionListener, SelectionEvent, SelectionRecord};
use history::SelectionHistory;
use metrics::MetricsCollector;

lazy_static! {
    static ref SELECTION_LISTENER: Arc<SelectionListener> = {
        Arc::new(SelectionListener::new())
    };
    
    static ref SELECTION_HISTORY: Arc<Mutex<SelectionHistory>> = {
        Arc::new(Mutex::new(SelectionHistory::new(100)))
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
    HttpResponse::Ok().json(StatusResponse {
        listener_active: SELECTION_LISTENER.is_active(),
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

async fn get_history() -> HttpResponse {
    let history = SELECTION_HISTORY.lock().unwrap();
    let json_str = history.export_json().unwrap_or_else(|_| "[]".to_string());
    match serde_json::from_str::<serde_json::Value>(&json_str) {
        Ok(value) => HttpResponse::Ok().json(value),
        Err(_) => HttpResponse::InternalServerError().json(
            serde_json::json!({"error": "Failed to parse history"})
        ),
    }
}

async fn get_context() -> HttpResponse {
    let history = SELECTION_HISTORY.lock().unwrap();
    let stats = history.get_stats();
    HttpResponse::Ok().json(stats)
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
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

    // Start selection monitoring in background thread
    let listener_clone = Arc::clone(&SELECTION_LISTENER);
    let history_clone = Arc::clone(&SELECTION_HISTORY);
    let metrics_clone = Arc::clone(&METRICS);
    
    std::thread::spawn(move || {
        listener_clone.start();
        
        info!("[Main] Selection monitoring loop started");
        listener_clone.run_loop(
                |event: SelectionEvent| {
                // 记录到历史对话
                {
                    let mut history = history_clone.lock().unwrap();
                    history.push(SelectionRecord {
                        text: event.text.clone(),
                        window_title: event.window_title.clone(),
                        timestamp: event.timestamp,
                        mouse_x: event.mouse_x,
                        mouse_y: event.mouse_y,
                    });
                }
                
                // 记录指标（固定为0ms延迟，实际应该从事件创建时戳）
                {
                    let mut metrics = metrics_clone.lock().unwrap();
                    metrics.record_latency(0);
                }
                
                // 输出事件到 stdout
                let json_str = serde_json::to_string(&event)
                    .unwrap_or_else(|_| "{}".to_string());
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
            .route("/history", web::get().to(get_history))
            .route("/context", web::get().to(get_context))
    })
    .bind(("127.0.0.1", port))?
    .run()
    .await
}
