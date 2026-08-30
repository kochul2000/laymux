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
    let current_generations: HashMap<String, u64> = state
        .pty_handles
        .lock_or_err()?
        .iter()
        .map(|(terminal_id, handle)| (terminal_id.clone(), handle.terminal_generation()))
        .collect();

    Ok(observations
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
                current_generations.get(&terminal_id).copied(),
            );
            (terminal_id, attribution)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_claim_wins_and_is_bound_to_generation() {
        let attribution = classify_attribution(
            7,
            "terminal-a",
            &HashMap::new(),
            &HashMap::from([("terminal-a".into(), Some("session-2".into()))]),
            &HashMap::new(),
            PtyAppLiveness::Running("Codex"),
            false,
        );
        assert_eq!(attribution.generation, 7);
        assert_eq!(attribution.state, SessionAttributionState::Identified);
        assert_eq!(attribution.session_id.as_deref(), Some("session-2"));
    }

    #[test]
    fn unknown_process_snapshot_is_not_collapsed_to_no_agent() {
        let attribution = classify_attribution(
            3,
            "terminal-a",
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            PtyAppLiveness::Unknown,
            false,
        );
        assert_eq!(attribution.state, SessionAttributionState::Unknown);
    }

    #[test]
    fn provider_lookup_failure_is_not_collapsed_to_destructive_absence() {
        let attribution = classify_attribution(
            4,
            "terminal-a",
            &HashMap::from([("terminal-a".into(), None)]),
            &HashMap::new(),
            &HashMap::new(),
            PtyAppLiveness::Running("Claude"),
            true,
        );

        assert_eq!(attribution.state, SessionAttributionState::Unknown);
        assert_eq!(attribution.session_id, None);
    }

    #[test]
    fn provider_lookup_failure_is_scoped_to_the_affected_terminal() {
        let failed = ProviderSessionLookup {
            attributions: HashMap::from([("terminal-b".into(), None)]),
            failed_terminal_ids: HashSet::from(["terminal-b".into()]),
        };
        let healthy = ProviderSessionLookup {
            attributions: HashMap::from([("terminal-a".into(), Some("session-a".into()))]),
            failed_terminal_ids: HashSet::new(),
        };

        assert!(!provider_lookup_failed_for_terminal(
            "terminal-a",
            &[&failed, &healthy]
        ));
        assert!(provider_lookup_failed_for_terminal(
            "terminal-b",
            &[&failed, &healthy]
        ));
    }

    #[test]
    fn provider_domains_keep_wsl_terminals_out_of_native_snapshot_failures() {
        let state = AppState::new();
        state.pty_handles.lock().unwrap().extend([
            (
                "terminal-native".into(),
                crate::pty::PtyHandle::from_test_writer(Box::new(std::io::sink()))
                    .with_child_pid(Some(101)),
            ),
            (
                "terminal-wsl".into(),
                crate::pty::PtyHandle::from_test_writer(Box::new(std::io::sink()))
                    .with_child_pid(Some(202))
                    .with_wsl_backed(true),
            ),
        ]);

        let domains =
            provider_terminal_domains(&["terminal-native".into(), "terminal-wsl".into()], &state)
                .unwrap();

        assert_eq!(domains.native_roots, vec![("terminal-native".into(), 101)]);
        assert_eq!(
            domains.wsl_terminal_ids,
            HashSet::from(["terminal-wsl".into()])
        );
    }

    #[test]
    fn generation_change_degrades_to_unknown() {
        let attribution = require_current_generation(
            TerminalSessionAttribution {
                generation: 8,
                state: SessionAttributionState::Identified,
                provider: Some("codex"),
                session_id: Some("session-before-restart".into()),
            },
            Some(9),
        );
        assert_eq!(attribution.generation, 8);
        assert_eq!(attribution.state, SessionAttributionState::Unknown);
        assert_eq!(attribution.session_id, None);
    }

    #[test]
    fn provider_lookups_start_concurrently_within_one_close_budget() {
        let gate = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let lookup =
            |started: std::sync::mpsc::Sender<()>,
             gate: Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>| {
                move || {
                    started.send(()).unwrap();
                    let (released, wake) = &*gate;
                    let mut released = released.lock().unwrap();
                    while !*released {
                        released = wake.wait(released).unwrap();
                    }
                    Ok(ProviderSessionLookup {
                        attributions: HashMap::new(),
                        failed_terminal_ids: HashSet::new(),
                    })
                }
            };
        let worker_gate = Arc::clone(&gate);
        let worker = std::thread::spawn(move || {
            collect_provider_session_lookups(
                lookup(started_tx.clone(), Arc::clone(&worker_gate)),
                lookup(started_tx.clone(), Arc::clone(&worker_gate)),
                lookup(started_tx, worker_gate),
            )
        });

        let mut started = 0;
        for _ in 0..3 {
            if started_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .is_ok()
            {
                started += 1;
            } else {
                break;
            }
        }
        let (released, wake) = &*gate;
        *released.lock().unwrap() = true;
        wake.notify_all();

        assert!(worker.join().unwrap().is_ok());
        assert_eq!(
            started, 3,
            "all provider lookups must share the time budget"
        );
    }
}
