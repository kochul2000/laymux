use super::*;

impl DaemonService {
    pub(super) async fn execute_read(&self, query: ReadCommand) -> Result<Value, AppError> {
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
            ReadCommand::SessionState => Ok(serde_json::to_value(self.writer.load()?)?),
            ReadCommand::SessionDiagnostics => self.writer.diagnostics(),
            ReadCommand::CaptureReceipt => {
                let state = self.state.clone();
                tokio::task::spawn_blocking(move || {
                    serde_json::to_value(
                        crate::session_checkpoint::receipt::capture(&state)
                            .map_err(AppError::Other)?,
                    )
                    .map_err(AppError::from)
                })
                .await
                .map_err(|_| AppError::Other("source receipt capture worker failed".into()))?
            }
            ReadCommand::CommitReceipt {
                token,
                coverage,
                checkpoint_revision,
            } => {
                let state = self.state.clone();
                let store = self.writer.store();
                tokio::task::spawn_blocking(move || {
                    let receipt = crate::session_checkpoint::receipt::commit_to_revision(
                        &state,
                        &token,
                        &coverage,
                        &crate::settings::settings_path(),
                        Some(checkpoint_revision),
                        &store,
                    )
                    .map_err(AppError::Other)?;
                    serde_json::to_value(receipt).map_err(AppError::from)
                })
                .await
                .map_err(|_| AppError::Other("source receipt commit worker failed".into()))?
            }
            ReadCommand::TerminalStates => {
                let state = self.state.clone();
                tokio::task::spawn_blocking(move || {
                    serde_json::to_value(crate::activity::detect_all_terminal_states(&state)?)
                        .map_err(AppError::from)
                })
                .await
                .map_err(|_| AppError::Other("daemon terminal state worker failed".into()))?
            }
            ReadCommand::BusinessEvents { since } => {
                let mut result = self.journal.lock_or_err()?.read(since)?;
                if result["reset"] == true {
                    result["catalog"] = self.catalog()?;
                }
                Ok(result)
            }
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
