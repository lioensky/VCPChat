//! EBU R128 loudness meter and 4x FIR true peak detector.

use crate::channel_layout::{ChannelLayout, ChannelPosition};
use crate::processor::dsp::linear_to_db;
use crate::processor::traits::{
    validate_sample_rate_hz, validated_channel_count, AudioBlockRef, ProcessError,
};
use std::sync::OnceLock;

const TRUE_PEAK_PHASES: usize = 4;
const TRUE_PEAK_FIR_TAPS: usize = 49;
/// Span (in input samples) of one polyphase branch. The limiter reuses this as
/// its detector-delay pad so an output sample's full intersample-peak
/// contribution is always inside its look-ahead window.
pub(crate) const TRUE_PEAK_DELAY: usize = TRUE_PEAK_FIR_TAPS.div_ceil(TRUE_PEAK_PHASES);
const TRUE_PEAK_HISTORY_LEN: usize = TRUE_PEAK_DELAY * 2;
const TRUE_PEAK_INTER_SAMPLE_TAPS: usize = TRUE_PEAK_DELAY - 1;

static TRUE_PEAK_FIR: OnceLock<TruePeakFir> = OnceLock::new();

#[derive(Clone, Copy)]
pub(crate) struct TruePeakFir {
    sample_phase_coeff: f64,
    inter_sample_coeffs: [[f64; TRUE_PEAK_INTER_SAMPLE_TAPS]; TRUE_PEAK_PHASES - 1],
}

/// EBU R128 loudness meter using the ebur128 crate
/// Measures integrated, short-term, momentary loudness and loudness range
pub struct LoudnessMeter {
    ebur128: ebur128::EbuR128,
    sample_rate: u32,
    channels: usize,
    true_peak: f64,
    samples_processed: u64,
    // 4x FIR true peak detector (per channel).
    true_peak_detectors: Vec<TruePeakDetector>,
}

impl LoudnessMeter {
    /// Create a meter for the given channel count and sample rate.
    ///
    /// Rejects zero channels/rate and EBU R128 backend geometry failure with a
    /// typed error; a failed backend is never represented as a usable meter.
    pub fn new(channels: usize, sample_rate: u32) -> Result<Self, ProcessError> {
        validated_channel_count(channels)?;
        validate_sample_rate_hz("LoudnessMeter", sample_rate)?;
        let ebur128 = new_ebur128(channels, sample_rate)?;
        let layout = ChannelLayout::from_count(channels);
        Self::with_backend(&layout, sample_rate, ebur128)
    }

    /// Create a meter with an explicit channel layout.
    ///
    /// The layout sets the EBU R128 channel map explicitly instead of relying
    /// on ebur128's channel-index default. This matters for layouts the default
    /// map handles incorrectly: for 8-channel input the default leaves channels
    /// 6–7 (the 7.1 side/back surrounds) `Unused`, so they contribute nothing
    /// to loudness; an explicit layout weights them as surrounds (+1.5 dB) per
    /// EBU R128. The LFE channel is always excluded from the measurement.
    ///
    /// For mono/stereo/5.1 the derived map matches ebur128's default, so
    /// existing measurements are unchanged.
    pub fn with_layout(layout: &ChannelLayout, sample_rate: u32) -> Result<Self, ProcessError> {
        let channels = layout.channel_count();
        validated_channel_count(channels)?;
        validate_sample_rate_hz("LoudnessMeter", sample_rate)?;
        let ebur128 = new_ebur128(channels, sample_rate)?;
        Self::with_backend(layout, sample_rate, ebur128)
    }

    fn with_backend(
        layout: &ChannelLayout,
        sample_rate: u32,
        mut ebur128: ebur128::EbuR128,
    ) -> Result<Self, ProcessError> {
        let channels = layout.channel_count();
        // Construction-time only (not the hot path): allocating the channel map
        // and (re)designing the ebur128 state here is allowed.
        let channel_map: Vec<ebur128::Channel> = layout
            .positions()
            .iter()
            .map(|position| ebur128_channel(*position))
            .collect();
        ebur128
            .set_channel_map(&channel_map)
            .map_err(|_| ProcessError::Backend {
                processor: "LoudnessMeter",
                operation: "configure EBU R128 channel map",
                message: "EBU R128 rejected the channel map",
            })?;

        // Create true peak detector for each channel
        let true_peak_detectors = (0..channels).map(|_| TruePeakDetector::new()).collect();

        Ok(Self {
            ebur128,
            sample_rate,
            channels,
            true_peak: -70.0,
            samples_processed: 0,
            true_peak_detectors,
        })
    }

    /// Reset meter state (call when starting a new track)
    pub fn reset(&mut self) {
        self.ebur128.reset();
        self.true_peak = -70.0;
        self.samples_processed = 0;
        // Reset true peak detectors
        for detector in &mut self.true_peak_detectors {
            detector.reset();
        }
    }

    /// Process interleaved f64 samples
    pub fn process(&mut self, samples: &[f64]) -> Result<(), ProcessError> {
        let block = AudioBlockRef::new(samples, self.channels)?;
        let frames = block.frames();
        if frames == 0 {
            return Ok(());
        }
        let samples = block.samples();

        self.ebur128
            .add_frames_f64(samples)
            .map_err(|_| ProcessError::Backend {
                processor: "LoudnessMeter",
                operation: "ingest interleaved frames",
                message: "EBU R128 rejected the audio block",
            })?;

        self.samples_processed += frames as u64;

        // True peak using 4x polyphase FIR oversampling.
        let fir = true_peak_fir();
        for frame in samples.chunks_exact(self.channels) {
            for (sample, detector) in frame.iter().zip(self.true_peak_detectors.iter_mut()) {
                detector.process_sample(*sample, fir);
            }
        }

        // Get maximum true peak across all channels
        let max_true_peak = self
            .true_peak_detectors
            .iter()
            .map(|d| d.max_true_peak())
            .fold(0.0_f64, f64::max);

        if max_true_peak > 0.0 {
            let peak_db = 20.0 * max_true_peak.log10();
            self.true_peak = peak_db.max(self.true_peak);
        }
        Ok(())
    }

    /// Materialize one gating measurement straight from the backend.
    ///
    /// `ebur128`'s momentary and short-term readers rescan their whole
    /// 400 ms / 3 s window on every call (`energy_in_interval` ->
    /// `Filter::calc_gating_block`) at a cost unrelated to the block just
    /// ingested. Evaluating all four inside `process` therefore dominated
    /// ingest — at 512-frame blocks it was the large majority of the work — so
    /// the readers now query the backend directly instead.
    ///
    /// This deliberately holds no cache: caching behind `&self` would require
    /// interior mutability, which would strip `LoudnessMeter` of `Sync` (and
    /// `Freeze`) and break the published auto-trait surface. Callers that read
    /// the same value repeatedly between blocks can hold onto the returned
    /// `f64`.
    ///
    /// Before any audio is consumed the backend has no gating block, so the
    /// documented pre-measurement reading is reported instead. Once audio has
    /// been ingested the mode configured in [`new_ebur128`] guarantees all four
    /// readers are available; a backend that still declines falls back to the
    /// same pre-measurement value, matching the previous behavior where a
    /// failed read simply left the cached field untouched.
    #[inline]
    fn gating_measurement(
        &self,
        read: impl FnOnce(&ebur128::EbuR128) -> Result<f64, ebur128::Error>,
        pre_measurement: f64,
    ) -> f64 {
        if self.samples_processed == 0 {
            return pre_measurement;
        }
        read(&self.ebur128).unwrap_or(pre_measurement)
    }

    /// Latest integrated loudness in LUFS (unreliable before 400 ms).
    pub fn integrated_loudness(&self) -> f64 {
        self.gating_measurement(|backend| backend.loudness_global(), -70.0)
    }
    /// Latest short-term loudness in LUFS.
    pub fn short_term_loudness(&self) -> f64 {
        self.gating_measurement(|backend| backend.loudness_shortterm(), -70.0)
    }
    /// Latest momentary loudness in LUFS.
    pub fn momentary_loudness(&self) -> f64 {
        self.gating_measurement(|backend| backend.loudness_momentary(), -70.0)
    }
    /// Latest loudness range in LU.
    pub fn loudness_range(&self) -> f64 {
        self.gating_measurement(|backend| backend.loudness_range(), 0.0)
    }

    /// Latest true-peak in dBTP.
    pub fn true_peak(&self) -> f64 {
        self.true_peak
    }
    /// Total samples consumed since construction or reset.
    pub fn samples_processed(&self) -> u64 {
        self.samples_processed
    }

    /// Whether enough audio has been measured for the readers to be meaningful.
    ///
    /// This remains false until at least one EBU R128 momentary window (400 ms)
    /// of audio has actually been consumed.
    pub fn has_reliable_measurement(&self) -> bool {
        let min_samples = (self.sample_rate as f64 * 0.4) as u64;
        self.samples_processed >= min_samples
    }
}

fn new_ebur128(channels: usize, sample_rate: u32) -> Result<ebur128::EbuR128, ProcessError> {
    let channels = u32::try_from(channels).map_err(|_| ProcessError::InvalidGeometry {
        processor: "LoudnessMeter",
        operation: "initialize EBU R128",
        message: "channel count exceeds the EBU R128 backend domain",
    })?;
    // `Mode::all()` would additionally enable SAMPLE_PEAK and TRUE_PEAK. This
    // meter reports its own 4x polyphase FIR true peak (`TruePeakDetector`) and
    // never reads `ebur128`'s peak values, so those modes were pure duplicated
    // work on every ingested sample.
    //
    // HISTOGRAM must stay enabled: it selects the histogram gating backend, and
    // dropping it changes the reported integrated loudness. `I | LRA |
    // HISTOGRAM` is bit-identical to `Mode::all()` for all four gating
    // measurements while roughly halving ingest cost.
    let mode = ebur128::Mode::I | ebur128::Mode::LRA | ebur128::Mode::HISTOGRAM;
    ebur128::EbuR128::new(channels, sample_rate, mode).map_err(|_| ProcessError::Backend {
        processor: "LoudnessMeter",
        operation: "initialize EBU R128",
        message: "EBU R128 rejected the channel or sample-rate geometry",
    })
}

/// True peak detector using 4x polyphase FIR oversampling.
///
/// The FIR follows libebur128's 49-tap Hanning-windowed sinc polyphase
/// interpolator shape. It replaces the older cubic interpolation estimate with
/// a bounded, no-heap process path. Formal BS.1770 conformance still depends on
/// validating against reference corpus data.
///
/// This drives loudness/true-peak *measurement*. The same per-sample FIR also
/// backs the limiter's default true-peak detection mode, so measurement and
/// limiting share one interpolator shape.
pub struct TruePeakDetector {
    /// Causal FIR history duplicated once so dot products read contiguous slices.
    history: [f64; TRUE_PEAK_HISTORY_LEN],
    write_pos: usize,
    /// Maximum true peak detected
    max_true_peak: f64,
}

impl TruePeakDetector {
    /// Create a detector with zeroed FIR history.
    pub fn new() -> Self {
        let _ = true_peak_fir();
        Self {
            history: [0.0; TRUE_PEAK_HISTORY_LEN],
            write_pos: 0,
            max_true_peak: 0.0,
        }
    }

    /// Process samples and update true peak measurement
    pub fn process(&mut self, samples: &[f64]) {
        let fir = true_peak_fir();
        for &sample in samples {
            self.process_sample(sample, fir);
        }
    }

    /// Process one channel from an interleaved buffer without allocating.
    pub fn process_strided(&mut self, samples: &[f64], offset: usize, stride: usize) {
        let fir = true_peak_fir();
        let mut index = offset;
        while index < samples.len() {
            self.process_sample(samples[index], fir);
            index += stride;
        }
    }

    #[inline]
    fn process_sample(&mut self, sample: f64, fir: &TruePeakFir) {
        self.max_true_peak = self.max_true_peak.max(self.intersample_peak(sample, fir));
    }

    /// Push one sample and return the intersample peak attributable to the
    /// current detector position (max of the sample magnitude and the three
    /// interpolated phases). Unlike [`Self::process_sample`] this does not
    /// accumulate into `max_true_peak`, so the limiter can use it as a
    /// per-frame control signal without carrying a running maximum.
    #[inline]
    pub(crate) fn intersample_peak(&mut self, sample: f64, fir: &TruePeakFir) -> f64 {
        self.history[self.write_pos] = sample;
        self.history[self.write_pos + TRUE_PEAK_DELAY] = sample;

        let dot_base = self.write_pos + TRUE_PEAK_DELAY - 11;
        let history = &self.history[dot_base..dot_base + TRUE_PEAK_INTER_SAMPLE_TAPS];
        let phase1 = dot12_contiguous(history, &fir.inter_sample_coeffs[0]);
        let phase2 = dot12_contiguous(history, &fir.inter_sample_coeffs[1]);
        let phase3 = dot12_contiguous(history, &fir.inter_sample_coeffs[2]);

        self.write_pos += 1;
        if self.write_pos == TRUE_PEAK_DELAY {
            self.write_pos = 0;
        }

        sample
            .abs()
            .max(phase1.abs())
            .max(phase2.abs())
            .max(phase3.abs())
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
        self.history.fill(0.0);
        self.write_pos = 0;
        self.max_true_peak = 0.0;
    }
}

impl Default for TruePeakDetector {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) fn true_peak_fir() -> &'static TruePeakFir {
    TRUE_PEAK_FIR.get_or_init(generate_true_peak_fir)
}

/// Maximum absolute reconstruction gain for a bounded additive sample error.
pub(crate) fn true_peak_reconstruction_l1_bound() -> f64 {
    true_peak_fir()
        .inter_sample_coeffs
        .iter()
        .map(|phase| {
            phase
                .iter()
                .map(|coefficient| coefficient.abs())
                .sum::<f64>()
        })
        .fold(1.0, f64::max)
}

fn generate_true_peak_fir() -> TruePeakFir {
    let mut fir = TruePeakFir {
        sample_phase_coeff: 0.0,
        inter_sample_coeffs: [[0.0; TRUE_PEAK_INTER_SAMPLE_TAPS]; TRUE_PEAK_PHASES - 1],
    };
    let center = (TRUE_PEAK_FIR_TAPS as f64 - 1.0) * 0.5;

    for tap_index in 0..TRUE_PEAK_FIR_TAPS {
        let phase = tap_index % TRUE_PEAK_PHASES;
        let position = tap_index as f64 - center;
        let window = 0.5
            * (1.0
                - (2.0 * std::f64::consts::PI * tap_index as f64
                    / (TRUE_PEAK_FIR_TAPS as f64 - 1.0))
                    .cos());
        let coeff = sinc(position / TRUE_PEAK_PHASES as f64) * window;

        if coeff.abs() > 1.0e-12 {
            if phase == 0 {
                fir.sample_phase_coeff = coeff;
            } else {
                fir.inter_sample_coeffs[phase - 1][tap_index / TRUE_PEAK_PHASES] = coeff;
            }
        }
    }

    fir
}

#[inline]
fn dot12_contiguous(history: &[f64], coeffs: &[f64; TRUE_PEAK_INTER_SAMPLE_TAPS]) -> f64 {
    history[11] * coeffs[0]
        + history[10] * coeffs[1]
        + history[9] * coeffs[2]
        + history[8] * coeffs[3]
        + history[7] * coeffs[4]
        + history[6] * coeffs[5]
        + history[5] * coeffs[6]
        + history[4] * coeffs[7]
        + history[3] * coeffs[8]
        + history[2] * coeffs[9]
        + history[1] * coeffs[10]
        + history[0] * coeffs[11]
}

#[inline]
fn sinc(x: f64) -> f64 {
    if x.abs() < 1.0e-12 {
        1.0
    } else {
        let pix = std::f64::consts::PI * x;
        pix.sin() / pix
    }
}

/// Map a [`ChannelPosition`] to the corresponding `ebur128::Channel` for R128
/// weighting. Surround (rear/side) positions become `LeftSurround`/
/// `RightSurround` (weighted +1.5 dB); LFE and unclassified channels become
/// `Unused` (excluded from the measurement).
fn ebur128_channel(position: ChannelPosition) -> ebur128::Channel {
    use ebur128::Channel as C;
    use ChannelPosition as P;
    match position {
        P::FrontLeft => C::Left,
        P::FrontRight => C::Right,
        P::FrontCenter => C::Center,
        P::LowFrequency => C::Unused,
        P::RearLeft | P::SideLeft => C::LeftSurround,
        P::RearRight | P::SideRight => C::RightSurround,
        P::FrontLeftCenter => C::MpSC,
        P::FrontRightCenter => C::MmSC,
        P::RearCenter => C::Mp180,
        P::Unspecified => C::Unused,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unspecified_channels_are_excluded_from_r128_weighting() {
        assert!(matches!(
            ebur128_channel(ChannelPosition::Unspecified),
            ebur128::Channel::Unused
        ));
    }

    fn deterministic_interleaved(frames: usize, channels: usize) -> Vec<f64> {
        let mut samples = Vec::with_capacity(frames * channels);
        for frame in 0..frames {
            for ch in 0..channels {
                let sample = ((frame as f64 * 0.017) + ch as f64 * 0.13).sin() * 0.5;
                samples.push(sample);
            }
        }
        samples
    }

    #[test]
    fn true_peak_strided_matches_channel_extract_for_common_channel_counts() {
        for channels in [1, 2, 6, 8] {
            let samples = deterministic_interleaved(512, channels);

            for ch in 0..channels {
                let channel_samples: Vec<f64> =
                    samples.iter().skip(ch).step_by(channels).copied().collect();
                let mut contiguous = TruePeakDetector::new();
                let mut strided = TruePeakDetector::new();

                contiguous.process(&channel_samples);
                strided.process_strided(&samples, ch, channels);

                assert_eq!(
                    contiguous.max_true_peak().to_bits(),
                    strided.max_true_peak().to_bits(),
                    "channels={channels}, channel={ch}"
                );
            }
        }
    }

    #[test]
    fn loudness_meter_rejects_partial_frames_without_mutation() {
        let mut meter = LoudnessMeter::new(2, 48_000).unwrap();
        meter.process(&deterministic_interleaved(64, 2)).unwrap();
        let samples = vec![0.1, -0.1, 0.2];
        let before = (
            meter.samples_processed(),
            meter.integrated_loudness().to_bits(),
            meter.short_term_loudness().to_bits(),
            meter.momentary_loudness().to_bits(),
            meter.loudness_range().to_bits(),
            meter.true_peak().to_bits(),
        );

        assert_eq!(
            meter.process(&samples),
            Err(ProcessError::InvalidBlock(
                crate::processor::traits::AudioBlockError::IncompleteFrame {
                    samples: 3,
                    channels: 2,
                }
            ))
        );

        assert_eq!(
            (
                meter.samples_processed(),
                meter.integrated_loudness().to_bits(),
                meter.short_term_loudness().to_bits(),
                meter.momentary_loudness().to_bits(),
                meter.loudness_range().to_bits(),
                meter.true_peak().to_bits(),
            ),
            before
        );
    }

    #[test]
    fn invalid_meter_geometry_is_rejected_at_construction() {
        assert!(matches!(
            LoudnessMeter::new(0, 48_000),
            Err(ProcessError::InvalidBlock(
                crate::processor::traits::AudioBlockError::ZeroChannels
            ))
        ));
        assert!(matches!(
            LoudnessMeter::new(2, 0),
            Err(ProcessError::InvalidSampleRate {
                processor: "LoudnessMeter",
                sample_rate_hz: 0,
            })
        ));
    }

    #[test]
    fn available_meter_becomes_reliable_only_after_one_momentary_window() {
        let sample_rate = 48_000;
        let mut meter = LoudnessMeter::new(2, sample_rate).unwrap();
        assert!(!meter.has_reliable_measurement());

        let window_frames = (sample_rate as f64 * 0.4) as usize;
        meter
            .process(&deterministic_interleaved(window_frames - 1, 2))
            .unwrap();
        assert!(!meter.has_reliable_measurement());

        meter.process(&deterministic_interleaved(1, 2)).unwrap();
        assert!(meter.has_reliable_measurement());
    }

    /// The narrowed `I | LRA | HISTOGRAM` mode must not change any reported
    /// gating measurement relative to the `Mode::all()` the meter used before.
    ///
    /// The signal deliberately steps its level so loudness range is non-zero:
    /// a constant-level signal reports LRA = 0 under every mode and would make
    /// this test pass without proving anything. `HISTOGRAM` in particular is
    /// load-bearing — dropping it shifts integrated loudness by a few
    /// millibels, so this guards against "simplifying" the mode further.
    #[test]
    fn narrowed_mode_matches_mode_all_bit_for_bit() {
        let sample_rate = 48_000;
        let channels = 2;
        let frames = 1_024;

        let mut narrowed = LoudnessMeter::new(channels, sample_rate).unwrap();
        let mut reference = LoudnessMeter::with_backend(
            &ChannelLayout::from_count(channels),
            sample_rate,
            ebur128::EbuR128::new(channels as u32, sample_rate, ebur128::Mode::all()).unwrap(),
        )
        .unwrap();

        let mut state = 12_345_u64;
        for block in 0..1_200 {
            // Step the level every ~2 s so the gating histogram spans several
            // bins and loudness range becomes non-zero.
            let amplitude = 0.05 + 0.9 * (((block / 90) % 5) as f64 / 4.0);
            let samples: Vec<f64> = (0..frames * channels)
                .map(|_| {
                    state = state
                        .wrapping_mul(6_364_136_223_846_793_005)
                        .wrapping_add(1);
                    ((state >> 11) as f64 / (1_u64 << 53) as f64 - 0.5) * 2.0 * amplitude
                })
                .collect();
            narrowed.process(&samples).unwrap();
            reference.process(&samples).unwrap();
        }

        assert!(
            reference.loudness_range() > 0.0,
            "fixture must exercise a non-zero loudness range, got {}",
            reference.loudness_range()
        );
        assert_eq!(
            narrowed.integrated_loudness(),
            reference.integrated_loudness()
        );
        assert_eq!(
            narrowed.short_term_loudness(),
            reference.short_term_loudness()
        );
        assert_eq!(
            narrowed.momentary_loudness(),
            reference.momentary_loudness()
        );
        assert_eq!(narrowed.loudness_range(), reference.loudness_range());
    }

    /// Deferring the gating reads must not change what a reader observes, at
    /// any point in the lifecycle: before the first block, between blocks,
    /// after repeated reads, and after `reset`.
    #[test]
    fn lazy_readers_match_eager_evaluation_across_the_lifecycle() {
        let sample_rate = 48_000;
        let channels = 2;

        let mut meter = LoudnessMeter::new(channels, sample_rate).unwrap();
        let mut eager = LoudnessMeter::new(channels, sample_rate).unwrap();

        let read = |meter: &LoudnessMeter| {
            (
                meter.integrated_loudness(),
                meter.short_term_loudness(),
                meter.momentary_loudness(),
                meter.loudness_range(),
            )
        };

        // Before any audio: the documented pre-measurement reading.
        assert_eq!(read(&meter), (-70.0, -70.0, -70.0, 0.0));

        for block in 0..80 {
            let samples = deterministic_interleaved(512, channels);
            meter.process(&samples).unwrap();

            // The eager comparison reads after every block, forcing a refresh
            // each time; `meter` is only read on some blocks. Skipped refreshes
            // must not change the value that finally surfaces.
            eager.process(&samples).unwrap();
            let eager_view = read(&eager);

            if block % 7 == 0 {
                assert_eq!(read(&meter), eager_view);
                // A repeated read without an intervening block is served from
                // the cache and must be identical.
                assert_eq!(read(&meter), eager_view);
            }
        }

        assert_eq!(read(&meter), read(&eager));

        meter.reset();
        eager.reset();
        assert_eq!(read(&meter), (-70.0, -70.0, -70.0, 0.0));
        assert_eq!(meter.samples_processed(), 0);

        // A single post-reset block is shorter than one gating window, so the
        // backend legitimately reports -inf for integrated loudness. What
        // matters is that the lazy reader agrees with the eager one exactly.
        let samples = deterministic_interleaved(512, channels);
        meter.process(&samples).unwrap();
        eager.process(&samples).unwrap();
        assert_eq!(read(&meter), read(&eager));
    }

    #[test]
    fn loudness_meter_process_is_steady_state_no_alloc() {
        let mut meter = LoudnessMeter::new(2, 48_000).unwrap();
        let samples = deterministic_interleaved(64, 2);

        assert_no_alloc::assert_no_alloc(|| {
            for _ in 0..1_000 {
                assert_eq!(meter.process(&samples), Ok(()));
            }
        });
    }

    #[test]
    fn loudness_meter_handles_surround_channel_counts() {
        for channels in [1, 2, 6, 8] {
            let mut meter = LoudnessMeter::new(channels, 48_000).unwrap();
            let samples = deterministic_interleaved(256, channels);

            meter.process(&samples).unwrap();

            assert_eq!(meter.samples_processed(), 256);
            assert!(meter.true_peak().is_finite());
        }
    }

    #[test]
    fn true_peak_fir_matches_libebur128_polyphase_shape() {
        let fir = true_peak_fir();

        assert!(fir.sample_phase_coeff.is_finite());
        assert!(fir.sample_phase_coeff.abs() > 1.0e-12);

        for phase in 0..TRUE_PEAK_PHASES - 1 {
            for tap in 0..TRUE_PEAK_INTER_SAMPLE_TAPS {
                assert!(fir.inter_sample_coeffs[phase][tap].is_finite());
                assert!(fir.inter_sample_coeffs[phase][tap].abs() > 1.0e-12);
            }
        }
    }

    #[test]
    fn true_peak_reset_clears_ring_history() {
        let mut detector = TruePeakDetector::new();
        detector.process(&[1.0; TRUE_PEAK_DELAY]);
        assert!(detector.max_true_peak() > 0.0);

        detector.reset();
        detector.process(&[0.0; TRUE_PEAK_DELAY]);

        assert_eq!(detector.max_true_peak(), 0.0);
    }

    #[test]
    fn true_peak_cross_buffer_continuity_matches_single_process() {
        let samples: Vec<f64> = (0..1024).map(|i| (i as f64 * 0.071).sin()).collect();
        let mut single = TruePeakDetector::new();
        let mut chunked = TruePeakDetector::new();

        single.process(&samples);
        for chunk in samples.chunks(17) {
            chunked.process(chunk);
        }

        assert_eq!(
            single.max_true_peak().to_bits(),
            chunked.max_true_peak().to_bits()
        );
    }

    #[test]
    fn true_peak_impulse_reaches_sample_peak_without_cubic_overshoot() {
        let mut detector = TruePeakDetector::new();
        let mut samples = vec![0.0; TRUE_PEAK_DELAY * 2];
        samples[TRUE_PEAK_DELAY / 2] = 1.0;

        detector.process(&samples);

        assert!(detector.max_true_peak() >= 1.0);
        assert!(detector.max_true_peak() < 1.1);
    }

    /// A steady tone placed only in a channel, at `sample_rate` for 1 second.
    fn tone_in_channel(channels: usize, channel: usize, sample_rate: u32) -> Vec<f64> {
        let frames = sample_rate as usize;
        let mut samples = vec![0.0; frames * channels];
        for f in 0..frames {
            let s = (f as f64 * std::f64::consts::TAU * 997.0 / sample_rate as f64).sin() * 0.1;
            samples[f * channels + channel] = s;
        }
        samples
    }

    #[test]
    fn explicit_layout_weights_7_1_side_surrounds_like_rear_surrounds() {
        use crate::channel_layout::ChannelLayout;
        let sample_rate = 48_000;
        let layout = ChannelLayout::surround_7_1();

        let measure = |channel: usize| {
            let mut meter = LoudnessMeter::with_layout(&layout, sample_rate).unwrap();
            meter
                .process(&tone_in_channel(8, channel, sample_rate))
                .unwrap();
            meter.integrated_loudness()
        };

        let rear_left = measure(4); // Ls — weighted by ebur128's default map too
        let side_left = measure(6); // SL — default map leaves this channel Unused

        assert!(rear_left.is_finite() && side_left.is_finite());
        assert!(rear_left > -70.0, "rear-left surround measured {rear_left}");
        // Both are surrounds with identical energy, so loudness should match.
        assert!(
            (rear_left - side_left).abs() < 0.1,
            "Ls {rear_left} vs SL {side_left} should match (both surrounds)"
        );
    }

    #[test]
    fn explicit_layout_fixes_7_1_weighting_vs_ebur128_default_map() {
        use crate::channel_layout::ChannelLayout;
        let sample_rate = 48_000;
        let samples = tone_in_channel(8, 6, sample_rate); // side-left only

        // ebur128's DEFAULT 8-channel map marks channel 6 Unused, so the energy
        // is dropped and no loudness registers.
        let mut default_ebur = ebur128::EbuR128::new(8, sample_rate, ebur128::Mode::all()).unwrap();
        default_ebur.add_frames_f64(&samples).unwrap();
        let default_loudness = default_ebur.loudness_global().unwrap_or(f64::NEG_INFINITY);

        // Our layout-mapped meter weights channel 6 as a surround.
        let mut meter =
            LoudnessMeter::with_layout(&ChannelLayout::surround_7_1(), sample_rate).unwrap();
        meter.process(&samples).unwrap();
        let mapped_loudness = meter.integrated_loudness();

        assert!(mapped_loudness > -70.0, "mapped loudness {mapped_loudness}");
        assert!(
            default_loudness < mapped_loudness - 10.0,
            "default map {default_loudness} should be far below layout-mapped {mapped_loudness}"
        );
    }
}
