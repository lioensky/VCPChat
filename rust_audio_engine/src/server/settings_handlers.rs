use super::*;
use actix_web::{web, HttpResponse};
use serde::Deserialize;
use std::sync::Arc;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/settings", web::get().to(get_settings))
        .route("/save_settings", web::post().to(save_settings));
}

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
    {
        let mut manager = data.settings_manager.lock();
        if let Err(e) = manager.update(body.settings.clone()) {
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "status": "error",
                "message": e
            }));
        }
    }

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
