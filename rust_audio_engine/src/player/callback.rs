//! Audio callback implementation (lock-free version)
//!
//! Contains the real-time audio processing callback using lock-free DSP chain.
//! All parameter updates use atomic operations, eliminating lock contention
//! between the audio thread and main thread.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use crossbeam::channel::Sender;
use arc_swap::ArcSwapOption;

use super::state::{SharedState, PlayerState,
    EVENT_TRACK_CHANGED, EVENT_NEEDS_PRELOAD_RESET, EVENT_PLAYBACK_ENDED};
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
/// This structure manages DSP processing state. The DspChain and convolver
/// are owned by the audio callback closure (&mut), NOT shared via Mutex.
///
/// - DspChain: owned exclusively by callback closure (created once, moved in)
/// - Convolver: updated via ArcSwapOption (wait-free pointer swap)
/// - IR kernels: stored for rebuild on non-realtime path only
/// - Parameters: read atomically from shared AtomicXxxParams
///
/// # Architecture
///
/// ```
/// Main Thread                    Audio Thread
///     |                              |
///     v                              v
/// AtomicParams ───> DspChain.process() (owned &mut, no Mutex)
/// (non-blocking)     |
///                    v
///               [EQ → Saturation → Crossfeed → Limiter → Volume → DynamicLoudness]
///                    |
///                    v
///               ArcSwapOption<FFTConvolver> ───> convolver.process_inplace()
/// ```
pub struct LockfreeDspContext {
    /// Lock-free parameter references (shared with main thread, read atomically)
    pub eq_params: Arc<AtomicEqParams>,
    pub saturation_params: Arc<AtomicSaturationParams>,
    pub crossfeed_params: Arc<AtomicCrossfeedParams>,
    pub limiter_params: Arc<AtomicPeakLimiterParams>,
    pub volume_params: Arc<AtomicVolumeParams>,
    pub noise_shaper_params: Arc<AtomicNoiseShaperParams>,
    pub dynamic_loudness_params: Arc<AtomicDynamicLoudnessParams>,

    /// Sample rate
    sample_rate: f64,
    /// Channel count
    channels: usize,

    /// Merged convolver — updated via ArcSwap (wait-free pointer swap from main thread,
    /// wait-free load from audio thread). No Mutex needed.
    pub merged_convolver: Arc<ArcSwapOption<FFTConvolver>>,

    /// IR kernel sources — only accessed from non-realtime command handling path.
    /// Protected by Mutex because they are only read/written from the audio thread's
    /// command processing loop (not from the audio callback itself).
    external_ir_kernel: parking_lot::Mutex<Option<(Vec<f64>, usize)>>,
    fir_ir_kernel: parking_lot::Mutex<Option<(Vec<f64>, usize)>>,
}

impl LockfreeDspContext {
    /// Create a new lock-free DSP context.
    ///
    /// Returns (Self, DspChain) — the caller must move the DspChain into the
    /// audio callback closure. The DspChain is exclusively owned by the audio
    /// thread and never shared.
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
    ) -> (Self, DspChain) {
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

        let ctx = Self {
            eq_params,
            saturation_params,
            crossfeed_params,
            limiter_params,
            volume_params,
            noise_shaper_params,
            dynamic_loudness_params,
            sample_rate,
            channels,
            merged_convolver: Arc::new(ArcSwapOption::empty()),
            external_ir_kernel: parking_lot::Mutex::new(None),
            fir_ir_kernel: parking_lot::Mutex::new(None),
        };

        (ctx, chain)
    }

    fn rebuild_merged_convolver(&self) -> Result<(), String> {
        let external = self.external_ir_kernel.lock().clone();
        let fir = self.fir_ir_kernel.lock().clone();

        let merged = match (external, fir) {
            (None, None) => None,
            (Some((ir, channels)), None) | (None, Some((ir, channels))) => {
                Some(Arc::new(FFTConvolver::new(&ir, channels)))
            }
            (Some((external_ir, ext_channels)), Some((fir_ir, fir_channels))) => {
                if ext_channels != fir_channels {
                    return Err(format!(
                        "Cannot merge kernels with different channels: external={}, fir={}",
                        ext_channels, fir_channels
                    ));
                }

                let merged_ir = convolve_interleaved_ir(&external_ir, &fir_ir, ext_channels)?;
                Some(Arc::new(FFTConvolver::new(&merged_ir, ext_channels)))
            }
        };

        // Wait-free pointer swap — audio callback will pick up new convolver
        // on next invocation via ArcSwap::load()
        match merged {
            Some(conv) => self.merged_convolver.store(Some(conv)),
            None => self.merged_convolver.store(None),
        }
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
/// Zero-Mutex audio processing:
/// - `dsp_chain`: exclusively owned by this closure (&mut), no lock needed
/// - `owned_convolver`: exclusively owned by callback, updated via ArcSwap swap-in
/// - `convolver_swap`: wait-free ArcSwap used only to deliver new convolver instances
/// - Parameters: read atomically from shared AtomicXxxParams
#[allow(clippy::too_many_arguments)]
pub fn audio_callback_lockfree(
    data: &mut [f32],
    shared: &SharedState,
    dsp_chain: &mut DspChain,
    owned_convolver: &mut Option<FFTConvolver>,
    convolver_swap: &Arc<ArcSwapOption<FFTConvolver>>,
    loudness_state: &Arc<AtomicLoudnessState>,
    spectrum_tx: &Sender<f64>,
    channels: usize,
    process_buf: &mut Vec<f64>,
    resampler: &mut Option<StreamingResampler>,
    resample_leftover: &mut Vec<f64>,
    resample_leftover_pos: &mut usize,
    resample_output: &mut Vec<f64>,
    convolver_output: &mut Vec<f64>,
) {
    // Check for new convolver delivered via ArcSwap (wait-free pointer swap).
    // If a new convolver was built by the command handler thread, swap it in.
    // We take ownership so we can call process_inplace(&mut self).
    {
        let new_conv = convolver_swap.swap(None);
        if let Some(arc_conv) = new_conv {
            // Try to unwrap the Arc; if there are no other references we get the owned value.
            // Otherwise, clone it (this only happens at swap-in time, not per-callback).
            match Arc::try_unwrap(arc_conv) {
                Ok(conv) => *owned_convolver = Some(conv),
                Err(arc) => *owned_convolver = Some((*arc).clone()),
            }
        }
    }

    // H-channel fix: Rebuild DspChain when channel count changes (or sample rate).
    // The LoadComplete handler sets dsp_needs_rebuild=true; we rebuild here
    // because dsp_chain is exclusively owned by this callback closure.
    if shared.dsp_needs_rebuild.compare_exchange(
        true, false, Ordering::AcqRel, Ordering::Acquire
    ).is_ok() {
        let new_channels = shared.channels.load(Ordering::Relaxed).max(1) as usize;
        let new_sr = shared.sample_rate.load(Ordering::Relaxed).max(1) as f64;
        dsp_chain.set_sample_rate(new_sr);
        dsp_chain.reset();
        // Reset convolver state for new format
        if let Some(ref mut conv) = owned_convolver {
            conv.reset();
        }
        log::info!("DspChain rebuilt for {} channels @ {} Hz", new_channels, new_sr);
    }

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
            // Load pending buffer via ArcSwap (lock-free)
            let pending_arc = shared.pending_buffer.load_full();
            let next_samples = pending_arc.as_ref().clone();
            // Clear the pending buffer
            shared.pending_buffer.store(Arc::new(None));

            if let Some(next) = next_samples {
                let next_frames = shared.pending_total_frames.load(Ordering::Relaxed);
                let next_sr = shared.pending_sample_rate.load(Ordering::Relaxed);
                let next_ch = shared.pending_channels.load(Ordering::Relaxed);

                // Store new audio buffer (wait-free ArcSwap)
                shared.audio_buffer.store(Arc::new(next));
                shared.total_frames.store(next_frames, Ordering::Relaxed);
                shared.sample_rate.store(next_sr, Ordering::Relaxed);
                shared.channels.store(next_ch, Ordering::Relaxed);
                shared.position_frames.store(0, Ordering::Relaxed);

                shared.pending_ready.store(false, Ordering::Release);
                shared.needs_preload.store(false, Ordering::Relaxed);
                shared.dsp_reset_pending.store(true, Ordering::Release);

                // Signal events via bitmask (single atomic op)
                shared.event_flags.fetch_or(
                    EVENT_TRACK_CHANGED | EVENT_NEEDS_PRELOAD_RESET,
                    Ordering::Release,
                );

                // Signal that metadata needs to be copied by main thread
                // (avoid RwLock writes in audio callback — P0-1 fix)
                shared.gapless_swap_pending.store(true, Ordering::Release);

                let pending_gain_bits = shared.pending_target_gain_db.load(Ordering::Relaxed);
                let pending_gain_db = f64::from_bits(pending_gain_bits);
                loudness_state.set_target_gain(pending_gain_db);

                log::info!("Gapless: switched to next track (gain: {:.2} dB)", pending_gain_db);

                // Reset DSP chain (no Mutex — owned &mut)
                dsp_chain.reset();
                // Reset convolver state for new track
                if let Some(ref mut conv) = owned_convolver {
                    conv.reset();
                }
                *resampler = None;
                resample_leftover.clear();
                *resample_leftover_pos = 0;
                shared.dsp_reset_pending.store(false, Ordering::Release);

                data.fill(0.0);
                return;
            }
        }

        data.fill(0.0);
        // P0 fix: use atomic store instead of try_write() to guarantee state update
        // and event delivery. Previously try_write() could fail if the RwLock was held,
        // silently dropping EVENT_PLAYBACK_ENDED.
        if shared.state.load() == PlayerState::Playing {
            shared.state.store(PlayerState::Stopped);
            shared.event_flags.fetch_or(EVENT_PLAYBACK_ENDED, Ordering::Release);
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

        // Clamp frames_to_read to pre-allocated buffer capacity to prevent
        // heap allocation inside the audio callback (P0-3 fix)
        let max_frames_from_capacity = process_buf.capacity() / channels;
        let frames_to_read = source_frames_needed.min(available_source).min(4096).min(max_frames_from_capacity);
        let start_sample = current_pos * channels;
        let end_sample = start_sample + frames_to_read * channels;

        process_buf.clear();
        {
            let buf = shared.audio_buffer.load();
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

        // Process through unified DSP chain (NO Mutex — owned &mut)
        dsp_chain.process(process_buf, channels);

        // Convolver: apply owned convolver in-place (P0 fix).
        // The convolver is exclusively owned by the callback closure,
        // so we can safely call process_inplace(&mut self).
        // New convolvers are delivered via ArcSwap at the top of this function.
        if let Some(ref mut conv) = owned_convolver {
            // Use pre-allocated convolver_output buffer to avoid allocation
            let buf_len = process_buf.len();
            convolver_output.clear();
            convolver_output.resize(buf_len, 0.0);
            conv.process_into(process_buf, convolver_output);
            process_buf.copy_from_slice(&convolver_output[..buf_len]);
        }

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

        let (ctx, mut chain) = LockfreeDspContext::new(
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
        // Process through owned chain (no Mutex!)
        chain.process(&mut buffer, 2);

        // Should not panic
    }
}