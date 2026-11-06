//! Newline-delimited JSON: one compact JSON-RPC message per line, in both directions.
//!
//! [`FrameCodec`] is a `tokio_util` codec. Use it with `FramedRead` and `FramedWrite`, then parse
//! each frame with [`Message::from_frame`](crate::jsonrpc::Message::from_frame):
//!
//! - A frame that is not UTF-8 JSON, or not JSON-RPC, is not a codec error. `from_frame` returns
//!   the error response to send, and the connection stays open.
//! - A frame longer than the limit is [`FrameError::TooLarge`], after which the codec yields
//!   nothing more. Close the connection.
//!
//! Frames end with `\n`. A `\r` before it is dropped, empty lines are skipped, and a last line
//! without a newline still counts at the end of the stream. The limit leaves out the line ending,
//! whether it is `\n` or `\r\n`.
//!
//! It splits lines like `tokio_util`'s `LinesCodec::new_with_max_length`, which 0007 names, but
//! yields bytes instead of strings. `LinesCodec` fails the stream on a line that is not UTF-8,
//! which would close the connection instead of answering that line with a parse error.

use std::error::Error;
use std::{fmt, io};

use bytes::{BufMut, Bytes, BytesMut};
use serde::Serialize;
use tokio_util::codec::{Decoder, Encoder};

/// The largest frame either side sends or accepts: 8 MiB, not counting the line ending.
///
/// Diffs, logs, and files that could be larger come through paged methods.
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Splits a byte stream into frames and writes messages as frames.
#[derive(Clone, Debug)]
pub struct FrameCodec {
    max_frame_bytes: usize,
    next_index: usize,
    too_large: bool,
}

impl FrameCodec {
    /// A codec with the protocol's limit, [`MAX_FRAME_BYTES`].
    #[must_use]
    pub fn new() -> Self {
        Self::with_max_frame_bytes(MAX_FRAME_BYTES)
    }

    /// A codec with another limit, in bytes, not counting the line ending.
    #[must_use]
    pub fn with_max_frame_bytes(max_frame_bytes: usize) -> Self {
        Self {
            max_frame_bytes,
            next_index: 0,
            too_large: false,
        }
    }

    /// The limit, in bytes, not counting the line ending.
    #[must_use]
    pub fn max_frame_bytes(&self) -> usize {
        self.max_frame_bytes
    }

    fn too_large(&mut self) -> FrameError {
        self.too_large = true;
        FrameError::TooLarge {
            max_frame_bytes: self.max_frame_bytes,
        }
    }
}

impl Default for FrameCodec {
    fn default() -> Self {
        Self::new()
    }
}

impl Decoder for FrameCodec {
    type Item = Bytes;
    type Error = FrameError;

    fn decode(&mut self, buf: &mut BytesMut) -> Result<Option<Bytes>, FrameError> {
        let max = self.max_frame_bytes;
        loop {
            if self.too_large {
                return Err(self.too_large());
            }
            // The limit leaves out the line ending, so the `\r` of a `\r\n` may sit just past it.
            let search_end = buf.len().min(max.saturating_add(2));
            let newline = buf[self.next_index..search_end]
                .iter()
                .position(|&byte| byte == b'\n');
            let Some(offset) = newline else {
                let past_limit =
                    buf.len() > max.saturating_add(1) || (buf.len() > max && buf[max] != b'\r');
                if past_limit {
                    return Err(self.too_large());
                }
                self.next_index = buf.len();
                return Ok(None);
            };
            let mut line = buf.split_to(self.next_index + offset + 1);
            self.next_index = 0;
            line.truncate(line.len() - 1);
            if line.last() == Some(&b'\r') {
                line.truncate(line.len() - 1);
            }
            if line.len() > max {
                return Err(self.too_large());
            }
            if !line.is_empty() {
                return Ok(Some(line.freeze()));
            }
        }
    }

    fn decode_eof(&mut self, buf: &mut BytesMut) -> Result<Option<Bytes>, FrameError> {
        if let Some(frame) = self.decode(buf)? {
            return Ok(Some(frame));
        }
        self.next_index = 0;
        let mut line = buf.split();
        if line.last() == Some(&b'\r') {
            line.truncate(line.len() - 1);
        }
        Ok((!line.is_empty()).then(|| line.freeze()))
    }
}

impl<T: Serialize> Encoder<T> for FrameCodec {
    type Error = FrameError;

    fn encode(&mut self, message: T, buf: &mut BytesMut) -> Result<(), FrameError> {
        let start = buf.len();
        let mut frame = LimitedWriter {
            buf: &mut *buf,
            remaining: self.max_frame_bytes,
            too_large: false,
        };
        let result = serde_json::to_writer(&mut frame, &message);
        let too_large = frame.too_large;
        if let Err(error) = result {
            buf.truncate(start);
            return Err(if too_large {
                FrameError::TooLarge {
                    max_frame_bytes: self.max_frame_bytes,
                }
            } else {
                FrameError::Serialize(error)
            });
        }
        buf.put_u8(b'\n');
        Ok(())
    }
}

// Fails the first write that would take the frame past the limit, which stops serde_json there,
// so an oversized message is never written out in full.
struct LimitedWriter<'a> {
    buf: &'a mut BytesMut,
    remaining: usize,
    too_large: bool,
}

impl io::Write for LimitedWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.remaining {
            self.too_large = true;
            return Err(io::Error::other("frame too large"));
        }
        self.remaining -= bytes.len();
        self.buf.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Why a frame could not be read or written.
#[derive(Debug)]
pub enum FrameError {
    /// A frame is longer than the limit. When reading, the connection must close.
    TooLarge {
        /// The limit, in bytes, not counting the line ending.
        max_frame_bytes: usize,
    },
    /// A message could not be serialized.
    Serialize(serde_json::Error),
    /// Reading or writing the stream failed.
    Io(io::Error),
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { max_frame_bytes } => {
                write!(f, "frame exceeds the limit of {max_frame_bytes} bytes")
            }
            Self::Serialize(error) => write!(f, "could not serialize a message: {error}"),
            Self::Io(error) => write!(f, "{error}"),
        }
    }
}

impl Error for FrameError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::TooLarge { .. } => None,
            Self::Serialize(error) => Some(error),
            Self::Io(error) => Some(error),
        }
    }
}

impl From<io::Error> for FrameError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use bytes::{Bytes, BytesMut};
    use serde::ser::SerializeSeq;
    use serde::{Serialize, Serializer};
    use serde_json::json;
    use tokio_util::codec::{Decoder, Encoder};

    use super::{FrameCodec, FrameError};

    fn decode_all(codec: &mut FrameCodec, buf: &mut BytesMut) -> Vec<Bytes> {
        let mut frames = Vec::new();
        while let Some(frame) = codec.decode(buf).unwrap() {
            frames.push(frame);
        }
        frames
    }

    /// Frames split across reads, several in one read, CRLF and blank lines, and a last line
    /// with no newline at the end of the stream all come out whole and in order.
    #[test]
    fn frames_come_out_whole_however_the_reads_split_them() {
        let mut codec = FrameCodec::new();
        let mut buf = BytesMut::new();
        for chunk in [&b"{\"jsonrpc\":"[..], b"\"2.0\",", b"\"method\":\"a\"}"] {
            buf.extend_from_slice(chunk);
            assert_eq!(codec.decode(&mut buf).unwrap(), None);
        }
        buf.extend_from_slice(b"\n{\"b\":2}\r\n\n\r\n{\"c\":3}\n{\"d\":4}\r");
        assert_eq!(
            decode_all(&mut codec, &mut buf),
            [
                Bytes::from_static(b"{\"jsonrpc\":\"2.0\",\"method\":\"a\"}"),
                Bytes::from_static(b"{\"b\":2}"),
                Bytes::from_static(b"{\"c\":3}"),
            ]
        );
        assert_eq!(
            codec.decode_eof(&mut buf).unwrap(),
            Some(Bytes::from_static(b"{\"d\":4}"))
        );
        assert_eq!(codec.decode_eof(&mut buf).unwrap(), None);
    }

    /// The limit counts a frame without its line ending, fails as soon as a frame passes it
    /// (before its newline arrives), and nothing decodes after that.
    #[test]
    fn a_frame_over_the_limit_fails_early_and_for_good() {
        for (input, frame) in [
            (&b"12345678\r\n"[..], &b"12345678"[..]),
            (b"12345678\n", b"12345678"),
            (b"1234567\r\r\n", b"1234567\r"),
        ] {
            let mut codec = FrameCodec::with_max_frame_bytes(8);
            let mut buf = BytesMut::from(input);
            assert_eq!(codec.decode(&mut buf).unwrap().as_deref(), Some(frame));
        }
        for input in [
            &b"123456789\r\n"[..],
            b"123456789\n",
            b"12345678\r\r\n",
            b"12345678\rx",
        ] {
            let mut codec = FrameCodec::with_max_frame_bytes(8);
            let mut buf = BytesMut::from(input);
            assert!(
                matches!(codec.decode(&mut buf), Err(FrameError::TooLarge { .. })),
                "{input:?}"
            );
        }

        let mut codec = FrameCodec::with_max_frame_bytes(8);
        let mut buf = BytesMut::from(&b"12345678\r"[..]);
        assert_eq!(codec.decode(&mut buf).unwrap(), None);
        buf.extend_from_slice(b"\n");
        assert_eq!(
            codec.decode(&mut buf).unwrap(),
            Some(Bytes::from_static(b"12345678")),
            "a CRLF split across reads at the limit"
        );

        let mut codec = FrameCodec::with_max_frame_bytes(8);
        let mut buf = BytesMut::from(&b"{}\n123456789\n{}\n"[..]);
        assert_eq!(
            codec.decode(&mut buf).unwrap(),
            Some(Bytes::from_static(b"{}"))
        );
        assert!(matches!(
            codec.decode(&mut buf),
            Err(FrameError::TooLarge { max_frame_bytes: 8 })
        ));
        assert!(
            matches!(codec.decode(&mut buf), Err(FrameError::TooLarge { .. })),
            "nothing is decoded after an oversized frame"
        );
    }

    /// A message encodes as compact JSON and one newline. One over the limit writes nothing and
    /// stops serializing as soon as it passes the limit.
    #[test]
    fn encoding_writes_one_line_and_nothing_over_the_limit() {
        struct Endless<'a>(&'a Cell<usize>);

        impl Serialize for Endless<'_> {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let mut sequence = serializer.serialize_seq(None)?;
                for _ in 0..1_000_000 {
                    self.0.set(self.0.get() + 1);
                    sequence.serialize_element("x")?;
                }
                sequence.end()
            }
        }

        let mut codec = FrameCodec::new();
        let mut buf = BytesMut::new();
        codec
            .encode(json!({"text": "two\nlines", "n": [1, 2]}), &mut buf)
            .unwrap();
        assert_eq!(&buf[..], b"{\"n\":[1,2],\"text\":\"two\\nlines\"}\n");

        let mut codec = FrameCodec::with_max_frame_bytes(8);
        let mut buf = BytesMut::from(&b"{}\n"[..]);
        assert!(matches!(
            codec.encode("1234567", &mut buf),
            Err(FrameError::TooLarge { max_frame_bytes: 8 })
        ));
        assert_eq!(&buf[..], b"{}\n");
        codec.encode("123456", &mut buf).unwrap();
        assert_eq!(&buf[..], b"{}\n\"123456\"\n");

        let serialized = Cell::new(0);
        let mut codec = FrameCodec::with_max_frame_bytes(64);
        let mut buf = BytesMut::new();
        assert!(matches!(
            codec.encode(Endless(&serialized), &mut buf),
            Err(FrameError::TooLarge { .. })
        ));
        assert!(buf.is_empty());
        assert!(serialized.get() < 32, "{} elements", serialized.get());
    }
}
