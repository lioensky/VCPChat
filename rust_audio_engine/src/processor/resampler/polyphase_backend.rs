//! Setup-designed nonlinear-phase rational resampling.
//!
//! Rubato's public engines intentionally expose only linear-phase kernels. This
//! module supplies the missing phase responses with a causal polyphase FIR:
//! a linear low-pass prototype is spectrally factorised into a minimum-phase
//! kernel, and maximum phase is its time reversal. Coefficients are immutable
//! after construction; processing uses only a bounded interleaved history ring.

use std::f64::consts::PI;

use rustfft::num_complex::Complex;

use super::BackendInitError;
#[cfg(test)]
use super::BackendProcessError;
#[cfg(test)]
use crate::config::PhaseResponse;
use crate::config::ResampleQuality;
use crate::processor::fir_design::{
    minimum_phase_from_log_magnitude, modified_bessel_i0, FirFftPlans,
};

pub(super) const MAX_REDUCED_RATE: usize = 1_024;
pub(super) const MAX_POLYPHASE_COEFFICIENTS: usize = 524_288;

#[cfg(test)]
pub(super) struct PolyphaseResampler {
    channels: usize,
    up: usize,
    down: usize,
    taps_per_phase: usize,
    coefficients: Vec<f64>,
    history: Vec<f64>,
    history_frames: usize,
    write_frame: usize,
    total_input: u64,
    next_output: u64,
    chunk_frames: usize,
    latency_frames: usize,
    finish_extension_frames: usize,
}

#[cfg(test)]
impl PolyphaseResampler {
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
                backend: "polyphase",
            });
        }
        if matches!(phase, PhaseResponse::Linear) {
            return Err(BackendInitError::NonlinearPhaseRequired {
                backend: "polyphase",
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

        let coefficients = polyphase_coefficients(&kernel, up, taps_per_phase);
        let latency_frames = phase_peak_latency_frames(&kernel, down);
        let finish_extension_frames = kernel_finish_extension_frames(kernel.len(), down);
        let history_frames = taps_per_phase
            .checked_add(down.div_ceil(up))
            .and_then(|frames| frames.checked_add(2))
            .ok_or(BackendInitError::StorageOverflow {
                buffer: "nonlinear history",
            })?;

        Ok(Self {
            channels,
            up,
            down,
            taps_per_phase,
            coefficients,
            history: vec![0.0; history_frames * channels],
            history_frames,
            write_frame: history_frames - 1,
            total_input: 0,
            next_output: 0,
            chunk_frames,
            latency_frames,
            finish_extension_frames,
        })
    }

    pub(super) fn output_frames_max(&self) -> usize {
        (self.chunk_frames * self.up).div_ceil(self.down) + 2
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

        let mut produced = 0usize;
        for input_frame in 0..input_frames {
            self.write_frame = (self.write_frame + 1) % self.history_frames;
            let history_start = self.write_frame * self.channels;
            let input_start = input_frame * self.channels;
            self.history[history_start..history_start + self.channels]
                .copy_from_slice(&input[input_start..input_start + self.channels]);
            self.total_input += 1;

            let target_output =
                ((self.total_input as u128 * self.up as u128) / self.down as u128) as u64;
            while self.next_output < target_output {
                if produced == output_capacity {
                    return Err("nonlinear backend returned too much output".into());
                }
                let q = self.next_output as u128 * self.down as u128;
                let base = (q / self.up as u128) as u64;
                let phase = (q % self.up as u128) as usize;
                let latest = self.total_input - 1;
                let age = (latest - base) as usize;
                let coefficient_start = phase * self.taps_per_phase;
                let output_start = produced * self.channels;
                for channel in 0..self.channels {
                    let mut sample = 0.0;
                    for tap in 0..self.taps_per_phase {
                        let history_age = age + tap;
                        let frame = (self.write_frame + self.history_frames - history_age)
                            % self.history_frames;
                        sample += self.coefficients[coefficient_start + tap]
                            * self.history[frame * self.channels + channel];
                    }
                    output[output_start + channel] = sample;
                }
                produced += 1;
                self.next_output += 1;
            }
        }

        Ok((input_frames, produced))
    }
}

pub(super) fn gcd(mut left: u32, mut right: u32) -> u32 {
    while right != 0 {
        (left, right) = (right, left % right);
    }
    left
}

pub(super) fn taps_per_phase(quality: ResampleQuality) -> usize {
    match quality {
        ResampleQuality::Low => 64,
        ResampleQuality::Standard => 128,
        ResampleQuality::High => 256,
        ResampleQuality::UltraHigh => 512,
    }
}

fn quality_rolloff(quality: ResampleQuality) -> f64 {
    match quality {
        ResampleQuality::Low => 0.90,
        ResampleQuality::Standard => 0.94,
        ResampleQuality::High => 0.96,
        ResampleQuality::UltraHigh => 0.98,
    }
}

fn quality_beta(quality: ResampleQuality) -> f64 {
    match quality {
        ResampleQuality::Low => 8.6,
        ResampleQuality::Standard => 11.0,
        ResampleQuality::High => 14.0,
        ResampleQuality::UltraHigh => 17.0,
    }
}

pub(super) fn design_linear_prototype(
    up: usize,
    down: usize,
    taps_per_phase: usize,
    quality: ResampleQuality,
) -> Vec<f64> {
    let length = up * taps_per_phase;
    let center = (length as f64 - 1.0) * 0.5;
    let cutoff = 0.5 * quality_rolloff(quality) / up.max(down) as f64;
    let beta = quality_beta(quality);
    let denominator = modified_bessel_i0(beta);
    let mut kernel = Vec::with_capacity(length);

    for index in 0..length {
        let distance = index as f64 - center;
        let sinc = if distance.abs() < 1.0e-12 {
            2.0 * cutoff
        } else {
            (2.0 * PI * cutoff * distance).sin() / (PI * distance)
        };
        let window_position = (2.0 * index as f64 / (length - 1) as f64) - 1.0;
        let window =
            modified_bessel_i0(beta * (1.0 - window_position * window_position).max(0.0).sqrt())
                / denominator;
        kernel.push(sinc * window);
    }

    normalize_kernel(&mut kernel);
    kernel
}

pub(super) fn minimum_phase_prototype(
    prototype: &[f64],
    plans: &mut FirFftPlans,
) -> Result<Vec<f64>, BackendInitError> {
    let mut fft_size = 1usize;
    let required = prototype
        .len()
        .checked_mul(4)
        .ok_or(BackendInitError::StorageOverflow {
            buffer: "nonlinear phase FFT",
        })?;
    while fft_size < required {
        fft_size = fft_size
            .checked_mul(2)
            .ok_or(BackendInitError::StorageOverflow {
                buffer: "nonlinear phase FFT",
            })?;
    }

    let mut spectrum = vec![Complex::new(0.0, 0.0); fft_size];
    spectrum[..prototype.len()]
        .iter_mut()
        .zip(prototype)
        .for_each(|(value, &sample)| value.re = sample);
    // Same cache the inner factorization uses, so this size is planned once for
    // both rather than once per planner.
    let fft = plans.forward(fft_size);
    fft.process(&mut spectrum);

    let mut log_magnitude = vec![0.0; fft_size];
    for (index, value) in spectrum.iter().enumerate() {
        log_magnitude[index] = value.norm().max(1.0e-14).ln();
    }
    let mut minimum = minimum_phase_from_log_magnitude(&log_magnitude, prototype.len(), plans);
    if minimum.iter().all(|sample| sample.abs() < 1.0e-15) {
        return Err(BackendInitError::EmptyMinimumPhaseFactor);
    }
    normalize_kernel(&mut minimum);
    Ok(minimum)
}

pub(super) fn polyphase_coefficients(kernel: &[f64], up: usize, taps_per_phase: usize) -> Vec<f64> {
    let mut coefficients = vec![0.0; up * taps_per_phase];
    for phase in 0..up {
        for tap in 0..taps_per_phase {
            if let Some(&sample) = kernel.get(phase + tap * up) {
                coefficients[phase * taps_per_phase + tap] = sample * up as f64;
            }
        }
    }
    coefficients
}

pub(super) fn normalize_kernel(kernel: &mut [f64]) {
    let sum = kernel.iter().sum::<f64>();
    if sum.abs() > 1.0e-15 {
        let scale = 1.0 / sum;
        for sample in kernel {
            *sample *= scale;
        }
    }
}

pub(super) fn phase_peak_latency_frames(kernel: &[f64], down: usize) -> usize {
    let peak = kernel
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| {
            left.abs()
                .partial_cmp(&right.abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(index, _)| index)
        .unwrap_or(0);
    (peak + down / 2) / down
}

pub(super) fn kernel_finish_extension_frames(kernel_len: usize, down: usize) -> usize {
    kernel_len.saturating_sub(1).div_ceil(down)
}

#[cfg(test)]
mod tests {
    use super::*;
    // The magnitude-spectrum helper below stays on rustfft's complex planner: it
    // is an independent cross-check of the designed kernels, so it deliberately
    // does not reuse the production plan cache.
    use rustfft::FftPlanner;

    fn magnitude_spectrum(kernel: &[f64], fft_size: usize) -> Vec<f64> {
        let mut spectrum = vec![Complex::new(0.0, 0.0); fft_size];
        spectrum[..kernel.len()]
            .iter_mut()
            .zip(kernel)
            .for_each(|(bin, &sample)| bin.re = sample);
        let mut planner = FftPlanner::new();
        planner.plan_fft_forward(fft_size).process(&mut spectrum);
        spectrum
            .into_iter()
            .take(fft_size / 2 + 1)
            .map(|bin| bin.norm())
            .collect()
    }

    fn energy_centroid(kernel: &[f64]) -> f64 {
        let energy = kernel.iter().map(|sample| sample * sample).sum::<f64>();
        kernel
            .iter()
            .enumerate()
            .map(|(index, sample)| index as f64 * sample * sample)
            .sum::<f64>()
            / energy
    }

    #[test]
    fn nonlinear_kernels_have_distinct_phase_energy_order() {
        let prototype = design_linear_prototype(1, 1, 128, ResampleQuality::High);
        let minimum = minimum_phase_prototype(&prototype, &mut FirFftPlans::new()).unwrap();
        let maximum: Vec<f64> = minimum.iter().copied().rev().collect();
        let linear_centroid = energy_centroid(&prototype);
        assert!(
            energy_centroid(&minimum) < linear_centroid,
            "minimum phase did not move energy earlier"
        );
        assert!(
            energy_centroid(&maximum) > linear_centroid,
            "maximum phase did not move energy later"
        );
        assert!(minimum
            .iter()
            .zip(maximum.iter().rev())
            .all(|(left, right)| (left - right).abs() < 1.0e-12));

        let reference_energy = prototype.iter().map(|sample| sample * sample).sum::<f64>();
        for (name, candidate) in [
            ("minimum", minimum.as_slice()),
            ("maximum", maximum.as_slice()),
        ] {
            let best_relative_mse = (0..prototype.len())
                .map(|shift| {
                    candidate
                        .iter()
                        .enumerate()
                        .map(|(index, sample)| {
                            let shifted_index = (index + prototype.len() - shift) % prototype.len();
                            (sample - prototype[shifted_index]).powi(2)
                        })
                        .sum::<f64>()
                        / reference_energy
                })
                .fold(f64::INFINITY, f64::min);
            assert!(
                best_relative_mse > 1.0e-6,
                "{name} phase was only a circular delay of linear: relative MSE {best_relative_mse:.3e}"
            );
        }

        fn response_magnitude(kernel: &[f64], normalized_frequency: f64) -> f64 {
            let phase = 2.0 * PI * normalized_frequency;
            kernel
                .iter()
                .enumerate()
                .fold(Complex::new(0.0, 0.0), |sum, (index, &sample)| {
                    sum + Complex::from_polar(sample, -phase * index as f64)
                })
                .norm()
        }

        for frequency in [0.0, 0.1, 0.25, 0.4] {
            let reference = response_magnitude(&prototype, frequency).max(1.0e-12);
            for candidate in [&minimum, &maximum] {
                let measured = response_magnitude(candidate, frequency).max(1.0e-12);
                let error_db = 20.0 * (measured / reference).abs().log10();
                assert!(
                    error_db.abs() < 0.25,
                    "phase factor changed magnitude at {frequency:.3}: {error_db:.3} dB"
                );
            }
        }
    }

    #[test]
    fn actual_ratio_nonlinear_kernels_preserve_dense_magnitude_response() {
        const UP: usize = 160;
        const DOWN: usize = 147;
        const INPUT_RATE: f64 = 44_100.0;
        const FFT_SIZE: usize = 1 << 17;

        let prototype = design_linear_prototype(UP, DOWN, 256, ResampleQuality::High);
        let minimum = minimum_phase_prototype(&prototype, &mut FirFftPlans::new()).unwrap();
        let maximum: Vec<f64> = minimum.iter().copied().rev().collect();
        let linear_magnitude = magnitude_spectrum(&prototype, FFT_SIZE);
        let minimum_magnitude = magnitude_spectrum(&minimum, FFT_SIZE);
        let maximum_magnitude = magnitude_spectrum(&maximum, FFT_SIZE);

        let passband_end = 20_000.0 / (INPUT_RATE * UP as f64);
        let passband_end_bin = (passband_end * FFT_SIZE as f64).floor() as usize;
        let mut worst_prototype_error_db = 0.0_f64;
        let mut worst_phase_pair_error_db = 0.0_f64;

        for bin in 0..=FFT_SIZE / 2 {
            let minimum_value = minimum_magnitude[bin].max(1.0e-15);
            let maximum_value = maximum_magnitude[bin].max(1.0e-15);
            // Below -200 dB relative to the normalized DC response, FFT
            // roundoff dominates the relative dB comparison.
            if minimum_value.max(maximum_value) >= 1.0e-10 {
                worst_phase_pair_error_db = worst_phase_pair_error_db
                    .max((20.0 * (minimum_value / maximum_value).log10()).abs());
            }
            if bin <= passband_end_bin {
                let reference = linear_magnitude[bin].max(1.0e-15);
                worst_prototype_error_db = worst_prototype_error_db
                    .max((20.0 * (minimum_value / reference).log10()).abs());
            }
        }

        assert!(
            worst_prototype_error_db < 0.25,
            "minimum-phase factor changed the 44.1->48 kHz passband by {worst_prototype_error_db:.6} dB"
        );
        assert!(
            worst_phase_pair_error_db < 0.001,
            "minimum/maximum dense-grid magnitude mismatch was {worst_phase_pair_error_db:.9} dB"
        );
    }

    #[test]
    fn finish_extension_covers_the_complete_actual_ratio_kernel() {
        let resampler = PolyphaseResampler::new(
            44_100,
            48_000,
            PhaseResponse::Maximum,
            ResampleQuality::High,
            1,
            1_024,
        )
        .unwrap();
        let kernel_len = resampler.up * resampler.taps_per_phase;
        assert_eq!(
            resampler.finish_extension_frames(),
            kernel_finish_extension_frames(kernel_len, resampler.down)
        );
        assert!(resampler.finish_extension_frames() > resampler.latency_frames());

        for total_input in 1_u64..=resampler.down as u64 * 2 {
            let last_supported_output = (((total_input - 1) as u128 * resampler.up as u128
                + (kernel_len - 1) as u128)
                / resampler.down as u128) as u64;
            let full_response_frames = last_supported_output + 1;
            let duration_frames = ((total_input as u128 * resampler.up as u128 * 2
                + resampler.down as u128)
                / (resampler.down as u128 * 2)) as u64;
            assert!(
                duration_frames + resampler.finish_extension_frames() as u64
                    >= full_response_frames,
                "finish extension truncated total_input={total_input}"
            );
        }
    }

    #[test]
    fn polyphase_process_is_duration_paced() {
        let mut resampler = PolyphaseResampler::new(
            44_100,
            48_000,
            PhaseResponse::Minimum,
            ResampleQuality::High,
            2,
            1_024,
        )
        .unwrap();
        let input = vec![0.0; 1_024 * 2];
        let mut output = vec![0.0; resampler.output_frames_max() * 2];
        let (consumed, produced) = resampler.process_chunk(&input, &mut output).unwrap();
        assert_eq!(consumed, 1_024);
        assert_eq!(produced, (1_024_u64 * 48_000 / 44_100) as usize);
    }
}
