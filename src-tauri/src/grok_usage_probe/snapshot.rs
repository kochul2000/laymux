//! Cached Grok `/usage` snapshot (ADR-0156).

use serde::Serialize;

use super::parse::GrokUsageRow;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GrokProbeStatus {
    Idle,
    Starting,
    Ready,
    GrokMissing,
    StartupTimeout,
    ParseFailed,
    Failed { message: String },
}

impl GrokProbeStatus {
    pub fn has_usable_data(&self) -> bool {
        matches!(self, GrokProbeStatus::Ready)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GrokUsageSnapshot {
    pub config_dir: String,
    pub status: GrokProbeStatus,
    pub rows: Vec<GrokUsageRow>,
    pub captured_at_ms: Option<u64>,
    pub next_query_at_ms: Option<u64>,
    pub raw_screen: Option<String>,
}

impl GrokUsageSnapshot {
    pub fn idle(config_dir: &str) -> Self {
        Self {
            config_dir: config_dir.to_string(),
            status: GrokProbeStatus::Idle,
            rows: Vec::new(),
            captured_at_ms: None,
            next_query_at_ms: None,
            raw_screen: None,
        }
    }
}
