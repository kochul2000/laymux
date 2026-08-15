//! Live Grok `/usage` probe — drives a real `grok` process.
//!
//! `#[ignore]`d: needs `grok` installed and logged in, and the `/usage`
//! TUI is not a stable contract ([ADR-0156]). Run by hand when the
//! drive sequence or parser changes:
//!
//! ```text
//! cargo test --test grok_usage_probe_live -- --ignored --nocapture
//! ```

use std::time::{Duration, Instant};

use laymux_lib::grok_usage_probe::{GrokProbeStatus, GrokUsageProbe, WorkerSpec};

fn probe_command_line() -> String {
    std::env::var("LAYMUX_PROBE_SHELL").unwrap_or_else(|_| "wsl.exe".to_string())
}

fn dump_screen(screen: Option<&str>) {
    let Ok(path) = std::env::var("LAYMUX_PROBE_SCREEN_OUT") else {
        return;
    };
    if let Some(screen) = screen {
        if let Err(error) = std::fs::write(&path, screen) {
            eprintln!("failed to write screen dump to {path}: {error}");
        } else {
            eprintln!("screen dump written to {path}");
        }
    }
}

#[test]
#[ignore = "spawns a real grok process and reads the /usage TUI"]
fn probe_reads_real_grok_usage() {
    let probe = GrokUsageProbe::new();
    let spec = WorkerSpec {
        config_dir: String::new(),
        profile: "WSL".into(),
        command_line: probe_command_line(),
        starting_directory: String::new(),
        refresh_seconds: 600,
    };

    probe
        .subscribe("live-test", spec)
        .expect("subscribe must succeed");

    let deadline = Instant::now() + Duration::from_secs(180);
    let mut last = GrokProbeStatus::Idle;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(2));
        let snapshot = probe.snapshot("").expect("snapshot must be readable");
        if snapshot.status != last {
            eprintln!("status: {:?}", snapshot.status);
            last = snapshot.status.clone();
        }
        if snapshot.status == GrokProbeStatus::Ready {
            eprintln!("rows={:?}", snapshot.rows);
            eprintln!("--- captured screen ---");
            eprintln!("{}", snapshot.raw_screen.as_deref().unwrap_or("(none)"));
            eprintln!("--- end ---");
            dump_screen(snapshot.raw_screen.as_deref());
            assert!(
                snapshot
                    .rows
                    .iter()
                    .any(|row| row.percent.is_some() || row.remaining.is_some()),
                "Ready must carry at least one numeric bucket"
            );
            assert!(
                snapshot.captured_at_ms.is_some(),
                "Ready must be timestamped"
            );
            probe.shutdown_all().expect("shutdown must succeed");
            return;
        }
        if matches!(
            snapshot.status,
            GrokProbeStatus::GrokMissing
                | GrokProbeStatus::StartupTimeout
                | GrokProbeStatus::ParseFailed
                | GrokProbeStatus::Failed { .. }
        ) {
            eprintln!("--- captured screen ---");
            eprintln!("{}", snapshot.raw_screen.as_deref().unwrap_or("(none)"));
            eprintln!("--- end ---");
            dump_screen(snapshot.raw_screen.as_deref());
            probe.shutdown_all().expect("shutdown must succeed");
            panic!("probe failed: {:?}", snapshot.status);
        }
    }

    let snapshot = probe.snapshot("").expect("snapshot must be readable");
    eprintln!(
        "{}",
        snapshot.raw_screen.as_deref().unwrap_or("(no screen)")
    );
    dump_screen(snapshot.raw_screen.as_deref());
    probe.shutdown_all().expect("shutdown must succeed");
    panic!(
        "probe never reached Ready; last status {:?}",
        snapshot.status
    );
}
