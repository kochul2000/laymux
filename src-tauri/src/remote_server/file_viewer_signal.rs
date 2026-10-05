//! Path-less desktop FileViewer signal for Remote's unread dot (ADR-0291).
//!
//! The desktop `useFileViewerStore` owns the viewer and its open sequence. The
//! frontend reports `{open, epoch, revision}` on every change and this module
//! keeps only the last value, so a heartbeat answers from memory instead of a
//! bridge round trip to the WebView — lease liveness must not depend on how
//! busy the WebView is. The path never lands here: it stays behind the
//! FileViewer capability on `/remote/v1/file-viewer/status` (ADR-0042).

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::state::AppState;

/// One desktop viewer state as Remote sees it. `(epoch, revision)` identifies
/// one open: the epoch changes with every WebView lifetime and the revision
/// counts opens within it, including the same path opened again.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileViewerSignal {
    /// A file — not the empty path prompt — is on the desktop viewer.
    pub open: bool,
    pub epoch: String,
    pub revision: u64,
}

/// Last reported [`FileViewerSignal`]. Its mutex guards only itself and joins
/// no `AppState` lock ordering: nothing takes it while holding another lock.
#[derive(Debug, Default)]
pub struct FileViewerSignalMirror(Mutex<FileViewerSignal>);

impl FileViewerSignalMirror {
    pub fn record(&self, signal: FileViewerSignal) -> Result<(), AppError> {
        *self.0.lock_or_err()? = signal;
        Ok(())
    }

    pub fn snapshot(&self) -> Result<FileViewerSignal, AppError> {
        Ok(self.0.lock_or_err()?.clone())
    }
}

/// Mirror the desktop viewer signal reported by the frontend (ADR-0291).
pub fn report_file_viewer_signal(
    app_state: &AppState,
    signal: FileViewerSignal,
) -> Result<(), String> {
    app_state
        .file_viewer_signal
        .record(signal)
        .map_err(|e| e.to_string())
}

/// Add `fileViewer` to a successful heartbeat body. A poisoned mirror drops the
/// field instead of failing the heartbeat: a missing dot is recoverable, a lost
/// lease is not. Remote leaves its dot as it was when the field is absent.
pub(crate) fn attach_heartbeat_signal(response: &mut serde_json::Value, state: &AppState) {
    let signal = match state.file_viewer_signal.snapshot() {
        Ok(signal) => signal,
        Err(error) => {
            tracing::warn!(%error, "file viewer signal unavailable for heartbeat");
            return;
        }
    };
    match serde_json::to_value(signal) {
        Ok(value) => response["fileViewer"] = value,
        Err(error) => tracing::warn!(%error, "file viewer signal did not serialize"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heartbeat_reports_nothing_open_before_the_first_report() {
        let state = AppState::new();
        let mut response = serde_json::json!({ "active": true });

        attach_heartbeat_signal(&mut response, &state);

        assert_eq!(
            response,
            serde_json::json!({
                "active": true,
                "fileViewer": { "open": false, "epoch": "", "revision": 0 },
            })
        );
    }

    #[test]
    fn heartbeat_carries_the_last_report_and_never_a_path() {
        let state = AppState::new();
        state
            .file_viewer_signal
            .record(FileViewerSignal {
                open: true,
                epoch: "epoch-a".into(),
                revision: 3,
            })
            .unwrap();
        state
            .file_viewer_signal
            .record(FileViewerSignal {
                open: true,
                epoch: "epoch-a".into(),
                revision: 4,
            })
            .unwrap();
        let mut response = serde_json::json!({});

        attach_heartbeat_signal(&mut response, &state);

        assert_eq!(
            response["fileViewer"],
            serde_json::json!({ "open": true, "epoch": "epoch-a", "revision": 4 })
        );
        let keys: Vec<_> = response["fileViewer"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(keys.len(), 3, "the heartbeat signal must stay path-less");
    }

    #[test]
    fn report_rejects_fields_the_mirror_does_not_own() {
        // The path belongs to the capability-gated status route only.
        let parsed = serde_json::from_value::<FileViewerSignal>(serde_json::json!({
            "open": true,
            "epoch": "epoch-a",
            "revision": 1,
            "path": "C:\\secret.txt",
        }));
        assert!(parsed.is_err());
    }
}
