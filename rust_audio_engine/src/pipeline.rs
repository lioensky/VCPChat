//! VCP Hi-Fi Audio Engine - Streaming Audio Pipeline
//!
//! Asynchronous audio processing pipeline for streaming decode and resample.
//! This eliminates the memory spike issue with 192kHz upsampling.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::{self, JoinHandle};
use parking_lot::RwLock;
// Channel imports unused in current implementation

use crate::decoder::StreamingDecoder;
use crate::processor::StreamingResampler;
use crate::config::ResampleQuality;

/// Ring buffer size in frames (per channel)
/// ~4MB for stereo f64 at 192kHz ≈ 0.5 seconds buffer
const RING_BUFFER_FRAMES: usize = 131072;

/// Chunk size for processing (frames per decode/resample cycle)
const CHUNK_SIZE_FRAMES: usize = 8192;

/// Status of the audio pipeline
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PipelineStatus {
    /// Pipeline is idle, waiting for data
    Idle,
    /// Pipeline is actively buffering/processing
    Buffering,
    /// Pipeline has finished processing all data
    Finished,
    /// Pipeline encountered an error
    Error,
}

/// Streaming audio pipeline that decodes and resamples in background
pub struct AudioPipeline {
    // Ring buffer for processed audio data
    ring_buffer: Arc<RwLock<RingBuffer>>,
    
    // Control flags
    is_running: Arc<AtomicBool>,
    is_finished: Arc<AtomicBool>,
    
    // Progress tracking
    buffered_frames: Arc<AtomicU64>,
    total_frames: Arc<AtomicU64>,
    current_read_pos: Arc<AtomicU64>,
    
    // Worker thread handle
    worker_handle: Option<JoinHandle<()>>,
    
    // Audio format info
    pub channels: usize,
    pub sample_rate: u32,
    pub original_sample_rate: u32,
}

/// Simple ring buffer for audio data
/// Uses monotonic counters (frames_written, frames_consumed) for clean overflow handling.
pub struct RingBuffer {
    data: Vec<f64>,
    capacity_frames: usize,
    channels: usize,
    /// Total frames written (monotonically increasing)
    frames_written: u64,
    /// Total frames consumed by readers (monotonically increasing)
    frames_consumed: u64,
    /// Number of overflow events
    overflow_count: u64,
}

impl RingBuffer {
    pub fn new(capacity_frames: usize, channels: usize) -> Self {
        Self {
            data: vec![0.0; capacity_frames * channels],
            capacity_frames,
            channels,
            frames_written: 0,
            frames_consumed: 0,
            overflow_count: 0,
        }
    }
    
    /// Write frames to the buffer, returns number of frames written
    /// If buffer would overflow, drops the oldest data (ring buffer behavior)
    /// Returns (frames_written, overflow_new_consumed) — overflow_new_consumed is
    /// the updated frames_consumed value that external read positions must respect.
    pub fn write(&mut self, samples: &[f64]) -> (usize, Option<u64>) {
        let frames_to_write = samples.len() / self.channels;
        let samples_to_write = frames_to_write * self.channels;

        if frames_to_write == 0 {
            return (0, None);
        }

        // Check for potential overflow
        let frames_in_buffer = self.frames_written.saturating_sub(self.frames_consumed);
        let available_space = self.capacity_frames.saturating_sub(frames_in_buffer as usize);

        let overflow_consumed = if frames_to_write > available_space {
            // Overflow detected - advance consumer position to make room
            // This effectively drops the oldest frames
            let overflow_frames = frames_to_write - available_space;
            self.frames_consumed = self.frames_consumed.saturating_add(overflow_frames as u64);
            self.overflow_count = self.overflow_count.saturating_add(1);
            log::warn!(
                "RingBuffer overflow: dropping {} frames (total overflows: {})",
                overflow_frames, self.overflow_count
            );
            // FIX for Defect 5: Return new consumed position so external read_pos can be updated
            Some(self.frames_consumed)
        } else {
            None
        };

        // Write samples using monotonically increasing write position
        for (i, &sample) in samples[..samples_to_write].iter().enumerate() {
            let frame_offset = i / self.channels;
            let write_frame = (self.frames_written as usize + frame_offset) % self.capacity_frames;
            let ch = i % self.channels;
            let buffer_idx = write_frame * self.channels + ch;
            self.data[buffer_idx] = sample;
        }

        self.frames_written += frames_to_write as u64;
        (frames_to_write, overflow_consumed)
    }
    
    /// Read frames from the buffer at a given position
    pub fn read(&self, start_frame: u64, output: &mut [f64]) -> usize {
        let frames_to_read = output.len() / self.channels;
        let available = self.frames_written.saturating_sub(start_frame) as usize;
        let actual_frames = frames_to_read.min(available);
        
        if actual_frames == 0 {
            return 0;
        }
        
        for frame in 0..actual_frames {
            let read_frame = ((start_frame as usize + frame) % self.capacity_frames) as usize;
            for ch in 0..self.channels {
                let buffer_idx = read_frame * self.channels + ch;
                let output_idx = frame * self.channels + ch;
                output[output_idx] = self.data[buffer_idx];
            }
        }
        
        actual_frames
    }
    
    /// Update consumed position (call after reading)
    pub fn advance_read_pos(&mut self, frames: u64) {
        self.frames_consumed = self.frames_consumed.saturating_add(frames);
    }
    
    /// Get number of frames available for reading from a given position
    pub fn available_frames(&self, read_pos: u64) -> u64 {
        self.frames_written.saturating_sub(read_pos)
    }
    
    /// Get total frames written
    pub fn total_written(&self) -> u64 {
        self.frames_written
    }
    
    /// Get overflow count
    pub fn overflow_count(&self) -> u64 {
        self.overflow_count
    }
}

impl AudioPipeline {
    /// Create a new pipeline from a file path
    pub fn new(
        path: &str,
        target_sample_rate: Option<u32>,
        _resample_quality: ResampleQuality,
    ) -> Result<Self, String> {
        let decoder = StreamingDecoder::open(path)
            .map_err(|e| format!("Failed to open decoder: {}", e))?;
        
        let info = decoder.info.clone();
        let original_sr = info.sample_rate;
        let channels = info.channels;
        let total_source_frames = info.total_frames.unwrap_or(0);
        
        // Determine target sample rate
        let target_sr = target_sample_rate.unwrap_or(original_sr);
        
        // Calculate expected total frames after resampling
        let total_frames = if target_sr != original_sr {
            ((total_source_frames as f64) * (target_sr as f64) / (original_sr as f64)).ceil() as u64
        } else {
            total_source_frames
        };
        
        log::info!(
            "Creating audio pipeline: {}→{} Hz, {} ch, ~{} frames",
            original_sr, target_sr, channels, total_frames
        );
        
        let ring_buffer = Arc::new(RwLock::new(RingBuffer::new(RING_BUFFER_FRAMES, channels)));
        let is_running = Arc::new(AtomicBool::new(false));
        let is_finished = Arc::new(AtomicBool::new(false));
        let buffered_frames = Arc::new(AtomicU64::new(0));
        let total_frames_arc = Arc::new(AtomicU64::new(total_frames));
        let current_read_pos = Arc::new(AtomicU64::new(0));
        
        let pipeline = Self {
            ring_buffer: Arc::clone(&ring_buffer),
            is_running: Arc::clone(&is_running),
            is_finished: Arc::clone(&is_finished),
            buffered_frames: Arc::clone(&buffered_frames),
            total_frames: Arc::clone(&total_frames_arc),
            current_read_pos: Arc::clone(&current_read_pos),
            worker_handle: None,
            channels,
            sample_rate: target_sr,
            original_sample_rate: original_sr,
        };
        
        Ok(pipeline)
    }
    
    /// Start the background processing thread
    pub fn start(&mut self, path: String, target_sample_rate: Option<u32>, _quality: ResampleQuality) {
        if self.is_running.load(Ordering::Relaxed) {
            return;
        }
        
        self.is_running.store(true, Ordering::Relaxed);
        self.is_finished.store(false, Ordering::Relaxed);
        
        let ring_buffer = Arc::clone(&self.ring_buffer);
        let is_running = Arc::clone(&self.is_running);
        let is_finished = Arc::clone(&self.is_finished);
        let buffered_frames = Arc::clone(&self.buffered_frames);
        let total_frames = Arc::clone(&self.total_frames);
        let current_read_pos = Arc::clone(&self.current_read_pos);
        let channels = self.channels;
        let original_sr = self.original_sample_rate;
        let target_sr = target_sample_rate.unwrap_or(original_sr);

        let handle = thread::spawn(move || {
            Self::worker_loop(
                path,
                channels,
                original_sr,
                target_sr,
                ring_buffer,
                is_running,
                is_finished,
                buffered_frames,
                total_frames,
                current_read_pos,
            );
        });
        
        self.worker_handle = Some(handle);
    }
    
    /// Background worker that decodes and resamples
    fn worker_loop(
        path: String,
        channels: usize,
        original_sr: u32,
        target_sr: u32,
        ring_buffer: Arc<RwLock<RingBuffer>>,
        is_running: Arc<AtomicBool>,
        is_finished: Arc<AtomicBool>,
        buffered_frames: Arc<AtomicU64>,
        total_frames: Arc<AtomicU64>,
        current_read_pos: Arc<AtomicU64>,
    ) {
        log::info!("Pipeline worker started for: {}", path);
        
        // Open decoder
        let mut decoder = match StreamingDecoder::open(&path) {
            Ok(d) => d,
            Err(e) => {
                log::error!("Failed to open decoder in worker: {}", e);
                is_finished.store(true, Ordering::Relaxed);
                return;
            }
        };
        
        // Create resampler if needed
        let mut resampler = if target_sr != original_sr {
            match StreamingResampler::new(channels, original_sr, target_sr) {
                Ok(rs) => Some(rs),
                Err(e) => {
                    log::error!("Failed to create pipeline resampler: {}", e);
                    return;
                }
            }
        } else {
            None
        };
        
        let mut total_output_frames: u64 = 0;
        
        // Process loop
        while is_running.load(Ordering::Relaxed) {
            // Decode next chunk
            let decoded = match decoder.decode_next() {
                Ok(Some(samples)) => samples,
                Ok(None) => {
                    // EOF - flush resampler if present
                    if let Some(ref mut rs) = resampler {
                        let flushed = rs.flush();
                        if !flushed.is_empty() {
                            let frames = flushed.len() / channels;
                            let (_, overflow) = ring_buffer.write().write(&flushed);
                            // FIX for Defect 5: Sync external read position on overflow
                            if let Some(min_pos) = overflow {
                                current_read_pos.fetch_max(min_pos, Ordering::Relaxed);
                            }
                            total_output_frames += frames as u64;
                            buffered_frames.store(total_output_frames, Ordering::Relaxed);
                        }
                    }
                    break;
                }
                Err(e) => {
                    log::error!("Decode error in pipeline: {}", e);
                    break;
                }
            };
            
            // Resample if needed
            let output = if let Some(ref mut rs) = resampler {
                rs.process_chunk(&decoded)
            } else {
                decoded
            };
            
            if !output.is_empty() {
                let frames = output.len() / channels;
                let (_, overflow) = ring_buffer.write().write(&output);
                // FIX for Defect 5: Sync external read position on overflow
                if let Some(min_pos) = overflow {
                    current_read_pos.fetch_max(min_pos, Ordering::Relaxed);
                }
                total_output_frames += frames as u64;
                buffered_frames.store(total_output_frames, Ordering::Relaxed);
            }
        }
        
        // Update final total frames (may differ from estimate)
        total_frames.store(total_output_frames, Ordering::Relaxed);
        is_finished.store(true, Ordering::Relaxed);
        is_running.store(false, Ordering::Relaxed);
        
        log::info!("Pipeline worker finished. Total frames: {}", total_output_frames);
    }
    
    /// Stop the pipeline
    pub fn stop(&mut self) {
        self.is_running.store(false, Ordering::Relaxed);
        if let Some(handle) = self.worker_handle.take() {
            let _ = handle.join();
        }
    }
    
    /// Read audio data from the pipeline
    /// Returns number of frames actually read
    pub fn read(&self, output: &mut [f64]) -> usize {
        let read_pos = self.current_read_pos.load(Ordering::Relaxed);
        let buffer = self.ring_buffer.read();
        let frames_read = buffer.read(read_pos, output);
        drop(buffer);
        
        if frames_read > 0 {
            self.current_read_pos.fetch_add(frames_read as u64, Ordering::Relaxed);
        }
        
        frames_read
    }
    
    /// Get current read position in frames
    pub fn read_position(&self) -> u64 {
        self.current_read_pos.load(Ordering::Relaxed)
    }
    
    /// Set read position (for seeking)
    pub fn set_read_position(&self, frame: u64) {
        self.current_read_pos.store(frame, Ordering::Relaxed);
    }
    
    /// Get total frames
    pub fn total_frames(&self) -> u64 {
        self.total_frames.load(Ordering::Relaxed)
    }
    
    /// Get buffered frames
    pub fn buffered_frames(&self) -> u64 {
        self.buffered_frames.load(Ordering::Relaxed)
    }
    
    /// Check if pipeline has finished processing
    pub fn is_finished(&self) -> bool {
        self.is_finished.load(Ordering::Relaxed)
    }
    
    /// Check if pipeline is running
    pub fn is_running(&self) -> bool {
        self.is_running.load(Ordering::Relaxed)
    }
    
    /// Get buffering ratio (0.0 - 1.0)
    pub fn buffer_ratio(&self) -> f32 {
        let total = self.total_frames.load(Ordering::Relaxed);
        let buffered = self.buffered_frames.load(Ordering::Relaxed);
        if total == 0 {
            return 0.0;
        }
        (buffered as f32 / total as f32).min(1.0)
    }
    
    /// Get available frames from current read position
    pub fn available_frames(&self) -> u64 {
        let read_pos = self.current_read_pos.load(Ordering::Relaxed);
        self.buffered_frames.load(Ordering::Relaxed).saturating_sub(read_pos)
    }
}

impl Drop for AudioPipeline {
    fn drop(&mut self) {
        self.stop();
    }
}
