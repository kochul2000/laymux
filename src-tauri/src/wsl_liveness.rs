//! Interactive-app liveness across the WSL boundary (ADR-0134).
//!
//! [`crate::process_tree`] answers "is Claude / Codex alive under this PTY?" by
//! walking the Windows process tree. For a WSL-backed pane that walk can only
//! ever see `wsl.exe`: the agent runs as a Linux process inside the VM, which
//! no Windows snapshot enumerates. The tree therefore has no standing to call
//! such a pane empty, and this module supplies the verdict instead.
//!
//! The probe cannot run on the PTY callback thread — OSC 0/2 spinner titles
//! arrive several times per second and `wsl.exe --exec` costs tens of
//! milliseconds. A background refresher owns every guest crossing and
//! publishes a snapshot; detection only ever reads that snapshot.
//!
//! Freshness is deliberately asymmetric:
//!
//! - Fresh snapshot — both verdicts are authoritative.
//! - Stale snapshot — only `Running` survives. A stale negative degrades to
//!   `Unknown` so a just-started agent is picked up by the title/buffer
//!   heuristics immediately instead of waiting out the staleness window.
//! - No snapshot / pane not covered by the last pass — `Unknown`.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use crate::lock_ext::MutexExt;
use crate::process_tree::PtyAppLiveness;

#[cfg(windows)]
use crate::state::AppState;
#[cfg(windows)]
use std::sync::Arc;

/// Guest-side scan. Only `claude` / `codex` processes are inspected further, so
/// the cost is one `comm` read per process plus a short ancestor walk for the
/// few matches — not an `environ` read for every PID.
///
/// The script receives no interpolated values; the distribution is a `wsl.exe`
/// argv and every other value comes from the guest's own `/proc`.
#[cfg(windows)]
const WSL_LIVENESS_PROBE: &str = r#"
printf 'LAYMUX_WSL_LIVENESS_PROBE_V1\n'
for proc in /proc/[0-9]*; do
  name=$(cat "$proc/comm" 2>/dev/null) || continue
  case "$name" in
    claude|codex) ;;
    *) continue ;;
  esac
  [ -r "$proc/environ" ] || continue
  terminal_id=$(tr '\000' '\n' < "$proc/environ" 2>/dev/null | sed -n 's/^LX_TERMINAL_ID=//p' | head -n 1)
  [ -n "$terminal_id" ] || continue
  pid=${proc##*/}
  depth=0
  current=$pid
  while [ "$depth" -lt 64 ]; do
    parent=$(sed -n 's/^PPid:[[:space:]]*//p' "/proc/$current/status" 2>/dev/null)
    [ -n "$parent" ] || break
    [ "$parent" = "0" ] && break
    current=$parent
    depth=$((depth + 1))
  done
  printf 'A\t%s\t%s\t%s\t%s\n' "$terminal_id" "$pid" "$name" "$depth"
done
printf 'LAYMUX_WSL_LIVENESS_PROBE_END\n'
"#;

const PROBE_HEADER: &str = "LAYMUX_WSL_LIVENESS_PROBE_V1";
const PROBE_END: &str = "LAYMUX_WSL_LIVENESS_PROBE_END";

/// One `claude` / `codex` process seen in a guest, attributed to the pane whose
/// `LX_TERMINAL_ID` it inherited.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslAgentRow {
    pub terminal_id: String,
    pub pid: u32,
    pub app: &'static str,
    /// Ancestor count up to the guest's init. Used only to rank processes
    /// within one pane, so absolute values do not need to match the host.
    pub depth: u32,
}

/// What the last probe pass learned. `covered` is the set of panes the pass
/// could actually speak for; absence from it means "no verdict", never "empty".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WslLivenessSnapshot {
    pub covered: HashSet<String>,
    pub apps: HashMap<String, &'static str>,
}

struct CacheEntry {
    taken_at: Instant,
    snapshot: WslLivenessSnapshot,
}

static CACHE: std::sync::Mutex<Option<CacheEntry>> = std::sync::Mutex::new(None);

/// Last time detection asked about a WSL pane. The refresher stops crossing the
/// boundary once nobody is looking, so an idle window costs nothing.
static LAST_DEMAND: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);

/// The liveness verdict for a WSL-backed pane. Cheap: one mutex and a map
/// lookup, no process enumeration and no guest crossing.
pub fn liveness(terminal_id: &str) -> PtyAppLiveness {
    note_demand();
    let Ok(guard) = CACHE.lock_or_err() else {
        return PtyAppLiveness::Unknown;
    };
    let Some(entry) = guard.as_ref() else {
        return PtyAppLiveness::Unknown;
    };
    decide(&entry.snapshot, entry.taken_at.elapsed(), terminal_id)
}

/// Freshness policy, split out so the asymmetry is testable without a clock.
pub fn decide(snapshot: &WslLivenessSnapshot, age: Duration, terminal_id: &str) -> PtyAppLiveness {
    if !snapshot.covered.contains(terminal_id) {
        return PtyAppLiveness::Unknown;
    }
    match snapshot.apps.get(terminal_id) {
        Some(app) if age <= crate::constants::WSL_LIVENESS_POSITIVE_MAX_AGE => {
            PtyAppLiveness::Running(app)
        }
        Some(_) => PtyAppLiveness::Unknown,
        None if age <= crate::constants::WSL_LIVENESS_AUTHORITATIVE_MAX_AGE => {
            PtyAppLiveness::NoneAlive
        }
        None => PtyAppLiveness::Unknown,
    }
}

fn note_demand() {
    if let Ok(mut guard) = LAST_DEMAND.lock_or_err() {
        *guard = Some(Instant::now());
    }
}

#[cfg(windows)]
fn demanded_recently() -> bool {
    let Ok(guard) = LAST_DEMAND.lock_or_err() else {
        return false;
    };
    guard.is_some_and(|at| at.elapsed() <= crate::constants::WSL_LIVENESS_DEMAND_WINDOW)
}

fn publish(snapshot: WslLivenessSnapshot) {
    if let Ok(mut guard) = CACHE.lock_or_err() {
        *guard = Some(CacheEntry {
            taken_at: Instant::now(),
            snapshot,
        });
    }
}

/// Start the background refresher. One thread for the whole app: the probe is
/// per distribution, not per pane, so terminal count does not multiply cost.
#[cfg(windows)]
pub fn start_refresher(state: Arc<AppState>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(crate::constants::WSL_LIVENESS_REFRESH_INTERVAL);
        if !demanded_recently() {
            continue;
        }
        refresh(&state);
    });
}

#[cfg(not(windows))]
pub fn start_refresher(_state: std::sync::Arc<crate::state::AppState>) {}

/// Probe every distribution that hosts a WSL pane and publish one snapshot.
#[cfg(windows)]
pub fn refresh(state: &AppState) {
    let deadline = Instant::now() + crate::constants::WSL_LIVENESS_PROBE_TIMEOUT;
    let targets = match crate::wsl_probe::wsl_terminal_targets(state, deadline) {
        Ok(targets) => targets,
        Err(error) => {
            tracing::warn!(%error, "WSL liveness target resolution failed");
            return;
        }
    };
    if targets.is_empty() {
        publish(WslLivenessSnapshot::default());
        return;
    }

    let mut by_distro: HashMap<String, Vec<String>> = HashMap::new();
    for (terminal_id, distro) in targets {
        // A pane whose distribution cannot be resolved gets no verdict; the
        // title/buffer heuristics keep owning it.
        let Some(distro) = distro else { continue };
        by_distro.entry(distro).or_default().push(terminal_id);
    }

    let mut snapshot = WslLivenessSnapshot::default();
    let mut distros: Vec<_> = by_distro.into_iter().collect();
    distros.sort_by(|left, right| left.0.cmp(&right.0));
    for (distro, terminal_ids) in distros {
        let rows = match crate::wsl_probe::remaining_timeout(deadline)
            .ok_or_else(|| "WSL liveness deadline expired".to_string())
            .and_then(|timeout| {
                crate::wsl_probe::run_probe_script(
                    &distro,
                    WSL_LIVENESS_PROBE,
                    "laymux-wsl-liveness-probe",
                    timeout,
                )
            })
            .and_then(|stdout| parse_probe_output(&stdout))
        {
            Ok(rows) => rows,
            Err(error) => {
                // No verdict for this distribution's panes this pass.
                tracing::debug!(%distro, %error, "WSL liveness probe failed");
                continue;
            }
        };
        let (apps, ambiguous) = resolve_rows(rows);
        for terminal_id in terminal_ids {
            if ambiguous.contains(&terminal_id) {
                continue;
            }
            if let Some(app) = apps.get(&terminal_id) {
                snapshot.apps.insert(terminal_id.clone(), app);
            }
            snapshot.covered.insert(terminal_id);
        }
    }
    publish(snapshot);
}

fn app_from_comm(name: &str) -> Option<&'static str> {
    match name.trim() {
        "claude" => Some("Claude"),
        "codex" => Some("Codex"),
        _ => None,
    }
}

/// Parse the probe's stdout. Sentinels bound the payload so a truncated run
/// (timeout kill, distribution shutting down) fails instead of publishing a
/// partial guest view as an authoritative negative.
pub fn parse_probe_output(output: &[u8]) -> Result<Vec<WslAgentRow>, String> {
    let text = std::str::from_utf8(output).map_err(|_| "WSL liveness output was not UTF-8")?;
    let lines: Vec<&str> = text.lines().collect();
    if lines.first().copied() != Some(PROBE_HEADER) || lines.last().copied() != Some(PROBE_END) {
        return Err("WSL liveness output was incomplete".into());
    }
    let mut rows = Vec::new();
    for line in lines[1..lines.len() - 1]
        .iter()
        .filter(|line| !line.is_empty())
    {
        let fields: Vec<&str> = line.split('\t').collect();
        let ["A", terminal_id, pid, name, depth] = fields.as_slice() else {
            return Err("WSL liveness row had an invalid shape".into());
        };
        let Some(app) = app_from_comm(name) else {
            return Err("WSL liveness row named an unexpected process".into());
        };
        if terminal_id.is_empty() {
            return Err("WSL liveness row had no terminal marker".into());
        }
        rows.push(WslAgentRow {
            terminal_id: (*terminal_id).to_string(),
            pid: pid
                .parse::<u32>()
                .ok()
                .filter(|pid| *pid > 0)
                .ok_or_else(|| "WSL liveness row had an invalid PID".to_string())?,
            app,
            depth: depth
                .parse::<u32>()
                .map_err(|_| "WSL liveness row had an invalid depth".to_string())?,
        });
    }
    Ok(rows)
}

/// Reduce rows to one app per pane: the shallowest process wins, so a Claude
/// pane that shells out to Codex still reports Claude.
///
/// Returns the resolved apps and the panes that must get **no** verdict — two
/// different agents tied at the same depth cannot be ranked, and guessing there
/// would be worse than letting the title heuristics decide.
pub fn resolve_rows(rows: Vec<WslAgentRow>) -> (HashMap<String, &'static str>, HashSet<String>) {
    let mut best: HashMap<String, (u32, &'static str)> = HashMap::new();
    let mut ambiguous: HashSet<String> = HashSet::new();
    for row in rows {
        match best.get(&row.terminal_id) {
            Some(&(depth, _)) if depth < row.depth => {}
            Some(&(depth, app)) if depth == row.depth => {
                if app != row.app {
                    ambiguous.insert(row.terminal_id);
                }
            }
            _ => {
                ambiguous.remove(&row.terminal_id);
                best.insert(row.terminal_id, (row.depth, row.app));
            }
        }
    }
    let apps = best
        .into_iter()
        .filter(|(terminal_id, _)| !ambiguous.contains(terminal_id))
        .map(|(terminal_id, (_, app))| (terminal_id, app))
        .collect();
    (apps, ambiguous)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{
        WSL_LIVENESS_AUTHORITATIVE_MAX_AGE, WSL_LIVENESS_POSITIVE_MAX_AGE,
        WSL_LIVENESS_REFRESH_INTERVAL,
    };

    fn snapshot(covered: &[&str], apps: &[(&str, &'static str)]) -> WslLivenessSnapshot {
        WslLivenessSnapshot {
            covered: covered.iter().map(|id| (*id).to_string()).collect(),
            apps: apps
                .iter()
                .map(|(id, app)| ((*id).to_string(), *app))
                .collect(),
        }
    }

    #[test]
    fn steady_state_refresh_keeps_snapshots_inside_the_authoritative_window() {
        // Otherwise every pass would spend part of its cycle in the degraded
        // tier and negatives would flap to Unknown in normal operation.
        assert!(WSL_LIVENESS_REFRESH_INTERVAL < WSL_LIVENESS_AUTHORITATIVE_MAX_AGE);
        assert!(WSL_LIVENESS_AUTHORITATIVE_MAX_AGE <= WSL_LIVENESS_POSITIVE_MAX_AGE);
    }

    #[test]
    fn fresh_snapshot_answers_both_ways() {
        let snap = snapshot(&["t-claude", "t-empty"], &[("t-claude", "Claude")]);
        assert_eq!(
            decide(&snap, Duration::from_millis(10), "t-claude"),
            PtyAppLiveness::Running("Claude")
        );
        assert_eq!(
            decide(&snap, Duration::from_millis(10), "t-empty"),
            PtyAppLiveness::NoneAlive
        );
    }

    #[test]
    fn uncovered_pane_never_gets_a_verdict() {
        let snap = snapshot(&["t-claude"], &[("t-claude", "Claude")]);
        assert_eq!(
            decide(&snap, Duration::from_millis(10), "t-other"),
            PtyAppLiveness::Unknown
        );
        assert_eq!(
            decide(&WslLivenessSnapshot::default(), Duration::ZERO, "t-claude"),
            PtyAppLiveness::Unknown
        );
    }

    #[test]
    fn stale_negative_degrades_but_stale_positive_survives() {
        // A stale negative must not keep blocking the title/buffer heuristics:
        // that is exactly the failure this module exists to remove.
        let snap = snapshot(&["t-claude", "t-empty"], &[("t-claude", "Claude")]);
        let stale = WSL_LIVENESS_AUTHORITATIVE_MAX_AGE + Duration::from_secs(1);
        assert_eq!(decide(&snap, stale, "t-empty"), PtyAppLiveness::Unknown);
        assert_eq!(
            decide(&snap, stale, "t-claude"),
            PtyAppLiveness::Running("Claude")
        );
    }

    #[test]
    fn positive_expires_once_it_outlives_its_own_window() {
        let snap = snapshot(&["t-claude"], &[("t-claude", "Claude")]);
        assert_eq!(
            decide(
                &snap,
                WSL_LIVENESS_POSITIVE_MAX_AGE + Duration::from_secs(1),
                "t-claude"
            ),
            PtyAppLiveness::Unknown
        );
    }

    #[test]
    fn parses_bounded_probe_rows() {
        let output = concat!(
            "LAYMUX_WSL_LIVENESS_PROBE_V1\n",
            "A\tterminal-pane-a\t20\tclaude\t3\n",
            "A\tterminal-pane-b\t40\tcodex\t3\n",
            "LAYMUX_WSL_LIVENESS_PROBE_END\n",
        );
        let rows = parse_probe_output(output.as_bytes()).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].app, "Claude");
        assert_eq!(rows[1].pid, 40);
    }

    #[test]
    fn truncated_or_malformed_output_fails_closed() {
        assert!(parse_probe_output(b"A\tterminal-pane-a\t20\tclaude\t3\n").is_err());
        assert!(parse_probe_output(
            b"LAYMUX_WSL_LIVENESS_PROBE_V1\nA\tterminal-pane-a\t20\tclaude\t3\n"
        )
        .is_err());
        assert!(parse_probe_output(
            b"LAYMUX_WSL_LIVENESS_PROBE_V1\nA\tterminal-pane-a\t0\tclaude\t3\nLAYMUX_WSL_LIVENESS_PROBE_END\n"
        )
        .is_err());
        assert!(parse_probe_output(
            b"LAYMUX_WSL_LIVENESS_PROBE_V1\nA\tterminal-pane-a\t20\tbash\t3\nLAYMUX_WSL_LIVENESS_PROBE_END\n"
        )
        .is_err());
    }

    #[test]
    fn shallowest_process_wins_within_one_pane() {
        let rows = vec![
            WslAgentRow {
                terminal_id: "t".into(),
                pid: 30,
                app: "Codex",
                depth: 5,
            },
            WslAgentRow {
                terminal_id: "t".into(),
                pid: 20,
                app: "Claude",
                depth: 3,
            },
        ];
        let (apps, ambiguous) = resolve_rows(rows);
        assert_eq!(apps.get("t"), Some(&"Claude"));
        assert!(ambiguous.is_empty());
    }

    #[test]
    fn equal_depth_rivals_leave_the_pane_without_a_verdict() {
        let rows = vec![
            WslAgentRow {
                terminal_id: "t".into(),
                pid: 20,
                app: "Claude",
                depth: 3,
            },
            WslAgentRow {
                terminal_id: "t".into(),
                pid: 21,
                app: "Codex",
                depth: 3,
            },
        ];
        let (apps, ambiguous) = resolve_rows(rows);
        assert!(apps.is_empty());
        assert!(ambiguous.contains("t"));
    }

    #[test]
    fn a_shallower_row_clears_an_earlier_tie() {
        let rows = vec![
            WslAgentRow {
                terminal_id: "t".into(),
                pid: 20,
                app: "Claude",
                depth: 3,
            },
            WslAgentRow {
                terminal_id: "t".into(),
                pid: 21,
                app: "Codex",
                depth: 3,
            },
            WslAgentRow {
                terminal_id: "t".into(),
                pid: 10,
                app: "Claude",
                depth: 1,
            },
        ];
        let (apps, ambiguous) = resolve_rows(rows);
        assert_eq!(apps.get("t"), Some(&"Claude"));
        assert!(ambiguous.is_empty());
    }
}
