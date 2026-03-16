use active_win_pos_rs::get_active_window;
use arboard::{Clipboard, GetExtLinux, LinuxClipboardKind};
use log::info;
use std::time::{Duration, Instant};

use crate::capture_linux_x11_event::X11SelectionEventBackend;
use crate::capture_linux_wayland::LinuxWaylandEventSource;
use crate::capture_linux_x11::LinuxX11EventSource;
use crate::windows_event_source::SelectionSignal;

const X11_SHADOW_REPORT_INTERVAL_SECS: u64 = 30;
const X11_SHADOW_REPORT_MIN_DELTA: u64 = 12;
const X11_SHADOW_PROMOTION_MIN_COMPARE: u64 = 80;
const X11_SHADOW_PROMOTION_MAX_DRIFT_PCT: f64 = 18.0;
const X11_SHADOW_DEMOTION_MIN_COMPARE: u64 = 80;
const X11_SHADOW_DEMOTION_DRIFT_PCT: f64 = 55.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxSessionKind {
    X11,
    Wayland,
    Unknown,
}

pub trait LinuxSelectionEventProvider: Send + std::fmt::Debug {
    fn poll_signal(&mut self) -> Option<SelectionSignal>;
    fn has_global_selection_event(&self) -> bool;
    // 问题4修复：添加 set_debounce_ms 方法
    fn set_debounce_ms(&mut self, _ms: u64) {}
}

#[derive(Debug, Default)]
struct X11ShadowStats {
    backend_events: u64,
    fallback_events: u64,
    backend_only: u64,
    fallback_only: u64,
    both_events: u64,
    last_report_total: u64,
    last_report_at: Option<Instant>,
}

impl X11ShadowStats {
    fn record(&mut self, backend_signal: bool, fallback_signal: bool) {
        match (backend_signal, fallback_signal) {
            (true, true) => {
                self.backend_events += 1;
                self.fallback_events += 1;
                self.both_events += 1;
            }
            (true, false) => {
                self.backend_events += 1;
                self.backend_only += 1;
            }
            (false, true) => {
                self.fallback_events += 1;
                self.fallback_only += 1;
            }
            (false, false) => {}
        }
    }

    fn maybe_report(&mut self) {
        let total = self.total_compared();
        if total == 0 {
            return;
        }

        let delta = total.saturating_sub(self.last_report_total);
        if delta < X11_SHADOW_REPORT_MIN_DELTA {
            return;
        }

        let report_due = self
            .last_report_at
            .map(|value| value.elapsed() >= Duration::from_secs(X11_SHADOW_REPORT_INTERVAL_SECS))
            .unwrap_or(true);

        if !report_due {
            return;
        }

        let drift_pct = self.drift_pct();

        info!(
            "[LinuxX11Shadow] compared={} backend={} fallback={} both={} backend_only={} fallback_only={} drift={:.1}%",
            total,
            self.backend_events,
            self.fallback_events,
            self.both_events,
            self.backend_only,
            self.fallback_only,
            drift_pct
        );

        self.last_report_total = total;
        self.last_report_at = Some(Instant::now());
    }

    fn total_compared(&self) -> u64 {
        self.backend_only + self.fallback_only + self.both_events
    }

    fn drift_pct(&self) -> f64 {
        let total = self.total_compared();
        if total == 0 {
            return 0.0;
        }
        ((self.backend_only + self.fallback_only) as f64 * 100.0) / total as f64
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum X11SelectionMode {
    ShadowVerify,
    EventPreferred,
    PollingFallback,
}

#[derive(Debug)]
pub struct LinuxX11SelectionEventProvider {
    event_backend: Option<X11SelectionEventBackend>,
    fallback: LinuxX11EventSource,
    shadow_stats: X11ShadowStats,
    mode: X11SelectionMode,
    debounce_ms: u64,
}

impl LinuxX11SelectionEventProvider {
    pub fn new() -> Self {
        let event_backend = X11SelectionEventBackend::connect();
        let event_ready = event_backend.is_some();
        if event_ready {
            info!(
                "[LinuxX11Shadow] Verification enabled. promotion_if(compared>={} && drift<={:.1}%), demotion_if(compared>={} && drift>={:.1}%)",
                X11_SHADOW_PROMOTION_MIN_COMPARE,
                X11_SHADOW_PROMOTION_MAX_DRIFT_PCT,
                X11_SHADOW_DEMOTION_MIN_COMPARE,
                X11_SHADOW_DEMOTION_DRIFT_PCT
            );
        }
        Self {
            event_backend,
            fallback: LinuxX11EventSource::new(),
            shadow_stats: X11ShadowStats::default(),
            mode: if event_ready {
                X11SelectionMode::ShadowVerify
            } else {
                X11SelectionMode::PollingFallback
            },
            debounce_ms: 80,
        }
    }

    fn evaluate_shadow_decision(&mut self) {
        let compared = self.shadow_stats.total_compared();
        let drift = self.shadow_stats.drift_pct();

        if self.mode == X11SelectionMode::ShadowVerify
            && compared >= X11_SHADOW_PROMOTION_MIN_COMPARE
            && drift <= X11_SHADOW_PROMOTION_MAX_DRIFT_PCT
        {
            self.mode = X11SelectionMode::EventPreferred;
            info!(
                "[LinuxX11Shadow] Promoted to X11 event default. compared={} drift={:.1}%",
                compared,
                drift
            );
            return;
        }

        if matches!(self.mode, X11SelectionMode::ShadowVerify | X11SelectionMode::EventPreferred)
            && compared >= X11_SHADOW_DEMOTION_MIN_COMPARE
            && drift >= X11_SHADOW_DEMOTION_DRIFT_PCT
        {
            self.mode = X11SelectionMode::PollingFallback;
            self.event_backend = None;
            info!(
                "[LinuxX11Shadow] Demoted to polling fallback. compared={} drift={:.1}%",
                compared,
                drift
            );
        }
    }
}

impl LinuxSelectionEventProvider for LinuxX11SelectionEventProvider {
    fn poll_signal(&mut self) -> Option<SelectionSignal> {
        if let Some(backend) = &mut self.event_backend {
            // 问题4修复：传递 debounce_ms 给 backend
            let backend_signal = backend.poll_signal(self.debounce_ms);
            let fallback_signal = self.fallback.poll_signal();

            self.shadow_stats
                .record(backend_signal.is_some(), fallback_signal.is_some());
            self.shadow_stats.maybe_report();
            self.evaluate_shadow_decision();

            return match self.mode {
                X11SelectionMode::ShadowVerify => fallback_signal.or(backend_signal),
                X11SelectionMode::EventPreferred => backend_signal.or(fallback_signal),
                X11SelectionMode::PollingFallback => fallback_signal,
            };
        }

        self.mode = X11SelectionMode::PollingFallback;
        self.fallback.poll_signal()
    }

    fn has_global_selection_event(&self) -> bool {
        self.event_backend.is_some() || self.mode == X11SelectionMode::EventPreferred
    }

    fn set_debounce_ms(&mut self, ms: u64) {
        self.debounce_ms = ms;
    }
}

#[derive(Debug)]
pub struct LinuxWaylandSelectionEventProvider {
    inner: LinuxWaylandEventSource,
}

impl LinuxWaylandSelectionEventProvider {
    pub fn new() -> Self {
        Self {
            inner: LinuxWaylandEventSource::new(),
        }
    }
}

impl LinuxSelectionEventProvider for LinuxWaylandSelectionEventProvider {
    fn poll_signal(&mut self) -> Option<SelectionSignal> {
        self.inner.poll_signal()
    }

    fn has_global_selection_event(&self) -> bool {
        false
    }
}

pub fn create_linux_selection_event_provider(
    session_kind: LinuxSessionKind,
) -> Box<dyn LinuxSelectionEventProvider> {
    match session_kind {
        LinuxSessionKind::X11 => Box::new(LinuxX11SelectionEventProvider::new()),
        LinuxSessionKind::Wayland | LinuxSessionKind::Unknown => {
            Box::new(LinuxWaylandSelectionEventProvider::new())
        }
    }
}

#[derive(Debug, Clone)]
pub struct LinuxSessionInfo {
    pub kind: LinuxSessionKind,
    pub confidence: u8,
    pub reason: String,
}

pub trait LinuxSessionDetector: Send + Sync {
    fn detect_session(&self) -> LinuxSessionInfo;
}

#[derive(Debug, Default)]
pub struct EnvLinuxSessionDetector;

impl LinuxSessionDetector for EnvLinuxSessionDetector {
    fn detect_session(&self) -> LinuxSessionInfo {
        let wayland_display = std::env::var("WAYLAND_DISPLAY")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let x11_display = std::env::var("DISPLAY")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let session_type = std::env::var("XDG_SESSION_TYPE")
            .ok()
            .map(|value| value.trim().to_lowercase())
            .filter(|value| !value.is_empty());

        if wayland_display.is_some() {
            return LinuxSessionInfo {
                kind: LinuxSessionKind::Wayland,
                confidence: 95,
                reason: "WAYLAND_DISPLAY detected".to_string(),
            };
        }

        if let Some(session) = &session_type {
            if session == "wayland" {
                return LinuxSessionInfo {
                    kind: LinuxSessionKind::Wayland,
                    confidence: 80,
                    reason: "XDG_SESSION_TYPE=wayland".to_string(),
                };
            }
        }

        if x11_display.is_some() {
            return LinuxSessionInfo {
                kind: LinuxSessionKind::X11,
                confidence: 85,
                reason: "DISPLAY detected".to_string(),
            };
        }

        if let Some(session) = &session_type {
            if session == "x11" {
                return LinuxSessionInfo {
                    kind: LinuxSessionKind::X11,
                    confidence: 70,
                    reason: "XDG_SESSION_TYPE=x11".to_string(),
                };
            }
        }

        LinuxSessionInfo {
            kind: LinuxSessionKind::Unknown,
            confidence: 30,
            reason: "No DISPLAY/WAYLAND_DISPLAY/XDG_SESSION_TYPE signal".to_string(),
        }
    }
}

pub trait LinuxTextProvider: Send {
    fn read_selected_text(&mut self, keyboard_triggered: bool) -> Option<String>;
}

#[derive(Debug)]
pub struct LinuxClipboardSelectionProvider {
    session_kind: LinuxSessionKind,
}

impl LinuxClipboardSelectionProvider {
    pub fn new(session_kind: LinuxSessionKind) -> Self {
        Self { session_kind }
    }
}

impl LinuxTextProvider for LinuxClipboardSelectionProvider {
    fn read_selected_text(&mut self, keyboard_triggered: bool) -> Option<String> {
        let mut clipboard = Clipboard::new().ok()?;

        let clipboard_text = clipboard
            .get()
            .clipboard(LinuxClipboardKind::Clipboard)
            .text()
            .ok();

        let primary_text = if self.session_kind == LinuxSessionKind::X11 {
            clipboard
                .get()
                .clipboard(LinuxClipboardKind::Primary)
                .text()
                .ok()
        } else {
            None
        };

        let prefer_primary = !keyboard_triggered && self.session_kind == LinuxSessionKind::X11;
        if prefer_primary {
            normalize_text_option(primary_text).or_else(|| normalize_text_option(clipboard_text))
        } else {
            normalize_text_option(clipboard_text).or_else(|| normalize_text_option(primary_text))
        }
    }
}

pub trait LinuxWindowInfoProvider: Send + Sync {
    fn get_active_window_info(&self) -> Option<(String, String)>;
    fn is_window_info_available(&self) -> bool;
    fn availability_reason(&self) -> &'static str;
}

#[derive(Debug)]
pub struct ActiveWinPosWindowInfoProvider {
    session_kind: LinuxSessionKind,
}

impl ActiveWinPosWindowInfoProvider {
    pub fn new(session_kind: LinuxSessionKind) -> Self {
        Self { session_kind }
    }
}

impl LinuxWindowInfoProvider for ActiveWinPosWindowInfoProvider {
    fn get_active_window_info(&self) -> Option<(String, String)> {
        if !self.is_window_info_available() {
            return None;
        }

        match get_active_window() {
            Ok(monitor) => {
                let title = monitor.title;
                let window_class = format!("window_{}", monitor.window_id);
                Some((title, window_class))
            }
            Err(_) => None,
        }
    }

    fn is_window_info_available(&self) -> bool {
        self.session_kind != LinuxSessionKind::Wayland
    }

    fn availability_reason(&self) -> &'static str {
        if self.is_window_info_available() {
            "window metadata available"
        } else {
            "Wayland window metadata restricted"
        }
    }
}

fn normalize_text_option(value: Option<String>) -> Option<String> {
    value
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty())
}
