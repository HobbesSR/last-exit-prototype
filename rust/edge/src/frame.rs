//! The framing both the client stream and the link use: a `u32` big-endian length of what follows, a `u8`
//! (the text/binary flag, or the link frame type), then the body (docs/24.5 "Stage 1's contracts").

/// Flag for a UTF-8 text message.
pub const TEXT: u8 = 0;
/// Flag for a binary message.
pub const BINARY: u8 = 1;

/// The link's frame types (docs/24.5 "The link"). `tests/edge-contract.test.js` holds Node's `FRAME` and 24.5's
/// table to exactly this list.
pub mod link {
    pub const EDGE: u8 = 0x01;
    pub const OPEN: u8 = 0x02;
    pub const MESSAGE: u8 = 0x03;
    pub const WRITTEN: u8 = 0x04;
    pub const CLOSED: u8 = 0x05;
    pub const ACCEPT: u8 = 0x81;
    pub const DELIVER: u8 = 0x82;
    pub const CLOSE: u8 = 0x83;
}

/// Encodes one frame whose body is the concatenation of `parts`.
pub fn encode(kind: u8, parts: &[&[u8]]) -> Vec<u8> {
    let body: usize = parts.iter().map(|part| part.len()).sum();
    let mut out = Vec::with_capacity(5 + body);
    out.extend_from_slice(&((body + 1) as u32).to_be_bytes());
    out.push(kind);
    for part in parts {
        out.extend_from_slice(part);
    }
    out
}

/// Why a frame could not be decoded.
#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    /// The length field was zero, so there is no type byte.
    Empty,
    /// The body is longer than the decoder's limit.
    TooLarge,
}

/// Rebuilds frames from the pieces a stream delivers.
pub struct Decoder {
    buf: Vec<u8>,
    start: usize,
    max_body: usize,
}

impl Decoder {
    /// A decoder that refuses a body longer than `max_body` bytes, as soon as its header is seen.
    pub fn new(max_body: usize) -> Self {
        Decoder {
            buf: Vec::new(),
            start: 0,
            max_body,
        }
    }

    /// Adds bytes read from the stream.
    pub fn push(&mut self, bytes: &[u8]) {
        if self.start == self.buf.len() {
            self.buf.clear();
            self.start = 0;
        } else if self.start > 1 << 16 {
            self.buf.drain(..self.start);
            self.start = 0;
        }
        self.buf.extend_from_slice(bytes);
    }

    /// The next whole frame as its type byte and body, or `None` when more bytes are needed.
    pub fn next_frame(&mut self) -> Result<Option<(u8, Vec<u8>)>, FrameError> {
        let pending = &self.buf[self.start..];
        if pending.len() < 4 {
            return Ok(None);
        }
        let len = u32::from_be_bytes([pending[0], pending[1], pending[2], pending[3]]) as usize;
        if len == 0 {
            return Err(FrameError::Empty);
        }
        if len - 1 > self.max_body {
            return Err(FrameError::TooLarge);
        }
        if pending.len() < 4 + len {
            return Ok(None);
        }
        let kind = pending[4];
        let body = pending[5..4 + len].to_vec();
        self.start += 4 + len;
        Ok(Some((kind, body)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_frame() {
        let bytes = encode(BINARY, &[b"ab", b"cd"]);
        assert_eq!(bytes, [0, 0, 0, 5, 1, b'a', b'b', b'c', b'd']);
        let mut decoder = Decoder::new(16);
        decoder.push(&bytes);
        assert_eq!(decoder.next_frame(), Ok(Some((BINARY, b"abcd".to_vec()))));
        assert_eq!(decoder.next_frame(), Ok(None));
    }

    #[test]
    fn waits_for_partial_frames_and_splits_joined_ones() {
        let mut bytes = encode(TEXT, &[b"hello"]);
        bytes.extend(encode(TEXT, &[b""]));
        let mut decoder = Decoder::new(16);
        for byte in &bytes[..8] {
            decoder.push(&[*byte]);
            assert_eq!(decoder.next_frame(), Ok(None));
        }
        decoder.push(&bytes[8..]);
        assert_eq!(decoder.next_frame(), Ok(Some((TEXT, b"hello".to_vec()))));
        assert_eq!(decoder.next_frame(), Ok(Some((TEXT, Vec::new()))));
        assert_eq!(decoder.next_frame(), Ok(None));
    }

    #[test]
    fn refuses_empty_and_oversize_frames() {
        let mut decoder = Decoder::new(3);
        decoder.push(&[0, 0, 0, 0]);
        assert_eq!(decoder.next_frame(), Err(FrameError::Empty));
        let mut decoder = Decoder::new(3);
        // The header alone is enough to refuse a 4-byte body.
        decoder.push(&[0, 0, 0, 5]);
        assert_eq!(decoder.next_frame(), Err(FrameError::TooLarge));
        let mut decoder = Decoder::new(3);
        decoder.push(&encode(TEXT, &[b"abc"]));
        assert!(matches!(decoder.next_frame(), Ok(Some(_))));
    }
}
