//! Tube Saturation / Soft Clipping Processor
//!
//! Provides analog-style warmth through non-linear waveshaping.
//! Uses tanh-based soft clipping to add harmonics without harsh distortion.
//!
//! # Design
//!
//! - Threshold-based: only affects samples above threshold
//! - Tanh waveshaping: smooth, musical saturation curve
//! - Drive control: intensity of the effect
//! - Mix control: blend between dry and saturated signal
//! - High-pass mode: only saturate high frequencies (exciter mode)
//!
//! # Use Cases
//!
//! - Add warmth to digital recordings
//! - Restore transient energy lost in limiting
//! - Simulate analog console coloration
//! - High-frequency exciter for presence boost

/// Saturation type / character
#[derive(Debug, Clone, Copy, PartialEq, Default, serde::Serialize, serde::Deserialize)]
pub enum SaturationType {
    #[default]
    Tape,       // Warm, gentle compression
    Tube,       // Rich even harmonics
    Transistor, // Edgy, odd harmonics
}

/// Tube Saturation processor with configurable drive and mix
///
/// When highpass_mode is enabled, only high frequencies (>4kHz) are saturated,
/// creating a more transparent "exciter" effect without muddying the low end.
///
/// Note: HPF state fields require mutable access. This struct should be wrapped
/// in `Arc<Mutex<Saturation>>` for thread-safe usage.
pub struct Saturation {
    /// Saturation type
    pub sat_type: SaturationType,
    /// Drive amount (0.0 - 2.0, default 0.25)
    pub drive: f64,
    /// Threshold where saturation begins (linear, default 0.88)
    pub threshold: f64,
    /// Mix between dry and wet (0.0 - 1.0, default 0.2)
    pub mix: f64,
    /// Input gain (dB, applied before saturation, default 0.0)
    pub input_gain_db: f64,
    /// Output gain compensation (dB, default 0.0)
    pub output_gain_db: f64,
    /// Enable/disable
    pub enabled: bool,
    
    // High-pass mode for exciter functionality
    /// Enable high-pass separation (only saturate highs)
    pub highpass_mode: bool,
    /// HPF cutoff frequency in Hz (default: 4000)
    pub highpass_cutoff: f64,
    
    // Sample rate for HPF coefficient calculation
    sample_rate: f64,
    // Cached HPF coefficient (recalculated when sample_rate or cutoff changes)
    hpf_coef: f64,
    
    // HPF state (per-channel) - requires &mut self access
    /// HPF state for left channel (y[n-1])
    hpf_state_l: f64,
    /// HPF state for right channel (y[n-1])
    hpf_state_r: f64,
    /// Previous input for left channel (x[n-1])
    prev_input_l: f64,
    /// Previous input for right channel (x[n-1])
    prev_input_r: f64,
}

impl Saturation {
    /// Create a new saturation processor with default settings
    pub fn new() -> Self {
        let mut instance = Self {
            sat_type: SaturationType::Tube,
            drive: 0.25,
            threshold: 0.88,
            mix: 0.2,
            input_gain_db: 0.0,
            output_gain_db: 0.0,
            enabled: true,
            highpass_mode: false,
            highpass_cutoff: 4000.0,
            sample_rate: 44100.0,
            hpf_coef: 0.0,  // Will be calculated below
            hpf_state_l: 0.0,
            hpf_state_r: 0.0,
            prev_input_l: 0.0,
            prev_input_r: 0.0,
        };
        // Initialize HPF coefficient immediately (fixes MINOR-03)
        instance.update_hpf_coef();
        instance
    }
    
    /// Create with specific saturation type
    pub fn with_type(sat_type: SaturationType) -> Self {
        Self {
            sat_type,
            ..Self::new()
        }
    }
    
    /// Set drive amount (0.0 - 2.0)
    pub fn set_drive(&mut self, drive: f64) {
        self.drive = drive.clamp(0.0, 2.0);
    }
    
    /// Set threshold (0.0 - 1.0)
    pub fn set_threshold(&mut self, threshold: f64) {
        self.threshold = threshold.clamp(0.0, 1.0);
    }
    
    /// Set mix amount (0.0 - 1.0)
    pub fn set_mix(&mut self, mix: f64) {
        self.mix = mix.clamp(0.0, 1.0);
    }
    
    /// Set input gain (dB) - applied before saturation
    pub fn set_input_gain(&mut self, gain_db: f64) {
        self.input_gain_db = gain_db;
    }
    
    /// Set output gain (dB) - applied only to saturated samples for compensation
    pub fn set_output_gain(&mut self, gain_db: f64) {
        self.output_gain_db = gain_db;
    }
    
    /// Enable/disable saturation
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }
    
    /// Set saturation type
    pub fn set_type(&mut self, sat_type: SaturationType) {
        self.sat_type = sat_type;
    }
    
    /// Enable/disable high-pass mode (exciter mode)
    pub fn set_highpass_mode(&mut self, enabled: bool) {
        self.highpass_mode = enabled;
    }
    
    /// Set high-pass cutoff frequency in Hz
    pub fn set_highpass_cutoff(&mut self, hz: f64) {
        self.highpass_cutoff = hz.clamp(1000.0, 12000.0);
        self.update_hpf_coef();
    }
    
    /// Update sample rate and recalculate HPF coefficient
    pub fn set_sample_rate(&mut self, sr: f64) {
        self.sample_rate = sr;
        self.update_hpf_coef();
    }
    
    /// Recalculate HPF coefficient based on current cutoff and sample rate
    fn update_hpf_coef(&mut self) {
        // First-order HPF coefficient using simple RC model:
        // y[n] = α·y[n-1] + α·(x[n] - x[n-1])
        // where α = 1/(1 + 2π·fc/fs)
        // This is a simple and numerically stable approximation
        self.hpf_coef = 1.0 / (1.0 + std::f64::consts::TAU * self.highpass_cutoff / self.sample_rate);
    }
    
    /// Process interleaved f64 samples in-place
    pub fn process(&mut self, samples: &mut [f64]) {
        self.process_with_channels(samples, 2)  // Default to stereo
    }
    
    /// Process interleaved f64 samples with specified channel count
    pub fn process_with_channels(&mut self, samples: &mut [f64], channels: usize) {
        if !self.enabled {
            return;
        }
        
        if self.highpass_mode {
            self.process_highpass(samples, channels);
        } else {
            self.process_fullband(samples);
        }
    }
    
    /// Process with explicit sample rate (for cases where SR differs from cached value)
    pub fn process_with_sr(&mut self, samples: &mut [f64], channels: usize, sample_rate: f64) {
        if (self.sample_rate - sample_rate).abs() > 1.0 {
            self.set_sample_rate(sample_rate);
        }
        self.process_with_channels(samples, channels);
    }
    
    /// Full-band saturation (original behavior)
    fn process_fullband(&mut self, samples: &mut [f64]) {
        let input_gain = db_to_linear(self.input_gain_db);
        let output_gain = db_to_linear(self.output_gain_db);
        
        for sample in samples.iter_mut() {
            let dry = *sample * input_gain;
            
            if dry.abs() > self.threshold {
                let driven = dry * (1.0 + self.drive);
                let saturated = self.apply_saturation(driven);
                *sample = (dry * (1.0 - self.mix) + saturated * self.mix) * output_gain;
            } else {
                *sample = dry;
            }
        }
    }
    
    /// High-pass separated saturation (exciter mode)
    /// Only saturates frequencies above the cutoff
    fn process_highpass(&mut self, samples: &mut [f64], channels: usize) {
        let input_gain = db_to_linear(self.input_gain_db);
        let output_gain = db_to_linear(self.output_gain_db);
        let alpha = self.hpf_coef;
        
        for i in (0..samples.len()).step_by(channels) {
            // Process left channel
            let in_l = samples[i] * input_gain;
            
            // First-order HPF: y[n] = α·y[n-1] + α·(x[n] - x[n-1])
            let high_l = alpha * self.hpf_state_l + alpha * (in_l - self.prev_input_l);
            self.hpf_state_l = high_l;
            self.prev_input_l = in_l;
            
            // Low frequencies are input minus high
            let _low_l = in_l - high_l;
            
            // Apply saturation to high frequencies only
            let saturated_high_l = if high_l.abs() > self.threshold {
                let driven = high_l * (1.0 + self.drive);
                self.apply_saturation(driven)
            } else {
                high_l
            };
            
            // Mix: low + saturated_high * mix + high * (1 - mix)
            // Simplified: low + high * (1 - mix) + saturated_high * mix
            // = in_l - high_l + high_l - high_l * mix + saturated_high * mix
            // = in_l - high_l * mix + saturated_high * mix
            samples[i] = (in_l + (saturated_high_l - high_l) * self.mix) * output_gain;
            
            // Process right channel if present
            if channels > 1 && i + 1 < samples.len() {
                let in_r = samples[i + 1] * input_gain;
                
                let high_r = alpha * self.hpf_state_r + alpha * (in_r - self.prev_input_r);
                self.hpf_state_r = high_r;
                self.prev_input_r = in_r;
                
                let _low_r = in_r - high_r;
                
                let saturated_high_r = if high_r.abs() > self.threshold {
                    let driven = high_r * (1.0 + self.drive);
                    self.apply_saturation(driven)
                } else {
                    high_r
                };
                
                samples[i + 1] = (in_r + (saturated_high_r - high_r) * self.mix) * output_gain;
            }
        }
    }
    
    /// Apply saturation curve based on type
    #[inline(always)]
    fn apply_saturation(&self, x: f64) -> f64 {
        match self.sat_type {
            SaturationType::Tape => x.signum() * (1.0 - (-x.abs()).exp()),
            SaturationType::Tube => x.tanh(),
            SaturationType::Transistor => {
                if x.abs() < 1.5 {
                    x - (x * x * x) / 3.0
                } else {
                    x.signum() * 0.667
                }
            }
        }
    }
    
    /// Reset filter state
    pub fn reset(&mut self) {
        self.hpf_state_l = 0.0;
        self.hpf_state_r = 0.0;
        self.prev_input_l = 0.0;
        self.prev_input_r = 0.0;
    }
    
    /// Get current settings as a struct
    pub fn get_settings(&self) -> SaturationSettings {
        SaturationSettings {
            sat_type: self.sat_type,
            drive: self.drive,
            threshold: self.threshold,
            mix: self.mix,
            input_gain_db: self.input_gain_db,
            output_gain_db: self.output_gain_db,
            enabled: self.enabled,
            highpass_mode: self.highpass_mode,
            highpass_cutoff: self.highpass_cutoff,
        }
    }
}

impl Default for Saturation {
    fn default() -> Self {
        Self::new()
    }
}

/// Settings struct for API responses
#[derive(Debug, Clone, serde::Serialize)]
pub struct SaturationSettings {
    pub sat_type: SaturationType,
    pub drive: f64,
    pub threshold: f64,
    pub mix: f64,
    pub input_gain_db: f64,
    pub output_gain_db: f64,
    pub enabled: bool,
    pub highpass_mode: bool,
    pub highpass_cutoff: f64,
}

/// Convert dB to linear
#[inline(always)]
fn db_to_linear(db: f64) -> f64 {
    10.0_f64.powf(db / 20.0)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_tube_saturation() {
        let mut sat = Saturation::with_type(SaturationType::Tube);
        sat.set_enabled(true);
        sat.set_mix(1.0);  // 100% wet for testing
        
        // Test that loud signals are compressed
        let mut samples = vec![0.9, -0.9, 0.5, -0.5];
        sat.process(&mut samples);
        
        // tanh(0.9) ≈ 0.716
        assert!(samples[0].abs() < 0.9);
        assert!(samples[1].abs() < 0.9);
        
        // Lower signals should pass through relatively unchanged
        // tanh(0.5) ≈ 0.462, which is close to 0.5
        assert!((samples[2].abs() - 0.5).abs() < 0.1);
    }
    
    #[test]
    fn test_disabled() {
        let mut sat = Saturation::new();
        sat.set_enabled(false);
        
        let mut samples = vec![0.9, -0.9, 0.5, -0.5];
        sat.process(&mut samples);
        
        // Should pass through unchanged when disabled
        assert!((samples[0] - 0.9).abs() < 1e-10);
        assert!((samples[1] - (-0.9)).abs() < 1e-10);
    }
    
    #[test]
    fn test_threshold() {
        let mut sat = Saturation::with_type(SaturationType::Tube);
        sat.set_enabled(true);
        sat.set_threshold(0.8);
        sat.set_mix(1.0);
        
        // Below threshold should pass unchanged
        let mut samples = vec![0.5];
        sat.process(&mut samples);
        assert!((samples[0] - 0.5).abs() < 1e-10);
        
        // Above threshold should be saturated
        let mut samples = vec![0.9];
        sat.process(&mut samples);
        assert!(samples[0].abs() < 0.9);
    }
    
    #[test]
    fn test_mix() {
        let mut sat = Saturation::with_type(SaturationType::Tube);
        sat.set_enabled(true);
        sat.set_drive(0.0);  // No drive for this test
        sat.set_mix(0.5);
        
        let mut samples = vec![1.0];
        sat.process(&mut samples);
        
        // Mix of tanh(1) ≈ 0.762 and 1.0
        // Result should be between the two
        let expected = (1.0 + 1.0_f64.tanh()) * 0.5;
        assert!((samples[0] - expected).abs() < 0.01);
    }
    
    #[test]
    fn test_hpf_coefficient() {
        let mut sat = Saturation::new();
        sat.set_sample_rate(44100.0);
        sat.set_highpass_cutoff(4000.0);
        
        // HPF coefficient should be: 1/(1 + 2π*4000/44100) ≈ 0.637
        let expected = 1.0 / (1.0 + std::f64::consts::TAU * 4000.0 / 44100.0);
        assert!((sat.hpf_coef - expected).abs() < 0.001);
    }
    
    #[test]
    fn test_hpf_dc_rejection() {
        let mut sat = Saturation::new();
        sat.set_highpass_mode(true);
        sat.set_highpass_cutoff(4000.0);
        sat.set_sample_rate(44100.0);
        sat.set_mix(0.5);  // With mix
        sat.set_threshold(2.0);  // Don't trigger saturation
        
        // DC signal - HPF should reject DC, so high component → 0
        // Output should be close to input (low freq passes through)
        let mut samples: Vec<f64> = vec![0.0; 200];  // 100 stereo samples
        for i in 0..100 {
            samples[i * 2] = 1.0;     // L = 1.0 (DC)
            samples[i * 2 + 1] = 1.0; // R = 1.0 (DC)
        }
        sat.process_with_channels(&mut samples, 2);
        
        // For DC input: high freq → 0, low freq ≈ input
        // Output ≈ input because low passes through and high is near 0
        // After initial transient, output should be close to DC input (1.0)
        let last_l: f64 = samples.iter().skip(180).step_by(2).take(10).sum::<f64>() / 10.0;
        let last_r: f64 = samples.iter().skip(181).step_by(2).take(10).sum::<f64>() / 10.0;
        
        // DC should pass through (high freq blocked, low freq = DC)
        assert!((last_l - 1.0).abs() < 0.1, "L output should be close to 1.0, got {}", last_l);
        assert!((last_r - 1.0).abs() < 0.1, "R output should be close to 1.0, got {}", last_r);
    }
}