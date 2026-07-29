use super::*;

#[test]
fn new_buffer_is_empty() {
    let buf = TerminalOutputBuffer::new(1024);
    assert!(buf.is_empty().unwrap());
    assert_eq!(buf.len().unwrap(), 0);
}

#[test]
fn push_stores_data() {
    let mut buf = TerminalOutputBuffer::new(1024);
    buf.push(b"hello");
    assert_eq!(buf.len().unwrap(), 5);
    assert_eq!(buf.recent_bytes(5).unwrap(), b"hello");
}

#[test]
fn push_evicts_oldest_when_full() {
    let mut buf = TerminalOutputBuffer::new(10);
    buf.push(b"abcdefgh"); // 8 bytes
    buf.push(b"ijklm"); // 5 bytes, total 13 > 10
    assert_eq!(buf.len().unwrap(), 10);
    // oldest 3 bytes evicted: "abc" gone, "defghijklm" remains
    assert_eq!(buf.recent_bytes(10).unwrap(), b"defghijklm");
}

#[test]
fn push_data_larger_than_capacity() {
    let mut buf = TerminalOutputBuffer::new(5);
    buf.push(b"abcdefghij"); // 10 bytes > capacity 5
    assert_eq!(buf.len().unwrap(), 5);
    assert_eq!(buf.recent_bytes(5).unwrap(), b"fghij");
}

#[test]
fn recent_lines_returns_last_n() {
    let mut buf = TerminalOutputBuffer::new(1024);
    buf.push(b"line1\nline2\nline3\nline4\nline5");
    assert_eq!(buf.recent_lines(3).unwrap(), "line3\nline4\nline5");
}

#[test]
fn recent_lines_fewer_than_n() {
    let mut buf = TerminalOutputBuffer::new(1024);
    buf.push(b"line1\nline2");
    assert_eq!(buf.recent_lines(10).unwrap(), "line1\nline2");
}

#[test]
fn recent_lines_zero_returns_empty() {
    let mut buf = TerminalOutputBuffer::new(1024);
    buf.push(b"hello");
    assert_eq!(buf.recent_lines(0).unwrap(), "");
}

#[test]
fn recent_lines_empty_buffer() {
    let buf = TerminalOutputBuffer::new(1024);
    assert_eq!(buf.recent_lines(5).unwrap(), "");
}

#[test]
fn recent_bytes_more_than_available() {
    let mut buf = TerminalOutputBuffer::new(1024);
    buf.push(b"abc");
    assert_eq!(buf.recent_bytes(100).unwrap(), b"abc");
}

#[test]
fn clear_empties_buffer() {
    let mut buf = TerminalOutputBuffer::new(1024);
    buf.push(b"data");
    buf.clear().unwrap();
    assert!(buf.is_empty().unwrap());
    assert_eq!(buf.len().unwrap(), 0);
}

#[test]
fn default_uses_the_lossless_desktop_retention_bound() {
    let buf = TerminalOutputBuffer::default();
    assert_eq!(buf.max_size().unwrap(), TERMINAL_OUTPUT_RING_MAX_BYTES);
    assert_eq!(
        TERMINAL_OUTPUT_RING_MAX_BYTES,
        crate::constants::TERMINAL_OUTPUT_DESKTOP_BASE_CREDIT_BYTES
            + crate::constants::TERMINAL_OUTPUT_DEC2026_CONTINUATION_MAX_BYTES
            + 2 * crate::pty::PTY_READ_BUFFER_BYTES
    );
    assert_eq!(
        crate::constants::TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES,
        TERMINAL_OUTPUT_RING_MAX_BYTES
    );
    assert_eq!(
        crate::constants::REMOTE_RENDER_CHECKPOINT_ABSOLUTE_MAX_BYTES,
        1024 * 1024,
        "desktop retention must not change the Remote snapshot contract"
    );
}

#[test]
fn multiple_pushes_accumulate() {
    let mut buf = TerminalOutputBuffer::new(1024);
    buf.push(b"aaa");
    buf.push(b"bbb");
    buf.push(b"ccc");
    assert_eq!(buf.len().unwrap(), 9);
    assert_eq!(buf.recent_bytes(9).unwrap(), b"aaabbbccc");
}

#[test]
fn write_seq_increases_monotonically() {
    let mut buf = TerminalOutputBuffer::new(1024);
    assert_eq!(buf.write_seq().unwrap(), 0);
    buf.push(b"hello"); // 5 bytes
    assert_eq!(buf.write_seq().unwrap(), 5);
    buf.push(b"world"); // 5 bytes
    assert_eq!(buf.write_seq().unwrap(), 10);
}

#[test]
fn write_seq_survives_ring_buffer_wrap() {
    let mut buf = TerminalOutputBuffer::new(10);
    buf.push(b"abcdefgh"); // 8 bytes, seq=8
    assert_eq!(buf.write_seq().unwrap(), 8);
    buf.push(b"ijklmnop"); // 8 bytes, total 16 > 10 cap, evicts oldest
    assert_eq!(buf.write_seq().unwrap(), 16);
    // len is capped but seq keeps growing
    assert_eq!(buf.len().unwrap(), 10);
}

#[test]
fn bytes_since_returns_new_data() {
    let mut buf = TerminalOutputBuffer::new(1024);
    buf.push(b"before");
    let seq = buf.write_seq().unwrap(); // 6
    buf.push(b"after");
    let new = buf.bytes_since(seq).unwrap();
    assert_eq!(new, b"after");
}

#[test]
fn bytes_since_after_wrap_returns_available() {
    let mut buf = TerminalOutputBuffer::new(10);
    buf.push(b"12345"); // seq=5, len=5
    let seq = buf.write_seq().unwrap();
    buf.push(b"67890abcde"); // seq=15, len=10, buffer="0abcde" wait...
                             // 15 bytes total pushed into 10 cap buffer
                             // new_bytes = 15 - 5 = 10, but buffer only holds 10
    let new = buf.bytes_since(seq).unwrap();
    // Should get min(10, 10) = 10 bytes (everything in buffer)
    assert_eq!(new.len(), 10);
}

#[test]
fn bytes_since_zero_when_no_new_data() {
    let mut buf = TerminalOutputBuffer::new(1024);
    buf.push(b"data");
    let seq = buf.write_seq().unwrap();
    let new = buf.bytes_since(seq).unwrap();
    assert!(new.is_empty());
}

#[test]
fn snapshot_reports_the_exact_retained_sequence_range() {
    let mut buf = TerminalOutputBuffer::new(5);
    buf.push(b"abcdefgh");

    let snapshot = buf.snapshot(3).unwrap();

    assert_eq!(snapshot.seq_start, 5);
    assert_eq!(snapshot.seq_end, 8);
    assert_eq!(snapshot.data, b"fgh");
    assert_eq!(buf.start_seq().unwrap(), 3);
}

#[test]
fn truncated_snapshot_drops_the_partial_first_line() {
    let mut buf = TerminalOutputBuffer::new(1024);
    buf.push(b"line1\nline2\nline3");

    let snapshot = buf.snapshot(10).unwrap(); // cuts inside "line2"

    assert_eq!(snapshot.data, b"line3");
    assert_eq!(snapshot.seq_end, 17);
    assert_eq!(snapshot.seq_start, 17 - 5);
}

#[test]
fn untruncated_snapshot_keeps_a_leading_partial_line() {
    let mut buf = TerminalOutputBuffer::new(1024);
    buf.push(b"line1\nline2");

    let snapshot = buf.snapshot(1024).unwrap();

    assert_eq!(snapshot.data, b"line1\nline2");
    assert_eq!(snapshot.seq_start, 0);
}

#[test]
fn truncated_snapshot_without_a_newline_is_kept_as_is() {
    let mut buf = TerminalOutputBuffer::new(1024);
    buf.push(b"one very long line without breaks");

    let snapshot = buf.snapshot(10).unwrap();

    assert_eq!(snapshot.data, b"out breaks");
    assert_eq!(snapshot.seq_start, snapshot.seq_end - 10);
}

#[test]
fn delta_since_rejects_a_sequence_gap_instead_of_clamping() {
    let mut buf = TerminalOutputBuffer::new(5);
    buf.push(b"abcdefgh");

    assert!(buf.delta_since(2).unwrap().is_none());
    assert_eq!(
        buf.delta_since(3).unwrap().unwrap(),
        TerminalOutputSlice {
            seq_start: 3,
            seq_end: 8,
            data: b"defgh".to_vec(),
        }
    );
    assert!(buf.delta_since(9).unwrap().is_none());
}

#[test]
fn protected_append_at_exact_capacity_evicts_only_the_parsed_prefix() {
    let ring = TerminalOutputBuffer::new(8);
    ring.push_sequenced(b"old!").unwrap();

    let appended = ring.push_sequenced_protected(b"abcdefgh", 4).unwrap();

    assert_eq!((appended.seq_start, appended.seq_end), (4, 12));
    assert_eq!(ring.start_seq().unwrap(), 4);
    assert_eq!(ring.recent_bytes(8).unwrap(), b"abcdefgh");
    assert_eq!(
        ring.exact_snapshot_since(4, 8).unwrap().unwrap().data,
        b"abcdefgh"
    );
}

#[test]
fn protected_append_that_would_cross_ack_is_an_error_without_mutation() {
    let ring = TerminalOutputBuffer::new(8);
    ring.push_sequenced_protected(b"abcdefgh", 0).unwrap();
    let before_output_at = ring.last_output_at().unwrap();

    let error = ring.push_sequenced_protected(b"i", 0).unwrap_err();

    assert!(error.to_string().contains("evict unacknowledged"));
    assert_eq!(ring.start_seq().unwrap(), 0);
    assert_eq!(ring.write_seq().unwrap(), 8);
    assert_eq!(ring.recent_bytes(8).unwrap(), b"abcdefgh");
    assert_eq!(ring.last_output_at().unwrap(), before_output_at);
}

#[test]
fn advancing_parsed_ack_allows_only_that_prefix_to_be_evicted() {
    let ring = TerminalOutputBuffer::new(8);
    ring.push_sequenced_protected(b"abcdefgh", 0).unwrap();

    ring.push_sequenced_protected(b"i", 1).unwrap();

    assert_eq!(ring.start_seq().unwrap(), 1);
    assert_eq!(ring.write_seq().unwrap(), 9);
    assert_eq!(ring.recent_bytes(8).unwrap(), b"bcdefghi");
}

#[test]
fn chunk_larger_than_capacity_is_rejected_without_partial_mutation() {
    let ring = TerminalOutputBuffer::new(8);
    let error = ring.push_sequenced_protected(b"123456789", 0).unwrap_err();

    assert!(error.to_string().contains("evict unacknowledged"));
    assert_eq!(ring.write_seq().unwrap(), 0);
    assert!(ring.is_empty().unwrap());
    assert!(ring.last_output_at().unwrap().is_none());
}

#[test]
fn max_read_chunk_can_retry_after_ack_at_the_full_desktop_bound() {
    let ring = TerminalOutputBuffer::default();
    let capacity = crate::constants::TERMINAL_OUTPUT_MAX_DESKTOP_RETAINED_BYTES;
    let read_chunk = crate::pty::PTY_READ_BUFFER_BYTES;
    let full_prefix = vec![b'x'; capacity];
    let next_read = vec![b'y'; read_chunk];
    ring.push_sequenced_protected(&full_prefix, 0).unwrap();

    assert!(ring
        .push_sequenced_protected(&next_read, 0)
        .unwrap_err()
        .to_string()
        .contains("evict unacknowledged"));
    assert_eq!(ring.write_seq().unwrap(), capacity as u64);
    assert_eq!(ring.start_seq().unwrap(), 0);

    ring.push_sequenced_protected(&next_read, read_chunk as u64)
        .unwrap();
    assert_eq!(ring.start_seq().unwrap(), read_chunk as u64);
    assert_eq!(ring.write_seq().unwrap(), (capacity + read_chunk) as u64);
}

#[test]
fn exact_snapshot_never_clamps_or_trims_the_requested_prefix() {
    let ring = TerminalOutputBuffer::new(8);
    ring.push_sequenced(b"00ab\ncdef").unwrap();

    let snapshot = ring.exact_snapshot_since(1, 8).unwrap().unwrap();
    assert_eq!((snapshot.seq_start, snapshot.seq_end), (1, 9));
    assert_eq!(snapshot.data, b"0ab\ncdef");
    assert!(ring.exact_snapshot_since(0, 8).unwrap().is_none());
    assert!(ring
        .exact_snapshot_since(1, 6)
        .unwrap_err()
        .to_string()
        .contains("exceeds limit"));
}

#[test]
fn poisoned_ring_fails_closed_for_authoritative_reads_and_writes() {
    let buf = TerminalOutputBuffer::new(16);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _inner = buf.inner.lock().unwrap();
        panic!("poison output ring after a partial mutation");
    }))
    .is_err());

    assert!(buf.push_sequenced(b"must-not-be-sequenced").is_err());
    assert!(buf.snapshot(16).is_err());
    assert!(buf.write_seq().is_err());
    assert!(buf.delta_since(0).is_err());
    assert!(buf.recent_bytes(16).is_err());
}
