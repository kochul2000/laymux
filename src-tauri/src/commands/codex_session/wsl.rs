use super::lifecycle::LogRow;
use crate::commands::wsl_agent_session::WslAgentProcess;

// No user paths are interpolated into the shell. The integer PID selects the
// environment in /proc; SQLite runs in its owning OS, not over UNC locking.
#[cfg(windows)]
pub(super) fn read_rows(
    process: &WslAgentProcess,
    terminal_id: &str,
    timeout: std::time::Duration,
) -> Result<Vec<LogRow>, String> {
    use std::fmt::Write;
    let mut marker = String::new();
    for byte in terminal_id.bytes() {
        write!(&mut marker, "{byte:02x}").map_err(|e| e.to_string())?;
    }
    let script = format!(
        "python3 - {} {} <<'LAYMUX_CODEX_SQLITE'\n{}\nLAYMUX_CODEX_SQLITE",
        process.pid,
        marker,
        include_str!("wsl_sqlite.py")
    );
    let output = crate::wsl_probe::run_probe_script(
        &process.distro,
        &script,
        "laymux-codex-sqlite",
        timeout,
    )?;
    serde_json::from_slice(&output).map_err(|e| format!("invalid WSL Codex diagnostics: {e}"))
}

#[cfg(not(windows))]
pub(super) fn read_rows(
    _: &WslAgentProcess,
    _: &str,
    _: std::time::Duration,
) -> Result<Vec<LogRow>, String> {
    Err("WSL is unavailable on this host".into())
}
