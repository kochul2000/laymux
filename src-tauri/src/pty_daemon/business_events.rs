use super::event_journal::BusinessEvent;
use super::gateway::DaemonGateway;
use super::requests::ReadCommand;
use crate::constants::*;
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::{Arc, Weak};
use tauri::{AppHandle, Emitter};

impl DaemonGateway {
    pub(crate) fn start_business_events(self: &Arc<Self>, state: Weak<AppState>, app: AppHandle) {
        let gateway = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            let outcome = async {
                let Some(initial) = gateway.upgrade() else {
                    return Ok::<(), String>(());
                };
                let mut reader = initial.open_reader().await?;
                drop(initial);
                let mut cursor = None;
                loop {
                    let Some(source) = gateway.upgrade() else {
                        return Ok(());
                    };
                    let Some(state) = state.upgrade() else {
                        return Ok(());
                    };
                    let response = reader
                        .call(ReadCommand::BusinessEvents { since: cursor })
                        .await?;
                    let sequence = response["sequence"]
                        .as_u64()
                        .ok_or("daemon business cursor rejected")?;
                    if cursor.is_some_and(|previous| sequence < previous) {
                        return Err("daemon business cursor regressed".into());
                    }
                    if response["reset"] == true {
                        source.publish_catalog_state(&state, &app, &response["catalog"])?;
                    } else {
                        let events: Vec<BusinessEvent> =
                            serde_json::from_value(response["events"].clone())
                                .map_err(|error| error.to_string())?;
                        for event in events {
                            if event.sequence <= cursor.unwrap_or(0) || event.sequence > sequence {
                                return Err("daemon business event sequence rejected".into());
                            }
                            if let Some(payload) = source.project_business_event(&state, &event)? {
                                app.emit(&event.event, payload)
                                    .map_err(|error| error.to_string())?;
                            }
                        }
                    }
                    cursor = Some(sequence);
                    drop(state);
                    drop(source);
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
            .await;
            if let Err(error) = outcome {
                tracing::warn!(%error, "daemon business event delivery stopped");
            }
        });
    }

    fn project_business_event(
        &self,
        state: &AppState,
        event: &BusinessEvent,
    ) -> Result<Option<Value>, String> {
        let mut terminals = state.terminals.lock_or_err()?;
        let handles = state.pty_handles.lock_or_err()?;
        let projections = self.projections.lock_or_err()?;
        let Some(projection) = projections
            .get(&event.terminal_id)
            .filter(|projection| projection.native_generation == event.generation)
        else {
            return Ok(None);
        };
        let delivery = projection
            .delivery_generation
            .load(std::sync::atomic::Ordering::Acquire);
        if delivery == 0 {
            return Ok(None);
        }
        let Some(handle) = handles.get(&event.terminal_id) else {
            return Ok(None);
        };
        if handle.terminal_generation() != delivery {
            return Ok(None);
        }
        let Some(terminal) = terminals.get_mut(&event.terminal_id) else {
            return Ok(None);
        };
        let Some(payload) = project_payload(event, projection.native_generation, delivery) else {
            return Ok(None);
        };
        match event.event.as_str() {
            EVENT_TERMINAL_CWD_CHANGED => {
                if let Some(cwd) = payload["cwd"].as_str() {
                    terminal.cwd = Some(cwd.into());
                }
            }
            EVENT_TERMINAL_TITLE_CHANGED => {
                if let Some(title) = payload["title"].as_str() {
                    terminal.title = title.into();
                }
            }
            EVENT_SYNC_BRANCH => {
                if let Some(branch) = payload["branch"].as_str() {
                    terminal.branch = Some(branch.into());
                }
            }
            EVENT_CLAUDE_MESSAGE_CHANGED => {
                terminal.claude_message = payload["message"].as_str().map(str::to_owned);
            }
            _ => {}
        }
        Ok(Some(payload))
    }

    pub(super) fn publish_catalog_state(
        &self,
        state: &AppState,
        app: &AppHandle,
        catalog: &Value,
    ) -> Result<(), String> {
        let entries = catalog
            .as_array()
            .ok_or("daemon business catalog rejected")?;
        for entry in entries {
            let session = &entry["session"];
            let id = session["id"]
                .as_str()
                .ok_or("daemon business terminal identity rejected")?;
            let generation = entry["generation"]
                .as_u64()
                .filter(|generation| *generation > 0)
                .ok_or("daemon business terminal generation rejected")?;
            for (event, payload) in [
                (
                    EVENT_TERMINAL_CWD_CHANGED,
                    json!({"terminalId":id,"cwd":session["cwd"],"cwdSend":session["cwd_send"]}),
                ),
                (
                    EVENT_TERMINAL_TITLE_CHANGED,
                    json!({"terminalId":id,"title":session["title"],"generation":generation}),
                ),
            ] {
                if event == EVENT_TERMINAL_CWD_CHANGED && !payload["cwd"].is_string() {
                    continue;
                }
                if let Some(payload) = self.project_business_event(
                    state,
                    &BusinessEvent {
                        sequence: 0,
                        event: event.into(),
                        terminal_id: id.into(),
                        generation,
                        payload,
                    },
                )? {
                    app.emit(event, payload)
                        .map_err(|error| error.to_string())?;
                }
            }
        }
        Ok(())
    }
}

fn project_payload(
    event: &BusinessEvent,
    native_generation: u64,
    delivery_generation: u64,
) -> Option<Value> {
    if event.generation != native_generation || delivery_generation == 0 {
        return None;
    }
    let mut payload = event.payload.clone();
    if payload.get("generation").is_some() {
        payload["generation"] = json!(delivery_generation);
    }
    Some(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn business_events_use_current_delivery_generation_and_reject_stale_sources() {
        let event = BusinessEvent {
            sequence: 9,
            event: EVENT_TERMINAL_TITLE_CHANGED.into(),
            terminal_id: "terminal-one".into(),
            generation: 42,
            payload: json!({"terminalId":"terminal-one","generation":42,"title":"current"}),
        };
        assert_eq!(project_payload(&event, 42, 3).unwrap()["generation"], 3);
        assert!(project_payload(&event, 43, 3).is_none());
        assert!(project_payload(&event, 42, 0).is_none());
    }
}
