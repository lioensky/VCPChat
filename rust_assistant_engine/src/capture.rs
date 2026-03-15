use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, RwLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use active_win_pos_rs::get_active_window;
use arboard::Clipboard;
use lazy_static::lazy_static;
use log::info;
use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
use crate::capture_macos::MacosEventSource;
#[cfg(target_os = "linux")]
use crate::linux_platform::{
    create_linux_selection_event_provider, ActiveWinPosWindowInfoProvider,
    EnvLinuxSessionDetector, LinuxClipboardSelectionProvider, LinuxSelectionEventProvider,
    LinuxSessionDetector, LinuxSessionInfo, LinuxSessionKind, LinuxTextProvider,
    LinuxWindowInfoProvider,
};
#[cfg(target_os = "macos")]
use crate::uia_selection_provider::macos_ax_trusted;
use crate::uia_selection_provider::UiaSelectionProvider;
use crate::windows_event_source::SelectionSignal;
#[cfg(target_os = "windows")]
use crate::windows_event_source::WindowsEventSource;

const MIN_EVENT_INTERVAL_MS: u64 = 80;
const MIN_DISTANCE: i32 = 8;
const SCREENSHOT_SUSPEND_MS: u64 = 3000;
const CLIPBOARD_CONFLICT_SUSPEND_MS: u64 = 1000;
const CLIPBOARD_CHECK_INTERVAL_MS: u64 = 500;

// 问题2修复：存储本程序最近写入剪贴板的内容，用于区分本程序写入和外部写入
lazy_static! {
    static ref OWN_CLIPBOARD_CONTENT: RwLock<Option<String>> = RwLock::new(None);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectionEvent {
    pub text: String,
    pub mouse_x: i32,
    pub mouse_y: i32,
    pub window_title: String,
    pub window_class: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuardRules {
    pub whitelist: Vec<String>,
    pub blacklist: Vec<String>,
    pub screenshot_apps: Vec<String>,
    #[serde(default = "default_min_event_interval_ms")]
    pub min_event_interval_ms: u64,
    #[serde(default = "default_min_distance")]
    pub min_distance: i32,
    #[serde(default = "default_screenshot_suspend_ms")]
    pub screenshot_suspend_ms: u64,
    #[serde(default = "default_clipboard_conflict_suspend_ms")]
    pub clipboard_conflict_suspend_ms: u64,
    #[serde(default = "default_clipboard_check_interval_ms")]
    pub clipboard_check_interval_ms: u64,
    #[serde(default)]
    pub own_window_handles: Vec<String>,
    #[serde(default)]
    pub own_process_ids: Vec<u32>,
    #[serde(default = "default_x11_debounce_ms")]
    pub x11_debounce_ms: u64,
}

fn default_min_event_interval_ms() -> u64 { MIN_EVENT_INTERVAL_MS }
fn default_min_distance() -> i32 { MIN_DISTANCE }
fn default_screenshot_suspend_ms() -> u64 { SCREENSHOT_SUSPEND_MS }
fn default_clipboard_conflict_suspend_ms() -> u64 { CLIPBOARD_CONFLICT_SUSPEND_MS }
fn default_clipboard_check_interval_ms() -> u64 { CLIPBOARD_CHECK_INTERVAL_MS }
fn default_x11_debounce_ms() -> u64 { 80 }

impl Default for GuardRules {
    fn default() -> Self {
        Self {
            whitelist: vec![],
            blacklist: vec![
                "password".to_string(),
                "credential".to_string(),
                "vault".to_string(),
                "1password".to_string(),
                "lastpass".to_string(),
                "bitwarden".to_string(),
                "keepass".to_string(),
                "chrome secure shell".to_string(),
                "putty".to_string(),
                "teamviewer".to_string(),
                "anydesk".to_string(),
                "terminal".to_string(),
                "powershell".to_string(),
                "cmd.exe".to_string(),
                "conhost".to_string(),
            ],
            screenshot_apps: vec![
                "snippingtool".to_string(),
                "snipaste".to_string(),
                "sharex".to_string(),
                "qq".to_string(),
                "wechat".to_string(),
            ],
            min_event_interval_ms: MIN_EVENT_INTERVAL_MS,
            min_distance: MIN_DISTANCE,
            screenshot_suspend_ms: SCREENSHOT_SUSPEND_MS,
            clipboard_conflict_suspend_ms: CLIPBOARD_CONFLICT_SUSPEND_MS,
            clipboard_check_interval_ms: CLIPBOARD_CHECK_INTERVAL_MS,
            own_window_handles: vec![],
            own_process_ids: vec![],
            x11_debounce_ms: 80,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct SelectionContext {
    pub last_text: String,
    pub last_event_time: u64,
    pub suspension_end_time: u64,
    pub last_clipboard_snapshot: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureCapability {
    pub platform: String,
    pub backend: String,
    pub mode: String,
    pub limited: bool,
    pub reason: String,
    #[serde(default)]
    pub session_kind: Option<String>,
    #[serde(default)]
    pub session_confidence: Option<u8>,
    #[serde(default)]
    pub window_info_available: Option<bool>,
    #[serde(default)]
    pub selection_read_mode: Option<String>,
    #[serde(default)]
    pub global_selection_event: Option<bool>,
}

#[derive(Debug)]
enum PlatformEventSource {
    #[cfg(target_os = "windows")]
    Windows(WindowsEventSource),
    #[cfg(target_os = "macos")]
    Macos(MacosEventSource),
    #[cfg(target_os = "linux")]
    Linux(Box<dyn LinuxSelectionEventProvider>),
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Noop,
}

impl PlatformEventSource {
    fn poll_signal(&mut self) -> Option<SelectionSignal> {
        match self {
            #[cfg(target_os = "windows")]
            Self::Windows(source) => source.poll_signal(),
            #[cfg(target_os = "macos")]
            Self::Macos(source) => source.poll_signal(),
            #[cfg(target_os = "linux")]
            Self::Linux(source) => source.poll_signal(),
            #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
            Self::Noop => None,
        }
    }

    #[cfg(target_os = "linux")]
    fn has_global_selection_event(&self) -> bool {
        match self {
            Self::Linux(source) => source.has_global_selection_event(),
        }
    }
}

#[cfg(target_os = "linux")]
trait LinuxEventSourceFactory: Send + Sync {
    fn create_event_source(&self, session_kind: LinuxSessionKind) -> PlatformEventSource;
    fn build_capability(
        &self,
        session: &LinuxSessionInfo,
        window_info_available: bool,
        window_info_reason: &str,
        global_selection_event: bool,
    ) -> CaptureCapability;
}

#[cfg(target_os = "linux")]
#[derive(Debug, Default)]
struct DefaultLinuxEventSourceFactory;

#[cfg(target_os = "linux")]
impl LinuxEventSourceFactory for DefaultLinuxEventSourceFactory {
    fn create_event_source(&self, session_kind: LinuxSessionKind) -> PlatformEventSource {
        PlatformEventSource::Linux(create_linux_selection_event_provider(session_kind))
    }

    fn build_capability(
        &self,
        session: &LinuxSessionInfo,
        window_info_available: bool,
        window_info_reason: &str,
        global_selection_event: bool,
    ) -> CaptureCapability {
        let (backend, mode, limited, base_reason) = match session.kind {
            LinuxSessionKind::X11 if global_selection_event => (
                "capture_linux_x11_event",
                "partial",
                true,
                "X11 XFixes selection-event mode; text capture via primary/clipboard fallback",
            ),
            LinuxSessionKind::X11 => (
                "capture_linux_x11",
                "partial",
                true,
                "X11 polling trigger mode; text capture via primary/clipboard fallback",
            ),
            LinuxSessionKind::Wayland => (
                "capture_linux_wayland",
                "limited",
                true,
                "Wayland global selection limitations; copy-key restricted mode",
            ),
            LinuxSessionKind::Unknown => (
                "capture_linux_wayland",
                "limited",
                true,
                "Unknown Linux session; using restricted wayland-safe mode",
            ),
        };

        let reason = format!(
            "{} | detect={} (confidence={}%) | window_info={} ({}) | global_event={}",
            base_reason,
            session.reason,
            session.confidence,
            if window_info_available {
                "available"
            } else {
                "unavailable"
            },
            window_info_reason,
            global_selection_event
        );

        let mut capability = capture_capability_base(
            "linux",
            backend,
            mode,
            limited,
            reason,
        );

        capability.session_kind = Some(match session.kind {
                LinuxSessionKind::X11 => "x11".to_string(),
                LinuxSessionKind::Wayland => "wayland".to_string(),
                LinuxSessionKind::Unknown => "unknown".to_string(),
            });
        capability.session_confidence = Some(session.confidence);
        capability.window_info_available = Some(window_info_available);
        capability.selection_read_mode = Some(match session.kind {
                LinuxSessionKind::X11 => "primary_then_clipboard".to_string(),
                LinuxSessionKind::Wayland | LinuxSessionKind::Unknown => {
                    "clipboard_only".to_string()
                }
            });
        capability.global_selection_event = Some(global_selection_event);
        capability
    }
}

pub struct SelectionListener {
    context: Arc<Mutex<SelectionContext>>,
    active: Arc<Mutex<bool>>,
    guard_rules: Arc<Mutex<GuardRules>>,
    event_source: Arc<Mutex<PlatformEventSource>>,
    uia_provider: Arc<UiaSelectionProvider>,
    #[cfg(target_os = "linux")]
    linux_text_provider: Arc<Mutex<Box<dyn LinuxTextProvider>>>,
    #[cfg(target_os = "linux")]
    linux_window_info_provider: Arc<dyn LinuxWindowInfoProvider>,
    clipboard_monitor_running: Arc<AtomicBool>,
    clipboard_monitor_stop_signal: Arc<(Mutex<bool>, Condvar)>,
    capability: CaptureCapability,
    run_loop_active: Arc<AtomicBool>,
}

impl SelectionListener {
    #[cfg(target_os = "linux")]
    pub fn new() -> Self {
        let (event_source, capability, linux_text_provider, linux_window_info_provider) =
            create_linux_platform_runtime();

        Self {
            context: Arc::new(Mutex::new(SelectionContext::default())),
            active: Arc::new(Mutex::new(false)),
            guard_rules: Arc::new(Mutex::new(GuardRules::default())),
            event_source: Arc::new(Mutex::new(event_source)),
            uia_provider: Arc::new(UiaSelectionProvider::new()),
            linux_text_provider: Arc::new(Mutex::new(linux_text_provider)),
            linux_window_info_provider,
            clipboard_monitor_running: Arc::new(AtomicBool::new(false)),
            clipboard_monitor_stop_signal: Arc::new((Mutex::new(false), Condvar::new())),
            capability,
            run_loop_active: Arc::new(AtomicBool::new(false)),
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub fn new() -> Self {
        let (event_source, capability) = create_platform_event_source();
        Self {
            context: Arc::new(Mutex::new(SelectionContext::default())),
            active: Arc::new(Mutex::new(false)),
            guard_rules: Arc::new(Mutex::new(GuardRules::default())),
            event_source: Arc::new(Mutex::new(event_source)),
            uia_provider: Arc::new(UiaSelectionProvider::new()),
            clipboard_monitor_running: Arc::new(AtomicBool::new(false)),
            clipboard_monitor_stop_signal: Arc::new((Mutex::new(false), Condvar::new())),
            capability,
            run_loop_active: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn start(&self) {
        let mut active = lock_or_recover(&self.active, "active");
        *active = true;
        info!("[SelectionListener] Started");
        
        // Start background clipboard monitor
        self.start_clipboard_monitor();
    }

    pub fn stop(&self) {
        let mut active = lock_or_recover(&self.active, "active");
        *active = false;
        info!("[SelectionListener] Stopped");
        
        // Stop background clipboard monitor
        self.stop_clipboard_monitor();
    }

    pub fn is_active(&self) -> bool {
        *lock_or_recover(&self.active, "active")
    }

    pub fn set_guard_rules(&self, rules: GuardRules) {
        #[cfg(target_os = "linux")]
        let debounce_ms = rules.x11_debounce_ms;
        
        let mut guard_rules = lock_or_recover(&self.guard_rules, "guard_rules");
        *guard_rules = rules;
        drop(guard_rules);
        
        // 问题4修复：同步更新 X11 provider 的 debounce 值
        #[cfg(target_os = "linux")]
        {
            let mut source = lock_or_recover(&self.event_source, "event_source");
            let PlatformEventSource::Linux(provider) = &mut *source else { return };
            provider.set_debounce_ms(debounce_ms);
        }
        
        info!("[SelectionListener] Guard rules updated");
    }

    pub fn get_guard_rules(&self) -> GuardRules {
        lock_or_recover(&self.guard_rules, "guard_rules").clone()
    }

    pub fn get_capability(&self) -> CaptureCapability {
        self.capability.clone()
    }

    #[cfg(target_os = "linux")]
    fn resolve_active_window_info(&self) -> (String, String) {
        self.linux_window_info_provider
            .get_active_window_info()
            .unwrap_or_else(|| (String::from("Unknown"), String::from("Unknown")))
    }

    #[cfg(not(target_os = "linux"))]
    fn resolve_active_window_info(&self) -> (String, String) {
        get_active_window_info()
    }

    #[cfg(target_os = "linux")]
    fn capture_selected_text_fallback_by_provider(&self, keyboard_triggered: bool) -> Option<String> {
        let mut provider = lock_or_recover(&self.linux_text_provider, "linux_text_provider");
        provider.read_selected_text(keyboard_triggered)
    }

    #[cfg(not(target_os = "linux"))]
    fn capture_selected_text_fallback_by_provider(&self, keyboard_triggered: bool) -> Option<String> {
        capture_selected_text_fallback(keyboard_triggered)
    }

    #[cfg(target_os = "linux")]
    fn is_window_info_available(&self) -> bool {
        self.linux_window_info_provider.is_window_info_available()
    }

    #[cfg(not(target_os = "linux"))]
    fn is_window_info_available(&self) -> bool {
        true
    }

    #[allow(dead_code)]
    pub fn suspend(&self, duration_ms: u64) {
        let now = current_timestamp();
        let mut context = lock_or_recover(&self.context, "context");
        context.suspension_end_time = now + duration_ms;
        info!("[SelectionListener] Suspended for {} ms", duration_ms);
    }

    pub fn poll(&self) -> Option<SelectionEvent> {
        if !self.is_active() {
            return None;
        }

        let signal = {
            let mut source = lock_or_recover(&self.event_source, "event_source");
            source.poll_signal()
        };

        let signal = match signal {
            Some(signal) => signal,
            None => return None,
        };

        let now = current_timestamp();
        let mut context = lock_or_recover(&self.context, "context");
        let guard_rules = lock_or_recover(&self.guard_rules, "guard_rules").clone();

        // Check if suspended (by clipboard monitor or other triggers)
        if now < context.suspension_end_time {
            return None;
        }

        if now.saturating_sub(context.last_event_time) < guard_rules.min_event_interval_ms {
            return None;
        }

        if !signal.keyboard_triggered {
            if is_release_on_own_window(signal.mouse_x, signal.mouse_y, &guard_rules) {
                context.last_event_time = now;
                info!(
                    "[SelectionListener] Skipped: mouse released on assistant window at ({}, {})",
                    signal.mouse_x,
                    signal.mouse_y
                );
                return None;
            }

            if signal.mouse_origin_known && guard_rules.min_distance > 0 {
                let distance = mouse_displacement(
                    signal.mouse_start_x,
                    signal.mouse_start_y,
                    signal.mouse_x,
                    signal.mouse_y,
                );
                if distance < guard_rules.min_distance {
                    context.last_event_time = now;
                    info!(
                        "[SelectionListener] Skipped by displacement pre-check. distance={} < {}",
                        distance,
                        guard_rules.min_distance
                    );
                    return None;
                }
            }
        }

        let (window_title, window_class) = self.resolve_active_window_info();
        let window_info_available = self.is_window_info_available();

        if window_info_available {
            if should_suspend_for_screenshot_app(&window_title, &window_class, &guard_rules) {
                context.suspension_end_time = now + guard_rules.screenshot_suspend_ms;
                context.last_event_time = now;
                info!(
                    "[SelectionListener] Screenshot app detected. Suspended for {} ms. window='{}' class='{}'",
                    guard_rules.screenshot_suspend_ms,
                    window_title,
                    window_class
                );
                return None;
            }

            if should_skip_app(&window_title, &window_class, &guard_rules) {
                context.last_event_time = now;
                info!(
                    "[SelectionListener] Skipped by guard rules. window='{}' class='{}'",
                    window_title,
                    window_class
                );
                return None;
            }
        } else {
            info!(
                "[SelectionListener] Window metadata unavailable; guard-rule window filtering degraded"
            );
        }

        let selected_text = self
            .uia_provider
            .get_selected_text()
            .or_else(|| self.capture_selected_text_fallback_by_provider(signal.keyboard_triggered))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let selected_text = match selected_text {
            Some(value) => value,
            None => {
                info!("[SelectionListener] Selection signal detected but no selected text available");
                return None;
            }
        };

        if selected_text == context.last_text {
            return None;
        }

        context.last_text = selected_text.clone();
        context.last_event_time = now;
        context.last_clipboard_snapshot = selected_text.clone();

        let event = SelectionEvent {
            text: selected_text,
            mouse_x: signal.mouse_x,
            mouse_y: signal.mouse_y,
            window_title,
            window_class,
            timestamp: now,
        };

        info!(
            "[SelectionListener] Detected selection: '{}' at ({}, {})",
            event.text.chars().take(50).collect::<String>(),
            event.mouse_x,
            event.mouse_y
        );

        Some(event)
    }

    fn start_clipboard_monitor(&self) {
        if self
            .clipboard_monitor_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }

        let context = Arc::clone(&self.context);
        let guard_rules = Arc::clone(&self.guard_rules);
        let running = Arc::clone(&self.clipboard_monitor_running);
        let stop_signal = Arc::clone(&self.clipboard_monitor_stop_signal);

        {
            let (lock, _) = &*self.clipboard_monitor_stop_signal;
            let mut stop = lock_or_recover(lock, "clipboard_stop_signal");
            *stop = false;
        }
        
        thread::spawn(move || {
            info!("[ClipboardMonitor] Background monitor started");
            
            // Initialize clipboard snapshot
            if let Some(initial_clipboard) = read_clipboard_text_snapshot() {
                let mut ctx = lock_or_recover(&context, "context");
                if ctx.last_clipboard_snapshot.is_empty() {
                    ctx.last_clipboard_snapshot = initial_clipboard;
                }
            }
            
            while running.load(Ordering::SeqCst) {
                let interval_ms = {
                    let rules = lock_or_recover(&guard_rules, "guard_rules");
                    rules.clipboard_check_interval_ms.max(50)
                };

                let (lock, cvar) = &*stop_signal;
                let stop_guard = lock_or_recover(lock, "clipboard_stop_signal");
                let wait_result = lock_result_or_recover(
                    cvar
                    .wait_timeout_while(
                        stop_guard,
                        Duration::from_millis(interval_ms),
                        |should_stop| !*should_stop,
                    )
                , "clipboard_stop_signal_wait");

                if *wait_result.0 || !running.load(Ordering::SeqCst) {
                    break;
                }
                
                if let Some(current_clipboard) = read_clipboard_text_snapshot() {
                    // 问题2修复：原子性地检测本程序写入并清除标记
                    let is_own_write = {
                        if let Ok(mut content) = OWN_CLIPBOARD_CONTENT.write() {
                            if content.as_ref().map(|c| c == &current_clipboard).unwrap_or(false) {
                                *content = None;  // 消费后清除
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    };

                    if is_own_write {
                        continue;
                    }

                    let mut ctx = lock_or_recover(&context, "context");
                    let rules = lock_or_recover(&guard_rules, "guard_rules");
                    
                    if !ctx.last_clipboard_snapshot.is_empty() 
                        && current_clipboard != ctx.last_clipboard_snapshot {
                        let now = current_timestamp();
                        ctx.suspension_end_time = now + rules.clipboard_conflict_suspend_ms;
                        ctx.last_clipboard_snapshot = current_clipboard.clone();
                        
                        info!(
                            "[ClipboardMonitor] External clipboard change detected. Suspended for {} ms",
                            rules.clipboard_conflict_suspend_ms
                        );
                    }
                }
            }
            
            running.store(false, Ordering::SeqCst);
            info!("[ClipboardMonitor] Background monitor stopped");
        });
    }
    
    fn stop_clipboard_monitor(&self) {
        self.clipboard_monitor_running.store(false, Ordering::SeqCst);
        let (lock, cvar) = &*self.clipboard_monitor_stop_signal;
        let mut stop = lock_or_recover(lock, "clipboard_stop_signal");
        *stop = true;
        cvar.notify_all();
    }

    pub fn run_loop<F>(&self, mut callback: F, poll_interval_ms: u64)
    where
        F: FnMut(SelectionEvent),
    {
        // 问题3修复：防止重入
        if self.run_loop_active
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            info!("[SelectionListener] run_loop already active, skipping duplicate call");
            return;
        }

        info!(
            "[SelectionListener] Starting monitoring loop ({}ms interval)",
            poll_interval_ms
        );

        let poll_duration = Duration::from_millis(poll_interval_ms);

        while self.is_active() {
            if let Some(event) = self.poll() {
                callback(event);
            }
            thread::sleep(poll_duration);
        }

        self.run_loop_active.store(false, Ordering::Release);
        info!("[SelectionListener] Monitoring loop stopped");
    }
}

fn get_active_window_info() -> (String, String) {
    match get_active_window() {
        Ok(monitor) => {
            let title = monitor.title;
            let window_class = format!("window_{}", monitor.window_id);
            (title, window_class)
        }
        Err(_) => (String::from("Unknown"), String::from("Unknown")),
    }
}

fn should_skip_app(title: &str, class: &str, rules: &GuardRules) -> bool {
    let combined = format!("{} {}", title.to_lowercase(), class.to_lowercase());

    if rules
        .whitelist
        .iter()
        .any(|keyword| combined.contains(&keyword.to_lowercase()))
    {
        return false;
    }

    if rules
        .blacklist
        .iter()
        .any(|keyword| combined.contains(&keyword.to_lowercase()))
    {
        return true;
    }

    false
}

fn should_suspend_for_screenshot_app(title: &str, class: &str, rules: &GuardRules) -> bool {
    let combined = format!("{} {}", title.to_lowercase(), class.to_lowercase());

    if rules
        .whitelist
        .iter()
        .any(|keyword| combined.contains(&keyword.to_lowercase()))
    {
        return false;
    }

    rules
        .screenshot_apps
        .iter()
        .any(|keyword| combined.contains(&keyword.to_lowercase()))
}

fn mouse_displacement(start_x: i32, start_y: i32, end_x: i32, end_y: i32) -> i32 {
    (end_x - start_x).abs().max((end_y - start_y).abs())
}

#[cfg(target_os = "windows")]
fn is_release_on_own_window(mouse_x: i32, mouse_y: i32, rules: &GuardRules) -> bool {
    if let Some((hwnd_u64, _process_id, _title, _class_name)) = get_window_info_at_point(mouse_x, mouse_y) {
        let hwnd_key = hwnd_u64.to_string();
        if rules.own_window_handles.iter().any(|value| value == &hwnd_key) {
            return true;
        }
    }

    false
}

#[cfg(not(target_os = "windows"))]
fn is_release_on_own_window(_mouse_x: i32, _mouse_y: i32, _rules: &GuardRules) -> bool {
    false
}

#[cfg(target_os = "windows")]
fn get_window_info_at_point(mouse_x: i32, mouse_y: i32) -> Option<(u64, u32, String, String)> {
    use winapi::shared::windef::POINT;
    use winapi::um::winuser::{
        GetClassNameW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        WindowFromPoint,
    };

    let point = POINT { x: mouse_x, y: mouse_y };
    let hwnd = unsafe { WindowFromPoint(point) };
    if hwnd.is_null() {
        return None;
    }

    let mut process_id: u32 = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut process_id as *mut u32);
    }

    let title_len = unsafe { GetWindowTextLengthW(hwnd) };
    let mut title_buf: Vec<u16> = vec![0; (title_len as usize).saturating_add(1)];
    let title_size = unsafe { GetWindowTextW(hwnd, title_buf.as_mut_ptr(), title_buf.len() as i32) };

    let mut class_buf: Vec<u16> = vec![0; 256];
    let class_size = unsafe { GetClassNameW(hwnd, class_buf.as_mut_ptr(), class_buf.len() as i32) };

    let title = if title_size > 0 {
        String::from_utf16_lossy(&title_buf[..title_size as usize])
    } else {
        String::new()
    };

    let class_name = if class_size > 0 {
        String::from_utf16_lossy(&class_buf[..class_size as usize])
    } else {
        String::new()
    };

    Some((hwnd as usize as u64, process_id, title, class_name))
}

#[cfg(target_os = "windows")]
fn create_platform_event_source() -> (PlatformEventSource, CaptureCapability) {
    (
        PlatformEventSource::Windows(WindowsEventSource::new()),
        capture_capability_base(
            "windows",
            "capture_windows",
            "full",
            false,
            "Win32 + UIA full mode".to_string(),
        ),
    )
}

#[cfg(target_os = "macos")]
fn create_platform_event_source() -> (PlatformEventSource, CaptureCapability) {
    let ax_trusted = macos_ax_trusted();
    let (mode, limited, reason) = if ax_trusted {
        (
            "full".to_string(),
            false,
            "DeviceQuery trigger mode; AX direct selected-text enabled with clipboard fallback"
                .to_string(),
        )
    } else {
        (
            "partial".to_string(),
            true,
            "DeviceQuery trigger mode; AX permission missing, using clipboard fallback only"
                .to_string(),
        )
    };

    (
        PlatformEventSource::Macos(MacosEventSource::new()),
        capture_capability_base("macos", "capture_macos", &mode, limited, reason),
    )
}

#[cfg(target_os = "linux")]
fn create_linux_platform_runtime(
) -> (
    PlatformEventSource,
    CaptureCapability,
    Box<dyn LinuxTextProvider>,
    Arc<dyn LinuxWindowInfoProvider>,
) {
    let detector: Box<dyn LinuxSessionDetector> = Box::new(EnvLinuxSessionDetector::default());
    let session = detector.detect_session();

    let factory: Box<dyn LinuxEventSourceFactory> = Box::new(DefaultLinuxEventSourceFactory::default());
    let window_info_provider: Arc<dyn LinuxWindowInfoProvider> =
        Arc::new(ActiveWinPosWindowInfoProvider::new(session.kind));
    let text_provider: Box<dyn LinuxTextProvider> =
        Box::new(LinuxClipboardSelectionProvider::new(session.kind));

    let event_source = factory.create_event_source(session.kind);
    let global_selection_event = event_source.has_global_selection_event();

    let capability = factory.build_capability(
        &session,
        window_info_provider.is_window_info_available(),
        window_info_provider.availability_reason(),
        global_selection_event,
    );

    (event_source, capability, text_provider, window_info_provider)
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn create_platform_event_source() -> (PlatformEventSource, CaptureCapability) {
    (
        PlatformEventSource::Noop,
        capture_capability_base(
            std::env::consts::OS,
            "noop",
            "limited",
            true,
            "Unsupported platform backend".to_string(),
        ),
    )
}

fn capture_capability_base(
    platform: &str,
    backend: &str,
    mode: &str,
    limited: bool,
    reason: String,
) -> CaptureCapability {
    CaptureCapability {
        platform: platform.to_string(),
        backend: backend.to_string(),
        mode: mode.to_string(),
        limited,
        reason,
        session_kind: None,
        session_confidence: None,
        window_info_available: None,
        selection_read_mode: None,
        global_selection_event: None,
    }
}

fn lock_or_recover<'a, T>(mutex: &'a Mutex<T>, name: &str) -> MutexGuard<'a, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            info!("[Lock] Poisoned mutex recovered: {}", name);
            poisoned.into_inner()
        }
    }
}

fn lock_result_or_recover<T>(result: std::sync::LockResult<T>, name: &str) -> T {
    match result {
        Ok(value) => value,
        Err(poisoned) => {
            info!("[Lock] Poisoned wait result recovered: {}", name);
            poisoned.into_inner()
        }
    }
}

#[cfg(target_os = "windows")]
fn capture_selected_text_fallback(_keyboard_triggered: bool) -> Option<String> {
    use winapi::um::winuser::{SendInput, INPUT, INPUT_KEYBOARD, KEYEVENTF_KEYUP};
    use winapi::um::winuser::GetClipboardSequenceNumber;
    use winapi::um::winuser::VK_CONTROL;

    const VK_C: u16 = 0x43;

    let previous_clipboard = read_clipboard_text_snapshot();

    // 问题1修复：使用 SendInput 替代废弃的 keybd_event
    unsafe {
        let mut inputs: [INPUT; 4] = std::mem::zeroed();

        // Ctrl down
        inputs[0].type_ = INPUT_KEYBOARD;
        inputs[0].u.ki_mut().wVk = VK_CONTROL as u16;

        // C down
        inputs[1].type_ = INPUT_KEYBOARD;
        inputs[1].u.ki_mut().wVk = VK_C;

        // C up
        inputs[2].type_ = INPUT_KEYBOARD;
        inputs[2].u.ki_mut().wVk = VK_C;
        inputs[2].u.ki_mut().dwFlags = KEYEVENTF_KEYUP;

        // Ctrl up
        inputs[3].type_ = INPUT_KEYBOARD;
        inputs[3].u.ki_mut().wVk = VK_CONTROL as u16;
        inputs[3].u.ki_mut().dwFlags = KEYEVENTF_KEYUP;

        SendInput(4, inputs.as_mut_ptr(), std::mem::size_of::<INPUT>() as i32);
    }

    let mut selected: Option<String> = None;
    let mut seq_at_capture: Option<u32> = None;

    for _ in 0..8 {
        thread::sleep(Duration::from_millis(40));

        let current = read_clipboard_text_snapshot();

        match (&previous_clipboard, &current) {
            (Some(prev), Some(curr)) if curr != prev => {
                selected = Some(curr.clone());
                seq_at_capture = Some(unsafe { GetClipboardSequenceNumber() });
                break;
            }
            (None, Some(curr)) => {
                selected = Some(curr.clone());
                seq_at_capture = Some(unsafe { GetClipboardSequenceNumber() });
                break;
            }
            _ => {}
        }
    }

    // 问题1修复：使用序列号判断是否安全恢复
    if let (Some(previous), Some(seq_captured)) = (&previous_clipboard, seq_at_capture) {
        let seq_now = unsafe { GetClipboardSequenceNumber() };
        if seq_now == seq_captured {
            // 从捕获到此刻无外部写入，安全恢复
            write_clipboard_text_snapshot_with_record(previous);
        }
        // 否则外部已修改，放弃恢复
    } else {
        // 未捕获到内容，无条件恢复
        if let Some(previous) = previous_clipboard {
            write_clipboard_text_snapshot_with_record(&previous);
        }
    }

    selected
}

#[cfg(all(not(target_os = "windows"), not(target_os = "linux")))]
fn capture_selected_text_fallback(keyboard_triggered: bool) -> Option<String> {
    let _ = keyboard_triggered;
    read_clipboard_text_snapshot()
}

// 问题7修复：导出为公共函数，供 main.rs 使用
pub fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn read_clipboard_text_snapshot() -> Option<String> {
    let mut clipboard = Clipboard::new().ok()?;
    normalize_text_option(clipboard.get_text().ok())
}

fn normalize_text_option(value: Option<String>) -> Option<String> {
    value
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty())
}

#[allow(dead_code)]
fn write_clipboard_text_snapshot(value: &str) {
    if let Ok(mut clipboard) = Clipboard::new() {
        let _ = clipboard.set_text(value.to_string());
    }
}

// 问题2修复：写入剪贴板时记录内容，用于区分本程序写入和外部写入
fn write_clipboard_text_snapshot_with_record(value: &str) {
    if let Ok(mut clipboard) = Clipboard::new() {
        if clipboard.set_text(value.to_string()).is_ok() {
            if let Ok(mut content) = OWN_CLIPBOARD_CONTENT.write() {
                *content = Some(value.to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_selection_listener_creation() {
        let listener = SelectionListener::new();
        assert!(!listener.is_active());
        listener.start();
        assert!(listener.is_active());
        listener.stop();
        assert!(!listener.is_active());
    }

    #[test]
    fn test_skip_app_logic() {
        let rules = GuardRules::default();
        assert!(should_skip_app("1Password", "", &rules));
        assert!(should_skip_app("", "KeePass", &rules));
        assert!(!should_skip_app("Visual Studio Code", "", &rules));
        assert!(!should_skip_app("Firefox", "", &rules));
    }

    #[test]
    fn test_guard_rules_whitelist_precedence() {
        let mut rules = GuardRules::default();
        rules.blacklist.push("code".to_string());
        rules.whitelist.push("visual studio code".to_string());

        assert!(!should_skip_app("Visual Studio Code", "", &rules));
    }
}
