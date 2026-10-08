use super::{SessionAttributionState, TerminalSessionAttribution};
use serde::{Deserialize, Deserializer};

// Keep the domain's static provider labels, but deserialize owned IPC data:
// borrowing a &'static str would require an impossible message lifetime.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireAttribution {
    generation: u64,
    state: SessionAttributionState,
    provider: Option<String>,
    session_id: Option<String>,
}

impl<'de> Deserialize<'de> for TerminalSessionAttribution {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = WireAttribution::deserialize(deserializer)?;
        let provider = match value.provider.as_deref() {
            None => None,
            Some("claude") => Some("claude"),
            Some("codex") => Some("codex"),
            Some("grok") => Some("grok"),
            Some(_) => {
                return Err(serde::de::Error::custom(
                    "unknown session attribution provider",
                ))
            }
        };
        if value.generation == 0 {
            return Err(serde::de::Error::custom(
                "session attribution generation unavailable",
            ));
        }
        Ok(Self {
            generation: value.generation,
            state: value.state,
            provider,
            session_id: value.session_id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_verdicts_roundtrip_without_borrowing_the_ipc_frame() {
        for provider in [None, Some("claude"), Some("codex"), Some("grok")] {
            let verdict = TerminalSessionAttribution {
                generation: 71,
                state: SessionAttributionState::Identified,
                provider,
                session_id: Some("verified-conversation".into()),
            };
            let decoded: TerminalSessionAttribution =
                serde_json::from_value(serde_json::to_value(&verdict).unwrap()).unwrap();
            assert_eq!(decoded, verdict);
        }
    }

    #[test]
    fn malformed_source_verdicts_are_not_treated_as_no_agent() {
        for value in [
            serde_json::json!({"generation":0,"state":"noAgent"}),
            serde_json::json!({"generation":7,"state":"identified","provider":"other"}),
            serde_json::json!({"generation":7,"state":"other"}),
        ] {
            assert!(serde_json::from_value::<TerminalSessionAttribution>(value).is_err());
        }
    }
}
