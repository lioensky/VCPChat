use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use active_win_pos_rs::get_active_window;
use clipboard_win::{formats, get_clipboard, set_clipboard};
use log::info;
use serde::{Deserialize, Serialize};

use crate::uia_selection_provider::UiaSelectionProvider;
use crate::windows_event_source::WindowsEventSource;

const MIN_EVENT_INTERVAL_MS: u64 = 80;
const MIN_DISTANCE: i32 = 8;
const SCREENSHOT_SUSPEND_MS: u64 = 3000;
const CLIPBOARD_CONFLICT_SUSPEND_MS: u64 = 1000;
const CLIPBOARD_CHECK_INTERVAL_MS: u64 = 500;

#[cfg(target_os = "windows")]
use winapi::um::winuser::{keybd_event, KEYEVENTF_KEYUP, VK_CONTROL};

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
}

fn default_min_event_interval_ms() -> u64 { MIN_EVENT_INTERVAL_MS }
fn default_min_distance() -> i32 { MIN_DISTANCE }
fn default_screenshot_suspend_ms() -> u64 { SCREENSHOT_SUSPEND_MS }
fn default_clipboard_conflict_suspend_ms() -> u64 { CLIPBOARD_CONFLICT_SUSPEND_MS }
fn default_clipboard_check_interval_ms() -> u64 { CLIPBOARD_CHECK_INTERVAL_MS }

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

pub struct SelectionListener {
    context: Arc<Mutex<SelectionContext>>,
    active: Arc<Mutex<bool>>,
    guard_rules: Arc<Mutex<GuardRules>>,
    event_source: Arc<Mutex<WindowsEventSource>>,
    uia_provider: Arc<UiaSelectionProvider>,
    clipboard_monitor_running: Arc<AtomicBool>,
    clipboard_monitor_stop_signal: Arc<(Mutex<bool>, Condvar)>,
}

impl SelectionListener {
    pub fn new() -> Self {
        Self {
            context: Arc::new(Mutex::new(SelectionContext::default())),
            active: Arc::new(Mutex::new(false)),
            guard_rules: Arc::new(Mutex::new(GuardRules::default())),
            event_source: Arc::new(Mutex::new(WindowsEventSource::new())),
            uia_provider: Arc::new(UiaSelectionProvider::new()),
            clipboard_monitor_running: Arc::new(AtomicBool::new(false)),
            clipboard_monitor_stop_signal: Arc::new((Mutex::new(false), Condvar::new())),
        }
    }

    pub fn start(&self) {
        let mut active = self.active.lock().unwrap();
        *active = true;
        info!("[SelectionListener] Started");
        
        // Start background clipboard monitor
        self.start_clipboard_monitor();
    }

    pub fn stop(&self) {
        let mut active = self.active.lock().unwrap();
        *active = false;
        info!("[SelectionListener] Stopped");
        
        // Stop background clipboard monitor
        self.stop_clipboard_monitor();
    }

    pub fn is_active(&self) -> bool {
        *self.active.lock().unwrap()
    }

    pub fn set_guard_rules(&self, rules: GuardRules) {
        let mut guard_rules = self.guard_rules.lock().unwrap();
        *guard_rules = rules;
        info!("[SelectionListener] Guard rules updated");
    }

    pub fn get_guard_rules(&self) -> GuardRules {
        self.guard_rules.lock().unwrap().clone()
    }

    #[allow(dead_code)]
    pub fn suspend(&self, duration_ms: u64) {
        let now = current_timestamp();
        let mut context = self.context.lock().unwrap();
        context.suspension_end_time = now + duration_ms;
        info!("[SelectionListener] Suspended for {} ms", duration_ms);
    }

    pub fn poll(&self) -> Option<SelectionEvent> {
        if !self.is_active() {
            return None;
        }

        let signal = {
            let mut source = self.event_source.lock().unwrap();
            source.poll_signal()
        };

        let signal = match signal {
            Some(signal) => signal,
            None => return None,
        };

        let now = current_timestamp();
        let mut context = self.context.lock().unwrap();
        let guard_rules = self.guard_rules.lock().unwrap().clone();

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
        }

        let (window_title, window_class) = get_active_window_info();

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

        let selected_text = self
            .uia_provider
            .get_selected_text()
            .or_else(capture_selected_text_fallback)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let selected_text = match selected_text {
            Some(value) => value,
            None => {
                info!("[SelectionListener] Selection signal detected but no selected text available");
                return None;
            }
        };

        if !signal.keyboard_triggered {
            let distance = mouse_displacement(signal.mouse_start_x, signal.mouse_start_y, signal.mouse_x, signal.mouse_y);
            let selected_text_len = selected_text.chars().count();
            if signal.mouse_origin_known
                && guard_rules.min_distance > 0
                && distance < guard_rules.min_distance
                && selected_text_len <= 1
            {
                context.last_event_time = now;
                info!(
                    "[SelectionListener] Skipped by displacement threshold. distance={} < {}, text_len={}",
                    distance,
                    guard_rules.min_distance,
                    selected_text_len
                );
                return None;
            }
        }

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
            let mut stop = lock.lock().unwrap();
            *stop = false;
        }
        
        thread::spawn(move || {
            info!("[ClipboardMonitor] Background monitor started");
            
            // Initialize clipboard snapshot
            if let Some(initial_clipboard) = read_clipboard_text_snapshot() {
                let mut ctx = context.lock().unwrap();
                if ctx.last_clipboard_snapshot.is_empty() {
                    ctx.last_clipboard_snapshot = initial_clipboard;
                }
            }
            
            while running.load(Ordering::SeqCst) {
                let interval_ms = {
                    let rules = guard_rules.lock().unwrap();
                    rules.clipboard_check_interval_ms.max(50)
                };

                let (lock, cvar) = &*stop_signal;
                let stop_guard = lock.lock().unwrap();
                let wait_result = cvar
                    .wait_timeout_while(
                        stop_guard,
                        Duration::from_millis(interval_ms),
                        |should_stop| !*should_stop,
                    )
                    .unwrap();

                if *wait_result.0 || !running.load(Ordering::SeqCst) {
                    break;
                }
                
                if let Some(current_clipboard) = read_clipboard_text_snapshot() {
                    let mut ctx = context.lock().unwrap();
                    let rules = guard_rules.lock().unwrap();
                    
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
        let mut stop = lock.lock().unwrap();
        *stop = true;
        cvar.notify_all();
    }

    pub fn run_loop<F>(&self, mut callback: F, poll_interval_ms: u64)
    where
        F: FnMut(SelectionEvent),
    {
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

        info!("[SelectionListener] Monitoring loop stopped");
    }
}

fn get_active_window_info() -> (String, String) {
    match get_active_window() {
        Ok(monitor) => {
            let title = monitor.title;
            let window_class = format!("win_{}", monitor.window_id);
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
    if let Some((hwnd_u64, process_id, _title, _class_name)) = get_window_info_at_point(mouse_x, mouse_y) {
        let hwnd_key = hwnd_u64.to_string();
        if rules.own_window_handles.iter().any(|value| value == &hwnd_key) {
            return true;
        }

        let _ = process_id;
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
fn capture_selected_text_fallback() -> Option<String> {
    let previous_clipboard = get_clipboard::<String, _>(formats::Unicode).ok();

    unsafe {
        const VK_C_CODE: u8 = 0x43;
        keybd_event(VK_CONTROL as u8, 0, 0, 0);
        keybd_event(VK_C_CODE, 0, 0, 0);
        keybd_event(VK_C_CODE, 0, KEYEVENTF_KEYUP, 0);
        keybd_event(VK_CONTROL as u8, 0, KEYEVENTF_KEYUP, 0);
    }

    let mut selected: Option<String> = None;

    for _ in 0..8 {
        thread::sleep(Duration::from_millis(40));

        let current = get_clipboard::<String, _>(formats::Unicode)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        match (&previous_clipboard, &current) {
            (Some(prev), Some(curr)) if curr != prev => {
                selected = Some(curr.clone());
                break;
            }
            (None, Some(curr)) => {
                selected = Some(curr.clone());
                break;
            }
            _ => {}
        }
    }

    if let Some(previous) = previous_clipboard {
        let _ = set_clipboard(formats::Unicode, previous);
    }

    selected
}

#[cfg(not(target_os = "windows"))]
fn capture_selected_text_fallback() -> Option<String> {
    None
}

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(target_os = "windows")]
fn read_clipboard_text_snapshot() -> Option<String> {
    get_clipboard::<String, _>(formats::Unicode)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(not(target_os = "windows"))]
fn read_clipboard_text_snapshot() -> Option<String> {
    None
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
