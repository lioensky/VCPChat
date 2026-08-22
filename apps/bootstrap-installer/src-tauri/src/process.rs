use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::InstallerEvent;

const STARTUP_EVENT_PREFIX: &str = "VCP_STARTUP:";

#[derive(serde::Deserialize)]
struct StartupEvent {
    progress: f32,
    message: String,
}

pub type ActiveChild = Arc<Mutex<Option<Child>>>;
pub type SharedLog = Arc<Mutex<File>>;

/// Prevent helper commands such as git/npm from creating a visible console
/// window on Windows. The Tauri installer itself is the only UI surface.
#[cfg(windows)]
pub fn configure_hidden(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
pub fn configure_hidden(_command: &mut Command) {}

pub fn run(
    app: &AppHandle,
    active_child: &ActiveChild,
    cancel: &Arc<AtomicBool>,
    log: &SharedLog,
    program: &Path,
    args: &[String],
    cwd: &Path,
    envs: &[(&str, String)],
) -> Result<ExitStatus, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in envs {
        command.env(key, value);
    }
    configure_process_group(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 {}：{error}", program.display()))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    {
        let mut slot = active_child
            .lock()
            .map_err(|_| "active child lock poisoned".to_string())?;
        if slot.is_some() {
            let _ = child.kill();
            return Err("已有受管子进程正在运行".into());
        }
        *slot = Some(child);
    }

    if let Some(stream) = stdout {
        stream_lines(app.clone(), log.clone(), "stdout", stream);
    }
    if let Some(stream) = stderr {
        stream_lines(app.clone(), log.clone(), "stderr", stream);
    }
    let mut termination_requested = false;
    let status = loop {
        if cancel.load(Ordering::Acquire) && !termination_requested {
            terminate_tree(pid);
            termination_requested = true;
        }
        let result = {
            let mut slot = active_child
                .lock()
                .map_err(|_| "active child lock poisoned".to_string())?;
            let child = slot
                .as_mut()
                .ok_or_else(|| "受管子进程所有权丢失".to_string())?;
            child
                .try_wait()
                .map_err(|error| format!("等待子进程失败：{error}"))?
        };
        if let Some(status) = result {
            break status;
        }
        thread::sleep(Duration::from_millis(50));
    };
    if let Ok(mut slot) = active_child.lock() {
        *slot = None;
    }
    if termination_requested {
        return Err("已取消当前操作".into());
    }
    Ok(status)
}

fn stream_lines<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    log: SharedLog,
    source: &'static str,
    stream: R,
) {
    thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            if let Ok(mut file) = log.lock() {
                let _ = writeln!(file, "[{source}] {line}");
                let _ = file.flush();
            }
            if let Some(payload) = line.strip_prefix(STARTUP_EVENT_PREFIX) {
                if let Ok(event) = serde_json::from_str::<StartupEvent>(payload) {
                    let _ = app.emit(
                        "installer",
                        InstallerEvent::LaunchProgress {
                            progress: event.progress.clamp(0.0, 1.0),
                            message: event.message,
                        },
                    );
                }
            }
            let _ = app.emit("installer", InstallerEvent::Log { line });
        }
    });
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
fn configure_process_group(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

#[cfg(unix)]
fn terminate_tree(pid: u32) {
    let _ = Command::new("kill")
        .args(["-TERM", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(windows)]
fn terminate_tree(pid: u32) {
    let _ = Command::new("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

pub fn cancel(active_child: &ActiveChild) {
    if let Ok(slot) = active_child.lock() {
        if let Some(child) = slot.as_ref() {
            terminate_tree(child.id());
        }
    }
}
