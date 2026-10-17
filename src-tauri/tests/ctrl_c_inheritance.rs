//! ADR-0341: a shell must take Ctrl+C even when laymux itself runs with the
//! inherited "ignore Ctrl+C" flag and without a console, as the release PTY
//! daemon does (`CREATE_NEW_PROCESS_GROUP`, windows subsystem).
//!
//! It is its own binary without the libtest harness: the flag and the console
//! are process-global, and the spawn path restores the flag only once, so a
//! test sharing the process with others would depend on their order. Output
//! goes to a log file because stdout is gone once the console is freed.

#[cfg(windows)]
fn main() {
    let log = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("ctrl_c_inheritance.log");
    let outcome = run();
    let _ = std::fs::write(&log, format!("{outcome:?}\n"));
    std::process::exit(if outcome.is_ok() { 0 } else { 1 });
}

#[cfg(not(windows))]
fn main() {}

#[cfg(windows)]
fn run() -> Result<(), String> {
    use laymux_lib::pty::{spawn_pty, PtyOutputControl};
    use laymux_lib::terminal::{TerminalConfig, TerminalSession};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::System::Console::{FreeConsole, SetConsoleCtrlHandler};

    // SAFETY: a null handler only sets the process's ignore-Ctrl+C flag, and
    // freeing the console only detaches this process; neither touches memory.
    unsafe {
        if SetConsoleCtrlHandler(None, 1) == 0 {
            return Err("could not set the ignore-Ctrl+C flag".into());
        }
        FreeConsole();
    }

    let session = TerminalSession::new(
        "ctrl-c-inheritance".into(),
        TerminalConfig {
            command_line: "powershell.exe -NoLogo".into(),
            startup_command: "Set-PSReadLineOption -HistorySaveStyle SaveNothing".into(),
            cols: 120,
            rows: 30,
            ..TerminalConfig::default()
        },
    );
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let handle = spawn_pty(&session, move |bytes| {
        let _ = tx.send(bytes);
        PtyOutputControl::Continue
    })?;
    let mut output = String::new();
    let mut until = |marker: &str, limit: Duration| -> Result<(), String> {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if let Ok(bytes) = rx.recv_timeout(Duration::from_millis(100)) {
                output.push_str(&String::from_utf8_lossy(&bytes));
                if output.contains(marker) {
                    output.clear();
                    return Ok(());
                }
            }
        }
        Err(format!("no {marker:?} within {limit:?}: {output:?}"))
    };

    let result = (|| {
        until("\x1b]7;", Duration::from_secs(30))?;
        handle.write(b"Start-Sleep -Seconds 60\r")?;
        until("\x1b]133;C\x07", Duration::from_secs(15))?;
        std::thread::sleep(Duration::from_secs(1));
        handle.write(b"\x03")?;
        // Well before the sleep would end on its own.
        until("\x1b]133;D;;lx=interrupted\x07", Duration::from_secs(20))
    })();
    let _ = handle.terminate();
    result
}
