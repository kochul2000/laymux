//! Recovery from WebView2 process failures (ADR-0336).
//!
//! The WebView is the whole UI. When WebView2 reports that the browser
//! process or the main-frame renderer is gone, or the renderer unresponsive
//! while the frontend's heartbeat has been silent for long, this GUI hands
//! its PTY daemon sessions over and starts its successor, the same way an
//! update does (ADR-0308). A small persisted budget stops a session that
//! keeps killing WebView2 from restarting forever; past it the user is asked.
//!
//! The policy, the persisted budget and the notice text are platform-neutral
//! and unit-tested everywhere. The subscription and the relaunch are Windows
//! code.

mod history;
mod notice;
mod policy;
#[cfg(windows)]
mod process_failed;
#[cfg(windows)]
mod relaunch;

pub use history::{claim_restart, record_restart, Claim};
pub use notice::{exit_code_text, notice_body, StopCause, NOTICE_TITLE};
pub use policy::{
    assess, budget, frontend_silence_ms, with_restart, Budget, FailureKind, FailureReason,
    RecoveryState, Response,
};
#[cfg(windows)]
pub use process_failed::watch_main_webview;
#[cfg(windows)]
pub use relaunch::{relaunch_gui, wait_for_predecessor};
