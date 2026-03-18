//! High-quality resampling using SoX VHQ Polyphase implementation

use rayon::prelude::*;
use soxr::{Soxr, format::Mono, params::{QualitySpec, QualityRecipe, QualityFlags, Rolloff, RuntimeSpec}};
use crate::config::{PhaseResponse, ResampleQuality};

/// Error type for resampler operations
#[derive(Debug, Clone)]
pub enum ResamplerError {
    /// Soxr initialization failed (e.g., invalid sample rate combination)
    InitializationFailed(String),
    /// Processing failed
    ProcessFailed(String),
}

impl std::fmt::Display for ResamplerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResamplerError::InitializationFailed(msg) => write!(f, "Soxr initialization failed: {}", msg),
            ResamplerError::ProcessFailed(msg) => write!(f, "Resampling process failed: {}", msg),
        }
    }
}

impl std::error::Error for ResamplerError {}

/// High-quality resampler using SoX (VHQ Polyphase implementation)
pub struct Resampler {
    channels: usize,
    from_rate: u32,
    to_rate: u32,
}

/// Convert ResampleQuality enum to SoX QualityRecipe
/// FIX for Defect 30: Actually use different quality levels
/// Note: QualityRecipe has Low variant, plus high() and very_high() constructor functions
fn quality_to_recipe(quality: ResampleQuality) -> QualityRecipe {
    match quality {
        ResampleQuality::Low => QualityRecipe::Low,             // Fast, lower quality (enum variant)
        ResampleQuality::Standard => QualityRecipe::high(),     // High quality (constructor)
        ResampleQuality::High => QualityRecipe::high(),         // High quality (constructor)
        ResampleQuality::UltraHigh => QualityRecipe::very_high(), // VHQ, slowest (constructor)
    }
}

/// Create a QualitySpec with the given recipe and phase response
fn make_quality_spec(recipe: QualityRecipe, phase: PhaseResponse) -> QualitySpec {
    QualitySpec::configure(
        recipe,
        Rolloff::default(),
        QualityFlags::HighPrecisionClock,
    ).with_phase_response(phase.to_soxr_value())
}

impl Resampler {
    pub fn new(channels: usize, from_rate: u32, to_rate: u32) -> Self {
        Self { channels, from_rate, to_rate }
    }
    
    /// Resample audio data using SoX VHQ polyphase filter
    /// Input and output are interleaved f64 samples for Hi-Fi transparency
    /// Resample audio data using SoX VHQ polyphase filter
    /// 
    /// optimised for multi-channel parallelism:
    /// - De-interleaves channels
    /// - Processes each channel on a separate thread (Rayon)
    /// - Re-interleaves result
    /// This avoids phase discontinuities from time-chunking while maintaining high performance.
    /// 
    /// Returns Err if Soxr initialization fails (e.g., invalid sample rate combination).
    pub fn resample_parallel(&self, input: &[f64], phase: PhaseResponse, quality: ResampleQuality) -> Result<Vec<f64>, ResamplerError> {
        if self.from_rate == self.to_rate {
            return Ok(input.to_vec());
        }
        
        // Validate sample rates
        if self.from_rate == 0 || self.to_rate == 0 {
            return Err(ResamplerError::InitializationFailed(
                format!("Invalid sample rate: from_rate={}, to_rate={}", self.from_rate, self.to_rate)
            ));
        }

        // 1. De-interleave
        let frames = input.len() / self.channels;
        let mut plan_channels: Vec<Vec<f64>> = vec![Vec::with_capacity(frames); self.channels];
        for (i, sample) in input.iter().enumerate() {
            plan_channels[i % self.channels].push(*sample);
        }

        // 2. Process channels in parallel
        let resampled_channels: Result<Vec<Vec<f64>>, ResamplerError> = plan_channels
            .into_par_iter()
            .enumerate()
            .map(|(ch_idx, channel_data)| {
                // Configure SoX for this channel with phase response and quality
                // FIX for Defect 30: Use quality parameter instead of hardcoded very_high
                let quality_spec = make_quality_spec(quality_to_recipe(quality), phase);
                
                let runtime_spec = RuntimeSpec::new(1); // 1 channel per thread
                
                let mut soxr = Soxr::<Mono<f64>>::new_with_params(
                    self.from_rate as f64,
                    self.to_rate as f64,
                    quality_spec,
                    runtime_spec,
                ).map_err(|e| ResamplerError::InitializationFailed(
                    format!("Channel {}: {:?}", ch_idx, e)
                ))?;

                // Output estimation
                let expected_frames = (channel_data.len() as f64 * self.to_rate as f64 / self.from_rate as f64).ceil() as usize + 100;
                let mut channel_output = Vec::with_capacity(expected_frames);
                
                // Chunked processing to avoid massive single-pass overhead
                // 8192 frames is a good balance for cache usage
                let inner_chunk_size = 8192; 
                let mut output_scratch = vec![0.0; (inner_chunk_size as f64 * 1.5) as usize]; // Spare room for resampling ratio
                
                let total_chunks = channel_data.len() / inner_chunk_size + 1;
                
                // Log only for first channel to avoid spam
                if ch_idx == 0 {
                   log::info!("Starting resampling on thread. Total chunks: {}, Phase: {:?}", total_chunks, phase);
                }

                for (i, chunk) in channel_data.chunks(inner_chunk_size).enumerate() {
                    let processed = soxr.process(chunk, &mut output_scratch)
                        .map_err(|e| ResamplerError::ProcessFailed(
                            format!("Channel {} chunk {}: {:?}", ch_idx, i, e)
                        ))?;
                    
                    if processed.output_frames > 0 {
                        channel_output.extend_from_slice(&output_scratch[..processed.output_frames]);
                    }
                    
                    // Periodic log check (every ~10%)
                    if ch_idx == 0 && i > 0 && i % (total_chunks.max(10) / 10).max(1) == 0 {
                        log::debug!("Resampling progress: {}%", i * 100 / total_chunks);
                    }
                }
                
                // Flush the resampler (pass empty slice)
                let mut flush_scratch = vec![0.0; 4096];
                if let Ok(processed) = soxr.process(&[], &mut flush_scratch) {
                     if processed.output_frames > 0 {
                         channel_output.extend_from_slice(&flush_scratch[..processed.output_frames]);
                     }
                }
                
                Ok(channel_output)
            })
            .collect();
            
        let resampled_channels = resampled_channels?;
            
        // 3. Re-interleave
        if resampled_channels.is_empty() {
             return Ok(Vec::new());
        }
        
        let out_frames = resampled_channels[0].len();
        let mut final_output = Vec::with_capacity(out_frames * self.channels);
        
        for f in 0..out_frames {
            for ch in 0..self.channels {
                if f < resampled_channels[ch].len() {
                    final_output.push(resampled_channels[ch][f]);
                } else {
                    final_output.push(0.0);
                }
            }
        }
        
        Ok(final_output)
    }
}

/// Stateful streaming resampler that maintains SoX instances across chunks.
/// This is used by AudioPipeline for memory-efficient streaming resampling.
/// 
/// FIX for Defect 33: Pre-allocate all buffers to avoid heap allocation in process_chunk
pub struct StreamingResampler {
    soxr_instances: Vec<Soxr<Mono<f64>>>,
    channels: usize,
    from_rate: u32,
    to_rate: u32,
    phase: PhaseResponse,
    quality: ResampleQuality,
    /// Pre-allocated output scratch buffer (per channel, reused)
    output_scratch: Vec<f64>,
    /// Pre-allocated channel input buffers (Defect 33 fix)
    channel_inputs: Vec<Vec<f64>>,
    /// Pre-allocated channel output buffers (Defect 33 fix)
    channel_outputs: Vec<Vec<f64>>,
    /// Pre-allocated interleaved output buffer (Defect 33 fix)
    interleaved_output: Vec<f64>,
    /// Maximum input frames expected (for buffer sizing)
    max_input_frames: usize,
}

impl StreamingResampler {
    /// Create a new streaming resampler with default (linear) phase and High quality
    pub fn new(channels: usize, from_rate: u32, to_rate: u32) -> Result<Self, ResamplerError> {
        Self::with_phase(channels, from_rate, to_rate, PhaseResponse::default())
    }
    
    /// Create a new streaming resampler with specified phase response (High quality)
    /// 
    /// Returns Err if Soxr initialization fails (e.g., invalid sample rates like 0 Hz)
    pub fn with_phase(channels: usize, from_rate: u32, to_rate: u32, phase: PhaseResponse) -> Result<Self, ResamplerError> {
        Self::with_quality(channels, from_rate, to_rate, phase, ResampleQuality::High)
    }
    
    /// Create a new streaming resampler with specified phase response and quality level
    /// 
    /// FIX for Defect 30: Allow quality configuration
    /// FIX for Defect 33: Pre-allocate all buffers to avoid heap allocation in process_chunk
    /// 
    /// Returns Err if Soxr initialization fails (e.g., invalid sample rates like 0 Hz)
    pub fn with_quality(
        channels: usize, 
        from_rate: u32, 
        to_rate: u32, 
        phase: PhaseResponse,
        quality: ResampleQuality,
    ) -> Result<Self, ResamplerError> {
        // Validate sample rates before creating Soxr instances
        if from_rate == 0 || to_rate == 0 {
            return Err(ResamplerError::InitializationFailed(
                format!("Invalid sample rate: from_rate={}, to_rate={}", from_rate, to_rate)
            ));
        }
        
        let mut soxr_instances = Vec::with_capacity(channels);
        for ch_idx in 0..channels {
            // Create params for each channel with phase response and quality
            // FIX for Defect 30: Use quality parameter
            let quality_spec = make_quality_spec(quality_to_recipe(quality), phase);
            let runtime_spec = RuntimeSpec::new(1);
            
            match Soxr::<Mono<f64>>::new_with_params(
                from_rate as f64,
                to_rate as f64,
                quality_spec,
                runtime_spec,
            ) {
                Ok(soxr) => soxr_instances.push(soxr),
                Err(e) => {
                    return Err(ResamplerError::InitializationFailed(
                        format!("Soxr failed for channel {}: {:?} (from={}Hz, to={}Hz)", 
                                ch_idx, e, from_rate, to_rate)
                    ));
                }
            }
        }
        
        // Pre-allocate all buffers (Defect 33 fix)
        let max_input_frames = 16384; // Typical chunk size
        let max_ratio = if from_rate > 0 && to_rate > from_rate {
            to_rate as f64 / from_rate as f64
        } else {
            2.0 // Conservative default
        };
        let max_output_per_channel = (max_input_frames as f64 * max_ratio).ceil() as usize + 64;
        
        // Pre-allocate channel buffers
        let channel_inputs: Vec<Vec<f64>> = (0..channels)
            .map(|_| Vec::with_capacity(max_input_frames))
            .collect();
        let channel_outputs: Vec<Vec<f64>> = (0..channels)
            .map(|_| Vec::with_capacity(max_output_per_channel))
            .collect();
        let interleaved_output = Vec::with_capacity(max_output_per_channel * channels);
        
        Ok(Self {
            soxr_instances,
            channels,
            from_rate,
            to_rate,
            phase,
            quality,
            output_scratch: vec![0.0; max_output_per_channel],
            channel_inputs,
            channel_outputs,
            interleaved_output,
            max_input_frames,
        })
    }
    
    /// Process a chunk of interleaved audio, returning resampled interleaved output
    /// 
    /// FIX for Defect 33: Uses pre-allocated buffers to avoid heap allocation.
    /// Note: This still returns a Vec for API compatibility. For zero-allocation,
    /// use process_chunk_into() which writes to a pre-allocated output buffer.
    pub fn process_chunk(&mut self, input: &[f64]) -> Vec<f64> {
        if self.from_rate == self.to_rate {
            return input.to_vec();
        }
        
        let input_frames = input.len() / self.channels;
        if input_frames == 0 {
            return Vec::new();
        }
        
        // Clear and reuse pre-allocated channel input buffers (Defect 33 fix)
        for ch_buf in &mut self.channel_inputs {
            ch_buf.clear();
        }
        
        // De-interleave input into pre-allocated buffers
        for (i, &sample) in input.iter().enumerate() {
            self.channel_inputs[i % self.channels].push(sample);
        }
        
        // Clear and reuse pre-allocated channel output buffers (Defect 33 fix)
        for ch_buf in &mut self.channel_outputs {
            ch_buf.clear();
        }
        
        // Process each channel
        for (ch, channel_data) in self.channel_inputs.iter().enumerate() {
            // Ensure scratch buffer is large enough (only resize if needed)
            let expected_output = (channel_data.len() as f64 * self.to_rate as f64 / self.from_rate as f64).ceil() as usize + 64;
            if self.output_scratch.len() < expected_output {
                self.output_scratch.resize(expected_output, 0.0);
            }
            
            let processed = self.soxr_instances[ch]
                .process(channel_data, &mut self.output_scratch)
                .expect("Resampling failed");
            
            // Copy to channel output buffer (still one allocation per channel, unavoidable for Vec return)
            self.channel_outputs[ch].extend_from_slice(&self.output_scratch[..processed.output_frames]);
        }
        
        // Re-interleave into pre-allocated buffer (Defect 33 fix)
        if self.channel_outputs.is_empty() || self.channel_outputs[0].is_empty() {
            return Vec::new();
        }
        
        let out_frames = self.channel_outputs[0].len();
        self.interleaved_output.clear();
        self.interleaved_output.reserve(out_frames * self.channels);
        
        for f in 0..out_frames {
            for ch in 0..self.channels {
                self.interleaved_output.push(
                    self.channel_outputs[ch].get(f).copied().unwrap_or(0.0)
                );
            }
        }
        
        // Return a clone of the interleaved data (API compatibility)
        // The pre-allocated buffer is reused on next call
        self.interleaved_output.clone()
    }
    
    /// Process a chunk into a pre-allocated output buffer (zero-allocation version)
    /// 
    /// Returns the number of frames written to output.
    /// Output buffer must be large enough: output.len() >= input.len() * to_rate / from_rate + 64
    pub fn process_chunk_into(&mut self, input: &[f64], output: &mut [f64]) -> usize {
        if self.from_rate == self.to_rate {
            let copy_len = input.len().min(output.len());
            output[..copy_len].copy_from_slice(&input[..copy_len]);
            return copy_len / self.channels;
        }
        
        let input_frames = input.len() / self.channels;
        if input_frames == 0 {
            return 0;
        }
        
        // Clear and reuse pre-allocated buffers
        for ch_buf in &mut self.channel_inputs {
            ch_buf.clear();
        }
        
        // De-interleave
        for (i, &sample) in input.iter().enumerate() {
            self.channel_inputs[i % self.channels].push(sample);
        }
        
        // Clear output buffers
        for ch_buf in &mut self.channel_outputs {
            ch_buf.clear();
        }
        
        // Process each channel
        for (ch, channel_data) in self.channel_inputs.iter().enumerate() {
            let expected_output = (channel_data.len() as f64 * self.to_rate as f64 / self.from_rate as f64).ceil() as usize + 64;
            if self.output_scratch.len() < expected_output {
                self.output_scratch.resize(expected_output, 0.0);
            }
            
            let processed = self.soxr_instances[ch]
                .process(channel_data, &mut self.output_scratch)
                .expect("Resampling failed");
            
            self.channel_outputs[ch].extend_from_slice(&self.output_scratch[..processed.output_frames]);
        }
        
        // Re-interleave directly into output buffer
        if self.channel_outputs.is_empty() || self.channel_outputs[0].is_empty() {
            return 0;
        }
        
        let out_frames = self.channel_outputs[0].len();
        for f in 0..out_frames {
            for ch in 0..self.channels {
                let idx = f * self.channels + ch;
                if idx < output.len() {
                    output[idx] = self.channel_outputs[ch].get(f).copied().unwrap_or(0.0);
                }
            }
        }
        
        out_frames
    }
    
    /// Flush any remaining samples in the resampler's internal buffers
    pub fn flush(&mut self) -> Vec<f64> {
        let mut channel_outputs: Vec<Vec<f64>> = Vec::with_capacity(self.channels);
        
        for ch in 0..self.channels {
            let mut flush_output = vec![0.0; 4096];
            let mut all_flushed = Vec::new();
            
            // Keep flushing until no more output
            loop {
                match self.soxr_instances[ch].process(&[], &mut flush_output) {
                    Ok(processed) if processed.output_frames > 0 => {
                        all_flushed.extend_from_slice(&flush_output[..processed.output_frames]);
                    }
                    _ => break,
                }
            }
            
            channel_outputs.push(all_flushed);
        }
        
        // Re-interleave flushed data
        if channel_outputs.is_empty() || channel_outputs.iter().all(|c| c.is_empty()) {
            return Vec::new();
        }
        
        let max_frames = channel_outputs.iter().map(|c| c.len()).max().unwrap_or(0);
        let mut output = Vec::with_capacity(max_frames * self.channels);
        
        for f in 0..max_frames {
            for ch in 0..self.channels {
                output.push(channel_outputs[ch].get(f).copied().unwrap_or(0.0));
            }
        }
        
        output
    }
}
