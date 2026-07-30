use super::*;

use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

struct Fixture {
    states: SharedTerminalProtocolStates,
    buffers: Arc<Mutex<HashMap<String, TerminalOutputBuffer>>>,
    session: Arc<TerminalOutputSession>,
}

fn registered_session(terminal_id: &str) -> Fixture {
    let states = SharedTerminalProtocolStates::default();
    let buffers = Arc::new(Mutex::new(HashMap::new()));
    let registration = register_terminal_output_session(&states, &buffers, terminal_id).unwrap();
    let session = registration.commit().unwrap();
    Fixture {
        states,
        buffers,
        session,
    }
}

fn assert_replaced_generation_rejects_computed_outcome(terminal_id: &str, fail_stopped: bool) {
    let fixture = registered_session(terminal_id);
    fixture
        .session
        .start_desktop_output_delivery(Arc::new(|_, _| Ok(())))
        .unwrap();
    fixture.session.begin_desktop_output_bootstrap(32).unwrap();
    if fail_stopped {
        fixture
            .session
            .desktop_delivery
            .close(TerminalOutputDeliveryCloseReason::SurfaceUnavailable);
    }

    let states = fixture.states.clone();
    let attached_terminal_id = terminal_id.to_string();
    let (computed_tx, computed_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let attach = thread::spawn(move || {
        attach_desktop_terminal_output_outcome_with_hook(
            &states,
            &attached_terminal_id,
            32,
            32,
            || {
                computed_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            },
        )
    });
    computed_rx.recv_timeout(Duration::from_secs(1)).unwrap();

    let old_generation = fixture.session.generation();
    assert!(retire_terminal_output_session(
        &fixture.states,
        &fixture.buffers,
        terminal_id,
        &fixture.session,
    )
    .unwrap());
    let replacement =
        register_terminal_output_session(&fixture.states, &fixture.buffers, terminal_id)
            .unwrap()
            .commit()
            .unwrap();
    assert_ne!(replacement.generation(), old_generation);

    release_tx.send(()).unwrap();
    let error = attach.join().unwrap().unwrap_err();
    assert!(error.contains("generation changed during desktop attach"));
    assert!(Arc::ptr_eq(
        &terminal_output_session_for(&fixture.states, terminal_id)
            .unwrap()
            .unwrap(),
        &replacement,
    ));
    assert!(retire_terminal_output_session(
        &fixture.states,
        &fixture.buffers,
        terminal_id,
        &replacement,
    )
    .unwrap());
}

#[test]
fn pre_attach_fail_stop_notice_has_an_explicit_null_lease_token() {
    let session = registered_session("bootstrap-fail-stop").session;
    let (notice_tx, notice_rx) = mpsc::channel();
    session
        .start_desktop_output_delivery_with_notifier(
            Arc::new(|_, _| Ok(())),
            Arc::new(move |notice| notice_tx.send(notice.clone()).unwrap()),
        )
        .unwrap();
    session.begin_desktop_output_bootstrap(32).unwrap();

    session
        .desktop_delivery
        .close(TerminalOutputDeliveryCloseReason::SurfaceUnavailable);
    let notice = notice_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(notice.lease_token, None);
    assert_eq!(
        serde_json::to_value(notice).unwrap()["leaseToken"],
        serde_json::Value::Null
    );
}

#[test]
fn current_fail_stopped_generation_resolves_as_a_typed_attach_outcome() {
    let fixture = registered_session("attach-fail-stop");
    let states = fixture.states;
    let session = fixture.session;
    session
        .start_desktop_output_delivery(Arc::new(|_, _| Ok(())))
        .unwrap();
    session.begin_desktop_output_bootstrap(32).unwrap();
    let first =
        attach_desktop_terminal_output_outcome(&states, "attach-fail-stop", 32, 32).unwrap();
    let DesktopTerminalOutputAttachOutcome::Attached(first) = first else {
        panic!("first attach must succeed");
    };
    assert!(session
        .fail_stop_desktop_surface(
            session.generation(),
            &first.flow_control.token,
            "control_orphan_cap",
        )
        .unwrap());

    assert_eq!(
        attach_desktop_terminal_output_outcome(&states, "attach-fail-stop", 32, 32).unwrap(),
        DesktopTerminalOutputAttachOutcome::FailStopped {
            terminal_id: "attach-fail-stop".into(),
            generation: session.generation(),
            reason: "control_orphan_cap".into(),
        }
    );
}

#[test]
fn active_continuation_attach_competition_remains_an_error() {
    let fixture = registered_session("attach-active-grant");
    let states = fixture.states;
    let session = fixture.session;
    let (envelope_tx, envelope_rx) = mpsc::channel();
    session
        .start_desktop_output_delivery(Arc::new(move |_, envelope| {
            envelope_tx.send(envelope.clone()).unwrap();
            Ok(())
        }))
        .unwrap();
    session.begin_desktop_output_bootstrap(32).unwrap();
    let first =
        attach_desktop_terminal_output_outcome(&states, "attach-active-grant", 32, 32).unwrap();
    assert!(matches!(
        first,
        DesktopTerminalOutputAttachOutcome::Attached(_)
    ));
    session.record_desktop_output(b"frame").unwrap();
    let opener = envelope_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(session
        .hold_desktop_continuation(
            opener.generation,
            &opener.lease_token,
            opener.envelope_id,
            "grant-active",
            opener.seq_start + 1,
        )
        .unwrap());

    let error =
        attach_desktop_terminal_output_outcome(&states, "attach-active-grant", 32, 32).unwrap_err();
    assert!(error.contains("continuation grant is active"));
    assert_eq!(session.delivery_failure(), None);
}

#[test]
fn computed_attachment_is_rejected_after_same_id_generation_replacement() {
    assert_replaced_generation_rejects_computed_outcome("attach-aba-success", false);
}

#[test]
fn computed_fail_stop_is_rejected_after_same_id_generation_replacement() {
    assert_replaced_generation_rejects_computed_outcome("attach-aba-fail-stop", true);
}

#[test]
fn delivery_close_reason_is_attach_authority_before_the_session_hook_finishes() {
    let fixture = registered_session("attach-close-hook-lag");
    let weak_session = Arc::downgrade(&fixture.session);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Arc::new(Mutex::new(release_rx));
    fixture
        .session
        .desktop_delivery
        .start(
            Arc::new(|_, _| Ok(())),
            Arc::new(move |reason| {
                entered_tx.send(reason.clone()).unwrap();
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(1))
                    .unwrap();
                if let Some(session) = weak_session.upgrade() {
                    let _ = session.on_delivery_closed(reason);
                }
            }),
        )
        .unwrap();
    fixture.session.begin_desktop_output_bootstrap(32).unwrap();

    let closing_session = Arc::clone(&fixture.session);
    let close = thread::spawn(move || {
        closing_session
            .desktop_delivery
            .close(TerminalOutputDeliveryCloseReason::SurfaceUnavailable);
    });
    assert_eq!(
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        TerminalOutputDeliveryCloseReason::SurfaceUnavailable
    );
    assert_eq!(fixture.session.delivery_failure(), None);
    let diagnostics = fixture.session.desktop_output_diagnostics().unwrap();
    assert_eq!(diagnostics.desktop_output_state, "failStopped");
    assert_eq!(diagnostics.reason.as_deref(), Some("surface_unavailable"));

    let outcome =
        attach_desktop_terminal_output_outcome(&fixture.states, "attach-close-hook-lag", 32, 32);
    release_tx.send(()).unwrap();
    close.join().unwrap();

    assert_eq!(
        outcome.unwrap(),
        DesktopTerminalOutputAttachOutcome::FailStopped {
            terminal_id: "attach-close-hook-lag".into(),
            generation: fixture.session.generation(),
            reason: "surface_unavailable".into(),
        }
    );
    assert_eq!(
        fixture.session.delivery_failure(),
        Some(TerminalOutputDeliveryCloseReason::SurfaceUnavailable)
    );
}
