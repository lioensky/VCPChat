//! DSP Processing Chain
//!
//! Manages a collection of audio processors in a pipeline.
//! Provides:
//! - Guaranteed continuous processing (no lock-induced skips)
//! - Unified statistics and debugging
//! - Easy dynamic configuration
//!
//! # Architecture
//!
//! ```text
//! Input Buffer
//!      │
//!      ▼
//! ┌─────────────────────────────────────────────────────┐
//! │                    DspChain                          │
//! │                                                      │
//! │  ┌──────────┐   ┌──────────┐   ┌──────────┐        │
//! │  │    EQ    │ → │ Saturation│ → │ Crossfeed│ → ...  │
//! │  └──────────┘   └──────────┘   └──────────┘        │
//! │                                                      │
//! │  Each processor:                                     │
//! │  - Reads lock-free params                           │
//! │  - Processes without blocking                       │
//! │  - Never skips due to contention                    │
//! │                                                      │
//! └─────────────────────────────────────────────────────┘
//!      │
//!      ▼
//! Output Buffer
//! ```

use super::traits::{
    finish_checked, process_checked, validate_sample_rate_hz, AudioBlockMut, FixedInPlaceProcessor,
    FrameDuration, ProcessBuffers, ProcessError, ProcessProgress, ProcessState, StreamingProcessor,
    TailSpec,
};

/// Policy used by [`DspChain::finish`] for processors with asymptotic tails.
///
/// The policy is copied into the chain on the first finish call. Keeping the
/// values in frames makes the callback path independent of wall-clock units and
/// avoids per-call allocation or policy object ownership.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChainFinishPolicy {
    /// RMS level below which generated tail frames count as silent.
    pub energy_threshold_dbfs: f64,
    /// Consecutive below-threshold frames required before finishing.
    pub silence_hold_frames: usize,
    /// Hard limit on frames generated for an unknown or infinite tail.
    pub max_tail_frames: usize,
}

impl ChainFinishPolicy {
    /// Construct a finish policy from frame-domain limits.
    pub const fn new(
        energy_threshold_dbfs: f64,
        silence_hold_frames: usize,
        max_tail_frames: usize,
    ) -> Self {
        Self {
            energy_threshold_dbfs,
            silence_hold_frames,
            max_tail_frames,
        }
    }

    /// Reject a policy that cannot bound a tail.
    ///
    /// Exposed to the crate so a builder can reject a preset before any DSP
    /// state exists; the first [`DspChain::finish_with_policy`] call still
    /// validates, because a chain can also be driven directly.
    pub(crate) fn validate(self) -> Result<Self, ProcessError> {
        if !self.energy_threshold_dbfs.is_finite() || self.energy_threshold_dbfs > 0.0 {
            return Err(ProcessError::InvalidRenderPolicy {
                message: "chain finish energy threshold must be finite and no greater than 0 dBFS",
            });
        }
        if self.silence_hold_frames == 0 {
            return Err(ProcessError::InvalidRenderPolicy {
                message: "chain finish silence hold must be greater than zero",
            });
        }
        if self.max_tail_frames < self.silence_hold_frames {
            return Err(ProcessError::InvalidRenderPolicy {
                message: "chain finish maximum tail must be at least the silence hold",
            });
        }
        Ok(self)
    }

    fn threshold_power(self) -> f64 {
        // RMS dBFS is power-domain; no input-dependent work occurs here.
        10.0_f64.powf(self.energy_threshold_dbfs / 10.0)
    }
}

impl Default for ChainFinishPolicy {
    fn default() -> Self {
        Self::new(-120.0, 12_000, 1_440_000)
    }
}

/// DSP processing chain
///
/// Manages multiple audio processors in sequence.
/// All processors share the same buffer, processed in-place.
///
/// # Accepted processor class
///
/// The chain drives one fixed in-place 1:1 topology at a single sample rate. It
/// owns no variable-rate scratch buffer, by design: allocating one would break
/// the callback's allocation-free contract. [`Self::add`] therefore only accepts
/// a [`FixedInPlaceProcessor`], and defensively verifies that the stage maps the
/// chain rate to itself, so incompatible geometry is rejected at build time
/// instead of failing inside the audio callback. The offline
/// [`OutputRenderChain`](super::output_chain::OutputRenderChain) owns the
/// resampler boundary.
pub struct DspChain {
    /// Processors in execution order
    processors: Vec<Box<dyn StreamingProcessor>>,
    sample_rate_hz: u32,
    finish_stage: usize,
    finish_complete: bool,
    finish_policy: Option<ChainFinishPolicy>,
    finish_threshold_power: f64,
    finish_unknown_stage: Option<usize>,
    finish_observation_end_stage: usize,
    finish_protected_frames: usize,
    finish_quiet_frames: usize,
    finish_generated_frames: usize,
    finish_capped: bool,
}

impl DspChain {
    /// Create an empty DSP chain in a valid sample-rate domain.
    pub fn new(sample_rate_hz: u32) -> Result<Self, ProcessError> {
        validate_sample_rate_hz("DspChain", sample_rate_hz)?;
        Ok(Self {
            processors: Vec::new(),
            sample_rate_hz,
            ..Self::empty_state()
        })
    }

    /// Create a chain with pre-allocated capacity in a valid rate domain.
    pub fn with_capacity(capacity: usize, sample_rate_hz: u32) -> Result<Self, ProcessError> {
        validate_sample_rate_hz("DspChain", sample_rate_hz)?;
        Ok(Self {
            processors: Vec::with_capacity(capacity),
            sample_rate_hz,
            ..Self::empty_state()
        })
    }

    const fn empty_state() -> Self {
        Self {
            processors: Vec::new(),
            sample_rate_hz: 0,
            finish_stage: 0,
            finish_complete: false,
            finish_policy: None,
            finish_threshold_power: 0.0,
            finish_unknown_stage: None,
            finish_observation_end_stage: 0,
            finish_protected_frames: 0,
            finish_quiet_frames: 0,
            finish_generated_frames: 0,
            finish_capped: false,
        }
    }

    /// Add a processor to the end of the chain.
    ///
    /// Rejects a processor the chain cannot honor, rather than accepting it and
    /// failing later on the audio thread:
    ///
    /// - a stage that does not map the chain rate to itself, because the chain
    ///   drives a fixed in-place 1:1 topology (see the type-level docs).
    pub fn add<P: FixedInPlaceProcessor + 'static>(
        &mut self,
        processor: P,
    ) -> Result<&mut Self, ProcessError> {
        validate_sample_rate_hz("DspChain", self.sample_rate_hz)?;
        let stage_output_rate = processor.output_sample_rate_hz(self.sample_rate_hz)?;
        if stage_output_rate != self.sample_rate_hz {
            return Err(ProcessError::UnsupportedOperation {
                processor: processor.name(),
                operation: "DspChain::add",
                message: "DspChain drives a fixed in-place 1:1 topology at one rate; a \
                          rate-transforming stage belongs in the offline OutputRenderChain",
            });
        }
        self.processors.push(Box::new(processor));
        Ok(self)
    }

    /// Process audio through all processors
    ///
    /// # Key Properties
    ///
    /// 1. **Continuous**: Never skips processors due to lock contention
    /// 2. **In-place**: Modifies buffer directly
    /// 3. **Lock-free**: All parameter updates use atomic operations
    ///
    /// # Arguments
    ///
    /// * `buffer` - Interleaved audio samples [L, R, L, R, ...]
    /// * `channels` - Number of audio channels
    pub fn process(
        &mut self,
        buffer: &mut [f64],
        channels: usize,
    ) -> Result<ProcessProgress, ProcessError> {
        if self.finish_policy.is_some() || self.finish_stage > 0 || self.finish_complete {
            return Err(ProcessError::AlreadyFinished {
                processor: "DspChain",
            });
        }
        let mut block = AudioBlockMut::new(buffer, channels)?;
        let frames = block.frames();
        let mut all_bypassed = true;

        for processor in &mut self.processors {
            let progress = process_checked(
                processor.as_mut(),
                ProcessBuffers::in_place(block.reborrow()),
            )?;
            all_bypassed &= progress.is_bypassed();
        }

        Ok(
            ProcessProgress::new(frames, frames, ProcessState::NeedInput)
                .with_bypassed(all_bypassed),
        )
    }

    /// Drain the chain's callback-facing tail into caller-owned output.
    ///
    /// Fixed 1:1 downstream stages are applied to each upstream finish block
    /// before it is returned. The loop is bounded by the stage count and the
    /// caller's output capacity; asymptotic tails are stopped by the selected
    /// energy/hold/cap policy.
    pub fn finish(&mut self, output: AudioBlockMut<'_>) -> Result<ProcessProgress, ProcessError> {
        self.finish_with_policy(output, ChainFinishPolicy::default())
    }

    /// Drain with an explicit unknown-tail policy. The first call locks the
    /// policy for the current stream; callers must reset before changing it.
    pub fn finish_with_policy(
        &mut self,
        output: AudioBlockMut<'_>,
        policy: ChainFinishPolicy,
    ) -> Result<ProcessProgress, ProcessError> {
        if self.finish_complete {
            return Ok(ProcessProgress::finished(0));
        }
        if self.finish_policy.is_none() {
            let policy = policy.validate()?;
            self.finish_threshold_power = policy.threshold_power();
            self.finish_policy = Some(policy);
        }

        if self.processors.is_empty() {
            self.finish_complete = true;
            return Ok(ProcessProgress::finished(0));
        }

        let channels = output.channels();
        let capacity = output.frames();
        if capacity == 0 {
            return Ok(ProcessProgress::new(0, 0, ProcessState::NeedOutput));
        }

        let mut output = output;
        let output_samples = output.samples_mut();
        let mut produced_total = 0usize;

        while self.finish_stage < self.processors.len() && produced_total < capacity {
            let stage_index = self.finish_stage;
            let stage_unknown = matches!(
                self.processors[stage_index].tail(),
                TailSpec::Unknown | TailSpec::Infinite
            );
            if stage_unknown && self.finish_unknown_stage != Some(stage_index) {
                self.finish_unknown_stage = Some(stage_index);
                self.finish_observation_end_stage =
                    self.tail_energy_observation_end_stage(stage_index);
                self.finish_protected_frames = self.downstream_finish_protected_frames(
                    stage_index,
                    self.finish_observation_end_stage,
                )?;
                self.finish_quiet_frames = 0;
                self.finish_generated_frames = 0;
            }

            let mut remaining_frames = capacity - produced_total;
            if stage_unknown {
                let policy = self.finish_policy.ok_or(ProcessError::Backend {
                    processor: "DspChain",
                    operation: "finish",
                    message: "finish policy was not initialized",
                })?;
                let remaining_observed = policy
                    .max_tail_frames
                    .saturating_sub(self.finish_generated_frames);
                let remaining_quiet = policy
                    .silence_hold_frames
                    .saturating_sub(self.finish_quiet_frames);
                let allowed = self
                    .finish_protected_frames
                    .saturating_add(remaining_observed.min(remaining_quiet));
                if allowed == 0 {
                    self.finish_capped = true;
                    self.finish_stage += 1;
                    self.finish_unknown_stage = None;
                    self.finish_observation_end_stage = 0;
                    self.finish_protected_frames = 0;
                    self.finish_quiet_frames = 0;
                    self.finish_generated_frames = 0;
                    continue;
                }
                remaining_frames = remaining_frames.min(allowed);
            }
            let start_sample = produced_total * channels;
            let end_sample = start_sample + remaining_frames * channels;
            let finish_progress = {
                let block =
                    AudioBlockMut::new(&mut output_samples[start_sample..end_sample], channels)?;
                finish_checked(self.processors[stage_index].as_mut(), block)?
            };
            let produced = finish_progress.produced_frames();

            if produced > 0 {
                let segment_end = start_sample + produced * channels;
                let mut observation = None;
                if stage_unknown && self.finish_observation_end_stage <= stage_index + 1 {
                    observation = Some(self.observe_finish_energy(
                        &output_samples[start_sample..segment_end],
                        channels,
                        produced,
                    ));
                }
                for downstream_index in (stage_index + 1)..self.processors.len() {
                    if stage_unknown
                        && observation.is_none()
                        && downstream_index == self.finish_observation_end_stage
                    {
                        observation = Some(self.observe_finish_energy(
                            &output_samples[start_sample..segment_end],
                            channels,
                            produced,
                        ));
                    }
                    let block = AudioBlockMut::new(
                        &mut output_samples[start_sample..segment_end],
                        channels,
                    )?;
                    let _ = process_checked(
                        self.processors[downstream_index].as_mut(),
                        ProcessBuffers::in_place(block),
                    )?;
                }

                if stage_unknown {
                    let (quiet, observed_frames) = observation.unwrap_or_else(|| {
                        self.observe_finish_energy(
                            &output_samples[start_sample..segment_end],
                            channels,
                            produced,
                        )
                    });
                    self.finish_generated_frames =
                        self.finish_generated_frames.saturating_add(observed_frames);
                    let policy = match self.finish_policy {
                        Some(policy) => policy,
                        None => {
                            return Err(ProcessError::Backend {
                                processor: "DspChain",
                                operation: "finish",
                                message: "finish policy was not initialized",
                            });
                        }
                    };
                    if quiet || self.finish_generated_frames >= policy.max_tail_frames {
                        self.finish_capped |= !quiet;
                        self.finish_stage += 1;
                        self.finish_unknown_stage = None;
                        self.finish_observation_end_stage = 0;
                        self.finish_protected_frames = 0;
                        self.finish_quiet_frames = 0;
                        self.finish_generated_frames = 0;
                    }
                }
            }

            produced_total += produced;

            if finish_progress.state() == ProcessState::NeedOutput
                && self.finish_stage == stage_index
            {
                // Unknown tails may receive a sub-block bounded by the quiet
                // hold still needed. If signal energy reset the hold, consume
                // another bounded segment while caller capacity remains.
                if produced_total < capacity {
                    continue;
                }
                break;
            }
            if finish_progress.state() == ProcessState::Finished && self.finish_stage == stage_index
            {
                self.finish_stage += 1;
                self.finish_unknown_stage = None;
                self.finish_observation_end_stage = 0;
                self.finish_protected_frames = 0;
                self.finish_quiet_frames = 0;
                self.finish_generated_frames = 0;
            }
        }

        if self.finish_stage >= self.processors.len() {
            self.finish_complete = true;
            return Ok(ProcessProgress::finished(produced_total));
        }
        if produced_total == capacity {
            return Ok(ProcessProgress::new(
                0,
                produced_total,
                ProcessState::NeedOutput,
            ));
        }

        // A zero-output non-terminal stage should not occur under the shared
        // finish contract. Return a typed backend error instead of spinning.
        Err(ProcessError::Backend {
            processor: "DspChain",
            operation: "finish",
            message: "stage made no finish progress",
        })
    }

    fn tail_energy_observation_end_stage(&self, stage_index: usize) -> usize {
        self.processors
            .iter()
            .enumerate()
            .skip(stage_index + 1)
            .find(|(_, processor)| processor.tail_energy_observation_barrier())
            .map(|(index, _)| index)
            .unwrap_or(self.processors.len())
    }

    fn downstream_finish_protected_frames(
        &self,
        stage_index: usize,
        observation_end_stage: usize,
    ) -> Result<usize, ProcessError> {
        let mut total = 0.0;
        for processor in &self.processors[stage_index..observation_end_stage] {
            total += processor
                .latency()
                .frames_at_rate_f64(self.sample_rate_hz)?;
            if let TailSpec::Finite(tail) = processor.tail() {
                total += tail.frames_at_rate_f64(self.sample_rate_hz)?;
            }
        }
        if !total.is_finite() || total < 0.0 || total > usize::MAX as f64 {
            return Err(ProcessError::Backend {
                processor: "DspChain",
                operation: "compose finish timing",
                message: "downstream finish protection exceeds the frame domain",
            });
        }
        Ok(total.ceil() as usize)
    }

    fn observe_finish_energy(
        &mut self,
        samples: &[f64],
        channels: usize,
        frames: usize,
    ) -> (bool, usize) {
        let Some(policy) = self.finish_policy else {
            return (false, 0);
        };
        let protected = self.finish_protected_frames.min(frames);
        self.finish_protected_frames -= protected;
        let observed_frames = frames - protected;
        if observed_frames == 0 {
            return (false, 0);
        }

        for frame in protected..frames {
            let start = frame * channels;
            let end = start + channels;
            let mut power = 0.0;
            for &sample in &samples[start..end] {
                power += sample * sample;
            }
            power /= channels.max(1) as f64;
            if !power.is_finite() || power > self.finish_threshold_power {
                self.finish_quiet_frames = 0;
            } else {
                self.finish_quiet_frames = self.finish_quiet_frames.saturating_add(1);
            }
        }
        (
            self.finish_quiet_frames >= policy.silence_hold_frames,
            observed_frames,
        )
    }

    /// Reset all processors, returning the first error after attempting every stage.
    pub fn reset(&mut self) -> Result<(), ProcessError> {
        let mut first_error = None;
        for processor in &mut self.processors {
            if let Err(error) = processor.reset() {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        self.finish_stage = 0;
        self.finish_complete = false;
        self.finish_policy = None;
        self.finish_threshold_power = 0.0;
        self.finish_unknown_stage = None;
        self.finish_observation_end_stage = 0;
        self.finish_protected_frames = 0;
        self.finish_quiet_frames = 0;
        self.finish_generated_frames = 0;
        self.finish_capped = false;
        first_error.map_or(Ok(()), Err)
    }

    /// Update sample rate for all processors, returning the first stage error.
    pub fn set_sample_rate(&mut self, sample_rate_hz: u32) -> Result<(), ProcessError> {
        if sample_rate_hz == 0 {
            return Err(ProcessError::InvalidSampleRate {
                processor: "DspChain",
                sample_rate_hz,
            });
        }

        let mut first_error = None;
        for processor in &mut self.processors {
            if let Err(error) = processor.set_sample_rate(sample_rate_hz) {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        self.sample_rate_hz = sample_rate_hz;
        self.finish_stage = 0;
        self.finish_complete = false;
        self.finish_policy = None;
        self.finish_threshold_power = 0.0;
        self.finish_unknown_stage = None;
        self.finish_observation_end_stage = 0;
        self.finish_protected_frames = 0;
        self.finish_quiet_frames = 0;
        self.finish_generated_frames = 0;
        self.finish_capped = false;
        first_error.map_or(Ok(()), Err)
    }

    /// Composed algorithmic latency in the chain's fixed sample-rate domain.
    pub fn latency(&self) -> FrameDuration {
        let total = self
            .processors
            .iter()
            .filter_map(|processor| {
                processor
                    .latency()
                    .frames_at_rate_f64(self.sample_rate_hz)
                    .ok()
            })
            .sum::<f64>();
        if !total.is_finite() || total < 0.0 || total == 0.0 || self.sample_rate_hz == 0 {
            return FrameDuration::ZERO;
        }
        match FrameDuration::new(total.round() as usize, self.sample_rate_hz) {
            Ok(duration) => duration,
            Err(_) => FrameDuration::ZERO,
        }
    }

    /// Composed semantic tail. Unknown/infinite tails dominate finite sums.
    pub fn tail(&self) -> TailSpec {
        // A chain with no stages has no tail. Deriving this from the frame
        // arithmetic below would instead report `Unknown` whenever the chain
        // rate is zero, which reads as "an unbounded tail" rather than "nothing
        // to drain".
        if self.processors.is_empty() {
            return TailSpec::None;
        }
        let mut finite_frames = 0.0_f64;
        for processor in &self.processors {
            match processor.tail() {
                TailSpec::None => {}
                TailSpec::Unknown => return TailSpec::Unknown,
                TailSpec::Infinite => return TailSpec::Infinite,
                TailSpec::Finite(duration) => {
                    let Some(frames) = duration
                        .frames_at_rate_f64(self.sample_rate_hz)
                        .ok()
                        .filter(|frames| frames.is_finite() && *frames >= 0.0)
                    else {
                        return TailSpec::Unknown;
                    };
                    finite_frames += frames;
                }
            }
        }
        if !finite_frames.is_finite() || finite_frames > usize::MAX as f64 {
            return TailSpec::Unknown;
        }
        TailSpec::finite(finite_frames.ceil() as usize, self.sample_rate_hz)
            .unwrap_or(TailSpec::Unknown)
    }

    /// Whether an unknown tail reached the configured safety cap.
    pub fn finish_was_capped(&self) -> bool {
        self.finish_capped
    }

    /// Get number of processors
    pub fn len(&self) -> usize {
        self.processors.len()
    }

    /// Return processor names in execution order.
    ///
    /// This is intended for setup-time diagnostics and tests. It allocates the
    /// returned vector, so do not call it from the realtime callback.
    pub fn processor_names(&self) -> Vec<&'static str> {
        self.processors
            .iter()
            .map(|processor| processor.name())
            .collect()
    }

    /// Check if chain is empty
    pub fn is_empty(&self) -> bool {
        self.processors.is_empty()
    }

    /// Clear all processors
    pub fn clear(&mut self) {
        self.processors.clear();
        self.finish_stage = 0;
        self.finish_complete = false;
        self.finish_policy = None;
        self.finish_threshold_power = 0.0;
        self.finish_unknown_stage = None;
        self.finish_observation_end_stage = 0;
        self.finish_protected_frames = 0;
        self.finish_quiet_frames = 0;
        self.finish_generated_frames = 0;
        self.finish_capped = false;
    }
}

#[cfg(test)]
mod tests;
