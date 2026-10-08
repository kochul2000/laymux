use super::*;
use crate::local_state::LocalSessionSnapshot;
use crate::pty_daemon::session_projection::Observation;
use std::time::Duration;

async fn observation(source: Arc<DaemonService>) -> Result<Observation, AppError> {
    tokio::time::timeout(
        crate::daemon_protocol::SESSION_OBSERVATION_DEADLINE,
        tokio::task::spawn_blocking(move || {
            let default_profile = source.settings.lock_or_err()?.default_profile.clone();
            Observation::collect(&source.state, default_profile)
        }),
    )
    .await
    .map_err(|_| AppError::Other("daemon session observation timed out".into()))?
    .map_err(|_| AppError::Other("daemon session observation worker failed".into()))?
}

impl DaemonService {
    pub(super) async fn submit_session(
        self: &Arc<Self>,
        stamp: crate::daemon_protocol::AttachmentStamp,
        revision: u64,
        snapshot: LocalSessionSnapshot,
    ) -> Result<Value, AppError> {
        let lease = self.authority.lock().await.lease(&stamp)?;
        let ticket = self.writer.reserve(&stamp, revision)?;
        let mut reservation = Reservation {
            writer: self.writer.clone(),
            ticket,
            error: None,
        };
        let outcome = async {
            // Slow provider reads neither retain the owner gate nor occupy the
            // ordered human-control RPC. Detach invalidates their result.
            let observed = tokio::select! {
                result = async {
                    #[cfg(test)]
                    {
                        let delay = self.session_read_delay.load(Ordering::Acquire);
                        if delay > 0 {
                            self.read_started.notify_one();
                            tokio::time::sleep(Duration::from_millis(delay)).await;
                        }
                    }
                    observation(self.clone()).await
                } => result?,
                _ = async {
                    while lease.load(Ordering::Acquire) { tokio::time::sleep(Duration::from_millis(25)).await; }
                } => return Err(AppError::Other("daemon session owner disconnected".into())),
            };
            let lifecycle = self.lifecycle.clone().lock_owned().await;
            {
                let authority = self.authority.lock().await;
                authority.validate(&stamp)?;
                self.controls.fetch_add(1, Ordering::AcqRel);
            }
            let control = ControlLifetime(self.clone());
            let writer = self.writer.clone();
            let state = self.state.clone();
            let commit = tokio::task::spawn_blocking(move || {
                let _lifecycle = lifecycle;
                let _control = control;
                #[cfg(test)]
                _control.0.session_commit_started.notify_one();
                if !lease.load(Ordering::Acquire) { return Err(AppError::Other("daemon session owner disconnected".into())); }
                writer.commit(&state, ticket, snapshot, observed)
            }).await.map_err(|_| AppError::Other("daemon session commit worker failed".into()))??;
            if commit.needs_retry { self.state.session_checkpoint.hints.request_retry(); }
            self.authority.lock().await.validate(&stamp)?;
            Ok(serde_json::to_value(commit)?)
        }.await;
        reservation.error = outcome.as_ref().err().map(ToString::to_string);
        outcome
    }

    pub(super) async fn refresh_session(self: &Arc<Self>) -> Result<bool, String> {
        let Some((version, snapshot)) = self.writer.background_base().map_err(String::from)? else {
            return Ok(true);
        };
        let observed = observation(self.clone()).await.map_err(String::from)?;
        let lifecycle = self.lifecycle.clone().lock_owned().await;
        let source = self.clone();
        tokio::task::spawn_blocking(move || {
            let _lifecycle = lifecycle;
            match source
                .writer
                .refresh(&source.state, version, snapshot, observed)
            {
                Ok(confirmed) => Ok(confirmed),
                Err(error) => {
                    source.writer.background_error(&error);
                    Err(String::from(error))
                }
            }
        })
        .await
        .map_err(|_| "daemon background session writer failed".to_string())?
    }
}

struct Reservation {
    writer: Arc<crate::pty_daemon::session_writer::SessionWriter>,
    ticket: crate::pty_daemon::session_writer::Ticket,
    error: Option<String>,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.writer.finish(self.ticket, self.error.take());
    }
}
impl DaemonService {
    pub(super) fn start_session_writer(self: &Arc<Self>) -> Result<(), AppError> {
        let source = Arc::downgrade(self);
        let finalizing = source.clone();
        let hints = self.state.session_checkpoint.hints.clone();
        let task = tokio::spawn(async move {
            crate::session_checkpoint::hints::run(
                &hints,
                || {
                    finalizing
                        .upgrade()
                        .is_some_and(|source| source.state.session_checkpoint.is_finalizing())
                },
                |_| {
                    let source = source.clone();
                    async move {
                        let Some(source) = source.upgrade() else {
                            return Ok(true);
                        };
                        source.refresh_session().await
                    }
                },
                crate::session_checkpoint::hints::Timing::for_daemon(),
            )
            .await;
        });
        *self.session_worker.lock_or_err()? = Some(task.abort_handle());
        Ok(())
    }
}
impl Drop for DaemonService {
    fn drop(&mut self) {
        if let Ok(worker) = self.session_worker.lock_or_err() {
            if let Some(worker) = worker.as_ref() {
                worker.abort();
            }
        }
    }
}
