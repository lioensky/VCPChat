use super::*;
use crate::processor::traits::ProcessBufferParts;

fn process_test_stage<F>(
    enabled: bool,
    buffers: ProcessBuffers<'_>,
    mut apply: F,
) -> Result<ProcessProgress, ProcessError>
where
    F: FnMut(&mut f64),
{
    let progress = match buffers.into_parts() {
        super::super::traits::ProcessBufferParts::InPlace(mut block) => {
            if enabled {
                block.samples_mut().iter_mut().for_each(&mut apply);
            }
            ProcessProgress::new(block.frames(), block.frames(), ProcessState::NeedInput)
                .with_bypassed(!enabled)
        }
        super::super::traits::ProcessBufferParts::OutOfPlace { input, mut output } => {
            let frames = input.frames().min(output.frames());
            let samples = frames * input.channels();
            output.samples_mut()[..samples].copy_from_slice(&input.samples()[..samples]);
            if enabled {
                output.samples_mut()[..samples]
                    .iter_mut()
                    .for_each(&mut apply);
            }
            let state = if frames < input.frames() {
                ProcessState::NeedOutput
            } else {
                ProcessState::NeedInput
            };
            ProcessProgress::new(frames, frames, state).with_bypassed(!enabled)
        }
    };
    Ok(progress)
}

// Test processor that doubles samples
struct DoublerProcessor {
    enabled: bool,
    processed_count: u64,
}

impl DoublerProcessor {
    fn new() -> Self {
        Self {
            enabled: true,
            processed_count: 0,
        }
    }

    fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }
}

impl StreamingProcessor for DoublerProcessor {
    fn name(&self) -> &'static str {
        "Doubler"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        let progress = process_test_stage(self.enabled, buffers, |sample| *sample *= 2.0)?;
        if self.enabled {
            self.processed_count += 1;
        }
        Ok(progress)
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        self.processed_count = 0;
        Ok(())
    }
}

// Test processor that adds 1.0
struct AdderProcessor {
    enabled: bool,
}

impl AdderProcessor {
    fn new() -> Self {
        Self { enabled: true }
    }
}

impl StreamingProcessor for AdderProcessor {
    fn name(&self) -> &'static str {
        "Adder"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        process_test_stage(self.enabled, buffers, |sample| *sample += 1.0)
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        Ok(())
    }
}

/// Minimal stage that reports a different output rate than its input rate,
/// standing in for an unequal-rate `StreamingResampler` without pulling a
/// backend into this module.
struct RateChangingStage {
    output_sample_rate_hz: u32,
}

impl StreamingProcessor for RateChangingStage {
    fn name(&self) -> &'static str {
        "RateChangingStage"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        process_test_stage(true, buffers, |_| {})
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        Ok(())
    }

    fn output_sample_rate_hz(&self, _input_sample_rate_hz: u32) -> Result<u32, ProcessError> {
        Ok(self.output_sample_rate_hz)
    }
}

#[test]
fn add_rejects_a_stage_that_does_not_map_the_chain_rate_to_itself() {
    let mut chain = DspChain::new(48_000).unwrap();

    let Err(error) = chain.add(RateChangingStage {
        output_sample_rate_hz: 96_000,
    }) else {
        panic!("a rate-transforming stage cannot run in a fixed in-place chain");
    };

    assert!(matches!(
        error,
        ProcessError::UnsupportedOperation {
            processor: "RateChangingStage",
            operation: "DspChain::add",
            ..
        }
    ));
    assert!(chain.is_empty(), "a rejected stage must not be retained");

    // The same stage is accepted when it is rate-preserving at this chain rate.
    chain
        .add(RateChangingStage {
            output_sample_rate_hz: 48_000,
        })
        .unwrap();
    assert_eq!(chain.len(), 1);
}

#[test]
fn constructors_reject_a_zero_rate_before_a_chain_exists() {
    for result in [DspChain::new(0), DspChain::with_capacity(4, 0)] {
        assert!(matches!(
            result,
            Err(ProcessError::InvalidSampleRate {
                processor: "DspChain",
                sample_rate_hz: 0,
            })
        ));
    }
}

#[test]
fn test_empty_chain() {
    let mut chain = DspChain::new(44_100).unwrap();
    let mut buffer = vec![1.0, 2.0, 3.0];
    let progress = chain.process(&mut buffer, 1).unwrap();
    assert_eq!(buffer, vec![1.0, 2.0, 3.0]);
    assert_eq!(progress.consumed_frames(), 3);
    assert_eq!(progress.produced_frames(), 3);
    assert!(progress.is_bypassed());
}

#[test]
fn test_single_processor() {
    let mut chain = DspChain::new(44_100).unwrap();
    chain.add(DoublerProcessor::new()).unwrap();

    let mut buffer = vec![1.0, 2.0, 3.0];
    let _ = chain.process(&mut buffer, 1).unwrap();

    assert_eq!(buffer, vec![2.0, 4.0, 6.0]);
}

#[test]
fn test_chain_order() {
    let mut chain = DspChain::new(44_100).unwrap();
    chain.add(DoublerProcessor::new()).unwrap(); // Doubles first
    chain.add(AdderProcessor::new()).unwrap(); // Then adds 1

    // Start with 1.0 -> 2.0 (double) -> 3.0 (add 1)
    let mut buffer = vec![1.0];
    let _ = chain.process(&mut buffer, 1).unwrap();
    assert_eq!(buffer, vec![3.0]);
}

#[test]
fn test_processor_names_follow_execution_order() {
    let mut chain = DspChain::new(44_100).unwrap();
    chain.add(DoublerProcessor::new()).unwrap();
    chain.add(AdderProcessor::new()).unwrap();

    assert_eq!(chain.processor_names(), vec!["Doubler", "Adder"]);
}

#[test]
fn test_bypassed_processor() {
    let mut chain = DspChain::new(44_100).unwrap();
    let mut doubler = DoublerProcessor::new();
    doubler.set_enabled(false);
    chain.add(doubler).unwrap();

    let mut buffer = vec![5.0];
    let progress = chain.process(&mut buffer, 1).unwrap();

    // Should be unchanged (bypassed)
    assert_eq!(buffer, vec![5.0]);
    assert!(progress.is_bypassed());
}

#[test]
fn test_reset() {
    let mut chain = DspChain::new(44_100).unwrap();
    chain.add(DoublerProcessor::new()).unwrap();

    let mut buffer = vec![1.0; 100];
    let _ = chain.process(&mut buffer, 1).unwrap();
    chain.reset().unwrap();
}

#[test]
fn process_rejects_invalid_interleaved_shape() {
    let mut chain = DspChain::new(44_100).unwrap();
    let mut buffer = [0.0; 3];

    assert!(matches!(
        chain.process(&mut buffer, 2),
        Err(ProcessError::InvalidBlock(_))
    ));
}

#[test]
fn set_sample_rate_rejects_zero() {
    let mut chain = DspChain::new(44_100).unwrap();
    assert_eq!(
        chain.set_sample_rate(0),
        Err(ProcessError::InvalidSampleRate {
            processor: "DspChain",
            sample_rate_hz: 0,
        })
    );
}

#[test]
fn steady_state_process_is_allocation_free() {
    let mut chain = DspChain::new(48_000).unwrap();
    chain.add(DoublerProcessor::new()).unwrap();
    let mut buffer = [0.25; 512 * 2];
    let _ = chain.process(&mut buffer, 2).unwrap();

    assert_no_alloc::assert_no_alloc(|| {
        let _ = chain.process(&mut buffer, 2).unwrap();
    });
}

struct UnknownDecay {
    state: f64,
    finished: bool,
}

struct UnknownImpulseThenSilence {
    generated_frames: usize,
}

impl StreamingProcessor for UnknownImpulseThenSilence {
    fn name(&self) -> &'static str {
        "UnknownImpulseThenSilence"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        match buffers.into_parts() {
            ProcessBufferParts::InPlace(block) => Ok(ProcessProgress::new(
                block.frames(),
                block.frames(),
                ProcessState::NeedInput,
            )),
            ProcessBufferParts::OutOfPlace { .. } => Err(ProcessError::UnsupportedBufferMode {
                processor: self.name(),
                mode: super::super::traits::ProcessBufferMode::OutOfPlace,
            }),
        }
    }

    fn finish(&mut self, mut output: AudioBlockMut<'_>) -> Result<ProcessProgress, ProcessError> {
        let channels = output.channels();
        for frame in output.samples_mut().chunks_exact_mut(channels) {
            let sample = if self.generated_frames == 0 { 1.0 } else { 0.0 };
            frame.fill(sample);
            self.generated_frames += 1;
        }
        Ok(ProcessProgress::new(
            0,
            output.frames(),
            ProcessState::NeedOutput,
        ))
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        self.generated_frames = 0;
        Ok(())
    }

    fn tail(&self) -> TailSpec {
        TailSpec::Unknown
    }
}

impl StreamingProcessor for UnknownDecay {
    fn name(&self) -> &'static str {
        "UnknownDecay"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        match buffers.into_parts() {
            ProcessBufferParts::InPlace(mut block) => {
                if self.finished {
                    return Err(ProcessError::AlreadyFinished {
                        processor: self.name(),
                    });
                }
                for sample in block.samples_mut() {
                    self.state = *sample;
                }
                Ok(ProcessProgress::new(
                    block.frames(),
                    block.frames(),
                    ProcessState::NeedInput,
                ))
            }
            ProcessBufferParts::OutOfPlace { .. } => Err(ProcessError::UnsupportedBufferMode {
                processor: self.name(),
                mode: super::super::traits::ProcessBufferMode::OutOfPlace,
            }),
        }
    }

    fn finish(&mut self, mut output: AudioBlockMut<'_>) -> Result<ProcessProgress, ProcessError> {
        if self.finished {
            return Ok(ProcessProgress::finished(0));
        }
        for sample in output.samples_mut() {
            *sample = self.state;
        }
        self.state *= 0.5;
        Ok(ProcessProgress::new(
            0,
            output.frames(),
            ProcessState::NeedOutput,
        ))
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        self.state = 0.0;
        self.finished = false;
        Ok(())
    }

    fn tail(&self) -> TailSpec {
        TailSpec::Unknown
    }
}

struct GainProcessor;

impl StreamingProcessor for GainProcessor {
    fn name(&self) -> &'static str {
        "Gain"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        match buffers.into_parts() {
            ProcessBufferParts::InPlace(mut block) => {
                for sample in block.samples_mut() {
                    *sample *= 2.0;
                }
                Ok(ProcessProgress::new(
                    block.frames(),
                    block.frames(),
                    ProcessState::NeedInput,
                ))
            }
            ProcessBufferParts::OutOfPlace { .. } => Err(ProcessError::UnsupportedBufferMode {
                processor: self.name(),
                mode: super::super::traits::ProcessBufferMode::OutOfPlace,
            }),
        }
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        Ok(())
    }
}

struct TerminalNoise {
    level: f64,
}

struct FractionalTail(FrameDuration);

impl StreamingProcessor for FractionalTail {
    fn name(&self) -> &'static str {
        "FractionalTail"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        match buffers.into_parts() {
            ProcessBufferParts::InPlace(block) => Ok(ProcessProgress::new(
                block.frames(),
                block.frames(),
                ProcessState::NeedInput,
            )),
            ProcessBufferParts::OutOfPlace { .. } => Err(ProcessError::UnsupportedBufferMode {
                processor: self.name(),
                mode: super::super::traits::ProcessBufferMode::OutOfPlace,
            }),
        }
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        Ok(())
    }

    fn tail(&self) -> TailSpec {
        TailSpec::Finite(self.0)
    }
}

impl StreamingProcessor for TerminalNoise {
    fn name(&self) -> &'static str {
        "TerminalNoise"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        match buffers.into_parts() {
            ProcessBufferParts::InPlace(mut block) => {
                for sample in block.samples_mut() {
                    *sample += self.level;
                }
                Ok(ProcessProgress::new(
                    block.frames(),
                    block.frames(),
                    ProcessState::NeedInput,
                ))
            }
            ProcessBufferParts::OutOfPlace { .. } => Err(ProcessError::UnsupportedBufferMode {
                processor: self.name(),
                mode: super::super::traits::ProcessBufferMode::OutOfPlace,
            }),
        }
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        Ok(())
    }

    fn tail_energy_observation_barrier(&self) -> bool {
        true
    }
}

struct LateFinitePulse {
    delay_frames: usize,
    remaining_frames: usize,
    pulse: f64,
    armed: bool,
}

impl StreamingProcessor for LateFinitePulse {
    fn name(&self) -> &'static str {
        "LateFinitePulse"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        match buffers.into_parts() {
            ProcessBufferParts::InPlace(mut block) => {
                for sample in block.samples_mut() {
                    if !self.armed {
                        self.pulse = *sample;
                        self.remaining_frames = self.delay_frames;
                        self.armed = true;
                        *sample = 0.0;
                    } else if self.remaining_frames > 0 {
                        self.remaining_frames -= 1;
                        *sample = if self.remaining_frames == 0 {
                            self.pulse
                        } else {
                            0.0
                        };
                    } else {
                        *sample = 0.0;
                    }
                }
                Ok(ProcessProgress::new(
                    block.frames(),
                    block.frames(),
                    ProcessState::NeedInput,
                ))
            }
            ProcessBufferParts::OutOfPlace { .. } => Err(ProcessError::UnsupportedBufferMode {
                processor: self.name(),
                mode: super::super::traits::ProcessBufferMode::OutOfPlace,
            }),
        }
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        self.remaining_frames = 0;
        self.pulse = 0.0;
        self.armed = false;
        Ok(())
    }

    fn tail(&self) -> TailSpec {
        TailSpec::finite(self.delay_frames, 48_000).unwrap()
    }
}

impl FixedInPlaceProcessor for DoublerProcessor {}
impl FixedInPlaceProcessor for AdderProcessor {}
impl FixedInPlaceProcessor for RateChangingStage {}
impl FixedInPlaceProcessor for UnknownImpulseThenSilence {}
impl FixedInPlaceProcessor for UnknownDecay {}
impl FixedInPlaceProcessor for GainProcessor {}
impl FixedInPlaceProcessor for FractionalTail {}
impl FixedInPlaceProcessor for TerminalNoise {}
impl FixedInPlaceProcessor for LateFinitePulse {}

#[test]
fn finish_drives_unknown_tail_through_downstream_without_scratch() {
    let mut chain = DspChain::with_capacity(2, 48_000).unwrap();
    chain
        .add(UnknownDecay {
            state: 0.0,
            finished: false,
        })
        .unwrap();
    chain.add(GainProcessor).unwrap();

    let mut input = [1.0_f64];
    let _ = chain.process(&mut input, 1).unwrap();

    let policy = ChainFinishPolicy::new(-6.0, 2, 20);
    let mut output = [0.0_f64; 4];
    let mut first = None;
    assert_no_alloc::assert_no_alloc(|| {
        first = Some(
            chain
                .finish_with_policy(AudioBlockMut::new(&mut output, 1).unwrap(), policy)
                .unwrap(),
        );
    });
    let first = first.unwrap();
    assert_eq!(first, ProcessProgress::new(0, 4, ProcessState::NeedOutput));
    assert_eq!(output, [2.0, 2.0, 1.0, 1.0]);

    let mut terminal_output = [9.0_f64; 4];
    let terminal = chain
        .finish_with_policy(AudioBlockMut::new(&mut terminal_output, 1).unwrap(), policy)
        .unwrap();
    assert_eq!(terminal, ProcessProgress::finished(2));
    assert_eq!(terminal_output[..2], [0.5, 0.5]);
    assert_eq!(
        chain
            .finish_with_policy(AudioBlockMut::new(&mut terminal_output, 1).unwrap(), policy,)
            .unwrap(),
        ProcessProgress::finished(0)
    );
}

#[test]
fn unknown_tail_stops_at_hold_boundary_independent_of_output_capacity() {
    fn render(output_frames: usize) -> (Vec<f64>, bool) {
        let mut chain = DspChain::new(48_000).unwrap();
        chain
            .add(UnknownImpulseThenSilence {
                generated_frames: 0,
            })
            .unwrap();
        let policy = ChainFinishPolicy::new(-80.0, 3, 20);
        let mut scratch = vec![9.0; output_frames];
        let mut rendered = Vec::new();
        loop {
            let progress = chain
                .finish_with_policy(AudioBlockMut::new(&mut scratch, 1).unwrap(), policy)
                .unwrap();
            rendered.extend_from_slice(&scratch[..progress.produced_frames()]);
            if progress.state() == ProcessState::Finished {
                break;
            }
        }
        (rendered, chain.finish_was_capped())
    }

    let one_frame = render(1);
    let large_block = render(64);
    assert_eq!(one_frame, large_block);
    assert_eq!(large_block.0, [1.0, 0.0, 0.0, 0.0]);
    assert!(!large_block.1);
}

#[test]
fn unknown_tail_waits_for_downstream_finite_support_before_energy_stop() {
    let mut chain = DspChain::with_capacity(2, 48_000).unwrap();
    chain
        .add(UnknownDecay {
            state: 0.0,
            finished: false,
        })
        .unwrap();
    chain
        .add(LateFinitePulse {
            delay_frames: 6,
            remaining_frames: 0,
            pulse: 0.0,
            armed: false,
        })
        .unwrap();
    let mut input = [1.0_f64];
    let _ = chain.process(&mut input, 1).unwrap();

    let policy = ChainFinishPolicy::new(-80.0, 2, 20);
    let mut rendered = Vec::new();
    let mut output = [0.0_f64; 4];
    for _ in 0..16 {
        let progress = chain
            .finish_with_policy(AudioBlockMut::new(&mut output, 1).unwrap(), policy)
            .unwrap();
        rendered.extend_from_slice(&output[..progress.produced_frames()]);
        if progress.state() == ProcessState::Finished {
            break;
        }
    }

    assert!(rendered
        .iter()
        .any(|sample| (*sample - 1.0).abs() <= 1.0e-12));
    assert!(!chain.finish_was_capped());
}

#[test]
fn unknown_tail_energy_is_observed_before_terminal_noise() {
    let mut chain = DspChain::with_capacity(2, 48_000).unwrap();
    chain
        .add(UnknownDecay {
            state: 0.0,
            finished: false,
        })
        .unwrap();
    chain.add(TerminalNoise { level: 0.25 }).unwrap();
    let mut input = [1.0_f64];
    let _ = chain.process(&mut input, 1).unwrap();

    let policy = ChainFinishPolicy::new(-20.0, 2, 20);
    let mut output = [0.0_f64; 1];
    let mut terminal = ProcessProgress::new(0, 0, ProcessState::NeedOutput);
    for _ in 0..24 {
        terminal = chain
            .finish_with_policy(AudioBlockMut::new(&mut output, 1).unwrap(), policy)
            .unwrap();
        if terminal.state() == ProcessState::Finished {
            break;
        }
    }

    assert_eq!(terminal.state(), ProcessState::Finished);
    assert!(!chain.finish_was_capped());
}

#[test]
fn unknown_tail_safety_cap_does_not_overshoot_large_output_blocks() {
    let mut chain = DspChain::new(48_000).unwrap();
    chain
        .add(UnknownDecay {
            state: 0.0,
            finished: false,
        })
        .unwrap();
    let mut input = [1.0_f64];
    let _ = chain.process(&mut input, 1).unwrap();

    let policy = ChainFinishPolicy::new(-120.0, 1, 5);
    let mut output = [0.0_f64; 64];
    let progress = chain
        .finish_with_policy(AudioBlockMut::new(&mut output, 1).unwrap(), policy)
        .unwrap();

    assert_eq!(progress, ProcessProgress::finished(5));
    assert!(chain.finish_was_capped());
}

#[test]
fn capped_unknown_tail_continues_to_downstream_finish_in_the_same_call() {
    let mut chain = DspChain::with_capacity(2, 48_000).unwrap();
    chain
        .add(UnknownDecay {
            state: 0.0,
            finished: false,
        })
        .unwrap();
    chain.add(GainProcessor).unwrap();
    let mut input = [1.0_f64];
    let _ = chain.process(&mut input, 1).unwrap();

    let policy = ChainFinishPolicy::new(-120.0, 1, 5);
    let mut output = [0.0_f64; 64];
    let progress = chain
        .finish_with_policy(AudioBlockMut::new(&mut output, 1).unwrap(), policy)
        .unwrap();

    assert_eq!(progress, ProcessProgress::finished(5));
    assert_eq!(output[..5], [2.0, 1.0, 0.5, 0.25, 0.125]);
    assert!(chain.finish_was_capped());
}

#[test]
fn chain_composes_latency_and_unknown_tail() {
    let mut chain = DspChain::new(48_000).unwrap();
    chain
        .add(UnknownDecay {
            state: 0.0,
            finished: false,
        })
        .unwrap();
    assert_eq!(chain.latency(), FrameDuration::ZERO);
    assert_eq!(chain.tail(), TailSpec::Unknown);
}

#[test]
fn finite_tail_rounding_happens_after_cross_rate_sum() {
    let mut chain = DspChain::new(48_000).unwrap();
    chain
        .add(FractionalTail(FrameDuration::new(1, 96_000).unwrap()))
        .unwrap();
    chain
        .add(FractionalTail(FrameDuration::new(1, 96_000).unwrap()))
        .unwrap();

    assert_eq!(chain.tail(), TailSpec::finite(1, 48_000).unwrap());
}
