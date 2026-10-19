use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use crate::error::AppError;

const GIT_TIMEOUT: Duration = Duration::from_secs(30);
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const EXIT_POLL: Duration = Duration::from_millis(10);

/// All commands use argument vectors; a WSL path stays attached to its distro.
pub(super) struct Git {
    pub cwd: String,
    distro: Option<String>,
}

impl Git {
    pub fn new(working_dir: &str) -> Result<Self, AppError> {
        if working_dir.is_empty() || working_dir.contains('\0') {
            return Err(AppError::Other("저장소의 절대 경로가 필요합니다.".into()));
        }
        #[cfg(windows)]
        {
            let input = if working_dir.starts_with("file://")
                || working_dir.starts_with("Microsoft.PowerShell.Core/FileSystem::")
            {
                crate::path_utils::normalize_wsl_path(working_dir)
            } else if working_dir.starts_with('/') {
                working_dir.to_owned()
            } else {
                working_dir.replace('\\', "/")
            };
            let explicit = crate::path_utils::extract_wsl_distro_from_path(&input);
            let distro = if explicit.is_some() {
                explicit
            } else if input.starts_with('/')
                && !input.starts_with("/mnt/")
                && !input.starts_with("//")
            {
                Some(
                    crate::path_utils::get_default_wsl_distro_with_timeout(GIT_TIMEOUT)
                        .ok_or_else(|| {
                            AppError::Other("WSL 배포판을 확인할 수 없습니다.".into())
                        })?,
                )
            } else {
                None
            };
            if let Some(distro) = distro {
                if !crate::wsl_probe::is_safe_distro_name(&distro) {
                    return Err(AppError::Other("올바르지 않은 WSL 배포판입니다.".into()));
                }
                return Ok(Self {
                    cwd: crate::path_utils::normalize_wsl_path(&input),
                    distro: Some(distro),
                });
            }
            let cwd = crate::path_utils::resolve_address_path(&input, None);
            if !std::path::Path::new(&cwd).is_absolute() {
                return Err(AppError::Other("저장소의 절대 경로가 필요합니다.".into()));
            }
            Ok(Self { cwd, distro: None })
        }
        #[cfg(not(windows))]
        {
            if !std::path::Path::new(working_dir).is_absolute() {
                return Err(AppError::Other("저장소의 절대 경로가 필요합니다.".into()));
            }
            Ok(Self {
                cwd: working_dir.to_owned(),
                distro: None,
            })
        }
    }

    pub fn host_path(&self, path: &str) -> String {
        match &self.distro {
            Some(distro) => format!("//wsl.localhost/{distro}{path}"),
            None => path.to_owned(),
        }
    }

    pub fn git_path(&self, path: &str) -> Result<String, AppError> {
        if path.contains('\0') {
            return Err(AppError::Other(
                "경로에 NUL 문자를 사용할 수 없습니다.".into(),
            ));
        }
        if let Some(distro) = &self.distro {
            let forward = if path.starts_with("\\\\") {
                path.replace('\\', "/")
            } else {
                path.to_owned()
            };
            if let Some(other) = crate::path_utils::extract_wsl_distro_from_path(&forward) {
                if !other.eq_ignore_ascii_case(distro) {
                    return Err(AppError::Other("다른 WSL 배포판의 경로입니다.".into()));
                }
                return Ok(crate::path_utils::normalize_wsl_path(&forward));
            }
            if forward.starts_with('/') && !forward.starts_with("//") {
                return Ok(forward);
            }
            return Err(AppError::Other(
                "워크트리 경로가 저장소 실행 환경과 다릅니다.".into(),
            ));
        }
        #[cfg(windows)]
        return Ok(crate::path_utils::resolve_address_path(path, None));
        #[cfg(not(windows))]
        Ok(path.to_owned())
    }

    pub fn same_path(&self, left: &str, right: &str) -> bool {
        match (self.git_path(left), self.git_path(right)) {
            (Ok(left), Ok(right)) if self.distro.is_some() || !cfg!(windows) => {
                left.trim_end_matches('/') == right.trim_end_matches('/')
            }
            (Ok(left), Ok(right)) => {
                crate::path_utils::normalize_path_for_comparison(&left)
                    == crate::path_utils::normalize_path_for_comparison(&right)
            }
            _ => false,
        }
    }

    pub fn run(&self, cwd: &str, args: &[&str]) -> Result<Vec<u8>, AppError> {
        let cwd = self.git_path(cwd)?;
        let mut command = self.command(&cwd, args);
        let output = bounded_output(&mut command)?;
        checked_stdout(output)
    }

    pub fn worktrees(&self) -> Result<Vec<super::types::WorktreeEntry>, AppError> {
        let cwd = self.git_path(&self.cwd)?;
        let mut command = self.command(&cwd, &["worktree", "list", "--porcelain", "-z"]);
        let output = bounded_output(&mut command)?;
        if output.status.success() {
            return super::parsing::worktrees(&output.stdout);
        }
        if !super::legacy::unsupported_nul(output.status.code(), &output.stderr) {
            return checked_stdout(output).and_then(|bytes| super::parsing::worktrees(&bytes));
        }
        let bytes = self.run(
            &self.cwd,
            &[
                "-c",
                "core.quotePath=true",
                "worktree",
                "list",
                "--porcelain",
            ],
        )?;
        super::legacy::worktrees(&bytes)
    }

    pub fn text(&self, cwd: &str, args: &[&str]) -> Result<String, AppError> {
        let bytes = self.run(cwd, args)?;
        let text = String::from_utf8(bytes)
            .map_err(|_| AppError::Other("Git 출력이 올바른 UTF-8이 아닙니다.".into()))?;
        // Strip Git's one line terminator, preserving whitespace in path names.
        Ok(text.strip_suffix('\n').unwrap_or(&text).to_owned())
    }

    fn command(&self, cwd: &str, args: &[&str]) -> Command {
        let mut command = match &self.distro {
            Some(distro) => {
                let mut command = crate::process::headless_wsl_command();
                command.args([
                    "-d",
                    distro,
                    "--exec",
                    "env",
                    "LC_ALL=C",
                    "GIT_TERMINAL_PROMPT=0",
                    "GIT_OPTIONAL_LOCKS=0",
                    "git",
                ]);
                command
            }
            None => crate::process::headless_command("git"),
        };
        // A calling agent may itself be running inside a Git hook. Its index,
        // repository and worktree overrides must never redirect this operation.
        for (name, _) in std::env::vars_os() {
            if name.to_string_lossy().starts_with("GIT_") {
                command.env_remove(name);
            }
        }
        command
            .env("LC_ALL", "C")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0");
        command.args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-C",
            cwd,
        ]);
        command.args(args);
        command
    }
}

fn checked_stdout(output: Output) -> Result<Vec<u8>, AppError> {
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(format!(
            "Git 검사 또는 작업에 실패했습니다: {}",
            detail.trim()
        )));
    }
    Ok(output.stdout)
}

fn drain(source: impl Read + Send + 'static) -> Receiver<std::io::Result<Vec<u8>>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = source
            .take((OUTPUT_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .and_then(|_| {
                if bytes.len() > OUTPUT_LIMIT {
                    Err(std::io::Error::other(
                        "Git output exceeded the inspection limit",
                    ))
                } else {
                    Ok(bytes)
                }
            });
        let _ = sender.send(result);
    });
    receiver
}

/// Bounded pipe reads fail closed; truncated status is never accepted as clean.
pub(super) fn bounded_output(command: &mut Command) -> Result<Output, AppError> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Other("Git stdout pipe missing".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Other("Git stderr pipe missing".into()))?;
    let stdout = drain(stdout);
    let stderr = drain(stderr);
    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(EXIT_POLL),
            outcome => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(outcome.err().map(AppError::Io).unwrap_or_else(|| {
                    AppError::Other(
                        "Git 작업이 제한 시간을 초과했습니다. 목록을 새로 고쳐 상태를 확인하세요."
                            .into(),
                    )
                }));
            }
        }
    };
    let receive = |receiver: Receiver<std::io::Result<Vec<u8>>>| -> Result<Vec<u8>, AppError> {
        receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| AppError::Other("Git 출력을 끝까지 확인하지 못했습니다.".into()))?
            .map_err(AppError::Io)
    };
    Ok(Output {
        status,
        stdout: receive(stdout)?,
        stderr: receive(stderr)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_paths_keep_guest_case_and_literal_backslashes() {
        let git = Git {
            cwd: "/home/repo".into(),
            distro: Some("Ubuntu".into()),
        };
        assert!(git.same_path(
            "//wsl.localhost/Ubuntu/home/repo",
            "\\\\wsl$\\Ubuntu\\home\\repo"
        ));
        assert!(!git.same_path("//wsl.localhost/Ubuntu/home/Repo", "/home/repo"));
        assert!(!git.same_path("//wsl.localhost/Debian/home/repo", "/home/repo"));
        assert!(!git.same_path("//wsl.localhost/Ubuntu/home/repo\\tail", "/home/repo/tail"));
    }

    #[test]
    fn oversized_output_fails_instead_of_becoming_a_partial_status() {
        let result = drain(std::io::Cursor::new(vec![b'x'; OUTPUT_LIMIT + 1]))
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        assert!(result.is_err());
    }
}
