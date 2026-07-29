/// Tracks only the VT lexical state that can make an exact geometry boundary
/// unsafe. Input is decoded with the same streaming UTF-8 rules as xterm's
/// `Utf8ToUtf32` before any C1 byte is interpreted as a control.
#[derive(Debug, Default)]
pub(super) struct GeometryBoundaryTracker {
    state: LexicalState,
    synchronized_output: bool,
    decoder: XtermUtf8Decoder,
}

impl GeometryBoundaryTracker {
    pub(super) fn feed(&mut self, data: &[u8]) {
        for &byte in data {
            if let Some(codepoint) = self.decoder.feed(byte) {
                self.feed_codepoint(codepoint);
            }
        }
    }

    pub(super) fn is_neutral(&self) -> bool {
        self.state == LexicalState::Ground && !self.synchronized_output && self.decoder.is_neutral()
    }

    fn feed_codepoint(&mut self, codepoint: u32) {
        if codepoint < 0xa0 {
            self.feed_control(codepoint as u8);
        } else {
            self.feed_non_ascii();
        }
    }

    fn feed_control(&mut self, byte: u8) {
        use LexicalState::*;

        // xterm's VT500 table applies these transitions in every state. Raw
        // invalid UTF-8 bytes never arrive here; encoded C1 scalars do.
        self.state = match byte {
            0x18 | 0x1a | 0x80..=0x8f | 0x91..=0x97 | 0x99 | 0x9a | 0x9c => Ground,
            0x1b => Escape,
            0x90 => Dcs(DcsState::Entry),
            0x98 | 0x9e | 0x9f => IgnoredString,
            0x9b => Csi(CsiTracker::default()),
            0x9d => Osc,
            _ => match self.state {
                Ground => Ground,
                Escape => match byte {
                    b'[' => Csi(CsiTracker::default()),
                    b']' => Osc,
                    b'P' => Dcs(DcsState::Entry),
                    b'X' | b'^' | b'_' => IgnoredString,
                    b'c' => {
                        self.synchronized_output = false;
                        Ground
                    }
                    0x00..=0x17 | 0x19 | 0x1c..=0x1f | 0x7f => Escape,
                    _ => Ground,
                },
                Csi(mut tracker) => match byte {
                    0x40..=0x7e if !tracker.ignoring => {
                        tracker.finish_parameter();
                        if tracker.soft_reset && byte == b'p' {
                            self.synchronized_output = false;
                        } else if tracker.private && tracker.saw_2026 {
                            if byte == b'h' {
                                self.synchronized_output = true;
                            } else if byte == b'l' {
                                self.synchronized_output = false;
                            }
                        }
                        Ground
                    }
                    0x40..=0x7e => Ground,
                    b'?' if tracker.at_entry => {
                        tracker.private = true;
                        tracker.at_entry = false;
                        Csi(tracker)
                    }
                    b'!' if tracker.at_entry => {
                        tracker.soft_reset = true;
                        tracker.at_entry = false;
                        Csi(tracker)
                    }
                    b'0'..=b'9' if !tracker.ignoring => {
                        tracker.at_entry = false;
                        tracker.push_digit(byte - b'0');
                        Csi(tracker)
                    }
                    b';' if !tracker.ignoring => {
                        tracker.at_entry = false;
                        tracker.finish_parameter();
                        Csi(tracker)
                    }
                    b'<'..=b'?' => {
                        tracker.at_entry = false;
                        tracker.ignoring = true;
                        Csi(tracker)
                    }
                    _ => {
                        tracker.at_entry = false;
                        Csi(tracker)
                    }
                },
                Osc => match byte {
                    0x07 => Ground,
                    _ => Osc,
                },
                Dcs(state) => Dcs(state.feed_control(byte)),
                IgnoredString => IgnoredString,
            },
        };
    }

    fn feed_non_ascii(&mut self) {
        use LexicalState::*;
        self.state = match self.state {
            Ground => Ground,
            Osc => Osc,
            Csi(tracker) if tracker.ignoring => Csi(tracker),
            Dcs(DcsState::Ignore) => Dcs(DcsState::Ignore),
            Dcs(DcsState::Passthrough) => Dcs(DcsState::Passthrough),
            // xterm's transition table has no NON_ASCII_PRINTABLE transition
            // for these states, so its ERROR fallback returns to Ground.
            Escape | Csi(_) | Dcs(_) | IgnoredString => Ground,
        };
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum LexicalState {
    #[default]
    Ground,
    Escape,
    Csi(CsiTracker),
    Osc,
    Dcs(DcsState),
    IgnoredString,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DcsState {
    Entry,
    Param,
    Intermediate,
    Ignore,
    Passthrough,
}

impl DcsState {
    fn feed_control(self, byte: u8) -> Self {
        use DcsState::*;
        match self {
            Entry => match byte {
                0x20..=0x2f => Intermediate,
                0x30..=0x3f => Param,
                0x40..=0x7e => Passthrough,
                _ => Entry,
            },
            Param => match byte {
                0x20..=0x2f => Intermediate,
                0x30..=0x3b => Param,
                0x3c..=0x3f => Ignore,
                0x40..=0x7e => Passthrough,
                _ => Param,
            },
            Intermediate => match byte {
                0x20..=0x2f => Intermediate,
                0x30..=0x3f => Ignore,
                0x40..=0x7e => Passthrough,
                _ => Intermediate,
            },
            Ignore => Ignore,
            Passthrough => Passthrough,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CsiTracker {
    at_entry: bool,
    private: bool,
    current: u32,
    has_digits: bool,
    current_valid: bool,
    saw_2026: bool,
    soft_reset: bool,
    ignoring: bool,
}

impl Default for CsiTracker {
    fn default() -> Self {
        Self {
            at_entry: true,
            private: false,
            current: 0,
            has_digits: false,
            current_valid: true,
            saw_2026: false,
            soft_reset: false,
            ignoring: false,
        }
    }
}

impl CsiTracker {
    fn push_digit(&mut self, digit: u8) {
        self.has_digits = true;
        if !self.current_valid {
            return;
        }
        match self
            .current
            .checked_mul(10)
            .and_then(|value| value.checked_add(u32::from(digit)))
        {
            Some(value) => self.current = value,
            None => self.current_valid = false,
        }
    }

    fn finish_parameter(&mut self) {
        if self.has_digits && self.current_valid && self.current == 2026 {
            self.saw_2026 = true;
        }
        self.current = 0;
        self.has_digits = false;
        self.current_valid = true;
    }
}

/// Streaming UTF-8 classifier ported from the xterm version bundled by the UI.
/// Invalid starters/sequences are discarded, not replaced, and an invalid
/// continuation is reprocessed as a possible new starter. Keeping this local
/// avoids inventing a second text-decoding policy for the boundary tracker.
#[derive(Debug, Default)]
struct XtermUtf8Decoder {
    pending: [u8; 4],
    len: usize,
    expected: usize,
}

impl XtermUtf8Decoder {
    fn is_neutral(&self) -> bool {
        self.len == 0
    }

    fn feed(&mut self, byte: u8) -> Option<u32> {
        if self.len > 0 {
            if byte & 0xc0 != 0x80 {
                self.clear();
                return self.feed(byte);
            }
            self.pending[self.len] = byte;
            self.len += 1;
            if self.len < self.expected {
                return None;
            }
            let codepoint = self.decode_pending();
            let expected = self.expected;
            self.clear();
            return valid_xterm_codepoint(codepoint, expected).then_some(codepoint);
        }

        if byte < 0x80 {
            return Some(u32::from(byte));
        }
        self.expected = match byte {
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => return None,
        };
        self.pending[0] = byte;
        self.len = 1;
        None
    }

    fn decode_pending(&self) -> u32 {
        let mask = match self.expected {
            2 => 0x1f,
            3 => 0x0f,
            4 => 0x07,
            _ => return 0,
        };
        let mut codepoint = u32::from(self.pending[0] & mask);
        for &byte in &self.pending[1..self.expected] {
            codepoint = (codepoint << 6) | u32::from(byte & 0x3f);
        }
        codepoint
    }

    fn clear(&mut self) {
        self.pending.fill(0);
        self.len = 0;
        self.expected = 0;
    }
}

fn valid_xterm_codepoint(codepoint: u32, encoded_len: usize) -> bool {
    match encoded_len {
        2 => codepoint >= 0x80,
        3 => codepoint >= 0x800 && !(0xd800..=0xdfff).contains(&codepoint) && codepoint != 0xfeff,
        4 => (0x10000..=0x10ffff).contains(&codepoint),
        _ => false,
    }
}
