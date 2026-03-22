//! WASAPI Exclusive Mode Audio Output
//!
//! This module provides true WASAPI exclusive mode playback on Windows.
//! When exclusive mode is enabled, the application gets direct, unmixed access
//! to the audio hardware, bypassing the Windows audio mixer.

#[cfg(windows)]
pub mod wasapi_exclusive {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use parking_lot::RwLock;
    use std::thread::{self, JoinHandle};
    use crossbeam::channel::{Sender, Receiver, bounded};
    
    use wasapi::{
        initialize_mta, DeviceEnumerator, Direction, WaveFormat, SampleType,
        StreamMode, calculate_period_100ns,
    };
    
    /// Commands for the WASAPI playback thread
    pub enum WasapiCommand {
        Play,
        Pause,
        Stop,
        Shutdown,
        Seek(u64), // Used purely for notifying the UI/logs if needed, actual seek is handled by `audio_callback`
    }
    
    /// State of WASAPI playback
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub enum WasapiState {
        Stopped,
        Playing,
        Paused,
    }
    
    /// Shared state between WASAPI thread and main audio player
    pub struct WasapiSharedState {
        pub state: RwLock<WasapiState>,
        pub position_frames: AtomicU64,
        pub sample_rate: AtomicU64,
        pub channels: AtomicU64,
        pub total_frames: AtomicU64,
        pub is_active: AtomicBool,
    }
    
    impl WasapiSharedState {
        pub fn new() -> Self {
            Self {
                state: RwLock::new(WasapiState::Stopped),
                position_frames: AtomicU64::new(0),
                sample_rate: AtomicU64::new(44100),
                channels: AtomicU64::new(2),
                total_frames: AtomicU64::new(0),
                is_active: AtomicBool::new(false),
            }
        }
    }
    
    impl Default for WasapiSharedState {
        fn default() -> Self {
            Self::new()
        }
    }
    
    pub type DspCallback = Box<dyn FnMut(&mut [f32], usize) -> bool + Send>;
    
    pub struct WasapiExclusivePlayer {
        shared_state: Arc<WasapiSharedState>,
        cmd_tx: Sender<WasapiCommand>,
        thread_handle: Option<JoinHandle<()>>,
        #[allow(dead_code)]
        device_id: Option<usize>,
    }
    
    impl WasapiExclusivePlayer {
        /// Create a new WASAPI exclusive mode player
        pub fn new(device_id: Option<usize>, sample_rate: u32, channels: usize, dsp_callback: DspCallback) -> Result<Self, String> {
            let shared_state = Arc::new(WasapiSharedState::new());
            shared_state.sample_rate.store(sample_rate as u64, Ordering::Relaxed);
            shared_state.channels.store(channels as u64, Ordering::Relaxed);
            
            let (cmd_tx, cmd_rx) = bounded(16);
            
            let state_clone = Arc::clone(&shared_state);
            let dev_id = device_id;
            
            let thread_handle = thread::Builder::new()
                .name("wasapi-exclusive".to_string())
                .spawn(move || {
                    wasapi_thread_main(cmd_rx, state_clone, dev_id, dsp_callback);
                })
                .map_err(|e| format!("Failed to spawn WASAPI thread: {}", e))?;
            
            Ok(Self {
                shared_state,
                cmd_tx,
                thread_handle: Some(thread_handle),
                device_id,
            })
        }
        
        /// Get shared state reference
        pub fn shared_state(&self) -> Arc<WasapiSharedState> {
            Arc::clone(&self.shared_state)
        }
        
        /// Start playback
        pub fn play(&self) -> Result<(), String> {
            self.cmd_tx.send(WasapiCommand::Play)
                .map_err(|e| format!("Failed to send play command: {}", e))
        }
        
        /// Pause playback
        pub fn pause(&self) -> Result<(), String> {
            self.cmd_tx.send(WasapiCommand::Pause)
                .map_err(|e| format!("Failed to send pause command: {}", e))
        }
        
        /// Stop playback
        pub fn stop(&self) -> Result<(), String> {
            self.cmd_tx.send(WasapiCommand::Stop)
                .map_err(|e| format!("Failed to send stop command: {}", e))
        }
        
        /// Check if exclusive mode is active
        #[allow(dead_code)]
        pub fn is_active(&self) -> bool {
            self.shared_state.is_active.load(Ordering::Relaxed)
        }
        
        /// Get current playback state
        pub fn get_state(&self) -> WasapiState {
            *self.shared_state.state.read()
        }
        
        /// Seek to position
        #[allow(dead_code)]
        pub fn seek(&self, frame: u64) -> Result<(), String> {
            self.cmd_tx.send(WasapiCommand::Seek(frame))
                .map_err(|e| format!("Failed to send seek command: {}", e))
        }
    }
    
    impl Drop for WasapiExclusivePlayer {
        fn drop(&mut self) {
            let _ = self.cmd_tx.send(WasapiCommand::Shutdown);
            if let Some(handle) = self.thread_handle.take() {
                let _ = handle.join();
            }
        }
    }
    
    /// Main WASAPI playback thread
    fn wasapi_thread_main(
        cmd_rx: Receiver<WasapiCommand>,
        shared_state: Arc<WasapiSharedState>,
        device_id: Option<usize>,
        mut dsp_callback: DspCallback,
    ) {
        log::info!("WASAPI exclusive thread started");
        
        // Initialize COM for this thread - returns HRESULT in wasapi 0.22
        let hr = initialize_mta();
        if hr.is_err() {
            log::error!("Failed to initialize MTA: {:?}", hr);
            return;
        }
        
        loop {
            match cmd_rx.recv() {
                Ok(WasapiCommand::Play) => {
                    log::info!("WASAPI: Received Play command");
                    
                    // Get audio parameters
                    let sample_rate = shared_state.sample_rate.load(Ordering::Relaxed) as usize;
                    let channels = shared_state.channels.load(Ordering::Relaxed) as usize;
                    
                    if channels == 0 {
                        log::error!("WASAPI: Invalid channel count");
                        continue;
                    }
                    
                    // Start exclusive playback
                    match start_exclusive_playback(&shared_state, &cmd_rx, sample_rate, channels, device_id, &mut dsp_callback) {
                        Ok(()) => log::info!("WASAPI: Exclusive playback completed"),
                        Err(e) => log::error!("WASAPI: Playback error: {}", e),
                    }
                    
                    shared_state.is_active.store(false, Ordering::Relaxed);
                    *shared_state.state.write() = WasapiState::Stopped;
                }
                Ok(WasapiCommand::Pause) => {
                    // Pause is handled inside the playback loop
                    log::debug!("WASAPI: Pause command received outside playback loop");
                }
                Ok(WasapiCommand::Stop) => {
                    log::info!("WASAPI: Stop command");
                    shared_state.position_frames.store(0, Ordering::Relaxed);
                    *shared_state.state.write() = WasapiState::Stopped;
                }
                Ok(WasapiCommand::Seek(frame)) => {
                    log::info!("WASAPI: Seek command to frame {}", frame);
                    let total = shared_state.total_frames.load(Ordering::Relaxed);
                    let new_pos = frame.min(total);
                    shared_state.position_frames.store(new_pos, Ordering::Relaxed);
                }
                Ok(WasapiCommand::Shutdown) | Err(_) => {
                    log::info!("WASAPI: Shutting down thread");
                    break;
                }
            }
        }
    }
    
    /// Start exclusive mode playback
    fn start_exclusive_playback(
        shared_state: &Arc<WasapiSharedState>,
        cmd_rx: &Receiver<WasapiCommand>,
        sample_rate: usize,
        channels: usize,
        device_id: Option<usize>,
        dsp_callback: &mut DspCallback,
    ) -> Result<(), String> {
        let enumerator = DeviceEnumerator::new()
            .map_err(|e| format!("Failed to create device enumerator: {:?}", e))?;
        
        // Select device by ID if specified, otherwise use default
        let device = match device_id {
            Some(id) => {
                // Get device collection and select by index
                let collection = enumerator.get_device_collection(&Direction::Render)
                    .map_err(|e| format!("Failed to get device collection: {:?}", e))?;
                
                let count = collection.get_nbr_devices()
                    .map_err(|e| format!("Failed to get device count: {:?}", e))?;
                
                if id >= count as usize {
                    return Err(format!("Device ID {} not found (only {} devices available)", id, count));
                }
                
                collection.get_device_at_index(id as u32)
                    .map_err(|e| format!("Failed to get device at index {}: {:?}", id, e))?
            }
            None => {
                // Use default device
                enumerator.get_default_device(&Direction::Render)
                    .map_err(|e| format!("Failed to get default device: {:?}", e))?
            }
        };
        
        let device_name = device.get_friendlyname().unwrap_or_else(|_| "Unknown".to_string());
        log::info!("WASAPI: Opening device '{}' in exclusive mode", device_name);
        
        let mut audio_client = device.get_iaudioclient()
            .map_err(|e| format!("Failed to get audio client: {:?}", e))?;
        
        // Sample rates to try, in order of preference (highest quality first)
        // Start with the requested rate, then fall back to common high-quality rates
        let candidate_sample_rates: Vec<usize> = {
            let mut rates = vec![sample_rate];
            for &rate in &[192000, 176400, 96000, 88200, 48000, 44100] {
                if rate != sample_rate && !rates.contains(&rate) {
                    rates.push(rate);
                }
            }
            rates
        };
        
        // Try to find a supported format across all sample rates
        let mut desired_format: Option<WaveFormat> = None;
        let mut actual_sample_rate = sample_rate;
        
        'outer: for &try_rate in &candidate_sample_rates {
            // Need to get a fresh audio client for each rate attempt
            if try_rate != sample_rate {
                audio_client = device.get_iaudioclient()
                    .map_err(|e| format!("Failed to get audio client: {:?}", e))?;
            }
            
            // Try different formats - 32-bit float preferred, then 24-bit, then 16-bit
            let formats_to_try = [
                WaveFormat::new(32, 32, &SampleType::Float, try_rate, channels, None),
                WaveFormat::new(24, 24, &SampleType::Int, try_rate, channels, None),
                WaveFormat::new(16, 16, &SampleType::Int, try_rate, channels, None),
            ];
            
            for format in &formats_to_try {
                match audio_client.is_supported_exclusive_with_quirks(format) {
                    Ok(fmt) => {
                        log::info!("WASAPI: Format supported at {} Hz: {:?}", try_rate, fmt);
                        desired_format = Some(fmt);
                        actual_sample_rate = try_rate;
                        break 'outer;
                    }
                    Err(e) => {
                        log::debug!("WASAPI: Format not supported at {} Hz: {:?}", try_rate, e);
                    }
                }
            }
        }
        
        let desired_format = desired_format
            .ok_or_else(|| "No supported exclusive format found at any sample rate".to_string())?;
        
        // Initialize resampler if actual format is different from source
        let mut resampler = if actual_sample_rate != sample_rate {
            use crate::processor::StreamingResampler;
            use crate::config::PhaseResponse;
            log::info!("WASAPI: Intrinsic streaming resampling {} -> {} Hz", sample_rate, actual_sample_rate);
            match StreamingResampler::with_phase(channels, sample_rate as u32, actual_sample_rate as u32, PhaseResponse::Linear) {
                Ok(r) => Some(r),
                Err(e) => {
                    log::error!("WASAPI: Failed to create StreamingResampler: {:?}", e);
                    None
                }
            }
        } else {
            None
        };
        
        let blockalign = desired_format.get_blockalign();
        let bits_per_sample = desired_format.get_bitspersample();
        // Check subformat - returns Result, so unwrap with default
        let is_float = desired_format.get_subformat()
            .map(|st| st == SampleType::Float)
            .unwrap_or(false);
        
        // Store actual output bit depth for NoiseShaper (Defect 37 fix)
        // Note: We need to pass this to AudioPlayer, but this thread doesn't have direct access.
        // The caller (audio_thread) should check this and update NoiseShaper.
        
        log::info!(
            "WASAPI: Using format: {} Hz, {} ch, {}-bit {}, blockalign={}",
            actual_sample_rate, channels, bits_per_sample,
            if is_float { "float" } else { "int" },
            blockalign
        );
        
        // Get device period
        let (_def_period, min_period) = audio_client.get_device_period()
            .map_err(|e| format!("Failed to get device period: {:?}", e))?;
        
        // Calculate aligned period
        // Fix for 96kHz+ popping: Don't use minimum latency.
        // Use at least 10ms (100,000 units) buffer or double the min period.
        let safe_period = std::cmp::max(100_000, 2 * min_period);
        log::info!("WASAPI: Min period {}, requesting safe period {}", min_period, safe_period);

        let desired_period = audio_client
            .calculate_aligned_period_near(safe_period, Some(128), &desired_format)
            .map_err(|e| format!("Failed to calculate period: {:?}", e))?;
        
        log::info!("WASAPI: Using period {} (100ns units)", desired_period);
        
        // Initialize in exclusive event mode
        let mode = StreamMode::EventsExclusive {
            period_hns: desired_period,
        };
        
        // Try to initialize, handling buffer alignment errors
        let init_result = audio_client.initialize_client(&desired_format, &Direction::Render, &mode);
        
        if let Err(ref e) = init_result {
            // Check for buffer alignment error
            let err_str = format!("{:?}", e);
            if err_str.contains("BUFFER_SIZE_NOT_ALIGNED") {
                log::warn!("WASAPI: Buffer not aligned, adjusting...");
                
                let buffersize = audio_client.get_buffer_size()
                    .map_err(|e| format!("Failed to get buffer size: {:?}", e))?;
                
                let aligned_period = calculate_period_100ns(
                    buffersize as i64,
                    actual_sample_rate as i64,
                );
                
                // Get new client and reinitialize
                audio_client = device.get_iaudioclient()
                    .map_err(|e| format!("Failed to get new audio client: {:?}", e))?;
                
                let aligned_mode = StreamMode::EventsExclusive {
                    period_hns: aligned_period,
                };
                
                audio_client.initialize_client(&desired_format, &Direction::Render, &aligned_mode)
                    .map_err(|e| format!("Failed to initialize after alignment: {:?}", e))?;
            } else {
                return Err(format!("Failed to initialize: {:?}", e));
            }
        }
        
        // Get event handle and render client
        let h_event = audio_client.set_get_eventhandle()
            .map_err(|e| format!("Failed to get event handle: {:?}", e))?;
        
        let render_client = audio_client.get_audiorenderclient()
            .map_err(|e| format!("Failed to get render client: {:?}", e))?;
        
        // Mark as active and start stream
        shared_state.is_active.store(true, Ordering::Relaxed);
        *shared_state.state.write() = WasapiState::Playing;
        
        audio_client.start_stream()
            .map_err(|e| format!("Failed to start stream: {:?}", e))?;
        
        log::info!("WASAPI: Exclusive stream started!");
        
        // Playback loop
        let mut paused = false;
        let mut resample_leftover: Vec<f32> = Vec::new();
        let mut resample_output_f64: Vec<f64> = Vec::with_capacity(8192 * channels);
        
        // P1-9 fix: Pre-allocate buffers used in the hot loop to avoid per-frame heap allocation
        let max_buffer_frames = 8192; // Typical max buffer size
        let mut output_f32_buffer: Vec<f32> = vec![0.0; max_buffer_frames * channels];
        let mut byte_buffer: Vec<u8> = vec![0u8; max_buffer_frames * blockalign as usize];
        let mut temp_f32_buffer: Vec<f32> = vec![0.0; 4096 * channels]; // For resampler input
        
        loop {
            // Check for commands (non-blocking)
            if let Ok(cmd) = cmd_rx.try_recv() {
                match cmd {
                    WasapiCommand::Pause => {
                        if !paused {
                            let _ = audio_client.stop_stream();
                            *shared_state.state.write() = WasapiState::Paused;
                            paused = true;
                            log::info!("WASAPI: Paused");
                        }
                        continue;
                    }
                    WasapiCommand::Play => {
                        if paused {
                            let _ = audio_client.start_stream();
                            *shared_state.state.write() = WasapiState::Playing;
                            paused = false;
                            log::info!("WASAPI: Resumed");
                        }
                        continue;
                    }
                    WasapiCommand::Seek(frame) => {
                        log::info!("WASAPI: Seek to frame {}", frame);
                        
                        // Clear out our internal left-over resampling buffer so we don't play stale audio
                        resample_leftover.clear();
                        
                        // Flush hardware buffer: stop -> start
                        // This effectively clears the buffer by letting the old data play out
                        // while the position has been updated
                        let _ = audio_client.stop_stream();
                        // Small delay to ensure buffer is cleared
                        std::thread::sleep(std::time::Duration::from_millis(1));
                        let _ = audio_client.start_stream();
                        log::debug!("WASAPI: Stream restarted after seek");
                        continue;
                    }
                    WasapiCommand::Stop | WasapiCommand::Shutdown => {
                        log::info!("WASAPI: Stopping playback");
                        let _ = audio_client.stop_stream();
                        break;
                    }
                }
            }
            
            if paused {
                std::thread::sleep(std::time::Duration::from_millis(10));
                continue;
            }
            
            // Get available buffer space
            let buffer_frame_count = match audio_client.get_available_space_in_frames() {
                Ok(count) => count,
                Err(e) => {
                    log::error!("WASAPI: Failed to get buffer space: {:?}", e);
                    break;
                }
            };
            
            if buffer_frame_count == 0 {
                // Wait for event
                if h_event.wait_for_event(1000).is_err() {
                    log::warn!("WASAPI: Event wait timeout");
                    continue;
                }
                continue;
            }
            
            let frames_to_write = buffer_frame_count as usize;
            let samples_to_write = frames_to_write * channels;
            
            // P1-9 fix: Resize pre-allocated buffers if needed (only grows, never shrinks)
            if output_f32_buffer.len() < samples_to_write {
                output_f32_buffer.resize(samples_to_write, 0.0);
            }
            output_f32_buffer[..samples_to_write].fill(0.0);
            let mut is_eof = false;
            
            if let Some(ref mut rs) = resampler {
                let mut samples_written = 0;
                while samples_written < samples_to_write {
                    if !resample_leftover.is_empty() {
                        let take = resample_leftover.len().min(samples_to_write - samples_written);
                        output_f32_buffer[samples_written..samples_written + take].copy_from_slice(&resample_leftover[0..take]);
                        resample_leftover.drain(0..take);
                        samples_written += take;
                    }
                    
                    if samples_written == samples_to_write {
                        break;
                    }
                    
                    let source_frames_to_request = 4096;
                    // P1-9 fix: Reuse pre-allocated temp buffer instead of allocating per iteration
                    let temp_samples = source_frames_to_request * channels;
                    if temp_f32_buffer.len() < temp_samples {
                        temp_f32_buffer.resize(temp_samples, 0.0);
                    }
                    temp_f32_buffer[..temp_samples].fill(0.0);
                    let chunk_eof = dsp_callback(&mut temp_f32_buffer[..temp_samples], channels);
                    if chunk_eof {
                        is_eof = true;
                    }
                    
                    // P1-9 fix: Convert f32 -> f64 using pre-allocated buffer
                    resample_output_f64.clear();
                    resample_output_f64.extend(temp_f32_buffer[..temp_samples].iter().map(|&f| f as f64));
                    let temp_f64 = &resample_output_f64;
                    
                    let needed_output = temp_f64.len() * 2 + 256;
                    let mut resample_scratch = vec![0.0f64; needed_output]; // resampler needs separate output buffer
                    let written_frames = rs.process_chunk_into(temp_f64, &mut resample_scratch);
                    
                    let new_samples = written_frames * channels;
                    for i in 0..new_samples {
                        resample_leftover.push(resample_scratch[i] as f32);
                    }
                    
                    if is_eof && new_samples == 0 {
                        break;
                    }
                }
            } else {
                // P1-9 fix: Only pass the exact number of samples needed, not the full pre-allocated buffer
                is_eof = dsp_callback(&mut output_f32_buffer[..samples_to_write], channels);
            }
            
            if is_eof && output_f32_buffer[..samples_to_write].iter().all(|&x| x == 0.0) {
                log::info!("WASAPI: Playback complete (EOF)");
                let _ = audio_client.stop_stream();
                break;
            }
            
            let actual_frames = frames_to_write;
            
            // P1-9 fix: Reuse pre-allocated byte buffer
            let data_len = actual_frames * blockalign as usize;
            if byte_buffer.len() < data_len {
                byte_buffer.resize(data_len, 0);
            }
            byte_buffer[..data_len].fill(0);
            let data = &mut byte_buffer[..data_len];
            
            // P1-9 fix: Only convert the actual samples needed (samples_to_write), not the entire pre-allocated buffer
            if is_float && bits_per_sample == 32 {
                // 32-bit float
                for (i, sample) in output_f32_buffer[..samples_to_write].iter().enumerate() {
                    let bytes = sample.to_le_bytes();
                    let offset = i * 4;
                    if offset + 4 <= data.len() {
                        data[offset..offset + 4].copy_from_slice(&bytes);
                    }
                }
            } else if bits_per_sample == 24 {
                // 24-bit integer
                for (i, sample) in output_f32_buffer[..samples_to_write].iter().enumerate() {
                    let sample_i32 = (*sample as f64 * 8388607.0).clamp(-8388607.0, 8388607.0) as i32;
                    let bytes = sample_i32.to_le_bytes();
                    let offset = i * 3;
                    if offset + 3 <= data.len() {
                        data[offset..offset + 3].copy_from_slice(&bytes[0..3]);
                    }
                }
            } else if bits_per_sample == 16 {
                // 16-bit integer
                for (i, sample) in output_f32_buffer[..samples_to_write].iter().enumerate() {
                    let sample_i16 = (*sample as f64 * 32767.0).clamp(-32767.0, 32767.0) as i16;
                    let bytes = sample_i16.to_le_bytes();
                    let offset = i * 2;
                    if offset + 2 <= data.len() {
                        data[offset..offset + 2].copy_from_slice(&bytes);
                    }
                }
            }
            
            // Write to device
            if let Err(e) = render_client.write_to_device(actual_frames, data, None) {
                log::error!("WASAPI: Failed to write to device: {:?}", e);
                break;
            }
            
            // Wait for next buffer request
            if h_event.wait_for_event(1000).is_err() {
                log::warn!("WASAPI: Event wait timeout after write");
            }
        }
        
        shared_state.is_active.store(false, Ordering::Relaxed);
        Ok(())
    }
}

// Re-export for convenience
#[cfg(windows)]
pub use wasapi_exclusive::*;

// Stub for non-Windows platforms
#[cfg(not(windows))]
pub mod wasapi_exclusive {
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub enum WasapiState {
        Stopped,
        Playing,
        Paused,
    }
    
    pub struct WasapiExclusivePlayer;
    
    impl WasapiExclusivePlayer {
        pub fn new(_device_id: Option<usize>) -> Result<Self, String> {
            Err("WASAPI is only available on Windows".to_string())
        }
        
        pub fn get_state(&self) -> WasapiState {
            WasapiState::Stopped
        }
    }
}

#[cfg(not(windows))]
pub use wasapi_exclusive::WasapiState;
