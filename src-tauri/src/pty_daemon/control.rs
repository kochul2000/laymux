//! Short-lived and handshake parts of the GUI ↔ daemon protocol: opening an
//! authenticated connection, listing sessions and ending one by id. The
//! long-lived per-terminal connection lives in `client`.

use std::io::{self, BufReader};
use std::time::Duration;

use super::discovery::{generate_token, handshake_proof, tokens_match};
use super::transport::{self, Stream};
use super::wire::{
    read_frame, write_control, ClientMessage, DaemonMessage, Frame, SessionInfo, PROTOCOL_VERSION,
};
use super::DaemonEndpoint;
use crate::constants::{PTY_DAEMON_HANDSHAKE_TIMEOUT_MS, PTY_DAEMON_TERMINATE_REQUEST_TIMEOUT_MS};

/// Open an authenticated connection to the daemon.
pub(crate) fn connect_authenticated(
    endpoint: &DaemonEndpoint,
) -> io::Result<(Stream, BufReader<Stream>)> {
    connect_authenticated_within(
        endpoint,
        Duration::from_millis(PTY_DAEMON_HANDSHAKE_TIMEOUT_MS),
    )
}

fn connect_authenticated_within(
    endpoint: &DaemonEndpoint,
    timeout: Duration,
) -> io::Result<(Stream, BufReader<Stream>)> {
    let stream = transport::connect(&endpoint.endpoint)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let mut writer = stream.try_clone()?;
    let nonce = generate_token().map_err(io::Error::other)?;
    write_control(
        &mut writer,
        &ClientMessage::Hello {
            token: endpoint.token.clone(),
            protocol_version: PROTOCOL_VERSION,
            nonce: nonce.clone(),
        },
    )?;
    let mut reader = BufReader::new(stream);
    match read_frame::<_, DaemonMessage>(&mut reader)? {
        Some(Frame::Control(DaemonMessage::HelloOk {
            protocol_version,
            proof,
            ..
        })) if protocol_version == PROTOCOL_VERSION => {
            // Whoever answers must hold the token too; otherwise it is some
            // other program on a stale endpoint and gets nothing more.
            if !tokens_match(&proof, &handshake_proof(&endpoint.token, &nonce)?) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "PTY daemon endpoint failed to prove it holds the instance token",
                ));
            }
        }
        Some(Frame::Control(DaemonMessage::Error { message })) => {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, message))
        }
        other => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unexpected PTY daemon handshake reply: {other:?}"),
            ))
        }
    }
    reader.get_ref().set_read_timeout(None)?;
    writer.set_write_timeout(None)?;
    Ok((writer, reader))
}

/// List the daemon's sessions on a short-lived connection.
pub fn list_sessions(endpoint: &DaemonEndpoint) -> io::Result<Vec<SessionInfo>> {
    let (mut writer, mut reader) = connect_authenticated(endpoint)?;
    // A wedged daemon must not hang terminal creation, which lists first.
    reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_millis(PTY_DAEMON_HANDSHAKE_TIMEOUT_MS)))?;
    write_control(&mut writer, &ClientMessage::List)?;
    match read_frame::<_, DaemonMessage>(&mut reader)? {
        Some(Frame::Control(DaemonMessage::Sessions { sessions })) => Ok(sessions),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unexpected PTY daemon list reply: {other:?}"),
        )),
    }
}

/// Attach to `session_id`, terminate it and wait for its exit code. This is
/// the explicit way to end a session no GUI holds (for example after a GUI
/// crash); output replayed by the attach is discarded.
pub fn terminate_session(endpoint: &DaemonEndpoint, session_id: &str) -> io::Result<u32> {
    let (mut writer, mut reader) = connect_authenticated(endpoint)?;
    write_control(
        &mut writer,
        &ClientMessage::Attach {
            session_id: session_id.to_owned(),
            replay: false,
            take_over: true,
            size: None,
        },
    )?;
    let mut terminate_sent = false;
    loop {
        match read_frame::<_, DaemonMessage>(&mut reader)? {
            Some(Frame::Control(DaemonMessage::Attached { .. })) if !terminate_sent => {
                write_control(&mut writer, &ClientMessage::Terminate)?;
                terminate_sent = true;
            }
            Some(Frame::Control(DaemonMessage::Exit { exit_code })) => return Ok(exit_code),
            Some(Frame::Control(DaemonMessage::Error { message })) if !terminate_sent => {
                return Err(io::Error::new(io::ErrorKind::NotFound, message))
            }
            Some(_) => {}
            None => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "PTY daemon closed the connection before the session exited",
                ))
            }
        }
    }
}

/// The daemon's answer to a by-id terminate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TerminateReply {
    pub found: bool,
    /// A newer client attached after `attach_epoch`; the session runs on.
    pub superseded: bool,
}

pub(crate) fn terminate_by_id(
    endpoint: &DaemonEndpoint,
    session_id: &str,
    attach_epoch: Option<u64>,
) -> io::Result<()> {
    // An unknown session has already ended and a superseded one belongs
    // to its newer owner: either way nothing of the requester's is left.
    request_terminate(endpoint, session_id, attach_epoch).map(|_| ())
}

pub(crate) fn request_terminate(
    endpoint: &DaemonEndpoint,
    session_id: &str,
    attach_epoch: Option<u64>,
) -> io::Result<TerminateReply> {
    let timeout = Duration::from_millis(PTY_DAEMON_TERMINATE_REQUEST_TIMEOUT_MS);
    let (mut writer, mut reader) = connect_authenticated_within(endpoint, timeout)?;
    reader.get_ref().set_read_timeout(Some(timeout))?;
    write_control(
        &mut writer,
        &ClientMessage::TerminateSession {
            session_id: session_id.to_owned(),
            attach_epoch,
        },
    )?;
    match read_frame::<_, DaemonMessage>(&mut reader)? {
        Some(Frame::Control(DaemonMessage::Terminating { found, superseded })) => {
            Ok(TerminateReply { found, superseded })
        }
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unexpected PTY daemon terminate reply: {other:?}"),
        )),
    }
}
