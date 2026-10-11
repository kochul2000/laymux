use crate::settings::{DockSetting, Workspace};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, schemars::JsonSchema, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUiState {
    pub active_workspace_id: Option<String>,
    pub file_viewer: Option<FileViewerRestore>,
}
#[derive(Clone, Debug, Default, PartialEq, schemars::JsonSchema, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileViewerRestore {
    pub open: bool,
    pub path: String,
    pub maximized: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributionCoverage {
    pub terminal_id: String,
    pub state: String,
    pub generation: Option<u64>,
    pub provider: Option<String>,
    pub session_id: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSessionSnapshot {
    pub workspaces: Vec<Workspace>,
    pub docks: Vec<DockSetting>,
    #[serde(default)]
    pub workspace_display_order: Vec<String>,
    #[serde(default)]
    pub coverage: Vec<AttributionCoverage>,
    #[serde(default)]
    pub attribution_lookup_failed: bool,
    #[serde(default)]
    pub cwd_lookup_failed: bool,
    #[serde(default)]
    pub ui_state: LocalUiState,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointCommit {
    pub revision: u64,
    pub unresolved_terminal_ids: Vec<String>,
    pub needs_retry: bool,
    pub snapshot: LocalSessionSnapshot,
}
