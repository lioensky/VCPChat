//! Spectrum analysis thread
//!
//! The audio callback pushes mono f32 samples into a wait-free SPSC ring
//! (`rtrb`); this thread drains it, runs the FFT analyzer every 2048 samples
//! and stores the result in `SharedState` for the WebSocket pusher.
//!
//! Each output stream owns its own producer, so a new ring is created per
//! stream and the consumer is handed over through [`SpectrumTap`].

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use crossbeam::channel::{Receiver, Sender, TryRecvError};
use parking_lot::Mutex;
use rtrb::{Consumer, Producer, RingBuffer};

use super::state::SharedState;
use crate::processor::SpectrumAnalyzer;

/// Ring capacity in mono samples (~370 ms at 44.1 kHz).
const RING_CAPACITY: usize = 16_384;
const WINDOW_SIZE: usize = 2048;
/// How long the analysis thread sleeps when the ring is empty.
const IDLE_POLL: Duration = Duration::from_millis(15);

/// Hands out ring producers to output streams and sends the matching
/// consumer to the analysis thread.
#[derive(Clone)]
pub struct SpectrumTap {
    consumers: Sender<Consumer<f32>>,
}

impl SpectrumTap {
    pub fn new() -> (Self, Receiver<Consumer<f32>>) {
        let (consumers, rx) = crossbeam::channel::unbounded();
        (Self { consumers }, rx)
    }

    /// Create a ring for a new output stream. Call off the realtime thread.
    pub fn producer(&self) -> Producer<f32> {
        let (producer, consumer) = RingBuffer::new(RING_CAPACITY);
        let _ = self.consumers.send(consumer);
        producer
    }
}

/// Spectrum analysis thread entry point.
pub fn spectrum_thread_main(
    consumers: Receiver<Consumer<f32>>,
    shared: Arc<SharedState>,
    analyzer: Arc<Mutex<SpectrumAnalyzer>>,
) {
    let mut window: Vec<f64> = Vec::with_capacity(WINDOW_SIZE);
    let mut active: Option<Consumer<f32>> = None;
    let mut idle_polls: u32 = 0;

    loop {
        // Newest stream wins; the previous stream's ring is dropped here.
        loop {
            match consumers.try_recv() {
                Ok(consumer) => {
                    active = Some(consumer);
                    window.clear();
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }

        // Track buffers retired by the realtime callback are freed here.
        shared.reclaim_retired_buffers();

        let mut drained_any = false;
        if let Some(consumer) = active.as_mut() {
            let available = consumer.slots();
            if available > 0 {
                drained_any = true;
                if let Ok(chunk) = consumer.read_chunk(available) {
                    let (first, second) = chunk.as_slices();
                    for &sample in first.iter().chain(second.iter()) {
                        window.push(sample as f64);
                        if window.len() >= WINDOW_SIZE {
                            let sr = shared.sample_rate.load(Ordering::Relaxed) as u32;
                            if let Ok(spectrum_data) = analyzer.lock().analyze(&window, sr) {
                                let mut target = shared.spectrum_data.lock();
                                target.clear();
                                target.extend_from_slice(&spectrum_data);
                            }
                            window.clear();
                        }
                    }
                    chunk.commit_all();
                }
            }
        }

        if drained_any {
            idle_polls = 0;
        } else {
            // Back off when nothing is playing for a while.
            idle_polls = idle_polls.saturating_add(1);
            std::thread::sleep(if idle_polls > 100 { IDLE_POLL * 6 } else { IDLE_POLL });
        }
    }
}
