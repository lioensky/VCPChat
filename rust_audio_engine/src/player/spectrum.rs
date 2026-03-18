//! Spectrum analysis thread
//!
//! Receives audio samples via channel and performs FFT analysis
//! for visualization purposes.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use crossbeam::channel::Receiver;

use super::state::SharedState;
use crate::processor::SpectrumAnalyzer;

/// Spectrum analysis thread entry point
///
/// Receives mono samples from the audio callback, buffers them,
/// and performs FFT analysis at regular intervals. Results are
/// stored in SharedState for WebSocket transmission.
pub fn spectrum_thread_main(
    rx: Receiver<f64>,
    shared: Arc<SharedState>,
    analyzer: Arc<SpectrumAnalyzer>,
) {
    let window_size = 2048;
    let mut buffer = Vec::with_capacity(window_size);

    loop {
        match rx.recv() {
            Ok(sample) => {
                buffer.push(sample);
                if buffer.len() >= window_size {
                    let sr = shared.sample_rate.load(Ordering::Relaxed) as u32;
                    let spectrum_data = analyzer.analyze(&buffer, sr);
                    *shared.spectrum_data.lock() = spectrum_data;
                    buffer.clear();
                }
            }
            Err(_) => break,
        }
    }
}