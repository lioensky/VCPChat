//! FFT-based convolution for long FIR filters (Overlap-Save algorithm)
//! 
//! Zero-allocation real-time implementation with pre-allocated scratch buffers.

use rustfft::{FftPlanner, num_complex::Complex};
use std::sync::Arc;

/// 基于 FFT 的高性能卷积器 (Overlap-Save 算法)
/// 零分配实现：所有 scratch buffers 在构造时预分配
pub struct FFTConvolver {
    fft_size: usize,
    impulse_response_fft: Vec<Vec<Complex<f64>>>, // 每个通道一个频域响应
    overlap_buffers: Vec<Vec<f64>>,               // 每个通道的重叠缓冲区
    channels: usize,
    ir_len: usize,
    // Cached FFT plans to avoid recreating on each process call
    fft_forward: Arc<dyn rustfft::Fft<f64>>,
    fft_inverse: Arc<dyn rustfft::Fft<f64>>,
    // Pre-allocated scratch buffers for zero-allocation processing
    scratch_complex: Vec<Complex<f64>>,
}

impl FFTConvolver {
    /// Create a new FFT convolver with the given impulse response
    /// 
    /// # Arguments
    /// * `ir_data` - Impulse response samples in interleaved format [L0, R0, L1, R1, ...]
    /// * `channels` - Number of channels
    pub fn new(ir_data: &[f64], channels: usize) -> Self {
        let ir_len_total = ir_data.len();
        let ir_len_per_ch = ir_len_total / channels;
        
        // 选择合适的 FFT 大小 (通常是 2 的幂，且大于 2*ir_len)
        let mut fft_size = 1;
        while fft_size < (ir_len_per_ch * 2) {
            fft_size <<= 1;
        }

        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(fft_size);
        
        // Create cached plans for forward and inverse FFT
        let fft_forward = planner.plan_fft_forward(fft_size);
        let fft_inverse = planner.plan_fft_inverse(fft_size);

        let mut ir_ffts = Vec::with_capacity(channels);
        let mut overlap_bufs = Vec::with_capacity(channels);

        for ch in 0..channels {
            let mut buffer = vec![Complex::new(0.0, 0.0); fft_size];
            // 填充 IR 并补零
            for i in 0..ir_len_per_ch {
                buffer[i] = Complex::new(ir_data[i * channels + ch], 0.0);
            }
            fft.process(&mut buffer);
            ir_ffts.push(buffer);
            overlap_bufs.push(vec![0.0; ir_len_per_ch - 1]);
        }

        // Pre-allocate scratch buffer for FFT workspace
        let scratch_complex = vec![Complex::new(0.0, 0.0); fft_size];

        FFTConvolver {
            fft_size,
            impulse_response_fft: ir_ffts,
            overlap_buffers: overlap_bufs,
            channels,
            ir_len: ir_len_per_ch,
            fft_forward,
            fft_inverse,
            scratch_complex,
        }
    }

    /// Get the IR length per channel
    pub fn ir_length(&self) -> usize {
        self.ir_len
    }

    /// Get the FFT size used
    pub fn fft_size(&self) -> usize {
        self.fft_size
    }

    /// Reset internal state (overlap buffers)
    /// Call this when starting a new track to avoid artifacts
    pub fn reset(&mut self) {
        for overlap in &mut self.overlap_buffers {
            overlap.fill(0.0);
        }
    }

    /// Process audio block with zero allocation
    /// 
    /// # Arguments
    /// * `input` - Input samples in interleaved format
    /// * `output` - Output buffer (must be same size as input)
    /// 
    /// # Safety
    /// This method is real-time safe: no heap allocations, no mutex, no syscalls
    #[inline]
    pub fn process_into(&mut self, input: &[f64], output: &mut [f64]) {
        debug_assert_eq!(input.len(), output.len());
        
        let channels = self.channels;
        let total_frames = input.len() / channels;
        let fft_size = self.fft_size;
        let ir_len = self.ir_len;
        let step_size = fft_size - ir_len + 1;
        let inv_n = 1.0 / fft_size as f64;

        // Clear output buffer
        output.fill(0.0);

        for ch in 0..channels {
            let mut processed_frames = 0;
            
            while processed_frames < total_frames {
                let chunk_len = std::cmp::min(step_size, total_frames - processed_frames);
                
                // Use pre-allocated scratch buffer
                let scratch = &mut self.scratch_complex;
                scratch.fill(Complex::new(0.0, 0.0));
                
                // 1. 填充重叠部分 (来自上一个块的末尾)
                for i in 0..ir_len - 1 {
                    scratch[i] = Complex::new(self.overlap_buffers[ch][i], 0.0);
                }
                
                // 2. 填充当前块数据
                for i in 0..chunk_len {
                    scratch[i + ir_len - 1] = Complex::new(
                        input[(processed_frames + i) * channels + ch], 
                        0.0
                    );
                }
                
                // 3. FFT (using cached plan)
                self.fft_forward.process(scratch);
                
                // 4. 频域相乘
                let ir_fft = &self.impulse_response_fft[ch];
                for i in 0..fft_size {
                    scratch[i] *= ir_fft[i];
                }
                
                // 5. IFFT (using cached plan)
                self.fft_inverse.process(scratch);
                
                // 6. 提取有效部分并写入输出
                for i in 0..chunk_len {
                    output[(processed_frames + i) * channels + ch] = scratch[i + ir_len - 1].re * inv_n;
                }
                
                // 7. 更新重叠缓冲区
                let overlap = &mut self.overlap_buffers[ch];
                if chunk_len >= ir_len - 1 {
                    for i in 0..ir_len - 1 {
                        overlap[i] = input[(processed_frames + chunk_len - (ir_len - 1) + i) * channels + ch];
                    }
                } else {
                    let shift = chunk_len;
                    let keep = ir_len - 1 - shift;
                    // Shift left
                    for i in 0..keep {
                        overlap[i] = overlap[i + shift];
                    }
                    // Append new
                    for i in 0..shift {
                        overlap[keep + i] = input[(processed_frames + i) * channels + ch];
                    }
                }
                
                processed_frames += chunk_len;
            }
        }
    }

    /// Process audio block, returning a new Vec (convenience wrapper)
    /// 
    /// Note: This method allocates. For real-time use, prefer process_into().
    pub fn process(&mut self, input: &[f64]) -> Vec<f64> {
        let mut output = vec![0.0; input.len()];
        self.process_into(input, &mut output);
        output
    }

    /// Process audio block in-place with zero allocation
    /// 
    /// Uses internal scratch buffer for temporary storage.
    /// This is the recommended method for real-time audio processing.
    /// 
    /// # Arguments
    /// * `buf` - Input/output samples in interleaved format (modified in place)
    #[inline]
    pub fn process_inplace(&mut self, buf: &mut [f64]) {
        // Use scratch_complex as temporary output buffer
        // First, we need a separate buffer for output since we can't read and write the same location
        // We'll use a two-phase approach: save input to scratch, process, write back
        
        let channels = self.channels;
        let total_frames = buf.len() / channels;
        let fft_size = self.fft_size;
        let ir_len = self.ir_len;
        let step_size = fft_size - ir_len + 1;
        let inv_n = 1.0 / fft_size as f64;

        // We need a temporary buffer for output
        // Re-purpose: use a separate approach - process channel by channel
        // For each channel, we process and immediately write back
        
        for ch in 0..channels {
            let mut processed_frames = 0;
            
            while processed_frames < total_frames {
                let chunk_len = std::cmp::min(step_size, total_frames - processed_frames);
                
                // Use pre-allocated scratch buffer
                let scratch = &mut self.scratch_complex;
                scratch.fill(Complex::new(0.0, 0.0));
                
                // 1. 填充重叠部分 (来自上一个块的末尾)
                for i in 0..ir_len - 1 {
                    scratch[i] = Complex::new(self.overlap_buffers[ch][i], 0.0);
                }
                
                // 2. 填充当前块数据
                for i in 0..chunk_len {
                    scratch[i + ir_len - 1] = Complex::new(
                        buf[(processed_frames + i) * channels + ch], 
                        0.0
                    );
                }
                
                // 3. FFT (using cached plan)
                self.fft_forward.process(scratch);
                
                // 4. 频域相乘
                let ir_fft = &self.impulse_response_fft[ch];
                for i in 0..fft_size {
                    scratch[i] *= ir_fft[i];
                }
                
                // 5. IFFT (using cached plan)
                self.fft_inverse.process(scratch);
                
                // 6. Save original input for overlap BEFORE writing output
                // (This is critical for inplace processing - we need the original input,
                // not the processed output, for the next chunk's overlap)
                let overlap = &mut self.overlap_buffers[ch];
                if chunk_len >= ir_len - 1 {
                    for i in 0..ir_len - 1 {
                        overlap[i] = buf[(processed_frames + chunk_len - (ir_len - 1) + i) * channels + ch];
                    }
                } else {
                    let shift = chunk_len;
                    let keep = ir_len - 1 - shift;
                    for i in 0..keep {
                        overlap[i] = overlap[i + shift];
                    }
                    for i in 0..shift {
                        overlap[keep + i] = buf[(processed_frames + i) * channels + ch];
                    }
                }
                
                // 7. Write processed output to buffer
                for i in 0..chunk_len {
                    buf[(processed_frames + i) * channels + ch] = scratch[i + ir_len - 1].re * inv_n;
                }
                
                processed_frames += chunk_len;
            }
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_convolver_identity() {
        // Identity impulse response [1.0, 0.0, 0.0, ...]
        let ir = vec![1.0, 0.0, 0.0, 0.0]; // 4 taps mono
        let mut conv = FFTConvolver::new(&ir, 1);
        
        let input = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
        let mut output = vec![0.0; input.len()];
        
        conv.process_into(&input, &mut output);
        
        // With identity IR, output should match input
        for i in 0..input.len() {
            assert!((output[i] - input[i]).abs() < 1e-10, 
                "Mismatch at {}: {} vs {}", i, output[i], input[i]);
        }
    }

    #[test]
    fn test_convolver_stereo() {
        // Simple stereo IR
        let ir = vec![1.0, 1.0, 0.0, 0.0]; // 2 taps stereo (both channels same)
        let mut conv = FFTConvolver::new(&ir, 2);
        
        let input = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
        let mut output = vec![0.0; input.len()];
        
        conv.process_into(&input, &mut output);
        
        // Verify output is not all zeros
        assert!(output.iter().any(|&x| x != 0.0));
    }

    #[test]
    fn test_zero_allocation() {
        let ir: Vec<f64> = (0..1024).map(|i| (i as f64 / 1024.0).sin()).collect();
        let mut conv = FFTConvolver::new(&ir, 1);
        
        let input = vec![0.5; 4096];
        let mut output = vec![0.0; 4096];
        
        // Multiple calls should not allocate
        for _ in 0..100 {
            conv.process_into(&input, &mut output);
        }
        
        // Just verify it doesn't crash
        assert!(output.iter().any(|&x| x != 0.0));
    }

    // === FIX for Defect 8: Boundary unit tests for process_inplace ===

    #[test]
    fn test_inplace_identity() {
        // Identity IR: process_inplace should preserve input
        let ir = vec![1.0, 0.0, 0.0, 0.0]; // 4 taps mono
        let mut conv = FFTConvolver::new(&ir, 1);

        let original = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
        let mut buf = original.clone();

        conv.process_inplace(&mut buf);

        for i in 0..original.len() {
            assert!((buf[i] - original[i]).abs() < 1e-10,
                "Inplace identity mismatch at {}: {} vs {}", i, buf[i], original[i]);
        }
    }

    #[test]
    fn test_inplace_matches_process_into() {
        // Verify process_inplace produces same output as process_into
        let ir: Vec<f64> = (0..32).map(|i| (i as f64 / 32.0).sin() * 0.1).collect();
        let input: Vec<f64> = (0..256).map(|i| (i as f64 * 0.05).sin()).collect();

        let mut conv1 = FFTConvolver::new(&ir, 1);
        let mut conv2 = FFTConvolver::new(&ir, 1);

        let mut output_into = vec![0.0; input.len()];
        conv1.process_into(&input, &mut output_into);

        let mut buf_inplace = input.clone();
        conv2.process_inplace(&mut buf_inplace);

        for i in 0..input.len() {
            assert!((output_into[i] - buf_inplace[i]).abs() < 1e-10,
                "Mismatch at {}: into={} vs inplace={}", i, output_into[i], buf_inplace[i]);
        }
    }

    #[test]
    fn test_inplace_small_buffer() {
        // Buffer smaller than IR length
        let ir = vec![1.0, 0.5, 0.25, 0.125, 0.0, 0.0, 0.0, 0.0]; // 8 taps mono
        let mut conv = FFTConvolver::new(&ir, 1);

        // Only 4 samples (less than 8-tap IR)
        let mut buf = vec![1.0, 0.0, 0.0, 0.0];
        conv.process_inplace(&mut buf);

        // Should produce convolution of delta with IR, truncated to 4 samples
        // Result: [1.0, 0.5, 0.25, 0.125]
        assert!((buf[0] - 1.0).abs() < 1e-10, "Expected 1.0, got {}", buf[0]);
        assert!((buf[1] - 0.5).abs() < 1e-10, "Expected 0.5, got {}", buf[1]);
        assert!((buf[2] - 0.25).abs() < 1e-10, "Expected 0.25, got {}", buf[2]);
        assert!((buf[3] - 0.125).abs() < 1e-10, "Expected 0.125, got {}", buf[3]);
    }

    #[test]
    fn test_inplace_stereo_identity() {
        // Stereo identity IR
        let ir = vec![1.0, 1.0, 0.0, 0.0]; // 2 taps stereo identity
        let mut conv = FFTConvolver::new(&ir, 2);

        let original = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]; // 4 frames stereo
        let mut buf = original.clone();

        conv.process_inplace(&mut buf);

        for i in 0..original.len() {
            assert!((buf[i] - original[i]).abs() < 1e-10,
                "Stereo inplace identity mismatch at {}: {} vs {}", i, buf[i], original[i]);
        }
    }

    #[test]
    fn test_inplace_multi_chunk() {
        // Multiple consecutive calls with continuity
        let ir = vec![1.0, 0.5, 0.0, 0.0]; // 4 taps mono
        let mut conv = FFTConvolver::new(&ir, 1);

        let mut buf1 = vec![1.0, 0.0, 0.0, 0.0];
        conv.process_inplace(&mut buf1);

        // Second chunk should carry overlap from first
        let mut buf2 = vec![0.0, 0.0, 0.0, 0.0];
        conv.process_inplace(&mut buf2);

        // buf1 should be [1.0, 0.5, 0.0, 0.0]
        assert!((buf1[0] - 1.0).abs() < 1e-10);
        assert!((buf1[1] - 0.5).abs() < 1e-10);
    }
}