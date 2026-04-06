use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::activity;
use crate::claude_bullet;
use crate::constants::*;
use crate::lock_ext::MutexExt;
use crate::osc;
use crate::osc_hooks::{self, CommandStatusField, OscAction};
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

    // Spawn PTY with unified OSC processing in the output callback.
    let terminal_id = id.clone();
    let app_clone = app.clone();
    let state_for_pty = Arc::clone(&*state);
    let claude_detected = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let lookback_buf: Arc<std::sync::Mutex<Vec<u8>>> =
        Arc::new(std::sync::Mutex::new(Vec::with_capacity(64)));
    let presets = osc_hooks::default_presets();
    let pty_handle = pty::spawn_pty(&session, move |data| {
        // IMPORTANT: Each lock below is acquired and released independently (never nested).
        // Do NOT combine these blocks — nested locks would violate the AppState lock ordering
        // (terminals → output_buffers → known_claude_terminals) and risk deadlock.

        // Write to output buffer
        if let Ok(mut buffers) = state_for_pty.output_buffers.lock_or_err() {
            if let Some(buf) = buffers.get_mut(&terminal_id) {
                buf.push(&data);
            }
        }

        // ── Unified OSC processing loop ──
        // Single pass: parse all OSC sequences, match against presets, dispatch actions,
        // and emit structured events. Replaces the old per-code extraction blocks.
        let sync_group = {
            if let Ok(terms) = state_for_pty.terminals.lock_or_err() {
                terms
                    .get(&terminal_id)
                    .map(|s| s.config.sync_group.clone())
                    .unwrap_or_default()
            } else {
                String::new()
            }
        };

        for event in osc::iter_osc_events(&data) {
            // Arm notify gate on user command observation (OSC 133;C or 133;E)
            if osc_hooks::should_arm_notify_gate(&event) {
                if let Ok(mut terms) = state_for_pty.terminals.lock_or_err() {
                    if let Some(session) = terms.get_mut(&terminal_id) {
                        session.notify_gate_armed = true;
                    }
                }
            }

            // Claude Code detection from OSC 0/2 titles
            if (event.code == 0 || event.code == 2)
                && !claude_detected.load(std::sync::atomic::Ordering::Relaxed)
                && event.data.contains("Claude Code")
            {
                claude_detected.store(true, std::sync::atomic::Ordering::Relaxed);
                if let Ok(mut known) = state_for_pty.known_claude_terminals.lock_or_err() {
                    known.insert(terminal_id.clone());
                }
                let _ = app_clone.emit(EVENT_CLAUDE_TERMINAL_DETECTED, &terminal_id);
            }

            // Claude Code exit detection: title no longer contains "Claude Code"
            // Clears stale claude_message and removes from known_claude_terminals
            // so activity detection correctly returns to "shell".
            if (event.code == 0 || event.code == 2)
                && claude_detected.load(std::sync::atomic::Ordering::Relaxed)
                && !event.data.contains("Claude Code")
            {
                claude_detected.store(false, std::sync::atomic::Ordering::Relaxed);
                // Lock ordering: terminals (1) before known_claude_terminals (3)
                if let Ok(mut terms) = state_for_pty.terminals.lock_or_err() {
                    if let Some(session) = terms.get_mut(&terminal_id) {
                        if session.claude_message.is_some() {
                            session.claude_message = None;
                            let _ = app_clone.emit(
                                EVENT_CLAUDE_MESSAGE_CHANGED,
                                serde_json::json!({
                                    "terminalId": terminal_id,
                                    "message": null,
                                }),
                            );
                        }
                    }
                }
                // Remove from known_claude_terminals so is_claude_terminal_from_buffer()
                // no longer reports this terminal as running Claude Code.
                if let Ok(mut known) = state_for_pty.known_claude_terminals.lock_or_err() {
                    known.remove(&terminal_id);
                }
            }

            // Emit structured title change event (OSC 0/2) for frontend activity detection
            if event.code == 0 || event.code == 2 {
                let interactive_app = activity::detect_interactive_app_from_title(&event.data);
                let notify_gate_armed = if let Ok(terms) = state_for_pty.terminals.lock_or_err() {
                    terms.get(&terminal_id).is_some_and(|s| s.notify_gate_armed)
                } else {
                    false
                };
                let _ = app_clone.emit(
                    EVENT_TERMINAL_TITLE_CHANGED,
                    serde_json::json!({
                        "terminalId": terminal_id,
                        "title": event.data,
                        "interactiveApp": interactive_app,
                        "notifyGateArmed": notify_gate_armed,
                    }),
                );
            }

            // Proactive CWD update (single source of truth in session.cwd)
            // This must happen regardless of hook matching — the backend always
            // tracks the latest CWD for each terminal.
            if event.code == 7 || (event.code == 9 && event.param.as_deref() == Some("9")) {
                // Both OSC 7 and OSC 9;9 provide CWD in event.data
                // (OSC 9;9 "9;" prefix is already stripped by iter_osc_events)
                let raw_cwd = &event.data;
                let normalized = path_utils::normalize_wsl_path(raw_cwd);
                let mut changed = false;
                if let Ok(mut terms) = state_for_pty.terminals.lock_or_err() {
                    if let Some(session) = terms.get_mut(&terminal_id) {
                        if session.cwd.as_deref() != Some(&normalized) {
                            if session.wsl_distro.is_none() {
                                if let Some(distro) =
                                    path_utils::extract_wsl_distro_from_path(raw_cwd)
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
                    let _ = app_clone.emit(
                        EVENT_TERMINAL_CWD_CHANGED,
                        serde_json::json!({
                            "terminalId": terminal_id,
                            "cwd": normalized,
                        }),
                    );
                }
            }

            // Match hooks and dispatch actions
            let matched = osc_hooks::match_hooks(&event, &presets);
            for hook in matched {
                // Check notify gate for notification actions
                if osc_hooks::is_notify_action(&hook.action) {
                    let armed = if let Ok(terms) = state_for_pty.terminals.lock_or_err() {
                        terms.get(&terminal_id).is_some_and(|s| s.notify_gate_armed)
                    } else {
                        false
                    };
                    if !armed {
                        continue;
                    }
                }

                dispatch_osc_action(
                    &state_for_pty,
                    &app_clone,
                    &terminal_id,
                    &sync_group,
                    &hook.action,
                    &event,
                );
            }
        }

        // ── Claude Code status-marker message detection ──
        // Only runs for known Claude terminals. Extracts user-facing status
        // messages (· or legacy ●) and stores as raw state in session.claude_message.
        // Accumulates a small lookback buffer to handle cross-chunk marker splits.
        if claude_detected.load(std::sync::atomic::Ordering::Relaxed) {
            // Prepend up to 64 bytes from previous chunk to handle splits where
            // the marker color/char arrives in one chunk and text in the next.
            let combined: std::borrow::Cow<[u8]> = {
                // Using lock().ok() instead of lock_or_err(): in PTY callback,
                // a poisoned lock is non-fatal (graceful degradation, not an error path).
                let prev = lookback_buf.lock().ok();
                let prev_data = prev.as_ref().map(|b| b.as_slice()).unwrap_or(&[]);
                if prev_data.is_empty() {
                    std::borrow::Cow::Borrowed(&data)
                } else {
                    let mut combined = Vec::with_capacity(prev_data.len() + data.len());
                    combined.extend_from_slice(prev_data);
                    combined.extend_from_slice(&data);
                    std::borrow::Cow::Owned(combined)
                }
            };
            // Update lookback: keep last 64 bytes for next chunk
            if let Ok(mut buf) = lookback_buf.lock() {
                let keep = 64.min(data.len());
                buf.clear();
                buf.extend_from_slice(&data[data.len() - keep..]);
            }
            if let Some(msg) = claude_bullet::extract_claude_status_message(&combined) {
                let mut changed = false;
                if let Ok(mut terms) = state_for_pty.terminals.lock_or_err() {
                    if let Some(session) = terms.get_mut(&terminal_id) {
                        if session.claude_message.as_deref() != Some(&msg) {
                            session.claude_message = Some(msg.clone());
                            changed = true;
                        }
                    }
                }
                if changed {
                    let _ = app_clone.emit(
                        EVENT_CLAUDE_MESSAGE_CHANGED,
                        serde_json::json!({
                            "terminalId": terminal_id,
                            "message": msg,
                        }),
                    );
                }
            }
        }

        let _ = app_clone.emit(&format!("terminal-output-{terminal_id}"), data);
    })?;

    // Start notify gate fallback timer: arms the gate after NOTIFY_GATE_FALLBACK_MS
    // for shells without preexec (e.g., PowerShell which doesn't emit OSC 133;C/E).
    {
        let state_for_timer = Arc::clone(&*state);
        let timer_terminal_id = id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(NOTIFY_GATE_FALLBACK_MS));
            if let Ok(mut terms) = state_for_timer.terminals.lock_or_err() {
                if let Some(session) = terms.get_mut(&timer_terminal_id) {
                    session.notify_gate_armed = true;
                }
            }
        });
    }

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

/// Dispatch an OSC hook action from the PTY callback.
/// Called for each matched hook after OSC parsing.
/// All locks are acquired and released independently to prevent deadlock.
fn dispatch_osc_action(
    state: &AppState,
    app: &AppHandle,
    terminal_id: &str,
    sync_group: &str,
    action: &OscAction,
    event: &osc::OscEvent,
) {
    match action {
        OscAction::SyncCwd => {
            // CWD sync — delegate to the shared do_sync_cwd function.
            // The proactive CWD update (session.cwd) already happened above,
            // so this handles group propagation.
            let _ = super::ipc_dispatch::do_sync_cwd(
                state,
                app,
                terminal_id,
                sync_group,
                &event.data,
                false,
                None,
            );
        }
        OscAction::SyncBranch => {
            if let Some(branch) = osc_hooks::extract_branch_from_command(&event.data) {
                let _ = super::ipc_dispatch::do_sync_branch(
                    state,
                    app,
                    terminal_id,
                    sync_group,
                    &branch,
                );
            }
        }
        OscAction::Notify { level } => {
            let message = osc_hooks::extract_notify_message(event);
            let _ =
                super::ipc_dispatch::do_notify(state, app, terminal_id, &message, level.as_deref());
        }
        OscAction::SetTabTitle => {
            let _ = super::ipc_dispatch::do_set_tab_title(state, app, terminal_id, &event.data);
        }
        OscAction::SetWslDistro => {
            let _ = super::ipc_dispatch::do_set_wsl_distro(state, terminal_id, &event.data);
        }
        OscAction::SetCommandStatus(field) => {
            // Skip all command status updates for propagated terminals (LX_PROPAGATED=1 cd).
            // Command text (133;E) is also filtered by the preset condition
            // (CommandDoesNotStartWith), but we check is_propagated() here as
            // defense-in-depth in case custom hooks bypass the preset condition.
            match super::ipc_dispatch::is_propagated(state, terminal_id) {
                Ok(true) => return,
                Err(e) => {
                    tracing::warn!(terminal_id, error = %e, "is_propagated check failed");
                }
                _ => {}
            }

            match field {
                CommandStatusField::Command => {
                    let _ = super::ipc_dispatch::do_set_command_status(
                        state,
                        app,
                        terminal_id,
                        Some(&event.data),
                        None,
                    );
                }
                CommandStatusField::ExitCode => {
                    let exit_code = event.data.parse::<i32>().ok();
                    let _ = super::ipc_dispatch::do_set_command_status(
                        state,
                        app,
                        terminal_id,
                        None,
                        exit_code,
                    );
                }
                CommandStatusField::Preexec => {
                    let _ = super::ipc_dispatch::do_set_command_status(
                        state,
                        app,
                        terminal_id,
                        Some("__preexec__"),
                        None,
                    );
                }
            }
        }
    }
}
