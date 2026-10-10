//! The daemon's grace without a GUI, and the GUI presence that holds it off
//! (ADR-0312).

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use super::control::connect_authenticated;
use super::tests::{raw_spawn, sleeper, TestDaemon, TIMEOUT};
use super::wire::{write_control, ClientMessage};

const SHORT_GRACE: Duration = Duration::from_millis(400);

fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + TIMEOUT;
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn sessions_end_once_no_gui_has_been_connected_for_the_grace() {
    let daemon = TestDaemon::start();
    daemon.server.set_grace_unclamped(SHORT_GRACE);
    let (writer, reader) = raw_spawn(&daemon.endpoint, "pane-x#1", sleeper());
    daemon.wait_for_sessions(1);
    // The GUI disappears and nothing connects again.
    drop(writer);
    drop(reader);
    daemon.wait_for_sessions(0);
    wait_until("the daemon to stop", || {
        daemon.server.shutdown.load(Ordering::Acquire)
    });
}

#[test]
fn a_gui_presence_keeps_sessions_no_terminal_of_it_is_attached_to() {
    let daemon = TestDaemon::start();
    let (writer, reader) = raw_spawn(&daemon.endpoint, "pane-y#1", sleeper());
    daemon.wait_for_sessions(1);
    let (mut presence, presence_reader) = connect_authenticated(&daemon.endpoint).unwrap();
    write_control(
        &mut presence,
        &ClientMessage::Presence {
            grace_ms: 10 * 60 * 1000,
        },
    )
    .unwrap();
    wait_until("the presence to register", || {
        daemon.server.presence_count() == 1
    });
    daemon.server.set_grace_unclamped(SHORT_GRACE);
    // The terminal connection goes, as for a workspace not opened yet.
    drop(writer);
    drop(reader);
    std::thread::sleep(SHORT_GRACE * 4);
    assert_eq!(daemon.server.session_count(), 1);

    // The GUI goes too: the grace starts.
    drop(presence);
    drop(presence_reader);
    daemon.wait_for_sessions(0);
}

#[test]
fn a_presence_does_not_keep_an_empty_daemon_running() {
    let daemon = TestDaemon::start();
    let (mut presence, _presence_reader) = connect_authenticated(&daemon.endpoint).unwrap();
    write_control(
        &mut presence,
        &ClientMessage::Presence {
            grace_ms: 10 * 60 * 1000,
        },
    )
    .unwrap();
    wait_until("the presence to register", || {
        daemon.server.presence_count() == 1
    });
    assert!(daemon.server.is_idle());
}

#[test]
fn a_reported_grace_is_kept_within_the_setting_range() {
    let daemon = TestDaemon::start();
    let minute = Duration::from_secs(60);
    daemon.server.set_grace(Duration::ZERO);
    assert_eq!(daemon.server.grace(), minute);
    daemon.server.set_grace(minute * 100_000);
    assert_eq!(daemon.server.grace(), minute * 24 * 60);
    daemon.server.set_grace(minute * 7);
    assert_eq!(daemon.server.grace(), minute * 7);
}

#[test]
fn a_gui_holds_one_presence_per_daemon_until_the_daemon_goes() {
    let daemon = TestDaemon::start();
    super::presence::keep(&daemon.endpoint);
    super::presence::keep(&daemon.endpoint);
    wait_until("the presence to register", || {
        daemon.server.presence_count() == 1
    });
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(daemon.server.presence_count(), 1);
}
