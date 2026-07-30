use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use crate::constants::TERMINAL_OUTPUT_RING_MAX_BYTES;
use crate::error::AppError;
use crate::lock_ext::MutexExt;

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

    fn lock_inner(&self) -> Result<MutexGuard<'_, TerminalOutputBufferInner>, AppError> {
        // The ring owns authoritative sequence state, not merely diagnostics.
        // Recovering a poisoned guard could publish a partially advanced
        // sequence or duplicate bytes, so every read and write fails closed.
        self.inner.lock_or_err()
    }

    pub fn same_storage(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    #[cfg(test)]
    pub fn push(&mut self, data: &[u8]) {
        self.push_sequenced(data)
            .expect("test output ring must remain healthy");
    }

    /// Append bytes and capture their exact range under one ring lock.
    pub(crate) fn push_sequenced(&self, data: &[u8]) -> Result<TerminalOutputSlice, AppError> {
        let mut inner = self.lock_inner()?;
        push_sequenced_inner(&mut inner, data, None)
    }

    /// Append bytes without evicting `protected_start_seq` or anything after it.
    ///
    /// Desktop parsed credit passes its current ACK as the protected boundary.
    /// All validation happens before sequence, timestamp, or bytes are mutated,
    /// so a caller can wait for ACK progress and retry the identical PTY chunk.
    pub(crate) fn push_sequenced_protected(
        &self,
        data: &[u8],
        protected_start_seq: u64,
    ) -> Result<TerminalOutputSlice, AppError> {
        let mut inner = self.lock_inner()?;
        push_sequenced_inner(&mut inner, data, Some(protected_start_seq))
    }

    pub fn recent_lines(&self, n: usize) -> Result<String, AppError> {
        let inner = self.lock_inner()?;
        if inner.buffer.is_empty() || n == 0 {
            return Ok(String::new());
        }

        let bytes: Vec<u8> = inner.buffer.iter().copied().collect();
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.lines().collect();

        if lines.len() <= n {
            Ok(lines.join("\n"))
        } else {
            Ok(lines[lines.len() - n..].join("\n"))
        }
    }

    pub fn recent_bytes(&self, n: usize) -> Result<Vec<u8>, AppError> {
        let inner = self.lock_inner()?;
        Ok(recent_bytes_from(&inner, n))
    }

    /// Sequence number of the oldest byte still retained by the ring.
    pub fn start_seq(&self) -> Result<u64, AppError> {
        let inner = self.lock_inner()?;
        Ok(start_seq_from(&inner))
    }

    /// Return an exact, sequenced tail snapshot.
    ///
    /// When `max_bytes` truncates retained history, the cut almost always lands
    /// mid-line (or mid escape sequence). Dropping through the first `\n` keeps
    /// the replayed tail starting on a clean line boundary; a tail with no
    /// newline at all is kept as-is rather than returned empty.
    pub fn snapshot(&self, max_bytes: usize) -> Result<TerminalOutputSlice, AppError> {
        let inner = self.lock_inner()?;
        let truncated = max_bytes < inner.buffer.len();
        let mut data = recent_bytes_from(&inner, max_bytes);
        if truncated {
            if let Some(newline) = data.iter().position(|&byte| byte == b'\n') {
                data.drain(..=newline);
            }
        }
        let seq_end = inner.write_seq;
        Ok(TerminalOutputSlice {
            seq_start: seq_end.saturating_sub(data.len() as u64),
            seq_end,
            data,
        })
    }

    /// Return the exact retained prefix `[since_seq, write_seq)` without tail
    /// clamping or line-boundary trimming.
    ///
    /// `Ok(None)` means the requested start is outside the retained sequence
    /// range. Exceeding `max_bytes` is an explicit invariant error rather than a
    /// shorter snapshot that could begin inside an unparsed control sequence.
    pub(crate) fn exact_snapshot_since(
        &self,
        since_seq: u64,
        max_bytes: usize,
    ) -> Result<Option<TerminalOutputSlice>, AppError> {
        let inner = self.lock_inner()?;
        let retained_start = start_seq_from(&inner);
        if since_seq < retained_start || since_seq > inner.write_seq {
            return Ok(None);
        }
        let byte_len_u64 = inner.write_seq - since_seq;
        let byte_len = usize::try_from(byte_len_u64).map_err(|_| {
            AppError::Other(format!(
                "terminal output snapshot length {byte_len_u64} does not fit usize"
            ))
        })?;
        if byte_len > max_bytes {
            return Err(AppError::Other(format!(
                "terminal output exact snapshot of {byte_len} bytes exceeds limit {max_bytes}"
            )));
        }
        let skip = usize::try_from(since_seq - retained_start).map_err(|_| {
            AppError::Other("terminal output snapshot offset does not fit usize".into())
        })?;
        let data = inner.buffer.iter().skip(skip).copied().collect();
        Ok(Some(TerminalOutputSlice {
            seq_start: since_seq,
            seq_end: inner.write_seq,
            data,
        }))
    }

    /// Monotonically increasing sequence number (total bytes ever pushed).
    pub fn write_seq(&self) -> Result<u64, AppError> {
        Ok(self.lock_inner()?.write_seq)
    }

    /// Return bytes written since `since_seq`, clamped to what the buffer still holds.
    pub fn bytes_since(&self, since_seq: u64) -> Result<Vec<u8>, AppError> {
        let inner = self.lock_inner()?;
        Ok(bytes_since_from(&inner, since_seq))
    }

    /// Return every byte after `since_seq` with its exact sequence range.
    ///
    /// `None` means the caller fell behind the ring and must reattach from a
    /// fresh snapshot. Silently clamping would hide an output gap and could
    /// leave a terminal surface with stale protocol modes.
    pub fn delta_since(&self, since_seq: u64) -> Result<Option<TerminalOutputSlice>, AppError> {
        let inner = self.lock_inner()?;
        if since_seq < start_seq_from(&inner) || since_seq > inner.write_seq {
            return Ok(None);
        }
        let data = bytes_since_from(&inner, since_seq);
        Ok(Some(TerminalOutputSlice {
            seq_start: since_seq,
            seq_end: inner.write_seq,
            data,
        }))
    }

    pub fn clear(&mut self) -> Result<(), AppError> {
        self.lock_inner()?.buffer.clear();
        Ok(())
    }

    pub fn len(&self) -> Result<usize, AppError> {
        Ok(self.lock_inner()?.buffer.len())
    }

    pub fn is_empty(&self) -> Result<bool, AppError> {
        Ok(self.lock_inner()?.buffer.is_empty())
    }

    pub fn last_output_at(&self) -> Result<Option<Instant>, AppError> {
        Ok(self.lock_inner()?.last_output_at)
    }

    #[cfg(test)]
    fn max_size(&self) -> Result<usize, AppError> {
        Ok(self.lock_inner()?.max_size)
    }

    #[cfg(test)]
    pub(crate) fn poison_for_test(&self) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _inner = self.inner.lock().unwrap();
            panic!("poison terminal output ring for test");
        }));
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

fn push_sequenced_inner(
    inner: &mut TerminalOutputBufferInner,
    data: &[u8],
    protected_start_seq: Option<u64>,
) -> Result<TerminalOutputSlice, AppError> {
    let seq_start = inner.write_seq;
    let data_len = u64::try_from(data.len())
        .map_err(|_| AppError::Other("terminal output chunk length does not fit u64".into()))?;
    let seq_end = seq_start
        .checked_add(data_len)
        .ok_or_else(|| AppError::Other("terminal output sequence overflow".into()))?;
    let new_len = inner
        .buffer
        .len()
        .checked_add(data.len())
        .ok_or_else(|| AppError::Other("terminal output ring length overflow".into()))?;

    if let Some(protected_start_seq) = protected_start_seq {
        let retained_start = start_seq_from(inner);
        if protected_start_seq < retained_start || protected_start_seq > seq_start {
            return Err(AppError::Other(format!(
                "terminal output protected sequence {protected_start_seq} is outside retained range {retained_start}..={seq_start}"
            )));
        }
        let capacity = u64::try_from(inner.max_size).map_err(|_| {
            AppError::Other("terminal output ring capacity does not fit u64".into())
        })?;
        let required_start = seq_end.saturating_sub(capacity);
        if required_start > protected_start_seq {
            return Err(AppError::Other(format!(
                "terminal output append would evict unacknowledged bytes at sequence {protected_start_seq}"
            )));
        }
    }

    inner.last_output_at = Some(Instant::now());
    inner.write_seq = seq_end;
    if data.len() >= inner.max_size {
        // Data at least as large as the buffer: keep only the tail. The
        // protected path has already proved that this cannot discard its ACK.
        inner.buffer.clear();
        let start = data.len() - inner.max_size;
        inner.buffer.extend(&data[start..]);
    } else {
        if new_len > inner.max_size {
            let to_remove = new_len - inner.max_size;
            inner.buffer.drain(..to_remove);
        }
        inner.buffer.extend(data);
    }

    Ok(TerminalOutputSlice {
        seq_start,
        seq_end,
        data: data.to_vec(),
    })
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
        Self::new(TERMINAL_OUTPUT_RING_MAX_BYTES)
    }
}

#[cfg(test)]
#[path = "output_buffer_tests.rs"]
mod tests;
