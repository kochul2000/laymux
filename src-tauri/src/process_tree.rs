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
//! executable name alone identifies the app, no command-line introspection.
//! On Linux they run as `claude` / `codex` (native launchers).
//!
//! This module is also the single source of process enumeration; `claude_session`
//! consumes `snapshot_processes` / `descendant_pids` for its session matching.

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

/// One process in a system snapshot.
#[derive(Debug, Clone)]
pub struct ProcessEntry {
    pub pid: u32,
    pub ppid: u32,
    /// Executable file name, as reported by the OS (e.g. `claude.exe`,
    /// `node.exe` on Windows; `claude`, `node` on Linux). Compared
    /// case-insensitively by `name_to_app`.
    pub name: String,
}

/// Map an executable file name to the interactive app it represents, or `None`.
/// Case-insensitive; a trailing `.exe` (Windows) is ignored.
fn name_to_app(name: &str) -> Option<&'static str> {
    let lowered = name.trim().to_ascii_lowercase();
    let stem = lowered.strip_suffix(".exe").unwrap_or(&lowered);
    match stem {
        "claude" => Some("Claude"),
        "codex" => Some("Codex"),
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
/// when no `claude`/`codex` process is found in the tree.
pub fn match_interactive_app(snapshot: &[ProcessEntry], root: u32) -> Option<&'static str> {
    let mut children: HashMap<u32, Vec<&ProcessEntry>> = HashMap::new();
    let mut name_by_pid: HashMap<u32, &str> = HashMap::new();
    for e in snapshot {
        children.entry(e.ppid).or_default().push(e);
        name_by_pid.insert(e.pid, e.name.as_str());
    }

    // The root PID itself (the PTY child) may be the app — e.g. when the
    // startup command launches `claude` directly with no intermediate shell.
    if let Some(name) = name_by_pid.get(&root) {
        if let Some(app) = name_to_app(name) {
            return Some(app);
        }
    }

    let mut queue = VecDeque::new();
    let mut seen = HashSet::new();
    queue.push_back(root);
    seen.insert(root);
    while let Some(pid) = queue.pop_front() {
        if let Some(kids) = children.get(&pid) {
            for kid in kids {
                if seen.insert(kid.pid) {
                    if let Some(app) = name_to_app(&kid.name) {
                        return Some(app);
                    }
                    queue.push_back(kid.pid);
                }
            }
        }
    }
    None
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
    let Ok(mut guard) = SNAPSHOT_CACHE.lock() else {
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

/// The liveness oracle: which interactive app, if any, is alive under the PTY
/// backing `terminal_id`. Returns `None` when the terminal has no PTY, the PTY
/// has no PID (e.g. serial connections), or no `claude`/`codex` process is in
/// its descendant tree.
///
/// Uses the TTL-cached snapshot so repeated calls within a burst of title
/// events share a single enumeration. For the hot positive-detection path,
/// a snapshot up to `SNAPSHOT_TTL` stale is fine (a just-exited process is
/// reported alive for at most one TTL, then self-corrects).
pub fn interactive_app_in_pty(state: &AppState, terminal_id: &str) -> Option<&'static str> {
    app_in_pty(state, terminal_id, false)
}

/// Like [`interactive_app_in_pty`] but forces a fresh enumeration, bypassing
/// the TTL cache. Used at exit-decision points (false-exit suppression): a
/// stale "still alive" snapshot taken just before the process exited would
/// wrongly suppress a genuine exit — by the time the shell emits its prompt
/// title the process is already gone, so the decision must use ground truth.
pub fn interactive_app_in_pty_fresh(state: &AppState, terminal_id: &str) -> Option<&'static str> {
    app_in_pty(state, terminal_id, true)
}

fn app_in_pty(state: &AppState, terminal_id: &str, force_fresh: bool) -> Option<&'static str> {
    let child_pid = {
        let handles = state.pty_handles.lock_or_err().ok()?;
        handles.get(terminal_id).and_then(|h| h.child_pid())?
    };
    with_snapshot(force_fresh, |snap| match_interactive_app(snap, child_pid))
}

// ── OS process enumeration ────────────────────────────────────────

/// Enumerate all live processes as `(pid, ppid, name)` triples.
/// Returns an empty vec when enumeration fails (caller treats as "unknown").
pub fn snapshot_processes() -> Vec<ProcessEntry> {
    #[cfg(windows)]
    {
        snapshot_processes_windows()
    }
    #[cfg(not(windows))]
    {
        snapshot_processes_proc()
    }
}

#[cfg(windows)]
fn snapshot_processes_windows() -> Vec<ProcessEntry> {
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
            return result;
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
                });
                if Process32Next(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
    }
    result
}

/// Linux: enumerate `/proc/<pid>/stat`. The `stat` line is
/// `pid (comm) state ppid ...`; `comm` (the executable name, truncated to 15
/// chars by the kernel) is between the first `(` and last `)`, and `ppid` is
/// the field after the single-char state. Parsing comm via the last `)` is
/// robust to process names that themselves contain spaces or parentheses.
#[cfg(not(windows))]
fn snapshot_processes_proc() -> Vec<ProcessEntry> {
    let mut result = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return result;
    };
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
        result.push(ProcessEntry { pid, ppid, name });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(pid: u32, ppid: u32, name: &str) -> ProcessEntry {
        ProcessEntry {
            pid,
            ppid,
            name: name.to_string(),
        }
    }

    // ── name_to_app ──

    #[test]
    fn name_to_app_matches_windows_exe() {
        assert_eq!(name_to_app("claude.exe"), Some("Claude"));
        assert_eq!(name_to_app("codex.exe"), Some("Codex"));
        assert_eq!(name_to_app("CLAUDE.EXE"), Some("Claude"));
    }

    #[test]
    fn name_to_app_matches_bare_name() {
        assert_eq!(name_to_app("claude"), Some("Claude"));
        assert_eq!(name_to_app("codex"), Some("Codex"));
    }

    #[test]
    fn name_to_app_rejects_others() {
        assert_eq!(name_to_app("node.exe"), None);
        assert_eq!(name_to_app("pwsh.exe"), None);
        assert_eq!(name_to_app("bash"), None);
        // Must not substring-match: "claude-wrapper" is not Claude.
        assert_eq!(name_to_app("claude-wrapper"), None);
    }

    // ── descendant_pids ──

    #[test]
    fn descendant_pids_includes_root_even_if_absent() {
        let snapshot: Vec<ProcessEntry> = vec![];
        let set = descendant_pids(&snapshot, 42);
        assert!(set.contains(&42));
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn descendant_pids_walks_transitively() {
        // 100 -> 200 -> 300, and 100 -> 400; 999 unrelated.
        let snapshot = vec![
            entry(200, 100, "a"),
            entry(300, 200, "b"),
            entry(400, 100, "c"),
            entry(999, 1, "x"),
        ];
        let set = descendant_pids(&snapshot, 100);
        assert!(set.contains(&100));
        assert!(set.contains(&200));
        assert!(set.contains(&300));
        assert!(set.contains(&400));
        assert!(!set.contains(&999));
    }

    // ── match_interactive_app ──

    #[test]
    fn match_finds_claude_descendant() {
        // pwsh(100) -> claude.exe(200) -> bash(300)
        let snapshot = vec![
            entry(100, 1, "pwsh.exe"),
            entry(200, 100, "claude.exe"),
            entry(300, 200, "bash.exe"),
        ];
        assert_eq!(match_interactive_app(&snapshot, 100), Some("Claude"));
    }

    #[test]
    fn match_finds_codex_descendant() {
        // pwsh(100) -> node(200, codex.js) -> codex.exe(300)
        let snapshot = vec![
            entry(100, 1, "pwsh.exe"),
            entry(200, 100, "node.exe"),
            entry(300, 200, "codex.exe"),
        ];
        assert_eq!(match_interactive_app(&snapshot, 100), Some("Codex"));
    }

    #[test]
    fn match_root_itself_is_the_app() {
        // PTY launched `claude` directly: root == claude.exe.
        let snapshot = vec![entry(200, 100, "claude.exe"), entry(300, 200, "bash.exe")];
        assert_eq!(match_interactive_app(&snapshot, 200), Some("Claude"));
    }

    #[test]
    fn match_shallowest_wins_when_both_present() {
        // Claude pane that spawned Codex as a subprocess: claude is nearer the
        // root, so the pane is reported as Claude, not Codex.
        let snapshot = vec![
            entry(100, 1, "pwsh.exe"),
            entry(200, 100, "claude.exe"),
            entry(300, 200, "node.exe"),
            entry(400, 300, "codex.exe"),
        ];
        assert_eq!(match_interactive_app(&snapshot, 100), Some("Claude"));
    }

    #[test]
    fn match_none_when_no_app_in_tree() {
        let snapshot = vec![
            entry(100, 1, "pwsh.exe"),
            entry(200, 100, "node.exe"),
            entry(300, 200, "git.exe"),
        ];
        assert_eq!(match_interactive_app(&snapshot, 100), None);
    }

    #[test]
    fn match_ignores_app_outside_subtree() {
        // codex.exe(900) belongs to an unrelated tree, not under root 100.
        let snapshot = vec![
            entry(100, 1, "pwsh.exe"),
            entry(200, 100, "node.exe"),
            entry(900, 1, "codex.exe"),
        ];
        assert_eq!(match_interactive_app(&snapshot, 100), None);
    }
}
