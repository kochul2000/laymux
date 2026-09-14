//! Deterministic WSL/PTY recovery check; never reads real agent credentials.

#![cfg(target_os = "windows")]

use std::time::{Duration, Instant};

use laymux_lib::usage_probe::{ProbeStatus, UsageProbe, WorkerSpec};

#[test]
#[ignore = "requires WSL and starts a real probe PTY"]
fn wsl_login_is_picked_up_after_a_failed_query_without_resubscribing() {
    let dir = fixture();
    let script = dir.path().join("probe.sh");
    check_claude_recovery(&dir, &script);
}

fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("probe.sh");
    std::fs::write(
        &script,
        r#"#!/bin/bash
cd "$(dirname "$0")"
# Like a CLI, read credentials once at process startup.
authenticated=0
[[ -f logged-in ]] && authenticated=1
printf 'started\n' >> starts
stty -echo -icanon
input=''
while IFS= read -r -n 1 key; do
    if [[ -z "$key" || "$key" == $'\r' ]]; then
        if [[ "$input" == *grok* ]]; then
            printf '\033[2J\033[HGrok Build\r\n'
        elif [[ "$input" == *claude* ]]; then
            printf '\033[2J\033[HClaude Code v-test\r\n'
        elif [[ "$input" == */usage* ]]; then
            if [[ "$authenticated" == 1 ]]; then
                printf '\033[2J\033[HCurrent session\r\n30%% used\r\nWeekly limit\r\n30%% used\r\n'
            else
                printf '\033[2J\033[HError: Authentication required\r\n'
            fi
        fi
        input=''
    else
        input+="$key"
    fi
done
"#,
    )
    .unwrap();
    dir
}

fn check_claude_recovery(dir: &tempfile::TempDir, script: &std::path::Path) {
    let script_path = laymux_lib::path_utils::windows_to_wsl_path(&script.to_string_lossy());
    let probe = UsageProbe::new();
    probe
        .subscribe(
            "recovery-test",
            WorkerSpec {
                config_dir: String::new(),
                profile: "WSL".into(),
                command_line: format!("wsl.exe --exec bash {script_path}"),
                starting_directory: String::new(),
                refresh_seconds: 600,
            },
        )
        .unwrap();

    let result = (|| {
        wait_for(&probe, |status| {
            matches!(status, ProbeStatus::UpstreamError { .. })
        })?;
        std::fs::write(dir.path().join("logged-in"), "test account").unwrap();
        assert!(probe.snapshot("").unwrap().next_query_at_ms.is_some());
        wait_for(&probe, |status| *status == ProbeStatus::Ready)?;
        let snapshot = probe.snapshot("").unwrap();
        assert_eq!(snapshot.session.percent, Some(30));
        assert!(snapshot.captured_at_ms.is_some());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("starts"))
                .unwrap()
                .lines()
                .count(),
            2
        );
        Ok::<_, String>(())
    })();
    probe.shutdown_all().unwrap();
    result.unwrap();
}

#[test]
#[ignore = "requires WSL and starts a real Grok probe PTY"]
fn grok_wsl_login_recovers_automatically_without_resubscribing() {
    use laymux_lib::grok_usage_probe::{GrokProbeStatus, GrokUsageProbe, WorkerSpec};
    let dir = fixture();
    let script_path =
        laymux_lib::path_utils::windows_to_wsl_path(&dir.path().join("probe.sh").to_string_lossy());
    let probe = GrokUsageProbe::new();
    probe
        .subscribe(
            "recovery-test",
            WorkerSpec {
                config_dir: String::new(),
                profile: "WSL".into(),
                command_line: format!("wsl.exe --exec bash {script_path}"),
                starting_directory: String::new(),
                refresh_seconds: 600,
            },
        )
        .unwrap();
    let wait = |expected| {
        let deadline = Instant::now() + Duration::from_secs(100);
        loop {
            let snapshot = probe.snapshot("").unwrap();
            if snapshot.status == expected {
                return Ok(snapshot);
            }
            if Instant::now() >= deadline {
                return Err(format!("unexpected Grok state: {snapshot:?}"));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    let result = (|| {
        let failed = wait(GrokProbeStatus::ParseFailed)?;
        assert!(failed.next_query_at_ms.is_some());
        std::fs::write(dir.path().join("logged-in"), "test account").unwrap();
        let ready = wait(GrokProbeStatus::Ready)?;
        assert_eq!(ready.rows[0].percent, Some(30.0));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("starts"))
                .unwrap()
                .lines()
                .count(),
            2
        );
        Ok::<_, String>(())
    })();
    probe.shutdown_all().unwrap();
    result.unwrap();
}

fn wait_for(probe: &UsageProbe, expected: impl Fn(&ProbeStatus) -> bool) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let snapshot = probe.snapshot("").unwrap();
        if expected(&snapshot.status) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("unexpected probe state: {snapshot:?}"));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
