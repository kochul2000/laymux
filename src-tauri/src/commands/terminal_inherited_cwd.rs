//! Resolve only split/stack CWD seeds; explicit paths and session restore bypass this policy.
use crate::path_utils;
use crate::settings::Settings;
use crate::terminal::{InitialExecutionHost, TerminalSession};

pub(super) async fn resolve(
    cwd: Option<String>,
    source_profile: Option<String>,
    target_profile: &str,
) -> Option<String> {
    let (Some(cwd), Some(profile)) = (cwd.as_ref(), source_profile) else {
        return cwd;
    };
    let settings = crate::settings::load_settings();
    if !settings.terminal.use_main_worktree_cwd_on_split {
        return Some(cwd.clone());
    }
    let target_command = profile_command(target_profile, &settings).to_owned();
    let original = cwd.clone();
    let input = cwd.clone();
    match tokio::task::spawn_blocking(move || resolve_from_profile(&input, &profile, &settings))
        .await
    {
        Ok(Ok(Some(resolved))) => {
            tracing::debug!(%original, %resolved, "inherited CWD selected the main worktree");
            Some(spawn_path(resolved, &target_command, cfg!(windows)))
        }
        Ok(Ok(None)) => Some(original),
        Ok(Err(error)) => {
            tracing::debug!(%error, "inherited CWD keeps its original path");
            Some(original)
        }
        Err(error) => {
            tracing::warn!(%error, "inherited CWD lookup task failed");
            Some(original)
        }
    }
}

fn resolve_from_profile(
    cwd: &str,
    profile: &str,
    settings: &Settings,
) -> Result<Option<String>, crate::error::AppError> {
    let command = profile_command(profile, settings);
    let host = classify_cwd_source(command, cfg!(windows));
    if host == InitialExecutionHost::DirectSsh {
        return Ok(None);
    }
    #[cfg(windows)]
    if host == InitialExecutionHost::Wsl && !cwd.starts_with("//") && !cwd.starts_with("\\\\") {
        let (distro, _) = crate::wsl_probe::terminal_distro_target(None, command)
            .map_err(crate::error::AppError::Other)?;
        let distro = distro
            .or_else(|| {
                path_utils::get_default_wsl_distro_with_timeout(std::time::Duration::from_secs(2))
            })
            .ok_or_else(|| {
                crate::error::AppError::Other("원본 WSL 배포판을 확인할 수 없습니다.".into())
            })?;
        let guest = path_utils::windows_to_wsl_path(cwd);
        let qualified = format!("//wsl.localhost/{distro}{guest}");
        match crate::worktree::main_worktree_cwd(&qualified) {
            Ok(value) => return Ok(value),
            Err(_) if guest.starts_with("/mnt/") => return crate::worktree::main_worktree_cwd(cwd),
            Err(error) => return Err(error),
        }
    }
    crate::worktree::main_worktree_cwd(cwd)
}

fn classify_cwd_source(command: &str, windows: bool) -> InitialExecutionHost {
    let executable = command.split_whitespace().next();
    // NonWindows is the generic spawn classification, but remote CWDs must
    // never be inspected on the local filesystem on any platform.
    if executable
        .and_then(|path| path.rsplit(['/', '\\']).next())
        .is_some_and(|name| {
            name.eq_ignore_ascii_case("ssh") || name.eq_ignore_ascii_case("ssh.exe")
        })
    {
        return InitialExecutionHost::DirectSsh;
    }
    InitialExecutionHost::classify_spawn_target(executable, windows)
}

fn spawn_path(path: String, target_command: &str, windows: bool) -> String {
    if InitialExecutionHost::classify_spawn_target(
        target_command.split_whitespace().next(),
        windows,
    ) == InitialExecutionHost::Wsl
    {
        path_utils::normalize_wsl_path(&path)
    } else {
        path
    }
}

fn profile_command<'a>(profile: &'a str, settings: &'a Settings) -> &'a str {
    settings
        .profiles
        .iter()
        .find(|p| p.name == profile)
        .map(|p| p.command_line.as_str())
        .filter(|line| !line.is_empty())
        .unwrap_or_else(|| TerminalSession::profile_command_line(profile))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ssh_sources_are_remote_on_linux_and_windows() {
        for windows in [false, true] {
            for command in [
                "ssh user@host",
                "/usr/bin/ssh user@host",
                "C:\\OpenSSH\\ssh.exe user@host",
            ] {
                assert_eq!(
                    classify_cwd_source(command, windows),
                    InitialExecutionHost::DirectSsh
                );
            }
        }
        assert_eq!(
            classify_cwd_source("bash", false),
            InitialExecutionHost::NonWindows
        );
    }
    #[test]
    fn qualified_git_paths_become_guest_paths_only_for_wsl_children() {
        let cwd = "//wsl.localhost/Debian/tmp/main repo/ui".to_owned();
        assert_eq!(
            spawn_path(cwd.clone(), "wsl.exe -d Debian", true),
            "/tmp/main repo/ui"
        );
        assert_eq!(spawn_path(cwd.clone(), "powershell.exe", true), cwd);
        assert_eq!(
            spawn_path("D:/main/ui".into(), "wsl.exe", true),
            "/mnt/d/main/ui"
        );
        assert_eq!(
            spawn_path("/home/main/ui".into(), "bash", false),
            "/home/main/ui"
        );
    }
}
