#![windows_subsystem = "windows"]

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use winit::{
    event::{Event, WindowEvent, ElementState, MouseButton},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::{WindowBuilder, WindowLevel, Icon},
    dpi::{PhysicalSize, PhysicalPosition},
};
use softbuffer::{Context, Surface};
use image::{ImageFormat, GenericImageView, imageops::FilterType};
use tiny_skia::{Pixmap, PixmapPaint, Transform, Rect, Paint, Color};
use bytemuck;
use fontdue::{Font, FontSettings};
use serde::Deserialize;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const STARTUP_EVENT_PREFIX: &str = "VCP_STARTUP:";
const WINDOW_WIDTH: u32 = 500;
const WINDOW_HEIGHT: u32 = 130;
const ICON_SIZE: u32 = 96; // Resized icon dimension
const FONT_SIZE: f32 = 24.0;
const INITIAL_TEXT: &str = "正在唤醒 VChat…";
const FRAME_INTERVAL: Duration = Duration::from_millis(16); // 约 60 FPS，避免无上限忙轮询

#[derive(Debug)]
enum LauncherEvent {
    Progress { progress: f32, message: String },
    ProcessExited(Option<i32>),
}

#[derive(Deserialize)]
struct StartupEvent {
    progress: f32,
    message: String,
}

fn find_project_root() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.extend(parent.ancestors().map(Path::to_path_buf));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.extend(cwd.ancestors().map(Path::to_path_buf));
    }

    candidates
        .into_iter()
        .find(|path| {
            path.join("package.json").is_file()
                && path
                    .join("node_modules/electron/dist/electron.exe")
                    .is_file()
        })
        .ok_or_else(|| {
            "找不到 VChat 项目目录或 node_modules/electron/dist/electron.exe".to_string()
        })
}

fn append_log(log: &Arc<Mutex<File>>, source: &str, line: &str) {
    if let Ok(mut file) = log.lock() {
        let _ = writeln!(file, "[{source}] {line}");
        let _ = file.flush();
    }
}

fn spawn_vchat(
    project_root: &Path,
    proxy: winit::event_loop::EventLoopProxy<LauncherEvent>,
) -> Result<mpsc::Receiver<()>, String> {
    let electron = project_root.join("node_modules/electron/dist/electron.exe");
    let log_dir = project_root.join("AppData/logs");
    fs::create_dir_all(&log_dir).map_err(|error| error.to_string())?;
    let log = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(log_dir.join("launcher-latest.log"))
        .map(|file| Arc::new(Mutex::new(file)))
        .map_err(|error| error.to_string())?;

    let mut child = Command::new(electron)
        .arg(".")
        .current_dir(project_root)
        // Recovery/diagnostic processes may set this variable to run Electron
        // as Node.js. It must never reach the real GUI application; otherwise
        // require("electron") exposes no app API and main.js exits before a
        // window can be created.
        .env_remove("ELECTRON_RUN_AS_NODE")
        .env("VCP_LAUNCHER_PROTOCOL", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| format!("无法启动 Electron：{error}"))?;

    let stdout = child.stdout.take().ok_or("无法捕获 Electron stdout")?;
    let stderr = child.stderr.take().ok_or("无法捕获 Electron stderr")?;

    let stdout_log = Arc::clone(&log);
    let stdout_proxy = proxy.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            append_log(&stdout_log, "stdout", &line);
            if let Some(payload) = line.strip_prefix(STARTUP_EVENT_PREFIX) {
                if let Ok(event) = serde_json::from_str::<StartupEvent>(payload) {
                    let _ = stdout_proxy.send_event(LauncherEvent::Progress {
                        progress: event.progress.clamp(0.0, 1.0),
                        message: event.message,
                    });
                }
            }
        }
    });

    let stderr_log = Arc::clone(&log);
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            append_log(&stderr_log, "stderr", &line);
        }
    });

    let (done_tx, done_rx) = mpsc::channel();
    thread::spawn(move || {
        let code = child.wait().ok().and_then(|status| status.code());
        append_log(&log, "launcher", &format!("Electron exited: {code:?}"));
        let _ = proxy.send_event(LauncherEvent::ProcessExited(code));
        let _ = done_tx.send(());
    });

    Ok(done_rx)
}

fn rasterize_text(font: &Font, text: &str) -> Vec<(fontdue::Metrics, Option<Pixmap>)> {
    text.chars()
        .map(|character| {
            let (metrics, bitmap) = font.rasterize(character, FONT_SIZE);
            let pixmap = if metrics.width > 0 && metrics.height > 0 {
                let mut pixmap =
                    Pixmap::new(metrics.width as u32, metrics.height as u32).unwrap();
                for (pixel, &alpha) in pixmap.pixels_mut().iter_mut().zip(bitmap.iter()) {
                    *pixel = Color::from_rgba8(224, 224, 224, alpha)
                        .premultiply()
                        .to_color_u8();
                }
                Some(pixmap)
            } else {
                None
            };
            (metrics, pixmap)
        })
        .collect()
}
 
fn main() {
    // --- 1. Setup Event Loop and Window ---
    let event_loop = EventLoopBuilder::<LauncherEvent>::with_user_event()
        .build()
        .unwrap();
    let project_root = find_project_root().expect("Failed to locate VChat project");
    let process_done = spawn_vchat(&project_root, event_loop.create_proxy())
        .expect("Failed to launch VChat");

    let primary_monitor = event_loop.primary_monitor().expect("Failed to get primary monitor");
    let monitor_size = primary_monitor.size();
    let window_pos = PhysicalPosition {
        x: (monitor_size.width - WINDOW_WIDTH) / 2,
        y: (monitor_size.height - WINDOW_HEIGHT) / 2,
    };

    let window = Arc::new({
        let icon_image = image::load_from_memory_with_format(include_bytes!("../../assets/icon.png"), ImageFormat::Png).unwrap();
        let (width, height) = icon_image.dimensions();
        let icon = Icon::from_rgba(icon_image.into_rgba8().into_raw(), width, height).unwrap();

        WindowBuilder::new()
            .with_title("VCP Chat Loading...")
            .with_inner_size(PhysicalSize::new(WINDOW_WIDTH, WINDOW_HEIGHT))
            .with_position(window_pos)
            .with_decorations(false)
            .with_transparent(true)
            .with_resizable(false)
            .with_window_level(WindowLevel::AlwaysOnTop)
            .with_window_icon(Some(icon))
            .build(&event_loop)
            .unwrap()
    });

    let mut surface = {
        let context = Context::new(window.as_ref()).unwrap();
        Surface::new(&context, window.as_ref()).unwrap()
    };

    // --- 2. Load and prepare the splash image ---
    let splash_image_bytes = include_bytes!("../../assets/icon.png");
    let img = image::load_from_memory(splash_image_bytes).expect("Failed to load splash image");
    let resized_img = img.resize_exact(ICON_SIZE, ICON_SIZE, FilterType::Lanczos3);
    let mut img_rgba = resized_img.to_rgba8();

    // Manually premultiply alpha for correct transparency rendering
    for pixel in img_rgba.pixels_mut() {
        let alpha = pixel[3] as f32 / 255.0;
        pixel[0] = (pixel[0] as f32 * alpha) as u8;
        pixel[1] = (pixel[1] as f32 * alpha) as u8;
        pixel[2] = (pixel[2] as f32 * alpha) as u8;
    }

    let mut icon_pixmap = Pixmap::new(resized_img.width(), resized_img.height()).unwrap();
    icon_pixmap.pixels_mut().copy_from_slice(bytemuck::cast_slice(img_rgba.as_raw()));

    // --- 3. Load Font and cache the current status text ---
    let font_bytes = include_bytes!("ZiHun219Hao-MengQuLuoLiTi-2.ttf");
    let font = Font::from_bytes(font_bytes as &[u8], FontSettings::default())
        .expect("Failed to load font");
    let mut glyphs = rasterize_text(&font, INITIAL_TEXT);
    let mut target_progress = 0.05_f32;
    let mut displayed_progress = 0.0_f32;
    let mut startup_complete = false;
    let mut completion_deadline: Option<Instant> = None;

    // --- 4. Run the Event Loop ---
    let start_time = Instant::now();
    let mut next_frame_at = Instant::now();
    let window_clone = Arc::clone(&window);
    event_loop.run(move |event, elwt| {
        match event {
            Event::WindowEvent { window_id, event } if window_id == window_clone.id() => match event {
                WindowEvent::RedrawRequested => {
                    let size = window_clone.inner_size();
                    let width = size.width;
                    let height = size.height;

                    surface.resize(width.try_into().unwrap(), height.try_into().unwrap()).unwrap();
                    let mut buffer = surface.buffer_mut().unwrap();
                    
                    let mut canvas = Pixmap::new(width, height).unwrap();
                    
                    // Draw rounded background
                    let bg_rect = Rect::from_xywh(0.0, 0.0, width as f32, height as f32).unwrap();
                    let mut bg_paint = Paint::default();
                    bg_paint.set_color_rgba8(42, 42, 42, 230); // Semi-transparent dark background
                    canvas.fill_rect(bg_rect, &bg_paint, Transform::identity(), None);


                    let elapsed_secs = start_time.elapsed().as_secs_f32();

                    // Draw floating sparkles behind the icon
                    let sparkle_colors = [
                        (255, 215, 0, 185),
                        (255, 154, 205, 165),
                        (125, 211, 252, 175),
                    ];
                    for i in 0..6 {
                        let phase = elapsed_secs * (1.1 + i as f32 * 0.08) + i as f32 * 1.7;
                        let sparkle_x = 15.0 + (phase * 0.8).sin() * 7.0 + (i % 3) as f32 * 42.0;
                        let sparkle_y = 14.0 + (phase * 1.3).cos() * 8.0 + (i / 3) as f32 * 84.0;
                        let sparkle_size = 2.0 + (phase.sin() * 0.5 + 0.5) * 2.0;
                        let mut sparkle_paint = Paint::default();
                        let color = sparkle_colors[i % sparkle_colors.len()];
                        sparkle_paint.set_color_rgba8(color.0, color.1, color.2, color.3);
                        if let Some(rect) = Rect::from_xywh(sparkle_x, sparkle_y, sparkle_size, sparkle_size) {
                            canvas.fill_rect(rect, &sparkle_paint, Transform::identity(), None);
                        }
                    }

                    // Draw a gently bouncing icon
                    let icon_x = 20.0;
                    let icon_y = (height as f32 - ICON_SIZE as f32) / 2.0
                        + (elapsed_secs * 2.8).sin() * 2.5;
                    canvas.draw_pixmap(
                        0,
                        0,
                        icon_pixmap.as_ref(),
                        &PixmapPaint::default(),
                        Transform::from_translate(icon_x, icon_y),
                        None,
                    );

                    // Draw cached text glyphs with a soft travelling wave
                    let mut text_x = icon_x + ICON_SIZE as f32 + 20.0;
                    let text_y = height as f32 / 2.0 - 10.0;

                    for (i, (metrics, glyph_pixmap)) in glyphs.iter().enumerate() {
                        let y_offset = (elapsed_secs * 4.5 + i as f32 * 0.65).sin() * 2.0;
                        if let Some(glyph_pixmap) = glyph_pixmap {
                            canvas.draw_pixmap(
                                (text_x + metrics.xmin as f32) as i32,
                                (text_y - metrics.height as f32 + metrics.ymin as f32 + y_offset) as i32,
                                glyph_pixmap.as_ref(),
                                &PixmapPaint::default(),
                                Transform::identity(),
                                None,
                            );
                        }
                        text_x += metrics.advance_width;
                    }

                    // Draw progress bar
                    let progress_x = icon_x + ICON_SIZE as f32 + 20.0;
                    let progress_width = width as f32 - progress_x - 20.0;
                    let progress_y = height as f32 / 2.0 + 10.0;
                    let progress_height = 4.0;

                    let bg_bar_rect = Rect::from_xywh(progress_x, progress_y, progress_width, progress_height).unwrap();
                    let mut bg_bar_paint = Paint::default();
                    bg_bar_paint.set_color_rgba8(79, 79, 79, 255);
                    canvas.fill_rect(bg_bar_rect, &bg_bar_paint, Transform::identity(), None);

                    displayed_progress +=
                        (target_progress - displayed_progress) * 0.12;
                    let bar_rect = Rect::from_xywh(
                        progress_x,
                        progress_y,
                        progress_width * displayed_progress,
                        progress_height,
                    )
                    .unwrap();
                    let mut bar_paint = Paint::default();
                    bar_paint.set_color_rgba8(255, 215, 0, 255); // VCP Cyber Gold
                    canvas.fill_rect(bar_rect, &bar_paint, Transform::identity(), None);

                    // Three playful loading dots run just above the progress bar.
                    for i in 0..3 {
                        let phase = elapsed_secs * 5.0 - i as f32 * 0.7;
                        let lift = (phase.sin() * 0.5 + 0.5) * 3.0;
                        let dot_size = 3.0;
                        let dot_x = progress_x + progress_width - 30.0 + i as f32 * 9.0;
                        let dot_y = progress_y - 9.0 - lift;
                        let mut dot_paint = Paint::default();
                        dot_paint.set_color_rgba8(255, 215, 0, (150.0 + lift * 30.0) as u8);
                        if let Some(dot_rect) = Rect::from_xywh(dot_x, dot_y, dot_size, dot_size) {
                            canvas.fill_rect(dot_rect, &dot_paint, Transform::identity(), None);
                        }
                    }

                    // Copy canvas to buffer, converting RGBA to BGRA for softbuffer
                    for (i, pixel) in buffer.iter_mut().enumerate() {
                        let x = (i % width as usize) as u32;
                        let y = (i / width as usize) as u32;
                        if let Some(p) = canvas.pixel(x, y) {
                             *pixel = ((p.alpha() as u32) << 24)
                                  | ((p.red() as u32) << 16)
                                  | ((p.green() as u32) << 8)
                                  | (p.blue() as u32);
                        }
                    }
                    
                    buffer.present().unwrap();
                }
                WindowEvent::MouseInput { state: ElementState::Pressed, button: MouseButton::Left, .. } => {
                    let _ = window_clone.drag_window();
                }
                WindowEvent::CloseRequested => elwt.exit(),
                _ => {}
            },
            Event::UserEvent(LauncherEvent::Progress { progress, message }) => {
                target_progress = target_progress.max(progress);
                glyphs = rasterize_text(&font, &message);
                if progress >= 1.0 && !startup_complete {
                    startup_complete = true;
                    displayed_progress = 1.0;
                    // 保留 0.6 秒完成画面，让用户能看清“准备完成！”。
                    // 此期间事件循环仍按 60 FPS 工作，不阻塞窗口消息泵。
                    completion_deadline = Some(Instant::now() + Duration::from_millis(600));
                    window_clone.request_redraw();
                }
            }
            Event::UserEvent(LauncherEvent::ProcessExited(code)) => {
                if !startup_complete {
                    target_progress = 1.0;
                    glyphs = rasterize_text(
                        &font,
                        &format!("启动失败（退出码 {}）", code.unwrap_or(-1)),
                    );
                }
                elwt.exit();
            }
            Event::AboutToWait => {
                let now = Instant::now();
                if completion_deadline.is_some_and(|deadline| now >= deadline) {
                    window_clone.set_visible(false);
                    elwt.exit();
                    return;
                }
                if now >= next_frame_at {
                    window_clone.request_redraw();
                    next_frame_at = now + FRAME_INTERVAL;
                }
                elwt.set_control_flow(ControlFlow::WaitUntil(next_frame_at));
            }
            _ => {}
        }
    })
    .unwrap();

    // event_loop 的闭包已释放 Surface，但外层 Arc 仍持有原生窗口。
    // 必须先销毁它，再进入无窗口监督状态；否则主线程阻塞等待 Electron
    // 时，Windows 会把残留的 Splash 窗口标记为“未响应”。
    drop(window);

    // Splash 消失后保持无窗口监督进程，持续承接 stdout/stderr，
    // 直到 Electron 正常退出，避免关闭管道导致后续日志写入失败。
    let _ = process_done.recv();
}
