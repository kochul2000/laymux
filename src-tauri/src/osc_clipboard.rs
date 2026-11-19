use base64::prelude::{Engine, BASE64_STANDARD};

const MAX_TEXT_BYTES: usize = 64 * 1024;

fn decode_write(data: &str) -> Option<String> {
    let encoded = data.strip_prefix("c;")?;
    if encoded.is_empty() || encoded.len() > MAX_TEXT_BYTES.div_ceil(3) * 4 {
        return None;
    }
    let decoded = BASE64_STANDARD.decode(encoded).ok()?;
    if decoded.len() > MAX_TEXT_BYTES || decoded.contains(&0) {
        return None;
    }
    String::from_utf8(decoded).ok()
}

#[cfg(windows)]
mod windows {
    use std::sync::Mutex;

    use crate::lock_ext::MutexExt;
    use crate::terminal_output::TerminalOutputSession;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    #[derive(PartialEq, Eq)]
    struct Target {
        window_handle: usize,
        terminal_id: String,
        generation: u64,
    }

    impl Target {
        fn is_foreground(&self, terminal_id: &str, generation: u64) -> bool {
            self.terminal_id == terminal_id
                && self.generation == generation
                && self.window_handle == unsafe { GetForegroundWindow() } as usize
        }
    }

    #[derive(Default)]
    struct FocusState {
        target: Option<Target>,
        epoch: u64,
    }

    /// A leaf lock. Focus updates serialize with the bounded clipboard write.
    #[derive(Default)]
    pub(crate) struct ClipboardFocus(Mutex<FocusState>);

    impl ClipboardFocus {
        pub(crate) fn update(
            &self,
            window_handle: usize,
            terminal_id: Option<String>,
            generation: Option<u64>,
        ) -> Result<(), crate::error::AppError> {
            let target = terminal_id
                .zip(generation)
                .map(|(terminal_id, generation)| Target {
                    window_handle,
                    terminal_id,
                    generation,
                });
            let mut state = self.0.lock_or_err()?;
            if state.target != target {
                state.epoch = state.epoch.wrapping_add(1);
                state.target = target;
            }
            Ok(())
        }

        pub(crate) fn epoch_for(&self, terminal_id: &str, generation: u64) -> Option<u64> {
            let state = self.0.lock_or_err().ok()?;
            state
                .target
                .as_ref()?
                .is_foreground(terminal_id, generation)
                .then_some(state.epoch)
        }

        pub(crate) fn write(
            &self,
            terminal_id: &str,
            session: &TerminalOutputSession,
            epoch: u64,
            data: &str,
        ) {
            let Some(text) = super::decode_write(data) else {
                return;
            };
            let Ok(state) = self.0.lock_or_err() else {
                return;
            };
            if state.epoch != epoch
                || session.is_terminal_output_retired()
                || !state
                    .target
                    .as_ref()
                    .is_some_and(|target| target.is_foreground(terminal_id, session.generation()))
            {
                return;
            }
            if let Err(error) = crate::clipboard::write_text(&text) {
                tracing::warn!(%error, %terminal_id, "OSC 52 clipboard write failed");
            }
        }
    }
}

#[cfg(windows)]
pub(crate) use windows::ClipboardFocus;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_only_valid_nonempty_clipboard_text() {
        assert_eq!(decode_write("c;7ZWc6riA").as_deref(), Some("한글"));
        for data in [
            "c;?", "c;", "p;YWJj", ";YWJj", "c;YQ==;", "c;YQ", "c;AA==", "c;/w==",
        ] {
            assert_eq!(decode_write(data), None, "{data}");
        }
    }

    #[test]
    fn bounds_decoded_text_in_bytes() {
        let maximum = "a".repeat(MAX_TEXT_BYTES);
        let encoded = BASE64_STANDARD.encode(&maximum);
        assert_eq!(decode_write(&format!("c;{encoded}")), Some(maximum));
        let encoded = BASE64_STANDARD.encode(vec![b'a'; MAX_TEXT_BYTES + 1]);
        assert_eq!(decode_write(&format!("c;{encoded}")), None);
    }
}
