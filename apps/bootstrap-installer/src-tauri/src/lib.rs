use std::fs::OpenOptions;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

mod manifest;
mod process;
mod source;
mod storage;

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum InstallerMode {
    Install,
    Update,
}

#[derive(Clone, serde::Serialize)]
struct InstallerStatus {
    running: bool,
    completed: bool,
    version: Option<String>,
    last_error: Option<String>,
    current_stage: Option<String>,
    source: source::SourceSnapshot,
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum InstallerEvent {
    Manifest { stages: Vec<String> },
    Stage { name: String, state: String },
    Log { line: String },
    LaunchProgress { progress: f32, message: String },
    Complete { version: String },
    Failed { error: String },
}

struct AppState {
    status: Arc<Mutex<InstallerStatus>>,
    cancel: Arc<AtomicBool>,
    closing: Arc<AtomicBool>,
    active_child: process::ActiveChild,
    log: process::SharedLog,
}

#[tauri::command]
fn get_manifest() -> Result<manifest::InstallerManifest, String> {
    Ok(manifest::load_manifest()?.0)
}

#[tauri::command]
fn get_mode() -> InstallerMode {
    InstallerMode::Install
}

#[tauri::command]
fn get_installer_status(state: State<'_, AppState>) -> InstallerStatus {
    state
        .status
        .lock()
        .expect("installer status lock poisoned")
        .clone()
}

#[tauri::command]
fn get_source_snapshot() -> source::SourceSnapshot {
    source::inspect()
}

#[tauri::command]
fn get_update_snapshot() -> source::UpdateSnapshot {
    source::inspect_update()
}

#[tauri::command]
fn get_install_layout() -> storage::InstallLayout {
    let root = std::env::var_os("VCPCHAT_INSTALL_ROOT")
        .or_else(|| std::env::var_os("VCPCHAT_MANAGED_ROOT"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("vcpchat-managed"));
    storage::InstallLayout::new(root)
}

fn acquire_managed_lock() -> Result<storage::OperationLock, String> {
    let layout = get_install_layout();
    layout.acquire_lock()
}

fn run_source_repair(
    app: &AppHandle,
    state: &AppState,
    root: &std::path::Path,
) -> Result<(), String> {
    if std::env::var_os("VCPCHAT_INSTALLER_SKIP_REPAIR").is_some() {
        return Ok(());
    }
    let script = root.join("scripts/vcpchat-repair.mjs");
    if !script.is_file() {
        return Err("源码缺少 scripts/vcpchat-repair.mjs，无法执行受控依赖安装".into());
    }
    let doctor = root.join("scripts/vcpchat-doctor.mjs");
    if doctor.is_file() {
        let args = vec![
            doctor.to_string_lossy().into_owned(),
            "--deep".into(),
            "--json".into(),
            "--project-root".into(),
            root.to_string_lossy().into_owned(),
        ];
        let preflight = process::run(
            app,
            &state.active_child,
            &state.cancel,
            &state.log,
            std::path::Path::new("node"),
            &args,
            root,
            &[],
        );
        match preflight {
            Ok(status) if status.success() => return Ok(()),
            Err(error) if state.cancel.load(Ordering::Acquire) => return Err(error),
            _ => {}
        }
    }
    let args = vec![
        script.to_string_lossy().into_owned(),
        "--apply".into(),
        "--yes".into(),
        "--include-rust".into(),
        "--project-root".into(),
        root.to_string_lossy().into_owned(),
    ];
    let status = process::run(
        app,
        &state.active_child,
        &state.cancel,
        &state.log,
        std::path::Path::new("node"),
        &args,
        root,
        &[],
    )?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("依赖修复退出码 {status}"))
    }
}

fn run_final_doctor(
    app: &AppHandle,
    state: &AppState,
    root: &std::path::Path,
) -> Result<(), String> {
    let script = root.join("scripts/vcpchat-doctor.mjs");
    let args = vec![
        script.to_string_lossy().into_owned(),
        "--deep".into(),
        "--json".into(),
        "--project-root".into(),
        root.to_string_lossy().into_owned(),
    ];
    let status = process::run(
        app,
        &state.active_child,
        &state.cancel,
        &state.log,
        std::path::Path::new("node"),
        &args,
        root,
        &[],
    )?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("最终 Doctor 未通过，退出状态 {status}"))
    }
}

#[tauri::command]
fn start_installer(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let (current_manifest, custom_manifest) = manifest::load_manifest()?;
    let operation_lock = acquire_managed_lock()?;
    let mut status = state
        .status
        .lock()
        .map_err(|_| "installer status lock poisoned")?;
    if status.running {
        return Err("VCPChat installer is already running".into());
    }
    status.running = true;
    status.completed = false;
    status.last_error = None;
    status.current_stage = None;

    let status_ref = Arc::clone(&state.status);
    let cancel_ref = Arc::clone(&state.cancel);
    let active_child = Arc::clone(&state.active_child);
    let log = Arc::clone(&state.log);
    cancel_ref.store(false, Ordering::Release);
    std::thread::spawn(move || {
        let _operation_lock = operation_lock;
        let worker_state = AppState {
            status: Arc::clone(&status_ref),
            cancel: Arc::clone(&cancel_ref),
            closing: Arc::new(AtomicBool::new(false)),
            active_child,
            log,
        };
        let snapshot = source::inspect();
        if snapshot.mode != "source-present" {
            let error =
                "未找到 VCPChat 源码；无源码 payload 下载、发布和回滚尚未完成，安装器已安全停止。"
                    .to_string();
            let _ = app.emit(
                "installer",
                InstallerEvent::Failed {
                    error: error.clone(),
                },
            );
            if let Ok(mut current) = status_ref.lock() {
                current.running = false;
                current.last_error = Some(error);
                current.current_stage = None;
            }
            return;
        }
        let stages = if snapshot.mode == "source-present" {
            vec![
                "locate-source",
                "inspect-git",
                "repair-environment",
                "final-doctor",
            ]
        } else {
            vec!["locate-source", "resolve-runtime", "verify-payload"]
        }
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
        let _ = app.emit(
            "installer",
            InstallerEvent::Manifest {
                stages: stages.clone(),
            },
        );
        for stage in stages {
            if cancel_ref.load(Ordering::Acquire) {
                let error = "已取消当前安装操作".to_string();
                let _ = app.emit(
                    "installer",
                    InstallerEvent::Failed {
                        error: error.clone(),
                    },
                );
                if let Ok(mut current) = status_ref.lock() {
                    current.running = false;
                    current.last_error = Some(error);
                    current.current_stage = None;
                }
                return;
            }
            let _ = app.emit(
                "installer",
                InstallerEvent::Stage {
                    name: stage.clone(),
                    state: "running".into(),
                },
            );
            if let Ok(mut current) = status_ref.lock() {
                current.current_stage = Some(stage.clone());
            }
            let _ = app.emit(
                "installer",
                InstallerEvent::Log {
                    line: format!("开始检查：{stage}"),
                },
            );
            if stage == "verify-payload" && custom_manifest {
                if let Err(error) = manifest::verify_local_payload(&current_manifest) {
                    let _ = app.emit(
                        "installer",
                        InstallerEvent::Stage {
                            name: stage,
                            state: "failed".into(),
                        },
                    );
                    let _ = app.emit(
                        "installer",
                        InstallerEvent::Failed {
                            error: error.clone(),
                        },
                    );
                    if let Ok(mut current) = status_ref.lock() {
                        current.running = false;
                        current.last_error = Some(error);
                        current.current_stage = None;
                    }
                    return;
                }
            } else if stage == "verify-payload" {
                let _ = app.emit(
                    "installer",
                    InstallerEvent::Stage {
                        name: stage,
                        state: "skipped".into(),
                    },
                );
                continue;
            }
            if stage == "inspect-git" && snapshot.dirty {
                let error = "检测到未提交源码修改；为避免覆盖用户工作，更新已阻止。".to_string();
                let _ = app.emit(
                    "installer",
                    InstallerEvent::Stage {
                        name: stage,
                        state: "failed".into(),
                    },
                );
                let _ = app.emit(
                    "installer",
                    InstallerEvent::Failed {
                        error: error.clone(),
                    },
                );
                if let Ok(mut current) = status_ref.lock() {
                    current.running = false;
                    current.last_error = Some(error);
                    current.current_stage = None;
                }
                return;
            }
            if stage == "repair-environment" {
                if let Some(root) = snapshot.root.as_deref() {
                    if let Err(error) =
                        run_source_repair(&app, &worker_state, std::path::Path::new(root))
                    {
                        let _ = app.emit(
                            "installer",
                            InstallerEvent::Stage {
                                name: stage,
                                state: "failed".into(),
                            },
                        );
                        let _ = app.emit(
                            "installer",
                            InstallerEvent::Failed {
                                error: error.clone(),
                            },
                        );
                        if let Ok(mut current) = status_ref.lock() {
                            current.running = false;
                            current.last_error = Some(error);
                            current.current_stage = None;
                        }
                        return;
                    }
                }
            }
            if stage == "final-doctor" {
                if let Some(root) = snapshot.root.as_deref() {
                    if let Err(error) =
                        run_final_doctor(&app, &worker_state, std::path::Path::new(root))
                    {
                        let _ = app.emit(
                            "installer",
                            InstallerEvent::Stage {
                                name: stage,
                                state: "failed".into(),
                            },
                        );
                        let _ = app.emit(
                            "installer",
                            InstallerEvent::Failed {
                                error: error.clone(),
                            },
                        );
                        if let Ok(mut current) = status_ref.lock() {
                            current.running = false;
                            current.last_error = Some(error);
                            current.current_stage = None;
                        }
                        return;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(60));
            let _ = app.emit(
                "installer",
                InstallerEvent::Stage {
                    name: stage,
                    state: "succeeded".into(),
                },
            );
        }
        let version = current_manifest.version.clone();
        let _ = app.emit(
            "installer",
            InstallerEvent::Complete {
                version: version.clone(),
            },
        );
        if let Ok(mut current) = status_ref.lock() {
            current.running = false;
            current.completed = true;
            current.version = Some(version);
            current.current_stage = None;
        }
    });
    Ok(())
}

#[tauri::command]
fn cancel_installer(state: State<'_, AppState>) -> Result<(), String> {
    state.cancel.store(true, Ordering::Release);
    process::cancel(&state.active_child);
    Ok(())
}

#[tauri::command]
async fn launch_vcpchat(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let root = std::env::var_os("VCPCHAT_INSTALL_ROOT")
        .or_else(|| std::env::var_os("VCPCHAT_PROJECT_ROOT"))
        .or_else(|| source::inspect().root.map(std::ffi::OsString::from))
        .ok_or_else(|| "未找到 VCPChat 源码或受管安装目录，无法执行 ready handoff".to_string())?;
    let root = std::path::PathBuf::from(root);
    let managed_launcher = root.join("scripts/vcpchat.mjs");
    if managed_launcher.is_file() {
        state.cancel.store(false, Ordering::Release);
        let worker_app = app.clone();
        let active_child = Arc::clone(&state.active_child);
        let cancel = Arc::clone(&state.cancel);
        let log = Arc::clone(&state.log);
        let args = vec![
            managed_launcher.to_string_lossy().into_owned(),
            "--project-root".into(),
            root.to_string_lossy().into_owned(),
            "--handoff".into(),
        ];
        let envs = [
            ("VCPCHAT_PROJECT_ROOT", root.to_string_lossy().into_owned()),
            (
                "VCPCHAT_APP_DATA_DIR",
                root.join("AppData").to_string_lossy().into_owned(),
            ),
        ];
        let worker_root = root.clone();
        let status = tauri::async_runtime::spawn_blocking(move || {
            process::run(
                &worker_app,
                &active_child,
                &cancel,
                &log,
                std::path::Path::new("node"),
                &args,
                &worker_root,
                &envs,
            )
        })
        .await
        .map_err(|error| format!("VCPChat handoff worker failed: {error}"))??;
        if !status.success() {
            return Err(format!("VCPChat ready handoff 失败，退出状态 {status}"));
        }
        app.exit(0);
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    let (program, args) = {
        let bundle = root.join("VCPChat.app");
        if bundle.exists() {
            (
                "/usr/bin/open".into(),
                vec![bundle.to_string_lossy().into_owned()],
            )
        } else {
            (
                root.join("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
                    .to_string_lossy()
                    .into_owned(),
                vec![root.to_string_lossy().into_owned()],
            )
        }
    };
    #[cfg(target_os = "windows")]
    let (program, args) = (
        root.join("VCPChat.exe").to_string_lossy().into_owned(),
        Vec::new(),
    );
    #[cfg(target_os = "linux")]
    let (program, args) = (
        root.join("VCPChat").to_string_lossy().into_owned(),
        Vec::new(),
    );
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map_err(|error| format!("failed to launch VCPChat: {error}"))?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn get_log_path(app: AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .app_log_dir()
        .map_err(|e| e.to_string())?
        .join("vcpchat-installer.log");
    Ok(path.to_string_lossy().into_owned())
}

pub fn run() {
    tauri::Builder::default()
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let child_active = state
                    .active_child
                    .lock()
                    .map(|slot| slot.is_some())
                    .unwrap_or(true);
                let operation_running = state
                    .status
                    .lock()
                    .map(|status| status.running)
                    .unwrap_or(true);
                if !child_active && !operation_running {
                    return;
                }
                api.prevent_close();
                if state.closing.swap(true, Ordering::AcqRel) {
                    return;
                }
                state.cancel.store(true, Ordering::Release);
                process::cancel(&state.active_child);
                let app = window.app_handle().clone();
                let active_child = Arc::clone(&state.active_child);
                std::thread::spawn(move || {
                    for _ in 0..300 {
                        let settled = active_child
                            .lock()
                            .map(|slot| slot.is_none())
                            .unwrap_or(false);
                        if settled {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    app.exit(0);
                });
            }
        })
        .setup(|app| {
            let log_path = app
                .path()
                .app_log_dir()
                .map_err(|error| error.to_string())?
                .join("vcpchat-installer.log");
            if let Some(parent) = log_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let log = OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_path)?;
            app.manage(AppState {
                status: Arc::new(Mutex::new(InstallerStatus {
                    running: false,
                    completed: false,
                    version: None,
                    last_error: None,
                    current_stage: None,
                    source: source::inspect(),
                })),
                cancel: Arc::new(AtomicBool::new(false)),
                closing: Arc::new(AtomicBool::new(false)),
                active_child: Arc::new(Mutex::new(None)),
                log: Arc::new(Mutex::new(log)),
            });
            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_mode,
            get_installer_status,
            get_source_snapshot,
            get_update_snapshot,
            get_install_layout,
            get_manifest,
            start_installer,
            cancel_installer,
            launch_vcpchat,
            get_log_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running VCPChat Setup");
}
