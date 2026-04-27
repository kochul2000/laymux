//! Terminal activity state detection.
//!
//! Detects whether a terminal is at a shell prompt, running a command,
//! or running an interactive application (Claude Code, vim, etc.).
//! Also contains `BurstDetector` for DEC 2026 sustained TUI activity detection.

use std::sync::atomic::AtomicBool;
use std::time::Instant;

use crate::constants::{ACTIVITY_SCAN_BYTES, INTERACTIVE_APP_GRACE_WINDOW};
use crate::lock_ext::MutexExt;
use crate::osc;
use crate::output_buffer::TerminalOutputBuffer;
use crate::state::AppState;
use crate::terminal::{TerminalActivity, TerminalStateInfo};

/// Known interactive apps detected from terminal title (OSC 0 / OSC 2).
/// Pattern matching uses word boundaries to avoid false positives
/// (e.g., "vim" should not match "environment").
pub const INTERACTIVE_APP_PATTERNS: &[(&str, &str)] = &[
    ("Claude Code", "Claude"),
    ("OpenAI Codex", "Codex"),
    ("nvim", "neovim"),
    ("vim", "vim"),
    ("vi", "vim"),
    ("nano", "nano"),
    ("htop", "htop"),
    ("btop", "btop"),
    ("top", "top"),
    ("less", "less"),
    ("man ", "man"),
    ("python3", "python"),
    ("python", "python"),
    ("node", "node"),
    ("ipython", "ipython"),
];

/// Check if a terminal is running Claude Code.
/// Uses two-pronged detection:
/// 1. Persistent tracking (`known_claude_terminals`) — instant O(1) check
/// 2. Full buffer title scan — checks ALL OSC 0/2 titles, not just the last one
pub fn is_claude_terminal_from_buffer(
    state: &AppState,
    terminal_id: &str,
    buffer: Option<&TerminalOutputBuffer>,
) -> bool {
    // Prong 1: Check persistent tracking
    if let Ok(known) = state.known_claude_terminals.lock_or_err() {
        if known.contains(terminal_id) {
            return true;
        }
    }

    // Prong 2: Scan ALL titles in buffer for "Claude Code"
    let Some(buf) = buffer else {
        return false;
    };
    let recent = buf.recent_bytes(ACTIVITY_SCAN_BYTES);
    if recent.is_empty() {
        return false;
    }

    if osc::any_terminal_title_contains(&recent, "Claude Code") {
        // Mark persistently for future calls
        if let Ok(mut known) = state.known_claude_terminals.lock_or_err() {
            known.insert(terminal_id.to_string());
        }
        return true;
    }

    false
}

/// Check if Claude Code is idle (at its prompt) by looking for ✳ (U+2733) prefix in terminal title.
pub fn is_claude_idle_from_buffer(buffer: Option<&TerminalOutputBuffer>) -> bool {
    let Some(buf) = buffer else {
        return false;
    };
    let recent = buf.recent_bytes(ACTIVITY_SCAN_BYTES);
    if recent.is_empty() {
        return false;
    }
    if let Some(title) = osc::extract_last_terminal_title(&recent) {
        title.starts_with('\u{2733}')
    } else {
        false
    }
}

/// Check if a terminal is at a shell prompt by examining its output buffer.
pub fn is_terminal_at_prompt_from_buffer(buffer: Option<&TerminalOutputBuffer>) -> bool {
    let Some(buf) = buffer else {
        return true; // Unknown terminal → assume at prompt
    };
    let recent = buf.recent_bytes(ACTIVITY_SCAN_BYTES);
    if recent.is_empty() {
        return true; // No output yet → assume at prompt
    }

    let last_c = osc::find_last_osc_133(&recent, b"C");
    let last_d = osc::find_last_osc_133(&recent, b"D");

    match (last_c, last_d) {
        (Some(c_pos), Some(d_pos)) => d_pos > c_pos,
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (None, None) => true,
    }
}

/// Detect if a known interactive app is running based on the terminal title.
pub fn detect_interactive_app(data: &[u8]) -> Option<String> {
    let title = osc::extract_last_terminal_title(data)?;
    detect_interactive_app_from_title(&title)
}

/// Detect interactive app from an already-extracted title string.
/// Used by the PTY callback when the title is already available from OSC parsing.
///
/// Applies word-boundary matching to avoid false positives (e.g., "vim" should
/// not match "environment", "vi" should not match "Review"). Skips path-like
/// titles (containing `/` or `\`) that could false-positive on app names
/// embedded in directory names.
pub fn detect_interactive_app_from_title(title: &str) -> Option<String> {
    // Skip path-like titles (e.g. "//wsl.localhost/.../python_projects")
    if title.contains('/') || title.contains('\\') {
        return None;
    }

    for &(pattern, name) in INTERACTIVE_APP_PATTERNS {
        if is_word_match(title, pattern) {
            return Some(name.to_string());
        }
    }
    None
}

/// Check if `pattern` appears in `text` at a word boundary.
/// A word boundary is defined as: start/end of string, whitespace, `-`, or `:`.
fn is_word_match(text: &str, pattern: &str) -> bool {
    // Exact match
    if text == pattern {
        return true;
    }

    // Patterns ending with space (like "man ") use contains for prefix matching
    if pattern.ends_with(' ') {
        return text.contains(pattern);
    }

    let mut start = 0;
    while let Some(pos) = text[start..].find(pattern) {
        let abs_pos = start + pos;
        let end_pos = abs_pos + pattern.len();

        // Check left boundary: start of string or boundary char
        let left_ok = abs_pos == 0
            || text.as_bytes()[abs_pos - 1].is_ascii_whitespace()
            || matches!(text.as_bytes()[abs_pos - 1], b'-' | b':');

        // Check right boundary: end of string or boundary char
        let right_ok = end_pos == text.len()
            || text.as_bytes()[end_pos].is_ascii_whitespace()
            || matches!(text.as_bytes()[end_pos], b'-' | b':');

        if left_ok && right_ok {
            return true;
        }

        start = abs_pos + 1;
    }
    false
}

fn recent_buffer_contains(recent: &[u8], needle: &str) -> bool {
    let needle = needle.as_bytes();
    !needle.is_empty() && recent.windows(needle.len()).any(|window| window == needle)
}

pub fn is_codex_terminal_from_buffer(
    state: &AppState,
    terminal_id: &str,
    buffer: Option<&TerminalOutputBuffer>,
) -> bool {
    if let Ok(known) = state.known_codex_terminals.lock_or_err() {
        if known.contains(terminal_id) {
            return true;
        }
    }

    let Some(buf) = buffer else {
        return false;
    };
    let recent = buf.recent_bytes(ACTIVITY_SCAN_BYTES);
    if recent.is_empty() {
        return false;
    }

    let detected = osc::any_terminal_title_contains(&recent, "OpenAI Codex")
        || recent_buffer_contains(&recent, "OpenAI Codex");
    if detected {
        if let Ok(mut known) = state.known_codex_terminals.lock_or_err() {
            known.insert(terminal_id.to_string());
        }
    }
    detected
}

/// Sync the per-app `known_*_terminals` sets so they stay mutually exclusive.
///
/// Without this, a pane that previously ran Claude keeps its
/// `known_claude_terminals` membership forever — and the live-title detector's
/// Claude fast path then masks any later Codex transition (the inverse holds
/// too). Called whenever a direct title match confirms which app is running.
fn sync_known_caches(state: &AppState, terminal_id: &str, app_name: &str) {
    match app_name {
        "Codex" => {
            if let Ok(mut known) = state.known_codex_terminals.lock_or_err() {
                known.insert(terminal_id.to_string());
            }
            if let Ok(mut known) = state.known_claude_terminals.lock_or_err() {
                known.remove(terminal_id);
            }
        }
        "Claude" => {
            if let Ok(mut known) = state.known_claude_terminals.lock_or_err() {
                known.insert(terminal_id.to_string());
            }
            if let Ok(mut known) = state.known_codex_terminals.lock_or_err() {
                known.remove(terminal_id);
            }
        }
        _ => {}
    }
}

/// Remember that `app_name` was successfully detected on `terminal_id` at
/// `Instant::now()`. Used to seed the grace window (§14.4 / issue #237) so a
/// subsequent title event that resolves to `None` can still report the
/// previously known app for a short while.
fn record_interactive_app_detection(state: &AppState, terminal_id: &str, app_name: &str) {
    if let Ok(mut guard) = state.last_detected_interactive_app.lock_or_err() {
        guard.insert(
            terminal_id.to_string(),
            (app_name.to_string(), Instant::now()),
        );
    }
}

/// Grace-window fallback: if `terminal_id` had a successful detection within
/// `INTERACTIVE_APP_GRACE_WINDOW`, return that app name. Expired entries are
/// evicted so the map does not grow without bound on long-lived terminals.
fn lookup_interactive_app_within_grace_window(
    state: &AppState,
    terminal_id: &str,
) -> Option<String> {
    let mut guard = state.last_detected_interactive_app.lock_or_err().ok()?;
    let Some((name, ts)) = guard.get(terminal_id) else {
        return None;
    };
    if ts.elapsed() <= INTERACTIVE_APP_GRACE_WINDOW {
        return Some(name.clone());
    }
    // Expired — evict so the shell fallback path is stable.
    guard.remove(terminal_id);
    None
}

/// Forget the grace-window entry for `terminal_id`. Called when the terminal
/// session closes so stale timestamps cannot leak into a new PTY sharing the
/// same ID.
pub fn clear_interactive_app_grace_window(state: &AppState, terminal_id: &str) {
    if let Ok(mut guard) = state.last_detected_interactive_app.lock_or_err() {
        guard.remove(terminal_id);
    }
}

pub fn detect_interactive_app_from_live_title(
    state: &AppState,
    terminal_id: &str,
    title: &str,
    buffer: Option<&TerminalOutputBuffer>,
) -> Option<String> {
    // 1) Direct title match — authoritative. `sync_known_caches` keeps the
    //    per-app sets mutually exclusive so a Claude→Codex (or reverse)
    //    handover never leaves a stale fast-path entry behind.
    if let Some(name) = detect_interactive_app_from_title(title) {
        sync_known_caches(state, terminal_id, &name);
        record_interactive_app_detection(state, terminal_id, &name);
        return Some(name);
    }

    // 2) Persistent signals. Both helpers cover the cache fast-path AND a
    //    full-buffer banner scan, so this single layer subsumes the previous
    //    Claude-fast-path / Claude-buffer-scan / Codex-spinner-fallback split.
    //    Symmetric on purpose: callers may pass an empty title (e.g.
    //    `detect_terminal_state` when the recent window has no OSC 0/2) and
    //    still recover the right app.
    if is_codex_terminal_from_buffer(state, terminal_id, buffer) {
        record_interactive_app_detection(state, terminal_id, "Codex");
        return Some("Codex".to_string());
    }
    if is_claude_terminal_from_buffer(state, terminal_id, buffer) {
        record_interactive_app_detection(state, terminal_id, "Claude");
        return Some("Claude".to_string());
    }

    // 3) Grace window fallback (issue #237). When every other signal returns
    //    None — e.g. a Braille-only spinner frame before the buffer has
    //    accumulated the "Claude Code" banner, a path-like title during
    //    Claude's splash, or PowerShell rewriting the title on every
    //    keystroke — keep reporting the last detected app for a short window.
    //
    //    Caveat (scope of #237): if the underlying process actually exited
    //    (`/exit` inside Claude/Codex, external `kill`) the grace window will
    //    still preserve the stale name for up to `INTERACTIVE_APP_GRACE_WINDOW`
    //    before clearing itself. Binding the grace entry to child-process
    //    exit signals / OSC 133;D is tracked as a follow-up.
    lookup_interactive_app_within_grace_window(state, terminal_id)
}

/// Detect the activity state of a terminal from its output buffer.
pub fn detect_terminal_activity(buffer: Option<&TerminalOutputBuffer>) -> TerminalActivity {
    let Some(buf) = buffer else {
        return TerminalActivity::Shell;
    };
    let recent = buf.recent_bytes(ACTIVITY_SCAN_BYTES);
    if recent.is_empty() {
        return TerminalActivity::Shell;
    }

    if let Some(name) = detect_interactive_app(&recent) {
        return TerminalActivity::InteractiveApp { name };
    }

    let at_prompt = is_terminal_at_prompt_from_buffer(Some(buf));
    if at_prompt {
        return TerminalActivity::Shell;
    }

    TerminalActivity::Running
}

/// Detect full terminal state (activity) for a single terminal.
pub fn detect_terminal_state(
    state: &AppState,
    terminal_id: &str,
    buffer: Option<&TerminalOutputBuffer>,
) -> TerminalStateInfo {
    let activity = detect_terminal_activity(buffer);

    let Some(buf) = buffer else {
        return TerminalStateInfo { activity };
    };
    let recent = buf.recent_bytes(ACTIVITY_SCAN_BYTES);
    if recent.is_empty() {
        return TerminalStateInfo { activity };
    }

    // Run the same persistent-signal pipeline regardless of whether the
    // recent window currently carries an OSC 0/2 title. Passing an empty
    // string when no title is available lets the symmetric Codex/Claude
    // recovery in `detect_interactive_app_from_live_title` cover both #239
    // (Claude title scrolled out) and its Codex mirror — without it Codex
    // panes were misclassified as Shell, leaking cd-sync into them.
    let title = osc::extract_last_terminal_title(&recent).unwrap_or_default();
    if let Some(name) = detect_interactive_app_from_live_title(state, terminal_id, &title, buffer) {
        return TerminalStateInfo {
            activity: TerminalActivity::InteractiveApp { name },
        };
    }

    TerminalStateInfo { activity }
}

/// Detect terminal states for all terminals.
pub fn detect_all_terminal_states(
    state: &AppState,
) -> std::collections::HashMap<String, TerminalStateInfo> {
    let mut result = std::collections::HashMap::new();
    if let Ok(buffers) = state.output_buffers.lock_or_err() {
        if let Ok(terminals) = state.terminals.lock_or_err() {
            for id in terminals.keys() {
                let info = detect_terminal_state(state, id, buffers.get(id));
                result.insert(id.clone(), info);
            }
        }
    }
    result
}

// ── DEC 2026 Burst Detection ──

/// Bundled state for DEC 2026 burst detection in the PTY callback.
///
/// TUI apps (Claude Code, neovim) emit `\x1b[?2026h` (DEC Synchronized Output)
/// before each frame. Single events (focus redraw, keystroke echo) are filtered
/// by requiring `threshold` hits within `window`. Only then is an event emitted,
/// throttled to at most one per `throttle` interval.
///
/// Uses `Instant` (monotonic clock) instead of `SystemTime` to avoid NTP jumps
/// breaking the sliding window.
pub struct BurstDetector {
    window: std::time::Duration,
    threshold: u64,
    throttle: std::time::Duration,
    /// Sliding window state: (burst_start, burst_count, last_emit)
    /// Protected by Mutex because Instant is not Atomic-storable.
    inner: std::sync::Mutex<BurstDetectorInner>,
}

struct BurstDetectorInner {
    burst_start: Instant,
    burst_count: u64,
    last_emit: Instant,
}

impl BurstDetector {
    pub fn new(window_ms: u64, threshold: u64, throttle_ms: u64) -> Self {
        let now = Instant::now();
        Self {
            window: std::time::Duration::from_millis(window_ms),
            threshold,
            throttle: std::time::Duration::from_millis(throttle_ms),
            inner: std::sync::Mutex::new(BurstDetectorInner {
                burst_start: now,
                burst_count: 0,
                last_emit: now - std::time::Duration::from_millis(throttle_ms + 1),
            }),
        }
    }

    /// Record a DEC 2026h hit. Returns `true` if an event should be emitted
    /// (burst threshold reached + throttle interval elapsed).
    pub fn record_hit(&self) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        let now = Instant::now();

        // Sliding window: reset if window expired
        if now.duration_since(inner.burst_start) > self.window {
            inner.burst_start = now;
            inner.burst_count = 1;
        } else {
            inner.burst_count += 1;
        }

        if inner.burst_count >= self.threshold
            && now.duration_since(inner.last_emit) >= self.throttle
        {
            inner.last_emit = now;
            true
        } else {
            false
        }
    }
}

// ── Boundary-safe marker scanner ──

/// Scans streamed byte chunks for a fixed-length marker, correctly detecting
/// the marker even when it straddles chunk boundaries in PTY callback streams.
///
/// PTY callbacks do not guarantee byte-aligned chunks, so a marker like
/// `\x1b[?2026h` (DEC Synchronized Output set) may be split between two
/// callback invocations — e.g. chunk A ends with `...\x1b[?20` and chunk B
/// begins with `26h...`. A naive `windows(N).any(...)` on each chunk misses
/// such splits entirely.
///
/// `MarkerTailScanner` keeps the last `N - 1` bytes of the previous chunk in
/// an internal tail buffer and prepends them to the next chunk before
/// scanning. The tail buffer length is bounded by `N - 1` so the overhead is
/// a constant `N + chunk_len` bytes per call.
///
/// Contract:
/// - Returns `true` if the marker appears at least once across the combined
///   `tail || data` slice. Multiple occurrences within a single call still
///   return `true` exactly once — callers treat the return value as a
///   "marker seen?" flag, matching the previous `windows().any()` semantics
///   and preventing double-counting within the same callback invocation.
/// - On each call, the tail is refreshed to the last `min(N - 1, total_len)`
///   bytes of the combined slice (total_len = tail_len + data.len()) so the
///   next chunk can complete any marker that was left mid-sequence.
/// - The scanner keeps no allocation across calls; the tail is a fixed-size
///   array and `data` is borrowed.
pub struct MarkerTailScanner<const N: usize> {
    marker: &'static [u8],
    tail: [u8; N],
    tail_len: usize,
}

impl<const N: usize> MarkerTailScanner<N> {
    /// Construct a scanner for the given marker. The marker's length must equal
    /// `N`; otherwise scanning is a no-op that always returns `false`.
    ///
    /// `N` is the tail-buffer capacity and is expected to equal the marker
    /// length. We only need to retain `N - 1` bytes of tail to catch splits,
    /// but allocating `N` keeps the `tail` array size identical to the marker
    /// length and simplifies const-generic bookkeeping.
    pub const fn new(marker: &'static [u8]) -> Self {
        Self {
            marker,
            tail: [0u8; N],
            tail_len: 0,
        }
    }

    /// Scan `data` for the marker, honoring any tail carried from a previous
    /// call. Updates the tail to the last `min(N - 1, combined_len)` bytes of
    /// the combined slice so a boundary-split marker is detected on the next
    /// call.
    pub fn scan(&mut self, data: &[u8]) -> bool {
        let marker_len = self.marker.len();
        if marker_len == 0 || marker_len != N {
            return false;
        }

        let tail_retain = marker_len - 1; // bytes we must keep for the next call
        let combined_len = self.tail_len + data.len();

        // Build the combined slice. Fast path: if no tail, scan `data` directly.
        let hit = if self.tail_len == 0 {
            combined_len >= marker_len && data.windows(marker_len).any(|w| w == self.marker)
        } else {
            // Allocate a small stack buffer (2N capacity: previous tail + new tail-scan window).
            // We only need to scan the region that includes the boundary: tail + first
            // (marker_len - 1) bytes of data. Anything further into `data` is covered by
            // scanning `data` on its own.
            let mut boundary = [0u8; 32]; // N is small (≤16 for DEC 2026); guard for larger markers
            let scan_prefix_len = tail_retain.min(data.len());
            let boundary_len = self.tail_len + scan_prefix_len;
            if boundary_len <= boundary.len() {
                boundary[..self.tail_len].copy_from_slice(&self.tail[..self.tail_len]);
                boundary[self.tail_len..boundary_len].copy_from_slice(&data[..scan_prefix_len]);
                let boundary_hit = boundary_len >= marker_len
                    && boundary[..boundary_len]
                        .windows(marker_len)
                        .any(|w| w == self.marker);
                let data_hit =
                    data.len() >= marker_len && data.windows(marker_len).any(|w| w == self.marker);
                boundary_hit || data_hit
            } else {
                // Fallback for unusually large markers: heap-allocate the combined slice.
                let mut combined = Vec::with_capacity(boundary_len);
                combined.extend_from_slice(&self.tail[..self.tail_len]);
                combined.extend_from_slice(&data[..scan_prefix_len]);
                let boundary_hit = combined.windows(marker_len).any(|w| w == self.marker);
                let data_hit =
                    data.len() >= marker_len && data.windows(marker_len).any(|w| w == self.marker);
                boundary_hit || data_hit
            }
        };

        // Refresh the tail to the last `tail_retain` bytes of the combined stream.
        // This ensures the NEXT call's boundary scan covers any marker that just
        // began at the end of this call.
        let new_tail_len = tail_retain.min(combined_len);
        if new_tail_len == 0 {
            self.tail_len = 0;
        } else if new_tail_len <= data.len() {
            // All new tail bytes come from the end of `data`.
            let start = data.len() - new_tail_len;
            self.tail[..new_tail_len].copy_from_slice(&data[start..]);
            self.tail_len = new_tail_len;
        } else {
            // Some bytes from the previous tail must also be retained.
            // Layout of the combined buffer: [prev_tail (tail_len)] [data (data.len())]
            // new_tail_len > data.len(), so we keep the last `(new_tail_len - data.len())`
            // bytes of prev_tail followed by all of `data`.
            let from_prev = new_tail_len - data.len();
            let prev_start = self.tail_len - from_prev;
            // Copy prev-tail suffix to a scratch slot first to avoid aliasing.
            let mut scratch = [0u8; N];
            scratch[..from_prev].copy_from_slice(&self.tail[prev_start..self.tail_len]);
            scratch[from_prev..new_tail_len].copy_from_slice(data);
            self.tail[..new_tail_len].copy_from_slice(&scratch[..new_tail_len]);
            self.tail_len = new_tail_len;
        }

        hit
    }
}

/// Bundled per-terminal state captured by the PTY callback closure.
/// Groups individual `Arc<Atomic*>` fields into a single `Arc<PtyCallbackState>`.
pub struct PtyCallbackState {
    pub claude_detected: AtomicBool,
    pub burst_detector: BurstDetector,
    /// Boundary-aware DEC 2026 marker scanner. Mutex because `scan` mutates
    /// the internal tail, while the enclosing `PtyCallbackState` is shared
    /// via `Arc` across the PTY callback closure.
    dec_sync_scanner: std::sync::Mutex<MarkerTailScanner<8>>,
}

impl PtyCallbackState {
    pub fn new(burst_window_ms: u64, burst_threshold: u64, throttle_ms: u64) -> Self {
        Self {
            claude_detected: AtomicBool::new(false),
            burst_detector: BurstDetector::new(burst_window_ms, burst_threshold, throttle_ms),
            dec_sync_scanner: std::sync::Mutex::new(MarkerTailScanner::new(
                crate::constants::DEC_SYNC_OUTPUT_SET,
            )),
        }
    }

    /// Scan `data` for DEC 2026 Synchronized Output set markers, correctly
    /// handling markers split across PTY chunk boundaries.
    ///
    /// Returns `true` if a marker was seen in the combined `previous_tail ||
    /// data` stream. Caller feeds the result into `burst_detector.record_hit()`
    /// at most once per callback invocation, preserving the original
    /// "one hit per callback" accounting.
    ///
    /// On lock poisoning the scanner is skipped (returns `false`) — the old
    /// behavior silently missed all hits too, so this is no worse and avoids
    /// leaking a poisoned-lock panic into the PTY thread.
    pub fn scan_dec_sync_marker(&self, data: &[u8]) -> bool {
        match self.dec_sync_scanner.lock() {
            Ok(mut scanner) => scanner.scan(data),
            Err(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn detect_activity_empty_buffer() {
        assert!(matches!(
            detect_terminal_activity(None),
            TerminalActivity::Shell
        ));
    }

    #[test]
    fn interactive_app_patterns_not_empty() {
        assert!(!INTERACTIVE_APP_PATTERNS.is_empty());
    }

    #[test]
    fn detect_interactive_app_claude() {
        let data = b"\x1b]0;Claude Code\x07";
        assert_eq!(detect_interactive_app(data), Some("Claude".to_string()));
    }

    #[test]
    fn detect_interactive_app_codex() {
        let data = b"\x1b]0;OpenAI Codex\x07";
        assert_eq!(detect_interactive_app(data), Some("Codex".to_string()));
    }

    #[test]
    fn detect_interactive_app_vim() {
        let data = b"\x1b]2;vim - main.rs\x07";
        assert_eq!(detect_interactive_app(data), Some("vim".to_string()));
    }

    #[test]
    fn detect_interactive_app_none() {
        let data = b"\x1b]0;bash\x07";
        assert_eq!(detect_interactive_app(data), None);
    }

    #[test]
    fn prompt_detection_no_markers() {
        assert!(is_terminal_at_prompt_from_buffer(None));
    }

    // ── detect_interactive_app_from_title word boundary tests ──

    #[test]
    fn title_word_boundary_vim_not_environment() {
        // "vim" should not match "environment"
        assert_eq!(detect_interactive_app_from_title("environment"), None);
    }

    #[test]
    fn title_word_boundary_vi_not_review() {
        // "vi" should not match "Review"
        assert_eq!(detect_interactive_app_from_title("Review"), None);
    }

    #[test]
    fn title_word_boundary_vim_at_start() {
        assert_eq!(
            detect_interactive_app_from_title("vim main.rs"),
            Some("vim".to_string())
        );
    }

    #[test]
    fn title_word_boundary_vim_after_dash() {
        assert_eq!(
            detect_interactive_app_from_title("term-vim"),
            Some("vim".to_string())
        );
    }

    #[test]
    fn title_exact_match() {
        assert_eq!(
            detect_interactive_app_from_title("htop"),
            Some("htop".to_string())
        );
    }

    #[test]
    fn title_path_like_skipped() {
        // Path-like titles should not match
        assert_eq!(
            detect_interactive_app_from_title("//wsl.localhost/home/user/python_projects"),
            None
        );
        assert_eq!(
            detect_interactive_app_from_title("C:\\Users\\test\\vim"),
            None
        );
    }

    #[test]
    fn title_nvim_detected() {
        assert_eq!(
            detect_interactive_app_from_title("nvim"),
            Some("neovim".to_string())
        );
    }

    #[test]
    fn title_claude_code_detected() {
        assert_eq!(
            detect_interactive_app_from_title("Claude Code"),
            Some("Claude".to_string())
        );
    }

    #[test]
    fn title_codex_detected() {
        assert_eq!(
            detect_interactive_app_from_title("OpenAI Codex"),
            Some("Codex".to_string())
        );
        assert_eq!(detect_interactive_app_from_title("codex"), None);
    }

    #[test]
    fn codex_spinner_title_preserved_after_explicit_detection() {
        let state = AppState::new();
        let mut explicit = TerminalOutputBuffer::default();
        explicit.push(b"\x1b]0;OpenAI Codex\x07");
        assert_eq!(
            detect_terminal_state(&state, "t1", Some(&explicit)).activity,
            TerminalActivity::InteractiveApp {
                name: "Codex".to_string()
            }
        );

        let mut spinner = TerminalOutputBuffer::default();
        spinner.push("\x1b]0;\u{280b} laymux\x07".as_bytes());
        assert_eq!(
            detect_terminal_state(&state, "t1", Some(&spinner)).activity,
            TerminalActivity::InteractiveApp {
                name: "Codex".to_string()
            }
        );
    }

    #[test]
    fn codex_spinner_title_detected_from_banner_output() {
        let state = AppState::new();
        let mut spinner = TerminalOutputBuffer::default();
        spinner.push(b">- OpenAI Codex (v0.118.0)\r\n");
        spinner.push("\x1b]0;\u{280b} laymux\x07".as_bytes());
        assert_eq!(
            detect_interactive_app_from_live_title(&state, "t1", "\u{280b} laymux", Some(&spinner)),
            Some("Codex".to_string())
        );
        assert_eq!(
            detect_terminal_state(&state, "t1", Some(&spinner)).activity,
            TerminalActivity::InteractiveApp {
                name: "Codex".to_string()
            }
        );
    }

    #[test]
    fn title_claude_with_prefix() {
        // ✳ Claude Code (idle indicator)
        assert_eq!(
            detect_interactive_app_from_title("\u{2733} Claude Code"),
            Some("Claude".to_string())
        );
    }

    #[test]
    fn title_man_page() {
        assert_eq!(
            detect_interactive_app_from_title("man git"),
            Some("man".to_string())
        );
    }

    #[test]
    fn title_vi_exact() {
        assert_eq!(
            detect_interactive_app_from_title("vi"),
            Some("vim".to_string())
        );
    }

    // ── Grace window (#237) ──

    #[test]
    fn grace_window_preserves_claude_on_path_like_title() {
        // Regression for #237: Rust currently drops `interactiveApp` to `None`
        // whenever the live title is path-like (`C:\...`, `~/project`, etc.),
        // even though the terminal is still running Claude. The grace window
        // should keep the previously detected app alive across that brief
        // None gap.
        let state = AppState::new();
        let tid = "t-grace-claude";

        // 1) A real Claude detection primes the grace window.
        assert_eq!(
            detect_interactive_app_from_live_title(&state, tid, "Claude Code", None),
            Some("Claude".to_string())
        );

        // 2) Claude rewrites the title to a path-like value (PowerShell `prompt`
        //    or the repo path breadcrumb). Rust should still report "Claude".
        assert_eq!(
            detect_interactive_app_from_live_title(&state, tid, "C:\\Users\\dev\\project", None,),
            Some("Claude".to_string())
        );

        // 3) Braille-only spinner before `known_claude_terminals` would have
        //    been populated from a buffer banner — still preserved.
        assert_eq!(
            detect_interactive_app_from_live_title(&state, tid, "\u{280b} Task", None),
            Some("Claude".to_string())
        );
    }

    #[test]
    fn grace_window_preserves_codex_without_banner_in_buffer() {
        // Codex's spinner-title fallback requires "OpenAI Codex" in the buffer.
        // Before the banner is flushed — or after it rotates out of the 16KB
        // window — the fallback fails and the frontend sees `None`. The grace
        // window must bridge that gap once Codex has been detected at least
        // once.
        let state = AppState::new();
        let tid = "t-grace-codex";

        // Prime: real banner + explicit title.
        let mut explicit = TerminalOutputBuffer::default();
        explicit.push(b"\x1b]0;OpenAI Codex\x07");
        assert_eq!(
            detect_interactive_app_from_live_title(&state, tid, "OpenAI Codex", Some(&explicit),),
            Some("Codex".to_string())
        );

        // Simulate that the banner has rotated out and the current title is a
        // Braille spinner: without grace window this returns None because the
        // empty buffer has no "OpenAI Codex" for the fallback to anchor on.
        let empty = TerminalOutputBuffer::default();
        assert_eq!(
            detect_interactive_app_from_live_title(&state, tid, "\u{280b} laymux", Some(&empty),),
            Some("Codex".to_string())
        );
    }

    #[test]
    fn grace_window_expires_after_configured_duration() {
        // When the grace timestamp is older than the configured window, the
        // detector must return None again so a truly dead app stops showing up.
        use crate::constants::INTERACTIVE_APP_GRACE_WINDOW;

        let state = AppState::new();
        let tid = "t-grace-expire";

        // Prime a detection.
        assert_eq!(
            detect_interactive_app_from_live_title(&state, tid, "Claude Code", None),
            Some("Claude".to_string())
        );

        // Manually age the entry beyond the grace window. After #239 the
        // direct-title match path at step 1 also populates
        // `known_claude_terminals`, so simulate a real Claude exit by
        // clearing that set too — otherwise step 2 (fast path) would still
        // report "Claude" regardless of the grace window.
        {
            let mut guard = state.last_detected_interactive_app.lock().unwrap();
            let entry = guard.get_mut(tid).expect("entry must exist");
            entry.1 = Instant::now() - INTERACTIVE_APP_GRACE_WINDOW - Duration::from_millis(10);
        }
        state.known_claude_terminals.lock().unwrap().remove(tid);

        assert_eq!(
            detect_interactive_app_from_live_title(&state, tid, "C:\\Users\\dev\\project", None,),
            None,
        );
    }

    #[test]
    fn grace_window_refreshes_on_successful_detection() {
        // A fresh successful detection must refresh the timestamp so the
        // window slides forward.
        let state = AppState::new();
        let tid = "t-grace-refresh";

        // Prime an entry.
        detect_interactive_app_from_live_title(&state, tid, "Claude Code", None);

        // Age it manually to just under the limit.
        let aged = {
            let mut guard = state.last_detected_interactive_app.lock().unwrap();
            let entry = guard.get_mut(tid).unwrap();
            entry.1 = Instant::now() - Duration::from_secs(4);
            entry.1
        };

        // A brand-new successful detection should overwrite the timestamp
        // (and the app name, in case it changed).
        detect_interactive_app_from_live_title(&state, tid, "Claude Code", None);
        let refreshed = state
            .last_detected_interactive_app
            .lock()
            .unwrap()
            .get(tid)
            .map(|(_, t)| *t)
            .unwrap();
        assert!(refreshed > aged, "timestamp must be refreshed");
    }

    #[test]
    fn grace_window_replaced_when_different_app_detected() {
        // Transitioning to a different interactive app must update both the
        // name and timestamp — no stale sticky state.
        let state = AppState::new();
        let tid = "t-grace-switch";

        detect_interactive_app_from_live_title(&state, tid, "Claude Code", None);
        assert_eq!(
            state
                .last_detected_interactive_app
                .lock()
                .unwrap()
                .get(tid)
                .map(|(n, _)| n.clone()),
            Some("Claude".to_string())
        );

        // Switch to vim.
        assert_eq!(
            detect_interactive_app_from_live_title(&state, tid, "vim", None),
            Some("vim".to_string())
        );
        assert_eq!(
            state
                .last_detected_interactive_app
                .lock()
                .unwrap()
                .get(tid)
                .map(|(n, _)| n.clone()),
            Some("vim".to_string())
        );
    }

    #[test]
    fn grace_window_ignored_when_never_detected() {
        // Terminals that never had a successful detection must remain None
        // — the grace window cannot fabricate one.
        let state = AppState::new();
        assert_eq!(
            detect_interactive_app_from_live_title(
                &state,
                "t-fresh",
                "C:\\Users\\dev\\project",
                None,
            ),
            None,
        );
    }

    // ── Cache symmetry between Claude and Codex (P2 / P1) ──

    #[test]
    fn claude_cache_cleared_when_codex_title_takes_over() {
        // P2: a pane that previously ran Claude is reused for Codex. The
        // direct OpenAI Codex title hit must remove the stale
        // known_claude_terminals entry, otherwise a subsequent None-
        // returning title (path-like, spinner, brief gap) would fall back
        // through the Claude fast path and report Claude forever.
        let state = AppState::new();
        let tid = "t-claude-then-codex";

        let mut buf_claude = TerminalOutputBuffer::default();
        buf_claude.push(b"\x1b]0;Claude Code\x07");
        assert_eq!(
            detect_terminal_state(&state, tid, Some(&buf_claude)).activity,
            TerminalActivity::InteractiveApp {
                name: "Claude".to_string()
            }
        );
        assert!(state.known_claude_terminals.lock().unwrap().contains(tid));

        let mut buf_codex = TerminalOutputBuffer::default();
        buf_codex.push(b"\x1b]0;OpenAI Codex\x07");
        assert_eq!(
            detect_terminal_state(&state, tid, Some(&buf_codex)).activity,
            TerminalActivity::InteractiveApp {
                name: "Codex".to_string()
            }
        );
        assert!(
            !state.known_claude_terminals.lock().unwrap().contains(tid),
            "stale Claude cache must be cleared once Codex is confirmed"
        );
        assert!(state.known_codex_terminals.lock().unwrap().contains(tid));
    }

    #[test]
    fn known_codex_preserved_when_title_scrolls_off_buffer() {
        // P1: detect_terminal_state used to fall back only to
        // is_claude_terminal_from_buffer when the recent window had no OSC
        // title, so a Codex pane whose "OpenAI Codex" title had scrolled
        // past was reclassified as Shell — letting cd-sync inject into the
        // active Codex (the same class of bug as #239 but mirrored).
        let state = AppState::new();
        let tid = "t-codex-title-scrolled";

        let mut explicit = TerminalOutputBuffer::default();
        explicit.push(b"\x1b]0;OpenAI Codex\x07");
        assert_eq!(
            detect_terminal_state(&state, tid, Some(&explicit)).activity,
            TerminalActivity::InteractiveApp {
                name: "Codex".to_string()
            }
        );

        let mut no_title = TerminalOutputBuffer::default();
        no_title.push(b"plain output without an OSC title\r\n\x1b]133;D\x07");
        assert_eq!(
            detect_terminal_state(&state, tid, Some(&no_title)).activity,
            TerminalActivity::InteractiveApp {
                name: "Codex".to_string()
            }
        );
    }

    #[test]
    fn claude_removed_from_known_returns_false() {
        let state = AppState::new();
        let tid = "terminal-test";

        // Insert into known_claude_terminals
        state
            .known_claude_terminals
            .lock()
            .unwrap()
            .insert(tid.to_string());
        assert!(is_claude_terminal_from_buffer(&state, tid, None));

        // Remove (simulates Claude exit detection)
        state.known_claude_terminals.lock().unwrap().remove(tid);
        assert!(!is_claude_terminal_from_buffer(&state, tid, None));
    }

    // ── BurstDetector tests ──

    #[test]
    fn burst_below_threshold_does_not_emit() {
        let detector = BurstDetector::new(2000, 3, 1000);
        assert!(!detector.record_hit());
        assert!(!detector.record_hit());
        // 2 hits < threshold 3 → no emit
    }

    #[test]
    fn burst_at_threshold_emits() {
        let detector = BurstDetector::new(2000, 3, 1000);
        assert!(!detector.record_hit());
        assert!(!detector.record_hit());
        assert!(detector.record_hit()); // 3rd hit → emit
    }

    #[test]
    fn burst_throttle_prevents_rapid_emit() {
        let detector = BurstDetector::new(2000, 3, 1000);
        // First burst → emit
        for _ in 0..3 {
            detector.record_hit();
        }
        // Immediately after — still within throttle window
        assert!(!detector.record_hit());
        assert!(!detector.record_hit());
    }

    #[test]
    fn burst_window_expired_resets_count() {
        let detector = BurstDetector::new(0, 3, 0); // 0ms window → always expired
                                                    // Each hit resets the window, so count never accumulates past 1
        assert!(!detector.record_hit());
        assert!(!detector.record_hit());
        assert!(!detector.record_hit());
    }

    #[test]
    fn burst_sustained_activity_emits_after_throttle() {
        // Short throttle for test
        let detector = BurstDetector::new(5000, 2, 0); // 0ms throttle
        assert!(!detector.record_hit());
        assert!(detector.record_hit()); // 2nd → emit
        assert!(detector.record_hit()); // still above threshold, 0ms throttle → emit again
    }

    // ── MarkerTailScanner: boundary-split DEC 2026 detection ──
    //
    // Regression cover for #232: PTY chunks are not byte-aligned so
    // `\x1b[?2026h` may be split across successive callback invocations. The
    // scanner must detect the marker regardless of where the split falls.

    use crate::constants::DEC_SYNC_OUTPUT_SET;

    #[test]
    fn scanner_detects_marker_inside_single_chunk() {
        let mut scanner = MarkerTailScanner::<8>::new(DEC_SYNC_OUTPUT_SET);
        assert!(scanner.scan(b"prefix\x1b[?2026hsuffix"));
    }

    #[test]
    fn scanner_no_false_positive_in_plain_text() {
        let mut scanner = MarkerTailScanner::<8>::new(DEC_SYNC_OUTPUT_SET);
        assert!(!scanner.scan(b"total 42\ndrwxr-xr-x  2 user user 4096\n"));
    }

    #[test]
    fn scanner_detects_marker_split_at_exact_midpoint() {
        // `\x1b[?2026h` is 8 bytes; split 4|4 — neither half is long enough to
        // contain the marker, so without the tail buffer the hit would be lost.
        let mut scanner = MarkerTailScanner::<8>::new(DEC_SYNC_OUTPUT_SET);
        assert!(!scanner.scan(b"padding\x1b[?2")); // prefix + first half
        assert!(scanner.scan(b"026hmore")); // second half + trailing bytes
    }

    #[test]
    fn scanner_detects_marker_split_at_start_boundary() {
        // Marker is the final byte of chunk 1 and the remaining 7 bytes of chunk 2.
        // Without a 7-byte tail, the 1-byte suffix of chunk 1 is discarded and the
        // next chunk's `[?2026h` misses the leading ESC.
        let mut scanner = MarkerTailScanner::<8>::new(DEC_SYNC_OUTPUT_SET);
        assert!(!scanner.scan(b"hello\x1b"));
        assert!(scanner.scan(b"[?2026h"));
    }

    #[test]
    fn scanner_detects_marker_split_at_end_boundary() {
        // Chunk 1 ends with the full 7-byte prefix of the marker; chunk 2 starts
        // with the final byte `h`.
        let mut scanner = MarkerTailScanner::<8>::new(DEC_SYNC_OUTPUT_SET);
        assert!(!scanner.scan(b"world\x1b[?2026"));
        assert!(scanner.scan(b"h after"));
    }

    #[test]
    fn scanner_single_hit_per_call_regardless_of_count() {
        // Preserve the old `windows().any()` semantics: multiple markers in the
        // same chunk still report as a single hit so `record_hit()` is called
        // at most once per PTY callback.
        let mut scanner = MarkerTailScanner::<8>::new(DEC_SYNC_OUTPUT_SET);
        assert!(scanner.scan(b"\x1b[?2026h\x1b[?2026h\x1b[?2026h"));
    }

    #[test]
    fn scanner_does_not_double_count_across_boundary_and_body() {
        // Marker split across a boundary AND a second full marker later in
        // chunk 2. The scanner reports one hit; the caller still invokes
        // `record_hit()` once, matching pre-fix behavior.
        let mut scanner = MarkerTailScanner::<8>::new(DEC_SYNC_OUTPUT_SET);
        assert!(!scanner.scan(b"pad\x1b[?20"));
        assert!(scanner.scan(b"26h middle \x1b[?2026h tail"));
    }

    #[test]
    fn scanner_no_hit_when_no_marker_across_chunks() {
        // Tail retention must not fabricate hits when neither chunk nor their
        // combination contains the marker.
        let mut scanner = MarkerTailScanner::<8>::new(DEC_SYNC_OUTPUT_SET);
        assert!(!scanner.scan(b"abcdefg"));
        assert!(!scanner.scan(b"hijklmn"));
        assert!(!scanner.scan(b"\x1b[?202xx")); // close but wrong byte
    }

    #[test]
    fn scanner_handles_tiny_chunks_sequentially() {
        // Feed the marker one byte at a time — exercises the tail-growing code
        // path where `data.len() < tail_retain` and some prev-tail bytes must
        // be retained for the next call.
        let mut scanner = MarkerTailScanner::<8>::new(DEC_SYNC_OUTPUT_SET);
        let marker = DEC_SYNC_OUTPUT_SET;
        for (i, b) in marker.iter().enumerate() {
            let hit = scanner.scan(std::slice::from_ref(b));
            if i < marker.len() - 1 {
                assert!(!hit, "unexpected hit after {} bytes", i + 1);
            } else {
                assert!(hit, "missing hit on final byte of marker");
            }
        }
    }

    #[test]
    fn scanner_handles_empty_chunk() {
        let mut scanner = MarkerTailScanner::<8>::new(DEC_SYNC_OUTPUT_SET);
        assert!(!scanner.scan(b""));
        // Empty chunk must not clobber a partial tail from the previous call.
        assert!(!scanner.scan(b"\x1b[?202"));
        assert!(!scanner.scan(b""));
        assert!(scanner.scan(b"6h"));
    }

    #[test]
    fn scanner_detects_consecutive_markers_across_splits() {
        // Two markers with the second straddling the boundary.
        let mut scanner = MarkerTailScanner::<8>::new(DEC_SYNC_OUTPUT_SET);
        assert!(scanner.scan(b"\x1b[?2026h frame1 \x1b[?2")); // first complete, second partial
        assert!(scanner.scan(b"026h frame2 done")); // completes second
    }

    #[test]
    fn pty_callback_state_scan_preserves_tail_across_calls() {
        // Integration-style test against `PtyCallbackState::scan_dec_sync_marker`
        // — the actual entry point invoked by the PTY callback.
        let state = PtyCallbackState::new(2000, 3, 1000);
        assert!(!state.scan_dec_sync_marker(b"noise\x1b[?20"));
        assert!(state.scan_dec_sync_marker(b"26h more"));
    }

    #[test]
    fn pty_callback_state_scan_single_hit_matches_burst_accounting() {
        // The original `windows().any()` returned at most a single `true` per
        // callback, so `burst_detector.record_hit()` was called at most once.
        // The new scanner must keep that contract even when a boundary-split
        // marker AND an in-body marker both occur in the second chunk.
        let state = PtyCallbackState::new(2000, 3, 1000);
        assert!(!state.scan_dec_sync_marker(b"head\x1b[?"));
        // Chunk 2 completes the split marker AND contains another full marker.
        // Caller calls `record_hit()` once — treat as single hit.
        assert!(state.scan_dec_sync_marker(b"2026h middle \x1b[?2026h"));
    }
}
