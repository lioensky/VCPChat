//! Pure-Rust interleaved resampler backend built on rubato 4.
//!
//! This backend adapts rubato's fixed-input-chunk interface to the same
//! streaming semantics the SoXR backend provides natively:
//!
//! - **Arbitrary input granularity.** Caller input of any size is staged in a
//!   pre-allocated input FIFO; rubato only ever sees exact setup-selected
//!   chunks, so the produced sample sequence is independent of how the caller
//!   splits its input (chunked and single-feed runs are bitwise identical).
//! - **Linear delay compensation.** The rubato FFT and sinc engines used for
//!   [`PhaseResponse::Linear`] carry a real leading delay. The adapter discards
//!   `output_delay()` produced frames at stream start (and again after reset),
//!   so callers receive an aligned duration sequence.
//! - **Nonlinear causal tails.** [`PhaseResponse::Minimum`] and
//!   [`PhaseResponse::Maximum`] use a setup-designed engine over the
//!   real-cepstrum minimum-phase kernel instead of pretending that a delay
//!   shift changes phase: a spectral (FFT block-convolution) engine for small
//!   reduced interpolation factors and a contiguous time-domain polyphase
//!   engine for large ones. Both retain the actual causal latency and finite
//!   tail through the streaming lifecycle.
//! - **Bounded drain.** At end of stream the adapter feeds preallocated zeros
//!   only until the duration sequence (and, for nonlinear phase, its declared
//!   finite tail) is complete, after which `drain` reports the terminal zero.
//! - **Allocation-free processing.** All buffers are allocated in `new`;
//!   `process`/`drain`/`clear` stay within pre-reserved capacity and rubato's
//!   `process_into_buffer` is itself allocation-free.
//!
//! For [`PhaseResponse::Linear`], exact 2:1 High-quality upsampling uses a
//! dedicated symmetric half-band FIR. Other common reduced sample-rate ratios
//! use the much faster rubato FFT engine at every quality tier: UltraHigh
//! selects a single FFT sub-chunk (a 2x longer internal FIR) while Low through
//! High batch two FFT sub-chunks in each 1024-frame call. Only ratios that
//! would create pathological FFT blocks fall back to sinc, where the quality
//! mapping selects sinc length / oversampling rather than a SoX recipe. For
//! [`PhaseResponse::Minimum`] and [`PhaseResponse::Maximum`], reduced
//! interpolation factors up to [`SPECTRAL_NONLINEAR_MAX_UP`] use the exact
//! spectral rational resampler whose complex kernel spectrum comes from the
//! precomputed real-cepstrum design; larger factors (e.g. 147:160) use the
//! contiguous time-domain polyphase engine over the identical kernel.
//! Nonlinear phase intentionally rejects reduced rate components above 1024
//! rather than silently falling back to the linear Rubato engines.

use crate::config::{PhaseResponse, ResampleQuality};
use rubato::{
    audioadapter::{Adapter, AdapterMut},
    audioadapter_buffers::direct::InterleavedSlice,
    Async, Fft, FixedAsync, FixedSync, Indexing, Resampler, SincInterpolationParameters,
    SincInterpolationType, WindowFunction,
};

use super::{
    contiguous_polyphase_backend::ContiguousPolyphaseResampler,
    halfband_backend::Halfband2xResampler, spectral_backend::SpectralNonlinearResampler,
    BackendInitError, BackendProcessError, BackendProgress,
};

pub(super) const BACKEND_NAME: &str = "rubato";

/// Default fixed input chunk in frames for every Rubato route.
const CHUNK_IN: usize = 1024;

/// Maximum numerator and denominator of the reduced sample-rate ratio routed
/// through rubato's synchronous FFT engine. Larger components make its FFT
/// block, delay, and per-call output grow with the raw rate pair; for example,
/// 44_100 -> 44_101 would otherwise create a 44_101-frame output block and a
/// 22_050-frame delay. All conventional audio-rate conversions fit this bound.
/// Only pathological reduced ratios fall back to the sinc engine.
const MAX_FFT_REDUCED_RATE: u32 = 1024;

/// Select coupled caller-chunk/sub-chunk geometry. Low through High batch two
/// quality-equivalent FFT units per call; UltraHigh retains the longer 1024/1
/// filter selected by quality evidence.
fn fft_geometry(quality: ResampleQuality) -> (usize, usize) {
    match quality {
        ResampleQuality::UltraHigh => (CHUNK_IN, 1),
        _ => (CHUNK_IN, 2),
    }
}

/// Consecutive zero-output flush rounds tolerated during drain before the
/// backend reports a stall instead of looping forever.
const MAX_DRAIN_STALL_ROUNDS: usize = 64;

/// Largest reduced interpolation factor (`to_rate / gcd`) routed through the
/// spectral nonlinear engine. Its exact alias fold costs about `up` complex
/// multiply-adds per input sample per channel, so it wins only while `up` is
/// small (e.g. exact 1:2 / 2:1 families). Larger factors — 147:160 and
/// friends — use the contiguous time-domain polyphase engine whose cost is
/// `taps_per_phase * up/down` cache-resident multiply-adds instead
/// (2026-07-25 same-machine matrix evidence). Both engines share the same
/// kernel design and `MAX_REDUCED_RATE` bound.
const SPECTRAL_NONLINEAR_MAX_UP: u32 = 16;

fn nonlinear_uses_spectral(from_rate: u32, to_rate: u32) -> bool {
    if from_rate == 0 || to_rate == 0 {
        // Either engine constructor rejects zero rates with the same error.
        return true;
    }
    let divisor = greatest_common_divisor(from_rate, to_rate);
    to_rate / divisor <= SPECTRAL_NONLINEAR_MAX_UP
}

fn sinc_parameters(quality: ResampleQuality) -> SincInterpolationParameters {
    let (sinc_len, oversampling_factor, interpolation) = match quality {
        ResampleQuality::Low => (64, 128, SincInterpolationType::Linear),
        ResampleQuality::Standard => (128, 256, SincInterpolationType::Cubic),
        ResampleQuality::High => (256, 256, SincInterpolationType::Cubic),
        ResampleQuality::UltraHigh => (256, 512, SincInterpolationType::Cubic),
    };
    SincInterpolationParameters::new(sinc_len, WindowFunction::BlackmanHarris2)
        .oversampling_factor(oversampling_factor)
        .interpolation(interpolation)
}

fn greatest_common_divisor(mut left: u32, mut right: u32) -> u32 {
    while right != 0 {
        (left, right) = (right, left % right);
    }
    left
}

fn should_use_fft(from_rate: u32, to_rate: u32, _quality: ResampleQuality) -> bool {
    if from_rate == 0 || to_rate == 0 {
        return false;
    }
    let divisor = greatest_common_divisor(from_rate, to_rate);
    from_rate / divisor <= MAX_FFT_REDUCED_RATE && to_rate / divisor <= MAX_FFT_REDUCED_RATE
}

fn should_use_halfband_2x(
    from_rate: u32,
    to_rate: u32,
    phase: PhaseResponse,
    quality: ResampleQuality,
) -> bool {
    matches!(phase, PhaseResponse::Linear)
        && matches!(quality, ResampleQuality::High)
        && from_rate.checked_mul(2) == Some(to_rate)
}

/// Total output frames a stream of `total_input` frames must produce to be
/// duration-aligned, rounding half up.
pub(super) fn expected_output_frames(total_input: u64, from_rate: u32, to_rate: u32) -> u64 {
    ((total_input as u128 * to_rate as u128 * 2 + from_rate as u128) / (from_rate as u128 * 2))
        as u64
}

/// Fixed-capacity sample FIFO with bounded two-copy push/pop operations.
///
/// Unlike the public pipeline ring, this adapter-local queue never overwrites
/// unread audio and never logs. Capacity errors remain static hot-path errors.
struct SampleRing {
    data: Box<[f64]>,
    head: usize,
    len: usize,
}

impl SampleRing {
    fn new(capacity: usize) -> Self {
        Self {
            data: vec![0.0; capacity].into_boxed_slice(),
            head: 0,
            len: 0,
        }
    }

    fn len(&self) -> usize {
        self.len
    }

    fn free(&self) -> usize {
        self.data.len() - self.len
    }

    fn is_empty(&self) -> bool {
        self.len == 0
    }

    fn clear(&mut self) {
        self.head = 0;
        self.len = 0;
    }

    fn push(&mut self, source: &[f64]) -> Result<(), BackendProcessError> {
        if source.len() > self.free() {
            return Err("resampler backend FIFO capacity exceeded".into());
        }
        if source.is_empty() {
            return Ok(());
        }

        let capacity = self.data.len();
        let tail = (self.head + self.len) % capacity;
        let first = source.len().min(capacity - tail);
        self.data[tail..tail + first].copy_from_slice(&source[..first]);
        let remaining = source.len() - first;
        if remaining > 0 {
            self.data[..remaining].copy_from_slice(&source[first..]);
        }
        self.len += source.len();
        Ok(())
    }

    fn front_contiguous(&self, samples: usize) -> Option<&[f64]> {
        let end = self.head.checked_add(samples)?;
        if samples > self.len || end > self.data.len() {
            return None;
        }
        Some(&self.data[self.head..end])
    }

    fn consume(&mut self, samples: usize) -> Result<(), BackendProcessError> {
        if samples > self.len {
            return Err("resampler backend FIFO underflow".into());
        }
        self.len -= samples;
        if self.len == 0 {
            self.head = 0;
        } else {
            self.head = (self.head + samples) % self.data.len();
        }
        Ok(())
    }

    fn pop_into(&mut self, output: &mut [f64]) -> usize {
        let samples = output.len().min(self.len);
        if samples == 0 {
            return 0;
        }

        let first = samples.min(self.data.len() - self.head);
        output[..first].copy_from_slice(&self.data[self.head..self.head + first]);
        let remaining = samples - first;
        if remaining > 0 {
            output[first..samples].copy_from_slice(&self.data[..remaining]);
        }

        self.len -= samples;
        if self.len == 0 {
            self.head = 0;
        } else {
            self.head = (self.head + samples) % self.data.len();
        }
        samples
    }
}

/// Rubato input view composed from an already-staged FIFO prefix and a caller
/// suffix. Rubato reads one channel at a time, so the channel-copy override
/// keeps that operation to two bounded interleaved loops instead of dispatching
/// one trait-object sample read per frame.
struct SplitInterleavedInput<'a> {
    prefix: &'a [f64],
    suffix: &'a [f64],
    channels: usize,
    prefix_frames: usize,
    frames: usize,
}

impl<'a> SplitInterleavedInput<'a> {
    fn new(
        prefix: &'a [f64],
        suffix: &'a [f64],
        channels: usize,
    ) -> Result<Self, BackendProcessError> {
        if channels == 0
            || !prefix.len().is_multiple_of(channels)
            || !suffix.len().is_multiple_of(channels)
        {
            return Err("resampler split input received invalid geometry".into());
        }
        let prefix_frames = prefix.len() / channels;
        let suffix_frames = suffix.len() / channels;
        let frames = prefix_frames
            .checked_add(suffix_frames)
            .ok_or("resampler split input frame count overflowed")?;
        Ok(Self {
            prefix,
            suffix,
            channels,
            prefix_frames,
            frames,
        })
    }

    #[inline]
    fn copy_interleaved_channel(
        source: &[f64],
        channels: usize,
        channel: usize,
        start_frame: usize,
        output: &mut [f64],
    ) {
        let start = start_frame * channels;
        let end = start + output.len() * channels;
        let source = &source[start..end];
        match channels {
            1 => output.copy_from_slice(source),
            2 => {
                for (frame, target) in source.chunks_exact(2).zip(output.iter_mut()) {
                    unsafe {
                        *target = *frame.get_unchecked(channel);
                    }
                }
            }
            _ => {
                for (frame, target) in source.chunks_exact(channels).zip(output.iter_mut()) {
                    unsafe {
                        *target = *frame.get_unchecked(channel);
                    }
                }
            }
        }
    }
}

// SAFETY: construction fixes the reported dimensions for the adapter's
// lifetime and validates that both backing slices contain complete frames.
unsafe impl Adapter<f64> for SplitInterleavedInput<'_> {
    unsafe fn read_sample_unchecked(&self, channel: usize, frame: usize) -> f64 {
        if frame < self.prefix_frames {
            let index = frame * self.channels + channel;
            unsafe { *self.prefix.get_unchecked(index) }
        } else {
            let index = (frame - self.prefix_frames) * self.channels + channel;
            unsafe { *self.suffix.get_unchecked(index) }
        }
    }

    fn channels(&self) -> usize {
        self.channels
    }

    fn frames(&self) -> usize {
        self.frames
    }

    fn copy_from_channel_to_slice(&self, channel: usize, skip: usize, slice: &mut [f64]) -> usize {
        if channel >= self.channels || skip >= self.frames {
            return 0;
        }
        let frames = slice.len().min(self.frames - skip);
        let end = skip + frames;
        let prefix_end = end.min(self.prefix_frames);
        let prefix_frames = prefix_end.saturating_sub(skip);
        if prefix_frames > 0 {
            Self::copy_interleaved_channel(
                self.prefix,
                self.channels,
                channel,
                skip,
                &mut slice[..prefix_frames],
            );
        }
        if prefix_frames < frames {
            let suffix_start = skip.max(self.prefix_frames) - self.prefix_frames;
            Self::copy_interleaved_channel(
                self.suffix,
                self.channels,
                channel,
                suffix_start,
                &mut slice[prefix_frames..frames],
            );
        }
        frames
    }
}

/// Contiguous interleaved Rubato output with channel-wise bulk writes. Rubato
/// produces planar channel slices, so overriding the trait helper avoids one
/// virtual `write_sample_unchecked` dispatch per output frame.
struct DirectInterleavedOutput<'a> {
    output: &'a mut [f64],
    channels: usize,
    frames: usize,
}

impl<'a> DirectInterleavedOutput<'a> {
    fn new(
        output: &'a mut [f64],
        channels: usize,
        frames: usize,
    ) -> Result<Self, BackendProcessError> {
        let samples = channels
            .checked_mul(frames)
            .ok_or("resampler direct output length overflowed")?;
        if channels == 0 || output.len() < samples {
            return Err("resampler direct output received invalid geometry".into());
        }
        Ok(Self {
            output: &mut output[..samples],
            channels,
            frames,
        })
    }
}

// SAFETY: construction fixes the reported dimensions and validates the exact
// backing prefix for the adapter's lifetime.
unsafe impl Adapter<f64> for DirectInterleavedOutput<'_> {
    unsafe fn read_sample_unchecked(&self, channel: usize, frame: usize) -> f64 {
        let index = frame * self.channels + channel;
        unsafe { *self.output.get_unchecked(index) }
    }

    fn channels(&self) -> usize {
        self.channels
    }

    fn frames(&self) -> usize {
        self.frames
    }
}

// SAFETY: all mapped writes stay inside the fixed dimensions validated by
// `new`; Rubato supplies in-bounds channel/frame pairs.
unsafe impl AdapterMut<f64> for DirectInterleavedOutput<'_> {
    unsafe fn write_sample_unchecked(&mut self, channel: usize, frame: usize, value: &f64) -> bool {
        let index = frame * self.channels + channel;
        unsafe {
            *self.output.get_unchecked_mut(index) = *value;
        }
        false
    }

    fn copy_from_slice_to_channel(
        &mut self,
        channel: usize,
        skip: usize,
        slice: &[f64],
    ) -> (usize, usize) {
        if channel >= self.channels || skip >= self.frames {
            return (0, 0);
        }
        let frames = slice.len().min(self.frames - skip);
        let start = skip * self.channels;
        let end = start + frames * self.channels;
        let output = &mut self.output[start..end];
        match self.channels {
            1 => output.copy_from_slice(&slice[..frames]),
            2 => {
                for (frame, value) in output.chunks_exact_mut(2).zip(&slice[..frames]) {
                    unsafe {
                        *frame.get_unchecked_mut(channel) = *value;
                    }
                }
            }
            channels => {
                for (frame, value) in output.chunks_exact_mut(channels).zip(&slice[..frames]) {
                    unsafe {
                        *frame.get_unchecked_mut(channel) = *value;
                    }
                }
            }
        }
        (frames, 0)
    }
}

/// FFT output view for the final duration-completing drain step. Native
/// leading delay and output beyond the exact caller-visible duration are
/// discarded in place, so a terminal tail is never copied into spill storage
/// only to be cleared immediately afterwards.
struct TerminalInterleavedOutput<'a> {
    output: &'a mut [f64],
    channels: usize,
    native_frames: usize,
    drop_frames: usize,
    direct_frames: usize,
}

impl<'a> TerminalInterleavedOutput<'a> {
    fn new(
        output: &'a mut [f64],
        channels: usize,
        native_frames: usize,
        drop_frames: usize,
        direct_frames: usize,
    ) -> Result<Self, BackendProcessError> {
        if channels == 0
            || drop_frames > native_frames
            || direct_frames > native_frames - drop_frames
        {
            return Err("resampler terminal output received invalid geometry".into());
        }
        let direct_samples = direct_frames
            .checked_mul(channels)
            .ok_or("resampler terminal output length overflowed")?;
        if output.len() < direct_samples {
            return Err("resampler terminal output backing storage was too small".into());
        }
        Ok(Self {
            output: &mut output[..direct_samples],
            channels,
            native_frames,
            drop_frames,
            direct_frames,
        })
    }
}

// SAFETY: construction validates the fixed native dimensions and the exact
// caller-visible backing prefix. Discarded native frames never index output.
unsafe impl Adapter<f64> for TerminalInterleavedOutput<'_> {
    unsafe fn read_sample_unchecked(&self, channel: usize, frame: usize) -> f64 {
        if frame < self.drop_frames || frame >= self.drop_frames + self.direct_frames {
            return 0.0;
        }
        let index = (frame - self.drop_frames) * self.channels + channel;
        unsafe { *self.output.get_unchecked(index) }
    }

    fn channels(&self) -> usize {
        self.channels
    }

    fn frames(&self) -> usize {
        self.native_frames
    }
}

// SAFETY: native frames outside the validated direct interval are deliberately
// discarded; mapped writes stay inside the exact output prefix from `new`.
unsafe impl AdapterMut<f64> for TerminalInterleavedOutput<'_> {
    unsafe fn write_sample_unchecked(&mut self, channel: usize, frame: usize, value: &f64) -> bool {
        if frame < self.drop_frames || frame >= self.drop_frames + self.direct_frames {
            return false;
        }
        let index = (frame - self.drop_frames) * self.channels + channel;
        unsafe {
            *self.output.get_unchecked_mut(index) = *value;
        }
        false
    }

    fn copy_from_slice_to_channel(
        &mut self,
        channel: usize,
        skip: usize,
        slice: &[f64],
    ) -> (usize, usize) {
        if channel >= self.channels || skip >= self.native_frames {
            return (0, 0);
        }
        let frames = slice.len().min(self.native_frames - skip);
        let source_end = skip + frames;
        let direct_start = skip.max(self.drop_frames);
        let direct_end = source_end.min(self.drop_frames + self.direct_frames);
        if direct_start < direct_end {
            let source_start = direct_start - skip;
            let source_frames = direct_end - direct_start;
            let output_start = (direct_start - self.drop_frames) * self.channels;
            let output_end = output_start + source_frames * self.channels;
            let output = &mut self.output[output_start..output_end];
            let source = &slice[source_start..source_start + source_frames];
            match self.channels {
                1 => output.copy_from_slice(source),
                2 => {
                    for (frame, value) in output.chunks_exact_mut(2).zip(source) {
                        unsafe {
                            *frame.get_unchecked_mut(channel) = *value;
                        }
                    }
                }
                channels => {
                    for (frame, value) in output.chunks_exact_mut(channels).zip(source) {
                        unsafe {
                            *frame.get_unchecked_mut(channel) = *value;
                        }
                    }
                }
            }
        }
        (frames, 0)
    }
}

/// Rubato output view that discards the native leading-delay prefix, writes
/// the caller-authorized prefix directly, and sends only the remaining tail to
/// preallocated spill storage. Its dimensions and backing slice lengths are
/// validated once before Rubato receives the trait object.
struct SplitInterleavedOutput<'a> {
    direct: &'a mut [f64],
    spill: &'a mut [f64],
    channels: usize,
    native_frames: usize,
    drop_frames: usize,
    direct_frames: usize,
}

impl<'a> SplitInterleavedOutput<'a> {
    fn new(
        direct: &'a mut [f64],
        spill: &'a mut [f64],
        channels: usize,
        native_frames: usize,
        drop_frames: usize,
        direct_frames: usize,
    ) -> Result<Self, BackendProcessError> {
        if channels == 0 || drop_frames > native_frames {
            return Err("resampler split output received invalid geometry".into());
        }
        let kept_frames = native_frames - drop_frames;
        if direct_frames > kept_frames {
            return Err("resampler split output direct prefix exceeded native output".into());
        }
        let direct_samples = direct_frames
            .checked_mul(channels)
            .ok_or("resampler split output direct length overflowed")?;
        let spill_samples = (kept_frames - direct_frames)
            .checked_mul(channels)
            .ok_or("resampler split output spill length overflowed")?;
        if direct.len() < direct_samples || spill.len() < spill_samples {
            return Err("resampler split output backing storage was too small".into());
        }
        Ok(Self {
            direct: &mut direct[..direct_samples],
            spill: &mut spill[..spill_samples],
            channels,
            native_frames,
            drop_frames,
            direct_frames,
        })
    }
}

// SAFETY: construction fixes the reported dimensions for the adapter's
// lifetime and validates that both backing slices cover every mapped sample.
unsafe impl Adapter<f64> for SplitInterleavedOutput<'_> {
    unsafe fn read_sample_unchecked(&self, channel: usize, frame: usize) -> f64 {
        if frame < self.drop_frames {
            return 0.0;
        }
        let kept_frame = frame - self.drop_frames;
        if kept_frame < self.direct_frames {
            let index = kept_frame * self.channels + channel;
            unsafe { *self.direct.get_unchecked(index) }
        } else {
            let index = (kept_frame - self.direct_frames) * self.channels + channel;
            unsafe { *self.spill.get_unchecked(index) }
        }
    }

    fn channels(&self) -> usize {
        self.channels
    }

    fn frames(&self) -> usize {
        self.native_frames
    }
}

// SAFETY: `write_sample_unchecked` uses the same validated, fixed mapping as
// the `Adapter` implementation. Rubato supplies in-bounds channel/frame pairs.
unsafe impl AdapterMut<f64> for SplitInterleavedOutput<'_> {
    unsafe fn write_sample_unchecked(&mut self, channel: usize, frame: usize, value: &f64) -> bool {
        if frame < self.drop_frames {
            return false;
        }
        let kept_frame = frame - self.drop_frames;
        if kept_frame < self.direct_frames {
            let index = kept_frame * self.channels + channel;
            unsafe {
                *self.direct.get_unchecked_mut(index) = *value;
            }
        } else {
            let index = (kept_frame - self.direct_frames) * self.channels + channel;
            unsafe {
                *self.spill.get_unchecked_mut(index) = *value;
            }
        }
        false
    }

    fn copy_from_slice_to_channel(
        &mut self,
        channel: usize,
        skip: usize,
        slice: &[f64],
    ) -> (usize, usize) {
        if channel >= self.channels || skip >= self.native_frames {
            return (0, 0);
        }
        let frames = slice.len().min(self.native_frames - skip);
        let source_end = skip + frames;
        let direct_native_start = skip.max(self.drop_frames);
        let direct_native_end = source_end.min(self.drop_frames + self.direct_frames);
        for native_frame in direct_native_start..direct_native_end {
            let source_index = native_frame - skip;
            let direct_frame = native_frame - self.drop_frames;
            let direct_index = direct_frame * self.channels + channel;
            unsafe {
                *self.direct.get_unchecked_mut(direct_index) = *slice.get_unchecked(source_index);
            }
        }

        let spill_native_start = skip.max(self.drop_frames + self.direct_frames);
        for native_frame in spill_native_start..source_end {
            let source_index = native_frame - skip;
            let spill_frame = native_frame - self.drop_frames - self.direct_frames;
            let spill_index = spill_frame * self.channels + channel;
            unsafe {
                *self.spill.get_unchecked_mut(spill_index) = *slice.get_unchecked(source_index);
            }
        }
        (frames, 0)
    }
}

enum NonlinearEngine {
    Spectral(SpectralNonlinearResampler),
    Polyphase(ContiguousPolyphaseResampler),
}

impl NonlinearEngine {
    #[inline]
    fn output_frames_max(&self) -> usize {
        match self {
            Self::Spectral(resampler) => resampler.output_frames_max(),
            Self::Polyphase(resampler) => resampler.output_frames_max(),
        }
    }

    #[inline]
    fn output_delay(&self) -> usize {
        match self {
            Self::Spectral(resampler) => resampler.output_delay(),
            Self::Polyphase(resampler) => resampler.output_delay(),
        }
    }

    #[inline]
    fn latency_frames(&self) -> usize {
        match self {
            Self::Spectral(resampler) => resampler.latency_frames(),
            Self::Polyphase(resampler) => resampler.latency_frames(),
        }
    }

    #[inline]
    fn finish_extension_frames(&self) -> usize {
        match self {
            Self::Spectral(resampler) => resampler.finish_extension_frames(),
            Self::Polyphase(resampler) => resampler.finish_extension_frames(),
        }
    }

    #[inline]
    fn process_chunk(
        &mut self,
        input: &[f64],
        output: &mut [f64],
    ) -> Result<(usize, usize), BackendProcessError> {
        match self {
            Self::Spectral(resampler) => resampler.process_chunk(input, output),
            Self::Polyphase(resampler) => resampler.process_chunk(input, output),
        }
    }

    #[inline]
    fn reset(&mut self) {
        match self {
            Self::Spectral(resampler) => resampler.reset(),
            Self::Polyphase(resampler) => resampler.reset(),
        }
    }
}

enum RubatoEngine {
    Halfband(Halfband2xResampler),
    Sinc(Async<f64>),
    Fft(Box<Fft<f64>>),
    Nonlinear(NonlinearEngine),
}

impl RubatoEngine {
    fn new(
        from_rate: u32,
        to_rate: u32,
        phase: PhaseResponse,
        quality: ResampleQuality,
        channels: usize,
    ) -> Result<(Self, usize), BackendInitError> {
        if !matches!(phase, PhaseResponse::Linear) {
            let nonlinear = if nonlinear_uses_spectral(from_rate, to_rate) {
                SpectralNonlinearResampler::new(
                    from_rate, to_rate, phase, quality, channels, CHUNK_IN,
                )
                .map(NonlinearEngine::Spectral)
            } else {
                ContiguousPolyphaseResampler::new(
                    from_rate, to_rate, phase, quality, channels, CHUNK_IN,
                )
                .map(NonlinearEngine::Polyphase)
            }?;
            return Ok((Self::Nonlinear(nonlinear), CHUNK_IN));
        }
        if should_use_halfband_2x(from_rate, to_rate, phase, quality) {
            return Halfband2xResampler::new(channels, CHUNK_IN)
                .map(|engine| (Self::Halfband(engine), CHUNK_IN));
        }
        if should_use_fft(from_rate, to_rate, quality) {
            let (chunk_in, sub_chunks) = fft_geometry(quality);
            Fft::<f64>::new_custom(
                from_rate as usize,
                to_rate as usize,
                chunk_in,
                sub_chunks,
                channels,
                WindowFunction::BlackmanHarris2,
                FixedSync::Input,
            )
            .map(Box::new)
            .map(|engine| (Self::Fft(engine), chunk_in))
            .map_err(|error| BackendInitError::Backend {
                message: error.to_string(),
            })
        } else {
            let ratio = to_rate as f64 / from_rate as f64;
            let parameters = sinc_parameters(quality);
            Async::<f64>::new_sinc(
                ratio,
                1.0,
                &parameters,
                CHUNK_IN,
                channels,
                FixedAsync::Input,
            )
            .map(|engine| (Self::Sinc(engine), CHUNK_IN))
            .map_err(|error| BackendInitError::Backend {
                message: error.to_string(),
            })
        }
    }

    fn output_frames_max(&self) -> usize {
        match self {
            Self::Halfband(resampler) => resampler.output_frames_max(),
            Self::Sinc(resampler) => resampler.output_frames_max(),
            Self::Fft(resampler) => resampler.output_frames_max(),
            Self::Nonlinear(resampler) => resampler.output_frames_max(),
        }
    }

    fn fft_output_frames_next(&self) -> Option<usize> {
        match self {
            Self::Fft(resampler) => Some(resampler.output_frames_next()),
            _ => None,
        }
    }

    fn output_delay(&self) -> usize {
        match self {
            Self::Halfband(resampler) => resampler.output_delay(),
            Self::Sinc(resampler) => resampler.output_delay(),
            Self::Fft(resampler) => resampler.output_delay(),
            Self::Nonlinear(resampler) => resampler.output_delay(),
        }
    }

    fn latency_frames(&self) -> usize {
        match self {
            Self::Halfband(_) | Self::Sinc(_) | Self::Fft(_) => 0,
            Self::Nonlinear(resampler) => resampler.latency_frames(),
        }
    }

    fn finish_extension_frames(&self) -> usize {
        match self {
            Self::Halfband(_) | Self::Sinc(_) | Self::Fft(_) => 0,
            Self::Nonlinear(resampler) => resampler.finish_extension_frames(),
        }
    }

    fn process_chunk(
        &mut self,
        input: &[f64],
        output: &mut [f64],
        channels: usize,
    ) -> Result<(usize, usize), BackendProcessError> {
        match self {
            Self::Halfband(resampler) => return resampler.process_chunk(input, output),
            Self::Nonlinear(resampler) => return resampler.process_chunk(input, output),
            Self::Sinc(resampler) => {
                let input_frames = input.len() / channels;
                let output_frames = output.len() / channels;
                let input = InterleavedSlice::new(input, channels, input_frames)
                    .map_err(|_| BackendProcessError::new("resampler backend input view failed"))?;
                let mut output = InterleavedSlice::new_mut(output, channels, output_frames)
                    .map_err(|_| {
                        BackendProcessError::new("resampler backend output view failed")
                    })?;
                resampler.process_into_buffer(&input, &mut output, None)
            }
            Self::Fft(resampler) => {
                let input_frames = input.len() / channels;
                let output_frames = output.len() / channels;
                let input = SplitInterleavedInput::new(input, &[], channels)?;
                if input.frames() != input_frames {
                    return Err("resampler backend input view changed frame count".into());
                }
                let mut output = DirectInterleavedOutput::new(output, channels, output_frames)?;
                return resampler
                    .process_into_buffer(&input, &mut output, None)
                    .map_err(|_| BackendProcessError::new("resampler backend process failed"));
            }
        }
        .map_err(|_| BackendProcessError::new("resampler backend process failed"))
    }

    fn process_fft_adapters(
        &mut self,
        input: &dyn Adapter<f64>,
        output: &mut dyn AdapterMut<f64>,
        indexing: Option<&Indexing>,
    ) -> Result<(usize, usize), BackendProcessError> {
        let Self::Fft(resampler) = self else {
            return Err("resampler split input requires the FFT engine".into());
        };
        resampler
            .process_into_buffer(input, output, indexing)
            .map_err(|_| BackendProcessError::new("resampler backend process failed"))
    }

    fn reset(&mut self) {
        match self {
            Self::Halfband(resampler) => resampler.reset(),
            Self::Sinc(resampler) => resampler.reset(),
            Self::Fft(resampler) => resampler.reset(),
            Self::Nonlinear(resampler) => resampler.reset(),
        }
    }
}

pub(super) struct MonoBackend {
    engine: RubatoEngine,
    chunk_in: usize,
    channels: usize,
    /// Staged caller input; rubato consumes exact `chunk_in` prefixes of this.
    in_fifo: SampleRing,
    /// Per-engine interleaved output stage.
    out_stage: Vec<f64>,
    /// Produced frames not yet handed to the caller.
    out_fifo: SampleRing,
    /// Zero frames used to pad the final partial chunk and to flush the tail.
    zero_chunk: Vec<f64>,
    /// Frames consumed from the caller (pad zeros are not counted).
    total_input: u64,
    /// Real caller frames actually consumed by completed backend chunks. This
    /// excludes caller input still queued in `in_fifo` and drain pad zeros; it
    /// bounds the caller-visible prefix on the non-integer direct-output path.
    processed_real_input: u64,
    /// Setup-selected non-integer-ratio direct-output mode: engine output is
    /// written straight into caller memory up to the cumulative rational
    /// real-input budget, and the bounded overflow spills into `out_fifo`.
    prefix_budget_direct: bool,
    /// Frames handed to the caller.
    emitted: u64,
    /// Set at drain start: the duration-aligned total output length.
    expected_total: u64,
    /// Backend output frames still to discard from the initial leading delay.
    delay_remaining: usize,
    initial_delay: usize,
    draining: bool,
    from_rate: u32,
    to_rate: u32,
    #[cfg(test)]
    direct_input_chunks: u64,
    #[cfg(test)]
    direct_drain_chunks: u64,
    #[cfg(test)]
    split_input_chunks: u64,
    #[cfg(test)]
    split_input_enabled: bool,
    #[cfg(test)]
    partial_zero_drain_enabled: bool,
    #[cfg(test)]
    partial_zero_drain_chunks: u64,
    #[cfg(test)]
    terminal_truncate_drain_enabled: bool,
    #[cfg(test)]
    terminal_truncate_drain_chunks: u64,
}

fn process_chunk_into(
    engine: &mut RubatoEngine,
    input: &[f64],
    output: &mut [f64],
    chunk_in: usize,
    channels: usize,
    delay_remaining: &mut usize,
) -> Result<usize, BackendProcessError> {
    let chunk_samples = chunk_in * channels;
    if input.len() != chunk_samples {
        return Err("resampler backend received an invalid native input chunk".into());
    }
    let (input_used, output_written) = engine.process_chunk(input, output, channels)?;
    let output_capacity_frames = output.len() / channels;
    if input_used != chunk_in || output_written > output_capacity_frames {
        return Err("resampler backend reported out-of-bounds progress".into());
    }

    let skip = (*delay_remaining).min(output_written);
    *delay_remaining -= skip;
    let emitted = output_written - skip;
    if skip > 0 && emitted > 0 {
        output.copy_within(skip * channels..output_written * channels, 0);
    }
    Ok(emitted)
}

fn process_fifo_chunk_into(
    engine: &mut RubatoEngine,
    in_fifo: &mut SampleRing,
    output: &mut [f64],
    chunk_in: usize,
    channels: usize,
    delay_remaining: &mut usize,
) -> Result<usize, BackendProcessError> {
    let chunk_samples = chunk_in * channels;
    let input = in_fifo
        .front_contiguous(chunk_samples)
        .ok_or("resampler backend input FIFO lost chunk contiguity")?;
    let emitted = process_chunk_into(engine, input, output, chunk_in, channels, delay_remaining)?;
    in_fifo.consume(chunk_samples)?;
    Ok(emitted)
}

fn process_fft_adapter_into(
    engine: &mut RubatoEngine,
    input: &dyn Adapter<f64>,
    output: &mut [f64],
    chunk_in: usize,
    channels: usize,
    delay_remaining: &mut usize,
) -> Result<usize, BackendProcessError> {
    if input.channels() != channels
        || input.frames() != chunk_in
        || !output.len().is_multiple_of(channels)
    {
        return Err("resampler backend FFT adapter received invalid geometry".into());
    }
    let output_frames = output.len() / channels;
    let (input_used, output_written) = {
        let mut output_view = DirectInterleavedOutput::new(output, channels, output_frames)?;
        engine.process_fft_adapters(input, &mut output_view, None)?
    };
    if input_used != chunk_in || output_written > output_frames {
        return Err("resampler backend FFT adapter reported out-of-bounds progress".into());
    }

    let skip = (*delay_remaining).min(output_written);
    *delay_remaining -= skip;
    let emitted = output_written - skip;
    if skip > 0 && emitted > 0 {
        output.copy_within(skip * channels..output_written * channels, 0);
    }
    Ok(emitted)
}

#[allow(clippy::too_many_arguments)]
fn process_fft_chunk_into_split(
    engine: &mut RubatoEngine,
    input: &[f64],
    output: &mut [f64],
    out_stage: &mut [f64],
    out_fifo: &mut SampleRing,
    chunk_in: usize,
    channels: usize,
    delay_remaining: &mut usize,
    emitted: &mut u64,
    authorized_total: u64,
) -> Result<Option<usize>, BackendProcessError> {
    if input.len() != chunk_in * channels {
        return Err("resampler backend FFT split received invalid input geometry".into());
    }
    let input = SplitInterleavedInput::new(input, &[], channels)?;
    process_fft_adapter_into_split(
        engine,
        &input,
        output,
        out_stage,
        out_fifo,
        chunk_in,
        channels,
        delay_remaining,
        emitted,
        authorized_total,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn process_fft_adapter_into_split(
    engine: &mut RubatoEngine,
    input: &dyn Adapter<f64>,
    output: &mut [f64],
    out_stage: &mut [f64],
    out_fifo: &mut SampleRing,
    chunk_in: usize,
    channels: usize,
    delay_remaining: &mut usize,
    emitted: &mut u64,
    authorized_total: u64,
    indexing: Option<&Indexing>,
) -> Result<Option<usize>, BackendProcessError> {
    let Some(native_frames) = engine.fft_output_frames_next() else {
        return Ok(None);
    };
    let required_input_frames = if let Some(indexing) = indexing {
        if indexing.output_offset != 0 || indexing.active_channels_mask.is_some() {
            return Err("resampler backend FFT split received unsupported indexing".into());
        }
        let partial_frames = indexing.partial_len.unwrap_or(chunk_in);
        if partial_frames > chunk_in {
            return Err("resampler backend FFT split partial input exceeded native chunk".into());
        }
        indexing
            .input_offset
            .checked_add(partial_frames)
            .ok_or("resampler backend FFT split input length overflowed")?
    } else {
        chunk_in
    };
    if input.channels() != channels
        || input.frames() < required_input_frames
        || (indexing.is_none() && input.frames() != chunk_in)
        || !output.len().is_multiple_of(channels)
    {
        return Err("resampler backend FFT split received invalid geometry".into());
    }

    let budget = authorized_total
        .saturating_sub(*emitted)
        .min(usize::MAX as u64) as usize;
    let caller_frames = output.len() / channels;
    let pending_frames = out_fifo.len() / channels;
    let pending_direct = pending_frames.min(budget).min(caller_frames);
    let drop_frames = (*delay_remaining).min(native_frames);
    let kept_frames = native_frames - drop_frames;
    let current_direct = kept_frames
        .min(budget.saturating_sub(pending_direct))
        .min(caller_frames.saturating_sub(pending_direct));
    let spill_frames = kept_frames - current_direct;

    let pending_samples = pending_direct
        .checked_mul(channels)
        .ok_or("resampler backend pending output length overflowed")?;
    let spill_samples = spill_frames
        .checked_mul(channels)
        .ok_or("resampler backend spill output length overflowed")?;
    let available_after_pending = out_fifo
        .free()
        .checked_add(pending_samples)
        .ok_or("resampler backend output capacity overflowed")?;
    if spill_samples > available_after_pending || spill_samples > out_stage.len() {
        return Ok(None);
    }

    let direct_samples = current_direct * channels;
    let direct_start = pending_samples;
    let direct_end = direct_start + direct_samples;
    let (input_used, output_written) = {
        let mut split_output = SplitInterleavedOutput::new(
            &mut output[direct_start..direct_end],
            &mut out_stage[..spill_samples],
            channels,
            native_frames,
            drop_frames,
            current_direct,
        )?;
        engine.process_fft_adapters(input, &mut split_output, indexing)?
    };
    if input_used != chunk_in || output_written != native_frames {
        return Err("resampler backend FFT split output reported invalid progress".into());
    }

    *delay_remaining -= drop_frames;
    let emitted_pending = out_fifo.pop_into(&mut output[..pending_samples]) / channels;
    if emitted_pending != pending_direct {
        return Err("resampler backend pending split output changed unexpectedly".into());
    }
    *emitted = emitted
        .checked_add((emitted_pending + current_direct) as u64)
        .ok_or("resampler backend emitted output count overflowed")?;
    if spill_samples > 0 {
        out_fifo.push(&out_stage[..spill_samples])?;
    }
    Ok(Some(emitted_pending + current_direct))
}

#[allow(clippy::too_many_arguments)]
fn process_fft_partial_zero_into_split(
    engine: &mut RubatoEngine,
    output: &mut [f64],
    out_stage: &mut [f64],
    out_fifo: &mut SampleRing,
    chunk_in: usize,
    channels: usize,
    delay_remaining: &mut usize,
    emitted: &mut u64,
    authorized_total: u64,
) -> Result<Option<usize>, BackendProcessError> {
    let input = SplitInterleavedInput::new(&[], &[], channels)?;
    let indexing = Indexing::new().partial_len(0);
    process_fft_adapter_into_split(
        engine,
        &input,
        output,
        out_stage,
        out_fifo,
        chunk_in,
        channels,
        delay_remaining,
        emitted,
        authorized_total,
        Some(&indexing),
    )
}

#[allow(clippy::too_many_arguments)]
fn process_fft_partial_zero_into_terminal(
    engine: &mut RubatoEngine,
    output: &mut [f64],
    chunk_in: usize,
    channels: usize,
    delay_remaining: &mut usize,
    emitted: &mut u64,
    expected_total: u64,
) -> Result<Option<usize>, BackendProcessError> {
    let Some(native_frames) = engine.fft_output_frames_next() else {
        return Ok(None);
    };
    if !output.len().is_multiple_of(channels) {
        return Err("resampler terminal output received incomplete frames".into());
    }
    let remaining = usize::try_from(expected_total.saturating_sub(*emitted))
        .map_err(|_| BackendProcessError::new("resampler terminal output length exceeded usize"))?;
    let drop_frames = (*delay_remaining).min(native_frames);
    let kept_frames = native_frames - drop_frames;
    if remaining == 0 || remaining > kept_frames || remaining > output.len() / channels {
        return Ok(None);
    }

    let input = SplitInterleavedInput::new(&[], &[], channels)?;
    let indexing = Indexing::new().partial_len(0);
    let (input_used, output_written) = {
        let mut output = TerminalInterleavedOutput::new(
            output,
            channels,
            native_frames,
            drop_frames,
            remaining,
        )?;
        engine.process_fft_adapters(&input, &mut output, Some(&indexing))?
    };
    if input_used != chunk_in || output_written != native_frames {
        return Err("resampler terminal FFT output reported invalid progress".into());
    }

    *delay_remaining -= drop_frames;
    *emitted = emitted
        .checked_add(remaining as u64)
        .ok_or("resampler backend emitted output count overflowed")?;
    Ok(Some(remaining))
}

impl MonoBackend {
    pub(super) fn new(
        from_rate: u32,
        to_rate: u32,
        phase: PhaseResponse,
        quality: ResampleQuality,
    ) -> Result<Self, BackendInitError> {
        Self::new_interleaved(from_rate, to_rate, phase, quality, 1)
    }

    pub(super) fn new_interleaved(
        from_rate: u32,
        to_rate: u32,
        phase: PhaseResponse,
        quality: ResampleQuality,
        channels: usize,
    ) -> Result<Self, BackendInitError> {
        if channels == 0 {
            return Err(BackendInitError::ZeroChannels);
        }
        let (engine, chunk_in) = RubatoEngine::new(from_rate, to_rate, phase, quality, channels)?;
        let out_max = engine.output_frames_max();
        let initial_delay = engine.output_delay();
        let out_fifo_capacity = out_max * 2 * channels;
        let duration_stable =
            (chunk_in as u128 * to_rate as u128).is_multiple_of(from_rate.max(1) as u128);
        // The FFT engine's cumulative post-delay output tracks the exact
        // rational duration within one frame per chunk, and the spectral and
        // contiguous-polyphase nonlinear engines pace output exactly
        // rationally per block, so their non-integer ratios can use
        // budget-bounded direct output. The sinc engine keeps the staged
        // route.
        let prefix_budget_direct =
            !duration_stable && matches!(engine, RubatoEngine::Fft(_) | RubatoEngine::Nonlinear(_));
        Ok(Self {
            engine,
            chunk_in,
            channels,
            in_fifo: SampleRing::new(chunk_in * 2 * channels),
            out_stage: vec![0.0; out_max * channels],
            out_fifo: SampleRing::new(out_fifo_capacity),
            zero_chunk: vec![0.0; chunk_in * channels],
            total_input: 0,
            processed_real_input: 0,
            prefix_budget_direct,
            emitted: 0,
            expected_total: 0,
            delay_remaining: initial_delay,
            initial_delay,
            draining: false,
            from_rate,
            to_rate,
            #[cfg(test)]
            direct_input_chunks: 0,
            #[cfg(test)]
            direct_drain_chunks: 0,
            #[cfg(test)]
            split_input_chunks: 0,
            #[cfg(test)]
            split_input_enabled: true,
            #[cfg(test)]
            partial_zero_drain_enabled: true,
            #[cfg(test)]
            partial_zero_drain_chunks: 0,
            #[cfg(test)]
            terminal_truncate_drain_enabled: true,
            #[cfg(test)]
            terminal_truncate_drain_chunks: 0,
        })
    }

    /// Run rubato over the first `chunk_in` frames of `in_fifo` and append the
    /// produced frames to `out_fifo`.
    fn run_chunk(&mut self) -> Result<(), BackendProcessError> {
        let emitted = process_fifo_chunk_into(
            &mut self.engine,
            &mut self.in_fifo,
            &mut self.out_stage,
            self.chunk_in,
            self.channels,
            &mut self.delay_remaining,
        )?;
        self.out_fifo
            .push(&self.out_stage[..emitted * self.channels])
    }

    fn direct_output_is_duration_stable(&self) -> bool {
        (self.chunk_in as u128 * self.to_rate as u128).is_multiple_of(self.from_rate as u128)
    }

    /// Caller-visible frames still authorized by real backend-processed input
    /// on the prefix-budget direct route. Frames beyond this stay staged in
    /// `out_fifo` until later real input (or finish) authorizes them.
    fn process_emit_budget(&self) -> usize {
        if !self.prefix_budget_direct {
            return usize::MAX;
        }
        let allowed_total =
            expected_output_frames(self.processed_real_input, self.from_rate, self.to_rate);
        allowed_total
            .saturating_sub(self.emitted)
            .min(usize::MAX as u64) as usize
    }

    /// Process one aligned FFT input chunk through a split Rubato output view.
    /// Pending earlier spill is reserved at the front of `output`; the current
    /// authorized prefix follows it directly and only the new overflow tail is
    /// staged for the ring. `None` keeps the generic full-native-output path.
    fn process_aligned_fft_chunk(
        &mut self,
        input: &[f64],
        output: &mut [f64],
    ) -> Result<Option<usize>, BackendProcessError> {
        // Let the generic direct-native path handle an entire Rubato output
        // block. Its ordinary interleaved adapter avoids the per-sample split
        // mapping; this adapter is only beneficial when caller capacity forces
        // delay/spill scattering.
        if output.len() / self.channels >= self.engine.output_frames_max() {
            return Ok(None);
        }
        let next_total_input = self
            .total_input
            .checked_add(self.chunk_in as u64)
            .ok_or("resampler backend input count overflowed")?;
        let next_processed_real_input = self
            .processed_real_input
            .checked_add(self.chunk_in as u64)
            .ok_or("resampler backend processed input count overflowed")?;
        let authorized_total = if self.prefix_budget_direct {
            expected_output_frames(next_processed_real_input, self.from_rate, self.to_rate)
        } else {
            u64::MAX
        };
        let produced = process_fft_chunk_into_split(
            &mut self.engine,
            input,
            output,
            &mut self.out_stage,
            &mut self.out_fifo,
            self.chunk_in,
            self.channels,
            &mut self.delay_remaining,
            &mut self.emitted,
            authorized_total,
        )?;
        if produced.is_none() {
            return Ok(None);
        }
        self.total_input = next_total_input;
        self.processed_real_input = next_processed_real_input;
        #[cfg(test)]
        {
            self.direct_input_chunks += 1;
        }
        Ok(produced)
    }

    /// Complete one staged partial FFT chunk directly from caller memory.
    /// The FIFO prefix was counted when it was accepted; only the suffix is
    /// newly consumed here. Unsupported engines or insufficient output spill
    /// capacity fall back to the ordinary FIFO path.
    fn process_split_input_fft_chunk(
        &mut self,
        suffix: &[f64],
        output: &mut [f64],
    ) -> Result<Option<(usize, usize)>, BackendProcessError> {
        #[cfg(test)]
        if !self.split_input_enabled {
            return Ok(None);
        }
        if !matches!(&self.engine, RubatoEngine::Fft(_))
            || self.in_fifo.is_empty()
            || !suffix.len().is_multiple_of(self.channels)
        {
            return Ok(None);
        }
        let prefix_frames = self.in_fifo.len() / self.channels;
        if prefix_frames >= self.chunk_in {
            return Ok(None);
        }
        let suffix_frames = suffix.len() / self.channels;
        let needed_frames = self.chunk_in - prefix_frames;
        if suffix_frames < needed_frames {
            return Ok(None);
        }

        let next_total_input = self
            .total_input
            .checked_add(needed_frames as u64)
            .ok_or("resampler backend input count overflowed")?;
        let next_processed_real_input = self
            .processed_real_input
            .checked_add(self.chunk_in as u64)
            .ok_or("resampler backend processed input count overflowed")?;
        let authorized_total = if self.prefix_budget_direct {
            expected_output_frames(next_processed_real_input, self.from_rate, self.to_rate)
        } else {
            u64::MAX
        };
        let prefix_samples = prefix_frames * self.channels;
        let suffix_samples = needed_frames * self.channels;
        let output_frames = output.len() / self.channels;
        let native_output_frames = self.engine.output_frames_max();
        let duration_stable = self.direct_output_is_duration_stable();

        let produced = {
            let prefix = self
                .in_fifo
                .front_contiguous(prefix_samples)
                .ok_or("resampler backend split input FIFO lost prefix contiguity")?;
            let input =
                SplitInterleavedInput::new(prefix, &suffix[..suffix_samples], self.channels)?;
            if input.frames() != self.chunk_in {
                return Err("resampler backend split input did not complete a native chunk".into());
            }

            if output_frames < native_output_frames {
                process_fft_adapter_into_split(
                    &mut self.engine,
                    &input,
                    output,
                    &mut self.out_stage,
                    &mut self.out_fifo,
                    self.chunk_in,
                    self.channels,
                    &mut self.delay_remaining,
                    &mut self.emitted,
                    authorized_total,
                    None,
                )?
            } else if (duration_stable || self.prefix_budget_direct) && self.out_fifo.is_empty() {
                let direct_samples = native_output_frames * self.channels;
                let chunk_frames = process_fft_adapter_into(
                    &mut self.engine,
                    &input,
                    &mut output[..direct_samples],
                    self.chunk_in,
                    self.channels,
                    &mut self.delay_remaining,
                )?;
                let budget = authorized_total
                    .saturating_sub(self.emitted)
                    .min(usize::MAX as u64) as usize;
                let direct = if duration_stable {
                    chunk_frames
                } else {
                    let budgeted = chunk_frames.min(budget);
                    self.out_fifo
                        .push(&output[budgeted * self.channels..chunk_frames * self.channels])?;
                    budgeted
                };
                self.emitted = self
                    .emitted
                    .checked_add(direct as u64)
                    .ok_or("resampler backend emitted output count overflowed")?;
                Some(direct)
            } else if self.out_fifo.free() >= self.out_stage.len() {
                let chunk_frames = process_fft_adapter_into(
                    &mut self.engine,
                    &input,
                    &mut self.out_stage,
                    self.chunk_in,
                    self.channels,
                    &mut self.delay_remaining,
                )?;
                self.out_fifo
                    .push(&self.out_stage[..chunk_frames * self.channels])?;
                Some(0)
            } else {
                None
            }
        };
        let Some(produced) = produced else {
            return Ok(None);
        };

        self.in_fifo.consume(prefix_samples)?;
        self.total_input = next_total_input;
        self.processed_real_input = next_processed_real_input;
        #[cfg(test)]
        {
            self.split_input_chunks += 1;
        }
        Ok(Some((needed_frames, produced)))
    }

    /// Move up to `max` pending frames into `output`, returning the count.
    fn emit_up_to(&mut self, output: &mut [f64], max: usize) -> usize {
        let count = (self.out_fifo.len() / self.channels)
            .min(output.len() / self.channels)
            .min(max);
        if count > 0 {
            let samples = count * self.channels;
            let copied = self.out_fifo.pop_into(&mut output[..samples]);
            let copied_frames = copied / self.channels;
            self.emitted += copied_frames as u64;
            return copied_frames;
        }
        0
    }

    pub(super) fn process(
        &mut self,
        input: &[f64],
        output: &mut [f64],
    ) -> Result<BackendProgress, BackendProcessError> {
        if self.draining {
            return Err("resampler backend already draining".into());
        }
        if !input.len().is_multiple_of(self.channels) || !output.len().is_multiple_of(self.channels)
        {
            return Err("resampler backend received an incomplete frame".into());
        }
        let mut consumed = 0usize;
        let mut produced = 0usize;
        let input_frames = input.len() / self.channels;
        let output_frames = output.len() / self.channels;

        // The representative callback supplies one setup-selected FFT chunk.
        // The split adapter already preserves pending-output order, delay
        // discard, exact-duration authorization, and bounded spill, so avoid
        // entering the generic FIFO/progress loop for this complete case.
        if self.in_fifo.is_empty() && input_frames == self.chunk_in {
            if let Some(output_frames) = self.process_aligned_fft_chunk(input, output)? {
                return Ok(BackendProgress {
                    input_frames,
                    output_frames,
                });
            }
        }

        loop {
            let before = (consumed, produced);
            produced += self.emit_up_to(
                &mut output[produced * self.channels..],
                self.process_emit_budget(),
            );

            let remaining_input = input_frames - consumed;
            let remaining_output = output_frames - produced;
            if let Some((input_used, output_written)) = self.process_split_input_fft_chunk(
                &input[consumed * self.channels..],
                &mut output[produced * self.channels..],
            )? {
                consumed += input_used;
                produced += output_written;
                if consumed == input_frames && produced == output_frames {
                    break;
                }
                continue;
            }
            if self.in_fifo.is_empty() && remaining_input >= self.chunk_in {
                let input_start = consumed * self.channels;
                let input_end = (consumed + self.chunk_in) * self.channels;
                let input_chunk = &input[input_start..input_end];
                if let Some(scattered) = self.process_aligned_fft_chunk(
                    input_chunk,
                    &mut output[produced * self.channels..],
                )? {
                    consumed += self.chunk_in;
                    produced += scattered;
                    if consumed == input_frames {
                        break;
                    }
                    continue;
                }
                let duration_stable = self.direct_output_is_duration_stable();
                if (duration_stable || self.prefix_budget_direct)
                    && self.out_fifo.is_empty()
                    && remaining_output >= self.engine.output_frames_max()
                {
                    let direct_samples = self.engine.output_frames_max() * self.channels;
                    let output_start = produced * self.channels;
                    let output_end = output_start + direct_samples;
                    let chunk_frames = process_chunk_into(
                        &mut self.engine,
                        input_chunk,
                        &mut output[output_start..output_end],
                        self.chunk_in,
                        self.channels,
                        &mut self.delay_remaining,
                    )?;
                    consumed += self.chunk_in;
                    self.total_input += self.chunk_in as u64;
                    self.processed_real_input += self.chunk_in as u64;
                    #[cfg(test)]
                    {
                        self.direct_input_chunks += 1;
                    }
                    let direct = if duration_stable {
                        chunk_frames
                    } else {
                        let budgeted = chunk_frames.min(self.process_emit_budget());
                        let spill_start = output_start + budgeted * self.channels;
                        let spill_end = output_start + chunk_frames * self.channels;
                        self.out_fifo.push(&output[spill_start..spill_end])?;
                        budgeted
                    };
                    self.emitted += direct as u64;
                    produced += direct;
                    continue;
                }

                if self.out_fifo.free() >= self.out_stage.len() {
                    let chunk_frames = process_chunk_into(
                        &mut self.engine,
                        input_chunk,
                        &mut self.out_stage,
                        self.chunk_in,
                        self.channels,
                        &mut self.delay_remaining,
                    )?;
                    consumed += self.chunk_in;
                    self.total_input += self.chunk_in as u64;
                    self.processed_real_input += self.chunk_in as u64;
                    #[cfg(test)]
                    {
                        self.direct_input_chunks += 1;
                    }
                    self.out_fifo
                        .push(&self.out_stage[..chunk_frames * self.channels])?;
                    continue;
                }
            }

            let free = self.in_fifo.free() / self.channels;
            let take = free.min(input_frames - consumed);
            if take > 0 {
                let start = consumed * self.channels;
                let end = (consumed + take) * self.channels;
                self.in_fifo.push(&input[start..end])?;
                consumed += take;
                self.total_input += take as u64;
            }
            while self.in_fifo.len() / self.channels >= self.chunk_in
                && self.out_fifo.free() >= self.out_stage.len()
            {
                let remaining_output = output_frames - produced;
                let duration_stable = self.direct_output_is_duration_stable();
                if (duration_stable || self.prefix_budget_direct)
                    && self.out_fifo.is_empty()
                    && remaining_output >= self.engine.output_frames_max()
                {
                    let direct_samples = self.engine.output_frames_max() * self.channels;
                    let chunk_frames = process_fifo_chunk_into(
                        &mut self.engine,
                        &mut self.in_fifo,
                        &mut output
                            [produced * self.channels..produced * self.channels + direct_samples],
                        self.chunk_in,
                        self.channels,
                        &mut self.delay_remaining,
                    )?;
                    self.processed_real_input += self.chunk_in as u64;
                    let direct = if duration_stable {
                        chunk_frames
                    } else {
                        // Expose only the cumulative rational real-input
                        // budget; spill the bounded overflow tail into the
                        // preallocated output ring for a later emit.
                        let budgeted = chunk_frames.min(self.process_emit_budget());
                        let spill_start = (produced + budgeted) * self.channels;
                        let spill_end = (produced + chunk_frames) * self.channels;
                        self.out_fifo.push(&output[spill_start..spill_end])?;
                        budgeted
                    };
                    self.emitted += direct as u64;
                    produced += direct;
                    continue;
                }
                self.run_chunk()?;
                self.processed_real_input += self.chunk_in as u64;
            }
            produced += self.emit_up_to(
                &mut output[produced * self.channels..],
                self.process_emit_budget(),
            );
            if (consumed, produced) == before {
                break;
            }
            if produced == output_frames && consumed == input_frames {
                break;
            }
        }
        Ok(BackendProgress {
            input_frames: consumed,
            output_frames: produced,
        })
    }

    pub(super) fn drain(&mut self, output: &mut [f64]) -> Result<usize, BackendProcessError> {
        if !output.len().is_multiple_of(self.channels) {
            return Err("resampler backend received an incomplete output frame".into());
        }
        if !self.draining {
            self.draining = true;
            // Per-chunk output counts can jitter by a frame around the exact
            // ratio; never let already-emitted frames underflow `remaining`.
            self.expected_total =
                expected_output_frames(self.total_input, self.from_rate, self.to_rate)
                    .saturating_add(self.engine.finish_extension_frames() as u64)
                    .max(self.emitted);
        }
        let mut produced = 0usize;
        let mut stall_rounds = 0usize;
        let output_frames = output.len() / self.channels;
        loop {
            let remaining = (self.expected_total - self.emitted) as usize;
            produced += self.emit_up_to(&mut output[produced * self.channels..], remaining);
            if self.emitted == self.expected_total {
                self.out_fifo.clear();
                self.in_fifo.clear();
                return Ok(produced);
            }
            if produced == output_frames {
                return Ok(produced);
            }
            // Reaching this point implies out_fifo is empty (emit was bounded
            // only by its length), so one full chunk of output always fits.
            // Flush staged real input first. Once the FIFO is empty, Rubato's
            // partial-input contract advances FFT state with implicit silence,
            // avoiding a zero-block FIFO copy and per-channel input copy.
            let staged_frames = self.in_fifo.len() / self.channels;
            let use_partial_zero =
                staged_frames == 0 && matches!(&self.engine, RubatoEngine::Fft(_));
            #[cfg(test)]
            let use_partial_zero = use_partial_zero && self.partial_zero_drain_enabled;
            let use_terminal_truncate = use_partial_zero;
            #[cfg(test)]
            let use_terminal_truncate =
                use_terminal_truncate && self.terminal_truncate_drain_enabled;
            if use_terminal_truncate {
                if let Some(direct) = process_fft_partial_zero_into_terminal(
                    &mut self.engine,
                    &mut output[produced * self.channels..],
                    self.chunk_in,
                    self.channels,
                    &mut self.delay_remaining,
                    &mut self.emitted,
                    self.expected_total,
                )? {
                    produced += direct;
                    #[cfg(test)]
                    {
                        self.direct_drain_chunks += 1;
                        self.partial_zero_drain_chunks += 1;
                        self.terminal_truncate_drain_chunks += 1;
                    }
                    continue;
                }
            }
            let before_fifo = self.out_fifo.len();
            let before_emitted = self.emitted;
            let direct = if use_partial_zero {
                process_fft_partial_zero_into_split(
                    &mut self.engine,
                    &mut output[produced * self.channels..],
                    &mut self.out_stage,
                    &mut self.out_fifo,
                    self.chunk_in,
                    self.channels,
                    &mut self.delay_remaining,
                    &mut self.emitted,
                    self.expected_total,
                )?
            } else {
                if staged_frames < self.chunk_in {
                    let pad_samples = (self.chunk_in - staged_frames) * self.channels;
                    self.in_fifo.push(&self.zero_chunk[..pad_samples])?;
                }
                let chunk_samples = self.chunk_in * self.channels;
                let input = self
                    .in_fifo
                    .front_contiguous(chunk_samples)
                    .ok_or("resampler backend drain input FIFO lost chunk contiguity")?;
                process_fft_chunk_into_split(
                    &mut self.engine,
                    input,
                    &mut output[produced * self.channels..],
                    &mut self.out_stage,
                    &mut self.out_fifo,
                    self.chunk_in,
                    self.channels,
                    &mut self.delay_remaining,
                    &mut self.emitted,
                    self.expected_total,
                )?
            };
            if let Some(direct) = direct {
                if !use_partial_zero {
                    self.in_fifo.consume(self.chunk_in * self.channels)?;
                }
                produced += direct;
                #[cfg(test)]
                {
                    self.direct_drain_chunks += 1;
                    if use_partial_zero {
                        self.partial_zero_drain_chunks += 1;
                    }
                }
            } else {
                if use_partial_zero {
                    self.in_fifo.push(&self.zero_chunk)?;
                }
                self.run_chunk()?;
            }
            if self.out_fifo.len() == before_fifo && self.emitted == before_emitted {
                stall_rounds += 1;
                if stall_rounds > MAX_DRAIN_STALL_ROUNDS {
                    return Err("resampler backend drain stalled".into());
                }
            } else {
                stall_rounds = 0;
            }
        }
    }

    pub(super) fn clear(&mut self) -> Result<(), BackendProcessError> {
        self.engine.reset();
        self.in_fifo.clear();
        self.out_fifo.clear();
        self.total_input = 0;
        self.processed_real_input = 0;
        self.emitted = 0;
        self.expected_total = 0;
        self.delay_remaining = self.initial_delay;
        self.draining = false;
        #[cfg(test)]
        {
            self.direct_input_chunks = 0;
            self.direct_drain_chunks = 0;
            self.split_input_chunks = 0;
            self.partial_zero_drain_chunks = 0;
            self.terminal_truncate_drain_chunks = 0;
        }
        Ok(())
    }

    pub(super) fn latency_frames(&self) -> usize {
        self.engine.latency_frames()
    }

    pub(super) fn finish_extension_frames(&self) -> usize {
        self.engine.finish_extension_frames()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_ring_wraps_without_reordering_or_allocating() {
        let mut ring = SampleRing::new(8);
        let first = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0];
        let second = [6.0, 7.0, 8.0, 9.0, 10.0];
        let mut prefix = [0.0; 5];
        let mut suffix = [0.0; 6];

        assert_no_alloc::assert_no_alloc(|| {
            ring.push(&first).unwrap();
            assert_eq!(ring.pop_into(&mut prefix), prefix.len());
            ring.push(&second).unwrap();
            assert_eq!(ring.pop_into(&mut suffix), suffix.len());
        });

        assert_eq!(prefix, [0.0, 1.0, 2.0, 3.0, 4.0]);
        assert_eq!(suffix, [5.0, 6.0, 7.0, 8.0, 9.0, 10.0]);
        assert!(ring.is_empty());
    }

    #[test]
    fn double_chunk_input_ring_keeps_each_front_chunk_contiguous() {
        const CHUNK: usize = 4;
        let mut ring = SampleRing::new(CHUNK * 2);
        ring.push(&[0.0, 1.0, 2.0, 3.0, 4.0, 5.0]).unwrap();
        assert_eq!(ring.front_contiguous(CHUNK).unwrap(), &[0.0, 1.0, 2.0, 3.0]);
        ring.consume(CHUNK).unwrap();
        ring.push(&[6.0, 7.0]).unwrap();
        assert_eq!(ring.front_contiguous(CHUNK).unwrap(), &[4.0, 5.0, 6.0, 7.0]);
        ring.consume(CHUNK).unwrap();
        assert!(ring.is_empty());
    }

    #[test]
    fn split_interleaved_input_bulk_copy_crosses_the_boundary_without_allocating() {
        let prefix = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0];
        let suffix = [6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0];
        let input = SplitInterleavedInput::new(&prefix, &suffix, 2).unwrap();
        let mut left = [-1.0; 7];
        let mut right = [-1.0; 4];

        assert_no_alloc::assert_no_alloc(|| {
            assert_eq!(input.copy_from_channel_to_slice(0, 0, &mut left), 7);
            assert_eq!(input.copy_from_channel_to_slice(1, 2, &mut right), 4);
        });

        assert_eq!(left, [0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0]);
        assert_eq!(right, [5.0, 7.0, 9.0, 11.0]);
        assert_eq!(input.read_sample(1, 6), Some(13.0));
        assert_eq!(input.copy_from_channel_to_slice(2, 0, &mut left), 0);
        assert_eq!(input.copy_from_channel_to_slice(0, 7, &mut left), 0);
    }

    #[test]
    fn direct_interleaved_output_bulk_copy_preserves_layout_without_allocating() {
        let mut output = [-1.0; 10];
        {
            let mut adapter = DirectInterleavedOutput::new(&mut output, 2, 5).unwrap();

            assert_no_alloc::assert_no_alloc(|| {
                assert_eq!(
                    adapter.copy_from_slice_to_channel(0, 0, &[0.0, 2.0, 4.0, 6.0, 8.0]),
                    (5, 0)
                );
                assert_eq!(
                    adapter.copy_from_slice_to_channel(1, 0, &[1.0, 3.0, 5.0, 7.0, 9.0]),
                    (5, 0)
                );
            });

            let mut short = [11.0, 13.0, 15.0, 17.0];
            assert_eq!(adapter.copy_from_channel_to_slice(1, 2, &mut short), 3);
            assert_eq!(short, [5.0, 7.0, 9.0, 17.0]);
        }
        assert_eq!(output, [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]);
    }

    #[test]
    fn terminal_interleaved_output_discards_delay_and_suffix_without_allocating() {
        let mut output = [-1.0; 6];
        {
            let mut adapter = TerminalInterleavedOutput::new(&mut output, 2, 7, 2, 3).unwrap();

            assert_no_alloc::assert_no_alloc(|| {
                assert_eq!(
                    adapter.copy_from_slice_to_channel(
                        0,
                        0,
                        &[0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0],
                    ),
                    (7, 0)
                );
                assert_eq!(
                    adapter.copy_from_slice_to_channel(
                        1,
                        0,
                        &[1.0, 3.0, 5.0, 7.0, 9.0, 11.0, 13.0],
                    ),
                    (7, 0)
                );
            });
        }
        assert_eq!(output, [4.0, 5.0, 6.0, 7.0, 8.0, 9.0]);
    }

    fn render_backend(backend: &mut MonoBackend, input: &[f64], channels: usize) -> Vec<f64> {
        render_backend_with_output_frames(backend, input, channels, CHUNK_IN * 4)
    }

    fn render_backend_with_output_frames(
        backend: &mut MonoBackend,
        input: &[f64],
        channels: usize,
        output_frames: usize,
    ) -> Vec<f64> {
        render_backend_with_patterns(
            backend,
            input,
            channels,
            output_frames,
            &[127, 509, 31, 1_024],
        )
    }

    fn render_backend_with_patterns(
        backend: &mut MonoBackend,
        input: &[f64],
        channels: usize,
        output_frames: usize,
        input_chunk_pattern: &[usize],
    ) -> Vec<f64> {
        assert!(!input_chunk_pattern.is_empty());
        let input_frames = input.len() / channels;
        let mut output = Vec::new();
        let mut output_scratch = vec![0.0; output_frames * channels];
        let mut input_cursor = 0;
        let mut pattern_cursor = 0;

        while input_cursor < input_frames {
            let chunk_frames = input_chunk_pattern[pattern_cursor % input_chunk_pattern.len()]
                .min(input_frames - input_cursor);
            pattern_cursor += 1;
            let chunk_end = input_cursor + chunk_frames;
            while input_cursor < chunk_end {
                let input_start = input_cursor * channels;
                let input_end = chunk_end * channels;
                let progress = backend
                    .process(
                        &input[input_start..input_end],
                        output_scratch.as_mut_slice(),
                    )
                    .unwrap();
                assert!(progress.input_frames > 0 || progress.output_frames > 0);
                output.extend_from_slice(&output_scratch[..progress.output_frames * channels]);
                input_cursor += progress.input_frames;
            }
        }

        loop {
            let produced_frames = backend.drain(output_scratch.as_mut_slice()).unwrap();
            output.extend_from_slice(&output_scratch[..produced_frames * channels]);
            if produced_frames == 0 {
                break;
            }
        }
        output
    }

    fn assert_interleaved_matches_independent_mono(
        from_rate: u32,
        to_rate: u32,
        quality: ResampleQuality,
    ) {
        const CHANNELS: usize = 2;
        const INPUT_FRAMES: usize = 4_097;
        let input: Vec<f64> = (0..INPUT_FRAMES)
            .flat_map(|frame| {
                let time = frame as f64;
                [
                    (time * 0.017).sin() * 0.5 + (time * 0.003).cos() * 0.1,
                    (time * 0.013 + 0.7).sin() * 0.4 - (time * 0.005).cos() * 0.2,
                ]
            })
            .collect();

        let mut interleaved = MonoBackend::new_interleaved(
            from_rate,
            to_rate,
            PhaseResponse::Linear,
            quality,
            CHANNELS,
        )
        .unwrap();
        let actual = render_backend(&mut interleaved, &input, CHANNELS);

        let mut mono_outputs = Vec::with_capacity(CHANNELS);
        for channel in 0..CHANNELS {
            let mono_input: Vec<f64> = input
                .chunks_exact(CHANNELS)
                .map(|frame| frame[channel])
                .collect();
            let mut mono =
                MonoBackend::new(from_rate, to_rate, PhaseResponse::Linear, quality).unwrap();
            mono_outputs.push(render_backend(&mut mono, &mono_input, 1));
        }

        let output_frames = actual.len() / CHANNELS;
        assert!(mono_outputs
            .iter()
            .all(|channel| channel.len() == output_frames));
        let mut max_error = 0.0_f64;
        for frame in 0..output_frames {
            for channel in 0..CHANNELS {
                max_error = max_error
                    .max((actual[frame * CHANNELS + channel] - mono_outputs[channel][frame]).abs());
            }
        }
        assert!(
            max_error <= 1.0e-14,
            "native interleaved {quality:?} output diverged from independent mono by {max_error:e}"
        );
    }

    #[test]
    fn fft_routing_accepts_common_audio_ratios_and_rejects_pathological_ones() {
        for quality in [
            ResampleQuality::Low,
            ResampleQuality::Standard,
            ResampleQuality::High,
            ResampleQuality::UltraHigh,
        ] {
            for (from_rate, to_rate) in [(44_100, 48_000), (96_000, 44_100), (44_100, 192_000)] {
                assert!(should_use_fft(from_rate, to_rate, quality));
            }
            assert!(!should_use_fft(44_100, 44_101, quality));
        }
        assert!(!should_use_fft(0, 48_000, ResampleQuality::High));
    }

    #[test]
    fn exact_two_x_high_upsampling_routes_to_halfband_without_broadening() {
        assert!(should_use_halfband_2x(
            48_000,
            96_000,
            PhaseResponse::Linear,
            ResampleQuality::High
        ));
        assert!(should_use_halfband_2x(
            44_100,
            88_200,
            PhaseResponse::Linear,
            ResampleQuality::High
        ));
        for (from_rate, to_rate, phase, quality) in [
            (
                48_000,
                96_000,
                PhaseResponse::Linear,
                ResampleQuality::Standard,
            ),
            (
                48_000,
                96_000,
                PhaseResponse::Linear,
                ResampleQuality::UltraHigh,
            ),
            (96_000, 48_000, PhaseResponse::Linear, ResampleQuality::High),
            (
                48_000,
                96_000,
                PhaseResponse::Minimum,
                ResampleQuality::High,
            ),
            (44_100, 48_000, PhaseResponse::Linear, ResampleQuality::High),
        ] {
            assert!(!should_use_halfband_2x(from_rate, to_rate, phase, quality));
        }
        assert!(matches!(
            RubatoEngine::new(
                48_000,
                96_000,
                PhaseResponse::Linear,
                ResampleQuality::High,
                2,
            )
            .unwrap()
            .0,
            RubatoEngine::Halfband(_)
        ));
    }

    #[test]
    fn ultra_high_routes_common_ratios_to_fft_and_pathological_ratios_to_sinc() {
        assert_eq!(fft_geometry(ResampleQuality::UltraHigh), (CHUNK_IN, 1));
        assert_eq!(fft_geometry(ResampleQuality::High), (CHUNK_IN, 2));
        assert!(matches!(
            RubatoEngine::new(
                44_100,
                48_000,
                PhaseResponse::Linear,
                ResampleQuality::High,
                1,
            )
            .unwrap()
            .0,
            RubatoEngine::Fft(_)
        ));
        assert!(matches!(
            RubatoEngine::new(
                44_100,
                48_000,
                PhaseResponse::Linear,
                ResampleQuality::UltraHigh,
                1,
            )
            .unwrap()
            .0,
            RubatoEngine::Fft(_)
        ));
        // UltraHigh's one-sub-chunk FFT unit is twice the High unit, so its
        // per-call output block and leading delay differ from High.
        let (high, high_chunk_in) = RubatoEngine::new(
            44_100,
            48_000,
            PhaseResponse::Linear,
            ResampleQuality::High,
            1,
        )
        .unwrap();
        let (ultra, ultra_chunk_in) = RubatoEngine::new(
            44_100,
            48_000,
            PhaseResponse::Linear,
            ResampleQuality::UltraHigh,
            1,
        )
        .unwrap();
        assert_eq!(high_chunk_in, CHUNK_IN);
        assert_eq!(ultra_chunk_in, CHUNK_IN);
        assert!(ultra.output_delay() > high.output_delay());
        for quality in [ResampleQuality::High, ResampleQuality::UltraHigh] {
            assert!(matches!(
                RubatoEngine::new(44_100, 44_101, PhaseResponse::Linear, quality, 1)
                    .unwrap()
                    .0,
                RubatoEngine::Sinc(_)
            ));
        }
    }

    #[test]
    fn native_interleaved_matches_independent_mono_for_fft_and_sinc() {
        assert_interleaved_matches_independent_mono(44_100, 48_000, ResampleQuality::High);
        assert_interleaved_matches_independent_mono(44_100, 48_000, ResampleQuality::UltraHigh);
        assert_interleaved_matches_independent_mono(48_000, 96_000, ResampleQuality::UltraHigh);
        assert_interleaved_matches_independent_mono(48_000, 96_000, ResampleQuality::High);
    }

    #[test]
    fn aligned_complete_chunks_bypass_the_input_fifo_without_allocating() {
        const CHANNELS: usize = 2;
        let mut backend = MonoBackend::new_interleaved(
            44_100,
            48_000,
            PhaseResponse::Linear,
            ResampleQuality::High,
            CHANNELS,
        )
        .unwrap();
        let input_frames = backend.chunk_in * 2;
        let input = (0..input_frames)
            .flat_map(|frame| {
                let frame = frame as f64;
                [(frame * 0.031).sin() * 0.6, (frame * 0.047).cos() * 0.5]
            })
            .collect::<Vec<_>>();
        let mut output = vec![0.0; backend.engine.output_frames_max() * 2 * CHANNELS];
        let mut progress = None;

        assert_no_alloc::assert_no_alloc(|| {
            progress = Some(backend.process(&input, &mut output).unwrap());
        });

        let progress = progress.unwrap();
        assert_eq!(progress.input_frames, input_frames);
        assert_eq!(backend.direct_input_chunks, 2);
        assert!(backend.in_fifo.is_empty());

        backend.clear().unwrap();
        let chunk_in = backend.chunk_in;
        let mut constrained_output = vec![0.0; 257 * CHANNELS];
        assert_no_alloc::assert_no_alloc(|| {
            let progress = backend
                .process(&input[..chunk_in * CHANNELS], &mut constrained_output)
                .unwrap();
            assert_eq!(progress.input_frames, chunk_in);
        });
        assert_eq!(backend.direct_input_chunks, 1);
        assert!(backend.in_fifo.is_empty());
    }

    #[test]
    fn fft_split_input_completion_matches_fifo_for_128_256_and_512_callers() {
        const CHANNELS: usize = 2;
        const INPUT_FRAMES: usize = 8_193;
        let input = (0..INPUT_FRAMES)
            .flat_map(|frame| {
                let frame = frame as f64;
                [
                    (frame * 0.011).sin() * 0.51 + (frame * 0.037).cos() * 0.08,
                    (frame * 0.023 + 0.2).cos() * 0.47 - (frame * 0.005).sin() * 0.11,
                ]
            })
            .collect::<Vec<_>>();

        for (from_rate, to_rate) in [(44_100, 48_000), (48_000, 44_100)] {
            for caller_frames in [128, 256, 512] {
                let make = || {
                    MonoBackend::new_interleaved(
                        from_rate,
                        to_rate,
                        PhaseResponse::Linear,
                        ResampleQuality::High,
                        CHANNELS,
                    )
                    .unwrap()
                };
                let mut split = make();
                let mut fifo = make();
                fifo.split_input_enabled = false;

                let split_output = render_backend_with_patterns(
                    &mut split,
                    &input,
                    CHANNELS,
                    257,
                    &[caller_frames],
                );
                let fifo_output = render_backend_with_patterns(
                    &mut fifo,
                    &input,
                    CHANNELS,
                    257,
                    &[caller_frames],
                );

                assert!(
                    split.split_input_chunks > 0,
                    "{from_rate}->{to_rate} with {caller_frames}-frame callers missed split input"
                );
                assert_eq!(fifo.split_input_chunks, 0);
                assert_bits_equal(
                    &split_output,
                    &fifo_output,
                    "FFT split input vs FIFO completion",
                );
            }
        }
    }

    #[test]
    fn fft_split_input_completion_is_allocation_free_and_reset_fresh_exact() {
        const CHANNELS: usize = 2;
        let make = || {
            MonoBackend::new_interleaved(
                44_100,
                48_000,
                PhaseResponse::Linear,
                ResampleQuality::High,
                CHANNELS,
            )
            .unwrap()
        };
        let mut backend = make();
        let input = (0..backend.chunk_in)
            .flat_map(|frame| {
                let frame = frame as f64;
                [(frame * 0.017).sin() * 0.5, (frame * 0.031).cos() * 0.4]
            })
            .collect::<Vec<_>>();
        let mut output = vec![0.0; 257 * CHANNELS];
        let prefix_frames = backend.chunk_in / 2;
        let prefix = &input[..prefix_frames * CHANNELS];
        let suffix = &input[prefix_frames * CHANNELS..];
        let first = backend.process(prefix, &mut output).unwrap();
        assert_eq!(first.input_frames, prefix_frames);
        assert_eq!(first.output_frames, 0);

        let mut second = None;
        assert_no_alloc::assert_no_alloc(|| {
            second = Some(backend.process(suffix, &mut output).unwrap());
        });
        let second = second.unwrap();
        assert_eq!(second.input_frames, prefix_frames);
        assert!(second.output_frames > 0);
        assert_eq!(backend.split_input_chunks, 1);

        let stream = (0..4_097)
            .flat_map(|frame| {
                let frame = frame as f64;
                [(frame * 0.013).sin() * 0.5, (frame * 0.019).cos() * 0.4]
            })
            .collect::<Vec<_>>();
        backend.clear().unwrap();
        let first = render_backend_with_patterns(&mut backend, &stream, CHANNELS, 257, &[512]);
        assert!(backend.split_input_chunks > 0);
        backend.clear().unwrap();
        let after_reset =
            render_backend_with_patterns(&mut backend, &stream, CHANNELS, 257, &[512]);
        let mut fresh = make();
        let fresh_output = render_backend_with_patterns(&mut fresh, &stream, CHANNELS, 257, &[512]);
        assert_bits_equal(&first, &after_reset, "FFT split input reset");
        assert_bits_equal(&after_reset, &fresh_output, "FFT split input fresh");
    }

    #[test]
    fn fft_partial_zero_drain_matches_explicit_zero_fifo_path_bit_exactly() {
        const CHANNELS: usize = 2;
        const INPUT_FRAMES: usize = CHUNK_IN * 4;
        let input = (0..INPUT_FRAMES)
            .flat_map(|frame| {
                let frame = frame as f64;
                [
                    (frame * 0.013).sin() * 0.51 + (frame * 0.003).cos() * 0.07,
                    (frame * 0.019).cos() * 0.43 - (frame * 0.005).sin() * 0.09,
                ]
            })
            .collect::<Vec<_>>();

        for (from_rate, to_rate) in [(44_100, 48_000), (48_000, 44_100)] {
            for caller_frames in [128, 256, 512] {
                let make = || {
                    MonoBackend::new_interleaved(
                        from_rate,
                        to_rate,
                        PhaseResponse::Linear,
                        ResampleQuality::High,
                        CHANNELS,
                    )
                    .unwrap()
                };
                let mut partial_zero = make();
                let mut explicit_zero = make();
                explicit_zero.partial_zero_drain_enabled = false;

                let partial_output = render_backend_with_patterns(
                    &mut partial_zero,
                    &input,
                    CHANNELS,
                    257,
                    &[caller_frames],
                );
                let explicit_output = render_backend_with_patterns(
                    &mut explicit_zero,
                    &input,
                    CHANNELS,
                    257,
                    &[caller_frames],
                );

                assert!(
                    partial_zero.partial_zero_drain_chunks > 0,
                    "{from_rate}->{to_rate} with {caller_frames}-frame callers missed partial-zero drain"
                );
                assert_eq!(explicit_zero.partial_zero_drain_chunks, 0);
                assert_bits_equal(
                    &explicit_output,
                    &partial_output,
                    "FFT partial-zero vs explicit-zero drain",
                );
                let mut terminal = vec![0.0; 257 * CHANNELS];
                assert_eq!(partial_zero.drain(&mut terminal).unwrap(), 0);
                assert_eq!(explicit_zero.drain(&mut terminal).unwrap(), 0);
            }
        }
    }

    #[test]
    fn fft_terminal_truncate_drain_matches_split_spill_bit_exactly() {
        const CHANNELS: usize = 2;
        const INPUT_FRAMES: usize = CHUNK_IN * 4;
        let input = (0..INPUT_FRAMES)
            .flat_map(|frame| {
                let frame = frame as f64;
                [(frame * 0.011).sin() * 0.5, (frame * 0.029).cos() * 0.4]
            })
            .collect::<Vec<_>>();

        for (from_rate, to_rate) in [(44_100, 48_000), (48_000, 44_100)] {
            let make = || {
                MonoBackend::new_interleaved(
                    from_rate,
                    to_rate,
                    PhaseResponse::Linear,
                    ResampleQuality::High,
                    CHANNELS,
                )
                .unwrap()
            };
            let mut terminal = make();
            let mut split_spill = make();
            split_spill.terminal_truncate_drain_enabled = false;
            let output_frames = terminal.engine.output_frames_max();

            let terminal_output = render_backend_with_patterns(
                &mut terminal,
                &input,
                CHANNELS,
                output_frames,
                &[512],
            );
            let split_output = render_backend_with_patterns(
                &mut split_spill,
                &input,
                CHANNELS,
                output_frames,
                &[512],
            );

            assert!(terminal.terminal_truncate_drain_chunks > 0);
            assert_eq!(split_spill.terminal_truncate_drain_chunks, 0);
            assert!(split_spill.partial_zero_drain_chunks > 0);
            assert_bits_equal(
                &split_output,
                &terminal_output,
                "FFT terminal truncate vs split spill drain",
            );
            let mut repeated = vec![0.0; output_frames * CHANNELS];
            assert_eq!(terminal.drain(&mut repeated).unwrap(), 0);
            assert_eq!(split_spill.drain(&mut repeated).unwrap(), 0);
        }
    }

    #[test]
    fn fft_partial_zero_drain_is_allocation_free_with_constrained_output() {
        const CHANNELS: usize = 2;
        let mut backend = MonoBackend::new_interleaved(
            44_100,
            48_000,
            PhaseResponse::Linear,
            ResampleQuality::High,
            CHANNELS,
        )
        .unwrap();
        let input = (0..CHUNK_IN * 4)
            .flat_map(|frame| {
                let frame = frame as f64;
                [(frame * 0.017).sin() * 0.5, (frame * 0.023).cos() * 0.4]
            })
            .collect::<Vec<_>>();
        let mut process_output = vec![0.0; backend.engine.output_frames_max() * CHANNELS];
        for chunk in input.chunks_exact(CHUNK_IN * CHANNELS) {
            let progress = backend.process(chunk, &mut process_output).unwrap();
            assert_eq!(progress.input_frames, CHUNK_IN);
        }
        assert!(backend.in_fifo.is_empty());

        let mut drain_output = vec![0.0; 257 * CHANNELS];
        let mut terminal = false;
        assert_no_alloc::assert_no_alloc(|| {
            for _ in 0..64 {
                if backend.drain(&mut drain_output).unwrap() == 0 {
                    terminal = true;
                    break;
                }
            }
        });
        assert!(terminal, "partial-zero drain did not terminate");
        assert!(backend.partial_zero_drain_chunks > 0);
        assert_eq!(backend.drain(&mut drain_output).unwrap(), 0);
    }

    #[test]
    fn fft_terminal_truncate_drain_is_allocation_free() {
        const CHANNELS: usize = 2;
        let mut backend = MonoBackend::new_interleaved(
            44_100,
            48_000,
            PhaseResponse::Linear,
            ResampleQuality::High,
            CHANNELS,
        )
        .unwrap();
        let input = vec![0.25; CHUNK_IN * 4 * CHANNELS];
        let output_frames = backend.engine.output_frames_max();
        let mut output = vec![0.0; output_frames * CHANNELS];
        for chunk in input.chunks_exact(CHUNK_IN * CHANNELS) {
            let progress = backend.process(chunk, &mut output).unwrap();
            assert_eq!(progress.input_frames, CHUNK_IN);
        }
        assert!(backend.in_fifo.is_empty());

        let mut terminal = false;
        assert_no_alloc::assert_no_alloc(|| {
            for _ in 0..8 {
                if backend.drain(&mut output).unwrap() == 0 {
                    terminal = true;
                    break;
                }
            }
        });
        assert!(terminal);
        assert!(backend.terminal_truncate_drain_chunks > 0);
        assert_eq!(backend.drain(&mut output).unwrap(), 0);
    }

    #[test]
    fn fft_split_output_matches_forced_fifo_staging_bit_exactly() {
        const CHANNELS: usize = 2;
        const INPUT_FRAMES: usize = 8_192;
        let input = (0..INPUT_FRAMES)
            .flat_map(|frame| {
                let frame = frame as f64;
                [
                    (frame * 0.019).sin() * 0.55 + (frame * 0.003).cos() * 0.12,
                    (frame * 0.029 + 0.4).cos() * 0.48 - (frame * 0.007).sin() * 0.09,
                ]
            })
            .collect::<Vec<_>>();
        let make = || {
            MonoBackend::new_interleaved(
                44_100,
                48_000,
                PhaseResponse::Linear,
                ResampleQuality::High,
                CHANNELS,
            )
            .unwrap()
        };
        let mut split = make();
        let mut staged = make();
        let caller_output_frames = 622;

        let split_output = render_backend_with_patterns(
            &mut split,
            &input,
            CHANNELS,
            caller_output_frames,
            &[CHUNK_IN],
        );
        let staged_output = render_backend_with_patterns(
            &mut staged,
            &input,
            CHANNELS,
            caller_output_frames,
            &[1, CHUNK_IN - 1],
        );

        assert!(split.direct_input_chunks > 0);
        assert_eq!(staged.direct_input_chunks, 0);
        assert!(split.direct_drain_chunks > 0);
        assert!(staged.direct_drain_chunks > 0);
        assert_bits_equal(&split_output, &staged_output, "FFT split vs staged output");
    }

    #[test]
    fn duration_stable_direct_output_is_bit_exact_with_staged_output() {
        const INPUT_FRAMES: usize = 8_193;
        let input: Vec<f64> = (0..INPUT_FRAMES)
            .map(|frame| {
                let time = frame as f64;
                (time * 0.071).sin() * 0.6 + (time * 0.013).cos() * 0.2
            })
            .collect();

        for (from_rate, to_rate, quality) in [
            (48_000, 96_000, ResampleQuality::High),
            (96_000, 48_000, ResampleQuality::UltraHigh),
        ] {
            let mut direct =
                MonoBackend::new(from_rate, to_rate, PhaseResponse::Linear, quality).unwrap();
            let mut staged =
                MonoBackend::new(from_rate, to_rate, PhaseResponse::Linear, quality).unwrap();

            let direct_output = render_backend(&mut direct, &input, 1);
            let staged_output = render_backend_with_output_frames(&mut staged, &input, 1, 257);
            assert_eq!(
                direct_output.len(),
                staged_output.len(),
                "{from_rate}->{to_rate} output length"
            );
            if let Some(index) = direct_output
                .iter()
                .zip(&staged_output)
                .position(|(direct, staged)| direct.to_bits() != staged.to_bits())
            {
                panic!(
                    "{from_rate}->{to_rate} first mismatch at {index}: direct={} staged={}",
                    direct_output[index], staged_output[index]
                );
            }
        }
    }

    fn noninteger_input() -> Vec<f64> {
        const INPUT_FRAMES: usize = 9_311;
        (0..INPUT_FRAMES)
            .map(|frame| {
                let time = frame as f64;
                (time * 0.041).sin() * 0.55 + (time * 0.007).cos() * 0.25
            })
            .collect()
    }

    #[test]
    fn noninteger_direct_output_is_bit_exact_with_staged_output() {
        let input = noninteger_input();
        let expected_len = expected_output_frames(input.len() as u64, 44_100, 48_000) as usize;

        for quality in [ResampleQuality::High, ResampleQuality::UltraHigh] {
            let make = || MonoBackend::new(44_100, 48_000, PhaseResponse::Linear, quality).unwrap();
            assert!(make().prefix_budget_direct);

            // Ordinary large caller output: eligible for the direct branch.
            let direct = render_backend(&mut make(), &input, 1);
            // Output-constrained caller: always forced through the staged route.
            let staged = render_backend_with_output_frames(&mut make(), &input, 1, 257);
            // Irregular caller output sizes: mixes direct and staged chunks.
            let irregular = render_backend_with_output_frames(&mut make(), &input, 1, 1_201);

            assert_eq!(direct.len(), expected_len);
            assert_eq!(staged.len(), expected_len);
            assert_eq!(irregular.len(), expected_len);
            for (name, other) in [("staged", &staged), ("irregular", &irregular)] {
                if let Some(index) = direct
                    .iter()
                    .zip(other.iter())
                    .position(|(left, right)| left.to_bits() != right.to_bits())
                {
                    panic!(
                        "44100->48000 {quality:?} direct vs {name} first mismatch at {index}: {} vs {}",
                        direct[index], other[index]
                    );
                }
            }
        }
    }

    #[test]
    fn noninteger_direct_prefix_never_exceeds_real_input_budget() {
        let input = noninteger_input();
        let mut backend =
            MonoBackend::new(44_100, 48_000, PhaseResponse::Linear, ResampleQuality::High).unwrap();
        let mut output = vec![0.0; CHUNK_IN * 4];
        let mut collected = 0usize;
        let mut cursor = 0usize;
        while cursor < input.len() {
            let end = (cursor + 733).min(input.len());
            let progress = backend.process(&input[cursor..end], &mut output).unwrap();
            cursor += progress.input_frames;
            collected += progress.output_frames;
            assert!(backend.processed_real_input <= backend.total_input);
            let allowed =
                expected_output_frames(backend.processed_real_input, 44_100, 48_000) as usize;
            assert!(
                collected <= allowed,
                "emitted {collected} frames beyond real-input budget {allowed}"
            );
        }
        loop {
            let produced = backend.drain(&mut output).unwrap();
            collected += produced;
            if produced == 0 {
                break;
            }
        }
        let expected = expected_output_frames(input.len() as u64, 44_100, 48_000) as usize;
        assert_eq!(collected, expected, "complete finish duration mismatch");
    }

    #[test]
    fn noninteger_clear_after_process_and_partial_drain_matches_fresh() {
        let input = noninteger_input();
        let mut fresh =
            MonoBackend::new(44_100, 48_000, PhaseResponse::Linear, ResampleQuality::High).unwrap();
        let expected = render_backend(&mut fresh, &input, 1);

        // Reset after process only.
        let mut reused =
            MonoBackend::new(44_100, 48_000, PhaseResponse::Linear, ResampleQuality::High).unwrap();
        let mut scratch = vec![0.0; CHUNK_IN * 4];
        let mut cursor = 0usize;
        while cursor < 3_000 {
            let progress = backend_step(&mut reused, &input[cursor..3_000], &mut scratch);
            cursor += progress;
        }
        reused.clear().unwrap();
        let after_process_reset = render_backend(&mut reused, &input, 1);
        assert_bits_equal(&expected, &after_process_reset, "reset after process");

        // Reset after a partial drain.
        let mut reused =
            MonoBackend::new(44_100, 48_000, PhaseResponse::Linear, ResampleQuality::High).unwrap();
        let mut cursor = 0usize;
        while cursor < 3_000 {
            let progress = backend_step(&mut reused, &input[cursor..3_000], &mut scratch);
            cursor += progress;
        }
        let mut small = [0.0; 97];
        let _ = reused.drain(&mut small).unwrap();
        reused.clear().unwrap();
        let after_partial_drain_reset = render_backend(&mut reused, &input, 1);
        assert_bits_equal(&expected, &after_partial_drain_reset, "reset after drain");
    }

    fn backend_step(backend: &mut MonoBackend, input: &[f64], scratch: &mut [f64]) -> usize {
        let progress = backend.process(input, scratch).unwrap();
        assert!(progress.input_frames > 0 || progress.output_frames > 0);
        progress.input_frames
    }

    fn assert_bits_equal(expected: &[f64], actual: &[f64], label: &str) {
        assert_eq!(expected.len(), actual.len(), "{label} length");
        if let Some(index) = expected
            .iter()
            .zip(actual.iter())
            .position(|(left, right)| left.to_bits() != right.to_bits())
        {
            panic!(
                "{label} first mismatch at {index}: {} vs {}",
                expected[index], actual[index]
            );
        }
    }

    #[test]
    fn noninteger_process_and_drain_do_not_allocate_after_setup() {
        let input = noninteger_input();
        for quality in [ResampleQuality::High, ResampleQuality::UltraHigh] {
            let mut backend =
                MonoBackend::new(44_100, 48_000, PhaseResponse::Linear, quality).unwrap();
            let mut output = vec![0.0; backend.engine.output_frames_max().max(CHUNK_IN * 4)];
            assert_no_alloc::assert_no_alloc(|| {
                let mut cursor = 0usize;
                while cursor < input.len() {
                    let end = (cursor + 733).min(input.len());
                    let progress = backend.process(&input[cursor..end], &mut output).unwrap();
                    cursor += progress.input_frames;
                }
                loop {
                    if backend.drain(&mut output).unwrap() == 0 {
                        break;
                    }
                }
            });
        }
    }

    #[test]
    fn clear_restores_the_selected_engines_leading_delay() {
        for (from_rate, to_rate, quality) in [
            (44_100, 48_000, ResampleQuality::High),
            (48_000, 96_000, ResampleQuality::High),
            (44_100, 48_000, ResampleQuality::UltraHigh),
            (44_100, 44_101, ResampleQuality::High),
        ] {
            let mut backend =
                MonoBackend::new(from_rate, to_rate, PhaseResponse::Linear, quality).unwrap();
            assert!(backend.initial_delay > 0);
            backend.delay_remaining = 0;
            backend.clear().unwrap();
            assert_eq!(backend.delay_remaining, backend.initial_delay);
        }
    }

    #[test]
    fn nonlinear_routing_selects_spectral_for_small_up_and_polyphase_for_large_up() {
        // The routing threshold itself is part of the benchmark and quality
        // contract: reduced up = 16 stays spectral, 17 moves to contiguous
        // polyphase.
        assert!(nonlinear_uses_spectral(45_000, 48_000));
        assert!(!nonlinear_uses_spectral(48_000, 51_000));
        for quality in [
            ResampleQuality::Low,
            ResampleQuality::Standard,
            ResampleQuality::High,
            ResampleQuality::UltraHigh,
        ] {
            for phase in [PhaseResponse::Minimum, PhaseResponse::Maximum] {
                // Reduced up = 2 and 1: spectral.
                assert!(nonlinear_uses_spectral(48_000, 96_000));
                assert!(nonlinear_uses_spectral(96_000, 48_000));
                assert!(matches!(
                    RubatoEngine::new(48_000, 96_000, phase, quality, 2)
                        .unwrap()
                        .0,
                    RubatoEngine::Nonlinear(NonlinearEngine::Spectral(_))
                ));
                // Reduced up = 160 / 147: contiguous polyphase.
                assert!(!nonlinear_uses_spectral(44_100, 48_000));
                assert!(!nonlinear_uses_spectral(48_000, 44_100));
                assert!(matches!(
                    RubatoEngine::new(44_100, 48_000, phase, quality, 2)
                        .unwrap()
                        .0,
                    RubatoEngine::Nonlinear(NonlinearEngine::Polyphase(_))
                ));
                assert!(matches!(
                    RubatoEngine::new(48_000, 44_100, phase, quality, 2)
                        .unwrap()
                        .0,
                    RubatoEngine::Nonlinear(NonlinearEngine::Polyphase(_))
                ));
                // Pathological reduced components stay rejected, never linear.
                assert!(RubatoEngine::new(44_100, 44_101, phase, quality, 2).is_err());
            }
        }
    }

    fn render_nonlinear(quality: ResampleQuality, output_frames: usize) -> Vec<f64> {
        let input = noninteger_input();
        let mut backend =
            MonoBackend::new(44_100, 48_000, PhaseResponse::Minimum, quality).unwrap();
        render_backend_with_output_frames(&mut backend, &input, 1, output_frames)
    }

    #[test]
    fn nonlinear_polyphase_direct_and_staged_streams_are_bit_exact_and_duration_aligned() {
        let input = noninteger_input();
        for quality in [ResampleQuality::High, ResampleQuality::UltraHigh] {
            let backend =
                MonoBackend::new(44_100, 48_000, PhaseResponse::Minimum, quality).unwrap();
            assert!(backend.prefix_budget_direct);
            let expected_len = expected_output_frames(input.len() as u64, 44_100, 48_000) as usize
                + backend.finish_extension_frames();

            let direct = render_nonlinear(quality, CHUNK_IN * 4);
            let staged = render_nonlinear(quality, 257);
            let irregular = render_nonlinear(quality, 1_201);
            assert_eq!(direct.len(), expected_len, "{quality:?} complete duration");
            assert_bits_equal(&direct, &staged, "nonlinear direct vs staged");
            assert_bits_equal(&direct, &irregular, "nonlinear direct vs irregular");
        }
    }

    #[test]
    fn nonlinear_polyphase_clear_after_partial_drain_matches_fresh() {
        let input = noninteger_input();
        let mut fresh = MonoBackend::new(
            44_100,
            48_000,
            PhaseResponse::Minimum,
            ResampleQuality::High,
        )
        .unwrap();
        let expected = render_backend(&mut fresh, &input, 1);

        let mut reused = MonoBackend::new(
            44_100,
            48_000,
            PhaseResponse::Minimum,
            ResampleQuality::High,
        )
        .unwrap();
        let mut scratch = vec![0.0; CHUNK_IN * 4];
        let mut cursor = 0usize;
        while cursor < 3_000 {
            let progress = backend_step(&mut reused, &input[cursor..3_000], &mut scratch);
            cursor += progress;
        }
        let mut small = [0.0; 97];
        let _ = reused.drain(&mut small).unwrap();
        reused.clear().unwrap();
        let after_reset = render_backend(&mut reused, &input, 1);
        assert_bits_equal(&expected, &after_reset, "nonlinear reset after drain");
    }

    #[test]
    fn nonlinear_polyphase_process_and_drain_do_not_allocate_after_setup() {
        let input = noninteger_input();
        let mut backend = MonoBackend::new(
            44_100,
            48_000,
            PhaseResponse::Minimum,
            ResampleQuality::High,
        )
        .unwrap();
        let mut output = vec![0.0; backend.engine.output_frames_max().max(CHUNK_IN * 4)];
        assert_no_alloc::assert_no_alloc(|| {
            let mut cursor = 0usize;
            while cursor < input.len() {
                let end = (cursor + 733).min(input.len());
                let progress = backend.process(&input[cursor..end], &mut output).unwrap();
                cursor += progress.input_frames;
            }
            loop {
                if backend.drain(&mut output).unwrap() == 0 {
                    break;
                }
            }
        });
    }
}
