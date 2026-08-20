#![windows_subsystem = "windows"]

use std::path::Path;
use std::sync::Arc;
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

const READY_SIGNAL_FILE: &str = ".vcp_ready";
const WINDOW_WIDTH: u32 = 500;
const WINDOW_HEIGHT: u32 = 130;
const ICON_SIZE: u32 = 96; // Resized icon dimension
const ANIMATION_DURATION_SECS: f32 = 2.8; // Pseudo-load duration (Speed increased by 2x)
const FONT_SIZE: f32 = 24.0;
const TEXT_TO_RENDER: &str = "VChat正在启动中！~";
const FRAME_INTERVAL: Duration = Duration::from_millis(16); // 约 60 FPS，避免无上限忙轮询

// 缓动函数：ease_out_quad(t) = t * (2 - t)
fn ease_out_quad(t: f32) -> f32 {
    t * (2.0 - t)
}
 
fn main() {
    // --- 1. Setup Event Loop and Window ---
    let event_loop = EventLoopBuilder::<()>::with_user_event().build().unwrap();

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

    // --- 3. Start the file watcher thread ---
    let event_loop_proxy = event_loop.create_proxy();
    thread::spawn(move || {
        while !Path::new(READY_SIGNAL_FILE).exists() {
            thread::sleep(Duration::from_millis(200));
        }
        let _ = event_loop_proxy.send_event(());
    });

    // --- 4. Load Font and cache glyphs ---
    // 字形只栅格化一次，避免动画每帧重复分配 Pixmap 和生成位图。
    let font_bytes = include_bytes!("蒙纳简漫画体.ttf");
    let font = Font::from_bytes(font_bytes as &[u8], FontSettings::default()).expect("Failed to load font");
    let glyphs: Vec<_> = TEXT_TO_RENDER
        .chars()
        .map(|character| {
            let (metrics, bitmap) = font.rasterize(character, FONT_SIZE);
            let pixmap = if metrics.width > 0 && metrics.height > 0 {
                let mut pixmap = Pixmap::new(metrics.width as u32, metrics.height as u32).unwrap();
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
        .collect();

    // --- 5. Run the Event Loop ---
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

                    let elapsed = start_time.elapsed().as_secs_f32();
                    let t = (elapsed / ANIMATION_DURATION_SECS).min(1.0);
                    let progress = ease_out_quad(t).min(0.95);
                    let bar_rect = Rect::from_xywh(progress_x, progress_y, progress_width * progress, progress_height).unwrap();
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
            Event::UserEvent(()) => elwt.exit(),
            Event::AboutToWait => {
                let now = Instant::now();
                if now >= next_frame_at {
                    window_clone.request_redraw();
                    next_frame_at = now + FRAME_INTERVAL;
                }
                elwt.set_control_flow(ControlFlow::WaitUntil(next_frame_at));
            }
            _ => {}
        }
    }).unwrap();
}
