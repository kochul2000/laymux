use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
#[cfg(windows)]
use std::time::Duration;
use std::time::Instant;

use crate::constants::WSL_AGENT_PROBE_TIMEOUT;
use crate::error::AppError;
use crate::state::AppState;
use crate::wsl_probe::remaining_timeout;
#[cfg(windows)]
use crate::wsl_probe::{run_probe_script, wsl_terminal_targets};

const PROBE_HEADER: &str = "LAYMUX_WSL_AGENT_PROBE_V2";
const PROBE_END: &str = "LAYMUX_WSL_AGENT_PROBE_END";

/// The script receives no interpolated values. The distro is a `wsl.exe` argv
/// and the terminal marker comes from each process environment.
const WSL_PROCESS_PROBE: &str = r#"
printf 'LAYMUX_WSL_AGENT_PROBE_V2\n'
for proc in /proc/[0-9]*; do
  [ -r "$proc/environ" ] || continue
  env_lines=$(tr '\000' '\n' < "$proc/environ" 2>/dev/null) || continue
  terminal_id=$(printf '%s\n' "$env_lines" | sed -n 's/^LX_TERMINAL_ID=//p' | head -n 1)
  [ -n "$terminal_id" ] || continue
  name=$(cat "$proc/comm" 2>/dev/null) || continue
  ppid=$(sed -n 's/^PPid:[[:space:]]*//p' "$proc/status" 2>/dev/null)
  home=$(printf '%s\n' "$env_lines" | sed -n 's/^HOME=//p' | head -n 1)
  codex_home=$(printf '%s\n' "$env_lines" | sed -n 's/^CODEX_HOME=//p' | head -n 1)
  grok_home=$(printf '%s\n' "$env_lines" | sed -n 's/^GROK_HOME=//p' | head -n 1)
  printf 'P\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$terminal_id" "${proc##*/}" "$ppid" "$name" "$home" "$codex_home" "$grok_home"
  for fd in "$proc"/fd/*; do
    target=$(readlink "$fd" 2>/dev/null) || continue
    case "$target" in
      */sessions/*/rollout-*.jsonl)
        printf 'R\t%s\t%s\t%s\n' "$terminal_id" "${proc##*/}" "$target"
        ;;
    esac
  done
done
printf 'LAYMUX_WSL_AGENT_PROBE_END\n'
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WslAgentProvider {
    Claude,
    Codex,
    Grok,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WslProcessEntry {
    terminal_id: String,
    pid: u32,
    ppid: u32,
    name: String,
    home: String,
    codex_home: Option<String>,
    grok_home: Option<String>,
    rollout_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct WslAgentProcess {
    pub pid: u32,
    pub distro: String,
    pub home: String,
    pub codex_home: Option<String>,
    pub grok_home: Option<String>,
    pub rollout_paths: Vec<String>,
}

pub(super) struct WslAgentProcessLookup {
    pub attributions: HashMap<String, Option<WslAgentProcess>>,
    pub lookup_failed: bool,
}

impl WslAgentProcess {
    pub(super) fn claude_sessions_dir(&self) -> Option<PathBuf> {
        self.windows_path(&format!(
            "{}/.claude/sessions",
            self.home.trim_end_matches('/')
        ))
    }

    pub(super) fn grok_home_dir(&self) -> Option<PathBuf> {
        if let Some(home) = self.grok_home.as_deref().filter(|path| !path.is_empty()) {
            return self.windows_path(home);
        }
        self.windows_path(&format!("{}/.grok", self.home.trim_end_matches('/')))
    }

    pub(super) fn codex_rollout_paths(&self) -> Vec<PathBuf> {
        let default_home = format!("{}/.codex", self.home.trim_end_matches('/'));
        let codex_home = self.codex_home.as_deref().unwrap_or(&default_home);
        let sessions_prefix = format!("{}/sessions/", codex_home.trim_end_matches('/'));
        self.rollout_paths
            .iter()
            .filter(|path| {
                path.starts_with(&sessions_prefix)
                    && path.rsplit('/').next().is_some_and(|name| {
                        name.starts_with("rollout-") && name.ends_with(".jsonl")
                    })
            })
            .filter_map(|path| self.windows_path(path))
            .collect()
    }

    fn windows_path(&self, linux_path: &str) -> Option<PathBuf> {
        if !linux_path.starts_with('/') {
            return None;
        }
        Some(PathBuf::from(crate::path_utils::resolve_path_for_windows(
            linux_path,
            Some(&self.distro),
        )))
    }
}

/// Resolve WSL provider processes by their inherited `LX_TERMINAL_ID` marker.
///
/// An absent key means that provider is not running in the terminal. A present
/// `None` means the WSL boundary was unavailable or attribution was ambiguous,
/// so the caller must clear stale session IDs.
pub(super) fn resolve_wsl_agent_processes(
    state: &AppState,
    provider: WslAgentProvider,
) -> Result<WslAgentProcessLookup, AppError> {
    #[cfg(not(windows))]
    {
        let _ = (state, provider);
        return Ok(WslAgentProcessLookup {
            attributions: HashMap::new(),
            lookup_failed: false,
        });
    }

    #[cfg(windows)]
    {
        // One deadline covers default-distro discovery and every distro probe.
        // The close handler gives session persistence five seconds, so this
        // adapter must not multiply its timeout by the number of distros.
        let deadline = Instant::now() + WSL_AGENT_PROBE_TIMEOUT;
        let targets = wsl_terminal_targets(state, deadline)?;
        let mut result = HashMap::new();
        let mut lookup_failed = false;
        let mut by_distro: HashMap<String, Vec<String>> = HashMap::new();
        for (terminal_id, distro) in targets {
            match distro {
                Some(distro) => by_distro.entry(distro).or_default().push(terminal_id),
                None => {
                    result.insert(terminal_id, None);
                }
            }
        }

        let mut distro_targets: Vec<_> = by_distro.into_iter().collect();
        distro_targets.sort_by(|left, right| left.0.cmp(&right.0));
        for (distro, terminal_ids) in distro_targets {
            let entries = match remaining_timeout(deadline)
                .ok_or_else(|| "WSL agent resolution deadline expired".to_string())
                .and_then(|timeout| probe_distro(&distro, timeout))
            {
                Ok(entries) => entries,
                Err(error) => {
                    tracing::warn!(%distro, %error, "WSL agent process probe failed closed");
                    lookup_failed = true;
                    for terminal_id in terminal_ids {
                        result.insert(terminal_id, None);
                    }
                    continue;
                }
            };
            let grouped = group_by_terminal(entries);
            for terminal_id in terminal_ids {
                let Some(entries) = grouped.get(&terminal_id) else {
                    continue;
                };
                let Some(selected) = select_top_level_agent(entries, provider) else {
                    continue;
                };
                result.insert(
                    terminal_id,
                    selected.map(|entry| WslAgentProcess {
                        pid: entry.pid,
                        distro: distro.clone(),
                        home: entry.home,
                        codex_home: entry.codex_home,
                        grok_home: entry.grok_home,
                        rollout_paths: entry.rollout_paths,
                    }),
                );
            }
        }
        Ok(WslAgentProcessLookup {
            attributions: result,
            lookup_failed,
        })
    }
}

#[cfg(windows)]
fn probe_distro(distro: &str, timeout: Duration) -> Result<Vec<WslProcessEntry>, String> {
    let stdout = run_probe_script(distro, WSL_PROCESS_PROBE, "laymux-wsl-agent-probe", timeout)?;
    parse_probe_output(&stdout)
}

fn parse_probe_output(output: &[u8]) -> Result<Vec<WslProcessEntry>, String> {
    let text = std::str::from_utf8(output).map_err(|_| "WSL probe output was not UTF-8")?;
    let lines: Vec<&str> = text.lines().collect();
    if lines.first().copied() != Some(PROBE_HEADER) || lines.last().copied() != Some(PROBE_END) {
        return Err("WSL probe output was incomplete".into());
    }
    let mut entries = Vec::new();
    let mut rollouts = Vec::new();
    for line in lines[1..lines.len() - 1]
        .iter()
        .filter(|line| !line.is_empty())
    {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["P", terminal_id, pid, ppid, name, home, codex_home, grok_home]
                if !terminal_id.is_empty() && !name.is_empty() =>
            {
                entries.push(WslProcessEntry {
                    terminal_id: (*terminal_id).to_string(),
                    pid: parse_probe_pid(pid)?,
                    ppid: ppid
                        .parse::<u32>()
                        .map_err(|_| "WSL probe row had an invalid PPID".to_string())?,
                    name: (*name).to_string(),
                    home: (*home).to_string(),
                    codex_home: non_empty(codex_home),
                    grok_home: non_empty(grok_home),
                    rollout_paths: Vec::new(),
                });
            }
            ["R", terminal_id, pid, path]
                if !terminal_id.is_empty() && path.starts_with('/') && path.ends_with(".jsonl") =>
            {
                rollouts.push(((*terminal_id).to_string(), parse_probe_pid(pid)?, *path));
            }
            _ => return Err("WSL probe row had an invalid shape".into()),
        }
    }
    for (terminal_id, pid, path) in rollouts {
        let mut matches = entries
            .iter_mut()
            .filter(|entry| entry.terminal_id == terminal_id && entry.pid == pid);
        let Some(entry) = matches.next() else {
            return Err("WSL probe rollout had no owning process".into());
        };
        if matches.next().is_some() {
            return Err("WSL probe rollout owner was ambiguous".into());
        }
        entry.rollout_paths.push(path.to_string());
    }
    Ok(entries)
}

fn parse_probe_pid(value: &str) -> Result<u32, String> {
    value
        .parse::<u32>()
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| "WSL probe row had an invalid PID".to_string())
}

fn non_empty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_string())
}

fn group_by_terminal(entries: Vec<WslProcessEntry>) -> HashMap<String, Vec<WslProcessEntry>> {
    let mut result: HashMap<String, Vec<WslProcessEntry>> = HashMap::new();
    for entry in entries {
        result
            .entry(entry.terminal_id.clone())
            .or_default()
            .push(entry);
    }
    result
}

/// Outer `None`: provider absent. `Some(None)`: provider present but ambiguous.
fn select_top_level_agent(
    entries: &[WslProcessEntry],
    provider: WslAgentProvider,
) -> Option<Option<WslProcessEntry>> {
    let by_pid: HashMap<u32, u32> = entries
        .iter()
        .map(|entry| (entry.pid, entry.ppid))
        .collect();
    let mut candidates = Vec::new();
    for entry in entries {
        let Some(entry_provider) = process_provider(&entry.name) else {
            continue;
        };
        let Some(depth) = process_depth(entry.pid, &by_pid) else {
            return entries
                .iter()
                .any(|entry| process_matches_provider(&entry.name, provider))
                .then_some(None);
        };
        candidates.push((depth, entry_provider, entry));
    }
    let minimum = candidates.iter().map(|(depth, _, _)| *depth).min()?;
    let shallowest: Vec<(WslAgentProvider, &WslProcessEntry)> = candidates
        .into_iter()
        .filter_map(|(depth, entry_provider, entry)| {
            (depth == minimum).then_some((entry_provider, entry))
        })
        .collect();
    match shallowest.as_slice() {
        [(entry_provider, entry)] if *entry_provider == provider => Some(Some((*entry).clone())),
        [(_entry_provider, _entry)] => None,
        entries
            if entries
                .iter()
                .any(|(entry_provider, _)| *entry_provider == provider) =>
        {
            Some(None)
        }
        _ => None,
    }
}

fn process_matches_provider(name: &str, provider: WslAgentProvider) -> bool {
    process_provider(name) == Some(provider)
}

fn process_provider(name: &str) -> Option<WslAgentProvider> {
    let lowercase = name.to_ascii_lowercase();
    let stem = lowercase.strip_suffix(".exe").unwrap_or(&lowercase);
    match stem {
        "claude" => Some(WslAgentProvider::Claude),
        "codex" => Some(WslAgentProvider::Codex),
        "grok" => Some(WslAgentProvider::Grok),
        _ => None,
    }
}

fn process_depth(pid: u32, by_pid: &HashMap<u32, u32>) -> Option<usize> {
    let mut current = pid;
    let mut visited = HashSet::new();
    let mut depth = 0;
    while let Some(parent) = by_pid.get(&current).copied() {
        if !visited.insert(current) {
            return None;
        }
        if !by_pid.contains_key(&parent) {
            return Some(depth);
        }
        depth += 1;
        current = parent;
    }
    Some(depth)
}

#[cfg(test)]
mod tests;
