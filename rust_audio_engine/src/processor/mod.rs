//! VCP Hi-Fi Audio Engine - Audio Processor Module
//!
//! High-performance audio processing pipeline using Rayon for parallelization.
//! Restored SoX VHQ Resampler and High-Order Noise Shaping for f64 Hi-Fi path.
//!
//! # Modules
//!
//! - [`resampler`] - SoX VHQ polyphase resampling
//! - [`eq`] - 10-band parametric IIR equalizer
//! - [`dsp`] - Volume control and noise shaping
//! - [`spectrum`] - FFT spectrum analyzer
//! - [`convolver`] - FFT convolution for FIR filters
//! - [`loudness`] - EBU R128 loudness normalization
//! - [`dynamic_loudness`] - ISO 226 dynamic loudness compensation (Fletcher-Munson)
//! - [`saturation`] - Tube/tape saturation for analog warmth
//! - [`crossfeed`] - Bauer binaural crossfeed for headphones
//! - [`fir_eq`] - FIR EQ with linear/minimum phase options

mod resampler;
mod eq;
mod dsp;
mod spectrum;
mod convolver;
mod loudness;
mod loudness_db;
mod dynamic_loudness;
mod saturation;
mod crossfeed;
mod fir_eq;

// Re-export all public items for backward compatibility
pub use resampler::{Resampler, StreamingResampler, ResamplerError};
pub use eq::{BiquadSection, Equalizer};
pub use dsp::{VolumeController, NoiseShaper, NoiseShaperCurve};
pub use spectrum::SpectrumAnalyzer;
pub use convolver::FFTConvolver;
pub use loudness::{
    LoudnessMeter,
    PeakLimiter,
    AtomicLoudnessState,
    LoudnessNormalizer,
    LoudnessInfo,
    GainRamp,
    TruePeakDetector,
};
pub use loudness_db::{
    LoudnessDatabase,
    TrackLoudness,
    DatabaseStats,
    CURRENT_SCAN_VERSION,
    DEFAULT_STREAMING_TARGET_LUFS,
    DEFAULT_BROADCAST_TARGET_LUFS,
};
pub use saturation::{
    Saturation,
    SaturationType,
    SaturationSettings,
};
pub use crossfeed::{
    Crossfeed,
    CrossfeedSettings,
};
pub use fir_eq::{
    FirEq,
    FirPhaseMode,
    STANDARD_BANDS,
};
pub use dynamic_loudness::{
    DynamicLoudness,
    AtomicDynamicLoudnessState,
    LOUDNESS_BANDS,
};
