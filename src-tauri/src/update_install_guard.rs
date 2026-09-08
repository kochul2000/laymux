//! Hand the update installer a directory it can actually write (ADR-0201).
//!
//! The installer is started by this process and this process disappears
//! immediately afterwards, so nothing else is left to clean up the terminals it
//! spawned. On Windows the bundled ConPTY runtime lives in the install
//! directory (ADR-0066/0067) and every open terminal keeps `OpenConsole.exe`
//! mapped, which makes the installer fail with a sharing violation on a file
//! this app owns. The install path therefore terminates its own children and
//! waits for those files to become writable before handing over.

#[cfg(any(windows, test))]
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::state::AppState;

/// Extensions a running child can hold open in the install directory. Data
/// files are not mapped as images and never produce a sharing violation.
#[cfg(any(windows, test))]
const LOCKABLE_IMAGE_EXTENSIONS: [&str; 2] = ["exe", "dll"];

/// Terminate this app's child processes and wait for the install directory to
/// become writable, then return so the caller can start the installer.
///
/// Best effort by construction: a wait that times out logs and returns rather
/// than cancelling the update, because refusing to install is worse than the
/// installer's own retry prompt.
pub fn release_installer_file_locks(state: &AppState) {
    state.terminate_child_processes();
    wait_for_install_directory(
        Duration::from_millis(crate::constants::UPDATE_INSTALL_LOCK_RELEASE_TIMEOUT_MS),
        Duration::from_millis(crate::constants::UPDATE_INSTALL_LOCK_RELEASE_POLL_MS),
    );
}

/// Only Windows refuses to overwrite a mapped image; elsewhere the installer
/// replaces files regardless of who has them open, so the teardown above is the
/// whole job.
#[cfg(not(windows))]
fn wait_for_install_directory(_timeout: Duration, _poll: Duration) {}

#[cfg(windows)]
fn wait_for_install_directory(timeout: Duration, poll: Duration) {
    let current_exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            tracing::warn!(%error, "cannot locate the install directory to wait on");
            return;
        }
    };
    let Some(install_dir) = current_exe.parent() else {
        tracing::warn!("the running executable has no parent directory");
        return;
    };
    let candidates = lockable_images_in(install_dir, &current_exe);
    if candidates.is_empty() {
        return;
    }

    let released = wait_until(
        || candidates.iter().all(|path| is_writable(path)),
        timeout,
        poll,
    );
    if !released {
        let held: Vec<String> = candidates
            .iter()
            .filter(|path| !is_writable(path))
            .filter_map(|path| path.file_name().map(|name| name.to_string_lossy().into()))
            .collect();
        tracing::warn!(
            held = ?held,
            timeout_ms = timeout.as_millis(),
            "install targets are still locked; the installer may prompt to retry"
        );
    }
}

/// Files in `dir` a surviving child could still be holding.
///
/// The running executable is excluded. This process maps it and is about to
/// exit, so waiting on it would only burn the entire timeout — and replacing it
/// after the app is gone is the one case that already works.
#[cfg(any(windows, test))]
fn lockable_images_in(dir: &Path, current_exe: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let current_name = current_exe.file_name();
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().is_some_and(|extension| {
                LOCKABLE_IMAGE_EXTENSIONS
                    .iter()
                    .any(|known| extension.eq_ignore_ascii_case(known))
            })
        })
        .filter(|path| path.file_name() != current_name)
        .collect()
}

/// Whether the installer could open `path` for writing right now.
///
/// The probe is the installer's own failure condition rather than a process
/// scan: enumerating by image name would both miss holders this app does not
/// know about and mistake another application's console host for one of ours.
/// A missing file cannot be locked, and an error that is not a sharing
/// violation (a permission problem, say) will not be resolved by waiting.
#[cfg(any(windows, test))]
fn is_writable(path: &Path) -> bool {
    match std::fs::OpenOptions::new().write(true).open(path) {
        Ok(_) => true,
        Err(error) => !is_sharing_violation(&error),
    }
}

/// Windows reports a file another process holds as `ERROR_SHARING_VIOLATION`
/// (32). That is the only failure a wait can resolve.
#[cfg(any(windows, test))]
fn is_sharing_violation(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(32)
}

/// Poll `ready` until it holds or `timeout` elapses. Returns whether it held.
///
/// `ready` is always evaluated once before any sleep so a zero timeout still
/// answers the question instead of reporting a failure that never happened.
fn wait_until(mut ready: impl FnMut() -> bool, timeout: Duration, poll: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if ready() {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        std::thread::sleep(poll.min(deadline - now));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn ready_condition_is_not_slept_on() {
        let calls = Cell::new(0);
        let held = wait_until(
            || {
                calls.set(calls.get() + 1);
                true
            },
            Duration::from_secs(30),
            Duration::from_secs(30),
        );
        assert!(held);
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn polling_continues_until_the_condition_holds() {
        let calls = Cell::new(0);
        let held = wait_until(
            || {
                calls.set(calls.get() + 1);
                calls.get() >= 3
            },
            Duration::from_secs(5),
            Duration::from_millis(1),
        );
        assert!(held);
        assert_eq!(calls.get(), 3);
    }

    #[test]
    fn a_condition_that_never_holds_gives_up_at_the_deadline() {
        let held = wait_until(
            || false,
            Duration::from_millis(10),
            Duration::from_millis(1),
        );
        assert!(!held);
    }

    /// A zero timeout must still answer, or an already-free directory would be
    /// reported as locked.
    #[test]
    fn a_zero_timeout_still_evaluates_the_condition_once() {
        let calls = Cell::new(0);
        let held = wait_until(
            || {
                calls.set(calls.get() + 1);
                true
            },
            Duration::ZERO,
            Duration::from_millis(1),
        );
        assert!(held);
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn only_images_other_than_the_running_executable_are_waited_on() {
        let dir = tempfile::tempdir().expect("temp dir");
        for name in [
            "Laymux.exe",
            "OpenConsole.exe",
            "conpty.dll",
            "settings.json",
            "THIRD_PARTY_NOTICES.md",
        ] {
            std::fs::write(dir.path().join(name), b"x").expect("fixture file");
        }

        let mut names: Vec<String> = lockable_images_in(dir.path(), &dir.path().join("Laymux.exe"))
            .iter()
            .filter_map(|path| path.file_name().map(|name| name.to_string_lossy().into()))
            .collect();
        names.sort();

        assert_eq!(names, vec!["OpenConsole.exe", "conpty.dll"]);
    }

    #[test]
    fn a_directory_that_cannot_be_read_yields_no_candidates() {
        let dir = tempfile::tempdir().expect("temp dir");
        let missing = dir.path().join("does-not-exist");
        assert!(lockable_images_in(&missing, &missing.join("Laymux.exe")).is_empty());
    }

    #[test]
    fn an_unlocked_file_is_writable() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("OpenConsole.exe");
        std::fs::write(&path, b"x").expect("fixture file");
        assert!(is_writable(&path));
    }

    /// Nothing holds a file that is not there, so waiting for it would be a
    /// guaranteed timeout.
    #[test]
    fn a_missing_file_is_not_a_lock() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(is_writable(&dir.path().join("absent.exe")));
    }

    /// Only the sharing violation is worth waiting out; anything else is a
    /// standing condition the installer will hit too.
    #[test]
    fn only_sharing_violations_are_worth_waiting_for() {
        assert!(is_sharing_violation(&std::io::Error::from_raw_os_error(32)));
        assert!(!is_sharing_violation(&std::io::Error::from_raw_os_error(5)));
        assert!(!is_sharing_violation(&std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "denied",
        )));
    }
}
