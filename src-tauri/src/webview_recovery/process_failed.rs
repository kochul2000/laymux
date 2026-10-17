//! Windows: the main WebView's `ProcessFailed` subscription (ADR-0336).
//!
//! WebView2 raises `ProcessFailed` on the UI thread. The handler reads the
//! event args there — they are only valid during the callback — and leaves
//! everything that blocks (the history file, the terminal handoff, the dialog)
//! to a worker thread.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2ProcessFailedEventArgs, ICoreWebView2ProcessFailedEventArgs2,
    ICoreWebView2ProcessFailedEventArgs3, COREWEBVIEW2_PROCESS_FAILED_KIND,
    COREWEBVIEW2_PROCESS_FAILED_REASON,
};
use webview2_com::{take_pwstr, ProcessFailedEventHandler};
use windows_core::{Interface, PWSTR};

use super::history::{claim_restart, record_restart, Claim};
use super::notice::{exit_code_text, notice_body, StopCause, NOTICE_TITLE};
use super::policy::{
    assess, frontend_silence_ms, FailureKind, FailureReason, RecoveryState, Response,
};
use super::relaunch::relaunch_gui;
use crate::constants::{MAIN_WINDOW_LABEL, WEBVIEW_RECOVERY_HISTORY_FILE};
use crate::lock_ext::MutexExt;
use crate::state::AppState;

/// Stands in for a kind WebView2 failed to report: logged, never acted on.
const UNREADABLE_KIND: i32 = -1;

type Job = Box<dyn FnOnce() + Send>;

/// Subscribe to the main WebView's `ProcessFailed`. Runs once from setup,
/// after `AppState` is managed. A failed subscription only loses recovery.
pub fn watch_main_webview(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        tracing::warn!("no main window; WebView2 process failures will not be recovered");
        return;
    };
    let recovery = Arc::new(Recovery {
        app: app.clone(),
        state: Mutex::new(RecoveryState::default()),
        watching_since_ms: wall_clock_ms(),
    });
    let reached = window.with_webview(move |webview| {
        // SAFETY: the controller is used on the UI thread that owns it.
        let subscribed = unsafe { webview.controller().CoreWebView2() }
            .and_then(|core| subscribe(&core, recovery));
        match subscribed {
            Ok(()) => tracing::info!("watching WebView2 process failures"),
            Err(error) => {
                tracing::warn!(%error, "could not subscribe to WebView2 process failures")
            }
        }
    });
    if let Err(error) = reached {
        tracing::warn!(%error, "could not reach the main WebView to watch its processes");
    }
}

fn subscribe(core: &ICoreWebView2, recovery: Arc<Recovery>) -> windows_core::Result<()> {
    let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
        if let Some(args) = args {
            recovery.handle(FailureReport::read(&args));
        }
        Ok(())
    }));
    // The handler stays registered for the life of the WebView.
    let mut token = 0;
    // SAFETY: `handler` is a live COM object and `token` outlives the call.
    unsafe { core.add_ProcessFailed(&handler, &mut token) }
}

/// The policy state of this GUI process and what acting on it needs.
struct Recovery {
    app: AppHandle,
    state: Mutex<RecoveryState>,
    /// When the subscription began: a frontend that never reported has been
    /// silent since then.
    watching_since_ms: u64,
}

impl Recovery {
    /// On the UI thread: classify and log the report, then hand a recovery
    /// to a worker.
    fn handle(self: &Arc<Self>, report: FailureReport) {
        let silent_ms = self.frontend_silent_ms();
        let response = match self.state.lock_or_err() {
            Ok(mut state) => {
                let (response, next) = assess(*state, report.kind, silent_ms);
                *state = next;
                response
            }
            Err(error) => {
                // Without the state a restart loop cannot be ruled out.
                tracing::error!(%error, "WebView recovery state unavailable; not recovering");
                Response::Ignore
            }
        };
        report.log(response, silent_ms);
        if response != Response::Recover {
            return;
        }
        if session_is_ending() {
            // WebView2 dies with a logoff or shutdown; a restart would only
            // start a GUI the session is about to end.
            tracing::info!("the Windows session is ending; not restarting the GUI");
            return;
        }
        let recovery = Arc::clone(self);
        off_ui_thread(Box::new(move || recovery.recover(&report)));
    }

    /// On a worker: restart if the budget allows, otherwise ask the user.
    /// Every path hands the daemon sessions over exactly once and exits:
    /// the broken window never lingers.
    fn recover(&self, report: &FailureReport) {
        let history =
            crate::settings::cache_dir_path().map(|dir| dir.join(WEBVIEW_RECOVERY_HISTORY_FILE));
        let cause = match claim_restart(history.as_deref(), wall_clock_ms()) {
            Claim::Granted => {
                // Hand over before starting the next GUI: its bounded wait for
                // this process to exit starts when it does.
                hand_over_terminals(&self.app);
                match relaunch_gui() {
                    Ok(next) => {
                        tracing::warn!(
                            kind = ?report.kind,
                            next,
                            "restarting the GUI to replace its WebView"
                        );
                    }
                    Err(error) => {
                        tracing::error!(%error, "could not start the next GUI; asking the user");
                        let cause = StopCause::LaunchFailed(error);
                        if ask_to_restart(&self.app, report, &cause) {
                            relaunch_at_users_request(history.as_deref());
                        }
                    }
                }
                self.app.exit(0);
                return;
            }
            Claim::Exhausted { recent } => {
                tracing::error!(
                    recent,
                    "WebView recovery restarts exhausted; asking the user"
                );
                StopCause::Exhausted { recent }
            }
            Claim::Unrecorded(error) => {
                tracing::error!(
                    %error,
                    "cannot record a WebView recovery restart; asking the user"
                );
                StopCause::Unrecorded(error.to_string())
            }
        };
        // Ask before handing over: until the user answers, Remote and the
        // Automation API keep working with the terminals.
        let restart = ask_to_restart(&self.app, report, &cause);
        hand_over_terminals(&self.app);
        if restart {
            relaunch_at_users_request(history.as_deref());
        } else {
            tracing::warn!("quitting after the WebView failed; daemon sessions wait for a GUI");
        }
        self.app.exit(0);
    }

    /// How long the frontend has sent no health report (ADR-0080). Unknown
    /// reads as no silence, which never restarts.
    fn frontend_silent_ms(&self) -> u64 {
        let Some(state) = self.app.try_state::<Arc<AppState>>() else {
            return 0;
        };
        match state.frontend_health.last_report_at_ms() {
            Ok(last) => frontend_silence_ms(last, self.watching_since_ms, wall_clock_ms()),
            Err(error) => {
                tracing::warn!(%error, "frontend health unavailable; treating it as reporting");
                0
            }
        }
    }
}

/// A restart the user asked for: outside the budget, but recorded so that the
/// next failure inside the window asks again.
fn relaunch_at_users_request(history: Option<&Path>) {
    if let Some(path) = history {
        if let Err(error) = record_restart(path, wall_clock_ms()) {
            tracing::warn!(%error, "could not record the requested restart");
        }
    }
    match relaunch_gui() {
        Ok(next) => tracing::warn!(next, "restarting the GUI at the user's request"),
        Err(error) => tracing::error!(%error, "could not start the next GUI"),
    }
}

/// What one `ProcessFailed` report says.
struct FailureReport {
    kind: FailureKind,
    reason: Option<FailureReason>,
    exit_code: Option<i32>,
    /// Which utility process failed, e.g. "Audio Service".
    process_description: Option<String>,
    /// The module the failure came from, e.g. `msedge.dll`.
    failure_module: Option<String>,
}

impl FailureReport {
    /// Read everything while `args` is valid, which is only during the
    /// callback. Older runtimes lack the later interfaces; the kind alone
    /// decides what happens.
    fn read(args: &ICoreWebView2ProcessFailedEventArgs) -> Self {
        let mut raw_kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
        // SAFETY: valid out pointer; `args` is alive for the callback.
        let kind = match unsafe { args.ProcessFailedKind(&mut raw_kind) } {
            Ok(()) => FailureKind::from_raw(raw_kind.0),
            Err(error) => {
                tracing::warn!(%error, "unreadable WebView2 process failure kind");
                FailureKind::Unrecognized(UNREADABLE_KIND)
            }
        };
        let mut report = Self {
            kind,
            reason: None,
            exit_code: None,
            process_description: None,
            failure_module: None,
        };
        if let Ok(args) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
            let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
            // SAFETY: valid out pointers; the returned string is ours to free,
            // which `take_pwstr` does.
            unsafe {
                if args.Reason(&mut reason).is_ok() {
                    report.reason = Some(FailureReason::from_raw(reason.0));
                }
                let mut exit_code = 0;
                if args.ExitCode(&mut exit_code).is_ok() {
                    report.exit_code = Some(exit_code);
                }
                let mut description = PWSTR::null();
                if args.ProcessDescription(&mut description).is_ok() {
                    report.process_description = non_empty(take_pwstr(description));
                }
            }
        }
        if let Ok(args) = args.cast::<ICoreWebView2ProcessFailedEventArgs3>() {
            let mut module = PWSTR::null();
            // SAFETY: as above.
            if unsafe { args.FailureSourceModulePath(&mut module) }.is_ok() {
                report.failure_module = non_empty(take_pwstr(module));
            }
        }
        report
    }

    fn log(&self, response: Response, frontend_silent_ms: u64) {
        let exit_code = exit_code_text(self.exit_code);
        macro_rules! log_at {
            ($level:ident) => {
                tracing::$level!(
                    kind = ?self.kind,
                    reason = ?self.reason,
                    exit_code = %exit_code,
                    process_description = ?self.process_description,
                    failure_module = ?self.failure_module,
                    frontend_silent_ms,
                    ?response,
                    "WebView2 process failed"
                )
            };
        }
        match response {
            Response::Recover => log_at!(error),
            Response::Wait | Response::Record => log_at!(warn),
            Response::Ignore => log_at!(info),
        }
    }
}

fn non_empty(text: String) -> Option<String> {
    (!text.is_empty()).then_some(text)
}

fn session_is_ending() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SHUTTINGDOWN};
    // SAFETY: a plain query without pointers.
    unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) != 0 }
}

fn wall_clock_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Ask whether to restart now. The dialog blocks the worker, not the UI.
fn ask_to_restart(app: &AppHandle, report: &FailureReport, cause: &StopCause) -> bool {
    let grace_minutes = crate::settings::load_settings()
        .terminal
        .pty_daemon_grace_minutes;
    let body = notice_body(
        report.kind,
        report.reason,
        report.exit_code,
        cause,
        grace_minutes,
    );
    let mut dialog = rfd::MessageDialog::new()
        .set_title(NOTICE_TITLE)
        .set_description(&body)
        .set_level(rfd::MessageLevel::Error)
        .set_buttons(rfd::MessageButtons::YesNo);
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        dialog = dialog.set_parent(&window);
    }
    // A dialog that cannot be shown answers as if declined: quit, and let
    // the user reopen laymux once the system recovers.
    matches!(dialog.show(), rfd::MessageDialogResult::Yes)
}

/// Leave the PTY daemon sessions running for the next GUI — the one just
/// started, or the one the user opens within the grace (ADR-0312) — and end
/// the PTYs this GUI owns, in the order of the installer teardown (ADR-0201,
/// ADR-0308, ADR-0319): the titles are picked while the handles are
/// registered and written last. The exit that follows then leaves the
/// daemon sessions alone.
fn hand_over_terminals(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        tracing::warn!("app state unavailable; exiting without a terminal handoff");
        return;
    };
    state.begin_update_handoff();
    let titles = crate::update_title_handoff::begin(&state);
    state.terminate_child_processes();
    titles.save(&state);
}

/// Run `job` on its own thread. Spawning fails only when the system is out
/// of resources — the case this recovers from — and then the job runs here,
/// on the UI thread, rather than not at all.
fn off_ui_thread(job: Job) {
    let slot = Arc::new(Mutex::new(Some(job)));
    let worker_slot = Arc::clone(&slot);
    let spawned = std::thread::Builder::new()
        .name("webview-recovery".into())
        .spawn(move || run_slot(&worker_slot));
    if let Err(error) = spawned {
        tracing::error!(%error, "no thread for WebView recovery; recovering on the UI thread");
        run_slot(&slot);
    }
}

fn run_slot(slot: &Mutex<Option<Job>>) {
    let job = match slot.lock_or_err() {
        Ok(mut job) => job.take(),
        Err(error) => {
            tracing::error!(%error, "WebView recovery job unavailable");
            None
        }
    };
    if let Some(job) = job {
        job();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;

    #[test]
    fn mirrored_kinds_match_the_sdk() {
        let sdk = [
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
                FailureKind::BrowserProcessExited,
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
                FailureKind::RenderProcessExited,
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
                FailureKind::RenderProcessUnresponsive,
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
                FailureKind::FrameRenderProcessExited,
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
                FailureKind::UtilityProcessExited,
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED,
                FailureKind::SandboxHelperProcessExited,
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
                FailureKind::GpuProcessExited,
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED,
                FailureKind::PpapiPluginProcessExited,
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED,
                FailureKind::PpapiBrokerProcessExited,
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED,
                FailureKind::UnknownProcessExited,
            ),
        ];
        for (raw, kind) in sdk {
            assert_eq!(FailureKind::from_raw(raw.0), kind);
        }
    }

    #[test]
    fn mirrored_reasons_match_the_sdk() {
        let sdk = [
            (
                COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED,
                FailureReason::Unexpected,
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE,
                FailureReason::Unresponsive,
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED,
                FailureReason::Terminated,
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED,
                FailureReason::Crashed,
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED,
                FailureReason::LaunchFailed,
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY,
                FailureReason::OutOfMemory,
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_REASON_PROFILE_DELETED,
                FailureReason::ProfileDeleted,
            ),
        ];
        for (raw, reason) in sdk {
            assert_eq!(FailureReason::from_raw(raw.0), reason);
        }
    }

    #[test]
    fn an_unreadable_kind_is_never_acted_on() {
        let (response, _) = assess(
            RecoveryState::default(),
            FailureKind::from_raw(UNREADABLE_KIND),
            u64::MAX,
        );
        assert_eq!(response, Response::Record);
    }

    #[test]
    fn a_running_session_is_not_ending() {
        assert!(!session_is_ending());
    }

    #[test]
    fn a_job_runs_off_the_calling_thread() {
        let caller = std::thread::current().id();
        let (sender, receiver) = std::sync::mpsc::channel();
        off_ui_thread(Box::new(move || {
            let _ = sender.send(std::thread::current().id());
        }));
        let worker = receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert_ne!(worker, caller);
    }
}
