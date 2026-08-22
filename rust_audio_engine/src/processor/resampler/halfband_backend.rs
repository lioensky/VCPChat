//! Dedicated linear-phase 2:1 interpolation for the common High-quality path.
//!
//! A symmetric odd-length half-band FIR has every other coefficient equal to
//! zero (except the center). With zero-stuffed 2x interpolation that lets the
//! causal engine emit one delayed source sample directly and calculate the
//! companion interpolated sample from only the nonzero symmetric pairs.
//! Coefficients and history are allocated during setup; the process loop uses
//! only bounded reads and writes to that state.

use std::f64::consts::PI;

#[cfg(target_arch = "x86")]
use std::arch::x86::{
    __m256d, _mm256_add_pd, _mm256_fmadd_pd, _mm256_loadu_pd, _mm256_set1_pd, _mm256_storeu_pd,
};
#[cfg(target_arch = "x86_64")]
use std::arch::x86_64::{
    __m256d, _mm256_add_pd, _mm256_fmadd_pd, _mm256_loadu_pd, _mm256_set1_pd, _mm256_storeu_pd,
};

use super::{BackendInitError, BackendProcessError};
use crate::processor::fir_design::modified_bessel_i0;

/// Odd length keeps the half-band center on an exact output frame. A 127-tap
/// Kaiser design is the smallest power-of-two-history candidate that keeps the
/// 0-20 kHz band flat while rejecting the 28-48 kHz interpolation image below
/// the High-quality floor.
const TAPS: usize = 127;
const GROUP_DELAY_FRAMES: usize = (TAPS - 1) / 2;
const HISTORY_FRAMES: usize = TAPS.div_ceil(2);
const HISTORY_PREFIX_FRAMES: usize = HISTORY_FRAMES - 1;
const COEFFICIENT_PAIRS: usize = HISTORY_FRAMES / 2;
const DIRECT_DELAY_FRAMES: usize = (GROUP_DELAY_FRAMES - 1) / 2;
const KAISER_BETA: f64 = 14.0;

type AccumulateKernel = fn(&mut [f64], &[f64], &[f64], f64);

pub(super) struct Halfband2xResampler {
    channels: usize,
    chunk_frames: usize,
    /// Coefficients for causal even-index output samples, paired symmetrically.
    even_coefficients: Box<[f64]>,
    /// The half-band center coefficient used by the delayed direct phase.
    center_gain: f64,
    /// Per-channel source history followed by one fixed input chunk.
    channel_input: Vec<f64>,
    /// Per-channel contiguous even-phase output for blockwise FIR evaluation.
    even_stage: Vec<f64>,
    /// Selected during setup; the callback never performs feature detection.
    accumulate_kernel: AccumulateKernel,
}

impl Halfband2xResampler {
    pub(super) fn new(channels: usize, chunk_frames: usize) -> Result<Self, BackendInitError> {
        if channels == 0 {
            return Err(BackendInitError::ZeroChannels);
        }
        if chunk_frames == 0 {
            return Err(BackendInitError::InvalidGeometry {
                backend: "half-band",
            });
        }

        let (even_coefficients, center_gain) = design_coefficients();
        let input_span_frames = HISTORY_PREFIX_FRAMES.checked_add(chunk_frames).ok_or(
            BackendInitError::StorageOverflow {
                buffer: "half-band input span",
            },
        )?;
        let input_samples =
            input_span_frames
                .checked_mul(channels)
                .ok_or(BackendInitError::StorageOverflow {
                    buffer: "half-band input",
                })?;
        let stage_samples =
            chunk_frames
                .checked_mul(channels)
                .ok_or(BackendInitError::StorageOverflow {
                    buffer: "half-band output",
                })?;
        Ok(Self {
            channels,
            chunk_frames,
            even_coefficients,
            center_gain,
            channel_input: vec![0.0; input_samples],
            even_stage: vec![0.0; stage_samples],
            accumulate_kernel: select_accumulate_kernel(),
        })
    }

    pub(super) fn output_frames_max(&self) -> usize {
        self.chunk_frames.saturating_mul(2)
    }

    pub(super) fn output_delay(&self) -> usize {
        GROUP_DELAY_FRAMES
    }

    pub(super) fn process_chunk(
        &mut self,
        input: &[f64],
        output: &mut [f64],
    ) -> Result<(usize, usize), BackendProcessError> {
        if !input.len().is_multiple_of(self.channels) || !output.len().is_multiple_of(self.channels)
        {
            return Err("half-band backend received an incomplete frame".into());
        }
        let input_frames = input.len() / self.channels;
        let output_capacity_frames = output.len() / self.channels;
        if input_frames != self.chunk_frames {
            return Err("half-band backend received an unexpected input chunk".into());
        }
        let output_frames = input_frames
            .checked_mul(2)
            .ok_or("half-band backend output frame overflow")?;
        if output_capacity_frames < output_frames {
            return Err("half-band backend output stage is too small".into());
        }

        let input_span_frames = HISTORY_PREFIX_FRAMES + self.chunk_frames;
        for channel in 0..self.channels {
            let input_base = channel * input_span_frames;
            for (frame, input_frame) in input.chunks_exact(self.channels).enumerate() {
                self.channel_input[input_base + HISTORY_PREFIX_FRAMES + frame] =
                    input_frame[channel];
            }

            let even_base = channel * self.chunk_frames;
            let even_output = &mut self.even_stage[even_base..even_base + self.chunk_frames];
            even_output.fill(0.0);
            for (pair, &coefficient) in self.even_coefficients.iter().enumerate() {
                let recent_start = input_base + HISTORY_PREFIX_FRAMES - pair;
                let older_start = input_base + HISTORY_PREFIX_FRAMES - (HISTORY_FRAMES - 1 - pair);
                let recent = &self.channel_input[recent_start..recent_start + self.chunk_frames];
                let older = &self.channel_input[older_start..older_start + self.chunk_frames];
                (self.accumulate_kernel)(even_output, recent, older, coefficient);
            }

            let direct_start = input_base + HISTORY_PREFIX_FRAMES - DIRECT_DELAY_FRAMES;
            let direct = &self.channel_input[direct_start..direct_start + self.chunk_frames];
            for frame in 0..self.chunk_frames {
                let even_start = frame * 2 * self.channels + channel;
                output[even_start] = even_output[frame];
                output[even_start + self.channels] = self.center_gain * direct[frame];
            }

            let history_source = input_base + self.chunk_frames;
            self.channel_input.copy_within(
                history_source..history_source + HISTORY_PREFIX_FRAMES,
                input_base,
            );
        }

        Ok((input_frames, output_frames))
    }

    pub(super) fn reset(&mut self) {
        self.channel_input.fill(0.0);
        self.even_stage.fill(0.0);
    }
}

fn select_accumulate_kernel() -> AccumulateKernel {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    if std::arch::is_x86_feature_detected!("avx2") && std::arch::is_x86_feature_detected!("fma") {
        return accumulate_block_avx2;
    }
    accumulate_block_scalar
}

#[inline]
fn accumulate_block_scalar(output: &mut [f64], recent: &[f64], older: &[f64], coefficient: f64) {
    debug_assert_eq!(output.len(), recent.len());
    debug_assert_eq!(output.len(), older.len());
    for ((output_sample, &recent), &older) in output.iter_mut().zip(recent).zip(older) {
        *output_sample = coefficient.mul_add(recent + older, *output_sample);
    }
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
fn accumulate_block_avx2(output: &mut [f64], recent: &[f64], older: &[f64], coefficient: f64) {
    debug_assert_eq!(output.len(), recent.len());
    debug_assert_eq!(output.len(), older.len());
    // SAFETY: this wrapper is selected only after setup-time AVX2+FMA feature
    // detection, and the three slices have identical validated lengths.
    unsafe { accumulate_block_avx2_inner(output, recent, older, coefficient) }
}

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
#[target_feature(enable = "avx2,fma")]
unsafe fn accumulate_block_avx2_inner(
    output: &mut [f64],
    recent: &[f64],
    older: &[f64],
    coefficient: f64,
) {
    let coefficient_vector: __m256d = _mm256_set1_pd(coefficient);
    let vectorized_len = output.len() & !3;
    let mut index = 0;
    while index < vectorized_len {
        // SAFETY: `index..index + 4` stays inside all equal-length slices, and
        // the unaligned AVX loads/stores accept arbitrary f64 alignment.
        unsafe {
            let output_values = _mm256_loadu_pd(output.as_ptr().add(index));
            let recent_values = _mm256_loadu_pd(recent.as_ptr().add(index));
            let older_values = _mm256_loadu_pd(older.as_ptr().add(index));
            let pair_sum = _mm256_add_pd(recent_values, older_values);
            let accumulated = _mm256_fmadd_pd(coefficient_vector, pair_sum, output_values);
            _mm256_storeu_pd(output.as_mut_ptr().add(index), accumulated);
        }
        index += 4;
    }
    while index < output.len() {
        output[index] = coefficient.mul_add(recent[index] + older[index], output[index]);
        index += 1;
    }
}

fn design_coefficients() -> (Box<[f64]>, f64) {
    let kernel = design_kernel();
    let even_coefficients = (0..COEFFICIENT_PAIRS)
        .map(|pair| kernel[pair * 2])
        .collect::<Vec<_>>()
        .into_boxed_slice();
    (even_coefficients, kernel[GROUP_DELAY_FRAMES])
}

fn design_kernel() -> Vec<f64> {
    let center = GROUP_DELAY_FRAMES as isize;
    let denominator = modified_bessel_i0(KAISER_BETA);
    let mut kernel = Vec::with_capacity(TAPS);

    for index in 0..TAPS {
        let distance = index as isize - center;
        // A gain-two ideal half-band response: all even offsets from the
        // center are exactly zero, while the center retains unity gain.
        let ideal = if distance == 0 {
            1.0
        } else if distance % 2 == 0 {
            0.0
        } else {
            let distance = distance as f64;
            2.0 * (PI * distance * 0.5).sin() / (PI * distance)
        };
        let position = (2.0 * index as f64 / (TAPS - 1) as f64) - 1.0;
        let window = modified_bessel_i0(KAISER_BETA * (1.0 - position * position).max(0.0).sqrt())
            / denominator;
        kernel.push(ideal * window);
    }

    // Interpolation follows zero stuffing, so the completed low-pass response
    // needs a DC gain of two. Scale every tap together to retain symmetry and
    // the half-band zero pattern.
    let sum = kernel.iter().sum::<f64>();
    let scale = 2.0 / sum;
    for coefficient in &mut kernel {
        *coefficient *= scale;
    }
    kernel
}

#[cfg(test)]
mod tests {
    use super::*;

    fn magnitude_ratio(
        even_coefficients: &[f64],
        center_gain: f64,
        normalized_frequency: f64,
    ) -> f64 {
        let mut real =
            center_gain * (2.0 * PI * normalized_frequency * GROUP_DELAY_FRAMES as f64).cos();
        let mut imaginary =
            -center_gain * (2.0 * PI * normalized_frequency * GROUP_DELAY_FRAMES as f64).sin();
        for (pair, &coefficient) in even_coefficients.iter().enumerate() {
            let mirror = HISTORY_FRAMES - 1 - pair;
            for index in [pair, mirror] {
                let phase = 2.0 * PI * normalized_frequency * (index * 2) as f64;
                real += coefficient * phase.cos();
                imaginary -= coefficient * phase.sin();
            }
        }
        (real.hypot(imaginary) / 2.0).max(f64::MIN_POSITIVE)
    }

    #[test]
    fn coefficients_preserve_half_band_dc_gain_two() {
        let (even, center) = design_coefficients();
        assert_eq!(even.len(), COEFFICIENT_PAIRS);
        let dc_gain = center + even.iter().sum::<f64>() * 2.0;
        assert!(
            (dc_gain - 2.0).abs() < 1.0e-12,
            "half-band DC gain was {dc_gain}"
        );
    }

    #[test]
    fn high_quality_filter_keeps_20khz_and_rejects_30khz_image() {
        let (even, center) = design_coefficients();
        let passband_db = 20.0 * magnitude_ratio(&even, center, 20_000.0 / 96_000.0).log10();
        let image_db = 20.0 * magnitude_ratio(&even, center, 30_000.0 / 96_000.0).log10();
        assert!(
            passband_db.abs() < 0.01,
            "20 kHz gain was {passband_db:.6} dB"
        );
        assert!(image_db < -120.0, "30 kHz image was {image_db:.3} dB");
    }

    #[test]
    fn processing_is_allocation_free_after_setup() {
        let mut resampler = Halfband2xResampler::new(2, 16).unwrap();
        let input = vec![0.25; 16 * 2];
        let mut output = vec![0.0; 16 * 2 * 2];
        assert_no_alloc::assert_no_alloc(|| {
            assert_eq!(resampler.process_chunk(&input, &mut output), Ok((16, 32)));
            resampler.reset();
        });
    }

    #[test]
    fn selected_block_accumulator_matches_scalar_for_vector_and_remainder_lengths() {
        for len in [4, 13, 1_024] {
            let recent: Vec<f64> = (0..len).map(|index| index as f64 * 0.031 - 0.4).collect();
            let older: Vec<f64> = (0..len).map(|index| index as f64 * -0.017 + 0.2).collect();
            let seed: Vec<f64> = (0..len).map(|index| index as f64 * 0.003).collect();
            let mut expected = seed.clone();
            let mut actual = seed;
            accumulate_block_scalar(&mut expected, &recent, &older, -0.137);
            select_accumulate_kernel()(&mut actual, &recent, &older, -0.137);
            for (index, (&expected, &actual)) in expected.iter().zip(&actual).enumerate() {
                assert_eq!(
                    expected.to_bits(),
                    actual.to_bits(),
                    "len={len} sample={index} expected={expected:?} actual={actual:?}"
                );
            }
        }
    }

    #[test]
    fn block_kernel_matches_full_zero_stuffed_convolution_across_chunks() {
        const CHANNELS: usize = 2;
        const CHUNK_FRAMES: usize = 73;
        const CHUNKS: usize = 3;
        let total_frames = CHUNK_FRAMES * CHUNKS;
        let input: Vec<f64> = (0..total_frames)
            .flat_map(|frame| {
                let phase = frame as f64 * 0.071;
                [phase.sin() * 0.4, phase.cos() * -0.25]
            })
            .collect();
        let kernel = design_kernel();
        let mut expected = vec![0.0; total_frames * 2 * CHANNELS];
        for output_frame in 0..total_frames * 2 {
            for (tap, &coefficient) in kernel.iter().enumerate().take(output_frame + 1) {
                let source_frame = output_frame - tap;
                if source_frame % 2 != 0 {
                    continue;
                }
                let source_frame = source_frame / 2;
                if source_frame >= total_frames {
                    continue;
                }
                for channel in 0..CHANNELS {
                    expected[output_frame * CHANNELS + channel] +=
                        coefficient * input[source_frame * CHANNELS + channel];
                }
            }
        }

        let mut actual = vec![0.0; expected.len()];
        let mut resampler = Halfband2xResampler::new(CHANNELS, CHUNK_FRAMES).unwrap();
        for chunk in 0..CHUNKS {
            let input_start = chunk * CHUNK_FRAMES * CHANNELS;
            let input_end = input_start + CHUNK_FRAMES * CHANNELS;
            let output_start = chunk * CHUNK_FRAMES * 2 * CHANNELS;
            let output_end = output_start + CHUNK_FRAMES * 2 * CHANNELS;
            assert_eq!(
                resampler.process_chunk(
                    &input[input_start..input_end],
                    &mut actual[output_start..output_end],
                ),
                Ok((CHUNK_FRAMES, CHUNK_FRAMES * 2))
            );
        }

        for (index, (&expected, &actual)) in expected.iter().zip(&actual).enumerate() {
            let delta = (expected - actual).abs();
            assert!(
                delta <= 2.0e-15,
                "sample {index} mismatch: expected={expected:.16e} actual={actual:.16e} delta={delta:.3e}"
            );
        }
    }
}
