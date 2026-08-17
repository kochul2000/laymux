//! The Grok `/usage` drive sequence, independent of any real PTY.
//!
//! Boot and query are expressed against [`ProbeTransport`] and [`Pacer`] so the
//! key-and-wait choreography is testable without spawning `grok`. The real
//! implementations live in `worker.rs`.

use std::time::Duration;

use super::parse::{parse_grok_usage_screen, GrokUsageRow};

/// Keys written to the probe PTY.
pub mod keys {
    /// `--trust` skips the folder-trust gate that otherwise prints `Grok Build`
    /// inside "Do you trust the contents of this directory?" and is then
    /// mistaken for a ready welcome screen.
    pub const GROK: &[u8] = b"grok --trust\r";
    pub const ESCAPE: &[u8] = b"\x1b";
    pub const ENTER: &[u8] = b"\r";
    pub const TAB: &[u8] = b"\t";
    pub const RIGHT: &[u8] = b"\x1b[C";
    /// Trust prompt answer. Grok's copy is `Enter or y to trust` / `Yes, proceed`.
    pub const TRUST_YES: &[u8] = b"y\r";
    /// Slash command only — CR is sent after the autocomplete popup renders.
    pub const USAGE_COMMAND: &[u8] = b"/usage";
}

/// In-query recapture attempts when the first parse fails. These only re-press
/// Tab / Right; they never re-issue `/usage`, so they cost no extra server query.
const TAB_RETRIES: usize = 4;

/// Ready screens. Must not match the trust prompt, which also contains
/// `Grok Build may run or modify…`.
///
/// Current grok 4.6 session chrome no longer reprints `Grok Build`; it
/// shows a model footer and key hints instead. Treating that as a shell
/// types `grok --trust` into the live TUI and times out the probe.
const READY_MARKERS: [&str; 3] = ["grok build", "shift+tab:mode", "ctrl+x:shortcuts"];

const TRUST_MARKERS: [&str; 3] = [
    "do you trust the contents",
    "enter or y to trust",
    "yes, proceed",
];

/// Shell errors that mean `grok` is not installed or not on PATH.
const MISSING_MARKERS: [&str; 4] = [
    "command not found",
    "is not recognized as the name of a cmdlet",
    "not found in %path%",
    "no such file or directory",
];

/// What the probe writes to and reads a rendered screen from.
pub trait ProbeTransport {
    fn write(&self, bytes: &[u8]) -> Result<(), String>;
    fn screen_text(&self) -> String;
}

/// Time and cancellation. Lets tests advance a scripted screen instead of
/// sleeping, and lets shutdown cut a 60-second boot short.
pub trait Pacer {
    fn wait(&self, duration: Duration);
    fn cancelled(&self) -> bool;
}

/// Waits used by the drive sequence. Values follow the Claude probe, which
/// established them against a real slash-command TUI.
#[derive(Debug, Clone, Copy)]
pub struct ProbeTiming {
    pub key_settle: Duration,
    pub autocomplete: Duration,
    pub usage_render: Duration,
    pub tab_render: Duration,
    pub boot_poll: Duration,
    pub boot_timeout: Duration,
}

impl Default for ProbeTiming {
    fn default() -> Self {
        Self {
            key_settle: Duration::from_millis(300),
            autocomplete: Duration::from_millis(500),
            usage_render: Duration::from_secs(5),
            tab_render: Duration::from_millis(1500),
            boot_poll: Duration::from_secs(1),
            boot_timeout: Duration::from_secs(60),
        }
    }
}

/// Result of bringing `grok` up in the probe PTY.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootOutcome {
    Ready,
    GrokMissing,
    Timeout,
    Cancelled,
    TransportFailed(String),
}

/// Result of one `/usage` round trip.
#[derive(Debug, Clone, PartialEq)]
pub struct QueryOutcome {
    pub rows: Vec<GrokUsageRow>,
    pub screen: String,
}

pub struct ProbeSession<'a> {
    transport: &'a dyn ProbeTransport,
    pacer: &'a dyn Pacer,
    timing: ProbeTiming,
}

impl<'a> ProbeSession<'a> {
    pub fn new(
        transport: &'a dyn ProbeTransport,
        pacer: &'a dyn Pacer,
        timing: ProbeTiming,
    ) -> Self {
        Self {
            transport,
            pacer,
            timing,
        }
    }

    fn press(&self, keys: &[u8], settle: Duration) -> Result<(), String> {
        self.transport.write(keys)?;
        self.pacer.wait(settle);
        Ok(())
    }

    /// Type `grok --trust`, clear a leftover trust gate, and wait for welcome.
    pub fn boot(&self) -> BootOutcome {
        if let Err(error) = self.transport.write(keys::GROK) {
            return BootOutcome::TransportFailed(error);
        }
        self.wait_until_ready()
    }

    /// Relaunch only when the current screen is not a live Grok TUI.
    pub fn ensure_ready(&self) -> BootOutcome {
        if self.pacer.cancelled() {
            return BootOutcome::Cancelled;
        }
        let screen = self.transport.screen_text();
        if is_trust_prompt(&screen) {
            if let Err(error) = self.transport.write(keys::TRUST_YES) {
                return BootOutcome::TransportFailed(error);
            }
            // Do not type `grok --trust` into a TUI that is still leaving
            // the trust gate. Wait out the same ready budget as boot.
            return self.wait_until_ready();
        }
        if in_grok_tui(&screen) {
            return BootOutcome::Ready;
        }
        self.boot()
    }

    fn wait_until_ready(&self) -> BootOutcome {
        let polls = poll_count(self.timing.boot_timeout, self.timing.boot_poll);
        let mut trust_handled = false;

        for _ in 0..polls {
            self.pacer.wait(self.timing.boot_poll);
            if self.pacer.cancelled() {
                return BootOutcome::Cancelled;
            }

            let screen = self.transport.screen_text();

            // Ready is checked before the missing-marker scan: once Grok is up,
            // its own output can legitimately contain "no such file or directory".
            if is_ready_screen(&screen) {
                return BootOutcome::Ready;
            }

            if is_grok_missing(&screen) {
                return BootOutcome::GrokMissing;
            }

            if !trust_handled && is_trust_prompt(&screen) {
                if let Err(error) = self.transport.write(keys::TRUST_YES) {
                    return BootOutcome::TransportFailed(error);
                }
                trust_handled = true;
            }
        }

        BootOutcome::Timeout
    }

    /// Send `/usage`, wait for the modal, parse, and step tabs to collect rows.
    pub fn query(&self) -> Result<QueryOutcome, String> {
        match self.ensure_ready() {
            BootOutcome::Ready => {}
            BootOutcome::Cancelled => return Err("cancelled".into()),
            BootOutcome::GrokMissing => return Err("grok missing".into()),
            BootOutcome::Timeout => return Err("startup timeout".into()),
            BootOutcome::TransportFailed(message) => return Err(message),
        }

        // Close a leftover usage modal only. ESC on the welcome / trust screen
        // quits Grok (`No, quit`), after which `/usage` is typed into the shell.
        if usage_modal_visible(&self.transport.screen_text()) {
            self.press(keys::ESCAPE, self.timing.key_settle)?;
            match self.ensure_ready() {
                BootOutcome::Ready => {}
                BootOutcome::Cancelled => return Err("cancelled".into()),
                BootOutcome::GrokMissing => return Err("grok missing".into()),
                BootOutcome::Timeout => return Err("startup timeout".into()),
                BootOutcome::TransportFailed(message) => return Err(message),
            }
        }

        self.press(keys::USAGE_COMMAND, self.timing.autocomplete)?;
        self.press(keys::ENTER, self.timing.usage_render)?;

        let mut screen = self.transport.screen_text();
        let mut rows = parse_grok_usage_screen(&screen);
        let mut best_screen = screen.clone();

        // 1.0.1+ `/usage` is a tabbed modal: Context usage | Usage limit |
        // Session info. Account buckets live on Usage limit; more Rights land
        // on Session info and would replace the diagnostic capture.
        for _ in 0..TAB_RETRIES {
            if self.pacer.cancelled() {
                break;
            }
            if should_stop_tabbing(&screen, &rows) {
                break;
            }
            self.press(keys::RIGHT, self.timing.tab_render)?;
            screen = self.transport.screen_text();
            let extra = parse_grok_usage_screen(&screen);
            if extra.len() > rows.len() {
                best_screen = screen.clone();
            }
            merge_rows(&mut rows, extra);
        }
        if rows.is_empty() {
            for _ in 0..TAB_RETRIES {
                if self.pacer.cancelled() {
                    break;
                }
                self.press(keys::TAB, self.timing.tab_render)?;
                screen = self.transport.screen_text();
                let extra = parse_grok_usage_screen(&screen);
                if !extra.is_empty() {
                    best_screen = screen.clone();
                }
                merge_rows(&mut rows, extra);
            }
        } else if parse_grok_usage_screen(&best_screen).is_empty() && !rows.is_empty() {
            best_screen = screen;
        }

        // One ESC closes the modal. A second ESC on the welcome screen quits
        // Grok, and the next refresh then types `/usage` into the shell.
        self.press(keys::ESCAPE, self.timing.key_settle)?;

        Ok(QueryOutcome {
            rows,
            screen: best_screen,
        })
    }
}

pub fn is_trust_prompt(screen: &str) -> bool {
    let lower = screen.to_ascii_lowercase();
    TRUST_MARKERS.iter().any(|marker| lower.contains(marker))
}

pub fn is_ready_screen(screen: &str) -> bool {
    if is_trust_prompt(screen) {
        return false;
    }
    let lower = screen.to_ascii_lowercase();
    READY_MARKERS.iter().any(|marker| lower.contains(marker))
}

/// Welcome banner *or* a `/usage` modal. The 1.0.4 Usage limit tab does not
/// reprint `Grok Build`, so banner-only ready would treat it as a shell.
fn in_grok_tui(screen: &str) -> bool {
    is_ready_screen(screen) || is_usage_limit_modal(screen) || has_limit_labels(screen)
}

/// `Command 'usage' not found` is a leftover from a previous failed query.
/// Only a line that names `grok` and a missing-command marker is uninstalled.
fn is_grok_missing(screen: &str) -> bool {
    screen.lines().any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.contains("grok") && MISSING_MARKERS.iter().any(|marker| lower.contains(marker))
    })
}

fn has_limit_rows(rows: &[GrokUsageRow]) -> bool {
    rows.iter()
        .any(|row| matches!(row.key.as_str(), "weekly" | "credits" | "payg"))
}

fn has_limit_labels(screen: &str) -> bool {
    let lower = screen.to_ascii_lowercase();
    lower.contains("weekly limit")
        || lower.contains("monthly limit")
        || lower.contains("credits:")
        || lower.contains("pay as you go")
        || lower.contains("pay-as-you-go")
}

/// New `/usage` modal header. Weekly/credits/payg live on the Usage limit tab.
fn is_usage_limit_modal(screen: &str) -> bool {
    let lower = screen.to_ascii_lowercase();
    lower.contains("usage limit")
        && (lower.contains("context usage") || lower.contains("session info"))
}

fn should_stop_tabbing(screen: &str, rows: &[GrokUsageRow]) -> bool {
    // New modal: stop on Usage limit so we do not walk into Session info.
    // Old WEEKLY/MONTHLY strip: keep walking to merge sibling buckets.
    has_limit_rows(rows) && is_usage_limit_modal(screen)
}

fn usage_modal_visible(screen: &str) -> bool {
    !is_trust_prompt(screen) && (is_usage_limit_modal(screen) || has_limit_labels(screen))
}

fn merge_rows(into: &mut Vec<GrokUsageRow>, extra: Vec<GrokUsageRow>) {
    for row in extra {
        if !into.iter().any(|existing| existing.key == row.key) {
            into.push(row);
        }
    }
}

fn poll_count(timeout: Duration, interval: Duration) -> usize {
    if interval.is_zero() {
        return 1;
    }
    let count = timeout.as_millis() / interval.as_millis();
    (count as usize).max(1)
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
