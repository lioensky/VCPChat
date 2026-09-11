//! Lock-free `f64` atomic used by the parameter and telemetry layers.
//!
//! `f64` has no atomic primitive in `core`, but it has a lossless `u64` bit
//! representation, so an [`AtomicU64`] holding `f64::to_bits` provides exactly
//! the same guarantees as a hypothetical `AtomicF64`. This is the standard
//! transmute-free encoding: `to_bits`/`from_bits` are total, allocation-free,
//! and compile to no instructions on every supported target.
//!
//! Only `load` and `store` are provided because those are the only operations
//! this crate performs on atomic floats. Read-modify-write arithmetic
//! (`fetch_add` and friends) is deliberately absent: it cannot be expressed as
//! a single instruction on `f64` and would need a compare-exchange loop, which
//! is not something the audio callback should be doing silently.

use std::sync::atomic::{AtomicU64, Ordering};

/// An `f64` cell that can be read and written atomically.
///
/// NaN payload bits round-trip unchanged, so a stored NaN is observed as the
/// same NaN. Callers that must reject non-finite values validate before the
/// store, exactly as they did before.
///
/// The field is a plain [`AtomicU64`] rather than an `UnsafeCell`-based
/// representation on purpose. Auto traits are structural: rustdoc synthesizes
/// them from the field types, and a manual `impl RefUnwindSafe` on a private
/// type is *not* propagated to the public types that hold one. Wrapping
/// `AtomicU64` — which is itself `UnwindSafe + RefUnwindSafe` — means every
/// public type holding an `AtomicF64` keeps the same auto-trait surface it had
/// with the previous `atomic_float` dependency, which the committed public-API
/// baseline treats as load-bearing.
#[derive(Debug)]
#[repr(transparent)]
pub(crate) struct AtomicF64 {
    bits: AtomicU64,
}

impl AtomicF64 {
    /// Create a cell holding `value`.
    #[inline]
    pub(crate) const fn new(value: f64) -> Self {
        Self {
            bits: AtomicU64::new(value.to_bits()),
        }
    }
    /// Read the current value with the given ordering.
    #[inline]
    pub(crate) fn load(&self, ordering: Ordering) -> f64 {
        f64::from_bits(self.bits.load(ordering))
    }

    /// Publish `value` with the given ordering.
    #[inline]
    pub(crate) fn store(&self, value: f64, ordering: Ordering) {
        self.bits.store(value.to_bits(), ordering);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_representative_values_including_non_finite() {
        for value in [
            0.0,
            -0.0,
            1.0,
            -1.0,
            f64::MIN,
            f64::MAX,
            f64::MIN_POSITIVE,
            f64::EPSILON,
            -70.0,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ] {
            let cell = AtomicF64::new(value);
            assert_eq!(cell.load(Ordering::Relaxed).to_bits(), value.to_bits());

            let replaced = AtomicF64::new(0.0);
            replaced.store(value, Ordering::Relaxed);
            assert_eq!(replaced.load(Ordering::Relaxed).to_bits(), value.to_bits());
        }
    }

    #[test]
    fn nan_round_trips_as_nan() {
        let cell = AtomicF64::new(0.0);
        cell.store(f64::NAN, Ordering::Relaxed);
        assert!(cell.load(Ordering::Relaxed).is_nan());
    }

    #[test]
    fn signed_zero_is_distinguishable() {
        let cell = AtomicF64::new(-0.0);
        assert!(cell.load(Ordering::Relaxed).is_sign_negative());
        cell.store(0.0, Ordering::Relaxed);
        assert!(cell.load(Ordering::Relaxed).is_sign_positive());
    }
}
