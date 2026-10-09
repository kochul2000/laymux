//! Terminal input/display modes a daemon session derives from its PTY output
//! (ADR-0302).
//!
//! An application sets modes such as bracketed paste once and never repeats
//! them, while a re-adopting GUI starts from terminal defaults. The daemon is
//! the only party that sees all output, including output produced while no GUI
//! was attached, so it tracks the modes and hands a fresh GUI a preamble that
//! re-asserts the ones that differ from the defaults. The tracker only
//! observes: output is relayed unchanged and nothing here answers a query.

/// Kitty keyboard flag stack depth kept per session; deeper pushes drop the
/// oldest entry, as terminals bound the stack too.
const KITTY_STACK_LIMIT: usize = 16;

/// Parameters kept per control sequence; later ones are ignored.
const MAX_PARAMS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MouseTracking {
    X10 = 9,
    Normal = 1000,
    ButtonEvent = 1002,
    AnyEvent = 1003,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MouseEncoding {
    Utf8 = 1005,
    Sgr = 1006,
    Urxvt = 1015,
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
    kitty_flags: u32,
    kitty_stack: Vec<u32>,
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
            kitty_flags: 0,
            kitty_stack: Vec::new(),
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
    /// only set modes and never contain a query, so writing them produces no
    /// reply. Alternate screen comes first: entering it must not undo the
    /// modes asserted after it.
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
        if self.kitty_flags != 0 {
            out.extend_from_slice(format!("\x1b[={};1u", self.kitty_flags).as_bytes());
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
                // The modes xterm.js resets on DECSTR, plus bracketed paste so
                // this agrees with the GUI's input encoder (`terminal_protocol`).
                self.insert_mode = false;
                self.application_cursor = false;
                self.application_keypad = false;
                self.cursor_visible = true;
                self.autowrap = true;
                self.bracketed_paste = false;
            }
            Action::KittyPush(flags) => {
                if self.kitty_stack.len() == KITTY_STACK_LIMIT {
                    self.kitty_stack.remove(0);
                }
                self.kitty_stack.push(self.kitty_flags);
                self.kitty_flags = flags;
            }
            Action::KittyPop(count) => {
                for _ in 0..count.max(1) {
                    match self.kitty_stack.pop() {
                        Some(flags) => self.kitty_flags = flags,
                        None => {
                            self.kitty_flags = 0;
                            break;
                        }
                    }
                }
            }
            Action::KittySet { flags, mode } => {
                self.kitty_flags = match mode {
                    2 => self.kitty_flags | flags,
                    3 => self.kitty_flags & !flags,
                    _ => flags,
                };
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
            9 | 1000 | 1002 | 1003 => {
                let tracking = match mode {
                    9 => MouseTracking::X10,
                    1000 => MouseTracking::Normal,
                    1002 => MouseTracking::ButtonEvent,
                    _ => MouseTracking::AnyEvent,
                };
                if enabled {
                    self.mouse_tracking = Some(tracking);
                } else if self.mouse_tracking == Some(tracking) {
                    self.mouse_tracking = None;
                }
            }
            1005 | 1006 | 1015 | 1016 => {
                let encoding = match mode {
                    1005 => MouseEncoding::Utf8,
                    1006 => MouseEncoding::Sgr,
                    1015 => MouseEncoding::Urxvt,
                    _ => MouseEncoding::SgrPixels,
                };
                if enabled {
                    self.mouse_encoding = Some(encoding);
                } else if self.mouse_encoding == Some(encoding) {
                    self.mouse_encoding = None;
                }
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
    KittyPush(u32),
    KittyPop(u32),
    KittySet { flags: u32, mode: u32 },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
enum State {
    #[default]
    Ground,
    Escape,
    Csi(Csi),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Csi {
    /// `?`, `>`, `<` or `=` right after the introducer.
    marker: Option<u8>,
    /// First intermediate byte (0x20..=0x2f), e.g. `!` of DECSTR.
    intermediate: Option<u8>,
    params: Vec<Option<u32>>,
    current: Option<u32>,
    /// Bytes seen since the introducer; a marker is only valid first.
    len: usize,
    /// Malformed or overflowing: consume to the final byte, then ignore.
    invalid: bool,
}

impl Csi {
    fn finish_param(&mut self) {
        if self.params.len() < MAX_PARAMS {
            self.params.push(self.current.take());
        }
        self.current = None;
    }

    fn param(&self, index: usize) -> Option<u32> {
        self.params.get(index).copied().flatten()
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
        (Some(b'?'), None, b'h' | b'l') => out.extend(
            csi.params
                .iter()
                .flatten()
                .map(|&mode| Action::Private { mode, enabled }),
        ),
        (None, None, b'h' | b'l') => {
            if csi.params.iter().flatten().any(|&mode| mode == 4) {
                out.push(Action::InsertMode(enabled));
            }
        }
        (None, Some(b'!'), b'p') => out.push(Action::SoftReset),
        (Some(b'>'), None, b'u') => out.push(Action::KittyPush(csi.param(0).unwrap_or(0))),
        (Some(b'<'), None, b'u') => out.push(Action::KittyPop(csi.param(0).unwrap_or(1))),
        (Some(b'='), None, b'u') => out.push(Action::KittySet {
            flags: csi.param(0).unwrap_or(0),
            mode: csi.param(1).unwrap_or(1),
        }),
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
    fn alternate_screen_comes_first_and_mouse_keeps_one_active_level() {
        let modes = modes_after(&[
            b"\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1049h\x1b[?1004h",
            // Clearing a level that is not active leaves the active one.
            b"\x1b[?1000l",
        ]);
        assert_eq!(
            modes.preamble(),
            b"\x1b[?1049h\x1b[?1004h\x1b[?1002h\x1b[?1006h"
        );
        let cleared = modes_after(&[b"\x1b[?1002h\x1b[?1006h\x1b[?1002l\x1b[?1006l"]);
        assert!(cleared.preamble().is_empty());
    }

    #[test]
    fn full_and_soft_reset_return_to_defaults() {
        assert!(
            modes_after(&[b"\x1b[?2004h\x1b[?1049h\x1b[>5u\x1b=", b"\x1bc"])
                .preamble()
                .is_empty()
        );
        // DECSTR resets input modes but keeps screen and mouse state.
        let soft = modes_after(&[b"\x1b[?2004h\x1b[?1h\x1b[4h\x1b=\x1b[?1000h", b"\x1b[!p"]);
        assert_eq!(soft.preamble(), b"\x1b[?1000h");
    }

    #[test]
    fn keypad_insert_mode_and_kitty_flags_are_restored() {
        let modes = modes_after(&[b"\x1b=\x1b[4h\x1b[>1u\x1b[>3u"]);
        assert_eq!(modes.preamble(), b"\x1b[4h\x1b=\x1b[=3;1u");
        // Pop returns to the pushed value; popping past the bottom is zero.
        assert_eq!(
            modes_after(&[b"\x1b[>1u\x1b[>3u\x1b[<u"]).preamble(),
            b"\x1b[=1;1u"
        );
        assert!(modes_after(&[b"\x1b[>1u\x1b[<5u"]).preamble().is_empty());
        // `=` sets, ors or clears flags.
        assert_eq!(
            modes_after(&[b"\x1b[=1u\x1b[=4;2u\x1b[=1;3u"]).preamble(),
            b"\x1b[=4;1u"
        );
    }

    #[test]
    fn unrelated_and_malformed_sequences_change_nothing() {
        let modes = modes_after(&[
            b"\x1b[31m\x1b[2J\x1b]0;title\x07\x1b[?2004\x18h",
            b"\x1b[?20;04$h\x1b[1;2004h\x1b[?99999999999h",
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
                        && sequence.ends_with(['h', 'l', 'u'])
                        && !sequence.contains('$')),
                "{sequence:?} in {text:?} is not a plain mode setting"
            );
        }
    }
}
