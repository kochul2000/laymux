//! Unix domain sockets that only the current user can connect to (ADR-0305).
//!
//! Used by the PTY daemon transport and the `lx` IPC server. Linux makes the
//! socket file 0600. Windows (AF_UNIX, Windows 10 1803+) gives it a protected
//! DACL for the current user and SYSTEM; connecting needs write access to the
//! file, so other local accounts are refused by the operating system.

use std::io;
use std::path::Path;

#[cfg(unix)]
pub type Stream = std::os::unix::net::UnixStream;
#[cfg(windows)]
pub type Stream = uds_windows::UnixStream;

#[cfg(unix)]
pub type Listener = std::os::unix::net::UnixListener;
#[cfg(windows)]
pub type Listener = uds_windows::UnixListener;

/// Bind `path`, replacing a stale socket file, and restrict it to the current
/// user. The caller must own the path (an instance lock or a per-process
/// name), since an existing file is removed.
pub fn bind_user_only(path: &Path) -> io::Result<Listener> {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let listener = Listener::bind(path)?;
    restrict_to_user(path)?;
    Ok(listener)
}

fn restrict_to_user(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
    }
    #[cfg(windows)]
    {
        crate::win_acl::restrict_to_current_user(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};

    #[test]
    fn a_user_only_socket_carries_bytes_both_ways() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("probe.sock");
        // A stale file at the path is replaced.
        std::fs::write(&path, b"stale").unwrap();
        let listener = bind_user_only(&path).unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(&stream).read_line(&mut line).unwrap();
            (&stream).write_all(line.to_uppercase().as_bytes()).unwrap();
        });
        let mut client = Stream::connect(&path).unwrap();
        client.write_all(b"ping\n").unwrap();
        let mut reply = String::new();
        BufReader::new(&client).read_line(&mut reply).unwrap();
        assert_eq!(reply, "PING\n");
        server.join().unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        #[cfg(windows)]
        {
            let dacl = crate::win_acl::dacl_sddl(&path).unwrap();
            let sid = crate::win_acl::current_user_sid().unwrap();
            assert!(dacl.starts_with("D:P"), "{dacl}");
            assert!(dacl.contains(&sid), "{dacl}");
            assert_eq!(dacl.matches("(A;").count(), 2, "{dacl}");
        }
    }
}
