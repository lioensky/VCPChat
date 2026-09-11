//! Canonical output render-chain definition and builders.
//!
//! Setup code may allocate while it materializes processors. The realtime
//! invariant applies to the returned [`DspChain::process`] path.

use std::sync::Arc;

use crate::config::{PhaseResponse, ResampleQuality};

use super::adapters::{
    ConvolverControl, ConvolverProcessor, CrossfeedProcessor, DynamicLoudnessProcessor,
    EqProcessor, NoiseShaperProcessor, NoiseShaperSnapshotLatch, PeakLimiterProcessor,
    SaturationProcessor, VolumeProcessor,
};
use super::dsp_chain::DspChain;
use super::lockfree_params::{
    AtomicCrossfeedParams, AtomicDynamicLoudnessParams, AtomicDynamicLoudnessTelemetry,
    AtomicEqParams, AtomicNoiseShaperParams, AtomicPeakLimiterParams, AtomicSaturationParams,
    AtomicVolumeParams,
};
use super::resampler::StreamingResampler;
use super::traits::{
    finish_checked, process_checked, AudioBlockMut, AudioBlockRef, FrameDuration, FrameRounding,
    ProcessBuffers, ProcessError, ProcessProgress, ProcessState, StreamingProcessor, TailSpec,
    TimingError,
};

const DEFAULT_OFFLINE_BLOCK_FRAMES: usize = 4_096;

fn process_fixed_stage<P: StreamingProcessor + ?Sized>(
    processor: &mut P,
    buffer: &mut [f64],
    channels: usize,
) -> Result<ProcessProgress, ProcessError> {
    let block = AudioBlockMut::new(buffer, channels)?;
    process_checked(processor, ProcessBuffers::in_place(block))
}

/// Timeline treatment applied after a complete offline finalize.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RenderTimeline {
    /// Remove accumulated algorithmic latency while preserving semantic tails.
    #[default]
    Compensated,
    /// Retain the causal leading delay and all finalize output.
    RawCausal,
}

/// Termination policy for processors whose semantic tail is not finite.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UnknownTailPolicy {
    /// Per-frame RMS energy threshold in dBFS, measured before noise shaping.
    pub energy_threshold_dbfs: f64,
    /// Required continuous below-threshold duration.
    pub silence_hold_ms: u32,
    /// Hard upper bound on generated unknown tail duration.
    pub max_tail_ms: u32,
}

impl Default for UnknownTailPolicy {
    fn default() -> Self {
        Self {
            energy_threshold_dbfs: -120.0,
            silence_hold_ms: 250,
            max_tail_ms: 30_000,
        }
    }
}

/// Policy for complete offline rendering.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct OfflineRenderPolicy {
    /// Whether rendered output retains or compensates algorithmic latency.
    pub timeline: RenderTimeline,
    /// Stop conditions for processors whose tail duration is not finite.
    pub unknown_tail: UnknownTailPolicy,
}

impl OfflineRenderPolicy {
    /// Return a policy that retains causal algorithmic latency in the output.
    pub fn raw_causal() -> Self {
        Self {
            timeline: RenderTimeline::RawCausal,
            ..Self::default()
        }
    }

    fn validate(self) -> Result<Self, ProcessError> {
        if !self.unknown_tail.energy_threshold_dbfs.is_finite()
            || self.unknown_tail.energy_threshold_dbfs > 0.0
        {
            return Err(ProcessError::InvalidRenderPolicy {
                message: "energy threshold must be finite and no greater than 0 dBFS",
            });
        }
        if self.unknown_tail.silence_hold_ms == 0 {
            return Err(ProcessError::InvalidRenderPolicy {
                message: "silence hold must be greater than zero",
            });
        }
        if self.unknown_tail.max_tail_ms < self.unknown_tail.silence_hold_ms {
            return Err(ProcessError::InvalidRenderPolicy {
                message: "maximum tail must be at least the silence hold duration",
            });
        }
        Ok(self)
    }
}

struct OfflineStageOutput {
    samples: Vec<f64>,
    #[cfg(test)]
    unknown_finish_capped: bool,
}

#[derive(Default)]
struct RenderTiming {
    latencies: Vec<FrameDuration>,
    finite_tails: Vec<FrameDuration>,
    has_unknown_tail: bool,
}

impl RenderTiming {
    fn observe_values(&mut self, latency: FrameDuration, tail: TailSpec) {
        self.latencies.push(latency);
        match tail {
            TailSpec::None => {}
            TailSpec::Finite(duration) => self.finite_tails.push(duration),
            TailSpec::Unknown | TailSpec::Infinite => self.has_unknown_tail = true,
        }
    }

    fn latency_frames(&self, sample_rate_hz: u32) -> Result<usize, ProcessError> {
        rounded_duration_sum(&self.latencies, sample_rate_hz, FrameRounding::Nearest)
            .map_err(Into::into)
    }

    fn finite_tail_frames(&self, sample_rate_hz: u32) -> Result<usize, ProcessError> {
        rounded_duration_sum(&self.finite_tails, sample_rate_hz, FrameRounding::Ceil)
            .map_err(Into::into)
    }
}

fn rounded_duration_sum(
    durations: &[FrameDuration],
    sample_rate_hz: u32,
    rounding: FrameRounding,
) -> Result<usize, TimingError> {
    let mut total = 0.0;
    for duration in durations {
        total += duration.frames_at_rate_f64(sample_rate_hz)?;
    }
    let rounded = match rounding {
        FrameRounding::Floor => total.floor(),
        FrameRounding::Nearest => (total + 0.5).floor(),
        FrameRounding::Ceil => total.ceil(),
    };
    if !rounded.is_finite() || rounded < 0.0 || rounded > usize::MAX as f64 {
        return Err(TimingError::FrameCountOverflow);
    }
    Ok(rounded as usize)
}

fn checked_frame_sum(left: usize, right: usize) -> Result<usize, TimingError> {
    left.checked_add(right)
        .ok_or(TimingError::FrameCountOverflow)
}

fn frames_for_milliseconds(milliseconds: u32, sample_rate_hz: u32) -> Result<usize, TimingError> {
    if sample_rate_hz == 0 {
        return Err(TimingError::ZeroSampleRate);
    }
    let numerator = milliseconds as u128 * sample_rate_hz as u128;
    usize::try_from(numerator.div_ceil(1_000)).map_err(|_| TimingError::FrameCountOverflow)
}

struct TailEnergyDetector {
    energy_threshold: f64,
    hold_frames: usize,
    below_frames: usize,
    silence_start_frame: usize,
}

impl TailEnergyDetector {
    fn new(policy: UnknownTailPolicy, sample_rate_hz: u32) -> Result<Self, TimingError> {
        let amplitude_threshold = 10.0_f64.powf(policy.energy_threshold_dbfs / 20.0);
        Ok(Self {
            energy_threshold: amplitude_threshold * amplitude_threshold,
            hold_frames: frames_for_milliseconds(policy.silence_hold_ms, sample_rate_hz)?.max(1),
            below_frames: 0,
            silence_start_frame: 0,
        })
    }

    fn observe(&mut self, samples: &[f64], channels: usize, first_frame: usize) -> Option<usize> {
        for (offset, frame) in samples.chunks_exact(channels).enumerate() {
            let frame_energy =
                frame.iter().map(|sample| sample * sample).sum::<f64>() / channels as f64;
            if frame_energy <= self.energy_threshold {
                if self.below_frames == 0 {
                    self.silence_start_frame = first_frame + offset;
                }
                self.below_frames += 1;
                if self.below_frames >= self.hold_frames {
                    return Some(self.silence_start_frame);
                }
            } else {
                self.below_frames = 0;
            }
        }
        None
    }
}

struct TailObservation {
    detector: TailEnergyDetector,
    protected_frames: usize,
    generated_frames: usize,
    max_frames: usize,
    stopped: bool,
    capped: bool,
}

struct ObservationDecision {
    keep_frames: usize,
    truncate_to_frame: Option<usize>,
}

impl TailObservation {
    fn new(
        policy: UnknownTailPolicy,
        sample_rate_hz: u32,
        protected_frames: usize,
    ) -> Result<Self, ProcessError> {
        Ok(Self {
            detector: TailEnergyDetector::new(policy, sample_rate_hz)?,
            protected_frames,
            generated_frames: 0,
            max_frames: frames_for_milliseconds(policy.max_tail_ms, sample_rate_hz)?,
            stopped: false,
            capped: false,
        })
    }

    fn observe(
        &mut self,
        samples: &[f64],
        channels: usize,
        first_frame: usize,
    ) -> ObservationDecision {
        if self.stopped {
            return ObservationDecision {
                keep_frames: 0,
                truncate_to_frame: None,
            };
        }

        let frames = samples.len() / channels;
        let protected = self.protected_frames.min(frames);
        self.protected_frames -= protected;
        let available = frames - protected;
        let allowed = available.min(self.max_frames.saturating_sub(self.generated_frames));
        let keep_frames = protected + allowed;

        let mut truncate_to_frame = None;
        if allowed > 0 {
            let start = protected * channels;
            let end = (protected + allowed) * channels;
            truncate_to_frame =
                self.detector
                    .observe(&samples[start..end], channels, first_frame + protected);
            self.generated_frames = self.generated_frames.saturating_add(allowed);
        }

        if truncate_to_frame.is_some() {
            self.stopped = true;
        } else if self.generated_frames >= self.max_frames {
            self.stopped = true;
            self.capped = true;
        }
        ObservationDecision {
            keep_frames,
            truncate_to_frame,
        }
    }

    fn remaining_capacity_frames(&self) -> usize {
        if self.stopped {
            0
        } else {
            self.protected_frames
                .saturating_add(self.max_frames.saturating_sub(self.generated_frames))
        }
    }
}

struct OutputBlockCollector<'a> {
    channels: usize,
    limiter: &'a mut PeakLimiterProcessor,
    noise_shaper: &'a mut NoiseShaperProcessor,
    samples: Vec<f64>,
    observation: Option<TailObservation>,
    tail_truncated: bool,
}

impl<'a> OutputBlockCollector<'a> {
    fn new(
        channels: usize,
        limiter: &'a mut PeakLimiterProcessor,
        noise_shaper: &'a mut NoiseShaperProcessor,
        estimated_samples: usize,
    ) -> Self {
        Self {
            channels,
            limiter,
            noise_shaper,
            samples: Vec::with_capacity(estimated_samples),
            observation: None,
            tail_truncated: false,
        }
    }

    fn begin_observation(
        &mut self,
        policy: UnknownTailPolicy,
        sample_rate_hz: u32,
        protected_frames: usize,
    ) -> Result<(), ProcessError> {
        self.observation = Some(TailObservation::new(
            policy,
            sample_rate_hz,
            protected_frames,
        )?);
        Ok(())
    }

    fn observation_stopped(&self) -> bool {
        self.observation
            .as_ref()
            .is_some_and(|observation| observation.stopped)
    }

    fn observation_active(&self) -> bool {
        self.observation.is_some()
    }

    fn observation_capacity_frames(&self, requested: usize) -> usize {
        self.observation
            .as_ref()
            .map(|observation| requested.min(observation.remaining_capacity_frames()))
            .unwrap_or(requested)
    }

    fn end_observation(&mut self) {
        if let Some(observation) = self.observation.take() {
            self.tail_truncated |= observation.capped;
        }
    }

    fn mark_tail_truncated(&mut self) {
        self.tail_truncated = true;
    }

    fn push_pre_limiter(&mut self, block: &mut [f64]) -> Result<(), ProcessError> {
        let total_frames = block.len() / self.channels;
        let mut processed_frames = 0usize;
        while processed_frames < total_frames && !self.observation_stopped() {
            let remaining = total_frames - processed_frames;
            let frames = self.observation_capacity_frames(remaining);
            if frames == 0 {
                break;
            }
            let start = processed_frames * self.channels;
            let end = start + frames * self.channels;
            let chunk = &mut block[start..end];
            let _ = process_fixed_stage(self.limiter, chunk, self.channels)?;
            self.push_post_limiter(chunk)?;
            processed_frames += frames;
        }
        Ok(())
    }

    fn push_post_limiter(&mut self, block: &mut [f64]) -> Result<(), ProcessError> {
        if self.observation_stopped() {
            return Ok(());
        }
        let frames = block.len() / self.channels;
        let first_frame = self.samples.len() / self.channels;
        let decision = self
            .observation
            .as_mut()
            .map(|observation| observation.observe(block, self.channels, first_frame))
            .unwrap_or(ObservationDecision {
                keep_frames: frames,
                truncate_to_frame: None,
            });

        let keep_samples = decision.keep_frames * self.channels;
        if keep_samples > 0 {
            let retained = &mut block[..keep_samples];
            let _ = process_fixed_stage(self.noise_shaper, retained, self.channels)?;
            self.samples
                .extend(retained.iter().map(|sample| *sample as f32 as f64));
        }
        if let Some(frame) = decision.truncate_to_frame {
            self.samples.truncate(frame * self.channels);
        }
        Ok(())
    }

    fn finish_limiter(
        &mut self,
        scratch: &mut [f64],
        frame_limit: usize,
    ) -> Result<(), ProcessError> {
        let mut generated = 0usize;
        loop {
            if generated >= frame_limit {
                return Err(ProcessError::Backend {
                    processor: "PeakLimiter",
                    operation: "finish",
                    message: "limiter finish exceeded its declared bound",
                });
            }
            let capacity = (scratch.len() / self.channels).min(frame_limit - generated);
            let block =
                AudioBlockMut::new(&mut scratch[..capacity * self.channels], self.channels)?;
            let progress = finish_checked(self.limiter, block)?;
            let produced = progress.produced_frames();
            self.push_post_limiter(&mut scratch[..produced * self.channels])?;
            generated += produced;
            if progress.state() == ProcessState::Finished {
                break;
            }
        }
        Ok(())
    }

    fn finish_noise_shaper(&mut self) -> Result<(), ProcessError> {
        let mut empty = [];
        let block = AudioBlockMut::new(&mut empty, self.channels)?;
        let progress = finish_checked(self.noise_shaper, block)?;
        if progress.state() != ProcessState::Finished || progress.produced_frames() != 0 {
            return Err(ProcessError::Backend {
                processor: "NoiseShaper",
                operation: "finish",
                message: "terminal noise shaper produced unexpected output",
            });
        }
        Ok(())
    }

    fn into_output(mut self) -> (Vec<f64>, bool) {
        self.end_observation();
        (self.samples, self.tail_truncated)
    }
}

struct RateBoundary<'a> {
    channels: usize,
    resampler: Option<&'a mut StreamingResampler>,
    scratch: Vec<f64>,
    input_frames_seen: usize,
}

impl<'a> RateBoundary<'a> {
    fn new(
        channels: usize,
        resampler: Option<&'a mut StreamingResampler>,
        block_frames: usize,
    ) -> Result<Self, ProcessError> {
        let samples = block_frames
            .checked_mul(channels)
            .ok_or(TimingError::FrameCountOverflow)?;
        Ok(Self {
            channels,
            resampler,
            scratch: vec![0.0; samples],
            input_frames_seen: 0,
        })
    }

    fn push(
        &mut self,
        source: &mut [f64],
        collector: &mut OutputBlockCollector<'_>,
    ) -> Result<(), ProcessError> {
        let Some(resampler) = self.resampler.as_mut() else {
            return collector.push_pre_limiter(source);
        };
        let input = AudioBlockRef::new(source, self.channels)?;
        let mut consumed = 0usize;
        while consumed < input.frames() && !collector.observation_stopped() {
            let input_start = consumed * self.channels;
            let input_view = AudioBlockRef::new(&source[input_start..], self.channels)?;
            let capacity_frames = collector
                .observation_capacity_frames(self.scratch.len() / self.channels)
                .max(1);
            let output_view = AudioBlockMut::new(
                &mut self.scratch[..capacity_frames * self.channels],
                self.channels,
            )?;
            let progress = process_checked(
                *resampler,
                ProcessBuffers::out_of_place(input_view, output_view)?,
            )?;
            let produced = progress.produced_frames();
            collector.push_pre_limiter(&mut self.scratch[..produced * self.channels])?;
            let step_consumed = progress.consumed_frames();
            consumed += step_consumed;
            self.input_frames_seen = checked_frame_sum(self.input_frames_seen, step_consumed)?;
        }
        Ok(())
    }

    fn finish_frame_limit(
        &self,
        policy: OfflineRenderPolicy,
        block_frames: usize,
    ) -> Result<usize, ProcessError> {
        let Some(resampler) = self.resampler.as_ref() else {
            return Ok(1);
        };
        finish_frame_limit(
            self.input_frames_seen,
            resampler.from_rate(),
            resampler.to_rate(),
            resampler.latency(),
            resampler.tail(),
            policy,
            block_frames,
        )
    }

    fn finish(
        &mut self,
        collector: &mut OutputBlockCollector<'_>,
        frame_limit: usize,
    ) -> Result<(), ProcessError> {
        let Some(resampler) = self.resampler.as_mut() else {
            return Ok(());
        };
        let mut generated = 0usize;
        loop {
            if generated >= frame_limit {
                return Err(ProcessError::Backend {
                    processor: "Resampler",
                    operation: "finish",
                    message: "resampler finish exceeded its declared bound",
                });
            }
            let capacity = (self.scratch.len() / self.channels).min(frame_limit - generated);
            let output =
                AudioBlockMut::new(&mut self.scratch[..capacity * self.channels], self.channels)?;
            let progress = finish_checked(*resampler, output)?;
            let produced = progress.produced_frames();
            collector.push_pre_limiter(&mut self.scratch[..produced * self.channels])?;
            generated += produced;
            if progress.state() == ProcessState::Finished {
                break;
            }
        }
        Ok(())
    }
}

fn finish_frame_limit(
    input_frames: usize,
    input_sample_rate_hz: u32,
    output_sample_rate_hz: u32,
    latency: FrameDuration,
    tail: TailSpec,
    policy: OfflineRenderPolicy,
    block_frames: usize,
) -> Result<usize, ProcessError> {
    let converted_input = FrameDuration::new(input_frames, input_sample_rate_hz)?
        .rounded_frames_at_rate(output_sample_rate_hz, FrameRounding::Ceil)?;
    let latency_frames =
        latency.rounded_frames_at_rate(output_sample_rate_hz, FrameRounding::Ceil)?;
    let finite_tail_frames = tail
        .finite_duration()
        .map(|duration| duration.rounded_frames_at_rate(output_sample_rate_hz, FrameRounding::Ceil))
        .transpose()?
        .unwrap_or(0);

    let declared = checked_frame_sum(latency_frames, finite_tail_frames)?;
    let limit = match tail {
        TailSpec::Unknown | TailSpec::Infinite => checked_frame_sum(
            frames_for_milliseconds(policy.unknown_tail.max_tail_ms, output_sample_rate_hz)?,
            latency_frames,
        )?,
        TailSpec::None | TailSpec::Finite(_) => {
            checked_frame_sum(checked_frame_sum(converted_input, declared)?, block_frames)?
        }
    };
    Ok(limit.max(1))
}

fn drive_offline_stage(
    processor: &mut dyn StreamingProcessor,
    input: &[f64],
    channels: usize,
    input_sample_rate_hz: u32,
    policy: OfflineRenderPolicy,
    block_frames: usize,
) -> Result<OfflineStageOutput, ProcessError> {
    if block_frames == 0 {
        return Err(ProcessError::InvalidRenderPolicy {
            message: "offline block size must be greater than zero",
        });
    }

    let input_block = AudioBlockRef::new(input, channels)?;
    processor.set_sample_rate(input_sample_rate_hz)?;
    let output_sample_rate_hz = processor.output_sample_rate_hz(input_sample_rate_hz)?;
    let scratch_samples = block_frames
        .checked_mul(channels)
        .ok_or(TimingError::FrameCountOverflow)?;
    let mut scratch = vec![0.0; scratch_samples];
    let mut samples = Vec::with_capacity(input.len());
    let mut consumed_frames = 0;

    while consumed_frames < input_block.frames() {
        let input_start = consumed_frames * channels;
        let input_view = AudioBlockRef::new(&input[input_start..], channels)?;
        let output_view = AudioBlockMut::new(&mut scratch, channels)?;
        let buffers = ProcessBuffers::out_of_place(input_view, output_view)?;
        let progress = process_checked(processor, buffers)?;
        let produced_samples = progress.produced_frames() * channels;
        samples.extend_from_slice(&scratch[..produced_samples]);
        consumed_frames += progress.consumed_frames();
    }

    let latency = processor.latency();
    let tail = processor.tail();
    let unknown_tail = matches!(tail, TailSpec::Unknown | TailSpec::Infinite);
    let finish_limit = finish_frame_limit(
        input_block.frames(),
        input_sample_rate_hz,
        output_sample_rate_hz,
        latency,
        tail,
        policy,
        block_frames,
    )?;
    let protected_finish_frames = if unknown_tail {
        latency.rounded_frames_at_rate(output_sample_rate_hz, FrameRounding::Ceil)?
    } else {
        0
    };
    let mut tail_detector = if unknown_tail {
        Some(TailEnergyDetector::new(
            policy.unknown_tail,
            output_sample_rate_hz,
        )?)
    } else {
        None
    };
    let mut finish_frames = 0;
    let mut terminal = false;
    let mut energy_stopped = false;

    while finish_frames < finish_limit {
        let capacity_frames = block_frames.min(finish_limit - finish_frames);
        let output_view = AudioBlockMut::new(&mut scratch[..capacity_frames * channels], channels)?;
        let progress = finish_checked(processor, output_view)?;
        let produced_frames = progress.produced_frames();
        let produced_samples = produced_frames * channels;
        let appended_start_frame = samples.len() / channels;
        samples.extend_from_slice(&scratch[..produced_samples]);
        if let Some(detector) = tail_detector.as_mut() {
            let inspect_start = protected_finish_frames
                .saturating_sub(finish_frames)
                .min(produced_frames);
            if inspect_start < produced_frames {
                let inspect_samples = &scratch[inspect_start * channels..produced_samples];
                if let Some(silence_start_frame) = detector.observe(
                    inspect_samples,
                    channels,
                    appended_start_frame + inspect_start,
                ) {
                    samples.truncate(silence_start_frame * channels);
                    energy_stopped = true;
                }
            }
        }
        finish_frames += produced_frames;
        if progress.state() == ProcessState::Finished {
            terminal = true;
        }
        if terminal || energy_stopped {
            break;
        }
    }

    if !terminal && !unknown_tail {
        return Err(ProcessError::Backend {
            processor: processor.name(),
            operation: "finish",
            message: "finite finish exceeded its declared safety bound",
        });
    }

    Ok(OfflineStageOutput {
        samples,
        #[cfg(test)]
        unknown_finish_capped: !terminal && !energy_stopped && unknown_tail,
    })
}

#[cfg(test)]
fn trim_unknown_tail_before_dither(
    samples: &mut Vec<f64>,
    channels: usize,
    protected_frames: usize,
    sample_rate_hz: u32,
    policy: UnknownTailPolicy,
    finish_was_capped: bool,
) -> Result<bool, ProcessError> {
    let total_frames = samples.len() / channels;
    let scan_start = protected_frames.min(total_frames);
    let mut detector = TailEnergyDetector::new(policy, sample_rate_hz)?;
    if let Some(silence_start) =
        detector.observe(&samples[scan_start * channels..], channels, scan_start)
    {
        samples.truncate(silence_start * channels);
    }

    Ok(finish_was_capped)
}

/// Invoke a consumer with the canonical render-stage manifest.
///
/// Roles are semantic boundaries: source-rate transforms run before the
/// optional rate boundary, output-rate transforms run after tail trimming, and
/// terminal transforms run after the final output-rate processor.
macro_rules! output_stage_manifest {
    ($consumer:ident $(, $arg:ident)*) => {
        $consumer! {
            ($($arg),*);
            (
                volume,
                Volume,
                "Volume",
                source,
                yes,
                true,
                false,
                "gain smoothing state, no algorithmic delay"
            ),
            (
                eq,
                Equalizer,
                "Equalizer",
                source,
                yes,
                true,
                false,
                "IIR state, no explicit output delay"
            ),
            (
                saturation,
                Saturation,
                "Saturation",
                source,
                yes,
                true,
                true,
                "armed Direct/2x/4x paths share four source frames of delay; hard bypass is zero latency"
            ),
            (
                crossfeed,
                Crossfeed,
                "Crossfeed",
                source,
                yes,
                true,
                false,
                "biquad state, no explicit output delay"
            ),
            (
                convolver,
                Convolver,
                "Convolver",
                source,
                yes,
                true,
                false,
                "zero-latency convolution head with IR-dependent finite semantic tail"
            ),
            (
                dynamic_loudness,
                DynamicLoudness,
                "DynamicLoudness",
                source,
                yes,
                true,
                false,
                "filter and smoother state, no explicit output delay"
            ),
            (
                resampler,
                Resampler,
                "Resampler",
                rate_boundary,
                no,
                true,
                false,
                "duration-aligned Rubato finish compensates backend delay and preserves exact output duration"
            ),
            (
                limiter,
                PeakLimiter,
                "PeakLimiter",
                output,
                yes,
                true,
                true,
                "single final-float-domain lookahead limiter at the active output rate"
            ),
            (
                noise_shaper,
                NoiseShaper,
                "NoiseShaper",
                output,
                yes,
                true,
                false,
                "error-feedback state, no explicit output delay"
            ),
            (
                quantize,
                Quantize,
                "Quantize",
                terminal,
                no,
                false,
                false,
                "final sample-format reduction"
            ),
        }
    };
}

macro_rules! callback_flag {
    (yes) => {
        true
    };
    (no) => {
        false
    };
}

macro_rules! build_output_stage_descriptors {
    (
        ($($arg:ident),*);
        $((
            $field:ident,
            $id:ident,
            $name:literal,
            $role:ident,
            $callback:ident,
            $carries_state:literal,
            $introduces_latency:literal,
            $latency_note:literal
        )),+ $(,)?
    ) => {
        &[
            $(OutputStageDescriptor {
                id: OutputStageId::$id,
                name: $name,
                callback_stage: callback_flag!($callback),
                offline_render_stage: true,
                carries_state: $carries_state,
                introduces_latency: $introduces_latency,
                latency_note: $latency_note,
            }),+
        ]
    };
}

macro_rules! callback_stage_count {
    (
        ($($arg:ident),*);
        $((
            $field:ident,
            $id:ident,
            $name:literal,
            $role:ident,
            $callback:ident,
            $carries_state:literal,
            $introduces_latency:literal,
            $latency_note:literal
        )),+ $(,)?
    ) => {
        0usize $(+ callback_stage_count_one!($callback))+
    };
}

macro_rules! callback_stage_count_one {
    (yes) => {
        1usize
    };
    (no) => {
        0usize
    };
}

/// Canonical signal-transform stage identifiers for the output chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OutputStageId {
    /// Lock-free gain smoothing stage.
    Volume,
    /// Ten-band equalizer stage.
    Equalizer,
    /// Nonlinear saturation stage.
    Saturation,
    /// Stereo crossfeed stage.
    Crossfeed,
    /// Dynamically published FIR convolution stage.
    Convolver,
    /// Level-dependent equal-loudness compensation stage.
    DynamicLoudness,
    /// Peak or true-peak limiting stage.
    PeakLimiter,
    /// Sample-rate conversion stage.
    Resampler,
    /// Quantization-error feedback stage.
    NoiseShaper,
    /// Final sample-depth quantization stage.
    Quantize,
}

/// Static metadata for one executed output-chain stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputStageDescriptor {
    /// Stable programmatic stage identifier.
    pub id: OutputStageId,
    /// Human-readable stage name.
    pub name: &'static str,
    /// Whether the realtime callback chain executes this stage.
    pub callback_stage: bool,
    /// Whether complete offline rendering executes this stage.
    pub offline_render_stage: bool,
    /// Whether results depend on history from earlier frames.
    pub carries_state: bool,
    /// Whether the stage contributes algorithmic latency.
    pub introduces_latency: bool,
    /// Static explanation of the stage's latency behavior.
    pub latency_note: &'static str,
}

/// Analysis that consumes rendered output without changing its samples.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PostRenderAnalysisId {
    /// EBU R128 loudness and true-peak measurement over final samples.
    LoudnessMeterTruePeak,
}

/// Static metadata for an opt-in post-render analysis.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PostRenderAnalysisDescriptor {
    /// Stable programmatic analysis identifier.
    pub id: PostRenderAnalysisId,
    /// Human-readable analysis name.
    pub name: &'static str,
    /// Static explanation of the measurements performed.
    pub analysis_note: &'static str,
}

const OUTPUT_STAGE_DESCRIPTORS: &[OutputStageDescriptor] =
    output_stage_manifest!(build_output_stage_descriptors);
const CALLBACK_STAGE_COUNT: usize = output_stage_manifest!(callback_stage_count);
const POST_RENDER_ANALYSIS_DESCRIPTORS: &[PostRenderAnalysisDescriptor] =
    &[PostRenderAnalysisDescriptor {
        id: PostRenderAnalysisId::LoudnessMeterTruePeak,
        name: "LoudnessMeterTruePeak",
        analysis_note: "opt-in EBU R128 true-peak analysis over final rendered samples",
    }];

/// Full canonical signal-transform order.
pub fn canonical_output_stage_descriptors() -> &'static [OutputStageDescriptor] {
    OUTPUT_STAGE_DESCRIPTORS
}

/// Canonical post-render analyses, separate from signal transforms.
pub fn canonical_post_render_analysis_descriptors() -> &'static [PostRenderAnalysisDescriptor] {
    POST_RENDER_ANALYSIS_DESCRIPTORS
}

/// Callback-safe stage names in canonical order.
pub fn callback_stage_names() -> Vec<&'static str> {
    OUTPUT_STAGE_DESCRIPTORS
        .iter()
        .filter(|stage| stage.callback_stage)
        .map(|stage| stage.name)
        .collect()
}

/// Offline render-stage names in canonical execution order.
pub fn offline_render_stage_names() -> Vec<&'static str> {
    OUTPUT_STAGE_DESCRIPTORS
        .iter()
        .filter(|stage| stage.offline_render_stage)
        .map(|stage| stage.name)
        .collect()
}

/// Post-render analysis names in canonical reporting order.
pub fn post_render_analysis_names() -> Vec<&'static str> {
    POST_RENDER_ANALYSIS_DESCRIPTORS
        .iter()
        .map(|analysis| analysis.name)
        .collect()
}

/// CSV snapshot of callback-safe stage names, for benchmark output.
pub fn callback_stage_order_csv() -> String {
    callback_stage_names().join(",")
}

/// CSV snapshot of actual offline render stages, for reports.
pub fn offline_render_stage_order_csv() -> String {
    offline_render_stage_names().join(",")
}

/// CSV snapshot of opt-in post-render analyses, for reports.
pub fn post_render_analysis_order_csv() -> String {
    post_render_analysis_names().join(",")
}

macro_rules! add_callback_stage {
    ($chain:ident, $params:ident, $rate:ident, $latch:ident, (volume, $($rest:tt)*)) => {
        $chain.add(VolumeProcessor::new(Arc::clone(&$params.volume_params)))?;
    };
    ($chain:ident, $params:ident, $rate:ident, $latch:ident, (eq, $($rest:tt)*)) => {
        $chain.add(EqProcessor::new(
            $params.channels,
            $rate as f64,
            Arc::clone(&$params.eq_params),
        ))?;
    };
    ($chain:ident, $params:ident, $rate:ident, $latch:ident, (saturation, $($rest:tt)*)) => {
        $chain.add(SaturationProcessor::new(
            $params.channels,
            Arc::clone(&$params.saturation_params),
        ))?;
    };
    ($chain:ident, $params:ident, $rate:ident, $latch:ident, (crossfeed, $($rest:tt)*)) => {
        $chain.add(CrossfeedProcessor::new(
            $rate as f64,
            Arc::clone(&$params.crossfeed_params),
        ))?;
    };
    ($chain:ident, $params:ident, $rate:ident, $latch:ident, (convolver, $($rest:tt)*)) => {
        $chain.add(ConvolverProcessor::new($params.convolver_control.clone())?)?;
    };
    ($chain:ident, $params:ident, $rate:ident, $latch:ident, (dynamic_loudness, $($rest:tt)*)) => {
        $chain.add(DynamicLoudnessProcessor::new(
            $params.channels,
            $rate,
            Arc::clone(&$params.dynamic_loudness_params),
            Arc::clone(&$params.dynamic_loudness_telemetry),
        )?)?;
    };
    ($chain:ident, $params:ident, $rate:ident, $latch:ident, (limiter, $($rest:tt)*)) => {
        $chain.add(PeakLimiterProcessor::new_with_output_guard_latch(
            $params.channels,
            $rate,
            Arc::clone(&$params.limiter_params),
            Arc::clone(&$params.noise_shaper_params),
            $latch.clone(),
        )?)?;
    };
    ($chain:ident, $params:ident, $rate:ident, $latch:ident, (resampler, $($rest:tt)*)) => {};
    ($chain:ident, $params:ident, $rate:ident, $latch:ident, (noise_shaper, $($rest:tt)*)) => {
        $chain.add(NoiseShaperProcessor::new_with_output_guard_latch(
            $params.channels,
            $rate,
            Arc::clone(&$params.noise_shaper_params),
            $latch.clone(),
        )?)?;
    };
    ($chain:ident, $params:ident, $rate:ident, $latch:ident, (quantize, $($rest:tt)*)) => {};
}

macro_rules! build_callback_stages {
    (($chain:ident, $params:ident, $rate:ident, $latch:ident); $($entry:tt),+ $(,)?) => {
        $(add_callback_stage!($chain, $params, $rate, $latch, $entry);)+
    };
}

macro_rules! process_pre_quantize_stage {
    ($chain:ident, $buffer:ident, ($field:ident, $id:ident, $name:literal, source, $($rest:tt)*)) => {
        let _ = process_fixed_stage(&mut $chain.$field, $buffer, $chain.channels)?;
    };
    ($chain:ident, $buffer:ident, ($field:ident, $id:ident, $name:literal, rate_boundary, $($rest:tt)*)) => {
        if let Some(processor) = $chain.$field.as_mut() {
            let rendered = drive_offline_stage(
                processor,
                $buffer,
                $chain.channels,
                $chain.source_sample_rate,
                OfflineRenderPolicy::default(),
                DEFAULT_OFFLINE_BLOCK_FRAMES,
            )?;
            *$buffer = rendered.samples;
        }
    };
    ($chain:ident, $buffer:ident, ($field:ident, $id:ident, $name:literal, output, $($rest:tt)*)) => {
        let _ = process_fixed_stage(&mut $chain.$field, $buffer, $chain.channels)?;
    };
    ($chain:ident, $buffer:ident, ($field:ident, $id:ident, $name:literal, terminal, $($rest:tt)*)) => {};
}

macro_rules! process_pre_quantize_stages {
    (($chain:ident, $buffer:ident); $($entry:tt),+ $(,)?) => {
        $(process_pre_quantize_stage!($chain, $buffer, $entry);)+
    };
}

macro_rules! reset_render_stage {
    ($chain:ident, $reset:ident, ($field:ident, $id:ident, $name:literal, source, $($rest:tt)*)) => {
        $reset!(&mut $chain.$field);
    };
    ($chain:ident, $reset:ident, ($field:ident, $id:ident, $name:literal, rate_boundary, $($rest:tt)*)) => {
        if let Some(processor) = $chain.$field.as_mut() {
            $reset!(processor);
        }
    };
    ($chain:ident, $reset:ident, ($field:ident, $id:ident, $name:literal, output, $($rest:tt)*)) => {
        $reset!(&mut $chain.$field);
    };
    ($chain:ident, $reset:ident, ($field:ident, $id:ident, $name:literal, terminal, $($rest:tt)*)) => {};
}

macro_rules! reset_render_stages {
    (($chain:ident, $reset:ident); $($entry:tt),+ $(,)?) => {
        $(reset_render_stage!($chain, $reset, $entry);)+
    };
}

macro_rules! set_source_rate_stage {
    ($chain:ident, $rate:ident, ($field:ident, $id:ident, $name:literal, source, $($rest:tt)*)) => {
        $chain.$field.set_sample_rate($rate)?;
    };
    ($chain:ident, $rate:ident, ($field:ident, $id:ident, $name:literal, rate_boundary, $($rest:tt)*)) => {};
    ($chain:ident, $rate:ident, ($field:ident, $id:ident, $name:literal, output, $($rest:tt)*)) => {};
    ($chain:ident, $rate:ident, ($field:ident, $id:ident, $name:literal, terminal, $($rest:tt)*)) => {};
}

macro_rules! set_source_rate_stages {
    (($chain:ident, $rate:ident); $($entry:tt),+ $(,)?) => {
        $(set_source_rate_stage!($chain, $rate, $entry);)+
    };
}

macro_rules! process_source_stage {
    ($pipeline:ident, $buffer:ident, ($field:ident, $id:ident, $name:literal, source, $($rest:tt)*)) => {
        let _ = process_fixed_stage($pipeline.$field, $buffer, $pipeline.channels)?;
    };
    ($pipeline:ident, $buffer:ident, ($field:ident, $id:ident, $name:literal, rate_boundary, $($rest:tt)*)) => {};
    ($pipeline:ident, $buffer:ident, ($field:ident, $id:ident, $name:literal, output, $($rest:tt)*)) => {};
    ($pipeline:ident, $buffer:ident, ($field:ident, $id:ident, $name:literal, terminal, $($rest:tt)*)) => {};
}

macro_rules! process_source_stages {
    (($pipeline:ident, $buffer:ident); $($entry:tt),+ $(,)?) => {
        $(process_source_stage!($pipeline, $buffer, $entry);)+
    };
}

macro_rules! process_source_stage_after {
    ($pipeline:ident, $buffer:ident, $target:ident, $found:ident, ($field:ident, $id:ident, $name:literal, source, $($rest:tt)*)) => {
        if $found {
            let _ = process_fixed_stage($pipeline.$field, $buffer, $pipeline.channels)?;
        } else if $target == OutputStageId::$id {
            $found = true;
        }
    };
    ($pipeline:ident, $buffer:ident, $target:ident, $found:ident, ($field:ident, $id:ident, $name:literal, rate_boundary, $($rest:tt)*)) => {};
    ($pipeline:ident, $buffer:ident, $target:ident, $found:ident, ($field:ident, $id:ident, $name:literal, output, $($rest:tt)*)) => {};
    ($pipeline:ident, $buffer:ident, $target:ident, $found:ident, ($field:ident, $id:ident, $name:literal, terminal, $($rest:tt)*)) => {};
}

macro_rules! process_source_stages_after {
    (($pipeline:ident, $buffer:ident, $target:ident, $found:ident); $($entry:tt),+ $(,)?) => {
        $(process_source_stage_after!($pipeline, $buffer, $target, $found, $entry);)+
    };
}

macro_rules! finish_source_stage {
    ($pipeline:ident, $target:ident, $scratch:ident, ($field:ident, $id:ident, $name:literal, source, $($rest:tt)*)) => {
        if $target == OutputStageId::$id {
            let output = AudioBlockMut::new($scratch, $pipeline.channels)?;
            return finish_checked($pipeline.$field, output);
        }
    };
    ($pipeline:ident, $target:ident, $scratch:ident, ($field:ident, $id:ident, $name:literal, rate_boundary, $($rest:tt)*)) => {};
    ($pipeline:ident, $target:ident, $scratch:ident, ($field:ident, $id:ident, $name:literal, output, $($rest:tt)*)) => {};
    ($pipeline:ident, $target:ident, $scratch:ident, ($field:ident, $id:ident, $name:literal, terminal, $($rest:tt)*)) => {};
}

macro_rules! finish_selected_source_stage {
    (($pipeline:ident, $target:ident, $scratch:ident); $($entry:tt),+ $(,)?) => {
        $(finish_source_stage!($pipeline, $target, $scratch, $entry);)+
    };
}

macro_rules! collect_source_stage_timing {
    ($pipeline:ident, $timings:ident, ($field:ident, $id:ident, $name:literal, source, $($rest:tt)*)) => {
        $timings.extend([SourceStageTiming {
            id: OutputStageId::$id,
            name: $name,
            timing: ProcessorTiming {
                latency: $pipeline.$field.latency(),
                tail: $pipeline.$field.tail(),
            },
        }]);
    };
    ($pipeline:ident, $timings:ident, ($field:ident, $id:ident, $name:literal, rate_boundary, $($rest:tt)*)) => {};
    ($pipeline:ident, $timings:ident, ($field:ident, $id:ident, $name:literal, output, $($rest:tt)*)) => {};
    ($pipeline:ident, $timings:ident, ($field:ident, $id:ident, $name:literal, terminal, $($rest:tt)*)) => {};
}

macro_rules! collect_source_stage_timings {
    (($pipeline:ident, $timings:ident); $($entry:tt),+ $(,)?) => {
        $(collect_source_stage_timing!($pipeline, $timings, $entry);)+
    };
}

#[derive(Clone, Copy)]
struct ProcessorTiming {
    latency: FrameDuration,
    tail: TailSpec,
}

#[derive(Clone, Copy)]
struct SourceStageTiming {
    id: OutputStageId,
    name: &'static str,
    timing: ProcessorTiming,
}

struct SourcePipeline<'a> {
    channels: usize,
    volume: &'a mut VolumeProcessor,
    eq: &'a mut EqProcessor,
    saturation: &'a mut SaturationProcessor,
    crossfeed: &'a mut CrossfeedProcessor,
    convolver: &'a mut ConvolverProcessor,
    dynamic_loudness: &'a mut DynamicLoudnessProcessor,
}

impl SourcePipeline<'_> {
    fn process_all(&mut self, buffer: &mut [f64]) -> Result<(), ProcessError> {
        let pipeline = self;
        output_stage_manifest!(process_source_stages, pipeline, buffer);
        Ok(())
    }

    fn process_after(
        &mut self,
        target: OutputStageId,
        buffer: &mut [f64],
    ) -> Result<(), ProcessError> {
        let pipeline = self;
        let mut found = false;
        output_stage_manifest!(process_source_stages_after, pipeline, buffer, target, found);
        if !found {
            return Err(ProcessError::Backend {
                processor: "OutputRenderChain",
                operation: "process source tail",
                message: "source finish stage is absent from the canonical manifest",
            });
        }
        Ok(())
    }

    fn finish(
        &mut self,
        target: OutputStageId,
        scratch: &mut [f64],
    ) -> Result<ProcessProgress, ProcessError> {
        let pipeline = self;
        output_stage_manifest!(finish_selected_source_stage, pipeline, target, scratch);
        Err(ProcessError::Backend {
            processor: "OutputRenderChain",
            operation: "finish source stage",
            message: "source finish stage is absent from the canonical manifest",
        })
    }

    fn timings(&self) -> Vec<SourceStageTiming> {
        let pipeline = self;
        let mut timings = Vec::with_capacity(6);
        output_stage_manifest!(collect_source_stage_timings, pipeline, timings);
        timings
    }
}

fn append_protected_durations(durations: &mut Vec<FrameDuration>, timing: ProcessorTiming) {
    durations.push(timing.latency);
    if let TailSpec::Finite(tail) = timing.tail {
        durations.push(tail);
    }
}

fn protected_output_frames(
    source_timings: &[SourceStageTiming],
    source_index: usize,
    rate_boundary_timing: ProcessorTiming,
    limiter_timing: ProcessorTiming,
    noise_shaper_timing: ProcessorTiming,
    output_sample_rate_hz: u32,
) -> Result<usize, ProcessError> {
    let remaining = source_timings.len().saturating_sub(source_index);
    let mut durations = Vec::with_capacity(remaining.saturating_mul(2).saturating_add(6));
    for stage in &source_timings[source_index..] {
        append_protected_durations(&mut durations, stage.timing);
    }
    append_protected_durations(&mut durations, rate_boundary_timing);
    append_protected_durations(&mut durations, limiter_timing);
    append_protected_durations(&mut durations, noise_shaper_timing);
    rounded_duration_sum(&durations, output_sample_rate_hz, FrameRounding::Ceil).map_err(Into::into)
}

fn source_finish_frame_limit(
    timing: ProcessorTiming,
    protected_frames: usize,
    source_sample_rate_hz: u32,
    output_sample_rate_hz: u32,
    policy: OfflineRenderPolicy,
    block_frames: usize,
) -> Result<usize, ProcessError> {
    let latency_frames = timing
        .latency
        .rounded_frames_at_rate(source_sample_rate_hz, FrameRounding::Ceil)?;
    let finite_tail_frames = timing
        .tail
        .finite_duration()
        .map(|duration| duration.rounded_frames_at_rate(source_sample_rate_hz, FrameRounding::Ceil))
        .transpose()?
        .unwrap_or(0);
    let declared = checked_frame_sum(latency_frames, finite_tail_frames)?;
    let limit = match timing.tail {
        TailSpec::Unknown | TailSpec::Infinite => {
            let max_tail =
                frames_for_milliseconds(policy.unknown_tail.max_tail_ms, source_sample_rate_hz)?;
            let protected = FrameDuration::new(protected_frames, output_sample_rate_hz)?
                .rounded_frames_at_rate(source_sample_rate_hz, FrameRounding::Ceil)?;
            checked_frame_sum(checked_frame_sum(max_tail, protected)?, block_frames)?
        }
        TailSpec::None | TailSpec::Finite(_) => checked_frame_sum(declared, block_frames)?,
    };
    Ok(limit.max(1))
}

/// All parameter and control handles required to materialize an output chain.
///
/// Cloning this value clones its control handles. Each simultaneously live
/// callback or render chain must nevertheless receive a distinct
/// [`ConvolverControl`], because that control has exactly one audio consumer.
#[derive(Clone)]
pub struct OutputChainParams {
    /// Number of interleaved channels processed by the chain.
    pub channels: usize,
    /// Final output-device sample rate in hertz.
    pub output_sample_rate: u32,
    /// Shared equalizer parameter snapshot.
    pub eq_params: Arc<AtomicEqParams>,
    /// Shared saturation parameter snapshot.
    pub saturation_params: Arc<AtomicSaturationParams>,
    /// Shared crossfeed parameter snapshot.
    pub crossfeed_params: Arc<AtomicCrossfeedParams>,
    /// Single-consumer convolver publication handle.
    pub convolver_control: ConvolverControl,
    /// Shared volume parameter snapshot.
    pub volume_params: Arc<AtomicVolumeParams>,
    /// Shared dynamic-loudness parameter snapshot.
    pub dynamic_loudness_params: Arc<AtomicDynamicLoudnessParams>,
    /// Lock-free sink for dynamic-loudness telemetry.
    pub dynamic_loudness_telemetry: Arc<AtomicDynamicLoudnessTelemetry>,
    /// Shared peak-limiter parameter snapshot.
    pub limiter_params: Arc<AtomicPeakLimiterParams>,
    /// Shared noise-shaper parameter snapshot.
    pub noise_shaper_params: Arc<AtomicNoiseShaperParams>,
}

/// Builder for realtime and offline output chains.
#[derive(Clone)]
pub struct OutputChainBuilder {
    params: OutputChainParams,
}

impl OutputChainBuilder {
    /// Create a builder around validated-on-build control handles and geometry.
    pub fn new(params: OutputChainParams) -> Self {
        Self { params }
    }

    /// Return the configured callback channel count.
    pub const fn channels(&self) -> usize {
        self.params.channels
    }

    /// Return the device/output sample rate used by the callback chain.
    pub const fn output_sample_rate_hz(&self) -> u32 {
        self.params.output_sample_rate
    }

    /// Return the control-plane handle retained across processor type erasure.
    ///
    /// A control may have multiple control-thread clones, but callers must not
    /// keep more than one callback/render chain built from it alive at once.
    pub fn convolver_control(&self) -> ConvolverControl {
        self.params.convolver_control.clone()
    }

    /// Build the callback-safe DSP chain from the canonical callback order.
    ///
    /// The callback chain is built at [`OutputChainParams::output_sample_rate`]
    /// because a device callback delivers buffers in its own domain. Source
    /// rates belong to the offline render operations that own resampling.
    pub fn build_callback_chain(&self) -> Result<DspChain, ProcessError> {
        let params = &self.params;
        if params.output_sample_rate == 0 {
            return Err(ProcessError::InvalidSampleRate {
                processor: "OutputChainBuilder::output_sample_rate",
                sample_rate_hz: 0,
            });
        }
        let sample_rate_hz = self.params.output_sample_rate;
        let noise_latch = NoiseShaperSnapshotLatch::new(params.noise_shaper_params.read());
        let mut chain = DspChain::with_capacity(CALLBACK_STAGE_COUNT, sample_rate_hz)?;
        output_stage_manifest!(
            build_callback_stages,
            chain,
            params,
            sample_rate_hz,
            noise_latch
        );

        chain.set_sample_rate(sample_rate_hz)?;
        Ok(chain)
    }

    /// Build the offline render chain from the canonical offline order.
    ///
    /// `source_sample_rate_hz` names the input buffer's rate domain. Unlike a
    /// callback chain, an offline render chain owns the optional conversion
    /// from that domain to [`OutputChainParams::output_sample_rate`].
    pub fn build_render_chain(
        &self,
        source_sample_rate_hz: u32,
    ) -> Result<OutputRenderChain, ProcessError> {
        OutputRenderChain::new(
            &self.params,
            source_sample_rate_hz,
            OfflineRenderPolicy::default(),
        )
    }

    /// Build an offline chain with an explicit source rate and render policy.
    pub fn build_render_chain_with_policy(
        &self,
        source_sample_rate_hz: u32,
        policy: OfflineRenderPolicy,
    ) -> Result<OutputRenderChain, ProcessError> {
        policy.validate()?;
        OutputRenderChain::new(&self.params, source_sample_rate_hz, policy)
    }
}

/// Render result after the full offline output chain.
pub struct RenderedOutput {
    /// Complete interleaved output samples.
    pub samples: Vec<f64>,
    /// Limiter gain reduction in decibels at the end of rendering.
    pub final_limiter_gain_reduction_db: f64,
    /// Derived internal headroom below the user-facing true-peak ceiling.
    pub final_limiter_ceiling_guard_db: f64,
    /// Final frame count after optional latency compensation.
    pub rendered_frames: usize,
    /// Algorithmic latency removed in compensated mode, or retained in raw mode.
    pub algorithmic_latency_frames: usize,
    /// Accumulated finite semantic tail preserved at the final output rate.
    pub semantic_tail_frames: usize,
    /// True only when an unknown/infinite tail hit its configured safety limit.
    pub tail_truncated: bool,
}

struct ConvolverReclaimer(ConvolverControl);

impl ConvolverReclaimer {
    fn reclaim(&self) {
        let _ = self.0.reclaim_retired();
    }
}

impl Drop for ConvolverReclaimer {
    fn drop(&mut self) {
        self.reclaim();
    }
}

/// Offline output renderer. It shares the canonical stage order with the
/// realtime builder, and inserts the resampler before final noise shaping when
/// the render target rate differs from the source rate.
pub struct OutputRenderChain {
    channels: usize,
    source_sample_rate: u32,
    output_sample_rate: u32,
    volume: VolumeProcessor,
    eq: EqProcessor,
    saturation: SaturationProcessor,
    crossfeed: CrossfeedProcessor,
    convolver: ConvolverProcessor,
    dynamic_loudness: DynamicLoudnessProcessor,
    limiter: PeakLimiterProcessor,
    resampler: Option<StreamingResampler>,
    noise_shaper: NoiseShaperProcessor,
    default_policy: OfflineRenderPolicy,
}

impl OutputRenderChain {
    fn new(
        params: &OutputChainParams,
        source_sample_rate_hz: u32,
        default_policy: OfflineRenderPolicy,
    ) -> Result<Self, ProcessError> {
        // The offline chain uses both rates, so both are rejected here rather
        // than surfacing as an inner stage's error with a misleading owner.
        if source_sample_rate_hz == 0 {
            return Err(ProcessError::InvalidSampleRate {
                processor: "OutputRenderChain::source_sample_rate",
                sample_rate_hz: 0,
            });
        }
        if params.output_sample_rate == 0 {
            return Err(ProcessError::InvalidSampleRate {
                processor: "OutputRenderChain::output_sample_rate",
                sample_rate_hz: 0,
            });
        }
        let source_sample_rate = source_sample_rate_hz as f64;
        let noise_latch = NoiseShaperSnapshotLatch::new(params.noise_shaper_params.read());
        let resampler = if source_sample_rate_hz == params.output_sample_rate {
            None
        } else {
            Some(
                StreamingResampler::with_quality(
                    params.channels,
                    source_sample_rate_hz,
                    params.output_sample_rate,
                    PhaseResponse::Linear,
                    ResampleQuality::UltraHigh,
                )
                .map_err(|error| ProcessError::Owned {
                    processor: "OutputRenderChain",
                    operation: "create resampler",
                    message: format!(
                        "{}->{} Hz: {error}",
                        source_sample_rate_hz, params.output_sample_rate,
                    ),
                })?,
            )
        };

        let mut chain = Self {
            channels: params.channels,
            source_sample_rate: source_sample_rate_hz,
            output_sample_rate: params.output_sample_rate,
            volume: VolumeProcessor::new(Arc::clone(&params.volume_params)),
            eq: EqProcessor::new(
                params.channels,
                source_sample_rate,
                Arc::clone(&params.eq_params),
            ),
            saturation: SaturationProcessor::new(
                params.channels,
                Arc::clone(&params.saturation_params),
            ),
            crossfeed: CrossfeedProcessor::new(
                source_sample_rate,
                Arc::clone(&params.crossfeed_params),
            ),
            convolver: ConvolverProcessor::new(params.convolver_control.clone())?,
            dynamic_loudness: DynamicLoudnessProcessor::new(
                params.channels,
                source_sample_rate_hz,
                Arc::clone(&params.dynamic_loudness_params),
                Arc::clone(&params.dynamic_loudness_telemetry),
            )?,
            limiter: PeakLimiterProcessor::new_with_output_guard_latch(
                params.channels,
                params.output_sample_rate,
                Arc::clone(&params.limiter_params),
                Arc::clone(&params.noise_shaper_params),
                noise_latch.clone(),
            )?,
            resampler,
            noise_shaper: NoiseShaperProcessor::new_with_output_guard_latch(
                params.channels,
                params.output_sample_rate,
                Arc::clone(&params.noise_shaper_params),
                noise_latch,
            )?,
            default_policy,
        };

        chain.set_source_sample_rate(source_sample_rate_hz)?;
        chain
            .noise_shaper
            .set_sample_rate(params.output_sample_rate)?;
        Ok(chain)
    }

    /// Process through the offline output chain up to final sample-format
    /// quantization. This is useful for parity tests against the callback chain
    /// when `source_sample_rate == output_sample_rate`.
    pub fn process_pre_quantize(&mut self, buffer: &mut Vec<f64>) -> Result<(), ProcessError> {
        let reclaimer = ConvolverReclaimer(self.convolver.control());
        reclaimer.reclaim();
        output_stage_manifest!(process_pre_quantize_stages, self, buffer);
        reclaimer.reclaim();
        Ok(())
    }

    /// Render samples through DSP, optional resampling, final noise shaping, and
    /// f32 output quantization.
    pub fn render(&mut self, samples: &[f64]) -> Result<RenderedOutput, ProcessError> {
        self.render_with_policy(samples, self.default_policy)
    }

    /// Render with an explicit timeline and unknown-tail policy.
    pub fn render_with_policy(
        &mut self,
        samples: &[f64],
        policy: OfflineRenderPolicy,
    ) -> Result<RenderedOutput, ProcessError> {
        self.render_with_policy_and_block_frames(samples, policy, DEFAULT_OFFLINE_BLOCK_FRAMES)
    }

    /// Render with an explicit bounded scheduler block size.
    ///
    /// Smaller blocks reduce scratch memory and increase scheduling overhead;
    /// the signal and lifecycle result remain block-size independent.
    pub fn render_with_policy_and_block_frames(
        &mut self,
        samples: &[f64],
        policy: OfflineRenderPolicy,
        block_frames: usize,
    ) -> Result<RenderedOutput, ProcessError> {
        if block_frames == 0 {
            return Err(ProcessError::InvalidRenderPolicy {
                message: "offline block size must be greater than zero",
            });
        }

        let reclaimer = ConvolverReclaimer(self.convolver.control());
        reclaimer.reclaim();
        let policy = policy.validate()?;
        let source_block = AudioBlockRef::new(samples, self.channels)?;
        let source_frames = source_block.frames();
        self.reset_for_render()?;
        let channels = self.channels;
        let source_sample_rate_hz = self.source_sample_rate;
        let output_sample_rate_hz = self.output_sample_rate;
        let boundary_output_rate = self
            .resampler
            .as_ref()
            .map(|resampler| resampler.output_sample_rate_hz(source_sample_rate_hz))
            .transpose()?
            .unwrap_or(source_sample_rate_hz);
        if boundary_output_rate != output_sample_rate_hz {
            return Err(ProcessError::SampleRateMismatch {
                processor: "OutputRenderChain",
                expected_sample_rate_hz: output_sample_rate_hz,
                actual_sample_rate_hz: boundary_output_rate,
            });
        }

        let scratch_samples = block_frames
            .checked_mul(channels)
            .ok_or(TimingError::FrameCountOverflow)?;
        let nominal_output_frames = FrameDuration::new(source_frames, source_sample_rate_hz)?
            .rounded_frames_at_rate(output_sample_rate_hz, FrameRounding::Ceil)?;
        let mut timing = RenderTiming::default();

        let (mut output, tail_truncated) = {
            let mut source_scratch = vec![0.0; scratch_samples];
            {
                let mut sync_pipeline = SourcePipeline {
                    channels,
                    volume: &mut self.volume,
                    eq: &mut self.eq,
                    saturation: &mut self.saturation,
                    crossfeed: &mut self.crossfeed,
                    convolver: &mut self.convolver,
                    dynamic_loudness: &mut self.dynamic_loudness,
                };
                // Zero-frame calls publish current control snapshots without
                // advancing signal history, including for an empty render.
                sync_pipeline.process_all(&mut source_scratch[..0])?;
            }
            let _ = process_fixed_stage(&mut self.limiter, &mut source_scratch[..0], channels)?;
            let _ =
                process_fixed_stage(&mut self.noise_shaper, &mut source_scratch[..0], channels)?;
            // A new offline stream starts settled at the snapshots just
            // published above, rather than ramping from the previous render.
            self.reset_for_render()?;

            let mut source_pipeline = SourcePipeline {
                channels,
                volume: &mut self.volume,
                eq: &mut self.eq,
                saturation: &mut self.saturation,
                crossfeed: &mut self.crossfeed,
                convolver: &mut self.convolver,
                dynamic_loudness: &mut self.dynamic_loudness,
            };
            let mut boundary = RateBoundary::new(channels, self.resampler.as_mut(), block_frames)?;

            let source_timings = source_pipeline.timings();
            let rate_boundary_timing = boundary
                .resampler
                .as_deref()
                .map(|processor| ProcessorTiming {
                    latency: processor.latency(),
                    tail: processor.tail(),
                })
                .unwrap_or(ProcessorTiming {
                    latency: FrameDuration::ZERO,
                    tail: TailSpec::None,
                });
            let limiter_timing = ProcessorTiming {
                latency: self.limiter.latency(),
                tail: self.limiter.tail(),
            };
            let noise_shaper_timing = ProcessorTiming {
                latency: self.noise_shaper.latency(),
                tail: self.noise_shaper.tail(),
            };

            for stage in &source_timings {
                timing.observe_values(stage.timing.latency, stage.timing.tail);
            }
            timing.observe_values(rate_boundary_timing.latency, rate_boundary_timing.tail);
            timing.observe_values(limiter_timing.latency, limiter_timing.tail);
            timing.observe_values(noise_shaper_timing.latency, noise_shaper_timing.tail);

            let latency_reserve = rounded_duration_sum(
                &timing.latencies,
                output_sample_rate_hz,
                FrameRounding::Ceil,
            )?;
            let finite_tail_reserve = timing.finite_tail_frames(output_sample_rate_hz)?;
            let unknown_hold_reserve = if timing.has_unknown_tail {
                frames_for_milliseconds(policy.unknown_tail.silence_hold_ms, output_sample_rate_hz)?
            } else {
                0
            };
            let estimated_frames = checked_frame_sum(
                checked_frame_sum(
                    checked_frame_sum(nominal_output_frames, latency_reserve)?,
                    finite_tail_reserve,
                )?,
                unknown_hold_reserve,
            )?;
            let estimated_samples = estimated_frames
                .checked_mul(channels)
                .ok_or(TimingError::FrameCountOverflow)?;
            let mut collector = OutputBlockCollector::new(
                channels,
                &mut self.limiter,
                &mut self.noise_shaper,
                estimated_samples,
            );

            for input in samples.chunks(scratch_samples) {
                let block = &mut source_scratch[..input.len()];
                block.copy_from_slice(input);
                source_pipeline.process_all(block)?;
                boundary.push(block, &mut collector)?;
            }

            for (source_index, stage) in source_timings.iter().enumerate() {
                let unknown_tail =
                    matches!(stage.timing.tail, TailSpec::Unknown | TailSpec::Infinite);
                if unknown_tail && collector.observation_stopped() {
                    continue;
                }

                let protected_frames = if unknown_tail {
                    protected_output_frames(
                        &source_timings,
                        source_index,
                        rate_boundary_timing,
                        limiter_timing,
                        noise_shaper_timing,
                        output_sample_rate_hz,
                    )?
                } else {
                    0
                };
                let started_observation = unknown_tail && !collector.observation_active();
                if started_observation {
                    collector.begin_observation(
                        policy.unknown_tail,
                        output_sample_rate_hz,
                        protected_frames,
                    )?;
                }

                let frame_limit = source_finish_frame_limit(
                    stage.timing,
                    protected_frames,
                    source_sample_rate_hz,
                    output_sample_rate_hz,
                    policy,
                    block_frames,
                )?;
                let mut generated_frames = 0usize;
                let mut terminal = false;
                let mut policy_stopped = false;
                loop {
                    if unknown_tail && collector.observation_stopped() {
                        policy_stopped = true;
                        break;
                    }
                    if generated_frames >= frame_limit {
                        break;
                    }

                    let capacity_frames = block_frames.min(frame_limit - generated_frames);
                    let block = &mut source_scratch[..capacity_frames * channels];
                    let progress = source_pipeline.finish(stage.id, block)?;
                    let produced_frames = progress.produced_frames();
                    if produced_frames > 0 {
                        let produced = &mut block[..produced_frames * channels];
                        source_pipeline.process_after(stage.id, produced)?;
                        boundary.push(produced, &mut collector)?;
                    }
                    generated_frames = checked_frame_sum(generated_frames, produced_frames)?;
                    if progress.state() == ProcessState::Finished {
                        terminal = true;
                        break;
                    }
                }

                let source_cap_reached =
                    unknown_tail && !terminal && !policy_stopped && generated_frames >= frame_limit;
                if source_cap_reached {
                    // A rate boundary can retain the last source-domain tail
                    // frames until its own finish call. Reaching the bounded
                    // source budget is therefore a policy truncation, not a
                    // backend failure; downstream stages still need draining.
                    collector.mark_tail_truncated();
                } else if !terminal && !policy_stopped {
                    return Err(ProcessError::Backend {
                        processor: stage.name,
                        operation: "finish",
                        message: "source stage finish exceeded its safety bound",
                    });
                }
                if started_observation && terminal && !collector.observation_stopped() {
                    collector.end_observation();
                }
            }

            let resampler_finish_limit = boundary.finish_frame_limit(policy, block_frames)?;
            boundary.finish(&mut collector, resampler_finish_limit)?;

            let limiter_finish_limit = finish_frame_limit(
                0,
                output_sample_rate_hz,
                output_sample_rate_hz,
                limiter_timing.latency,
                limiter_timing.tail,
                policy,
                block_frames,
            )?;
            collector.finish_limiter(&mut boundary.scratch, limiter_finish_limit)?;
            collector.finish_noise_shaper()?;
            collector.into_output()
        };

        let latency_frames = timing.latency_frames(output_sample_rate_hz)?;
        let semantic_tail_frames = timing.finite_tail_frames(output_sample_rate_hz)?;

        if policy.timeline == RenderTimeline::Compensated {
            let trim_frames = latency_frames.min(output.len() / channels);
            let trim_samples = trim_frames * channels;
            output.copy_within(trim_samples.., 0);
            output.truncate(output.len() - trim_samples);
        }

        let rendered_frames = output.len() / channels;
        reclaimer.reclaim();

        Ok(RenderedOutput {
            samples: output,
            final_limiter_gain_reduction_db: self.limiter.gain_reduction_db(),
            final_limiter_ceiling_guard_db: self.limiter.output_ceiling_guard_db(),
            rendered_frames,
            algorithmic_latency_frames: latency_frames,
            semantic_tail_frames,
            tail_truncated,
        })
    }

    /// Return the limiter's current gain reduction in decibels.
    pub fn limiter_gain_reduction_db(&self) -> f64 {
        self.limiter.gain_reduction_db()
    }

    /// Return the internal headroom below the public limiter ceiling.
    pub fn limiter_output_ceiling_guard_db(&self) -> f64 {
        self.limiter.output_ceiling_guard_db()
    }

    fn reset_for_render(&mut self) -> Result<(), ProcessError> {
        let mut first_error = None;
        macro_rules! reset_stage {
            ($processor:expr) => {
                if let Err(error) = $processor.reset() {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            };
        }

        output_stage_manifest!(reset_render_stages, self, reset_stage);

        first_error.map_or(Ok(()), Err)
    }

    fn set_source_sample_rate(&mut self, sample_rate_hz: u32) -> Result<(), ProcessError> {
        output_stage_manifest!(set_source_rate_stages, self, sample_rate_hz);
        Ok(())
    }
}

#[cfg(test)]
mod tests;
