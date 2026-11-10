use super::output::OUTPUT_LIMIT;
use super::parsing::{index_guards, status, FILE_PREVIEW_LIMIT};
use std::io::{self, Cursor, Read};

/// 전체 출력을 만들지 않고 같은 NUL 레코드를 요청된 크기만큼 제공한다.
struct Records {
    bytes: Vec<u8>,
    position: usize,
    length: usize,
}
impl Records {
    fn new(bytes: Vec<u8>, count: usize) -> Self {
        Self {
            length: bytes.len() * count,
            bytes,
            position: 0,
        }
    }
}
impl Read for Records {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let count = output.len().min(self.length - self.position);
        for (offset, byte) in output[..count].iter_mut().enumerate() {
            *byte = self.bytes[(self.position + offset) % self.bytes.len()];
        }
        self.position += count;
        Ok(count)
    }
}

struct Bytewise<R>(R);
impl<R: Read> Read for Bytewise<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let count = output.len().min(1);
        self.0.read(&mut output[..count])
    }
}

#[test]
fn ignored_file_count_is_complete_beyond_eight_mib_and_the_preview() {
    let bytes = format!("!! {}\0", "x".repeat(256)).into_bytes();
    let records = Records::new(bytes, 40_000);
    assert!(records.length > OUTPUT_LIMIT);
    let result = status(records).unwrap();
    assert_eq!(result.ignored, 40_000);
    assert_eq!(result.files.len(), FILE_PREVIEW_LIMIT);
    assert!(result.files.iter().all(|file| file.kind == "ignored"));
}

#[test]
fn guards_after_eight_mib_are_not_missed() {
    let bytes = format!("H 100644 {} 0\t{}\0", "a".repeat(40), "x".repeat(256)).into_bytes();
    let records = Records::new(bytes, 40_000);
    assert!(records.length > OUTPUT_LIMIT);
    let final_guard = Cursor::new(b"S 160000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0\tmodule\0");
    assert_eq!(
        index_guards(records.chain(final_guard)).unwrap(),
        (true, true)
    );
}

#[test]
fn split_utf8_and_rename_source_paths_preserve_counts_and_names() {
    let bytes = "R  한글\n새 이름\0?? 원래 이름\0?? next\0".as_bytes();
    let result = status(Bytewise(Cursor::new(bytes))).unwrap();
    assert_eq!((result.tracked, result.untracked), (1, 1));
    assert_eq!(result.files[0].path, "한글\n새 이름");
    assert_eq!(result.files[1].path, "next");
}

#[test]
fn malformed_or_unterminated_records_never_become_clean_results() {
    for bytes in [
        b"?? unfinished".as_slice(),
        b"R  new\0",
        b"R  new\0old",
        b"?? \xff\0",
        b"bad\0",
    ] {
        assert!(status(bytes).is_err());
    }
    assert!(index_guards(b"H 100644 hash 0\tunfinished".as_slice()).is_err());
    let records = Records::new(b"?? valid\0".to_vec(), 300);
    assert!(status(records.chain(Cursor::new(b"?? truncated"))).is_err());
    assert!(status(io::repeat(b'x').take((OUTPUT_LIMIT + 1) as u64)).is_err());
}

#[test]
fn preview_byte_budget_does_not_stop_total_counts() {
    let bytes = format!("?? {}\0", "x".repeat(OUTPUT_LIMIT / 4)).into_bytes();
    let result = status(Records::new(bytes, 5)).unwrap();
    assert_eq!(result.untracked, 5);
    assert_eq!(result.files.len(), 4);
    assert_eq!(
        result
            .files
            .iter()
            .map(|file| file.path.len())
            .sum::<usize>(),
        OUTPUT_LIMIT
    );
}
