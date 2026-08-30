use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::State;

use crate::lock_ext::MutexExt;
use crate::state::AppState;

use super::session_attribution::{provider_terminal_domains, ProviderSessionLookup};
use super::wsl_agent_session::{resolve_wsl_agent_processes, WslAgentProcess, WslAgentProvider};

/// Resolve Claude Code session IDs for known Claude terminals.
///
/// The PTY descendant PID must match `~/.claude/sessions/<pid>.json`.
/// CWD is never an attribution fallback because multiple panes commonly share it.
#[tauri::command(async)]
pub fn get_claude_session_ids(
    session_max_age_hours: Option<u64>,
    state: State<Arc<AppState>>,
) -> Result<HashMap<String, Option<String>>, String> {
    get_claude_session_ids_impl(session_max_age_hours, &state)
}

pub(crate) fn get_claude_session_ids_impl(
    session_max_age_hours: Option<u64>,
    state: &AppState,
) -> Result<HashMap<String, Option<String>>, String> {
    Ok(get_claude_session_lookup_impl(session_max_age_hours, state)?.attributions)
}

pub(crate) fn get_claude_session_lookup_impl(
    session_max_age_hours: Option<u64>,
    state: &AppState,
) -> Result<ProviderSessionLookup, String> {
    let known: Vec<String> = {
        let k = state.known_claude_terminals.lock_or_err()?;
        k.iter().cloned().collect()
    };

    let domains = provider_terminal_domains(&known, state)?;
    let terminal_roots = domains.native_roots;
    let native_terminal_ids: HashSet<String> = terminal_roots
        .iter()
        .map(|(terminal_id, _)| terminal_id.clone())
        .collect();
    let mut failed_terminal_ids = HashSet::new();
    let native_descendants = if terminal_roots.is_empty() {
        Vec::new()
    } else {
        match crate::process_tree::try_snapshot_processes() {
            Ok(snapshot) => terminal_roots
                .into_iter()
                .map(|(terminal_id, root_pid)| {
                    (
                        terminal_id,
                        crate::process_tree::descendant_pids(&snapshot, root_pid),
                    )
                })
                .collect(),
            Err(error) => {
                failed_terminal_ids.extend(native_terminal_ids);
                tracing::warn!(%error, "native Claude process attribution failed");
                Vec::new()
            }
        }
    };
    let relevant_native_pids: HashSet<u32> = native_descendants
        .iter()
        .flat_map(|(_, descendants)| descendants.iter().copied())
        .collect();
    let session_files = if relevant_native_pids.is_empty() {
        Vec::new()
    } else {
        let sessions_dir = resolve_claude_sessions_dir();
        let session_lookup = read_claude_session_files_for_pids_detailed(
            &sessions_dir,
            session_max_age_hours,
            Some(&relevant_native_pids),
        );
        failed_terminal_ids.extend(affected_native_terminal_ids(
            &native_descendants,
            &session_lookup,
        ));
        session_lookup.sessions
    };
    let candidates = native_descendants
        .into_iter()
        .filter_map(|(terminal_id, descendants)| {
            find_session_by_pids(&session_files, &descendants)
                .map(|session_id| (terminal_id, session_id))
        })
        .collect();
    let mut result = crate::process_tree::complete_agent_session_attributions(
        &known,
        remove_duplicate_attributions(candidates),
    );
    match resolve_wsl_agent_processes(state, WslAgentProvider::Claude) {
        Ok(lookup) => {
            failed_terminal_ids.extend(lookup.failed_terminal_ids);
            for (terminal_id, process) in lookup.attributions {
                let session_id = match process {
                    Some(process) => {
                        match find_wsl_claude_session_checked(&process, session_max_age_hours) {
                            Ok(session_id) => session_id,
                            Err(error) => {
                                failed_terminal_ids.insert(terminal_id.clone());
                                tracing::warn!(%error, "WSL Claude session file lookup failed");
                                None
                            }
                        }
                    }
                    None => None,
                };
                result.insert(terminal_id, session_id);
            }
        }
        Err(error) => {
            failed_terminal_ids.extend(domains.wsl_terminal_ids);
            tracing::warn!(%error, "WSL Claude attribution failed");
        }
    }
    Ok(ProviderSessionLookup {
        attributions: crate::process_tree::reject_duplicate_session_attributions(result, "Claude"),
        failed_terminal_ids,
    })
}

fn find_wsl_claude_session_checked(
    process: &WslAgentProcess,
    session_max_age_hours: Option<u64>,
) -> Result<Option<String>, String> {
    let Some(directory) = process.claude_sessions_dir() else {
        return Ok(None);
    };
    let relevant_pids = HashSet::from([process.pid]);
    let (sessions, lookup_failed) = read_claude_session_files_for_pids_checked(
        &directory,
        session_max_age_hours,
        Some(&relevant_pids),
    );
    if lookup_failed {
        return Err(format!(
            "failed to read Claude session files from {}",
            directory.display()
        ));
    }
    Ok(find_session_by_pids(
        &sessions,
        &HashSet::from([process.pid]),
    ))
}

/// A parsed Claude session file entry.
#[derive(Debug, Clone)]
struct ClaudeSessionFile {
    pid: u32,
    session_id: String,
    started_at: u64,
}

/// Validate that a startup command override is safe to execute.
///
/// The only allowed form is `<configured claude command> --resume
/// <valid_session_id>`, where the command prefix is re-derived from settings on
/// disk (`claude.command`, normalized) instead of trusted from the caller.
/// External viewers use a structured IPC argument and are validated separately.
pub(crate) fn is_valid_claude_startup_command_override(
    cmd: &str,
    configured_command: &str,
) -> bool {
    let agent = crate::settings::agent_command::resolve_agent_command(
        configured_command,
        crate::settings::agent_command::DEFAULT_CLAUDE_COMMAND,
    );
    cmd.strip_prefix(&format!("{agent} --resume "))
        .is_some_and(is_valid_session_id)
}

/// Validate that an agent session ID starts with an alphanumeric character and
/// contains only alphanumerics, hyphens, or underscores. Shared with Codex.
pub(crate) fn is_valid_session_id(id: &str) -> bool {
    id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
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
#[cfg(test)]
fn read_claude_session_files(
    dir: &std::path::Path,
    max_age_hours: Option<u64>,
) -> Vec<ClaudeSessionFile> {
    read_claude_session_files_checked(dir, max_age_hours).0
}

#[cfg(test)]
fn read_claude_session_files_checked(
    dir: &std::path::Path,
    max_age_hours: Option<u64>,
) -> (Vec<ClaudeSessionFile>, bool) {
    read_claude_session_files_for_pids_checked(dir, max_age_hours, None)
}

fn read_claude_session_files_for_pids_checked(
    dir: &std::path::Path,
    max_age_hours: Option<u64>,
    relevant_pids: Option<&HashSet<u32>>,
) -> (Vec<ClaudeSessionFile>, bool) {
    let lookup = read_claude_session_files_for_pids_detailed(dir, max_age_hours, relevant_pids);
    let lookup_failed = lookup.scope_failed || !lookup.failed_pids.is_empty();
    (lookup.sessions, lookup_failed)
}

struct ClaudeSessionFileLookup {
    sessions: Vec<ClaudeSessionFile>,
    failed_pids: HashSet<u32>,
    scope_failed: bool,
}

fn read_claude_session_files_for_pids_detailed(
    dir: &std::path::Path,
    max_age_hours: Option<u64>,
    relevant_pids: Option<&HashSet<u32>>,
) -> ClaudeSessionFileLookup {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ClaudeSessionFileLookup {
                sessions: Vec::new(),
                failed_pids: HashSet::new(),
                scope_failed: false,
            };
        }
        Err(error) => {
            tracing::warn!(path = %dir.display(), %error, "failed to read Claude sessions directory");
            return ClaudeSessionFileLookup {
                sessions: Vec::new(),
                failed_pids: HashSet::new(),
                scope_failed: true,
            };
        }
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
    let mut failed_pids = HashSet::new();
    let mut scope_failed = false;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                scope_failed = true;
                tracing::warn!(%error, "failed to read a Claude session directory entry");
                continue;
            }
        };
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let file_pid = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .and_then(|stem| stem.parse::<u32>().ok());
        if let Some(relevant_pids) = relevant_pids {
            if !file_pid.is_some_and(|pid| relevant_pids.contains(&pid)) {
                continue;
            }
        }
        match std::fs::read_to_string(&path)
            .map_err(|error| error.to_string())
            .and_then(|content| {
                serde_json::from_str::<serde_json::Value>(&content)
                    .map_err(|error| error.to_string())
            }) {
            Ok(val) => {
                let pid = val.get("pid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let session_id = val
                    .get("sessionId")
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
                        started_at,
                    });
                }
            }
            Err(error) => {
                match file_pid {
                    Some(pid) => {
                        failed_pids.insert(pid);
                    }
                    None => scope_failed = true,
                }
                tracing::warn!(path = %path.display(), %error, "failed to parse Claude session file");
            }
        }
    }
    ClaudeSessionFileLookup {
        sessions: result,
        failed_pids,
        scope_failed,
    }
}

fn affected_native_terminal_ids(
    native_descendants: &[(String, HashSet<u32>)],
    lookup: &ClaudeSessionFileLookup,
) -> HashSet<String> {
    native_descendants
        .iter()
        .filter(|(_, descendants)| {
            lookup.scope_failed || !descendants.is_disjoint(&lookup.failed_pids)
        })
        .map(|(terminal_id, _)| terminal_id.clone())
        .collect()
}

/// Find a Claude session ID by matching any of the given PIDs against session file PIDs.
/// When multiple sessions match, the most recently started one wins.
fn find_session_by_pids(sessions: &[ClaudeSessionFile], pids: &HashSet<u32>) -> Option<String> {
    sessions
        .iter()
        .filter(|s| pids.contains(&s.pid))
        .max_by_key(|s| s.started_at)
        .map(|s| s.session_id.clone())
}

fn remove_duplicate_attributions(candidates: Vec<(String, String)>) -> HashMap<String, String> {
    let mut seen = HashSet::new();
    let mut duplicates = HashSet::new();
    for (_, session_id) in &candidates {
        if !seen.insert(session_id.clone()) {
            duplicates.insert(session_id.clone());
        }
    }
    if !duplicates.is_empty() {
        tracing::warn!(
            ?duplicates,
            "Claude session attribution collision; skipping restore"
        );
    }
    candidates
        .into_iter()
        .filter(|(_, session_id)| !duplicates.contains(session_id))
        .collect()
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
        assert!(read_claude_session_files_checked(tmp.path(), None).1);
    }

    #[test]
    fn pid_scoped_read_ignores_an_unrelated_malformed_session_file() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("999.json"), "not valid json!").unwrap();
        std::fs::write(
            tmp.path().join("123.json"),
            r#"{"pid":123,"sessionId":"session-123","startedAt":1000}"#,
        )
        .unwrap();

        let (sessions, lookup_failed) = read_claude_session_files_for_pids_checked(
            tmp.path(),
            None,
            Some(&HashSet::from([123])),
        );

        assert!(!lookup_failed);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "session-123");
    }

    #[test]
    fn pid_scoped_read_reports_a_malformed_relevant_session_file() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("123.json"), "not valid json!").unwrap();

        let (_, lookup_failed) = read_claude_session_files_for_pids_checked(
            tmp.path(),
            None,
            Some(&HashSet::from([123])),
        );

        assert!(lookup_failed);
    }

    #[test]
    fn malformed_live_pid_only_fails_its_own_terminal() {
        let lookup = ClaudeSessionFileLookup {
            sessions: Vec::new(),
            failed_pids: HashSet::from([123]),
            scope_failed: false,
        };
        let affected = affected_native_terminal_ids(
            &[
                ("terminal-a".into(), HashSet::from([100, 123])),
                ("terminal-b".into(), HashSet::from([200, 201])),
            ],
            &lookup,
        );

        assert_eq!(affected, HashSet::from(["terminal-a".into()]));
    }

    #[test]
    fn find_session_by_pids_matches() {
        let sessions = vec![
            ClaudeSessionFile {
                pid: 100,
                session_id: "s1".into(),
                started_at: 1,
            },
            ClaudeSessionFile {
                pid: 200,
                session_id: "s2".into(),
                started_at: 2,
            },
        ];
        assert_eq!(
            find_session_by_pids(&sessions, &HashSet::from([200])),
            Some("s2".into())
        );
        assert_eq!(find_session_by_pids(&sessions, &HashSet::from([300])), None);
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
        assert!(!is_valid_session_id("--last"));
    }

    // -- Startup command override validation tests --

    #[test]
    fn startup_command_override_accepts_valid_resume() {
        assert!(is_valid_claude_startup_command_override(
            "claude --resume abc-123",
            "claude"
        ));
        assert!(is_valid_claude_startup_command_override(
            "claude --resume session_v2",
            "claude"
        ));
        assert!(is_valid_claude_startup_command_override(
            "claude --resume A1B2",
            "claude"
        ));
    }

    #[test]
    fn startup_command_override_rejects_arbitrary_commands() {
        assert!(!is_valid_claude_startup_command_override(
            "rm -rf /", "claude"
        ));
        assert!(!is_valid_claude_startup_command_override(
            "echo pwned",
            "claude"
        ));
        assert!(!is_valid_claude_startup_command_override(
            "claude --resume bad; rm -rf /",
            "claude"
        ));
        assert!(!is_valid_claude_startup_command_override(
            "claude --resume $(whoami)",
            "claude"
        ));
        assert!(!is_valid_claude_startup_command_override(
            "claude --resume id && echo x",
            "claude"
        ));
        assert!(!is_valid_claude_startup_command_override("", "claude"));
        assert!(!is_valid_claude_startup_command_override(
            "claude --resume ",
            "claude"
        ));
        assert!(!is_valid_claude_startup_command_override(
            "claude --resume",
            "claude"
        ));
        assert!(!is_valid_claude_startup_command_override(
            "not-claude --resume abc",
            "claude"
        ));
    }

    #[test]
    fn startup_command_override_follows_the_configured_launch_command() {
        assert!(is_valid_claude_startup_command_override(
            "claude --dangerously-skip-permissions --resume abc-123",
            "claude --dangerously-skip-permissions"
        ));
        // Whitespace in the setting is normalized before comparison.
        assert!(is_valid_claude_startup_command_override(
            "claude --yolo --resume abc-123",
            "  claude   --yolo  "
        ));
        // A caller cannot add flags the user did not configure.
        assert!(!is_valid_claude_startup_command_override(
            "claude --dangerously-skip-permissions --resume abc-123",
            "claude"
        ));
        // An unsafe setting falls back to the bare default, not to itself.
        assert!(!is_valid_claude_startup_command_override(
            "claude; rm -rf / --resume abc-123",
            "claude; rm -rf /"
        ));
        assert!(is_valid_claude_startup_command_override(
            "claude --resume abc-123",
            "claude; rm -rf /"
        ));
    }

    #[test]
    fn startup_command_override_rejects_raw_viewer_commands() {
        assert!(!is_valid_claude_startup_command_override(
            "vi '/home/user/file.txt'",
            "claude"
        ));
        assert!(!is_valid_claude_startup_command_override(
            "notepad 'C:\\Users\\me\\README.md'",
            "claude"
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
                started_at: 1,
            },
            ClaudeSessionFile {
                pid: 200,
                session_id: "new-session".into(),
                started_at: 10,
            },
        ];
        // Both PIDs match — should pick the most recent (started_at=10)
        assert_eq!(
            find_session_by_pids(&sessions, &HashSet::from([100, 200])),
            Some("new-session".into())
        );
    }

    #[test]
    fn duplicate_claude_session_attribution_fails_closed() {
        let candidates = vec![
            ("pane-a".into(), "same-session".into()),
            ("pane-b".into(), "same-session".into()),
        ];
        assert!(remove_duplicate_attributions(candidates).is_empty());
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
