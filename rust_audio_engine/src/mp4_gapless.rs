//! AAC in MP4/M4A: read the encoder priming and padding that the container stores,
//! so tracks of a continuous album join without the ~23-48 ms of priming at each start.
//!
//! The MP4 demuxer we use parses the edit list but never applies it, and does not
//! report the iTunes `iTunSMPB` tag either, so the decoder would emit the AAC priming
//! frames (1024 for most encoders, 2112 for iTunes) as part of the song.
//!
//! Two sources, in order of preference:
//! 1. `iTunSMPB` freeform tag (`moov/udta/meta/ilst/----`): " 00000000 <delay> <padding> <length> ..."
//! 2. Edit list of the sound track (`moov/trak/edts/elst`): first entry's `media_time` is the
//!    priming in media timescale, `segment_duration` (movie timescale) the playable length.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Frames to drop at the start, and the playable length in frames when the file says so.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mp4Gapless {
    pub delay: u64,
    pub valid_frames: Option<u64>,
    /// How far `valid_frames` can be off from rounding (edit lists are often in milliseconds).
    pub tolerance: u64,
}

/// A `moov` larger than this is not a music file we should be walking.
const MAX_MOOV: u64 = 64 * 1024 * 1024;

/// Read the gapless info of a local MP4/M4A file. `sample_rate` converts edit-list times.
/// Returns `None` when the file has none (or isn't MP4), so callers keep their current behaviour.
pub fn read_file(path: &Path, sample_rate: u32) -> Option<Mp4Gapless> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut pos = 0u64;
    while pos + 8 <= len {
        f.seek(SeekFrom::Start(pos)).ok()?;
        let (kind, size, header) = read_header(&mut f, len - pos)?;
        if &kind == b"moov" {
            if size > MAX_MOOV { return None; }
            let mut body = vec![0u8; (size - header) as usize];
            f.read_exact(&mut body).ok()?;
            return parse_moov(&body, sample_rate);
        }
        pos += size;
    }
    None
}

fn read_header<R: Read>(r: &mut R, remaining: u64) -> Option<([u8; 4], u64, u64)> {
    let mut h = [0u8; 8];
    r.read_exact(&mut h).ok()?;
    let mut size = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as u64;
    let kind = [h[4], h[5], h[6], h[7]];
    let mut header = 8;
    if size == 1 {
        let mut ext = [0u8; 8];
        r.read_exact(&mut ext).ok()?;
        size = u64::from_be_bytes(ext);
        header = 16;
    } else if size == 0 {
        size = remaining;
    }
    if size < header || size > remaining { return None; }
    Some((kind, size, header))
}

/// Child boxes of a container body: (type, body).
fn children(buf: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = Vec::new();
    let mut p = 0usize;
    while p + 8 <= buf.len() {
        let mut size = u32::from_be_bytes([buf[p], buf[p + 1], buf[p + 2], buf[p + 3]]) as usize;
        let kind = [buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]];
        let mut header = 8;
        if size == 1 {
            if p + 16 > buf.len() { break; }
            size = u64::from_be_bytes(buf[p + 8..p + 16].try_into().unwrap()) as usize;
            header = 16;
        } else if size == 0 {
            size = buf.len() - p;
        }
        if size < header || p + size > buf.len() { break; }
        out.push((kind, &buf[p + header..p + size]));
        p += size;
    }
    out
}

fn child<'a>(buf: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    children(buf).into_iter().find(|(k, _)| k == kind).map(|(_, b)| b)
}

fn be_u32(b: &[u8], at: usize) -> Option<u64> {
    b.get(at..at + 4).map(|s| u32::from_be_bytes(s.try_into().unwrap()) as u64)
}
fn be_u64(b: &[u8], at: usize) -> Option<u64> {
    b.get(at..at + 8).map(|s| u64::from_be_bytes(s.try_into().unwrap()))
}

/// (timescale) of mvhd/mdhd: version 0 has 32-bit times, version 1 64-bit.
fn timescale(full_box: &[u8]) -> Option<u64> {
    match *full_box.first()? {
        0 => be_u32(full_box, 12),
        1 => be_u32(full_box, 20),
        _ => None,
    }
}

pub(crate) fn parse_moov(moov: &[u8], sample_rate: u32) -> Option<Mp4Gapless> {
    if let Some(g) = itunsmpb(moov) { return Some(g); }

    let movie_scale = child(moov, b"mvhd").and_then(timescale)?;
    for (kind, trak) in children(moov) {
        if &kind != b"trak" { continue; }
        let Some(mdia) = child(trak, b"mdia") else { continue };
        let is_sound = child(mdia, b"hdlr").and_then(|h| h.get(8..12)).map_or(false, |t| t == b"soun");
        if !is_sound { continue; }
        let media_scale = child(mdia, b"mdhd").and_then(timescale)?;
        let elst = child(trak, b"edts").and_then(|e| child(e, b"elst"))?;
        let version = *elst.first()?;
        let count = be_u32(elst, 4)?;
        // An empty edit (media_time -1) first means "start later": not priming, leave it alone.
        let (segment, media_time) = match version {
            0 => (be_u32(elst, 8)?, be_u32(elst, 12)? as u32 as i32 as i64),
            1 => (be_u64(elst, 8)?, be_u64(elst, 16)? as i64),
            _ => return None,
        };
        if count == 0 || media_time <= 0 || movie_scale == 0 || media_scale == 0 { return None; }
        let sr = sample_rate as u128;
        let delay = (media_time as u128 * sr / media_scale as u128) as u64;
        let valid = if segment > 0 { Some((segment as u128 * sr / movie_scale as u128) as u64) } else { None };
        let tolerance = (sr / movie_scale as u128) as u64 + 1;
        return Some(Mp4Gapless { delay, valid_frames: valid, tolerance });
    }
    None
}

/// `moov/udta/meta/ilst/----` with name `iTunSMPB`.
fn itunsmpb(moov: &[u8]) -> Option<Mp4Gapless> {
    let meta = child(child(moov, b"udta")?, b"meta")?;
    // meta is a full box (4 bytes version/flags) in iTunes files; some writers omit them.
    let ilst = child(meta.get(4..)?, b"ilst").or_else(|| child(meta, b"ilst"))?;
    for (kind, item) in children(ilst) {
        if &kind != b"----" { continue; }
        let parts = children(item);
        let name = parts.iter().find(|(k, _)| k == b"name").and_then(|(_, b)| b.get(4..));
        if name != Some(&b"iTunSMPB"[..]) { continue; }
        let data = parts.iter().find(|(k, _)| k == b"data").and_then(|(_, b)| b.get(8..))?;
        return parse_smpb(std::str::from_utf8(data).ok()?);
    }
    None
}

fn parse_smpb(text: &str) -> Option<Mp4Gapless> {
    let f: Vec<u64> = text.split_whitespace().take(4).map(|s| u64::from_str_radix(s, 16).ok()).collect::<Option<_>>()?;
    if f.len() < 4 { return None; }
    let (delay, length) = (f[1], f[3]);
    if delay == 0 && length == 0 { return None; }
    Some(Mp4Gapless { delay, valid_frames: if length > 0 { Some(length) } else { None }, tolerance: 0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(body);
        v
    }
    fn mvhd(scale: u32) -> Vec<u8> {
        let mut b = vec![0u8; 100];
        b[12..16].copy_from_slice(&scale.to_be_bytes());
        bx(b"mvhd", &b)
    }
    fn trak(handler: &[u8; 4], media_scale: u32, segment: u32, media_time: i32) -> Vec<u8> {
        let mut hdlr = vec![0u8; 24];
        hdlr[8..12].copy_from_slice(handler);
        let mut mdhd = vec![0u8; 24];
        mdhd[12..16].copy_from_slice(&media_scale.to_be_bytes());
        let mut elst = vec![0u8; 8];
        elst[4..8].copy_from_slice(&1u32.to_be_bytes());
        elst.extend_from_slice(&segment.to_be_bytes());
        elst.extend_from_slice(&(media_time as u32).to_be_bytes());
        elst.extend_from_slice(&[0, 1, 0, 0]);
        let mdia = [bx(b"hdlr", &hdlr), bx(b"mdhd", &mdhd)].concat();
        bx(b"trak", &[bx(b"edts", &bx(b"elst", &elst)), bx(b"mdia", &mdia)].concat())
    }

    #[test]
    fn edit_list_priming_of_the_sound_track() {
        // movie timescale 1000, media 44100: 1024 frames priming, 1.234 s playable
        let moov = [mvhd(1000), trak(b"vide", 90000, 5000, 3000), trak(b"soun", 44100, 1234, 1024)].concat();
        let g = parse_moov(&moov, 44100).unwrap();
        assert_eq!(g, Mp4Gapless { delay: 1024, valid_frames: Some(54419), tolerance: 45 });
    }

    #[test]
    fn empty_edit_or_no_priming_is_left_alone() {
        assert_eq!(parse_moov(&[mvhd(1000), trak(b"soun", 44100, 1000, -1)].concat(), 44100), None);
        assert_eq!(parse_moov(&[mvhd(1000), trak(b"soun", 44100, 1000, 0)].concat(), 44100), None);
    }

    #[test]
    fn itunes_smpb_wins_over_edit_list() {
        let smpb = b" 00000000 00000840 000001C0 00000000000D4E40 00000000 00000000";
        let mut data = vec![0u8; 8];
        data.extend_from_slice(smpb);
        let mut name = vec![0u8; 4];
        name.extend_from_slice(b"iTunSMPB");
        let item = bx(b"----", &[bx(b"mean", b"\0\0\0\0com.apple.iTunes"), bx(b"name", &name), bx(b"data", &data)].concat());
        let meta = bx(b"meta", &[vec![0u8; 4], bx(b"ilst", &item)].concat());
        let moov = [mvhd(1000), trak(b"soun", 44100, 1234, 1024), bx(b"udta", &meta)].concat();
        assert_eq!(parse_moov(&moov, 44100), Some(Mp4Gapless { delay: 2112, valid_frames: Some(0xD4E40), tolerance: 0 }));
    }

    #[test]
    fn malformed_boxes_do_not_panic() {
        assert_eq!(parse_moov(&[0, 0, 0, 200, b'm', b'v', b'h', b'd'], 44100), None);
        assert_eq!(parse_moov(&[], 44100), None);
        assert_eq!(parse_smpb("zz 1 2"), None);
    }
}
