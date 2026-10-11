//! Daemon side of the connection handshake: the first frame must prove the
//! instance token within one deadline for the whole exchange.

use std::io::{self, BufReader, Read};
use std::time::{Duration, Instant};

use super::discovery::{handshake_proof, tokens_match};
use super::session::ConnWriter;
use super::transport::Stream;
use super::wire::{read_frame_limited, ClientMessage, DaemonMessage, Frame, PROTOCOL_VERSION};
use crate::constants::{PTY_DAEMON_HANDSHAKE_TIMEOUT_MS, PTY_DAEMON_HELLO_MAX_BYTES};

/// Authenticate a fresh connection and answer the client's nonce. Returns
/// whether the connection may proceed.
pub(super) fn authenticate(
    expected_token: &str,
    reader: &mut BufReader<Stream>,
    writer: &ConnWriter,
) -> bool {
    let mut reader = HandshakeReader {
        inner: reader,
        deadline: Instant::now() + Duration::from_millis(PTY_DAEMON_HANDSHAKE_TIMEOUT_MS),
    };
    match read_frame_limited::<_, ClientMessage>(&mut reader, PTY_DAEMON_HELLO_MAX_BYTES) {
        Ok(Some(Frame::Control(ClientMessage::Hello {
            token,
            protocol_version,
            nonce,
        }))) => {
            if !tokens_match(&token, expected_token) {
                writer.error("PTY daemon authentication failed");
                return false;
            }
            if protocol_version != PROTOCOL_VERSION {
                writer.error(&format!(
                    "PTY daemon protocol {PROTOCOL_VERSION} cannot serve client protocol {protocol_version}"
                ));
                return false;
            }
            let Ok(proof) = handshake_proof(expected_token, &nonce) else {
                writer.error("PTY daemon could not prove its identity");
                return false;
            };
            writer
                .send(&DaemonMessage::HelloOk {
                    protocol_version: PROTOCOL_VERSION,
                    daemon_pid: std::process::id(),
                    proof,
                })
                .is_ok()
        }
        _ => {
            writer.error("PTY daemon handshake expected hello");
            false
        }
    }
}

/// Reads the handshake against one deadline for the whole exchange. A plain
/// socket read timeout restarts on every byte, so a client trickling its
/// hello could hold a connection slot indefinitely.
struct HandshakeReader<'a> {
    inner: &'a mut BufReader<Stream>,
    deadline: Instant,
}

impl Read for HandshakeReader<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "PTY daemon handshake deadline passed",
            ));
        }
        self.inner.get_ref().set_read_timeout(Some(remaining))?;
        self.inner.read(buf)
    }
}
