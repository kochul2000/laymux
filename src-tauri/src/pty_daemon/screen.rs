//! The daemon's model of a session's visible screen, redrawn for a client
//! that re-adopts the session (ADR-0307).
//!
//! The model only serves that redraw, so it must never take the session down
//! with it: `vt100` can panic on some resize-then-write sequences (a wide
//! character cut by a narrower grid, a one-row grid). Every call into it runs
//! under `catch_unwind`, and a model that panicked is replaced by a blank one
//! of the same size. The session lock it runs under is therefore never
//! poisoned, and the PTY's output keeps flowing.

use std::panic::{catch_unwind, AssertUnwindSafe};

use crate::constants::{PTY_DAEMON_SCREEN_DEFAULT_COLS, PTY_DAEMON_SCREEN_DEFAULT_ROWS};

/// `vt100` mishandles a grid smaller than this; a real one this small shows
/// next to nothing anyway.
const MIN_ROWS: u16 = 2;
const MIN_COLS: u16 = 2;

pub(super) struct ScreenModel {
    parser: vt100::Parser,
}

impl Default for ScreenModel {
    fn default() -> Self {
        Self::new(
            PTY_DAEMON_SCREEN_DEFAULT_ROWS,
            PTY_DAEMON_SCREEN_DEFAULT_COLS,
        )
    }
}

impl ScreenModel {
    pub(super) fn new(rows: u16, cols: u16) -> Self {
        let (rows, cols) = clamp(rows, cols);
        Self {
            parser: vt100::Parser::new(rows, cols, 0),
        }
    }

    pub(super) fn process(&mut self, data: &[u8]) {
        let parser = &mut self.parser;
        if catch_unwind(AssertUnwindSafe(|| parser.process(data))).is_err() {
            self.reset("output");
        }
    }

    /// Resize like a terminal emulator does: when rows go away, the top of
    /// the main screen scrolls off so the cursor's row stays visible (xterm
    /// and ConPTY), instead of `vt100`'s cutting the bottom rows — which
    /// would drop a shell's prompt.
    pub(super) fn set_size(&mut self, rows: u16, cols: u16) {
        let (rows, cols) = clamp(rows, cols);
        let parser = &mut self.parser;
        let resized = catch_unwind(AssertUnwindSafe(|| {
            let screen = parser.screen();
            let (old_rows, _) = screen.size();
            let (cursor_row, cursor_col) = screen.cursor_position();
            if !screen.alternate_screen() && rows < old_rows && cursor_row >= rows {
                let scroll = usize::from(cursor_row - rows + 1);
                let mut bytes = format!("\x1b[{old_rows};1H").into_bytes();
                bytes.extend(std::iter::repeat_n(b'\n', scroll));
                bytes.extend(format!("\x1b[{rows};{}H", cursor_col + 1).into_bytes());
                parser.process(&bytes);
            }
            parser.screen_mut().set_size(rows, cols);
        }));
        if resized.is_err() {
            self.parser = vt100::Parser::new(rows, cols, 0);
            tracing::warn!("PTY daemon screen model failed on resize; reset");
        }
    }

    pub(super) fn alternate_screen(&self) -> bool {
        self.parser.screen().alternate_screen()
    }

    /// Bytes that draw the current screen on a blank terminal of the same
    /// size: cells, attributes and the cursor — no OSC and no query. `None`
    /// when the model cannot produce them.
    pub(super) fn redraw(&self) -> Option<Vec<u8>> {
        let screen = self.parser.screen();
        catch_unwind(AssertUnwindSafe(|| {
            [screen.contents_formatted(), screen.cursor_state_formatted()].concat()
        }))
        .ok()
    }

    fn reset(&mut self, during: &str) {
        let (rows, cols) = self.parser.screen().size();
        self.parser = vt100::Parser::new(rows, cols, 0);
        tracing::warn!(during, "PTY daemon screen model failed; reset");
    }
}

fn clamp(rows: u16, cols: u16) -> (u16, u16) {
    (rows.max(MIN_ROWS), cols.max(MIN_COLS))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contents(model: &ScreenModel) -> String {
        let mut terminal = vt100::Parser::new(
            model.parser.screen().size().0,
            model.parser.screen().size().1,
            0,
        );
        terminal.process(&model.redraw().unwrap());
        terminal.screen().contents()
    }

    #[test]
    fn a_wide_character_cut_by_a_narrower_grid_does_not_take_the_model_down() {
        // vt100 0.16 panics writing over the half of a wide character that a
        // narrower grid left in its last column.
        let mut model = ScreenModel::new(24, 10);
        model.process("abcdefgh한".as_bytes());
        model.set_size(24, 9);
        model.process(b"\r\x1b[8Cx");
        model.process(b"\r\nstill here");
        assert!(contents(&model).contains("still here"));
    }

    #[test]
    fn a_one_row_terminal_is_modelled_with_two() {
        let mut model = ScreenModel::new(1, 10);
        model.process(b"a prompt longer than the row\r\nnext");
        model.set_size(1, 10);
        model.process(b"\r\nand more output");
        assert_eq!(model.parser.screen().size(), (2, 10));
        assert!(model.redraw().is_some());
    }

    #[test]
    fn a_zero_size_is_never_given_to_the_model() {
        let mut model = ScreenModel::new(0, 0);
        model.set_size(0, 0);
        model.process(b"output");
        assert_eq!(model.parser.screen().size(), (2, 2));
    }

    #[test]
    fn losing_rows_scrolls_the_top_away_and_keeps_the_prompt() {
        let mut model = ScreenModel::new(10, 20);
        for line in 0..9 {
            model.process(format!("line{line}\r\n").as_bytes());
        }
        model.process(b"PROMPT> ");
        model.set_size(5, 20);
        let shown = contents(&model);
        assert!(shown.starts_with("line5"), "{shown:?}");
        assert!(shown.trim_end().ends_with("PROMPT>"), "{shown:?}");
        assert_eq!(model.parser.screen().cursor_position(), (4, 8));
        // Typing continues where the prompt is.
        model.process(b"ls");
        assert!(contents(&model).ends_with("PROMPT> ls"));
    }

    #[test]
    fn losing_rows_below_the_cursor_keeps_the_top() {
        let mut model = ScreenModel::new(10, 20);
        model.process(b"top\r\nPROMPT> ");
        model.set_size(5, 20);
        assert!(contents(&model).starts_with("top"));
        assert_eq!(model.parser.screen().cursor_position(), (1, 8));
    }
}
