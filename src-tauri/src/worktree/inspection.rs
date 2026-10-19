use crate::error::AppError;

use super::git::Git;
use super::parsing;
use super::service::snapshot_with;
use super::types::WorktreeInspection;

pub(super) fn inspect_with(git: &Git, path: &str) -> Result<WorktreeInspection, AppError> {
    let snapshot = snapshot_with(git)?;
    let worktree = snapshot
        .worktrees
        .into_iter()
        .find(|entry| git.same_path(&entry.path, path))
        .ok_or_else(|| {
            AppError::Other("현재 저장소에 등록된 정확한 워크트리 경로가 아닙니다.".into())
        })?;
    let mut result = WorktreeInspection {
        worktree,
        tracked_changes: 0,
        untracked_files: 0,
        ignored_files: 0,
        files: Vec::new(),
        files_truncated: false,
        upstream: None,
        ahead: None,
        behind: None,
        blockers: Vec::new(),
        can_remove: false,
    };
    for (blocked, code) in [
        (result.worktree.is_main, "main"),
        (result.worktree.bare, "bare"),
        (result.worktree.locked.is_some(), "locked"),
        (result.worktree.prunable.is_some(), "prunable"),
        (
            result.worktree.branch.is_none() && !result.worktree.bare,
            "detached",
        ),
    ] {
        if blocked {
            result.blockers.push(code.into());
        }
    }
    // Missing metadata is not a successful clean inspection; the categorical
    // blocker remains visible, but the counters are not used to allow removal.
    if result.worktree.bare || result.worktree.prunable.is_some() {
        return Ok(result);
    }
    let target = &result.worktree.path;
    let target_common = git.text(
        target,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    if !git.same_path(&git.host_path(&target_common), &snapshot.common_dir) {
        return Err(AppError::Other(
            "워크트리의 저장소 정보가 변경되었습니다.".into(),
        ));
    }
    let source_is_target = match git
        .text(&git.cwd, &["rev-parse", "--is-bare-repository"])?
        .as_str()
    {
        "true" => false,
        "false" => {
            let source_root = git.text(&git.cwd, &["rev-parse", "--show-toplevel"])?;
            git.same_path(&git.host_path(&source_root), target)
        }
        _ => return Err(AppError::Other("저장소 유형을 확인할 수 없습니다.".into())),
    };
    if source_is_target || process_cwd_is_within(target) {
        result.blockers.push("current_directory".into());
    }
    let status = parsing::status(&git.run(
        target,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignored=traditional",
            "--ignore-submodules=none",
        ],
    )?)?;
    result.tracked_changes = status.tracked;
    result.untracked_files = status.untracked;
    result.ignored_files = status.ignored;
    result.files_truncated =
        status.tracked + status.untracked + status.ignored > status.files.len();
    result.files = status.files;
    let (submodules, hidden_index) =
        parsing::index_guards(&git.run(target, &["ls-files", "-v", "--stage", "-z"])?)?;
    for (blocked, code) in [
        (result.tracked_changes > 0, "tracked_changes"),
        (result.untracked_files > 0, "untracked_files"),
        (result.ignored_files > 0, "ignored_files"),
        (submodules, "submodules"),
        (hidden_index, "index_flags"),
    ] {
        if blocked {
            result.blockers.push(code.into());
        }
    }
    if let Some(branch) = &result.worktree.branch {
        let reference = format!("refs/heads/{branch}");
        let upstream = git.text(
            target,
            &["for-each-ref", "--format=%(upstream:short)", &reference],
        )?;
        if !upstream.is_empty() {
            let counts = git.text(
                target,
                &[
                    "rev-list",
                    "--left-right",
                    "--count",
                    "HEAD...@{upstream}",
                    "--",
                ],
            )?;
            let numbers = counts
                .split_whitespace()
                .map(str::parse::<u64>)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| AppError::Other("upstream 커밋 수를 확인할 수 없습니다.".into()))?;
            if numbers.len() != 2 {
                return Err(AppError::Other(
                    "upstream 커밋 수를 확인할 수 없습니다.".into(),
                ));
            }
            result.upstream = Some(upstream);
            result.ahead = Some(numbers[0]);
            result.behind = Some(numbers[1]);
        }
    }
    // A branch checkout/commit during inspection invalidates the entire result.
    let after = snapshot_with(git)?
        .worktrees
        .into_iter()
        .find(|entry| git.same_path(&entry.path, target))
        .ok_or_else(|| AppError::Other("검사 중 워크트리 등록이 변경되었습니다.".into()))?;
    if after.head != result.worktree.head
        || after.branch != result.worktree.branch
        || after.locked != result.worktree.locked
        || after.prunable != result.worktree.prunable
    {
        return Err(AppError::Other(
            "검사 중 워크트리가 변경되었습니다. 다시 확인하세요.".into(),
        ));
    }
    result.can_remove = result.blockers.is_empty();
    Ok(result)
}

fn process_cwd_is_within(target: &str) -> bool {
    let Ok(cwd) = std::env::current_dir() else {
        return true;
    };
    native_cwd_is_within(&cwd, target)
}

fn native_cwd_is_within(cwd: &std::path::Path, target: &str) -> bool {
    let Ok(cwd) = super::canonical::canonicalize_native_path(cwd) else {
        return true;
    };
    #[cfg(windows)]
    let (cwd, target) = (
        crate::path_utils::normalize_path_for_comparison(&cwd),
        crate::path_utils::normalize_path_for_comparison(target),
    );
    #[cfg(not(windows))]
    let (cwd, target) = (
        cwd.trim_end_matches('/').to_owned(),
        target.trim_end_matches('/').to_owned(),
    );
    cwd == target
        || cwd
            .strip_prefix(&target)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_directory_aliases_are_resolved_before_protection_check() {
        let temp = tempfile::tempdir().unwrap();
        let actual = temp.path().join("actual");
        std::fs::create_dir_all(actual.join("child")).unwrap();
        std::fs::create_dir(temp.path().join("other")).unwrap();
        let alias = temp.path().join("other/../actual/child");
        assert!(native_cwd_is_within(&alias, actual.to_str().unwrap()));
        assert!(!native_cwd_is_within(
            &temp.path().join("other"),
            actual.to_str().unwrap()
        ));
        assert!(native_cwd_is_within(
            &temp.path().join("missing"),
            actual.to_str().unwrap()
        ));
    }

    #[cfg(unix)]
    #[test]
    fn process_directory_symlinks_protect_the_actual_worktree() {
        let temp = tempfile::tempdir().unwrap();
        let actual = temp.path().join("actual");
        std::fs::create_dir_all(actual.join("child")).unwrap();
        let alias = temp.path().join("alias");
        std::os::unix::fs::symlink(&actual, &alias).unwrap();
        assert!(native_cwd_is_within(
            &alias.join("child"),
            actual.to_str().unwrap()
        ));
    }
}
