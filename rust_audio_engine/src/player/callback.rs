//! Audio callback implementation (lock-free version)
//!
//! Contains the real-time audio processing callback using lock-free DSP chain.
//! All parameter updates use atomic operations, eliminating lock contention
//! between the audio thread and main thread.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use crossbeam::channel::Sender;

use super::state::{SharedState, PlayerState,
    EVENT_TRACK_CHANGED, EVENT_NEEDS_PRELOAD_RESET, EVENT_PLAYBACK_ENDED};
use crate::processor::{
    AudioBlockMut, ConvolverControl, ConvolverProcessor, DspChain, ProcessBuffers,
    StreamingProcessor, StreamingResampler, AtomicLoudnessState,
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

/// Lock-free DSP context for audio callback.
///
/// The callback exclusively owns mutable DSP and [`ConvolverProcessor`] state.
/// Atomic parameter snapshots cross from control to audio, while
/// [`ConvolverControl`] transfers unique kernel ownership through bounded
/// publication and retirement slots. Kernel construction and destruction stay
/// on the control thread.
pub struct LockfreeDspContext {
    /// Lock-free parameter references (shared with main thread, read atomically)
    pub eq_params: Arc<AtomicEqParams>,
    pub saturation_params: Arc<AtomicSaturationParams>,
    pub crossfeed_params: Arc<AtomicCrossfeedParams>,
    pub limiter_params: Arc<AtomicPeakLimiterParams>,
    pub volume_params: Arc<AtomicVolumeParams>,
    pub noise_shaper_params: Arc<AtomicNoiseShaperParams>,
    pub dynamic_loudness_params: Arc<AtomicDynamicLoudnessParams>,

    /// Single-consumer, wait-free convolver ownership handoff.
    pub convolver_control: ConvolverControl,
    /// Source-rate domain used when publishing newly merged kernels.
    convolver_sample_rate_hz: AtomicU64,

    /// IR kernel sources — only accessed from non-realtime command handling path.
    /// Protected by Mutex because they are only read/written from the audio thread's
    /// command processing loop (not from the audio callback itself).
    external_ir_kernel: parking_lot::Mutex<Option<(Vec<f64>, usize)>>,
    fir_ir_kernel: parking_lot::Mutex<Option<(Vec<f64>, usize)>>,
}

/// Callback-owned canonical VChat DSP domains.
pub struct VchatDspPipeline {
    /// Source domain before convolution: Volume → EQ → Saturation → Crossfeed.
    source_pre: DspChain,
    /// Source domain after convolution: Dynamic Loudness.
    source_post: DspChain,
    /// Device/output domain after Rubato: final True-Peak Limiter → Noise Shaper.
    output: DspChain,
}

impl VchatDspPipeline {
    fn process_source_pre(&mut self, buffer: &mut [f64], channels: usize) -> Result<(), crate::processor::ProcessError> {
        self.source_pre.process(buffer, channels).map(|_| ())
    }

    fn process_source_post(&mut self, buffer: &mut [f64], channels: usize) -> Result<(), crate::processor::ProcessError> {
        self.source_post.process(buffer, channels).map(|_| ())
    }

    /// Process the final device-domain stages after the rate boundary.
    pub(crate) fn process_output(
        &mut self,
        buffer: &mut [f64],
        channels: usize,
    ) -> Result<(), crate::processor::ProcessError> {
        self.output.process(buffer, channels).map(|_| ())
    }

    /// Reconfigure only the final device-domain stages after WASAPI has
    /// negotiated its actual exclusive-mode sample rate.
    pub(crate) fn set_output_sample_rate(
        &mut self,
        sample_rate_hz: u32,
    ) -> Result<(), crate::processor::ProcessError> {
        self.output.set_sample_rate(sample_rate_hz)
    }

    fn reset(&mut self) {
        let _ = self.source_pre.reset();
        let _ = self.source_post.reset();
        let _ = self.output.reset();
    }
}

impl LockfreeDspContext {
    /// Create a lock-free context and canonical source/output-domain pipeline.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        channels: usize,
        source_sample_rate: f64,
        output_sample_rate: f64,
        eq_params: Arc<AtomicEqParams>,
        saturation_params: Arc<AtomicSaturationParams>,
        crossfeed_params: Arc<AtomicCrossfeedParams>,
        limiter_params: Arc<AtomicPeakLimiterParams>,
        volume_params: Arc<AtomicVolumeParams>,
        noise_shaper_params: Arc<AtomicNoiseShaperParams>,
        dynamic_loudness_params: Arc<AtomicDynamicLoudnessParams>,
        dynamic_loudness_telemetry: Arc<AtomicDynamicLoudnessTelemetry>,
    ) -> (Self, VchatDspPipeline) {
        let source_sample_rate_hz = source_sample_rate.max(1.0) as u32;
        let output_sample_rate_hz = output_sample_rate.max(1.0) as u32;

        let mut source_pre = DspChain::with_capacity(4, source_sample_rate_hz)
            .expect("validated callback source rate");
        source_pre
            .add(VolumeProcessor::new(Arc::clone(&volume_params)))
            .expect("volume belongs to fixed source domain");
        source_pre
            .add(EqProcessor::new(channels, source_sample_rate, Arc::clone(&eq_params)))
            .expect("EQ belongs to fixed source domain");
        source_pre
            .add(SaturationProcessor::new(channels, Arc::clone(&saturation_params)))
            .expect("saturation belongs to fixed source domain");
        source_pre
            .add(CrossfeedProcessor::new(source_sample_rate, Arc::clone(&crossfeed_params)))
            .expect("crossfeed belongs to fixed source domain");

        let mut source_post = DspChain::with_capacity(1, source_sample_rate_hz)
            .expect("validated callback source rate");
        source_post
            .add(
                DynamicLoudnessProcessor::new(
                    channels,
                    source_sample_rate_hz,
                    Arc::clone(&dynamic_loudness_params),
                    Arc::clone(&dynamic_loudness_telemetry),
                )
                .expect("validated dynamic-loudness geometry"),
            )
            .expect("dynamic loudness belongs to fixed source domain");

        let mut output = DspChain::with_capacity(2, output_sample_rate_hz)
            .expect("validated callback output rate");
        output
            .add(
                PeakLimiterProcessor::new_with_output_guard(
                    channels,
                    output_sample_rate_hz,
                    Arc::clone(&limiter_params),
                    Arc::clone(&noise_shaper_params),
                )
                .expect("validated final limiter geometry"),
            )
            .expect("limiter belongs to fixed output domain");
        output
            .add(
                NoiseShaperProcessor::new(
                    channels,
                    output_sample_rate_hz,
                    Arc::clone(&noise_shaper_params),
                )
                .expect("validated noise-shaper geometry"),
            )
            .expect("noise shaper belongs to fixed output domain");

        let ctx = Self {
            eq_params,
            saturation_params,
            crossfeed_params,
            limiter_params,
            volume_params,
            noise_shaper_params,
            dynamic_loudness_params,
            convolver_control: ConvolverControl::new(false),
            convolver_sample_rate_hz: AtomicU64::new(source_sample_rate_hz as u64),
            external_ir_kernel: parking_lot::Mutex::new(None),
            fir_ir_kernel: parking_lot::Mutex::new(None),
        };

        (
            ctx,
            VchatDspPipeline {
                source_pre,
                source_post,
                output,
            },
        )
    }

    fn rebuild_merged_convolver(&self) -> Result<(), String> {
        let external = self.external_ir_kernel.lock().clone();
        let fir = self.fir_ir_kernel.lock().clone();

        let merged = match (external, fir) {
            (None, None) => None,
            (Some((ir, channels)), None) | (None, Some((ir, channels))) => Some(
                FFTConvolver::new(&ir, channels)
                    .map_err(|error| format!("Failed to build convolver: {error}"))?,
            ),
            (Some((external_ir, ext_channels)), Some((fir_ir, fir_channels))) => {
                if ext_channels != fir_channels {
                    return Err(format!(
                        "Cannot merge kernels with different channels: external={}, fir={}",
                        ext_channels, fir_channels
                    ));
                }

                let merged_ir = convolve_interleaved_ir(&external_ir, &fir_ir, ext_channels)?;
                Some(
                    FFTConvolver::new(&merged_ir, ext_channels)
                        .map_err(|error| format!("Failed to build merged convolver: {error}"))?,
                )
            }
        };

        match merged {
            Some(convolver) => {
                let sample_rate_hz = self
                    .convolver_sample_rate_hz
                    .load(Ordering::Acquire) as u32;
                self.convolver_control
                    .publish_at_rate(convolver, sample_rate_hz)
                    .map_err(|error| format!("Failed to publish convolver: {error}"))?;
                self.convolver_control.set_enabled(true);
            }
            None => self.convolver_control.set_enabled(false),
        }
        Ok(())
    }

    /// Set the source sample-rate domain used by subsequently published kernels.
    /// Existing IR sources are republished for the new domain on the control thread.
    pub fn set_convolver_sample_rate(&self, sample_rate_hz: u32) -> Result<(), String> {
        if sample_rate_hz == 0 {
            return Err("Convolver sample rate must be non-zero".to_string());
        }
        self.convolver_sample_rate_hz
            .store(sample_rate_hz as u64, Ordering::Release);
        self.rebuild_merged_convolver()
    }

    /// Reclaim retired kernels on the non-realtime command thread.
    pub fn reclaim_retired_convolver(&self) {
        while self.convolver_control.reclaim_retired() {}
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

/// Main f64 audio callback core shared by CPAL and WASAPI.
///
/// CPAL executes the complete source/rate/output chain and converts to f32 only
/// after this function returns. WASAPI requests source-domain rendering here,
/// performs its negotiated Rubato boundary, then invokes the same pipeline's
/// final device-domain limiter and noise shaper.
#[allow(clippy::too_many_arguments)]
pub fn audio_callback_lockfree(
    data: &mut [f64],
    shared: &SharedState,
    dsp_pipeline: &mut VchatDspPipeline,
    convolver: &mut ConvolverProcessor,
    loudness_state: &Arc<AtomicLoudnessState>,
    spectrum_tx: &Sender<f64>,
    channels: usize,
    process_buf: &mut Vec<f64>,
    resampler: &mut Option<StreamingResampler>,
    resample_leftover: &mut Vec<f64>,
    resample_leftover_pos: &mut usize,
    resample_output: &mut Vec<f64>,
    finalize_output_domain: bool,
) {
    // Format-specific chains are prepared before stream construction. The
    // callback only resets state at a block boundary; it never redesigns
    // filters, resizes storage, or logs.
    if shared.dsp_needs_rebuild.compare_exchange(
        true, false, Ordering::AcqRel, Ordering::Acquire
    ).is_ok() {
        dsp_pipeline.reset();
        let _ = convolver.reset();
    }

    let has_leftover = *resample_leftover_pos < resample_leftover.len();

    // Gapless and EOF handling
    let total = shared.total_frames.load(Ordering::Relaxed) as usize;
    let mut current_pos = shared.position_frames.load(Ordering::Relaxed) as usize;

    // Signal preload — request next track preloading early enough to allow
    // full decode + optional resampling before EOF. 5 seconds of lead time
    // handles large files and remote (WebDAV) streams that take longer to decode.
    // Previously used 2 seconds which was insufficient for slow-decoding tracks,
    // causing playback_ended to fire instead of gapless transition.
    let sr = shared.sample_rate.load(Ordering::Relaxed) as usize;
    let remaining_frames = total.saturating_sub(current_pos);
    if remaining_frames > 0
        && remaining_frames < sr * 5
        && !shared.pending_ready.load(Ordering::Relaxed)
        && !shared.needs_preload.load(Ordering::Acquire)
    {
        shared.needs_preload.store(true, Ordering::Release);
    }

    // EOF Detection with gapless
    if current_pos >= total && !has_leftover {
        if shared.pending_ready.load(Ordering::Acquire) {
            // Atomically take the preloaded Arc without cloning the track data.
            if let Some(next) = shared.pending_buffer.swap(None) {
                let next_frames = shared.pending_total_frames.load(Ordering::Relaxed);
                let next_sr = shared.pending_sample_rate.load(Ordering::Relaxed);
                let next_ch = shared.pending_channels.load(Ordering::Relaxed);
                let current_sr = shared.sample_rate.load(Ordering::Relaxed);
                let resampler_geometry_matches = resampler
                    .as_ref()
                    .map(|processor| processor.from_rate() == next_sr as u32)
                    .unwrap_or(next_sr == current_sr);

                // Gapless preload normalizes into the active source domain.
                // Reject inconsistent publication rather than deleting the
                // source-to-device rate boundary and playing at the wrong rate.
                if next_sr != current_sr
                    || next_ch as usize != channels
                    || !resampler_geometry_matches
                {
                    shared.pending_ready.store(false, Ordering::Release);
                    shared.needs_preload.store(false, Ordering::Relaxed);
                    data.fill(0.0);
                    return;
                }

                // Store new audio buffer (wait-free ArcSwap)
                shared.audio_buffer.store(next);
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

                // Reset every canonical DSP domain and preserve the existing
                // source-to-device Rubato geometry for the next normalized track.
                dsp_pipeline.reset();
                let _ = convolver.reset();
                if let Some(processor) = resampler.as_mut() {
                    let _ = processor.reset();
                }
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
            *dst = *src;
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

        // Source position is committed only after every DSP/rate stage accepts
        // the complete block. A backend error must not silently discard audio.

        // ===== DSP Chain Processing (LOCK-FREE) =====
        // Apply loudness normalization (atomic, no lock)
        let frames_in_chunk = process_buf.len() / channels;
        let linear_gain = loudness_state.process_gain(frames_in_chunk);
        for sample in process_buf.iter_mut() {
            *sample *= linear_gain;
        }

        // Canonical source-domain prefix:
        // Volume → EQ → Saturation → Crossfeed.
        if dsp_pipeline.process_source_pre(process_buf, channels).is_err() {
            process_buf.fill(0.0);
        }

        // Canonical source-domain Convolver stage. Kernel adoption and
        // retirement are wait-free and preserve unique ownership.
        let convolver_block = match AudioBlockMut::new(process_buf, channels) {
            Ok(block) => block,
            Err(_) => {
                data[samples_written..].fill(0.0);
                return;
            }
        };
        if convolver
            .process(ProcessBuffers::in_place(convolver_block))
            .is_err()
        {
            data[samples_written..].fill(0.0);
            return;
        }

        // Canonical source-domain suffix: Dynamic Loudness.
        if dsp_pipeline.process_source_post(process_buf, channels).is_err() {
            process_buf.fill(0.0);
        }

        // Rubato rate boundary, then final output-domain limiter/noise shaping.
        if let Some(rs) = resampler {
            let progress = match rs.process_chunk_into(process_buf, resample_output) {
                Ok(progress) if progress.consumed_frames() == frames_to_read => progress,
                Ok(_) | Err(_) => {
                    data[samples_written..].fill(0.0);
                    return;
                }
            };
            current_pos += progress.consumed_frames();
            shared.position_frames.store(current_pos as u64, Ordering::Relaxed);
            let samples_resampled = progress.produced_frames() * channels;
            if finalize_output_domain
                && dsp_pipeline
                    .process_output(&mut resample_output[..samples_resampled], channels)
                    .is_err()
            {
                resample_output[..samples_resampled].fill(0.0);
            }
            
            let mut chunk_idx = 0;
            while samples_written < output_len && chunk_idx < samples_resampled {
                data[samples_written] = resample_output[chunk_idx];
                samples_written += 1;
                chunk_idx += 1;
            }

            if chunk_idx < samples_resampled {
                resample_leftover.extend_from_slice(&resample_output[chunk_idx..samples_resampled]);
                *resample_leftover_pos = 0;
            }
        } else {
            if finalize_output_domain
                && dsp_pipeline.process_output(process_buf, channels).is_err()
            {
                data[samples_written..].fill(0.0);
                return;
            }
            current_pos += frames_to_read;
            shared.position_frames.store(current_pos as u64, Ordering::Relaxed);
            let take = process_buf.len().min(output_len - samples_written);
            for i in 0..take {
                data[samples_written + i] = process_buf[i];
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
                    sum += data[i + c];
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
    use crossbeam::channel::bounded;

    fn assert_callback_geometry_is_allocation_free(
        source_sample_rate: u32,
        output_sample_rate: u32,
        callback_frames: usize,
    ) {
        const CHANNELS: usize = 2;
        const SOURCE_FRAMES: usize = 131_072;

        let eq_params = Arc::new(AtomicEqParams::new());
        let saturation_params = Arc::new(AtomicSaturationParams::new());
        let crossfeed_params = Arc::new(AtomicCrossfeedParams::new());
        let limiter_params = Arc::new(AtomicPeakLimiterParams::new());
        let volume_params = Arc::new(AtomicVolumeParams::new());
        let noise_shaper_params = Arc::new(AtomicNoiseShaperParams::new());
        let dynamic_loudness_params = Arc::new(AtomicDynamicLoudnessParams::new());
        let dynamic_loudness_telemetry =
            Arc::new(AtomicDynamicLoudnessTelemetry::new());

        let (context, mut pipeline) = LockfreeDspContext::new(
            CHANNELS,
            source_sample_rate as f64,
            output_sample_rate as f64,
            eq_params,
            saturation_params,
            crossfeed_params,
            limiter_params,
            volume_params,
            noise_shaper_params,
            dynamic_loudness_params,
            dynamic_loudness_telemetry,
        );
        let mut convolver =
            ConvolverProcessor::new(context.convolver_control.clone()).unwrap();
        convolver.set_sample_rate(source_sample_rate).unwrap();

        let shared = SharedState::new();
        let source = (0..SOURCE_FRAMES)
            .flat_map(|frame| {
                let phase = std::f64::consts::TAU * 997.0 * frame as f64
                    / source_sample_rate as f64;
                [phase.sin() * 0.1, phase.cos() * 0.1]
            })
            .collect::<Vec<_>>();
        shared.audio_buffer.store(Arc::new(source));
        shared
            .sample_rate
            .store(source_sample_rate as u64, Ordering::Relaxed);
        shared.channels.store(CHANNELS as u64, Ordering::Relaxed);
        shared
            .total_frames
            .store(SOURCE_FRAMES as u64, Ordering::Relaxed);
        shared.state.store(PlayerState::Playing);

        let loudness_state =
            Arc::new(AtomicLoudnessState::new(200.0, source_sample_rate).unwrap());
        let (spectrum_tx, _spectrum_rx) = bounded(1);
        let mut process_buffer = Vec::with_capacity(8192 * CHANNELS);
        let mut resampler = if source_sample_rate == output_sample_rate {
            None
        } else {
            Some(
                StreamingResampler::with_phase(
                    CHANNELS,
                    source_sample_rate,
                    output_sample_rate,
                    crate::config::PhaseResponse::Linear,
                )
                .unwrap(),
            )
        };
        let output_capacity_frames = resampler
            .as_ref()
            .and_then(|processor| processor.process_output_capacity_frames(4096).ok())
            .unwrap_or(4096);
        let mut resample_leftover =
            Vec::with_capacity(output_capacity_frames * CHANNELS);
        let mut resample_leftover_pos = 0usize;
        let mut resample_output = vec![0.0; output_capacity_frames * CHANNELS];
        let mut output = vec![0.0; callback_frames * CHANNELS];

        // Exercise lazy snapshot reads and the first Rubato block before
        // measuring steady-state callback behavior.
        audio_callback_lockfree(
            &mut output,
            &shared,
            &mut pipeline,
            &mut convolver,
            &loudness_state,
            &spectrum_tx,
            CHANNELS,
            &mut process_buffer,
            &mut resampler,
            &mut resample_leftover,
            &mut resample_leftover_pos,
            &mut resample_output,
            true,
        );

        assert_no_alloc::assert_no_alloc(|| {
            for _ in 0..24 {
                audio_callback_lockfree(
                    &mut output,
                    &shared,
                    &mut pipeline,
                    &mut convolver,
                    &loudness_state,
                    &spectrum_tx,
                    CHANNELS,
                    &mut process_buffer,
                    &mut resampler,
                    &mut resample_leftover,
                    &mut resample_leftover_pos,
                    &mut resample_output,
                    true,
                );
            }
        });

        assert!(output.iter().all(|sample| sample.is_finite()));
    }

    #[test]
    fn callback_is_allocation_free_for_device_blocks_and_rate_matrix() {
        for (source_rate, output_rate) in [
            (44_100, 44_100),
            (44_100, 48_000),
            (48_000, 44_100),
            (48_000, 96_000),
            (96_000, 48_000),
        ] {
            for callback_frames in [128, 256, 512] {
                assert_callback_geometry_is_allocation_free(
                    source_rate,
                    output_rate,
                    callback_frames,
                );
            }
        }
    }

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

        let (_ctx, mut pipeline) = LockfreeDspContext::new(
            2,
            44100.0,
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

        // Test that atomic parameters can be updated while every callback-owned
        // source/output domain remains exclusively mutable and lock-free.
        eq_params.set_band_gain(0, 3.0);

        let mut buffer = vec![0.5; 100];
        pipeline.process_source_pre(&mut buffer, 2).unwrap();
        pipeline.process_source_post(&mut buffer, 2).unwrap();
        pipeline.process_output(&mut buffer, 2).unwrap();

        assert!(buffer.iter().all(|sample| sample.is_finite()));
    }
}