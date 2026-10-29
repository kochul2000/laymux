#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args_os().skip(1);
    let first = args.next();
    #[cfg(windows)]
    if first
        .as_deref()
        .is_some_and(|arg| arg == laymux_lib::constants::TERMINAL_CLOSE_CONSOLE_CLI_FLAG)
    {
        let pid = args.next();
        let birth = args.next();
        std::process::exit(laymux_lib::terminal_shutdown::run_console_helper(
            pid.as_deref(),
            birth.as_deref(),
        ));
    }
    // The PTY daemon shares this binary but must start before any GUI/Tauri
    // initialization (ADR-0300).
    if first
        .as_deref()
        .is_some_and(|arg| arg == laymux_lib::constants::PTY_DAEMON_CLI_FLAG)
    {
        std::process::exit(laymux_lib::pty_daemon::run_daemon_main());
    }
    // A GUI started to replace one whose WebView failed waits for it to exit
    // before taking the automation port and the WebView2 profile (ADR-0336).
    #[cfg(windows)]
    if first
        .as_deref()
        .is_some_and(|arg| arg == laymux_lib::constants::GUI_RELAUNCH_AFTER_CLI_FLAG)
    {
        laymux_lib::webview_recovery::wait_for_predecessor(args.next().as_deref());
    }
    laymux_lib::run();
}
