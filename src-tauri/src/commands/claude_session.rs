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
                eprintln!(
                    "[claude-session] PID tree match failed for {terminal_id}, \
                     using CWD fallback (cwd={cwd})"
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
/// Allowed forms:
/// - `claude --resume <valid_session_id>` — Claude session restore
/// - `<viewer_command> '<file_path>'` — Extension viewer from settings whitelist
///
/// `allowed_viewer_commands` should contain the command names registered in
/// `settings.fileExplorer.extensionViewers` (e.g., `["vi", "less"]`).
pub(crate) fn is_valid_startup_command_override(
    cmd: &str,
    allowed_viewer_commands: &[String],
) -> bool {
    // Check claude --resume pattern first
    if cmd
        .strip_prefix("claude --resume ")
        .is_some_and(|id| is_valid_session_id(id))
    {
        return true;
    }

    // Check extension viewer pattern: "<command> '<path>'"
    // The path is single-quoted by shellEscape on the frontend.
    // shellEscape escapes embedded single quotes as '\'' (end-quote, escaped-quote, start-quote),
    // so the full argument looks like: 'part1'\''part2'
    // We validate the structure: command + space + shell-escaped path, no other shell metacharacters.
    for viewer_cmd in allowed_viewer_commands {
        if let Some(rest) = cmd.strip_prefix(viewer_cmd.as_str()) {
            if let Some(after_space) = rest.strip_prefix(' ') {
                if is_valid_shell_escaped_path(after_space) {
                    return true;
                }
            }
        }
    }

    false
}

/// Validate a shell-escaped path produced by the frontend's `shellEscape()`.
///
/// Accepted format: `'<content>'` where embedded single-quotes are escaped as `'\''`.
/// The full pattern is one or more `'...'` segments separated by `'\''`.
/// No shell metacharacters (`;`, `&`, `|`, `$`, `` ` ``, `(`, `)`) are allowed
/// inside the quoted segments.
fn is_valid_shell_escaped_path(s: &str) -> bool {
    // Must start with ' and end with '
    if !s.starts_with('\'') || !s.ends_with('\'') || s.len() < 2 {
        return false;
    }

    // Dangerous shell metacharacters that must not appear even inside quotes.
    // Single-quoted strings in POSIX shells don't interpret these, but since
    // the escaped-quote pattern ('\'') temporarily leaves the quoted context,
    // we reject them to be safe.
    const DANGEROUS: &[char] = &[';', '&', '|', '$', '`', '(', ')', '\n'];

    // Strip outer quotes and check segments split by '\'' (escaped quote)
    let inner = &s[1..s.len() - 1];
    for segment in inner.split("'\\''") {
        if segment.contains(DANGEROUS) {
            return false;
        }
    }

    true
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
/// Uses platform-specific process enumeration.
fn get_descendant_pids(root_pid: u32) -> Vec<u32> {
    use std::collections::{HashSet, VecDeque};

    let mut result = vec![root_pid];
    let mut seen = HashSet::new();
    seen.insert(root_pid);

    #[cfg(windows)]
    {
        match create_process_snapshot() {
            Ok(snapshot) => {
                let parent_map = build_parent_map(&snapshot);
                let mut queue = VecDeque::new();
                queue.push_back(root_pid);
                while let Some(pid) = queue.pop_front() {
                    if let Some(children) = parent_map.get(&pid) {
                        for &child in children {
                            if seen.insert(child) {
                                result.push(child);
                                queue.push_back(child);
                            }
                        }
                    }
                }
            }
            Err(e) => {
                eprintln!(
                    "[claude-session] Failed to create process snapshot for PID {root_pid}: {e}"
                );
            }
        }
    }

    #[cfg(not(windows))]
    {
        let mut queue = VecDeque::new();
        queue.push_back(root_pid);
        while let Some(pid) = queue.pop_front() {
            let children_path = format!("/proc/{pid}/task/{pid}/children");
            match std::fs::read_to_string(&children_path) {
                Ok(content) => {
                    for token in content.split_whitespace() {
                        if let Ok(child_pid) = token.parse::<u32>() {
                            if seen.insert(child_pid) {
                                result.push(child_pid);
                                queue.push_back(child_pid);
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[claude-session] Cannot read /proc children for PID {pid}: {e} \
                         (kernel CONFIG_PROC_CHILDREN may be disabled, or PID exited)"
                    );
                }
            }
        }
    }

    result
}

#[cfg(windows)]
fn create_process_snapshot() -> Result<Vec<(u32, u32)>, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };

    /// RAII guard that closes a Windows HANDLE on drop, preventing leaks on panic.
    struct SnapshotGuard(windows_sys::Win32::Foundation::HANDLE);
    impl Drop for SnapshotGuard {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return Err("Failed to create snapshot".into());
        }
        let _guard = SnapshotGuard(snap);

        let mut entry: PROCESSENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32>() as u32;
        let mut pairs = Vec::new();
        if Process32First(snap, &mut entry) != 0 {
            loop {
                pairs.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if Process32Next(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        Ok(pairs)
    }
}

#[cfg(windows)]
fn build_parent_map(snapshot: &[(u32, u32)]) -> HashMap<u32, Vec<u32>> {
    let mut map: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(pid, ppid) in snapshot {
        map.entry(ppid).or_default().push(pid);
    }
    map
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
        let no_viewers: &[String] = &[];
        assert!(is_valid_startup_command_override(
            "claude --resume abc-123",
            no_viewers
        ));
        assert!(is_valid_startup_command_override(
            "claude --resume session_v2",
            no_viewers,
        ));
        assert!(is_valid_startup_command_override(
            "claude --resume A1B2",
            no_viewers
        ));
    }

    #[test]
    fn startup_command_override_rejects_arbitrary_commands() {
        let no_viewers: &[String] = &[];
        assert!(!is_valid_startup_command_override("rm -rf /", no_viewers));
        assert!(!is_valid_startup_command_override("echo pwned", no_viewers));
        assert!(!is_valid_startup_command_override(
            "claude --resume bad; rm -rf /",
            no_viewers,
        ));
        assert!(!is_valid_startup_command_override(
            "claude --resume $(whoami)",
            no_viewers,
        ));
        assert!(!is_valid_startup_command_override(
            "claude --resume id && echo x",
            no_viewers,
        ));
        assert!(!is_valid_startup_command_override("", no_viewers));
        assert!(!is_valid_startup_command_override(
            "claude --resume ",
            no_viewers
        ));
        assert!(!is_valid_startup_command_override(
            "claude --resume",
            no_viewers
        ));
        assert!(!is_valid_startup_command_override(
            "not-claude --resume abc",
            no_viewers,
        ));
    }

    #[test]
    fn startup_command_override_accepts_whitelisted_viewer_command() {
        let viewers = vec!["vi".to_string(), "less".to_string(), "cat".to_string()];
        // Simple file path
        assert!(is_valid_startup_command_override(
            "vi '/home/user/file.txt'",
            &viewers
        ));
        assert!(is_valid_startup_command_override(
            "less '/tmp/log.log'",
            &viewers
        ));
        assert!(is_valid_startup_command_override(
            "cat '/data/notes.md'",
            &viewers
        ));
        // Windows-style path
        assert!(is_valid_startup_command_override(
            "vi 'C:\\Users\\test\\file.rs'",
            &viewers
        ));
        // Path with spaces
        assert!(is_valid_startup_command_override(
            "vi '/home/user/my file.txt'",
            &viewers
        ));
        // Path with embedded single quote (shellEscape produces: 'it'\''s here')
        assert!(is_valid_startup_command_override(
            "vi 'it'\\''s here'",
            &viewers
        ));
    }

    #[test]
    fn startup_command_override_rejects_non_whitelisted_viewer_command() {
        let viewers = vec!["vi".to_string(), "less".to_string()];
        // Command not in whitelist
        assert!(!is_valid_startup_command_override(
            "rm '/home/user/file.txt'",
            &viewers
        ));
        assert!(!is_valid_startup_command_override(
            "bash '/tmp/evil.sh'",
            &viewers
        ));
    }

    #[test]
    fn startup_command_override_rejects_viewer_with_injection() {
        let viewers = vec!["vi".to_string()];
        // Injection attempts inside the "path" argument
        assert!(!is_valid_startup_command_override(
            "vi 'file.txt'; rm -rf /",
            &viewers
        ));
        assert!(!is_valid_startup_command_override(
            "vi 'file.txt' && echo pwned",
            &viewers
        ));
        assert!(!is_valid_startup_command_override("vi $(whoami)", &viewers));
        assert!(!is_valid_startup_command_override(
            "vi file.txt; rm -rf /",
            &viewers
        ));
        // No argument at all
        assert!(!is_valid_startup_command_override("vi", &viewers));
        assert!(!is_valid_startup_command_override("vi ", &viewers));
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
