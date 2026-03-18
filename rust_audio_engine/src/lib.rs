//! VCP Hi-Fi Audio Engine - Library Root
//!
//! This module exposes the audio engine as a library for direct Rust integration
//! or communication with the JS frontend via the server module.

pub mod decoder;
pub mod player;
pub mod processor;
pub mod server;
pub mod config;
pub mod pipeline;
pub mod webdav;
pub mod settings;
#[cfg(windows)]
pub mod wasapi_output;

// Re-exports for convenience
pub use decoder::StreamingDecoder;
pub use player::{AudioPlayer, PlayerState, AudioDeviceInfo, SharedState};
pub use processor::{Resampler, StreamingResampler, Equalizer, VolumeController, NoiseShaper, SpectrumAnalyzer, FFTConvolver, LoudnessMeter, LoudnessNormalizer, PeakLimiter, LoudnessInfo, AtomicLoudnessState, LoudnessDatabase, TrackLoudness, DatabaseStats, CURRENT_SCAN_VERSION, GainRamp, TruePeakDetector};
pub use config::{LoudnessConfig, NormalizationMode};
pub use pipeline::AudioPipeline;

/// Library version
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

// Note: Python bindings have been removed as the engine now communicates 
// directly with the JS frontend via WebSocket/HTTP.