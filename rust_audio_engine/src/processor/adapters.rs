//! Processor Adapters
//!
//! Wraps existing processors with the AudioProcessor trait, enabling
//! lock-free parameter passing and unified DSP chain management.
//!
//! Each adapter:
//! - Owns the actual processor (audio thread exclusive)
//! - References lock-free parameters (shared with main thread)
//! - Synchronizes parameters before processing

use std::sync::Arc;

use super::traits::{AudioProcessor, ProcessResult, SampleRateAware, ChannelAware};
use super::lockfree_params::*;
use super::eq::Equalizer;
use super::saturation::Saturation;
use super::crossfeed::Crossfeed;
use super::loudness::PeakLimiter;
use super::dsp::NoiseShaper;
use super::dynamic_loudness::DynamicLoudness;
// ============================================================================
// EQ Adapter
// ============================================================================

/// Equalizer processor adapter with lock-free parameters
pub struct EqProcessor {
    /// Internal EQ processor (audio thread exclusive)
    eq: Equalizer,
    /// Channel count for reinitialization
    channels: usize,
    /// Lock-free parameters reference
    params: Arc<AtomicEqParams>,
    /// Local parameter cache
    cached: EqParamsSnapshot,
    /// Sample rate for coefficient recalculation
    sample_rate: f64,
}

impl EqProcessor {
    /// Create new EQ processor with lock-free params
    pub fn new(channels: usize, sample_rate: f64, params: Arc<AtomicEqParams>) -> Self {
        Self {
            eq: Equalizer::new(channels, sample_rate),
            channels,
            params,
            cached: EqParamsSnapshot::default(),
            sample_rate,
        }
    }

    /// Synchronize parameters from lock-free storage
    fn sync_params(&mut self) {
        if self.params.has_update() {
            self.cached = self.params.read();

            // Apply to internal EQ
            self.eq.set_all_bands(&self.cached.gains, self.sample_rate);
            self.eq.set_enabled(self.cached.enabled);
        }
    }
}

impl AudioProcessor for EqProcessor {
    fn name(&self) -> &'static str {
        "Equalizer"
    }

    fn process(&mut self, buffer: &mut [f64], _channels: usize) -> ProcessResult {
        self.sync_params();

        if !self.cached.enabled {
            return ProcessResult::Bypassed;
        }

        self.eq.process(buffer);
        ProcessResult::Ok
    }

    fn reset(&mut self) {
        self.eq.reset();
    }

    fn is_enabled(&self) -> bool {
        self.cached.enabled
    }

    fn set_enabled(&mut self, enabled: bool) {
        self.params.set_enabled(enabled);
    }

    fn set_sample_rate(&mut self, sample_rate: f64) {
        SampleRateAware::set_sample_rate(self, sample_rate);
    }
}

impl SampleRateAware for EqProcessor {
    fn sample_rate(&self) -> f64 {
        self.sample_rate
    }

    fn set_sample_rate(&mut self, sr: f64) {
        self.sample_rate = sr;
        self.eq = Equalizer::new(self.channels, sr);
        // Re-apply cached params
        self.eq.set_all_bands(&self.cached.gains, sr);
        self.eq.set_enabled(self.cached.enabled);
    }
}

// ============================================================================
// Saturation Adapter
// ============================================================================

/// Saturation processor adapter
pub struct SaturationProcessor {
    saturation: Saturation,
    params: Arc<AtomicSaturationParams>,
    cached: SaturationParamsSnapshot,
    sample_rate: f64,
}

impl SaturationProcessor {
    pub fn new(params: Arc<AtomicSaturationParams>) -> Self {
        Self {
            saturation: Saturation::new(),
            params,
            cached: SaturationParamsSnapshot::default(),
            sample_rate: 44100.0,
        }
    }

    fn sync_params(&mut self) {
        if self.params.has_update() {
            self.cached = self.params.read();
            self.params.clear_dirty();

            // Apply to saturation processor
            self.saturation.set_drive(self.cached.drive);
            self.saturation.set_threshold(self.cached.threshold);
            self.saturation.set_mix(self.cached.mix);
            self.saturation.set_input_gain(self.cached.input_gain_db);
            self.saturation.set_output_gain(self.cached.output_gain_db);
            self.saturation.set_highpass_mode(self.cached.highpass_mode);
            self.saturation.set_highpass_cutoff(self.cached.highpass_cutoff);
            self.saturation.set_enabled(self.cached.enabled);

            // M-4 fix: use From trait for type-safe conversion
            self.saturation.set_type(super::saturation::SaturationType::from(self.cached.sat_type));
        }
    }
}

impl AudioProcessor for SaturationProcessor {
    fn name(&self) -> &'static str {
        "Saturation"
    }

    fn process(&mut self, buffer: &mut [f64], channels: usize) -> ProcessResult {
        self.sync_params();

        if !self.cached.enabled {
            return ProcessResult::Bypassed;
        }

        self.saturation.process_with_channels(buffer, channels);
        ProcessResult::Ok
    }

    fn reset(&mut self) {
        self.saturation.reset();
    }

    fn is_enabled(&self) -> bool {
        self.cached.enabled
    }

    fn set_enabled(&mut self, enabled: bool) {
        self.params.set_enabled(enabled);
    }

    fn set_sample_rate(&mut self, sample_rate: f64) {
        SampleRateAware::set_sample_rate(self, sample_rate);
    }
}

impl SampleRateAware for SaturationProcessor {
    fn sample_rate(&self) -> f64 {
        self.sample_rate
    }

    fn set_sample_rate(&mut self, sr: f64) {
        self.sample_rate = sr;
        self.saturation.set_sample_rate(sr);
    }
}

// ============================================================================
// Crossfeed Adapter
// ============================================================================

/// Crossfeed processor adapter
pub struct CrossfeedProcessor {
    crossfeed: Crossfeed,
    params: Arc<AtomicCrossfeedParams>,
    cached: CrossfeedParamsSnapshot,
    sample_rate: f64,
}

impl CrossfeedProcessor {
    pub fn new(sample_rate: f64, params: Arc<AtomicCrossfeedParams>) -> Self {
        Self {
            crossfeed: Crossfeed::new(sample_rate),
            params,
            cached: CrossfeedParamsSnapshot::default(),
            sample_rate,
        }
    }

    fn sync_params(&mut self) {
        if self.params.has_update() {
            self.cached = self.params.read();
            self.params.clear_dirty();
            self.crossfeed.set_mix(self.cached.mix);
            self.crossfeed.set_enabled(self.cached.enabled);
            // Cutoff change requires sample rate update
            self.crossfeed.set_sample_rate(self.sample_rate, self.cached.cutoff_hz);
        }
    }
}

impl AudioProcessor for CrossfeedProcessor {
    fn name(&self) -> &'static str {
        "Crossfeed"
    }

    fn process(&mut self, buffer: &mut [f64], channels: usize) -> ProcessResult {
        self.sync_params();

        if !self.cached.enabled {
            return ProcessResult::Bypassed;
        }

        self.crossfeed.process(buffer, channels);
        ProcessResult::Ok
    }

    fn reset(&mut self) {
        self.crossfeed.reset();
    }

    fn is_enabled(&self) -> bool {
        self.cached.enabled
    }

    fn set_enabled(&mut self, enabled: bool) {
        self.params.set_enabled(enabled);
    }

    fn set_sample_rate(&mut self, sample_rate: f64) {
        SampleRateAware::set_sample_rate(self, sample_rate);
    }
}

impl SampleRateAware for CrossfeedProcessor {
    fn sample_rate(&self) -> f64 {
        self.sample_rate
    }

    fn set_sample_rate(&mut self, sr: f64) {
        self.sample_rate = sr;
        self.crossfeed.set_sample_rate(sr, self.cached.cutoff_hz);
    }
}

// ============================================================================
// Peak Limiter Adapter
// ============================================================================

/// Peak limiter processor adapter
pub struct PeakLimiterProcessor {
    limiter: PeakLimiter,
    params: Arc<AtomicPeakLimiterParams>,
    cached: PeakLimiterParamsSnapshot,
    sample_rate: u32,
    channels: usize,
}

impl PeakLimiterProcessor {
    pub fn new(
        channels: usize,
        sample_rate: u32,
        params: Arc<AtomicPeakLimiterParams>,
    ) -> Self {
        Self {
            limiter: PeakLimiter::new(channels, sample_rate, -1.0, 10.0, 150.0),
            params,
            cached: PeakLimiterParamsSnapshot::default(),
            sample_rate,
            channels,
        }
    }

    fn sync_params(&mut self) {
        if self.params.has_update() {
            self.cached = self.params.read();
            self.params.clear_dirty();

            // In-place update — NO PeakLimiter::new(), NO heap allocation
            self.limiter.set_threshold(self.cached.threshold_db);
            self.limiter.set_release_ms(self.cached.release_ms);
            // If enabled state changed, limiter reset may be needed
            if self.cached.enabled != self.limiter.is_enabled() {
                self.limiter.reset();
            }
        }
    }
}

impl AudioProcessor for PeakLimiterProcessor {
    fn name(&self) -> &'static str {
        "PeakLimiter"
    }

    fn process(&mut self, buffer: &mut [f64], _channels: usize) -> ProcessResult {
        self.sync_params();

        if !self.cached.enabled {
            return ProcessResult::Bypassed;
        }

        self.limiter.process(buffer);
        ProcessResult::Ok
    }

    fn reset(&mut self) {
        self.limiter.reset();
    }

    fn is_enabled(&self) -> bool {
        self.cached.enabled
    }

    fn set_enabled(&mut self, enabled: bool) {
        self.params.set_enabled(enabled);
    }

    fn set_sample_rate(&mut self, sample_rate: f64) {
        SampleRateAware::set_sample_rate(self, sample_rate);
    }
}

impl SampleRateAware for PeakLimiterProcessor {
    fn sample_rate(&self) -> f64 {
        self.sample_rate as f64
    }

    fn set_sample_rate(&mut self, sr: f64) {
        self.sample_rate = sr as u32;
        self.limiter = PeakLimiter::new(
            self.channels,
            self.sample_rate,
            self.cached.threshold_db,
            10.0,
            self.cached.release_ms,
        );
    }
}

impl ChannelAware for PeakLimiterProcessor {
    fn channels(&self) -> usize {
        self.channels
    }

    fn set_channels(&mut self, ch: usize) {
        self.channels = ch;
        self.limiter = PeakLimiter::new(
            self.channels,
            self.sample_rate,
            self.cached.threshold_db,
            10.0,
            self.cached.release_ms,
        );
    }
}

// ============================================================================
// Volume Adapter (P1-3 fix: anti-zipper smoothing)
// ============================================================================

/// Volume processor with exponential smoothing to prevent zipper noise.
///
/// Uses ~5ms smoothing time constant to ensure click-free volume transitions.
/// Previous implementation directly multiplied buffer by target volume,
/// causing audible clicks/zips on rapid volume changes.
pub struct VolumeProcessor {
    params: Arc<AtomicVolumeParams>,
    cached: VolumeParamsSnapshot,
    /// Current smoothed volume (exponentially approaches target)
    current_volume: f64,
    /// Smoothing coefficient per sample (calculated from sample rate)
    smoothing_coeff: f64,
    /// Sample rate for smoothing calculation
    sample_rate: f64,
}

impl VolumeProcessor {
    pub fn new(params: Arc<AtomicVolumeParams>) -> Self {
        let smoothing_coeff = Self::calc_smoothing_coeff(44100.0);
        Self {
            params,
            cached: VolumeParamsSnapshot::default(),
            current_volume: 1.0,
            smoothing_coeff,
            sample_rate: 44100.0,
        }
    }

    /// Calculate smoothing coefficient for ~5ms time constant
    fn calc_smoothing_coeff(sample_rate: f64) -> f64 {
        let smoothing_time_ms = 5.0;
        let smoothing_samples = (smoothing_time_ms / 1000.0) * sample_rate;
        (-1.0 / smoothing_samples).exp()
    }

    fn sync_params(&mut self) {
        if self.params.has_update() {
            self.cached = self.params.read();
            self.params.clear_dirty();
        }
    }
}

impl AudioProcessor for VolumeProcessor {
    fn name(&self) -> &'static str {
        "Volume"
    }

    fn process(&mut self, buffer: &mut [f64], channels: usize) -> ProcessResult {
        self.sync_params();

        // Volume is always "enabled" - just applies gain
        // Check for mute
        if self.cached.muted {
            // Smooth fade to zero to avoid click
            for sample in buffer.iter_mut() {
                self.current_volume *= self.smoothing_coeff;
                *sample *= self.current_volume;
            }
            return ProcessResult::Ok;
        }

        // Apply volume with anti-zipper smoothing
        let target = self.cached.volume;
        let coeff = self.smoothing_coeff;
        let one_minus_coeff = 1.0 - coeff;
        let frames = buffer.len() / channels;

        for frame in 0..frames {
            // Exponential smoothing: current = current + (target - current) * (1 - coeff)
            self.current_volume += (target - self.current_volume) * one_minus_coeff;
            for ch in 0..channels {
                buffer[frame * channels + ch] *= self.current_volume;
            }
        }

        ProcessResult::Ok
    }

    fn reset(&mut self) {
        self.current_volume = self.cached.volume;
    }

    fn is_enabled(&self) -> bool {
        true  // Volume is always active
    }

    fn set_enabled(&mut self, _enabled: bool) {
        // Use set_muted instead
    }

    fn set_sample_rate(&mut self, sample_rate: f64) {
        if (self.sample_rate - sample_rate).abs() > 1.0 {
            self.sample_rate = sample_rate;
            self.smoothing_coeff = Self::calc_smoothing_coeff(sample_rate);
        }
    }
}

// ============================================================================
// Noise Shaper Adapter
// ============================================================================

/// Noise shaper processor adapter
pub struct NoiseShaperProcessor {
    noise_shaper: NoiseShaper,
    params: Arc<AtomicNoiseShaperParams>,
    cached: NoiseShaperParamsSnapshot,
    sample_rate: u32,
    channels: usize,
}

impl NoiseShaperProcessor {
    pub fn new(
        channels: usize,
        sample_rate: u32,
        params: Arc<AtomicNoiseShaperParams>,
    ) -> Self {
        let cached = params.read();
        let mut noise_shaper = NoiseShaper::new(channels, sample_rate, cached.bits);
        noise_shaper.set_enabled(cached.enabled);
        noise_shaper.set_curve(cached.curve);

        Self {
            noise_shaper,
            params,
            cached,
            sample_rate,
            channels,
        }
    }

    fn sync_params(&mut self) {
        if self.params.has_update() {
            self.cached = self.params.read();
            self.params.clear_dirty();
            self.noise_shaper.set_enabled(self.cached.enabled);
            self.noise_shaper.set_bits(self.cached.bits);
            self.noise_shaper.set_curve(self.cached.curve);
        }
    }
}

impl AudioProcessor for NoiseShaperProcessor {
    fn name(&self) -> &'static str {
        "NoiseShaper"
    }

    fn process(&mut self, buffer: &mut [f64], _channels: usize) -> ProcessResult {
        self.sync_params();

        if !self.cached.enabled {
            return ProcessResult::Bypassed;
        }

        self.noise_shaper.process(buffer, self.channels);
        ProcessResult::Ok
    }

    fn reset(&mut self) {
        self.noise_shaper.reset();
    }

    fn is_enabled(&self) -> bool {
        self.cached.enabled
    }

    fn set_enabled(&mut self, enabled: bool) {
        self.params.set_enabled(enabled);
    }

    fn set_sample_rate(&mut self, sample_rate: f64) {
        SampleRateAware::set_sample_rate(self, sample_rate);
    }
}

impl SampleRateAware for NoiseShaperProcessor {
    fn sample_rate(&self) -> f64 {
        self.sample_rate as f64
    }

    fn set_sample_rate(&mut self, sr: f64) {
        self.sample_rate = sr as u32;
        self.noise_shaper = NoiseShaper::new(self.channels, self.sample_rate, self.cached.bits);
        self.noise_shaper.set_enabled(self.cached.enabled);
        self.noise_shaper.set_curve(self.cached.curve);
    }
}

// ============================================================================
// Dynamic Loudness Adapter
// ============================================================================

/// Dynamic loudness compensation processor
pub struct DynamicLoudnessProcessor {
    dynamic_loudness: DynamicLoudness,
    params: Arc<AtomicDynamicLoudnessParams>,
    telemetry: Arc<AtomicDynamicLoudnessTelemetry>,
    cached: DynamicLoudnessParamsSnapshot,
    sample_rate: u32,
    channels: usize,
}

impl DynamicLoudnessProcessor {
    pub fn new(
        channels: usize,
        sample_rate: u32,
        params: Arc<AtomicDynamicLoudnessParams>,
        telemetry: Arc<AtomicDynamicLoudnessTelemetry>,
    ) -> Self {
        Self {
            dynamic_loudness: DynamicLoudness::new(channels, sample_rate as f64),
            params,
            telemetry,
            cached: DynamicLoudnessParamsSnapshot::default(),
            sample_rate,
            channels,
        }
    }

    fn sync_params(&mut self) {
        if self.params.has_update() {
            self.cached = self.params.read();
            self.params.clear_dirty();
            self.dynamic_loudness.set_volume(self.cached.volume);
            self.dynamic_loudness.set_strength(self.cached.strength);
        }
    }
}

impl AudioProcessor for DynamicLoudnessProcessor {
    fn name(&self) -> &'static str {
        "DynamicLoudness"
    }

    fn process(&mut self, buffer: &mut [f64], _channels: usize) -> ProcessResult {
        self.sync_params();

        if !self.cached.enabled {
            self.telemetry.update(0.0, [0.0; 7]);
            return ProcessResult::Bypassed;
        }

        self.dynamic_loudness.process(buffer);
        self.telemetry.update(
            self.dynamic_loudness.loudness_factor(),
            self.dynamic_loudness.get_band_gains(),
        );
        ProcessResult::Ok
    }

    fn reset(&mut self) {
        self.dynamic_loudness.reset();
    }

    fn is_enabled(&self) -> bool {
        self.cached.enabled
    }

    fn set_enabled(&mut self, enabled: bool) {
        self.params.set_enabled(enabled);
    }

    fn set_sample_rate(&mut self, sample_rate: f64) {
        SampleRateAware::set_sample_rate(self, sample_rate);
    }
}

impl SampleRateAware for DynamicLoudnessProcessor {
    fn sample_rate(&self) -> f64 {
        self.sample_rate as f64
    }

    fn set_sample_rate(&mut self, sr: f64) {
        self.sample_rate = sr as u32;
        self.dynamic_loudness = DynamicLoudness::new(self.channels, self.sample_rate as f64);
    }
}

// ============================================================================
// Pass-through Processor (for testing)
// ============================================================================

/// Simple pass-through processor for testing
pub struct PassThroughProcessor {
    enabled: bool,
}

impl PassThroughProcessor {
    pub fn new() -> Self {
        Self { enabled: true }
    }
}

impl Default for PassThroughProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioProcessor for PassThroughProcessor {
    fn name(&self) -> &'static str {
        "PassThrough"
    }

    fn process(&mut self, _buffer: &mut [f64], _channels: usize) -> ProcessResult {
        if self.enabled {
            ProcessResult::Ok
        } else {
            ProcessResult::Bypassed
        }
    }

    fn reset(&mut self) {}

    fn is_enabled(&self) -> bool {
        self.enabled
    }

    fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_eq_processor() {
        let params = Arc::new(AtomicEqParams::new());
        let mut proc = EqProcessor::new(2, 44100.0, Arc::clone(&params));

        // Set params from "main thread"
        let gains = [2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        params.write(&gains, true);

        // Process from "audio thread"
        let mut buffer = vec![0.5, 0.5];
        let result = proc.process(&mut buffer, 2);

        assert_eq!(result, ProcessResult::Ok);
        // Should be boosted by ~6dB (2x)
        assert!(buffer[0] > 0.5);
    }

    #[test]
    fn test_volume_processor_muted() {
        let params = Arc::new(AtomicVolumeParams::new());
        let mut proc = VolumeProcessor::new(Arc::clone(&params));

        params.set_volume(0.5);
        params.set_muted(true);

        let mut buffer = vec![1.0, 1.0, 1.0, 1.0];
        proc.process(&mut buffer, 2);

        assert!(buffer.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn test_saturation_processor() {
        let params = Arc::new(AtomicSaturationParams::new());
        let mut proc = SaturationProcessor::new(Arc::clone(&params));

        params.set_drive(1.0);
        params.set_mix(1.0);
        params.set_enabled(true);

        let mut buffer = vec![0.9, 0.9];
        proc.process(&mut buffer, 2);

        // tanh(0.9 * 2) ≈ 0.96, less than input
        assert!(buffer[0].abs() < 0.9 * 2.0);
    }

    #[test]
    fn test_pass_through() {
        let mut proc = PassThroughProcessor::new();
        let mut buffer = vec![1.0, 2.0, 3.0, 4.0];
        let original = buffer.clone();

        let result = proc.process(&mut buffer, 2);
        assert_eq!(result, ProcessResult::Ok);
        assert_eq!(buffer, original);
    }
}
