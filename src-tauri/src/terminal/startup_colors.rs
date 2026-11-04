//! Initial-theme reply delegation for a validated native Codex launch (ADR-0375).
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::constants::CODEX_STARTUP_COLOR_WRITE_TIMEOUT_MS;
use crate::pty_control::PtyControlWorker;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartupColorReplies {
    pub foreground: String,
    pub background: String,
}

impl StartupColorReplies {
    pub(crate) fn validated(self) -> Option<Self> {
        fn valid(reply: &str, code: u8) -> bool {
            if reply.len() != 25 {
                return false;
            }
            let prefix = format!("\x1b]{code};rgb:");
            let Some(rgb) = reply
                .strip_prefix(&prefix)
                .and_then(|s| s.strip_suffix("\x1b\\"))
            else {
                return false;
            };
            let channels: Vec<_> = rgb.split('/').collect();
            channels.len() == 3
                && channels
                    .iter()
                    .all(|c| c.len() == 4 && c.bytes().all(|b| b.is_ascii_hexdigit()))
        }
        (valid(&self.foreground, 10) && valid(&self.background, 11)).then_some(self)
    }
}

pub(crate) struct StartupColorResponder {
    replies: StartupColorReplies,
    pending: u8,
    escape: bool,
    osc: Option<Vec<u8>>,
    overflow: bool,
}

impl StartupColorResponder {
    pub(crate) fn new(replies: StartupColorReplies) -> Self {
        Self {
            replies,
            pending: 3,
            escape: false,
            osc: None,
            overflow: false,
        }
    }

    /// Called by the native owner, before output reaches either GUI transport.
    pub(crate) fn respond(&mut self, data: &[u8], writer: &Arc<PtyControlWorker>) {
        let replies = self.observe(data);
        if replies.is_empty() {
            return;
        }
        let timeout = Duration::from_millis(CODEX_STARTUP_COLOR_WRITE_TIMEOUT_MS);
        let deadline = Instant::now() + timeout;
        match writer.submit_write(&replies, false, deadline) {
            Ok(job) => match job
                .result
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok(Ok(())) => tracing::debug!(
                    bytes = replies.len(),
                    "answered Codex startup colors in PTY owner"
                ),
                result => {
                    job.cancelled.store(true, Ordering::Release);
                    tracing::warn!(
                        ?result,
                        "Codex startup color write did not complete; not retrying"
                    );
                }
            },
            Err(error) => {
                tracing::warn!(%error, "Codex startup color write was rejected; not retrying")
            }
        }
    }

    fn observe(&mut self, data: &[u8]) -> Vec<u8> {
        let mut replies = Vec::new();
        if self.pending == 0 {
            return replies;
        }
        for &byte in data {
            if let Some(osc) = self.osc.as_mut() {
                if byte == 7 || (self.escape && byte == b'\\') {
                    let osc = self.osc.take().unwrap_or_default();
                    let st = self.escape && byte == b'\\';
                    self.escape = false;
                    if !self.overflow {
                        self.finish(&osc, st, &mut replies);
                    }
                    self.overflow = false;
                } else if byte == 0x1b {
                    self.escape = true;
                } else {
                    // Bound long titles; their payload is never a new query.
                    if osc.len() < 128 {
                        osc.push(byte);
                    } else {
                        self.overflow = true;
                        if osc.starts_with(b"10;") || osc.starts_with(b"11;") {
                            self.pending = 0;
                        }
                    }
                    self.escape = false;
                }
            } else if self.escape && byte == b']' {
                self.osc = Some(Vec::new());
                self.escape = false;
            } else {
                self.escape = byte == 0x1b;
            }
        }
        replies
    }

    fn finish(&mut self, osc: &[u8], st: bool, replies: &mut Vec<u8>) {
        match osc {
            b"10;?" if st && self.pending & 1 != 0 => {
                self.pending &= !1;
                replies.extend_from_slice(self.replies.foreground.as_bytes());
            }
            b"11;?" if st && self.pending & 2 != 0 => {
                self.pending &= !2;
                replies.extend_from_slice(self.replies.background.as_bytes());
            }
            b"10;?" | b"11;?" => {}
            // Shell changed/reset defaults after the snapshot: fail closed.
            b"110" | b"111" => self.pending = 0,
            value if value.starts_with(b"110;") || value.starts_with(b"111;") => self.pending = 0,
            value if value.starts_with(b"10;") || value.starts_with(b"11;") => self.pending = 0,
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn colors() -> StartupColorReplies {
        StartupColorReplies {
            foreground: "\x1b]10;rgb:1212/3434/abab\x1b\\".into(),
            background: "\x1b]11;rgb:fefe/fdfd/fcfc\x1b\\".into(),
        }
    }

    #[test]
    fn validates_both_slots_and_rejects_input_injection() {
        assert!(colors().validated().is_some());
        for invalid in [
            "text\r",
            "\x1b]10;rgb:ffff/ffff/ffff\x1b\\\r",
            "\x1b]11;rgb:ffff/ffff/ffff\x1b\\",
        ] {
            let mut value = colors();
            value.foreground = invalid.into();
            assert!(value.validated().is_none());
        }
    }

    #[test]
    fn split_queries_receive_theme_colors_once_without_a_renderer() {
        let colors = colors();
        let mut responder = StartupColorResponder::new(colors.clone());
        let mut actual = Vec::new();
        for byte in b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\" {
            actual.extend(responder.observe(&[*byte]));
        }
        assert_eq!(
            actual,
            [colors.foreground.as_bytes(), colors.background.as_bytes()].concat()
        );
        assert!(responder
            .observe(b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\")
            .is_empty());
    }

    #[test]
    fn setters_and_resets_invalidate_the_initial_snapshot() {
        for setter in [
            "\x1b]10;#ffffff\x1b\\",
            "\x1b]11;#ffffff\x07",
            "\x1b]110\x1b\\",
            "\x1b]111\x07",
            "\x1b]10;?;#ffffff\x1b\\",
        ] {
            let mut responder = StartupColorResponder::new(colors());
            responder.observe(setter.as_bytes());
            assert!(
                responder
                    .observe(b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\")
                    .is_empty(),
                "{setter:?}"
            );
        }
    }

    #[test]
    fn unrelated_osc_and_bel_queries_do_not_claim_startup_replies() {
        let mut responder = StartupColorResponder::new(colors());
        assert!(responder
            .observe(b"\x1b]2;hello\x07\x1b]10;?\x07")
            .is_empty());
        assert_eq!(
            responder.observe(b"\x1b]10;?\x1b\\"),
            colors().foreground.as_bytes()
        );
    }

    struct Recorder(Arc<std::sync::Mutex<Vec<u8>>>);
    impl std::io::Write for Recorder {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn native_owner_writes_snapshot_without_waiting_for_a_gui_responder() {
        let bytes = Arc::new(std::sync::Mutex::new(Vec::new()));
        let writer = PtyControlWorker::spawn(
            Box::new(Recorder(Arc::clone(&bytes))),
            Arc::new(std::sync::Mutex::new(None)),
        )
        .unwrap();
        let mut responder = StartupColorResponder::new(colors());
        responder.respond(b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\", &writer);
        assert_eq!(
            *bytes.lock().unwrap(),
            [
                colors().foreground.as_bytes(),
                colors().background.as_bytes()
            ]
            .concat()
        );
        responder.respond(b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\", &writer);
        assert_eq!(bytes.lock().unwrap().len(), 50, "no duplicate owner reply");
        writer.close();
    }

    #[test]
    fn a_busy_owner_drops_expired_startup_replies_instead_of_injecting_them_later() {
        use std::io::Write;
        use std::sync::{mpsc, Mutex};
        struct BusyWriter {
            recorder: Recorder,
            started: mpsc::Sender<()>,
            release: Option<mpsc::Receiver<()>>,
        }
        impl Write for BusyWriter {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                if let Some(release) = self.release.take() {
                    self.started.send(()).unwrap();
                    release.recv_timeout(Duration::from_secs(2)).unwrap();
                }
                self.recorder.write(data)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let writer = PtyControlWorker::spawn(
            Box::new(BusyWriter {
                recorder: Recorder(Arc::clone(&bytes)),
                started: started_tx,
                release: Some(release_rx),
            }),
            Arc::new(Mutex::new(None)),
        )
        .unwrap();
        let busy = writer
            .submit_write(b"busy", false, Instant::now() + Duration::from_secs(2))
            .unwrap();
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let mut responder = StartupColorResponder::new(colors());
        responder.respond(b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\", &writer);
        release_tx.send(()).unwrap();
        busy.result
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap();
        let done = writer
            .submit_write(b"done", false, Instant::now() + Duration::from_secs(1))
            .unwrap();
        done.result
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap();
        assert_eq!(
            *bytes.lock().unwrap(),
            b"busydone",
            "no stale color bytes after FIFO unblocks"
        );
        writer.close();
    }
}
