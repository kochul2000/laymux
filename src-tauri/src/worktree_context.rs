//! Qualify followed CWDs using the terminal that actually reported them.
use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use crate::terminal::InitialExecutionHost;

struct Source {
    cwd: Option<String>,
    distro: Option<String>,
    command_line: String,
    host: InitialExecutionHost,
}

pub fn resolve_working_dir(
    state: &AppState,
    working_dir: &str,
    source_terminal_id: Option<&str>,
) -> Result<String, AppError> {
    let source = source_terminal_id
        .map(|id| {
            let terminals = state.terminals.lock_or_err()?;
            let terminal = terminals
                .get(id)
                .ok_or_else(|| AppError::SessionNotFound(id.into()))?;
            Ok::<_, AppError>(Source {
                cwd: terminal.cwd.clone(),
                distro: terminal.wsl_distro.clone(),
                command_line: terminal.config.command_line.clone(),
                host: terminal.initial_execution_host,
            })
        })
        .transpose()?;
    qualify(working_dir, source.as_ref(), cfg!(windows))
}

fn qualify(working_dir: &str, source: Option<&Source>, windows: bool) -> Result<String, AppError> {
    if let Some(source) = source {
        if source.host == InitialExecutionHost::DirectSsh {
            return Err(AppError::Other(
                "SSH 원격 터미널의 워크트리는 로컬에서 조회할 수 없습니다.".into(),
            ));
        }
        if source.cwd.as_deref() != Some(working_dir) {
            return Err(AppError::Other(
                "터미널 경로가 변경되었습니다. 목록을 다시 조회하세요.".into(),
            ));
        }
    }
    if !windows {
        return Ok(working_dir.into());
    }
    let path = if working_dir.starts_with('/') {
        working_dir.to_owned()
    } else {
        working_dir.replace('\\', "/")
    };
    if path.starts_with('/') && !path.starts_with("//") && !path.starts_with("/mnt/") {
        let source = source.ok_or_else(|| {
            AppError::Other(
                "WSL 경로는 원본 터미널 또는 배포판을 포함한 UNC 경로가 필요합니다.".into(),
            )
        })?;
        let (distro, _) = crate::wsl_probe::terminal_distro_target(
            source.distro.as_deref(),
            &source.command_line,
        )
        .map_err(AppError::Other)?;
        let distro = distro.ok_or_else(|| {
            AppError::Other("원본 터미널의 WSL 배포판을 확인할 수 없습니다.".into())
        })?;
        return Ok(format!("//wsl.localhost/{distro}{path}"));
    }
    Ok(working_dir.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_cwd_is_bound_to_its_source_distribution_not_the_default() {
        let source = Source {
            cwd: Some("/home/repo".into()),
            distro: Some("Debian".into()),
            command_line: "wsl.exe -d Debian".into(),
            host: InitialExecutionHost::Wsl,
        };
        assert_eq!(
            qualify("/home/repo", Some(&source), true).unwrap(),
            "//wsl.localhost/Debian/home/repo"
        );
        assert!(qualify("/home/repo", None, true).is_err());
        assert!(qualify("/home/other", Some(&source), true).is_err());
    }

    #[test]
    fn explicit_unc_and_native_linux_paths_do_not_need_a_terminal() {
        assert_eq!(
            qualify("//wsl.localhost/Debian/home/repo", None, true).unwrap(),
            "//wsl.localhost/Debian/home/repo"
        );
        assert_eq!(qualify("/home/repo", None, false).unwrap(), "/home/repo");
        assert_eq!(qualify("/mnt/d/repo", None, true).unwrap(), "/mnt/d/repo");
    }

    #[test]
    fn remote_cwd_never_becomes_a_local_repository() {
        let source = Source {
            cwd: Some("/home/repo".into()),
            distro: None,
            command_line: "ssh host".into(),
            host: InitialExecutionHost::DirectSsh,
        };
        assert!(qualify("/home/repo", Some(&source), false).is_err());
    }

    #[test]
    fn followed_linux_name_keeps_its_literal_backslash() {
        let source = Source {
            cwd: Some("/home/Repo\\name".into()),
            distro: Some("Debian".into()),
            command_line: "wsl.exe -d Debian".into(),
            host: InitialExecutionHost::Wsl,
        };
        assert_eq!(
            qualify("/home/Repo\\name", Some(&source), true).unwrap(),
            "//wsl.localhost/Debian/home/Repo\\name"
        );
    }
}
