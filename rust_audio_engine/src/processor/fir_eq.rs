//! FIR EQ: Generates impulse response from frequency response specification
//!
//! This module creates linear-phase FIR filters from band gain specifications.
//! The generated IR is used with FFTConvolver for efficient convolution.

use realfft::num_complex::Complex;

use super::fir_design::{minimum_phase_from_log_magnitude, FirFftPlans};
use super::lockfree_params::{sanitized, EQ_BAND_GAIN_DB_MAX, EQ_BAND_GAIN_DB_MIN};
use std::f64::consts::PI;

/// Standard 10-band EQ frequencies (ISO octave bands)
///
/// Supported as the default band layout for [`FirEq`]; nothing in this crate
/// consumes it, but a consuming application needs it to build the gain list
/// [`FirEq::set_bands`] expects.
pub const STANDARD_BANDS: [(f64, f64); 10] = [
    (31.0, 0.0),    // 31 Hz
    (62.0, 0.0),    // 62 Hz
    (125.0, 0.0),   // 125 Hz
    (250.0, 0.0),   // 250 Hz
    (500.0, 0.0),   // 500 Hz
    (1000.0, 0.0),  // 1 kHz
    (2000.0, 0.0),  // 2 kHz
    (4000.0, 0.0),  // 4 kHz
    (8000.0, 0.0),  // 8 kHz
    (16000.0, 0.0), // 16 kHz
];

/// Phase mode for FIR EQ
///
/// Supported as part of the [`FirEq`] surface.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum FirPhaseMode {
    /// Linear phase: symmetric IR with half-tap latency.
    #[default]
    Linear,
    /// Minimum phase: zero added latency, non-linear phase.
    Minimum,
}

/// FIR EQ generator: creates IR from band gain specifications
///
/// Supported, but not used by any other type in this crate. It exists for a
/// consuming application that wants linear- or minimum-phase EQ applied through
/// [`FFTConvolver`](super::FFTConvolver); the output chain's own EQ stage is the
/// IIR [`Equalizer`](super::Equalizer) and does not use this type.
pub struct FirEq {
    /// Number of FIR taps (must be odd for linear phase)
    num_taps: usize,
    /// Sample rate
    sample_rate: f64,
    /// Band gains: (freq_hz, gain_db) pairs, sorted by frequency
    bands: [(f64, f64); 10],
    /// Phase mode
    phase_mode: FirPhaseMode,
    /// Cached IR (regenerated when bands change)
    cached_ir: Vec<f64>,
    /// Reused FFT plans.
    ///
    /// `regenerate_ir` runs on every `set_band` / `set_bands` / `set_sample_rate`
    /// / `set_num_taps` / `set_phase_mode`, i.e. once per EQ slider movement, not
    /// just at construction. Rebuilding a planner each time dominated that cost.
    plans: FirFftPlans,
}

impl FirEq {
    /// Create a new FIR EQ generator
    ///
    /// # Arguments
    /// * `sample_rate` - Audio sample rate in Hz
    /// * `num_taps` - Number of FIR taps (must be odd, will be forced to odd if even)
    ///
    /// A one-tap filter is a pure scalar using the requested gain at the
    /// existing 1 kHz reference. Consequently a flat 0 dB curve produces the
    /// unit impulse `[1.0]`; a non-uniform curve cannot retain its shape with a
    /// single coefficient and collapses to that reference gain.
    pub fn new(sample_rate: f64, num_taps: usize) -> Self {
        // Ensure odd number of taps for symmetric IR
        let num_taps = if num_taps.is_multiple_of(2) {
            num_taps + 1
        } else {
            num_taps
        };

        let mut fir_eq = Self {
            num_taps,
            sample_rate,
            bands: STANDARD_BANDS,
            phase_mode: FirPhaseMode::Linear,
            cached_ir: Vec::new(),
            plans: FirFftPlans::new(),
        };

        // Generate initial IR
        fir_eq.regenerate_ir();
        fir_eq
    }

    /// Set sample rate (triggers IR regeneration).
    ///
    /// A non-positive or non-finite rate is ignored: it would make every
    /// designed tap `NaN` and there is no valid filter to fall back to.
    pub fn set_sample_rate(&mut self, sr: f64) {
        if !sr.is_finite() || sr <= 0.0 {
            return;
        }
        self.sample_rate = sr;
        self.regenerate_ir();
    }

    /// Set number of taps (triggers IR regeneration)
    pub fn set_num_taps(&mut self, taps: usize) {
        self.num_taps = if taps.is_multiple_of(2) {
            taps + 1
        } else {
            taps
        };
        self.regenerate_ir();
    }

    /// Set phase mode (triggers IR regeneration)
    pub fn set_phase_mode(&mut self, mode: FirPhaseMode) {
        self.phase_mode = mode;
        self.regenerate_ir();
    }

    /// Update a band gain (triggers IR regeneration)
    ///
    /// # Arguments
    /// * `band_idx` - Band index (0-9 for standard 10-band EQ)
    /// * `gain_db` - Gain in dB, clamped to the published
    ///   [`EQ_BAND_GAIN_DB_MIN`]..=[`EQ_BAND_GAIN_DB_MAX`] range. A non-finite
    ///   gain is ignored rather than clamped, matching [`Equalizer`].
    ///
    /// [`Equalizer`]: super::eq::Equalizer
    pub fn set_band(&mut self, band_idx: usize, gain_db: f64) {
        let Some(gain_db) = sanitized(gain_db, EQ_BAND_GAIN_DB_MIN, EQ_BAND_GAIN_DB_MAX) else {
            return;
        };
        if band_idx < self.bands.len() {
            self.bands[band_idx].1 = gain_db;
            self.regenerate_ir();
        }
    }

    /// Set all bands at once (single regeneration).
    ///
    /// The whole bank is validated first, so one non-finite entry cannot leave
    /// a partially updated filter behind.
    pub fn set_bands(&mut self, gains_db: &[f64; 10]) {
        let mut validated = [0.0; 10];
        for (slot, &gain) in validated.iter_mut().zip(gains_db.iter()) {
            let Some(gain) = sanitized(gain, EQ_BAND_GAIN_DB_MIN, EQ_BAND_GAIN_DB_MAX) else {
                return;
            };
            *slot = gain;
        }
        for (band, gain) in self.bands.iter_mut().zip(validated) {
            band.1 = gain;
        }
        self.regenerate_ir();
    }

    /// Get current band gains
    pub fn get_bands(&self) -> [(f64, f64); 10] {
        self.bands
    }

    /// Get current IR (interleaved for all channels)
    /// Returns IR repeated for each channel
    pub fn get_ir(&self, channels: usize) -> Vec<f64> {
        let mut ir = Vec::with_capacity(self.cached_ir.len() * channels);
        for &sample in &self.cached_ir {
            for _ in 0..channels {
                ir.push(sample);
            }
        }
        ir
    }

    /// Get IR length (per channel)
    pub fn ir_length(&self) -> usize {
        self.cached_ir.len()
    }

    /// Get number of taps
    pub fn num_taps(&self) -> usize {
        self.num_taps
    }

    /// Regenerate IR from current band settings
    fn regenerate_ir(&mut self) {
        if self.num_taps == 1 {
            self.cached_ir = vec![10.0_f64.powf(self.interpolate_gain(1000.0) / 20.0)];
            return;
        }

        match self.phase_mode {
            FirPhaseMode::Linear => self.generate_linear_phase_ir(),
            FirPhaseMode::Minimum => self.generate_minimum_phase_ir(),
        }
    }

    /// Generate linear-phase FIR IR using frequency sampling method
    fn generate_linear_phase_ir(&mut self) {
        let num_taps = self.num_taps;
        let sr = self.sample_rate;

        // FFT size must be at least 2x num_taps for linear convolution
        let mut fft_size = 1;
        while fft_size < num_taps * 2 {
            fft_size <<= 1;
        }

        // 1. Build desired frequency response magnitude at each FFT bin
        let num_bins = fft_size / 2 + 1;
        let mut magnitude = vec![1.0f64; num_bins];

        for (bin, mag) in magnitude.iter_mut().enumerate() {
            let freq = bin as f64 * sr / fft_size as f64;
            *mag = self.interpolate_gain(freq);
        }

        // 2. Convert dB magnitude to linear
        let linear_mag: Vec<f64> = magnitude
            .iter()
            .map(|&db| 10.0_f64.powf(db / 20.0))
            .collect();

        // 3. Inverse-transform the half-spectrum directly. A real inverse
        //    transform implies the Hermitian symmetry that the previous complex
        //    formulation had to write out by hand, so the negative-frequency
        //    half must *not* be populated here. `realfft` also requires the DC
        //    and Nyquist bins to be purely real, which they are by construction.
        let ifft = self.plans.real_inverse(fft_size);
        let mut spectrum = ifft.make_input_vec();
        for (bin, &magnitude) in spectrum.iter_mut().zip(linear_mag.iter()) {
            *bin = Complex::new(magnitude, 0.0);
        }

        // 4. IFFT to get the ideal IR
        let mut time_domain = ifft.make_output_vec();
        let mut scratch = ifft.make_scratch_vec();
        // Setup-time transform over correctly sized buffers; the length
        // invariants cannot fail here.
        debug_assert_eq!(spectrum.len(), fft_size / 2 + 1);
        debug_assert_eq!(time_domain.len(), fft_size);
        let _ = ifft.process_with_scratch(&mut spectrum, &mut time_domain, &mut scratch);

        // 5. Extract center num_taps samples (circular shift to make causal)
        let half = num_taps / 2;
        let mut ir_mono: Vec<f64> = (0..num_taps)
            .map(|i| {
                let idx = (i + fft_size - half) % fft_size;
                time_domain[idx] / fft_size as f64
            })
            .collect();

        // 6. Apply Hann window to reduce Gibbs phenomenon
        for (i, sample) in ir_mono.iter_mut().enumerate() {
            let w = 0.5 * (1.0 - (2.0 * PI * i as f64 / (num_taps - 1) as f64).cos());
            *sample *= w;
        }

        self.cached_ir = ir_mono;
    }

    /// Generate minimum-phase FIR IR
    /// Uses cepstral method: log|H(w)| -> IFFT -> cosine transform -> FFT -> exp -> IFFT
    fn generate_minimum_phase_ir(&mut self) {
        let num_taps = self.num_taps;
        let sr = self.sample_rate;

        // FFT size
        let mut fft_size = 1;
        while fft_size < num_taps * 4 {
            fft_size <<= 1;
        }

        let num_bins = fft_size / 2 + 1;

        // 1. Build desired magnitude response
        let mut log_mag = vec![0.0f64; fft_size];
        for bin in 0..num_bins {
            let freq = bin as f64 * sr / fft_size as f64;
            let gain_db = self.interpolate_gain(freq);
            log_mag[bin] = gain_db / 20.0 * std::f64::consts::LN_10; // Convert to natural log
            if bin > 0 && bin < fft_size / 2 {
                log_mag[fft_size - bin] = log_mag[bin];
            }
        }

        // 2-7. Apply the shared real-cepstrum spectral factorization.
        let mut ir_mono = minimum_phase_from_log_magnitude(&log_mag, num_taps, &mut self.plans);

        // 8. Apply a raised-cosine tail window. The causal half remains at
        // unity, then the tail monotonically fades to zero at the final tap.
        for (i, sample) in ir_mono.iter_mut().enumerate() {
            *sample *= minimum_phase_tail_weight(i, num_taps);
        }

        self.cached_ir = ir_mono;
    }

    /// Log-frequency interpolation of gain across EQ bands
    fn interpolate_gain(&self, freq_hz: f64) -> f64 {
        if freq_hz <= 0.0 {
            return self.bands[0].1;
        }

        // Find surrounding bands
        for i in 0..self.bands.len() - 1 {
            let (f0, g0) = self.bands[i];
            let (f1, g1) = self.bands[i + 1];

            if freq_hz >= f0 && freq_hz <= f1 {
                // Linear interpolation in log-frequency space
                let log_f0 = f0.log2();
                let log_f1 = f1.log2();
                let log_freq = freq_hz.log2();

                if (log_f1 - log_f0).abs() < 1e-10 {
                    return g0;
                }

                let t = (log_freq - log_f0) / (log_f1 - log_f0);
                return g0 + (g1 - g0) * t;
            }
        }

        // Extrapolate from nearest band
        if freq_hz < self.bands[0].0 {
            return self.bands[0].1;
        }
        self.bands[self.bands.len() - 1].1
    }
}

fn minimum_phase_tail_weight(index: usize, num_taps: usize) -> f64 {
    if num_taps <= 1 {
        return 1.0;
    }

    let midpoint = num_taps / 2;
    if index <= midpoint {
        return 1.0;
    }

    let tail_length = num_taps - 1 - midpoint;
    if tail_length == 0 {
        return 1.0;
    }
    let progress = (index - midpoint) as f64 / tail_length as f64;
    0.5 * (1.0 + (PI * progress).cos())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reference implementation of the linear-phase IR using a full complex
    /// inverse FFT with the Hermitian half written out by hand — the formulation
    /// this module used before moving to `realfft`.
    ///
    /// Deliberately built on `rustfft` so it stays an independent oracle: if it
    /// used `realfft` too it would only confirm itself.
    fn legacy_linear_phase_ir(fir: &FirEq, num_taps: usize) -> Vec<f64> {
        use rustfft::{num_complex::Complex as C, FftPlanner};

        let mut fft_size = 1;
        while fft_size < num_taps * 2 {
            fft_size <<= 1;
        }
        let num_bins = fft_size / 2 + 1;

        let linear_mag: Vec<f64> = (0..num_bins)
            .map(|bin| {
                let freq = bin as f64 * fir.sample_rate / fft_size as f64;
                10.0_f64.powf(fir.interpolate_gain(freq) / 20.0)
            })
            .collect();

        let mut spectrum = vec![C::new(0.0, 0.0); fft_size];
        for k in 0..linear_mag.len() {
            spectrum[k] = C::new(linear_mag[k], 0.0);
            if k > 0 && k < fft_size / 2 {
                spectrum[fft_size - k] = C::new(linear_mag[k], 0.0);
            }
        }

        let mut planner = FftPlanner::new();
        planner.plan_fft_inverse(fft_size).process(&mut spectrum);

        let half = num_taps / 2;
        let mut ir: Vec<f64> = (0..num_taps)
            .map(|i| {
                let idx = (i + fft_size - half) % fft_size;
                spectrum[idx].re / fft_size as f64
            })
            .collect();
        for (i, sample) in ir.iter_mut().enumerate() {
            let w = 0.5 * (1.0 - (2.0 * PI * i as f64 / (num_taps - 1) as f64).cos());
            *sample *= w;
        }
        ir
    }

    /// The real inverse transform must reproduce the hand-mirrored complex
    /// formulation. A real IFFT implies Hermitian symmetry, so this also guards
    /// against the negative-frequency half being populated by mistake, which
    /// would double every tap.
    ///
    /// Agreement is at float-rounding level rather than bit-exact, because the
    /// two transforms fold the same sums in a different order. The tolerance is
    /// relative to the peak tap and sits ~5 orders of magnitude above the
    /// observed error (~1e-16 relative), following the rounding-tolerance
    /// precedent used for the convolver tail assertions.
    #[test]
    fn linear_phase_ir_matches_complex_reference_formulation() {
        for num_taps in [63usize, 255, 511, 1023] {
            for gains in [
                [0.0; 10],
                [6.0, -6.0, 3.0, -3.0, 9.0, -9.0, 1.5, -1.5, 4.5, -4.5],
                [-12.0, 12.0, 0.0, 0.0, -6.0, 6.0, 0.0, 0.0, 3.0, -3.0],
            ] {
                let mut fir = FirEq::new(48_000.0, num_taps);
                fir.set_bands(&gains);

                let actual = fir.get_ir(1);
                let expected = legacy_linear_phase_ir(&fir, num_taps);
                assert_eq!(actual.len(), expected.len());

                let peak = expected.iter().fold(0.0f64, |acc, t| acc.max(t.abs()));
                assert!(peak > 0.0, "reference IR must not be all zeros");
                let tolerance = peak * 1e-11;

                for (tap, (got, want)) in actual.iter().zip(&expected).enumerate() {
                    assert!(
                        (got - want).abs() <= tolerance,
                        "taps={num_taps} gains={gains:?} tap {tap}: {got} vs {want} \
                         (diff {:.3e} > tol {:.3e})",
                        (got - want).abs(),
                        tolerance
                    );
                }
            }
        }
    }

    /// Reusing a cached FFT plan must be a pure performance change, so a
    /// repeatedly-regenerated `FirEq` has to agree *bit for bit* with a freshly
    /// constructed one. A plan is a read-only object, so any difference here
    /// would mean the refactor changed transform geometry rather than that
    /// caching is lossy — hence exact equality, not a tolerance.
    #[test]
    fn repeated_regeneration_is_bit_identical_to_a_fresh_instance() {
        for taps in [1usize, 63, 255, 511] {
            for mode in [FirPhaseMode::Linear, FirPhaseMode::Minimum] {
                let gain_sequence = [
                    [0.0; 10],
                    [6.0, -6.0, 3.0, -3.0, 9.0, -9.0, 1.5, -1.5, 4.5, -4.5],
                    [-12.0, 12.0, 0.0, 0.0, -6.0, 6.0, 0.0, 0.0, 3.0, -3.0],
                ];

                // Drive one instance through every state, exercising the cache.
                let mut reused = FirEq::new(48_000.0, taps);
                reused.set_phase_mode(mode);
                for gains in &gain_sequence {
                    reused.set_bands(gains);
                }
                // Also cross a sample-rate change and a tap-count change, both of
                // which alter the transform size and so add cache entries.
                reused.set_sample_rate(44_100.0);
                reused.set_sample_rate(48_000.0);
                let final_gains = gain_sequence[gain_sequence.len() - 1];

                // A pristine instance placed directly in that final state.
                let mut fresh = FirEq::new(48_000.0, taps);
                fresh.set_phase_mode(mode);
                fresh.set_bands(&final_gains);

                assert_eq!(
                    reused.get_ir(1),
                    fresh.get_ir(1),
                    "taps={taps} mode={mode:?}: cached plans changed the IR"
                );
                assert_eq!(reused.ir_length(), fresh.ir_length());
            }
        }
    }

    /// A cache keyed by transform size must return the right plan when several
    /// sizes are interleaved, not merely the most recent one.
    #[test]
    fn interleaved_tap_counts_do_not_cross_contaminate_cached_plans() {
        let gains = [6.0, -6.0, 3.0, -3.0, 9.0, -9.0, 1.5, -1.5, 4.5, -4.5];
        for mode in [FirPhaseMode::Linear, FirPhaseMode::Minimum] {
            let reference: Vec<Vec<f64>> = [63usize, 255, 511]
                .iter()
                .map(|&taps| {
                    let mut eq = FirEq::new(48_000.0, taps);
                    eq.set_phase_mode(mode);
                    eq.set_bands(&gains);
                    eq.get_ir(1)
                })
                .collect();

            // One instance cycling between sizes, twice, so every lookup after
            // the first is a cache hit against a populated cache.
            let mut eq = FirEq::new(48_000.0, 63);
            eq.set_phase_mode(mode);
            eq.set_bands(&gains);
            for _ in 0..2 {
                for (index, &taps) in [63usize, 255, 511].iter().enumerate() {
                    eq.set_num_taps(taps);
                    assert_eq!(
                        eq.get_ir(1),
                        reference[index],
                        "mode={mode:?} taps={taps}: wrong cached plan was reused"
                    );
                }
            }
        }
    }

    /// A non-finite gain or rate designs an all-`NaN` impulse response, which
    /// then silences or poisons every convolution using it.
    #[test]
    fn fir_eq_setters_drop_non_finite_writes() {
        let mut fir = FirEq::new(48_000.0, 255);
        fir.set_band(0, 6.0);
        let bands = fir.get_bands();
        let ir = fir.get_ir(1);

        for poison in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            fir.set_sample_rate(poison);
            fir.set_band(0, poison);
            fir.set_bands(&[poison; 10]);

            assert_eq!(fir.sample_rate, 48_000.0, "rate survived {poison}");
            assert_eq!(fir.get_bands(), bands, "bands survived {poison}");
            assert_eq!(fir.get_ir(1), ir, "IR survived {poison}");
        }

        assert!(fir.get_ir(1).iter().all(|tap| tap.is_finite()));
    }

    /// One non-finite entry must not leave a partially updated bank behind.
    #[test]
    fn fir_eq_set_bands_is_all_or_nothing() {
        let mut fir = FirEq::new(48_000.0, 255);
        let mut gains = [0.0; 10];
        gains[0] = 3.0;
        gains[9] = f64::NAN;

        fir.set_bands(&gains);

        assert_eq!(fir.get_bands()[0].1, 0.0, "no band may be applied");
    }

    fn measured_gain_db(ir: &[f64], frequency_hz: f64, sample_rate: f64) -> f64 {
        let omega = 2.0 * PI * frequency_hz / sample_rate;
        let (real, imaginary) =
            ir.iter()
                .enumerate()
                .fold((0.0, 0.0), |(real, imaginary), (index, sample)| {
                    let phase = omega * index as f64;
                    (
                        real + sample * phase.cos(),
                        imaginary - sample * phase.sin(),
                    )
                });
        20.0 * real.hypot(imaginary).log10()
    }

    fn energy_centroid(ir: &[f64]) -> f64 {
        let total = ir.iter().map(|sample| sample * sample).sum::<f64>();
        ir.iter()
            .enumerate()
            .map(|(index, sample)| index as f64 * sample * sample)
            .sum::<f64>()
            / total
    }

    #[test]
    fn test_fir_eq_flat() {
        // Flat response (all bands at 0 dB) should produce near-unity impulse
        let fir = FirEq::new(44100.0, 1023);
        let ir = fir.get_ir(2);
        assert!(!ir.is_empty());

        // Sum should be approximately 1.0 for unity gain
        let sum: f64 = fir.cached_ir.iter().sum();
        assert!(
            (sum - 1.0).abs() < 0.1,
            "Flat IR sum should be ~1.0, got {}",
            sum
        );
    }

    #[test]
    fn test_fir_eq_bass_boost() {
        let mut fir = FirEq::new(44100.0, 1023);
        fir.set_band(0, 6.0); // Boost 31 Hz by 6 dB

        // IR should still be generated without error
        let ir = fir.get_ir(2);
        assert!(!ir.is_empty());

        // Sum should be larger due to bass boost
        let sum: f64 = fir.cached_ir.iter().sum();
        assert!(sum > 1.0, "Bass boost IR sum should be > 1.0, got {}", sum);
    }

    #[test]
    fn test_interpolate_gain() {
        let fir = FirEq::new(44100.0, 1023);

        // Test interpolation between bands
        let gain_750 = fir.interpolate_gain(750.0);
        let gain_500 = fir.interpolate_gain(500.0); // 0 dB (standard band)
        let gain_1000 = fir.interpolate_gain(1000.0); // 0 dB (standard band)
        assert!((gain_500 - 0.0).abs() < 0.01);
        assert!((gain_1000 - 0.0).abs() < 0.01);

        // At 750 Hz (between 500 and 1000, both 0 dB), should be 0 dB
        assert!(
            (gain_750 - 0.0).abs() < 0.01,
            "Gain at 750 Hz should be ~0 dB"
        );
    }

    #[test]
    fn test_minimum_phase_flat() {
        // Flat response in minimum phase mode should also produce near-unity sum
        let mut fir = FirEq::new(44100.0, 1023);
        fir.set_phase_mode(FirPhaseMode::Minimum);

        let sum: f64 = fir.cached_ir.iter().sum();
        assert!(
            (sum - 1.0).abs() < 0.15,
            "Minimum phase flat IR sum should be ~1.0, got {}",
            sum
        );
    }

    #[test]
    fn test_minimum_phase_boost_bounded() {
        // Defect 7 regression test: with 1/N normalization, a 6 dB bass boost
        // should produce a reasonable IR sum, not one amplified by N.
        let mut fir = FirEq::new(44100.0, 1023);
        fir.set_phase_mode(FirPhaseMode::Minimum);
        fir.set_band(0, 6.0); // Boost 31 Hz by 6 dB

        let sum: f64 = fir.cached_ir.iter().sum();
        // The sum should be in a reasonable range (not blown up by N ~= 4096)
        assert!(
            sum.abs() < 100.0,
            "Minimum phase boosted IR sum should be bounded, got {}",
            sum
        );
        assert!(
            sum > 0.5,
            "Minimum phase boosted IR sum should be positive and > 0.5, got {}",
            sum
        );
    }

    #[test]
    fn one_tap_is_a_finite_reference_gain_for_both_phase_modes() {
        for phase_mode in [FirPhaseMode::Linear, FirPhaseMode::Minimum] {
            for gain_db in [-6.0, 0.0, 6.0] {
                let mut fir = FirEq::new(48_000.0, 1);
                fir.set_phase_mode(phase_mode);
                fir.set_bands(&[gain_db; 10]);

                let expected = 10.0_f64.powf(gain_db / 20.0);
                assert_eq!(fir.cached_ir.len(), 1);
                assert!(fir.cached_ir[0].is_finite());
                assert!(
                    (fir.cached_ir[0] - expected).abs() <= 1.0e-12,
                    "{phase_mode:?} one-tap {gain_db} dB gain was {}, expected {expected}",
                    fir.cached_ir[0]
                );
            }
        }

        let mut fir = FirEq::new(48_000.0, 1);
        let mut nonuniform = [0.0; 10];
        nonuniform[5] = 3.0;
        fir.set_bands(&nonuniform);
        assert!((fir.cached_ir[0] - 10.0_f64.powf(3.0 / 20.0)).abs() <= 1.0e-12);
    }

    #[test]
    fn uniform_gain_is_not_normalized_away() {
        for phase_mode in [FirPhaseMode::Linear, FirPhaseMode::Minimum] {
            for gain_db in [-6.0, 6.0] {
                let mut fir = FirEq::new(48_000.0, 1023);
                fir.set_phase_mode(phase_mode);
                fir.set_bands(&[gain_db; 10]);

                for frequency in [31.0, 1_000.0, 16_000.0] {
                    let measured = measured_gain_db(&fir.cached_ir, frequency, 48_000.0);
                    assert!(
                        (measured - gain_db).abs() <= 1.0e-9,
                        "{phase_mode:?} uniform {gain_db} dB measured {measured} dB at {frequency} Hz"
                    );
                }
            }
        }
    }

    #[test]
    fn minimum_phase_tail_window_fades_in_the_correct_direction() {
        let num_taps = 11;
        let weights = (0..num_taps)
            .map(|index| minimum_phase_tail_weight(index, num_taps))
            .collect::<Vec<_>>();

        assert_eq!(weights[num_taps / 2], 1.0);
        assert!(weights[num_taps / 2 + 1] < 1.0);
        assert!(weights[num_taps / 2 + 1] > 0.0);
        assert!(weights[num_taps - 1].abs() <= f64::EPSILON);
        assert!(weights.windows(2).all(|pair| pair[1] <= pair[0]));
    }

    #[test]
    fn minimum_phase_energy_precedes_linear_phase_energy() {
        let curve = [6.0, 4.0, 2.0, 0.0, -2.0, -3.0, -1.5, 1.0, 3.5, 5.0];
        let mut linear = FirEq::new(48_000.0, 1023);
        linear.set_bands(&curve);
        let mut minimum = FirEq::new(48_000.0, 1023);
        minimum.set_phase_mode(FirPhaseMode::Minimum);
        minimum.set_bands(&curve);

        let linear_centroid = energy_centroid(&linear.cached_ir);
        let minimum_centroid = energy_centroid(&minimum.cached_ir);
        assert!(
            minimum_centroid < linear_centroid * 0.5,
            "minimum-phase centroid {minimum_centroid} was not materially earlier than linear {linear_centroid}"
        );
    }

    #[test]
    fn designed_response_tracks_representative_band_curve() {
        let curve = [6.0, 4.0, 2.0, 0.0, -2.0, -3.0, -1.5, 1.0, 3.5, 5.0];
        for phase_mode in [FirPhaseMode::Linear, FirPhaseMode::Minimum] {
            let mut fir = FirEq::new(48_000.0, 2047);
            fir.set_phase_mode(phase_mode);
            fir.set_bands(&curve);

            for (index, (frequency, _)) in STANDARD_BANDS.iter().enumerate() {
                let measured = measured_gain_db(&fir.cached_ir, *frequency, 48_000.0);
                let expected = curve[index];
                assert!(
                    (measured - expected).abs() <= 1.5,
                    "{phase_mode:?} response at {frequency} Hz was {measured:.3} dB, expected {expected:.3} dB"
                );
            }
        }
    }
}
