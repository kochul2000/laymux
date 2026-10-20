//! Non-destructive release of one GUI proxy connection, never of its PTY.
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use super::transport::{self, Stream};
use crate::lock_ext::MutexExt;

#[derive(Default)]
pub(crate) struct ReconnectControl {
    pub(crate) preserve_on_drop: AtomicBool,
    stream: OnceLock<Stream>,
}

/// A lost Attached reply can advance only the daemon's epoch. Explicit close
/// may reacquire that exact, detached session, but never evicts another client.
pub(super) fn terminate_preserved_session(
    endpoint: &super::DaemonEndpoint,
    session_id: &str,
    epoch: &Mutex<Option<u64>>,
) -> io::Result<()> {
    use super::control::{connect_authenticated, request_terminate};
    use super::wire::{read_frame, write_control, ClientMessage, DaemonMessage, Frame};

    let previous = epoch
        .lock_or_err()
        .map_err(io::Error::other)?
        .ok_or_else(|| io::Error::other("PTY daemon close has no confirmed attach epoch"))?;
    let reply = request_terminate(endpoint, session_id, Some(previous))?;
    if !reply.superseded {
        return Ok(());
    }
    let (mut writer, mut reader) = connect_authenticated(endpoint)?;
    let timeout = Some(Duration::from_millis(
        crate::constants::PTY_DAEMON_HANDSHAKE_TIMEOUT_MS,
    ));
    writer.set_write_timeout(timeout)?;
    reader.get_ref().set_read_timeout(timeout)?;
    write_control(
        &mut writer,
        &ClientMessage::Attach {
            session_id: session_id.to_owned(),
            replay: false,
            take_over: false,
            size: None,
            missed_output: false,
        },
    )?;
    let claimed = match read_frame::<_, DaemonMessage>(&mut reader)? {
        Some(Frame::Control(DaemonMessage::Attached { attach_epoch, .. })) => attach_epoch,
        other => {
            return Err(io::Error::other(format!(
                "PTY daemon close could not reclaim its session: {other:?}"
            )))
        }
    };
    *epoch.lock_or_err().map_err(io::Error::other)? = Some(claimed);
    // A redraw may be larger than a socket buffer. Drain it while the separate
    // acknowledged terminate is running; keep the claim connection until ACK.
    let drain = std::thread::spawn(move || {
        while matches!(read_frame::<_, DaemonMessage>(&mut reader), Ok(Some(_))) {}
    });
    let terminated = request_terminate(endpoint, session_id, Some(claimed));
    transport::shutdown(&writer);
    let _ = drain.join();
    if terminated?.superseded {
        return Err(io::Error::other(
            "PTY daemon close was superseded after reclaim",
        ));
    }
    Ok(())
}

impl ReconnectControl {
    pub(super) fn bind(&self, stream: &Stream) -> std::io::Result<()> {
        self.stream
            .set(stream.try_clone()?)
            .map_err(|_| std::io::Error::other("PTY daemon reconnect control already bound"))
    }

    pub(crate) fn preserve(&self) {
        self.preserve_on_drop.store(true, Ordering::Release);
    }

    pub(crate) fn disconnect(&self) {
        self.preserve();
        if let Some(stream) = self.stream.get() {
            transport::shutdown(stream);
        }
    }
}

#[cfg(test)]
#[path = "reconnect_tests.rs"]
mod tests;
