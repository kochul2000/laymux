//! Where a terminal's `lx` finds the running IDE (ADR-0304).
//!
//! The IDE's IPC endpoint changes with every GUI process (a random loopback
//! port on Windows, a per-session socket on Linux). A shell outlives the GUI
//! that started it — the PTY daemon re-adopts it into the next GUI — so the
//! environment cannot carry the endpoint itself. It carries the fixed path of
//! this build kind's endpoint file instead; every GUI republishes the file at
//! startup and `lx` reads it on every invocation.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::constants::{ENV_LX_ENDPOINT_FILE, LX_ENDPOINT_FILE_NAME};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LxEndpoint {
    /// `127.0.0.1:{port}` on Windows, a Unix socket path elsewhere.
    pub endpoint: String,
    /// The publishing GUI, for diagnostics only.
    pub pid: u32,
}

/// This build kind's endpoint file, next to `automation.json` in the
/// settings directory (`%APPDATA%\laymux[-dev]`, `~/.config/laymux[-dev]`).
pub fn endpoint_file_path() -> PathBuf {
    endpoint_file_path_in(
        crate::settings::settings_path()
            .parent()
            .unwrap_or_else(|| Path::new(".")),
    )
}

pub fn endpoint_file_path_in(dir: &Path) -> PathBuf {
    dir.join(LX_ENDPOINT_FILE_NAME)
}

/// Replace the endpoint file atomically, so an `lx` running concurrently
/// reads either the previous or the new endpoint, never a partial file.
pub fn publish(path: &Path, endpoint: &LxEndpoint) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(endpoint).map_err(io::Error::other)?;
    let temp = path.with_extension(format!("json.{}.tmp", endpoint.pid));
    std::fs::write(&temp, json)?;
    std::fs::rename(&temp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

pub fn read(path: &Path) -> io::Result<LxEndpoint> {
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

/// The current IDE endpoint for an `lx` started with `endpoint_file` (the
/// value of `LX_ENDPOINT_FILE`). Read on every call: the GUI may have been
/// replaced since the shell started.
pub fn resolve(endpoint_file: Option<&str>) -> Result<String, String> {
    let path = endpoint_file
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            format!("{ENV_LX_ENDPOINT_FILE} not set. Are you running inside a Laymux terminal?")
        })?;
    read(Path::new(path))
        .map(|endpoint| endpoint.endpoint)
        .map_err(|error| format!("Could not read the Laymux endpoint file {path}: {error}"))
}

/// A connected IPC stream: reader half and writer half.
pub type LxConnection = (Box<dyn io::BufRead>, Box<dyn io::Write>);

/// Connect to an IDE endpoint as published by [`publish`].
pub fn connect(endpoint: &str) -> io::Result<LxConnection> {
    #[cfg(windows)]
    let stream = std::net::TcpStream::connect(endpoint)?;
    #[cfg(unix)]
    let stream = std::os::unix::net::UnixStream::connect(endpoint)?;
    let writer = stream.try_clone()?;
    Ok((Box::new(io::BufReader::new(stream)), Box::new(writer)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishing_replaces_the_previous_gui_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let path = endpoint_file_path_in(&dir.path().join("laymux-dev"));
        let first = LxEndpoint {
            endpoint: "127.0.0.1:50001".into(),
            pid: 10,
        };
        publish(&path, &first).unwrap();
        assert_eq!(read(&path).unwrap(), first);

        // A restarted GUI publishes its own endpoint over the old one; no
        // temporary file is left behind.
        let second = LxEndpoint {
            endpoint: "127.0.0.1:50002".into(),
            pid: 11,
        };
        publish(&path, &second).unwrap();
        assert_eq!(read(&path).unwrap(), second);
        let leftovers = std::fs::read_dir(path.parent().unwrap()).unwrap().count();
        assert_eq!(leftovers, 1);
    }

    #[test]
    fn lx_reaches_whichever_gui_published_the_file_last() {
        use crate::cli::{cli::send_message, LxMessage, LxResponse};
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let path = endpoint_file_path_in(dir.path());
        let env_value = path.to_string_lossy().into_owned();
        // Two GUIs in turn: the shell keeps the same environment value.
        for gui in ["first", "second"] {
            let session = format!("lx-endpoint-test-{gui}-{}", std::process::id());
            let endpoint = crate::ipc_server::start_ipc_server(
                session,
                Arc::new(move |_message: LxMessage| LxResponse::ok(Some(gui.into()))),
            )
            .unwrap();
            publish(
                &path,
                &LxEndpoint {
                    endpoint,
                    pid: std::process::id(),
                },
            )
            .unwrap();

            let resolved = resolve(Some(&env_value)).unwrap();
            let (mut reader, mut writer) = connect(&resolved).unwrap();
            let message = LxMessage::GetCwd {
                terminal_id: "t1".into(),
            };
            let response = send_message(&message, &mut reader, &mut writer).unwrap();
            assert_eq!(response.data.as_deref(), Some(gui));
        }
    }

    #[test]
    fn resolving_without_the_variable_explains_the_problem() {
        let error = resolve(None).unwrap_err();
        assert!(error.contains(ENV_LX_ENDPOINT_FILE), "{error}");
        assert!(resolve(Some("")).is_err());
    }

    #[test]
    fn a_missing_or_corrupt_file_is_an_error_not_an_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let path = endpoint_file_path_in(dir.path());
        assert_eq!(read(&path).unwrap_err().kind(), io::ErrorKind::NotFound);
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(read(&path).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }
}
