//! IIR Biquad Equalizer - 10-band parametric EQ

use std::cmp::Ordering;

use super::lockfree_params::{validate_eq_band_index, EQ_BAND_GAIN_DB_MAX, EQ_BAND_GAIN_DB_MIN};
use super::traits::ProcessError;

pub use super::lockfree_params::EQ_BANDS;

/// Reject a band gain that would build non-finite biquad coefficients.
///
/// `f64::clamp` returns `NaN` unchanged, so an accepted `NaN` gain reaches
/// [`BiquadSection::peaking_eq`] and permanently poisons the filter history of
/// every channel in that band.
fn checked_band_gain(gain_db: f64) -> Result<f64, ProcessError> {
    if gain_db.is_finite() {
        return Ok(gain_db);
    }
    Err(ProcessError::InvalidParameter {
        processor: "Equalizer",
        parameter: "eq band gain",
        message: "value must be finite",
    })
}

/// IIR Biquad filter section (SOS - Second Order Section)
///
/// Crate-internal: this is the building block of [`Equalizer`], not a
/// user-facing type. Keeping it private leaves the biquad representation free
/// to change without a breaking release.
#[derive(Clone)]
pub(crate) struct BiquadSection {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl BiquadSection {
    /// A unit-gain pass-through section: `y[n] = x[n]` for every input.
    fn identity() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    pub fn peaking_eq(freq: f64, gain_db: f64, q: f64, sample_rate: f64) -> Self {
        // A center frequency at or above Nyquist has no representable band to
        // move: `w0 >= PI` makes `sin(w0) <= 0`, which flips the sign of
        // `alpha` and puts the pole pair on or outside the unit circle, so the
        // section diverges instead of filtering (a 16 kHz band on 22.05 kHz
        // material reached |pole| = 2.38 at -12 dB). Such a band is a stable
        // identity at every gain. Only a strictly-below-Nyquist ordering
        // designs a filter, so an incomparable (non-finite) frequency or
        // sample rate also takes the identity path.
        let strictly_below_nyquist =
            matches!((freq * 2.0).partial_cmp(&sample_rate), Some(Ordering::Less));
        if !strictly_below_nyquist {
            return Self::identity();
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

        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    #[inline]
    pub fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

/// 10-band Parametric EQ
///
/// Band centers are fixed at 31 Hz through 16 kHz. A band whose center
/// frequency is at or above the Nyquist frequency of the configured sample
/// rate (for example the 16 kHz band on 22.05 kHz material) is a transparent
/// identity stage at every gain setting; it re-arms automatically when a later
/// sample-rate change brings the band back below Nyquist.
pub struct Equalizer {
    bands: Vec<[BiquadSection; EQ_BANDS]>, // current active filters [channel][band]
    target_bands: Vec<[BiquadSection; EQ_BANDS]>, // target filters (new params) [channel][band]
    target_gains: Vec<f64>,                // target gain per band (dB)
    smooth_counter: Vec<u32>,              // samples remaining in crossfade per band
    channels: usize,
    enabled: bool,
}

const EQ_SMOOTH_SAMPLES: u32 = 1024; // ~23ms @ 44100Hz
const INV_EQ_SMOOTH: f64 = 1.0 / EQ_SMOOTH_SAMPLES as f64;

impl Equalizer {
    const FREQUENCIES: [f64; EQ_BANDS] = [
        31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
    ];
    const Q: f64 = 1.41;

    /// Construct a disabled, flat 10-band equalizer for `channels` streams.
    pub fn new(channels: usize, sample_rate: f64) -> Self {
        let bands: Vec<[BiquadSection; EQ_BANDS]> = (0..channels)
            .map(|_| Self::build_channel_bank(sample_rate))
            .collect();
        let target_bands = bands.clone();

        Self {
            bands,
            target_bands,
            target_gains: vec![0.0; EQ_BANDS],
            smooth_counter: vec![0u32; EQ_BANDS],
            channels,
            enabled: false,
        }
    }

    fn build_channel_bank(sample_rate: f64) -> [BiquadSection; EQ_BANDS] {
        std::array::from_fn(|idx| {
            BiquadSection::peaking_eq(Self::FREQUENCIES[idx], 0.0, Self::Q, sample_rate)
        })
    }

    /// Set one band's target gain in dB, clamped to
    /// [`EQ_BAND_GAIN_DB_MIN`]..=[`EQ_BAND_GAIN_DB_MAX`], and start this band's
    /// crossfade to the new coefficients.
    ///
    /// Returns [`ProcessError::InvalidParameter`] for a band index at or above
    /// [`EQ_BANDS`] and for a non-finite gain. Neither is clamped: clamping an
    /// index would edit a different band than the caller asked for, and a
    /// non-finite gain would poison this filter's history for the rest of the
    /// stream. A rejected call leaves coefficients, target gains, and
    /// transition counters untouched.
    pub fn set_band_gain(
        &mut self,
        band_idx: usize,
        gain_db: f64,
        sample_rate: f64,
    ) -> Result<(), ProcessError> {
        validate_eq_band_index("Equalizer", band_idx)?;
        let gain_db = checked_band_gain(gain_db)?;
        self.set_band_gain_validated(band_idx, gain_db, sample_rate);
        Ok(())
    }

    /// Set every band's target gain, clamped like [`Self::set_band_gain`].
    ///
    /// The whole bank is validated before any band is applied, so a single
    /// non-finite entry cannot leave a partially updated equalizer behind.
    pub fn set_all_bands(
        &mut self,
        gains: &[f64; EQ_BANDS],
        sample_rate: f64,
    ) -> Result<(), ProcessError> {
        for gain in gains {
            checked_band_gain(*gain)?;
        }
        self.set_all_bands_validated(gains, sample_rate);
        Ok(())
    }

    /// Apply one already-validated band gain.
    ///
    /// Callers must supply `band_idx < EQ_BANDS` and a finite `gain_db`. This
    /// kernel owns the published-range clamp. Callback-side parameter sync
    /// calls it directly because [`AtomicEqParams`](super::AtomicEqParams) has
    /// already sanitized its snapshot, so the audio thread pays no validation
    /// and handles no `Result`.
    pub(crate) fn set_band_gain_validated(
        &mut self,
        band_idx: usize,
        gain_db: f64,
        sample_rate: f64,
    ) {
        let gain_db = gain_db.clamp(EQ_BAND_GAIN_DB_MIN, EQ_BAND_GAIN_DB_MAX);
        let freq = Self::FREQUENCIES[band_idx];
        // Update target filters for all channels
        for ch in 0..self.channels {
            self.target_bands[ch][band_idx] =
                BiquadSection::peaking_eq(freq, gain_db, Self::Q, sample_rate);
        }
        self.target_gains[band_idx] = gain_db;
        // Start crossfade for this band
        self.smooth_counter[band_idx] = EQ_SMOOTH_SAMPLES;
    }

    /// Apply an already-validated complete bank; see
    /// [`Self::set_band_gain_validated`] for the caller's precondition.
    pub(crate) fn set_all_bands_validated(&mut self, gains: &[f64; EQ_BANDS], sample_rate: f64) {
        for (idx, &gain) in gains.iter().enumerate() {
            self.set_band_gain_validated(idx, gain, sample_rate);
        }
    }

    /// Enable or bypass filtering without discarding filter state.
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// Return whether filtering is currently enabled.
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Filter complete interleaved frames in place.
    ///
    /// Any trailing samples that do not form a complete frame are left
    /// untouched. The caller must configure the same channel count used by
    /// the buffer.
    pub fn process(&mut self, buffer: &mut [f64]) {
        if !self.enabled || self.channels == 0 {
            return;
        }
        debug_assert!(self.bands.len() >= self.channels);
        debug_assert!(self.target_bands.len() >= self.channels);
        let frames = buffer.len() / self.channels;

        if self.channels == 2 && self.smooth_counter.iter().all(|&counter| counter == 0) {
            self.process_settled_stereo(buffer);
            return;
        }

        for frame in 0..frames {
            // Process all channels for this frame
            for ch in 0..self.channels {
                let idx = frame * self.channels + ch;
                buffer[idx] = self.process_sample_no_counter_update(buffer[idx], ch);
            }

            // Update smooth counters once per frame (after all channels processed)
            // This fixes the multi-channel sync issue (MINOR-04)
            for b in 0..EQ_BANDS {
                if self.smooth_counter[b] > 0 {
                    self.smooth_counter[b] -= 1;
                    // Crossfade done: snap current to target
                    if self.smooth_counter[b] == 0 {
                        for c in 0..self.channels {
                            self.bands[c][b].clone_from(&self.target_bands[c][b]);
                        }
                    }
                }
            }
        }
    }

    fn process_settled_stereo(&mut self, buffer: &mut [f64]) {
        debug_assert_eq!(self.channels, 2);
        debug_assert!(self.smooth_counter.iter().all(|&counter| counter == 0));

        let (left_banks, right_banks) = self.bands.split_at_mut(1);
        let left_bands = &mut left_banks[0];
        let right_bands = &mut right_banks[0];

        for frame in buffer.chunks_exact_mut(2) {
            let mut left = frame[0];
            for band in left_bands.iter_mut() {
                left = band.process(left);
            }
            frame[0] = left;

            let mut right = frame[1];
            for band in right_bands.iter_mut() {
                right = band.process(right);
            }
            frame[1] = right;
        }
    }

    /// Process a single sample without updating smooth_counter
    /// Counter updates are handled in process() for proper multi-channel sync
    #[inline]
    fn process_sample_no_counter_update(&mut self, mut sample: f64, ch: usize) -> f64 {
        debug_assert!(ch < self.channels);
        for b in 0..EQ_BANDS {
            if self.smooth_counter[b] > 0 {
                // Blend: run both filters on the same input
                let current_out = self.bands[ch][b].process(sample);
                let target_out = self.target_bands[ch][b].process(sample);
                let t = self.smooth_counter[b] as f64 * INV_EQ_SMOOTH;
                sample = current_out * t + target_out * (1.0 - t);
            } else {
                sample = self.bands[ch][b].process(sample);
            }
        }
        sample
    }

    // M-2 fix: Removed deprecated process_sample() method.
    // It duplicated logic from process() + process_sample_no_counter_update()
    // with subtle differences that could cause bugs. Use process() instead.

    /// Reset all biquad signal history (`z1`/`z2`) in every channel, for both
    /// the active and the target filter banks.
    ///
    /// Coefficients and any in-progress parameter crossfade are preserved: a
    /// transition that was mid-flight continues (now over cleared history)
    /// and still adopts the target coefficients when it completes. Use
    /// `reset_settled` (crate-internal) to start a logically new
    /// stream directly from the latest target coefficients instead.
    pub fn reset(&mut self) {
        for ch in &mut self.bands {
            for band in ch {
                band.reset();
            }
        }
        for ch in &mut self.target_bands {
            for band in ch {
                band.reset();
            }
        }
    }

    /// Start a new stream from the latest target coefficients without a
    /// carry-over parameter transition or signal history.
    pub(crate) fn reset_settled(&mut self) {
        for channel in 0..self.channels {
            for band in 0..EQ_BANDS {
                self.bands[channel][band].clone_from(&self.target_bands[channel][band]);
            }
        }
        self.smooth_counter.fill(0);
        self.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_section_bit_equal(actual: &BiquadSection, expected: &BiquadSection) {
        assert_eq!(actual.b0.to_bits(), expected.b0.to_bits(), "b0");
        assert_eq!(actual.b1.to_bits(), expected.b1.to_bits(), "b1");
        assert_eq!(actual.b2.to_bits(), expected.b2.to_bits(), "b2");
        assert_eq!(actual.a1.to_bits(), expected.a1.to_bits(), "a1");
        assert_eq!(actual.a2.to_bits(), expected.a2.to_bits(), "a2");
        assert_eq!(actual.z1.to_bits(), expected.z1.to_bits(), "z1");
        assert_eq!(actual.z2.to_bits(), expected.z2.to_bits(), "z2");
    }

    fn configured_transition_input(kind: usize) -> Vec<f64> {
        let mut input = vec![0.0; EQ_SMOOTH_SAMPLES as usize];
        match kind {
            0 => {
                for (frame, sample) in input.iter_mut().enumerate() {
                    *sample =
                        (2.0 * std::f64::consts::PI * 997.0 * frame as f64 / 48_000.0).sin() * 0.4;
                }
            }
            _ => input[17] = 0.8,
        }
        input
    }

    fn assert_transition_adopts_target_state(transition_input: &[f64]) {
        const BAND: usize = 5;
        let mut eq = Equalizer::new(1, 48_000.0);
        eq.set_enabled(true);

        let mut warmup = (0..257)
            .map(|frame| ((frame as f64) * 0.071).sin() * 0.3)
            .collect::<Vec<_>>();
        eq.process(&mut warmup);
        eq.set_band_gain(BAND, 12.0, 48_000.0).unwrap();

        let mut transition = transition_input.to_vec();
        eq.process(&mut transition);

        assert_eq!(eq.smooth_counter[BAND], 0);
        assert_section_bit_equal(&eq.bands[0][BAND], &eq.target_bands[0][BAND]);

        let mut actual = eq.bands[0][BAND].clone();
        let mut reference = eq.target_bands[0][BAND].clone();
        let continuation = (0..512)
            .map(|frame| ((frame as f64) * 0.113).cos() * 0.25)
            .collect::<Vec<_>>();
        let max_error = continuation
            .into_iter()
            .map(|sample| (actual.process(sample) - reference.process(sample)).abs())
            .fold(0.0_f64, f64::max);
        assert!(max_error <= 1.0e-9, "continuation error {max_error:e}");
    }

    #[test]
    fn transition_adopts_complete_target_state_for_tone_and_impulse() {
        assert_transition_adopts_target_state(&configured_transition_input(0));
        assert_transition_adopts_target_state(&configured_transition_input(1));
    }

    #[test]
    fn transition_is_equivalent_across_irregular_chunks() {
        let mut whole = Equalizer::new(2, 48_000.0);
        let mut chunked = Equalizer::new(2, 48_000.0);
        whole.set_enabled(true);
        chunked.set_enabled(true);
        whole.set_band_gain(5, 9.0, 48_000.0).unwrap();
        chunked.set_band_gain(5, 9.0, 48_000.0).unwrap();
        let input = (0..(EQ_SMOOTH_SAMPLES as usize + 733) * 2)
            .map(|sample| ((sample as f64) * 0.019).sin() * 0.3)
            .collect::<Vec<_>>();
        let mut expected = input.clone();
        let mut actual = input;

        whole.process(&mut expected);
        let chunk_pattern = [1, 17, 3, 127, 64, 5, 251, 32];
        let total_frames = actual.len() / 2;
        let mut start = 0;
        let mut pattern = 0;
        while start < total_frames {
            let end = (start + chunk_pattern[pattern % chunk_pattern.len()]).min(total_frames);
            chunked.process(&mut actual[start * 2..end * 2]);
            start = end;
            pattern += 1;
        }

        let max_error = actual
            .iter()
            .zip(&expected)
            .map(|(left, right)| (left - right).abs())
            .fold(0.0_f64, f64::max);
        assert!(max_error <= 1.0e-9, "chunking error {max_error:e}");
    }

    #[test]
    fn transition_completion_is_allocation_free() {
        let mut eq = Equalizer::new(2, 48_000.0);
        eq.set_enabled(true);
        eq.set_band_gain(5, 12.0, 48_000.0).unwrap();
        let mut buffer = vec![0.25; EQ_SMOOTH_SAMPLES as usize * 2];

        assert_no_alloc::assert_no_alloc(|| eq.process(&mut buffer));
    }

    #[test]
    fn fixed_band_banks_are_allocated_per_channel() {
        for channels in [1, 2, 6, 8] {
            let eq = Equalizer::new(channels, 48_000.0);
            assert_eq!(eq.bands.len(), channels);
            assert_eq!(eq.target_bands.len(), channels);
            assert!(eq.bands.iter().all(|bank| bank.len() == EQ_BANDS));
            assert!(eq.target_bands.iter().all(|bank| bank.len() == EQ_BANDS));
        }
    }

    #[test]
    fn process_with_zero_channels_is_a_noop_not_a_panic() {
        // A zero-channel EQ can be constructed; process must not divide by zero.
        let mut eq = Equalizer::new(0, 48_000.0);
        eq.set_enabled(true);
        let mut buffer = vec![0.25; 8];
        eq.process(&mut buffer);
        assert_eq!(buffer, vec![0.25; 8]);
    }

    #[test]
    fn reset_clears_current_and_target_bank_state() {
        let mut eq = Equalizer::new(2, 48_000.0);
        eq.set_enabled(true);
        eq.set_band_gain(0, 6.0, 48_000.0).unwrap();

        let mut buffer = vec![0.25; 256];
        eq.process(&mut buffer);

        assert!(eq
            .bands
            .iter()
            .flatten()
            .chain(eq.target_bands.iter().flatten())
            .any(|band| band.z1 != 0.0 || band.z2 != 0.0));

        eq.reset();

        assert!(eq
            .bands
            .iter()
            .flatten()
            .chain(eq.target_bands.iter().flatten())
            .all(|band| band.z1 == 0.0 && band.z2 == 0.0));
    }

    #[test]
    fn settled_reset_adopts_target_and_clears_transition_state() {
        let mut eq = Equalizer::new(2, 48_000.0);
        eq.set_enabled(true);
        eq.set_band_gain(5, 9.0, 48_000.0).unwrap();
        let mut buffer = vec![0.25; 2 * 137];
        eq.process(&mut buffer);
        assert!(eq.smooth_counter[5] > 0);

        eq.reset_settled();

        assert!(eq.smooth_counter.iter().all(|&counter| counter == 0));
        for channel in 0..2 {
            for band in 0..EQ_BANDS {
                assert_section_bit_equal(&eq.bands[channel][band], &eq.target_bands[channel][band]);
                assert_eq!(eq.bands[channel][band].z1, 0.0);
                assert_eq!(eq.bands[channel][band].z2, 0.0);
            }
        }
    }

    #[test]
    fn settled_stereo_fast_path_matches_regular_path() {
        let gains = [12.0, 9.0, 6.0, 3.0, -3.0, -6.0, -9.0, -12.0, 6.0, -6.0];
        let mut regular = Equalizer::new(2, 48_000.0);
        let mut fast = Equalizer::new(2, 48_000.0);
        regular.set_enabled(true);
        fast.set_enabled(true);
        regular.set_all_bands(&gains, 48_000.0).unwrap();
        fast.set_all_bands(&gains, 48_000.0).unwrap();

        let mut silence = vec![0.0; 2 * (EQ_SMOOTH_SAMPLES as usize + 1)];
        regular.process(&mut silence);
        fast.process(&mut silence);
        assert!(regular.smooth_counter.iter().all(|&counter| counter == 0));
        assert!(fast.smooth_counter.iter().all(|&counter| counter == 0));

        let mut regular_buffer = (0..2048)
            .map(|sample| {
                let t = sample as f64 / 48_000.0;
                (2.0 * std::f64::consts::PI * 997.0 * t).sin() * 0.25
            })
            .collect::<Vec<_>>();
        let mut fast_buffer = regular_buffer.clone();

        regular.process_sample_by_sample_for_test(&mut regular_buffer);
        fast.process(&mut fast_buffer);

        let max_abs = regular_buffer
            .iter()
            .zip(&fast_buffer)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f64::max);
        assert!(max_abs <= 1.0e-12, "max_abs={max_abs:.3e}");
    }

    fn assert_bank_bit_equal(actual: &Equalizer, expected: &Equalizer) {
        assert_eq!(actual.channels, expected.channels, "channels");
        assert_eq!(actual.target_gains, expected.target_gains, "target gains");
        assert_eq!(
            actual.smooth_counter, expected.smooth_counter,
            "transition counters"
        );
        for channel in 0..expected.channels {
            for band in 0..EQ_BANDS {
                assert_section_bit_equal(
                    &actual.bands[channel][band],
                    &expected.bands[channel][band],
                );
                assert_section_bit_equal(
                    &actual.target_bands[channel][band],
                    &expected.target_bands[channel][band],
                );
            }
        }
    }

    fn configured_stereo_eq() -> Equalizer {
        let mut eq = Equalizer::new(2, 48_000.0);
        eq.set_enabled(true);
        eq.set_band_gain(2, 6.0, 48_000.0).unwrap();
        eq
    }

    #[test]
    fn out_of_range_band_index_is_rejected_without_touching_state() {
        let mut eq = configured_stereo_eq();
        let expected = configured_stereo_eq();

        for band in [EQ_BANDS, EQ_BANDS + 1, usize::MAX] {
            assert_eq!(
                eq.set_band_gain(band, 12.0, 48_000.0).unwrap_err(),
                ProcessError::InvalidParameter {
                    processor: "Equalizer",
                    parameter: "eq band index",
                    message: "band index must be below EQ_BANDS",
                }
            );
        }

        assert_bank_bit_equal(&eq, &expected);
    }

    #[test]
    fn non_finite_band_gain_is_rejected_and_cannot_poison_filter_history() {
        let mut eq = configured_stereo_eq();
        let expected = configured_stereo_eq();

        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(
                eq.set_band_gain(2, bad, 48_000.0).unwrap_err(),
                ProcessError::InvalidParameter {
                    processor: "Equalizer",
                    parameter: "eq band gain",
                    message: "value must be finite",
                }
            );
        }

        assert_bank_bit_equal(&eq, &expected);

        // Before this contract `f64::clamp` passed NaN straight into the
        // coefficients and every later sample came out NaN.
        let mut buffer = vec![0.25; 2 * (EQ_SMOOTH_SAMPLES as usize + 64)];
        eq.process(&mut buffer);
        assert!(buffer.iter().all(|sample| sample.is_finite()));
    }

    #[test]
    fn whole_bank_write_is_rejected_atomically_when_any_gain_is_non_finite() {
        let mut eq = Equalizer::new(2, 48_000.0);
        let untouched = Equalizer::new(2, 48_000.0);

        let mut gains = [3.0; EQ_BANDS];
        gains[EQ_BANDS - 1] = f64::NAN;
        assert_eq!(
            eq.set_all_bands(&gains, 48_000.0).unwrap_err(),
            ProcessError::InvalidParameter {
                processor: "Equalizer",
                parameter: "eq band gain",
                message: "value must be finite",
            }
        );

        // The nine finite gains ahead of the rejected one must not be applied.
        assert_bank_bit_equal(&eq, &untouched);
    }

    #[test]
    fn band_gain_is_clamped_to_the_published_range() {
        let mut eq = Equalizer::new(1, 48_000.0);

        eq.set_band_gain(0, EQ_BAND_GAIN_DB_MAX + 40.0, 48_000.0)
            .unwrap();
        eq.set_band_gain(1, EQ_BAND_GAIN_DB_MIN - 40.0, 48_000.0)
            .unwrap();

        assert_eq!(eq.target_gains[0], EQ_BAND_GAIN_DB_MAX);
        assert_eq!(eq.target_gains[1], EQ_BAND_GAIN_DB_MIN);
    }

    #[test]
    fn checked_and_validated_band_writes_produce_identical_state() {
        let mut checked = Equalizer::new(2, 48_000.0);
        let mut kernel = Equalizer::new(2, 48_000.0);
        let gains = [12.0, 9.0, 6.0, 3.0, -3.0, -6.0, -9.0, -12.0, 6.0, -6.0];

        checked.set_all_bands(&gains, 48_000.0).unwrap();
        kernel.set_all_bands_validated(&gains, 48_000.0);

        assert_bank_bit_equal(&checked, &kernel);
    }

    /// Necessary-and-sufficient stability test for a normalized biquad: both
    /// poles are strictly inside the unit circle iff `|a2| < 1` and
    /// `|a1| < 1 + a2` (Schur-Cohn / stability triangle).
    fn assert_section_is_strictly_stable(section: &BiquadSection, context: &str) {
        assert!(
            section.a2.abs() < 1.0 && section.a1.abs() < 1.0 + section.a2,
            "{context}: unstable poles (a1={}, a2={})",
            section.a1,
            section.a2
        );
    }

    #[test]
    fn every_band_is_strictly_stable_across_sample_rates_and_extreme_gains() {
        // The 2026-08 review found the 16 kHz band diverging on 22.05/24 kHz
        // material: freq >= Nyquist flips the sign of alpha and pushes the
        // pole pair outside the unit circle. Every prior test lived at 48 kHz
        // and could not see it.
        for sample_rate in [
            8_000.0, 11_025.0, 16_000.0, 22_050.0, 24_000.0, 32_000.0, 44_100.0, 48_000.0,
            96_000.0, 192_000.0,
        ] {
            for gain_db in [EQ_BAND_GAIN_DB_MIN, -3.0, 0.0, 3.0, EQ_BAND_GAIN_DB_MAX] {
                for (band, &freq) in Equalizer::FREQUENCIES.iter().enumerate() {
                    let section =
                        BiquadSection::peaking_eq(freq, gain_db, Equalizer::Q, sample_rate);
                    assert_section_is_strictly_stable(
                        &section,
                        &format!("band {band} ({freq} Hz) at {gain_db} dB, fs {sample_rate}"),
                    );
                }
            }
        }
    }

    #[test]
    fn bands_at_or_above_nyquist_are_transparent_and_bounded() {
        // 22.05 kHz playback with the full user gain range applied to every
        // band: the 16 kHz band (and at 8 kHz playback also the 8 kHz band)
        // must be a stable pass-through instead of diverging to NaN.
        for sample_rate in [8_000.0, 22_050.0, 24_000.0] {
            let mut eq = Equalizer::new(2, sample_rate);
            eq.set_enabled(true);
            let gains = [EQ_BAND_GAIN_DB_MAX; EQ_BANDS];
            eq.set_all_bands(&gains, sample_rate).unwrap();

            let mut buffer = (0..2 * (EQ_SMOOTH_SAMPLES as usize + 2048))
                .map(|sample| ((sample as f64) * 0.037).sin() * 0.5)
                .collect::<Vec<_>>();
            eq.process(&mut buffer);

            let max_abs = buffer.iter().fold(0.0_f64, |acc, s| acc.max(s.abs()));
            assert!(
                max_abs.is_finite() && max_abs < 1.0e3,
                "fs {sample_rate}: output diverged (max abs {max_abs:e})"
            );
        }
    }

    #[test]
    fn nyquist_band_is_bit_exact_identity_once_settled() {
        // Only the 16 kHz band is driven; at 22.05 kHz it must contribute
        // exactly nothing (identity coefficients), so once the crossfade has
        // settled the samples pass through bit-exactly.
        let mut eq = Equalizer::new(1, 22_050.0);
        eq.set_enabled(true);
        eq.set_band_gain(EQ_BANDS - 1, 12.0, 22_050.0).unwrap();

        let mut settle = vec![0.0; EQ_SMOOTH_SAMPLES as usize + 8];
        eq.process(&mut settle);

        let input = (0..512)
            .map(|sample| ((sample as f64) * 0.113).cos() * 0.25)
            .collect::<Vec<_>>();
        let mut output = input.clone();
        eq.process(&mut output);

        for (produced, expected) in output.iter().zip(&input) {
            assert_eq!(produced.to_bits(), expected.to_bits());
        }
    }

    #[test]
    fn nyquist_guard_boundary_designs_strictly_below_and_bypasses_at_and_above() {
        // Exactly at Nyquist (fs = 32 kHz, 16 kHz band) the double pole sits
        // on the unit circle, so the guard must include equality.
        let at_nyquist = BiquadSection::peaking_eq(16_000.0, 12.0, Equalizer::Q, 32_000.0);
        assert_eq!(at_nyquist.b0, 1.0);
        assert_eq!(at_nyquist.b1, 0.0);
        assert_eq!(at_nyquist.a2, 0.0);

        let below_nyquist = BiquadSection::peaking_eq(16_000.0, 12.0, Equalizer::Q, 32_001.0);
        assert!(
            below_nyquist.b0 != 1.0,
            "band strictly below Nyquist must still be designed"
        );
        assert_section_is_strictly_stable(&below_nyquist, "16 kHz at fs 32001");

        // A non-finite or non-positive sample rate cannot construct an
        // unstable section either.
        for sample_rate in [f64::NAN, 0.0, -48_000.0] {
            let guarded = BiquadSection::peaking_eq(16_000.0, 12.0, Equalizer::Q, sample_rate);
            assert_eq!(guarded.b0, 1.0);
            assert_eq!(guarded.a2, 0.0);
        }
    }

    impl Equalizer {
        fn process_sample_by_sample_for_test(&mut self, buffer: &mut [f64]) {
            let frames = buffer.len() / self.channels;
            for frame in 0..frames {
                for ch in 0..self.channels {
                    let idx = frame * self.channels + ch;
                    buffer[idx] = self.process_sample_no_counter_update(buffer[idx], ch);
                }
            }
        }
    }
}
