use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

use crate::automation_server::AutomationResponse;
use crate::ide_cli::{IdeMessage, IdeResponse};
use crate::output_buffer::TerminalOutputBuffer;
use crate::pty;
use crate::state::AppState;
use crate::terminal::{TerminalActivity, TerminalConfig, TerminalSession, TerminalStateInfo};

/// How long a propagation flag remains valid before expiring.
const PROPAGATION_TIMEOUT: Duration = Duration::from_secs(5);

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to Laymux.", name)
}

#[tauri::command]
pub fn create_terminal_session(
    id: String,
    profile: String,
    cols: u16,
    rows: u16,
    sync_group: String,
    state: State<Arc<AppState>>,
    app: AppHandle,
) -> Result<TerminalSession, String> {
    // Inject IDE_SOCKET and IDE_AUTOMATION_PORT env vars
    let mut env = Vec::new();
    if let Ok(path_lock) = state.ipc_socket_path.lock() {
        if let Some(ref socket_path) = *path_lock {
            env.push(("IDE_SOCKET".to_string(), socket_path.clone()));
        }
    }
    if let Ok(port_lock) = state.automation_port.lock() {
        if let Some(port) = *port_lock {
            env.push(("IDE_AUTOMATION_PORT".to_string(), port.to_string()));
        }
    }

    let config = TerminalConfig {
        profile,
        cols,
        rows,
        sync_group: sync_group.clone(),
        env,
    };

    let session = TerminalSession::new(id.clone(), config);

    // Check for duplicate
    {
        let terminals = state
            .terminals
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        if terminals.contains_key(&id) {
            return Err(format!("Session '{id}' already exists"));
        }
    }

    // Create output buffer for this terminal
    {
        let mut buffers = state
            .output_buffers
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        buffers.insert(id.clone(), TerminalOutputBuffer::default());
    }

    // Spawn PTY
    let terminal_id = id.clone();
    let app_clone = app.clone();
    let output_buffers = state.output_buffers.clone();
    let buffer_terminal_id = id.clone();
    let pty_handle = pty::spawn_pty(&session, move |data| {
        // Write to output buffer
        if let Ok(mut buffers) = output_buffers.lock() {
            if let Some(buf) = buffers.get_mut(&buffer_terminal_id) {
                buf.push(&data);
            }
        }
        let _ = app_clone.emit(
            &format!("terminal-output-{terminal_id}"),
            data,
        );
    })?;

    // Store session and PTY handle
    let result = TerminalSession::new(id.clone(), TerminalConfig {
        profile: session.config.profile.clone(),
        cols: session.config.cols,
        rows: session.config.rows,
        sync_group: session.config.sync_group.clone(),
        env: session.config.env.clone(),
    });

    {
        let mut terminals = state
            .terminals
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        terminals.insert(id.clone(), session);
    }

    {
        let mut ptys = state
            .pty_handles
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        ptys.insert(id.clone(), pty_handle);
    }

    // Register in sync group if non-empty
    if !sync_group.is_empty() {
        let mut groups = state
            .sync_groups
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
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
        let mut terminals = state
            .terminals
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        let session = terminals
            .get_mut(&id)
            .ok_or_else(|| format!("Session '{id}' not found"))?;
        session.config.cols = cols;
        session.config.rows = rows;
    }

    // Resize PTY
    let ptys = state
        .pty_handles
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    if let Some(handle) = ptys.get(&id) {
        handle.resize(cols, rows)?;
    }

    Ok(())
}

#[tauri::command]
pub fn write_to_terminal(id: String, data: String, state: State<Arc<AppState>>) -> Result<(), String> {
    let ptys = state
        .pty_handles
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;

    let handle = ptys
        .get(&id)
        .ok_or_else(|| format!("Session '{id}' not found"))?;

    handle.write(data.as_bytes())
}

#[tauri::command]
pub fn close_terminal_session(id: String, state: State<Arc<AppState>>) -> Result<(), String> {
    // Remove PTY handle (drop closes the PTY)
    {
        let mut ptys = state
            .pty_handles
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        ptys.remove(&id);
    }

    // Remove output buffer
    {
        let mut buffers = state
            .output_buffers
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        buffers.remove(&id);
    }

    let mut terminals = state
        .terminals
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;

    let session = terminals
        .remove(&id)
        .ok_or_else(|| format!("Session '{id}' not found"))?;

    // Remove from sync group
    if !session.config.sync_group.is_empty() {
        if let Ok(mut groups) = state.sync_groups.lock() {
            if let Some(group) = groups.get_mut(&session.config.sync_group) {
                group.remove_terminal(&id);
                if group.terminal_ids.is_empty() {
                    groups.remove(&session.config.sync_group);
                }
            }
        }
    }

    // Clean up propagation flag
    if let Ok(mut propagated) = state.propagated_terminals.lock() {
        propagated.remove(&id);
    }

    Ok(())
}

#[tauri::command]
pub fn get_sync_group_terminals(
    group_name: String,
    state: State<Arc<AppState>>,
) -> Result<Vec<String>, String> {
    let groups = state
        .sync_groups
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;

    Ok(groups
        .get(&group_name)
        .map(|g| g.terminal_ids.clone())
        .unwrap_or_default())
}

/// Inner handler that processes IDE messages. Used by both the Tauri command
/// and the IPC socket server so that all message routes share the same logic.
pub fn handle_ide_message_inner(
    message_json: &str,
    state: &AppState,
    app: &AppHandle,
) -> Result<IdeResponse, String> {
    let message: IdeMessage =
        serde_json::from_str(message_json).map_err(|e| format!("Parse error: {e}"))?;

    handle_ide_message_dispatch(state, app, message)
}

#[tauri::command]
pub fn handle_ide_message(
    message_json: String,
    state: State<Arc<AppState>>,
    app: AppHandle,
) -> Result<IdeResponse, String> {
    let message: IdeMessage =
        serde_json::from_str(&message_json).map_err(|e| format!("Parse error: {e}"))?;

    handle_ide_message_dispatch(&state, &app, message)
}

fn handle_ide_message_dispatch(
    state: &AppState,
    app: &AppHandle,
    message: IdeMessage,
) -> Result<IdeResponse, String> {
    match message {
        IdeMessage::SyncCwd {
            path,
            terminal_id,
            group_id,
            all,
            target_group,
        } => {
            cleanup_stale_propagations(&state);

            // Check if this is an echo from a propagated command — suppress to prevent loop
            if is_propagated(&state, &terminal_id)? {
                return Ok(IdeResponse::ok(Some(format!(
                    "sync-cwd {} suppressed (propagated)",
                    path
                ))));
            }

            // Normalize WSL UNC paths to Linux-native paths
            let normalized_path = normalize_wsl_path(&path);

            // Skip if CWD hasn't actually changed for this terminal
            if should_skip_sync_cwd(&state, &terminal_id, &normalized_path) {
                return Ok(IdeResponse::ok(Some(format!(
                    "sync-cwd {} skipped (unchanged)",
                    normalized_path
                ))));
            }

            // Update stored CWD for the source terminal
            update_terminal_cwd(&state, &terminal_id, &normalized_path);

            let all_targets = resolve_target_terminals(&state, &terminal_id, &group_id, all, target_group.as_deref())?;

            // Skip targets that have a command running (e.g., interactive apps like Claude Code)
            let idle_targets = filter_targets_not_busy(&state, &all_targets);

            // Skip targets that are already at the same CWD
            let target_terminals = filter_targets_needing_cd(&state, &idle_targets, &normalized_path);

            // Write cd command to target terminals (with propagation flag)
            if !target_terminals.is_empty() {
                write_to_group_terminals(&state, &target_terminals, &terminal_id, &format!(" cd {normalized_path}\n"))?;
            }

            // Mark targets so their OSC echo won't re-propagate
            if !target_terminals.is_empty() {
                mark_propagated(&state, &target_terminals)?;
            }

            // Update stored CWD for all targets (including those already at the CWD)
            for tid in &all_targets {
                update_terminal_cwd(&state, tid, &normalized_path);
            }

            // Emit sync-cwd event to frontend for UI updates (all targets for CWD display)
            let _ = app.emit("sync-cwd", serde_json::json!({
                "path": normalized_path,
                "terminalId": terminal_id,
                "groupId": group_id,
                "targets": all_targets,
            }));

            Ok(IdeResponse::ok(Some(format!(
                "sync-cwd {} to {} terminals ({} already at cwd)",
                normalized_path,
                target_terminals.len(),
                all_targets.len() - target_terminals.len()
            ))))
        }
        IdeMessage::SyncBranch {
            branch,
            terminal_id,
            group_id,
        } => {
            // Emit sync-branch event to frontend for UI updates
            let _ = app.emit("sync-branch", serde_json::json!({
                "branch": branch,
                "terminalId": terminal_id,
                "groupId": group_id,
            }));

            let groups = state
                .sync_groups
                .lock()
                .map_err(|e| format!("Lock error: {e}"))?;
            let count = groups
                .get(&group_id)
                .map(|g| g.terminal_ids.len())
                .unwrap_or(0);

            Ok(IdeResponse::ok(Some(format!(
                "sync-branch {} to {} terminals",
                branch, count
            ))))
        }
        IdeMessage::Notify { message, terminal_id, level } => {
            // Emit notification to frontend
            let mut payload = serde_json::json!({
                "message": message,
                "terminalId": terminal_id,
            });
            if let Some(ref lvl) = level {
                payload["level"] = serde_json::json!(lvl);
            }
            let _ = app.emit("ide-notify", payload);

            Ok(IdeResponse::ok(Some(format!("notification: {}", message))))
        }
        IdeMessage::SetTabTitle { title, terminal_id } => {
            let mut terminals = state
                .terminals
                .lock()
                .map_err(|e| format!("Lock error: {e}"))?;
            if let Some(session) = terminals.get_mut(&terminal_id) {
                session.title = title.clone();
            }

            let _ = app.emit("set-tab-title", serde_json::json!({
                "title": title,
                "terminalId": terminal_id,
            }));

            Ok(IdeResponse::ok(Some(format!("title set: {}", title))))
        }
        IdeMessage::GetCwd { terminal_id } => {
            let terminals = state
                .terminals
                .lock()
                .map_err(|e| format!("Lock error: {e}"))?;
            let cwd = terminals
                .get(&terminal_id)
                .and_then(|s| s.cwd.clone())
                .unwrap_or_default();
            Ok(IdeResponse::ok(Some(cwd)))
        }
        IdeMessage::GetBranch { terminal_id } => {
            let terminals = state
                .terminals
                .lock()
                .map_err(|e| format!("Lock error: {e}"))?;
            let branch = terminals
                .get(&terminal_id)
                .and_then(|s| s.branch.clone())
                .unwrap_or_default();
            Ok(IdeResponse::ok(Some(branch)))
        }
        IdeMessage::SendCommand { command, group } => {
            let groups = state
                .sync_groups
                .lock()
                .map_err(|e| format!("Lock error: {e}"))?;
            let target_ids = groups
                .get(&group)
                .map(|g| g.terminal_ids.clone())
                .unwrap_or_default();
            drop(groups);

            write_to_group_terminals(&state, &target_ids, "", &format!("{command}\n"))?;

            Ok(IdeResponse::ok(Some(format!(
                "sent '{}' to {} terminals in group '{}'",
                command, target_ids.len(), group
            ))))
        }
        IdeMessage::OpenFile { path, terminal_id } => {
            // Emit open-file event to frontend
            let _ = app.emit("open-file", serde_json::json!({
                "path": path,
                "terminalId": terminal_id,
            }));

            Ok(IdeResponse::ok(Some(format!("open-file: {}", path))))
        }
        IdeMessage::SetCommandStatus { terminal_id, command, exit_code } => {
            // Update command_running state on the terminal session.
            // command present (no exit_code) → command started → running = true
            // exit_code present → command finished → running = false
            {
                let mut terminals = state
                    .terminals
                    .lock()
                    .map_err(|e| format!("Lock error: {e}"))?;
                if let Some(session) = terminals.get_mut(&terminal_id) {
                    if exit_code.is_some() {
                        session.command_running = false;
                    } else if command.is_some() {
                        session.command_running = true;
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
            let _ = app.emit("command-status", payload);

            let desc = match (&command, exit_code) {
                (Some(cmd), Some(code)) => format!("command '{}' exit {}", cmd, code),
                (Some(cmd), None) => format!("command '{}' started", cmd),
                (None, Some(code)) => format!("exit code {}", code),
                (None, None) => "no-op".to_string(),
            };
            Ok(IdeResponse::ok(Some(desc)))
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
        let terminals = state
            .terminals
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        Ok(terminals
            .keys()
            .filter(|id| id.as_str() != source_terminal_id)
            .cloned()
            .collect())
    } else if let Some(target) = target_group {
        let groups = state
            .sync_groups
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
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
        let groups = state
            .sync_groups
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
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
/// Prepends a space to avoid shell history, and sets IDE_PROPAGATED=1.
fn write_to_group_terminals(
    state: &AppState,
    target_ids: &[String],
    _source_id: &str,
    command: &str,
) -> Result<(), String> {
    let ptys = state
        .pty_handles
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;

    for id in target_ids {
        if let Some(handle) = ptys.get(id) {
            // Write with IDE_PROPAGATED=1 to prevent loop
            let propagated_cmd = format!("IDE_PROPAGATED=1 {command}");
            let _ = handle.write(propagated_cmd.as_bytes());
        }
    }

    Ok(())
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
pub fn open_settings_file() -> Result<(), String> {
    let path = crate::settings::settings_path();
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
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

/// Simple base64 encoder (no external crate needed).
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((input.len() + 2) / 3 * 4);
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

/// Upload a screenshot to the GitHub repo via the contents API.
/// Returns the raw download URL of the uploaded image.
fn upload_screenshot_to_github(path: &std::path::Path) -> Result<String, String> {
    let bytes = std::fs::read(path)
        .map_err(|e| format!("Failed to read screenshot: {e}"))?;
    let b64 = base64_encode(&bytes);

    let filename = path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "screenshot.png".to_string());

    // Get repo name
    let repo_out = std::process::Command::new("gh")
        .args(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])
        .output()
        .map_err(|e| format!("gh repo view failed: {e}"))?;
    if !repo_out.status.success() {
        return Err("Not in a GitHub repo or gh not configured".into());
    }
    let repo = String::from_utf8_lossy(&repo_out.stdout).trim().to_string();

    // Write JSON body to temp file (avoids command-line length limits)
    let json_body = format!(
        r#"{{"message":"Upload issue screenshot","content":"{b64}"}}"#
    );
    let temp_path = std::env::temp_dir().join("laymux_gh_upload.json");
    std::fs::write(&temp_path, &json_body)
        .map_err(|e| format!("Failed to write temp file: {e}"))?;

    // Upload via GitHub contents API
    let api_path = format!(
        "repos/{repo}/contents/.github/issue-screenshots/{filename}"
    );
    let upload_out = std::process::Command::new("gh")
        .args(["api", &api_path, "-X", "PUT", "--input", &temp_path.to_string_lossy()])
        .output()
        .map_err(|e| format!("gh api upload failed: {e}"))?;

    let _ = std::fs::remove_file(&temp_path);

    if !upload_out.status.success() {
        let stderr = String::from_utf8_lossy(&upload_out.stderr).trim().to_string();
        return Err(format!("GitHub upload failed: {stderr}"));
    }

    // Use github.com/raw/ URL format — works for both public and private repos
    // (authenticated users who have repo access can view the image)
    Ok(format!(
        "https://github.com/{repo}/raw/main/.github/issue-screenshots/{filename}"
    ))
}

#[tauri::command]
pub async fn submit_github_issue(title: String, body: String, screenshot_path: Option<String>) -> Result<String, String> {
    let mut full_body = body;

    // Upload screenshot to GitHub and embed the image in the body
    if let Some(ref path_str) = screenshot_path {
        let p = std::path::Path::new(path_str);
        if p.exists() {
            match upload_screenshot_to_github(p) {
                Ok(image_url) => {
                    full_body = format!("{full_body}\n\n![Screenshot]({image_url})");
                }
                Err(e) => {
                    full_body = format!("{full_body}\n\n_Screenshot upload failed: {e}_");
                }
            }
        }
    }

    let output = std::process::Command::new("gh")
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
        let _ = std::process::Command::new("powershell")
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
        let mut channels = state
            .automation_channels
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        channels.remove(&response.request_id)
    };

    if let Some(tx) = tx {
        let value = if response.success {
            response
                .data
                .unwrap_or(serde_json::Value::Null)
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
    let propagated = state
        .propagated_terminals
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    if let Some(ts) = propagated.get(terminal_id) {
        Ok(ts.elapsed() < PROPAGATION_TIMEOUT)
    } else {
        Ok(false)
    }
}

/// Check if a sync-cwd should be skipped because the terminal already has the same CWD.
fn should_skip_sync_cwd(state: &AppState, terminal_id: &str, normalized_path: &str) -> bool {
    if let Ok(terminals) = state.terminals.lock() {
        if let Some(session) = terminals.get(terminal_id) {
            if let Some(ref cwd) = session.cwd {
                return cwd == normalized_path;
            }
        }
    }
    false
}

/// Filter out terminals that have a command running.
/// Checks the terminal output buffer for the last OSC 133 marker:
/// - OSC 133;C (preexec) = command is running → exclude
/// - OSC 133;D (exit code) = at shell prompt → include
/// This is more reliable than the async `command_running` flag because it
/// reads from the actual terminal output (ground truth), avoiding race conditions.
fn filter_targets_not_busy(state: &AppState, targets: &[String]) -> Vec<String> {
    if let Ok(buffers) = state.output_buffers.lock() {
        targets
            .iter()
            .filter(|id| is_terminal_at_prompt_from_buffer(buffers.get(id.as_str())))
            .cloned()
            .collect()
    } else {
        targets.to_vec()
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
    let recent = buf.recent_bytes(8192); // Check last 8KB
    if recent.is_empty() {
        return true; // No output yet → assume at prompt
    }

    // Find the last OSC 133;C (preexec) and OSC 133;D (exit code) positions.
    // OSC format: \x1b]133;C\x07  or  \x1b]133;D;N\x07
    let last_c = find_last_osc_133(&recent, b"C");
    let last_d = find_last_osc_133(&recent, b"D");

    match (last_c, last_d) {
        (Some(c_pos), Some(d_pos)) => d_pos > c_pos, // D after C = at prompt
        (None, Some(_)) => true,                       // Only D = at prompt
        (Some(_), None) => false,                      // Only C = command running
        (None, None) => true,                          // No markers = assume at prompt
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
        if let Some(found) = data[start..].windows(needle.len()).position(|w| w == needle.as_slice()) {
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
pub fn detect_terminal_activity(
    buffer: Option<&crate::output_buffer::TerminalOutputBuffer>,
) -> TerminalActivity {
    let Some(buf) = buffer else {
        return TerminalActivity::Shell;
    };
    let recent = buf.recent_bytes(16384);
    if recent.is_empty() {
        return TerminalActivity::Shell;
    }

    let at_prompt = is_terminal_at_prompt_from_buffer(Some(buf));
    if at_prompt {
        return TerminalActivity::Shell;
    }

    // Command is running — check terminal title for known interactive apps
    if let Some(name) = detect_interactive_app(&recent) {
        return TerminalActivity::InteractiveApp { name };
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
            if let Some(found) = data[start..].windows(needle.len()).position(|w| w == needle) {
                let abs_pos = start + found;
                if best_pos.map_or(true, |bp| abs_pos > bp) {
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
    if let Ok(buffers) = state.output_buffers.lock() {
        if let Ok(terminals) = state.terminals.lock() {
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

/// Filter target terminals to only those whose CWD differs from the sync path.
/// Terminals already at the target CWD don't need a cd command.
fn filter_targets_needing_cd(state: &AppState, targets: &[String], normalized_path: &str) -> Vec<String> {
    if let Ok(terminals) = state.terminals.lock() {
        targets
            .iter()
            .filter(|id| {
                terminals.get(id.as_str()).map_or(true, |session| {
                    session.cwd.as_deref() != Some(normalized_path)
                })
            })
            .cloned()
            .collect()
    } else {
        targets.to_vec()
    }
}

/// Update the stored CWD for a terminal session.
fn update_terminal_cwd(state: &AppState, terminal_id: &str, cwd: &str) {
    if let Ok(mut terminals) = state.terminals.lock() {
        if let Some(session) = terminals.get_mut(terminal_id) {
            session.cwd = Some(cwd.to_string());
        }
    }
}

/// Normalize various CWD path formats to Linux-native paths.
/// `//wsl.localhost/Distro/path` → `/path`
/// `//wsl$/Distro/path` → `/path`
/// `file://localhost/path` → `/path` (OSC 7 format)
/// Non-WSL paths are returned unchanged.
fn normalize_wsl_path(path: &str) -> String {
    // file://localhost/<path> (OSC 7 CWD format from shell integration)
    if let Some(rest) = path.strip_prefix("file://localhost") {
        if rest.starts_with('/') {
            return rest.to_string();
        }
    }
    // //wsl.localhost/<distro>/<rest>
    if let Some(rest) = path.strip_prefix("//wsl.localhost/") {
        if let Some(pos) = rest.find('/') {
            return rest[pos..].to_string();
        }
    }
    // //wsl$/<distro>/<rest>
    if let Some(rest) = path.strip_prefix("//wsl$/") {
        if let Some(pos) = rest.find('/') {
            return rest[pos..].to_string();
        }
    }
    path.to_string()
}

/// Mark multiple terminals as having received a propagated command.
fn mark_propagated(state: &AppState, terminal_ids: &[String]) -> Result<(), String> {
    let mut propagated = state
        .propagated_terminals
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;
    let now = Instant::now();
    for id in terminal_ids {
        propagated.insert(id.clone(), now);
    }
    Ok(())
}

/// Remove propagation entries older than PROPAGATION_TIMEOUT.
fn cleanup_stale_propagations(state: &AppState) {
    if let Ok(mut propagated) = state.propagated_terminals.lock() {
        propagated.retain(|_, ts| ts.elapsed() < PROPAGATION_TIMEOUT);
    }
}

/// Tauri command: smart paste — resolve clipboard files/images into paths.
#[tauri::command]
pub fn smart_paste(image_dir: String, profile: String) -> Result<crate::clipboard::SmartPasteResult, String> {
    crate::clipboard::smart_paste(&image_dir, &profile)
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
            terminals.insert("t1".into(), TerminalSession::new("t1".into(), TerminalConfig::default()));
            terminals.insert("t2".into(), TerminalSession::new("t2".into(), TerminalConfig::default()));
            terminals.insert("t3".into(), TerminalSession::new("t3".into(), TerminalConfig::default()));
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

        // Mark targets as propagated (simulating handle_ide_message behavior)
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
            normalize_wsl_path("//wsl.localhost/Ubuntu-22.04/home/user/project"),
            "/home/user/project"
        );
        assert_eq!(
            normalize_wsl_path("//wsl$/Ubuntu-22.04/home/user/project"),
            "/home/user/project"
        );
    }

    #[test]
    fn sync_cwd_skips_when_cwd_unchanged() {
        // If a terminal reports the same CWD it already has, no sync should happen
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            let mut session = TerminalSession::new("t1".into(), TerminalConfig::default());
            session.cwd = Some("/home/user/project".into());
            terminals.insert("t1".into(), session);
            terminals.insert("t2".into(), TerminalSession::new("t2".into(), TerminalConfig::default()));
        }
        {
            let mut groups = state.sync_groups.lock().unwrap();
            let mut group = crate::terminal::SyncGroup::new("g1".into());
            group.add_terminal("t1".into());
            group.add_terminal("t2".into());
            groups.insert("g1".into(), group);
        }

        // same CWD → should be skipped
        assert!(should_skip_sync_cwd(&state, "t1", "/home/user/project"));
        // different CWD → should NOT be skipped
        assert!(!should_skip_sync_cwd(&state, "t1", "/home/user/other"));
        // unknown terminal → should NOT be skipped
        assert!(!should_skip_sync_cwd(&state, "unknown", "/whatever"));
    }

    #[test]
    fn normalize_wsl_path_leaves_normal_paths_unchanged() {
        assert_eq!(normalize_wsl_path("/home/user/project"), "/home/user/project");
        assert_eq!(normalize_wsl_path("~/dev"), "~/dev");
        assert_eq!(normalize_wsl_path("C:\\Users\\user"), "C:\\Users\\user");
    }

    #[test]
    fn normalize_file_localhost_path() {
        assert_eq!(
            normalize_wsl_path("file://localhost/home/user/project"),
            "/home/user/project"
        );
        assert_eq!(
            normalize_wsl_path("file://localhost/tmp"),
            "/tmp"
        );
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

            buffers.insert("t3".into(), crate::output_buffer::TerminalOutputBuffer::default());
        }

        let targets = vec!["t1".into(), "t2".into(), "t3".into()];
        let filtered = filter_targets_not_busy(&state, &targets);
        assert!(filtered.contains(&"t1".to_string()), "t1 at prompt");
        assert!(!filtered.contains(&"t2".to_string()), "t2 is busy, should be excluded");
        assert!(filtered.contains(&"t3".to_string()), "t3 no output, assume at prompt");
    }

    #[test]
    fn filter_targets_not_busy_includes_unknown_terminals() {
        let state = AppState::new();
        let targets = vec!["unknown".into()];
        let filtered = filter_targets_not_busy(&state, &targets);
        assert_eq!(filtered, vec!["unknown"]);
    }

    #[test]
    fn is_terminal_at_prompt_detects_running_command() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;D;0\x07prompt$ \x1b]133;C\x07");
        assert!(!is_terminal_at_prompt_from_buffer(Some(&buf)), "After C, command is running");
    }

    #[test]
    fn is_terminal_at_prompt_detects_idle() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;C\x07output\x1b]133;D;0\x07prompt$ ");
        assert!(is_terminal_at_prompt_from_buffer(Some(&buf)), "After D, terminal is idle");
    }

    #[test]
    fn is_terminal_at_prompt_empty_buffer() {
        let buf = crate::output_buffer::TerminalOutputBuffer::default();
        assert!(is_terminal_at_prompt_from_buffer(Some(&buf)), "Empty buffer → assume at prompt");
    }

    #[test]
    fn is_terminal_at_prompt_no_buffer() {
        assert!(is_terminal_at_prompt_from_buffer(None), "No buffer → assume at prompt");
    }

    #[test]
    fn sync_cwd_skips_busy_terminals() {
        // Setup: group "g1" with t1 (source), t2 (idle), t3 (busy with Claude Code)
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            terminals.insert("t1".into(), TerminalSession::new("t1".into(), TerminalConfig::default()));
            terminals.insert("t2".into(), TerminalSession::new("t2".into(), TerminalConfig::default()));
            terminals.insert("t3".into(), TerminalSession::new("t3".into(), TerminalConfig::default()));
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

        let idle_targets = filter_targets_not_busy(&state, &all_targets);
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
        assert_eq!(detect_terminal_activity(Some(&buf)), TerminalActivity::Shell);
    }

    #[test]
    fn detect_activity_running_command() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;D;0\x07prompt$ \x1b]133;C\x07");
        assert_eq!(detect_terminal_activity(Some(&buf)), TerminalActivity::Running);
    }

    #[test]
    fn detect_activity_claude_code_from_title() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        // Simulate: prompt → preexec → Claude Code sets terminal title
        buf.push(b"\x1b]133;D;0\x07prompt$ \x1b]133;C\x07\x1b]0;\xe2\x9c\xb3 Claude Code\x07");
        assert_eq!(
            detect_terminal_activity(Some(&buf)),
            TerminalActivity::InteractiveApp { name: "Claude Code".to_string() }
        );
    }

    #[test]
    fn detect_activity_vim_from_title() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;D;0\x07\x1b]133;C\x07\x1b]0;vim main.rs\x07");
        assert_eq!(
            detect_terminal_activity(Some(&buf)),
            TerminalActivity::InteractiveApp { name: "vim".to_string() }
        );
    }

    #[test]
    fn detect_activity_no_buffer() {
        assert_eq!(detect_terminal_activity(None), TerminalActivity::Shell);
    }

    #[test]
    fn detect_activity_empty_buffer() {
        let buf = crate::output_buffer::TerminalOutputBuffer::default();
        assert_eq!(detect_terminal_activity(Some(&buf)), TerminalActivity::Shell);
    }

    #[test]
    fn extract_title_osc0() {
        let data = b"some output\x1b]0;my title\x07more output";
        assert_eq!(extract_last_terminal_title(data), Some("my title".to_string()));
    }

    #[test]
    fn extract_title_osc2() {
        let data = b"\x1b]2;window title\x07";
        assert_eq!(extract_last_terminal_title(data), Some("window title".to_string()));
    }

    #[test]
    fn extract_title_last_wins() {
        let data = b"\x1b]0;first\x07middle\x1b]0;second\x07end";
        assert_eq!(extract_last_terminal_title(data), Some("second".to_string()));
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
        assert!(state_info.output_active, "Just pushed output should be active");
        assert!(state_info.last_output_ms_ago < 1000);
    }

    #[test]
    fn detect_state_output_stale() {
        let mut buf = crate::output_buffer::TerminalOutputBuffer::default();
        buf.push(b"\x1b]133;D;0\x07prompt$ ");
        // Manually set last_output_at to the past
        buf.last_output_at = Some(std::time::Instant::now() - std::time::Duration::from_secs(10));
        let state_info = detect_terminal_state(Some(&buf));
        assert!(!state_info.output_active, "10s old output should not be active");
        assert!(state_info.last_output_ms_ago >= 9000);
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
}
