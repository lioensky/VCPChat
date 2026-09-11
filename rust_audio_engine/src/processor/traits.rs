//! Audio Processor Traits
//!
//! Defines the unified interface for all DSP processors in the audio pipeline.
//! This abstraction enables a composable DSP chain with guaranteed continuity.

use std::num::{NonZeroU32, NonZeroUsize};

use thiserror::Error;

/// Validation failure for a borrowed interleaved audio block.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum AudioBlockError {
    /// An interleaved block cannot describe frames without at least one channel.
    #[error("audio block channel count must be greater than zero")]
    ZeroChannels,
    /// The sample slice ends with an incomplete interleaved frame.
    #[error("interleaved sample count {samples} is not divisible by channel count {channels}")]
    IncompleteFrame {
        /// Number of interleaved samples supplied by the caller.
        samples: usize,
        /// Channel count used to validate the interleaved block.
        channels: usize,
    },
    /// An out-of-place call requires the same channel count on both sides.
    /// The caller supplied an interleaved buffer with invalid frame geometry.
    #[error(
        "input/output channel mismatch: input has {input_channels}, output has {output_channels}"
    )]
    ChannelMismatch {
        /// Channel count declared by the input view.
        input_channels: usize,
        /// Channel count declared by the output view.
        output_channels: usize,
    },
}

pub(crate) fn validated_channel_count(channels: usize) -> Result<NonZeroUsize, AudioBlockError> {
    NonZeroUsize::new(channels).ok_or(AudioBlockError::ZeroChannels)
}

/// Zero-copy view over a complete interleaved `f64` input block.
#[derive(Debug, Clone, Copy)]
pub struct AudioBlockRef<'a> {
    samples: &'a [f64],
    channels: NonZeroUsize,
    frames: usize,
}

impl<'a> AudioBlockRef<'a> {
    /// Validate and borrow an interleaved sample slice.
    pub fn new(samples: &'a [f64], channels: usize) -> Result<Self, AudioBlockError> {
        let channels = validated_channel_count(channels)?;
        if !samples.len().is_multiple_of(channels.get()) {
            return Err(AudioBlockError::IncompleteFrame {
                samples: samples.len(),
                channels: channels.get(),
            });
        }

        Ok(Self {
            samples,
            channels,
            frames: samples.len() / channels.get(),
        })
    }

    /// Borrow all interleaved samples in the block.
    pub fn samples(self) -> &'a [f64] {
        self.samples
    }

    /// Number of interleaved channels.
    pub fn channels(self) -> usize {
        self.channels.get()
    }

    /// Number of complete frames in the block.
    pub fn frames(self) -> usize {
        self.frames
    }

    /// Number of interleaved samples in the block.
    pub fn sample_count(self) -> usize {
        self.samples.len()
    }

    /// Whether the block contains zero frames.
    pub fn is_empty(self) -> bool {
        self.frames == 0
    }
}

/// Zero-copy mutable view over a complete interleaved `f64` block.
#[derive(Debug)]
pub struct AudioBlockMut<'a> {
    samples: &'a mut [f64],
    channels: NonZeroUsize,
    frames: usize,
}

impl<'a> AudioBlockMut<'a> {
    /// Validate and mutably borrow an interleaved sample slice.
    pub fn new(samples: &'a mut [f64], channels: usize) -> Result<Self, AudioBlockError> {
        let channels = validated_channel_count(channels)?;
        if !samples.len().is_multiple_of(channels.get()) {
            return Err(AudioBlockError::IncompleteFrame {
                samples: samples.len(),
                channels: channels.get(),
            });
        }

        Ok(Self {
            frames: samples.len() / channels.get(),
            samples,
            channels,
        })
    }

    /// Borrow all interleaved samples immutably.
    pub fn samples(&self) -> &[f64] {
        self.samples
    }

    /// Borrow all interleaved samples mutably.
    pub fn samples_mut(&mut self) -> &mut [f64] {
        self.samples
    }

    /// Consume the view and return its original mutable slice.
    pub fn into_samples(self) -> &'a mut [f64] {
        self.samples
    }

    /// Borrow this mutable view for a shorter lifetime.
    pub fn reborrow(&mut self) -> AudioBlockMut<'_> {
        AudioBlockMut {
            samples: self.samples,
            channels: self.channels,
            frames: self.frames,
        }
    }

    /// Create an immutable view over the same block.
    pub fn as_ref(&self) -> AudioBlockRef<'_> {
        AudioBlockRef {
            samples: self.samples,
            channels: self.channels,
            frames: self.frames,
        }
    }

    /// Number of interleaved channels.
    pub fn channels(&self) -> usize {
        self.channels.get()
    }

    /// Number of complete frames in the block.
    pub fn frames(&self) -> usize {
        self.frames
    }

    /// Number of interleaved samples in the block.
    pub fn sample_count(&self) -> usize {
        self.samples.len()
    }

    /// Whether the block contains zero frames.
    pub fn is_empty(&self) -> bool {
        self.frames == 0
    }
}

/// Buffer shape selected for one streaming processor call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessBufferMode {
    /// Read and write the same fixed-size block.
    InPlace,
    /// Read input and write to independent caller-owned storage.
    OutOfPlace,
}

/// Borrowed buffers yielded to a processor implementation.
#[derive(Debug)]
pub enum ProcessBufferParts<'a> {
    /// Fixed-size zero-copy processing.
    InPlace(AudioBlockMut<'a>),
    /// Variable-I/O or caller-separated processing.
    OutOfPlace {
        /// Read-only input frames.
        input: AudioBlockRef<'a>,
        /// Writable output capacity.
        output: AudioBlockMut<'a>,
    },
}

/// Validated input/output buffers for one [`StreamingProcessor::process`] call.
#[derive(Debug)]
pub struct ProcessBuffers<'a> {
    parts: ProcessBufferParts<'a>,
}

impl<'a> ProcessBuffers<'a> {
    /// Create an in-place call over one complete interleaved block.
    pub fn in_place(block: AudioBlockMut<'a>) -> Self {
        Self {
            parts: ProcessBufferParts::InPlace(block),
        }
    }

    /// Create an out-of-place call with matching channel counts.
    pub fn out_of_place(
        input: AudioBlockRef<'a>,
        output: AudioBlockMut<'a>,
    ) -> Result<Self, AudioBlockError> {
        if input.channels() != output.channels() {
            return Err(AudioBlockError::ChannelMismatch {
                input_channels: input.channels(),
                output_channels: output.channels(),
            });
        }

        Ok(Self {
            parts: ProcessBufferParts::OutOfPlace { input, output },
        })
    }

    /// Processing shape used for this call.
    pub fn mode(&self) -> ProcessBufferMode {
        match &self.parts {
            ProcessBufferParts::InPlace(_) => ProcessBufferMode::InPlace,
            ProcessBufferParts::OutOfPlace { .. } => ProcessBufferMode::OutOfPlace,
        }
    }

    /// Shared channel count for input and output.
    pub fn channels(&self) -> usize {
        match &self.parts {
            ProcessBufferParts::InPlace(block) => block.channels(),
            ProcessBufferParts::OutOfPlace { input, .. } => input.channels(),
        }
    }

    /// Capture frame capacities before moving the buffers into a processor.
    pub fn capacity(&self) -> ProcessCapacity {
        match &self.parts {
            ProcessBufferParts::InPlace(block) => ProcessCapacity::in_place(block.frames()),
            ProcessBufferParts::OutOfPlace { input, output } => {
                ProcessCapacity::new(input.frames(), output.frames())
            }
        }
    }

    /// Consume the wrapper and expose the selected safe buffer shape.
    pub fn into_parts(self) -> ProcessBufferParts<'a> {
        self.parts
    }
}

/// Reason the caller should stop or continue driving a processor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessState {
    /// All currently usable input was consumed; provide another input block.
    NeedInput,
    /// Output capacity stopped progress; call again with writable output space.
    NeedOutput,
    /// End-of-stream processing is complete and further finish calls produce zero frames.
    Finished,
}

/// Consumption/production result for a streaming processor call.
#[must_use]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessProgress {
    consumed_frames: usize,
    produced_frames: usize,
    state: ProcessState,
    bypassed: bool,
}

impl ProcessProgress {
    /// Construct an explicit progress result.
    pub const fn new(consumed_frames: usize, produced_frames: usize, state: ProcessState) -> Self {
        Self {
            consumed_frames,
            produced_frames,
            state,
            bypassed: false,
        }
    }

    /// Mark this result as a transparent bypass operation.
    pub const fn with_bypassed(mut self, bypassed: bool) -> Self {
        self.bypassed = bypassed;
        self
    }

    /// Construct a terminal finish result.
    pub const fn finished(produced_frames: usize) -> Self {
        Self::new(0, produced_frames, ProcessState::Finished)
    }

    /// Number of input frames consumed by the operation.
    pub const fn consumed_frames(self) -> usize {
        self.consumed_frames
    }

    /// Number of output frames produced by the operation.
    pub const fn produced_frames(self) -> usize {
        self.produced_frames
    }

    /// Lifecycle state reported after the operation.
    pub const fn state(self) -> ProcessState {
        self.state
    }

    /// Whether the operation copied input transparently without applying DSP.
    pub const fn is_bypassed(self) -> bool {
        self.bypassed
    }

    /// Whether at least one input frame was consumed or output frame produced.
    pub const fn made_progress(self) -> bool {
        self.consumed_frames > 0 || self.produced_frames > 0
    }
}

/// Frame capacities associated with one process/finish call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessCapacity {
    input_frames: usize,
    output_frames: usize,
    mode: ProcessBufferMode,
    finishing: bool,
}

impl ProcessCapacity {
    /// Describe an out-of-place process call with input and output capacities.
    pub const fn new(input_frames: usize, output_frames: usize) -> Self {
        Self {
            input_frames,
            output_frames,
            mode: ProcessBufferMode::OutOfPlace,
            finishing: false,
        }
    }

    /// Describe an in-place call whose input and output capacities are equal.
    pub const fn in_place(frames: usize) -> Self {
        Self {
            input_frames: frames,
            output_frames: frames,
            mode: ProcessBufferMode::InPlace,
            finishing: false,
        }
    }

    /// Describe a finish call that has no input and can emit tail frames.
    pub const fn for_finish(output_frames: usize) -> Self {
        Self {
            input_frames: 0,
            output_frames,
            mode: ProcessBufferMode::OutOfPlace,
            finishing: true,
        }
    }

    /// Return the input capacity in complete frames.
    pub const fn input_frames(self) -> usize {
        self.input_frames
    }

    /// Return the output capacity in complete frames.
    pub const fn output_frames(self) -> usize {
        self.output_frames
    }

    /// Return whether the call is in-place or out-of-place.
    pub const fn mode(self) -> ProcessBufferMode {
        self.mode
    }

    /// Return whether this capacity describes a tail-draining finish call.
    pub const fn is_finishing(self) -> bool {
        self.finishing
    }

    /// Verify bounds, caller-direction state, and forward progress.
    pub fn validate(
        self,
        processor: &'static str,
        progress: ProcessProgress,
    ) -> Result<ProcessProgress, ProcessError> {
        if progress.consumed_frames() > self.input_frames
            || progress.produced_frames() > self.output_frames
        {
            return Err(ProcessError::InvalidProgress {
                processor,
                consumed_frames: progress.consumed_frames(),
                produced_frames: progress.produced_frames(),
                input_capacity_frames: self.input_frames,
                output_capacity_frames: self.output_frames,
            });
        }

        if !progress.made_progress()
            && self.input_frames > 0
            && self.output_frames > 0
            && progress.state() != ProcessState::Finished
        {
            return Err(ProcessError::Stalled { processor });
        }

        let invalid_direction = if self.finishing {
            match progress.state() {
                ProcessState::NeedInput => true,
                ProcessState::NeedOutput => progress.produced_frames() != self.output_frames,
                ProcessState::Finished => progress.consumed_frames() != 0,
            }
        } else if self.mode == ProcessBufferMode::InPlace {
            progress.consumed_frames() != self.input_frames
                || progress.produced_frames() != self.output_frames
                || progress.state() != ProcessState::NeedInput
        } else {
            match progress.state() {
                ProcessState::NeedInput => progress.consumed_frames() != self.input_frames,
                ProcessState::NeedOutput => progress.produced_frames() != self.output_frames,
                ProcessState::Finished => true,
            }
        };
        if invalid_direction {
            return Err(ProcessError::InvalidProgress {
                processor,
                consumed_frames: progress.consumed_frames(),
                produced_frames: progress.produced_frames(),
                input_capacity_frames: self.input_frames,
                output_capacity_frames: self.output_frames,
            });
        }

        Ok(progress)
    }
}

/// Failure while constructing or rescaling frame-domain timing metadata.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum TimingError {
    /// A timing conversion was requested with a zero sample rate.
    #[error("sample rate must be greater than zero")]
    ZeroSampleRate,
    /// A converted frame count did not fit in the platform `usize`.
    #[error("rescaled frame count does not fit in usize")]
    FrameCountOverflow,
}

/// Rounding policy used only after timing values reach a common sample rate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameRounding {
    /// Discard the fractional frame.
    Floor,
    /// Round to the nearest frame; exact half-frame ties round upward.
    Nearest,
    /// Round upward whenever a fractional frame is present.
    Ceil,
}

/// A frame count carrying the sample-rate domain in which it was measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameDuration {
    frames: usize,
    sample_rate_hz: Option<NonZeroU32>,
}

impl FrameDuration {
    /// Rate-independent zero duration used by processors with no latency/tail.
    pub const ZERO: Self = Self {
        frames: 0,
        sample_rate_hz: None,
    };

    /// Construct a frame duration in a non-zero sample-rate domain.
    pub fn new(frames: usize, sample_rate_hz: u32) -> Result<Self, TimingError> {
        let sample_rate_hz = NonZeroU32::new(sample_rate_hz).ok_or(TimingError::ZeroSampleRate)?;
        Ok(Self {
            frames,
            sample_rate_hz: Some(sample_rate_hz),
        })
    }

    /// Return the frame count in this duration's sample-rate domain.
    pub const fn frames(self) -> usize {
        self.frames
    }

    /// `None` only for the rate-independent [`Self::ZERO`] value.
    pub const fn sample_rate_hz(self) -> Option<u32> {
        match self.sample_rate_hz {
            Some(rate) => Some(rate.get()),
            None => None,
        }
    }

    /// Return whether this duration represents no frames.
    pub const fn is_zero(self) -> bool {
        self.frames == 0
    }

    /// Convert to a fractional frame count without rounding.
    ///
    /// A chain should convert every stage to the final rate, sum these values,
    /// and round the total once. The default offline policy uses nearest-frame
    /// rounding for accumulated latency and ceiling for accumulated finite tail.
    pub fn frames_at_rate_f64(self, target_sample_rate_hz: u32) -> Result<f64, TimingError> {
        let target = NonZeroU32::new(target_sample_rate_hz).ok_or(TimingError::ZeroSampleRate)?;
        let Some(source) = self.sample_rate_hz else {
            return Ok(0.0);
        };
        Ok(self.frames as f64 * target.get() as f64 / source.get() as f64)
    }

    /// Rescale and round one duration. Chain composition should prefer
    /// [`Self::frames_at_rate_f64`] and round only the final accumulated value.
    pub fn rounded_frames_at_rate(
        self,
        target_sample_rate_hz: u32,
        rounding: FrameRounding,
    ) -> Result<usize, TimingError> {
        let target = NonZeroU32::new(target_sample_rate_hz).ok_or(TimingError::ZeroSampleRate)?;
        let Some(source) = self.sample_rate_hz else {
            return Ok(0);
        };

        let numerator = (self.frames as u128) * (target.get() as u128);
        let denominator = source.get() as u128;
        let rounded = match rounding {
            FrameRounding::Floor => numerator / denominator,
            FrameRounding::Nearest => (numerator + denominator / 2) / denominator,
            FrameRounding::Ceil => numerator.div_ceil(denominator),
        };
        usize::try_from(rounded).map_err(|_| TimingError::FrameCountOverflow)
    }
}

/// Tail behavior with exact timing metadata for finite tails.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TailSpec {
    /// The processor produces no semantic effect tail.
    None,
    /// The processor produces exactly this duration after input ends.
    Finite(FrameDuration),
    /// The processor decays but cannot predict an exact terminal frame.
    Unknown,
    /// The processor may produce a non-decaying or intentionally infinite tail.
    Infinite,
}

impl TailSpec {
    /// Normalize a zero-length finite tail to [`TailSpec::None`].
    pub fn finite(frames: usize, sample_rate_hz: u32) -> Result<Self, TimingError> {
        if frames == 0 {
            if sample_rate_hz == 0 {
                return Err(TimingError::ZeroSampleRate);
            }
            Ok(Self::None)
        } else {
            Ok(Self::Finite(FrameDuration::new(frames, sample_rate_hz)?))
        }
    }

    /// Return exact timing for finite tails, or `None` for unknown/infinite tails.
    pub const fn finite_duration(self) -> Option<FrameDuration> {
        match self {
            Self::None => Some(FrameDuration::ZERO),
            Self::Finite(duration) => Some(duration),
            Self::Unknown | Self::Infinite => None,
        }
    }
}

/// Typed failure from the unified streaming contract.
///
/// Marked `#[non_exhaustive]`: downstream matches must include a wildcard arm
/// so new diagnostic variants are not breaking changes.
#[derive(Debug, Error, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProcessError {
    /// The caller supplied an invalid interleaved block.
    #[error(transparent)]
    InvalidBlock(#[from] AudioBlockError),
    /// A frame-domain timing conversion failed.
    #[error(transparent)]
    InvalidTiming(#[from] TimingError),
    /// The processor does not implement the requested buffer shape.
    #[error("processor {processor} does not support {mode:?} processing")]
    UnsupportedBufferMode {
        /// Processor reporting the unsupported mode.
        processor: &'static str,
        /// Buffer mode that was requested.
        mode: ProcessBufferMode,
    },
    /// A processor reported counts outside the caller-provided capacities.
    #[error(
        "processor {processor} returned invalid progress: consumed {consumed_frames}/{input_capacity_frames} input frames, produced {produced_frames}/{output_capacity_frames} output frames"
    )]
    InvalidProgress {
        /// Processor that returned the invalid counts.
        processor: &'static str,
        /// Input frames reported as consumed.
        consumed_frames: usize,
        /// Output frames reported as produced.
        produced_frames: usize,
        /// Input capacity supplied by the caller.
        input_capacity_frames: usize,
        /// Output capacity supplied by the caller.
        output_capacity_frames: usize,
    },
    /// The processor returned no progress despite available work and capacity.
    #[error("processor {processor} made no progress with non-empty input and output capacity")]
    Stalled {
        /// Processor that stalled.
        processor: &'static str,
    },
    /// Input was supplied after the processor entered its terminal state.
    #[error("processor {processor} received input after end-of-stream; reset it first")]
    AlreadyFinished {
        /// Processor that has already finished.
        processor: &'static str,
    },
    /// A second streaming consumer attempted to use a single-consumer handle.
    #[error("processor {processor} already has an active audio consumer")]
    ConsumerAlreadyActive {
        /// Processor or control handle with the existing consumer.
        processor: &'static str,
    },
    /// The incoming block has a different channel geometry than setup allowed.
    #[error(
        "processor {processor} expected {expected_channels} channels but received {actual_channels}"
    )]
    ChannelCountMismatch {
        /// Processor reporting the mismatch.
        processor: &'static str,
        /// Channel count configured during setup.
        expected_channels: usize,
        /// Channel count received at the call boundary.
        actual_channels: usize,
    },
    /// The processor was asked to operate at a zero or otherwise invalid rate.
    #[error("processor {processor} received invalid sample rate {sample_rate_hz} Hz")]
    InvalidSampleRate {
        /// Processor reporting the invalid rate.
        processor: &'static str,
        /// Rejected sample rate in hertz.
        sample_rate_hz: u32,
    },
    /// The interleaved buffer shape is invalid for the requested operation.
    #[error(
        "processor {processor} received invalid interleaved geometry during {operation}: {message}"
    )]
    InvalidGeometry {
        /// Processor reporting the malformed geometry.
        processor: &'static str,
        /// Operation at which geometry was checked.
        operation: &'static str,
        /// Static reason the geometry was rejected.
        message: &'static str,
    },
    /// Sparse automation events failed ordering or value validation.
    #[error("processor {processor} received invalid automation events: {message}")]
    InvalidAutomation {
        /// Processor reporting the malformed automation.
        processor: &'static str,
        /// Static reason the events were rejected.
        message: &'static str,
    },
    /// A control-thread parameter write was rejected before it could reach DSP
    /// state, for example a non-finite value that would poison filter history.
    #[error("processor {processor} rejected parameter {parameter}: {message}")]
    InvalidParameter {
        /// Processor reporting the rejected parameter.
        processor: &'static str,
        /// Parameter name supplied by the caller.
        parameter: &'static str,
        /// Static reason the value was rejected.
        message: &'static str,
    },
    /// The incoming block belongs to a different sample-rate domain.
    #[error(
        "processor {processor} expected {expected_sample_rate_hz} Hz input but received {actual_sample_rate_hz} Hz"
    )]
    SampleRateMismatch {
        /// Processor reporting the rate-domain mismatch.
        processor: &'static str,
        /// Rate at which the processor was configured.
        expected_sample_rate_hz: u32,
        /// Rate attached to the incoming block.
        actual_sample_rate_hz: u32,
    },
    /// An offline render policy contains an unsafe or inconsistent bound.
    #[error("invalid offline render policy: {message}")]
    InvalidRenderPolicy {
        /// Static reason the offline policy was rejected.
        message: &'static str,
    },
    /// The processor exists but intentionally does not support this operation
    /// through the current API surface. The message names the supported path.
    #[error("processor {processor} does not support {operation}: {message}")]
    UnsupportedOperation {
        /// Processor reporting the unsupported operation.
        processor: &'static str,
        /// Operation requested by the caller.
        operation: &'static str,
        /// Static explanation of the supported alternative.
        message: &'static str,
    },
    /// Allocation-free backend diagnostic for realtime-capable processing.
    #[error("processor {processor} failed during {operation}: {message}")]
    Backend {
        /// Processor or backend reporting the failure.
        processor: &'static str,
        /// Operation that failed.
        operation: &'static str,
        /// Allocation-free static diagnostic.
        message: &'static str,
    },
    /// Owned diagnostic accepted from existing setup/offline APIs.
    ///
    /// Realtime implementations must use [`Self::Backend`] so constructing an
    /// error never allocates on the callback thread.
    #[error("processor {processor} failed during {operation}: {message}")]
    Owned {
        /// Processor reporting the setup/offline failure.
        processor: &'static str,
        /// Operation that failed.
        operation: &'static str,
        /// Owned diagnostic retained for non-realtime callers.
        message: String,
    },
}

pub(crate) fn validate_processor_channels(
    processor: &'static str,
    expected_channels: Option<usize>,
    actual_channels: usize,
) -> Result<(), ProcessError> {
    if let Some(expected_channels) = expected_channels {
        if expected_channels != actual_channels {
            return Err(ProcessError::ChannelCountMismatch {
                processor,
                expected_channels,
                actual_channels,
            });
        }
    }
    Ok(())
}

pub(crate) fn validate_sample_rate_hz(
    processor: &'static str,
    sample_rate_hz: u32,
) -> Result<(), ProcessError> {
    if sample_rate_hz == 0 {
        return Err(ProcessError::InvalidSampleRate {
            processor,
            sample_rate_hz,
        });
    }
    Ok(())
}

/// Unified object-safe streaming DSP lifecycle.
///
/// [`Self::latency`] and finite [`Self::tail`] values carry their own sample-rate
/// domains. A chain converts every duration to its final output rate, sums the
/// fractional frame values, then rounds once: nearest for latency compensation
/// and ceiling for finite-tail preservation.
pub trait StreamingProcessor: Send {
    /// Stable processor name for diagnostics outside the realtime path.
    fn name(&self) -> &'static str;

    /// Consume input and produce output using caller-owned storage.
    ///
    /// Chain/direct drivers should call [`process_checked`] so progress bounds,
    /// in-place 1:1 behavior, and forward progress are centrally enforced.
    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError>;

    /// Produce remaining algorithm delay/effect tail after the final input.
    ///
    /// Implementations must be idempotent: once this returns `Finished`, all
    /// later calls produce zero frames and remain `Finished` until
    /// [`Self::reset`]. Processing new input before reset returns
    /// [`ProcessError::AlreadyFinished`]. Drivers should call [`finish_checked`].
    fn finish(&mut self, _output: AudioBlockMut<'_>) -> Result<ProcessProgress, ProcessError> {
        Ok(ProcessProgress::finished(0))
    }

    /// Clear all Rust and native backend state before a logically new stream.
    fn reset(&mut self) -> Result<(), ProcessError>;

    /// Algorithmic delay, excluding semantic effect tail.
    fn latency(&self) -> FrameDuration {
        FrameDuration::ZERO
    }

    /// Semantic effect tail after the last input frame.
    fn tail(&self) -> TailSpec {
        TailSpec::None
    }

    /// Mark a terminal transform whose output must be excluded from unknown
    /// tail energy observation (for example, dither/noise shaping). The chain
    /// observes immediately before the first such stage and still forwards the
    /// resulting tail through it.
    fn tail_energy_observation_barrier(&self) -> bool {
        false
    }

    /// Map the current graph rate through this stage.
    ///
    /// Fixed-rate processors keep the input rate. A resampler overrides this
    /// method and returns its configured output rate.
    fn output_sample_rate_hz(&self, input_sample_rate_hz: u32) -> Result<u32, ProcessError> {
        if input_sample_rate_hz == 0 {
            return Err(ProcessError::InvalidSampleRate {
                processor: self.name(),
                sample_rate_hz: input_sample_rate_hz,
            });
        }
        Ok(input_sample_rate_hz)
    }

    /// Update sample rate and any dependent coefficients on a non-realtime path.
    fn set_sample_rate(&mut self, _sample_rate_hz: u32) -> Result<(), ProcessError> {
        Ok(())
    }
}

/// A processor whose process path is valid for fixed in-place 1:1 execution.
///
/// Implementors must consume and produce the complete block when called with
/// [`ProcessBuffers::in_place`] and must preserve the input sample-rate domain.
/// [`crate::processor::DspChain`] requires this capability explicitly because
/// it owns no variable-I/O scratch storage. Rate conversion and other buffered
/// transforms belong in a driver that owns suitable caller-visible buffers.
///
/// `StreamingResampler` intentionally does not implement this trait, even for
/// configurations whose input and output rates happen to match:
///
/// ```compile_fail
/// use audio_engine_core::{DspChain, StreamingResampler};
///
/// # fn insert(mut chain: DspChain, resampler: StreamingResampler) {
/// chain.add(resampler).unwrap();
/// # }
/// ```
pub trait FixedInPlaceProcessor: StreamingProcessor {}

/// Drive one process call and enforce the shared progress invariants.
pub fn process_checked<P: StreamingProcessor + ?Sized>(
    processor: &mut P,
    buffers: ProcessBuffers<'_>,
) -> Result<ProcessProgress, ProcessError> {
    let capacity = buffers.capacity();
    let progress = processor.process(buffers)?;
    capacity.validate(processor.name(), progress)
}

/// Drive one finish call and enforce terminal lifecycle invariants.
pub fn finish_checked<P: StreamingProcessor + ?Sized>(
    processor: &mut P,
    output: AudioBlockMut<'_>,
) -> Result<ProcessProgress, ProcessError> {
    let capacity = ProcessCapacity::for_finish(output.frames());
    let progress = processor.finish(output)?;
    capacity.validate(processor.name(), progress)
}

#[cfg(test)]
mod tests;
