//! Read Codex CLI rate limits through its documented app-server protocol.
//!
//! This deliberately starts a short-lived local stdio server for each read:
//! it neither opens a listener nor creates a Codex thread, and therefore never
//! competes with an interactive Codex terminal.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::process::headless_command;

const APP_SERVER_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageSnapshot {
    pub status: CodexUsageStatus,
    pub limits: Vec<CodexUsageLimit>,
    pub plan: Option<String>,
    pub captured_at_ms: Option<u64>,
}

impl CodexUsageSnapshot {
    fn failed(status: CodexUsageStatus) -> Self {
        Self {
            status,
            limits: Vec::new(),
            plan: None,
            captured_at_ms: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CodexUsageStatus {
    Ready,
    CodexMissing,
    Unauthorized,
    Failed { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsageLimit {
    pub key: String,
    pub label: String,
    /// Which window of its quota family this row is. Carried as a field rather
    /// than encoded in `key`, so the view never has to parse the key format.
    pub kind: CodexUsageWindowKind,
    pub used_percent: u8,
    pub window_duration_mins: u64,
    pub resets_at_secs: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexUsageWindowKind {
    Primary,
    Secondary,
}

#[derive(Debug, Deserialize)]
struct RpcEnvelope {
    id: Option<u64>,
    result: Option<RateLimitsResult>,
    error: Option<RpcError>,
}

#[derive(Debug, Deserialize)]
struct RpcError {
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateLimitsResult {
    rate_limits: Option<RawBucket>,
    #[serde(default)]
    rate_limits_by_limit_id: BTreeMap<String, RawBucket>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawBucket {
    limit_id: String,
    limit_name: Option<String>,
    primary: Option<RawWindow>,
    secondary: Option<RawWindow>,
    plan_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawWindow {
    used_percent: f64,
    window_duration_mins: u64,
    resets_at: u64,
}

/// Read one Codex account's quota windows. `config_dir` is a user-selected
/// CODEX_HOME whose independent `auth.json` was created with `codex login`.
/// A missing executable and an unauthenticated account are normal display
/// states, not command errors.
#[tauri::command(async)]
pub fn get_codex_usage_snapshot(config_dir: String) -> CodexUsageSnapshot {
    match read_rate_limits(&config_dir) {
        Ok(snapshot) => snapshot,
        Err(ReadError::Missing) => CodexUsageSnapshot::failed(CodexUsageStatus::CodexMissing),
        Err(ReadError::Unauthorized) => CodexUsageSnapshot::failed(CodexUsageStatus::Unauthorized),
        Err(ReadError::Failed(message)) => {
            CodexUsageSnapshot::failed(CodexUsageStatus::Failed { message })
        }
    }
}

#[derive(Debug)]
enum ReadError {
    Missing,
    Unauthorized,
    Failed(String),
}

fn read_rate_limits(config_dir: &str) -> Result<CodexUsageSnapshot, ReadError> {
    let mut command = codex_app_server_command();
    apply_codex_home(&mut command, config_dir);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ReadError::Missing
            } else {
                ReadError::Failed(error.to_string())
            }
        })?;

    let request = concat!(
        "{\"id\":0,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"laymux\",\"title\":\"laymux\",\"version\":\"1.0\"}}}\n",
        "{\"method\":\"initialized\",\"params\":{}}\n",
        "{\"id\":1,\"method\":\"account/rateLimits/read\",\"params\":{}}\n",
    );
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| ReadError::Failed("Codex app-server stdin unavailable".into()))?;
    stdin
        .write_all(request.as_bytes())
        .map_err(|error| ReadError::Failed(error.to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ReadError::Failed("Codex app-server stdout unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ReadError::Failed("Codex app-server stderr unavailable".into()))?;
    let stderr_reader = std::thread::spawn(move || read_stderr_tail(stderr));
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let response =
            find_rate_limit_response(BufReader::new(stdout).lines().map_while(Result::ok));
        let _ = sender.send(response);
    });
    let response = receiver.recv_timeout(APP_SERVER_TIMEOUT);
    drop(stdin);
    let exit_status = match child.try_wait() {
        Ok(Some(status)) => Some(status),
        Ok(None) => {
            let _ = child.kill();
            child.wait().ok()
        }
        Err(_) => None,
    };
    let stderr = stderr_reader
        .join()
        .unwrap_or_else(|_| "Codex app-server stderr reader failed".into());

    match response {
        Ok(Some(response)) => parse_rate_limit_response(response),
        Ok(None) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err(classify_no_response(exit_status, &stderr))
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            Err(ReadError::Failed("Codex app-server timed out".into()))
        }
    }
}

const STDERR_TAIL_BYTES: usize = 4 * 1024;

fn read_stderr_tail(mut stderr: impl Read) -> String {
    let mut tail = Vec::new();
    let mut buffer = [0_u8; 1024];
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                tail.extend_from_slice(&buffer[..read]);
                if tail.len() > STDERR_TAIL_BYTES {
                    tail.drain(..tail.len() - STDERR_TAIL_BYTES);
                }
            }
        }
    }
    String::from_utf8_lossy(&tail).trim().to_owned()
}

fn find_rate_limit_response<I, S>(lines: I) -> Option<RpcEnvelope>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    lines.into_iter().find_map(|line| {
        let message = serde_json::from_str::<RpcEnvelope>(line.as_ref()).ok()?;
        (message.id == Some(1)).then_some(message)
    })
}

fn classify_no_response(exit_status: Option<std::process::ExitStatus>, stderr: &str) -> ReadError {
    let lower_stderr = stderr.to_lowercase();
    if lower_stderr.contains("not recognized as an internal or external command")
        || lower_stderr.contains("command not found")
        || lower_stderr.contains("no such file or directory")
    {
        return ReadError::Missing;
    }
    let status = exit_status
        .map(|status| status.to_string())
        .unwrap_or_else(|| "unknown exit status".into());
    let detail = if stderr.is_empty() {
        String::new()
    } else {
        format!(": {stderr}")
    };
    ReadError::Failed(format!(
        "Codex app-server exited without a rate-limit response ({status}){detail}"
    ))
}

fn apply_codex_home(command: &mut std::process::Command, config_dir: &str) {
    if !config_dir.is_empty() {
        command.env("CODEX_HOME", config_dir);
    }
}

#[cfg(target_os = "windows")]
fn codex_app_server_command() -> std::process::Command {
    // npm installs Codex as a .cmd/.ps1 shim on Windows. Invoke the underlying
    // Node entry point directly so stdin/stdout stay attached to app-server.
    if let Some(script) = std::env::var_os("APPDATA")
        .map(|appdata| {
            std::path::PathBuf::from(appdata).join("npm/node_modules/@openai/codex/bin/codex.js")
        })
        .filter(|path| path.is_file())
    {
        let mut command = headless_command("node");
        command.arg(script).args(["app-server", "--stdio"]);
        return command;
    }
    // Fallback for non-npm installs that still expose a command shim.
    let mut command = headless_command("cmd");
    command.args(["/C", "codex", "app-server", "--stdio"]);
    command
}

#[cfg(not(target_os = "windows"))]
fn codex_app_server_command() -> std::process::Command {
    let mut command = headless_command("codex");
    command.args(["app-server", "--stdio"]);
    command
}

#[cfg(test)]
fn parse_rate_limits(stdout: &str) -> Result<CodexUsageSnapshot, ReadError> {
    let response = find_rate_limit_response(stdout.lines()).ok_or_else(|| {
        ReadError::Failed("Codex app-server returned no rate-limit response".into())
    })?;
    parse_rate_limit_response(response)
}

fn parse_rate_limit_response(response: RpcEnvelope) -> Result<CodexUsageSnapshot, ReadError> {
    if let Some(error) = response.error {
        let lower = error.message.to_lowercase();
        return Err(if lower.contains("auth") || lower.contains("login") {
            ReadError::Unauthorized
        } else {
            ReadError::Failed(error.message)
        });
    }
    let result = response.result.ok_or_else(|| {
        ReadError::Failed("Codex app-server returned an empty rate-limit response".into())
    })?;
    let buckets = if result.rate_limits_by_limit_id.is_empty() {
        result.rate_limits.into_iter().collect::<Vec<_>>()
    } else {
        result.rate_limits_by_limit_id.into_values().collect()
    };
    let plan = buckets.iter().find_map(|bucket| bucket.plan_type.clone());
    let limits = buckets.into_iter().flat_map(flatten_bucket).collect();
    Ok(CodexUsageSnapshot {
        status: CodexUsageStatus::Ready,
        limits,
        plan,
        captured_at_ms: Some(now_ms()),
    })
}

fn flatten_bucket(bucket: RawBucket) -> Vec<CodexUsageLimit> {
    let base = bucket.limit_name.unwrap_or_else(|| bucket.limit_id.clone());
    [
        (CodexUsageWindowKind::Primary, bucket.primary),
        (CodexUsageWindowKind::Secondary, bucket.secondary),
    ]
    .into_iter()
    .filter_map(|(kind, window)| {
        window.map(|window| CodexUsageLimit {
            key: format!("{}-{}", bucket.limit_id, window_kind_slug(kind)),
            label: match kind {
                CodexUsageWindowKind::Primary => base.clone(),
                CodexUsageWindowKind::Secondary => format!("{base} (secondary)"),
            },
            kind,
            used_percent: window.used_percent.round().clamp(0.0, 100.0) as u8,
            window_duration_mins: window.window_duration_mins,
            resets_at_secs: window.resets_at,
        })
    })
    .collect()
}

/// `key` stays human-readable for React keys and test ids. It is not parsed.
fn window_kind_slug(kind: CodexUsageWindowKind) -> &'static str {
    match kind {
        CodexUsageWindowKind::Primary => "primary",
        CodexUsageWindowKind::Secondary => "secondary",
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn selected_account_home_is_isolated_to_its_app_server_child() {
        let mut command = std::process::Command::new("codex");
        apply_codex_home(&mut command, "C:/accounts/work");
        let home = command
            .get_envs()
            .find(|(key, _)| *key == OsStr::new("CODEX_HOME"))
            .and_then(|(_, value)| value.map(ToOwned::to_owned));
        assert_eq!(home.as_deref(), Some(OsStr::new("C:/accounts/work")));
    }

    #[test]
    fn parses_all_structured_rate_limit_windows() {
        let output = r#"{"id":1,"result":{"rateLimitsByLimitId":{"codex":{"limitId":"codex","limitName":"Codex","planType":"pro","primary":{"usedPercent":42,"windowDurationMins":300,"resetsAt":1730950800},"secondary":{"usedPercent":10,"windowDurationMins":10080,"resetsAt":1731550800}}}}}"#;
        let snapshot = parse_rate_limits(output).unwrap();
        assert_eq!(snapshot.limits.len(), 2);
        assert_eq!(snapshot.limits[0].label, "Codex");
        assert_eq!(snapshot.limits[0].kind, CodexUsageWindowKind::Primary);
        assert_eq!(snapshot.limits[1].label, "Codex (secondary)");
        assert_eq!(snapshot.limits[1].kind, CodexUsageWindowKind::Secondary);
        assert_eq!(snapshot.plan.as_deref(), Some("pro"));
    }

    #[test]
    fn window_kind_survives_a_limit_id_that_looks_like_a_key_suffix() {
        // The view selects primary windows by `kind`, so a limit id ending in
        // "-primary" can no longer be mistaken for one.
        let output = r#"{"id":1,"result":{"rateLimits":{"limitId":"weird-primary","primary":{"usedPercent":5,"windowDurationMins":300,"resetsAt":1730950800},"secondary":{"usedPercent":6,"windowDurationMins":10080,"resetsAt":1731550800}}}}"#;
        let snapshot = parse_rate_limits(output).unwrap();
        assert_eq!(snapshot.limits[0].key, "weird-primary-primary");
        assert_eq!(snapshot.limits[0].kind, CodexUsageWindowKind::Primary);
        assert_eq!(snapshot.limits[1].key, "weird-primary-secondary");
        assert_eq!(snapshot.limits[1].kind, CodexUsageWindowKind::Secondary);
    }

    #[test]
    fn rounds_and_clamps_fractional_rate_limit_percentages() {
        let output = r#"{"id":1,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":42.5,"windowDurationMins":300,"resetsAt":1730950800},"secondary":{"usedPercent":255.1,"windowDurationMins":10080,"resetsAt":1731550800}}}}"#;
        let snapshot = parse_rate_limits(output).unwrap();
        assert_eq!(snapshot.limits[0].used_percent, 43);
        assert_eq!(snapshot.limits[1].used_percent, 100);
    }

    #[test]
    fn maps_disconnected_command_shim_to_codex_missing() {
        assert!(matches!(
            classify_no_response(
                None,
                "'codex' is not recognized as an internal or external command"
            ),
            ReadError::Missing
        ));
    }
    #[test]
    fn maps_auth_errors_to_a_display_state() {
        let output = r#"{"id":1,"error":{"message":"Authentication required"}}"#;
        assert!(matches!(
            parse_rate_limits(output),
            Err(ReadError::Unauthorized)
        ));
    }
}
