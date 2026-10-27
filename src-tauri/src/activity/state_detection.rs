use super::{
    detect_interactive_app_from_live_title, detect_terminal_activity,
    record_interactive_app_detection, sync_known_caches,
};
use crate::constants::ACTIVITY_SCAN_BYTES;
use crate::osc;
use crate::output_buffer::TerminalOutputBuffer;
use crate::process_tree::{self, PtyAppLiveness};
use crate::state::AppState;
use crate::terminal::{TerminalActivity, TerminalStateInfo};

/// Detect full terminal state (activity) for a single terminal.
pub fn detect_terminal_state(
    state: &AppState,
    terminal_id: &str,
    buffer: Option<&TerminalOutputBuffer>,
) -> TerminalStateInfo {
    detect_terminal_state_with_liveness(
        state,
        terminal_id,
        buffer,
        process_tree::interactive_app_in_pty(state, terminal_id),
    )
}

pub(super) fn detect_terminal_state_with_liveness(
    state: &AppState,
    terminal_id: &str,
    buffer: Option<&TerminalOutputBuffer>,
    liveness: PtyAppLiveness,
) -> TerminalStateInfo {
    // Process evidence survives silent re-attachment and outranks old titles
    // left in the ring. An empty ring cannot prove that a live app exited.
    if let PtyAppLiveness::Running(name) = liveness {
        sync_known_caches(state, terminal_id, name);
        record_interactive_app_detection(state, terminal_id, name);
        return TerminalStateInfo {
            activity: TerminalActivity::InteractiveApp { name: name.into() },
        };
    }
    let activity = detect_terminal_activity(buffer);
    let Some(buf) = buffer else {
        return TerminalStateInfo { activity };
    };
    let Ok(recent) = buf.recent_bytes(ACTIVITY_SCAN_BYTES) else {
        return TerminalStateInfo { activity };
    };
    if recent.is_empty() {
        return TerminalStateInfo { activity };
    }

    // Absence skips grace/banner fallback. A direct title still supports SSH
    // and JS shims whose remote/interpreted process has no local agent name.
    // Only a prompt observed AFTER that title makes the direct title stale.
    if liveness == PtyAppLiveness::NoneAlive {
        let activity = match activity {
            TerminalActivity::InteractiveApp { ref name }
                if matches!(name.as_str(), "Claude" | "Codex" | "Grok")
                    && prompt_after_last_title(&recent) =>
            {
                detect_shell_activity(&recent)
            }
            other => other,
        };
        return TerminalStateInfo { activity };
    }

    // An empty title still lets process/cache/banner recovery run when the
    // latest OSC 0/2 has scrolled out of the recent window (#239).
    let title = osc::extract_last_terminal_title(&recent).unwrap_or_default();
    if let Some(name) = detect_interactive_app_from_live_title(state, terminal_id, &title, buffer) {
        return TerminalStateInfo {
            activity: TerminalActivity::InteractiveApp { name },
        };
    }
    TerminalStateInfo { activity }
}

fn prompt_after_last_title(recent: &[u8]) -> bool {
    let mut prompt = false;
    let mut child_commands: u32 = 0;
    for event in osc::iter_osc_events(recent) {
        match event.code {
            0 | 2 => {
                prompt = false;
                child_commands = 0;
            }
            133 if matches!(event.param.as_deref(), Some("A" | "B")) => prompt = true,
            133 if event.param.as_deref() == Some("C") => {
                child_commands = child_commands.saturating_add(1)
            }
            133 if event.param.as_deref() == Some("D") => {
                if child_commands == 0 {
                    prompt = true;
                } else {
                    child_commands -= 1;
                }
            }
            _ => {}
        }
    }
    prompt
}

/// Only positive OSC lifecycle evidence can classify a shell/command.
pub(super) fn detect_shell_activity(recent: &[u8]) -> TerminalActivity {
    let start = osc::find_last_osc_133(recent, b"C");
    let prompt = [b"A", b"B", b"D"]
        .into_iter()
        .filter_map(|marker| osc::find_last_osc_133(recent, marker))
        .max();
    match (start, prompt) {
        (Some(c), Some(p)) if c > p => TerminalActivity::Running,
        (_, Some(_)) => TerminalActivity::Shell,
        (Some(_), None) => TerminalActivity::Running,
        (None, None) => TerminalActivity::Unknown,
    }
}
