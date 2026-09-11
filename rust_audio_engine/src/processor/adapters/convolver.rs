mod control;
mod handoff;
#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) use control::ConvolverDropProbe;
pub use control::{ConvolverControl, ConvolverStatus};

use control::{ConsumerLease, PublishedConvolver};
use handoff::AudioOwned;

use super::{process_fixed_1_to_1, validate_sample_rate, FixedLifecycle};
use crate::processor::traits::{
    validate_processor_channels, AudioBlockMut, FixedInPlaceProcessor, ProcessBufferParts,
    ProcessBuffers, ProcessError, ProcessProgress, ProcessState, StreamingProcessor, TailSpec,
};

const CONVOLVER_ACTIVATION_MS: u32 = 5;

/// FFT convolver adapter with fixed, wait-free ownership hand-off.
pub struct ConvolverProcessor {
    owned: Option<AudioOwned<PublishedConvolver>>,
    incoming: Option<AudioOwned<PublishedConvolver>>,
    pending_retire: Option<AudioOwned<PublishedConvolver>>,
    control: ConvolverControl,
    lifecycle: FixedLifecycle,
    sample_rate_hz: u32,
    finish_remaining_frames: Option<usize>,
    finish_generation: Option<u64>,
    transition_remaining_frames: usize,
    transition_total_frames: usize,
    transition_cursor: usize,
    transition_start_wet: f64,
    transition_target_wet: f64,
    waiting_for_kernel: bool,
    dry_wait_rendered: bool,
    // Keep the lease last so local heavy ownership is dropped before another
    // consumer can acquire the control during non-RT teardown.
    _consumer_lease: ConsumerLease,
}

impl ConvolverProcessor {
    /// Acquire the control's single audio-consumer lease and create an idle adapter.
    ///
    /// Returns [`ProcessError::ConsumerAlreadyActive`] when another processor
    /// already owns the same control handle.
    pub fn new(control: ConvolverControl) -> Result<Self, ProcessError> {
        let consumer_lease = control.acquire_consumer()?;
        let processor = Self {
            owned: None,
            incoming: None,
            pending_retire: None,
            control: control.clone(),
            lifecycle: FixedLifecycle::default(),
            sample_rate_hz: 44_100,
            finish_remaining_frames: None,
            finish_generation: None,
            transition_remaining_frames: 0,
            transition_total_frames: 0,
            transition_cursor: 0,
            transition_start_wet: 0.0,
            transition_target_wet: 0.0,
            waiting_for_kernel: false,
            dry_wait_rendered: false,
            _consumer_lease: consumer_lease,
        };
        control.set_active_sample_rate(44_100);
        control.set_waiting_sample_rate(None);
        Ok(processor)
    }

    /// Clone the control-plane handle associated with this audio consumer.
    pub fn control(&self) -> ConvolverControl {
        self.control.clone()
    }

    fn try_flush_retired(&mut self) {
        if let Some(retired) = self.pending_retire.take() {
            if let Err(retired) = self.control.try_retire(retired) {
                self.pending_retire = Some(retired);
            }
        }
    }

    fn activation_frames(&self) -> usize {
        ((CONVOLVER_ACTIVATION_MS as u64 * self.sample_rate_hz as u64).div_ceil(1_000)).max(1)
            as usize
    }

    fn current_wet_weight(&self) -> f64 {
        if !self.transition_active() || self.transition_total_frames <= 1 {
            return self.transition_target_wet;
        }
        let t = self.transition_cursor.min(self.transition_total_frames - 1) as f64
            / (self.transition_total_frames - 1) as f64;
        let smooth = t * t * (3.0 - 2.0 * t);
        self.transition_start_wet
            + (self.transition_target_wet - self.transition_start_wet) * smooth
    }

    fn set_steady_wet(&mut self, wet: f64) {
        self.transition_remaining_frames = 0;
        self.transition_total_frames = 0;
        self.transition_cursor = 0;
        self.transition_start_wet = wet;
        self.transition_target_wet = wet;
    }

    fn begin_transition(&mut self, target_wet: f64) {
        let start_wet = self.current_wet_weight();
        if start_wet == target_wet {
            self.set_steady_wet(target_wet);
            return;
        }
        self.transition_total_frames = self.activation_frames();
        self.transition_remaining_frames = self.transition_total_frames;
        self.transition_cursor = 0;
        self.transition_start_wet = start_wet;
        self.transition_target_wet = target_wet;
    }

    fn transition_active(&self) -> bool {
        self.transition_remaining_frames != 0
    }

    fn current_finish_frames(&self) -> usize {
        let kernel_tail = self
            .owned
            .as_ref()
            .filter(|owned| owned.get().sample_rate_hz == self.sample_rate_hz)
            .map(|owned| owned.get().kernel.ir_length().saturating_sub(1))
            .unwrap_or(0);
        if self.transition_active() && self.transition_target_wet == 0.0 {
            kernel_tail.min(self.transition_remaining_frames)
        } else {
            kernel_tail
        }
    }

    fn process_kernel(
        &mut self,
        buffers: ProcessBuffers<'_>,
        ramp: bool,
    ) -> Result<ProcessProgress, ProcessError> {
        let transition_cursor = self.transition_cursor;
        let transition_total_frames = self.transition_total_frames;
        let transition_start_wet = self.transition_start_wet;
        let transition_target_wet = self.transition_target_wet;
        let Some(owned) = self.owned.as_mut() else {
            return process_fixed_1_to_1("Convolver", false, None, buffers, |_, _| Ok(()));
        };
        if owned.get().sample_rate_hz != self.sample_rate_hz {
            return process_fixed_1_to_1("Convolver", false, None, buffers, |_, _| Ok(()));
        }
        let channels = owned.get().kernel.channels();
        validate_processor_channels("Convolver", Some(channels), buffers.channels())?;
        match buffers.into_parts() {
            ProcessBufferParts::InPlace(mut block) => {
                let frames = block.frames();
                if ramp {
                    owned
                        .get_mut()
                        .kernel
                        .try_process_inplace_with_wet_transition(
                            block.samples_mut(),
                            transition_cursor,
                            transition_total_frames,
                            transition_start_wet,
                            transition_target_wet,
                        )?;
                } else {
                    owned
                        .get_mut()
                        .kernel
                        .process_inplace(block.samples_mut())?;
                }
                self.advance_transition(frames);
                Ok(ProcessProgress::new(
                    frames,
                    frames,
                    ProcessState::NeedInput,
                ))
            }
            ProcessBufferParts::OutOfPlace { input, mut output } => {
                let frames = input.frames().min(output.frames());
                let samples = frames * channels;
                output.samples_mut()[..samples].copy_from_slice(&input.samples()[..samples]);
                if ramp {
                    owned
                        .get_mut()
                        .kernel
                        .try_process_inplace_with_wet_transition(
                            &mut output.samples_mut()[..samples],
                            transition_cursor,
                            transition_total_frames,
                            transition_start_wet,
                            transition_target_wet,
                        )?;
                } else {
                    owned
                        .get_mut()
                        .kernel
                        .process_inplace(&mut output.samples_mut()[..samples])?;
                }
                self.advance_transition(frames);
                let state = if frames < input.frames() {
                    ProcessState::NeedOutput
                } else {
                    ProcessState::NeedInput
                };
                Ok(ProcessProgress::new(frames, frames, state))
            }
        }
    }

    fn advance_transition(&mut self, frames: usize) {
        if !self.transition_active() {
            return;
        }
        self.transition_cursor = self.transition_cursor.saturating_add(frames);
        self.transition_remaining_frames = self
            .transition_total_frames
            .saturating_sub(self.transition_cursor);
        if self.transition_remaining_frames == 0 {
            self.transition_start_wet = self.transition_target_wet;
        }
    }

    fn sync_convolver(&mut self) {
        self.try_flush_retired();

        // A rate boundary invalidates both the kernel's physical domain and
        // its accumulated overlap/partition history. Keep ownership local if
        // the retirement slot is backpressured, but never run it again.
        let owned_rate_mismatch = self
            .owned
            .as_ref()
            .is_some_and(|owned| owned.get().sample_rate_hz != self.sample_rate_hz);
        if owned_rate_mismatch && self.pending_retire.is_none() {
            if let Some(current) = self.owned.take() {
                self.pending_retire = Some(current);
                self.control.note_retired();
                self.try_flush_retired();
            }
        }

        if self.incoming.is_none() {
            self.incoming = self.control.take_published();
        }

        let incoming_rate_mismatch = self
            .incoming
            .as_ref()
            .is_some_and(|incoming| incoming.get().sample_rate_hz != self.sample_rate_hz);
        if incoming_rate_mismatch && self.pending_retire.is_none() {
            if let Some(incoming) = self.incoming.take() {
                self.pending_retire = Some(incoming);
                self.control.note_discarded();
                self.control.note_retired();
                self.try_flush_retired();
            }
        }

        if !self.control.is_enabled() {
            self.waiting_for_kernel = false;
            self.dry_wait_rendered = false;
            self.set_steady_wet(0.0);
            self.control.set_waiting_sample_rate(None);
            if self.pending_retire.is_none() {
                if let Some(current) = self.owned.take() {
                    self.pending_retire = Some(current);
                    self.control.note_retired();
                    self.try_flush_retired();
                } else if let Some(incoming) = self.incoming.take() {
                    self.pending_retire = Some(incoming);
                    self.control.note_discarded();
                    self.control.note_retired();
                    self.try_flush_retired();
                }
            }

            let still_holding =
                self.owned.is_some() || self.incoming.is_some() || self.pending_retire.is_some();
            if still_holding {
                self.control.mark_backpressured();
            } else {
                self.control.clear_backpressure();
                self.control.acknowledge_drained();
            }
            return;
        }

        let owned_matches = self
            .owned
            .as_ref()
            .is_some_and(|owned| owned.get().sample_rate_hz == self.sample_rate_hz);
        let held_rate_mismatch = self
            .owned
            .as_ref()
            .is_some_and(|owned| owned.get().sample_rate_hz != self.sample_rate_hz)
            || self
                .incoming
                .as_ref()
                .is_some_and(|incoming| incoming.get().sample_rate_hz != self.sample_rate_hz);
        if held_rate_mismatch {
            self.control.mark_backpressured();
            self.control
                .set_waiting_sample_rate(Some(self.sample_rate_hz));
            return;
        }

        let Some(incoming) = self.incoming.take() else {
            if self.pending_retire.is_some() {
                self.control.mark_backpressured();
            } else {
                self.control.clear_backpressure();
            }
            self.control
                .set_waiting_sample_rate((!owned_matches).then_some(self.sample_rate_hz));
            self.waiting_for_kernel = !owned_matches;
            return;
        };
        if incoming.get().sample_rate_hz != self.sample_rate_hz {
            // A full retirement slot can race the earlier mismatch branch.
            // Retain unique ownership for the next bounded boundary instead
            // of destroying it on the audio thread.
            self.incoming = Some(incoming);
            self.control.mark_backpressured();
            self.control
                .set_waiting_sample_rate(Some(self.sample_rate_hz));
            return;
        }
        let generation = incoming.get().generation;
        match self.owned.take() {
            None => {
                self.owned = Some(incoming);
                self.control.note_adopted(generation);
                self.control.clear_backpressure();
                self.control.set_waiting_sample_rate(None);
                if self.dry_wait_rendered {
                    self.begin_transition(1.0);
                } else {
                    self.set_steady_wet(1.0);
                }
                self.waiting_for_kernel = false;
                self.dry_wait_rendered = false;
            }
            Some(old) if self.pending_retire.is_none() => {
                self.owned = Some(incoming);
                self.control.note_adopted(generation);
                self.pending_retire = Some(old);
                self.control.note_retired();
                self.try_flush_retired();
                if self.pending_retire.is_some() {
                    self.control.mark_backpressured();
                } else {
                    self.control.clear_backpressure();
                }
                self.control.set_waiting_sample_rate(None);
                self.waiting_for_kernel = false;
                if !self.transition_active() {
                    self.set_steady_wet(1.0);
                }
            }
            Some(old) => {
                self.owned = Some(old);
                self.incoming = Some(incoming);
                self.control.mark_backpressured();
                self.control.set_waiting_sample_rate(None);
            }
        }
    }
}

impl Drop for ConvolverProcessor {
    fn drop(&mut self) {
        // Processor teardown is a control-thread operation. Release every
        // audio-local owner before publishing the final drained generation.
        drop(self.pending_retire.take());
        drop(self.incoming.take());
        drop(self.owned.take());
        self.control.acknowledge_drained();
    }
}

impl StreamingProcessor for ConvolverProcessor {
    fn name(&self) -> &'static str {
        "Convolver"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        self.lifecycle.ensure_processing("Convolver")?;
        let requested_enabled = self.control.is_enabled();

        if !requested_enabled {
            let has_matching_kernel = self
                .owned
                .as_ref()
                .is_some_and(|owned| owned.get().sample_rate_hz == self.sample_rate_hz);
            if has_matching_kernel
                && (!self.transition_active() || self.transition_target_wet != 0.0)
            {
                self.begin_transition(0.0);
            }
            if has_matching_kernel && self.transition_active() {
                let progress = self.process_kernel(buffers, true)?;
                if !self.transition_active() {
                    self.sync_convolver();
                }
                return Ok(progress);
            }
            self.sync_convolver();
            return process_fixed_1_to_1("Convolver", false, None, buffers, |_, _| Ok(()));
        }

        self.sync_convolver();
        let has_matching_kernel = self
            .owned
            .as_ref()
            .is_some_and(|owned| owned.get().sample_rate_hz == self.sample_rate_hz);
        if !has_matching_kernel {
            let progress = process_fixed_1_to_1("Convolver", false, None, buffers, |_, _| Ok(()))?;
            self.dry_wait_rendered |= progress.produced_frames() > 0;
            return Ok(progress);
        }
        if self.current_wet_weight() < 1.0
            && (!self.transition_active() || self.transition_target_wet != 1.0)
        {
            self.begin_transition(1.0);
        }
        self.process_kernel(buffers, self.transition_active())
    }

    fn finish(&mut self, output: AudioBlockMut<'_>) -> Result<ProcessProgress, ProcessError> {
        let enabled = self.control.is_enabled();
        if self.lifecycle.is_finished() {
            if !enabled {
                self.sync_convolver();
            }
            return Ok(ProcessProgress::finished(0));
        }

        let already_finishing = self.finish_remaining_frames.is_some();
        if !already_finishing && enabled {
            self.sync_convolver();
        }

        let channels = self
            .owned
            .as_ref()
            .filter(|convolver| convolver.get().sample_rate_hz == self.sample_rate_hz)
            .map(|convolver| convolver.get().kernel.channels());
        validate_processor_channels("Convolver", channels, output.channels())?;

        if !already_finishing {
            self.lifecycle.begin_finish();
            let generation = self
                .owned
                .as_ref()
                .filter(|convolver| convolver.get().sample_rate_hz == self.sample_rate_hz)
                .map(|convolver| convolver.get().generation);
            let remaining = self.current_finish_frames();
            self.finish_generation = generation;
            self.finish_remaining_frames = Some(remaining);
        }

        let remaining = self.finish_remaining_frames.ok_or(ProcessError::Backend {
            processor: "Convolver",
            operation: "finish",
            message: "finish state was not initialized",
        })?;
        if remaining == 0 {
            return Ok(self.lifecycle.finish());
        }

        let mut output = output;
        let frames = output.frames().min(remaining);
        let samples = frames * output.channels();
        output.samples_mut()[..samples].fill(0.0);
        if frames > 0 {
            let ramp = self.transition_active();
            let transition_cursor = self.transition_cursor;
            let transition_total_frames = self.transition_total_frames;
            let transition_start_wet = self.transition_start_wet;
            let transition_target_wet = self.transition_target_wet;
            let Some(owned) = self.owned.as_mut() else {
                return Err(ProcessError::Backend {
                    processor: "Convolver",
                    operation: "finish",
                    message: "finish-locked kernel is missing",
                });
            };
            let convolver = owned.get_mut();
            if Some(convolver.generation) != self.finish_generation {
                return Err(ProcessError::Backend {
                    processor: "Convolver",
                    operation: "finish",
                    message: "finish-locked generation changed",
                });
            }
            if ramp {
                convolver.kernel.try_process_inplace_with_wet_transition(
                    &mut output.samples_mut()[..samples],
                    transition_cursor,
                    transition_total_frames,
                    transition_start_wet,
                    transition_target_wet,
                )?;
            } else {
                convolver
                    .kernel
                    .process_inplace(&mut output.samples_mut()[..samples])?;
            }
            self.advance_transition(frames);
        }
        let remaining = remaining - frames;
        self.finish_remaining_frames = Some(remaining);

        if remaining == 0 {
            let _ = self.lifecycle.finish();
            Ok(ProcessProgress::finished(frames))
        } else {
            Ok(ProcessProgress::new(0, frames, ProcessState::NeedOutput))
        }
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        if let Some(owned) = self.owned.as_mut() {
            owned.get_mut().kernel.reset();
        }
        self.lifecycle.reset();
        self.finish_remaining_frames = None;
        self.finish_generation = None;
        let wet = if self.control.is_enabled()
            && self
                .owned
                .as_ref()
                .is_some_and(|owned| owned.get().sample_rate_hz == self.sample_rate_hz)
        {
            1.0
        } else {
            0.0
        };
        self.set_steady_wet(wet);
        self.waiting_for_kernel = false;
        self.dry_wait_rendered = false;
        Ok(())
    }

    fn tail(&self) -> TailSpec {
        if let Some(remaining) = self.finish_remaining_frames {
            return TailSpec::finite(remaining, self.sample_rate_hz).unwrap_or(TailSpec::Unknown);
        }
        let frames = self.current_finish_frames();
        TailSpec::finite(frames, self.sample_rate_hz).unwrap_or(TailSpec::Unknown)
    }

    fn set_sample_rate(&mut self, sample_rate_hz: u32) -> Result<(), ProcessError> {
        validate_sample_rate("Convolver", sample_rate_hz)?;
        self.sample_rate_hz = sample_rate_hz;
        self.control.set_active_sample_rate(sample_rate_hz);
        if let Some(owned) = self.owned.as_mut() {
            if owned.get().sample_rate_hz != sample_rate_hz {
                owned.get_mut().kernel.reset();
            }
        }
        self.control
            .set_waiting_sample_rate(self.control.is_enabled().then_some(sample_rate_hz));
        self.waiting_for_kernel = self.control.is_enabled();
        self.dry_wait_rendered = false;
        self.set_steady_wet(0.0);
        self.lifecycle.reset();
        self.finish_remaining_frames = None;
        self.finish_generation = None;
        Ok(())
    }
}

impl FixedInPlaceProcessor for ConvolverProcessor {}
