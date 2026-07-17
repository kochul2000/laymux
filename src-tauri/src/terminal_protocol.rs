//! Authoritative terminal protocol state derived from the complete PTY output stream.
//!
//! This module deliberately has no Tauri or application-state dependencies. A caller can
//! keep one [`TerminalProtocolState`] behind each terminal's protocol mutex, feed every PTY
//! output chunk to [`TerminalProtocolState::process_output`], and capture a
//! [`TerminalProtocolSnapshot`] before encoding structured input.

use std::fmt;

/// Bracketed-paste prefix emitted around non-empty structured text.
pub const BRACKETED_PASTE_BEGIN: &[u8] = b"\x1b[200~";

/// Bracketed-paste suffix emitted around non-empty structured text.
pub const BRACKETED_PASTE_END: &[u8] = b"\x1b[201~";

/// Copyable public view of the protocol state at one output-stream revision.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TerminalProtocolSnapshot {
    pub bracketed_paste: bool,
    pub revision: u64,
}

/// Streaming protocol state for a single PTY session.
#[derive(Debug, Default)]
pub struct TerminalProtocolState {
    bracketed_paste: bool,
    revision: u64,
    parser: ProtocolParser,
}

impl TerminalProtocolState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed the next raw PTY output chunk.
    ///
    /// Returns `true` when at least one effective protocol-state transition occurred.
    pub fn process_output(&mut self, data: &[u8]) -> bool {
        let mut changed = false;
        for &byte in data {
            if let Some(action) = self.parser.feed_byte(byte) {
                changed |= self.apply_action(action);
            }
        }
        changed
    }

    pub fn snapshot(&self) -> TerminalProtocolSnapshot {
        TerminalProtocolSnapshot {
            bracketed_paste: self.bracketed_paste,
            revision: self.revision,
        }
    }

    pub fn bracketed_paste(&self) -> bool {
        self.bracketed_paste
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Reset protocol modes to their terminal-reset defaults.
    ///
    /// Returns `true` only when this changes an effective mode.
    pub fn reset(&mut self) -> bool {
        self.parser.reset();
        self.set_bracketed_paste(false)
    }

    fn apply_action(&mut self, action: ProtocolAction) -> bool {
        match action {
            ProtocolAction::SetBracketedPaste(enabled) => self.set_bracketed_paste(enabled),
            ProtocolAction::Reset => self.set_bracketed_paste(false),
        }
    }

    fn set_bracketed_paste(&mut self, enabled: bool) -> bool {
        if self.bracketed_paste == enabled {
            return false;
        }
        self.bracketed_paste = enabled;
        self.revision = self.revision.saturating_add(1);
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProtocolAction {
    SetBracketedPaste(bool),
    Reset,
}

#[derive(Debug, Default)]
struct ProtocolParser {
    state: ParserState,
}

impl ProtocolParser {
    fn reset(&mut self) {
        self.state = ParserState::Ground;
    }

    fn feed_byte(&mut self, byte: u8) -> Option<ProtocolAction> {
        use ParserState::*;

        match self.state {
            Ground => {
                if byte == 0x1b {
                    self.state = Escape;
                }
                None
            }
            Escape => match byte {
                0x1b => None,
                b'[' => {
                    self.state = CsiEntry;
                    None
                }
                b'c' => {
                    self.state = Ground;
                    Some(ProtocolAction::Reset)
                }
                _ => {
                    self.state = Ground;
                    None
                }
            },
            CsiEntry => match byte {
                0x1b => {
                    self.state = Escape;
                    None
                }
                0x18 | 0x1a => {
                    self.state = Ground;
                    None
                }
                b'?' => {
                    self.state = CsiPrivate(PrivateParams::default());
                    None
                }
                b'!' => {
                    self.state = CsiBang;
                    None
                }
                0x40..=0x7e => {
                    self.state = Ground;
                    None
                }
                // C0 controls are executed by a terminal parser without ending CSI.
                0x00..=0x1f | 0x7f => None,
                0x20..=0x3f => {
                    self.state = CsiIgnore;
                    None
                }
                _ => {
                    self.state = CsiIgnore;
                    None
                }
            },
            CsiPrivate(mut params) => match byte {
                0x1b => {
                    self.state = Escape;
                    None
                }
                0x18 | 0x1a => {
                    self.state = Ground;
                    None
                }
                b'0'..=b'9' => {
                    params.push_digit(byte - b'0');
                    self.state = CsiPrivate(params);
                    None
                }
                b';' => {
                    params.finish_parameter();
                    self.state = CsiPrivate(params);
                    None
                }
                b'h' | b'l' => {
                    params.finish_parameter();
                    self.state = Ground;
                    params
                        .saw_2004
                        .then_some(ProtocolAction::SetBracketedPaste(byte == b'h'))
                }
                0x40..=0x7e => {
                    self.state = Ground;
                    None
                }
                // C0 controls are transparent inside CSI; DEL is ignored.
                0x00..=0x1f | 0x7f => {
                    self.state = CsiPrivate(params);
                    None
                }
                _ => {
                    self.state = CsiIgnore;
                    None
                }
            },
            CsiBang => match byte {
                0x1b => {
                    self.state = Escape;
                    None
                }
                0x18 | 0x1a => {
                    self.state = Ground;
                    None
                }
                b'p' => {
                    self.state = Ground;
                    Some(ProtocolAction::Reset)
                }
                0x40..=0x7e => {
                    self.state = Ground;
                    None
                }
                0x00..=0x1f | 0x7f => None,
                _ => {
                    self.state = CsiIgnore;
                    None
                }
            },
            CsiIgnore => {
                match byte {
                    0x1b => self.state = Escape,
                    0x18 | 0x1a | 0x40..=0x7e => self.state = Ground,
                    _ => {}
                }
                None
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
enum ParserState {
    #[default]
    Ground,
    Escape,
    CsiEntry,
    CsiPrivate(PrivateParams),
    CsiBang,
    CsiIgnore,
}

#[derive(Debug, Clone, Copy)]
struct PrivateParams {
    current: u32,
    has_digits: bool,
    current_valid: bool,
    saw_2004: bool,
}

impl Default for PrivateParams {
    fn default() -> Self {
        Self {
            current: 0,
            has_digits: false,
            current_valid: true,
            saw_2004: false,
        }
    }
}

impl PrivateParams {
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
        if self.has_digits && self.current_valid && self.current == 2004 {
            self.saw_2004 = true;
        }
        self.current = 0;
        self.has_digits = false;
        self.current_valid = true;
    }
}

/// Structured-input encoding failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalInputEncodeError {
    PayloadTooLarge {
        encoded_bytes: usize,
        max_bytes: usize,
    },
}

impl fmt::Display for TerminalInputEncodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PayloadTooLarge {
                encoded_bytes,
                max_bytes,
            } => write!(
                f,
                "encoded terminal input is {encoded_bytes} bytes, exceeding the {max_bytes}-byte limit"
            ),
        }
    }
}

impl std::error::Error for TerminalInputEncodeError {}

/// Encode one structured terminal input job.
///
/// `max_bytes` bounds the complete physical payload returned by this function, including
/// bracketed-paste markers and the optional submit CR.
pub fn encode_terminal_input(
    text: &str,
    submit: bool,
    bracketed: bool,
    max_bytes: usize,
) -> Result<Vec<u8>, TerminalInputEncodeError> {
    let normalized_bytes = normalized_len(text.as_bytes());
    let marker_bytes = if bracketed && normalized_bytes > 0 {
        BRACKETED_PASTE_BEGIN.len() + BRACKETED_PASTE_END.len()
    } else {
        0
    };
    let encoded_bytes = normalized_bytes
        .checked_add(marker_bytes)
        .and_then(|size| size.checked_add(usize::from(submit)))
        .unwrap_or(usize::MAX);

    if encoded_bytes > max_bytes {
        return Err(TerminalInputEncodeError::PayloadTooLarge {
            encoded_bytes,
            max_bytes,
        });
    }

    let mut encoded = Vec::with_capacity(encoded_bytes);
    if normalized_bytes > 0 {
        if bracketed {
            encoded.extend_from_slice(BRACKETED_PASTE_BEGIN);
        }
        push_normalized(&mut encoded, text.as_bytes());
        if bracketed {
            encoded.extend_from_slice(BRACKETED_PASTE_END);
        }
    }
    if submit {
        encoded.push(b'\r');
    }
    Ok(encoded)
}

fn normalized_len(data: &[u8]) -> usize {
    let mut index = 0;
    let mut len = 0;
    while index < data.len() {
        len += 1;
        if data[index] == b'\r' && data.get(index + 1) == Some(&b'\n') {
            index += 2;
        } else {
            index += 1;
        }
    }
    len
}

fn push_normalized(output: &mut Vec<u8>, data: &[u8]) {
    let mut index = 0;
    while index < data.len() {
        match data[index] {
            b'\r' => {
                output.push(b'\r');
                index += if data.get(index + 1) == Some(&b'\n') {
                    2
                } else {
                    1
                };
            }
            b'\n' => {
                output.push(b'\r');
                index += 1;
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests;
