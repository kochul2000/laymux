//! Short-lived proof owned by an explicit close/update checkpoint.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexStatusProcess {
    pub pid: u32,
    pub started_at: u64,
    pub distro: Option<String>,
    pub codex_home: PathBuf,
    pub sqlite_home: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexStatusStep {
    Dismiss,
    Clear,
    TypeStatus,
    Submit,
}

#[derive(Clone, Debug)]
pub(crate) struct CodexStatusTarget {
    pub io: Arc<Mutex<()>>,
    pub generation: u64,
    pub process: CodexStatusProcess,
    pub original_cols: u16,
    pub original_rows: u16,
    pub resized: bool,
    pub dismissed: bool,
    pub clear_batches: u16,
    pub next_step: Option<CodexStatusStep>,
    pub output_start: Option<u64>,
    pub proof: Option<(String, bool)>,
}

pub(crate) struct CodexStatusCheckpoint {
    pub token: String,
    pub deadline: Instant,
    pub owns_fence: bool,
    pub completed: bool,
    pub update_request_id: Option<u64>,
    pub targets: HashMap<String, CodexStatusTarget>,
}

impl CodexStatusCheckpoint {
    pub fn check(&self, token: &str) -> Result<(), String> {
        if self.token != token || Instant::now() >= self.deadline {
            return Err("Codex status checkpoint expired or was cancelled".into());
        }
        Ok(())
    }
}
