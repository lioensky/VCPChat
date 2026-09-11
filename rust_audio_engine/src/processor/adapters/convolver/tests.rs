use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Barrier};

use super::*;
use crate::processor::convolver::FFTConvolver;
use crate::processor::traits::{finish_checked, process_checked, AudioBlockMut, ProcessBuffers};

fn valid_convolver(ir: &[f64], channels: usize) -> FFTConvolver {
    FFTConvolver::new(ir, channels).unwrap()
}

fn process_mono(
    processor: &mut ConvolverProcessor,
    samples: &mut [f64],
) -> Result<ProcessProgress, ProcessError> {
    process_checked(
        processor,
        ProcessBuffers::in_place(AudioBlockMut::new(samples, 1)?),
    )
}

/// Assert that `actual` matches `expected` with a tolerance that absorbs
/// FFT/layout rounding (observed on CI Ubuntu x86_64: 0.25 tail tap computed
/// as 0.24999999999999997).
fn assert_samples_close(actual: &[f64], expected: &[f64]) {
    assert_eq!(actual.len(), expected.len(), "sample counts differ");
    for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
        let tolerance = 1e-12_f64.max(expected.abs() * 1e-12);
        assert!(
            (actual - expected).abs() <= tolerance,
            "sample {index}: {actual} differs from expected {expected} beyond {tolerance}",
        );
    }
}

#[test]
fn consumer_lease_rejects_second_direct_consumer_and_releases_on_drop() {
    let control = ConvolverControl::new(false);
    let first = ConvolverProcessor::new(control.clone()).unwrap();

    assert!(matches!(
        ConvolverProcessor::new(control.clone()),
        Err(ProcessError::ConsumerAlreadyActive {
            processor: "Convolver"
        })
    ));

    drop(first);
    assert!(ConvolverProcessor::new(control).is_ok());
}

#[test]
fn first_process_on_a_new_audio_thread_is_allocation_free() {
    let control = ConvolverControl::new(true);
    control
        .publish_at_rate(valid_convolver(&[0.5, 0.25], 1), 44_100)
        .unwrap();
    let processor = ConvolverProcessor::new(control.clone()).unwrap();

    let processor = std::thread::spawn(move || {
        let mut processor = processor;
        let mut samples = [1.0; 128];
        assert_no_alloc::assert_no_alloc(|| {
            let _ = process_mono(&mut processor, &mut samples).unwrap();
        });
        assert_eq!(samples[0], 0.5);
        processor
    })
    .join()
    .unwrap();

    drop(processor);
}

#[test]
fn kernel_published_after_dry_wait_fades_in_from_the_dry_path() {
    let control = ConvolverControl::new(true);
    let mut processor = ConvolverProcessor::new(control.clone()).unwrap();

    let mut dry_wait = [1.0; 16];
    let progress = process_mono(&mut processor, &mut dry_wait).unwrap();
    assert!(progress.is_bypassed());
    assert!(dry_wait.iter().all(|sample| *sample == 1.0));

    control
        .publish_at_rate(valid_convolver(&[0.0], 1), 44_100)
        .unwrap();
    let mut activation = vec![1.0; processor.activation_frames()];
    let progress = process_mono(&mut processor, &mut activation).unwrap();
    assert!(!progress.is_bypassed());
    assert!((activation[0] - 1.0).abs() <= 1.0e-12);
    assert!(activation
        .last()
        .is_some_and(|sample| sample.abs() <= 1.0e-12));
    assert!(!processor.transition_active());
}

#[test]
fn disabled_convolver_still_reports_owned_kernel_tail_until_finish() {
    let control = ConvolverControl::new(true);
    control
        .publish_at_rate(valid_convolver(&[1.0, 0.5, 0.25], 1), 44_100)
        .unwrap();
    let mut processor = ConvolverProcessor::new(control.clone()).unwrap();
    let mut input = [1.0];
    let _ = process_mono(&mut processor, &mut input).unwrap();

    control.set_enabled(false);
    assert_eq!(processor.tail(), TailSpec::finite(2, 44_100).unwrap());
}

#[test]
fn finish_continues_an_active_kernel_fade_without_a_full_wet_jump() {
    let control = ConvolverControl::new(true);
    let mut processor = ConvolverProcessor::new(control.clone()).unwrap();
    let mut dry_wait = [1.0; 8];
    let _ = process_mono(&mut processor, &mut dry_wait).unwrap();

    control
        .publish_at_rate(valid_convolver(&[1.0, 0.5, 0.25], 1), 44_100)
        .unwrap();
    let mut activation = [1.0];
    let _ = process_mono(&mut processor, &mut activation).unwrap();
    assert!(processor.transition_active());

    let mut tail = [0.0; 2];
    let progress =
        finish_checked(&mut processor, AudioBlockMut::new(&mut tail, 1).unwrap()).unwrap();
    assert_eq!(progress.produced_frames(), 2);
    assert!(tail[0] >= 0.0 && tail[0] < 0.5);
    assert!(tail[1] >= 0.0 && tail[1] < 0.25);
}

#[test]
fn enable_toggles_retarget_an_active_transition_from_its_current_wet_weight() {
    let control = ConvolverControl::new(true);
    let mut processor = ConvolverProcessor::new(control.clone()).unwrap();
    let mut dry_wait = [1.0; 8];
    let _ = process_mono(&mut processor, &mut dry_wait).unwrap();
    control
        .publish_at_rate(valid_convolver(&[0.0], 1), 44_100)
        .unwrap();

    let mut fade_in = vec![1.0; processor.activation_frames() / 2];
    let _ = process_mono(&mut processor, &mut fade_in).unwrap();
    let before_disable = *fade_in.last().unwrap();

    control.set_enabled(false);
    let mut reverse_to_dry = [1.0];
    let _ = process_mono(&mut processor, &mut reverse_to_dry).unwrap();
    assert!((reverse_to_dry[0] - before_disable).abs() < 0.02);

    let mut fade_out = [1.0; 50];
    let _ = process_mono(&mut processor, &mut fade_out).unwrap();
    let before_reenable = *fade_out.last().unwrap();

    control.set_enabled(true);
    let mut reverse_to_wet = [1.0];
    let _ = process_mono(&mut processor, &mut reverse_to_wet).unwrap();
    assert!((reverse_to_wet[0] - before_reenable).abs() < 0.02);
}

#[test]
fn partitioned_fade_reversal_and_finish_match_direct_convolution_oracle() {
    use crate::processor::convolver::PARTITIONED_CONVOLUTION_IR_THRESHOLD;

    fn transition_weight(start: f64, target: f64, cursor: usize, total: usize) -> f64 {
        if total <= 1 || cursor >= total {
            return target;
        }
        let t = cursor as f64 / (total - 1) as f64;
        let smooth = t * t * (3.0 - 2.0 * t);
        start + (target - start) * smooth
    }

    fn append_weights(
        output: &mut Vec<f64>,
        frames: usize,
        start: f64,
        target: f64,
        cursor: &mut usize,
        total: usize,
    ) {
        for _ in 0..frames {
            output.push(transition_weight(start, target, *cursor, total));
            *cursor = cursor.saturating_add(1);
        }
    }

    let ir_frames = PARTITIONED_CONVOLUTION_IR_THRESHOLD + 1;
    let mut ir = Vec::with_capacity(ir_frames);
    for tap in 0..ir_frames {
        let value = if tap == 0 {
            0.65
        } else {
            (tap as f64 * 0.071).cos() * (-(tap as f64) / 700.0).exp() * 0.002
        };
        ir.push(value);
    }
    let program_frames = 190;
    let program = (0..program_frames)
        .map(|frame| (frame as f64 * 0.113).sin() * 0.4 + (frame as f64 * 0.037).cos() * 0.1)
        .collect::<Vec<_>>();

    let mut wet = vec![0.0; program_frames + ir_frames - 1];
    for (input_frame, &sample) in program.iter().enumerate() {
        for (tap, &coefficient) in ir.iter().enumerate() {
            wet[input_frame + tap] += sample * coefficient;
        }
    }

    let control = ConvolverControl::new(true);
    let mut processor = ConvolverProcessor::new(control.clone()).unwrap();
    let mut dry_wait = [0.25; 7];
    let progress = process_mono(&mut processor, &mut dry_wait).unwrap();
    assert!(progress.is_bypassed());
    assert_eq!(dry_wait, [0.25; 7]);
    control
        .publish_at_rate(valid_convolver(&ir, 1), 44_100)
        .unwrap();
    let transition_frames = processor.activation_frames();

    let mut actual = program.clone();
    let _ = process_mono(&mut processor, &mut actual[..80]).unwrap();
    control.set_enabled(false);
    let _ = process_mono(&mut processor, &mut actual[80..130]).unwrap();
    control.set_enabled(true);
    let _ = process_mono(&mut processor, &mut actual[130..]).unwrap();

    let mut finish_chunk = 0usize;
    let finish_capacities = [1, 17, 257, 31];
    loop {
        let mut output = vec![0.0; finish_capacities[finish_chunk % finish_capacities.len()]];
        let progress =
            finish_checked(&mut processor, AudioBlockMut::new(&mut output, 1).unwrap()).unwrap();
        actual.extend_from_slice(&output[..progress.produced_frames()]);
        finish_chunk += 1;
        if progress.state() == ProcessState::Finished {
            break;
        }
        assert_eq!(progress.state(), ProcessState::NeedOutput);
    }
    assert_eq!(actual.len(), wet.len());

    let mut weights = Vec::with_capacity(wet.len());
    let mut cursor = 0usize;
    append_weights(&mut weights, 80, 0.0, 1.0, &mut cursor, transition_frames);
    let fade_out_start = transition_weight(0.0, 1.0, cursor, transition_frames);
    cursor = 0;
    append_weights(
        &mut weights,
        50,
        fade_out_start,
        0.0,
        &mut cursor,
        transition_frames,
    );
    let second_fade_in_start = transition_weight(fade_out_start, 0.0, cursor, transition_frames);
    cursor = 0;
    append_weights(
        &mut weights,
        wet.len() - 130,
        second_fade_in_start,
        1.0,
        &mut cursor,
        transition_frames,
    );

    for index in 0..actual.len() {
        let dry = program.get(index).copied().unwrap_or(0.0);
        let expected = dry + (wet[index] - dry) * weights[index];
        assert!(
            (actual[index] - expected).abs() <= 1.0e-8,
            "sample={index}: actual={} expected={expected} wet={} dry={dry} weight={}",
            actual[index],
            wet[index],
            weights[index]
        );
    }

    let mut terminal = [9.0];
    assert_eq!(
        finish_checked(
            &mut processor,
            AudioBlockMut::new(&mut terminal, 1).unwrap(),
        )
        .unwrap(),
        ProcessProgress::finished(0)
    );
    assert_eq!(terminal, [9.0]);
}

#[test]
fn partitioned_adoption_process_and_finish_are_allocation_free_on_new_audio_thread() {
    use crate::processor::convolver::PARTITIONED_CONVOLUTION_IR_THRESHOLD;

    let ir_frames = PARTITIONED_CONVOLUTION_IR_THRESHOLD + 1;
    let mut ir = vec![0.0; ir_frames];
    ir[0] = 1.0;
    ir[ir_frames - 1] = 0.25;

    let control = ConvolverControl::new(true);
    control
        .publish_at_rate(valid_convolver(&ir, 1), 44_100)
        .unwrap();
    let processor = ConvolverProcessor::new(control.clone()).unwrap();

    let processor = std::thread::spawn(move || {
        let mut processor = processor;
        let mut input = [0.0; 128];
        input[0] = 1.0;
        let mut output = [0.0; 257];
        let mut produced_tail_frames = 0usize;

        assert_no_alloc::assert_no_alloc(|| {
            let progress = process_mono(&mut processor, &mut input).unwrap();
            assert_eq!(progress.state(), ProcessState::NeedInput);

            loop {
                let progress =
                    finish_checked(&mut processor, AudioBlockMut::new(&mut output, 1).unwrap())
                        .unwrap();
                produced_tail_frames += progress.produced_frames();
                if progress.state() == ProcessState::Finished {
                    break;
                }
                assert_eq!(progress.state(), ProcessState::NeedOutput);
            }

            output.fill(9.0);
            let terminal =
                finish_checked(&mut processor, AudioBlockMut::new(&mut output, 1).unwrap())
                    .unwrap();
            assert_eq!(terminal, ProcessProgress::finished(0));
            assert_eq!(output, [9.0; 257]);
        });

        assert_eq!(produced_tail_frames, ir_frames - 1);
        processor
    })
    .join()
    .unwrap();

    drop(processor);
    control.set_enabled(false);
    assert!(control.is_quiescent());
}

#[test]
fn disable_during_partial_finish_preserves_locked_tail() {
    let control = ConvolverControl::new(true);
    control
        .publish_at_rate(valid_convolver(&[1.0, 0.5, 0.25, 0.125], 1), 44_100)
        .unwrap();
    let mut processor = ConvolverProcessor::new(control.clone()).unwrap();
    let mut input = [1.0];
    let _ = process_mono(&mut processor, &mut input).unwrap();

    let mut output = [0.0];
    let first =
        finish_checked(&mut processor, AudioBlockMut::new(&mut output, 1).unwrap()).unwrap();
    assert_eq!(first.state(), ProcessState::NeedOutput);
    assert_samples_close(&output, &[0.5]);

    control.set_enabled(false);
    let second =
        finish_checked(&mut processor, AudioBlockMut::new(&mut output, 1).unwrap()).unwrap();
    assert_eq!(second.state(), ProcessState::NeedOutput);
    assert_samples_close(&output, &[0.25]);

    let third =
        finish_checked(&mut processor, AudioBlockMut::new(&mut output, 1).unwrap()).unwrap();
    assert_eq!(third.state(), ProcessState::Finished);
    assert_samples_close(&output, &[0.125]);

    assert_eq!(
        finish_checked(&mut processor, AudioBlockMut::new(&mut output, 1).unwrap(),).unwrap(),
        ProcessProgress::finished(0)
    );
    assert!(control.reclaim_retired());
    assert!(control.is_quiescent());
}

#[test]
fn disable_before_first_finish_preserves_current_kernel_tail() {
    let control = ConvolverControl::new(true);
    control
        .publish_at_rate(valid_convolver(&[1.0, 0.5, 0.25, 0.125], 1), 44_100)
        .unwrap();
    let mut processor = ConvolverProcessor::new(control.clone()).unwrap();
    let mut input = [1.0];
    let _ = process_mono(&mut processor, &mut input).unwrap();

    control.set_enabled(false);
    let mut output = [0.0; 3];
    let progress =
        finish_checked(&mut processor, AudioBlockMut::new(&mut output, 1).unwrap()).unwrap();

    assert_eq!(progress.state(), ProcessState::Finished);
    assert_eq!(progress.produced_frames(), 3);
    assert_samples_close(&output, &[0.5, 0.25, 0.125]);
    assert_eq!(
        finish_checked(
            &mut processor,
            AudioBlockMut::new(&mut output[..1], 1).unwrap(),
        )
        .unwrap(),
        ProcessProgress::finished(0)
    );
    assert!(control.reclaim_retired());
    assert!(control.is_quiescent());
}

#[test]
fn publication_during_idle_ack_cannot_commit_a_stale_generation() {
    let control = ConvolverControl::new(false);
    let audio_control = control.clone();
    let loaded = Arc::new(Barrier::new(2));
    let published = Arc::new(Barrier::new(2));
    let audio_loaded = Arc::clone(&loaded);
    let audio_published = Arc::clone(&published);

    let audio = std::thread::spawn(move || {
        audio_control.acknowledge_drained_with_test_hook(|| {
            audio_loaded.wait();
            audio_published.wait();
        });
    });

    loaded.wait();
    let generation = control
        .publish_at_rate(valid_convolver(&[1.0], 1), 44_100)
        .unwrap();
    published.wait();
    audio.join().unwrap();

    let status = control.status();
    assert_eq!(status.latest_published_generation, generation);
    assert_ne!(status.audio_drained_generation, generation);
    assert!(!control.is_quiescent());
}

#[test]
fn quiescence_rechecks_retirement_after_generation_acknowledgement() {
    let control = ConvolverControl::new(false);
    let generation = control
        .publish_at_rate(valid_convolver(&[0.5], 1), 44_100)
        .unwrap();
    let blocker_control = ConvolverControl::new(false);
    blocker_control
        .publish_at_rate(valid_convolver(&[1.0], 1), 44_100)
        .unwrap();
    let blocker = blocker_control.take_published().unwrap();
    assert!(control.try_retire(blocker).is_ok());

    let mut processor = ConvolverProcessor::new(control.clone()).unwrap();
    let mut samples = [0.0; 4];
    let _ = process_mono(&mut processor, &mut samples).unwrap();
    assert!(control.reclaim_retired());

    let quiescent = control.is_quiescent_with_test_hook(|| {
        let _ = process_mono(&mut processor, &mut samples).unwrap();
    });

    assert_eq!(
        control.status().audio_drained_generation,
        generation,
        "the audio side must acknowledge the drained publication"
    );
    assert!(
        !quiescent,
        "a retirement stored after the first slot check must block teardown"
    );
    assert!(control.reclaim_retired());
    assert!(control.is_quiescent());
}

#[test]
fn terminal_finish_and_retirement_are_allocation_free_on_new_audio_thread() {
    let control = ConvolverControl::new(true);
    control
        .publish_at_rate(valid_convolver(&[1.0, 0.5, 0.25], 1), 44_100)
        .unwrap();
    let mut processor = ConvolverProcessor::new(control.clone()).unwrap();
    let mut input = [1.0];
    let _ = process_mono(&mut processor, &mut input).unwrap();
    control.set_enabled(false);

    let processor = std::thread::spawn(move || {
        let mut processor = processor;
        let mut output = [0.0; 2];
        assert_no_alloc::assert_no_alloc(|| {
            let finished =
                finish_checked(&mut processor, AudioBlockMut::new(&mut output, 1).unwrap())
                    .unwrap();
            assert_eq!(finished.state(), ProcessState::Finished);
            let terminal =
                finish_checked(&mut processor, AudioBlockMut::new(&mut output, 1).unwrap())
                    .unwrap();
            assert_eq!(terminal, ProcessProgress::finished(0));
        });
        processor
    })
    .join()
    .unwrap();

    assert!(control.reclaim_retired());
    assert!(control.is_quiescent());
    drop(processor);
}

#[test]
fn concurrent_reclaim_and_audio_retirement_drop_every_kernel_off_audio() {
    const KERNELS: u64 = 64;

    let control = ConvolverControl::new(true);
    let audio_control = control.clone();
    let boundary = Arc::new(Barrier::new(2));
    let audio_boundary = Arc::clone(&boundary);
    let (command_tx, command_rx) = sync_channel::<bool>(0);
    let (ready_tx, ready_rx) = sync_channel(0);
    let (done_tx, done_rx) = sync_channel(0);
    let audio = std::thread::spawn(move || {
        ready_tx.send(std::thread::current().id()).unwrap();
        let mut processor = ConvolverProcessor::new(audio_control).unwrap();
        let mut samples = [1.0; 256];
        while command_rx.recv().unwrap() {
            audio_boundary.wait();
            let _ = process_mono(&mut processor, &mut samples).unwrap();
            done_tx.send(()).unwrap();
        }
        processor
    });

    let audio_thread_id = ready_rx.recv().unwrap();
    let dropped_on_audio = Arc::new(AtomicBool::new(false));
    let drop_count = Arc::new(AtomicU64::new(0));
    let make_probe = || control::ConvolverDropProbe {
        audio_thread_id,
        dropped_on_audio: Arc::clone(&dropped_on_audio),
        drop_count: Arc::clone(&drop_count),
    };
    let process_and_race_reclaim = || {
        command_tx.send(true).unwrap();
        boundary.wait();
        let _ = control.reclaim_retired();
        done_rx.recv().unwrap();
        let _ = control.reclaim_retired();
    };

    control.publish_with_drop_probe(valid_convolver(&[1.0], 1), 44_100, make_probe());
    process_and_race_reclaim();
    for generation in 1..KERNELS {
        let gain = 1.0 - generation as f64 / (KERNELS * 2) as f64;
        control.publish_with_drop_probe(valid_convolver(&[gain], 1), 44_100, make_probe());
        process_and_race_reclaim();
    }

    control.set_enabled(false);
    process_and_race_reclaim();
    assert!(control.is_quiescent());

    command_tx.send(false).unwrap();
    let processor = audio.join().unwrap();
    drop(processor);

    assert_eq!(drop_count.load(Ordering::Acquire), KERNELS);
    assert!(!dropped_on_audio.load(Ordering::Acquire));
}

#[test]
fn drained_generation_acknowledgement_handles_wrapping_publication() {
    let control = ConvolverControl::new(false);
    control.set_generation_state_for_test(u64::MAX, u64::MAX);
    let generation = control
        .publish_at_rate(valid_convolver(&[1.0], 1), 44_100)
        .unwrap();
    assert_eq!(generation, 0);

    let mut processor = ConvolverProcessor::new(control.clone()).unwrap();
    let mut samples = [0.0; 4];
    let _ = process_mono(&mut processor, &mut samples).unwrap();
    assert!(control.reclaim_retired());

    let status = control.status();
    assert_eq!(status.latest_published_generation, 0);
    assert_eq!(status.audio_drained_generation, 0);
    assert!(control.is_quiescent());
}
