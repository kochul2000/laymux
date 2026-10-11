//! Process-tree liveness oracle for interactive-app detection (ADR-0009).
//!
//! Answers "is Claude / Codex actually still running under this PTY?" by
//! walking the PTY child's descendant process tree and matching executable
//! names. The process tree is ground truth — title/buffer signals are
//! ambiguous (spinner-only titles are shared across TUIs) and ephemeral (the
//! 16KB `ACTIVITY_SCAN_BYTES` window scrolls past the startup banner), so they
//! cannot authoritatively decide that an app has exited. This module owns the
//! liveness verdict; the title state machine keeps owning working/idle/message.
//!
//! On Windows, Claude runs as `claude.exe` and Codex as `codex.exe` — the
//! executable name identifies candidates; a proven app-server role is excluded.
//! On Linux they run as `claude` / `codex` (native launchers).
//!
//! This module is also the single source of process enumeration; agent session
//! attribution consumes snapshots, descendant sets, and exact app PIDs here.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::lock_ext::MutexExt;
use crate::state::AppState;

/// TTL for the cached global process snapshot. OSC 0/2 title events fire on
/// every spinner tick (several per second); without caching, each detection
/// pass would trigger a full process enumeration. One shared snapshot per
/// second bounds the cost to ~1 enumeration/sec regardless of terminal count.
const SNAPSHOT_TTL: Duration = Duration::from_millis(1000);

mod roles;

/// One process in a system snapshot.
#[derive(Debug, Clone)]
pub struct ProcessEntry {
    pub pid: u32,
    pub ppid: u32,
    /// Executable file name, as reported by the OS (e.g. `claude.exe`,
    /// `node.exe` on Windows; `claude`, `node` on Linux). Compared
    /// case-insensitively by `name_to_app`.
    pub name: String,
    /// Proven non-interactive role. Keep its PID/PPID for descendant traversal.
    pub is_helper: bool,
}

impl ProcessEntry {
    fn interactive_app(&self) -> Option<&'static str> {
        if self.is_helper {
            None
        } else {
            name_to_app(&self.name)
        }
    }
}

/// Preserve every terminal whose live process identified the provider,
/// even when an exact session ID cannot be proven. `None` is a
/// deliberate fail-closed attribution, distinct from a terminal where that
/// provider is not currently running.
pub(crate) fn complete_agent_session_attributions(
    observed_terminal_ids: &[String],
    exact: HashMap<String, String>,
) -> HashMap<String, Option<String>> {
    let mut result: HashMap<String, Option<String>> = observed_terminal_ids
        .iter()
        .cloned()
        .map(|terminal_id| (terminal_id, None))
        .collect();
    for (terminal_id, session_id) in exact {
        result.insert(terminal_id, Some(session_id));
    }
    result
}

/// Reject a session ID attributed to more than one terminal after every host
/// adapter has contributed its result. A collision is evidence that no pane
/// owns the session uniquely, including native-to-WSL and WSL-to-WSL pairs.
pub(crate) fn reject_duplicate_session_attributions(
    mut attributions: HashMap<String, Option<String>>,
    provider: &str,
) -> HashMap<String, Option<String>> {
    let mut seen = HashSet::new();
    let mut duplicates = HashSet::new();
    for session_id in attributions.values().flatten() {
        if !seen.insert(session_id.clone()) {
            duplicates.insert(session_id.clone());
        }
    }
    if !duplicates.is_empty() {
        tracing::warn!(
            provider,
            ?duplicates,
            "agent session attribution collision; skipping restore"
        );
        for session_id in attributions.values_mut() {
            if session_id
                .as_ref()
                .is_some_and(|session_id| duplicates.contains(session_id))
            {
                *session_id = None;
            }
        }
    }
    attributions
}

/// Map an executable file name to the interactive app it represents, or `None`.
/// Case-insensitive; a trailing `.exe` (Windows) is ignored.
fn name_to_app(name: &str) -> Option<&'static str> {
    let lowered = name.trim().to_ascii_lowercase();
    let stem = lowered.strip_suffix(".exe").unwrap_or(&lowered);
    match stem {
        "claude" => Some("Claude"),
        "codex" => Some("Codex"),
        "grok" => Some("Grok"),
        _ => None,
    }
}

/// Collect `root` and all of its transitive descendants from a snapshot.
/// Always includes `root` itself, even when the snapshot does not contain it.
pub fn descendant_pids(snapshot: &[ProcessEntry], root: u32) -> HashSet<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for e in snapshot {
        children.entry(e.ppid).or_default().push(e.pid);
    }
    let mut result = HashSet::new();
    let mut queue = VecDeque::new();
    result.insert(root);
    queue.push_back(root);
    while let Some(pid) = queue.pop_front() {
        if let Some(kids) = children.get(&pid) {
            for &kid in kids {
                if result.insert(kid) {
                    queue.push_back(kid);
                }
            }
        }
    }
    result
}

/// Identify the interactive app running under `root` in this snapshot.
///
/// Breadth-first from `root` so the **shallowest** matching process wins: when
/// a Claude pane spawns Codex as a subprocess (or vice versa) the foreground
/// app the shell launched sits nearer the root and is reported. Returns `None`
/// when no supported agent or no unique shallowest process is found.
#[cfg(test)]
fn match_interactive_app(snapshot: &[ProcessEntry], root: u32) -> Option<&'static str> {
    match_interactive_app_process(snapshot, root).map(|(_, app)| app)
}

/// Identify the shallowest interactive app and return its exact OS process ID.
/// Session attribution needs the PID while liveness callers only consume the app name.
pub fn match_interactive_app_process(
    snapshot: &[ProcessEntry],
    root: u32,
) -> Option<(u32, &'static str)> {
    match shallowest_interactive_app_processes(snapshot, root).as_slice() {
        [candidate] => Some(*candidate),
        _ => None,
    }
}

// Keep multiple matches for liveness even though exact PID attribution rejects them.
fn shallowest_interactive_app_processes(
    snapshot: &[ProcessEntry],
    root: u32,
) -> Vec<(u32, &'static str)> {
    let mut children: HashMap<u32, Vec<&ProcessEntry>> = HashMap::new();
    let mut by_pid: HashMap<u32, &ProcessEntry> = HashMap::new();
    for e in snapshot {
        children.entry(e.ppid).or_default().push(e);
        by_pid.insert(e.pid, e);
    }

    // The root PID itself (the PTY child) may be the app — e.g. when the
    // startup command launches `claude` directly with no intermediate shell.
    if let Some(entry) = by_pid.get(&root) {
        if let Some(app) = entry.interactive_app() {
            return vec![(root, app)];
        }
    }

    let mut queue = VecDeque::new();
    let mut seen = HashSet::new();
    queue.push_back(root);
    seen.insert(root);
    while !queue.is_empty() {
        let level = queue.len();
        let mut found = Vec::new();
        for _ in 0..level {
            let pid = queue.pop_front().expect("level drained from queue");
            if let Some(kids) = children.get(&pid) {
                for kid in kids {
                    if seen.insert(kid.pid) {
                        if let Some(app) = kid.interactive_app() {
                            found.push((kid.pid, app));
                        } else {
                            queue.push_back(kid.pid);
                        }
                    }
                }
            }
        }
        if !found.is_empty() {
            return found;
        }
    }
    Vec::new()
}

/// Cached global process snapshot. Independent of any `AppState` lock — it
/// mirrors OS state, not app state — so it carries no lock-ordering obligation.
static SNAPSHOT_CACHE: Mutex<Option<(Instant, Vec<ProcessEntry>)>> = Mutex::new(None);

/// Run `f` against a process snapshot no older than `SNAPSHOT_TTL`, refreshing
/// on miss (or unconditionally when `force_fresh`). `f` runs while the cache
/// lock is held, so the snapshot is borrowed, never cloned — the hot detection
/// path calls this per terminal per title tick, so avoiding the per-call clone
/// of the whole process list matters. On lock poisoning, falls back to an
/// uncached fresh enumeration.
fn with_snapshot<R>(force_fresh: bool, f: impl FnOnce(&[ProcessEntry]) -> R) -> R {
    let Ok(mut guard) = SNAPSHOT_CACHE.lock_or_err() else {
        return f(&snapshot_processes());
    };
    let stale = guard
        .as_ref()
        .is_none_or(|(ts, _)| ts.elapsed() >= SNAPSHOT_TTL);
    if force_fresh || stale {
        *guard = Some((Instant::now(), snapshot_processes()));
    }
    // Just populated above when stale/forced; otherwise the existing entry is fresh.
    f(&guard.as_ref().expect("snapshot cache populated").1)
}

/// Result of the liveness oracle. Distinguishes an authoritative negative from
/// "no signal" — the distinction the call sites need: a negative is ground
/// truth and must beat stale heuristics (e.g. a `Claude Code` banner still
/// resident in the recent 16KB buffer after a title-less exit — SIGKILL, a
/// dropped PTY callback), whereas `Unknown` must fall back to those heuristics
/// rather than assert an exit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyAppLiveness {
    /// `claude`/`codex` is alive in the PTY's descendant tree.
    Running(&'static str),
    /// Multiple shallowest agent processes are alive; no exact owner can be chosen.
    Ambiguous,
    /// The snapshot was readable and the PTY's PID is known, but no
    /// `claude`/`codex` process is under it — authoritative "nothing alive here".
    NoneAlive,
    /// No liveness signal: the PTY has no PID (e.g. serial), or the process
    /// snapshot could not be enumerated. Callers fall back to title/buffer.
    Unknown,
}

/// Classify liveness from a `child_pid` and a process `snapshot`. Pure — split
/// out so the negative/unknown distinction is unit-testable without a live PTY
/// or real OS enumeration.
///
/// - `child_pid == None` → `Unknown` (no PID to anchor the tree walk).
/// - empty `snapshot` → `Unknown` (enumeration failed; there is always at least
///   the calling process, so an empty list means failure, not "no processes").
/// - non-empty snapshot, app found → `Running`.
/// - multiple shallowest agents → `Ambiguous` (never an authoritative exit).
/// - non-empty snapshot, no app found → `NoneAlive` (authoritative negative).
pub(crate) fn classify(child_pid: Option<u32>, snapshot: &[ProcessEntry]) -> PtyAppLiveness {
    let Some(pid) = child_pid else {
        return PtyAppLiveness::Unknown;
    };
    if snapshot.is_empty() {
        return PtyAppLiveness::Unknown;
    }
    match shallowest_interactive_app_processes(snapshot, pid).as_slice() {
        [] => PtyAppLiveness::NoneAlive,
        [(_, app)] => PtyAppLiveness::Running(app),
        _ => PtyAppLiveness::Ambiguous,
    }
}

/// Whether a title-derived `exited` signal for `app` must be neutralized
/// because the process tree shows that same app still alive under the PTY
/// (ADR-0009 false-exit suppression). The title state machines
/// (`process_claude_title` / `process_codex_title`) report `exited` for any
/// title that no longer looks like the app — but a transient non-app title
/// (a subprocess's OSC title, a path-like prompt, Codex's bare cwd-basename
/// idle title — #297) is not an exit while the process is alive. The process
/// tree is ground truth, so this returns `true` only on `Running(app)`.
///
/// Pure so the load-bearing decision is unit-testable without a live PTY: the
/// PTY callback feeds it the state machine's `exited` flag and a fresh
/// `interactive_app_in_pty_fresh` verdict. CRUCIAL for #297: a `NoneAlive`
/// (process genuinely gone) or `Unknown` (no PID / snapshot miss) verdict does
/// NOT suppress — a real exit flows through, and when the tree cannot see the
/// process the title signal is honored rather than wrongly pinning a dead pane.
pub fn suppresses_false_exit(app: &str, liveness: PtyAppLiveness) -> bool {
    matches!(liveness, PtyAppLiveness::Running(alive) if alive == app)
}

/// The liveness oracle: whether `claude`/`codex` is alive under the PTY backing
/// `terminal_id` (`Running`), or the process tree authoritatively says nothing
/// is (`NoneAlive`), or there is no signal (`Unknown`).
///
/// Uses the TTL-cached snapshot so repeated calls within a burst of title
/// events share a single enumeration. For the hot positive-detection path,
/// a snapshot up to `SNAPSHOT_TTL` stale is fine (a just-exited process is
/// reported alive for at most one TTL, then self-corrects).
pub fn interactive_app_in_pty(state: &AppState, terminal_id: &str) -> PtyAppLiveness {
    app_in_pty(state, terminal_id, false)
}

/// Like [`interactive_app_in_pty`] but forces a fresh enumeration, bypassing
/// the TTL cache. Used at exit-decision points (false-exit suppression): a
/// stale "still alive" snapshot taken just before the process exited would
/// wrongly suppress a genuine exit — by the time the shell emits its prompt
/// title the process is already gone, so the decision must use ground truth.
pub fn interactive_app_in_pty_fresh(state: &AppState, terminal_id: &str) -> PtyAppLiveness {
    app_in_pty(state, terminal_id, true)
}

fn app_in_pty(state: &AppState, terminal_id: &str, force_fresh: bool) -> PtyAppLiveness {
    let (child_pid, wsl_target) = match state.pty_handles.lock_or_err() {
        Ok(handles) => match handles.get(terminal_id) {
            Some(handle) => (
                handle.child_pid(),
                handle.is_wsl_backed().then(|| handle.terminal_generation()),
            ),
            None => (None, None),
        },
        Err(_) => (None, None),
    };
    // A WSL pane's agent is a Linux process inside the guest, which no Windows
    // snapshot enumerates — the local tree would only ever find `wsl.exe` and
    // report the authoritative negative `NoneAlive`, silently suppressing the
    // title/buffer detectors for every WSL pane. Hand the verdict to the guest
    // probe, which answers `Unknown` when it has nothing to say (ADR-0134).
    //
    // `force_fresh` cannot mean anything here: the guest is unreachable from
    // this thread, so exit decisions read the same published verdict as display.
    // The guest probe owns WSL exits and the reconcile worker publishes the
    // correction when a suppression turns out to be wrong (ADR-0135).
    if let Some(generation) = wsl_target {
        return crate::wsl_liveness::liveness(terminal_id, generation);
    }
    // No PID → no tree to walk; skip enumeration entirely.
    if child_pid.is_none() {
        return PtyAppLiveness::Unknown;
    }
    with_snapshot(force_fresh, |snap| classify(child_pid, snap))
}

// ── OS process enumeration ────────────────────────────────────────

/// Enumerate all live processes as `(pid, ppid, name)` triples.
/// Returns an empty vec when enumeration fails (caller treats as "unknown").
pub fn snapshot_processes() -> Vec<ProcessEntry> {
    try_snapshot_processes().unwrap_or_default()
}

/// Enumerate processes without erasing the difference between an empty result
/// and an OS enumeration failure. Session attribution uses this checked form
/// because failure must preserve the previous resume id.
pub fn try_snapshot_processes() -> Result<Vec<ProcessEntry>, String> {
    #[cfg(windows)]
    let mut entries = snapshot_processes_windows()?;
    #[cfg(not(windows))]
    let mut entries = snapshot_processes_proc()?;
    roles::mark_helpers(&mut entries);
    Ok(entries)
}

#[cfg(windows)]
fn snapshot_processes_windows() -> Result<Vec<ProcessEntry>, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };

    /// RAII guard that closes the snapshot HANDLE on drop, preventing leaks on panic.
    struct SnapshotGuard(windows_sys::Win32::Foundation::HANDLE);
    impl Drop for SnapshotGuard {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    let mut result = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return Err("failed to create the operating-system process snapshot".into());
        }
        let _guard = SnapshotGuard(snap);

        let mut entry: PROCESSENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32>() as u32;
        if Process32First(snap, &mut entry) != 0 {
            loop {
                // szExeFile is a NUL-terminated ANSI string. `c as u8` is a
                // no-op for u8 and a safe reinterpret for i8 platforms.
                let name: Vec<u8> = entry
                    .szExeFile
                    .iter()
                    .take_while(|&&c| c != 0)
                    .map(|&c| c as u8)
                    .collect();
                result.push(ProcessEntry {
                    pid: entry.th32ProcessID,
                    ppid: entry.th32ParentProcessID,
                    name: String::from_utf8_lossy(&name).into_owned(),
                    is_helper: false,
                });
                if Process32Next(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
    }
    if result.is_empty() {
        Err("operating-system process snapshot was empty".into())
    } else {
        Ok(result)
    }
}

/// Linux: enumerate `/proc/<pid>/stat`. The `stat` line is
/// `pid (comm) state ppid ...`; `comm` (the executable name, truncated to 15
/// chars by the kernel) is between the first `(` and last `)`, and `ppid` is
/// the field after the single-char state. Parsing comm via the last `)` is
/// robust to process names that themselves contain spaces or parentheses.
#[cfg(not(windows))]
fn snapshot_processes_proc() -> Result<Vec<ProcessEntry>, String> {
    let mut result = Vec::new();
    let entries = std::fs::read_dir("/proc")
        .map_err(|error| format!("failed to enumerate /proc: {error}"))?;
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Some(open) = stat.find('(') else { continue };
        let Some(close) = stat.rfind(')') else {
            continue;
        };
        if close < open {
            continue;
        }
        let name = stat[open + 1..close].to_string();
        // After ") " comes: state ppid ...
        let rest: Vec<&str> = stat[close + 1..].split_whitespace().collect();
        // rest[0] = state, rest[1] = ppid
        let ppid = rest.get(1).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
        result.push(ProcessEntry {
            pid,
            ppid,
            name,
            is_helper: false,
        });
    }
    if result.is_empty() {
        Err("operating-system process snapshot was empty".into())
    } else {
        Ok(result)
    }
}

#[cfg(test)]
mod tests;
