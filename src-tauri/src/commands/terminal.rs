use serde::Deserialize;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

use crate::activity;
use crate::claude_activity;
use crate::claude_bullet;
use crate::codex_activity;
use crate::constants::*;
use crate::lock_ext::MutexExt;
use crate::osc;
use crate::osc_hooks::{self, CommandStatusField, OscAction};
use crate::output_buffer::TerminalOutputBuffer;
use crate::path_utils;
use crate::pty;
use crate::pty_trace;
use crate::state::AppState;
use crate::terminal::{TerminalConfig, TerminalSession};

/// Resolve whether Claude Code is currently detected for `terminal_id`,
/// combining the per-terminal `claude_detected` atomic with the shared
/// `known_claude_terminals` set.
///
/// Two detection sources populate Claude state but do not share a single
/// sink:
/// - The PTY callback's title state machine (this file) sets the atomic AND
///   inserts into the set when it sees a "Claude Code" title.
/// - The `mark_claude_terminal` command (called by the frontend when it
///   recognizes a `claude` command from OSC 133;E) inserts into the set
///   only — the atomic stays false because it lives on per-terminal PTY
///   callback state that the command handler cannot reach.
///
/// Without this fallback, a command-detected session whose first title is a
/// spinner-only title (e.g. "✶ Task", "⠋ Working") would be invisible to
/// `process_claude_title`: `was_detected=false` means the working/idle
/// block is skipped, `claude_was_working` never becomes true, and the
/// eventual ✳ idle transition produces no completion notification.
///
/// When the atomic is false but the set contains the ID, the atomic is
/// synced so subsequent OSC 0/2 events on the same terminal take the fast
/// path without re-locking the set.
fn resolve_claude_detected(
    atomic: &AtomicBool,
    known: &Mutex<HashSet<String>>,
    terminal_id: &str,
) -> bool {
    if atomic.load(Ordering::Relaxed) {
        return true;
    }
    let in_known = known
        .lock_or_err()
        .map(|set| set.contains(terminal_id))
        .unwrap_or(false);
    if in_known {
        atomic.store(true, Ordering::Relaxed);
    }
    in_known
}

/// Apply a `ClaudeTitleResult` to a terminal session's Claude-related
/// fields. Pure mutation over `&mut TerminalSession` — no locks, no IPC.
/// The caller emits `EVENT_CLAUDE_MESSAGE_CHANGED` when the return value
/// is `true`.
///
/// Extracted from the PTY OSC 0/2 handler so the three cases
/// (exit / in-session working / in-session non-working) can be unit-tested
/// directly against `TerminalSession` without spinning up a PTY. The
/// function is a no-op for results that represent neither an exit nor an
/// active Claude session, mirroring the caller's outer guard — this
/// duplication is intentional defense-in-depth so a future caller that
/// forgets the guard cannot silently corrupt state.
///
/// `title` is the raw OSC 0/2 payload (including any spinner prefix) and
/// is stored in `claude_last_working_title` only when `cr.now_working` is
/// true. Any other non-exit title invalidates the remembered working
/// title so a later ✳ idle cannot reach into a stale value from before a
/// working→plain transition.
fn apply_claude_title_state(
    session: &mut TerminalSession,
    cr: &claude_activity::ClaudeTitleResult,
    title: &str,
    new_message: Option<&str>,
) -> bool {
    if !cr.exited && !cr.in_claude_session {
        return false;
    }
    let mut message_changed = false;
    if cr.exited {
        session.claude_was_working = false;
        session.claude_last_working_title = None;
        if session.claude_message.is_some() {
            session.claude_message = None;
            message_changed = true;
        }
    } else {
        session.claude_was_working = cr.now_working;
        session.claude_last_working_title = if cr.now_working {
            Some(title.to_string())
        } else {
            None
        };
        if let Some(msg) = new_message {
            if session.claude_message.as_deref() != Some(msg) {
                session.claude_message = Some(msg.to_string());
                message_changed = true;
            }
        }
    }
    message_changed
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_terminal_session(
    id: String,
    profile: String,
    cols: u16,
    rows: u16,
    sync_group: String,
    cwd_send: Option<bool>,
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
    session.cwd_send = cwd_send.unwrap_or(true);
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
    let burst = settings.terminal.output_activity_burst.sanitized();
    let pty_cb_state = Arc::new(activity::PtyCallbackState::new(
        burst.window_ms,
        burst.threshold,
        burst.throttle_ms,
    ));
    let presets = osc_hooks::default_presets();
    let pty_handle = pty::spawn_pty(&session, move |data| {
        if pty_trace::is_pty_trace_enabled() {
            let signals = pty_trace::detect_terminal_signals(&data);
            tracing::info!(
                terminal_id = %terminal_id,
                direction = "pty->ui",
                bytes = data.len(),
                signals = ?signals,
                preview = %pty_trace::summarize_terminal_bytes(&data),
                "PTY chunk"
            );
        }

        // IMPORTANT: Each lock below is acquired and released independently (never nested).
        // Do NOT combine these blocks — nested locks would violate the AppState lock ordering
        // (terminals → output_buffers → known_claude_terminals) and risk deadlock.

        // Write to output buffer
        if let Ok(mut buffers) = state_for_pty.output_buffers.lock_or_err() {
            if let Some(buf) = buffers.get_mut(&terminal_id) {
                buf.push(&data);
            }
        }

        // ── DEC 2026 burst detection: sustained TUI activity ──
        // See activity::BurstDetector for sliding window + throttle logic.
        // The scanner carries a 7-byte tail across calls so markers straddling
        // PTY chunk boundaries are still detected (see #232).
        if pty_cb_state.scan_dec_sync_marker(&data) && pty_cb_state.burst_detector.record_hit() {
            let _ = app_clone.emit(
                EVENT_TERMINAL_OUTPUT_ACTIVITY,
                serde_json::json!({ "terminalId": terminal_id }),
            );
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

            // ── Claude Code title state machine (single pass) ──
            // Handles entry/exit detection, working→idle task completion,
            // and known_claude_terminals tracking for OSC 0/2 title changes.
            //
            // Lock strategy: each mutex is acquired and RELEASED before the next
            // is taken — no overlapping holds, so the #1 → #3 numerical ordering
            // rule (which prevents deadlock between concurrent threads holding
            // multiple locks) does not apply. In order:
            // 1. `resolve_claude_detected` briefly takes `known_claude_terminals`
            //    (#3) to check the command-detection fallback; released on return.
            // 2. `terminals` (#1) is taken to read was_working/prev_working_title.
            // 3. Terminals lock is re-acquired later to write back state via
            //    `apply_claude_title_state`.
            // 4. On `cr.entered` or `cr.exited`, `known_claude_terminals` (#3) is
            //    taken again to insert/remove the terminal ID.
            // This layout keeps non-Claude terminals off the #1 lock when possible.
            if event.code == 0 || event.code == 2 {
                let was_detected = resolve_claude_detected(
                    &pty_cb_state.claude_detected,
                    &state_for_pty.known_claude_terminals,
                    &terminal_id,
                );
                let (was_working, prev_working_title) = if was_detected {
                    if let Ok(terms) = state_for_pty.terminals.lock_or_err() {
                        match terms.get(&terminal_id) {
                            Some(s) => (s.claude_was_working, s.claude_last_working_title.clone()),
                            None => (false, None),
                        }
                    } else {
                        (false, None)
                    }
                } else {
                    (false, None)
                };

                let cr = claude_activity::process_claude_title(
                    &event.data,
                    was_detected,
                    was_working,
                    prev_working_title.as_deref(),
                );

                if cr.entered {
                    pty_cb_state
                        .claude_detected
                        .store(true, std::sync::atomic::Ordering::Relaxed);
                    if let Ok(mut known) = state_for_pty.known_claude_terminals.lock_or_err() {
                        known.insert(terminal_id.clone());
                    }
                    let _ = app_clone.emit(EVENT_CLAUDE_TERMINAL_DETECTED, &terminal_id);
                }

                // Determine claude_message before acquiring the terminals lock
                let new_message = if cr.exited {
                    None // will clear in the block below
                } else if cr.task_completed.is_some() {
                    // Task completed (working→idle): extract from output buffer
                    if let Ok(buffers) = state_for_pty.output_buffers.lock_or_err() {
                        buffers.get(&terminal_id).and_then(|buf| {
                            let recent = buf.recent_bytes(ACTIVITY_SCAN_BYTES);
                            claude_bullet::extract_claude_status_message(&recent)
                        })
                    } else {
                        None
                    }
                } else if cr.now_working {
                    // Working: use title text (strip spinner prefix)
                    let text = claude_activity::strip_claude_spinner_prefix(&event.data);
                    if text.is_empty() || text == "Claude Code" {
                        None
                    } else {
                        Some(text.to_string())
                    }
                } else {
                    None
                };

                // Outer guard keeps non-Claude terminals out of the terminals
                // lock entirely. `apply_claude_title_state` is also guarded
                // internally (defense in depth — see its doc comment).
                let mut message_changed = false;
                if cr.exited || cr.in_claude_session {
                    if let Ok(mut terms) = state_for_pty.terminals.lock_or_err() {
                        if let Some(session) = terms.get_mut(&terminal_id) {
                            message_changed = apply_claude_title_state(
                                session,
                                &cr,
                                &event.data,
                                new_message.as_deref(),
                            );
                        }
                    }
                }

                if cr.exited {
                    pty_cb_state
                        .claude_detected
                        .store(false, std::sync::atomic::Ordering::Relaxed);
                    // known_claude_terminals lock (#3) — separate from terminals (#1)
                    if let Ok(mut known) = state_for_pty.known_claude_terminals.lock_or_err() {
                        known.remove(&terminal_id);
                    }
                    // Also drop the grace-window entry so the shell fallback
                    // kicks in immediately instead of pinning "Claude" for
                    // up to `INTERACTIVE_APP_GRACE_WINDOW` after exit (#237).
                    activity::clear_interactive_app_grace_window(&state_for_pty, &terminal_id);
                }

                if message_changed {
                    let msg_payload = if cr.exited { None } else { new_message.clone() };
                    let _ = app_clone.emit(
                        EVENT_CLAUDE_MESSAGE_CHANGED,
                        serde_json::json!({
                            "terminalId": terminal_id,
                            "message": msg_payload,
                        }),
                    );
                }
                // While Claude is working (spinner title), emit outputActive=true on each
                // title change to keep the frontend's 2s timer alive. The spinner rotates
                // every ~500ms, so the timer never expires during active work. This is
                // necessary because Claude's "thinking" phase doesn't produce DEC 2026h
                // frames — only the response generation phase does. (§15.5 app-specific)
                if cr.now_working && cr.task_completed.is_none() {
                    let _ = app_clone.emit(
                        EVENT_TERMINAL_OUTPUT_ACTIVITY,
                        serde_json::json!({ "terminalId": terminal_id }),
                    );
                }
                if let Some(ref message) = cr.task_completed {
                    // Emit active:false BEFORE terminal-title-changed (emitted below at L346+).
                    // Both events originate from the same PTY callback thread, so ordering is
                    // guaranteed: the frontend receives active:false first, clears outputActive,
                    // then processes the title change — no 2-second DEC 2026 timeout lag.
                    // This is app-agnostic: any TUI working→idle transition triggers it.
                    let _ = app_clone.emit(
                        EVENT_TERMINAL_OUTPUT_ACTIVITY,
                        serde_json::json!({
                            "terminalId": terminal_id,
                            "active": false,
                        }),
                    );
                    // Synthetic exitCode=0: TUI apps don't emit OSC 133;D, so the
                    // isolated app module provides a completion signal here (§15.5).
                    let _ = super::ipc_dispatch::do_set_command_status(
                        &state_for_pty,
                        &app_clone,
                        &terminal_id,
                        None,
                        Some(0),
                    );
                    let _ = super::ipc_dispatch::do_notify(
                        &state_for_pty,
                        &app_clone,
                        &terminal_id,
                        message,
                        Some("success"),
                    );
                }
            }

            // ── Codex (OpenAI Codex CLI) title state machine ──
            // Mirror of the Claude block above but simpler: no working/idle
            // tracking, only entry + exit. Without this branch Codex sessions
            // had no way to clear `known_codex_terminals` once they ended,
            // so a pane that previously ran Codex stayed pinned as
            // InteractiveApp{Codex} forever (PR 242 follow-up).
            //
            // Lock note: `sync_known_caches` and `known_codex_terminals.lock`
            // each acquire and release the relevant mutex independently —
            // no overlap with the Claude-block locks above.
            if event.code == 0 || event.code == 2 {
                let was_detected = pty_cb_state.codex_detected.load(Ordering::Relaxed)
                    || state_for_pty
                        .known_codex_terminals
                        .lock_or_err()
                        .map(|known| known.contains(&terminal_id))
                        .unwrap_or(false);

                let cr_codex = codex_activity::process_codex_title(&event.data, was_detected);

                if cr_codex.entered {
                    pty_cb_state.codex_detected.store(true, Ordering::Relaxed);
                    // Mutually-exclusive: also clears any stale Claude
                    // membership left over from a previous session in this
                    // pane (and inserts into known_codex_terminals).
                    activity::sync_known_caches(&state_for_pty, &terminal_id, "Codex");
                }

                if cr_codex.exited {
                    pty_cb_state.codex_detected.store(false, Ordering::Relaxed);
                    if let Ok(mut known) = state_for_pty.known_codex_terminals.lock_or_err() {
                        known.remove(&terminal_id);
                    }
                    // Drop the grace-window entry so the shell fallback
                    // engages immediately instead of pinning "Codex" for
                    // up to `INTERACTIVE_APP_GRACE_WINDOW` after exit
                    // (#237 mirror for Codex).
                    activity::clear_interactive_app_grace_window(&state_for_pty, &terminal_id);
                }
            }

            // Emit structured title change event (OSC 0/2) for frontend activity detection.
            //
            // `detect_interactive_app_from_live_title` already walks every
            // fallback layer: direct title match → known_claude_terminals
            // fast path → Codex spinner+banner → grace window (#237). The
            // callback therefore only needs to call it once and emit the
            // result.
            if event.code == 0 || event.code == 2 {
                let interactive_app =
                    if let Ok(buffers) = state_for_pty.output_buffers.lock_or_err() {
                        activity::detect_interactive_app_from_live_title(
                            &state_for_pty,
                            &terminal_id,
                            &event.data,
                            buffers.get(&terminal_id),
                        )
                    } else {
                        activity::detect_interactive_app_from_live_title(
                            &state_for_pty,
                            &terminal_id,
                            &event.data,
                            None,
                        )
                    };
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
                let mut source_cwd_send = true;
                if let Ok(mut terms) = state_for_pty.terminals.lock_or_err() {
                    if let Some(session) = terms.get_mut(&terminal_id) {
                        source_cwd_send = session.cwd_send;
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
                            "cwdSend": source_cwd_send,
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

        // Claude Code status message is updated in two places:
        // 1. Working title → strip spinner prefix → claude_message (in OSC title handler below)
        // 2. Task completion (working→idle) → extract from output buffer via claude_bullet (below)

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
            .add_terminal(id.clone());
    }

    // Notify MCP resource bridge that the terminal catalog grew. This drives
    // `notifications/resources/list_changed` on all subscribed peers (advertised
    // via `enable_resources_list_changed`).
    if let Err(e) = app.emit(
        EVENT_TERMINALS_LIST_CHANGED,
        serde_json::json!({ "op": "created", "terminalId": id }),
    ) {
        tracing::warn!(error = %e, terminal_id = %id, "failed to emit terminals-list-changed on create");
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
    if pty_trace::is_pty_trace_enabled() {
        tracing::info!(
            terminal_id = %id,
            direction = "ui->pty",
            bytes = data.len(),
            signals = ?pty_trace::detect_terminal_signals(data.as_bytes()),
            preview = %pty_trace::summarize_terminal_bytes(data.as_bytes()),
            "PTY write"
        );
    }

    let ptys = state.pty_handles.lock_or_err()?;

    let handle = ptys
        .get(&id)
        .ok_or_else(|| format!("Session '{id}' not found"))?;

    handle.write(data.as_bytes())
}

#[tauri::command]
pub fn close_terminal_session(
    id: String,
    state: State<Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    // Remove PTY handle and terminate the child process tree before dropping it.
    {
        let mut ptys = state.pty_handles.lock_or_err()?;
        if let Some(handle) = ptys.remove(&id) {
            handle.terminate()?;
        }
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

    // Clean up Codex terminal tracking
    if let Ok(mut known) = state.known_codex_terminals.lock_or_err() {
        known.remove(&id);
    }

    // Clean up interactive-app grace window (#237) so a new terminal that
    // happens to reuse this ID does not inherit stale detection.
    activity::clear_interactive_app_grace_window(&state, &id);

    // Clean up notifications for this terminal
    if let Ok(mut notifs) = state.notifications.lock_or_err() {
        notifs.retain(|n| n.terminal_id != id);
    }

    // Notify MCP resource bridge that the terminal catalog shrank so clients
    // re-query `resources/list` and drop the stale `terminal://{id}` entry.
    if let Err(e) = app.emit(
        EVENT_TERMINALS_LIST_CHANGED,
        serde_json::json!({ "op": "closed", "terminalId": id }),
    ) {
        tracing::warn!(error = %e, terminal_id = %id, "failed to emit terminals-list-changed on close");
    }

    Ok(())
}

/// One shadow-cursor trace sample emitted by the UI. The UI batches
/// events for the duration of a single `requestAnimationFrame` tick so
/// the hot render path pays one IPC hop per frame instead of one per
/// event. The payload is a JSON-stringified snapshot so the Rust side
/// does not need to mirror every shadow-cursor field type.
#[derive(Deserialize)]
pub struct CursorTraceEvent {
    #[serde(alias = "ts")]
    pub timestamp: String,
    pub event: String,
    #[serde(default)]
    pub payload: Option<String>,
}

/// Diagnostic-only: flush a rAF-batched window of UI shadow-cursor
/// events into the same `tracing` stream that carries the PTY trace,
/// so the two layers interleave naturally in the log. Gated by
/// `LAYMUX_CURSOR_TRACE` (or `LAYMUX_PTY_TRACE` implicitly). A no-op
/// when either the flag is off or the batch is empty, so production
/// builds pay nothing beyond the UI-side gate that would have stopped
/// the `invoke` in the first place.
#[tauri::command]
pub fn log_terminal_trace_batch(
    terminal_id: String,
    events: Vec<CursorTraceEvent>,
) -> Result<(), String> {
    if !pty_trace::is_cursor_trace_enabled() {
        return Ok(());
    }
    for ev in events {
        tracing::info!(
            terminal_id = %terminal_id,
            ts = %ev.timestamp,
            event = %ev.event,
            payload = ev.payload.as_deref().unwrap_or(""),
            "UI cursor trace"
        );
    }
    Ok(())
}

/// Register a terminal as running Claude Code (single source of truth).
/// Called by the frontend when it detects Claude from command text (OSC 133 E).
/// The PTY callback also populates this from title detection, but the frontend
/// may detect earlier via command text (e.g., user typed "claude").
///
/// Three-step seeding so the strict-signal helpers (which reject cache-
/// only hits — see `is_claude_terminal_from_buffer` doc) still classify
/// the pane correctly during the multi-second Claude startup window
/// before the first "Claude Code" title arrives:
///
/// 1. Insert into `known_claude_terminals` (consumed by the cache + live
///    Claude-title disambiguator once spinner frames start).
/// 2. `sync_known_caches` mutual-excludes any stale `known_codex_terminals`
///    entry left over from a previous Codex session in this pane (PTY
///    Codex exit path may not have fired).
/// 3. Seed the grace window so the helpers' "no live signal" verdict
///    falls through to step 3 of `detect_interactive_app_from_live_title`,
///    which still reports Claude until the window expires.
pub fn mark_claude_terminal_inner(
    state: &AppState,
    id: &str,
) -> Result<bool, crate::error::AppError> {
    let inserted = {
        let mut known = state.known_claude_terminals.lock_or_err()?;
        known.insert(id.to_string())
    };
    activity::sync_known_caches(state, id, "Claude");
    activity::record_interactive_app_detection(state, id, "Claude");
    Ok(inserted)
}

#[tauri::command]
pub fn mark_claude_terminal(id: String, state: State<Arc<AppState>>) -> Result<bool, String> {
    mark_claude_terminal_inner(&state, &id).map_err(|e| e.to_string())
}

/// Register a terminal as running Codex (OpenAI Codex CLI).
///
/// Mirrors `mark_claude_terminal` for command-text detection. Codex resume can
/// enter directly into a restored TUI without first emitting an `OpenAI Codex`
/// title/banner in the recent scan window, so the frontend seeds the backend
/// tracker when OSC 133;E identifies a `codex ...` command.
#[tauri::command]
pub fn mark_codex_terminal(id: String, state: State<Arc<AppState>>) -> Result<bool, String> {
    mark_codex_terminal_inner(&state, &id).map_err(|e| e.to_string())
}

pub fn mark_codex_terminal_inner(
    state: &AppState,
    id: &str,
) -> Result<bool, crate::error::AppError> {
    let inserted = {
        let mut known = state.known_codex_terminals.lock_or_err()?;
        known.insert(id.to_string())
    };
    activity::sync_known_caches(state, id, "Codex");
    activity::record_interactive_app_detection(state, id, "Codex");
    Ok(inserted)
}

/// Check if a terminal is registered as running Claude Code.
#[tauri::command]
pub fn is_claude_terminal(id: String, state: State<Arc<AppState>>) -> Result<bool, String> {
    let known = state.known_claude_terminals.lock_or_err()?;
    Ok(known.contains(&id))
}

/// Check if a terminal is registered as running Codex.
#[tauri::command]
pub fn is_codex_terminal(id: String, state: State<Arc<AppState>>) -> Result<bool, String> {
    let known = state.known_codex_terminals.lock_or_err()?;
    Ok(known.contains(&id))
}

#[tauri::command]
pub fn set_terminal_cwd_send(
    terminal_id: String,
    send: bool,
    state: State<Arc<AppState>>,
) -> Result<(), String> {
    let mut terminals = state.terminals.lock_or_err()?;
    if let Some(session) = terminals.get_mut(&terminal_id) {
        session.cwd_send = send;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_activity::ClaudeTitleResult;

    fn test_session() -> TerminalSession {
        TerminalSession::new("t1".into(), TerminalConfig::default())
    }

    // ── resolve_claude_detected ──

    #[test]
    fn resolve_returns_true_when_atomic_set() {
        let atomic = AtomicBool::new(true);
        let known = Mutex::new(HashSet::new());
        assert!(resolve_claude_detected(&atomic, &known, "t1"));
    }

    #[test]
    fn resolve_falls_back_to_known_set_and_syncs_atomic() {
        // Command-detection path: atomic was never set because
        // `mark_claude_terminal` only touches `known_claude_terminals`.
        // The resolver must still report detected=true and lift the
        // atomic so subsequent title changes skip the locked lookup.
        let atomic = AtomicBool::new(false);
        let mut set = HashSet::new();
        set.insert("t1".to_string());
        let known = Mutex::new(set);

        assert!(resolve_claude_detected(&atomic, &known, "t1"));
        assert!(
            atomic.load(Ordering::Relaxed),
            "atomic must be synced so the next call takes the fast path"
        );
    }

    #[test]
    fn resolve_returns_false_when_neither_source_has_id() {
        let atomic = AtomicBool::new(false);
        let known = Mutex::new(HashSet::new());
        assert!(!resolve_claude_detected(&atomic, &known, "t1"));
        assert!(
            !atomic.load(Ordering::Relaxed),
            "a non-Claude terminal must not be promoted to detected"
        );
    }

    #[test]
    fn resolve_ignores_other_ids_in_known_set() {
        let atomic = AtomicBool::new(false);
        let mut set = HashSet::new();
        set.insert("someone-else".to_string());
        let known = Mutex::new(set);
        assert!(!resolve_claude_detected(&atomic, &known, "t1"));
        assert!(!atomic.load(Ordering::Relaxed));
    }

    #[test]
    fn mark_codex_terminal_seeds_backend_detection_for_resume_command() {
        let state = AppState::new();
        let tid = "t-codex-resume";

        state
            .known_claude_terminals
            .lock()
            .unwrap()
            .insert(tid.to_string());

        assert!(
            mark_codex_terminal_inner(&state, tid).unwrap(),
            "first Codex mark should report a new insert"
        );
        assert!(
            state.known_codex_terminals.lock().unwrap().contains(tid),
            "command-detected Codex must seed the persistent Codex tracker"
        );
        assert!(
            !state.known_claude_terminals.lock().unwrap().contains(tid),
            "Codex mark must clear stale Claude membership for the same pane"
        );
        assert_eq!(
            activity::detect_interactive_app_from_live_title(&state, tid, "", None),
            Some("Codex".to_string()),
            "grace window must classify Codex before a title/banner arrives"
        );
    }

    #[test]
    fn mark_codex_terminal_returns_false_on_duplicate_mark() {
        let state = AppState::new();
        let tid = "t-codex-duplicate";

        assert!(mark_codex_terminal_inner(&state, tid).unwrap());
        assert!(
            !mark_codex_terminal_inner(&state, tid).unwrap(),
            "second Codex mark should not report a new insert"
        );
    }

    // ── apply_claude_title_state ──

    #[test]
    fn apply_exit_clears_all_claude_state_and_reports_message_change() {
        let mut session = test_session();
        session.claude_was_working = true;
        session.claude_last_working_title = Some("\u{2736} Task".into());
        session.claude_message = Some("Task".into());

        let cr = ClaudeTitleResult {
            exited: true,
            ..Default::default()
        };
        let changed = apply_claude_title_state(&mut session, &cr, "bash", None);

        assert!(!session.claude_was_working);
        assert!(session.claude_last_working_title.is_none());
        assert!(session.claude_message.is_none());
        assert!(changed, "message was Some → caller must emit change event");
    }

    #[test]
    fn apply_exit_with_no_prior_message_returns_false() {
        let mut session = test_session();
        session.claude_was_working = true;
        session.claude_last_working_title = Some("\u{2736} Task".into());
        // claude_message already None

        let cr = ClaudeTitleResult {
            exited: true,
            ..Default::default()
        };
        let changed = apply_claude_title_state(&mut session, &cr, "bash", None);

        assert!(!session.claude_was_working);
        assert!(session.claude_last_working_title.is_none());
        assert!(
            !changed,
            "no prior message → no EVENT_CLAUDE_MESSAGE_CHANGED needed"
        );
    }

    #[test]
    fn apply_working_sets_state_and_remembers_full_title() {
        let mut session = test_session();
        let cr = ClaudeTitleResult {
            in_claude_session: true,
            now_working: true,
            ..Default::default()
        };
        let changed =
            apply_claude_title_state(&mut session, &cr, "\u{2736} Fix bug", Some("Fix bug"));

        assert!(session.claude_was_working);
        assert_eq!(
            session.claude_last_working_title.as_deref(),
            Some("\u{2736} Fix bug"),
            "full title (spinner prefix included) is stored so a later idle \
             transition can strip the prefix for the completion notification"
        );
        assert_eq!(session.claude_message.as_deref(), Some("Fix bug"));
        assert!(changed);
    }

    #[test]
    fn apply_idle_resets_working_and_clears_remembered_title() {
        let mut session = test_session();
        session.claude_was_working = true;
        session.claude_last_working_title = Some("\u{2736} Old".into());

        let cr = ClaudeTitleResult {
            in_claude_session: true,
            now_idle: true,
            ..Default::default()
        };
        apply_claude_title_state(&mut session, &cr, "\u{2733} Claude Code", None);

        assert!(!session.claude_was_working);
        assert!(session.claude_last_working_title.is_none());
    }

    #[test]
    fn apply_plain_title_resets_working_bug1_regression_guard() {
        // Bug #1 regression guard at the session-mutation layer: a plain
        // "Claude Code" title (no spinner, no ✳) between spinner and idle
        // MUST reset was_working=false and clear the remembered title. If
        // this regresses, the next ✳ idle will fire a spurious
        // "task completed" notification based on stale state.
        let mut session = test_session();
        session.claude_was_working = true;
        session.claude_last_working_title = Some("\u{2736} Working on task".into());

        let cr = ClaudeTitleResult {
            in_claude_session: true,
            now_working: false,
            now_idle: false,
            ..Default::default()
        };
        apply_claude_title_state(&mut session, &cr, "Claude Code", None);

        assert!(
            !session.claude_was_working,
            "plain title must reset was_working"
        );
        assert!(
            session.claude_last_working_title.is_none(),
            "plain title must invalidate the remembered working title"
        );
    }

    #[test]
    fn apply_message_update_only_when_different() {
        let mut session = test_session();
        session.claude_message = Some("Task".into());

        let cr = ClaudeTitleResult {
            in_claude_session: true,
            now_working: true,
            ..Default::default()
        };
        let changed = apply_claude_title_state(&mut session, &cr, "\u{2736} Task", Some("Task"));

        assert_eq!(session.claude_message.as_deref(), Some("Task"));
        assert!(
            !changed,
            "identical message must not emit spurious change event"
        );
    }

    #[test]
    fn apply_no_op_when_not_in_session_and_not_exited() {
        // Defense in depth: a result with both `exited=false` and
        // `in_claude_session=false` must not mutate session state even if
        // a future caller forgets the outer `cr.exited || cr.in_claude_session`
        // guard.
        let mut session = test_session();
        session.claude_was_working = true;
        session.claude_last_working_title = Some("\u{2736} Keep me".into());
        session.claude_message = Some("Keep me".into());

        let cr = ClaudeTitleResult::default(); // all flags false
        let changed = apply_claude_title_state(&mut session, &cr, "bash", None);

        assert!(session.claude_was_working, "state must be preserved");
        assert_eq!(
            session.claude_last_working_title.as_deref(),
            Some("\u{2736} Keep me")
        );
        assert_eq!(session.claude_message.as_deref(), Some("Keep me"));
        assert!(!changed);
    }

    #[test]
    fn apply_working_plain_idle_chain_session_end_state_is_clean() {
        // Chain the three session mutations in order (mirrors the PTY
        // callback's per-title loop). After step 2 (plain title), session
        // state must be clean so step 3 (idle) cannot consume a stale
        // working title.
        let mut session = test_session();

        // Step 1: working
        apply_claude_title_state(
            &mut session,
            &ClaudeTitleResult {
                in_claude_session: true,
                now_working: true,
                ..Default::default()
            },
            "\u{2736} Fix bug",
            Some("Fix bug"),
        );
        assert!(session.claude_was_working);
        assert_eq!(
            session.claude_last_working_title.as_deref(),
            Some("\u{2736} Fix bug")
        );

        // Step 2: plain "Claude Code"
        apply_claude_title_state(
            &mut session,
            &ClaudeTitleResult {
                in_claude_session: true,
                ..Default::default()
            },
            "Claude Code",
            None,
        );
        assert!(!session.claude_was_working);
        assert!(session.claude_last_working_title.is_none());

        // Step 3: idle ✳. new_message=None because process_claude_title
        // would see was_working=false from step 2 and not emit
        // task_completed.
        apply_claude_title_state(
            &mut session,
            &ClaudeTitleResult {
                in_claude_session: true,
                now_idle: true,
                ..Default::default()
            },
            "\u{2733} Claude Code",
            None,
        );
        assert!(!session.claude_was_working);
        assert!(session.claude_last_working_title.is_none());
    }

    #[test]
    fn apply_overwrites_remembered_title_on_each_working_event() {
        // Two successive working titles: the second must overwrite, not
        // append. Guards against accidental accumulation if the
        // `Some(...)` branch is ever restructured.
        let mut session = test_session();

        apply_claude_title_state(
            &mut session,
            &ClaudeTitleResult {
                in_claude_session: true,
                now_working: true,
                ..Default::default()
            },
            "\u{2736} First",
            None,
        );
        apply_claude_title_state(
            &mut session,
            &ClaudeTitleResult {
                in_claude_session: true,
                now_working: true,
                ..Default::default()
            },
            "\u{2736} Second",
            None,
        );

        assert_eq!(
            session.claude_last_working_title.as_deref(),
            Some("\u{2736} Second")
        );
    }
}
