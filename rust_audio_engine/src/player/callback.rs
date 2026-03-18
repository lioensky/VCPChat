//! Audio callback implementation
//!
//! Contains the real-time audio processing callback and related utilities.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use parking_lot::Mutex;
use crossbeam::channel::Sender;

use super::state::{SharedState, PlayerState};
use crate::processor::{
    Equalizer, VolumeController, NoiseShaper,
    AtomicLoudnessState, PeakLimiter, StreamingResampler,
    Saturation, Crossfeed, FFTConvolver, DynamicLoudness,
};

/// Main audio callback for cpal output stream
///
/// This function is called by cpal when it needs more audio samples.
/// It handles:
/// - Gapless playback buffer swapping
/// - DSP processing chain (EQ → FIR_EQ → Convolver → Crossfeed → Loudness → DynamicLoudness → Saturation → Limiter → Volume)
/// - Resampling (if device sample rate differs)
/// - Noise shaping / dithering
/// - Spectrum data output
#[allow(clippy::too_many_arguments)]
pub fn audio_callback(
    data: &mut [f32],
    shared: &SharedState,
    eq: &Mutex<Equalizer>,
    volume: &Mutex<VolumeController>,
    noise_shaper: &Mutex<NoiseShaper>,
    loudness_state: &Arc<AtomicLoudnessState>,
    peak_limiter: &Mutex<PeakLimiter>,
    convolver: &Mutex<Option<FFTConvolver>>,
    fir_convolver: &Mutex<Option<FFTConvolver>>,
    saturation: &Mutex<Saturation>,
    crossfeed: &Mutex<Crossfeed>,
    dynamic_loudness: &Mutex<DynamicLoudness>,
    spectrum_tx: &Sender<f64>,
    channels: usize,
    process_buf: &mut Vec<f64>,
    resampler: &mut Option<StreamingResampler>,
    resample_leftover: &mut Vec<f64>,
    // FIX for RISK-08: Pre-allocated output buffer for process_chunk_into()
    // This avoids heap allocation per callback when resampling.
    resample_output: &mut Vec<f64>,
) {
    // FIX for Defect 25: Don't hold read lock for entire callback duration.
    // Only acquire lock when reading data, release immediately after.
    // This prevents blocking LoadComplete write operations.
    
    let total = shared.total_frames.load(Ordering::Relaxed) as usize;
    let mut current_pos = shared.position_frames.load(Ordering::Relaxed) as usize;

    // ── Gapless: Signal preload when remaining < 2s ──
    let sr = shared.sample_rate.load(Ordering::Relaxed) as usize;
    let remaining_frames = total.saturating_sub(current_pos);
    if remaining_frames > 0
        && remaining_frames < sr * 2  // Remaining < 2 seconds
        && !shared.pending_ready.load(Ordering::Relaxed)
        && !shared.needs_preload.load(Ordering::Acquire)
    {
        shared.needs_preload.store(true, Ordering::Release);
    }

    // ── EOF Detection (with Gapless buffer swap) ──
    if current_pos >= total && resample_leftover.is_empty() {
        // Check if pending buffer is ready for gapless swap
        if shared.pending_ready.load(Ordering::Acquire) {
            // Take pending buffer (move, no clone)
            let next_samples = shared.pending_buffer.write().take();

            if let Some(next) = next_samples {
                // Atomically swap all metadata
                let next_frames = shared.pending_total_frames.load(Ordering::Relaxed);
                let next_sr = shared.pending_sample_rate.load(Ordering::Relaxed);
                let next_ch = shared.pending_channels.load(Ordering::Relaxed);
                let next_path = shared.pending_file_path.write().take();
                let next_metadata = shared.pending_metadata.write().take();

                // Write new buffer (swap happens at sample boundary)
                *shared.audio_buffer.write() = next;
                shared.total_frames.store(next_frames, Ordering::Relaxed);
                shared.sample_rate.store(next_sr, Ordering::Relaxed);
                shared.channels.store(next_ch, Ordering::Relaxed);
                shared.position_frames.store(0, Ordering::Relaxed);
                *shared.file_path.write() = next_path.clone();
                
                // Update track metadata
                if let Some(meta) = next_metadata {
                    *shared.track_metadata.write() = meta;
                }
                *shared.current_track_path.write() = next_path;

                // Clear pending state
                shared.pending_ready.store(false, Ordering::Release);
                shared.needs_preload.store(false, Ordering::Relaxed);

                // Mark DSP needs reset (will be handled at next callback start)
                shared.dsp_reset_pending.store(true, Ordering::Release);

                // FIX for Defect 22: Apply pending target gain after buffer swap
                // This ensures the gain transition starts only after the track change,
                // not during the last seconds of the previous track.
                let pending_gain_bits = shared.pending_target_gain_db.load(Ordering::Relaxed);
                let pending_gain_db = f64::from_bits(pending_gain_bits);
                loudness_state.set_target_gain(pending_gain_db);

                log::info!("Gapless: switched to next track at sample boundary (gain: {:.2} dB)", pending_gain_db);

                // Fill remaining with silence for this callback
                data.fill(0.0);
                return;
            }
        }

        // No pending buffer: normal EOF, stop playback
        data.fill(0.0);
        if let Some(mut state) = shared.state.try_write() {
            if *state == PlayerState::Playing {
                *state = PlayerState::Stopped;
            }
        }
        return;
    }

    let mut samples_written = 0;
    let output_len = data.len();

    // 1. Drain leftovers from previous callback if any
    if resampler.is_some() && !resample_leftover.is_empty() {
        let take = resample_leftover.len().min(output_len);
        for i in 0..take {
            data[i] = resample_leftover[i] as f32;
        }
        resample_leftover.drain(0..take);
        samples_written = take;
    }

    // 2. Generate new samples
    while samples_written < output_len {
        // ── Gapless: Reset DSP state after buffer swap ──
        if shared.dsp_reset_pending.load(Ordering::Acquire) {
            if let Some(mut locked_eq) = eq.try_lock() {
                locked_eq.reset();
            }
            if let Some(mut locked_ns) = noise_shaper.try_lock() {
                locked_ns.reset();
            }
            if let Some(mut guard) = convolver.try_lock() {
                if let Some(ref mut conv) = *guard {
                    conv.reset();
                }
            }
            // Reset FIR EQ convolver
            if let Some(mut guard) = fir_convolver.try_lock() {
                if let Some(ref mut fir_conv) = *guard {
                    fir_conv.reset();
                }
            }
            if let Some(mut locked_cf) = crossfeed.try_lock() {
                locked_cf.reset();
            }
            // Reset saturation HPF state to avoid transient coloring
            if let Some(mut locked_sat) = saturation.try_lock() {
                locked_sat.reset();
            }
            // Reset peak limiter delay buffer and gain reduction
            if let Some(mut locked_limiter) = peak_limiter.try_lock() {
                locked_limiter.reset();
            }
            // Reset Dynamic Loudness filter states
            if let Some(mut locked_dl) = dynamic_loudness.try_lock() {
                locked_dl.reset();
            }
            // CRITICAL FIX (Defect 21): Clear resampler after gapless switch
            // Pending buffer is already at device sample rate (resampled during preload),
            // so no resampling is needed. Keeping old resampler would cause severe speed change.
            *resampler = None;
            resample_leftover.clear();
            shared.dsp_reset_pending.store(false, Ordering::Release);
            log::debug!("Gapless: DSP state reset after track switch (resampler cleared)");
        }

        let frames_needed_out = (output_len - samples_written) / channels;
        if frames_needed_out == 0 { break; }

        let mut source_frames_needed = frames_needed_out;

        // Adjust for resampling ratio
        if resampler.is_some() {
            source_frames_needed = 4096;
        }

        // Clamp to available source frames
        let available_source = total.saturating_sub(current_pos);
        if available_source == 0 {
            break;
        }

        let frames_to_read = source_frames_needed.min(available_source).min(4096);
        let start_sample = current_pos * channels;
        let end_sample = start_sample + frames_to_read * channels;

        // Read from source buffer - FIX for Defect 25: Hold lock only during read
        process_buf.clear();
        {
            let buf = shared.audio_buffer.read();
            if end_sample <= buf.len() {
                process_buf.extend_from_slice(&buf[start_sample..end_sample]);
            }
            // Lock released here when buf goes out of scope
        }
        
        // Skip if no data (boundary condition fix - prevents silent chunks)
        if process_buf.is_empty() {
            continue;
        }

        // Advance source position
        current_pos += frames_to_read;
        shared.position_frames.store(current_pos as u64, Ordering::Relaxed);

        // ===== DSP Chain =====
        // Note on Defect 23 fix: We use try_lock for real-time safety.
        // If a lock can't be acquired, the processor is skipped for this callback.
        // This is intentional - blocking in audio callback would cause glitches.
        // The processor's internal state is preserved for the next callback.
        // To minimize lock contention, main thread should hold locks for minimal time.
        
        // 1. IIR EQ (at source sample rate)
        if let Some(mut locked_eq) = eq.try_lock() {
            locked_eq.process(process_buf);
        }
        // If EQ lock fails: frequency response unchanged for this chunk (acceptable)

        // 2. FIR EQ Convolution (linear phase EQ, runs after IIR EQ)
        if let Some(mut guard) = fir_convolver.try_lock() {
            if let Some(ref mut fir_conv) = *guard {
                fir_conv.process_inplace(process_buf);
            }
        }

        // 3. User IR Convolution (room simulation, cabinet IR, etc.)
        if let Some(mut guard) = convolver.try_lock() {
            if let Some(ref mut conv) = *guard {
                conv.process_inplace(process_buf);
            }
        }

        // 4. Crossfeed (headphone virtual speaker, stereo only)
        if let Some(mut locked_cf) = crossfeed.try_lock() {
            locked_cf.process(process_buf, channels);
        }

        // 5. Loudness normalization (lock-free atomic state)
        let frames_in_chunk = process_buf.len() / channels;
        let linear_gain = loudness_state.process_gain(frames_in_chunk);
        for sample in process_buf.iter_mut() {
            *sample *= linear_gain;
        }

        // 6. Dynamic Loudness Compensation (ISO 226 Fletcher-Munson)
        // Compensates for ear's reduced sensitivity at low frequencies/high frequencies
        // when listening at low volumes
        if let Some(mut locked_dl) = dynamic_loudness.try_lock() {
            // FIX: Pass current volume to processor before processing
            let vol = shared.volume.load(Ordering::Relaxed) as f64 / 1_000_000.0;
            locked_dl.set_volume(vol);
            locked_dl.process(process_buf);
        }

        // 7. Saturation (analog warmth, optional)
        if let Some(mut locked_sat) = saturation.try_lock() {
            locked_sat.process_with_channels(process_buf, channels);
        }

        // 8. Peak limiting
        if let Some(mut locked_limiter) = peak_limiter.try_lock() {
            locked_limiter.process(process_buf);
        }

        // 9. Volume control - FIX for Defect 23: Use atomic volume from SharedState
        // No lock needed, always applies volume even when other processors are locked
        let vol_atomic = shared.volume.load(Ordering::Relaxed) as f64 / 1_000_000.0;
        let vol = vol_atomic.clamp(0.0, 1.0);
        for sample in process_buf.iter_mut() {
            *sample *= vol;
        }

        // Get NoiseShaper lock for dithering
        let mut locked_ns = noise_shaper.try_lock();

        // Helper to write sample with dither
        let mut write_sample = |data: &mut [f32], pos: usize, val: f64, ch: usize| {
            let final_val = if let Some(ref mut ns) = locked_ns {
                ns.process_sample(val, ch)
            } else {
                val
            };
            data[pos] = final_val as f32;
        };

        // 8. Resample or pass-through
        if let Some(rs) = resampler {
            // FIX for RISK-08: Use process_chunk_into() with pre-allocated buffer
            // to avoid heap allocation per callback
            resample_output.clear();
            resample_output.resize(process_buf.len() * 2 + 256, 0.0); // Extra room for resampling ratio
            
            let frames_written = rs.process_chunk_into(process_buf, resample_output);
            let samples_resampled = frames_written * channels;
            
            let mut chunk_idx = 0;
            while samples_written < output_len && chunk_idx < samples_resampled {
                let ch = samples_written % channels;
                write_sample(data, samples_written, resample_output[chunk_idx], ch);
                samples_written += 1;
                chunk_idx += 1;
            }

            // Store overflow
            if chunk_idx < samples_resampled {
                resample_leftover.extend_from_slice(&resample_output[chunk_idx..samples_resampled]);
            }
        } else {
            // No resampling - direct copy with dither
            let take = process_buf.len().min(output_len - samples_written);
            for i in 0..take {
                let ch = (samples_written + i) % channels;
                write_sample(data, samples_written + i, process_buf[i], ch);
            }
            samples_written += take;
        }
    }

    // Fill remaining with silence if EOF
    if samples_written < output_len {
        for i in samples_written..output_len {
            data[i] = 0.0;
        }
    }

    // Spectrum analysis output
    if samples_written > 0 {
        let frames_sent = samples_written / channels;
        if frames_sent > 0 {
            let take = samples_written.min(1024);
            for i in (0..take).step_by(channels) {
                let mut sum = 0.0;
                for c in 0..channels {
                    if i+c < data.len() { sum += data[i+c] as f64; }
                }
                let _ = spectrum_tx.try_send(sum / channels as f64);
            }
        }
    }
}

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
