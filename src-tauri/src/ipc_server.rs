use std::io::{BufRead, BufReader, Write};
use std::sync::Arc;

use crate::cli::{LxMessage, LxResponse};

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

/// Generate a unique socket path for this IDE session.
pub fn socket_path(session_id: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        // Windows named pipe
        format!(r"\\.\pipe\lx-{session_id}")
    }

    #[cfg(not(target_os = "windows"))]
    {
        format!("/tmp/lx-{session_id}.sock")
    }
}

/// Start the IPC server in a background thread.
/// On Windows, uses a named pipe. On Linux, uses a Unix domain socket.
pub fn start_ipc_server<F>(
    #[allow(unused_variables)] session_id: String,
    handler: Arc<F>,
) -> Result<String, String>
where
    F: Fn(LxMessage) -> LxResponse + Send + Sync + 'static,
{
    #[cfg(not(target_os = "windows"))]
    let path = socket_path(&session_id);

    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::net::UnixListener;

        // Remove stale socket
        let _ = std::fs::remove_file(&path);

        let listener = UnixListener::bind(&path).map_err(|e| format!("Bind error: {e}"))?;

        let path_clone = path.clone();
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
            let _ = std::fs::remove_file(&path_clone);
        });
    }

    #[cfg(target_os = "windows")]
    {
        // On Windows, use a TCP listener on localhost as a simple IPC mechanism.
        // Named pipes require additional crate support; TCP localhost is simpler and works.
        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Bind error: {e}"))?;
        let local_addr = listener
            .local_addr()
            .map_err(|e| format!("Addr error: {e}"))?;
        let port = local_addr.port();
        let path = format!("127.0.0.1:{port}");

        let path_clone = path.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let handler = Arc::clone(&handler);
                        std::thread::spawn(move || {
                            let writer = match stream.try_clone() {
                                Ok(w) => w,
                                Err(e) => {
                                    eprintln!("IPC stream clone failed: {e}");
                                    return;
                                }
                            };
                            let mut reader = BufReader::new(&stream);
                            let mut writer = writer;
                            let _ = handle_ipc_stream(&mut reader, &mut writer, |msg| handler(msg));
                        });
                    }
                    Err(_) => break,
                }
            }
            drop(path_clone);
        });

        return Ok(path);
    }

    #[cfg(not(target_os = "windows"))]
    Ok(path)
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
    fn socket_path_is_valid() {
        let path = socket_path("test123");
        assert!(!path.is_empty());
        assert!(path.contains("test123") || path.contains("127.0.0.1"));
    }
}
