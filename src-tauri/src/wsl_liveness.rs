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
//! - No snapshot / no verdict for this pane in the last pass — `Unknown`.
//! - Exit decisions ([`Purpose::ExitDecision`]) get no positive at all: that
//!   call is one-shot, so a cached `Running` could pin a pane that really did
//!   exit, with nothing to undo it.
//!
//! Verdicts are keyed by PTY generation, because a pane can be torn down and
//! respawned under the same terminal id.

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
/// An agent owned by another guest user (`sudo claude`, a `wsl.exe -u root`
/// pane) has an unreadable `environ`, so its own marker cannot be read. The walk
/// therefore continues up the ancestor chain — `sudo claude` still descends from
/// the pane's own shell, whose `environ` the probing user can read — and only
/// gives up when a marker was never found *and* something along the way was
/// unreadable. That case is reported as a `U` row so the pass can refuse
/// authority over the distribution instead of certifying the agent absent. A
/// fully readable chain with no marker is a guest agent that laymux did not
/// start, and is skipped without poisoning anything. See ADR-0134.
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
  pid=${proc##*/}
  terminal_id=
  unreadable=0
  depth=0
  current=$pid
  while [ "$depth" -lt 64 ]; do
    if [ -r "/proc/$current/environ" ]; then
      if [ -z "$terminal_id" ]; then
        terminal_id=$(tr '\000' '\n' < "/proc/$current/environ" 2>/dev/null | sed -n 's/^LX_TERMINAL_ID=//p' | head -n 1)
      fi
    elif [ -z "$terminal_id" ]; then
      unreadable=1
    fi
    parent=$(sed -n 's/^PPid:[[:space:]]*//p' "/proc/$current/status" 2>/dev/null)
    [ -n "$parent" ] || break
    [ "$parent" = "0" ] && break
    current=$parent
    depth=$((depth + 1))
  done
  if [ -n "$terminal_id" ]; then
    printf 'A\t%s\t%s\t%s\t%s\n' "$terminal_id" "$pid" "$name" "$depth"
  elif [ "$unreadable" = "1" ]; then
    printf 'U\t%s\t%s\n' "$pid" "$name"
  fi
done
printf 'LAYMUX_WSL_LIVENESS_PROBE_END\n'
"#;

const PROBE_HEADER: &str = "LAYMUX_WSL_LIVENESS_PROBE_V1";
const PROBE_END: &str = "LAYMUX_WSL_LIVENESS_PROBE_END";

/// One `claude` / `codex` process seen in a guest, attributed to the pane whose
/// `LX_TERMINAL_ID` it (or its nearest readable ancestor) carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslAgentRow {
    pub terminal_id: String,
    pub pid: u32,
    pub app: &'static str,
    /// Ancestor count up to the guest's init. Used only to rank processes
    /// within one pane, so absolute values do not need to match the host.
    pub depth: u32,
}

/// One probe pass's output for a distribution: attributable agents plus whether
/// an agent existed that could not be attributed at all.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WslProbeReading {
    pub rows: Vec<WslAgentRow>,
    /// An agent process existed whose owning pane could not be determined
    /// because part of its ancestor chain was unreadable. The pass must not
    /// claim authority over this distribution's panes.
    pub unattributable_agent: bool,
}

/// What the last probe pass learned, per pane it could speak for.
///
/// The verdict is keyed by PTY generation as well as terminal id: a pane can be
/// torn down and respawned under the same id (Restart View, profile change), and
/// a verdict about the previous PTY says nothing about the new one.
/// `Some(app)` is "this app is running", `None` is "nothing is running here".
/// A pane absent from the map has no verdict at all — never "empty".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WslLivenessSnapshot {
    pub verdicts: HashMap<String, (u64, Option<&'static str>)>,
}

struct CacheEntry {
    taken_at: Instant,
    snapshot: WslLivenessSnapshot,
}

static CACHE: std::sync::Mutex<Option<CacheEntry>> = std::sync::Mutex::new(None);

/// Last time detection asked about a WSL pane. The refresher stops crossing the
/// boundary once nobody is looking, so an idle window costs nothing.
static LAST_DEMAND: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);

/// Why liveness is being asked, which decides how much staleness is tolerable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    /// Classify what is running in the pane right now. A slightly stale
    /// positive only delays noticing an exit and the next pass corrects it.
    Display,
    /// Decide whether a title-derived exit is false (ADR-0009 suppression).
    /// This decision is **one-shot** — nothing re-fires it — so a cached
    /// positive must never suppress a real exit here.
    ExitDecision,
}

/// The liveness verdict for a WSL-backed pane. Cheap: one mutex and a map
/// lookup, no process enumeration and no guest crossing.
pub fn liveness(terminal_id: &str, generation: u64, purpose: Purpose) -> PtyAppLiveness {
    note_demand();
    let Ok(guard) = CACHE.lock_or_err() else {
        return PtyAppLiveness::Unknown;
    };
    let Some(entry) = guard.as_ref() else {
        return PtyAppLiveness::Unknown;
    };
    decide(
        &entry.snapshot,
        entry.taken_at.elapsed(),
        terminal_id,
        generation,
        purpose,
    )
}

/// Freshness policy, split out so the asymmetry is testable without a clock.
pub fn decide(
    snapshot: &WslLivenessSnapshot,
    age: Duration,
    terminal_id: &str,
    generation: u64,
    purpose: Purpose,
) -> PtyAppLiveness {
    let Some((verdict_generation, app)) = snapshot.verdicts.get(terminal_id) else {
        return PtyAppLiveness::Unknown;
    };
    // A verdict about a previous PTY generation is not about this pane's
    // current process at all.
    if *verdict_generation != generation {
        return PtyAppLiveness::Unknown;
    }
    match app {
        // Suppressing an exit needs proof the app is alive *now*, and the guest
        // cannot be reached from this thread. Declining to answer keeps the
        // title-derived exit flowing, which is what WSL panes did before this
        // module existed — a wrong suppression here would pin a dead pane until
        // some later title event, with no reconcile path to undo it (#767).
        Some(_) if purpose == Purpose::ExitDecision => PtyAppLiveness::Unknown,
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

/// Drop any verdict about `terminal_id`. Called when a PTY session closes so a
/// verdict cannot outlive the process it described, even if a probe pass that
/// started before the teardown is still in flight.
pub fn forget(terminal_id: &str) {
    if let Ok(mut guard) = CACHE.lock_or_err() {
        if let Some(entry) = guard.as_mut() {
            entry.snapshot.verdicts.remove(terminal_id);
        }
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
///
/// Each distribution gets its own timeout rather than sharing one pass-wide
/// deadline: a single hanging distribution would otherwise consume the budget
/// and, because the iteration order is stable, starve every distribution behind
/// it on every pass. The starting index also rotates per pass so no
/// distribution is permanently first in line.
#[cfg(windows)]
pub fn refresh(state: &AppState) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static PASS: AtomicUsize = AtomicUsize::new(0);

    let target_deadline = Instant::now() + crate::constants::WSL_LIVENESS_PROBE_TIMEOUT;
    let targets = match crate::wsl_probe::wsl_terminal_targets(state, target_deadline) {
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

    // A verdict is only meaningful for the PTY generation it observed, so a pane
    // whose handle is gone (closing, already torn down) is left out entirely.
    let generations = match pty_generations(state) {
        Ok(generations) => generations,
        Err(error) => {
            tracing::warn!(%error, "WSL liveness generation lookup failed");
            return;
        }
    };

    let mut by_distro: HashMap<String, Vec<String>> = HashMap::new();
    for (terminal_id, distro) in targets {
        // A pane whose distribution cannot be resolved gets no verdict; the
        // title/buffer heuristics keep owning it.
        let Some(distro) = distro else { continue };
        if !generations.contains_key(&terminal_id) {
            continue;
        }
        by_distro.entry(distro).or_default().push(terminal_id);
    }

    let mut distros: Vec<_> = by_distro.into_iter().collect();
    distros.sort_by(|left, right| left.0.cmp(&right.0));
    if !distros.is_empty() {
        let offset = PASS.fetch_add(1, Ordering::Relaxed) % distros.len();
        distros.rotate_left(offset);
    }

    let mut snapshot = WslLivenessSnapshot::default();
    for (distro, terminal_ids) in distros {
        let reading = match crate::wsl_probe::run_probe_script(
            &distro,
            WSL_LIVENESS_PROBE,
            "laymux-wsl-liveness-probe",
            crate::constants::WSL_LIVENESS_PROBE_TIMEOUT,
        )
        .and_then(|stdout| parse_probe_output(&stdout))
        {
            Ok(reading) => reading,
            Err(error) => {
                // No verdict for this distribution's panes this pass.
                tracing::debug!(%distro, %error, "WSL liveness probe failed");
                continue;
            }
        };
        if reading.unattributable_agent {
            // An agent is running that this probe could not pin to a pane, so
            // "no agent here" cannot be asserted for any pane in this
            // distribution. Leave them all without a verdict.
            tracing::debug!(
                %distro,
                "WSL liveness saw an unattributable agent; skipping this distribution"
            );
            continue;
        }
        let (apps, ambiguous) = resolve_rows(reading.rows);
        for terminal_id in terminal_ids {
            if ambiguous.contains(&terminal_id) {
                continue;
            }
            let Some(generation) = generations.get(&terminal_id).copied() else {
                continue;
            };
            let app = apps.get(&terminal_id).copied();
            snapshot.verdicts.insert(terminal_id, (generation, app));
        }
    }
    publish(snapshot);
}

/// Current PTY generation per terminal. Taken after `terminals` is released so
/// the AppState lock order (`terminals` before `pty_handles`) is preserved.
#[cfg(windows)]
fn pty_generations(state: &AppState) -> Result<HashMap<String, u64>, crate::error::AppError> {
    let handles = state.pty_handles.lock_or_err()?;
    Ok(handles
        .iter()
        .map(|(terminal_id, handle)| (terminal_id.clone(), handle.terminal_generation()))
        .collect())
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
pub fn parse_probe_output(output: &[u8]) -> Result<WslProbeReading, String> {
    let text = std::str::from_utf8(output).map_err(|_| "WSL liveness output was not UTF-8")?;
    let lines: Vec<&str> = text.lines().collect();
    if lines.first().copied() != Some(PROBE_HEADER) || lines.last().copied() != Some(PROBE_END) {
        return Err("WSL liveness output was incomplete".into());
    }
    let mut reading = WslProbeReading::default();
    for line in lines[1..lines.len() - 1]
        .iter()
        .filter(|line| !line.is_empty())
    {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["A", terminal_id, pid, name, depth] => {
                let Some(app) = app_from_comm(name) else {
                    return Err("WSL liveness row named an unexpected process".into());
                };
                if terminal_id.is_empty() {
                    return Err("WSL liveness row had no terminal marker".into());
                }
                reading.rows.push(WslAgentRow {
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
            ["U", pid, name] => {
                if app_from_comm(name).is_none() {
                    return Err("WSL liveness row named an unexpected process".into());
                }
                pid.parse::<u32>()
                    .ok()
                    .filter(|pid| *pid > 0)
                    .ok_or_else(|| "WSL liveness row had an invalid PID".to_string())?;
                reading.unattributable_agent = true;
            }
            _ => return Err("WSL liveness row had an invalid shape".into()),
        }
    }
    Ok(reading)
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

    const GEN: u64 = 7;

    fn snapshot(verdicts: &[(&str, u64, Option<&'static str>)]) -> WslLivenessSnapshot {
        WslLivenessSnapshot {
            verdicts: verdicts
                .iter()
                .map(|(id, generation, app)| ((*id).to_string(), (*generation, *app)))
                .collect(),
        }
    }

    fn fresh() -> WslLivenessSnapshot {
        snapshot(&[("t-claude", GEN, Some("Claude")), ("t-empty", GEN, None)])
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
        let snap = fresh();
        assert_eq!(
            decide(
                &snap,
                Duration::from_millis(10),
                "t-claude",
                GEN,
                Purpose::Display
            ),
            PtyAppLiveness::Running("Claude")
        );
        assert_eq!(
            decide(
                &snap,
                Duration::from_millis(10),
                "t-empty",
                GEN,
                Purpose::Display
            ),
            PtyAppLiveness::NoneAlive
        );
    }

    #[test]
    fn pane_without_a_verdict_never_gets_one() {
        let snap = fresh();
        assert_eq!(
            decide(
                &snap,
                Duration::from_millis(10),
                "t-other",
                GEN,
                Purpose::Display
            ),
            PtyAppLiveness::Unknown
        );
        assert_eq!(
            decide(
                &WslLivenessSnapshot::default(),
                Duration::ZERO,
                "t-claude",
                GEN,
                Purpose::Display
            ),
            PtyAppLiveness::Unknown
        );
    }

    /// A pane can be torn down and respawned under the same id (Restart View,
    /// profile change). A verdict about the previous PTY must not describe the
    /// replacement — otherwise the new shell inherits the old app state, and the
    /// CWD-propagation gate reads it too.
    #[test]
    fn verdict_from_a_previous_pty_generation_is_ignored() {
        let snap = fresh();
        assert_eq!(
            decide(
                &snap,
                Duration::from_millis(10),
                "t-claude",
                GEN + 1,
                Purpose::Display
            ),
            PtyAppLiveness::Unknown
        );
        assert_eq!(
            decide(
                &snap,
                Duration::from_millis(10),
                "t-empty",
                GEN + 1,
                Purpose::Display
            ),
            PtyAppLiveness::Unknown
        );
    }

    /// Exit suppression is one-shot: nothing re-runs it. A cached positive would
    /// therefore pin a pane that really did exit until some later title event,
    /// and there is no reconcile path to undo that (#767).
    #[test]
    fn exit_decisions_never_suppress_from_a_cached_positive() {
        let snap = fresh();
        assert_eq!(
            decide(
                &snap,
                Duration::ZERO,
                "t-claude",
                GEN,
                Purpose::ExitDecision
            ),
            PtyAppLiveness::Unknown
        );
        // The negative is unchanged: it suppresses nothing either way.
        assert_eq!(
            decide(&snap, Duration::ZERO, "t-empty", GEN, Purpose::ExitDecision),
            PtyAppLiveness::NoneAlive
        );
    }

    #[test]
    fn stale_negative_degrades_but_stale_positive_survives() {
        // A stale negative must not keep blocking the title/buffer heuristics:
        // that is exactly the failure this module exists to remove.
        let snap = fresh();
        let stale = WSL_LIVENESS_AUTHORITATIVE_MAX_AGE + Duration::from_secs(1);
        assert_eq!(
            decide(&snap, stale, "t-empty", GEN, Purpose::Display),
            PtyAppLiveness::Unknown
        );
        assert_eq!(
            decide(&snap, stale, "t-claude", GEN, Purpose::Display),
            PtyAppLiveness::Running("Claude")
        );
    }

    #[test]
    fn positive_expires_once_it_outlives_its_own_window() {
        let snap = fresh();
        assert_eq!(
            decide(
                &snap,
                WSL_LIVENESS_POSITIVE_MAX_AGE + Duration::from_secs(1),
                "t-claude",
                GEN,
                Purpose::Display
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
        let reading = parse_probe_output(output.as_bytes()).unwrap();
        assert_eq!(reading.rows.len(), 2);
        assert_eq!(reading.rows[0].app, "Claude");
        assert_eq!(reading.rows[1].pid, 40);
        assert!(!reading.unattributable_agent);
    }

    /// An agent the probe could not pin to a pane (`sudo claude` whose whole
    /// chain is another user's) must stop the pass from certifying any pane in
    /// that distribution as empty.
    #[test]
    fn an_unattributable_agent_is_reported_so_coverage_can_be_refused() {
        let output = concat!(
            "LAYMUX_WSL_LIVENESS_PROBE_V1\n",
            "A\tterminal-pane-a\t20\tclaude\t3\n",
            "U\t99\tcodex\n",
            "LAYMUX_WSL_LIVENESS_PROBE_END\n",
        );
        let reading = parse_probe_output(output.as_bytes()).unwrap();
        assert_eq!(reading.rows.len(), 1);
        assert!(reading.unattributable_agent);
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
        assert!(parse_probe_output(
            b"LAYMUX_WSL_LIVENESS_PROBE_V1\nU\t20\tbash\nLAYMUX_WSL_LIVENESS_PROBE_END\n"
        )
        .is_err());
        assert!(parse_probe_output(
            b"LAYMUX_WSL_LIVENESS_PROBE_V1\nU\t0\tclaude\nLAYMUX_WSL_LIVENESS_PROBE_END\n"
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
