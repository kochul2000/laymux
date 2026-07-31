//! The `/usage` drive sequence, independent of any real PTY.
//!
//! Boot and query are expressed against [`ProbeTransport`] and [`Pacer`] so the
//! whole key-and-wait choreography is testable without spawning `claude`. The
//! real implementations live in `worker.rs`.

use std::time::Duration;

use super::parse::{parse_account_info, parse_usage, AccountInfo, ParsedUsage};

/// Keys written to the probe PTY.
mod keys {
    pub const ESCAPE: &[u8] = b"\x1b";
    pub const ENTER: &[u8] = b"\r";
    pub const TAB: &[u8] = b"\t";
    pub const RIGHT: &[u8] = b"\x1b[C";
    /// Trust prompt answer. Per `docs/claude-code-automation.md`, `y` plus CR
    /// clears the "trust this folder" gate; on a menu that ignores letters the
    /// CR still selects the default (yes) option.
    pub const TRUST_YES: &[u8] = b"y\r";
    pub const CLAUDE: &[u8] = b"claude\r";
    pub const USAGE_COMMAND: &[u8] = b"/usage";
}

/// Number of tab steps from the dialog's first tab to Usage.
const USAGE_TAB_STEPS: usize = 3;
/// In-query recapture attempts when the first parse fails. These only re-press
/// Tab; they never re-issue `/usage`, so they cost no extra server query.
const TAB_RETRIES: usize = 3;

/// What the probe writes to and reads a rendered screen from.
pub trait ProbeTransport {
    fn write(&self, bytes: &[u8]) -> Result<(), String>;
    fn screen_text(&self) -> String;
}

/// Time and cancellation. Lets tests advance a scripted screen instead of
/// sleeping, and lets shutdown cut a 60-second boot short.
pub trait Pacer {
    fn wait(&self, duration: Duration);
    /// True once the worker should abandon the sequence.
    fn cancelled(&self) -> bool;
}

/// Waits used by the drive sequence. Values follow what `ccu` established
/// against the real TUI; they are grouped here so they can be tuned in one
/// place and stubbed to zero in tests.
#[derive(Debug, Clone, Copy)]
pub struct ProbeTiming {
    /// Settle time after a single key press.
    pub key_settle: Duration,
    /// Time for the slash-command autocomplete popup to render.
    pub autocomplete: Duration,
    /// Time for the usage panel to fetch and render.
    pub usage_render: Duration,
    /// Time for a tab switch to render.
    pub tab_render: Duration,
    /// Interval between boot readiness polls.
    pub boot_poll: Duration,
    /// Total budget for `claude` to become ready.
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

/// Result of bringing `claude` up in the probe PTY.
#[derive(Debug, Clone, PartialEq)]
pub enum BootOutcome {
    Ready(AccountInfo),
    /// The shell reported that `claude` does not exist.
    ClaudeMissing,
    /// Ready state never appeared within the budget.
    Timeout,
    /// Cancelled before reaching a verdict (shutdown).
    Cancelled,
    /// Writing to the PTY failed.
    TransportFailed(String),
}

/// Result of one `/usage` round trip.
#[derive(Debug, Clone, PartialEq)]
pub struct QueryOutcome {
    pub parsed: ParsedUsage,
    /// Screen the parse was taken from, kept for diagnostics.
    pub screen: String,
}

/// Shell errors that mean `claude` is not installed or not on PATH.
const MISSING_MARKERS: [&str; 4] = [
    "command not found",
    "is not recognized as the name of a cmdlet",
    "not found in %path%",
    "no such file or directory",
];

/// Marker that means Claude Code finished booting.
///
/// The startup banner prints `Claude Code v<version>`. Matching that instead of
/// model names is deliberate: the model lineup changes (a probe keyed to
/// Opus/Sonnet/Haiku failed to recognize a `Fable 5` session), whereas the
/// product name in the banner is stable. It is also what laymux's own Claude
/// automation runbook polls for.
const READY_MARKER: &str = "claude code";

const TRUST_MARKER: &str = "trust";

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

    /// Type `claude`, clear the trust gate, and wait for the welcome screen.
    pub fn boot(&self) -> BootOutcome {
        if let Err(error) = self.transport.write(keys::CLAUDE) {
            return BootOutcome::TransportFailed(error);
        }

        let polls = poll_count(self.timing.boot_timeout, self.timing.boot_poll);
        let mut trust_handled = false;

        for _ in 0..polls {
            self.pacer.wait(self.timing.boot_poll);
            if self.pacer.cancelled() {
                return BootOutcome::Cancelled;
            }

            let screen = self.transport.screen_text();
            let lower = screen.to_ascii_lowercase();

            // Ready is checked before the missing-marker scan: once Claude Code
            // is up, its own output can legitimately contain phrases like "no
            // such file or directory".
            if lower.contains(READY_MARKER) {
                return BootOutcome::Ready(parse_account_info(&screen));
            }

            if MISSING_MARKERS.iter().any(|marker| lower.contains(marker)) {
                return BootOutcome::ClaudeMissing;
            }

            if !trust_handled && lower.contains(TRUST_MARKER) {
                if let Err(error) = self.transport.write(keys::TRUST_YES) {
                    return BootOutcome::TransportFailed(error);
                }
                trust_handled = true;
            }
        }

        BootOutcome::Timeout
    }

    /// Send `/usage`, navigate to the Usage tab, and parse the rendered panel.
    pub fn query(&self) -> Result<QueryOutcome, String> {
        // Close anything left open from a previous round before typing.
        self.press(keys::ESCAPE, self.timing.key_settle)?;

        // Enter is sent separately: the slash-command popup must render first,
        // otherwise the CR lands before `/usage` is selected.
        self.press(keys::USAGE_COMMAND, self.timing.autocomplete)?;
        self.press(keys::ENTER, self.timing.usage_render)?;

        for _ in 0..USAGE_TAB_STEPS {
            self.press(keys::RIGHT, self.timing.key_settle)?;
        }
        self.pacer.wait(self.timing.tab_render);

        let mut screen = self.transport.screen_text();
        let mut parsed = parse_usage(&screen);

        // The dialog's tab order is not a contract. If the panel we landed on
        // does not parse, step through the remaining tabs before giving up —
        // this recaptures without issuing another server query.
        for _ in 0..TAB_RETRIES {
            if parsed.is_success() || self.pacer.cancelled() {
                break;
            }
            self.press(keys::TAB, self.timing.tab_render)?;
            screen = self.transport.screen_text();
            parsed = parse_usage(&screen);
        }

        // Leave the TUI closed so the next round starts from a known state.
        self.press(keys::ESCAPE, self.timing.key_settle)?;
        self.press(keys::ESCAPE, self.timing.key_settle)?;

        Ok(QueryOutcome { parsed, screen })
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
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Decides the next screen from what was just written.
    type ScreenReaction = Box<dyn Fn(&[u8], &mut String) + Send + Sync>;

    /// Transport whose screen is advanced by a script keyed on what was written.
    struct ScriptedTransport {
        writes: Mutex<Vec<Vec<u8>>>,
        screen: Mutex<String>,
        react: ScreenReaction,
        fail_on: Option<Vec<u8>>,
    }

    impl ScriptedTransport {
        fn new(initial: &str, react: impl Fn(&[u8], &mut String) + Send + Sync + 'static) -> Self {
            Self {
                writes: Mutex::new(Vec::new()),
                screen: Mutex::new(initial.to_string()),
                react: Box::new(react),
                fail_on: None,
            }
        }

        fn failing(on: &[u8]) -> Self {
            Self {
                writes: Mutex::new(Vec::new()),
                screen: Mutex::new(String::new()),
                react: Box::new(|_, _| {}),
                fail_on: Some(on.to_vec()),
            }
        }

        fn written(&self) -> Vec<Vec<u8>> {
            self.writes.lock().unwrap().clone()
        }
    }

    impl ProbeTransport for ScriptedTransport {
        fn write(&self, bytes: &[u8]) -> Result<(), String> {
            if self.fail_on.as_deref() == Some(bytes) {
                return Err("pty gone".into());
            }
            self.writes.lock().unwrap().push(bytes.to_vec());
            let mut screen = self.screen.lock().unwrap();
            (self.react)(bytes, &mut screen);
            Ok(())
        }

        fn screen_text(&self) -> String {
            self.screen.lock().unwrap().clone()
        }
    }

    /// Pacer that never sleeps, counts waits, and can cancel after N waits.
    struct FakePacer {
        waits: Mutex<usize>,
        cancel_after: Option<usize>,
    }

    impl FakePacer {
        fn new() -> Self {
            Self {
                waits: Mutex::new(0),
                cancel_after: None,
            }
        }

        fn cancelling_after(waits: usize) -> Self {
            Self {
                waits: Mutex::new(0),
                cancel_after: Some(waits),
            }
        }
    }

    impl Pacer for FakePacer {
        fn wait(&self, _duration: Duration) {
            *self.waits.lock().unwrap() += 1;
        }

        fn cancelled(&self) -> bool {
            match self.cancel_after {
                Some(limit) => *self.waits.lock().unwrap() >= limit,
                None => false,
            }
        }
    }

    fn fast_timing() -> ProbeTiming {
        ProbeTiming {
            key_settle: Duration::ZERO,
            autocomplete: Duration::ZERO,
            usage_render: Duration::ZERO,
            tab_render: Duration::ZERO,
            boot_poll: Duration::from_millis(1),
            boot_timeout: Duration::from_millis(10),
        }
    }

    const USAGE_PANEL: &str = "\
 Current session
 30% used
 Resets 10pm (Asia/Seoul)
 Current week (all models)
 11% used
 Resets Mar 6, 11:59am (Asia/Seoul)
 Current week (Sonnet only)
 0% used
";

    #[test]
    fn boot_reports_ready_and_account_info() {
        let transport = ScriptedTransport::new("", |bytes, screen| {
            if bytes == keys::CLAUDE {
                *screen = " Claude Code v2.1.220\n Opus 4.6 · Claude Max\n".into();
            }
        });
        let pacer = FakePacer::new();
        let outcome = ProbeSession::new(&transport, &pacer, fast_timing()).boot();
        assert_eq!(
            outcome,
            BootOutcome::Ready(AccountInfo {
                model: Some("Opus 4.6".into()),
                plan: Some("Claude Max".into()),
            })
        );
    }

    /// Regression: readiness keyed to model names (Opus/Sonnet/Haiku) timed out
    /// against a real `Fable 5` session whose banner has no "Welcome" line.
    #[test]
    fn boot_recognizes_a_banner_with_no_welcome_line_and_an_unfamiliar_model() {
        let transport = ScriptedTransport::new("", |bytes, screen| {
            if bytes == keys::CLAUDE {
                *screen = " ▐▛███▜▌   Claude Code v2.1.220\n\
                            ▝▜█████▛▘  Fable 5 with xhigh effort · Claude Team\n"
                    .into();
            }
        });
        let pacer = FakePacer::new();
        let outcome = ProbeSession::new(&transport, &pacer, fast_timing()).boot();
        assert_eq!(
            outcome,
            BootOutcome::Ready(AccountInfo {
                model: Some("Fable 5".into()),
                plan: Some("Claude Team".into()),
            })
        );
    }

    #[test]
    fn boot_answers_the_trust_prompt_once() {
        let transport = ScriptedTransport::new("", |bytes, screen| {
            if bytes == keys::CLAUDE {
                *screen = " Do you trust the files in this folder?\n".into();
            } else if bytes == keys::TRUST_YES {
                *screen = " Welcome to Claude Code\n".into();
            }
        });
        let pacer = FakePacer::new();
        let outcome = ProbeSession::new(&transport, &pacer, fast_timing()).boot();
        assert!(matches!(outcome, BootOutcome::Ready(_)));
        let trust_presses = transport
            .written()
            .iter()
            .filter(|w| w.as_slice() == keys::TRUST_YES)
            .count();
        assert_eq!(trust_presses, 1);
    }

    #[test]
    fn boot_detects_missing_claude() {
        let transport = ScriptedTransport::new("", |_, screen| {
            *screen = "bash: claude: command not found\n".into();
        });
        let pacer = FakePacer::new();
        let outcome = ProbeSession::new(&transport, &pacer, fast_timing()).boot();
        assert_eq!(outcome, BootOutcome::ClaudeMissing);
    }

    #[test]
    fn ready_output_mentioning_a_missing_file_is_not_read_as_missing_claude() {
        // Claude Code's own output can contain shell-error phrasing. Ready must
        // win, otherwise a healthy session gets reported as uninstalled.
        let transport = ScriptedTransport::new("", |_, screen| {
            *screen =
                " Claude Code v2.1.220\n Opus 4.6 · Claude Max\n Error: no such file or directory\n"
                    .into();
        });
        let pacer = FakePacer::new();
        let outcome = ProbeSession::new(&transport, &pacer, fast_timing()).boot();
        assert!(matches!(outcome, BootOutcome::Ready(_)));
    }

    #[test]
    fn boot_times_out_on_a_silent_screen() {
        let transport = ScriptedTransport::new("", |_, _| {});
        let pacer = FakePacer::new();
        let outcome = ProbeSession::new(&transport, &pacer, fast_timing()).boot();
        assert_eq!(outcome, BootOutcome::Timeout);
    }

    #[test]
    fn boot_stops_on_cancellation() {
        let transport = ScriptedTransport::new("", |_, _| {});
        let pacer = FakePacer::cancelling_after(1);
        let outcome = ProbeSession::new(&transport, &pacer, fast_timing()).boot();
        assert_eq!(outcome, BootOutcome::Cancelled);
    }

    #[test]
    fn boot_surfaces_write_failure() {
        let transport = ScriptedTransport::failing(keys::CLAUDE);
        let pacer = FakePacer::new();
        let outcome = ProbeSession::new(&transport, &pacer, fast_timing()).boot();
        assert_eq!(outcome, BootOutcome::TransportFailed("pty gone".into()));
    }

    #[test]
    fn query_sends_usage_then_enter_separately() {
        let transport = ScriptedTransport::new("", |bytes, screen| {
            if bytes == keys::ENTER {
                *screen = USAGE_PANEL.into();
            }
        });
        let pacer = FakePacer::new();
        let outcome = ProbeSession::new(&transport, &pacer, fast_timing())
            .query()
            .unwrap();
        assert_eq!(outcome.parsed.session.percent, Some(30));

        let written = transport.written();
        let usage_at = written
            .iter()
            .position(|w| w.as_slice() == keys::USAGE_COMMAND)
            .expect("usage command written");
        assert_eq!(written[usage_at + 1].as_slice(), keys::ENTER);
    }

    #[test]
    fn query_walks_to_the_usage_tab_and_closes_the_dialog() {
        let transport = ScriptedTransport::new("", |bytes, screen| {
            if bytes == keys::ENTER {
                *screen = USAGE_PANEL.into();
            }
        });
        let pacer = FakePacer::new();
        ProbeSession::new(&transport, &pacer, fast_timing())
            .query()
            .unwrap();

        let written = transport.written();
        let rights = written
            .iter()
            .filter(|w| w.as_slice() == keys::RIGHT)
            .count();
        assert_eq!(rights, USAGE_TAB_STEPS);
        // Opening escape plus two closing escapes.
        let escapes = written
            .iter()
            .filter(|w| w.as_slice() == keys::ESCAPE)
            .count();
        assert_eq!(escapes, 3);
    }

    #[test]
    fn query_retries_with_tab_without_reissuing_usage() {
        // Land on a non-usage tab first; only the third Tab reveals the panel.
        let tabs_seen = Mutex::new(0usize);
        let transport = ScriptedTransport::new("", move |bytes, screen| {
            if bytes == keys::ENTER {
                *screen = " Settings\n nothing parseable here\n".into();
            }
            if bytes == keys::TAB {
                let mut seen = tabs_seen.lock().unwrap();
                *seen += 1;
                if *seen >= 3 {
                    *screen = USAGE_PANEL.into();
                }
            }
        });
        let pacer = FakePacer::new();
        let outcome = ProbeSession::new(&transport, &pacer, fast_timing())
            .query()
            .unwrap();
        assert_eq!(outcome.parsed.week_all.percent, Some(11));

        let written = transport.written();
        let usage_commands = written
            .iter()
            .filter(|w| w.as_slice() == keys::USAGE_COMMAND)
            .count();
        assert_eq!(usage_commands, 1, "retries must not cost another query");
    }

    #[test]
    fn query_gives_up_after_bounded_tab_retries() {
        let transport = ScriptedTransport::new("", |_, screen| {
            *screen = " nothing parseable\n".into();
        });
        let pacer = FakePacer::new();
        let outcome = ProbeSession::new(&transport, &pacer, fast_timing())
            .query()
            .unwrap();
        assert!(!outcome.parsed.is_success());
        let tabs = transport
            .written()
            .iter()
            .filter(|w| w.as_slice() == keys::TAB)
            .count();
        assert_eq!(tabs, TAB_RETRIES);
    }

    #[test]
    fn query_keeps_the_screen_it_parsed() {
        let transport = ScriptedTransport::new("", |bytes, screen| {
            if bytes == keys::ENTER {
                *screen = USAGE_PANEL.into();
            }
        });
        let pacer = FakePacer::new();
        let outcome = ProbeSession::new(&transport, &pacer, fast_timing())
            .query()
            .unwrap();
        assert!(outcome.screen.contains("Current week (all models)"));
    }

    #[test]
    fn query_propagates_write_failure() {
        let transport = ScriptedTransport::failing(keys::ESCAPE);
        let pacer = FakePacer::new();
        let error = ProbeSession::new(&transport, &pacer, fast_timing())
            .query()
            .unwrap_err();
        assert_eq!(error, "pty gone");
    }

    #[test]
    fn poll_count_never_returns_zero() {
        assert_eq!(poll_count(Duration::ZERO, Duration::from_secs(1)), 1);
        assert_eq!(poll_count(Duration::from_secs(1), Duration::ZERO), 1);
        assert_eq!(
            poll_count(Duration::from_secs(60), Duration::from_secs(1)),
            60
        );
    }
}
