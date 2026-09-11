//! Atomic loudness state for lock-free audio-thread access.
//!
//! The main thread mutates target gains / mode / preamp via the helpers below;
//! the audio thread reads them in `process_gain` with relaxed ordering. The reads
//! are intentionally independent rather than a single consistent snapshot: a mode
//! switch and its matching gains are not published atomically, so the callback can
//! briefly observe a mode from one update with a gain from another. That transient
//! is inaudible because the applied gain is exponentially smoothed toward its
//! target (~200 ms), so one block of a slightly-off target only nudges the smoother
//! and is corrected on the next read.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use crate::processor::atomic_f64::AtomicF64;

use crate::config::NormalizationMode;
use crate::processor::dsp::db_to_linear;
use crate::processor::traits::{validate_sample_rate_hz, ProcessError};

use super::info::LoudnessInfo;

/// Atomic loudness state for lock-free audio thread access.
/// Uses AtomicF64 with Relaxed ordering (gains don't need strict synchronization).
pub struct AtomicLoudnessState {
    /// Target gain in dB (set by main thread, read by audio thread)
    target_gain_db: AtomicF64,
    /// Current smoothed gain in dB (updated by audio thread)
    current_gain_db: AtomicF64,
    /// Smoothing coefficient per sample (< 1.0, for multiplication)
    smoothing_coeff: AtomicF64,
    /// Album gain for Album mode (same for all tracks in album)
    album_gain_db: AtomicF64,
    /// Preamp gain for headroom adjustment (default -3 dB)
    preamp_gain_db: AtomicF64,
    /// Enable/disable normalization
    enabled: AtomicBool,
    /// Normalization mode: 0=Track, 1=Album, 2=Streaming,
    /// 3=ReplayGainTrack, 4=ReplayGainAlbum.
    mode: AtomicU8,
}

impl AtomicLoudnessState {
    /// Create a normalized state with the given smoothing and sample rate.
    ///
    /// Rejects zero sample rate and non-finite/negative smoothing before any
    /// publication state exists.
    pub fn new(smoothing_time_ms: f64, sample_rate: u32) -> Result<Self, ProcessError> {
        validate_sample_rate_hz("AtomicLoudnessState", sample_rate)?;
        let smoothing_coeff = smoothing_coefficient(smoothing_time_ms, sample_rate).ok_or(
            ProcessError::InvalidParameter {
                processor: "AtomicLoudnessState",
                parameter: "smoothing time",
                message: "value must be finite and non-negative",
            },
        )?;

        Ok(Self {
            target_gain_db: AtomicF64::new(0.0),
            current_gain_db: AtomicF64::new(0.0),
            smoothing_coeff: AtomicF64::new(smoothing_coeff),
            album_gain_db: AtomicF64::new(0.0),
            preamp_gain_db: AtomicF64::new(-1.0), // Reduced headroom for better dynamics
            enabled: AtomicBool::new(true),
            mode: AtomicU8::new(0),
        })
    }

    /// Set target gain.
    ///
    /// Non-finite input is rejected and the previous valid value is retained.
    /// This is reachable from the audio thread, so the rejection path remains
    /// allocation- and log-free.
    pub fn set_target_gain(&self, gain_db: f64) {
        if gain_db.is_finite() {
            self.target_gain_db.store(gain_db, Ordering::Relaxed);
        }
    }

    /// Set album gain (call from main thread)
    pub fn set_album_gain(&self, gain_db: f64) {
        if gain_db.is_finite() {
            self.album_gain_db.store(gain_db, Ordering::Relaxed);
        }
    }

    /// Set preamp gain in dB (call from main thread)
    pub fn set_preamp_gain(&self, gain_db: f64) {
        if gain_db.is_finite() {
            self.preamp_gain_db.store(gain_db, Ordering::Relaxed);
        }
    }

    /// Set enabled state
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    /// Publish a typed normalization mode without exposing its atomic encoding.
    pub fn set_normalization_mode(&self, mode: NormalizationMode) {
        let value = match mode {
            NormalizationMode::Track => 0,
            NormalizationMode::Album => 1,
            NormalizationMode::Streaming => 2,
            NormalizationMode::ReplayGainTrack => 3,
            NormalizationMode::ReplayGainAlbum => 4,
        };
        self.mode.store(value, Ordering::Relaxed);
    }

    /// Get normalization mode as enum
    pub fn get_mode(&self) -> NormalizationMode {
        match self.mode.load(Ordering::Relaxed) {
            0 => NormalizationMode::Track,
            1 => NormalizationMode::Album,
            2 => NormalizationMode::Streaming,
            3 => NormalizationMode::ReplayGainTrack,
            4 => NormalizationMode::ReplayGainAlbum,
            _ => NormalizationMode::Track,
        }
    }

    /// Update smoothing coefficient
    pub fn set_smoothing(&self, smoothing_time_ms: f64, sample_rate: u32) {
        if let Some(coeff) = smoothing_coefficient(smoothing_time_ms, sample_rate) {
            self.smoothing_coeff.store(coeff, Ordering::Relaxed);
        }
    }

    /// Read-only target gain published to the callback.
    pub fn target_gain_db(&self) -> f64 {
        self.target_gain_db.load(Ordering::Relaxed)
    }

    /// Read-only current smoothed gain.
    pub fn current_gain_db(&self) -> f64 {
        self.current_gain_db.load(Ordering::Relaxed)
    }

    /// Read-only smoothing coefficient.
    pub fn smoothing_coefficient(&self) -> f64 {
        self.smoothing_coeff.load(Ordering::Relaxed)
    }

    /// Read-only album gain.
    pub fn album_gain_db(&self) -> f64 {
        self.album_gain_db.load(Ordering::Relaxed)
    }

    /// Read-only preamp gain.
    pub fn preamp_gain_db(&self) -> f64 {
        self.preamp_gain_db.load(Ordering::Relaxed)
    }

    /// Read-only enablement flag.
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Reset the callback-owned gain history for a new track.
    pub(crate) fn reset_gain(&self) {
        self.target_gain_db.store(0.0, Ordering::Relaxed);
        self.current_gain_db.store(0.0, Ordering::Relaxed);
    }

    /// Process gain for a chunk (call from audio thread - lock-free)
    /// Returns the linear gain to apply (includes preamp)
    ///
    /// All fields are read with Relaxed ordering. They are independent atomics, so
    /// this is deliberately not a consistent snapshot: a concurrent main-thread
    /// update can leave the mode and the gains momentarily mismatched for one block.
    /// That is acceptable because the resulting gain is exponentially smoothed (see
    /// `remaining_factor` below), so a single slightly-wrong target is inaudible and
    /// self-corrects on the next call.
    #[inline]
    pub fn process_gain(&self, frames: usize) -> f64 {
        if !self.enabled() {
            return 1.0;
        }

        let mode = self.mode.load(Ordering::Relaxed);
        let target = self.target_gain_db.load(Ordering::Relaxed);
        let current = self.current_gain_db.load(Ordering::Relaxed);
        let coeff = self.smoothing_coeff.load(Ordering::Relaxed);
        let preamp = self.preamp_gain_db.load(Ordering::Relaxed);

        // Select gain based on mode
        let effective_target = match mode {
            1 => self.album_gain_db.load(Ordering::Relaxed), // Album mode
            _ => target,                                     // Track or Streaming mode
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
            current_gain_db: self.current_gain_db(),
            target_gain_db: self.target_gain_db(),
            preamp_db: self.preamp_gain_db(),
        }
    }
}

impl Default for AtomicLoudnessState {
    fn default() -> Self {
        Self::new(200.0, 44_100).expect("default loudness state configuration is valid")
    }
}

fn smoothing_coefficient(smoothing_time_ms: f64, sample_rate: u32) -> Option<f64> {
    if sample_rate == 0 || !smoothing_time_ms.is_finite() || smoothing_time_ms < 0.0 {
        return None;
    }
    if smoothing_time_ms == 0.0 {
        return Some(0.0);
    }

    let smoothing_samples = (smoothing_time_ms / 1000.0) * sample_rate as f64;
    let coefficient = (-1.0 / smoothing_samples).exp();
    coefficient.is_finite().then_some(coefficient)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constructor_rejects_invalid_smoothing_and_sample_rate() {
        assert!(matches!(
            AtomicLoudnessState::new(f64::NAN, 48_000),
            Err(ProcessError::InvalidParameter {
                processor: "AtomicLoudnessState",
                parameter: "smoothing time",
                ..
            })
        ));
        assert!(matches!(
            AtomicLoudnessState::new(-1.0, 48_000),
            Err(ProcessError::InvalidParameter { .. })
        ));
        assert!(matches!(
            AtomicLoudnessState::new(200.0, 0),
            Err(ProcessError::InvalidSampleRate {
                processor: "AtomicLoudnessState",
                sample_rate_hz: 0,
            })
        ));
        assert_eq!(
            AtomicLoudnessState::new(0.0, 48_000)
                .unwrap()
                .smoothing_coefficient(),
            0.0
        );
    }

    #[test]
    fn invalid_atomic_writes_retain_previous_bits() {
        let state = AtomicLoudnessState::new(200.0, 48_000).unwrap();
        state.set_target_gain(3.5);
        state.set_album_gain(-2.25);
        state.set_preamp_gain(-1.5);
        state.set_smoothing(100.0, 48_000);

        let before = [
            state.target_gain_db().to_bits(),
            state.album_gain_db().to_bits(),
            state.preamp_gain_db().to_bits(),
            state.smoothing_coefficient().to_bits(),
        ];

        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            state.set_target_gain(value);
            state.set_album_gain(value);
            state.set_preamp_gain(value);
            state.set_smoothing(value, 48_000);
            state.set_smoothing(-1.0, 48_000);
            state.set_smoothing(100.0, 0);
        }

        let after = [
            state.target_gain_db().to_bits(),
            state.album_gain_db().to_bits(),
            state.preamp_gain_db().to_bits(),
            state.smoothing_coefficient().to_bits(),
        ];
        assert_eq!(after, before);
    }
}
