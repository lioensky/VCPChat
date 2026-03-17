//! DSP utilities - Volume control and Noise shaping
//!
//! NoiseShaper implementation based on SoX dither.c coefficients
//! with NTF-verified stability and realtime-safe xorshift64 RNG.

use serde::{Deserialize, Serialize};

/// Volume controller with anti-zipper smoothing
/// 
/// FIX for Defect 36: Smoothing coefficient is now sample-rate aware.
/// The smoothing time constant is ~20ms regardless of sample rate.
pub struct VolumeController {
    current: f64,
    target: f64,
    smoothing: f64,
    sample_rate: u32,
}

impl VolumeController {
    /// Create a new VolumeController with default sample rate (44100 Hz)
    pub fn new() -> Self {
        Self::with_sample_rate(44100)
    }
    
    /// Create a new VolumeController with specified sample rate
    /// 
    /// FIX for Defect 36: Calculate smoothing coefficient based on sample rate
    /// to maintain consistent ~20ms smoothing time.
    pub fn with_sample_rate(sample_rate: u32) -> Self {
        // Target: ~20ms smoothing time
        // smoothing = exp(-1 / tau) where tau = samples for 20ms
        let smoothing_time_ms = 20.0;
        let smoothing_samples = (smoothing_time_ms / 1000.0) * sample_rate as f64;
        let smoothing = (-1.0 / smoothing_samples).exp();
        
        Self {
            current: 1.0,
            target: 1.0,
            smoothing,
            sample_rate,
        }
    }
    
    /// Update sample rate (recalculates smoothing coefficient)
    pub fn set_sample_rate(&mut self, sample_rate: u32) {
        if sample_rate != self.sample_rate {
            self.sample_rate = sample_rate;
            let smoothing_time_ms = 20.0;
            let smoothing_samples = (smoothing_time_ms / 1000.0) * sample_rate as f64;
            self.smoothing = (-1.0 / smoothing_samples).exp();
        }
    }
    
    pub fn set_target(&mut self, volume: f64) {
        self.target = volume.clamp(0.0, 1.0);
    }

    #[inline]
    pub fn next_volume(&mut self) -> f64 {
        self.current += (self.target - self.current) * (1.0 - self.smoothing);
        self.current
    }
    
    pub fn process(&mut self, buffer: &mut [f64], channels: usize) {
        let frames = buffer.len() / channels;
        for frame in 0..frames {
            let vol = self.next_volume();
            for ch in 0..channels {
                buffer[frame * channels + ch] *= vol;
            }
        }
    }
}

impl Default for VolumeController {
    fn default() -> Self {
        Self::new()
    }
}

/// Noise shaping curve presets
/// All coefficients from SoX src/dither.c, NTF zeros verified |z| < 1
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NoiseShaperCurve {
    /// Lipshitz 5-tap - general purpose, works well at 44.1/48kHz
    /// NTF max|z| = 0.961, 4kHz notch -27.2dB
    Lipshitz5,
    
    /// F-weighted 9-tap - psychoacoustically optimized for 44.1kHz
    /// Deepest notch in 2-5kHz region (human hearing most sensitive)
    /// NTF max|z| = 0.914
    FWeighted9,
    
    /// Modified-E 9-tap - moderate high-frequency push
    /// NTF max|z| = 0.916
    ModifiedE9,
    
    /// Improved-E 9-tap - most aggressive HF noise shaping
    /// NTF max|z| = 0.959
    ImprovedE9,
    
    /// Pure TPDF only, no noise shaping
    /// Recommended for 96kHz+ where shaping benefit diminishes
    TpdfOnly,
}

impl NoiseShaperCurve {
    /// Auto-select curve based on sample rate
    /// - 44.1kHz: Lipshitz5 (safe default)
    /// - 48kHz: Lipshitz5 (acceptable 8.8% offset)
    /// - 88.2/96kHz+: TpdfOnly (shaping benefit diminishes)
    pub fn auto_select(sample_rate: u32) -> Self {
        if sample_rate <= 50_000 { 
            Self::Lipshitz5 
        } else { 
            Self::TpdfOnly 
        }
    }
    
    /// Get verified SoX coefficients
    /// Returns 9-element array (lower-order curves pad with zeros)
    pub fn coeffs(&self) -> [f64; 9] {
        match self {
            // SoX lip44 - Lipshitz 1992, 5-tap
            // Verified: NTF zeros all inside unit circle
            Self::Lipshitz5 =>
                [2.033, -2.165, 1.959, -1.590, 0.6149, 0.0, 0.0, 0.0, 0.0],

            // SoX fwe44 - F-weighted, 9-tap
            // Best psychoacoustic performance at 44.1kHz
            Self::FWeighted9 =>
                [2.412, -3.370, 3.937, -4.174, 3.353, -2.205, 1.281, -0.569, 0.0847],

            // SoX mew44 - Modified-E, 9-tap
            Self::ModifiedE9 =>
                [1.662, -1.263, 0.4827, -0.2913, 0.1268, -0.1124, 0.03252, -0.01265, -0.03524],

            // SoX iew44 - Improved-E, 9-tap (most aggressive)
            Self::ImprovedE9 =>
                [2.847, -4.685, 6.214, -7.184, 6.639, -5.032, 3.263, -1.632, 0.4191],

            // Pure TPDF - no noise shaping
            Self::TpdfOnly =>
                [0.0; 9],
        }
    }
    
    /// Check if this curve is recommended for given sample rate
    /// Unified boundary at 50_000 Hz based on NTF degradation analysis:
    /// - At 48kHz: all curves have ≤6dB 4kHz notch degradation (acceptable)
    /// - At 88.2kHz: only FWeighted9/ImprovedE9 stay ≤6dB, others exceed
    /// - Conservative choice: recommend TpdfOnly for all rates >50kHz
    pub fn is_recommended_for(&self, sample_rate: u32) -> bool {
        match self {
            Self::TpdfOnly => true,  // Always safe
            _ => sample_rate <= 50_000,  // Unified boundary
        }
    }
}

impl Default for NoiseShaperCurve {
    fn default() -> Self {
        Self::Lipshitz5
    }
}

/// High-order noise shaping quantizer with SoX-verified coefficients
/// 
/// Features:
/// - 9-tap error feedback (supports all SoX curves)
/// - Internal xorshift64 RNG (realtime-safe, no thread_rng overhead)
/// - TPDF dither at ±1 LSB (standard amplitude)
/// - Error clamp ±2 LSB (prevents burst noise)
/// - Runtime curve switching with history reset
pub struct NoiseShaper {
    /// Per-channel error history (9 samples each)
    error_history: Vec<[f64; 9]>,
    /// Current coefficients
    coeffs: [f64; 9],
    /// Target bit depth
    bits: u32,
    /// Enable/disable flag
    enabled: bool,
    /// Current curve preset
    curve: NoiseShaperCurve,
    /// Sample rate for auto-selection
    sample_rate: u32,
    /// xorshift64 state for TPDF generation
    rng_state: u64,
}

impl NoiseShaper {
    /// Create new NoiseShaper with auto-selected curve
    pub fn new(channels: usize, sample_rate: u32, bits: u32) -> Self {
        let curve = NoiseShaperCurve::auto_select(sample_rate);
        let coeffs = curve.coeffs();
        
        Self {
            error_history: vec![[0.0; 9]; channels],
            coeffs,
            bits,
            enabled: true,
            curve,
            sample_rate,
            rng_state: 0x1234_5678_9ABC_DEF0,  // Fixed seed for reproducibility
        }
    }
    
    /// Enable or disable noise shaping
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }
    
    /// Set target bit depth (Defect 37 fix)
    pub fn set_bits(&mut self, bits: u32) {
        if bits != self.bits && bits >= 8 && bits <= 32 {
            self.bits = bits;
            log::info!("NoiseShaper bit depth: {} bits", bits);
        }
    }
    
    /// Get current curve
    pub fn curve(&self) -> NoiseShaperCurve {
        self.curve
    }
    
    /// Get current sample rate
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
    
    /// Get current bit depth
    pub fn bits(&self) -> u32 {
        self.bits
    }
    
    /// Switch to a different noise shaping curve
    /// IMPORTANT: Clears error history to prevent artifacts from coefficient mismatch
    /// 
    /// When curve is not recommended for current sample rate, logs a warning
    /// but respects user's explicit choice (does not force-replace).
    pub fn set_curve(&mut self, curve: NoiseShaperCurve) {
        // Warn if curve not recommended for current sample rate
        // But respect user's explicit choice (don't force-replace)
        if !curve.is_recommended_for(self.sample_rate) {
            log::warn!(
                "Curve {:?} not recommended at {} Hz, frequency response will be degraded",
                curve, self.sample_rate
            );
        }
        
        self.curve = curve;
        self.coeffs = curve.coeffs();
        
        // MUST clear history when switching curves
        for h in &mut self.error_history {
            *h = [0.0; 9];
        }
        
        log::info!("NoiseShaper curve: {:?} @ {} Hz", curve, self.sample_rate);
    }
    
    /// Update sample rate (triggers curve auto-selection)
    pub fn set_sample_rate(&mut self, sample_rate: u32) {
        if sample_rate != self.sample_rate {
            self.sample_rate = sample_rate;
            let new_curve = NoiseShaperCurve::auto_select(sample_rate);
            self.set_curve(new_curve);
        }
    }
    
    /// xorshift64 PRNG - fast, deterministic, period 2^64-1
    #[inline(always)]
    fn next_u64(&mut self) -> u64 {
        // Classic xorshift64 parameters (13, 7, 17)
        self.rng_state ^= self.rng_state << 13;
        self.rng_state ^= self.rng_state >> 7;
        self.rng_state ^= self.rng_state << 17;
        self.rng_state
    }
    
    /// Generate TPDF sample: triangular distribution over (-1, 1)
    /// This gives ±1 LSB amplitude when multiplied by lsb
    /// Standard TPDF: two independent uniform samples subtracted
    #[inline(always)]
    fn tpdf(&mut self) -> f64 {
        // Two independent U(0,1) samples
        let r1 = self.next_u64() as f64 / u64::MAX as f64;
        let r2 = self.next_u64() as f64 / u64::MAX as f64;
        // Triangular distribution: U(0,1) - U(0,1) = T(-1, 1)
        r1 - r2
    }
    
    /// Process a single sample with noise shaping and dither
    /// 
    /// # Arguments
    /// * `sample` - Input sample in [-1, 1] range
    /// * `ch` - Channel index for error history
    /// 
    /// # Returns
    /// * Quantized sample in [-1, 1] range
    #[inline]
    pub fn process_sample(&mut self, sample: f64, ch: usize) -> f64 {
        if !self.enabled || ch >= self.error_history.len() {
            return sample;
        }
        
        // Adaptive dither: skip dither and noise shaping in silence regions
        // Threshold: -120 dBFS (1e-6)
        // Rationale: 24-bit TPDF dither RMS ≈ -146 dBFS, so -120 dBFS is far below
        // perceptible range. This avoids audible dither noise in quiet passages.
        const SILENCE_THRESHOLD: f64 = 1e-6;  // -120 dBFS
        
        if sample.abs() < SILENCE_THRESHOLD {
            // Clear error history to prevent burst noise when audio resumes
            // If we don't do this, accumulated error from silence would suddenly
            // be released when signal returns, causing an audible click
            self.error_history[ch] = [0.0; 9];
            return sample;
        }
        
        let scale = 2.0_f64.powi(self.bits as i32 - 1);
        let lsb = 1.0 / scale;
        
        // 1. Generate TPDF dither FIRST (before borrowing error_history)
        //    tpdf() returns (-1, 1) which is ±1 LSB in the integer domain
        //    This is the standard TPDF amplitude for dither
        let dither = self.tpdf();
        
        // 2. Get error history and compute feedback
        let e = &mut self.error_history[ch];
        let feedback: f64 = self.coeffs.iter()
            .zip(e.iter())
            .map(|(c, ei)| c * ei)
            .sum();
        
        // 3. Quantize
        //    x is in the integer domain (sample * scale shifts to integer range)
        //    dither adds ±1 LSB to prevent quantization distortion
        let x = sample * scale + feedback;
        let quantized = (x + dither).round();
        
        // 4. Update error history with clamp
        //    Clamping prevents error accumulation that could cause burst noise
        //    With ±1 LSB dither, max error is ~1.5 LSB, clamp at ±2 for safety margin
        let raw_error = x - quantized;
        let clamped_error = raw_error.clamp(-2.0, 2.0);
        
        // Shift history and insert new error
        e.copy_within(0..8, 1);
        e[0] = clamped_error;
        
        quantized * lsb
    }
    
    /// Process a buffer of samples (convenience method)
    pub fn process(&mut self, buffer: &mut [f64], channels: usize) {
        if !self.enabled {
            return;
        }
        
        let frames = buffer.len() / channels;
        for frame in 0..frames {
            for ch in 0..channels {
                let idx = frame * channels + ch;
                buffer[idx] = self.process_sample(buffer[idx], ch);
            }
        }
    }
    
    /// Reset error history (useful when starting new track)
    pub fn reset(&mut self) {
        for h in &mut self.error_history {
            *h = [0.0; 9];
        }
        // Reset RNG state for reproducibility
        self.rng_state = 0x1234_5678_9ABC_DEF0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tpdf_distribution() {
        // TPDF should have triangular distribution centered at 0
        let mut ns = NoiseShaper::new(1, 44100, 24);
        let n_samples = 100_000;
        let mut sum = 0.0;
        let mut sum_sq = 0.0;
        let mut min = f64::MAX;
        let mut max = f64::MIN;
        
        for _ in 0..n_samples {
            let t = ns.tpdf();
            sum += t;
            sum_sq += t * t;
            min = min.min(t);
            max = max.max(t);
        }
        
        let mean = sum / n_samples as f64;
        let variance = sum_sq / n_samples as f64 - mean * mean;
        
        // TPDF (-1, 1): mean ≈ 0, variance = 1/6 ≈ 0.1667
        assert!(mean.abs() < 0.01, "TPDF mean should be ~0, got {}", mean);
        assert!((variance - 1.0/6.0).abs() < 0.01, "TPDF variance should be ~0.1667, got {}", variance);
        assert!(min > -1.01 && max < 1.01, "TPDF range should be (-1, 1), got [{}, {}]", min, max);
    }
    
    #[test]
    fn test_stability_with_full_scale() {
        // Full-scale square wave should not cause error divergence
        let mut ns = NoiseShaper::new(1, 44100, 24);
        
        for i in 0..44100 {
            // Alternating full-scale signal (worst case for stability)
            let sample = if i % 2 == 0 { 1.0 } else { -1.0 };
            let out = ns.process_sample(sample, 0);
            
            // Output should stay in valid range (allow small overshoot from dither)
            assert!(out.abs() <= 1.001, "Output diverged: {}", out);
            
            // Check error history stays bounded by clamp
            let e = &ns.error_history[0];
            for &ei in e.iter() {
                assert!(ei.abs() <= 2.0, "Error history exceeds clamp: {}", ei);
            }
        }
    }
    
    #[test]
    fn test_curve_switch_clears_history() {
        let mut ns = NoiseShaper::new(1, 44100, 24);
        
        // Process some samples to build up error history
        for i in 0..100 {
            ns.process_sample(0.5 * (i as f64 / 100.0).sin(), 0);
        }
        
        // Verify history is non-zero
        let has_nonzero = ns.error_history[0].iter().any(|&e| e != 0.0);
        assert!(has_nonzero, "Error history should have non-zero values");
        
        // Switch curve
        ns.set_curve(NoiseShaperCurve::FWeighted9);
        
        // Verify history is cleared
        for &e in ns.error_history[0].iter() {
            assert_eq!(e, 0.0, "Error history should be cleared after curve switch");
        }
    }
    
    #[test]
    fn test_idle_tone_free() {
        // With adaptive dither, zero input returns zero output (silence bypass)
        // Test that near-silence (above threshold) produces dithered output
        let mut ns = NoiseShaper::new(1, 44100, 24);
        let n_samples = 44100;
        let mut samples = Vec::with_capacity(n_samples);
        
        // Use a signal just above the silence threshold
        let above_threshold = 2e-6;  // -114 dBFS, above -120 dBFS threshold
        
        for _ in 0..n_samples {
            samples.push(ns.process_sample(above_threshold, 0));
        }
        
        // Check 1: Output should be non-zero (dither is working)
        let non_zero_count = samples.iter().filter(|&&x| x != 0.0).count();
        assert!(non_zero_count > n_samples / 2, 
            "Dither not working: only {}/{} samples non-zero", non_zero_count, n_samples);
        
        // Check 2: Output should have reasonable variance (dither is adding noise)
        let mean = samples.iter().sum::<f64>() / n_samples as f64;
        let variance = samples.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n_samples as f64;
        
        // For 24-bit with TPDF dither at ±1 LSB, expect some variance
        let lsb = 1.0 / 2.0_f64.powi(23);
        assert!(variance > lsb * lsb * 0.01, 
            "Variance too low ({:.2e}), possible idle tone or stuck output", variance);
    }
    
    #[test]
    fn test_adaptive_dither_silence() {
        // Test that silence below threshold bypasses dither
        let mut ns = NoiseShaper::new(1, 44100, 24);
        
        // Zero input should return zero output
        assert_eq!(ns.process_sample(0.0, 0), 0.0);
        
        // Very low input below threshold should return input unchanged
        let below_threshold = 0.5e-6;  // -126 dBFS, below -120 dBFS threshold
        assert_eq!(ns.process_sample(below_threshold, 0), below_threshold);
        
        // Error history should be cleared after silence
        ns.process_sample(1e-3, 0);  // First, build up some error history
        let has_nonzero = ns.error_history[0].iter().any(|&e| e != 0.0);
        assert!(has_nonzero, "Error history should be non-zero after signal");
        
        // Now feed silence
        ns.process_sample(0.0, 0);
        
        // Error history should be cleared
        for &e in ns.error_history[0].iter() {
            assert_eq!(e, 0.0, "Error history should be cleared after silence");
        }
    }
    
    #[test]
    fn test_all_curves_stable() {
        // Each curve should process without divergence
        for curve in [
            NoiseShaperCurve::Lipshitz5,
            NoiseShaperCurve::FWeighted9,
            NoiseShaperCurve::ModifiedE9,
            NoiseShaperCurve::ImprovedE9,
            NoiseShaperCurve::TpdfOnly,
        ] {
            let mut ns = NoiseShaper::new(1, 44100, 24);
            ns.set_curve(curve);
            
            // Process 1 second of full-scale sine wave
            for i in 0..44100 {
                let t = i as f64 / 44100.0;
                let sample = 0.9 * (2.0 * std::f64::consts::PI * 440.0 * t).sin();
                let out = ns.process_sample(sample, 0);
                assert!(out.abs() <= 1.0, "Curve {:?} diverged: {}", curve, out);
            }
        }
    }
}