//! Lock-free Parameter Structures
//!
//! Provides snapshot-based parameter passing from main thread to audio thread.
//! This eliminates the need for mutexes in the audio callback, ensuring
//! that DSP processing is never blocked or skipped due to lock contention.
//!
//! # Design Pattern
//!
//! Control-side reads retain convenient immutable snapshots. Realtime
//! consumers subscribe during setup to a dedicated hazard slot and
//! copy a complete `Copy` snapshot at block boundaries. Replaced storage is
//! reclaimed only by the control-side publisher, so the audio thread never
//! allocates, deallocates, or becomes the last owner of a published snapshot.

use super::traits::ProcessError;
use std::ptr;
use std::sync::{
    atomic::{AtomicPtr, AtomicU64, Ordering},
    Arc, Mutex, MutexGuard,
};

use super::atomic_f64::AtomicF64;

use crate::processor::loudness::LimiterMode;

use super::crossfeed::{
    DEFAULT_CUTOFF_HZ as CROSSFEED_DEFAULT_CUTOFF_HZ, DEFAULT_MIX as CROSSFEED_DEFAULT_MIX,
    MAX_CUTOFF_HZ as CROSSFEED_MAX_CUTOFF_HZ, MIN_CUTOFF_HZ as CROSSFEED_MIN_CUTOFF_HZ,
};
use super::dynamic_loudness::{
    LOUDNESS_BANDS_N, PRE_GAIN_DB_DEFAULT as DYNAMIC_LOUDNESS_PRE_GAIN_DB_DEFAULT,
    PRE_GAIN_DB_MAX as DYNAMIC_LOUDNESS_PRE_GAIN_DB_LIMIT_MAX,
    PRE_GAIN_DB_MIN as DYNAMIC_LOUDNESS_PRE_GAIN_DB_LIMIT_MIN,
    REFERENCE_VOLUME_DB_DEFAULT as DYNAMIC_LOUDNESS_COMPENSATION_REF_DB_DEFAULT,
    REFERENCE_VOLUME_DB_MAX as DYNAMIC_LOUDNESS_COMPENSATION_REF_DB_LIMIT_MAX,
    REFERENCE_VOLUME_DB_MIN as DYNAMIC_LOUDNESS_COMPENSATION_REF_DB_LIMIT_MIN,
    TRANSITION_DB_DEFAULT as DYNAMIC_LOUDNESS_TRANSITION_DB_DEFAULT,
    TRANSITION_DB_MAX as DYNAMIC_LOUDNESS_TRANSITION_DB_LIMIT_MAX,
    TRANSITION_DB_MIN as DYNAMIC_LOUDNESS_TRANSITION_DB_LIMIT_MIN,
};

// ============================================================================
// Published control-value ranges
// ============================================================================
//
// These are the single source of truth for what a control thread may publish.
// Every setter below clamps to them, and the high-level playback facade
// re-exports them so a UI can bound its own widgets.

/// Smallest publishable callback volume multiplier.
pub const VOLUME_MIN: f64 = 0.0;
/// Largest publishable callback volume multiplier: the callback stage
/// attenuates only, so positive gain belongs upstream.
pub const VOLUME_MAX: f64 = 1.0;
/// Smallest publishable equalizer band gain, in dB.
pub const EQ_BAND_GAIN_DB_MIN: f64 = -15.0;
/// Largest publishable equalizer band gain, in dB.
pub const EQ_BAND_GAIN_DB_MAX: f64 = 15.0;
/// Smallest publishable limiter threshold, in dB.
pub const LIMITER_THRESHOLD_DB_MIN: f64 = -20.0;
/// Largest publishable limiter threshold, in dB.
pub const LIMITER_THRESHOLD_DB_MAX: f64 = 0.0;
/// Smallest publishable limiter release, in milliseconds.
pub const LIMITER_RELEASE_MS_MIN: f64 = 10.0;
/// Largest publishable limiter release, in milliseconds.
pub const LIMITER_RELEASE_MS_MAX: f64 = 1_000.0;
/// Smallest publishable saturation drive.
pub const SATURATION_DRIVE_MIN: f64 = 0.0;
/// Largest publishable saturation drive.
pub const SATURATION_DRIVE_MAX: f64 = 2.0;
/// Smallest publishable saturation onset threshold (linear).
pub const SATURATION_THRESHOLD_MIN: f64 = 0.0;
/// Largest publishable saturation onset threshold (linear).
pub const SATURATION_THRESHOLD_MAX: f64 = 1.0;
/// Smallest publishable saturation dry/wet mix (linear).
pub const SATURATION_MIX_MIN: f64 = 0.0;
/// Largest publishable saturation dry/wet mix (linear).
pub const SATURATION_MIX_MAX: f64 = 1.0;
/// Smallest publishable saturation high-pass cutoff, in Hz.
pub const SATURATION_HIGHPASS_CUTOFF_HZ_MIN: f64 = 1_000.0;
/// Largest publishable saturation high-pass cutoff, in Hz.
pub const SATURATION_HIGHPASS_CUTOFF_HZ_MAX: f64 = 12_000.0;
/// Smallest publishable saturation input/output makeup gain, in dB.
pub const SATURATION_GAIN_DB_MIN: f64 = -24.0;
/// Largest publishable saturation input/output makeup gain, in dB.
pub const SATURATION_GAIN_DB_MAX: f64 = 24.0;
/// Smallest publishable crossfeed dry/wet mix (linear).
pub const CROSSFEED_MIX_MIN: f64 = 0.0;
/// Largest publishable crossfeed dry/wet mix (linear).
pub const CROSSFEED_MIX_MAX: f64 = 1.0;
/// Smallest publishable crossfeed low-pass cutoff, in Hz.
pub const CROSSFEED_CUTOFF_HZ_MIN: f64 = CROSSFEED_MIN_CUTOFF_HZ;
/// Largest publishable crossfeed low-pass cutoff, in Hz.
pub const CROSSFEED_CUTOFF_HZ_MAX: f64 = CROSSFEED_MAX_CUTOFF_HZ;
/// The crossfeed core's own starting mix, so a facade config that has not been
/// given an explicit mix cannot describe a different profile than the stage it
/// builds.
pub(crate) const CROSSFEED_MIX_DEFAULT: f64 = CROSSFEED_DEFAULT_MIX;
/// The crossfeed core's own starting cutoff, in Hz; see
/// [`CROSSFEED_MIX_DEFAULT`].
pub(crate) const CROSSFEED_CUTOFF_HZ_DEFAULT: f64 = CROSSFEED_DEFAULT_CUTOFF_HZ;
/// Smallest publishable dynamic-loudness compensation strength.
pub const DYNAMIC_LOUDNESS_STRENGTH_MIN: f64 = 0.0;
/// Largest publishable dynamic-loudness compensation strength.
pub const DYNAMIC_LOUDNESS_STRENGTH_MAX: f64 = 1.0;
/// Smallest publishable dynamic-loudness listening volume (linear).
pub const DYNAMIC_LOUDNESS_VOLUME_MIN: f64 = 0.0;
/// Largest publishable dynamic-loudness listening volume (linear).
pub const DYNAMIC_LOUDNESS_VOLUME_MAX: f64 = 1.0;
/// Deepest publishable dynamic-loudness pre-gain, in dB. The compensation
/// curve boosts low frequencies, so this headroom is reserved ahead of it.
pub const DYNAMIC_LOUDNESS_PRE_GAIN_DB_MIN: f64 = DYNAMIC_LOUDNESS_PRE_GAIN_DB_LIMIT_MIN;
/// Shallowest publishable dynamic-loudness pre-gain, in dB: no headroom.
pub const DYNAMIC_LOUDNESS_PRE_GAIN_DB_MAX: f64 = DYNAMIC_LOUDNESS_PRE_GAIN_DB_LIMIT_MAX;
/// Narrowest publishable span, in dB, over which compensation ramps from none
/// to full.
pub const DYNAMIC_LOUDNESS_TRANSITION_DB_MIN: f64 = DYNAMIC_LOUDNESS_TRANSITION_DB_LIMIT_MIN;
/// Widest such publishable span, in dB.
pub const DYNAMIC_LOUDNESS_TRANSITION_DB_MAX: f64 = DYNAMIC_LOUDNESS_TRANSITION_DB_LIMIT_MAX;
/// Quietest publishable compensation onset, in dB.
///
/// This is the listening level *below which* compensation starts, not the
/// current listening volume; see [`DynamicLoudnessTuningSnapshot`].
pub const DYNAMIC_LOUDNESS_COMPENSATION_REF_DB_MIN: f64 =
    DYNAMIC_LOUDNESS_COMPENSATION_REF_DB_LIMIT_MIN;
/// Loudest publishable compensation onset, in dB, at which no compensation is
/// applied.
pub const DYNAMIC_LOUDNESS_COMPENSATION_REF_DB_MAX: f64 =
    DYNAMIC_LOUDNESS_COMPENSATION_REF_DB_LIMIT_MAX;
/// Smallest publishable noise-shaper target bit depth.
pub const NOISE_SHAPER_BITS_MIN: u32 = 8;
/// Largest publishable noise-shaper target bit depth.
pub const NOISE_SHAPER_BITS_MAX: u32 = 32;

/// Clamp a control value into its published range, rejecting non-finite input.
///
/// `f64::clamp` returns `NaN` unchanged, so a `NaN` reaching a DSP stage
/// permanently poisons its filter state. Every control-thread setter therefore
/// routes through this helper and simply keeps the previously published value
/// when the caller supplies `NaN` or an infinity.
///
/// This is the single shared policy for both parameter layers: the atomic
/// publishers here, and the infallible setters on the standalone DSP cores.
/// Fallible entry points such as [`Equalizer::set_band_gain`] instead report
/// the rejection; see the crate's parameter-validation spec.
///
/// [`Equalizer::set_band_gain`]: super::eq::Equalizer::set_band_gain
#[inline]
pub(crate) fn sanitized(value: f64, min: f64, max: f64) -> Option<f64> {
    value.is_finite().then(|| value.clamp(min, max))
}

struct RealtimeSnapshotControl<T> {
    readers: Vec<Arc<AtomicPtr<T>>>,
    retired: Vec<Box<T>>,
}

struct RealtimeSnapshot<T> {
    current: AtomicPtr<T>,
    sequence: AtomicU64,
    control: Mutex<RealtimeSnapshotControl<T>>,
}

/// Pre-registered realtime reader for one immutable parameter snapshot type.
///
/// Obtain this only through the matching `Atomic*Params::subscribe_realtime`
/// method during setup, then retain it for allocation-free block-boundary
/// reads. The handle deliberately exposes no raw ownership operations.
pub struct RealtimeSnapshotReader<T> {
    hazard: Arc<AtomicPtr<T>>,
}

impl<T> Drop for RealtimeSnapshotReader<T> {
    fn drop(&mut self) {
        self.hazard.store(ptr::null_mut(), Ordering::SeqCst);
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl<T: Copy> RealtimeSnapshot<T> {
    fn new(snapshot: T) -> Self {
        Self {
            current: AtomicPtr::new(Box::into_raw(Box::new(snapshot))),
            sequence: AtomicU64::new(0),
            control: Mutex::new(RealtimeSnapshotControl {
                readers: Vec::new(),
                retired: Vec::new(),
            }),
        }
    }

    fn subscribe(&self) -> RealtimeSnapshotReader<T> {
        let hazard = Arc::new(AtomicPtr::new(ptr::null_mut()));
        lock_unpoisoned(&self.control)
            .readers
            .push(Arc::clone(&hazard));
        RealtimeSnapshotReader { hazard }
    }

    fn load_with_generation(&self, reader: &RealtimeSnapshotReader<T>) -> Option<(T, u64)> {
        let before = self.sequence.load(Ordering::SeqCst);
        if before & 1 != 0 {
            return None;
        }
        let pointer = self.current.load(Ordering::SeqCst);
        reader.hazard.store(pointer, Ordering::SeqCst);
        if self.current.load(Ordering::SeqCst) != pointer
            || self.sequence.load(Ordering::SeqCst) != before
        {
            reader.hazard.store(ptr::null_mut(), Ordering::SeqCst);
            return None;
        }

        // The writer retains every replaced Box while its pointer appears in
        // a reader hazard slot. The pointed-to snapshot is immutable and Copy.
        let snapshot = unsafe { *pointer };
        let after = self.sequence.load(Ordering::SeqCst);
        reader.hazard.store(ptr::null_mut(), Ordering::SeqCst);
        (before == after).then_some((snapshot, before / 2))
    }

    fn load_if_changed_since(
        &self,
        reader: &RealtimeSnapshotReader<T>,
        cached_generation: u64,
    ) -> Option<(T, u64)> {
        let sequence = self.sequence.load(Ordering::Acquire);
        if sequence & 1 != 0 || sequence / 2 == cached_generation {
            return None;
        }
        self.load_with_generation(reader)
            .filter(|(_, generation)| *generation != cached_generation)
    }

    fn publish(&self, snapshot: T) {
        let mut control = lock_unpoisoned(&self.control);
        let before = self.sequence.load(Ordering::SeqCst);
        debug_assert_eq!(before & 1, 0);
        let next = before.wrapping_add(2);
        self.sequence
            .store(before.wrapping_add(1), Ordering::SeqCst);
        let previous = self
            .current
            .swap(Box::into_raw(Box::new(snapshot)), Ordering::SeqCst);
        self.sequence.store(next, Ordering::SeqCst);

        // SAFETY: `previous` was created by Box::into_raw and atomically
        // removed from `current`; this control-side vector resumes ownership.
        control.retired.push(unsafe { Box::from_raw(previous) });
        let RealtimeSnapshotControl { readers, retired } = &mut *control;
        readers.retain(|reader| Arc::strong_count(reader) > 1);
        retired.retain(|retired| {
            let pointer = (&**retired) as *const T as *mut T;
            readers
                .iter()
                .any(|reader| reader.load(Ordering::SeqCst) == pointer)
        });
    }
}

impl<T> Drop for RealtimeSnapshot<T> {
    fn drop(&mut self) {
        let pointer = *self.current.get_mut();
        if !pointer.is_null() {
            // SAFETY: `self` has exclusive access and `pointer` is the one Box
            // still owned by the current slot.
            unsafe { drop(Box::from_raw(pointer)) };
        }
    }
}

struct SharedParams<T: Copy> {
    /// Control-side published snapshot.
    ///
    /// Every reader clones the *same* `Arc` rather than rebuilding one, which
    /// is what makes [`Self::load_if_changed`]'s pointer comparison meaningful:
    /// "unchanged" must mean "same allocation". The lock is only ever held for
    /// a clone or a pointer store, and never by the audio thread — realtime
    /// consumers go through `realtime` instead.
    current: Mutex<Arc<T>>,
    realtime: RealtimeSnapshot<T>,
    writer: Mutex<()>,
    generation: AtomicU64,
}

impl<T: Copy + Default> SharedParams<T> {
    fn new() -> Self {
        Self::from_snapshot(T::default())
    }
}

// Every published snapshot `T` in this module is a plain `Copy` value object
// (floats, bools, small enums) with no interior mutability of its own. The
// interior mutability that `Mutex` and `AtomicPtr` introduce here is confined
// to publishing whole snapshots and is safe to observe after a caught unwind:
// a panic mid-publish leaves either the old or the new complete snapshot, never
// a torn one, because the generation counter gates every reader.
//
// These impls are written out rather than inferred because `Mutex<Arc<T>>`
// forwards `T`'s unwind-safety while the previous `ArcSwap<T>` storage did not.
// Without them the public auto-trait surface of every parameter handle would
// silently lose `UnwindSafe` / `RefUnwindSafe`, which the committed public-API
// baseline treats as a breaking change.
impl<T: Copy> std::panic::RefUnwindSafe for SharedParams<T> {}
impl<T: Copy> std::panic::UnwindSafe for SharedParams<T> {}
impl<T: Copy> SharedParams<T> {
    fn from_snapshot(snapshot: T) -> Self {
        Self {
            current: Mutex::new(Arc::new(snapshot)),
            realtime: RealtimeSnapshot::new(snapshot),
            writer: Mutex::new(()),
            generation: AtomicU64::new(0),
        }
    }

    /// Clone the currently published snapshot handle.
    #[inline]
    fn current_snapshot(&self) -> Arc<T> {
        Arc::clone(&lock_unpoisoned(&self.current))
    }
    #[inline]
    fn load(&self) -> Arc<T> {
        self.current_snapshot()
    }

    /// Control-side coherent snapshot + generation read.
    ///
    /// This may briefly spin while a publisher is mid-publish (generation is
    /// odd), so it must only be called from control/UI threads. Realtime
    /// consumers must use `subscribe_realtime` +
    /// `load_realtime_if_changed_since`, whose failure mode is "keep the
    /// cached snapshot" instead of waiting.
    #[inline]
    fn load_with_generation(&self) -> (Arc<T>, u64) {
        loop {
            let before = self.generation.load(Ordering::Acquire);
            if before & 1 != 0 {
                std::hint::spin_loop();
                continue;
            }
            let current = self.current_snapshot();
            let after = self.generation.load(Ordering::Acquire);
            if before == after {
                return (current, after / 2);
            }
        }
    }

    #[inline]
    fn load_if_changed(&self, cached: &Arc<T>) -> Option<Arc<T>> {
        let current = self.current_snapshot();
        if Arc::ptr_eq(&current, cached) {
            None
        } else {
            Some(current)
        }
    }

    #[inline]
    fn load_if_changed_since(&self, cached_generation: u64) -> Option<(Arc<T>, u64)> {
        let generation = self.generation.load(Ordering::Acquire);
        if generation & 1 == 0 && generation / 2 == cached_generation {
            return None;
        }
        let (current, generation) = self.load_with_generation();
        (generation != cached_generation).then_some((current, generation))
    }

    #[inline]
    fn publish(&self, snapshot: T) {
        let _writer = lock_unpoisoned(&self.writer);
        self.publish_locked(snapshot);
    }

    fn publish_locked(&self, snapshot: T) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        *lock_unpoisoned(&self.current) = Arc::new(snapshot);
        self.realtime.publish(snapshot);
        self.generation.fetch_add(1, Ordering::Release);
    }

    fn subscribe_realtime(&self) -> (RealtimeSnapshotReader<T>, T, u64) {
        let reader = self.realtime.subscribe();
        loop {
            if let Some((snapshot, generation)) = self.realtime.load_with_generation(&reader) {
                return (reader, snapshot, generation);
            }
            std::thread::yield_now();
        }
    }

    #[inline]
    fn load_realtime_if_changed_since(
        &self,
        reader: &RealtimeSnapshotReader<T>,
        cached_generation: u64,
    ) -> Option<(T, u64)> {
        self.realtime
            .load_if_changed_since(reader, cached_generation)
    }
}

impl<T: Copy> SharedParams<T> {
    #[inline]
    fn read(&self) -> T {
        **lock_unpoisoned(&self.current)
    }

    #[inline]
    fn update(&self, mut f: impl FnMut(&mut T)) {
        let _writer = lock_unpoisoned(&self.writer);
        let mut snapshot = **lock_unpoisoned(&self.current);
        f(&mut snapshot);
        self.publish_locked(snapshot);
    }

    /// Guarded read-modify-publish that may decline to publish.
    ///
    /// Use this when the decision to publish depends on the current snapshot.
    /// Deciding outside the writer lock and then publishing a locally mutated
    /// copy would overwrite any concurrent update.
    fn update_if(&self, mut f: impl FnMut(&mut T) -> bool) {
        let _writer = lock_unpoisoned(&self.writer);
        let mut snapshot = **lock_unpoisoned(&self.current);
        if !f(&mut snapshot) {
            return;
        }
        self.publish_locked(snapshot);
    }
}

macro_rules! impl_default_via_new {
    ($type:ty) => {
        impl Default for $type {
            fn default() -> Self {
                Self::new()
            }
        }
    };
}

macro_rules! impl_snapshot_accessors {
    ($snapshot:ty) => {
        #[inline]
        /// Load the latest immutable parameter snapshot.
        pub fn load(&self) -> Arc<$snapshot> {
            self.shared.load()
        }

        /// Control-side coherent snapshot + generation read.
        ///
        /// May briefly spin while a publish is in flight; do not call from the
        /// audio callback. Realtime consumers use [`Self::subscribe_realtime`]
        /// and [`Self::load_realtime_if_changed_since`] instead, which never
        /// wait.
        #[inline]
        pub fn load_with_generation(&self) -> (Arc<$snapshot>, u64) {
            self.shared.load_with_generation()
        }

        #[inline]
        /// Return a new snapshot only when it differs from `cached`.
        pub fn load_if_changed(&self, cached: &Arc<$snapshot>) -> Option<Arc<$snapshot>> {
            self.shared.load_if_changed(cached)
        }

        #[inline]
        /// Return a new snapshot and generation after `cached_generation`.
        pub fn load_if_changed_since(
            &self,
            cached_generation: u64,
        ) -> Option<(Arc<$snapshot>, u64)> {
            self.shared.load_if_changed_since(cached_generation)
        }

        /// Register one realtime consumer and return its initial snapshot.
        ///
        /// Registration allocates and takes a control-side lock, so call this
        /// before entering an audio callback.
        pub fn subscribe_realtime(&self) -> (RealtimeSnapshotReader<$snapshot>, $snapshot, u64) {
            self.shared.subscribe_realtime()
        }

        /// Copy a newly published complete snapshot without allocation or
        /// ownership destruction on the calling thread.
        #[inline]
        pub fn load_realtime_if_changed_since(
            &self,
            reader: &RealtimeSnapshotReader<$snapshot>,
            cached_generation: u64,
        ) -> Option<($snapshot, u64)> {
            self.shared
                .load_realtime_if_changed_since(reader, cached_generation)
        }
    };
}

macro_rules! impl_set_enabled_accessor {
    () => {
        #[inline]
        /// Publish the enabled/bypassed state from the control thread.
        pub fn set_enabled(&self, enabled: bool) {
            self.shared.update(|snapshot| {
                snapshot.enabled = enabled;
            });
        }
    };
}

macro_rules! impl_enabled_reader {
    () => {
        #[inline]
        /// Read the current enabled/bypassed state.
        pub fn is_enabled(&self) -> bool {
            self.read().enabled
        }
    };
}

// ============================================================================
// EQ Parameters
// ============================================================================

/// EQ band count constant
pub const EQ_BANDS: usize = 10;

/// Reject an equalizer band index outside `0..EQ_BANDS`.
///
/// A band index is an address, not a value: unlike a gain it cannot be clamped
/// into range without silently editing a different band than the caller asked
/// for. Every public EQ entry point that returns a `Result` rejects it here, so
/// the playback facade and the raw [`Equalizer`](crate::processor::Equalizer)
/// report the same parameter identity for the same mistake.
pub(crate) fn validate_eq_band_index(
    processor: &'static str,
    band: usize,
) -> Result<(), ProcessError> {
    if band < EQ_BANDS {
        return Ok(());
    }
    Err(ProcessError::InvalidParameter {
        processor,
        parameter: "eq band index",
        message: "band index must be below EQ_BANDS",
    })
}

/// EQ parameter snapshot for audio thread
#[derive(Debug, Clone, Copy)]
pub struct EqParamsSnapshot {
    /// Gain for each band in dB
    pub gains: [f64; EQ_BANDS],
    /// Whether EQ is enabled
    pub enabled: bool,
}

impl Default for EqParamsSnapshot {
    fn default() -> Self {
        Self {
            gains: [0.0; EQ_BANDS],
            enabled: false,
        }
    }
}

/// EQ parameters published as complete immutable snapshots.
pub struct AtomicEqParams {
    shared: SharedParams<EqParamsSnapshot>,
}

impl AtomicEqParams {
    /// Create new EQ params with default values
    pub fn new() -> Self {
        Self {
            shared: SharedParams::new(),
        }
    }

    /// Publish all EQ parameters as a complete snapshot.
    ///
    /// Gains are clamped to the published band-gain range so a later read
    /// reports what the equalizer actually applies. A non-finite gain rejects
    /// the whole write and keeps the previous snapshot.
    pub fn write(&self, gains: &[f64; EQ_BANDS], enabled: bool) {
        let mut clamped = [0.0; EQ_BANDS];
        for (slot, gain) in clamped.iter_mut().zip(gains.iter()) {
            let Some(gain) = sanitized(*gain, EQ_BAND_GAIN_DB_MIN, EQ_BAND_GAIN_DB_MAX) else {
                return;
            };
            *slot = gain;
        }
        self.shared.publish(EqParamsSnapshot {
            gains: clamped,
            enabled,
        });
    }

    /// Read the current EQ parameter snapshot.
    pub fn read(&self) -> EqParamsSnapshot {
        self.shared.read()
    }

    impl_snapshot_accessors!(EqParamsSnapshot);

    /// Update a single band gain by patching and publishing a new snapshot.
    ///
    /// Like every setter on this type this is infallible. A band index at or
    /// above [`EQ_BANDS`], or a non-finite gain, publishes nothing and leaves
    /// the previously published snapshot in effect, so an advanced caller
    /// cannot poison callback-side filter state. Use
    /// [`PlaybackParameters::set_eq_band_gain_db`](crate::PlaybackParameters::set_eq_band_gain_db)
    /// when the rejection has to be reported back to a user or persisted.
    pub fn set_band_gain(&self, band: usize, gain_db: f64) {
        if band >= EQ_BANDS {
            return;
        }
        let Some(gain_db) = sanitized(gain_db, EQ_BAND_GAIN_DB_MIN, EQ_BAND_GAIN_DB_MAX) else {
            return;
        };
        self.shared.update(|snap| {
            snap.gains[band] = gain_db;
        });
    }

    /// Set enabled state (main thread)
    pub fn set_enabled(&self, enabled: bool) {
        self.shared.update(|snap| {
            snap.enabled = enabled;
        });
    }

    // Quick read of enabled state only.
    impl_enabled_reader!();
}

impl_default_via_new!(AtomicEqParams);

// ============================================================================
// Saturation Parameters (Simple Atomic)
// ============================================================================

/// Saturation type enumeration for lock-free parameter passing.
///
/// Provides bidirectional conversion with `SaturationType` from the saturation
/// module, eliminating unsafe string-based mapping. Both directions are
/// exhaustive `match`es, so adding a variant to either enum is a compile error
/// until the mapping is completed; `saturation_representations_round_trip`
/// pins the identity.
///
/// There is deliberately no `From<u8>`. A snapshot is published as a whole
/// `Copy` value rather than packed into an atomic word, so a byte decoding never
/// occurs; the previous one mapped every unknown byte to the default variant,
/// which would have turned a future encoding mistake into silent wrong audio
/// instead of a compile or runtime error. A wire format, if ever needed, belongs
/// in a `TryFrom` that rejects unknown bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum SaturationTypeValue {
    #[default]
    /// Tape-style hysteretic saturation.
    Tape = 0,
    /// Tube-style asymmetric saturation.
    Tube = 1,
    /// Transistor-style hard-knee saturation.
    Transistor = 2,
}

impl From<crate::processor::SaturationType> for SaturationTypeValue {
    fn from(st: crate::processor::SaturationType) -> Self {
        match st {
            crate::processor::SaturationType::Tape => Self::Tape,
            crate::processor::SaturationType::Tube => Self::Tube,
            crate::processor::SaturationType::Transistor => Self::Transistor,
        }
    }
}

impl From<SaturationTypeValue> for crate::processor::SaturationType {
    fn from(v: SaturationTypeValue) -> Self {
        match v {
            SaturationTypeValue::Tape => Self::Tape,
            SaturationTypeValue::Tube => Self::Tube,
            SaturationTypeValue::Transistor => Self::Transistor,
        }
    }
}

/// Saturation processing quality for lock-free parameter passing.
///
/// Like [`SaturationTypeValue`], this converts only to and from its saturation
/// module counterpart, never from a raw byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum SaturationQualityValue {
    #[default]
    /// Source-rate waveshaping without oversampling.
    Direct = 0,
    /// Two-times oversampled antialiased waveshaping.
    Oversampled2x = 1,
    /// Four-times oversampled antialiased waveshaping.
    Oversampled4x = 2,
}

impl From<crate::processor::SaturationQuality> for SaturationQualityValue {
    fn from(quality: crate::processor::SaturationQuality) -> Self {
        match quality {
            crate::processor::SaturationQuality::Direct => Self::Direct,
            crate::processor::SaturationQuality::Oversampled2x => Self::Oversampled2x,
            crate::processor::SaturationQuality::Oversampled4x => Self::Oversampled4x,
        }
    }
}

impl From<SaturationQualityValue> for crate::processor::SaturationQuality {
    fn from(v: SaturationQualityValue) -> Self {
        match v {
            SaturationQualityValue::Direct => Self::Direct,
            SaturationQualityValue::Oversampled2x => Self::Oversampled2x,
            SaturationQualityValue::Oversampled4x => Self::Oversampled4x,
        }
    }
}

/// Saturation parameter snapshot
#[derive(Debug, Clone, Copy)]
pub struct SaturationParamsSnapshot {
    /// Input drive amount.
    pub drive: f64,
    /// Soft-knee saturation threshold.
    pub threshold: f64,
    /// Wet/dry mix, where zero is transparent.
    pub mix: f64,
    /// Waveshaper family.
    pub sat_type: SaturationTypeValue,
    /// Antialiasing quality mode.
    pub quality: SaturationQualityValue,
    /// Input gain in decibels.
    pub input_gain_db: f64,
    /// Output gain in decibels.
    pub output_gain_db: f64,
    /// Whether the optional high-pass stage is active.
    pub highpass_mode: bool,
    /// High-pass cutoff in hertz.
    pub highpass_cutoff: f64,
    /// Runtime effect enable state.
    pub enabled: bool,
    /// Setup/reset-time activation of the fixed-latency stage.
    pub armed: bool,
}

impl Default for SaturationParamsSnapshot {
    fn default() -> Self {
        Self {
            drive: 0.25,
            threshold: 0.88,
            mix: 0.2,
            sat_type: SaturationTypeValue::Tube,
            quality: SaturationQualityValue::Direct,
            input_gain_db: 0.0,
            output_gain_db: 0.0,
            highpass_mode: false,
            highpass_cutoff: 4000.0,
            enabled: true,
            armed: true,
        }
    }
}

/// Saturation parameters published as complete immutable snapshots.
pub struct AtomicSaturationParams {
    shared: SharedParams<SaturationParamsSnapshot>,
}

impl AtomicSaturationParams {
    /// Create a parameter publisher initialized with safe saturation defaults.
    pub fn new() -> Self {
        Self {
            shared: SharedParams::new(),
        }
    }

    /// Publish all saturation settings as one coherent snapshot.
    ///
    /// A non-finite field rejects the whole write so the previous snapshot
    /// survives.
    #[inline]
    pub fn write(&self, snapshot: SaturationParamsSnapshot) {
        let mut snapshot = snapshot;
        let (
            Some(drive),
            Some(threshold),
            Some(mix),
            Some(highpass_cutoff),
            Some(input_gain_db),
            Some(output_gain_db),
        ) = (
            sanitized(snapshot.drive, SATURATION_DRIVE_MIN, SATURATION_DRIVE_MAX),
            sanitized(
                snapshot.threshold,
                SATURATION_THRESHOLD_MIN,
                SATURATION_THRESHOLD_MAX,
            ),
            sanitized(snapshot.mix, SATURATION_MIX_MIN, SATURATION_MIX_MAX),
            sanitized(
                snapshot.highpass_cutoff,
                SATURATION_HIGHPASS_CUTOFF_HZ_MIN,
                SATURATION_HIGHPASS_CUTOFF_HZ_MAX,
            ),
            sanitized(
                snapshot.input_gain_db,
                SATURATION_GAIN_DB_MIN,
                SATURATION_GAIN_DB_MAX,
            ),
            sanitized(
                snapshot.output_gain_db,
                SATURATION_GAIN_DB_MIN,
                SATURATION_GAIN_DB_MAX,
            ),
        )
        else {
            return;
        };
        snapshot.drive = drive;
        snapshot.threshold = threshold;
        snapshot.mix = mix;
        snapshot.highpass_cutoff = highpass_cutoff;
        snapshot.input_gain_db = input_gain_db;
        snapshot.output_gain_db = output_gain_db;
        self.shared.publish(snapshot);
    }

    /// Set drive amount (0.0 - 2.0)
    #[inline]
    pub fn set_drive(&self, drive: f64) {
        let Some(drive) = sanitized(drive, SATURATION_DRIVE_MIN, SATURATION_DRIVE_MAX) else {
            return;
        };
        self.shared.update(|snapshot| {
            snapshot.drive = drive;
        });
    }

    /// Set threshold (0.0 - 1.0)
    #[inline]
    pub fn set_threshold(&self, threshold: f64) {
        let Some(threshold) = sanitized(
            threshold,
            SATURATION_THRESHOLD_MIN,
            SATURATION_THRESHOLD_MAX,
        ) else {
            return;
        };
        self.shared.update(|snapshot| {
            snapshot.threshold = threshold;
        });
    }

    /// Set mix amount (0.0 - 1.0)
    #[inline]
    pub fn set_mix(&self, mix: f64) {
        let Some(mix) = sanitized(mix, SATURATION_MIX_MIN, SATURATION_MIX_MAX) else {
            return;
        };
        self.shared.update(|snapshot| {
            snapshot.mix = mix;
        });
    }

    /// Set saturation type
    #[inline]
    pub fn set_sat_type(&self, sat_type: SaturationTypeValue) {
        self.shared.update(|snapshot| {
            snapshot.sat_type = sat_type;
        });
    }

    /// Set processing quality / antialiasing mode.
    #[inline]
    pub fn set_quality(&self, quality: SaturationQualityValue) {
        self.shared.update(|snapshot| {
            snapshot.quality = quality;
        });
    }

    /// Set input gain (dB)
    ///
    /// Changing both makeup gains as one control operation must use
    /// [`Self::set_gains_db`]: two separate setter calls are two separately
    /// observable snapshots, and the callback can adopt the intermediate one.
    #[inline]
    pub fn set_input_gain(&self, gain_db: f64) {
        let Some(gain_db) = sanitized(gain_db, SATURATION_GAIN_DB_MIN, SATURATION_GAIN_DB_MAX)
        else {
            return;
        };
        self.shared.update(|snapshot| {
            snapshot.input_gain_db = gain_db;
        });
    }

    /// Set output gain (dB)
    ///
    /// See [`Self::set_input_gain`] for the paired-update rule.
    #[inline]
    pub fn set_output_gain(&self, gain_db: f64) {
        let Some(gain_db) = sanitized(gain_db, SATURATION_GAIN_DB_MIN, SATURATION_GAIN_DB_MAX)
        else {
            return;
        };
        self.shared.update(|snapshot| {
            snapshot.output_gain_db = gain_db;
        });
    }

    /// Publish both makeup gains (dB) as one coherent snapshot.
    ///
    /// Input and output makeup gain are one semantic control operation: the
    /// pair is normally moved in opposite directions to keep the stage's
    /// output level while changing how hard the nonlinearity is driven. Patching
    /// both fields inside a single guarded publication stops the callback from
    /// running a block with the new input gain against the old output gain.
    ///
    /// A non-finite gain in either position rejects the whole write and leaves
    /// the previous snapshot in effect, matching every other setter here.
    #[inline]
    pub fn set_gains_db(&self, input_gain_db: f64, output_gain_db: f64) {
        let (Some(input_gain_db), Some(output_gain_db)) = (
            sanitized(
                input_gain_db,
                SATURATION_GAIN_DB_MIN,
                SATURATION_GAIN_DB_MAX,
            ),
            sanitized(
                output_gain_db,
                SATURATION_GAIN_DB_MIN,
                SATURATION_GAIN_DB_MAX,
            ),
        ) else {
            return;
        };
        self.shared.update(|snapshot| {
            snapshot.input_gain_db = input_gain_db;
            snapshot.output_gain_db = output_gain_db;
        });
    }

    /// Set highpass mode
    #[inline]
    pub fn set_highpass_mode(&self, enabled: bool) {
        self.shared.update(|snapshot| {
            snapshot.highpass_mode = enabled;
        });
    }

    /// Set highpass cutoff frequency
    #[inline]
    pub fn set_highpass_cutoff(&self, hz: f64) {
        let Some(hz) = sanitized(
            hz,
            SATURATION_HIGHPASS_CUTOFF_HZ_MIN,
            SATURATION_HIGHPASS_CUTOFF_HZ_MAX,
        ) else {
            return;
        };
        self.shared.update(|snapshot| {
            snapshot.highpass_cutoff = hz;
        });
    }

    impl_set_enabled_accessor!();

    /// Arm or hard-bypass the stage for the next reset/setup boundary.
    #[inline]
    pub fn set_armed(&self, armed: bool) {
        self.shared.update(|snapshot| {
            snapshot.armed = armed;
        });
    }

    /// Read all parameters into a snapshot
    #[inline]
    pub fn read(&self) -> SaturationParamsSnapshot {
        self.shared.read()
    }

    impl_snapshot_accessors!(SaturationParamsSnapshot);

    // Quick check if enabled.
    impl_enabled_reader!();
}

impl_default_via_new!(AtomicSaturationParams);

// ============================================================================
// Crossfeed Parameters
// ============================================================================

/// Crossfeed parameter snapshot
#[derive(Debug, Clone, Copy)]
pub struct CrossfeedParamsSnapshot {
    /// Crossfeed wet mix.
    pub mix: f64,
    /// Low-pass cutoff applied to the crossfed signal, in hertz.
    pub cutoff_hz: f64,
    /// Whether crossfeed is enabled.
    pub enabled: bool,
}

impl Default for CrossfeedParamsSnapshot {
    fn default() -> Self {
        Self {
            mix: CROSSFEED_DEFAULT_MIX,
            cutoff_hz: CROSSFEED_DEFAULT_CUTOFF_HZ,
            enabled: true,
        }
    }
}

/// Atomic crossfeed parameters
pub struct AtomicCrossfeedParams {
    shared: SharedParams<CrossfeedParamsSnapshot>,
}

impl AtomicCrossfeedParams {
    /// Create a parameter publisher initialized with crossfeed defaults.
    pub fn new() -> Self {
        Self {
            shared: SharedParams::new(),
        }
    }

    /// Publish crossfeed settings as one coherent snapshot.
    ///
    /// A non-finite mix or cutoff rejects the whole write.
    #[inline]
    pub fn write(&self, enabled: bool, mix: f64, cutoff_hz: f64) {
        let (Some(mix), Some(cutoff_hz)) = (
            sanitized(mix, CROSSFEED_MIX_MIN, CROSSFEED_MIX_MAX),
            sanitized(cutoff_hz, CROSSFEED_CUTOFF_HZ_MIN, CROSSFEED_CUTOFF_HZ_MAX),
        ) else {
            return;
        };
        self.shared.publish(CrossfeedParamsSnapshot {
            enabled,
            mix,
            cutoff_hz,
        });
    }

    #[inline]
    /// Set the crossfeed wet mix; non-finite input is ignored.
    pub fn set_mix(&self, mix: f64) {
        let Some(mix) = sanitized(mix, CROSSFEED_MIX_MIN, CROSSFEED_MIX_MAX) else {
            return;
        };
        self.shared.update(|snapshot| {
            snapshot.mix = mix;
        });
    }

    #[inline]
    /// Set the crossfeed cutoff in hertz; non-finite input is ignored.
    pub fn set_cutoff(&self, hz: f64) {
        let Some(hz) = sanitized(hz, CROSSFEED_CUTOFF_HZ_MIN, CROSSFEED_CUTOFF_HZ_MAX) else {
            return;
        };
        self.shared.update(|snapshot| {
            snapshot.cutoff_hz = hz;
        });
    }

    impl_set_enabled_accessor!();

    #[inline]
    /// Read the current crossfeed snapshot coherently.
    pub fn read(&self) -> CrossfeedParamsSnapshot {
        self.shared.read()
    }

    impl_snapshot_accessors!(CrossfeedParamsSnapshot);

    impl_enabled_reader!();
}

impl_default_via_new!(AtomicCrossfeedParams);

// ============================================================================
// Peak Limiter Parameters
// ============================================================================

/// Peak limiter parameter snapshot
#[derive(Debug, Clone, Copy)]
pub struct PeakLimiterParamsSnapshot {
    /// Limiter ceiling in decibels.
    pub threshold_db: f64,
    /// Release time in milliseconds.
    pub release_ms: f64,
    /// Whether limiting is enabled.
    pub enabled: bool,
    /// Peak-detection mode.
    pub mode: LimiterMode,
}

impl Default for PeakLimiterParamsSnapshot {
    fn default() -> Self {
        Self {
            threshold_db: -1.0,
            release_ms: 150.0,
            enabled: true,
            mode: LimiterMode::TruePeak,
        }
    }
}

/// Atomic peak limiter parameters
pub struct AtomicPeakLimiterParams {
    shared: SharedParams<PeakLimiterParamsSnapshot>,
}

impl AtomicPeakLimiterParams {
    /// Create a parameter publisher initialized with true-peak limiter defaults.
    pub fn new() -> Self {
        Self {
            shared: SharedParams::new(),
        }
    }

    #[inline]
    /// Set the limiter ceiling in decibels; out-of-range input is clamped.
    pub fn set_threshold(&self, db: f64) {
        let Some(db) = sanitized(db, LIMITER_THRESHOLD_DB_MIN, LIMITER_THRESHOLD_DB_MAX) else {
            return;
        };
        self.shared.update(|snapshot| {
            snapshot.threshold_db = db;
        });
    }

    #[inline]
    /// Set the limiter release time in milliseconds; out-of-range input is clamped.
    pub fn set_release(&self, ms: f64) {
        let Some(ms) = sanitized(ms, LIMITER_RELEASE_MS_MIN, LIMITER_RELEASE_MS_MAX) else {
            return;
        };
        self.shared.update(|snapshot| {
            snapshot.release_ms = ms;
        });
    }

    /// Select the detection [`LimiterMode`].
    ///
    /// The adapter applies mode changes in place with pre-sized limiter
    /// buffers, resetting limiter state when the active delay window changes.
    /// Set this from the control thread, not inside the audio callback.
    #[inline]
    pub fn set_mode(&self, mode: LimiterMode) {
        self.shared.update(|snapshot| {
            snapshot.mode = mode;
        });
    }

    impl_set_enabled_accessor!();

    #[inline]
    /// Read the current limiter snapshot coherently.
    pub fn read(&self) -> PeakLimiterParamsSnapshot {
        self.shared.read()
    }

    impl_snapshot_accessors!(PeakLimiterParamsSnapshot);

    impl_enabled_reader!();
}

impl_default_via_new!(AtomicPeakLimiterParams);

// ============================================================================
// Volume Parameters
// ============================================================================

/// Volume parameter snapshot
#[derive(Debug, Clone, Copy)]
pub struct VolumeParamsSnapshot {
    /// Linear gain in the inclusive range 0.0..=1.0.
    pub volume: f64, // 0.0 - 1.0
    /// Whether the effective gain is forced to zero.
    pub muted: bool,
}

impl Default for VolumeParamsSnapshot {
    fn default() -> Self {
        Self {
            volume: 1.0,
            muted: false,
        }
    }
}

/// Atomic volume parameters
pub struct AtomicVolumeParams {
    shared: SharedParams<VolumeParamsSnapshot>,
}

impl AtomicVolumeParams {
    /// Create a volume publisher initialized at unity gain and unmuted.
    pub fn new() -> Self {
        Self {
            shared: SharedParams::new(),
        }
    }

    /// Set volume (0.0 = silence, 1.0 = full)
    ///
    /// A non-finite value keeps the previous volume.
    #[inline]
    pub fn set_volume(&self, vol: f64) {
        let Some(vol) = sanitized(vol, VOLUME_MIN, VOLUME_MAX) else {
            return;
        };
        self.shared.update(|snapshot| {
            snapshot.volume = vol;
        });
    }

    /// Set mute state
    #[inline]
    pub fn set_muted(&self, muted: bool) {
        self.shared.update(|snapshot| {
            snapshot.muted = muted;
        });
    }

    /// Read current state
    #[inline]
    pub fn read(&self) -> VolumeParamsSnapshot {
        self.shared.read()
    }

    impl_snapshot_accessors!(VolumeParamsSnapshot);

    /// Get effective volume (0.0 if muted)
    #[inline]
    pub fn effective_volume(&self) -> f64 {
        let snapshot = self.read();
        if snapshot.muted {
            0.0
        } else {
            snapshot.volume
        }
    }
}

impl_default_via_new!(AtomicVolumeParams);

// ============================================================================
// Noise Shaper Parameters
// ============================================================================

/// Noise shaper parameter snapshot
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoiseShaperParamsSnapshot {
    /// Whether quantization-error feedback is enabled.
    pub enabled: bool,
    /// Target integer bit depth.
    pub bits: u32,
    /// Noise-shaping coefficient curve.
    pub curve: super::dsp::NoiseShaperCurve,
}

impl Default for NoiseShaperParamsSnapshot {
    fn default() -> Self {
        Self {
            enabled: true,
            bits: 24,
            curve: super::dsp::NoiseShaperCurve::Lipshitz5,
        }
    }
}

/// Atomic noise shaper parameters
pub struct AtomicNoiseShaperParams {
    shared: SharedParams<NoiseShaperParamsSnapshot>,
}

impl AtomicNoiseShaperParams {
    /// Create a publisher initialized with the default 24-bit curve.
    pub fn new() -> Self {
        Self {
            shared: SharedParams::new(),
        }
    }

    /// Publish noise-shaping settings as one coherent snapshot.
    #[inline]
    pub fn write(&self, enabled: bool, bits: u32, curve: super::dsp::NoiseShaperCurve) {
        self.shared.publish(NoiseShaperParamsSnapshot {
            enabled,
            bits: bits.clamp(NOISE_SHAPER_BITS_MIN, NOISE_SHAPER_BITS_MAX),
            curve,
        });
    }

    impl_set_enabled_accessor!();

    #[inline]
    /// Set the target bit depth, clamped to the supported range.
    pub fn set_bits(&self, bits: u32) {
        self.shared.update(|snapshot| {
            snapshot.bits = bits.clamp(NOISE_SHAPER_BITS_MIN, NOISE_SHAPER_BITS_MAX);
        });
    }

    #[inline]
    /// Select the noise-shaping coefficient curve.
    pub fn set_curve(&self, curve: super::dsp::NoiseShaperCurve) {
        self.shared.update(|snapshot| {
            snapshot.curve = curve;
        });
    }

    #[inline]
    /// Read the current noise-shaper snapshot coherently.
    pub fn read(&self) -> NoiseShaperParamsSnapshot {
        self.shared.read()
    }

    impl_snapshot_accessors!(NoiseShaperParamsSnapshot);

    impl_enabled_reader!();

    #[inline]
    /// Return the current target bit depth.
    pub fn bits(&self) -> u32 {
        self.read().bits
    }

    #[inline]
    /// Return the current noise-shaping curve.
    pub fn curve(&self) -> super::dsp::NoiseShaperCurve {
        self.read().curve
    }
}

impl_default_via_new!(AtomicNoiseShaperParams);

// ============================================================================
// Dynamic Loudness Parameters
// ============================================================================

/// Dynamic loudness parameter snapshot
#[derive(Debug, Clone, Copy)]
pub struct DynamicLoudnessParamsSnapshot {
    /// Whether loudness compensation is enabled.
    pub enabled: bool,
    /// Current listening volume as a linear gain.
    pub volume: f64,
    /// Compensation strength in the inclusive range 0.0..=1.0.
    pub strength: f64,
    /// Optional dB reference from which `volume` was derived.
    pub ref_volume_db: Option<f64>,
}

impl Default for DynamicLoudnessParamsSnapshot {
    fn default() -> Self {
        Self {
            enabled: true,
            volume: 1.0,
            strength: 1.0,
            ref_volume_db: None,
        }
    }
}

/// Curve-shaping settings for the dynamic-loudness stage.
///
/// These describe *how* the compensation curve is drawn, and change far less
/// often than the listening volume in [`DynamicLoudnessParamsSnapshot`]. They
/// are published on a separate generation counter so a tuning edit never forces
/// the callback to re-read the hot volume/strength snapshot, and vice versa.
///
/// # Note on `compensation_ref_db`
///
/// This is **not** the same quantity as
/// [`DynamicLoudnessParamsSnapshot::ref_volume_db`]. That field is the current
/// listening volume expressed in dB, from which the linear `volume` is derived.
/// `compensation_ref_db` is the listening level *below which* compensation
/// begins: at or above it the stage adds no gain, and the curve reaches full
/// strength `transition_db` further down.
///
/// `#[non_exhaustive]`: construct via [`Default`] and the setters on
/// [`AtomicDynamicLoudnessParams`], so later tuning values stay additive.
#[derive(Debug, Clone, Copy, PartialEq)]
#[non_exhaustive]
pub struct DynamicLoudnessTuningSnapshot {
    /// Headroom reserved ahead of the low-band boost, in dB.
    pub pre_gain_db: f64,
    /// Span, in dB, from compensation onset to full compensation.
    pub transition_db: f64,
    /// Listening level, in dB, below which compensation begins.
    pub compensation_ref_db: f64,
}

impl Default for DynamicLoudnessTuningSnapshot {
    /// The dynamic-loudness core's own starting curve, so a snapshot that has
    /// never been written describes exactly the stage it configures.
    fn default() -> Self {
        Self {
            pre_gain_db: DYNAMIC_LOUDNESS_PRE_GAIN_DB_DEFAULT,
            transition_db: DYNAMIC_LOUDNESS_TRANSITION_DB_DEFAULT,
            compensation_ref_db: DYNAMIC_LOUDNESS_COMPENSATION_REF_DB_DEFAULT,
        }
    }
}

/// Atomic dynamic loudness parameters
pub struct AtomicDynamicLoudnessParams {
    shared: SharedParams<DynamicLoudnessParamsSnapshot>,
    tuning: SharedParams<DynamicLoudnessTuningSnapshot>,
}

impl AtomicDynamicLoudnessParams {
    /// Create a publisher initialized with neutral dynamic-loudness settings.
    pub fn new() -> Self {
        Self {
            shared: SharedParams::new(),
            tuning: SharedParams::new(),
        }
    }

    /// Publish current listening volume and compensation strength as one
    /// coherent snapshot. `volume` is linear, where 1.0 is 0 dBFS.
    ///
    /// A non-finite volume or strength rejects the whole write.
    #[inline]
    pub fn write(&self, enabled: bool, volume: f64, strength: f64) {
        let (Some(volume), Some(strength)) = (
            sanitized(
                volume,
                DYNAMIC_LOUDNESS_VOLUME_MIN,
                DYNAMIC_LOUDNESS_VOLUME_MAX,
            ),
            sanitized(
                strength,
                DYNAMIC_LOUDNESS_STRENGTH_MIN,
                DYNAMIC_LOUDNESS_STRENGTH_MAX,
            ),
        ) else {
            return;
        };
        self.shared.publish(DynamicLoudnessParamsSnapshot {
            enabled,
            volume,
            strength,
            ref_volume_db: None,
        });
    }

    impl_set_enabled_accessor!();

    #[inline]
    /// Set listening volume as a linear gain and clear any dB reference.
    pub fn set_volume(&self, vol: f64) {
        let Some(vol) = sanitized(
            vol,
            DYNAMIC_LOUDNESS_VOLUME_MIN,
            DYNAMIC_LOUDNESS_VOLUME_MAX,
        ) else {
            return;
        };
        self.shared.update(|snapshot| {
            snapshot.volume = vol;
            snapshot.ref_volume_db = None;
        });
    }

    /// Set the reference volume in dB and publish the derived linear volume.
    ///
    /// The read, the conversion, and the publication all happen inside the
    /// writer lock, so a concurrent `set_strength`/`set_enabled`/`set_volume`
    /// cannot be overwritten by a stale snapshot copy.
    #[inline]
    pub fn set_ref_volume_db(&self, db: f64) {
        if !db.is_finite() {
            return;
        }
        // Converted here so the guarded closure stays allocation- and math-free
        // beyond the field assignment.
        let volume =
            (10f64.powf(db / 20.0)).clamp(DYNAMIC_LOUDNESS_VOLUME_MIN, DYNAMIC_LOUDNESS_VOLUME_MAX);
        self.shared.update_if(|snapshot| {
            if snapshot.ref_volume_db == Some(db) {
                return false;
            }
            snapshot.ref_volume_db = Some(db);
            snapshot.volume = volume;
            true
        });
    }

    /// Set strength (0.0 - 1.0)
    #[inline]
    pub fn set_strength(&self, strength: f64) {
        let Some(strength) = sanitized(
            strength,
            DYNAMIC_LOUDNESS_STRENGTH_MIN,
            DYNAMIC_LOUDNESS_STRENGTH_MAX,
        ) else {
            return;
        };
        self.shared.update(|snapshot| {
            snapshot.strength = strength;
        });
    }

    #[inline]
    /// Read the current dynamic-loudness snapshot coherently.
    pub fn read(&self) -> DynamicLoudnessParamsSnapshot {
        self.shared.read()
    }

    // --- curve tuning ------------------------------------------------------
    //
    // Published on their own generation counter. A tuning edit therefore never
    // invalidates the volume/strength snapshot the callback reads every block,
    // and a volume automation ramp never re-delivers unchanged tuning values.

    /// Publish all three curve-shaping values as one coherent snapshot.
    ///
    /// Each value is clamped to its published range; a non-finite value rejects
    /// the whole write, so the stage never sees a partially applied curve.
    #[inline]
    pub fn write_tuning(&self, pre_gain_db: f64, transition_db: f64, compensation_ref_db: f64) {
        let (Some(pre_gain_db), Some(transition_db), Some(compensation_ref_db)) = (
            sanitized(
                pre_gain_db,
                DYNAMIC_LOUDNESS_PRE_GAIN_DB_MIN,
                DYNAMIC_LOUDNESS_PRE_GAIN_DB_MAX,
            ),
            sanitized(
                transition_db,
                DYNAMIC_LOUDNESS_TRANSITION_DB_MIN,
                DYNAMIC_LOUDNESS_TRANSITION_DB_MAX,
            ),
            sanitized(
                compensation_ref_db,
                DYNAMIC_LOUDNESS_COMPENSATION_REF_DB_MIN,
                DYNAMIC_LOUDNESS_COMPENSATION_REF_DB_MAX,
            ),
        ) else {
            return;
        };
        self.tuning.publish(DynamicLoudnessTuningSnapshot {
            pre_gain_db,
            transition_db,
            compensation_ref_db,
        });
    }

    /// Set the headroom reserved ahead of the low-band boost, in dB, clamped to
    /// [`DYNAMIC_LOUDNESS_PRE_GAIN_DB_MIN`]..=[`DYNAMIC_LOUDNESS_PRE_GAIN_DB_MAX`].
    #[inline]
    pub fn set_pre_gain_db(&self, db: f64) {
        let Some(db) = sanitized(
            db,
            DYNAMIC_LOUDNESS_PRE_GAIN_DB_MIN,
            DYNAMIC_LOUDNESS_PRE_GAIN_DB_MAX,
        ) else {
            return;
        };
        self.tuning.update(|snapshot| {
            snapshot.pre_gain_db = db;
        });
    }

    /// Set the span from compensation onset to full compensation, in dB,
    /// clamped to
    /// [`DYNAMIC_LOUDNESS_TRANSITION_DB_MIN`]..=[`DYNAMIC_LOUDNESS_TRANSITION_DB_MAX`].
    #[inline]
    pub fn set_transition_db(&self, db: f64) {
        let Some(db) = sanitized(
            db,
            DYNAMIC_LOUDNESS_TRANSITION_DB_MIN,
            DYNAMIC_LOUDNESS_TRANSITION_DB_MAX,
        ) else {
            return;
        };
        self.tuning.update(|snapshot| {
            snapshot.transition_db = db;
        });
    }

    /// Set the listening level below which compensation begins, in dB, clamped
    /// to
    /// [`DYNAMIC_LOUDNESS_COMPENSATION_REF_DB_MIN`]..=[`DYNAMIC_LOUDNESS_COMPENSATION_REF_DB_MAX`].
    ///
    /// This is the curve's onset threshold, not the current listening volume;
    /// for the latter use [`Self::set_volume`] or [`Self::set_ref_volume_db`].
    #[inline]
    pub fn set_compensation_ref_db(&self, db: f64) {
        let Some(db) = sanitized(
            db,
            DYNAMIC_LOUDNESS_COMPENSATION_REF_DB_MIN,
            DYNAMIC_LOUDNESS_COMPENSATION_REF_DB_MAX,
        ) else {
            return;
        };
        self.tuning.update(|snapshot| {
            snapshot.compensation_ref_db = db;
        });
    }

    #[inline]
    /// Read the current curve-tuning snapshot coherently.
    pub fn read_tuning(&self) -> DynamicLoudnessTuningSnapshot {
        self.tuning.read()
    }

    /// Register one realtime consumer of the curve-tuning snapshot.
    ///
    /// Registration allocates and takes a control-side lock, so call this
    /// before entering an audio callback. This is a second, independent
    /// subscription from [`Self::subscribe_realtime`]; a processor that applies
    /// tuning needs both.
    pub fn subscribe_realtime_tuning(
        &self,
    ) -> (
        RealtimeSnapshotReader<DynamicLoudnessTuningSnapshot>,
        DynamicLoudnessTuningSnapshot,
        u64,
    ) {
        self.tuning.subscribe_realtime()
    }

    /// Copy a newly published tuning snapshot without allocation or ownership
    /// destruction on the calling thread.
    #[inline]
    pub fn load_realtime_tuning_if_changed_since(
        &self,
        reader: &RealtimeSnapshotReader<DynamicLoudnessTuningSnapshot>,
        cached_generation: u64,
    ) -> Option<(DynamicLoudnessTuningSnapshot, u64)> {
        self.tuning
            .load_realtime_if_changed_since(reader, cached_generation)
    }

    /// Control-side coherent tuning snapshot + generation read.
    ///
    /// May briefly spin while a publish is in flight; do not call from the
    /// audio callback.
    #[inline]
    pub fn load_tuning_with_generation(&self) -> (Arc<DynamicLoudnessTuningSnapshot>, u64) {
        self.tuning.load_with_generation()
    }

    impl_snapshot_accessors!(DynamicLoudnessParamsSnapshot);

    impl_enabled_reader!();

    /// Get strength (0.0 - 1.0)
    #[inline]
    pub fn strength(&self) -> f64 {
        self.read().strength
    }
}

impl_default_via_new!(AtomicDynamicLoudnessParams);

/// Real-time dynamic loudness telemetry published by audio thread.
///
/// Exposes the current loudness compensation factor and 7-band gains
/// for UI/state query without touching real-time processor internals.
pub struct AtomicDynamicLoudnessTelemetry {
    factor: AtomicF64,
    band_gains: [AtomicF64; LOUDNESS_BANDS_N],
}

impl AtomicDynamicLoudnessTelemetry {
    /// Create a zeroed telemetry publisher for the audio thread.
    pub fn new() -> Self {
        Self {
            factor: AtomicF64::new(0.0),
            band_gains: std::array::from_fn(|_| AtomicF64::new(0.0)),
        }
    }

    #[inline]
    /// Publish the current compensation factor and seven band gains.
    pub fn update(&self, factor: f64, band_gains: [f64; LOUDNESS_BANDS_N]) {
        self.factor.store(factor, Ordering::Release);
        for (dst, gain) in self.band_gains.iter().zip(band_gains.iter().copied()) {
            dst.store(gain, Ordering::Release);
        }
    }

    #[inline]
    /// Read the most recently published compensation factor.
    pub fn factor(&self) -> f64 {
        self.factor.load(Ordering::Acquire)
    }

    #[inline]
    /// Read the most recently published seven-band gain array.
    pub fn band_gains(&self) -> [f64; LOUDNESS_BANDS_N] {
        let _ = self.factor.load(Ordering::Acquire);
        std::array::from_fn(|i| self.band_gains[i].load(Ordering::Relaxed))
    }
}

impl_default_via_new!(AtomicDynamicLoudnessTelemetry);

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    /// The snapshot enums and their saturation-module counterparts are two
    /// hand-written tables. Both directions are exhaustive matches, so a new
    /// variant fails to compile; this pins that the mapping is also an identity
    /// rather than merely total.
    #[test]
    fn saturation_representations_round_trip() {
        use crate::processor::{SaturationQuality, SaturationType};

        for domain in [
            SaturationType::Tape,
            SaturationType::Tube,
            SaturationType::Transistor,
        ] {
            let value = SaturationTypeValue::from(domain);
            assert_eq!(SaturationType::from(value), domain);
        }

        for value in [
            SaturationTypeValue::Tape,
            SaturationTypeValue::Tube,
            SaturationTypeValue::Transistor,
        ] {
            let domain = SaturationType::from(value);
            assert_eq!(SaturationTypeValue::from(domain), value);
        }

        for domain in [
            SaturationQuality::Direct,
            SaturationQuality::Oversampled2x,
            SaturationQuality::Oversampled4x,
        ] {
            let value = SaturationQualityValue::from(domain);
            assert_eq!(SaturationQuality::from(value), domain);
        }

        for value in [
            SaturationQualityValue::Direct,
            SaturationQualityValue::Oversampled2x,
            SaturationQualityValue::Oversampled4x,
        ] {
            let domain = SaturationQuality::from(value);
            assert_eq!(SaturationQualityValue::from(domain), value);
        }
    }

    /// The telemetry array must stay sized by the model, not by a repeated
    /// literal, so adding a band cannot silently drop its gain from the readout.
    #[test]
    fn dynamic_loudness_telemetry_is_sized_by_the_band_model() {
        assert_eq!(
            LOUDNESS_BANDS_N,
            super::super::dynamic_loudness::LOUDNESS_BANDS.len()
        );

        let telemetry = AtomicDynamicLoudnessTelemetry::new();
        let gains = std::array::from_fn::<f64, LOUDNESS_BANDS_N, _>(|i| i as f64 + 1.0);
        telemetry.update(0.5, gains);

        assert_eq!(telemetry.factor(), 0.5);
        assert_eq!(telemetry.band_gains(), gains);
    }

    #[test]
    fn test_eq_params_write_read() {
        let params = AtomicEqParams::new();
        let gains = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];

        params.write(&gains, true);

        let snapshot = params.read();
        for (i, &g) in gains.iter().enumerate() {
            assert!((snapshot.gains[i] - g).abs() < 1e-10);
        }
        assert!(snapshot.enabled);
    }

    #[test]
    fn composite_publishers_do_not_expose_mixed_tuples() {
        let crossfeed = AtomicCrossfeedParams::new();
        crossfeed.write(true, 0.25, 900.0);
        let crossfeed_snapshot = crossfeed.read();
        assert!(crossfeed_snapshot.enabled);
        assert_eq!(crossfeed_snapshot.mix, 0.25);
        assert_eq!(crossfeed_snapshot.cutoff_hz, 900.0);

        let loudness = AtomicDynamicLoudnessParams::new();
        loudness.write(true, 0.25, 0.75);
        let loudness_snapshot = loudness.read();
        assert!(loudness_snapshot.enabled);
        assert_eq!(loudness_snapshot.volume, 0.25);
        assert_eq!(loudness_snapshot.strength, 0.75);

        let noise = AtomicNoiseShaperParams::new();
        noise.write(true, 16, crate::processor::dsp::NoiseShaperCurve::TpdfOnly);
        let noise_snapshot = noise.read();
        assert!(noise_snapshot.enabled);
        assert_eq!(noise_snapshot.bits, 16);
        assert_eq!(
            noise_snapshot.curve,
            crate::processor::dsp::NoiseShaperCurve::TpdfOnly
        );
    }

    #[test]
    fn test_saturation_params() {
        let params = AtomicSaturationParams::new();

        params.set_drive(1.5);
        params.set_mix(0.7);
        params.set_quality(SaturationQualityValue::Oversampled4x);
        params.set_enabled(true);

        let snapshot = params.read();
        assert!((snapshot.drive - 1.5).abs() < 1e-10);
        assert!((snapshot.mix - 0.7).abs() < 1e-10);
        assert_eq!(snapshot.quality, SaturationQualityValue::Oversampled4x);
        assert!(snapshot.enabled);
    }

    #[test]
    fn paired_saturation_gains_publish_once_and_reject_non_finite_atomically() {
        let params = AtomicSaturationParams::new();
        params.set_gains_db(-4.0, 4.0);
        let (_, before) = params.load_with_generation();

        params.set_gains_db(-9.0, 9.0);
        let (snapshot, after) = params.load_with_generation();
        assert_eq!(after, before + 1, "one paired write is one publication");
        assert!((snapshot.input_gain_db + 9.0).abs() < 1e-10);
        assert!((snapshot.output_gain_db - 9.0).abs() < 1e-10);

        params.set_gains_db(f64::NAN, 2.0);
        params.set_gains_db(2.0, f64::INFINITY);
        let (snapshot, rejected) = params.load_with_generation();
        assert_eq!(rejected, after, "a rejected pair must not publish");
        assert!((snapshot.input_gain_db + 9.0).abs() < 1e-10);
        assert!((snapshot.output_gain_db - 9.0).abs() < 1e-10);
    }

    #[test]
    fn reference_volume_writes_cannot_lose_a_concurrent_strength_update() {
        use std::sync::atomic::AtomicBool as Flag;

        const ITERATIONS: usize = 20_000;
        let params = Arc::new(AtomicDynamicLoudnessParams::new());
        // The default snapshot starts at full strength, so seed the floor the
        // strength writer will climb from.
        params.set_strength(DYNAMIC_LOUDNESS_STRENGTH_MIN);
        let stop = Arc::new(Flag::new(false));

        let writer_params = Arc::clone(&params);
        let reference_writer = std::thread::spawn(move || {
            for iteration in 0..ITERATIONS {
                // Alternate so the unchanged-value short circuit does not
                // silence the writer.
                writer_params.set_ref_volume_db(if iteration % 2 == 0 { -12.0 } else { -6.0 });
            }
        });

        let strength_params = Arc::clone(&params);
        let strength_writer = std::thread::spawn(move || {
            for iteration in 1..=ITERATIONS {
                strength_params.set_strength(iteration as f64 / ITERATIONS as f64);
            }
        });

        let observer_params = Arc::clone(&params);
        let observer_stop = Arc::clone(&stop);
        let observer = std::thread::spawn(move || {
            let mut highest = 0.0_f64;
            while !observer_stop.load(Ordering::Acquire) {
                let strength = observer_params.read().strength;
                // Strength is written strictly increasing. A published snapshot
                // carrying an older strength means a reference-volume write
                // resurrected a stale copy and lost that update.
                assert!(
                    strength >= highest,
                    "strength regressed from {highest} to {strength}"
                );
                highest = strength;
            }
        });

        reference_writer.join().unwrap();
        strength_writer.join().unwrap();
        stop.store(true, Ordering::Release);
        observer.join().unwrap();

        let snapshot = params.read();
        assert!((snapshot.strength - 1.0).abs() < 1e-10);
        assert!(snapshot.ref_volume_db.is_some());
    }

    #[test]
    fn test_simple_param_burst_final_state_visible() {
        let params = AtomicDynamicLoudnessParams::new();
        for i in 0..100 {
            params.set_volume(i as f64 / 100.0);
            params.set_strength(1.0 - i as f64 / 100.0);
        }

        let snapshot = params.read();
        assert!((snapshot.volume - 0.99).abs() < 1e-10);
        assert!((snapshot.strength - 0.01).abs() < 1e-10);
        assert!(snapshot.enabled);
    }

    /// `load_if_changed` distinguishes snapshots by allocation identity, so
    /// the backing store must hand out the *same* `Arc` until a publish
    /// replaces it. A store that rebuilt an `Arc` per read would still return
    /// correct values while silently degrading this into "always changed",
    /// forcing consumers to reload every block.
    #[test]
    fn load_if_changed_tracks_publication_identity_not_value() {
        let params = AtomicEqParams::new();
        let cached = params.load();

        // Repeated reads without a publish must all be the same allocation.
        assert!(params.load_if_changed(&cached).is_none());
        assert!(params.load_if_changed(&cached).is_none());
        assert!(Arc::ptr_eq(&params.load(), &cached));

        // Exactly one publish yields exactly one observed change.
        params.set_band_gain(2, 3.0);
        let changed = params
            .load_if_changed(&cached)
            .expect("a published snapshot must be observed as changed");
        assert!(!Arc::ptr_eq(&changed, &cached));
        assert!((changed.gains[2] - 3.0).abs() < 1e-10);

        // Re-reading against the new handle is quiet again.
        assert!(params.load_if_changed(&changed).is_none());

        // Publishing an identical value still counts as a publish: the
        // contract is about publication identity, not value equality.
        params.set_band_gain(2, 3.0);
        let republished = params
            .load_if_changed(&changed)
            .expect("republishing the same value is still a new snapshot");
        assert!((republished.gains[2] - 3.0).abs() < 1e-10);
        assert!(params.load_if_changed(&republished).is_none());
    }

    #[test]
    fn test_eq_snapshot_publication_keeps_old_and_new_consistent() {
        let params = AtomicEqParams::new();
        let old = params.load();

        params.set_band_gain(3, 6.0);
        let new = params.load();

        assert!(!Arc::ptr_eq(&old, &new));
        assert_eq!(old.gains, [0.0; EQ_BANDS]);
        assert!((new.gains[3] - 6.0).abs() < 1e-10);
        for (index, gain) in new.gains.iter().enumerate() {
            if index != 3 {
                assert!((*gain - 0.0).abs() < 1e-10);
            }
        }
    }

    #[test]
    fn test_dynamic_loudness_ref_volume_db_skips_unchanged_publish() {
        let params = AtomicDynamicLoudnessParams::new();

        params.set_ref_volume_db(-6.0);
        let first = params.load();

        params.set_ref_volume_db(-6.0);
        let second = params.load();

        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn test_telemetry_band_gains_round_trip() {
        let telemetry = AtomicDynamicLoudnessTelemetry::new();
        let gains = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0];

        telemetry.update(0.5, gains);

        assert!((telemetry.factor() - 0.5).abs() < 1e-10);
        assert_eq!(telemetry.band_gains(), gains);
    }

    #[test]
    fn test_volume_params_muted() {
        let params = AtomicVolumeParams::new();

        params.set_volume(0.5);
        assert!((params.effective_volume() - 0.5).abs() < 1e-10);

        params.set_muted(true);
        assert!((params.effective_volume() - 0.0).abs() < 1e-10);
    }

    #[test]
    fn realtime_reader_is_allocation_free_during_concurrent_publication() {
        const UPDATES: u64 = 10_000;
        const MAX_READ_ATTEMPTS: usize = 20_000_000;

        let params = Arc::new(AtomicEqParams::new());
        let (reader, initial, initial_generation) = params.subscribe_realtime();
        let ready = Arc::new(AtomicBool::new(false));
        let start = Arc::new(AtomicBool::new(false));
        let publishing_done = Arc::new(AtomicBool::new(false));

        let audio_params = Arc::clone(&params);
        let audio_ready = Arc::clone(&ready);
        let audio_start = Arc::clone(&start);
        let audio_publishing_done = Arc::clone(&publishing_done);
        let audio = std::thread::spawn(move || {
            let mut snapshot = initial;
            let mut generation = initial_generation;
            let mut attempts = 0;

            assert_no_alloc::assert_no_alloc(|| {
                audio_ready.store(true, Ordering::Release);
                while !audio_start.load(Ordering::Acquire) {
                    std::hint::spin_loop();
                }

                while attempts < MAX_READ_ATTEMPTS {
                    attempts += 1;
                    if let Some((next, next_generation)) =
                        audio_params.load_realtime_if_changed_since(&reader, generation)
                    {
                        let marker = next.gains[0];
                        assert!(next.gains.iter().all(|gain| *gain == marker));
                        assert_eq!(next.enabled, (marker as u64) & 1 == 0);
                        snapshot = next;
                        generation = next_generation;
                    }

                    if audio_publishing_done.load(Ordering::Acquire) && generation == UPDATES {
                        break;
                    }
                    std::hint::spin_loop();
                }
            });

            (snapshot, generation, attempts)
        });

        while !ready.load(Ordering::Acquire) {
            std::hint::spin_loop();
        }
        start.store(true, Ordering::Release);
        // The marker must stay inside the published band-gain range, because
        // `write` now clamps gains so a reader sees what the EQ applies.
        for update in 1..=UPDATES {
            let marker = (update % 15) as f64;
            params.write(&[marker; EQ_BANDS], (marker as u64) & 1 == 0);
        }
        publishing_done.store(true, Ordering::Release);

        let (snapshot, generation, attempts) = audio.join().unwrap();
        assert_eq!(
            generation, UPDATES,
            "reader stopped after {attempts} attempts"
        );
        assert_eq!(snapshot.gains, [(UPDATES % 15) as f64; EQ_BANDS]);
        assert!(snapshot.enabled);
    }
}
