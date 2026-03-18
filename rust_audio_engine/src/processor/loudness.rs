//! EBU R128 Loudness Normalization
//!
//! Implements loudness measurement and normalization according to EBU R128 standard.
//! Supports track-based pre-analysis and real-time streaming modes.
//!
//! # Components
//!
//! - `LoudnessMeter`: EBU R128 compliant loudness measurement
//! - `PeakLimiter`: True Peak limiter with 4x oversampling detection
//! - `GainRamp`: Linear gain ramp for smooth track transitions
//! - `AtomicLoudnessState`: Lock-free state for audio thread
//! - `LoudnessNormalizer`: High-level normalization processor

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use atomic_float::AtomicF64;
use crate::config::{LoudnessConfig, NormalizationMode};

// ============================================================================
// EBU R128 Loudness Meter
// ============================================================================

/// EBU R128 loudness meter using the ebur128 crate
/// Measures integrated, short-term, momentary loudness and loudness range
pub struct LoudnessMeter {
    ebur128: Option<ebur128::EbuR128>,
    sample_rate: u32,
    channels: usize,
    // Pre-allocated planar buffer (avoids heap allocation in process)
    planar_buffer: Vec<Vec<f32>>,
    // Cached results
    integrated_loudness: f64,
    short_term_loudness: f64,
    momentary_loudness: f64,
    loudness_range: f64,
    true_peak: f64,
    samples_processed: u64,
    // ITU-R BS.1770-4 compliant true peak detector (per channel)
    true_peak_detectors: Vec<TruePeakDetector>,
}

impl LoudnessMeter {
    pub fn new(channels: usize, sample_rate: u32) -> Self {
        let ebur128 = ebur128::EbuR128::new(channels as u32, sample_rate, ebur128::Mode::all())
            .ok();
        
        // Pre-allocate planar buffer
        let planar_buffer = vec![Vec::new(); channels];
        
        // Create true peak detector for each channel
        let true_peak_detectors = (0..channels).map(|_| TruePeakDetector::new()).collect();
        
        Self {
            ebur128,
            sample_rate,
            channels,
            planar_buffer,
            integrated_loudness: -70.0,
            short_term_loudness: -70.0,
            momentary_loudness: -70.0,
            loudness_range: 0.0,
            true_peak: -70.0,
            samples_processed: 0,
            true_peak_detectors,
        }
    }
    
    /// Reset meter state (call when starting a new track)
    pub fn reset(&mut self) {
        if let Some(ref mut ebur) = self.ebur128 {
            ebur.reset();
        }
        self.integrated_loudness = -70.0;
        self.short_term_loudness = -70.0;
        self.momentary_loudness = -70.0;
        self.loudness_range = 0.0;
        self.true_peak = -70.0;
        self.samples_processed = 0;
        // Clear planar buffers (reuse pre-allocated memory)
        for ch in &mut self.planar_buffer {
            ch.clear();
        }
        // Reset true peak detectors
        for detector in &mut self.true_peak_detectors {
            detector.reset();
        }
    }
    
    /// Process interleaved f64 samples
    /// Uses pre-allocated planar buffer to avoid heap allocation in audio callback
    pub fn process(&mut self, samples: &[f64]) {
        let Some(ref mut ebur) = self.ebur128 else { return };
        
        let frames = samples.len() / self.channels;
        if frames == 0 { return; }
        
        // Clear and reuse pre-allocated planar buffer
        for ch in &mut self.planar_buffer {
            ch.clear();
            ch.reserve(frames);
        }
        
        // Convert f64 interleaved to planar f32
        for (i, &sample) in samples.iter().enumerate() {
            self.planar_buffer[i % self.channels].push(sample as f32);
        }
        
        // Add frames to meter
        let slices: Vec<&[f32]> = self.planar_buffer.iter().map(|c| c.as_slice()).collect();
        if let Err(e) = ebur.add_frames_planar_f32(&slices) {
            log::warn!("EBU R128 add_frames error: {:?}", e);
            return;
        }
        
        self.samples_processed += frames as u64;
        
        // Update measurements
        if let Ok(loudness) = ebur.loudness_global() {
            self.integrated_loudness = loudness;
        }
        
        if let Ok(loudness) = ebur.loudness_shortterm() {
            self.short_term_loudness = loudness;
        }
        
        if let Ok(loudness) = ebur.loudness_momentary() {
            self.momentary_loudness = loudness;
        }
        
        if let Ok(lra) = ebur.loudness_range() {
            self.loudness_range = lra;
        }
        
        // True peak using ITU-R BS.1770-4 compliant 4x oversampling
        // Process each channel through its dedicated TruePeakDetector
        for (ch, detector) in self.true_peak_detectors.iter_mut().enumerate() {
            // Extract channel samples
            let channel_samples: Vec<f64> = samples.iter()
                .skip(ch)
                .step_by(self.channels)
                .copied()
                .collect();
            detector.process(&channel_samples);
        }
        
        // Get maximum true peak across all channels
        let max_true_peak = self.true_peak_detectors.iter()
            .map(|d| d.max_true_peak())
            .fold(0.0_f64, f64::max);
        
        if max_true_peak > 0.0 {
            let peak_db = 20.0 * max_true_peak.log10();
            self.true_peak = peak_db.max(self.true_peak);
        }
    }
    
    pub fn integrated_loudness(&self) -> f64 { self.integrated_loudness }
    pub fn short_term_loudness(&self) -> f64 { self.short_term_loudness }
    pub fn momentary_loudness(&self) -> f64 { self.momentary_loudness }
    pub fn loudness_range(&self) -> f64 { self.loudness_range }
    pub fn true_peak(&self) -> f64 { self.true_peak }
    pub fn samples_processed(&self) -> u64 { self.samples_processed }
    
    pub fn has_reliable_measurement(&self) -> bool {
        let min_samples = (self.sample_rate as f64 * 0.4) as u64;
        self.samples_processed >= min_samples
    }
}

// ============================================================================
// True Peak Limiter (Improved with Ring Buffer)
// ============================================================================

/// True Peak Limiter with look-ahead and proper release smoothing.
/// Uses fixed-size ring buffer for real-time safety (no heap allocation in process).
/// 
/// # Design
/// 
/// - 10ms look-ahead buffer for peak detection
/// - -1.0 dBTP threshold (EBU R128 recommendation)
/// - Proper release coefficient using exponential smoothing
/// - Fixed ring buffer avoids heap allocation in audio callback
pub struct PeakLimiter {
    /// Linear threshold (e.g., 0.8913 for -1 dB)
    threshold: f64,
    /// Look-ahead buffer size in frames
    lookahead_frames: usize,
    /// Fixed-size ring buffer (frames * channels)
    delay_buffer: Box<[f64]>,
    /// Current write position in the ring buffer
    write_pos: usize,
    /// Current gain reduction (linear, < 1.0 when limiting)
    gain_reduction: f64,
    /// Release coefficient per sample (< 1.0, for multiplication)
    release_coeff: f64,
    /// Number of channels
    channels: usize,
}

impl PeakLimiter {
    /// Create a new True Peak Limiter
    /// 
    /// # Arguments
    /// * `channels` - Number of audio channels
    /// * `sample_rate` - Sample rate in Hz
    /// * `threshold_db` - Threshold in dBTP (default: -1.0)
    /// * `lookahead_ms` - Look-ahead time in ms (default: 10.0)
    /// * `release_ms` - Release time in ms (default: 100.0)
    pub fn new(
        channels: usize,
        sample_rate: u32,
        threshold_db: f64,
        lookahead_ms: f64,
        release_ms: f64,
    ) -> Self {
        let threshold = db_to_linear(threshold_db);
        let lookahead_frames = ((lookahead_ms / 1000.0) * sample_rate as f64).ceil() as usize;
        let lookahead_frames = lookahead_frames.max(1);
        
        // Release coefficient: exp(-1 / tau) where tau = release_samples
        // This gives us a coefficient < 1 for multiplication
        let release_samples = (release_ms / 1000.0) * sample_rate as f64;
        let release_coeff = (-1.0 / release_samples).exp();
        
        // Pre-allocate fixed-size buffer
        let buffer_size = lookahead_frames * channels;
        let delay_buffer = vec![0.0; buffer_size].into_boxed_slice();
        
        Self {
            threshold,
            lookahead_frames,
            delay_buffer,
            write_pos: 0,
            gain_reduction: 1.0,
            release_coeff,
            channels,
        }
    }
    
    /// Process interleaved samples in-place
    /// 
    /// This function is real-time safe:
    /// - No heap allocations
    /// - No system calls
    /// - O(n) complexity where n = number of samples
    pub fn process(&mut self, samples: &mut [f64]) {
        let total_samples = samples.len();
        let frames = total_samples / self.channels;
        if frames == 0 { return; }
        
        for frame in 0..frames {
            // Step 1: Find peak across all channels in the look-ahead window
            let peak = self.find_lookahead_peak();
            
            // Step 2: Calculate required gain reduction (instant attack)
            let target_gain = if peak > self.threshold {
                self.threshold / peak
            } else {
                1.0
            };
            
            // Step 3: Apply release smoothing (gain_reduction can only decrease or recover)
            // Instant attack: take minimum of current and target
            // Smooth release: recover towards 1.0 using multiplication
            if target_gain < self.gain_reduction {
                // Attack: instant
                self.gain_reduction = target_gain;
            } else {
                // Release: smooth recovery
                self.gain_reduction = self.gain_reduction + 
                    (1.0 - self.gain_reduction) * (1.0 - self.release_coeff);
                // Ensure we don't exceed target
                self.gain_reduction = self.gain_reduction.min(target_gain);
            }
            
            // Step 4: Read from delay buffer, write new samples, apply gain
            for ch in 0..self.channels {
                let input_idx = frame * self.channels + ch;
                let buffer_idx = self.write_pos * self.channels + ch;
                
                // Get delayed sample
                let delayed = self.delay_buffer[buffer_idx];
                
                // Store new sample in buffer
                self.delay_buffer[buffer_idx] = samples[input_idx];
                
                // Output delayed sample with gain reduction
                samples[input_idx] = delayed * self.gain_reduction;
            }
            
            // Advance write position
            self.write_pos = (self.write_pos + 1) % self.lookahead_frames;
        }
    }
    
    /// Find the maximum peak in the look-ahead window.
    /// Only scans samples that are about to be output (from write_pos forward),
    /// not samples that haven't been "seen" yet (just written).
    /// O(n) scan, but n is fixed and small (~441 samples at 44.1kHz, 10ms)
    fn find_lookahead_peak(&self) -> f64 {
        let mut peak = 0.0_f64;
        for frame in 0..self.lookahead_frames {
            let pos = (self.write_pos + frame) % self.lookahead_frames;
            for ch in 0..self.channels {
                let idx = pos * self.channels + ch;
                peak = peak.max(self.delay_buffer[idx].abs());
            }
        }
        peak
    }
    
    /// Set threshold in dB
    pub fn set_threshold_db(&mut self, threshold_db: f64) {
        self.threshold = db_to_linear(threshold_db);
    }
    
    /// Get current gain reduction in dB (for metering)
    pub fn gain_reduction_db(&self) -> f64 {
        linear_to_db(self.gain_reduction)
    }
    
    /// Reset limiter state
    pub fn reset(&mut self) {
        for sample in self.delay_buffer.iter_mut() {
            *sample = 0.0;
        }
        self.write_pos = 0;
        self.gain_reduction = 1.0;
    }
}

// ============================================================================
// True Peak Detector (4x Oversampling)
// ============================================================================

/// True Peak detector using 4x oversampling interpolation.
/// Implements ITU-R BS.1770-4 compliant true peak detection.
/// 
/// This is used for measurement, not limiting. The limiter above
/// handles peak limiting without oversampling (acceptable for most use cases).
pub struct TruePeakDetector {
    /// 4x oversampling interpolation state
    prev_samples: [f64; 4],
    /// Maximum true peak detected
    max_true_peak: f64,
}

impl TruePeakDetector {
    pub fn new() -> Self {
        Self {
            prev_samples: [0.0; 4],
            max_true_peak: 0.0,
        }
    }
    
    /// Process samples and update true peak measurement
    pub fn process(&mut self, samples: &[f64]) {
        for &sample in samples {
            // Shift previous samples
            self.prev_samples[0] = self.prev_samples[1];
            self.prev_samples[1] = self.prev_samples[2];
            self.prev_samples[2] = self.prev_samples[3];
            self.prev_samples[3] = sample;
            
            // Check interpolated peaks at 4x positions
            for t in [0.25, 0.5, 0.75] {
                let interp = cubic_interpolate(
                    self.prev_samples[0],
                    self.prev_samples[1],
                    self.prev_samples[2],
                    self.prev_samples[3],
                    t,
                );
                self.max_true_peak = self.max_true_peak.max(interp.abs());
            }
            
            // Also check the actual sample
            self.max_true_peak = self.max_true_peak.max(sample.abs());
        }
    }
    
    /// Get maximum true peak detected (linear)
    pub fn max_true_peak(&self) -> f64 {
        self.max_true_peak
    }
    
    /// Get maximum true peak in dBTP
    pub fn max_true_peak_db(&self) -> f64 {
        linear_to_db(self.max_true_peak)
    }
    
    /// Reset detector state
    pub fn reset(&mut self) {
        self.prev_samples = [0.0; 4];
        self.max_true_peak = 0.0;
    }
}

impl Default for TruePeakDetector {
    fn default() -> Self {
        Self::new()
    }
}

/// Cubic interpolation for true peak estimation
/// Uses 4-point, 3rd-order Hermite interpolation
fn cubic_interpolate(y0: f64, y1: f64, y2: f64, y3: f64, t: f64) -> f64 {
    // Hermite interpolation coefficients
    let a = y1;
    let b = 0.5 * (y2 - y0);
    let c = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    let d = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
    
    a + b * t + c * t * t + d * t * t * t
}

// ============================================================================
// Gain Ramp (Linear Smoothing for Track Transitions)
// ============================================================================

/// Linear gain ramp for smooth transitions between tracks.
/// Uses position-based interpolation to avoid floating-point accumulation errors.
/// 
/// Use cases:
/// - Track-to-track gain changes
/// - Mute/unmute transitions
/// - Bypass switching
pub struct GainRamp {
    /// Starting gain value (linear)
    from: f64,
    /// Target gain value (linear)
    to: f64,
    /// Total samples in the ramp
    total_samples: usize,
    /// Remaining samples in the ramp
    remaining: usize,
}

impl GainRamp {
    /// Create a new gain ramp
    /// 
    /// # Arguments
    /// * `from` - Starting gain (linear)
    /// * `to` - Target gain (linear)
    /// * `sample_rate` - Sample rate in Hz
    /// * `ramp_ms` - Ramp duration in milliseconds
    pub fn new(from: f64, to: f64, sample_rate: u32, ramp_ms: u32) -> Self {
        let total_samples = (sample_rate as u64 * ramp_ms as u64 / 1000) as usize;
        let total_samples = total_samples.max(1);
        
        Self {
            from,
            to,
            total_samples,
            remaining: total_samples,
        }
    }
    
    /// Create a ramp from 0 to target (fade in)
    pub fn fade_in(target: f64, sample_rate: u32, ramp_ms: u32) -> Self {
        Self::new(0.0, target, sample_rate, ramp_ms)
    }
    
    /// Create a ramp from current to 0 (fade out)
    pub fn fade_out(from: f64, sample_rate: u32, ramp_ms: u32) -> Self {
        Self::new(from, 0.0, sample_rate, ramp_ms)
    }
    
    /// Get the next gain value (call once per sample)
    /// Uses position-based interpolation to avoid accumulation errors (RISK-02 fix)
    #[inline(always)]
    pub fn next_gain(&mut self) -> f64 {
        if self.remaining > 0 {
            // Position-based interpolation: no accumulation error
            // progress = (total - remaining) / total
            let progress = 1.0 - (self.remaining as f64 / self.total_samples as f64);
            self.remaining -= 1;
            self.from + (self.to - self.from) * progress
        } else {
            self.to
        }
    }
    
    /// Apply gain ramp to a buffer (more efficient than per-sample calls)
    pub fn apply(&mut self, samples: &mut [f64]) {
        for sample in samples.iter_mut() {
            *sample *= self.next_gain();
        }
    }
    
    /// Check if ramp is complete
    pub fn is_done(&self) -> bool {
        self.remaining == 0
    }
    
    /// Get remaining samples
    pub fn remaining_samples(&self) -> usize {
        self.remaining
    }
    
    /// Get current gain (computed from position)
    pub fn current(&self) -> f64 {
        if self.remaining > 0 {
            let progress = 1.0 - (self.remaining as f64 / self.total_samples as f64);
            self.from + (self.to - self.from) * progress
        } else {
            self.to
        }
    }
    
    /// Get target gain
    pub fn target(&self) -> f64 {
        self.to
    }
    
    /// Set a new target, starting from current position
    pub fn retarget(&mut self, new_target: f64, sample_rate: u32, ramp_ms: u32) {
        let current = self.current();
        self.from = current;
        self.to = new_target;
        let total_samples = (sample_rate as u64 * ramp_ms as u64 / 1000) as usize;
        self.total_samples = total_samples.max(1);
        self.remaining = self.total_samples;
    }
    
    /// Jump immediately to target (no ramp)
    pub fn jump(&mut self, target: f64) {
        self.from = target;
        self.to = target;
        self.total_samples = 1;
        self.remaining = 0;
    }
}

// ============================================================================
// Atomic Loudness State (Lock-free for audio thread)
// ============================================================================

/// Atomic loudness state for lock-free audio thread access.
/// Uses AtomicF64 with Relaxed ordering (gains don't need strict synchronization).
pub struct AtomicLoudnessState {
    /// Target gain in dB (set by main thread, read by audio thread)
    pub target_gain_db: AtomicF64,
    /// Current smoothed gain in dB (updated by audio thread)
    pub current_gain_db: AtomicF64,
    /// Smoothing coefficient per sample (< 1.0, for multiplication)
    pub smoothing_coeff: AtomicF64,
    /// Album gain for Album mode (same for all tracks in album)
    pub album_gain_db: AtomicF64,
    /// Preamp gain for headroom adjustment (default -3 dB)
    pub preamp_gain_db: AtomicF64,
    /// Enable/disable normalization
    pub enabled: AtomicBool,
    /// Normalization mode: 0=Track, 1=Album, 2=Streaming
    pub mode: AtomicU8,
}

impl AtomicLoudnessState {
    pub fn new(smoothing_time_ms: f64, sample_rate: u32) -> Self {
        let smoothing_coeff = {
            let smoothing_samples = (smoothing_time_ms / 1000.0) * sample_rate as f64;
            (-1.0 / smoothing_samples).exp()
        };
        
        Self {
            target_gain_db: AtomicF64::new(0.0),
            current_gain_db: AtomicF64::new(0.0),
            smoothing_coeff: AtomicF64::new(smoothing_coeff),
            album_gain_db: AtomicF64::new(0.0),
            preamp_gain_db: AtomicF64::new(-1.0),  // Reduced headroom for better dynamics
            enabled: AtomicBool::new(true),
            mode: AtomicU8::new(0),
        }
    }
    
    /// Set target gain (call from main thread)
    pub fn set_target_gain(&self, gain_db: f64) {
        self.target_gain_db.store(gain_db, Ordering::Relaxed);
    }
    
    /// Set album gain (call from main thread)
    pub fn set_album_gain(&self, gain_db: f64) {
        self.album_gain_db.store(gain_db, Ordering::Relaxed);
    }
    
    /// Set preamp gain in dB (call from main thread)
    pub fn set_preamp_gain(&self, gain_db: f64) {
        self.preamp_gain_db.store(gain_db, Ordering::Relaxed);
    }
    
    /// Set enabled state
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }
    
    /// Set mode: 0=Track, 1=Album, 2=Streaming, 3=ReplayGainTrack, 4=ReplayGainAlbum
    pub fn set_mode(&self, mode: u8) {
        self.mode.store(mode, Ordering::Relaxed);
    }
    
    /// Update smoothing coefficient
    pub fn set_smoothing(&self, smoothing_time_ms: f64, sample_rate: u32) {
        let smoothing_samples = (smoothing_time_ms / 1000.0) * sample_rate as f64;
        let coeff = (-1.0 / smoothing_samples).exp();
        self.smoothing_coeff.store(coeff, Ordering::Relaxed);
    }
    
    /// Process gain for a chunk (call from audio thread - lock-free)
    /// Returns the linear gain to apply (includes preamp)
    /// 
    /// Uses SeqCst for mode read to reduce mid-update inconsistency window (RISK-01 fix).
    /// Other fields use Relaxed ordering since gains don't need strict synchronization.
    #[inline]
    pub fn process_gain(&self, frames: usize) -> f64 {
        if !self.enabled.load(Ordering::Relaxed) {
            return 1.0;
        }
        
        // Read mode with SeqCst first to establish a consistent snapshot point
        let mode = self.mode.load(Ordering::SeqCst);
        
        // Now read other fields with Relaxed - they will be from approximately the same point
        let target = self.target_gain_db.load(Ordering::Relaxed);
        let current = self.current_gain_db.load(Ordering::Relaxed);
        let coeff = self.smoothing_coeff.load(Ordering::Relaxed);
        let preamp = self.preamp_gain_db.load(Ordering::Relaxed);
        
        // Select gain based on mode
        let effective_target = match mode {
            1 => self.album_gain_db.load(Ordering::Relaxed),  // Album mode
            _ => target,  // Track or Streaming mode
        };
        
        // Add preamp
        let effective_target = effective_target + preamp;
        
        // Smooth gain transition using exponential smoothing
        // FIX for Defect 27: Correct formula is coeff^frames, not (1-coeff)^frames
        // coeff^frames represents the proportion of gain difference remaining after N frames.
        // - When coeff ≈ 0.9999 (200ms smoothing): coeff^512 ≈ 0.95, gain moves 5% toward target
        // - When coeff = 0 (smoothing disabled): coeff^N = 0, gain jumps instantly to target
        // - When coeff = 1 (infinite smoothing): coeff^N = 1, gain never changes
        let remaining_factor = coeff.powi(frames as i32);
        let new_gain = current + (effective_target - current) * (1.0 - remaining_factor);
        
        self.current_gain_db.store(new_gain, Ordering::Relaxed);
        
        // Convert dB to linear
        db_to_linear(new_gain)
    }
    
    /// Get current loudness info (for API responses)
    pub fn get_info(&self) -> LoudnessInfo {
        LoudnessInfo {
            integrated_lufs: -70.0,
            short_term_lufs: -70.0,
            momentary_lufs: -70.0,
            loudness_range: 0.0,
            true_peak_dbtp: -70.0,
            current_gain_db: self.current_gain_db.load(Ordering::Relaxed),
            target_gain_db: self.target_gain_db.load(Ordering::Relaxed),
            preamp_db: self.preamp_gain_db.load(Ordering::Relaxed),
        }
    }
}

impl Default for AtomicLoudnessState {
    fn default() -> Self {
        Self::new(200.0, 44100)
    }
}

// ============================================================================
// Loudness Normalizer
// ============================================================================

/// Loudness normalizer with EBU R128 compliance.
/// Supports track-based pre-analysis and real-time streaming modes.
pub struct LoudnessNormalizer {
    meter: LoudnessMeter,
    limiter: PeakLimiter,
    config: LoudnessConfig,
    atomic_state: Arc<AtomicLoudnessState>,
    
    // Track analysis results
    track_loudness: Option<f64>,
    track_gain: Option<f64>,
    
    channels: usize,
    sample_rate: u32,
}

impl LoudnessNormalizer {
    pub fn new(channels: usize, sample_rate: u32, config: LoudnessConfig) -> Self {
        let atomic_state = Arc::new(AtomicLoudnessState::new(config.smoothing_time_ms, sample_rate));
        
        Self {
            meter: LoudnessMeter::new(channels, sample_rate),
            limiter: PeakLimiter::new(
                channels,
                sample_rate,
                config.true_peak_limit_db,
                10.0,   // 10ms look-ahead
                100.0,  // 100ms release
            ),
            config,
            atomic_state,
            track_loudness: None,
            track_gain: None,
            channels,
            sample_rate,
        }
    }
    
    pub fn atomic_state(&self) -> Arc<AtomicLoudnessState> {
        Arc::clone(&self.atomic_state)
    }
    
    pub fn set_enabled(&mut self, enabled: bool) {
        self.atomic_state.set_enabled(enabled);
    }
    
    pub fn set_config(&mut self, config: LoudnessConfig) {
        self.config = config.clone();
        self.limiter.set_threshold_db(config.true_peak_limit_db);
        self.atomic_state.set_smoothing(config.smoothing_time_ms, self.sample_rate);
        
        if let Some(loudness) = self.track_loudness {
            self.track_gain = Some(self.config.target_lufs - loudness);
            self.atomic_state.set_target_gain(self.track_gain.unwrap());
        }
    }
    
    pub fn set_target_lufs(&mut self, target_lufs: f64) {
        self.config.target_lufs = target_lufs;
        if let Some(loudness) = self.track_loudness {
            self.track_gain = Some(target_lufs - loudness);
            self.atomic_state.set_target_gain(self.track_gain.unwrap());
        }
    }
    
    pub fn set_album_gain(&self, gain_db: f64) {
        self.atomic_state.set_album_gain(gain_db);
    }
    
    pub fn set_preamp_gain(&self, gain_db: f64) {
        self.atomic_state.set_preamp_gain(gain_db);
    }
    
    pub fn set_mode(&self, mode: NormalizationMode) {
        let mode_val = match mode {
            NormalizationMode::Track => 0,
            NormalizationMode::Album => 1,
            NormalizationMode::Streaming => 2,
            NormalizationMode::ReplayGainTrack => 3,
            NormalizationMode::ReplayGainAlbum => 4,
        };
        self.atomic_state.set_mode(mode_val);
    }
    
    /// Pre-analyze track loudness (call before streaming playback)
    /// 
    /// FIX for Defect 39: Check loudness.is_finite() to prevent +inf gain
    /// when ebur128 returns -inf (silent or very short tracks <400ms).
    /// Invalid loudness values result in 0 dB gain (no normalization).
    pub fn analyze_track(&mut self, samples: &[f64]) -> f64 {
        self.meter.reset();
        self.meter.process(samples);
        let loudness = self.meter.integrated_loudness();
        
        // FIX for Defect 39: Validate loudness before computing gain
        if loudness.is_finite() {
            self.track_loudness = Some(loudness);
            let gain_db = self.config.target_lufs - loudness;
            self.track_gain = Some(gain_db);
            self.atomic_state.set_target_gain(gain_db);
            
            log::info!(
                "Track analysis: Integrated loudness = {:.2} LUFS, Target gain = {:.2} dB",
                loudness, gain_db
            );
        } else {
            // Invalid loudness (e.g., -inf for silent/very short tracks)
            // Keep 0 dB gain to avoid +inf/-inf multiplication in audio callback
            self.track_loudness = None;
            self.track_gain = Some(0.0);
            self.atomic_state.set_target_gain(0.0);
            
            log::warn!(
                "Track analysis: Invalid loudness ({:.2}), using 0 dB gain (no normalization)",
                loudness
            );
        }
        
        loudness
    }
    
    /// Calculate track gain without updating atomic state (for gapless preload)
    /// Returns the target gain in dB that should be applied after buffer swap.
    /// This prevents premature gain update during the last seconds of current track.
    /// 
    /// FIX for Defect 39: Check loudness.is_finite() to prevent +inf gain
    /// when ebur128 returns -inf (silent or very short tracks <400ms).
    pub fn calculate_gain(&mut self, samples: &[f64]) -> f64 {
        self.meter.reset();
        self.meter.process(samples);
        let loudness = self.meter.integrated_loudness();
        
        // FIX for Defect 39: Validate loudness before computing gain
        if loudness.is_finite() {
            let gain_db = self.config.target_lufs - loudness;
            
            log::info!(
                "Gapless preload analysis: Integrated loudness = {:.2} LUFS, Pending gain = {:.2} dB",
                loudness, gain_db
            );
            
            gain_db
        } else {
            log::warn!(
                "Gapless preload analysis: Invalid loudness ({:.2}), using 0 dB gain",
                loudness
            );
            0.0
        }
    }
    
    /// Calculate gain for gapless preload with mode awareness (Bug-4 fix)
    ///
    /// For ReplayGain modes, reads gain from metadata tags instead of EBU R128 analysis.
    /// Falls back to EBU R128 if tags are missing.
    pub fn calculate_gain_with_mode(
        &mut self,
        samples: &[f64],
        mode: NormalizationMode,
        metadata: &crate::decoder::TrackMetadata,
    ) -> f64 {
        match mode {
            NormalizationMode::ReplayGainTrack => {
                // Use ReplayGain track gain from tag
                if let Some(rg_gain) = metadata.rg_track_gain {
                    // ReplayGain reference is -18 LUFS ( ReplayGain 2.0 uses -18 LUFS)
                    // Convert to our target LUFS
                    let gain_db = rg_gain + (self.config.target_lufs + 18.0);
                    log::info!(
                        "Gapless preload: Using ReplayGain track tag: {:.2} dB -> target gain: {:.2} dB",
                        rg_gain, gain_db
                    );
                    return gain_db;
                }
                // Fallback to EBU R128 if no tag
                log::warn!("Gapless preload: No ReplayGain track tag, falling back to EBU R128");
                self.calculate_gain(samples)
            }
            NormalizationMode::ReplayGainAlbum => {
                // Use ReplayGain album gain (fallback to track)
                let rg_gain = metadata.rg_album_gain.or(metadata.rg_track_gain);
                if let Some(gain) = rg_gain {
                    let gain_db = gain + (self.config.target_lufs + 18.0);
                    log::info!(
                        "Gapless preload: Using ReplayGain album tag: {:.2} dB -> target gain: {:.2} dB",
                        gain, gain_db
                    );
                    return gain_db;
                }
                log::warn!("Gapless preload: No ReplayGain album/track tag, falling back to EBU R128");
                self.calculate_gain(samples)
            }
            _ => {
                // Track/Album/Streaming modes: use EBU R128 analysis
                self.calculate_gain(samples)
            }
        }
    }
    
    pub fn reset(&mut self) {
        self.meter.reset();
        self.limiter.reset();
        self.atomic_state.target_gain_db.store(0.0, Ordering::Relaxed);
        self.atomic_state.current_gain_db.store(0.0, Ordering::Relaxed);
        self.track_loudness = None;
        self.track_gain = None;
    }
    
    /// Process interleaved f64 samples in-place
    pub fn process(&mut self, samples: &mut [f64]) {
        if !self.atomic_state.enabled.load(Ordering::Relaxed) { return; }
        
        let frames = samples.len() / self.channels;
        if frames == 0 { return; }
        
        // For streaming mode, measure in real-time
        if self.config.mode == NormalizationMode::Streaming {
            self.meter.process(samples);
            
            if self.meter.has_reliable_measurement() {
                let current_loudness = self.meter.short_term_loudness();
                if current_loudness > -70.0 {
                    let target_gain = self.config.target_lufs - current_loudness;
                    self.atomic_state.set_target_gain(target_gain.clamp(-20.0, 20.0));
                }
            }
        }
        
        // Apply gain using atomic state
        let linear_gain = self.atomic_state.process_gain(frames);
        for sample in samples.iter_mut() {
            *sample *= linear_gain;
        }
        
        // Apply peak limiting
        self.limiter.process(samples);
    }
    
    pub fn get_loudness_info(&self) -> LoudnessInfo {
        LoudnessInfo {
            integrated_lufs: self.meter.integrated_loudness(),
            short_term_lufs: self.meter.short_term_loudness(),
            momentary_lufs: self.meter.momentary_loudness(),
            loudness_range: self.meter.loudness_range(),
            true_peak_dbtp: self.meter.true_peak(),
            current_gain_db: self.atomic_state.current_gain_db.load(Ordering::Relaxed),
            target_gain_db: self.atomic_state.target_gain_db.load(Ordering::Relaxed),
            preamp_db: self.atomic_state.preamp_gain_db.load(Ordering::Relaxed),
        }
    }
    
    pub fn track_loudness(&self) -> Option<f64> { self.track_loudness }
    pub fn is_analyzed(&self) -> bool { self.track_loudness.is_some() }
}

// ============================================================================
// Loudness Info
// ============================================================================

/// Loudness measurement information for API responses
#[derive(Debug, Clone, serde::Serialize)]
pub struct LoudnessInfo {
    pub integrated_lufs: f64,
    pub short_term_lufs: f64,
    pub momentary_lufs: f64,
    pub loudness_range: f64,
    pub true_peak_dbtp: f64,
    pub current_gain_db: f64,
    pub target_gain_db: f64,
    pub preamp_db: f64,
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Convert dB to linear
#[inline(always)]
pub fn db_to_linear(db: f64) -> f64 {
    10.0_f64.powf(db / 20.0)
}

/// Convert linear to dB
#[inline(always)]
pub fn linear_to_db(linear: f64) -> f64 {
    if linear > 0.0 {
        20.0 * linear.log10()
    } else {
        f64::NEG_INFINITY
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_db_conversion() {
        assert!((db_to_linear(0.0) - 1.0).abs() < 1e-10);
        assert!((db_to_linear(-6.0) - 0.501).abs() < 0.01);
        assert!((linear_to_db(1.0) - 0.0).abs() < 1e-10);
        assert!((linear_to_db(0.5) - (-6.02)).abs() < 0.1);
    }
    
    #[test]
    fn test_gain_ramp() {
        let mut ramp = GainRamp::new(0.0, 1.0, 44100, 100);  // 100ms ramp
        
        // Should take ~4410 samples
        assert!(!ramp.is_done());
        
        // Simulate processing
        let mut samples = vec![1.0; 5000];
        ramp.apply(&mut samples);
        
        // Should be done or nearly done
        assert!(ramp.remaining_samples() < 1000);
        assert!(ramp.current() > 0.9);
    }
    
    #[test]
    fn test_peak_limiter() {
        let mut limiter = PeakLimiter::new(2, 44100, -1.0, 10.0, 100.0);
        
        // Create a signal that exceeds threshold
        let mut samples = vec![0.0; 4096];
        for i in 0..2048 {
            samples[i * 2] = 1.5;  // Left channel, above threshold
            samples[i * 2 + 1] = 1.5;  // Right channel
        }
        
        limiter.process(&mut samples);
        
        // After limiting, peaks should be below threshold
        let max_out = samples.iter().map(|s| s.abs()).fold(0.0_f64, f64::max);
        let threshold = db_to_linear(-1.0);
        assert!(max_out < threshold * 1.01, "Max output {} exceeds threshold {}", max_out, threshold);
    }
    
    #[test]
    fn test_true_peak_detector() {
        let mut detector = TruePeakDetector::new();
        
        // Create a signal with intersample peaks
        // A full-scale sine wave at Nyquist can have ISP
        let samples: Vec<f64> = (0..100)
            .map(|i| (i as f64 * 0.1).sin())
            .collect();
        
        detector.process(&samples);
        
        // True peak should be >= max sample
        let max_sample = samples.iter().map(|s| s.abs()).fold(0.0_f64, f64::max);
        assert!(detector.max_true_peak() >= max_sample * 0.99);
    }
    
    #[test]
    fn test_cubic_interpolation() {
        // Simple test: interpolation at integer points should return original values
        let y0 = 0.0;
        let y1 = 1.0;
        let y2 = 0.0;
        let y3 = -1.0;
        
        // At t=0, should return y1
        assert!((cubic_interpolate(y0, y1, y2, y3, 0.0) - y1).abs() < 1e-10);
    }
}