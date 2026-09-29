use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

pub const ENV_TOKEN: &str = "LX_AGENT_HOOK_TOKEN";
pub const EVENT_PATH: &str = "/api/v1/agent-hooks/events";
const MAX_INPUT_BYTES: u64 = 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_millis(700);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub start_time: u64,
    pub name: String,
    pub helper: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookEvent {
    pub terminal_id: String,
    pub token: String,
    pub provider: String,
    pub session_id: String,
    pub event: String,
    pub source: Option<String>,
    pub transcript_path: Option<String>,
    pub cwd: Option<String>,
    pub agent_id: Option<String>,
    pub turn_id: Option<String>,
    pub emitted_at_ms: u64,
    pub ancestors: Vec<ProcessIdentity>,
    pub distro: Option<String>,
    pub config_dir: Option<String>,
}

fn string(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| s.len() <= 8192)
        .map(str::to_owned)
}

pub fn parse_event(
    provider: &str,
    input: &Value,
    terminal_id: String,
    token: String,
) -> Result<HookEvent, String> {
    crate::install::config_name(provider)?;
    let session_id = string(input, "session_id")
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 256
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        })
        .ok_or("Invalid session id")?;
    let event = string(input, "hook_event_name")
        .filter(|s| crate::install::EVENTS.contains(&s.as_str()))
        .ok_or("Unsupported hook event")?;
    Ok(HookEvent {
        terminal_id,
        token,
        provider: provider.into(),
        session_id,
        event,
        source: string(input, "source"),
        transcript_path: string(input, "transcript_path"),
        cwd: string(input, "cwd"),
        agent_id: string(input, "agent_id"),
        turn_id: string(input, "turn_id"),
        emitted_at_ms: 0,
        ancestors: Vec::new(),
        distro: None,
        config_dir: None,
    })
}

fn ancestors() -> Vec<ProcessIdentity> {
    let mut system = System::new();
    let mut pid = Pid::from_u32(std::process::id());
    let mut result = Vec::new();
    for _ in 0..32 {
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
        );
        let Some(process) = system.process(pid) else {
            break;
        };
        let name = process.name().to_string_lossy().to_ascii_lowercase();
        let helper = (name == "codex" || name == "codex.exe")
            && process.cmd().get(1).is_some_and(|arg| arg == "app-server");
        let parent = process.parent();
        result.push(ProcessIdentity {
            pid: pid.as_u32(),
            parent_pid: parent.map(Pid::as_u32),
            start_time: process.start_time(),
            name,
            helper,
        });
        let Some(parent) = parent else {
            break;
        };
        if result.iter().any(|p| p.pid == parent.as_u32()) {
            break;
        }
        pid = parent;
    }
    result
}

pub fn emit(provider: &str) -> Result<(), String> {
    let terminal_id = std::env::var("LX_TERMINAL_ID").unwrap_or_default();
    let token = std::env::var(ENV_TOKEN).unwrap_or_default();
    if terminal_id.is_empty() || token.is_empty() {
        return Ok(());
    }
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err("Hook input too large".into());
    }
    let input: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let mut event = parse_event(provider, &input, terminal_id, token)?;
    event.ancestors = ancestors();
    event.distro = std::env::var("WSL_DISTRO_NAME").ok();
    event.config_dir = std::env::current_exe().ok().and_then(|path| {
        path.parent()?
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
    });
    event.emitted_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    let port: u16 = std::env::var("LX_AUTOMATION_PORT")
        .map_err(|e| e.to_string())?
        .parse()
        .map_err(|_| "Invalid automation port")?;
    // Never guess release/dev when the parent did not supply a destination.
    let host = std::env::var("LX_AUTOMATION_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let host: IpAddr = host.parse().map_err(|_| "Invalid automation host")?;
    let body = serde_json::to_vec(&event).map_err(|e| e.to_string())?;
    let mut stream = TcpStream::connect_timeout(&SocketAddr::new(host, port), IO_TIMEOUT)
        .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|e| e.to_string())?;
    write!(stream,"POST {EVENT_PATH} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).map_err(|e|e.to_string())?;
    stream.write_all(&body).map_err(|e| e.to_string())?;
    let mut response = [0u8; 128];
    let n = stream.read(&mut response).map_err(|e| e.to_string())?;
    if !response[..n].starts_with(b"HTTP/1.1 200") {
        return Err("Hook event was not accepted".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn forwards_identity_without_prompt_or_tool_contents() {
        let input = json!({"session_id":"session-1","hook_event_name":"SessionStart","source":"resume","prompt":"SECRET","tool_input":{"password":"SECRET"},"transcript_path":"/tmp/session.jsonl"});
        let event = parse_event("codex", &input, "pane".into(), "token".into()).unwrap();
        let json = serde_json::to_string(&event).unwrap();
        assert!(!json.contains("SECRET"));
        assert_eq!(event.source.as_deref(), Some("resume"));
        assert_eq!(event.transcript_path.as_deref(), Some("/tmp/session.jsonl"));
    }

    #[test]
    fn rejects_malformed_or_unrecognized_input() {
        for input in [
            json!({}),
            json!({"session_id":"../other","hook_event_name":"SessionStart"}),
            json!({"session_id":"ok","hook_event_name":"unknown"}),
        ] {
            assert!(parse_event("claude", &input, "pane".into(), "token".into()).is_err());
        }
    }
}
