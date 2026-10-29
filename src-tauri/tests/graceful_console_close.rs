//! A private console per actor; never attaches the test runner/user console.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
    use laymux_lib::constants::TERMINAL_CLOSE_CONSOLE_CLI_FLAG;
    let mut args = std::env::args_os().skip(1);
    let first = args.next();
    if first
        .as_deref()
        .is_some_and(|arg| arg == TERMINAL_CLOSE_CONSOLE_CLI_FLAG)
    {
        let pid = args.next();
        let birth = args.next();
        std::process::exit(laymux_lib::terminal_shutdown::run_console_helper(
            pid.as_deref(),
            birth.as_deref(),
        ));
    }
    if first.as_deref().is_some_and(|arg| arg == "--actor") {
        let path = std::env::var_os("LAYMUX_TEST_ACTOR_LOG").expect("actor log path");
        actor(std::path::Path::new(&path));
        return;
    }
    let result = run();
    if let Err(error) = result {
        println!("{error}");
        std::process::exit(1);
    }
}

#[cfg(not(windows))]
fn main() {}

#[cfg(windows)]
static SIGNAL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(windows)]
unsafe extern "system" fn control(event: u32) -> i32 {
    if event == windows_sys::Win32::System::Console::CTRL_C_EVENT {
        SIGNAL.store(true, std::sync::atomic::Ordering::SeqCst);
        1
    } else {
        0
    }
}

#[cfg(windows)]
fn actor(path: &std::path::Path) {
    use std::io::Write;
    // SAFETY: the handler only stores an atomic flag, and lives for this actor.
    assert_ne!(
        unsafe { windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(control), 1) },
        0
    );
    std::fs::write(path, "ready\n").unwrap();
    println!("CONSOLE_ACTOR_READY");
    std::io::stdout().flush().unwrap();
    while !SIGNAL.load(std::sync::atomic::Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    std::fs::write(path, "ready\nCTRL_C\n").unwrap();
    std::thread::sleep(std::time::Duration::from_secs(1));
    std::fs::write(path, "ready\nCTRL_C\ncleanup-complete\n").unwrap();
}

#[cfg(windows)]
fn run() -> Result<(), String> {
    use laymux_lib::{
        pty::{spawn_pty, PtyHandle, PtyOutputControl},
        terminal::{TerminalConfig, TerminalSession},
    };
    use std::time::{Duration, Instant};
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // The isolated harness has no parallel tests. A bare actor filename avoids
    // the product profile parser's whitespace splitting of quoted executable paths.
    std::env::set_current_dir(exe.parent().ok_or("test executable directory")?)
        .map_err(|e| e.to_string())?;
    let spawn = |name: &str| -> Result<(PtyHandle, std::path::PathBuf), String> {
        let log = temp.path().join(format!("{name}.log"));
        let session = TerminalSession::new(
            name.into(),
            TerminalConfig {
                command_line: format!(
                    "{} --actor",
                    exe.file_name()
                        .ok_or("test executable name")?
                        .to_string_lossy()
                ),
                starting_directory: exe
                    .parent()
                    .ok_or("test executable directory")?
                    .to_string_lossy()
                    .into_owned(),
                env: vec![(
                    "LAYMUX_TEST_ACTOR_LOG".into(),
                    log.to_string_lossy().into_owned(),
                )],
                rows: 24,
                cols: 80,
                ..TerminalConfig::default()
            },
        );
        let handle = spawn_pty(&session, |_| PtyOutputControl::Continue)?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while !std::fs::read_to_string(&log).is_ok_and(|s| s.contains("ready")) {
            if Instant::now() >= deadline {
                let _ = handle.terminate();
                return Err(format!("{name}: actor not ready"));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok((handle, log))
    };
    let (first, first_log) = spawn("closing-pane")?;
    let (peer, peer_log) = spawn("unrelated-pane")?;
    // A stale/reused numeric PID must not redirect a signal to a live console.
    let peer_pid = peer.child_pid().ok_or("peer PID")?.to_string();
    let wrong_birth = std::ffi::OsStr::new("1");
    assert_eq!(
        laymux_lib::terminal_shutdown::run_console_helper(
            Some(std::ffi::OsStr::new(&peer_pid)),
            Some(wrong_birth)
        ),
        0
    );
    let started = Instant::now();
    let result = first.terminate_gracefully();
    let first_events = std::fs::read_to_string(first_log).map_err(|e| e.to_string())?;
    let peer_events = std::fs::read_to_string(peer_log).map_err(|e| e.to_string())?;
    let peer_alive = peer.write(b"peer-is-still-alive").is_ok();
    let _ = peer.terminate();
    result?;
    if !first_events.contains("CTRL_C\ncleanup-complete") {
        return Err(format!("normal cleanup incomplete: {first_events:?}"));
    }
    if started.elapsed() < Duration::from_secs(1) {
        return Err("close did not wait for cleanup".into());
    }
    if peer_events != "ready\n" || !peer_alive {
        return Err(format!("another pane was signaled: {peer_events:?}"));
    }
    println!("native console: graceful cleanup completed; peer untouched");
    Ok(())
}
