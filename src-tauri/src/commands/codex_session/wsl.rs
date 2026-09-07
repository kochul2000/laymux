use super::lifecycle::LogRow;
use crate::commands::wsl_agent_session::WslAgentProcess;

// The bundled static Linux executable owns SQLite locking inside the distro.
// Arguments never pass through a shell or an ambient PATH lookup.
#[cfg(windows)]
pub(super) fn read_rows(
    process: &WslAgentProcess,
    terminal_id: &str,
    timeout: std::time::Duration,
) -> Result<Vec<LogRow>, String> {
    if !crate::wsl_probe::is_safe_distro_name(&process.distro) {
        return Err("unsafe WSL distribution name".into());
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let helper = executable
        .parent()
        .ok_or("application directory missing")?
        .join(crate::constants::WSL_CODEX_PROBE_FILE);
    if !helper.is_file() {
        return Err("bundled WSL Codex probe missing".into());
    }
    let helper =
        crate::path_utils::windows_to_wsl_path(helper.to_str().ok_or("invalid WSL probe path")?);
    let mut command = crate::process::headless_command("wsl.exe");
    command.args([
        "-d",
        &process.distro,
        "--exec",
        &helper,
        &process.pid.to_string(),
        terminal_id,
    ]);
    let output =
        crate::process::output_with_timeout(&mut command, timeout).map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("WSL Codex probe exited with {}", output.status));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("invalid WSL Codex diagnostics: {e}"))
}

#[cfg(not(windows))]
pub(super) fn read_rows(
    _: &WslAgentProcess,
    _: &str,
    _: std::time::Duration,
) -> Result<Vec<LogRow>, String> {
    Err("WSL is unavailable on this host".into())
}
