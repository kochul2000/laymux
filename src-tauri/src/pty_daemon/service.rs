//! Terminal service with no Tauri window or GUI output-credit dependency.
use crate::daemon_protocol::{AttachmentAuthority, Capability, Challenge, PROTOCOL_VERSION};
use crate::daemon_requests::{
    Authentication, Command, PhysicalAction, ReadCommand, Request, Response,
};
use crate::daemon_wire::{read_frame, write_frame};
use crate::error::AppError;
use crate::headless_broker::HeadlessBroker;
use crate::headless_worker::HeadlessWorker;
use crate::lock_ext::MutexExt;
use crate::settings::Settings;
use crate::state::AppState;
use crate::terminal_events::TerminalEvents;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncWrite};

const MAX_SCREEN_CELLS: usize = 4 * 1024 * 1024;

pub(crate) struct DaemonService {
    capability: Capability,
    scope: String,
    runtime: String,
    incarnation: String,
    /// All client mutations share this gate. No AppState guard crosses await.
    authority: tokio::sync::Mutex<AttachmentAuthority>,
    controls: AtomicUsize,
    physical: Mutex<HashMap<String, Arc<AtomicBool>>>,
    state: Arc<AppState>,
    settings: Arc<Mutex<Settings>>,
    broker: Arc<HeadlessBroker>,
    events: TerminalEvents,
    writer: Arc<super::session_writer::SessionWriter>,
    lifecycle: Arc<tokio::sync::Mutex<()>>,
    session_worker: Mutex<Option<tokio::task::AbortHandle>>,
    journal: Arc<Mutex<super::event_journal::EventJournal>>,
    #[cfg(test)]
    read_started: tokio::sync::Notify,
    #[cfg(test)]
    session_read_delay: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    session_commit_started: tokio::sync::Notify,
}

struct ConnectionLifetime(Arc<AtomicBool>);
struct ControlLifetime(Arc<DaemonService>);
impl Drop for ControlLifetime {
    fn drop(&mut self) {
        self.0.controls.fetch_sub(1, Ordering::AcqRel);
    }
}
struct PhysicalLifetime {
    service: Arc<DaemonService>,
    id: String,
}
impl Drop for PhysicalLifetime {
    fn drop(&mut self) {
        if let Ok(mut operations) = self.service.physical.lock_or_err() {
            operations.remove(&self.id);
        }
    }
}
impl Drop for ConnectionLifetime {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl DaemonService {
    pub(crate) fn incarnation(&self) -> &str {
        &self.incarnation
    }
    pub(crate) fn new(
        capability: Capability,
        scope: String,
        runtime: String,
        settings: Settings,
        node: &Path,
        worker: &Path,
        store: crate::local_state::LocalStateStore,
    ) -> Result<Arc<Self>, AppError> {
        let state = Arc::new(AppState::from_settings(settings.clone()));
        let settings = Arc::new(Mutex::new(settings));
        let worker = Arc::new(HeadlessWorker::start(node, worker)?);
        let broker = Arc::new(HeadlessBroker::new(worker, &state));
        let event_broker = broker.clone();
        let parser_broker = broker.clone();
        let setup_broker = broker.clone();
        let setup_settings = settings.clone();
        let journal = Arc::new(Mutex::new(super::event_journal::EventJournal::default()));
        let event_journal = journal.clone();
        let events = TerminalEvents::new(move |event, payload| {
            let id = payload
                .get("terminalId")
                .and_then(Value::as_str)
                .or_else(|| payload.as_str())
                .map(str::to_owned);
            if let Some(id) = id {
                if let Some(generation) =
                    event_broker.binding_generation(&id).map_err(String::from)?
                {
                    event_journal
                        .lock_or_err()?
                        .push(event, &id, generation, payload)
                        .map_err(String::from)?;
                }
            }
            event_broker.flush_bootstrap_replies().map_err(String::from)
        })
        .with_output_parser(move |id, delta| parser_broker.parse(id, delta).map_err(String::from))
        .with_parser_setup(move |id, generation, config| {
            let scheme = {
                let settings = setup_settings.lock_or_err()?;
                let name = settings
                    .profiles
                    .iter()
                    .find(|profile| profile.name == config.profile)
                    .map(|profile| profile.color_scheme.as_str())
                    .filter(|name| !name.is_empty())
                    .or_else(|| {
                        (!settings.profile_defaults.color_scheme.is_empty())
                            .then_some(settings.profile_defaults.color_scheme.as_str())
                    })
                    .unwrap_or("CampbellClear");
                Some(
                    settings
                        .color_schemes
                        .iter()
                        .find(|scheme| scheme.name == name)
                        .map(serde_json::to_value)
                        .transpose()
                        .map_err(|error| error.to_string())?
                        .unwrap_or_else(|| json!({"builtin":name})),
                )
            };
            setup_broker
                .prepare(id, generation, config.cols, config.rows, scheme)
                .map_err(String::from)
        });
        let incarnation = uuid::Uuid::new_v4().to_string();
        let writer = Arc::new(super::session_writer::SessionWriter::new(store)?);
        let service = Arc::new(Self {
            capability,
            scope,
            runtime,
            incarnation: incarnation.clone(),
            authority: tokio::sync::Mutex::new(AttachmentAuthority::new(incarnation)),
            controls: AtomicUsize::new(0),
            physical: Mutex::new(HashMap::new()),
            state,
            settings,
            broker,
            events,
            writer,
            lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            session_worker: Mutex::new(None),
            journal,
            #[cfg(test)]
            read_started: tokio::sync::Notify::new(),
            #[cfg(test)]
            session_read_delay: std::sync::atomic::AtomicU64::new(0),
            #[cfg(test)]
            session_commit_started: tokio::sync::Notify::new(),
        });
        service.start_session_writer()?;
        Ok(service)
    }

    pub(crate) async fn serve_connection(
        self: Arc<Self>,
        mut stream: impl AsyncRead + AsyncWrite + Unpin,
    ) -> Result<(), AppError> {
        let connection = uuid::Uuid::new_v4().to_string();
        let lifetime = ConnectionLifetime(Arc::new(AtomicBool::new(true)));
        let result = self
            .serve_inner(&mut stream, &connection, lifetime.0.clone())
            .await;
        // Transport loss revokes only this client's authority; terminal core,
        // parser and owned jobs remain alive. Never terminate PTYs here.
        self.authority.lock().await.disconnected(&connection);
        result
    }

    async fn serve_inner(
        self: &Arc<Self>,
        stream: &mut (impl AsyncRead + AsyncWrite + Unpin),
        connection: &str,
        live: Arc<AtomicBool>,
    ) -> Result<(), AppError> {
        let challenge = Challenge {
            protocol: PROTOCOL_VERSION,
            scope: self.scope.clone(),
            incarnation: self.incarnation.clone(),
            runtime: self.runtime.clone(),
            nonce: uuid::Uuid::new_v4().to_string(),
        };
        write_frame(stream, &challenge).await?;
        let authentication: Authentication = read_frame(stream).await?;
        self.capability.verify(&challenge, &authentication.proof)?;
        write_frame(
            stream,
            &Authentication {
                proof: self.capability.server_proof(&challenge)?,
            },
        )
        .await?;
        let mut last_request = 0;
        loop {
            let request: Request = read_frame(stream).await?;
            let response = match request {
                Request::CommitSession {
                    request_id,
                    stamp,
                    structure_revision,
                    snapshot,
                } => {
                    if request_id == 0 || request_id <= last_request {
                        return Err(AppError::Other(
                            "daemon session request sequence rejected".into(),
                        ));
                    }
                    last_request = request_id;
                    let outcome = self
                        .submit_session(stamp, structure_revision, *snapshot)
                        .await;
                    response(request_id, outcome)
                }
                Request::Read {
                    request_id,
                    stamp,
                    query,
                } => {
                    if request_id == 0 || request_id <= last_request {
                        return Err(AppError::Other(
                            "daemon read request sequence rejected".into(),
                        ));
                    }
                    last_request = request_id;
                    let admitted = self.authority.lock().await.validate(&stamp);
                    let outcome = match admitted {
                        Err(error) => Err(error),
                        Ok(()) => {
                            let result = self.execute_read(query).await;
                            // Observation finishing after detach is not evidence
                            // for a new GUI. Read I/O never retains the owner gate.
                            self.authority.lock().await.validate(&stamp).and(result)
                        }
                    };
                    response(request_id, outcome)
                }
                Request::Attach => {
                    let mut authority = self.authority.lock().await;
                    let stamp = if self.controls.load(Ordering::Acquire) != 0
                        || !self.physical.lock_or_err()?.is_empty()
                        || !crate::remote_server::human_control_operations_drained(&self.state)
                            .map_err(AppError::Other)?
                    {
                        Err(AppError::Other(
                            "daemon physical controls have not drained".into(),
                        ))
                    } else {
                        authority.attach_live(connection.into(), live.clone())
                    };
                    response(
                        0,
                        stamp
                            .and_then(|stamp| Ok(json!({"stamp":stamp,"catalog":self.catalog()?}))),
                    )
                }
                Request::Call {
                    request_id,
                    stamp,
                    command,
                } => {
                    if request_id == 0 || request_id <= last_request {
                        return Err(AppError::Other("daemon request sequence rejected".into()));
                    }
                    last_request = request_id;
                    let mut authority = self.authority.lock().await;
                    let admitted = if stamp.connection != connection {
                        Err(AppError::Other(
                            "daemon connection authority rejected".into(),
                        ))
                    } else {
                        authority.validate(&stamp)
                    };
                    let outcome = match admitted {
                        Err(error) => Err(error),
                        Ok(()) => match command {
                            Command::Detach => {
                                if self.controls.load(Ordering::Acquire) != 0
                                    || !self.physical.lock_or_err()?.is_empty()
                                    || !crate::remote_server::human_control_operations_drained(
                                        &self.state,
                                    )
                                    .map_err(AppError::Other)?
                                {
                                    Err(AppError::Other(
                                        "daemon physical controls have not drained".into(),
                                    ))
                                } else {
                                    authority.detach(&stamp).map(|_| json!({"detached":true}))
                                }
                            }
                            command => {
                                self.controls.fetch_add(1, Ordering::AcqRel);
                                let _control = ControlLifetime(self.clone());
                                drop(authority);
                                self.execute(command).await
                            }
                        },
                    };
                    response(request_id, outcome)
                }
            };
            write_frame(stream, &response).await?;
        }
    }

    fn catalog(&self) -> Result<Value, AppError> {
        let terminals = self.state.terminals.lock_or_err()?;
        let handles = self.state.pty_handles.lock_or_err()?;
        let mut entries = Vec::new();
        for (id, terminal) in terminals.iter() {
            if let Some(handle) = handles.get(id) {
                let mut session = serde_json::to_value(terminal)?;
                // Spawn-time env contains hook credentials; presentation never
                // needs them, even on the authenticated GUI transport.
                session["config"]["env"] = json!([]);
                entries.push(json!({"session":session,"generation":handle.terminal_generation(),"childPid":handle.child_pid()}));
            }
        }
        Ok(json!(entries))
    }

    fn verify_generation(&self, id: &str, generation: u64) -> Result<(), AppError> {
        let handles = self.state.pty_handles.lock_or_err()?;
        let handle = handles
            .get(id)
            .ok_or_else(|| AppError::SessionNotFound(id.into()))?;
        if handle.terminal_generation() != generation {
            return Err(AppError::Other(
                "daemon terminal generation rejected".into(),
            ));
        }
        Ok(())
    }

    fn admit_geometry(&self, id: &str, cols: u16, rows: u16) -> Result<(), AppError> {
        let terminals = self.state.terminals.lock_or_err()?;
        let requested = usize::from(cols) * usize::from(rows) * 2;
        let existing: usize = terminals
            .iter()
            .filter(|(other, _)| other.as_str() != id)
            .map(|(_, terminal)| {
                usize::from(terminal.config.cols) * usize::from(terminal.config.rows) * 2
            })
            .sum();
        if requested.saturating_add(existing) > MAX_SCREEN_CELLS {
            return Err(AppError::Other(
                "daemon screen memory capacity exceeded".into(),
            ));
        }
        Ok(())
    }
}

#[path = "service_commands.rs"]
mod commands;
#[path = "service_session.rs"]
mod sessions;

#[path = "service_physical.rs"]
mod physical;

fn response(request_id: u64, result: Result<Value, AppError>) -> Response {
    match result {
        Ok(result) => Response {
            request_id,
            result: Some(result),
            error: None,
        },
        Err(error) => Response {
            request_id,
            result: None,
            error: Some(error.to_string()),
        },
    }
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;

#[path = "service_reads.rs"]
mod reads;
