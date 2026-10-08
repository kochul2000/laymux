//! Live parser ownership; GUI subscribers are independent presentation mirrors.
use crate::error::AppError;
use crate::headless_worker::HeadlessWorker;
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use crate::terminal_output::{TerminalGeometry, TerminalOutputDelta};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

struct ScreenBinding {
    generation: u64,
    cols: u16,
    rows: u16,
    seq: u64,
    geometry_revision: u64,
    pending_resizes: std::collections::VecDeque<(u64, TerminalGeometry)>,
    pending_replies: Vec<Vec<u8>>,
}

pub(crate) struct HeadlessBroker {
    worker: Arc<HeadlessWorker>,
    state: Weak<AppState>,
    screens: Mutex<HashMap<String, ScreenBinding>>,
    faults: Mutex<HashMap<String, (u64, String)>>,
}

impl HeadlessBroker {
    pub(crate) fn prepare(
        &self,
        id: &str,
        generation: u64,
        cols: u16,
        rows: u16,
        scheme: Option<Value>,
    ) -> Result<(), AppError> {
        self.worker.ensure_healthy()?;
        let mut screens = self.screens.lock_or_err()?;
        if let Some(old) = screens.get(id) {
            if old.generation == generation {
                return Err(AppError::Other(
                    "headless terminal is already prepared".into(),
                ));
            }
            self.worker.request(
                json!({"operation":"dispose","terminalId":id,"generation":old.generation}),
            )?;
            screens.remove(id);
        }
        self.worker.request(json!({"operation":"create","terminalId":id,"generation":generation,"cols":cols,"rows":rows,"scheme":scheme}))?;
        screens.insert(
            id.into(),
            ScreenBinding {
                generation,
                cols,
                rows,
                seq: 0,
                geometry_revision: 0,
                pending_resizes: std::collections::VecDeque::new(),
                pending_replies: Vec::new(),
            },
        );
        Ok(())
    }

    pub(crate) fn binding_generation(&self, id: &str) -> Result<Option<u64>, AppError> {
        Ok(self
            .screens
            .lock_or_err()?
            .get(id)
            .map(|screen| screen.generation))
    }

    pub(crate) fn resize_at(
        &self,
        id: &str,
        generation: u64,
        seq: u64,
        geometry: TerminalGeometry,
    ) -> Result<(), AppError> {
        self.ensure_healthy(id, generation)?;
        let mut screens = self.screens.lock_or_err()?;
        let screen = screens
            .get_mut(id)
            .filter(|screen| screen.generation == generation)
            .ok_or_else(|| AppError::Other("headless resize generation unavailable".into()))?;
        if screen.seq >= seq {
            self.apply_geometry(id, screen, geometry)
        } else {
            if screen.pending_resizes.len() >= 128 {
                return Err(AppError::Other(
                    "headless resize boundary capacity exceeded".into(),
                ));
            }
            screen.pending_resizes.push_back((seq, geometry));
            Ok(())
        }
    }

    fn apply_geometry(
        &self,
        id: &str,
        screen: &mut ScreenBinding,
        geometry: TerminalGeometry,
    ) -> Result<(), AppError> {
        if geometry.revision < screen.geometry_revision {
            return Ok(());
        }
        if (screen.cols, screen.rows) != (geometry.cols, geometry.rows) {
            self.worker.request(json!({"operation":"resize","terminalId":id,"generation":screen.generation,"cols":geometry.cols,"rows":geometry.rows}))?;
            screen.cols = geometry.cols;
            screen.rows = geometry.rows;
        }
        screen.geometry_revision = geometry.revision;
        Ok(())
    }

    pub(crate) fn new(worker: Arc<HeadlessWorker>, state: &Arc<AppState>) -> Self {
        Self {
            worker,
            state: Arc::downgrade(state),
            screens: Mutex::new(HashMap::new()),
            faults: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn parse(&self, id: &str, delta: &TerminalOutputDelta) -> Result<(), AppError> {
        self.ensure_healthy(id, delta.generation)?;
        let result = self.parse_inner(id, delta);
        if let Err(error) = &result {
            self.faults
                .lock_or_err()?
                .insert(id.into(), (delta.generation, error.to_string()));
        }
        result
    }

    pub(crate) fn ensure_healthy(&self, id: &str, generation: u64) -> Result<(), AppError> {
        self.worker.ensure_healthy()?;
        if let Some((_, reason)) = self
            .faults
            .lock_or_err()?
            .get(id)
            .filter(|(failed_generation, _)| *failed_generation == generation)
        {
            return Err(AppError::Other(format!(
                "headless terminal parser is unavailable: {reason}"
            )));
        }
        Ok(())
    }

    fn parse_inner(&self, id: &str, delta: &TerminalOutputDelta) -> Result<(), AppError> {
        let mut screens = self.screens.lock_or_err()?;
        if screens
            .get(id)
            .is_some_and(|screen| screen.generation != delta.generation)
        {
            return Err(AppError::Other(
                "stale headless output generation rejected".into(),
            ));
        }
        if !screens.contains_key(id) {
            self.worker.request(json!({"operation":"create","terminalId":id,"generation":delta.generation,"cols":delta.geometry.cols,"rows":delta.geometry.rows}))?;
            screens.insert(
                id.into(),
                ScreenBinding {
                    generation: delta.generation,
                    cols: delta.geometry.cols,
                    rows: delta.geometry.rows,
                    seq: delta.seq_start,
                    geometry_revision: delta.geometry.revision,
                    pending_resizes: std::collections::VecDeque::new(),
                    pending_replies: Vec::new(),
                },
            );
        }
        let screen = screens
            .get_mut(id)
            .ok_or_else(|| AppError::Other("headless screen missing after creation".into()))?;
        self.apply_geometry(id, screen, delta.geometry)?;
        if screen.seq != delta.seq_start {
            return Err(AppError::Other("headless output sequence gap".into()));
        }
        let response=self.worker.request(json!({"operation":"write","terminalId":id,"generation":delta.generation,"data":base64::engine::general_purpose::STANDARD.encode(&delta.data)}))?;
        screen.seq = delta.seq_end;
        let replies = response["replies"]
            .as_array()
            .ok_or_else(|| AppError::Other("invalid headless reply list".into()))?;
        if screen.pending_replies.len().saturating_add(replies.len()) > 128 {
            return Err(AppError::Other(
                "headless bootstrap reply capacity exceeded".into(),
            ));
        }
        for reply in replies {
            let reply = reply
                .as_str()
                .filter(|reply| reply.len() <= 4096)
                .ok_or_else(|| AppError::Other("invalid headless protocol reply".into()))?;
            screen.pending_replies.push(reply.as_bytes().to_vec());
        }
        let replies = std::mem::take(&mut screen.pending_replies);
        while screen
            .pending_resizes
            .front()
            .is_some_and(|(seq, _)| *seq <= screen.seq)
        {
            if let Some((_, geometry)) = screen.pending_resizes.pop_front() {
                self.apply_geometry(id, screen, geometry)?;
            }
        }
        drop(screens);
        self.send_or_defer(id, delta.generation, replies)
    }

    fn send_or_defer(
        &self,
        id: &str,
        generation: u64,
        replies: Vec<Vec<u8>>,
    ) -> Result<(), AppError> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| AppError::Other("terminal core is unavailable".into()))?;
        let handle = state.pty_handles.lock_or_err()?.get(id).cloned();
        if let Some(handle) = handle {
            if handle.terminal_generation() != generation {
                return Err(AppError::Other("headless reply generation changed".into()));
            }
            for reply in replies {
                handle
                    .write_protocol_reply(&reply)
                    .map_err(AppError::Other)?;
            }
        } else {
            let mut screens = self.screens.lock_or_err()?;
            if let Some(screen) = screens
                .get_mut(id)
                .filter(|screen| screen.generation == generation)
            {
                if screen.pending_replies.len().saturating_add(replies.len()) > 128 {
                    return Err(AppError::Other(
                        "headless bootstrap reply capacity exceeded".into(),
                    ));
                }
                screen.pending_replies.extend(replies);
            }
        }
        Ok(())
    }

    /// The create path publishes its real handle before emitting catalog-ready.
    pub(crate) fn flush_bootstrap_replies(&self) -> Result<(), AppError> {
        let pending = {
            let mut screens = self.screens.lock_or_err()?;
            screens
                .iter_mut()
                .map(|(id, screen)| {
                    (
                        id.clone(),
                        screen.generation,
                        std::mem::take(&mut screen.pending_replies),
                    )
                })
                .collect::<Vec<_>>()
        };
        for (id, generation, replies) in pending {
            self.send_or_defer(&id, generation, replies)?;
        }
        Ok(())
    }

    pub(crate) fn checkpoint(&self, id: &str, generation: u64) -> Result<Value, AppError> {
        self.ensure_healthy(id, generation)?;
        let screens = self.screens.lock_or_err()?;
        if !screens
            .get(id)
            .is_some_and(|screen| screen.generation == generation)
        {
            return Err(AppError::Other(
                "headless screen generation unavailable".into(),
            ));
        }
        let mut checkpoint = self
            .worker
            .request(json!({"operation":"checkpoint","terminalId":id,"generation":generation}))?;
        checkpoint["generation"] = json!(generation);
        checkpoint["sourceSeq"] = json!(screens[id].seq);
        checkpoint["geometryRevision"] = json!(screens[id].geometry_revision);
        Ok(checkpoint)
    }

    pub(crate) fn dispose(&self, id: &str, generation: u64) -> Result<(), AppError> {
        let mut faults = self.faults.lock_or_err()?;
        if faults
            .get(id)
            .is_some_and(|(failed_generation, _)| *failed_generation == generation)
        {
            faults.remove(id);
        }
        drop(faults);
        let mut screens = self.screens.lock_or_err()?;
        if screens
            .get(id)
            .is_some_and(|screen| screen.generation == generation)
        {
            self.worker
                .request(json!({"operation":"dispose","terminalId":id,"generation":generation}))?;
            screens.remove(id);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn stop_parser_for_test(&self) {
        self.worker.stop_parser_for_test();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_events::TerminalEvents;
    #[test]
    fn resize_marker_waits_for_older_output_and_late_generation_cannot_replace_the_screen() {
        let state = Arc::new(AppState::from_settings(crate::settings::Settings::default()));
        let script =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("gen/headless/worker.cjs");
        let worker =
            Arc::new(HeadlessWorker::start(std::path::Path::new("node"), &script).unwrap());
        let broker = HeadlessBroker::new(worker, &state);
        broker.prepare("fixture", 1, 80, 24, None).unwrap();
        broker
            .resize_at(
                "fixture",
                1,
                10,
                TerminalGeometry {
                    revision: 1,
                    cols: 60,
                    rows: 20,
                },
            )
            .unwrap();
        assert_eq!(broker.checkpoint("fixture", 1).unwrap()["cols"], 80);
        let old = TerminalOutputDelta {
            generation: 1,
            seq_start: 0,
            seq_end: 10,
            data: b"old-prefix".to_vec(),
            geometry: TerminalGeometry::default(),
        };
        broker.parse("fixture", &old).unwrap();
        let snapshot = broker.checkpoint("fixture", 1).unwrap();
        assert_eq!(snapshot["cols"], 60);
        assert_eq!(snapshot["geometryRevision"], 1);
        assert_eq!(snapshot["sourceSeq"], 10);
        broker.prepare("fixture", 2, 70, 22, None).unwrap();
        assert!(broker.parse("fixture", &old).is_err());
        assert_eq!(broker.checkpoint("fixture", 2).unwrap()["cols"], 70);
    }
    #[tokio::test]
    async fn a_real_terminal_can_run_and_parse_without_a_tauri_app_or_gui_ack() {
        let fixture = tempfile::tempdir().unwrap();
        let mut settings = crate::settings::Settings::default();
        settings.profiles[0].command_line = if cfg!(windows) {
            "cmd.exe /Q"
        } else {
            "/bin/bash --noprofile --norc"
        }
        .into();
        settings.profiles[0].startup_command.clear();
        let profile = settings.profiles[0].name.clone();
        let state = Arc::new(AppState::from_settings(settings.clone()));
        let script =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("gen/headless/worker.cjs");
        let worker =
            Arc::new(HeadlessWorker::start(std::path::Path::new("node"), &script).unwrap());
        let broker = Arc::new(HeadlessBroker::new(worker, &state));
        let events_broker = broker.clone();
        let parser_broker = broker.clone();
        let events = TerminalEvents::new(move |_, _| {
            events_broker
                .flush_bootstrap_replies()
                .map_err(String::from)
        })
        .with_output_parser(move |id, delta| parser_broker.parse(id, delta).map_err(String::from));
        let id = "headless-core-fixture".to_string();
        crate::commands::create_terminal_session_core(
            id.clone(),
            profile,
            80,
            24,
            String::new(),
            Some(false),
            Some(false),
            Some(fixture.path().to_string_lossy().into_owned()),
            None,
            None,
            state.clone(),
            events,
            settings,
        )
        .await
        .unwrap();
        let handle = state
            .pty_handles
            .lock_or_err()
            .unwrap()
            .get(&id)
            .cloned()
            .unwrap();
        handle.write(b"echo daemon-core-ready\r").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        loop {
            if broker
                .checkpoint(&id, handle.terminal_generation())
                .ok()
                .and_then(|value| {
                    value["serialized"]
                        .as_str()
                        .map(|value| value.contains("daemon-core-ready"))
                })
                .unwrap_or(false)
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "headless terminal must progress without GUI credit"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        state.terminate_child_processes();
    }
    use std::time::Duration;
}
