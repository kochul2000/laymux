//! The restarts this GUI performed to recover its WebView, kept on disk
//! because each restart is a new process (ADR-0336).
//!
//! A restart that cannot be recorded is not performed: the next GUI would
//! start with an empty budget, and a session that keeps killing WebView2
//! would restart forever.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::policy::{budget, with_restart, Budget};
use crate::error::AppError;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryFile {
    /// Wall-clock epoch milliseconds of each restart, oldest first.
    #[serde(default)]
    restarts_ms: Vec<u64>,
}

/// Whether this failure may restart the GUI.
#[derive(Debug)]
pub enum Claim {
    /// Recorded; restart now.
    Granted,
    /// `recent` restarts already fill the window.
    Exhausted { recent: usize },
    /// The history could not be read or written.
    Unrecorded(AppError),
}

/// Consult the budget for a restart at `now_ms` (wall clock) and, if it is
/// granted, record it before returning.
pub fn claim_restart(path: Option<&Path>, now_ms: u64) -> Claim {
    let Some(path) = path else {
        return Claim::Unrecorded(AppError::Other(
            "no cache directory for the WebView recovery history".into(),
        ));
    };
    let restarts = match load_restarts(path) {
        Ok(restarts) => restarts,
        Err(error) => return Claim::Unrecorded(error),
    };
    match budget(&restarts, now_ms) {
        Budget::Exhausted { recent } => Claim::Exhausted { recent },
        Budget::Restart => match store_restarts(path, &with_restart(&restarts, now_ms)) {
            Ok(()) => Claim::Granted,
            Err(error) => Claim::Unrecorded(error),
        },
    }
}

/// Record a restart the user asked for once the budget was exhausted, so the
/// next failure inside the window asks again instead of restarting.
pub fn record_restart(path: &Path, now_ms: u64) -> Result<(), AppError> {
    let restarts = load_restarts(path)?;
    store_restarts(path, &with_restart(&restarts, now_ms))
}

/// The persisted restarts. A missing file holds none, and so does one that
/// does not parse (writes replace the file whole, so this is a hand edit, and
/// the next record repairs it). Any other read error is returned: the budget
/// cannot be known.
fn load_restarts(path: &Path) -> Result<Vec<u64>, AppError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    match serde_json::from_slice::<HistoryFile>(&bytes) {
        Ok(file) => Ok(file.restarts_ms),
        Err(error) => {
            tracing::warn!(
                %error,
                path = %path.display(),
                "unparsable WebView recovery history; treating it as empty"
            );
            Ok(Vec::new())
        }
    }
}

/// Replace the persisted restarts. The file is written beside its final
/// name and renamed over it, so a reader never sees half of it.
fn store_restarts(path: &Path, restarts: &[u64]) -> Result<(), AppError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_vec(&HistoryFile {
        restarts_ms: restarts.to_vec(),
    })?;
    let staged = path.with_extension("json.tmp");
    std::fs::write(&staged, json)?;
    if let Err(error) = std::fs::rename(&staged, path) {
        let _ = std::fs::remove_file(&staged);
        return Err(error.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{WEBVIEW_RECOVERY_HISTORY_FILE, WEBVIEW_RECOVERY_MAX_RESTARTS};

    const NOW: u64 = 1_760_000_000_000;

    fn history_in(dir: &tempfile::TempDir) -> std::path::PathBuf {
        dir.path().join("cache").join(WEBVIEW_RECOVERY_HISTORY_FILE)
    }

    #[test]
    fn a_missing_history_holds_no_restarts() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_restarts(&history_in(&dir)).unwrap(), Vec::<u64>::new());
    }

    #[test]
    fn stored_restarts_load_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = history_in(&dir);
        store_restarts(&path, &[NOW - 1, NOW]).unwrap();
        assert_eq!(load_restarts(&path).unwrap(), vec![NOW - 1, NOW]);

        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(json["restartsMs"], serde_json::json!([NOW - 1, NOW]));
    }

    #[test]
    fn storing_leaves_no_temporary_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = history_in(&dir);
        store_restarts(&path, &[NOW]).unwrap();
        store_restarts(&path, &[NOW, NOW + 1]).unwrap();
        let names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, [WEBVIEW_RECOVERY_HISTORY_FILE]);
        assert_eq!(load_restarts(&path).unwrap(), vec![NOW, NOW + 1]);
    }

    #[test]
    fn an_unparsable_history_holds_no_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let path = history_in(&dir);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{ not json").unwrap();
        assert_eq!(load_restarts(&path).unwrap(), Vec::<u64>::new());
    }

    #[test]
    fn an_unreadable_history_is_an_error() {
        // A directory where the file should be: reading fails for a reason
        // other than absence, so the budget cannot be known.
        let dir = tempfile::tempdir().unwrap();
        let path = history_in(&dir);
        std::fs::create_dir_all(&path).unwrap();
        assert!(load_restarts(&path).is_err());
    }

    #[test]
    fn claims_are_granted_and_recorded_until_the_budget_is_exhausted() {
        let dir = tempfile::tempdir().unwrap();
        let path = history_in(&dir);
        for i in 0..WEBVIEW_RECOVERY_MAX_RESTARTS as u64 {
            let claim = claim_restart(Some(&path), NOW + i);
            assert!(matches!(claim, Claim::Granted), "claim {i}: {claim:?}");
            assert_eq!(load_restarts(&path).unwrap().len() as u64, i + 1);
        }
        let claim = claim_restart(Some(&path), NOW + 100);
        assert!(
            matches!(claim, Claim::Exhausted { recent } if recent == WEBVIEW_RECOVERY_MAX_RESTARTS),
            "{claim:?}"
        );
        // A refused claim is not a restart and records nothing.
        assert_eq!(
            load_restarts(&path).unwrap().len(),
            WEBVIEW_RECOVERY_MAX_RESTARTS
        );
    }

    #[test]
    fn a_requested_restart_is_recorded_past_the_budget() {
        let dir = tempfile::tempdir().unwrap();
        let path = history_in(&dir);
        for i in 0..WEBVIEW_RECOVERY_MAX_RESTARTS as u64 {
            assert!(matches!(
                claim_restart(Some(&path), NOW + i),
                Claim::Granted
            ));
        }
        record_restart(&path, NOW + 100).unwrap();
        let restarts = load_restarts(&path).unwrap();
        assert_eq!(restarts.len(), WEBVIEW_RECOVERY_MAX_RESTARTS);
        assert_eq!(restarts.last(), Some(&(NOW + 100)));
        assert!(matches!(
            claim_restart(Some(&path), NOW + 200),
            Claim::Exhausted { .. }
        ));
    }

    #[test]
    fn a_claim_that_cannot_be_recorded_is_refused() {
        // The parent of the history is a file: nothing can be written there.
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("cache");
        std::fs::write(&blocker, b"").unwrap();
        let path = blocker.join(WEBVIEW_RECOVERY_HISTORY_FILE);
        let claim = claim_restart(Some(&path), NOW);
        assert!(matches!(claim, Claim::Unrecorded(_)), "{claim:?}");
    }

    #[test]
    fn a_claim_that_cannot_read_the_history_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = history_in(&dir);
        std::fs::create_dir_all(&path).unwrap();
        let claim = claim_restart(Some(&path), NOW);
        assert!(matches!(claim, Claim::Unrecorded(_)), "{claim:?}");
    }

    #[test]
    fn a_claim_without_a_history_location_is_refused() {
        let claim = claim_restart(None, NOW);
        assert!(matches!(claim, Claim::Unrecorded(_)), "{claim:?}");
    }
}
