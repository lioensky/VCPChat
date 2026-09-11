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
    /// Warm, gentle compression character.
    #[default]
    Tape,
    /// Rich even-harmonic tube character.
    Tube,
    /// Edgy odd-harmonic transistor character.
    Transistor,
}

/// Saturation processing quality.
///
/// `Direct` preserves the legacy source-rate waveshaper. The oversampled modes
/// spend bounded CPU on interpolated nonlinear processing plus fixed FIR
/// decimation to reduce high-frequency aliasing products.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub enum SaturationQuality {
    /// Legacy source-rate waveshaper (no oversampling).
    #[default]
    Direct,
    /// 2x oversampled nonlinear processing with fixed FIR decimation.
    Oversampled2x,
    /// 4x oversampled nonlinear processing with fixed FIR decimation.
    Oversampled4x,
}

const OVERSAMPLING_MAX_FILTER_TAPS: usize = 33;
/// Enabled Saturation keeps one fixed timeline across Direct and oversampled
/// quality modes. The oversampling filters' group delay is four source frames.
pub const SATURATION_LATENCY_FRAMES: usize = 4;
/// Width of the C1 transition from identity to the selected waveshaper.
///
/// A fixed 5% full-scale knee keeps the threshold local while remaining
/// continuous even when callers intentionally process samples above 0 dBFS.
const SATURATION_SOFT_KNEE_WIDTH: f64 = 0.05;
// Ten source frames rebuild either oversampling state: after the first replay
// frame establishes interpolation history, nine more frames push 18 samples
// through the 17-tap 2x FIR or 36 through the 33-tap 4x FIR.
const SATURATION_SOURCE_HISTORY_FRAMES: usize = 10;
const OVERSAMPLING_2X_FILTER: [f64; 17] = [
    5.251027135038586e-19,
    -3.0197042000540625e-4,
    2.851588800210736e-3,
    7.746002998672272e-3,
    -1.590176357619914e-2,
    -5.244242465496063e-2,
    3.804086149277052e-2,
    2.950296948494157e-1,
    4.499560210201921e-1,
    2.950296948494157e-1,
    3.804086149277053e-2,
    -5.244242465496067e-2,
    -1.5901763576199147e-2,
    7.746002998672269e-3,
    2.8515888002107396e-3,
    -3.019704200054068e-4,
    5.251027135038586e-19,
];
const OVERSAMPLING_4X_FILTER: [f64; OVERSAMPLING_MAX_FILTER_TAPS] = [
    2.625498272061368e-19,
    -6.89589757263199e-5,
    -1.5098433040796195e-4,
    1.9935259364948403e-4,
    1.4257860938530118e-3,
    3.2191159563376977e-3,
    3.872978936386087e-3,
    6.89620329927397e-4,
    -7.950835468636832e-3,
    -1.961391240495165e-2,
    -2.622105957052836e-2,
    -1.6252179284702004e-2,
    1.9020319939036252e-2,
    7.836872883124728e-2,
    1.4751398804726262e-1,
    2.034596893795545e-1,
    2.2497669985539734e-1,
    2.034596893795545e-1,
    1.4751398804726262e-1,
    7.836872883124729e-2,
    1.9020319939036256e-2,
    -1.6252179284702004e-2,
    -2.622105957052838e-2,
    -1.961391240495166e-2,
    -7.950835468636836e-3,
    6.89620329927397e-4,
    3.872978936386086e-3,
    3.219115956337702e-3,
    1.4257860938530135e-3,
    1.9935259364948398e-4,
    -1.5098433040796222e-4,
    -6.895897572632045e-5,
    2.625498272061368e-19,
];

impl SaturationQuality {
    #[inline]
    fn ratio(self) -> usize {
        match self {
            Self::Direct => 1,
            Self::Oversampled2x => 2,
            Self::Oversampled4x => 4,
        }
    }

    #[inline]
    fn decimation_filter(self) -> &'static [f64] {
        match self {
            Self::Direct => &[],
            Self::Oversampled2x => &OVERSAMPLING_2X_FILTER,
            Self::Oversampled4x => &OVERSAMPLING_4X_FILTER,
        }
    }
}

#[derive(Clone, Copy)]
struct OversamplingChannelState {
    previous_input: f64,
    initialized: bool,
    filter_history: [f64; OVERSAMPLING_MAX_FILTER_TAPS * 2],
    /// Start of the contiguous newest-to-oldest window for the active filter.
    filter_index: usize,
}

impl Default for OversamplingChannelState {
    fn default() -> Self {
        Self {
            previous_input: 0.0,
            initialized: false,
            filter_history: [0.0; OVERSAMPLING_MAX_FILTER_TAPS * 2],
            filter_index: 0,
        }
    }
}

impl OversamplingChannelState {
    fn reset(&mut self) {
        self.previous_input = 0.0;
        self.initialized = false;
        self.filter_history.fill(0.0);
        self.filter_index = 0;
    }

    fn initialize(&mut self, input: f64) {
        self.previous_input = input;
        self.initialized = true;
        self.filter_history.fill(0.0);
        self.filter_index = 0;
    }

    #[inline]
    fn push(&mut self, sample: f64, len: usize) {
        debug_assert!(len > 0 && len <= OVERSAMPLING_MAX_FILTER_TAPS);
        self.filter_index = if self.filter_index == 0 {
            len - 1
        } else {
            self.filter_index - 1
        };
        self.filter_history[self.filter_index] = sample;
        self.filter_history[self.filter_index + len] = sample;
    }

    #[inline(always)]
    fn evaluate<const TAPS: usize>(&self, coefficients: &[f64; TAPS]) -> f64 {
        debug_assert!(TAPS > 0 && TAPS <= OVERSAMPLING_MAX_FILTER_TAPS);
        let mut acc = 0.0;
        let history = &self.filter_history[self.filter_index..self.filter_index + TAPS];
        for (&coefficient, &sample) in coefficients.iter().zip(history) {
            acc += coefficient * sample;
        }

        acc
    }
}

#[derive(Clone, Copy)]
struct DelayChannelState {
    raw: [f64; SATURATION_LATENCY_FRAMES],
    dry: [f64; SATURATION_LATENCY_FRAMES],
    delta: [f64; SATURATION_LATENCY_FRAMES],
}

impl Default for DelayChannelState {
    fn default() -> Self {
        Self {
            raw: [0.0; SATURATION_LATENCY_FRAMES],
            dry: [0.0; SATURATION_LATENCY_FRAMES],
            delta: [0.0; SATURATION_LATENCY_FRAMES],
        }
    }
}

impl DelayChannelState {
    #[inline]
    fn push_raw(&mut self, sample: f64, index: usize) -> f64 {
        let delayed = self.raw[index];
        self.raw[index] = sample;
        delayed
    }

    #[inline]
    fn push_dry(&mut self, sample: f64, index: usize) -> f64 {
        let delayed = self.dry[index];
        self.dry[index] = sample;
        delayed
    }

    #[inline]
    fn push_delta(&mut self, sample: f64, index: usize) -> f64 {
        let delayed = self.delta[index];
        self.delta[index] = sample;
        delayed
    }

    fn reset(&mut self) {
        self.raw = [0.0; SATURATION_LATENCY_FRAMES];
        self.dry = [0.0; SATURATION_LATENCY_FRAMES];
        self.delta = [0.0; SATURATION_LATENCY_FRAMES];
    }
}

/// Tube Saturation processor with configurable drive and mix
///
/// When highpass_mode is enabled, only high frequencies (>4kHz) are saturated,
/// creating a more transparent "exciter" effect without muddying the low end.
///
/// Configuration is done through the `set_*` methods; current values can be read
/// back with [`Saturation::get_settings`]. For shared mutable access from another
/// thread, wrap this in `Arc<Mutex<Saturation>>`.
#[derive(Clone)]
pub struct Saturation {
    /// Saturation type
    sat_type: SaturationType,
    /// Processing quality / antialiasing mode.
    quality: SaturationQuality,
    /// Drive amount (0.0 - 2.0, default 0.25)
    drive: f64,
    /// Threshold where saturation begins (linear, default 0.88)
    threshold: f64,
    /// Mix between dry and wet (0.0 - 1.0, default 0.2)
    mix: f64,
    /// Input gain (dB, applied before saturation, default 0.0)
    input_gain_db: f64,
    /// Output gain compensation (dB, default 0.0)
    output_gain_db: f64,
    /// Cached linear input gain.
    input_gain_linear: f64,
    /// Cached linear output gain.
    output_gain_linear: f64,
    /// Enable/disable
    enabled: bool,

    // High-pass mode for exciter functionality
    /// Enable high-pass separation (only saturate highs)
    highpass_mode: bool,
    /// HPF cutoff frequency in Hz (default: 4000)
    highpass_cutoff: f64,

    // Sample rate for HPF coefficient calculation
    sample_rate: f64,
    // Cached HPF coefficient (recalculated when sample_rate or cutoff changes)
    hpf_coef: f64,

    // P1-5 fix: Per-channel HPF state (supports arbitrary channel count, not just stereo)
    /// HPF filter state per channel (y[n-1])
    hpf_states: Vec<f64>,
    /// Previous input per channel (x[n-1])
    prev_inputs: Vec<f64>,
    /// Per-channel oversampling state, pre-sized during setup.
    oversampling_states: Vec<OversamplingChannelState>,
    /// Recent full-band or HPF samples at the nonlinear/oversampling boundary.
    source_history: Vec<[f64; SATURATION_SOURCE_HISTORY_FRAMES]>,
    source_history_index: usize,
    source_history_len: usize,
    /// Per-channel fixed timeline and Direct/high-pass delta delay state.
    delay_states: Vec<DelayChannelState>,
    delay_index: usize,
}

impl Saturation {
    /// Create a new saturation processor with default settings
    pub fn new() -> Self {
        let mut instance = Self {
            sat_type: SaturationType::Tube,
            quality: SaturationQuality::Direct,
            drive: 0.25,
            threshold: 0.88,
            mix: 0.2,
            input_gain_db: 0.0,
            output_gain_db: 0.0,
            input_gain_linear: 1.0,
            output_gain_linear: 1.0,
            enabled: true,
            highpass_mode: false,
            highpass_cutoff: 4000.0,
            sample_rate: 44100.0,
            hpf_coef: 0.0, // Will be calculated below
            // P1-5 fix: Initialize for 2 channels by default, grows on demand
            hpf_states: vec![0.0; 2],
            prev_inputs: vec![0.0; 2],
            oversampling_states: vec![OversamplingChannelState::default(); 2],
            source_history: vec![[0.0; SATURATION_SOURCE_HISTORY_FRAMES]; 2],
            source_history_index: 0,
            source_history_len: 0,
            delay_states: vec![DelayChannelState::default(); 2],
            delay_index: 0,
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

    /// Copy configuration and signal state into an already-sized instance.
    ///
    /// This is used only by the preallocated quality-transition bank. Both
    /// instances must have the same setup-time channel geometry.
    pub(crate) fn copy_from_preallocated(&mut self, source: &Self) {
        debug_assert_eq!(self.hpf_states.len(), source.hpf_states.len());
        debug_assert_eq!(self.prev_inputs.len(), source.prev_inputs.len());
        debug_assert_eq!(
            self.oversampling_states.len(),
            source.oversampling_states.len()
        );
        debug_assert_eq!(self.source_history.len(), source.source_history.len());
        debug_assert_eq!(self.delay_states.len(), source.delay_states.len());
        if self.hpf_states.len() != source.hpf_states.len()
            || self.prev_inputs.len() != source.prev_inputs.len()
            || self.oversampling_states.len() != source.oversampling_states.len()
            || self.source_history.len() != source.source_history.len()
            || self.delay_states.len() != source.delay_states.len()
        {
            return;
        }

        self.sat_type = source.sat_type;
        self.quality = source.quality;
        self.drive = source.drive;
        self.threshold = source.threshold;
        self.mix = source.mix;
        self.input_gain_db = source.input_gain_db;
        self.output_gain_db = source.output_gain_db;
        self.input_gain_linear = source.input_gain_linear;
        self.output_gain_linear = source.output_gain_linear;
        self.enabled = source.enabled;
        self.highpass_mode = source.highpass_mode;
        self.highpass_cutoff = source.highpass_cutoff;
        self.sample_rate = source.sample_rate;
        self.hpf_coef = source.hpf_coef;
        self.hpf_states.copy_from_slice(&source.hpf_states);
        self.prev_inputs.copy_from_slice(&source.prev_inputs);
        self.oversampling_states
            .copy_from_slice(&source.oversampling_states);
        self.source_history.copy_from_slice(&source.source_history);
        self.source_history_index = source.source_history_index;
        self.source_history_len = source.source_history_len;
        self.delay_states.copy_from_slice(&source.delay_states);
        self.delay_index = source.delay_index;
    }

    /// Set drive amount, clamped to the published
    /// [`SATURATION_DRIVE_MIN`]..=[`SATURATION_DRIVE_MAX`] range.
    ///
    /// A non-finite value is dropped rather than clamped, because `f64::clamp`
    /// passes `NaN` through and would poison this stage for the rest of the
    /// stream. This matches the atomic publication layer.
    pub fn set_drive(&mut self, drive: f64) {
        if let Some(drive) = sanitized(drive, SATURATION_DRIVE_MIN, SATURATION_DRIVE_MAX) {
            self.drive = drive;
        }
    }

    /// Set the saturation onset threshold, clamped to the published
    /// [`SATURATION_THRESHOLD_MIN`]..=[`SATURATION_THRESHOLD_MAX`] range.
    /// A non-finite value is dropped, as in [`Self::set_drive`].
    pub fn set_threshold(&mut self, threshold: f64) {
        if let Some(threshold) = sanitized(
            threshold,
            SATURATION_THRESHOLD_MIN,
            SATURATION_THRESHOLD_MAX,
        ) {
            self.threshold = threshold;
        }
    }

    /// Set the dry/wet mix, clamped to the published
    /// [`SATURATION_MIX_MIN`]..=[`SATURATION_MIX_MAX`] range.
    /// A non-finite value is dropped, as in [`Self::set_drive`].
    pub fn set_mix(&mut self, mix: f64) {
        if let Some(mix) = sanitized(mix, SATURATION_MIX_MIN, SATURATION_MIX_MAX) {
            self.mix = mix;
        }
    }

    /// Set input gain (dB) applied before saturation, clamped to the published
    /// [`SATURATION_GAIN_DB_MIN`]..=[`SATURATION_GAIN_DB_MAX`] range.
    /// A non-finite value is dropped, as in [`Self::set_drive`].
    pub fn set_input_gain(&mut self, gain_db: f64) {
        let Some(gain_db) = sanitized(gain_db, SATURATION_GAIN_DB_MIN, SATURATION_GAIN_DB_MAX)
        else {
            return;
        };
        self.input_gain_db = gain_db;
        self.input_gain_linear = db_to_linear(gain_db);
    }

    /// Set output gain (dB), applied after the dry/wet saturation blend and
    /// clamped to the published
    /// [`SATURATION_GAIN_DB_MIN`]..=[`SATURATION_GAIN_DB_MAX`] range.
    /// A non-finite value is dropped, as in [`Self::set_drive`].
    pub fn set_output_gain(&mut self, gain_db: f64) {
        let Some(gain_db) = sanitized(gain_db, SATURATION_GAIN_DB_MIN, SATURATION_GAIN_DB_MAX)
        else {
            return;
        };
        self.output_gain_db = gain_db;
        self.output_gain_linear = db_to_linear(gain_db);
    }

    /// Enable/disable saturation
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// Set saturation type
    pub fn set_type(&mut self, sat_type: SaturationType) {
        self.sat_type = sat_type;
    }

    /// Set processing quality / antialiasing mode.
    pub fn set_quality(&mut self, quality: SaturationQuality) {
        if self.quality != quality {
            self.quality = quality;
            self.prepare_nonlinear_state_from_history();
        }
    }

    /// Enable/disable high-pass mode (exciter mode)
    pub fn set_highpass_mode(&mut self, enabled: bool) {
        if self.highpass_mode != enabled {
            self.reset_oversampling_states();
            self.reset_source_history();
        }
        self.highpass_mode = enabled;
    }

    /// Set the high-pass cutoff in Hz, clamped to the published
    /// [`SATURATION_HIGHPASS_CUTOFF_HZ_MIN`]..=[`SATURATION_HIGHPASS_CUTOFF_HZ_MAX`]
    /// range. A non-finite value is dropped, as in [`Self::set_drive`].
    pub fn set_highpass_cutoff(&mut self, hz: f64) {
        let Some(hz) = sanitized(
            hz,
            SATURATION_HIGHPASS_CUTOFF_HZ_MIN,
            SATURATION_HIGHPASS_CUTOFF_HZ_MAX,
        ) else {
            return;
        };
        self.highpass_cutoff = hz;
        self.update_hpf_coef();
    }

    /// Update sample rate and recalculate HPF coefficient.
    ///
    /// A sample-rate change starts a new timing domain. Discarding delay,
    /// oversampling, and HPF history prevents samples produced at the old
    /// rate from leaking into the new stream. Invalid rates are ignored by
    /// this infallible standalone setter; callback adapters validate before
    /// calling it.
    pub fn set_sample_rate(&mut self, sr: f64) {
        if !sr.is_finite() || sr <= 0.0 {
            return;
        }
        if self.sample_rate == sr {
            self.update_hpf_coef();
            return;
        }
        self.sample_rate = sr;
        self.update_hpf_coef();
        self.reset();
    }

    /// Pre-size the per-channel HPF state for `channels`, off the audio thread.
    ///
    /// Call this during setup (when the processor is built for a stream) so
    /// `process_highpass` never resizes `hpf_states`/`prev_inputs` on the realtime
    /// audio thread. Defaults keep the stereo size when `channels == 0`.
    pub fn set_channel_count(&mut self, channels: usize) {
        let channels = channels.max(1);
        if self.hpf_states.len() != channels {
            self.hpf_states.resize(channels, 0.0);
            self.prev_inputs.resize(channels, 0.0);
            self.oversampling_states
                .resize(channels, OversamplingChannelState::default());
            self.source_history
                .resize(channels, [0.0; SATURATION_SOURCE_HISTORY_FRAMES]);
            self.delay_states
                .resize(channels, DelayChannelState::default());
            self.reset();
        }
    }

    fn reset_oversampling_states(&mut self) {
        for state in &mut self.oversampling_states {
            state.reset();
        }
    }

    fn reset_source_history(&mut self) {
        for history in &mut self.source_history {
            history.fill(0.0);
        }
        self.source_history_index = 0;
        self.source_history_len = 0;
    }

    #[inline]
    fn record_source_sample(&mut self, channel: usize, sample: f64) {
        self.source_history[channel][self.source_history_index] = sample;
    }

    #[inline]
    fn advance_source_history(&mut self) {
        self.source_history_index =
            (self.source_history_index + 1) % SATURATION_SOURCE_HISTORY_FRAMES;
        self.source_history_len =
            (self.source_history_len + 1).min(SATURATION_SOURCE_HISTORY_FRAMES);
    }

    /// Rebuild only quality-dependent nonlinear state from recent source
    /// samples. HPF and timeline state remain copied and aligned across slots.
    pub(crate) fn prepare_nonlinear_state_from_history(&mut self) {
        self.reset_oversampling_states();
        for delay in &mut self.delay_states {
            delay.delta.fill(0.0);
        }

        let history_len = self.source_history_len;
        let history_start = (self.source_history_index + SATURATION_SOURCE_HISTORY_FRAMES
            - history_len)
            % SATURATION_SOURCE_HISTORY_FRAMES;
        let sat_type = self.sat_type;
        let threshold = self.threshold;
        let drive_plus1 = 1.0 + self.drive;

        for channel in 0..self.source_history.len() {
            let history = self.source_history[channel];
            if self.quality == SaturationQuality::Direct {
                let retained = history_len.min(SATURATION_LATENCY_FRAMES);
                for retained_offset in 0..retained {
                    let history_offset = history_len - retained + retained_offset;
                    let sample = history
                        [(history_start + history_offset) % SATURATION_SOURCE_HISTORY_FRAMES];
                    let shaped = Self::apply_thresholded_saturation(
                        sat_type,
                        sample,
                        threshold,
                        drive_plus1,
                    );
                    let delay_position = (self.delay_index + SATURATION_LATENCY_FRAMES - retained
                        + retained_offset)
                        % SATURATION_LATENCY_FRAMES;
                    self.delay_states[channel].delta[delay_position] = shaped - sample;
                }
                continue;
            }

            let ratio = self.quality.ratio();
            let filter = self.quality.decimation_filter();
            for history_offset in 0..history_len {
                let sample =
                    history[(history_start + history_offset) % SATURATION_SOURCE_HISTORY_FRAMES];
                Self::advance_oversampled_state(
                    &mut self.oversampling_states[channel],
                    sample,
                    ratio,
                    filter,
                    sat_type,
                    threshold,
                    drive_plus1,
                );
            }
        }
    }

    fn reset_delay_states(&mut self) {
        for state in &mut self.delay_states {
            state.reset();
        }
        self.delay_index = 0;
    }

    fn has_channel_capacity(&self, channels: usize) -> bool {
        self.hpf_states.len() >= channels
            && self.prev_inputs.len() >= channels
            && self.oversampling_states.len() >= channels
            && self.source_history.len() >= channels
            && self.delay_states.len() >= channels
    }

    /// Recalculate HPF coefficient based on current cutoff and sample rate
    fn update_hpf_coef(&mut self) {
        // Correct first-order RC HPF: α = fs / (fs + 2π·fc)
        // For difference equation y[n] = α·y[n-1] + α·(x[n] - x[n-1])
        // α close to 1.0 = low cutoff (passes more), α close to 0.0 = high cutoff
        self.hpf_coef =
            self.sample_rate / (self.sample_rate + std::f64::consts::TAU * self.highpass_cutoff);
    }

    /// Process interleaved f64 samples in-place
    pub fn process(&mut self, samples: &mut [f64]) {
        self.process_with_channels(samples, 2) // Default to stereo
    }

    /// Process interleaved f64 samples with specified channel count
    pub fn process_with_channels(&mut self, samples: &mut [f64], channels: usize) {
        self.process_with_channels_mix(samples, channels, 1.0);
    }

    /// Process with an additional effect-enable weight.
    ///
    /// The state advances exactly once for every source frame. A zero weight
    /// still emits the fixed delayed dry timeline, which lets an adapter ramp
    /// enable/disable without running a second copy of the DSP state.
    pub fn process_with_channels_mix(
        &mut self,
        samples: &mut [f64],
        channels: usize,
        effect_weight: f64,
    ) {
        if !self.enabled {
            return;
        }

        if channels == 0
            || !samples.len().is_multiple_of(channels)
            || !self.has_channel_capacity(channels)
        {
            return;
        }

        if self.highpass_mode {
            self.process_highpass(samples, channels, effect_weight);
        } else {
            self.process_fullband(samples, channels, effect_weight);
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
    fn process_fullband(&mut self, samples: &mut [f64], channels: usize, effect_weight: f64) {
        if self.quality != SaturationQuality::Direct {
            self.process_fullband_oversampled(samples, channels, effect_weight);
            return;
        }

        let input_gain = self.input_gain_linear;
        let output_gain = self.output_gain_linear;
        let threshold = self.threshold;
        let drive_plus1 = 1.0 + self.drive;
        let mix = self.mix;
        let sat_type = self.sat_type;

        let frames = samples.len() / channels;
        for frame in 0..frames {
            for ch in 0..channels {
                let index = frame * channels + ch;
                let raw = samples[index];
                let dry = raw * input_gain;
                let delayed_raw = self.delay_states[ch].push_raw(raw, self.delay_index);
                let delayed_dry = self.delay_states[ch].push_dry(dry, self.delay_index);
                let wet = Self::apply_thresholded_saturation(sat_type, dry, threshold, drive_plus1);
                let delayed_delta = self.delay_states[ch].push_delta(wet - dry, self.delay_index);
                let processed = (delayed_dry + delayed_delta * mix) * output_gain;
                samples[index] = delayed_raw + (processed - delayed_raw) * effect_weight;
                self.record_source_sample(ch, dry);
            }
            self.delay_index = (self.delay_index + 1) % SATURATION_LATENCY_FRAMES;
            self.advance_source_history();
        }
    }

    fn process_fullband_oversampled(
        &mut self,
        samples: &mut [f64],
        channels: usize,
        effect_weight: f64,
    ) {
        debug_assert!(
            self.oversampling_states.len() >= channels,
            "Saturation oversampling state undersized for {} channels (have {}); call set_channel_count during setup",
            channels,
            self.oversampling_states.len()
        );
        if self.oversampling_states.len() < channels {
            return;
        }

        match self.quality {
            SaturationQuality::Oversampled2x => self.process_fullband_oversampled_fixed::<2, 17>(
                samples,
                channels,
                effect_weight,
                &OVERSAMPLING_2X_FILTER,
            ),
            SaturationQuality::Oversampled4x => self
                .process_fullband_oversampled_fixed::<4, OVERSAMPLING_MAX_FILTER_TAPS>(
                    samples,
                    channels,
                    effect_weight,
                    &OVERSAMPLING_4X_FILTER,
                ),
            SaturationQuality::Direct => {}
        }
    }

    #[inline]
    fn process_fullband_oversampled_fixed<const RATIO: usize, const TAPS: usize>(
        &mut self,
        samples: &mut [f64],
        channels: usize,
        effect_weight: f64,
        filter: &[f64; TAPS],
    ) {
        debug_assert!(RATIO > 1);
        debug_assert!(TAPS > 0 && TAPS <= OVERSAMPLING_MAX_FILTER_TAPS);

        let input_gain = self.input_gain_linear;
        let output_gain = self.output_gain_linear;
        let threshold = self.threshold;
        let drive_plus1 = 1.0 + self.drive;
        let mix = self.mix;
        let sat_type = self.sat_type;

        let frames = samples.len() / channels;
        for frame in 0..frames {
            for ch in 0..channels {
                let index = frame * channels + ch;
                let raw = samples[index];
                let dry = raw * input_gain;
                let delayed_raw = self.delay_states[ch].push_raw(raw, self.delay_index);
                let delayed_dry = self.delay_states[ch].push_dry(dry, self.delay_index);
                let delta = Self::process_oversampled_delta_fixed::<RATIO, TAPS>(
                    &mut self.oversampling_states[ch],
                    dry,
                    filter,
                    sat_type,
                    threshold,
                    drive_plus1,
                );
                let processed = (delayed_dry + delta * mix) * output_gain;
                samples[index] = delayed_raw + (processed - delayed_raw) * effect_weight;
                self.record_source_sample(ch, dry);
            }
            self.delay_index = (self.delay_index + 1) % SATURATION_LATENCY_FRAMES;
            self.advance_source_history();
        }
    }

    /// High-pass separated saturation (exciter mode)
    /// Only saturates frequencies above the cutoff.
    /// P1-5 fix: Supports arbitrary channel count (was hardcoded to L/R only).
    fn process_highpass(&mut self, samples: &mut [f64], channels: usize, effect_weight: f64) {
        // HPF state is sized off the audio thread via `set_channel_count`; never
        // resize here, which would allocate on the realtime audio thread. If this
        // fires, a caller processed more channels than it was set up for.
        debug_assert!(
            self.hpf_states.len() >= channels,
            "Saturation HPF state undersized for {} channels (have {}); call set_channel_count during setup",
            channels,
            self.hpf_states.len()
        );
        debug_assert!(
            self.oversampling_states.len() >= channels,
            "Saturation oversampling state undersized for {} channels (have {}); call set_channel_count during setup",
            channels,
            self.oversampling_states.len()
        );
        if self.hpf_states.len() < channels
            || self.prev_inputs.len() < channels
            || self.oversampling_states.len() < channels
        {
            return;
        }

        match self.quality {
            SaturationQuality::Direct => {
                self.process_highpass_fixed::<1, 0>(samples, channels, effect_weight, &[])
            }
            SaturationQuality::Oversampled2x => self.process_highpass_fixed::<2, 17>(
                samples,
                channels,
                effect_weight,
                &OVERSAMPLING_2X_FILTER,
            ),
            SaturationQuality::Oversampled4x => self
                .process_highpass_fixed::<4, OVERSAMPLING_MAX_FILTER_TAPS>(
                    samples,
                    channels,
                    effect_weight,
                    &OVERSAMPLING_4X_FILTER,
                ),
        }
    }

    #[inline]
    fn process_highpass_fixed<const RATIO: usize, const TAPS: usize>(
        &mut self,
        samples: &mut [f64],
        channels: usize,
        effect_weight: f64,
        filter: &[f64; TAPS],
    ) {
        debug_assert!(
            (RATIO == 1 && TAPS == 0)
                || (RATIO > 1 && TAPS > 0 && TAPS <= OVERSAMPLING_MAX_FILTER_TAPS)
        );

        let input_gain = self.input_gain_linear;
        let output_gain = self.output_gain_linear;
        let alpha = self.hpf_coef;
        let threshold = self.threshold;
        let drive_plus1 = 1.0 + self.drive;
        let mix = self.mix;
        let sat_type = self.sat_type;

        let frames = samples.len() / channels;
        for frame in 0..frames {
            for ch in 0..channels {
                let idx = frame * channels + ch;
                let raw = samples[idx];
                let input = raw * input_gain;

                // First-order HPF: y[n] = α·y[n-1] + α·(x[n] - x[n-1])
                let high = alpha * self.hpf_states[ch] + alpha * (input - self.prev_inputs[ch]);
                self.hpf_states[ch] = high;
                self.prev_inputs[ch] = input;
                #[cfg(not(any(
                    target_arch = "x86",
                    target_arch = "x86_64",
                    target_arch = "aarch64"
                )))]
                {
                    self.hpf_states[ch] =
                        crate::runtime::flush_subnormal_sample(self.hpf_states[ch]);
                    self.prev_inputs[ch] =
                        crate::runtime::flush_subnormal_sample(self.prev_inputs[ch]);
                }

                // Apply saturation to high frequencies only.
                let delta = if TAPS == 0 {
                    let saturated =
                        Self::apply_thresholded_saturation(sat_type, high, threshold, drive_plus1);
                    self.delay_states[ch].push_delta(saturated - high, self.delay_index)
                } else {
                    Self::process_oversampled_delta_fixed::<RATIO, TAPS>(
                        &mut self.oversampling_states[ch],
                        high,
                        filter,
                        sat_type,
                        threshold,
                        drive_plus1,
                    )
                };

                let delayed_raw = self.delay_states[ch].push_raw(raw, self.delay_index);
                let delayed_input = self.delay_states[ch].push_dry(input, self.delay_index);
                // Mix: delayed input + delayed/filtered nonlinear residual.
                let processed = (delayed_input + delta * mix) * output_gain;
                samples[idx] = delayed_raw + (processed - delayed_raw) * effect_weight;
                self.record_source_sample(ch, high);
            }
            self.delay_index = (self.delay_index + 1) % SATURATION_LATENCY_FRAMES;
            self.advance_source_history();
        }
    }

    #[inline(always)]
    fn apply_saturation_type(sat_type: SaturationType, x: f64) -> f64 {
        match sat_type {
            SaturationType::Tape => x.signum() * (1.0 - (-x.abs()).exp()),
            SaturationType::Tube => x.tanh(),
            SaturationType::Transistor => {
                // Cubic soft clip `x - x³/3`, saturating at its extremum: the
                // derivative `1 - x²` reaches zero at |x| = 1 (value ±2/3), so
                // clamping the input there is monotonic and C1. Running the
                // cubic past its peak (the pre-1.0.1 code extended it to
                // |x| = 1.5, then plateaued at the folded-back value 0.375)
                // made louder input quieter across a 4.9 dB fold-back region —
                // a waveform folder, not a clipper.
                let x = x.clamp(-1.0, 1.0);
                x - (x * x * x) / 3.0
            }
        }
    }

    #[inline(always)]
    fn apply_thresholded_saturation(
        sat_type: SaturationType,
        input: f64,
        threshold: f64,
        drive_plus1: f64,
    ) -> f64 {
        let excess = input.abs() - threshold;
        if excess <= 0.0 {
            return input;
        }

        let shaped = Self::apply_saturation_type(sat_type, input * drive_plus1);
        let position = (excess / SATURATION_SOFT_KNEE_WIDTH).min(1.0);
        let weight = position * position * (3.0 - 2.0 * position);
        input + (shaped - input) * weight
    }

    #[inline(always)]
    fn process_oversampled_delta_fixed<const RATIO: usize, const TAPS: usize>(
        state: &mut OversamplingChannelState,
        input: f64,
        filter: &[f64; TAPS],
        sat_type: SaturationType,
        threshold: f64,
        drive_plus1: f64,
    ) -> f64 {
        Self::advance_oversampled_state_fixed::<RATIO, TAPS>(
            state,
            input,
            sat_type,
            threshold,
            drive_plus1,
        );
        state.evaluate(filter)
    }

    #[inline(always)]
    fn advance_oversampled_state_fixed<const RATIO: usize, const TAPS: usize>(
        state: &mut OversamplingChannelState,
        input: f64,
        sat_type: SaturationType,
        threshold: f64,
        drive_plus1: f64,
    ) {
        if !state.initialized {
            state.initialize(input);
        }

        let previous = state.previous_input;
        let delta = input - previous;
        for phase in 1..=RATIO {
            let t = phase as f64 / RATIO as f64;
            let interpolated = previous + delta * t;
            let shaped =
                Self::apply_thresholded_saturation(sat_type, interpolated, threshold, drive_plus1);
            state.push(shaped - interpolated, TAPS);
        }
        state.previous_input = input;
    }

    #[inline]
    fn advance_oversampled_state(
        state: &mut OversamplingChannelState,
        input: f64,
        ratio: usize,
        filter: &[f64],
        sat_type: SaturationType,
        threshold: f64,
        drive_plus1: f64,
    ) -> f64 {
        if !state.initialized {
            state.initialize(input);
        }

        let previous = state.previous_input;
        let delta = input - previous;
        let mut final_delta = 0.0;
        for phase in 1..=ratio {
            let t = phase as f64 / ratio as f64;
            let interpolated = previous + delta * t;
            let shaped =
                Self::apply_thresholded_saturation(sat_type, interpolated, threshold, drive_plus1);
            let nonlinear_delta = shaped - interpolated;
            if filter.is_empty() {
                final_delta = nonlinear_delta;
            } else {
                state.push(nonlinear_delta, filter.len());
            }
        }
        state.previous_input = input;
        final_delta
    }

    /// Reset filter state
    pub fn reset(&mut self) {
        self.hpf_states.fill(0.0);
        self.prev_inputs.fill(0.0);
        self.reset_oversampling_states();
        self.reset_source_history();
        self.reset_delay_states();
    }

    /// Fixed enabled-stage latency used by all quality modes.
    pub const fn latency_frames(&self) -> usize {
        if self.enabled {
            SATURATION_LATENCY_FRAMES
        } else {
            0
        }
    }

    /// Number of source frames needed to flush the fixed full-band state.
    /// High-pass mode is asymptotic and is handled by the unknown-tail driver.
    pub fn finite_tail_frames(&self) -> usize {
        if !self.enabled || self.highpass_mode {
            return 0;
        }
        let filter_tail = if self.quality == SaturationQuality::Direct {
            0
        } else {
            let ratio = self.quality.ratio();
            let taps = self.quality.decimation_filter().len();
            taps.saturating_sub(1).div_ceil(ratio)
        };
        SATURATION_LATENCY_FRAMES.max(filter_tail)
    }

    /// Finite effect tail beyond the fixed algorithmic delay.
    pub fn semantic_tail_frames(&self) -> usize {
        self.finite_tail_frames()
            .saturating_sub(self.latency_frames())
    }

    /// Process a transparently delayed bypass for an armed stage.
    ///
    /// This is distinct from [`Saturation::set_enabled`], whose disabled state
    /// remains the direct zero-latency hard bypass for standalone callers.
    pub fn process_delayed_bypass(&mut self, samples: &mut [f64], channels: usize) {
        if channels == 0
            || !samples.len().is_multiple_of(channels)
            || !self.has_channel_capacity(channels)
        {
            return;
        }
        debug_assert!(self.delay_states.len() >= channels);
        debug_assert!(self.source_history.len() >= channels);
        debug_assert!(self.hpf_states.len() >= channels);
        if self.delay_states.len() < channels
            || self.source_history.len() < channels
            || self.hpf_states.len() < channels
            || self.prev_inputs.len() < channels
        {
            return;
        }

        let input_gain = self.input_gain_linear;
        let alpha = self.hpf_coef;
        let frames = samples.len() / channels;
        for frame in 0..frames {
            for ch in 0..channels {
                let index = frame * channels + ch;
                let raw = samples[index];
                let gained = raw * input_gain;
                let nonlinear_source = if self.highpass_mode {
                    let high =
                        alpha * self.hpf_states[ch] + alpha * (gained - self.prev_inputs[ch]);
                    self.hpf_states[ch] = high;
                    self.prev_inputs[ch] = gained;
                    #[cfg(not(any(
                        target_arch = "x86",
                        target_arch = "x86_64",
                        target_arch = "aarch64"
                    )))]
                    {
                        self.hpf_states[ch] =
                            crate::runtime::flush_subnormal_sample(self.hpf_states[ch]);
                        self.prev_inputs[ch] =
                            crate::runtime::flush_subnormal_sample(self.prev_inputs[ch]);
                    }
                    high
                } else {
                    gained
                };
                self.record_source_sample(ch, nonlinear_source);
                samples[index] = self.delay_states[ch].push_raw(raw, self.delay_index);
                let _ = self.delay_states[ch].push_dry(gained, self.delay_index);
                let _ = self.delay_states[ch].push_delta(0.0, self.delay_index);
            }
            self.delay_index = (self.delay_index + 1) % SATURATION_LATENCY_FRAMES;
            self.advance_source_history();
        }
    }

    /// Get current settings as a struct
    pub fn get_settings(&self) -> SaturationSettings {
        SaturationSettings {
            sat_type: self.sat_type,
            quality: self.quality,
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
///
/// Supported, but not read by any other type in this crate. It exists so a
/// consuming application can report the active configuration; the realtime path
/// reads its values from the lock-free parameter snapshot instead.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SaturationSettings {
    /// Active saturation transfer character.
    pub sat_type: SaturationType,
    /// Active processing quality / antialiasing mode.
    pub quality: SaturationQuality,
    /// Input drive amount (0.0–2.0).
    pub drive: f64,
    /// Linear threshold where saturation begins.
    pub threshold: f64,
    /// Dry/wet mix (0.0–1.0).
    pub mix: f64,
    /// Input gain in dB.
    pub input_gain_db: f64,
    /// Output gain in dB.
    pub output_gain_db: f64,
    /// Whether the stage is enabled.
    pub enabled: bool,
    /// Whether only frequencies above the cutoff are saturated.
    pub highpass_mode: bool,
    /// Exciter-mode highpass cutoff in Hz.
    pub highpass_cutoff: f64,
}

use super::dsp::db_to_linear;
use super::lockfree_params::{
    sanitized, SATURATION_DRIVE_MAX, SATURATION_DRIVE_MIN, SATURATION_GAIN_DB_MAX,
    SATURATION_GAIN_DB_MIN, SATURATION_HIGHPASS_CUTOFF_HZ_MAX, SATURATION_HIGHPASS_CUTOFF_HZ_MIN,
    SATURATION_MIX_MAX, SATURATION_MIX_MIN, SATURATION_THRESHOLD_MAX, SATURATION_THRESHOLD_MIN,
};

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests;
