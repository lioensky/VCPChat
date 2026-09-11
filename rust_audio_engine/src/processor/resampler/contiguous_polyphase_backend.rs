//! Contiguous time-domain polyphase nonlinear-phase rational resampling.
//!
//! For nonlinear phases with a large reduced interpolation factor (`up > 16`,
//! e.g. 44.1 kHz <-> 48 kHz's 147:160), the exact spectral alias fold streams a
//! spectrum table proportional to `up` per input sample and becomes
//! memory-bandwidth-bound. This engine evaluates the identical real-cepstrum
//! kernel in the time domain instead: a planar per-channel history buffer is
//! shifted with one `copy_within` per chunk, and every output frame is one
//! contiguous `taps_per_phase` dot product (4 accumulators, coefficient slices
//! shared across channels for the stereo kernel). The `up * taps_per_phase`
//! coefficient bank fits cache, so per-frame cost is `taps_per_phase * up/down`
//! multiply-adds rather than an `up`-sized spectrum stream.
//!
//! The kernel design, exact rational pacing, latency, and finish-extension
//! formulas are shared with the spectral engine and the retired test-only
//! polyphase oracle, so streaming semantics and quality evidence carry over
//! unchanged. All buffers are allocated during construction; `process_chunk`
//! and `reset` perform only bounded copies and fixed-length dot products.

use crate::config::{PhaseResponse, ResampleQuality};

#[cfg(target_arch = "x86")]
use std::arch::x86::{
    __m256d, _mm256_add_pd, _mm256_loadu_pd, _mm256_mul_pd, _mm256_setzero_pd, _mm256_storeu_pd,
};
#[cfg(target_arch = "x86_64")]
use std::arch::x86_64::{
    __m256d, _mm256_add_pd, _mm256_loadu_pd, _mm256_mul_pd, _mm256_setzero_pd, _mm256_storeu_pd,
};

use super::polyphase_backend::{
    design_linear_prototype, gcd, kernel_finish_extension_frames, minimum_phase_prototype,
    normalize_kernel, phase_peak_latency_frames, polyphase_coefficients, taps_per_phase,
    MAX_POLYPHASE_COEFFICIENTS, MAX_REDUCED_RATE,
};
use crate::processor::fir_design::FirFftPlans;

use super::{BackendInitError, BackendProcessError};

pub(super) struct ContiguousPolyphaseResampler {
    channels: usize,
    up: usize,
    down: usize,
    taps_per_phase: usize,
    /// Reversed per-phase coefficient banks: entry `phase * taps + i`
    /// multiplies the history sample `taps - 1 - i` frames old, so the dot
    /// product walks both slices forward contiguously.
    coefficients_reversed: Vec<f64>,
    /// Planar per-channel history. The head retains enough prior input for the
    /// first rationally authorized output to lag the current chunk boundary.
    history: Vec<f64>,
    history_head_frames: usize,
    history_stride: usize,
    chunk_frames: usize,
    total_input: u64,
    next_output: u64,
    latency_frames: usize,
    finish_extension_frames: usize,
    /// Selected during setup; the callback never performs feature detection.
    stereo_dot_kernel: StereoDotKernel,
}

type StereoDotKernel = fn(&[f64], &[f64], &[f64]) -> (f64, f64);

/// Contiguous dot product with four independent accumulators.
#[inline]
fn dot_contiguous(coefficients: &[f64], history: &[f64]) -> f64 {
    debug_assert_eq!(coefficients.len(), history.len());
    let mut acc = [0.0_f64; 4];
    let mut coefficient_chunks = coefficients.chunks_exact(4);
    let mut history_chunks = history.chunks_exact(4);
    for (c, h) in (&mut coefficient_chunks).zip(&mut history_chunks) {
        acc[0] += c[0] * h[0];
        acc[1] += c[1] * h[1];
        acc[2] += c[2] * h[2];
        acc[3] += c[3] * h[3];
    }
    let mut tail = 0.0_f64;
    for (c, h) in coefficient_chunks
        .remainder()
        .iter()
        .zip(history_chunks.remainder())
    {
        tail += c * h;
    }
    (acc[0] + acc[1]) + (acc[2] + acc[3]) + tail
}

/// Stereo dot product sharing each coefficient load across both channels.
#[inline]
fn dot_contiguous_stereo_scalar(coefficients: &[f64], left: &[f64], right: &[f64]) -> (f64, f64) {
    debug_assert_eq!(coefficients.len(), left.len());
    debug_assert_eq!(coefficients.len(), right.len());
    let mut acc_left = [0.0_f64; 4];
    let mut acc_right = [0.0_f64; 4];
    let mut coefficient_chunks = coefficients.chunks_exact(4);
    let mut left_chunks = left.chunks_exact(4);
    let mut right_chunks = right.chunks_exact(4);
    for ((c, l), r) in (&mut coefficient_chunks)
        .zip(&mut left_chunks)
        .zip(&mut right_chunks)
    {
        acc_left[0] += c[0] * l[0];
        acc_left[1] += c[1] * l[1];
        acc_left[2] += c[2] * l[2];
        acc_left[3] += c[3] * l[3];
        acc_right[0] += c[0] * r[0];
        acc_right[1] += c[1] * r[1];
        acc_right[2] += c[2] * r[2];
        acc_right[3] += c[3] * r[3];
    }
    let mut tail_left = 0.0_f64;
    let mut tail_right = 0.0_f64;
    for ((c, l), r) in coefficient_chunks
        .remainder()
        .iter()
        .zip(left_chunks.remainder())
        .zip(right_chunks.remainder())
    {
        tail_left += c * l;
        tail_right += c * r;
    }
    (
        (acc_left[0] + acc_left[1]) + (acc_left[2] + acc_left[3]) + tail_left,
        (acc_right[0] + acc_right[1]) + (acc_right[2] + acc_right[3]) + tail_right,
    )
}

fn select_stereo_dot_kernel() -> StereoDotKernel {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    if std::arch::is_x86_feature_detected!("avx2") {
        return dot_contiguous_stereo_avx2;
    }
    dot_contiguous_stereo_scalar
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
fn dot_contiguous_stereo_avx2(coefficients: &[f64], left: &[f64], right: &[f64]) -> (f64, f64) {
    debug_assert_eq!(coefficients.len(), left.len());
    debug_assert_eq!(coefficients.len(), right.len());
    // SAFETY: this wrapper is selected only after setup-time AVX2 feature
    // detection, and the three slices have identical validated lengths.
    unsafe { dot_contiguous_stereo_avx2_inner(coefficients, left, right) }
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "avx2")]
unsafe fn dot_contiguous_stereo_avx2_inner(
    coefficients: &[f64],
    left: &[f64],
    right: &[f64],
) -> (f64, f64) {
    let mut acc_left: __m256d = _mm256_setzero_pd();
    let mut acc_right: __m256d = _mm256_setzero_pd();
    let vectorized_len = coefficients.len() & !3;
    let mut index = 0;
    while index < vectorized_len {
        // SAFETY: `index..index + 4` stays inside all equal-length slices, and
        // the unaligned AVX loads accept arbitrary f64 alignment.
        unsafe {
            let coefficient_values = _mm256_loadu_pd(coefficients.as_ptr().add(index));
            let left_values = _mm256_loadu_pd(left.as_ptr().add(index));
            let right_values = _mm256_loadu_pd(right.as_ptr().add(index));
            acc_left = _mm256_add_pd(acc_left, _mm256_mul_pd(coefficient_values, left_values));
            acc_right = _mm256_add_pd(acc_right, _mm256_mul_pd(coefficient_values, right_values));
        }
        index += 4;
    }

    let mut left_lanes = [0.0_f64; 4];
    let mut right_lanes = [0.0_f64; 4];
    // SAFETY: both lane arrays contain four writable f64 values.
    unsafe {
        _mm256_storeu_pd(left_lanes.as_mut_ptr(), acc_left);
        _mm256_storeu_pd(right_lanes.as_mut_ptr(), acc_right);
    }
    let mut tail_left = 0.0_f64;
    let mut tail_right = 0.0_f64;
    while index < coefficients.len() {
        tail_left += coefficients[index] * left[index];
        tail_right += coefficients[index] * right[index];
        index += 1;
    }
    (
        (left_lanes[0] + left_lanes[1]) + (left_lanes[2] + left_lanes[3]) + tail_left,
        (right_lanes[0] + right_lanes[1]) + (right_lanes[2] + right_lanes[3]) + tail_right,
    )
}

impl ContiguousPolyphaseResampler {
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
                backend: "contiguous polyphase",
            });
        }
        if matches!(phase, PhaseResponse::Linear) {
            return Err(BackendInitError::NonlinearPhaseRequired {
                backend: "contiguous polyphase",
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
        let coefficient_count = up
            .checked_mul(taps_per_phase)
            .ok_or(BackendInitError::CoefficientCountOverflow)?;
        if coefficient_count > MAX_POLYPHASE_COEFFICIENTS {
            return Err(BackendInitError::CoefficientBankTooLarge {
                coefficients: coefficient_count,
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

        let forward = polyphase_coefficients(&kernel, up, taps_per_phase);
        let mut coefficients_reversed = vec![0.0; forward.len()];
        for phase_index in 0..up {
            let source = &forward[phase_index * taps_per_phase..(phase_index + 1) * taps_per_phase];
            let target = &mut coefficients_reversed
                [phase_index * taps_per_phase..(phase_index + 1) * taps_per_phase];
            for (index, &value) in source.iter().rev().enumerate() {
                target[index] = value;
            }
        }

        // `next_output = floor(total_input * up / down)` can map back to an
        // input base just before the next chunk boundary. Retain that maximum
        // rational lag in addition to the FIR's ordinary `taps - 1` history.
        let maximum_base_lag = (down - 1).div_ceil(up);
        let history_head_frames = (taps_per_phase - 1).checked_add(maximum_base_lag).ok_or(
            BackendInitError::StorageOverflow {
                buffer: "nonlinear history",
            },
        )?;
        let history_stride = history_head_frames.checked_add(chunk_frames).ok_or(
            BackendInitError::StorageOverflow {
                buffer: "nonlinear history",
            },
        )?;
        let history_len =
            history_stride
                .checked_mul(channels)
                .ok_or(BackendInitError::StorageOverflow {
                    buffer: "nonlinear history",
                })?;
        Ok(Self {
            channels,
            up,
            down,
            taps_per_phase,
            coefficients_reversed,
            history: vec![0.0; history_len],
            history_head_frames,
            history_stride,
            chunk_frames,
            total_input: 0,
            next_output: 0,
            latency_frames,
            finish_extension_frames,
            stereo_dot_kernel: select_stereo_dot_kernel(),
        })
    }

    pub(super) fn output_frames_max(&self) -> usize {
        (self.chunk_frames * self.up).div_ceil(self.down) + 2
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
        let expected_max = (input_frames * self.up).div_ceil(self.down) + 1;
        if output_capacity < expected_max {
            return Err("nonlinear backend output stage is too small".into());
        }

        let mut consumed = 0usize;
        let mut produced = 0usize;
        while consumed < input_frames {
            let take = self.chunk_frames.min(input_frames - consumed);
            produced += self.run_sub_chunk(
                &input[consumed * self.channels..(consumed + take) * self.channels],
                &mut output[produced * self.channels..],
                take,
            )?;
            consumed += take;
        }
        Ok((input_frames, produced))
    }

    /// Consume `take <= chunk_frames` interleaved frames, writing every
    /// authorized output frame at the start of `output`.
    fn run_sub_chunk(
        &mut self,
        input: &[f64],
        output: &mut [f64],
        take: usize,
    ) -> Result<usize, BackendProcessError> {
        let taps = self.taps_per_phase;
        let chunk_start = self.total_input;
        // Deinterleave the chunk behind the retained history head.
        for channel in 0..self.channels {
            let base = channel * self.history_stride + self.history_head_frames;
            for frame in 0..take {
                self.history[base + frame] = input[frame * self.channels + channel];
            }
        }
        self.total_input += take as u64;

        let target_output =
            ((self.total_input as u128 * self.up as u128) / self.down as u128) as u64;
        let mut produced = 0usize;
        while self.next_output < target_output {
            if (produced + 1) * self.channels > output.len() {
                return Err("nonlinear backend returned too much output".into());
            }
            let q = self.next_output as u128 * self.down as u128;
            let base = (q / self.up as u128) as u64;
            let phase = (q % self.up as u128) as usize;
            if base >= self.total_input {
                return Err("nonlinear backend requested future input history".into());
            }
            let window_origin = self.history_head_frames - (taps - 1);
            let start = if base >= chunk_start {
                let offset = usize::try_from(base - chunk_start)
                    .map_err(|_| "nonlinear backend history offset overflow")?;
                window_origin
                    .checked_add(offset)
                    .ok_or("nonlinear backend history offset overflow")?
            } else {
                let lag = usize::try_from(chunk_start - base)
                    .map_err(|_| "nonlinear backend history offset overflow")?;
                window_origin
                    .checked_sub(lag)
                    .ok_or("nonlinear backend history window underrun")?
            };
            if start
                .checked_add(taps)
                .is_none_or(|end| end > self.history_head_frames + take)
            {
                return Err("nonlinear backend history window overrun".into());
            }
            let coefficients = &self.coefficients_reversed[phase * taps..(phase + 1) * taps];
            let output_start = produced * self.channels;
            if self.channels == 2 {
                let (left_history, right_history) = self.history.split_at(self.history_stride);
                let (left, right) = (self.stereo_dot_kernel)(
                    coefficients,
                    &left_history[start..start + taps],
                    &right_history[start..start + taps],
                );
                output[output_start] = left;
                output[output_start + 1] = right;
            } else {
                for channel in 0..self.channels {
                    let history = &self.history[channel * self.history_stride + start..][..taps];
                    output[output_start + channel] = dot_contiguous(coefficients, history);
                }
            }
            produced += 1;
            self.next_output += 1;
        }

        // Shift the newest retained frames back to the history head.
        for channel in 0..self.channels {
            let base = channel * self.history_stride;
            self.history
                .copy_within(base + take..base + take + self.history_head_frames, base);
        }
        Ok(produced)
    }

    pub(super) fn reset(&mut self) {
        self.history.fill(0.0);
        self.total_input = 0;
        self.next_output = 0;
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
    fn contiguous_output_matches_polyphase_oracle_within_1e_minus_9() {
        for (from_rate, to_rate) in [
            (44_100_u32, 48_000_u32),
            (48_000, 44_100),
            (44_100, 32_000),
            (44_100, 96_000),
        ] {
            for quality in [
                ResampleQuality::Standard,
                ResampleQuality::High,
                ResampleQuality::UltraHigh,
            ] {
                for phase in [PhaseResponse::Minimum, PhaseResponse::Maximum] {
                    let channels = 2usize;
                    let input = signal(3 * CHUNK + 311, channels);
                    let mut contiguous = ContiguousPolyphaseResampler::new(
                        from_rate, to_rate, phase, quality, channels, CHUNK,
                    )
                    .unwrap();
                    let mut oracle = PolyphaseResampler::new(
                        from_rate, to_rate, phase, quality, channels, CHUNK,
                    )
                    .unwrap();

                    let contiguous_max = contiguous.output_frames_max();
                    let contiguous_out = render_engine_chunks(
                        &mut |input, output| contiguous.process_chunk(input, output),
                        contiguous_max,
                        &input,
                        channels,
                        4,
                    );
                    let oracle_max = oracle.output_frames_max();
                    let oracle_out = render_engine_chunks(
                        &mut |input, output| oracle.process_chunk(input, output),
                        oracle_max,
                        &input,
                        channels,
                        4,
                    );

                    assert_eq!(contiguous_out.len(), oracle_out.len());
                    assert!(contiguous_out.len() > 2 * CHUNK * channels);
                    let mut max_error = 0.0_f64;
                    for index in 0..contiguous_out.len() {
                        max_error =
                            max_error.max((contiguous_out[index] - oracle_out[index]).abs());
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
    fn contiguous_mono_matches_stereo_channels_exactly() {
        // The stereo shared-load kernel and the generic 4-accumulator kernel
        // use the same accumulation order, so a mono stream must be bit-equal
        // to either stereo channel fed the same samples.
        let frames = 2 * CHUNK + 199;
        let mono_input: Vec<f64> = signal(frames, 1);
        let stereo_input: Vec<f64> = mono_input
            .iter()
            .flat_map(|&sample| [sample, sample * -0.5])
            .collect();
        let mut mono = ContiguousPolyphaseResampler::new(
            44_100,
            48_000,
            PhaseResponse::Minimum,
            ResampleQuality::High,
            1,
            CHUNK,
        )
        .unwrap();
        let mut stereo = ContiguousPolyphaseResampler::new(
            44_100,
            48_000,
            PhaseResponse::Minimum,
            ResampleQuality::High,
            2,
            CHUNK,
        )
        .unwrap();
        let mono_max = mono.output_frames_max();
        let mono_out = render_engine_chunks(
            &mut |input, output| mono.process_chunk(input, output),
            mono_max,
            &mono_input,
            1,
            2,
        );
        let stereo_max = stereo.output_frames_max();
        let stereo_out = render_engine_chunks(
            &mut |input, output| stereo.process_chunk(input, output),
            stereo_max,
            &stereo_input,
            2,
            2,
        );
        assert_eq!(mono_out.len() * 2, stereo_out.len());
        for (index, sample) in mono_out.iter().enumerate() {
            assert_eq!(
                sample.to_bits(),
                stereo_out[index * 2].to_bits(),
                "mono/stereo kernel diverged at frame {index}"
            );
        }
    }

    #[test]
    fn contiguous_timing_metadata_matches_polyphase_formulas() {
        for (from_rate, to_rate) in [(44_100_u32, 48_000_u32), (48_000, 44_100)] {
            for phase in [PhaseResponse::Minimum, PhaseResponse::Maximum] {
                let contiguous = ContiguousPolyphaseResampler::new(
                    from_rate,
                    to_rate,
                    phase,
                    ResampleQuality::High,
                    1,
                    CHUNK,
                )
                .unwrap();
                let oracle = PolyphaseResampler::new(
                    from_rate,
                    to_rate,
                    phase,
                    ResampleQuality::High,
                    1,
                    CHUNK,
                )
                .unwrap();
                assert_eq!(contiguous.output_delay(), 0);
                assert_eq!(contiguous.latency_frames(), oracle.latency_frames());
                assert_eq!(
                    contiguous.finish_extension_frames(),
                    oracle.finish_extension_frames()
                );
            }
        }
    }

    #[test]
    fn contiguous_rejects_pathological_reduced_geometry() {
        let error = match ContiguousPolyphaseResampler::new(
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
        assert!(ContiguousPolyphaseResampler::new(
            44_100,
            48_000,
            PhaseResponse::Linear,
            ResampleQuality::High,
            1,
            CHUNK,
        )
        .is_err());
    }

    #[test]
    fn contiguous_reset_restores_a_fresh_stream() {
        let channels = 2usize;
        let input = signal(2 * CHUNK, channels);
        let mut engine = ContiguousPolyphaseResampler::new(
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
    fn contiguous_process_and_reset_are_allocation_free_after_setup() {
        let channels = 2usize;
        let mut engine = ContiguousPolyphaseResampler::new(
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

    #[test]
    fn selected_stereo_dot_matches_scalar_for_vector_and_remainder_lengths() {
        for len in [4, 13, 256, 513] {
            let coefficients: Vec<f64> = (0..len)
                .map(|index| (index as f64 * 0.037).sin() * 0.2)
                .collect();
            let left: Vec<f64> = (0..len).map(|index| index as f64 * 0.013 - 0.7).collect();
            let right: Vec<f64> = (0..len).map(|index| index as f64 * -0.019 + 0.4).collect();
            let expected = dot_contiguous_stereo_scalar(&coefficients, &left, &right);
            let actual = select_stereo_dot_kernel()(&coefficients, &left, &right);
            assert_eq!(expected.0.to_bits(), actual.0.to_bits(), "left len={len}");
            assert_eq!(expected.1.to_bits(), actual.1.to_bits(), "right len={len}");
        }
    }
}
