//! VCP Hi-Fi Audio Engine - Streaming Decoder Module
//!
//! Uses Symphonia for high-quality audio decoding with streaming support.
//! Upgraded to f64 for full-stack lossless transparency.
//! Supports local file paths and HTTP(S) URLs with optional Basic Auth (WebDAV).

use std::fs::File;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_AAC, CODEC_TYPE_NULL};
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
                                metadata.rg_track_peak = parse_rg_peak_from_value(&tag.value);
                            }
                            "replaygain_album_gain" => {
                                metadata.rg_album_gain = parse_rg_gain_from_value(&tag.value);
                            }
                            "replaygain_album_peak" => {
                                metadata.rg_album_peak = parse_rg_peak_from_value(&tag.value);
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

/// Parse ReplayGain peak value from tag value (format: "0.987654" or "0.987654 dB")
fn parse_rg_peak_from_value(value: &Value) -> Option<f64> {
    match value {
        Value::String(s) => parse_rg_peak_str(s),
        Value::UnsignedInt(n) => Some(*n as f64),
        Value::SignedInt(n) => Some(*n as f64),
        Value::Float(f) => Some(*f),
        _ => None,
    }
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
/// Waits before each retry of a failed chunk: about 4 s in all, then the error stands.
#[cfg(not(test))]
const RANGE_RETRY_DELAYS_MS: [u64; 4] = [250, 500, 1000, 2000];
#[cfg(test)]
const RANGE_RETRY_DELAYS_MS: [u64; 4] = [1, 1, 1, 1];

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

    /// One chunk of the file. A dropped connection, a timeout or a busy server (5xx, 408,
    /// 429) is retried a few times: a Wi-Fi hiccup or a NAS waking up used to end the song
    /// right there and skip to the next one.
    fn fetch_range(&mut self, start: u64, len: usize) -> Result<Vec<u8>, DecoderError> {
        // Handle zero-length request to prevent underflow
        if len == 0 {
            return Ok(Vec::new());
        }
        let mut attempt = 0;
        loop {
            match self.fetch_range_once(start, len) {
                Ok(data) => return Ok(data),
                Err((error, retryable)) => {
                    if !retryable || attempt >= RANGE_RETRY_DELAYS_MS.len() {
                        return Err(error);
                    }
                    log::warn!(
                        "Range fetch at {} failed ({}), retry {} of {}",
                        start,
                        error,
                        attempt + 1,
                        RANGE_RETRY_DELAYS_MS.len()
                    );
                    std::thread::sleep(std::time::Duration::from_millis(RANGE_RETRY_DELAYS_MS[attempt]));
                    attempt += 1;
                }
            }
        }
    }

    /// One request; the error says whether trying again can help.
    fn fetch_range_once(&self, start: u64, len: usize) -> Result<Vec<u8>, (DecoderError, bool)> {
        // Calculate end position safely using checked arithmetic
        let end = start
            .checked_add(len as u64 - 1)
            .ok_or_else(|| (DecoderError::Http("Range end overflow".into()), false))?;

        let mut req = self.client.get(&self.url)
            .header("Range", format!("bytes={}-{}", start, end));
        if let Some(ref creds) = self.credentials {
            req = req.basic_auth(&creds.username, Some(&creds.password));
        }

        let response = req.send().map_err(|e| (DecoderError::Http(e.to_string()), true))?;

        let status = response.status();
        let code = status.as_u16();
        // A 200 answer to a Range request is the whole file from byte 0: using it as the
        // chunk at `start` would feed the decoder the wrong bytes.
        if code != 206 && !(code == 200 && start == 0) {
            let retryable = status.is_server_error() || code == 408 || code == 429;
            return Err((
                DecoderError::Http(format!("Server returned {} (expected 206 Partial Content)", status)),
                retryable,
            ));
        }

        let mut data = response
            .bytes()
            .map_err(|e| (DecoderError::Http(e.to_string()), true))?
            .to_vec();
        data.truncate(len);
        Ok(data)
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
                Ok(stream) if stream.content_length.is_some() && stream.supports_range => {
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
        let mut encoder_delay = codec_params.delay.unwrap_or(0);
        let mut end_padding = codec_params.padding.unwrap_or(0);
        let mut duration_secs = duration_secs;

        // AAC in MP4/M4A: the demuxer leaves the priming in (edit list / iTunSMPB are not applied),
        // so every track of a gapless album would start with ~23-48 ms of encoder warm-up.
        if !is_url && encoder_delay == 0 && end_padding == 0 && codec_params.codec == CODEC_TYPE_AAC {
            if let Some(g) = crate::mp4_gapless::read_file(path.as_ref(), sample_rate) {
                encoder_delay = g.delay.min(u32::MAX as u64) as u32;
                if let (Some(total), Some(valid)) = (total_frames, g.valid_frames) {
                    let after = total.saturating_sub(g.delay);
                    // Within rounding of the edit list the sample table is the better length.
                    let keep = if after.abs_diff(valid) <= g.tolerance { after } else { valid.min(after) };
                    end_padding = total.saturating_sub(g.delay).saturating_sub(keep).min(u32::MAX as u64) as u32;
                    duration_secs = Some(keep as f64 / sample_rate as f64);
                }
            }
        }

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

#[cfg(test)]
pub(crate) mod range_retry_tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// A tiny HTTP server for `body`. `fail(n)` decides what the n-th ranged GET gets:
    /// 0 = served, 1 = 503, 2 = half the body and a dropped connection, 3 = 200 with the whole file.
    pub(crate) fn serve(body: Vec<u8>, fail: fn(usize) -> u8) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/song.flac", listener.local_addr().unwrap());
        let gets = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&gets);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                if reader.read_line(&mut first).is_err() { continue; }
                let mut range = None;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" { break; }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                        let mut it = v.trim().split('-');
                        let a: usize = it.next().unwrap().parse().unwrap();
                        let b: usize = it.next().unwrap().parse().unwrap();
                        range = Some((a, b.min(body.len() - 1)));
                    }
                }
                if first.starts_with("HEAD") {
                    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n", body.len());
                    continue;
                }
                let (a, b) = range.unwrap_or((0, body.len() - 1));
                let n = counter.fetch_add(1, Ordering::SeqCst);
                match fail(n) {
                    1 => { let _ = write!(stream, "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); }
                    2 => {
                        let part = &body[a..=b];
                        let _ = write!(stream, "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n", part.len(), a, b, body.len());
                        let _ = stream.write_all(&part[..part.len() / 2]);
                    }
                    3 => {
                        let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                        let _ = stream.write_all(&body);
                    }
                    _ => {
                        let part = &body[a..=b];
                        let _ = write!(stream, "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n", part.len(), a, b, body.len());
                        let _ = stream.write_all(part);
                    }
                }
            }
        });
        (url, gets)
    }

    fn body() -> Vec<u8> {
        (0..(RANGE_PREFETCH * 2 + 1234)).map(|i| (i * 7 % 251) as u8).collect()
    }

    fn read_all(url: &str) -> std::io::Result<Vec<u8>> {
        let mut stream = RangeStream::new(url.to_string(), None).unwrap();
        assert!(stream.supports_range);
        let mut out = Vec::new();
        stream.read_to_end(&mut out)?;
        Ok(out)
    }

    #[test]
    fn a_busy_server_or_a_dropped_connection_mid_song_is_retried() {
        let data = body();
        // Second chunk: 503, then a connection cut halfway, then served.
        let (url, gets) = serve(data.clone(), |n| match n { 1 => 1, 2 => 2, _ => 0 });
        assert_eq!(read_all(&url).unwrap(), data);
        assert!(gets.load(Ordering::SeqCst) >= 5);
    }

    #[test]
    fn a_whole_file_answer_to_a_range_request_is_not_used_as_the_chunk() {
        let data = body();
        // Every non-first chunk gets the whole file with 200: must fail, not play wrong bytes.
        let (url, _) = serve(data.clone(), |n| if n == 0 { 0 } else { 3 });
        let result = read_all(&url);
        assert!(result.is_err(), "decoded the wrong bytes instead of failing");
    }

    #[test]
    fn a_server_that_stays_down_still_ends_in_an_error() {
        let (url, gets) = serve(body(), |n| if n == 0 { 0 } else { 1 });
        assert!(read_all(&url).is_err());
        assert_eq!(gets.load(Ordering::SeqCst), 1 + 1 + RANGE_RETRY_DELAYS_MS.len());
    }
}
