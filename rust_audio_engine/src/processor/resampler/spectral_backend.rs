//! FFT block-convolution nonlinear-phase rational resampling.
//!
//! This engine replaces the time-domain rational polyphase FIR in the
//! streaming path with spectral rational resampling: an overlap-save real FFT
//! of the input block, one precomputed complex-kernel spectrum fold onto the
//! output bin grid, and an inverse real FFT at the output block size. The
//! decimation alias fold is computed exactly (all `down` alias terms per
//! output bin), so the engine is mathematically identical to the time-domain
//! polyphase convolution up to floating-point rounding. The kernel itself is
//! the unchanged real-cepstrum minimum-phase design (maximum phase is its
//! time reversal), so latency and finish-extension formulas carry over.
//!
//! All FFT plans, spectra, the fold table, and every staging buffer are
//! allocated during construction; `process_chunk` and `reset` perform only
//! bounded copies, FFT executions with preallocated scratch, and the fold
//! multiply loop.

use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use rustfft::{num_complex::Complex, FftPlanner};
use std::sync::Arc;

use crate::config::{PhaseResponse, ResampleQuality};

use super::polyphase_backend::{
    design_linear_prototype, gcd, kernel_finish_extension_frames, minimum_phase_prototype,
    normalize_kernel, phase_peak_latency_frames, taps_per_phase, MAX_POLYPHASE_COEFFICIENTS,
    MAX_REDUCED_RATE,
};
use crate::processor::fir_design::FirFftPlans;

use super::{BackendInitError, BackendProcessError};

/// One precomputed alias-fold term: output bin `k` accumulates
/// `(h_re + i·h_im) · (x.re + i·sign·x.im)` from input bin `index`.
struct FoldEntry {
    h_re: f64,
    h_im: f64,
    sign: f64,
    index: u32,
}

pub(super) struct SpectralNonlinearResampler {
    channels: usize,
    /// Input frames per internal FFT block (`down · s`, at least one kernel
    /// input span so overlap-save circular aliasing cannot occur).
    nin: usize,
    /// Output frames per internal FFT block (`up · s`; exact rational pacing).
    nout: usize,
    chunk_frames: usize,
    /// `(nout + 1) · down` entries ordered by output bin, `down` terms each.
    fold: Vec<FoldEntry>,
    down: usize,
    forward: Arc<dyn RealToComplex<f64>>,
    inverse: Arc<dyn ComplexToReal<f64>>,
    /// Per-channel previous input block (`channels · nin`).
    history: Vec<f64>,
    /// Per-channel deinterleaved staging for the current block.
    pending: Vec<f64>,
    pending_frames: usize,
    /// Forward FFT input scratch (`2 · nin`; realfft mutates its input).
    time_in: Vec<f64>,
    spec_in: Vec<Complex<f64>>,
    spec_out: Vec<Complex<f64>>,
    time_out: Vec<f64>,
    forward_scratch: Vec<Complex<f64>>,
    inverse_scratch: Vec<Complex<f64>>,
    latency_frames: usize,
    finish_extension_frames: usize,
}

impl SpectralNonlinearResampler {
    pub(super) fn new(
        from_rate: u32,
        to_rate: u32,
        phase: PhaseResponse,
        quality: ResampleQuality,
        channels: usize,
        chunk_frames: usize,
    ) -> Result<Self, BackendInitError> {
        if channels == 0 {
            return Err(BackendInitError::ZeroChannels);
        }
        if chunk_frames == 0 || from_rate == 0 || to_rate == 0 {
            return Err(BackendInitError::InvalidGeometry {
                backend: "spectral",
            });
        }
        if matches!(phase, PhaseResponse::Linear) {
            return Err(BackendInitError::NonlinearPhaseRequired {
                backend: "spectral",
            });
        }

        let divisor = gcd(from_rate, to_rate);
        let up = (to_rate / divisor) as usize;
        let down = (from_rate / divisor) as usize;
        if up > MAX_REDUCED_RATE || down > MAX_REDUCED_RATE {
            return Err(BackendInitError::RatioExceedsLimit {
                up,
                down,
                limit: MAX_REDUCED_RATE,
            });
        }

        let taps_per_phase = taps_per_phase(quality);
        let kernel_len = up
            .checked_mul(taps_per_phase)
            .ok_or(BackendInitError::CoefficientCountOverflow)?;
        if kernel_len > MAX_POLYPHASE_COEFFICIENTS {
            return Err(BackendInitError::CoefficientBankTooLarge {
                coefficients: kernel_len,
                maximum: MAX_POLYPHASE_COEFFICIENTS,
            });
        }

        let prototype = design_linear_prototype(up, down, taps_per_phase, quality);
        // One cache shared by `minimum_phase_prototype` and the factorization it
        // calls, so the common transform size is planned once instead of twice.
        let mut plans = FirFftPlans::new();
        let minimum = minimum_phase_prototype(&prototype, &mut plans)?;
        let mut kernel = match phase {
            PhaseResponse::Minimum => minimum,
            PhaseResponse::Maximum => minimum.into_iter().rev().collect(),
            PhaseResponse::Linear => unreachable!("linear phase rejected above"),
        };
        normalize_kernel(&mut kernel);
        let latency_frames = phase_peak_latency_frames(&kernel, down);
        let finish_extension_frames = kernel_finish_extension_frames(kernel.len(), down);

        // Smallest block with `nin >= taps_per_phase` keeps the kept
        // overlap-save half alias-free (`nin · up >= kernel_len - 1`).
        let s = taps_per_phase.div_ceil(down).max(1);
        let nin = down * s;
        let nout = up * s;
        let n_in_full = 2 * nin;
        let n_out_full = 2 * nout;
        let n_up = n_in_full
            .checked_mul(up)
            .ok_or(BackendInitError::StorageOverflow {
                buffer: "nonlinear FFT grid",
            })?;
        debug_assert!(nin * up >= kernel_len - 1);

        // Unnormalized complex FFT of the zero-padded time-domain kernel; the
        // interpolation gain (×up), the exact decimation fold (÷down), and the
        // unnormalized inverse FFT (÷n_out_full) are folded in once here.
        let mut kernel_spectrum = vec![Complex::new(0.0, 0.0); n_up];
        for (bin, &sample) in kernel_spectrum.iter_mut().zip(kernel.iter()) {
            bin.re = sample;
        }
        FftPlanner::new()
            .plan_fft_forward(n_up)
            .process(&mut kernel_spectrum);
        let scale = up as f64 / (down as f64 * n_out_full as f64);
        let half_up = n_up / 2;

        let mut fold = Vec::with_capacity((nout + 1) * down);
        for k in 0..=nout {
            for m in 0..down {
                let j = k + m * n_out_full;
                let (mut h, outer_conj) = if j <= half_up {
                    (kernel_spectrum[j], false)
                } else {
                    (kernel_spectrum[n_up - j], true)
                };
                let r = j % n_in_full;
                let (index, x_conj) = if r <= nin {
                    (r, false)
                } else {
                    (n_in_full - r, true)
                };
                // For the mirrored half (`j > half_up`) the term is
                // `conj(H[n_up - j] · X_ext((n_up - j) mod n_in_full))`.
                // `X_ext((n_in_full - r) mod n_in_full)` equals
                // `conj(X_ext(r))` for a real input block, so the double
                // conjugation on X cancels: only H is conjugated while the
                // X lookup keeps the ordinary rule for `r`.
                if outer_conj {
                    h = h.conj();
                }
                fold.push(FoldEntry {
                    h_re: h.re * scale,
                    h_im: h.im * scale,
                    sign: if x_conj { -1.0 } else { 1.0 },
                    index: index as u32,
                });
            }
        }

        let mut planner = RealFftPlanner::<f64>::new();
        let forward = planner.plan_fft_forward(n_in_full);
        let inverse = planner.plan_fft_inverse(n_out_full);
        let forward_scratch = forward.make_scratch_vec();
        let inverse_scratch = inverse.make_scratch_vec();

        Ok(Self {
            channels,
            nin,
            nout,
            chunk_frames,
            fold,
            down,
            forward,
            inverse,
            history: vec![0.0; channels * nin],
            pending: vec![0.0; channels * nin],
            pending_frames: 0,
            time_in: vec![0.0; n_in_full],
            spec_in: vec![Complex::new(0.0, 0.0); nin + 1],
            spec_out: vec![Complex::new(0.0, 0.0); nout + 1],
            time_out: vec![0.0; n_out_full],
            forward_scratch,
            inverse_scratch,
            latency_frames,
            finish_extension_frames,
        })
    }

    pub(super) fn output_frames_max(&self) -> usize {
        // Pending can hold `nin - 1` frames before the chunk arrives.
        self.chunk_frames.div_ceil(self.nin) * self.nout
    }

    pub(super) fn output_delay(&self) -> usize {
        0
    }

    pub(super) fn latency_frames(&self) -> usize {
        self.latency_frames
    }

    pub(super) fn finish_extension_frames(&self) -> usize {
        self.finish_extension_frames
    }

    pub(super) fn process_chunk(
        &mut self,
        input: &[f64],
        output: &mut [f64],
    ) -> Result<(usize, usize), BackendProcessError> {
        if !input.len().is_multiple_of(self.channels) || !output.len().is_multiple_of(self.channels)
        {
            return Err("nonlinear backend received an incomplete frame".into());
        }
        let input_frames = input.len() / self.channels;
        let output_capacity = output.len() / self.channels;
        let block_count = (self.pending_frames + input_frames) / self.nin;
        if output_capacity < block_count * self.nout {
            return Err("nonlinear backend output stage is too small".into());
        }

        let mut consumed = 0usize;
        let mut produced = 0usize;
        while consumed < input_frames {
            let take = (self.nin - self.pending_frames).min(input_frames - consumed);
            for channel in 0..self.channels {
                let pending_base = channel * self.nin + self.pending_frames;
                for frame in 0..take {
                    self.pending[pending_base + frame] =
                        input[(consumed + frame) * self.channels + channel];
                }
            }
            self.pending_frames += take;
            consumed += take;
            if self.pending_frames == self.nin {
                self.run_block(&mut output[produced * self.channels..])?;
                produced += self.nout;
                self.pending_frames = 0;
            }
        }

        Ok((input_frames, produced))
    }

    /// Run one complete `nin`-input / `nout`-output overlap-save block for
    /// every channel, writing interleaved frames at the start of `output`.
    fn run_block(&mut self, output: &mut [f64]) -> Result<(), BackendProcessError> {
        for channel in 0..self.channels {
            let history = &mut self.history[channel * self.nin..(channel + 1) * self.nin];
            let pending = &self.pending[channel * self.nin..(channel + 1) * self.nin];
            self.time_in[..self.nin].copy_from_slice(history);
            self.time_in[self.nin..].copy_from_slice(pending);
            history.copy_from_slice(pending);

            self.forward
                .process_with_scratch(
                    &mut self.time_in,
                    &mut self.spec_in,
                    &mut self.forward_scratch,
                )
                .map_err(|_| BackendProcessError::new("nonlinear backend forward FFT failed"))?;

            for (k, entries) in self.fold.chunks_exact(self.down).enumerate() {
                let mut real = 0.0_f64;
                let mut imaginary = 0.0_f64;
                for entry in entries {
                    let x = self.spec_in[entry.index as usize];
                    let x_re = x.re;
                    let x_im = entry.sign * x.im;
                    real += entry.h_re * x_re - entry.h_im * x_im;
                    imaginary += entry.h_re * x_im + entry.h_im * x_re;
                }
                self.spec_out[k] = Complex::new(real, imaginary);
            }
            // The exact fold leaves only rounding noise here; realfft requires
            // the DC and Nyquist bins to be purely real.
            self.spec_out[0].im = 0.0;
            self.spec_out[self.nout].im = 0.0;

            self.inverse
                .process_with_scratch(
                    &mut self.spec_out,
                    &mut self.time_out,
                    &mut self.inverse_scratch,
                )
                .map_err(|_| BackendProcessError::new("nonlinear backend inverse FFT failed"))?;

            let kept = &self.time_out[self.nout..];
            for (frame, &sample) in kept.iter().enumerate() {
                output[frame * self.channels + channel] = sample;
            }
        }
        Ok(())
    }

    pub(super) fn reset(&mut self) {
        self.history.fill(0.0);
        self.pending.fill(0.0);
        self.pending_frames = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::super::polyphase_backend::PolyphaseResampler;
    use super::*;

    const CHUNK: usize = 1_024;

    fn signal(frames: usize, channels: usize) -> Vec<f64> {
        (0..frames)
            .flat_map(|frame| {
                let time = frame as f64;
                (0..channels).map(move |channel| {
                    let offset = channel as f64 * 0.61;
                    (time * 0.019 + offset).sin() * 0.5 + (time * 0.0041 + offset).cos() * 0.3
                })
            })
            .collect()
    }

    type EngineProcess<'a> =
        &'a mut dyn FnMut(&[f64], &mut [f64]) -> Result<(usize, usize), BackendProcessError>;

    fn render_engine_chunks(
        process: EngineProcess<'_>,
        output_frames_max: usize,
        input: &[f64],
        channels: usize,
        flush_chunks: usize,
    ) -> Vec<f64> {
        let mut rendered = Vec::new();
        let mut stage = vec![0.0; output_frames_max * channels];
        let zero = vec![0.0; CHUNK * channels];
        let frames = input.len() / channels;
        let mut cursor = 0usize;
        while cursor < frames {
            let take = CHUNK.min(frames - cursor);
            let mut chunk = input[cursor * channels..(cursor + take) * channels].to_vec();
            chunk.resize(CHUNK * channels, 0.0);
            let (consumed, produced) = process(&chunk, &mut stage).unwrap();
            assert_eq!(consumed, CHUNK);
            rendered.extend_from_slice(&stage[..produced * channels]);
            cursor += take;
        }
        for _ in 0..flush_chunks {
            let (_, produced) = process(&zero, &mut stage).unwrap();
            rendered.extend_from_slice(&stage[..produced * channels]);
        }
        rendered
    }

    #[test]
    fn spectral_output_matches_time_domain_polyphase_within_1e_minus_9() {
        for (from_rate, to_rate) in [
            (48_000_u32, 96_000_u32),
            (96_000, 48_000),
            (44_100, 48_000),
            (48_000, 44_100),
        ] {
            for quality in [
                ResampleQuality::Standard,
                ResampleQuality::High,
                ResampleQuality::UltraHigh,
            ] {
                for phase in [PhaseResponse::Minimum, PhaseResponse::Maximum] {
                    let channels = 2usize;
                    let input = signal(3 * CHUNK + 311, channels);
                    let mut spectral = SpectralNonlinearResampler::new(
                        from_rate, to_rate, phase, quality, channels, CHUNK,
                    )
                    .unwrap();
                    let mut polyphase = PolyphaseResampler::new(
                        from_rate, to_rate, phase, quality, channels, CHUNK,
                    )
                    .unwrap();

                    let spectral_max = spectral.output_frames_max();
                    let spectral_out = render_engine_chunks(
                        &mut |input, output| spectral.process_chunk(input, output),
                        spectral_max,
                        &input,
                        channels,
                        4,
                    );
                    let polyphase_max = polyphase.output_frames_max();
                    let polyphase_out = render_engine_chunks(
                        &mut |input, output| polyphase.process_chunk(input, output),
                        polyphase_max,
                        &input,
                        channels,
                        4,
                    );

                    let shared = spectral_out.len().min(polyphase_out.len());
                    assert!(shared > 2 * CHUNK * channels);
                    let mut max_error = 0.0_f64;
                    for index in 0..shared {
                        max_error =
                            max_error.max((spectral_out[index] - polyphase_out[index]).abs());
                    }
                    assert!(
                        max_error < 1.0e-9,
                        "{from_rate}->{to_rate} {quality:?} {phase:?} max error {max_error:.3e}"
                    );
                }
            }
        }
    }

    #[test]
    fn spectral_timing_metadata_matches_polyphase_formulas() {
        for (from_rate, to_rate) in [(48_000_u32, 96_000_u32), (44_100, 48_000)] {
            for phase in [PhaseResponse::Minimum, PhaseResponse::Maximum] {
                let spectral = SpectralNonlinearResampler::new(
                    from_rate,
                    to_rate,
                    phase,
                    ResampleQuality::High,
                    1,
                    CHUNK,
                )
                .unwrap();
                let polyphase = PolyphaseResampler::new(
                    from_rate,
                    to_rate,
                    phase,
                    ResampleQuality::High,
                    1,
                    CHUNK,
                )
                .unwrap();
                assert_eq!(spectral.output_delay(), 0);
                assert_eq!(spectral.latency_frames(), polyphase.latency_frames());
                assert_eq!(
                    spectral.finish_extension_frames(),
                    polyphase.finish_extension_frames()
                );
            }
        }
    }

    #[test]
    fn spectral_rejects_pathological_reduced_geometry() {
        let error = match SpectralNonlinearResampler::new(
            44_100,
            44_101,
            PhaseResponse::Minimum,
            ResampleQuality::High,
            1,
            CHUNK,
        ) {
            Err(error) => error,
            Ok(_) => panic!("pathological ratio unexpectedly accepted"),
        };
        assert!(matches!(
            error,
            BackendInitError::RatioExceedsLimit {
                up: 44_101,
                down: 44_100,
                limit: MAX_REDUCED_RATE,
            }
        ));
    }

    #[test]
    fn spectral_reset_restores_a_fresh_stream() {
        let channels = 2usize;
        let input = signal(2 * CHUNK, channels);
        let mut engine = SpectralNonlinearResampler::new(
            44_100,
            48_000,
            PhaseResponse::Minimum,
            ResampleQuality::High,
            channels,
            CHUNK,
        )
        .unwrap();
        let output_max = engine.output_frames_max();
        let fresh = render_engine_chunks(
            &mut |input, output| engine.process_chunk(input, output),
            output_max,
            &input,
            channels,
            2,
        );
        engine.reset();
        let reused = render_engine_chunks(
            &mut |input, output| engine.process_chunk(input, output),
            output_max,
            &input,
            channels,
            2,
        );
        assert_eq!(fresh.len(), reused.len());
        for (index, (expected, actual)) in fresh.iter().zip(&reused).enumerate() {
            assert_eq!(
                expected.to_bits(),
                actual.to_bits(),
                "reset stream diverged at sample {index}"
            );
        }
    }

    #[test]
    fn spectral_process_and_reset_are_allocation_free_after_setup() {
        let channels = 2usize;
        let mut engine = SpectralNonlinearResampler::new(
            44_100,
            48_000,
            PhaseResponse::Minimum,
            ResampleQuality::High,
            channels,
            CHUNK,
        )
        .unwrap();
        let input = signal(CHUNK, channels);
        let mut output = vec![0.0; engine.output_frames_max() * channels];
        assert_no_alloc::assert_no_alloc(|| {
            engine.process_chunk(&input, &mut output).unwrap();
            engine.process_chunk(&input, &mut output).unwrap();
            engine.reset();
        });
    }
}
