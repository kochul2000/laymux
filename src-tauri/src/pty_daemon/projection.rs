//! GUI presentation of a daemon-owned terminal. No parser/business OSC replay.
use super::gateway::DaemonGateway;
use super::requests::{Command, CreateTerminal, ReadCommand};
use crate::constants::{
    EVENT_TERMINAL_DAEMON_RESYNC, TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES,
    TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES,
};
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use crate::terminal::TerminalSession;
use crate::terminal_output::{
    self, DaemonSurfaceCheckpoint, DesktopTerminalOutputAttachment, TerminalGeometry,
};
use base64::Engine;
use serde::Deserialize;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub(super) struct Projection {
    native_generation: u64,
    attach: tokio::sync::Mutex<()>,
    epoch: AtomicU64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogEntry {
    session: TerminalSession,
    generation: u64,
}

impl DaemonGateway {
    pub(crate) fn source_cwds(&self) -> Result<std::collections::HashMap<String, String>, String> {
        let catalog: Vec<CatalogEntry> =
            serde_json::from_value(self.read_blocking(ReadCommand::Catalog)?)
                .map_err(|error| format!("daemon CWD catalog rejected: {error}"))?;
        Ok(catalog
            .into_iter()
            .filter_map(|entry| entry.session.cwd.map(|cwd| (entry.session.id, cwd)))
            .collect())
    }

    pub(crate) async fn source_checkpoint(&self, id: &str) -> Result<Value, String> {
        let generation = self
            .projections
            .lock_or_err()?
            .get(id)
            .map(|projection| projection.native_generation)
            .ok_or_else(|| format!("daemon terminal '{id}' unavailable"))?;
        self.read(ReadCommand::Checkpoint {
            terminal_id: id.into(),
            generation,
        })
        .await
    }
    pub(crate) async fn create_mirror(
        self: &Arc<Self>,
        state: &Arc<AppState>,
        spec: CreateTerminal,
    ) -> Result<TerminalSession, String> {
        self.wait_ready().await?;
        let id = spec.id.clone();
        if state.terminals.lock_or_err()?.contains_key(&id) {
            return Err(format!("Session '{id}' already exists"));
        }
        let mut catalog: Vec<CatalogEntry> =
            serde_json::from_value(self.read(ReadCommand::Catalog).await?)
                .map_err(|error| error.to_string())?;
        let entry = if let Some(index) = catalog.iter().position(|entry| entry.session.id == id) {
            catalog.swap_remove(index)
        } else {
            self.call(Command::Configure {
                settings: Box::new(crate::settings::load_settings()),
            })
            .await?;
            self.call(Command::Create { spec }).await?;
            let catalog: Vec<CatalogEntry> =
                serde_json::from_value(self.read(ReadCommand::Catalog).await?)
                    .map_err(|error| error.to_string())?;
            catalog
                .into_iter()
                .find(|entry| entry.session.id == id)
                .ok_or_else(|| "created daemon terminal is absent from catalog".to_string())?
        };
        if entry.generation == 0 {
            return Err("daemon terminal generation unavailable".into());
        }
        let result: TerminalSession = serde_json::from_value(
            serde_json::to_value(&entry.session).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        // This mirror contains no native child PID, OS master or child killer.
        let handle = crate::pty::PtyHandle::from_external(
            entry.generation,
            self.physical_executor(id.clone(), entry.generation),
        )?;
        let mut terminals = state.terminals.lock_or_err()?;
        if terminals.contains_key(&id) {
            return Err(format!("Session '{id}' already exists"));
        }
        state.pty_handles.lock_or_err()?.insert(id.clone(), handle);
        self.projections.lock_or_err()?.insert(
            id.clone(),
            Arc::new(Projection {
                native_generation: entry.generation,
                attach: tokio::sync::Mutex::new(()),
                epoch: AtomicU64::new(0),
            }),
        );
        terminals.insert(id, entry.session);
        Ok(result)
    }

    pub(crate) async fn attach_surface(
        self: &Arc<Self>,
        state: &Arc<AppState>,
        app: &AppHandle,
        id: &str,
    ) -> Result<DesktopTerminalOutputAttachment, String> {
        let projection = self
            .projections
            .lock_or_err()?
            .get(id)
            .cloned()
            .ok_or_else(|| format!("daemon terminal '{id}' unavailable"))?;
        let _attach = projection.attach.lock().await;
        let pump_projection = projection.clone();
        let checkpoint = self
            .read(ReadCommand::Checkpoint {
                terminal_id: id.into(),
                generation: projection.native_generation,
            })
            .await?;
        let (geometry, serialized, metadata) = parse_checkpoint(
            &checkpoint,
            self.incarnation()?,
            projection.native_generation,
        )?;
        let epoch = projection.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        if let Some(old) =
            terminal_output::terminal_output_session_for(&state.terminal_protocol_states, id)?
        {
            terminal_output::retire_terminal_output_session(
                &state.terminal_protocol_states,
                &state.output_buffers,
                id,
                &old,
            )?;
        }
        let registration = terminal_output::register_terminal_output_session_with_geometry(
            &state.terminal_protocol_states,
            &state.output_buffers,
            id,
            geometry,
        )?;
        let session = registration.session();
        session.record_output(serialized.as_bytes())?;
        let emitter = app.clone();
        session.start_desktop_output_delivery(Arc::new(move |event, envelope| {
            emitter
                .emit(event, envelope)
                .map_err(|error| error.to_string())
        }))?;
        registration.commit()?;
        let mut attached = terminal_output::attach_desktop_terminal_output(
            &state.terminal_protocol_states,
            id,
            TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES,
            TERMINAL_OUTPUT_DESKTOP_FLOW_WINDOW_BYTES,
        )?;
        attached.attachment.state.snapshot_kind = terminal_output::TerminalSnapshotKind::Screen;
        // Local delivery byte sequence names the projection, independently of
        // metadata.source_seq (the real PTY stream prefix).
        attached.daemon = Some(metadata.clone());
        // Bind binary/protocol-reply admission to this delivery generation;
        // its executor remains bound to the actual daemon PTY generation.
        state
            .pty_handles
            .lock_or_err()?
            .get(id)
            .ok_or_else(|| format!("daemon terminal '{id}' mirror unavailable"))?
            .bind_delivery_generation(session.generation());
        let gateway = self.clone();
        let weak_state = Arc::downgrade(state);
        let app = app.clone();
        let id = id.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let outcome = pump(
                &gateway,
                &pump_projection,
                epoch,
                &weak_state,
                &id,
                &session,
                metadata.source_seq,
                geometry.revision,
            );
            if let Err(error) = outcome {
                if pump_projection.epoch.load(Ordering::Acquire) == epoch {
                    tracing::warn!(terminal_id=%id, %error, "daemon presentation requires a fresh checkpoint");
                    let _ = app.emit(
                        EVENT_TERMINAL_DAEMON_RESYNC,
                        serde_json::json!({"terminalId":id,"generation":session.generation()}),
                    );
                }
            }
        });
        Ok(attached)
    }

    pub(crate) async fn close_source(&self, id: &str) -> Result<(), String> {
        let projection = self
            .projections
            .lock_or_err()?
            .get(id)
            .cloned()
            .ok_or_else(|| format!("daemon terminal '{id}' unavailable"))?;
        self.call(Command::Close {
            terminal_id: id.into(),
            generation: projection.native_generation,
        })
        .await?;
        projection.epoch.fetch_add(1, Ordering::AcqRel);
        self.projections.lock_or_err()?.remove(id);
        Ok(())
    }

    pub(crate) fn close_source_blocking(&self, id: &str) -> Result<(), String> {
        let projection = self
            .projections
            .lock_or_err()?
            .get(id)
            .cloned()
            .ok_or_else(|| format!("daemon terminal '{id}' unavailable"))?;
        self.call_blocking(
            Command::Close {
                terminal_id: id.into(),
                generation: projection.native_generation,
            },
            std::time::Instant::now() + std::time::Duration::from_secs(10),
        )?;
        projection.epoch.fetch_add(1, Ordering::AcqRel);
        self.projections.lock_or_err()?.remove(id);
        Ok(())
    }
}

fn parse_checkpoint(
    value: &Value,
    incarnation: String,
    generation: u64,
) -> Result<(TerminalGeometry, String, DaemonSurfaceCheckpoint), String> {
    if value["generation"].as_u64() != Some(generation) {
        return Err("daemon checkpoint generation mismatch".into());
    }
    let integer = |field: &str| {
        value[field]
            .as_u64()
            .filter(|number| *number <= 9_007_199_254_740_991)
            .ok_or_else(|| format!("invalid daemon checkpoint {field}"))
    };
    let cols = u16::try_from(integer("cols")?).map_err(|_| "daemon checkpoint columns overflow")?;
    let rows = u16::try_from(integer("rows")?).map_err(|_| "daemon checkpoint rows overflow")?;
    if cols == 0 || rows == 0 || cols > 4096 || rows > 4096 {
        return Err("daemon checkpoint geometry unavailable".into());
    }
    let serialized = value["serialized"]
        .as_str()
        .ok_or("daemon checkpoint snapshot unavailable")?
        .to_string();
    if serialized.len() > TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES {
        return Err("daemon checkpoint exceeds presentation budget".into());
    }
    let pending_bytes: Vec<u8> = serde_json::from_value(value["pendingBytes"].clone())
        .map_err(|_| "daemon checkpoint pending bytes rejected")?;
    if pending_bytes.len() > TERMINAL_ATTACH_SNAPSHOT_MAX_BYTES || !value["parserState"].is_object()
    {
        return Err("daemon checkpoint parser state rejected".into());
    }
    Ok((
        TerminalGeometry {
            cols,
            rows,
            revision: integer("geometryRevision")?,
        },
        serialized,
        DaemonSurfaceCheckpoint {
            version: 1,
            incarnation,
            native_generation: generation,
            source_seq: integer("sourceSeq")?,
            pending_bytes,
            parser_state: value["parserState"].clone(),
        },
    ))
}

fn pump(
    gateway: &DaemonGateway,
    projection: &Projection,
    epoch: u64,
    state: &std::sync::Weak<AppState>,
    id: &str,
    session: &Arc<terminal_output::TerminalOutputSession>,
    mut source_seq: u64,
    geometry_revision: u64,
) -> Result<(), String> {
    loop {
        if projection.epoch.load(Ordering::Acquire) != epoch
            || state.upgrade().is_none()
            || session.is_terminal_output_retired()
        {
            return Ok(());
        }
        session.wait_for_desktop_output_capacity(session.output_buffer().write_seq()?)?;
        if projection.epoch.load(Ordering::Acquire) != epoch {
            return Ok(());
        }
        let value = gateway.read_blocking(ReadCommand::Output {
            terminal_id: id.into(),
            generation: projection.native_generation,
            since_seq: Some(source_seq),
            geometry_revision: Some(geometry_revision),
        })?;
        if value["type"] != "delta"
            || value["generation"].as_u64() != Some(projection.native_generation)
            || value["sourceStartSeq"].as_u64() != Some(source_seq)
        {
            return Err("daemon source prefix requires checkpoint replacement".into());
        }
        let end = value["sourceSeq"]
            .as_u64()
            .ok_or("daemon source end sequence rejected")?;
        let data = base64::engine::general_purpose::STANDARD
            .decode(
                value["data"]
                    .as_str()
                    .ok_or("daemon source bytes rejected")?,
            )
            .map_err(|_| "daemon source base64 rejected")?;
        if end.checked_sub(source_seq) != Some(data.len() as u64) {
            return Err("daemon source sequence range rejected".into());
        }
        if projection.epoch.load(Ordering::Acquire) != epoch {
            return Ok(());
        }
        if !data.is_empty() {
            session
                .record_desktop_output(&data)
                .map_err(|error| error.to_string())?;
        }
        source_seq = end;
        if data.is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}
