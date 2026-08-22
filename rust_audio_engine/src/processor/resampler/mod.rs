//! High-quality streaming resampling with a pluggable compile-time backend.
//!
//! Two backends implement the same streaming contract (arbitrary input
//! granularity, duration-aligned drain, `clear` restoring initial state): the
//! pure-Rust rubato backend (`rubato` feature, default), which routes common
//! sample-rate ratios through FFT resampling at every quality tier (UltraHigh
//! selects a 2x longer single-sub-chunk FFT filter) and uses windowed sinc only
//! for pathological ratios, and the native SoXR / SoX VHQ backend (`soxr`
//! feature, opt-in). When both features are enabled, SoXR
//! wins. The public `Resampler` / `StreamingResampler` API is identical for
//! both.
//!
//! One auto trait differs. [`StreamingResampler`] is `Send` under either
//! backend, but on the rubato backend it is **not** `Sync`, `UnwindSafe`, or
//! `RefUnwindSafe`, because rubato's `Async<f64>` holds a
//! `Box<dyn InnerResampler<f64>>` whose trait object does not declare those auto
//! traits. Every method that advances state takes `&mut self`, so
//! `Arc<Mutex<StreamingResampler>>` (needs only `Send`) and moving the resampler
//! to the audio thread both still work; only `Arc<StreamingResampler>` is
//! rejected. Enable `soxr` if the `Sync` impl itself is required.

use crate::config::{PhaseResponse, ResampleQuality};
use thiserror::Error;

#[cfg(not(any(feature = "soxr", feature = "rubato")))]
compile_error!(
    "audio-engine-core requires a resampler backend: enable the default `rubato` feature \
     (pure Rust) or the opt-in `soxr` feature (native SoX VHQ, links LGPL-2.1 libsoxr)."
);

#[cfg(all(feature = "rubato", not(feature = "soxr")))]
mod contiguous_polyphase_backend;
#[cfg(all(feature = "rubato", not(feature = "soxr")))]
mod halfband_backend;
#[cfg(all(feature = "rubato", not(feature = "soxr")))]
mod polyphase_backend;
#[cfg(all(feature = "rubato", not(feature = "soxr")))]
mod rubato_backend;
#[cfg(feature = "soxr")]
mod soxr_backend;
#[cfg(all(feature = "rubato", not(feature = "soxr")))]
mod spectral_backend;

#[cfg(all(feature = "rubato", not(feature = "soxr")))]
use rubato_backend::{MonoBackend, BACKEND_NAME};
#[cfg(feature = "soxr")]
use soxr_backend::{MonoBackend, BACKEND_NAME};

/// Compile-time selected resampler backend name: `"rubato"` (pure Rust,
/// default) or `"soxr"` (native SoX VHQ, opt-in). Follows the same precedence as
/// the backend selection above — SoXR wins when both features are enabled — so
/// benchmark reports and diagnostics can label the measured backend without
/// re-deriving feature-precedence logic.
pub const RESAMPLER_BACKEND_NAME: &str = BACKEND_NAME;

/// Per-call progress reported by a selected backend stream.
struct BackendProgress {
    input_frames: usize,
    output_frames: usize,
}

#[derive(Debug, Error)]
enum BackendInitError {
    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    #[error("channel count must be at least one")]
    ZeroChannels,
    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    #[error("invalid {backend} geometry")]
    InvalidGeometry { backend: &'static str },
    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    #[error("{backend} requires nonlinear phase")]
    NonlinearPhaseRequired { backend: &'static str },
    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    #[error("reduced ratio {up}:{down} exceeds nonlinear phase limit {limit}")]
    RatioExceedsLimit {
        up: usize,
        down: usize,
        limit: usize,
    },
    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    #[error("nonlinear coefficient count overflow")]
    CoefficientCountOverflow,
    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    #[error(
        "nonlinear coefficient bank is too large: {coefficients} coefficients (maximum {maximum})"
    )]
    CoefficientBankTooLarge { coefficients: usize, maximum: usize },
    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    #[error("{buffer} storage overflow")]
    StorageOverflow { buffer: &'static str },
    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    #[error("nonlinear minimum-phase factor was empty")]
    EmptyMinimumPhaseFactor,
    #[error("backend rejected initialization: {message}")]
    Backend { message: String },
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("{message}")]
struct BackendProcessError {
    message: &'static str,
}

impl BackendProcessError {
    const fn new(message: &'static str) -> Self {
        Self { message }
    }

    const fn message(self) -> &'static str {
        self.message
    }
}

impl From<&'static str> for BackendProcessError {
    fn from(message: &'static str) -> Self {
        Self::new(message)
    }
}

use super::traits::{
    AudioBlockError, AudioBlockMut, AudioBlockRef, FrameDuration, FrameRounding, ProcessBufferMode,
    ProcessBufferParts, ProcessBuffers, ProcessError, ProcessProgress, ProcessState,
    StreamingProcessor, TailSpec,
};

/// Error type for resampler construction and offline operations.
#[derive(Debug, Clone, Error)]
#[non_exhaustive]
pub enum ResamplerError {
    /// Either input or output sample rate is zero.
    #[error("invalid resampler sample rates: {from_rate} Hz -> {to_rate} Hz")]
    InvalidSampleRate {
        /// Rejected input sample rate in hertz.
        from_rate: u32,
        /// Rejected output sample rate in hertz.
        to_rate: u32,
    },
    /// Interleaved resampling requires at least one channel.
    #[error("resampler channel count must be at least one")]
    ZeroChannels,
    /// One-shot input does not contain complete interleaved frames.
    #[error(transparent)]
    InvalidBlock(#[from] AudioBlockError),
    /// Checked sizing of a reusable buffer or working set overflowed.
    #[error("resampler {buffer} capacity overflow")]
    CapacityOverflow {
        /// Logical buffer whose checked capacity calculation overflowed.
        buffer: &'static str,
    },
    /// A nonlinear reduced ratio exceeds the supported bounded design.
    #[error("reduced ratio {up}:{down} exceeds nonlinear phase limit {limit}")]
    RatioExceedsLimit {
        /// Reduced interpolation factor.
        up: usize,
        /// Reduced decimation factor.
        down: usize,
        /// Maximum supported factor on either side of the ratio.
        limit: usize,
    },
    /// Nonlinear coefficient-count arithmetic overflowed.
    #[error("nonlinear resampler coefficient count overflow")]
    CoefficientCountOverflow,
    /// A nonlinear coefficient bank exceeds its bounded maximum.
    #[error(
        "nonlinear coefficient bank is too large: {coefficients} coefficients (maximum {maximum})"
    )]
    CoefficientBankTooLarge {
        /// Coefficient count required by the requested geometry.
        coefficients: usize,
        /// Maximum bounded coefficient count accepted by the implementation.
        maximum: usize,
    },
    /// The selected internal backend rejected its geometry or phase contract.
    #[error("{backend} backend geometry is invalid")]
    InvalidBackendGeometry {
        /// Selected backend whose geometry contract was rejected.
        backend: &'static str,
    },
    /// Minimum-phase conversion produced no usable factor.
    #[error("nonlinear minimum-phase factor was empty")]
    EmptyMinimumPhaseFactor,
    /// A third-party backend rejected initialization.
    #[error("{backend} backend initialization failed for channel {channel:?}: {message}")]
    BackendInitialization {
        /// Backend that rejected initialization.
        backend: &'static str,
        /// Affected zero-based channel, or `None` for shared setup.
        channel: Option<usize>,
        /// Backend-owned initialization diagnostic.
        message: String,
    },
    /// A timing value derived from the backend violated the lifecycle contract.
    #[error("invalid resampler {metric}: {message}")]
    InvalidTiming {
        /// Timing quantity that violated the streaming contract.
        metric: &'static str,
        /// Description of the invalid value or relationship.
        message: String,
    },
    /// A backend returned consumed/produced counts outside caller capacity.
    #[error("resampler backend returned invalid {operation} progress for channel {channel:?}")]
    InvalidBackendProgress {
        /// Backend operation that returned invalid progress.
        operation: &'static str,
        /// Affected zero-based channel, or `None` for shared processing.
        channel: Option<usize>,
    },
    /// A backend made no progress while work remained.
    #[error("resampler backend stalled during {operation} for channel {channel:?}")]
    BackendStalled {
        /// Backend operation that failed to make progress.
        operation: &'static str,
        /// Affected zero-based channel, or `None` for shared processing.
        channel: Option<usize>,
    },
    /// A backend operation failed with a backend-owned diagnostic.
    #[error("resampler backend {operation} failed for channel {channel:?}: {message}")]
    BackendProcess {
        /// Backend operation that failed.
        operation: &'static str,
        /// Affected zero-based channel, or `None` for shared processing.
        channel: Option<usize>,
        /// Static backend diagnostic suitable for realtime propagation.
        message: &'static str,
    },
}

fn map_backend_init_error(error: BackendInitError, channel: Option<usize>) -> ResamplerError {
    match error {
        #[cfg(all(feature = "rubato", not(feature = "soxr")))]
        BackendInitError::ZeroChannels => ResamplerError::ZeroChannels,
        #[cfg(all(feature = "rubato", not(feature = "soxr")))]
        BackendInitError::InvalidGeometry { .. }
        | BackendInitError::NonlinearPhaseRequired { .. } => {
            ResamplerError::InvalidBackendGeometry {
                backend: BACKEND_NAME,
            }
        }
        #[cfg(all(feature = "rubato", not(feature = "soxr")))]
        BackendInitError::RatioExceedsLimit { up, down, limit } => {
            ResamplerError::RatioExceedsLimit { up, down, limit }
        }
        #[cfg(all(feature = "rubato", not(feature = "soxr")))]
        BackendInitError::CoefficientCountOverflow => ResamplerError::CoefficientCountOverflow,
        #[cfg(all(feature = "rubato", not(feature = "soxr")))]
        BackendInitError::CoefficientBankTooLarge {
            coefficients,
            maximum,
        } => ResamplerError::CoefficientBankTooLarge {
            coefficients,
            maximum,
        },
        #[cfg(all(feature = "rubato", not(feature = "soxr")))]
        BackendInitError::StorageOverflow { buffer } => ResamplerError::CapacityOverflow { buffer },
        #[cfg(all(feature = "rubato", not(feature = "soxr")))]
        BackendInitError::EmptyMinimumPhaseFactor => ResamplerError::EmptyMinimumPhaseFactor,
        BackendInitError::Backend { message } => ResamplerError::BackendInitialization {
            backend: BACKEND_NAME,
            channel,
            message,
        },
    }
}

/// High-quality resampler driving one backend stream per channel.
pub struct Resampler {
    channels: usize,
    from_rate: u32,
    to_rate: u32,
}

const ONE_SHOT_INPUT_CHUNK_FRAMES: usize = 8_192;
const PROCESS_OUTPUT_BURST_SLACK_FRAMES: usize = 64;

fn validate_resampler_geometry(
    channels: usize,
    from_rate: u32,
    to_rate: u32,
) -> Result<(), ResamplerError> {
    if channels == 0 {
        return Err(ResamplerError::ZeroChannels);
    }
    if from_rate == 0 || to_rate == 0 {
        return Err(ResamplerError::InvalidSampleRate { from_rate, to_rate });
    }
    Ok(())
}

fn converted_output_frames(
    input_frames: usize,
    from_rate: u32,
    to_rate: u32,
    buffer: &'static str,
) -> Result<usize, ResamplerError> {
    FrameDuration::new(input_frames, from_rate)
        .and_then(|duration| duration.rounded_frames_at_rate(to_rate, FrameRounding::Ceil))
        .map_err(|_| ResamplerError::CapacityOverflow { buffer })
}

fn process_output_capacity_frames(
    input_frames: usize,
    from_rate: u32,
    to_rate: u32,
) -> Result<usize, ResamplerError> {
    if input_frames == 0 {
        return Ok(0);
    }
    converted_output_frames(input_frames, from_rate, to_rate, "process output")?
        .checked_add(PROCESS_OUTPUT_BURST_SLACK_FRAMES)
        .ok_or(ResamplerError::CapacityOverflow {
            buffer: "process output",
        })
}

fn deinterleave_frame_major(
    input: &[f64],
    channels: usize,
    frames: usize,
    channel_inputs: &mut [Vec<f64>],
) {
    for frame in input[..frames * channels].chunks_exact(channels) {
        for (ch, &sample) in frame.iter().enumerate() {
            channel_inputs[ch].push(sample);
        }
    }
}

fn channel_outputs_have_frames(
    channel_outputs: &[Vec<f64>],
    channels: usize,
    frames: usize,
) -> bool {
    channel_outputs
        .iter()
        .take(channels)
        .all(|channel| channel.len() >= frames)
}

fn interleave_channel_outputs_to_vec(
    channel_outputs: &[Vec<f64>],
    channels: usize,
    output: &mut Vec<f64>,
) -> Result<usize, ResamplerError> {
    if channel_outputs.is_empty() || channel_outputs[0].is_empty() {
        output.clear();
        return Ok(0);
    }

    let out_frames = channel_outputs[0].len();
    output.clear();
    let output_samples =
        out_frames
            .checked_mul(channels)
            .ok_or(ResamplerError::CapacityOverflow {
                buffer: "one-shot interleaved output",
            })?;
    output.reserve(output_samples);

    if channel_outputs_have_frames(channel_outputs, channels, out_frames) {
        for frame in 0..out_frames {
            for channel in channel_outputs.iter().take(channels) {
                output.push(channel[frame]);
            }
        }
    } else {
        for frame in 0..out_frames {
            for channel in channel_outputs.iter().take(channels) {
                output.push(channel.get(frame).copied().unwrap_or(0.0));
            }
        }
    }

    Ok(out_frames)
}

#[cfg(feature = "soxr")]
fn interleave_channel_outputs_to_slice(
    channel_outputs: &[Vec<f64>],
    channels: usize,
    output: &mut [f64],
) -> usize {
    if channel_outputs.is_empty() || channel_outputs[0].is_empty() {
        return 0;
    }

    let out_frames = channel_outputs[0].len();

    if output.len() >= out_frames * channels
        && channel_outputs_have_frames(channel_outputs, channels, out_frames)
    {
        for (frame, out_frame) in output
            .chunks_exact_mut(channels)
            .take(out_frames)
            .enumerate()
        {
            for (dst, channel) in out_frame
                .iter_mut()
                .zip(channel_outputs.iter().take(channels))
            {
                *dst = channel[frame];
            }
        }
    } else {
        for frame in 0..out_frames {
            for (ch, channel) in channel_outputs.iter().take(channels).enumerate() {
                let idx = frame * channels + ch;
                if idx < output.len() {
                    output[idx] = channel.get(frame).copied().unwrap_or(0.0);
                }
            }
        }
    }

    out_frames
}

impl Resampler {
    /// Create a one-shot resampler with validated interleaved geometry.
    pub fn new(channels: usize, from_rate: u32, to_rate: u32) -> Result<Self, ResamplerError> {
        validate_resampler_geometry(channels, from_rate, to_rate)?;
        Ok(Self {
            channels,
            from_rate,
            to_rate,
        })
    }

    /// Resample audio data using the configured backend (SoX VHQ polyphase
    /// with the `soxr` feature, quality-aware rubato FFT/sinc routing with
    /// `rubato`).
    ///
    /// Input and output are interleaved f64 samples for Hi-Fi transparency.
    ///
    /// Optimised for multi-channel parallelism:
    /// - De-interleaves channels
    /// - Processes each channel on a separate thread (Rayon)
    /// - Re-interleaves result
    ///
    /// This avoids phase discontinuities from time-chunking while maintaining high performance.
    ///
    /// # Cost model
    ///
    /// Each call constructs a fresh backend stream per channel, which includes
    /// full filter design (hundreds of microseconds per channel for SoXR).
    /// This is intended for one-shot offline conversions of whole buffers.
    /// For repeated block-wise or realtime processing, use
    /// [`StreamingResampler`](crate::StreamingResampler), which designs its
    /// filters once and processes incrementally without per-call setup.
    ///
    /// Returns Err if backend initialization fails (e.g., invalid sample rate combination).
    pub fn resample_parallel(
        &self,
        input: &[f64],
        phase: PhaseResponse,
        quality: ResampleQuality,
    ) -> Result<Vec<f64>, ResamplerError> {
        let input = AudioBlockRef::new(input, self.channels)?;
        if self.from_rate == self.to_rate {
            return Ok(input.samples().to_vec());
        }

        // 1. De-interleave
        let frames = input.frames();
        let mut plan_channels: Vec<Vec<f64>> = vec![Vec::with_capacity(frames); self.channels];
        deinterleave_frame_major(input.samples(), self.channels, frames, &mut plan_channels);

        // 2. Process channels in parallel.
        //
        // One scoped thread per channel. This is an offline one-shot path over
        // a bounded channel count, so a work-stealing pool would add scheduling
        // machinery (and a dependency) for no benefit: the per-channel tasks
        // are long, equal-sized, and never nested.
        let channel_count = self.channels;
        let resampled_channels: Result<Vec<Vec<f64>>, ResamplerError> = if channel_count <= 1 {
            plan_channels
                .into_iter()
                .enumerate()
                .map(|(ch_idx, channel_data)| {
                    self.resample_one_channel(ch_idx, &channel_data, phase, quality)
                })
                .collect()
        } else {
            std::thread::scope(|scope| {
                let handles: Vec<_> = plan_channels
                    .iter()
                    .enumerate()
                    .map(|(ch_idx, channel_data)| {
                        scope.spawn(move || {
                            self.resample_one_channel(ch_idx, channel_data, phase, quality)
                        })
                    })
                    .collect();

                handles
                    .into_iter()
                    .map(|handle| {
                        // A panic inside a channel worker is a bug in this
                        // crate, not a runtime condition. Surface it as a typed
                        // error instead of unwinding through the caller.
                        handle.join().unwrap_or(Err(ResamplerError::BackendStalled {
                            operation: "process",
                            channel: None,
                        }))
                    })
                    .collect()
            })
        };

        let resampled_channels = resampled_channels?;

        // 3. Re-interleave
        if resampled_channels.is_empty() {
            return Ok(Vec::new());
        }

        let final_capacity = resampled_channels[0]
            .len()
            .checked_mul(self.channels)
            .ok_or(ResamplerError::CapacityOverflow {
                buffer: "one-shot interleaved output",
            })?;
        let mut final_output = Vec::with_capacity(final_capacity);
        interleave_channel_outputs_to_vec(&resampled_channels, self.channels, &mut final_output)?;

        Ok(final_output)
    }

    /// Run one deinterleaved channel through its own backend stream.
    ///
    /// Split out of [`Self::resample_parallel`] so the same body serves both
    /// the single-channel sequential path and the scoped-thread path.
    fn resample_one_channel(
        &self,
        ch_idx: usize,
        channel_data: &[f64],
        phase: PhaseResponse,
        quality: ResampleQuality,
    ) -> Result<Vec<f64>, ResamplerError> {
        // One backend stream per channel with the requested phase
        // response and quality level.
        let mut backend = MonoBackend::new(self.from_rate, self.to_rate, phase, quality)
            .map_err(|error| map_backend_init_error(error, Some(ch_idx)))?;

        let expected_frames = converted_output_frames(
            channel_data.len(),
            self.from_rate,
            self.to_rate,
            "one-shot output",
        )?;
        let mut channel_output = Vec::with_capacity(expected_frames);

        // Chunked processing to avoid massive single-pass overhead
        // 8192 frames is a good balance for cache usage. The shared
        // process-capacity contract owns the backend burst slack.
        let inner_chunk_size = ONE_SHOT_INPUT_CHUNK_FRAMES;
        let scratch_frames =
            process_output_capacity_frames(inner_chunk_size, self.from_rate, self.to_rate)?;
        let mut output_scratch = vec![0.0; scratch_frames];

        let total_chunks = channel_data.len().div_ceil(inner_chunk_size);

        // Log only for first channel to avoid spam
        if ch_idx == 0 {
            log::info!(
                "Starting resampling on thread. Total chunks: {}, Phase: {:?}",
                total_chunks,
                phase
            );
        }

        for (i, chunk) in channel_data.chunks(inner_chunk_size).enumerate() {
            let mut input_offset = 0;
            while input_offset < chunk.len() {
                let processed = backend
                    .process(&chunk[input_offset..], &mut output_scratch)
                    .map_err(|error| ResamplerError::BackendProcess {
                        operation: "process",
                        channel: Some(ch_idx),
                        message: error.message(),
                    })?;

                if processed.input_frames > chunk.len() - input_offset
                    || processed.output_frames > output_scratch.len()
                {
                    return Err(ResamplerError::InvalidBackendProgress {
                        operation: "process",
                        channel: Some(ch_idx),
                    });
                }

                if processed.input_frames == 0 && processed.output_frames == 0 {
                    return Err(ResamplerError::BackendStalled {
                        operation: "process",
                        channel: Some(ch_idx),
                    });
                }
                input_offset += processed.input_frames;
                channel_output.extend_from_slice(&output_scratch[..processed.output_frames]);
            }

            // Periodic log check (every ~10%)
            if ch_idx == 0 && i > 0 && i % (total_chunks.max(10) / 10).max(1) == 0 {
                log::debug!("Resampling progress: {}%", i * 100 / total_chunks);
            }
        }

        // Native drain is the only end-of-stream operation guaranteed
        // by the backend. Keep calling it until it reports terminal
        // zero.
        loop {
            match backend.drain(&mut output_scratch) {
                Ok(output_frames) if output_frames > 0 => {
                    if output_frames > output_scratch.len() {
                        return Err(ResamplerError::InvalidBackendProgress {
                            operation: "drain",
                            channel: Some(ch_idx),
                        });
                    }
                    channel_output.extend_from_slice(&output_scratch[..output_frames]);
                }
                Ok(_) => break,
                Err(e) => {
                    return Err(ResamplerError::BackendProcess {
                        operation: "drain",
                        channel: Some(ch_idx),
                        message: e.message(),
                    });
                }
            }
        }

        Ok(channel_output)
    }
}

/// Stateful streaming resampler that maintains backend state across chunks.
/// SoXR uses one native interleaved stream for stereo and mono streams as the
/// fallback for other layouts. Rubato uses one native interleaved stream for
/// the complete block. This is used by AudioPipeline for memory-efficient
/// streaming resampling.
///
/// # Thread safety
///
/// Always `Send`. On the default rubato backend it is **not** `Sync` (nor
/// `UnwindSafe` / `RefUnwindSafe`), because rubato's `Async<f64>` holds a
/// `Box<dyn InnerResampler<f64>>` that does not declare those auto traits; the
/// `soxr` backend does provide them. Since [`process`](Self::process),
/// [`finish`](Self::finish), [`reset`](Self::reset), and
/// [`set_sample_rate`](Self::set_sample_rate) all take `&mut self`, sharing via
/// `Arc<Mutex<StreamingResampler>>` (which needs only `Send`) or moving the
/// resampler onto the audio thread work on both backends.
///
/// FIX for Defect 33: Pre-allocate all buffers to avoid heap allocation in process.
pub struct StreamingResampler {
    #[cfg(feature = "soxr")]
    backends: Vec<MonoBackend>,
    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    backend: MonoBackend,
    channels: usize,
    from_rate: u32,
    to_rate: u32,
    latency: FrameDuration,
    tail: TailSpec,
    #[cfg(feature = "soxr")]
    /// Pre-allocated output scratch buffer (per channel, reused)
    output_scratch: Vec<f64>,
    #[cfg(feature = "soxr")]
    /// Pre-allocated channel input buffers (Defect 33 fix)
    channel_inputs: Vec<Vec<f64>>,
    #[cfg(feature = "soxr")]
    /// Pre-allocated channel output buffers (Defect 33 fix)
    channel_outputs: Vec<Vec<f64>>,
    /// End-of-stream has been signalled, but native drain may still have data.
    finishing: bool,
    /// Native drain reached terminal zero. Stable until reset.
    finished: bool,
}

const STREAMING_MAX_INPUT_FRAMES: usize = 16_384;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct StreamingBufferLayout {
    max_output_per_channel: usize,
    pcm_bytes: usize,
}

fn streaming_buffer_layout(
    channels: usize,
    from_rate: u32,
    to_rate: u32,
) -> Result<StreamingBufferLayout, ResamplerError> {
    validate_resampler_geometry(channels, from_rate, to_rate)?;
    let max_output_per_channel =
        process_output_capacity_frames(STREAMING_MAX_INPUT_FRAMES, from_rate, to_rate)?;
    #[cfg(feature = "soxr")]
    let pcm_bytes = if channels == 2 {
        0
    } else {
        let input_samples = channels
            .checked_mul(STREAMING_MAX_INPUT_FRAMES)
            .ok_or(ResamplerError::CapacityOverflow { buffer: "input" })?;
        let channel_output_samples = channels
            .checked_mul(max_output_per_channel)
            .ok_or(ResamplerError::CapacityOverflow { buffer: "output" })?;
        let total_samples = max_output_per_channel
            .checked_add(input_samples)
            .and_then(|samples| samples.checked_add(channel_output_samples))
            .ok_or(ResamplerError::CapacityOverflow {
                buffer: "working-set samples",
            })?;
        total_samples
            .checked_mul(std::mem::size_of::<f64>())
            .ok_or(ResamplerError::CapacityOverflow {
                buffer: "working-set bytes",
            })?
    };
    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    let pcm_bytes = 0;
    Ok(StreamingBufferLayout {
        max_output_per_channel,
        pcm_bytes,
    })
}

impl StreamingResampler {
    /// Exact `f64` capacity bytes allocated by reusable adapter scratch.
    ///
    /// Rubato processes caller-owned interleaved buffers directly, so this is
    /// zero for the pure-Rust backend; Rubato's own engine storage is part of
    /// setup allocation rather than adapter scratch.
    pub fn working_buffer_bytes(
        channels: usize,
        from_rate: u32,
        to_rate: u32,
    ) -> Result<usize, ResamplerError> {
        Ok(streaming_buffer_layout(channels, from_rate, to_rate)?.pcm_bytes)
    }

    /// Return the configured input sample rate in hertz.
    pub fn from_rate(&self) -> u32 {
        self.from_rate
    }

    /// Return the configured output sample rate in hertz.
    pub fn to_rate(&self) -> u32 {
        self.to_rate
    }

    /// Conservative per-channel output capacity for one caller input block.
    ///
    /// This setup/provisioning helper uses frame units and exact rational
    /// ceiling conversion plus a fixed backend-burst allowance. Backpressure
    /// remains authoritative: callers must advance from [`ProcessProgress`]
    /// rather than assume the capacity guarantees complete input consumption
    /// for every possible prior backend state.
    pub fn process_output_capacity_frames(
        &self,
        input_frames: usize,
    ) -> Result<usize, ResamplerError> {
        process_output_capacity_frames(input_frames, self.from_rate, self.to_rate)
    }

    /// Create a new streaming resampler with default (linear) phase and High quality
    pub fn new(channels: usize, from_rate: u32, to_rate: u32) -> Result<Self, ResamplerError> {
        Self::with_phase(channels, from_rate, to_rate, PhaseResponse::default())
    }

    /// Create a new streaming resampler with specified phase response (High quality)
    ///
    /// Returns Err if backend initialization fails (e.g., invalid sample rates like 0 Hz)
    pub fn with_phase(
        channels: usize,
        from_rate: u32,
        to_rate: u32,
        phase: PhaseResponse,
    ) -> Result<Self, ResamplerError> {
        Self::with_quality(channels, from_rate, to_rate, phase, ResampleQuality::High)
    }

    /// Create a new streaming resampler with specified phase response and quality level
    ///
    /// FIX for Defect 30: Allow quality configuration
    /// FIX for Defect 33: Pre-allocate all buffers to avoid heap allocation in process.
    ///
    /// Returns Err if backend initialization fails (e.g., invalid sample rates like 0 Hz)
    pub fn with_quality(
        channels: usize,
        from_rate: u32,
        to_rate: u32,
        phase: PhaseResponse,
        quality: ResampleQuality,
    ) -> Result<Self, ResamplerError> {
        validate_resampler_geometry(channels, from_rate, to_rate)?;

        #[cfg(feature = "soxr")]
        let backends = if channels == 2 {
            vec![
                MonoBackend::new_interleaved_stereo(from_rate, to_rate, phase, quality)
                    .map_err(|error| map_backend_init_error(error, None))?,
            ]
        } else {
            let mut backends = Vec::with_capacity(channels);
            for ch_idx in 0..channels {
                match MonoBackend::new(from_rate, to_rate, phase, quality) {
                    Ok(backend) => backends.push(backend),
                    Err(error) => {
                        return Err(map_backend_init_error(error, Some(ch_idx)));
                    }
                }
            }
            backends
        };
        #[cfg(all(feature = "rubato", not(feature = "soxr")))]
        let backend = MonoBackend::new_interleaved(from_rate, to_rate, phase, quality, channels)
            .map_err(|error| map_backend_init_error(error, None))?;

        #[cfg(feature = "soxr")]
        let latency_frames = if from_rate == to_rate {
            0
        } else {
            backends.first().map_or(0, MonoBackend::latency_frames)
        };
        #[cfg(all(feature = "rubato", not(feature = "soxr")))]
        let latency_frames = if from_rate == to_rate {
            0
        } else {
            backend.latency_frames()
        };
        #[cfg(feature = "soxr")]
        let finish_extension_frames = if from_rate == to_rate {
            0
        } else {
            backends
                .first()
                .map_or(0, MonoBackend::finish_extension_frames)
        };
        #[cfg(all(feature = "rubato", not(feature = "soxr")))]
        let finish_extension_frames = if from_rate == to_rate {
            0
        } else {
            backend.finish_extension_frames()
        };
        let latency = if latency_frames == 0 {
            FrameDuration::ZERO
        } else {
            FrameDuration::new(latency_frames, to_rate).map_err(|error| {
                ResamplerError::InvalidTiming {
                    metric: "latency",
                    message: error.to_string(),
                }
            })?
        };
        let tail = TailSpec::finite(
            finish_extension_frames.saturating_sub(latency_frames),
            to_rate,
        )
        .map_err(|error| ResamplerError::InvalidTiming {
            metric: "tail",
            message: error.to_string(),
        })?;

        // Pre-allocate all SoXR buffers from the same checked layout exposed
        // to callers for reservation-before-allocation accounting.
        #[cfg(feature = "soxr")]
        let layout = streaming_buffer_layout(channels, from_rate, to_rate)?;
        #[cfg(feature = "soxr")]
        let max_output_per_channel = layout.max_output_per_channel;

        // Pre-allocate channel buffers
        #[cfg(feature = "soxr")]
        let legacy_channel_inputs = || {
            (0..channels)
                .map(|_| Vec::with_capacity(STREAMING_MAX_INPUT_FRAMES))
                .collect::<Vec<Vec<f64>>>()
        };
        #[cfg(feature = "soxr")]
        let legacy_channel_outputs = || {
            (0..channels)
                .map(|_| Vec::with_capacity(max_output_per_channel))
                .collect::<Vec<Vec<f64>>>()
        };
        #[cfg(feature = "soxr")]
        let (channel_inputs, channel_outputs, output_scratch) = if channels == 2 {
            (Vec::new(), Vec::new(), Vec::new())
        } else {
            (
                legacy_channel_inputs(),
                legacy_channel_outputs(),
                vec![0.0; max_output_per_channel],
            )
        };
        Ok(Self {
            #[cfg(feature = "soxr")]
            backends,
            #[cfg(all(feature = "rubato", not(feature = "soxr")))]
            backend,
            channels,
            from_rate,
            to_rate,
            latency,
            tail,
            #[cfg(feature = "soxr")]
            output_scratch,
            #[cfg(feature = "soxr")]
            channel_inputs,
            #[cfg(feature = "soxr")]
            channel_outputs,
            finishing: false,
            finished: false,
        })
    }

    #[cfg(feature = "soxr")]
    fn clear_work_buffers(&mut self) {
        for ch_buf in &mut self.channel_inputs {
            ch_buf.clear();
        }
        for ch_buf in &mut self.channel_outputs {
            ch_buf.clear();
        }
    }

    fn validate_channels(&self, actual_channels: usize) -> Result<(), ProcessError> {
        if actual_channels == self.channels {
            Ok(())
        } else {
            Err(ProcessError::ChannelCountMismatch {
                processor: "StreamingResampler",
                expected_channels: self.channels,
                actual_channels,
            })
        }
    }

    fn ensure_processing(&self) -> Result<(), ProcessError> {
        if self.finishing || self.finished {
            Err(ProcessError::AlreadyFinished {
                processor: "StreamingResampler",
            })
        } else {
            Ok(())
        }
    }

    fn process_out_of_place(
        &mut self,
        input: AudioBlockRef<'_>,
        output: AudioBlockMut<'_>,
    ) -> Result<ProcessProgress, ProcessError> {
        #[cfg(feature = "soxr")]
        {
            if self.uses_interleaved_soxr() {
                return self.process_out_of_place_interleaved(input, output);
            }
            self.process_out_of_place_mono(input, output)
        }
        #[cfg(all(feature = "rubato", not(feature = "soxr")))]
        return self.process_out_of_place_interleaved(input, output);
    }

    #[cfg(feature = "soxr")]
    fn uses_interleaved_soxr(&self) -> bool {
        self.backends
            .first()
            .is_some_and(MonoBackend::is_interleaved_stereo)
    }

    #[cfg(feature = "soxr")]
    fn process_interleaved_backend(
        &mut self,
        input: &[f64],
        output: &mut [f64],
    ) -> Result<BackendProgress, BackendProcessError> {
        self.backends
            .first_mut()
            .ok_or("resampler backend set was empty")?
            .process_interleaved_stereo(input, output)
    }

    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    #[inline]
    fn process_interleaved_backend(
        &mut self,
        input: &[f64],
        output: &mut [f64],
    ) -> Result<BackendProgress, BackendProcessError> {
        self.backend.process(input, output)
    }

    #[cfg(feature = "soxr")]
    fn process_out_of_place_mono(
        &mut self,
        input: AudioBlockRef<'_>,
        mut output: AudioBlockMut<'_>,
    ) -> Result<ProcessProgress, ProcessError> {
        let channels = self.channels;
        let input_frames = input.frames();
        let output_frames = output.frames();

        if self.from_rate == self.to_rate {
            let frames = input_frames.min(output_frames);
            let samples = frames * channels;
            output.samples_mut()[..samples].copy_from_slice(&input.samples()[..samples]);
            let state = if frames < input_frames {
                ProcessState::NeedOutput
            } else {
                ProcessState::NeedInput
            };
            return Ok(ProcessProgress::new(frames, frames, state).with_bypassed(true));
        }

        let input_samples = input.samples();
        let output_samples = output.samples_mut();
        let mut consumed_frames = 0;
        let mut produced_frames = 0;

        while consumed_frames < input_frames && produced_frames < output_frames {
            let input_step_frames =
                (input_frames - consumed_frames).min(STREAMING_MAX_INPUT_FRAMES);
            let output_step_capacity =
                (output_frames - produced_frames).min(self.output_scratch.len());

            self.clear_work_buffers();
            let input_start = consumed_frames * channels;
            let input_end = input_start + input_step_frames * channels;
            deinterleave_frame_major(
                &input_samples[input_start..input_end],
                channels,
                input_step_frames,
                &mut self.channel_inputs,
            );

            let mut shared_progress = None;
            for channel in 0..channels {
                let processed = self.backends[channel]
                    .process(
                        &self.channel_inputs[channel],
                        &mut self.output_scratch[..output_step_capacity],
                    )
                    .map_err(|error| ProcessError::Backend {
                        processor: "StreamingResampler",
                        operation: "process",
                        message: error.message(),
                    })?;

                if processed.input_frames > input_step_frames
                    || processed.output_frames > output_step_capacity
                {
                    return Err(ProcessError::Backend {
                        processor: "StreamingResampler",
                        operation: "process",
                        message: "backend returned out-of-bounds progress",
                    });
                }

                match shared_progress {
                    None => {
                        shared_progress = Some((processed.input_frames, processed.output_frames));
                    }
                    Some(expected)
                        if expected != (processed.input_frames, processed.output_frames) =>
                    {
                        return Err(ProcessError::Backend {
                            processor: "StreamingResampler",
                            operation: "process",
                            message: "backend channel progress diverged",
                        });
                    }
                    Some(_) => {}
                }

                self.channel_outputs[channel]
                    .extend_from_slice(&self.output_scratch[..processed.output_frames]);
            }

            let Some((step_consumed, step_produced)) = shared_progress else {
                return Err(ProcessError::Backend {
                    processor: "StreamingResampler",
                    operation: "process",
                    message: "backend channel set was empty",
                });
            };
            if step_consumed == 0 && step_produced == 0 {
                return Err(ProcessError::Backend {
                    processor: "StreamingResampler",
                    operation: "process",
                    message: "backend made no progress",
                });
            }

            let output_start = produced_frames * channels;
            let output_end = output_start + step_produced * channels;
            let written = interleave_channel_outputs_to_slice(
                &self.channel_outputs,
                channels,
                &mut output_samples[output_start..output_end],
            );
            if written != step_produced {
                return Err(ProcessError::Backend {
                    processor: "StreamingResampler",
                    operation: "process",
                    message: "failed to interleave complete backend output",
                });
            }

            consumed_frames += step_consumed;
            produced_frames += step_produced;
        }

        let state = if consumed_frames == input_frames {
            ProcessState::NeedInput
        } else if produced_frames == output_frames {
            ProcessState::NeedOutput
        } else {
            return Err(ProcessError::Backend {
                processor: "StreamingResampler",
                operation: "process",
                message: "backend stopped before reaching an input/output boundary",
            });
        };
        Ok(ProcessProgress::new(
            consumed_frames,
            produced_frames,
            state,
        ))
    }

    fn process_out_of_place_interleaved(
        &mut self,
        input: AudioBlockRef<'_>,
        mut output: AudioBlockMut<'_>,
    ) -> Result<ProcessProgress, ProcessError> {
        let channels = self.channels;
        let input_frames = input.frames();
        let output_frames = output.frames();

        if self.from_rate == self.to_rate {
            let frames = input_frames.min(output_frames);
            let samples = frames * channels;
            output.samples_mut()[..samples].copy_from_slice(&input.samples()[..samples]);
            let state = if frames < input_frames {
                ProcessState::NeedOutput
            } else {
                ProcessState::NeedInput
            };
            return Ok(ProcessProgress::new(frames, frames, state).with_bypassed(true));
        }

        let input_samples = input.samples();
        let output_samples = output.samples_mut();
        let mut consumed_frames = 0usize;
        let mut produced_frames = 0usize;
        while consumed_frames < input_frames && produced_frames < output_frames {
            let processed = self
                .process_interleaved_backend(
                    &input_samples[consumed_frames * channels..],
                    &mut output_samples[produced_frames * channels..],
                )
                .map_err(|error| ProcessError::Backend {
                    processor: "StreamingResampler",
                    operation: "process",
                    message: error.message(),
                })?;
            if processed.input_frames > input_frames - consumed_frames
                || processed.output_frames > output_frames - produced_frames
            {
                return Err(ProcessError::Backend {
                    processor: "StreamingResampler",
                    operation: "process",
                    message: "backend returned out-of-bounds progress",
                });
            }
            if processed.input_frames == 0 && processed.output_frames == 0 {
                return Err(ProcessError::Backend {
                    processor: "StreamingResampler",
                    operation: "process",
                    message: "backend made no progress",
                });
            }
            consumed_frames += processed.input_frames;
            produced_frames += processed.output_frames;
        }

        let state = if consumed_frames == input_frames {
            ProcessState::NeedInput
        } else if produced_frames == output_frames {
            ProcessState::NeedOutput
        } else {
            return Err(ProcessError::Backend {
                processor: "StreamingResampler",
                operation: "process",
                message: "backend stopped before reaching an input/output boundary",
            });
        };
        Ok(ProcessProgress::new(
            consumed_frames,
            produced_frames,
            state,
        ))
    }

    fn drain_into(&mut self, output: AudioBlockMut<'_>) -> Result<ProcessProgress, ProcessError> {
        #[cfg(feature = "soxr")]
        {
            if self.uses_interleaved_soxr() {
                return self.drain_into_interleaved(output);
            }
            self.drain_into_mono(output)
        }
        #[cfg(all(feature = "rubato", not(feature = "soxr")))]
        return self.drain_into_interleaved(output);
    }

    #[cfg(feature = "soxr")]
    fn drain_interleaved_backend(
        &mut self,
        output: &mut [f64],
    ) -> Result<usize, BackendProcessError> {
        self.backends
            .first_mut()
            .ok_or("resampler backend set was empty")?
            .drain_interleaved_stereo(output)
    }

    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    #[inline]
    fn drain_interleaved_backend(
        &mut self,
        output: &mut [f64],
    ) -> Result<usize, BackendProcessError> {
        self.backend.drain(output)
    }

    #[cfg(feature = "soxr")]
    fn drain_into_mono(
        &mut self,
        mut output: AudioBlockMut<'_>,
    ) -> Result<ProcessProgress, ProcessError> {
        if self.finished {
            return Ok(ProcessProgress::finished(0));
        }
        self.finishing = true;

        let channels = self.channels;
        let output_frames = output.frames();
        if output_frames == 0 {
            return Ok(ProcessProgress::new(0, 0, ProcessState::NeedOutput));
        }

        let output_samples = output.samples_mut();
        let mut produced_frames = 0;
        while produced_frames < output_frames {
            let output_step_capacity =
                (output_frames - produced_frames).min(self.output_scratch.len());
            for channel_output in &mut self.channel_outputs {
                channel_output.clear();
            }

            let mut shared_output_frames = None;
            for channel in 0..channels {
                let channel_frames = self.backends[channel]
                    .drain(&mut self.output_scratch[..output_step_capacity])
                    .map_err(|error| ProcessError::Backend {
                        processor: "StreamingResampler",
                        operation: "finish",
                        message: error.message(),
                    })?;
                if channel_frames > output_step_capacity {
                    return Err(ProcessError::Backend {
                        processor: "StreamingResampler",
                        operation: "finish",
                        message: "backend drain returned out-of-bounds progress",
                    });
                }
                match shared_output_frames {
                    None => shared_output_frames = Some(channel_frames),
                    Some(expected) if expected != channel_frames => {
                        return Err(ProcessError::Backend {
                            processor: "StreamingResampler",
                            operation: "finish",
                            message: "backend channel drain diverged",
                        });
                    }
                    Some(_) => {}
                }
                self.channel_outputs[channel]
                    .extend_from_slice(&self.output_scratch[..channel_frames]);
            }

            let Some(step_produced) = shared_output_frames else {
                return Err(ProcessError::Backend {
                    processor: "StreamingResampler",
                    operation: "finish",
                    message: "backend channel set was empty",
                });
            };
            if step_produced == 0 {
                self.finished = true;
                return Ok(ProcessProgress::finished(produced_frames));
            }

            let output_start = produced_frames * channels;
            let output_end = output_start + step_produced * channels;
            let written = interleave_channel_outputs_to_slice(
                &self.channel_outputs,
                channels,
                &mut output_samples[output_start..output_end],
            );
            if written != step_produced {
                return Err(ProcessError::Backend {
                    processor: "StreamingResampler",
                    operation: "finish",
                    message: "failed to interleave complete backend drain output",
                });
            }
            produced_frames += step_produced;
        }

        Ok(ProcessProgress::new(
            0,
            produced_frames,
            ProcessState::NeedOutput,
        ))
    }

    fn drain_into_interleaved(
        &mut self,
        mut output: AudioBlockMut<'_>,
    ) -> Result<ProcessProgress, ProcessError> {
        if self.finished {
            return Ok(ProcessProgress::finished(0));
        }
        self.finishing = true;
        if output.frames() == 0 {
            return Ok(ProcessProgress::new(0, 0, ProcessState::NeedOutput));
        }

        let output_frames = output.frames();
        let produced_frames = self
            .drain_interleaved_backend(output.samples_mut())
            .map_err(|error| ProcessError::Backend {
                processor: "StreamingResampler",
                operation: "finish",
                message: error.message(),
            })?;
        if produced_frames > output_frames {
            return Err(ProcessError::Backend {
                processor: "StreamingResampler",
                operation: "finish",
                message: "backend drain returned out-of-bounds progress",
            });
        }
        if produced_frames == 0 {
            self.finished = true;
            Ok(ProcessProgress::finished(0))
        } else if produced_frames == output_frames {
            Ok(ProcessProgress::new(
                0,
                produced_frames,
                ProcessState::NeedOutput,
            ))
        } else {
            self.finished = true;
            Ok(ProcessProgress::finished(produced_frames))
        }
    }

    /// Drive one caller-owned interleaved block through the unified progress
    /// contract without allocating.
    ///
    /// Unlike the legacy SoXR adapter this reports exact input consumption and
    /// never panics on a backend failure. Callers must retain unconsumed input
    /// when the returned state is `NeedOutput`.
    pub fn process_chunk_into(
        &mut self,
        input: &[f64],
        output: &mut [f64],
    ) -> Result<ProcessProgress, ProcessError> {
        let input = AudioBlockRef::new(input, self.channels)?;
        let output = AudioBlockMut::new(output, self.channels)?;
        let buffers = ProcessBuffers::out_of_place(input, output)?;
        super::traits::process_checked(self, buffers)
    }

    /// Allocation-using decode/offline convenience driver.
    ///
    /// This loops over explicit consumed/produced progress until the complete
    /// input block has been accepted. Realtime paths must use
    /// [`Self::process_chunk_into`] with preallocated storage instead.
    pub fn process_chunk(&mut self, input: &[f64]) -> Result<Vec<f64>, ProcessError> {
        let input_block = AudioBlockRef::new(input, self.channels)?;
        let capacity_frames = self
            .process_output_capacity_frames(input_block.frames())
            .map_err(|error| ProcessError::Owned {
                processor: "StreamingResampler",
                operation: "size process output",
                message: error.to_string(),
            })?
            .max(1);
        let mut scratch = vec![0.0; capacity_frames * self.channels];
        let mut output = Vec::with_capacity(capacity_frames * self.channels);
        let mut consumed = 0usize;

        while consumed < input_block.frames() {
            let input_start = consumed * self.channels;
            let progress = self.process_chunk_into(&input[input_start..], &mut scratch)?;
            output.extend_from_slice(
                &scratch[..progress.produced_frames().saturating_mul(self.channels)],
            );
            consumed += progress.consumed_frames();
        }
        Ok(output)
    }

    /// Allocation-using complete end-of-stream drain for decode/offline paths.
    ///
    /// The returned sequence is duration aligned and the resampler remains
    /// terminal until reset.
    pub fn flush(&mut self) -> Result<Vec<f64>, ProcessError> {
        let capacity_frames = self
            .process_output_capacity_frames(STREAMING_MAX_INPUT_FRAMES)
            .map_err(|error| ProcessError::Owned {
                processor: "StreamingResampler",
                operation: "size finish output",
                message: error.to_string(),
            })?
            .max(1);
        let mut scratch = vec![0.0; capacity_frames * self.channels];
        let mut output = Vec::new();
        loop {
            let block = AudioBlockMut::new(&mut scratch, self.channels)?;
            let progress = super::traits::finish_checked(self, block)?;
            output.extend_from_slice(
                &scratch[..progress.produced_frames().saturating_mul(self.channels)],
            );
            if progress.state() == ProcessState::Finished {
                break;
            }
        }
        Ok(output)
    }
}

impl StreamingProcessor for StreamingResampler {
    fn name(&self) -> &'static str {
        "StreamingResampler"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        self.ensure_processing()?;
        self.validate_channels(buffers.channels())?;

        match buffers.into_parts() {
            ProcessBufferParts::InPlace(block) if self.from_rate == self.to_rate => Ok(
                ProcessProgress::new(block.frames(), block.frames(), ProcessState::NeedInput)
                    .with_bypassed(true),
            ),
            ProcessBufferParts::InPlace(_) => Err(ProcessError::UnsupportedBufferMode {
                processor: "StreamingResampler",
                mode: ProcessBufferMode::InPlace,
            }),
            ProcessBufferParts::OutOfPlace { input, output } => {
                self.process_out_of_place(input, output)
            }
        }
    }

    fn finish(&mut self, output: AudioBlockMut<'_>) -> Result<ProcessProgress, ProcessError> {
        self.validate_channels(output.channels())?;
        if self.from_rate == self.to_rate {
            self.finishing = true;
            self.finished = true;
            return Ok(ProcessProgress::finished(0));
        }
        self.drain_into(output)
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        #[cfg(feature = "soxr")]
        let mut first_error = None;
        #[cfg(feature = "soxr")]
        for backend in &mut self.backends {
            if backend.clear().is_err() && first_error.is_none() {
                first_error = Some(ProcessError::Backend {
                    processor: "StreamingResampler",
                    operation: "reset",
                    message: "backend clear failed",
                });
            }
        }
        #[cfg(all(feature = "rubato", not(feature = "soxr")))]
        let first_error = self.backend.clear().err().map(|_| ProcessError::Backend {
            processor: "StreamingResampler",
            operation: "reset",
            message: "backend clear failed",
        });
        #[cfg(feature = "soxr")]
        self.clear_work_buffers();
        self.finishing = false;
        self.finished = false;
        first_error.map_or(Ok(()), Err)
    }

    fn latency(&self) -> FrameDuration {
        self.latency
    }

    fn tail(&self) -> TailSpec {
        self.tail
    }

    fn output_sample_rate_hz(&self, input_sample_rate_hz: u32) -> Result<u32, ProcessError> {
        if input_sample_rate_hz == 0 {
            return Err(ProcessError::InvalidSampleRate {
                processor: "StreamingResampler",
                sample_rate_hz: input_sample_rate_hz,
            });
        }
        if input_sample_rate_hz != self.from_rate {
            return Err(ProcessError::SampleRateMismatch {
                processor: "StreamingResampler",
                expected_sample_rate_hz: self.from_rate,
                actual_sample_rate_hz: input_sample_rate_hz,
            });
        }
        Ok(self.to_rate)
    }

    fn set_sample_rate(&mut self, sample_rate_hz: u32) -> Result<(), ProcessError> {
        if sample_rate_hz != self.from_rate {
            return Err(ProcessError::SampleRateMismatch {
                processor: "StreamingResampler",
                expected_sample_rate_hz: self.from_rate,
                actual_sample_rate_hz: sample_rate_hz,
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processor::traits::{finish_checked, process_checked, AudioBlockError};

    fn fixture(frames: usize, channels: usize) -> Vec<f64> {
        (0..frames * channels)
            .map(|sample| {
                let frame = sample / channels;
                let channel = sample % channels;
                ((frame as f64 * 0.017 + channel as f64 * 0.31).sin() * 0.5)
                    + ((frame as f64 * 0.003).cos() * 0.1)
            })
            .collect()
    }

    fn render_with_chunks(
        resampler: &mut StreamingResampler,
        input: &[f64],
        input_chunks: &[usize],
        output_block_frames: usize,
    ) -> Result<Vec<f64>, ProcessError> {
        let channels = resampler.channels;
        let total_frames = AudioBlockRef::new(input, channels)?.frames();
        let mut scratch = vec![0.0; output_block_frames * channels];
        let mut output = Vec::new();
        let mut frame = 0;
        let mut chunk_index = 0;

        while frame < total_frames {
            let chunk_frames = input_chunks[chunk_index % input_chunks.len()].max(1);
            let chunk_end = (frame + chunk_frames).min(total_frames);
            let mut chunk_offset = frame;
            while chunk_offset < chunk_end {
                let input_block = AudioBlockRef::new(
                    &input[chunk_offset * channels..chunk_end * channels],
                    channels,
                )?;
                let output_block = AudioBlockMut::new(&mut scratch, channels)?;
                let buffers = ProcessBuffers::out_of_place(input_block, output_block)?;
                let progress = process_checked(resampler, buffers)?;
                output.extend_from_slice(
                    &scratch[..progress.produced_frames().saturating_mul(channels)],
                );
                chunk_offset += progress.consumed_frames();
            }
            frame = chunk_end;
            chunk_index += 1;
        }

        loop {
            let output_block = AudioBlockMut::new(&mut scratch, channels)?;
            let progress = finish_checked(resampler, output_block)?;
            output
                .extend_from_slice(&scratch[..progress.produced_frames().saturating_mul(channels)]);
            if progress.state() == ProcessState::Finished {
                break;
            }
        }
        Ok(output)
    }

    #[test]
    fn streaming_resampler_rejects_invalid_geometry() {
        assert!(matches!(
            StreamingResampler::new(0, 48_000, 96_000),
            Err(ResamplerError::ZeroChannels)
        ));
        for (from_rate, to_rate) in [(0, 96_000), (48_000, 0)] {
            assert!(matches!(
                StreamingResampler::new(2, from_rate, to_rate),
                Err(ResamplerError::InvalidSampleRate { .. })
            ));
        }
    }

    /// Offline channel fan-out must be equivalent to resampling each channel
    /// on its own, for every supported channel count.
    ///
    /// This is the contract that lets `resample_parallel` distribute work at
    /// all: per-channel backend streams must stay independent, so splitting
    /// across threads cannot change a sample. The one- and two-channel cases
    /// also cover the sequential/threaded branch boundary.
    #[test]
    fn parallel_channel_fan_out_matches_per_channel_resampling() {
        for channels in [1usize, 2, 6, 8] {
            let frames = 5_000;
            let interleaved = fixture(frames, channels);

            let combined = Resampler::new(channels, 48_000, 96_000)
                .unwrap()
                .resample_parallel(&interleaved, PhaseResponse::Minimum, ResampleQuality::High)
                .unwrap();

            assert_eq!(combined.len() % channels, 0);
            let out_frames = combined.len() / channels;

            for channel in 0..channels {
                let mono: Vec<f64> = (0..frames)
                    .map(|frame| interleaved[frame * channels + channel])
                    .collect();
                let expected = Resampler::new(1, 48_000, 96_000)
                    .unwrap()
                    .resample_parallel(&mono, PhaseResponse::Minimum, ResampleQuality::High)
                    .unwrap();

                assert_eq!(
                    expected.len(),
                    out_frames,
                    "channel {channel} of {channels} produced a different frame count"
                );
                for (frame, want) in expected.iter().enumerate() {
                    let got = combined[frame * channels + channel];
                    assert_eq!(
                        got.to_bits(),
                        want.to_bits(),
                        "channel {channel} of {channels} diverged at frame {frame}"
                    );
                }
            }
        }
    }

    /// The offline path must actually run channels concurrently.
    ///
    /// Without this, dropping the work-stealing pool in favour of scoped
    /// threads could silently degrade into a sequential loop and nothing else
    /// in the suite would notice. Every channel worker parks on a barrier that
    /// only releases once all of them have arrived, so this test cannot pass
    /// unless the channels are genuinely in flight at the same time.
    #[test]
    fn parallel_channel_fan_out_runs_channels_concurrently() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Barrier;

        let channels = 4;
        let peak = AtomicUsize::new(0);
        let live = AtomicUsize::new(0);
        let barrier = Barrier::new(channels);

        std::thread::scope(|scope| {
            for _ in 0..channels {
                scope.spawn(|| {
                    let now = live.fetch_add(1, Ordering::AcqRel) + 1;
                    peak.fetch_max(now, Ordering::AcqRel);
                    // Deadlocks instead of failing quietly if the runtime ever
                    // stops overlapping these.
                    barrier.wait();
                    live.fetch_sub(1, Ordering::AcqRel);
                });
            }
        });

        assert_eq!(
            peak.load(Ordering::Acquire),
            channels,
            "scoped fan-out must keep every channel worker in flight together"
        );
    }

    #[test]
    fn one_shot_resampler_rejects_invalid_geometry_at_construction() {
        assert!(matches!(
            Resampler::new(0, 48_000, 96_000),
            Err(ResamplerError::ZeroChannels)
        ));
        for (from_rate, to_rate) in [(0, 96_000), (48_000, 0)] {
            assert!(matches!(
                Resampler::new(2, from_rate, to_rate),
                Err(ResamplerError::InvalidSampleRate { .. })
            ));
        }
    }

    #[test]
    fn one_shot_resampler_rejects_incomplete_frames_before_rate_bypass() {
        for (from_rate, to_rate) in [(48_000, 48_000), (48_000, 96_000)] {
            let error = Resampler::new(2, from_rate, to_rate)
                .unwrap()
                .resample_parallel(
                    &[0.25, -0.25, 0.5],
                    PhaseResponse::Linear,
                    ResampleQuality::High,
                )
                .unwrap_err();
            assert!(matches!(
                error,
                ResamplerError::InvalidBlock(AudioBlockError::IncompleteFrame {
                    samples: 3,
                    channels: 2,
                })
            ));
        }
    }

    #[test]
    fn one_shot_equal_rate_preserves_valid_and_empty_input() {
        let resampler = Resampler::new(2, 48_000, 48_000).unwrap();
        let input = [0.25, -0.25, 0.5, -0.5];
        assert_eq!(
            resampler
                .resample_parallel(&input, PhaseResponse::Linear, ResampleQuality::High,)
                .unwrap(),
            input
        );
        assert!(resampler
            .resample_parallel(&[], PhaseResponse::Linear, ResampleQuality::High)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn process_capacity_is_checked_exact_frame_domain_provisioning() {
        let resampler = StreamingResampler::new(2, 44_100, 48_000).unwrap();
        assert_eq!(resampler.process_output_capacity_frames(0).unwrap(), 0);
        assert_eq!(
            resampler.process_output_capacity_frames(441).unwrap(),
            480 + PROCESS_OUTPUT_BURST_SLACK_FRAMES
        );

        let equal_rate = StreamingResampler::new(2, 48_000, 48_000).unwrap();
        assert!(matches!(
            equal_rate.process_output_capacity_frames(usize::MAX),
            Err(ResamplerError::CapacityOverflow {
                buffer: "process output"
            })
        ));
        assert!(matches!(
            process_output_capacity_frames(usize::MAX, 1, u32::MAX),
            Err(ResamplerError::CapacityOverflow {
                buffer: "process output"
            })
        ));
    }

    #[test]
    fn process_capacity_bounds_repeated_canonical_blocks() {
        for (from_rate, to_rate) in [
            (48_000, 48_000),
            (44_100, 48_000),
            (48_000, 44_100),
            (8_000, 192_000),
        ] {
            let mut resampler = StreamingResampler::new(2, from_rate, to_rate).unwrap();
            let input = fixture(512, 2);
            let capacity_frames = resampler.process_output_capacity_frames(512).unwrap();
            let mut output = vec![0.0; capacity_frames * 2];

            for _ in 0..8 {
                let input_block = AudioBlockRef::new(&input, 2).unwrap();
                let output_block = AudioBlockMut::new(&mut output, 2).unwrap();
                let progress = process_checked(
                    &mut resampler,
                    ProcessBuffers::out_of_place(input_block, output_block).unwrap(),
                )
                .unwrap();
                assert_eq!(progress.consumed_frames(), 512);
                assert!(progress.produced_frames() <= capacity_frames);
            }
        }
    }

    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    #[test]
    fn nonlinear_phase_rejects_pathological_geometry_without_linear_fallback() {
        assert!(StreamingResampler::with_phase(1, 44_100, 44_101, PhaseResponse::Linear,).is_ok());

        for phase in [PhaseResponse::Minimum, PhaseResponse::Maximum] {
            match StreamingResampler::with_phase(1, 44_100, 44_101, phase) {
                Err(ResamplerError::RatioExceedsLimit { up, down, limit }) => {
                    assert_eq!((up, down, limit), (44_101, 44_100, 1_024));
                }
                Err(error) => panic!("{phase:?} returned an unexpected error: {error}"),
                Ok(_) => panic!("{phase:?} unexpectedly selected a linear backend"),
            }
        }
    }

    #[cfg(feature = "soxr")]
    #[test]
    fn working_buffer_size_overflow_has_a_typed_class() {
        assert!(matches!(
            StreamingResampler::working_buffer_bytes(usize::MAX, 48_000, 96_000),
            Err(ResamplerError::CapacityOverflow { .. })
        ));
    }

    #[test]
    fn backend_failure_classes_are_structured() {
        let initialization = map_backend_init_error(
            BackendInitError::Backend {
                message: "fixture".to_string(),
            },
            Some(2),
        );
        assert!(matches!(
            initialization,
            ResamplerError::BackendInitialization {
                channel: Some(2),
                ..
            }
        ));
        assert!(matches!(
            ResamplerError::InvalidBackendProgress {
                operation: "process",
                channel: None,
            },
            ResamplerError::InvalidBackendProgress { .. }
        ));
        assert!(matches!(
            ResamplerError::BackendStalled {
                operation: "process",
                channel: None,
            },
            ResamplerError::BackendStalled { .. }
        ));
    }

    #[test]
    fn working_buffer_bytes_matches_internal_capacities() {
        #[cfg(feature = "soxr")]
        let resampler = StreamingResampler::new(6, 44_100, 192_000).unwrap();
        #[cfg(feature = "soxr")]
        let actual_samples = resampler.output_scratch.capacity()
            + resampler
                .channel_inputs
                .iter()
                .map(Vec::capacity)
                .sum::<usize>()
            + resampler
                .channel_outputs
                .iter()
                .map(Vec::capacity)
                .sum::<usize>();
        #[cfg(all(feature = "rubato", not(feature = "soxr")))]
        let actual_samples = 0usize;
        assert_eq!(
            StreamingResampler::working_buffer_bytes(6, 44_100, 192_000).unwrap(),
            actual_samples * std::mem::size_of::<f64>()
        );
    }

    #[cfg(feature = "soxr")]
    #[test]
    fn stereo_soxr_uses_one_interleaved_backend_without_adapter_pcm_scratch() {
        let resampler = StreamingResampler::new(2, 44_100, 48_000).unwrap();
        assert_eq!(resampler.backends.len(), 1);
        assert!(resampler.backends[0].is_interleaved_stereo());
        assert_eq!(resampler.output_scratch.capacity(), 0);
        assert_eq!(resampler.channel_inputs.capacity(), 0);
        assert_eq!(resampler.channel_outputs.capacity(), 0);
        assert_eq!(
            StreamingResampler::working_buffer_bytes(2, 44_100, 48_000).unwrap(),
            0
        );
    }

    #[cfg(feature = "soxr")]
    #[test]
    fn stereo_soxr_matches_independent_mono_reference_bits() {
        let input = fixture(4_097, 2);
        let expected = Resampler::new(2, 44_100, 48_000)
            .unwrap()
            .resample_parallel(&input, PhaseResponse::Linear, ResampleQuality::High)
            .unwrap();
        let mut streaming = StreamingResampler::with_quality(
            2,
            44_100,
            48_000,
            PhaseResponse::Linear,
            ResampleQuality::High,
        )
        .unwrap();
        let actual =
            render_with_chunks(&mut streaming, &input, &[1, 17, 251, 64, 1_024], 257).unwrap();

        assert_eq!(actual.len(), expected.len());
        assert!(
            actual
                .iter()
                .zip(expected)
                .all(|(left, right)| left.to_bits() == right.to_bits()),
            "native interleaved stereo diverged from independent mono streams"
        );
    }

    #[test]
    fn equal_rate_supports_in_place_bypass_and_lifecycle() {
        let mut resampler = StreamingResampler::new(2, 48_000, 48_000).unwrap();
        let mut samples = fixture(32, 2);
        let expected = samples.clone();
        let progress = process_checked(
            &mut resampler,
            ProcessBuffers::in_place(AudioBlockMut::new(&mut samples, 2).unwrap()),
        )
        .unwrap();
        assert!(progress.is_bypassed());
        assert_eq!(samples, expected);

        let mut output = [0.0; 8];
        assert_eq!(
            finish_checked(&mut resampler, AudioBlockMut::new(&mut output, 2).unwrap()).unwrap(),
            ProcessProgress::finished(0)
        );
        assert!(matches!(
            process_checked(
                &mut resampler,
                ProcessBuffers::in_place(AudioBlockMut::new(&mut samples, 2).unwrap())
            ),
            Err(ProcessError::AlreadyFinished { .. })
        ));
        resampler.reset().unwrap();
        let _ = process_checked(
            &mut resampler,
            ProcessBuffers::in_place(AudioBlockMut::new(&mut samples, 2).unwrap()),
        )
        .unwrap();
    }

    #[test]
    fn variable_rate_rejects_in_place_and_channel_mismatch() {
        let mut resampler = StreamingResampler::new(2, 48_000, 96_000).unwrap();
        let mut samples = fixture(16, 2);
        assert!(matches!(
            process_checked(
                &mut resampler,
                ProcessBuffers::in_place(AudioBlockMut::new(&mut samples, 2).unwrap())
            ),
            Err(ProcessError::UnsupportedBufferMode { .. })
        ));

        let input = AudioBlockRef::new(&samples, 2).unwrap();
        let mut output = [0.0; 16];
        assert_eq!(
            ProcessBuffers::out_of_place(input, AudioBlockMut::new(&mut output, 1).unwrap())
                .unwrap_err(),
            AudioBlockError::ChannelMismatch {
                input_channels: 2,
                output_channels: 1,
            }
        );
    }

    #[test]
    fn short_and_long_integer_upsampling_consume_every_frame() {
        for frames in [512, 100_000] {
            let input = fixture(frames, 2);
            let mut resampler = StreamingResampler::new(2, 48_000, 96_000).unwrap();
            let output = render_with_chunks(&mut resampler, &input, &[frames], 257).unwrap();
            assert_eq!(output.len() / 2, frames * 2);
        }
    }

    #[test]
    fn random_input_chunking_matches_single_feed() {
        let input = fixture(32_777, 2);
        let mut whole = StreamingResampler::new(2, 48_000, 96_000).unwrap();
        let mut chunked = StreamingResampler::new(2, 48_000, 96_000).unwrap();
        let expected = render_with_chunks(&mut whole, &input, &[input.len() / 2], 509).unwrap();
        let actual =
            render_with_chunks(&mut chunked, &input, &[1, 17, 3, 251, 64, 5, 1024, 7], 509)
                .unwrap();
        assert_eq!(actual.len(), expected.len());
        let max_error = actual
            .iter()
            .zip(&expected)
            .map(|(left, right)| (left - right).abs())
            .fold(0.0_f64, f64::max);
        assert!(max_error <= 1.0e-12, "chunking error {max_error:e}");
    }

    #[test]
    fn native_drain_returns_a_duration_aligned_impulse_sequence() {
        let input_frames = 4_096;
        let impulse_frame = 1_024;
        let mut input = vec![0.0; input_frames];
        input[impulse_frame] = 1.0;
        let mut resampler = StreamingResampler::new(1, 48_000, 96_000).unwrap();
        let output = render_with_chunks(&mut resampler, &input, &[127, 509], 257).unwrap();
        let peak_frame = output
            .iter()
            .enumerate()
            .max_by(|(_, left), (_, right)| {
                left.abs()
                    .partial_cmp(&right.abs())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(frame, _)| frame)
            .unwrap();

        assert_eq!(output.len(), input_frames * 2);
        assert!(
            peak_frame.abs_diff(impulse_frame * 2) <= 1,
            "resampled impulse peak landed at {peak_frame}, expected {}",
            impulse_frame * 2
        );
        assert_eq!(resampler.latency(), FrameDuration::ZERO);
    }

    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    #[test]
    fn rubato_sinc_fallback_is_duration_and_impulse_aligned() {
        let input_frames = 4_096;
        let impulse_frame = 1_024;
        let mut input = vec![0.0; input_frames];
        input[impulse_frame] = 1.0;
        let mut resampler = StreamingResampler::new(1, 44_100, 44_101).unwrap();
        let output = render_with_chunks(&mut resampler, &input, &[127, 509], 257).unwrap();
        let peak_frame = output
            .iter()
            .enumerate()
            .max_by(|(_, left), (_, right)| {
                left.abs()
                    .partial_cmp(&right.abs())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(frame, _)| frame)
            .unwrap();
        let expected_frames =
            super::rubato_backend::expected_output_frames(input_frames as u64, 44_100, 44_101);
        let expected_peak =
            super::rubato_backend::expected_output_frames(impulse_frame as u64, 44_100, 44_101);

        assert_eq!(output.len() as u64, expected_frames);
        assert!(
            (peak_frame as u64).abs_diff(expected_peak) <= 1,
            "sinc-fallback impulse peak landed at {peak_frame}, expected {expected_peak}"
        );
        assert_eq!(resampler.latency(), FrameDuration::ZERO);
    }

    #[test]
    fn finish_is_terminal_idempotent_and_reset_clears_native_history() {
        let impulse = {
            let mut samples = vec![0.0; 2_048 * 2];
            samples[0] = 0.8;
            samples[1] = -0.8;
            samples
        };
        let silence = vec![0.0; 2_048 * 2];
        let mut reused = StreamingResampler::new(2, 48_000, 96_000).unwrap();
        let _ = render_with_chunks(&mut reused, &impulse, &[127], 257).unwrap();

        let mut terminal_buffer = vec![0.0; 64 * 2];
        let terminal = finish_checked(
            &mut reused,
            AudioBlockMut::new(&mut terminal_buffer, 2).unwrap(),
        )
        .unwrap();
        assert_eq!(terminal, ProcessProgress::finished(0));

        reused.reset().unwrap();
        let actual = render_with_chunks(&mut reused, &silence, &[31, 257], 257).unwrap();
        let mut fresh = StreamingResampler::new(2, 48_000, 96_000).unwrap();
        let expected = render_with_chunks(&mut fresh, &silence, &[31, 257], 257).unwrap();
        assert_eq!(actual.len(), expected.len());
        assert!(actual
            .iter()
            .zip(expected)
            .all(|(left, right)| left.to_bits() == right.to_bits()));
    }

    #[test]
    fn streaming_process_and_finish_do_not_allocate_after_setup() {
        let input = fixture(512, 2);
        let mut output = vec![0.0; 2_048 * 2];
        let mut resampler = StreamingResampler::new(2, 48_000, 96_000).unwrap();

        assert_no_alloc::assert_no_alloc(|| {
            let input_block = AudioBlockRef::new(&input, 2).unwrap();
            let output_block = AudioBlockMut::new(&mut output, 2).unwrap();
            let progress = process_checked(
                &mut resampler,
                ProcessBuffers::out_of_place(input_block, output_block).unwrap(),
            )
            .unwrap();
            assert_eq!(progress.consumed_frames(), 512);

            loop {
                let output_block = AudioBlockMut::new(&mut output, 2).unwrap();
                let progress = finish_checked(&mut resampler, output_block).unwrap();
                if progress.state() == ProcessState::Finished {
                    break;
                }
            }
        });
    }

    #[test]
    fn one_shot_parallel_matches_unified_streaming_length() {
        let input = fixture(24_000, 2);
        let parallel = Resampler::new(2, 44_100, 192_000)
            .unwrap()
            .resample_parallel(&input, PhaseResponse::Linear, ResampleQuality::High)
            .unwrap();
        let mut streaming = StreamingResampler::with_quality(
            2,
            44_100,
            192_000,
            PhaseResponse::Linear,
            ResampleQuality::High,
        )
        .unwrap();
        let streamed = render_with_chunks(&mut streaming, &input, &[8_192], 1_023).unwrap();
        assert_eq!(parallel.len(), streamed.len());
    }

    #[test]
    fn output_rate_mapping_is_explicit() {
        let resampler = StreamingResampler::new(2, 44_100, 48_000).unwrap();
        assert_eq!(resampler.output_sample_rate_hz(44_100), Ok(48_000));
        assert!(matches!(
            resampler.output_sample_rate_hz(48_000),
            Err(ProcessError::SampleRateMismatch { .. })
        ));
    }

    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    #[test]
    fn nonlinear_chunking_interleaving_terminal_and_reset_match_references() {
        const CHANNELS: usize = 2;
        const INPUT_FRAMES: usize = 4_097;
        let input = fixture(INPUT_FRAMES, CHANNELS);

        let mut whole =
            StreamingResampler::with_phase(CHANNELS, 48_000, 96_000, PhaseResponse::Minimum)
                .unwrap();
        let expected = render_with_chunks(&mut whole, &input, &[INPUT_FRAMES], 257).unwrap();

        let mut chunked =
            StreamingResampler::with_phase(CHANNELS, 48_000, 96_000, PhaseResponse::Minimum)
                .unwrap();
        let actual =
            render_with_chunks(&mut chunked, &input, &[1, 17, 3, 251, 64, 5, 1_024, 7], 257)
                .unwrap();
        assert_eq!(actual.len(), expected.len());
        assert!(actual
            .iter()
            .zip(&expected)
            .all(|(left, right)| left.to_bits() == right.to_bits()));

        for channel in 0..CHANNELS {
            let mono_input: Vec<f64> = input
                .chunks_exact(CHANNELS)
                .map(|frame| frame[channel])
                .collect();
            let mut mono =
                StreamingResampler::with_phase(1, 48_000, 96_000, PhaseResponse::Minimum).unwrap();
            let mono_output = render_with_chunks(
                &mut mono,
                &mono_input,
                &[1, 17, 3, 251, 64, 5, 1_024, 7],
                257,
            )
            .unwrap();
            assert_eq!(actual.len() / CHANNELS, mono_output.len());
            assert!(actual
                .chunks_exact(CHANNELS)
                .zip(&mono_output)
                .all(|(frame, sample)| frame[channel].to_bits() == sample.to_bits()));
        }

        let mut terminal_output = vec![0.0; 64 * CHANNELS];
        let terminal = finish_checked(
            &mut chunked,
            AudioBlockMut::new(&mut terminal_output, CHANNELS).unwrap(),
        )
        .unwrap();
        assert_eq!(terminal, ProcessProgress::finished(0));

        chunked.reset().unwrap();
        let post_reset_input = fixture(2_049, CHANNELS);
        let reset_output =
            render_with_chunks(&mut chunked, &post_reset_input, &[31, 257], 257).unwrap();
        let mut fresh =
            StreamingResampler::with_phase(CHANNELS, 48_000, 96_000, PhaseResponse::Minimum)
                .unwrap();
        let fresh_output =
            render_with_chunks(&mut fresh, &post_reset_input, &[31, 257], 257).unwrap();
        assert_eq!(reset_output.len(), fresh_output.len());
        assert!(reset_output
            .iter()
            .zip(&fresh_output)
            .all(|(left, right)| left.to_bits() == right.to_bits()));
    }

    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    #[test]
    fn nonlinear_phase_is_real_and_reports_causal_latency() {
        let input_frames = 4_096;
        let impulse_frame = 1_024;
        let mut input = vec![0.0; input_frames];
        input[impulse_frame] = 1.0;

        let mut linear =
            StreamingResampler::with_phase(1, 44_100, 48_000, PhaseResponse::Linear).unwrap();
        let mut minimum =
            StreamingResampler::with_phase(1, 44_100, 48_000, PhaseResponse::Minimum).unwrap();
        let mut maximum =
            StreamingResampler::with_phase(1, 44_100, 48_000, PhaseResponse::Maximum).unwrap();

        let linear_output = render_with_chunks(&mut linear, &input, &[127, 509], 257).unwrap();
        let minimum_output = render_with_chunks(&mut minimum, &input, &[127, 509], 257).unwrap();
        let maximum_output = render_with_chunks(&mut maximum, &input, &[127, 509], 257).unwrap();

        let expected_frames =
            super::rubato_backend::expected_output_frames(input_frames as u64, 44_100, 48_000)
                as usize;
        assert_eq!(linear_output.len(), expected_frames);
        let minimum_tail = minimum.tail().finite_duration().unwrap().frames();
        let maximum_tail = maximum.tail().finite_duration().unwrap().frames();
        assert_eq!(
            minimum_output.len(),
            expected_frames + minimum.latency().frames() + minimum_tail
        );
        assert_eq!(
            maximum_output.len(),
            expected_frames + maximum.latency().frames() + maximum_tail
        );
        assert_eq!(minimum_output.len(), maximum_output.len());
        assert!(minimum.latency().frames() < maximum.latency().frames());
        assert!(minimum_tail > maximum_tail);

        fn energy_centroid(samples: &[f64]) -> f64 {
            let total = samples.iter().map(|sample| sample * sample).sum::<f64>();
            samples
                .iter()
                .enumerate()
                .map(|(index, sample)| index as f64 * sample * sample)
                .sum::<f64>()
                / total
        }

        let minimum_centroid = energy_centroid(&minimum_output);
        let maximum_centroid = energy_centroid(&maximum_output);
        assert!(minimum_centroid < maximum_centroid);

        let minimum_peak = minimum_output
            .iter()
            .enumerate()
            .max_by(|(_, left), (_, right)| {
                left.abs()
                    .partial_cmp(&right.abs())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(index, _)| index)
            .unwrap();
        let maximum_peak = maximum_output
            .iter()
            .enumerate()
            .max_by(|(_, left), (_, right)| {
                left.abs()
                    .partial_cmp(&right.abs())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(index, _)| index)
            .unwrap();
        assert!(minimum_peak < maximum_peak);
    }

    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    #[test]
    fn exact_two_x_linear_high_passband_thdn_and_images_are_bounded() {
        const FROM_RATE: u32 = 48_000;
        const TO_RATE: u32 = 96_000;
        const INPUT_FRAMES: usize = 32_768;
        const ANALYSIS_START: usize = 4_096;
        // Divisible by the 20/28 kHz 24-sample periods and the 18/30 kHz
        // 16-sample periods at 96 kHz.
        const ANALYSIS_FRAMES: usize = 6_144;
        const AMPLITUDE: f64 = 0.5;

        fn sine(frequency_hz: f64) -> Vec<f64> {
            (0..INPUT_FRAMES)
                .map(|frame| {
                    AMPLITUDE
                        * (2.0 * std::f64::consts::PI * frequency_hz * frame as f64
                            / FROM_RATE as f64)
                            .sin()
                })
                .collect()
        }

        fn fitted_tone(samples: &[f64], frequency_hz: f64) -> (f64, f64) {
            let samples = &samples[ANALYSIS_START..ANALYSIS_START + ANALYSIS_FRAMES];
            let mut sin_dot = 0.0;
            let mut cos_dot = 0.0;
            for (offset, &sample) in samples.iter().enumerate() {
                let frame = ANALYSIS_START + offset;
                let phase =
                    2.0 * std::f64::consts::PI * frequency_hz * frame as f64 / TO_RATE as f64;
                sin_dot += sample * phase.sin();
                cos_dot += sample * phase.cos();
            }
            let sin_scale = 2.0 * sin_dot / ANALYSIS_FRAMES as f64;
            let cos_scale = 2.0 * cos_dot / ANALYSIS_FRAMES as f64;
            let amplitude = sin_scale.hypot(cos_scale);
            let mut residual_energy = 0.0;
            let mut fitted_energy = 0.0;
            for (offset, &sample) in samples.iter().enumerate() {
                let frame = ANALYSIS_START + offset;
                let phase =
                    2.0 * std::f64::consts::PI * frequency_hz * frame as f64 / TO_RATE as f64;
                let fitted = sin_scale * phase.sin() + cos_scale * phase.cos();
                residual_energy += (sample - fitted).powi(2);
                fitted_energy += fitted.powi(2);
            }
            let thdn_db = 10.0 * (residual_energy / fitted_energy.max(1.0e-30)).log10();
            (amplitude, thdn_db)
        }

        fn render(frequency_hz: f64) -> Vec<f64> {
            let mut resampler = StreamingResampler::with_quality(
                1,
                FROM_RATE,
                TO_RATE,
                PhaseResponse::Linear,
                ResampleQuality::High,
            )
            .unwrap();
            render_with_chunks(&mut resampler, &sine(frequency_hz), &[127, 509], 257).unwrap()
        }

        let output_20khz = render(20_000.0);
        let (passband_amplitude, thdn_db) = fitted_tone(&output_20khz, 20_000.0);
        let gain_db = 20.0 * (passband_amplitude / AMPLITUDE).log10();
        let (image_28khz_amplitude, _) = fitted_tone(&output_20khz, 28_000.0);
        let image_28khz_db = 20.0 * (image_28khz_amplitude / AMPLITUDE).max(1.0e-15).log10();

        let output_18khz = render(18_000.0);
        let (image_30khz_amplitude, _) = fitted_tone(&output_18khz, 30_000.0);
        let image_30khz_db = 20.0 * (image_30khz_amplitude / AMPLITUDE).max(1.0e-15).log10();

        assert!(gain_db.abs() < 0.01, "20 kHz gain was {gain_db:.6} dB");
        assert!(thdn_db < -100.0, "20 kHz THD+N was {thdn_db:.3} dB");
        assert!(
            image_28khz_db < -120.0,
            "20 kHz -> 28 kHz image was {image_28khz_db:.3} dB"
        );
        assert!(
            image_30khz_db < -120.0,
            "18 kHz -> 30 kHz image was {image_30khz_db:.3} dB"
        );
    }

    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    #[test]
    fn nonlinear_phase_actual_ratio_passband_alias_and_thdn_are_bounded() {
        const FROM_RATE: u32 = 96_000;
        const TO_RATE: u32 = 48_000;
        const INPUT_FRAMES: usize = 32_768;
        const ANALYSIS_START: usize = 4_096;
        // Divisible by both the 20 kHz / 48 kHz 12-sample period and the
        // 18 kHz / 48 kHz 8-sample period, keeping the fitted-tone basis exact.
        const ANALYSIS_FRAMES: usize = 6_144;
        const AMPLITUDE: f64 = 0.5;

        fn sine(frequency_hz: f64) -> Vec<f64> {
            (0..INPUT_FRAMES)
                .map(|frame| {
                    AMPLITUDE
                        * (2.0 * std::f64::consts::PI * frequency_hz * frame as f64
                            / FROM_RATE as f64)
                            .sin()
                })
                .collect()
        }

        fn fitted_tone(samples: &[f64], frequency_hz: f64) -> (f64, f64) {
            let samples = &samples[ANALYSIS_START..ANALYSIS_START + ANALYSIS_FRAMES];
            let mut sin_dot = 0.0;
            let mut cos_dot = 0.0;
            for (offset, &sample) in samples.iter().enumerate() {
                let frame = ANALYSIS_START + offset;
                let phase =
                    2.0 * std::f64::consts::PI * frequency_hz * frame as f64 / TO_RATE as f64;
                sin_dot += sample * phase.sin();
                cos_dot += sample * phase.cos();
            }
            let sin_scale = 2.0 * sin_dot / ANALYSIS_FRAMES as f64;
            let cos_scale = 2.0 * cos_dot / ANALYSIS_FRAMES as f64;
            let amplitude = sin_scale.hypot(cos_scale);
            let mut residual_energy = 0.0;
            let mut fitted_energy = 0.0;
            for (offset, &sample) in samples.iter().enumerate() {
                let frame = ANALYSIS_START + offset;
                let phase =
                    2.0 * std::f64::consts::PI * frequency_hz * frame as f64 / TO_RATE as f64;
                let fitted = sin_scale * phase.sin() + cos_scale * phase.cos();
                residual_energy += (sample - fitted).powi(2);
                fitted_energy += fitted.powi(2);
            }
            let thdn_db = 10.0 * (residual_energy / fitted_energy.max(1.0e-30)).log10();
            (amplitude, thdn_db)
        }

        for phase in [PhaseResponse::Minimum, PhaseResponse::Maximum] {
            let mut passband = StreamingResampler::with_quality(
                1,
                FROM_RATE,
                TO_RATE,
                phase,
                ResampleQuality::High,
            )
            .unwrap();
            let passband_output =
                render_with_chunks(&mut passband, &sine(20_000.0), &[127, 509], 257).unwrap();
            let (passband_amplitude, thdn_db) = fitted_tone(&passband_output, 20_000.0);
            let gain_db = 20.0 * (passband_amplitude / AMPLITUDE).log10();

            let mut stopband = StreamingResampler::with_quality(
                1,
                FROM_RATE,
                TO_RATE,
                phase,
                ResampleQuality::High,
            )
            .unwrap();
            let stopband_output =
                render_with_chunks(&mut stopband, &sine(30_000.0), &[127, 509], 257).unwrap();
            let (alias_amplitude, _) = fitted_tone(&stopband_output, 18_000.0);
            let alias_db = 20.0 * (alias_amplitude / AMPLITUDE).max(1.0e-15).log10();

            assert!(
                gain_db.abs() < 0.05,
                "{phase:?} 20 kHz gain was {gain_db:.6} dB"
            );
            assert!(thdn_db < -90.0, "{phase:?} THD+N was {thdn_db:.3} dB");
            assert!(
                alias_db < -100.0,
                "{phase:?} 30 kHz -> 18 kHz alias was {alias_db:.3} dB"
            );
        }
    }

    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    #[test]
    fn nonlinear_phase_streaming_is_allocation_free_after_setup() {
        let input = fixture(512, 2);
        let mut output = vec![0.0; 2_048 * 2];
        let mut resampler =
            StreamingResampler::with_phase(2, 48_000, 96_000, PhaseResponse::Minimum).unwrap();

        assert_no_alloc::assert_no_alloc(|| {
            let input_block = AudioBlockRef::new(&input, 2).unwrap();
            let output_block = AudioBlockMut::new(&mut output, 2).unwrap();
            let progress = process_checked(
                &mut resampler,
                ProcessBuffers::out_of_place(input_block, output_block).unwrap(),
            )
            .unwrap();
            assert_eq!(progress.consumed_frames(), 512);

            loop {
                let output_block = AudioBlockMut::new(&mut output, 2).unwrap();
                let progress = finish_checked(&mut resampler, output_block).unwrap();
                if progress.state() == ProcessState::Finished {
                    break;
                }
            }
        });
    }
}
