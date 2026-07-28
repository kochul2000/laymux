//! Build-time Git/worktree metadata discovery.
//!
//! This module reads Git administrative files directly instead of spawning a
//! process. `build.rs` includes it to inject immutable values, while the main
//! crate includes it only in tests so linked-worktree behavior stays covered.

use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Eq, PartialEq)]
pub struct BuildMetadata {
    pub worktree_root: PathBuf,
    pub git_commit: Option<String>,
    pub git_branch: Option<String>,
    pub rerun_paths: Vec<PathBuf>,
}

pub fn discover(worktree_root: &Path) -> BuildMetadata {
    let marker = worktree_root.join(".git");
    // A linked worktree's `.git` is a small pointer file whose content may be
    // repointed. A normal checkout's `.git` is a directory; watching it would
    // recursively include objects, FETCH_HEAD, index, and logs.
    let mut rerun_paths = marker
        .is_file()
        .then_some(marker.clone())
        .into_iter()
        .collect();
    let Some(git_dir) = resolve_git_dir(worktree_root, &marker) else {
        return BuildMetadata {
            worktree_root: worktree_root.to_path_buf(),
            git_commit: None,
            git_branch: None,
            rerun_paths,
        };
    };

    let common_dir_file = git_dir.join("commondir");
    if common_dir_file.is_file() {
        rerun_paths.push(common_dir_file.clone());
    }
    let common_dir = resolve_common_dir(&git_dir, &common_dir_file);
    let head_path = git_dir.join("HEAD");
    if head_path.is_file() {
        rerun_paths.push(head_path.clone());
    }
    // A commit on a packed branch creates a new loose ref without changing
    // either HEAD or packed-refs. The per-worktree HEAD reflog changes for
    // commits and checkouts, so it precisely invalidates that transition
    // without making Cargo watch the entire refs directory.
    let head_log_path = git_dir.join("logs/HEAD");
    if head_log_path.is_file() {
        rerun_paths.push(head_log_path);
    }
    let Some(head) = read_trimmed(&head_path) else {
        return BuildMetadata {
            worktree_root: worktree_root.to_path_buf(),
            git_commit: None,
            git_branch: None,
            rerun_paths,
        };
    };

    if is_object_id(&head) {
        return BuildMetadata {
            worktree_root: worktree_root.to_path_buf(),
            git_commit: Some(head),
            git_branch: None,
            rerun_paths,
        };
    }

    let Some(reference) = head.strip_prefix("ref: ") else {
        return BuildMetadata {
            worktree_root: worktree_root.to_path_buf(),
            git_commit: None,
            git_branch: None,
            rerun_paths,
        };
    };
    let branch = reference
        .strip_prefix("refs/heads/")
        .unwrap_or(reference)
        .to_string();
    let commit = read_reference(reference, &git_dir, &common_dir, &mut rerun_paths);

    BuildMetadata {
        worktree_root: worktree_root.to_path_buf(),
        git_commit: commit,
        git_branch: Some(branch),
        rerun_paths,
    }
}

fn resolve_git_dir(worktree_root: &Path, marker: &Path) -> Option<PathBuf> {
    if marker.is_dir() {
        return Some(marker.to_path_buf());
    }
    let value = read_trimmed(marker)?;
    let path = PathBuf::from(value.strip_prefix("gitdir: ")?);
    Some(if path.is_absolute() {
        path
    } else {
        worktree_root.join(path)
    })
}

fn resolve_common_dir(git_dir: &Path, common_dir_file: &Path) -> PathBuf {
    read_trimmed(common_dir_file)
        .map(PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                git_dir.join(path)
            }
        })
        .unwrap_or_else(|| git_dir.to_path_buf())
}

fn read_reference(
    reference: &str,
    git_dir: &Path,
    common_dir: &Path,
    rerun_paths: &mut Vec<PathBuf>,
) -> Option<String> {
    for base in [git_dir, common_dir] {
        let path = base.join(reference);
        if path.is_file() && !rerun_paths.contains(&path) {
            rerun_paths.push(path.clone());
        }
        if let Some(value) = read_trimmed(&path).filter(|value| is_object_id(value)) {
            return Some(value);
        }
    }

    let packed_refs = common_dir.join("packed-refs");
    if packed_refs.is_file() && !rerun_paths.contains(&packed_refs) {
        rerun_paths.push(packed_refs.clone());
    }
    let contents = fs::read_to_string(packed_refs).ok()?;
    contents.lines().find_map(|line| {
        let (object_id, packed_reference) = line.split_once(' ')?;
        (packed_reference == reference && is_object_id(object_id)).then(|| object_id.to_string())
    })
}

fn read_trimmed(path: &Path) -> Option<String> {
    let value = fs::read_to_string(path).ok()?;
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn is_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn reads_a_normal_worktree_reference() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let git_dir = root.join(".git");
        fs::create_dir_all(git_dir.join("refs/heads")).unwrap();
        fs::create_dir_all(git_dir.join("logs")).unwrap();
        fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(git_dir.join("logs/HEAD"), "normal worktree reflog\n").unwrap();
        fs::write(git_dir.join("refs/heads/main"), format!("{COMMIT}\n")).unwrap();

        let metadata = discover(root);

        assert_eq!(metadata.worktree_root, root);
        assert_eq!(metadata.git_commit.as_deref(), Some(COMMIT));
        assert_eq!(metadata.git_branch.as_deref(), Some("main"));
        assert!(!metadata.rerun_paths.contains(&git_dir));
        assert!(metadata.rerun_paths.contains(&git_dir.join("HEAD")));
        assert!(metadata.rerun_paths.contains(&git_dir.join("logs/HEAD")));
        assert!(metadata
            .rerun_paths
            .contains(&git_dir.join("refs/heads/main")));
        assert!(metadata.rerun_paths.iter().all(|path| path.exists()));
    }

    #[test]
    fn reads_a_linked_worktree_reference_from_the_common_dir() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("worktree");
        let common = temp.path().join("repo.git");
        let git_dir = common.join("worktrees/issue-625");
        fs::create_dir_all(common.join("refs/heads/fix")).unwrap();
        fs::create_dir_all(git_dir.join("logs")).unwrap();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(".git"),
            format!("gitdir: {}\n", git_dir.display()),
        )
        .unwrap();
        fs::write(git_dir.join("commondir"), "../..\n").unwrap();
        fs::write(git_dir.join("HEAD"), "ref: refs/heads/fix/625\n").unwrap();
        fs::write(git_dir.join("logs/HEAD"), "linked worktree reflog\n").unwrap();
        fs::write(common.join("refs/heads/fix/625"), format!("{COMMIT}\n")).unwrap();

        let metadata = discover(&root);

        assert_eq!(metadata.git_commit.as_deref(), Some(COMMIT));
        assert_eq!(metadata.git_branch.as_deref(), Some("fix/625"));
        assert!(metadata.rerun_paths.contains(&root.join(".git")));
        assert!(metadata.rerun_paths.contains(&git_dir.join("HEAD")));
        assert!(metadata.rerun_paths.contains(&git_dir.join("logs/HEAD")));
        assert!(metadata
            .rerun_paths
            .iter()
            .any(|path| path.ends_with("refs/heads/fix/625")));
        assert!(metadata.rerun_paths.iter().all(|path| path.is_file()));
    }

    #[test]
    fn reads_a_detached_head_without_inventing_a_branch() {
        let temp = tempfile::tempdir().unwrap();
        let git_dir = temp.path().join(".git");
        fs::create_dir_all(&git_dir).unwrap();
        fs::write(git_dir.join("HEAD"), format!("{COMMIT}\n")).unwrap();

        let metadata = discover(temp.path());

        assert_eq!(metadata.git_commit.as_deref(), Some(COMMIT));
        assert_eq!(metadata.git_branch, None);
    }

    #[test]
    fn packed_ref_watches_head_reflog_for_its_loose_successor() {
        let temp = tempfile::tempdir().unwrap();
        let git_dir = temp.path().join(".git");
        fs::create_dir_all(git_dir.join("refs")).unwrap();
        fs::create_dir_all(git_dir.join("logs")).unwrap();
        fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(
            git_dir.join("logs/HEAD"),
            format!("{COMMIT} {COMMIT} Test <test@example.com> 0 +0000\tcommit\n"),
        )
        .unwrap();
        fs::write(
            git_dir.join("packed-refs"),
            format!("# pack-refs with: peeled fully-peeled\n{COMMIT} refs/heads/main\n"),
        )
        .unwrap();

        let metadata = discover(temp.path());

        assert_eq!(metadata.git_commit.as_deref(), Some(COMMIT));
        assert_eq!(metadata.git_branch.as_deref(), Some("main"));
        assert!(!metadata.rerun_paths.contains(&git_dir));
        assert!(!metadata.rerun_paths.contains(&git_dir.join("refs")));
        assert!(metadata.rerun_paths.contains(&git_dir.join("HEAD")));
        assert!(metadata.rerun_paths.contains(&git_dir.join("logs/HEAD")));
        assert!(metadata.rerun_paths.contains(&git_dir.join("packed-refs")));
        assert!(metadata.rerun_paths.iter().all(|path| path.is_file()));
    }

    #[test]
    fn source_archive_has_no_git_identity_or_missing_watch_path() {
        let temp = tempfile::tempdir().unwrap();

        let metadata = discover(temp.path());

        assert_eq!(metadata.git_commit, None);
        assert_eq!(metadata.git_branch, None);
        assert!(metadata.rerun_paths.is_empty());
    }
}
