use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use serde::Deserialize;
use tauri::State;

use crate::lock_ext::MutexExt;
use crate::state::AppState;

use super::wsl_agent_session::{resolve_wsl_agent_processes, WslAgentProvider};

/// `<configured grok command> --resume <uuid>` only. Prefix is re-derived
/// from disk settings (ADR-0125 / ADR-0154).
pub(crate) fn is_valid_grok_startup_command_override(cmd: &str, configured_command: &str) -> bool {
    let agent = crate::settings::agent_command::resolve_agent_command(
        configured_command,
        crate::settings::agent_command::DEFAULT_GROK_COMMAND,
    );
    cmd.strip_prefix(&format!("{agent} --resume "))
        .is_some_and(is_valid_grok_session_id)
}

pub(crate) fn is_valid_grok_session_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        let hex = matches!(byte, b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F');
        let hyphen = *byte == b'-' && matches!(index, 8 | 13 | 18 | 23);
        if !hex && !hyphen {
            return false;
        }
        if matches!(index, 8 | 13 | 18 | 23) && *byte != b'-' {
            return false;
        }
    }
    true
}

#[derive(Debug, Deserialize)]
struct ActiveGrokSession {
    session_id: String,
    pid: u32,
}

fn grok_home() -> PathBuf {
    if let Ok(home) = std::env::var("GROK_HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    let user_home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(user_home).join(".grok")
}

fn read_active_sessions(home: &Path) -> Vec<ActiveGrokSession> {
    let path = home.join("active_sessions.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    match serde_json::from_str(&text) {
        Ok(sessions) => sessions,
        Err(error) => {
            tracing::warn!(
                path = %path.display(),
                %error,
                "failed to parse Grok active_sessions.json"
            );
            Vec::new()
        }
    }
}

fn session_summary_path(home: &Path, session_id: &str) -> Option<PathBuf> {
    let sessions = home.join("sessions");
    let entries = std::fs::read_dir(sessions).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join(session_id).join("summary.json");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn summary_within_age(path: &Path, max_age_hours: Option<u64>) -> bool {
    let Some(hours) = max_age_hours.filter(|&h| h > 0) else {
        return true;
    };
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return false;
    };
    let Ok(age) = SystemTime::now().duration_since(modified) else {
        return false;
    };
    age.as_secs() <= hours.saturating_mul(3600)
}

fn session_id_for_pid(home: &Path, pid: u32, max_age_hours: Option<u64>) -> Option<String> {
    let mut session_ids: Vec<String> = read_active_sessions(home)
        .into_iter()
        .filter(|entry| entry.pid == pid)
        .map(|entry| entry.session_id)
        .filter(|id| is_valid_grok_session_id(id))
        .collect();
    session_ids.sort();
    session_ids.dedup();
    // One Grok process can list multiple sessions; pick nothing rather than
    // resume the first JSON entry (ADR-0154).
    if session_ids.len() != 1 {
        return None;
    }
    let session_id = session_ids.pop()?;
    let summary = session_summary_path(home, &session_id)?;
    if !summary_within_age(&summary, max_age_hours) {
        return None;
    }
    Some(session_id)
}

#[tauri::command]
pub fn get_grok_session_ids(
    session_max_age_hours: Option<u64>,
    state: State<Arc<AppState>>,
) -> Result<HashMap<String, Option<String>>, String> {
    let known: Vec<String> = {
        let k = state.known_grok_terminals.lock_or_err()?;
        k.iter().cloned().collect()
    };
    let home = grok_home();
    let terminal_roots: Vec<(String, u32)> = {
        let ptys = state.pty_handles.lock_or_err()?;
        known
            .iter()
            .cloned()
            .filter_map(|terminal_id| {
                let child_pid = ptys.get(&terminal_id)?.child_pid()?;
                Some((terminal_id, child_pid))
            })
            .collect()
    };
    let snapshot = crate::process_tree::snapshot_processes();
    let candidates = if snapshot.is_empty() {
        Vec::new()
    } else {
        terminal_roots
            .into_iter()
            .filter_map(|(terminal_id, root_pid)| {
                let (pid, app) =
                    crate::process_tree::match_interactive_app_process(&snapshot, root_pid)?;
                if app != "Grok" {
                    return None;
                }
                session_id_for_pid(&home, pid, session_max_age_hours)
                    .map(|session_id| (terminal_id, session_id))
            })
            .collect()
    };
    let mut result = crate::process_tree::complete_agent_session_attributions(
        &known,
        crate::process_tree::reject_duplicate_session_attributions(
            candidates
                .into_iter()
                .map(|(id, session)| (id, Some(session)))
                .collect(),
            "Grok",
        )
        .into_iter()
        .filter_map(|(id, session)| session.map(|session| (id, session)))
        .collect(),
    );
    match resolve_wsl_agent_processes(&state, WslAgentProvider::Grok) {
        Ok(attributions) => {
            for (terminal_id, process) in attributions {
                result.insert(
                    terminal_id,
                    process.and_then(|process| {
                        session_id_for_pid(
                            &process.grok_home_dir()?,
                            process.pid,
                            session_max_age_hours,
                        )
                    }),
                );
            }
        }
        Err(error) => tracing::warn!(%error, "WSL Grok attribution failed"),
    }
    Ok(crate::process_tree::reject_duplicate_session_attributions(
        result, "Grok",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::time::SystemTime;

    #[test]
    fn resume_override_requires_uuid() {
        assert!(is_valid_grok_startup_command_override(
            "grok --resume 019ffa7f-b8c1-7511-872f-911e8dc8d179",
            "grok"
        ));
        assert!(is_valid_grok_startup_command_override(
            "grok --yolo --resume 019ffa7f-b8c1-7511-872f-911e8dc8d179",
            "grok --yolo"
        ));
        assert!(!is_valid_grok_startup_command_override(
            "grok --resume not-a-uuid",
            "grok"
        ));
        assert!(!is_valid_grok_startup_command_override(
            "grok resume 019ffa7f-b8c1-7511-872f-911e8dc8d179",
            "grok"
        ));
        assert!(!is_valid_grok_startup_command_override(
            "grok --resume 019ffa7fb8c17511872f911e8dc8d179",
            "grok"
        ));
    }

    fn write_summary(home: &Path, session_id: &str) -> PathBuf {
        let summary = home
            .join("sessions")
            .join("proj")
            .join(session_id)
            .join("summary.json");
        std::fs::create_dir_all(summary.parent().unwrap()).unwrap();
        std::fs::write(&summary, "{}").unwrap();
        summary
    }

    #[test]
    fn session_id_for_pid_matches_live_uuid() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let sid = "019ffa7f-b8c1-7511-872f-911e8dc8d179";
        std::fs::write(
            home.join("active_sessions.json"),
            format!(r#"[{{"session_id":"{sid}","pid":4242}}]"#),
        )
        .unwrap();
        write_summary(home, sid);
        assert_eq!(
            session_id_for_pid(home, 4242, Some(24)).as_deref(),
            Some(sid)
        );
    }

    #[test]
    fn session_id_for_pid_rejects_non_uuid() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        std::fs::write(
            home.join("active_sessions.json"),
            r#"[{"session_id":"not-a-uuid","pid":4242}]"#,
        )
        .unwrap();
        write_summary(home, "not-a-uuid");
        assert_eq!(session_id_for_pid(home, 4242, Some(24)), None);
    }

    #[test]
    fn session_id_for_pid_requires_summary() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let sid = "019ffa7f-b8c1-7511-872f-911e8dc8d179";
        std::fs::write(
            home.join("active_sessions.json"),
            format!(r#"[{{"session_id":"{sid}","pid":4242}}]"#),
        )
        .unwrap();
        assert_eq!(session_id_for_pid(home, 4242, Some(24)), None);
    }

    #[test]
    fn session_id_for_pid_rejects_stale_summary() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let sid = "019ffa7f-b8c1-7511-872f-911e8dc8d179";
        std::fs::write(
            home.join("active_sessions.json"),
            format!(r#"[{{"session_id":"{sid}","pid":4242}}]"#),
        )
        .unwrap();
        let summary = write_summary(home, sid);
        let file = std::fs::File::options().write(true).open(summary).unwrap();
        let old = SystemTime::now() - std::time::Duration::from_secs(48 * 3600);
        file.set_modified(old).unwrap();
        assert_eq!(session_id_for_pid(home, 4242, Some(24)), None);
    }

    #[test]
    fn session_id_for_pid_rejects_duplicate_pid() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let first = "019ffa7f-b8c1-7511-872f-911e8dc8d179";
        let second = "019ffa7f-b8c1-7511-872f-911e8dc8d180";
        std::fs::write(
            home.join("active_sessions.json"),
            format!(
                r#"[{{"session_id":"{first}","pid":4242}},{{"session_id":"{second}","pid":4242}}]"#
            ),
        )
        .unwrap();
        write_summary(home, first);
        write_summary(home, second);
        assert_eq!(session_id_for_pid(home, 4242, Some(24)), None);
    }

    #[test]
    fn session_id_for_pid_accepts_duplicate_rows_of_the_same_id() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let sid = "019ffa7f-b8c1-7511-872f-911e8dc8d179";
        std::fs::write(
            home.join("active_sessions.json"),
            format!(r#"[{{"session_id":"{sid}","pid":4242}},{{"session_id":"{sid}","pid":4242}}]"#),
        )
        .unwrap();
        write_summary(home, sid);
        assert_eq!(
            session_id_for_pid(home, 4242, Some(24)).as_deref(),
            Some(sid)
        );
    }

    #[test]
    fn malformed_active_sessions_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        std::fs::write(home.join("active_sessions.json"), "{not json").unwrap();
        assert!(read_active_sessions(home).is_empty());
    }
}
