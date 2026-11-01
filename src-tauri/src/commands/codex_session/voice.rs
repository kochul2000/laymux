use crate::agent_voice::Target;
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use crate::wsl_probe::snapshot::GuestObservation;
use std::collections::HashSet;

pub(crate) fn codex_voice_target(state: &AppState, id: &str) -> Result<Target, String> {
    let generation = state
        .pty_handles
        .lock_or_err()?
        .get(id)
        .ok_or("Codex pane disappeared")?
        .terminal_generation();
    let title = state
        .terminals
        .lock_or_err()?
        .get(id)
        .ok_or("Codex pane disappeared")?
        .codex_hook_title
        .clone();
    let scope = HashSet::from([id.to_owned()]);
    let observation = GuestObservation::starting_now();
    let thread_id=title.identity.clone().ok_or("Cannot identify this Codex conversation. Include thread-id in Codex /title before connecting Voice.")?;
    let domains =
        crate::commands::session_attribution::provider_terminal_domains_scoped(state, Some(&scope))
            .map_err(|e| e.to_string())?;
    let (home, distro) = if domains.wsl_terminal_ids.contains(id) {
        let mut result = crate::commands::wsl_agent_session::resolve_wsl_agent_processes_scoped(
            state,
            crate::commands::wsl_agent_session::WslAgentProvider::Codex,
            observation,
            Some(&scope),
        )
        .map_err(|e| e.to_string())?;
        let process = result
            .attributions
            .remove(id)
            .flatten()
            .ok_or("Cannot identify this WSL Codex process")?;
        let home = process
            .codex_home
            .unwrap_or_else(|| format!("{}/.codex", process.home.trim_end_matches('/')));
        (std::path::PathBuf::from(home), Some(process.distro))
    } else {
        let root = domains
            .native_roots
            .iter()
            .find(|(terminal, _)| terminal == id)
            .map(|(_, pid)| *pid)
            .ok_or("Codex pane is not running")?;
        let snapshot = crate::process_tree::session_processes(state, observation)
            .map_err(|e| e.to_string())?;
        let (pid, "Codex") = crate::process_tree::match_interactive_app_process(&snapshot, root)
            .ok_or("Codex is not running in this pane")?
        else {
            return Err("This pane is not a Codex session".into());
        };
        (
            super::status_probe::process_context::read(pid)?.codex_home,
            None,
        )
    };
    let current_generation = state
        .pty_handles
        .lock_or_err()?
        .get(id)
        .ok_or("Codex pane disappeared")?
        .terminal_generation();
    let current_title = state
        .terminals
        .lock_or_err()?
        .get(id)
        .ok_or("Codex pane disappeared")?
        .codex_hook_title
        .clone();
    if generation != current_generation || title != current_title {
        return Err("Codex pane changed during Voice discovery".into());
    }
    let socket_path = if distro.is_some() {
        std::path::PathBuf::from(format!(
            "{}/app-server-control/app-server-control.sock",
            home.to_string_lossy().trim_end_matches('/')
        ))
    } else {
        home.join("app-server-control")
            .join("app-server-control.sock")
    };
    Ok(Target {
        terminal_id: id.into(),
        generation,
        title,
        thread_id,
        socket_path,
        distro,
    })
}
