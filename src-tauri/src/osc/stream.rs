use super::{extract_osc_param, OscEvent};

const MAX_OSC_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Default)]
enum Phase {
    #[default]
    Ground,
    Escape,
    Osc,
    OscEscape,
    ControlString,
    ControlStringEscape,
}

/// Incremental OSC framing for one PTY generation. DCS, SOS, PM and APC
/// strings cannot introduce nested clipboard requests.
#[derive(Default)]
pub(crate) struct OscStream {
    phase: Phase,
    payload: Vec<u8>,
    oversized: bool,
    clipboard_epoch: Option<u64>,
}

impl OscStream {
    pub(crate) fn push(
        &mut self,
        mut data: &[u8],
        epoch: Option<u64>,
        mut emit: impl FnMut(OscEvent, Option<u64>),
    ) {
        if self.clipboard_epoch != epoch {
            self.clipboard_epoch = None;
        }
        while !data.is_empty() {
            if matches!(self.phase, Phase::Ground) {
                let Some(escape) = data.iter().position(|&byte| byte == 0x1b) else {
                    return;
                };
                self.phase = Phase::Escape;
                self.clipboard_epoch = epoch;
                data = &data[escape + 1..];
                continue;
            }
            let byte = data[0];
            data = &data[1..];
            self.phase = match (self.phase, byte) {
                (Phase::Escape, b']') => {
                    self.payload.clear();
                    self.oversized = false;
                    Phase::Osc
                }
                (Phase::Escape, b'P' | b'X' | b'^' | b'_') => Phase::ControlString,
                (Phase::Escape, 0x1b) | (Phase::OscEscape, 0x1b) => {
                    self.clipboard_epoch = epoch;
                    Phase::Escape
                }
                (Phase::Osc, 0x07) | (Phase::OscEscape, b'\\') => {
                    self.finish(&mut emit);
                    Phase::Ground
                }
                (Phase::Osc, 0x1b) => Phase::OscEscape,
                (Phase::OscEscape, b']') => {
                    self.payload.clear();
                    self.oversized = false;
                    self.clipboard_epoch = None;
                    Phase::Osc
                }
                (Phase::OscEscape, b'P' | b'X' | b'^' | b'_') => Phase::ControlString,
                (Phase::Osc, 0x18 | 0x1a)
                | (Phase::ControlString | Phase::ControlStringEscape, 0x18 | 0x1a)
                | (Phase::ControlStringEscape, b'\\')
                | (Phase::OscEscape | Phase::Escape, _) => Phase::Ground,
                (Phase::Osc, _) => {
                    if self.payload.len() < MAX_OSC_FRAME_BYTES {
                        self.payload.push(byte);
                    } else {
                        self.oversized = true;
                    }
                    Phase::Osc
                }
                (Phase::ControlString, 0x1b) => Phase::ControlStringEscape,
                (Phase::ControlString | Phase::ControlStringEscape, _) => Phase::ControlString,
                (Phase::Ground, _) => unreachable!(),
            };
        }
    }

    fn finish(&self, emit: &mut impl FnMut(OscEvent, Option<u64>)) {
        if self.oversized {
            return;
        }
        let Some(sep) = self.payload.iter().position(|&byte| byte == b';') else {
            return;
        };
        let code_bytes = &self.payload[..sep];
        if !code_bytes.iter().all(u8::is_ascii_digit) {
            return;
        }
        let Some(code) = std::str::from_utf8(code_bytes)
            .ok()
            .and_then(|code| code.parse::<u16>().ok())
        else {
            return;
        };
        let raw = String::from_utf8_lossy(&self.payload[sep + 1..]);
        if raw.is_empty() && !matches!(code, 0 | 2 | 133) {
            return;
        }
        let (param, data) = extract_osc_param(code, &raw);
        emit(OscEvent { code, param, data }, self.clipboard_epoch);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_bel_and_st_at_every_chunk_boundary() {
        for frame in [
            b"\x1b]52;c;7ZWc6riA\x07".as_slice(),
            b"\x1b]52;c;7ZWc6riA\x1b\\",
        ] {
            for split in 0..=frame.len() {
                let mut stream = OscStream::default();
                let mut events = Vec::new();
                stream.push(&frame[..split], Some(3), |e, epoch| events.push((e, epoch)));
                stream.push(&frame[split..], Some(3), |e, epoch| events.push((e, epoch)));
                assert_eq!(events.len(), 1, "split {split}");
                assert_eq!(events[0].0.code, 52);
                assert_eq!(events[0].0.data, "c;7ZWc6riA");
                assert_eq!(events[0].1, Some(3));
            }
        }
    }

    #[test]
    fn incomplete_or_replayed_clipboard_request_cannot_gain_focus() {
        for old_epoch in [None, Some(4)] {
            let mut stream = OscStream::default();
            let mut epochs = Vec::new();
            stream.push(b"\x1b]52;c;YW", old_epoch, |_, epoch| epochs.push(epoch));
            stream.push(b"Jj\x07\x1b]52;c;YWJj\x07", Some(5), |_, epoch| {
                epochs.push(epoch)
            });
            assert_eq!(epochs, [None, Some(5)]);
        }
    }

    #[test]
    fn ignores_nested_canceled_and_malformed_frames_and_keeps_ordinary_hooks() {
        let mut events = Vec::new();
        OscStream::default().push(
            b"\x1bPt\x1b\x1b]52;c;YWJj\x07\x1b\\\x1b]52;c;YWJj\x18\x1b]52;c;YWJj\x1bZ\x1b]133;D;0\x07",
            Some(5),
            |event, _| events.push(event),
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].code, 133);
        assert_eq!(events[0].param.as_deref(), Some("D"));
        assert_eq!(events[0].data, "0");
    }
}
