; NSIS installer hooks (tauri `bundle.windows.nsis.installerHooks`).

; The PTY daemon runs as a staged copy named laymux-pty-daemon.exe, which the
; uninstaller's check for a running laymux.exe does not see (ADR-0308). An
; update runs the previous uninstaller with /UPDATE and keeps the daemon, so
; the updated GUI adopts its sessions; a real uninstall ends it with its
; terminals.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    nsis_tauri_utils::KillProcessCurrentUser "laymux-pty-daemon.exe"
    Pop $R0
  ${EndIf}
!macroend
