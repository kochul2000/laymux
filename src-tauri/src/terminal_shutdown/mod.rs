//! Cooperative foreground shutdown, separate from raw PTY retirement (ADR-0364).

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};

use crate::terminal::TerminalSession;

pub(crate) fn retired_output_control(
    session: &crate::terminal_output::TerminalOutputSession,
) -> crate::pty::PtyOutputControl {
    if session.drain_retired_pty_output() {
        crate::pty::PtyOutputControl::Continue
    } else {
        crate::pty::PtyOutputControl::Stop
    }
}

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
mod wsl;

/// Shared by all clones of one PTY generation; never renewed by a GUI reader.
#[derive(Clone)]
pub(crate) struct Target {
    platform: Platform,
    result: Arc<OnceLock<Result<(), String>>>,
}

#[derive(Clone)]
enum Platform {
    #[cfg(windows)]
    Wsl(wsl::Target),
    #[cfg(windows)]
    Console(windows::Target),
    #[cfg(unix)]
    Unix(unix::Target),
    #[cfg(test)]
    Probe(Arc<std::sync::atomic::AtomicUsize>),
}

impl Target {
    pub(crate) fn for_session(
        session: &TerminalSession,
        command_line: &str,
        adopted: Option<&BTreeMap<String, String>>,
        child_pid: Option<u32>,
        wsl_backed: bool,
    ) -> Result<Option<Self>, String> {
        let Some(pid) = child_pid else {
            return Ok(None);
        };
        #[cfg(windows)]
        let platform = if wsl_backed {
            Platform::Wsl(wsl::Target::for_session(session, command_line, adopted)?)
        } else {
            Platform::Console(windows::Target::new(pid)?)
        };
        #[cfg(unix)]
        let platform = {
            let _ = (session, command_line, adopted, wsl_backed);
            Platform::Unix(unix::Target::new(pid)?)
        };
        Ok(Some(Self {
            platform,
            result: Arc::new(OnceLock::new()),
        }))
    }

    pub(crate) fn request(&self) -> Result<(), String> {
        self.result
            .get_or_init(|| match &self.platform {
                #[cfg(windows)]
                Platform::Wsl(target) => target.request(),
                #[cfg(windows)]
                Platform::Console(target) => target.request(),
                #[cfg(unix)]
                Platform::Unix(target) => target.request(),
                #[cfg(test)]
                Platform::Probe(counter) => {
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                }
            })
            .clone()
    }

    #[cfg(test)]
    pub(crate) fn probe(counter: Arc<std::sync::atomic::AtomicUsize>) -> Self {
        Self {
            platform: Platform::Probe(counter),
            result: Arc::new(OnceLock::new()),
        }
    }
}

pub(crate) fn session_metadata(
    session: &TerminalSession,
    command_line: &str,
) -> BTreeMap<String, String> {
    #[cfg(windows)]
    return wsl::Target::for_session(session, command_line, None)
        .map(|target| target.metadata())
        .unwrap_or_default();
    #[cfg(not(windows))]
    {
        let _ = (session, command_line);
        BTreeMap::new()
    }
}

/// Internal one-shot helper, dispatched before Tauri owns any GUI resources.
#[cfg(windows)]
pub fn run_console_helper(pid: Option<&std::ffi::OsStr>, birth: Option<&std::ffi::OsStr>) -> i32 {
    let parsed = pid
        .and_then(|p| p.to_str())
        .and_then(|p| p.parse().ok())
        .zip(birth.and_then(|p| p.to_str()).and_then(|p| p.parse().ok()));
    let Some((pid, birth)) = parsed else { return 2 };
    match windows::signal_console(pid, birth) {
        Ok(()) => 0,
        Err(error) => {
            // A structured stdout result; never attach logging to the target console.
            println!("{}", serde_json::json!({"error":error}));
            1
        }
    }
}

#[cfg(test)]
mod tests;
