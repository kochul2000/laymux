//! The OSC title each daemon terminal running an agent last showed, handed
//! from the GUI that installs an update to the GUI that adopts its sessions
//! (ADR-0319).
//!
//! An adopted terminal takes the output it missed while no GUI was attached
//! through the OSC pass (ADR-0309). The title an agent set before the handoff
//! is not in that backlog, and an idle agent sets no new one: Claude's `✳`
//! title stays the only sign that it is idle until its next turn. Without it
//! the updated GUI cannot tell an idle agent from a busy one.
//!
//! The next GUI consumes the file when it starts. A title only applies to the
//! same terminal id running the same child, and goes ahead of the missed
//! output, which holds everything that child printed since.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::lock_ext::MutexExt;
use crate::state::AppState;
use crate::terminal::TerminalActivity;

const FILE_NAME: &str = "update-handoff-titles.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandedTitle {
    terminal_id: String,
    child_pid: u32,
    title: String,
}

fn file_path() -> Option<PathBuf> {
    crate::settings::cache_dir_path().map(|dir| dir.join(FILE_NAME))
}

/// The daemon terminals running an agent, picked while their PTY handles are
/// still registered.
pub struct Handoff(Vec<(String, u32)>);

/// Pick what to hand over. The installer teardown releases the handles next.
pub fn begin(state: &AppState) -> Handoff {
    Handoff(agent_children(state))
}

impl Handoff {
    /// Write the titles as they are now. The detached sessions still report to
    /// this GUI until it exits, so the later this runs, the less is lost.
    pub fn save(self, state: &AppState) {
        let Some(path) = file_path() else {
            return;
        };
        if let Err(error) = write_to(&path, &titles(state, self.0)) {
            tracing::warn!(%error, "could not hand terminal titles to the update");
        }
    }
}

/// The update did not happen; this GUI keeps its sessions.
pub fn discard() {
    if let Some(path) = file_path() {
        let _ = std::fs::remove_file(path);
    }
}

fn handed() -> &'static Mutex<HashMap<String, HandedTitle>> {
    static HANDED: OnceLock<Mutex<HashMap<String, HandedTitle>>> = OnceLock::new();
    HANDED.get_or_init(|| Mutex::new(file_path().map(|path| load_from(&path)).unwrap_or_default()))
}

/// Take over what the previous GUI handed over, at startup: the file belongs
/// to this launch only, whether or not any terminal adopts.
pub fn claim() {
    handed();
}

/// The title handed over for the session this terminal just adopted, once.
pub fn take(terminal_id: &str, child_pid: Option<u32>) -> Option<String> {
    take_from(&mut *handed().lock_or_err().ok()?, terminal_id, child_pid?)
}

/// The title as the OSC pass reads it from output. Control characters cannot
/// come from a parsed title; dropping them keeps the sequence well formed.
pub fn osc_title_sequence(title: &str) -> Vec<u8> {
    let title: String = title.chars().filter(|c| !c.is_control()).collect();
    format!("\x1b]2;{title}\x07").into_bytes()
}

/// Only a terminal the backend sees running Claude, Codex or Grok: an agent
/// that left without resetting the title must not mark a shell as an agent
/// in the next GUI.
fn agent_children(state: &AppState) -> Vec<(String, u32)> {
    let activities = match crate::activity::detect_all_terminal_states(state) {
        Ok(activities) => activities,
        Err(error) => {
            tracing::warn!(%error, "terminal activity unavailable; handing over no titles");
            return Vec::new();
        }
    };
    let Ok(handles) = state.pty_handles.lock_or_err() else {
        return Vec::new();
    };
    handles
        .iter()
        .filter(|(id, handle)| {
            handle.is_backend_owned()
                && activities
                    .get(*id)
                    .is_some_and(|info| is_agent(&info.activity))
        })
        .filter_map(|(id, handle)| Some((id.clone(), handle.child_pid()?)))
        .collect()
}

fn is_agent(activity: &TerminalActivity) -> bool {
    matches!(
        activity,
        TerminalActivity::InteractiveApp { name } if matches!(name.as_str(), "Claude" | "Codex" | "Grok")
    )
}

fn titles(state: &AppState, children: Vec<(String, u32)>) -> Vec<HandedTitle> {
    let Ok(terminals) = state.terminals.lock_or_err() else {
        return Vec::new();
    };
    children
        .into_iter()
        .filter_map(|(terminal_id, child_pid)| {
            let title = terminals.get(&terminal_id)?.osc_title.clone()?;
            Some(HandedTitle {
                terminal_id,
                child_pid,
                title,
            })
        })
        .collect()
}

fn write_to(path: &Path, titles: &[HandedTitle]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec(titles).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// Read and remove the file: the titles belong to this one handoff.
fn load_from(path: &Path) -> HashMap<String, HandedTitle> {
    let Ok(bytes) = std::fs::read(path) else {
        return HashMap::new();
    };
    let _ = std::fs::remove_file(path);
    serde_json::from_slice::<Vec<HandedTitle>>(&bytes)
        .unwrap_or_default()
        .into_iter()
        .map(|entry| (entry.terminal_id.clone(), entry))
        .collect()
}

fn take_from(
    handed: &mut HashMap<String, HandedTitle>,
    terminal_id: &str,
    child_pid: u32,
) -> Option<String> {
    if handed.get(terminal_id)?.child_pid != child_pid {
        return None;
    }
    handed.remove(terminal_id).map(|entry| entry.title)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(terminal_id: &str, child_pid: u32, title: &str) -> HandedTitle {
        HandedTitle {
            terminal_id: terminal_id.into(),
            child_pid,
            title: title.into(),
        }
    }

    #[test]
    fn titles_are_read_once_from_the_handoff_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache").join(FILE_NAME);
        write_to(&path, &[entry("terminal-a", 41, "✳ Claude Code")]).unwrap();

        let mut handed = load_from(&path);
        assert!(!path.exists(), "the next launch must not apply them again");
        assert_eq!(handed.len(), 1);
        assert_eq!(
            take_from(&mut handed, "terminal-a", 41).as_deref(),
            Some("✳ Claude Code")
        );
        assert_eq!(take_from(&mut handed, "terminal-a", 41), None);
    }

    #[test]
    fn a_title_applies_only_to_the_child_it_was_taken_from() {
        let mut handed = HashMap::from([("terminal-a".into(), entry("terminal-a", 41, "✳ idle"))]);
        assert_eq!(take_from(&mut handed, "terminal-b", 41), None);
        assert_eq!(take_from(&mut handed, "terminal-a", 42), None);
        assert_eq!(
            take_from(&mut handed, "terminal-a", 41).as_deref(),
            Some("✳ idle"),
            "a mismatch leaves the entry for its own child"
        );
    }

    #[test]
    fn a_missing_or_corrupt_file_hands_over_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        assert!(load_from(&path).is_empty());
        std::fs::write(&path, b"not json").unwrap();
        assert!(load_from(&path).is_empty());
        assert!(!path.exists());
    }

    #[test]
    fn only_a_running_agent_hands_over_its_title() {
        for name in ["Claude", "Codex", "Grok"] {
            assert!(is_agent(&TerminalActivity::InteractiveApp {
                name: name.into()
            }));
        }
        assert!(!is_agent(&TerminalActivity::InteractiveApp {
            name: "vim".into()
        }));
        assert!(!is_agent(&TerminalActivity::Shell));
        assert!(!is_agent(&TerminalActivity::Running));
    }

    #[test]
    fn titles_skip_terminals_that_left_no_title_or_are_gone() {
        let state = AppState::new();
        let config = || crate::terminal::TerminalConfig::default();
        let mut session = crate::terminal::TerminalSession::new("terminal-a".into(), config());
        session.osc_title = Some("✳ Claude Code".into());
        let mut terminals = state.terminals.lock().unwrap();
        terminals.insert("terminal-a".into(), session);
        terminals.insert(
            "terminal-b".into(),
            crate::terminal::TerminalSession::new("terminal-b".into(), config()),
        );
        drop(terminals);
        let children = vec![
            ("terminal-a".into(), 41),
            ("terminal-b".into(), 42),
            ("terminal-gone".into(), 43),
        ];
        assert_eq!(
            titles(&state, children),
            vec![entry("terminal-a", 41, "✳ Claude Code")]
        );
    }

    #[test]
    fn the_title_parses_back_as_the_same_osc_title() {
        let bytes = osc_title_sequence("✳ Fix\x07 the\x1b bug");
        let events: Vec<_> = crate::osc::iter_osc_events(&bytes).collect();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].code, 2);
        assert_eq!(events[0].data, "✳ Fix the bug");
    }
}
