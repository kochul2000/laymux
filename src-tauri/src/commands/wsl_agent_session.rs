#[cfg(windows)]
use crate::lock_ext::MutexExt;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[cfg(windows)]
use crate::constants::WSL_AGENT_PROBE_TIMEOUT;
use crate::error::AppError;
use crate::state::AppState;
use crate::wsl_probe::snapshot::{GuestObservation, GuestProbeKey, TerminalCatalog};
use crate::wsl_probe::WslTerminalTargets;
#[cfg(windows)]
use crate::wsl_probe::{run_probe_script, wsl_terminal_targets_scoped};

/// `arg0` of the guest shell, and the probe's name in the shared run table.
const PROBE_NAME: &str = "laymux-wsl-agent-probe";
const PROBE_HEADER: &str = "LAYMUX_WSL_AGENT_PROBE_V3";
const PROBE_END: &str = "LAYMUX_WSL_AGENT_PROBE_END";

/// The script receives no interpolated values. The distro is a `wsl.exe` argv
/// and the terminal marker comes from each process environment.
const WSL_PROCESS_PROBE: &str = r#"
printf 'LAYMUX_WSL_AGENT_PROBE_V3\n'
for proc in /proc/[0-9]*; do
  [ -r "$proc/environ" ] || continue
  env_lines=$(tr '\000' '\n' < "$proc/environ" 2>/dev/null) || continue
  unset terminal_id home codex_home grok_home
  while IFS='=' read -r key value; do
    case "$key" in
      LX_TERMINAL_ID) [ "${terminal_id+x}" = x ] || terminal_id=$value ;;
      HOME) [ "${home+x}" = x ] || home=$value ;;
      CODEX_HOME) [ "${codex_home+x}" = x ] || codex_home=$value ;;
      GROK_HOME) [ "${grok_home+x}" = x ] || grok_home=$value ;;
    esac
  done <<EOF
$env_lines
EOF
  [ -n "$terminal_id" ] || continue
  if laymux_is_terminated_process "$proc"; then continue; fi
  IFS= read -r name < "$proc/comm" 2>/dev/null || continue
  ppid=
  while read -r key value; do
    if [ "$key" = 'PPid:' ]; then ppid=$value; break; fi
  done < "$proc/status" 2>/dev/null
  helper=0
  if laymux_is_agent_helper "$proc" "$name"; then helper=1; fi
  printf 'P\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$terminal_id" "${proc##*/}" "$ppid" "$name" "$home" "$codex_home" "$grok_home" "$helper"
  # Only Codex attribution consumes rollout descriptors. Keep every marked
  # process above so intermediary shells still establish the parent chain.
  # A server can retain many conversations; none belongs to its launching pane.
  [ "$helper" = '0' ] || continue
  case "$name" in [cC][oO][dD][eE][xX]*) ;; *) continue ;; esac
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
    is_helper: bool,
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

#[derive(Debug)]
pub(super) struct WslAgentProcessLookup {
    pub attributions: HashMap<String, Option<WslAgentProcess>>,
    pub failed_terminal_ids: HashSet<String>,
}

impl WslAgentProcess {
    pub(super) fn codex_home_dir(&self) -> Option<PathBuf> {
        self.windows_path(
            self.codex_home
                .as_deref()
                .unwrap_or(&format!("{}/.codex", self.home.trim_end_matches('/'))),
        )
    }
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

    #[cfg(test)]
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
///
/// The scan itself is provider-agnostic, so every provider reads the same
/// shared per-distribution run; `observation` is the caller's freshness
/// contract for it (ADR-0335).
pub(super) fn resolve_wsl_agent_processes(
    state: &AppState,
    provider: WslAgentProvider,
    observation: GuestObservation,
) -> Result<WslAgentProcessLookup, AppError> {
    resolve_wsl_agent_processes_scoped(state, provider, observation, None)
}

pub(super) fn resolve_wsl_agent_processes_scoped(
    state: &AppState,
    provider: WslAgentProvider,
    observation: GuestObservation,
    scope: Option<&HashSet<String>>,
) -> Result<WslAgentProcessLookup, AppError> {
    #[cfg(not(windows))]
    {
        let _ = (state, provider, observation, scope);
        return Ok(WslAgentProcessLookup {
            attributions: HashMap::new(),
            failed_terminal_ids: HashSet::new(),
        });
    }

    #[cfg(windows)]
    {
        // One deadline covers default-distro discovery and every distro probe.
        // The close handler gives session persistence five seconds, so this
        // adapter must not multiply its timeout by the number of distros.
        let deadline = Instant::now() + WSL_AGENT_PROBE_TIMEOUT;
        let targets = wsl_terminal_targets_scoped(state, deadline, scope)?;
        if observation.is_reusable() {
            return resolve_display_targets(state, targets, provider);
        }
        resolve_targets(state, targets, provider, observation, deadline, scan_distro)
    }
}

#[cfg(windows)]
fn resolve_display_targets(
    state: &AppState,
    targets: WslTerminalTargets,
    provider: WslAgentProvider,
) -> Result<WslAgentProcessLookup, AppError> {
    let mut result = WslAgentProcessLookup {
        attributions: HashMap::new(),
        failed_terminal_ids: HashSet::new(),
    };
    for (id, distro) in targets.targets {
        let catalog = TerminalCatalog::for_ids(state, &HashSet::from([id.clone()]))?;
        let generation = state
            .pty_handles
            .lock_or_err()?
            .get(&id)
            .map(|h| h.terminal_generation())
            .unwrap_or(0);
        let provider_name = match provider {
            WslAgentProvider::Claude => "claude",
            WslAgentProvider::Codex => "codex",
            WslAgentProvider::Grok => "grok",
        };
        let root = crate::commands::cached_root_pid(
            state,
            &id,
            generation,
            provider_name,
            distro.as_deref(),
        );
        let output = distro.as_deref().and_then(|distro| {
            if root.is_some() {
                state
                    .wsl_guest_snapshots
                    .cached_run_for_verified_root(PROBE_NAME, distro, &catalog, &[])
                    .map(|(_, output)| output)
            } else {
                state
                    .wsl_guest_snapshots
                    .cached_runs(PROBE_NAME, distro, &catalog)
                    .into_iter()
                    .find(|(args, _)| args.is_empty())
                    .map(|(_, output)| output)
            }
        });
        let entries = output
            .unwrap_or_else(|| Err("WSL ownership awaits a targeted observation".into()))
            .and_then(|bytes| parse_probe_output(&bytes));
        let entries = match entries {
            Ok(entries) => entries,
            Err(_) => {
                result.failed_terminal_ids.insert(id.clone());

                result.attributions.insert(id, None);
                continue;
            }
        };
        let mut grouped = group_by_terminal(entries);
        let Some(entries) = grouped.remove(&id) else {
            continue;
        };
        let Some(selected) = select_top_level_agent(&entries, provider) else {
            continue;
        };
        if root.is_some_and(|pid| selected.as_ref().is_none_or(|p| p.pid != pid)) {
            result.failed_terminal_ids.insert(id.clone());
            result.attributions.insert(id, None);
            continue;
        }
        result.attributions.insert(
            id,
            selected.map(|entry| WslAgentProcess {
                pid: entry.pid,
                distro: distro.clone().unwrap_or_default(),
                home: entry.home,
                codex_home: entry.codex_home,
                grok_home: entry.grok_home,
                rollout_paths: entry.rollout_paths,
            }),
        );
    }
    Ok(result)
}

/// The platform-independent half of [`resolve_wsl_agent_processes`]: group the
/// targets by distribution, read each distribution's scan, and select this
/// provider's process per pane. `scan` runs one guest scan and returns its raw
/// stdout.
#[cfg_attr(not(windows), allow(dead_code))]
fn resolve_targets<S>(
    state: &AppState,
    targets: WslTerminalTargets,
    provider: WslAgentProvider,
    observation: GuestObservation,
    deadline: Instant,
    scan: S,
) -> Result<WslAgentProcessLookup, AppError>
where
    S: Fn(&str, Duration) -> Result<Vec<u8>, String> + Clone + Send + 'static,
{
    let mut result = HashMap::new();
    let mut failed_terminal_ids = HashSet::new();
    if targets.lookup_failed {
        failed_terminal_ids.extend(
            targets
                .targets
                .iter()
                .filter(|(_, distro)| distro.is_none())
                .map(|(terminal_id, _)| terminal_id.clone()),
        );
    }
    let mut by_distro: HashMap<String, Vec<String>> = HashMap::new();
    for (terminal_id, distro) in targets.targets {
        match distro {
            Some(distro) => by_distro.entry(distro).or_default().push(terminal_id),
            None => {
                result.insert(terminal_id, None);
            }
        }
    }

    let mut distro_targets: Vec<_> = by_distro.into_iter().collect();
    distro_targets.sort_by(|left, right| left.0.cmp(&right.0));
    if distro_targets.is_empty() {
        return Ok(WslAgentProcessLookup {
            attributions: result,
            failed_terminal_ids,
        });
    }
    // Read after the targets: a pane created or respawned in between moves the
    // catalog, so no scan from before it can be reused for it.
    let catalog = TerminalCatalog::of(state)?;
    // Every distribution's run starts before any is awaited, so they overlap
    // inside the one deadline instead of queueing behind each other.
    let pending: Vec<_> = distro_targets
        .into_iter()
        .map(|(distro, terminal_ids)| {
            let (scan, scan_distro) = (scan.clone(), distro.clone());
            let pending = state.wsl_guest_snapshots.request(
                GuestProbeKey::new(PROBE_NAME, &distro, Vec::new()),
                &catalog,
                observation,
                deadline,
                move |timeout| scan(&scan_distro, timeout),
            );
            (distro, terminal_ids, pending)
        })
        .collect();
    for (distro, terminal_ids, pending) in pending {
        let entries = match pending
            .wait(deadline)
            .and_then(|output| parse_probe_output(&output))
        {
            Ok(entries) => entries,
            Err(error) => {
                tracing::warn!(%distro, %error, "WSL agent process probe failed closed");
                failed_terminal_ids.extend(terminal_ids.iter().cloned());
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
        failed_terminal_ids,
    })
}

/// One guest `/proc` scan of `distro`, as raw stdout.
#[cfg(windows)]
fn scan_distro(distro: &str, timeout: Duration) -> Result<Vec<u8>, String> {
    let script = crate::wsl_probe::with_agent_role_probe(WSL_PROCESS_PROBE);
    run_probe_script(distro, &script, PROBE_NAME, timeout)
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
            ["P", terminal_id, pid, ppid, name, home, codex_home, grok_home, helper]
                if !terminal_id.is_empty() && !name.is_empty() && matches!(*helper, "0" | "1") =>
            {
                entries.push(WslProcessEntry {
                    terminal_id: (*terminal_id).to_string(),
                    pid: parse_probe_pid(pid)?,
                    ppid: ppid
                        .parse::<u32>()
                        .map_err(|_| "WSL probe row had an invalid PPID".to_string())?,
                    name: (*name).to_string(),
                    is_helper: *helper == "1",
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
        // Keep helpers in by_pid: removing their topology would change the
        // depth of real agents below them. Only their candidacy is excluded.
        if entry.is_helper {
            continue;
        }
        let Some(entry_provider) = process_provider(&entry.name) else {
            continue;
        };
        let Some(depth) = process_depth(entry.pid, &by_pid) else {
            return entries
                .iter()
                .any(|entry| !entry.is_helper && process_matches_provider(&entry.name, provider))
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

#[cfg(test)]
mod shared_scan_tests;
