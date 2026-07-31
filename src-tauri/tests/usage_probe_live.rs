//! Live probe check — drives a real `claude` process and reads a real `/usage`
//! screen.
//!
//! `#[ignore]`d on purpose: it needs `claude` installed and logged in, it talks
//! to Anthropic's rate-limited usage endpoint, and it takes tens of seconds.
//! Run it by hand when the probe's drive sequence or the `/usage` parser changes:
//!
//! ```text
//! cargo test --test usage_probe_live -- --ignored --nocapture
//! ```
//!
//! Screen scraping a TUI is not a stable contract ([ADR-0099]), so this test is
//! the only thing that catches an upstream layout change before a user does.

use std::time::{Duration, Instant};

use laymux_lib::usage_probe::{ProbeStatus, UsageProbe, WorkerSpec};

/// Shell the probe should run `claude` in. Override with `LAYMUX_PROBE_SHELL`.
fn probe_command_line() -> String {
    std::env::var("LAYMUX_PROBE_SHELL").unwrap_or_else(|_| "wsl.exe".to_string())
}

/// Write the capture to `LAYMUX_PROBE_SCREEN_OUT` when set, so a run can be
/// analyzed without spending another rate-limited query to reproduce it.
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
#[ignore = "spawns a real claude process and consumes a rate-limited /usage query"]
fn probe_reads_real_usage() {
    let probe = UsageProbe::new();
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

    // Boot plus one `/usage` round trip. Generous: `claude` startup alone can
    // take 10+ seconds on a cold WSL distro.
    let deadline = Instant::now() + Duration::from_secs(180);
    let mut last = ProbeStatus::Idle;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(2));
        let snapshot = probe.snapshot("").expect("snapshot must be readable");
        if snapshot.status != last {
            eprintln!("status: {:?}", snapshot.status);
            last = snapshot.status.clone();
        }
        if snapshot.status == ProbeStatus::Ready {
            eprintln!(
                "session={:?} weekAll={:?} weekModel={:?} ({:?}) plan={:?} model={:?}",
                snapshot.session,
                snapshot.week_all,
                snapshot.week_model,
                snapshot.week_model_label,
                snapshot.plan,
                snapshot.model
            );
            // Print the capture on success too: this is how a changed row set
            // is told apart from a parse gap.
            eprintln!("--- captured screen ---");
            eprintln!("{}", snapshot.raw_screen.as_deref().unwrap_or("(none)"));
            eprintln!("--- end ---");
            dump_screen(snapshot.raw_screen.as_deref());
            assert!(
                snapshot.session.percent.is_some() || snapshot.week_all.percent.is_some(),
                "Ready must carry at least one percentage"
            );
            assert!(
                snapshot.captured_at_ms.is_some(),
                "Ready must be timestamped"
            );
            probe.shutdown_all().expect("shutdown must succeed");
            return;
        }
        // A terminal failure will not improve by waiting; print the captured
        // screen so an upstream TUI change is diagnosable, then fail.
        if matches!(
            snapshot.status,
            ProbeStatus::ClaudeMissing
                | ProbeStatus::StartupTimeout
                | ProbeStatus::ParseFailed
                | ProbeStatus::UpstreamError { .. }
                | ProbeStatus::Failed { .. }
        ) {
            eprintln!("--- captured screen ---");
            eprintln!("{}", snapshot.raw_screen.as_deref().unwrap_or("(none)"));
            eprintln!("--- end ---");
            probe.shutdown_all().expect("shutdown must succeed");
            panic!("probe failed: {:?}", snapshot.status);
        }
    }

    let snapshot = probe.snapshot("").expect("snapshot must be readable");
    eprintln!(
        "{}",
        snapshot.raw_screen.as_deref().unwrap_or("(no screen)")
    );
    probe.shutdown_all().expect("shutdown must succeed");
    panic!(
        "probe never reached Ready; last status {:?}",
        snapshot.status
    );
}
