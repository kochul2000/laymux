//! Optional CLI integration. Installation and observations are independent of
//! heuristic activity; consuming hook state is an explicit settings decision.
pub mod observations;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use laymux_agent_hook::runtime::HookEvent;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::process::{headless_command, output_with_timeout};
use crate::state::AppState;

const MANAGE_TIMEOUT: Duration = Duration::from_secs(8);
const EVENT_MAX_AGE_MS: u64 = 30_000;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManageRequest {
    pub provider: String,
    pub operation: String,
    pub distro: Option<String>,
    pub config_dir: Option<String>,
}

pub fn environments() -> Result<Vec<Value>, AppError> {
    #[allow(unused_mut)] // WSL enumeration extends the list only on Windows.
    let mut values = vec![
        json!({"id":"native", "label":if cfg!(windows) {"Windows"} else {"Linux"}, "distro":null}),
    ];
    #[cfg(windows)]
    {
        let mut command = headless_command("wsl.exe");
        command.args(["--list", "--quiet"]);
        if let Ok(output) = output_with_timeout(&mut command, Duration::from_secs(3)) {
            if output.status.success() {
                let words: Vec<_> = output
                    .stdout
                    .chunks_exact(2)
                    .map(|b| u16::from_le_bytes([b[0], b[1]]))
                    .collect();
                let text = String::from_utf16_lossy(&words);
                for distro in text
                    .lines()
                    .map(str::trim)
                    .filter(|s| crate::wsl_probe::is_safe_distro_name(s))
                {
                    values.push(json!({"id":format!("wsl:{distro}"),"label":format!("WSL · {distro}"),"distro":distro}));
                }
            }
        }
    }
    Ok(values)
}

pub fn manage(request: &ManageRequest, app: &tauri::AppHandle) -> Result<Value, AppError> {
    laymux_agent_hook::install::config_name(&request.provider).map_err(AppError::Other)?;
    if !matches!(request.operation.as_str(), "status" | "install" | "remove") {
        return Err(AppError::Other("Unknown hook operation".into()));
    }
    let directory = helper_directory(app)?;
    if let Some(distro) = &request.distro {
        if !cfg!(windows) || !crate::wsl_probe::is_safe_distro_name(distro) {
            return Err(AppError::Other("Invalid WSL distribution".into()));
        }
        let executable = directory.join("laymux-agent-hook-wsl");
        if !executable.is_file() {
            return Err(AppError::Other("Bundled WSL hook helper missing".into()));
        }
        let executable = crate::path_utils::windows_to_wsl_path(
            executable
                .to_str()
                .ok_or_else(|| AppError::Other("Invalid helper path".into()))?,
        );
        let mut command = headless_command("wsl.exe");
        command.args([
            "-d",
            distro,
            "--exec",
            &executable,
            "manage",
            &request.provider,
            &request.operation,
        ]);
        if let Some(root) = request.config_dir.as_ref().filter(|s| !s.is_empty()) {
            command.arg(root);
        }
        let output = output_with_timeout(&mut command, MANAGE_TIMEOUT)?;
        let value: Value = serde_json::from_slice(&output.stdout)
            .map_err(|_| AppError::Other(format!("WSL hook helper failed ({})", output.status)))?;
        if !output.status.success() {
            return Err(AppError::Other(
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("WSL hook operation failed")
                    .into(),
            ));
        }
        return Ok(value);
    }
    let root = match request.config_dir.as_ref().filter(|s| !s.is_empty()) {
        Some(root) => PathBuf::from(root),
        None => {
            laymux_agent_hook::install::default_root(&request.provider).map_err(AppError::Other)?
        }
    };
    let executable = directory.join(if cfg!(windows) {
        "laymux-agent-hook.exe"
    } else {
        "laymux-agent-hook"
    });
    laymux_agent_hook::install::manage(&root, &request.provider, &request.operation, &executable)
        .map_err(AppError::Other)
}

fn helper_directory(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    if cfg!(windows) || cfg!(debug_assertions) {
        return std::env::current_exe()?
            .parent()
            .map(std::path::Path::to_path_buf)
            .ok_or_else(|| AppError::Other("Application directory missing".into()));
    }
    use tauri::Manager;
    app.path()
        .resource_dir()
        .map_err(|e| AppError::Other(e.to_string()))
}

pub fn accept(state: &AppState, event: HookEvent) -> Result<(), AppError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| AppError::Other(e.to_string()))?
        .as_millis() as u64;
    if !matches!(event.provider.as_str(), "claude" | "codex")
        || serde_json::to_vec(&event)
            .map_err(|e| AppError::Other(e.to_string()))?
            .len()
            > 32_768
        || !laymux_agent_hook::install::events(&event.provider).contains(&event.event.as_str())
        || event.session_id.is_empty()
        || event.session_id.len() > 256
        || !event
            .session_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        || event.ancestors.len() > 32
        || event.emitted_at_ms > now + 5_000
        || now.saturating_sub(event.emitted_at_ms) > EVENT_MAX_AGE_MS
    {
        return Err(AppError::Other(
            "Invalid or expired hook observation".into(),
        ));
    }
    // A shared server can keep the launching pane's environment across resume.
    // Recording metadata cannot establish pane ownership: the state consumer
    // separately proves the current process, conversation, domain and generation.
    state
        .agent_hook_observations
        .lock_or_err()?
        .observe(event.clone());
    let mut terminals = state.terminals.lock_or_err()?;
    let Some(session) = terminals.get_mut(&event.terminal_id) else {
        return Ok(());
    };
    if session.agent_hook_token.is_empty() || session.agent_hook_token != event.token {
        return Ok(());
    }
    if let Some(previous) = &session.agent_hook {
        if event.emitted_at_ms < previous.emitted_at_ms {
            return Ok(());
        }
        if event.event == "SessionEnd"
            && (previous.session_id != event.session_id || previous.provider != event.provider)
        {
            return Ok(());
        }
    }
    // Subagent sessions must not replace the parent pane's conversation.
    if event.agent_id.is_some() {
        return Ok(());
    }
    session.agent_hook = Some(event);
    Ok(())
}

pub fn connections(state: &AppState) -> Result<Vec<Value>, AppError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| AppError::Other(e.to_string()))?
        .as_millis() as u64;
    let registry = state.agent_hook_observations.lock_or_err()?;
    Ok(registry.diagnostic_events(now).map(|event|json!({
        "terminalId":event.terminal_id,"provider":event.provider,"sessionId":event.session_id,"event":event.event,
        "receivedAtMs":event.emitted_at_ms,"distro":event.distro,"configDir":event.config_dir,
        "paneIdentity":"reported", "source":event.source,"ancestors":event.ancestors
    })).collect())
}

#[cfg(test)]
mod tests;
