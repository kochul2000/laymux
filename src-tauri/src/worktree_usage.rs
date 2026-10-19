//! Worktree usage combines live terminals, saved panes and daemon inventory.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::constants::{FILE_VIEWER_TERMINAL_ID_PREFIX, TERMINAL_ID_PREFIX};
use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::pty_daemon::{self, KnownTerminals, PtySessionInventory, PtySessionState};
use crate::settings::Settings;
use crate::state::AppState;
use crate::terminal::InitialExecutionHost;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageKind {
    Live,
    Saved,
    Daemon,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeUsage {
    pub terminal_id: Option<String>,
    pub pane_id: Option<String>,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    pub cwd: String,
    pub kind: UsageKind,
    pub agent_type: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub usage: Vec<WorktreeUsage>,
    pub warnings: Vec<String>,
    pub complete: bool,
}

struct LiveTerminal {
    id: String,
    cwd: Option<String>,
    distro: Option<String>,
    command_line: String,
    host: InitialExecutionHost,
    agent_type: Option<String>,
}

/// Read each AppState collection briefly; disk and daemon IPC run without guards.
pub fn collect_usage(state: &AppState) -> Result<UsageSnapshot, AppError> {
    let settings = crate::settings::load_settings_checked().map_err(AppError::Other)?;
    let mut live: Vec<_> = {
        let terminals = state.terminals.lock_or_err()?;
        terminals
            .values()
            .map(|terminal| LiveTerminal {
                id: terminal.id.clone(),
                cwd: terminal.cwd.clone(),
                distro: terminal.wsl_distro.clone(),
                command_line: terminal.config.command_line.clone(),
                host: terminal.initial_execution_host,
                agent_type: None,
            })
            .collect()
    };
    let claude = state.known_claude_terminals.lock_or_err()?.clone();
    let codex = state.known_codex_terminals.lock_or_err()?.clone();
    let grok = state.known_grok_terminals.lock_or_err()?.clone();
    for terminal in &mut live {
        terminal.agent_type = if claude.contains(&terminal.id) {
            Some("claude")
        } else if codex.contains(&terminal.id) {
            Some("codex")
        } else if grok.contains(&terminal.id) {
            Some("grok")
        } else {
            None
        }
        .map(str::to_owned);
    }
    let panes = state.pty_handles.lock_or_err()?.keys().cloned().collect();
    let adoption_seen = state.pty_daemon_adoption_seen.lock_or_err()?.clone();
    let known = KnownTerminals {
        panes,
        layout: saved_views(&settings)
            .into_iter()
            .map(|view| format!("{TERMINAL_ID_PREFIX}{}", view.id))
            .collect(),
        adoption_seen,
        adopts: pty_daemon::is_enabled(),
        file_viewer_open: settings
            .local_ui_state
            .as_ref()
            .and_then(|ui| ui.file_viewer.as_ref())
            .is_some_and(|viewer| viewer.open && !viewer.path.is_empty()),
    };
    let inventory = pty_daemon::inventory(&known).map_err(AppError::Other)?;
    Ok(resolve_usage_paths(
        assemble_usage(live, &settings, &inventory, cfg!(windows)),
        crate::worktree::canonicalize_host_path,
    ))
}

struct SavedView<'a> {
    id: &'a str,
    workspace_id: Option<&'a str>,
    workspace_name: Option<&'a str>,
    view: &'a serde_json::Value,
}

fn saved_views(settings: &Settings) -> Vec<SavedView<'_>> {
    let mut result = Vec::new();
    for workspace in &settings.workspaces {
        for pane in &workspace.panes {
            for (id, view) in pane.content_views() {
                if view.view_type == "TerminalView" {
                    result.push(SavedView {
                        id,
                        workspace_id: Some(&workspace.id),
                        workspace_name: Some(&workspace.name),
                        view: &view.extra,
                    });
                }
            }
        }
    }
    for dock in &settings.docks {
        for pane in &dock.panes {
            if pane.view["type"].as_str() == Some("TerminalView") {
                result.push(SavedView {
                    id: &pane.id,
                    workspace_id: None,
                    workspace_name: None,
                    view: &pane.view,
                });
            }
        }
    }
    result
}

fn assemble_usage(
    live: Vec<LiveTerminal>,
    settings: &Settings,
    inventory: &PtySessionInventory,
    windows: bool,
) -> UsageSnapshot {
    let views = saved_views(settings);
    let by_terminal: HashMap<_, _> = views
        .iter()
        .map(|view| (format!("{TERMINAL_ID_PREFIX}{}", view.id), view))
        .collect();
    // Even an unknown/remote live CWD supersedes a previous saved CWD.
    let live_ids: HashSet<_> = live.iter().map(|terminal| terminal.id.clone()).collect();
    let mut usage = Vec::new();
    let mut warnings = Vec::new();
    let default_profile = if settings.default_profile.is_empty() {
        Settings::default().default_profile
    } else {
        settings.default_profile.clone()
    };
    for terminal in live {
        if terminal.host == InitialExecutionHost::DirectSsh {
            continue;
        }
        let cwd = terminal
            .cwd
            .as_deref()
            .ok_or_else(|| "현재 CWD가 아직 확인되지 않았습니다".to_owned())
            .and_then(|cwd| {
                local_path(
                    cwd,
                    terminal.distro.as_deref(),
                    &terminal.command_line,
                    windows,
                )
            });
        match cwd {
            Ok(cwd) => {
                let mut entry =
                    view_usage(by_terminal.get(&terminal.id).copied(), cwd, UsageKind::Live);
                if entry.pane_id.is_none()
                    && !terminal.id.starts_with(FILE_VIEWER_TERMINAL_ID_PREFIX)
                {
                    entry.pane_id = terminal
                        .id
                        .strip_prefix(TERMINAL_ID_PREFIX)
                        .filter(|id| !id.is_empty())
                        .map(str::to_owned);
                }
                entry.terminal_id = Some(terminal.id);
                entry.agent_type = terminal.agent_type;
                usage.push(entry);
            }
            Err(error) => warnings.push(format!("{}: {error}", terminal.id)),
        }
    }
    for view in &views {
        let id = format!("{TERMINAL_ID_PREFIX}{}", view.id);
        if live_ids.contains(&id) {
            continue;
        }
        // Match ViewRenderer: an absent/empty view profile uses the configured
        // default, then the application's default profile.
        let profile_name = view.view["profile"]
            .as_str()
            .filter(|name| !name.is_empty())
            .unwrap_or(&default_profile);
        let profile = settings
            .profiles
            .iter()
            .find(|profile| profile.name == profile_name);
        let command_line = profile
            .map(|profile| profile.command_line.as_str())
            .unwrap_or("");
        let executable = command_line
            .split_whitespace()
            .next()
            .unwrap_or("")
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("");
        if executable.eq_ignore_ascii_case("ssh") || executable.eq_ignore_ascii_case("ssh.exe") {
            continue;
        }
        let Some(cwd) = view.view["lastCwd"]
            .as_str()
            .filter(|cwd| !cwd.is_empty())
            .or_else(|| {
                profile
                    .map(|profile| profile.starting_directory.as_str())
                    .filter(|cwd| !cwd.is_empty())
            })
        else {
            continue;
        };
        match local_path(cwd, view.view["wslDistro"].as_str(), command_line, windows) {
            Ok(cwd) => usage.push(view_usage(Some(view), cwd, UsageKind::Saved)),
            Err(error) => warnings.push(format!("{id} (복원 대상): {error}")),
        }
    }
    for session in &inventory.sessions {
        if session.state == PtySessionState::Pane && live_ids.contains(&session.terminal_id) {
            continue;
        }
        // A saved path is useful to show/protect, but cannot establish where a
        // detached child is now. Display history is not operational evidence.
        if let Some(entry) = usage.iter_mut().find(|entry| {
            entry.terminal_id.as_deref() == Some(session.terminal_id.as_str())
                && entry.kind == UsageKind::Saved
        }) {
            entry.kind = UsageKind::Daemon;
        }
        // Ending merges an exited child with an asynchronous termination
        // request. A failed teardown can leave that request set while the child
        // is alive, so it cannot release the worktree's usage protection.
        let reason = if session.state == PtySessionState::Ending {
            "종료 요청된 PTY의 종료 완료를 확인할 수 없습니다"
        } else {
            "연결되지 않은 PTY의 현재 CWD를 확인할 수 없습니다"
        };
        warnings.push(format!(
            "{} ({}): {reason}",
            session.terminal_id, session.daemon
        ));
    }
    for daemon in &inventory.unavailable_daemons {
        warnings.push(format!(
            "{}: PTY 데몬의 사용 정보를 확인할 수 없습니다",
            daemon.daemon
        ));
    }
    warnings.sort();
    warnings.dedup();
    usage.sort_by(|left, right| {
        (left.kind as u8, &left.terminal_id).cmp(&(right.kind as u8, &right.terminal_id))
    });
    UsageSnapshot {
        usage,
        complete: warnings.is_empty(),
        warnings,
    }
}

fn resolve_usage_paths(
    mut snapshot: UsageSnapshot,
    resolve: impl Fn(&str) -> Result<String, AppError>,
) -> UsageSnapshot {
    let mut resolved: HashMap<String, Result<String, String>> = HashMap::new();
    for usage in &mut snapshot.usage {
        let result = resolved
            .entry(usage.cwd.clone())
            .or_insert_with(|| resolve(&usage.cwd).map_err(|error| error.to_string()));
        match result {
            Ok(path) => usage.cwd = path.clone(),
            Err(error) => {
                snapshot.complete = false;
                snapshot.warnings.push(format!(
                    "{}: CWD의 실제 경로를 확인할 수 없습니다: {error}",
                    usage.terminal_id.as_deref().unwrap_or(&usage.cwd)
                ));
            }
        }
    }
    snapshot.warnings.sort();
    snapshot.warnings.dedup();
    snapshot
}

fn view_usage(view: Option<&SavedView<'_>>, cwd: String, kind: UsageKind) -> WorktreeUsage {
    WorktreeUsage {
        terminal_id: view.map(|view| format!("{TERMINAL_ID_PREFIX}{}", view.id)),
        pane_id: view.map(|view| view.id.to_owned()),
        workspace_id: view.and_then(|view| view.workspace_id).map(str::to_owned),
        workspace_name: view.and_then(|view| view.workspace_name).map(str::to_owned),
        cwd,
        kind,
        agent_type: None,
    }
}

fn local_path(
    cwd: &str,
    distro: Option<&str>,
    command_line: &str,
    windows: bool,
) -> Result<String, String> {
    if cwd.is_empty() {
        return Err("CWD가 비어 있습니다".into());
    }
    if !windows {
        return if cwd.starts_with('/') {
            Ok(cwd.to_owned())
        } else {
            Err("CWD가 절대 경로가 아닙니다".into())
        };
    }
    // A slash-rooted guest path can contain a literal Linux backslash. Native
    // drive/backslash UNC forms alone use that character as a separator.
    let path = if cwd.starts_with('/') {
        cwd.to_owned()
    } else {
        cwd.replace('\\', "/")
    };
    if path.starts_with("//")
        || (path.len() >= 3 && path.as_bytes()[1] == b':' && path.as_bytes()[2] == b'/')
    {
        return Ok(path);
    }
    if let Some(native) = (!path.contains('\\'))
        .then(|| crate::path_utils::mnt_path_to_windows(&path))
        .flatten()
    {
        return Ok(native.replace('\\', "/"));
    }
    if path.starts_with('/') {
        let (distro, _) = crate::wsl_probe::terminal_distro_target(distro, command_line)?;
        let distro = distro.ok_or("WSL 배포판을 확인할 수 없어 CWD를 연결하지 않았습니다")?;
        return Ok(format!("//wsl.localhost/{distro}{path}"));
    }
    Err("CWD가 확인 가능한 절대 경로가 아닙니다".into())
}

pub fn usage_for_path(usage: &[WorktreeUsage], path: &str) -> Vec<WorktreeUsage> {
    let target = canonical_or_original(path);
    usage
        .iter()
        .filter(|entry| path_is_within(&entry.cwd, &target, cfg!(windows)))
        .cloned()
        .collect()
}

fn canonical_or_original(path: &str) -> String {
    if cfg!(windows) && path.starts_with('/') && path.contains('\\') {
        let lower = path.to_ascii_lowercase();
        if !path.starts_with("//")
            || lower.starts_with("//wsl.localhost/")
            || lower.starts_with("//wsl$/")
            || lower.starts_with("//?/unc/wsl.localhost/")
            || lower.starts_with("//?/unc/wsl$/")
        {
            // Win32 would reinterpret the literal as a directory separator.
            // These are already guest-resolved worktree paths, so retain them.
            return path.to_owned();
        }
    }
    let native = if cfg!(windows) {
        crate::path_utils::resolve_path_for_windows(path, None)
    } else {
        path.to_owned()
    };
    std::fs::canonicalize(&native)
        .ok()
        .and_then(|path| path.to_str().map(str::to_owned))
        .unwrap_or(native)
}

fn path_is_within(candidate: &str, root: &str, windows: bool) -> bool {
    let candidate = path_key(candidate, windows);
    let root = path_key(root, windows);
    !root.is_empty()
        && (candidate == root
            || candidate
                .strip_prefix(&root)
                .is_some_and(|tail| tail.starts_with('/') || root == "/"))
}

fn path_key(path: &str, windows: bool) -> String {
    let mut path = if windows && !path.starts_with('/') {
        path.replace('\\', "/")
    } else {
        path.to_owned()
    };
    if let Some(rest) = path.strip_prefix("//?/UNC/") {
        path = format!("//{rest}");
    } else if let Some(rest) = path.strip_prefix("//?/") {
        path = rest.to_owned();
    }
    if windows {
        for prefix in ["//wsl.localhost/", "//wsl$/"] {
            if path.to_ascii_lowercase().starts_with(prefix) {
                let rest = &path[prefix.len()..];
                let (distro, suffix) = rest.split_once('/').unwrap_or((rest, ""));
                let suffix = format!("/{suffix}");
                if suffix.contains('\\')
                    || crate::path_utils::mnt_path_to_windows(&suffix).is_none()
                {
                    return format!(
                        "//wsl.localhost/{}{}",
                        distro.to_lowercase(),
                        suffix.trim_end_matches('/')
                    );
                }
                path = suffix;
                break;
            }
        }
        if let Some(native) = (!path.contains('\\'))
            .then(|| crate::path_utils::mnt_path_to_windows(&path))
            .flatten()
        {
            path = native.replace('\\', "/");
        } else if path.starts_with('/') && !path.starts_with("//") {
            return if path == "/" {
                path
            } else {
                path.trim_end_matches('/').to_owned()
            };
        }
        path = path.to_lowercase();
    }
    if path == "/" {
        path
    } else {
        path.trim_end_matches('/').to_owned()
    }
}

#[cfg(test)]
mod tests;
