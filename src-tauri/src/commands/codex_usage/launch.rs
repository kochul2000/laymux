use super::ReadError;
use crate::settings::Settings;
#[cfg(windows)]
use crate::terminal::{detect_shell_type, ShellType};

pub(super) fn command(
    settings: &Settings,
    config_dir: &str,
) -> Result<std::process::Command, ReadError> {
    let name = if settings.usage.codex.profile.is_empty() {
        &settings.default_profile
    } else {
        &settings.usage.codex.profile
    };
    let profile = settings
        .profiles
        .iter()
        .find(|profile| &profile.name == name)
        .ok_or_else(|| ReadError::Failed(format!("Terminal profile '{name}' does not exist")))?;
    #[cfg(windows)]
    {
        let parts = crate::commands::misc::split_shell_prefix(&profile.command_line);
        let executable = parts.first().map(String::as_str).unwrap_or("");
        if detect_shell_type(executable) == ShellType::Wsl {
            return wsl_command(&parts, &profile.starting_directory, config_dir);
        }
    }
    #[cfg(not(windows))]
    let _ = profile;
    let mut command = codex_app_server_command();
    apply_codex_home(&mut command, config_dir);
    Ok(command)
}

#[cfg(windows)]
fn wsl_command(
    parts: &[String],
    starting_directory: &str,
    config_dir: &str,
) -> Result<std::process::Command, ReadError> {
    let mut command = crate::process::headless_command(&parts[0]);
    let mut args = parts[1..].iter().peekable();
    while let Some(arg) = args.next() {
        if arg == "--" && args.peek().is_none() {
            break;
        }
        if matches!(
            arg.as_str(),
            "-d" | "--distribution" | "-u" | "--user" | "--cd"
        ) {
            let value = args
                .next()
                .filter(|value| !value.starts_with('-'))
                .ok_or_else(|| ReadError::Failed(format!("WSL option '{arg}' has no value")))?;
            command.args([arg, value]);
        } else if ["--distribution=", "--user=", "--cd="]
            .iter()
            .any(|prefix| arg.starts_with(prefix) && arg.len() > prefix.len())
        {
            command.arg(arg);
        } else {
            return Err(ReadError::Failed(format!(
                "Unsupported WSL usage profile option: {arg}"
            )));
        }
    }
    if !starting_directory.is_empty()
        && !parts
            .iter()
            .any(|arg| arg == "--cd" || arg.starts_with("--cd="))
    {
        command.args([
            "--cd",
            &crate::path_utils::windows_to_wsl_path(starting_directory),
        ]);
    }
    // pane과 같이 .bashrc를 읽되 profile.startupCommand는 실행하지 않는다.
    // CODEX_HOME은 셸 코드가 아니라 위치 인자이며 WSL 안의 경로 그대로다.
    command.args([
        "--exec",
        "bash",
        "-ic",
        "if [ -n \"$1\" ]; then export CODEX_HOME=\"$1\"; fi; exec codex app-server --stdio",
        "laymux-usage",
        config_dir,
    ]);
    Ok(command)
}

fn apply_codex_home(command: &mut std::process::Command, config_dir: &str) {
    if !config_dir.is_empty() {
        command.env("CODEX_HOME", config_dir);
    }
}

#[cfg(target_os = "windows")]
fn codex_app_server_command() -> std::process::Command {
    // npm installs Codex as a .cmd/.ps1 shim on Windows. Invoke the underlying
    // Node entry point directly so stdin/stdout stay attached to app-server.
    if let Some(script) = std::env::var_os("APPDATA")
        .map(|appdata| {
            std::path::PathBuf::from(appdata).join("npm/node_modules/@openai/codex/bin/codex.js")
        })
        .filter(|path| path.is_file())
    {
        let mut command = crate::process::headless_command("node");
        command.arg(script).args(["app-server", "--stdio"]);
        return command;
    }
    // Fallback for non-npm installs that still expose a command shim.
    let mut command = crate::process::headless_command("cmd");
    command.args(["/C", "codex", "app-server", "--stdio"]);
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn settings(command_line: &str) -> Settings {
        let mut settings = Settings::default();
        settings.usage.codex.profile = settings.profiles[0].name.clone();
        settings.profiles[0].command_line = command_line.into();
        settings.profiles[0].starting_directory.clear();
        settings
    }

    #[test]
    fn native_account_home_is_only_an_environment_override() {
        let command = command(&settings("powershell.exe"), "C:/accounts/work").unwrap();
        assert!(command
            .get_envs()
            .any(|(key, value)| key == OsStr::new("CODEX_HOME")
                && value == Some(OsStr::new("C:/accounts/work"))));
    }

    #[test]
    fn missing_profile_fails_instead_of_querying_another_account() {
        let mut settings = settings("powershell.exe");
        settings.usage.codex.profile = "missing-profile".into();
        assert!(matches!(command(&settings, ""), Err(ReadError::Failed(_))));
    }

    #[cfg(windows)]
    #[test]
    fn wsl_profile_preserves_user_distribution_and_literal_home() {
        let mut settings = settings("wsl.exe -d 'My Distro' -u alice --");
        settings.default_profile = settings.usage.codex.profile.clone();
        settings.usage.codex.profile.clear();
        let home = "/home/alice/account ' $(echo unexpected)";
        let command = command(&settings, home).unwrap();
        assert_eq!(command.get_program(), "wsl.exe");
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy())
            .collect();
        assert_eq!(&args[..4], &["-d", "My Distro", "-u", "alice"]);
        assert_eq!(args.last().unwrap(), home);
        assert!(
            !args[7].contains(home),
            "계정 경로는 셸 코드에 보간하지 않는다"
        );
    }

    #[cfg(windows)]
    #[test]
    fn unsupported_wsl_options_fail_closed() {
        for profile in [
            "wsl.exe --exec bash",
            "wsl.exe --shutdown",
            "wsl.exe -u",
            "wsl.exe --distribution=",
        ] {
            assert!(
                matches!(command(&settings(profile), ""), Err(ReadError::Failed(_))),
                "{profile}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires WSL; uses an isolated fake app-server and auth directory"]
    fn wsl_app_server_reads_new_login_on_next_query() {
        let dir = tempfile::tempdir().unwrap();
        let home = crate::path_utils::windows_to_wsl_path(&dir.path().to_string_lossy());
        let account_dir = dir.path().join("account ' $literal");
        std::fs::create_dir(&account_dir).unwrap();
        let account = crate::path_utils::windows_to_wsl_path(&account_dir.to_string_lossy());
        std::fs::write(
            dir.path().join(".bashrc"),
            format!(
                "export HOME='{}'\nexport PATH=\"$HOME\":/usr/bin:/bin\n",
                home.replace('\'', "'\\''")
            ),
        )
        .unwrap();
        std::fs::write(dir.path().join("codex"), r#"#!/bin/bash
printf '%s\n' "$CODEX_HOME" >> "$HOME/seen-home"
while IFS= read -r line; do
  if [[ "$line" == *account/rateLimits/read* ]]; then
    if [[ -f "$CODEX_HOME/logged-in" ]]; then
      printf '%s\n' '{"id":1,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":30,"windowDurationMins":300,"resetsAt":1730950800}}}}'
    else
      printf '%s\n' '{"id":1,"error":{"message":"Authentication required"}}'
    fi
    exit 0
  fi
done
"#).unwrap();
        let status = crate::process::headless_command("wsl.exe")
            .args(["--exec", "chmod", "+x", &format!("{home}/codex")])
            .status()
            .unwrap();
        assert!(status.success());
        let settings = settings("wsl.exe");
        let query = || {
            let command = command(&settings, &account).unwrap();
            // WSL은 HOME을 자체 설정한다. 테스트 전용 rcfile로 실제 CLI·계정을 격리한다.
            let mut isolated = crate::process::headless_command(command.get_program());
            for arg in command.get_args() {
                if arg == "-ic" {
                    isolated.args(["--rcfile", &format!("{home}/.bashrc")]);
                }
                isolated.arg(arg);
            }
            super::super::read_rate_limits(isolated)
        };
        assert!(matches!(query(), Err(ReadError::Unauthorized)));
        std::fs::write(account_dir.join("logged-in"), "test account").unwrap();
        let snapshot = query().unwrap_or_else(|error| {
            panic!(
                "{error:?}; 전달 경로: {:?}",
                std::fs::read_to_string(dir.path().join("seen-home"))
            )
        });
        assert!(matches!(
            snapshot.status,
            super::super::CodexUsageStatus::Ready
        ));
        assert_eq!(snapshot.limits[0].used_percent, 30);
    }
}

#[cfg(not(target_os = "windows"))]
fn codex_app_server_command() -> std::process::Command {
    let mut command = crate::process::headless_command("codex");
    command.args(["app-server", "--stdio"]);
    command
}
