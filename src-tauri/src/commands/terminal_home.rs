//! The directory a pane's shell means by `~` (ADR-0288). Path links expand
//! `~/...` with it; it lives apart from `file_ops.rs` because it is about the
//! pane's execution host, not the filesystem.

use std::sync::Arc;

use tauri::State;

use super::file_ops::home_directory;
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use crate::terminal::InitialExecutionHost;

/// The directory a pane's shell means by `~`, so a path link such as
/// `~/notes/a.md` resolves where that shell would (ADR-0288).
///
/// The spawn-time host decides, not the cwd: a WSL pane sitting in `/mnt/c/...`
/// still means its Linux `$HOME`, and a PowerShell pane's cwd reaches the
/// frontend normalized to the same `/mnt/c/...` form. A direct SSH pane's home
/// lives on another machine, and an unclassified pane has no host to ask yet.
/// The resolvers are injected so the routing is testable without a WSL guest.
pub fn terminal_home_directory(
    state: &AppState,
    terminal_id: &str,
    host_home: impl FnOnce() -> Option<String>,
    wsl_home: impl FnOnce(Option<&str>) -> Option<String>,
) -> Option<String> {
    let (host, wsl_target) = {
        let terminals = state.terminals.lock_or_err().ok()?;
        let session = terminals.get(terminal_id)?;
        let wsl_target = (session.initial_execution_host == InitialExecutionHost::Wsl).then(|| {
            crate::wsl_probe::terminal_distro_target(
                session.wsl_distro.as_deref(),
                &session.config.command_line,
            )
        });
        (session.initial_execution_host, wsl_target)
    };
    match host {
        // An unsafe stored or explicit distro fails closed instead of falling
        // back to the default distribution's home.
        InitialExecutionHost::Wsl => {
            let (distro, _needs_default) = wsl_target?.ok()?;
            wsl_home(distro.as_deref())
        }
        InitialExecutionHost::NativeWindows | InitialExecutionHost::NonWindows => host_home(),
        InitialExecutionHost::DirectSsh | InitialExecutionHost::Unknown => None,
    }
}

/// Return the home directory a terminal pane's shell expands `~` to, or `None`.
#[tauri::command(async)]
pub fn get_terminal_home_directory(
    terminal_id: String,
    state: State<Arc<AppState>>,
) -> Option<String> {
    terminal_home_directory(&state, &terminal_id, home_directory, wsl_home_directory)
}

/// `$HOME` of `distro` (or the default distribution) — one bounded, cached
/// `wsl.exe` probe per distribution.
#[cfg(windows)]
fn wsl_home_directory(distro: Option<&str>) -> Option<String> {
    let distro = distro
        .map(str::to_owned)
        .or_else(crate::path_utils::get_default_wsl_distro)?;
    crate::wsl_probe::home_dir_cached(&distro, crate::constants::WSL_AGENT_PROBE_TIMEOUT)
}

/// WSL panes only exist on a Windows host.
#[cfg(not(windows))]
fn wsl_home_directory(_distro: Option<&str>) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(
        id: &str,
        host: InitialExecutionHost,
        command_line: &str,
    ) -> crate::terminal::TerminalSession {
        let config = crate::terminal::TerminalConfig {
            command_line: command_line.into(),
            ..Default::default()
        };
        let mut session = crate::terminal::TerminalSession::new(id.into(), config);
        session.initial_execution_host = host;
        // A PowerShell cwd is normalized to /mnt/c/... too, so the cwd cannot decide.
        session.cwd = Some("/mnt/c/Users/me".into());
        session
    }

    fn state_with(sessions: Vec<crate::terminal::TerminalSession>) -> AppState {
        let state = AppState::new();
        let mut terminals = state.terminals.lock().unwrap();
        for session in sessions {
            terminals.insert(session.id.clone(), session);
        }
        drop(terminals);
        state
    }

    const HOST_HOME: fn() -> Option<String> = || Some(r"C:\Users\me".into());

    fn wsl_home(distro: Option<&str>) -> Option<String> {
        Some(format!("/home/{}", distro.unwrap_or("default")))
    }

    #[test]
    fn terminal_home_follows_the_spawn_host_not_the_cwd() {
        let state = state_with(vec![
            session("ps", InitialExecutionHost::NativeWindows, "powershell.exe"),
            session("wsl", InitialExecutionHost::Wsl, "wsl.exe"),
            session("linux", InitialExecutionHost::NonWindows, "bash"),
        ]);

        assert_eq!(
            terminal_home_directory(&state, "ps", HOST_HOME, wsl_home),
            Some(r"C:\Users\me".into())
        );
        assert_eq!(
            terminal_home_directory(&state, "wsl", HOST_HOME, wsl_home),
            Some("/home/default".into())
        );
        assert_eq!(
            terminal_home_directory(&state, "linux", HOST_HOME, wsl_home),
            Some(r"C:\Users\me".into())
        );
    }

    #[test]
    fn wsl_terminal_home_uses_the_pane_distribution() {
        let mut reported = session("reported", InitialExecutionHost::Wsl, "wsl.exe");
        reported.wsl_distro = Some("Debian".into());
        let state = state_with(vec![
            reported,
            session(
                "explicit",
                InitialExecutionHost::Wsl,
                "wsl.exe -d Ubuntu-22.04",
            ),
        ]);

        assert_eq!(
            terminal_home_directory(&state, "reported", HOST_HOME, wsl_home),
            Some("/home/Debian".into())
        );
        assert_eq!(
            terminal_home_directory(&state, "explicit", HOST_HOME, wsl_home),
            Some("/home/Ubuntu-22.04".into())
        );
    }

    #[test]
    fn terminal_without_a_local_home_has_none() {
        let mut unsafe_distro = session("unsafe", InitialExecutionHost::Wsl, "wsl.exe");
        unsafe_distro.wsl_distro = Some("bad/name".into());
        let state = state_with(vec![
            session("ssh", InitialExecutionHost::DirectSsh, "ssh.exe host"),
            session("unknown", InitialExecutionHost::Unknown, ""),
            unsafe_distro,
        ]);
        let no_wsl = |_: Option<&str>| -> Option<String> { panic!("must not probe WSL") };

        assert_eq!(
            terminal_home_directory(&state, "ssh", HOST_HOME, no_wsl),
            None
        );
        assert_eq!(
            terminal_home_directory(&state, "unknown", HOST_HOME, no_wsl),
            None
        );
        assert_eq!(
            terminal_home_directory(&state, "unsafe", HOST_HOME, no_wsl),
            None
        );
        assert_eq!(
            terminal_home_directory(&state, "missing", HOST_HOME, no_wsl),
            None
        );
    }
}
