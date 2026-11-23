use crate::terminal_protocol::{BRACKETED_PASTE_BEGIN, BRACKETED_PASTE_END};
use std::io::{self, Write};

const MAX_CLEAR_LINE_BYTES: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DisplayClear {
    Command,
    Redraw,
}

#[derive(Default)]
pub(crate) struct RemoteClearInput {
    line: Vec<u8>,
    unknown_line: bool,
    bracketed_paste: bool,
    escape_len: usize,
}

impl RemoteClearInput {
    pub(crate) fn new(adopted: bool) -> Self {
        Self {
            unknown_line: adopted,
            ..Self::default()
        }
    }

    fn reset_line(&mut self) {
        self.line.clear();
        self.unknown_line = false;
    }

    fn record(&mut self, data: &[u8], clear: &mut Option<DisplayClear>) {
        for &byte in data {
            if self.escape_len > 0 {
                let marker = if self.bracketed_paste {
                    BRACKETED_PASTE_END
                } else {
                    BRACKETED_PASTE_BEGIN
                };
                if byte == marker[self.escape_len] {
                    self.escape_len += 1;
                    if self.escape_len == marker.len() {
                        self.bracketed_paste = !self.bracketed_paste;
                        self.escape_len = 0;
                    }
                    continue;
                }
                // xterm의 포커스 보고는 작성 중인 줄을 편집하지 않는다.
                let focus =
                    !self.bracketed_paste && self.escape_len == 2 && matches!(byte, b'I' | b'O');
                self.escape_len = 0;
                if focus {
                    continue;
                }
                self.unknown_line = true;
            }
            match byte {
                0x1b => self.escape_len = 1,
                0x20..=0x7e if self.line.len() < MAX_CLEAR_LINE_BYTES => self.line.push(byte),
                _ if self.bracketed_paste => self.unknown_line = true,
                b'\r' => {
                    if !self.unknown_line && is_clear_command(&self.line) {
                        *clear = Some(DisplayClear::Command);
                    }
                    self.reset_line();
                }
                0x03 => self.reset_line(),
                0x15 if !self.unknown_line => self.reset_line(),
                0x0c => {
                    clear.get_or_insert(DisplayClear::Redraw);
                }
                0x08 | 0x7f => {
                    self.line.pop();
                }
                // Ctrl+J(LF)는 TUI 작성기의 줄바꿈이다.
                _ => self.unknown_line = true,
            }
        }
    }
}

// 부분 쓰기가 성공한 바이트만 실제 PTY 순서로 기록한다. 프로토콜 응답은 이 래퍼를 거치지 않는다.
pub(crate) struct ObservedInputWriter<'a> {
    pub writer: &'a mut dyn Write,
    pub input: &'a mut RemoteClearInput,
    pub clear: Option<DisplayClear>,
}

impl Write for ObservedInputWriter<'_> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let written = self.writer.write(data)?;
        self.input.record(&data[..written], &mut self.clear);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

fn is_clear_command(line: &[u8]) -> bool {
    let line = line.trim_ascii();
    [b"/clear".as_slice(), b"clear", b"cls", b"clear-host"]
        .iter()
        .any(|command| line.eq_ignore_ascii_case(command))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::PtyHandle;
    use std::time::{Duration, Instant};

    fn observe(input: &mut RemoteClearInput, data: &[u8]) -> Option<DisplayClear> {
        let mut clear = None;
        input.record(data, &mut clear);
        clear
    }

    #[test]
    fn line_feed_inside_a_draft_never_submits_clear() {
        let mut input = RemoteClearInput::default();
        assert_eq!(observe(&mut input, b"/clear\n"), None);
        assert_eq!(observe(&mut input, b"/clear\r"), None);
        assert_eq!(
            observe(&mut input, b"/clear\r"),
            Some(DisplayClear::Command)
        );
    }

    #[test]
    fn every_split_of_the_paste_markers_preserves_the_line_boundaries() {
        for cut in 1..BRACKETED_PASTE_BEGIN.len() {
            let mut input = RemoteClearInput::default();
            assert_eq!(observe(&mut input, &BRACKETED_PASTE_BEGIN[..cut]), None);
            assert_eq!(observe(&mut input, &BRACKETED_PASTE_BEGIN[cut..]), None);
            assert_eq!(observe(&mut input, b"notes\r/clear\r"), None);
            assert_eq!(observe(&mut input, &BRACKETED_PASTE_END[..cut]), None);
            assert_eq!(observe(&mut input, &BRACKETED_PASTE_END[cut..]), None);
            assert_eq!(
                observe(&mut input, b"\r/clear\r"),
                Some(DisplayClear::Command)
            );
        }
    }

    #[test]
    fn remote_submit_uses_the_local_line_and_physical_write_order() {
        let handle = PtyHandle::from_test_writer(Box::new(std::io::sink()));
        let deadline = Instant::now() + Duration::from_secs(2);
        let enqueue = |data: &[u8]| handle.enqueue_write(data, false, deadline).unwrap();
        let finish = |job| {
            handle
                .await_write_display_clear(job, deadline, || true)
                .unwrap()
        };
        handle.write(b"echo ").unwrap();
        assert_eq!(finish(enqueue(b"/clear\r")), None);
        handle.write(b"codex\r").unwrap();
        let first = enqueue(b"/cl");
        handle.write_protocol_reply(b"\x1b[?1;2c").unwrap();
        let last = enqueue(b"ear\r");
        assert_eq!(finish(last), Some(DisplayClear::Command));
        assert_eq!(finish(first), None);
    }

    #[test]
    fn recognizes_clear_only_when_split_input_is_submitted() {
        let mut input = RemoteClearInput::default();
        assert_eq!(observe(&mut input, b" /cl"), None);
        assert_eq!(observe(&mut input, b"eaz\x7fr "), None);
        assert_eq!(observe(&mut input, b"\r"), Some(DisplayClear::Command));
        assert_eq!(observe(&mut input, b"clear other\r"), None);
        assert_eq!(
            observe(&mut input, b"/CLEAR\r"),
            Some(DisplayClear::Command)
        );
    }

    #[test]
    fn adopted_drafts_and_unknown_edits_need_a_new_line_boundary() {
        let mut input = RemoteClearInput::new(true);
        assert_eq!(observe(&mut input, b"/clear\r"), None);
        assert_eq!(
            observe(&mut input, b"/clear\r"),
            Some(DisplayClear::Command)
        );
        assert_eq!(observe(&mut input, b"/clear\x1b[D\r"), None);
        assert_eq!(
            observe(&mut input, b"draft\x03\x1b[I/clear\r"),
            Some(DisplayClear::Command)
        );
    }

    #[test]
    fn ctrl_l_clears_display_without_discarding_the_line() {
        let mut input = RemoteClearInput::default();
        assert_eq!(observe(&mut input, b"/cl\x0c"), Some(DisplayClear::Redraw));
        assert_eq!(observe(&mut input, b"ear\r"), Some(DisplayClear::Command));
    }

    #[test]
    fn bracketed_paste_needs_enter_outside_the_paste() {
        let mut input = RemoteClearInput::default();
        assert_eq!(observe(&mut input, b"\x1b[200~/clear\x1b[201~"), None);
        assert_eq!(observe(&mut input, b"\r"), Some(DisplayClear::Command));
        assert_eq!(
            observe(&mut input, b"\x1b[200~other\r/clear\r\x1b[201~\r"),
            None
        );
    }
}
