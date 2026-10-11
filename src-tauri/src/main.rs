#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The PTY daemon shares this binary but must start before any GUI/Tauri
    // initialization (ADR-0300).
    if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == laymux_lib::constants::PTY_DAEMON_CLI_FLAG)
    {
        std::process::exit(laymux_lib::pty_daemon::run_daemon_main());
    }
    laymux_lib::run();
}
