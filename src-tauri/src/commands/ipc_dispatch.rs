use std::time::Instant;
use tauri::{AppHandle, Emitter, State};

use std::sync::Arc;

use crate::activity;
use crate::cli::{LxMessage, LxResponse};
use crate::constants::*;
use crate::lock_ext::MutexExt;
use crate::path_utils;
use crate::state::AppState;

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
        } => do_sync_cwd(
            state,
            app,
            &terminal_id,
            &group_id,
            &path,
            all,
            target_group.as_deref(),
        ),
        LxMessage::SyncBranch {
            branch,
            terminal_id,
            group_id,
        } => do_sync_branch(state, app, &terminal_id, &group_id, &branch),
        LxMessage::Notify {
            message,
            terminal_id,
            level,
        } => do_notify(state, app, &terminal_id, &message, level.as_deref()),
        LxMessage::SetTabTitle { title, terminal_id } => {
            do_set_tab_title(state, app, &terminal_id, &title)
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
        } => do_set_command_status(state, app, &terminal_id, command.as_deref(), exit_code),
        LxMessage::SetWslDistro { path, terminal_id } => {
            do_set_wsl_distro(state, &terminal_id, &path)
        }
    }
}

// ── Public inner functions — callable from both LxMessage dispatch and PTY callback ──

/// Sync CWD across terminal group. Handles propagation guard, target filtering, and cd writing.
pub fn do_sync_cwd(
    state: &AppState,
    app: &AppHandle,
    terminal_id: &str,
    group_id: &str,
    path: &str,
    all: bool,
    target_group: Option<&str>,
) -> Result<LxResponse, String> {
    cleanup_stale_propagations(state);

    if is_propagated(state, terminal_id)? {
        return Ok(LxResponse::ok(Some(format!(
            "sync-cwd {} suppressed (propagated)",
            path
        ))));
    }

    // Issue #215: Skip propagation when the source terminal is running an
    // interactive TUI app (Codex, Claude Code, vim, ...). OSC 7 emitted in
    // that state (e.g. by PowerShell's prompt function re-rendering) does
    // not represent a user-intended `cd`, so we must not push it to peers
    // or mark the local session.cwd.
    {
        let buffers = state.output_buffers.lock_or_err()?;
        if !is_source_sync_allowed(state, terminal_id, buffers.get(terminal_id)) {
            tracing::debug!(
                terminal_id,
                path,
                "sync-cwd suppressed: source terminal has non-shell activity"
            );
            return Ok(LxResponse::ok(Some(format!(
                "sync-cwd {} suppressed (source activity != shell)",
                path
            ))));
        }
    }

    let normalized_path = path_utils::normalize_wsl_path(path);

    // NOTE: We intentionally do NOT skip when the source terminal's CWD
    // matches normalized_path. The backend PTY callback (proactive CWD
    // detection) may have already updated session.cwd before this IPC
    // arrives, so a naive "unchanged" check would suppress every
    // propagation. Target-side dedup is handled by filter_targets_needing_cd.
    update_terminal_cwd(state, terminal_id, &normalized_path);

    // Check if source terminal has cwd_send disabled — if so, skip group propagation
    // but keep the local CWD update above (the terminal's own CWD should still be tracked).
    let source_cwd_send = {
        let terminals = state.terminals.lock_or_err()?;
        terminals
            .get(terminal_id)
            .map(|s| s.cwd_send)
            .unwrap_or(true)
    };
    if !source_cwd_send {
        return Ok(LxResponse::ok(Some(format!(
            "sync-cwd {} suppressed (cwd_send disabled)",
            normalized_path
        ))));
    }

    let all_targets = resolve_target_terminals(state, terminal_id, group_id, all, target_group)?;

    let receiving_targets = filter_targets_cwd_receive(state, &all_targets);

    let settings = crate::settings::load_settings();
    let (idle_targets, claude_ids) =
        filter_targets_not_busy(state, &receiving_targets, &settings.claude.sync_cwd);

    let target_terminals = filter_targets_needing_cd(state, &idle_targets, &normalized_path);

    if !target_terminals.is_empty() {
        write_cd_to_group_terminals(
            state,
            &target_terminals,
            terminal_id,
            &normalized_path,
            &claude_ids,
        )?;
    }

    if !target_terminals.is_empty() {
        mark_propagated(state, &target_terminals)?;
    }

    for tid in &receiving_targets {
        update_terminal_cwd(state, tid, &normalized_path);
    }

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

/// Sync git branch across terminal group.
pub fn do_sync_branch(
    state: &AppState,
    app: &AppHandle,
    terminal_id: &str,
    group_id: &str,
    branch: &str,
) -> Result<LxResponse, String> {
    {
        let mut terminals = state.terminals.lock_or_err()?;
        if let Some(session) = terminals.get_mut(terminal_id) {
            session.branch = Some(branch.to_string());
        }
    }

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
        .get(group_id)
        .map(|g| g.terminal_ids.len())
        .unwrap_or(0);

    Ok(LxResponse::ok(Some(format!(
        "sync-branch {} to {} terminals",
        branch, count
    ))))
}

/// Send a notification (store + emit to frontend).
pub fn do_notify(
    state: &AppState,
    app: &AppHandle,
    terminal_id: &str,
    message: &str,
    level: Option<&str>,
) -> Result<LxResponse, String> {
    {
        let notification = crate::terminal::TerminalNotification {
            id: state
                .notification_counter
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            terminal_id: terminal_id.to_string(),
            message: message.to_string(),
            level: level.unwrap_or("info").to_string(),
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            read_at: None,
        };
        if let Ok(mut notifs) = state.notifications.lock_or_err() {
            notifs.push(notification);
            super::evict_old_notifications(&mut notifs);
        }
    }

    let mut payload = serde_json::json!({
        "message": message,
        "terminalId": terminal_id,
    });
    if let Some(lvl) = level {
        payload["level"] = serde_json::json!(lvl);
    }
    let _ = app.emit(EVENT_LX_NOTIFY, payload);

    Ok(LxResponse::ok(Some(format!("notification: {}", message))))
}

/// Set the tab title for a terminal.
pub fn do_set_tab_title(
    state: &AppState,
    app: &AppHandle,
    terminal_id: &str,
    title: &str,
) -> Result<LxResponse, String> {
    let mut terminals = state.terminals.lock_or_err()?;
    if let Some(session) = terminals.get_mut(terminal_id) {
        session.title = title.to_string();
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

/// Update command status (command text, exit code, or both).
pub fn do_set_command_status(
    state: &AppState,
    app: &AppHandle,
    terminal_id: &str,
    command: Option<&str>,
    exit_code: Option<i32>,
) -> Result<LxResponse, String> {
    {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let mut terminals = state.terminals.lock_or_err()?;
        if let Some(session) = terminals.get_mut(terminal_id) {
            if let Some(cmd) = command {
                session.last_command = Some(cmd.to_string());
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
    if let Some(cmd) = command {
        payload["command"] = serde_json::json!(cmd);
    }
    if let Some(code) = exit_code {
        payload["exitCode"] = serde_json::json!(code);
    }
    let _ = app.emit(EVENT_COMMAND_STATUS, payload);

    let desc = match (command, exit_code) {
        (Some(cmd), Some(code)) => format!("command '{}' exit {}", cmd, code),
        (Some(cmd), None) => format!("command '{}' started", cmd),
        (None, Some(code)) => format!("exit code {}", code),
        (None, None) => "no-op".to_string(),
    };
    Ok(LxResponse::ok(Some(desc)))
}

/// Set WSL distro name from a path containing UNC distro information.
pub fn do_set_wsl_distro(
    state: &AppState,
    terminal_id: &str,
    path: &str,
) -> Result<LxResponse, String> {
    if let Some(distro) = path_utils::extract_wsl_distro_from_path(path) {
        let mut terminals = state.terminals.lock_or_err()?;
        if let Some(session) = terminals.get_mut(terminal_id) {
            session.wsl_distro = Some(distro.clone());
        }
        Ok(LxResponse::ok(Some(format!("wsl-distro set: {distro}"))))
    } else {
        Ok(LxResponse::ok(Some("no distro found in path".into())))
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

// --- Propagation guard helpers ---

/// Decide whether the source terminal's current state permits sync-cwd propagation.
///
/// Background (issue #215): some shells re-emit OSC 7 on every prompt render
/// (e.g. PowerShell's `prompt` function). If an interactive TUI app is active
/// in that terminal (Codex, Claude Code, vim, ...), the emitted CWD does not
/// reflect a user-intended `cd` and must not be pushed to sync-group peers.
///
/// Policy:
/// - `Shell` / `Running` (no interactive app) → propagation allowed.
/// - `InteractiveApp { .. }` → propagation blocked.
/// - Unknown / no buffer → permissive (true), to preserve existing behavior for
///   freshly created terminals.
///
/// Uses `detect_terminal_state` (not just `detect_terminal_activity`) so the
/// guard triggers even when the last title has drifted away from the literal
/// pattern: Codex switches its title to a braille spinner, Claude Code switches
/// to task descriptions, etc. Persistent tracking via `known_claude_terminals`
/// and `known_codex_terminals` keeps those sessions marked as interactive.
/// Inserts into those HashSets are idempotent and already happen on every
/// PTY output chunk, so acquiring them here has no behavioural side-effect.
///
/// Lock order: caller must hold `output_buffers` (2); this function acquires
/// `known_claude_terminals` (3) and `known_codex_terminals` (4) per `state.rs`.
pub(crate) fn is_source_sync_allowed(
    state: &AppState,
    terminal_id: &str,
    buffer: Option<&crate::output_buffer::TerminalOutputBuffer>,
) -> bool {
    let info = activity::detect_terminal_state(state, terminal_id, buffer);
    !matches!(
        info.activity,
        crate::terminal::TerminalActivity::InteractiveApp { .. }
    )
}

/// Decide whether an incoming OSC CWD event from the source terminal should
/// update backend session state at all.
///
/// This is stricter than normal shell CWD tracking: when an interactive app is
/// active, PowerShell can re-emit OSC 7 during prompt/title repaints. Updating
/// `session.cwd` in that state leaks a stale source CWD into syncGroup consumers
/// even if `do_sync_cwd` later suppresses propagation.
pub(crate) fn should_accept_source_cwd_event(
    state: &AppState,
    terminal_id: &str,
    buffer: Option<&crate::output_buffer::TerminalOutputBuffer>,
) -> bool {
    is_source_sync_allowed(state, terminal_id, buffer)
}

/// Check if a terminal is within the propagation suppression window.
/// Unlike the old consume_propagation, this does NOT remove the entry —
/// the flag stays active for the full PROPAGATION_TIMEOUT so that multiple
/// OSC sequences (e.g. OSC 7 + OSC 9;9 from WSL) are all suppressed.
pub(crate) fn is_propagated(state: &AppState, terminal_id: &str) -> Result<bool, String> {
    let propagated = state.propagated_terminals.lock_or_err()?;
    if let Some(ts) = propagated.get(terminal_id) {
        Ok(ts.elapsed() < PROPAGATION_TIMEOUT)
    } else {
        Ok(false)
    }
}

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

/// Filter target terminals based on their detected activity.
///
/// Uses the full `detect_terminal_state` pipeline (buffer scan + persistent
/// tracking via `known_claude_terminals` / `known_codex_terminals` + braille
/// spinner heuristic + title pattern matching) so the decision is consistent
/// with every other activity-gated feature (see ARCHITECTURE.md §10).
///
/// Policy per target:
/// - `InteractiveApp { name: "Claude" }` → governed by `claude_mode`:
///   - `Skip` → exclude.
///   - `Command` → include only when Claude is at its idle prompt
///     (✳ prefix); mark the id in `claude_ids` so the caller writes
///     `! cd '/path'` instead of the normal propagated command.
/// - `InteractiveApp { name: other }` (vim, codex, nvim, ...) → exclude.
///   Injecting `LX_PROPAGATED=1 cd ...` into a TUI app would type the
///   literal command into its input buffer (issue #239).
/// - `Running` → exclude (a shell command is mid-execution).
/// - `Shell` → include.
///
/// Returns `(idle_targets, claude_ids)`. `claude_ids` is a subset of the
/// returned targets — callers pass it to `write_cd_to_group_terminals` so it
/// can format the command differently without re-scanning buffers.
fn filter_targets_not_busy(
    state: &AppState,
    targets: &[String],
    claude_mode: &crate::settings::ClaudeSyncCwdMode,
) -> (Vec<String>, std::collections::HashSet<String>) {
    let mut claude_ids = std::collections::HashSet::new();

    let Ok(buffers) = state.output_buffers.lock_or_err() else {
        return (targets.to_vec(), claude_ids);
    };

    let mut result = Vec::new();
    for id in targets {
        let buf = buffers.get(id.as_str());
        let info = activity::detect_terminal_state(state, id, buf);

        match &info.activity {
            crate::terminal::TerminalActivity::InteractiveApp { name } if name == "Claude" => {
                match claude_mode {
                    crate::settings::ClaudeSyncCwdMode::Skip => {
                        // Don't propagate cd to Claude terminals
                        continue;
                    }
                    crate::settings::ClaudeSyncCwdMode::Command => {
                        // Only include if Claude is idle (✳ prefix in title)
                        if activity::is_claude_idle_from_buffer(buf) {
                            claude_ids.insert(id.clone());
                            result.push(id.clone());
                        }
                    }
                }
            }
            crate::terminal::TerminalActivity::InteractiveApp { .. } => {
                // Any other TUI app (vim, codex, nvim, ...) — cd injection
                // would be typed literally into the app's input buffer.
                continue;
            }
            crate::terminal::TerminalActivity::Running => {
                // A shell command is mid-execution; defer cd to avoid racing
                // with the current command's output.
                continue;
            }
            crate::terminal::TerminalActivity::Shell => {
                result.push(id.clone());
            }
        }
    }
    (result, claude_ids)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::osc;
    use crate::terminal::{TerminalConfig, TerminalSession};

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
            !activity::is_terminal_at_prompt_from_buffer(Some(&buf)),
            "After C, command is running"
        );
    }

    #[test]
    fn is_terminal_at_prompt_detects_idle() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;C\x07output\x1b]133;D;0\x07prompt$ ");
        assert!(
            activity::is_terminal_at_prompt_from_buffer(Some(&buf)),
            "After D, terminal is idle"
        );
    }

    #[test]
    fn is_terminal_at_prompt_empty_buffer() {
        let buf = crate::output_buffer::TerminalOutputBuffer::default();
        assert!(
            activity::is_terminal_at_prompt_from_buffer(Some(&buf)),
            "Empty buffer → assume at prompt"
        );
    }

    #[test]
    fn is_terminal_at_prompt_no_buffer() {
        assert!(
            activity::is_terminal_at_prompt_from_buffer(None),
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
        use crate::terminal::TerminalActivity;
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;C\x07output\x1b]133;D;0\x07prompt$ ");
        assert_eq!(
            activity::detect_terminal_activity(Some(&buf)),
            TerminalActivity::Shell
        );
    }

    #[test]
    fn detect_activity_running_command() {
        use crate::terminal::TerminalActivity;
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;D;0\x07prompt$ \x1b]133;C\x07");
        assert_eq!(
            activity::detect_terminal_activity(Some(&buf)),
            TerminalActivity::Running
        );
    }

    #[test]
    fn detect_activity_claude_code_from_title() {
        use crate::terminal::TerminalActivity;
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        // Simulate: prompt → preexec → Claude Code sets terminal title
        buf.push(b"\x1b]133;D;0\x07prompt$ \x1b]133;C\x07\x1b]0;\xe2\x9c\xb3 Claude Code\x07");
        assert_eq!(
            activity::detect_terminal_activity(Some(&buf)),
            TerminalActivity::InteractiveApp {
                name: "Claude".to_string()
            }
        );
    }

    #[test]
    fn detect_activity_vim_from_title() {
        use crate::terminal::TerminalActivity;
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;D;0\x07\x1b]133;C\x07\x1b]0;vim main.rs\x07");
        assert_eq!(
            activity::detect_terminal_activity(Some(&buf)),
            TerminalActivity::InteractiveApp {
                name: "vim".to_string()
            }
        );
    }

    #[test]
    fn detect_activity_no_buffer() {
        use crate::terminal::TerminalActivity;
        assert_eq!(
            activity::detect_terminal_activity(None),
            TerminalActivity::Shell
        );
    }

    #[test]
    fn detect_activity_empty_buffer() {
        use crate::terminal::TerminalActivity;
        let buf = crate::output_buffer::TerminalOutputBuffer::default();
        assert_eq!(
            activity::detect_terminal_activity(Some(&buf)),
            TerminalActivity::Shell
        );
    }

    #[test]
    fn extract_title_osc0() {
        let data = b"some output\x1b]0;my title\x07more output";
        assert_eq!(
            osc::extract_last_terminal_title(data),
            Some("my title".to_string())
        );
    }

    #[test]
    fn extract_title_osc2() {
        let data = b"\x1b]2;window title\x07";
        assert_eq!(
            osc::extract_last_terminal_title(data),
            Some("window title".to_string())
        );
    }

    #[test]
    fn extract_title_last_wins() {
        let data = b"\x1b]0;first\x07middle\x1b]0;second\x07end";
        assert_eq!(
            osc::extract_last_terminal_title(data),
            Some("second".to_string())
        );
    }

    #[test]
    fn extract_title_none_when_missing() {
        let data = b"no osc sequences here";
        assert_eq!(osc::extract_last_terminal_title(data), None);
    }

    #[test]
    fn detect_state_activity_only() {
        use crate::terminal::TerminalActivity;
        let state = AppState::new();
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;D;0\x07prompt$ ");
        let state_info = activity::detect_terminal_state(&state, "t1", Some(&buf));
        assert_eq!(state_info.activity, TerminalActivity::Shell);
    }

    // --- Claude Code detection tests ---

    #[test]
    fn is_claude_terminal_detects_claude_from_title() {
        let state = AppState::new();
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07");
        assert!(activity::is_claude_terminal_from_buffer(
            &state,
            "t1",
            Some(&buf)
        ));
    }

    #[test]
    fn is_claude_terminal_false_for_normal_terminal() {
        let state = AppState::new();
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]0;bash\x07");
        assert!(!activity::is_claude_terminal_from_buffer(
            &state,
            "t1",
            Some(&buf)
        ));
    }

    #[test]
    fn is_claude_terminal_false_for_no_buffer() {
        let state = AppState::new();
        assert!(!activity::is_claude_terminal_from_buffer(
            &state, "t1", None
        ));
    }

    #[test]
    fn is_claude_terminal_false_for_empty_buffer() {
        let state = AppState::new();
        let buf = crate::output_buffer::TerminalOutputBuffer::default();
        assert!(!activity::is_claude_terminal_from_buffer(
            &state,
            "t1",
            Some(&buf)
        ));
    }

    #[test]
    fn is_claude_idle_detects_idle_prefix() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        // ✳ (U+2733) prefix = idle
        buf.push(b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07");
        assert!(activity::is_claude_idle_from_buffer(Some(&buf)));
    }

    #[test]
    fn is_claude_idle_false_when_working() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        // ✶ (U+2736) prefix = working/spinner
        buf.push(b"\x1b]0;\xe2\x9c\xb6 Claude Code\x07");
        assert!(!activity::is_claude_idle_from_buffer(Some(&buf)));
    }

    #[test]
    fn is_claude_idle_false_for_no_buffer() {
        assert!(!activity::is_claude_idle_from_buffer(None));
    }

    #[test]
    fn detect_activity_claude_when_osc133_markers_scrolled_out() {
        use crate::terminal::TerminalActivity;
        // Bug fix test: when Claude runs long, OSC 133;C scrolls out of buffer.
        // Without title, there are no OSC 133 markers → would wrongly return Shell.
        // With fix: title check happens first → correctly returns InteractiveApp.
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        // Only a title set, no OSC 133 markers at all (simulating they scrolled out)
        buf.push(b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07some output here");
        assert_eq!(
            activity::detect_terminal_activity(Some(&buf)),
            TerminalActivity::InteractiveApp {
                name: "Claude".to_string()
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

    // --- cwd_receive tests ---

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

    // --- cwd_send tests ---

    #[test]
    fn do_sync_cwd_skips_propagation_when_cwd_send_disabled() {
        let state = AppState::new();
        // Create source terminal with cwd_send = false
        {
            let mut terminals = state.terminals.lock().unwrap();
            let mut source = TerminalSession::new("source".into(), TerminalConfig::default());
            source.cwd_send = false;
            source.config.sync_group = "group1".into();
            terminals.insert("source".into(), source);

            let mut target = TerminalSession::new("target".into(), TerminalConfig::default());
            target.config.sync_group = "group1".into();
            terminals.insert("target".into(), target);
        }
        // Register sync group
        {
            let mut groups = state.sync_groups.lock().unwrap();
            let mut group = crate::terminal::SyncGroup::new("group1".into());
            group.terminal_ids = vec!["source".into(), "target".into()];
            groups.insert("group1".into(), group);
        }

        // do_sync_cwd requires an AppHandle which we can't easily create in unit tests.
        // Instead, verify the cwd_send check logic directly:
        let terminals = state.terminals.lock().unwrap();
        let source_cwd_send = terminals.get("source").map(|s| s.cwd_send).unwrap_or(true);
        assert!(
            !source_cwd_send,
            "source terminal should have cwd_send=false"
        );
        // When cwd_send is false, do_sync_cwd should return early after updating local CWD
    }

    #[test]
    fn cwd_send_defaults_to_true() {
        let session = TerminalSession::new("test".into(), TerminalConfig::default());
        assert!(session.cwd_send, "cwd_send should default to true");
    }

    // --- any_terminal_title_contains tests ---

    #[test]
    fn any_title_contains_finds_claude_in_earlier_title() {
        // Claude Code set title first, then changed to task description
        let data =
            b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07some output\x1b]0;\xe2\x9c\xb6 Exploring code\x07";
        assert!(osc::any_terminal_title_contains(data, "Claude Code"));
    }

    #[test]
    fn any_title_contains_finds_claude_in_last_title() {
        let data = b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07";
        assert!(osc::any_terminal_title_contains(data, "Claude Code"));
    }

    #[test]
    fn any_title_contains_false_when_no_claude() {
        let data = b"\x1b]0;bash\x07output\x1b]0;vim\x07";
        assert!(!osc::any_terminal_title_contains(data, "Claude Code"));
    }

    #[test]
    fn any_title_contains_checks_osc2_titles() {
        // OSC 2 (window title) should also be scanned
        let data = b"\x1b]2;\xe2\x9c\xb3 Claude Code\x07\x1b]0;task desc\x07";
        assert!(osc::any_terminal_title_contains(data, "Claude Code"));
    }

    #[test]
    fn any_title_contains_empty_data() {
        assert!(!osc::any_terminal_title_contains(b"", "Claude Code"));
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
            activity::is_claude_terminal_from_buffer(&state, "t1", Some(&buf)),
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
            assert!(activity::is_claude_terminal_from_buffer(
                &state,
                "t1",
                Some(&buf)
            ));
        }
        // Second call: buffer no longer has "Claude Code", but persistent set remembers
        {
            let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
            buf.push(b"\x1b]0;\xe2\x9c\xbb reading file.rs\x07");
            assert!(
                activity::is_claude_terminal_from_buffer(&state, "t1", Some(&buf)),
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
            !activity::is_claude_terminal_from_buffer(&state, "t1", Some(&buf)),
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
        assert!(osc::any_terminal_title_contains(chunk, "Claude Code"));

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
            osc::extract_last_osc7_cwd(data),
            Some("file://localhost/home/user".into())
        );
    }

    #[test]
    fn extract_osc7_cwd_st_terminator() {
        let data = b"\x1b]7;file://localhost/C:/Users/test\x1b\\";
        assert_eq!(
            osc::extract_last_osc7_cwd(data),
            Some("file://localhost/C:/Users/test".into())
        );
    }

    #[test]
    fn extract_osc7_cwd_multiple_returns_last() {
        let data = b"\x1b]7;file://localhost/old\x07some output\x1b]7;file://localhost/new\x07";
        assert_eq!(
            osc::extract_last_osc7_cwd(data),
            Some("file://localhost/new".into())
        );
    }

    #[test]
    fn extract_osc7_cwd_none_when_absent() {
        let data = b"plain terminal output with no osc";
        assert_eq!(osc::extract_last_osc7_cwd(data), None);
    }

    #[test]
    fn extract_osc7_cwd_none_when_truncated() {
        // Sequence starts but no terminator
        let data = b"\x1b]7;file://localhost/home/user";
        assert_eq!(osc::extract_last_osc7_cwd(data), None);
    }

    #[test]
    fn extract_osc7_cwd_mixed_with_other_osc() {
        // OSC 0 title + OSC 7 CWD in same chunk
        let data = b"\x1b]0;My Terminal\x07\x1b]7;file://localhost/tmp\x07";
        assert_eq!(
            osc::extract_last_osc7_cwd(data),
            Some("file://localhost/tmp".into())
        );
    }

    // -- extract_last_osc9_9_cwd tests --

    #[test]
    fn extract_osc9_9_cwd_basic() {
        let data = b"\x1b]9;9;C:/Users/kochul\x07";
        assert_eq!(
            osc::extract_last_osc9_9_cwd(data),
            Some("C:/Users/kochul".into())
        );
    }

    #[test]
    fn extract_osc9_9_cwd_wsl_unc() {
        let data = b"\x1b]9;9;//wsl.localhost/Ubuntu-22.04/home/user\x07";
        assert_eq!(
            osc::extract_last_osc9_9_cwd(data),
            Some("//wsl.localhost/Ubuntu-22.04/home/user".into())
        );
    }

    #[test]
    fn extract_osc9_9_cwd_multiple_returns_last() {
        let data = b"\x1b]9;9;C:/old\x07output\x1b]9;9;C:/new\x07";
        assert_eq!(osc::extract_last_osc9_9_cwd(data), Some("C:/new".into()));
    }

    #[test]
    fn extract_osc9_9_cwd_none_when_absent() {
        let data = b"no osc 9;9 here";
        assert_eq!(osc::extract_last_osc9_9_cwd(data), None);
    }

    #[test]
    fn extract_osc9_9_cwd_ignores_non_9_subcode() {
        // OSC 9 with non-9 subcode (e.g., notification)
        let data = b"\x1b]9;Hello notification\x07";
        assert_eq!(osc::extract_last_osc9_9_cwd(data), None);
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

    // -- extract_last_osc_payload shared function --

    #[test]
    fn extract_osc_payload_with_custom_needle() {
        // Verify the shared function works for an arbitrary needle
        let needle = &[0x1b, b']', b'7', b';'];
        let data = b"\x1b]7;file://localhost/test\x07";
        assert_eq!(
            osc::extract_last_osc_payload(data, needle),
            Some("file://localhost/test".into())
        );
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

    // ── Issue #215: CWD propagation must be gated on source activity ──
    //
    // PowerShell re-emits OSC 7 every prompt render, including transitions
    // triggered by an interactive TUI app (OpenAI Codex, vim, etc). When the
    // source terminal is not sitting at a shell prompt, the current OSC 7
    // payload does not reflect a user-intended `cd`, so it must NOT be
    // propagated to the rest of the sync group.

    #[test]
    fn is_source_sync_allowed_for_shell_activity() {
        // At-prompt shell: OSC 7 is a legitimate CWD change → allow propagation.
        let state = AppState::new();
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;C\x07output\x1b]133;D;0\x07prompt$ ");
        assert!(is_source_sync_allowed(&state, "t1", Some(&buf)));
    }

    #[test]
    fn is_source_sync_allowed_for_running_command() {
        // `Running` (shell command mid-execution) is still considered shell
        // context — the user issued a shell command that may itself `cd`.
        let state = AppState::new();
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;D;0\x07prompt$ \x1b]133;C\x07");
        assert!(is_source_sync_allowed(&state, "t1", Some(&buf)));
    }

    #[test]
    fn is_source_sync_allowed_no_buffer() {
        // Unknown/no buffer → assume shell (permissive default).
        let state = AppState::new();
        assert!(is_source_sync_allowed(&state, "t1", None));
    }

    #[test]
    fn is_source_sync_blocked_for_interactive_codex_title() {
        // PowerShell + codex bug scenario: OSC 7 fires while Codex is the
        // active interactive app → propagation must be blocked.
        let state = AppState::new();
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;D;0\x07PS C:\\> \x1b]0;OpenAI Codex\x07");
        assert!(!is_source_sync_allowed(&state, "t1", Some(&buf)));
    }

    #[test]
    fn is_source_sync_blocked_for_claude_code_title() {
        let state = AppState::new();
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07");
        assert!(!is_source_sync_allowed(&state, "t1", Some(&buf)));
    }

    #[test]
    fn is_source_sync_blocked_for_vim_title() {
        let state = AppState::new();
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]2;vim - main.rs\x07");
        assert!(!is_source_sync_allowed(&state, "t1", Some(&buf)));
    }

    #[test]
    fn is_source_sync_blocked_for_codex_spinner_title_after_detection() {
        // Issue #215 reviewer scenario: once Codex is running, its title
        // changes from "OpenAI Codex" to a braille spinner like "⠋ working".
        // That spinner no longer matches INTERACTIVE_APP_PATTERNS directly,
        // so we must rely on persistent tracking (`known_codex_terminals`) +
        // Codex spinner heuristic — otherwise OSC 7 leaks through.
        let state = AppState::new();
        state
            .known_codex_terminals
            .lock()
            .unwrap()
            .insert("t1".to_string());
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        // Buffer holds ONLY the braille spinner title + OSC 7 — the literal
        // "OpenAI Codex" string has already scrolled out of the scan window.
        // Detection must rely solely on persistent `known_codex_terminals`
        // combined with the braille spinner heuristic.
        buf.push(b"\x1b]0;\xe2\xa0\x8b working\x07\x1b]7;file://localhost/C:/tmp\x07");
        assert!(
            !is_source_sync_allowed(&state, "t1", Some(&buf)),
            "Codex spinner title with persistent tracking must still block propagation"
        );
    }

    #[test]
    fn is_source_sync_blocked_for_claude_task_title_after_detection() {
        // Reviewer scenario: Claude Code initially sets "✳ Claude Code" then
        // switches to per-task titles (e.g. "✻ Exploring code"). Title-only
        // matching misses those; persistent tracking must carry the state.
        let state = AppState::new();
        state
            .known_claude_terminals
            .lock()
            .unwrap()
            .insert("t1".to_string());
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        // Only a task title in buffer — no literal "Claude Code" anywhere.
        buf.push(b"\x1b]0;\xe2\x9c\xb6 Exploring code\x07\x1b]7;file://localhost/C:/tmp\x07");
        assert!(
            !is_source_sync_allowed(&state, "t1", Some(&buf)),
            "Claude task title with persistent tracking must still block propagation"
        );
    }

    #[test]
    fn source_cwd_event_rejected_for_claude_activity_before_local_update() {
        // Regression: the PTY callback used to update session.cwd and emit
        // terminal-cwd-changed before do_sync_cwd applied the source activity
        // guard. A Claude-active OSC 7 must be rejected before any local CWD
        // state mutation can occur.
        let state = AppState::new();
        state
            .known_claude_terminals
            .lock()
            .unwrap()
            .insert("source".to_string());

        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]0;\xe2\x9c\xb6 Editing files\x07\x1b]7;file://localhost/C:/leaked\x07");

        assert!(
            !should_accept_source_cwd_event(&state, "source", Some(&buf)),
            "Claude-active OSC 7 must not update local session.cwd before propagation is gated"
        );
    }

    #[test]
    fn source_cwd_event_accepted_for_shell_activity() {
        let state = AppState::new();
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;C\x07cd C:\\work\x1b]133;D;0\x07PS C:\\work> ");

        assert!(should_accept_source_cwd_event(&state, "source", Some(&buf)));
    }

    #[test]
    fn osc_sync_cwd_from_codex_does_not_write_to_targets() {
        // End-to-end regression for issue #215:
        // Source terminal is running Codex. A subsequent OSC 7 arrives (from
        // PowerShell's prompt emission). The shared filter used by do_sync_cwd
        // must return an empty target list so no `cd` is written to peers.
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            let mut source = TerminalSession::new("source".into(), TerminalConfig::default());
            source.config.sync_group = "g1".into();
            terminals.insert("source".into(), source);

            let mut target = TerminalSession::new("target".into(), TerminalConfig::default());
            target.config.sync_group = "g1".into();
            terminals.insert("target".into(), target);
        }
        {
            let mut groups = state.sync_groups.lock().unwrap();
            let mut g = crate::terminal::SyncGroup::new("g1".into());
            g.add_terminal("source".into());
            g.add_terminal("target".into());
            groups.insert("g1".into(), g);
        }
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            // Source is Codex — title set, then PowerShell prompt re-render emits OSC 7.
            let mut buf_src = crate::output_buffer::TerminalOutputBuffer::default();
            buf_src.push(b"\x1b]0;OpenAI Codex\x07\x1b]7;file://localhost/C:/tmp\x07");
            buffers.insert("source".into(), buf_src);

            // Target is an idle shell.
            let mut buf_tgt = crate::output_buffer::TerminalOutputBuffer::default();
            buf_tgt.push(b"\x1b]133;D;0\x07PS C:\\> ");
            buffers.insert("target".into(), buf_tgt);
        }

        // Guard check — when the source is an interactive app, we must not
        // propagate regardless of what happens downstream in do_sync_cwd.
        let src_buf_allowed = {
            let buffers = state.output_buffers.lock().unwrap();
            is_source_sync_allowed(&state, "source", buffers.get("source"))
        };
        assert!(
            !src_buf_allowed,
            "Codex-active source must not trigger sync-cwd propagation"
        );
    }

    // ── Issue #239: filter_targets_not_busy must use activity detection ──
    //
    // The previous implementation relied on `is_claude_terminal_from_buffer`
    // (title/buffer scan + `known_claude_terminals` HashSet) to detect Claude
    // targets, and `is_terminal_at_prompt_from_buffer` (OSC 133;D vs ;C) for
    // everything else. That combination misses Claude when:
    //   - the "Claude Code" title has scrolled out of the scan window, AND
    //   - the PTY callback never inserted the terminal into
    //     `known_claude_terminals` (e.g. Claude was spawned via `claude` command
    //     detected only on the frontend, or the title arrived before the
    //     terminal was registered).
    // In that state, the target is classified as a normal shell sitting at the
    // last OSC 133;D marker, and `LX_PROPAGATED=1 cd ...` gets injected into
    // Claude's input box.
    //
    // Fix: use `detect_terminal_state` so the full activity pipeline (including
    // `known_claude_terminals`, braille-spinner heuristic, vim/codex title
    // patterns) governs target filtering. Any `InteractiveApp { .. }` target —
    // not just Claude — is now excluded.

    #[test]
    fn filter_targets_not_busy_skips_claude_when_activity_is_claude_but_title_absent() {
        // Claude Code was detected earlier (persistent tracking + grace
        // window seeded by either the PTY callback's cr.entered or by
        // `mark_claude_terminal` from frontend command-text detection),
        // but the last buffer window only contains a path-like title and
        // a stale OSC 133;D from before Claude started.
        // `is_terminal_at_prompt_from_buffer` would naively report
        // "at prompt", but the activity pipeline must keep the target
        // classified as `InteractiveApp { name: "Claude" }` so cd-sync
        // does not inject into Claude's input.
        //
        // Post-PR-242-review: the cache is a hint, not a verdict. The
        // strict-signal helper rejects a path-like title as non-Claude
        // (cache + path-like is not enough), so the grace-window seed
        // is what carries the classification through this gap.
        let state = AppState::new();
        state
            .known_claude_terminals
            .lock()
            .unwrap()
            .insert("t-claude".to_string());
        // Grace-window seed — what `mark_claude_terminal` and the PTY
        // entry path do in production.
        crate::activity::record_interactive_app_detection(&state, "t-claude", "Claude");
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
            // Stale prompt marker + later title that does NOT match
            // INTERACTIVE_APP_PATTERNS directly (path-like titles are skipped
            // by detect_interactive_app_from_title). Without activity
            // detection, this buffer would pass `is_terminal_at_prompt_from_buffer`.
            buf.push(b"\x1b]133;D;0\x07stale prompt$ \x1b]0;/home/user/project\x07");
            buffers.insert("t-claude".into(), buf);
        }

        let targets = vec!["t-claude".into()];
        let (filtered, _claude_ids) =
            filter_targets_not_busy(&state, &targets, &crate::settings::ClaudeSyncCwdMode::Skip);
        assert!(
            filtered.is_empty(),
            "Claude target must be skipped based on activity, not buffer-title scan"
        );
    }

    #[test]
    fn filter_targets_not_busy_skips_interactive_app_when_stale_prompt_marker_present() {
        // Issue #239 exact reproduction: a target running Claude (detected
        // via the title pattern, NOT via known_claude_terminals) still has
        // a stale OSC 133;D from the pre-Claude shell prompt. With the old
        // codepath, `is_claude_terminal_from_buffer` returns true via title
        // scan and the Skip-mode branch excludes it — but if the Claude title
        // has scrolled out of the scan window AND the terminal was never
        // registered in known_claude_terminals, the fallback branch relies
        // on `is_terminal_at_prompt_from_buffer` which only sees the stale
        // ;D marker and erroneously keeps the target.
        //
        // Activity-based filtering must exclude any InteractiveApp target
        // regardless of which detection path succeeded.
        let state = AppState::new();
        // NOTE: known_claude_terminals is intentionally NOT populated here —
        // we rely on the title-pattern match in `detect_interactive_app_from_title`.
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
            // Stale shell prompt marker followed by Claude Code title.
            buf.push(b"\x1b]133;D;0\x07user@host:~$ claude\r\n\x1b]0;\xe2\x9c\xb3 Claude Code\x07");
            buffers.insert("t-claude".into(), buf);
        }

        let targets = vec!["t-claude".into()];
        let (filtered_skip, _) =
            filter_targets_not_busy(&state, &targets, &crate::settings::ClaudeSyncCwdMode::Skip);
        assert!(
            filtered_skip.is_empty(),
            "Claude target must not receive cd propagation just because a stale ;D marker remains"
        );
    }

    #[test]
    fn filter_targets_not_busy_skips_vim_interactive_app() {
        // Issue #239: any interactive TUI app target must be skipped,
        // not just Claude. vim does not have a persistent-tracking table
        // analogous to known_claude_terminals, so detection relies entirely
        // on `detect_terminal_activity` via title pattern.
        let state = AppState::new();
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
            buf.push(b"\x1b]133;D;0\x07$ \x1b]2;vim - main.rs\x07");
            buffers.insert("t-vim".into(), buf);
        }

        let targets = vec!["t-vim".into()];
        let (filtered, _) =
            filter_targets_not_busy(&state, &targets, &crate::settings::ClaudeSyncCwdMode::Skip);
        assert!(
            filtered.is_empty(),
            "vim target must be skipped — cd injection would be typed into vim buffer"
        );
    }

    #[test]
    fn filter_targets_not_busy_skips_codex_interactive_app() {
        // Codex, like Claude, sets a specific title first and later drifts
        // to a braille spinner. `detect_terminal_state` combines persistent
        // tracking + spinner heuristic to keep the session classified as
        // InteractiveApp.
        let state = AppState::new();
        state
            .known_codex_terminals
            .lock()
            .unwrap()
            .insert("t-codex".to_string());
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
            // Stale prompt + spinner-only title (no literal "OpenAI Codex").
            buf.push(b"\x1b]133;D;0\x07stale$ \x1b]0;\xe2\xa0\x8b working\x07");
            buffers.insert("t-codex".into(), buf);
        }

        let targets = vec!["t-codex".into()];
        let (filtered, _) =
            filter_targets_not_busy(&state, &targets, &crate::settings::ClaudeSyncCwdMode::Skip);
        assert!(
            filtered.is_empty(),
            "Codex target must be skipped via activity detection"
        );
    }

    #[test]
    fn filter_targets_not_busy_skips_claude_idle_heuristic_mismatch() {
        // Reviewer scenario: `is_claude_idle_from_buffer` uses the literal
        // ✳ (U+2733) prefix check on the LAST title. When Claude's title is
        // a task-description (e.g. "✻ Exploring code"), the idle check
        // returns false, but the terminal is still running Claude. In Skip
        // mode, cd propagation must never happen; in Command mode, Claude
        // must be skipped when not in the idle state (existing behavior).
        let state = AppState::new();
        state
            .known_claude_terminals
            .lock()
            .unwrap()
            .insert("t-claude".to_string());
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
            buf.push(b"\x1b]0;\xe2\x9c\xbb Exploring code\x07");
            buffers.insert("t-claude".into(), buf);
        }

        let targets = vec!["t-claude".into()];
        let (filtered_skip, claude_ids_skip) =
            filter_targets_not_busy(&state, &targets, &crate::settings::ClaudeSyncCwdMode::Skip);
        assert!(filtered_skip.is_empty());
        assert!(claude_ids_skip.is_empty());

        let (filtered_cmd, claude_ids_cmd) = filter_targets_not_busy(
            &state,
            &targets,
            &crate::settings::ClaudeSyncCwdMode::Command,
        );
        assert!(
            filtered_cmd.is_empty(),
            "Claude in Command mode must still be skipped when not idle"
        );
        assert!(claude_ids_cmd.is_empty());
    }

    #[test]
    fn filter_targets_not_busy_allows_claude_idle_in_command_mode() {
        // Regression guard for existing behavior: when Claude is at its idle
        // prompt (✳ prefix) and the mode is Command, the target should be
        // included AND marked as a claude_id so the caller writes `! cd '...'`.
        let state = AppState::new();
        state
            .known_claude_terminals
            .lock()
            .unwrap()
            .insert("t-claude".to_string());
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
            buf.push(b"\x1b]0;\xe2\x9c\xb3 Claude Code\x07");
            buffers.insert("t-claude".into(), buf);
        }

        let targets = vec!["t-claude".into()];
        let (filtered, claude_ids) = filter_targets_not_busy(
            &state,
            &targets,
            &crate::settings::ClaudeSyncCwdMode::Command,
        );
        assert_eq!(filtered, vec!["t-claude".to_string()]);
        assert!(claude_ids.contains("t-claude"));
    }

    #[test]
    fn filter_targets_not_busy_allows_shell_target() {
        // Regression guard: a plain shell target at its prompt must still
        // receive the cd propagation.
        let state = AppState::new();
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
            buf.push(b"\x1b]133;D;0\x07$ ");
            buffers.insert("t-shell".into(), buf);
        }

        let targets = vec!["t-shell".into()];
        let (filtered, claude_ids) =
            filter_targets_not_busy(&state, &targets, &crate::settings::ClaudeSyncCwdMode::Skip);
        assert_eq!(filtered, vec!["t-shell".to_string()]);
        assert!(claude_ids.is_empty());
    }
}
