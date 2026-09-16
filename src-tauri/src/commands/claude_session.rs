use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::State;

use crate::state::AppState;

use super::session_attribution::{provider_terminal_domains, ProviderSessionLookup};
use super::wsl_agent_session::{resolve_wsl_agent_processes, WslAgentProcess, WslAgentProvider};

/// Resolve Claude Code session IDs for live Claude processes under owned PTYs.
///
/// The PTY descendant PID must match `~/.claude/sessions/<pid>.json`.
/// CWD is never an attribution fallback because multiple panes commonly share it.
#[tauri::command(async)]
pub fn get_claude_session_ids(
    session_max_age_hours: Option<u64>,
    state: State<Arc<AppState>>,
) -> Result<HashMap<String, Option<String>>, String> {
    get_claude_session_ids_impl(session_max_age_hours, &state)
}

pub(crate) fn get_claude_session_ids_impl(
    session_max_age_hours: Option<u64>,
    state: &AppState,
) -> Result<HashMap<String, Option<String>>, String> {
    Ok(get_claude_session_lookup_impl(session_max_age_hours, state)?.attributions)
}

pub(crate) fn get_claude_session_lookup_impl(
    session_max_age_hours: Option<u64>,
    state: &AppState,
) -> Result<ProviderSessionLookup, String> {
    let domains = provider_terminal_domains(state)?;
    let terminal_roots = domains.native_roots;
    let native_terminal_ids: HashSet<String> = terminal_roots
        .iter()
        .map(|(terminal_id, _)| terminal_id.clone())
        .collect();
    let mut failed_terminal_ids = HashSet::new();
    let native_descendants = if terminal_roots.is_empty() {
        Vec::new()
    } else {
        match crate::process_tree::try_snapshot_processes() {
            Ok(snapshot) => native_claude_candidates(&snapshot, terminal_roots),
            Err(error) => {
                failed_terminal_ids.extend(native_terminal_ids);
                tracing::warn!(%error, "native Claude process attribution failed");
                Vec::new()
            }
        }
    };
    let relevant_native_pids: HashSet<u32> = native_descendants
        .iter()
        .flat_map(|(_, descendants)| descendants.iter().copied())
        .collect();
    let session_files = if relevant_native_pids.is_empty() {
        Vec::new()
    } else {
        let sessions_dir = resolve_claude_sessions_dir();
        let session_lookup = read_claude_session_files_for_pids_detailed(
            &sessions_dir,
            session_max_age_hours,
            Some(&relevant_native_pids),
        );
        failed_terminal_ids.extend(affected_native_terminal_ids(
            &native_descendants,
            &session_lookup,
        ));
        session_lookup.sessions
    };
    let observed: Vec<String> = native_descendants
        .iter()
        .map(|(id, _)| id.clone())
        .collect();
    let candidates = native_descendants
        .into_iter()
        .filter_map(|(terminal_id, descendants)| {
            find_session_by_pids(&session_files, &descendants)
                .map(|session_id| (terminal_id, session_id))
        })
        .collect();
    let mut result = crate::process_tree::complete_agent_session_attributions(
        &observed,
        remove_duplicate_attributions(candidates),
    );
    match resolve_wsl_agent_processes(state, WslAgentProvider::Claude) {
        Ok(lookup) => {
            failed_terminal_ids.extend(lookup.failed_terminal_ids);
            for (terminal_id, process) in lookup.attributions {
                let session_id = match process {
                    Some(process) => {
                        match find_wsl_claude_session_checked(&process, session_max_age_hours) {
                            Ok(session_id) => session_id,
                            Err(error) => {
                                failed_terminal_ids.insert(terminal_id.clone());
                                tracing::warn!(%error, "WSL Claude session file lookup failed");
                                None
                            }
                        }
                    }
                    None => None,
                };
                result.insert(terminal_id, session_id);
            }
        }
        Err(error) => {
            failed_terminal_ids.extend(domains.wsl_terminal_ids);
            tracing::warn!(%error, "WSL Claude attribution failed");
        }
    }
    Ok(ProviderSessionLookup {
        attributions: crate::process_tree::reject_duplicate_session_attributions(result, "Claude"),
        failed_terminal_ids,
        rollout_absence: HashMap::new(),
        fresh_sessions: HashMap::new(),
    })
}

fn native_claude_candidates(
    snapshot: &[crate::process_tree::ProcessEntry],
    terminal_roots: Vec<(String, u32)>,
) -> Vec<(String, HashSet<u32>)> {
    terminal_roots
        .into_iter()
        .filter_map(|(terminal_id, root_pid)| {
            let (pid, app) =
                crate::process_tree::match_interactive_app_process(snapshot, root_pid)?;
            (app == "Claude").then_some((terminal_id, HashSet::from([pid])))
        })
        .collect()
}

fn find_wsl_claude_session_checked(
    process: &WslAgentProcess,
    session_max_age_hours: Option<u64>,
) -> Result<Option<String>, String> {
    let Some(directory) = process.claude_sessions_dir() else {
        return Ok(None);
    };
    let relevant_pids = HashSet::from([process.pid]);
    let (sessions, lookup_failed) = read_claude_session_files_for_pids_checked(
        &directory,
        session_max_age_hours,
        Some(&relevant_pids),
    );
    if lookup_failed {
        return Err(format!(
            "failed to read Claude session files from {}",
            directory.display()
        ));
    }
    Ok(find_session_by_pids(
        &sessions,
        &HashSet::from([process.pid]),
    ))
}

/// A parsed Claude session file entry.
#[derive(Debug, Clone)]
struct ClaudeSessionFile {
    pid: u32,
    session_id: String,
    started_at: u64,
}

/// Validate that a startup command override is safe to execute.
///
/// The only allowed form is `<configured claude command> --resume
/// <valid_session_id>`, where the command prefix is re-derived from settings on
/// disk (`claude.command`, normalized) instead of trusted from the caller.
/// External viewers use a structured IPC argument and are validated separately.
pub(crate) fn is_valid_claude_startup_command_override(
    cmd: &str,
    configured_command: &str,
) -> bool {
    let agent = crate::settings::agent_command::resolve_agent_command(
        configured_command,
        crate::settings::agent_command::DEFAULT_CLAUDE_COMMAND,
    );
    cmd.strip_prefix(&format!("{agent} --resume "))
        .is_some_and(is_valid_session_id)
}

/// Validate that an agent session ID starts with an alphanumeric character and
/// contains only alphanumerics, hyphens, or underscores. Shared with Codex.
pub(crate) fn is_valid_session_id(id: &str) -> bool {
    id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Resolve the Claude sessions directory path.
fn resolve_claude_sessions_dir() -> std::path::PathBuf {
    #[cfg(windows)]
    {
        if let Ok(home) = std::env::var("USERPROFILE") {
            return std::path::PathBuf::from(home)
                .join(".claude")
                .join("sessions");
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME") {
            return std::path::PathBuf::from(home)
                .join(".claude")
                .join("sessions");
        }
    }
    std::path::PathBuf::from(".claude").join("sessions")
}

/// Read and parse all Claude session files from the given directory.
/// If `max_age_hours` is Some, sessions older than the threshold are filtered out.
#[cfg(test)]
fn read_claude_session_files(
    dir: &std::path::Path,
    max_age_hours: Option<u64>,
) -> Vec<ClaudeSessionFile> {
    read_claude_session_files_checked(dir, max_age_hours).0
}

#[cfg(test)]
fn read_claude_session_files_checked(
    dir: &std::path::Path,
    max_age_hours: Option<u64>,
) -> (Vec<ClaudeSessionFile>, bool) {
    read_claude_session_files_for_pids_checked(dir, max_age_hours, None)
}

fn read_claude_session_files_for_pids_checked(
    dir: &std::path::Path,
    max_age_hours: Option<u64>,
    relevant_pids: Option<&HashSet<u32>>,
) -> (Vec<ClaudeSessionFile>, bool) {
    let lookup = read_claude_session_files_for_pids_detailed(dir, max_age_hours, relevant_pids);
    let lookup_failed = lookup.scope_failed || !lookup.failed_pids.is_empty();
    (lookup.sessions, lookup_failed)
}

struct ClaudeSessionFileLookup {
    sessions: Vec<ClaudeSessionFile>,
    failed_pids: HashSet<u32>,
    scope_failed: bool,
}

fn read_claude_session_files_for_pids_detailed(
    dir: &std::path::Path,
    max_age_hours: Option<u64>,
    relevant_pids: Option<&HashSet<u32>>,
) -> ClaudeSessionFileLookup {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ClaudeSessionFileLookup {
                sessions: Vec::new(),
                failed_pids: HashSet::new(),
                scope_failed: false,
            };
        }
        Err(error) => {
            tracing::warn!(path = %dir.display(), %error, "failed to read Claude sessions directory");
            return ClaudeSessionFileLookup {
                sessions: Vec::new(),
                failed_pids: HashSet::new(),
                scope_failed: true,
            };
        }
    };

    // Compute the cutoff timestamp (seconds since epoch) if max_age_hours is set.
    // 0 means "no filter" (accept all sessions regardless of age).
    let cutoff = max_age_hours.filter(|&hours| hours > 0).and_then(|hours| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs().saturating_sub(hours * 3600))
    });

    let mut result = Vec::new();
    let mut failed_pids = HashSet::new();
    let mut scope_failed = false;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                scope_failed = true;
                tracing::warn!(%error, "failed to read a Claude session directory entry");
                continue;
            }
        };
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let file_pid = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .and_then(|stem| stem.parse::<u32>().ok());
        if let Some(relevant_pids) = relevant_pids {
            if !file_pid.is_some_and(|pid| relevant_pids.contains(&pid)) {
                continue;
            }
        }
        match std::fs::read_to_string(&path)
            .map_err(|error| error.to_string())
            .and_then(|content| {
                serde_json::from_str::<serde_json::Value>(&content)
                    .map_err(|error| error.to_string())
            }) {
            Ok(val) => {
                let pid = val.get("pid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let session_id = val
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let started_at = val.get("startedAt").and_then(|v| v.as_u64()).unwrap_or(0);

                // Skip stale sessions
                if let Some(min_ts) = cutoff {
                    if started_at < min_ts {
                        continue;
                    }
                }

                if is_valid_session_id(&session_id) {
                    result.push(ClaudeSessionFile {
                        pid,
                        session_id,
                        started_at,
                    });
                }
            }
            Err(error) => {
                match file_pid {
                    Some(pid) => {
                        failed_pids.insert(pid);
                    }
                    None => scope_failed = true,
                }
                tracing::warn!(path = %path.display(), %error, "failed to parse Claude session file");
            }
        }
    }
    ClaudeSessionFileLookup {
        sessions: result,
        failed_pids,
        scope_failed,
    }
}

fn affected_native_terminal_ids(
    native_descendants: &[(String, HashSet<u32>)],
    lookup: &ClaudeSessionFileLookup,
) -> HashSet<String> {
    native_descendants
        .iter()
        .filter(|(_, descendants)| {
            lookup.scope_failed || !descendants.is_disjoint(&lookup.failed_pids)
        })
        .map(|(terminal_id, _)| terminal_id.clone())
        .collect()
}

/// Find a Claude session ID by matching any of the given PIDs against session file PIDs.
/// When multiple sessions match, the most recently started one wins.
fn find_session_by_pids(sessions: &[ClaudeSessionFile], pids: &HashSet<u32>) -> Option<String> {
    sessions
        .iter()
        .filter(|s| pids.contains(&s.pid))
        .max_by_key(|s| s.started_at)
        .map(|s| s.session_id.clone())
}

fn remove_duplicate_attributions(candidates: Vec<(String, String)>) -> HashMap<String, String> {
    let mut seen = HashSet::new();
    let mut duplicates = HashSet::new();
    for (_, session_id) in &candidates {
        if !seen.insert(session_id.clone()) {
            duplicates.insert(session_id.clone());
        }
    }
    if !duplicates.is_empty() {
        tracing::warn!(
            ?duplicates,
            "Claude session attribution collision; skipping restore"
        );
    }
    candidates
        .into_iter()
        .filter(|(_, session_id)| !duplicates.contains(session_id))
        .collect()
}

#[cfg(test)]
mod tests;
