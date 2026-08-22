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
//! Source buffer
//!   → Loudness normalizer gain
//!   → canonical output chain:
//!     Volume → Equalizer → Saturation → Crossfeed → Convolver
//!     → DynamicLoudness → PeakLimiter → optional resampler
//!     → NoiseShaper → final output
//! ```

use super::lockfree_params::{
    sanitized, DYNAMIC_LOUDNESS_STRENGTH_MAX, DYNAMIC_LOUDNESS_STRENGTH_MIN,
};
use super::traits::{
    validate_processor_channels, validated_channel_count, AudioBlockMut, ProcessError,
};

// ============================================================================
// Biquad Filter Types
// ============================================================================

/// Biquad filter coefficients (normalized)
#[derive(Clone, Copy, Debug)]
struct BiquadCoeffs {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

impl Default for BiquadCoeffs {
    fn default() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
        }
    }
}

/// Biquad filter state (delay elements)
#[derive(Clone, Debug, Default)]
struct BiquadState {
    z1: f64,
    z2: f64,
}

/// Frequency/sample-rate invariants for a biquad filter.
#[derive(Clone, Debug)]
struct BiquadGeometry {
    freq: f64,
    q: f64,
    sample_rate: f64,
    cos_w0: f64,
    alpha: f64,
}

impl BiquadGeometry {
    fn new(freq: f64, q: f64, sample_rate: f64, filter_type: FilterType) -> Self {
        let w0 = 2.0 * std::f64::consts::PI * freq / sample_rate;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = match filter_type {
            FilterType::Peaking => sin_w0 / (2.0 * q),
            FilterType::LowShelf | FilterType::HighShelf => sin_w0 / std::f64::consts::SQRT_2,
        };

        Self {
            freq,
            q,
            sample_rate,
            cos_w0,
            alpha,
        }
    }
}

/// Biquad filter with multiple filter types
#[derive(Clone, Debug)]
struct BiquadFilter {
    geometry: BiquadGeometry,
    coeffs: BiquadCoeffs,
    state: BiquadState,
    filter_type: FilterType,
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
        let filter_type = FilterType::Peaking;
        let geometry = BiquadGeometry::new(freq, q, sample_rate, filter_type);
        let coeffs = Self::calc_peaking_coeffs(&geometry, gain_db);
        Self {
            geometry,
            coeffs,
            state: BiquadState::default(),
            filter_type,
        }
    }

    /// Create a low shelf filter
    fn low_shelf(freq: f64, gain_db: f64, sample_rate: f64) -> Self {
        let filter_type = FilterType::LowShelf;
        let geometry = BiquadGeometry::new(freq, 0.7, sample_rate, filter_type);
        let coeffs = Self::calc_low_shelf_coeffs(&geometry, gain_db);
        Self {
            geometry,
            coeffs,
            state: BiquadState::default(),
            filter_type,
        }
    }

    /// Create a high shelf filter
    fn high_shelf(freq: f64, gain_db: f64, sample_rate: f64) -> Self {
        let filter_type = FilterType::HighShelf;
        let geometry = BiquadGeometry::new(freq, 0.7, sample_rate, filter_type);
        let coeffs = Self::calc_high_shelf_coeffs(&geometry, gain_db);
        Self {
            geometry,
            coeffs,
            state: BiquadState::default(),
            filter_type,
        }
    }

    /// Calculate peaking filter coefficients
    /// Using RBJ Audio EQ Cookbook formulas
    fn calc_peaking_coeffs(geometry: &BiquadGeometry, gain_db: f64) -> BiquadCoeffs {
        if gain_db.abs() < 0.0001 {
            // Unity gain: bypass
            return BiquadCoeffs::default();
        }

        let a = 10.0_f64.powf(gain_db / 40.0); // gain_db/40 for peaking
        let cos_w0 = geometry.cos_w0;
        let alpha = geometry.alpha;

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
    fn calc_low_shelf_coeffs(geometry: &BiquadGeometry, gain_db: f64) -> BiquadCoeffs {
        if gain_db.abs() < 0.0001 {
            return BiquadCoeffs::default();
        }

        let a = 10.0_f64.powf(gain_db / 40.0);
        let cos_w0 = geometry.cos_w0;
        // RBJ cookbook: S=1 (shelf slope), alpha and beta formulas
        // alpha = sin(w0)/2 * sqrt(2) when S=1
        // two_sqrt_a_alpha = 2 * sqrt(A) * alpha
        let alpha = geometry.alpha;
        let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;

        let b0 = a * ((a + 1.0) - (a - 1.0) * cos_w0 + two_sqrt_a_alpha);
        let b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w0);
        let b2 = a * ((a + 1.0) - (a - 1.0) * cos_w0 - two_sqrt_a_alpha);
        let a0 = (a + 1.0) + (a - 1.0) * cos_w0 + two_sqrt_a_alpha;
        let a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cos_w0);
        let a2 = (a + 1.0) + (a - 1.0) * cos_w0 - two_sqrt_a_alpha;

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
    fn calc_high_shelf_coeffs(geometry: &BiquadGeometry, gain_db: f64) -> BiquadCoeffs {
        if gain_db.abs() < 0.0001 {
            return BiquadCoeffs::default();
        }

        let a = 10.0_f64.powf(gain_db / 40.0);
        let cos_w0 = geometry.cos_w0;
        // RBJ cookbook: S=1 (shelf slope), alpha and beta formulas
        let alpha = geometry.alpha;
        let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;

        let b0 = a * ((a + 1.0) + (a - 1.0) * cos_w0 + two_sqrt_a_alpha);
        let b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0);
        let b2 = a * ((a + 1.0) + (a - 1.0) * cos_w0 - two_sqrt_a_alpha);
        let a0 = (a + 1.0) - (a - 1.0) * cos_w0 + two_sqrt_a_alpha;
        let a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cos_w0);
        let a2 = (a + 1.0) - (a - 1.0) * cos_w0 - two_sqrt_a_alpha;

        BiquadCoeffs {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }

    /// Update gain (recalculates coefficients)
    #[cfg(test)]
    fn set_gain_db(&mut self, gain_db: f64) {
        self.coeffs = match self.filter_type {
            FilterType::Peaking => Self::calc_peaking_coeffs(&self.geometry, gain_db),
            FilterType::LowShelf => Self::calc_low_shelf_coeffs(&self.geometry, gain_db),
            FilterType::HighShelf => Self::calc_high_shelf_coeffs(&self.geometry, gain_db),
        };
    }

    /// Process a single sample (Direct Form I)
    #[inline(always)]
    fn process(&mut self, x: f64) -> f64 {
        let y = self.coeffs.b0 * x + self.state.z1;
        self.state.z1 = self.coeffs.b1 * x - self.coeffs.a1 * y + self.state.z2;
        self.state.z2 = self.coeffs.b2 * x - self.coeffs.a2 * y;
        #[cfg(not(any(target_arch = "x86", target_arch = "x86_64", target_arch = "aarch64")))]
        {
            self.state.z1 = crate::runtime::flush_subnormal_sample(self.state.z1);
            self.state.z2 = crate::runtime::flush_subnormal_sample(self.state.z2);
        }
        y
    }

    /// Reset filter state
    fn reset(&mut self) {
        self.state = BiquadState::default();
    }

    /// Update sample rate (recalculates coefficients)
    fn set_sample_rate(&mut self, sample_rate: f64) {
        if (self.geometry.sample_rate - sample_rate).abs() > 1.0 {
            self.geometry = BiquadGeometry::new(
                self.geometry.freq,
                self.geometry.q,
                sample_rate,
                self.filter_type,
            );
            // Recalculate with current gain (will be updated later)
            self.coeffs = match self.filter_type {
                FilterType::Peaking => Self::calc_peaking_coeffs(&self.geometry, 0.0),
                FilterType::LowShelf => Self::calc_low_shelf_coeffs(&self.geometry, 0.0),
                FilterType::HighShelf => Self::calc_high_shelf_coeffs(&self.geometry, 0.0),
            };
            self.reset();
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
    fn smoothing_coeff(smoothing_time_ms: f64, sample_rate: f64) -> f64 {
        let tau = (smoothing_time_ms / 1000.0) * sample_rate;
        if tau > 0.0 {
            (-1.0 / tau).exp()
        } else {
            0.0
        }
    }

    /// Create a new smoother with time constant in milliseconds
    fn new(smoothing_time_ms: f64, sample_rate: f64) -> Self {
        Self {
            current: 0.0,
            target: 0.0,
            coeff: Self::smoothing_coeff(smoothing_time_ms, sample_rate),
            samples_remaining: 0,
        }
    }

    fn set_sample_rate(&mut self, smoothing_time_ms: f64, sample_rate: f64) {
        self.coeff = Self::smoothing_coeff(smoothing_time_ms, sample_rate);
    }

    /// Set target value
    fn set_target(&mut self, target: f64) {
        if (self.target - target).abs() > 0.0001 {
            self.target = target;
            self.samples_remaining = usize::MAX; // Start smoothing
        }
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
    (40.0, 12.0, 0.0), // freq, max_gain_db, Q (0 = shelf)
    (100.0, 10.0, 0.9),
    (300.0, 4.0, 1.0),
    (1000.0, 0.0, 1.0), // Reference band (no boost)
    (3000.0, 2.0, 0.9),
    (8000.0, 4.0, 0.8),
    (12000.0, 6.0, 0.0), // High shelf
];

/// Number of dynamic-loudness bands, derived from [`LOUDNESS_BANDS`] so adding
/// or removing a band cannot leave a stale count behind.
pub const LOUDNESS_BANDS_N: usize = LOUDNESS_BANDS.len();

/// Block size for coefficient updates (CPU optimization)
const BLOCK_SIZE: usize = 64;
const GAIN_UPDATE_EPSILON_DB: f64 = 0.01;
const BAND_ACTIVE_EPSILON_DB: f64 = 0.0001;

// Reference-curve bounds owned by this model. `lockfree_params` re-exports
// them as the published control range for the dynamic-loudness tuning
// snapshot, so this module stays the single source of truth and the two layers
// cannot drift apart.
/// Quietest listening reference the compensation curve is calibrated for.
pub(crate) const REFERENCE_VOLUME_DB_MIN: f64 = -30.0;
/// Loudest listening reference, at which no compensation is applied.
pub(crate) const REFERENCE_VOLUME_DB_MAX: f64 = 0.0;
/// Narrowest span over which compensation ramps from none to full.
pub(crate) const TRANSITION_DB_MIN: f64 = 10.0;
/// Widest such span.
pub(crate) const TRANSITION_DB_MAX: f64 = 40.0;
/// Deepest pre-gain attenuation the bass-boost headroom control accepts.
pub(crate) const PRE_GAIN_DB_MIN: f64 = -6.0;
/// Shallowest pre-gain: no headroom is reserved.
pub(crate) const PRE_GAIN_DB_MAX: f64 = 0.0;
/// Default headroom reserved ahead of the low-band boost.
pub(crate) const PRE_GAIN_DB_DEFAULT: f64 = -3.0;
/// Default compensation onset: the listening level below which the curve
/// starts adding gain.
pub(crate) const REFERENCE_VOLUME_DB_DEFAULT: f64 = -15.0;
/// Default span from onset to full compensation.
pub(crate) const TRANSITION_DB_DEFAULT: f64 = 25.0;

/// Convert a pre-gain in dB to the linear multiplier the process loop applies.
///
/// Shared by the constructor and [`DynamicLoudness::set_pre_gain_db`] so the
/// default and a control-thread update cannot encode the same dB value
/// differently.
#[inline]
pub(crate) fn pre_gain_db_to_linear(db: f64) -> f64 {
    10.0_f64.powf(db / 20.0)
}

/// Dynamic Loudness Compensation processor
///
/// Implements ISO 226 inspired loudness compensation using a 7-band dynamic EQ.
/// At low volumes, boosts low and high frequencies to compensate for the
/// ear's reduced sensitivity (Fletcher-Munson effect).
pub struct DynamicLoudness {
    /// Per-channel filter banks
    filters: Vec<[BiquadFilter; LOUDNESS_BANDS_N]>,
    /// Per-band parameter smoothers
    smoothers: Vec<ParameterSmoother>,
    /// Last gain actually applied to each band coefficient set.
    last_applied_gains: [f64; LOUDNESS_BANDS_N],
    /// Whether each band currently has non-identity coefficients.
    active_bands: [bool; LOUDNESS_BANDS_N],
    /// Maximum boost per band (dB)
    max_gains: [f64; LOUDNESS_BANDS_N],
    /// Reference volume in dB (above this, no compensation)
    ref_volume_db: f64,
    /// Transition range in dB (from ref to max compensation)
    transition_db: f64,
    /// Cached linear pre-gain.
    pre_gain_linear: f64,
    /// Sample rate
    sample_rate: f64,
    /// Number of channels
    channels: usize,
    /// Current loudness factor (0.0 = full volume, 1.0 = max compensation)
    current_loudness_factor: f64,
    /// User strength multiplier (0.0 - 1.0)
    strength: f64,
    /// Enabled flag
    enabled: bool,
}

impl DynamicLoudness {
    /// Create a new DynamicLoudness processor
    pub fn new(channels: usize, sample_rate: f64) -> Result<Self, ProcessError> {
        validated_channel_count(channels)?;
        Self::validate_sample_rate(sample_rate)?;
        Ok(Self::new_validated(channels, sample_rate))
    }

    pub(crate) fn new_validated(channels: usize, sample_rate: f64) -> Self {
        let filters: Vec<[BiquadFilter; LOUDNESS_BANDS_N]> = (0..channels)
            .map(|_| Self::build_channel_filters(sample_rate))
            .collect();

        let smoothers: Vec<ParameterSmoother> = LOUDNESS_BANDS
            .iter()
            .map(|_| ParameterSmoother::new(50.0, sample_rate)) // 50ms smoothing
            .collect();

        let max_gains = LOUDNESS_BANDS.map(|(_, max_gain, _)| max_gain);

        Self {
            filters,
            smoothers,
            last_applied_gains: [f64::NAN; LOUDNESS_BANDS_N],
            active_bands: [false; LOUDNESS_BANDS_N],
            max_gains,
            ref_volume_db: REFERENCE_VOLUME_DB_DEFAULT, // Reference: ~50% perceived loudness
            transition_db: TRANSITION_DB_DEFAULT, // Compensation starts below -15 dB, max at -40 dB
            // Headroom for bass boost (-3 dB).
            pre_gain_linear: pre_gain_db_to_linear(PRE_GAIN_DB_DEFAULT),
            sample_rate,
            channels,
            current_loudness_factor: 0.0,
            strength: 1.0,
            enabled: true,
        }
    }

    fn build_channel_filters(sample_rate: f64) -> [BiquadFilter; LOUDNESS_BANDS_N] {
        std::array::from_fn(|idx| {
            let (freq, _max_gain, q) = LOUDNESS_BANDS[idx];
            if q == 0.0 && freq < 1000.0 {
                BiquadFilter::low_shelf(freq, 0.0, sample_rate)
            } else if q == 0.0 {
                BiquadFilter::high_shelf(freq, 0.0, sample_rate)
            } else {
                BiquadFilter::peaking(freq, 0.0, q, sample_rate)
            }
        })
    }

    fn calculate_band_coeffs(&self, band: usize, gain_db: f64) -> BiquadCoeffs {
        let filter = &self.filters[0][band];
        match filter.filter_type {
            FilterType::Peaking => BiquadFilter::calc_peaking_coeffs(&filter.geometry, gain_db),
            FilterType::LowShelf => BiquadFilter::calc_low_shelf_coeffs(&filter.geometry, gain_db),
            FilterType::HighShelf => {
                BiquadFilter::calc_high_shelf_coeffs(&filter.geometry, gain_db)
            }
        }
    }

    fn apply_band_gain_if_changed(&mut self, band: usize, gain_db: f64) {
        let should_be_active = gain_db.abs() >= BAND_ACTIVE_EPSILON_DB;
        if (gain_db - self.last_applied_gains[band]).abs() < GAIN_UPDATE_EPSILON_DB
            && self.active_bands[band] == should_be_active
        {
            return;
        }

        let coeffs = self.calculate_band_coeffs(band, gain_db);
        for ch_filters in &mut self.filters {
            ch_filters[band].coeffs = coeffs;
        }
        self.last_applied_gains[band] = gain_db;
        self.active_bands[band] = should_be_active;
    }

    fn refresh_smoother_targets(&mut self) {
        for (i, smoother) in self.smoothers.iter_mut().enumerate() {
            let target_gain = self.max_gains[i] * self.current_loudness_factor * self.strength;
            smoother.set_target(target_gain);
        }
    }

    fn can_bypass_for_zero_strength(&self) -> bool {
        self.strength < 0.0001
            && self.active_bands.iter().all(|&active| !active)
            && self
                .smoothers
                .iter()
                .all(|smoother| smoother.samples_remaining == 0)
    }

    /// Set user volume as linear value (0.0 - 1.0)
    /// This is the main control input. A non-finite value is ignored.
    pub fn set_volume(&mut self, linear_volume: f64) {
        if !linear_volume.is_finite() {
            return;
        }
        let volume_db = if linear_volume > 0.0 {
            20.0 * linear_volume.log10()
        } else {
            f64::NEG_INFINITY
        };

        self.update_loudness_factor(volume_db);
    }

    /// Set user volume as percentage (0 - 100). A non-finite value is ignored.
    pub fn set_volume_percent(&mut self, percent: f64) {
        self.set_volume(percent / 100.0);
    }

    /// Set user volume as dB. A non-finite value is ignored, because it would
    /// otherwise reach the compensation-factor arithmetic below.
    pub fn set_volume_db(&mut self, volume_db: f64) {
        if !volume_db.is_finite() {
            return;
        }
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
            self.refresh_smoother_targets();
        }
    }

    /// Set compensation strength, clamped to the published
    /// [`DYNAMIC_LOUDNESS_STRENGTH_MIN`]..=[`DYNAMIC_LOUDNESS_STRENGTH_MAX`]
    /// range. A non-finite value is ignored.
    pub fn set_strength(&mut self, strength: f64) {
        let Some(strength) = sanitized(
            strength,
            DYNAMIC_LOUDNESS_STRENGTH_MIN,
            DYNAMIC_LOUDNESS_STRENGTH_MAX,
        ) else {
            return;
        };
        if (self.strength - strength).abs() > 0.0001 {
            self.strength = strength;
            self.refresh_smoother_targets();
        }
    }

    /// Set reference volume level in dB, clamped to the internal
    /// `REFERENCE_VOLUME_DB_MIN`..=`REFERENCE_VOLUME_DB_MAX` range.
    /// A non-finite value is ignored.
    pub fn set_reference_volume_db(&mut self, ref_db: f64) {
        if let Some(ref_db) = sanitized(ref_db, REFERENCE_VOLUME_DB_MIN, REFERENCE_VOLUME_DB_MAX) {
            self.ref_volume_db = ref_db;
        }
    }

    /// Set transition range in dB, clamped to the internal
    /// `TRANSITION_DB_MIN`..=`TRANSITION_DB_MAX` range.
    ///
    /// A non-finite value is ignored; it would otherwise become the divisor in
    /// the internal `update_loudness_factor` step and make every band gain
    /// `NaN`.
    pub fn set_transition_db(&mut self, transition_db: f64) {
        if let Some(transition_db) = sanitized(transition_db, TRANSITION_DB_MIN, TRANSITION_DB_MAX)
        {
            self.transition_db = transition_db;
        }
    }

    /// Set the headroom reserved ahead of the low-band boost, in dB, clamped
    /// to the internal `PRE_GAIN_DB_MIN`..=`PRE_GAIN_DB_MAX` range.
    ///
    /// The compensation curve adds low-frequency gain, so the stage attenuates
    /// first to keep the boosted signal from clipping. A shallower pre-gain
    /// preserves level at the cost of that headroom; `0.0` reserves none.
    ///
    /// This updates a cached scalar only — no filter coefficient is redesigned
    /// and no delay history is touched, so a change is safe between blocks and
    /// does not disturb the band smoothers. A non-finite value is ignored.
    pub fn set_pre_gain_db(&mut self, pre_gain_db: f64) {
        if let Some(pre_gain_db) = sanitized(pre_gain_db, PRE_GAIN_DB_MIN, PRE_GAIN_DB_MAX) {
            self.pre_gain_linear = pre_gain_db_to_linear(pre_gain_db);
        }
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
            self.active_bands = [false; LOUDNESS_BANDS_N];
            self.last_applied_gains = [f64::NAN; LOUDNESS_BANDS_N];
        }
        self.enabled = enabled;
    }

    /// Update sample rate
    pub fn set_sample_rate(&mut self, sample_rate: f64) -> Result<(), ProcessError> {
        Self::validate_sample_rate(sample_rate)?;
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
                smoother.set_sample_rate(50.0, sample_rate);
            }

            // Old-rate biquad histories were reset above. Rebuild each band at
            // its preserved current smoother gain before the next frame.
            self.last_applied_gains = [f64::NAN; LOUDNESS_BANDS_N];
            self.active_bands = [false; LOUDNESS_BANDS_N];
            for band in 0..LOUDNESS_BANDS_N {
                self.apply_band_gain_if_changed(band, self.smoothers[band].current);
            }
        }
        Ok(())
    }

    /// Process interleaved audio buffer
    ///
    /// Coefficient ramps now track the per-block smoother *within* the buffer:
    /// each `BLOCK_SIZE`-frame chunk advances the smoothers, applies any changed
    /// band gain, then filters only that chunk's frames. This avoids the
    /// end-of-buffer "zipper" that occurred when the whole buffer was filtered
    /// with only the final block's coefficients. Total smoother advancement is
    /// unchanged (Σ chunk_frames == frames), so end-of-buffer state matches the
    /// previous behavior; buffers ≤ BLOCK_SIZE are filtered as a single block.
    pub fn process(&mut self, buffer: &mut [f64], channels: usize) -> Result<(), ProcessError> {
        let block = AudioBlockMut::new(buffer, channels)?;
        validate_processor_channels("DynamicLoudness", Some(self.channels), channels)?;
        self.process_validated(block.into_samples());
        Ok(())
    }

    pub(crate) fn process_validated(&mut self, buffer: &mut [f64]) {
        if !self.enabled || self.can_bypass_for_zero_strength() {
            return;
        }

        let frames = buffer.len() / self.channels;
        if frames == 0 {
            return;
        }

        // Interleave per-block coefficient updates with filtering so the gain
        // ramp is applied as it is computed.
        for chunk_start in (0..frames).step_by(BLOCK_SIZE) {
            let chunk_end = (chunk_start + BLOCK_SIZE).min(frames);
            let chunk_frames = chunk_end - chunk_start;

            for i in 0..self.smoothers.len() {
                let gain = self.smoothers[i].next_block(chunk_frames);
                self.apply_band_gain_if_changed(i, gain);
            }

            self.process_samples_range(buffer, chunk_start, chunk_end);
        }
    }

    fn validate_sample_rate(sample_rate: f64) -> Result<(), ProcessError> {
        if !sample_rate.is_finite() || sample_rate <= 0.0 {
            return Err(ProcessError::InvalidGeometry {
                processor: "DynamicLoudness",
                operation: "configure sample rate",
                message: "sample rate must be finite and greater than zero",
            });
        }
        Ok(())
    }

    /// Internal: apply pre-gain and active-band filtering to `[start_frame, end_frame)`.
    ///
    /// When no band is active the band loop is skipped, so this reduces to
    /// applying pre-gain only.
    fn process_samples_range(&mut self, buffer: &mut [f64], start_frame: usize, end_frame: usize) {
        for frame in start_frame..end_frame {
            for ch in 0..self.channels {
                let idx = frame * self.channels + ch;
                let mut sample = buffer[idx] * self.pre_gain_linear;

                let ch_filters = &mut self.filters[ch];
                for (band, filter) in ch_filters.iter_mut().enumerate() {
                    if self.active_bands[band] {
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
        self.last_applied_gains = [f64::NAN; LOUDNESS_BANDS_N];
        self.active_bands = [false; LOUDNESS_BANDS_N];
    }

    /// Get current loudness factor (for display)
    pub fn loudness_factor(&self) -> f64 {
        self.current_loudness_factor
    }

    /// Get current band gains (for display/metering)
    pub fn get_band_gains(&self) -> [f64; LOUDNESS_BANDS_N] {
        let mut gains = [0.0; LOUDNESS_BANDS_N];
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

    /// Current linear pre-gain, for tests and crate-internal assertions.
    ///
    /// Deliberately not public: the dB value is the published control, and the
    /// linear cache is an implementation detail of the process loop.
    #[cfg(test)]
    pub(crate) fn pre_gain_linear(&self) -> f64 {
        self.pre_gain_linear
    }

    /// Current transition span in dB, for tests.
    #[cfg(test)]
    pub(crate) fn transition_db(&self) -> f64 {
        self.transition_db
    }

    /// Current compensation onset in dB, for tests.
    ///
    /// Named after the published control rather than the internal field, which
    /// shares a name with the unrelated listening-volume reference in
    /// `DynamicLoudnessParamsSnapshot`.
    #[cfg(test)]
    pub(crate) fn compensation_ref_db(&self) -> f64 {
        self.ref_volume_db
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests;
