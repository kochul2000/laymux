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
    #[cfg(test)]
    read_started: tokio::sync::Notify,
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
    ) -> Result<Arc<Self>, AppError> {
        let state = Arc::new(AppState::from_settings(settings.clone()));
        let settings = Arc::new(Mutex::new(settings));
        let worker = Arc::new(HeadlessWorker::start(node, worker)?);
        let broker = Arc::new(HeadlessBroker::new(worker, &state));
        let event_broker = broker.clone();
        let parser_broker = broker.clone();
        let setup_broker = broker.clone();
        let setup_settings = settings.clone();
        let events = TerminalEvents::new(move |_, _| {
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
        Ok(Arc::new(Self {
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
            #[cfg(test)]
            read_started: tokio::sync::Notify::new(),
        }))
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
                                if !self.physical.lock_or_err()?.is_empty()
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

    async fn execute(self: &Arc<Self>, command: Command) -> Result<Value, AppError> {
        let origin = crate::remote_server::HumanControlOrigin::Local;
        match command {
            Command::Configure { settings } => {
                *self.settings.lock_or_err()? = *settings;
                Ok(json!({"configured":true}))
            }
            Command::Physical {
                operation_id,
                terminal_id,
                generation,
                expires_at,
                action,
            } => {
                if uuid::Uuid::parse_str(&operation_id).is_err() {
                    return Err(AppError::Other(
                        "daemon physical operation identity rejected".into(),
                    ));
                }
                let cancelled = Arc::new(AtomicBool::new(false));
                {
                    let mut operations = self.physical.lock_or_err()?;
                    if operations.contains_key(&operation_id) {
                        return Err(AppError::Other(
                            "daemon physical operation already exists".into(),
                        ));
                    }
                    operations.insert(operation_id.clone(), cancelled.clone());
                }
                let operation = PhysicalLifetime {
                    service: self.clone(),
                    id: operation_id,
                };
                let source = self.clone();
                tokio::task::spawn_blocking(move || {
                    let _operation = operation;
                    source.execute_physical(terminal_id, generation, expires_at, action, cancelled)
                })
                .await
                .map_err(|_| AppError::Other("daemon physical control worker failed".into()))?
            }
            Command::Ping => Ok(json!({"incarnation":self.incarnation})),
            Command::Catalog => self.catalog(),
            Command::Create { spec } => {
                self.broker.ensure_healthy(&spec.id, 0)?;
                if spec.id.is_empty()
                    || spec.id.len() > 512
                    || spec.cols == 0
                    || spec.rows == 0
                    || spec.cols > 4096
                    || spec.rows > 4096
                {
                    return Err(AppError::Other(
                        "daemon terminal specification rejected".into(),
                    ));
                }
                self.admit_geometry(&spec.id, spec.cols, spec.rows)?;
                let settings = self.settings.lock_or_err()?.clone();
                let id = spec.id.clone();
                let previous_parser = self.broker.binding_generation(&id)?;
                let created = crate::commands::create_terminal_session_core(
                    spec.id,
                    spec.profile,
                    spec.cols,
                    spec.rows,
                    spec.sync_group,
                    spec.cwd_send,
                    spec.cwd_receive,
                    spec.cwd,
                    spec.startup_command_override,
                    spec.viewer,
                    self.state.clone(),
                    self.events.clone(),
                    settings,
                )
                .await;
                let session = match created {
                    Ok(session) => session,
                    Err(error) => {
                        if let Some(generation) = self.broker.binding_generation(&id)? {
                            if Some(generation) != previous_parser {
                                self.broker.dispose(&id, generation)?;
                            }
                        }
                        return Err(AppError::Other(error));
                    }
                };
                let generation = self
                    .state
                    .pty_handles
                    .lock_or_err()?
                    .get(&session.id)
                    .map(|handle| handle.terminal_generation())
                    .ok_or_else(|| AppError::SessionNotFound(session.id.clone()))?;
                if let Err(error) = self.broker.ensure_healthy(&session.id, generation) {
                    let _ = crate::commands::close_terminal_session_inner(
                        &session.id,
                        &self.state,
                        &self.events,
                    );
                    let _ = self.broker.dispose(&session.id, generation);
                    return Err(error);
                }
                Ok(json!({"id":session.id,"generation":generation}))
            }
            Command::Write {
                terminal_id,
                generation,
                data,
            } => {
                self.verify_generation(&terminal_id, generation)?;
                self.broker.ensure_healthy(&terminal_id, generation)?;
                if data.len() > 1024 * 1024 {
                    return Err(AppError::Other("daemon input size rejected".into()));
                }
                crate::commands::write_to_terminal_inner(&self.state, &terminal_id, &data, origin)
                    .map_err(AppError::Other)?;
                Ok(json!({"written":data.len()}))
            }
            Command::Resize {
                terminal_id,
                generation,
                cols,
                rows,
            } => {
                self.verify_generation(&terminal_id, generation)?;
                self.broker.ensure_healthy(&terminal_id, generation)?;
                if cols > 4096 || rows > 4096 {
                    return Err(AppError::Other("daemon terminal geometry rejected".into()));
                }
                self.admit_geometry(&terminal_id, cols, rows)?;
                crate::commands::resize_terminal_inner(
                    &self.state,
                    &terminal_id,
                    cols,
                    rows,
                    origin,
                )
                .map_err(AppError::Other)?;
                let target = crate::terminal_output::terminal_render_checkpoint_target(
                    &self.state.terminal_protocol_states,
                    &terminal_id,
                )
                .map_err(AppError::Other)?;
                self.broker
                    .resize_at(&terminal_id, generation, target.seq, target.geometry)?;
                Ok(json!({"resized":true}))
            }
            Command::Checkpoint {
                terminal_id,
                generation,
            } => {
                self.verify_generation(&terminal_id, generation)?;
                self.broker.checkpoint(&terminal_id, generation)
            }
            Command::Close {
                terminal_id,
                generation,
            } => {
                self.verify_generation(&terminal_id, generation)?;
                crate::commands::close_terminal_session_inner(
                    &terminal_id,
                    &self.state,
                    &self.events,
                )
                .map_err(AppError::Other)?;
                if let Err(error) = self.broker.dispose(&terminal_id, generation) {
                    tracing::warn!(%error, "closed terminal parser cleanup failed");
                }
                Ok(json!({"closed":true}))
            }
            Command::Detach => Err(AppError::Other(
                "daemon detach requires attachment authority".into(),
            )),
        }
    }

    async fn execute_read(&self, query: ReadCommand) -> Result<Value, AppError> {
        match query {
            ReadCommand::CancelPhysical { operation_id } => {
                let operations = self.physical.lock_or_err()?;
                let cancelled = operations.get(&operation_id).is_some_and(|operation| {
                    operation.store(true, Ordering::Release);
                    true
                });
                Ok(json!({"cancelled":cancelled}))
            }
            ReadCommand::Ping => Ok(json!({"incarnation":self.incarnation})),
            ReadCommand::Catalog => self.catalog(),
            ReadCommand::Drained => Ok(
                json!({"drained":self.physical.lock_or_err()?.is_empty() && crate::remote_server::human_control_operations_drained(&self.state).map_err(AppError::Other)?}),
            ),
            ReadCommand::Output {
                terminal_id,
                generation,
                since_seq,
                geometry_revision,
            } => {
                self.verify_generation(&terminal_id, generation)?;
                self.broker.ensure_healthy(&terminal_id, generation)?;
                let target = crate::terminal_output::terminal_render_checkpoint_target(
                    &self.state.terminal_protocol_states,
                    &terminal_id,
                )
                .map_err(AppError::Other)?;
                if let Some(seq) =
                    since_seq.filter(|_| geometry_revision == Some(target.geometry.revision))
                {
                    let buffer = self
                        .state
                        .output_buffers
                        .lock_or_err()?
                        .get(&terminal_id)
                        .cloned()
                        .ok_or_else(|| AppError::SessionNotFound(terminal_id.clone()))?;
                    if let Some(mut delta) = buffer.delta_since(seq)? {
                        delta.data.truncate(64 * 1024);
                        delta.seq_end = delta.seq_start + delta.data.len() as u64;
                        return Ok(
                            json!({"type":"delta","generation":generation,"sourceStartSeq":delta.seq_start,"sourceSeq":delta.seq_end,"data":base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &delta.data),"geometry":target.geometry}),
                        );
                    }
                }
                let broker = self.broker.clone();
                let mut checkpoint = tokio::task::spawn_blocking(move || {
                    broker.checkpoint(&terminal_id, generation)
                })
                .await
                .map_err(|_| AppError::Other("daemon output checkpoint worker failed".into()))??;
                checkpoint["type"] = json!("checkpoint");
                Ok(checkpoint)
            }
            ReadCommand::Checkpoint {
                terminal_id,
                generation,
            } => {
                self.verify_generation(&terminal_id, generation)?;
                let broker = self.broker.clone();
                tokio::task::spawn_blocking(move || broker.checkpoint(&terminal_id, generation))
                    .await
                    .map_err(|_| AppError::Other("daemon checkpoint worker failed".into()))?
            }
            ReadCommand::Attributions {
                claude_max_age_hours,
                codex_max_age_hours,
                grok_max_age_hours,
            } => {
                let state = self.state.clone();
                tokio::task::spawn_blocking(move || {
                    let result = crate::commands::get_terminal_session_attributions_impl(
                        claude_max_age_hours,
                        codex_max_age_hours,
                        grok_max_age_hours,
                        &state,
                    )
                    .map_err(AppError::Other)?;
                    Ok(serde_json::to_value(result)?)
                })
                .await
                .map_err(|_| AppError::Other("daemon attribution worker failed".into()))?
            }
            #[cfg(test)]
            ReadCommand::Delay { milliseconds } => {
                self.read_started.notify_one();
                tokio::time::sleep(std::time::Duration::from_millis(milliseconds)).await;
                Ok(json!({"observed":true}))
            }
        }
    }
}

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
