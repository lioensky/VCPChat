//! Bauer stereophonic-to-binaural crossfeed for headphone listening.
//!
//! The processor follows the classic libbs2b topology: a low-passed copy of
//! each channel feeds the opposite ear, while a complementary high-boost path
//! and global gain keep the direct signal balanced and avoid a mono bass boost.
//!
//! ```text
//! L_bauer = gain * (highboost(L) + lowpass(R))
//! R_bauer = gain * (highboost(R) + lowpass(L))
//! output  = dry + strength * (bauer - dry)
//! ```
//!
//! The reference profile uses a 4.5 dB low-frequency feed level. `mix` is the
//! dry/reference strength, not a mislabeled raw cross-channel coefficient.

use super::lockfree_params::{CROSSFEED_MIX_MAX, CROSSFEED_MIX_MIN};

const DEFAULT_SAMPLE_RATE_HZ: f64 = 44_100.0;
pub(super) const DEFAULT_CUTOFF_HZ: f64 = 700.0;
pub(super) const DEFAULT_MIX: f64 = 0.35;
pub(super) const MIN_CUTOFF_HZ: f64 = 200.0;
pub(super) const MAX_CUTOFF_HZ: f64 = 2_000.0;
const BAUER_REFERENCE_FEED_DB: f64 = 4.5;
const PARAMETER_RAMP_MS: f64 = 10.0;

#[derive(Debug, Clone, Copy, PartialEq)]
struct BauerCoefficients {
    a0_low: f64,
    b1_low: f64,
    a0_high: f64,
    a1_high: f64,
    b1_high: f64,
    gain: f64,
}

impl BauerCoefficients {
    /// Design the first-order low-pass/high-boost pair used by libbs2b.
    /// Coefficient design happens only when rate/cutoff changes, never per sample.
    fn design(sample_rate_hz: f64, cutoff_hz: f64) -> Self {
        let low_gain_db = -5.0 * BAUER_REFERENCE_FEED_DB / 6.0 - 3.0;
        let high_gain_db = BAUER_REFERENCE_FEED_DB / 6.0 - 3.0;
        let low_gain = 10.0_f64.powf(low_gain_db / 20.0);
        let high_loss = 1.0 - 10.0_f64.powf(high_gain_db / 20.0);
        let high_cutoff_hz =
            cutoff_hz * 2.0_f64.powf((low_gain_db - 20.0 * high_loss.log10()) / 12.0);

        let low_pole = (-std::f64::consts::TAU * cutoff_hz / sample_rate_hz).exp();
        let high_pole = (-std::f64::consts::TAU * high_cutoff_hz / sample_rate_hz).exp();

        Self {
            a0_low: low_gain * (1.0 - low_pole),
            b1_low: low_pole,
            a0_high: 1.0 - high_loss * (1.0 - high_pole),
            a1_high: -high_pole,
            b1_high: high_pole,
            gain: 1.0 / (1.0 - high_loss + low_gain),
        }
    }

    #[inline(always)]
    fn lerp(self, target: Self, amount: f64) -> Self {
        Self {
            a0_low: self.a0_low + (target.a0_low - self.a0_low) * amount,
            b1_low: self.b1_low + (target.b1_low - self.b1_low) * amount,
            a0_high: self.a0_high + (target.a0_high - self.a0_high) * amount,
            a1_high: self.a1_high + (target.a1_high - self.a1_high) * amount,
            b1_high: self.b1_high + (target.b1_high - self.b1_high) * amount,
            gain: self.gain + (target.gain - self.gain) * amount,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ScalarRamp {
    current: f64,
    target: f64,
    step: f64,
    remaining: usize,
}

impl ScalarRamp {
    fn at(value: f64) -> Self {
        Self {
            current: value,
            target: value,
            step: 0.0,
            remaining: 0,
        }
    }

    fn retarget(&mut self, target: f64, frames: usize) {
        if target == self.target {
            return;
        }
        self.target = target;
        self.remaining = frames.max(1);
        self.step = (target - self.current) / self.remaining as f64;
    }

    #[inline(always)]
    fn next(&mut self) -> f64 {
        if self.remaining == 0 {
            return self.current;
        }
        self.current += self.step;
        self.remaining -= 1;
        if self.remaining == 0 {
            self.current = self.target;
        }
        self.current
    }

    fn jump_to_target(&mut self) {
        self.current = self.target;
        self.step = 0.0;
        self.remaining = 0;
    }
}

#[derive(Debug, Clone, Copy)]
struct CoefficientRamp {
    current: BauerCoefficients,
    start: BauerCoefficients,
    target: BauerCoefficients,
    total: usize,
    remaining: usize,
}

impl CoefficientRamp {
    fn at(coefficients: BauerCoefficients) -> Self {
        Self {
            current: coefficients,
            start: coefficients,
            target: coefficients,
            total: 1,
            remaining: 0,
        }
    }

    fn retarget(&mut self, target: BauerCoefficients, frames: usize) {
        if target == self.target {
            return;
        }
        self.start = self.current;
        self.target = target;
        self.total = frames.max(1);
        self.remaining = self.total;
    }

    #[inline(always)]
    fn next(&mut self) -> BauerCoefficients {
        if self.remaining == 0 {
            return self.current;
        }
        let completed = self.total - self.remaining + 1;
        self.current = self
            .start
            .lerp(self.target, completed as f64 / self.total as f64);
        self.remaining -= 1;
        if self.remaining == 0 {
            self.current = self.target;
        }
        self.current
    }

    fn jump_to_target(&mut self) {
        self.current = self.target;
        self.start = self.target;
        self.total = 1;
        self.remaining = 0;
    }

    fn jump(&mut self, coefficients: BauerCoefficients) {
        self.current = coefficients;
        self.start = coefficients;
        self.target = coefficients;
        self.total = 1;
        self.remaining = 0;
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct BauerState {
    previous_input: [f64; 2],
    low: [f64; 2],
    high: [f64; 2],
}

impl BauerState {
    fn reset(&mut self) {
        *self = Self::default();
    }
}

/// Bauer-style stereo crossfeed processor.
///
/// The filter is stereo-only. Mono and multichannel buffers pass through
/// unchanged. Mix and cutoff changes are ramped without reallocating or
/// clearing signal history; a sample-rate change defines a new stream domain
/// and resets the old-rate history.
pub struct Crossfeed {
    state: BauerState,
    coefficients: CoefficientRamp,
    mix: ScalarRamp,
    sample_rate_hz: f64,
    cutoff_hz: f64,
    enabled: bool,
}

impl Crossfeed {
    /// Create a 700 Hz crossfeed at a subtle 35% reference strength.
    pub fn new(sample_rate_hz: f64) -> Self {
        Self::with_params(sample_rate_hz, DEFAULT_CUTOFF_HZ, DEFAULT_MIX)
    }

    /// Create with a custom cutoff and dry/reference strength.
    pub fn with_params(sample_rate_hz: f64, cutoff_hz: f64, mix: f64) -> Self {
        let sample_rate_hz = Self::sanitize_sample_rate(sample_rate_hz);
        let cutoff_hz = Self::sanitize_cutoff(cutoff_hz);
        let mix = Self::sanitize_mix(mix);
        let coefficients = BauerCoefficients::design(sample_rate_hz, cutoff_hz);

        Self {
            state: BauerState::default(),
            coefficients: CoefficientRamp::at(coefficients),
            mix: ScalarRamp::at(mix),
            sample_rate_hz,
            cutoff_hz,
            enabled: true,
        }
    }

    fn sanitize_sample_rate(sample_rate_hz: f64) -> f64 {
        if sample_rate_hz.is_finite() && sample_rate_hz > 0.0 {
            sample_rate_hz
        } else {
            DEFAULT_SAMPLE_RATE_HZ
        }
    }

    fn sanitize_cutoff(cutoff_hz: f64) -> f64 {
        if cutoff_hz.is_finite() {
            cutoff_hz.clamp(MIN_CUTOFF_HZ, MAX_CUTOFF_HZ)
        } else {
            DEFAULT_CUTOFF_HZ
        }
    }

    fn sanitize_mix(mix: f64) -> f64 {
        if mix.is_finite() {
            mix.clamp(CROSSFEED_MIX_MIN, CROSSFEED_MIX_MAX)
        } else {
            DEFAULT_MIX
        }
    }

    fn ramp_frames(&self) -> usize {
        ((self.sample_rate_hz * PARAMETER_RAMP_MS / 1000.0).round() as usize).max(1)
    }

    /// Set dry/reference strength (`0.0` = dry, `1.0` = full Bauer profile).
    pub fn set_mix(&mut self, mix: f64) {
        self.mix
            .retarget(Self::sanitize_mix(mix), self.ramp_frames());
    }

    /// Retarget the low-pass cutoff without clearing signal history.
    pub fn set_cutoff(&mut self, cutoff_hz: f64) {
        let cutoff_hz = Self::sanitize_cutoff(cutoff_hz);
        if cutoff_hz == self.cutoff_hz {
            return;
        }
        self.cutoff_hz = cutoff_hz;
        self.coefficients.retarget(
            BauerCoefficients::design(self.sample_rate_hz, cutoff_hz),
            self.ramp_frames(),
        );
    }

    /// Enter a new sample-rate domain, snap coefficients, and clear old history.
    pub fn set_sample_rate(&mut self, sample_rate_hz: f64, cutoff_hz: f64) {
        self.sample_rate_hz = Self::sanitize_sample_rate(sample_rate_hz);
        self.cutoff_hz = Self::sanitize_cutoff(cutoff_hz);
        self.coefficients.jump(BauerCoefficients::design(
            self.sample_rate_hz,
            self.cutoff_hz,
        ));
        self.mix.jump_to_target();
        self.state.reset();
    }

    /// Enable or bypass the crossfeed stage.
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// Clear signal history and complete any pending parameter transition.
    pub fn reset(&mut self) {
        self.state.reset();
        self.coefficients.jump_to_target();
        self.mix.jump_to_target();
    }

    /// Process interleaved stereo samples in place.
    pub fn process(&mut self, samples: &mut [f64], channels: usize) {
        if !self.enabled || channels != 2 {
            return;
        }

        for frame in samples.chunks_exact_mut(2) {
            let coefficients = self.coefficients.next();
            let mix = self.mix.next();
            let left = frame[0];
            let right = frame[1];

            self.state.low[0] =
                coefficients.a0_low * left + coefficients.b1_low * self.state.low[0];
            self.state.low[1] =
                coefficients.a0_low * right + coefficients.b1_low * self.state.low[1];

            self.state.high[0] = coefficients.a0_high * left
                + coefficients.a1_high * self.state.previous_input[0]
                + coefficients.b1_high * self.state.high[0];
            self.state.high[1] = coefficients.a0_high * right
                + coefficients.a1_high * self.state.previous_input[1]
                + coefficients.b1_high * self.state.high[1];
            self.state.previous_input = [left, right];

            #[cfg(not(any(target_arch = "x86", target_arch = "x86_64", target_arch = "aarch64")))]
            {
                for channel in 0..2 {
                    self.state.previous_input[channel] =
                        crate::runtime::flush_subnormal_sample(self.state.previous_input[channel]);
                    self.state.low[channel] =
                        crate::runtime::flush_subnormal_sample(self.state.low[channel]);
                    self.state.high[channel] =
                        crate::runtime::flush_subnormal_sample(self.state.high[channel]);
                }
            }

            let bauer_left = (self.state.high[0] + self.state.low[1]) * coefficients.gain;
            let bauer_right = (self.state.high[1] + self.state.low[0]) * coefficients.gain;
            frame[0] = left + (bauer_left - left) * mix;
            frame[1] = right + (bauer_right - right) * mix;
        }
    }

    /// Read the current crossfeed settings.
    pub fn get_settings(&self) -> CrossfeedSettings {
        CrossfeedSettings {
            mix: self.mix.target,
            cutoff_hz: self.cutoff_hz,
            enabled: self.enabled,
        }
    }
}

impl Default for Crossfeed {
    fn default() -> Self {
        Self::new(DEFAULT_SAMPLE_RATE_HZ)
    }
}

/// Observable snapshot of the crossfeed settings.
///
/// Supported, but not read by any other type in this crate. It exists so a
/// consuming application can report the active configuration; the realtime path
/// reads its values from the lock-free parameter snapshot instead.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CrossfeedSettings {
    /// Dry/wet linear mix target.
    pub mix: f64,
    /// Lowpass cutoff in Hz.
    pub cutoff_hz: f64,
    /// Whether the stage is active.
    pub enabled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hard_left_sine(frames: usize, sample_rate_hz: f64, frequency_hz: f64) -> Vec<f64> {
        (0..frames)
            .flat_map(|frame| {
                let phase = std::f64::consts::TAU * frequency_hz * frame as f64 / sample_rate_hz;
                [phase.sin() * 0.25, 0.0]
            })
            .collect()
    }

    fn rms(samples: impl Iterator<Item = f64>) -> f64 {
        let (power, count) = samples.fold((0.0, 0_usize), |(power, count), sample| {
            (power + sample * sample, count + 1)
        });
        (power / count as f64).sqrt()
    }

    fn right_crossfeed_gain_db(frequency_hz: f64) -> f64 {
        let sample_rate_hz = 48_000.0;
        let mut samples = hard_left_sine(48_000, sample_rate_hz, frequency_hz);
        let input_rms = rms(samples.iter().skip(9_600).step_by(2).copied());
        let mut crossfeed = Crossfeed::with_params(sample_rate_hz, 700.0, 1.0);
        crossfeed.process(&mut samples, 2);
        let output_rms = rms(samples.iter().skip(9_601).step_by(2).copied());
        20.0 * (output_rms / input_rms).log10()
    }

    #[test]
    fn low_frequency_crossfeed_is_stronger_than_high_frequency_crossfeed() {
        let low_db = right_crossfeed_gain_db(80.0);
        let high_db = right_crossfeed_gain_db(2_000.0);

        assert!(
            low_db > high_db + 8.0,
            "low={low_db:.2} dB high={high_db:.2} dB"
        );
    }

    #[test]
    fn full_reference_matches_bauer_dc_gain_profile() {
        let mut crossfeed = Crossfeed::with_params(48_000.0, 700.0, 1.0);
        let mut samples = vec![0.0; 8_192 * 2];
        for frame in samples.chunks_exact_mut(2) {
            frame[0] = 1.0;
        }

        crossfeed.process(&mut samples, 2);

        let last = &samples[samples.len() - 2..];
        assert!((last[0] - 0.6267).abs() <= 5.0e-4, "direct={}", last[0]);
        assert!((last[1] - 0.3733).abs() <= 5.0e-4, "cross={}", last[1]);
        assert!((last[0] + last[1] - 1.0).abs() <= 1.0e-12);
    }

    #[test]
    fn zero_mix_is_bit_exact_bypass() {
        let mut crossfeed = Crossfeed::with_params(44_100.0, 700.0, 0.0);
        let mut samples = hard_left_sine(1024, 44_100.0, 997.0);
        let original = samples.clone();

        crossfeed.process(&mut samples, 2);

        assert_eq!(samples, original);
    }

    #[test]
    fn mono_and_multichannel_are_passthrough() {
        let mut crossfeed = Crossfeed::new(44_100.0);
        for channels in [1, 6] {
            let mut samples = vec![0.25; channels * 16];
            let original = samples.clone();
            crossfeed.process(&mut samples, channels);
            assert_eq!(samples, original);
        }
    }

    #[test]
    fn disabled_is_passthrough() {
        let mut crossfeed = Crossfeed::new(44_100.0);
        crossfeed.set_enabled(false);
        let mut samples = vec![1.0, 0.0, 0.5, 0.0];
        let original = samples.clone();
        crossfeed.process(&mut samples, 2);
        assert_eq!(samples, original);
    }

    #[test]
    fn mix_and_cutoff_changes_ramp_without_clearing_history() {
        let mut crossfeed = Crossfeed::with_params(48_000.0, 700.0, 0.35);
        let mut warm = hard_left_sine(2048, 48_000.0, 997.0);
        crossfeed.process(&mut warm, 2);
        let state_before = crossfeed.state;

        crossfeed.set_mix(0.8);
        crossfeed.set_cutoff(1_100.0);

        assert_eq!(crossfeed.state.previous_input, state_before.previous_input);
        assert_eq!(crossfeed.state.low, state_before.low);
        assert_eq!(crossfeed.state.high, state_before.high);
        assert_eq!(crossfeed.mix.remaining, 480);
        assert_eq!(crossfeed.coefficients.remaining, 480);

        let mut transition = hard_left_sine(480, 48_000.0, 997.0);
        crossfeed.process(&mut transition, 2);
        assert_eq!(crossfeed.mix.current, 0.8);
        assert_eq!(crossfeed.mix.remaining, 0);
        assert_eq!(crossfeed.coefficients.remaining, 0);
    }

    #[test]
    fn parameter_ramps_are_independent_of_buffer_chunking() {
        let mut whole = Crossfeed::with_params(48_000.0, 700.0, 0.35);
        let mut chunked = Crossfeed::with_params(48_000.0, 700.0, 0.35);
        let mut warm_a = hard_left_sine(1024, 48_000.0, 997.0);
        let mut warm_b = warm_a.clone();
        whole.process(&mut warm_a, 2);
        chunked.process(&mut warm_b, 2);
        whole.set_mix(0.8);
        chunked.set_mix(0.8);
        whole.set_cutoff(1_100.0);
        chunked.set_cutoff(1_100.0);

        let mut output_a = hard_left_sine(2048, 48_000.0, 997.0);
        let mut output_b = output_a.clone();
        whole.process(&mut output_a, 2);
        let mut offset = 0;
        for frames in [1, 7, 31, 113, 509, 1387] {
            let end = offset + frames * 2;
            chunked.process(&mut output_b[offset..end], 2);
            offset = end;
        }

        assert_eq!(offset, output_b.len());
        assert_eq!(output_a, output_b);
    }

    #[test]
    fn reset_isolates_prior_stream_state() {
        let mut reused = Crossfeed::with_params(48_000.0, 700.0, 0.7);
        let mut fresh = Crossfeed::with_params(48_000.0, 700.0, 0.7);
        let mut warm = hard_left_sine(4096, 48_000.0, 997.0);
        reused.process(&mut warm, 2);
        reused.reset();

        let mut reused_output = hard_left_sine(512, 48_000.0, 431.0);
        let mut fresh_output = reused_output.clone();
        reused.process(&mut reused_output, 2);
        fresh.process(&mut fresh_output, 2);

        assert_eq!(reused_output, fresh_output);
    }

    #[test]
    fn steady_state_processing_is_allocation_free() {
        let mut crossfeed = Crossfeed::new(48_000.0);
        let mut samples = hard_left_sine(512, 48_000.0, 997.0);
        crossfeed.process(&mut samples, 2);

        assert_no_alloc::assert_no_alloc(|| {
            for _ in 0..128 {
                crossfeed.process(&mut samples, 2);
            }
        });
    }

    #[test]
    fn crossfeed_flushes_denormals_with_audio_thread_init() {
        crate::runtime::audio_thread_init();
        if !crate::runtime::audio_thread_float_mode_is_enabled() {
            return;
        }

        let subnormal = f64::from_bits(1);
        let mut crossfeed = Crossfeed::new(44_100.0);
        crossfeed.state.low = [subnormal, -subnormal];
        crossfeed.state.high = [-subnormal, subnormal];
        let mut samples = vec![0.0; 32];
        crossfeed.process(&mut samples, 2);

        assert_eq!(crossfeed.state.low, [0.0; 2]);
        assert_eq!(crossfeed.state.high, [0.0; 2]);
        assert!(samples.iter().all(|sample| *sample == 0.0));
    }
}
