//! FFT-based convolution for FIR filters.
//!
//! Short and medium impulse responses use a classic overlap-save engine. Long
//! impulse responses route to a uniform partitioned engine so callback work is
//! spread across fixed-size FFT blocks instead of one very large FFT.

use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use rustfft::num_complex::Complex;
use std::sync::Arc;

use super::traits::{AudioBlockRef, ProcessError};

/// Per-channel IR length above which [`FFTConvolver::new`] selects the
/// partitioned path.
///
/// The value intentionally keeps current FIR EQ tap counts on the existing
/// overlap-save path while routing room/reverb-length IRs to partitioned
/// convolution. Re-run `audio_convolver_perf` and `audio_fir_eq_perf` before
/// changing it.
pub const PARTITIONED_CONVOLUTION_IR_THRESHOLD: usize = 4_096;

/// Uniform partition size used by the long-IR convolution path.
pub const PARTITIONED_CONVOLUTION_PARTITION_SIZE: usize = 1_024;

/// Runtime convolution strategy selected for an [`FFTConvolver`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConvolutionStrategy {
    /// Classic single-kernel overlap-save convolution.
    OverlapSave,
    /// Head/tail uniform partitioned convolution for long impulse responses.
    Partitioned,
}

/// High-performance FFT convolver.
///
/// Zero-allocation implementation: all scratch buffers are pre-allocated at
/// construction time so checked `process_into`/`process_inplace` calls are
/// realtime-safe and return typed geometry errors without allocation.
#[derive(Clone)]
pub struct FFTConvolver {
    engine: ConvolverEngine,
}

#[derive(Clone)]
enum ConvolverEngine {
    OverlapSave(OverlapSaveConvolver),
    Partitioned(Box<PartitionedConvolver>),
}

impl FFTConvolver {
    /// Constructs a convolver after validating the public interleaved IR boundary.
    pub fn new(ir_data: &[f64], channels: usize) -> Result<Self, ProcessError> {
        let block = AudioBlockRef::new(ir_data, channels)?;
        if block.frames() == 0 {
            return Err(ProcessError::InvalidGeometry {
                processor: "FFTConvolver",
                operation: "construct",
                message: "impulse response must contain at least one complete frame",
            });
        }
        Self::from_validated_ir(ir_data, channels, block.frames())
    }

    fn from_validated_ir(
        ir_data: &[f64],
        channels: usize,
        ir_len_per_ch: usize,
    ) -> Result<Self, ProcessError> {
        let engine = if ir_len_per_ch > PARTITIONED_CONVOLUTION_IR_THRESHOLD {
            ConvolverEngine::Partitioned(Box::new(PartitionedConvolver::new(ir_data, channels)?))
        } else {
            ConvolverEngine::OverlapSave(OverlapSaveConvolver::new(ir_data, channels))
        };

        Ok(Self { engine })
    }

    /// Get the IR length per channel.
    pub fn ir_length(&self) -> usize {
        match &self.engine {
            ConvolverEngine::OverlapSave(engine) => engine.ir_length(),
            ConvolverEngine::Partitioned(engine) => engine.ir_length(),
        }
    }

    /// Number of interleaved channels this kernel was configured to process.
    pub fn channels(&self) -> usize {
        match &self.engine {
            ConvolverEngine::OverlapSave(engine) => engine.channels,
            ConvolverEngine::Partitioned(engine) => engine.channels,
        }
    }

    /// Get the FFT size used by the active engine.
    pub fn fft_size(&self) -> usize {
        match &self.engine {
            ConvolverEngine::OverlapSave(engine) => engine.fft_size(),
            ConvolverEngine::Partitioned(engine) => engine.fft_size(),
        }
    }

    /// Return the selected convolution strategy.
    pub fn strategy(&self) -> ConvolutionStrategy {
        match &self.engine {
            ConvolverEngine::OverlapSave(_) => ConvolutionStrategy::OverlapSave,
            ConvolverEngine::Partitioned(_) => ConvolutionStrategy::Partitioned,
        }
    }

    /// Return the partition size for long-IR mode.
    pub fn partition_size(&self) -> Option<usize> {
        match &self.engine {
            ConvolverEngine::OverlapSave(_) => None,
            ConvolverEngine::Partitioned(engine) => Some(engine.partition_size()),
        }
    }

    /// Reset internal state. Call this when starting a new track to avoid artifacts.
    pub fn reset(&mut self) {
        match &mut self.engine {
            ConvolverEngine::OverlapSave(engine) => engine.reset(),
            ConvolverEngine::Partitioned(engine) => engine.reset(),
        }
    }

    /// Process audio block with zero allocation.
    ///
    /// # Arguments
    /// * `input` - Input samples in interleaved format
    /// * `output` - Output buffer (must be same size as input)
    ///
    /// # Safety
    /// This method is real-time safe: no heap allocations, no mutex, no syscalls.
    #[inline]
    pub fn process_into(&mut self, input: &[f64], output: &mut [f64]) -> Result<(), ProcessError> {
        self.try_process_into(input, output)
    }

    #[inline]
    fn process_into_validated(
        &mut self,
        input: &[f64],
        output: &mut [f64],
    ) -> Result<(), ProcessError> {
        match &mut self.engine {
            ConvolverEngine::OverlapSave(engine) => {
                engine.process_into(input, output);
                Ok(())
            }
            ConvolverEngine::Partitioned(engine) => engine.process_into(input, output),
        }
    }

    /// Checked zero-allocation processing entry point.
    pub fn try_process_into(
        &mut self,
        input: &[f64],
        output: &mut [f64],
    ) -> Result<(), ProcessError> {
        let input_block = AudioBlockRef::new(input, self.channels())?;
        let output_block = AudioBlockRef::new(output, self.channels())?;
        if input_block.frames() != output_block.frames() {
            return Err(ProcessError::InvalidGeometry {
                processor: "FFTConvolver",
                operation: "process_into",
                message: "input and output must contain the same number of complete frames",
            });
        }
        self.process_into_validated(input, output)
    }

    /// Process audio block, returning a new Vec (convenience wrapper).
    ///
    /// Note: This method allocates. For real-time use, prefer `process_into`.
    pub fn process(&mut self, input: &[f64]) -> Result<Vec<f64>, ProcessError> {
        let mut output = vec![0.0; input.len()];
        self.process_into(input, &mut output)?;
        Ok(output)
    }

    /// Process audio block in-place with zero allocation.
    ///
    /// Uses internal scratch buffers for temporary storage.
    #[inline]
    pub fn process_inplace(&mut self, buf: &mut [f64]) -> Result<(), ProcessError> {
        self.try_process_inplace(buf)
    }

    #[inline]
    fn process_inplace_validated(&mut self, buf: &mut [f64]) -> Result<(), ProcessError> {
        match &mut self.engine {
            ConvolverEngine::OverlapSave(engine) => {
                engine.process_inplace(buf);
                Ok(())
            }
            ConvolverEngine::Partitioned(engine) => engine.process_inplace(buf),
        }
    }

    /// Process with one convolution kernel and a complementary dry/wet ramp.
    ///
    /// Existing engine scratch preserves the dry samples, so activation and
    /// disable fades add no allocation and require no second kernel.
    #[inline]
    pub fn process_inplace_with_wet_ramp(
        &mut self,
        buf: &mut [f64],
        start_frame: usize,
        total_frames: usize,
        fade_in: bool,
    ) -> Result<(), ProcessError> {
        let (start_wet, target_wet) = if fade_in { (0.0, 1.0) } else { (1.0, 0.0) };
        self.try_process_inplace_with_wet_transition(
            buf,
            start_frame,
            total_frames,
            start_wet,
            target_wet,
        )
    }

    /// Checked in-place wet-ramp entry point.
    pub fn try_process_inplace_with_wet_ramp(
        &mut self,
        buf: &mut [f64],
        start_frame: usize,
        total_frames: usize,
        fade_in: bool,
    ) -> Result<(), ProcessError> {
        let (start_wet, target_wet) = if fade_in { (0.0, 1.0) } else { (1.0, 0.0) };
        self.try_process_inplace_with_wet_transition(
            buf,
            start_frame,
            total_frames,
            start_wet,
            target_wet,
        )
    }

    pub(crate) fn try_process_inplace_with_wet_transition(
        &mut self,
        buf: &mut [f64],
        start_frame: usize,
        total_frames: usize,
        start_wet: f64,
        target_wet: f64,
    ) -> Result<(), ProcessError> {
        AudioBlockRef::new(buf, self.channels())?;
        self.process_inplace_with_wet_transition_validated(
            buf,
            start_frame,
            total_frames,
            start_wet,
            target_wet,
        )
    }

    #[inline]
    fn process_inplace_with_wet_transition_validated(
        &mut self,
        buf: &mut [f64],
        start_frame: usize,
        total_frames: usize,
        start_wet: f64,
        target_wet: f64,
    ) -> Result<(), ProcessError> {
        if total_frames == 0 {
            return self.process_inplace_validated(buf);
        }
        match &mut self.engine {
            ConvolverEngine::OverlapSave(engine) => {
                engine.process_inplace_with_wet_transition(
                    buf,
                    start_frame,
                    total_frames,
                    start_wet,
                    target_wet,
                );
                Ok(())
            }
            ConvolverEngine::Partitioned(engine) => engine.process_inplace_with_wet_transition(
                buf,
                start_frame,
                total_frames,
                start_wet,
                target_wet,
            ),
        }
    }

    /// Checked in-place processing entry point.
    pub fn try_process_inplace(&mut self, buf: &mut [f64]) -> Result<(), ProcessError> {
        AudioBlockRef::new(buf, self.channels())?;
        self.process_inplace_validated(buf)
    }
}

/// Classic overlap-save convolver used directly for short IRs and as the
/// zero-latency head path for the partitioned engine.
///
/// The convolved signal is real-valued, so the engine uses `realfft` rather
/// than a full complex transform whose imaginary half would be identically
/// zero. This matches [`PartitionedConvolver`] and halves both the spectral
/// storage (`fft_size / 2 + 1` bins) and the per-block transform cost.
#[derive(Clone)]
struct OverlapSaveConvolver {
    fft_size: usize,
    impulse_response_fft: Vec<Vec<Complex<f64>>>, // one half-spectrum per channel
    overlap_buffers: Vec<Vec<f64>>,               // overlap buffer per channel
    channels: usize,
    ir_len: usize,
    // Cached real-FFT plans to avoid recreating on each process call
    fft_forward: Arc<dyn RealToComplex<f64>>,
    fft_inverse: Arc<dyn ComplexToReal<f64>>,
    // Pre-allocated time-domain block reused as both real FFT input and
    // inverse output. `realfft` mutates its input, so this is scratch too.
    scratch_real: Vec<f64>,
    // Pre-allocated half-spectrum for the current block.
    scratch_spectrum: Vec<Complex<f64>>,
    // Workspace for `process_with_scratch`; the plain `process` convenience
    // method allocates its scratch on every call, which is not realtime-safe.
    fft_scratch: Vec<Complex<f64>>,
}

impl OverlapSaveConvolver {
    fn new(ir_data: &[f64], channels: usize) -> Self {
        let ir_len_total = ir_data.len();
        let ir_len_per_ch = ir_len_total / channels;

        // Pick a suitable FFT size (a power of two larger than 2*ir_len).
        let mut fft_size = 1;
        while fft_size < (ir_len_per_ch * 2) {
            fft_size <<= 1;
        }

        let mut planner = RealFftPlanner::<f64>::new();
        let fft_forward = planner.plan_fft_forward(fft_size);
        let fft_inverse = planner.plan_fft_inverse(fft_size);
        let spectrum_size = fft_forward.complex_len();

        let mut ir_ffts = Vec::with_capacity(channels);
        let mut overlap_bufs = Vec::with_capacity(channels);
        // Setup-only staging; the processing path never allocates.
        let mut ir_time = vec![0.0; fft_size];
        let mut ir_scratch = fft_forward.make_scratch_vec();

        for ch in 0..channels {
            let mut spectrum = vec![Complex::new(0.0, 0.0); spectrum_size];
            // Load the IR for this channel and zero-pad the rest.
            ir_time.fill(0.0);
            for i in 0..ir_len_per_ch {
                ir_time[i] = ir_data[i * channels + ch];
            }
            // Setup-time transform over a correctly sized buffer triple; the
            // length invariants cannot fail here.
            debug_assert_eq!(ir_time.len(), fft_size);
            let _ = fft_forward.process_with_scratch(&mut ir_time, &mut spectrum, &mut ir_scratch);
            ir_ffts.push(spectrum);
            overlap_bufs.push(vec![0.0; ir_len_per_ch - 1]);
        }

        // Pre-allocate the processing buffers so `process_*` never allocates.
        let scratch_real = vec![0.0; fft_size];
        let scratch_spectrum = vec![Complex::new(0.0, 0.0); spectrum_size];
        let fft_scratch = vec![
            Complex::new(0.0, 0.0);
            fft_forward
                .get_scratch_len()
                .max(fft_inverse.get_scratch_len())
        ];

        Self {
            fft_size,
            impulse_response_fft: ir_ffts,
            overlap_buffers: overlap_bufs,
            channels,
            ir_len: ir_len_per_ch,
            fft_forward,
            fft_inverse,
            scratch_real,
            scratch_spectrum,
            fft_scratch,
        }
    }

    fn ir_length(&self) -> usize {
        self.ir_len
    }

    fn fft_size(&self) -> usize {
        self.fft_size
    }

    fn reset(&mut self) {
        for overlap in &mut self.overlap_buffers {
            overlap.fill(0.0);
        }
    }

    #[inline]
    #[allow(clippy::too_many_arguments)]
    fn prepare_channel_chunk(
        scratch: &mut [f64],
        overlap: &[f64],
        input: &[f64],
        channels: usize,
        channel: usize,
        processed_frames: usize,
        chunk_len: usize,
        ir_len: usize,
    ) {
        scratch[..ir_len - 1].copy_from_slice(&overlap[..ir_len - 1]);

        for i in 0..chunk_len {
            scratch[i + ir_len - 1] = input[(processed_frames + i) * channels + channel];
        }
        scratch[ir_len - 1 + chunk_len..].fill(0.0);
    }

    #[inline]
    fn update_channel_overlap(
        overlap: &mut [f64],
        input: &[f64],
        channels: usize,
        channel: usize,
        processed_frames: usize,
        chunk_len: usize,
        ir_len: usize,
    ) {
        if chunk_len >= ir_len - 1 {
            for i in 0..ir_len - 1 {
                overlap[i] =
                    input[(processed_frames + chunk_len - (ir_len - 1) + i) * channels + channel];
            }
        } else {
            let shift = chunk_len;
            let keep = ir_len - 1 - shift;
            overlap.copy_within(shift..shift + keep, 0);
            for i in 0..shift {
                overlap[keep + i] = input[(processed_frames + i) * channels + channel];
            }
        }
    }

    #[inline]
    #[allow(clippy::too_many_arguments)]
    fn write_channel_output(
        scratch: &[f64],
        output: &mut [f64],
        channels: usize,
        channel: usize,
        processed_frames: usize,
        chunk_len: usize,
        ir_len: usize,
        inv_n: f64,
    ) {
        for i in 0..chunk_len {
            output[(processed_frames + i) * channels + channel] = scratch[i + ir_len - 1] * inv_n;
        }
    }

    /// Forward real FFT, spectral multiply, inverse real FFT, all in place over
    /// the preallocated `scratch_real` / `scratch_spectrum` pair.
    ///
    /// The buffer lengths are fixed at construction to exactly what the plans
    /// require, so `realfft`'s length checks cannot fail; a violated invariant
    /// would be a bug in this module rather than a runtime condition, and the
    /// callback has no way to recover from it. Debug builds assert the
    /// invariant; release builds leave the block untransformed rather than
    /// panicking on the audio thread.
    #[inline]
    fn process_channel_chunk_fft(&mut self, channel: usize) {
        debug_assert_eq!(self.scratch_real.len(), self.fft_size);
        debug_assert_eq!(self.scratch_spectrum.len(), self.fft_forward.complex_len());

        if self
            .fft_forward
            .process_with_scratch(
                &mut self.scratch_real,
                &mut self.scratch_spectrum,
                &mut self.fft_scratch,
            )
            .is_err()
        {
            return;
        }

        let ir_fft = &self.impulse_response_fft[channel];
        multiply_spectrum_in_place(&mut self.scratch_spectrum, ir_fft);

        let _ = self.fft_inverse.process_with_scratch(
            &mut self.scratch_spectrum,
            &mut self.scratch_real,
            &mut self.fft_scratch,
        );
    }

    #[inline]
    fn process_into(&mut self, input: &[f64], output: &mut [f64]) {
        debug_assert_eq!(input.len(), output.len());

        let channels = self.channels;
        let total_frames = input.len() / channels;
        let fft_size = self.fft_size;
        let ir_len = self.ir_len;
        let step_size = fft_size - ir_len + 1;
        let inv_n = 1.0 / fft_size as f64;

        // `total_frames` intentionally ignores an incomplete trailing frame.
        // Keep that remainder deterministic without clearing the whole buffer.
        output[total_frames * channels..].fill(0.0);

        for ch in 0..channels {
            let mut processed_frames = 0;

            while processed_frames < total_frames {
                let chunk_len = std::cmp::min(step_size, total_frames - processed_frames);

                Self::prepare_channel_chunk(
                    &mut self.scratch_real,
                    &self.overlap_buffers[ch],
                    input,
                    channels,
                    ch,
                    processed_frames,
                    chunk_len,
                    ir_len,
                );
                self.process_channel_chunk_fft(ch);
                Self::write_channel_output(
                    &self.scratch_real,
                    output,
                    channels,
                    ch,
                    processed_frames,
                    chunk_len,
                    ir_len,
                    inv_n,
                );

                Self::update_channel_overlap(
                    &mut self.overlap_buffers[ch],
                    input,
                    channels,
                    ch,
                    processed_frames,
                    chunk_len,
                    ir_len,
                );

                processed_frames += chunk_len;
            }
        }
    }

    #[inline]
    fn process_inplace(&mut self, buf: &mut [f64]) {
        // Each channel is convolved and written back in one pass. The overlap
        // history must be captured from the original input before any sample
        // is overwritten by the convolved output.

        let channels = self.channels;
        let total_frames = buf.len() / channels;
        let fft_size = self.fft_size;
        let ir_len = self.ir_len;
        let step_size = fft_size - ir_len + 1;
        let inv_n = 1.0 / fft_size as f64;

        for ch in 0..channels {
            let mut processed_frames = 0;

            while processed_frames < total_frames {
                let chunk_len = std::cmp::min(step_size, total_frames - processed_frames);

                Self::prepare_channel_chunk(
                    &mut self.scratch_real,
                    &self.overlap_buffers[ch],
                    buf,
                    channels,
                    ch,
                    processed_frames,
                    chunk_len,
                    ir_len,
                );
                self.process_channel_chunk_fft(ch);

                // Save the original input for the overlap BEFORE writing
                // output: the next chunk needs the input history, not the
                // convolved result.
                Self::update_channel_overlap(
                    &mut self.overlap_buffers[ch],
                    buf,
                    channels,
                    ch,
                    processed_frames,
                    chunk_len,
                    ir_len,
                );

                Self::write_channel_output(
                    &self.scratch_real,
                    buf,
                    channels,
                    ch,
                    processed_frames,
                    chunk_len,
                    ir_len,
                    inv_n,
                );

                processed_frames += chunk_len;
            }
        }
    }

    #[inline]
    fn process_inplace_with_wet_transition(
        &mut self,
        buf: &mut [f64],
        start_frame: usize,
        total_frames: usize,
        start_wet: f64,
        target_wet: f64,
    ) {
        let channels = self.channels;
        let total = buf.len() / channels;
        let fft_size = self.fft_size;
        let ir_len = self.ir_len;
        let step_size = fft_size - ir_len + 1;
        let inv_n = 1.0 / fft_size as f64;

        for ch in 0..channels {
            let mut processed_frames = 0;
            while processed_frames < total {
                let chunk_len = std::cmp::min(step_size, total - processed_frames);
                Self::prepare_channel_chunk(
                    &mut self.scratch_real,
                    &self.overlap_buffers[ch],
                    buf,
                    channels,
                    ch,
                    processed_frames,
                    chunk_len,
                    ir_len,
                );
                self.process_channel_chunk_fft(ch);
                // The overlap must see the original input, before any sample
                // is replaced by the mixed output.
                Self::update_channel_overlap(
                    &mut self.overlap_buffers[ch],
                    buf,
                    channels,
                    ch,
                    processed_frames,
                    chunk_len,
                    ir_len,
                );
                for i in 0..chunk_len {
                    let frame = start_frame.saturating_add(processed_frames + i);
                    let wet = transition_weight(frame, total_frames, start_wet, target_wet);
                    let index = (processed_frames + i) * channels + ch;
                    let dry = buf[index];
                    let filtered = self.scratch_real[i + ir_len - 1] * inv_n;
                    buf[index] = dry.mul_add(1.0 - wet, filtered * wet);
                }
                processed_frames += chunk_len;
            }
        }
    }
}

#[derive(Clone)]
struct PartitionedConvolver {
    channels: usize,
    ir_len: usize,
    partition_size: usize,
    fft_size: usize,
    tail_partitions: usize,
    head: OverlapSaveConvolver,
    channel_states: Vec<PartitionedChannelState>,
    fft_forward: Arc<dyn RealToComplex<f64>>,
    fft_inverse: Arc<dyn ComplexToReal<f64>>,
    scratch_real: Vec<f64>,
    scratch_spectrum: Vec<Complex<f64>>,
    // Workspace for real FFT processing; plain `process` allocates per call.
    fft_scratch: Vec<Complex<f64>>,
    block_pos: usize,
    history_cursor: usize,
    inv_fft_size: f64,
    inplace_scratch: Vec<f64>,
    // Time-distributed tail accumulation: partitions 1..tail_partitions for the
    // upcoming boundary are accumulated incrementally while the current input
    // block fills, so the boundary callback only carries the newest-partition
    // pass plus the two FFTs. One quantum = one partition on one channel.
    spread_quanta_done: usize,
    spread_quanta_total: usize,
    // Bresenham accumulator: add `spread_quanta_total` per frame and emit a
    // quantum whenever the accumulated error reaches `partition_size`.
    spread_schedule_error: usize,
    // Direct cursors preserve partition-major quantum order without divisions
    // or modulo in `run_spread_quantum`.
    spread_channel: usize,
    spread_partition: usize,
    spread_history_slot: usize,
}

#[derive(Clone)]
struct PartitionedChannelState {
    tail_ir_ffts: Vec<Complex<f64>>,
    input_history_ffts: Vec<Complex<f64>>,
    input_block: Vec<f64>,
    tail_output_block: Vec<f64>,
    tail_overlap: Vec<f64>,
    // Persistent spectral accumulator fed by the spread quanta between
    // partition boundaries and consumed by the boundary inverse FFT.
    tail_accum_spectrum: Vec<Complex<f64>>,
}

impl PartitionedConvolver {
    fn new(ir_data: &[f64], channels: usize) -> Result<Self, ProcessError> {
        let ir_len = ir_data.len() / channels;
        let partition_size = PARTITIONED_CONVOLUTION_PARTITION_SIZE;
        let fft_size = partition_size * 2;
        let tail_partitions = ir_len
            .saturating_sub(partition_size)
            .div_ceil(partition_size);

        let mut planner = RealFftPlanner::<f64>::new();
        let fft_forward = planner.plan_fft_forward(fft_size);
        let fft_inverse = planner.plan_fft_inverse(fft_size);
        let spectrum_size = fft_forward.complex_len();

        let head_ir = interleaved_ir_head(ir_data, channels, partition_size);
        let head = OverlapSaveConvolver::new(&head_ir, channels);
        let mut channel_states = Vec::with_capacity(channels);

        for channel in 0..channels {
            let mut tail_ir_ffts = vec![Complex::new(0.0, 0.0); tail_partitions * spectrum_size];

            for partition in 0..tail_partitions {
                let start_frame = partition_size * (partition + 1);
                let frames = ir_len.saturating_sub(start_frame).min(partition_size);
                let mut input = vec![0.0; fft_size];
                let spectrum_start = partition * spectrum_size;
                let spectrum_end = spectrum_start + spectrum_size;

                for frame in 0..frames {
                    input[frame] = ir_data[(start_frame + frame) * channels + channel];
                }

                fft_forward
                    .process(&mut input, &mut tail_ir_ffts[spectrum_start..spectrum_end])
                    .map_err(|_| ProcessError::Backend {
                        processor: "FFTConvolver",
                        operation: "construct partition spectra",
                        message: "real FFT buffer invariant failed",
                    })?;
            }

            channel_states.push(PartitionedChannelState {
                tail_ir_ffts,
                input_history_ffts: vec![Complex::new(0.0, 0.0); tail_partitions * spectrum_size],
                input_block: vec![0.0; partition_size],
                tail_output_block: vec![0.0; partition_size],
                tail_overlap: vec![0.0; partition_size],
                tail_accum_spectrum: vec![Complex::new(0.0, 0.0); spectrum_size],
            });
        }

        // The very first boundary consumes an all-zero accumulator over all-zero
        // history, so it starts "complete"; every later period must earn its
        // quanta before the next boundary.
        let spread_quanta_total = tail_partitions.saturating_sub(1) * channels;

        Ok(Self {
            channels,
            ir_len,
            partition_size,
            fft_size,
            tail_partitions,
            head,
            channel_states,
            scratch_real: vec![0.0; fft_size],
            scratch_spectrum: vec![Complex::new(0.0, 0.0); spectrum_size],
            fft_scratch: vec![
                Complex::new(0.0, 0.0);
                fft_forward
                    .get_scratch_len()
                    .max(fft_inverse.get_scratch_len())
            ],
            fft_forward,
            fft_inverse,
            block_pos: 0,
            history_cursor: 0,
            inv_fft_size: 1.0 / fft_size as f64,
            inplace_scratch: vec![0.0; partition_size * channels],
            spread_quanta_done: spread_quanta_total,
            spread_quanta_total,
            spread_schedule_error: 0,
            spread_channel: 0,
            spread_partition: 1,
            spread_history_slot: tail_partitions.saturating_sub(1),
        })
    }

    fn ir_length(&self) -> usize {
        self.ir_len
    }

    fn fft_size(&self) -> usize {
        self.fft_size
    }

    fn partition_size(&self) -> usize {
        self.partition_size
    }

    fn reset(&mut self) {
        self.head.reset();
        self.block_pos = 0;
        self.history_cursor = 0;
        self.scratch_real.fill(0.0);
        self.scratch_spectrum.fill(Complex::new(0.0, 0.0));
        self.spread_quanta_done = self.spread_quanta_total;
        self.spread_schedule_error = 0;
        self.spread_channel = 0;
        self.spread_partition = 1;
        self.spread_history_slot = self.tail_partitions.saturating_sub(1);

        for state in &mut self.channel_states {
            state.input_history_ffts.fill(Complex::new(0.0, 0.0));
            state.input_block.fill(0.0);
            state.tail_output_block.fill(0.0);
            state.tail_overlap.fill(0.0);
            state.tail_accum_spectrum.fill(Complex::new(0.0, 0.0));
        }
    }

    #[inline]
    fn process_into(&mut self, input: &[f64], output: &mut [f64]) -> Result<(), ProcessError> {
        debug_assert_eq!(input.len(), output.len());

        self.head.process_into(input, output);
        self.add_partitioned_tail(input, output)
    }

    #[inline]
    fn process_inplace(&mut self, buf: &mut [f64]) -> Result<(), ProcessError> {
        let total_frames = buf.len() / self.channels;
        let mut processed_frames = 0;

        while processed_frames < total_frames {
            let chunk_frames = (total_frames - processed_frames).min(self.partition_size);
            let chunk_samples = chunk_frames * self.channels;
            let start = processed_frames * self.channels;
            let end = start + chunk_samples;

            self.inplace_scratch[..chunk_samples].copy_from_slice(&buf[start..end]);
            self.head
                .process_into(&self.inplace_scratch[..chunk_samples], &mut buf[start..end]);
            self.add_partitioned_tail_from_scratch(chunk_samples, &mut buf[start..end])?;

            processed_frames += chunk_frames;
        }
        Ok(())
    }

    #[inline]
    fn process_inplace_with_wet_transition(
        &mut self,
        buf: &mut [f64],
        start_frame: usize,
        total_frames: usize,
        start_wet: f64,
        target_wet: f64,
    ) -> Result<(), ProcessError> {
        let total_frames_in_block = buf.len() / self.channels;
        let mut processed_frames = 0;
        while processed_frames < total_frames_in_block {
            let chunk_frames = (total_frames_in_block - processed_frames).min(self.partition_size);
            let chunk_samples = chunk_frames * self.channels;
            let start = processed_frames * self.channels;
            let end = start + chunk_samples;
            self.inplace_scratch[..chunk_samples].copy_from_slice(&buf[start..end]);
            self.head
                .process_into(&self.inplace_scratch[..chunk_samples], &mut buf[start..end]);
            self.add_partitioned_tail_from_scratch(chunk_samples, &mut buf[start..end])?;
            for sample in 0..chunk_samples {
                let frame = start_frame.saturating_add(processed_frames + sample / self.channels);
                let wet = transition_weight(frame, total_frames, start_wet, target_wet);
                let dry = self.inplace_scratch[sample];
                buf[start + sample] = dry.mul_add(1.0 - wet, buf[start + sample] * wet);
            }
            processed_frames += chunk_frames;
        }
        Ok(())
    }

    #[inline]
    fn add_partitioned_tail(
        &mut self,
        input: &[f64],
        output: &mut [f64],
    ) -> Result<(), ProcessError> {
        let total_frames = input.len() / self.channels;

        for frame in 0..total_frames {
            if self.block_pos == 0 {
                self.prepare_tail_output_block()?;
            }

            let block_pos = self.block_pos;
            for channel in 0..self.channels {
                let sample_index = frame * self.channels + channel;
                let state = &mut self.channel_states[channel];
                output[sample_index] += state.tail_output_block[block_pos];
                state.input_block[block_pos] = input[sample_index];
            }

            self.pump_spread_quanta();
            self.advance_partition_block()?;
        }
        Ok(())
    }

    #[inline]
    fn add_partitioned_tail_from_scratch(
        &mut self,
        input_samples: usize,
        output: &mut [f64],
    ) -> Result<(), ProcessError> {
        let total_frames = input_samples / self.channels;

        for frame in 0..total_frames {
            if self.block_pos == 0 {
                self.prepare_tail_output_block()?;
            }

            let block_pos = self.block_pos;
            for channel in 0..self.channels {
                let sample_index = frame * self.channels + channel;
                let state = &mut self.channel_states[channel];
                output[sample_index] += state.tail_output_block[block_pos];
                state.input_block[block_pos] = self.inplace_scratch[sample_index];
            }

            self.pump_spread_quanta();
            self.advance_partition_block()?;
        }
        Ok(())
    }

    /// Advance the current period's spread quanta with a Bresenham schedule.
    /// This completes exactly at the partition boundary without a per-frame
    /// division and remains a deterministic function of in-period frame
    /// position, so callback chunking cannot change the quantum order.
    #[inline]
    fn pump_spread_quanta(&mut self) {
        let total = self.spread_quanta_total;
        if total == 0 {
            return;
        }
        self.spread_schedule_error += total;
        while self.spread_schedule_error >= self.partition_size && self.spread_quanta_done < total {
            self.spread_schedule_error -= self.partition_size;
            self.run_spread_quantum();
        }
    }

    #[inline]
    fn run_spread_quantum(&mut self) {
        let channel = self.spread_channel;
        // Partitions 1..tail_partitions read history committed at least one
        // full period ago; partition 0 is only available at the boundary.
        let partition = self.spread_partition;
        let spectrum_size = self.scratch_spectrum.len();
        let history_start = self.spread_history_slot * spectrum_size;
        let ir_start = partition * spectrum_size;

        let PartitionedChannelState {
            tail_ir_ffts,
            input_history_ffts,
            tail_accum_spectrum,
            ..
        } = &mut self.channel_states[channel];
        accumulate_spectrum_in_place(
            tail_accum_spectrum,
            &input_history_ffts[history_start..history_start + spectrum_size],
            &tail_ir_ffts[ir_start..ir_start + spectrum_size],
        );
        self.spread_quanta_done += 1;
        self.spread_channel += 1;
        if self.spread_channel == self.channels {
            self.spread_channel = 0;
            self.spread_partition += 1;
            self.spread_history_slot = if self.spread_history_slot == 0 {
                self.tail_partitions - 1
            } else {
                self.spread_history_slot - 1
            };
        }
    }

    #[inline]
    fn advance_partition_block(&mut self) -> Result<(), ProcessError> {
        self.block_pos += 1;
        if self.block_pos == self.partition_size {
            self.commit_input_block()?;
            self.block_pos = 0;
        }
        Ok(())
    }

    fn prepare_tail_output_block(&mut self) -> Result<(), ProcessError> {
        debug_assert_eq!(
            self.spread_quanta_done, self.spread_quanta_total,
            "spread schedule must complete before the partition boundary"
        );
        let tail_partitions = self.tail_partitions;
        let partition_size = self.partition_size;
        let inv_fft_size = self.inv_fft_size;
        let spectrum_size = self.scratch_spectrum.len();
        // The boundary commit already advanced the cursor, so the newest block
        // sits one slot behind it.
        let newest_slot = (self.history_cursor + tail_partitions - 1) % tail_partitions;

        let Self {
            channel_states,
            fft_inverse,
            scratch_real,
            fft_scratch,
            ..
        } = self;

        for state in channel_states.iter_mut() {
            {
                let PartitionedChannelState {
                    tail_ir_ffts,
                    input_history_ffts,
                    tail_accum_spectrum,
                    ..
                } = state;
                let history_start = newest_slot * spectrum_size;
                accumulate_spectrum_in_place(
                    tail_accum_spectrum,
                    &input_history_ffts[history_start..history_start + spectrum_size],
                    &tail_ir_ffts[..spectrum_size],
                );
            }

            // The inverse FFT consumes the accumulator; clear it afterwards so
            // the next period's spread quanta start from zero.
            fft_inverse
                .process_with_scratch(&mut state.tail_accum_spectrum, scratch_real, fft_scratch)
                .map_err(|_| ProcessError::Backend {
                    processor: "FFTConvolver",
                    operation: "inverse partition FFT",
                    message: "real FFT buffer invariant failed",
                })?;
            state.tail_accum_spectrum.fill(Complex::new(0.0, 0.0));

            for frame in 0..partition_size {
                state.tail_output_block[frame] =
                    scratch_real[frame] * inv_fft_size + state.tail_overlap[frame];
                state.tail_overlap[frame] = scratch_real[frame + partition_size] * inv_fft_size;
            }
        }

        self.spread_quanta_done = 0;
        self.spread_schedule_error = 0;
        self.spread_channel = 0;
        self.spread_partition = 1;
        self.spread_history_slot = if self.history_cursor == 0 {
            self.tail_partitions - 1
        } else {
            self.history_cursor - 1
        };
        Ok(())
    }

    fn commit_input_block(&mut self) -> Result<(), ProcessError> {
        let history_slot = self.history_cursor;
        let partition_size = self.partition_size;
        let spectrum_size = self.scratch_spectrum.len();

        for channel in 0..self.channels {
            self.scratch_real[..partition_size]
                .copy_from_slice(&self.channel_states[channel].input_block);
            self.scratch_real[partition_size..].fill(0.0);

            self.fft_forward
                .process_with_scratch(
                    &mut self.scratch_real,
                    &mut self.scratch_spectrum,
                    &mut self.fft_scratch,
                )
                .map_err(|_| ProcessError::Backend {
                    processor: "FFTConvolver",
                    operation: "forward partition FFT",
                    message: "real FFT buffer invariant failed",
                })?;

            let state = &mut self.channel_states[channel];
            let spectrum_start = history_slot * spectrum_size;
            state.input_history_ffts[spectrum_start..spectrum_start + spectrum_size]
                .copy_from_slice(&self.scratch_spectrum);
            state.input_block.fill(0.0);
        }

        self.history_cursor += 1;
        if self.history_cursor == self.tail_partitions {
            self.history_cursor = 0;
        }
        Ok(())
    }
}

#[inline]
fn transition_weight(frame: usize, total_frames: usize, start_wet: f64, target_wet: f64) -> f64 {
    if total_frames <= 1 {
        return target_wet;
    }
    let t = (frame.min(total_frames - 1) as f64) / (total_frames - 1) as f64;
    let smooth = t * t * (3.0 - 2.0 * t);
    start_wet + (target_wet - start_wet) * smooth
}

fn interleaved_ir_head(ir_data: &[f64], channels: usize, partition_size: usize) -> Vec<f64> {
    let ir_len = ir_data.len() / channels;
    let head_frames = ir_len.min(partition_size);
    let mut head = vec![0.0; partition_size * channels];

    for frame in 0..head_frames {
        let src_start = frame * channels;
        let dst_start = frame * channels;
        head[dst_start..dst_start + channels]
            .copy_from_slice(&ir_data[src_start..src_start + channels]);
    }

    head
}

#[inline]
fn multiply_spectrum_in_place(samples: &mut [Complex<f64>], ir_fft: &[Complex<f64>]) {
    for (sample, ir) in samples.iter_mut().zip(ir_fft) {
        let re = sample.re * ir.re - sample.im * ir.im;
        let im = sample.re * ir.im + sample.im * ir.re;
        sample.re = re;
        sample.im = im;
    }
}

#[inline]
fn accumulate_spectrum_in_place(
    accumulator: &mut [Complex<f64>],
    input_fft: &[Complex<f64>],
    ir_fft: &[Complex<f64>],
) {
    for ((acc, input), ir) in accumulator.iter_mut().zip(input_fft).zip(ir_fft) {
        let re = input.re * ir.re - input.im * ir.im;
        let im = input.re * ir.im + input.im * ir.re;
        acc.re += re;
        acc.im += im;
    }
}

#[cfg(test)]
mod tests;
