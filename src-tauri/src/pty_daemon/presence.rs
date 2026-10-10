//! GUI presence (ADR-0312): while this GUI runs, it holds one connection to
//! every daemon it uses. A daemon keeps its sessions only for a grace after
//! its last connection closes, so without this a GUI with no terminal open
//! on a daemon (a restored workspace not opened yet) would lose them.

use std::collections::HashSet;
use std::io::{self, BufReader, Read};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use super::control::connect_authenticated;
use super::transport::Stream;
use super::wire::{write_control, ClientMessage};
use super::DaemonEndpoint;
use crate::constants::{
    PTY_DAEMON_GRACE_DEFAULT_MINUTES, PTY_DAEMON_GRACE_MAX_MINUTES, PTY_DAEMON_GRACE_MIN_MINUTES,
    PTY_DAEMON_PRESENCE_POLL_MS,
};
use crate::lock_ext::MutexExt;

const MINUTE_MS: u64 = 60 * 1000;

static GRACE_MS: AtomicU64 = AtomicU64::new(PTY_DAEMON_GRACE_DEFAULT_MINUTES as u64 * MINUTE_MS);

/// Endpoints this GUI holds a presence connection to.
static HELD: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// `terminal.ptyDaemonGraceMinutes`, clamped to the range it allows. Every
/// presence connection reports a change to its daemon.
pub fn set_grace_minutes(minutes: u32) {
    let minutes = minutes.clamp(PTY_DAEMON_GRACE_MIN_MINUTES, PTY_DAEMON_GRACE_MAX_MINUTES);
    GRACE_MS.store(u64::from(minutes) * MINUTE_MS, Ordering::Release);
}

/// Hold a presence connection to this daemon for as long as it lives. A
/// daemon that predates presence closes the connection; the next terminal on
/// it asks again, which is harmless.
pub(super) fn keep(endpoint: &DaemonEndpoint) {
    let Ok(mut held) = HELD.lock_or_err() else {
        return;
    };
    if !held
        .get_or_insert_with(HashSet::new)
        .insert(endpoint.endpoint.clone())
    {
        return;
    }
    drop(held);
    let endpoint = endpoint.clone();
    thread::spawn(move || {
        if let Err(error) = hold(&endpoint) {
            tracing::debug!(%error, "PTY daemon presence ended");
        }
        if let Ok(mut held) = HELD.lock_or_err() {
            if let Some(held) = held.as_mut() {
                held.remove(&endpoint.endpoint);
            }
        }
    });
}

/// Report the grace, then wait for the daemon to close the connection,
/// reporting the grace again whenever it changes.
fn hold(endpoint: &DaemonEndpoint) -> io::Result<()> {
    let (mut writer, mut reader) = connect_authenticated(endpoint)?;
    let mut reported = GRACE_MS.load(Ordering::Acquire);
    write_control(&mut writer, &ClientMessage::Presence { grace_ms: reported })?;
    reader
        .get_ref()
        .set_read_timeout(Some(Duration::from_millis(PTY_DAEMON_PRESENCE_POLL_MS)))?;
    loop {
        if !still_open(&mut reader)? {
            return Ok(());
        }
        let grace = GRACE_MS.load(Ordering::Acquire);
        if grace != reported {
            write_control(&mut writer, &ClientMessage::Presence { grace_ms: grace })?;
            reported = grace;
        }
    }
}

/// The daemon never writes on a presence connection: a read only ends with
/// the connection, or times out while it is open.
fn still_open(reader: &mut BufReader<Stream>) -> io::Result<bool> {
    let mut byte = [0u8; 1];
    match reader.read(&mut byte) {
        Ok(0) => Ok(false),
        Ok(_) => Ok(true),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
            ) =>
        {
            Ok(true)
        }
        Err(error) => Err(error),
    }
}
