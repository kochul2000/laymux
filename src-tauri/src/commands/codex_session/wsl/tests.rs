use super::*;
use std::sync::{Arc, Mutex};

type Calls = Arc<Mutex<Vec<(String, Vec<Pane>)>>>;

fn process(pid: u32, distro: &str) -> Option<WslAgentProcess> {
    Some(WslAgentProcess {
        pid,
        distro: distro.into(),
        home: "/home/test".into(),
        codex_home: None,
        grok_home: None,
        rollout_paths: vec![],
    })
}

/// Six Codex panes in Ubuntu, one in Debian, and a pane without Codex.
fn processes() -> HashMap<String, Option<WslAgentProcess>> {
    let mut processes: HashMap<_, _> = (1..=6)
        .map(|pid| (format!("pane-{pid}"), process(pid, "Ubuntu")))
        .collect();
    processes.insert("pane-7".into(), process(7, "Debian"));
    processes.insert("not-running".into(), None);
    processes
}

fn framed(rows: &[(u8, String)]) -> Vec<u8> {
    let mut output = format!("{BATCH_HEADER}\n");
    for (index, (status, json)) in rows.iter().enumerate() {
        output.push_str(&format!("C\t{index}\t{status}\t{json}\n"));
    }
    output.push_str(BATCH_END);
    output.push('\n');
    output.into_bytes()
}

fn rows_for(pid: u32) -> String {
    format!(r#"{{"process_uuid":"pid:{pid}:test","rows":[]}}"#)
}

/// A healthy guest: records each run and answers every pane.
fn guest(
    calls: &Calls,
) -> impl Fn(&str, &[Pane], Duration) -> Result<Vec<u8>, String> + Clone + Send + 'static {
    let calls = Arc::clone(calls);
    move |distro, panes, _| {
        calls
            .lock()
            .unwrap()
            .push((distro.to_string(), panes.to_vec()));
        Ok(framed(
            &panes
                .iter()
                .map(|(pid, _)| (0, rows_for(*pid)))
                .collect::<Vec<_>>(),
        ))
    }
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(3)
}

fn pane(pid: u32) -> Pane {
    (pid, format!("pane-{pid}"))
}

#[test]
fn one_guest_run_reads_a_batch_of_panes_per_distribution() {
    let state = AppState::new();
    let calls = Calls::default();
    let rows = read_rows_batch_with(
        &state,
        &processes(),
        GuestObservation::starting_now(),
        deadline(),
        guest(&calls),
    );
    let mut calls = calls.lock().unwrap().clone();
    calls.sort();
    assert_eq!(
        calls,
        vec![
            ("Debian".to_string(), vec![pane(7)]),
            (
                "Ubuntu".to_string(),
                vec![pane(1), pane(2), pane(3), pane(4)]
            ),
            ("Ubuntu".to_string(), vec![pane(5), pane(6)]),
        ]
    );
    assert_eq!(rows.len(), 7);
    assert!(!rows.contains_key("not-running"));
    for pid in 1..=7 {
        assert_eq!(
            rows[&format!("pane-{pid}")].as_ref().unwrap().process_uuid,
            format!("pid:{pid}:test")
        );
    }
}

#[test]
fn a_failing_pane_inside_a_batch_stays_with_that_pane() {
    let state = AppState::new();
    let processes: HashMap<_, _> = (1..=3)
        .map(|pid| (format!("pane-{pid}"), process(pid, "Ubuntu")))
        .collect();
    let rows = read_rows_batch_with(
        &state,
        &processes,
        GuestObservation::starting_now(),
        deadline(),
        |_: &str, _: &[Pane], _| {
            // Pane 2's reader failed; pane 3 answered for another process.
            Ok(framed(&[
                (0, rows_for(1)),
                (1, String::new()),
                (0, rows_for(99)),
            ]))
        },
    );
    assert!(rows["pane-1"].is_ok());
    assert_eq!(
        rows["pane-2"].as_ref().unwrap_err(),
        "WSL Codex probe exited with 1"
    );
    assert!(rows["pane-3"]
        .as_ref()
        .unwrap_err()
        .contains("identity mismatch"));
}

#[test]
fn a_failed_run_fails_only_its_own_panes() {
    let state = AppState::new();
    let calls = Calls::default();
    let healthy = guest(&calls);
    let rows = read_rows_batch_with(
        &state,
        &processes(),
        GuestObservation::starting_now(),
        deadline(),
        move |distro: &str, panes: &[Pane], timeout| {
            if distro == "Debian" {
                return Err("guest unavailable".into());
            }
            healthy(distro, panes, timeout)
        },
    );
    assert_eq!(rows["pane-7"].as_ref().unwrap_err(), "guest unavailable");
    for pid in 1..=6 {
        assert!(rows[&format!("pane-{pid}")].is_ok());
    }
}

#[test]
fn an_expired_deadline_starts_no_guest_run() {
    let state = AppState::new();
    let rows = read_rows_batch_with(
        &state,
        &processes(),
        GuestObservation::starting_now(),
        Instant::now(),
        |_: &str, _: &[Pane], _| -> Result<Vec<u8>, String> {
            panic!("an expired lookup must not start a guest run")
        },
    );
    assert_eq!(rows.len(), 7);
    assert!(rows.values().all(Result::is_err));
}

#[test]
fn display_polling_reuses_a_batch_and_a_boundary_reads_the_guest_again() {
    let state = AppState::new();
    let calls = Calls::default();
    let processes = processes();
    let read = |observation| {
        read_rows_batch_with(&state, &processes, observation, deadline(), guest(&calls))
    };
    read(GuestObservation::starting_now());
    read(GuestObservation::Reusable);
    assert_eq!(calls.lock().unwrap().len(), 3);
    read(GuestObservation::starting_now());
    assert_eq!(calls.lock().unwrap().len(), 6);
}

#[test]
fn broken_batch_framing_fails_every_pane_it_carried() {
    let one = framed(&[(0, rows_for(1))]);
    assert!(parse_batch_output(&one, 1).unwrap()[0].is_ok());
    let text = String::from_utf8(one).unwrap();
    for broken in [
        text.replace(BATCH_HEADER, "LAYMUX_WSL_CODEX_BATCH_V0"),
        text.replace(BATCH_END, ""),
        text.replace("C\t0\t", "C\t1\t"),
        text.replace("C\t0\t0", "C\t0\tx"),
        text.replace("C\t0", "R\t0"),
    ] {
        assert!(
            parse_batch_output(broken.as_bytes(), 1).is_err(),
            "{broken}"
        );
    }
    // Every pane the run carried must be answered, no more and no fewer.
    assert!(parse_batch_output(text.as_bytes(), 2).is_err());
    assert!(parse_batch_output(&framed(&[]), 1).is_err());
    assert!(parse_batch_output(b"\xff", 1).is_err());
}

/// The real guest shell: argv stays literal and each pane keeps its own exit
/// status.
#[cfg(target_os = "linux")]
#[test]
fn batch_script_frames_each_pane_and_keeps_argv_literal() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let helper = root.path().join("reader with space");
    std::fs::write(
        &helper,
        "#!/bin/sh\n[ \"$1\" = 2 ] && exit 3\nprintf '{\"process_uuid\":\"pid:%s:%s\",\"rows\":[]}' \"$1\" \"$2\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut command = crate::process::headless_command("sh");
    command.args(["-c", CODEX_BATCH_SCRIPT, BATCH_NAME]);
    command.arg(&helper);
    command.args(["1", "pane a", "2", "pane-b", "3", "pane$(touch pwned)"]);
    let output = crate::process::output_with_timeout(&mut command, Duration::from_secs(3)).unwrap();
    assert!(output.status.success());
    let rows = parse_batch_output(&output.stdout, 3).unwrap();
    assert_eq!(rows[0].as_ref().unwrap().process_uuid, "pid:1:pane a");
    assert_eq!(
        rows[1].as_ref().unwrap_err(),
        "WSL Codex probe exited with 3"
    );
    assert_eq!(
        rows[2].as_ref().unwrap().process_uuid,
        "pid:3:pane$(touch pwned)"
    );
    assert!(!std::path::Path::new("pwned").exists());
}
