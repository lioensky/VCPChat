//! WebSocket push channel.
//!
//! One hub task per process reads the shared player state, turns event flags
//! into messages and broadcasts them to every connection. (Each connection
//! used to drain the event bitmask itself, so with two clients every event
//! reached only one of them, and gapless metadata was never copied when no
//! client was connected.)
//!
//! Protocol (text frames are JSON):
//! - server → client on connect: `hello` (protocol version and features), then
//!   the current `playback_state`.
//! - `playback_state`: sent immediately on any discrete change (play state,
//!   track, duration, load id, applied command sequence, buffering) and every
//!   250 ms while playing. Clients interpolate the position in between.
//! - legacy events kept unchanged for older front ends: `load_complete`
//!   (now with `load_id`), `load_error`, `loading_progress`, `track_changed`,
//!   `playback_ended`, `needs_preload`.
//! - spectrum: JSON `spectrum_data` by default. After the client sends
//!   `{"type":"subscribe","spectrum":"binary"}` it gets binary frames instead:
//!   `[u8 kind=1][u8 version=1][u16 LE bin count N][N × f32 LE]`.

use super::*;
use actix_web::web::Bytes;
use actix_web::{web, HttpRequest, HttpResponse};
use actix_ws::{self, Message};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;
use tokio::time::interval;

use crate::player::{
    PlayerState, SharedState, EVENT_LOAD_COMPLETE, EVENT_LOAD_ERROR, EVENT_NEEDS_PRELOAD_RESET, EVENT_PLAYBACK_ENDED, EVENT_TRACK_CHANGED,
};

pub const PROTOCOL_VERSION: u32 = 2;
pub const SPECTRUM_FRAME_KIND: u8 = 1;
pub const SPECTRUM_FRAME_VERSION: u8 = 1;

const TICK: Duration = Duration::from_millis(50);
const IDLE_TICK: Duration = Duration::from_millis(200);
const POSITION_PUSH_INTERVAL: Duration = Duration::from_millis(250);

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/ws", web::get().to(websocket));
}

#[derive(Clone)]
enum HubMessage {
    Text(Arc<str>),
    Spectrum { json: Arc<str>, binary: Bytes },
}

struct Hub {
    tx: broadcast::Sender<HubMessage>,
    /// Latest `playback_state`, sent to new connections right after `hello`.
    latest_state: parking_lot::Mutex<Option<Arc<str>>>,
}

static HUB: OnceLock<Arc<Hub>> = OnceLock::new();

fn hub(shared_state: &Arc<SharedState>) -> Arc<Hub> {
    Arc::clone(HUB.get_or_init(|| {
        let (tx, _) = broadcast::channel(64);
        let hub = Arc::new(Hub {
            tx,
            latest_state: parking_lot::Mutex::new(None),
        });
        let task_hub = Arc::clone(&hub);
        let task_state = Arc::clone(shared_state);
        actix_rt::spawn(async move { run_hub(task_hub, task_state).await });
        hub
    }))
}

/// Encode spectrum bins as a binary frame.
pub fn encode_spectrum_frame(bins: &[f32]) -> Vec<u8> {
    let count = bins.len().min(u16::MAX as usize);
    let mut frame = Vec::with_capacity(4 + count * 4);
    frame.push(SPECTRUM_FRAME_KIND);
    frame.push(SPECTRUM_FRAME_VERSION);
    frame.extend_from_slice(&(count as u16).to_le_bytes());
    for value in &bins[..count] {
        frame.extend_from_slice(&value.to_le_bytes());
    }
    frame
}

/// Discrete parts of the playback state; a change in any of them is pushed
/// immediately.
#[derive(Clone, PartialEq)]
struct Discrete {
    state: &'static str,
    file_path: Option<String>,
    duration_ms: u64,
    load_id: u64,
    applied_seq: u64,
    decode_complete: bool,
}

fn state_name(shared: &SharedState) -> &'static str {
    if shared.is_loading.load(Ordering::Acquire) {
        return "loading";
    }
    match shared.state.load() {
        PlayerState::Playing if shared.buffering.load(Ordering::Relaxed) => "buffering",
        PlayerState::Playing => "playing",
        PlayerState::Paused => "paused",
        PlayerState::Stopped => "stopped",
    }
}

fn snapshot(shared: &SharedState) -> Discrete {
    Discrete {
        state: state_name(shared),
        file_path: shared.file_path.read().clone(),
        duration_ms: (shared.duration_secs() * 1000.0).round() as u64,
        load_id: shared.load_generation.load(Ordering::Acquire),
        applied_seq: shared.applied_seq.load(Ordering::Acquire),
        decode_complete: shared.decode_complete(),
    }
}

fn playback_state_json(shared: &SharedState, discrete: &Discrete, rev: u64) -> Arc<str> {
    let volume = shared.volume.load(Ordering::Relaxed) as f64 / 1_000_000.0;
    json!({
        "type": "playback_state",
        "rev": rev,
        "state": discrete.state,
        "is_playing": matches!(discrete.state, "playing" | "buffering"),
        "position": shared.current_time_secs(),
        "duration": discrete.duration_ms as f64 / 1000.0,
        "buffered": shared.buffered_secs(),
        "decode_complete": discrete.decode_complete,
        "file_path": discrete.file_path,
        "load_id": discrete.load_id,
        "applied_seq": discrete.applied_seq,
        "cmd_seq": shared.cmd_seq.load(Ordering::Acquire),
        "volume": volume,
    })
    .to_string()
    .into()
}

async fn run_hub(hub: Arc<Hub>, shared: Arc<SharedState>) {
    let mut timer = interval(TICK);
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut rev: u64 = 0;
    let mut last_discrete: Option<Discrete> = None;
    let mut last_position_push = Instant::now();
    let mut last_spectrum: Vec<f32> = Vec::new();
    let mut last_load_progress: u64 = u64::MAX;
    let mut last_preload_sent = false;
    let mut idle_ticks: u32 = 0;

    let send = |message: HubMessage| {
        // No receivers is fine: state is still kept current for new clients.
        let _ = hub.tx.send(message);
    };
    let text = |value: serde_json::Value| HubMessage::Text(value.to_string().into());

    loop {
        tokio::select! {
            _ = timer.tick() => {}
            _ = shared.event_notify.notified() => {}
        }

        // ── Event bitmask: atomic take-all, once for every client ──
        let events = shared.event_flags.swap(0, Ordering::AcqRel);

        if events & EVENT_TRACK_CHANGED != 0
            && shared.gapless_swap_pending.swap(false, Ordering::AcqRel)
        {
            // The audio callback cannot take locks; copy the pending
            // metadata of a gapless switch here.
            let next_path = shared.pending_file_path.write().take();
            let next_metadata = shared.pending_metadata.write().take();
            if let Some(ref p) = next_path {
                *shared.file_path.write() = Some(p.clone());
            }
            if let Some(meta) = next_metadata {
                *shared.track_metadata.write() = meta;
            }
            *shared.current_track_path.write() = next_path;
        }

        let is_loading = shared.is_loading.load(Ordering::Acquire);
        if is_loading {
            let progress = shared.load_progress.load(Ordering::Relaxed);
            if progress != last_load_progress {
                last_load_progress = progress;
                send(text(json!({ "type": "loading_progress", "progress": progress })));
            }
        } else {
            last_load_progress = u64::MAX;
        }

        if events & EVENT_LOAD_COMPLETE != 0 {
            send(text(json!({
                "type": "load_complete",
                "file_path": shared.file_path.read().clone(),
                "duration": shared.duration_secs(),
                "load_id": shared.load_generation.load(Ordering::Acquire),
                "decode_complete": shared.decode_complete(),
            })));
        }
        if events & EVENT_LOAD_ERROR != 0 {
            let error = shared
                .load_error
                .read()
                .clone()
                .unwrap_or_else(|| "Unknown load error".to_string());
            send(text(json!({
                "type": "load_error",
                "error": error,
                "load_id": shared.load_generation.load(Ordering::Acquire),
            })));
        }
        if events & EVENT_TRACK_CHANGED != 0 {
            send(text(json!({
                "type": "track_changed",
                "file_path": shared.current_track_path.read().clone(),
                "duration": shared.duration_secs(),
            })));
        }
        if events & EVENT_PLAYBACK_ENDED != 0 {
            send(text(json!({ "type": "playback_ended" })));
        }
        if events & EVENT_NEEDS_PRELOAD_RESET != 0 {
            last_preload_sent = false;
        }
        // EVENT_COMMAND_APPLIED / EVENT_DECODE_COMPLETE need no message of
        // their own: they show up as a change in the snapshot below.

        // ── playback_state: on change, plus a position heartbeat ──
        let discrete = snapshot(&shared);
        let is_playing = matches!(discrete.state, "playing" | "buffering");
        let changed = last_discrete.as_ref() != Some(&discrete);
        if changed || (is_playing && last_position_push.elapsed() >= POSITION_PUSH_INTERVAL) {
            rev += 1;
            let message = playback_state_json(&shared, &discrete, rev);
            *hub.latest_state.lock() = Some(Arc::clone(&message));
            send(HubMessage::Text(message));
            last_position_push = Instant::now();
            last_discrete = Some(discrete);
        }

        // ── Gapless preload request ──
        let needs_preload_now = shared.needs_preload.load(Ordering::Acquire);
        if needs_preload_now && !last_preload_sent {
            last_preload_sent = true;
            let pos = shared.position_frames.load(Ordering::Relaxed);
            let total = shared.total_frames.load(Ordering::Relaxed);
            let sr = shared.sample_rate.load(Ordering::Relaxed).max(1);
            let remaining_secs = total.saturating_sub(pos) as f64 / sr as f64;
            send(text(json!({ "type": "needs_preload", "remaining_secs": remaining_secs })));
        }
        if !needs_preload_now && last_preload_sent {
            last_preload_sent = false;
        }

        // ── Spectrum ──
        let spectrum = shared.spectrum_data.lock().clone();
        if is_playing || spectrum != last_spectrum {
            let json_frame: Arc<str> = json!({ "type": "spectrum_data", "data": spectrum })
                .to_string()
                .into();
            let binary = Bytes::from(encode_spectrum_frame(&spectrum));
            last_spectrum = spectrum;
            send(HubMessage::Spectrum { json: json_frame, binary });
        }

        // Idle: slow down. Events accumulate in the bitmask meanwhile.
        if !is_playing && !is_loading {
            idle_ticks = idle_ticks.saturating_add(1);
            if idle_ticks > 40 {
                tokio::select! {
                    _ = tokio::time::sleep(IDLE_TICK) => {}
                    _ = shared.event_notify.notified() => {}
                }
            }
        } else {
            idle_ticks = 0;
        }
    }
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
    let hub = hub(&shared_state);
    let mut rx = hub.tx.subscribe();
    let binary_spectrum = Arc::new(AtomicBool::new(false));
    let (close_tx, mut close_rx) = tokio::sync::oneshot::channel::<()>();

    let mut session_for_recv = session.clone();
    let binary_for_recv = Arc::clone(&binary_spectrum);
    actix_rt::spawn(async move {
        while let Some(Ok(msg)) = msg_stream.recv().await {
            match msg {
                Message::Close(_) => {
                    let _ = session_for_recv.close(None).await;
                    break;
                }
                Message::Ping(bytes) => {
                    let _ = session_for_recv.pong(&bytes).await;
                }
                Message::Text(text) => {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                        if value.get("type").and_then(|v| v.as_str()) == Some("subscribe") {
                            let binary = value.get("spectrum").and_then(|v| v.as_str()) == Some("binary");
                            binary_for_recv.store(binary, Ordering::Relaxed);
                        }
                    }
                }
                _ => {}
            }
        }
        let _ = close_tx.send(());
    });

    let latest_state = hub.latest_state.lock().clone();
    actix_rt::spawn(async move {
        let hello = json!({
            "type": "hello",
            "protocol": PROTOCOL_VERSION,
            "features": ["playback_state", "cmd_seq", "spectrum_binary", "streaming"],
        })
        .to_string();
        if session.text(hello).await.is_err() {
            return;
        }
        if let Some(state) = latest_state {
            if session.text(state.to_string()).await.is_err() {
                return;
            }
        }

        loop {
            tokio::select! {
                _ = &mut close_rx => break,
                message = rx.recv() => {
                    let result = match message {
                        Ok(HubMessage::Text(text)) => session.text(text.to_string()).await,
                        Ok(HubMessage::Spectrum { json, binary }) => {
                            if binary_spectrum.load(Ordering::Relaxed) {
                                session.binary(binary).await
                            } else {
                                session.text(json.to_string()).await
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            // Slow client: skip ahead, but resend the latest state.
                            let latest = hub.latest_state.lock().clone();
                            match latest {
                                Some(state) => session.text(state.to_string()).await,
                                None => Ok(()),
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    };
                    if result.is_err() {
                        break;
                    }
                }
            }
        }
    });

    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spectrum_frame_layout() {
        let frame = encode_spectrum_frame(&[0.5, -1.0, 2.25]);
        assert_eq!(frame.len(), 4 + 3 * 4);
        assert_eq!(frame[0], SPECTRUM_FRAME_KIND);
        assert_eq!(frame[1], SPECTRUM_FRAME_VERSION);
        assert_eq!(u16::from_le_bytes([frame[2], frame[3]]), 3);
        let third = f32::from_le_bytes(frame[12..16].try_into().unwrap());
        assert_eq!(third, 2.25);
    }

    #[test]
    fn state_names_follow_player_state() {
        let shared = SharedState::new();
        assert_eq!(state_name(&shared), "stopped");
        shared.state.store(PlayerState::Playing);
        assert_eq!(state_name(&shared), "playing");
        shared.buffering.store(true, Ordering::Relaxed);
        assert_eq!(state_name(&shared), "buffering");
        shared.is_loading.store(true, Ordering::Release);
        assert_eq!(state_name(&shared), "loading");
    }
}
