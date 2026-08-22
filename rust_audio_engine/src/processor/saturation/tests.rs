use super::*;

#[derive(Clone, Copy)]
struct LegacyCircularFirHistory {
    samples: [f64; OVERSAMPLING_MAX_FILTER_TAPS],
    next_write: usize,
}

impl Default for LegacyCircularFirHistory {
    fn default() -> Self {
        Self {
            samples: [0.0; OVERSAMPLING_MAX_FILTER_TAPS],
            next_write: 0,
        }
    }
}

impl LegacyCircularFirHistory {
    fn reset(&mut self) {
        self.samples.fill(0.0);
        self.next_write = 0;
    }

    fn push(&mut self, sample: f64, len: usize) {
        self.samples[self.next_write] = sample;
        self.next_write += 1;
        if self.next_write == len {
            self.next_write = 0;
        }
    }

    fn evaluate<const TAPS: usize>(&self, coefficients: &[f64; TAPS]) -> f64 {
        let mut acc = 0.0;
        let mut history_index = if self.next_write == 0 {
            TAPS - 1
        } else {
            self.next_write - 1
        };
        for &coefficient in coefficients {
            acc += coefficient * self.samples[history_index];
            history_index = if history_index == 0 {
                TAPS - 1
            } else {
                history_index - 1
            };
        }
        acc
    }
}

#[test]
fn test_tube_saturation() {
    let mut sat = Saturation::with_type(SaturationType::Tube);
    sat.set_enabled(true);
    sat.set_mix(1.0); // 100% wet for testing

    // Test that loud signals are compressed
    let mut samples = vec![0.9, -0.9, 0.5, -0.5];
    samples.extend_from_slice(&[0.0; SATURATION_LATENCY_FRAMES]);
    sat.process_with_channels(&mut samples, 1);

    // tanh(0.9) ≈ 0.716
    assert!(samples[SATURATION_LATENCY_FRAMES].abs() < 0.9);
    assert!(samples[SATURATION_LATENCY_FRAMES + 1].abs() < 0.9);

    // Lower signals should pass through relatively unchanged
    // tanh(0.5) ≈ 0.462, which is close to 0.5
    assert!((samples[SATURATION_LATENCY_FRAMES + 2].abs() - 0.5).abs() < 0.1);
}

#[test]
fn test_disabled() {
    let mut sat = Saturation::new();
    sat.set_enabled(false);

    let mut samples = vec![0.9, -0.9, 0.5, -0.5];
    sat.process_with_channels(&mut samples, 1);

    // Should pass through unchanged when disabled
    assert!((samples[0] - 0.9).abs() < 1e-10);
    assert!((samples[1] - (-0.9)).abs() < 1e-10);
}

#[test]
fn test_cached_linear_gains_update_with_db_setters() {
    let mut sat = Saturation::new();

    sat.set_input_gain(6.0);
    sat.set_output_gain(-3.0);

    assert!((sat.input_gain_linear - db_to_linear(6.0)).abs() < 1e-12);
    assert!((sat.output_gain_linear - db_to_linear(-3.0)).abs() < 1e-12);
    assert_eq!(sat.input_gain_db, 6.0);
    assert_eq!(sat.output_gain_db, -3.0);
}

/// The standalone setters must honour the same published bounds as the atomic
/// publication path, so a direct core user cannot reach a gain the facade
/// refuses to publish.
#[test]
fn standalone_gain_setters_clamp_to_published_range() {
    let mut sat = Saturation::new();

    sat.set_input_gain(SATURATION_GAIN_DB_MAX + 12.0);
    sat.set_output_gain(SATURATION_GAIN_DB_MIN - 12.0);

    assert_eq!(sat.input_gain_db, SATURATION_GAIN_DB_MAX);
    assert_eq!(sat.output_gain_db, SATURATION_GAIN_DB_MIN);
    assert!((sat.input_gain_linear - db_to_linear(SATURATION_GAIN_DB_MAX)).abs() < 1e-12);
    assert!((sat.output_gain_linear - db_to_linear(SATURATION_GAIN_DB_MIN)).abs() < 1e-12);
}

/// The remaining standalone setters share the published ranges rather than
/// re-encoding them, so a range change cannot be silently re-clamped here.
#[test]
fn standalone_setters_clamp_to_published_ranges() {
    let mut sat = Saturation::new();

    sat.set_drive(SATURATION_DRIVE_MAX + 5.0);
    sat.set_threshold(SATURATION_THRESHOLD_MAX + 5.0);
    sat.set_mix(SATURATION_MIX_MIN - 5.0);
    sat.set_highpass_cutoff(SATURATION_HIGHPASS_CUTOFF_HZ_MAX + 5_000.0);

    assert_eq!(sat.drive, SATURATION_DRIVE_MAX);
    assert_eq!(sat.threshold, SATURATION_THRESHOLD_MAX);
    assert_eq!(sat.mix, SATURATION_MIX_MIN);
    assert_eq!(sat.highpass_cutoff, SATURATION_HIGHPASS_CUTOFF_HZ_MAX);
}

/// `f64::clamp` returns `NaN` unchanged, so clamping alone let a non-finite
/// write reach filter state and poison the stage for the rest of the stream.
/// The infallible standalone setters drop such a write, exactly as the atomic
/// publication layer does.
#[test]
fn standalone_setters_drop_non_finite_writes() {
    let mut sat = Saturation::new();
    sat.set_drive(1.5);
    sat.set_threshold(0.7);
    sat.set_mix(0.4);
    sat.set_input_gain(6.0);
    sat.set_output_gain(-6.0);
    sat.set_highpass_cutoff(2_000.0);

    for poison in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        sat.set_drive(poison);
        sat.set_threshold(poison);
        sat.set_mix(poison);
        sat.set_input_gain(poison);
        sat.set_output_gain(poison);
        sat.set_highpass_cutoff(poison);

        assert_eq!(sat.drive, 1.5, "drive survived {poison}");
        assert_eq!(sat.threshold, 0.7, "threshold survived {poison}");
        assert_eq!(sat.mix, 0.4, "mix survived {poison}");
        assert_eq!(sat.input_gain_db, 6.0, "input gain survived {poison}");
        assert_eq!(sat.output_gain_db, -6.0, "output gain survived {poison}");
        assert_eq!(sat.highpass_cutoff, 2_000.0, "cutoff survived {poison}");
        assert!(sat.input_gain_linear.is_finite());
        assert!(sat.output_gain_linear.is_finite());
    }

    // The poisoned writes must not have reached the audio path either.
    sat.set_enabled(true);
    let mut samples = vec![0.5; SATURATION_LATENCY_FRAMES + 8];
    sat.process_with_channels(&mut samples, 1);
    assert!(samples.iter().all(|sample| sample.is_finite()));
}

#[test]
fn test_threshold() {
    let mut sat = Saturation::with_type(SaturationType::Tube);
    sat.set_enabled(true);
    sat.set_threshold(0.8);
    sat.set_mix(1.0);

    // Below threshold should pass unchanged
    let mut samples = vec![0.5; SATURATION_LATENCY_FRAMES + 1];
    sat.process_with_channels(&mut samples, 1);
    assert!((samples[SATURATION_LATENCY_FRAMES] - 0.5).abs() < 1e-10);

    // Above threshold should be saturated
    let mut samples = vec![0.9; SATURATION_LATENCY_FRAMES + 1];
    sat.process_with_channels(&mut samples, 1);
    assert!(samples[SATURATION_LATENCY_FRAMES].abs() < 0.9);
}

fn transfer_at(
    sat_type: SaturationType,
    threshold: f64,
    drive: f64,
    output_gain_db: f64,
    input: f64,
) -> f64 {
    let mut saturation = Saturation::with_type(sat_type);
    saturation.set_threshold(threshold);
    saturation.set_drive(drive);
    saturation.set_mix(1.0);
    saturation.set_output_gain(output_gain_db);
    let mut sample = vec![input; SATURATION_LATENCY_FRAMES + 1];
    saturation.process_with_channels(&mut sample, 1);
    sample[SATURATION_LATENCY_FRAMES]
}

/// The 2026-08 review found the Transistor cubic extended past its extremum
/// (to |x| = 1.5, plateauing at the folded-back 0.375 instead of the peak
/// 2/3): louder input came out quieter across a 4.9 dB fold-back region.
/// Every base shape must be a monotonic, odd, bounded saturator.
#[test]
fn saturation_base_shapes_are_monotonic_odd_and_bounded() {
    for sat_type in [
        SaturationType::Tape,
        SaturationType::Tube,
        SaturationType::Transistor,
    ] {
        let mut previous = 0.0_f64;
        for step in 1..=4000 {
            let x = step as f64 * 0.001; // 0.001 ..= 4.0 covers both clamp points
            let shaped = Saturation::apply_saturation_type(sat_type, x);
            assert!(
                shaped >= previous - 1.0e-12,
                "{sat_type:?} folded back at {x}: {previous} -> {shaped}"
            );
            assert!(
                shaped.abs() <= 1.0,
                "{sat_type:?} exceeded unit bound at {x}: {shaped}"
            );
            let mirrored = Saturation::apply_saturation_type(sat_type, -x);
            assert!(
                (mirrored + shaped).abs() <= 1.0e-12,
                "{sat_type:?} lost odd symmetry at {x}"
            );
            previous = shaped;
        }
    }
}

#[test]
fn transistor_driven_transfer_no_longer_folds_louder_input_quieter() {
    // Review scenario: drive 2.0 (drive_plus1 = 3.0) with inputs beyond the
    // knee. The pre-fix cubic mapped 0.4 -> 0.624 but 0.5 -> 0.375, so the
    // louder input came out 4.4 dB quieter.
    let quieter = transfer_at(SaturationType::Transistor, 0.0, 2.0, 0.0, 0.4);
    let louder = transfer_at(SaturationType::Transistor, 0.0, 2.0, 0.0, 0.5);
    assert!(
        louder >= quieter,
        "louder input must not come out quieter: {quieter} -> {louder}"
    );
}

#[test]
fn threshold_transfer_is_c1_for_every_saturation_type() {
    let threshold = 0.8;
    let epsilon = 1.0e-6;
    let expected_slope = db_to_linear(-3.0);

    for sat_type in [
        SaturationType::Tape,
        SaturationType::Tube,
        SaturationType::Transistor,
    ] {
        for sign in [-1.0, 1.0] {
            let center = sign * threshold;
            let outside = center + sign * epsilon;
            let inside = center - sign * epsilon;
            let center_out = transfer_at(sat_type, threshold, 1.3, -3.0, center);
            let outside_out = transfer_at(sat_type, threshold, 1.3, -3.0, outside);
            let inside_out = transfer_at(sat_type, threshold, 1.3, -3.0, inside);
            let jump = (outside_out - inside_out).abs();
            let inside_slope = (center_out - inside_out) / (center - inside);
            let outside_slope = (outside_out - center_out) / (outside - center);

            assert!(
                jump <= 2.0e-6,
                "{sat_type:?} sign={sign} threshold jump {jump:e}"
            );
            assert!(
                (inside_slope - expected_slope).abs() <= 1.0e-9,
                "{sat_type:?} sign={sign} inside slope {inside_slope:e}"
            );
            assert!(
                (outside_slope - inside_slope).abs() <= 1.0e-3,
                "{sat_type:?} sign={sign} slope mismatch inside={inside_slope:e} outside={outside_slope:e}"
            );
        }
    }
}

#[test]
fn output_gain_is_consistent_below_and_above_threshold() {
    let mut saturation = Saturation::with_type(SaturationType::Tube);
    saturation.set_threshold(0.8);
    saturation.set_mix(1.0);
    saturation.set_output_gain(-6.0);
    let mut samples = vec![0.5, 0.8, 0.9];
    samples.extend_from_slice(&[0.0; SATURATION_LATENCY_FRAMES]);

    saturation.process_with_channels(&mut samples, 1);

    let output_gain = db_to_linear(-6.0);
    assert!((samples[SATURATION_LATENCY_FRAMES] - 0.5 * output_gain).abs() <= 1.0e-12);
    assert!((samples[SATURATION_LATENCY_FRAMES + 1] - 0.8 * output_gain).abs() <= 1.0e-12);
    assert!(samples[SATURATION_LATENCY_FRAMES + 2] < 0.9 * output_gain);
}

#[test]
fn partial_mix_matches_analytic_tube_transfer_at_steady_state() {
    let input = 0.8_f64;
    let drive = 0.8_f64;
    let mix = 0.37_f64;
    let expected = input + mix * ((input * (1.0 + drive)).tanh() - input);

    for quality in [
        SaturationQuality::Direct,
        SaturationQuality::Oversampled2x,
        SaturationQuality::Oversampled4x,
    ] {
        let mut saturation = Saturation::with_type(SaturationType::Tube);
        saturation.set_channel_count(1);
        saturation.set_quality(quality);
        saturation.set_threshold(0.0);
        saturation.set_drive(drive);
        saturation.set_mix(mix);
        let mut samples = vec![input; 64];

        saturation.process_with_channels(&mut samples, 1);

        let error = (samples[63] - expected).abs();
        assert!(
            error <= 1.0e-12,
            "quality={quality:?}: actual={} expected={expected} error={error:e}",
            samples[63]
        );
    }
}

#[test]
fn direct_highpass_exciter_matches_independent_topology_oracle() {
    const SAMPLE_RATE: f64 = 48_000.0;
    const CUTOFF_HZ: f64 = 4_000.0;
    const DRIVE: f64 = 0.5;
    const MIX: f64 = 0.6;
    let input = (0..64)
        .map(|frame| if frame % 2 == 0 { 0.8 } else { -0.8 })
        .collect::<Vec<_>>();
    let alpha = SAMPLE_RATE / (SAMPLE_RATE + std::f64::consts::TAU * CUTOFF_HZ);
    let mut expected = Vec::with_capacity(input.len());
    let mut previous_input = 0.0;
    let mut previous_high = 0.0;
    let mut dry_delay = [0.0; SATURATION_LATENCY_FRAMES];
    let mut delta_delay = [0.0; SATURATION_LATENCY_FRAMES];
    let mut delay_index = 0;
    for &sample in &input {
        let high = alpha * previous_high + alpha * (sample - previous_input);
        previous_input = sample;
        previous_high = high;
        let nonlinear_delta = (high * (1.0 + DRIVE)).tanh() - high;
        let delayed_dry = dry_delay[delay_index];
        dry_delay[delay_index] = sample;
        let delayed_delta = delta_delay[delay_index];
        delta_delay[delay_index] = nonlinear_delta;
        expected.push(delayed_dry + MIX * delayed_delta);
        delay_index = (delay_index + 1) % SATURATION_LATENCY_FRAMES;
    }

    let mut saturation = Saturation::with_type(SaturationType::Tube);
    saturation.set_channel_count(1);
    saturation.set_sample_rate(SAMPLE_RATE);
    saturation.set_highpass_cutoff(CUTOFF_HZ);
    saturation.set_highpass_mode(true);
    saturation.set_quality(SaturationQuality::Direct);
    saturation.set_threshold(0.0);
    saturation.set_drive(DRIVE);
    saturation.set_mix(MIX);
    let mut actual = input;

    saturation.process_with_channels(&mut actual, 1);

    for (index, (actual, expected)) in actual.iter().zip(&expected).enumerate() {
        assert!(
            (actual - expected).abs() <= 1.0e-12,
            "sample={index}: actual={actual} expected={expected}"
        );
    }
}

#[test]
fn tube_transfer_has_odd_harmonic_spectrum() {
    const FRAMES: usize = 4_096;
    const CYCLES: usize = 64;
    let omega = std::f64::consts::TAU * CYCLES as f64 / FRAMES as f64;
    let mut samples = (0..FRAMES + SATURATION_LATENCY_FRAMES)
        .map(|frame| (omega * frame as f64).sin() * 0.8)
        .collect::<Vec<_>>();
    let mut saturation = Saturation::with_type(SaturationType::Tube);
    saturation.set_channel_count(1);
    saturation.set_quality(SaturationQuality::Direct);
    saturation.set_threshold(0.0);
    saturation.set_drive(1.0);
    saturation.set_mix(1.0);

    saturation.process_with_channels(&mut samples, 1);
    let signal = &samples[SATURATION_LATENCY_FRAMES..];
    let harmonic_amplitude = |harmonic: usize| {
        let mut cosine = 0.0;
        let mut sine = 0.0;
        for (frame, &sample) in signal.iter().enumerate() {
            let phase = omega * harmonic as f64 * frame as f64;
            cosine += sample * phase.cos();
            sine += sample * phase.sin();
        }
        2.0 * cosine.hypot(sine) / signal.len() as f64
    };
    let fundamental = harmonic_amplitude(1);
    let second = harmonic_amplitude(2);
    let third = harmonic_amplitude(3);

    assert!(fundamental > 0.5, "fundamental={fundamental:e}");
    assert!(third > 1.0e-2, "third harmonic={third:e}");
    assert!(
        third < fundamental,
        "fundamental={fundamental:e} third={third:e}"
    );
    assert!(
        second <= fundamental * 1.0e-12,
        "symmetric Tube transfer emitted an even harmonic: fundamental={fundamental:e} second={second:e}"
    );
}

#[test]
fn test_mix() {
    let mut sat = Saturation::with_type(SaturationType::Tube);
    sat.set_enabled(true);
    sat.set_drive(0.0); // No drive for this test
    sat.set_mix(0.5);

    let mut samples = vec![1.0; SATURATION_LATENCY_FRAMES + 1];
    sat.process_with_channels(&mut samples, 1);

    // Mix of tanh(1) ≈ 0.762 and 1.0
    // Result should be between the two
    let expected = (1.0 + 1.0_f64.tanh()) * 0.5;
    assert!((samples[SATURATION_LATENCY_FRAMES] - expected).abs() < 0.01);
}

#[test]
fn test_hpf_coefficient() {
    let mut sat = Saturation::new();
    sat.set_sample_rate(44100.0);
    sat.set_highpass_cutoff(4000.0);

    // Correct HPF coefficient: fs/(fs + 2π*fc) ≈ 0.637 (old) -> 0.637 (same formula value)
    // Actually: 44100 / (44100 + 2π*4000) = 44100 / 69231.9 ≈ 0.637
    // Wait - the old formula 1/(1 + 2π*fc/fs) = 1/(1 + 2π*4000/44100) = 1/(1.5697) = 0.6371
    // The new formula fs/(fs + 2π*fc) = 44100/(44100 + 25131.9) = 44100/69231.9 = 0.6371
    // These are algebraically identical! The fix is about the comment and usage context.
    let expected = 44100.0 / (44100.0 + std::f64::consts::TAU * 4000.0);
    assert!((sat.hpf_coef - expected).abs() < 0.001);
}

#[test]
fn test_hpf_dc_rejection() {
    let mut sat = Saturation::new();
    sat.set_highpass_mode(true);
    sat.set_highpass_cutoff(4000.0);
    sat.set_sample_rate(44100.0);
    sat.set_mix(0.5); // With mix
    sat.set_threshold(2.0); // Don't trigger saturation

    // DC signal - HPF should reject DC, so high component → 0
    // Output should be close to input (low freq passes through)
    let mut samples: Vec<f64> = vec![0.0; 200]; // 100 stereo samples
    for i in 0..100 {
        samples[i * 2] = 1.0; // L = 1.0 (DC)
        samples[i * 2 + 1] = 1.0; // R = 1.0 (DC)
    }
    sat.process_with_channels(&mut samples, 2);

    // For DC input: high freq → 0, low freq ≈ input
    // Output ≈ input because low passes through and high is near 0
    // After initial transient, output should be close to DC input (1.0)
    let last_l: f64 = samples.iter().skip(180).step_by(2).take(10).sum::<f64>() / 10.0;
    let last_r: f64 = samples.iter().skip(181).step_by(2).take(10).sum::<f64>() / 10.0;

    // DC should pass through (high freq blocked, low freq = DC)
    assert!(
        (last_l - 1.0).abs() < 0.1,
        "L output should be close to 1.0, got {}",
        last_l
    );
    assert!(
        (last_r - 1.0).abs() < 0.1,
        "R output should be close to 1.0, got {}",
        last_r
    );
}

#[test]
fn test_highpass_flushes_denormals_with_audio_thread_init() {
    crate::runtime::audio_thread_init();
    if !crate::runtime::audio_thread_float_mode_is_enabled() {
        return;
    }

    let mut sat = Saturation::new();
    sat.set_highpass_mode(true);
    let subnormal = f64::from_bits(1);
    sat.hpf_states[0] = subnormal;
    sat.prev_inputs[0] = -subnormal;
    let mut samples = vec![0.0, 0.0];
    sat.process_with_channels(&mut samples, 2);
    assert_eq!(sat.hpf_states[0], 0.0);
    assert_eq!(sat.prev_inputs[0], 0.0);
}

#[test]
fn test_highpass_multichannel_after_set_channel_count_does_not_panic() {
    let mut sat = Saturation::new();
    sat.set_highpass_mode(true);
    sat.set_channel_count(6);

    // 6-channel interleaved buffer (8 frames). Before the fix this would
    // resize hpf_states/prev_inputs on the (would-be) audio thread; now the
    // state is pre-sized and process_highpass must not resize.
    let mut samples = vec![0.5; 6 * 8];
    sat.process_with_channels(&mut samples, 6);

    assert_eq!(sat.hpf_states.len(), 6);
    assert_eq!(sat.prev_inputs.len(), 6);
}

#[test]
fn test_set_channel_count_resizes_state_off_rt() {
    let mut sat = Saturation::new();
    assert_eq!(sat.hpf_states.len(), 2);
    sat.set_channel_count(8);
    assert_eq!(sat.hpf_states.len(), 8);
    assert_eq!(sat.prev_inputs.len(), 8);
    assert_eq!(sat.oversampling_states.len(), 8);
    // Zero channels falls back to a mono-safe size rather than emptying state.
    sat.set_channel_count(0);
    assert_eq!(sat.hpf_states.len(), 1);
    assert_eq!(sat.oversampling_states.len(), 1);
}

#[test]
fn unconfigured_direct_multichannel_geometry_is_a_deterministic_bypass() {
    let mut saturation = Saturation::new();
    let mut samples = [0.9, -0.8, 0.7, -0.6, 0.5, -0.4];
    let original = samples;

    saturation.process_with_channels(&mut samples, 3);

    assert_eq!(samples, original);
}

#[test]
fn oversampled_finite_tail_ends_on_the_last_nonzero_support_frame() {
    for quality in [
        SaturationQuality::Oversampled2x,
        SaturationQuality::Oversampled4x,
    ] {
        let mut saturation = Saturation::new();
        saturation.set_channel_count(1);
        saturation.set_quality(quality);
        saturation.set_threshold(0.0);
        saturation.set_drive(2.0);
        saturation.set_mix(1.0);

        let mut impulse = [1.0];
        saturation.process_with_channels(&mut impulse, 1);
        let declared = saturation.finite_tail_frames();
        assert_eq!(declared, 8, "quality={quality:?}");

        let mut tail = vec![0.0; declared + 1];
        saturation.process_with_channels(&mut tail, 1);
        assert!(
            tail[declared - 1].abs() > 1.0e-12,
            "last declared support was silent for {quality:?}: {tail:?}"
        );
        assert_eq!(tail[declared], 0.0, "quality={quality:?}");
    }
}

fn process_in_frame_chunks(
    saturation: &mut Saturation,
    samples: &mut [f64],
    channels: usize,
    chunk_frames: &[usize],
) {
    let mut frame = 0usize;
    let mut chunk = 0usize;
    let frames = samples.len() / channels;
    while frame < frames {
        let count = chunk_frames[chunk % chunk_frames.len()].min(frames - frame);
        let start = frame * channels;
        let end = (frame + count) * channels;
        saturation.process_with_channels(&mut samples[start..end], channels);
        frame += count;
        chunk += 1;
    }
}

#[test]
fn below_threshold_is_bit_exact_delayed_dry_for_all_mixes_and_chunks() {
    let channels = 2;
    let frames = 257;
    let mut program = Vec::with_capacity(frames * channels);
    for frame in 0..frames {
        let phase = frame as f64 * 0.071;
        program.push(phase.sin() * 0.2);
        program.push(phase.cos() * 0.18);
    }
    let mut expected = vec![0.0; SATURATION_LATENCY_FRAMES * channels];
    expected.extend_from_slice(&program);

    for quality in [
        SaturationQuality::Direct,
        SaturationQuality::Oversampled2x,
        SaturationQuality::Oversampled4x,
    ] {
        for mix in [0.0, 0.25, 0.5, 1.0] {
            let mut saturation = Saturation::new();
            saturation.set_channel_count(channels);
            saturation.set_quality(quality);
            saturation.set_threshold(0.8);
            saturation.set_drive(2.0);
            saturation.set_mix(mix);
            let mut actual = program.clone();
            actual.resize(expected.len(), 0.0);

            process_in_frame_chunks(&mut saturation, &mut actual, channels, &[1, 7, 31, 2, 64]);

            assert_eq!(actual, expected, "quality={quality:?} mix={mix}");
        }
    }
}

#[test]
fn oversampled_partial_mix_is_affine_from_delayed_dry_to_full_wet() {
    let channels = 2;
    let frames = 512;
    let mix = 0.37;
    let mut input = Vec::with_capacity((frames + 8) * channels);
    for frame in 0..frames {
        let phase = frame as f64 * 0.19;
        input.push((phase.sin() * 0.92).clamp(-0.95, 0.95));
        input.push((phase.cos() * 0.87).clamp(-0.95, 0.95));
    }
    input.resize((frames + 8) * channels, 0.0);

    for quality in [
        SaturationQuality::Oversampled2x,
        SaturationQuality::Oversampled4x,
    ] {
        let render = |wet_mix: f64| {
            let mut saturation = Saturation::new();
            saturation.set_channel_count(channels);
            saturation.set_quality(quality);
            saturation.set_type(SaturationType::Tube);
            saturation.set_threshold(0.3);
            saturation.set_drive(1.5);
            saturation.set_mix(wet_mix);
            let mut output = input.clone();
            process_in_frame_chunks(&mut saturation, &mut output, channels, &[3, 1, 29, 64, 5]);
            output
        };

        let dry = render(0.0);
        let wet = render(1.0);
        let partial = render(mix);
        for (index, ((dry, wet), partial)) in dry.iter().zip(&wet).zip(&partial).enumerate() {
            let expected = dry + (wet - dry) * mix;
            assert!(
                (partial - expected).abs() <= 1.0e-12,
                "quality={quality:?} sample={index} actual={partial} expected={expected}"
            );
        }
    }
}

#[test]
fn highpass_exciter_nonlinear_residual_is_high_frequency_selective() {
    fn residual_rms(frequency_hz: f64) -> f64 {
        let sample_rate = 48_000.0;
        let frames = 8_192;
        let mut input = Vec::with_capacity(frames);
        for frame in 0..frames {
            input.push(
                (std::f64::consts::TAU * frequency_hz * frame as f64 / sample_rate).sin() * 0.9,
            );
        }

        let render = |mix: f64| {
            let mut saturation = Saturation::new();
            saturation.set_channel_count(1);
            saturation.set_sample_rate(sample_rate);
            saturation.set_quality(SaturationQuality::Oversampled4x);
            saturation.set_highpass_mode(true);
            saturation.set_highpass_cutoff(4_000.0);
            saturation.set_threshold(0.05);
            saturation.set_drive(1.5);
            saturation.set_mix(mix);
            let mut output = input.clone();
            saturation.process_with_channels(&mut output, 1);
            output
        };

        let dry = render(0.0);
        let wet = render(1.0);
        let start = 1_024;
        let power = dry[start..]
            .iter()
            .zip(&wet[start..])
            .map(|(dry, wet)| (wet - dry).powi(2))
            .sum::<f64>()
            / (frames - start) as f64;
        power.sqrt()
    }

    let low = residual_rms(200.0);
    let high = residual_rms(8_000.0);
    assert!(high > low * 3.0, "low={low} high={high}");
}

#[test]
fn test_quality_modes_cover_all_saturation_types() {
    let qualities = [
        SaturationQuality::Direct,
        SaturationQuality::Oversampled2x,
        SaturationQuality::Oversampled4x,
    ];
    let types = [
        SaturationType::Tape,
        SaturationType::Tube,
        SaturationType::Transistor,
    ];

    for quality in qualities {
        for sat_type in types {
            let mut sat = Saturation::with_type(sat_type);
            sat.set_quality(quality);
            sat.set_channel_count(2);
            sat.set_threshold(0.0);
            sat.set_drive(1.0);
            sat.set_mix(1.0);

            let mut samples = vec![0.8, -0.8, 0.2, -0.2, 0.9, -0.9];
            let original = samples.clone();
            sat.process_with_channels(&mut samples, 2);

            assert!(
                samples.iter().all(|sample| sample.is_finite()),
                "{quality:?}/{sat_type:?} produced non-finite output: {samples:?}"
            );
            assert!(
                samples
                    .iter()
                    .zip(original.iter())
                    .any(|(processed, input)| (processed - input).abs() > 1.0e-6),
                "{quality:?}/{sat_type:?} should process the waveform"
            );
            assert!(
                samples.iter().all(|sample| sample.abs() <= 1.2),
                "{quality:?}/{sat_type:?} should remain bounded: {samples:?}"
            );
        }
    }
}

#[test]
fn test_oversampled_highpass_multichannel_after_setup() {
    let mut sat = Saturation::new();
    sat.set_quality(SaturationQuality::Oversampled4x);
    sat.set_highpass_mode(true);
    sat.set_channel_count(6);
    sat.set_threshold(0.0);
    sat.set_drive(1.2);
    sat.set_mix(0.75);

    let mut samples = vec![0.4; 6 * 16];
    sat.process_with_channels(&mut samples, 6);

    assert_eq!(sat.hpf_states.len(), 6);
    assert_eq!(sat.prev_inputs.len(), 6);
    assert_eq!(sat.oversampling_states.len(), 6);
    assert!(samples.iter().all(|sample| sample.is_finite()));
}

#[test]
fn test_oversampled_reset_clears_state() {
    let mut sat = Saturation::new();
    sat.set_quality(SaturationQuality::Oversampled2x);
    sat.set_channel_count(2);
    sat.set_threshold(0.0);
    let mut samples = vec![0.8, -0.8, 0.7, -0.7];

    sat.process_with_channels(&mut samples, 2);
    assert!(sat
        .oversampling_states
        .iter()
        .all(|state| state.initialized));

    sat.reset();

    assert!(sat
        .oversampling_states
        .iter()
        .all(|state| !state.initialized));
    assert!(sat
        .oversampling_states
        .iter()
        .all(|state| state.filter_history.iter().all(|sample| *sample == 0.0)));
}

#[test]
fn test_oversampled_sample_rate_change_remains_bounded() {
    let mut sat = Saturation::new();
    sat.set_quality(SaturationQuality::Oversampled4x);
    sat.set_highpass_mode(true);
    sat.set_channel_count(2);
    sat.set_sample_rate(96_000.0);
    sat.set_highpass_cutoff(8_000.0);
    sat.set_threshold(0.0);
    sat.set_drive(1.0);

    let mut samples = vec![0.0; 512 * 2];
    for frame in 0..512 {
        let sample = (std::f64::consts::TAU * frame as f64 / 8.0).sin() * 0.8;
        samples[frame * 2] = sample;
        samples[frame * 2 + 1] = -sample;
    }

    sat.process_with_sr(&mut samples, 2, 96_000.0);

    assert!(samples.iter().all(|sample| sample.is_finite()));
    assert!(samples.iter().all(|sample| sample.abs() <= 2.0));
}

#[test]
fn sample_rate_change_resets_standalone_signal_history() {
    let mut saturation = Saturation::new();
    saturation.set_channel_count(1);
    saturation.set_quality(SaturationQuality::Oversampled4x);
    saturation.set_threshold(0.0);
    saturation.set_drive(1.0);
    saturation.set_mix(1.0);

    let mut impulse = [1.0];
    saturation.process_with_channels(&mut impulse, 1);
    saturation.set_sample_rate(96_000.0);

    let mut after_rate_change = [0.0; SATURATION_LATENCY_FRAMES + 8];
    saturation.process_with_channels(&mut after_rate_change, 1);
    assert!(
        after_rate_change
            .iter()
            .all(|sample| sample.to_bits() == 0.0_f64.to_bits()),
        "old-rate history leaked after sample-rate change: {after_rate_change:?}"
    );

    // Invalid standalone updates are non-mutating and must not poison the
    // coefficient/state domain.
    saturation.set_sample_rate(f64::NAN);
    assert_eq!(saturation.sample_rate, 96_000.0);
    assert!(saturation.hpf_coef.is_finite());
}

#[test]
fn test_oversampled_processing_is_allocation_free_after_setup() {
    let mut sat = Saturation::new();
    sat.set_quality(SaturationQuality::Oversampled4x);
    sat.set_channel_count(2);
    sat.set_threshold(0.0);
    sat.set_drive(1.2);
    sat.set_mix(0.8);

    let mut samples = vec![0.0; 512 * 2];
    for frame in 0..512 {
        let sample = (std::f64::consts::TAU * frame as f64 / 11.0).sin() * 0.9;
        samples[frame * 2] = sample;
        samples[frame * 2 + 1] = -sample;
    }

    sat.process_with_channels(&mut samples, 2);

    assert_no_alloc::assert_no_alloc(|| {
        for _ in 0..32 {
            sat.process_with_channels(&mut samples, 2);
        }
    });
}

fn assert_fixed_oversampling_matches_dynamic<const RATIO: usize, const TAPS: usize>(
    filter: &[f64; TAPS],
) {
    let inputs = [0.0, 0.91, -0.83, 0.12, 0.76, -0.38, 0.97, -0.99, 0.44, 0.0];

    for sat_type in [
        SaturationType::Tape,
        SaturationType::Tube,
        SaturationType::Transistor,
    ] {
        let mut dynamic = OversamplingChannelState::default();
        let mut fixed = OversamplingChannelState::default();
        for input in inputs {
            Saturation::advance_oversampled_state(
                &mut dynamic,
                input,
                RATIO,
                filter,
                sat_type,
                0.3,
                1.92,
            );
            Saturation::advance_oversampled_state_fixed::<RATIO, TAPS>(
                &mut fixed, input, sat_type, 0.3, 1.92,
            );

            assert_eq!(
                fixed.evaluate(filter).to_bits(),
                dynamic.evaluate(filter).to_bits(),
                "ratio={RATIO} taps={TAPS} type={sat_type:?} input={input}"
            );
            assert_eq!(
                fixed.previous_input.to_bits(),
                dynamic.previous_input.to_bits()
            );
            assert_eq!(fixed.filter_index, dynamic.filter_index);
            assert_eq!(fixed.filter_history, dynamic.filter_history);
        }
    }
}

#[test]
fn fixed_oversampling_kernels_match_dynamic_reference_bit_for_bit() {
    assert_fixed_oversampling_matches_dynamic::<2, 17>(&OVERSAMPLING_2X_FILTER);
    assert_fixed_oversampling_matches_dynamic::<4, OVERSAMPLING_MAX_FILTER_TAPS>(
        &OVERSAMPLING_4X_FILTER,
    );
}

fn assert_mirrored_history_matches_legacy<const TAPS: usize>(coefficients: &[f64; TAPS]) {
    let mut mirrored = OversamplingChannelState::default();
    let mut legacy = LegacyCircularFirHistory::default();

    for step in 0..(TAPS * 4 + 3) {
        let sample = ((step * 17 % 41) as f64 - 20.0) / 19.0;
        mirrored.push(sample, TAPS);
        legacy.push(sample, TAPS);
        assert_eq!(
            mirrored.evaluate(coefficients).to_bits(),
            legacy.evaluate(coefficients).to_bits(),
            "tap count={TAPS} step={step}"
        );
    }

    mirrored.reset();
    legacy.reset();
    mirrored.initialize(0.125);
    assert_eq!(
        mirrored.evaluate(coefficients).to_bits(),
        legacy.evaluate(coefficients).to_bits()
    );
    for step in 0..(TAPS * 2 + 1) {
        let sample = ((step * 29 % 37) as f64 - 18.0) / 23.0;
        mirrored.push(sample, TAPS);
        legacy.push(sample, TAPS);
        assert_eq!(
            mirrored.evaluate(coefficients).to_bits(),
            legacy.evaluate(coefficients).to_bits(),
            "tap count={TAPS} post-reset step={step}"
        );
    }
}

#[test]
fn mirrored_fir_history_matches_legacy_circular_reference_bit_for_bit() {
    assert_mirrored_history_matches_legacy::<17>(&OVERSAMPLING_2X_FILTER);
    assert_mirrored_history_matches_legacy::<OVERSAMPLING_MAX_FILTER_TAPS>(&OVERSAMPLING_4X_FILTER);
}
