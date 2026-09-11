//! EBU R128 Loudness Normalization
//!
//! Implements loudness measurement and normalization according to EBU R128 standard.
//! Supports track-based pre-analysis and real-time streaming modes.
//!
//! # Components
//!
//! - `LoudnessMeter`: EBU R128 compliant loudness measurement ([`meter`])
//! - `PeakLimiter`: True Peak limiter with 4x oversampling detection ([`limiter`])
//! - `AtomicLoudnessState`: Lock-free state for audio thread ([`atomic_state`])
//! - `LoudnessNormalizer`: High-level normalization processor ([`normalizer`])

mod atomic_state;
mod info;
mod limiter;
mod meter;
mod normalizer;

pub use atomic_state::AtomicLoudnessState;
pub use info::LoudnessInfo;
pub use limiter::{LimiterMode, PeakLimiter};
pub(crate) use meter::true_peak_reconstruction_l1_bound;
pub use meter::{LoudnessMeter, TruePeakDetector};
pub use normalizer::LoudnessNormalizer;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processor::dsp::{db_to_linear, linear_to_db};

    #[test]
    fn test_db_conversion() {
        assert!((db_to_linear(0.0) - 1.0).abs() < 1e-10);
        assert!((db_to_linear(-6.0) - 0.501).abs() < 0.01);
        assert!((linear_to_db(1.0) - 0.0).abs() < 1e-10);
        assert!((linear_to_db(0.5) - (-6.02)).abs() < 0.1);
    }

    #[test]
    fn test_peak_limiter() {
        let mut limiter = PeakLimiter::new_validated(2, 44100, -1.0, 10.0, 100.0);

        // Create a signal that exceeds threshold
        let mut samples = vec![0.0; 4096];
        for i in 0..2048 {
            samples[i * 2] = 1.5; // Left channel, above threshold
            samples[i * 2 + 1] = 1.5; // Right channel
        }

        limiter.process_validated(&mut samples);

        // After limiting, peaks should be below threshold
        let max_out = samples.iter().map(|s| s.abs()).fold(0.0_f64, f64::max);
        let threshold = db_to_linear(-1.0);
        assert!(
            max_out < threshold * 1.01,
            "Max output {} exceeds threshold {}",
            max_out,
            threshold
        );
    }

    #[test]
    fn test_true_peak_detector() {
        let mut detector = TruePeakDetector::new();

        // Create a signal with intersample peaks
        // A full-scale sine wave at Nyquist can have ISP
        let samples: Vec<f64> = (0..100).map(|i| (i as f64 * 0.1).sin()).collect();

        detector.process(&samples);

        // True peak should be >= max sample
        let max_sample = samples.iter().map(|s| s.abs()).fold(0.0_f64, f64::max);
        assert!(detector.max_true_peak() >= max_sample * 0.99);
    }
}
