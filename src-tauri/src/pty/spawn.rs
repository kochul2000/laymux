//! PTY spawn: command construction for a terminal session and the shared
//! open/spawn/reader bring-up used by in-process PTYs, daemon sessions and
//! the GUI's daemon proxy (ADR-0300).

use portable_pty::{native_pty_system, Child, CommandBuilder, PtyPair, PtySize, PtySystem};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use std::thread;

use super::{
    is_wsl_command, plan_start_dir, publish_child_exit, PtyHandle, PtyOutputControl, StartDirPlan,
};
use crate::constants::{
    ENV_WSLENV, PTY_DAEMON_METADATA_AGENT_HOOK_TOKEN, PTY_DAEMON_METADATA_PROFILE,
    PTY_DAEMON_METADATA_WSL_BACKED,
};
use crate::pty_control::PtyControlWorker;
use crate::pty_reader::{run_interruptible_reader_loop, PtyReaderLifecycle};
use crate::terminal::{InitialExecutionHost, TerminalSession};
use crate::terminal_env::TerminalEnvPlan;

/// Spawn a PTY process for the given terminal session.
/// Returns a PtyHandle and starts a reader thread that calls `on_output` with data chunks.
pub struct SpawnedPty {
    pub handle: PtyHandle,
    pub initial_execution_host: InitialExecutionHost,
    /// The directory the child was actually started in, canonicalized like an
    /// OSC 7 CWD, or `None` when no starting directory could be applied.
    pub resolved_cwd: Option<String>,
    /// Set when the terminal took over a daemon session an earlier GUI left
    /// running instead of starting a new child: the metadata that GUI stored.
    pub adopted: Option<BTreeMap<String, String>>,
}

pub fn spawn_pty<F>(session: &TerminalSession, on_output: F) -> Result<PtyHandle, String>
where
    F: Fn(Vec<u8>) -> PtyOutputControl + Send + 'static,
{
    spawn_pty_for_generation(session, 1, on_output).map(|spawned| spawned.handle)
}

pub fn spawn_pty_with_metadata<F>(
    session: &TerminalSession,
    on_output: F,
) -> Result<SpawnedPty, String>
where
    F: Fn(Vec<u8>) -> PtyOutputControl + Send + 'static,
{
    spawn_pty_for_generation(session, 1, on_output)
}

pub fn spawn_pty_for_generation<F>(
    session: &TerminalSession,
    terminal_generation: u64,
    on_output: F,
) -> Result<SpawnedPty, String>
where
    F: Fn(Vec<u8>) -> PtyOutputControl + Send + 'static,
{
    spawn_pty_on(&PtyBackend::Local, session, terminal_generation, on_output)
}

/// Where a terminal's OS PTY and child process live (ADR-0300).
///
/// Only the owner of the master/child changes. Command construction, the
/// output callback (protocol/OSC/delivery) and the [`PtyHandle`] contract are
/// identical for both backends.
#[derive(Debug, Clone)]
pub enum PtyBackend {
    /// The GUI process owns the PTY (default).
    Local,
    /// The detached PTY daemon owns the PTY; the GUI holds a proxy. With
    /// `adopt`, the terminal takes over that live daemon session (left by an
    /// earlier GUI) instead of spawning, and the built command is not run.
    Daemon {
        endpoint: crate::pty_daemon::DaemonEndpoint,
        adopt: Option<String>,
    },
}

impl PtyBackend {
    pub fn adopts(&self) -> bool {
        matches!(self, Self::Daemon { adopt: Some(_), .. })
    }
}

pub fn spawn_pty_on<F>(
    backend: &PtyBackend,
    session: &TerminalSession,
    terminal_generation: u64,
    on_output: F,
) -> Result<SpawnedPty, String>
where
    F: Fn(Vec<u8>) -> PtyOutputControl + Send + 'static,
{
    let size = PtySize {
        rows: session.config.rows,
        cols: session.config.cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let (command_line, startup_command) = if session.config.command_line.is_empty() {
        // Fallback: legacy profile name-based resolution. Historically this
        // path did not consume startup_command, so preserve that behavior.
        (
            TerminalSession::profile_command_line(&session.config.profile),
            "",
        )
    } else {
        (
            session.config.command_line.as_str(),
            session.config.startup_command.as_str(),
        )
    };
    let executable = command_line
        .split_whitespace()
        .next()
        .unwrap_or("powershell.exe");
    let is_wsl = is_wsl_command(executable);
    let inherited_wslenv = is_wsl.then(|| std::env::var(ENV_WSLENV).ok()).flatten();
    let env_plan = TerminalEnvPlan::for_session(
        &session.config.env,
        &session.id,
        &session.config.sync_group,
        session.config.advertise_true_color,
        is_wsl,
        inherited_wslenv.as_deref(),
    );

    let (cmd_path, args) = TerminalSession::command_line_to_command_with_env_plan(
        command_line,
        &env_plan,
        startup_command,
    );
    let initial_execution_host = InitialExecutionHost::for_current_platform(Some(&cmd_path));
    let mut cmd = CommandBuilder::new(&cmd_path);
    for arg in &args {
        cmd.arg(arg);
    }
    env_plan.apply_to_command(&mut cmd);

    // Set starting directory if configured
    let start_dir = plan_start_dir(&session.config.starting_directory, &cmd_path);
    match &start_dir {
        StartDirPlan::WslCd(dir) => {
            // WSL terminal with Unix path: inject --cd flag before existing args
            cmd = CommandBuilder::new(&cmd_path);
            cmd.arg("--cd");
            cmd.arg(dir);
            for arg in &args {
                cmd.arg(arg);
            }
            env_plan.apply_to_command(&mut cmd);
        }
        StartDirPlan::ChildCwd(dir) => cmd.cwd(std::path::Path::new(dir)),
        StartDirPlan::None => {}
    }

    let options = |kill_owner| SpawnOptions {
        wsl_backed: is_wsl,
        kill_owner,
    };
    let (handle, adopted) = match backend {
        PtyBackend::Local => (
            spawn_command_on(
                native_pty_system().as_ref(),
                size,
                cmd,
                terminal_generation,
                options(ChildKillOwner::Local),
                on_output,
                PtyLifecycleHooks::default(),
            )?,
            None,
        ),
        PtyBackend::Daemon { endpoint, adopt } => {
            // Adoption is claimed atomically by the daemon and may be
            // refused (another client won the race, or the session started
            // terminating); a refused adoption starts a new child instead.
            let adopted = adopt.as_ref().and_then(|session_key| {
                let system =
                    crate::pty_daemon::DaemonPtySystem::adopt(endpoint.clone(), session_key.clone());
                match open_and_spawn(&system, size, cmd.clone()) {
                    Ok(opened) => system.adopted_metadata().map(|metadata| (opened, metadata)),
                    Err(error) => {
                        tracing::warn!(terminal_id = %session.id, %error, "PTY daemon adoption refused; starting a new session");
                        None
                    }
                }
            });
            let (opened, metadata) = match adopted {
                Some((opened, metadata)) => (opened, Some(metadata)),
                None => {
                    let system = crate::pty_daemon::DaemonPtySystem::spawn(
                        endpoint.clone(),
                        crate::pty_daemon::session_key(&session.id, terminal_generation),
                        session.id.clone(),
                        daemon_session_metadata(session, is_wsl),
                    );
                    (open_and_spawn(&system, size, cmd)?, None)
                }
            };
            // An adopted child keeps the WSL domain it was started in.
            let wsl_backed = metadata
                .as_ref()
                .and_then(|metadata| metadata.get(PTY_DAEMON_METADATA_WSL_BACKED))
                .map_or(is_wsl, |value| value == "true");
            let handle = start_spawned(
                opened,
                terminal_generation,
                SpawnOptions {
                    wsl_backed,
                    kill_owner: ChildKillOwner::Backend,
                },
                on_output,
                PtyLifecycleHooks::default(),
            )?;
            (handle, metadata)
        }
    };

    Ok(SpawnedPty {
        handle,
        initial_execution_host,
        // For an adopted child this is the requested (last known) directory,
        // the best available seed until its next OSC 7.
        resolved_cwd: start_dir.resolved_cwd(),
        adopted,
    })
}

/// GUI state a later GUI needs to keep serving a child it adopts. The agent
/// hook token is baked into the child's environment, so hooks from an adopted
/// shell only authenticate if the new GUI reuses it.
fn daemon_session_metadata(
    session: &TerminalSession,
    wsl_backed: bool,
) -> BTreeMap<String, String> {
    BTreeMap::from([
        (
            PTY_DAEMON_METADATA_AGENT_HOOK_TOKEN.to_owned(),
            session.agent_hook_token.clone(),
        ),
        (
            PTY_DAEMON_METADATA_PROFILE.to_owned(),
            session.config.profile.clone(),
        ),
        (
            PTY_DAEMON_METADATA_WSL_BACKED.to_owned(),
            wsl_backed.to_string(),
        ),
    ])
}

/// Who may kill the direct child's process tree by PID.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChildKillOwner {
    /// This process holds the OS child handle, so a PID-based tree kill is
    /// safe from PID recycling while `child_exited` is still false.
    Local,
    /// Another process (the PTY daemon) holds the child handle. A PID kill
    /// from here could hit a recycled PID, so killing is delegated to the
    /// backend's `ChildKiller`, which performs the tree kill where the handle
    /// lives.
    Backend,
}

pub(crate) struct SpawnOptions {
    pub wsl_backed: bool,
    pub kill_owner: ChildKillOwner,
}

/// Optional observers for the two independent end-of-life signals of a PTY.
/// The GUI derives both from its own reader/handle; the daemon forwards them
/// to its attached client.
#[derive(Default)]
pub(crate) struct PtyLifecycleHooks {
    /// Runs on the reader thread after the last output callback returned.
    pub on_reader_end: Option<Box<dyn FnOnce() + Send>>,
    /// Runs on the wait thread once the child exit has been published.
    pub on_child_exit: Option<Box<dyn FnOnce(u32) + Send>>,
}

/// Open a PTY on `pty_system`, spawn `cmd` into it and start the
/// generation-scoped reader. Shared by the in-process path, the daemon's
/// native sessions and the GUI's daemon proxy.
pub(crate) fn spawn_command_on<F>(
    pty_system: &dyn PtySystem,
    size: PtySize,
    cmd: CommandBuilder,
    terminal_generation: u64,
    options: SpawnOptions,
    on_output: F,
    hooks: PtyLifecycleHooks,
) -> Result<PtyHandle, String>
where
    F: Fn(Vec<u8>) -> PtyOutputControl + Send + 'static,
{
    let spawned = open_and_spawn(pty_system, size, cmd)?;
    start_spawned(spawned, terminal_generation, options, on_output, hooks)
}

/// A child running in a freshly opened PTY whose reader is not started yet.
pub(crate) struct OpenedPty {
    pair: PtyPair,
    child: Box<dyn Child + Send + Sync>,
}

/// First half of [`spawn_command_on`]: open the PTY and start the child.
/// Nothing consumes the output callback yet, so a caller can still try
/// another PTY system when this fails.
pub(crate) fn open_and_spawn(
    pty_system: &dyn PtySystem,
    size: PtySize,
    cmd: CommandBuilder,
) -> Result<OpenedPty, String> {
    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {e}"))?;
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {e}"))?;
    Ok(OpenedPty { pair, child })
}

/// Second half of [`spawn_command_on`]: wait thread, writer, reader.
pub(crate) fn start_spawned<F>(
    opened: OpenedPty,
    terminal_generation: u64,
    options: SpawnOptions,
    on_output: F,
    hooks: PtyLifecycleHooks,
) -> Result<PtyHandle, String>
where
    F: Fn(Vec<u8>) -> PtyOutputControl + Send + 'static,
{
    let OpenedPty { pair, child } = opened;

    let child_pid = child.process_id();
    let child_killer = child.clone_killer();
    let child_exited = Arc::new(AtomicBool::new(false));
    let exited_signal = Arc::clone(&child_exited);
    let child_exit_handshake = Arc::new(Mutex::new(()));
    let exited_handshake = Arc::clone(&child_exit_handshake);
    let on_child_exit = hooks.on_child_exit;

    // Spawn a background thread to wait for the child process.
    // This prevents zombie processes on Unix (where unwait-ed children
    // linger in the process table). On Windows, this closes the process
    // handle cleanly after exit. The thread exits naturally when the
    // shell terminates (e.g., via PTY master close → SIGHUP).
    //
    // The `child_exited` flip MUST happen before `child` drops: while the
    // `Box<dyn Child>` is alive the OS keeps the PID reserved to this
    // process (Windows won't recycle it), so any observer that sees
    // `child_exited == true` can safely conclude the PID belongs to the
    // now-dead shell and not an unrelated process.
    thread::spawn(move || {
        let mut child = child;
        let exit_code = match child.wait() {
            Ok(status) => status.exit_code(),
            Err(_) => 1,
        };
        if let Err(error) = publish_child_exit(&exited_handshake, &exited_signal) {
            // Dropping the process handle after a poisoned handshake could
            // make a concurrent PID-based kill unsafe. Leak it instead; this
            // is a terminal-local fail-safe on an already-corrupted path.
            tracing::error!(%error, "child exit handshake failed; retaining process handle");
            std::mem::forget(child);
        }
        // `child` drops here; Windows may recycle the PID after this point.
        if let Some(on_child_exit) = on_child_exit {
            on_child_exit(exit_code);
        }
    });
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take writer: {e}"))?;

    let reader_pair = pair
        .master
        .try_clone_interruptible_reader(terminal_generation)
        .map_err(|e| format!("Failed to clone interruptible reader: {e}"))?
        .ok_or_else(|| "Native PTY does not provide an interruptible reader".to_string())?;
    let reader_lifecycle = PtyReaderLifecycle::new(terminal_generation, reader_pair.control)?;

    let master = Arc::new(Mutex::new(Some(pair.master)));
    let control = PtyControlWorker::spawn(writer, Arc::clone(&master))?;
    let handle = PtyHandle {
        checkpoint_input_revision: Arc::new(AtomicU64::new(0)),
        session_restore: None,
        control,
        master,
        child_killer: Arc::new(Mutex::new(Some(child_killer))),
        child_pid,
        child_exited,
        child_exit_handshake,
        input_faulted: Arc::new(AtomicBool::new(false)),
        reader_lifecycle: Arc::clone(&reader_lifecycle),
        codex_startup_color_probe: None,
        bootstrap_da_reply: None,
        wsl_backed: options.wsl_backed,
        kill_owner: options.kill_owner,
    };

    // Spawn reader thread
    let on_reader_end = hooks.on_reader_end;
    thread::spawn(move || {
        run_interruptible_reader_loop(reader_pair.reader, reader_lifecycle, on_output);
        if let Some(on_reader_end) = on_reader_end {
            on_reader_end();
        }
    });

    Ok(handle)
}
