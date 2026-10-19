use crate::error::AppError;

use super::git::Git;
use super::inspection;
use super::types::{WorktreeInspection, WorktreeSnapshot};

pub fn snapshot(working_dir: &str) -> Result<WorktreeSnapshot, AppError> {
    snapshot_with(&Git::new(working_dir)?)
}

pub(super) fn snapshot_with(git: &Git) -> Result<WorktreeSnapshot, AppError> {
    let common_dir = git.text(
        &git.cwd,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let mut worktrees = git.worktrees()?;
    for worktree in &mut worktrees {
        worktree.path = git.host_path(&worktree.path);
    }
    let repository_path = worktrees
        .first()
        .ok_or_else(|| AppError::Other("워크트리가 없습니다.".into()))?
        .path
        .clone();
    Ok(WorktreeSnapshot {
        repository_path,
        common_dir: git.host_path(&common_dir),
        worktrees,
    })
}

pub fn inspect(working_dir: &str, path: &str) -> Result<WorktreeInspection, AppError> {
    inspection::inspect_with(&Git::new(working_dir)?, path)
}

pub fn remove(working_dir: &str, path: &str, expected_head: &str) -> Result<(), AppError> {
    remove_with_guard(working_dir, path, expected_head, |_| Ok(()))
}

/// Re-read membership, Git state and HEAD, then let the application check fresh
/// terminal/daemon usage immediately before the non-forced Git operation.
pub fn remove_with_guard(
    working_dir: &str,
    path: &str,
    expected_head: &str,
    guard: impl FnOnce(&str) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let git = Git::new(working_dir)?;
    let inspection = inspection::inspect_with(&git, path)?;
    if expected_head.is_empty() || inspection.worktree.head != expected_head {
        return Err(AppError::Other(
            "검사 이후 HEAD가 변경되었습니다. 다시 확인하세요.".into(),
        ));
    }
    if !inspection.can_remove {
        return Err(AppError::Other(format!(
            "워크트리를 제거할 수 없습니다: {}",
            inspection.blockers.join(", ")
        )));
    }
    let target = git.git_path(&inspection.worktree.path)?;
    guard(&inspection.worktree.path)?;
    git.run(&git.cwd, &["worktree", "remove", "--", &target])?;
    Ok(())
}
