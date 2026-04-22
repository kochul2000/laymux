use std::collections::VecDeque;
use std::time::Instant;

const DEFAULT_MAX_SIZE: usize = 1024 * 1024; // 1MB

pub struct TerminalOutputBuffer {
    buffer: VecDeque<u8>,
    max_size: usize,
    /// Timestamp of the last push (used for output activity detection).
    pub last_output_at: Option<Instant>,
    /// Monotonically increasing byte counter (total bytes ever pushed).
    /// Unlike `len()`, this never decreases when the ring buffer wraps.
    write_seq: u64,
}

impl TerminalOutputBuffer {
    pub fn new(max_size: usize) -> Self {
        Self {
            buffer: VecDeque::with_capacity(max_size.min(8192)),
            max_size,
            last_output_at: None,
            write_seq: 0,
        }
    }

    pub fn push(&mut self, data: &[u8]) {
        self.last_output_at = Some(Instant::now());
        self.write_seq += data.len() as u64;

        if data.len() >= self.max_size {
            // Data larger than buffer: keep only the tail
            self.buffer.clear();
            let start = data.len() - self.max_size;
            self.buffer.extend(&data[start..]);
            return;
        }

        let new_len = self.buffer.len() + data.len();
        if new_len > self.max_size {
            let to_remove = new_len - self.max_size;
            self.buffer.drain(..to_remove);
        }
        self.buffer.extend(data);
    }

    pub fn recent_lines(&self, n: usize) -> String {
        if self.buffer.is_empty() || n == 0 {
            return String::new();
        }

        let bytes: Vec<u8> = self.buffer.iter().copied().collect();
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.lines().collect();

        if lines.len() <= n {
            lines.join("\n")
        } else {
            lines[lines.len() - n..].join("\n")
        }
    }

    pub fn recent_bytes(&self, n: usize) -> Vec<u8> {
        if n >= self.buffer.len() {
            self.buffer.iter().copied().collect()
        } else {
            let start = self.buffer.len() - n;
            self.buffer.iter().skip(start).copied().collect()
        }
    }

    /// Monotonically increasing sequence number (total bytes ever pushed).
    pub fn write_seq(&self) -> u64 {
        self.write_seq
    }

    /// Return bytes written since `since_seq`, clamped to what the buffer still holds.
    pub fn bytes_since(&self, since_seq: u64) -> Vec<u8> {
        let new_bytes = self.write_seq.saturating_sub(since_seq) as usize;
        if new_bytes == 0 {
            return Vec::new();
        }
        // If more bytes arrived than the buffer can hold, return everything we have
        let available = new_bytes.min(self.buffer.len());
        self.recent_bytes(available)
    }

    pub fn clear(&mut self) {
        self.buffer.clear();
    }

    pub fn len(&self) -> usize {
        self.buffer.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }
}

impl Default for TerminalOutputBuffer {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_SIZE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_buffer_is_empty() {
        let buf = TerminalOutputBuffer::new(1024);
        assert!(buf.is_empty());
        assert_eq!(buf.len(), 0);
    }

    #[test]
    fn push_stores_data() {
        let mut buf = TerminalOutputBuffer::new(1024);
        buf.push(b"hello");
        assert_eq!(buf.len(), 5);
        assert_eq!(buf.recent_bytes(5), b"hello");
    }

    #[test]
    fn push_evicts_oldest_when_full() {
        let mut buf = TerminalOutputBuffer::new(10);
        buf.push(b"abcdefgh"); // 8 bytes
        buf.push(b"ijklm"); // 5 bytes, total 13 > 10
        assert_eq!(buf.len(), 10);
        // oldest 3 bytes evicted: "abc" gone, "defghijklm" remains
        assert_eq!(buf.recent_bytes(10), b"defghijklm");
    }

    #[test]
    fn push_data_larger_than_capacity() {
        let mut buf = TerminalOutputBuffer::new(5);
        buf.push(b"abcdefghij"); // 10 bytes > capacity 5
        assert_eq!(buf.len(), 5);
        assert_eq!(buf.recent_bytes(5), b"fghij");
    }

    #[test]
    fn recent_lines_returns_last_n() {
        let mut buf = TerminalOutputBuffer::new(1024);
        buf.push(b"line1\nline2\nline3\nline4\nline5");
        assert_eq!(buf.recent_lines(3), "line3\nline4\nline5");
    }

    #[test]
    fn recent_lines_fewer_than_n() {
        let mut buf = TerminalOutputBuffer::new(1024);
        buf.push(b"line1\nline2");
        assert_eq!(buf.recent_lines(10), "line1\nline2");
    }

    #[test]
    fn recent_lines_zero_returns_empty() {
        let mut buf = TerminalOutputBuffer::new(1024);
        buf.push(b"hello");
        assert_eq!(buf.recent_lines(0), "");
    }

    #[test]
    fn recent_lines_empty_buffer() {
        let buf = TerminalOutputBuffer::new(1024);
        assert_eq!(buf.recent_lines(5), "");
    }

    #[test]
    fn recent_bytes_more_than_available() {
        let mut buf = TerminalOutputBuffer::new(1024);
        buf.push(b"abc");
        assert_eq!(buf.recent_bytes(100), b"abc");
    }

    #[test]
    fn clear_empties_buffer() {
        let mut buf = TerminalOutputBuffer::new(1024);
        buf.push(b"data");
        buf.clear();
        assert!(buf.is_empty());
        assert_eq!(buf.len(), 0);
    }

    #[test]
    fn default_uses_1mb() {
        let buf = TerminalOutputBuffer::default();
        assert_eq!(buf.max_size, 1024 * 1024);
    }

    #[test]
    fn multiple_pushes_accumulate() {
        let mut buf = TerminalOutputBuffer::new(1024);
        buf.push(b"aaa");
        buf.push(b"bbb");
        buf.push(b"ccc");
        assert_eq!(buf.len(), 9);
        assert_eq!(buf.recent_bytes(9), b"aaabbbccc");
    }

    #[test]
    fn write_seq_increases_monotonically() {
        let mut buf = TerminalOutputBuffer::new(1024);
        assert_eq!(buf.write_seq(), 0);
        buf.push(b"hello"); // 5 bytes
        assert_eq!(buf.write_seq(), 5);
        buf.push(b"world"); // 5 bytes
        assert_eq!(buf.write_seq(), 10);
    }

    #[test]
    fn write_seq_survives_ring_buffer_wrap() {
        let mut buf = TerminalOutputBuffer::new(10);
        buf.push(b"abcdefgh"); // 8 bytes, seq=8
        assert_eq!(buf.write_seq(), 8);
        buf.push(b"ijklmnop"); // 8 bytes, total 16 > 10 cap, evicts oldest
        assert_eq!(buf.write_seq(), 16);
        // len is capped but seq keeps growing
        assert_eq!(buf.len(), 10);
    }

    #[test]
    fn bytes_since_returns_new_data() {
        let mut buf = TerminalOutputBuffer::new(1024);
        buf.push(b"before");
        let seq = buf.write_seq(); // 6
        buf.push(b"after");
        let new = buf.bytes_since(seq);
        assert_eq!(new, b"after");
    }

    #[test]
    fn bytes_since_after_wrap_returns_available() {
        let mut buf = TerminalOutputBuffer::new(10);
        buf.push(b"12345"); // seq=5, len=5
        let seq = buf.write_seq();
        buf.push(b"67890abcde"); // seq=15, len=10, buffer="0abcde" wait...
                                 // 15 bytes total pushed into 10 cap buffer
                                 // new_bytes = 15 - 5 = 10, but buffer only holds 10
        let new = buf.bytes_since(seq);
        // Should get min(10, 10) = 10 bytes (everything in buffer)
        assert_eq!(new.len(), 10);
    }

    #[test]
    fn bytes_since_zero_when_no_new_data() {
        let mut buf = TerminalOutputBuffer::new(1024);
        buf.push(b"data");
        let seq = buf.write_seq();
        let new = buf.bytes_since(seq);
        assert!(new.is_empty());
    }
}
