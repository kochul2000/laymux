use std::sync::mpsc::{self, Sender};

use windows_sys::Win32::System::Power::{
    SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
};

use super::InhibitBackend;
use crate::error::AppError;

/// `SetThreadExecutionState` attaches the request to the *calling thread*
/// and the request dies with that thread. A Tauri command runs on whatever
/// worker the runtime picks, so the inhibitor lives on a thread this module
/// owns and keeps alive instead.
struct Request {
    enabled: bool,
    ack: Sender<Result<(), String>>,
}

pub struct PlatformBackend {
    tx: Option<Sender<Request>>,
}

impl PlatformBackend {
    pub fn new() -> Self {
        Self { tx: None }
    }

    fn worker(&mut self) -> Result<&Sender<Request>, AppError> {
        if self.tx.is_none() {
            let (tx, rx) = mpsc::channel::<Request>();
            std::thread::Builder::new()
                .name("sleep-inhibitor".into())
                .spawn(move || {
                    while let Ok(request) = rx.recv() {
                        let flags = if request.enabled {
                            ES_CONTINUOUS | ES_SYSTEM_REQUIRED
                        } else {
                            ES_CONTINUOUS
                        };
                        // Returns the previous state, or 0 on failure.
                        let previous = unsafe { SetThreadExecutionState(flags) };
                        let result = if previous == 0 {
                            Err("SetThreadExecutionState failed".to_string())
                        } else {
                            Ok(())
                        };
                        let _ = request.ack.send(result);
                    }
                    // The channel is only dropped when the process is going
                    // away, but clear the request anyway so the thread never
                    // exits still holding one.
                    unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
                })
                .map_err(AppError::Io)?;
            self.tx = Some(tx);
        }
        self.tx
            .as_ref()
            .ok_or_else(|| AppError::Other("sleep inhibitor thread missing".into()))
    }
}

impl InhibitBackend for PlatformBackend {
    fn apply(&mut self, enabled: bool) -> Result<(), AppError> {
        // Nothing to release before the thread has ever run.
        if !enabled && self.tx.is_none() {
            return Ok(());
        }
        let (ack_tx, ack_rx) = mpsc::channel();
        self.worker()?
            .send(Request {
                enabled,
                ack: ack_tx,
            })
            .map_err(|_| AppError::Other("sleep inhibitor thread stopped".into()))?;
        ack_rx
            .recv()
            .map_err(|_| AppError::Other("sleep inhibitor thread stopped".into()))?
            .map_err(AppError::Other)
    }
}
