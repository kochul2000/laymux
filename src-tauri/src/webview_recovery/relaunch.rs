//! Windows: start the GUI that replaces this one (ADR-0336).
//!
//! Tauri's `restart` spawns through `std::process::Command`, which always
//! passes `bInheritHandles = TRUE`: the next GUI inherits this one's
//! listening sockets and keeps the automation port bound to a socket nobody
//! accepts on, so its own bind fails. The next GUI is created directly with
//! inheritance off, and it waits for this process to exit before it takes the
//! port, the lx endpoint and the WebView2 profile.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, OpenProcess, WaitForSingleObject, PROCESS_INFORMATION, PROCESS_SYNCHRONIZE,
    STARTUPINFOW,
};

use crate::constants::{GUI_RELAUNCH_AFTER_CLI_FLAG, GUI_RELAUNCH_PREDECESSOR_WAIT_MS};

/// Start the next GUI and return its PID. The GUI takes no arguments of its
/// own, so only the predecessor PID is passed on.
pub fn relaunch_gui() -> Result<u32, String> {
    let exe = std::env::current_exe().map_err(|error| format!("no executable path: {error}"))?;
    let application: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut command_line = command_line(&exe, std::process::id());
    // SAFETY: zeroed STARTUPINFOW/PROCESS_INFORMATION are valid initial
    // values; `cb` is set before use.
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: both strings are NUL-terminated and outlive the call; the
    // command line buffer is mutable as CreateProcessW requires. Null
    // environment and directory inherit this process's; inheritance is off.
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            0,
            std::ptr::null(),
            std::ptr::null(),
            &startup,
            &mut info,
        )
    };
    if created == 0 {
        // SAFETY: reads the calling thread's last-error value.
        let code = unsafe { GetLastError() };
        return Err(format!(
            "could not start {} (Windows error {code})",
            exe.display()
        ));
    }
    // SAFETY: both handles were just returned to us and are closed once.
    unsafe {
        CloseHandle(info.hThread);
        CloseHandle(info.hProcess);
    }
    Ok(info.dwProcessId)
}

/// Called first thing by a relaunched GUI with the argument after
/// `--relaunch-after`: wait, bounded, until the predecessor has exited.
pub fn wait_for_predecessor(pid: Option<&OsStr>) {
    if let Some(pid) = parse_pid(pid) {
        wait_for_exit(pid, GUI_RELAUNCH_PREDECESSOR_WAIT_MS);
    }
}

fn command_line(exe: &Path, predecessor: u32) -> Vec<u16> {
    // An executable path cannot contain `"` and does not end in `\`, so
    // plain quoting keeps it one argument.
    let mut line: Vec<u16> = Vec::new();
    line.push(u16::from(b'"'));
    line.extend(exe.as_os_str().encode_wide());
    line.push(u16::from(b'"'));
    line.extend(format!(" {GUI_RELAUNCH_AFTER_CLI_FLAG} {predecessor}").encode_utf16());
    line.push(0);
    line
}

fn parse_pid(arg: Option<&OsStr>) -> Option<u32> {
    arg?.to_str()?.parse().ok()
}

/// Return once `pid` has exited or `timeout_ms` has passed. A process that is
/// already gone cannot be opened, which ends the wait at once.
fn wait_for_exit(pid: u32, timeout_ms: u32) {
    // SAFETY: plain call; a null result means there is nothing to wait for.
    let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if process.is_null() {
        return;
    }
    // SAFETY: `process` is the valid handle opened above, closed once.
    unsafe {
        WaitForSingleObject(process, timeout_ms);
        CloseHandle(process);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn the_command_line_quotes_the_executable_and_names_the_predecessor() {
        let line = command_line(Path::new(r"C:\Program Files\Laymux\laymux.exe"), 4242);
        assert_eq!(line.last(), Some(&0), "NUL-terminated for CreateProcessW");
        let text = String::from_utf16(&line[..line.len() - 1]).unwrap();
        assert_eq!(
            text,
            format!(r#""C:\Program Files\Laymux\laymux.exe" {GUI_RELAUNCH_AFTER_CLI_FLAG} 4242"#)
        );
    }

    #[test]
    fn only_a_numeric_predecessor_is_waited_for() {
        assert_eq!(parse_pid(Some(OsStr::new("4242"))), Some(4242));
        assert_eq!(parse_pid(Some(OsStr::new("not-a-pid"))), None);
        assert_eq!(parse_pid(Some(OsStr::new(""))), None);
        assert_eq!(parse_pid(None), None);
    }

    #[test]
    fn a_predecessor_that_is_gone_does_not_delay_startup() {
        let mut child = crate::process::headless_command("cmd.exe")
            .args(["/C", "exit 0"])
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        let started = Instant::now();
        wait_for_exit(pid, 10_000);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn startup_waits_until_the_predecessor_exits() {
        // `ping -n 3` takes about two seconds.
        let mut child = crate::process::headless_command("cmd.exe")
            .args(["/C", "ping -n 3 127.0.0.1 >NUL"])
            .spawn()
            .unwrap();
        wait_for_exit(child.id(), 30_000);
        assert!(
            child.try_wait().unwrap().is_some(),
            "returned while the predecessor was still running"
        );
    }

    #[test]
    fn the_wait_is_bounded() {
        let mut child = crate::process::headless_command("cmd.exe")
            .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
            .spawn()
            .unwrap();
        let started = Instant::now();
        wait_for_exit(child.id(), 200);
        let waited = started.elapsed();
        let _ = child.kill();
        let _ = child.wait();
        assert!(waited < Duration::from_secs(5), "waited {waited:?}");
    }
}
