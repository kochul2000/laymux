//! The OSC title each daemon terminal last showed, handed from the GUI that
//! installs an update to the GUI that adopts its sessions (ADR-0319).
//!
//! An adopted terminal takes the output it missed while no GUI was attached
//! through the OSC pass (ADR-0309). The title an agent set before the handoff
//! is not in that backlog, and an idle agent sets no new one: Claude's `✳`
//! title stays the only sign that it is idle until its next turn. Without it
//! the updated GUI cannot tell an idle agent from a busy one.
//!
//! The file is consumed by the first GUI that adopts a terminal. A title only
//! applies to the same terminal id running the same child, and goes ahead of
//! the missed output, which holds everything that child printed since.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::lock_ext::MutexExt;
use crate::state::AppState;

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

/// Record the title of every daemon terminal this GUI hands to the update.
/// Runs while the PTY handles are still registered.
pub fn save(state: &AppState) {
    let Some(path) = file_path() else {
        return;
    };
    if let Err(error) = write_to(&path, &collect(state)) {
        tracing::warn!(%error, "could not hand terminal titles to the update");
    }
}

/// The update did not happen; this GUI keeps its sessions.
pub fn discard() {
    if let Some(path) = file_path() {
        let _ = std::fs::remove_file(path);
    }
}

/// The title handed over for the session this terminal just adopted, once.
pub fn take(terminal_id: &str, child_pid: Option<u32>) -> Option<String> {
    static HANDED: OnceLock<Mutex<HashMap<String, HandedTitle>>> = OnceLock::new();
    let handed = HANDED
        .get_or_init(|| Mutex::new(file_path().map(|path| load_from(&path)).unwrap_or_default()));
    take_from(&mut *handed.lock_or_err().ok()?, terminal_id, child_pid?)
}

/// The title as the OSC pass reads it from output. Control characters cannot
/// come from a parsed title; dropping them keeps the sequence well formed.
pub fn osc_title_sequence(title: &str) -> Vec<u8> {
    let title: String = title.chars().filter(|c| !c.is_control()).collect();
    format!("\x1b]2;{title}\x07").into_bytes()
}

fn collect(state: &AppState) -> Vec<HandedTitle> {
    let children: Vec<(String, u32)> = match state.pty_handles.lock_or_err() {
        Ok(handles) => handles
            .iter()
            .filter(|(_, handle)| handle.is_backend_owned())
            .filter_map(|(id, handle)| Some((id.clone(), handle.child_pid()?)))
            .collect(),
        Err(_) => return Vec::new(),
    };
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
    fn the_title_parses_back_as_the_same_osc_title() {
        let bytes = osc_title_sequence("✳ Fix\x07 the\x1b bug");
        let events: Vec<_> = crate::osc::iter_osc_events(&bytes).collect();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].code, 2);
        assert_eq!(events[0].data, "✳ Fix the bug");
    }
}
