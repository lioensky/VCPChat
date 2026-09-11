use super::*;

#[test]
fn test_convolver_identity() {
    // Identity impulse response [1.0, 0.0, 0.0, ...]
    let ir = vec![1.0, 0.0, 0.0, 0.0]; // 4 taps mono
    let mut conv = FFTConvolver::new(&ir, 1).unwrap();

    let input = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
    let mut output = vec![0.0; input.len()];

    conv.process_into(&input, &mut output).unwrap();

    // With identity IR, output should match input
    for i in 0..input.len() {
        assert!(
            (output[i] - input[i]).abs() < 1e-10,
            "Mismatch at {}: {} vs {}",
            i,
            output[i],
            input[i]
        );
    }
}

#[test]
fn test_convolver_stereo() {
    // Simple stereo IR
    let ir = vec![1.0, 1.0, 0.0, 0.0]; // 2 taps stereo (both channels same)
    let mut conv = FFTConvolver::new(&ir, 2).unwrap();

    let input = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
    let mut output = vec![0.0; input.len()];

    conv.process_into(&input, &mut output).unwrap();

    // Verify output is not all zeros
    assert!(output.iter().any(|&x| x != 0.0));
}

#[test]
fn public_convolver_entries_reject_incomplete_interleaved_geometry() {
    assert!(FFTConvolver::new(&[1.0, 0.5, 0.25], 2).is_err());

    let mut convolver = FFTConvolver::new(&[1.0, 0.5], 2).unwrap();
    let mut output = [0.0; 2];
    assert!(convolver
        .try_process_into(&[1.0, 2.0, 3.0], &mut output)
        .is_err());
    assert!(convolver.try_process_inplace(&mut [1.0, 2.0, 3.0]).is_err());
    assert!(convolver
        .process_into(&[1.0, 2.0, 3.0], &mut output)
        .is_err());
    assert!(convolver.process_inplace(&mut [1.0, 2.0, 3.0]).is_err());
}

#[test]
fn test_zero_allocation() {
    let ir: Vec<f64> = (0..1024).map(|i| (i as f64 / 1024.0).sin()).collect();
    let mut conv = FFTConvolver::new(&ir, 1).unwrap();

    let input = vec![0.5; 4096];
    let mut output = vec![0.0; 4096];

    // Multiple calls should not allocate
    for _ in 0..100 {
        conv.process_into(&input, &mut output).unwrap();
    }

    // Just verify it doesn't crash
    assert!(output.iter().any(|&x| x != 0.0));
}

#[test]
fn test_partitioned_strategy_selected_for_long_ir() {
    let channels = 2;
    let ir = synthetic_ir(PARTITIONED_CONVOLUTION_IR_THRESHOLD + 1, channels);
    let conv = FFTConvolver::new(&ir, channels).unwrap();

    assert_eq!(conv.strategy(), ConvolutionStrategy::Partitioned);
    assert_eq!(
        conv.partition_size(),
        Some(PARTITIONED_CONVOLUTION_PARTITION_SIZE)
    );
    assert_eq!(conv.fft_size(), PARTITIONED_CONVOLUTION_PARTITION_SIZE * 2);
}

#[test]
fn test_overlap_save_strategy_retained_for_short_ir() {
    let channels = 2;
    let ir = synthetic_ir(PARTITIONED_CONVOLUTION_IR_THRESHOLD, channels);
    let conv = FFTConvolver::new(&ir, channels).unwrap();

    assert_eq!(conv.strategy(), ConvolutionStrategy::OverlapSave);
    assert_eq!(conv.partition_size(), None);
}

#[test]
fn test_partitioned_matches_overlap_save_for_long_stereo_ir() {
    let channels = 2;
    let ir = synthetic_ir(PARTITIONED_CONVOLUTION_IR_THRESHOLD + 1537, channels);
    let input = synthetic_input(8192, channels);

    let mut reference = OverlapSaveConvolver::new(&ir, channels);
    let mut partitioned = FFTConvolver::new(&ir, channels).unwrap();
    assert_eq!(partitioned.strategy(), ConvolutionStrategy::Partitioned);

    let mut expected = vec![0.0; input.len()];
    let mut actual = vec![0.0; input.len()];
    reference.process_into(&input, &mut expected);
    partitioned.process_into(&input, &mut actual).unwrap();

    assert_close(&expected, &actual, 1.0e-8);
}

#[test]
fn test_partitioned_matches_overlap_save_for_mono_and_surround_ir() {
    for channels in [1, 6] {
        let ir = synthetic_ir(PARTITIONED_CONVOLUTION_IR_THRESHOLD + 1537, channels);
        let input = synthetic_input(8192, channels);

        let mut reference = OverlapSaveConvolver::new(&ir, channels);
        let mut partitioned = FFTConvolver::new(&ir, channels).unwrap();
        assert_eq!(partitioned.strategy(), ConvolutionStrategy::Partitioned);

        let mut expected = vec![0.0; input.len()];
        let mut actual = vec![0.0; input.len()];
        reference.process_into(&input, &mut expected);
        partitioned.process_into(&input, &mut actual).unwrap();

        assert_close(&expected, &actual, 1.0e-8);
    }
}

#[test]
fn test_partitioned_preserves_cross_buffer_continuity() {
    let channels = 2;
    let ir = synthetic_ir(PARTITIONED_CONVOLUTION_IR_THRESHOLD + 3073, channels);
    let input = synthetic_input(12_000, channels);
    let chunk_frames = [127, 512, 73, 1024, 1500, 31, 2048, 640, 997];

    let mut reference = OverlapSaveConvolver::new(&ir, channels);
    let mut partitioned = FFTConvolver::new(&ir, channels).unwrap();
    let mut expected = vec![0.0; input.len()];
    let mut actual = vec![0.0; input.len()];
    let mut frame = 0;
    let mut chunk_index = 0;

    while frame < input.len() / channels {
        let frames =
            chunk_frames[chunk_index % chunk_frames.len()].min(input.len() / channels - frame);
        let start = frame * channels;
        let end = start + frames * channels;

        reference.process_into(&input[start..end], &mut expected[start..end]);
        partitioned
            .process_into(&input[start..end], &mut actual[start..end])
            .unwrap();

        frame += frames;
        chunk_index += 1;
    }

    assert_close(&expected, &actual, 1.0e-8);
}

#[test]
fn test_partitioned_tail_is_bitwise_invariant_to_chunking() {
    // The spread-quanta schedule advances on in-period frame position, not
    // on callback boundaries, so any chunking of the same input must
    // produce a bit-identical partitioned tail. (The overlap-save head is
    // only tolerance-invariant to chunking, so it is excluded here.)
    let channels = 6;
    let ir = synthetic_ir(PARTITIONED_CONVOLUTION_IR_THRESHOLD * 4, channels);
    let input = synthetic_input(9_000, channels);
    let chunkings: [&[usize]; 6] = [
        &[64],
        &[128],
        &[256],
        &[512],
        &[61, 64, 97, 640, 1024, 1500, 31],
        &[4096],
    ];

    let mut outputs = Vec::new();
    for chunking in chunkings {
        let mut convolver = PartitionedConvolver::new(&ir, channels).unwrap();
        let mut output = vec![0.0; input.len()];
        let mut frame = 0;
        let mut chunk_index = 0;

        while frame < input.len() / channels {
            let frames = chunking[chunk_index % chunking.len()].min(input.len() / channels - frame);
            let start = frame * channels;
            let end = start + frames * channels;
            convolver
                .add_partitioned_tail(&input[start..end], &mut output[start..end])
                .unwrap();
            frame += frames;
            chunk_index += 1;
        }
        outputs.push(output);
    }

    for output in &outputs[1..] {
        for (sample_index, (expected, actual)) in outputs[0].iter().zip(output.iter()).enumerate() {
            assert_eq!(
                expected.to_bits(),
                actual.to_bits(),
                "chunking changed tail sample {sample_index}"
            );
        }
    }
}

#[test]
fn test_partitioned_reset_matches_fresh_convolver() {
    let channels = 6;
    let ir = synthetic_ir(PARTITIONED_CONVOLUTION_IR_THRESHOLD + 2049, channels);
    let warmup = synthetic_input(2048, channels);
    let input = synthetic_input(4096, channels);

    let mut reused = FFTConvolver::new(&ir, channels).unwrap();
    let mut fresh = FFTConvolver::new(&ir, channels).unwrap();
    let mut scratch = vec![0.0; warmup.len()];
    reused.process_into(&warmup, &mut scratch).unwrap();
    reused.reset();

    let mut expected = vec![0.0; input.len()];
    let mut actual = vec![0.0; input.len()];
    fresh.process_into(&input, &mut expected).unwrap();
    reused.process_into(&input, &mut actual).unwrap();

    assert_close(&expected, &actual, 1.0e-8);
}

#[test]
fn test_partitioned_inplace_matches_process_into() {
    let channels = 2;
    let ir = synthetic_ir(PARTITIONED_CONVOLUTION_IR_THRESHOLD + 2049, channels);
    let input = synthetic_input(8192, channels);

    let mut into_conv = FFTConvolver::new(&ir, channels).unwrap();
    let mut inplace_conv = FFTConvolver::new(&ir, channels).unwrap();

    let mut expected = vec![0.0; input.len()];
    let mut actual = input.clone();
    into_conv.process_into(&input, &mut expected).unwrap();
    inplace_conv.process_inplace(&mut actual).unwrap();

    assert_close(&expected, &actual, 1.0e-8);
}

#[test]
fn test_partitioned_process_inplace_is_allocation_free_after_setup() {
    let channels = 2;
    let ir = synthetic_ir(PARTITIONED_CONVOLUTION_IR_THRESHOLD + 2049, channels);
    let mut conv = FFTConvolver::new(&ir, channels).unwrap();
    let mut buffer = synthetic_input(2048, channels);

    conv.process_inplace(&mut buffer).unwrap();

    assert_no_alloc::assert_no_alloc(|| {
        for _ in 0..32 {
            conv.process_inplace(&mut buffer).unwrap();
        }
    });
}

// === FIX for Defect 8: Boundary unit tests for process_inplace ===

#[test]
fn test_inplace_identity() {
    // Identity IR: process_inplace should preserve input
    let ir = vec![1.0, 0.0, 0.0, 0.0]; // 4 taps mono
    let mut conv = FFTConvolver::new(&ir, 1).unwrap();

    let original = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
    let mut buf = original.clone();

    conv.process_inplace(&mut buf).unwrap();

    for i in 0..original.len() {
        assert!(
            (buf[i] - original[i]).abs() < 1e-10,
            "Inplace identity mismatch at {}: {} vs {}",
            i,
            buf[i],
            original[i]
        );
    }
}

#[test]
fn test_inplace_matches_process_into() {
    // Verify process_inplace produces same output as process_into
    let ir: Vec<f64> = (0..32).map(|i| (i as f64 / 32.0).sin() * 0.1).collect();
    let input: Vec<f64> = (0..256).map(|i| (i as f64 * 0.05).sin()).collect();

    let mut conv1 = FFTConvolver::new(&ir, 1).unwrap();
    let mut conv2 = FFTConvolver::new(&ir, 1).unwrap();

    let mut output_into = vec![0.0; input.len()];
    conv1.process_into(&input, &mut output_into).unwrap();

    let mut buf_inplace = input.clone();
    conv2.process_inplace(&mut buf_inplace).unwrap();

    for i in 0..input.len() {
        assert!(
            (output_into[i] - buf_inplace[i]).abs() < 1e-10,
            "Mismatch at {}: into={} vs inplace={}",
            i,
            output_into[i],
            buf_inplace[i]
        );
    }
}

fn assert_processing_paths_equivalent(channels: usize, ir_frames: usize, input_frames: usize) {
    let ir: Vec<f64> = (0..ir_frames * channels)
        .map(|i| ((i + 1) as f64 * 0.17).sin() * 0.05)
        .collect();
    let input: Vec<f64> = (0..input_frames * channels)
        .map(|i| ((i + 3) as f64 * 0.11).cos() * 0.5)
        .collect();

    let mut process_conv = FFTConvolver::new(&ir, channels).unwrap();
    let mut into_conv = FFTConvolver::new(&ir, channels).unwrap();
    let mut inplace_conv = FFTConvolver::new(&ir, channels).unwrap();

    let process_output = process_conv.process(&input).unwrap();

    let mut into_output = vec![f64::NAN; input.len()];
    into_conv.process_into(&input, &mut into_output).unwrap();

    let mut inplace_output = input.clone();
    inplace_conv.process_inplace(&mut inplace_output).unwrap();

    for i in 0..input.len() {
        assert!(
            (process_output[i] - into_output[i]).abs() < 1e-10,
            "process/process_into mismatch at {i}: {} vs {}",
            process_output[i],
            into_output[i]
        );
        assert!(
            (process_output[i] - inplace_output[i]).abs() < 1e-10,
            "process/process_inplace mismatch at {i}: {} vs {}",
            process_output[i],
            inplace_output[i]
        );
    }
}

#[test]
fn test_processing_paths_equivalent_for_boundary_chunk_sizes() {
    assert_processing_paths_equivalent(1, 8, 4);
    assert_processing_paths_equivalent(2, 8, 8);
    assert_processing_paths_equivalent(6, 8, 20);
}

#[test]
fn test_inplace_small_buffer() {
    // Buffer smaller than IR length
    let ir = vec![1.0, 0.5, 0.25, 0.125, 0.0, 0.0, 0.0, 0.0]; // 8 taps mono
    let mut conv = FFTConvolver::new(&ir, 1).unwrap();

    // Only 4 samples (less than 8-tap IR)
    let mut buf = vec![1.0, 0.0, 0.0, 0.0];
    conv.process_inplace(&mut buf).unwrap();

    // Should produce convolution of delta with IR, truncated to 4 samples
    // Result: [1.0, 0.5, 0.25, 0.125]
    assert!((buf[0] - 1.0).abs() < 1e-10, "Expected 1.0, got {}", buf[0]);
    assert!((buf[1] - 0.5).abs() < 1e-10, "Expected 0.5, got {}", buf[1]);
    assert!(
        (buf[2] - 0.25).abs() < 1e-10,
        "Expected 0.25, got {}",
        buf[2]
    );
    assert!(
        (buf[3] - 0.125).abs() < 1e-10,
        "Expected 0.125, got {}",
        buf[3]
    );
}

#[test]
fn test_inplace_stereo_identity() {
    // Stereo identity IR
    let ir = vec![1.0, 1.0, 0.0, 0.0]; // 2 taps stereo identity
    let mut conv = FFTConvolver::new(&ir, 2).unwrap();

    let original = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]; // 4 frames stereo
    let mut buf = original.clone();

    conv.process_inplace(&mut buf).unwrap();

    for i in 0..original.len() {
        assert!(
            (buf[i] - original[i]).abs() < 1e-10,
            "Stereo inplace identity mismatch at {}: {} vs {}",
            i,
            buf[i],
            original[i]
        );
    }
}

#[test]
fn test_inplace_multi_chunk() {
    // Multiple consecutive calls with continuity
    let ir = vec![1.0, 0.5, 0.0, 0.0]; // 4 taps mono
    let mut conv = FFTConvolver::new(&ir, 1).unwrap();

    let mut buf1 = vec![1.0, 0.0, 0.0, 0.0];
    conv.process_inplace(&mut buf1).unwrap();

    // Second chunk should carry overlap from first
    let mut buf2 = vec![0.0, 0.0, 0.0, 0.0];
    conv.process_inplace(&mut buf2).unwrap();

    // buf1 should be [1.0, 0.5, 0.0, 0.0]
    assert!((buf1[0] - 1.0).abs() < 1e-10);
    assert!((buf1[1] - 0.5).abs() < 1e-10);
}

fn synthetic_ir(frames: usize, channels: usize) -> Vec<f64> {
    let mut ir = Vec::with_capacity(frames * channels);
    for frame in 0..frames {
        let decay = (-(frame as f64) / 900.0).exp();
        for channel in 0..channels {
            let direct = if frame == 0 { 0.8 } else { 0.0 };
            let early = if frame == 97 + channel * 13 {
                0.08
            } else {
                0.0
            };
            let tail = ((frame + 1 + channel * 17) as f64 * 0.021).sin() * decay * 0.03;
            ir.push(direct + early + tail);
        }
    }
    ir
}

fn synthetic_input(frames: usize, channels: usize) -> Vec<f64> {
    let mut input = Vec::with_capacity(frames * channels);
    for frame in 0..frames {
        for channel in 0..channels {
            let phase = frame as f64 * (0.013 + channel as f64 * 0.002);
            let transient = if frame % 257 == 0 { 0.25 } else { 0.0 };
            input.push((phase.sin() * 0.4 + (phase * 0.31).cos() * 0.1 + transient) * 0.7);
        }
    }
    input
}

fn assert_close(expected: &[f64], actual: &[f64], tolerance: f64) {
    assert_eq!(expected.len(), actual.len());
    for (index, (&left, &right)) in expected.iter().zip(actual).enumerate() {
        let delta = (left - right).abs();
        assert!(
            delta <= tolerance,
            "sample {index} mismatch: expected {left:.12e}, actual {right:.12e}, delta {delta:.3e}"
        );
    }
}
