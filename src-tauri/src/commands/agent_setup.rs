//! Read-only agent installation diagnostics for an explicitly chosen profile.

use serde::{Deserialize, Serialize};
use std::time::Duration;

#[cfg(windows)]
use crate::process::headless_command;
use crate::process::output_bounded_with_timeout;
use crate::settings::{agent_command, Profile, Settings};
use crate::terminal::TerminalSession;

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const PROBE_OUTPUT_LIMIT: usize = 4096;
const FOUND_MARKER: &str = "LAYMUX_AGENT_FOUND";

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartupRequest {
    pub agent_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallationStatus {
    pub status: &'static str,
    pub environment: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_command: Option<String>,
}

fn agent_command_for(settings: &Settings, agent_id: &str) -> Result<String, String> {
    let (configured, fallback) = match agent_id {
        "claude" => (
            &settings.claude.command,
            agent_command::DEFAULT_CLAUDE_COMMAND,
        ),
        "codex" => (
            &settings.codex.command,
            agent_command::DEFAULT_CODEX_COMMAND,
        ),
        "grok" => (&settings.grok.command, agent_command::DEFAULT_GROK_COMMAND),
        _ => return Err(format!("Unsupported agent: {agent_id}")),
    };
    Ok(agent_command::resolve_agent_command(configured, fallback))
}

pub(crate) fn agent_startup_command(settings: &Settings, agent_id: &str) -> Result<String, String> {
    agent_command_for(settings, agent_id)
}

fn unknown(
    environment: &'static str,
    detail: impl Into<String>,
    command: String,
) -> AgentInstallationStatus {
    AgentInstallationStatus {
        status: "unknown",
        environment,
        version: None,
        detail: Some(detail.into()),
        effective_command: Some(command),
    }
}

fn probe_plan(
    profile: &Profile,
    executable: &str,
) -> Result<(std::process::Command, &'static str), (&'static str, String)> {
    // An explicit agent launch replaces profile.startup_command, so neither
    // the launch nor its read-only diagnostic executes that stored command.
    let line = if profile.command_line.trim().is_empty() {
        TerminalSession::profile_command_line(&profile.name)
    } else {
        &profile.command_line
    };
    let parts: Vec<&str> = line.split_whitespace().collect();
    let shell = parts.first().copied().unwrap_or("");
    let basename = shell
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(shell)
        .to_ascii_lowercase();
    let stem = basename.strip_suffix(".exe").unwrap_or(&basename);
    #[cfg(windows)]
    {
        if stem == "wsl" {
            let mut command = headless_command(shell);
            let mut args = parts[1..].iter().copied().peekable();
            let mut explicit_distro = None;
            while let Some(arg) = args.next() {
                if arg == "--" && args.peek().is_none() {
                    break;
                }
                if matches!(arg, "-d" | "--distribution" | "-u" | "--user" | "--cd") {
                    let value = args
                        .next()
                        .ok_or(("wsl", format!("WSL option {arg} has no value")))?;
                    if value.starts_with('-') || value.contains(['\'', '"']) {
                        return Err(("wsl", "Unsupported WSL option value".into()));
                    }
                    if matches!(arg, "-d" | "--distribution") {
                        explicit_distro = Some(value);
                    }
                    command.args([arg, value]);
                } else if ["--distribution=", "--user=", "--cd="]
                    .iter()
                    .any(|prefix| arg.starts_with(prefix) && arg.len() > prefix.len())
                {
                    if let Some(value) = arg.strip_prefix("--distribution=") {
                        explicit_distro = Some(value);
                    }
                    command.arg(arg);
                } else {
                    return Err(("wsl", format!("Unsupported WSL profile option: {arg}")));
                }
            }
            if let Some(distro) = explicit_distro {
                if !crate::wsl_probe::is_safe_distro_name(distro) {
                    return Err(("wsl", "Unsupported WSL distribution".into()));
                }
            } else if let Some(distro) = crate::path_utils::get_default_wsl_distro() {
                command.args(["-d", &distro]);
            } else {
                return Err((
                    "wsl",
                    "Default WSL distribution could not be resolved".into(),
                ));
            }
            command.args(["--exec", "bash", "-ic", &format!("p=$(type -P -- '{executable}') || exit 31; printf '{FOUND_MARKER}\\n'; \"$p\" --version")]);
            return Ok((command, "wsl"));
        }
        if matches!(stem, "powershell" | "pwsh") {
            if parts[1..]
                .iter()
                .any(|arg| !matches!(arg.to_ascii_lowercase().as_str(), "-nologo" | "-noprofile"))
            {
                return Err(("unknown", "Unsupported PowerShell profile options".into()));
            }
            let mut command = headless_command(shell);
            // The PTY builder currently uses its own -NoLogo/-NoExit/-Command
            // arguments and does not forward these profile options. Mirror
            // that effective shell instead of probing a different account.
            command.args(["-Command", &format!("$p=(Get-Command -Name '{executable}' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source; if (!$p) {{ exit 31 }}; Write-Output '{FOUND_MARKER}'; & $p --version; if ($LASTEXITCODE -ne $null) {{ exit $LASTEXITCODE }}")]);
            return Ok((command, "windows"));
        }
        if stem == "cmd" {
            return Err((
                "windows",
                "CMD profiles do not support structured agent startup in the current PTY launcher"
                    .into(),
            ));
        }
        Err((
            "unknown",
            "Selected profile shell is unsupported by the installation check".into(),
        ))
    }
    #[cfg(not(windows))]
    {
        let _ = (parts, stem, executable);
        Err((
            "linux",
            "Native Linux shell profiles do not support structured agent startup in the current PTY launcher".into(),
        ))
    }
}

fn inspect(
    settings: &Settings,
    agent_id: &str,
    profile_name: &str,
) -> Result<AgentInstallationStatus, String> {
    let effective_command = agent_command_for(settings, agent_id)?;
    let profile = settings
        .profiles
        .iter()
        .find(|profile| profile.name == profile_name)
        .ok_or_else(|| format!("Terminal profile '{profile_name}' does not exist"))?;
    let executable = effective_command.split(' ').next().unwrap_or("");
    let basename = executable.rsplit(['/', '\\']).next().unwrap_or(executable);
    let stem = [".exe", ".cmd", ".bat", ".ps1"]
        .iter()
        .find_map(|suffix| {
            basename
                .to_ascii_lowercase()
                .strip_suffix(suffix)
                .map(str::to_string)
        })
        .unwrap_or_else(|| basename.to_ascii_lowercase());
    if stem != agent_id {
        return Ok(unknown(
            "unknown",
            "Configured launch command uses a wrapper or differently named executable; installation cannot be verified safely",
            effective_command,
        ));
    }
    let (mut process, environment) = match probe_plan(profile, executable) {
        Ok(plan) => plan,
        Err((environment, reason)) => return Ok(unknown(environment, reason, effective_command)),
    };
    let output = match output_bounded_with_timeout(&mut process, PROBE_TIMEOUT, PROBE_OUTPUT_LIMIT)
    {
        Ok(output) => output,
        Err(error) => return Ok(unknown(environment, error.to_string(), effective_command)),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let found = stdout.lines().any(|line| line.trim() == FOUND_MARKER);
    if !found {
        return Ok(AgentInstallationStatus {
            status: if output.status.code() == Some(31) {
                "missing"
            } else {
                "unknown"
            },
            environment,
            version: None,
            detail: Some(if output.status.code() == Some(31) {
                "Executable was not found in the selected environment".into()
            } else {
                format!("Installation check exited with {}", output.status)
            }),
            effective_command: Some(effective_command),
        });
    }
    let version = stdout
        .lines()
        .skip_while(|line| line.trim() != FOUND_MARKER)
        .skip(1)
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(200).collect());
    Ok(AgentInstallationStatus {
        status: if output.status.success() {
            "installed"
        } else {
            "unknown"
        },
        environment,
        version,
        detail: (!output.status.success())
            .then(|| format!("Version check exited with {}", output.status)),
        effective_command: Some(effective_command),
    })
}

#[tauri::command(async)]
pub fn check_agent_installation(
    agent_id: String,
    profile_name: String,
) -> Result<AgentInstallationStatus, String> {
    inspect(&crate::settings::load_settings(), &agent_id, &profile_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_command_is_derived_from_settings() {
        let mut settings = Settings::default();
        settings.claude.command = "claude --dangerously-skip-permissions".into();
        assert_eq!(
            agent_startup_command(&settings, "claude").unwrap(),
            settings.claude.command
        );
        assert!(agent_startup_command(&settings, "other").is_err());
    }

    #[test]
    fn missing_profile_fails_without_host_fallback() {
        assert!(inspect(&Settings::default(), "codex", "missing").is_err());
    }

    #[test]
    fn wrapper_command_does_not_prove_agent_installation() {
        let mut settings = Settings::default();
        settings.codex.command = "wsl.exe -d Ubuntu codex".into();
        let profile_name = settings.profiles[0].name.clone();
        let result = inspect(&settings, "codex", &profile_name).unwrap();
        assert_eq!(result.status, "unknown");
    }

    #[cfg(windows)]
    #[test]
    fn profile_startup_does_not_enter_probe_plan() {
        let mut profile = Profile {
            command_line: "powershell.exe".into(),
            ..Profile::default()
        };
        let before = probe_plan(&profile, "claude").unwrap().0;
        profile.startup_command = "echo side-effect".into();
        let after = probe_plan(&profile, "claude").unwrap().0;
        assert_eq!(
            before.get_args().collect::<Vec<_>>(),
            after.get_args().collect::<Vec<_>>()
        );
    }

    #[cfg(windows)]
    #[test]
    fn powershell_probe_matches_effective_pty_options() {
        let profile = Profile {
            command_line: "powershell.exe -NoProfile -NoLogo".into(),
            ..Profile::default()
        };
        let (command, _) = probe_plan(&profile, "codex").unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy())
            .collect();
        assert_eq!(args[0], "-Command");
        assert!(!args
            .iter()
            .any(|arg| arg.eq_ignore_ascii_case("-NoProfile")));
    }

    #[cfg(not(windows))]
    #[test]
    fn native_linux_probe_is_unknown_until_explicit_launch_is_supported() {
        let profile = Profile {
            command_line: "bash".into(),
            ..Profile::default()
        };
        assert_eq!(probe_plan(&profile, "codex").unwrap_err().0, "linux");
    }

    #[cfg(windows)]
    #[test]
    fn wsl_profile_probe_preserves_selected_distribution_and_user() {
        let profile = Profile {
            command_line: "wsl.exe -d Ubuntu -u alice --".into(),
            ..Profile::default()
        };
        let (command, environment) = probe_plan(&profile, "codex").unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy())
            .collect();
        assert_eq!(environment, "wsl");
        assert_eq!(
            &args[..6],
            ["-d", "Ubuntu", "-u", "alice", "--exec", "bash"]
        );
        assert!(args.last().is_some_and(|arg| arg.contains("'codex'")));
    }

    #[cfg(windows)]
    #[test]
    fn unsupported_shell_wrapper_stays_unknown() {
        let profile = Profile {
            command_line: "pwsh.exe -Command something".into(),
            ..Profile::default()
        };
        assert_eq!(probe_plan(&profile, "codex").unwrap_err().0, "unknown");
    }

    #[cfg(windows)]
    #[test]
    fn uppercase_exe_shell_names_keep_their_supported_environment() {
        let powershell = Profile {
            command_line: "PowerShell.EXE -NoLogo".into(),
            ..Profile::default()
        };
        assert_eq!(probe_plan(&powershell, "codex").unwrap().1, "windows");

        let wsl = Profile {
            command_line: "WSL.EXE -d Ubuntu".into(),
            ..Profile::default()
        };
        assert_eq!(probe_plan(&wsl, "codex").unwrap().1, "wsl");
    }
}
