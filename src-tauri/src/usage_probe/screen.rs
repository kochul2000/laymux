//! vt100 screen model for the probe PTY.
//!
//! The probe needs *rendered* screen state, not a byte stream: `/usage` is a
//! TUI that repaints in place, so concatenated output interleaves stale and
//! live frames. This wrapper is scoped to the probe on purpose — laymux's user
//! terminals keep their single cell grid in xterm.js ([ADR-0099]).

use std::sync::{Arc, Mutex};

/// Screen geometry for the probe PTY. Large enough that the `/usage` panel
/// renders without wrapping or truncation, matching what `ccu` found workable.
pub const PROBE_COLS: u16 = 200;
pub const PROBE_ROWS: u16 = 60;

/// A vt100 screen that PTY output can be fed into from the reader thread while
/// the worker thread reads text snapshots.
#[derive(Clone)]
pub struct ProbeScreen {
    parser: Arc<Mutex<vt100::Parser>>,
}

impl ProbeScreen {
    pub fn new() -> Self {
        Self {
            // No scrollback: only the visible screen is ever parsed, and
            // retaining history would let a stale frame outlive its repaint.
            parser: Arc::new(Mutex::new(vt100::Parser::new(PROBE_ROWS, PROBE_COLS, 0))),
        }
    }

    /// Feed raw PTY bytes. Called from the PTY reader thread.
    ///
    /// A poisoned lock is dropped rather than propagated: losing screen bytes
    /// degrades the next capture into a parse failure, which the probe already
    /// reports, whereas panicking here would take down the reader thread.
    pub fn feed(&self, data: &[u8]) {
        match self.parser.lock() {
            Ok(mut parser) => parser.process(data),
            Err(poisoned) => {
                tracing::warn!("usage probe screen lock poisoned; dropping output chunk");
                let mut parser = poisoned.into_inner();
                parser.process(data);
            }
        }
    }

    /// Current screen as plain text, one line per row, trailing blanks trimmed.
    pub fn text(&self) -> String {
        let contents = match self.parser.lock() {
            Ok(parser) => parser.screen().contents(),
            Err(poisoned) => poisoned.into_inner().screen().contents(),
        };
        contents
            .lines()
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join("\n")
    }
}

impl Default for ProbeScreen {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_plain_text() {
        let screen = ProbeScreen::new();
        screen.feed(b"hello");
        assert_eq!(screen.text().lines().next(), Some("hello"));
    }

    #[test]
    fn strips_sgr_sequences() {
        let screen = ProbeScreen::new();
        screen.feed(b"\x1b[96m30% used\x1b[0m");
        assert_eq!(screen.text().lines().next(), Some("30% used"));
    }

    #[test]
    fn repaint_over_the_same_cell_keeps_only_the_live_frame() {
        // The reason a byte-stream scrape cannot work: the old value is
        // overwritten in place, and only a screen model reflects that.
        let screen = ProbeScreen::new();
        screen.feed(b"\x1b[H30% used");
        screen.feed(b"\x1b[H99% used");
        let text = screen.text();
        assert!(text.contains("99% used"), "{text}");
        assert!(!text.contains("30% used"), "{text}");
    }

    #[test]
    fn cursor_addressing_places_rows() {
        let screen = ProbeScreen::new();
        screen.feed(b"\x1b[2;1HCurrent session\x1b[3;1H  30% used");
        let text = screen.text();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[1], "Current session");
        assert_eq!(lines[2], "  30% used");
    }

    #[test]
    fn screen_is_shareable_across_threads() {
        let screen = ProbeScreen::new();
        let writer = screen.clone();
        let handle = std::thread::spawn(move || writer.feed(b"from another thread"));
        handle.join().unwrap();
        assert!(screen.text().contains("from another thread"));
    }
}
