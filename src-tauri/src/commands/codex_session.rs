mod store;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;

use super::claude_session::is_valid_session_id;
use super::session_attribution::ProviderSessionLookup;
use super::wsl_agent_session::{resolve_wsl_agent_processes, WslAgentProvider};
use crate::constants::{ENV_CODEX_HOME, ENV_CODEX_SQLITE_HOME};
use crate::lock_ext::MutexExt;
use crate::process_tree::match_interactive_app_process;
use crate::state::AppState;

use self::store::CodexSessionStore;

/// Resolve Codex CLI session IDs only when the owning pane can be proven.
///
/// Native terminals use the PTY child tree and Codex diagnostics DB. Windows
/// WSL terminals use the inherited pane marker and rollout FDs of the exact
/// Linux process. CWD is deliberately not a fallback: panes commonly share it.
#[tauri::command(async)]
pub fn get_codex_session_ids(
    session_max_age_hours: Option<u64>,
    state: State<Arc<AppState>>,
) -> Result<HashMap<String, Option<String>>, String> {
    get_codex_session_ids_impl(session_max_age_hours, &state).map_err(|error| error.to_string())
}

pub(crate) fn get_codex_session_ids_impl(
    session_max_age_hours: Option<u64>,
    state: &AppState,
) -> Result<HashMap<String, Option<String>>, crate::error::AppError> {
    Ok(get_codex_session_lookup_impl(session_max_age_hours, state)?.attributions)
}

pub(crate) fn get_codex_session_lookup_impl(
    session_max_age_hours: Option<u64>,
    state: &AppState,
) -> Result<ProviderSessionLookup, crate::error::AppError> {
    let known: Vec<String> = state
        .known_codex_terminals
        .lock_or_err()?
        .iter()
        .cloned()
        .collect();
    let terminal_roots: Vec<(String, u32)> = {
        let ptys = state.pty_handles.lock_or_err()?;
        known
            .iter()
            .cloned()
            .filter_map(|terminal_id| {
                let child_pid = ptys.get(&terminal_id)?.child_pid()?;
                Some((terminal_id, child_pid))
            })
            .collect()
    };
    let mut failed_terminal_ids = HashSet::new();
    let terminal_codex_pids: Vec<(String, u32)> =
        match crate::process_tree::try_snapshot_processes() {
            Ok(snapshot) => terminal_roots
                .into_iter()
                .filter_map(|(terminal_id, root_pid)| {
                    let (pid, app) = match_interactive_app_process(&snapshot, root_pid)?;
                    (app == "Codex").then_some((terminal_id, pid))
                })
                .collect(),
            Err(error) => {
                failed_terminal_ids.extend(known.iter().cloned());
                tracing::warn!(%error, "native Codex process attribution failed");
                Vec::new()
            }
        };

    let store = CodexSessionStore::resolve();
    let mut candidates = Vec::new();
    for (terminal_id, pid) in &terminal_codex_pids {
        match store.find_session_for_pid_checked(*pid, session_max_age_hours) {
            Ok(Some(session_id)) => candidates.push((terminal_id.clone(), session_id)),
            Ok(None) => tracing::debug!(
                pid,
                "Codex PID could not be attributed to a valid top-level thread"
            ),
            Err(error) => {
                failed_terminal_ids.insert(terminal_id.clone());
                tracing::warn!(pid, %error, "native Codex session lookup failed");
            }
        }
    }
    let exact = remove_duplicate_candidates(candidates);
    let mut result = crate::process_tree::complete_agent_session_attributions(&known, exact);
    match resolve_wsl_agent_processes(state, WslAgentProvider::Codex) {
        Ok(lookup) => {
            failed_terminal_ids.extend(lookup.failed_terminal_ids);
            for (terminal_id, process) in lookup.attributions {
                let session_id = match process {
                    Some(process) => {
                        match super::codex_session::store::find_session_from_rollout_paths_checked(
                            &process.codex_rollout_paths(),
                            session_max_age_hours,
                        ) {
                            Ok(session_id) => session_id,
                            Err(error) => {
                                failed_terminal_ids.insert(terminal_id.clone());
                                tracing::warn!(%error, "WSL Codex rollout lookup failed");
                                None
                            }
                        }
                    }
                    None => None,
                };
                result.insert(terminal_id, session_id);
            }
        }
        Err(error) => {
            failed_terminal_ids.extend(known.iter().cloned());
            tracing::warn!(%error, "WSL Codex attribution failed");
        }
    }
    Ok(ProviderSessionLookup {
        attributions: crate::process_tree::reject_duplicate_session_attributions(result, "Codex"),
        failed_terminal_ids,
    })
}

fn remove_duplicate_candidates(candidates: Vec<(String, String)>) -> HashMap<String, String> {
    let mut unique = HashSet::new();
    let mut duplicates = HashSet::new();
    for (_, session_id) in &candidates {
        if !unique.insert(session_id.clone()) {
            duplicates.insert(session_id.clone());
        }
    }
    if !duplicates.is_empty() {
        tracing::warn!(
            ?duplicates,
            "Codex session attribution collision; skipping restore"
        );
    }
    candidates
        .into_iter()
        .filter(|(_, session_id)| !duplicates.contains(session_id))
        .collect()
}

/// Build a one-to-one terminal/session assignment and reject any collision.
/// A duplicate is evidence that attribution is not exact, so every pane in
/// that collision is omitted instead of guessing which one owns the thread.
#[cfg(test)]
fn assign_exact_sessions(
    terminals: &[(String, u32)],
    mut find_session: impl FnMut(u32) -> Option<String>,
) -> HashMap<String, String> {
    let candidates: Vec<(String, String)> = terminals
        .iter()
        .filter_map(|(terminal_id, pid)| {
            find_session(*pid).map(|session_id| (terminal_id.clone(), session_id))
        })
        .collect();
    remove_duplicate_candidates(candidates)
}

/// Accept only the exact `<configured codex command> resume <safe-id>` form.
/// The command prefix comes from settings on disk (`codex.command`, normalized),
/// never from the caller.
pub(crate) fn is_valid_codex_startup_command_override(
    command: &str,
    configured_command: &str,
) -> bool {
    let agent = crate::settings::agent_command::resolve_agent_command(
        configured_command,
        crate::settings::agent_command::DEFAULT_CODEX_COMMAND,
    );
    command
        .strip_prefix(&format!("{agent} resume "))
        .is_some_and(is_valid_session_id)
}

fn resolve_codex_roots() -> (PathBuf, PathBuf) {
    let codex_home = std::env::var_os(ENV_CODEX_HOME)
        .map(PathBuf::from)
        .or_else(platform_codex_home)
        .unwrap_or_else(|| PathBuf::from(".codex"));
    let sqlite_home = std::env::var_os(ENV_CODEX_SQLITE_HOME)
        .map(PathBuf::from)
        .unwrap_or_else(|| codex_home.clone());
    (codex_home, sqlite_home)
}

fn platform_codex_home() -> Option<PathBuf> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    home.map(PathBuf::from).map(|path| path.join(".codex"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_pid_assignment_keeps_same_cwd_panes_distinct() {
        let terminals = vec![("pane-a".into(), 101), ("pane-b".into(), 202)];
        let result = assign_exact_sessions(&terminals, |pid| match pid {
            101 => Some("session-a".into()),
            202 => Some("session-b".into()),
            _ => None,
        });

        assert_eq!(result.get("pane-a").map(String::as_str), Some("session-a"));
        assert_eq!(result.get("pane-b").map(String::as_str), Some("session-b"));
    }

    #[test]
    fn duplicate_session_attribution_fails_closed_for_every_colliding_pane() {
        let terminals = vec![("pane-a".into(), 101), ("pane-b".into(), 202)];
        let result = assign_exact_sessions(&terminals, |_| Some("same-session".into()));
        assert!(result.is_empty());
    }

    #[test]
    fn missing_pid_attribution_does_not_guess() {
        let terminals = vec![("pane-a".into(), 101), ("pane-b".into(), 202)];
        let result =
            assign_exact_sessions(&terminals, |pid| (pid == 101).then(|| "session-a".into()));
        assert_eq!(result.len(), 1);
        assert_eq!(result.get("pane-a").map(String::as_str), Some("session-a"));
    }

    #[test]
    fn startup_override_accepts_only_exact_safe_resume_form() {
        assert!(is_valid_codex_startup_command_override(
            "codex resume 019fc0d8-a862-7241-a0f5-b6a66ef4ef6f",
            "codex"
        ));
        for invalid in [
            "codex resume --last",
            "codex resume bad;echo-pwned",
            "codex resume $(whoami)",
            "codex --resume abc",
            "claude --resume abc",
            "",
        ] {
            assert!(!is_valid_codex_startup_command_override(invalid, "codex"));
        }
    }

    #[test]
    fn startup_override_follows_the_configured_launch_command() {
        assert!(is_valid_codex_startup_command_override(
            "codex --yolo resume 019fc0d8-a862-7241-a0f5-b6a66ef4ef6f",
            "codex --yolo"
        ));
        // Flags the user did not configure are not accepted from the caller.
        assert!(!is_valid_codex_startup_command_override(
            "codex --yolo resume 019fc0d8-a862-7241-a0f5-b6a66ef4ef6f",
            "codex"
        ));
        // An unsafe setting falls back to the bare default.
        assert!(is_valid_codex_startup_command_override(
            "codex resume 019fc0d8",
            "codex && echo pwned"
        ));
        assert!(!is_valid_codex_startup_command_override(
            "codex && echo pwned resume 019fc0d8",
            "codex && echo pwned"
        ));
    }

    #[test]
    fn codex_and_sqlite_roots_are_independent() {
        let codex_home = PathBuf::from("D:/codex");
        let sqlite_home = PathBuf::from("D:/codex-state");
        let store = CodexSessionStore::new(codex_home.clone(), sqlite_home.clone());
        assert_eq!(store.sessions_dir(), codex_home.join("sessions"));
        assert_eq!(store.sqlite_home(), sqlite_home.as_path());
    }
}
