use std::collections::BTreeMap;
use std::sync::mpsc;

use super::tests::{collect_until, interactive_shell, size, TestDaemon};
use super::{list_sessions, DaemonPtySystem};
use crate::constants::PTY_DAEMON_METADATA_CODEX_STARTUP_COLORS;
use crate::pty::{
    spawn_command_on, ChildKillOwner, PtyLifecycleHooks, PtyOutputControl, SpawnOptions,
};
use crate::terminal::StartupColorReplies;

#[test]
fn daemon_consumes_startup_colors_without_leaking_them_to_adoption_metadata() {
    let daemon = TestDaemon::start();
    let colors = StartupColorReplies {
        foreground: "\x1b]10;rgb:ffff/ffff/ffff\x1b\\".into(),
        background: "\x1b]11;rgb:0000/0000/0000\x1b\\".into(),
    };
    let system = DaemonPtySystem::spawn(
        daemon.endpoint.clone(),
        "colors#1".into(),
        "colors".into(),
        BTreeMap::from([
            (
                PTY_DAEMON_METADATA_CODEX_STARTUP_COLORS.into(),
                serde_json::to_string(&colors).unwrap(),
            ),
            ("retained".into(), "yes".into()),
        ]),
    );
    let (command, input) = interactive_shell();
    let (tx, rx) = mpsc::channel();
    let handle = spawn_command_on(
        &system,
        size(),
        command,
        1,
        SpawnOptions {
            wsl_backed: false,
            kill_owner: ChildKillOwner::Backend,
            startup_colors: None,
        },
        move |data| {
            tx.send(data).unwrap();
            PtyOutputControl::Continue
        },
        PtyLifecycleHooks::default(),
    )
    .unwrap();
    handle.write(input).unwrap();
    collect_until(&rx, "MARK_42");
    let sessions = list_sessions(&daemon.endpoint).unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(
        sessions[0].metadata.get("retained").map(String::as_str),
        Some("yes")
    );
    assert!(!sessions[0]
        .metadata
        .contains_key(PTY_DAEMON_METADATA_CODEX_STARTUP_COLORS));
    handle.terminate().unwrap();
    daemon.wait_for_sessions(0);
}
