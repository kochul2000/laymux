use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::lock_ext::MutexExt;
use crate::process_tree::PtyAppLiveness;
use crate::state::AppState;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionAttributionState {
    Identified,
    RestorePending,
    NoAgent,
    ActiveButUnidentified,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionAttribution {
    generation: u64,
    state: SessionAttributionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
}

pub(crate) struct ProviderSessionLookup {
    pub attributions: HashMap<String, Option<String>>,
    pub failed_terminal_ids: HashSet<String>,
    /// Exact WSL Codex process with no rollout FD, not a rejected/ambiguous candidate.
    pub missing_rollout_terminal_ids: HashSet<String>,
}

pub(crate) struct ProviderTerminalDomains {
    pub native_roots: Vec<(String, u32)>,
    pub wsl_terminal_ids: HashSet<String>,
}

pub(crate) fn provider_terminal_domains(
    known_terminal_ids: &[String],
    state: &AppState,
) -> Result<ProviderTerminalDomains, crate::error::AppError> {
    let ptys = state.pty_handles.lock_or_err()?;
    let mut native_roots = Vec::new();
    let mut wsl_terminal_ids = HashSet::new();
    for terminal_id in known_terminal_ids {
        let Some(handle) = ptys.get(terminal_id) else {
            continue;
        };
        if handle.is_wsl_backed() {
            wsl_terminal_ids.insert(terminal_id.clone());
        } else if let Some(child_pid) = handle.child_pid() {
            native_roots.push((terminal_id.clone(), child_pid));
        }
    }
    Ok(ProviderTerminalDomains {
        native_roots,
        wsl_terminal_ids,
    })
}

fn provider_lookup_failed_for_terminal(
    terminal_id: &str,
    lookups: &[&ProviderSessionLookup],
) -> bool {
    lookups
        .iter()
        .any(|lookup| lookup.failed_terminal_ids.contains(terminal_id))
}

fn classify_attribution(
    generation: u64,
    terminal_id: &str,
    claude: &HashMap<String, Option<String>>,
    codex: &HashMap<String, Option<String>>,
    grok: &HashMap<String, Option<String>>,
    liveness: PtyAppLiveness,
    lookup_failed: bool,
) -> TerminalSessionAttribution {
    if lookup_failed {
        return unknown_attribution(generation);
    }
    let claims = [
        ("claude", claude.get(terminal_id)),
        ("codex", codex.get(terminal_id)),
        ("grok", grok.get(terminal_id)),
    ];
    let active: Vec<_> = claims
        .into_iter()
        .filter_map(|(provider, session)| session.map(|session| (provider, session)))
        .collect();
    if active.len() == 1 {
        let (provider, session) = active[0];
        if let Some(session_id) = session.clone() {
            return TerminalSessionAttribution {
                generation,
                state: SessionAttributionState::Identified,
                provider: Some(provider),
                session_id: Some(session_id),
            };
        }
        return TerminalSessionAttribution {
            generation,
            state: SessionAttributionState::ActiveButUnidentified,
            provider: Some(provider),
            session_id: None,
        };
    }
    if active.len() > 1 {
        return TerminalSessionAttribution {
            generation,
            state: SessionAttributionState::ActiveButUnidentified,
            provider: None,
            session_id: None,
        };
    }

    let (state, provider) = match liveness {
        PtyAppLiveness::Running("Claude") => (
            SessionAttributionState::ActiveButUnidentified,
            Some("claude"),
        ),
        PtyAppLiveness::Running("Codex") => (
            SessionAttributionState::ActiveButUnidentified,
            Some("codex"),
        ),
        PtyAppLiveness::Running("Grok") => {
            (SessionAttributionState::ActiveButUnidentified, Some("grok"))
        }
        PtyAppLiveness::Running(_) => (SessionAttributionState::NoAgent, None),
        PtyAppLiveness::NoneAlive => (SessionAttributionState::NoAgent, None),
        PtyAppLiveness::Unknown => (SessionAttributionState::Unknown, None),
    };
    TerminalSessionAttribution {
        generation,
        state,
        provider,
        session_id: None,
    }
}

fn unknown_attribution(generation: u64) -> TerminalSessionAttribution {
    TerminalSessionAttribution {
        generation,
        state: SessionAttributionState::Unknown,
        provider: None,
        session_id: None,
    }
}

fn apply_unconsumed_restore(
    mut attribution: TerminalSessionAttribution,
    handle: &crate::pty::PtyHandle,
    missing_rollout: bool,
) -> TerminalSessionAttribution {
    if handle.terminal_generation() != attribution.generation {
        return unknown_attribution(attribution.generation);
    }
    let Some((provider, session_id)) = handle.unconsumed_session_restore() else {
        return attribution;
    };
    match attribution.state {
        SessionAttributionState::NoAgent => {}
        SessionAttributionState::ActiveButUnidentified
            if attribution.provider == Some(provider) && missing_rollout => {}
        SessionAttributionState::Unknown => return attribution,
        _ => {
            handle.consume_session_restore();
            return attribution;
        }
    }
    attribution.state = SessionAttributionState::RestorePending;
    attribution.provider = Some(provider);
    attribution.session_id = Some(session_id.to_owned());
    attribution
}

fn reject_duplicate_restore_checkpoints(
    attributions: &mut HashMap<String, TerminalSessionAttribution>,
    handles: &HashMap<String, crate::pty::PtyHandle>,
) {
    let mut counts = HashMap::new();
    for attribution in attributions.values() {
        if let (Some(provider), Some(id)) = (attribution.provider, &attribution.session_id) {
            *counts.entry((provider, id.clone())).or_insert(0) += 1;
        }
    }
    for (terminal_id, attribution) in attributions {
        if attribution.state == SessionAttributionState::RestorePending
            && attribution
                .provider
                .zip(attribution.session_id.clone())
                .is_some_and(|key| counts.get(&key).is_some_and(|count| *count > 1))
        {
            if let Some(handle) = handles.get(terminal_id) {
                handle.consume_session_restore();
            }
            attribution.state = SessionAttributionState::ActiveButUnidentified;
            attribution.session_id = None;
        }
    }
}

fn require_current_generation(
    attribution: TerminalSessionAttribution,
    current_generation: Option<u64>,
) -> TerminalSessionAttribution {
    if current_generation == Some(attribution.generation) {
        attribution
    } else {
        unknown_attribution(attribution.generation)
    }
}

fn collect_provider_session_lookups<Claude, Codex, Grok>(
    claude_lookup: Claude,
    codex_lookup: Codex,
    grok_lookup: Grok,
) -> Result<
    (
        ProviderSessionLookup,
        ProviderSessionLookup,
        ProviderSessionLookup,
    ),
    String,
>
where
    Claude: FnOnce() -> Result<ProviderSessionLookup, String> + Send,
    Codex: FnOnce() -> Result<ProviderSessionLookup, String> + Send,
    Grok: FnOnce() -> Result<ProviderSessionLookup, String> + Send,
{
    std::thread::scope(|scope| {
        let claude = scope.spawn(claude_lookup);
        let codex = scope.spawn(codex_lookup);
        let grok = scope.spawn(grok_lookup);
        let claude = claude
            .join()
            .map_err(|_| "Claude session lookup worker panicked".to_string())??;
        let codex = codex
            .join()
            .map_err(|_| "Codex session lookup worker panicked".to_string())??;
        let grok = grok
            .join()
            .map_err(|_| "Grok session lookup worker panicked".to_string())??;
        Ok((claude, codex, grok))
    })
}

/// Return one generation-bound attribution verdict for every live PTY.
#[tauri::command(async)]
pub fn get_terminal_session_attributions(
    claude_session_max_age_hours: Option<u64>,
    codex_session_max_age_hours: Option<u64>,
    grok_session_max_age_hours: Option<u64>,
    state: State<Arc<AppState>>,
) -> Result<HashMap<String, TerminalSessionAttribution>, String> {
    // Capture generations before provider I/O. A terminal can be closed and
    // recreated under the same id while those lookups run; the second catalog
    // snapshot below rejects any result that crossed that boundary.
    let terminals: Vec<(String, u64)> = state
        .pty_handles
        .lock_or_err()?
        .iter()
        .map(|(terminal_id, handle)| (terminal_id.clone(), handle.terminal_generation()))
        .collect();
    // Each provider owns a bounded WSL probe. Run the three independent
    // lookups together so the command consumes one probe budget rather than
    // serially multiplying it past the five-second window-close deadline.
    let (claude, codex, grok) = collect_provider_session_lookups(
        || {
            super::claude_session::get_claude_session_lookup_impl(
                claude_session_max_age_hours,
                &state,
            )
        },
        || {
            super::codex_session::get_codex_session_lookup_impl(codex_session_max_age_hours, &state)
                .map_err(|error| error.to_string())
        },
        || super::grok_session::get_grok_session_lookup_impl(grok_session_max_age_hours, &state),
    )?;
    let observations: Vec<(String, u64, PtyAppLiveness)> = terminals
        .into_iter()
        .map(|(terminal_id, generation)| {
            let liveness = crate::process_tree::interactive_app_in_pty_fresh(&state, &terminal_id);
            (terminal_id, generation, liveness)
        })
        .collect();
    let current_handles = state.pty_handles.lock_or_err()?.clone();

    let mut attributions = observations
        .into_iter()
        .map(|(terminal_id, generation, liveness)| {
            let lookup_failed =
                provider_lookup_failed_for_terminal(&terminal_id, &[&claude, &codex, &grok]);
            let attribution = classify_attribution(
                generation,
                &terminal_id,
                &claude.attributions,
                &codex.attributions,
                &grok.attributions,
                liveness,
                lookup_failed,
            );
            let attribution = require_current_generation(
                attribution,
                current_handles
                    .get(&terminal_id)
                    .map(|handle| handle.terminal_generation()),
            );
            let attribution = match current_handles.get(&terminal_id) {
                Some(handle) => apply_unconsumed_restore(
                    attribution,
                    handle,
                    codex.missing_rollout_terminal_ids.contains(&terminal_id),
                ),
                None => attribution,
            };
            (terminal_id, attribution)
        })
        .collect();
    reject_duplicate_restore_checkpoints(&mut attributions, &current_handles);
    Ok(attributions)
}

#[cfg(test)]
mod tests;
