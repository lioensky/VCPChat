//! High-level loudness normalizer wiring meter, limiter, and atomic state.

use std::sync::Arc;

use crate::config::{LoudnessConfig, NormalizationMode};
use crate::processor::lockfree_params::{LIMITER_THRESHOLD_DB_MAX, LIMITER_THRESHOLD_DB_MIN};
use crate::processor::traits::{
    validate_processor_channels, validate_sample_rate_hz, validated_channel_count, AudioBlockMut,
    AudioBlockRef, ProcessError,
};

use super::atomic_state::AtomicLoudnessState;
use super::info::LoudnessInfo;
use super::limiter::PeakLimiter;
use super::meter::LoudnessMeter;

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
    /// Create a normalizer for the given geometry and prevalidated config.
    ///
    /// Rejects zero channels/rate, invalid config fields, and EBU R128 backend
    /// failure atomically before any state exists.
    pub fn new(
        channels: usize,
        sample_rate: u32,
        config: LoudnessConfig,
    ) -> Result<Self, ProcessError> {
        validated_channel_count(channels)?;
        validate_sample_rate_hz("LoudnessNormalizer", sample_rate)?;
        validate_config(&config)?;
        let meter = LoudnessMeter::new(channels, sample_rate)?;
        let atomic_state = Arc::new(AtomicLoudnessState::new(
            config.smoothing_time_ms,
            sample_rate,
        )?);
        atomic_state.set_enabled(config.enabled);
        atomic_state.set_normalization_mode(config.mode);

        Ok(Self {
            meter,
            limiter: PeakLimiter::new_validated(
                channels,
                sample_rate,
                config.true_peak_limit_db,
                10.0,  // 10ms look-ahead
                100.0, // 100ms release
            ),
            config,
            atomic_state,
            track_loudness: None,
            track_gain: None,
            channels,
            sample_rate,
        })
    }

    /// Share the normalized control state with a caller-owned handle.
    pub fn atomic_state(&self) -> Arc<AtomicLoudnessState> {
        Arc::clone(&self.atomic_state)
    }

    /// Enable or bypass normalization on the next block.
    pub fn set_enabled(&mut self, enabled: bool) {
        self.config.enabled = enabled;
        self.atomic_state.set_enabled(enabled);
    }

    /// Replace the config after validating every field.
    ///
    /// On rejection the previous config, limiter, meter, and gain state are
    /// left unchanged.
    pub fn set_config(&mut self, config: LoudnessConfig) -> Result<(), ProcessError> {
        validate_config(&config)?;
        if let Some(loudness) = self.track_loudness {
            checked_gain(config.target_lufs - loudness, "target LUFS")?;
        }

        self.limiter.set_threshold_db(config.true_peak_limit_db);
        self.atomic_state
            .set_smoothing(config.smoothing_time_ms, self.sample_rate);
        self.atomic_state.set_enabled(config.enabled);
        self.atomic_state.set_normalization_mode(config.mode);
        self.config = config;

        if let Some(loudness) = self.track_loudness {
            let track_gain = self.config.target_lufs - loudness;
            self.track_gain = Some(track_gain);
            self.atomic_state.set_target_gain(track_gain);
        }
        Ok(())
    }

    /// Change the target loudness; rejects non-finite or out-of-domain values.
    pub fn set_target_lufs(&mut self, target_lufs: f64) -> Result<(), ProcessError> {
        validate_finite("target LUFS", target_lufs)?;
        if let Some(loudness) = self.track_loudness {
            checked_gain(target_lufs - loudness, "target LUFS")?;
        }
        self.config.target_lufs = target_lufs;
        if let Some(loudness) = self.track_loudness {
            let track_gain = target_lufs - loudness;
            self.track_gain = Some(track_gain);
            self.atomic_state.set_target_gain(track_gain);
        }
        Ok(())
    }

    /// Override the album gain offset; rejects non-finite values.
    pub fn set_album_gain(&self, gain_db: f64) -> Result<(), ProcessError> {
        validate_finite("album gain", gain_db)?;
        self.atomic_state.set_album_gain(gain_db);
        Ok(())
    }

    /// Override the preamp gain offset; rejects non-finite values.
    pub fn set_preamp_gain(&self, gain_db: f64) -> Result<(), ProcessError> {
        validate_finite("preamp gain", gain_db)?;
        self.atomic_state.set_preamp_gain(gain_db);
        Ok(())
    }

    /// Switch the normalization mode (track/album/streaming/ReplayGain).
    pub fn set_mode(&mut self, mode: NormalizationMode) {
        self.config.mode = mode;
        self.atomic_state.set_normalization_mode(mode);
    }

    /// Pre-analyze track loudness (call before streaming playback)
    ///
    /// FIX for Defect 39: Check loudness.is_finite() to prevent +inf gain
    /// when ebur128 returns -inf (silent or very short tracks <400ms).
    /// Invalid loudness values result in 0 dB gain (no normalization).
    pub fn analyze_track(&mut self, samples: &[f64]) -> Result<f64, ProcessError> {
        AudioBlockRef::new(samples, self.channels)?;
        self.meter.reset();
        self.meter.process(samples)?;
        let loudness = self.meter.integrated_loudness();

        // FIX for Defect 39: Validate loudness before computing gain
        if loudness.is_finite() {
            let gain_db = checked_gain(self.config.target_lufs - loudness, "target LUFS")?;
            self.track_loudness = Some(loudness);
            self.track_gain = Some(gain_db);
            self.atomic_state.set_target_gain(gain_db);

            log::info!(
                "Track analysis: Integrated loudness = {:.2} LUFS, Target gain = {:.2} dB",
                loudness,
                gain_db
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

        Ok(loudness)
    }

    /// Calculate track gain without updating atomic state (for gapless preload)
    /// Returns the target gain in dB that should be applied after buffer swap.
    /// This prevents premature gain update during the last seconds of current track.
    ///
    /// FIX for Defect 39: Check loudness.is_finite() to prevent +inf gain
    /// when ebur128 returns -inf (silent or very short tracks <400ms).
    pub fn calculate_gain(&mut self, samples: &[f64]) -> Result<f64, ProcessError> {
        AudioBlockRef::new(samples, self.channels)?;
        self.meter.reset();
        self.meter.process(samples)?;
        let loudness = self.meter.integrated_loudness();

        // FIX for Defect 39: Validate loudness before computing gain
        if loudness.is_finite() {
            let gain_db = self.config.target_lufs - loudness;

            log::info!(
                "Gapless preload analysis: Integrated loudness = {:.2} LUFS, Pending gain = {:.2} dB",
                loudness, gain_db
            );

            checked_gain(gain_db, "target LUFS")
        } else {
            log::warn!(
                "Gapless preload analysis: Invalid loudness ({:.2}), using 0 dB gain",
                loudness
            );
            Ok(0.0)
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
    ) -> Result<f64, ProcessError> {
        match mode {
            NormalizationMode::ReplayGainTrack => {
                // Use ReplayGain track gain from tag
                if let Some(rg_gain) = metadata.rg_track_gain {
                    // Convert ReplayGain tag gain to current target LUFS using configurable reference
                    let gain_db =
                        rg_gain + (self.config.target_lufs - self.config.replaygain_reference_lufs);
                    log::info!(
                        "Gapless preload: Using ReplayGain track tag: {:.2} dB -> target gain: {:.2} dB",
                        rg_gain, gain_db
                    );
                    return checked_gain(gain_db, "ReplayGain track gain");
                }
                // Fallback to EBU R128 if no tag
                log::warn!("Gapless preload: No ReplayGain track tag, falling back to EBU R128");
                self.calculate_gain(samples)
            }
            NormalizationMode::ReplayGainAlbum => {
                // Use ReplayGain album gain (fallback to track)
                let rg_gain = metadata.rg_album_gain.or(metadata.rg_track_gain);
                if let Some(gain) = rg_gain {
                    let gain_db =
                        gain + (self.config.target_lufs - self.config.replaygain_reference_lufs);
                    log::info!(
                        "Gapless preload: Using ReplayGain album tag: {:.2} dB -> target gain: {:.2} dB",
                        gain, gain_db
                    );
                    return checked_gain(gain_db, "ReplayGain album gain");
                }
                log::warn!(
                    "Gapless preload: No ReplayGain album/track tag, falling back to EBU R128"
                );
                self.calculate_gain(samples)
            }
            _ => {
                // Track/Album/Streaming modes: use EBU R128 analysis
                self.calculate_gain(samples)
            }
        }
    }

    /// Reset meter, limiter, gain state, and cached track analysis.
    pub fn reset(&mut self) {
        self.meter.reset();
        self.limiter.reset();
        self.atomic_state.reset_gain();
        self.track_loudness = None;
        self.track_gain = None;
    }

    /// Process interleaved f64 samples in-place
    pub fn process(&mut self, samples: &mut [f64], channels: usize) -> Result<(), ProcessError> {
        let block = AudioBlockMut::new(samples, channels)?;
        validate_processor_channels("LoudnessNormalizer", Some(self.channels), channels)?;
        self.process_validated(block.into_samples())
    }

    fn process_validated(&mut self, samples: &mut [f64]) -> Result<(), ProcessError> {
        if !self.atomic_state.enabled() {
            return Ok(());
        }

        let frames = samples.len() / self.channels;
        if frames == 0 {
            return Ok(());
        }

        // For streaming mode, measure in real-time
        if self.config.mode == NormalizationMode::Streaming {
            self.meter.process(samples)?;

            if self.meter.has_reliable_measurement() {
                let current_loudness = self.meter.short_term_loudness();
                if current_loudness > -70.0 {
                    let target_gain = self.config.target_lufs - current_loudness;
                    self.atomic_state
                        .set_target_gain(target_gain.clamp(-20.0, 20.0));
                }
            }
        }

        // Apply gain using atomic state
        let linear_gain = self.atomic_state.process_gain(frames);
        for sample in samples.iter_mut() {
            *sample *= linear_gain;
        }

        // Apply peak limiting
        self.limiter.process_validated(samples);
        Ok(())
    }

    /// Current measurement/gain readout for UI or status reporting.
    pub fn get_loudness_info(&self) -> LoudnessInfo {
        LoudnessInfo {
            integrated_lufs: self.meter.integrated_loudness(),
            short_term_lufs: self.meter.short_term_loudness(),
            momentary_lufs: self.meter.momentary_loudness(),
            loudness_range: self.meter.loudness_range(),
            true_peak_dbtp: self.meter.true_peak(),
            current_gain_db: self.atomic_state.current_gain_db(),
            target_gain_db: self.atomic_state.target_gain_db(),
            preamp_db: self.atomic_state.preamp_gain_db(),
        }
    }

    /// Analyzed track loudness in LUFS, when pre-analysis ran.
    pub fn track_loudness(&self) -> Option<f64> {
        self.track_loudness
    }
    /// Whether track-level analysis has provided a loudness measurement.
    pub fn is_analyzed(&self) -> bool {
        self.track_loudness.is_some()
    }
}

fn validate_config(config: &LoudnessConfig) -> Result<(), ProcessError> {
    validate_finite("target LUFS", config.target_lufs)?;
    validate_finite("true-peak limit", config.true_peak_limit_db)?;
    if !(LIMITER_THRESHOLD_DB_MIN..=LIMITER_THRESHOLD_DB_MAX).contains(&config.true_peak_limit_db) {
        return Err(ProcessError::InvalidParameter {
            processor: "LoudnessNormalizer",
            parameter: "true-peak limit",
            message: "value must be inside the published limiter threshold range",
        });
    }
    if !config.smoothing_time_ms.is_finite() || config.smoothing_time_ms < 0.0 {
        return Err(ProcessError::InvalidParameter {
            processor: "LoudnessNormalizer",
            parameter: "smoothing time",
            message: "value must be finite and non-negative",
        });
    }
    validate_finite(
        "ReplayGain reference LUFS",
        config.replaygain_reference_lufs,
    )
}

fn validate_finite(parameter: &'static str, value: f64) -> Result<(), ProcessError> {
    if value.is_finite() {
        return Ok(());
    }
    Err(ProcessError::InvalidParameter {
        processor: "LoudnessNormalizer",
        parameter,
        message: "value must be finite",
    })
}

fn checked_gain(value: f64, parameter: &'static str) -> Result<f64, ProcessError> {
    validate_finite(parameter, value)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processor::traits::AudioBlockError;

    fn loudness_info_bits(info: &LoudnessInfo) -> [u64; 8] {
        [
            info.integrated_lufs.to_bits(),
            info.short_term_lufs.to_bits(),
            info.momentary_lufs.to_bits(),
            info.loudness_range.to_bits(),
            info.true_peak_dbtp.to_bits(),
            info.current_gain_db.to_bits(),
            info.target_gain_db.to_bits(),
            info.preamp_db.to_bits(),
        ]
    }

    const MODES: [NormalizationMode; 5] = [
        NormalizationMode::Track,
        NormalizationMode::Album,
        NormalizationMode::Streaming,
        NormalizationMode::ReplayGainTrack,
        NormalizationMode::ReplayGainAlbum,
    ];

    #[test]
    fn constructor_publishes_disabled_album_config_and_bypasses() {
        let config = LoudnessConfig {
            enabled: false,
            mode: NormalizationMode::Album,
            ..LoudnessConfig::default()
        };
        let mut normalizer = LoudnessNormalizer::new(2, 48_000, config).unwrap();
        let state = normalizer.atomic_state();

        assert!(!state.enabled());
        assert_eq!(state.get_mode(), NormalizationMode::Album);

        let mut samples = vec![0.25; 128 * 2];
        let expected = samples.clone();
        normalizer.process_validated(&mut samples).unwrap();
        assert_eq!(samples, expected);
    }

    #[test]
    fn config_and_explicit_setters_round_trip_all_modes() {
        let mut normalizer = LoudnessNormalizer::new(2, 48_000, LoudnessConfig::default()).unwrap();

        for (index, mode) in MODES.into_iter().enumerate() {
            let enabled = index % 2 == 0;
            let config = LoudnessConfig {
                enabled,
                mode,
                ..LoudnessConfig::default()
            };
            normalizer.set_config(config).unwrap();
            assert_eq!(normalizer.atomic_state.enabled(), enabled);
            assert_eq!(normalizer.atomic_state.get_mode(), mode);
            assert_eq!(normalizer.config.enabled, enabled);
            assert_eq!(normalizer.config.mode, mode);
        }

        normalizer.set_enabled(false);
        normalizer.set_mode(NormalizationMode::ReplayGainAlbum);
        assert!(!normalizer.config.enabled);
        assert_eq!(normalizer.config.mode, NormalizationMode::ReplayGainAlbum);
        assert!(!normalizer.atomic_state.enabled());
        assert_eq!(
            normalizer.atomic_state.get_mode(),
            NormalizationMode::ReplayGainAlbum
        );
    }

    #[test]
    fn invalid_config_and_setters_reject_before_mutation() {
        for config in [
            LoudnessConfig {
                target_lufs: f64::NAN,
                ..LoudnessConfig::default()
            },
            LoudnessConfig {
                true_peak_limit_db: LIMITER_THRESHOLD_DB_MIN - 0.1,
                ..LoudnessConfig::default()
            },
            LoudnessConfig {
                smoothing_time_ms: -1.0,
                ..LoudnessConfig::default()
            },
            LoudnessConfig {
                replaygain_reference_lufs: f64::INFINITY,
                ..LoudnessConfig::default()
            },
        ] {
            assert!(matches!(
                LoudnessNormalizer::new(2, 48_000, config),
                Err(ProcessError::InvalidParameter { .. })
            ));
        }

        let mut normalizer = LoudnessNormalizer::new(2, 48_000, LoudnessConfig::default()).unwrap();
        let mut reference = LoudnessNormalizer::new(2, 48_000, LoudnessConfig::default()).unwrap();
        normalizer.set_album_gain(-2.0).unwrap();
        reference.set_album_gain(-2.0).unwrap();
        normalizer.set_preamp_gain(-1.5).unwrap();
        reference.set_preamp_gain(-1.5).unwrap();

        let before_config = normalizer.config.clone();
        let state = normalizer.atomic_state();
        let before_state = [
            state.target_gain_db().to_bits(),
            state.current_gain_db().to_bits(),
            state.smoothing_coefficient().to_bits(),
            state.album_gain_db().to_bits(),
            state.preamp_gain_db().to_bits(),
        ];
        let invalid = LoudnessConfig {
            target_lufs: -30.0,
            true_peak_limit_db: -10.0,
            smoothing_time_ms: f64::NAN,
            mode: NormalizationMode::Album,
            enabled: false,
            replaygain_reference_lufs: -23.0,
        };

        assert!(matches!(
            normalizer.set_config(invalid),
            Err(ProcessError::InvalidParameter {
                parameter: "smoothing time",
                ..
            })
        ));
        assert_eq!(
            [
                state.target_gain_db().to_bits(),
                state.current_gain_db().to_bits(),
                state.smoothing_coefficient().to_bits(),
                state.album_gain_db().to_bits(),
                state.preamp_gain_db().to_bits(),
            ],
            before_state
        );
        assert_eq!(
            normalizer.config.target_lufs.to_bits(),
            before_config.target_lufs.to_bits()
        );
        assert_eq!(
            normalizer.config.true_peak_limit_db.to_bits(),
            before_config.true_peak_limit_db.to_bits()
        );
        assert_eq!(normalizer.config.mode, before_config.mode);
        assert_eq!(normalizer.config.enabled, before_config.enabled);

        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(normalizer.set_target_lufs(value).is_err());
            assert!(normalizer.set_album_gain(value).is_err());
            assert!(normalizer.set_preamp_gain(value).is_err());
        }
        assert_eq!(
            normalizer.config.target_lufs.to_bits(),
            before_config.target_lufs.to_bits()
        );
        assert_eq!(state.album_gain_db().to_bits(), (-2.0_f64).to_bits());
        assert_eq!(state.preamp_gain_db().to_bits(), (-1.5_f64).to_bits());

        let mut samples = vec![1.0; 2_048 * 2];
        let mut reference_samples = samples.clone();
        normalizer.process(&mut samples, 2).unwrap();
        reference.process(&mut reference_samples, 2).unwrap();
        assert_eq!(samples, reference_samples);
    }

    #[test]
    fn zero_smoothing_is_valid_and_streaming_process_stays_no_alloc() {
        let config = LoudnessConfig {
            smoothing_time_ms: 0.0,
            mode: NormalizationMode::Streaming,
            ..LoudnessConfig::default()
        };
        let mut normalizer = LoudnessNormalizer::new(2, 48_000, config).unwrap();
        assert_eq!(normalizer.atomic_state.smoothing_coefficient(), 0.0);
        let mut samples = [0.125; 64 * 2];

        assert_no_alloc::assert_no_alloc(|| {
            for _ in 0..1_000 {
                assert_eq!(normalizer.process(&mut samples, 2), Ok(()));
            }
        });
    }

    #[test]
    fn raw_normalizer_rejects_invalid_setup_and_block_geometry_atomically() {
        assert!(matches!(
            LoudnessNormalizer::new(0, 48_000, LoudnessConfig::default()),
            Err(ProcessError::InvalidBlock(AudioBlockError::ZeroChannels))
        ));
        assert!(matches!(
            LoudnessNormalizer::new(2, 0, LoudnessConfig::default()),
            Err(ProcessError::InvalidSampleRate {
                processor: "LoudnessNormalizer",
                sample_rate_hz: 0,
            })
        ));

        let config = LoudnessConfig {
            mode: NormalizationMode::Streaming,
            ..LoudnessConfig::default()
        };
        let mut normalizer = LoudnessNormalizer::new(2, 48_000, config.clone()).unwrap();
        let mut reference = LoudnessNormalizer::new(2, 48_000, config).unwrap();
        let mut warm = [0.25; 128];
        let mut reference_warm = warm;
        normalizer.process(&mut warm, 2).unwrap();
        reference.process(&mut reference_warm, 2).unwrap();
        assert_eq!(warm, reference_warm);
        let state = loudness_info_bits(&normalizer.get_loudness_info());

        let mut zero_channels = [0.25; 4];
        let zero_channels_before = zero_channels;
        let mut incomplete = [0.25; 3];
        let incomplete_before = incomplete;
        let mut mismatch = [0.25; 4];
        let mismatch_before = mismatch;
        assert_no_alloc::assert_no_alloc(|| {
            assert_eq!(
                normalizer.process(&mut zero_channels, 0),
                Err(ProcessError::InvalidBlock(AudioBlockError::ZeroChannels))
            );
            assert_eq!(
                normalizer.process(&mut incomplete, 2),
                Err(ProcessError::InvalidBlock(
                    AudioBlockError::IncompleteFrame {
                        samples: 3,
                        channels: 2,
                    }
                ))
            );
            assert_eq!(
                normalizer.process(&mut mismatch, 1),
                Err(ProcessError::ChannelCountMismatch {
                    processor: "LoudnessNormalizer",
                    expected_channels: 2,
                    actual_channels: 1,
                })
            );
        });

        assert_eq!(zero_channels, zero_channels_before);
        assert_eq!(incomplete, incomplete_before);
        assert_eq!(mismatch, mismatch_before);
        assert_eq!(loudness_info_bits(&normalizer.get_loudness_info()), state);

        let mut next = [0.125; 128];
        let mut reference_next = next;
        normalizer.process(&mut next, 2).unwrap();
        reference.process(&mut reference_next, 2).unwrap();
        assert_eq!(next, reference_next);
        assert_eq!(
            loudness_info_bits(&normalizer.get_loudness_info()),
            loudness_info_bits(&reference.get_loudness_info())
        );
    }
}
