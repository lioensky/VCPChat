//! DSP Processing Chain
//!
//! Manages a collection of audio processors in a pipeline.
//! Provides:
//! - Guaranteed continuous processing (no lock-induced skips)
//! - Unified statistics and debugging
//! - Easy dynamic configuration
//!
//! # Architecture
//!
//! ```text
//! Input Buffer
//!      │
//!      ▼
//! ┌─────────────────────────────────────────────────────┐
//! │                    DspChain                          │
//! │                                                      │
//! │  ┌──────────┐   ┌──────────┐   ┌──────────┐        │
//! │  │    EQ    │ → │ Saturation│ → │ Crossfeed│ → ...  │
//! │  └──────────┘   └──────────┘   └──────────┘        │
//! │                                                      │
//! │  Each processor:                                     │
//! │  - Reads lock-free params                           │
//! │  - Processes without blocking                       │
//! │  - Never skips due to contention                    │
//! │                                                      │
//! └─────────────────────────────────────────────────────┘
//!      │
//!      ▼
//! Output Buffer
//! ```

use std::sync::atomic::{AtomicU64, Ordering};

use super::traits::{AudioProcessor, ProcessResult};

/// Processing statistics for monitoring
#[derive(Debug, Default, Clone)]
pub struct ChainStats {
    /// Total number of process() calls
    pub total_calls: u64,
    /// Number of times any processor was bypassed
    pub bypassed_count: u64,
    /// Number of times stale params were used
    pub stale_params_count: u64,
    /// Per-processor statistics
    pub processor_stats: Vec<ProcessorStats>,
}

/// Statistics for a single processor
#[derive(Debug, Default, Clone)]
pub struct ProcessorStats {
    /// Processor name
    pub name: String,
    /// Number of successful processes
    pub success_count: u64,
    /// Number of times bypassed
    pub bypassed_count: u64,
}

/// DSP processing chain
///
/// Manages multiple audio processors in sequence.
/// All processors share the same buffer, processed in-place.
pub struct DspChain {
    /// Processors in execution order
    processors: Vec<Box<dyn AudioProcessor>>,
    /// Chain-level statistics (atomic for lock-free updates)
    total_calls: AtomicU64,
    bypassed_count: AtomicU64,
    /// Sample rate for the chain
    sample_rate: f64,
}

impl DspChain {
    /// Create an empty DSP chain
    pub fn new(sample_rate: f64) -> Self {
        Self {
            processors: Vec::new(),
            total_calls: AtomicU64::new(0),
            bypassed_count: AtomicU64::new(0),
            sample_rate,
        }
    }

    /// Create a chain with pre-allocated capacity
    pub fn with_capacity(capacity: usize, sample_rate: f64) -> Self {
        Self {
            processors: Vec::with_capacity(capacity),
            total_calls: AtomicU64::new(0),
            bypassed_count: AtomicU64::new(0),
            sample_rate,
        }
    }

    /// Add a processor to the end of the chain
    pub fn add<P: AudioProcessor + 'static>(&mut self, processor: P) -> &mut Self {
        self.processors.push(Box::new(processor));
        self
    }

    /// Add a processor with Box (for dynamic dispatch)
    pub fn add_boxed(&mut self, processor: Box<dyn AudioProcessor>) -> &mut Self {
        self.processors.push(processor);
        self
    }

    /// Insert a processor at a specific position
    pub fn insert<P: AudioProcessor + 'static>(&mut self, index: usize, processor: P) {
        self.processors.insert(index, Box::new(processor));
    }

    /// Remove a processor by name
    pub fn remove_by_name(&mut self, name: &str) -> Option<Box<dyn AudioProcessor>> {
        let pos = self.processors.iter().position(|p| p.name() == name)?;
        Some(self.processors.remove(pos))
    }

    /// Process audio through all processors
    ///
    /// # Key Properties
    ///
    /// 1. **Continuous**: Never skips processors due to lock contention
    /// 2. **In-place**: Modifies buffer directly
    /// 3. **Lock-free**: All parameter updates use atomic operations
    ///
    /// # Arguments
    ///
    /// * `buffer` - Interleaved audio samples [L, R, L, R, ...]
    /// * `channels` - Number of audio channels
    pub fn process(&mut self, buffer: &mut [f64], channels: usize) {
        self.total_calls.fetch_add(1, Ordering::Relaxed);

        for processor in &mut self.processors {
            let result = processor.process(buffer, channels);

            if result == ProcessResult::Bypassed {
                self.bypassed_count.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// Reset all processors
    pub fn reset(&mut self) {
        for processor in &mut self.processors {
            processor.reset();
        }
    }

    /// Update sample rate for all processors
    pub fn set_sample_rate(&mut self, sample_rate: f64) {
        self.sample_rate = sample_rate;
        for processor in &mut self.processors {
            processor.set_sample_rate(sample_rate);
        }
    }

    /// Get number of processors
    pub fn len(&self) -> usize {
        self.processors.len()
    }

    /// Check if chain is empty
    pub fn is_empty(&self) -> bool {
        self.processors.is_empty()
    }

    /// Find processor by name
    pub fn find_mut(&mut self, name: &str) -> Option<&mut dyn AudioProcessor> {
        for processor in &mut self.processors {
            if processor.name() == name {
                return Some(processor.as_mut());
            }
        }
        None
    }

    /// Find processor by name (immutable)
    pub fn find(&self, name: &str) -> Option<&dyn AudioProcessor> {
        for processor in &self.processors {
            if processor.name() == name {
                return Some(processor.as_ref());
            }
        }
        None
    }

    /// Get processor at index
    pub fn get_mut(&mut self, index: usize) -> Option<&mut dyn AudioProcessor> {
        if let Some(processor) = self.processors.get_mut(index) {
            Some(processor.as_mut())
        } else {
            None
        }
    }

    /// Get chain statistics
    pub fn stats(&self) -> ChainStats {
        ChainStats {
            total_calls: self.total_calls.load(Ordering::Relaxed),
            bypassed_count: self.bypassed_count.load(Ordering::Relaxed),
            stale_params_count: 0, // Would need per-processor tracking
            processor_stats: self
                .processors
                .iter()
                .map(|p| ProcessorStats {
                    name: p.name().to_string(),
                    success_count: 0, // Would need atomic per-processor
                    bypassed_count: 0,
                })
                .collect(),
        }
    }

    /// Get all processor names
    pub fn processor_names(&self) -> Vec<&'static str> {
        self.processors.iter().map(|p| p.name()).collect()
    }

    /// Enable/disable a processor by name
    pub fn set_processor_enabled(&mut self, name: &str, enabled: bool) -> bool {
        if let Some(processor) = self.find_mut(name) {
            processor.set_enabled(enabled);
            true
        } else {
            false
        }
    }

    /// Check if a processor is enabled
    pub fn is_processor_enabled(&self, name: &str) -> Option<bool> {
        self.find(name).map(|p| p.is_enabled())
    }

    /// Clear all processors
    pub fn clear(&mut self) {
        self.processors.clear();
    }
}

impl Default for DspChain {
    fn default() -> Self {
        Self::new(44100.0)
    }
}

/// Builder for creating DSP chains
pub struct DspChainBuilder {
    chain: DspChain,
}

impl DspChainBuilder {
    /// Create a new builder
    pub fn new(sample_rate: f64) -> Self {
        Self {
            chain: DspChain::new(sample_rate),
        }
    }

    /// Add a processor
    pub fn add<P: AudioProcessor + 'static>(mut self, processor: P) -> Self {
        self.chain.add(processor);
        self
    }

    /// Build the chain
    pub fn build(self) -> DspChain {
        self.chain
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test processor that doubles samples
    struct DoublerProcessor {
        enabled: bool,
        processed_count: u64,
    }

    impl DoublerProcessor {
        fn new() -> Self {
            Self {
                enabled: true,
                processed_count: 0,
            }
        }
    }

    impl AudioProcessor for DoublerProcessor {
        fn name(&self) -> &'static str {
            "Doubler"
        }

        fn process(&mut self, buffer: &mut [f64], _channels: usize) -> ProcessResult {
            if !self.enabled {
                return ProcessResult::Bypassed;
            }
            for sample in buffer.iter_mut() {
                *sample *= 2.0;
            }
            self.processed_count += 1;
            ProcessResult::Ok
        }

        fn reset(&mut self) {
            self.processed_count = 0;
        }

        fn is_enabled(&self) -> bool {
            self.enabled
        }

        fn set_enabled(&mut self, enabled: bool) {
            self.enabled = enabled;
        }
    }

    // Test processor that adds 1.0
    struct AdderProcessor {
        enabled: bool,
    }

    impl AdderProcessor {
        fn new() -> Self {
            Self { enabled: true }
        }
    }

    impl AudioProcessor for AdderProcessor {
        fn name(&self) -> &'static str {
            "Adder"
        }

        fn process(&mut self, buffer: &mut [f64], _channels: usize) -> ProcessResult {
            if !self.enabled {
                return ProcessResult::Bypassed;
            }
            for sample in buffer.iter_mut() {
                *sample += 1.0;
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
    fn test_empty_chain() {
        let mut chain = DspChain::new(44100.0);
        let mut buffer = vec![1.0, 2.0, 3.0];
        chain.process(&mut buffer, 1);
        assert_eq!(buffer, vec![1.0, 2.0, 3.0]);
    }

    #[test]
    fn test_single_processor() {
        let mut chain = DspChain::new(44100.0);
        chain.add(DoublerProcessor::new());

        let mut buffer = vec![1.0, 2.0, 3.0];
        chain.process(&mut buffer, 1);

        assert_eq!(buffer, vec![2.0, 4.0, 6.0]);
    }

    #[test]
    fn test_chain_order() {
        let mut chain = DspChain::new(44100.0);
        chain.add(DoublerProcessor::new());  // Doubles first
        chain.add(AdderProcessor::new());    // Then adds 1

        // Start with 1.0 -> 2.0 (double) -> 3.0 (add 1)
        let mut buffer = vec![1.0];
        chain.process(&mut buffer, 1);
        assert_eq!(buffer, vec![3.0]);
    }

    #[test]
    fn test_bypassed_processor() {
        let mut chain = DspChain::new(44100.0);
        let mut doubler = DoublerProcessor::new();
        doubler.set_enabled(false);
        chain.add(doubler);

        let mut buffer = vec![5.0];
        chain.process(&mut buffer, 1);

        // Should be unchanged (bypassed)
        assert_eq!(buffer, vec![5.0]);
    }

    #[test]
    fn test_find_processor() {
        let mut chain = DspChain::new(44100.0);
        chain.add(DoublerProcessor::new());
        chain.add(AdderProcessor::new());

        assert!(chain.find("Doubler").is_some());
        assert!(chain.find("Adder").is_some());
        assert!(chain.find("NonExistent").is_none());
    }

    #[test]
    fn test_enable_disable() {
        let mut chain = DspChain::new(44100.0);
        chain.add(DoublerProcessor::new());

        assert!(chain.is_processor_enabled("Doubler").unwrap());

        chain.set_processor_enabled("Doubler", false);
        assert!(!chain.is_processor_enabled("Doubler").unwrap());
    }

    #[test]
    fn test_stats() {
        let mut chain = DspChain::new(44100.0);
        chain.add(DoublerProcessor::new());

        let mut buffer = vec![1.0; 100];
        for _ in 0..10 {
            chain.process(&mut buffer, 1);
        }

        let stats = chain.stats();
        assert_eq!(stats.total_calls, 10);
    }

    #[test]
    fn test_builder() {
        let mut chain = DspChainBuilder::new(44100.0)
            .add(DoublerProcessor::new())
            .add(AdderProcessor::new())
            .build();

        let mut buffer = vec![1.0];
        chain.process(&mut buffer, 1);
        assert_eq!(buffer, vec![3.0]);
    }

    #[test]
    fn test_remove_processor() {
        let mut chain = DspChain::new(44100.0);
        chain.add(DoublerProcessor::new());
        chain.add(AdderProcessor::new());

        let removed = chain.remove_by_name("Doubler");
        assert!(removed.is_some());
        assert_eq!(chain.len(), 1);
        assert!(chain.find("Doubler").is_none());
    }

    #[test]
    fn test_reset() {
        let mut chain = DspChain::new(44100.0);
        chain.add(DoublerProcessor::new());

        let mut buffer = vec![1.0; 100];
        chain.process(&mut buffer, 1);
        chain.reset();
        // Should not panic
    }
}
