//! FFT-based spectrum analyzer for visualization

use realfft::{num_complex::Complex, RealFftPlanner, RealToComplex};
use std::sync::Arc;

use super::traits::{validate_sample_rate_hz, ProcessError};

/// FFT-based spectrum analyzer for visualization
///
/// The analyzed signal is real, so this uses `realfft` rather than a complex
/// transform whose imaginary half would be identically zero. The analyzer only
/// ever reads positive-frequency bins, which is exactly what a real transform
/// produces.
pub struct SpectrumAnalyzer {
    fft_size: usize,
    fft: Arc<dyn RealToComplex<f64>>,
    window: Vec<f64>,
    num_bins: usize,
    /// Windowed time-domain block. `realfft` mutates its input, so this doubles
    /// as scratch.
    fft_input: Vec<f64>,
    /// Half-spectrum output: `fft_size / 2 + 1` bins, DC first, Nyquist last.
    fft_spectrum: Vec<Complex<f64>>,
    // Workspace for `process_with_scratch` (the plain `process` allocates per call).
    fft_scratch: Vec<Complex<f64>>,
    magnitudes: Vec<f64>,
    result: Vec<f32>,
    bin_ranges: Vec<(usize, usize)>,
    bin_sample_rate: Option<u32>,
}

impl SpectrumAnalyzer {
    /// Create an analyzer with the given FFT and output bin geometry.
    ///
    /// Rejects `fft_size < 4` and `num_bins == 0` before planning any FFT.
    pub fn new(fft_size: usize, num_bins: usize) -> Result<Self, ProcessError> {
        if fft_size < 4 {
            return Err(ProcessError::InvalidGeometry {
                processor: "SpectrumAnalyzer",
                operation: "create analyzer",
                message: "FFT size must provide at least one non-DC/non-Nyquist bin",
            });
        }
        if num_bins == 0 {
            return Err(ProcessError::InvalidGeometry {
                processor: "SpectrumAnalyzer",
                operation: "create analyzer",
                message: "output bin count must be greater than zero",
            });
        }
        let mut planner = RealFftPlanner::<f64>::new();
        let fft = planner.plan_fft_forward(fft_size);
        let window: Vec<f64> = (0..fft_size)
            .map(|i| 0.5 * (1.0 - (2.0 * std::f64::consts::PI * i as f64 / fft_size as f64).cos()))
            .collect();

        Ok(Self {
            fft_size,
            window,
            num_bins,
            fft_input: vec![0.0; fft_size],
            fft_spectrum: vec![Complex::new(0.0, 0.0); fft.complex_len()],
            fft_scratch: vec![Complex::new(0.0, 0.0); fft.get_scratch_len()],
            fft,
            magnitudes: vec![0.0; fft_size.saturating_div(2).saturating_sub(1)],
            result: vec![0.0; num_bins],
            bin_ranges: Vec::with_capacity(num_bins),
            bin_sample_rate: None,
        })
    }

    /// Analyze a block of samples and return the binned magnitudes.
    ///
    /// Rejects a zero sample rate before touching cached state; blocks shorter
    /// than the FFT size produce a zero-filled result.
    pub fn analyze(&mut self, samples: &[f64], sample_rate: u32) -> Result<&[f32], ProcessError> {
        validate_sample_rate_hz("SpectrumAnalyzer", sample_rate)?;
        if samples.len() < self.fft_size {
            self.result.fill(0.0);
            return Ok(&self.result);
        }

        for ((slot, &sample), &window) in self
            .fft_input
            .iter_mut()
            .zip(samples.iter().take(self.fft_size))
            .zip(&self.window)
        {
            *slot = sample * window;
        }

        // Buffer lengths are fixed at construction to exactly what the plan
        // requires, so these length checks cannot fail; a violated invariant
        // would be a bug in this module. Leave the previous spectrum in place
        // rather than panicking.
        debug_assert_eq!(self.fft_input.len(), self.fft_size);
        debug_assert_eq!(self.fft_spectrum.len(), self.fft.complex_len());
        let _ = self.fft.process_with_scratch(
            &mut self.fft_input,
            &mut self.fft_spectrum,
            &mut self.fft_scratch,
        );

        // Skip DC and stop below Nyquist, preserving the original bin
        // selection. The half-spectrum is `fft_size / 2 + 1` long, so
        // `1..fft_size / 2` addresses exactly the frequencies the complex
        // transform did.
        for (dst, c) in self
            .magnitudes
            .iter_mut()
            .zip(self.fft_spectrum[1..self.fft_size / 2].iter())
        {
            *dst = c.norm() / self.fft_size as f64;
        }

        self.ensure_bin_ranges(sample_rate);
        self.log_bin();
        Ok(&self.result)
    }

    fn ensure_bin_ranges(&mut self, sample_rate: u32) {
        if self.bin_sample_rate == Some(sample_rate) && self.bin_ranges.len() == self.num_bins {
            return;
        }

        let nyquist = sample_rate as f64 / 2.0;
        let min_freq = 20.0f64;
        let max_freq = nyquist;
        let log_min = min_freq.log10();
        let log_max = max_freq.log10();
        let freq_per_bin = nyquist / self.magnitudes.len().max(1) as f64;

        self.bin_ranges.clear();
        for bin_idx in 0..self.num_bins {
            let freq_low = 10.0_f64
                .powf(log_min + (log_max - log_min) * bin_idx as f64 / self.num_bins as f64);
            let freq_high = 10.0_f64
                .powf(log_min + (log_max - log_min) * (bin_idx + 1) as f64 / self.num_bins as f64);
            let idx_low = ((freq_low / freq_per_bin) as usize)
                .clamp(0, self.magnitudes.len().saturating_sub(1));
            let idx_high =
                ((freq_high / freq_per_bin) as usize).clamp(idx_low + 1, self.magnitudes.len());
            self.bin_ranges.push((idx_low, idx_high));
        }
        self.bin_sample_rate = Some(sample_rate);
    }

    fn log_bin(&mut self) {
        self.result.fill(0.0);
        for (result_val, &(idx_low, idx_high)) in self.result.iter_mut().zip(&self.bin_ranges) {
            if idx_high > idx_low {
                let sum: f64 = self.magnitudes[idx_low..idx_high]
                    .iter()
                    .map(|m| m * m)
                    .sum();
                let rms = (sum / (idx_high - idx_low) as f64).sqrt();
                let db = 20.0 * (rms + 1e-9).log10();
                *result_val = ((db + 90.0) / 90.0).clamp(0.0, 1.0) as f32;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // The reference implementation below is deliberately kept on rustfft's
    // complex transform: it is the oracle that pins the realfft migration, so
    // rewriting it with realfft would make it self-confirming.
    use rustfft::num_complex::Complex as OracleComplex;
    use rustfft::FftPlanner;

    #[test]
    fn constructor_rejects_empty_magnitude_and_output_domains() {
        for fft_size in 0..4 {
            assert!(matches!(
                SpectrumAnalyzer::new(fft_size, 4),
                Err(ProcessError::InvalidGeometry {
                    processor: "SpectrumAnalyzer",
                    operation: "create analyzer",
                    ..
                })
            ));
        }
        assert!(matches!(
            SpectrumAnalyzer::new(4, 0),
            Err(ProcessError::InvalidGeometry {
                processor: "SpectrumAnalyzer",
                operation: "create analyzer",
                ..
            })
        ));
    }

    #[test]
    fn zero_sample_rate_rejection_preserves_cached_fft_and_bins() {
        let mut analyzer = SpectrumAnalyzer::new(16, 4).unwrap();
        let samples: Vec<f64> = (0..16).map(|index| (index as f64 * 0.1).sin()).collect();
        analyzer.analyze(&samples, 48_000).unwrap();
        let fft_input = analyzer.fft_input.clone();
        let fft_spectrum = analyzer.fft_spectrum.clone();
        let fft_scratch = analyzer.fft_scratch.clone();
        let magnitudes = analyzer.magnitudes.clone();
        let result = analyzer.result.clone();
        let bin_ranges = analyzer.bin_ranges.clone();
        let bin_sample_rate = analyzer.bin_sample_rate;

        assert_no_alloc::assert_no_alloc(|| {
            assert!(matches!(
                analyzer.analyze(&samples, 0),
                Err(ProcessError::InvalidSampleRate {
                    processor: "SpectrumAnalyzer",
                    sample_rate_hz: 0,
                })
            ));
        });

        assert_eq!(analyzer.fft_input, fft_input);
        assert_eq!(analyzer.fft_spectrum, fft_spectrum);
        assert_eq!(analyzer.fft_scratch, fft_scratch);
        assert_eq!(analyzer.magnitudes, magnitudes);
        assert_eq!(analyzer.result, result);
        assert_eq!(analyzer.bin_ranges, bin_ranges);
        assert_eq!(analyzer.bin_sample_rate, bin_sample_rate);
    }

    #[test]
    fn short_input_returns_reused_zero_bins() {
        let mut analyzer = SpectrumAnalyzer::new(16, 4).unwrap();
        let first_ptr = analyzer.analyze(&[0.0; 8], 48_000).unwrap().as_ptr();
        assert_eq!(analyzer.analyze(&[0.0; 8], 48_000).unwrap(), &[0.0; 4]);
        assert_eq!(
            analyzer.analyze(&[0.0; 8], 48_000).unwrap().as_ptr(),
            first_ptr
        );
    }

    #[test]
    fn analyze_reuses_result_and_recomputes_ranges_on_sample_rate_change() {
        let mut analyzer = SpectrumAnalyzer::new(64, 8).unwrap();
        let samples: Vec<f64> = (0..64).map(|i| (i as f64 * 0.1).sin()).collect();

        let first_ptr = analyzer.analyze(&samples, 48_000).unwrap().as_ptr();
        let first_ranges = analyzer.bin_ranges.clone();
        assert!(analyzer
            .analyze(&samples, 48_000)
            .unwrap()
            .iter()
            .any(|&v| v > 0.0));
        assert_eq!(
            analyzer.analyze(&samples, 48_000).unwrap().as_ptr(),
            first_ptr
        );
        assert_eq!(analyzer.bin_ranges, first_ranges);

        analyzer.analyze(&samples, 96_000).unwrap();
        assert_ne!(analyzer.bin_ranges, first_ranges);
    }

    #[test]
    fn analyzer_output_matches_legacy_allocation_path() {
        let mut analyzer = SpectrumAnalyzer::new(128, 16).unwrap();
        let samples: Vec<f64> = (0..128)
            .map(|i| {
                let t = i as f64 / 48_000.0;
                (2.0 * std::f64::consts::PI * 997.0 * t).sin() * 0.4
            })
            .collect();

        let actual = analyzer.analyze(&samples, 48_000).unwrap().to_vec();
        let expected = legacy_analyze(&samples, 128, 16, 48_000);

        for (idx, (actual, expected)) in actual.iter().zip(expected.iter()).enumerate() {
            assert!(
                (actual - expected).abs() <= 1e-6,
                "bin {idx}: actual={actual}, expected={expected}"
            );
        }
    }

    fn legacy_analyze(
        samples: &[f64],
        fft_size: usize,
        num_bins: usize,
        sample_rate: u32,
    ) -> Vec<f32> {
        if samples.len() < fft_size {
            return vec![0.0; num_bins];
        }

        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(fft_size);
        let window: Vec<f64> = (0..fft_size)
            .map(|i| 0.5 * (1.0 - (2.0 * std::f64::consts::PI * i as f64 / fft_size as f64).cos()))
            .collect();
        let mut buffer: Vec<OracleComplex<f64>> = samples[..fft_size]
            .iter()
            .zip(&window)
            .map(|(&s, &w)| OracleComplex::new(s * w, 0.0))
            .collect();

        fft.process(&mut buffer);
        let magnitudes: Vec<f64> = buffer[1..fft_size / 2]
            .iter()
            .map(|c| c.norm() / fft_size as f64)
            .collect();
        legacy_log_bin(&magnitudes, sample_rate, num_bins)
    }

    fn legacy_log_bin(magnitudes: &[f64], sample_rate: u32, num_bins: usize) -> Vec<f32> {
        let mut result = vec![0.0f32; num_bins];
        let nyquist = sample_rate as f64 / 2.0;
        let min_freq = 20.0f64;
        let max_freq = nyquist;
        let log_min = min_freq.log10();
        let log_max = max_freq.log10();

        for (bin_idx, result_val) in result.iter_mut().enumerate() {
            let freq_low =
                10.0_f64.powf(log_min + (log_max - log_min) * bin_idx as f64 / num_bins as f64);
            let freq_high = 10.0_f64
                .powf(log_min + (log_max - log_min) * (bin_idx + 1) as f64 / num_bins as f64);
            let freq_per_bin = nyquist / magnitudes.len() as f64;
            let idx_low =
                ((freq_low / freq_per_bin) as usize).clamp(0, magnitudes.len().saturating_sub(1));
            let idx_high =
                ((freq_high / freq_per_bin) as usize).clamp(idx_low + 1, magnitudes.len());

            if idx_high > idx_low {
                let sum: f64 = magnitudes[idx_low..idx_high].iter().map(|m| m * m).sum();
                let rms = (sum / (idx_high - idx_low) as f64).sqrt();
                let db = 20.0 * (rms + 1e-9).log10();
                *result_val = ((db + 90.0) / 90.0).clamp(0.0, 1.0) as f32;
            }
        }

        result
    }
}
