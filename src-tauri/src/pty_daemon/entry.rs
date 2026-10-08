//! Dedicated process entry; evaluated before any GUI/Tauri initialization.
use crate::daemon_protocol::{Capability, PROTOCOL_VERSION};
use crate::daemon_service::DaemonService;
use crate::daemon_transport::{current_identity, private_directory, Listener};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

pub(crate) const DAEMON_ARGUMENT: &str = "--pty-daemon";
pub(crate) const SPAWN_ARGUMENT: &str = "--pty-daemon-spawn";
const MAX_CONNECTIONS: usize = 8;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bootstrap_accepts_the_complete_serialized_gui_settings() {
        let value = Bootstrap {
            protocol: PROTOCOL_VERSION,
            scope: "scope".into(),
            endpoint: "endpoint".into(),
            runtime: "runtime".into(),
            runtime_path: "owned-runtime".into(),
            capability: CapabilityBytes([19; 32]),
            settings: crate::settings::Settings::default(),
        };
        let bytes = serde_json::to_vec(&value).unwrap();
        let restored: Bootstrap = serde_json::from_slice(&bytes)
            .expect("a real GUI configuration must cross the launcher boundary");
        assert_eq!(
            restored.settings.default_profile,
            value.settings.default_profile
        );
        assert_eq!(
            restored.settings.profiles.len(),
            value.settings.profiles.len()
        );
    }
}

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub(crate) struct CapabilityBytes(pub [u8; 32]);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Bootstrap {
    pub protocol: u32,
    pub scope: String,
    pub endpoint: String,
    pub runtime: String,
    pub runtime_path: PathBuf,
    pub capability: CapabilityBytes,
    pub settings: crate::settings::Settings,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Discovery {
    pub protocol: u32,
    pub scope: String,
    pub endpoint: String,
    pub incarnation: String,
    pub runtime: String,
    pub pid: u32,
}

pub(crate) fn scope_for(state_path: &Path) -> Result<String, AppError> {
    let identity = current_identity()?;
    let build = if cfg!(debug_assertions) {
        "dev"
    } else {
        "release"
    };
    let worktree = if cfg!(debug_assertions) {
        env!("LAYMUX_BUILD_WORKTREE_ROOT")
    } else {
        ""
    };
    let encoded = serde_json::to_vec(&(identity, build, worktree, state_path))?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

pub(crate) fn load_bootstrap(path: &Path) -> Result<Bootstrap, AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Other("daemon bootstrap path rejected".into()))?;
    private_directory(parent)?;
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > crate::daemon_protocol::MAX_FRAME_BYTES as u64
    {
        return Err(AppError::Other("daemon bootstrap file rejected".into()));
    }
    let bytes = Zeroizing::new(std::fs::read(path)?);
    let bootstrap: Bootstrap = serde_json::from_slice(&bytes)?;
    if bootstrap.protocol != PROTOCOL_VERSION
        || bootstrap.scope != scope_for(&crate::local_state::state_path()?)?
    {
        return Err(AppError::Other("daemon bootstrap scope rejected".into()));
    }
    private_directory(&bootstrap.runtime_path)?;
    crate::daemon_runtime::verify(&bootstrap.runtime_path, &bootstrap.runtime)?;
    Ok(bootstrap)
}

pub(crate) fn read_bootstrap(path: &Path) -> Result<Bootstrap, AppError> {
    let bootstrap = load_bootstrap(path)?;
    let current = std::env::current_exe()?.canonicalize()?;
    if current.parent() != Some(bootstrap.runtime_path.canonicalize()?.as_path()) {
        return Err(AppError::Other(
            "daemon executable must run from its immutable bundle".into(),
        ));
    }
    Ok(bootstrap)
}

pub(crate) async fn run(path: PathBuf) -> Result<(), AppError> {
    let bootstrap = read_bootstrap(&path)?;
    // OS advisory lifetime lock survives stale discovery files and is released
    // automatically on a crash/reboot. Different dev worktrees cannot become
    // simultaneous writers of one profile's SQLite state.
    let state_path = crate::local_state::state_path()?;
    let state_directory = state_path
        .parent()
        .ok_or_else(|| AppError::Other("daemon state directory unavailable".into()))?;
    std::fs::create_dir_all(state_directory)?;
    let writer_lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(state_directory.join("pty-daemon-writer.lock"))?;
    writer_lock
        .try_lock()
        .map_err(|_| AppError::Other("another daemon owns this profile's state writer".into()))?;
    let mut listener = Listener::bind(&bootstrap.endpoint)?;
    let node = bootstrap
        .runtime_path
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let service = DaemonService::new(
        Capability::from_bytes(bootstrap.capability.0),
        bootstrap.scope.clone(),
        bootstrap.runtime.clone(),
        bootstrap.settings,
        &node,
        &bootstrap.runtime_path.join("worker.cjs"),
    )?;
    let discovery = Discovery {
        protocol: PROTOCOL_VERSION,
        scope: bootstrap.scope,
        endpoint: bootstrap.endpoint,
        incarnation: service.incarnation().into(),
        runtime: bootstrap.runtime,
        pid: std::process::id(),
    };
    let directory = path
        .parent()
        .ok_or_else(|| AppError::Other("daemon bootstrap path rejected".into()))?;
    let discovery_path = directory.join("discovery.json");
    let temporary = directory.join(format!(".discovery-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, serde_json::to_vec(&discovery)?)?;
    std::fs::rename(&temporary, &discovery_path)?;
    let capacity = std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
    loop {
        // Reserve before accepting. Invalid or slow peers cannot spawn unbounded
        // tasks or allocate MAX_FRAME_BYTES on arbitrarily many connections.
        let permit = capacity
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| AppError::Other("daemon connection admission unavailable".into()))?;
        match listener.accept().await {
            Ok(stream) => {
                let service = service.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Err(error) = service.serve_connection(stream).await {
                        tracing::debug!(%error, "daemon client disconnected");
                    }
                });
            }
            Err(error) => {
                drop(permit);
                tracing::warn!(%error, "daemon peer rejected");
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        }
    }
}

pub fn run_if_requested() -> Option<Result<(), String>> {
    let mut arguments = std::env::args_os().skip(1);
    let mode = arguments.next()?;
    if mode != DAEMON_ARGUMENT && mode != SPAWN_ARGUMENT {
        return None;
    }
    let _ = tracing_subscriber::fmt()
        .with_target(false)
        .with_ansi(false)
        .try_init();
    let result = (|| {
        let path = arguments
            .next()
            .ok_or_else(|| AppError::Other("daemon bootstrap argument required".into()))?;
        if arguments.next().is_some() {
            return Err(AppError::Other("daemon arguments rejected".into()));
        }
        if mode == SPAWN_ARGUMENT {
            let path = PathBuf::from(path);
            read_bootstrap(&path)?;
            let diagnostics = std::fs::OpenOptions::new().create(true).append(true).open(
                path.parent()
                    .ok_or_else(|| {
                        AppError::Other("daemon diagnostic directory unavailable".into())
                    })?
                    .join("daemon.log"),
            )?;
            let mut command = crate::process::headless_command(std::env::current_exe()?);
            command
                .arg(DAEMON_ARGUMENT)
                .arg(path)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(diagnostics);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                // No console, independent process group, and outside any GUI
                // job. Refuse a non-breakaway host rather than losing jobs on
                // the next parent exit. This intermediate launcher exits now.
                command.creation_flags(0x08000000 | 0x00000200 | 0x01000000);
            }
            #[cfg(target_os = "linux")]
            {
                use std::os::unix::process::CommandExt;
                // SAFETY: setsid is async-signal-safe and uses no Rust locks.
                unsafe {
                    command.pre_exec(|| {
                        if libc::setsid() < 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                        Ok(())
                    });
                }
            }
            command.spawn().map_err(|error| {
                AppError::Other(format!("daemon OS detachment spawn failed: {error}"))
            })?;
            return Ok(());
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        runtime.block_on(run(path.into()))
    })();
    Some(result.map_err(|error: AppError| error.to_string()))
}
