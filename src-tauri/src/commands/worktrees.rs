//! Worktree UI and Automation share Git operations and laymux usage checks.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;

use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use crate::worktree::{self, WorktreeEntry, WorktreeInspection};
use crate::worktree_usage::{self, UsageSnapshot, WorktreeUsage};

// Independent of AppState locks. Only removal owns this gate; filesystem and
// daemon calls never run while holding a terminal registry guard.
static REMOVAL: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRow {
    #[serde(flatten)]
    pub worktree: WorktreeEntry,
    pub usage: Vec<WorktreeUsage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeViewSnapshot {
    pub working_dir: String,
    pub repository_path: String,
    pub common_dir: String,
    pub worktrees: Vec<WorktreeRow>,
    pub usage_warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeViewInspection {
    #[serde(flatten)]
    pub inspection: WorktreeInspection,
    pub usage: Vec<WorktreeUsage>,
    pub usage_warnings: Vec<String>,
}

pub fn get_worktree_snapshot_inner(
    state: &AppState,
    working_dir: &str,
    source_terminal_id: Option<&str>,
) -> Result<WorktreeViewSnapshot, AppError> {
    let working_dir =
        crate::worktree_context::resolve_working_dir(state, working_dir, source_terminal_id)?;
    let snapshot = worktree::snapshot(&working_dir)?;
    let usage = worktree_usage::collect_usage(state)?;
    Ok(WorktreeViewSnapshot {
        working_dir,
        repository_path: snapshot.repository_path,
        common_dir: snapshot.common_dir,
        worktrees: snapshot
            .worktrees
            .into_iter()
            .map(|worktree| WorktreeRow {
                usage: worktree_usage::usage_for_path(&usage.usage, &worktree.path),
                worktree,
            })
            .collect(),
        usage_warnings: usage.warnings,
    })
}

fn with_usage(
    mut inspection: WorktreeInspection,
    snapshot: UsageSnapshot,
) -> WorktreeViewInspection {
    let usage = worktree_usage::usage_for_path(&snapshot.usage, &inspection.worktree.path);
    if !usage.is_empty() {
        inspection.blockers.push("in_use".into());
    }
    if !snapshot.complete {
        inspection.blockers.push("usage_unknown".into());
    }
    inspection.can_remove = inspection.blockers.is_empty();
    WorktreeViewInspection {
        inspection,
        usage,
        usage_warnings: snapshot.warnings,
    }
}

pub fn inspect_worktree_inner(
    state: &AppState,
    working_dir: &str,
    path: &str,
) -> Result<WorktreeViewInspection, AppError> {
    let working_dir = crate::worktree_context::resolve_working_dir(state, working_dir, None)?;
    let inspection = worktree::inspect(&working_dir, path)?;
    Ok(with_usage(
        inspection,
        worktree_usage::collect_usage(state)?,
    ))
}

pub fn remove_worktree_inner(
    state: &AppState,
    working_dir: &str,
    path: &str,
    expected_head: &str,
) -> Result<(), AppError> {
    let _removal = REMOVAL.lock_or_err()?;
    let working_dir = crate::worktree_context::resolve_working_dir(state, working_dir, None)?;
    worktree::remove_with_guard(&working_dir, path, expected_head, |validated_path| {
        let usage = worktree_usage::collect_usage(state)?;
        if !usage.complete {
            return Err(AppError::Other(format!(
                "사용 정보를 확인할 수 없어 제거하지 않았습니다: {}",
                usage.warnings.join("; ")
            )));
        }
        if !worktree_usage::usage_for_path(&usage.usage, validated_path).is_empty() {
            return Err(AppError::Other(
                "laymux 터미널 또는 복원 대상이 사용 중이므로 제거하지 않았습니다.".into(),
            ));
        }
        Ok(())
    })
}

#[tauri::command(async)]
pub fn get_worktree_snapshot(
    state: State<'_, Arc<AppState>>,
    working_dir: String,
    source_terminal_id: Option<String>,
) -> Result<WorktreeViewSnapshot, String> {
    get_worktree_snapshot_inner(&state, &working_dir, source_terminal_id.as_deref())
        .map_err(String::from)
}

#[tauri::command(async)]
pub fn inspect_worktree(
    state: State<'_, Arc<AppState>>,
    working_dir: String,
    path: String,
) -> Result<WorktreeViewInspection, String> {
    inspect_worktree_inner(&state, &working_dir, &path).map_err(String::from)
}

#[tauri::command(async)]
pub fn remove_worktree(
    state: State<'_, Arc<AppState>>,
    working_dir: String,
    path: String,
    expected_head: String,
) -> Result<(), String> {
    remove_worktree_inner(&state, &working_dir, &path, &expected_head).map_err(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inspection() -> WorktreeInspection {
        WorktreeInspection {
            worktree: WorktreeEntry {
                path: "D:/trees/task".into(),
                head: "abc".into(),
                branch: Some("task".into()),
                is_main: false,
                bare: false,
                locked: None,
                prunable: None,
            },
            tracked_changes: 0,
            untracked_files: 0,
            ignored_files: 0,
            files: vec![],
            files_truncated: false,
            upstream: None,
            ahead: None,
            behind: None,
            blockers: vec![],
            can_remove: true,
        }
    }

    #[test]
    fn unknown_usage_cannot_become_a_cleanup_candidate() {
        let result = with_usage(
            inspection(),
            UsageSnapshot {
                usage: vec![],
                warnings: vec!["daemon unavailable".into()],
                complete: false,
            },
        );
        assert!(!result.inspection.can_remove);
        assert_eq!(result.inspection.blockers, vec!["usage_unknown"]);
        assert_eq!(result.usage_warnings, vec!["daemon unavailable"]);
    }

    #[test]
    fn saved_reference_in_child_directory_blocks_clean_worktree() {
        let result = with_usage(
            inspection(),
            UsageSnapshot {
                usage: vec![WorktreeUsage {
                    terminal_id: Some("terminal-hidden".into()),
                    pane_id: Some("hidden".into()),
                    workspace_id: Some("ws-hidden".into()),
                    workspace_name: Some("숨은 작업".into()),
                    cwd: "D:/trees/task/src".into(),
                    kind: worktree_usage::UsageKind::Saved,
                    agent_type: None,
                }],
                warnings: vec![],
                complete: true,
            },
        );
        assert!(!result.inspection.can_remove);
        assert_eq!(result.inspection.blockers, vec!["in_use"]);
        assert_eq!(result.usage.len(), 1);
    }
}
