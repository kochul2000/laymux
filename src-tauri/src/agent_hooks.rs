//! Optional CLI integration. Installation and observations are independent of
//! heuristic activity; consuming hook state is an explicit settings decision.
pub mod inspections;
pub mod mcp;
pub mod observations;
pub mod title;
pub mod updates;
pub mod usage;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use laymux_agent_hook::runtime::HookEvent;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::process::{headless_wsl_command, output_with_timeout};
use crate::state::AppState;

const MANAGE_TIMEOUT: Duration = Duration::from_secs(8);
// WSL cold start plus up to three host probes (connect + read) per check.
pub(crate) const MCP_WSL_TIMEOUT: Duration = Duration::from_secs(20);
const EVENT_MAX_AGE_MS: u64 = 30_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
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
        let mut command = headless_wsl_command();
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

pub fn manage(
    request: &ManageRequest,
    state: &AppState,
    app: &tauri::AppHandle,
) -> Result<Value, AppError> {
    laymux_agent_hook::install::config_name(&request.provider).map_err(AppError::Other)?;
    if !matches!(
        request.operation.as_str(),
        "status" | "install" | "remove" | "update"
    ) || request
        .distro
        .as_ref()
        .is_some_and(|d| !cfg!(windows) || !crate::wsl_probe::is_safe_distro_name(d))
    {
        return Err(AppError::Other("Invalid hook management request".into()));
    }
    let _gate = state.agent_hook_inspections.gate()?;
    if !state.agent_hook_inspections.begin(request)? {
        return Err(AppError::Other(
            "Hook installation inspection target limit reached".into(),
        ));
    }
    let result =
        helper_directory(app).and_then(|directory| manage_in_directory(request, &directory));
    state.agent_hook_inspections.record(request, &result)?;
    let default_folder = || {
        state
            .agent_hook_inspections
            .is_default_folder(request)
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "Could not classify the hook folder");
                false
            })
    };
    if result.is_ok() && request.operation != "status" && default_folder() {
        let target = usage::UsageTarget {
            provider: request.provider.clone(),
            distro: request.distro.clone(),
        };
        let removed = request.operation == "remove";
        state
            .agent_usage
            .set_removed(usage::Integration::Hook, target, removed);
    }
    notify_inspection_needed(app);
    result
}

pub(crate) fn notify_inspection_needed(app: &tauri::AppHandle) {
    use tauri::Emitter;
    if let Err(error) = app.emit(crate::constants::EVENT_AGENT_HOOK_INSPECTION_NEEDED, ()) {
        tracing::warn!(%error, "Could not notify hook inspection result or discovery");
    }
}

pub(super) fn manage_with_timeout(
    request: &ManageRequest,
    app: &tauri::AppHandle,
    timeout: Duration,
) -> Result<Value, AppError> {
    manage_in_directory_with_timeout(request, &helper_directory(app)?, timeout)
}

pub(crate) fn manage_in_directory(
    request: &ManageRequest,
    directory: &std::path::Path,
) -> Result<Value, AppError> {
    manage_in_directory_with_timeout(request, directory, MANAGE_TIMEOUT)
}

fn manage_in_directory_with_timeout(
    request: &ManageRequest,
    directory: &std::path::Path,
    timeout: Duration,
) -> Result<Value, AppError> {
    tracing::debug!(provider=%request.provider, operation=%request.operation, distro=?request.distro, config_dir=?request.config_dir, "Inspecting agent hook installation");
    laymux_agent_hook::install::config_name(&request.provider).map_err(AppError::Other)?;
    if !matches!(
        request.operation.as_str(),
        "status" | "install" | "remove" | "update"
    ) {
        return Err(AppError::Other("Unknown hook operation".into()));
    }
    if let Some(distro) = &request.distro {
        let mut args = vec!["manage", request.provider.as_str(), &request.operation];
        if let Some(root) = request.config_dir.as_ref().filter(|s| !s.is_empty()) {
            args.push(root);
        }
        return run_wsl_helper(directory, distro, &args, timeout.min(MANAGE_TIMEOUT));
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

pub(crate) fn run_wsl_helper(
    directory: &std::path::Path,
    distro: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<Value, AppError> {
    if !cfg!(windows) || !crate::wsl_probe::is_safe_distro_name(distro) {
        return Err(AppError::Other("Invalid WSL distribution".into()));
    }
    let executable = directory.join("laymux-agent-hook-wsl");
    if !executable.is_file() {
        return Err(AppError::Other("Bundled WSL helper missing".into()));
    }
    let executable = crate::path_utils::windows_to_wsl_path(
        executable
            .to_str()
            .ok_or_else(|| AppError::Other("Invalid helper path".into()))?,
    );
    let mut command = headless_wsl_command();
    command
        .args(["-d", distro, "--exec", &executable])
        .args(args);
    if timeout.is_zero() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "Hook check time budget exhausted",
        )
        .into());
    }
    let output = output_with_timeout(&mut command, timeout)?;
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| AppError::Other(format!("WSL helper failed ({})", output.status)))?;
    if !output.status.success() {
        return Err(AppError::Other(
            value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("WSL helper operation failed")
                .into(),
        ));
    }
    Ok(value)
}

pub(crate) fn helper_directory(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
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

pub fn accept(state: &AppState, event: HookEvent) -> Result<bool, AppError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| AppError::Other(e.to_string()))?
        .as_millis() as u64;
    if !matches!(event.provider.as_str(), "claude" | "codex" | "grok")
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
    let recorded = state
        .agent_hook_observations
        .lock_or_err()?
        .observe(event.clone());
    if recorded && event.provider == "codex" {
        state.session_checkpoint.hints.request();
    }
    let needed = recorded
        && event.agent_id.is_none()
        && event
            .config_dir
            .as_ref()
            .is_some_and(|root| !root.is_empty())
        && state.agent_hook_inspections.announce(&ManageRequest {
            provider: event.provider.clone(),
            operation: "status".into(),
            distro: event.distro.clone(),
            config_dir: event.config_dir.clone(),
        })?;
    let mut terminals = state.terminals.lock_or_err()?;
    let Some(session) = terminals.get_mut(&event.terminal_id) else {
        return Ok(needed);
    };
    if session.agent_hook_token.is_empty() || session.agent_hook_token != event.token {
        return Ok(needed);
    }
    if let Some(previous) = &session.agent_hook {
        if event.emitted_at_ms < previous.emitted_at_ms {
            return Ok(needed);
        }
        if event.event == "SessionEnd"
            && (previous.session_id != event.session_id || previous.provider != event.provider)
        {
            return Ok(needed);
        }
    }
    // Subagent sessions must not replace the parent pane's conversation.
    if event.agent_id.is_some() {
        return Ok(needed);
    }
    session.agent_hook = Some(event);
    Ok(needed)
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
