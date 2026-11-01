//! Client-owned audio, Codex-owned conversation (ADR-0369).
pub(crate) mod routes;
#[cfg(test)]
mod tests;
mod transport;

use crate::lock_ext::MutexExt;
use crate::state::AppState;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

const MAX_SDP_BYTES: usize = 128 * 1024;
const MAX_EVENTS: usize = 128;
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Default)]
pub struct VoiceManager {
    current: Mutex<Option<Arc<Session>>>,
}

struct Session {
    id: String,
    target: Target,
    owner: Option<String>,
    cancel: AtomicBool,
    closed: AtomicBool,
    last_seen: Mutex<Instant>,
    events: Mutex<Events>,
}

#[derive(Clone)]
pub(crate) struct Target {
    pub terminal_id: String,
    pub generation: u64,
    pub title: crate::agent_hooks::title::TitleBinding,
    pub thread_id: String,
    pub socket_path: std::path::PathBuf,
    pub distro: Option<String>,
}

#[derive(Default)]
struct Events {
    sequence: u64,
    entries: VecDeque<(u64, Value)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceEvents {
    sequence: u64,
    events: Vec<Value>,
    closed: bool,
}

impl Events {
    fn push(&mut self, value: Value) {
        self.sequence += 1;
        self.entries.push_back((self.sequence, value));
        if self.entries.len() > MAX_EVENTS {
            self.entries.pop_front();
        }
    }
    fn after(&self, since: u64) -> Result<VoiceEvents, String> {
        if since > self.sequence
            || self
                .entries
                .front()
                .is_some_and(|(first, _)| since.saturating_add(1) < *first)
        {
            return Err("Voice signaling events were lost; reconnect voice".into());
        }
        Ok(VoiceEvents {
            sequence: self.sequence,
            events: self
                .entries
                .iter()
                .filter(|(s, _)| *s > since)
                .map(|(_, v)| v.clone())
                .collect(),
            closed: false,
        })
    }
}

fn validate_offer(sdp: &str) -> Result<(), String> {
    if sdp.len() > MAX_SDP_BYTES
        || !sdp.starts_with("v=0")
        || !sdp.lines().any(|line| line.starts_with("m=audio "))
        || sdp.contains('\0')
    {
        return Err("A valid audio WebRTC offer (up to 128 KiB) is required".into());
    }
    Ok(())
}

fn voice_event(message: &Value, thread_id: &str) -> Option<Value> {
    let method = message.get("method")?.as_str()?;
    // Media uses WebRTC. Do not relay raw PCM or unrelated account/agent data.
    if !matches!(
        method,
        "thread/realtime/sdp"
            | "thread/realtime/started"
            | "thread/realtime/error"
            | "thread/realtime/closed"
    ) || message.pointer("/params/threadId")?.as_str()? != thread_id
    {
        return None;
    }
    Some(message.clone())
}

impl Session {
    fn event(&self, message: Value) {
        if let Ok(mut events) = self.events.lock_or_err() {
            events.push(message);
        }
    }
    fn valid(&self, state: &AppState) -> bool {
        if self.cancel.load(Ordering::Acquire) {
            return false;
        }
        let live = state.pty_handles.lock_or_err().ok().is_some_and(|p| {
            p.get(&self.target.terminal_id)
                .is_some_and(|h| h.terminal_generation() == self.target.generation)
        });
        let selected = state.terminals.lock_or_err().ok().is_some_and(|t| {
            t.get(&self.target.terminal_id)
                .is_some_and(|t| t.codex_hook_title == self.target.title)
        });
        let recent = self
            .last_seen
            .lock_or_err()
            .ok()
            .is_some_and(|seen| seen.elapsed() < HEARTBEAT_TIMEOUT);
        let owner = match &self.owner {
            Some(lease) => {
                crate::remote_server::active_lease_matches(state, lease).unwrap_or(false)
            }
            None => crate::remote_server::begin_human_control_operation(
                state,
                crate::remote_server::HumanControlOrigin::Local,
                &self.target.terminal_id,
            )
            .is_ok(),
        };
        live && selected && recent && owner
    }
}

impl VoiceManager {
    pub async fn start(
        state: Arc<AppState>,
        terminal: String,
        sdp: String,
        owner: Option<String>,
    ) -> Result<String, String> {
        validate_offer(&sdp)?;
        let resolver_state = state.clone();
        let target = tokio::task::spawn_blocking(move || {
            crate::commands::codex_voice_target(&resolver_state, &terminal)
        })
        .await
        .map_err(|e| e.to_string())??;
        let session = Arc::new(Session {
            id: uuid::Uuid::new_v4().to_string(),
            target,
            owner,
            cancel: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            last_seen: Mutex::new(Instant::now()),
            events: Mutex::new(Events::default()),
        });
        {
            let mut current = state.agent_voice.current.lock_or_err()?;
            if current
                .as_ref()
                .is_some_and(|s| !s.closed.load(Ordering::Acquire))
            {
                return Err("Another laymux voice session is active".into());
            }
            *current = Some(session.clone());
        }
        let (ready, result) = tokio::sync::oneshot::channel();
        let worker_session = session.clone();
        let worker_state = state.clone();
        std::thread::Builder::new()
            .name("agent-voice".into())
            .spawn(move || run(worker_state, worker_session, sdp, ready))
            .map_err(|e| {
                session.closed.store(true, Ordering::Release);
                e.to_string()
            })?;
        match tokio::time::timeout(Duration::from_secs(25), result).await {
            Ok(Ok(Ok(()))) => Ok(session.id.clone()),
            other => {
                session.cancel.store(true, Ordering::Release);
                Err(match other {
                    Ok(Ok(Err(e))) => e,
                    _ => "Voice startup timed out".into(),
                })
            }
        }
    }

    fn owned(&self, id: &str, owner: Option<&str>) -> Result<Arc<Session>, String> {
        self.current
            .lock_or_err()?
            .as_ref()
            .filter(|s| s.id == id && s.owner.as_deref() == owner)
            .cloned()
            .ok_or_else(|| "Voice session does not belong to this controller".into())
    }
    pub fn poll(&self, id: &str, owner: Option<&str>, since: u64) -> Result<VoiceEvents, String> {
        let session = self.owned(id, owner)?;
        *session.last_seen.lock_or_err()? = Instant::now();
        let mut result = session.events.lock_or_err()?.after(since)?;
        result.closed = session.closed.load(Ordering::Acquire);
        Ok(result)
    }
    pub fn stop(&self, id: &str, owner: Option<&str>) -> Result<(), String> {
        self.owned(id, owner)?.cancel.store(true, Ordering::Release);
        Ok(())
    }
}

fn run(
    state: Arc<AppState>,
    session: Arc<Session>,
    sdp: String,
    ready: tokio::sync::oneshot::Sender<Result<(), String>>,
) {
    let mut connection = match transport::Connection::connect(&session.target) {
        Ok(c) => c,
        Err(e) => {
            let _ = ready.send(Err(e));
            session.closed.store(true, Ordering::Release);
            return;
        }
    };
    let mut thread_id = session.target.thread_id.clone();
    let startup = (|| {
        connection.request("initialize", json!({"clientInfo":{"name":"laymux-voice","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}), |_|{})?;
        connection.notify("initialized", json!({}))?;
        if thread_id.len() != 36 {
            let loaded = connection.request("thread/loaded/list", json!({}), |_| {})?;
            let matches: Vec<String> = loaded
                .get("data")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|id| id.starts_with(&thread_id))
                .map(str::to_owned)
                .collect();
            if matches.len() != 1 {
                return Err(
                    "Codex current title does not identify exactly one loaded conversation".into(),
                );
            }
            thread_id = matches[0].clone();
        }
        if !session.valid(&state) {
            return Err("Voice pane or controller changed during startup".into());
        }
        connection.request(
            "thread/resume",
            json!({"threadId":thread_id,"excludeTurns":true}),
            |_| {},
        )?;
        connection.request("thread/realtime/start", json!({"threadId":thread_id,"voiceSessionId":session.id,"version":"v3","outputModality":"audio","transport":{"type":"webrtc","sdp":sdp}}), |v| { if let Some(v)=voice_event(&v,&thread_id){session.event(v);} })?;
        Ok(())
    })();
    let started = startup.is_ok();
    let _ = ready.send(startup);
    if started {
        let mut ended_by_server = false;
        while session.valid(&state) {
            match connection.read() {
                Ok(Some(message)) => {
                    if let Some(event) = voice_event(&message, &thread_id) {
                        let closed = event["method"] == "thread/realtime/closed"
                            || event["method"] == "thread/realtime/error";
                        session.event(event);
                        if closed {
                            ended_by_server = true;
                            break;
                        }
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    session.event(json!({"method":"thread/realtime/error","params":{"threadId":thread_id,"message":error}}));
                    break;
                }
            }
        }
        // The upstream stop API is thread-scoped. Concurrent native CLI Voice
        // on this thread is unsupported; do not stop again after server closure.
        if !ended_by_server {
            let _ = connection.request(
                "thread/realtime/stop",
                json!({"threadId":thread_id}),
                |_| {},
            );
        }
    }
    session.closed.store(true, Ordering::Release);
}
