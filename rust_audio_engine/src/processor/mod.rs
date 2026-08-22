//! Audio Processor Module
//!
//! Realtime-safe DSP building blocks with lock-free parameter passing.
//! This experiment uses the pure-Rust Rubato 4.0 f64 route, extended with
//! half-band, spectral, and contiguous-polyphase paths. Offline multi-channel
//! resampling may parallelize across channels; realtime paths are
//! single-threaded and allocation-free.
//!
//! # Modules
//!
//! ## Core Processors
//! - [`StreamingResampler`] and [`Resampler`] - pure-Rust quality-routed resampling
//! - [`Equalizer`] - 10-band parametric IIR equalizer
//! - [`VolumeProcessor`] and [`NoiseShaper`] - Volume control and noise shaping
//! - [`SpectrumAnalyzer`] - FFT spectrum analyzer
//! - [`FFTConvolver`] - FFT convolution for FIR filters, with partitioned long-IR routing
//! - [`LoudnessNormalizer`], [`LoudnessMeter`], and [`TruePeakDetector`] - EBU R128 loudness normalization
//! - [`DynamicLoudness`] - ISO 226 dynamic loudness compensation (Fletcher-Munson)
//! - [`Saturation`] - Tube/tape saturation for analog warmth
//! - [`Crossfeed`] - Bauer binaural crossfeed for headphones
//! - [`FirEq`] - FIR EQ with linear/minimum phase options
//!
//! ## Unified Abstraction (Lock-Free Design)
//! - [`StreamingProcessor`] and streaming block/progress types - full consumed/produced,
//!   finish, latency/tail, and reset lifecycle
//! - [`lockfree_params`] - lock-free parameter structures for thread-safe parameter passing
//! - [`adapters`] - processor adapters implementing [`StreamingProcessor`]
//! - [`DspChain`] - composable DSP processing chain

mod atomic_f64;
mod convolver;
mod crossfeed;
mod dsp;
mod dynamic_loudness;
mod eq;
mod fir_design;
mod fir_eq;
mod loudness;
#[cfg(feature = "loudness-db")]
mod loudness_db;
mod output_chain;
mod resampler;
mod saturation;
mod spectrum;

// New unified abstraction modules
pub mod adapters;
pub mod dsp_chain;
pub mod lockfree_params;
pub mod traits;

// Public processor API re-exports.
pub use convolver::{
    ConvolutionStrategy, FFTConvolver, PARTITIONED_CONVOLUTION_IR_THRESHOLD,
    PARTITIONED_CONVOLUTION_PARTITION_SIZE,
};
pub use crossfeed::{Crossfeed, CrossfeedSettings};
pub use dsp::{db_to_linear, linear_to_db, NoiseShaper, NoiseShaperCurve};
pub use dynamic_loudness::{DynamicLoudness, LOUDNESS_BANDS, LOUDNESS_BANDS_N};
pub use eq::Equalizer;
pub use fir_eq::{FirEq, FirPhaseMode, STANDARD_BANDS};
pub use loudness::{
    AtomicLoudnessState, LimiterMode, LoudnessInfo, LoudnessMeter, LoudnessNormalizer, PeakLimiter,
    TruePeakDetector,
};
#[cfg(feature = "loudness-db")]
pub use loudness_db::{
    DatabaseStats, LoudnessDatabase, TrackLoudness, CURRENT_SCAN_VERSION,
    DEFAULT_STREAMING_TARGET_LUFS,
};
pub use output_chain::{
    callback_stage_names, callback_stage_order_csv, canonical_output_stage_descriptors,
    canonical_post_render_analysis_descriptors, offline_render_stage_names,
    offline_render_stage_order_csv, post_render_analysis_names, post_render_analysis_order_csv,
    OfflineRenderPolicy, OutputChainBuilder, OutputChainParams, OutputRenderChain,
    OutputStageDescriptor, OutputStageId, PostRenderAnalysisDescriptor, PostRenderAnalysisId,
    RenderTimeline, RenderedOutput, UnknownTailPolicy,
};
pub use resampler::{Resampler, ResamplerError, StreamingResampler, RESAMPLER_BACKEND_NAME};
pub use saturation::{Saturation, SaturationQuality, SaturationSettings, SaturationType};
pub use spectrum::SpectrumAnalyzer;

// Re-export unified abstraction types
pub use adapters::{
    ConvolverControl, ConvolverProcessor, ConvolverStatus, CrossfeedProcessor,
    DynamicLoudnessProcessor, EqProcessor, NoiseShaperProcessor, PeakLimiterProcessor,
    SaturationEvent, SaturationEventKind, SaturationProcessor, VolumeProcessor,
    SATURATION_TRANSITION_FRAMES,
};
pub use dsp_chain::{ChainFinishPolicy, DspChain};
pub use lockfree_params::{
    AtomicCrossfeedParams, AtomicDynamicLoudnessParams, AtomicDynamicLoudnessTelemetry,
    AtomicEqParams, AtomicNoiseShaperParams, AtomicPeakLimiterParams, AtomicSaturationParams,
    AtomicVolumeParams, CrossfeedParamsSnapshot, DynamicLoudnessParamsSnapshot,
    DynamicLoudnessTuningSnapshot, EqParamsSnapshot, NoiseShaperParamsSnapshot,
    PeakLimiterParamsSnapshot, RealtimeSnapshotReader, SaturationParamsSnapshot,
    SaturationQualityValue, SaturationTypeValue, VolumeParamsSnapshot, CROSSFEED_CUTOFF_HZ_MAX,
    CROSSFEED_CUTOFF_HZ_MIN, CROSSFEED_MIX_MAX, CROSSFEED_MIX_MIN,
    DYNAMIC_LOUDNESS_COMPENSATION_REF_DB_MAX, DYNAMIC_LOUDNESS_COMPENSATION_REF_DB_MIN,
    DYNAMIC_LOUDNESS_PRE_GAIN_DB_MAX, DYNAMIC_LOUDNESS_PRE_GAIN_DB_MIN,
    DYNAMIC_LOUDNESS_STRENGTH_MAX, DYNAMIC_LOUDNESS_STRENGTH_MIN,
    DYNAMIC_LOUDNESS_TRANSITION_DB_MAX, DYNAMIC_LOUDNESS_TRANSITION_DB_MIN,
    DYNAMIC_LOUDNESS_VOLUME_MAX, DYNAMIC_LOUDNESS_VOLUME_MIN, EQ_BANDS, EQ_BAND_GAIN_DB_MAX,
    EQ_BAND_GAIN_DB_MIN, LIMITER_RELEASE_MS_MAX, LIMITER_RELEASE_MS_MIN, LIMITER_THRESHOLD_DB_MAX,
    LIMITER_THRESHOLD_DB_MIN, NOISE_SHAPER_BITS_MAX, NOISE_SHAPER_BITS_MIN, SATURATION_DRIVE_MAX,
    SATURATION_DRIVE_MIN, SATURATION_GAIN_DB_MAX, SATURATION_GAIN_DB_MIN,
    SATURATION_HIGHPASS_CUTOFF_HZ_MAX, SATURATION_HIGHPASS_CUTOFF_HZ_MIN, SATURATION_MIX_MAX,
    SATURATION_MIX_MIN, SATURATION_THRESHOLD_MAX, SATURATION_THRESHOLD_MIN, VOLUME_MAX, VOLUME_MIN,
};
pub use traits::{
    finish_checked, process_checked, AudioBlockError, AudioBlockMut, AudioBlockRef,
    FixedInPlaceProcessor, FrameDuration, FrameRounding, ProcessBufferMode, ProcessBufferParts,
    ProcessBuffers, ProcessCapacity, ProcessError, ProcessProgress, ProcessState,
    StreamingProcessor, TailSpec, TimingError,
};
