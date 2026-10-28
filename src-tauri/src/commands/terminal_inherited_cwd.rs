//! Resolve only split/stack CWD seeds; explicit paths and session restore bypass this policy.
#[cfg(windows)]
use crate::path_utils;
use crate::settings::Settings;
use crate::terminal::{InitialExecutionHost, TerminalSession};

pub(super) async fn resolve(cwd: Option<String>, source_profile: Option<String>) -> Option<String> {
    let (Some(cwd), Some(profile)) = (cwd.as_ref(), source_profile) else {
        return cwd;
    };
    let settings = crate::settings::load_settings();
    if !settings.terminal.use_main_worktree_cwd_on_split {
        return Some(cwd.clone());
    }
    let original = cwd.clone();
    let input = cwd.clone();
    match tokio::task::spawn_blocking(move || resolve_from_profile(&input, &profile, &settings))
        .await
    {
        Ok(Ok(Some(resolved))) => {
            tracing::debug!(%original, %resolved, "inherited CWD selected the main worktree");
            Some(resolved)
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
    let command = settings
        .profiles
        .iter()
        .find(|p| p.name == profile)
        .map(|p| p.command_line.as_str())
        .filter(|line| !line.is_empty())
        .unwrap_or_else(|| TerminalSession::profile_command_line(profile));
    let host = InitialExecutionHost::classify_spawn_target(
        command.split_whitespace().next(),
        cfg!(windows),
    );
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
            Err(_) if guest.starts_with("/mnt/") => {
                // A mounted Windows checkout may contain native Git absolute metadata.
                return crate::worktree::main_worktree_cwd(cwd);
            }
            Err(error) => return Err(error),
        }
    }
    crate::worktree::main_worktree_cwd(cwd)
}
