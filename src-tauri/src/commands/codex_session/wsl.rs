//! WSL Codex diagnostics: the bundled static SQLite reader, run inside the
//! pane's distribution (ADR-0238), batched per distribution and shared through
//! the guest run table (ADR-0335).

use super::lifecycle::ProcessRows;
use crate::commands::wsl_agent_session::WslAgentProcess;
use crate::state::AppState;
use crate::wsl_probe::snapshot::{GuestObservation, GuestProbeKey, TerminalCatalog};
use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, Instant};

/// `arg0` of the guest batch shell, and the run's name in the shared table.
const BATCH_NAME: &str = "laymux-wsl-codex-probe";
const BATCH_HEADER: &str = "LAYMUX_WSL_CODEX_BATCH_V1";
const BATCH_END: &str = "LAYMUX_WSL_CODEX_BATCH_END";

/// Runs the bundled reader once per `(PID, pane marker)` pair inside one guest
/// shell, in order. Every value — the reader's path included — arrives as argv
/// and is never interpolated. Each pane is framed with its own exit status, so
/// one pane's failure stays that pane's. The reader's JSON is compact and never
/// contains a raw newline or tab.
#[cfg(any(windows, test))]
const CODEX_BATCH_SCRIPT: &str = r#"
helper=$1
shift
printf 'LAYMUX_WSL_CODEX_BATCH_V1\n'
index=0
while [ "$#" -ge 2 ]; do
  rows=$("$helper" "$1" "$2" 2>/dev/null)
  status=$?
  printf 'C\t%s\t%s\t%s\n' "$index" "$status" "$rows"
  index=$((index + 1))
  shift 2
done
printf 'LAYMUX_WSL_CODEX_BATCH_END\n'
"#;

/// One pane to read: the Codex PID and the pane's terminal id (its marker).
type Pane = (u32, String);

/// Diagnostics for every attributed WSL Codex process, keyed by terminal id.
/// `observation` is the lookup's freshness contract; every wait ends at
/// `deadline`.
pub(super) fn read_rows_batch(
    state: &AppState,
    processes: &HashMap<String, Option<WslAgentProcess>>,
    observation: GuestObservation,
    deadline: Instant,
) -> HashMap<String, Result<ProcessRows, String>> {
    read_rows_batch_with(state, processes, observation, deadline, run_batch)
}

fn read_rows_batch_with<R>(
    state: &AppState,
    processes: &HashMap<String, Option<WslAgentProcess>>,
    observation: GuestObservation,
    deadline: Instant,
    run: R,
) -> HashMap<String, Result<ProcessRows, String>>
where
    R: Fn(&str, &[Pane], Duration) -> Result<Vec<u8>, String> + Clone + Send + 'static,
{
    let mut by_distro: BTreeMap<&str, Vec<Pane>> = BTreeMap::new();
    for (terminal_id, process) in processes {
        if let Some(process) = process {
            by_distro
                .entry(&process.distro)
                .or_default()
                .push((process.pid, terminal_id.clone()));
        }
    }
    let mut results = HashMap::new();
    if by_distro.is_empty() {
        return results;
    }
    let catalog = match TerminalCatalog::of(state) {
        Ok(catalog) => catalog,
        Err(error) => {
            let error = error.to_string();
            for (_, terminal_id) in by_distro.into_values().flatten() {
                results.insert(terminal_id, Err(error.clone()));
            }
            return results;
        }
    };
    // Sorted chunks: every reader of the same panes asks for the same runs.
    // All runs start before any is awaited, so chunks overlap in the deadline.
    let mut pending = Vec::new();
    for (distro, mut panes) in by_distro {
        panes.sort_by(|left, right| left.1.cmp(&right.1));
        for chunk in panes.chunks(crate::constants::WSL_CODEX_PROBE_BATCH_PANES) {
            let chunk = chunk.to_vec();
            let args = chunk
                .iter()
                .flat_map(|(pid, terminal_id)| [pid.to_string(), terminal_id.clone()])
                .collect();
            let (run, run_distro, run_chunk) = (run.clone(), distro.to_string(), chunk.clone());
            let request = state.wsl_guest_snapshots.request(
                GuestProbeKey::new(BATCH_NAME, distro, args),
                &catalog,
                observation,
                deadline,
                move |timeout| run(&run_distro, &run_chunk, timeout),
            );
            pending.push((chunk, request));
        }
    }
    for (chunk, request) in pending {
        match request
            .wait(deadline)
            .and_then(|output| parse_batch_output(&output, chunk.len()))
        {
            Ok(rows) => {
                for ((pid, terminal_id), rows) in chunk.into_iter().zip(rows) {
                    results.insert(
                        terminal_id,
                        rows.and_then(|rows| require_identity(rows, pid)),
                    );
                }
            }
            Err(error) => {
                for (_, terminal_id) in chunk {
                    results.insert(terminal_id, Err(error.clone()));
                }
            }
        }
    }
    results
}

/// Split one batch run into per-pane results. A run whose framing is broken —
/// truncated, reordered, or the wrong size — fails every pane it carried.
fn parse_batch_output(
    output: &[u8],
    panes: usize,
) -> Result<Vec<Result<ProcessRows, String>>, String> {
    let text = std::str::from_utf8(output).map_err(|_| "WSL Codex diagnostics were not UTF-8")?;
    let lines: Vec<&str> = text.lines().collect();
    if lines.first().copied() != Some(BATCH_HEADER) || lines.last().copied() != Some(BATCH_END) {
        return Err("WSL Codex diagnostics were incomplete".into());
    }
    let rows = &lines[1..lines.len() - 1];
    if rows.len() != panes {
        return Err("WSL Codex diagnostics did not cover every pane".into());
    }
    rows.iter()
        .enumerate()
        .map(|(position, line)| {
            let mut fields = line.splitn(4, '\t');
            let (Some("C"), Some(index), Some(status), Some(json)) =
                (fields.next(), fields.next(), fields.next(), fields.next())
            else {
                return Err("WSL Codex diagnostics row had an invalid shape".to_string());
            };
            if index.parse::<usize>().ok() != Some(position) {
                return Err("WSL Codex diagnostics rows were out of order".into());
            }
            let status: u8 = status
                .parse()
                .map_err(|_| "WSL Codex diagnostics row had an invalid status".to_string())?;
            Ok(if status == 0 {
                serde_json::from_str::<ProcessRows>(json)
                    .map_err(|error| format!("invalid WSL Codex diagnostics: {error}"))
            } else {
                Err(format!("WSL Codex probe exited with {status}"))
            })
        })
        .collect()
}

fn require_identity(rows: ProcessRows, pid: u32) -> Result<ProcessRows, String> {
    if !rows.process_uuid.starts_with(&format!("pid:{pid}:")) {
        return Err("WSL Codex diagnostic process identity mismatch".into());
    }
    Ok(rows)
}

// The bundled static Linux executable owns SQLite locking inside the distro.
// Arguments never pass through a shell interpolation or an ambient PATH lookup.
#[cfg(windows)]
fn run_batch(distro: &str, panes: &[Pane], timeout: Duration) -> Result<Vec<u8>, String> {
    if !crate::wsl_probe::is_safe_distro_name(distro) {
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
    let mut command = crate::process::headless_wsl_command();
    command.args([
        "-d",
        distro,
        "--exec",
        "sh",
        "-c",
        CODEX_BATCH_SCRIPT,
        BATCH_NAME,
        &helper,
    ]);
    for (pid, terminal_id) in panes {
        command.arg(pid.to_string()).arg(terminal_id);
    }
    let output =
        crate::process::output_with_timeout(&mut command, timeout).map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("WSL Codex probe exited with {}", output.status));
    }
    Ok(output.stdout)
}

#[cfg(not(windows))]
fn run_batch(_: &str, _: &[Pane], _: Duration) -> Result<Vec<u8>, String> {
    Err("WSL is unavailable on this host".into())
}

#[cfg(test)]
mod tests;
