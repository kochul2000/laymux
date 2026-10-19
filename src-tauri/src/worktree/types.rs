use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    pub head: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub is_main: bool,
    pub bare: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prunable: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSnapshot {
    pub repository_path: String,
    pub common_dir: String,
    pub worktrees: Vec<WorktreeEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeFile {
    pub kind: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInspection {
    pub worktree: WorktreeEntry,
    pub tracked_changes: usize,
    pub untracked_files: usize,
    pub ignored_files: usize,
    pub files: Vec<WorktreeFile>,
    pub files_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<u64>,
    pub blockers: Vec<String>,
    pub can_remove: bool,
}
