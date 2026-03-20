use super::*;
use actix_web::{web, HttpRequest, HttpResponse};
use actix_ws::{self, Message};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::time::interval;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/ws", web::get().to(websocket));
}

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

    let (close_tx, mut close_rx) = oneshot::channel::<()>();

    let mut session_for_recv = session.clone();
    actix_rt::spawn(async move {
        while let Some(Ok(msg)) = msg_stream.recv().await {
            match msg {
                Message::Close(_) => {
                    let _ = session_for_recv.close(None).await;
                    let _ = close_tx.send(());
                    return;
                }
                Message::Ping(bytes) => {
                    let _ = session_for_recv.pong(&bytes).await;
                }
                Message::Text(_) | Message::Binary(_) => {}
                _ => {}
            }
        }
    });

    actix_rt::spawn(async move {
        let mut timer = interval(Duration::from_millis(50));
        let mut last_spectrum: Vec<f32> = Vec::new();
        let mut idle_ticks: u32 = 0;
        let mut last_load_progress: u64 = 0;
        let mut last_preload_sent = false;  // FIX for Defect 4: track if preload was already sent

        loop {
            tokio::select! {
                _ = &mut close_rx => {
                    break;
                }
                _ = timer.tick() => {
                    let is_playing = matches!(
                        *shared_state.state.read(),
                        crate::player::PlayerState::Playing
                    );

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

                    // FIX for Defect 4: Use load() but only send if we haven't sent
                    // for this preload cycle already. Reset tracking when needs_preload
                    // goes from true→false (i.e., gapless system clears it).
                    let needs_preload_now = shared_state.needs_preload.load(std::sync::atomic::Ordering::Acquire);
                    if needs_preload_now && !last_preload_sent {
                        last_preload_sent = true;
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
                    }
                    if !needs_preload_now && last_preload_sent {
                        // Reset once gapless system clears the flag, ready for next cycle
                        last_preload_sent = false;
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
                        break;
                    }
                }
            }
        }
    });

    Ok(response)
}
