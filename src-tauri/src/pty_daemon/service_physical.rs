use super::*;

impl DaemonService {
    pub(super) fn execute_physical(
        &self,
        id: String,
        generation: u64,
        expiry: u64,
        action: PhysicalAction,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Value, AppError> {
        let requested_deadline = crate::daemon_clock::import_deadline(expiry)?;
        self.verify_generation(&id, generation)?;
        self.broker.ensure_healthy(&id, generation)?;
        let handle = self
            .state
            .pty_handles
            .lock_or_err()?
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::SessionNotFound(id.clone()))?;
        let permit = crate::remote_server::begin_human_control_operation(
            &self.state,
            crate::remote_server::HumanControlOrigin::Local,
            &id,
        )
        .map_err(AppError::Other)?;
        let deadline = requested_deadline.min(permit.deadline());
        if cancelled.load(Ordering::Acquire) || std::time::Instant::now() >= deadline {
            return Err(AppError::Other(
                "daemon control deadline expired before enqueue".into(),
            ));
        }
        let pending = match action {
            PhysicalAction::Write { data, submit } => {
                if data.len() > 1024 * 1024 {
                    return Err(AppError::Other("daemon input size rejected".into()));
                }
                permit
                    .enqueue_pty_job(|| {
                        if cancelled.load(Ordering::Acquire)
                            || std::time::Instant::now() >= deadline
                        {
                            return Err(
                                "daemon control deadline expired before input enqueue".into()
                            );
                        }
                        handle.enqueue_write(&data, submit, deadline)
                    })
                    .map_err(AppError::Other)?
            }
            PhysicalAction::Resize { cols, rows } => {
                if cols == 0 || rows == 0 || cols > 4096 || rows > 4096 {
                    return Err(AppError::Other("daemon geometry rejected".into()));
                }
                self.admit_geometry(&id, cols, rows)?;
                permit.ensure_current().map_err(AppError::Other)?;
                if std::time::Instant::now() >= deadline {
                    return Err(AppError::Other(
                        "daemon control deadline expired before resize".into(),
                    ));
                }
                {
                    let mut terminals = self.state.terminals.lock_or_err()?;
                    let session = terminals
                        .get_mut(&id)
                        .ok_or_else(|| AppError::SessionNotFound(id.clone()))?;
                    if (session.config.cols, session.config.rows) == (cols, rows) {
                        permit.finish().map_err(AppError::Other)?;
                        return Ok(json!({"completed":true}));
                    }
                    session.config.cols = cols;
                    session.config.rows = rows;
                }
                crate::terminal_output::update_terminal_output_geometry(
                    &self.state.terminal_protocol_states,
                    &id,
                    cols,
                    rows,
                )
                .map_err(AppError::Other)?;
                permit
                    .enqueue_pty_job(|| handle.enqueue_resize(cols, rows, deadline))
                    .map_err(AppError::Other)?
            }
        };
        let result = handle.await_enqueued_control_job(pending, deadline, || {
            !cancelled.load(Ordering::Acquire) && permit.is_current()
        });
        crate::commands::finish_human_control_io(permit, &handle, result)
            .map_err(AppError::Other)?;
        let target = crate::terminal_output::terminal_render_checkpoint_target(
            &self.state.terminal_protocol_states,
            &id,
        )
        .map_err(AppError::Other)?;
        self.broker
            .resize_at(&id, generation, target.seq, target.geometry)?;
        Ok(json!({"completed":true}))
    }
}
