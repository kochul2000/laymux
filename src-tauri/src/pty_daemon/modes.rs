//! Terminal input/display modes a daemon session derives from its PTY output
//! (ADR-0303).
//!
//! An application sets modes such as bracketed paste once and never repeats
//! them, while a re-adopting GUI starts from terminal defaults. The daemon is
//! the only party that sees all output, including output produced while no GUI
//! was attached, so it tracks the modes and hands a fresh GUI a preamble that
//! re-asserts the ones that differ from the defaults. The tracker only
//! observes: output is relayed unchanged and nothing here answers a query.
//!
//! The GUI terminal is xterm.js, so every transition follows xterm.js
//! semantics: re-asserting a mode must leave the fresh GUI exactly where the
//! previous one was.

/// Parameters kept per control sequence; later ones are ignored.
const MAX_PARAMS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MouseTracking {
    X10 = 9,
    Normal = 1000,
    ButtonEvent = 1002,
    AnyEvent = 1003,
}

/// Only the encodings xterm.js implements; it ignores 1005 and 1015.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MouseEncoding {
    Sgr = 1006,
    SgrPixels = 1016,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalModes {
    application_cursor: bool,
    autowrap: bool,
    cursor_visible: bool,
    focus_events: bool,
    bracketed_paste: bool,
    alternate_screen: bool,
    insert_mode: bool,
    application_keypad: bool,
    mouse_tracking: Option<MouseTracking>,
    mouse_encoding: Option<MouseEncoding>,
    parser: Parser,
}

impl Default for TerminalModes {
    fn default() -> Self {
        Self {
            application_cursor: false,
            autowrap: true,
            cursor_visible: true,
            focus_events: false,
            bracketed_paste: false,
            alternate_screen: false,
            insert_mode: false,
            application_keypad: false,
            mouse_tracking: None,
            mouse_encoding: None,
            parser: Parser::default(),
        }
    }
}

impl TerminalModes {
    /// Feed the next raw output chunk. Sequences may span chunks.
    pub fn process(&mut self, data: &[u8]) {
        let mut actions = Vec::new();
        for &byte in data {
            self.parser.feed(byte, &mut actions);
            for action in actions.drain(..) {
                self.apply(action);
            }
        }
    }

    /// Bytes that bring a terminal in its default state to these modes. They
    /// only set modes and contain no query; the one reply they can cause is
    /// the focus report xterm.js sends when focus events turn on, which the
    /// application asked for by enabling them. Alternate screen comes first:
    /// entering it must not undo the modes asserted after it.
    pub fn preamble(&self) -> Vec<u8> {
        let defaults = Self::default();
        let mut set = Vec::new();
        let mut reset = Vec::new();
        let mut private = |enabled: bool, default: bool, mode: u32| {
            if enabled != default {
                if enabled { &mut set } else { &mut reset }.push(mode);
            }
        };
        private(self.application_cursor, defaults.application_cursor, 1);
        private(self.autowrap, defaults.autowrap, 7);
        private(self.cursor_visible, defaults.cursor_visible, 25);
        private(self.focus_events, defaults.focus_events, 1004);
        private(self.bracketed_paste, defaults.bracketed_paste, 2004);
        if let Some(tracking) = self.mouse_tracking {
            set.push(tracking as u32);
        }
        if let Some(encoding) = self.mouse_encoding {
            set.push(encoding as u32);
        }

        let mut out = Vec::new();
        if self.alternate_screen {
            out.extend_from_slice(b"\x1b[?1049h");
        }
        for mode in set {
            out.extend_from_slice(format!("\x1b[?{mode}h").as_bytes());
        }
        for mode in reset {
            out.extend_from_slice(format!("\x1b[?{mode}l").as_bytes());
        }
        if self.insert_mode {
            out.extend_from_slice(b"\x1b[4h");
        }
        if self.application_keypad {
            out.extend_from_slice(b"\x1b=");
        }
        out
    }

    fn apply(&mut self, action: Action) {
        match action {
            Action::Private { mode, enabled } => self.set_private(mode, enabled),
            Action::InsertMode(enabled) => self.insert_mode = enabled,
            Action::Keypad(enabled) => self.application_keypad = enabled,
            Action::FullReset => {
                let parser = std::mem::take(&mut self.parser);
                *self = Self {
                    parser,
                    ..Self::default()
                };
            }
            Action::SoftReset => {
                // xterm.js DECSTR resets the insert mode and all default DEC
                // private modes; screen buffer and mouse state survive.
                self.insert_mode = false;
                self.application_cursor = false;
                self.application_keypad = false;
                self.cursor_visible = true;
                self.autowrap = true;
                self.focus_events = false;
                self.bracketed_paste = false;
            }
        }
    }

    fn set_private(&mut self, mode: u32, enabled: bool) {
        match mode {
            1 => self.application_cursor = enabled,
            7 => self.autowrap = enabled,
            25 => self.cursor_visible = enabled,
            1004 => self.focus_events = enabled,
            2004 => self.bracketed_paste = enabled,
            47 | 1047 | 1049 => self.alternate_screen = enabled,
            // One active tracking protocol; resetting any of them turns
            // tracking off, as in xterm.js and xterm.
            9 | 1000 | 1002 | 1003 => {
                self.mouse_tracking = enabled.then_some(match mode {
                    9 => MouseTracking::X10,
                    1000 => MouseTracking::Normal,
                    1002 => MouseTracking::ButtonEvent,
                    _ => MouseTracking::AnyEvent,
                });
            }
            // Resetting either encoding returns to the default encoding.
            1006 | 1016 => {
                self.mouse_encoding = enabled.then_some(if mode == 1006 {
                    MouseEncoding::Sgr
                } else {
                    MouseEncoding::SgrPixels
                });
            }
            _ => {}
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Private { mode: u32, enabled: bool },
    InsertMode(bool),
    Keypad(bool),
    FullReset,
    SoftReset,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum State {
    #[default]
    Ground,
    Escape,
    Csi(Csi),
}

/// A control sequence being parsed. Fixed-size, so parsing allocates nothing
/// while the session's sink lock is held.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Csi {
    /// `?`, `>`, `<` or `=` right after the introducer.
    marker: Option<u8>,
    /// First intermediate byte (0x20..=0x2f), e.g. `!` of DECSTR.
    intermediate: Option<u8>,
    params: [Option<u32>; MAX_PARAMS],
    param_count: usize,
    current: Option<u32>,
    /// Bytes seen since the introducer; a marker is only valid first.
    len: usize,
    /// Malformed or overflowing: consume to the final byte, then ignore.
    invalid: bool,
}

impl Csi {
    fn finish_param(&mut self) {
        if self.param_count < MAX_PARAMS {
            self.params[self.param_count] = self.current;
            self.param_count += 1;
        }
        self.current = None;
    }

    fn params(&self) -> impl Iterator<Item = u32> + '_ {
        self.params[..self.param_count].iter().flatten().copied()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Parser {
    state: State,
}

impl Parser {
    /// Advance by one byte, appending any completed mode changes to `out`.
    fn feed(&mut self, byte: u8, out: &mut Vec<Action>) {
        match std::mem::take(&mut self.state) {
            State::Ground => {
                if byte == 0x1b {
                    self.state = State::Escape;
                }
            }
            State::Escape => match byte {
                0x1b => self.state = State::Escape,
                b'[' => self.state = State::Csi(Csi::default()),
                b'c' => out.push(Action::FullReset),
                b'=' => out.push(Action::Keypad(true)),
                b'>' => out.push(Action::Keypad(false)),
                _ => {}
            },
            State::Csi(mut csi) => {
                match byte {
                    0x1b => {
                        self.state = State::Escape;
                        return;
                    }
                    // CAN/SUB abort the sequence.
                    0x18 | 0x1a => return,
                    // Other C0 controls execute without ending the sequence.
                    0x00..=0x1f | 0x7f => {
                        self.state = State::Csi(csi);
                        return;
                    }
                    b'?' | b'>' | b'<' | b'=' if csi.len == 0 => csi.marker = Some(byte),
                    b'0'..=b'9' if csi.intermediate.is_none() => {
                        let digit = u32::from(byte - b'0');
                        match csi
                            .current
                            .unwrap_or(0)
                            .checked_mul(10)
                            .and_then(|value| value.checked_add(digit))
                        {
                            Some(value) => csi.current = Some(value),
                            None => csi.invalid = true,
                        }
                    }
                    b';' | b':' if csi.intermediate.is_none() => csi.finish_param(),
                    0x20..=0x2f => {
                        if csi.intermediate.is_some() {
                            csi.invalid = true;
                        }
                        csi.intermediate = Some(byte);
                    }
                    // Parameter bytes in an unexpected place.
                    0x30..=0x3f => csi.invalid = true,
                    0x40..=0x7e => {
                        csi.finish_param();
                        if !csi.invalid {
                            dispatch(&csi, byte, out);
                        }
                        return;
                    }
                    _ => csi.invalid = true,
                }
                csi.len += 1;
                self.state = State::Csi(csi);
            }
        }
    }
}

fn dispatch(csi: &Csi, final_byte: u8, out: &mut Vec<Action>) {
    let enabled = final_byte == b'h';
    match (csi.marker, csi.intermediate, final_byte) {
        (Some(b'?'), None, b'h' | b'l') => {
            out.extend(csi.params().map(|mode| Action::Private { mode, enabled }))
        }
        (None, None, b'h' | b'l') => {
            if csi.params().any(|mode| mode == 4) {
                out.push(Action::InsertMode(enabled));
            }
        }
        (None, Some(b'!'), b'p') => out.push(Action::SoftReset),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_protocol::TerminalProtocolState;

    fn modes_after(chunks: &[&[u8]]) -> TerminalModes {
        let mut modes = TerminalModes::default();
        for chunk in chunks {
            modes.process(chunk);
        }
        modes
    }

    #[test]
    fn defaults_need_no_preamble() {
        assert!(TerminalModes::default().preamble().is_empty());
        // Setting and clearing again lands back on the defaults.
        assert!(
            modes_after(&[b"\x1b[?2004h\x1b[?1h", b"\x1b[?1l\x1b[?2004l"])
                .preamble()
                .is_empty()
        );
    }

    #[test]
    fn sequences_split_across_chunks_are_tracked() {
        let modes = modes_after(&[b"text\x1b", b"[?20", b"04", b"h more"]);
        assert_eq!(modes.preamble(), b"\x1b[?2004h");
    }

    #[test]
    fn several_modes_in_one_sequence_all_apply() {
        let modes = modes_after(&[b"\x1b[?1;25;2004l\x1b[?1;2004h"]);
        assert_eq!(modes.preamble(), b"\x1b[?1h\x1b[?2004h\x1b[?25l");
    }

    #[test]
    fn alternate_screen_comes_first_and_mouse_follows_xterm_js() {
        let modes = modes_after(&[b"\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1049h\x1b[?1004h"]);
        assert_eq!(
            modes.preamble(),
            b"\x1b[?1049h\x1b[?1004h\x1b[?1002h\x1b[?1006h"
        );
        // Resetting any tracking protocol turns tracking off, even one that
        // is not the active protocol.
        assert!(modes_after(&[b"\x1b[?1003h\x1b[?1000l"])
            .preamble()
            .is_empty());
        // xterm.js ignores the UTF-8 and urxvt encodings, so they neither
        // replace SGR nor get re-asserted.
        assert_eq!(
            modes_after(&[b"\x1b[?1006h\x1b[?1015h\x1b[?1005h"]).preamble(),
            b"\x1b[?1006h"
        );
        // Resetting either SGR encoding returns to the default encoding.
        assert!(modes_after(&[b"\x1b[?1016h\x1b[?1006l"])
            .preamble()
            .is_empty());
    }

    #[test]
    fn full_and_soft_reset_follow_xterm_js() {
        assert!(modes_after(&[b"\x1b[?2004h\x1b[?1049h\x1b=", b"\x1bc"])
            .preamble()
            .is_empty());
        // DECSTR resets input and focus modes but keeps screen and mouse state.
        let soft = modes_after(&[
            b"\x1b[?2004h\x1b[?1h\x1b[4h\x1b=\x1b[?1004h\x1b[?1049h\x1b[?1000h",
            b"\x1b[!p",
        ]);
        assert_eq!(soft.preamble(), b"\x1b[?1049h\x1b[?1000h");
    }

    #[test]
    fn keypad_and_insert_mode_are_restored() {
        let modes = modes_after(&[b"\x1b=\x1b[4h"]);
        assert_eq!(modes.preamble(), b"\x1b[4h\x1b=");
        assert!(modes_after(&[b"\x1b=\x1b[4h\x1b>\x1b[4l"])
            .preamble()
            .is_empty());
    }

    #[test]
    fn unrelated_and_malformed_sequences_change_nothing() {
        let modes = modes_after(&[
            b"\x1b[31m\x1b[2J\x1b]0;title\x07\x1b[?2004\x18h",
            b"\x1b[?20;04$h\x1b[1;2004h\x1b[?99999999999h",
            // modifyOtherKeys, kitty keyboard, DECRQM, charset and DECSC.
            b"\x1b[>4;2m\x1b[>1u\x1b[?2004$p\x1b(=\x1b7",
        ]);
        assert!(modes.preamble().is_empty());
    }

    #[test]
    fn the_preamble_is_a_query_free_replay_of_the_tracked_state() {
        let modes = modes_after(&[b"\x1b[?2004h\x1b[?1h\x1b[?1049h\x1b[?1003h\x1b[?1006h"]);
        let preamble = modes.preamble();
        // Replaying it reproduces the same state...
        assert_eq!(modes_after(&[&preamble]).preamble(), preamble);
        // ...turns on the GUI's bracketed-paste encoding...
        let mut protocol = TerminalProtocolState::new();
        protocol.process_output(&preamble);
        assert!(protocol.bracketed_paste());
        // ...and consists only of mode settings, never a query a terminal
        // would answer (DA `c`, DSR `n`, DECRQM `$p`, window ops `t`, ...).
        let text = String::from_utf8(preamble).unwrap();
        for sequence in text.split('\x1b').filter(|s| !s.is_empty()) {
            assert!(
                sequence == "="
                    || (sequence.starts_with('[')
                        && sequence.ends_with(['h', 'l'])
                        && !sequence.contains('$')),
                "{sequence:?} in {text:?} is not a plain mode setting"
            );
        }
    }
}
