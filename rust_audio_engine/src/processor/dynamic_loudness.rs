//! Dynamic Loudness Compensation based on ISO 226:2003 Equal-Loudness Contours
//!
//! Implements a 7-band dynamic EQ that compensates for human hearing's frequency
//! sensitivity changes at different loudness levels (Fletcher-Munson effect).
//!
//! # Features
//!
//! - 7-band dynamic EQ (Low Shelf, 5 Peaking, High Shelf)
//! - ISO 226 inspired compensation curves
//! - Block-based coefficient updates for CPU efficiency
//! - Smooth parameter transitions (50ms default)
//! - User-adjustable strength (0-100%)
//!
//! # DSP Chain Position
//!
//! ```text
//! Decoder → Loudness Normalizer → Dynamic Loudness → User EQ → Volume → Output
//! ```

use std::sync::atomic::{AtomicBool, Ordering};
use atomic_float::AtomicF32;

// ============================================================================
// Biquad Filter Types
// ============================================================================

/// Biquad filter coefficients (normalized)
#[derive(Clone, Debug)]
struct BiquadCoeffs {
    b0: f64, b1: f64, b2: f64,
    a1: f64, a2: f64,
}

impl Default for BiquadCoeffs {
    fn default() -> Self {
        Self { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0 }
    }
}

/// Biquad filter state (delay elements)
#[derive(Clone, Debug, Default)]
struct BiquadState {
    z1: f64,
    z2: f64,
}

/// Biquad filter with multiple filter types
#[derive(Clone, Debug)]
struct BiquadFilter {
    coeffs: BiquadCoeffs,
    state: BiquadState,
    filter_type: FilterType,
    freq: f64,
    q: f64,
    sample_rate: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum FilterType {
    Peaking,
    LowShelf,
    HighShelf,
}

impl BiquadFilter {
    /// Create a peaking/bell filter
    fn peaking(freq: f64, gain_db: f64, q: f64, sample_rate: f64) -> Self {
        let coeffs = Self::calc_peaking_coeffs(freq, gain_db, q, sample_rate);
        Self {
            coeffs,
            state: BiquadState::default(),
            filter_type: FilterType::Peaking,
            freq,
            q,
            sample_rate,
        }
    }
    
    /// Create a low shelf filter
    fn low_shelf(freq: f64, gain_db: f64, sample_rate: f64) -> Self {
        let coeffs = Self::calc_low_shelf_coeffs(freq, gain_db, sample_rate);
        Self {
            coeffs,
            state: BiquadState::default(),
            filter_type: FilterType::LowShelf,
            freq,
            q: 0.7, // Shelf filters use fixed Q
            sample_rate,
        }
    }
    
    /// Create a high shelf filter
    fn high_shelf(freq: f64, gain_db: f64, sample_rate: f64) -> Self {
        let coeffs = Self::calc_high_shelf_coeffs(freq, gain_db, sample_rate);
        Self {
            coeffs,
            state: BiquadState::default(),
            filter_type: FilterType::HighShelf,
            freq,
            q: 0.7,
            sample_rate,
        }
    }
    
    /// Calculate peaking filter coefficients
    /// Using RBJ Audio EQ Cookbook formulas
    fn calc_peaking_coeffs(freq: f64, gain_db: f64, q: f64, sample_rate: f64) -> BiquadCoeffs {
        if gain_db.abs() < 0.0001 {
            // Unity gain: bypass
            return BiquadCoeffs::default();
        }
        
        let a = 10.0_f64.powf(gain_db / 40.0); // gain_db/40 for peaking
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
    
    /// Calculate low shelf filter coefficients
    /// Using RBJ cookbook with S=1 (shelf slope, 12dB/octave)
    fn calc_low_shelf_coeffs(freq: f64, gain_db: f64, sample_rate: f64) -> BiquadCoeffs {
        if gain_db.abs() < 0.0001 {
            return BiquadCoeffs::default();
        }
        
        let a = 10.0_f64.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f64::consts::PI * freq / sample_rate;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        
        // RBJ cookbook: S=1 (shelf slope), alpha and beta formulas
        // alpha = sin(w0)/2 * sqrt(2) when S=1
        // beta = 2 * sqrt(A) * alpha
        let alpha = sin_w0 / std::f64::consts::SQRT_2;
        let beta = 2.0 * a.sqrt() * alpha;
        
        let b0 = a * ((a + 1.0) - (a - 1.0) * cos_w0 + beta * sin_w0);
        let b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w0);
        let b2 = a * ((a + 1.0) - (a - 1.0) * cos_w0 - beta * sin_w0);
        let a0 = (a + 1.0) + (a - 1.0) * cos_w0 + beta * sin_w0;
        let a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cos_w0);
        let a2 = (a + 1.0) + (a - 1.0) * cos_w0 - beta * sin_w0;
        
        BiquadCoeffs {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }
    
    /// Calculate high shelf filter coefficients
    /// Using RBJ cookbook with S=1 (shelf slope, 12dB/octave)
    fn calc_high_shelf_coeffs(freq: f64, gain_db: f64, sample_rate: f64) -> BiquadCoeffs {
        if gain_db.abs() < 0.0001 {
            return BiquadCoeffs::default();
        }
        
        let a = 10.0_f64.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f64::consts::PI * freq / sample_rate;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        
        // RBJ cookbook: S=1 (shelf slope), alpha and beta formulas
        let alpha = sin_w0 / std::f64::consts::SQRT_2;
        let beta = 2.0 * a.sqrt() * alpha;
        
        let b0 = a * ((a + 1.0) + (a - 1.0) * cos_w0 + beta * sin_w0);
        let b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0);
        let b2 = a * ((a + 1.0) + (a - 1.0) * cos_w0 - beta * sin_w0);
        let a0 = (a + 1.0) - (a - 1.0) * cos_w0 + beta * sin_w0;
        let a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cos_w0);
        let a2 = (a + 1.0) - (a - 1.0) * cos_w0 - beta * sin_w0;
        
        BiquadCoeffs {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }
    
    /// Update gain (recalculates coefficients)
    fn set_gain_db(&mut self, gain_db: f64) {
        self.coeffs = match self.filter_type {
            FilterType::Peaking => Self::calc_peaking_coeffs(self.freq, gain_db, self.q, self.sample_rate),
            FilterType::LowShelf => Self::calc_low_shelf_coeffs(self.freq, gain_db, self.sample_rate),
            FilterType::HighShelf => Self::calc_high_shelf_coeffs(self.freq, gain_db, self.sample_rate),
        };
    }
    
    /// Process a single sample (Direct Form I)
    #[inline(always)]
    fn process(&mut self, x: f64) -> f64 {
        let y = self.coeffs.b0 * x + self.state.z1;
        self.state.z1 = self.coeffs.b1 * x - self.coeffs.a1 * y + self.state.z2;
        self.state.z2 = self.coeffs.b2 * x - self.coeffs.a2 * y;
        y
    }
    
    /// Reset filter state
    fn reset(&mut self) {
        self.state = BiquadState::default();
    }
    
    /// Update sample rate (recalculates coefficients)
    fn set_sample_rate(&mut self, sample_rate: f64) {
        if (self.sample_rate - sample_rate).abs() > 1.0 {
            self.sample_rate = sample_rate;
            // Recalculate with current gain (will be updated later)
            self.coeffs = match self.filter_type {
                FilterType::Peaking => Self::calc_peaking_coeffs(self.freq, 0.0, self.q, sample_rate),
                FilterType::LowShelf => Self::calc_low_shelf_coeffs(self.freq, 0.0, sample_rate),
                FilterType::HighShelf => Self::calc_high_shelf_coeffs(self.freq, 0.0, sample_rate),
            };
        }
    }
}

// ============================================================================
// Parameter Smoother
// ============================================================================

/// Exponential parameter smoother for click-free transitions
#[derive(Debug, Clone)]
struct ParameterSmoother {
    current: f64,
    target: f64,
    /// Smoothing coefficient per sample (exp(-1/tau))
    coeff: f64,
    /// Samples remaining to reach target (for block-based updates)
    samples_remaining: usize,
}

impl ParameterSmoother {
    /// Create a new smoother with time constant in milliseconds
    fn new(smoothing_time_ms: f64, sample_rate: f64) -> Self {
        let tau = (smoothing_time_ms / 1000.0) * sample_rate;
        let coeff = if tau > 0.0 { (-1.0 / tau).exp() } else { 0.0 };
        
        Self {
            current: 0.0,
            target: 0.0,
            coeff,
            samples_remaining: 0,
        }
    }
    
    /// Set target value
    fn set_target(&mut self, target: f64) {
        if (self.target - target).abs() > 0.0001 {
            self.target = target;
            self.samples_remaining = usize::MAX; // Start smoothing
        }
    }
    
    /// Get next smoothed value (call once per sample)
    #[inline(always)]
    fn next(&mut self) -> f64 {
        if self.samples_remaining > 0 {
            self.current = self.current + (self.target - self.current) * (1.0 - self.coeff);
            // Check if we've essentially reached target
            if (self.current - self.target).abs() < 0.0001 {
                self.current = self.target;
                self.samples_remaining = 0;
            }
        }
        self.current
    }
    
    /// Get smoothed value for a block (call once per block)
    /// Returns the value at the end of the block
    fn next_block(&mut self, block_size: usize) -> f64 {
        if self.samples_remaining > 0 {
            // Apply smoothing for entire block at once
            // remaining_factor = coeff^block_size
            let remaining_factor = self.coeff.powi(block_size as i32);
            self.current = self.current + (self.target - self.current) * (1.0 - remaining_factor);
            
            if (self.current - self.target).abs() < 0.0001 {
                self.current = self.target;
                self.samples_remaining = 0;
            }
        }
        self.current
    }
    
    /// Jump immediately to target
    fn jump(&mut self, target: f64) {
        self.current = target;
        self.target = target;
        self.samples_remaining = 0;
    }
    
    /// Reset to zero
    fn reset(&mut self) {
        self.current = 0.0;
        self.target = 0.0;
        self.samples_remaining = 0;
    }
}

// ============================================================================
// 7-Band Dynamic Loudness Compensation
// ============================================================================

/// ISO 226 inspired 7-band loudness compensation curve
/// 
/// Frequency bands and maximum boost at very low volume:
/// - 40 Hz:  +12 dB (deep bass)
/// - 100 Hz: +10 dB (bass fundamental)
/// - 300 Hz: +4 dB  (low-mids)
/// - 1 kHz:  0 dB   (reference, unchanged)
/// - 3 kHz:  +2 dB  (presence)
/// - 8 kHz:  +4 dB  (highs)
/// - 12 kHz: +6 dB  (air)
pub const LOUDNESS_BANDS: [(f64, f64, f64); 7] = [
    (40.0,   12.0,  0.0),   // freq, max_gain_db, Q (0 = shelf)
    (100.0,  10.0,  0.9),
    (300.0,  4.0,   1.0),
    (1000.0, 0.0,   1.0),   // Reference band (no boost)
    (3000.0, 2.0,   0.9),
    (8000.0, 4.0,   0.8),
    (12000.0, 6.0,  0.0),   // High shelf
];

/// Block size for coefficient updates (CPU optimization)
const BLOCK_SIZE: usize = 64;

/// Dynamic Loudness Compensation processor
/// 
/// Implements ISO 226 inspired loudness compensation using a 7-band dynamic EQ.
/// At low volumes, boosts low and high frequencies to compensate for the
/// ear's reduced sensitivity (Fletcher-Munson effect).
pub struct DynamicLoudness {
    /// Per-channel filter banks
    filters: Vec<Vec<BiquadFilter>>,
    /// Per-band parameter smoothers
    smoothers: Vec<ParameterSmoother>,
    /// Maximum boost per band (dB)
    max_gains: [f64; 7],
    /// Reference volume in dB (above this, no compensation)
    ref_volume_db: f64,
    /// Transition range in dB (from ref to max compensation)
    transition_db: f64,
    /// Pre-gain to prevent clipping from bass boost (dB)
    pre_gain_db: f64,
    /// Sample rate
    sample_rate: f64,
    /// Number of channels
    channels: usize,
    /// Processing block counter
    block_counter: usize,
    /// Current loudness factor (0.0 = full volume, 1.0 = max compensation)
    current_loudness_factor: f64,
    /// User strength multiplier (0.0 - 1.0)
    strength: f64,
    /// Enabled flag
    enabled: bool,
}

impl DynamicLoudness {
    /// Create a new DynamicLoudness processor
    pub fn new(channels: usize, sample_rate: f64) -> Self {
        let filters: Vec<Vec<BiquadFilter>> = (0..channels)
            .map(|_| {
                LOUDNESS_BANDS
                    .iter()
                    .map(|(freq, _max_gain, q)| {
                        if *q == 0.0 && *freq < 1000.0 {
                            BiquadFilter::low_shelf(*freq, 0.0, sample_rate)
                        } else if *q == 0.0 {
                            BiquadFilter::high_shelf(*freq, 0.0, sample_rate)
                        } else {
                            BiquadFilter::peaking(*freq, 0.0, *q, sample_rate)
                        }
                    })
                    .collect()
            })
            .collect();
        
        let smoothers: Vec<ParameterSmoother> = LOUDNESS_BANDS
            .iter()
            .map(|_| ParameterSmoother::new(50.0, sample_rate)) // 50ms smoothing
            .collect();
        
        let max_gains = LOUDNESS_BANDS.map(|(_, max_gain, _)| max_gain);
        
        Self {
            filters,
            smoothers,
            max_gains,
            ref_volume_db: -15.0,    // Reference: ~50% perceived loudness
            transition_db: 25.0,     // Compensation starts below -15 dB, max at -40 dB
            pre_gain_db: -3.0,       // Headroom for bass boost
            sample_rate,
            channels,
            block_counter: 0,
            current_loudness_factor: 0.0,
            strength: 1.0,
            enabled: true,
        }
    }
    
    /// Set user volume as linear value (0.0 - 1.0)
    /// This is the main control input
    pub fn set_volume(&mut self, linear_volume: f64) {
        let volume_db = if linear_volume > 0.0 {
            20.0 * linear_volume.log10()
        } else {
            f64::NEG_INFINITY
        };
        
        self.update_loudness_factor(volume_db);
    }
    
    /// Set user volume as percentage (0 - 100)
    pub fn set_volume_percent(&mut self, percent: f64) {
        self.set_volume(percent / 100.0);
    }
    
    /// Set user volume as dB
    pub fn set_volume_db(&mut self, volume_db: f64) {
        self.update_loudness_factor(volume_db);
    }
    
    /// Update loudness factor based on volume
    fn update_loudness_factor(&mut self, volume_db: f64) {
        // Calculate loudness factor (0 at ref_volume, 1 at ref_volume - transition_db)
        let factor = if volume_db >= self.ref_volume_db {
            0.0
        } else {
            ((self.ref_volume_db - volume_db) / self.transition_db).min(1.0)
        };
        
        // Update if changed significantly
        if (self.current_loudness_factor - factor).abs() > 0.0001 {
            self.current_loudness_factor = factor;
            
            // Update target gains for each band
            for (i, smoother) in self.smoothers.iter_mut().enumerate() {
                let target_gain = self.max_gains[i] * factor * self.strength;
                smoother.set_target(target_gain);
            }
        }
    }
    
    /// Set strength (0.0 - 1.0, scales all compensation)
    pub fn set_strength(&mut self, strength: f64) {
        let strength = strength.clamp(0.0, 1.0);
        if (self.strength - strength).abs() > 0.0001 {
            self.strength = strength;
            // Recalculate targets
            self.update_loudness_factor(if self.current_loudness_factor > 0.0 {
                self.ref_volume_db - self.current_loudness_factor * self.transition_db
            } else {
                self.ref_volume_db
            });
        }
    }
    
    /// Set reference volume level in dB
    pub fn set_reference_volume_db(&mut self, ref_db: f64) {
        self.ref_volume_db = ref_db.clamp(-30.0, 0.0);
    }
    
    /// Set transition range in dB
    pub fn set_transition_db(&mut self, transition_db: f64) {
        self.transition_db = transition_db.clamp(10.0, 40.0);
    }
    
    /// Enable or disable processing
    pub fn set_enabled(&mut self, enabled: bool) {
        if self.enabled && !enabled {
            // Disabling: reset all filters
            for ch_filters in &mut self.filters {
                for filter in ch_filters {
                    filter.reset();
                }
            }
            for smoother in &mut self.smoothers {
                smoother.reset();
            }
        }
        self.enabled = enabled;
    }
    
    /// Update sample rate
    pub fn set_sample_rate(&mut self, sample_rate: f64) {
        if (self.sample_rate - sample_rate).abs() > 1.0 {
            self.sample_rate = sample_rate;
            
            // Update all filters
            for ch_filters in &mut self.filters {
                for filter in ch_filters {
                    filter.set_sample_rate(sample_rate);
                }
            }
            
            // Update smoothers
            for smoother in &mut self.smoothers {
                *smoother = ParameterSmoother::new(50.0, sample_rate);
            }
        }
    }
    
    /// Process interleaved audio buffer
    pub fn process(&mut self, buffer: &mut [f64]) {
        if !self.enabled || self.strength < 0.0001 {
            return;
        }
        
        let frames = buffer.len() / self.channels;
        if frames == 0 {
            return;
        }
        
        // Apply pre-gain for headroom
        let pre_gain = if self.pre_gain_db != 0.0 {
            10.0_f64.powf(self.pre_gain_db / 20.0)
        } else {
            1.0
        };
        
        // Update filter coefficients once per block for CPU efficiency
        for chunk_start in (0..frames).step_by(BLOCK_SIZE) {
            let chunk_end = (chunk_start + BLOCK_SIZE).min(frames);
            let chunk_frames = chunk_end - chunk_start;
            
            // Update filter coefficients once per block
            for (i, smoother) in self.smoothers.iter_mut().enumerate() {
                let gain = smoother.next_block(chunk_frames);
                for ch_filters in &mut self.filters {
                    if i < ch_filters.len() {
                        ch_filters[i].set_gain_db(gain);
                    }
                }
            }
        }
        
        // Process all samples
        self.process_samples(buffer, pre_gain);
    }
    
    /// Internal: process samples after coefficient update
    fn process_samples(&mut self, buffer: &mut [f64], pre_gain: f64) {
        let frames = buffer.len() / self.channels;
        
        for frame in 0..frames {
            for ch in 0..self.channels {
                let idx = frame * self.channels + ch;
                let mut sample = buffer[idx] * pre_gain;
                
                if let Some(ch_filters) = self.filters.get_mut(ch) {
                    for filter in ch_filters {
                        sample = filter.process(sample);
                    }
                }
                
                buffer[idx] = sample;
            }
        }
    }
    
    /// Reset all filter states
    pub fn reset(&mut self) {
        for ch_filters in &mut self.filters {
            for filter in ch_filters {
                filter.reset();
            }
        }
        for smoother in &mut self.smoothers {
            smoother.reset();
        }
        self.current_loudness_factor = 0.0;
    }
    
    /// Get current loudness factor (for display)
    pub fn loudness_factor(&self) -> f64 {
        self.current_loudness_factor
    }
    
    /// Get current band gains (for display/metering)
    pub fn get_band_gains(&self) -> [f64; 7] {
        let mut gains = [0.0; 7];
        for (i, smoother) in self.smoothers.iter().enumerate() {
            gains[i] = smoother.current;
        }
        gains
    }
    
    /// Check if enabled
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }
    
    /// Get strength
    pub fn strength(&self) -> f64 {
        self.strength
    }
}

// ============================================================================
// Atomic State for Thread-Safe Control
// ============================================================================

/// Thread-safe state for DynamicLoudness control from UI thread
pub struct AtomicDynamicLoudnessState {
    /// Linear volume (0.0 - 1.0)
    pub volume: AtomicF32,
    /// Strength (0.0 - 1.0)
    pub strength: AtomicF32,
    /// Enabled flag
    pub enabled: AtomicBool,
}

impl AtomicDynamicLoudnessState {
    pub fn new() -> Self {
        Self {
            volume: AtomicF32::new(1.0),
            strength: AtomicF32::new(1.0),
            enabled: AtomicBool::new(true),
        }
    }
    
    /// Set volume (call from UI thread)
    pub fn set_volume(&self, volume: f32) {
        self.volume.store(volume.clamp(0.0, 1.0), Ordering::Relaxed);
    }
    
    /// Set strength (call from UI thread)
    pub fn set_strength(&self, strength: f32) {
        self.strength.store(strength.clamp(0.0, 1.0), Ordering::Relaxed);
    }
    
    /// Set enabled (call from UI thread)
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }
    
    /// Sync to processor (call from audio thread)
    pub fn sync_to_processor(&self, processor: &mut DynamicLoudness) {
        let volume = self.volume.load(Ordering::Relaxed) as f64;
        let strength = self.strength.load(Ordering::Relaxed) as f64;
        let enabled = self.enabled.load(Ordering::Relaxed);
        
        processor.set_volume(volume);
        processor.set_strength(strength);
        processor.set_enabled(enabled);
    }
}

impl Default for AtomicDynamicLoudnessState {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    
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
        let mut dl = DynamicLoudness::new(2, 44100.0);
        
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
        let mut dl = DynamicLoudness::new(2, 44100.0);
        dl.set_strength(0.5);
        dl.set_volume_db(-40.0); // Max compensation
        
        // With 50% strength, max low shelf boost should be 6 dB (12 * 0.5)
        let gains = dl.get_band_gains();
        assert!((gains[0] - 6.0).abs() < 0.1, "Expected 6 dB, got {}", gains[0]);
    }
    
    #[test]
    fn test_process_no_crash() {
        let mut dl = DynamicLoudness::new(2, 44100.0);
        dl.set_volume(0.1); // Low volume
        
        // Process some audio
        let mut buffer = vec![0.5; 1024];
        dl.process(&mut buffer);
        
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
        let mut current = 0.0;
        for _ in 0..1000 {
            current = smoother.next();
        }
        
        // Should be close to target
        assert!((current - 10.0).abs() < 0.1);
    }
    
    #[test]
    fn test_disabled_bypass() {
        let mut dl = DynamicLoudness::new(2, 44100.0);
        dl.set_enabled(false);
        dl.set_volume(0.1);
        
        let input = vec![0.5; 100];
        let mut buffer = input.clone();
        dl.process(&mut buffer);
        
        // When disabled, output should equal input
        for (i, o) in input.iter().zip(buffer.iter()) {
            assert!((i - o).abs() < 0.0001);
        }
    }
}
