use crate::lock_ext::MutexExt;
use crate::state::AppState;
use laymux_agent_hook::runtime::{HookEvent, ProcessIdentity};
use std::collections::HashMap;

pub(super) use crate::agent_hooks::observations::{root_identity as identity, same_root as same};

fn verifies_claim(owner: &mut ProcessIdentity, event: &HookEvent) -> bool {
    let Some(claim) = event.ancestors.iter().find(|p| p.pid == owner.pid) else {
        return true;
    };
    // Legacy Linux helpers reported only epoch seconds. Keep their conservative
    // comparison until their owned helper is updated to emit stable ticks.
    if claim.start_ticks.is_none() {
        owner.start_ticks = None;
    }
    same(owner, claim)
}

/// The selected TUI owns the pane. A shared hook producer may be a different
/// process, so its events cannot by themselves renew the TUI's presence lease.
pub(super) fn verify_many(
    state: &AppState,
    events: &HashMap<String, HookEvent>,
) -> Result<HashMap<String, ProcessIdentity>, String> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let handles = state.pty_handles.lock_or_err()?.clone();
    let mut verified = HashMap::new();
    let native: Vec<_> = events
        .iter()
        .filter_map(|(id, event)| {
            let handle = handles.get(id)?;
            (!handle.is_wsl_backed()).then_some((id, event, handle))
        })
        .collect();
    if !native.is_empty() {
        let tree = crate::process_tree::try_snapshot_processes()?;
        let candidates: Vec<_> = native
            .into_iter()
            .filter_map(|(id, event, handle)| {
                identity(event)?;
                let (pid, app) =
                    crate::process_tree::match_interactive_app_process(&tree, handle.child_pid()?)?;
                app.eq_ignore_ascii_case(&event.provider)
                    .then_some((id, event, pid))
            })
            .collect();
        let pids: Vec<_> = candidates
            .iter()
            .map(|(_, _, pid)| Pid::from_u32(*pid))
            .collect();
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            ProcessRefreshKind::nothing(),
        );
        for (id, event, pid) in candidates {
            let Some(process) = system.process(Pid::from_u32(pid)) else {
                continue;
            };
            let mut owner = ProcessIdentity {
                pid,
                parent_pid: process.parent().map(Pid::as_u32),
                start_time: process.start_time(),
                start_ticks: laymux_agent_hook::runtime::process_start_ticks(pid),
                name: process.name().to_string_lossy().to_ascii_lowercase(),
                helper: false,
            };
            if crate::process_tree::name_to_app(&owner.name)
                .is_none_or(|app| !app.eq_ignore_ascii_case(&event.provider))
            {
                continue;
            }
            if !verifies_claim(&mut owner, event) {
                continue;
            }
            verified.insert(id.clone(), owner);
        }
    }
    #[cfg(windows)]
    verify_guests(state, events, &handles, &mut verified)?;
    Ok(verified)
}

#[cfg(windows)]
struct GuestRoot {
    id: String,
    pid: u32,
}

#[cfg(windows)]
fn verify_guests(
    state: &AppState,
    events: &HashMap<String, HookEvent>,
    handles: &HashMap<String, crate::pty::PtyHandle>,
    verified: &mut HashMap<String, ProcessIdentity>,
) -> Result<(), String> {
    use crate::commands::wsl_agent_session::{
        resolve_wsl_agent_processes_scoped, WslAgentProvider,
    };
    use crate::wsl_probe::snapshot::{GuestObservation, GuestProbeKey, TerminalCatalog};
    use std::{collections::HashSet, time::Instant};
    let mut by_distro: HashMap<String, Vec<GuestRoot>> = HashMap::new();
    for (provider, kind) in [
        ("claude", WslAgentProvider::Claude),
        ("codex", WslAgentProvider::Codex),
        ("grok", WslAgentProvider::Grok),
    ] {
        let ids = events
            .iter()
            .filter(|(id, e)| {
                e.provider == provider && handles.get(*id).is_some_and(|h| h.is_wsl_backed())
            })
            .map(|(id, _)| id.clone())
            .collect::<HashSet<_>>();
        if ids.is_empty() {
            continue;
        }
        let lookup = resolve_wsl_agent_processes_scoped(
            state,
            kind,
            GuestObservation::Reusable,
            Some(&ids),
        )?;
        for id in ids {
            let Some(Some(process)) = lookup.attributions.get(&id) else {
                continue;
            };
            if identity(&events[&id]).is_some()
                && events[&id].distro.as_deref() == Some(process.distro.as_str())
            {
                by_distro
                    .entry(process.distro.clone())
                    .or_default()
                    .push(GuestRoot {
                        id,
                        pid: process.pid,
                    });
            }
        }
    }
    for (distro, mut roots) in by_distro {
        roots.sort_by_key(|root| root.pid);
        let pids: Vec<_> = roots.iter().map(|root| root.pid.to_string()).collect();
        // Only validated u32 values enter shell code. One run per distribution.
        let script = format!(
            r#"
hz=$(getconf CLK_TCK) || exit 1
boot=$(awk '$1 == "btime" {{print $2}}' /proc/stat) || exit 1
[ "$hz" -gt 0 ] && [ -n "$boot" ] || exit 1
for pid in {}; do
  stat=$(cat /proc/$pid/stat) || continue
  rest=${{stat##*) }}
  set -- $rest
  case "$1" in Z|X) continue ;; esac
  parent=$2
  shift 19
  ticks=$1
  IFS= read -r name < /proc/$pid/comm || continue
  printf '%s\t%s\t%s\t%s\t%s\n' "$pid" "$ticks" "$((boot + ticks / hz))" "$parent" "$name"
done
"#,
            pids.join(" ")
        );
        let deadline = Instant::now() + crate::constants::WSL_AGENT_PROBE_TIMEOUT;
        let catalog = TerminalCatalog::of(state)?;
        let pending = state.wsl_guest_snapshots.request(
            GuestProbeKey::new("laymux-hook-roots", &distro, pids),
            &catalog,
            GuestObservation::starting_now(),
            deadline,
            move |timeout| {
                crate::wsl_probe::run_probe_script(&distro, &script, "laymux-hook-roots", timeout)
            },
        );
        let bytes = pending.wait(deadline)?;
        let owners: HashMap<u32, ProcessIdentity> = std::str::from_utf8(&bytes)
            .map_err(|e| e.to_string())?
            .lines()
            .filter_map(|line| {
                let fields: Vec<_> = line.split('\t').collect();
                if fields.len() != 5 {
                    return None;
                }
                let pid = fields[0].parse().ok()?;
                Some((
                    pid,
                    ProcessIdentity {
                        pid,
                        parent_pid: Some(fields[3].parse().ok()?),
                        start_time: fields[2].parse().ok()?,
                        start_ticks: Some(fields[1].parse().ok()?),
                        name: fields[4].to_owned(),
                        helper: false,
                    },
                ))
            })
            .collect();
        for root in roots {
            let Some(owner) = owners.get(&root.pid) else {
                continue;
            };
            let event = &events[&root.id];
            if crate::process_tree::name_to_app(&owner.name)
                .is_none_or(|app| !app.eq_ignore_ascii_case(&event.provider))
            {
                continue;
            }
            let mut owner = owner.clone();
            if !verifies_claim(&mut owner, event) {
                continue;
            }
            verified.insert(root.id, owner);
        }
    }
    Ok(())
}
