use std::io::Read;
use std::process::{ChildStdout, Command, ExitStatus, Output, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use crate::error::AppError;

pub(super) const GIT_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const EXIT_POLL: Duration = Duration::from_millis(10);

pub(super) struct ReadOutput<T> {
    pub status: ExitStatus,
    pub stdout: T,
    pub stderr: Vec<u8>,
}

fn limited_bytes(source: impl Read) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    source
        .take((OUTPUT_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > OUTPUT_LIMIT {
        return Err(AppError::Other(
            "Git 출력이 버퍼 제한(8 MiB)을 초과했습니다.".into(),
        ));
    }
    Ok(bytes)
}

fn spawn_read<T: Send + 'static>(
    read: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Receiver<Result<T, AppError>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(read());
    });
    receiver
}

fn receive<T>(receiver: Receiver<Result<T, AppError>>, deadline: Instant) -> Result<T, AppError> {
    receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| AppError::Other("Git 출력을 끝까지 확인하지 못했습니다.".into()))?
}

/// stdout 집계와 stderr 배출은 병렬로 수행하고 프로세스 종료와 EOF 모두를 확인한다.
pub(super) fn read_output_for<T: Send + 'static>(
    command: &mut Command,
    timeout: Duration,
    read_stdout: impl FnOnce(ChildStdout) -> Result<T, AppError> + Send + 'static,
) -> Result<ReadOutput<T>, AppError> {
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
    let stdout = spawn_read(move || read_stdout(stdout));
    let stderr = spawn_read(move || limited_bytes(stderr));
    let deadline = Instant::now() + timeout;
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
    Ok(ReadOutput {
        status,
        stdout: receive(stdout, deadline)?,
        stderr: receive(stderr, deadline)?,
    })
}

pub(super) fn bounded_output(command: &mut Command) -> Result<Output, AppError> {
    bounded_output_for(command, GIT_TIMEOUT)
}

pub(super) fn bounded_output_for(
    command: &mut Command,
    timeout: Duration,
) -> Result<Output, AppError> {
    let output = read_output_for(command, timeout, limited_bytes)?;
    Ok(Output {
        status: output.status,
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_streamed_output_and_stderr_keep_the_existing_limit() {
        assert!(limited_bytes(std::io::repeat(b'x').take((OUTPUT_LIMIT + 1) as u64)).is_err());
        assert!(limited_bytes(std::io::Cursor::new(b"small")).is_ok());
    }

    #[test]
    #[ignore = "시간 제한 검증의 자식 프로세스 전용"]
    fn timeout_fixture() {
        std::thread::sleep(Duration::from_secs(5));
    }

    #[test]
    fn timeout_still_terminates_and_reaps_a_streamed_command() {
        let mut command = crate::process::headless_command(std::env::current_exe().unwrap());
        command.args([
            "--exact",
            "worktree::output::tests::timeout_fixture",
            "--ignored",
        ]);
        let started = Instant::now();
        let result = read_output_for(&mut command, Duration::from_millis(100), limited_bytes);
        assert!(result.err().unwrap().to_string().contains("제한 시간"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
