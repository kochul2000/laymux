#[derive(Debug, Default)]
pub(super) struct GeometryBoundaryTracker {
    state: LexicalState,
    synchronized_output: bool,
}

impl GeometryBoundaryTracker {
    pub(super) fn feed(&mut self, data: &[u8]) {
        for &byte in data {
            self.feed_byte(byte);
        }
    }

    pub(super) fn is_neutral(&self) -> bool {
        self.state == LexicalState::Ground && !self.synchronized_output
    }

    fn feed_byte(&mut self, byte: u8) {
        use LexicalState::*;
        self.state = match self.state {
            Ground => match byte {
                0x1b => Escape,
                0x9b => Csi(CsiTracker::default()),
                0x9d => ControlString(ControlStringKind::Osc),
                0x90 | 0x98 | 0x9e | 0x9f => ControlString(ControlStringKind::StOnly),
                _ => Ground,
            },
            Escape => match byte {
                b'[' => Csi(CsiTracker::default()),
                b']' => ControlString(ControlStringKind::Osc),
                b'P' | b'X' | b'^' | b'_' => ControlString(ControlStringKind::StOnly),
                b'c' => {
                    self.synchronized_output = false;
                    Ground
                }
                0x1b => Escape,
                _ => Ground,
            },
            Csi(mut tracker) => match byte {
                0x1b => Escape,
                0x18 | 0x1a => Ground,
                0x40..=0x7e => {
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
                b'0'..=b'9' => {
                    tracker.at_entry = false;
                    tracker.push_digit(byte - b'0');
                    Csi(tracker)
                }
                b';' => {
                    tracker.at_entry = false;
                    tracker.finish_parameter();
                    Csi(tracker)
                }
                _ => {
                    tracker.at_entry = false;
                    Csi(tracker)
                }
            },
            ControlString(kind) => match byte {
                0x18 | 0x1a | 0x9c => Ground,
                0x07 if kind == ControlStringKind::Osc => Ground,
                0x1b => ControlStringEscape(kind),
                _ => ControlString(kind),
            },
            ControlStringEscape(kind) => match byte {
                b'\\' => Ground,
                0x1b => ControlStringEscape(kind),
                0x18 | 0x1a => Ground,
                _ => ControlString(kind),
            },
        };
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum LexicalState {
    #[default]
    Ground,
    Escape,
    Csi(CsiTracker),
    ControlString(ControlStringKind),
    ControlStringEscape(ControlStringKind),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ControlStringKind {
    Osc,
    StOnly,
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
