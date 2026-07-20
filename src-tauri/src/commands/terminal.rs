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
use crate::path_utils;
use crate::pty;
use crate::pty_trace;
use crate::remote_server::{begin_human_control_operation, HumanControlOrigin, HumanControlPermit};
use crate::state::AppState;
use crate::terminal::{TerminalConfig, TerminalSession};
use crate::terminal_output::{self, TerminalOutputAttachment};
use crate::terminal_protocol::encode_terminal_input;

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
    viewer: Option<super::ViewerStartupRequest>,
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
    if viewer.is_some() && startup_command_override.is_some() {
        return Err("Viewer startup and startup command override are mutually exclusive".into());
    }

    let viewer_startup = if let Some(request) = viewer.as_ref() {
        let selected_profile = matched_profile
            .ok_or_else(|| format!("Terminal profile '{profile}' does not exist"))?;
        let default_wsl_distro =
            super::viewer_requires_default_wsl_distro(request, selected_profile)
                .then(path_utils::get_default_wsl_distro)
                .flatten();
        super::build_viewer_startup(
            request,
            selected_profile,
            &settings.file_explorer.extension_viewers,
            default_wsl_distro.as_deref(),
        )?
    } else {
        String::new()
    };

    // The unstructured override is reserved for Claude session restoration.
    let validated_override =
        startup_command_override.filter(|cmd| super::is_valid_startup_command_override(cmd));
    let startup_command = if !viewer_startup.is_empty() {
        viewer_startup
    } else {
        validated_override.unwrap_or_else(|| {
            matched_profile
                .map(|p| p.startup_command.clone())
                .unwrap_or_default()
        })
    };
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

    // Check and reserve while holding the terminal catalog lock. Close takes
    // the same lock before selecting a generation, so it cannot observe an
    // empty output registry and then tear down this newly-created id.
    let output_registration = {
        let terminals = state.terminals.lock_or_err()?;
        if terminals.contains_key(&id) {
            return Err(format!("Session '{id}' already exists"));
        }

        // Install one generation-scoped protocol/ring session before PTY
        // output can arrive. Any error before `commit()` rolls this exact
        // generation back without touching a replacement session.
        terminal_output::register_terminal_output_session(
            &state.terminal_protocol_states,
            &state.output_buffers,
            &id,
        )?
    };
    let output_session = output_registration.session();

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
    let pty_output_session = Arc::clone(&output_session);
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

        // The protocol gate and output ring are intentionally nested in the
        // documented protocol → output order so attach observes one prefix.
        // Every other AppState lock below remains independent of that pair.

        // Parse protocol modes and append bytes under one prefix gate. The v2
        // event carries the exact byte range for listener-before-attach clients.
        match pty_output_session.record_output(&data) {
            Ok(Some(delta)) => {
                let _ = app_clone.emit(
                    &format!("{EVENT_TERMINAL_OUTPUT_V2_PREFIX}{terminal_id}"),
                    delta,
                );
            }
            Ok(None) => {
                tracing::debug!(
                    terminal_id = %terminal_id,
                    generation = pty_output_session.generation(),
                    "dropped PTY output from retired terminal generation"
                );
                return;
            }
            Err(err) => {
                tracing::warn!(terminal_id = %terminal_id, error = %err, "failed to record PTY output");
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

            // Propagated to the `terminal-title-changed` payload below so the
            // frontend's title handler can distinguish "the OSC 0 title just
            // happens to read like a shell prompt" (issue #234 — keep Claude
            // pinned) from "the PTY callback's Claude/Codex state machine
            // just confirmed exit" (must clear the interactive-app pin).
            let mut interactive_app_exited = false;

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

                let mut cr = claude_activity::process_claude_title(
                    &event.data,
                    was_detected,
                    was_working,
                    prev_working_title.as_deref(),
                );

                // False-exit suppression (ADR-0009). `process_claude_title`
                // reports `exited` whenever the new title is not Claude-shaped
                // — but a transient non-Claude title (a subprocess's OSC title,
                // a path-like prompt, a compaction frame) is NOT Claude exiting
                // if the claude process is still alive under this PTY. The
                // process tree is ground truth: when it still sees `claude`,
                // neutralize the exit so detection, the cache, the grace window,
                // and `claude_was_working` survive untouched, and no spurious
                // "task completed" notification fires. The genuine exit (process
                // gone) flows through unchanged.
                if cr.exited
                    && crate::process_tree::suppresses_false_exit(
                        "Claude",
                        crate::process_tree::interactive_app_in_pty_fresh(
                            &state_for_pty,
                            &terminal_id,
                        ),
                    )
                {
                    cr.exited = false;
                    cr.task_completed = None;
                }

                if cr.entered {
                    pty_cb_state
                        .claude_detected
                        .store(true, std::sync::atomic::Ordering::Relaxed);
                    if let Ok(mut known) = state_for_pty.known_claude_terminals.lock_or_err() {
                        known.insert(terminal_id.clone());
                    }
                    // A fresh entry invalidates any pending exit marker from
                    // a previous session in the same pane — otherwise the
                    // buffer-scan strong-signal suppression would mis-block
                    // an immediate Claude relaunch.
                    activity::clear_interactive_app_exit_marker(&state_for_pty, &terminal_id);
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
                    // Record the exit so the next OSC 0/2 title (typically a
                    // shell prompt) cannot re-pin the cache via the stale
                    // `Claude Code` banner still resident in the 16KB recent
                    // window. Without this marker `is_claude_terminal_from_buffer`
                    // fires its strong-signal branch and the frontend keeps
                    // showing InteractiveApp{Claude} until the banner scrolls
                    // out — sometimes for many minutes on an idle shell.
                    activity::record_interactive_app_exit(&state_for_pty, &terminal_id, "Claude");
                    // Tell the frontend's title-changed handler to drop the
                    // interactive-app pin even though
                    // `ClaudeActivityHandler.shouldPreserveActivityOnTitleReset`
                    // would otherwise hold it across title resets (issue #234).
                    interactive_app_exited = true;
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

                let mut cr_codex = codex_activity::process_codex_title(&event.data, was_detected);

                // False-exit suppression (ADR-0009), mirror of the Claude path:
                // a non-Codex title while the `codex` process is still alive
                // under this PTY is a transient title, not an exit.
                if cr_codex.exited
                    && crate::process_tree::suppresses_false_exit(
                        "Codex",
                        crate::process_tree::interactive_app_in_pty_fresh(
                            &state_for_pty,
                            &terminal_id,
                        ),
                    )
                {
                    cr_codex.exited = false;
                }

                if cr_codex.entered {
                    pty_cb_state.codex_detected.store(true, Ordering::Relaxed);
                    // Mutually-exclusive: also clears any stale Claude
                    // membership left over from a previous session in this
                    // pane (and inserts into known_codex_terminals). It
                    // also clears the recently-exited marker as part of
                    // its confirmed-detection contract.
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
                    // Mirror of the Claude exit-marker recording above: the
                    // 16KB recent window still carries the `OpenAI Codex`
                    // banner (in OSC titles AND in the body banner that
                    // `recent_buffer_contains` scans), and without the
                    // marker the next shell-prompt title re-pins Codex.
                    activity::record_interactive_app_exit(&state_for_pty, &terminal_id, "Codex");
                    // Mirror of the Claude exit flag: tell the frontend to
                    // unpin the interactive-app activity even though Codex's
                    // handler also preserves across title resets.
                    interactive_app_exited = true;
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
                        // True iff the Claude/Codex title state machine just
                        // observed an exit. Frontend uses this to override
                        // its `shouldPreserveActivityOnTitleReset` guard
                        // (which would otherwise keep the pane pinned as
                        // InteractiveApp{Claude} after `/exit`, since the
                        // following PowerShell-prompt title still passes
                        // the heuristic guard from issue #234).
                        "interactiveAppExited": interactive_app_exited,
                    }),
                );
            }

            // Proactive CWD update (single source of truth in session.cwd).
            // Interactive apps can trigger shell prompt/title repaints that
            // re-emit stale OSC 7/9;9 values, and a running command can emit
            // OSC 7 of its own; both are noise that must not mutate the local
            // CWD. Apply the same source-activity gate (Shell-only) before
            // local state is mutated or events are emitted.
            if event.code == 7 || (event.code == 9 && event.param.as_deref() == Some("9")) {
                let accept_source_cwd =
                    if let Ok(buffers) = state_for_pty.output_buffers.lock_or_err() {
                        super::ipc_dispatch::should_accept_source_cwd_event(
                            &state_for_pty,
                            &terminal_id,
                            buffers.get(&terminal_id),
                        )
                    } else {
                        true
                    };
                if !accept_source_cwd {
                    tracing::debug!(
                        terminal_id,
                        cwd = %event.data,
                        "terminal cwd update suppressed: source terminal has non-shell activity"
                    );
                    continue;
                }

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
        let timer_output_session = Arc::clone(&output_session);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(NOTIFY_GATE_FALLBACK_MS));
            if let Ok(mut terms) = state_for_timer.terminals.lock_or_err() {
                let same_generation = terminal_output::terminal_output_session_for(
                    &state_for_timer.terminal_protocol_states,
                    &timer_terminal_id,
                )
                .ok()
                .flatten()
                .is_some_and(|current| Arc::ptr_eq(&current, &timer_output_session));
                if same_generation {
                    let Some(session) = terms.get_mut(&timer_terminal_id) else {
                        return;
                    };
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

    // Publish every id-keyed table and commit the output generation while the
    // terminal catalog lock excludes close/create for this id. In particular,
    // close cannot retire the generation between the terminal and PTY inserts.
    let mut terminals = match state.terminals.lock_or_err() {
        Ok(terminals) => terminals,
        Err(error) => {
            return Err(terminate_uninstalled_pty(&pty_handle, error.to_string()));
        }
    };
    let mut groups = match state.sync_groups.lock_or_err() {
        Ok(groups) => groups,
        Err(error) => {
            drop(terminals);
            return Err(terminate_uninstalled_pty(&pty_handle, error.to_string()));
        }
    };
    let mut ptys = match state.pty_handles.lock_or_err() {
        Ok(ptys) => ptys,
        Err(error) => {
            drop(groups);
            drop(terminals);
            return Err(terminate_uninstalled_pty(&pty_handle, error.to_string()));
        }
    };
    terminals.insert(id.clone(), session);
    ptys.insert(id.clone(), pty_handle);
    if !sync_group.is_empty() {
        groups
            .entry(sync_group.clone())
            .or_insert_with(|| crate::terminal::SyncGroup::new(sync_group.clone()))
            .add_terminal(id.clone());
    }
    drop(ptys);
    drop(groups);

    // The terminal/session/PTY tables are now fully installed. From this point
    // normal close owns retirement; the create rollback guard is disarmed.
    if let Err(error) = output_registration.commit() {
        let handle = state
            .pty_handles
            .lock_or_err()
            .ok()
            .and_then(|mut ptys| ptys.remove(&id));
        terminals.remove(&id);
        if !sync_group.is_empty() {
            if let Ok(mut groups) = state.sync_groups.lock_or_err() {
                if let Some(group) = groups.get_mut(&sync_group) {
                    group.remove_terminal(&id);
                    if group.terminal_ids.is_empty() {
                        groups.remove(&sync_group);
                    }
                }
            }
        }
        drop(terminals);
        return Err(match handle {
            Some(handle) => terminate_uninstalled_pty(&handle, error),
            None => format!("{error}; failed to recover the uncommitted PTY handle"),
        });
    }
    drop(terminals);

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

fn terminate_uninstalled_pty(handle: &pty::PtyHandle, error: impl std::fmt::Display) -> String {
    let error = error.to_string();
    match handle.terminate() {
        Ok(()) => error,
        Err(cleanup_error) => {
            format!("{error}; failed to terminate uninstalled PTY: {cleanup_error}")
        }
    }
}

#[tauri::command]
pub fn resize_terminal(
    id: String,
    cols: u16,
    rows: u16,
    state: State<Arc<AppState>>,
) -> Result<(), String> {
    resize_terminal_inner(&state, &id, cols, rows, HumanControlOrigin::Local)
}

pub fn resize_terminal_inner(
    state: &AppState,
    id: &str,
    cols: u16,
    rows: u16,
    origin: HumanControlOrigin,
) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Err("terminal size must be positive".into());
    }
    let permit = begin_human_control_operation(state, origin, id)?;
    permit.ensure_current()?;
    {
        let mut terminals = state.terminals.lock_or_err()?;
        let session = terminals
            .get_mut(id)
            .ok_or_else(|| format!("Session '{id}' not found"))?;
        session.config.cols = cols;
        session.config.rows = rows;
    }

    let handle = state.pty_handles.lock_or_err()?.get(id).cloned();
    permit.ensure_current()?;
    if let Some(handle) = handle {
        // Never retain the terminal or PTY map lock across platform I/O.
        let deadline = permit.deadline();
        let pending = permit.enqueue_pty_job(|| handle.enqueue_resize(cols, rows, deadline))?;
        let result = handle.await_enqueued_control_job(pending, deadline, || permit.is_current());
        // Resize is a single synchronous platform operation. A post-check
        // reports an owner change during it as ambiguous; owner transitions
        // are otherwise barred while this permit remains registered.
        return finish_human_control_io(permit, &handle, result);
    }

    permit.finish()
}

/// Finish one owner-checked physical operation without publishing a false
/// cancellation acknowledgement. A platform call that outlives bounded PTY
/// teardown transfers its worker completion token into the owner barrier.
fn finish_human_control_io(
    permit: HumanControlPermit<'_>,
    handle: &pty::PtyHandle,
    result: Result<(), String>,
) -> Result<(), String> {
    match result {
        Ok(()) => permit.finish(),
        Err(error) => {
            if let Some(completion) = handle.pending_control_completion() {
                permit
                    .quarantine(completion)
                    .map_err(|quarantine_error| {
                        format!(
                            "{error}; failed to retain terminal cancellation barrier: {quarantine_error}"
                        )
                    })?;
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub fn write_to_terminal(
    id: String,
    data: String,
    state: State<Arc<AppState>>,
) -> Result<(), String> {
    write_to_terminal_inner(&state, &id, data.as_bytes(), HumanControlOrigin::Local)
}

pub fn write_to_terminal_inner(
    state: &AppState,
    id: &str,
    data: &[u8],
    origin: HumanControlOrigin,
) -> Result<(), String> {
    if pty_trace::is_pty_trace_enabled() {
        tracing::info!(
            terminal_id = %id,
            direction = "ui->pty",
            bytes = data.len(),
            signals = ?pty_trace::detect_terminal_signals(data),
            preview = %pty_trace::summarize_terminal_bytes(data),
            "PTY write"
        );
    }

    let permit = begin_human_control_operation(state, origin, id)?;
    let handle = state
        .pty_handles
        .lock_or_err()?
        .get(id)
        .cloned()
        .ok_or_else(|| format!("Session '{id}' not found"))?;

    let deadline = permit.deadline();
    let pending = permit.enqueue_pty_job(|| handle.enqueue_write(data, deadline))?;
    let result = handle.await_enqueued_control_job(pending, deadline, || permit.is_current());
    finish_human_control_io(permit, &handle, result)
}

#[tauri::command]
pub fn write_terminal_input(
    id: String,
    text: String,
    submit: bool,
    state: State<Arc<AppState>>,
) -> Result<(), String> {
    write_terminal_input_inner(&state, &id, &text, submit, HumanControlOrigin::Local)
}

pub fn write_terminal_input_inner(
    state: &AppState,
    id: &str,
    text: &str,
    submit: bool,
    origin: HumanControlOrigin,
) -> Result<(), String> {
    let permit = begin_human_control_operation(state, origin, id)?;
    permit.ensure_current()?;
    let protocol_gate = terminal_output::protocol_gate_for(&state.terminal_protocol_states, id)?;
    let bracketed_paste = {
        let protocol = protocol_gate.lock_or_err()?;
        protocol.bracketed_paste()
    };
    // Encode only the body here; the submit CR is written as a separate,
    // delayed PTY write below. Fusing text and CR into one write makes a TUI
    // (Codex/Claude Code) or shell (PowerShell/PSReadLine, WSL) fold the CR into
    // the bracketed paste of the body, so the line is typed but never submitted
    // until a second lone CR arrives (#490; matches the MCP path's #314 split).
    let body = encode_terminal_input(
        text,
        false,
        bracketed_paste,
        TERMINAL_STRUCTURED_INPUT_MAX_BYTES,
    )
    .map_err(|err| err.to_string())?;
    permit.ensure_current()?;
    if body.is_empty() && !submit {
        return permit.finish();
    }

    let handle = state
        .pty_handles
        .lock_or_err()?
        .get(id)
        .cloned()
        .ok_or_else(|| format!("Session '{id}' not found"))?;
    let deadline = permit.deadline();

    if !body.is_empty() {
        permit.ensure_current()?;
        let pending = permit.enqueue_pty_job(|| handle.enqueue_write(&body, deadline))?;
        let result = handle.await_enqueued_control_job(pending, deadline, || permit.is_current());
        if result.is_err() {
            return finish_human_control_io(permit, &handle, result);
        }
    }

    if !submit {
        return finish_human_control_io(permit, &handle, Ok(()));
    }

    // Only gap the CR when a body preceded it; a lone Enter needs no delay.
    if !body.is_empty() {
        std::thread::sleep(std::time::Duration::from_millis(ENTER_SUBMIT_CR_DELAY_MS));
    }
    permit.ensure_current()?;
    let pending = permit.enqueue_pty_job(|| handle.enqueue_write(b"\r", deadline))?;
    let result = handle.await_enqueued_control_job(pending, deadline, || permit.is_current());
    finish_human_control_io(permit, &handle, result)
}

#[tauri::command]
pub fn attach_terminal_output(
    id: String,
    state: State<Arc<AppState>>,
) -> Result<TerminalOutputAttachment, String> {
    terminal_output::attach_terminal_output(
        &state.terminal_protocol_states,
        &state.output_buffers,
        &id,
        TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES,
    )
}

#[tauri::command]
pub fn close_terminal_session(
    id: String,
    state: State<Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    // Hold the terminal catalog from generation selection through all
    // id-keyed cleanup. Create performs its duplicate check and generation
    // reservation under the same lock, so close cannot consume state from a
    // newer terminal that reused this id.
    let mut terminals = state.terminals.lock_or_err()?;
    terminal_output::retire_terminal_output_for_close(
        &state.terminal_protocol_states,
        &state.output_buffers,
        &id,
    )?;

    let session = terminals
        .remove(&id)
        .ok_or_else(|| format!("Session '{id}' not found"))?;
    let handle = state.pty_handles.lock_or_err()?.remove(&id);

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

    // Clean up the per-terminal write/exec lock (#427). The table is now
    // process-global on AppState, so without this it would grow unbounded as
    // terminals open and close over a long session.
    if let Ok(mut locks) = state.exec_locks.lock() {
        locks.remove(&id);
    }

    // Clean up interactive-app grace window (#237) so a new terminal that
    // happens to reuse this ID does not inherit stale detection.
    activity::clear_interactive_app_grace_window(&state, &id);
    // Mirror cleanup for the recently-exited marker so a fresh terminal
    // reusing this ID does not start under a stale Claude/Codex exit
    // suppression.
    activity::clear_interactive_app_exit_marker(&state, &id);

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

    // The old handle was selected while create was excluded, but potentially
    // blocking platform shutdown happens only after every AppState lock is
    // released. A replacement generation may now start without being mistaken
    // for the process being terminated here.
    drop(terminals);
    if let Some(handle) = handle {
        handle.terminate()?;
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

/// 1회성 CWD 전파 (issue #293).
///
/// 컨트롤 패널의 "현재 CWD 1회 전파" 버튼이 호출한다. 소스 터미널의 현재
/// `session.cwd` 와 sync group 을 읽어 `do_sync_cwd(force=true)` 로 그룹에 한 번
/// 밀어넣는다. 지속 동기화(cwd_send/cwd_receive 토글)와 달리, 평소 동기화를 꺼둔
/// file explorer/viewer 도 이 순간의 CWD 로 따라오게 만드는 것이 목적이다.
///
/// 소스 터미널에 CWD 가 아직 없으면(예: OSC 7 미발행 셸) 전파할 것이 없으므로
/// no-op 으로 Ok 를 돌려준다.
#[tauri::command]
pub fn propagate_cwd_once(
    terminal_id: String,
    state: State<Arc<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    let Some((cwd, sync_group)) = resolve_propagate_source(&state, &terminal_id)? else {
        // 전파할 CWD 가 없음 — 사용자에게 에러를 던질 필요는 없다.
        return Ok(());
    };

    super::ipc_dispatch::do_sync_cwd(
        &state,
        &app,
        &terminal_id,
        &sync_group,
        &cwd,
        false,
        None,
        true,
    )
    .map(|_| ())
}

/// `propagate_cwd_once` 의 소스 해석 단계만 분리한 순수 헬퍼 (AppHandle 불필요).
///
/// - 세션 없음 → `Err`
/// - 세션은 있으나 CWD 가 없거나 빈 문자열 → `Ok(None)` (전파 no-op)
/// - 그 외 → `Ok(Some((cwd, sync_group)))`
///
/// P2(issue #293): sync group 은 `session.config.sync_group` 이 아니라 멤버십의
/// 권위 소스인 `state.sync_groups` 에서 현재 그룹을 조회한다. `update_terminal_sync_group`
/// 은 `state.sync_groups` membership 만 옮기고 `session.config.sync_group` 은 갱신하지
/// 않으므로, config 를 읽으면 런타임에 그룹이 바뀐 터미널이 stale 한 옛 그룹으로
/// 전파되거나 no-op 이 된다. 권위 소스를 단일화(sync_groups 조회)해 stale 위험을 없앤다.
///
/// 락 순서: `terminals`(1) → `sync_groups`(8) (state.rs Lock ordering 준수).
fn resolve_propagate_source(
    state: &AppState,
    terminal_id: &str,
) -> Result<Option<(String, String)>, String> {
    let cwd = {
        let terminals = state.terminals.lock_or_err()?;
        let session = terminals
            .get(terminal_id)
            .ok_or_else(|| format!("Session '{terminal_id}' not found"))?;
        session.cwd.clone().filter(|c| !c.is_empty())
    };

    let Some(cwd) = cwd else {
        return Ok(None);
    };

    // 현재 멤버십 기준으로 이 terminal 이 속한 그룹을 찾는다(권위 소스).
    // 그룹에 속하지 않으면 빈 문자열 — do_sync_cwd 가 group_id 로 받아 no-op 대상이 된다.
    let sync_group = {
        let groups = state.sync_groups.lock_or_err()?;
        groups
            .iter()
            .find(|(_, g)| g.terminal_ids.iter().any(|id| id == terminal_id))
            .map(|(name, _)| name.clone())
            .unwrap_or_default()
    };

    Ok(Some((cwd, sync_group)))
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
                false,
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
    use crate::remote_server::RemoteControlLease;
    use std::io::Write;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    struct SharedTestWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedTestWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct BlockingTestWriter {
        started: Option<mpsc::Sender<()>>,
        release: mpsc::Receiver<()>,
    }

    impl Write for BlockingTestWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if let Some(started) = self.started.take() {
                let _ = started.send(());
            }
            self.release
                .recv_timeout(Duration::from_secs(5))
                .map_err(std::io::Error::other)?;
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn enable_test_remote_access(state: &AppState) {
        let mut runtime = state.remote_access.lock_or_err().unwrap();
        runtime.enabled = true;
        runtime.auth_token = Some("test-token".into());
    }

    fn set_test_remote_lease(state: &AppState, lease_id: &str) {
        state.remote_control.lock_or_err().unwrap().lease = Some(RemoteControlLease {
            lease_id: lease_id.into(),
            remote_addr: "127.0.0.1:1".into(),
            client_name: None,
            last_heartbeat: Instant::now(),
        });
    }

    fn remote_origin(lease_id: &str) -> HumanControlOrigin {
        HumanControlOrigin::Remote {
            lease_id: lease_id.into(),
        }
    }

    fn test_session() -> TerminalSession {
        TerminalSession::new("t1".into(), TerminalConfig::default())
    }

    #[test]
    fn human_raw_structured_and_resize_paths_share_the_same_owner_gate() {
        let state = AppState::new();
        enable_test_remote_access(&state);
        state
            .terminals
            .lock_or_err()
            .unwrap()
            .insert("t1".into(), test_session());
        state
            .terminal_protocol_states
            .lock_or_err()
            .unwrap()
            .insert("t1".into(), terminal_output::new_protocol_gate());
        let written = Arc::new(Mutex::new(Vec::new()));
        state.pty_handles.lock_or_err().unwrap().insert(
            "t1".into(),
            pty::PtyHandle::from_test_writer(Box::new(SharedTestWriter(Arc::clone(&written)))),
        );

        write_to_terminal_inner(&state, "t1", b"local-raw", HumanControlOrigin::Local).unwrap();
        write_terminal_input_inner(&state, "t1", "local-input", true, HumanControlOrigin::Local)
            .unwrap();

        set_test_remote_lease(&state, "lease-1");
        assert!(write_to_terminal_inner(
            &state,
            "t1",
            b"rejected-local",
            HumanControlOrigin::Local,
        )
        .is_err());
        assert!(write_terminal_input_inner(
            &state,
            "t1",
            "rejected-local",
            true,
            HumanControlOrigin::Local,
        )
        .is_err());
        assert!(write_to_terminal_inner(&state, "t1", b"wrong", remote_origin("wrong")).is_err());
        assert!(
            write_terminal_input_inner(&state, "t1", "wrong", true, remote_origin("wrong"),)
                .is_err()
        );

        write_to_terminal_inner(&state, "t1", b"remote-raw", remote_origin("lease-1")).unwrap();
        write_terminal_input_inner(&state, "t1", "remote-input", true, remote_origin("lease-1"))
            .unwrap();

        // Config-only resize still passes through the exact same owner gate
        // when a PTY handle is absent (session restoration window).
        state.pty_handles.lock_or_err().unwrap().remove("t1");
        assert!(resize_terminal_inner(&state, "t1", 90, 30, HumanControlOrigin::Local).is_err());
        assert!(resize_terminal_inner(&state, "t1", 90, 30, remote_origin("wrong")).is_err());
        resize_terminal_inner(&state, "t1", 120, 40, remote_origin("lease-1")).unwrap();

        let session = state.terminals.lock_or_err().unwrap();
        let session = session.get("t1").unwrap();
        assert_eq!((session.config.cols, session.config.rows), (120, 40));
        assert_eq!(
            &*written.lock().unwrap(),
            b"local-rawlocal-input\rremote-rawremote-input\r"
        );
    }

    #[test]
    fn structured_and_raw_writes_enqueue_in_permit_registration_order() {
        let state = Arc::new(AppState::new());
        let protocol_gate = terminal_output::new_protocol_gate();
        state
            .terminal_protocol_states
            .lock_or_err()
            .unwrap()
            .insert("t1".into(), Arc::clone(&protocol_gate));
        let written = Arc::new(Mutex::new(Vec::new()));
        state.pty_handles.lock_or_err().unwrap().insert(
            "t1".into(),
            pty::PtyHandle::from_test_writer(Box::new(SharedTestWriter(Arc::clone(&written)))),
        );

        // Keep the first structured operation between permit registration and
        // PTY enqueue. A later raw key must not overtake it in the worker FIFO.
        let protocol_guard = protocol_gate.lock_or_err().unwrap();
        let structured_state = Arc::clone(&state);
        let structured = thread::spawn(move || {
            write_terminal_input_inner(
                &structured_state,
                "t1",
                "structured",
                false,
                HumanControlOrigin::Local,
            )
        });

        let registration_deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if state
                .remote_control
                .lock_or_err()
                .unwrap()
                .has_active_operations()
            {
                break;
            }
            assert!(
                Instant::now() < registration_deadline,
                "structured input did not register its permit"
            );
            thread::yield_now();
        }

        let (raw_started_tx, raw_started_rx) = mpsc::channel();
        let (raw_result_tx, raw_result_rx) = mpsc::channel();
        let raw_state = Arc::clone(&state);
        let raw = thread::spawn(move || {
            raw_started_tx.send(()).unwrap();
            let result =
                write_to_terminal_inner(&raw_state, "t1", b"raw", HumanControlOrigin::Local);
            raw_result_tx.send(result).unwrap();
        });
        raw_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("raw writer thread should start");

        assert!(
            matches!(
                raw_result_rx.recv_timeout(Duration::from_millis(100)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ),
            "later raw input must wait for the earlier structured enqueue"
        );
        assert!(written.lock().unwrap().is_empty());

        drop(protocol_guard);
        structured.join().unwrap().unwrap();
        raw_result_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("raw input should finish after structured enqueue")
            .unwrap();
        raw.join().unwrap();
        assert_eq!(&*written.lock().unwrap(), b"structuredraw");
    }

    #[test]
    fn structured_write_holds_no_app_state_table_lock_during_pty_io() {
        let state = Arc::new(AppState::new());
        let protocol_gate = terminal_output::new_protocol_gate();
        state
            .terminal_protocol_states
            .lock_or_err()
            .unwrap()
            .insert("t1".into(), Arc::clone(&protocol_gate));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        state.pty_handles.lock_or_err().unwrap().insert(
            "t1".into(),
            pty::PtyHandle::from_test_writer(Box::new(BlockingTestWriter {
                started: Some(started_tx),
                release: release_rx,
            })),
        );

        let worker_state = Arc::clone(&state);
        // submit=false so the body is a single blocking write; a submit would
        // add a second, delayed CR write (#490) that the one-shot BlockingTest-
        // Writer release channel can't serve. The no-table-lock-during-I/O
        // invariant is identical for both writes.
        let worker = thread::spawn(move || {
            write_terminal_input_inner(
                &worker_state,
                "t1",
                "blocking input",
                false,
                HumanControlOrigin::Local,
            )
        });
        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("test writer should enter physical I/O");

        assert!(state.pty_handles.try_lock().is_ok());
        assert!(state.terminals.try_lock().is_ok());
        assert!(state.terminal_protocol_states.try_lock().is_ok());
        assert!(protocol_gate.try_lock().is_ok());
        assert!(state.remote_access.try_lock().is_ok());
        assert!(state.remote_control.try_lock().is_ok());

        release_tx.send(()).unwrap();
        worker.join().unwrap().unwrap();
    }

    /// #490: a submit must reach the PTY as the body followed by a *separate*
    /// CR write, not one fused `text\r` buffer. Fusing them makes a TUI/shell
    /// fold the CR into a bracketed paste of the body, typing the line without
    /// submitting it. A per-write recorder proves the two are distinct writes.
    #[test]
    fn structured_submit_writes_body_and_cr_as_separate_pty_writes() {
        #[derive(Clone)]
        struct ChunkRecordingWriter(Arc<Mutex<Vec<Vec<u8>>>>);
        impl Write for ChunkRecordingWriter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().push(bytes.to_vec());
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let write_chunks = |text: &str, submit: bool| -> Vec<Vec<u8>> {
            let state = AppState::new();
            state
                .terminals
                .lock_or_err()
                .unwrap()
                .insert("t1".into(), test_session());
            state
                .terminal_protocol_states
                .lock_or_err()
                .unwrap()
                .insert("t1".into(), terminal_output::new_protocol_gate());
            let chunks = Arc::new(Mutex::new(Vec::new()));
            state.pty_handles.lock_or_err().unwrap().insert(
                "t1".into(),
                pty::PtyHandle::from_test_writer(Box::new(ChunkRecordingWriter(Arc::clone(
                    &chunks,
                )))),
            );
            write_terminal_input_inner(&state, "t1", text, submit, HumanControlOrigin::Local)
                .unwrap();
            let recorded = chunks.lock().unwrap().clone();
            recorded
        };

        // Body + submit → two distinct writes, CR last and by itself.
        assert_eq!(
            write_chunks("hi", true),
            vec![b"hi".to_vec(), b"\r".to_vec()]
        );
        // Lone submit → a single CR write (no empty body write ahead of it).
        assert_eq!(write_chunks("", true), vec![b"\r".to_vec()]);
        // No submit → body only, never a trailing CR.
        assert_eq!(write_chunks("hi", false), vec![b"hi".to_vec()]);
    }

    #[test]
    fn owner_transition_waits_for_a_blocked_pty_worker_to_acknowledge_cancellation() {
        let state = Arc::new(AppState::new());
        enable_test_remote_access(&state);
        set_test_remote_lease(&state, "lease-1");

        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        state.pty_handles.lock_or_err().unwrap().insert(
            "t1".into(),
            pty::PtyHandle::from_test_writer(Box::new(BlockingTestWriter {
                started: Some(started_tx),
                release: release_rx,
            })),
        );

        let worker_state = Arc::clone(&state);
        let worker = thread::spawn(move || {
            write_to_terminal_inner(
                &worker_state,
                "t1",
                b"blocked remote write",
                remote_origin("lease-1"),
            )
        });
        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("test writer should enter physical I/O");

        let transition = state
            .remote_control
            .lock_or_err()
            .unwrap()
            .begin_remote_owner_transition(Instant::now());
        assert!(transition.is_some());

        let error = worker
            .join()
            .unwrap()
            .expect_err("the stale remote write must fail closed");
        assert!(error.contains("ownership changed"));

        {
            let control = state.remote_control.lock_or_err().unwrap();
            assert!(control.transitioning);
            assert!(control.has_active_operations());
        }
        assert!(begin_human_control_operation(&state, HumanControlOrigin::Local, "t1").is_err());

        release_tx.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let status = crate::remote_server::get_remote_control_status(&state).unwrap();
            if !status.transitioning {
                assert!(!status.active);
                break;
            }
            assert!(
                Instant::now() < deadline,
                "PTY worker acknowledgement timed out"
            );
            thread::sleep(Duration::from_millis(10));
        }

        let permit =
            begin_human_control_operation(&state, HumanControlOrigin::Local, "t1").unwrap();
        permit.finish().unwrap();
    }

    // ── resolve_propagate_source (issue #293) ──

    #[test]
    fn resolve_propagate_source_errors_for_unknown_terminal() {
        let state = AppState::new();
        assert!(resolve_propagate_source(&state, "missing").is_err());
    }

    #[test]
    fn resolve_propagate_source_errors_for_file_explorer_id() {
        // 회귀(issue #293): file explorer 페인은 PTY 세션이 없어
        // `file-explorer-<paneId>` id 가 state.terminals 에 존재하지 않는다.
        // 따라서 `propagate_cwd_once` 의 백엔드 경로는 Err 가 되며, 무음 no-op 대신
        // 프론트(FileExplorerView)의 force sync-cwd 경로로 처리해야 함을 명시한다.
        let state = AppState::new();
        assert!(resolve_propagate_source(&state, "file-explorer-pane-x").is_err());
    }

    #[test]
    fn resolve_propagate_source_noop_when_cwd_absent() {
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            // CWD 가 한 번도 갱신되지 않은 갓 생성된 세션
            terminals.insert(
                "t1".into(),
                TerminalSession::new("t1".into(), TerminalConfig::default()),
            );
        }
        assert_eq!(resolve_propagate_source(&state, "t1").unwrap(), None);
    }

    #[test]
    fn resolve_propagate_source_noop_when_cwd_empty() {
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            let mut session = TerminalSession::new("t1".into(), TerminalConfig::default());
            session.cwd = Some(String::new());
            terminals.insert("t1".into(), session);
        }
        assert_eq!(resolve_propagate_source(&state, "t1").unwrap(), None);
    }

    #[test]
    fn resolve_propagate_source_returns_cwd_and_group() {
        // 그룹은 권위 소스인 state.sync_groups 멤버십에서 해석한다(P2).
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            let mut session = TerminalSession::new("t1".into(), TerminalConfig::default());
            session.cwd = Some("/home/user/project".into());
            terminals.insert("t1".into(), session);
        }
        {
            let mut groups = state.sync_groups.lock().unwrap();
            let mut group = crate::terminal::SyncGroup::new("ws-1".into());
            group.add_terminal("t1".into());
            groups.insert("ws-1".into(), group);
        }
        assert_eq!(
            resolve_propagate_source(&state, "t1").unwrap(),
            Some(("/home/user/project".into(), "ws-1".into()))
        );
    }

    #[test]
    fn resolve_propagate_source_empty_group_when_not_in_any_group() {
        // 어떤 그룹에도 속하지 않은 터미널 → 그룹은 빈 문자열(do_sync_cwd no-op 대상).
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            let mut session = TerminalSession::new("t1".into(), TerminalConfig::default());
            session.cwd = Some("/home/user/project".into());
            terminals.insert("t1".into(), session);
        }
        assert_eq!(
            resolve_propagate_source(&state, "t1").unwrap(),
            Some(("/home/user/project".into(), String::new()))
        );
    }

    #[test]
    fn resolve_propagate_source_uses_current_group_after_change() {
        // P2 회귀(issue #293): update_terminal_sync_group 으로 런타임에 그룹을 바꾸면
        // resolve_propagate_source 는 stale 한 config 가 아니라 새 멤버십(state.sync_groups)
        // 기준으로 새 그룹을 해석해야 한다. update_terminal_sync_group 은 session.config.sync_group
        // 을 갱신하지 않으므로, config 를 읽던 옛 구현은 여기서 옛 그룹으로 잘못 해석했다.
        let state = std::sync::Arc::new(AppState::new());
        {
            let mut terminals = state.terminals.lock().unwrap();
            // 초기 config.sync_group 은 old-group 으로 둬, config 와 멤버십이 어긋난 상황을 만든다.
            let config = TerminalConfig {
                sync_group: "old-group".into(),
                ..Default::default()
            };
            let mut session = TerminalSession::new("t1".into(), config);
            session.cwd = Some("/home/user/project".into());
            terminals.insert("t1".into(), session);
        }
        {
            let mut groups = state.sync_groups.lock().unwrap();
            let mut group = crate::terminal::SyncGroup::new("old-group".into());
            group.add_terminal("t1".into());
            groups.insert("old-group".into(), group);
        }

        // 런타임에 new-group 으로 이동.
        {
            let mut groups = state.sync_groups.lock().unwrap();
            if let Some(g) = groups.get_mut("old-group") {
                g.remove_terminal("t1");
            }
            groups.retain(|_, g| !g.terminal_ids.is_empty());
            let mut new_group = crate::terminal::SyncGroup::new("new-group".into());
            new_group.add_terminal("t1".into());
            groups.insert("new-group".into(), new_group);
        }

        // config.sync_group 은 여전히 old-group 이지만, 권위 소스는 new-group.
        assert_eq!(
            resolve_propagate_source(&state, "t1").unwrap(),
            Some(("/home/user/project".into(), "new-group".into()))
        );
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
