use super::*;
use crate::processor::traits::AudioBlockError;

#[derive(Debug, PartialEq, Eq)]
struct DynamicLoudnessState {
    filter_state: Vec<(u64, u64)>,
    smoother_state: Vec<(u64, u64, u64, usize)>,
    last_applied_gains: [u64; LOUDNESS_BANDS_N],
    active_bands: [bool; LOUDNESS_BANDS_N],
    loudness_factor: u64,
    sample_rate: u64,
}

fn dynamic_loudness_state(processor: &DynamicLoudness) -> DynamicLoudnessState {
    DynamicLoudnessState {
        filter_state: processor
            .filters
            .iter()
            .flatten()
            .map(|filter| (filter.state.z1.to_bits(), filter.state.z2.to_bits()))
            .collect(),
        smoother_state: processor
            .smoothers
            .iter()
            .map(|smoother| {
                (
                    smoother.current.to_bits(),
                    smoother.target.to_bits(),
                    smoother.coeff.to_bits(),
                    smoother.samples_remaining,
                )
            })
            .collect(),
        last_applied_gains: processor.last_applied_gains.map(f64::to_bits),
        active_bands: processor.active_bands,
        loudness_factor: processor.current_loudness_factor.to_bits(),
        sample_rate: processor.sample_rate.to_bits(),
    }
}

#[test]
fn process_tracks_block_coefficient_ramp_within_buffer() {
    let make = || {
        let mut dl = DynamicLoudness::new_validated(2, 44_100.0);
        dl.set_strength(1.0);
        dl.set_volume(0.05);
        dl
    };
    let frames = BLOCK_SIZE * 4 + 17;
    let input: Vec<f64> = (0..frames * 2)
        .map(|i| ((i as f64) * 0.013).sin() * 0.3)
        .collect();
    let mut whole = make();
    let mut wbuf = input.clone();
    whole.process_validated(&mut wbuf);
    let mut chunked = make();
    let mut cbuf = input.clone();
    for cs in (0..frames).step_by(BLOCK_SIZE) {
        let ce = (cs + BLOCK_SIZE).min(frames);
        chunked.process_validated(&mut cbuf[cs * 2..ce * 2]);
    }
    for (w, c) in wbuf.iter().zip(&cbuf) {
        assert!((w - c).abs() < 1e-9, "{} vs {}", w, c);
    }
}

fn rbj_peaking_coeffs(freq: f64, gain_db: f64, q: f64, sample_rate: f64) -> BiquadCoeffs {
    if gain_db.abs() < 0.0001 {
        return BiquadCoeffs::default();
    }

    let a = 10.0_f64.powf(gain_db / 40.0);
    let w0 = 2.0 * std::f64::consts::PI * freq / sample_rate;
    let cos_w0 = w0.cos();
    let sin_w0 = w0.sin();
    let alpha = sin_w0 / (2.0 * q);

    let b0 = 1.0 + alpha * a;
    let b1 = -2.0 * cos_w0;
    let b2 = 1.0 - alpha * a;
    let a0 = 1.0 + alpha / a;
    let a1 = -2.0 * cos_w0;
    let a2 = 1.0 - alpha / a;

    BiquadCoeffs {
        b0: b0 / a0,
        b1: b1 / a0,
        b2: b2 / a0,
        a1: a1 / a0,
        a2: a2 / a0,
    }
}

fn rbj_low_shelf_coeffs(freq: f64, gain_db: f64, sample_rate: f64) -> BiquadCoeffs {
    if gain_db.abs() < 0.0001 {
        return BiquadCoeffs::default();
    }

    let a = 10.0_f64.powf(gain_db / 40.0);
    let w0 = 2.0 * std::f64::consts::PI * freq / sample_rate;
    let cos_w0 = w0.cos();
    let sin_w0 = w0.sin();
    let alpha = sin_w0 / std::f64::consts::SQRT_2;
    let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;

    let b0 = a * ((a + 1.0) - (a - 1.0) * cos_w0 + two_sqrt_a_alpha);
    let b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w0);
    let b2 = a * ((a + 1.0) - (a - 1.0) * cos_w0 - two_sqrt_a_alpha);
    let a0 = (a + 1.0) + (a - 1.0) * cos_w0 + two_sqrt_a_alpha;
    let a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cos_w0);
    let a2 = (a + 1.0) + (a - 1.0) * cos_w0 - two_sqrt_a_alpha;

    BiquadCoeffs {
        b0: b0 / a0,
        b1: b1 / a0,
        b2: b2 / a0,
        a1: a1 / a0,
        a2: a2 / a0,
    }
}

fn rbj_high_shelf_coeffs(freq: f64, gain_db: f64, sample_rate: f64) -> BiquadCoeffs {
    if gain_db.abs() < 0.0001 {
        return BiquadCoeffs::default();
    }

    let a = 10.0_f64.powf(gain_db / 40.0);
    let w0 = 2.0 * std::f64::consts::PI * freq / sample_rate;
    let cos_w0 = w0.cos();
    let sin_w0 = w0.sin();
    let alpha = sin_w0 / std::f64::consts::SQRT_2;
    let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;

    let b0 = a * ((a + 1.0) + (a - 1.0) * cos_w0 + two_sqrt_a_alpha);
    let b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0);
    let b2 = a * ((a + 1.0) + (a - 1.0) * cos_w0 - two_sqrt_a_alpha);
    let a0 = (a + 1.0) - (a - 1.0) * cos_w0 + two_sqrt_a_alpha;
    let a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cos_w0);
    let a2 = (a + 1.0) - (a - 1.0) * cos_w0 - two_sqrt_a_alpha;

    BiquadCoeffs {
        b0: b0 / a0,
        b1: b1 / a0,
        b2: b2 / a0,
        a1: a1 / a0,
        a2: a2 / a0,
    }
}

fn assert_coeffs_bit_equal(actual: &BiquadCoeffs, expected: &BiquadCoeffs) {
    assert_eq!(actual.b0.to_bits(), expected.b0.to_bits(), "b0");
    assert_eq!(actual.b1.to_bits(), expected.b1.to_bits(), "b1");
    assert_eq!(actual.b2.to_bits(), expected.b2.to_bits(), "b2");
    assert_eq!(actual.a1.to_bits(), expected.a1.to_bits(), "a1");
    assert_eq!(actual.a2.to_bits(), expected.a2.to_bits(), "a2");
}

fn response_db(coeffs: BiquadCoeffs, frequency: f64, sample_rate: f64) -> f64 {
    let w = 2.0 * std::f64::consts::PI * frequency / sample_rate;
    let (sin_w, cos_w) = w.sin_cos();
    let (sin_2w, cos_2w) = (2.0 * w).sin_cos();
    let numerator_re = coeffs.b0 + coeffs.b1 * cos_w + coeffs.b2 * cos_2w;
    let numerator_im = -coeffs.b1 * sin_w - coeffs.b2 * sin_2w;
    let denominator_re = 1.0 + coeffs.a1 * cos_w + coeffs.a2 * cos_2w;
    let denominator_im = -coeffs.a1 * sin_w - coeffs.a2 * sin_2w;
    let numerator = numerator_re.hypot(numerator_im);
    let denominator = denominator_re.hypot(denominator_im);
    20.0 * (numerator / denominator).log10()
}

#[test]
fn test_cached_geometry_coefficients_match_rbj_reference() {
    let cases = [
        (FilterType::LowShelf, 40.0, 0.7, 12.0, 192_000.0),
        (FilterType::Peaking, 100.0, 0.9, -12.0, 44_100.0),
        (FilterType::Peaking, 3000.0, 0.9, 20.0, 48_000.0),
        (FilterType::HighShelf, 12000.0, 0.7, -20.0, 44_100.0),
    ];

    for (filter_type, freq, q, gain, sample_rate) in cases {
        let mut filter = match filter_type {
            FilterType::Peaking => BiquadFilter::peaking(freq, 0.0, q, sample_rate),
            FilterType::LowShelf => BiquadFilter::low_shelf(freq, 0.0, sample_rate),
            FilterType::HighShelf => BiquadFilter::high_shelf(freq, 0.0, sample_rate),
        };
        filter.set_gain_db(gain);

        let expected = match filter_type {
            FilterType::Peaking => rbj_peaking_coeffs(freq, gain, q, sample_rate),
            FilterType::LowShelf => rbj_low_shelf_coeffs(freq, gain, sample_rate),
            FilterType::HighShelf => rbj_high_shelf_coeffs(freq, gain, sample_rate),
        };
        for (actual, expected) in [
            (filter.coeffs.b0, expected.b0),
            (filter.coeffs.b1, expected.b1),
            (filter.coeffs.b2, expected.b2),
            (filter.coeffs.a1, expected.a1),
            (filter.coeffs.a2, expected.a2),
        ] {
            assert!((actual - expected).abs() <= 1.0e-12);
        }
        for probe in [20.0, freq, (freq * 2.0).min(sample_rate * 0.49)] {
            let actual_db = response_db(filter.coeffs, probe, sample_rate);
            let expected_db = response_db(expected, probe, sample_rate);
            assert!(
                (actual_db - expected_db).abs() <= 1.0e-9,
                "{filter_type:?} {probe} Hz: {actual_db} vs {expected_db}"
            );
        }
    }
}

#[test]
fn sample_rate_change_preserves_control_and_smoother_state_but_resets_filters() {
    let mut dl = DynamicLoudness::new_validated(2, 48_000.0);
    dl.set_strength(0.37);
    dl.set_volume_db(-30.0);
    let mut input = vec![0.25; BLOCK_SIZE * 4 * 2];
    dl.process_validated(&mut input);
    let factor = dl.current_loudness_factor;
    let old_smoother_coeffs = dl
        .smoothers
        .iter()
        .map(|smoother| smoother.coeff)
        .collect::<Vec<_>>();
    let smoother_state = dl
        .smoothers
        .iter()
        .map(|smoother| {
            (
                smoother.current,
                smoother.target,
                smoother.samples_remaining,
            )
        })
        .collect::<Vec<_>>();
    assert!(dl
        .filters
        .iter()
        .flatten()
        .any(|filter| filter.state.z1 != 0.0 || filter.state.z2 != 0.0));

    dl.set_sample_rate(96_000.0).unwrap();

    assert_eq!(dl.sample_rate, 96_000.0);
    assert_eq!(dl.strength, 0.37);
    assert_eq!(dl.current_loudness_factor, factor);
    for ((smoother, expected), old_coeff) in dl
        .smoothers
        .iter()
        .zip(smoother_state)
        .zip(old_smoother_coeffs)
    {
        assert_eq!(
            (
                smoother.current,
                smoother.target,
                smoother.samples_remaining
            ),
            expected
        );
        assert!(smoother.coeff > old_coeff);
    }
    assert!(dl
        .filters
        .iter()
        .flatten()
        .all(|filter| filter.state.z1 == 0.0 && filter.state.z2 == 0.0));
}

#[test]
fn test_cached_geometry_rebuilds_on_sample_rate_change() {
    let mut filter = BiquadFilter::peaking(1000.0, 6.0, 1.0, 44_100.0);
    filter.set_sample_rate(96_000.0);
    filter.set_gain_db(6.0);

    let expected = rbj_peaking_coeffs(1000.0, 6.0, 1.0, 96_000.0);
    assert_coeffs_bit_equal(&filter.coeffs, &expected);
    assert_eq!(filter.geometry.sample_rate, 96_000.0);
}

#[test]
fn test_cached_geometry_extreme_gains_stay_finite() {
    for gain in [-20.0, -12.0, 0.0, 12.0, 20.0] {
        for mut filter in [
            BiquadFilter::low_shelf(40.0, 0.0, 192_000.0),
            BiquadFilter::peaking(1000.0, 0.0, 1.0, 48_000.0),
            BiquadFilter::high_shelf(12000.0, 0.0, 44_100.0),
        ] {
            filter.set_gain_db(gain);
            assert!(filter.coeffs.b0.is_finite());
            assert!(filter.coeffs.b1.is_finite());
            assert!(filter.coeffs.b2.is_finite());
            assert!(filter.coeffs.a1.is_finite());
            assert!(filter.coeffs.a2.is_finite());
        }
    }
}

#[test]
fn test_band_gain_update_uses_last_applied_epsilon() {
    let mut dl = DynamicLoudness::new_validated(2, 48_000.0);

    dl.apply_band_gain_if_changed(0, GAIN_UPDATE_EPSILON_DB * 2.0);
    assert_eq!(dl.last_applied_gains[0], GAIN_UPDATE_EPSILON_DB * 2.0);

    dl.apply_band_gain_if_changed(0, GAIN_UPDATE_EPSILON_DB * 2.5);
    assert_eq!(dl.last_applied_gains[0], GAIN_UPDATE_EPSILON_DB * 2.0);

    dl.apply_band_gain_if_changed(0, GAIN_UPDATE_EPSILON_DB * 3.5);
    assert_eq!(dl.last_applied_gains[0], GAIN_UPDATE_EPSILON_DB * 3.5);
}

#[test]
fn test_band_gain_update_broadcasts_coefficients_to_channels() {
    let mut dl = DynamicLoudness::new_validated(2, 48_000.0);
    dl.apply_band_gain_if_changed(0, 3.0);

    let left = dl.filters[0][0].coeffs;
    let right = dl.filters[1][0].coeffs;
    assert_coeffs_bit_equal(&left, &right);
}

#[test]
fn test_identity_bands_are_inactive_and_skipped() {
    let mut dl = DynamicLoudness::new_validated(2, 48_000.0);
    dl.set_volume_db(-40.0);
    let mut buffer = vec![0.25; BLOCK_SIZE * 2];

    dl.process_validated(&mut buffer);

    assert!(dl.active_bands[0]);
    assert!(!dl.active_bands[3]);
    assert_eq!(dl.filters[0][3].state.z1, 0.0);
    assert_eq!(dl.filters[0][3].state.z2, 0.0);
    assert_eq!(dl.filters[1][3].state.z1, 0.0);
    assert_eq!(dl.filters[1][3].state.z2, 0.0);
}

#[test]
fn test_first_process_applies_band_activity_state() {
    let mut dl = DynamicLoudness::new_validated(2, 48_000.0);
    dl.set_volume_db(-40.0);
    let mut buffer = vec![0.25; BLOCK_SIZE * 2];

    dl.process_validated(&mut buffer);

    assert!(dl.last_applied_gains.iter().all(|gain| gain.is_finite()));
    assert!(!dl.active_bands[3]);
    assert!(dl
        .active_bands
        .iter()
        .enumerate()
        .any(|(band, &active)| band != 3 && active));
}

#[test]
fn test_identity_path_applies_pregain_without_touching_filters() {
    let mut dl = DynamicLoudness::new_validated(2, 48_000.0);
    dl.set_volume_db(-15.0);
    let input = vec![0.25, -0.5, 0.125, -0.25];
    let mut buffer = input.clone();

    dl.process_validated(&mut buffer);

    for (actual, original) in buffer.iter().zip(input.iter()) {
        assert!((actual - original * dl.pre_gain_linear).abs() < 1.0e-12);
    }
    assert!(dl.active_bands.iter().all(|&active| !active));
    assert!(dl
        .filters
        .iter()
        .flatten()
        .all(|filter| filter.state.z1 == 0.0 && filter.state.z2 == 0.0));
}

#[test]
fn test_strength_zero_lets_active_bands_decay_to_inactive() {
    let mut dl = DynamicLoudness::new_validated(2, 48_000.0);
    dl.set_volume_db(-40.0);
    let mut buffer = vec![0.25; BLOCK_SIZE * 2];

    dl.process_validated(&mut buffer);
    assert!(dl.active_bands[0]);

    dl.set_strength(0.0);
    dl.process_validated(&mut buffer);
    assert!(
        dl.active_bands[0],
        "strength changes should not clear active filters before smoothing catches up"
    );

    for _ in 0..512 {
        dl.process_validated(&mut buffer);
    }

    assert!(dl.active_bands.iter().all(|&active| !active));
    assert!(dl.get_band_gains().iter().all(|gain| gain.abs() < 0.0001));
}

#[test]
fn test_biquad_peaking() {
    let mut filter = BiquadFilter::peaking(1000.0, 6.0, 1.0, 44100.0);

    // Process some samples
    let input = vec![0.5; 100];
    let mut output: Vec<f64> = Vec::new();

    for &sample in &input {
        output.push(filter.process(sample));
    }

    // Output should be boosted around the center frequency
    // At steady state, gain should be approximately 6 dB
    let steady_state = output.last().unwrap();
    assert!(steady_state > &0.5, "Peaking filter should boost");
}

#[test]
fn test_loudness_factor_calculation() {
    let mut dl = DynamicLoudness::new_validated(2, 44100.0);

    // At reference volume (-15 dB), factor should be 0
    dl.set_volume_db(-15.0);
    assert!((dl.loudness_factor() - 0.0).abs() < 0.01);

    // Below reference
    dl.set_volume_db(-25.0); // 10 dB below ref, transition is 25 dB
    assert!((dl.loudness_factor() - 0.4).abs() < 0.05);

    // Far below reference
    dl.set_volume_db(-50.0);
    assert!((dl.loudness_factor() - 1.0).abs() < 0.01);

    // Above reference
    dl.set_volume_db(-10.0);
    assert!((dl.loudness_factor() - 0.0).abs() < 0.01);
}

#[test]
fn test_strength_scaling() {
    let mut dl = DynamicLoudness::new_validated(2, 44100.0);
    dl.set_strength(0.5);
    dl.set_volume_db(-40.0); // Max compensation
    let mut buffer = vec![0.25; BLOCK_SIZE * 2];
    dl.process_validated(&mut buffer);

    // With 50% strength, max low shelf boost should be 6 dB (12 * 0.5)
    let gains = dl.get_band_gains();
    assert!(
        gains[0] > 0.0,
        "Expected smoother to start moving, got {}",
        gains[0]
    );
    assert!(
        gains[0] <= 6.0 + 0.1,
        "Expected gain to stay within target, got {}",
        gains[0]
    );
}

#[test]
fn test_process_no_crash() {
    let mut dl = DynamicLoudness::new_validated(2, 44100.0);
    dl.set_volume(0.1); // Low volume

    // Process some audio
    let mut buffer = vec![0.5; 1024];
    dl.process_validated(&mut buffer);

    // Should not crash or produce NaN/Inf
    for &sample in &buffer {
        assert!(sample.is_finite());
    }
}

#[test]
fn test_parameter_smoother() {
    let mut smoother = ParameterSmoother::new(50.0, 44100.0);

    smoother.set_target(10.0);

    // Should take some samples to reach target
    let mut current = 0.0_f64;
    for _ in 0..20000 {
        current = smoother.next_block(1);
    }

    // Should be close to target
    assert!((current - 10.0).abs() < 0.5);
}

#[test]
fn test_disabled_bypass() {
    let mut dl = DynamicLoudness::new_validated(2, 44100.0);
    dl.set_enabled(false);
    dl.set_volume(0.1);

    let input = vec![0.5; 100];
    let mut buffer = input.clone();
    dl.process_validated(&mut buffer);

    // When disabled, output should equal input
    for (i, o) in input.iter().zip(buffer.iter()) {
        assert!((i - o).abs() < 0.0001);
    }
}

#[test]
fn test_fixed_filter_banks_are_allocated_per_channel() {
    for channels in [1, 2, 6, 8] {
        let dl = DynamicLoudness::new_validated(channels, 48_000.0);
        assert_eq!(dl.filters.len(), channels);
        assert!(dl.filters.iter().all(|bank| bank.len() == LOUDNESS_BANDS_N));
    }
}

#[test]
fn test_reset_clears_all_filter_bank_state() {
    let mut dl = DynamicLoudness::new_validated(2, 48_000.0);
    dl.set_volume(0.1);

    let mut buffer = vec![0.25; 256];
    dl.process_validated(&mut buffer);

    assert!(dl
        .filters
        .iter()
        .flatten()
        .any(|filter| filter.state.z1 != 0.0 || filter.state.z2 != 0.0));

    dl.reset();

    assert!(dl
        .filters
        .iter()
        .flatten()
        .all(|filter| filter.state.z1 == 0.0 && filter.state.z2 == 0.0));
}

#[test]
fn raw_dynamic_loudness_rejects_invalid_geometry_without_state_mutation() {
    assert!(matches!(
        DynamicLoudness::new(0, 48_000.0),
        Err(ProcessError::InvalidBlock(AudioBlockError::ZeroChannels))
    ));
    for invalid_rate in [0.0, f64::NAN, f64::INFINITY] {
        assert!(matches!(
            DynamicLoudness::new(2, invalid_rate),
            Err(ProcessError::InvalidGeometry {
                processor: "DynamicLoudness",
                operation: "configure sample rate",
                ..
            })
        ));
    }

    let mut processor = DynamicLoudness::new(2, 48_000.0).unwrap();
    processor.set_volume_db(-35.0);
    let mut warm = [0.25; 128];
    processor.process(&mut warm, 2).unwrap();
    let state = dynamic_loudness_state(&processor);

    let mut zero_channels = [0.25; 4];
    let zero_channels_before = zero_channels;
    let mut incomplete = [0.25; 3];
    let incomplete_before = incomplete;
    let mut mismatch = [0.25; 4];
    let mismatch_before = mismatch;
    assert_no_alloc::assert_no_alloc(|| {
        assert_eq!(
            processor.process(&mut zero_channels, 0),
            Err(ProcessError::InvalidBlock(AudioBlockError::ZeroChannels))
        );
        assert_eq!(
            processor.process(&mut incomplete, 2),
            Err(ProcessError::InvalidBlock(
                AudioBlockError::IncompleteFrame {
                    samples: 3,
                    channels: 2,
                }
            ))
        );
        assert_eq!(
            processor.process(&mut mismatch, 1),
            Err(ProcessError::ChannelCountMismatch {
                processor: "DynamicLoudness",
                expected_channels: 2,
                actual_channels: 1,
            })
        );
        assert!(matches!(
            processor.set_sample_rate(0.0),
            Err(ProcessError::InvalidGeometry {
                processor: "DynamicLoudness",
                operation: "configure sample rate",
                ..
            })
        ));
    });

    assert_eq!(zero_channels, zero_channels_before);
    assert_eq!(incomplete, incomplete_before);
    assert_eq!(mismatch, mismatch_before);
    assert_eq!(dynamic_loudness_state(&processor), state);
}

#[test]
fn test_biquad_flushes_denormals_with_audio_thread_init() {
    crate::runtime::audio_thread_init();
    if !crate::runtime::audio_thread_float_mode_is_enabled() {
        return;
    }

    let mut filter = BiquadFilter::peaking(1000.0, 0.0, 1.0, 44100.0);
    let subnormal = f64::from_bits(1);
    filter.state.z1 = subnormal;
    filter.state.z2 = -subnormal;
    let _ = filter.process(0.0);
    assert_eq!(filter.state.z1, 0.0);
    assert_eq!(filter.state.z2, 0.0);
}

#[test]
fn test_biquad_sustained_subnormal_input_flushes_to_zero() {
    crate::runtime::audio_thread_init();
    if !crate::runtime::audio_thread_float_mode_is_enabled() {
        return;
    }

    let mut filter = BiquadFilter::peaking(1000.0, 6.0, 1.0, 44100.0);
    let subnormal = f64::from_bits(1);

    for _ in 0..1024 {
        assert_eq!(filter.process(subnormal), 0.0);
        assert_eq!(filter.process(-subnormal), 0.0);
    }

    assert_eq!(filter.state.z1, 0.0);
    assert_eq!(filter.state.z2, 0.0);
}
