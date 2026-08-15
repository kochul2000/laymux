use super::*;
use std::sync::Mutex;

type ScreenReaction = Box<dyn Fn(&[u8], &mut String) + Send + Sync>;

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

const WELCOME: &str = " Grok Build\n 1.0.4\n > \n";
const TRUST: &str = "\
Grok Build
Do you trust the contents of this directory?
Grok Build may run or modify contents in this directory, posing security risks.
y  Yes, proceed
n  No, quit
Enter or y to trust
";
const USAGE_PANEL: &str = "\
Grok Build
Weekly limit (SuperGrok)

███████████████░░░░░░░░░░░░░░░  50%
Resets: May 29, 00:00

Credits: $12.34
";

#[test]
fn trust_prompt_is_not_a_ready_screen() {
    assert!(is_trust_prompt(TRUST));
    assert!(!is_ready_screen(TRUST));
    assert!(is_ready_screen(WELCOME));
}

#[test]
fn boot_launches_grok_with_trust_flag() {
    let transport = ScriptedTransport::new("", |bytes, screen| {
        if bytes == keys::GROK {
            *screen = WELCOME.into();
        }
    });
    let pacer = FakePacer::new();
    let outcome = ProbeSession::new(&transport, &pacer, fast_timing()).boot();
    assert_eq!(outcome, BootOutcome::Ready);
    assert_eq!(transport.written()[0], keys::GROK);
}

#[test]
fn boot_does_not_treat_trust_prompt_as_ready() {
    let transport = ScriptedTransport::new("", |bytes, screen| {
        if bytes == keys::GROK {
            *screen = TRUST.into();
        } else if bytes == keys::TRUST_YES {
            *screen = WELCOME.into();
        }
    });
    let pacer = FakePacer::new();
    let outcome = ProbeSession::new(&transport, &pacer, fast_timing()).boot();
    assert_eq!(outcome, BootOutcome::Ready);
    let trust_presses = transport
        .written()
        .iter()
        .filter(|w| w.as_slice() == keys::TRUST_YES)
        .count();
    assert_eq!(trust_presses, 1);
}

#[test]
fn boot_detects_missing_grok() {
    let transport = ScriptedTransport::new("", |_, screen| {
        *screen = "bash: grok: command not found\n".into();
    });
    let pacer = FakePacer::new();
    let outcome = ProbeSession::new(&transport, &pacer, fast_timing()).boot();
    assert_eq!(outcome, BootOutcome::GrokMissing);
}

#[test]
fn leftover_shell_usage_miss_is_not_grok_missing() {
    // Live failure dump stays in the vt100 screen after we type `grok --trust`.
    // A substring scan for "command not found" would kill the worker as
    // GrokMissing before the banner can paint.
    let transport = ScriptedTransport::new(
        "Command 'usage' not found, did you mean:\n  command 'osage'\n$ usage\n",
        |_, _| {},
    );
    let pacer = FakePacer::new();
    let outcome = ProbeSession::new(&transport, &pacer, fast_timing()).boot();
    assert_eq!(outcome, BootOutcome::Timeout);
}

#[test]
fn ready_output_mentioning_a_missing_file_is_not_read_as_missing_grok() {
    let transport = ScriptedTransport::new("", |_, screen| {
        *screen = " Grok Build\n Error: no such file or directory\n".into();
    });
    let pacer = FakePacer::new();
    let outcome = ProbeSession::new(&transport, &pacer, fast_timing()).boot();
    assert_eq!(outcome, BootOutcome::Ready);
}

#[test]
fn boot_times_out_on_a_silent_screen() {
    let transport = ScriptedTransport::new("", |_, _| {});
    let pacer = FakePacer::new();
    let outcome = ProbeSession::new(&transport, &pacer, fast_timing()).boot();
    assert_eq!(outcome, BootOutcome::Timeout);
}

#[test]
fn query_does_not_escape_before_first_usage() {
    let transport = ScriptedTransport::new(WELCOME, |bytes, screen| {
        if bytes == keys::USAGE_COMMAND {
            *screen = " Grok Build\n /usage\n".into();
        } else if bytes == keys::ENTER {
            *screen = USAGE_PANEL.into();
        }
    });
    let pacer = FakePacer::new();
    let outcome = ProbeSession::new(&transport, &pacer, fast_timing())
        .query()
        .expect("query");
    assert!(
        !transport
            .written()
            .iter()
            .take_while(|w| w.as_slice() != keys::USAGE_COMMAND)
            .any(|w| w.as_slice() == keys::ESCAPE),
        "ESC before /usage quits Grok on the welcome/trust screen: {:?}",
        transport.written()
    );
    assert!(transport.written().contains(&keys::USAGE_COMMAND.to_vec()));
    assert!(transport.written().contains(&keys::ENTER.to_vec()));
    assert_eq!(outcome.rows[0].key, "weekly");
    assert_eq!(outcome.rows[0].percent, Some(50.0));
    assert_eq!(outcome.rows[1].key, "credits");
    assert_eq!(outcome.rows[1].remaining, Some(12.34));
}

#[test]
fn query_sends_usage_and_enter_separately() {
    let transport = ScriptedTransport::new(WELCOME, |bytes, screen| {
        if bytes == keys::ENTER {
            *screen = USAGE_PANEL.into();
        }
    });
    let pacer = FakePacer::new();
    ProbeSession::new(&transport, &pacer, fast_timing())
        .query()
        .expect("query");
    let writes = transport.written();
    let usage_at = writes
        .iter()
        .position(|w| w.as_slice() == keys::USAGE_COMMAND)
        .expect("/usage");
    let enter_at = writes
        .iter()
        .position(|w| w.as_slice() == keys::ENTER)
        .expect("enter");
    assert!(
        enter_at > usage_at,
        "CR must wait for slash autocomplete: {writes:?}"
    );
    assert!(
        !writes.iter().any(|w| w.as_slice() == b"/usage\r"),
        "combined /usage+CR lands before autocomplete selects the command"
    );
}

#[test]
fn query_relaunches_grok_after_escape_drops_to_the_shell() {
    let transport = ScriptedTransport::new(
        "Command 'usage' not found\nkochul@host:~/python_projects$ usage\n",
        |bytes, screen| {
            if bytes == keys::GROK {
                // Banner paints on top of the leftover dump; the miss stays.
                screen.push_str(WELCOME);
            } else if bytes == keys::ENTER {
                *screen = USAGE_PANEL.into();
            }
        },
    );
    let pacer = FakePacer::new();
    let outcome = ProbeSession::new(&transport, &pacer, fast_timing())
        .query()
        .expect("query");
    assert!(transport.written().contains(&keys::GROK.to_vec()));
    assert_eq!(outcome.rows[0].percent, Some(50.0));
}

#[test]
fn query_does_not_retype_grok_into_a_usage_modal_without_banner() {
    let modal = "\
Context usage  Usage limit  Session info
Weekly limit (SuperGrok)

███████████████░░░░░░░░░░░░░░░  66%
Resets: August 20, 16:13
";
    let transport = ScriptedTransport::new(modal, |bytes, screen| {
        if bytes == keys::GROK {
            panic!("must not type grok --trust into the leftover /usage modal");
        }
        if bytes == keys::ESCAPE {
            *screen = WELCOME.into();
        } else if bytes == keys::ENTER {
            *screen = modal.into();
        }
    });
    let pacer = FakePacer::new();
    let outcome = ProbeSession::new(&transport, &pacer, fast_timing())
        .query()
        .expect("query");
    assert!(!transport.written().contains(&keys::GROK.to_vec()));
    assert_eq!(outcome.rows[0].percent, Some(66.0));
}

#[test]
fn query_answers_a_leftover_trust_prompt_instead_of_escaping() {
    let transport = ScriptedTransport::new(TRUST, |bytes, screen| {
        if bytes == keys::TRUST_YES {
            *screen = WELCOME.into();
        } else if bytes == keys::ENTER {
            *screen = USAGE_PANEL.into();
        } else if bytes == keys::ESCAPE {
            *screen = "kochul@host:~$ \n".into();
        }
    });
    let pacer = FakePacer::new();
    let outcome = ProbeSession::new(&transport, &pacer, fast_timing())
        .query()
        .expect("query");
    assert!(transport.written().contains(&keys::TRUST_YES.to_vec()));
    assert!(
        !transport.written().contains(&keys::GROK.to_vec()),
        "answering trust must not retype grok --trust into the TUI"
    );
    let writes = transport.written();
    let first_non_trust = writes
        .iter()
        .find(|w| w.as_slice() != keys::TRUST_YES)
        .map(|w| w.as_slice());
    assert_ne!(first_non_trust, Some(keys::ESCAPE));
    assert_eq!(outcome.rows[0].key, "weekly");
}

#[test]
fn query_closes_the_modal_with_a_single_escape() {
    let transport = ScriptedTransport::new(WELCOME, |bytes, screen| {
        if bytes == keys::ENTER {
            *screen = USAGE_PANEL.into();
        }
    });
    let pacer = FakePacer::new();
    ProbeSession::new(&transport, &pacer, fast_timing())
        .query()
        .expect("query");
    let escapes = transport
        .written()
        .iter()
        .filter(|w| w.as_slice() == keys::ESCAPE)
        .count();
    assert_eq!(escapes, 1, "a second ESC quits Grok");
}

#[test]
fn query_stops_on_usage_limit_tab() {
    let transport = ScriptedTransport::new(WELCOME, |bytes, screen| {
        if bytes == keys::ENTER {
            *screen = "\
Grok Build
Context usage  Usage limit  Session info
Context: 5612 / 500000 tokens (1%)
"
            .into();
        } else if bytes == keys::RIGHT {
            *screen = "\
Grok Build
Context usage  Usage limit  Session info
Weekly limit (SuperGrok)

███████████████░░░░░░░░░░░░░░░  66%
Resets: August 20, 16:13
"
            .into();
        } else if bytes == keys::TAB {
            *screen = "\
Grok Build
Context usage  Usage limit  Session info
Session info
Shell version: 1.0.4
"
            .into();
        }
    });
    let pacer = FakePacer::new();
    let outcome = ProbeSession::new(&transport, &pacer, fast_timing())
        .query()
        .expect("query");
    let rights = transport
        .written()
        .iter()
        .filter(|w| w.as_slice() == keys::RIGHT)
        .count();
    assert_eq!(
        rights,
        1,
        "stop after landing on Usage limit: {:?}",
        transport.written()
    );
    assert!(
        outcome.screen.contains("Weekly limit"),
        "raw screen must stay on Usage limit, got:\n{}",
        outcome.screen
    );
    assert!(!outcome.screen.contains("Shell version"));
    assert_eq!(outcome.rows[0].percent, Some(66.0));
    assert_eq!(outcome.rows[0].reset.as_deref(), Some("August 20, 16:13"));
}

#[test]
fn query_merges_rows_from_later_tabs() {
    let transport = ScriptedTransport::new(WELCOME, |bytes, screen| {
        if bytes == keys::ENTER {
            *screen = USAGE_PANEL.into();
        } else if bytes == keys::RIGHT {
            *screen = "\
Grok Build
Monthly limit

░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  10%
Resets: Jun 1, 00:00
"
            .into();
        }
    });
    let pacer = FakePacer::new();
    let outcome = ProbeSession::new(&transport, &pacer, fast_timing())
        .query()
        .expect("query");
    let keys: Vec<&str> = outcome.rows.iter().map(|row| row.key.as_str()).collect();
    assert_eq!(keys, ["weekly", "credits", "monthly"]);
    assert_eq!(
        outcome
            .rows
            .iter()
            .find(|row| row.key == "monthly")
            .and_then(|row| row.percent),
        Some(10.0)
    );
}

#[test]
fn boot_reports_transport_failure() {
    let transport = ScriptedTransport::failing(keys::GROK);
    let pacer = FakePacer::new();
    let outcome = ProbeSession::new(&transport, &pacer, fast_timing()).boot();
    assert!(matches!(outcome, BootOutcome::TransportFailed(_)));
}

#[test]
fn boot_honours_cancellation() {
    let transport = ScriptedTransport::new("", |_, _| {});
    let pacer = FakePacer::cancelling_after(0);
    let outcome = ProbeSession::new(&transport, &pacer, fast_timing()).boot();
    assert_eq!(outcome, BootOutcome::Cancelled);
}
