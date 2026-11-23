use crate::terminal_protocol::{BRACKETED_PASTE_BEGIN, BRACKETED_PASTE_END};

// Only keep the small line prefix needed to recognize display clears.
const MAX_CLEAR_LINE_BYTES: usize = 64;

#[derive(Default)]
pub(super) struct RemoteClearInput {
    revision: Option<u64>,
    line: Vec<u8>,
    unknown_line: bool,
    bracketed_paste: bool,
}

impl RemoteClearInput {
    fn reset_line(&mut self) {
        self.line.clear();
        self.unknown_line = false;
    }

    pub(super) fn observe(&mut self, revision: u64, mut data: &[u8]) -> Option<bool> {
        if let Some(previous) = self.revision {
            if revision <= previous {
                return None;
            }
            if revision != previous + 1 {
                self.line.clear();
                self.unknown_line = true;
            }
        }
        self.revision = Some(revision);

        let mut clear = None;
        while let Some((&byte, rest)) = data.split_first() {
            if let Some(rest) = data.strip_prefix(BRACKETED_PASTE_BEGIN) {
                self.bracketed_paste = true;
                data = rest;
                continue;
            }
            if let Some(rest) = data.strip_prefix(BRACKETED_PASTE_END) {
                self.bracketed_paste = false;
                data = rest;
                continue;
            }
            data = rest;
            match byte {
                0x20..=0x7e if self.line.len() < MAX_CLEAR_LINE_BYTES => self.line.push(byte),
                _ if self.bracketed_paste => self.unknown_line = true,
                b'\r' | b'\n' => {
                    if !self.unknown_line && is_clear_command(&self.line) {
                        clear = Some(true);
                    }
                    self.reset_line();
                }
                0x03 => self.reset_line(),
                0x15 if !self.unknown_line => self.reset_line(),
                0x0c => clear = clear.or(Some(false)),
                0x08 | 0x7f => {
                    self.line.pop();
                }
                // Focus reports can accompany regular xterm key input.
                0x1b if rest.starts_with(b"[I") || rest.starts_with(b"[O") => data = &rest[2..],
                _ => self.unknown_line = true,
            }
        }
        clear
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

    #[test]
    fn recognizes_clear_only_when_split_input_is_submitted() {
        let mut input = RemoteClearInput::default();
        assert_eq!(input.observe(4, b" /cl"), None);
        assert_eq!(input.observe(5, b"eaz\x7fr "), None);
        assert_eq!(input.observe(6, b"\r"), Some(true));
        assert_eq!(input.observe(7, b"clear other\r"), None);
        assert_eq!(input.observe(8, b"/CLEAR\r"), Some(true));
    }

    #[test]
    fn gaps_and_unknown_edits_cannot_create_a_clear_command() {
        let mut input = RemoteClearInput::default();
        assert_eq!(input.observe(2, b"/cl"), None);
        assert_eq!(input.observe(4, b"ear\r"), None);
        assert_eq!(input.observe(3, b"/clear\r"), None);
        assert_eq!(input.observe(5, b"/clear\x1b[D\r"), None);
        assert_eq!(input.observe(6, b"draft\x03\x1b[I/clear\r"), Some(true));
    }

    #[test]
    fn ctrl_l_clears_display_without_discarding_the_line() {
        let mut input = RemoteClearInput::default();
        assert_eq!(input.observe(1, b"/cl\x0c"), Some(false));
        assert_eq!(input.observe(2, b"ear\r"), Some(true));
    }

    #[test]
    fn bracketed_paste_needs_enter_outside_the_paste() {
        let mut input = RemoteClearInput::default();
        assert_eq!(input.observe(1, b"\x1b[200~/clear\x1b[201~"), None);
        assert_eq!(input.observe(2, b"\r"), Some(true));
        assert_eq!(
            input.observe(3, b"\x1b[200~other\r/clear\r\x1b[201~\r"),
            None
        );
    }
}
