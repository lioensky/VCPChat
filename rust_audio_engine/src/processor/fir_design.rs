//! Setup-time FIR design helpers shared by the EQ and resampler modules.

use realfft::{ComplexToReal, RealFftPlanner};
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::sync::Arc;

/// A planned forward/inverse pair for one transform length.
struct PlanPair {
    len: usize,
    forward: Arc<dyn Fft<f64>>,
    inverse: Arc<dyn Fft<f64>>,
}

/// A planned real inverse transform for one length.
struct RealInversePlan {
    len: usize,
    plan: Arc<dyn ComplexToReal<f64>>,
}

/// Reusable FFT plan cache for the FIR design helpers.
///
/// `FftPlanner::new()` starts empty, so planning from a fresh planner repeats a
/// prime factorization, an algorithm selection, and a twiddle-factor
/// precomputation every time. At 8192 points that measured 171 us from a cold
/// planner against 0.072 us from a warm one. A planner also shares recipes and
/// twiddles *across directions*, so holding one planner for both the forward and
/// inverse plan of a size is materially cheaper than holding two.
///
/// This is deliberately owned by the caller rather than kept in a global or
/// thread-local: `FirEq::new` is public API and takes a caller-chosen
/// `num_taps`, so a process-wide cache keyed by transform size would be an
/// unbounded, caller-driven memory growth path. Scoping the cache to an owner
/// bounds it by that owner's lifetime.
///
/// Plans are read-only once built (`process` does not mutate them) and a cached
/// plan is bit-identical in output to a freshly built one, so reuse is a pure
/// performance change. Holding one does cost `UnwindSafe`/`RefUnwindSafe` for
/// the owning type, because `dyn Fft` and `dyn ComplexToReal` do not declare
/// `RefUnwindSafe`; that narrowing is recorded in the public API baseline.
pub(crate) struct FirFftPlans {
    planner: FftPlanner<f64>,
    /// Cached plans. The helpers here use a handful of power-of-two sizes per
    /// owner, so a short linear scan beats hashing.
    plans: Vec<PlanPair>,
    real_planner: RealFftPlanner<f64>,
    /// Cached real inverse plans, used by the linear-phase EQ design.
    real_inverse: Vec<RealInversePlan>,
}

impl FirFftPlans {
    pub(crate) fn new() -> Self {
        Self {
            planner: FftPlanner::new(),
            plans: Vec::new(),
            real_planner: RealFftPlanner::new(),
            real_inverse: Vec::new(),
        }
    }

    /// Forward and inverse plans for `len`, planned once per cache.
    fn pair(&mut self, len: usize) -> (Arc<dyn Fft<f64>>, Arc<dyn Fft<f64>>) {
        if let Some(cached) = self.plans.iter().find(|entry| entry.len == len) {
            return (Arc::clone(&cached.forward), Arc::clone(&cached.inverse));
        }
        let forward = self.planner.plan_fft_forward(len);
        let inverse = self.planner.plan_fft_inverse(len);
        self.plans.push(PlanPair {
            len,
            forward: Arc::clone(&forward),
            inverse: Arc::clone(&inverse),
        });
        (forward, inverse)
    }

    /// Forward-only accessor, used by the resampler's minimum-phase prototype.
    /// Populates both directions so the paired inverse is already warm when the
    /// factorization asks for it.
    #[cfg(all(feature = "rubato", not(feature = "soxr")))]
    pub(crate) fn forward(&mut self, len: usize) -> Arc<dyn Fft<f64>> {
        self.pair(len).0
    }

    /// Real inverse plan for `len`, planned once per cache.
    pub(crate) fn real_inverse(&mut self, len: usize) -> Arc<dyn ComplexToReal<f64>> {
        if let Some(cached) = self.real_inverse.iter().find(|entry| entry.len == len) {
            return Arc::clone(&cached.plan);
        }
        let plan = self.real_planner.plan_fft_inverse(len);
        self.real_inverse.push(RealInversePlan {
            len,
            plan: Arc::clone(&plan),
        });
        plan
    }
}

/// Modified Bessel function of the first kind, order zero.
///
/// FIR window design calls this during setup only. The bounded series avoids a
/// dependency solely for coefficient construction and is shared by the
/// resampler's Kaiser-windowed designs.
#[cfg(all(feature = "rubato", not(feature = "soxr")))]
pub(crate) fn modified_bessel_i0(value: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let half_squared = (value * value) * 0.25;
    for order in 1..=64 {
        term *= half_squared / (order as f64 * order as f64);
        sum += term;
        if term.abs() <= sum.abs() * 1.0e-16 {
            break;
        }
    }
    sum
}

/// Convert a Hermitian log-magnitude spectrum into a causal minimum-phase IR.
///
/// The input contains natural-log magnitude for every FFT bin, with negative
/// frequency bins already mirrored. This helper is setup-only: it allocates
/// and plans FFTs, so callers must not invoke it from a processing callback.
///
/// This stays on `rustfft`'s complex transforms on purpose, unlike the other FFT
/// sites in this crate. The real-cepstrum factorization exponentiates a
/// *complex* spectrum (`value.exp()`) between the transforms: the intermediate
/// carries the Hilbert-transform phase in its imaginary part, so it is genuinely
/// complex-valued and a real transform cannot represent it. Only the two
/// endpoints are real, and splitting the plan to exploit that would obscure the
/// factorization for no measurable gain at setup-time call rates.
pub(crate) fn minimum_phase_from_log_magnitude(
    log_magnitude: &[f64],
    output_len: usize,
    plans: &mut FirFftPlans,
) -> Vec<f64> {
    if output_len == 0 || log_magnitude.is_empty() {
        return Vec::new();
    }

    let fft_size = log_magnitude.len();
    let mut spectrum: Vec<Complex<f64>> = log_magnitude
        .iter()
        .map(|&value| Complex::new(value, 0.0))
        .collect();

    // One cache lookup yields both directions; the caller reuses the same cache
    // across `minimum_phase_prototype`, so the shared size is planned once.
    let (fft, ifft) = plans.pair(fft_size);
    ifft.process(&mut spectrum);

    // rustfft's inverse transform is intentionally unnormalised.
    let inverse_scale = 1.0 / fft_size as f64;
    for value in &mut spectrum {
        *value *= inverse_scale;
    }

    // Keep the causal cepstrum: DC and Nyquist stay unchanged, positive
    // quefrencies are doubled, and negative quefrencies are discarded.
    let half = fft_size / 2;
    for (index, value) in spectrum.iter_mut().enumerate() {
        if index == 0 || index == half {
            continue;
        }
        if index < half {
            *value *= 2.0;
        } else {
            *value = Complex::new(0.0, 0.0);
        }
    }

    fft.process(&mut spectrum);
    for value in &mut spectrum {
        *value = value.exp();
    }

    ifft.process(&mut spectrum);
    let output_len = output_len.min(fft_size);
    spectrum[..output_len]
        .iter()
        .map(|value| value.re * inverse_scale)
        .collect()
}
