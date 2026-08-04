//! Shared Windows→WSL probe plumbing.
//!
//! Two consumers cross the WSL boundary to inspect Linux processes that the
//! Windows process snapshot cannot see:
//!
//! - [`crate::commands::wsl_agent_session`] — agent session attribution on save.
//! - [`crate::wsl_liveness`] — the interactive-app liveness oracle (ADR-0134).
//!
//! Both need the same three things: which panes are WSL-backed and in which
//! distribution, a safe distribution name, and a bounded `wsl.exe --exec` run.
//! Those live here so the two probes cannot drift apart on the security-
//! relevant parts (distro validation, single deadline for all distros).

use std::time::{Duration, Instant};

#[cfg(windows)]
use crate::error::AppError;
#[cfg(windows)]
use crate::lock_ext::MutexExt;
#[cfg(windows)]
use crate::process::{headless_command, output_with_timeout};
#[cfg(windows)]
use crate::state::AppState;
#[cfg(windows)]
use crate::terminal::InitialExecutionHost;

/// Every WSL-backed terminal and the distribution its probe must run in.
/// `None` means the pane uses the default distribution, which the caller
/// resolves once per probe pass.
#[cfg(windows)]
pub fn wsl_terminal_targets(
    state: &AppState,
    deadline: Instant,
) -> Result<Vec<(String, Option<String>)>, AppError> {
    let terminals = state.terminals.lock_or_err()?;
    let mut unresolved_default = Vec::new();
    let mut targets = Vec::new();
    for (terminal_id, session) in terminals.iter() {
        if session.initial_execution_host != InitialExecutionHost::Wsl {
            continue;
        }
        let (distro, needs_default) = match terminal_distro_target(
            session.wsl_distro.as_deref(),
            &session.config.command_line,
        ) {
            Ok(target) => target,
            Err(error) => {
                tracing::warn!(
                    terminal_id,
                    %error,
                    "invalid explicit WSL distro failed closed"
                );
                (None, false)
            }
        };
        if needs_default {
            unresolved_default.push(targets.len());
        }
        targets.push((terminal_id.clone(), distro));
    }
    drop(terminals);

    if !unresolved_default.is_empty() {
        let default = remaining_timeout(deadline)
            .and_then(crate::path_utils::get_default_wsl_distro_with_timeout)
            .filter(|distro| is_safe_distro_name(distro));
        for index in unresolved_default {
            targets[index].1.clone_from(&default);
        }
    }
    Ok(targets)
}

/// Run `script` inside `distro` under a bounded timeout and return its stdout.
///
/// `arg0` names the shell invocation in the guest process list so an operator
/// reading `ps` can tell which laymux probe is running.
#[cfg(windows)]
pub fn run_probe_script(
    distro: &str,
    script: &str,
    arg0: &str,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    if !is_safe_distro_name(distro) {
        return Err("unsafe WSL distribution name".into());
    }
    let mut command = headless_command("wsl.exe");
    command.args(["-d", distro, "--exec", "sh", "-c", script, arg0]);
    let output = output_with_timeout(&mut command, timeout).map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("wsl.exe exited with {}", output.status));
    }
    Ok(output.stdout)
}

pub fn remaining_timeout(deadline: Instant) -> Option<Duration> {
    remaining_timeout_at(deadline, Instant::now())
}

pub fn remaining_timeout_at(deadline: Instant, now: Instant) -> Option<Duration> {
    deadline
        .checked_duration_since(now)
        .filter(|remaining| !remaining.is_zero())
}

/// Returns `(resolved distro, needs default lookup)`. Invalid stored or
/// explicit values are errors and must never be reinterpreted as bare WSL.
pub fn terminal_distro_target(
    stored_distro: Option<&str>,
    command_line: &str,
) -> Result<(Option<String>, bool), String> {
    match stored_distro {
        Some(distro) if is_safe_distro_name(distro) => Ok((Some(distro.to_string()), false)),
        Some(_) => Err("stored WSL distribution value is unsupported".into()),
        None => match explicit_wsl_distro_from_command_line(command_line)? {
            Some(distro) => Ok((Some(distro), false)),
            None => Ok((None, true)),
        },
    }
}

pub fn explicit_wsl_distro_from_command_line(command_line: &str) -> Result<Option<String>, String> {
    const LONG_FLAG: &str = "--distribution";
    const LONG_FLAG_EQ: &str = "--distribution=";
    let tokens: Vec<&str> = command_line.split_whitespace().collect();
    let mut selected: Option<String> = None;
    let mut index = 1;
    while index < tokens.len() {
        let argument = tokens[index];
        let lowercase = argument.to_ascii_lowercase();
        let value = if lowercase == "-d" || lowercase == LONG_FLAG {
            index += 1;
            tokens
                .get(index)
                .copied()
                .ok_or_else(|| "WSL distribution flag has no value".to_string())?
        } else if lowercase.starts_with(LONG_FLAG_EQ) {
            &argument[LONG_FLAG_EQ.len()..]
        } else {
            index += 1;
            continue;
        };
        if value.contains(['\'', '"']) || !is_safe_distro_name(value) {
            return Err("WSL distribution value is unsupported".into());
        }
        if let Some(previous) = selected.as_deref() {
            if !previous.eq_ignore_ascii_case(value) {
                return Err("WSL profile selects conflicting distributions".into());
            }
        } else {
            selected = Some(value.to_string());
        }
        index += 1;
    }
    Ok(selected)
}

pub fn is_safe_distro_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains(['/', '\\'])
        && !value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_unquoted_consistent_wsl_distribution_flags() {
        assert_eq!(
            explicit_wsl_distro_from_command_line("wsl.exe -d Ubuntu-22.04").unwrap(),
            Some("Ubuntu-22.04".into())
        );
        assert_eq!(
            explicit_wsl_distro_from_command_line("wsl --distribution=Debian").unwrap(),
            Some("Debian".into())
        );
        assert!(explicit_wsl_distro_from_command_line("wsl -d Ubuntu -d Debian").is_err());
        assert!(explicit_wsl_distro_from_command_line("wsl -d \"Ubuntu\"").is_err());
    }

    #[test]
    fn only_bare_wsl_requests_default_distro_lookup() {
        assert_eq!(
            terminal_distro_target(None, "wsl.exe").unwrap(),
            (None, true)
        );
        assert_eq!(
            terminal_distro_target(None, "wsl.exe -d Debian").unwrap(),
            (Some("Debian".into()), false)
        );
        assert!(terminal_distro_target(None, "wsl.exe -d").is_err());
        assert!(terminal_distro_target(Some("bad/name"), "wsl.exe").is_err());
    }

    #[test]
    fn resolution_budget_uses_one_injected_deadline() {
        let start = Instant::now();
        let deadline = start + Duration::from_secs(3);

        assert_eq!(
            remaining_timeout_at(deadline, start + Duration::from_secs(1)),
            Some(Duration::from_secs(2))
        );
        assert_eq!(remaining_timeout_at(deadline, deadline), None);
        assert_eq!(
            remaining_timeout_at(deadline, deadline + Duration::from_millis(1)),
            None
        );
    }

    #[test]
    fn rejects_distro_names_that_could_escape_the_argv() {
        assert!(is_safe_distro_name("Ubuntu-22.04"));
        assert!(!is_safe_distro_name(""));
        assert!(!is_safe_distro_name("."));
        assert!(!is_safe_distro_name(".."));
        assert!(!is_safe_distro_name("a/b"));
        assert!(!is_safe_distro_name("a\\b"));
        assert!(!is_safe_distro_name("a\nb"));
    }
}
