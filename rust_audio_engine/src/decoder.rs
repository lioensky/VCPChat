//! VCP Hi-Fi Audio Engine - Streaming Decoder Module
//!
//! Uses Symphonia for high-quality audio decoding with streaming support.
//! Upgraded to f64 for full-stack lossless transparency.
//! Supports local file paths and HTTP(S) URLs with optional Basic Auth (WebDAV).

use std::fs::File;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{MetadataOptions, StandardTagKey, Value};
use symphonia::core::probe::{Hint, ProbeResult};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum DecoderError {
    #[error("Failed to open file: {0}")]
    FileOpen(#[from] std::io::Error),
    #[error("HTTP error: {0}")]
    Http(String),
    #[error("Unsupported format")]
    UnsupportedFormat,
    #[error("No audio track found")]
    NoAudioTrack,
    #[error("Decoder error: {0}")]
    Decoder(String),
    #[error("Probe error: {0}")]
    Probe(String),
}

/// Track metadata extracted from audio file tags
#[derive(Debug, Clone, Default)]
pub struct TrackMetadata {
    /// Track title
    pub title: Option<String>,
    /// Artist name
    pub artist: Option<String>,
    /// Album name
    pub album: Option<String>,
    /// Track number
    pub track_number: Option<u32>,
    /// Disc number
    pub disc_number: Option<u32>,
    /// Genre
    pub genre: Option<String>,
    /// Year
    pub year: Option<u32>,
    /// Cover art data (front cover)
    pub cover_art: Option<Vec<u8>>,
    /// Cover art MIME type (e.g., "image/jpeg", "image/png")
    pub cover_art_mime: Option<String>,
    /// ReplayGain track gain in dB (e.g., -6.54)
    pub rg_track_gain: Option<f64>,
    /// ReplayGain track peak (linear, 0.0-1.0+)
    pub rg_track_peak: Option<f64>,
    /// ReplayGain album gain in dB
    pub rg_album_gain: Option<f64>,
    /// ReplayGain album peak (linear)
    pub rg_album_peak: Option<f64>,
}

/// Audio format information extracted from file
#[derive(Debug, Clone)]
pub struct AudioInfo {
    pub sample_rate: u32,
    pub channels: usize,
    pub total_frames: Option<u64>,
    pub duration_secs: Option<f64>,
    /// Encoder delay: samples to skip at the start (for gapless playback)
    pub encoder_delay: u32,
    /// End padding: samples to skip at the end (for gapless playback)
    pub end_padding: u32,
    /// Track metadata (tags)
    pub metadata: TrackMetadata,
}

/// Extract track metadata from Symphonia probe result
fn extract_metadata(probed: &mut ProbeResult) -> TrackMetadata {
    let mut metadata = TrackMetadata::default();
    
    // Get metadata from the probed result
    // ProbedMetadata::get() returns Option<Metadata>
    if let Some(meta) = probed.metadata.get() {
        // Get current revision
        if let Some(revision) = meta.current() {
            // Iterate through tags
            for tag in revision.tags() {
                match tag.std_key {
                    Some(StandardTagKey::TrackTitle) => {
                        metadata.title = tag_value_to_string(&tag.value);
                    }
                    Some(StandardTagKey::Artist) => {
                        metadata.artist = tag_value_to_string(&tag.value);
                    }
                    Some(StandardTagKey::Album) => {
                        metadata.album = tag_value_to_string(&tag.value);
                    }
                    Some(StandardTagKey::TrackNumber) => {
                        metadata.track_number = tag_value_to_u32(&tag.value);
                    }
                    Some(StandardTagKey::DiscNumber) => {
                        metadata.disc_number = tag_value_to_u32(&tag.value);
                    }
                    Some(StandardTagKey::Genre) => {
                        metadata.genre = tag_value_to_string(&tag.value);
                    }
                    Some(StandardTagKey::Date) => {
                        metadata.year = tag_value_to_u32(&tag.value);
                    }
                    // ReplayGain tags (Symphonia may not have StandardTagKey for these)
                    _ => {
                        // Fallback: match raw tag keys for ReplayGain
                        let key_lower = tag.key.to_lowercase();
                        match key_lower.as_str() {
                            "replaygain_track_gain" => {
                                metadata.rg_track_gain = parse_rg_gain_from_value(&tag.value);
                            }
                            "replaygain_track_peak" => {
                                metadata.rg_track_peak = tag_value_to_f64(&tag.value);
                            }
                            "replaygain_album_gain" => {
                                metadata.rg_album_gain = parse_rg_gain_from_value(&tag.value);
                            }
                            "replaygain_album_peak" => {
                                metadata.rg_album_peak = tag_value_to_f64(&tag.value);
                            }
                            _ => {}
                        }
                    }
                }
            }
            
            // Extract cover art from visual metadata
            for visual in revision.visuals() {
                // Take first visual as cover art
                metadata.cover_art = Some(visual.data.to_vec());
                metadata.cover_art_mime = Some(visual.media_type.clone());
                break;
            }
        }
    }
    
    // Log extracted metadata
    if metadata.title.is_some() || metadata.artist.is_some() {
        log::debug!(
            "Extracted metadata: {:?} by {:?} from {:?}",
            metadata.title, metadata.artist, metadata.album
        );
    }
    
    metadata
}

/// Convert tag value to String
fn tag_value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::UnsignedInt(n) => Some(n.to_string()),
        Value::SignedInt(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Convert tag value to u32
fn tag_value_to_u32(value: &Value) -> Option<u32> {
    match value {
        Value::String(s) => s.parse().ok(),
        Value::UnsignedInt(n) => Some(*n as u32),
        Value::SignedInt(n) => Some(*n as u32),
        _ => None,
    }
}

/// Convert tag value to f64
fn tag_value_to_f64(value: &Value) -> Option<f64> {
    match value {
        Value::String(s) => s.parse().ok(),
        Value::UnsignedInt(n) => Some(*n as f64),
        Value::SignedInt(n) => Some(*n as f64),
        Value::Float(f) => Some(*f),
        _ => None,
    }
}

/// Parse ReplayGain gain value from tag value (format: "-6.54 dB")
fn parse_rg_gain_from_value(value: &Value) -> Option<f64> {
    let s = tag_value_to_string(value)?;
    parse_rg_gain_str(&s)
}

/// Parse ReplayGain gain string (format: "-6.54 dB" or just "-6.54")
fn parse_rg_gain_str(s: &str) -> Option<f64> {
    s.trim()
        .trim_end_matches("dB")
        .trim()
        .trim_end_matches("db")
        .trim()
        .parse::<f64>()
        .ok()
}

/// Parse ReplayGain peak string (format: "0.987654" or "0.987654 dB")
fn parse_rg_peak_str(s: &str) -> Option<f64> {
    // Extract just the numeric part
    s.split_whitespace()
        .next()
        .and_then(|p| p.parse::<f64>().ok())
}

/// Optional HTTP credentials for WebDAV / authenticated endpoints
#[derive(Debug, Clone, Default)]
pub struct HttpCredentials {
    pub username: String,
    pub password: String,
}

/// Streaming HTTP source using Range requests with read-ahead buffer
struct RangeStream {
    url: String,
    credentials: Option<HttpCredentials>,
    client: reqwest::blocking::Client,
    buf: Vec<u8>,       // read-ahead buffer
    buf_start: u64,     // file offset of buf[0]
    pos: u64,           // current logical read position
    content_length: Option<u64>,
    supports_range: bool, // whether server supports Range requests
}

const RANGE_PREFETCH: usize = 256 * 1024; // 256 KB per fetch

impl RangeStream {
    fn new(url: String, credentials: Option<HttpCredentials>) -> Result<Self, DecoderError> {
        // FIX for Defect 28: Add timeout to prevent indefinite blocking
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| DecoderError::Http(format!("Failed to create HTTP client: {}", e)))?;

        // Use HEAD request to probe server capabilities without downloading body
        // This is much more efficient than GET for large files
        let mut head_req = client.head(&url);
        if let Some(ref creds) = credentials {
            head_req = head_req.basic_auth(&creds.username, Some(&creds.password));
        }

        let (content_length, supports_range) = head_req.send()
            .ok()
            .and_then(|r| {
                // Check if server supports Range requests
                let supports_range = r.headers()
                    .get("accept-ranges")
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s == "bytes")
                    .unwrap_or(false);

                // Get content length if available
                let cl = r.headers()
                    .get("content-length")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse().ok());

                Some((cl, supports_range))
            })
            .unwrap_or((None, false));

        // If HEAD didn't give us content-length, try Range: bytes=0-0 as fallback
        // This gets minimal data (1 byte) while still getting headers
        let content_length = if content_length.is_none() {
            let mut range_req = client.get(&url).header("Range", "bytes=0-0");
            if let Some(ref creds) = credentials {
                range_req = range_req.basic_auth(&creds.username, Some(&creds.password));
            }
            range_req.send()
                .ok()
                .and_then(|r| {
                    r.headers()
                        .get("content-range")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| {
                            // Parse "bytes 0-0/12345" -> 12345
                            s.split('/').last().and_then(|s| s.parse().ok())
                        })
                })
        } else {
            content_length
        };

        Ok(Self {
            url,
            credentials,
            client,
            buf: Vec::new(),
            buf_start: 0,
            pos: 0,
            content_length,
            supports_range,
        })
    }

    fn fetch_range(&mut self, start: u64, len: usize) -> Result<Vec<u8>, DecoderError> {
        // Handle zero-length request to prevent underflow
        if len == 0 {
            return Ok(Vec::new());
        }

        // Calculate end position safely using checked arithmetic
        let end = start.checked_add(len as u64 - 1)
            .ok_or_else(|| DecoderError::Http("Range end overflow".into()))?;

        let mut req = self.client.get(&self.url)
            .header("Range", format!("bytes={}-{}", start, end));
        if let Some(ref creds) = self.credentials {
            req = req.basic_auth(&creds.username, Some(&creds.password));
        }

        let response = req.send()
            .map_err(|e| DecoderError::Http(e.to_string()))?;

        // Check if server returned partial content (Range was honored)
        let status = response.status();
        if !status.is_success() && status.as_u16() != 206 {
            // Server doesn't support Range requests or returned error
            return Err(DecoderError::Http(
                format!("Server returned {} (expected 206 Partial Content)", status)
            ));
        }

        Ok(response
            .bytes()
            .map_err(|e| DecoderError::Http(e.to_string()))?
            .to_vec())
    }

    /// Ensure buf covers [pos, pos+need)
    fn ensure_buffered(&mut self, need: usize) -> std::io::Result<()> {
        let buf_end = self.buf_start + self.buf.len() as u64;
        // Already buffered
        if self.pos >= self.buf_start && self.pos + need as u64 <= buf_end {
            return Ok(());
        }
        // Fetch a new chunk starting at pos
        let fetch_len = need.max(RANGE_PREFETCH);
        let fetch_len = if let Some(cl) = self.content_length {
            fetch_len.min((cl.saturating_sub(self.pos)) as usize)
        } else {
            fetch_len
        };
        if fetch_len == 0 {
            return Ok(());
        }
        let data = self.fetch_range(self.pos, fetch_len)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        self.buf_start = self.pos;
        self.buf = data;
        Ok(())
    }
}

impl Read for RangeStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() { return Ok(0); }
        self.ensure_buffered(buf.len())?;
        let offset = (self.pos - self.buf_start) as usize;
        let available = self.buf.len().saturating_sub(offset);
        if available == 0 { return Ok(0); } // EOF
        let n = available.min(buf.len());
        buf[..n].copy_from_slice(&self.buf[offset..offset + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for RangeStream {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let new_pos = match pos {
            SeekFrom::Start(p) => p as i64,
            SeekFrom::Current(d) => self.pos as i64 + d,
            SeekFrom::End(d) => {
                if let Some(len) = self.content_length {
                    len as i64 + d
                } else {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Unsupported,
                        "content-length unknown",
                    ));
                }
            }
        };
        if new_pos < 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "negative seek"));
        }
        self.pos = new_pos as u64;
        Ok(self.pos)
    }
}

impl symphonia::core::io::MediaSource for RangeStream {
    fn is_seekable(&self) -> bool { self.content_length.is_some() }
    fn byte_len(&self) -> Option<u64> { self.content_length }
}

/// Streaming audio decoder using Symphonia
pub struct StreamingDecoder {
    format_reader: Box<dyn symphonia::core::formats::FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    pub info: AudioInfo,
    sample_buf: Option<SampleBuffer<f64>>,
    /// Samples output counter for delay/padding trimming in streaming mode
    samples_output: u64,
    /// Flag indicating if we've finished outputting (for padding trim)
    finished: bool,
}

impl StreamingDecoder {
    /// Open a local file path
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, DecoderError> {
        Self::open_with_credentials(path, None)
    }

    /// Open an audio source (local path or HTTP/HTTPS URL) with optional Basic Auth credentials
    pub fn open_with_credentials<P: AsRef<Path>>(
        path: P,
        credentials: Option<&HttpCredentials>,
    ) -> Result<Self, DecoderError> {
        let path_str = path.as_ref().to_string_lossy();
        let is_url = path_str.starts_with("http://") || path_str.starts_with("https://");

        let (mss, hint) = if is_url {
            // Try Range-based streaming first; fall back to full download if server doesn't support it
            let owned_creds = credentials.cloned();
            let range_stream = RangeStream::new(path_str.to_string(), owned_creds.clone());
            match range_stream {
                Ok(stream) if stream.content_length.is_some() => {
                    log::info!("HTTP URL supports Range requests, streaming: {}", path_str);
                    let mss = MediaSourceStream::new(Box::new(stream), Default::default());
                    let mut hint = Hint::new();
                    if let Some(ext) = path_str
                        .split('?')
                        .next()
                        .and_then(|p| p.rsplit('.').next())
                        .filter(|e| e.len() <= 5)
                    {
                        hint.with_extension(ext);
                    }
                    (mss, hint)
                }
                _ => {
                    log::info!("HTTP URL does not support Range, falling back to full download: {}", path_str);
                    
                    // FIX for Defect 49: Check memory limit before downloading full file.
                    // Peak memory = raw bytes + decoded f64 samples (~8x expansion).
                    // Use the same limit as decode_all (2GB default).
                    let max_memory_mb: usize = std::env::var("DECODE_MAX_MEMORY_MB")
                        .ok()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(2048);
                    let max_memory_bytes = max_memory_mb * 1024 * 1024;
                    // Conservative estimate: decoded samples are ~8x raw bytes for typical formats
                    // So limit raw download to 1/8 of max memory
                    let max_download_bytes = max_memory_bytes / 8;
                    
                    // FIX for Defect 28: Add timeout to prevent indefinite blocking
                    let client = reqwest::blocking::Client::builder()
                        .timeout(std::time::Duration::from_secs(120))  // Longer for full downloads
                        .connect_timeout(std::time::Duration::from_secs(10))
                        .build()
                        .map_err(|e| DecoderError::Http(format!("Failed to create HTTP client: {}", e)))?;
                    
                    // Try to get Content-Length first via HEAD request
                    let mut head_req = client.head(path_str.as_ref());
                    if let Some(creds) = credentials {
                        head_req = head_req.basic_auth(&creds.username, Some(&creds.password));
                    }
                    
                    let content_length: Option<u64> = head_req.send().ok().and_then(|r| {
                        r.headers()
                            .get("content-length")
                            .and_then(|v| v.to_str().ok())
                            .and_then(|s| s.parse().ok())
                    });
                    
                    // Check if file is too large
                    if let Some(len) = content_length {
                        if len as usize > max_download_bytes {
                            let len_mb = len / (1024 * 1024);
                            return Err(DecoderError::Http(format!(
                                "File too large for non-Range download: {} MB (limit: {} MB). \
                                 Server must support Range requests for files this size. \
                                 Increase DECODE_MAX_MEMORY_MB env var if needed.",
                                len_mb, max_download_bytes / (1024 * 1024)
                            )));
                        }
                        log::info!("Downloading {} MB file (server does not support Range)", len / (1024 * 1024));
                    } else {
                        log::warn!("Content-Length unknown, downloading without size check (may cause OOM)");
                    }
                    
                    let mut req = client.get(path_str.as_ref());
                    if let Some(creds) = credentials {
                        req = req.basic_auth(&creds.username, Some(&creds.password));
                    }
                    let response = req
                        .send()
                        .map_err(|e| DecoderError::Http(e.to_string()))?;
                    
                    // FIX for Defect-49: Avoid double memory allocation
                    // Previously: bytes.to_vec() created a copy, causing 2x memory spike
                    // Now: Pre-allocate Vec with known size and use copy_from_slice()
                    let download_size = content_length.unwrap_or(0) as usize;
                    
                    let cursor = if download_size > 0 {
                        // Known size: pre-allocate exact buffer and copy directly
                        let mut buffer = vec![0u8; download_size];
                        let mut pos = 0;
                        let mut stream = response;
                        
                        while pos < download_size {
                            let remaining = &mut buffer[pos..];
                            let n = stream.read(remaining)
                                .map_err(|e| DecoderError::Http(e.to_string()))?;
                            if n == 0 {
                                // Early EOF - truncate buffer
                                buffer.truncate(pos);
                                break;
                            }
                            pos += n;
                            
                            // Check size limit during streaming download
                            if pos > max_download_bytes {
                                let actual_mb = pos / (1024 * 1024);
                                return Err(DecoderError::Http(format!(
                                    "Downloaded file exceeds memory limit: {} MB (limit: {} MB)",
                                    actual_mb, max_download_bytes / (1024 * 1024)
                                )));
                            }
                        }
                        
                        log::debug!("Downloaded {} bytes directly into pre-allocated buffer", pos);
                        Cursor::new(buffer)
                    } else {
                        // Unknown size: use bytes() and convert efficiently
                        let bytes = response
                            .bytes()
                            .map_err(|e| DecoderError::Http(e.to_string()))?;
                        
                        // Check actual download size
                        if bytes.len() > max_download_bytes {
                            let actual_mb = bytes.len() / (1024 * 1024);
                            return Err(DecoderError::Http(format!(
                                "Downloaded file exceeds memory limit: {} MB (limit: {} MB)",
                                actual_mb, max_download_bytes / (1024 * 1024)
                            )));
                        }
                        
                        // FIX: Use .to_vec() instead of .into_iter().collect() — avoids per-byte iteration overhead
                        Cursor::new(bytes.to_vec())
                    };
                    
                    let mss = MediaSourceStream::new(Box::new(cursor), Default::default());
                    let mut hint = Hint::new();
                    if let Some(ext) = path_str
                        .split('?')
                        .next()
                        .and_then(|p| p.rsplit('.').next())
                        .filter(|e| e.len() <= 5)
                    {
                        hint.with_extension(ext);
                    }
                    (mss, hint)
                }
            }
        } else {
            let file = File::open(path.as_ref())?;
            let mss = MediaSourceStream::new(Box::new(file), Default::default());
            let mut hint = Hint::new();
            if let Some(ext) = path.as_ref().extension().and_then(|e| e.to_str()) {
                hint.with_extension(ext);
            }
            (mss, hint)
        };

        let format_opts = FormatOptions::default();
        let metadata_opts = MetadataOptions::default();

        let mut probed = symphonia::default::get_probe()
            .format(&hint, mss, &format_opts, &metadata_opts)
            .map_err(|e| DecoderError::Probe(e.to_string()))?;

        // Extract track metadata from tags BEFORE moving format
        let metadata = extract_metadata(&mut probed);

        let format_reader = probed.format;

        let track = format_reader
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or(DecoderError::NoAudioTrack)?;

        let track_id = track.id;
        let codec_params = &track.codec_params;

        let sample_rate = codec_params.sample_rate.unwrap_or(44100);
        let channels = codec_params.channels.map(|c| c.count()).unwrap_or(2);
        let total_frames = codec_params.n_frames;
        let duration_secs = total_frames.map(|f| f as f64 / sample_rate as f64);

        // Read encoder delay and end padding for gapless playback
        // These are set by encoders like MP3, AAC, Opus to ensure sample-accurate decoding
        let encoder_delay = codec_params.delay.unwrap_or(0);
        let end_padding = codec_params.padding.unwrap_or(0);

        if encoder_delay > 0 || end_padding > 0 {
            log::debug!(
                "Codec delay compensation: delay={}, padding={} samples",
                encoder_delay, end_padding
            );
        }

        let info = AudioInfo {
            sample_rate,
            channels,
            total_frames,
            duration_secs,
            encoder_delay,
            end_padding,
            metadata,
        };

        let decoder_opts = DecoderOptions::default();
        let decoder = symphonia::default::get_codecs()
            .make(codec_params, &decoder_opts)
            .map_err(|e| DecoderError::Decoder(e.to_string()))?;

        log::info!(
            "Opened audio source: {} Hz, {} ch, {:?}s",
            sample_rate, channels, duration_secs
        );

        Ok(Self {
            format_reader,
            decoder,
            track_id,
            info,
            sample_buf: None,
            samples_output: 0,
            finished: false,
        })
    }

    /// Decode the next packet and return f64 interleaved samples
    ///
    /// Handles encoder delay and end padding trimming for gapless playback.
    /// In streaming mode, skips the first `encoder_delay` samples and
    /// stops output before the last `end_padding` samples.
    pub fn decode_next(&mut self) -> Result<Option<Vec<f64>>, DecoderError> {
        if self.finished {
            return Ok(None);
        }

        loop {
            let packet = match self.format_reader.next_packet() {
                Ok(p) => p,
                Err(symphonia::core::errors::Error::IoError(e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    self.finished = true;
                    return Ok(None); // EOF
                }
                Err(e) => return Err(DecoderError::Decoder(e.to_string())),
            };

            if packet.track_id() != self.track_id {
                continue;
            }

            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
                Err(e) => return Err(DecoderError::Decoder(e.to_string())),
            };

            let spec = *decoded.spec();
            let duration = decoded.capacity();

            if self.sample_buf.is_none()
                || self.sample_buf.as_ref().unwrap().capacity() < duration
            {
                self.sample_buf = Some(SampleBuffer::new(duration as u64, spec));
            }

            let sample_buf = self.sample_buf.as_mut().unwrap();
            sample_buf.copy_interleaved_ref(decoded);

            let mut samples: Vec<f64> = sample_buf.samples().to_vec();
            let channels = self.info.channels;

            // === Delay trimming (skip first encoder_delay samples) ===
            // FIX for Defect 26: encoder_delay is in FRAMES (per channel), not interleaved samples.
            // Must multiply by channels to get correct number of interleaved samples to skip.
            let delay_frames = self.info.encoder_delay as u64;
            let delay_samples = delay_frames * channels as u64;  // Convert frames to interleaved samples
            if self.samples_output < delay_samples {
                let skip = (delay_samples - self.samples_output).min(samples.len() as u64) as usize;
                samples.drain(0..skip);
                self.samples_output += skip as u64;
                if samples.is_empty() {
                    continue; // Get next packet
                }
            }

            // === Padding trimming (stop before end_padding samples) ===
            let total_frames = self.info.total_frames.unwrap_or(u64::MAX);
            let padding_frames = self.info.end_padding as u64;
            let effective_total = total_frames.saturating_sub(padding_frames);
            
            // Check if we would exceed effective total
            let current_frame = self.samples_output / channels as u64;
            let frames_in_chunk = samples.len() / channels;
            
            if current_frame + frames_in_chunk as u64 > effective_total {
                let frames_to_keep = effective_total.saturating_sub(current_frame) as usize;
                if frames_to_keep == 0 {
                    self.finished = true;
                    return Ok(None);
                }
                samples.truncate(frames_to_keep * channels);
            }

            self.samples_output += samples.len() as u64;
            return Ok(Some(samples));
        }
    }

    /// Decode entire file into a single f64 buffer
    ///
    /// Automatically trims encoder delay and end padding for gapless playback.
    /// 
    /// FIX for Defect 42: Check estimated memory size before decoding to prevent OOM.
    /// Maximum allowed: 2 GB of decoded audio data (configurable via DECODE_MAX_MEMORY_MB env var).
    pub fn decode_all(&mut self) -> Result<Vec<f64>, DecoderError> {
        // FIX for Defect 42: Estimate memory requirement before decoding
        // Each f64 sample = 8 bytes
        // Memory = total_frames * channels * 8 bytes
        let max_memory_mb: usize = std::env::var("DECODE_MAX_MEMORY_MB")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(2048);  // Default: 2 GB limit
        let max_memory_bytes = max_memory_mb * 1024 * 1024;
        
        if let Some(total_frames) = self.info.total_frames {
            let estimated_bytes = total_frames as usize * self.info.channels * 8;
            if estimated_bytes > max_memory_bytes {
                let estimated_mb = estimated_bytes / (1024 * 1024);
                return Err(DecoderError::Decoder(format!(
                    "File too large to decode into memory: estimated {} MB (limit: {} MB). \
                     Use streaming mode instead or increase DECODE_MAX_MEMORY_MB env var.",
                    estimated_mb, max_memory_mb
                )));
            }
            
            // Pre-allocate with known size for efficiency
            let total_samples = total_frames as usize * self.info.channels;
            log::info!(
                "Pre-allocating buffer for {} samples (~{} MB)",
                total_samples,
                total_samples * 8 / (1024 * 1024)
            );
        }
        
        let mut all_samples = Vec::new();
        while let Some(samples) = self.decode_next()? {
            all_samples.extend(samples);
            
            // FIX for Defect 42: Also check during streaming (for unknown duration files)
            let current_bytes = all_samples.len() * 8;
            if current_bytes > max_memory_bytes {
                let current_mb = current_bytes / (1024 * 1024);
                return Err(DecoderError::Decoder(format!(
                    "Memory limit exceeded during decode: {} MB (limit: {} MB). \
                     File may be corrupted or extremely long.",
                    current_mb, max_memory_mb
                )));
            }
        }

        let delay_trimmed = self.info.encoder_delay;
        let padding_trimmed = self.info.end_padding;
        
        if delay_trimmed > 0 || padding_trimmed > 0 {
            log::info!(
                "Decoded {} samples (trimmed {} delay + {} padding for gapless)",
                all_samples.len(), delay_trimmed, padding_trimmed
            );
        } else {
            log::info!("Decoded {} total samples (f64)", all_samples.len());
        }
        
        Ok(all_samples)
    }

    pub fn seek(&mut self, time_secs: f64) -> Result<(), DecoderError> {
        use symphonia::core::formats::SeekTo;
        use symphonia::core::units::Time;

        let seek_to = SeekTo::Time {
            time: Time::from(time_secs),
            track_id: Some(self.track_id),
        };

        self.format_reader
            .seek(symphonia::core::formats::SeekMode::Coarse, seek_to)
            .map_err(|e| DecoderError::Decoder(e.to_string()))?;

        self.decoder.reset();
        
        // FIX for Defect 48: Reset finished flag and samples counter when seeking.
        // Without this, decode_next() would immediately return None after a seek
        // because the finished flag was still true from previous EOF.
        self.finished = false;
        self.samples_output = 0;
        
        Ok(())
    }
}
