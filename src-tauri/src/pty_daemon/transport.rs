//! Local-only byte stream between the GUI and the PTY daemon (ADR-0305).
//!
//! Both platforms use a Unix domain socket in the daemon directory that only
//! the current user can connect to (`local_socket`). Every connection still
//! presents the per-instance token and checks the daemon's proof (see
//! `discovery`).

use std::io;
use std::path::Path;
use std::time::Duration;

use crate::constants::PTY_DAEMON_SOCKET_FILE;
use crate::local_socket;

pub use crate::local_socket::Stream;

pub struct Listener {
    inner: local_socket::Listener,
}

impl Listener {
    /// Bind a fresh endpoint for this daemon instance. The caller must hold
    /// the daemon instance lock, which is what makes removing a stale socket
    /// file safe.
    pub fn bind(dir: &Path) -> io::Result<(Self, String)> {
        let path = dir.join(PTY_DAEMON_SOCKET_FILE);
        let inner = local_socket::bind_user_only(&path)?;
        let endpoint = path
            .to_str()
            .ok_or_else(|| io::Error::other("PTY daemon socket path is not valid Unicode"))?
            .to_owned();
        Ok((Self { inner }, endpoint))
    }

    pub fn accept(&self) -> io::Result<Stream> {
        let (stream, _) = self.inner.accept()?;
        Ok(stream)
    }
}

/// Connect to a daemon socket. A local socket connects or fails at once, so
/// `timeout` only matters to the handshake the caller bounds next.
pub fn connect(endpoint: &str, timeout: Duration) -> io::Result<Stream> {
    let _ = timeout;
    Stream::connect(endpoint)
}

/// Unblock both directions of a stream that other threads may be using.
pub fn shutdown(stream: &Stream) {
    let _ = stream.shutdown(std::net::Shutdown::Both);
}
