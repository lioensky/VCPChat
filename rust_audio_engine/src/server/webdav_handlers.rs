use super::*;
use actix_web::{web, HttpResponse};
use std::sync::Arc;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/webdav/configure", web::post().to(webdav_configure))
        .route("/webdav/browse", web::get().to(webdav_browse));
}

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
        return HttpResponse::BadRequest().json(ApiResponse::error("WebDAV not configured"));
    }
    let path = query.path.as_deref().unwrap_or("/").to_string();

    let cfg_clone = cfg.clone();
    let path_for_block = path.clone();
    let result = run_analysis_job(&data, move || {
        cfg_clone
            .list(&path_for_block)
            .map_err(|e| format!("WebDAV list failed: {}", e))
    })
    .await;

    match result {
        Ok(entries) => HttpResponse::Ok().json(serde_json::json!({
            "status": "success",
            "path": path,
            "entries": entries,
        })),
        Err(e) => {
            if e.to_ascii_lowercase().contains("timed out") {
                HttpResponse::GatewayTimeout().json(ApiResponse::error(&e))
            } else {
                HttpResponse::InternalServerError().json(ApiResponse::error(&e))
            }
        }
    }
}
