use super::*;
use actix_web::{web, HttpResponse};
use std::sync::Arc;

fn not_implemented_error(err: &str) -> bool {
    err.to_ascii_lowercase().contains("not yet implemented")
}

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/set_eq", web::post().to(set_eq))
        .route("/set_eq_type", web::post().to(set_eq_type))
        .route("/configure_optimizations", web::post().to(configure_optimizations))
        .route("/crossfeed", web::get().to(get_crossfeed))
        .route("/set_crossfeed", web::post().to(set_crossfeed))
        .route("/saturation", web::get().to(get_saturation))
        .route("/set_saturation", web::post().to(set_saturation))
        .route("/dynamic_loudness", web::get().to(get_dynamic_loudness))
        .route("/set_dynamic_loudness", web::post().to(set_dynamic_loudness))
        .route("/noise_shaper_curve", web::get().to(get_noise_shaper_curve))
        .route("/set_noise_shaper_curve", web::post().to(set_noise_shaper_curve))
        .route("/configure_output_bits", web::post().to(configure_output_bits));
}

async fn set_eq(
    data: web::Data<Arc<AppState>>,
    body: web::Json<SetEqRequest>,
) -> HttpResponse {
    let mut player = data.player.lock();

    let is_fir = player.is_fir_eq_enabled();

    if is_fir {
        if let Some(enabled) = body.enabled {
            if !enabled {
                player.disable_fir_eq();
            }
        }

        if let Some(ref bands) = body.bands {
            let band_map: std::collections::HashMap<&str, usize> = [
                ("31", 0),
                ("62", 1),
                ("125", 2),
                ("250", 3),
                ("500", 4),
                ("1000", 5),
                ("2000", 6),
                ("4000", 7),
                ("8000", 8),
                ("16000", 9),
                ("1k", 5),
                ("2k", 6),
                ("4k", 7),
                ("8k", 8),
                ("16k", 9),
            ]
            .into_iter()
            .collect();

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

    if let Some(enabled) = body.enabled {
        player.lockfree_eq_params.set_enabled(enabled);
    }

    if let Some(ref bands) = body.bands {
        let band_map: std::collections::HashMap<&str, usize> = [
            ("31", 0),
            ("62", 1),
            ("125", 2),
            ("250", 3),
            ("500", 4),
            ("1000", 5),
            ("2000", 6),
            ("4000", 7),
            ("8000", 8),
            ("16000", 9),
            ("1k", 5),
            ("2k", 6),
            ("4k", 7),
            ("8k", 8),
            ("16k", 9),
        ]
        .into_iter()
        .collect();

        for (name, &gain) in bands {
            if let Some(&idx) = band_map.get(name.as_str()) {
                player.lockfree_eq_params.set_band_gain(idx, gain);
            } else {
                log::warn!("Unknown EQ band name: '{}'", name);
            }
        }
    }

    *player.shared_state().eq_type.write() = "IIR".to_string();

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
            let mut player = data.player.lock();
            player.disable_fir_eq();
            *player.shared_state().eq_type.write() = "IIR".to_string();
            HttpResponse::Ok().json(ApiResponse::success("EQ type set to IIR"))
        }
        "FIR" => {
            let num_taps = body.fir_taps.unwrap_or(1023);
            let mut player = data.player.lock();
            match player.enable_fir_eq(num_taps) {
                Ok(()) => {
                    *player.shared_state().eq_type.write() = "FIR".to_string();
                    HttpResponse::Ok().json(ApiResponse::success(&format!(
                        "FIR EQ enabled with {} taps",
                        num_taps
                    )))
                }
                Err(e) => {
                    if not_implemented_error(&e) {
                        HttpResponse::NotImplemented().json(ApiResponse::error(&e))
                    } else {
                        HttpResponse::InternalServerError().json(ApiResponse::error(&e))
                    }
                }
            }
        }
        _ => HttpResponse::BadRequest().json(ApiResponse::error(&format!(
            "Unknown EQ type: '{}'. Supported types: IIR, FIR",
            body.eq_type
        ))),
    }
}

async fn configure_optimizations(
    data: web::Data<Arc<AppState>>,
    body: web::Json<ConfigureOptimizationsRequest>,
) -> HttpResponse {
    let mut player = data.player.lock();

    if let Some(dither) = body.dither_enabled {
        player.dither_enabled = dither;
        player.lockfree_noise_shaper_params.set_enabled(dither);
    }

    if let Some(rg) = body.replaygain_enabled {
        player.replaygain_enabled = rg;
    }

    HttpResponse::Ok().json(ApiResponse::success_with_state(
        "Optimizations updated",
        get_player_state(&player),
    ))
}

async fn set_crossfeed(
    data: web::Data<Arc<AppState>>,
    body: web::Json<SetCrossfeedRequest>,
) -> HttpResponse {
    let player = data.player.lock();

    if let Some(enabled) = body.enabled {
        player.set_crossfeed_enabled(enabled);
    }
    if let Some(mix) = body.mix {
        player.set_crossfeed_mix(mix);
    }

    let settings = player.get_crossfeed_info();
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
    let settings = player.get_crossfeed_info();

    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "crossfeed": {
            "enabled": settings.enabled,
            "mix": settings.mix
        }
    }))
}

async fn set_saturation(
    data: web::Data<Arc<AppState>>,
    body: web::Json<SetSaturationRequest>,
) -> HttpResponse {
    let player = data.player.lock();

    if let Some(enabled) = body.enabled {
        player.set_saturation_enabled(enabled);
    }
    if let Some(drive) = body.drive {
        player.set_saturation_drive(drive);
    }
    if let Some(threshold) = body.threshold {
        player.lockfree_saturation_params.set_threshold(threshold);
    }
    if let Some(mix) = body.mix {
        player.set_saturation_mix(mix);
    }
    if let Some(input_gain_db) = body.input_gain_db {
        player.lockfree_saturation_params.set_input_gain(input_gain_db);
    }
    if let Some(output_gain_db) = body.output_gain_db {
        player.lockfree_saturation_params.set_output_gain(output_gain_db);
    }
    if let Some(highpass_mode) = body.highpass_mode {
        player.lockfree_saturation_params.set_highpass_mode(highpass_mode);
    }
    if let Some(highpass_cutoff) = body.highpass_cutoff {
        player
            .lockfree_saturation_params
            .set_highpass_cutoff(highpass_cutoff);
    }

    let settings = player.get_saturation_info();
    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "message": "Saturation updated",
        "saturation": settings
    }))
}

async fn get_saturation(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let player = data.player.lock();
    let settings = player.get_saturation_info();

    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "saturation": settings
    }))
}

async fn set_dynamic_loudness(
    data: web::Data<Arc<AppState>>,
    body: web::Json<SetDynamicLoudnessRequest>,
) -> HttpResponse {
    let player = data.player.lock();

    if let Some(enabled) = body.enabled {
        player.set_dynamic_loudness_enabled(enabled);
    }
    if let Some(strength) = body.strength {
        if !(0.0..=1.0).contains(&strength) {
            return HttpResponse::BadRequest()
                .json(ApiResponse::error("Strength must be between 0.0 and 1.0"));
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

async fn set_noise_shaper_curve(
    data: web::Data<Arc<AppState>>,
    body: web::Json<SetNoiseShaperCurveRequest>,
) -> HttpResponse {
    let curve = match body.curve.to_ascii_lowercase().as_str() {
        "lipshitz5" => crate::processor::NoiseShaperCurve::Lipshitz5,
        "fweighted9" => crate::processor::NoiseShaperCurve::FWeighted9,
        "modifiede9" => crate::processor::NoiseShaperCurve::ModifiedE9,
        "improvede9" => crate::processor::NoiseShaperCurve::ImprovedE9,
        "tpdfonly" => crate::processor::NoiseShaperCurve::TpdfOnly,
        _ => {
            return HttpResponse::BadRequest().json(ApiResponse::error(&format!(
                "Unknown noise shaper curve '{}'. Supported: Lipshitz5, FWeighted9, ModifiedE9, ImprovedE9, TpdfOnly",
                body.curve
            )));
        }
    };

    let player = data.player.lock();
    if let Err(e) = player.set_noise_shaper_curve(curve) {
        return HttpResponse::InternalServerError().json(ApiResponse::error(&e));
    }

    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "message": format!("Noise shaper curve set to {:?}", curve),
        "noise_shaper": {
            "curve": format!("{:?}", curve),
            "enabled": player.dither_enabled,
            "bits": player.get_output_bits()
        }
    }))
}

async fn get_noise_shaper_curve(data: web::Data<Arc<AppState>>) -> HttpResponse {
    let player = data.player.lock();
    let curve = player.get_noise_shaper_curve();

    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "noise_shaper": {
            "curve": curve,
            "enabled": player.dither_enabled,
            "bits": player.get_output_bits()
        }
    }))
}

async fn configure_output_bits(
    data: web::Data<Arc<AppState>>,
    body: web::Json<SetOutputBitsRequest>,
) -> HttpResponse {
    if body.bits != 16 && body.bits != 24 && body.bits != 32 {
        return HttpResponse::BadRequest()
            .json(ApiResponse::error("Invalid bit depth. Supported: 16, 24, 32"));
    }

    let player = data.player.lock();
    player.set_output_bits(body.bits);

    HttpResponse::Ok().json(serde_json::json!({
        "status": "success",
        "message": format!("Output bit depth set to {} bits", body.bits)
    }))
}
