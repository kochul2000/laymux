//! Provider lookups share one guest scan per distribution (ADR-0335).

use super::*;
use crate::pty::PtyHandle;
use std::sync::{Arc, Barrier, Condvar, Mutex};

const PANES: [&str; 3] = ["terminal-claude", "terminal-codex", "terminal-grok"];

/// Ubuntu hosts a Claude pane and a Codex pane; Debian hosts a Grok pane.
fn guest_output(distro: &str) -> Vec<u8> {
    let output = if distro == "Ubuntu" {
        concat!(
            "LAYMUX_WSL_AGENT_PROBE_V3\n",
            "P\tterminal-claude\t10\t1\tbash\t/home/u\t\t\t0\n",
            "P\tterminal-claude\t11\t10\tclaude\t/home/u\t\t\t0\n",
            "P\tterminal-codex\t20\t1\tbash\t/home/u\t\t\t0\n",
            "P\tterminal-codex\t21\t20\tcodex\t/home/u\t\t\t0\n",
            "LAYMUX_WSL_AGENT_PROBE_END\n",
        )
    } else {
        concat!(
            "LAYMUX_WSL_AGENT_PROBE_V3\n",
            "P\tterminal-grok\t30\t1\tbash\t/home/u\t\t\t0\n",
            "P\tterminal-grok\t31\t30\tgrok\t/home/u\t\t\t0\n",
            "LAYMUX_WSL_AGENT_PROBE_END\n",
        )
    };
    output.as_bytes().to_vec()
}

/// A fake guest that counts its scans per distribution.
#[derive(Clone, Default)]
struct Guest {
    scans: Arc<Mutex<HashMap<String, usize>>>,
    delay: Duration,
    failing: Option<&'static str>,
}

impl Guest {
    fn scanner(
        &self,
    ) -> impl Fn(&str, Duration) -> Result<Vec<u8>, String> + Clone + Send + 'static {
        let guest = self.clone();
        move |distro, _| {
            *guest
                .scans
                .lock()
                .unwrap()
                .entry(distro.to_string())
                .or_default() += 1;
            std::thread::sleep(guest.delay);
            if guest.failing == Some(distro) {
                return Err("guest unavailable".into());
            }
            Ok(guest_output(distro))
        }
    }

    fn scans(&self, distro: &str) -> usize {
        self.scans.lock().unwrap().get(distro).copied().unwrap_or(0)
    }
}

fn wsl_handle(generation: u64) -> PtyHandle {
    PtyHandle::from_test_writer_for_generation(Box::new(std::io::sink()), generation)
        .with_wsl_backed(true)
}

fn state_with_panes() -> AppState {
    let state = AppState::new();
    state.pty_handles.lock().unwrap().extend(
        PANES
            .iter()
            .map(|terminal_id| ((*terminal_id).to_string(), wsl_handle(1))),
    );
    state
}

fn targets() -> WslTerminalTargets {
    WslTerminalTargets {
        targets: vec![
            ("terminal-claude".into(), Some("Ubuntu".into())),
            ("terminal-codex".into(), Some("Ubuntu".into())),
            ("terminal-grok".into(), Some("Debian".into())),
        ],
        lookup_failed: false,
    }
}

fn resolve(
    state: &AppState,
    guest: &Guest,
    provider: WslAgentProvider,
    observation: GuestObservation,
) -> WslAgentProcessLookup {
    resolve_targets(
        state,
        targets(),
        provider,
        observation,
        Instant::now() + Duration::from_secs(3),
        guest.scanner(),
    )
    .unwrap()
}

fn pid(lookup: &WslAgentProcessLookup, terminal_id: &str) -> Option<u32> {
    lookup
        .attributions
        .get(terminal_id)?
        .as_ref()
        .map(|process| process.pid)
}

/// `get_terminal_session_attributions` runs the three providers in parallel
/// behind one command boundary. They must read one scan per distribution, not
/// one each.
#[test]
fn three_providers_behind_one_boundary_share_one_scan_per_distribution() {
    let state = state_with_panes();
    let guest = Guest {
        delay: Duration::from_millis(100),
        ..Guest::default()
    };
    let boundary = GuestObservation::starting_now();
    let start = Barrier::new(3);
    let (claude, codex, grok) = std::thread::scope(|scope| {
        let run = |provider| {
            let (state, guest, start) = (&state, &guest, &start);
            scope.spawn(move || {
                start.wait();
                resolve(state, guest, provider, boundary)
            })
        };
        let claude = run(WslAgentProvider::Claude);
        let codex = run(WslAgentProvider::Codex);
        let grok = run(WslAgentProvider::Grok);
        (
            claude.join().unwrap(),
            codex.join().unwrap(),
            grok.join().unwrap(),
        )
    });
    assert_eq!(guest.scans("Ubuntu"), 1);
    assert_eq!(guest.scans("Debian"), 1);
    // Provider selection still happens per reader on the shared rows.
    assert_eq!(pid(&claude, "terminal-claude"), Some(11));
    assert!(!claude.attributions.contains_key("terminal-codex"));
    assert_eq!(pid(&codex, "terminal-codex"), Some(21));
    assert!(!codex.attributions.contains_key("terminal-claude"));
    assert_eq!(pid(&grok, "terminal-grok"), Some(31));
    assert_eq!(
        grok.attributions["terminal-grok"].as_ref().unwrap().distro,
        "Debian"
    );
    for lookup in [&claude, &codex, &grok] {
        assert!(lookup.failed_terminal_ids.is_empty());
    }
}

#[test]
fn display_polling_reuses_a_scan_and_a_later_boundary_reads_the_guest_again() {
    let state = state_with_panes();
    let guest = Guest::default();
    let first = resolve(
        &state,
        &guest,
        WslAgentProvider::Codex,
        GuestObservation::starting_now(),
    );
    let polled = resolve(
        &state,
        &guest,
        WslAgentProvider::Claude,
        GuestObservation::Reusable,
    );
    assert_eq!(pid(&first, "terminal-codex"), Some(21));
    assert_eq!(pid(&polled, "terminal-claude"), Some(11));
    assert_eq!(guest.scans("Ubuntu"), 1);
    // Persistence asks after the earlier scan: it must not be answered by it.
    resolve(
        &state,
        &guest,
        WslAgentProvider::Codex,
        GuestObservation::starting_now(),
    );
    assert_eq!(guest.scans("Ubuntu"), 2);
}

/// A guest process names its pane, never its PTY generation. A scan from
/// before a respawn or close must not describe the catalog after it.
#[test]
fn a_pane_lifecycle_change_never_reads_a_scan_from_before_it() {
    let state = state_with_panes();
    let guest = Guest::default();
    resolve(
        &state,
        &guest,
        WslAgentProvider::Codex,
        GuestObservation::Reusable,
    );
    // Restart View: same terminal id, new PTY generation.
    state
        .pty_handles
        .lock()
        .unwrap()
        .insert("terminal-codex".into(), wsl_handle(2));
    resolve(
        &state,
        &guest,
        WslAgentProvider::Codex,
        GuestObservation::Reusable,
    );
    assert_eq!(guest.scans("Ubuntu"), 2);
    state.pty_handles.lock().unwrap().remove("terminal-grok");
    resolve(
        &state,
        &guest,
        WslAgentProvider::Codex,
        GuestObservation::Reusable,
    );
    assert_eq!(guest.scans("Ubuntu"), 3);
}

#[test]
fn a_failed_distribution_fails_closed_only_for_its_own_panes() {
    let state = state_with_panes();
    let guest = Guest {
        failing: Some("Debian"),
        ..Guest::default()
    };
    let grok = resolve(
        &state,
        &guest,
        WslAgentProvider::Grok,
        GuestObservation::starting_now(),
    );
    assert_eq!(grok.attributions.get("terminal-grok"), Some(&None));
    assert!(grok.failed_terminal_ids.contains("terminal-grok"));
    assert!(!grok.failed_terminal_ids.contains("terminal-claude"));
    // Polling inside the window shares the failure instead of asking the
    // broken guest again, and the healthy distribution still answers.
    let claude = resolve(
        &state,
        &guest,
        WslAgentProvider::Claude,
        GuestObservation::Reusable,
    );
    assert!(claude.failed_terminal_ids.contains("terminal-grok"));
    assert_eq!(pid(&claude, "terminal-claude"), Some(11));
    assert_eq!(guest.scans("Debian"), 1);
}

#[test]
fn every_waiter_keeps_the_single_resolution_deadline() {
    let state = state_with_panes();
    let guest = Guest {
        delay: Duration::from_millis(700),
        ..Guest::default()
    };
    let started = Instant::now();
    let lookup = resolve_targets(
        &state,
        targets(),
        WslAgentProvider::Codex,
        GuestObservation::starting_now(),
        started + Duration::from_millis(100),
        guest.scanner(),
    )
    .unwrap();
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "a waiter outlived its deadline: {:?}",
        started.elapsed()
    );
    for terminal_id in PANES {
        assert!(lookup.failed_terminal_ids.contains(terminal_id));
        assert_eq!(lookup.attributions.get(terminal_id), Some(&None));
    }
}

/// Distributions no longer queue behind each other inside the one deadline.
#[test]
fn distributions_are_scanned_concurrently() {
    let state = state_with_panes();
    let started = Arc::new((Mutex::new(0usize), Condvar::new()));
    let scan = {
        let started = Arc::clone(&started);
        move |distro: &str, _| {
            let (count, both) = &*started;
            let mut count = count.lock().unwrap();
            *count += 1;
            both.notify_all();
            let (count, _) = both
                .wait_timeout_while(count, Duration::from_secs(1), |count| *count < 2)
                .unwrap();
            if *count < 2 {
                return Err("distributions were scanned one after another".into());
            }
            Ok(guest_output(distro))
        }
    };
    let lookup = resolve_targets(
        &state,
        targets(),
        WslAgentProvider::Grok,
        GuestObservation::starting_now(),
        Instant::now() + Duration::from_secs(3),
        scan,
    )
    .unwrap();
    assert!(lookup.failed_terminal_ids.is_empty(), "{lookup:?}");
    assert_eq!(pid(&lookup, "terminal-grok"), Some(31));
}
