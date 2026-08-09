use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::error::AppError;
use crate::lock_ext::MutexExt;

const OSC_10_QUERY: &[u8] = b"\x1b]10;?\x1b\\";
const OSC_11_QUERY: &[u8] = b"\x1b]11;?\x1b\\";
const PRIMARY_DA_QUERY: &[u8] = b"\x1b[c";
const XTERM_PRIMARY_DA_REPLY: &[u8] = b"\x1b[?1;2c";

pub(crate) const OSC_10_REPLY_BIT: u8 = 1 << 0;
pub(crate) const OSC_11_REPLY_BIT: u8 = 1 << 1;
const BOTH_COLOR_REPLY_BITS: u8 = OSC_10_REPLY_BIT | OSC_11_REPLY_BIT;

/// Generation-local, bounded authorization for xterm's reply to ConPTY's
/// startup Primary Device Attributes query.
///
/// The query commonly reaches the first desktop attach snapshot before the
/// visible xterm is attached. Generic replay replies remain suppressed, but
/// this guard proves that the current PTY generation actually emitted the
/// exact query recently before one exact pinned-xterm response may be written.
#[derive(Debug)]
pub(crate) struct TerminalBootstrapDaReplyGuard {
    active: AtomicBool,
    observation_failure_reported: AtomicBool,
    armed_at: Instant,
    state: Mutex<BootstrapDaProbeState>,
}

#[derive(Debug, Default)]
struct BootstrapDaProbeState {
    query_match: usize,
    observed_queries: u64,
    claimed_replies: u64,
    last_query_observed_at: Option<Instant>,
    bootstrap_claimed: bool,
}

impl TerminalBootstrapDaReplyGuard {
    pub(crate) fn armed() -> Self {
        Self::armed_at(Instant::now())
    }

    fn armed_at(armed_at: Instant) -> Self {
        Self {
            active: AtomicBool::new(true),
            observation_failure_reported: AtomicBool::new(false),
            armed_at,
            state: Mutex::new(BootstrapDaProbeState::default()),
        }
    }

    pub(crate) fn observe_output(&self, data: &[u8]) -> Result<(), AppError> {
        self.observe_output_at(data, Instant::now())
    }

    fn observe_output_at(&self, data: &[u8], now: Instant) -> Result<(), AppError> {
        if !self.active.load(Ordering::Acquire) {
            return Ok(());
        }
        if is_bootstrap_da_expired(self.armed_at, now) {
            self.active.store(false, Ordering::Release);
            return Ok(());
        }

        let mut state = self.state.lock_or_err()?;
        if !self.active.load(Ordering::Relaxed) {
            return Ok(());
        }
        for &byte in data {
            if advance_pattern(PRIMARY_DA_QUERY, &mut state.query_match, byte) {
                state.observed_queries = state.observed_queries.saturating_add(1);
                state.last_query_observed_at = Some(now);
            }
        }
        Ok(())
    }

    pub(crate) fn authorize_reply(&self, data: &[u8]) -> Result<bool, AppError> {
        self.authorize_reply_at(data, Instant::now())
    }

    fn authorize_reply_at(&self, data: &[u8], now: Instant) -> Result<bool, AppError> {
        if data != XTERM_PRIMARY_DA_REPLY || !self.active.load(Ordering::Acquire) {
            return Ok(false);
        }

        let mut state = self.state.lock_or_err()?;
        if !self.active.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let Some(query_observed_at) = state.last_query_observed_at else {
            return Ok(false);
        };
        let current = !is_bootstrap_da_expired(self.armed_at, now)
            && !is_bootstrap_da_expired(query_observed_at, now);
        if !current {
            self.active.store(false, Ordering::Release);
            return Ok(false);
        }
        if state.bootstrap_claimed || state.claimed_replies >= state.observed_queries {
            return Ok(false);
        }
        state.bootstrap_claimed = true;
        state.claimed_replies = state.claimed_replies.saturating_add(1);
        Ok(true)
    }

    /// Arbitrate an exact live reply against the bounded bootstrap exchange.
    /// The first reply candidate claims each observed query. Once replay has
    /// claimed the bootstrap query, live candidates without a newer query are
    /// duplicates and must not enter the PTY input stream.
    pub(crate) fn should_suppress_live_reply(&self, data: &[u8]) -> Result<bool, AppError> {
        self.should_suppress_live_reply_at(data, Instant::now())
    }

    fn should_suppress_live_reply_at(&self, data: &[u8], now: Instant) -> Result<bool, AppError> {
        if data != XTERM_PRIMARY_DA_REPLY || !self.active.load(Ordering::Acquire) {
            return Ok(false);
        }
        let mut state = self.state.lock_or_err()?;
        if !self.active.load(Ordering::Relaxed) {
            return Ok(false);
        }
        if is_bootstrap_da_expired(self.armed_at, now) {
            self.active.store(false, Ordering::Release);
            return Ok(false);
        }
        if state.claimed_replies < state.observed_queries {
            state.claimed_replies = state.claimed_replies.saturating_add(1);
            return Ok(false);
        }
        Ok(state.bootstrap_claimed)
    }

    pub(crate) fn should_report_observation_failure(&self) -> bool {
        !self
            .observation_failure_reported
            .swap(true, Ordering::Relaxed)
    }
}

fn is_bootstrap_da_expired(started: Instant, now: Instant) -> bool {
    now.checked_duration_since(started).is_none_or(|age| {
        age > Duration::from_millis(crate::constants::TERMINAL_BOOTSTRAP_DA_REPLY_MAX_AGE_MS)
    })
}

/// One-shot guard for the native Windows Codex startup color probe.
///
/// Codex owns console input for only 100 ms while probing. xterm may parse the
/// query later under frontend load, at which point its otherwise-correct reply
/// would be consumed by Codex's normal composer input loop. The guard observes
/// the exact query bytes in the authoritative PTY output stream and suppresses
/// each corresponding xterm RGB reply once. Codex then uses its Windows console
/// color fallback instead of receiving stale terminal input.
#[derive(Debug, Default)]
pub(crate) struct NativeWindowsCodexColorProbeGuard {
    active: AtomicBool,
    observation_failure_reported: AtomicBool,
    state: Mutex<ProbeState>,
}

#[derive(Debug, Default)]
struct ProbeState {
    awaiting_query_mask: u8,
    pending_reply_mask: u8,
    osc_10_match: usize,
    osc_11_match: usize,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct FilteredProtocolReply {
    pub(crate) bytes: Vec<u8>,
    pub(crate) suppressed_mask: u8,
}

impl NativeWindowsCodexColorProbeGuard {
    pub(crate) fn armed() -> Self {
        Self {
            active: AtomicBool::new(true),
            state: Mutex::new(ProbeState {
                awaiting_query_mask: BOTH_COLOR_REPLY_BITS,
                ..ProbeState::default()
            }),
            ..Self::default()
        }
    }

    pub(crate) fn observe_output(&self, data: &[u8]) -> Result<(), AppError> {
        if !self.active.load(Ordering::Acquire) {
            return Ok(());
        }

        let mut state = self.state.lock_or_err()?;
        if !self.active.load(Ordering::Relaxed) {
            return Ok(());
        }
        state.observe_output(data);
        Ok(())
    }

    pub(crate) fn filter_protocol_reply(
        &self,
        data: &[u8],
    ) -> Result<Option<FilteredProtocolReply>, AppError> {
        if !self.active.load(Ordering::Acquire) {
            return Ok(None);
        }

        let mut state = self.state.lock_or_err()?;
        if !self.active.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let filtered = state.filter_protocol_reply(data);
        if state.awaiting_query_mask | state.pending_reply_mask == 0 {
            self.active.store(false, Ordering::Release);
        }
        Ok(filtered)
    }

    pub(crate) fn should_report_observation_failure(&self) -> bool {
        !self
            .observation_failure_reported
            .swap(true, Ordering::Relaxed)
    }
}

impl ProbeState {
    fn observe_output(&mut self, data: &[u8]) {
        for &byte in data {
            if self.awaiting_query_mask & OSC_10_REPLY_BIT != 0
                && advance_pattern(OSC_10_QUERY, &mut self.osc_10_match, byte)
            {
                self.awaiting_query_mask &= !OSC_10_REPLY_BIT;
                self.pending_reply_mask |= OSC_10_REPLY_BIT;
            }
            if self.awaiting_query_mask & OSC_11_REPLY_BIT != 0
                && advance_pattern(OSC_11_QUERY, &mut self.osc_11_match, byte)
            {
                self.awaiting_query_mask &= !OSC_11_REPLY_BIT;
                self.pending_reply_mask |= OSC_11_REPLY_BIT;
            }
        }
    }

    fn filter_protocol_reply(&mut self, data: &[u8]) -> Option<FilteredProtocolReply> {
        if self.pending_reply_mask == 0 {
            return None;
        }

        let mut bytes = Vec::with_capacity(data.len());
        let mut copied_through = 0;
        let mut scan = 0;
        let mut suppressed_mask = 0;
        while scan < data.len() {
            let Some((reply_bit, end)) = parse_rgb_reply_at(data, scan) else {
                scan += 1;
                continue;
            };
            if self.pending_reply_mask & reply_bit == 0 {
                scan = end;
                continue;
            }

            bytes.extend_from_slice(&data[copied_through..scan]);
            copied_through = end;
            scan = end;
            self.pending_reply_mask &= !reply_bit;
            suppressed_mask |= reply_bit;
        }

        if suppressed_mask == 0 {
            return None;
        }
        bytes.extend_from_slice(&data[copied_through..]);
        Some(FilteredProtocolReply {
            bytes,
            suppressed_mask,
        })
    }
}

fn advance_pattern(pattern: &[u8], matched: &mut usize, byte: u8) -> bool {
    if byte == pattern[*matched] {
        *matched += 1;
        if *matched == pattern.len() {
            *matched = 0;
            return true;
        }
        return false;
    }
    *matched = usize::from(byte == pattern[0]);
    false
}

fn parse_rgb_reply_at(data: &[u8], start: usize) -> Option<(u8, usize)> {
    let tail = data.get(start..)?;
    let (reply_bit, payload_start) = if tail.starts_with(b"\x1b]10;rgb:") {
        (OSC_10_REPLY_BIT, start + b"\x1b]10;rgb:".len())
    } else if tail.starts_with(b"\x1b]11;rgb:") {
        (OSC_11_REPLY_BIT, start + b"\x1b]11;rgb:".len())
    } else {
        return None;
    };

    let mut cursor = payload_start;
    let (payload_end, sequence_end) = loop {
        match *data.get(cursor)? {
            0x07 => break (cursor, cursor + 1),
            0x1b if data.get(cursor + 1) == Some(&b'\\') => break (cursor, cursor + 2),
            0x1b => return None,
            _ => cursor += 1,
        }
    };
    valid_rgb_payload(&data[payload_start..payload_end]).then_some((reply_bit, sequence_end))
}

fn valid_rgb_payload(payload: &[u8]) -> bool {
    let mut components = payload.split(|byte| *byte == b'/');
    let valid_component = |component: &[u8]| {
        !component.is_empty() && component.len() <= 4 && component.iter().all(u8::is_ascii_hexdigit)
    };
    let Some(red) = components.next() else {
        return false;
    };
    let Some(green) = components.next() else {
        return false;
    };
    let Some(blue) = components.next() else {
        return false;
    };
    components.next().is_none()
        && valid_component(red)
        && valid_component(green)
        && valid_component(blue)
}

#[cfg(test)]
mod tests {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn reply_is_not_filtered_before_the_exact_query_is_observed() {
        let guard = NativeWindowsCodexColorProbeGuard::armed();
        assert!(guard
            .filter_protocol_reply(b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\")
            .unwrap()
            .is_none());
    }

    #[test]
    fn split_queries_arm_one_shot_filters_and_preserve_neighboring_input() {
        let guard = NativeWindowsCodexColorProbeGuard::armed();
        guard.observe_output(b"prefix\x1b]10;").unwrap();
        guard.observe_output(b"?\x1b\\middle\x1b]11;?\x1b").unwrap();
        guard.observe_output(b"\\suffix").unwrap();

        let replies = b"\x1b[I\x1b]10;rgb:f0f0/f0f0/f0f0\x1b\\\x1b]11;rgb:0c0c/0c0c/0c0c\x07tail";
        let filtered = guard.filter_protocol_reply(replies).unwrap().unwrap();
        assert_eq!(filtered.suppressed_mask, BOTH_COLOR_REPLY_BITS);
        assert_eq!(filtered.bytes, b"\x1b[Itail");

        assert!(guard.filter_protocol_reply(replies).unwrap().is_none());
    }

    #[test]
    fn each_reply_is_suppressed_only_after_its_own_query() {
        let guard = NativeWindowsCodexColorProbeGuard::armed();
        guard.observe_output(OSC_10_QUERY).unwrap();

        let foreground = guard
            .filter_protocol_reply(b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\")
            .unwrap()
            .unwrap();
        assert_eq!(foreground.suppressed_mask, OSC_10_REPLY_BIT);
        assert!(foreground.bytes.is_empty());
        assert!(guard
            .filter_protocol_reply(b"\x1b]11;rgb:0000/0000/0000\x1b\\")
            .unwrap()
            .is_none());

        guard.observe_output(OSC_11_QUERY).unwrap();
        let background = guard
            .filter_protocol_reply(b"\x1b]11;rgb:0000/0000/0000\x1b\\")
            .unwrap()
            .unwrap();
        assert_eq!(background.suppressed_mask, OSC_11_REPLY_BIT);
        assert!(background.bytes.is_empty());
    }

    #[test]
    fn malformed_or_non_rgb_osc_payloads_are_never_filtered() {
        let guard = NativeWindowsCodexColorProbeGuard::armed();
        guard.observe_output(OSC_10_QUERY).unwrap();
        for reply in [
            b"\x1b]10;?\x1b\\".as_slice(),
            b"\x1b]10;rgb:ffff/ffff\x1b\\".as_slice(),
            b"\x1b]10;rgb:ffff/xxxx/ffff\x1b\\".as_slice(),
            b"\x1b]12;rgb:ffff/ffff/ffff\x1b\\".as_slice(),
        ] {
            assert!(
                guard.filter_protocol_reply(reply).unwrap().is_none(),
                "{reply:?}"
            );
        }
    }

    #[test]
    fn poisoned_state_fails_closed_and_reports_observation_failure_once() {
        let guard = NativeWindowsCodexColorProbeGuard::armed();
        assert!(catch_unwind(AssertUnwindSafe(|| {
            let _state = guard.state.lock().unwrap();
            panic!("poison startup probe state");
        }))
        .is_err());

        assert!(guard.observe_output(OSC_10_QUERY).is_err());
        assert!(guard.should_report_observation_failure());
        assert!(!guard.should_report_observation_failure());
        assert!(guard
            .filter_protocol_reply(b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\")
            .is_err());
    }

    #[test]
    fn bootstrap_da_reply_requires_a_current_split_query_and_is_one_shot() {
        let started = Instant::now();
        let guard = TerminalBootstrapDaReplyGuard::armed_at(started);
        guard
            .observe_output_at(b"prefix\x1b[", started + Duration::from_millis(10))
            .unwrap();
        guard
            .observe_output_at(b"csuffix", started + Duration::from_millis(20))
            .unwrap();

        assert!(guard
            .authorize_reply_at(b"\x1b[?1;2c", started + Duration::from_millis(30),)
            .unwrap());
        assert!(!guard
            .authorize_reply_at(b"\x1b[?1;2c", started + Duration::from_millis(40),)
            .unwrap());
    }

    #[test]
    fn bootstrap_da_reply_rejects_unobserved_wrong_and_expired_data() {
        let started = Instant::now();
        let guard = TerminalBootstrapDaReplyGuard::armed_at(started);
        assert!(!guard
            .authorize_reply_at(b"\x1b[?1;2c", started + Duration::from_millis(10),)
            .unwrap());

        guard
            .observe_output_at(b"\x1b[c", started + Duration::from_millis(20))
            .unwrap();
        assert!(!guard
            .authorize_reply_at(b"\x1b[O", started + Duration::from_millis(30))
            .unwrap());
        assert!(!guard
            .authorize_reply_at(
                b"\x1b[?1;2c",
                started
                    + Duration::from_millis(
                        crate::constants::TERMINAL_BOOTSTRAP_DA_REPLY_MAX_AGE_MS + 21,
                    ),
            )
            .unwrap());
    }

    #[test]
    fn live_da_reply_claim_prevents_a_replay_duplicate() {
        let started = Instant::now();
        let guard = TerminalBootstrapDaReplyGuard::armed_at(started);
        guard.observe_output_at(b"\x1b[c", started).unwrap();

        assert!(!guard
            .should_suppress_live_reply_at(b"\x1b[?1;2c", started)
            .unwrap());
        assert!(!guard
            .authorize_reply_at(b"\x1b[?1;2c", started + Duration::from_millis(1))
            .unwrap());
    }

    #[test]
    fn bootstrap_da_reply_claim_suppresses_a_late_live_duplicate() {
        let started = Instant::now();
        let guard = TerminalBootstrapDaReplyGuard::armed_at(started);
        guard.observe_output_at(b"\x1b[c", started).unwrap();

        assert!(guard
            .authorize_reply_at(b"\x1b[?1;2c", started + Duration::from_millis(1))
            .unwrap());
        assert!(guard
            .should_suppress_live_reply_at(b"\x1b[?1;2c", started + Duration::from_millis(2),)
            .unwrap());
    }

    #[test]
    fn a_new_observed_query_keeps_its_live_reply_after_bootstrap_claimed_the_first() {
        let started = Instant::now();
        let guard = TerminalBootstrapDaReplyGuard::armed_at(started);
        guard.observe_output_at(b"\x1b[c", started).unwrap();
        assert!(guard
            .authorize_reply_at(b"\x1b[?1;2c", started + Duration::from_millis(1))
            .unwrap());

        guard
            .observe_output_at(b"\x1b[c", started + Duration::from_millis(2))
            .unwrap();
        assert!(!guard
            .should_suppress_live_reply_at(b"\x1b[?1;2c", started + Duration::from_millis(3),)
            .unwrap());
        assert!(guard
            .should_suppress_live_reply_at(b"\x1b[?1;2c", started + Duration::from_millis(4),)
            .unwrap());
    }
}
