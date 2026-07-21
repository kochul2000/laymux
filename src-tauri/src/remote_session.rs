//! OS-level remote-desktop session detection.
//!
//! The intended scenario: laymux is already running on the desktop, and the
//! user opens Windows Remote Desktop *from their phone* to reach that window.
//! When the window is entered over a remote session driven by a phone we want
//! the Remote Access panel open so the phone can quickly switch to the mobile
//! web UI. A desktop-to-desktop RDP session must not pop the panel.
//!
//! This module only answers the coarse "is this an RDP session?" question via
//! Terminal Services and pushes a transition event to the UI. RDP exposes no
//! device-type flag, so the phone-vs-desktop decision lives in the frontend
//! (`useAutoRemoteAccessPrompt` / `isPhoneLikeRemoteScreen`), which inspects the
//! session's display geometry — a phone client is portrait and narrow on its
//! short edge. The laymux window's own width is not used for this: a
//! non-maximized window never fires a `resize` on connect.

#[cfg(target_os = "windows")]
pub fn is_remote_session() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_REMOTESESSION};
    // SAFETY: `GetSystemMetrics` is a pure query with no preconditions.
    // A non-zero return means the calling process is attached to a Terminal
    // Services (RDP) client session rather than the physical console.
    unsafe { GetSystemMetrics(SM_REMOTESESSION) != 0 }
}

#[cfg(not(target_os = "windows"))]
pub fn is_remote_session() -> bool {
    false
}

/// Poll the OS remote-session state forever, emitting
/// [`crate::constants::EVENT_REMOTE_SESSION_CHANGED`] on every transition so the
/// UI can react to RDP connect/disconnect. The initial state is *not* emitted —
/// the frontend pulls it once on mount via `get_remote_session_active` to avoid
/// racing the webview's listener registration.
#[cfg(target_os = "windows")]
pub fn watch_remote_session(app: tauri::AppHandle) {
    use crate::constants::{EVENT_REMOTE_SESSION_CHANGED, REMOTE_SESSION_POLL};
    use tauri::Emitter;

    let mut last = is_remote_session();
    loop {
        std::thread::sleep(REMOTE_SESSION_POLL);
        let now = is_remote_session();
        if now != last {
            last = now;
            if let Err(err) = app.emit(EVENT_REMOTE_SESSION_CHANGED, now) {
                tracing::warn!(error = %err, "Failed to emit remote-session-changed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_is_never_remote() {
        assert!(!is_remote_session());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn query_does_not_panic() {
        // We can't force an RDP session in a unit test, but the query itself
        // must be callable and return a stable bool.
        let _ = is_remote_session();
    }
}
