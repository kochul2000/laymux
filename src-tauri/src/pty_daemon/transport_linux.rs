use crate::error::AppError;
use std::os::unix::fs::PermissionsExt;
use tokio::net::{UnixListener, UnixStream};

pub(crate) fn private_directory(path: &std::path::Path) -> Result<(), AppError> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let created = std::fs::DirBuilder::new().mode(0o700).create(path);
    if let Err(error) = created {
        if error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(error.into());
        }
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.mode() & 0o777 != 0o700
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(AppError::Other(
            "daemon private directory permissions rejected".into(),
        ));
    }
    Ok(())
}

pub(crate) fn current_identity() -> Result<String, AppError> {
    let audit = std::fs::read_to_string("/proc/self/sessionid")
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| *value != u32::MAX);
    let session = audit
        .map(|value| format!("audit:{value}"))
        .unwrap_or_else(|| {
            let xdg = std::env::var("XDG_SESSION_ID").ok().filter(|value| {
                value.len() <= 128
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            });
            format!("xdg:{}", xdg.as_deref().unwrap_or("unassigned"))
        });
    // Audit/XDG login identity survives setsid(), unlike the process session ID.
    Ok(format!("linux-user:{}:{session}", unsafe {
        libc::geteuid()
    }))
}

fn verify_peer(stream: &UnixStream) -> Result<(), AppError> {
    // SAFETY: geteuid has no preconditions.
    if stream.peer_cred()?.uid() != unsafe { libc::geteuid() } {
        return Err(AppError::Other("daemon peer user rejected".into()));
    }
    if let Some(pid) = stream.peer_cred()?.pid() {
        let own = std::fs::read_to_string("/proc/self/sessionid")?;
        let peer = std::fs::read_to_string(format!("/proc/{pid}/sessionid"))?;
        if own.trim() != peer.trim() {
            return Err(AppError::Other("daemon peer audit session rejected".into()));
        }
    }
    Ok(())
}

pub(crate) struct Listener {
    inner: UnixListener,
}
impl Listener {
    pub(crate) fn bind(name: &str) -> Result<Self, AppError> {
        let parent = std::path::Path::new(name)
            .parent()
            .ok_or_else(|| AppError::Other("daemon socket parent unavailable".into()))?;
        private_directory(parent)?;
        // Never unlink an existing socket: it may belong to a live daemon.
        let inner = UnixListener::bind(name)?;
        std::fs::set_permissions(name, std::fs::Permissions::from_mode(0o600))?;
        Ok(Self { inner })
    }
    pub(crate) async fn accept(&mut self) -> Result<UnixStream, AppError> {
        let (stream, _) = self.inner.accept().await?;
        verify_peer(&stream)?;
        Ok(stream)
    }
}

pub(crate) async fn connect(name: &str) -> Result<UnixStream, AppError> {
    let stream = tokio::time::timeout(
        crate::daemon_protocol::CONNECTION_DEADLINE,
        UnixStream::connect(name),
    )
    .await
    .map_err(|_| AppError::Other("daemon connection deadline exceeded".into()))??;
    verify_peer(&stream)?;
    Ok(stream)
}
