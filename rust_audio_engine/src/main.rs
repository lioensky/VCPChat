//! VCP Hi-Fi Audio Engine - Main Entry Point
//!
//! Standalone server binary for the Rust audio engine.
//!
//! Note: Zero-allocation audit for audio callback is handled in audio_thread.rs
//! by wrapping the callback with assert_no_alloc::assert_no_alloc().
//! We do NOT replace the global allocator here as it would crash env_logger
//! initialization during startup.

mod decoder;
mod player;
mod processor;
mod server;
mod config;
mod pipeline;
mod webdav;
mod settings;
#[cfg(windows)]
mod wasapi_output;

use std::path::PathBuf;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // Initialize logger
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();
    
    log::info!("VCP Hi-Fi Audio Engine v2.0.0 (Full Rust)");
    log::info!("Built with: Symphonia + cpal + actix-web");
    
    // Parse command line args
    let args: Vec<String> = std::env::args().collect();
    let port = args
        .iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .and_then(|p| p.parse().ok())
        .unwrap_or(63789);
    
    // Load config
    let config = crate::config::AppConfig::load();
    
    // Determine AppData path for settings persistence
    let app_data_dir = std::env::var("VCP_APP_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            // Default to ./AppData relative to executable
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .unwrap_or_else(|| PathBuf::from("."))
                .join("AppData")
        });
    
    // Create settings manager
    let settings_manager = settings::create_settings_manager(&app_data_dir);
    
    // Run the server
    server::run_server(port, config, settings_manager).await
}