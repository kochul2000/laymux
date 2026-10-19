use super::*;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = crate::process::headless_command("git")
        .args(["-c", "core.hooksPath=", "-c", "commit.gpgSign=false"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

struct Repository {
    temp: TempDir,
    main: PathBuf,
}

impl Repository {
    fn new() -> Self {
        let temp = TempDir::new().unwrap();
        let main = temp.path().join("main repo");
        std::fs::create_dir(&main).unwrap();
        git(&main, &["init", "-b", "main"]);
        git(&main, &["config", "user.name", "Worktree test"]);
        git(&main, &["config", "user.email", "worktree@example.invalid"]);
        std::fs::write(main.join("tracked.txt"), "initial\n").unwrap();
        std::fs::write(main.join(".gitignore"), "*.secret\nignored/\n").unwrap();
        git(&main, &["add", "."]);
        git(&main, &["commit", "-m", "initial"]);
        Self { temp, main }
    }

    fn add(&self, name: &str) -> PathBuf {
        let path = self.temp.path().join(name);
        git(
            &self.main,
            &["worktree", "add", "-b", name, path.to_str().unwrap()],
        );
        path
    }

    fn cwd(&self) -> &str {
        self.main.to_str().unwrap()
    }

    fn inspect(&self, path: &Path) -> WorktreeInspection {
        inspect(self.cwd(), path.to_str().unwrap()).unwrap()
    }
}

#[test]
fn lists_linked_worktrees_from_a_nested_directory() {
    let repo = Repository::new();
    let linked = repo.add("feature");
    let nested = linked.join("nested");
    std::fs::create_dir(&nested).unwrap();
    let result = snapshot(nested.to_str().unwrap()).unwrap();
    assert_eq!(result.worktrees.len(), 2);
    assert!(result.worktrees[0].is_main);
    assert_eq!(result.worktrees[1].branch.as_deref(), Some("feature"));
    assert!(!result.worktrees[1].is_main);
    assert!(result
        .common_dir
        .replace('\\', "/")
        .ends_with("main repo/.git"));
}

#[test]
fn clean_removal_preserves_branch_and_commits() {
    let repo = Repository::new();
    let linked = repo.add("clean");
    let before = repo.inspect(&linked);
    assert!(before.can_remove, "{:?}", before.blockers);
    assert!(before.upstream.is_none());
    remove(repo.cwd(), linked.to_str().unwrap(), &before.worktree.head).unwrap();
    assert!(!linked.exists());
    assert_eq!(
        git(&repo.main, &["rev-parse", "clean"]),
        before.worktree.head
    );
    assert_eq!(snapshot(repo.cwd()).unwrap().worktrees.len(), 1);
}

#[test]
fn dirty_untracked_and_ignored_files_are_visible_and_protected() {
    let repo = Repository::new();
    let linked = repo.add("dirty");
    std::fs::write(linked.join("tracked.txt"), "modified\n").unwrap();
    std::fs::write(linked.join("untracked.txt"), "local\n").unwrap();
    std::fs::write(linked.join("credentials.secret"), "local\n").unwrap();
    let result = repo.inspect(&linked);
    assert_eq!(
        (
            result.tracked_changes,
            result.untracked_files,
            result.ignored_files
        ),
        (1, 1, 1)
    );
    assert_eq!(result.files.len(), 3);
    for reason in ["tracked_changes", "untracked_files", "ignored_files"] {
        assert!(result.blockers.iter().any(|item| item == reason));
    }
    assert!(remove(repo.cwd(), linked.to_str().unwrap(), &result.worktree.head).is_err());
    assert!(linked.join("credentials.secret").exists());
}

#[test]
fn removal_rechecks_head_and_files_after_the_preview() {
    let repo = Repository::new();
    let linked = repo.add("changed");
    let before = repo.inspect(&linked);
    assert!(remove(repo.cwd(), linked.to_str().unwrap(), "old-head").is_err());
    std::fs::write(linked.join("later.secret"), "keep").unwrap();
    assert!(remove(repo.cwd(), linked.to_str().unwrap(), &before.worktree.head).is_err());
    assert!(linked.join("later.secret").exists());
}

#[test]
fn main_current_and_locked_worktrees_cannot_be_removed() {
    let repo = Repository::new();
    assert!(repo.inspect(&repo.main).blockers.contains(&"main".into()));
    let linked = repo.add("locked");
    let head = repo.inspect(&linked).worktree.head;
    let current = inspect(linked.to_str().unwrap(), linked.to_str().unwrap()).unwrap();
    assert!(current.blockers.contains(&"current_directory".into()));
    git(
        &repo.main,
        &[
            "worktree",
            "lock",
            "--reason",
            "keep me",
            linked.to_str().unwrap(),
        ],
    );
    let locked = repo.inspect(&linked);
    assert_eq!(locked.worktree.locked.as_deref(), Some("keep me"));
    assert!(locked.blockers.contains(&"locked".into()));
    assert!(remove(repo.cwd(), linked.to_str().unwrap(), &head).is_err());
}

#[test]
fn targets_must_be_exact_members_of_the_same_repository() {
    let repo = Repository::new();
    let other = Repository::new();
    assert!(inspect(repo.cwd(), other.cwd()).is_err());
    let linked = repo.add("member");
    let nested = linked.join("child");
    std::fs::create_dir(&nested).unwrap();
    assert!(inspect(repo.cwd(), nested.to_str().unwrap()).is_err());
    assert!(remove(repo.cwd(), other.cwd(), "anything").is_err());
    assert!(other.main.exists());
}

#[test]
fn detached_worktrees_cannot_be_removed() {
    let repo = Repository::new();
    let linked = repo.add("detached");
    git(&linked, &["checkout", "--detach"]);
    let result = repo.inspect(&linked);
    assert!(result.blockers.contains(&"detached".into()));
    assert!(!result.can_remove);
}

#[test]
fn upstream_counts_are_local_information_without_network_access() {
    let repo = Repository::new();
    let linked = repo.add("ahead");
    git(&linked, &["branch", "--set-upstream-to=main"]);
    git(&linked, &["commit", "--allow-empty", "-m", "ahead"]);
    let result = repo.inspect(&linked);
    assert_eq!(result.upstream.as_deref(), Some("main"));
    assert_eq!(result.ahead, Some(1));
    assert_eq!(result.behind, Some(0));
    assert!(result.can_remove);
}

#[test]
fn failed_inspection_is_not_a_clean_worktree() {
    let repo = Repository::new();
    let linked = repo.add("missing");
    std::fs::remove_file(linked.join(".git")).unwrap();
    assert!(!matches!(repo.inspect_result(&linked), Ok(value) if value.can_remove));
}

#[test]
fn hidden_index_changes_are_protected() {
    let repo = Repository::new();
    for (name, flag) in [
        ("assumed", "--assume-unchanged"),
        ("skipped", "--skip-worktree"),
    ] {
        let linked = repo.add(name);
        git(&linked, &["update-index", flag, "tracked.txt"]);
        std::fs::write(linked.join("tracked.txt"), "hidden change\n").unwrap();
        let result = repo.inspect(&linked);
        assert!(result.blockers.contains(&"index_flags".into()));
        assert!(remove(repo.cwd(), linked.to_str().unwrap(), &result.worktree.head).is_err());
        assert_eq!(
            std::fs::read_to_string(linked.join("tracked.txt")).unwrap(),
            "hidden change\n"
        );
    }
}

#[test]
fn submodules_are_protected_even_without_local_modifications() {
    let repo = Repository::new();
    let linked = repo.add("submodule");
    let head = git(&linked, &["rev-parse", "HEAD"]);
    git(
        &linked,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            "160000",
            &head,
            "nested-module",
        ],
    );
    git(&linked, &["commit", "-m", "submodule"]);
    let result = repo.inspect(&linked);
    assert!(result.blockers.contains(&"submodules".into()));
    assert!(!result.can_remove);
}

#[test]
fn ignored_directories_are_counted_as_files_and_never_removed() {
    let repo = Repository::new();
    let linked = repo.add("ignored-files");
    std::fs::create_dir(linked.join("ignored")).unwrap();
    std::fs::write(linked.join("ignored/one"), "one").unwrap();
    std::fs::write(linked.join("ignored/two"), "two").unwrap();
    let result = repo.inspect(&linked);
    assert_eq!(result.ignored_files, 2);
    assert!(!result.can_remove);
}

#[test]
fn final_guard_can_reject_after_git_inspection() {
    let repo = Repository::new();
    let linked = repo.add("guarded");
    let entry = repo.inspect(&linked).worktree;
    let result = super::service::remove_with_guard(
        repo.cwd(),
        linked.to_str().unwrap(),
        &entry.head,
        |validated_path| {
            assert_eq!(
                validated_path, entry.path,
                "usage checks receive Git's canonical member path, not the input alias"
            );
            Err(crate::error::AppError::Other("now in use".into()))
        },
    );
    assert!(result.unwrap_err().to_string().contains("now in use"));
    assert!(linked.exists());
}

#[test]
fn renamed_paths_keep_unicode_and_spaces_without_double_counting() {
    let repo = Repository::new();
    let linked = repo.temp.path().join("한글 worktree");
    git(
        &repo.main,
        &["worktree", "add", "-b", "rename", linked.to_str().unwrap()],
    );
    git(&linked, &["mv", "tracked.txt", "한글 renamed file.txt"]);
    let result = repo.inspect(&linked);
    assert_eq!(result.tracked_changes, 1);
    assert_eq!(result.files[0].path, "한글 renamed file.txt");
    assert_eq!(result.files[0].kind, "tracked");
    assert!(!result.can_remove);
}

#[test]
fn long_file_lists_keep_total_counts_and_mark_the_preview_as_truncated() {
    let repo = Repository::new();
    let linked = repo.add("many-files");
    for index in 0..300 {
        std::fs::write(linked.join(format!("local-{index}.txt")), "local").unwrap();
    }
    let result = repo.inspect(&linked);
    assert_eq!(result.untracked_files, 300);
    assert!(result.files.len() < 300);
    assert!(result.files_truncated);
    assert!(!result.can_remove);
}

#[test]
fn bare_repository_can_inspect_and_remove_its_linked_worktree() {
    let repo = Repository::new();
    let bare = repo.temp.path().join("bare.git");
    git(
        &repo.main,
        &["clone", "--bare", repo.cwd(), bare.to_str().unwrap()],
    );
    let linked = repo.temp.path().join("bare-linked");
    git(
        &bare,
        &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
    );
    let listed = snapshot(bare.to_str().unwrap()).unwrap();
    assert!(listed.worktrees[0].bare);
    let inspected = inspect(bare.to_str().unwrap(), linked.to_str().unwrap()).unwrap();
    assert!(inspected.can_remove, "{:?}", inspected.blockers);
    remove(
        bare.to_str().unwrap(),
        linked.to_str().unwrap(),
        &inspected.worktree.head,
    )
    .unwrap();
    assert!(!linked.exists());
    assert_eq!(
        git(&bare, &["rev-parse", "linked"]),
        inspected.worktree.head
    );
}

impl Repository {
    fn inspect_result(&self, path: &Path) -> Result<WorktreeInspection, crate::error::AppError> {
        inspect(self.cwd(), path.to_str().unwrap())
    }
}
