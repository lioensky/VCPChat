use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{self, BufRead, Write};

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
}

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
enum Command {
    Ping {
        #[serde(default)]
        request_id: Option<String>,
    },
    StartSession {
        #[serde(default)]
        request_id: Option<String>,
        mode: String,
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
            | Self::StartSession { request_id, .. }
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
    let stdout = io::stdout();
    let mut output = stdout.lock();
    if serde_json::to_writer(&mut output, &event).is_ok() {
        let _ = output.write_all(b"\n");
        let _ = output.flush();
    }
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

#[derive(Debug, Default)]
struct EngineState {
    mode: Option<InputMode>,
    restore_window_handle: Option<u64>,
    target_window_handle: Option<u64>,
    right_alt_held: bool,
    active: bool,
}

impl EngineState {
    fn start_session(&mut self, mode: InputMode, target: u64) -> Result<serde_json::Value, String> {
        self.release_all()?;

        let original = platform::foreground_window_handle();
        self.mode = Some(mode);
        self.restore_window_handle = original.filter(|handle| *handle != 0 && *handle != target);
        self.target_window_handle = Some(target);
        self.active = false;

        platform::focus_window(target)?;
        std::thread::sleep(std::time::Duration::from_millis(90));

        match mode {
            InputMode::WindowsVoiceTyping => platform::tap_windows_h()?,
            InputMode::RightAltHold => {
                platform::set_right_alt(true)?;
                self.right_alt_held = true;
            }
        }

        self.active = true;

        Ok(json!({
            "targetWindowHandle": target.to_string(),
            "restoreWindowHandle": self.restore_window_handle.map(|value| value.to_string())
        }))
    }

    fn stop_session(&mut self) -> Result<(), String> {
        if !self.active {
            self.release_all()?;
            return Ok(());
        }

        match self.mode {
            Some(InputMode::WindowsVoiceTyping) => platform::tap_windows_h()?,
            Some(InputMode::RightAltHold) => {
                platform::set_right_alt(false)?;
                self.right_alt_held = false;
            }
            None => {}
        }

        self.active = false;
        Ok(())
    }

    fn restore_focus(&mut self) -> Result<Option<u64>, String> {
        self.release_all()?;
        let restored = self.restore_window_handle.take();
        if let Some(handle) = restored {
            platform::focus_window(handle)?;
        }
        self.mode = None;
        self.target_window_handle = None;
        self.active = false;
        Ok(restored)
    }

    fn cancel(&mut self) -> Result<Option<u64>, String> {
        self.stop_session()?;
        self.restore_focus()
    }

    fn release_all(&mut self) -> Result<(), String> {
        let release_result = if self.right_alt_held {
            platform::set_right_alt(false)
        } else {
            Ok(())
        };
        platform::release_simulated_keys_best_effort();
        self.right_alt_held = false;
        release_result
    }
}

fn parse_window_handle(value: &str) -> Result<u64, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("target_window_handle is empty".to_string());
    }
    trimmed
        .parse::<u64>()
        .map_err(|_| format!("invalid target_window_handle: {trimmed}"))
        .and_then(|handle| {
            if handle == 0 {
                Err("target_window_handle must not be zero".to_string())
            } else {
                Ok(handle)
            }
        })
}

fn process_command(command: Command, state: &mut EngineState) -> bool {
    let request_id_owned = command.request_id().map(ToOwned::to_owned);
    let request_id = request_id_owned.as_deref();

    match command {
        Command::Ping { .. } => {
            emit(EngineEvent {
                event: "pong",
                success: true,
                request_id,
                mode: state.mode.map(InputMode::as_str),
                error: None,
                detail: Some(json!({
                    "platform": std::env::consts::OS,
                    "active": state.active,
                    "rightAltHeld": state.right_alt_held
                })),
            });
        }
        Command::StartSession {
            mode,
            target_window_handle,
            ..
        } => {
            let result = InputMode::parse(&mode)
                .and_then(|parsed_mode| {
                    parse_window_handle(&target_window_handle).map(|target| (parsed_mode, target))
                })
                .and_then(|(parsed_mode, target)| {
                    state
                        .start_session(parsed_mode, target)
                        .map(|detail| (parsed_mode, detail))
                });

            match result {
                Ok((parsed_mode, detail)) => emit(EngineEvent {
                    event: "started",
                    success: true,
                    request_id,
                    mode: Some(parsed_mode.as_str()),
                    error: None,
                    detail: Some(detail),
                }),
                Err(error) => emit_error(request_id, error),
            }
        }
        Command::StopSession { .. } => match state.stop_session() {
            Ok(()) => emit(EngineEvent {
                event: "stopped",
                success: true,
                request_id,
                mode: state.mode.map(InputMode::as_str),
                error: None,
                detail: None,
            }),
            Err(error) => emit_error(request_id, error),
        },
        Command::RestoreFocus { .. } => match state.restore_focus() {
            Ok(restored) => emit(EngineEvent {
                event: "focus_restored",
                success: true,
                request_id,
                mode: None,
                error: None,
                detail: Some(json!({
                    "restoredWindowHandle": restored.map(|value| value.to_string())
                })),
            }),
            Err(error) => emit_error(request_id, error),
        },
        Command::Cancel { .. } => match state.cancel() {
            Ok(restored) => emit(EngineEvent {
                event: "cancelled",
                success: true,
                request_id,
                mode: None,
                error: None,
                detail: Some(json!({
                    "restoredWindowHandle": restored.map(|value| value.to_string())
                })),
            }),
            Err(error) => emit_error(request_id, error),
        },
        Command::ReleaseAll { .. } => match state.release_all() {
            Ok(()) => emit(EngineEvent {
                event: "released",
                success: true,
                request_id,
                mode: state.mode.map(InputMode::as_str),
                error: None,
                detail: None,
            }),
            Err(error) => emit_error(request_id, error),
        },
        Command::Shutdown { .. } => {
            let result = state.cancel();
            match result {
                Ok(_) => emit(EngineEvent {
                    event: "shutdown",
                    success: true,
                    request_id,
                    mode: None,
                    error: None,
                    detail: None,
                }),
                Err(error) => emit_error(request_id, error),
            }
            return false;
        }
    }

    true
}

fn main() {
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
            "modes": ["windows_voice_typing", "right_alt_hold"]
        })),
    });

    let stdin = io::stdin();
    let mut state = EngineState::default();

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
                if !process_command(command, &mut state) {
                    return;
                }
            }
            Err(error) => emit_error(None, format!("invalid command JSON: {error}")),
        }
    }

    let _ = state.cancel();
}

#[cfg(target_os = "windows")]
mod platform {
    use std::mem::size_of;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VIRTUAL_KEY, VK_LWIN, VK_RMENU,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, IsWindow, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    const VK_H: VIRTUAL_KEY = VIRTUAL_KEY(0x48);

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
        unsafe {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        if unsafe { SetForegroundWindow(hwnd).as_bool() } {
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
        let flags = if pressed {
            KEYBD_EVENT_FLAGS(0)
        } else {
            KEYEVENTF_KEYUP
        };
        send_inputs(&[keyboard_input(VK_RMENU, flags)])
    }

    pub fn release_simulated_keys_best_effort() {
        let _ = send_inputs(&[
            keyboard_input(VK_H, KEYEVENTF_KEYUP),
            keyboard_input(VK_LWIN, KEYEVENTF_KEYUP),
            keyboard_input(VK_RMENU, KEYEVENTF_KEYUP),
        ]);
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    fn unsupported() -> String {
        format!(
            "native simulated voice input is not implemented for {} yet",
            std::env::consts::OS
        )
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
    fn parses_supported_modes_and_aliases() {
        assert_eq!(
            InputMode::parse("windows_voice_typing").unwrap(),
            InputMode::WindowsVoiceTyping
        );
        assert_eq!(
            InputMode::parse("win_h").unwrap(),
            InputMode::WindowsVoiceTyping
        );
        assert_eq!(
            InputMode::parse("right_alt").unwrap(),
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

    #[test]
    fn parses_tagged_commands() {
        let command: Command = serde_json::from_str(
            r#"{"command":"start_session","request_id":"r1","mode":"win_h","target_window_handle":"42"}"#,
        )
        .unwrap();
        assert_eq!(command.request_id(), Some("r1"));
    }
}
