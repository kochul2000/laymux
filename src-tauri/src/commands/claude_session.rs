use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;

use crate::lock_ext::MutexExt;
use crate::path_utils;
use crate::state::AppState;

/// Resolve Claude Code session IDs for known Claude terminals.
///
/// Returns a map of terminal ID → Claude session ID by:
/// 1. (Primary) PID tree matching: walk the process tree from the PTY child PID
///    and match against `~/.claude/sessions/<pid>.json` files.
/// 2. (Fallback) CWD + most-recent matching: compare the terminal's CWD with
///    session file CWD, picking the most recently started session.
#[tauri::command]
pub fn get_claude_session_ids(
    session_max_age_hours: Option<u64>,
    state: State<Arc<AppState>>,
) -> Result<HashMap<String, String>, String> {
    let known: Vec<String> = {
        let k = state.known_claude_terminals.lock_or_err()?;
        k.iter().cloned().collect()
    };

    if known.is_empty() {
        return Ok(HashMap::new());
    }

    // Read session files from ~/.claude/sessions/
    let sessions_dir = resolve_claude_sessions_dir();
    let session_files = read_claude_session_files(&sessions_dir, session_max_age_hours);

    let mut result = HashMap::new();

    for terminal_id in &known {
        // Get child PID from PTY handle
        let child_pid = {
            let ptys = state.pty_handles.lock_or_err()?;
            ptys.get(terminal_id).and_then(|h| h.child_pid())
        };

        // Get terminal CWD for fallback
        let terminal_cwd = {
            let terminals = state.terminals.lock_or_err()?;
            terminals.get(terminal_id).and_then(|s| s.cwd.clone())
        };

        // Strategy 1: PID tree matching
        if let Some(pid) = child_pid {
            let descendant_pids = get_descendant_pids(pid);
            if let Some(session_id) = find_session_by_pids(&session_files, &descendant_pids) {
                result.insert(terminal_id.clone(), session_id);
                continue;
            }
        }

        // Strategy 2: CWD + most-recent fallback
        if let Some(ref cwd) = terminal_cwd {
            if let Some(session_id) = find_session_by_cwd(&session_files, cwd) {
                tracing::warn!(
                    terminal_id,
                    cwd,
                    "PID tree match failed, using CWD fallback"
                );
                result.insert(terminal_id.clone(), session_id);
            }
        }
    }

    Ok(result)
}

/// A parsed Claude session file entry.
#[derive(Debug, Clone)]
struct ClaudeSessionFile {
    pid: u32,
    session_id: String,
    cwd: String,
    started_at: u64,
}

/// Validate that a startup command override is safe to execute.
///
/// The only allowed form is `claude --resume <valid_session_id>`. External
/// viewers use a structured IPC argument and are validated separately.
pub(crate) fn is_valid_startup_command_override(cmd: &str) -> bool {
    cmd.strip_prefix("claude --resume ")
        .is_some_and(is_valid_session_id)
}

/// Validate that a Claude session ID contains only safe characters
/// (alphanumeric, hyphens, underscores). Prevents command injection when
/// the ID is interpolated into `claude --resume <id>`.
fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Resolve the Claude sessions directory path.
fn resolve_claude_sessions_dir() -> std::path::PathBuf {
    #[cfg(windows)]
    {
        if let Ok(home) = std::env::var("USERPROFILE") {
            return std::path::PathBuf::from(home)
                .join(".claude")
                .join("sessions");
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME") {
            return std::path::PathBuf::from(home)
                .join(".claude")
                .join("sessions");
        }
    }
    std::path::PathBuf::from(".claude").join("sessions")
}

/// Read and parse all Claude session files from the given directory.
/// If `max_age_hours` is Some, sessions older than the threshold are filtered out.
fn read_claude_session_files(
    dir: &std::path::Path,
    max_age_hours: Option<u64>,
) -> Vec<ClaudeSessionFile> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    // Compute the cutoff timestamp (seconds since epoch) if max_age_hours is set.
    // 0 means "no filter" (accept all sessions regardless of age).
    let cutoff = max_age_hours.filter(|&hours| hours > 0).and_then(|hours| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs().saturating_sub(hours * 3600))
    });

    let mut result = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                let pid = val.get("pid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let session_id = val
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let cwd = val
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let started_at = val.get("startedAt").and_then(|v| v.as_u64()).unwrap_or(0);

                // Skip stale sessions
                if let Some(min_ts) = cutoff {
                    if started_at < min_ts {
                        continue;
                    }
                }

                if is_valid_session_id(&session_id) {
                    result.push(ClaudeSessionFile {
                        pid,
                        session_id,
                        cwd,
                        started_at,
                    });
                }
            }
        }
    }
    result
}

/// Get all descendant PIDs of a given process (including the process itself).
/// Delegates to the shared process enumeration in `crate::process_tree`
/// (ADR-0009) so there is a single snapshot implementation per platform.
fn get_descendant_pids(root_pid: u32) -> Vec<u32> {
    let snapshot = crate::process_tree::snapshot_processes();
    crate::process_tree::descendant_pids(&snapshot, root_pid)
        .into_iter()
        .collect()
}

/// Find a Claude session ID by matching any of the given PIDs against session file PIDs.
/// When multiple sessions match, the most recently started one wins.
fn find_session_by_pids(sessions: &[ClaudeSessionFile], pids: &[u32]) -> Option<String> {
    sessions
        .iter()
        .filter(|s| pids.contains(&s.pid))
        .max_by_key(|s| s.started_at)
        .map(|s| s.session_id.clone())
}

/// Find a Claude session ID by matching CWD (most recent session wins).
fn find_session_by_cwd(sessions: &[ClaudeSessionFile], cwd: &str) -> Option<String> {
    let normalized_cwd = path_utils::normalize_path_for_comparison(cwd);
    sessions
        .iter()
        .filter(|s| path_utils::normalize_path_for_comparison(&s.cwd) == normalized_cwd)
        .max_by_key(|s| s.started_at)
        .map(|s| s.session_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- Claude session file parsing tests --

    #[test]
    fn read_claude_session_files_empty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let sessions = read_claude_session_files(tmp.path(), None);
        assert!(sessions.is_empty());
    }

    #[test]
    fn read_claude_session_files_valid_json() {
        let tmp = tempfile::tempdir().unwrap();
        let content = r#"{"pid":12345,"sessionId":"abc-123","cwd":"/home/user","startedAt":1000}"#;
        std::fs::write(tmp.path().join("12345.json"), content).unwrap();
        let sessions = read_claude_session_files(tmp.path(), None);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].pid, 12345);
        assert_eq!(sessions[0].session_id, "abc-123");
        assert_eq!(sessions[0].cwd, "/home/user");
        assert_eq!(sessions[0].started_at, 1000);
    }

    #[test]
    fn read_claude_session_files_ignores_non_json() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("readme.txt"), "not json").unwrap();
        let sessions = read_claude_session_files(tmp.path(), None);
        assert!(sessions.is_empty());
    }

    #[test]
    fn read_claude_session_files_ignores_invalid_json() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("bad.json"), "not valid json!").unwrap();
        let sessions = read_claude_session_files(tmp.path(), None);
        assert!(sessions.is_empty());
    }

    #[test]
    fn find_session_by_pids_matches() {
        let sessions = vec![
            ClaudeSessionFile {
                pid: 100,
                session_id: "s1".into(),
                cwd: "/a".into(),
                started_at: 1,
            },
            ClaudeSessionFile {
                pid: 200,
                session_id: "s2".into(),
                cwd: "/b".into(),
                started_at: 2,
            },
        ];
        assert_eq!(find_session_by_pids(&sessions, &[200]), Some("s2".into()));
        assert_eq!(find_session_by_pids(&sessions, &[300]), None);
    }

    #[test]
    fn find_session_by_cwd_picks_most_recent() {
        let sessions = vec![
            ClaudeSessionFile {
                pid: 1,
                session_id: "old".into(),
                cwd: "/home/user".into(),
                started_at: 100,
            },
            ClaudeSessionFile {
                pid: 2,
                session_id: "new".into(),
                cwd: "/home/user".into(),
                started_at: 200,
            },
            ClaudeSessionFile {
                pid: 3,
                session_id: "other".into(),
                cwd: "/other".into(),
                started_at: 300,
            },
        ];
        assert_eq!(
            find_session_by_cwd(&sessions, "/home/user"),
            Some("new".into())
        );
        assert_eq!(find_session_by_cwd(&sessions, "/nonexistent"), None);
    }

    #[test]
    fn get_descendant_pids_includes_root() {
        let pids = get_descendant_pids(99999);
        assert!(pids.contains(&99999));
    }

    // -- Session ID validation tests --

    #[test]
    fn is_valid_session_id_accepts_safe_ids() {
        assert!(is_valid_session_id("abc-123"));
        assert!(is_valid_session_id("session_id_v2"));
        assert!(is_valid_session_id("a1b2c3"));
        assert!(is_valid_session_id("ABC-def_012"));
    }

    #[test]
    fn is_valid_session_id_rejects_dangerous_ids() {
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("id; rm -rf /"));
        assert!(!is_valid_session_id("id && echo pwned"));
        assert!(!is_valid_session_id("id | cat /etc/passwd"));
        assert!(!is_valid_session_id("$(whoami)"));
        assert!(!is_valid_session_id("id`whoami`"));
        assert!(!is_valid_session_id("hello world"));
        assert!(!is_valid_session_id("id\nnewline"));
    }

    // -- Startup command override validation tests --

    #[test]
    fn startup_command_override_accepts_valid_resume() {
        assert!(is_valid_startup_command_override("claude --resume abc-123"));
        assert!(is_valid_startup_command_override(
            "claude --resume session_v2"
        ));
        assert!(is_valid_startup_command_override("claude --resume A1B2"));
    }

    #[test]
    fn startup_command_override_rejects_arbitrary_commands() {
        assert!(!is_valid_startup_command_override("rm -rf /"));
        assert!(!is_valid_startup_command_override("echo pwned"));
        assert!(!is_valid_startup_command_override(
            "claude --resume bad; rm -rf /"
        ));
        assert!(!is_valid_startup_command_override(
            "claude --resume $(whoami)"
        ));
        assert!(!is_valid_startup_command_override(
            "claude --resume id && echo x"
        ));
        assert!(!is_valid_startup_command_override(""));
        assert!(!is_valid_startup_command_override("claude --resume "));
        assert!(!is_valid_startup_command_override("claude --resume"));
        assert!(!is_valid_startup_command_override(
            "not-claude --resume abc"
        ));
    }

    #[test]
    fn startup_command_override_rejects_raw_viewer_commands() {
        assert!(!is_valid_startup_command_override(
            "vi '/home/user/file.txt'"
        ));
        assert!(!is_valid_startup_command_override(
            "notepad 'C:\\Users\\me\\README.md'"
        ));
    }

    #[test]
    fn read_claude_session_files_rejects_invalid_session_id() {
        let tmp = tempfile::tempdir().unwrap();
        let content = r#"{"pid":1,"sessionId":"bad; rm -rf /","cwd":"/home","startedAt":1}"#;
        std::fs::write(tmp.path().join("1.json"), content).unwrap();
        let sessions = read_claude_session_files(tmp.path(), None);
        assert!(sessions.is_empty());
    }

    #[test]
    fn find_session_by_pids_picks_most_recent_on_multiple_matches() {
        let sessions = vec![
            ClaudeSessionFile {
                pid: 100,
                session_id: "old-session".into(),
                cwd: "/a".into(),
                started_at: 1,
            },
            ClaudeSessionFile {
                pid: 200,
                session_id: "new-session".into(),
                cwd: "/b".into(),
                started_at: 10,
            },
        ];
        // Both PIDs match — should pick the most recent (started_at=10)
        assert_eq!(
            find_session_by_pids(&sessions, &[100, 200]),
            Some("new-session".into())
        );
    }

    // -- Stale session filtering tests --

    #[test]
    fn read_claude_session_files_filters_stale_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Recent session (1 hour ago)
        let recent = format!(
            r#"{{"pid":1,"sessionId":"recent","cwd":"/a","startedAt":{}}}"#,
            now - 3600
        );
        std::fs::write(tmp.path().join("1.json"), recent).unwrap();

        // Stale session (48 hours ago)
        let stale = format!(
            r#"{{"pid":2,"sessionId":"stale","cwd":"/b","startedAt":{}}}"#,
            now - 48 * 3600
        );
        std::fs::write(tmp.path().join("2.json"), stale).unwrap();

        // With 24h max age, only the recent session should pass
        let sessions = read_claude_session_files(tmp.path(), Some(24));
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "recent");
    }

    #[test]
    fn read_claude_session_files_no_filter_when_none() {
        let tmp = tempfile::tempdir().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Old session (72 hours ago)
        let old = format!(
            r#"{{"pid":1,"sessionId":"old","cwd":"/a","startedAt":{}}}"#,
            now - 72 * 3600
        );
        std::fs::write(tmp.path().join("1.json"), old).unwrap();

        // No max age filter — session should be included
        let sessions = read_claude_session_files(tmp.path(), None);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "old");
    }

    #[test]
    fn read_claude_session_files_zero_hours_disables_filter() {
        let tmp = tempfile::tempdir().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Very old session (30 days ago)
        let old = format!(
            r#"{{"pid":1,"sessionId":"ancient","cwd":"/a","startedAt":{}}}"#,
            now - 30 * 24 * 3600
        );
        std::fs::write(tmp.path().join("1.json"), old).unwrap();

        // 0 hours = disabled, but saturating_sub means cutoff = now,
        // so we actually need to handle 0 as a special case.
        // Let's verify current behavior: 0 * 3600 = 0, cutoff = now - 0 = now.
        // startedAt < now → filtered out. That's NOT what we want.
        // We should treat 0 as "no filter".
        let sessions = read_claude_session_files(tmp.path(), Some(0));
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "ancient");
    }
}
