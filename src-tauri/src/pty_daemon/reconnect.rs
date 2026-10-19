//! Non-destructive release of one GUI proxy connection, never of its PTY.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use super::transport::{self, Stream};

#[derive(Default)]
pub(crate) struct ReconnectControl {
    pub(crate) preserve_on_drop: AtomicBool,
    stream: OnceLock<Stream>,
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
