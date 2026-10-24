//! Task state that Claude and Grok record in their own session files
//! (ADR-0321). The frontend reads it only while no title confirms the state.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::lock_ext::MutexExt;
use crate::state::AppState;
use crate::wsl_probe::snapshot::GuestObservation;

use super::claude_session::{get_claude_session_records_impl, ClaudeSessionStatus};
use super::grok_session::get_grok_session_records_impl;
use super::session_attribution::ProviderSessionLookup;

/// Bounded tail of Grok's `updates.jsonl`; tool output can make it large.
const GROK_UPDATES_READ_LIMIT: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentSessionStatus {
    Running,
    Idle,
    Waiting,
    Ended,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentTurnResult {
    Success,
    Interrupted,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionState {
    generation: u64,
    session_id: String,
    status: AgentSessionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<AgentTurnResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
}

#[tauri::command(async)]
pub fn get_agent_session_states(
    claude_terminal_ids: Vec<String>,
    grok_terminal_ids: Vec<String>,
    state: State<Arc<AppState>>,
) -> Result<HashMap<String, AgentSessionState>, String> {
    get_agent_session_states_impl(&claude_terminal_ids, &grok_terminal_ids, &state)
}

/// A terminal is missing from the result when its session or state is not known.
pub(crate) fn get_agent_session_states_impl(
    claude_terminal_ids: &[String],
    grok_terminal_ids: &[String],
    state: &AppState,
) -> Result<HashMap<String, AgentSessionState>, String> {
    let generations = terminal_generations(state)?;
    let mut states = HashMap::new();
    // Display polling: both providers may read one shared guest scan (ADR-0335).
    let observation = GuestObservation::Reusable;
    if !claude_terminal_ids.is_empty() {
        let records = get_claude_session_records_impl(None, state, observation)?;
        for id in claude_terminal_ids {
            let (Some(generation), Some(session_id)) =
                (generations.get(id), attributed(&records.lookup, id))
            else {
                continue;
            };
            let Some(status) = records.statuses.get(session_id) else {
                continue;
            };
            let status = match status {
                ClaudeSessionStatus::Busy => AgentSessionStatus::Running,
                ClaudeSessionStatus::Idle => AgentSessionStatus::Idle,
                ClaudeSessionStatus::Waiting => AgentSessionStatus::Waiting,
            };
            states.insert(
                id.clone(),
                AgentSessionState {
                    generation: *generation,
                    session_id: session_id.to_owned(),
                    status,
                    result: None,
                    turn_id: None,
                },
            );
        }
    }
    if !grok_terminal_ids.is_empty() {
        let records = get_grok_session_records_impl(None, state, observation)?;
        for id in grok_terminal_ids {
            let (Some(generation), Some(session_id)) =
                (generations.get(id), attributed(&records.lookup, id))
            else {
                continue;
            };
            let Some(directory) = records.directories.get(session_id) else {
                continue;
            };
            match read_grok_turn(&directory.join("updates.jsonl"), session_id) {
                Ok(Some((status, result, turn_id))) => {
                    states.insert(
                        id.clone(),
                        AgentSessionState {
                            generation: *generation,
                            session_id: session_id.to_owned(),
                            status,
                            result,
                            turn_id,
                        },
                    );
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::debug!(terminal_id = id, %error, "Grok turn record unavailable")
                }
            }
        }
    }
    // A PTY replaced during the lookup belongs to another process.
    let current = terminal_generations(state)?;
    states.retain(|id, entry| current.get(id) == Some(&entry.generation));
    Ok(states)
}

fn terminal_generations(state: &AppState) -> Result<HashMap<String, u64>, String> {
    Ok(state
        .pty_handles
        .lock_or_err()
        .map_err(|error| error.to_string())?
        .iter()
        .map(|(id, handle)| (id.clone(), handle.terminal_generation()))
        .collect())
}

fn attributed<'a>(lookup: &'a ProviderSessionLookup, terminal_id: &str) -> Option<&'a str> {
    if lookup.failed_terminal_ids.contains(terminal_id) {
        return None;
    }
    lookup.attributions.get(terminal_id)?.as_deref()
}

type GrokTurn = (AgentSessionStatus, Option<AgentTurnResult>, Option<String>);

fn read_grok_turn(path: &Path, session_id: &str) -> std::io::Result<Option<GrokTurn>> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(GROK_UPDATES_READ_LIMIT);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(len - start).read_to_end(&mut bytes)?;
    Ok(last_grok_turn(&bytes, start > 0, session_id))
}

/// The last turn boundary: a user message starts a turn and `turn_completed`
/// ends it. Without a boundary a whole file means no turn yet (idle); a
/// truncated tail or an unreadable record is unknown (`None`).
fn last_grok_turn(bytes: &[u8], truncated: bool, session_id: &str) -> Option<GrokTurn> {
    // Grok may still be writing the last line; only newline-terminated lines count.
    let complete = &bytes[..bytes.iter().rposition(|&byte| byte == b'\n').unwrap_or(0)];
    let mut lines: Vec<&[u8]> = complete.split(|&byte| byte == b'\n').collect();
    if truncated && !lines.is_empty() {
        // The tail can start in the middle of a record.
        lines.remove(0);
    }
    for line in lines.into_iter().rev() {
        if line.is_empty() {
            continue;
        }
        let record: serde_json::Value = serde_json::from_slice(line).ok()?;
        if record["params"]["sessionId"].as_str() != Some(session_id) {
            return None;
        }
        let update = &record["params"]["update"];
        match update["sessionUpdate"].as_str() {
            Some("user_message_chunk") => return Some((AgentSessionStatus::Running, None, None)),
            Some("turn_completed") => {
                let result = match update["stop_reason"].as_str() {
                    Some("end_turn") => Some(AgentTurnResult::Success),
                    Some("cancelled") => Some(AgentTurnResult::Interrupted),
                    _ => None,
                };
                let turn_id = update["prompt_id"]
                    .as_str()
                    .filter(|id| !id.is_empty() && id.len() <= 256)
                    .map(str::to_owned);
                return Some((AgentSessionStatus::Ended, result, turn_id));
            }
            _ => {}
        }
    }
    (!truncated).then_some((AgentSessionStatus::Idle, None, None))
}

#[cfg(test)]
mod tests;
