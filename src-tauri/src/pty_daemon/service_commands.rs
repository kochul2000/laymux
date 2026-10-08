use super::*;

impl DaemonService {
    pub(super) async fn execute(self: &Arc<Self>, command: Command) -> Result<Value, AppError> {
        let origin = crate::remote_server::HumanControlOrigin::Local;
        match command {
            Command::TerminalOptions {
                terminal_id,
                generation,
                sync_group,
                cwd_send,
                cwd_receive,
            } => {
                let _lifecycle = self.lifecycle.lock().await;
                self.verify_generation(&terminal_id, generation)?;
                crate::commands::set_terminal_options_inner(
                    &self.state,
                    &terminal_id,
                    sync_group,
                    cwd_send,
                    cwd_receive,
                )
                .map_err(AppError::Other)?;
                Ok(json!({"applied":true}))
            }
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
                let _lifecycle = self.lifecycle.lock().await;
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
                let _lifecycle = self.lifecycle.lock().await;
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
}
