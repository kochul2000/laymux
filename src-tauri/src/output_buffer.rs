use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

const DEFAULT_MAX_SIZE: usize = 1024 * 1024; // 1MB

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalOutputSlice {
    pub seq_start: u64,
    pub seq_end: u64,
    pub data: Vec<u8>,
}

/// Cloneable handle to one terminal's sequenced output ring.
///
/// Clones share the same storage. This lets the legacy `output_buffers` table
/// remain a cheap read index while the generation-scoped terminal output
/// session owns the authoritative ring.
#[derive(Clone)]
pub struct TerminalOutputBuffer {
    inner: Arc<Mutex<TerminalOutputBufferInner>>,
}

struct TerminalOutputBufferInner {
    buffer: VecDeque<u8>,
    max_size: usize,
    /// Timestamp of the last push (used for output activity detection).
    last_output_at: Option<Instant>,
    /// Monotonically increasing byte counter (total bytes ever pushed).
    /// Unlike `len()`, this never decreases when the ring buffer wraps.
    write_seq: u64,
}

impl TerminalOutputBuffer {
    pub fn new(max_size: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(TerminalOutputBufferInner {
                buffer: VecDeque::with_capacity(max_size.min(8192)),
                max_size,
                last_output_at: None,
                write_seq: 0,
            })),
        }
    }

    fn lock_inner(&self) -> MutexGuard<'_, TerminalOutputBufferInner> {
        // Output history is diagnostic/recoverable state. If a prior holder
        // panicked, retain the bytes and sequence instead of cascading the
        // poison through every output reader.
        match self.inner.lock() {
            Ok(inner) => inner,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    pub fn same_storage(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    pub fn push(&mut self, data: &[u8]) {
        let _ = self.push_sequenced(data);
    }

    /// Append bytes and capture their exact range under one ring lock.
    pub(crate) fn push_sequenced(&self, data: &[u8]) -> TerminalOutputSlice {
        let mut inner = self.lock_inner();
        let seq_start = inner.write_seq;
        inner.last_output_at = Some(Instant::now());
        inner.write_seq = inner.write_seq.saturating_add(data.len() as u64);

        if data.len() >= inner.max_size {
            // Data larger than buffer: keep only the tail
            inner.buffer.clear();
            let start = data.len() - inner.max_size;
            inner.buffer.extend(&data[start..]);
        } else {
            let new_len = inner.buffer.len() + data.len();
            if new_len > inner.max_size {
                let to_remove = new_len - inner.max_size;
                inner.buffer.drain(..to_remove);
            }
            inner.buffer.extend(data);
        }

        TerminalOutputSlice {
            seq_start,
            seq_end: inner.write_seq,
            data: data.to_vec(),
        }
    }

    pub fn recent_lines(&self, n: usize) -> String {
        let inner = self.lock_inner();
        if inner.buffer.is_empty() || n == 0 {
            return String::new();
        }

        let bytes: Vec<u8> = inner.buffer.iter().copied().collect();
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.lines().collect();

        if lines.len() <= n {
            lines.join("\n")
        } else {
            lines[lines.len() - n..].join("\n")
        }
    }

    pub fn recent_bytes(&self, n: usize) -> Vec<u8> {
        let inner = self.lock_inner();
        recent_bytes_from(&inner, n)
    }

    /// Sequence number of the oldest byte still retained by the ring.
    pub fn start_seq(&self) -> u64 {
        let inner = self.lock_inner();
        start_seq_from(&inner)
    }

    /// Return an exact, sequenced tail snapshot.
    ///
    /// When `max_bytes` truncates retained history, the cut almost always lands
    /// mid-line (or mid escape sequence). Dropping through the first `\n` keeps
    /// the replayed tail starting on a clean line boundary; a tail with no
    /// newline at all is kept as-is rather than returned empty.
    pub fn snapshot(&self, max_bytes: usize) -> TerminalOutputSlice {
        let inner = self.lock_inner();
        let truncated = max_bytes < inner.buffer.len();
        let mut data = recent_bytes_from(&inner, max_bytes);
        if truncated {
            if let Some(newline) = data.iter().position(|&byte| byte == b'\n') {
                data.drain(..=newline);
            }
        }
        let seq_end = inner.write_seq;
        TerminalOutputSlice {
            seq_start: seq_end.saturating_sub(data.len() as u64),
            seq_end,
            data,
        }
    }

    /// Monotonically increasing sequence number (total bytes ever pushed).
    pub fn write_seq(&self) -> u64 {
        self.lock_inner().write_seq
    }

    /// Return bytes written since `since_seq`, clamped to what the buffer still holds.
    pub fn bytes_since(&self, since_seq: u64) -> Vec<u8> {
        let inner = self.lock_inner();
        bytes_since_from(&inner, since_seq)
    }

    /// Return every byte after `since_seq` with its exact sequence range.
    ///
    /// `None` means the caller fell behind the ring and must reattach from a
    /// fresh snapshot. Silently clamping would hide an output gap and could
    /// leave a terminal surface with stale protocol modes.
    pub fn delta_since(&self, since_seq: u64) -> Option<TerminalOutputSlice> {
        let inner = self.lock_inner();
        if since_seq < start_seq_from(&inner) || since_seq > inner.write_seq {
            return None;
        }
        let data = bytes_since_from(&inner, since_seq);
        Some(TerminalOutputSlice {
            seq_start: since_seq,
            seq_end: inner.write_seq,
            data,
        })
    }

    pub fn clear(&mut self) {
        self.lock_inner().buffer.clear();
    }

    pub fn len(&self) -> usize {
        self.lock_inner().buffer.len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock_inner().buffer.is_empty()
    }

    pub fn last_output_at(&self) -> Option<Instant> {
        self.lock_inner().last_output_at
    }

    #[cfg(test)]
    fn max_size(&self) -> usize {
        self.lock_inner().max_size
    }
}

fn recent_bytes_from(inner: &TerminalOutputBufferInner, n: usize) -> Vec<u8> {
    if n >= inner.buffer.len() {
        inner.buffer.iter().copied().collect()
    } else {
        let start = inner.buffer.len() - n;
        inner.buffer.iter().skip(start).copied().collect()
    }
}

fn start_seq_from(inner: &TerminalOutputBufferInner) -> u64 {
    inner.write_seq.saturating_sub(inner.buffer.len() as u64)
}

fn bytes_since_from(inner: &TerminalOutputBufferInner, since_seq: u64) -> Vec<u8> {
    let new_bytes = inner.write_seq.saturating_sub(since_seq) as usize;
    if new_bytes == 0 {
        return Vec::new();
    }
    // If more bytes arrived than the buffer can hold, return everything we have
    let available = new_bytes.min(inner.buffer.len());
    recent_bytes_from(inner, available)
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
        assert_eq!(buf.max_size(), 1024 * 1024);
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

    #[test]
    fn snapshot_reports_the_exact_retained_sequence_range() {
        let mut buf = TerminalOutputBuffer::new(5);
        buf.push(b"abcdefgh");

        let snapshot = buf.snapshot(3);

        assert_eq!(snapshot.seq_start, 5);
        assert_eq!(snapshot.seq_end, 8);
        assert_eq!(snapshot.data, b"fgh");
        assert_eq!(buf.start_seq(), 3);
    }

    #[test]
    fn truncated_snapshot_drops_the_partial_first_line() {
        let mut buf = TerminalOutputBuffer::new(1024);
        buf.push(b"line1\nline2\nline3");

        let snapshot = buf.snapshot(10); // cuts inside "line2"

        assert_eq!(snapshot.data, b"line3");
        assert_eq!(snapshot.seq_end, 17);
        assert_eq!(snapshot.seq_start, 17 - 5);
    }

    #[test]
    fn untruncated_snapshot_keeps_a_leading_partial_line() {
        let mut buf = TerminalOutputBuffer::new(1024);
        buf.push(b"line1\nline2");

        let snapshot = buf.snapshot(1024);

        assert_eq!(snapshot.data, b"line1\nline2");
        assert_eq!(snapshot.seq_start, 0);
    }

    #[test]
    fn truncated_snapshot_without_a_newline_is_kept_as_is() {
        let mut buf = TerminalOutputBuffer::new(1024);
        buf.push(b"one very long line without breaks");

        let snapshot = buf.snapshot(10);

        assert_eq!(snapshot.data, b"out breaks");
        assert_eq!(snapshot.seq_start, snapshot.seq_end - 10);
    }

    #[test]
    fn delta_since_rejects_a_sequence_gap_instead_of_clamping() {
        let mut buf = TerminalOutputBuffer::new(5);
        buf.push(b"abcdefgh");

        assert!(buf.delta_since(2).is_none());
        assert_eq!(
            buf.delta_since(3).unwrap(),
            TerminalOutputSlice {
                seq_start: 3,
                seq_end: 8,
                data: b"defgh".to_vec(),
            }
        );
        assert!(buf.delta_since(9).is_none());
    }
}
