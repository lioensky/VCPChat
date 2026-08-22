use super::*;

struct StreamingGain {
    enabled: bool,
    gain: f64,
}

impl StreamingProcessor for StreamingGain {
    fn name(&self) -> &'static str {
        "StreamingGain"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        let progress = match buffers.into_parts() {
            ProcessBufferParts::InPlace(mut block) => {
                if self.enabled {
                    for sample in block.samples_mut() {
                        *sample *= self.gain;
                    }
                }
                ProcessProgress::new(block.frames(), block.frames(), ProcessState::NeedInput)
                    .with_bypassed(!self.enabled)
            }
            ProcessBufferParts::OutOfPlace { input, mut output } => {
                let frames = input.frames().min(output.frames());
                let samples = frames * input.channels();
                let input_samples = &input.samples()[..samples];
                let output_samples = &mut output.samples_mut()[..samples];

                if self.enabled {
                    for (source, destination) in input_samples.iter().zip(output_samples.iter_mut())
                    {
                        *destination = *source * self.gain;
                    }
                } else {
                    output_samples.copy_from_slice(input_samples);
                }

                let state = if frames < input.frames() {
                    ProcessState::NeedOutput
                } else {
                    ProcessState::NeedInput
                };
                ProcessProgress::new(frames, frames, state).with_bypassed(!self.enabled)
            }
        };

        Ok(progress)
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        Ok(())
    }
}

struct FiniteTailProcessor {
    tail_frames: usize,
    remaining_frames: usize,
    sample_rate_hz: u32,
    finished: bool,
}

impl FiniteTailProcessor {
    fn new(tail_frames: usize, sample_rate_hz: u32) -> Self {
        Self {
            tail_frames,
            remaining_frames: tail_frames,
            sample_rate_hz,
            finished: false,
        }
    }
}

impl StreamingProcessor for FiniteTailProcessor {
    fn name(&self) -> &'static str {
        "FiniteTail"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        if self.finished {
            return Err(ProcessError::AlreadyFinished {
                processor: self.name(),
            });
        }

        let progress = match buffers.into_parts() {
            ProcessBufferParts::InPlace(block) => {
                ProcessProgress::new(block.frames(), block.frames(), ProcessState::NeedInput)
            }
            ProcessBufferParts::OutOfPlace { input, mut output } => {
                let frames = input.frames().min(output.frames());
                let samples = frames * input.channels();
                output.samples_mut()[..samples].copy_from_slice(&input.samples()[..samples]);
                let state = if frames < input.frames() {
                    ProcessState::NeedOutput
                } else {
                    ProcessState::NeedInput
                };
                ProcessProgress::new(frames, frames, state)
            }
        };
        Ok(progress)
    }

    fn finish(&mut self, mut output: AudioBlockMut<'_>) -> Result<ProcessProgress, ProcessError> {
        if self.finished {
            return Ok(ProcessProgress::finished(0));
        }

        let produced = self.remaining_frames.min(output.frames());
        let produced_samples = produced * output.channels();
        output.samples_mut()[..produced_samples].fill(0.25);
        self.remaining_frames -= produced;

        if self.remaining_frames == 0 {
            self.finished = true;
            Ok(ProcessProgress::finished(produced))
        } else {
            Ok(ProcessProgress::new(0, produced, ProcessState::NeedOutput))
        }
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        self.remaining_frames = self.tail_frames;
        self.finished = false;
        Ok(())
    }

    fn tail(&self) -> TailSpec {
        TailSpec::finite(self.tail_frames, self.sample_rate_hz)
            .expect("test processor uses a non-zero sample rate")
    }
}

#[test]
fn audio_block_views_validate_complete_interleaved_frames() {
    let input = [1.0, 2.0, 3.0, 4.0];
    let block = AudioBlockRef::new(&input, 2).unwrap();
    assert_eq!(block.channels(), 2);
    assert_eq!(block.frames(), 2);
    assert_eq!(block.sample_count(), 4);
    assert_eq!(block.samples().as_ptr(), input.as_ptr());

    assert_eq!(
        AudioBlockRef::new(&input, 0).unwrap_err(),
        AudioBlockError::ZeroChannels
    );
    assert_eq!(
        AudioBlockRef::new(&input[..3], 2).unwrap_err(),
        AudioBlockError::IncompleteFrame {
            samples: 3,
            channels: 2,
        }
    );

    let mut mutable = input;
    assert_eq!(
        AudioBlockMut::new(&mut mutable, 0).unwrap_err(),
        AudioBlockError::ZeroChannels
    );
    assert_eq!(
        AudioBlockMut::new(&mut mutable[..3], 2).unwrap_err(),
        AudioBlockError::IncompleteFrame {
            samples: 3,
            channels: 2,
        }
    );
}

#[test]
fn configured_channel_and_sample_rate_validation_is_shared_and_allocation_free() {
    assert_no_alloc::assert_no_alloc(|| {
        assert_eq!(
            validate_processor_channels("test", Some(2), 1),
            Err(ProcessError::ChannelCountMismatch {
                processor: "test",
                expected_channels: 2,
                actual_channels: 1,
            })
        );
        assert_eq!(validate_processor_channels("test", Some(2), 2), Ok(()));
        assert_eq!(validate_processor_channels("test", None, 8), Ok(()));
        assert_eq!(
            validate_sample_rate_hz("test", 0),
            Err(ProcessError::InvalidSampleRate {
                processor: "test",
                sample_rate_hz: 0,
            })
        );
        assert_eq!(validate_sample_rate_hz("test", 48_000), Ok(()));
    });
}

#[test]
fn mutable_audio_block_is_zero_copy_and_reborrowable() {
    let mut samples = [1.0, 2.0, 3.0, 4.0];
    let original_ptr = samples.as_ptr();
    {
        let mut block = AudioBlockMut::new(&mut samples, 2).unwrap();
        assert_eq!(block.samples().as_ptr(), original_ptr);
        block.samples_mut()[1] = 8.0;

        let mut shorter = block.reborrow();
        shorter.samples_mut()[2] = 9.0;
        assert_eq!(shorter.as_ref().frames(), 2);
    }
    assert_eq!(samples, [1.0, 8.0, 9.0, 4.0]);
}

#[test]
fn out_of_place_buffers_require_matching_channels() {
    let input = [1.0, 2.0, 3.0, 4.0];
    let mut output = [0.0; 4];
    let input = AudioBlockRef::new(&input, 2).unwrap();
    let output = AudioBlockMut::new(&mut output, 1).unwrap();

    assert_eq!(
        ProcessBuffers::out_of_place(input, output).unwrap_err(),
        AudioBlockError::ChannelMismatch {
            input_channels: 2,
            output_channels: 1,
        }
    );
}

#[test]
fn process_capacity_rejects_overrun_wrong_direction_and_stall() {
    let capacity = ProcessCapacity::new(4, 4);
    let valid = ProcessProgress::new(4, 3, ProcessState::NeedInput);
    assert_eq!(capacity.validate("test", valid), Ok(valid));

    let overrun = ProcessProgress::new(5, 4, ProcessState::NeedInput);
    assert!(matches!(
        capacity.validate("test", overrun),
        Err(ProcessError::InvalidProgress { .. })
    ));

    let wrong_direction = ProcessProgress::new(3, 4, ProcessState::NeedInput);
    assert!(matches!(
        capacity.validate("test", wrong_direction),
        Err(ProcessError::InvalidProgress { .. })
    ));

    let partial_in_place = ProcessProgress::new(3, 4, ProcessState::NeedOutput);
    assert!(matches!(
        ProcessCapacity::in_place(4).validate("test", partial_in_place),
        Err(ProcessError::InvalidProgress { .. })
    ));

    let process_finished = ProcessProgress::new(4, 4, ProcessState::Finished);
    assert!(matches!(
        capacity.validate("test", process_finished),
        Err(ProcessError::InvalidProgress { .. })
    ));

    let stalled = ProcessProgress::new(0, 0, ProcessState::NeedInput);
    assert_eq!(
        capacity.validate("test", stalled),
        Err(ProcessError::Stalled { processor: "test" })
    );

    let finish_needs_input = ProcessProgress::new(0, 0, ProcessState::NeedInput);
    assert!(matches!(
        ProcessCapacity::for_finish(4).validate("test", finish_needs_input),
        Err(ProcessError::InvalidProgress { .. })
    ));
    let finish_has_more = ProcessProgress::new(0, 4, ProcessState::NeedOutput);
    assert_eq!(
        ProcessCapacity::for_finish(4).validate("test", finish_has_more),
        Ok(finish_has_more)
    );
    let finish_complete = ProcessProgress::finished(3);
    assert_eq!(
        ProcessCapacity::for_finish(4).validate("test", finish_complete),
        Ok(finish_complete)
    );
    assert!(ProcessCapacity::for_finish(4).is_finishing());
    assert_eq!(
        ProcessCapacity::in_place(4).mode(),
        ProcessBufferMode::InPlace
    );
}

#[test]
fn streaming_processor_supports_in_place_out_of_place_and_reported_bypass() {
    let mut processor = StreamingGain {
        enabled: true,
        gain: 0.5,
    };

    let mut in_place = [2.0, 4.0, 6.0, 8.0];
    let block = AudioBlockMut::new(&mut in_place, 2).unwrap();
    let progress = process_checked(&mut processor, ProcessBuffers::in_place(block)).unwrap();
    assert_eq!(progress.consumed_frames(), 2);
    assert_eq!(progress.produced_frames(), 2);
    assert!(!progress.is_bypassed());
    assert_eq!(in_place, [1.0, 2.0, 3.0, 4.0]);

    let input = [2.0, 4.0, 6.0, 8.0];
    let mut output = [0.0; 2];
    let buffers = ProcessBuffers::out_of_place(
        AudioBlockRef::new(&input, 2).unwrap(),
        AudioBlockMut::new(&mut output, 2).unwrap(),
    )
    .unwrap();
    let progress = process_checked(&mut processor, buffers).unwrap();
    assert_eq!(progress.state(), ProcessState::NeedOutput);
    assert_eq!(progress.consumed_frames(), 1);
    assert_eq!(output, [1.0, 2.0]);

    processor.enabled = false;
    let mut bypassed = [3.0, 5.0];
    let block = AudioBlockMut::new(&mut bypassed, 1).unwrap();
    let progress = process_checked(&mut processor, ProcessBuffers::in_place(block)).unwrap();
    assert!(progress.is_bypassed());
    assert_eq!(bypassed, [3.0, 5.0]);
}

#[test]
fn default_finish_and_tail_contract_are_idempotent() {
    let mut processor = StreamingGain {
        enabled: true,
        gain: 0.5,
    };
    let mut output = [0.0; 4];

    for _ in 0..2 {
        let progress =
            finish_checked(&mut processor, AudioBlockMut::new(&mut output, 2).unwrap()).unwrap();
        assert_eq!(progress, ProcessProgress::finished(0));
    }
    assert_eq!(processor.latency(), FrameDuration::ZERO);
    assert_eq!(processor.tail(), TailSpec::None);
    assert_eq!(TailSpec::finite(0, 48_000), Ok(TailSpec::None));
    assert_eq!(
        TailSpec::finite(12, 48_000)
            .unwrap()
            .finite_duration()
            .unwrap()
            .frames(),
        12
    );
    assert_eq!(TailSpec::Unknown.finite_duration(), None);
    assert_eq!(processor.output_sample_rate_hz(48_000), Ok(48_000));
    assert!(matches!(
        processor.output_sample_rate_hz(0),
        Err(ProcessError::InvalidSampleRate { .. })
    ));
}

#[test]
fn frame_duration_carries_rate_and_uses_explicit_rounding() {
    let duration = FrameDuration::new(441, 44_100).unwrap();
    assert_eq!(duration.sample_rate_hz(), Some(44_100));
    assert_eq!(
        duration.rounded_frames_at_rate(48_000, FrameRounding::Nearest),
        Ok(480)
    );
    assert_eq!(duration.frames_at_rate_f64(48_000), Ok(480.0));

    let fractional = FrameDuration::new(1, 44_100).unwrap();
    assert_eq!(
        fractional.rounded_frames_at_rate(48_000, FrameRounding::Floor),
        Ok(1)
    );
    assert_eq!(
        fractional.rounded_frames_at_rate(48_000, FrameRounding::Nearest),
        Ok(1)
    );
    assert_eq!(
        fractional.rounded_frames_at_rate(48_000, FrameRounding::Ceil),
        Ok(2)
    );
    assert_eq!(
        fractional.rounded_frames_at_rate(0, FrameRounding::Nearest),
        Err(TimingError::ZeroSampleRate)
    );
    assert_eq!(FrameDuration::new(0, 0), Err(TimingError::ZeroSampleRate));
}

#[test]
fn stateful_finish_drains_to_terminal_state_and_reset_rearms_stream() {
    let mut processor = FiniteTailProcessor::new(5, 48_000);
    let mut output = [0.0; 4];

    let first =
        finish_checked(&mut processor, AudioBlockMut::new(&mut output, 2).unwrap()).unwrap();
    assert_eq!(first, ProcessProgress::new(0, 2, ProcessState::NeedOutput));
    assert_eq!(output, [0.25; 4]);

    let second =
        finish_checked(&mut processor, AudioBlockMut::new(&mut output, 2).unwrap()).unwrap();
    assert_eq!(second, ProcessProgress::new(0, 2, ProcessState::NeedOutput));

    let third =
        finish_checked(&mut processor, AudioBlockMut::new(&mut output, 2).unwrap()).unwrap();
    assert_eq!(third, ProcessProgress::finished(1));

    for _ in 0..2 {
        let terminal =
            finish_checked(&mut processor, AudioBlockMut::new(&mut output, 2).unwrap()).unwrap();
        assert_eq!(terminal, ProcessProgress::finished(0));
    }

    let mut input = [1.0, 2.0];
    let process_after_finish = process_checked(
        &mut processor,
        ProcessBuffers::in_place(AudioBlockMut::new(&mut input, 1).unwrap()),
    );
    assert_eq!(
        process_after_finish,
        Err(ProcessError::AlreadyFinished {
            processor: "FiniteTail"
        })
    );

    processor.reset().unwrap();
    let after_reset =
        finish_checked(&mut processor, AudioBlockMut::new(&mut output, 2).unwrap()).unwrap();
    assert_eq!(
        after_reset,
        ProcessProgress::new(0, 2, ProcessState::NeedOutput)
    );
    assert_eq!(
        processor.tail().finite_duration(),
        Some(FrameDuration::new(5, 48_000).unwrap())
    );
    assert_eq!(TailSpec::Unknown.finite_duration(), None);
    assert_eq!(TailSpec::Infinite.finite_duration(), None);
}

#[test]
fn process_error_preserves_static_and_owned_backend_diagnostics() {
    let backend = ProcessError::Backend {
        processor: "resampler",
        operation: "drain",
        message: "native drain failed",
    };
    assert_eq!(
        backend.to_string(),
        "processor resampler failed during drain: native drain failed"
    );

    let owned = ProcessError::Owned {
        processor: "resampler",
        operation: "legacy process",
        message: String::from("channel 3 failed"),
    };
    assert_eq!(
        owned.to_string(),
        "processor resampler failed during legacy process: channel 3 failed"
    );
}

#[test]
fn streaming_contract_hot_path_allocates_nothing() {
    let mut processor = StreamingGain {
        enabled: true,
        gain: 0.5,
    };
    let mut samples = [1.0; 8];
    let input = [1.0; 8];
    let mut output = [0.0; 8];
    let mut tail = FiniteTailProcessor::new(5, 48_000);
    let mut tail_output = [0.0; 4];

    assert_no_alloc::assert_no_alloc(|| {
        for _ in 0..32 {
            let block = AudioBlockMut::new(&mut samples, 2).unwrap();
            let buffers = ProcessBuffers::in_place(block);
            let progress = process_checked(&mut processor, buffers).unwrap();
            assert_eq!(progress.produced_frames(), 4);

            let buffers = ProcessBuffers::out_of_place(
                AudioBlockRef::new(&input, 2).unwrap(),
                AudioBlockMut::new(&mut output, 2).unwrap(),
            )
            .unwrap();
            let progress = process_checked(&mut processor, buffers).unwrap();
            assert_eq!(progress.produced_frames(), 4);
        }

        assert_eq!(
            finish_checked(&mut tail, AudioBlockMut::new(&mut tail_output, 2).unwrap())
                .unwrap()
                .state(),
            ProcessState::NeedOutput
        );
        assert_eq!(
            finish_checked(&mut tail, AudioBlockMut::new(&mut tail_output, 2).unwrap())
                .unwrap()
                .state(),
            ProcessState::NeedOutput
        );
        assert_eq!(
            finish_checked(&mut tail, AudioBlockMut::new(&mut tail_output, 2).unwrap())
                .unwrap()
                .state(),
            ProcessState::Finished
        );
    });
}

#[test]
fn streaming_processor_trait_is_object_safe() {
    fn exercise(processor: &mut dyn StreamingProcessor) {
        assert_eq!(processor.name(), "StreamingGain");
    }

    let mut processor = StreamingGain {
        enabled: true,
        gain: 1.0,
    };
    exercise(&mut processor);
}
