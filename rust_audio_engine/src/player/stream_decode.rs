//! Decode → (resample) → (channel-normalize) → TrackBuffer pump shared by the
//! main load path and the gapless preload path.

use crate::decoder::StreamingDecoder;
use crate::processor::{LoudnessMeter, StreamingResampler};

use super::callback::normalize_channels;
use super::track_buffer::TrackBufferWriter;

pub enum PumpOutcome {
    /// Reached end of stream; the writer still needs `finish()`.
    Finished,
    /// `should_stop` returned true.
    Cancelled,
}

pub struct Pump<'a> {
    pub decoder: &'a mut StreamingDecoder,
    pub resampler: Option<StreamingResampler>,
    pub source_channels: usize,
    pub output_channels: usize,
    /// Integrated-loudness meter fed with output samples, when the caller
    /// needs an EBU R128 measurement of the whole track.
    pub meter: Option<LoudnessMeter>,
}

impl Pump<'_> {
    fn emit(
        &mut self,
        samples: Vec<f64>,
        writer: &mut TrackBufferWriter,
    ) -> Result<(), String> {
        let samples = if self.source_channels != self.output_channels {
            normalize_channels(samples, self.source_channels, self.output_channels)
        } else {
            samples
        };
        if let Some(meter) = self.meter.as_mut() {
            if meter.process(&samples).is_err() {
                // A failed measurement only disables loudness fallback.
                self.meter = None;
            }
        }
        writer.push(&samples).map_err(|e| e.to_string())
    }

    /// Decode until end of stream or until `should_stop` says so. `on_progress`
    /// runs after every decoded packet with the frames written so far.
    pub fn run(
        &mut self,
        writer: &mut TrackBufferWriter,
        mut should_stop: impl FnMut() -> bool,
        mut on_progress: impl FnMut(&TrackBufferWriter, u64),
    ) -> Result<PumpOutcome, String> {
        let mut decoded_input_frames = 0u64;
        while let Some(chunk) = self.decoder.decode_next().map_err(|e| e.to_string())? {
            if should_stop() {
                return Ok(PumpOutcome::Cancelled);
            }
            decoded_input_frames += (chunk.len() / self.source_channels.max(1)) as u64;
            let out = match self.resampler.as_mut() {
                Some(rs) => rs
                    .process_chunk(&chunk)
                    .map_err(|e| format!("Rubato streaming process failed: {e}"))?,
                None => chunk,
            };
            self.emit(out, writer)?;
            on_progress(writer, decoded_input_frames);
        }
        if let Some(rs) = self.resampler.as_mut() {
            let tail = rs
                .flush()
                .map_err(|e| format!("Rubato streaming finish failed: {e}"))?;
            self.emit(tail, writer)?;
        }
        Ok(PumpOutcome::Finished)
    }

    /// Integrated loudness of everything emitted, if a meter was attached.
    pub fn integrated_loudness(&self) -> Option<f64> {
        self.meter.as_ref().map(|m| m.integrated_loudness())
    }
}
