use super::*;
use crate::processor::loudness::LimiterMode;
use crate::processor::traits::{AudioBlockError, AudioBlockRef};

fn valid_convolver(ir: &[f64], channels: usize) -> FFTConvolver {
    FFTConvolver::new(ir, channels).unwrap()
}

struct TestProgress(ProcessProgress);

impl TestProgress {
    fn is_bypassed(&self) -> bool {
        self.0.is_bypassed()
    }
}

macro_rules! impl_test_process_block {
        ($($processor:ty),+ $(,)?) => {
            $(
                impl $processor {
                    fn process(
                        &mut self,
                        buffer: &mut [f64],
                        channels: usize,
                    ) -> TestProgress {
                        let block = AudioBlockMut::new(buffer, channels).unwrap();
                        TestProgress(
                            super::super::traits::process_checked(
                                self,
                                ProcessBuffers::in_place(block),
                            )
                            .unwrap(),
                        )
                    }
                }
            )+
        };
    }

impl_test_process_block!(
    EqProcessor,
    SaturationProcessor,
    CrossfeedProcessor,
    PeakLimiterProcessor,
    VolumeProcessor,
    ConvolverProcessor,
    NoiseShaperProcessor,
    DynamicLoudnessProcessor,
);

#[test]
fn geometry_dependent_adapter_constructors_reject_before_allocating_state() {
    let limiter_params = Arc::new(AtomicPeakLimiterParams::new());
    let noise_params = Arc::new(AtomicNoiseShaperParams::new());
    let dynamic_params = Arc::new(AtomicDynamicLoudnessParams::new());
    let telemetry = Arc::new(AtomicDynamicLoudnessTelemetry::new());

    assert_no_alloc::assert_no_alloc(|| {
        assert!(matches!(
            PeakLimiterProcessor::new(0, 48_000, Arc::clone(&limiter_params)),
            Err(ProcessError::InvalidBlock(AudioBlockError::ZeroChannels))
        ));
        assert!(matches!(
            PeakLimiterProcessor::new(2, 0, Arc::clone(&limiter_params)),
            Err(ProcessError::InvalidSampleRate {
                processor: "PeakLimiter",
                sample_rate_hz: 0,
            })
        ));
        assert!(matches!(
            PeakLimiterProcessor::new_with_output_guard(
                0,
                48_000,
                Arc::clone(&limiter_params),
                Arc::clone(&noise_params),
            ),
            Err(ProcessError::InvalidBlock(AudioBlockError::ZeroChannels))
        ));
        assert!(matches!(
            NoiseShaperProcessor::new(0, 48_000, Arc::clone(&noise_params)),
            Err(ProcessError::InvalidBlock(AudioBlockError::ZeroChannels))
        ));
        assert!(matches!(
            NoiseShaperProcessor::new(2, 0, Arc::clone(&noise_params)),
            Err(ProcessError::InvalidSampleRate {
                processor: "NoiseShaper",
                sample_rate_hz: 0,
            })
        ));
        assert!(matches!(
            DynamicLoudnessProcessor::new(
                0,
                48_000,
                Arc::clone(&dynamic_params),
                Arc::clone(&telemetry),
            ),
            Err(ProcessError::InvalidBlock(AudioBlockError::ZeroChannels))
        ));
        assert!(matches!(
            DynamicLoudnessProcessor::new(
                2,
                0,
                Arc::clone(&dynamic_params),
                Arc::clone(&telemetry),
            ),
            Err(ProcessError::InvalidSampleRate {
                processor: "DynamicLoudness",
                sample_rate_hz: 0,
            })
        ));
    });
}

#[test]
fn test_convolver_processor_swaps_in_and_processes() {
    let control = ConvolverControl::default();
    let mut proc = ConvolverProcessor::new(control.clone()).unwrap();
    let mut buffer = vec![1.0, 2.0, 3.0, 4.0];

    assert!(proc.process(&mut buffer, 1).is_bypassed());

    let generation = control
        .publish_at_rate(valid_convolver(&[0.5], 1), 44_100)
        .unwrap();
    control.set_enabled(true);
    assert!(!proc.process(&mut buffer, 1).is_bypassed());
    assert_eq!(buffer, vec![0.5, 1.0, 1.5, 2.0]);

    let status = control.status();
    assert_eq!(status.latest_published_generation, generation);
    assert_eq!(status.latest_adopted_generation, generation);
    assert_eq!(status.adopted_kernels, 1);
    assert_eq!(status.pending_kernels, 0);
    assert!(!status.backpressured);
}

#[test]
fn test_convolver_processor_clear_disables_owned_convolver() {
    let control = ConvolverControl::new(true);
    let mut proc = ConvolverProcessor::new(control.clone()).unwrap();
    let mut buffer = vec![1.0, 2.0, 3.0, 4.0];

    control
        .publish_at_rate(valid_convolver(&[0.5], 1), 44_100)
        .unwrap();
    assert!(!proc.process(&mut buffer, 1).is_bypassed());

    control.set_enabled(false);
    let mut transition = vec![1.0; 256];
    assert!(!proc.process(&mut transition, 1).is_bypassed());
    let mut bypassed = vec![1.0, 2.0, 3.0, 4.0];
    assert!(proc.process(&mut bypassed, 1).is_bypassed());
    assert_eq!(bypassed, vec![1.0, 2.0, 3.0, 4.0]);
    assert_eq!(control.status().pending_reclamations, 1);
    assert!(control.reclaim_retired());
    assert!(control.is_quiescent());
}

#[test]
fn convolver_publication_is_latest_wins_before_audio_withdrawal() {
    let control = ConvolverControl::new(true);
    let mut proc = ConvolverProcessor::new(control.clone()).unwrap();
    let mut buffer = vec![1.0, 2.0, 3.0, 4.0];

    let first = control
        .publish_at_rate(valid_convolver(&[0.5], 1), 44_100)
        .unwrap();
    let latest = control
        .publish_at_rate(valid_convolver(&[0.25], 1), 44_100)
        .unwrap();
    assert!(!proc.process(&mut buffer, 1).is_bypassed());
    assert_eq!(buffer, vec![0.25, 0.5, 0.75, 1.0]);

    let status = control.status();
    assert_eq!(first, 1);
    assert_eq!(status.latest_adopted_generation, latest);
    assert_eq!(status.adopted_kernels, 1);
    assert_eq!(status.superseded_kernels, 1);
    assert_eq!(status.pending_kernels, 0);
}

#[test]
fn convolver_disable_reports_retirement_backpressure_and_recovers() {
    let control = ConvolverControl::new(true);
    let mut proc = ConvolverProcessor::new(control.clone()).unwrap();
    let mut buffer = vec![1.0; 256];

    control
        .publish_at_rate(valid_convolver(&[1.0], 1), 44_100)
        .unwrap();
    assert!(!proc.process(&mut buffer, 1).is_bypassed());
    control
        .publish_at_rate(valid_convolver(&[0.5], 1), 44_100)
        .unwrap();
    control.set_enabled(false);

    assert!(!proc.process(&mut buffer, 1).is_bypassed());
    assert!(proc.process(&mut buffer, 1).is_bypassed());
    let saturated = control.status();
    assert!(saturated.backpressured);
    assert_eq!(saturated.discarded_kernels, 1);
    assert_eq!(saturated.pending_reclamations, 2);

    assert!(control.reclaim_retired());
    assert!(proc.process(&mut buffer, 1).is_bypassed());
    let recovered = control.status();
    assert!(!recovered.backpressured);
    assert!(recovered.audio_idle);
    assert_eq!(recovered.pending_reclamations, 1);

    assert!(control.reclaim_retired());
    assert!(control.is_quiescent());
}

#[test]
fn convolver_processor_kernel_swap_is_allocation_free_on_audio_side() {
    let control = ConvolverControl::new(true);
    let mut proc = ConvolverProcessor::new(control.clone()).unwrap();
    let mut buffer = vec![0.3; 512];

    for _ in 0..8 {
        // Control side: publishing allocates (allowed).
        control
            .publish_at_rate(valid_convolver(&[0.5, 0.25], 1), 44_100)
            .unwrap();
        // Audio side: swap-in, retirement hand-off, and processing must not
        // allocate or deallocate.
        assert_no_alloc::assert_no_alloc(|| {
            proc.process(&mut buffer, 1);
        });
        // Control side: draining performs the large deallocation.
        let _ = control.reclaim_retired();
    }

    control
        .publish_at_rate(valid_convolver(&[0.75], 1), 44_100)
        .unwrap();
    control.set_enabled(false);
    assert_no_alloc::assert_no_alloc(|| {
        proc.process(&mut buffer, 1);
        proc.process(&mut buffer, 1);
    });
    assert!(control.status().backpressured);

    assert!(control.reclaim_retired());
    assert_no_alloc::assert_no_alloc(|| {
        proc.process(&mut buffer, 1);
    });
    assert!(control.reclaim_retired());

    control.set_enabled(true);
    control
        .publish_at_rate(valid_convolver(&[0.25], 1), 44_100)
        .unwrap();
    assert_no_alloc::assert_no_alloc(|| {
        proc.process(&mut buffer, 1);
    });
}

#[test]
fn convolver_control_stress_remains_bounded_and_adopts_latest_generation() {
    const UPDATES: u64 = 10_000;

    let control = ConvolverControl::new(true);
    let mut proc = ConvolverProcessor::new(control.clone()).unwrap();
    let mut buffer = [1.0; 256];
    let mut latest_gain = 0.0;

    for update in 0..UPDATES {
        latest_gain = 0.25 + (update % 23) as f64 * 0.01;
        let generation = control
            .publish_at_rate(valid_convolver(&[latest_gain], 1), 44_100)
            .unwrap();
        assert_eq!(generation, update + 1);

        if update % 17 == 0 {
            buffer.fill(1.0);
            assert!(!proc.process(&mut buffer, 1).is_bypassed());
            assert!((buffer[0] - latest_gain).abs() <= f64::EPSILON);
        }
        if update % 113 == 0 {
            let _ = control.reclaim_retired();
        }
    }

    buffer.fill(1.0);
    assert!(!proc.process(&mut buffer, 1).is_bypassed());
    assert!((buffer[0] - latest_gain).abs() <= f64::EPSILON);
    let _ = control.reclaim_retired();

    let burst_status = control.status();
    assert_eq!(burst_status.latest_published_generation, UPDATES);
    assert_eq!(burst_status.latest_adopted_generation, UPDATES);
    assert_eq!(
        burst_status.adopted_kernels
            + burst_status.superseded_kernels
            + burst_status.discarded_kernels,
        UPDATES
    );
    assert_eq!(burst_status.pending_kernels, 0);
    assert_eq!(burst_status.pending_reclamations, 0);

    control
        .publish_at_rate(valid_convolver(&[0.5], 1), 44_100)
        .unwrap();
    control.set_enabled(false);
    assert!(!proc.process(&mut buffer, 1).is_bypassed());
    assert!(proc.process(&mut buffer, 1).is_bypassed());
    let saturated = control.status();
    assert!(saturated.backpressured);
    assert_eq!(saturated.pending_reclamations, 2);

    assert!(control.reclaim_retired());
    assert!(proc.process(&mut buffer, 1).is_bypassed());
    assert!(control.reclaim_retired());
    assert!(control.is_quiescent());

    control.set_enabled(true);
    let final_generation = control
        .publish_at_rate(valid_convolver(&[0.875], 1), 44_100)
        .unwrap();
    buffer.fill(1.0);
    assert!(!proc.process(&mut buffer, 1).is_bypassed());
    assert_eq!(buffer, [0.875; 256]);

    let final_status = control.status();
    assert_eq!(final_status.latest_adopted_generation, final_generation);
    assert_eq!(final_status.pending_kernels, 0);
    assert_eq!(final_status.pending_reclamations, 0);
    assert!(!final_status.backpressured);
    assert!(final_status.deferred_adoptions >= 1);
    assert_eq!(
        final_status.adopted_kernels
            + final_status.superseded_kernels
            + final_status.discarded_kernels,
        final_status.latest_published_generation
    );
}

#[test]
fn convolver_control_serializes_concurrent_publishers() {
    const PUBLISHERS: usize = 4;
    const UPDATES_PER_PUBLISHER: usize = 64;
    const TOTAL_UPDATES: usize = PUBLISHERS * UPDATES_PER_PUBLISHER;

    let control = ConvolverControl::new(true);
    let start = Arc::new(std::sync::Barrier::new(PUBLISHERS));
    let mut publishers = Vec::with_capacity(PUBLISHERS);
    for publisher in 0..PUBLISHERS {
        let control = control.clone();
        let start = Arc::clone(&start);
        publishers.push(std::thread::spawn(move || {
            start.wait();
            let mut published = Vec::with_capacity(UPDATES_PER_PUBLISHER);
            for update in 0..UPDATES_PER_PUBLISHER {
                let ordinal = publisher * UPDATES_PER_PUBLISHER + update + 1;
                let gain = ordinal as f64 / TOTAL_UPDATES as f64;
                let generation = control
                    .publish_at_rate(valid_convolver(&[gain], 1), 44_100)
                    .unwrap();
                published.push((generation, gain));
            }
            published
        }));
    }

    let mut publications = Vec::with_capacity(TOTAL_UPDATES);
    for publisher in publishers {
        publications.extend(publisher.join().unwrap());
    }
    publications.sort_by_key(|(generation, _)| *generation);
    assert_eq!(publications.len(), TOTAL_UPDATES);
    for (index, (generation, _)) in publications.iter().enumerate() {
        assert_eq!(*generation, index as u64 + 1);
    }

    let (latest_generation, latest_gain) = publications[TOTAL_UPDATES - 1];
    let mut proc = ConvolverProcessor::new(control.clone()).unwrap();
    let mut buffer = [1.0; 4];
    assert!(!proc.process(&mut buffer, 1).is_bypassed());
    assert_eq!(buffer, [latest_gain; 4]);

    let status = control.status();
    assert_eq!(status.latest_published_generation, latest_generation);
    assert_eq!(status.latest_adopted_generation, latest_generation);
    assert_eq!(status.adopted_kernels, 1);
    assert_eq!(status.superseded_kernels, TOTAL_UPDATES as u64 - 1);
    assert_eq!(status.pending_kernels, 0);
}

#[test]
fn convolver_kernels_are_destroyed_by_control_not_audio_thread() {
    use std::sync::mpsc::sync_channel;

    let control = ConvolverControl::new(true);
    let audio_control = control.clone();
    let (command_tx, command_rx) = sync_channel::<bool>(0);
    let (ready_tx, ready_rx) = sync_channel(0);
    let (processed_tx, processed_rx) = sync_channel(0);
    let audio_thread = std::thread::spawn(move || {
        ready_tx.send(std::thread::current().id()).unwrap();
        let mut proc = ConvolverProcessor::new(audio_control).unwrap();
        let mut buffer = [1.0; 256];
        while command_rx.recv().unwrap() {
            buffer.fill(1.0);
            let _ = proc.process(&mut buffer, 1);
            processed_tx.send(()).unwrap();
        }
    });
    let audio_thread_id = ready_rx.recv().unwrap();
    let dropped_on_audio = Arc::new(AtomicBool::new(false));
    let drop_count = Arc::new(AtomicU64::new(0));
    let make_probe = || ConvolverDropProbe {
        audio_thread_id,
        dropped_on_audio: Arc::clone(&dropped_on_audio),
        drop_count: Arc::clone(&drop_count),
    };
    let process_once = || {
        command_tx.send(true).unwrap();
        processed_rx.recv().unwrap();
    };

    control.publish_with_drop_probe(valid_convolver(&[1.0], 1), 44_100, make_probe());
    process_once();
    control.publish_with_drop_probe(valid_convolver(&[0.75], 1), 44_100, make_probe());
    process_once();
    assert_eq!(drop_count.load(Ordering::Acquire), 0);
    assert!(control.reclaim_retired());

    control.publish_with_drop_probe(valid_convolver(&[0.5], 1), 44_100, make_probe());
    control.publish_with_drop_probe(valid_convolver(&[0.25], 1), 44_100, make_probe());
    process_once();
    assert_eq!(drop_count.load(Ordering::Acquire), 2);
    assert!(control.reclaim_retired());

    control.set_enabled(false);
    process_once();
    assert!(control.reclaim_retired());
    assert!(control.is_quiescent());

    command_tx.send(false).unwrap();
    audio_thread.join().unwrap();
    assert_eq!(drop_count.load(Ordering::Acquire), 4);
    assert!(!dropped_on_audio.load(Ordering::Acquire));
}

#[test]
fn test_eq_processor() {
    let params = Arc::new(AtomicEqParams::new());
    let mut proc = EqProcessor::new(2, 44100.0, Arc::clone(&params));

    // Set params from "main thread"
    let gains = [2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    params.write(&gains, true);

    // Process from "audio thread"
    let mut buffer = vec![0.5; 4096];
    let result = proc.process(&mut buffer, 2);

    assert!(!result.is_bypassed());
    // EQ gain smoothing may not boost the very first sample, but the block should change.
    assert!(buffer.iter().any(|&sample| (sample - 0.5).abs() > 1e-6));
}

#[test]
fn test_volume_processor_muted() {
    let params = Arc::new(AtomicVolumeParams::new());
    let mut proc = VolumeProcessor::new(Arc::clone(&params));

    params.set_volume(0.5);
    params.set_muted(true);

    let mut buffer = vec![1.0; 4096];
    proc.process(&mut buffer, 2);

    // Muting uses a click-free exponential fade rather than an instant hard cut.
    assert!(buffer[0] < 1.0);
    assert!(buffer[buffer.len() - 1] < 0.001);
}

#[test]
fn test_volume_processor_muted_fade_is_frame_coherent() {
    // The muted fade must decay per frame, not per sample: both channels of
    // a stereo frame must receive the identical gain. A per-sample decay
    // would give L and R different gains (inter-channel skew) and halve the
    // fade time constant.
    let params = Arc::new(AtomicVolumeParams::new());
    let mut proc = VolumeProcessor::new(Arc::clone(&params));

    params.set_muted(true);

    let channels = 2;
    let mut buffer = vec![1.0; channels * 512];
    proc.process(&mut buffer, channels);

    for frame in buffer.chunks_exact(channels) {
        assert_eq!(
            frame[0], frame[1],
            "L and R of the same frame must share one gain"
        );
    }
}

#[test]
fn test_volume_processor_writes_back_smoothed_volume() {
    let params = Arc::new(AtomicVolumeParams::new());
    let mut proc = VolumeProcessor::new(Arc::clone(&params));

    params.set_volume(0.25);
    let mut buffer = vec![1.0; 128];
    proc.process(&mut buffer, 2);

    let first_pass_volume = proc.current_volume;
    assert!(first_pass_volume < 1.0);
    assert!(first_pass_volume > 0.25);

    proc.process(&mut buffer, 2);

    assert!(proc.current_volume < first_pass_volume);
    assert!(proc.current_volume > 0.25);
}

#[test]
fn test_volume_processor_steady_state_fast_path_preserves_unity() {
    let params = Arc::new(AtomicVolumeParams::new());
    let mut proc = VolumeProcessor::new(Arc::clone(&params));
    proc.reset().unwrap();

    let mut buffer = vec![0.25, -0.5, 0.75, -1.0];
    let original = buffer.clone();

    assert!(!proc.process(&mut buffer, 2).is_bypassed());
    assert_eq!(buffer, original);
    assert_eq!(proc.current_volume, 1.0);
}

#[test]
fn test_volume_processor_steady_state_fast_path_applies_target() {
    let params = Arc::new(AtomicVolumeParams::new());
    params.set_volume(0.5);
    let mut proc = VolumeProcessor::new(Arc::clone(&params));
    proc.sync_params();
    proc.reset().unwrap();

    let mut buffer = vec![0.25, -0.5, 0.75, -1.0];

    assert!(!proc.process(&mut buffer, 2).is_bypassed());
    assert_eq!(buffer, vec![0.125, -0.25, 0.375, -0.5]);
    assert_eq!(proc.current_volume, 0.5);
}

#[test]
fn volume_lazy_settle_dc_null_residual_stays_below_snap_floor() {
    let input = vec![0.8; 32_768 * 2];

    assert_lazy_settle_residual_bounds("dc", &input, 2);
}

#[test]
fn volume_lazy_settle_sweep_null_residual_stays_below_snap_floor() {
    let input = sweep_signal(32_768, 2);

    assert_lazy_settle_residual_bounds("sweep", &input, 2);
}

#[test]
fn volume_lazy_settle_abrupt_step_null_residual_stays_below_snap_floor() {
    let input = abrupt_step_signal(32_768, 2);

    assert_lazy_settle_residual_bounds("abrupt_step", &input, 2);
}

#[test]
fn test_saturation_processor() {
    let params = Arc::new(AtomicSaturationParams::new());
    let mut proc = SaturationProcessor::new(2, Arc::clone(&params));

    params.set_drive(1.0);
    params.set_mix(1.0);
    params.set_enabled(true);

    let mut buffer = vec![0.9, 0.9];
    proc.process(&mut buffer, 2);

    // tanh(0.9 * 2) ≈ 0.96, less than input
    assert!(buffer[0].abs() < 0.9 * 2.0);
}

#[test]
fn saturation_soft_disable_keeps_fixed_timeline_and_drains_delay() {
    let params = Arc::new(AtomicSaturationParams::new());
    params.set_mix(1.0);
    params.set_drive(1.0);
    let mut proc = SaturationProcessor::new(1, Arc::clone(&params));
    let mut input = vec![0.95; 64];
    let _ = proc.process(&mut input, 1);
    assert_eq!(proc.latency().frames(), SATURATION_LATENCY_FRAMES);

    params.set_enabled(false);
    let mut disabled = vec![0.25; SATURATION_TRANSITION_FRAMES + 8];
    let _ = proc.process(&mut disabled, 1);
    assert_eq!(proc.latency().frames(), SATURATION_LATENCY_FRAMES);
    assert!(disabled.iter().any(|sample| sample.abs() > 0.0));

    let mut scratch = [0.0; SATURATION_LATENCY_FRAMES];
    let mut saw_output = false;
    loop {
        let progress = super::super::traits::finish_checked(
            &mut proc,
            AudioBlockMut::new(&mut scratch, 1).unwrap(),
        )
        .unwrap();
        saw_output |= progress.produced_frames() > 0;
        if progress.state() == ProcessState::Finished {
            break;
        }
    }
    assert!(saw_output);
}

#[test]
fn saturation_sparse_events_start_at_exact_frame_and_are_chunk_stable() {
    let params = Arc::new(AtomicSaturationParams::new());
    params.set_mix(1.0);
    params.set_drive(0.75);
    let events = [SaturationEvent {
        frame_offset: 7,
        kind: SaturationEventKind::Quality(SaturationQualityValue::Oversampled4x),
    }];

    let mut whole = SaturationProcessor::new(1, Arc::clone(&params));
    let mut chunked = SaturationProcessor::new(1, Arc::clone(&params));
    let input = vec![0.95; 96];
    let mut whole_output = input.clone();
    let _ = whole
        .process_with_events(&mut whole_output, 1, &events)
        .unwrap();

    let mut chunked_output = input;
    let _ = chunked
        .process_with_events(&mut chunked_output[..7], 1, &[])
        .unwrap();
    let _ = chunked
        .process_with_events(
            &mut chunked_output[7..],
            1,
            &[SaturationEvent {
                frame_offset: 0,
                kind: SaturationEventKind::Quality(SaturationQualityValue::Oversampled4x),
            }],
        )
        .unwrap();

    assert!(whole_output[..7]
        .iter()
        .zip(&chunked_output[..7])
        .all(|(left, right)| left.to_bits() == right.to_bits()));
    assert!(whole_output[7..]
        .iter()
        .zip(&chunked_output[7..])
        .all(|(left, right)| (left - right).abs() < 1.0e-10));
}

#[test]
fn saturation_quality_transition_replays_target_source_history() {
    for highpass_mode in [false, true] {
        let switched_params = Arc::new(AtomicSaturationParams::new());
        switched_params.set_mix(1.0);
        switched_params.set_drive(0.9);
        switched_params.set_highpass_mode(highpass_mode);

        let direct_params = Arc::new(AtomicSaturationParams::new());
        direct_params.set_mix(1.0);
        direct_params.set_drive(0.9);
        direct_params.set_highpass_mode(highpass_mode);

        let target_params = Arc::new(AtomicSaturationParams::new());
        target_params.set_mix(1.0);
        target_params.set_drive(0.9);
        target_params.set_highpass_mode(highpass_mode);
        target_params.set_quality(SaturationQualityValue::Oversampled4x);

        let mut switched = SaturationProcessor::new(1, switched_params);
        let mut direct = SaturationProcessor::new(1, direct_params);
        let mut target = SaturationProcessor::new(1, target_params);
        let warm = (0..128)
            .map(|frame| ((frame as f64) * 0.371).sin() * 0.98)
            .collect::<Vec<_>>();
        let mut switched_warm = warm.clone();
        let mut direct_warm = warm.clone();
        let mut target_warm = warm;
        let _ = switched.process(&mut switched_warm, 1);
        let _ = direct.process(&mut direct_warm, 1);
        let _ = target.process(&mut target_warm, 1);

        let input = (128..176)
            .map(|frame| ((frame as f64) * 0.371).sin() * 0.98)
            .collect::<Vec<_>>();
        let mut actual = input.clone();
        let mut direct_output = input.clone();
        let mut target_output = input;
        let _ = switched
            .process_with_events(
                &mut actual,
                1,
                &[SaturationEvent {
                    frame_offset: 0,
                    kind: SaturationEventKind::Quality(SaturationQualityValue::Oversampled4x),
                }],
            )
            .unwrap();
        let _ = direct.process(&mut direct_output, 1);
        let _ = target.process(&mut target_output, 1);

        for frame in 0..SATURATION_TRANSITION_FRAMES {
            let t = frame as f64 / (SATURATION_TRANSITION_FRAMES - 1) as f64;
            let target_weight = t * t * (3.0 - 2.0 * t);
            let expected = direct_output[frame]
                + (target_output[frame] - direct_output[frame]) * target_weight;
            assert!(
                (actual[frame] - expected).abs() <= 1.0e-12,
                "highpass={highpass_mode} frame={frame} actual={} expected={expected}",
                actual[frame]
            );
        }
    }
}

#[test]
fn saturation_soft_disable_blends_to_ungained_delayed_input() {
    let params = Arc::new(AtomicSaturationParams::new());
    params.set_input_gain(6.0);
    params.set_output_gain(-3.0);
    params.set_mix(1.0);
    let mut proc = SaturationProcessor::new(1, params);
    let mut warm = vec![0.25; 64];
    let _ = proc.process(&mut warm, 1);

    let mut output = vec![0.25; SATURATION_TRANSITION_FRAMES + 2];
    let _ = proc
        .process_with_events(
            &mut output,
            1,
            &[SaturationEvent {
                frame_offset: 0,
                kind: SaturationEventKind::EffectEnabled(false),
            }],
        )
        .unwrap();

    assert!((output[SATURATION_TRANSITION_FRAMES - 1] - 0.25).abs() <= 1.0e-12);
    assert!((output[SATURATION_TRANSITION_FRAMES] - 0.25).abs() <= 1.0e-12);
}

#[test]
fn saturation_soft_reenable_replays_inactive_oversampling_history() {
    let reactivated_params = Arc::new(AtomicSaturationParams::new());
    reactivated_params.set_quality(SaturationQualityValue::Oversampled4x);
    reactivated_params.set_mix(1.0);
    reactivated_params.set_drive(0.9);
    reactivated_params.set_enabled(false);

    let wet_params = Arc::new(AtomicSaturationParams::new());
    wet_params.set_quality(SaturationQualityValue::Oversampled4x);
    wet_params.set_mix(1.0);
    wet_params.set_drive(0.9);

    let bypass_params = Arc::new(AtomicSaturationParams::new());
    bypass_params.set_quality(SaturationQualityValue::Oversampled4x);
    bypass_params.set_mix(1.0);
    bypass_params.set_drive(0.9);
    bypass_params.set_enabled(false);

    let mut reactivated = SaturationProcessor::new(1, reactivated_params);
    let mut wet = SaturationProcessor::new(1, wet_params);
    let mut bypass = SaturationProcessor::new(1, bypass_params);
    let warm = (0..128)
        .map(|frame| ((frame as f64) * 0.293).cos() * 0.98)
        .collect::<Vec<_>>();
    let mut reactivated_warm = warm.clone();
    let mut wet_warm = warm.clone();
    let mut bypass_warm = warm;
    let _ = reactivated.process(&mut reactivated_warm, 1);
    let _ = wet.process(&mut wet_warm, 1);
    let _ = bypass.process(&mut bypass_warm, 1);

    let input = (128..176)
        .map(|frame| ((frame as f64) * 0.293).cos() * 0.98)
        .collect::<Vec<_>>();
    let mut actual = input.clone();
    let mut wet_output = input.clone();
    let mut bypass_output = input;
    let _ = reactivated
        .process_with_events(
            &mut actual,
            1,
            &[SaturationEvent {
                frame_offset: 0,
                kind: SaturationEventKind::EffectEnabled(true),
            }],
        )
        .unwrap();
    let _ = wet.process(&mut wet_output, 1);
    let _ = bypass.process(&mut bypass_output, 1);

    for frame in 0..SATURATION_TRANSITION_FRAMES {
        let t = frame as f64 / (SATURATION_TRANSITION_FRAMES - 1) as f64;
        let wet_weight = t * t * (3.0 - 2.0 * t);
        let expected =
            bypass_output[frame] + (wet_output[frame] - bypass_output[frame]) * wet_weight;
        assert!(
            (actual[frame] - expected).abs() <= 1.0e-12,
            "frame={frame} actual={} expected={expected}",
            actual[frame]
        );
    }
}

#[test]
fn saturation_dense_quality_retargeting_preserves_weight_sum_and_chunking() {
    let params = Arc::new(AtomicSaturationParams::new());
    params.set_mix(1.0);
    params.set_drive(0.9);
    let qualities = [
        SaturationQualityValue::Oversampled4x,
        SaturationQualityValue::Oversampled2x,
        SaturationQualityValue::Direct,
    ];
    let events = (1..48)
        .map(|frame_offset| SaturationEvent {
            frame_offset,
            kind: SaturationEventKind::Quality(qualities[(frame_offset - 1) % qualities.len()]),
        })
        .collect::<Vec<_>>();
    let input = (0..96)
        .map(|frame| ((frame as f64) * 0.173).sin() * 0.95)
        .collect::<Vec<_>>();
    let mut whole = SaturationProcessor::new(1, Arc::clone(&params));
    let mut chunked = SaturationProcessor::new(1, Arc::clone(&params));
    let mut invariant = SaturationProcessor::new(1, Arc::clone(&params));
    let mut whole_output = input.clone();
    let mut chunked_output = input;

    let mut sample = [0.9];
    for quality in qualities.into_iter().cycle().take(47) {
        let _ = invariant
            .process_with_events(
                &mut sample,
                1,
                &[SaturationEvent {
                    frame_offset: 0,
                    kind: SaturationEventKind::Quality(quality),
                }],
            )
            .unwrap();
        assert!(invariant
            .quality_weights
            .iter()
            .all(|weight| weight.is_finite() && *weight >= 0.0));
        assert!((invariant.quality_weights.iter().sum::<f64>() - 1.0).abs() <= 1.0e-12);
    }

    let _ = whole
        .process_with_events(&mut whole_output, 1, &events)
        .unwrap();
    let chunk_pattern = [1, 7, 3, 19, 2, 11];
    let mut start = 0usize;
    let mut pattern = 0usize;
    while start < chunked_output.len() {
        let end = (start + chunk_pattern[pattern % chunk_pattern.len()]).min(chunked_output.len());
        let local_events = events
            .iter()
            .filter(|event| (start..end).contains(&event.frame_offset))
            .map(|event| SaturationEvent {
                frame_offset: event.frame_offset - start,
                kind: event.kind,
            })
            .collect::<Vec<_>>();
        let _ = chunked
            .process_with_events(&mut chunked_output[start..end], 1, &local_events)
            .unwrap();
        start = end;
        pattern += 1;
    }

    assert!(whole
        .quality_weights
        .iter()
        .all(|weight| weight.is_finite()));
    assert!((whole.quality_weights.iter().sum::<f64>() - 1.0).abs() <= 1.0e-12);
    assert!(whole_output
        .iter()
        .zip(&chunked_output)
        .all(|(left, right)| (left - right).abs() <= 1.0e-12));
}

#[test]
fn saturation_same_offset_quality_events_coalesce_to_last_value() {
    let params = Arc::new(AtomicSaturationParams::new());
    let mut proc = SaturationProcessor::new(1, params);
    let mut samples = [0.9; 4];
    let events = [
        SaturationEvent {
            frame_offset: 0,
            kind: SaturationEventKind::Quality(SaturationQualityValue::Oversampled4x),
        },
        SaturationEvent {
            frame_offset: 0,
            kind: SaturationEventKind::Quality(SaturationQualityValue::Direct),
        },
        SaturationEvent {
            frame_offset: 0,
            kind: SaturationEventKind::Quality(SaturationQualityValue::Oversampled2x),
        },
    ];

    let _ = proc.process_with_events(&mut samples, 1, &events).unwrap();

    assert_eq!(
        proc.quality_transition_target,
        Some(SaturationQualityValue::Oversampled2x)
    );
}

fn dirty_all_saturation_quality_slots(proc: &mut SaturationProcessor) {
    let mut samples = (0..96)
        .map(|frame| ((frame as f64) * 0.137).cos() * 0.9)
        .collect::<Vec<_>>();
    let events = [
        SaturationEvent {
            frame_offset: 1,
            kind: SaturationEventKind::Quality(SaturationQualityValue::Oversampled4x),
        },
        SaturationEvent {
            frame_offset: 2,
            kind: SaturationEventKind::Quality(SaturationQualityValue::Oversampled2x),
        },
        SaturationEvent {
            frame_offset: 3,
            kind: SaturationEventKind::Quality(SaturationQualityValue::Direct),
        },
    ];
    let _ = proc.process_with_events(&mut samples, 1, &events).unwrap();
}

fn assert_saturation_quality_bank_matches_fresh(
    reused: &mut SaturationProcessor,
    fresh: &mut SaturationProcessor,
) {
    let events = [
        SaturationEvent {
            frame_offset: 0,
            kind: SaturationEventKind::Quality(SaturationQualityValue::Oversampled4x),
        },
        SaturationEvent {
            frame_offset: 1,
            kind: SaturationEventKind::Quality(SaturationQualityValue::Oversampled2x),
        },
        SaturationEvent {
            frame_offset: 2,
            kind: SaturationEventKind::Quality(SaturationQualityValue::Direct),
        },
    ];
    let input = (0..128)
        .map(|frame| ((frame as f64) * 0.097).sin() * 0.92)
        .collect::<Vec<_>>();
    let mut actual = input.clone();
    let mut expected = input;
    let _ = reused.process_with_events(&mut actual, 1, &events).unwrap();
    let _ = fresh
        .process_with_events(&mut expected, 1, &events)
        .unwrap();
    assert!(actual
        .iter()
        .zip(&expected)
        .all(|(left, right)| left.to_bits() == right.to_bits()));
}

#[test]
fn saturation_reset_clears_every_preallocated_quality_state() {
    let params = Arc::new(AtomicSaturationParams::new());
    let mut reused = SaturationProcessor::new(1, Arc::clone(&params));
    dirty_all_saturation_quality_slots(&mut reused);
    reused.reset().unwrap();
    let mut fresh = SaturationProcessor::new(1, params);

    assert_saturation_quality_bank_matches_fresh(&mut reused, &mut fresh);
}

#[test]
fn saturation_sample_rate_change_clears_every_preallocated_quality_state() {
    let params = Arc::new(AtomicSaturationParams::new());
    let mut reused = SaturationProcessor::new(1, Arc::clone(&params));
    dirty_all_saturation_quality_slots(&mut reused);
    reused.set_sample_rate(96_000).unwrap();
    let mut fresh = SaturationProcessor::new(1, params);
    fresh.set_sample_rate(96_000).unwrap();

    assert_saturation_quality_bank_matches_fresh(&mut reused, &mut fresh);
}

#[test]
fn saturation_finish_completes_last_frame_quality_transition() {
    let params = Arc::new(AtomicSaturationParams::new());
    params.set_mix(1.0);
    params.set_drive(1.0);
    let mut proc = SaturationProcessor::new(1, params);
    let mut input = vec![0.95; 16];
    let _ = proc
        .process_with_events(
            &mut input,
            1,
            &[SaturationEvent {
                frame_offset: 15,
                kind: SaturationEventKind::Quality(SaturationQualityValue::Oversampled4x),
            }],
        )
        .unwrap();
    let expected_finish_frames = proc.finite_finish_frames();
    let semantic_tail = proc.tail().finite_duration().unwrap().frames();
    assert_eq!(
        expected_finish_frames,
        SATURATION_LATENCY_FRAMES + semantic_tail
    );
    assert_eq!(expected_finish_frames, SATURATION_TRANSITION_FRAMES - 1);

    let mut produced = 0usize;
    let mut scratch = [0.0; 5];
    loop {
        let progress = super::super::traits::finish_checked(
            &mut proc,
            AudioBlockMut::new(&mut scratch, 1).unwrap(),
        )
        .unwrap();
        produced += progress.produced_frames();
        if progress.state() == ProcessState::Finished {
            break;
        }
    }
    assert_eq!(produced, expected_finish_frames);
    assert_eq!(proc.quality_transition_target, None);
}

#[test]
fn saturation_event_validation_is_typed_and_non_mutating() {
    let params = Arc::new(AtomicSaturationParams::new());
    let mut proc = SaturationProcessor::new(1, params);
    let mut samples = [0.5; 8];
    let before = samples;
    let result = proc.process_with_events(
        &mut samples,
        1,
        &[
            SaturationEvent {
                frame_offset: 4,
                kind: SaturationEventKind::EffectEnabled(false),
            },
            SaturationEvent {
                frame_offset: 2,
                kind: SaturationEventKind::EffectEnabled(true),
            },
        ],
    );
    assert!(matches!(
        result,
        Err(ProcessError::InvalidAutomation { .. })
    ));
    assert_eq!(samples, before);
}

#[test]
fn saturation_finite_finish_preserves_delayed_impulse_for_all_quality_modes() {
    for quality in [
        SaturationQualityValue::Direct,
        SaturationQualityValue::Oversampled2x,
        SaturationQualityValue::Oversampled4x,
    ] {
        let params = Arc::new(AtomicSaturationParams::new());
        params.set_mix(1.0);
        params.set_drive(1.0);
        params.set_quality(quality);
        let mut proc = SaturationProcessor::new(1, Arc::clone(&params));
        let mut input = vec![0.0; 16];
        input[15] = 0.95;
        let _ = proc.process(&mut input, 1);
        let finish_frames = proc.finite_finish_frames();
        let expected_finish_frames = match quality {
            SaturationQualityValue::Direct => SATURATION_LATENCY_FRAMES,
            SaturationQualityValue::Oversampled2x | SaturationQualityValue::Oversampled4x => 8,
        };
        assert_eq!(finish_frames, expected_finish_frames);

        let quality_index = SaturationProcessor::quality_index(quality);
        let mut oracle = proc.quality_states[quality_index].clone();
        let mut oracle_tail = vec![0.0; finish_frames + 1];
        oracle.process_with_channels_mix(&mut oracle_tail, 1, 1.0);

        let mut tail = Vec::new();
        let mut scratch = [0.0; 3];
        loop {
            let progress = super::super::traits::finish_checked(
                &mut proc,
                AudioBlockMut::new(&mut scratch, 1).unwrap(),
            )
            .unwrap();
            tail.extend_from_slice(&scratch[..progress.produced_frames()]);
            if progress.state() == ProcessState::Finished {
                break;
            }
        }
        assert_eq!(tail.len(), finish_frames);
        assert_eq!(tail, oracle_tail[..finish_frames]);
        assert_ne!(tail.last().copied().unwrap_or(0.0), 0.0);
        assert_eq!(oracle_tail[finish_frames], 0.0);
    }
}

#[test]
fn sample_rate_change_rearms_every_fixed_adapter_lifecycle() {
    fn assert_rearmed(mut processor: impl StreamingProcessor, channels: usize) {
        let mut finish_output = vec![0.0; channels * 16];
        let finished = super::super::traits::finish_checked(
            &mut processor,
            AudioBlockMut::new(&mut finish_output, channels).unwrap(),
        )
        .unwrap();
        assert_eq!(
            finished.state(),
            ProcessState::Finished,
            "{}",
            processor.name()
        );

        processor.set_sample_rate(96_000).unwrap();
        let mut input = vec![0.25; channels * 4];
        let block = AudioBlockMut::new(&mut input, channels).unwrap();
        let progress =
            super::super::traits::process_checked(&mut processor, ProcessBuffers::in_place(block))
                .unwrap();
        assert_eq!(
            progress.state(),
            ProcessState::NeedInput,
            "{}",
            processor.name()
        );
    }

    let eq = Arc::new(AtomicEqParams::new());
    eq.set_enabled(false);
    assert_rearmed(EqProcessor::new(2, 48_000.0, eq), 2);

    let saturation = Arc::new(AtomicSaturationParams::new());
    saturation.set_armed(false);
    assert_rearmed(SaturationProcessor::new(2, saturation), 2);

    let crossfeed = Arc::new(AtomicCrossfeedParams::new());
    crossfeed.set_enabled(false);
    assert_rearmed(CrossfeedProcessor::new(48_000.0, crossfeed), 2);

    let limiter = Arc::new(AtomicPeakLimiterParams::new());
    limiter.set_enabled(false);
    assert_rearmed(PeakLimiterProcessor::new(2, 48_000, limiter).unwrap(), 2);

    assert_rearmed(VolumeProcessor::new(Arc::new(AtomicVolumeParams::new())), 2);
    assert_rearmed(
        NoiseShaperProcessor::new(2, 48_000, Arc::new(AtomicNoiseShaperParams::new())).unwrap(),
        2,
    );

    let dynamic = Arc::new(AtomicDynamicLoudnessParams::new());
    dynamic.set_enabled(false);
    assert_rearmed(
        DynamicLoudnessProcessor::new(
            2,
            48_000,
            dynamic,
            Arc::new(AtomicDynamicLoudnessTelemetry::new()),
        )
        .unwrap(),
        2,
    );
}

#[test]
fn saturation_event_processing_is_allocation_free_after_setup() {
    let params = Arc::new(AtomicSaturationParams::new());
    let mut proc = SaturationProcessor::new(2, params);
    let mut samples = vec![0.9; 128 * 2];
    let events = [
        SaturationEvent {
            frame_offset: 7,
            kind: SaturationEventKind::Quality(SaturationQualityValue::Oversampled4x),
        },
        SaturationEvent {
            frame_offset: 63,
            kind: SaturationEventKind::EffectEnabled(false),
        },
    ];

    assert_no_alloc::assert_no_alloc(|| {
        let _ = proc.process_with_events(&mut samples, 2, &events).unwrap();
    });
}

#[test]
fn crossfeed_processor_mix_change_preserves_filter_history() {
    let params = Arc::new(AtomicCrossfeedParams::new());
    let mut proc = CrossfeedProcessor::new(48_000.0, Arc::clone(&params));
    let mut reference = Crossfeed::with_params(48_000.0, 700.0, 0.35);
    let mut reset_reference = Crossfeed::with_params(48_000.0, 700.0, 0.35);

    let warm = hard_panned_sine(2048, 0, 48_000.0, 997.0);
    let mut proc_warm = warm.clone();
    let mut ref_warm = warm.clone();
    let mut reset_warm = warm;
    proc.process(&mut proc_warm, 2);
    reference.process(&mut ref_warm, 2);
    reset_reference.process(&mut reset_warm, 2);

    params.set_mix(0.7);
    reference.set_mix(0.7);
    reset_reference.set_mix(0.7);
    reset_reference.set_sample_rate(48_000.0, 700.0);

    let next = hard_panned_sine(256, 2048, 48_000.0, 997.0);
    let mut proc_next = next.clone();
    let mut ref_next = next.clone();
    let mut reset_next = next;
    assert!(!proc.process(&mut proc_next, 2).is_bypassed());
    reference.process(&mut ref_next, 2);
    reset_reference.process(&mut reset_next, 2);

    let max_reference_delta = max_abs_delta(&proc_next, &ref_next);
    let max_reset_delta = max_abs_delta(&proc_next, &reset_next);
    assert!(
            max_reference_delta <= 1.0e-12,
            "mix change should preserve Bauer filter state, max_reference_delta={max_reference_delta:.3e}"
        );
    assert!(
        max_reset_delta > 1.0e-4,
        "test signal should distinguish reset history, max_reset_delta={max_reset_delta:.3e}"
    );
}

#[test]
fn crossfeed_processor_cutoff_change_preserves_filter_history() {
    let params = Arc::new(AtomicCrossfeedParams::new());
    let mut proc = CrossfeedProcessor::new(48_000.0, Arc::clone(&params));
    let mut reference = Crossfeed::with_params(48_000.0, 700.0, 0.35);
    let mut reset_reference = Crossfeed::with_params(48_000.0, 700.0, 0.35);

    let warm = hard_panned_sine(2048, 0, 48_000.0, 431.0);
    let mut proc_warm = warm.clone();
    let mut reference_warm = warm.clone();
    let mut reset_warm = warm;
    proc.process(&mut proc_warm, 2);
    reference.process(&mut reference_warm, 2);
    reset_reference.process(&mut reset_warm, 2);

    params.set_cutoff(1_100.0);
    reference.set_cutoff(1_100.0);
    reset_reference.set_sample_rate(48_000.0, 1_100.0);

    let next = hard_panned_sine(512, 2048, 48_000.0, 431.0);
    let mut proc_next = next.clone();
    let mut reference_next = next.clone();
    let mut reset_next = next;
    proc.process(&mut proc_next, 2);
    reference.process(&mut reference_next, 2);
    reset_reference.process(&mut reset_next, 2);

    let max_reference_delta = max_abs_delta(&proc_next, &reference_next);
    let max_reset_delta = max_abs_delta(&proc_next, &reset_next);
    assert!(
            max_reference_delta <= 1.0e-12,
            "cutoff change should preserve and ramp Bauer state, max_reference_delta={max_reference_delta:.3e}"
        );
    assert!(
        max_reset_delta > 1.0e-4,
        "test signal should distinguish reset history, max_reset_delta={max_reset_delta:.3e}"
    );
}

#[test]
fn crossfeed_processor_steady_state_process_is_allocation_free() {
    let params = Arc::new(AtomicCrossfeedParams::new());
    let mut proc = CrossfeedProcessor::new(48_000.0, Arc::clone(&params));
    let mut buffer = hard_panned_sine(512, 0, 48_000.0, 997.0);

    proc.process(&mut buffer, 2);

    assert_no_alloc::assert_no_alloc(|| {
        for _ in 0..200 {
            proc.process(&mut buffer, 2);
        }
    });
}

#[test]
fn noise_shaper_bits_change_does_not_reset_unchanged_curve_history() {
    let params = Arc::new(AtomicNoiseShaperParams::new());
    let mut processor = NoiseShaperProcessor::new(2, 48_000, Arc::clone(&params)).unwrap();
    let mut reference = NoiseShaper::new(2, 48_000, 24).unwrap();
    reference.set_curve(params.curve());

    let mut warm = hard_panned_sine(2048, 0, 48_000.0, 997.0);
    let mut reference_warm = warm.clone();
    processor.process(&mut warm, 2);
    reference.process(&mut reference_warm, 2).unwrap();
    assert_eq!(warm, reference_warm);

    params.set_bits(16);
    reference.set_bits(16);
    let mut next = hard_panned_sine(512, 2048, 48_000.0, 997.0);
    let mut reference_next = next.clone();
    processor.process(&mut next, 2);
    reference.process(&mut reference_next, 2).unwrap();

    assert_eq!(next, reference_next);
}

fn assert_lazy_settle_residual_bounds(name: &str, input: &[f64], channels: usize) {
    const RESIDUAL_DELTA_LIMIT: f64 = 2.0e-6;
    const RESIDUAL_RMS_LIMIT: f64 = 2.0e-7;

    let mut exact = input.to_vec();
    let mut lazy = input.to_vec();
    process_volume_exact_kernel(&mut exact, channels, 48_000.0, 0.25);
    process_volume_lazy_settle_kernel(
        &mut lazy,
        channels,
        48_000.0,
        0.25,
        VolumeProcessor::SETTLE_EPSILON,
    );

    let mut max_abs = 0.0_f64;
    let mut sum_sq = 0.0_f64;
    let mut max_delta = 0.0_f64;
    let mut prev_residual = 0.0_f64;

    for (idx, (left, right)) in lazy.iter().zip(&exact).enumerate() {
        let residual = left - right;
        max_abs = max_abs.max(residual.abs());
        sum_sq += residual * residual;
        if idx > 0 {
            max_delta = max_delta.max((residual - prev_residual).abs());
        }
        prev_residual = residual;
    }

    let rms = (sum_sq / input.len() as f64).sqrt();
    assert!(
        max_abs <= VolumeProcessor::SETTLE_EPSILON,
        "{name} lazy-settle max residual {max_abs:.3e} exceeds {:.3e}",
        VolumeProcessor::SETTLE_EPSILON
    );
    assert!(
        max_delta <= RESIDUAL_DELTA_LIMIT,
        "{name} lazy-settle residual delta {max_delta:.3e} exceeds {RESIDUAL_DELTA_LIMIT:.3e}"
    );
    assert!(
        rms <= RESIDUAL_RMS_LIMIT,
        "{name} lazy-settle residual rms {rms:.3e} exceeds {RESIDUAL_RMS_LIMIT:.3e}"
    );
}

fn process_volume_exact_kernel(
    buffer: &mut [f64],
    channels: usize,
    sample_rate: f64,
    target: f64,
) -> f64 {
    let smoothing_coeff = VolumeProcessor::calc_smoothing_coeff(sample_rate);
    let one_minus_coeff = 1.0 - smoothing_coeff;
    let mut current_volume = 1.0;
    let frames = buffer.len() / channels;

    for frame in 0..frames {
        current_volume += (target - current_volume) * one_minus_coeff;
        for ch in 0..channels {
            buffer[frame * channels + ch] *= current_volume;
        }
    }

    current_volume
}

fn process_volume_lazy_settle_kernel(
    buffer: &mut [f64],
    channels: usize,
    sample_rate: f64,
    target: f64,
    settle_epsilon: f64,
) -> f64 {
    let smoothing_coeff = VolumeProcessor::calc_smoothing_coeff(sample_rate);
    let one_minus_coeff = 1.0 - smoothing_coeff;
    let mut current_volume = 1.0;
    let frames = buffer.len() / channels;
    let mut frame = 0;

    while frame < frames {
        if (target - current_volume).abs() <= settle_epsilon {
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

    current_volume
}

fn sweep_signal(frames: usize, channels: usize) -> Vec<f64> {
    let mut out = Vec::with_capacity(frames * channels);
    let sample_rate = 48_000.0;
    let start_hz = 20.0_f64;
    let end_hz = 20_000.0_f64;
    let mut phase = 0.0_f64;

    for frame in 0..frames {
        let progress = frame as f64 / frames.saturating_sub(1).max(1) as f64;
        let hz = start_hz * (end_hz / start_hz).powf(progress);
        phase += std::f64::consts::TAU * hz / sample_rate;
        let sample = phase.sin() * 0.9;
        for ch in 0..channels {
            out.push(sample * (1.0 - ch as f64 * 0.05));
        }
    }

    out
}

fn abrupt_step_signal(frames: usize, channels: usize) -> Vec<f64> {
    let mut out = Vec::with_capacity(frames * channels);

    for frame in 0..frames {
        let sample = match frame * 4 / frames.max(1) {
            0 => 0.0,
            1 => 1.0,
            2 => -1.0,
            _ => {
                if frame % 2 == 0 {
                    1.0
                } else {
                    -1.0
                }
            }
        };
        for _ in 0..channels {
            out.push(sample);
        }
    }

    out
}

fn hard_panned_sine(
    frames: usize,
    start_frame: usize,
    sample_rate: f64,
    frequency: f64,
) -> Vec<f64> {
    let mut out = Vec::with_capacity(frames * 2);
    let omega = std::f64::consts::TAU * frequency / sample_rate;
    for frame in start_frame..start_frame + frames {
        out.push((omega * frame as f64).sin() * 0.8);
        out.push(0.0);
    }
    out
}

fn max_abs_delta(left: &[f64], right: &[f64]) -> f64 {
    left.iter()
        .zip(right)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0, f64::max)
}

#[test]
fn fixed_bypass_copies_out_of_place_and_reports_backpressure() {
    let params = Arc::new(AtomicEqParams::new());
    params.write(&[0.0; EQ_BANDS], false);
    let mut proc = EqProcessor::new(2, 48_000.0, params);
    let input = [0.1, -0.2, 0.3, -0.4];
    let mut output = [9.0, 9.0];

    let buffers = ProcessBuffers::out_of_place(
        AudioBlockRef::new(&input, 2).unwrap(),
        AudioBlockMut::new(&mut output, 2).unwrap(),
    )
    .unwrap();
    let progress = super::super::traits::process_checked(&mut proc, buffers).unwrap();

    assert_eq!(progress.consumed_frames(), 1);
    assert_eq!(progress.produced_frames(), 1);
    assert_eq!(progress.state(), ProcessState::NeedOutput);
    assert!(progress.is_bypassed());
    assert_eq!(output, input[..2]);
}

#[test]
fn fixed_out_of_place_matches_in_place_processing() {
    let params = Arc::new(AtomicVolumeParams::new());
    params.set_volume(0.5);
    let mut in_place = VolumeProcessor::new(Arc::clone(&params));
    let mut out_of_place = VolumeProcessor::new(params);
    in_place.reset().unwrap();
    out_of_place.reset().unwrap();

    let input = [0.25, -0.5, 0.75, -1.0];
    let mut expected = input;
    let _ = in_place.process(&mut expected, 2);
    let mut actual = [0.0; 4];
    let buffers = ProcessBuffers::out_of_place(
        AudioBlockRef::new(&input, 2).unwrap(),
        AudioBlockMut::new(&mut actual, 2).unwrap(),
    )
    .unwrap();
    let progress = super::super::traits::process_checked(&mut out_of_place, buffers).unwrap();

    assert_eq!(progress.consumed_frames(), 2);
    assert_eq!(progress.produced_frames(), 2);
    assert_eq!(progress.state(), ProcessState::NeedInput);
    assert!(!progress.is_bypassed());
    assert_eq!(actual, expected);
}

#[test]
fn fixed_finish_requires_reset_before_more_input() {
    let params = Arc::new(AtomicVolumeParams::new());
    let mut proc = VolumeProcessor::new(params);
    let mut finish_output = [0.0; 2];
    let finished = super::super::traits::finish_checked(
        &mut proc,
        AudioBlockMut::new(&mut finish_output, 2).unwrap(),
    )
    .unwrap();
    assert_eq!(finished.state(), ProcessState::Finished);

    let mut input = [0.25, -0.25];
    let block = AudioBlockMut::new(&mut input, 2).unwrap();
    assert_eq!(
        super::super::traits::process_checked(&mut proc, ProcessBuffers::in_place(block),),
        Err(ProcessError::AlreadyFinished {
            processor: "Volume",
        })
    );

    proc.reset().unwrap();
    let _ = proc.process(&mut input, 2);
}

#[test]
fn configured_channel_count_is_validated_before_processing() {
    let params = Arc::new(AtomicNoiseShaperParams::new());
    let mut proc = NoiseShaperProcessor::new(2, 48_000, params).unwrap();
    let mut mono = [0.25; 4];
    let block = AudioBlockMut::new(&mut mono, 1).unwrap();

    assert_eq!(
        super::super::traits::process_checked(&mut proc, ProcessBuffers::in_place(block),),
        Err(ProcessError::ChannelCountMismatch {
            processor: "NoiseShaper",
            expected_channels: 2,
            actual_channels: 1,
        })
    );
}

#[test]
fn crossfeed_non_stereo_bypass_has_no_finish_tail() {
    for channels in [1, 3] {
        let params = Arc::new(AtomicCrossfeedParams::new());
        params.set_enabled(true);
        let mut processor = CrossfeedProcessor::new(48_000.0, params);
        let mut input = vec![0.25; channels * 8];
        let original = input.clone();
        let progress = processor.process(&mut input, channels);

        assert!(progress.is_bypassed());
        assert_eq!(input, original);
        assert_eq!(processor.tail(), TailSpec::None);

        let mut output = vec![9.0; channels * 8];
        let progress = super::super::traits::finish_checked(
            &mut processor,
            AudioBlockMut::new(&mut output, channels).unwrap(),
        )
        .unwrap();
        assert_eq!(progress, ProcessProgress::finished(0));
        assert_eq!(output, vec![9.0; channels * 8]);
    }
}

#[test]
fn fixed_out_of_place_processing_is_allocation_free_after_setup() {
    let params = Arc::new(AtomicVolumeParams::new());
    params.set_volume(0.5);
    let mut proc = VolumeProcessor::new(params);
    proc.reset().unwrap();
    let input = [0.25; 512 * 2];
    let mut output = [0.0; 512 * 2];

    assert_no_alloc::assert_no_alloc(|| {
        let buffers = ProcessBuffers::out_of_place(
            AudioBlockRef::new(&input, 2).unwrap(),
            AudioBlockMut::new(&mut output, 2).unwrap(),
        )
        .unwrap();
        let _ = super::super::traits::process_checked(&mut proc, buffers).unwrap();
    });
}

#[test]
fn peak_limiter_processor_defaults_to_true_peak_mode() {
    let params = Arc::new(AtomicPeakLimiterParams::new());
    let proc = PeakLimiterProcessor::new(2, 48_000, Arc::clone(&params)).unwrap();
    assert_eq!(proc.limiter.mode(), LimiterMode::TruePeak);
}

#[test]
fn final_output_limiter_forces_true_peak_mode() {
    let limiter_params = Arc::new(AtomicPeakLimiterParams::new());
    limiter_params.set_mode(LimiterMode::SamplePeak);
    let noise_params = Arc::new(AtomicNoiseShaperParams::new());
    let mut proc = PeakLimiterProcessor::new_with_output_guard(
        2,
        48_000,
        Arc::clone(&limiter_params),
        noise_params,
    )
    .unwrap();
    assert_eq!(proc.limiter.mode(), LimiterMode::TruePeak);

    let mut buffer = vec![0.25; 32 * 2];
    let _ = proc.process(&mut buffer, 2);
    assert_eq!(proc.limiter.mode(), LimiterMode::TruePeak);
}

#[test]
fn final_output_guard_survives_callback_sample_rate_initialization() {
    let limiter_params = Arc::new(AtomicPeakLimiterParams::new());
    limiter_params.set_threshold(-1.0);
    let noise_params = Arc::new(AtomicNoiseShaperParams::new());
    noise_params.set_enabled(true);
    noise_params.set_bits(8);
    noise_params.set_curve(NoiseShaperCurve::TpdfOnly);

    let mut initialized_at_source_rate = PeakLimiterProcessor::new_with_output_guard(
        1,
        44_100,
        Arc::clone(&limiter_params),
        Arc::clone(&noise_params),
    )
    .unwrap();
    initialized_at_source_rate.set_sample_rate(48_000).unwrap();
    let mut initialized_at_output_rate =
        PeakLimiterProcessor::new_with_output_guard(1, 48_000, limiter_params, noise_params)
            .unwrap();

    assert!(initialized_at_source_rate.output_ceiling_guard_db() > 0.0);
    assert_eq!(
        initialized_at_source_rate.output_ceiling_guard_db(),
        initialized_at_output_rate.output_ceiling_guard_db()
    );

    let mut rebuilt_output = vec![1.25; 2_048];
    let mut fresh_output = rebuilt_output.clone();
    let _ = initialized_at_source_rate.process(&mut rebuilt_output, 1);
    let _ = initialized_at_output_rate.process(&mut fresh_output, 1);
    assert_eq!(rebuilt_output, fresh_output);
}

#[test]
fn final_limiter_and_noise_shaper_share_one_block_snapshot() {
    let limiter_params = Arc::new(AtomicPeakLimiterParams::new());
    let noise_params = Arc::new(AtomicNoiseShaperParams::new());
    noise_params.set_bits(24);
    let latch = NoiseShaperSnapshotLatch::new(noise_params.read());
    let mut limiter = PeakLimiterProcessor::new_with_output_guard_latch(
        1,
        48_000,
        limiter_params,
        Arc::clone(&noise_params),
        latch.clone(),
    )
    .unwrap();
    let mut noise = NoiseShaperProcessor::new_with_output_guard_latch(
        1,
        48_000,
        Arc::clone(&noise_params),
        latch,
    )
    .unwrap();

    let mut limiter_block = [0.25; 32];
    let _ = limiter.process(&mut limiter_block, 1);
    noise_params.set_bits(8);
    let mut noise_block = limiter_block;
    let _ = noise.process(&mut noise_block, 1);
    assert_eq!(noise.noise_shaper.bits(), 24);

    let _ = limiter.process(&mut limiter_block, 1);
    let _ = noise.process(&mut noise_block, 1);
    assert_eq!(noise.noise_shaper.bits(), 8);
}

#[test]
fn peak_limiter_processor_applies_mode_snapshot() {
    let params = Arc::new(AtomicPeakLimiterParams::new());
    let mut proc = PeakLimiterProcessor::new(2, 48_000, Arc::clone(&params)).unwrap();
    assert_eq!(proc.limiter.mode(), LimiterMode::TruePeak);

    // Control thread switches mode; the snapshot is applied on the next
    // process() sync.
    params.set_mode(LimiterMode::SamplePeak);
    let mut buffer = vec![0.25; 256 * 2];
    proc.process(&mut buffer, 2);
    assert_eq!(proc.limiter.mode(), LimiterMode::SamplePeak);

    params.set_mode(LimiterMode::TruePeak);
    proc.process(&mut buffer, 2);
    assert_eq!(proc.limiter.mode(), LimiterMode::TruePeak);
}

#[test]
fn peak_limiter_processor_mode_switch_is_allocation_free_in_process() {
    let params = Arc::new(AtomicPeakLimiterParams::new());
    let mut proc = PeakLimiterProcessor::new(2, 48_000, Arc::clone(&params)).unwrap();
    let mut buffer = vec![0.3; 256 * 2];
    // Warm up the cached generation so the first asserted block is steady.
    proc.process(&mut buffer, 2);

    // Flipping the atomic mode is a control-plane call (its rcu publish
    // allocates a fresh snapshot), so it stays outside the no-alloc guard.
    // Consuming the flip and processing on the audio side must not
    // allocate: the limiter switches in place.
    for i in 0..200 {
        let mode = if i % 2 == 0 {
            LimiterMode::SamplePeak
        } else {
            LimiterMode::TruePeak
        };
        params.set_mode(mode);
        assert_no_alloc::assert_no_alloc(|| {
            proc.process(&mut buffer, 2);
        });
    }
}

#[test]
fn peak_limiter_processor_disabled_bypasses() {
    let params = Arc::new(AtomicPeakLimiterParams::new());
    let mut proc = PeakLimiterProcessor::new(2, 48_000, Arc::clone(&params)).unwrap();

    params.set_enabled(false);
    let mut buffer = vec![1.5; 256 * 2];
    let original = buffer.clone();
    let result = proc.process(&mut buffer, 2);

    assert!(result.is_bypassed());
    assert_eq!(buffer, original);
}

#[test]
fn dynamic_loudness_sample_rate_change_preserves_published_controls() {
    let params = Arc::new(AtomicDynamicLoudnessParams::new());
    params.set_ref_volume_db(-30.0);
    params.set_strength(0.37);
    let telemetry = Arc::new(AtomicDynamicLoudnessTelemetry::new());
    let mut proc = DynamicLoudnessProcessor::new(2, 48_000, params, telemetry).unwrap();
    let factor = proc.dynamic_loudness.loudness_factor();

    proc.set_sample_rate(96_000).unwrap();

    assert_eq!(proc.sample_rate, 96_000);
    assert_eq!(proc.dynamic_loudness.strength(), 0.37);
    assert_eq!(proc.dynamic_loudness.loudness_factor(), factor);
}

#[test]
fn dynamic_loudness_reset_matches_fresh_without_a_new_publication() {
    let params = Arc::new(AtomicDynamicLoudnessParams::new());
    params.write(true, 0.05, 0.37);
    let mut reset = DynamicLoudnessProcessor::new(
        2,
        48_000,
        Arc::clone(&params),
        Arc::new(AtomicDynamicLoudnessTelemetry::new()),
    )
    .unwrap();
    let mut prior_stream: Vec<f64> = (0..4_096)
        .map(|index| (index as f64 * 0.017).sin() * 0.25)
        .collect();
    let _ = reset.process(&mut prior_stream, 2);
    let cached_generation = reset.cached_generation;

    assert_no_alloc::assert_no_alloc(|| reset.reset().unwrap());

    assert_eq!(reset.cached_generation, cached_generation);
    let mut fresh = DynamicLoudnessProcessor::new(
        2,
        48_000,
        params,
        Arc::new(AtomicDynamicLoudnessTelemetry::new()),
    )
    .unwrap();
    assert_eq!(reset.dynamic_loudness.strength(), 0.37);
    assert_eq!(
        reset.dynamic_loudness.loudness_factor(),
        fresh.dynamic_loudness.loudness_factor()
    );
    assert_eq!(
        reset.dynamic_loudness.get_band_gains(),
        fresh.dynamic_loudness.get_band_gains()
    );

    let input: Vec<f64> = (0..8_192)
        .map(|index| {
            let time = index as f64 / (48_000.0 * 2.0);
            (std::f64::consts::TAU * 110.0 * time).sin() * 0.2
        })
        .collect();
    let mut actual = input.clone();
    let mut expected = input;
    let _ = reset.process(&mut actual, 2);
    let _ = fresh.process(&mut expected, 2);

    assert_eq!(actual, expected);
    assert_eq!(
        reset.dynamic_loudness.get_band_gains(),
        fresh.dynamic_loudness.get_band_gains()
    );
}

/// The three curve-tuning values must reach the DSP core through the parameter
/// layer, not just through the core's own setters.
#[test]
fn dynamic_loudness_tuning_reaches_the_dsp_core() {
    let params = Arc::new(AtomicDynamicLoudnessParams::new());
    let mut proc = DynamicLoudnessProcessor::new(
        2,
        48_000,
        Arc::clone(&params),
        Arc::new(AtomicDynamicLoudnessTelemetry::new()),
    )
    .unwrap();

    // Defaults match the core's own starting curve.
    assert_eq!(
        proc.dynamic_loudness.pre_gain_linear(),
        10.0_f64.powf(-3.0 / 20.0)
    );
    assert_eq!(proc.dynamic_loudness.transition_db(), 25.0);
    assert_eq!(proc.dynamic_loudness.compensation_ref_db(), -15.0);

    params.write_tuning(-6.0, 40.0, -20.0);
    let mut buffer = vec![0.0; 128 * 2];
    let _ = proc.process(&mut buffer, 2);

    assert_eq!(
        proc.dynamic_loudness.pre_gain_linear(),
        10.0_f64.powf(-6.0 / 20.0)
    );
    assert_eq!(proc.dynamic_loudness.transition_db(), 40.0);
    assert_eq!(proc.dynamic_loudness.compensation_ref_db(), -20.0);
}

/// Tuning and volume/strength ride separate generations, so an edit to one
/// never forces the callback to re-apply the other.
#[test]
fn dynamic_loudness_tuning_and_volume_generations_are_independent() {
    let params = Arc::new(AtomicDynamicLoudnessParams::new());
    let mut proc = DynamicLoudnessProcessor::new(
        2,
        48_000,
        Arc::clone(&params),
        Arc::new(AtomicDynamicLoudnessTelemetry::new()),
    )
    .unwrap();
    let mut buffer = vec![0.0; 64 * 2];

    let volume_generation = proc.cached_generation;
    let tuning_generation = proc.tuning_generation;

    params.set_pre_gain_db(-5.0);
    let _ = proc.process(&mut buffer, 2);
    assert_eq!(proc.cached_generation, volume_generation);
    assert_ne!(proc.tuning_generation, tuning_generation);

    let tuning_generation = proc.tuning_generation;
    params.set_strength(0.5);
    let _ = proc.process(&mut buffer, 2);
    assert_ne!(proc.cached_generation, volume_generation);
    assert_eq!(proc.tuning_generation, tuning_generation);
}

/// The added tuning read is a hot-path read: it must not allocate, whether or
/// not a new snapshot is waiting.
#[test]
fn dynamic_loudness_tuning_sync_does_not_allocate() {
    let params = Arc::new(AtomicDynamicLoudnessParams::new());
    let mut proc = DynamicLoudnessProcessor::new(
        2,
        48_000,
        Arc::clone(&params),
        Arc::new(AtomicDynamicLoudnessTelemetry::new()),
    )
    .unwrap();
    let mut buffer = vec![0.0; 128 * 2];

    // Steady state: nothing published since the last block.
    assert_no_alloc::assert_no_alloc(|| {
        let _ = proc.process(&mut buffer, 2);
    });

    // Change edge: a freshly published tuning snapshot is copied and applied.
    params.write_tuning(-4.5, 30.0, -18.0);
    assert_no_alloc::assert_no_alloc(|| {
        let _ = proc.process(&mut buffer, 2);
    });
    assert_eq!(proc.dynamic_loudness.transition_db(), 30.0);
}

/// A caller that never touches the tuning API must get byte-identical output.
#[test]
fn dynamic_loudness_default_tuning_is_unchanged() {
    let params = Arc::new(AtomicDynamicLoudnessParams::new());
    params.write(true, 0.05, 1.0);
    let mut proc = DynamicLoudnessProcessor::new(
        2,
        48_000,
        Arc::clone(&params),
        Arc::new(AtomicDynamicLoudnessTelemetry::new()),
    )
    .unwrap();

    // Explicitly republishing the documented defaults must be a no-op on the
    // signal, which pins the defaults against accidental drift.
    let explicit = Arc::new(AtomicDynamicLoudnessParams::new());
    explicit.write(true, 0.05, 1.0);
    explicit.write_tuning(-3.0, 25.0, -15.0);
    let mut pinned = DynamicLoudnessProcessor::new(
        2,
        48_000,
        explicit,
        Arc::new(AtomicDynamicLoudnessTelemetry::new()),
    )
    .unwrap();

    let input: Vec<f64> = (0..8_192)
        .map(|index| {
            let time = index as f64 / (48_000.0 * 2.0);
            (std::f64::consts::TAU * 110.0 * time).sin() * 0.2
        })
        .collect();
    let mut actual = input.clone();
    let mut expected = input;
    let _ = proc.process(&mut actual, 2);
    let _ = pinned.process(&mut expected, 2);

    assert_eq!(actual, expected);
}

/// Out-of-range input clamps; non-finite input keeps the previous value.
#[test]
fn dynamic_loudness_tuning_rejects_non_finite_and_clamps_range() {
    let params = Arc::new(AtomicDynamicLoudnessParams::new());

    params.set_pre_gain_db(12.0);
    assert_eq!(params.read_tuning().pre_gain_db, 0.0);
    params.set_transition_db(-100.0);
    assert_eq!(params.read_tuning().transition_db, 10.0);
    params.set_compensation_ref_db(50.0);
    assert_eq!(params.read_tuning().compensation_ref_db, 0.0);

    let retained = params.read_tuning();
    params.set_pre_gain_db(f64::NAN);
    params.set_transition_db(f64::INFINITY);
    params.set_compensation_ref_db(f64::NEG_INFINITY);
    assert_eq!(params.read_tuning(), retained);

    // A non-finite member rejects the whole coherent write.
    params.write_tuning(-5.0, f64::NAN, -20.0);
    assert_eq!(params.read_tuning(), retained);
}

#[test]
fn peak_limiter_finish_releases_exact_algorithmic_delay() {
    let params = Arc::new(AtomicPeakLimiterParams::new());
    let mut proc = PeakLimiterProcessor::new(1, 48_000, params).unwrap();
    let latency_frames = proc.limiter.delay_frames();
    let mut input = vec![0.0; 64];
    input[63] = 0.5;
    let _ = proc.process(&mut input, 1);
    assert!(input.iter().all(|sample| *sample == 0.0));
    assert_eq!(proc.latency().frames(), latency_frames);
    assert_eq!(proc.tail(), TailSpec::None);

    let mut drained = Vec::new();
    let mut scratch = vec![0.0; 37];
    loop {
        let progress = super::super::traits::finish_checked(
            &mut proc,
            AudioBlockMut::new(&mut scratch, 1).unwrap(),
        )
        .unwrap();
        drained.extend_from_slice(&scratch[..progress.produced_frames()]);
        if progress.state() == ProcessState::Finished {
            break;
        }
    }

    assert_eq!(drained.len(), latency_frames);
    assert!((drained[latency_frames - 1] - 0.5).abs() <= 1.0e-12);
    assert_eq!(
        super::super::traits::finish_checked(
            &mut proc,
            AudioBlockMut::new(&mut scratch, 1).unwrap(),
        )
        .unwrap(),
        ProcessProgress::finished(0)
    );
}

fn direct_interleaved_convolution(input: &[f64], ir: &[f64], channels: usize) -> Vec<f64> {
    let input_frames = input.len() / channels;
    let ir_frames = ir.len() / channels;
    let mut output = vec![0.0; (input_frames + ir_frames - 1) * channels];

    for input_frame in 0..input_frames {
        for tap in 0..ir_frames {
            let output_frame = input_frame + tap;
            for channel in 0..channels {
                output[output_frame * channels + channel] +=
                    input[input_frame * channels + channel] * ir[tap * channels + channel];
            }
        }
    }
    output
}

fn deterministic_convolver_input(frames: usize, channels: usize) -> Vec<f64> {
    (0..frames * channels)
        .map(|sample| ((sample * 7 + 3) % 19) as f64 * 0.03125 - 0.28125)
        .collect()
}

fn deterministic_convolver_ir(frames: usize, channels: usize) -> Vec<f64> {
    let mut ir = vec![0.0; frames * channels];
    for frame in 0..frames {
        for channel in 0..channels {
            let value = if frame == 0 {
                0.75 - channel as f64 * 0.125
            } else {
                let sign = if (frame + channel) % 2 == 0 {
                    1.0
                } else {
                    -1.0
                };
                sign * (0.2 + channel as f64 * 0.025) / (frame + 1) as f64
            };
            ir[frame * channels + channel] = value;
        }
    }
    ir
}

fn render_convolver_with_patterns(
    proc: &mut ConvolverProcessor,
    input: &[f64],
    channels: usize,
    process_chunks: &[usize],
    finish_chunks: &[usize],
    expected_ir_frames: usize,
) -> Vec<f64> {
    assert!(!process_chunks.is_empty());
    assert!(!finish_chunks.is_empty());
    assert!(process_chunks.iter().all(|frames| *frames > 0));
    assert!(finish_chunks.iter().all(|frames| *frames > 0));
    assert_eq!(proc.latency(), FrameDuration::ZERO);

    let input_frames = input.len() / channels;
    let mut output = Vec::with_capacity((input_frames + expected_ir_frames - 1) * channels);
    let mut cursor = 0;
    let mut chunk_index = 0;
    while cursor < input_frames {
        let frames = process_chunks[chunk_index % process_chunks.len()].min(input_frames - cursor);
        let sample_start = cursor * channels;
        let sample_end = (cursor + frames) * channels;
        let mut block = input[sample_start..sample_end].to_vec();
        let progress = super::super::traits::process_checked(
            proc,
            ProcessBuffers::in_place(AudioBlockMut::new(&mut block, channels).unwrap()),
        )
        .unwrap();
        assert_eq!(progress.consumed_frames(), frames);
        assert_eq!(progress.produced_frames(), frames);
        assert_eq!(progress.state(), ProcessState::NeedInput);
        output.extend_from_slice(&block);
        cursor += frames;
        chunk_index += 1;
    }

    assert_eq!(
        proc.tail(),
        TailSpec::finite(expected_ir_frames - 1, 48_000).unwrap()
    );

    let mut finish_index = 0;
    let final_produced = loop {
        let capacity_frames = finish_chunks[finish_index % finish_chunks.len()];
        let mut scratch = vec![0.0; capacity_frames * channels];
        let progress = super::super::traits::finish_checked(
            proc,
            AudioBlockMut::new(&mut scratch, channels).unwrap(),
        )
        .unwrap();
        output.extend_from_slice(&scratch[..progress.produced_frames() * channels]);
        if progress.state() == ProcessState::Finished {
            break progress.produced_frames();
        }
        assert_eq!(progress.state(), ProcessState::NeedOutput);
        assert_eq!(progress.produced_frames(), capacity_frames);
        finish_index += 1;
    };

    if expected_ir_frames > 1 {
        assert!(final_produced > 0);
    }
    let mut terminal_scratch = vec![0.0; finish_chunks[0] * channels];
    assert_eq!(
        super::super::traits::finish_checked(
            proc,
            AudioBlockMut::new(&mut terminal_scratch, channels).unwrap(),
        )
        .unwrap(),
        ProcessProgress::finished(0)
    );
    output
}

fn assert_convolver_matches_direct_oracle(input_frames: usize, ir_frames: usize, channels: usize) {
    let input = deterministic_convolver_input(input_frames, channels);
    let ir = deterministic_convolver_ir(ir_frames, channels);
    let expected = direct_interleaved_convolution(&input, &ir, channels);

    for (process_chunks, finish_chunks) in [
        (vec![input_frames], vec![ir_frames.max(1)]),
        (vec![1, 4, 2, 7, 3], vec![1, 5, 17, 257]),
    ] {
        let control = ConvolverControl::new(true);
        control
            .publish_at_rate(valid_convolver(&ir, channels), 48_000)
            .unwrap();
        let mut proc = ConvolverProcessor::new(control).unwrap();
        proc.set_sample_rate(48_000).unwrap();
        let actual = render_convolver_with_patterns(
            &mut proc,
            &input,
            channels,
            &process_chunks,
            &finish_chunks,
            ir_frames,
        );

        assert_eq!(actual.len(), expected.len());
        for (sample, (actual, expected)) in actual.iter().zip(&expected).enumerate() {
            assert!(
                (actual - expected).abs() <= 1.0e-8,
                "sample {sample} differs: actual={actual:?} expected={expected:?}"
            );
        }
    }
}

#[test]
fn convolver_process_and_finish_match_independent_direct_oracle() {
    let long_ir_frames = super::super::convolver::PARTITIONED_CONVOLUTION_IR_THRESHOLD + 1;
    assert_convolver_matches_direct_oracle(23, 1, 1);
    assert_convolver_matches_direct_oracle(29, 9, 2);
    assert_convolver_matches_direct_oracle(31, long_ir_frames, 1);
    assert_convolver_matches_direct_oracle(27, long_ir_frames, 2);
}

#[test]
fn convolver_reset_isolates_prior_process_and_partial_finish_history() {
    const CHANNELS: usize = 2;
    let ir = deterministic_convolver_ir(11, CHANNELS);
    let control = ConvolverControl::new(true);
    let generation = control
        .publish_at_rate(valid_convolver(&ir, CHANNELS), 48_000)
        .unwrap();
    let mut proc = ConvolverProcessor::new(control.clone()).unwrap();
    proc.set_sample_rate(48_000).unwrap();

    let mut prior = deterministic_convolver_input(17, CHANNELS);
    let _ = super::super::traits::process_checked(
        &mut proc,
        ProcessBuffers::in_place(AudioBlockMut::new(&mut prior, CHANNELS).unwrap()),
    )
    .unwrap();
    let mut partial_tail = [0.0; 3 * CHANNELS];
    let partial = super::super::traits::finish_checked(
        &mut proc,
        AudioBlockMut::new(&mut partial_tail, CHANNELS).unwrap(),
    )
    .unwrap();
    assert_eq!(partial.state(), ProcessState::NeedOutput);

    proc.reset().unwrap();
    assert_eq!(control.status().latest_adopted_generation, generation);
    let input = deterministic_convolver_input(19, CHANNELS);
    let actual =
        render_convolver_with_patterns(&mut proc, &input, CHANNELS, &[2, 5, 1, 7], &[3, 4], 11);
    let expected = direct_interleaved_convolution(&input, &ir, CHANNELS);

    for (sample, (actual, expected)) in actual.iter().zip(&expected).enumerate() {
        assert!(
            (actual - expected).abs() <= 1.0e-10,
            "sample {sample} leaked prior stream state: actual={actual:?} expected={expected:?}"
        );
    }
}

#[test]
fn convolver_sample_rate_change_waits_for_a_matching_kernel() {
    let control = ConvolverControl::new(true);
    let generation = control
        .publish_at_rate(valid_convolver(&[1.0, 0.5, 0.25], 1), 48_000)
        .unwrap();
    let mut proc = ConvolverProcessor::new(control.clone()).unwrap();
    proc.set_sample_rate(48_000).unwrap();
    let mut input = [1.0];
    let _ = proc.process(&mut input, 1);

    assert_eq!(proc.latency(), FrameDuration::ZERO);
    assert_eq!(proc.tail(), TailSpec::finite(2, 48_000).unwrap());
    proc.set_sample_rate(96_000).unwrap();
    let mut dry = [0.25, -0.5];
    assert!(proc.process(&mut dry, 1).is_bypassed());
    assert_eq!(dry, [0.25, -0.5]);
    assert_eq!(proc.tail(), TailSpec::None);
    assert_eq!(control.status().latest_adopted_generation, generation);
    assert_eq!(control.status().waiting_for_sample_rate_hz, Some(96_000));

    let replacement = control
        .publish_at_rate(valid_convolver(&[0.5], 1), 96_000)
        .unwrap();
    let mut activation = vec![1.0; 480];
    assert!(!proc.process(&mut activation, 1).is_bypassed());
    assert_eq!(control.status().latest_adopted_generation, replacement);
    assert_eq!(control.status().waiting_for_sample_rate_hz, None);

    control.set_enabled(false);
    assert_eq!(proc.tail(), TailSpec::None);
    assert_eq!(
        ConvolverProcessor::new(ConvolverControl::new(true))
            .unwrap()
            .tail(),
        TailSpec::None
    );
}

#[test]
fn convolver_finish_preserves_last_frame_impulse_tail() {
    let control = ConvolverControl::new(true);
    control
        .publish_at_rate(valid_convolver(&[1.0, 0.5, 0.25], 1), 48_000)
        .unwrap();
    let mut proc = ConvolverProcessor::new(control).unwrap();
    proc.set_sample_rate(48_000).unwrap();

    let mut input = vec![0.0, 0.0, 0.0, 1.0];
    let _ = proc.process(&mut input, 1);
    assert!((input[3] - 1.0).abs() <= 1.0e-12);
    assert_eq!(proc.tail(), TailSpec::finite(2, 48_000).unwrap());

    let mut scratch = [0.0; 1];
    let first = super::super::traits::finish_checked(
        &mut proc,
        AudioBlockMut::new(&mut scratch, 1).unwrap(),
    )
    .unwrap();
    assert_eq!(first.state(), ProcessState::NeedOutput);
    assert!((scratch[0] - 0.5).abs() <= 1.0e-12);

    let second = super::super::traits::finish_checked(
        &mut proc,
        AudioBlockMut::new(&mut scratch, 1).unwrap(),
    )
    .unwrap();
    assert_eq!(second.state(), ProcessState::Finished);
    assert!((scratch[0] - 0.25).abs() <= 1.0e-12);
}

#[test]
fn convolver_terminal_finish_can_retire_to_control_quiescence() {
    let control = ConvolverControl::new(true);
    control
        .publish_at_rate(valid_convolver(&[1.0, 0.5], 1), 44_100)
        .unwrap();
    let mut proc = ConvolverProcessor::new(control.clone()).unwrap();
    let mut input = [1.0];
    let _ = proc.process(&mut input, 1);
    let mut scratch = [0.0];
    assert_eq!(
        super::super::traits::finish_checked(
            &mut proc,
            AudioBlockMut::new(&mut scratch, 1).unwrap(),
        )
        .unwrap()
        .state(),
        ProcessState::Finished
    );

    control
        .publish_at_rate(valid_convolver(&[0.25], 1), 44_100)
        .unwrap();
    control.set_enabled(false);
    for _ in 0..2 {
        assert_eq!(
            super::super::traits::finish_checked(
                &mut proc,
                AudioBlockMut::new(&mut scratch, 1).unwrap(),
            )
            .unwrap(),
            ProcessProgress::finished(0)
        );
    }
    assert!(control.status().backpressured);
    assert_eq!(control.status().pending_reclamations, 2);

    assert!(control.reclaim_retired());
    assert_eq!(
        super::super::traits::finish_checked(
            &mut proc,
            AudioBlockMut::new(&mut scratch, 1).unwrap(),
        )
        .unwrap(),
        ProcessProgress::finished(0)
    );
    assert!(control.reclaim_retired());
    assert!(control.is_quiescent());
}

#[test]
fn finite_finish_paths_are_allocation_free_after_processing() {
    let limiter_params = Arc::new(AtomicPeakLimiterParams::new());
    let mut limiter = PeakLimiterProcessor::new(1, 48_000, limiter_params).unwrap();
    let mut limiter_input = vec![0.25; 64];
    let _ = limiter.process(&mut limiter_input, 1);
    let mut limiter_output = vec![0.0; limiter.limiter.delay_frames()];

    let control = ConvolverControl::new(true);
    control
        .publish_at_rate(valid_convolver(&[1.0, 0.5, 0.25], 1), 48_000)
        .unwrap();
    let mut convolver = ConvolverProcessor::new(control).unwrap();
    let mut convolver_input = [1.0, 0.0];
    let _ = convolver.process(&mut convolver_input, 1);
    let mut convolver_output = [0.0; 2];

    assert_no_alloc::assert_no_alloc(|| {
        let limiter_progress = super::super::traits::finish_checked(
            &mut limiter,
            AudioBlockMut::new(&mut limiter_output, 1).unwrap(),
        )
        .unwrap();
        assert_eq!(limiter_progress.state(), ProcessState::Finished);

        let convolver_progress = super::super::traits::finish_checked(
            &mut convolver,
            AudioBlockMut::new(&mut convolver_output, 1).unwrap(),
        )
        .unwrap();
        assert_eq!(convolver_progress.state(), ProcessState::Finished);
    });
}
