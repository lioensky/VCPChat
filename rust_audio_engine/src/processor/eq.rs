//! IIR Biquad Equalizer - 10-band parametric EQ

/// IIR Biquad filter section (SOS - Second Order Section)
#[derive(Clone)]
pub struct BiquadSection {
    b0: f64, b1: f64, b2: f64,
    a1: f64, a2: f64,
    z1: f64, z2: f64,
}

impl BiquadSection {
    pub fn peaking_eq(freq: f64, gain_db: f64, q: f64, sample_rate: f64) -> Self {
        let a = 10.0_f64.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f64::consts::PI * freq / sample_rate;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * q);
        
        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cos_w0;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1 = -2.0 * cos_w0;
        let a2 = 1.0 - alpha / a;
        
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }
    
    #[inline]
    pub fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
    
    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
    
    /// Copy coefficients from another section without copying state (z1, z2).
    /// This is used for smooth parameter transitions to avoid state discontinuities.
    pub fn copy_coefficients_from(&mut self, other: &Self) {
        self.b0 = other.b0;
        self.b1 = other.b1;
        self.b2 = other.b2;
        self.a1 = other.a1;
        self.a2 = other.a2;
        // z1, z2 are intentionally NOT copied - keep current state
    }
}

/// 10-band Parametric EQ
pub struct Equalizer {
    bands: Vec<Vec<BiquadSection>>,     // current active filters [channel][band]
    target_bands: Vec<Vec<BiquadSection>>, // target filters (new params) [channel][band]
    target_gains: Vec<f64>,              // target gain per band (dB)
    smooth_counter: Vec<u32>,            // samples remaining in crossfade per band
    channels: usize,
    enabled: bool,
    sample_rate: f64,
}

const EQ_SMOOTH_SAMPLES: u32 = 1024; // ~23ms @ 44100Hz

impl Equalizer {
    const FREQUENCIES: [f64; 10] = [31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];
    const Q: f64 = 1.41;

    pub fn new(channels: usize, sample_rate: f64) -> Self {
        let bands: Vec<Vec<BiquadSection>> = (0..channels)
            .map(|_| {
                Self::FREQUENCIES
                    .iter()
                    .map(|&f| BiquadSection::peaking_eq(f, 0.0, Self::Q, sample_rate))
                    .collect()
            })
            .collect();
        let target_bands = bands.clone();

        Self {
            bands,
            target_bands,
            target_gains: vec![0.0; 10],
            smooth_counter: vec![0u32; 10],
            channels,
            enabled: false,
            sample_rate,
        }
    }

    pub fn set_band_gain(&mut self, band_idx: usize, gain_db: f64, sample_rate: f64) {
        if band_idx >= 10 { return; }
        let gain_db = gain_db.clamp(-15.0, 15.0);
        let freq = Self::FREQUENCIES[band_idx];
        // Update target filters for all channels
        for ch in 0..self.channels {
            self.target_bands[ch][band_idx] = BiquadSection::peaking_eq(freq, gain_db, Self::Q, sample_rate);
        }
        self.target_gains[band_idx] = gain_db;
        // Start crossfade for this band
        self.smooth_counter[band_idx] = EQ_SMOOTH_SAMPLES;
    }

    pub fn set_all_bands(&mut self, gains: &[f64; 10], sample_rate: f64) {
        for (idx, &gain) in gains.iter().enumerate() {
            self.set_band_gain(idx, gain, sample_rate);
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn process(&mut self, buffer: &mut [f64]) {
        if !self.enabled { return; }
        let frames = buffer.len() / self.channels;
        
        for frame in 0..frames {
            // Process all channels for this frame
            for ch in 0..self.channels {
                let idx = frame * self.channels + ch;
                buffer[idx] = self.process_sample_no_counter_update(buffer[idx], ch);
            }
            
            // Update smooth counters once per frame (after all channels processed)
            // This fixes the multi-channel sync issue (MINOR-04)
            for b in 0..self.bands[0].len() {
                if self.smooth_counter[b] > 0 {
                    self.smooth_counter[b] -= 1;
                    // Crossfade done: snap current to target
                    if self.smooth_counter[b] == 0 {
                        for c in 0..self.channels {
                            self.bands[c][b].copy_coefficients_from(&self.target_bands[c][b]);
                        }
                    }
                }
            }
        }
    }

    /// Process a single sample without updating smooth_counter
    /// Counter updates are handled in process() for proper multi-channel sync
    #[inline]
    fn process_sample_no_counter_update(&mut self, mut sample: f64, ch: usize) -> f64 {
        if ch >= self.channels { return sample; }
        for b in 0..self.bands[ch].len() {
            if self.smooth_counter[b] > 0 {
                // Blend: run both filters on the same input
                let current_out = self.bands[ch][b].process(sample);
                let target_out = self.target_bands[ch][b].process(sample);
                let t = self.smooth_counter[b] as f64 / EQ_SMOOTH_SAMPLES as f64;
                sample = current_out * t + target_out * (1.0 - t);
            } else {
                sample = self.bands[ch][b].process(sample);
            }
        }
        sample
    }

    // M-2 fix: Removed deprecated process_sample() method.
    // It duplicated logic from process() + process_sample_no_counter_update()
    // with subtle differences that could cause bugs. Use process() instead.

    pub fn reset(&mut self) {
        for ch in &mut self.bands {
            for band in ch {
                band.reset();
            }
        }
        for ch in &mut self.target_bands {
            for band in ch {
                band.reset();
            }
        }
    }
}
