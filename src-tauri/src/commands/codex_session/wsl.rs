use super::lifecycle::ProcessRows;
use crate::commands::wsl_agent_session::WslAgentProcess;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

pub(super) fn read_rows_batch(
    processes: &HashMap<String, Option<WslAgentProcess>>,
    deadline: Instant,
) -> HashMap<String, Result<ProcessRows, String>> {
    read_rows_batch_with(processes, deadline, read_rows)
}

fn read_rows_batch_with(
    processes: &HashMap<String, Option<WslAgentProcess>>,
    deadline: Instant,
    read: impl Fn(&WslAgentProcess, &str, Duration) -> Result<ProcessRows, String> + Sync,
) -> HashMap<String, Result<ProcessRows, String>> {
    let processes: Vec<_> = processes
        .iter()
        .filter_map(|(id, process)| process.as_ref().map(|process| (id, process)))
        .collect();
    let next = AtomicUsize::new(0);
    // A completed slot immediately takes the next pane; a slow probe must not
    // hold the other slots idle until the shared deadline expires.
    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..processes
            .len()
            .min(crate::constants::WSL_CODEX_PROBE_CONCURRENCY))
            .map(|_| {
                scope.spawn(|| {
                    let mut results = Vec::new();
                    while let Some((id, process)) =
                        processes.get(next.fetch_add(1, Ordering::Relaxed))
                    {
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            crate::wsl_probe::remaining_timeout(deadline)
                                .ok_or_else(|| "Codex WSL deadline expired".to_owned())
                                .and_then(|timeout| read(process, id, timeout))
                        }))
                        .unwrap_or_else(|_| Err("WSL Codex diagnostic worker panicked".into()));
                        results.push(((*id).clone(), result));
                    }
                    results
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|worker| worker.join().unwrap_or_default())
            .collect()
    })
}

// The bundled static Linux executable owns SQLite locking inside the distro.
// Arguments never pass through a shell or an ambient PATH lookup.
#[cfg(windows)]
pub(super) fn read_rows(
    process: &WslAgentProcess,
    terminal_id: &str,
    timeout: std::time::Duration,
) -> Result<ProcessRows, String> {
    if !crate::wsl_probe::is_safe_distro_name(&process.distro) {
        return Err("unsafe WSL distribution name".into());
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let helper = executable
        .parent()
        .ok_or("application directory missing")?
        .join(crate::constants::WSL_CODEX_PROBE_FILE);
    if !helper.is_file() {
        return Err("bundled WSL Codex probe missing".into());
    }
    let helper =
        crate::path_utils::windows_to_wsl_path(helper.to_str().ok_or("invalid WSL probe path")?);
    let mut command = crate::process::headless_command("wsl.exe");
    command.args([
        "-d",
        &process.distro,
        "--exec",
        &helper,
        &process.pid.to_string(),
        terminal_id,
    ]);
    let output =
        crate::process::output_with_timeout(&mut command, timeout).map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("WSL Codex probe exited with {}", output.status));
    }
    let rows: ProcessRows = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("invalid WSL Codex diagnostics: {e}"))?;
    if !rows
        .process_uuid
        .starts_with(&format!("pid:{}:", process.pid))
    {
        return Err("WSL Codex diagnostic process identity mismatch".into());
    }
    Ok(rows)
}

#[cfg(not(windows))]
pub(super) fn read_rows(
    _: &WslAgentProcess,
    _: &str,
    _: std::time::Duration,
) -> Result<ProcessRows, String> {
    Err("WSL is unavailable on this host".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slow_probe_does_not_hold_completed_slots_idle() {
        let processes: HashMap<_, _> = (0..8)
            .map(|pid| {
                (
                    format!("pane-{pid}"),
                    Some(WslAgentProcess {
                        pid,
                        distro: "Ubuntu".into(),
                        home: "/home/test".into(),
                        codex_home: None,
                        grok_home: None,
                        rollout_paths: vec![],
                    }),
                )
            })
            .collect();
        // Select the first actual iteration entry so every run blocks the first
        // slot regardless of HashMap randomization. It needs the later jobs to run.
        let slow = processes.values().next().unwrap().as_ref().unwrap().pid;
        let completed = std::sync::Mutex::new(0);
        let ready = std::sync::Condvar::new();
        let deadline = Instant::now() + Duration::from_secs(2);
        let rows = read_rows_batch_with(&processes, deadline, |process, _, timeout| {
            if process.pid == slow {
                let _guard = ready
                    .wait_timeout_while(completed.lock().unwrap(), timeout, |count| *count < 7)
                    .unwrap();
                Err("slow pane".into())
            } else {
                *completed.lock().unwrap() += 1;
                ready.notify_all();
                Ok(ProcessRows {
                    process_uuid: format!("pid:{}:test", process.pid),
                    rows: vec![],
                })
            }
        });
        assert_eq!(rows.len(), 8);
        assert_eq!(
            *completed.lock().unwrap(),
            7,
            "free slots did not start queued panes"
        );
        for (id, result) in rows {
            assert_eq!(result.is_err(), id == format!("pane-{slow}"), "{id}");
        }
    }

    #[test]
    fn pane_probes_overlap_with_a_bound_and_keep_failures_scoped() {
        let mut processes: HashMap<_, _> = (0..16)
            .map(|pid| {
                (
                    format!("pane-{pid}"),
                    Some(WslAgentProcess {
                        pid,
                        distro: "Ubuntu".into(),
                        home: "/home/test".into(),
                        codex_home: None,
                        grok_home: None,
                        rollout_paths: vec![],
                    }),
                )
            })
            .collect();
        processes.insert("not-running".into(), None);
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let deadline = Instant::now() + Duration::from_secs(5);
        let rows = read_rows_batch_with(&processes, deadline, |process, id, timeout| {
            assert_eq!(id, format!("pane-{}", process.pid));
            assert!(timeout <= Duration::from_secs(5));
            let count = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(count, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(50));
            active.fetch_sub(1, Ordering::SeqCst);
            if process.pid == 9 {
                panic!("isolated diagnostic reader panic");
            }
            if process.pid == 7 {
                Err("isolated database failure".into())
            } else {
                Ok(ProcessRows {
                    process_uuid: format!("pid:{}:test", process.pid),
                    rows: vec![],
                })
            }
        });
        assert_eq!(rows.len(), 16);
        assert!(
            peak.load(Ordering::SeqCst) > 1,
            "serial probes exhausted the shared WSL deadline in dev"
        );
        assert!(peak.load(Ordering::SeqCst) <= 4);
        for (id, result) in &rows {
            assert_eq!(result.is_err(), id == "pane-7" || id == "pane-9");
        }
        let expired = read_rows_batch_with(&processes, Instant::now(), |_, _, _| {
            panic!("expired probe must not start")
        });
        assert_eq!(expired.len(), 16);
        assert!(expired.values().all(Result::is_err));
    }
}
