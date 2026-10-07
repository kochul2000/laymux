//! Fenced lifecycle identity; task phase expiry is deliberately irrelevant.
use super::targets;
use crate::agent_hooks::title::TitleBinding;
use crate::commands::session_attribution::ProviderSessionLookup;
use crate::lock_ext::MutexExt;
use crate::session_checkpoint::codex_status::{CodexHookBinding, CodexStatusProcess};
use crate::state::AppState;
use std::collections::HashMap;
use std::path::Path;

struct Candidate {
    binding: CodexHookBinding,
    id: String,
    root: String,
}

fn candidate(
    registry: &crate::agent_hooks::observations::HookRegistry,
    title: Option<&TitleBinding>,
    generation: u64,
    process: &CodexStatusProcess,
    selected: Option<&str>,
    required: Option<&CodexHookBinding>,
) -> Option<Candidate> {
    let live_title = title.filter(|t| t.generation == generation && t.identity.is_some());
    if !matches!(required, Some(CodexHookBinding::Process(_))) {
        if let Some(title) = live_title {
            if let Some(event) = registry
                .codex_conversation(title.identity.as_deref()?, process.distro.as_deref())
                .map(|o| &o.event)
                .filter(|event| matches_process(event, process, selected))
            {
                return Some(Candidate {
                    binding: CodexHookBinding::Title(title.clone()),
                    id: event.session_id.clone(),
                    root: event.config_dir.clone()?,
                });
            }
        }
    }
    if matches!(required, Some(CodexHookBinding::Title(_))) {
        return None;
    }
    let id = selected?;
    if !uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id)
        || live_title.is_some_and(|t| !id.starts_with(t.identity.as_deref().unwrap_or_default()))
    {
        return None;
    }
    let root = process.codex_home.to_str()?;
    let root = if process.distro.is_some() {
        crate::path_utils::normalize_wsl_path(&root.replace('\\', "/"))
    } else {
        root.into()
    };
    // Converting the selected process root must never switch WSL domains.
    if Path::new(&crate::path_utils::resolve_path_for_windows(
        &root,
        process.distro.as_deref(),
    )) != process.codex_home
    {
        return None;
    }
    Some(Candidate {
        binding: CodexHookBinding::Process(title.cloned()),
        id: id.into(),
        root,
    })
}

#[cfg(test)]
mod batch_tests;
#[cfg(test)]
mod selection_tests;

fn matches_process(
    event: &laymux_agent_hook::runtime::HookEvent,
    process: &CodexStatusProcess,
    selected: Option<&str>,
) -> bool {
    event.provider == "codex"
        && event.agent_id.is_none()
        && event.event != "SessionEnd"
        && event.distro == process.distro
        && selected.is_none_or(|id| id == event.session_id)
        && event.config_dir.as_deref().is_some_and(|root| {
            Path::new(&crate::path_utils::resolve_path_for_windows(
                root,
                process.distro.as_deref(),
            )) == process.codex_home
        })
}

pub(super) fn resolve(
    state: &AppState,
    terminal: &str,
    generation: u64,
    process: &CodexStatusProcess,
    selection: Option<(&str, bool)>,
    required: Option<&CodexHookBinding>,
) -> Result<Option<(CodexHookBinding, String, bool)>, String> {
    // The common lookup already validated process selection or title/hook plus
    // rollout. Installation status is not evidence of a live conversation.
    let Some((selected, fresh)) = selection else {
        return Ok(None);
    };
    let title = state
        .terminals
        .lock_or_err()?
        .get(terminal)
        .map(|s| s.codex_hook_title.clone());
    let candidate = candidate(
        &*state.agent_hook_observations.lock_or_err()?,
        title.as_ref(),
        generation,
        process,
        Some(selected),
        required,
    );
    let Some(candidate) = candidate else {
        return Ok(None);
    };
    if candidate.id != selected
        || Path::new(&crate::path_utils::resolve_path_for_windows(
            &candidate.root,
            process.distro.as_deref(),
        )) != process.codex_home
    {
        return Ok(None);
    }
    let current_generation = state
        .pty_handles
        .lock_or_err()?
        .get(terminal)
        .map(|h| h.terminal_generation());
    let final_title = state
        .terminals
        .lock_or_err()?
        .get(terminal)
        .map(|s| s.codex_hook_title.clone());
    if final_title != title || current_generation != Some(generation) {
        return Ok(None);
    }
    Ok(Some((candidate.binding, candidate.id, fresh)))
}

pub(crate) fn verified_status_sessions(
    state: &AppState,
    lookup: &ProviderSessionLookup,
) -> Result<HashMap<String, (u64, String, bool)>, String> {
    verified_with_processes(state, lookup, || targets::processes(state))
}

fn verified_with_processes(
    state: &AppState,
    lookup: &ProviderSessionLookup,
    processes: impl FnOnce() -> Result<HashMap<String, CodexStatusProcess>, String>,
) -> Result<HashMap<String, (u64, String, bool)>, String> {
    let (token, targets): (_, Vec<_>) = {
        let slot = state.session_checkpoint.codex_status.lock_or_err()?;
        let Some(checkpoint) = slot.as_ref() else {
            return Ok(HashMap::new());
        };
        if checkpoint.check(&checkpoint.token).is_err()
            || !state.session_checkpoint.is_finalizing()
            || checkpoint.update_request_id.is_some_and(|id| {
                !state
                    .session_checkpoint
                    .owns_update_checkpoint(id)
                    .unwrap_or(false)
            })
        {
            return Ok(HashMap::new());
        }
        let targets = checkpoint
            .targets
            .iter()
            .filter(|(_, target)| target.proof.is_some())
            .map(|(id, target)| (id.clone(), target.clone()))
            .collect();
        (checkpoint.token.clone(), targets)
    };
    if targets.is_empty() {
        return Ok(HashMap::new());
    }
    let mut result = HashMap::new();
    // One current process snapshot for the whole checkpoint, not one global
    // discovery for each pane followed by another for each hook resolver.
    let processes = processes()?;
    let handles = state.pty_handles.lock_or_err()?.clone();
    for (terminal, target) in targets {
        if processes.get(&terminal) != Some(&target.process)
            || handles
                .get(&terminal)
                .is_none_or(|h| h.terminal_generation() != target.generation)
        {
            return Err(format!(
                "[{terminal}] Codex process or terminal generation changed during checkpoint"
            ));
        }
        if let Some(expected_binding) = &target.hook_binding {
            let current = resolve(
                state,
                &terminal,
                target.generation,
                &target.process,
                verified_selection(lookup, &terminal),
                Some(expected_binding),
            )?;
            if !current.is_some_and(|(binding, id, _)| {
                &binding == expected_binding
                    && target
                        .proof
                        .as_ref()
                        .is_some_and(|(expected, _)| expected == &id)
            }) {
                return Err(format!(
                    "[{terminal}] Codex hook conversation changed during checkpoint"
                ));
            }
        }
        if let Some((id, _)) = target.proof {
            if lookup
                .attributions
                .get(&terminal)
                .and_then(Option::as_deref)
                .is_some_and(|current| current != id)
            {
                return Err(format!(
                    "[{terminal}] Codex conversation changed after status verification"
                ));
            }
            let fresh = if target.hook_binding.is_some() {
                lookup.fresh_sessions.get(&terminal) == Some(&id)
            } else {
                targets::verify_session(&target.process, &id)?
            };
            if !fresh && target.hook_binding.is_none() {
                targets::remember_checkpoint_file(
                    state,
                    &terminal,
                    target.generation,
                    &target.process,
                    &id,
                );
            }
            result.insert(terminal, (target.generation, id, fresh));
        }
    }
    let slot = state.session_checkpoint.codex_status.lock_or_err()?;
    let checkpoint = slot
        .as_ref()
        .ok_or("Codex status checkpoint was cancelled")?;
    checkpoint.check(&token)?;
    if !state.session_checkpoint.is_finalizing() {
        return Err("Codex checkpoint lost its input fence during verification".into());
    }
    Ok(result)
}

pub(super) fn verified_selection<'a>(
    lookup: &'a ProviderSessionLookup,
    terminal: &str,
) -> Option<(&'a str, bool)> {
    if lookup.failed_terminal_ids.contains(terminal) {
        return None;
    }
    let id = lookup.attributions.get(terminal)?.as_deref()?;
    Some((
        id,
        lookup
            .fresh_sessions
            .get(terminal)
            .is_some_and(|fresh| fresh == id),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn verified_current_conversation_does_not_require_hook_installation_io() {
        let state = AppState::new();
        let home = tempfile::tempdir().unwrap();
        let process = CodexStatusProcess {
            pid: 1,
            started_at: 2,
            distro: None,
            codex_home: home.path().into(),
            sqlite_home: home.path().into(),
        };
        state.pty_handles.lock().unwrap().insert(
            "pane".into(),
            crate::pty::PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), 3),
        );
        let id = "01a0ec06-451a-7e61-ac51-bd98fab4ed82";
        assert!(
            resolve(&state, "pane", 3, &process, Some((id, false)), None)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn lifecycle_candidate_requires_exact_environment_root_and_never_overrides_a_selection() {
        for distro in [None, Some("Ubuntu-22.04")] {
            let root = if distro.is_some() {
                "/tmp/codex"
            } else if cfg!(windows) {
                "C:\\codex"
            } else {
                "/tmp/codex"
            };
            let mut event = laymux_agent_hook::runtime::parse_event(
                "codex",
                &json!({"session_id":"current","hook_event_name":"Stop"}),
                "old-pane".into(),
                "old-token".into(),
            )
            .unwrap();
            event.config_dir = Some(root.into());
            event.distro = distro.map(str::to_owned);
            let process = CodexStatusProcess {
                pid: 1,
                started_at: 2,
                distro: event.distro.clone(),
                codex_home: crate::path_utils::resolve_path_for_windows(root, distro).into(),
                sqlite_home: "unused".into(),
            };
            assert!(matches_process(&event, &process, None));
            assert!(matches_process(&event, &process, Some("current")));
            assert!(!matches_process(&event, &process, Some("different")));
            for mutation in ["provider", "root", "distro", "subagent", "end"] {
                let mut invalid = event.clone();
                match mutation {
                    "provider" => invalid.provider = "claude".into(),
                    "root" => invalid.config_dir = Some("/different".into()),
                    "distro" => invalid.distro = Some("other".into()),
                    "subagent" => invalid.agent_id = Some("child".into()),
                    _ => invalid.event = "SessionEnd".into(),
                }
                assert!(!matches_process(&invalid, &process, None), "{mutation}");
            }
        }
    }
}
