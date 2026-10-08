//! Exercise the vendored Windows killer against a real owned child process.
#[test]
fn cloned_native_child_killer_reports_success_after_terminating_a_live_process() {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    let mut command = CommandBuilder::new("cmd.exe");
    command.args(["/Q", "/c", "ping -n 30 127.0.0.1 > nul"]);
    let mut child = pair.slave.spawn_command(command).unwrap();
    assert!(child.try_wait().unwrap().is_none());
    let result = child.clone_killer().kill();
    let exit = child.wait().unwrap();
    assert!(!exit.success(), "the owned child must really be terminated");
    assert!(
        result.is_ok(),
        "successful TerminateProcess must be acknowledged: {result:?}"
    );
}
