//! Audio callback implementation (lock-free version)
//!
//! Contains the real-time audio processing callback using lock-free DSP chain.
//! All parameter updates use atomic operations, eliminating lock contention
//! between the audio thread and main thread.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use rtrb::Producer;
use super::track_buffer::TrackBuffer;

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
    /// What the stages are set to, read once per block to decide on direct mode.
    probe: TransparencyProbe,
    /// Direct ("bit-perfect") mode: nothing would change the samples, so every
    /// stage is skipped, including the limiter's ~10 ms look-ahead.
    direct: DirectMode,
}

/// Parameter handles needed to tell whether the chain would be a no-op.
struct TransparencyProbe {
    eq: Arc<AtomicEqParams>,
    saturation: Arc<AtomicSaturationParams>,
    crossfeed: Arc<AtomicCrossfeedParams>,
    volume: Arc<AtomicVolumeParams>,
    noise_shaper: Arc<AtomicNoiseShaperParams>,
    dynamic_loudness: Arc<AtomicDynamicLoudnessParams>,
}

impl TransparencyProbe {
    fn chain_is_identity(&self) -> bool {
        let eq = self.eq.read();
        self.volume.effective_volume() == 1.0
            && (!eq.enabled || eq.gains.iter().all(|g| *g == 0.0))
            && !self.saturation.is_enabled()
            && !self.crossfeed.is_enabled()
            && !self.dynamic_loudness.is_enabled()
            && !self.noise_shaper.is_enabled()
    }
}

/// Switching between the full chain and direct mode moves the output by the
/// limiter's look-ahead, so the switch dips to silence and back (~8 ms each way)
/// instead of jumping.
#[derive(Clone, Copy, Debug, PartialEq)]
enum DirectPhase {
    /// No decision yet: the first block picks a mode without a fade.
    Unset,
    Steady,
    FadingOut,
    FadingIn,
}

struct DirectMode {
    active: bool,
    phase: DirectPhase,
    gain: f64,
    /// Frames to stay silent after switching into the chain: its look-ahead
    /// starts out empty, so the fade-in waits for real audio to come through.
    hold: usize,
}

impl DirectMode {
    fn new() -> Self {
        Self { active: false, phase: DirectPhase::Unset, gain: 1.0, hold: 0 }
    }
}

impl VchatDspPipeline {
    fn process_source_pre(&mut self, buffer: &mut [f64], channels: usize) -> Result<(), crate::processor::ProcessError> {
        if self.direct.active { return Ok(()); }
        self.source_pre.process(buffer, channels).map(|_| ())
    }

    fn process_source_post(&mut self, buffer: &mut [f64], channels: usize) -> Result<(), crate::processor::ProcessError> {
        if self.direct.active { return Ok(()); }
        self.source_post.process(buffer, channels).map(|_| ())
    }

    /// Decide once per block whether the chain can be skipped. `others_idle` covers
    /// what the pipeline cannot see: loudness normalization, resampling, convolver.
    fn plan_direct(&mut self, others_idle: bool) {
        let want = others_idle && self.probe.chain_is_identity();
        match self.direct.phase {
            DirectPhase::Unset => {
                self.direct.active = want;
                self.direct.phase = DirectPhase::Steady;
            }
            DirectPhase::Steady if want != self.direct.active => {
                self.direct.phase = DirectPhase::FadingOut;
            }
            // Changed back while fading in: fade out again from where we are.
            DirectPhase::FadingIn if want != self.direct.active => {
                self.direct.phase = DirectPhase::FadingOut;
            }
            _ => {}
        }
    }

    /// Ramp the switch fade over the finished block; flip modes at silence.
    fn apply_direct_fade(&mut self, data: &mut [f64], channels: usize) {
        if !matches!(self.direct.phase, DirectPhase::FadingOut | DirectPhase::FadingIn) {
            return;
        }
        let step = 1.0 / FADE_FRAMES as f64;
        for frame in data.chunks_mut(channels.max(1)) {
            match self.direct.phase {
                DirectPhase::FadingOut => self.direct.gain = (self.direct.gain - step).max(0.0),
                DirectPhase::FadingIn if self.direct.hold > 0 => self.direct.hold -= 1,
                DirectPhase::FadingIn => self.direct.gain = (self.direct.gain + step).min(1.0),
                _ => {}
            }
            for sample in frame.iter_mut() {
                *sample *= self.direct.gain;
            }
        }
        if self.direct.phase == DirectPhase::FadingOut && self.direct.gain <= 0.0 {
            // Silent now: switch, and start the chain from clean state so the
            // limiter's look-ahead holds silence rather than the old audio.
            self.direct.active = !self.direct.active;
            self.reset_stages();
            self.direct.hold = if self.direct.active {
                0
            } else {
                self.source_pre.latency().frames() + self.source_post.latency().frames() + self.output.latency().frames()
            };
            self.direct.phase = DirectPhase::FadingIn;
        } else if self.direct.phase == DirectPhase::FadingIn && self.direct.gain >= 1.0 {
            self.direct.phase = DirectPhase::Steady;
        }
    }

    fn reset_stages(&mut self) {
        let _ = self.source_pre.reset();
        let _ = self.source_post.reset();
        let _ = self.output.reset();
    }

    /// Process the final device-domain stages after the rate boundary.
    pub(crate) fn process_output(
        &mut self,
        buffer: &mut [f64],
        channels: usize,
    ) -> Result<(), crate::processor::ProcessError> {
        if self.direct.active {
            // Nothing scales the signal in direct mode; only keep it inside full scale
            // (a no-op for integer sources, a guard for hot float files).
            for sample in buffer.iter_mut() {
                *sample = sample.clamp(-1.0, 1.0);
            }
            return Ok(());
        }
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
        self.reset_stages();
        // A new stream: pick the mode again without a fade.
        if !matches!(self.direct.phase, DirectPhase::FadingOut | DirectPhase::FadingIn) {
            self.direct.phase = DirectPhase::Unset;
        }
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

        let probe = TransparencyProbe {
            eq: Arc::clone(&ctx.eq_params),
            saturation: Arc::clone(&ctx.saturation_params),
            crossfeed: Arc::clone(&ctx.crossfeed_params),
            volume: Arc::clone(&ctx.volume_params),
            noise_shaper: Arc::clone(&ctx.noise_shaper_params),
            dynamic_loudness: Arc::clone(&ctx.dynamic_loudness_params),
        };
        (
            ctx,
            VchatDspPipeline {
                source_pre,
                source_post,
                output,
                probe,
                direct: DirectMode::new(),
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

/// Crossfade length in source frames of the current track (0 = off).
fn crossfade_frames(shared: &SharedState) -> usize {
    let ms = shared.crossfade_ms.load(Ordering::Relaxed);
    (ms * shared.sample_rate.load(Ordering::Relaxed) / 1000) as usize
}

/// Equal-power crossfade of the block in `buf` (outgoing track, starting `offset`
/// frames into the window) with the first frames of `next`. Appends the incoming
/// frames behind the outgoing ones inside the same pre-allocated buffer (capacity is
/// 8192 frames, blocks are at most 4096), mixes, then truncates: no allocation.
fn mix_crossfade(buf: &mut Vec<f64>, next: &TrackBuffer, offset: usize, window: usize, channels: usize) {
    let n = buf.len();
    let frames = n / channels;
    if buf.capacity() < n * 2 || next.channels() != channels {
        return;
    }
    next.extend_into(offset, frames, buf);
    buf.resize(n + frames * channels, 0.0); // a still-decoding next track fades in from silence
    let (out, inc) = buf.split_at_mut(n);
    for f in 0..frames {
        let t = ((offset + f) as f64 + 0.5) / window as f64;
        let angle = t.clamp(0.0, 1.0) * std::f64::consts::FRAC_PI_2;
        let (g_in, g_out) = angle.sin_cos();
        for c in 0..channels {
            let i = f * channels + c;
            out[i] = out[i] * g_out + inc[i] * g_in;
        }
    }
    buf.truncate(n);
}

/// Frames for a full 0↔1 fade (~8 ms at 48 kHz). Short enough to feel
/// instant, long enough to remove the click of a hard stop/start.
pub const FADE_FRAMES: f32 = 384.0;

/// Ramp the block toward the pause/resume fade target.
#[inline]
fn apply_fade(data: &mut [f64], shared: &SharedState, channels: usize) {
    let target = f32::from_bits(shared.fade_target.load(Ordering::Acquire));
    let mut gain = f32::from_bits(shared.fade_gain.load(Ordering::Relaxed));
    if gain == target && gain == 1.0 {
        return;
    }
    let step = 1.0 / FADE_FRAMES;
    for frame in data.chunks_mut(channels.max(1)) {
        if gain < target {
            gain = (gain + step).min(target);
        } else if gain > target {
            gain = (gain - step).max(target);
        }
        for sample in frame.iter_mut() {
            *sample *= gain as f64;
        }
    }
    shared.fade_gain.store(gain.to_bits(), Ordering::Relaxed);
}

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
    spectrum_tx: &mut Producer<f32>,
    channels: usize,
    process_buf: &mut Vec<f64>,
    resampler: &mut Option<StreamingResampler>,
    resample_leftover: &mut Vec<f64>,
    resample_leftover_pos: &mut usize,
    resample_output: &mut Vec<f64>,
    finalize_output_domain: bool,
) {
    // Shared-mode streams are kept (paused) between tracks and reused. Some
    // backends keep calling a paused stream; never play while not Playing.
    // (WASAPI exclusive drives its own start/stop and passes `false`.)
    if finalize_output_domain && shared.state.load() != PlayerState::Playing {
        data.fill(0.0);
        return;
    }

    // Format-specific chains are prepared before stream construction. The
    // callback only resets state at a block boundary; it never redesigns
    // filters, resizes storage, or logs.
    if shared.dsp_needs_rebuild.compare_exchange(
        true, false, Ordering::AcqRel, Ordering::Acquire
    ).is_ok() {
        dsp_pipeline.reset();
        let _ = convolver.reset();
        // A reused output stream must not carry the previous track's
        // resampler history or buffered output into the new one.
        if let Some(processor) = resampler.as_mut() {
            let _ = processor.reset();
        }
        resample_leftover.clear();
        *resample_leftover_pos = 0;
    }

    dsp_pipeline.plan_direct(!loudness_state.enabled() && resampler.is_none() && convolver.is_idle());

    let has_leftover = *resample_leftover_pos < resample_leftover.len();

    // Gapless and EOF handling
    // The track buffer may still be filling (streaming load). Only frames
    // below `ready` are readable; the length is exact once `complete`.
    let buf = shared.audio_buffer.load();
    let ready = buf.ready_frames() as usize;
    let complete = buf.is_complete();
    let total = buf.duration_frames() as usize;
    if shared.total_frames.load(Ordering::Relaxed) != total as u64 {
        shared.total_frames.store(total as u64, Ordering::Relaxed);
    }
    let mut current_pos = shared.position_frames.load(Ordering::Relaxed) as usize;

    // Decoder has not caught up with the play position (start of a streamed
    // track, or a seek past the decoded range): output silence without
    // advancing and without treating it as end of track.
    if !complete && current_pos >= ready && !has_leftover {
        shared.buffering.store(true, Ordering::Relaxed);
        data.fill(0.0);
        return;
    }

    // Signal preload — request next track preloading early enough to allow
    // full decode + optional resampling before EOF. 5 seconds of lead time
    // handles large files and remote (WebDAV) streams that take longer to decode.
    // Previously used 2 seconds which was insufficient for slow-decoding tracks,
    // causing playback_ended to fire instead of gapless transition.
    let sr = shared.sample_rate.load(Ordering::Relaxed) as usize;
    let remaining_frames = total.saturating_sub(current_pos);
    if remaining_frames > 0
        && remaining_frames < sr * 5 + crossfade_frames(shared)
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

                // Swap in the next track (wait-free ArcSwap). The outgoing
                // buffer is handed to a non-realtime thread to be freed.
                drop(buf);
                let previous = shared.audio_buffer.swap(next);
                let _ = shared.retired_buffers_tx.try_send(previous);
                shared.buffering.store(false, Ordering::Relaxed);
                shared.total_frames.store(next_frames, Ordering::Relaxed);
                shared.sample_rate.store(next_sr, Ordering::Relaxed);
                shared.channels.store(next_ch, Ordering::Relaxed);
                // After a crossfade the incoming track has already played its first frames.
                let faded_from = shared.crossfade_from.swap(u64::MAX, Ordering::Relaxed);
                let start = if faded_from < total as u64 && crossfade_frames(shared) > 0 { (total as u64 - faded_from).min(next_frames) } else { 0 };
                shared.position_frames.store(start, Ordering::Relaxed);

                shared.pending_ready.store(false, Ordering::Release);
                shared.needs_preload.store(false, Ordering::Relaxed);

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

                // Same rate and channels (checked above): keep EQ, convolver, limiter and
                // resampler state running, exactly as if both tracks were one file. Resetting
                // here restarted the output chain from silence at every join and dropped the
                // old track's tail still inside the resampler — an audible dip on live albums.
                resample_leftover.clear();
                *resample_leftover_pos = 0;

                // Continue straight into the next track in this same block
                // instead of emitting a block of silence at the boundary.
                return audio_callback_lockfree(
                    data, shared, dsp_pipeline, convolver, loudness_state, spectrum_tx, channels,
                    process_buf, resampler, resample_leftover, resample_leftover_pos,
                    resample_output, finalize_output_domain,
                );
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

        let available_source = ready.saturating_sub(current_pos);
        if available_source == 0 { break; }

        // Clamp frames_to_read to pre-allocated buffer capacity to prevent
        // heap allocation inside the audio callback (P0-3 fix)
        let max_frames_from_capacity = process_buf.capacity() / channels;
        let mut frames_wanted = source_frames_needed.min(available_source).min(4096).min(max_frames_from_capacity);

        // Crossfade window: the last `xf` frames of a complete track overlap the start
        // of the preloaded next one. A block never straddles the window start, so the
        // decision (fade or plain gapless) is taken exactly once, at its first frame.
        let xf = crossfade_frames(shared).min(total / 2);
        let window_start = total - xf;
        if xf > 0 && complete && current_pos < window_start {
            frames_wanted = frames_wanted.min(window_start - current_pos);
        }
        if xf > 0 && complete && current_pos == window_start {
            let next_ok = shared.pending_ready.load(Ordering::Acquire)
                && shared.pending_sample_rate.load(Ordering::Relaxed) == shared.sample_rate.load(Ordering::Relaxed)
                && shared.pending_channels.load(Ordering::Relaxed) as usize == channels;
            shared.crossfade_from.store(if next_ok { window_start as u64 } else { u64::MAX }, Ordering::Relaxed);
        }

        process_buf.clear();
        let frames_to_read = if buf.channels() == channels {
            buf.extend_into(current_pos, frames_wanted, process_buf)
        } else {
            0
        };
        if frames_to_read == 0 {
            break;
        }

        if xf > 0 && shared.crossfade_from.load(Ordering::Relaxed) == window_start as u64 && current_pos >= window_start {
            if let Some(next) = shared.pending_buffer.load().as_ref() {
                mix_crossfade(process_buf, next, current_pos - window_start, xf, channels);
            }
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

    // The track ended inside this block and the next one is ready: render
    // the rest of the block from it (gapless), rather than padding silence.
    if samples_written < output_len
        && complete
        && current_pos >= ready
        && *resample_leftover_pos >= resample_leftover.len()
        && shared.pending_ready.load(Ordering::Acquire)
        && shared.state.load() == PlayerState::Playing
    {
        drop(buf);
        let (_, rest) = data.split_at_mut(samples_written);
        audio_callback_lockfree(
            rest, shared, dsp_pipeline, convolver, loudness_state, spectrum_tx, channels,
            process_buf, resampler, resample_leftover, resample_leftover_pos,
            resample_output, finalize_output_domain,
        );
        return;
    }

    shared
        .buffering
        .store(samples_written < output_len && !complete, Ordering::Relaxed);

    // Fill remaining with silence
    if samples_written < output_len {
        for i in samples_written..output_len {
            data[i] = 0.0;
        }
    }

    dsp_pipeline.apply_direct_fade(data, channels);
    apply_fade(data, shared, channels);

    // Spectrum output: mono-downmix the first 512 frames and push them to
    // the analysis thread through the wait-free ring in one batch. When the
    // ring is full the analyzer is behind and the excess is dropped.
    if samples_written > 0 {
        let mut mono = [0.0f32; 512];
        let frames = (samples_written / channels).min(mono.len());
        for (frame, slot) in mono[..frames].iter_mut().enumerate() {
            let base = frame * channels;
            let sum: f64 = data[base..base + channels].iter().sum();
            *slot = (sum / channels as f64) as f32;
        }
        let _ = spectrum_tx.push_partial_slice(&mono[..frames]);
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::player::track_buffer::{TrackBuffer, CHUNK_FRAMES};
    use crate::player::state::EVENT_PLAYBACK_ENDED;

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
        shared.audio_buffer.store(TrackBuffer::from_samples(source, CHANNELS));
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
        let (mut spectrum_tx, _spectrum_rx) = rtrb::RingBuffer::new(1);
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
            &mut spectrum_tx,
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
                    &mut spectrum_tx,
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

    /// Minimal 44.1 kHz stereo callback harness without a rate boundary.
    struct StreamingHarness {
        shared: SharedState,
        pipeline: VchatDspPipeline,
        convolver: ConvolverProcessor,
        loudness_state: Arc<AtomicLoudnessState>,
        spectrum_tx: Producer<f32>,
        process_buffer: Vec<f64>,
        resampler: Option<StreamingResampler>,
        leftover: Vec<f64>,
        leftover_pos: usize,
        resample_output: Vec<f64>,
    }

    impl StreamingHarness {
        fn new() -> Self {
            let (context, pipeline) = LockfreeDspContext::new(
                2,
                44_100.0,
                44_100.0,
                Arc::new(AtomicEqParams::new()),
                Arc::new(AtomicSaturationParams::new()),
                Arc::new(AtomicCrossfeedParams::new()),
                Arc::new(AtomicPeakLimiterParams::new()),
                Arc::new(AtomicVolumeParams::new()),
                Arc::new(AtomicNoiseShaperParams::new()),
                Arc::new(AtomicDynamicLoudnessParams::new()),
                Arc::new(AtomicDynamicLoudnessTelemetry::new()),
            );
            let mut convolver = ConvolverProcessor::new(context.convolver_control.clone()).unwrap();
            convolver.set_sample_rate(44_100).unwrap();
            let shared = SharedState::new();
            shared.sample_rate.store(44_100, Ordering::Relaxed);
            shared.channels.store(2, Ordering::Relaxed);
            shared.state.store(PlayerState::Playing);
            let (spectrum_tx, _) = rtrb::RingBuffer::new(4096);
            Self {
                shared,
                pipeline,
                convolver,
                loudness_state: Arc::new(AtomicLoudnessState::new(200.0, 44_100).unwrap()),
                spectrum_tx,
                process_buffer: Vec::with_capacity(8192 * 2),
                resampler: None,
                leftover: Vec::new(),
                leftover_pos: 0,
                resample_output: Vec::new(),
            }
        }

        fn render(&mut self, output: &mut [f64]) {
            audio_callback_lockfree(
                output,
                &self.shared,
                &mut self.pipeline,
                &mut self.convolver,
                &self.loudness_state,
                &mut self.spectrum_tx,
                2,
                &mut self.process_buffer,
                &mut self.resampler,
                &mut self.leftover,
                &mut self.leftover_pos,
                &mut self.resample_output,
                true,
            );
        }

        fn position(&self) -> u64 {
            self.shared.position_frames.load(Ordering::Relaxed)
        }
    }

    fn tone(frames: usize) -> Vec<f64> {
        (0..frames)
            .flat_map(|frame| {
                let v = (std::f64::consts::TAU * 440.0 * frame as f64 / 44_100.0).sin() * 0.1;
                [v, v]
            })
            .collect()
    }

    #[test]
    fn streaming_buffer_waits_for_decoder_instead_of_ending_track() {
        let mut harness = StreamingHarness::new();
        let (buffer, mut writer) = TrackBuffer::new(2, Some((CHUNK_FRAMES * 4) as u64));
        harness.shared.audio_buffer.store(Arc::clone(&buffer));
        let mut output = vec![0.0; 512 * 2];

        // Nothing decoded yet: silence, no progress, still playing.
        assert_no_alloc::assert_no_alloc(|| harness.render(&mut output));
        assert_eq!(harness.position(), 0);
        assert!(harness.shared.buffering.load(Ordering::Relaxed));
        assert_eq!(harness.shared.state.load(), PlayerState::Playing);
        assert_eq!(harness.shared.event_flags.load(Ordering::Relaxed) & EVENT_PLAYBACK_ENDED, 0);
        assert_eq!(
            harness.shared.total_frames.load(Ordering::Relaxed),
            (CHUNK_FRAMES * 4) as u64,
            "duration reports the container estimate while streaming"
        );

        // One chunk published: playback advances through it, then starves again.
        writer.push(&tone(CHUNK_FRAMES)).unwrap();
        let mut rendered = 0;
        while harness.position() < CHUNK_FRAMES as u64 && rendered < 1000 {
            assert_no_alloc::assert_no_alloc(|| harness.render(&mut output));
            rendered += 1;
        }
        assert_eq!(harness.position(), CHUNK_FRAMES as u64);
        assert!(output.iter().all(|s| s.is_finite()));
        harness.render(&mut output);
        assert_eq!(harness.position(), CHUNK_FRAMES as u64);
        assert!(harness.shared.buffering.load(Ordering::Relaxed));
        assert_eq!(harness.shared.state.load(), PlayerState::Playing);

        // Decoder finishes shorter than estimated: duration snaps to the real
        // length and the track ends normally.
        writer.push(&tone(100)).unwrap();
        writer.finish();
        harness.render(&mut output);
        assert!(!harness.shared.buffering.load(Ordering::Relaxed));
        assert_eq!(harness.position(), (CHUNK_FRAMES + 100) as u64);
        assert_eq!(harness.shared.total_frames.load(Ordering::Relaxed), (CHUNK_FRAMES + 100) as u64);
        harness.render(&mut output);
        assert_eq!(harness.shared.state.load(), PlayerState::Stopped);
        assert_ne!(harness.shared.event_flags.load(Ordering::Relaxed) & EVENT_PLAYBACK_ENDED, 0);
    }

    /// A continuous recording split into two tracks must come out exactly as if it were one:
    /// no DSP restart at the join (that is what makes live albums dip).
    fn render_split(split: Option<usize>) -> Vec<f64> {
        let mut harness = StreamingHarness::new();
        let all = tone(12_000);
        match split {
            None => harness.shared.audio_buffer.store(TrackBuffer::from_samples(all, 2)),
            Some(at) => {
                harness.shared.audio_buffer.store(TrackBuffer::from_samples(all[..at * 2].to_vec(), 2));
                harness.shared.pending_buffer.store(Some(TrackBuffer::from_samples(all[at * 2..].to_vec(), 2)));
                harness.shared.pending_total_frames.store((12_000 - at) as u64, Ordering::Relaxed);
                harness.shared.pending_sample_rate.store(44_100, Ordering::Relaxed);
                harness.shared.pending_channels.store(2, Ordering::Relaxed);
                harness.shared.pending_ready.store(true, Ordering::Release);
            }
        }
        harness.shared.total_frames.store(split.unwrap_or(12_000) as u64, Ordering::Relaxed);
        let mut out = Vec::new();
        let mut block = vec![0.0; 512 * 2];
        for _ in 0..16 {
            harness.render(&mut block);
            out.extend_from_slice(&block);
        }
        out
    }

    fn max_join_error() -> f64 {
        let one = render_split(None);
        let two = render_split(Some(3_001));
        let peak = one.iter().fold(0.0f64, |m, s| m.max(s.abs()));
        assert!(peak > 0.02, "signal reaches the output (peak {peak})");
        one.iter().zip(&two).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max)
    }

    #[test]
    fn gapless_join_continues_like_one_track() {
        // Before: the next track restarted from silence (error 0.067 on a 0.1 tone).
        // What is left is the loudness stage re-applying the (equal) target gain: < -70 dB.
        let e = max_join_error();
        assert!(e < 2e-4, "join error {e}");
    }

    /// Harness whose parameters we keep, with every stage switched off.
    fn transparent_harness() -> (StreamingHarness, Arc<AtomicEqParams>, Arc<AtomicVolumeParams>) {
        let eq = Arc::new(AtomicEqParams::new());
        let vol = Arc::new(AtomicVolumeParams::new());
        let sat = Arc::new(AtomicSaturationParams::new());
        let cf = Arc::new(AtomicCrossfeedParams::new());
        let ns = Arc::new(AtomicNoiseShaperParams::new());
        let dl = Arc::new(AtomicDynamicLoudnessParams::new());
        let (context, pipeline) = LockfreeDspContext::new(
            2, 44_100.0, 44_100.0,
            Arc::clone(&eq), Arc::clone(&sat), Arc::clone(&cf),
            Arc::new(AtomicPeakLimiterParams::new()), Arc::clone(&vol), Arc::clone(&ns), Arc::clone(&dl),
            Arc::new(AtomicDynamicLoudnessTelemetry::new()),
        );
        vol.set_volume(1.0);
        eq.set_enabled(false);
        sat.set_enabled(false);
        cf.set_enabled(false);
        ns.set_enabled(false);
        dl.set_enabled(false);
        let mut h = StreamingHarness::new();
        let mut convolver = ConvolverProcessor::new(context.convolver_control.clone()).unwrap();
        convolver.set_sample_rate(44_100).unwrap();
        h.pipeline = pipeline;
        h.convolver = convolver;
        h.loudness_state.set_enabled(false);
        (h, eq, vol)
    }

    fn pcm16_noise(frames: usize) -> Vec<f64> {
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        (0..frames * 2)
            .map(|_| {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                ((seed >> 48) as i16) as f64 / 32768.0 * 0.5
            })
            .collect()
    }

    #[test]
    fn direct_mode_outputs_the_source_bit_for_bit() {
        // Before: with every effect off the limiter still delayed the output by
        // ~10 ms and its smoothing touched the samples, so nothing was bit-exact.
        let (mut h, _, _) = transparent_harness();
        let src = pcm16_noise(20_000);
        h.shared.audio_buffer.store(TrackBuffer::from_samples(src.clone(), 2));
        let mut out = Vec::new();
        let mut block = vec![0.0; 1000 * 2];
        for _ in 0..12 { h.render(&mut block); out.extend_from_slice(&block); }
        assert_eq!(&out[..], &src[..out.len()], "direct mode must be a straight copy");
    }

    #[test]
    fn leaving_direct_mode_dips_instead_of_clicking() {
        let (mut h, eq, _) = transparent_harness();
        let tone: Vec<f64> = (0..40_000).flat_map(|i| { let v = (i as f64 * 0.05).sin() * 0.3; [v, v] }).collect();
        h.shared.audio_buffer.store(TrackBuffer::from_samples(tone, 2));
        let mut out = Vec::new();
        let mut block = vec![0.0; 512 * 2];
        for _ in 0..4 { h.render(&mut block); out.extend_from_slice(&block); }
        let mut gains = [0.0; crate::processor::EQ_BANDS];
        gains[5] = 3.0;
        eq.write(&gains, true); // EQ on: the chain is needed again
        for _ in 0..30 { h.render(&mut block); out.extend_from_slice(&block); }
        let left: Vec<f64> = out.chunks(2).map(|f| f[0]).collect();
        let worst = left.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f64::max);
        // A 0.05 rad/sample tone moves at most ~0.015 per sample at 0.3 amplitude.
        assert!(worst < 0.03, "step at the switch {worst}");
        assert!(left[left.len() - 200..].iter().any(|s| s.abs() > 0.15), "audio is back after the switch");
    }

    #[test]
    fn entering_direct_mode_dips_instead_of_clicking() {
        let (mut h, eq, _) = transparent_harness();
        let mut gains = [0.0; crate::processor::EQ_BANDS];
        gains[5] = 3.0;
        eq.write(&gains, true);
        let tone: Vec<f64> = (0..40_000).flat_map(|i| { let v = (i as f64 * 0.05).sin() * 0.3; [v, v] }).collect();
        h.shared.audio_buffer.store(TrackBuffer::from_samples(tone, 2));
        let mut out = Vec::new();
        let mut block = vec![0.0; 512 * 2];
        for _ in 0..6 { h.render(&mut block); out.extend_from_slice(&block); }
        eq.set_enabled(false); // back to nothing-to-do: the limiter look-ahead is dropped
        for _ in 0..30 { h.render(&mut block); out.extend_from_slice(&block); }
        let left: Vec<f64> = out.chunks(2).map(|f| f[0]).collect();
        let worst = left[1500..].windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f64::max);
        assert!(worst < 0.03, "step at the switch {worst}");
        assert!(left[left.len() - 200..].iter().any(|s| s.abs() > 0.15), "audio is back after the switch");
    }

    #[test]
    fn crossfade_overlaps_the_next_track_and_hands_over_its_position() {
        const A: usize = 8_000;
        const B: usize = 9_000;
        const XF: usize = 1_984; // 45 ms at 44.1 kHz
        let mut harness = StreamingHarness::new();
        harness.shared.crossfade_ms.store(45, Ordering::Relaxed);
        harness.shared.audio_buffer.store(TrackBuffer::from_samples(vec![0.4; A * 2], 2));
        harness.shared.pending_buffer.store(Some(TrackBuffer::from_samples(vec![-0.4; B * 2], 2)));
        harness.shared.pending_total_frames.store(B as u64, Ordering::Relaxed);
        harness.shared.pending_sample_rate.store(44_100, Ordering::Relaxed);
        harness.shared.pending_channels.store(2, Ordering::Relaxed);
        harness.shared.pending_ready.store(true, Ordering::Release);

        // Pull frame by frame-ish blocks until the first track is over.
        let mut source = Vec::new();
        let mut block = vec![0.0; 500 * 2];
        while source.len() < (A + 2000) * 2 {
            harness.render(&mut block);
            source.extend_from_slice(&block);
        }
        // The swap happened at the end of A: the incoming track already played XF frames.
        assert!(harness.position() >= XF as u64 && harness.position() < (XF + 2500) as u64,
            "position after swap {}", harness.position());
        let left: Vec<f64> = source.chunks(2).map(|f| f[0]).collect();
        // The chain adds a little latency, so look for the crossing rather than a fixed frame:
        // the level goes from the outgoing (+) to the incoming (-) track inside the window,
        // not at the end of A as a plain join would.
        assert!(left[1000] > 0.1, "outgoing before the window");
        let crossing = (A - XF..A).find(|&i| left[i] < 0.0).expect("incoming takes over inside the window");
        assert!(crossing < A - XF / 4, "crossing at {crossing}, window {}..{A}", A - XF);
        assert!(left[A + 1000] < -0.1, "only the next track after the window");
        // Equal-power curve: no jump between neighbouring samples inside the window.
        let worst = left[A - XF..A + 50].windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f64::max);
        assert!(worst < 0.01, "step inside the crossfade {worst}");
    }

    #[test]
    fn crossfade_off_keeps_the_plain_gapless_join() {
        let mut harness = StreamingHarness::new();
        harness.shared.audio_buffer.store(TrackBuffer::from_samples(vec![0.4; 3_000 * 2], 2));
        harness.shared.pending_buffer.store(Some(TrackBuffer::from_samples(vec![-0.4; 3_000 * 2], 2)));
        harness.shared.pending_total_frames.store(3_000, Ordering::Relaxed);
        harness.shared.pending_sample_rate.store(44_100, Ordering::Relaxed);
        harness.shared.pending_channels.store(2, Ordering::Relaxed);
        harness.shared.pending_ready.store(true, Ordering::Release);
        let mut block = vec![0.0; 1000 * 2];
        for _ in 0..4 { harness.render(&mut block); }
        assert_eq!(harness.position(), 1_000, "next track starts from its first frame");
    }

    #[test]
    fn gapless_swap_into_a_still_decoding_buffer_retires_the_old_one() {
        let mut harness = StreamingHarness::new();
        harness.shared.audio_buffer.store(TrackBuffer::from_samples(tone(256), 2));
        let (next, mut writer) = TrackBuffer::new(2, None);
        writer.push(&tone(CHUNK_FRAMES)).unwrap();
        harness.shared.pending_buffer.store(Some(Arc::clone(&next)));
        harness.shared.pending_sample_rate.store(44_100, Ordering::Relaxed);
        harness.shared.pending_channels.store(2, Ordering::Relaxed);
        harness.shared.pending_ready.store(true, Ordering::Release);

        let mut output = vec![0.0; 2048 * 2];
        // The 256-frame track ends mid-block; the rest of the same block
        // comes from the next track, with no silent block in between.
        harness.render(&mut output);
        assert!(Arc::ptr_eq(&harness.shared.audio_buffer.load_full(), &next));
        assert_eq!(harness.shared.retired_buffers_rx.len(), 1, "old buffer freed off the audio thread");
        assert_eq!(harness.position(), 2048 - 256);
        assert!(
            output[1024 * 2..].iter().any(|s| s.abs() > 1e-4),
            "the rest of the boundary block must carry the next track"
        );
        let mut output = vec![0.0; 512 * 2];
        harness.render(&mut output);
        assert_eq!(harness.position(), 2048 - 256 + 512);
        assert_eq!(harness.shared.state.load(), PlayerState::Playing);
    }

    #[test]
    fn pause_fades_out_and_resume_fades_in_without_steps() {
        let mut harness = StreamingHarness::new();
        harness.shared.audio_buffer.store(TrackBuffer::from_samples(vec![0.5; 44_100 * 2], 2));
        let mut output = vec![0.0; 512 * 2];
        for _ in 0..8 {
            harness.render(&mut output); // settle limiter / smoothing
        }
        harness.shared.fade_target.store(0.0f32.to_bits(), Ordering::Release);
        harness.render(&mut output);
        let left: Vec<f64> = output.chunks(2).map(|f| f[0]).collect();
        assert!(left[0].abs() > 0.05, "fade starts from the current level");
        assert!(left[(FADE_FRAMES as usize) + 1..].iter().all(|s| s.abs() < 1e-9), "silent after the fade");
        for pair in left.windows(2).take(FADE_FRAMES as usize) {
            assert!((pair[0] - pair[1]).abs() < 0.01, "no step during the fade");
        }

        harness.shared.fade_target.store(1.0f32.to_bits(), Ordering::Release);
        harness.render(&mut output);
        let left: Vec<f64> = output.chunks(2).map(|f| f[0]).collect();
        assert!(left[0].abs() < 0.01, "resume starts from silence");
        assert!(left[511].abs() > 0.05, "and is back at level within the block");
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