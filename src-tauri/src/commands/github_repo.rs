//! Shared GitHub issue/PR snapshots for `GitHubView`.
//!
//! Every pane that shows the list is driven by the CWD it receives from its
//! sync group, so several panes routinely watch the *same* repository. The
//! snapshots therefore live in a process-wide registry keyed by
//! `owner/repo`: the first caller inside a refresh window runs `gh`, every
//! other caller — pane, worktree, or workspace — reads that result.
//! (ADR-0105)

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::lock_ext::MutexExt;

/// How long one repository's snapshot is served without re-running `gh`.
/// Panes poll on roughly this cadence; the registry is what keeps the process
/// count down when many of them watch one repository.
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(10);

/// Upper bound per list. The view is a watch surface, not an issue browser.
const LIST_LIMIT: u32 = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepoSnapshot {
    pub status: GithubRepoStatus,
    /// `owner/repo`, present whenever the working dir resolved to GitHub.
    pub repo: Option<String>,
    pub repo_url: Option<String>,
    pub issues: Vec<GithubItem>,
    pub pulls: Vec<GithubItem>,
    pub fetched_at_ms: Option<u64>,
}

impl GithubRepoSnapshot {
    fn failed(repo: Option<String>, repo_url: Option<String>, status: GithubRepoStatus) -> Self {
        Self {
            status,
            repo,
            repo_url,
            issues: Vec::new(),
            pulls: Vec::new(),
            fetched_at_ms: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GithubRepoStatus {
    Ready,
    /// The working dir has no GitHub `origin` — a normal display state, not an
    /// error: a pane may simply be parked outside a repository.
    NotAGithubRepo,
    GhMissing,
    Unauthorized,
    Failed {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubItem {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub url: String,
    pub updated_at: String,
    pub labels: Vec<String>,
    /// Always false for issues; a PR opened as a draft reports true.
    pub is_draft: bool,
}

// -- `gh --json` wire shapes -------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawItem {
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    author: Option<RawAuthor>,
    #[serde(default)]
    url: String,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    labels: Vec<RawLabel>,
    #[serde(default)]
    is_draft: bool,
}

#[derive(Debug, Deserialize)]
struct RawAuthor {
    #[serde(default)]
    login: String,
}

#[derive(Debug, Deserialize)]
struct RawLabel {
    #[serde(default)]
    name: String,
}

impl From<RawItem> for GithubItem {
    fn from(raw: RawItem) -> Self {
        Self {
            number: raw.number,
            title: raw.title,
            author: raw.author.map(|a| a.login).unwrap_or_default(),
            url: raw.url,
            updated_at: raw.updated_at,
            labels: raw.labels.into_iter().map(|l| l.name).collect(),
            is_draft: raw.is_draft,
        }
    }
}

fn parse_item_list(stdout: &str) -> Result<Vec<GithubItem>, String> {
    let raw: Vec<RawItem> = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("gh returned invalid JSON: {e}"))?;
    Ok(raw.into_iter().map(GithubItem::from).collect())
}

// -- Registry ----------------------------------------------------------------

struct RepoEntry {
    snapshot: Option<GithubRepoSnapshot>,
    fetched_at: Option<Instant>,
}

type Registry = Mutex<HashMap<String, Arc<Mutex<RepoEntry>>>>;

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The table lock is held only to hand out one repository's entry, never
/// across a `gh` run, so two repositories still refresh concurrently.
fn repo_entry(repo: &str) -> Result<Arc<Mutex<RepoEntry>>, String> {
    let mut table = registry().lock_or_err().map_err(|e| e.to_string())?;
    Ok(table
        .entry(repo.to_string())
        .or_insert_with(|| {
            Arc::new(Mutex::new(RepoEntry {
                snapshot: None,
                fetched_at: None,
            }))
        })
        .clone())
}

/// A cached snapshot is reused until it is `REFRESH_INTERVAL` old.
fn is_fresh(fetched_at: Option<Instant>, now: Instant) -> bool {
    fetched_at.is_some_and(|at| now.duration_since(at) < REFRESH_INTERVAL)
}

// -- gh invocation -----------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ItemKind {
    Issue,
    Pull,
}

impl ItemKind {
    fn gh_noun(self) -> &'static str {
        match self {
            ItemKind::Issue => "issue",
            ItemKind::Pull => "pr",
        }
    }
}

/// `gh {issue|pr} list` for one repository. The repo is always passed as
/// `--repo owner/repo` rather than inherited from a working directory, so the
/// registry key and the queried repository can never disagree — and the
/// command still works when the configured shell prefix runs `gh` inside WSL,
/// where the pane's Windows cwd would not exist.
fn build_list_args(kind: ItemKind, repo: &str) -> Vec<String> {
    let mut fields = "number,title,author,url,updatedAt,labels".to_string();
    if kind == ItemKind::Pull {
        fields.push_str(",isDraft");
    }
    vec![
        kind.gh_noun().to_string(),
        "list".to_string(),
        "--repo".to_string(),
        repo.to_string(),
        "--state".to_string(),
        "open".to_string(),
        "--limit".to_string(),
        LIST_LIMIT.to_string(),
        "--json".to_string(),
        fields,
    ]
}

/// Every mutating action the view offers. Parsed from the frontend string, so
/// an unknown action is rejected before any process is spawned — the view can
/// never talk `gh` into an operation this list does not name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemAction {
    CloseIssueCompleted,
    CloseIssueNotPlanned,
    MergePull,
    ClosePull,
}

fn parse_item_action(raw: &str) -> Result<ItemAction, String> {
    match raw {
        "issue.close" => Ok(ItemAction::CloseIssueCompleted),
        "issue.closeNotPlanned" => Ok(ItemAction::CloseIssueNotPlanned),
        "pr.merge" => Ok(ItemAction::MergePull),
        "pr.close" => Ok(ItemAction::ClosePull),
        other => Err(format!("Unknown GitHub action: {other}")),
    }
}

fn build_action_args(action: ItemAction, repo: &str, number: u64) -> Vec<String> {
    let mut args: Vec<String> = match action {
        ItemAction::CloseIssueCompleted | ItemAction::CloseIssueNotPlanned => {
            vec!["issue".into(), "close".into(), number.to_string()]
        }
        ItemAction::MergePull => vec!["pr".into(), "merge".into(), number.to_string()],
        ItemAction::ClosePull => vec!["pr".into(), "close".into(), number.to_string()],
    };
    args.push("--repo".into());
    args.push(repo.into());
    match action {
        ItemAction::CloseIssueNotPlanned => {
            args.push("--reason".into());
            args.push("not planned".into());
        }
        // `gh pr merge` is interactive without an explicit method; the view
        // offers the repository's ordinary merge-commit flow.
        ItemAction::MergePull => args.push("--merge".into()),
        _ => {}
    }
    args
}

struct GhOutput {
    stdout: String,
    stderr: String,
    success: bool,
}

#[derive(Debug)]
enum GhError {
    Missing,
    Unauthorized,
    Failed(String),
}

impl GhError {
    fn message(self) -> String {
        match self {
            GhError::Missing => "`gh` not found on PATH".to_string(),
            GhError::Unauthorized => "Run `gh auth login` first".to_string(),
            GhError::Failed(message) => message,
        }
    }
}

/// How a failed `gh` run should be shown. Kept as a pure mapping from stderr
/// so it stays testable: with a shell prefix configured (e.g. WSL) a missing
/// binary is reported by the wrapping shell, not by the spawn call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GhFailureKind {
    Missing,
    Unauthorized,
    Failed,
}

fn classify_gh_stderr(stderr: &str) -> GhFailureKind {
    let lower = stderr.to_lowercase();
    if lower.contains("not recognized as an internal or external command")
        || lower.contains("command not found")
        || lower.contains("no such file or directory")
    {
        return GhFailureKind::Missing;
    }
    if lower.contains("gh auth login")
        || lower.contains("authentication required")
        || lower.contains("not logged")
        || lower.contains("bad credentials")
    {
        return GhFailureKind::Unauthorized;
    }
    GhFailureKind::Failed
}

fn gh_error_from_stderr(stderr: &str) -> GhError {
    match classify_gh_stderr(stderr) {
        GhFailureKind::Missing => GhError::Missing,
        GhFailureKind::Unauthorized => GhError::Unauthorized,
        GhFailureKind::Failed => GhError::Failed(if stderr.is_empty() {
            "gh failed without a message".to_string()
        } else {
            stderr.to_string()
        }),
    }
}

fn run_gh(args: &[String]) -> Result<GhOutput, GhError> {
    let shell_prefix = crate::settings::load_settings().issue_reporter.shell;
    let output = super::misc::gh_command(&shell_prefix)
        .args(args)
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                GhError::Missing
            } else {
                GhError::Failed(e.to_string())
            }
        })?;
    Ok(GhOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        success: output.status.success(),
    })
}

fn list_items(kind: ItemKind, repo: &str) -> Result<Vec<GithubItem>, GhError> {
    let output = run_gh(&build_list_args(kind, repo))?;
    if !output.success {
        return Err(gh_error_from_stderr(&output.stderr));
    }
    parse_item_list(&output.stdout).map_err(GhError::Failed)
}

fn fetch_snapshot(repo: &str, repo_url: &str) -> GithubRepoSnapshot {
    let repo_owned = Some(repo.to_string());
    let url_owned = Some(repo_url.to_string());
    let issues = match list_items(ItemKind::Issue, repo) {
        Ok(items) => items,
        Err(error) => return snapshot_for_error(repo_owned, url_owned, error),
    };
    let pulls = match list_items(ItemKind::Pull, repo) {
        Ok(items) => items,
        Err(error) => return snapshot_for_error(repo_owned, url_owned, error),
    };
    GithubRepoSnapshot {
        status: GithubRepoStatus::Ready,
        repo: repo_owned,
        repo_url: url_owned,
        issues,
        pulls,
        fetched_at_ms: Some(now_ms()),
    }
}

fn snapshot_for_error(
    repo: Option<String>,
    repo_url: Option<String>,
    error: GhError,
) -> GithubRepoSnapshot {
    let status = match error {
        GhError::Missing => GithubRepoStatus::GhMissing,
        GhError::Unauthorized => GithubRepoStatus::Unauthorized,
        GhError::Failed(message) => GithubRepoStatus::Failed { message },
    };
    GithubRepoSnapshot::failed(repo, repo_url, status)
}

// -- Repository resolution ---------------------------------------------------

/// `https://github.com/owner/repo` → `owner/repo`.
fn slug_from_github_base(base: &str) -> Option<String> {
    let rest = base.strip_prefix("https://github.com/")?;
    let mut segments = rest.split('/').filter(|s| !s.is_empty());
    let owner = segments.next()?;
    let repo = segments.next()?;
    Some(format!("{owner}/{repo}"))
}

struct RepoRef {
    slug: String,
    url: String,
}

fn resolve_repo(working_dir: &str) -> Option<RepoRef> {
    let url = crate::git_watcher::resolve_github_base_from_working_dir(working_dir)?;
    let slug = slug_from_github_base(&url)?;
    Some(RepoRef { slug, url })
}

// -- Commands ----------------------------------------------------------------

fn snapshot_blocking(working_dir: String, force: bool) -> GithubRepoSnapshot {
    let Some(repo) = resolve_repo(&working_dir) else {
        return GithubRepoSnapshot::failed(None, None, GithubRepoStatus::NotAGithubRepo);
    };
    let failure = |message: String| {
        GithubRepoSnapshot::failed(
            Some(repo.slug.clone()),
            Some(repo.url.clone()),
            GithubRepoStatus::Failed { message },
        )
    };
    let entry = match repo_entry(&repo.slug) {
        Ok(entry) => entry,
        Err(message) => return failure(message),
    };
    // Holding the per-repo lock across the fetch is what collapses a burst of
    // pane polls into one `gh` run: latecomers block, then read the result the
    // first caller just stored.
    let mut guard = match entry.lock_or_err() {
        Ok(guard) => guard,
        Err(error) => return failure(error.to_string()),
    };
    if !force && is_fresh(guard.fetched_at, Instant::now()) {
        if let Some(snapshot) = guard.snapshot.clone() {
            return snapshot;
        }
    }
    let snapshot = fetch_snapshot(&repo.slug, &repo.url);
    guard.snapshot = Some(snapshot.clone());
    guard.fetched_at = Some(Instant::now());
    snapshot
}

/// Read the shared snapshot for the repository containing `working_dir`.
/// `force` skips the refresh window for an explicit user refresh.
#[tauri::command]
pub async fn get_github_repo_snapshot(working_dir: String, force: bool) -> GithubRepoSnapshot {
    tokio::task::spawn_blocking(move || snapshot_blocking(working_dir, force))
        .await
        .unwrap_or_else(|e| {
            GithubRepoSnapshot::failed(
                None,
                None,
                GithubRepoStatus::Failed {
                    message: format!("GitHub snapshot task failed: {e}"),
                },
            )
        })
}

fn run_action_blocking(working_dir: String, action: String, number: u64) -> Result<(), String> {
    let action = parse_item_action(&action)?;
    let repo = resolve_repo(&working_dir)
        .ok_or_else(|| "Not a GitHub repository for this working directory".to_string())?;
    let output =
        run_gh(&build_action_args(action, &repo.slug, number)).map_err(|error| error.message())?;
    if !output.success {
        return Err(gh_error_from_stderr(&output.stderr).message());
    }
    // The list this action just invalidated must not be served from the cache
    // again, or the closed item would linger for a whole refresh window.
    invalidate(&repo.slug);
    Ok(())
}

fn invalidate(repo: &str) {
    let Ok(entry) = repo_entry(repo) else { return };
    let Ok(mut guard) = entry.lock_or_err() else {
        return;
    };
    guard.snapshot = None;
    guard.fetched_at = None;
}

/// Apply one issue/PR action through `gh`. Mutating GitHub state is always a
/// direct consequence of a user's confirmed click in the view.
#[tauri::command]
pub async fn run_github_item_action(
    working_dir: String,
    action: String,
    number: u64,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || run_action_blocking(working_dir, action, number))
        .await
        .unwrap_or_else(|e| Err(format!("GitHub action task failed: {e}")))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_an_issue_list_payload() {
        let json = r#"[
            {"number":708,"title":"gh issue/pr list view","author":{"login":"kochul2000"},
             "url":"https://github.com/o/r/issues/708","updatedAt":"2026-08-01T00:00:00Z",
             "labels":[{"name":"enhancement"}]}
        ]"#;
        let items = parse_item_list(json).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].number, 708);
        assert_eq!(items[0].author, "kochul2000");
        assert_eq!(items[0].labels, vec!["enhancement".to_string()]);
        assert!(!items[0].is_draft);
    }

    #[test]
    fn parses_a_pull_list_with_draft_state_and_a_missing_author() {
        let json = r#"[
            {"number":12,"title":"wip","author":null,"url":"https://github.com/o/r/pull/12",
             "updatedAt":"2026-08-01T00:00:00Z","labels":[],"isDraft":true}
        ]"#;
        let items = parse_item_list(json).unwrap();
        assert!(items[0].is_draft);
        assert_eq!(items[0].author, "");
    }

    #[test]
    fn rejects_non_json_output() {
        assert!(parse_item_list("gh: command failed").is_err());
    }

    #[test]
    fn list_args_target_the_registry_repo_not_a_working_dir() {
        let args = build_list_args(ItemKind::Issue, "owner/repo");
        assert_eq!(args[0], "issue");
        let repo_at = args.iter().position(|a| a == "--repo").unwrap();
        assert_eq!(args[repo_at + 1], "owner/repo");
        assert!(!args.iter().any(|a| a.contains("isDraft")));
    }

    #[test]
    fn pull_list_args_request_the_draft_field() {
        let args = build_list_args(ItemKind::Pull, "owner/repo");
        assert_eq!(args[0], "pr");
        assert!(args.last().unwrap().contains("isDraft"));
    }

    #[test]
    fn close_not_planned_passes_the_reason_gh_expects() {
        let args = build_action_args(ItemAction::CloseIssueNotPlanned, "owner/repo", 7);
        assert_eq!(args[..3], ["issue", "close", "7"]);
        let reason_at = args.iter().position(|a| a == "--reason").unwrap();
        assert_eq!(args[reason_at + 1], "not planned");
    }

    #[test]
    fn close_completed_omits_a_reason() {
        let args = build_action_args(ItemAction::CloseIssueCompleted, "owner/repo", 7);
        assert!(!args.iter().any(|a| a == "--reason"));
    }

    #[test]
    fn merge_is_non_interactive() {
        let args = build_action_args(ItemAction::MergePull, "owner/repo", 9);
        assert_eq!(args[..3], ["pr", "merge", "9"]);
        assert!(args.iter().any(|a| a == "--merge"));
    }

    #[test]
    fn close_pull_uses_the_pr_noun() {
        let args = build_action_args(ItemAction::ClosePull, "owner/repo", 9);
        assert_eq!(args[..3], ["pr", "close", "9"]);
        assert!(!args.iter().any(|a| a == "--merge"));
    }

    #[test]
    fn unknown_actions_never_reach_gh() {
        assert!(parse_item_action("issue.delete").is_err());
        assert!(parse_item_action("pr.merge").is_ok());
    }

    #[test]
    fn a_snapshot_is_reused_only_inside_the_refresh_window() {
        let now = Instant::now();
        assert!(!is_fresh(None, now));
        assert!(is_fresh(Some(now), now));
        let expired = now.checked_sub(REFRESH_INTERVAL).expect("monotonic clock");
        assert!(!is_fresh(Some(expired), now));
    }

    #[test]
    fn repo_entries_are_shared_per_slug() {
        let a = repo_entry("owner/shared").unwrap();
        let b = repo_entry("owner/shared").unwrap();
        let c = repo_entry("owner/other").unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        assert!(!Arc::ptr_eq(&a, &c));
    }

    #[test]
    fn an_action_drops_the_repository_snapshot_so_the_next_poll_refetches() {
        let slug = "owner/invalidate";
        let entry = repo_entry(slug).unwrap();
        {
            let mut guard = entry.lock_or_err().unwrap();
            guard.snapshot = Some(GithubRepoSnapshot::failed(
                None,
                None,
                GithubRepoStatus::Ready,
            ));
            guard.fetched_at = Some(Instant::now());
        }
        invalidate(slug);
        let guard = entry.lock_or_err().unwrap();
        assert!(guard.snapshot.is_none());
        assert!(!is_fresh(guard.fetched_at, Instant::now()));
    }

    #[test]
    fn slug_is_extracted_from_the_normalized_github_base() {
        assert_eq!(
            slug_from_github_base("https://github.com/owner/repo").as_deref(),
            Some("owner/repo")
        );
        assert_eq!(slug_from_github_base("https://gitlab.com/owner/repo"), None);
        assert_eq!(slug_from_github_base("https://github.com/owner"), None);
    }

    #[test]
    fn classifies_gh_stderr_into_display_states() {
        assert_eq!(
            classify_gh_stderr("'gh' is not recognized as an internal or external command"),
            GhFailureKind::Missing
        );
        assert_eq!(
            classify_gh_stderr("gh auth login required"),
            GhFailureKind::Unauthorized
        );
        assert_eq!(classify_gh_stderr("HTTP 500"), GhFailureKind::Failed);
    }
}
