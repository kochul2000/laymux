use super::*;
use crate::process_tree::{interactive_app_in_pty_fresh, PtyAppLiveness};
use std::process::{Child, Stdio};

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn grok_process_beats_claude_migration_promotion_in_its_own_screen() {
    let dir = tempfile::tempdir().unwrap();
    #[cfg(windows)]
    let (source, name, args) = (
        std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/cmd.exe"),
        "grok.exe",
        vec!["/D", "/Q", "/C", "pause"],
    );
    #[cfg(not(windows))]
    let (source, name, args) = (std::path::PathBuf::from("/bin/sleep"), "grok", vec!["30"]);
    let executable = dir.path().join(name);
    std::fs::copy(source, &executable).unwrap();
    let child = ChildGuard(
        crate::process::headless_command(&executable)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let state = AppState::new();
    state.pty_handles.lock_or_err().unwrap().insert(
        "grok-promotion".into(),
        crate::pty::PtyHandle::from_test_writer(Box::new(std::io::sink()))
            .with_child_pid(Some(child.0.id())),
    );
    assert_eq!(
        interactive_app_in_pty_fresh(&state, "grok-promotion"),
        PtyAppLiveness::Running("Grok")
    );
    let mut buffer = TerminalOutputBuffer::default();
    buffer.push(b"Grok Build 1.0.70\r\nComing from Claude Code? Resume your session using ctrl+u\r\n\x1b]0;grok\x07");
    assert_eq!(
        detect_terminal_state(&state, "grok-promotion", Some(&buffer)).activity,
        TerminalActivity::InteractiveApp {
            name: "Grok".into()
        }
    );
}
