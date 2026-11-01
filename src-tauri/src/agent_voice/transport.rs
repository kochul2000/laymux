//! A local control socket, optionally carried over bounded WSL stdio.
use super::Target;
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::{self, Message, WebSocket};

trait Io: Read + Write + Send {}
impl<T: Read + Write + Send> Io for T {}

pub(super) struct Connection {
    socket: WebSocket<Box<dyn Io>>,
    serial: u64,
}
impl Connection {
    pub fn connect(target: &Target) -> Result<Self, String> {
        let stream: Box<dyn Io> = if let Some(distro) = &target.distro {
            #[cfg(windows)]
            {
                Box::new(Guest::connect(distro, &target.socket_path)?)
            }
            #[cfg(not(windows))]
            {
                let _ = distro;
                return Err("WSL relay is only available on Windows".into());
            }
        } else {
            let stream=crate::local_socket::Stream::connect(&target.socket_path).map_err(|e|format!("Cannot connect to this Codex daemon: {e}. Start Codex with its shared daemon."))?;
            stream
                .set_read_timeout(Some(Duration::from_millis(200)))
                .map_err(|e| e.to_string())?;
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .map_err(|e| e.to_string())?;
            Box::new(stream)
        };
        let mut config = tungstenite::protocol::WebSocketConfig::default();
        config.max_message_size = Some(512 * 1024);
        config.max_frame_size = Some(512 * 1024);
        let mut handshake =
            tungstenite::client::client_with_config("ws://localhost/", stream, Some(config));
        let deadline = Instant::now() + Duration::from_secs(5);
        let socket = loop {
            match handshake {
                Ok((socket, _)) => break socket,
                Err(tungstenite::HandshakeError::Interrupted(mid)) if Instant::now() < deadline => {
                    handshake = mid.handshake();
                }
                Err(error) => return Err(format!("Codex control handshake failed: {error}")),
            }
        };
        Ok(Self { socket, serial: 0 })
    }
    pub fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.send(json!({"method":method,"params":params}))
    }
    fn send(&mut self, value: Value) -> Result<(), String> {
        self.socket
            .send(Message::Text(value.to_string().into()))
            .map_err(|e| e.to_string())
    }
    pub fn request(
        &mut self,
        method: &str,
        params: Value,
        mut event: impl FnMut(Value),
    ) -> Result<Value, String> {
        self.serial += 1;
        let id = self.serial;
        self.send(json!({"id":id,"method":method,"params":params}))?;
        let deadline =
            Instant::now() + Duration::from_secs(if method.ends_with("/stop") { 2 } else { 20 });
        while Instant::now() < deadline {
            if let Some(message) = self.read()? {
                if message.get("id").and_then(Value::as_u64) == Some(id) {
                    if let Some(error) = message.get("error") {
                        return Err(error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Codex voice request failed")
                            .to_owned());
                    }
                    return Ok(message.get("result").cloned().unwrap_or(Value::Null));
                }
                event(message);
            }
        }
        Err(format!("Codex {method} timed out"))
    }
    pub fn read(&mut self) -> Result<Option<Value>, String> {
        match self.socket.read() {
            Ok(Message::Text(text)) => serde_json::from_str(&text)
                .map(Some)
                .map_err(|e| e.to_string()),
            Ok(Message::Close(_)) => Err("Codex voice connection closed".into()),
            Ok(_) => Ok(None),
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                Ok(None)
            }
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(windows)]
struct Guest {
    child: std::process::Child,
    input: std::process::ChildStdin,
    output: std::sync::mpsc::Receiver<Vec<u8>>,
    pending: std::io::Cursor<Vec<u8>>,
}
#[cfg(windows)]
impl Guest {
    fn connect(distro: &str, path: &std::path::Path) -> Result<Self, String> {
        use std::process::Stdio;
        let mut child = crate::process::headless_wsl_command()
            .args([
                "-d",
                distro,
                "--exec",
                "python3",
                "-u",
                "-c",
                include_str!("wsl_socket_relay.py"),
            ])
            .arg(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let input = child.stdin.take().ok_or("WSL relay stdin unavailable")?;
        let mut stdout = child.stdout.take().ok_or("WSL relay stdout unavailable")?;
        let (tx, output) = std::sync::mpsc::sync_channel(8);
        std::thread::Builder::new()
            .name("voice-wsl-relay".into())
            .spawn(move || {
                let mut buffer = [0u8; 8192];
                loop {
                    match stdout.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send(buffer[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            child,
            input,
            output,
            pending: std::io::Cursor::new(Vec::new()),
        })
    }
}
#[cfg(windows)]
impl Read for Guest {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.pending.read(buf)?;
        if n > 0 {
            return Ok(n);
        }
        match self.output.recv_timeout(Duration::from_millis(200)) {
            Ok(data) => {
                self.pending = std::io::Cursor::new(data);
                self.pending.read(buf)
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                Err(io::ErrorKind::WouldBlock.into())
            }
            Err(_) => Ok(0),
        }
    }
}
#[cfg(windows)]
impl Write for Guest {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.input.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.input.flush()
    }
}
#[cfg(windows)]
impl Drop for Guest {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
