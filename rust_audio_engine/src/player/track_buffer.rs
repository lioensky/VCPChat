//! Progressive (grow-while-playing) track buffer.
//!
//! A decode thread appends interleaved f64 samples while the audio callback
//! reads from any already-published position. Storage is a fixed array of
//! chunk slots allocated up front; each slot is written exactly once
//! (`OnceLock`) and then published by bumping `ready_frames` with `Release`
//! ordering. Readers only perform atomic loads and memcpy, so the callback can
//! read while decoding continues without locks or allocation.
//!
//! The whole track stays resident, which keeps random-access seeking,
//! gapless swaps and the resample cache working unchanged. Samples are
//! stored as f32 and widened to f64 on read: that halves the resident size
//! (a 5-minute 96 kHz stereo track is ~230 MB instead of ~460 MB, and the
//! gapless preload holds a second one). f32 represents every 16- and 24-bit
//! source sample exactly, and its rounding of resampled output (~-150 dBFS)
//! is far below any DAC's noise floor; all DSP still runs in f64.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

/// Frames per chunk. 16384 frames is ~0.37 s at 44.1 kHz.
pub const CHUNK_FRAMES: usize = 16_384;

/// Slot budget when the container does not report a frame count
/// (~6.8 h at 44.1 kHz, ~1.5 h at 192 kHz).
const UNKNOWN_LENGTH_SLOTS: usize = 16_384;

/// Extra slots on top of the container estimate; estimates for VBR streams
/// can be short.
const ESTIMATE_HEADROOM_SLOTS: usize = 64;

pub struct TrackBuffer {
    channels: usize,
    slots: Box<[OnceLock<Box<[f32]>>]>,
    ready_frames: AtomicU64,
    complete: AtomicBool,
    estimated_frames: u64,
}

impl std::fmt::Debug for TrackBuffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrackBuffer")
            .field("channels", &self.channels)
            .field("ready_frames", &self.ready_frames())
            .field("complete", &self.is_complete())
            .finish()
    }
}

impl TrackBuffer {
    /// An empty, complete buffer (initial state before any track is loaded).
    pub fn empty() -> Self {
        let buffer = Self::with_slots(2, 0, 0);
        buffer.complete.store(true, Ordering::Release);
        buffer
    }

    /// Create a buffer and its single writer.
    pub fn new(channels: usize, estimated_frames: Option<u64>) -> (Arc<Self>, TrackBufferWriter) {
        let channels = channels.max(1);
        let slots = match estimated_frames {
            Some(frames) if frames > 0 => {
                let with_margin = frames.saturating_add(frames / 4) as usize;
                with_margin.div_ceil(CHUNK_FRAMES) + ESTIMATE_HEADROOM_SLOTS
            }
            _ => UNKNOWN_LENGTH_SLOTS,
        };
        let buffer = Arc::new(Self::with_slots(channels, slots, estimated_frames.unwrap_or(0)));
        let writer = TrackBufferWriter {
            buffer: Arc::clone(&buffer),
            staging: Vec::with_capacity(CHUNK_FRAMES * channels),
            next_slot: 0,
            written_frames: 0,
        };
        (buffer, writer)
    }

    /// Build a complete buffer from fully decoded samples (cache hits, tests).
    pub fn from_samples(samples: Vec<f64>, channels: usize) -> Arc<Self> {
        let channels = channels.max(1);
        let frames = (samples.len() / channels) as u64;
        let (buffer, mut writer) = Self::new(channels, Some(frames));
        // Overflow is impossible: the slot count was sized from this length.
        let _ = writer.push(&samples);
        drop(samples);
        writer.finish();
        buffer
    }

    fn with_slots(channels: usize, slots: usize, estimated_frames: u64) -> Self {
        Self {
            channels,
            slots: (0..slots).map(|_| OnceLock::new()).collect(),
            ready_frames: AtomicU64::new(0),
            complete: AtomicBool::new(false),
            estimated_frames,
        }
    }

    #[inline]
    pub fn channels(&self) -> usize {
        self.channels
    }

    /// Frames that can be read right now.
    #[inline]
    pub fn ready_frames(&self) -> u64 {
        self.ready_frames.load(Ordering::Acquire)
    }

    /// True once the writer has published the last frame (or gave up).
    #[inline]
    pub fn is_complete(&self) -> bool {
        self.complete.load(Ordering::Acquire)
    }

    /// Container-reported length; 0 when unknown.
    #[inline]
    pub fn estimated_frames(&self) -> u64 {
        self.estimated_frames
    }

    /// Best current length: exact once complete, otherwise the larger of the
    /// estimate and what is already decoded.
    pub fn duration_frames(&self) -> u64 {
        let ready = self.ready_frames();
        if self.is_complete() {
            ready
        } else {
            ready.max(self.estimated_frames)
        }
    }

    /// Append frames `[start_frame, start_frame + frames)` to `out` with
    /// `extend_from_slice`. Returns the number of frames appended, which is
    /// smaller than requested when the range is not decoded yet. Does not
    /// allocate when `out` has capacity for the requested samples.
    pub fn extend_into(&self, start_frame: usize, frames: usize, out: &mut Vec<f64>) -> usize {
        let ready = self.ready_frames() as usize;
        if start_frame >= ready {
            return 0;
        }
        let end_frame = (start_frame + frames).min(ready);
        let mut frame = start_frame;
        while frame < end_frame {
            let slot_index = frame / CHUNK_FRAMES;
            let Some(chunk) = self.slots.get(slot_index).and_then(OnceLock::get) else {
                break;
            };
            let offset = frame - slot_index * CHUNK_FRAMES;
            let take = (CHUNK_FRAMES - offset).min(end_frame - frame);
            let start = offset * self.channels;
            let end = start + take * self.channels;
            if end > chunk.len() {
                break;
            }
            out.extend(chunk[start..end].iter().map(|&sample| f64::from(sample)));
            frame += take;
        }
        frame - start_frame
    }

    /// Visit every published chunk in order (non-realtime: cache writes,
    /// loudness analysis, tests).
    pub fn for_each_chunk(&self, mut visit: impl FnMut(&[f64])) {
        let ready = self.ready_frames() as usize;
        let mut frame = 0usize;
        let mut wide = Vec::with_capacity(CHUNK_FRAMES * self.channels);
        for slot in self.slots.iter() {
            if frame >= ready {
                break;
            }
            let Some(chunk) = slot.get() else { break };
            let frames = (chunk.len() / self.channels).min(ready - frame);
            wide.clear();
            wide.extend(chunk[..frames * self.channels].iter().map(|&sample| f64::from(sample)));
            visit(&wide);
            frame += frames;
        }
    }

    /// Bytes held by published samples (for logs and tests).
    pub fn resident_bytes(&self) -> usize {
        self.slots.iter().filter_map(OnceLock::get).map(|chunk| chunk.len() * std::mem::size_of::<f32>()).sum()
    }

    /// Copy the published samples into one contiguous vector (tests only).
    #[cfg(test)]
    pub fn to_vec(&self) -> Vec<f64> {
        let mut out = Vec::new();
        self.for_each_chunk(|chunk| out.extend_from_slice(chunk));
        out
    }
}

/// The single producer for a [`TrackBuffer`].
pub struct TrackBufferWriter {
    buffer: Arc<TrackBuffer>,
    staging: Vec<f32>,
    next_slot: usize,
    written_frames: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrackBufferFull;

impl std::fmt::Display for TrackBufferFull {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("track is longer than the streaming buffer can hold")
    }
}

impl TrackBufferWriter {
    pub fn buffer(&self) -> &Arc<TrackBuffer> {
        &self.buffer
    }

    /// Frames handed to `push` so far (published or still staged).
    pub fn written_frames(&self) -> u64 {
        self.written_frames
    }

    /// Append interleaved samples. Whole chunks are published immediately.
    pub fn push(&mut self, mut samples: &[f64]) -> Result<(), TrackBufferFull> {
        let channels = self.buffer.channels;
        // Never split a frame across pushes.
        samples = &samples[..samples.len() - samples.len() % channels];
        self.written_frames += (samples.len() / channels) as u64;
        let chunk_samples = CHUNK_FRAMES * channels;
        while !samples.is_empty() {
            let room = chunk_samples - self.staging.len();
            let take = room.min(samples.len());
            self.staging.extend(samples[..take].iter().map(|&sample| sample as f32));
            samples = &samples[take..];
            if self.staging.len() == chunk_samples {
                self.publish_staging()?;
            }
        }
        Ok(())
    }

    /// Publish the staged samples as the next chunk. Readers index chunks by
    /// `frame / CHUNK_FRAMES`, so a partial chunk may only be the last one.
    fn publish_staging(&mut self) -> Result<(), TrackBufferFull> {
        if self.staging.is_empty() {
            return Ok(());
        }
        let channels = self.buffer.channels;
        let slot = self.buffer.slots.get(self.next_slot).ok_or(TrackBufferFull)?;
        let frames = (self.staging.len() / channels) as u64;
        let chunk_samples = CHUNK_FRAMES * channels;
        let chunk = std::mem::replace(&mut self.staging, Vec::with_capacity(chunk_samples));
        let _ = slot.set(chunk.into_boxed_slice());
        self.next_slot += 1;
        self.buffer.ready_frames.fetch_add(frames, Ordering::AcqRel);
        Ok(())
    }

    /// Publish the tail and mark the buffer complete. Returns the total frame count.
    pub fn finish(mut self) -> u64 {
        if self.publish_staging().is_err() {
            log::warn!("Track buffer full; dropping the last {} staged samples", self.staging.len());
        }
        self.mark_complete()
    }

    fn mark_complete(&mut self) -> u64 {
        self.buffer.complete.store(true, Ordering::Release);
        self.buffer.ready_frames()
    }
}

impl Drop for TrackBufferWriter {
    /// A writer that goes away early (cancelled load, decode error) still
    /// completes the buffer, so the player ends the track instead of
    /// waiting forever in the buffering state.
    fn drop(&mut self) {
        if !self.buffer.is_complete() {
            if !self.staging.is_empty() {
                let _ = self.publish_staging();
            }
            self.mark_complete();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp(frames: usize, channels: usize) -> Vec<f64> {
        (0..frames * channels).map(|i| i as f64).collect()
    }

    #[test]
    fn stores_four_bytes_per_sample_and_keeps_24_bit_samples_exact() {
        let frames = CHUNK_FRAMES * 3;
        // Every 24-bit PCM value, scaled the way the decoder does, survives the f32 store.
        let samples: Vec<f64> = (0..frames * 2)
            .map(|i| ((i as i64 * 7919) % (1 << 23) - (1 << 22)) as f64 / (1u32 << 23) as f64)
            .collect();
        let buffer = TrackBuffer::from_samples(samples.clone(), 2);
        assert_eq!(buffer.resident_bytes(), frames * 2 * 4);
        let mut out = Vec::with_capacity(frames * 2);
        assert_eq!(buffer.extend_into(0, frames, &mut out), frames);
        assert_eq!(out, samples);
        assert_eq!(buffer.to_vec(), samples);
    }

    #[test]
    fn reads_only_published_frames() {
        let (buffer, mut writer) = TrackBuffer::new(2, Some(100_000));
        writer.push(&ramp(CHUNK_FRAMES - 1, 2)).unwrap();
        assert_eq!(buffer.ready_frames(), 0, "partial chunk is staged, not published");

        writer.push(&[0.0, 0.0]).unwrap();
        assert_eq!(buffer.ready_frames(), CHUNK_FRAMES as u64);
        assert!(!buffer.is_complete());

        let mut out = Vec::with_capacity(64);
        assert_eq!(buffer.extend_into(CHUNK_FRAMES - 4, 32, &mut out), 4);
        assert_eq!(out.len(), 8);
        assert_eq!(buffer.extend_into(CHUNK_FRAMES, 32, &mut out), 0);
    }

    #[test]
    fn reads_across_chunk_boundaries_and_finishes_with_tail() {
        let frames = CHUNK_FRAMES * 2 + 123;
        let source = ramp(frames, 2);
        let (buffer, mut writer) = TrackBuffer::new(2, None);
        for piece in source.chunks(1000) {
            writer.push(piece).unwrap();
        }
        assert_eq!(writer.finish(), frames as u64);
        assert!(buffer.is_complete());
        assert_eq!(buffer.duration_frames(), frames as u64);

        let start = CHUNK_FRAMES - 10;
        let mut out = Vec::new();
        assert_eq!(buffer.extend_into(start, CHUNK_FRAMES + 50, &mut out), CHUNK_FRAMES + 50);
        assert_eq!(out, source[start * 2..(start + CHUNK_FRAMES + 50) * 2]);
        assert_eq!(buffer.to_vec(), source);
    }

    #[test]
    fn dropped_writer_completes_buffer() {
        let (buffer, mut writer) = TrackBuffer::new(1, Some(10));
        writer.push(&[1.0, 2.0, 3.0]).unwrap();
        drop(writer);
        assert!(buffer.is_complete());
        assert_eq!(buffer.ready_frames(), 3);
    }

    #[test]
    fn concurrent_reader_sees_consistent_prefix() {
        let frames = CHUNK_FRAMES * 8 + 7;
        let (buffer, mut writer) = TrackBuffer::new(2, Some(frames as u64));
        let reader = {
            let buffer = Arc::clone(&buffer);
            std::thread::spawn(move || {
                let mut out = Vec::with_capacity(4096 * 2);
                let mut pos = 0usize;
                while !(buffer.is_complete() && pos as u64 >= buffer.ready_frames()) {
                    out.clear();
                    let got = buffer.extend_into(pos, 4096, &mut out);
                    for (i, sample) in out.iter().enumerate() {
                        assert_eq!(*sample, (pos * 2 + i) as f64);
                    }
                    pos += got;
                    if got == 0 {
                        std::thread::yield_now();
                    }
                }
                pos
            })
        };
        let source = ramp(frames, 2);
        for piece in source.chunks(777 * 2) {
            writer.push(piece).unwrap();
        }
        writer.finish();
        assert_eq!(reader.join().unwrap(), frames);
    }

    #[test]
    fn from_samples_is_complete() {
        let source = ramp(5000, 2);
        let buffer = TrackBuffer::from_samples(source.clone(), 2);
        assert!(buffer.is_complete());
        assert_eq!(buffer.to_vec(), source);
    }
}
