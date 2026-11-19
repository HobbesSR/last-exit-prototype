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
    pub const DATAGRAM: u8 = 0x06;
    pub const ACCEPT: u8 = 0x81;
    pub const DELIVER: u8 = 0x82;
    pub const CLOSE: u8 = 0x83;
    /// Node → edge: `u32` session id, then one message to send to that session as datagrams.
    pub const SEND: u8 = 0x84;
}

/// The datagram fragments the edge sends to a client (docs/24.5 "The link").
pub mod datagram {
    /// Each datagram is a `u16` big-endian message number, a `u8` fragment index, a `u8` fragment count, then
    /// the fragment's bytes.
    pub const HEADER: usize = 4;
    /// At most this many message bytes per datagram, so a datagram is at most 1,104 bytes. That fits the
    /// smallest WebTransport datagram QUIC allows at its minimum 1,200-byte path MTU (about 1,146 bytes after a
    /// 20-byte connection id, the packet number, the AEAD tag, the DATAGRAM frame header and the session's
    /// quarter stream id), so the limit does not depend on path MTU discovery.
    pub const FRAGMENT_BYTES: usize = 1100;
    /// The most fragments one message may take.
    pub const MAX_FRAGMENTS: usize = 4;
    /// The longest message that can be sent as datagrams; Node streams anything larger.
    pub const MAX_MESSAGE: usize = FRAGMENT_BYTES * MAX_FRAGMENTS;

    /// Splits `message` into numbered datagrams, or `None` when it is empty or longer than [`MAX_MESSAGE`].
    pub fn fragments(number: u16, message: &[u8]) -> Option<Vec<Vec<u8>>> {
        if message.is_empty() || message.len() > MAX_MESSAGE {
            return None;
        }
        let count = message.len().div_ceil(FRAGMENT_BYTES);
        let number = number.to_be_bytes();
        Some(
            message
                .chunks(FRAGMENT_BYTES)
                .enumerate()
                .map(|(index, chunk)| {
                    let mut out = Vec::with_capacity(HEADER + chunk.len());
                    out.extend_from_slice(&number);
                    out.push(index as u8);
                    out.push(count as u8);
                    out.extend_from_slice(chunk);
                    out
                })
                .collect(),
        )
    }
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

    #[test]
    fn fragments_split_by_the_limit() {
        use super::datagram::*;
        assert_eq!(fragments(7, &[1]).unwrap(), vec![vec![0, 7, 0, 1, 1]]);
        assert_eq!(fragments(0, &vec![0; FRAGMENT_BYTES]).unwrap().len(), 1);
        assert_eq!(fragments(0, &vec![0; FRAGMENT_BYTES + 1]).unwrap().len(), 2);
        let message: Vec<u8> = (0..MAX_MESSAGE).map(|i| (i % 251) as u8).collect();
        let parts = fragments(0x0102, &message).unwrap();
        assert_eq!(parts.len(), 4);
        for (index, part) in parts.iter().enumerate() {
            assert_eq!(&part[..4], &[1, 2, index as u8, 4]);
            assert!(part.len() <= HEADER + FRAGMENT_BYTES);
        }
        let joined: Vec<u8> = parts.iter().flat_map(|p| p[4..].to_vec()).collect();
        assert_eq!(joined, message);
        assert!(fragments(0, &vec![0; MAX_MESSAGE + 1]).is_none());
        assert!(fragments(0, &[]).is_none());
    }
}
