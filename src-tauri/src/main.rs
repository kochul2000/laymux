#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(result) = laymux_lib::run_terminal_service_if_requested() {
        if let Err(error) = result {
            tracing::error!(%error, "PTY daemon failed");
            std::process::exit(1);
        }
        return;
    }
    laymux_lib::run();
}
