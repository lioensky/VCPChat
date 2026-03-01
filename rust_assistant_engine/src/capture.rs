use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use std::thread;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use log::info;
use device_query::{DeviceQuery, DeviceState, MouseState};
use active_win_pos_rs::get_active_window;
use clipboard_win::{formats, get_clipboard, set_clipboard};

#[cfg(target_os = "windows")]
use winapi::um::winuser::{keybd_event, GetAsyncKeyState, KEYEVENTF_KEYUP, VK_CONTROL, VK_LBUTTON};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectionRecord {
    pub text: String,
    pub window_title: String,
    pub timestamp: u64,
    pub mouse_x: i32,
    pub mouse_y: i32,
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
}

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
        }
    }
}

#[derive(Debug, Clone)]
pub struct SelectionContext {
    pub last_text: String,
    pub last_mouse_state: MouseState,
    pub last_left_pressed: bool,
    pub last_event_time: u64,
    pub suspension_end_time: u64,
}

impl Default for SelectionContext {
    fn default() -> Self {
        Self {
            last_text: String::new(),
            last_mouse_state: MouseState {
                coords: (0, 0),
                button_pressed: vec![false, false, false],
            },
            last_left_pressed: false,
            last_event_time: 0,
            suspension_end_time: 0,
        }
    }
}

pub struct SelectionListener {
    context: Arc<Mutex<SelectionContext>>,
    active: Arc<Mutex<bool>>,
    guard_rules: Arc<Mutex<GuardRules>>,
}

impl SelectionListener {
    pub fn new() -> Self {
        Self {
            context: Arc::new(Mutex::new(SelectionContext::default())),
            active: Arc::new(Mutex::new(false)),
            guard_rules: Arc::new(Mutex::new(GuardRules::default())),
        }
    }

    pub fn start(&self) {
        let mut active = self.active.lock().unwrap();
        *active = true;
        info!("[SelectionListener] Started");
    }

    pub fn stop(&self) {
        let mut active = self.active.lock().unwrap();
        *active = false;
        info!("[SelectionListener] Stopped");
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

    /// Poll for text selection events in non-blocking manner
    /// Returns Some(SelectionEvent) if selection detected, None otherwise
    pub fn poll(&self) -> Option<SelectionEvent> {
        if !self.is_active() {
            return None;
        }

        let mut context = self.context.lock().unwrap();
        let now = current_timestamp();

        // Check if suspended
        if now < context.suspension_end_time {
            return None;
        }

        let device_state = DeviceState::new();
        let mouse_state = device_state.get_mouse();

        // Check if left mouse button was released (selection completed)
        // On Windows, always use WinAPI state to avoid device_query incompatibility.
        let was_pressed = context.last_left_pressed;
        let is_pressed = current_left_button_pressed(&mouse_state);

        // Detect mouse button release
        if was_pressed && !is_pressed {
            if let Some(clipboard_data) = capture_selected_text() {
                if !clipboard_data.is_empty() && clipboard_data != context.last_text {
                    let text = clipboard_data.trim();

                    if text.len() < 2 || text.len() > 10000 {
                        context.last_left_pressed = is_pressed;
                        context.last_mouse_state = mouse_state;
                        return None;
                    }

                    let (window_title, window_class) = get_active_window_info();
                    let guard_rules = self.guard_rules.lock().unwrap().clone();
                    if should_skip_app(&window_title, &window_class, &guard_rules) {
                        info!(
                            "[SelectionListener] Skipped by guard rules. window='{}' class='{}'",
                            window_title,
                            window_class
                        );
                        context.last_mouse_state = mouse_state;
                        context.last_left_pressed = is_pressed;
                        context.last_event_time = now;
                        return None;
                    }

                    let event = SelectionEvent {
                        text: text.to_string(),
                        mouse_x: mouse_state.coords.0,
                        mouse_y: mouse_state.coords.1,
                        window_title,
                        window_class,
                        timestamp: now,
                    };

                    context.last_text = text.to_string();
                    context.last_event_time = now;

                    info!(
                        "[SelectionListener] Detected selection: '{}' at ({}, {})",
                        event.text.chars().take(50).collect::<String>(),
                        event.mouse_x,
                        event.mouse_y
                    );

                    context.last_left_pressed = is_pressed;
                    context.last_mouse_state = mouse_state;
                    return Some(event);
                }
            } else {
                info!("[SelectionListener] Mouse released but no selected text captured");
            }
        }

        context.last_left_pressed = is_pressed;
        context.last_mouse_state = mouse_state;
        None
    }

    /// Blocking loop for continuous selection monitoring
    /// Calls callback for each detected selection
    pub fn run_loop<F>(&self, mut callback: F, poll_interval_ms: u64)
    where
        F: FnMut(SelectionEvent),
    {
        use std::thread;
        use std::time::Duration;

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

/// Get active window title and class
fn get_active_window_info() -> (String, String) {
    match get_active_window() {
        Ok(monitor) => {
            let title = monitor.title;
            // Note: active_win_pos_rs doesn't provide window class on all platforms
            // Using window ID as a fallback identifier
            let window_class = format!("win_{}", monitor.window_id);
            (title, window_class)
        }
        Err(_) => (String::from("Unknown"), String::from("Unknown")),
    }
}

/// Check if app should be skipped (e.g., password managers, system apps)
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

    rules
        .screenshot_apps
        .iter()
        .any(|keyword| combined.contains(&keyword.to_lowercase()))
}

#[cfg(target_os = "windows")]
fn left_button_pressed_fallback() -> bool {
    unsafe { ((GetAsyncKeyState(VK_LBUTTON as i32) as i32) & 0x8000) != 0 }
}

#[cfg(not(target_os = "windows"))]
fn left_button_pressed_fallback() -> bool {
    false
}

#[cfg(target_os = "windows")]
fn current_left_button_pressed(_mouse_state: &MouseState) -> bool {
    left_button_pressed_fallback()
}

#[cfg(not(target_os = "windows"))]
fn current_left_button_pressed(mouse_state: &MouseState) -> bool {
    mouse_state.button_pressed.get(0).copied().unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn capture_selected_text() -> Option<String> {
    let previous_clipboard = get_clipboard::<String, _>(formats::Unicode).ok();

    unsafe {
        const VK_C_CODE: u8 = 0x43;
        keybd_event(VK_CONTROL as u8, 0, 0, 0);
        keybd_event(VK_C_CODE, 0, 0, 0);
        keybd_event(VK_C_CODE, 0, KEYEVENTF_KEYUP, 0);
        keybd_event(VK_CONTROL as u8, 0, KEYEVENTF_KEYUP, 0);
    }

    let mut selected: Option<String> = None;

    // Wait for clipboard update after Ctrl+C.
    // Some applications need more than a fixed 70ms to publish selected text.
    for _ in 0..8 {
        thread::sleep(Duration::from_millis(40));

        let current = get_clipboard::<String, _>(formats::Unicode)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        match (&previous_clipboard, &current) {
            // Clipboard changed -> likely new selected text
            (Some(prev), Some(curr)) if curr != prev => {
                selected = Some(curr.clone());
                break;
            }
            // Clipboard was empty/unavailable before, now has text
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
fn capture_selected_text() -> Option<String> {
    None
}

/// Get current Unix timestamp in milliseconds
fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
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
