use super::{git, Repository};
use crate::worktree::main_worktree_cwd;

#[test]
fn inherited_worktree_cwd_preserves_subdirectories_or_falls_back_to_main_root() {
    let repo = Repository::new();
    let linked = repo.add("linked");
    std::fs::create_dir_all(repo.main.join("ui/한 글")).unwrap();
    std::fs::create_dir_all(linked.join("ui/한 글")).unwrap();
    let resolved = main_worktree_cwd(linked.join("ui/한 글").to_str().unwrap())
        .unwrap()
        .unwrap();
    assert!(
        std::path::Path::new(&resolved).canonicalize().unwrap()
            == repo.main.join("ui/한 글").canonicalize().unwrap()
    );
    std::fs::create_dir_all(linked.join("only-linked")).unwrap();
    let resolved = main_worktree_cwd(linked.join("only-linked").to_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        std::path::Path::new(&resolved).canonicalize().unwrap(),
        repo.main.canonicalize().unwrap()
    );
}

#[test]
fn main_checkout_and_non_repository_do_not_change_cwd() {
    let repo = Repository::new();
    std::fs::create_dir(repo.main.join("ui")).unwrap();
    assert!(main_worktree_cwd(repo.main.join("ui").to_str().unwrap())
        .unwrap()
        .is_none());
    assert!(main_worktree_cwd(repo.temp.path().to_str().unwrap()).is_err());
}

#[test]
fn main_worktree_remains_main_after_default_branch_is_renamed() {
    let repo = Repository::new();
    git(&repo.main, &["branch", "-m", "renamed"]);
    let linked = repo.add("other");
    let resolved = main_worktree_cwd(linked.to_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        std::path::Path::new(&resolved).canonicalize().unwrap(),
        repo.main.canonicalize().unwrap()
    );
}
