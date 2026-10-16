//! The native notice shown when the WebView failed and this GUI will not
//! restart itself (ADR-0336). The dialog asks one yes/no question: restart
//! now, or quit. Either way the PTY daemon sessions are handed over before
//! this GUI exits.

use super::policy::{FailureKind, FailureReason};
use crate::constants::{
    PTY_DAEMON_GRACE_MAX_MINUTES, PTY_DAEMON_GRACE_MIN_MINUTES, WEBVIEW_RECOVERY_WINDOW_MS,
};

pub const NOTICE_TITLE: &str = "Laymux 화면 복구 중단";
const UNKNOWN: &str = "알 수 없음";

/// Why the GUI did not restart itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopCause {
    /// `recent` automatic restarts already happened inside the window.
    Exhausted { recent: usize },
    /// The restart could not be recorded, so a restart might never stop.
    Unrecorded(String),
    /// The next GUI process could not be started.
    LaunchFailed(String),
}

/// The dialog text. `grace_minutes` is `terminal.ptyDaemonGraceMinutes`.
pub fn notice_body(
    kind: FailureKind,
    reason: Option<FailureReason>,
    exit_code: Option<i32>,
    cause: &StopCause,
    grace_minutes: u32,
) -> String {
    let lead = match cause {
        StopCause::Exhausted { recent } => format!(
            "laymux 화면(WebView2)이 다시 실패했습니다. 최근 {window}분 동안 이미 {recent}번 \
             자동으로 다시 시작했으므로 더 이상 자동으로 다시 시작하지 않습니다.",
            window = WEBVIEW_RECOVERY_WINDOW_MS / 60_000,
        ),
        StopCause::Unrecorded(error) => format!(
            "laymux 화면(WebView2)이 실패했지만 재시작 기록을 저장하지 못해({error}) 자동으로 \
             다시 시작하지 않았습니다. 기록 없이 다시 시작하면 같은 실패가 끝없이 반복될 수 \
             있습니다."
        ),
        StopCause::LaunchFailed(error) => format!(
            "laymux 화면(WebView2)이 실패해 laymux를 다시 시작하려 했지만 새 창을 띄우지 \
             못했습니다({error})."
        ),
    };
    let reason = reason.map_or_else(|| UNKNOWN.to_string(), |reason| format!("{reason:?}"));
    let exit_code = exit_code_text(exit_code);
    // The daemon clamps the setting the same way (ADR-0312).
    let grace = grace_minutes.clamp(PTY_DAEMON_GRACE_MIN_MINUTES, PTY_DAEMON_GRACE_MAX_MINUTES);
    format!(
        "{lead}\n\n\
         실패 종류: {kind:?}\n\
         이유: {reason}\n\
         종료 코드: {exit_code}\n\n\
         PTY 데몬이 실행하는 터미널 작업은 그대로 실행되며, {grace}분 안에 laymux를 다시 열면 \
         이어집니다. 메모리나 시스템 핸들이 부족하면 다시 시작해도 같은 실패가 반복될 수 \
         있습니다.\n\n\
         지금 laymux를 다시 시작할까요?\n\
         [예] 다시 시작   [아니요] 종료"
    )
}

/// An exit code as signed decimal and, the way crash reports print it, as
/// unsigned hex (`0x80000003` is a breakpoint exception).
pub fn exit_code_text(code: Option<i32>) -> String {
    code.map_or_else(
        || UNKNOWN.to_string(),
        |code| format!("{code} (0x{:08X})", code as u32),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exhausted(grace_minutes: u32) -> String {
        notice_body(
            FailureKind::BrowserProcessExited,
            Some(FailureReason::Crashed),
            Some(0x8000_0003_u32 as i32),
            &StopCause::Exhausted { recent: 2 },
            grace_minutes,
        )
    }

    #[test]
    fn the_notice_names_the_failure() {
        let body = exhausted(10);
        assert!(body.contains("BrowserProcessExited"), "{body}");
        assert!(body.contains("Crashed"), "{body}");
        // The exit code as WebView2 crash reports print it.
        assert!(body.contains("0x80000003"), "{body}");
    }

    #[test]
    fn the_notice_explains_the_budget() {
        let body = exhausted(10);
        let window_minutes = WEBVIEW_RECOVERY_WINDOW_MS / 60_000;
        assert!(body.contains(&format!("{window_minutes}분")), "{body}");
        assert!(body.contains("2번"), "{body}");
    }

    #[test]
    fn the_notice_says_how_long_terminals_wait() {
        assert!(exhausted(25).contains("25분 안에"));
        // The daemon clamps the setting the same way (ADR-0312).
        assert!(exhausted(0).contains(&format!("{PTY_DAEMON_GRACE_MIN_MINUTES}분 안에")));
        assert!(exhausted(u32::MAX).contains(&format!("{PTY_DAEMON_GRACE_MAX_MINUTES}분 안에")));
    }

    #[test]
    fn the_notice_asks_one_yes_no_question() {
        // MessageBoxW labels its buttons itself, so the text names them.
        let body = exhausted(10);
        assert!(body.contains("[예]"), "{body}");
        assert!(body.contains("[아니요]"), "{body}");
    }

    #[test]
    fn a_failed_relaunch_says_the_next_window_did_not_start() {
        let body = notice_body(
            FailureKind::BrowserProcessExited,
            Some(FailureReason::Crashed),
            None,
            &StopCause::LaunchFailed("Windows error 1450".into()),
            10,
        );
        assert!(body.contains("Windows error 1450"), "{body}");
        assert!(body.contains("새 창"), "{body}");
    }

    #[test]
    fn an_unrecorded_restart_says_why_it_was_not_attempted() {
        let body = notice_body(
            FailureKind::RenderProcessExited,
            None,
            None,
            &StopCause::Unrecorded("IO: access denied".into()),
            10,
        );
        assert!(body.contains("IO: access denied"), "{body}");
        assert!(body.contains("RenderProcessExited"), "{body}");
        assert!(
            body.contains("알 수 없음"),
            "unknown reason/exit code: {body}"
        );
    }
}
