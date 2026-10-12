use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::cli::{LxMessage, LxResponse};
use crate::constants::{LX_SOCKET_PREFIX, LX_SOCKET_SUFFIX};
use crate::local_socket;

/// Handle a single IPC connection by reading JSON messages and returning responses.
/// Each line is a JSON LxMessage; the response is a JSON LxResponse on one line.
pub fn handle_ipc_stream<R: BufRead, W: Write, F>(
    reader: &mut R,
    writer: &mut W,
    handler: F,
) -> Result<(), String>
where
    F: Fn(LxMessage) -> LxResponse,
{
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break, // EOF
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let response = match serde_json::from_str::<LxMessage>(trimmed) {
                    Ok(message) => handler(message),
                    Err(e) => LxResponse::err(format!("Parse error: {e}")),
                };

                let response_json = serde_json::to_string(&response)
                    .unwrap_or_else(|_| r#"{"success":false,"error":"Serialize error"}"#.into());

                let _ = writeln!(writer, "{response_json}");
                let _ = writer.flush();
            }
            Err(e) => {
                return Err(format!("Read error: {e}"));
            }
        }
    }
    Ok(())
}

/// This GUI's socket. Per process, so a second, accidental GUI of the same
/// build kind never unbinds the first one's socket.
pub fn socket_path_in(dir: &Path, session_id: &str) -> PathBuf {
    dir.join(format!("{LX_SOCKET_PREFIX}{session_id}{LX_SOCKET_SUFFIX}"))
}

/// Start the IPC server in a background thread on a Unix domain socket that
/// only the current user can connect to (ADR-0305). Returns the socket path.
pub fn start_ipc_server<F>(session_id: String, handler: Arc<F>) -> Result<String, String>
where
    F: Fn(LxMessage) -> LxResponse + Send + Sync + 'static,
{
    let dir =
        crate::lx_endpoint::lx_dir().ok_or_else(|| "cannot locate the lx directory".to_string())?;
    start_ipc_server_in(&dir, &session_id, handler)
}

pub fn start_ipc_server_in<F>(
    dir: &Path,
    session_id: &str,
    handler: Arc<F>,
) -> Result<String, String>
where
    F: Fn(LxMessage) -> LxResponse + Send + Sync + 'static,
{
    local_socket::ensure_private_dir(dir).map_err(|e| format!("Socket directory error: {e}"))?;
    remove_dead_sockets(dir);
    let path = socket_path_in(dir, session_id);
    let listener = local_socket::bind_user_only(&path).map_err(|e| format!("Bind error: {e}"))?;
    let endpoint = path
        .to_str()
        .ok_or_else(|| "IPC socket path is not valid Unicode".to_string())?
        .to_owned();

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let handler = Arc::clone(&handler);
                    std::thread::spawn(move || {
                        let mut reader = BufReader::new(&stream);
                        let mut writer = &stream;
                        let _ = handle_ipc_stream(&mut reader, &mut writer, |msg| handler(msg));
                    });
                }
                Err(_) => break,
            }
        }
        let _ = std::fs::remove_file(&path);
    });

    Ok(endpoint)
}

/// Remove sockets left by GUIs that died without cleaning up. A socket whose
/// process still runs is kept: it may be another GUI's live server.
fn remove_dead_sockets(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut system = sysinfo::System::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name
            .to_str()
            .and_then(|name| name.strip_prefix(LX_SOCKET_PREFIX))
            .and_then(|rest| rest.strip_suffix(LX_SOCKET_SUFFIX))
            .and_then(|pid| pid.parse::<u32>().ok())
        else {
            continue;
        };
        let pid = sysinfo::Pid::from_u32(pid);
        system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
        if system.process(pid).is_none() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn handle_ipc_stream_parses_message() {
        let input = r#"{"action":"notify","message":"hello","terminal_id":"t1"}"#;
        let mut reader = BufReader::new(Cursor::new(format!("{input}\n")));
        let mut output = Vec::new();

        let result = handle_ipc_stream(&mut reader, &mut output, |msg| match msg {
            LxMessage::Notify { message, .. } => LxResponse::ok(Some(format!("got: {message}"))),
            _ => LxResponse::err("unexpected".into()),
        });

        assert!(result.is_ok());
        let response_str = String::from_utf8(output).unwrap();
        let response: LxResponse = serde_json::from_str(response_str.trim()).unwrap();
        assert!(response.success);
        assert_eq!(response.data, Some("got: hello".into()));
    }

    #[test]
    fn handle_ipc_stream_returns_error_for_invalid_json() {
        let mut reader = BufReader::new(Cursor::new("not json\n"));
        let mut output = Vec::new();

        let result = handle_ipc_stream(&mut reader, &mut output, |_| LxResponse::ok(None));

        assert!(result.is_ok());
        let response_str = String::from_utf8(output).unwrap();
        let response: LxResponse = serde_json::from_str(response_str.trim()).unwrap();
        assert!(!response.success);
        assert!(response.error.unwrap().contains("Parse error"));
    }

    #[test]
    fn handle_ipc_stream_handles_empty_lines() {
        let mut reader = BufReader::new(Cursor::new("\n\n"));
        let mut output = Vec::new();

        let result = handle_ipc_stream(&mut reader, &mut output, |_| LxResponse::ok(None));

        assert!(result.is_ok());
        assert!(output.is_empty()); // No response for empty lines
    }

    #[test]
    fn handle_ipc_stream_processes_multiple_messages() {
        let input = format!(
            "{}\n{}\n",
            r#"{"action":"notify","message":"msg1","terminal_id":"t1"}"#,
            r#"{"action":"notify","message":"msg2","terminal_id":"t1"}"#,
        );
        let mut reader = BufReader::new(Cursor::new(input));
        let mut output = Vec::new();

        let result = handle_ipc_stream(&mut reader, &mut output, |msg| match msg {
            LxMessage::Notify { message, .. } => LxResponse::ok(Some(message)),
            _ => LxResponse::err("unexpected".into()),
        });

        assert!(result.is_ok());
        let output_str = String::from_utf8(output).unwrap();
        let lines: Vec<&str> = output_str.trim().split('\n').collect();
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn sockets_are_per_process_and_dead_ones_are_swept() {
        let dir = tempfile::tempdir().unwrap();
        let path = socket_path_in(dir.path(), "4242");
        assert_eq!(path.file_name().unwrap(), "lx-4242.sock");

        // A socket file of a process that no longer exists is removed; a live
        // process's socket and unrelated files are kept.
        let dead = socket_path_in(dir.path(), "4294967294");
        std::fs::write(&dead, b"").unwrap();
        let live = socket_path_in(dir.path(), &std::process::id().to_string());
        std::fs::write(&live, b"").unwrap();
        let other = dir.path().join("settings.json");
        std::fs::write(&other, b"{}").unwrap();
        remove_dead_sockets(dir.path());
        assert!(!dead.exists());
        assert!(live.exists());
        assert!(other.exists());
    }

    #[test]
    fn the_ipc_server_answers_on_its_user_only_socket() {
        let dir = tempfile::tempdir().unwrap();
        let endpoint = start_ipc_server_in(
            dir.path(),
            "ipc-test",
            Arc::new(|_message: LxMessage| LxResponse::ok(Some("pong".into()))),
        )
        .unwrap();
        let (mut reader, mut writer) = crate::lx_endpoint::connect(&endpoint).unwrap();
        let message = LxMessage::GetCwd {
            terminal_id: "t1".into(),
        };
        let response = crate::cli::cli::send_message(&message, &mut reader, &mut writer).unwrap();
        assert_eq!(response.data.as_deref(), Some("pong"));
    }
}
