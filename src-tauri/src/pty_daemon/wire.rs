//! Private GUI ↔ PTY daemon wire format (ADR-0300).
//!
//! Every frame is `u32 LE body length | u8 kind | payload`. Control frames
//! carry one JSON message; data frames carry raw PTY bytes so terminal output
//! never pays a JSON/base64 round trip. One frame is always written with a
//! single `write_all` under the connection's writer lock, so concurrent
//! writers never interleave partial frames.

use portable_pty::CommandBuilder;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{self, Read, Write};

use crate::constants::PTY_DAEMON_MAX_FRAME_BYTES;

/// Bumped on any incompatible message/semantics change. A daemon and client
/// with different versions refuse each other in the handshake.
pub const PROTOCOL_VERSION: u32 = 2;

const KIND_CONTROL: u8 = 0;
const KIND_DATA: u8 = 1;

/// Messages a client sends to the daemon.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientMessage {
    /// First frame on every connection.
    Hello {
        token: String,
        protocol_version: u32,
    },
    /// Create a session and bind this connection to it as the attached client.
    Spawn {
        session_id: String,
        /// GUI terminal (pane) identity; a later GUI adopts by this.
        terminal_id: String,
        rows: u16,
        cols: u16,
        command: WireCommand,
        /// Opaque GUI state the daemon stores and returns on attach, so an
        /// adopting GUI can rebuild what the running child still relies on.
        #[serde(default)]
        metadata: BTreeMap<String, String>,
    },
    /// Bind this connection to an existing session. With `replay`, output
    /// retained while detached is delivered first; without it the backlog is
    /// discarded. With `take_over` a currently attached client is replaced;
    /// without it (adoption) the attach is refused when the session is
    /// attached or being terminated, so two adopters never share one child.
    Attach {
        session_id: String,
        replay: bool,
        take_over: bool,
    },
    /// Describe live sessions. Valid on an unbound connection.
    List,
    /// Resize the bound session's PTY.
    Resize { rows: u16, cols: u16 },
    /// Terminate the bound session's child process tree.
    Terminate,
    /// Terminate a session by id from any connection. The GUI uses a fresh
    /// connection for this when its terminal connection is busy or broken,
    /// so ending work never waits behind a stuck input write.
    ///
    /// `attach_epoch` is the epoch the requester attached with. When the
    /// session was attached again since (adopted by a newer client), the
    /// stale request is refused so it cannot end the newer owner's work.
    TerminateSession {
        session_id: String,
        attach_epoch: Option<u64>,
    },
    /// Terminate every session, then exit the daemon. Used before an update
    /// replaces the executable the daemon runs from.
    Shutdown,
}

/// Messages the daemon sends to a client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DaemonMessage {
    HelloOk {
        protocol_version: u32,
        daemon_pid: u32,
    },
    Spawned {
        child_pid: Option<u32>,
        attach_epoch: u64,
    },
    Attached {
        child_pid: Option<u32>,
        attach_epoch: u64,
        /// Detached output that did not fit the backlog and was discarded.
        dropped_bytes: u64,
        metadata: BTreeMap<String, String>,
    },
    Sessions {
        sessions: Vec<SessionInfo>,
    },
    /// The session's PTY reader reached end of output. No data follows.
    Eof,
    /// The session's direct child exited.
    Exit {
        exit_code: u32,
    },
    /// Reply to `TerminateSession`. `found` is false when no such session
    /// exists any more, which also satisfies the request. `superseded` means
    /// a newer client owns the session now and it was left running.
    Terminating {
        found: bool,
        superseded: bool,
    },
    Error {
        message: String,
    },
}

/// The fully resolved child command. The GUI builds it exactly as for an
/// in-process PTY (argv, the complete environment, cwd) and the daemon spawns
/// it verbatim, so the daemon's own environment never leaks into a terminal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireCommand {
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: Option<String>,
}

impl WireCommand {
    /// Argv and cwd must be valid Unicode; environment entries that are not
    /// are skipped, matching what the PTY spawn itself can pass on.
    pub fn from_builder(command: &CommandBuilder) -> Result<Self, String> {
        let argv = command
            .get_argv()
            .iter()
            .map(|arg| {
                arg.to_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "PTY daemon command argument is not valid Unicode".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let cwd = command
            .get_cwd()
            .map(|cwd| {
                cwd.to_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "PTY daemon working directory is not valid Unicode".to_string())
            })
            .transpose()?;
        let env = command
            .iter_full_env_as_str()
            .map(|(key, value)| (key.to_owned(), value.to_owned()))
            .collect();
        Ok(Self { argv, env, cwd })
    }

    pub fn into_builder(self) -> Result<CommandBuilder, String> {
        if self.argv.is_empty() {
            return Err("PTY daemon command has no program".into());
        }
        let mut command =
            CommandBuilder::from_argv(self.argv.into_iter().map(Into::into).collect());
        command.env_clear();
        for (key, value) in self.env {
            command.env(key, value);
        }
        if let Some(cwd) = self.cwd {
            command.cwd(cwd);
        }
        Ok(command)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub terminal_id: String,
    /// Daemon-wide creation order; larger is newer.
    pub created_seq: u64,
    /// Current attach epoch, so a terminate for a listed session can be
    /// made conditional on nobody having attached since.
    pub attach_epoch: u64,
    pub metadata: BTreeMap<String, String>,
    pub child_pid: Option<u32>,
    pub attached: bool,
    pub exited: bool,
    /// A terminate was requested; the session is going away.
    pub terminating: bool,
}

#[derive(Debug)]
pub enum Frame<M> {
    Control(M),
    Data(Vec<u8>),
}

pub fn write_control<W: Write + ?Sized, M: Serialize>(
    writer: &mut W,
    message: &M,
) -> io::Result<()> {
    let json = serde_json::to_vec(message).map_err(io::Error::other)?;
    write_frame(writer, KIND_CONTROL, &json)
}

pub fn write_data<W: Write + ?Sized>(writer: &mut W, data: &[u8]) -> io::Result<()> {
    write_frame(writer, KIND_DATA, data)
}

fn write_frame<W: Write + ?Sized>(writer: &mut W, kind: u8, payload: &[u8]) -> io::Result<()> {
    let body_len = payload.len() + 1;
    if body_len > PTY_DAEMON_MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("PTY daemon frame of {body_len} bytes exceeds the protocol limit"),
        ));
    }
    let mut frame = Vec::with_capacity(4 + body_len);
    frame.extend_from_slice(&(body_len as u32).to_le_bytes());
    frame.push(kind);
    frame.extend_from_slice(payload);
    writer.write_all(&frame)?;
    writer.flush()
}

/// Read one frame. `Ok(None)` is a clean end of stream at a frame boundary;
/// a stream cut inside a frame is `UnexpectedEof`.
pub fn read_frame<R: Read + ?Sized, M: DeserializeOwned>(
    reader: &mut R,
) -> io::Result<Option<Frame<M>>> {
    read_frame_limited(reader, PTY_DAEMON_MAX_FRAME_BYTES)
}

/// [`read_frame`] with a tighter body limit, checked before allocating.
pub fn read_frame_limited<R: Read + ?Sized, M: DeserializeOwned>(
    reader: &mut R,
    max_body_bytes: usize,
) -> io::Result<Option<Frame<M>>> {
    let mut len = [0u8; 4];
    match reader.read_exact(&mut len) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let body_len = u32::from_le_bytes(len) as usize;
    if body_len == 0 || body_len > max_body_bytes.min(PTY_DAEMON_MAX_FRAME_BYTES) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid PTY daemon frame length {body_len}"),
        ));
    }
    let mut body = vec![0u8; body_len];
    reader.read_exact(&mut body)?;
    let payload = body.split_off(1);
    match body[0] {
        KIND_CONTROL => serde_json::from_slice(&payload)
            .map(|message| Some(Frame::Control(message)))
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error)),
        KIND_DATA => Ok(Some(Frame::Data(payload))),
        kind => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unknown PTY daemon frame kind {kind}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn control_and_data_frames_round_trip_in_order() {
        let mut buf = Vec::new();
        write_control(
            &mut buf,
            &DaemonMessage::Spawned {
                child_pid: Some(42),
                attach_epoch: 1,
            },
        )
        .unwrap();
        write_data(&mut buf, b"\x1b[31mhi\x00\xff").unwrap();
        write_control(&mut buf, &DaemonMessage::Exit { exit_code: 3 }).unwrap();

        let mut cursor = Cursor::new(buf);
        match read_frame::<_, DaemonMessage>(&mut cursor).unwrap() {
            Some(Frame::Control(DaemonMessage::Spawned { child_pid, .. })) => {
                assert_eq!(child_pid, Some(42))
            }
            other => panic!("unexpected {other:?}"),
        }
        match read_frame::<_, DaemonMessage>(&mut cursor).unwrap() {
            Some(Frame::Data(bytes)) => assert_eq!(bytes, b"\x1b[31mhi\x00\xff"),
            other => panic!("unexpected {other:?}"),
        }
        match read_frame::<_, DaemonMessage>(&mut cursor).unwrap() {
            Some(Frame::Control(DaemonMessage::Exit { exit_code })) => assert_eq!(exit_code, 3),
            other => panic!("unexpected {other:?}"),
        }
        assert!(read_frame::<_, DaemonMessage>(&mut cursor)
            .unwrap()
            .is_none());
    }

    #[test]
    fn spawn_carries_the_complete_command_including_env_and_cwd() {
        let mut command = CommandBuilder::new("shell-bin");
        command.arg("-c");
        command.arg("echo hi");
        command.env("LAYMUX_WIRE_TEST", "value");
        command.cwd("/tmp/somewhere");
        let mut buf = Vec::new();
        write_control(
            &mut buf,
            &ClientMessage::Spawn {
                session_id: "t:1".into(),
                terminal_id: "t".into(),
                metadata: BTreeMap::new(),
                rows: 24,
                cols: 80,
                command: WireCommand::from_builder(&command).unwrap(),
            },
        )
        .unwrap();
        match read_frame::<_, ClientMessage>(&mut Cursor::new(buf)).unwrap() {
            Some(Frame::Control(ClientMessage::Spawn {
                session_id,
                terminal_id: _,
                metadata: _,
                rows,
                cols,
                command,
            })) => {
                assert_eq!((session_id.as_str(), rows, cols), ("t:1", 24, 80));
                let command = command.into_builder().unwrap();
                assert_eq!(command.get_argv().len(), 3);
                // The base environment of the sender travels with the command.
                if let Some((key, value)) = std::env::vars().next() {
                    assert_eq!(
                        command.get_env(&key).and_then(|v| v.to_str()),
                        Some(value.as_str())
                    );
                }
                assert_eq!(
                    command.get_env("LAYMUX_WIRE_TEST").and_then(|v| v.to_str()),
                    Some("value")
                );
                assert_eq!(
                    command.get_cwd().and_then(|v| v.to_str()),
                    Some("/tmp/somewhere")
                );
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn truncated_and_oversized_frames_are_errors_not_messages() {
        let mut buf = Vec::new();
        write_data(&mut buf, b"abcdef").unwrap();
        buf.truncate(buf.len() - 2);
        let error = read_frame::<_, DaemonMessage>(&mut Cursor::new(buf)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);

        let oversized = ((PTY_DAEMON_MAX_FRAME_BYTES + 1) as u32).to_le_bytes();
        let error =
            read_frame::<_, DaemonMessage>(&mut Cursor::new(oversized.to_vec())).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);

        let too_big = vec![0u8; PTY_DAEMON_MAX_FRAME_BYTES];
        assert!(write_data(&mut Vec::new(), &too_big).is_err());
    }

    #[test]
    fn unknown_kind_and_malformed_json_are_rejected() {
        let error =
            read_frame::<_, DaemonMessage>(&mut Cursor::new(vec![2, 0, 0, 0, 9, 0])).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        let mut buf = Vec::new();
        write_frame(&mut buf, KIND_CONTROL, b"{not json").unwrap();
        let error = read_frame::<_, DaemonMessage>(&mut Cursor::new(buf)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
