//! Bounded JSONL transport. Oversized input is fatal: never interpret its suffix as a new request.
use std::io::{self, BufRead, Write};
use serde_json::Value;

// 8 MiB source may expand sixfold when JSON escaped. Includes protocol overhead.
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
pub const REQUEST_QUEUE_CAPACITY: usize = 2;

pub fn read_frame(reader: &mut impl BufRead, limit: usize) -> io::Result<Option<String>> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if bytes.is_empty() { Ok(None) } else { decode(bytes).map(Some) };
        }
        let newline = available.iter().position(|&b| b == b'\n');
        let count = newline.unwrap_or(available.len());
        if count > limit.saturating_sub(bytes.len()) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "JSONL frame exceeds byte limit"));
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count + usize::from(newline.is_some()));
        if newline.is_some() {
            return decode(bytes).map(Some);
        }
    }
}

fn decode(bytes: Vec<u8>) -> io::Result<String> {
    String::from_utf8(bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

struct BoundedBuffer {
    bytes: Vec<u8>,
    limit: usize,
}
impl Write for BoundedBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "JSONL response exceeds byte limit"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}

/// Serialize before touching stdout, so an oversized response cannot corrupt the stream.
pub fn encode_frame(value: &Value, limit: usize) -> io::Result<Vec<u8>> {
    let mut buffer = BoundedBuffer { bytes: Vec::new(), limit };
    serde_json::to_writer(&mut buffer, value).map_err(io::Error::other)?;
    buffer.bytes.push(b'\n');
    Ok(buffer.bytes)
}

pub fn write_frame(out: &mut impl Write, value: &Value) -> io::Result<()> {
    let bytes = match encode_frame(value, MAX_FRAME_BYTES) {
        Ok(bytes) => bytes,
        Err(_) => encode_frame(&serde_json::json!({
            "id": value.get("id").cloned().unwrap_or(Value::Null),
            "ok": false,
            "error": { "code": "RESPONSE_TOO_LARGE", "message": "Response exceeds transport budget; narrow the query" }
        }), MAX_FRAME_BYTES)?,
    };
    out.write_all(&bytes)?;
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    #[test]
    fn accepts_boundary_crlf_and_unterminated_final_frame() {
        let mut input = Cursor::new(b"abcd\nx\r\nlast".to_vec());
        assert_eq!(read_frame(&mut input, 4).unwrap().as_deref(), Some("abcd"));
        assert_eq!(read_frame(&mut input, 4).unwrap().as_deref(), Some("x\r"));
        assert_eq!(read_frame(&mut input, 4).unwrap().as_deref(), Some("last"));
        assert!(read_frame(&mut input, 4).unwrap().is_none());
    }

    #[test]
    fn rejects_overlong_frame_across_small_buffers() {
        let mut input = BufReader::with_capacity(2, Cursor::new(b"abcde\n{}\n"));
        assert_eq!(read_frame(&mut input, 4).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn rejects_invalid_utf8_and_counts_bytes_not_characters() {
        assert!(read_frame(&mut Cursor::new(vec![0xff, b'\n']), 4).is_err());
        assert!(read_frame(&mut Cursor::new("猫\n".as_bytes()), 2).is_err());
        assert_eq!(read_frame(&mut Cursor::new("猫\n".as_bytes()), 3).unwrap().as_deref(), Some("猫"));
    }

    #[test]
    fn bounded_serialization_never_writes_partial_frame() {
        let value = serde_json::json!({"text": "\u{0000}".repeat(20)});
        assert!(encode_frame(&value, 30).is_err());
        let small = serde_json::json!({"ok":true});
        let bytes = encode_frame(&small, 11).unwrap();
        assert_eq!(bytes, b"{\"ok\":true}\n");
        assert!(encode_frame(&small, 10).is_err());
    }
}