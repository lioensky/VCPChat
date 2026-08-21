use std::fs::OpenOptions;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
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

impl InstallerMode {
    fn from_args(args: impl IntoIterator<Item = impl AsRef<str>>) -> Self {
        if args.into_iter().any(|arg| arg.as_ref() == "--update") {
            Self::Update
        } else {
            Self::Install
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct InstallerStatus {
    running: bool,
    cancelling: bool,
    cancelled: bool,
    completed: bool,
    version: Option<String>,
    last_error: Option<String>,
    current_stage: Option<String>,
    source: source::SourceSnapshot,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StageInfo {
    id: String,
    title: String,
    detail: String,
}

fn stage_info(id: &str) -> StageInfo {
    let (title, detail) = match id {
        "locate-source" => ("定位 VCPChat", "确认项目目录和启动入口"),
        "inspect-git" => ("检查项目状态", "保护尚未提交的本地修改"),
        "stash-changes" => ("保护本地修改", "创建可恢复的命名 Git stash"),
        "fetch-upstream" => ("获取上游更新", "刷新当前分支的远端提交"),
        "update-source" => ("更新项目源码", "仅执行 fast-forward 更新"),
        "restore-changes" => ("恢复本地修改", "按记录的 stash OID 恢复并确认"),
        "repair-environment" => ("准备运行环境", "安装依赖并适配 Electron 原生模块"),
        "final-doctor" => ("验证运行环境", "确认 Electron、ABI 和原生服务均可用"),
        "resolve-runtime" => ("解析运行时", "查找可用的受管运行环境"),
        "verify-payload" => ("验证安装内容", "检查下载内容的完整性和签名"),
        _ => (id, "正在处理当前步骤"),
    };
    StageInfo {
        id: id.to_string(),
        title: title.to_string(),
        detail: detail.to_string(),
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum InstallerEvent {
    Manifest {
        stages: Vec<StageInfo>,
    },
    Stage {
        name: String,
        state: String,
        duration_ms: Option<u64>,
    },
    Log {
        line: String,
    },
    LaunchProgress {
        progress: f32,
        message: String,
    },
    Complete {
        version: String,
    },
    Cancelled,
    Failed {
        stage: Option<String>,
        error: String,
    },
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
    InstallerMode::from_args(std::env::args())
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

fn publish_cancelled(app: &AppHandle, status: &Arc<Mutex<InstallerStatus>>) {
    let _ = app.emit("installer", InstallerEvent::Cancelled);
    if let Ok(mut current) = status.lock() {
        current.running = false;
        current.cancelling = false;
        current.cancelled = true;
        current.last_error = None;
        current.current_stage = None;
    }
}

fn git_output(root: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let mut command = std::process::Command::new("git");
    command.args(args).current_dir(root);
    process::configure_hidden(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("运行 git {} 失败: {error}", args.join(" ")))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git(
    app: &AppHandle,
    state: &AppState,
    root: &std::path::Path,
    args: Vec<String>,
) -> Result<(), String> {
    run_git_with_cancel(app, state, root, args, &state.cancel)
}

fn run_git_with_cancel(
    app: &AppHandle,
    state: &AppState,
    root: &std::path::Path,
    args: Vec<String>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    let status = process::run(
        app,
        &state.active_child,
        cancel,
        &state.log,
        std::path::Path::new("git"),
        &args,
        root,
        &[],
    )?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("git {} 失败，退出状态 {status}", args.join(" ")))
    }
}

fn run_git_cleanup(
    app: &AppHandle,
    state: &AppState,
    root: &std::path::Path,
    args: Vec<String>,
) -> Result<(), String> {
    // Once user work has entered a stash, rollback and restoration must reach a
    // quiescent state even when the foreground operation was cancelled.
    let cleanup_cancel = Arc::new(AtomicBool::new(false));
    run_git_with_cancel(app, state, root, args, &cleanup_cancel)
}

fn emit_stage(
    app: &AppHandle,
    status: &Arc<Mutex<InstallerStatus>>,
    name: &str,
    state: &str,
    duration_ms: Option<u64>,
) {
    let _ = app.emit(
        "installer",
        InstallerEvent::Stage {
            name: name.to_string(),
            state: state.to_string(),
            duration_ms,
        },
    );
    if let Ok(mut current) = status.lock() {
        current.current_stage = (state == "running").then(|| name.to_string());
    }
}

fn find_stash_ref(root: &std::path::Path, oid: &str) -> Option<String> {
    git_output(root, &["stash", "list", "--format=%H%x09%gd"])
        .ok()?
        .lines()
        .find_map(|line| {
            let (candidate, reference) = line.split_once('\t')?;
            (candidate == oid).then(|| reference.to_string())
        })
}

fn restore_stash(
    app: &AppHandle,
    state: &AppState,
    root: &std::path::Path,
    oid: &str,
) -> Result<(), String> {
    run_git_cleanup(
        app,
        state,
        root,
        vec!["stash".into(), "apply".into(), "--index".into(), oid.into()],
    )?;
    let reference = find_stash_ref(root, oid)
        .ok_or_else(|| format!("本地修改已恢复，但找不到 stash {oid} 的引用，已保留备份"))?;
    run_git_cleanup(
        app,
        state,
        root,
        vec!["stash".into(), "drop".into(), reference],
    )
}

fn clean_failed_stash_apply(
    app: &AppHandle,
    state: &AppState,
    root: &std::path::Path,
    head: &str,
) -> Result<(), String> {
    run_git_cleanup(
        app,
        state,
        root,
        vec!["reset".into(), "--hard".into(), head.into()],
    )?;
    // The tree was clean immediately before stash apply. Removing only
    // untracked (not ignored) files clears partial apply output; originals are
    // still recoverable from the recorded stash OID.
    run_git_cleanup(app, state, root, vec!["clean".into(), "-fd".into()])
}

fn run_update_flow(
    app: &AppHandle,
    state: &AppState,
    status: &Arc<Mutex<InstallerStatus>>,
    root: &std::path::Path,
    strategy: Option<&str>,
) -> Result<String, String> {
    let stage_names = [
        "inspect-git",
        "stash-changes",
        "fetch-upstream",
        "update-source",
        "repair-environment",
        "final-doctor",
        "restore-changes",
    ];
    let _ = app.emit(
        "installer",
        InstallerEvent::Manifest {
            stages: stage_names.iter().map(|stage| stage_info(stage)).collect(),
        },
    );

    let original_head = git_output(root, &["rev-parse", "HEAD"])?;
    let dirty = !git_output(root, &["status", "--porcelain"])?.is_empty();
    let mut stash_oid: Option<String> = None;

    let started = Instant::now();
    emit_stage(app, status, "inspect-git", "running", None);
    git_output(root, &["rev-parse", "--abbrev-ref", "@{upstream}"])
        .map_err(|_| "当前分支没有配置 upstream，无法执行安全更新".to_string())?;
    if dirty && strategy != Some("stash") {
        emit_stage(
            app,
            status,
            "inspect-git",
            "failed",
            Some(started.elapsed().as_millis() as u64),
        );
        return Err("检测到本地修改；请选择“安全暂存并更新”或暂不更新".into());
    }
    emit_stage(
        app,
        status,
        "inspect-git",
        "succeeded",
        Some(started.elapsed().as_millis() as u64),
    );

    let started = Instant::now();
    emit_stage(app, status, "stash-changes", "running", None);
    if dirty {
        let previous_stash = git_output(root, &["rev-parse", "--verify", "refs/stash"]).ok();
        let label = format!(
            "vcpchat-installer/{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        );
        let stash_result = run_git(
            app,
            state,
            root,
            vec![
                "stash".into(),
                "push".into(),
                "--include-untracked".into(),
                "--message".into(),
                label,
            ],
        );
        if let Err(error) = stash_result {
            let candidate = git_output(root, &["rev-parse", "--verify", "refs/stash"]).ok();
            if candidate != previous_stash {
                if let Some(oid) = candidate.as_deref() {
                    return match restore_stash(app, state, root, oid) {
                        Ok(()) => Err(error),
                        Err(restore_error) => Err(format!(
                            "{error}；暂存操作中断后无法自动恢复，本地修改仍安全保存在 stash {oid}：{restore_error}。可在确认后运行 git stash apply --index {oid}"
                        )),
                    };
                }
            }
            return Err(error);
        }
        stash_oid = Some(git_output(root, &["rev-parse", "refs/stash"])?);
    }
    emit_stage(
        app,
        status,
        "stash-changes",
        if dirty { "succeeded" } else { "skipped" },
        Some(started.elapsed().as_millis() as u64),
    );

    let update_result = (|| -> Result<String, String> {
        let started = Instant::now();
        emit_stage(app, status, "fetch-upstream", "running", None);
        run_git(app, state, root, vec!["fetch".into(), "--prune".into()])?;
        emit_stage(
            app,
            status,
            "fetch-upstream",
            "succeeded",
            Some(started.elapsed().as_millis() as u64),
        );

        let started = Instant::now();
        emit_stage(app, status, "update-source", "running", None);
        run_git(
            app,
            state,
            root,
            vec!["merge".into(), "--ff-only".into(), "@{upstream}".into()],
        )?;
        emit_stage(
            app,
            status,
            "update-source",
            "succeeded",
            Some(started.elapsed().as_millis() as u64),
        );

        let started = Instant::now();
        emit_stage(app, status, "repair-environment", "running", None);
        run_source_repair(app, state, root)?;
        emit_stage(
            app,
            status,
            "repair-environment",
            "succeeded",
            Some(started.elapsed().as_millis() as u64),
        );

        let started = Instant::now();
        emit_stage(app, status, "final-doctor", "running", None);
        run_final_doctor(app, state, root)?;
        emit_stage(
            app,
            status,
            "final-doctor",
            "succeeded",
            Some(started.elapsed().as_millis() as u64),
        );
        let unexpected_changes = git_output(root, &["status", "--porcelain"])?;
        if !unexpected_changes.is_empty() {
            return Err(format!(
                "环境修复后源码目录出现意外修改，已停止恢复用户 stash：{}",
                unexpected_changes
                    .lines()
                    .take(5)
                    .collect::<Vec<_>>()
                    .join("；")
            ));
        }
        git_output(root, &["rev-parse", "--short=12", "HEAD"])
    })();

    if let Err(error) = update_result {
        let rollback_result = clean_failed_stash_apply(app, state, root, &original_head);
        if let Err(rollback_error) = rollback_result {
            return Err(format!(
                "{error}；源码自动回退失败：{rollback_error}。本地修改仍安全保存在 stash {}",
                stash_oid.as_deref().unwrap_or("（未创建）")
            ));
        }
        if let Some(oid) = stash_oid.as_deref() {
            if let Err(restore_error) = restore_stash(app, state, root, oid) {
                let cleanup_error = clean_failed_stash_apply(app, state, root, &original_head)
                    .err()
                    .map(|value| format!("；清理冲突工作树失败：{value}"))
                    .unwrap_or_default();
                return Err(format!(
                    "{error}；已回退源码，但本地修改仍安全保存在 stash {oid}：{restore_error}{cleanup_error}。可在确认后运行 git stash apply --index {oid}"
                ));
            }
        }
        return Err(error);
    }

    let revision = update_result?;
    let started = Instant::now();
    emit_stage(app, status, "restore-changes", "running", None);
    if let Some(oid) = stash_oid.as_deref() {
        if let Err(error) = restore_stash(app, state, root, oid) {
            let updated_head = git_output(root, &["rev-parse", "HEAD"]).unwrap_or_default();
            let cleanup_error = clean_failed_stash_apply(app, state, root, &updated_head)
                .err()
                .map(|value| format!("；清理冲突工作树失败：{value}"))
                .unwrap_or_default();
            emit_stage(
                app,
                status,
                "restore-changes",
                "failed",
                Some(started.elapsed().as_millis() as u64),
            );
            return Err(format!(
                "源码已更新，但本地修改无法自动恢复；本地修改仍安全保存在 stash {oid}。{error}{cleanup_error}。可在确认后运行 git stash apply --index {oid}"
            ));
        }
        emit_stage(
            app,
            status,
            "restore-changes",
            "succeeded",
            Some(started.elapsed().as_millis() as u64),
        );
    } else {
        emit_stage(
            app,
            status,
            "restore-changes",
            "skipped",
            Some(started.elapsed().as_millis() as u64),
        );
    }
    Ok(revision)
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
fn start_installer(
    app: AppHandle,
    state: State<'_, AppState>,
    strategy: Option<String>,
) -> Result<(), String> {
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
    status.cancelling = false;
    status.cancelled = false;
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
        if matches!(get_mode(), InstallerMode::Update) {
            let result = snapshot
                .root
                .as_deref()
                .ok_or_else(|| "未找到 VCPChat 源码，无法执行更新".to_string())
                .and_then(|root| {
                    run_update_flow(
                        &app,
                        &worker_state,
                        &status_ref,
                        std::path::Path::new(root),
                        strategy.as_deref(),
                    )
                });
            match result {
                Ok(version) => {
                    let _ = app.emit(
                        "installer",
                        InstallerEvent::Complete {
                            version: version.clone(),
                        },
                    );
                    if let Ok(mut current) = status_ref.lock() {
                        current.running = false;
                        current.cancelling = false;
                        current.cancelled = false;
                        current.completed = true;
                        current.version = Some(version);
                        current.last_error = None;
                        current.current_stage = None;
                    }
                }
                Err(_error) if cancel_ref.load(Ordering::Acquire) => {
                    publish_cancelled(&app, &status_ref);
                }
                Err(error) => {
                    let stage = status_ref
                        .lock()
                        .ok()
                        .and_then(|status| status.current_stage.clone());
                    let _ = app.emit(
                        "installer",
                        InstallerEvent::Failed {
                            stage,
                            error: error.clone(),
                        },
                    );
                    if let Ok(mut current) = status_ref.lock() {
                        current.running = false;
                        current.cancelling = false;
                        current.cancelled = false;
                        current.last_error = Some(error);
                        current.current_stage = None;
                    }
                }
            }
            return;
        }
        if snapshot.mode != "source-present" {
            let error =
                "未找到 VCPChat 源码；无源码 payload 下载、发布和回滚尚未完成，安装器已安全停止。"
                    .to_string();
            let _ = app.emit(
                "installer",
                InstallerEvent::Failed {
                    stage: None,
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
                stages: stages.iter().map(|stage| stage_info(stage)).collect(),
            },
        );
        for stage in stages {
            if cancel_ref.load(Ordering::Acquire) {
                publish_cancelled(&app, &status_ref);
                return;
            }
            let _ = app.emit(
                "installer",
                InstallerEvent::Stage {
                    name: stage.clone(),
                    state: "running".into(),
                    duration_ms: None,
                },
            );
            let stage_started = Instant::now();
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
                            name: stage.clone(),
                            state: "failed".into(),
                            duration_ms: Some(stage_started.elapsed().as_millis() as u64),
                        },
                    );
                    let _ = app.emit(
                        "installer",
                        InstallerEvent::Failed {
                            stage: Some(stage),
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
                        duration_ms: Some(stage_started.elapsed().as_millis() as u64),
                    },
                );
                continue;
            }
            if stage == "inspect-git"
                && snapshot.dirty
                && matches!(get_mode(), InstallerMode::Update)
            {
                let error = "检测到未提交源码修改；为避免覆盖用户工作，更新已阻止。".to_string();
                let _ = app.emit(
                    "installer",
                    InstallerEvent::Stage {
                        name: stage.clone(),
                        state: "failed".into(),
                        duration_ms: Some(stage_started.elapsed().as_millis() as u64),
                    },
                );
                let _ = app.emit(
                    "installer",
                    InstallerEvent::Failed {
                        stage: Some(stage),
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
                        if cancel_ref.load(Ordering::Acquire) {
                            publish_cancelled(&app, &status_ref);
                            return;
                        }
                        let _ = app.emit(
                            "installer",
                            InstallerEvent::Stage {
                                name: stage.clone(),
                                state: "failed".into(),
                                duration_ms: Some(stage_started.elapsed().as_millis() as u64),
                            },
                        );
                        let _ = app.emit(
                            "installer",
                            InstallerEvent::Failed {
                                stage: Some(stage),
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
                        if cancel_ref.load(Ordering::Acquire) {
                            publish_cancelled(&app, &status_ref);
                            return;
                        }
                        let _ = app.emit(
                            "installer",
                            InstallerEvent::Stage {
                                name: stage.clone(),
                                state: "failed".into(),
                                duration_ms: Some(stage_started.elapsed().as_millis() as u64),
                            },
                        );
                        let _ = app.emit(
                            "installer",
                            InstallerEvent::Failed {
                                stage: Some(stage),
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
                    duration_ms: Some(stage_started.elapsed().as_millis() as u64),
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
            current.cancelling = false;
            current.cancelled = false;
            current.completed = true;
            current.version = Some(version);
            current.current_stage = None;
        }
    });
    Ok(())
}

#[tauri::command]
fn cancel_installer(state: State<'_, AppState>) -> Result<(), String> {
    if let Ok(mut status) = state.status.lock() {
        if status.running {
            status.cancelling = true;
        }
    }
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
        if status.code() == Some(42) {
            return Err("VCPChat 已经在运行中。请切回已有的 VCPChat 窗口继续使用。".into());
        }
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
        Vec::<String>::new(),
    );
    #[cfg(target_os = "linux")]
    let (program, args) = (
        root.join("VCPChat").to_string_lossy().into_owned(),
        Vec::<String>::new(),
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

#[tauri::command]
fn open_log_directory(app: AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer");
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    command
        .arg(path)
        .spawn()
        .map_err(|error| format!("无法打开诊断记录目录: {error}"))?;
    Ok(())
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
                    cancelling: false,
                    cancelled: false,
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
            get_log_path,
            open_log_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running VCPChat Setup");
}
