//! FIR EQ: Generates impulse response from frequency response specification
//!
//! This module creates linear-phase FIR filters from band gain specifications.
//! The generated IR is used with FFTConvolver for efficient convolution.

use rustfft::{FftPlanner, num_complex::Complex};
use std::f64::consts::PI;

/// Standard 10-band EQ frequencies (ISO octave bands)
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
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum FirPhaseMode {
    #[default]
    Linear,     // Linear phase (symmetric IR, half-tap latency)
    Minimum,    // Minimum phase (zero latency, non-linear phase)
}

/// FIR EQ generator: creates IR from band gain specifications
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
}

impl FirEq {
    /// Create a new FIR EQ generator
    /// 
    /// # Arguments
    /// * `sample_rate` - Audio sample rate in Hz
    /// * `num_taps` - Number of FIR taps (must be odd, will be forced to odd if even)
    pub fn new(sample_rate: f64, num_taps: usize) -> Self {
        // Ensure odd number of taps for symmetric IR
        let num_taps = if num_taps % 2 == 0 { num_taps + 1 } else { num_taps };
        
        let mut fir_eq = Self {
            num_taps,
            sample_rate,
            bands: STANDARD_BANDS,
            phase_mode: FirPhaseMode::Linear,
            cached_ir: Vec::new(),
        };
        
        // Generate initial IR
        fir_eq.regenerate_ir();
        fir_eq
    }
    
    /// Set sample rate (triggers IR regeneration)
    pub fn set_sample_rate(&mut self, sr: f64) {
        self.sample_rate = sr;
        self.regenerate_ir();
    }
    
    /// Set number of taps (triggers IR regeneration)
    pub fn set_num_taps(&mut self, taps: usize) {
        self.num_taps = if taps % 2 == 0 { taps + 1 } else { taps };
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
    /// * `gain_db` - Gain in dB (-15 to +15)
    pub fn set_band(&mut self, band_idx: usize, gain_db: f64) {
        if band_idx < self.bands.len() {
            self.bands[band_idx].1 = gain_db.clamp(-15.0, 15.0);
            self.regenerate_ir();
        }
    }
    
    /// Set all bands at once (single regeneration)
    pub fn set_bands(&mut self, gains_db: &[f64; 10]) {
        for (i, &gain) in gains_db.iter().enumerate() {
            self.bands[i].1 = gain.clamp(-15.0, 15.0);
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
        
        for bin in 0..num_bins {
            let freq = bin as f64 * sr / fft_size as f64;
            magnitude[bin] = self.interpolate_gain(freq);
        }
        
        // 2. Convert dB magnitude to linear
        let linear_mag: Vec<f64> = magnitude.iter()
            .map(|&db| 10.0_f64.powf(db / 20.0))
            .collect();
        
        // 3. Build symmetric frequency response (Hermitian symmetry for real output)
        let mut spectrum = vec![Complex::new(0.0, 0.0); fft_size];
        for k in 0..linear_mag.len() {
            spectrum[k] = Complex::new(linear_mag[k], 0.0);
            if k > 0 && k < fft_size / 2 {
                spectrum[fft_size - k] = Complex::new(linear_mag[k], 0.0);
            }
        }
        
        // 4. IFFT to get the ideal IR
        let mut planner = FftPlanner::new();
        let ifft = planner.plan_fft_inverse(fft_size);
        ifft.process(&mut spectrum);
        
        // 5. Extract center num_taps samples (circular shift to make causal)
        let half = num_taps / 2;
        let mut ir_mono: Vec<f64> = (0..num_taps)
            .map(|i| {
                let idx = (i + fft_size - half) % fft_size;
                spectrum[idx].re / fft_size as f64
            })
            .collect();
        
        // 6. Apply Hann window to reduce Gibbs phenomenon
        for (i, sample) in ir_mono.iter_mut().enumerate() {
            let w = 0.5 * (1.0 - (2.0 * PI * i as f64 / (num_taps - 1) as f64).cos());
            *sample *= w;
        }
        
        // 7. Normalize to preserve overall gain (0 dB at 1 kHz reference)
        let ref_gain = self.interpolate_gain(1000.0);
        let norm_factor = 10.0_f64.powf(-ref_gain / 20.0);
        for sample in ir_mono.iter_mut() {
            *sample *= norm_factor;
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
        
        // 2. IFFT of log magnitude to get cepstral coefficients
        let mut spectrum: Vec<Complex<f64>> = log_mag.iter()
            .map(|&lm| Complex::new(lm, 0.0))
            .collect();

        let mut planner = FftPlanner::new();
        let ifft = planner.plan_fft_inverse(fft_size);
        ifft.process(&mut spectrum);

        // FIX for Defect 7: rustfft's IFFT does not apply 1/N normalization.
        // Without this, cepstral coefficients are amplified by N, which propagates
        // through FFT→exp→IFFT and distorts the frequency response shape
        // (gains raised to the N-th power instead of being preserved).
        let inv_n = 1.0 / fft_size as f64;
        for s in spectrum.iter_mut() {
            *s *= inv_n;
        }

        // 3. Apply cepstral window (keep positive frequencies, double, zero negative)
        let half = fft_size / 2;
        for (i, s) in spectrum.iter_mut().enumerate() {
            if i == 0 || i == half {
                // Keep DC and Nyquist as-is
            } else if i < half {
                *s = *s * 2.0;  // Double positive frequencies
            } else {
                *s = Complex::new(0.0, 0.0);  // Zero negative frequencies
            }
        }
        
        // 4. FFT back to frequency domain
        let fft = planner.plan_fft_forward(fft_size);
        fft.process(&mut spectrum);
        
        // 5. Exponentiate to get minimum phase frequency response
        for s in spectrum.iter_mut() {
            *s = s.exp();
        }
        
        // 6. IFFT to get minimum phase IR
        ifft.process(&mut spectrum);
        
        // 7. Extract first num_taps samples
        let mut ir_mono: Vec<f64> = (0..num_taps)
            .map(|i| spectrum[i].re / fft_size as f64)
            .collect();
        
        // 8. Apply half-window (fade out at the end)
        for (i, sample) in ir_mono.iter_mut().enumerate() {
            if i > num_taps / 2 {
                let w = 0.5 * (1.0 + ((num_taps - 1 - i) as f64 / (num_taps / 2) as f64 * PI).cos());
                *sample *= w;
            }
        }
        
        // 9. Normalize
        let ref_gain = self.interpolate_gain(1000.0);
        let norm_factor = 10.0_f64.powf(-ref_gain / 20.0);
        for sample in ir_mono.iter_mut() {
            *sample *= norm_factor;
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

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_fir_eq_flat() {
        // Flat response (all bands at 0 dB) should produce near-unity impulse
        let fir = FirEq::new(44100.0, 1023);
        let ir = fir.get_ir(2);
        
        // Sum should be approximately 1.0 for unity gain
        let sum: f64 = fir.cached_ir.iter().sum();
        assert!((sum - 1.0).abs() < 0.1, "Flat IR sum should be ~1.0, got {}", sum);
    }
    
    #[test]
    fn test_fir_eq_bass_boost() {
        let mut fir = FirEq::new(44100.0, 1023);
        fir.set_band(0, 6.0);  // Boost 31 Hz by 6 dB
        
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
        let gain_500 = fir.interpolate_gain(500.0);  // 0 dB (standard band)
        let gain_1000 = fir.interpolate_gain(1000.0); // 0 dB (standard band)

        // At 750 Hz (between 500 and 1000, both 0 dB), should be 0 dB
        assert!((gain_750 - 0.0).abs() < 0.01, "Gain at 750 Hz should be ~0 dB");
    }

    #[test]
    fn test_minimum_phase_flat() {
        // Flat response in minimum phase mode should also produce near-unity sum
        let mut fir = FirEq::new(44100.0, 1023);
        fir.set_phase_mode(FirPhaseMode::Minimum);

        let sum: f64 = fir.cached_ir.iter().sum();
        assert!((sum - 1.0).abs() < 0.15, "Minimum phase flat IR sum should be ~1.0, got {}", sum);
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
        assert!(sum.abs() < 100.0, "Minimum phase boosted IR sum should be bounded, got {}", sum);
        assert!(sum > 0.5, "Minimum phase boosted IR sum should be positive and > 0.5, got {}", sum);
    }
}
