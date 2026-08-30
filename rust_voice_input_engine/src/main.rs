use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{self, BufRead, Write};
use std::sync::{
    atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering},
    mpsc, Arc, Mutex, OnceLock,
};
use std::thread;
use std::time::{Duration, Instant};

const HOTKEY_POLL_MS: u64 = 12;
const RIGHT_ALT_WATCHDOG_MS: u64 = 15_000;

static OUTPUT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static CONFIGURED_HOTKEY_VK: AtomicU16 = AtomicU16::new(0);
static HOOK_KEY_PRESSED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InputMode {
    WindowsVoiceTyping,
    RightAltHold,
}

impl InputMode {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "windows_voice_typing" | "win_h" => Ok(Self::WindowsVoiceTyping),
            "right_alt_hold" | "right_alt" => Ok(Self::RightAltHold),
            other => Err(format!("unsupported voice input mode: {other}")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::WindowsVoiceTyping => "windows_voice_typing",
            Self::RightAltHold => "right_alt_hold",
        }
    }

    fn code(self) -> u16 {
        match self {
            Self::WindowsVoiceTyping => 1,
            Self::RightAltHold => 2,
        }
    }

    fn from_code(value: u16) -> Option<Self> {
        match value {
            1 => Some(Self::WindowsVoiceTyping),
            2 => Some(Self::RightAltHold),
            _ => None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
enum Command {
    Ping {
        #[serde(default)]
        request_id: Option<String>,
    },
    ConfigureHotkey {
        #[serde(default)]
        request_id: Option<String>,
        shortcut: String,
        mode: String,
    },
    FocusReady {
        #[serde(default)]
        request_id: Option<String>,
        target_window_handle: String,
    },
    StopSession {
        #[serde(default)]
        request_id: Option<String>,
    },
    RestoreFocus {
        #[serde(default)]
        request_id: Option<String>,
    },
    Cancel {
        #[serde(default)]
        request_id: Option<String>,
    },
    ReleaseAll {
        #[serde(default)]
        request_id: Option<String>,
    },
    Shutdown {
        #[serde(default)]
        request_id: Option<String>,
    },
}

impl Command {
    fn request_id(&self) -> Option<&str> {
        match self {
            Self::Ping { request_id }
            | Self::ConfigureHotkey { request_id, .. }
            | Self::FocusReady { request_id, .. }
            | Self::StopSession { request_id }
            | Self::RestoreFocus { request_id }
            | Self::Cancel { request_id }
            | Self::ReleaseAll { request_id }
            | Self::Shutdown { request_id } => request_id.as_deref(),
        }
    }
}

#[derive(Debug, Serialize)]
struct EngineEvent<'a> {
    event: &'a str,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<serde_json::Value>,
}

fn emit(event: EngineEvent<'_>) {
    let _guard = OUTPUT_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let stdout = io::stdout();
    let mut output = stdout.lock();
    if serde_json::to_writer(&mut output, &event).is_ok() {
        let _ = output.write_all(b"\n");
        let _ = output.flush();
    }
}

fn emit_unsolicited(event: &'static str, mode: Option<InputMode>, detail: serde_json::Value) {
    emit(EngineEvent {
        event,
        success: true,
        request_id: None,
        mode: mode.map(InputMode::as_str),
        error: None,
        detail: Some(detail),
    });
}

fn emit_error(request_id: Option<&str>, error: impl Into<String>) {
    emit(EngineEvent {
        event: "error",
        success: false,
        request_id,
        mode: None,
        error: Some(error.into()),
        detail: None,
    });
}

#[derive(Debug)]
struct SharedState {
    running: AtomicBool,
    configured_mode: AtomicU16,
    native_hook_active: AtomicBool,
    hotkey_pressed: AtomicBool,
    awaiting_focus: AtomicBool,
    right_alt_held: AtomicBool,
    original_window_handle: AtomicU64,
    target_window_handle: AtomicU64,
    alt_pressed_at: Mutex<Option<Instant>>,
}

impl Default for SharedState {
    fn default() -> Self {
        Self {
            running: AtomicBool::new(true),
            configured_mode: AtomicU16::new(0),
            native_hook_active: AtomicBool::new(false),
            hotkey_pressed: AtomicBool::new(false),
            awaiting_focus: AtomicBool::new(false),
            right_alt_held: AtomicBool::new(false),
            original_window_handle: AtomicU64::new(0),
            target_window_handle: AtomicU64::new(0),
            alt_pressed_at: Mutex::new(None),
        }
    }
}

impl SharedState {
    fn mode(&self) -> Option<InputMode> {
        InputMode::from_code(self.configured_mode.load(Ordering::SeqCst))
    }

    fn release_all(&self) {
        platform::release_simulated_keys_best_effort();
        self.right_alt_held.store(false, Ordering::SeqCst);
        self.awaiting_focus.store(false, Ordering::SeqCst);
        *self
            .alt_pressed_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    fn restore_focus(&self) -> Result<Option<u64>, String> {
        self.release_all();
        let handle = self.original_window_handle.swap(0, Ordering::SeqCst);
        self.target_window_handle.store(0, Ordering::SeqCst);
        if handle != 0 {
            platform::focus_window(handle)?;
            Ok(Some(handle))
        } else {
            Ok(None)
        }
    }

    fn stop_session(&self) -> Result<(), String> {
        if matches!(self.mode(), Some(InputMode::WindowsVoiceTyping)) {
            platform::tap_windows_h()?;
        }
        self.release_all();
        Ok(())
    }
}

fn parse_window_handle(value: &str) -> Result<u64, String> {
    let trimmed = value.trim();
    let handle = trimmed
        .parse::<u64>()
        .map_err(|_| format!("invalid target_window_handle: {trimmed}"))?;
    if handle == 0 {
        Err("target_window_handle must not be zero".to_string())
    } else {
        Ok(handle)
    }
}

fn parse_function_key(value: &str) -> Result<u16, String> {
    let normalized = value.trim().to_ascii_uppercase();
    let number = normalized
        .strip_prefix('F')
        .ok_or_else(|| "P0 native hotkey currently supports F1-F24 only".to_string())?
        .parse::<u16>()
        .map_err(|_| "P0 native hotkey currently supports F1-F24 only".to_string())?;
    if !(1..=24).contains(&number) {
        return Err("P0 native hotkey currently supports F1-F24 only".to_string());
    }
    Ok(0x70 + number - 1)
}

fn start_hotkey_monitor(state: Arc<SharedState>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let (event_tx, event_rx) = mpsc::channel::<bool>();
        let hook_running = Arc::clone(&state);
        let hook_thread = thread::spawn(move || {
            platform::run_hotkey_hook(hook_running, event_tx);
        });

        while state.running.load(Ordering::SeqCst) {
            match event_rx.recv_timeout(Duration::from_millis(HOTKEY_POLL_MS)) {
                Ok(true) => {
                    let vk = CONFIGURED_HOTKEY_VK.load(Ordering::SeqCst);
                    state.hotkey_pressed.store(true, Ordering::SeqCst);
                    state.release_all();
                    let original = platform::foreground_window_handle().unwrap_or(0);
                    state
                        .original_window_handle
                        .store(original, Ordering::SeqCst);
                    state.awaiting_focus.store(true, Ordering::SeqCst);
                    emit_unsolicited(
                        "hotkey_down",
                        state.mode(),
                        json!({
                            "virtualKey": vk,
                            "originalWindowHandle": if original == 0 { None } else { Some(original.to_string()) }
                        }),
                    );
                }
                Ok(false) => {
                    let vk = CONFIGURED_HOTKEY_VK.load(Ordering::SeqCst);
                    state.hotkey_pressed.store(false, Ordering::SeqCst);
                    // P0 invariant: the native key-up path releases every
                    // simulated modifier before Electron can perform any work.
                    state.release_all();
                    let target = state.target_window_handle.load(Ordering::SeqCst);
                    let target_window_handle = if target == 0 {
                        None
                    } else {
                        Some(target.to_string())
                    };
                    emit_unsolicited(
                        "hotkey_up",
                        state.mode(),
                        json!({
                            "virtualKey": vk,
                            "targetWindowHandle": target_window_handle
                        }),
                    );
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }

            let watchdog_expired = state.right_alt_held.load(Ordering::SeqCst)
                && state
                    .alt_pressed_at
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .map(|started| {
                        started.elapsed() >= Duration::from_millis(RIGHT_ALT_WATCHDOG_MS)
                    })
                    .unwrap_or(false);
            if watchdog_expired {
                state.release_all();
                emit_unsolicited(
                    "watchdog_release",
                    state.mode(),
                    json!({ "reason": "right_alt_hold_timeout" }),
                );
            }
        }

        state.release_all();
        let _ = hook_thread.join();
    })
}

fn process_command(command: Command, state: &Arc<SharedState>) -> bool {
    let request_id_owned = command.request_id().map(ToOwned::to_owned);
    let request_id = request_id_owned.as_deref();

    match command {
        Command::Ping { .. } => emit(EngineEvent {
            event: "pong",
            success: true,
            request_id,
            mode: state.mode().map(InputMode::as_str),
            error: None,
            detail: Some(json!({
                "platform": std::env::consts::OS,
                "nativeHookActive": state.native_hook_active.load(Ordering::SeqCst),
                "hotkeyPressed": state.hotkey_pressed.load(Ordering::SeqCst),
                "awaitingFocus": state.awaiting_focus.load(Ordering::SeqCst),
                "rightAltHeld": state.right_alt_held.load(Ordering::SeqCst)
            })),
        }),
        Command::ConfigureHotkey { shortcut, mode, .. } => {
            let hook_ready_deadline = Instant::now() + Duration::from_millis(500);
            while !state.native_hook_active.load(Ordering::SeqCst)
                && Instant::now() < hook_ready_deadline
            {
                thread::sleep(Duration::from_millis(10));
            }

            let result = if state.native_hook_active.load(Ordering::SeqCst) {
                InputMode::parse(&mode).and_then(|parsed_mode| {
                    parse_function_key(&shortcut).map(|vk| (parsed_mode, vk))
                })
            } else {
                Err("native low-level keyboard hook is not active".to_string())
            };
            match result {
                Ok((parsed_mode, vk)) => {
                    state.release_all();
                    state
                        .configured_mode
                        .store(parsed_mode.code(), Ordering::SeqCst);
                    CONFIGURED_HOTKEY_VK.store(vk, Ordering::SeqCst);
                    emit(EngineEvent {
                        event: "hotkey_configured",
                        success: true,
                        request_id,
                        mode: Some(parsed_mode.as_str()),
                        error: None,
                        detail: Some(json!({ "shortcut": shortcut, "virtualKey": vk })),
                    });
                }
                Err(error) => emit_error(request_id, error),
            }
        }
        Command::FocusReady {
            target_window_handle,
            ..
        } => {
            let result = parse_window_handle(&target_window_handle).and_then(|target| {
                if !state.hotkey_pressed.load(Ordering::SeqCst)
                    || !state.awaiting_focus.load(Ordering::SeqCst)
                {
                    return Err(
                        "focus_ready rejected without an active physical hotkey".to_string()
                    );
                }
                platform::focus_window(target)?;
                state.target_window_handle.store(target, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(80));
                match state.mode() {
                    Some(InputMode::WindowsVoiceTyping) => platform::tap_windows_h()?,
                    Some(InputMode::RightAltHold) => {
                        platform::set_right_alt(true)?;
                        state.right_alt_held.store(true, Ordering::SeqCst);
                        *state
                            .alt_pressed_at
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                            Some(Instant::now());
                    }
                    None => return Err("voice input mode is not configured".to_string()),
                }
                state.awaiting_focus.store(false, Ordering::SeqCst);
                Ok(target)
            });
            match result {
                Ok(target) => emit(EngineEvent {
                    event: "input_started",
                    success: true,
                    request_id,
                    mode: state.mode().map(InputMode::as_str),
                    error: None,
                    detail: Some(json!({ "targetWindowHandle": target.to_string() })),
                }),
                Err(error) => {
                    state.release_all();
                    emit_error(request_id, error);
                }
            }
        }
        Command::StopSession { .. } => match state.stop_session() {
            Ok(()) => emit(EngineEvent {
                event: "stopped",
                success: true,
                request_id,
                mode: state.mode().map(InputMode::as_str),
                error: None,
                detail: None,
            }),
            Err(error) => {
                state.release_all();
                emit_error(request_id, error);
            }
        },
        Command::RestoreFocus { .. } => match state.restore_focus() {
            Ok(restored) => emit(EngineEvent {
                event: "focus_restored",
                success: true,
                request_id,
                mode: state.mode().map(InputMode::as_str),
                error: None,
                detail: Some(json!({
                    "restoredWindowHandle": restored.map(|value| value.to_string())
                })),
            }),
            Err(error) => emit_error(request_id, error),
        },
        Command::Cancel { .. } => {
            let _ = state.stop_session();
            match state.restore_focus() {
                Ok(restored) => emit(EngineEvent {
                    event: "cancelled",
                    success: true,
                    request_id,
                    mode: state.mode().map(InputMode::as_str),
                    error: None,
                    detail: Some(json!({
                        "restoredWindowHandle": restored.map(|value| value.to_string())
                    })),
                }),
                Err(error) => emit_error(request_id, error),
            }
        }
        Command::ReleaseAll { .. } => {
            state.release_all();
            emit(EngineEvent {
                event: "released",
                success: true,
                request_id,
                mode: state.mode().map(InputMode::as_str),
                error: None,
                detail: None,
            });
        }
        Command::Shutdown { .. } => {
            state.running.store(false, Ordering::SeqCst);
            state.release_all();
            emit(EngineEvent {
                event: "shutdown",
                success: true,
                request_id,
                mode: state.mode().map(InputMode::as_str),
                error: None,
                detail: None,
            });
            return false;
        }
    }
    true
}

fn main() {
    let state = Arc::new(SharedState::default());
    let monitor = start_hotkey_monitor(Arc::clone(&state));

    emit(EngineEvent {
        event: "ready",
        success: true,
        request_id: None,
        mode: None,
        error: None,
        detail: Some(json!({
            "service": "vcp_voice_input_engine",
            "version": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS,
            "nativeHotkey": true,
            "nativeHookActive": state.native_hook_active.load(Ordering::SeqCst),
            "supportedHotkeys": "F1-F24"
        })),
    });

    let stdin = io::stdin();
    for line_result in stdin.lock().lines() {
        let line = match line_result {
            Ok(value) => value,
            Err(error) => {
                emit_error(None, format!("stdin read failed: {error}"));
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Command>(&line) {
            Ok(command) => {
                if !process_command(command, &state) {
                    break;
                }
            }
            Err(error) => emit_error(None, format!("invalid command JSON: {error}")),
        }
    }

    // stdin EOF is authoritative: never leave an injected modifier behind.
    state.running.store(false, Ordering::SeqCst);
    state.release_all();
    let _ = monitor.join();
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{Arc, Ordering, SharedState, CONFIGURED_HOTKEY_VK, HOOK_KEY_PRESSED};
    use std::mem::size_of;
    use std::sync::{mpsc::Sender, Mutex, OnceLock};
    use std::thread;
    use std::time::Duration;
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_LWIN, VK_RMENU,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetForegroundWindow, IsWindow, PeekMessageW,
        SetForegroundWindow, SetWindowsHookExW, ShowWindow, TranslateMessage, UnhookWindowsHookEx,
        HC_ACTION, KBDLLHOOKSTRUCT, MSG, PM_REMOVE, SW_RESTORE, WH_KEYBOARD_LL, WM_KEYDOWN,
        WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    const VK_H: VIRTUAL_KEY = VIRTUAL_KEY(0x48);
    static HOOK_EVENT_SENDER: OnceLock<Mutex<Option<Sender<bool>>>> = OnceLock::new();

    unsafe extern "system" fn low_level_keyboard_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code == HC_ACTION as i32 {
            let event = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let configured_vk = CONFIGURED_HOTKEY_VK.load(Ordering::SeqCst);
            if configured_vk != 0 && event.vkCode == configured_vk as u32 {
                let message = wparam.0 as u32;
                let pressed = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
                let released = message == WM_KEYUP || message == WM_SYSKEYUP;
                if pressed || released {
                    let was_pressed = HOOK_KEY_PRESSED.load(Ordering::SeqCst);
                    let is_edge = (pressed && !was_pressed) || (released && was_pressed);
                    if is_edge {
                        HOOK_KEY_PRESSED.store(pressed, Ordering::SeqCst);
                        if let Some(sender) = HOOK_EVENT_SENDER
                            .get_or_init(|| Mutex::new(None))
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .as_ref()
                        {
                            let _ = sender.send(pressed);
                        }
                    }
                    // Swallow the initial edge and all auto-repeat events so
                    // the foreground app can never retain an unmatched F-key.
                    return LRESULT(1);
                }
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    pub fn run_hotkey_hook(running: Arc<SharedState>, sender: Sender<bool>) {
        HOOK_KEY_PRESSED.store(false, Ordering::SeqCst);
        *HOOK_EVENT_SENDER
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(sender);

        let hook = unsafe {
            SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(low_level_keyboard_proc),
                HINSTANCE::default(),
                0,
            )
        };
        let hook = match hook {
            Ok(value) => value,
            Err(error) => {
                running.native_hook_active.store(false, Ordering::SeqCst);
                *HOOK_EVENT_SENDER
                    .get_or_init(|| Mutex::new(None))
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
                super::emit(super::EngineEvent {
                    event: "hook_error",
                    success: false,
                    request_id: None,
                    mode: running.mode().map(super::InputMode::as_str),
                    error: Some(format!("SetWindowsHookExW failed: {error}")),
                    detail: None,
                });
                return;
            }
        };
        running.native_hook_active.store(true, Ordering::SeqCst);
        super::emit_unsolicited(
            "hook_ready",
            running.mode(),
            serde_json::json!({ "nativeHookActive": true }),
        );

        let mut message = MSG::default();
        while running.running.load(Ordering::SeqCst) {
            unsafe {
                while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            thread::sleep(Duration::from_millis(4));
        }

        unsafe {
            let _ = UnhookWindowsHookEx(hook);
        }
        running.native_hook_active.store(false, Ordering::SeqCst);
        HOOK_KEY_PRESSED.store(false, Ordering::SeqCst);
        *HOOK_EVENT_SENDER
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    fn hwnd_from_u64(value: u64) -> Result<HWND, String> {
        let raw = usize::try_from(value)
            .map_err(|_| format!("window handle is outside pointer range: {value}"))?;
        let hwnd = HWND(raw as *mut core::ffi::c_void);
        if unsafe { IsWindow(hwnd).as_bool() } {
            Ok(hwnd)
        } else {
            Err(format!("window handle is not valid: {value}"))
        }
    }

    fn keyboard_input(key: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn send_inputs(inputs: &[INPUT]) -> Result<(), String> {
        let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
        if sent == inputs.len() as u32 {
            Ok(())
        } else {
            // A partial injection is unsafe. Immediately release every key.
            release_simulated_keys_best_effort();
            Err(format!(
                "SendInput injected {sent} of {} keyboard events",
                inputs.len()
            ))
        }
    }

    pub fn foreground_window_handle() -> Option<u64> {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            None
        } else {
            Some(hwnd.0 as usize as u64)
        }
    }

    pub fn focus_window(handle: u64) -> Result<(), String> {
        let hwnd = hwnd_from_u64(handle)?;
        if unsafe { GetForegroundWindow() } == hwnd {
            return Ok(());
        }

        unsafe {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }

        let foreground_request_accepted = unsafe { SetForegroundWindow(hwnd).as_bool() };
        if foreground_request_accepted || unsafe { GetForegroundWindow() } == hwnd {
            Ok(())
        } else {
            Err(format!(
                "Windows rejected SetForegroundWindow for handle {handle}"
            ))
        }
    }

    pub fn tap_windows_h() -> Result<(), String> {
        send_inputs(&[
            keyboard_input(VK_LWIN, KEYBD_EVENT_FLAGS(0)),
            keyboard_input(VK_H, KEYBD_EVENT_FLAGS(0)),
            keyboard_input(VK_H, KEYEVENTF_KEYUP),
            keyboard_input(VK_LWIN, KEYEVENTF_KEYUP),
        ])
    }

    pub fn set_right_alt(pressed: bool) -> Result<(), String> {
        let flags = KEYEVENTF_EXTENDEDKEY
            | if pressed {
                KEYBD_EVENT_FLAGS(0)
            } else {
                KEYEVENTF_KEYUP
            };
        send_inputs(&[keyboard_input(VK_RMENU, flags)])
    }

    pub fn release_simulated_keys_best_effort() {
        let _ = unsafe {
            SendInput(
                &[
                    keyboard_input(VK_H, KEYEVENTF_KEYUP),
                    keyboard_input(VK_LWIN, KEYEVENTF_KEYUP),
                    keyboard_input(VK_RMENU, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP),
                ],
                size_of::<INPUT>() as i32,
            )
        };
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    fn unsupported() -> String {
        format!(
            "native voice input is not implemented for {} yet",
            std::env::consts::OS
        )
    }

    use super::{Arc, AtomicBool};
    use std::sync::mpsc::Sender;

    pub fn run_hotkey_hook(running: Arc<AtomicBool>, _sender: Sender<bool>) {
        while running.running.load(std::sync::atomic::Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
    pub fn foreground_window_handle() -> Option<u64> {
        None
    }
    pub fn focus_window(_handle: u64) -> Result<(), String> {
        Err(unsupported())
    }
    pub fn tap_windows_h() -> Result<(), String> {
        Err(unsupported())
    }
    pub fn set_right_alt(_pressed: bool) -> Result<(), String> {
        Err(unsupported())
    }
    pub fn release_simulated_keys_best_effort() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_function_keys() {
        assert_eq!(parse_function_key("F1").unwrap(), 0x70);
        assert_eq!(parse_function_key("f7").unwrap(), 0x76);
        assert_eq!(parse_function_key("F24").unwrap(), 0x87);
        assert!(parse_function_key("Control+Alt+Space").is_err());
        assert!(parse_function_key("F25").is_err());
    }

    #[test]
    fn parses_supported_modes() {
        assert_eq!(
            InputMode::parse("windows_voice_typing").unwrap(),
            InputMode::WindowsVoiceTyping
        );
        assert_eq!(
            InputMode::parse("right_alt_hold").unwrap(),
            InputMode::RightAltHold
        );
    }

    #[test]
    fn rejects_invalid_window_handles() {
        assert!(parse_window_handle("").is_err());
        assert!(parse_window_handle("0").is_err());
        assert!(parse_window_handle("not-a-handle").is_err());
        assert_eq!(parse_window_handle("123").unwrap(), 123);
    }
}
