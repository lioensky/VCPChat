use super::*;
use crate::processor::{
    FFTConvolver, NoiseShaperCurve, SaturationQualityValue, SaturationTypeValue, EQ_BANDS,
};

const CHANNELS: usize = 2;
const SAMPLE_RATE: u32 = 48_000;

#[test]
fn callback_builder_order_matches_canonical_stage_list() {
    let builder = test_builder();
    let chain = builder.build_callback_chain().unwrap();

    assert_callback_stage_order_matches(&chain.processor_names());
}

#[test]
fn callback_runtime_order_matches_offline_shared_stage_intersection() {
    let builder = test_builder();
    let chain = builder.build_callback_chain().unwrap();
    let shared_offline_stage_names = canonical_output_stage_descriptors()
        .iter()
        .filter(|stage| stage.offline_render_stage && stage.callback_stage)
        .map(|stage| stage.name)
        .collect::<Vec<_>>();

    assert_eq!(chain.processor_names(), shared_offline_stage_names);
}

#[test]
fn callback_builder_retains_convolver_control_after_type_erasure() {
    let params = transparent_render_params(SAMPLE_RATE);
    let builder = OutputChainBuilder::new(params);
    let control = builder.convolver_control();
    let mut chain = builder.build_callback_chain().unwrap();

    control.set_enabled(true);
    let generation = control
        .publish_at_rate(
            FFTConvolver::new(&[0.5, 0.5], CHANNELS).unwrap(),
            SAMPLE_RATE,
        )
        .unwrap();
    let mut samples = [1.0, -1.0, 0.5, -0.5];
    let progress = chain.process(&mut samples, CHANNELS).unwrap();

    assert_eq!(samples, [0.5, -0.5, 0.25, -0.25]);
    assert_eq!(progress.produced_frames(), 2);
    assert_eq!(control.status().latest_adopted_generation, generation);
}

#[test]
fn convolver_consumer_lease_is_shared_by_direct_callback_and_render_entries() {
    let builder = test_builder();
    let direct = ConvolverProcessor::new(builder.convolver_control()).unwrap();
    assert_consumer_conflict(builder.build_callback_chain());
    assert_consumer_conflict(builder.build_render_chain(SAMPLE_RATE));

    drop(direct);
    let callback = builder.build_callback_chain().unwrap();
    assert_consumer_conflict(builder.build_render_chain(SAMPLE_RATE));
    assert_consumer_conflict(ConvolverProcessor::new(builder.convolver_control()));

    drop(callback);
    let render = builder.build_render_chain(SAMPLE_RATE).unwrap();
    assert_consumer_conflict(builder.build_callback_chain());

    drop(render);
    assert!(ConvolverProcessor::new(builder.convolver_control()).is_ok());
}

#[test]
fn callback_build_failure_releases_convolver_consumer_lease() {
    // A zero channel count is the only params defect that survives past the
    // canonical Convolver stage: the callback builder rejects both rates before
    // any stage exists, so an invalid-rate build would never take the lease and
    // could not prove it is released. DynamicLoudness is the first stage after
    // Convolver that validates the channel count.
    let mut params = test_params();
    params.channels = 0;
    let control = params.convolver_control.clone();
    let builder = OutputChainBuilder::new(params);

    let Err(error) = builder.build_callback_chain() else {
        panic!("a zero channel count must fail the callback build");
    };
    assert!(
        !matches!(error, ProcessError::InvalidSampleRate { .. }),
        "the failure must happen after the Convolver stage, not during rate validation: {error}"
    );
    assert!(
        ConvolverProcessor::new(control).is_ok(),
        "a post-acquisition build failure must release the single-consumer lease"
    );
}

#[test]
fn render_build_failure_releases_convolver_consumer_lease() {
    let mut params = test_params();
    params.channels = 0;
    let control = params.convolver_control.clone();
    let builder = OutputChainBuilder::new(params);

    let Err(error) = builder.build_render_chain(SAMPLE_RATE) else {
        panic!("a zero channel count must fail the render build");
    };
    assert!(
        !matches!(error, ProcessError::InvalidSampleRate { .. }),
        "the failure must happen after the Convolver stage, not during rate validation: {error}"
    );
    assert!(ConvolverProcessor::new(control).is_ok());
}

#[test]
fn callback_build_rejects_the_device_rate_it_actually_uses() {
    let mut params = test_params();
    params.output_sample_rate = 0;

    assert!(matches!(
        OutputChainBuilder::new(params).build_callback_chain(),
        Err(ProcessError::InvalidSampleRate {
            processor: "OutputChainBuilder::output_sample_rate",
            sample_rate_hz: 0,
        })
    ));
}

#[test]
fn render_build_rejects_both_zero_rates_before_any_stage() {
    assert!(matches!(
        OutputChainBuilder::new(test_params()).build_render_chain(0),
        Err(ProcessError::InvalidSampleRate {
            processor: "OutputRenderChain::source_sample_rate",
            sample_rate_hz: 0,
        })
    ));

    let mut output_zero = test_params();
    output_zero.output_sample_rate = 0;
    assert!(matches!(
        OutputChainBuilder::new(output_zero).build_render_chain(SAMPLE_RATE),
        Err(ProcessError::InvalidSampleRate {
            processor: "OutputRenderChain::output_sample_rate",
            sample_rate_hz: 0,
        })
    ));
}

#[test]
fn callback_chain_uses_the_device_output_rate() {
    let mut params = test_params();
    params.output_sample_rate = 96_000;
    let control = params.convolver_control.clone();
    let chain = OutputChainBuilder::new(params)
        .build_callback_chain()
        .unwrap();

    assert_eq!(chain.latency().sample_rate_hz(), Some(96_000));
    assert_eq!(control.status().active_sample_rate_hz, 96_000);
}

#[test]
fn callback_stage_order_assertion_rejects_reordered_chain() {
    let mut reordered = callback_stage_names();
    reordered.swap(0, 1);

    let result = std::panic::catch_unwind(|| {
        assert_callback_stage_order_matches(&reordered);
    });

    assert!(
        result.is_err(),
        "deliberately reordered callback chain must fail parity assertion"
    );
}

#[test]
fn offline_render_order_preserves_render_only_nodes() {
    assert_eq!(
        offline_render_stage_names(),
        vec![
            "Volume",
            "Equalizer",
            "Saturation",
            "Crossfeed",
            "Convolver",
            "DynamicLoudness",
            "Resampler",
            "PeakLimiter",
            "NoiseShaper",
            "Quantize",
        ]
    );
    assert_eq!(post_render_analysis_names(), vec!["LoudnessMeterTruePeak"]);
    assert_eq!(
        canonical_post_render_analysis_descriptors(),
        &[PostRenderAnalysisDescriptor {
            id: PostRenderAnalysisId::LoudnessMeterTruePeak,
            name: "LoudnessMeterTruePeak",
            analysis_note: "opt-in EBU R128 true-peak analysis over final rendered samples",
        }]
    );
}

#[test]
fn stage_metadata_marks_stateful_and_latency_stages() {
    let saturation = descriptor(OutputStageId::Saturation);
    assert!(saturation.introduces_latency);

    let convolver = descriptor(OutputStageId::Convolver);
    assert!(!convolver.introduces_latency);

    let resampler = descriptor(OutputStageId::Resampler);
    assert!(!resampler.introduces_latency);

    let limiter = descriptor(OutputStageId::PeakLimiter);
    assert!(limiter.carries_state);
    assert!(limiter.introduces_latency);

    let quantize = descriptor(OutputStageId::Quantize);
    assert!(!quantize.carries_state);
    assert!(!quantize.introduces_latency);
}

#[test]
fn render_chain_matches_callback_chain_pre_quantize_when_no_resampler() {
    let mut callback_chain = active_test_builder().build_callback_chain().unwrap();
    let mut render_chain = active_test_builder()
        .build_render_chain(SAMPLE_RATE)
        .unwrap();

    let input = fixture_signal(512);
    let mut callback = input.clone();
    let mut rendered = input;

    let _ = callback_chain.process(&mut callback, CHANNELS).unwrap();
    render_chain.process_pre_quantize(&mut rendered).unwrap();

    assert_eq!(callback.len(), rendered.len());
    for (idx, (left, right)) in callback.iter().zip(&rendered).enumerate() {
        assert_eq!(
            left.to_bits(),
            right.to_bits(),
            "sample {idx} diverged: callback={left:?} render={right:?}"
        );
    }
}

#[test]
fn final_output_guard_covers_every_bit_depth_and_noise_shaper_curve() {
    use crate::processor::dsp::{db_to_linear, linear_to_db};
    use crate::processor::loudness::{true_peak_reconstruction_l1_bound, TruePeakDetector};

    const TARGET_DBTP: f64 = -1.0;
    const METER_TOLERANCE_DB: f64 = 0.01;
    const FRAMES: usize = 2_048;
    let amplitude = db_to_linear(0.1);
    let mut input = Vec::with_capacity(FRAMES * CHANNELS);
    for frame in 0..FRAMES {
        let phase = std::f64::consts::FRAC_PI_2 * frame as f64 + std::f64::consts::FRAC_PI_4;
        let sample = phase.sin() * amplitude;
        input.extend_from_slice(&[sample, -sample]);
    }

    for curve in [
        NoiseShaperCurve::TpdfOnly,
        NoiseShaperCurve::Lipshitz5,
        NoiseShaperCurve::FWeighted9,
        NoiseShaperCurve::ModifiedE9,
        NoiseShaperCurve::ImprovedE9,
    ] {
        let mut previous_guard_db = f64::INFINITY;
        for bits in 8..=32 {
            let params = transparent_render_params(SAMPLE_RATE);
            params.limiter_params.set_enabled(true);
            params.limiter_params.set_threshold(TARGET_DBTP);
            params.noise_shaper_params.set_enabled(true);
            params.noise_shaper_params.set_bits(bits);
            params.noise_shaper_params.set_curve(curve);
            let mut chain = OutputChainBuilder::new(params)
                .build_render_chain(SAMPLE_RATE)
                .unwrap();

            let rendered = chain.render(&input).unwrap();

            let target = db_to_linear(TARGET_DBTP);
            let additive_bound = (curve.quantization_error_bound(bits) + f32::EPSILON as f64 * 0.5)
                * true_peak_reconstruction_l1_bound();
            let guarded = (target - additive_bound).max(f64::MIN_POSITIVE);
            let expected_guard_db = TARGET_DBTP - linear_to_db(guarded);
            assert!(
                (rendered.final_limiter_ceiling_guard_db - expected_guard_db).abs() <= 1.0e-12,
                "bits={bits} curve={curve:?}: actual_guard={} expected_guard={expected_guard_db}",
                rendered.final_limiter_ceiling_guard_db
            );
            assert!(
                rendered.final_limiter_ceiling_guard_db.is_finite()
                    && rendered.final_limiter_ceiling_guard_db > 0.0,
                "bits={bits} curve={curve:?}: guard must be finite and positive"
            );
            assert!(
                rendered.final_limiter_ceiling_guard_db < previous_guard_db,
                "bits={bits} curve={curve:?}: guard={} must be below prior-bit guard={previous_guard_db}",
                rendered.final_limiter_ceiling_guard_db
            );
            previous_guard_db = rendered.final_limiter_ceiling_guard_db;

            let mut max_true_peak = 0.0_f64;
            for channel in 0..CHANNELS {
                let mut detector = TruePeakDetector::new();
                detector.process_strided(&rendered.samples, channel, CHANNELS);
                detector.process(&[0.0; 16]);
                max_true_peak = max_true_peak.max(detector.max_true_peak());
            }
            let measured_dbtp = linear_to_db(max_true_peak);
            assert!(
                measured_dbtp <= TARGET_DBTP + METER_TOLERANCE_DB,
                "bits={bits} curve={curve:?}: measured={measured_dbtp:.6} dBTP target={TARGET_DBTP:.6} dBTP guard={:.6} dB",
                rendered.final_limiter_ceiling_guard_db
            );
        }
    }
}

#[test]
fn reused_render_starts_settled_at_the_latest_parameter_snapshot() {
    let reused_params = transparent_render_params(SAMPLE_RATE);
    let reused_eq = Arc::clone(&reused_params.eq_params);
    let mut reused = OutputChainBuilder::new(reused_params)
        .build_render_chain(SAMPLE_RATE)
        .unwrap();
    let input = fixture_signal(512);
    let _ = reused.render(&input).unwrap();

    let gains = [3.0; EQ_BANDS];
    reused_eq.write(&gains, true);

    let fresh_params = transparent_render_params(SAMPLE_RATE);
    fresh_params.eq_params.write(&gains, true);
    let mut fresh = OutputChainBuilder::new(fresh_params)
        .build_render_chain(SAMPLE_RATE)
        .unwrap();

    let actual = reused.render(&input).unwrap();
    let expected = fresh.render(&input).unwrap();
    assert_eq!(actual.samples.len(), expected.samples.len());
    for (index, (actual, expected)) in actual.samples.iter().zip(&expected.samples).enumerate() {
        assert_eq!(
            actual.to_bits(),
            expected.to_bits(),
            "sample {index} started from stale render state: actual={actual:?} expected={expected:?}"
        );
    }
}

#[test]
fn callback_chain_processing_is_allocation_free_after_setup() {
    let builder = active_test_builder();
    let mut chain = builder.build_callback_chain().unwrap();
    let mut buffer = fixture_signal(256);

    let _ = chain.process(&mut buffer, CHANNELS).unwrap();

    assert_no_alloc::assert_no_alloc(|| {
        for _ in 0..32 {
            let _ = chain.process(&mut buffer, CHANNELS).unwrap();
        }
    });
}

#[test]
fn callback_chain_is_equivalent_across_irregular_frame_chunks() {
    let mut whole_chain = active_test_builder().build_callback_chain().unwrap();
    let mut chunked_chain = active_test_builder().build_callback_chain().unwrap();
    let input = fixture_signal(4_096);
    let mut whole = input.clone();
    let mut chunked = input;

    let _ = whole_chain.process(&mut whole, CHANNELS).unwrap();

    let chunk_pattern = [1, 17, 3, 127, 64, 5, 251, 32];
    let total_frames = chunked.len() / CHANNELS;
    let mut start_frame = 0;
    let mut pattern_index = 0;
    while start_frame < total_frames {
        let end_frame =
            (start_frame + chunk_pattern[pattern_index % chunk_pattern.len()]).min(total_frames);
        let _ = chunked_chain
            .process(
                &mut chunked[start_frame * CHANNELS..end_frame * CHANNELS],
                CHANNELS,
            )
            .unwrap();
        start_frame = end_frame;
        pattern_index += 1;
    }

    for (index, (left, right)) in whole.iter().zip(&chunked).enumerate() {
        assert_eq!(
            left.to_bits(),
            right.to_bits(),
            "sample {index} changed with callback chunking: whole={left:?} chunked={right:?}"
        );
    }
}

#[test]
fn callback_chain_reset_isolates_prior_stream_state() {
    let mut reused = active_test_builder().build_callback_chain().unwrap();
    let mut reference = active_test_builder().build_callback_chain().unwrap();
    reused.reset().unwrap();
    reference.reset().unwrap();

    let mut warmup = fixture_signal(2_048);
    let _ = reused.process(&mut warmup, CHANNELS).unwrap();
    reused.reset().unwrap();

    let input = fixture_signal(512);
    let mut actual = input.clone();
    let mut expected = input;
    let _ = reused.process(&mut actual, CHANNELS).unwrap();
    let _ = reference.process(&mut expected, CHANNELS).unwrap();

    for (index, (left, right)) in actual.iter().zip(&expected).enumerate() {
        assert_eq!(
            left.to_bits(),
            right.to_bits(),
            "sample {index} leaked pre-reset state: reused={left:?} reference={right:?}"
        );
    }
}

#[test]
fn default_render_compensates_limiter_latency_and_preserves_last_impulse() {
    let params = transparent_render_params(SAMPLE_RATE);
    params.limiter_params.set_enabled(true);
    let builder = OutputChainBuilder::new(params);
    let mut chain = builder.build_render_chain(SAMPLE_RATE).unwrap();
    let mut input = vec![0.0; 128 * CHANNELS];
    let input_len = input.len();
    input[input_len - 2] = 0.5;
    input[input_len - 1] = -0.5;

    let raw = chain
        .render_with_policy(&input, OfflineRenderPolicy::raw_causal())
        .unwrap();
    let compensated = chain.render(&input).unwrap();

    assert!(raw.algorithmic_latency_frames > 0);
    assert_eq!(
        raw.rendered_frames,
        input.len() / CHANNELS + raw.algorithmic_latency_frames
    );
    assert_eq!(compensated.rendered_frames, input.len() / CHANNELS);
    assert_eq!(
        &raw.samples[raw.algorithmic_latency_frames * CHANNELS..],
        compensated.samples.as_slice()
    );
    assert!(compensated.samples[compensated.samples.len() - 2].abs() > 0.49);
    assert!(compensated.samples[compensated.samples.len() - 1].abs() > 0.49);
    assert!(!raw.tail_truncated);
    assert!(!compensated.tail_truncated);
}

#[test]
fn convolver_tail_flows_through_limiter_and_resampler_independent_of_block_size() {
    let params = transparent_render_params(96_000);
    params.limiter_params.set_enabled(true);
    let builder = OutputChainBuilder::new(params);
    let control = builder.convolver_control();
    control.set_enabled(true);
    control
        .publish_at_rate(
            FFTConvolver::new(&[1.0, 1.0, 0.5, 0.5, 0.25, 0.25], CHANNELS).unwrap(),
            48_000,
        )
        .unwrap();
    let mut chain = builder.build_render_chain(48_000).unwrap();
    let mut input = vec![0.0; 64 * CHANNELS];
    let input_len = input.len();
    input[input_len - 2] = 0.4;
    input[input_len - 1] = -0.4;
    let policy = OfflineRenderPolicy::default();

    let small_blocks = chain
        .render_with_policy_and_block_frames(&input, policy, 17)
        .unwrap();
    let large_blocks = chain
        .render_with_policy_and_block_frames(&input, policy, 257)
        .unwrap();

    assert_eq!(small_blocks.semantic_tail_frames, 4);
    assert_eq!(small_blocks.rendered_frames, 64 * 2 + 4);
    assert_eq!(small_blocks.rendered_frames, large_blocks.rendered_frames);
    assert_eq!(
        small_blocks.algorithmic_latency_frames,
        large_blocks.algorithmic_latency_frames
    );
    assert_eq!(small_blocks.tail_truncated, large_blocks.tail_truncated);
    assert_eq!(small_blocks.samples, large_blocks.samples);
    assert!(small_blocks.samples[small_blocks.samples.len() - 16..]
        .iter()
        .any(|sample| sample.abs() > 1.0e-5));
}

#[cfg(all(feature = "rubato", not(feature = "soxr")))]
#[test]
fn resampler_finish_bound_includes_nonlinear_latency_and_tail() {
    let input_frames = 1_024;
    let block_frames = 1_024;
    let mut resampler =
        StreamingResampler::with_phase(CHANNELS, 8_000, 192_000, PhaseResponse::Minimum).unwrap();
    let declared_frames = resampler.latency().frames()
        + resampler
            .tail()
            .finite_duration()
            .expect("nonlinear resampler has a finite tail")
            .frames();
    let old_process_estimate = resampler
        .process_output_capacity_frames(input_frames)
        .unwrap()
        + block_frames;
    let mut boundary = RateBoundary::new(CHANNELS, Some(&mut resampler), block_frames).unwrap();
    boundary.input_frames_seen = input_frames;

    let limit = boundary
        .finish_frame_limit(OfflineRenderPolicy::default(), block_frames)
        .unwrap();
    let converted_frames = input_frames * 24;

    assert_eq!(limit, converted_frames + declared_frames + block_frames);
    assert!(
        limit > old_process_estimate,
        "the nonlinear timing contract must exceed the old process-capacity estimate"
    );
}

#[test]
fn production_iir_tail_stops_early_and_is_block_size_independent() {
    let params = transparent_render_params(SAMPLE_RATE);
    let mut gains = [0.0; EQ_BANDS];
    gains[EQ_BANDS - 1] = 6.0;
    params.eq_params.write(&gains, true);
    params.limiter_params.set_enabled(true);
    let builder = OutputChainBuilder::new(params);
    let mut chain = builder.build_render_chain(SAMPLE_RATE).unwrap();
    let mut input = vec![0.0; 256 * CHANNELS];
    let last = input.len();
    input[last - 2] = 0.5;
    input[last - 1] = -0.5;
    let policy = OfflineRenderPolicy {
        unknown_tail: UnknownTailPolicy {
            energy_threshold_dbfs: -80.0,
            silence_hold_ms: 5,
            max_tail_ms: 100,
        },
        ..OfflineRenderPolicy::default()
    };

    let small = chain
        .render_with_policy_and_block_frames(&input, policy, 17)
        .unwrap();
    let large = chain
        .render_with_policy_and_block_frames(&input, policy, 257)
        .unwrap();

    assert!(!small.tail_truncated);
    assert_eq!(small.samples, large.samples);
    assert_eq!(small.rendered_frames, large.rendered_frames);
    assert_eq!(
        small.algorithmic_latency_frames,
        large.algorithmic_latency_frames
    );
    assert_eq!(small.semantic_tail_frames, 0);
    assert!(small.rendered_frames >= input.len() / CHANNELS);
    assert!(
        small.rendered_frames < input.len() / CHANNELS + SAMPLE_RATE as usize / 10,
        "decaying EQ tail should stop before the 100 ms safety cap"
    );
}

#[test]
fn resampled_unknown_tail_with_single_frame_blocks_respects_cap_without_backend_error() {
    let source_rate = 48_000;
    let output_rate = 8_000;
    let params = transparent_render_params(output_rate);
    let mut gains = [0.0; EQ_BANDS];
    gains[EQ_BANDS - 1] = 6.0;
    params.eq_params.write(&gains, true);

    let builder = OutputChainBuilder::new(params);
    let mut chain = builder.build_render_chain(source_rate).unwrap();
    let mut input = vec![0.0; 32 * CHANNELS];
    input[..CHANNELS].fill(0.5);
    let policy = OfflineRenderPolicy {
        unknown_tail: UnknownTailPolicy {
            energy_threshold_dbfs: -40.0,
            silence_hold_ms: 1,
            max_tail_ms: 2,
        },
        ..OfflineRenderPolicy::default()
    };

    let single_frame_blocks = chain
        .render_with_policy_and_block_frames(&input, policy, 1)
        .unwrap();
    let regular_blocks = chain
        .render_with_policy_and_block_frames(&input, policy, 64)
        .unwrap();

    assert!(single_frame_blocks.tail_truncated);
    assert_eq!(single_frame_blocks.samples, regular_blocks.samples);
    assert_eq!(
        single_frame_blocks.tail_truncated,
        regular_blocks.tail_truncated
    );
    assert!(single_frame_blocks
        .samples
        .iter()
        .all(|sample| sample.is_finite()));
}

#[test]
fn render_rejects_zero_block_size_before_processing() {
    let mut chain = OutputChainBuilder::new(transparent_render_params(SAMPLE_RATE))
        .build_render_chain(SAMPLE_RATE)
        .unwrap();

    assert!(matches!(
        chain.render_with_policy_and_block_frames(
            &[0.0; CHANNELS],
            OfflineRenderPolicy::default(),
            0,
        ),
        Err(ProcessError::InvalidRenderPolicy {
            message: "offline block size must be greater than zero",
        })
    ));
}

struct UnknownTailProcessor {
    channels: usize,
    sample_rate_hz: u32,
    decay: f64,
    tail_frame: usize,
    finishing: bool,
}

impl UnknownTailProcessor {
    fn new(channels: usize, sample_rate_hz: u32, decay: f64) -> Self {
        Self {
            channels,
            sample_rate_hz,
            decay,
            tail_frame: 0,
            finishing: false,
        }
    }
}

impl StreamingProcessor for UnknownTailProcessor {
    fn name(&self) -> &'static str {
        "UnknownTailTest"
    }

    fn process(&mut self, buffers: ProcessBuffers<'_>) -> Result<ProcessProgress, ProcessError> {
        if self.finishing {
            return Err(ProcessError::AlreadyFinished {
                processor: self.name(),
            });
        }
        match buffers.into_parts() {
            super::super::traits::ProcessBufferParts::InPlace(block) => Ok(ProcessProgress::new(
                block.frames(),
                block.frames(),
                ProcessState::NeedInput,
            )),
            super::super::traits::ProcessBufferParts::OutOfPlace { input, mut output } => {
                let frames = input.frames().min(output.frames());
                let samples = frames * self.channels;
                output.samples_mut()[..samples].copy_from_slice(&input.samples()[..samples]);
                let state = if frames < input.frames() {
                    ProcessState::NeedOutput
                } else {
                    ProcessState::NeedInput
                };
                Ok(ProcessProgress::new(frames, frames, state))
            }
        }
    }

    fn finish(&mut self, mut output: AudioBlockMut<'_>) -> Result<ProcessProgress, ProcessError> {
        self.finishing = true;
        for frame in output.samples_mut().chunks_exact_mut(self.channels) {
            let value = self.decay.powf(self.tail_frame as f64);
            frame.fill(value);
            self.tail_frame += 1;
        }
        Ok(ProcessProgress::new(
            0,
            output.frames(),
            ProcessState::NeedOutput,
        ))
    }

    fn reset(&mut self) -> Result<(), ProcessError> {
        self.tail_frame = 0;
        self.finishing = false;
        Ok(())
    }

    fn tail(&self) -> TailSpec {
        TailSpec::Unknown
    }

    fn set_sample_rate(&mut self, sample_rate_hz: u32) -> Result<(), ProcessError> {
        self.sample_rate_hz = sample_rate_hz;
        Ok(())
    }
}

#[test]
fn unknown_tail_energy_stop_is_block_size_independent() {
    let policy = OfflineRenderPolicy {
        unknown_tail: UnknownTailPolicy {
            energy_threshold_dbfs: -40.0,
            silence_hold_ms: 5,
            max_tail_ms: 100,
        },
        ..OfflineRenderPolicy::default()
    };
    let input = [1.0];

    let mut small = UnknownTailProcessor::new(1, 1_000, 0.8);
    let mut small_output = drive_offline_stage(&mut small, &input, 1, 1_000, policy, 7).unwrap();
    let small_generated_tail_frames = small.tail_frame;
    let small_truncated = trim_unknown_tail_before_dither(
        &mut small_output.samples,
        1,
        1,
        1_000,
        policy.unknown_tail,
        small_output.unknown_finish_capped,
    )
    .unwrap();

    let mut large = UnknownTailProcessor::new(1, 1_000, 0.8);
    let mut large_output = drive_offline_stage(&mut large, &input, 1, 1_000, policy, 31).unwrap();
    let large_generated_tail_frames = large.tail_frame;
    let large_truncated = trim_unknown_tail_before_dither(
        &mut large_output.samples,
        1,
        1,
        1_000,
        policy.unknown_tail,
        large_output.unknown_finish_capped,
    )
    .unwrap();

    assert!(!small_truncated);
    assert!(!large_truncated);
    assert_eq!(small_output.samples, large_output.samples);
    assert!(small_generated_tail_frames < 100);
    assert!(large_generated_tail_frames < 100);
    assert!(small_generated_tail_frames <= 28);
    assert!(large_generated_tail_frames <= 31);
}

#[test]
fn unknown_tail_reports_truncation_at_safety_limit() {
    let policy = OfflineRenderPolicy {
        unknown_tail: UnknownTailPolicy {
            energy_threshold_dbfs: -80.0,
            silence_hold_ms: 5,
            max_tail_ms: 20,
        },
        ..OfflineRenderPolicy::default()
    };
    let input = [1.0];
    let mut processor = UnknownTailProcessor::new(1, 1_000, 1.0);
    let mut rendered = drive_offline_stage(&mut processor, &input, 1, 1_000, policy, 7).unwrap();
    assert_eq!(processor.tail_frame, 20);
    let truncated = trim_unknown_tail_before_dither(
        &mut rendered.samples,
        1,
        1,
        1_000,
        policy.unknown_tail,
        rendered.unknown_finish_capped,
    )
    .unwrap();

    assert!(truncated);
    assert_eq!(rendered.samples.len(), 1 + 20);
}

#[test]
fn capped_unknown_tail_remains_reported_after_silence_trim() {
    let policy = UnknownTailPolicy {
        energy_threshold_dbfs: -80.0,
        silence_hold_ms: 5,
        max_tail_ms: 20,
    };
    let mut samples = vec![1.0];
    samples.extend_from_slice(&[0.0; 5]);

    let truncated =
        trim_unknown_tail_before_dither(&mut samples, 1, 1, 1_000, policy, true).unwrap();

    assert!(truncated);
    assert_eq!(samples, vec![1.0]);
}

fn descriptor(id: OutputStageId) -> OutputStageDescriptor {
    canonical_output_stage_descriptors()
        .iter()
        .copied()
        .find(|stage| stage.id == id)
        .expect("descriptor exists")
}

fn assert_callback_stage_order_matches(observed: &[&'static str]) {
    assert_eq!(
        observed,
        callback_stage_names().as_slice(),
        "callback stage order diverged from canonical output chain"
    );
}

fn assert_consumer_conflict<T>(result: Result<T, ProcessError>) {
    match result {
        Err(ProcessError::ConsumerAlreadyActive {
            processor: "Convolver",
        }) => {}
        Err(error) => panic!("expected Convolver consumer conflict, got {error}"),
        Ok(_) => panic!("second Convolver consumer unexpectedly succeeded"),
    }
}

fn test_builder() -> OutputChainBuilder {
    OutputChainBuilder::new(test_params())
}

fn active_test_builder() -> OutputChainBuilder {
    let params = test_params();
    params.eq_params.write(&[0.0; EQ_BANDS], false);
    params.saturation_params.set_enabled(true);
    params.saturation_params.set_drive(0.4);
    params.saturation_params.set_mix(0.25);
    params
        .saturation_params
        .set_sat_type(SaturationTypeValue::Tube);
    params
        .saturation_params
        .set_quality(SaturationQualityValue::Oversampled4x);
    params.saturation_params.set_highpass_mode(true);
    params.crossfeed_params.set_enabled(true);
    params.crossfeed_params.set_mix(0.25);
    params.volume_params.set_volume(0.8);
    params.dynamic_loudness_params.set_enabled(false);
    params.limiter_params.set_enabled(true);
    params.limiter_params.set_threshold(-1.0);
    params.noise_shaper_params.set_enabled(true);
    params.noise_shaper_params.set_bits(24);
    params
        .noise_shaper_params
        .set_curve(NoiseShaperCurve::TpdfOnly);
    OutputChainBuilder::new(params)
}

fn test_params() -> OutputChainParams {
    OutputChainParams {
        channels: CHANNELS,
        output_sample_rate: SAMPLE_RATE,
        eq_params: Arc::new(AtomicEqParams::new()),
        saturation_params: Arc::new(AtomicSaturationParams::new()),
        crossfeed_params: Arc::new(AtomicCrossfeedParams::new()),
        convolver_control: ConvolverControl::default(),
        volume_params: Arc::new(AtomicVolumeParams::new()),
        dynamic_loudness_params: Arc::new(AtomicDynamicLoudnessParams::new()),
        dynamic_loudness_telemetry: Arc::new(AtomicDynamicLoudnessTelemetry::new()),
        limiter_params: Arc::new(AtomicPeakLimiterParams::new()),
        noise_shaper_params: Arc::new(AtomicNoiseShaperParams::new()),
    }
}

fn transparent_render_params(output_sample_rate: u32) -> OutputChainParams {
    let mut params = test_params();
    params.output_sample_rate = output_sample_rate;
    params.eq_params.write(&[0.0; EQ_BANDS], false);
    params.saturation_params.set_enabled(false);
    params.saturation_params.set_armed(false);
    params.crossfeed_params.set_enabled(false);
    params.dynamic_loudness_params.set_enabled(false);
    params.limiter_params.set_enabled(false);
    params.noise_shaper_params.set_enabled(false);
    params
}

fn fixture_signal(frames: usize) -> Vec<f64> {
    let mut out = Vec::with_capacity(frames * CHANNELS);
    for frame in 0..frames {
        let t = frame as f64 / SAMPLE_RATE as f64;
        let left = (std::f64::consts::TAU * 997.0 * t).sin() * 0.25;
        let right = (std::f64::consts::TAU * 1201.0 * t).sin() * 0.20;
        out.push(left);
        out.push(right);
    }
    out
}
