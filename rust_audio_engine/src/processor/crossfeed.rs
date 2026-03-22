//! Bauer Binaural Crossfeed for Headphone Listening
//!
//! Simulates speaker crosstalk to reduce "inside-head" localization.
//! Based on the Bauer stereophonic-to-binaural filter.
//!
//! # Algorithm
//!
//! ```
//! L_out = L + α × HPF(R)
//! R_out = R + α × HPF(L)
//! ```
//!
//! Where HPF is a second-order high-pass filter (~700Hz cutoff),
//! and α is the crossfeed amount (0.3-0.45 typical).
//!
//! # Use Cases
//!
//! - Headphone listening with speaker-like imaging
//! - Reduces listener fatigue from extreme stereo separation
//! - Particularly beneficial for older recordings with hard-panned instruments

/// Bauer crossfeed processor
///
/// Uses a 2nd-order Butterworth high-pass filter for the crossfeed path.
/// Implementation uses Direct Form II Transposed for numerical stability.
pub struct Crossfeed {
    // HPF state for L→R path (filtering L to mix into R)
    // Direct Form II Transposed only needs 2 state variables
    w_lr: [f64; 2],
    // HPF state for R→L path (filtering R to mix into L)
    w_rl: [f64; 2],
    
    // Biquad coefficients (2nd-order Butterworth HPF)
    // H(z) = (b0 + b1*z^-1 + b2*z^-2) / (1 + a1*z^-1 + a2*z^-2)
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    
    // Crossfeed amount (0.0 - 1.0)
    mix: f64,
    // Enable flag
    enabled: bool,
}

impl Crossfeed {
    /// Create a new crossfeed processor with default settings
    ///
    /// Default: 700Hz cutoff, 0.35 crossfeed amount
    pub fn new(sample_rate: f64) -> Self {
        Self::with_params(sample_rate, 700.0, 0.35)
    }
    
    /// Create with custom parameters
    ///
    /// # Arguments
    /// * `sample_rate` - Audio sample rate in Hz
    /// * `cutoff_hz` - HPF cutoff frequency (600-900 Hz typical)
    /// * `mix` - Crossfeed amount (0.0 - 1.0, 0.3-0.45 typical)
    pub fn with_params(sample_rate: f64, cutoff_hz: f64, mix: f64) -> Self {
        let (b0, b1, b2, a1, a2) = Self::calc_hpf_coeffs(cutoff_hz, sample_rate);
        
        Self {
            w_lr: [0.0; 2],
            w_rl: [0.0; 2],
            b0, b1, b2, a1, a2,
            mix: mix.clamp(0.0, 1.0),
            enabled: true,
        }
    }
    
    /// Calculate 2nd-order Butterworth HPF coefficients using bilinear transform
    ///
    /// High-pass transform: substitute s → 1/s in low-pass prototype
    /// LPF: H(s) = 1 / (1 + √2·s + s²)
    /// HPF: H(s) = s² / (s² + √2·s + 1)
    fn calc_hpf_coeffs(cutoff: f64, sr: f64) -> (f64, f64, f64, f64, f64) {
        // Bilinear transform: s = (2/T) * (z-1)/(z+1) = (1/k) * (z-1)/(z+1)
        // where k = tan(ωc·T/2) = tan(π·fc/fs)
        let wc = std::f64::consts::PI * cutoff / sr;
        let k = wc.tan();
        let k2 = k * k;
        
        // Butterworth 2nd-order HPF via low-pass to high-pass transform
        // HPF numerator: (1 - 2z^-1 + z^-2) for the z² factor
        // After bilinear transform on HPF prototype:
        // b0 = 1/(1 + √2k + k²), b1 = -2/(...), b2 = 1/(...)
        let sqrt2_k = std::f64::consts::SQRT_2 * k;
        let norm = 1.0 / (1.0 + sqrt2_k + k2);
        
        // HPF coefficients (numerator has 1, -2, 1 pattern, NOT k² pattern)
        let b0 = norm;
        let b1 = -2.0 * norm;
        let b2 = norm;
        
        // Denominator (same for LPF and HPF after transform)
        let a1 = 2.0 * (k2 - 1.0) * norm;
        let a2 = (1.0 - sqrt2_k + k2) * norm;
        
        (b0, b1, b2, a1, a2)
    }
    
    /// Set crossfeed amount (0.0 - 1.0)
    pub fn set_mix(&mut self, mix: f64) {
        self.mix = mix.clamp(0.0, 1.0);
    }
    
    /// Update sample rate and recalculate HPF coefficients
    /// This is critical when playing files with different sample rates
    /// (e.g., 44.1kHz vs 192kHz) to maintain correct cutoff frequency.
    pub fn set_sample_rate(&mut self, sample_rate: f64, cutoff_hz: f64) {
        let (b0, b1, b2, a1, a2) = Self::calc_hpf_coeffs(cutoff_hz, sample_rate);
        self.b0 = b0;
        self.b1 = b1;
        self.b2 = b2;
        self.a1 = a1;
        self.a2 = a2;
        // Reset filter state to avoid artifacts from previous sample rate
        self.reset();
    }
    
    /// Set enabled state
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }
    
    /// Reset filter state
    pub fn reset(&mut self) {
        self.w_lr = [0.0; 2];
        self.w_rl = [0.0; 2];
    }
    
    /// Process interleaved stereo samples in-place
    ///
    /// Only processes if channels == 2 (stereo). Mono and multi-channel pass through.
    pub fn process(&mut self, samples: &mut [f64], channels: usize) {
        if !self.enabled || channels != 2 {
            return;
        }
        
        // Cache coefficients to avoid borrowing issues
        let b0 = self.b0;
        let b1 = self.b1;
        let b2 = self.b2;
        let a1 = self.a1;
        let a2 = self.a2;
        let mix = self.mix;
        
        for chunk in samples.chunks_exact_mut(2) {
            let l_in = chunk[0];
            let r_in = chunk[1];
            
            // Apply HPF to L for R output (L→R crossfeed)
            let hpf_l = Self::process_hpf_df2t_static(&mut self.w_lr, b0, b1, b2, a1, a2, l_in);
            
            // Apply HPF to R for L output (R→L crossfeed)
            let hpf_r = Self::process_hpf_df2t_static(&mut self.w_rl, b0, b1, b2, a1, a2, r_in);
            
            // Mix crossfeed
            chunk[0] = l_in + hpf_r * mix;  // L + α×HPF(R)
            chunk[1] = r_in + hpf_l * mix;  // R + α×HPF(L)
        }
    }
    
    /// Direct Form II Transposed biquad processing (static version)
    ///
    /// Numerically stable, only requires 2 state variables.
    /// y[n] = b0*x[n] + w0
    /// w0' = b1*x[n] - a1*y[n] + w1
    /// w1' = b2*x[n] - a2*y[n]
    #[inline(always)]
    fn process_hpf_df2t_static(w: &mut [f64; 2], b0: f64, b1: f64, b2: f64, a1: f64, a2: f64, input: f64) -> f64 {
        let output = b0 * input + w[0];
        w[0] = b1 * input - a1 * output + w[1];
        w[1] = b2 * input - a2 * output;
        output
    }
    
    /// Get current settings
    pub fn get_settings(&self) -> CrossfeedSettings {
        CrossfeedSettings {
            mix: self.mix,
            enabled: self.enabled,
        }
    }
}

impl Default for Crossfeed {
    fn default() -> Self {
        Self::new(44100.0)
    }
}

/// Settings struct for API responses
#[derive(Debug, Clone, serde::Serialize)]
pub struct CrossfeedSettings {
    pub mix: f64,
    pub enabled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_crossfeed_stereo() {
        let mut cf = Crossfeed::new(44100.0);
        cf.set_mix(0.5);
        
        // Hard-panned left signal
        let mut samples = vec![1.0, 0.0, 0.5, 0.0, 0.0, 0.0];
        cf.process(&mut samples, 2);
        
        // Right channel should now have some signal (crossfeed from L)
        // Left channel should be slightly modified
        assert!(samples[1].abs() > 0.0);  // R got crossfeed from L
    }
    
    #[test]
    fn test_crossfeed_mono_passthrough() {
        let mut cf = Crossfeed::new(44100.0);
        cf.set_enabled(true);
        
        let mut samples = vec![1.0, 0.5, 0.25];
        let original = samples.clone();
        cf.process(&mut samples, 1);
        
        // Mono should pass through unchanged
        assert_eq!(samples, original);
    }
    
    #[test]
    fn test_crossfeed_disabled() {
        let mut cf = Crossfeed::new(44100.0);
        cf.set_enabled(false);
        
        let mut samples = vec![1.0, 0.0, 0.5, 0.0];
        let original = samples.clone();
        cf.process(&mut samples, 2);
        
        // Should pass through unchanged when disabled
        assert_eq!(samples, original);
    }
    
    #[test]
    fn test_hpf_coefficients_highpass() {
        let (b0, b1, b2, _a1, _a2) = Crossfeed::calc_hpf_coeffs(700.0, 44100.0);
        
        // HPF numerator should have 1, -2, 1 pattern (normalized)
        // This is the key difference from LPF which has k², -2k², k² pattern
        assert!((b0 - b2).abs() < 1e-10);  // b0 == b2
        assert!((b1 + 2.0 * b0).abs() < 1e-10);  // b1 == -2*b0
        
        // DC gain of HPF should be near 0 (high-pass blocks DC)
        // DC gain = (b0 + b1 + b2) / (1 + a1 + a2)
        // For HPF with 1,-2,1 numerator, b0+b1+b2 ≈ 0
        assert!((b0 + b1 + b2).abs() < 1e-10);
    }
    
    #[test]
    fn test_hpf_attenuates_low_freq() {
        let mut cf = Crossfeed::with_params(44100.0, 700.0, 1.0);
        
        // DC signal (0 Hz) should be strongly attenuated by HPF
        let mut samples: Vec<f64> = vec![0.0; 200];  // 100 stereo samples
        for i in 0..100 {
            samples[i * 2] = 1.0;     // L = 1.0 (DC)
            samples[i * 2 + 1] = 0.0; // R = 0.0
        }
        cf.process(&mut samples, 2);
        
        // N-1 fix: Clarify intent — skip initial transient (first 50 stereo frames = 100 samples),
        // then take R channel samples (odd indices) by starting at index 101 (R of frame 50).
        let sum_r: f64 = samples.iter().skip(100).skip(1).step_by(2).take(50).sum();
        assert!(sum_r.abs() < 1.0);  // Much less than 50 samples of DC
    }
}