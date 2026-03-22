//! VCP Hi-Fi Audio Engine - Audio Processor Module
//!
//! High-performance audio processing pipeline using Rayon for parallelization.
//! Restored SoX VHQ Resampler and High-Order Noise Shaping for f64 Hi-Fi path.
//!
//! # Modules
//!
//! ## Core Processors
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
//!
//! ## Unified Abstraction (Lock-Free Design)
//! - [`traits`] - AudioProcessor trait and ProcessResult enum
//! - [`lockfree_params`] - Lock-free parameter structures for thread-safe parameter passing
//! - [`adapters`] - Processor adapters implementing AudioProcessor trait
//! - [`dsp_chain`] - Composable DSP processing chain

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

// New unified abstraction modules
pub mod traits;
pub mod lockfree_params;
pub mod adapters;
pub mod dsp_chain;

// Re-export all public items for backward compatibility
pub use resampler::{Resampler, StreamingResampler, ResamplerError};
pub use eq::{BiquadSection, Equalizer};
pub use dsp::{VolumeController, NoiseShaper, NoiseShaperCurve, db_to_linear, linear_to_db};
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

// Re-export unified abstraction types
pub use traits::{
    AudioProcessor,
    ProcessResult,
    LockfreeParams,
    SampleRateAware,
    ChannelAware,
};
pub use lockfree_params::{
    EqParamsSnapshot,
    AtomicEqParams,
    SaturationParamsSnapshot,
    AtomicSaturationParams,
    SaturationTypeValue,
    CrossfeedParamsSnapshot,
    AtomicCrossfeedParams,
    PeakLimiterParamsSnapshot,
    AtomicPeakLimiterParams,
    VolumeParamsSnapshot,
    AtomicVolumeParams,
    NoiseShaperParamsSnapshot,
    AtomicNoiseShaperParams,
    DynamicLoudnessParamsSnapshot,
    AtomicDynamicLoudnessParams,
    AtomicDynamicLoudnessTelemetry,
    EQ_BANDS,
};
pub use adapters::{
    EqProcessor,
    SaturationProcessor,
    CrossfeedProcessor,
    PeakLimiterProcessor,
    VolumeProcessor,
    NoiseShaperProcessor,
    DynamicLoudnessProcessor,
    PassThroughProcessor,
};
pub use dsp_chain::{
    DspChain,
    DspChainBuilder,
    ChainStats,
    ProcessorStats,
};
