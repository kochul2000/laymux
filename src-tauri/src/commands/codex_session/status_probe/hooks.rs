//! Fenced lifecycle identity; task phase expiry is deliberately irrelevant.
use super::targets;
use crate::agent_hooks::{title::TitleBinding, ManageRequest};
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
    selected: Option<&str>,
    required: Option<&CodexHookBinding>,
) -> Result<Option<(CodexHookBinding, String, bool)>, String> {
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
        selected,
        required,
    );
    let Some(candidate) = candidate else {
        return Ok(None);
    };
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let directory = executable
        .parent()
        .ok_or("Codex hook helper directory unavailable")?;
    let status = crate::agent_hooks::manage_in_directory(
        &ManageRequest {
            provider: "codex".into(),
            operation: "status".into(),
            distro: process.distro.clone(),
            config_dir: Some(candidate.root.clone()),
        },
        directory,
    );
    if !status.is_ok_and(|v| {
        v["installed"] == true
            && v["disabled"] == false
            && v["warning"].is_null()
            && (matches!(candidate.binding, CodexHookBinding::Process(_))
                || (v["titleBinding"]["configured"] == true
                    && v["titleBinding"]["warning"].is_null()))
    }) {
        return Ok(None);
    }
    let fresh = match targets::verify_session(process, &candidate.id) {
        Ok(fresh) => fresh,
        Err(_) => return Ok(None),
    };
    let current_title = state
        .terminals
        .lock_or_err()?
        .get(terminal)
        .map(|s| s.codex_hook_title.clone());
    let current_generation = state
        .pty_handles
        .lock_or_err()?
        .get(terminal)
        .map(|h| h.terminal_generation());
    let still_same = match &candidate.binding {
        CodexHookBinding::Title(title) => state
            .agent_hook_observations
            .lock_or_err()?
            .codex_conversation(
                title.identity.as_deref().unwrap_or_default(),
                process.distro.as_deref(),
            )
            .is_some_and(|o| {
                o.event.session_id == candidate.id
                    && o.event.config_dir.as_deref() == Some(candidate.root.as_str())
            }),
        CodexHookBinding::Process(_) => {
            super::super::get_codex_session_lookup_impl(None, state)?
                .attributions
                .get(terminal)
                .and_then(|id| id.as_deref())
                == Some(candidate.id.as_str())
        }
    };
    // The diagnostic I/O above can outlive the TUI. Recheck its incarnation.
    targets::require_current_process(state, terminal, process)?;
    if current_title != title || current_generation != Some(generation) || !still_same {
        return Ok(None);
    }
    let final_title = state
        .terminals
        .lock_or_err()?
        .get(terminal)
        .map(|s| s.codex_hook_title.clone());
    let final_generation = state
        .pty_handles
        .lock_or_err()?
        .get(terminal)
        .map(|h| h.terminal_generation());
    if final_title != title || final_generation != Some(generation) {
        return Ok(None);
    }
    Ok(Some((candidate.binding, candidate.id, fresh)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
pub(crate) fn verified_status_sessions(
    state: &AppState,
) -> Result<HashMap<String, (u64, String, bool)>, String> {
    let targets: Vec<_> = {
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
        checkpoint
            .targets
            .iter()
            .filter(|(_, target)| target.proof.is_some())
            .map(|(id, target)| (id.clone(), target.clone()))
            .collect()
    };
    let mut result = HashMap::new();
    let selections = if targets.iter().any(|(_, t)| t.hook_binding.is_some()) {
        Some(super::super::get_codex_session_lookup_impl(None, state)?)
    } else {
        None
    };
    for (terminal, target) in targets {
        super::current_handle(state, &terminal, &target)?;
        if let Some(expected_binding) = &target.hook_binding {
            let current = resolve(
                state,
                &terminal,
                target.generation,
                &target.process,
                selections
                    .as_ref()
                    .and_then(|s| s.attributions.get(&terminal))
                    .and_then(|s| s.as_deref()),
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
            let fresh = targets::verify_session(&target.process, &id)?;
            result.insert(terminal, (target.generation, id, fresh));
        }
    }
    Ok(result)
}
