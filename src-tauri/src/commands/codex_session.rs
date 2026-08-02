use std::collections::HashMap;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::State;

use super::claude_session::is_valid_session_id;
use crate::constants::{
    CODEX_SESSION_DIRECTORY_DEPTH, CODEX_SESSION_META_MAX_BYTES, ENV_CODEX_HOME,
};
use crate::lock_ext::MutexExt;
use crate::path_utils;
use crate::state::AppState;

/// Resolve Codex CLI session IDs for known Codex terminals.
///
/// Codex rollout metadata has no PTY PID, so each terminal is matched to the
/// newest top-level rollout whose `session_meta.cwd` equals the terminal CWD.
#[tauri::command]
pub fn get_codex_session_ids(
    session_max_age_hours: Option<u64>,
    state: State<Arc<AppState>>,
) -> Result<HashMap<String, String>, String> {
    get_codex_session_ids_impl(session_max_age_hours, &state).map_err(|error| error.to_string())
}

fn get_codex_session_ids_impl(
    session_max_age_hours: Option<u64>,
    state: &AppState,
) -> Result<HashMap<String, String>, crate::error::AppError> {
    get_codex_session_ids_from_dir(session_max_age_hours, state, &resolve_codex_sessions_dir())
}

fn get_codex_session_ids_from_dir(
    session_max_age_hours: Option<u64>,
    state: &AppState,
    sessions_dir: &Path,
) -> Result<HashMap<String, String>, crate::error::AppError> {
    let known: Vec<String> = state
        .known_codex_terminals
        .lock_or_err()?
        .iter()
        .cloned()
        .collect();
    if known.is_empty() {
        return Ok(HashMap::new());
    }

    let rollouts = read_codex_rollout_files(sessions_dir, session_max_age_hours);
    let terminals = state.terminals.lock_or_err()?;
    Ok(known
        .into_iter()
        .filter_map(|terminal_id| {
            let cwd = terminals.get(&terminal_id)?.cwd.as_deref()?;
            find_session_by_cwd(&rollouts, cwd).map(|session_id| (terminal_id, session_id))
        })
        .collect())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CodexRolloutFile {
    session_id: String,
    cwd: String,
    modified_at: u128,
}

/// Accept only the exact `codex resume <safe-id>` form.
pub(crate) fn is_valid_codex_startup_command_override(command: &str) -> bool {
    command
        .strip_prefix("codex resume ")
        .is_some_and(is_valid_session_id)
}

fn resolve_codex_sessions_dir() -> PathBuf {
    let codex_home = std::env::var_os(ENV_CODEX_HOME).map(PathBuf::from);
    #[cfg(windows)]
    let platform_home = std::env::var_os("USERPROFILE").map(PathBuf::from);
    #[cfg(not(windows))]
    let platform_home = std::env::var_os("HOME").map(PathBuf::from);

    resolve_codex_sessions_dir_from(codex_home, platform_home)
}

fn resolve_codex_sessions_dir_from(
    codex_home: Option<PathBuf>,
    platform_home: Option<PathBuf>,
) -> PathBuf {
    codex_home
        .or_else(|| platform_home.map(|path| path.join(".codex")))
        .unwrap_or_else(|| PathBuf::from(".codex"))
        .join("sessions")
}

fn collect_rollout_paths(dir: &Path, depth: u8, paths: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() && depth > 0 {
            collect_rollout_paths(&path, depth - 1, paths);
        } else if file_type.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        {
            paths.push(path);
        }
    }
}

fn read_codex_rollout_files(dir: &Path, max_age_hours: Option<u64>) -> Vec<CodexRolloutFile> {
    let mut paths = Vec::new();
    collect_rollout_paths(dir, CODEX_SESSION_DIRECTORY_DEPTH, &mut paths);

    let cutoff = max_age_hours.filter(|hours| *hours > 0).and_then(|hours| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|now| {
                let age_nanos = (hours as u128)
                    .saturating_mul(3600)
                    .saturating_mul(1_000_000_000);
                now.as_nanos().saturating_sub(age_nanos)
            })
    });

    paths
        .into_iter()
        .filter_map(|path| parse_rollout_header(&path, cutoff))
        .collect()
}

fn parse_rollout_header(path: &Path, cutoff: Option<u128>) -> Option<CodexRolloutFile> {
    let modified_at = std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    if cutoff.is_some_and(|minimum| modified_at < minimum) {
        return None;
    }

    let file = std::fs::File::open(path).ok()?;
    let mut header = String::new();
    let mut limited = std::io::BufReader::new(file).take((CODEX_SESSION_META_MAX_BYTES + 1) as u64);
    limited.read_line(&mut header).ok()?;
    if header.len() > CODEX_SESSION_META_MAX_BYTES {
        return None;
    }

    let value: serde_json::Value = serde_json::from_str(&header).ok()?;
    if value.get("type").and_then(serde_json::Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = value.get("payload")?;
    let is_subagent = payload
        .get("parent_thread_id")
        .is_some_and(|parent| !parent.is_null())
        || payload
            .get("thread_source")
            .and_then(serde_json::Value::as_str)
            == Some("subagent")
        || payload
            .get("source")
            .and_then(|source| source.get("subagent"))
            .is_some();
    if is_subagent {
        return None;
    }

    let session_id = payload.get("id")?.as_str()?;
    let cwd = payload.get("cwd")?.as_str()?;
    if !is_valid_session_id(session_id) || cwd.is_empty() {
        return None;
    }
    Some(CodexRolloutFile {
        session_id: session_id.to_owned(),
        cwd: cwd.to_owned(),
        modified_at,
    })
}

fn find_session_by_cwd(sessions: &[CodexRolloutFile], cwd: &str) -> Option<String> {
    let normalized_cwd = path_utils::normalize_path_for_comparison(cwd);
    sessions
        .iter()
        .filter(|session| path_utils::normalize_path_for_comparison(&session.cwd) == normalized_cwd)
        .max_by(|left, right| {
            left.modified_at
                .cmp(&right.modified_at)
                .then_with(|| left.session_id.cmp(&right.session_id))
        })
        .map(|session| session.session_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::{TerminalConfig, TerminalSession};

    fn write_rollout(dir: &Path, name: &str, id: &str, cwd: &str, extra_payload: &str) -> PathBuf {
        let path = dir.join(name);
        let content = format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\",\"cwd\":\"{cwd}\"{extra_payload}}}}}\n{{\"type\":\"response_item\"}}"
        );
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn parses_top_level_rollout_from_date_directories() {
        let temp = tempfile::tempdir().unwrap();
        let nested = temp.path().join("2026").join("08").join("02");
        std::fs::create_dir_all(&nested).unwrap();
        write_rollout(
            &nested,
            "rollout-2026-08-02-session.jsonl",
            "019fc0d8-a862-7241-a0f5-b6a66ef4ef6f",
            "/work/project",
            "",
        );

        let sessions = read_codex_rollout_files(temp.path(), Some(24));
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            sessions[0].session_id,
            "019fc0d8-a862-7241-a0f5-b6a66ef4ef6f"
        );
        assert_eq!(sessions[0].cwd, "/work/project");
    }

    #[test]
    fn ignores_subagent_rollouts_even_when_they_are_newer() {
        let temp = tempfile::tempdir().unwrap();
        write_rollout(
            temp.path(),
            "rollout-parent.jsonl",
            "parent-session",
            "/work/project",
            "",
        );
        write_rollout(
            temp.path(),
            "rollout-child.jsonl",
            "child-session",
            "/work/project",
            ",\"parent_thread_id\":\"parent-session\",\"thread_source\":\"subagent\"",
        );

        let sessions = read_codex_rollout_files(temp.path(), None);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "parent-session");
    }

    #[test]
    fn app_state_maps_only_known_codex_terminals_by_cwd() {
        let temp = tempfile::tempdir().unwrap();
        write_rollout(
            temp.path(),
            "rollout-known.jsonl",
            "known-session",
            "/work/known",
            "",
        );
        write_rollout(
            temp.path(),
            "rollout-other.jsonl",
            "other-session",
            "/work/other",
            "",
        );

        let state = AppState::new();
        state
            .known_codex_terminals
            .lock()
            .unwrap()
            .insert("terminal-known".into());
        let mut known = TerminalSession::new("terminal-known".into(), TerminalConfig::default());
        known.cwd = Some("/work/known".into());
        let mut unregistered =
            TerminalSession::new("terminal-other".into(), TerminalConfig::default());
        unregistered.cwd = Some("/work/other".into());
        state.terminals.lock().unwrap().extend([
            ("terminal-known".into(), known),
            ("terminal-other".into(), unregistered),
        ]);

        let result = get_codex_session_ids_from_dir(None, &state, temp.path()).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            result.get("terminal-known").map(String::as_str),
            Some("known-session")
        );
    }

    #[test]
    fn rejects_non_rollout_files_invalid_headers_and_unsafe_ids() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("notes.jsonl"), "{}").unwrap();
        std::fs::write(
            temp.path().join("rollout-response.jsonl"),
            r#"{"type":"response_item","payload":{}}"#,
        )
        .unwrap();
        write_rollout(
            temp.path(),
            "rollout-unsafe.jsonl",
            "--last",
            "/work/project",
            "",
        );

        assert!(read_codex_rollout_files(temp.path(), None).is_empty());
    }

    #[test]
    fn zero_age_disables_filter_and_cwd_match_chooses_latest() {
        let sessions = vec![
            CodexRolloutFile {
                session_id: "old-session".into(),
                cwd: "/work/project".into(),
                modified_at: 1,
            },
            CodexRolloutFile {
                session_id: "new-session".into(),
                cwd: "/work/project".into(),
                modified_at: 2,
            },
        ];
        assert_eq!(
            find_session_by_cwd(&sessions, "/work/project"),
            Some("new-session".into())
        );

        let temp = tempfile::tempdir().unwrap();
        write_rollout(
            temp.path(),
            "rollout-any.jsonl",
            "any-session",
            "/work/project",
            "",
        );
        assert_eq!(read_codex_rollout_files(temp.path(), Some(0)).len(), 1);
    }

    #[test]
    fn cwd_match_breaks_equal_timestamp_ties_by_session_id() {
        let sessions = vec![
            CodexRolloutFile {
                session_id: "session-a".into(),
                cwd: "/work/project".into(),
                modified_at: 100,
            },
            CodexRolloutFile {
                session_id: "session-b".into(),
                cwd: "/work/project".into(),
                modified_at: 100,
            },
        ];

        assert_eq!(
            find_session_by_cwd(&sessions, "/work/project"),
            Some("session-b".into())
        );
    }

    #[test]
    fn startup_override_accepts_only_exact_safe_resume_form() {
        assert!(is_valid_codex_startup_command_override(
            "codex resume 019fc0d8-a862-7241-a0f5-b6a66ef4ef6f"
        ));
        for invalid in [
            "codex resume --last",
            "codex resume bad;echo-pwned",
            "codex resume $(whoami)",
            "codex --resume abc",
            "claude --resume abc",
            "",
        ] {
            assert!(!is_valid_codex_startup_command_override(invalid));
        }
    }

    #[test]
    fn codex_home_precedes_platform_home() {
        assert_eq!(
            resolve_codex_sessions_dir_from(
                Some(PathBuf::from("D:/isolated-codex")),
                Some(PathBuf::from("C:/Users/example")),
            ),
            PathBuf::from("D:/isolated-codex/sessions")
        );
        assert_eq!(
            resolve_codex_sessions_dir_from(None, Some(PathBuf::from("/home/example"))),
            PathBuf::from("/home/example/.codex/sessions")
        );
    }
}
