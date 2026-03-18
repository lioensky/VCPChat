//! FFT-based spectrum analyzer for visualization

use rustfft::{FftPlanner, num_complex::Complex};
use std::sync::Arc;

/// FFT-based spectrum analyzer for visualization
pub struct SpectrumAnalyzer {
    fft_size: usize,
    fft: Arc<dyn rustfft::Fft<f64>>,
    window: Vec<f64>,
    num_bins: usize,
}

impl SpectrumAnalyzer {
    pub fn new(fft_size: usize, num_bins: usize) -> Self {
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(fft_size);
        let window: Vec<f64> = (0..fft_size)
            .map(|i| 0.5 * (1.0 - (2.0 * std::f64::consts::PI * i as f64 / fft_size as f64).cos()))
            .collect();
        
        Self { fft_size, fft, window, num_bins }
    }
    
    pub fn analyze(&self, samples: &[f64], sample_rate: u32) -> Vec<f32> {
        if samples.len() < self.fft_size {
            return vec![0.0; self.num_bins];
        }
        let mut buffer: Vec<Complex<f64>> = samples[..self.fft_size]
            .iter()
            .zip(&self.window)
            .map(|(&s, &w)| Complex::new(s * w, 0.0))
            .collect();
        
        self.fft.process(&mut buffer);
        let magnitudes: Vec<f64> = buffer[1..self.fft_size / 2]
            .iter()
            .map(|c| c.norm() / self.fft_size as f64)
            .collect();
        
        self.log_bin(&magnitudes, sample_rate)
    }
    
    fn log_bin(&self, magnitudes: &[f64], sample_rate: u32) -> Vec<f32> {
        let mut result = vec![0.0f32; self.num_bins];
        let nyquist = sample_rate as f64 / 2.0;
        let min_freq = 20.0f64;
        let max_freq = nyquist;
        let log_min = min_freq.log10();
        let log_max = max_freq.log10();
        
        for (bin_idx, result_val) in result.iter_mut().enumerate() {
            let freq_low = 10.0_f64.powf(log_min + (log_max - log_min) * bin_idx as f64 / self.num_bins as f64);
            let freq_high = 10.0_f64.powf(log_min + (log_max - log_min) * (bin_idx + 1) as f64 / self.num_bins as f64);
            let freq_per_bin = nyquist / magnitudes.len() as f64;
            let idx_low = ((freq_low / freq_per_bin) as usize).clamp(0, magnitudes.len().saturating_sub(1));
            let idx_high = ((freq_high / freq_per_bin) as usize).clamp(idx_low + 1, magnitudes.len());
            
            if idx_high > idx_low {
                let sum: f64 = magnitudes[idx_low..idx_high].iter().map(|m| m * m).sum();
                let rms = (sum / (idx_high - idx_low) as f64).sqrt();
                let db = 20.0 * (rms + 1e-9).log10();
                *result_val = ((db + 90.0) / 90.0).clamp(0.0, 1.0) as f32;
            }
        }
        result
    }
}
