//! Memory-only display history belongs to the exact daemon child (ADR-0329).
use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::lock_ext::MutexExt;
use crate::pty_daemon::DisplayContext;
use crate::state::AppState;
use crate::terminal::TerminalSession;

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct BackendContext {
    title: String,
    osc_title: Option<String>,
    last_command: Option<String>,
    last_exit_code: Option<i32>,
    last_command_at: Option<u64>,
    command_running: bool,
    claude_message: Option<String>,
    claude_was_working: bool,
    claude_last_working_title: Option<String>,
}

fn display_text(value: &str) -> String {
    value.chars().take(512).collect()
}
fn optional_display_text(value: &Option<String>) -> Option<String> {
    value.as_deref().map(display_text)
}

pub(crate) fn restore(session: &mut TerminalSession, metadata: &BTreeMap<String, String>) {
    let Some(context) = metadata.get(crate::constants::PTY_DAEMON_METADATA_DISPLAY_CONTEXT) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<Value>(context) else {
        return;
    };
    if value.get("version").and_then(Value::as_u64) != Some(1) {
        return;
    }
    if let Some(backend) = value
        .get("backend")
        .cloned()
        .and_then(|v| serde_json::from_value::<BackendContext>(v).ok())
    {
        session.title = backend.title;
        session.osc_title = backend.osc_title;
        session.last_command = backend.last_command;
        session.last_exit_code = backend.last_exit_code;
        session.last_command_at = backend.last_command_at;
        session.command_running = backend.command_running;
        session.claude_message = backend.claude_message;
        session.claude_was_working = backend.claude_was_working;
        session.claude_last_working_title = backend.claude_last_working_title;
    }
    session.display_context = Some(DisplayContext(context.clone()));
}

#[tauri::command]
pub async fn save_terminal_display_context(
    id: String,
    generation: u64,
    context: Value,
    state: State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    let Some((owner, context)) = prepare_context(&state, &id, generation, context)? else {
        return Ok(false);
    };
    let saved_context = context.clone();
    let accepted = tokio::task::spawn_blocking(move || owner.save(context))
        .await
        .map_err(|_| "terminal display context transfer task failed".to_owned())??;
    if accepted {
        let mut terminals = state.terminals.lock_or_err()?;
        let current = crate::terminal_output::terminal_output_session_for(
            &state.terminal_protocol_states,
            &id,
        )?;
        if current.as_ref().map(|s| s.generation()) == Some(generation) {
            if let Some(session) = terminals.get_mut(&id) {
                session.display_context = Some(saved_context);
            }
        }
    }
    Ok(accepted)
}

fn prepare_context(
    state: &AppState,
    id: &str,
    generation: u64,
    mut context: Value,
) -> Result<Option<(crate::pty_daemon::DisplayContextOwner, DisplayContext)>, String> {
    if context.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("unsupported terminal display context".into());
    }
    let owner = {
        let terminals = state.terminals.lock_or_err()?;
        let Some(session) = terminals.get(id) else {
            return Ok(None);
        };
        let current = crate::terminal_output::terminal_output_session_for(
            &state.terminal_protocol_states,
            id,
        )?;
        if current.as_ref().map(|s| s.generation()) != Some(generation) {
            return Ok(None);
        }
        let handles = state.pty_handles.lock_or_err()?;
        let Some(owner) = handles
            .get(id)
            .and_then(|h| h.display_context_owner.clone())
        else {
            return Ok(None);
        };
        let backend = BackendContext {
            title: display_text(&session.title),
            osc_title: optional_display_text(&session.osc_title),
            last_command: optional_display_text(&session.last_command),
            last_exit_code: session.last_exit_code,
            last_command_at: session.last_command_at,
            command_running: session.command_running,
            claude_message: optional_display_text(&session.claude_message),
            claude_was_working: session.claude_was_working,
            claude_last_working_title: optional_display_text(&session.claude_last_working_title),
        };
        context
            .as_object_mut()
            .ok_or("invalid terminal display context")?
            .insert(
                "backend".into(),
                serde_json::to_value(backend).map_err(|_| "invalid backend display context")?,
            );
        owner
    };
    let serialized =
        serde_json::to_string(&context).map_err(|_| "invalid terminal display context")?;
    Ok(Some((owner, DisplayContext(serialized))))
}

#[tauri::command]
pub fn get_terminal_display_context(
    id: String,
    generation: u64,
    state: State<'_, Arc<AppState>>,
) -> Result<Option<Value>, String> {
    let terminals = state.terminals.lock_or_err()?;
    let current =
        crate::terminal_output::terminal_output_session_for(&state.terminal_protocol_states, &id)?;
    if current.as_ref().map(|s| s.generation()) != Some(generation) {
        return Ok(None);
    }
    let context = terminals.get(&id).and_then(|s| s.display_context.clone());
    Ok(context.and_then(|c| serde_json::from_str(&c.0).ok()))
}

#[tauri::command]
pub async fn load_terminal_display_contexts(
    profiles: BTreeMap<String, String>,
) -> Result<BTreeMap<String, Value>, String> {
    tokio::task::spawn_blocking(move || {
        Ok(crate::pty_daemon::load_display_contexts(&profiles)?
            .into_iter()
            .filter_map(|(id, c)| Some((id, serde_json::from_str(&c.0).ok()?)))
            .collect())
    })
    .await
    .map_err(|_| "terminal display context load task failed".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::TerminalConfig;

    #[test]
    fn restores_raw_status_but_never_serializes_private_input_with_the_session() {
        let mut session = TerminalSession::new("t".into(), TerminalConfig::default());
        let value = serde_json::json!({"version":1,"profile":"PowerShell",
            "lastUserInput":"PRIVATE_INPUT_SENTINEL",
            "backend":{"title":"Claude","oscTitle":"✳ Claude Code", "lastCommand":"command",
                "lastExitCode":7,"lastCommandAt":100,"claudeMessage":"completed message"}});
        restore(
            &mut session,
            &BTreeMap::from([(
                crate::constants::PTY_DAEMON_METADATA_DISPLAY_CONTEXT.into(),
                value.to_string(),
            )]),
        );
        assert_eq!(session.last_exit_code, Some(7));
        assert_eq!(session.claude_message.as_deref(), Some("completed message"));
        assert_eq!(session.osc_title.as_deref(), Some("✳ Claude Code"));
        assert!(session.display_context.is_some());
        assert!(!serde_json::to_string(&session)
            .unwrap()
            .contains("PRIVATE_INPUT_SENTINEL"));
        assert!(!format!("{session:?}").contains("PRIVATE_INPUT_SENTINEL"));
    }

    #[test]
    fn rejects_unknown_context_versions_and_corrupt_payloads() {
        for value in ["not json", r#"{"version":2,"backend":{"lastExitCode":8}}"#] {
            let mut session = TerminalSession::new("t".into(), TerminalConfig::default());
            restore(
                &mut session,
                &BTreeMap::from([(
                    crate::constants::PTY_DAEMON_METADATA_DISPLAY_CONTEXT.into(),
                    value.into(),
                )]),
            );
            assert!(session.display_context.is_none());
            assert!(session.last_exit_code.is_none());
        }
    }
}
