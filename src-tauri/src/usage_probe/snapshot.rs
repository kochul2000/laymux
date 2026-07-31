//! Raw usage snapshot types.
//!
//! Per [ADR-0102], the probe stores only raw values read off the `/usage`
//! screen. Reset times are carried as the verbatim strings Claude Code
//! printed — the probe never interprets them into a calendar instant, and it
//! never derives pace. Both are the frontend's job.

use serde::{Deserialize, Serialize};

/// One usage limit row: percentage used plus the raw "Resets ..." text.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimit {
    /// Percentage used, 0-100. `None` when the row was absent from the screen.
    pub percent: Option<u8>,
    /// Verbatim reset text, e.g. `7pm (Asia/Seoul)` or `Mar 6, 12pm (Asia/Seoul)`.
    /// Never parsed here.
    pub reset: Option<String>,
}

impl UsageLimit {
    pub fn is_empty(&self) -> bool {
        self.percent.is_none() && self.reset.is_none()
    }
}

/// Why a probe is not currently reporting usable numbers.
///
/// Kept as distinct variants rather than a single message so the view and the
/// Automation contract can react differently (retry vs. tell the user to
/// install `claude` vs. surface an upstream error).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProbeStatus {
    /// No worker exists for this config dir — nothing has been requested yet,
    /// or demand dropped to zero.
    Idle,
    /// Worker is booting `claude` and has not completed a `/usage` round trip.
    Starting,
    /// Last query parsed successfully. Numbers in the snapshot are usable.
    Ready,
    /// The `claude` executable could not be found on PATH.
    ClaudeMissing,
    /// `claude` was spawned but never reached a ready state in time.
    StartupTimeout,
    /// The `/usage` screen was captured but no rows could be parsed. Usually
    /// means the upstream TUI layout changed; `rawScreen` carries the capture.
    ParseFailed,
    /// The `/usage` screen itself reported an error (server side).
    UpstreamError { message: String },
    /// Probe machinery failed (PTY spawn, write, worker panic).
    Failed { message: String },
}

impl ProbeStatus {
    /// True when the snapshot's percentages are meaningful.
    pub fn has_usable_data(&self) -> bool {
        matches!(self, ProbeStatus::Ready)
    }
}

/// Full snapshot for one Claude config dir.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    /// The `CLAUDE_CONFIG_DIR` this snapshot describes. Empty string means the
    /// default config dir.
    pub config_dir: String,
    pub status: ProbeStatus,
    pub session: UsageLimit,
    pub week_all: UsageLimit,
    /// Per-model weekly row. Claude Code names it after the account's model
    /// (`Current week (Fable)`, `Current week (Sonnet only)`).
    pub week_model: UsageLimit,
    /// Label from that row's header, e.g. `Fable`. `None` when the panel showed
    /// no per-model row.
    pub week_model_label: Option<String>,
    /// Plan name from the welcome screen, e.g. `Claude Max`.
    pub plan: Option<String>,
    /// Model name from the welcome screen, e.g. `Opus 4.6`.
    pub model: Option<String>,
    /// Unix millis of the last successful capture. `None` before the first one.
    pub captured_at_ms: Option<u64>,
    /// Unix millis at which the worker may query again. Lets consumers show a
    /// countdown without knowing the interval policy.
    pub next_query_at_ms: Option<u64>,
    /// Last captured screen text, ANSI already stripped by the vt100 model.
    /// Diagnostics only — present so an upstream TUI change surfaces as
    /// inspectable evidence instead of a silent wrong number.
    pub raw_screen: Option<String>,
}

impl UsageSnapshot {
    /// Snapshot for a config dir that has no worker yet.
    pub fn idle(config_dir: impl Into<String>) -> Self {
        Self {
            config_dir: config_dir.into(),
            status: ProbeStatus::Idle,
            session: UsageLimit::default(),
            week_all: UsageLimit::default(),
            week_model: UsageLimit::default(),
            week_model_label: None,
            plan: None,
            model: None,
            captured_at_ms: None,
            next_query_at_ms: None,
            raw_screen: None,
        }
    }

    pub fn with_status(mut self, status: ProbeStatus) -> Self {
        self.status = status;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_snapshot_has_no_data() {
        let snap = UsageSnapshot::idle("");
        assert_eq!(snap.status, ProbeStatus::Idle);
        assert!(!snap.status.has_usable_data());
        assert!(snap.session.is_empty());
        assert!(snap.captured_at_ms.is_none());
    }

    #[test]
    fn status_serializes_as_tagged_camel_case() {
        let json = serde_json::to_string(&ProbeStatus::ClaudeMissing).unwrap();
        assert_eq!(json, r#"{"type":"claudeMissing"}"#);

        let json = serde_json::to_string(&ProbeStatus::UpstreamError {
            message: "boom".into(),
        })
        .unwrap();
        assert_eq!(json, r#"{"type":"upstreamError","message":"boom"}"#);
    }

    #[test]
    fn snapshot_reset_text_is_carried_verbatim() {
        // The probe must not normalize reset text — the frontend owns parsing.
        let mut snap = UsageSnapshot::idle("");
        snap.week_all.reset = Some("Mar 6, 12pm (Asia/Seoul)".into());
        let json = serde_json::to_value(&snap).unwrap();
        assert_eq!(json["weekAll"]["reset"], "Mar 6, 12pm (Asia/Seoul)");
    }

    #[test]
    fn only_ready_reports_usable_data() {
        assert!(ProbeStatus::Ready.has_usable_data());
        for status in [
            ProbeStatus::Idle,
            ProbeStatus::Starting,
            ProbeStatus::ParseFailed,
            ProbeStatus::StartupTimeout,
            ProbeStatus::ClaudeMissing,
        ] {
            assert!(!status.has_usable_data(), "{status:?} must not be usable");
        }
    }
}
