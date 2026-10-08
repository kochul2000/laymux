//! Local-only byte stream between the GUI and the PTY daemon.
//!
//! Linux uses a Unix socket inside the user-only (0700) daemon directory,
//! itself 0600. Windows uses a loopback TCP socket like the existing `lx`
//! IPC; the endpoint is never bound to a non-loopback address and every
//! connection must still present the per-instance token (see `discovery`).

use std::io;
use std::path::Path;
use std::time::Duration;

#[cfg(unix)]
pub type Stream = std::os::unix::net::UnixStream;
#[cfg(windows)]
pub type Stream = std::net::TcpStream;

pub struct Listener {
    #[cfg(unix)]
    inner: std::os::unix::net::UnixListener,
    #[cfg(windows)]
    inner: std::net::TcpListener,
}

impl Listener {
    /// Bind a fresh endpoint for this daemon instance. The caller must hold
    /// the daemon instance lock, which is what makes removing a stale Unix
    /// socket file safe.
    pub fn bind(dir: &Path) -> io::Result<(Self, String)> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join(crate::constants::PTY_DAEMON_SOCKET_FILE);
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            let inner = std::os::unix::net::UnixListener::bind(&path)?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
            let endpoint = path
                .to_str()
                .ok_or_else(|| io::Error::other("PTY daemon socket path is not valid Unicode"))?
                .to_owned();
            Ok((Self { inner }, endpoint))
        }
        #[cfg(windows)]
        {
            let _ = dir;
            let inner = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
            let endpoint = inner.local_addr()?.to_string();
            Ok((Self { inner }, endpoint))
        }
    }

    pub fn accept(&self) -> io::Result<Stream> {
        let (stream, _) = self.inner.accept()?;
        #[cfg(windows)]
        stream.set_nodelay(true)?;
        Ok(stream)
    }
}

pub fn connect(endpoint: &str, timeout: Duration) -> io::Result<Stream> {
    #[cfg(unix)]
    {
        let _ = timeout;
        Stream::connect(endpoint)
    }
    #[cfg(windows)]
    {
        let addr: std::net::SocketAddr = endpoint
            .parse()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        if !addr.ip().is_loopback() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "PTY daemon endpoint is not a loopback address",
            ));
        }
        let stream = Stream::connect_timeout(&addr, timeout)?;
        stream.set_nodelay(true)?;
        Ok(stream)
    }
}

/// Unblock both directions of a stream that other threads may be using.
pub fn shutdown(stream: &Stream) {
    let _ = stream.shutdown(std::net::Shutdown::Both);
}
