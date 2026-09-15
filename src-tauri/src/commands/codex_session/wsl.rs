use super::lifecycle::LogRow;
use crate::commands::wsl_agent_session::WslAgentProcess;
use std::collections::HashMap;
use std::time::{Duration, Instant};

pub(super) fn read_rows_batch(
    processes: &HashMap<String, Option<WslAgentProcess>>,
    deadline: Instant,
) -> HashMap<String, Result<Vec<LogRow>, String>> {
    read_rows_batch_with(processes, deadline, read_rows)
}

fn read_rows_batch_with(
    processes: &HashMap<String, Option<WslAgentProcess>>,
    deadline: Instant,
    read: impl Fn(&WslAgentProcess, &str, Duration) -> Result<Vec<LogRow>, String> + Sync,
) -> HashMap<String, Result<Vec<LogRow>, String>> {
    let processes: Vec<_> = processes
        .iter()
        .filter_map(|(id, process)| process.as_ref().map(|process| (id, process)))
        .collect();
    let mut results = HashMap::new();
    // WSL startup per pane otherwise consumes the shared deadline before the
    // last pane is read. Bound both concurrent launches and their total budget.
    for batch in processes.chunks(crate::constants::WSL_CODEX_PROBE_CONCURRENCY) {
        std::thread::scope(|scope| {
            let workers: Vec<_> = batch
                .iter()
                .map(|(id, process)| {
                    (
                        *id,
                        scope.spawn(|| {
                            crate::wsl_probe::remaining_timeout(deadline)
                                .ok_or_else(|| "Codex WSL deadline expired".to_owned())
                                .and_then(|timeout| read(process, id, timeout))
                        }),
                    )
                })
                .collect();
            for (id, worker) in workers {
                results.insert(
                    id.clone(),
                    worker
                        .join()
                        .unwrap_or_else(|_| Err("WSL Codex diagnostic worker panicked".into())),
                );
            }
        });
    }
    results
}

// The bundled static Linux executable owns SQLite locking inside the distro.
// Arguments never pass through a shell or an ambient PATH lookup.
#[cfg(windows)]
pub(super) fn read_rows(
    process: &WslAgentProcess,
    terminal_id: &str,
    timeout: std::time::Duration,
) -> Result<Vec<LogRow>, String> {
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
    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("invalid WSL Codex diagnostics: {e}"))
}

#[cfg(not(windows))]
pub(super) fn read_rows(
    _: &WslAgentProcess,
    _: &str,
    _: std::time::Duration,
) -> Result<Vec<LogRow>, String> {
    Err("WSL is unavailable on this host".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

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
            if process.pid == 7 {
                Err("isolated database failure".into())
            } else {
                Ok(vec![])
            }
        });
        assert_eq!(rows.len(), 16);
        assert!(
            peak.load(Ordering::SeqCst) > 1,
            "serial probes exhausted the shared WSL deadline in dev"
        );
        assert!(peak.load(Ordering::SeqCst) <= 4);
        for (id, result) in &rows {
            assert_eq!(result.is_err(), id == "pane-7");
        }
        let expired = read_rows_batch_with(&processes, Instant::now(), |_, _, _| {
            panic!("expired probe must not start")
        });
        assert_eq!(expired.len(), 16);
        assert!(expired.values().all(Result::is_err));
    }
}
