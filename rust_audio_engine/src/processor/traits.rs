//! Audio Processor Traits
//!
//! Defines the unified interface for all DSP processors in the audio pipeline.
//! This abstraction enables:
//! - Lock-free parameter passing from main thread to audio thread
//! - Composable DSP chain with guaranteed continuity
//! - Easy testing and extension of processors

/// Processing result status
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessResult {
    /// Normal processing completed
    Ok,
    /// Processor is disabled, signal passed through unchanged
    Bypassed,
    /// Parameters were stale, used previous values
    StaleParams,
}

/// Core audio processor trait
///
/// All DSP processors must implement this trait to be used in the DspChain.
/// The trait provides a unified interface for:
/// - Audio processing
/// - State reset
/// - Enable/disable control
///
/// # Thread Safety
///
/// Implementations must be `Send` because processors are owned by the audio thread.
/// Parameters should be passed via lock-free mechanisms (see `LockfreeParams`).
///
/// # Example
///
/// ```ignore
/// use crate::processor::traits::{AudioProcessor, ProcessResult};
///
/// struct MyProcessor {
///     enabled: bool,
///     gain: f64,
/// }
///
/// impl AudioProcessor for MyProcessor {
///     fn name(&self) -> &'static str { "MyProcessor" }
///     
///     fn process(&mut self, buffer: &mut [f64], channels: usize) -> ProcessResult {
///         if !self.enabled {
///             return ProcessResult::Bypassed;
///         }
///         for sample in buffer.iter_mut() {
///             *sample *= self.gain;
///         }
///         ProcessResult::Ok
///     }
///     
///     fn reset(&mut self) {}
///     fn is_enabled(&self) -> bool { self.enabled }
///     fn set_enabled(&mut self, enabled: bool) { self.enabled = enabled; }
/// }
/// ```
pub trait AudioProcessor: Send {
    /// Processor name for debugging and logging
    fn name(&self) -> &'static str;

    /// Process audio samples in-place
    ///
    /// # Arguments
    /// * `buffer` - Interleaved audio samples [L, R, L, R, ...]
    /// * `channels` - Number of audio channels
    ///
    /// # Returns
    /// Processing result status indicating what happened
    fn process(&mut self, buffer: &mut [f64], channels: usize) -> ProcessResult;

    /// Reset internal state (filter delay lines, etc.)
    ///
    /// Called when:
    /// - Starting a new track
    /// - Changing sample rate
    /// - After gapless track switch
    fn reset(&mut self);

    /// Check if processor is enabled
    fn is_enabled(&self) -> bool;

    /// Enable or disable the processor
    fn set_enabled(&mut self, enabled: bool);

    /// Update sample rate and recalculate internal coefficients if needed.
    ///
    /// Default implementation is no-op for processors that are sample-rate agnostic.
    fn set_sample_rate(&mut self, _sample_rate: f64) {}
}

/// Lock-free parameter trait
///
/// Enables safe parameter updates from the main thread to the audio thread
/// without using mutexes or blocking operations.
///
/// # Implementations
///
/// - Simple scalar values: Use atomic operations directly
/// - Complex structures: Use SeqLock pattern or triple buffering
///
/// # Usage Pattern
///
/// ```ignore
/// // Main thread
/// params.write(&new_params);
///
/// // Audio thread
/// if params.has_update() {
///     let snapshot = params.read();
///     processor.apply_params(&snapshot);
/// }
/// ```
pub trait LockfreeParams: Send + Sync {
    /// Name of the processor these params belong to
    fn processor_name(&self) -> &'static str;

    /// Mark parameters as updated (main thread calls this)
    fn mark_dirty(&self);

    /// Clear the update flag (audio thread calls this)
    fn clear_dirty(&self);

    /// Check if parameters have been updated
    fn is_dirty(&self) -> bool;
}

/// Sample rate aware processor extension
///
/// Processors that need sample rate information should implement this.
pub trait SampleRateAware {
    /// Get current sample rate
    fn sample_rate(&self) -> f64;

    /// Set sample rate and recalculate internal coefficients
    fn set_sample_rate(&mut self, sample_rate: f64);
}

/// Channel count aware processor extension
///
/// Processors that need to know channel count during initialization.
pub trait ChannelAware {
    /// Get channel count
    fn channels(&self) -> usize;

    /// Set channel count (may require reinitialization)
    fn set_channels(&mut self, channels: usize);
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestProcessor {
        enabled: bool,
        gain: f64,
    }

    impl AudioProcessor for TestProcessor {
        fn name(&self) -> &'static str {
            "TestProcessor"
        }

        fn process(&mut self, buffer: &mut [f64], _channels: usize) -> ProcessResult {
            if !self.enabled {
                return ProcessResult::Bypassed;
            }
            for sample in buffer.iter_mut() {
                *sample *= self.gain;
            }
            ProcessResult::Ok
        }

        fn reset(&mut self) {}

        fn is_enabled(&self) -> bool {
            self.enabled
        }

        fn set_enabled(&mut self, enabled: bool) {
            self.enabled = enabled;
        }
    }

    #[test]
    fn test_processor_enabled() {
        let mut proc = TestProcessor {
            enabled: true,
            gain: 0.5,
        };
        let mut buffer = vec![1.0, 1.0];
        let result = proc.process(&mut buffer, 1);
        assert_eq!(result, ProcessResult::Ok);
        assert!((buffer[0] - 0.5).abs() < 1e-10);
    }

    #[test]
    fn test_processor_bypassed() {
        let mut proc = TestProcessor {
            enabled: false,
            gain: 0.5,
        };
        let mut buffer = vec![1.0, 1.0];
        let result = proc.process(&mut buffer, 1);
        assert_eq!(result, ProcessResult::Bypassed);
        assert!((buffer[0] - 1.0).abs() < 1e-10);
    }
}
