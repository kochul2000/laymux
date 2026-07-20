//! OS-level remote-desktop session detection.
//!
//! The intended scenario: laymux is already running on the desktop, and the
//! user opens Windows Remote Desktop from their phone to reach that window.
//! When the window is entered over a remote session we want the Remote Access
//! panel open so the phone can quickly switch to the mobile web UI.
//!
//! The window-width heuristic in `useAutoRemoteAccessPrompt` is an unreliable
//! proxy for this — phone RDP clients usually negotiate a resolution wider than
//! the threshold, and a non-maximized window never fires a `resize` on connect.
//! This module reads the real Terminal Services state instead and pushes a
//! transition event to the UI.

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
