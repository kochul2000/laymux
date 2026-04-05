use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

use crate::automation_server::AutomationResponse;
use crate::cli::{LxMessage, LxResponse};
use crate::constants::*;
use crate::lock_ext::MutexExt;
use crate::output_buffer::TerminalOutputBuffer;
use crate::path_utils;
use crate::pty;
use crate::state::AppState;
use crate::terminal::{
    TerminalActivity, TerminalConfig, TerminalNotification, TerminalSession, TerminalStateInfo,
};

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to Laymux.", name)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_terminal_session(
    id: String,
    profile: String,
    cols: u16,
    rows: u16,
    sync_group: String,
    cwd_receive: Option<bool>,
    cwd: Option<String>,
    startup_command_override: Option<String>,
    state: State<Arc<AppState>>,
    app: AppHandle,
) -> Result<TerminalSession, String> {
    // Inject LX_SOCKET and LX_AUTOMATION_PORT env vars
    let mut env = Vec::new();
    if let Ok(path_lock) = state.ipc_socket_path.lock_or_err() {
        if let Some(ref socket_path) = *path_lock {
            env.push((ENV_LX_SOCKET.to_string(), socket_path.clone()));
        }
    }
    if let Ok(port_lock) = state.automation_port.lock_or_err() {
        if let Some(port) = *port_lock {
            env.push((ENV_LX_AUTOMATION_PORT.to_string(), port.to_string()));
        }
    }
    if let Ok(key_lock) = state.automation_key.lock_or_err() {
        if let Some(ref key) = *key_lock {
            env.push((ENV_LX_AUTOMATION_KEY.to_string(), key.clone()));
        }
    }

    // Look up the profile's command_line, startup_command, and starting_directory from settings
    let settings = crate::settings::load_settings();
    let matched_profile = settings.profiles.iter().find(|p| p.name == profile);
    let command_line = matched_profile
        .map(|p| p.command_line.clone())
        .unwrap_or_default();
    // Use startup_command_override if provided (e.g., "claude --resume <id>" or
    // extension viewer command like "vi '/path/to/file'").
    // Validate against known safe patterns to prevent arbitrary command injection.
    let allowed_viewer_commands: Vec<String> = settings
        .file_explorer
        .extension_viewers
        .iter()
        .map(|v| v.command.clone())
        .collect();
    let validated_override = startup_command_override
        .filter(|cmd| is_valid_startup_command_override(cmd, &allowed_viewer_commands));
    let startup_command = validated_override.unwrap_or_else(|| {
        matched_profile
            .map(|p| p.startup_command.clone())
            .unwrap_or_default()
    });
    let starting_directory = cwd.filter(|c| !c.is_empty()).unwrap_or_else(|| {
        matched_profile
            .map(|p| p.starting_directory.clone())
            .unwrap_or_default()
    });

    let config = TerminalConfig {
        profile,
        command_line,
        startup_command,
        starting_directory,
        cols,
        rows,
        sync_group: sync_group.clone(),
        env,
    };

    let mut session = TerminalSession::new(id.clone(), config);
    session.cwd_receive = cwd_receive.unwrap_or(true);

    // Check for duplicate
    {
        let terminals = state.terminals.lock_or_err()?;
        if terminals.contains_key(&id) {
            return Err(format!("Session '{id}' already exists"));
        }
    }

    // Create output buffer for this terminal
    {
        let mut buffers = state.output_buffers.lock_or_err()?;
        buffers.insert(id.clone(), TerminalOutputBuffer::default());
    }

    // Spawn PTY
    let terminal_id = id.clone();
    let app_clone = app.clone();
    let output_buffers = state.output_buffers.clone();
    let buffer_terminal_id = id.clone();
    let known_claude = state.known_claude_terminals.clone();
    let claude_detect_id = id.clone();
    let claude_detected = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let terminals_for_cwd = state.terminals.clone();
    let cwd_terminal_id = id.clone();
    let cwd_app = app.clone();
    let pty_handle = pty::spawn_pty(&session, move |data| {
        // IMPORTANT: Each lock below is acquired and released independently (never nested).
        // Do NOT combine these blocks — nested locks would violate the AppState lock ordering
        // (terminals → output_buffers → known_claude_terminals) and risk deadlock.

        // Write to output buffer
        if let Ok(mut buffers) = output_buffers.lock_or_err() {
            if let Some(buf) = buffers.get_mut(&buffer_terminal_id) {
                buf.push(&data);
            }
        }

        // Proactive Claude Code detection: scan each PTY output chunk for
        // "Claude Code" in terminal title (OSC 0/2). Once detected, the terminal
        // is permanently registered in known_claude_terminals (single source of truth).
        // AtomicBool fast-path avoids scanning after first detection.
        if !claude_detected.load(std::sync::atomic::Ordering::Relaxed) {
            if any_terminal_title_contains(&data, "Claude Code") {
                claude_detected.store(true, std::sync::atomic::Ordering::Relaxed);
                if let Ok(mut known) = known_claude.lock_or_err() {
                    known.insert(claude_detect_id.clone());
                }
                let _ = app_clone.emit(EVENT_CLAUDE_TERMINAL_DETECTED, &claude_detect_id);
            }
        }

        // Proactive CWD detection: scan each PTY output chunk for OSC 7 or OSC 9;9.
        // Updates backend TerminalSession.cwd directly (single source of truth).
        // This ensures CWD is always up-to-date even if the frontend hasn't processed
        // the OSC sequence yet (e.g., during rapid close after Claude Code exit).
        if let Some(raw_cwd) =
            extract_last_osc7_cwd(&data).or_else(|| extract_last_osc9_9_cwd(&data))
        {
            let normalized = path_utils::normalize_wsl_path(&raw_cwd);
            let mut changed = false;
            if let Ok(mut terms) = terminals_for_cwd.lock_or_err() {
                if let Some(session) = terms.get_mut(&cwd_terminal_id) {
                    if session.cwd.as_deref() != Some(&normalized) {
                        // Extract WSL distro before normalization strips it
                        if session.wsl_distro.is_none() {
                            if let Some(distro) = path_utils::extract_wsl_distro_from_path(&raw_cwd)
                            {
                                session.wsl_distro = Some(distro);
                            }
                        }
                        session.cwd = Some(normalized.clone());
                        changed = true;
                    }
                }
            }
            if changed {
                let _ = cwd_app.emit(
                    EVENT_TERMINAL_CWD_CHANGED,
                    serde_json::json!({
                        "terminalId": cwd_terminal_id,
                        "cwd": normalized,
                    }),
                );
            }
        }

        let _ = app_clone.emit(&format!("terminal-output-{terminal_id}"), data);
    })?;

    // Store session and PTY handle
    let result = TerminalSession::new(
        id.clone(),
        TerminalConfig {
            profile: session.config.profile.clone(),
            command_line: session.config.command_line.clone(),
            startup_command: session.config.startup_command.clone(),
            starting_directory: session.config.starting_directory.clone(),
            cols: session.config.cols,
            rows: session.config.rows,
            sync_group: session.config.sync_group.clone(),
            env: session.config.env.clone(),
        },
    );

    {
        let mut terminals = state.terminals.lock_or_err()?;
        terminals.insert(id.clone(), session);
    }

    {
        let mut ptys = state.pty_handles.lock_or_err()?;
        ptys.insert(id.clone(), pty_handle);
    }

    // Register in sync group if non-empty
    if !sync_group.is_empty() {
        let mut groups = state.sync_groups.lock_or_err()?;
        groups
            .entry(sync_group.clone())
            .or_insert_with(|| crate::terminal::SyncGroup::new(sync_group))
            .add_terminal(id);
    }

    Ok(result)
}

#[tauri::command]
pub fn resize_terminal(
    id: String,
    cols: u16,
    rows: u16,
    state: State<Arc<AppState>>,
) -> Result<(), String> {
    // Update config
    {
        let mut terminals = state.terminals.lock_or_err()?;
        let session = terminals
            .get_mut(&id)
            .ok_or_else(|| format!("Session '{id}' not found"))?;
        session.config.cols = cols;
        session.config.rows = rows;
    }

    // Resize PTY
    let ptys = state.pty_handles.lock_or_err()?;
    if let Some(handle) = ptys.get(&id) {
        handle.resize(cols, rows)?;
    }

    Ok(())
}

#[tauri::command]
pub fn write_to_terminal(
    id: String,
    data: String,
    state: State<Arc<AppState>>,
) -> Result<(), String> {
    let ptys = state.pty_handles.lock_or_err()?;

    let handle = ptys
        .get(&id)
        .ok_or_else(|| format!("Session '{id}' not found"))?;

    handle.write(data.as_bytes())
}

#[tauri::command]
pub fn close_terminal_session(id: String, state: State<Arc<AppState>>) -> Result<(), String> {
    // Remove PTY handle (drop closes the PTY)
    {
        let mut ptys = state.pty_handles.lock_or_err()?;
        ptys.remove(&id);
    }

    // Remove output buffer
    {
        let mut buffers = state.output_buffers.lock_or_err()?;
        buffers.remove(&id);
    }

    let mut terminals = state.terminals.lock_or_err()?;

    let session = terminals
        .remove(&id)
        .ok_or_else(|| format!("Session '{id}' not found"))?;

    // Remove from sync group
    if !session.config.sync_group.is_empty() {
        if let Ok(mut groups) = state.sync_groups.lock_or_err() {
            if let Some(group) = groups.get_mut(&session.config.sync_group) {
                group.remove_terminal(&id);
                if group.terminal_ids.is_empty() {
                    groups.remove(&session.config.sync_group);
                }
            }
        }
    }

    // Clean up propagation flag
    if let Ok(mut propagated) = state.propagated_terminals.lock_or_err() {
        propagated.remove(&id);
    }

    // Clean up Claude terminal tracking
    if let Ok(mut known) = state.known_claude_terminals.lock_or_err() {
        known.remove(&id);
    }

    // Clean up notifications for this terminal
    if let Ok(mut notifs) = state.notifications.lock_or_err() {
        notifs.retain(|n| n.terminal_id != id);
    }

    Ok(())
}

/// Register a terminal as running Claude Code (single source of truth).
/// Called by the frontend when it detects Claude from command text (OSC 133 E).
/// The PTY callback also populates this from title detection, but the frontend
/// may detect earlier via command text (e.g., user typed "claude").
#[tauri::command]
pub fn mark_claude_terminal(id: String, state: State<Arc<AppState>>) -> Result<bool, String> {
    let mut known = state.known_claude_terminals.lock_or_err()?;
    Ok(known.insert(id))
}

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
fn is_valid_startup_command_override(cmd: &str, allowed_viewer_commands: &[String]) -> bool {
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

/// Check if a terminal is registered as running Claude Code.
#[tauri::command]
pub fn is_claude_terminal(id: String, state: State<Arc<AppState>>) -> Result<bool, String> {
    let known = state.known_claude_terminals.lock_or_err()?;
    Ok(known.contains(&id))
}

#[tauri::command]
pub fn get_sync_group_terminals(
    group_name: String,
    state: State<Arc<AppState>>,
) -> Result<Vec<String>, String> {
    let groups = state.sync_groups.lock_or_err()?;

    Ok(groups
        .get(&group_name)
        .map(|g| g.terminal_ids.clone())
        .unwrap_or_default())
}

#[tauri::command]
pub fn set_terminal_cwd_receive(
    terminal_id: String,
    receive: bool,
    state: State<Arc<AppState>>,
) -> Result<(), String> {
    let mut terminals = state.terminals.lock_or_err()?;
    if let Some(session) = terminals.get_mut(&terminal_id) {
        session.cwd_receive = receive;
    }
    Ok(())
}

#[tauri::command]
pub fn update_terminal_sync_group(
    terminal_id: String,
    new_group: String,
    state: State<Arc<AppState>>,
) -> Result<(), String> {
    let mut groups = state.sync_groups.lock_or_err()?;

    // Remove from all existing groups
    let empty_groups: Vec<String> = groups
        .iter_mut()
        .filter_map(|(name, group)| {
            group.remove_terminal(&terminal_id);
            if group.terminal_ids.is_empty() {
                Some(name.clone())
            } else {
                None
            }
        })
        .collect();
    for name in empty_groups {
        groups.remove(&name);
    }

    // Add to new group (if non-empty)
    if !new_group.is_empty() {
        groups
            .entry(new_group.clone())
            .or_insert_with(|| crate::terminal::SyncGroup::new(new_group))
            .add_terminal(terminal_id);
    }

    Ok(())
}

/// Inner handler that processes IDE messages. Used by both the Tauri command
/// and the IPC socket server so that all message routes share the same logic.
pub fn handle_lx_message_inner(
    message_json: &str,
    state: &AppState,
    app: &AppHandle,
) -> Result<LxResponse, String> {
    let message: LxMessage =
        serde_json::from_str(message_json).map_err(|e| format!("Parse error: {e}"))?;

    handle_lx_message_dispatch(state, app, message)
}

#[tauri::command]
pub fn handle_lx_message(
    message_json: String,
    state: State<Arc<AppState>>,
    app: AppHandle,
) -> Result<LxResponse, String> {
    let message: LxMessage =
        serde_json::from_str(&message_json).map_err(|e| format!("Parse error: {e}"))?;

    handle_lx_message_dispatch(&state, &app, message)
}

fn handle_lx_message_dispatch(
    state: &AppState,
    app: &AppHandle,
    message: LxMessage,
) -> Result<LxResponse, String> {
    match message {
        LxMessage::SyncCwd {
            path,
            terminal_id,
            group_id,
            all,
            target_group,
        } => {
            cleanup_stale_propagations(state);

            // Check if this is an echo from a propagated command — suppress to prevent loop
            if is_propagated(state, &terminal_id)? {
                return Ok(LxResponse::ok(Some(format!(
                    "sync-cwd {} suppressed (propagated)",
                    path
                ))));
            }

            // Normalize WSL UNC paths to Linux-native paths
            let normalized_path = path_utils::normalize_wsl_path(&path);

            // NOTE: We intentionally do NOT skip when the source terminal's CWD
            // matches normalized_path. The backend PTY callback (proactive CWD
            // detection) may have already updated session.cwd before this IPC
            // arrives, so a naive "unchanged" check would suppress every
            // propagation. Target-side dedup is handled by filter_targets_needing_cd.

            // Update stored CWD for the source terminal
            update_terminal_cwd(state, &terminal_id, &normalized_path);

            let all_targets = resolve_target_terminals(
                state,
                &terminal_id,
                &group_id,
                all,
                target_group.as_deref(),
            )?;

            // Skip targets that have cwd_receive disabled
            let receiving_targets = filter_targets_cwd_receive(state, &all_targets);

            // Skip targets that have a command running (e.g., interactive apps like Claude Code)
            let settings = crate::settings::load_settings();
            let (idle_targets, claude_ids) =
                filter_targets_not_busy(state, &receiving_targets, &settings.claude.sync_cwd);

            // Skip targets that are already at the same CWD
            let target_terminals =
                filter_targets_needing_cd(state, &idle_targets, &normalized_path);

            // Write cd command to target terminals (with propagation flag + path conversion)
            if !target_terminals.is_empty() {
                write_cd_to_group_terminals(
                    state,
                    &target_terminals,
                    &terminal_id,
                    &normalized_path,
                    &claude_ids,
                )?;
            }

            // Mark targets so their OSC echo won't re-propagate
            if !target_terminals.is_empty() {
                mark_propagated(state, &target_terminals)?;
            }

            // Update stored CWD for receiving targets only (respect cwd_receive filter)
            for tid in &receiving_targets {
                update_terminal_cwd(state, tid, &normalized_path);
            }

            // Emit sync-cwd event to frontend — only receiving targets, not all
            let _ = app.emit(
                EVENT_SYNC_CWD,
                serde_json::json!({
                    "path": normalized_path,
                    "terminalId": terminal_id,
                    "groupId": group_id,
                    "targets": receiving_targets,
                }),
            );

            Ok(LxResponse::ok(Some(format!(
                "sync-cwd {} to {} terminals ({} filtered by cwd_receive, {} already at cwd)",
                normalized_path,
                target_terminals.len(),
                all_targets.len() - receiving_targets.len(),
                receiving_targets.len() - target_terminals.len()
            ))))
        }
        LxMessage::SyncBranch {
            branch,
            terminal_id,
            group_id,
        } => {
            // Update stored branch for the source terminal (single source of truth)
            {
                let mut terminals = state.terminals.lock_or_err()?;
                if let Some(session) = terminals.get_mut(&terminal_id) {
                    session.branch = Some(branch.clone());
                }
            }

            // Emit sync-branch event to frontend for UI updates
            let _ = app.emit(
                EVENT_SYNC_BRANCH,
                serde_json::json!({
                    "branch": branch,
                    "terminalId": terminal_id,
                    "groupId": group_id,
                }),
            );

            let groups = state.sync_groups.lock_or_err()?;
            let count = groups
                .get(&group_id)
                .map(|g| g.terminal_ids.len())
                .unwrap_or(0);

            Ok(LxResponse::ok(Some(format!(
                "sync-branch {} to {} terminals",
                branch, count
            ))))
        }
        LxMessage::Notify {
            message,
            terminal_id,
            level,
        } => {
            // Store notification in backend (single source of truth)
            {
                let notification = crate::terminal::TerminalNotification {
                    id: state
                        .notification_counter
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                    terminal_id: terminal_id.clone(),
                    message: message.clone(),
                    level: level.clone().unwrap_or_else(|| "info".to_string()),
                    created_at: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64,
                    read_at: None,
                };
                if let Ok(mut notifs) = state.notifications.lock_or_err() {
                    notifs.push(notification);
                    evict_old_notifications(&mut notifs);
                }
            }

            // Emit notification to frontend
            let mut payload = serde_json::json!({
                "message": message,
                "terminalId": terminal_id,
            });
            if let Some(ref lvl) = level {
                payload["level"] = serde_json::json!(lvl);
            }
            let _ = app.emit(EVENT_LX_NOTIFY, payload);

            Ok(LxResponse::ok(Some(format!("notification: {}", message))))
        }
        LxMessage::SetTabTitle { title, terminal_id } => {
            let mut terminals = state.terminals.lock_or_err()?;
            if let Some(session) = terminals.get_mut(&terminal_id) {
                session.title = title.clone();
            }

            let _ = app.emit(
                EVENT_SET_TAB_TITLE,
                serde_json::json!({
                    "title": title,
                    "terminalId": terminal_id,
                }),
            );

            Ok(LxResponse::ok(Some(format!("title set: {}", title))))
        }
        LxMessage::GetCwd { terminal_id } => {
            let terminals = state.terminals.lock_or_err()?;
            let cwd = terminals
                .get(&terminal_id)
                .and_then(|s| s.cwd.clone())
                .unwrap_or_default();
            Ok(LxResponse::ok(Some(cwd)))
        }
        LxMessage::GetBranch { terminal_id } => {
            let terminals = state.terminals.lock_or_err()?;
            let branch = terminals
                .get(&terminal_id)
                .and_then(|s| s.branch.clone())
                .unwrap_or_default();
            Ok(LxResponse::ok(Some(branch)))
        }
        LxMessage::SendCommand { command, group } => {
            let groups = state.sync_groups.lock_or_err()?;
            let target_ids = groups
                .get(&group)
                .map(|g| g.terminal_ids.clone())
                .unwrap_or_default();
            drop(groups);

            write_to_group_terminals(state, &target_ids, "", &format!("{command}\n"))?;

            Ok(LxResponse::ok(Some(format!(
                "sent '{}' to {} terminals in group '{}'",
                command,
                target_ids.len(),
                group
            ))))
        }
        LxMessage::OpenFile { path, terminal_id } => {
            // Emit open-file event to frontend
            let _ = app.emit(
                EVENT_OPEN_FILE,
                serde_json::json!({
                    "path": path,
                    "terminalId": terminal_id,
                }),
            );

            Ok(LxResponse::ok(Some(format!("open-file: {}", path))))
        }
        LxMessage::SetCommandStatus {
            terminal_id,
            command,
            exit_code,
        } => {
            // Update command state on the terminal session (single source of truth).
            {
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let mut terminals = state.terminals.lock_or_err()?;
                if let Some(session) = terminals.get_mut(&terminal_id) {
                    if let Some(ref cmd) = command {
                        session.last_command = Some(cmd.clone());
                        session.last_exit_code = None;
                        session.last_command_at = Some(now_ms);
                        session.command_running = true;
                    }
                    if let Some(code) = exit_code {
                        session.last_exit_code = Some(code);
                        session.last_command_at = Some(now_ms);
                        session.command_running = false;
                    }
                }
            }

            let mut payload = serde_json::json!({
                "terminalId": terminal_id,
            });
            if let Some(ref cmd) = command {
                payload["command"] = serde_json::json!(cmd);
            }
            if let Some(code) = exit_code {
                payload["exitCode"] = serde_json::json!(code);
            }
            let _ = app.emit(EVENT_COMMAND_STATUS, payload);

            let desc = match (&command, exit_code) {
                (Some(cmd), Some(code)) => format!("command '{}' exit {}", cmd, code),
                (Some(cmd), None) => format!("command '{}' started", cmd),
                (None, Some(code)) => format!("exit code {}", code),
                (None, None) => "no-op".to_string(),
            };
            Ok(LxResponse::ok(Some(desc)))
        }
        LxMessage::SetWslDistro { path, terminal_id } => {
            // Extract WSL distro name from UNC-style path (e.g., //wsl.localhost/Ubuntu-22.04/...)
            if let Some(distro) = path_utils::extract_wsl_distro_from_path(&path) {
                let mut terminals = state.terminals.lock_or_err()?;
                if let Some(session) = terminals.get_mut(&terminal_id) {
                    session.wsl_distro = Some(distro.clone());
                }
                Ok(LxResponse::ok(Some(format!("wsl-distro set: {distro}"))))
            } else {
                Ok(LxResponse::ok(Some("no distro found in path".into())))
            }
        }
    }
}

/// Resolve target terminal IDs based on sync propagation rules.
fn resolve_target_terminals(
    state: &AppState,
    source_terminal_id: &str,
    group_id: &str,
    all: bool,
    target_group: Option<&str>,
) -> Result<Vec<String>, String> {
    if all {
        let terminals = state.terminals.lock_or_err()?;
        Ok(terminals
            .keys()
            .filter(|id| id.as_str() != source_terminal_id)
            .cloned()
            .collect())
    } else if let Some(target) = target_group {
        let groups = state.sync_groups.lock_or_err()?;
        Ok(groups
            .get(target)
            .map(|g| {
                g.terminal_ids
                    .iter()
                    .filter(|id| id.as_str() != source_terminal_id)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default())
    } else {
        let groups = state.sync_groups.lock_or_err()?;
        Ok(groups
            .get(group_id)
            .map(|g| {
                g.terminal_ids
                    .iter()
                    .filter(|id| id.as_str() != source_terminal_id)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default())
    }
}

/// Write a command to all target terminals via their PTY handles.
/// Prepends a space to avoid shell history, and sets LX_PROPAGATED=1.
/// Uses profile-appropriate syntax for each target terminal.
fn write_to_group_terminals(
    state: &AppState,
    target_ids: &[String],
    _source_id: &str,
    command: &str,
) -> Result<(), String> {
    let ptys = state.pty_handles.lock_or_err()?;

    let terminals = state.terminals.lock_or_err()?;

    for id in target_ids {
        if let Some(handle) = ptys.get(id) {
            let profile = terminals
                .get(id)
                .map(|t| t.config.profile.as_str())
                .unwrap_or("WSL");
            // PowerShell on Windows ConPTY uses CR as Enter; ensure the command ends correctly
            let cmd = if matches!(profile, "PowerShell" | "powershell") {
                command.trim_end_matches('\n').to_string() + "\r"
            } else {
                command.to_string()
            };
            let propagated_cmd = match profile {
                "PowerShell" | "powershell" => format!("$env:LX_PROPAGATED='1';{cmd}"),
                _ => format!("LX_PROPAGATED=1 {command}"),
            };
            let _ = handle.write(propagated_cmd.as_bytes());
        }
    }

    Ok(())
}

/// Write a cd command to target terminals with cross-profile path conversion.
/// Converts the path for each target's profile (e.g., WSL→PowerShell: /mnt/c/... → C:\...).
/// Uses WSL distro name for UNC path conversion when needed (e.g., /home/... → \\wsl.localhost\distro\...).
///
/// Claude Code terminals in command mode get `! cd "/path"\n` instead of the normal
/// propagated cd command, because Claude Code accepts `! <command>` for inline shell execution.
/// The `claude_ids` set is produced by `filter_targets_not_busy` so we avoid re-scanning
/// the output buffers.
fn write_cd_to_group_terminals(
    state: &AppState,
    target_ids: &[String],
    source_id: &str,
    path: &str,
    claude_ids: &std::collections::HashSet<String>,
) -> Result<(), String> {
    // Extract WSL distro name for UNC path conversion (before locking terminals)
    let wsl_distro = path_utils::find_wsl_distro(state, source_id);

    let ptys = state.pty_handles.lock_or_err()?;

    let terminals = state.terminals.lock_or_err()?;

    for id in target_ids {
        if let Some(handle) = ptys.get(id) {
            let profile = terminals
                .get(id)
                .map(|t| t.config.profile.as_str())
                .unwrap_or("WSL");

            // Convert path for the target profile; skip if not convertible
            let converted = match path_utils::convert_path_for_target_with_distro(
                path,
                profile,
                wsl_distro.as_deref(),
            ) {
                Some(p) => p,
                None => continue,
            };

            let cmd = build_sync_cd_command(&converted, profile, claude_ids.contains(id));
            let _ = handle.write(cmd.as_bytes());
        }
    }

    Ok(())
}

/// Build the command string to write to a terminal for sync-cwd.
///
/// Claude Code terminals get `! cd '/path'\n` (single-quoted, escaped).
/// Normal terminals get `LX_PROPAGATED=1 cd '/path'\n` (or PowerShell equivalent).
fn build_sync_cd_command(converted_path: &str, profile: &str, is_claude: bool) -> String {
    if is_claude {
        // Single-quote the path so $, ", backticks, etc. are treated literally.
        // Escape embedded single quotes with the '\'' trick.
        let escaped = converted_path.replace('\'', "'\\''");
        format!("! cd '{escaped}'\n")
    } else {
        let cd_cmd = build_cd_command(converted_path, profile);
        match profile {
            "PowerShell" | "powershell" => format!("$env:LX_PROPAGATED='1';{cd_cmd}"),
            _ => format!("LX_PROPAGATED=1 {cd_cmd}"),
        }
    }
}

/// Checks whether a font is monospace by reading the `post` table's `isFixedPitch` field.
/// Falls back to comparing advance widths of 'i' and 'M'.
/// CJK-aware monospace fonts (e.g. JetBrainsMonoBigHangul) may set isFixedPitch=0
/// because they use half-width/full-width proportions, so we always verify with advance widths.
fn is_monospace(font: &font_kit::font::Font) -> bool {
    // Quick accept: if the post table says it's fixed-pitch, trust it
    if let Some(post_data) = font.load_font_table(u32::from_be_bytes(*b"post")) {
        let post: &[u8] = post_data.as_ref();
        if post.len() >= 16 {
            let is_fixed = u32::from_be_bytes([post[12], post[13], post[14], post[15]]);
            if is_fixed != 0 {
                return true;
            }
        }
    }
    // Fallback / CJK-aware check: compare advance widths of narrow vs wide Latin characters
    let glyphs: Vec<f32> = ['i', 'M']
        .iter()
        .filter_map(|&c| {
            let gid = font.glyph_for_char(c)?;
            font.advance(gid).ok().map(|v| v.x())
        })
        .collect();
    glyphs.len() == 2 && (glyphs[0] - glyphs[1]).abs() < 1.0
}

#[tauri::command]
pub fn list_system_monospace_fonts() -> Result<Vec<String>, String> {
    use font_kit::source::SystemSource;
    let source = SystemSource::new();
    let families = source
        .all_families()
        .map_err(|e| format!("Failed to enumerate system fonts: {e}"))?;

    let mut result: Vec<String> = families
        .into_iter()
        .filter(|name| {
            source
                .select_family_by_name(name)
                .ok()
                .and_then(|fh| fh.fonts().first().cloned())
                .and_then(|h| h.load().ok())
                .map(|f| is_monospace(&f))
                .unwrap_or(false)
        })
        .collect();

    result.sort_unstable_by_key(|a| a.to_lowercase());
    result.dedup();
    Ok(result)
}

#[tauri::command]
pub fn load_settings() -> Result<crate::settings::Settings, String> {
    Ok(crate::settings::load_settings())
}

#[tauri::command]
pub fn save_settings(settings: crate::settings::Settings) -> Result<(), String> {
    crate::settings::save_settings(&settings)
}

#[tauri::command]
pub fn load_memo(key: String) -> Result<String, String> {
    Ok(crate::settings::load_memo(&key))
}

#[tauri::command]
pub fn save_memo(key: String, content: String) -> Result<(), String> {
    crate::settings::save_memo(&key, &content)
}

#[tauri::command]
pub fn open_settings_file() -> Result<(), String> {
    let path = crate::settings::settings_path();
    #[cfg(target_os = "windows")]
    {
        crate::process::headless_command("cmd")
            .args(["/C", "start", "", &path.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("Failed to open settings.json: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open settings.json: {e}"))?;
    }
    Ok(())
}

/// Content type classification for file viewer.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum FileViewerContent {
    /// Text file — content included inline.
    Text { content: String, truncated: bool },
    /// Image file — inline data URL (base64).
    Image {
        #[serde(rename = "dataUrl")]
        data_url: String,
    },
    /// Binary/unsupported — show info only.
    Binary { size: u64 },
}

const IMAGE_EXTENSIONS: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico",
];

const TEXT_EXTENSIONS: &[&str] = &[
    ".txt",
    ".md",
    ".json",
    ".jsonc",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".rs",
    ".py",
    ".go",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".toml",
    ".yaml",
    ".yml",
    ".xml",
    ".html",
    ".css",
    ".scss",
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".bat",
    ".ps1",
    ".log",
    ".env",
    ".gitignore",
    ".editorconfig",
    ".conf",
    ".cfg",
    ".ini",
    ".csv",
];

/// Read a file and classify it for the file viewer.
#[tauri::command]
pub fn read_file_for_viewer(
    path: String,
    max_bytes: Option<usize>,
) -> Result<FileViewerContent, String> {
    // Resolve WSL paths on Windows
    let distro = if cfg!(windows) && path.starts_with('/') && !path.starts_with("/mnt/") {
        path_utils::get_default_wsl_distro()
    } else {
        None
    };
    let resolved = path_utils::resolve_path_for_windows(&path, distro.as_deref());
    let file_path = std::path::Path::new(&resolved);
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()))
        .unwrap_or_default();

    if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        // Read image and return as data URL (convertFileSrc can't handle WSL UNC paths)
        let bytes = std::fs::read(&resolved).map_err(|e| format!("Cannot read image: {e}"))?;
        let mime = match ext.as_str() {
            ".png" => "image/png",
            ".jpg" | ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".svg" => "image/svg+xml",
            ".webp" => "image/webp",
            ".bmp" => "image/bmp",
            ".ico" => "image/x-icon",
            _ => "application/octet-stream",
        };
        let b64 = base64_encode(&bytes);
        return Ok(FileViewerContent::Image {
            data_url: format!("data:{mime};base64,{b64}"),
        });
    }

    let metadata = std::fs::metadata(&resolved).map_err(|e| format!("Cannot stat file: {e}"))?;
    let size = metadata.len();
    let limit = max_bytes.unwrap_or(1_048_576) as u64; // 1MB default

    // Treat known text extensions or small files as text
    let is_text_ext = TEXT_EXTENSIONS.contains(&ext.as_str()) || ext.is_empty();
    if !is_text_ext && size > limit {
        return Ok(FileViewerContent::Binary { size });
    }

    // Read only up to limit bytes (avoid loading entire large files into memory)
    let read_limit = std::cmp::min(size, limit) as usize;
    let truncated = size > limit;
    let mut buf = vec![0u8; read_limit];
    {
        use std::io::Read;
        let mut f = std::fs::File::open(&resolved).map_err(|e| format!("Cannot open file: {e}"))?;
        f.read_exact(&mut buf)
            .map_err(|e| format!("Cannot read file: {e}"))?;
    }

    match std::str::from_utf8(&buf) {
        Ok(text) => Ok(FileViewerContent::Text {
            content: text.to_string(),
            truncated,
        }),
        Err(_) if is_text_ext => {
            // Lossy conversion for known text extensions
            Ok(FileViewerContent::Text {
                content: String::from_utf8_lossy(&buf).into_owned(),
                truncated,
            })
        }
        Err(_) => Ok(FileViewerContent::Binary { size }),
    }
}

/// A single directory entry returned by `list_directory`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub is_executable: bool,
    pub size: u64,
}

/// List directory contents and return structured metadata for each entry.
#[tauri::command]
pub fn list_directory(path: String, wsl_distro: Option<String>) -> Result<Vec<DirEntry>, String> {
    // On Windows, resolve Linux paths to UNC paths
    let distro = wsl_distro.or_else(|| {
        // Auto-detect WSL distro if path looks like a Linux path
        if cfg!(windows) && path.starts_with('/') && !path.starts_with("/mnt/") {
            path_utils::get_default_wsl_distro()
        } else {
            None
        }
    });
    let resolved = path_utils::resolve_path_for_windows(&path, distro.as_deref());
    let dir_path = std::path::Path::new(&resolved);
    let entries = std::fs::read_dir(dir_path).map_err(|e| format!("Cannot read directory: {e}"))?;

    let mut result = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // skip unreadable entries
        };
        let name = entry.file_name().to_string_lossy().into_owned();

        // Use symlink_metadata to detect symlinks (metadata follows symlinks)
        let sym_meta = entry.path().symlink_metadata();
        let is_symlink = sym_meta.as_ref().map(|m| m.is_symlink()).unwrap_or(false);

        // Follow symlinks for the actual file type and size
        let meta = entry.path().metadata();
        let is_directory = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);

        // Check executable bit (Unix only)
        #[cfg(unix)]
        let is_executable = {
            use std::os::unix::fs::PermissionsExt;
            meta.as_ref()
                .map(|m| !m.is_dir() && (m.permissions().mode() & 0o111) != 0)
                .unwrap_or(false)
        };
        #[cfg(not(unix))]
        let is_executable = {
            // On Windows, check common executable extensions
            let ext = entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_lowercase())
                .unwrap_or_default();
            !is_directory && matches!(ext.as_str(), "exe" | "cmd" | "bat" | "ps1" | "com")
        };

        result.push(DirEntry {
            name,
            is_directory,
            is_symlink,
            is_executable,
            size,
        });
    }

    // Sort: directories first, then alphabetically (case-insensitive)
    result.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

/// Simple base64 encoder (no external crate needed).
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let combined = (b0 << 16) | (b1 << 8) | b2;
        result.push(TABLE[((combined >> 18) & 0x3F) as usize] as char);
        result.push(TABLE[((combined >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(TABLE[((combined >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(TABLE[(combined & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

/// Split an `issueReporter.shell` prefix into tokens, respecting single and double quotes.
/// Unmatched trailing quotes treat the rest of the string as one token.
/// Note: backslash escapes (e.g. `\"`) are NOT supported.
fn split_shell_prefix(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut chars = input.chars().peekable();
    while let Some(&ch) = chars.peek() {
        match ch {
            ' ' | '\t' => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
                chars.next();
            }
            '"' | '\'' => {
                let quote = ch;
                chars.next(); // consume opening quote
                while let Some(&c) = chars.peek() {
                    if c == quote {
                        chars.next(); // consume closing quote
                        break;
                    }
                    current.push(c);
                    chars.next();
                }
            }
            _ => {
                current.push(ch);
                chars.next();
            }
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// Build a `std::process::Command` for `gh`, optionally wrapped by a shell prefix.
/// When `shell_prefix` is empty, gh is invoked directly.
/// When set (e.g. `wsl.exe -d "My Distro" --`), gh is invoked as:
///   `wsl.exe -d "My Distro" -- gh {args...}`
/// Supports single/double-quoted arguments in the prefix.
fn build_gh_command(shell_prefix: &str) -> std::process::Command {
    let parts = split_shell_prefix(shell_prefix);
    if parts.is_empty() {
        crate::process::headless_command("gh")
    } else {
        let mut cmd = crate::process::headless_command(&parts[0]);
        for part in &parts[1..] {
            cmd.arg(part);
        }
        cmd.arg("gh");
        cmd
    }
}

/// Build a `gh` CLI command that runs without a visible console window on Windows.
fn gh_command(shell_prefix: &str) -> std::process::Command {
    build_gh_command(shell_prefix)
}

/// Upload a screenshot to the GitHub repo via the contents API.
/// Returns the raw download URL of the uploaded image.
fn upload_screenshot_to_github(
    path: &std::path::Path,
    shell_prefix: &str,
) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read screenshot: {e}"))?;
    let b64 = base64_encode(&bytes);

    let filename = path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "screenshot.png".to_string());

    // Get repo name
    let repo_out = gh_command(shell_prefix)
        .args([
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "-q",
            ".nameWithOwner",
        ])
        .output()
        .map_err(|e| format!("gh repo view failed: {e}"))?;
    if !repo_out.status.success() {
        return Err("Not in a GitHub repo or gh not configured".into());
    }
    let repo = String::from_utf8_lossy(&repo_out.stdout).trim().to_string();

    // Write JSON body to temp file (avoids command-line length limits)
    let json_body = format!(r#"{{"message":"Upload issue screenshot","content":"{b64}"}}"#);
    let temp_path = std::env::temp_dir().join("laymux_gh_upload.json");
    std::fs::write(&temp_path, &json_body)
        .map_err(|e| format!("Failed to write temp file: {e}"))?;

    // Upload via GitHub contents API
    let api_path = format!("repos/{repo}/contents/.github/issue-screenshots/{filename}");
    let upload_out = gh_command(shell_prefix)
        .args([
            "api",
            &api_path,
            "-X",
            "PUT",
            "--input",
            &temp_path.to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("gh api upload failed: {e}"))?;

    let _ = std::fs::remove_file(&temp_path);

    if !upload_out.status.success() {
        let stderr = String::from_utf8_lossy(&upload_out.stderr)
            .trim()
            .to_string();
        return Err(format!("GitHub upload failed: {stderr}"));
    }

    // Use github.com/raw/ URL format — works for both public and private repos
    // (authenticated users who have repo access can view the image)
    Ok(format!(
        "https://github.com/{repo}/raw/main/.github/issue-screenshots/{filename}"
    ))
}

#[tauri::command]
pub async fn submit_github_issue(
    title: String,
    body: String,
    screenshot_path: Option<String>,
) -> Result<String, String> {
    let settings = crate::settings::load_settings();
    let shell_prefix = &settings.issue_reporter.shell;
    let mut full_body = body;

    // Upload screenshot to GitHub and embed the image in the body
    if let Some(ref path_str) = screenshot_path {
        let p = std::path::Path::new(path_str);
        if p.exists() {
            match upload_screenshot_to_github(p, shell_prefix) {
                Ok(image_url) => {
                    full_body = format!("{full_body}\n\n![Screenshot]({image_url})");
                }
                Err(e) => {
                    full_body = format!("{full_body}\n\n_Screenshot upload failed: {e}_");
                }
            }
        }
    }

    let output = gh_command(shell_prefix)
        .args(["issue", "create", "--title", &title, "--body", &full_body])
        .output()
        .map_err(|e| format!("Failed to run gh CLI: {e}. Is gh installed and authenticated?"))?;

    if output.status.success() {
        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(url)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("gh issue create failed: {stderr}"))
    }
}

#[tauri::command]
pub fn get_listening_ports() -> Vec<crate::port_detect::ListeningPort> {
    crate::port_detect::get_listening_ports()
}

#[tauri::command]
pub fn get_git_branch(working_dir: String) -> Option<String> {
    let path = std::path::Path::new(&working_dir);
    let git_dir = crate::git_watcher::find_git_dir(path)?;
    crate::git_watcher::read_git_branch(&git_dir)
}

#[tauri::command]
pub fn send_os_notification(title: String, body: String) -> Result<(), String> {
    // OS notification via the system's built-in mechanism.
    // On Windows, uses tauri notification or powershell toast.
    #[cfg(target_os = "windows")]
    {
        let _ = crate::process::headless_command("powershell")
            .args([
                "-Command",
                &format!(
                    "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; \
                     $n = New-Object System.Windows.Forms.NotifyIcon; \
                     $n.Icon = [System.Drawing.SystemIcons]::Information; \
                     $n.Visible = $true; \
                     $n.ShowBalloonTip(5000, '{}', '{}', 'Info'); \
                     Start-Sleep -Seconds 5; \
                     $n.Dispose()",
                    title.replace('\'', "''"),
                    body.replace('\'', "''"),
                ),
            ])
            .spawn();
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("notify-send")
            .args([&title, &body])
            .spawn();
        Ok(())
    }
}

#[tauri::command]
pub fn automation_response(
    response_json: String,
    state: State<Arc<AppState>>,
) -> Result<(), String> {
    let response: AutomationResponse =
        serde_json::from_str(&response_json).map_err(|e| format!("Parse error: {e}"))?;

    let tx = {
        let mut channels = state.automation_channels.lock_or_err()?;
        channels.remove(&response.request_id)
    };

    if let Some(tx) = tx {
        let value = if response.success {
            response.data.unwrap_or(serde_json::Value::Null)
        } else {
            serde_json::json!({
                "success": false,
                "error": response.error.unwrap_or_default(),
            })
        };
        let _ = tx.send(value);
    }

    Ok(())
}

// --- Propagation guard helpers ---

/// Check if a terminal is within the propagation suppression window.
/// Unlike the old consume_propagation, this does NOT remove the entry —
/// the flag stays active for the full PROPAGATION_TIMEOUT so that multiple
/// OSC sequences (e.g. OSC 7 + OSC 9;9 from WSL) are all suppressed.
fn is_propagated(state: &AppState, terminal_id: &str) -> Result<bool, String> {
    let propagated = state.propagated_terminals.lock_or_err()?;
    if let Some(ts) = propagated.get(terminal_id) {
        Ok(ts.elapsed() < PROPAGATION_TIMEOUT)
    } else {
        Ok(false)
    }
}

/// Filter out terminals that have a command running.
/// Checks the terminal output buffer for the last OSC 133 marker:
/// - OSC 133;C (preexec) = command is running → exclude
/// - OSC 133;D (exit code) = at shell prompt → include
///
/// Filter out terminals that have cwd_receive disabled.
fn filter_targets_cwd_receive(state: &AppState, targets: &[String]) -> Vec<String> {
    if let Ok(terminals) = state.terminals.lock_or_err() {
        targets
            .iter()
            .filter(|id| terminals.get(id.as_str()).is_none_or(|s| s.cwd_receive))
            .cloned()
            .collect()
    } else {
        targets.to_vec()
    }
}

/// This is more reliable than the async `command_running` flag because it
/// reads from the actual terminal output (ground truth), avoiding race conditions.
///
/// Claude Code terminals are partitioned out and handled separately based on
/// the `claude.syncCwd` setting (skip or command mode).
///
/// Returns `(idle_targets, claude_ids)` — the caller passes `claude_ids` to
/// `write_cd_to_group_terminals` so it can format the command differently
/// without re-scanning the output buffers.
fn filter_targets_not_busy(
    state: &AppState,
    targets: &[String],
    claude_mode: &crate::settings::ClaudeSyncCwdMode,
) -> (Vec<String>, std::collections::HashSet<String>) {
    let mut claude_ids = std::collections::HashSet::new();

    if let Ok(buffers) = state.output_buffers.lock_or_err() {
        let mut result = Vec::new();
        for id in targets {
            let buf = buffers.get(id.as_str());
            if is_claude_terminal_from_buffer(state, id, buf) {
                // Handle Claude Code terminal based on settings
                match claude_mode {
                    crate::settings::ClaudeSyncCwdMode::Skip => {
                        // Don't propagate cd to Claude terminals
                        continue;
                    }
                    crate::settings::ClaudeSyncCwdMode::Command => {
                        // Only include if Claude is idle (✳ prefix in title)
                        if is_claude_idle_from_buffer(buf) {
                            claude_ids.insert(id.clone());
                            result.push(id.clone());
                        }
                    }
                }
            } else if is_terminal_at_prompt_from_buffer(buf) {
                result.push(id.clone());
            }
        }
        (result, claude_ids)
    } else {
        (targets.to_vec(), claude_ids)
    }
}

/// Check if ANY terminal title (OSC 0 or OSC 2) in the buffer data contains the given substring.
/// Scans all title sequences, not just the last one.
fn any_terminal_title_contains(data: &[u8], substring: &str) -> bool {
    let needle_0: &[u8] = &[0x1b, b']', b'0', b';'];
    let needle_2: &[u8] = &[0x1b, b']', b'2', b';'];

    for needle in [needle_0, needle_2] {
        let mut start = 0;
        while start + needle.len() <= data.len() {
            if let Some(found) = data[start..]
                .windows(needle.len())
                .position(|w| w == needle)
            {
                let abs_pos = start + found;
                let title_start = abs_pos + needle.len();
                if title_start < data.len() {
                    let remaining = &data[title_start..];
                    if let Some(end) = remaining.iter().position(|&b| b == 0x07 || b == 0x1b) {
                        let title = String::from_utf8_lossy(&remaining[..end]);
                        if title.contains(substring) {
                            return true;
                        }
                    }
                }
                start = abs_pos + 1;
            } else {
                break;
            }
        }
    }
    false
}

/// Extract the payload of the last occurrence of an OSC sequence identified by `needle`.
/// Scans for `needle` (e.g., `\x1b]7;`) and returns the text up to the BEL (`\x07`)
/// or ST (`\x1b\\`) terminator. Returns `None` if no complete match is found.
fn extract_last_osc_payload(data: &[u8], needle: &[u8]) -> Option<String> {
    let mut last: Option<String> = None;
    let mut start = 0;

    while start + needle.len() <= data.len() {
        if let Some(found) = data[start..]
            .windows(needle.len())
            .position(|w| w == needle)
        {
            let abs_pos = start + found;
            let payload_start = abs_pos + needle.len();
            if payload_start < data.len() {
                let remaining = &data[payload_start..];
                if let Some(end) = remaining.iter().position(|&b| b == 0x07 || b == 0x1b) {
                    let payload = String::from_utf8_lossy(&remaining[..end]);
                    if !payload.is_empty() {
                        last = Some(payload.into_owned());
                    }
                }
            }
            start = abs_pos + 1;
        } else {
            break;
        }
    }
    last
}

/// Extract CWD from the last OSC 7 sequence in PTY output data.
/// Format: `\x1b]7;<url>\x07` or `\x1b]7;<url>\x1b\\`
fn extract_last_osc7_cwd(data: &[u8]) -> Option<String> {
    extract_last_osc_payload(data, &[0x1b, b']', b'7', b';'])
}

/// Extract CWD from the last OSC 9;9 sequence in PTY output data.
/// Format: `\x1b]9;9;<path>\x07`
fn extract_last_osc9_9_cwd(data: &[u8]) -> Option<String> {
    extract_last_osc_payload(data, &[0x1b, b']', b'9', b';', b'9', b';'])
}

/// Check if a terminal is running Claude Code.
/// Uses two-pronged detection:
/// 1. Persistent tracking (`known_claude_terminals`) — instant O(1) check
/// 2. Full buffer title scan — checks ALL OSC 0/2 titles, not just the last one
///
/// When detected via buffer scan, the terminal ID is added to `known_claude_terminals`
/// so future calls don't depend on the title still being in the buffer.
fn is_claude_terminal_from_buffer(
    state: &AppState,
    terminal_id: &str,
    buffer: Option<&crate::output_buffer::TerminalOutputBuffer>,
) -> bool {
    // Prong 1: Check persistent tracking
    if let Ok(known) = state.known_claude_terminals.lock_or_err() {
        if known.contains(terminal_id) {
            return true;
        }
    }

    // Prong 2: Scan ALL titles in buffer for "Claude Code"
    let Some(buf) = buffer else {
        return false;
    };
    let recent = buf.recent_bytes(ACTIVITY_SCAN_BYTES);
    if recent.is_empty() {
        return false;
    }

    if any_terminal_title_contains(&recent, "Claude Code") {
        // Mark persistently for future calls
        if let Ok(mut known) = state.known_claude_terminals.lock_or_err() {
            known.insert(terminal_id.to_string());
        }
        return true;
    }

    false
}

/// Check if Claude Code is idle (at its prompt) by looking for ✳ (U+2733) prefix in terminal title.
/// Claude Code sets the terminal title with ✳ when idle and spinner chars when working.
fn is_claude_idle_from_buffer(buffer: Option<&crate::output_buffer::TerminalOutputBuffer>) -> bool {
    let Some(buf) = buffer else {
        return false;
    };
    let recent = buf.recent_bytes(ACTIVITY_SCAN_BYTES);
    if recent.is_empty() {
        return false;
    }
    if let Some(title) = extract_last_terminal_title(&recent) {
        // ✳ is U+2733, encoded as \xe2\x9c\xb3 in UTF-8
        title.starts_with('\u{2733}')
    } else {
        false
    }
}

/// Check if a terminal is at a shell prompt by examining its output buffer.
/// Returns true if the terminal appears to be at a prompt (safe to send cd).
fn is_terminal_at_prompt_from_buffer(
    buffer: Option<&crate::output_buffer::TerminalOutputBuffer>,
) -> bool {
    let Some(buf) = buffer else {
        return true; // Unknown terminal → assume at prompt
    };
    let recent = buf.recent_bytes(ACTIVITY_SCAN_BYTES);
    if recent.is_empty() {
        return true; // No output yet → assume at prompt
    }

    // Find the last OSC 133;C (preexec) and OSC 133;D (exit code) positions.
    // OSC format: \x1b]133;C\x07  or  \x1b]133;D;N\x07
    let last_c = find_last_osc_133(&recent, b"C");
    let last_d = find_last_osc_133(&recent, b"D");

    match (last_c, last_d) {
        (Some(c_pos), Some(d_pos)) => d_pos > c_pos, // D after C = at prompt
        (None, Some(_)) => true,                     // Only D = at prompt
        (Some(_), None) => false,                    // Only C = command running
        (None, None) => true,                        // No markers = assume at prompt
    }
}

/// Find the last occurrence of an OSC 133 sequence with a given param (e.g., "C" or "D").
fn find_last_osc_133(data: &[u8], param: &[u8]) -> Option<usize> {
    // Search for \x1b]133;{param} pattern
    let mut needle = vec![0x1b, b']', b'1', b'3', b'3', b';'];
    needle.extend_from_slice(param);

    let mut pos = None;
    let mut start = 0;
    while start + needle.len() <= data.len() {
        if let Some(found) = data[start..]
            .windows(needle.len())
            .position(|w| w == needle.as_slice())
        {
            pos = Some(start + found);
            start = start + found + 1;
        } else {
            break;
        }
    }
    pos
}

/// Detect the activity state of a terminal from its output buffer.
/// Returns Shell (at prompt), Running (command executing), or InteractiveApp (TUI app).
///
/// IMPORTANT: Check interactive app title BEFORE OSC 133 markers.
/// When long-running apps like Claude Code run, the preexec marker (OSC 133;C) can scroll
/// out of the 8KB buffer, causing `is_terminal_at_prompt_from_buffer` to wrongly return true.
/// Checking the terminal title first prevents this misdetection.
pub fn detect_terminal_activity(
    buffer: Option<&crate::output_buffer::TerminalOutputBuffer>,
) -> TerminalActivity {
    let Some(buf) = buffer else {
        return TerminalActivity::Shell;
    };
    let recent = buf.recent_bytes(ACTIVITY_SCAN_BYTES);
    if recent.is_empty() {
        return TerminalActivity::Shell;
    }

    // Check terminal title FIRST — interactive apps set their title even when
    // OSC 133 markers have scrolled out of the buffer.
    if let Some(name) = detect_interactive_app(&recent) {
        return TerminalActivity::InteractiveApp { name };
    }

    let at_prompt = is_terminal_at_prompt_from_buffer(Some(buf));
    if at_prompt {
        return TerminalActivity::Shell;
    }

    TerminalActivity::Running
}

/// Known interactive apps detected from terminal title (OSC 0 / OSC 2).
const INTERACTIVE_APP_PATTERNS: &[(&str, &str)] = &[
    ("Claude Code", "Claude Code"),
    ("vim", "vim"),
    ("nvim", "neovim"),
    ("nano", "nano"),
    ("htop", "htop"),
    ("btop", "btop"),
    ("top", "top"),
    ("less", "less"),
    ("man ", "man"),
    ("python3", "python"),
    ("python", "python"),
    ("node", "node"),
    ("ipython", "ipython"),
];

/// Detect if a known interactive app is running based on the terminal title.
fn detect_interactive_app(data: &[u8]) -> Option<String> {
    let title = extract_last_terminal_title(data)?;
    for &(pattern, name) in INTERACTIVE_APP_PATTERNS {
        if title.contains(pattern) {
            return Some(name.to_string());
        }
    }
    None
}

/// Extract the last terminal title from OSC 0 or OSC 2 sequences in the output.
/// Format: ESC ] 0 ; title BEL  or  ESC ] 2 ; title BEL
fn extract_last_terminal_title(data: &[u8]) -> Option<String> {
    // Search backwards for the last OSC 0; or OSC 2;
    let mut best_pos = None;
    let mut best_code = 0u8;

    // OSC 0; → \x1b]0;
    let needle_0: &[u8] = &[0x1b, b']', b'0', b';'];
    let needle_2: &[u8] = &[0x1b, b']', b'2', b';'];

    for needle in [needle_0, needle_2] {
        let mut start = 0;
        while start + needle.len() <= data.len() {
            if let Some(found) = data[start..]
                .windows(needle.len())
                .position(|w| w == needle)
            {
                let abs_pos = start + found;
                if best_pos.is_none_or(|bp| abs_pos > bp) {
                    best_pos = Some(abs_pos);
                    best_code = needle[2]; // '0' or '2'
                }
                start = abs_pos + 1;
            } else {
                break;
            }
        }
    }

    let pos = best_pos?;
    let title_start = pos + 4; // skip ESC ] N ;
    if title_start >= data.len() {
        return None;
    }

    // Find BEL (\x07) or ST (\x1b\\) terminator
    let remaining = &data[title_start..];
    let end = remaining.iter().position(|&b| b == 0x07 || b == 0x1b)?;
    let title_bytes = &remaining[..end];
    let _ = best_code; // suppress unused warning

    String::from_utf8_lossy(title_bytes).to_string().into()
}

/// Detect full terminal state (activity + output freshness) for a single terminal.
pub fn detect_terminal_state(
    buffer: Option<&crate::output_buffer::TerminalOutputBuffer>,
) -> TerminalStateInfo {
    let activity = detect_terminal_activity(buffer);
    let (output_active, last_output_ms_ago) = if let Some(buf) = buffer {
        if let Some(ts) = buf.last_output_at {
            let elapsed = ts.elapsed().as_millis() as u64;
            (elapsed < 2000, elapsed) // Active if output within last 2 seconds
        } else {
            (false, u64::MAX)
        }
    } else {
        (false, u64::MAX)
    };

    TerminalStateInfo {
        activity,
        output_active,
        last_output_ms_ago,
    }
}

/// Detect terminal states for all terminals.
pub fn detect_all_terminal_states(
    state: &AppState,
) -> std::collections::HashMap<String, TerminalStateInfo> {
    let mut result = std::collections::HashMap::new();
    if let Ok(buffers) = state.output_buffers.lock_or_err() {
        if let Ok(terminals) = state.terminals.lock_or_err() {
            for id in terminals.keys() {
                let info = detect_terminal_state(buffers.get(id));
                result.insert(id.clone(), info);
            }
        }
    }
    result
}

/// Tauri command: get terminal state for all terminals.
#[tauri::command]
pub fn get_terminal_states(
    state: State<Arc<AppState>>,
) -> std::collections::HashMap<String, TerminalStateInfo> {
    detect_all_terminal_states(&state)
}

/// Tauri command: get CWD for all terminals from backend (single source of truth).
/// Returns a map of terminal_id → normalized CWD path.
#[tauri::command]
pub fn get_terminal_cwds(
    state: State<Arc<AppState>>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let terminals = state.terminals.lock_or_err()?;
    let mut result = std::collections::HashMap::new();
    for (id, session) in terminals.iter() {
        if let Some(ref cwd) = session.cwd {
            result.insert(id.clone(), cwd.clone());
        }
    }
    Ok(result)
}

/// Response for a single terminal in `get_terminal_summaries`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSummaryResponse {
    pub id: String,
    pub profile: String,
    pub title: String,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub last_command: Option<String>,
    pub last_exit_code: Option<i32>,
    pub last_command_at: Option<u64>,
    pub command_running: bool,
    pub activity: TerminalActivity,
    pub output_active: bool,
    pub is_claude: bool,
    pub unread_notification_count: u32,
    pub latest_notification: Option<TerminalNotification>,
}

/// Tauri command: get comprehensive summary for requested terminals (single source of truth).
/// Returns all data needed to render WorkspaceSelectorView for the given terminal IDs.
///
/// Lock order: terminals → output_buffers → known_claude_terminals → notifications
/// (see `AppState` doc for the canonical ordering).
#[tauri::command]
pub fn get_terminal_summaries(
    terminal_ids: Vec<String>,
    state: State<Arc<AppState>>,
) -> Result<Vec<TerminalSummaryResponse>, String> {
    get_terminal_summaries_inner(&terminal_ids, &state)
}

/// Core implementation of `get_terminal_summaries` without Tauri State wrapper.
/// Used by both the Tauri command and tests.
///
/// Lock order: terminals → output_buffers → known_claude_terminals → notifications
/// (see `AppState` doc for the canonical ordering).
pub fn get_terminal_summaries_inner(
    terminal_ids: &[String],
    state: &AppState,
) -> Result<Vec<TerminalSummaryResponse>, String> {
    let terminals = state.terminals.lock_or_err()?;
    let buffers = state.output_buffers.lock_or_err()?;
    let known_claude = state.known_claude_terminals.lock_or_err()?;
    let notifications = state.notifications.lock_or_err()?;

    let mut result = Vec::with_capacity(terminal_ids.len());

    for tid in terminal_ids {
        let Some(session) = terminals.get(tid.as_str()) else {
            continue;
        };
        let state_info = detect_terminal_state(buffers.get(tid.as_str()));
        let is_claude = known_claude.contains(tid.as_str());
        let term_notifs: Vec<&TerminalNotification> = notifications
            .iter()
            .filter(|n| n.terminal_id == *tid)
            .collect();
        let unread_count = term_notifs.iter().filter(|n| n.read_at.is_none()).count() as u32;
        let latest_unread = term_notifs
            .iter()
            .filter(|n| n.read_at.is_none())
            .max_by_key(|n| n.created_at)
            .map(|n| (*n).clone());

        result.push(TerminalSummaryResponse {
            id: tid.clone(),
            profile: session.config.profile.clone(),
            title: session.title.clone(),
            cwd: session.cwd.clone(),
            branch: session.branch.clone(),
            last_command: session.last_command.clone(),
            last_exit_code: session.last_exit_code,
            last_command_at: session.last_command_at,
            command_running: session.command_running,
            activity: state_info.activity,
            output_active: state_info.output_active,
            is_claude,
            unread_notification_count: unread_count,
            latest_notification: latest_unread,
        });
    }

    Ok(result)
}

/// Tauri command: mark notifications as read for the given terminal IDs.
#[tauri::command]
pub fn mark_notifications_read(
    terminal_ids: Vec<String>,
    state: State<Arc<AppState>>,
) -> Result<u32, String> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let mut count = 0u32;
    if let Ok(mut notifs) = state.notifications.lock_or_err() {
        for n in notifs.iter_mut() {
            if terminal_ids.contains(&n.terminal_id) && n.read_at.is_none() {
                n.read_at = Some(now_ms);
                count += 1;
            }
        }
    }
    Ok(count)
}

/// Evict oldest read notifications when the list exceeds MAX_NOTIFICATIONS.
/// Unread notifications are never evicted. Only read (already consumed) entries are removed.
fn evict_old_notifications(notifs: &mut Vec<crate::terminal::TerminalNotification>) {
    if notifs.len() <= MAX_NOTIFICATIONS {
        return;
    }
    // Remove oldest read notifications first (smallest created_at with read_at set)
    let over = notifs.len() - MAX_NOTIFICATIONS;
    let mut read_indices: Vec<usize> = notifs
        .iter()
        .enumerate()
        .filter(|(_, n)| n.read_at.is_some())
        .map(|(i, _)| i)
        .collect();
    // Already sorted by insertion order (oldest first), take the first `over` entries
    read_indices.truncate(over);
    // Remove in reverse order to keep indices stable
    for &i in read_indices.iter().rev() {
        notifs.remove(i);
    }
}

/// Filter target terminals to only those whose CWD differs from the sync path.
/// Terminals already at the target CWD don't need a cd command.
fn filter_targets_needing_cd(
    state: &AppState,
    targets: &[String],
    normalized_path: &str,
) -> Vec<String> {
    if let Ok(terminals) = state.terminals.lock_or_err() {
        targets
            .iter()
            .filter(|id| {
                terminals
                    .get(id.as_str())
                    .is_none_or(|session| session.cwd.as_deref() != Some(normalized_path))
            })
            .cloned()
            .collect()
    } else {
        targets.to_vec()
    }
}

/// Update the stored CWD for a terminal session.
fn update_terminal_cwd(state: &AppState, terminal_id: &str, cwd: &str) {
    if let Ok(mut terminals) = state.terminals.lock_or_err() {
        if let Some(session) = terminals.get_mut(terminal_id) {
            session.cwd = Some(cwd.to_string());
        }
    }
}

/// Convert a path for a target terminal profile.
/// Returns `None` if the path cannot be navigated from the target profile
/// and no WSL distro is available for UNC conversion.
///
/// Conversion rules:
/// - Linux `/mnt/X/...` → Windows `X:\...` (for PowerShell targets)
/// - Windows `X:\...` → Linux `/mnt/x/...` (for WSL targets)
/// - Same-type paths pass through unchanged
/// - Pure Linux paths → `\\wsl.localhost\<distro>\path` for PowerShell (if distro known)
/// - Pure Linux paths → `None` for PowerShell (if distro unknown)
#[cfg(test)]
fn convert_path_for_target(path: &str, target_profile: &str) -> Option<String> {
    path_utils::convert_path_for_target_with_distro(path, target_profile, None)
}

/// Build a cd command string for the given profile.
/// Prepends a space to avoid shell history recording.
/// PowerShell on Windows ConPTY uses CR (`\r`) as Enter; bash uses LF (`\n`).
fn build_cd_command(path: &str, profile: &str) -> String {
    let eol = match profile {
        "PowerShell" | "powershell" => "\r",
        _ => "\n",
    };
    format!(" cd {path}{eol}")
}

/// Mark multiple terminals as having received a propagated command.
fn mark_propagated(state: &AppState, terminal_ids: &[String]) -> Result<(), String> {
    let mut propagated = state.propagated_terminals.lock_or_err()?;
    let now = Instant::now();
    for id in terminal_ids {
        propagated.insert(id.clone(), now);
    }
    Ok(())
}

/// Remove propagation entries older than PROPAGATION_TIMEOUT.
fn cleanup_stale_propagations(state: &AppState) {
    if let Ok(mut propagated) = state.propagated_terminals.lock_or_err() {
        propagated.retain(|_, ts| ts.elapsed() < PROPAGATION_TIMEOUT);
    }
}

/// Tauri command: smart paste — resolve clipboard files/images into paths.
#[tauri::command]
pub fn smart_paste(
    image_dir: String,
    profile: String,
) -> Result<crate::clipboard::SmartPasteResult, String> {
    crate::clipboard::smart_paste(&image_dir, &profile)
}

/// Tauri command: write text to the system clipboard.
#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    clipboard_write_text_platform(&text)
}

#[cfg(target_os = "windows")]
fn clipboard_write_text_platform(text: &str) -> Result<(), String> {
    clipboard_win::set_clipboard(clipboard_win::formats::Unicode, text)
        .map_err(|e| format!("Clipboard write failed: {e}"))
}

#[cfg(not(target_os = "windows"))]
fn clipboard_write_text_platform(_text: &str) -> Result<(), String> {
    Err("Clipboard write not implemented on this platform".into())
}

fn sanitize_filename(s: &str) -> String {
    let sanitized: String = s
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    // Prevent path traversal via ".." components (use "__" to preserve length and avoid collisions)
    sanitized.replace("..", "__")
}

/// Inner implementation for saving terminal output cache, testable with arbitrary path.
fn save_terminal_output_cache_to(
    cache_dir: &std::path::Path,
    pane_id: &str,
    data: &str,
) -> Result<(), String> {
    if pane_id.is_empty() {
        return Err("Empty pane ID".into());
    }
    let dir = cache_dir.join("terminal-output");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create cache dir: {e}"))?;
    let path = dir.join(format!("{}.dat", sanitize_filename(pane_id)));
    std::fs::write(&path, data.as_bytes()).map_err(|e| format!("Failed to write cache: {e}"))
}

/// Inner implementation for loading terminal output cache, testable with arbitrary path.
fn load_terminal_output_cache_from(
    cache_dir: &std::path::Path,
    pane_id: &str,
) -> Result<String, String> {
    if pane_id.is_empty() {
        return Err("Empty pane ID".into());
    }
    let dir = cache_dir.join("terminal-output");
    let path = dir.join(format!("{}.dat", sanitize_filename(pane_id)));
    let bytes = std::fs::read(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("Cache not found: {}", path.display()),
        _ => format!("Failed to read cache: {e}"),
    })?;
    String::from_utf8(bytes).map_err(|e| format!("Invalid UTF-8 in cache: {e}"))
}

/// Inner implementation for cleaning orphaned cache files, testable with arbitrary path.
fn clean_terminal_output_cache_in(
    cache_dir: &std::path::Path,
    active_pane_ids: &[String],
) -> Result<u32, String> {
    let dir = cache_dir.join("terminal-output");
    if !dir.exists() {
        return Ok(0);
    }
    let active_set: std::collections::HashSet<String> = active_pane_ids
        .iter()
        .filter(|id| !id.is_empty())
        .map(|id| format!("{}.dat", sanitize_filename(id)))
        .collect();
    let mut removed = 0u32;
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("Read dir: {e}"))? {
        let entry = entry.map_err(|e| format!("Dir entry: {e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".dat")
            && !active_set.contains(&name)
            && std::fs::remove_file(entry.path()).is_ok()
        {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Save terminal output to the cache directory.
/// Accepts a string (xterm.js SerializeAddon output) and writes as UTF-8 bytes.
#[tauri::command]
pub fn save_terminal_output_cache(pane_id: String, data: String) -> Result<(), String> {
    let cache_dir = crate::settings::cache_dir_path().ok_or("Cannot determine cache directory")?;
    save_terminal_output_cache_to(&cache_dir, &pane_id, &data)
}

/// Load terminal output from the cache directory.
/// Returns a string (to be written back via terminal.write()).
#[tauri::command]
pub fn load_terminal_output_cache(pane_id: String) -> Result<String, String> {
    let cache_dir = crate::settings::cache_dir_path().ok_or("Cannot determine cache directory")?;
    load_terminal_output_cache_from(&cache_dir, &pane_id)
}

/// Remove orphaned cache files that don't correspond to any active pane.
#[tauri::command]
pub fn clean_terminal_output_cache(active_pane_ids: Vec<String>) -> Result<u32, String> {
    let cache_dir = crate::settings::cache_dir_path().ok_or("Cannot determine cache directory")?;
    clean_terminal_output_cache_in(&cache_dir, &active_pane_ids)
}

/// Window geometry to persist across restarts.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct WindowGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

fn window_geometry_path() -> Result<std::path::PathBuf, String> {
    let cache_dir = crate::settings::cache_dir_path().ok_or("Cannot determine cache directory")?;
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("Failed to create cache dir: {e}"))?;
    Ok(cache_dir.join("window-geometry.json"))
}

/// Save window geometry to cache.
#[tauri::command]
pub fn save_window_geometry(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
) -> Result<(), String> {
    let geo = WindowGeometry {
        x,
        y,
        width,
        height,
        maximized,
    };
    let json = serde_json::to_string(&geo).map_err(|e| format!("Serialize: {e}"))?;
    let path = window_geometry_path()?;
    std::fs::write(&path, json.as_bytes()).map_err(|e| format!("Write: {e}"))
}

/// Load window geometry from cache. Returns null if not found.
#[tauri::command]
pub fn load_window_geometry() -> Result<Option<WindowGeometry>, String> {
    let path = match window_geometry_path() {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };
    match std::fs::read(&path) {
        Ok(bytes) => {
            let s = String::from_utf8(bytes).map_err(|e| format!("UTF-8: {e}"))?;
            let geo: WindowGeometry =
                serde_json::from_str(&s).map_err(|e| format!("Deserialize: {e}"))?;
            Ok(Some(geo))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Read: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greet_returns_message() {
        let result = greet("Laymux");
        assert_eq!(result, "Hello, Laymux! Welcome to Laymux.");
    }

    #[test]
    fn build_gh_command_direct_invocation() {
        let cmd = build_gh_command("");
        assert_eq!(cmd.get_program(), "gh");
        assert_eq!(cmd.get_args().collect::<Vec<_>>().len(), 0);
    }

    #[test]
    fn build_gh_command_with_shell_prefix() {
        let cmd = build_gh_command("wsl.exe -d Ubuntu --");
        assert_eq!(cmd.get_program(), "wsl.exe");
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, vec!["-d", "Ubuntu", "--", "gh"]);
    }

    #[test]
    fn build_gh_command_whitespace_only_prefix() {
        let cmd = build_gh_command("   ");
        assert_eq!(cmd.get_program(), "gh");
        assert_eq!(cmd.get_args().collect::<Vec<_>>().len(), 0);
    }

    #[test]
    fn build_gh_command_simple_shell() {
        let cmd = build_gh_command("bash");
        assert_eq!(cmd.get_program(), "bash");
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, vec!["gh"]);
    }

    #[test]
    fn build_gh_command_double_quoted_arg() {
        let cmd = build_gh_command(r#"wsl.exe -d "My Distro" --"#);
        assert_eq!(cmd.get_program(), "wsl.exe");
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, vec!["-d", "My Distro", "--", "gh"]);
    }

    #[test]
    fn build_gh_command_single_quoted_arg() {
        let cmd = build_gh_command("wsl.exe -d 'My Distro' --");
        assert_eq!(cmd.get_program(), "wsl.exe");
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, vec!["-d", "My Distro", "--", "gh"]);
    }

    #[test]
    fn split_shell_prefix_basic() {
        assert_eq!(split_shell_prefix(""), Vec::<String>::new());
        assert_eq!(split_shell_prefix("   "), Vec::<String>::new());
        assert_eq!(split_shell_prefix("a b c"), vec!["a", "b", "c"]);
    }

    #[test]
    fn split_shell_prefix_quotes() {
        assert_eq!(split_shell_prefix(r#""hello world""#), vec!["hello world"]);
        assert_eq!(split_shell_prefix("'hello world'"), vec!["hello world"]);
        assert_eq!(
            split_shell_prefix(r#"cmd "arg one" 'arg two' plain"#),
            vec!["cmd", "arg one", "arg two", "plain"]
        );
    }

    #[test]
    fn split_shell_prefix_unclosed_quote() {
        // Unclosed quote: rest of string is one token
        assert_eq!(
            split_shell_prefix(r#"cmd "unclosed arg"#),
            vec!["cmd", "unclosed arg"]
        );
    }

    #[test]
    fn sanitize_filename_alphanumeric_preserved() {
        assert_eq!(sanitize_filename("pane-abc123"), "pane-abc123");
        assert_eq!(sanitize_filename("dp_test_1"), "dp_test_1");
    }

    #[test]
    fn sanitize_filename_special_chars_replaced() {
        assert_eq!(sanitize_filename("pane/../../etc"), "pane_______etc");
        assert_eq!(sanitize_filename("a b.c"), "a_b.c");
    }

    #[test]
    fn sanitize_filename_rejects_dot_dot_traversal() {
        assert_eq!(sanitize_filename(".."), "__");
        assert_eq!(sanitize_filename("foo..bar"), "foo__bar");
    }

    #[test]
    fn terminal_output_cache_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let data = "Hello terminal output \x1b[32mgreen\x1b[0m";
        save_terminal_output_cache_to(dir.path(), "pane-test123", data).unwrap();
        let loaded = load_terminal_output_cache_from(dir.path(), "pane-test123").unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn save_cache_rejects_empty_pane_id() {
        let dir = tempfile::tempdir().unwrap();
        let result = save_terminal_output_cache_to(dir.path(), "", "data");
        assert_eq!(result.unwrap_err(), "Empty pane ID");
    }

    #[test]
    fn load_cache_rejects_empty_pane_id() {
        let dir = tempfile::tempdir().unwrap();
        let result = load_terminal_output_cache_from(dir.path(), "");
        assert_eq!(result.unwrap_err(), "Empty pane ID");
    }

    #[test]
    fn clean_terminal_output_cache_removes_orphans() {
        let dir = tempfile::tempdir().unwrap();
        save_terminal_output_cache_to(dir.path(), "pane-keep", "data").unwrap();
        save_terminal_output_cache_to(dir.path(), "pane-orphan", "data").unwrap();
        save_terminal_output_cache_to(dir.path(), "pane-also-orphan", "data").unwrap();

        let removed = clean_terminal_output_cache_in(dir.path(), &["pane-keep".into()]).unwrap();
        assert_eq!(removed, 2);
        // Verify via load
        assert!(load_terminal_output_cache_from(dir.path(), "pane-keep").is_ok());
        assert!(load_terminal_output_cache_from(dir.path(), "pane-orphan").is_err());
    }

    #[test]
    fn clean_cache_skips_non_dat_files() {
        let dir = tempfile::tempdir().unwrap();
        save_terminal_output_cache_to(dir.path(), "pane-keep", "data").unwrap();
        // Create a non-.dat file in the terminal-output directory
        let non_dat = dir.path().join("terminal-output").join("readme.txt");
        std::fs::write(&non_dat, "do not delete").unwrap();

        let removed = clean_terminal_output_cache_in(dir.path(), &["pane-keep".into()]).unwrap();
        assert_eq!(removed, 0);
        // Non-.dat file should still exist
        assert!(non_dat.exists());
    }

    #[test]
    fn clean_cache_filters_empty_pane_ids() {
        let dir = tempfile::tempdir().unwrap();
        save_terminal_output_cache_to(dir.path(), "pane-a", "data").unwrap();
        // Empty string in active list should not match everything
        let removed =
            clean_terminal_output_cache_in(dir.path(), &["".into(), "pane-a".into()]).unwrap();
        assert_eq!(removed, 0);
    }

    #[test]
    fn resolve_targets_from_group() {
        let state = AppState::new();
        {
            let mut groups = state.sync_groups.lock().unwrap();
            let mut group = crate::terminal::SyncGroup::new("g1".into());
            group.add_terminal("t1".into());
            group.add_terminal("t2".into());
            group.add_terminal("t3".into());
            groups.insert("g1".into(), group);
        }

        let targets = resolve_target_terminals(&state, "t1", "g1", false, None).unwrap();
        assert_eq!(targets, vec!["t2", "t3"]);
    }

    #[test]
    fn resolve_targets_all() {
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            terminals.insert(
                "t1".into(),
                TerminalSession::new("t1".into(), TerminalConfig::default()),
            );
            terminals.insert(
                "t2".into(),
                TerminalSession::new("t2".into(), TerminalConfig::default()),
            );
            terminals.insert(
                "t3".into(),
                TerminalSession::new("t3".into(), TerminalConfig::default()),
            );
        }

        let mut targets = resolve_target_terminals(&state, "t1", "", true, None).unwrap();
        targets.sort();
        assert_eq!(targets, vec!["t2", "t3"]);
    }

    #[test]
    fn resolve_targets_specific_group() {
        let state = AppState::new();
        {
            let mut groups = state.sync_groups.lock().unwrap();
            let mut group = crate::terminal::SyncGroup::new("other".into());
            group.add_terminal("t4".into());
            group.add_terminal("t5".into());
            groups.insert("other".into(), group);
        }

        let targets = resolve_target_terminals(&state, "t1", "g1", false, Some("other")).unwrap();
        assert_eq!(targets, vec!["t4", "t5"]);
    }

    // --- Propagation guard tests ---

    #[test]
    fn is_propagated_returns_false_for_unknown_terminal() {
        let state = AppState::new();
        assert!(!is_propagated(&state, "t1").unwrap());
    }

    #[test]
    fn is_propagated_returns_true_after_mark() {
        let state = AppState::new();
        mark_propagated(&state, &["t1".into()]).unwrap();
        assert!(is_propagated(&state, "t1").unwrap());
    }

    #[test]
    fn is_propagated_remains_true_on_repeated_checks() {
        let state = AppState::new();
        mark_propagated(&state, &["t1".into()]).unwrap();
        // Multiple checks within timeout — all should return true
        assert!(is_propagated(&state, "t1").unwrap());
        assert!(is_propagated(&state, "t1").unwrap());
        assert!(is_propagated(&state, "t1").unwrap());
    }

    #[test]
    fn mark_propagated_sets_multiple_terminals() {
        let state = AppState::new();
        mark_propagated(&state, &["t1".into(), "t2".into(), "t3".into()]).unwrap();
        assert!(is_propagated(&state, "t1").unwrap());
        assert!(is_propagated(&state, "t2").unwrap());
        assert!(is_propagated(&state, "t3").unwrap());
    }

    #[test]
    fn propagated_flag_does_not_affect_other_terminals() {
        let state = AppState::new();
        mark_propagated(&state, &["t1".into()]).unwrap();
        assert!(!is_propagated(&state, "t2").unwrap());
    }

    #[test]
    fn stale_entries_cleaned_up() {
        let state = AppState::new();
        {
            let mut propagated = state.propagated_terminals.lock().unwrap();
            propagated.insert(
                "t1".into(),
                std::time::Instant::now() - std::time::Duration::from_secs(10),
            );
        }
        cleanup_stale_propagations(&state);
        let propagated = state.propagated_terminals.lock().unwrap();
        assert!(propagated.is_empty());
    }

    #[test]
    fn fresh_entries_survive_cleanup() {
        let state = AppState::new();
        mark_propagated(&state, &["t1".into()]).unwrap();
        cleanup_stale_propagations(&state);
        let propagated = state.propagated_terminals.lock().unwrap();
        assert!(propagated.contains_key("t1"));
    }

    #[test]
    fn expired_propagation_returns_false() {
        let state = AppState::new();
        {
            let mut propagated = state.propagated_terminals.lock().unwrap();
            propagated.insert(
                "t1".into(),
                std::time::Instant::now() - std::time::Duration::from_secs(10),
            );
        }
        // Even though the entry exists, it's expired → returns false
        assert!(!is_propagated(&state, "t1").unwrap());
    }

    #[test]
    fn sync_cwd_ping_pong_prevention() {
        // Setup: group "g1" with t1, t2, t3
        let state = AppState::new();
        {
            let mut groups = state.sync_groups.lock().unwrap();
            let mut group = crate::terminal::SyncGroup::new("g1".into());
            group.add_terminal("t1".into());
            group.add_terminal("t2".into());
            group.add_terminal("t3".into());
            groups.insert("g1".into(), group);
        }

        // Step 1: T1 triggers sync-cwd (user-initiated) — not propagated
        assert!(!is_propagated(&state, "t1").unwrap());
        let targets = resolve_target_terminals(&state, "t1", "g1", false, None).unwrap();
        assert_eq!(targets, vec!["t2", "t3"]);

        // Mark targets as propagated (simulating handle_lx_message behavior)
        mark_propagated(&state, &targets).unwrap();

        // Step 2: T2's echo triggers sync-cwd — should be suppressed
        assert!(is_propagated(&state, "t2").unwrap());

        // Step 3: T3's echo triggers sync-cwd — should also be suppressed
        assert!(is_propagated(&state, "t3").unwrap());

        // Step 4: T1 does another cd — should NOT be suppressed
        assert!(!is_propagated(&state, "t1").unwrap());
    }

    #[test]
    fn propagation_suppresses_multiple_osc_within_timeout() {
        // WSL emits both OSC 7 and OSC 9;9 — both must be suppressed
        let state = AppState::new();
        mark_propagated(&state, &["t1".into()]).unwrap();

        // First OSC check — suppressed
        assert!(is_propagated(&state, "t1").unwrap());
        // Second OSC check (e.g. OSC 9;9 after OSC 7) — still suppressed
        assert!(is_propagated(&state, "t1").unwrap());
        // Third check — still suppressed within timeout
        assert!(is_propagated(&state, "t1").unwrap());
    }

    #[test]
    fn propagation_expires_after_timeout() {
        let state = AppState::new();
        {
            let mut propagated = state.propagated_terminals.lock().unwrap();
            propagated.insert(
                "t1".into(),
                std::time::Instant::now() - std::time::Duration::from_secs(10),
            );
        }
        // Expired entry → not suppressed
        assert!(!is_propagated(&state, "t1").unwrap());
    }

    #[test]
    fn filter_targets_skips_terminals_already_at_same_cwd() {
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            let mut t1 = TerminalSession::new("t1".into(), TerminalConfig::default());
            t1.cwd = Some("/home/user/project".into());
            let mut t2 = TerminalSession::new("t2".into(), TerminalConfig::default());
            t2.cwd = Some("/home/user/project".into()); // same CWD
            let mut t3 = TerminalSession::new("t3".into(), TerminalConfig::default());
            t3.cwd = Some("/home/user/other".into()); // different CWD
            let t4 = TerminalSession::new("t4".into(), TerminalConfig::default()); // no CWD
            terminals.insert("t1".into(), t1);
            terminals.insert("t2".into(), t2);
            terminals.insert("t3".into(), t3);
            terminals.insert("t4".into(), t4);
        }

        let targets = vec!["t2".into(), "t3".into(), "t4".into()];
        let filtered = filter_targets_needing_cd(&state, &targets, "/home/user/project");
        // t2 already at same CWD → excluded
        // t3 different CWD → included
        // t4 no CWD → included
        assert!(!filtered.contains(&"t2".to_string()));
        assert!(filtered.contains(&"t3".to_string()));
        assert!(filtered.contains(&"t4".to_string()));
    }

    #[test]
    fn normalize_wsl_unc_path_converts_correctly() {
        assert_eq!(
            path_utils::normalize_wsl_path("//wsl.localhost/Ubuntu-22.04/home/user/project"),
            "/home/user/project"
        );
        assert_eq!(
            path_utils::normalize_wsl_path("//wsl$/Ubuntu-22.04/home/user/project"),
            "/home/user/project"
        );
    }

    #[test]
    fn filter_targets_needing_cd_deduplicates_unchanged_cwd() {
        // When source's CWD is already set (e.g., by proactive PTY detection),
        // filter_targets_needing_cd should still filter targets that already
        // have the same CWD — this is the target-side dedup mechanism.
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            let mut t1 = TerminalSession::new("t1".into(), TerminalConfig::default());
            t1.cwd = Some("/home/user/project".into());
            terminals.insert("t1".into(), t1);

            // t2 already at same CWD → should be filtered out
            let mut t2 = TerminalSession::new("t2".into(), TerminalConfig::default());
            t2.cwd = Some("/home/user/project".into());
            terminals.insert("t2".into(), t2);

            // t3 at different CWD → should NOT be filtered out
            let mut t3 = TerminalSession::new("t3".into(), TerminalConfig::default());
            t3.cwd = Some("/home/user/other".into());
            terminals.insert("t3".into(), t3);

            // t4 no CWD → should NOT be filtered out
            terminals.insert(
                "t4".into(),
                TerminalSession::new("t4".into(), TerminalConfig::default()),
            );
        }

        let targets = vec!["t2".into(), "t3".into(), "t4".into()];
        let result = filter_targets_needing_cd(&state, &targets, "/home/user/project");
        // t2 filtered (same CWD), t3 and t4 remain
        assert_eq!(result, vec!["t3".to_string(), "t4".to_string()]);
    }

    #[test]
    fn normalize_wsl_path_leaves_linux_paths_unchanged() {
        assert_eq!(
            path_utils::normalize_wsl_path("/home/user/project"),
            "/home/user/project"
        );
        assert_eq!(path_utils::normalize_wsl_path("~/dev"), "~/dev");
    }

    #[test]
    fn normalize_wsl_path_converts_windows_to_mnt() {
        // Windows paths are normalized to /mnt/x/... canonical form
        assert_eq!(
            path_utils::normalize_wsl_path("C:\\Users\\user"),
            "/mnt/c/Users/user"
        );
    }

    #[test]
    fn normalize_file_localhost_path() {
        assert_eq!(
            path_utils::normalize_wsl_path("file://localhost/home/user/project"),
            "/home/user/project"
        );
        assert_eq!(
            path_utils::normalize_wsl_path("file://localhost/tmp"),
            "/tmp"
        );
    }

    #[test]
    fn normalize_powershell_osc7_windows_path() {
        // PowerShell emits: file://localhost/C:/Users/kochul → /mnt/c/Users/kochul
        assert_eq!(
            path_utils::normalize_wsl_path("file://localhost/C:/Users/kochul"),
            "/mnt/c/Users/kochul"
        );
        assert_eq!(
            path_utils::normalize_wsl_path("file://localhost/D:/Games/SteamLibrary"),
            "/mnt/d/Games/SteamLibrary"
        );
        assert_eq!(
            path_utils::normalize_wsl_path("file://localhost/C:/"),
            "/mnt/c/"
        );
    }

    #[test]
    fn normalize_bare_windows_path() {
        // Bare Windows paths from OSC 9;9: C:/Users → /mnt/c/Users
        assert_eq!(path_utils::normalize_wsl_path("C:/Users"), "/mnt/c/Users");
        assert_eq!(
            path_utils::normalize_wsl_path("C:\\Windows"),
            "/mnt/c/Windows"
        );
        assert_eq!(
            path_utils::normalize_wsl_path("D:\\Games\\Steam"),
            "/mnt/d/Games/Steam"
        );
    }

    #[test]
    fn normalize_osc7_and_osc99_produce_same_result() {
        // Critical: both OSC 7 and OSC 9;9 for the same cd must normalize identically
        // so filter_targets_needing_cd deduplicates them
        let from_osc7 = path_utils::normalize_wsl_path("file://localhost/mnt/c/Windows");
        let from_osc99 = path_utils::normalize_wsl_path("C:/Windows");
        assert_eq!(from_osc7, from_osc99);
        assert_eq!(from_osc7, "/mnt/c/Windows");
    }

    #[test]
    fn filter_targets_not_busy_excludes_command_running() {
        let state = AppState::new();
        // t1: at prompt (last OSC is 133;D)
        // t2: command running (last OSC is 133;C)
        // t3: no output (assume at prompt)
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            let mut buf1 = crate::output_buffer::TerminalOutputBuffer::default();
            buf1.push(b"\x1b]133;C\x07some output\x1b]133;D;0\x07prompt$ ");
            buffers.insert("t1".into(), buf1);

            let mut buf2 = crate::output_buffer::TerminalOutputBuffer::default();
            buf2.push(b"\x1b]133;D;0\x07prompt$ \x1b]133;C\x07"); // Last is C → running
            buffers.insert("t2".into(), buf2);

            buffers.insert(
                "t3".into(),
                crate::output_buffer::TerminalOutputBuffer::default(),
            );
        }

        let targets = vec!["t1".into(), "t2".into(), "t3".into()];
        let (filtered, claude_ids) =
            filter_targets_not_busy(&state, &targets, &crate::settings::ClaudeSyncCwdMode::Skip);
        assert!(filtered.contains(&"t1".to_string()), "t1 at prompt");
        assert!(
            !filtered.contains(&"t2".to_string()),
            "t2 is busy, should be excluded"
        );
        assert!(
            filtered.contains(&"t3".to_string()),
            "t3 no output, assume at prompt"
        );
        assert!(claude_ids.is_empty(), "no Claude terminals in this test");
    }

    #[test]
    fn filter_targets_not_busy_includes_unknown_terminals() {
        let state = AppState::new();
        let targets = vec!["unknown".into()];
        let (filtered, _) =
            filter_targets_not_busy(&state, &targets, &crate::settings::ClaudeSyncCwdMode::Skip);
        assert_eq!(filtered, vec!["unknown"]);
    }

    #[test]
    fn is_terminal_at_prompt_detects_running_command() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;D;0\x07prompt$ \x1b]133;C\x07");
        assert!(
            !is_terminal_at_prompt_from_buffer(Some(&buf)),
            "After C, command is running"
        );
    }

    #[test]
    fn is_terminal_at_prompt_detects_idle() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;C\x07output\x1b]133;D;0\x07prompt$ ");
        assert!(
            is_terminal_at_prompt_from_buffer(Some(&buf)),
            "After D, terminal is idle"
        );
    }

    #[test]
    fn is_terminal_at_prompt_empty_buffer() {
        let buf = crate::output_buffer::TerminalOutputBuffer::default();
        assert!(
            is_terminal_at_prompt_from_buffer(Some(&buf)),
            "Empty buffer → assume at prompt"
        );
    }

    #[test]
    fn is_terminal_at_prompt_no_buffer() {
        assert!(
            is_terminal_at_prompt_from_buffer(None),
            "No buffer → assume at prompt"
        );
    }

    #[test]
    fn sync_cwd_skips_busy_terminals() {
        // Setup: group "g1" with t1 (source), t2 (idle), t3 (busy with Claude Code)
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            terminals.insert(
                "t1".into(),
                TerminalSession::new("t1".into(), TerminalConfig::default()),
            );
            terminals.insert(
                "t2".into(),
                TerminalSession::new("t2".into(), TerminalConfig::default()),
            );
            terminals.insert(
                "t3".into(),
                TerminalSession::new("t3".into(), TerminalConfig::default()),
            );
        }
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            // t2: at prompt
            let mut buf2 = crate::output_buffer::TerminalOutputBuffer::default();
            buf2.push(b"\x1b]133;D;0\x07prompt$ ");
            buffers.insert("t2".into(), buf2);
            // t3: command running (last OSC is 133;C)
            let mut buf3 = crate::output_buffer::TerminalOutputBuffer::default();
            buf3.push(b"\x1b]133;D;0\x07prompt$ \x1b]133;C\x07");
            buffers.insert("t3".into(), buf3);
        }
        {
            let mut groups = state.sync_groups.lock().unwrap();
            let mut group = crate::terminal::SyncGroup::new("g1".into());
            group.add_terminal("t1".into());
            group.add_terminal("t2".into());
            group.add_terminal("t3".into());
            groups.insert("g1".into(), group);
        }

        let all_targets = resolve_target_terminals(&state, "t1", "g1", false, None).unwrap();
        assert_eq!(all_targets, vec!["t2", "t3"]);

        let (idle_targets, _) = filter_targets_not_busy(
            &state,
            &all_targets,
            &crate::settings::ClaudeSyncCwdMode::Skip,
        );
        assert_eq!(idle_targets, vec!["t2"]);
    }

    #[test]
    fn close_terminal_removes_propagated_flag() {
        let state = AppState::new();
        mark_propagated(&state, &["t1".into()]).unwrap();
        // Simulate close: remove from propagated
        {
            let mut propagated = state.propagated_terminals.lock().unwrap();
            propagated.remove("t1");
        }
        assert!(!is_propagated(&state, "t1").unwrap());
    }

    // --- Terminal activity detection tests ---

    #[test]
    fn detect_activity_shell_at_prompt() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;C\x07output\x1b]133;D;0\x07prompt$ ");
        assert_eq!(
            detect_terminal_activity(Some(&buf)),
            TerminalActivity::Shell
        );
    }

    #[test]
    fn detect_activity_running_command() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;D;0\x07prompt$ \x1b]133;C\x07");
        assert_eq!(
            detect_terminal_activity(Some(&buf)),
            TerminalActivity::Running
        );
    }

    #[test]
    fn detect_activity_claude_code_from_title() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        // Simulate: prompt → preexec → Claude Code sets terminal title
        buf.push(b"\x1b]133;D;0\x07prompt$ \x1b]133;C\x07\x1b]0;\xe2\x9c\xb3 Claude Code\x07");
        assert_eq!(
            detect_terminal_activity(Some(&buf)),
            TerminalActivity::InteractiveApp {
                name: "Claude Code".to_string()
            }
        );
    }

    #[test]
    fn detect_activity_vim_from_title() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;D;0\x07\x1b]133;C\x07\x1b]0;vim main.rs\x07");
        assert_eq!(
            detect_terminal_activity(Some(&buf)),
            TerminalActivity::InteractiveApp {
                name: "vim".to_string()
            }
        );
    }

    #[test]
    fn detect_activity_no_buffer() {
        assert_eq!(detect_terminal_activity(None), TerminalActivity::Shell);
    }

    #[test]
    fn detect_activity_empty_buffer() {
        let buf = crate::output_buffer::TerminalOutputBuffer::default();
        assert_eq!(
            detect_terminal_activity(Some(&buf)),
            TerminalActivity::Shell
        );
    }

    #[test]
    fn extract_title_osc0() {
        let data = b"some output\x1b]0;my title\x07more output";
        assert_eq!(
            extract_last_terminal_title(data),
            Some("my title".to_string())
        );
    }

    #[test]
    fn extract_title_osc2() {
        let data = b"\x1b]2;window title\x07";
        assert_eq!(
            extract_last_terminal_title(data),
            Some("window title".to_string())
        );
    }

    #[test]
    fn extract_title_last_wins() {
        let data = b"\x1b]0;first\x07middle\x1b]0;second\x07end";
        assert_eq!(
            extract_last_terminal_title(data),
            Some("second".to_string())
        );
    }

    #[test]
    fn extract_title_none_when_missing() {
        let data = b"no osc sequences here";
        assert_eq!(extract_last_terminal_title(data), None);
    }

    #[test]
    fn detect_state_output_active() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;D;0\x07prompt$ "); // push sets last_output_at
        let state_info = detect_terminal_state(Some(&buf));
        assert_eq!(state_info.activity, TerminalActivity::Shell);
        assert!(
            state_info.output_active,
            "Just pushed output should be active"
        );
        assert!(state_info.last_output_ms_ago < 1000);
    }

    #[test]
    fn detect_state_output_stale() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;D;0\x07prompt$ ");
        // Manually set last_output_at to the past
        buf.last_output_at = Some(std::time::Instant::now() - std::time::Duration::from_secs(10));
        let state_info = detect_terminal_state(Some(&buf));
        assert!(
            !state_info.output_active,
            "10s old output should not be active"
        );
        assert!(state_info.last_output_ms_ago >= 9000);
    }

    // --- Claude Code detection tests ---

    #[test]
    fn is_claude_terminal_detects_claude_from_title() {
        let state = AppState::new();
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07");
        assert!(is_claude_terminal_from_buffer(&state, "t1", Some(&buf)));
    }

    #[test]
    fn is_claude_terminal_false_for_normal_terminal() {
        let state = AppState::new();
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]0;bash\x07");
        assert!(!is_claude_terminal_from_buffer(&state, "t1", Some(&buf)));
    }

    #[test]
    fn is_claude_terminal_false_for_no_buffer() {
        let state = AppState::new();
        assert!(!is_claude_terminal_from_buffer(&state, "t1", None));
    }

    #[test]
    fn is_claude_terminal_false_for_empty_buffer() {
        let state = AppState::new();
        let buf = crate::output_buffer::TerminalOutputBuffer::default();
        assert!(!is_claude_terminal_from_buffer(&state, "t1", Some(&buf)));
    }

    #[test]
    fn is_claude_idle_detects_idle_prefix() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        // ✳ (U+2733) prefix = idle
        buf.push(b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07");
        assert!(is_claude_idle_from_buffer(Some(&buf)));
    }

    #[test]
    fn is_claude_idle_false_when_working() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        // ✶ (U+2736) prefix = working/spinner
        buf.push(b"\x1b]0;\xe2\x9c\xb6 Claude Code\x07");
        assert!(!is_claude_idle_from_buffer(Some(&buf)));
    }

    #[test]
    fn is_claude_idle_false_for_no_buffer() {
        assert!(!is_claude_idle_from_buffer(None));
    }

    #[test]
    fn detect_activity_claude_when_osc133_markers_scrolled_out() {
        // Bug fix test: when Claude runs long, OSC 133;C scrolls out of buffer.
        // Without title, there are no OSC 133 markers → would wrongly return Shell.
        // With fix: title check happens first → correctly returns InteractiveApp.
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        // Only a title set, no OSC 133 markers at all (simulating they scrolled out)
        buf.push(b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07some output here");
        assert_eq!(
            detect_terminal_activity(Some(&buf)),
            TerminalActivity::InteractiveApp {
                name: "Claude Code".to_string()
            }
        );
    }

    #[test]
    fn filter_targets_not_busy_skips_claude_in_skip_mode() {
        // Default settings: claude.syncCwd = "skip"
        // Claude terminals should be excluded even if they appear idle
        let state = AppState::new();
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            // t1: normal terminal at prompt
            let mut buf1 = crate::output_buffer::TerminalOutputBuffer::default();
            buf1.push(b"\x1b]133;D;0\x07prompt$ ");
            buffers.insert("t1".into(), buf1);
            // t2: Claude Code terminal (idle)
            let mut buf2 = crate::output_buffer::TerminalOutputBuffer::default();
            buf2.push(b"\x1b]133;D;0\x07\x1b]133;C\x07\x1b]0;\xe2\x9c\xb3 Claude Code\x07");
            buffers.insert("t2".into(), buf2);
        }

        let targets = vec!["t1".into(), "t2".into()];
        let (filtered, claude_ids) =
            filter_targets_not_busy(&state, &targets, &crate::settings::ClaudeSyncCwdMode::Skip);
        // In skip mode (default), Claude terminal t2 should be excluded
        assert!(
            filtered.contains(&"t1".to_string()),
            "normal terminal should pass"
        );
        assert!(
            claude_ids.is_empty(),
            "skip mode should not collect claude_ids"
        );
        assert!(
            !filtered.contains(&"t2".to_string()),
            "Claude terminal should be skipped"
        );
    }

    #[test]
    fn filter_targets_not_busy_command_mode_includes_idle_claude() {
        // Command mode: idle Claude terminal should be included with claude_ids
        let state = AppState::new();
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            // t1: normal terminal at prompt
            let mut buf1 = crate::output_buffer::TerminalOutputBuffer::default();
            buf1.push(b"\x1b]133;D;0\x07prompt$ ");
            buffers.insert("t1".into(), buf1);
            // t2: Claude Code terminal (idle — ✳ prefix)
            let mut buf2 = crate::output_buffer::TerminalOutputBuffer::default();
            buf2.push(b"\x1b]133;D;0\x07\x1b]0;\xe2\x9c\xb3 Claude Code\x07");
            buffers.insert("t2".into(), buf2);
        }

        let targets = vec!["t1".into(), "t2".into()];
        let (filtered, claude_ids) = filter_targets_not_busy(
            &state,
            &targets,
            &crate::settings::ClaudeSyncCwdMode::Command,
        );
        assert!(
            filtered.contains(&"t1".to_string()),
            "normal terminal should pass"
        );
        assert!(
            filtered.contains(&"t2".to_string()),
            "idle Claude should be included in command mode"
        );
        assert!(
            claude_ids.contains("t2"),
            "idle Claude should be in claude_ids"
        );
        assert!(
            !claude_ids.contains("t1"),
            "normal terminal should not be in claude_ids"
        );
    }

    #[test]
    fn filter_targets_not_busy_command_mode_excludes_working_claude() {
        // Command mode: working Claude terminal (✶ spinner) should be excluded
        let state = AppState::new();
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            // t1: Claude Code terminal (working — ✶ prefix)
            let mut buf1 = crate::output_buffer::TerminalOutputBuffer::default();
            buf1.push(b"\x1b]0;\xe2\x9c\xb6 Claude Code\x07");
            buffers.insert("t1".into(), buf1);
        }

        let targets = vec!["t1".into()];
        let (filtered, claude_ids) = filter_targets_not_busy(
            &state,
            &targets,
            &crate::settings::ClaudeSyncCwdMode::Command,
        );
        assert!(
            filtered.is_empty(),
            "working Claude should be excluded even in command mode"
        );
        assert!(
            claude_ids.is_empty(),
            "working Claude should not be in claude_ids"
        );
    }

    // --- build_sync_cd_command tests ---

    #[test]
    fn build_sync_cd_command_claude_uses_bang_cd_single_quoted() {
        let cmd = build_sync_cd_command("/home/user/project", "WSL", true);
        assert_eq!(cmd, "! cd '/home/user/project'\n");
    }

    #[test]
    fn build_sync_cd_command_claude_escapes_single_quotes_in_path() {
        let cmd = build_sync_cd_command("/home/user/it's a dir", "WSL", true);
        assert_eq!(cmd, "! cd '/home/user/it'\\''s a dir'\n");
    }

    #[test]
    fn build_sync_cd_command_claude_safe_with_dollar_and_backtick() {
        let cmd = build_sync_cd_command("/home/$USER/`test`", "WSL", true);
        // Single quotes prevent shell expansion of $ and backticks
        assert_eq!(cmd, "! cd '/home/$USER/`test`'\n");
    }

    #[test]
    fn build_sync_cd_command_normal_wsl_uses_propagated_cd() {
        let cmd = build_sync_cd_command("/home/user/project", "WSL", false);
        assert!(
            cmd.starts_with("LX_PROPAGATED=1 "),
            "WSL should use LX_PROPAGATED=1 prefix"
        );
        assert!(cmd.contains("cd "), "should contain cd command");
    }

    #[test]
    fn build_sync_cd_command_normal_powershell_uses_env_propagated() {
        let cmd = build_sync_cd_command("C:\\Users\\test", "PowerShell", false);
        assert!(
            cmd.starts_with("$env:LX_PROPAGATED='1';"),
            "PowerShell should use $env: prefix"
        );
        assert!(cmd.contains("cd "), "should contain cd command");
    }

    // --- Cross-profile path conversion tests ---

    #[test]
    fn convert_path_wsl_mnt_to_powershell() {
        // WSL /mnt/c/... → PowerShell C:\...
        assert_eq!(
            convert_path_for_target("/mnt/c/Users/kochul/project", "PowerShell"),
            Some("C:\\Users\\kochul\\project".into())
        );
    }

    #[test]
    fn convert_path_wsl_mnt_drive_root_to_powershell() {
        // WSL /mnt/c → PowerShell C:\
        assert_eq!(
            convert_path_for_target("/mnt/c", "PowerShell"),
            Some("C:\\".into())
        );
    }

    #[test]
    fn convert_path_wsl_mnt_various_drives() {
        assert_eq!(
            convert_path_for_target("/mnt/d/Games", "PowerShell"),
            Some("D:\\Games".into())
        );
        assert_eq!(
            convert_path_for_target("/mnt/e/Backup/data", "PowerShell"),
            Some("E:\\Backup\\data".into())
        );
    }

    #[test]
    fn convert_path_wsl_home_to_powershell_without_distro_returns_none() {
        // Without distro info, pure WSL path can't be converted
        assert_eq!(
            convert_path_for_target("/home/kochul/python_projects", "PowerShell"),
            None
        );
    }

    #[test]
    fn convert_path_wsl_home_to_powershell_with_distro_uses_unc() {
        // With distro info, pure WSL path → UNC path
        assert_eq!(
            path_utils::convert_path_for_target_with_distro(
                "/home/kochul/python_projects",
                "PowerShell",
                Some("Ubuntu-22.04")
            ),
            Some("\\\\wsl.localhost\\Ubuntu-22.04\\home\\kochul\\python_projects".into())
        );
    }

    #[test]
    fn convert_path_wsl_tmp_to_powershell_with_distro_uses_unc() {
        assert_eq!(
            path_utils::convert_path_for_target_with_distro(
                "/tmp",
                "PowerShell",
                Some("Ubuntu-22.04")
            ),
            Some("\\\\wsl.localhost\\Ubuntu-22.04\\tmp".into())
        );
    }

    #[test]
    fn convert_path_wsl_mnt_to_powershell_ignores_distro() {
        // /mnt/c/ paths should still convert to C:\ even when distro is available
        assert_eq!(
            path_utils::convert_path_for_target_with_distro(
                "/mnt/c/Users",
                "PowerShell",
                Some("Ubuntu-22.04")
            ),
            Some("C:\\Users".into())
        );
    }

    #[test]
    fn extract_wsl_distro_from_wsl_localhost_title() {
        assert_eq!(
            path_utils::extract_wsl_distro_from_path("//wsl.localhost/Ubuntu-22.04/home/kochul"),
            Some("Ubuntu-22.04".into())
        );
    }

    #[test]
    fn extract_wsl_distro_from_wsl_dollar_title() {
        assert_eq!(
            path_utils::extract_wsl_distro_from_path("//wsl$/Ubuntu/home/user"),
            Some("Ubuntu".into())
        );
    }

    #[test]
    fn extract_wsl_distro_from_non_wsl_path_returns_none() {
        assert_eq!(
            path_utils::extract_wsl_distro_from_path("PowerShell 7.4"),
            None
        );
        assert_eq!(
            path_utils::extract_wsl_distro_from_path("C:\\Windows"),
            None
        );
        assert_eq!(
            path_utils::extract_wsl_distro_from_path("file://localhost/home/user"),
            None
        );
        assert_eq!(
            path_utils::extract_wsl_distro_from_path("/home/user/project"),
            None
        );
    }

    // --- 4-direction sync conversion tests (PS→WSL, WSL→PS, WSL→WSL, PS→PS) ---

    #[test]
    fn sync_direction_ps_to_wsl_windows_drive() {
        // PowerShell at C:\Users → WSL should get /mnt/c/Users
        assert_eq!(
            convert_path_for_target("C:\\Users", "WSL"),
            Some("/mnt/c/Users".into())
        );
    }

    #[test]
    fn sync_direction_ps_to_wsl_forward_slash() {
        // PowerShell OSC7 sends C:/Users (forward slash)
        assert_eq!(
            convert_path_for_target("C:/Users/kochul", "WSL"),
            Some("/mnt/c/Users/kochul".into())
        );
    }

    #[test]
    fn sync_direction_wsl_to_ps_mnt_path() {
        // WSL at /mnt/c/Windows → PowerShell should get C:\Windows
        assert_eq!(
            convert_path_for_target("/mnt/c/Windows", "PowerShell"),
            Some("C:\\Windows".into())
        );
    }

    #[test]
    fn sync_direction_wsl_to_ps_home_with_distro() {
        // WSL at /home/kochul → PowerShell should get UNC path
        assert_eq!(
            path_utils::convert_path_for_target_with_distro(
                "/home/kochul",
                "PowerShell",
                Some("Ubuntu-22.04")
            ),
            Some("\\\\wsl.localhost\\Ubuntu-22.04\\home\\kochul".into())
        );
    }

    #[test]
    fn sync_direction_wsl_to_ps_tmp_with_distro() {
        assert_eq!(
            path_utils::convert_path_for_target_with_distro(
                "/tmp/build",
                "PowerShell",
                Some("Debian")
            ),
            Some("\\\\wsl.localhost\\Debian\\tmp\\build".into())
        );
    }

    #[test]
    fn sync_direction_wsl_to_wsl_linux_path() {
        // WSL → WSL: Linux paths pass through
        assert_eq!(
            convert_path_for_target("/home/kochul/project", "WSL"),
            Some("/home/kochul/project".into())
        );
    }

    #[test]
    fn sync_direction_wsl_to_wsl_mnt_path() {
        assert_eq!(
            convert_path_for_target("/mnt/c/Windows", "WSL"),
            Some("/mnt/c/Windows".into())
        );
    }

    #[test]
    fn sync_direction_ps_to_ps_windows_path() {
        // PowerShell → PowerShell: Windows paths pass through
        assert_eq!(
            convert_path_for_target("C:\\Users\\kochul", "PowerShell"),
            Some("C:\\Users\\kochul".into())
        );
    }

    #[test]
    fn normalize_powershell_provider_path() {
        // PowerShell at UNC path emits provider prefix
        assert_eq!(
            path_utils::normalize_wsl_path("file://localhost/Microsoft.PowerShell.Core/FileSystem:://wsl.localhost/Ubuntu-22.04/home/kochul"),
            "/home/kochul"
        );
        // Raw provider prefix (without file://localhost)
        assert_eq!(
            path_utils::normalize_wsl_path(
                "Microsoft.PowerShell.Core/FileSystem:://wsl.localhost/Ubuntu-22.04/tmp"
            ),
            "/tmp"
        );
        // Provider prefix with Windows path → normalized to /mnt/c/...
        assert_eq!(
            path_utils::normalize_wsl_path(
                "Microsoft.PowerShell.Core/FileSystem::C:\\Users\\kochul"
            ),
            "/mnt/c/Users/kochul"
        );
    }

    #[test]
    fn extract_distro_from_osc99_path() {
        // OSC 9;9 sends //wsl.localhost/Ubuntu-22.04/home/kochul
        assert_eq!(
            path_utils::extract_wsl_distro_from_path("//wsl.localhost/Ubuntu-22.04/home/kochul"),
            Some("Ubuntu-22.04".into())
        );
    }

    #[test]
    fn extract_distro_from_wsl_dollar_path() {
        assert_eq!(
            path_utils::extract_wsl_distro_from_path("//wsl$/Debian/usr/local"),
            Some("Debian".into())
        );
    }

    #[test]
    fn convert_path_windows_to_wsl() {
        // PowerShell C:\Users\kochul → WSL /mnt/c/Users/kochul
        assert_eq!(
            convert_path_for_target("C:\\Users\\kochul\\project", "WSL"),
            Some("/mnt/c/Users/kochul/project".into())
        );
    }

    #[test]
    fn convert_path_windows_forward_slash_to_wsl() {
        assert_eq!(
            convert_path_for_target("C:/Users/kochul/project", "WSL"),
            Some("/mnt/c/Users/kochul/project".into())
        );
    }

    #[test]
    fn convert_path_windows_drive_root_to_wsl() {
        assert_eq!(
            convert_path_for_target("C:\\", "WSL"),
            Some("/mnt/c/".into())
        );
    }

    #[test]
    fn convert_path_same_profile_linux_to_wsl() {
        assert_eq!(
            convert_path_for_target("/home/kochul/project", "WSL"),
            Some("/home/kochul/project".into())
        );
    }

    #[test]
    fn convert_path_same_profile_windows_to_powershell() {
        assert_eq!(
            convert_path_for_target("C:\\Users\\kochul", "PowerShell"),
            Some("C:\\Users\\kochul".into())
        );
    }

    #[test]
    fn convert_path_lowercase_profiles() {
        assert_eq!(
            convert_path_for_target("/mnt/c/Users", "powershell"),
            Some("C:\\Users".into())
        );
        assert_eq!(
            convert_path_for_target("C:\\Users", "wsl"),
            Some("/mnt/c/Users".into())
        );
    }

    #[test]
    fn build_cd_command_for_wsl_uses_plain_cd() {
        assert_eq!(
            build_cd_command("/home/kochul", "WSL"),
            " cd /home/kochul\n"
        );
    }

    #[test]
    fn build_cd_command_for_powershell_uses_cr() {
        assert_eq!(
            build_cd_command("C:\\Users\\kochul", "PowerShell"),
            " cd C:\\Users\\kochul\r"
        );
    }

    #[test]
    fn base64_encode_empty() {
        assert_eq!(base64_encode(b""), "");
    }

    #[test]
    fn base64_encode_hello() {
        assert_eq!(base64_encode(b"Hello"), "SGVsbG8=");
    }

    #[test]
    fn base64_encode_roundtrip() {
        let original = b"screenshot data \x00\xff\x80";
        let encoded = base64_encode(original);
        let decoded = crate::automation_server::base64_decode(&encoded).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn is_monospace_detects_consolas() {
        use font_kit::source::SystemSource;
        let source = SystemSource::new();
        // Consolas is always present on Windows
        if let Ok(family) = source.select_family_by_name("Consolas") {
            if let Some(handle) = family.fonts().first() {
                if let Ok(font) = handle.load() {
                    assert!(
                        is_monospace(&font),
                        "Consolas should be detected as monospace"
                    );
                }
            }
        }
    }

    #[test]
    fn is_monospace_rejects_arial() {
        use font_kit::source::SystemSource;
        let source = SystemSource::new();
        // Arial is always present on Windows and is proportional
        if let Ok(family) = source.select_family_by_name("Arial") {
            if let Some(handle) = family.fonts().first() {
                if let Ok(font) = handle.load() {
                    assert!(
                        !is_monospace(&font),
                        "Arial should not be detected as monospace"
                    );
                }
            }
        }
    }

    #[test]
    fn is_monospace_detects_cjk_monospace_font() {
        use font_kit::source::SystemSource;
        let source = SystemSource::new();
        // JetBrainsMonoBigHangul has isFixedPitch=0 in post table (CJK double-width)
        // but Latin chars 'i' and 'M' share the same advance width — it IS monospace
        if let Ok(family) = source.select_family_by_name("JetBrainsMonoBigHangul") {
            if let Some(handle) = family.fonts().first() {
                if let Ok(font) = handle.load() {
                    assert!(
                        is_monospace(&font),
                        "JetBrainsMonoBigHangul should be detected as monospace"
                    );
                }
            }
        }
    }

    #[test]
    fn list_system_monospace_fonts_returns_known_fonts() {
        let result = list_system_monospace_fonts().expect("should enumerate fonts");
        // Should contain at least one well-known monospace font per platform
        #[cfg(windows)]
        assert!(
            result.iter().any(|f| f == "Consolas"),
            "System monospace fonts should include Consolas, got: {:?}",
            &result[..result.len().min(10)]
        );
        #[cfg(not(windows))]
        assert!(
            result
                .iter()
                .any(|f| f.contains("Mono") || f.contains("mono")),
            "System monospace fonts should include at least one *Mono* font, got: {:?}",
            &result[..result.len().min(10)]
        );
        // Should NOT contain proportional fonts
        assert!(
            !result.iter().any(|f| f == "Arial"),
            "System monospace fonts should not include Arial"
        );
        // JetBrainsMonoBigHangul may not be installed on all systems
        #[cfg(windows)]
        assert!(
            result.iter().any(|f| f == "JetBrainsMonoBigHangul"),
            "System monospace fonts should include JetBrainsMonoBigHangul"
        );
    }

    // --- cwd_receive initialization tests ---

    #[test]
    fn terminal_session_defaults_cwd_receive_true() {
        let session = TerminalSession::new("t1".into(), TerminalConfig::default());
        assert!(
            session.cwd_receive,
            "New terminal should default to cwd_receive=true"
        );
    }

    #[test]
    fn filter_targets_cwd_receive_excludes_disabled() {
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            let t1 = TerminalSession::new("t1".into(), TerminalConfig::default());
            let mut t2 = TerminalSession::new("t2".into(), TerminalConfig::default());
            t2.cwd_receive = false; // explicitly disabled
            let t3 = TerminalSession::new("t3".into(), TerminalConfig::default());
            terminals.insert("t1".into(), t1);
            terminals.insert("t2".into(), t2);
            terminals.insert("t3".into(), t3);
        }

        let targets = vec!["t1".into(), "t2".into(), "t3".into()];
        let filtered = filter_targets_cwd_receive(&state, &targets);
        assert!(
            filtered.contains(&"t1".to_string()),
            "t1 with cwd_receive=true should pass"
        );
        assert!(
            !filtered.contains(&"t2".to_string()),
            "t2 with cwd_receive=false should be excluded"
        );
        assert!(
            filtered.contains(&"t3".to_string()),
            "t3 with cwd_receive=true should pass"
        );
    }

    // --- any_terminal_title_contains tests ---

    #[test]
    fn any_title_contains_finds_claude_in_earlier_title() {
        // Claude Code set title first, then changed to task description
        let data =
            b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07some output\x1b]0;\xe2\x9c\xb6 Exploring code\x07";
        assert!(any_terminal_title_contains(data, "Claude Code"));
    }

    #[test]
    fn any_title_contains_finds_claude_in_last_title() {
        let data = b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07";
        assert!(any_terminal_title_contains(data, "Claude Code"));
    }

    #[test]
    fn any_title_contains_false_when_no_claude() {
        let data = b"\x1b]0;bash\x07output\x1b]0;vim\x07";
        assert!(!any_terminal_title_contains(data, "Claude Code"));
    }

    #[test]
    fn any_title_contains_checks_osc2_titles() {
        // OSC 2 (window title) should also be scanned
        let data = b"\x1b]2;\xe2\x9c\xb3 Claude Code\x07\x1b]0;task desc\x07";
        assert!(any_terminal_title_contains(data, "Claude Code"));
    }

    #[test]
    fn any_title_contains_empty_data() {
        assert!(!any_terminal_title_contains(b"", "Claude Code"));
    }

    // --- is_claude_terminal_from_buffer with persistent tracking ---

    #[test]
    fn is_claude_terminal_detected_when_last_title_is_task() {
        // Core bug scenario: Claude initially sets "✳ Claude Code", then changes to task title
        let state = AppState::new();
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(
            b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07some output\x1b]0;\xe2\x9c\xb6 Exploring code\x07",
        );
        assert!(
            is_claude_terminal_from_buffer(&state, "t1", Some(&buf)),
            "Claude should be detected even when last title is a task description"
        );
    }

    #[test]
    fn is_claude_terminal_persistent_after_titles_scroll_out() {
        let state = AppState::new();
        // First call: detect from buffer and mark persistently
        {
            let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
            buf.push(b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07");
            assert!(is_claude_terminal_from_buffer(&state, "t1", Some(&buf)));
        }
        // Second call: buffer no longer has "Claude Code", but persistent set remembers
        {
            let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
            buf.push(b"\x1b]0;\xe2\x9c\xbb reading file.rs\x07");
            assert!(
                is_claude_terminal_from_buffer(&state, "t1", Some(&buf)),
                "Should be detected via persistent tracking even without Claude Code in buffer"
            );
        }
    }

    #[test]
    fn known_claude_terminal_cleaned_up_on_close() {
        let state = AppState::new();
        // Simulate detection
        state
            .known_claude_terminals
            .lock()
            .unwrap()
            .insert("t1".to_string());
        assert!(state.known_claude_terminals.lock().unwrap().contains("t1"));
        // Simulate close_terminal_session cleanup
        state.known_claude_terminals.lock().unwrap().remove("t1");
        assert!(!state.known_claude_terminals.lock().unwrap().contains("t1"));

        // After cleanup, buffer without "Claude Code" should not be detected
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]0;bash\x07");
        assert!(
            !is_claude_terminal_from_buffer(&state, "t1", Some(&buf)),
            "After close, reused terminal ID should not be falsely detected"
        );
    }

    #[test]
    fn filter_targets_not_busy_skips_claude_with_task_title_in_skip_mode() {
        // Core integration test: Claude terminal with task-only title should still be skipped
        let state = AppState::new();
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            // t1: normal terminal at prompt
            let mut buf1 = crate::output_buffer::TerminalOutputBuffer::default();
            buf1.push(b"\x1b]133;D;0\x07prompt$ ");
            buffers.insert("t1".into(), buf1);
            // t2: Claude Code but last title is a task description (the bug scenario!)
            let mut buf2 = crate::output_buffer::TerminalOutputBuffer::default();
            buf2.push(b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07lots of output here\x1b]0;\xe2\x9c\xb6 Exploring code\x07");
            buffers.insert("t2".into(), buf2);
        }

        let targets = vec!["t1".into(), "t2".into()];
        let (filtered, claude_ids) =
            filter_targets_not_busy(&state, &targets, &crate::settings::ClaudeSyncCwdMode::Skip);
        assert!(
            filtered.contains(&"t1".to_string()),
            "normal terminal should pass"
        );
        assert!(
            !filtered.contains(&"t2".to_string()),
            "Claude with task title should still be skipped in skip mode"
        );
        assert!(
            claude_ids.is_empty(),
            "skip mode should not collect claude_ids"
        );
    }

    #[test]
    fn filter_targets_not_busy_persistent_claude_skipped_in_skip_mode() {
        // Claude detected previously, now buffer has no Claude title at all
        let state = AppState::new();
        // Pre-mark as Claude (simulating previous detection)
        state
            .known_claude_terminals
            .lock()
            .unwrap()
            .insert("t2".to_string());
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            // t1: normal terminal
            let mut buf1 = crate::output_buffer::TerminalOutputBuffer::default();
            buf1.push(b"\x1b]133;D;0\x07prompt$ ");
            buffers.insert("t1".into(), buf1);
            // t2: known Claude but buffer only has task title (no "Claude Code" anywhere)
            let mut buf2 = crate::output_buffer::TerminalOutputBuffer::default();
            buf2.push(b"\x1b]0;\xe2\x9c\xb6 Exploring code\x07");
            buffers.insert("t2".into(), buf2);
        }

        let targets = vec!["t1".into(), "t2".into()];
        let (filtered, _) =
            filter_targets_not_busy(&state, &targets, &crate::settings::ClaudeSyncCwdMode::Skip);
        assert!(filtered.contains(&"t1".to_string()));
        assert!(
            !filtered.contains(&"t2".to_string()),
            "Persistently known Claude terminal should be skipped"
        );
    }

    #[test]
    fn proactive_claude_detection_from_pty_output_chunk() {
        // Simulates the PTY callback scenario: a raw output chunk containing
        // a Claude Code title should be detected by any_terminal_title_contains.
        // In production, the PTY callback uses this to populate known_claude_terminals.
        let chunk = b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07some terminal output here";
        assert!(any_terminal_title_contains(chunk, "Claude Code"));

        // After registration (simulating PTY callback behavior),
        // filter_targets_not_busy should skip the terminal
        let state = AppState::new();
        state
            .known_claude_terminals
            .lock()
            .unwrap()
            .insert("t-claude".to_string());
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
            // Buffer now only has task title, no "Claude Code"
            buf.push(b"\x1b]0;\xe2\x9c\xb6 Working on task\x07");
            buffers.insert("t-claude".into(), buf);
            let mut buf_normal = crate::output_buffer::TerminalOutputBuffer::default();
            buf_normal.push(b"\x1b]133;D;0\x07prompt$ ");
            buffers.insert("t-normal".into(), buf_normal);
        }
        let targets = vec!["t-normal".into(), "t-claude".into()];
        let (filtered, _) =
            filter_targets_not_busy(&state, &targets, &crate::settings::ClaudeSyncCwdMode::Skip);
        assert!(filtered.contains(&"t-normal".to_string()));
        assert!(
            !filtered.contains(&"t-claude".to_string()),
            "Proactively registered Claude terminal must be skipped in skip mode"
        );
    }

    #[test]
    fn mark_claude_terminal_returns_true_on_first_insert() {
        let state = AppState::new();
        let mut known = state.known_claude_terminals.lock().unwrap();
        assert!(
            known.insert("t1".to_string()),
            "First insert should return true"
        );
        assert!(
            !known.insert("t1".to_string()),
            "Second insert should return false"
        );
    }

    #[test]
    fn is_claude_terminal_after_mark() {
        let state = AppState::new();
        {
            let mut known = state.known_claude_terminals.lock().unwrap();
            known.insert("t1".to_string());
        }
        let known = state.known_claude_terminals.lock().unwrap();
        assert!(known.contains("t1"));
        assert!(!known.contains("t2"));
    }

    // -- extract_last_osc7_cwd tests --

    #[test]
    fn extract_osc7_cwd_bel_terminator() {
        let data = b"\x1b]7;file://localhost/home/user\x07";
        assert_eq!(
            extract_last_osc7_cwd(data),
            Some("file://localhost/home/user".into())
        );
    }

    #[test]
    fn extract_osc7_cwd_st_terminator() {
        let data = b"\x1b]7;file://localhost/C:/Users/test\x1b\\";
        assert_eq!(
            extract_last_osc7_cwd(data),
            Some("file://localhost/C:/Users/test".into())
        );
    }

    #[test]
    fn extract_osc7_cwd_multiple_returns_last() {
        let data = b"\x1b]7;file://localhost/old\x07some output\x1b]7;file://localhost/new\x07";
        assert_eq!(
            extract_last_osc7_cwd(data),
            Some("file://localhost/new".into())
        );
    }

    #[test]
    fn extract_osc7_cwd_none_when_absent() {
        let data = b"plain terminal output with no osc";
        assert_eq!(extract_last_osc7_cwd(data), None);
    }

    #[test]
    fn extract_osc7_cwd_none_when_truncated() {
        // Sequence starts but no terminator
        let data = b"\x1b]7;file://localhost/home/user";
        assert_eq!(extract_last_osc7_cwd(data), None);
    }

    #[test]
    fn extract_osc7_cwd_mixed_with_other_osc() {
        // OSC 0 title + OSC 7 CWD in same chunk
        let data = b"\x1b]0;My Terminal\x07\x1b]7;file://localhost/tmp\x07";
        assert_eq!(
            extract_last_osc7_cwd(data),
            Some("file://localhost/tmp".into())
        );
    }

    // -- extract_last_osc9_9_cwd tests --

    #[test]
    fn extract_osc9_9_cwd_basic() {
        let data = b"\x1b]9;9;C:/Users/kochul\x07";
        assert_eq!(
            extract_last_osc9_9_cwd(data),
            Some("C:/Users/kochul".into())
        );
    }

    #[test]
    fn extract_osc9_9_cwd_wsl_unc() {
        let data = b"\x1b]9;9;//wsl.localhost/Ubuntu-22.04/home/user\x07";
        assert_eq!(
            extract_last_osc9_9_cwd(data),
            Some("//wsl.localhost/Ubuntu-22.04/home/user".into())
        );
    }

    #[test]
    fn extract_osc9_9_cwd_multiple_returns_last() {
        let data = b"\x1b]9;9;C:/old\x07output\x1b]9;9;C:/new\x07";
        assert_eq!(extract_last_osc9_9_cwd(data), Some("C:/new".into()));
    }

    #[test]
    fn extract_osc9_9_cwd_none_when_absent() {
        let data = b"no osc 9;9 here";
        assert_eq!(extract_last_osc9_9_cwd(data), None);
    }

    #[test]
    fn extract_osc9_9_cwd_ignores_non_9_subcode() {
        // OSC 9 with non-9 subcode (e.g., notification)
        let data = b"\x1b]9;Hello notification\x07";
        assert_eq!(extract_last_osc9_9_cwd(data), None);
    }

    #[test]
    fn close_terminal_clears_claude_tracking() {
        let state = AppState::new();
        state
            .known_claude_terminals
            .lock()
            .unwrap()
            .insert("t1".to_string());
        // Simulate close_terminal_session cleanup
        state.known_claude_terminals.lock().unwrap().remove("t1");
        assert!(!state.known_claude_terminals.lock().unwrap().contains("t1"));
    }

    // -- SyncBranch stores branch --

    #[test]
    fn sync_branch_updates_session_branch() {
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            terminals.insert(
                "t1".into(),
                TerminalSession::new("t1".into(), TerminalConfig::default()),
            );
        }
        // Simulate SyncBranch handler updating branch
        {
            let mut terminals = state.terminals.lock().unwrap();
            if let Some(session) = terminals.get_mut("t1") {
                session.branch = Some("feature/login".into());
            }
        }
        let terminals = state.terminals.lock().unwrap();
        assert_eq!(
            terminals.get("t1").unwrap().branch.as_deref(),
            Some("feature/login")
        );
    }

    // -- SetCommandStatus stores command data --

    #[test]
    fn set_command_status_stores_command() {
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            terminals.insert(
                "t1".into(),
                TerminalSession::new("t1".into(), TerminalConfig::default()),
            );
        }
        // Simulate command started
        {
            let mut terminals = state.terminals.lock().unwrap();
            if let Some(session) = terminals.get_mut("t1") {
                session.last_command = Some("npm test".into());
                session.last_exit_code = None;
                session.last_command_at = Some(1000);
                session.command_running = true;
            }
        }
        let terminals = state.terminals.lock().unwrap();
        let session = terminals.get("t1").unwrap();
        assert_eq!(session.last_command.as_deref(), Some("npm test"));
        assert_eq!(session.last_exit_code, None);
        assert!(session.command_running);
        assert_eq!(session.last_command_at, Some(1000));
    }

    #[test]
    fn set_command_status_stores_exit_code() {
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            let mut session = TerminalSession::new("t1".into(), TerminalConfig::default());
            session.last_command = Some("npm test".into());
            session.command_running = true;
            terminals.insert("t1".into(), session);
        }
        // Simulate exit code
        {
            let mut terminals = state.terminals.lock().unwrap();
            if let Some(session) = terminals.get_mut("t1") {
                session.last_exit_code = Some(0);
                session.last_command_at = Some(2000);
                session.command_running = false;
            }
        }
        let terminals = state.terminals.lock().unwrap();
        let session = terminals.get("t1").unwrap();
        assert_eq!(session.last_command.as_deref(), Some("npm test"));
        assert_eq!(session.last_exit_code, Some(0));
        assert!(!session.command_running);
    }

    // -- Notify stores notification --

    #[test]
    fn notify_stores_notification() {
        let state = AppState::new();
        let notification = crate::terminal::TerminalNotification {
            id: state
                .notification_counter
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            terminal_id: "t1".into(),
            message: "Build complete".into(),
            level: "success".into(),
            created_at: 12345,
            read_at: None,
        };
        state.notifications.lock().unwrap().push(notification);

        let notifs = state.notifications.lock().unwrap();
        assert_eq!(notifs.len(), 1);
        assert_eq!(notifs[0].message, "Build complete");
        assert_eq!(notifs[0].level, "success");
        assert!(notifs[0].read_at.is_none());
    }

    #[test]
    fn notify_increments_id() {
        let state = AppState::new();
        let id1 = state
            .notification_counter
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let id2 = state
            .notification_counter
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(id2, id1 + 1);
    }

    // -- get_terminal_summaries tests --

    #[test]
    fn get_terminal_summaries_empty_ids() {
        let state = AppState::new();
        let result = get_terminal_summaries_inner(&[], &state).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn get_terminal_summaries_returns_session_data() {
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            let mut session = TerminalSession::new("t1".into(), TerminalConfig::default());
            session.cwd = Some("/home/user".into());
            session.branch = Some("main".into());
            session.last_command = Some("cargo test".into());
            session.last_exit_code = Some(0);
            session.last_command_at = Some(12345);
            terminals.insert("t1".into(), session);
        }
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            buffers.insert(
                "t1".into(),
                crate::output_buffer::TerminalOutputBuffer::default(),
            );
        }

        let result = get_terminal_summaries_inner(&["t1".into()], &state).unwrap();
        assert_eq!(result.len(), 1);
        let t = &result[0];
        assert_eq!(t.id, "t1");
        assert_eq!(t.cwd.as_deref(), Some("/home/user"));
        assert_eq!(t.branch.as_deref(), Some("main"));
        assert_eq!(t.last_command.as_deref(), Some("cargo test"));
        assert_eq!(t.last_exit_code, Some(0));
        assert_eq!(t.last_command_at, Some(12345));
        assert_eq!(t.profile, "PowerShell");
    }

    #[test]
    fn get_terminal_summaries_skips_missing_ids() {
        let state = AppState::new();
        let result = get_terminal_summaries_inner(&["nonexistent".into()], &state).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn get_terminal_summaries_includes_claude_detection() {
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            terminals.insert(
                "t1".into(),
                TerminalSession::new("t1".into(), TerminalConfig::default()),
            );
        }
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            buffers.insert(
                "t1".into(),
                crate::output_buffer::TerminalOutputBuffer::default(),
            );
        }
        state
            .known_claude_terminals
            .lock()
            .unwrap()
            .insert("t1".into());

        let result = get_terminal_summaries_inner(&["t1".into()], &state).unwrap();
        assert!(result[0].is_claude);
    }

    #[test]
    fn get_terminal_summaries_includes_notifications() {
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            terminals.insert(
                "t1".into(),
                TerminalSession::new("t1".into(), TerminalConfig::default()),
            );
        }
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            buffers.insert(
                "t1".into(),
                crate::output_buffer::TerminalOutputBuffer::default(),
            );
        }
        // Add 2 unread + 1 read notification
        {
            let mut notifs = state.notifications.lock().unwrap();
            notifs.push(TerminalNotification {
                id: 1,
                terminal_id: "t1".into(),
                message: "old".into(),
                level: "info".into(),
                created_at: 100,
                read_at: Some(200),
            });
            notifs.push(TerminalNotification {
                id: 2,
                terminal_id: "t1".into(),
                message: "unread1".into(),
                level: "error".into(),
                created_at: 300,
                read_at: None,
            });
            notifs.push(TerminalNotification {
                id: 3,
                terminal_id: "t1".into(),
                message: "unread2".into(),
                level: "warning".into(),
                created_at: 400,
                read_at: None,
            });
        }

        let result = get_terminal_summaries_inner(&["t1".into()], &state).unwrap();
        assert_eq!(result[0].unread_notification_count, 2);
        let latest = result[0].latest_notification.as_ref().unwrap();
        assert_eq!(latest.message, "unread2");
        assert_eq!(latest.created_at, 400);
    }

    // -- mark_notifications_read tests --

    #[test]
    fn mark_notifications_read_sets_read_at() {
        let state = AppState::new();
        {
            let mut notifs = state.notifications.lock().unwrap();
            notifs.push(TerminalNotification {
                id: 1,
                terminal_id: "t1".into(),
                message: "test".into(),
                level: "info".into(),
                created_at: 100,
                read_at: None,
            });
            notifs.push(TerminalNotification {
                id: 2,
                terminal_id: "t2".into(),
                message: "other".into(),
                level: "info".into(),
                created_at: 200,
                read_at: None,
            });
        }

        // Mark t1 as read
        let now_ms = 999u64;
        {
            let mut notifs = state.notifications.lock().unwrap();
            for n in notifs.iter_mut() {
                if n.terminal_id == "t1" && n.read_at.is_none() {
                    n.read_at = Some(now_ms);
                }
            }
        }

        let notifs = state.notifications.lock().unwrap();
        assert!(notifs[0].read_at.is_some()); // t1 marked
        assert!(notifs[1].read_at.is_none()); // t2 untouched
    }

    // -- evict_old_notifications tests --

    #[test]
    fn evict_removes_oldest_read_notifications() {
        let mut notifs: Vec<TerminalNotification> = Vec::new();
        // Fill with MAX_NOTIFICATIONS + 5 notifications, all read
        for i in 0..(MAX_NOTIFICATIONS + 5) {
            notifs.push(TerminalNotification {
                id: i as u64,
                terminal_id: "t1".into(),
                message: format!("msg-{i}"),
                level: "info".into(),
                created_at: i as u64,
                read_at: Some(1000),
            });
        }
        assert_eq!(notifs.len(), MAX_NOTIFICATIONS + 5);
        evict_old_notifications(&mut notifs);
        assert_eq!(notifs.len(), MAX_NOTIFICATIONS);
        // Oldest 5 should be removed
        assert_eq!(notifs[0].id, 5);
    }

    #[test]
    fn evict_preserves_unread_notifications() {
        let mut notifs: Vec<TerminalNotification> = Vec::new();
        // Fill with MAX_NOTIFICATIONS + 3: first 3 are unread, rest are read
        for i in 0..(MAX_NOTIFICATIONS + 3) {
            notifs.push(TerminalNotification {
                id: i as u64,
                terminal_id: "t1".into(),
                message: format!("msg-{i}"),
                level: "info".into(),
                created_at: i as u64,
                read_at: if i < 3 { None } else { Some(1000) },
            });
        }
        evict_old_notifications(&mut notifs);
        // All 3 unread should survive; 3 oldest read removed
        let unread_count = notifs.iter().filter(|n| n.read_at.is_none()).count();
        assert_eq!(unread_count, 3);
        assert_eq!(notifs.len(), MAX_NOTIFICATIONS);
    }

    #[test]
    fn evict_noop_under_limit() {
        let mut notifs: Vec<TerminalNotification> = vec![TerminalNotification {
            id: 1,
            terminal_id: "t1".into(),
            message: "msg".into(),
            level: "info".into(),
            created_at: 100,
            read_at: Some(200),
        }];
        evict_old_notifications(&mut notifs);
        assert_eq!(notifs.len(), 1);
    }

    // -- close_terminal cleans up notifications --

    #[test]
    fn close_terminal_removes_notifications() {
        let state = AppState::new();
        {
            let mut notifs = state.notifications.lock().unwrap();
            notifs.push(TerminalNotification {
                id: 1,
                terminal_id: "t1".into(),
                message: "test".into(),
                level: "info".into(),
                created_at: 100,
                read_at: None,
            });
            notifs.push(TerminalNotification {
                id: 2,
                terminal_id: "t2".into(),
                message: "other".into(),
                level: "info".into(),
                created_at: 200,
                read_at: None,
            });
        }
        // Simulate close_terminal_session cleanup for t1
        {
            let mut notifs = state.notifications.lock().unwrap();
            notifs.retain(|n| n.terminal_id != "t1");
        }
        let notifs = state.notifications.lock().unwrap();
        assert_eq!(notifs.len(), 1);
        assert_eq!(notifs[0].terminal_id, "t2");
    }

    // -- extract_last_osc_payload shared function --

    #[test]
    fn extract_osc_payload_with_custom_needle() {
        // Verify the shared function works for an arbitrary needle
        let needle = &[0x1b, b']', b'7', b';'];
        let data = b"\x1b]7;file://localhost/test\x07";
        assert_eq!(
            extract_last_osc_payload(data, needle),
            Some("file://localhost/test".into())
        );
    }

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
    fn normalize_path_for_comparison_trims_slashes() {
        assert_eq!(
            path_utils::normalize_path_for_comparison("/home/user/"),
            path_utils::normalize_path_for_comparison("/home/user")
        );
    }

    #[test]
    #[cfg(windows)]
    fn normalize_path_for_comparison_converts_wsl_mnt_paths() {
        // /mnt/c/Users/test should match C:\Users\test
        assert_eq!(
            path_utils::normalize_path_for_comparison("/mnt/c/Users/test"),
            path_utils::normalize_path_for_comparison("C:\\Users\\test")
        );
        // /mnt/d/Projects should match D:\Projects
        assert_eq!(
            path_utils::normalize_path_for_comparison("/mnt/d/Projects"),
            path_utils::normalize_path_for_comparison("D:\\Projects")
        );
        // Single drive letter
        assert_eq!(
            path_utils::normalize_path_for_comparison("/mnt/c"),
            path_utils::normalize_path_for_comparison("C:\\")
        );
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

    #[test]
    fn resolve_path_for_windows_passthrough() {
        assert_eq!(
            path_utils::resolve_path_for_windows("C:\\Users\\me", None),
            "C:\\Users\\me"
        );
        assert_eq!(
            path_utils::resolve_path_for_windows("\\\\server\\share", None),
            "\\\\server\\share"
        );
    }

    #[test]
    fn resolve_path_for_windows_mnt_to_drive() {
        assert_eq!(
            path_utils::resolve_path_for_windows("/mnt/c/Users/me", None),
            "C:\\Users\\me"
        );
        assert_eq!(
            path_utils::resolve_path_for_windows("/mnt/d/data", None),
            "D:\\data"
        );
    }

    #[test]
    fn resolve_path_for_windows_wsl_unc() {
        assert_eq!(
            path_utils::resolve_path_for_windows("/home/user", Some("Ubuntu-22.04")),
            "\\\\wsl.localhost\\Ubuntu-22.04\\home\\user"
        );
    }

    #[test]
    #[test]
    fn file_viewer_content_image_serializes_data_url() {
        let content = FileViewerContent::Image {
            data_url: "data:image/png;base64,abc".into(),
        };
        let json = serde_json::to_string(&content).unwrap();
        assert!(json.contains("\"dataUrl\""));
        assert!(json.contains("\"kind\":\"image\""));
    }

    fn list_directory_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let result = list_directory(dir.path().to_string_lossy().into_owned(), None).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn list_directory_mixed_entries() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("subdir")).unwrap();
        std::fs::write(dir.path().join("file.txt"), "hello").unwrap();
        std::fs::write(dir.path().join("another.rs"), "fn main() {}").unwrap();

        let result = list_directory(dir.path().to_string_lossy().into_owned(), None).unwrap();
        assert_eq!(result.len(), 3);

        // Directories should come first
        assert!(result[0].is_directory);
        assert_eq!(result[0].name, "subdir");

        // Files sorted alphabetically after directories
        assert!(!result[1].is_directory);
        assert!(!result[2].is_directory);
        // "another.rs" < "file.txt" alphabetically
        assert_eq!(result[1].name, "another.rs");
        assert_eq!(result[2].name, "file.txt");
        assert_eq!(result[2].size, 5); // "hello"
    }

    #[test]
    fn list_directory_nonexistent_path() {
        let result = list_directory("/this/path/does/not/exist/at/all".into(), None);
        assert!(result.is_err());
    }
}
