//! Processor Adapters
//!
//! Wraps existing processors with the [`StreamingProcessor`] trait, enabling
//! lock-free parameter passing and unified DSP chain management.
//!
//! Each adapter:
//! - Owns the actual processor (audio thread exclusive)
//! - References lock-free parameters (shared with main thread)
//! - Synchronizes parameters before processing

#[cfg(test)]
use std::sync::atomic::AtomicBool;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

#[cfg(test)]
use super::convolver::FFTConvolver;
use super::crossfeed::Crossfeed;
use super::dsp::{NoiseShaper, NoiseShaperCurve};
use super::dynamic_loudness::{DynamicLoudness, LOUDNESS_BANDS_N};
use super::eq::Equalizer;
use super::lockfree_params::*;
use super::loudness::{LimiterMode, PeakLimiter};
use super::saturation::Saturation;
use super::saturation::SATURATION_LATENCY_FRAMES;
use super::traits::{
    validate_processor_channels, validate_sample_rate_hz, validated_channel_count, AudioBlockMut,
    FixedInPlaceProcessor, FrameDuration, ProcessBufferParts, ProcessBuffers, ProcessError,
    ProcessProgress, ProcessState, StreamingProcessor, TailSpec,
};

#[derive(Default)]
struct FixedLifecycle {
    finishing: bool,
    finished: bool,
    finish_enabled: Option<bool>,
}

impl FixedLifecycle {
    fn ensure_processing(&self, processor: &'static str) -> Result<(), ProcessError> {
        if self.finishing || self.finished {
            Err(ProcessError::AlreadyFinished { processor })
        } else {
            Ok(())
        }
    }

    fn begin_finish(&mut self) {
        self.finishing = true;
    }

    /// Lock the enabled decision made by the first finish call.
    ///
    /// Control snapshots may change while a tail is being drained, but a
    /// promised tail must not disappear halfway through a multi-call finish.
    fn lock_finish_enabled(&mut self, enabled: bool) -> bool {
        self.finishing = true;
        *self.finish_enabled.get_or_insert(enabled)
    }

    fn is_finished(&self) -> bool {
        self.finished
    }

    fn finish(&mut self) -> ProcessProgress {
        self.finishing = true;
        self.finished = true;
        ProcessProgress::finished(0)
    }

    fn reset(&mut self) {
        self.finishing = false;
        self.finished = false;
        self.finish_enabled = None;
    }
}

fn validate_sample_rate(processor: &'static str, sample_rate_hz: u32) -> Result<f64, ProcessError> {
    validate_sample_rate_hz(processor, sample_rate_hz)?;
    Ok(sample_rate_hz as f64)
}

fn process_fixed_1_to_1<F>(
    processor: &'static str,
    enabled: bool,
    expected_channels: Option<usize>,
    buffers: ProcessBuffers<'_>,
    process: F,
) -> Result<ProcessProgress, ProcessError>
where
    F: FnOnce(&mut [f64], usize) -> Result<(), ProcessError>,
{
    let channels = buffers.channels();
    validate_processor_channels(processor, expected_channels, channels)?;

    match buffers.into_parts() {
        ProcessBufferParts::InPlace(mut block) => {
            let frames = block.frames();
            if enabled && frames > 0 {
                process(block.samples_mut(), channels)?;
            }
            Ok(
                ProcessProgress::new(frames, frames, ProcessState::NeedInput)
                    .with_bypassed(!enabled),
            )
        }
        ProcessBufferParts::OutOfPlace { input, mut output } => {
            let frames = input.frames().min(output.frames());
            let samples = frames * channels;
            output.samples_mut()[..samples].copy_from_slice(&input.samples()[..samples]);
            if enabled && frames > 0 {
                process(&mut output.samples_mut()[..samples], channels)?;
            }
            let state = if frames < input.frames() {
                ProcessState::NeedOutput
            } else {
                ProcessState::NeedInput
            };
            Ok(ProcessProgress::new(frames, frames, state).with_bypassed(!enabled))
        }
    }
}

fn finish_fixed(
    processor: &'static str,
    expected_channels: Option<usize>,
    lifecycle: &mut FixedLifecycle,
    output: AudioBlockMut<'_>,
) -> Result<ProcessProgress, ProcessError> {
    validate_processor_channels(processor, expected_channels, output.channels())?;
    Ok(lifecycle.finish())
}

/// Drive a fixed 1:1 processor's state with caller-owned zero input.
///
/// Unknown/asymptotic tails deliberately remain `NeedOutput`; the owning chain
/// or offline renderer applies its energy/hold/safety-cap policy. The first
/// finish call locks `enabled` so a control update cannot truncate a tail.
fn finish_fixed_unknown<F>(
    processor: &'static str,
    enabled: bool,
    expected_channels: Option<usize>,
    lifecycle: &mut FixedLifecycle,
    output: AudioBlockMut<'_>,
    process: F,
) -> Result<ProcessProgress, ProcessError>
where
    F: FnOnce(&mut [f64], usize),
{
    validate_processor_channels(processor, expected_channels, output.channels())?;
    if lifecycle.is_finished() {
        return Ok(ProcessProgress::finished(0));
    }

    let enabled = lifecycle.lock_finish_enabled(enabled);
    if !enabled {
        return Ok(lifecycle.finish());
    }

    let frames = output.frames();
    if frames == 0 {
        return Ok(ProcessProgress::new(0, 0, ProcessState::NeedOutput));
    }

    let channels = output.channels();
    let mut output = output;
    output.samples_mut().fill(0.0);
    process(output.samples_mut(), channels);
    Ok(ProcessProgress::new(0, frames, ProcessState::NeedOutput))
}
// ============================================================================
// EQ Adapter
// ============================================================================

/// Equalizer processor adapter with lock-free parameters
pub struct EqProcessor {
    /// Internal EQ processor (audio thread exclusive)
    eq: Equalizer,
    /// Channel count for reinitialization
    channels: usize,
    /// Lock-free parameters reference
    params: Arc<AtomicEqParams>,
    params_reader: RealtimeSnapshotReader<EqParamsSnapshot>,
    cached_generation: u64,
    /// Local parameter cache
    cached: EqParamsSnapshot,
    /// Sample rate for coefficient recalculation
    sample_rate: f64,
    lifecycle: FixedLifecycle,
}

impl EqProcessor {
    /// Create new EQ processor with lock-free params
    pub fn new(channels: usize, sample_rate: f64, params: Arc<AtomicEqParams>) -> Self {
        let (params_reader, cached, cached_generation) = params.subscribe_realtime();
        let mut eq = Equalizer::new(channels, sample_rate);
        eq.set_all_bands_validated(&cached.gains, sample_rate);
        eq.reset_settled();
        eq.set_enabled(cached.enabled);
        Self {
            eq,
            channels,
            params,
            params_reader,
            cached_generation,
            cached,
            sample_rate,
            lifecycle: FixedLifecycle::default(),
        }
    }

    /// Synchronize parameters from lock-free storage
    fn sync_params(&mut self) {
        if let Some((current, generation)) = self
            .params
            .load_realtime_if_changed_since(&self.params_reader, self.cached_generation)
        {
            self.cached = current;
            self.cached_generation = generation;

            // Apply to internal EQ. The snapshot is already finite and clamped
            // by `AtomicEqParams`, so the audio thread uses the validated
            // kernel and handles no `Result` here.
            self.eq
                .set_all_bands_validated(&self.cached.gains, self.sample_rate);
            self.eq.set_enabled(self.cached.enabled);
        }
    }
}

impl StreamingProcessor for EqProcessor {
    fn name(&self) -> &'static str {
        "Equalizer"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        self.lifecycle.ensure_processing("Equalizer")?;
        self.sync_params();

        process_fixed_1_to_1(
            "Equalizer",
            self.cached.enabled,
            Some(self.channels),
            buffers,
            |buffer, _channels| {
                self.eq.process(buffer);
                Ok(())
            },
        )
    }

    fn finish(&mut self, output: AudioBlockMut<'_>) -> Result<ProcessProgress, ProcessError> {
        finish_fixed_unknown(
            "Equalizer",
            self.cached.enabled,
            Some(self.channels),
            &mut self.lifecycle,
            output,
            |buffer, _channels| self.eq.process(buffer),
        )
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        self.eq.reset_settled();
        self.lifecycle.reset();
        Ok(())
    }

    fn tail(&self) -> TailSpec {
        if self.cached.enabled {
            TailSpec::Unknown
        } else {
            TailSpec::None
        }
    }

    fn set_sample_rate(&mut self, sample_rate_hz: u32) -> Result<(), ProcessError> {
        let sample_rate = validate_sample_rate("Equalizer", sample_rate_hz)?;
        self.sample_rate = sample_rate;
        self.eq = Equalizer::new(self.channels, sample_rate);
        self.eq
            .set_all_bands_validated(&self.cached.gains, sample_rate);
        self.eq.reset_settled();
        self.eq.set_enabled(self.cached.enabled);
        self.lifecycle.reset();
        Ok(())
    }
}

// ============================================================================
// Saturation Adapter
// ============================================================================

/// Source-frame duration of soft Saturation state transitions.
pub const SATURATION_TRANSITION_FRAMES: usize = 32;

/// Sample-accurate Saturation automation event relative to one source block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SaturationEvent {
    /// Zero-based source-frame offset within the current block.
    pub frame_offset: usize,
    /// Control change applied at the frame offset.
    pub kind: SaturationEventKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// Sparse control change accepted by [`SaturationProcessor::process_with_events`].
pub enum SaturationEventKind {
    /// Transition to a new saturation quality mode.
    Quality(SaturationQualityValue),
    /// Smoothly enable or disable the audible effect while preserving state.
    EffectEnabled(bool),
}

/// Saturation processor adapter
pub struct SaturationProcessor {
    channels: usize,
    params: Arc<AtomicSaturationParams>,
    params_reader: RealtimeSnapshotReader<SaturationParamsSnapshot>,
    cached_generation: u64,
    cached: SaturationParamsSnapshot,
    sample_rate: f64,
    lifecycle: FixedLifecycle,
    finish_remaining_frames: Option<usize>,
    hard_bypassed: bool,
    stream_started: bool,
    effect_weight: f64,
    effect_transition_start: f64,
    effect_transition_target: f64,
    effect_transition_cursor: usize,
    quality_states: [Saturation; 3],
    quality_weights: [f64; 3],
    quality_transition_start_weights: [f64; 3],
    quality_transition_target: Option<SaturationQualityValue>,
    quality_transition_cursor: usize,
    quality_scratch: [Vec<f64>; 3],
}

impl SaturationProcessor {
    /// Construct a processor and preallocate per-channel saturation state.
    pub fn new(channels: usize, params: Arc<AtomicSaturationParams>) -> Self {
        let (params_reader, cached, cached_generation) = params.subscribe_realtime();
        let mut saturation = Saturation::new();
        // Pre-size per-channel HPF state off the audio thread so highpass-mode
        // processing never resizes on the realtime thread.
        saturation.set_channel_count(channels);
        saturation.set_drive(cached.drive);
        saturation.set_threshold(cached.threshold);
        saturation.set_mix(cached.mix);
        saturation.set_input_gain(cached.input_gain_db);
        saturation.set_output_gain(cached.output_gain_db);
        saturation.set_highpass_mode(cached.highpass_mode);
        saturation.set_highpass_cutoff(cached.highpass_cutoff);
        // The adapter owns hard bypass separately. Once armed, the core stays
        // enabled so a runtime soft-disable can preserve delay/history.
        saturation.set_enabled(cached.armed);
        saturation.set_type(super::saturation::SaturationType::from(cached.sat_type));
        saturation.set_quality(super::saturation::SaturationQuality::Direct);
        let mut quality_states = [saturation.clone(), saturation.clone(), saturation.clone()];
        quality_states[0].set_quality(super::saturation::SaturationQuality::Direct);
        quality_states[1].set_quality(super::saturation::SaturationQuality::Oversampled2x);
        quality_states[2].set_quality(super::saturation::SaturationQuality::Oversampled4x);
        let quality_weights = Self::one_hot_quality(cached.quality);
        Self {
            channels,
            params,
            params_reader,
            cached_generation,
            cached,
            sample_rate: 44100.0,
            lifecycle: FixedLifecycle::default(),
            finish_remaining_frames: None,
            hard_bypassed: !cached.armed,
            stream_started: false,
            effect_weight: if cached.enabled { 1.0 } else { 0.0 },
            effect_transition_start: if cached.enabled { 1.0 } else { 0.0 },
            effect_transition_target: if cached.enabled { 1.0 } else { 0.0 },
            effect_transition_cursor: SATURATION_TRANSITION_FRAMES,
            quality_states,
            quality_weights,
            quality_transition_start_weights: quality_weights,
            quality_transition_target: None,
            quality_transition_cursor: SATURATION_TRANSITION_FRAMES,
            quality_scratch: std::array::from_fn(|_| vec![0.0; channels.max(1)]),
        }
    }

    fn sync_params(&mut self) {
        if let Some((current, generation)) = self
            .params
            .load_realtime_if_changed_since(&self.params_reader, self.cached_generation)
        {
            let previous = self.cached;
            self.cached = current;
            self.cached_generation = generation;

            for state in &mut self.quality_states {
                state.set_drive(self.cached.drive);
                state.set_threshold(self.cached.threshold);
                state.set_mix(self.cached.mix);
                state.set_input_gain(self.cached.input_gain_db);
                state.set_output_gain(self.cached.output_gain_db);
                state.set_highpass_mode(self.cached.highpass_mode);
                state.set_highpass_cutoff(self.cached.highpass_cutoff);
                state.set_type(super::saturation::SaturationType::from(
                    self.cached.sat_type,
                ));
            }
            if previous.armed != self.cached.armed && !self.stream_started {
                self.hard_bypassed = !self.cached.armed;
            }
            for state in &mut self.quality_states {
                state.set_enabled(!self.hard_bypassed);
            }

            if self.cached.quality != previous.quality {
                self.begin_quality_transition(self.cached.quality);
            }

            if previous.enabled != self.cached.enabled && !self.hard_bypassed {
                self.begin_effect_transition(self.cached.enabled);
            }
        }
    }

    fn begin_effect_transition(&mut self, enabled: bool) {
        if enabled && self.current_effect_weight() == 0.0 {
            let weights = self.current_quality_weights();
            let target_index = self.quality_transition_target.map(Self::quality_index);
            for (index, state) in self.quality_states.iter_mut().enumerate() {
                if weights[index] > 0.0 || target_index == Some(index) {
                    state.prepare_nonlinear_state_from_history();
                }
            }
        }
        self.effect_transition_start = self.current_effect_weight();
        self.effect_transition_target = if enabled { 1.0 } else { 0.0 };
        self.effect_transition_cursor = 0;
    }

    fn quality_index(quality: SaturationQualityValue) -> usize {
        match quality {
            SaturationQualityValue::Direct => 0,
            SaturationQualityValue::Oversampled2x => 1,
            SaturationQualityValue::Oversampled4x => 2,
        }
    }

    fn one_hot_quality(quality: SaturationQualityValue) -> [f64; 3] {
        let mut weights = [0.0; 3];
        weights[Self::quality_index(quality)] = 1.0;
        weights
    }

    fn current_quality_weights(&self) -> [f64; 3] {
        let Some(target) = self.quality_transition_target else {
            return self.quality_weights;
        };
        if self.quality_transition_cursor >= SATURATION_TRANSITION_FRAMES {
            return Self::one_hot_quality(target);
        }

        let denominator = (SATURATION_TRANSITION_FRAMES - 1) as f64;
        let t = self.quality_transition_cursor as f64 / denominator;
        let smooth = t * t * (3.0 - 2.0 * t);
        let target_weights = Self::one_hot_quality(target);
        let mut weights = [0.0; 3];
        for index in 0..3 {
            weights[index] = self.quality_transition_start_weights[index]
                + (target_weights[index] - self.quality_transition_start_weights[index]) * smooth;
        }
        weights
    }

    fn copy_quality_state(&mut self, source_index: usize, target_index: usize) {
        if source_index == target_index {
            return;
        }
        if source_index < target_index {
            let (before, target_and_after) = self.quality_states.split_at_mut(target_index);
            target_and_after[0].copy_from_preallocated(&before[source_index]);
        } else {
            let (target_and_before, source_and_after) =
                self.quality_states.split_at_mut(source_index);
            target_and_before[target_index].copy_from_preallocated(&source_and_after[0]);
        }
    }

    fn begin_quality_transition(&mut self, target: SaturationQualityValue) {
        if self.quality_transition_target == Some(target) {
            return;
        }
        let current_weights = self.current_quality_weights();
        let target_index = Self::quality_index(target);
        if current_weights[target_index] >= 1.0 - f64::EPSILON {
            self.quality_weights = Self::one_hot_quality(target);
            self.quality_transition_start_weights = self.quality_weights;
            self.quality_transition_target = None;
            self.quality_transition_cursor = SATURATION_TRANSITION_FRAMES;
            return;
        }

        if current_weights[target_index] <= f64::EPSILON {
            let source_index = current_weights
                .iter()
                .enumerate()
                .max_by(|left, right| left.1.total_cmp(right.1))
                .map(|(index, _)| index)
                .unwrap_or(target_index);
            self.copy_quality_state(source_index, target_index);
            self.quality_states[target_index]
                .set_quality(super::saturation::SaturationQuality::from(target));
            self.quality_states[target_index].set_enabled(!self.hard_bypassed);
        }

        self.quality_weights = current_weights;
        self.quality_transition_start_weights = current_weights;
        self.quality_transition_target = Some(target);
        self.quality_transition_cursor = 0;
    }

    fn quality_transition_active(&self) -> bool {
        self.quality_transition_target.is_some()
            && self.quality_transition_cursor < SATURATION_TRANSITION_FRAMES
    }

    fn dominant_quality_index(&self) -> usize {
        self.quality_weights
            .iter()
            .enumerate()
            .max_by(|left, right| left.1.total_cmp(right.1))
            .map(|(index, _)| index)
            .unwrap_or(0)
    }

    fn process_quality_transition_frame(&mut self, output: &mut [f64], channels: usize) {
        let weights = self.current_quality_weights();
        let target_index = self
            .quality_transition_target
            .map(Self::quality_index)
            .unwrap_or_else(|| {
                weights
                    .iter()
                    .enumerate()
                    .max_by(|left, right| left.1.total_cmp(right.1))
                    .map(|(index, _)| index)
                    .unwrap_or(0)
            });
        let effect_weight = self.current_effect_weight();
        for (index, weight) in weights.iter().copied().enumerate() {
            if weight > 0.0 || index == target_index {
                self.quality_scratch[index][..channels].copy_from_slice(output);
                self.quality_states[index].process_with_channels_mix(
                    &mut self.quality_scratch[index][..channels],
                    channels,
                    effect_weight,
                );
            }
        }
        for (channel, output_sample) in output.iter_mut().take(channels).enumerate() {
            let mut sample = 0.0;
            for (index, weight) in weights.iter().copied().enumerate() {
                if weight > 0.0 {
                    sample = self.quality_scratch[index][channel].mul_add(weight, sample);
                }
            }
            *output_sample = sample;
        }
        self.quality_weights = weights;
        self.quality_transition_cursor += 1;
        if self.quality_transition_cursor >= SATURATION_TRANSITION_FRAMES {
            let target = self
                .quality_transition_target
                .unwrap_or(SaturationQualityValue::Direct);
            self.quality_weights = Self::one_hot_quality(target);
            self.quality_transition_start_weights = self.quality_weights;
            self.quality_transition_target = None;
            self.quality_transition_cursor = SATURATION_TRANSITION_FRAMES;
        }
    }

    fn current_effect_weight(&self) -> f64 {
        if self.effect_transition_cursor >= SATURATION_TRANSITION_FRAMES {
            return self.effect_transition_target;
        }
        let denominator = (SATURATION_TRANSITION_FRAMES - 1) as f64;
        let t = self.effect_transition_cursor as f64 / denominator;
        let smooth = t * t * (3.0 - 2.0 * t);
        self.effect_transition_start
            + (self.effect_transition_target - self.effect_transition_start) * smooth
    }

    fn transition_remaining_frames(cursor: usize) -> usize {
        SATURATION_TRANSITION_FRAMES.saturating_sub(cursor)
    }

    fn effect_can_ring(&self) -> bool {
        self.current_effect_weight() != 0.0
            || (self.effect_transition_cursor < SATURATION_TRANSITION_FRAMES
                && self.effect_transition_target != 0.0)
    }

    fn finite_finish_frames(&self) -> usize {
        let pending_transition = Self::transition_remaining_frames(self.effect_transition_cursor)
            .max(Self::transition_remaining_frames(
                self.quality_transition_cursor,
            ));
        let final_effect_enabled = self.effect_transition_target != 0.0;
        let state_tail = if self.effect_can_ring() && final_effect_enabled {
            let final_quality = self
                .quality_transition_target
                .map(Self::quality_index)
                .unwrap_or_else(|| self.dominant_quality_index());
            self.quality_states[final_quality].finite_tail_frames()
        } else {
            SATURATION_LATENCY_FRAMES
        };
        pending_transition.max(state_tail)
    }

    fn process_armed(&mut self, buffer: &mut [f64], channels: usize) {
        let frames = buffer.len() / channels;
        let mut frame = 0;
        while frame < frames
            && (self.effect_transition_cursor < SATURATION_TRANSITION_FRAMES
                || self.quality_transition_active())
        {
            if self.quality_transition_active() {
                let start = frame * channels;
                let end = start + channels;
                self.process_quality_transition_frame(&mut buffer[start..end], channels);
                self.effect_weight = self.current_effect_weight();
                if self.effect_transition_cursor < SATURATION_TRANSITION_FRAMES {
                    self.effect_transition_cursor += 1;
                }
                frame += 1;
                continue;
            }
            let weight = self.current_effect_weight();
            let start = frame * channels;
            let end = start + channels;
            let quality_index = self.dominant_quality_index();
            self.quality_states[quality_index].process_with_channels_mix(
                &mut buffer[start..end],
                channels,
                weight,
            );
            self.effect_weight = weight;
            self.effect_transition_cursor += 1;
            frame += 1;
        }

        if self.effect_transition_cursor >= SATURATION_TRANSITION_FRAMES {
            self.effect_weight = self.effect_transition_target;
        }
        if frame >= frames {
            return;
        }

        let remainder = &mut buffer[frame * channels..];
        let quality_index = self.dominant_quality_index();
        if self.effect_weight == 0.0 {
            self.quality_states[quality_index].process_delayed_bypass(remainder, channels);
        } else {
            self.quality_states[quality_index].process_with_channels_mix(
                remainder,
                channels,
                self.effect_weight,
            );
        }
    }

    /// Switch the setup/reset-time zero-latency bypass.
    ///
    /// Runtime automation must publish through
    /// [`AtomicSaturationParams::set_enabled`]; a hard bypass change after
    /// processing starts would change the public timeline.
    pub fn set_hard_bypassed(&mut self, bypassed: bool) -> Result<(), ProcessError> {
        if self.stream_started {
            return Err(ProcessError::Backend {
                processor: "Saturation",
                operation: "set hard bypass",
                message: "hard bypass changes require reset before processing",
            });
        }
        self.hard_bypassed = bypassed;
        self.cached.armed = !bypassed;
        for state in &mut self.quality_states {
            state.set_enabled(!bypassed);
        }
        Ok(())
    }

    /// Return whether setup-time hard bypass is active.
    pub const fn is_hard_bypassed(&self) -> bool {
        self.hard_bypassed
    }

    /// Process one in-place source block with borrowed sparse automation.
    ///
    /// Events must be sorted by non-decreasing frame offset. Duplicate offsets
    /// are applied in slice order, so the last event for a control wins. The
    /// method borrows caller memory and performs no event ownership transfer.
    pub fn process_with_events(
        &mut self,
        samples: &mut [f64],
        channels: usize,
        events: &[SaturationEvent],
    ) -> Result<ProcessProgress, ProcessError> {
        self.lifecycle.ensure_processing("Saturation")?;
        validate_processor_channels("Saturation", Some(self.channels), channels)?;
        let block = super::traits::AudioBlockMut::new(samples, channels)?;
        let frames = block.frames();
        let samples = block.into_samples();

        let mut previous_offset = 0usize;
        for (index, event) in events.iter().enumerate() {
            if event.frame_offset >= frames {
                return Err(ProcessError::InvalidAutomation {
                    processor: "Saturation",
                    message: "event offset must address a frame inside the current block",
                });
            }
            if index > 0 && event.frame_offset < previous_offset {
                return Err(ProcessError::InvalidAutomation {
                    processor: "Saturation",
                    message: "events must be sorted by non-decreasing frame offset",
                });
            }
            previous_offset = event.frame_offset;
        }

        self.sync_params();

        if self.hard_bypassed {
            self.apply_events_without_processing(events);
            return Ok(
                ProcessProgress::new(frames, frames, ProcessState::NeedInput).with_bypassed(true),
            );
        }

        self.stream_started |= frames > 0;
        let mut cursor = 0usize;
        let mut event_index = 0usize;
        while event_index < events.len() {
            let offset = events[event_index].frame_offset;
            if cursor < offset {
                self.process_armed(&mut samples[cursor * channels..offset * channels], channels);
                cursor = offset;
            }
            let group_start = event_index;
            while event_index < events.len() && events[event_index].frame_offset == offset {
                event_index += 1;
            }
            self.apply_event_group(&events[group_start..event_index]);
        }
        if cursor < frames {
            self.process_armed(&mut samples[cursor * channels..], channels);
        }

        Ok(ProcessProgress::new(
            frames,
            frames,
            ProcessState::NeedInput,
        ))
    }

    fn apply_events_without_processing(&mut self, events: &[SaturationEvent]) {
        let mut start = 0usize;
        while start < events.len() {
            let offset = events[start].frame_offset;
            let mut end = start + 1;
            while end < events.len() && events[end].frame_offset == offset {
                end += 1;
            }
            self.apply_event_group(&events[start..end]);
            start = end;
        }
    }

    fn apply_event_group(&mut self, events: &[SaturationEvent]) {
        let mut quality = None;
        let mut effect_enabled = None;
        for event in events {
            match event.kind {
                SaturationEventKind::Quality(value) => quality = Some(value),
                SaturationEventKind::EffectEnabled(value) => effect_enabled = Some(value),
            }
        }

        if let Some(quality) = quality {
            self.cached.quality = quality;
            if self.hard_bypassed {
                self.quality_weights = Self::one_hot_quality(quality);
                self.quality_transition_start_weights = self.quality_weights;
                self.quality_transition_target = None;
                self.quality_transition_cursor = SATURATION_TRANSITION_FRAMES;
            } else {
                self.begin_quality_transition(quality);
            }
        }
        if let Some(enabled) = effect_enabled {
            self.cached.enabled = enabled;
            if self.hard_bypassed {
                self.effect_weight = if enabled { 1.0 } else { 0.0 };
                self.effect_transition_start = self.effect_weight;
                self.effect_transition_target = self.effect_weight;
                self.effect_transition_cursor = SATURATION_TRANSITION_FRAMES;
            } else {
                self.begin_effect_transition(enabled);
            }
        }
    }
}

impl StreamingProcessor for SaturationProcessor {
    fn name(&self) -> &'static str {
        "Saturation"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        self.lifecycle.ensure_processing("Saturation")?;
        self.sync_params();

        if self.hard_bypassed {
            return process_fixed_1_to_1(
                "Saturation",
                false,
                Some(self.channels),
                buffers,
                |_, _| Ok(()),
            );
        }
        self.stream_started |= buffers.capacity().input_frames() > 0;

        process_fixed_1_to_1(
            "Saturation",
            true,
            Some(self.channels),
            buffers,
            |buffer, channels| {
                self.process_armed(buffer, channels);
                Ok(())
            },
        )
    }

    fn finish(&mut self, output: AudioBlockMut<'_>) -> Result<ProcessProgress, ProcessError> {
        if self.hard_bypassed {
            return finish_fixed(
                "Saturation",
                Some(self.channels),
                &mut self.lifecycle,
                output,
            );
        }
        validate_processor_channels("Saturation", Some(self.channels), output.channels())?;
        if self.lifecycle.is_finished() {
            return Ok(ProcessProgress::finished(0));
        }
        let enabled = self.lifecycle.lock_finish_enabled(true);
        if !enabled {
            return Ok(self.lifecycle.finish());
        }

        if self.cached.highpass_mode && self.effect_can_ring() {
            let frames = output.frames();
            if frames == 0 {
                return Ok(ProcessProgress::new(0, 0, ProcessState::NeedOutput));
            }
            let channels = output.channels();
            let mut output = output;
            output.samples_mut().fill(0.0);
            self.process_armed(output.samples_mut(), channels);
            return Ok(ProcessProgress::new(0, frames, ProcessState::NeedOutput));
        }

        if self.finish_remaining_frames.is_none() {
            self.finish_remaining_frames = Some(self.finite_finish_frames());
        }
        let remaining = self.finish_remaining_frames.unwrap_or(0);
        if remaining == 0 {
            return Ok(self.lifecycle.finish());
        }

        let frames = output.frames().min(remaining);
        let channels = output.channels();
        let mut output = output;
        let samples = frames * channels;
        output.samples_mut()[..samples].fill(0.0);
        if frames > 0 {
            self.process_armed(&mut output.samples_mut()[..samples], channels);
        }
        let remaining = remaining - frames;
        self.finish_remaining_frames = Some(remaining);
        if remaining == 0 {
            let _ = self.lifecycle.finish();
            Ok(ProcessProgress::finished(frames).with_bypassed(false))
        } else {
            Ok(ProcessProgress::new(0, frames, ProcessState::NeedOutput))
        }
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        self.hard_bypassed = !self.cached.armed;
        for state in &mut self.quality_states {
            state.reset();
            state.set_enabled(!self.hard_bypassed);
        }
        self.lifecycle.reset();
        self.finish_remaining_frames = None;
        self.stream_started = false;
        self.effect_weight = if self.cached.enabled { 1.0 } else { 0.0 };
        self.effect_transition_start = self.effect_weight;
        self.effect_transition_target = self.effect_weight;
        self.effect_transition_cursor = SATURATION_TRANSITION_FRAMES;
        self.quality_weights = Self::one_hot_quality(self.cached.quality);
        self.quality_transition_start_weights = self.quality_weights;
        self.quality_transition_target = None;
        self.quality_transition_cursor = SATURATION_TRANSITION_FRAMES;
        Ok(())
    }

    fn latency(&self) -> FrameDuration {
        if self.hard_bypassed {
            return FrameDuration::ZERO;
        }
        FrameDuration::new(SATURATION_LATENCY_FRAMES, self.sample_rate as u32)
            .unwrap_or(FrameDuration::ZERO)
    }

    fn tail(&self) -> TailSpec {
        if self.hard_bypassed {
            return TailSpec::None;
        }
        if self.cached.highpass_mode && self.effect_can_ring() {
            TailSpec::Unknown
        } else {
            let semantic_tail = self
                .finite_finish_frames()
                .saturating_sub(SATURATION_LATENCY_FRAMES);
            TailSpec::finite(semantic_tail, self.sample_rate as u32).unwrap_or(TailSpec::Unknown)
        }
    }

    fn set_sample_rate(&mut self, sample_rate_hz: u32) -> Result<(), ProcessError> {
        let sample_rate = validate_sample_rate("Saturation", sample_rate_hz)?;
        self.sample_rate = sample_rate;
        self.hard_bypassed = !self.cached.armed;
        for state in &mut self.quality_states {
            state.set_sample_rate(sample_rate);
            state.reset();
            state.set_enabled(!self.hard_bypassed);
        }
        self.lifecycle.reset();
        self.finish_remaining_frames = None;
        self.stream_started = false;
        self.effect_weight = if self.cached.enabled { 1.0 } else { 0.0 };
        self.effect_transition_start = self.effect_weight;
        self.effect_transition_target = self.effect_weight;
        self.effect_transition_cursor = SATURATION_TRANSITION_FRAMES;
        self.quality_weights = Self::one_hot_quality(self.cached.quality);
        self.quality_transition_start_weights = self.quality_weights;
        self.quality_transition_target = None;
        self.quality_transition_cursor = SATURATION_TRANSITION_FRAMES;
        Ok(())
    }
}

// ============================================================================
// Crossfeed Adapter
// ============================================================================

/// Crossfeed processor adapter
pub struct CrossfeedProcessor {
    crossfeed: Crossfeed,
    params: Arc<AtomicCrossfeedParams>,
    params_reader: RealtimeSnapshotReader<CrossfeedParamsSnapshot>,
    cached_generation: u64,
    cached: CrossfeedParamsSnapshot,
    sample_rate: f64,
    stream_channels: Option<usize>,
    lifecycle: FixedLifecycle,
}

impl CrossfeedProcessor {
    /// Construct a crossfeed adapter from the current parameter snapshot.
    pub fn new(sample_rate: f64, params: Arc<AtomicCrossfeedParams>) -> Self {
        let (params_reader, cached, cached_generation) = params.subscribe_realtime();
        let mut crossfeed = Crossfeed::with_params(sample_rate, cached.cutoff_hz, cached.mix);
        crossfeed.set_enabled(cached.enabled);
        Self {
            crossfeed,
            params,
            params_reader,
            cached_generation,
            cached,
            sample_rate,
            stream_channels: None,
            lifecycle: FixedLifecycle::default(),
        }
    }

    fn sync_params(&mut self) {
        if let Some((current, generation)) = self
            .params
            .load_realtime_if_changed_since(&self.params_reader, self.cached_generation)
        {
            let previous = self.cached;
            self.cached = current;
            self.cached_generation = generation;
            if self.cached.mix != previous.mix {
                self.crossfeed.set_mix(self.cached.mix);
            }
            if self.cached.enabled != previous.enabled {
                self.crossfeed.set_enabled(self.cached.enabled);
            }
            if self.cached.cutoff_hz != previous.cutoff_hz {
                self.crossfeed.set_cutoff(self.cached.cutoff_hz);
            }
        }
    }
}

impl StreamingProcessor for CrossfeedProcessor {
    fn name(&self) -> &'static str {
        "Crossfeed"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        self.lifecycle.ensure_processing("Crossfeed")?;
        self.sync_params();
        let channels = buffers.channels();
        self.stream_channels = Some(channels);
        let enabled = self.cached.enabled && channels == 2;

        process_fixed_1_to_1("Crossfeed", enabled, None, buffers, |buffer, channels| {
            self.crossfeed.process(buffer, channels);
            Ok(())
        })
    }

    fn finish(&mut self, output: AudioBlockMut<'_>) -> Result<ProcessProgress, ProcessError> {
        let stereo = output.channels() == 2;
        finish_fixed_unknown(
            "Crossfeed",
            self.cached.enabled && stereo,
            None,
            &mut self.lifecycle,
            output,
            |buffer, channels| self.crossfeed.process(buffer, channels),
        )
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        self.crossfeed.reset();
        self.stream_channels = None;
        self.lifecycle.reset();
        Ok(())
    }

    fn tail(&self) -> TailSpec {
        if self.cached.enabled && self.stream_channels.unwrap_or(2) == 2 {
            TailSpec::Unknown
        } else {
            TailSpec::None
        }
    }

    fn set_sample_rate(&mut self, sample_rate_hz: u32) -> Result<(), ProcessError> {
        let sample_rate = validate_sample_rate("Crossfeed", sample_rate_hz)?;
        self.sample_rate = sample_rate;
        self.crossfeed
            .set_sample_rate(sample_rate, self.cached.cutoff_hz);
        self.lifecycle.reset();
        Ok(())
    }
}

// ============================================================================
// Peak Limiter Adapter
// ============================================================================

/// Per-chain block-boundary handoff from the final limiter to NoiseShaper.
#[derive(Clone)]
pub(super) struct NoiseShaperSnapshotLatch {
    packed: Arc<AtomicU64>,
}

impl NoiseShaperSnapshotLatch {
    pub(super) fn new(snapshot: NoiseShaperParamsSnapshot) -> Self {
        Self {
            packed: Arc::new(AtomicU64::new(Self::pack(snapshot))),
        }
    }

    fn pack(snapshot: NoiseShaperParamsSnapshot) -> u64 {
        let curve = match snapshot.curve {
            NoiseShaperCurve::Lipshitz5 => 0,
            NoiseShaperCurve::FWeighted9 => 1,
            NoiseShaperCurve::ModifiedE9 => 2,
            NoiseShaperCurve::ImprovedE9 => 3,
            NoiseShaperCurve::TpdfOnly => 4,
        };
        u64::from(snapshot.bits) | (u64::from(snapshot.enabled) << 8) | ((curve as u64) << 9)
    }

    fn unpack(packed: u64) -> NoiseShaperParamsSnapshot {
        let curve = match (packed >> 9) & 0x7 {
            0 => NoiseShaperCurve::Lipshitz5,
            1 => NoiseShaperCurve::FWeighted9,
            2 => NoiseShaperCurve::ModifiedE9,
            3 => NoiseShaperCurve::ImprovedE9,
            _ => NoiseShaperCurve::TpdfOnly,
        };
        NoiseShaperParamsSnapshot {
            enabled: ((packed >> 8) & 1) != 0,
            bits: (packed & 0xff) as u32,
            curve,
        }
    }

    fn store(&self, snapshot: NoiseShaperParamsSnapshot) {
        self.packed.store(Self::pack(snapshot), Ordering::Release);
    }

    fn load(&self) -> NoiseShaperParamsSnapshot {
        Self::unpack(self.packed.load(Ordering::Acquire))
    }
}

/// Peak limiter processor adapter
pub struct PeakLimiterProcessor {
    limiter: PeakLimiter,
    params: Arc<AtomicPeakLimiterParams>,
    params_reader: RealtimeSnapshotReader<PeakLimiterParamsSnapshot>,
    cached_generation: u64,
    cached: PeakLimiterParamsSnapshot,
    sample_rate: u32,
    channels: usize,
    lifecycle: FixedLifecycle,
    finish_remaining_frames: Option<usize>,
    output_guard_params: Option<Arc<AtomicNoiseShaperParams>>,
    output_guard_reader: Option<RealtimeSnapshotReader<NoiseShaperParamsSnapshot>>,
    output_guard_latch: Option<NoiseShaperSnapshotLatch>,
    output_guard_generation: u64,
    output_guard_snapshot: NoiseShaperParamsSnapshot,
    output_ceiling_guard_db: f64,
    force_true_peak: bool,
}

impl PeakLimiterProcessor {
    /// Construct a limiter adapter after validating channels and sample rate.
    pub fn new(
        channels: usize,
        sample_rate: u32,
        params: Arc<AtomicPeakLimiterParams>,
    ) -> Result<Self, ProcessError> {
        validated_channel_count(channels)?;
        validate_sample_rate("PeakLimiter", sample_rate)?;
        let (params_reader, cached, cached_generation) = params.subscribe_realtime();
        Ok(Self {
            limiter: PeakLimiter::with_mode_validated(
                channels,
                sample_rate,
                cached.threshold_db,
                10.0,
                cached.release_ms,
                cached.mode,
            ),
            params,
            params_reader,
            cached_generation,
            cached,
            sample_rate,
            channels,
            lifecycle: FixedLifecycle::default(),
            finish_remaining_frames: None,
            output_guard_params: None,
            output_guard_reader: None,
            output_guard_latch: None,
            output_guard_generation: 0,
            output_guard_snapshot: NoiseShaperParamsSnapshot::default(),
            output_ceiling_guard_db: 0.0,
            force_true_peak: false,
        })
    }

    /// Construct the final-domain limiter with a guard derived from the
    /// downstream quantizer/noise-shaper configuration.
    pub fn new_with_output_guard(
        channels: usize,
        sample_rate: u32,
        params: Arc<AtomicPeakLimiterParams>,
        noise_shaper_params: Arc<AtomicNoiseShaperParams>,
    ) -> Result<Self, ProcessError> {
        validated_channel_count(channels)?;
        validate_sample_rate("PeakLimiter", sample_rate)?;
        let latch = NoiseShaperSnapshotLatch::new(noise_shaper_params.read());
        Self::new_with_output_guard_latch(channels, sample_rate, params, noise_shaper_params, latch)
    }

    pub(super) fn new_with_output_guard_latch(
        channels: usize,
        sample_rate: u32,
        params: Arc<AtomicPeakLimiterParams>,
        noise_shaper_params: Arc<AtomicNoiseShaperParams>,
        latch: NoiseShaperSnapshotLatch,
    ) -> Result<Self, ProcessError> {
        let mut processor = Self::new(channels, sample_rate, params)?;
        let (reader, snapshot, generation) = noise_shaper_params.subscribe_realtime();
        processor.output_guard_snapshot = snapshot;
        processor.output_guard_generation = generation;
        processor.output_guard_params = Some(noise_shaper_params);
        processor.output_guard_reader = Some(reader);
        processor.output_guard_latch = Some(latch);
        processor.force_true_peak = true;
        processor.limiter.set_mode(LimiterMode::TruePeak);
        if let Some(latch) = processor.output_guard_latch.as_ref() {
            latch.store(processor.output_guard_snapshot);
        }
        processor.apply_output_ceiling_guard();
        Ok(processor)
    }

    fn effective_mode(&self) -> LimiterMode {
        if self.force_true_peak {
            LimiterMode::TruePeak
        } else {
            self.cached.mode
        }
    }

    fn apply_output_ceiling_guard(&mut self) {
        let target = super::dsp::db_to_linear(self.cached.threshold_db);
        let quantization = if self.output_guard_snapshot.enabled {
            self.output_guard_snapshot
                .curve
                .quantization_error_bound(self.output_guard_snapshot.bits)
        } else {
            0.0
        };
        let f32_rounding = f32::EPSILON as f64 * 0.5;
        let reconstruction = super::loudness::true_peak_reconstruction_l1_bound();
        let additive_bound = (quantization + f32_rounding) * reconstruction;
        let guarded = (target - additive_bound).max(f64::MIN_POSITIVE);
        let guarded_db = super::dsp::linear_to_db(guarded);
        self.output_ceiling_guard_db = self.cached.threshold_db - guarded_db;
        self.limiter.set_threshold(guarded_db);
    }

    fn sync_params(&mut self) {
        let mut changed = false;
        if let Some((current, generation)) = self
            .params
            .load_realtime_if_changed_since(&self.params_reader, self.cached_generation)
        {
            self.cached = current;
            self.cached_generation = generation;
            changed = true;

            // In-place updates only — NO PeakLimiter::new(), NO heap allocation.
            // set_mode is allocation-free (buffers pre-sized for the worst case)
            // and resets internal state when the active window changes.
            self.limiter.set_mode(self.effective_mode());
            self.limiter.set_release_ms(self.cached.release_ms);
            // If enabled state changed, limiter reset may be needed
            if self.cached.enabled != self.limiter.is_enabled() {
                self.limiter.reset();
            }
        }
        if let (Some(params), Some(reader)) = (
            self.output_guard_params.as_ref(),
            self.output_guard_reader.as_ref(),
        ) {
            if let Some((snapshot, generation)) =
                params.load_realtime_if_changed_since(reader, self.output_guard_generation)
            {
                self.output_guard_snapshot = snapshot;
                self.output_guard_generation = generation;
                changed = true;
            }
        }
        if let Some(latch) = self.output_guard_latch.as_ref() {
            latch.store(self.output_guard_snapshot);
        }
        if self.output_guard_params.is_some() {
            if changed {
                self.apply_output_ceiling_guard();
            }
        } else if changed {
            self.output_ceiling_guard_db = 0.0;
            self.limiter.set_threshold(self.cached.threshold_db);
        }
    }

    /// Current limiter gain reduction in dB.
    pub fn gain_reduction_db(&self) -> f64 {
        self.limiter.gain_reduction_db()
    }

    /// Derived internal headroom below the user-facing ceiling.
    pub fn output_ceiling_guard_db(&self) -> f64 {
        self.output_ceiling_guard_db
    }
}

impl StreamingProcessor for PeakLimiterProcessor {
    fn name(&self) -> &'static str {
        "PeakLimiter"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        self.lifecycle.ensure_processing("PeakLimiter")?;
        self.sync_params();

        process_fixed_1_to_1(
            "PeakLimiter",
            self.cached.enabled,
            Some(self.channels),
            buffers,
            |buffer, _channels| {
                self.limiter.process_validated(buffer);
                Ok(())
            },
        )
    }

    fn finish(&mut self, output: AudioBlockMut<'_>) -> Result<ProcessProgress, ProcessError> {
        validate_processor_channels("PeakLimiter", Some(self.channels), output.channels())?;
        if self.lifecycle.is_finished() {
            return Ok(ProcessProgress::finished(0));
        }

        self.lifecycle.begin_finish();
        let initial_remaining = if self.cached.enabled {
            self.limiter.delay_frames()
        } else {
            0
        };
        let remaining = self
            .finish_remaining_frames
            .get_or_insert(initial_remaining);
        if *remaining == 0 {
            return Ok(self.lifecycle.finish());
        }

        let mut output = output;
        let frames = output.frames().min(*remaining);
        let samples = frames * self.channels;
        output.samples_mut()[..samples].fill(0.0);
        if frames > 0 {
            self.limiter
                .process_validated(&mut output.samples_mut()[..samples]);
        }
        *remaining -= frames;

        if *remaining == 0 {
            let _ = self.lifecycle.finish();
            Ok(ProcessProgress::finished(frames))
        } else {
            Ok(ProcessProgress::new(0, frames, ProcessState::NeedOutput))
        }
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        self.limiter.reset();
        self.lifecycle.reset();
        self.finish_remaining_frames = None;
        Ok(())
    }

    fn latency(&self) -> FrameDuration {
        if !self.cached.enabled {
            return FrameDuration::ZERO;
        }
        FrameDuration::new(self.limiter.delay_frames(), self.sample_rate)
            .unwrap_or(FrameDuration::ZERO)
    }

    fn set_sample_rate(&mut self, sample_rate_hz: u32) -> Result<(), ProcessError> {
        validate_sample_rate("PeakLimiter", sample_rate_hz)?;
        self.sample_rate = sample_rate_hz;
        self.limiter = PeakLimiter::with_mode_validated(
            self.channels,
            self.sample_rate,
            self.cached.threshold_db,
            10.0,
            self.cached.release_ms,
            self.effective_mode(),
        );
        if self.output_guard_params.is_some() {
            self.apply_output_ceiling_guard();
        } else {
            self.output_ceiling_guard_db = 0.0;
        }
        self.lifecycle.reset();
        self.finish_remaining_frames = None;
        Ok(())
    }
}

// ============================================================================
// Volume Adapter (P1-3 fix: anti-zipper smoothing)
// ============================================================================

/// Volume processor with exponential smoothing to prevent zipper noise.
///
/// Uses ~5ms smoothing time constant to ensure click-free volume transitions.
/// Previous implementation directly multiplied buffer by target volume,
/// causing audible clicks/zips on rapid volume changes.
pub struct VolumeProcessor {
    params: Arc<AtomicVolumeParams>,
    params_reader: RealtimeSnapshotReader<VolumeParamsSnapshot>,
    cached_generation: u64,
    cached: VolumeParamsSnapshot,
    /// Current smoothed volume (exponentially approaches target)
    current_volume: f64,
    /// Smoothing coefficient per sample (calculated from sample rate)
    smoothing_coeff: f64,
    /// Cached `1.0 - smoothing_coeff`
    one_minus_smoothing_coeff: f64,
    /// Sample rate for smoothing calculation
    sample_rate: f64,
    lifecycle: FixedLifecycle,
}

impl VolumeProcessor {
    const SETTLE_EPSILON: f64 = 1.0e-6;

    /// Construct a volume adapter from the current atomic parameter snapshot.
    pub fn new(params: Arc<AtomicVolumeParams>) -> Self {
        let smoothing_coeff = Self::calc_smoothing_coeff(44100.0);
        let one_minus_smoothing_coeff = 1.0 - smoothing_coeff;
        let (params_reader, cached, cached_generation) = params.subscribe_realtime();
        Self {
            params,
            params_reader,
            cached_generation,
            cached,
            current_volume: 1.0,
            smoothing_coeff,
            one_minus_smoothing_coeff,
            sample_rate: 44100.0,
            lifecycle: FixedLifecycle::default(),
        }
    }

    /// Calculate smoothing coefficient for ~5ms time constant
    fn calc_smoothing_coeff(sample_rate: f64) -> f64 {
        let smoothing_time_ms = 5.0;
        let smoothing_samples = (smoothing_time_ms / 1000.0) * sample_rate;
        (-1.0 / smoothing_samples).exp()
    }

    fn sync_params(&mut self) {
        if let Some((current, generation)) = self
            .params
            .load_realtime_if_changed_since(&self.params_reader, self.cached_generation)
        {
            self.cached = current;
            self.cached_generation = generation;
        }
    }
}

impl StreamingProcessor for VolumeProcessor {
    fn name(&self) -> &'static str {
        "Volume"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        self.lifecycle.ensure_processing("Volume")?;
        self.sync_params();

        process_fixed_1_to_1("Volume", true, None, buffers, |buffer, channels| {
            // Volume is always active. Muting is a smoothed gain transition,
            // not a transparent bypass.
            if self.cached.muted {
                // Decay once per frame so every channel receives the same gain.
                let coeff = self.smoothing_coeff;
                let mut current_volume = self.current_volume;
                for frame in buffer.chunks_exact_mut(channels) {
                    current_volume *= coeff;
                    for sample in frame.iter_mut() {
                        *sample *= current_volume;
                    }
                }
                self.current_volume = current_volume;
                return Ok(());
            }

            let target = self.cached.volume;
            if self.current_volume == target {
                if target != 1.0 {
                    for sample in buffer.iter_mut() {
                        *sample *= target;
                    }
                }
                return Ok(());
            }

            let one_minus_coeff = self.one_minus_smoothing_coeff;
            let mut current_volume = self.current_volume;
            let frames = buffer.len() / channels;
            let mut frame = 0;

            while frame < frames {
                if (target - current_volume).abs() <= Self::SETTLE_EPSILON {
                    current_volume = target;
                    break;
                }

                current_volume += (target - current_volume) * one_minus_coeff;
                for ch in 0..channels {
                    buffer[frame * channels + ch] *= current_volume;
                }
                frame += 1;
            }

            if frame < frames && target != 1.0 {
                for sample in &mut buffer[(frame * channels)..] {
                    *sample *= target;
                }
            }
            self.current_volume = current_volume;

            Ok(())
        })
    }

    fn finish(&mut self, output: AudioBlockMut<'_>) -> Result<ProcessProgress, ProcessError> {
        finish_fixed("Volume", None, &mut self.lifecycle, output)
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        self.current_volume = self.cached.volume;
        self.lifecycle.reset();
        Ok(())
    }

    fn set_sample_rate(&mut self, sample_rate_hz: u32) -> Result<(), ProcessError> {
        let sample_rate = validate_sample_rate("Volume", sample_rate_hz)?;
        if (self.sample_rate - sample_rate).abs() > 1.0 {
            self.sample_rate = sample_rate;
            self.smoothing_coeff = Self::calc_smoothing_coeff(sample_rate);
            self.one_minus_smoothing_coeff = 1.0 - self.smoothing_coeff;
        }
        self.lifecycle.reset();
        Ok(())
    }
}

// ============================================================================
// Noise Shaper Adapter
// ============================================================================

/// Noise shaper processor adapter
pub struct NoiseShaperProcessor {
    noise_shaper: NoiseShaper,
    params: Arc<AtomicNoiseShaperParams>,
    params_reader: RealtimeSnapshotReader<NoiseShaperParamsSnapshot>,
    cached_generation: u64,
    cached: NoiseShaperParamsSnapshot,
    sample_rate: u32,
    channels: usize,
    lifecycle: FixedLifecycle,
    output_guard_latch: Option<NoiseShaperSnapshotLatch>,
}

impl NoiseShaperProcessor {
    /// Construct a noise-shaper adapter after validating stream geometry.
    pub fn new(
        channels: usize,
        sample_rate: u32,
        params: Arc<AtomicNoiseShaperParams>,
    ) -> Result<Self, ProcessError> {
        validated_channel_count(channels)?;
        validate_sample_rate("NoiseShaper", sample_rate)?;
        let (params_reader, cached, cached_generation) = params.subscribe_realtime();
        let mut noise_shaper = NoiseShaper::new_validated(channels, sample_rate, cached.bits);
        noise_shaper.set_enabled(cached.enabled);
        noise_shaper.set_curve(cached.curve);

        Ok(Self {
            noise_shaper,
            params,
            params_reader,
            cached_generation,
            cached,
            sample_rate,
            channels,
            lifecycle: FixedLifecycle::default(),
            output_guard_latch: None,
        })
    }

    pub(super) fn new_with_output_guard_latch(
        channels: usize,
        sample_rate: u32,
        params: Arc<AtomicNoiseShaperParams>,
        latch: NoiseShaperSnapshotLatch,
    ) -> Result<Self, ProcessError> {
        let mut processor = Self::new(channels, sample_rate, params)?;
        processor.output_guard_latch = Some(latch);
        let snapshot = processor
            .output_guard_latch
            .as_ref()
            .map(NoiseShaperSnapshotLatch::load)
            .unwrap_or(processor.cached);
        processor.apply_snapshot(snapshot);
        Ok(processor)
    }

    fn apply_snapshot(&mut self, snapshot: NoiseShaperParamsSnapshot) {
        let previous = self.cached;
        self.cached = snapshot;
        if self.cached.enabled != previous.enabled {
            self.noise_shaper.set_enabled(self.cached.enabled);
        }
        if self.cached.bits != previous.bits {
            self.noise_shaper.set_bits(self.cached.bits);
        }
        if self.cached.curve != previous.curve {
            self.noise_shaper.set_curve(self.cached.curve);
        }
    }

    fn sync_params(&mut self) {
        if let Some(latch) = self.output_guard_latch.as_ref() {
            let snapshot = latch.load();
            if snapshot != self.cached {
                self.apply_snapshot(snapshot);
            }
            return;
        }
        if let Some((current, generation)) = self
            .params
            .load_realtime_if_changed_since(&self.params_reader, self.cached_generation)
        {
            self.cached_generation = generation;
            self.apply_snapshot(current);
        }
    }
}

impl StreamingProcessor for NoiseShaperProcessor {
    fn name(&self) -> &'static str {
        "NoiseShaper"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        self.lifecycle.ensure_processing("NoiseShaper")?;
        self.sync_params();

        process_fixed_1_to_1(
            "NoiseShaper",
            self.cached.enabled,
            Some(self.channels),
            buffers,
            |buffer, _channels| {
                self.noise_shaper.process_validated(buffer, self.channels);
                Ok(())
            },
        )
    }

    fn finish(&mut self, output: AudioBlockMut<'_>) -> Result<ProcessProgress, ProcessError> {
        finish_fixed(
            "NoiseShaper",
            Some(self.channels),
            &mut self.lifecycle,
            output,
        )
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        self.noise_shaper.reset();
        self.lifecycle.reset();
        Ok(())
    }

    fn tail_energy_observation_barrier(&self) -> bool {
        true
    }

    fn set_sample_rate(&mut self, sample_rate_hz: u32) -> Result<(), ProcessError> {
        validate_sample_rate("NoiseShaper", sample_rate_hz)?;
        self.sample_rate = sample_rate_hz;
        self.noise_shaper =
            NoiseShaper::new_validated(self.channels, self.sample_rate, self.cached.bits);
        self.noise_shaper.set_enabled(self.cached.enabled);
        self.noise_shaper.set_curve(self.cached.curve);
        self.lifecycle.reset();
        Ok(())
    }
}

// ============================================================================
// Dynamic Loudness Adapter
// ============================================================================

/// Dynamic loudness compensation processor
pub struct DynamicLoudnessProcessor {
    dynamic_loudness: DynamicLoudness,
    params: Arc<AtomicDynamicLoudnessParams>,
    params_reader: RealtimeSnapshotReader<DynamicLoudnessParamsSnapshot>,
    tuning_reader: RealtimeSnapshotReader<DynamicLoudnessTuningSnapshot>,
    telemetry: Arc<AtomicDynamicLoudnessTelemetry>,
    cached_generation: u64,
    cached: DynamicLoudnessParamsSnapshot,
    tuning_generation: u64,
    tuning: DynamicLoudnessTuningSnapshot,
    sample_rate: u32,
    channels: usize,
    lifecycle: FixedLifecycle,
}

impl DynamicLoudnessProcessor {
    /// Construct a dynamic-loudness adapter and attach its telemetry sink.
    pub fn new(
        channels: usize,
        sample_rate: u32,
        params: Arc<AtomicDynamicLoudnessParams>,
        telemetry: Arc<AtomicDynamicLoudnessTelemetry>,
    ) -> Result<Self, ProcessError> {
        validated_channel_count(channels)?;
        validate_sample_rate("DynamicLoudness", sample_rate)?;
        let (params_reader, cached, cached_generation) = params.subscribe_realtime();
        let (tuning_reader, tuning, tuning_generation) = params.subscribe_realtime_tuning();
        let mut processor = Self {
            dynamic_loudness: DynamicLoudness::new_validated(channels, sample_rate as f64),
            params,
            params_reader,
            tuning_reader,
            telemetry,
            cached_generation,
            cached,
            tuning_generation,
            tuning,
            sample_rate,
            channels,
            lifecycle: FixedLifecycle::default(),
        };
        processor.apply_cached_params();
        processor.apply_cached_tuning();
        Ok(processor)
    }

    fn apply_cached_params(&mut self) {
        self.dynamic_loudness.set_volume(self.cached.volume);
        self.dynamic_loudness.set_strength(self.cached.strength);
    }

    /// Push the curve-shaping values into the DSP core.
    ///
    /// Each of these is a cached scalar on the core: no filter coefficient is
    /// redesigned and no delay history is touched, so applying them at a block
    /// boundary cannot discontinue the signal.
    fn apply_cached_tuning(&mut self) {
        self.dynamic_loudness
            .set_pre_gain_db(self.tuning.pre_gain_db);
        self.dynamic_loudness
            .set_transition_db(self.tuning.transition_db);
        self.dynamic_loudness
            .set_reference_volume_db(self.tuning.compensation_ref_db);
    }

    fn sync_params(&mut self) {
        if let Some((current, generation)) = self
            .params
            .load_realtime_if_changed_since(&self.params_reader, self.cached_generation)
        {
            self.cached = current;
            self.cached_generation = generation;
            self.apply_cached_params();
        }
        if let Some((current, generation)) = self
            .params
            .load_realtime_tuning_if_changed_since(&self.tuning_reader, self.tuning_generation)
        {
            self.tuning = current;
            self.tuning_generation = generation;
            self.apply_cached_tuning();
        }
    }
}

impl StreamingProcessor for DynamicLoudnessProcessor {
    fn name(&self) -> &'static str {
        "DynamicLoudness"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        self.lifecycle.ensure_processing("DynamicLoudness")?;
        self.sync_params();

        if !self.cached.enabled {
            self.telemetry.update(0.0, [0.0; LOUDNESS_BANDS_N]);
        }

        process_fixed_1_to_1(
            "DynamicLoudness",
            self.cached.enabled,
            Some(self.channels),
            buffers,
            |buffer, _channels| {
                self.dynamic_loudness.process_validated(buffer);
                self.telemetry.update(
                    self.dynamic_loudness.loudness_factor(),
                    self.dynamic_loudness.get_band_gains(),
                );
                Ok(())
            },
        )
    }

    fn finish(&mut self, output: AudioBlockMut<'_>) -> Result<ProcessProgress, ProcessError> {
        finish_fixed_unknown(
            "DynamicLoudness",
            self.cached.enabled,
            Some(self.channels),
            &mut self.lifecycle,
            output,
            |buffer, _channels| self.dynamic_loudness.process_validated(buffer),
        )
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        self.dynamic_loudness.reset();
        self.apply_cached_params();
        self.lifecycle.reset();
        Ok(())
    }

    fn tail(&self) -> TailSpec {
        if self.cached.enabled {
            TailSpec::Unknown
        } else {
            TailSpec::None
        }
    }

    fn set_sample_rate(&mut self, sample_rate_hz: u32) -> Result<(), ProcessError> {
        validate_sample_rate("DynamicLoudness", sample_rate_hz)?;
        self.sample_rate = sample_rate_hz;
        self.dynamic_loudness
            .set_sample_rate(self.sample_rate as f64)?;
        self.lifecycle.reset();
        Ok(())
    }
}

impl FixedInPlaceProcessor for EqProcessor {}
impl FixedInPlaceProcessor for SaturationProcessor {}
impl FixedInPlaceProcessor for CrossfeedProcessor {}
impl FixedInPlaceProcessor for PeakLimiterProcessor {}
impl FixedInPlaceProcessor for VolumeProcessor {}
impl FixedInPlaceProcessor for NoiseShaperProcessor {}
impl FixedInPlaceProcessor for DynamicLoudnessProcessor {}

mod convolver;

#[cfg(test)]
use convolver::ConvolverDropProbe;
pub use convolver::{ConvolverControl, ConvolverProcessor, ConvolverStatus};
#[cfg(test)]
mod tests;
