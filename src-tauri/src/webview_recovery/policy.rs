//! What to do about one WebView2 `ProcessFailed` report (ADR-0336).
//!
//! Pure: every clock reading and the persisted restart history are inputs, so
//! the policy is unit-tested on every platform without a WebView.

use crate::constants::{
    WEBVIEW_HANG_SILENCE_MS, WEBVIEW_RECOVERY_MAX_RESTARTS, WEBVIEW_RECOVERY_WINDOW_MS,
};

/// `COREWEBVIEW2_PROCESS_FAILED_KIND`, mirrored so the policy needs no Windows
/// bindings. The Windows subscription checks the values against the SDK.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    BrowserProcessExited,
    RenderProcessExited,
    RenderProcessUnresponsive,
    FrameRenderProcessExited,
    UtilityProcessExited,
    SandboxHelperProcessExited,
    GpuProcessExited,
    PpapiPluginProcessExited,
    PpapiBrokerProcessExited,
    UnknownProcessExited,
    /// A kind newer than this build.
    Unrecognized(i32),
}

impl FailureKind {
    pub fn from_raw(value: i32) -> Self {
        match value {
            0 => Self::BrowserProcessExited,
            1 => Self::RenderProcessExited,
            2 => Self::RenderProcessUnresponsive,
            3 => Self::FrameRenderProcessExited,
            4 => Self::UtilityProcessExited,
            5 => Self::SandboxHelperProcessExited,
            6 => Self::GpuProcessExited,
            7 => Self::PpapiPluginProcessExited,
            8 => Self::PpapiBrokerProcessExited,
            9 => Self::UnknownProcessExited,
            other => Self::Unrecognized(other),
        }
    }

    /// Whether the main frame is gone for good: the browser process took
    /// every control with it, or the main-frame renderer died and left an
    /// error page. WebView2 restarts the other processes itself, and a dead
    /// subframe leaves the main frame running.
    fn loses_the_main_frame(self) -> bool {
        matches!(self, Self::BrowserProcessExited | Self::RenderProcessExited)
    }
}

/// `COREWEBVIEW2_PROCESS_FAILED_REASON`. Logged and shown; the policy does not
/// branch on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureReason {
    Unexpected,
    Unresponsive,
    Terminated,
    Crashed,
    LaunchFailed,
    OutOfMemory,
    ProfileDeleted,
    /// A reason newer than this build.
    Unrecognized(i32),
}

impl FailureReason {
    pub fn from_raw(value: i32) -> Self {
        match value {
            0 => Self::Unexpected,
            1 => Self::Unresponsive,
            2 => Self::Terminated,
            3 => Self::Crashed,
            4 => Self::LaunchFailed,
            5 => Self::OutOfMemory,
            6 => Self::ProfileDeleted,
            other => Self::Unrecognized(other),
        }
    }
}

/// What one report calls for, before the restart budget is consulted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Response {
    /// WebView2 recreates this process itself, or the main frame is unaffected.
    Record,
    /// The main-frame renderer is unresponsive, not yet for long.
    Wait,
    /// The main frame is gone or stuck: the WebView has to be replaced.
    Recover,
    /// A recovery is already underway.
    Ignore,
}

/// What the reports so far have established in this process.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RecoveryState {
    recovering: bool,
}

/// Classify one report. `frontend_silent_ms` is how long the frontend has sent
/// no health report ([`frontend_silence_ms`]); only an unresponsive renderer
/// looks at it.
///
/// WebView2 raises the unresponsive report for input the renderer leaves
/// unanswered, not on a timer, so how often it repeats depends on the user.
/// The frontend's own one-second heartbeat says how long its main thread has
/// been stuck.
pub fn assess(
    state: RecoveryState,
    kind: FailureKind,
    frontend_silent_ms: u64,
) -> (Response, RecoveryState) {
    if state.recovering {
        return (Response::Ignore, state);
    }
    let recovering = RecoveryState { recovering: true };
    if kind.loses_the_main_frame() {
        return (Response::Recover, recovering);
    }
    if kind != FailureKind::RenderProcessUnresponsive {
        return (Response::Record, state);
    }
    if frontend_silent_ms >= WEBVIEW_HANG_SILENCE_MS {
        (Response::Recover, recovering)
    } else {
        (Response::Wait, state)
    }
}

/// How long the frontend has sent no health report at `now_ms`: since its
/// last report, or since the subscription began if it never reported. Wall
/// clock; a clock that moved back reads as no silence, which never restarts.
pub fn frontend_silence_ms(
    last_report_at_ms: Option<u64>,
    watching_since_ms: u64,
    now_ms: u64,
) -> u64 {
    now_ms.saturating_sub(last_report_at_ms.unwrap_or(watching_since_ms))
}

/// Whether one more automatic restart fits the budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Budget {
    Restart,
    /// `recent` restarts already fill the window.
    Exhausted {
        recent: usize,
    },
}

/// `restarts` are wall-clock epoch milliseconds read from disk; so is `now_ms`.
pub fn budget(restarts: &[u64], now_ms: u64) -> Budget {
    let recent = restarts.iter().filter(|&&at| counts_at(at, now_ms)).count();
    if recent < WEBVIEW_RECOVERY_MAX_RESTARTS {
        Budget::Restart
    } else {
        Budget::Exhausted { recent }
    }
}

/// The history to persist when a restart at `now_ms` is granted: what still
/// counts, plus `now_ms`, bounded so the file cannot grow.
pub fn with_restart(restarts: &[u64], now_ms: u64) -> Vec<u64> {
    let mut kept: Vec<u64> = restarts
        .iter()
        .copied()
        .filter(|&at| counts_at(at, now_ms))
        .chain(std::iter::once(now_ms))
        .collect();
    kept.sort_unstable();
    // The newest `MAX` already exhaust the budget; older ones never matter.
    let excess = kept.len().saturating_sub(WEBVIEW_RECOVERY_MAX_RESTARTS);
    kept.drain(..excess);
    kept
}

/// A restart counts while it lies within the window of `now_ms` on either
/// side. One stamped ahead of the clock — the clock moved back — still holds
/// a restart loop off, but not for longer than one window.
fn counts_at(at: u64, now_ms: u64) -> bool {
    at.abs_diff(now_ms) < WEBVIEW_RECOVERY_WINDOW_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECOND: u64 = 1_000;
    const MINUTE: u64 = 60 * SECOND;
    /// A wall-clock "now" far from zero so that subtraction never saturates.
    const NOW: u64 = 1_760_000_000_000;

    /// Reports in order, each with how long the frontend had been silent.
    fn assess_all(reports: &[(FailureKind, u64)]) -> Vec<Response> {
        let mut state = RecoveryState::default();
        reports
            .iter()
            .map(|&(kind, silent_ms)| {
                let (response, next) = assess(state, kind, silent_ms);
                state = next;
                response
            })
            .collect()
    }

    #[test]
    fn kinds_map_from_the_documented_values() {
        let expected = [
            (0, FailureKind::BrowserProcessExited),
            (1, FailureKind::RenderProcessExited),
            (2, FailureKind::RenderProcessUnresponsive),
            (3, FailureKind::FrameRenderProcessExited),
            (4, FailureKind::UtilityProcessExited),
            (5, FailureKind::SandboxHelperProcessExited),
            (6, FailureKind::GpuProcessExited),
            (7, FailureKind::PpapiPluginProcessExited),
            (8, FailureKind::PpapiBrokerProcessExited),
            (9, FailureKind::UnknownProcessExited),
            (42, FailureKind::Unrecognized(42)),
            (-1, FailureKind::Unrecognized(-1)),
        ];
        for (raw, kind) in expected {
            assert_eq!(FailureKind::from_raw(raw), kind, "raw kind {raw}");
        }
    }

    #[test]
    fn reasons_map_from_the_documented_values() {
        let expected = [
            (0, FailureReason::Unexpected),
            (1, FailureReason::Unresponsive),
            (2, FailureReason::Terminated),
            (3, FailureReason::Crashed),
            (4, FailureReason::LaunchFailed),
            (5, FailureReason::OutOfMemory),
            (6, FailureReason::ProfileDeleted),
            (7, FailureReason::Unrecognized(7)),
        ];
        for (raw, reason) in expected {
            assert_eq!(FailureReason::from_raw(raw), reason, "raw reason {raw}");
        }
    }

    #[test]
    fn a_dead_browser_process_calls_for_recovery() {
        // Every WebView2 control of the environment is closed with it; only a
        // new WebView brings the UI back.
        let (response, _) = assess(
            RecoveryState::default(),
            FailureKind::BrowserProcessExited,
            0,
        );
        assert_eq!(response, Response::Recover);
    }

    #[test]
    fn a_dead_main_frame_renderer_calls_for_recovery() {
        // The main frame shows an error page until something replaces it.
        let (response, _) = assess(
            RecoveryState::default(),
            FailureKind::RenderProcessExited,
            0,
        );
        assert_eq!(response, Response::Recover);
    }

    #[test]
    fn processes_webview2_restarts_itself_are_only_recorded() {
        for kind in [
            FailureKind::GpuProcessExited,
            FailureKind::UtilityProcessExited,
            FailureKind::SandboxHelperProcessExited,
            FailureKind::PpapiPluginProcessExited,
            FailureKind::PpapiBrokerProcessExited,
            FailureKind::UnknownProcessExited,
            FailureKind::FrameRenderProcessExited,
            FailureKind::Unrecognized(42),
        ] {
            // However long the frontend has been silent.
            let (response, state) = assess(RecoveryState::default(), kind, u64::MAX);
            assert_eq!(response, Response::Record, "{kind:?}");
            assert_eq!(state, RecoveryState::default(), "{kind:?} changed state");
        }
    }

    #[test]
    fn an_unresponsive_renderer_whose_frontend_still_reports_waits() {
        // A main thread an output flood keeps busy (#606) misses input for a
        // while, but its health probe still gets through now and then.
        assert_eq!(
            assess_all(&[(FailureKind::RenderProcessUnresponsive, 2 * SECOND)]),
            [Response::Wait]
        );
    }

    #[test]
    fn an_unresponsive_renderer_silent_past_the_threshold_calls_for_recovery() {
        assert_eq!(
            assess_all(&[
                (
                    FailureKind::RenderProcessUnresponsive,
                    WEBVIEW_HANG_SILENCE_MS - 1
                ),
                (
                    FailureKind::RenderProcessUnresponsive,
                    WEBVIEW_HANG_SILENCE_MS
                ),
            ]),
            [Response::Wait, Response::Recover]
        );
    }

    #[test]
    fn a_single_report_is_enough_once_the_frontend_is_silent_long_enough() {
        // WebView2 raises the report only for input the renderer leaves
        // unanswered; a user who stops clicking produces no second report.
        assert_eq!(
            assess_all(&[(FailureKind::RenderProcessUnresponsive, 5 * MINUTE)]),
            [Response::Recover]
        );
    }

    #[test]
    fn silence_is_measured_from_the_last_health_report() {
        assert_eq!(
            frontend_silence_ms(Some(NOW - 7 * SECOND), NOW - MINUTE, NOW),
            7 * SECOND
        );
    }

    #[test]
    fn a_frontend_that_never_reported_is_silent_since_watching_began() {
        // A renderer stuck before the frontend booted far enough to report.
        assert_eq!(frontend_silence_ms(None, NOW - MINUTE, NOW), MINUTE);
    }

    #[test]
    fn a_clock_that_moved_back_reads_as_no_silence() {
        assert_eq!(
            frontend_silence_ms(Some(NOW + SECOND), NOW - MINUTE, NOW),
            0
        );
        assert_eq!(frontend_silence_ms(None, NOW + SECOND, NOW), 0);
    }

    #[test]
    fn reports_after_recovery_began_are_ignored() {
        // A dead browser process can be followed by renderer reports; the
        // first recovery already replaces everything.
        let responses = assess_all(&[
            (FailureKind::BrowserProcessExited, 0),
            (FailureKind::RenderProcessExited, 1),
            (FailureKind::RenderProcessUnresponsive, 2),
            (FailureKind::GpuProcessExited, 3),
        ]);
        assert_eq!(
            responses,
            [
                Response::Recover,
                Response::Ignore,
                Response::Ignore,
                Response::Ignore
            ]
        );
    }

    #[test]
    fn the_budget_grants_restarts_until_the_window_is_full() {
        assert_eq!(budget(&[], NOW), Budget::Restart);
        let mut restarts = Vec::new();
        for i in 0..WEBVIEW_RECOVERY_MAX_RESTARTS {
            assert_eq!(budget(&restarts, NOW), Budget::Restart, "after {i}");
            restarts.push(NOW - MINUTE + i as u64);
        }
        assert_eq!(
            budget(&restarts, NOW),
            Budget::Exhausted {
                recent: WEBVIEW_RECOVERY_MAX_RESTARTS
            }
        );
    }

    #[test]
    fn restarts_older_than_the_window_no_longer_count() {
        let old = vec![NOW - WEBVIEW_RECOVERY_WINDOW_MS; WEBVIEW_RECOVERY_MAX_RESTARTS];
        assert_eq!(budget(&old, NOW), Budget::Restart);
        let inside = vec![NOW - WEBVIEW_RECOVERY_WINDOW_MS + 1; WEBVIEW_RECOVERY_MAX_RESTARTS];
        assert_eq!(
            budget(&inside, NOW),
            Budget::Exhausted {
                recent: WEBVIEW_RECOVERY_MAX_RESTARTS
            }
        );
    }

    #[test]
    fn a_restart_stamped_ahead_of_the_clock_counts_unless_far_ahead() {
        // The clock moved back: a near-future stamp still blocks a restart
        // loop, but a stamp a whole window ahead cannot block recovery forever.
        let near = vec![NOW + MINUTE; WEBVIEW_RECOVERY_MAX_RESTARTS];
        assert!(matches!(budget(&near, NOW), Budget::Exhausted { .. }));
        let far = vec![NOW + WEBVIEW_RECOVERY_WINDOW_MS; WEBVIEW_RECOVERY_MAX_RESTARTS];
        assert_eq!(budget(&far, NOW), Budget::Restart);
    }

    #[test]
    fn a_granted_restart_drops_stale_entries_and_appends_now() {
        let restarts = [NOW - WEBVIEW_RECOVERY_WINDOW_MS - 1, NOW - MINUTE];
        assert_eq!(with_restart(&restarts, NOW), vec![NOW - MINUTE, NOW]);
    }

    #[test]
    fn the_persisted_history_stays_bounded() {
        // Restarts the user asks for past the budget are recorded too; the
        // file keeps only as many as the budget can ever look at.
        let mut restarts = Vec::new();
        for i in 0..10 {
            restarts = with_restart(&restarts, NOW + i * SECOND);
        }
        assert_eq!(restarts.len(), WEBVIEW_RECOVERY_MAX_RESTARTS);
        assert_eq!(restarts.last(), Some(&(NOW + 9 * SECOND)));
        assert!(matches!(
            budget(&restarts, NOW + 10 * SECOND),
            Budget::Exhausted { .. }
        ));
    }
}
