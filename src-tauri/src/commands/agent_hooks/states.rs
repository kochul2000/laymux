use crate::agent_hooks::{
    observations::{HookPhase, HookResult, Observation},
    ManageRequest,
};
use crate::commands::session_attribution::{
    get_terminal_session_attributions_impl, SessionAttributionState, TerminalSessionAttribution,
};
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStateSnapshot {
    generation: u64,
    provider: String,
    session_id: String,
    state: HookPhase,
    result: Option<HookResult>,
    task_id: String,
    sequence: u64,
    observed_at_ms: u64,
    config_dir: Option<String>,
    distro: Option<String>,
}

#[tauri::command(async)]
pub fn get_agent_hook_states(
    providers: Vec<String>,
    state: State<Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<HashMap<String, HookStateSnapshot>, String> {
    get_agent_hook_states_impl(&providers, &state, &app)
}

pub(crate) fn get_agent_hook_states_impl(
    providers: &[String],
    state: &AppState,
    app: &tauri::AppHandle,
) -> Result<HashMap<String, HookStateSnapshot>, String> {
    if providers.is_empty() {
        return Ok(HashMap::new());
    }
    if providers
        .iter()
        .any(|p| !matches!(p.as_str(), "claude" | "codex"))
    {
        return Err("Unsupported hook provider".into());
    }
    let attributions = get_terminal_session_attributions_impl(None, None, None, state)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    #[cfg(windows)]
    let distros: HashMap<_, _> = crate::wsl_probe::wsl_terminal_targets(
        state,
        std::time::Instant::now() + std::time::Duration::from_secs(1),
    )?
    .targets
    .into_iter()
    .collect();
    #[cfg(not(windows))]
    let distros: HashMap<String, Option<String>> = HashMap::new();
    let domains: HashMap<_, _> = state
        .pty_handles
        .lock_or_err()?
        .iter()
        .map(|(id, h)| (id.clone(), (h.terminal_generation(), h.is_wsl_backed())))
        .collect();
    let observations: Vec<(String, u64, Observation)> = {
        let registry = state.agent_hook_observations.lock_or_err()?;
        attributions
            .into_iter()
            .filter_map(|(id, attribution)| {
                if !matches!(
                    attribution.state,
                    SessionAttributionState::Identified | SessionAttributionState::Fresh
                ) {
                    return None;
                }
                let provider = attribution.provider?;
                if !providers.iter().any(|p| p == provider) {
                    return None;
                }
                let (generation, wsl) = domains.get(&id)?;
                if *generation != attribution.generation {
                    return None;
                }
                let distro = if *wsl {
                    Some(distros.get(&id)?.as_deref()?)
                } else {
                    None
                };
                registry
                    .exact(provider, attribution.session_id.as_deref()?, distro, now)
                    .cloned()
                    .map(|observation| (id, *generation, observation))
            })
            .collect()
    };
    let mut installed = HashMap::new();
    let mut result = HashMap::new();
    for (id, generation, observation) in observations {
        let event = &observation.event;
        let expected = if event.provider == "claude" {
            "Claude"
        } else {
            "Codex"
        };
        // A server or stale attribution must never keep a shell marked as an agent.
        if crate::process_tree::interactive_app_in_pty_fresh(state, &id)
            != crate::process_tree::PtyAppLiveness::Running(expected)
        {
            continue;
        }
        let key = (
            event.provider.clone(),
            event.distro.clone(),
            event.config_dir.clone(),
        );
        let enabled = *installed.entry(key).or_insert_with(|| {
            crate::agent_hooks::manage(
                &ManageRequest {
                    provider: event.provider.clone(),
                    operation: "status".into(),
                    distro: event.distro.clone(),
                    config_dir: event.config_dir.clone(),
                },
                app,
            )
            .is_ok_and(|value| {
                value["installed"] == true
                    && value["disabled"] == false
                    && value["warning"].is_null()
            })
        });
        if !enabled {
            continue;
        }
        let Some(phase) = observation.phase else {
            continue;
        };
        result.insert(
            id,
            HookStateSnapshot {
                generation,
                provider: event.provider.clone(),
                session_id: event.session_id.clone(),
                state: phase,
                result: observation.result,
                task_id: observation.task.to_string(),
                sequence: observation.sequence,
                observed_at_ms: observation.phase_at_ms,
                config_dir: event.config_dir.clone(),
                distro: event.distro.clone(),
            },
        );
    }
    // Installation I/O can span a session switch within the same PTY. Recheck
    // exact selection and liveness after it, not just the generation number.
    if !result.is_empty() {
        let final_attributions = get_terminal_session_attributions_impl(None, None, None, state)?;
        result.retain(|id, entry| {
            final_attributions
                .get(id)
                .is_some_and(|a| same_verified_session(entry, a))
                && crate::process_tree::interactive_app_in_pty_fresh(state, id)
                    == crate::process_tree::PtyAppLiveness::Running(if entry.provider == "claude" {
                        "Claude"
                    } else {
                        "Codex"
                    })
        });
    }
    let handles = state.pty_handles.lock_or_err()?;
    result.retain(|id, entry| {
        handles
            .get(id)
            .is_some_and(|h| h.terminal_generation() == entry.generation)
    });
    Ok(result)
}

fn same_verified_session(
    snapshot: &HookStateSnapshot,
    attribution: &TerminalSessionAttribution,
) -> bool {
    matches!(
        attribution.state,
        SessionAttributionState::Identified | SessionAttributionState::Fresh
    ) && attribution.generation == snapshot.generation
        && attribution.provider == Some(snapshot.provider.as_str())
        && attribution.session_id.as_deref() == Some(snapshot.session_id.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binding_requires_current_generation_provider_and_exact_conversation() {
        for provider in ["claude", "codex"] {
            let snapshot = HookStateSnapshot {
                generation: 4,
                provider: provider.into(),
                session_id: "current".into(),
                state: HookPhase::Running,
                result: None,
                task_id: "1".into(),
                sequence: 2,
                observed_at_ms: 100,
                config_dir: None,
                distro: None,
            };
            let exact = TerminalSessionAttribution {
                generation: 4,
                state: SessionAttributionState::Identified,
                provider: Some(provider),
                session_id: Some("current".into()),
            };
            assert!(same_verified_session(&snapshot, &exact));
            for state in [
                SessionAttributionState::NoAgent,
                SessionAttributionState::Unknown,
                SessionAttributionState::ActiveButUnidentified,
                SessionAttributionState::RestorePending,
            ] {
                assert!(!same_verified_session(
                    &snapshot,
                    &TerminalSessionAttribution {
                        state,
                        ..exact.clone()
                    }
                ));
            }
            assert!(!same_verified_session(
                &snapshot,
                &TerminalSessionAttribution {
                    generation: 5,
                    ..exact.clone()
                }
            ));
            assert!(!same_verified_session(
                &snapshot,
                &TerminalSessionAttribution {
                    provider: Some("grok"),
                    ..exact.clone()
                }
            ));
            assert!(!same_verified_session(
                &snapshot,
                &TerminalSessionAttribution {
                    session_id: Some("previous".into()),
                    ..exact
                }
            ));
        }
    }
}
