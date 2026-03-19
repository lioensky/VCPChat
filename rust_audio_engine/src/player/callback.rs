//! Audio callback implementation (lock-free version)
//!
//! Contains the real-time audio processing callback using lock-free DSP chain.
//! All parameter updates use atomic operations, eliminating lock contention
//! between the audio thread and main thread.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use crossbeam::channel::Sender;

use super::state::{SharedState, PlayerState};
use crate::processor::{
    DspChain, StreamingResampler, AtomicLoudnessState,
    AtomicEqParams, AtomicSaturationParams, AtomicCrossfeedParams,
    AtomicPeakLimiterParams, AtomicVolumeParams, AtomicNoiseShaperParams,
    AtomicDynamicLoudnessParams, AtomicDynamicLoudnessTelemetry,
    FFTConvolver,
    EqProcessor, SaturationProcessor, CrossfeedProcessor,
    PeakLimiterProcessor, VolumeProcessor, NoiseShaperProcessor, DynamicLoudnessProcessor,
};

// ============================================================================
// CHANNEL NORMALIZATION
// ============================================================================

/// Channel normalization for gapless playback
///
/// Handles mono ↔ stereo conversion:
/// - mono → stereo: duplicate each sample to L/R
/// - stereo → mono: average L+R
pub fn normalize_channels(samples: Vec<f64>, from: usize, to: usize) -> Vec<f64> {
    if from == 1 && to == 2 {
        // mono → stereo: duplicate each sample to L/R
        let mut out = Vec::with_capacity(samples.len() * 2);
        for s in &samples {
            out.push(*s);
            out.push(*s);
        }
        out
    } else if from == 2 && to == 1 {
        // stereo → mono: average L+R
        let frames = samples.len() / 2;
        let mut out = Vec::with_capacity(frames);
        for i in 0..frames {
            out.push((samples[i * 2] + samples[i * 2 + 1]) * 0.5);
        }
        out
    } else {
        // Other cases: truncate or zero-pad to 'to' channels
        let frames = samples.len() / from;
        let mut out = Vec::with_capacity(frames * to);
        for i in 0..frames {
            for ch in 0..to {
                out.push(if ch < from { samples[i * from + ch] } else { 0.0 });
            }
        }
        out
    }
}

// ============================================================================
// LOCK-FREE DSP CONTEXT
// ============================================================================

/// Lock-free DSP context for audio callback
///
/// This structure holds all the state needed for lock-free audio processing.
/// It uses DspChain for unified processing and atomic parameters for thread-safe
/// parameter updates without blocking.
///
/// # Architecture
///
/// ```
/// Main Thread                    Audio Thread
///     |                              |
///     v                              v
/// AtomicParams ---> LockfreeDspContext.process()
/// (non-blocking)     |
///                    v
///                DspChain.process()
///                    |
///                    v
///               [EQ → Saturation → Crossfeed → Limiter → Volume → DynamicLoudness]
/// ```
///
/// # Usage
///
/// ```ignore
/// // Main thread: create and share
/// let ctx = Arc::new(LockfreeDspContext::new(2, 44100.0, params...));
///
/// // Audio thread: process
/// ctx.process(buffer, channels);
///
/// // Main thread: update parameters (non-blocking)
/// ctx.eq_params().set_band_gain(0, 3.0);
/// ```
pub struct LockfreeDspContext {
    /// Runtime state guarded by a single lock (chain + merged convolver)
    runtime: parking_lot::Mutex<DspRuntime>,
    
    /// Lock-free parameter references
    eq_params: Arc<AtomicEqParams>,
    saturation_params: Arc<AtomicSaturationParams>,
    crossfeed_params: Arc<AtomicCrossfeedParams>,
    limiter_params: Arc<AtomicPeakLimiterParams>,
    volume_params: Arc<AtomicVolumeParams>,
    noise_shaper_params: Arc<AtomicNoiseShaperParams>,
    dynamic_loudness_params: Arc<AtomicDynamicLoudnessParams>,
    
    /// Sample rate
    sample_rate: f64,
    /// Channel count
    channels: usize,
    /// Optional external IR kernel source (interleaved)
    external_ir_kernel: parking_lot::Mutex<Option<(Vec<f64>, usize)>>,
    /// Optional FIR kernel source (interleaved)
    fir_ir_kernel: parking_lot::Mutex<Option<(Vec<f64>, usize)>>,
}

struct DspRuntime {
    chain: DspChain,
    merged_convolver: Option<FFTConvolver>,
}

impl LockfreeDspContext {
    /// Create a new lock-free DSP context
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        channels: usize,
        sample_rate: f64,
        eq_params: Arc<AtomicEqParams>,
        saturation_params: Arc<AtomicSaturationParams>,
        crossfeed_params: Arc<AtomicCrossfeedParams>,
        limiter_params: Arc<AtomicPeakLimiterParams>,
        volume_params: Arc<AtomicVolumeParams>,
        noise_shaper_params: Arc<AtomicNoiseShaperParams>,
        dynamic_loudness_params: Arc<AtomicDynamicLoudnessParams>,
        dynamic_loudness_telemetry: Arc<AtomicDynamicLoudnessTelemetry>,
    ) -> Self {
        // Build DSP chain with processors
        let mut chain = DspChain::new(sample_rate);
        
        // Add processors in order: EQ → Saturation → Crossfeed → Limiter → Volume → DynamicLoudness → NoiseShaper
        chain.add(EqProcessor::new(channels, sample_rate, Arc::clone(&eq_params)));
        chain.add(SaturationProcessor::new(Arc::clone(&saturation_params)));
        chain.add(CrossfeedProcessor::new(sample_rate, Arc::clone(&crossfeed_params)));
        chain.add(PeakLimiterProcessor::new(channels, sample_rate as u32, Arc::clone(&limiter_params)));
        chain.add(VolumeProcessor::new(Arc::clone(&volume_params)));
        chain.add(DynamicLoudnessProcessor::new(
            channels,
            sample_rate as u32,
            Arc::clone(&dynamic_loudness_params),
            Arc::clone(&dynamic_loudness_telemetry),
        ));
        chain.add(NoiseShaperProcessor::new(
            channels,
            sample_rate as u32,
            Arc::clone(&noise_shaper_params),
        ));
        
        Self {
            runtime: parking_lot::Mutex::new(DspRuntime {
                chain,
                merged_convolver: None,
            }),
            eq_params,
            saturation_params,
            crossfeed_params,
            limiter_params,
            volume_params,
            noise_shaper_params,
            dynamic_loudness_params,
            sample_rate,
            channels,
            external_ir_kernel: parking_lot::Mutex::new(None),
            fir_ir_kernel: parking_lot::Mutex::new(None),
        }
    }
    
    /// Process audio buffer through DSP chain (lock-free)
    ///
    /// This method acquires a lock on the chain only for the duration of
    /// processing. All parameter reads use atomic operations, so there is
    /// no risk of blocking due to parameter updates from the main thread.
    #[inline]
    pub fn process(&self, buffer: &mut [f64]) {
        let mut runtime = self.runtime.lock();
        runtime.chain.process(buffer, self.channels);
        if let Some(convolver) = runtime.merged_convolver.as_mut() {
                convolver.process_inplace(buffer);
        }
    }
    
    /// Reset all processors
    pub fn reset(&self) {
        let mut runtime = self.runtime.lock();
        runtime.chain.reset();
        if let Some(convolver) = runtime.merged_convolver.as_mut() {
            convolver.reset();
        }
    }

    fn rebuild_merged_convolver(&self) -> Result<(), String> {
        let external = self.external_ir_kernel.lock().clone();
        let fir = self.fir_ir_kernel.lock().clone();

        let merged = match (external, fir) {
            (None, None) => None,
            (Some((ir, channels)), None) | (None, Some((ir, channels))) => {
                Some(FFTConvolver::new(&ir, channels))
            }
            (Some((external_ir, ext_channels)), Some((fir_ir, fir_channels))) => {
                if ext_channels != fir_channels {
                    return Err(format!(
                        "Cannot merge kernels with different channels: external={}, fir={}",
                        ext_channels, fir_channels
                    ));
                }

                let merged_ir = convolve_interleaved_ir(&external_ir, &fir_ir, ext_channels)?;
                Some(FFTConvolver::new(&merged_ir, ext_channels))
            }
        };

        let mut runtime = self.runtime.lock();
        runtime.merged_convolver = merged;
        Ok(())
    }

    /// Load/update external IR convolver (non-realtime path)
    pub fn set_external_ir_convolver(&self, ir_data: &[f64], channels: usize) -> Result<(), String> {
        if ir_data.is_empty() {
            return Err("IR data is empty".to_string());
        }
        {
            let mut guard = self.external_ir_kernel.lock();
            *guard = Some((ir_data.to_vec(), channels));
        }
        self.rebuild_merged_convolver()
    }

    /// Disable and clear external IR convolver
    pub fn clear_external_ir_convolver(&self) {
        {
            let mut guard = self.external_ir_kernel.lock();
            *guard = None;
        }
        let _ = self.rebuild_merged_convolver();
    }

    /// Load/update FIR convolver (non-realtime path)
    pub fn set_fir_convolver(&self, ir_data: &[f64], channels: usize) -> Result<(), String> {
        if ir_data.is_empty() {
            return Err("FIR data is empty".to_string());
        }
        {
            let mut guard = self.fir_ir_kernel.lock();
            *guard = Some((ir_data.to_vec(), channels));
        }
        self.rebuild_merged_convolver()
    }

    /// Disable and clear FIR convolver
    pub fn clear_fir_convolver(&self) {
        {
            let mut guard = self.fir_ir_kernel.lock();
            *guard = None;
        }
        let _ = self.rebuild_merged_convolver();
    }
    
    /// Update sample rate (reinitializes processors)
    pub fn set_sample_rate(&self, sample_rate: f64) {
        let mut runtime = self.runtime.lock();
        runtime.chain.set_sample_rate(sample_rate);
    }
    
    /// Get parameter references for main thread updates
    pub fn eq_params(&self) -> &Arc<AtomicEqParams> {
        &self.eq_params
    }
    
    pub fn saturation_params(&self) -> &Arc<AtomicSaturationParams> {
        &self.saturation_params
    }
    
    pub fn crossfeed_params(&self) -> &Arc<AtomicCrossfeedParams> {
        &self.crossfeed_params
    }
    
    pub fn limiter_params(&self) -> &Arc<AtomicPeakLimiterParams> {
        &self.limiter_params
    }
    
    pub fn volume_params(&self) -> &Arc<AtomicVolumeParams> {
        &self.volume_params
    }
    
    pub fn dynamic_loudness_params(&self) -> &Arc<AtomicDynamicLoudnessParams> {
        &self.dynamic_loudness_params
    }

    pub fn noise_shaper_params(&self) -> &Arc<AtomicNoiseShaperParams> {
        &self.noise_shaper_params
    }
}

fn convolve_interleaved_ir(a: &[f64], b: &[f64], channels: usize) -> Result<Vec<f64>, String> {
    if channels == 0 {
        return Err("channels must be > 0".to_string());
    }
    if a.is_empty() || b.is_empty() {
        return Err("IR data must not be empty".to_string());
    }
    if a.len() % channels != 0 || b.len() % channels != 0 {
        return Err("IR data length is not divisible by channels".to_string());
    }

    let a_len = a.len() / channels;
    let b_len = b.len() / channels;
    let out_len = a_len + b_len - 1;
    let mut out = vec![0.0; out_len * channels];

    for ch in 0..channels {
        for i in 0..a_len {
            let ai = a[i * channels + ch];
            if ai == 0.0 {
                continue;
            }
            for j in 0..b_len {
                out[(i + j) * channels + ch] += ai * b[j * channels + ch];
            }
        }
    }

    Ok(out)
}

// ============================================================================
// AUDIO CALLBACK
// ============================================================================

/// Main audio callback for cpal output stream (lock-free)
///
/// This function is called by cpal when it needs more audio samples.
/// It handles:
/// - Gapless playback buffer swapping
/// - DSP processing chain via `LockfreeDspContext` (lock-free parameter reads)
/// - Resampling (if device sample rate differs)
/// - Loudness normalization
/// - Spectrum data output
///
/// # Key Features
///
/// 1. Uses `LockfreeDspContext` instead of individual Mutex<T> processors
/// 2. Parameters are read atomically, never blocking
/// 3. No processor is ever skipped due to lock contention
/// 4. Simpler, more maintainable code
#[allow(clippy::too_many_arguments)]
pub fn audio_callback_lockfree(
    data: &mut [f32],
    shared: &SharedState,
    dsp_ctx: &LockfreeDspContext,
    loudness_state: &Arc<AtomicLoudnessState>,
    spectrum_tx: &Sender<f64>,
    channels: usize,
    process_buf: &mut Vec<f64>,
    resampler: &mut Option<StreamingResampler>,
    resample_leftover: &mut Vec<f64>,
    resample_leftover_pos: &mut usize,
    resample_output: &mut Vec<f64>,
) {
    let has_leftover = *resample_leftover_pos < resample_leftover.len();

    // Gapless and EOF handling
    let total = shared.total_frames.load(Ordering::Relaxed) as usize;
    let mut current_pos = shared.position_frames.load(Ordering::Relaxed) as usize;

    // Signal preload
    let sr = shared.sample_rate.load(Ordering::Relaxed) as usize;
    let remaining_frames = total.saturating_sub(current_pos);
    if remaining_frames > 0
        && remaining_frames < sr * 2
        && !shared.pending_ready.load(Ordering::Relaxed)
        && !shared.needs_preload.load(Ordering::Acquire)
    {
        shared.needs_preload.store(true, Ordering::Release);
    }

    // EOF Detection with gapless
    if current_pos >= total && !has_leftover {
        if shared.pending_ready.load(Ordering::Acquire) {
            let next_samples = shared.pending_buffer.write().take();

            if let Some(next) = next_samples {
                let next_frames = shared.pending_total_frames.load(Ordering::Relaxed);
                let next_sr = shared.pending_sample_rate.load(Ordering::Relaxed);
                let next_ch = shared.pending_channels.load(Ordering::Relaxed);
                let next_path = shared.pending_file_path.write().take();
                let next_metadata = shared.pending_metadata.write().take();

                *shared.audio_buffer.write() = next;
                shared.total_frames.store(next_frames, Ordering::Relaxed);
                shared.sample_rate.store(next_sr, Ordering::Relaxed);
                shared.channels.store(next_ch, Ordering::Relaxed);
                shared.position_frames.store(0, Ordering::Relaxed);
                *shared.file_path.write() = next_path.clone();
                
                if let Some(meta) = next_metadata {
                    *shared.track_metadata.write() = meta;
                }
                *shared.current_track_path.write() = next_path;

                shared.pending_ready.store(false, Ordering::Release);
                shared.needs_preload.store(false, Ordering::Relaxed);
                shared.event_track_changed.store(true, Ordering::Release);
                shared.dsp_reset_pending.store(true, Ordering::Release);

                let pending_gain_bits = shared.pending_target_gain_db.load(Ordering::Relaxed);
                let pending_gain_db = f64::from_bits(pending_gain_bits);
                loudness_state.set_target_gain(pending_gain_db);

                log::info!("Gapless: switched to next track (gain: {:.2} dB)", pending_gain_db);

                // Reset DSP chain
                dsp_ctx.reset();
                *resampler = None;
                resample_leftover.clear();
                *resample_leftover_pos = 0;
                shared.dsp_reset_pending.store(false, Ordering::Release);

                data.fill(0.0);
                return;
            }
        }

        data.fill(0.0);
        if let Some(mut state) = shared.state.try_write() {
            if *state == PlayerState::Playing {
                *state = PlayerState::Stopped;
                shared.event_playback_ended.store(true, Ordering::Release);
            }
        }
        return;
    }

    let mut samples_written = 0;
    let output_len = data.len();

    // Drain leftovers from resampling
    if resampler.is_some() && *resample_leftover_pos < resample_leftover.len() {
        let available = resample_leftover.len() - *resample_leftover_pos;
        let take = available.min(output_len);
        let start = *resample_leftover_pos;
        let end = start + take;
        for (dst, src) in data[..take].iter_mut().zip(resample_leftover[start..end].iter()) {
            *dst = *src as f32;
        }
        *resample_leftover_pos += take;
        if *resample_leftover_pos >= resample_leftover.len() {
            resample_leftover.clear();
            *resample_leftover_pos = 0;
        }
        samples_written = take;
    }

    // Generate new samples
    while samples_written < output_len {
        let frames_needed_out = (output_len - samples_written) / channels;
        if frames_needed_out == 0 { break; }

        let mut source_frames_needed = frames_needed_out;
        if resampler.is_some() {
            source_frames_needed = 4096;
        }

        let available_source = total.saturating_sub(current_pos);
        if available_source == 0 { break; }

        let frames_to_read = source_frames_needed.min(available_source).min(4096);
        let start_sample = current_pos * channels;
        let end_sample = start_sample + frames_to_read * channels;

        process_buf.clear();
        {
            let buf = shared.audio_buffer.read();
            if end_sample <= buf.len() {
                process_buf.extend_from_slice(&buf[start_sample..end_sample]);
            }
        }
        
        if process_buf.is_empty() {
            continue;
        }

        current_pos += frames_to_read;
        shared.position_frames.store(current_pos as u64, Ordering::Relaxed);

        // ===== DSP Chain Processing (LOCK-FREE) =====
        // Apply loudness normalization (atomic, no lock)
        let frames_in_chunk = process_buf.len() / channels;
        let linear_gain = loudness_state.process_gain(frames_in_chunk);
        for sample in process_buf.iter_mut() {
            *sample *= linear_gain;
        }

        // Process through unified DSP chain (lock-free parameter reads)
        dsp_ctx.process(process_buf);

        // Resample or direct output
        if let Some(rs) = resampler {
            let frames_written = rs.process_chunk_into(process_buf, resample_output);
            let samples_resampled = frames_written * channels;
            
            let mut chunk_idx = 0;
            while samples_written < output_len && chunk_idx < samples_resampled {
                data[samples_written] = resample_output[chunk_idx] as f32;
                samples_written += 1;
                chunk_idx += 1;
            }

            if chunk_idx < samples_resampled {
                resample_leftover.extend_from_slice(&resample_output[chunk_idx..samples_resampled]);
                *resample_leftover_pos = 0;
            }
        } else {
            let take = process_buf.len().min(output_len - samples_written);
            for i in 0..take {
                data[samples_written + i] = process_buf[i] as f32;
            }
            samples_written += take;
        }
    }

    // Fill remaining with silence
    if samples_written < output_len {
        for i in samples_written..output_len {
            data[i] = 0.0;
        }
    }

    // Spectrum output
    if samples_written > 0 {
        let take = samples_written.min(1024);
        for i in (0..take).step_by(channels) {
            let mut sum = 0.0;
            for c in 0..channels {
                if i + c < data.len() {
                    sum += data[i + c] as f64;
                }
            }
            let _ = spectrum_tx.try_send(sum / channels as f64);
        }
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_channels_mono_to_stereo() {
        let mono = vec![1.0, 2.0, 3.0];
        let stereo = normalize_channels(mono, 1, 2);
        assert_eq!(stereo, vec![1.0, 1.0, 2.0, 2.0, 3.0, 3.0]);
    }

    #[test]
    fn test_normalize_channels_stereo_to_mono() {
        let stereo = vec![1.0, 3.0, 2.0, 4.0];
        let mono = normalize_channels(stereo, 2, 1);
        assert_eq!(mono, vec![2.0, 3.0]); // (1+3)/2, (2+4)/2
    }

    #[test]
    fn test_lockfree_dsp_context() {
        let eq_params = Arc::new(AtomicEqParams::new());
        let sat_params = Arc::new(AtomicSaturationParams::new());
        let cross_params = Arc::new(AtomicCrossfeedParams::new());
        let limiter_params = Arc::new(AtomicPeakLimiterParams::new());
        let vol_params = Arc::new(AtomicVolumeParams::new());
        let ns_params = Arc::new(AtomicNoiseShaperParams::new());
        let dl_params = Arc::new(AtomicDynamicLoudnessParams::new());
        let dl_telemetry = Arc::new(AtomicDynamicLoudnessTelemetry::new());

        let ctx = LockfreeDspContext::new(
            2,
            44100.0,
            Arc::clone(&eq_params),
            Arc::clone(&sat_params),
            Arc::clone(&cross_params),
            Arc::clone(&limiter_params),
            Arc::clone(&vol_params),
            Arc::clone(&ns_params),
            Arc::clone(&dl_params),
            Arc::clone(&dl_telemetry),
        );

        // Test that we can update params while processing
        eq_params.set_band_gain(0, 3.0);
        
        let mut buffer = vec![0.5; 100];
        ctx.process(&mut buffer);
        
        // Should not panic
    }
}