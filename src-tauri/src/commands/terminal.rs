use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::constants::*;
use crate::lock_ext::MutexExt;
use crate::osc;
use crate::output_buffer::TerminalOutputBuffer;
use crate::path_utils;
use crate::pty;
use crate::state::AppState;
use crate::terminal::{TerminalConfig, TerminalSession};

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
        .filter(|cmd| super::is_valid_startup_command_override(cmd, &allowed_viewer_commands));
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
            if osc::any_terminal_title_contains(&data, "Claude Code") {
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
            osc::extract_last_osc7_cwd(&data).or_else(|| osc::extract_last_osc9_9_cwd(&data))
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

/// Check if a terminal is registered as running Claude Code.
#[tauri::command]
pub fn is_claude_terminal(id: String, state: State<Arc<AppState>>) -> Result<bool, String> {
    let known = state.known_claude_terminals.lock_or_err()?;
    Ok(known.contains(&id))
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
