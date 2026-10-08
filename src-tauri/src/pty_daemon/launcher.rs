//! Discover or start a service. Existing live images are never overwritten.
use crate::daemon_entry::{Bootstrap, CapabilityBytes, Discovery, SPAWN_ARGUMENT};
use crate::daemon_protocol::{Capability, PROTOCOL_VERSION};
use crate::daemon_transport::private_directory;
use crate::error::AppError;
use crate::settings::Settings;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub(crate) struct PreparedService {
    pub root: PathBuf,
    pub bootstrap: Bootstrap,
    pub discovery: Discovery,
    _startup_lock: std::fs::File,
}

fn read_discovery(path: &Path) -> Result<Discovery, AppError> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
        return Err(AppError::Other("daemon discovery file rejected".into()));
    }
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}

fn runtime_sources(
    executable: &Path,
    resources: &Path,
) -> Result<Vec<(String, PathBuf)>, AppError> {
    let parent = executable
        .parent()
        .ok_or_else(|| AppError::Other("daemon source directory unavailable".into()))?;
    let mut sources = vec![
        (
            if cfg!(windows) {
                "laymux.exe"
            } else {
                "laymux"
            }
            .into(),
            executable.into(),
        ),
        (
            if cfg!(windows) { "node.exe" } else { "node" }.into(),
            resources
                .join("headless")
                .join(if cfg!(windows) { "node.exe" } else { "node" }),
        ),
        ("worker.cjs".into(), resources.join("headless/worker.cjs")),
        (
            "node-runtime.json".into(),
            resources.join("headless/node-runtime.json"),
        ),
        (
            "Node-LICENSE.txt".into(),
            resources.join("headless/Node-LICENSE.txt"),
        ),
    ];
    let helpers: &[&str] = if cfg!(windows) {
        &[
            "lx.exe",
            "laymux-agent-hook.exe",
            "laymux-agent-hook-wsl",
            "laymux-wsl-codex-probe",
            "conpty.dll",
            "OpenConsole.exe",
        ]
    } else {
        &["lx", "laymux-agent-hook"]
    };
    for name in helpers {
        let path = if parent.join(name).is_file() {
            parent.join(name)
        } else {
            resources.join(name)
        };
        if !path.is_file() {
            return Err(AppError::Other(format!(
                "daemon bundled helper missing: {name}"
            )));
        }
        sources.push(((*name).into(), path));
    }
    Ok(sources)
}

/// Called on a blocking startup worker, never with an AppState lock held.
pub(crate) fn prepare(
    settings: &Settings,
    executable: &Path,
    resources: &Path,
) -> Result<PreparedService, AppError> {
    let state_path = crate::local_state::state_path()?;
    let parent = state_path
        .parent()
        .ok_or_else(|| AppError::Other("daemon profile directory unavailable".into()))?;
    std::fs::create_dir_all(parent)?;
    let scope = crate::daemon_entry::scope_for(&state_path)?;
    let root = parent.join(format!("pty-daemon-{}", &scope[..24]));
    private_directory(&root)?;
    let startup_lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("startup.lock"))?;
    startup_lock
        .try_lock()
        .map_err(|_| AppError::Other("daemon startup already in progress".into()))?;
    let bootstrap_path = root.join("bootstrap.json");
    let discovery_path = root.join("discovery.json");
    if bootstrap_path.is_file() && discovery_path.is_file() {
        let bootstrap = crate::daemon_entry::load_bootstrap(&bootstrap_path)?;
        let discovery = read_discovery(&discovery_path)?;
        if discovery.protocol != PROTOCOL_VERSION
            || discovery.scope != scope
            || discovery.runtime != bootstrap.runtime
            || discovery.endpoint != bootstrap.endpoint
            || discovery.incarnation.is_empty()
        {
            return Err(AppError::Other("daemon discovery identity rejected".into()));
        }
        // A kernel lock, rather than a PID/file timestamp, distinguishes a
        // surviving owner from stale files left by a crash or reboot.
        let writer = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(parent.join("pty-daemon-writer.lock"))?;
        if writer.try_lock().is_err() {
            return Ok(PreparedService {
                root,
                bootstrap,
                discovery,
                _startup_lock: startup_lock,
            });
        }
    }
    // A daemon in another worktree/logon can share this SQLite profile but must
    // not be replaced. Fail before writing a new bootstrap or starting a child.
    let writer = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(parent.join("pty-daemon-writer.lock"))?;
    writer.try_lock().map_err(|_| {
        AppError::Other("another worktree or logon owns this profile's PTY daemon".into())
    })?;
    let runtimes = root.join("runtimes");
    private_directory(&runtimes)?;
    let (runtime, runtime_path) =
        crate::daemon_runtime::stage(&runtimes, &runtime_sources(executable, resources)?)?;
    let endpoint = if cfg!(windows) {
        format!(r"\\.\pipe\laymux-pty-{}", uuid::Uuid::new_v4())
    } else {
        // sockaddr_un has a short path limit. Keep sockets in a protected
        // short directory, independently of long XDG_STATE_HOME/worktree paths.
        let socket_directory = std::env::temp_dir().join(format!("laymux-pty-{}", &scope[..24]));
        private_directory(&socket_directory)?;
        socket_directory
            .join(format!(
                "{}.sock",
                &uuid::Uuid::new_v4().simple().to_string()[..16]
            ))
            .to_string_lossy()
            .into_owned()
    };
    let key = Capability::generate()?;
    let bootstrap = Bootstrap {
        protocol: PROTOCOL_VERSION,
        scope,
        endpoint,
        runtime,
        runtime_path,
        capability: CapabilityBytes(*key.bytes()),
        settings: settings.clone(),
    };
    let temporary = root.join(format!(".bootstrap-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, serde_json::to_vec(&bootstrap)?)?;
    std::fs::rename(&temporary, &bootstrap_path)?;
    drop(writer); // transfer the kernel writer lock to the child
    let daemon = bootstrap.runtime_path.join(if cfg!(windows) {
        "laymux.exe"
    } else {
        "laymux"
    });
    let mut command = crate::process::headless_command(daemon);
    command.arg(SPAWN_ARGUMENT).arg(&bootstrap_path);
    let output = crate::process::output_with_timeout(&mut command, Duration::from_secs(5))?;
    if !output.status.success() {
        let mut diagnostic = output.stdout;
        diagnostic.extend(output.stderr);
        diagnostic.truncate(4096);
        std::fs::write(root.join("launcher.log"), &diagnostic)?;
        return Err(AppError::Other(format!(
            "daemon detached launcher failed ({:?}); see launcher.log",
            output.status.code()
        )));
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(discovery) = read_discovery(&discovery_path) {
            if discovery.protocol == PROTOCOL_VERSION
                && discovery.scope == bootstrap.scope
                && discovery.runtime == bootstrap.runtime
                && discovery.endpoint == bootstrap.endpoint
            {
                return Ok(PreparedService {
                    root,
                    bootstrap,
                    discovery,
                    _startup_lock: startup_lock,
                });
            }
        }
        if Instant::now() >= deadline {
            return Err(AppError::Other(
                "daemon startup acknowledgement timed out".into(),
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
