use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use crate::activity;
use crate::constants::EVENT_TERMINALS_LIST_CHANGED;
use crate::lock_ext::MutexExt;
use crate::pty::PtyOutputControl;
use crate::state::AppState;
use crate::terminal_output::{self, TerminalOutputSession};

pub(super) fn request_terminal_output_fatal_teardown(
    state: &Arc<AppState>,
    app: &AppHandle,
    terminal_id: &str,
    output_session: &Arc<TerminalOutputSession>,
    stage: &'static str,
) -> PtyOutputControl {
    let app = app.clone();
    request_terminal_output_fatal_teardown_inner(
        state,
        terminal_id,
        output_session,
        stage,
        move |terminal_id, generation| {
            if let Err(error) = app.emit(
                EVENT_TERMINALS_LIST_CHANGED,
                serde_json::json!({
                    "op": "closed",
                    "terminalId": terminal_id,
                    "reason": "terminalOutputFatal",
                }),
            ) {
                tracing::warn!(
                    terminal_id,
                    generation,
                    %error,
                    "failed to emit terminals-list-changed after fatal output teardown"
                );
            }
        },
    )
}

fn request_terminal_output_fatal_teardown_inner<F>(
    state: &Arc<AppState>,
    terminal_id: &str,
    output_session: &Arc<TerminalOutputSession>,
    stage: &'static str,
    on_closed: F,
) -> PtyOutputControl
where
    F: FnOnce(&str, u64) + Send + 'static,
{
    if output_session.request_fatal_teardown() {
        let dispatcher = state.terminal_teardown_dispatcher.clone();
        let state = Arc::clone(state);
        let terminal_id = terminal_id.to_string();
        let output_session = Arc::clone(output_session);
        tracing::error!(
            terminal_id = %terminal_id,
            generation = output_session.generation(),
            stage,
            "terminal output generation requested automatic teardown"
        );
        // AppState creates this worker before terminals can exist. Dispatch is
        // therefore a non-blocking channel send with no per-fatal OS-thread
        // creation edge after the exactly-once bit has been claimed.
        let reaper_dispatcher = dispatcher.clone();
        let dispatch_result =
            dispatcher.dispatch_cleanup(Box::new(move || match detach_terminal_output_generation(
                &state,
                &terminal_id,
                &output_session,
            ) {
                Ok(Some(detached)) => {
                    let generation = output_session.generation();
                    if let Some(handle) = detached.handle {
                        let reaper_terminal_id = terminal_id.clone();
                        if let Err(error) = reaper_dispatcher.dispatch_reaper(Box::new(move || {
                            terminate_detached_handle(&reaper_terminal_id, generation, handle);
                        })) {
                            tracing::error!(
                                terminal_id = %terminal_id,
                                generation,
                                %error,
                                "failed to dispatch detached PTY to fatal reaper"
                            );
                        }
                    }
                    on_closed(&terminal_id, generation);
                }
                Ok(None) => {
                    tracing::debug!(
                        terminal_id = %terminal_id,
                        generation = output_session.generation(),
                        "fatal output teardown lost to close, rollback, or a newer generation"
                    );
                }
                Err(error) => {
                    tracing::error!(
                        terminal_id = %terminal_id,
                        generation = output_session.generation(),
                        %error,
                        "fatal output teardown failed"
                    );
                }
            }));
        if let Err(error) = dispatch_result {
            // The receiver remains alive for the full AppState lifetime and
            // catches job panics, so this can only occur during global state
            // teardown, whose AppState::drop path drains all remaining PTYs.
            tracing::error!(%error, "failed to dispatch terminal fatal teardown");
        }
    }
    PtyOutputControl::Stop
}

/// Retire and detach exactly `expected`; never resolve a PTY handle by id until
/// that generation identity has won under the terminal catalog lock.
///
/// All potentially blocking platform shutdown runs after every AppState lock is
/// released. A create that has reserved the output generation but has not yet
/// installed its handle observes retirement at commit and owns that handle's
/// rollback instead.
struct DetachedFatalGeneration {
    handle: Option<crate::pty::PtyHandle>,
}

fn detach_terminal_output_generation(
    state: &AppState,
    terminal_id: &str,
    expected: &Arc<TerminalOutputSession>,
) -> Result<Option<DetachedFatalGeneration>, String> {
    detach_terminal_output_generation_with_post_unlock(state, terminal_id, expected, || {})
}

fn detach_terminal_output_generation_with_post_unlock(
    state: &AppState,
    terminal_id: &str,
    expected: &Arc<TerminalOutputSession>,
    post_unlock: impl FnOnce(),
) -> Result<Option<DetachedFatalGeneration>, String> {
    let mut terminals = state
        .terminals
        .lock_or_recover_for_discard("tearing down fatal terminal catalog entry");
    let detached = terminal_output::retire_terminal_output_session_and_then_deferred(
        &state.terminal_protocol_states,
        &state.output_buffers,
        terminal_id,
        expected,
        || {
            let session = terminals.remove(terminal_id);
            let handle = state
                .pty_handles
                .lock_or_recover_for_discard("tearing down fatal PTY handle registry entry")
                .remove(terminal_id);

            if let Some(session) = session.as_ref() {
                if !session.config.sync_group.is_empty() {
                    if let Ok(mut groups) = state.sync_groups.lock_or_err() {
                        if let Some(group) = groups.get_mut(&session.config.sync_group) {
                            group.remove_terminal(terminal_id);
                            if group.terminal_ids.is_empty() {
                                groups.remove(&session.config.sync_group);
                            }
                        }
                    }
                }
            }
            if let Ok(mut propagated) = state.propagated_terminals.lock_or_err() {
                propagated.remove(terminal_id);
            }
            if let Ok(mut known) = state.known_claude_terminals.lock_or_err() {
                known.remove(terminal_id);
            }
            if let Ok(mut known) = state.known_codex_terminals.lock_or_err() {
                known.remove(terminal_id);
            }
            activity::clear_interactive_app_grace_window(state, terminal_id);
            activity::clear_interactive_app_exit_marker(state, terminal_id);
            // A guest verdict describes a specific PTY generation. Drop it here
            // too so a probe pass still in flight cannot resurrect it for the
            // replacement PTY that reuses this id (ADR-0134).
            crate::wsl_liveness::forget(terminal_id);
            if let Ok(mut notifications) = state.notifications.lock_or_err() {
                notifications.retain(|notification| notification.terminal_id != terminal_id);
            }

            handle
        },
    )?;
    let Some((handle, output_retirement)) = detached else {
        return Ok(None);
    };

    drop(terminals);
    post_unlock();
    if let Ok(mut locks) = state.exec_locks.lock_or_err() {
        if locks
            .get(terminal_id)
            .is_some_and(|current| current.generation == expected.generation())
        {
            locks.remove(terminal_id);
        }
    }
    output_retirement.finish();
    Ok(Some(DetachedFatalGeneration { handle }))
}

fn terminate_detached_handle(terminal_id: &str, generation: u64, handle: crate::pty::PtyHandle) {
    if let Err(error) = handle.terminate() {
        tracing::error!(
            terminal_id,
            generation,
            %error,
            "failed to terminate PTY after fatal output generation was detached"
        );
    }
}

#[cfg(test)]
#[path = "terminal_teardown/tests.rs"]
mod tests;
