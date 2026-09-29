use laymux_agent_hook::runtime::HookEvent;
use serde::Serialize;

/// No phase event is an indefinite heartbeat. Missing transitions fall back.
pub const MAX_OBSERVATION_AGE_MS: u64 = 60_000;
const MAX_CONVERSATIONS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HookPhase {
    Idle,
    Running,
    Waiting,
    Ended,
}
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HookResult {
    Failure,
    Interrupted,
}

#[derive(Clone, Debug)]
pub struct Observation {
    pub event: HookEvent,
    pub phase: Option<HookPhase>,
    pub result: Option<HookResult>,
    pub task: u64,
    pub sequence: u64,
    pub phase_at_ms: u64,
    turn: Option<String>,
}

#[derive(Default)]
pub struct HookRegistry {
    entries: Vec<Observation>,
    sequence: u64,
}

impl HookRegistry {
    /// Resolve a live TUI title against all retained candidates before applying
    /// phase expiry. An expired collision must not make a different ID unique.
    pub fn by_codex_title(
        &self,
        identity: &str,
        distro: Option<&str>,
        now: u64,
    ) -> Option<&Observation> {
        let mut candidates = self.entries.iter().filter(|entry| {
            entry.event.provider == "codex"
                && entry.event.distro.as_deref() == distro
                && entry.event.session_id.len() == 36
                && entry.event.session_id.starts_with(identity)
        });
        let candidate = candidates.next()?;
        if candidates.next().is_some() {
            return None;
        }
        self.exact("codex", &candidate.event.session_id, distro, now)
    }
    pub fn diagnostic_events(&self, now: u64) -> impl Iterator<Item = &HookEvent> {
        self.entries
            .iter()
            .filter(move |entry| {
                now.saturating_sub(entry.event.emitted_at_ms) <= MAX_OBSERVATION_AGE_MS * 5
            })
            .map(|entry| &entry.event)
    }
    pub fn observe(&mut self, event: HookEvent) {
        if event.agent_id.is_some() || event.config_dir.is_none() {
            return;
        }
        self.entries.retain(|e| {
            event.emitted_at_ms.saturating_sub(e.event.emitted_at_ms) <= MAX_OBSERVATION_AGE_MS * 5
        });
        let previous = self
            .entries
            .iter_mut()
            .find(|e| same_conversation(&e.event, &event));
        if let Some(previous) = previous {
            if event.emitted_at_ms < previous.event.emitted_at_ms {
                return;
            }
            if event.turn_id.is_some()
                && previous.turn.is_some()
                && event.turn_id != previous.turn
                && !matches!(
                    event.event.as_str(),
                    "UserPromptSubmit" | "SessionStart" | "SessionEnd"
                )
            {
                return;
            }
        }
        self.sequence = self.sequence.saturating_add(1);
        let index = if let Some(index) = self
            .entries
            .iter()
            .position(|e| same_conversation(&e.event, &event))
        {
            index
        } else {
            if self.entries.len() >= MAX_CONVERSATIONS {
                if let Some((index, _)) = self
                    .entries
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, e)| e.event.emitted_at_ms)
                {
                    self.entries.remove(index);
                }
            }
            self.entries.push(Observation {
                event: event.clone(),
                phase: None,
                result: None,
                task: 0,
                sequence: 0,
                phase_at_ms: 0,
                turn: None,
            });
            self.entries.len() - 1
        };
        let entry = &mut self.entries[index];
        let next = phase(&event);
        if event.event == "UserPromptSubmit"
            || (next == Some(HookPhase::Running) && entry.phase == Some(HookPhase::Ended))
        {
            entry.task = entry.task.saturating_add(1);
        }
        if event.event == "SessionEnd" {
            entry.phase = None;
        } else if let Some(next) = next {
            entry.phase = Some(next);
            entry.phase_at_ms = event.emitted_at_ms;
        }
        if next.is_some() || event.event == "SessionEnd" {
            entry.result = match event.event.as_str() {
                "Interrupt" => Some(HookResult::Interrupted),
                "StopFailure" => Some(HookResult::Failure),
                _ => None,
            };
        }
        if event.turn_id.is_some() {
            entry.turn = event.turn_id.clone();
        }
        entry.sequence = self.sequence;
        entry.event = event;
    }

    pub fn exact(
        &self,
        provider: &str,
        session_id: &str,
        distro: Option<&str>,
        now: u64,
    ) -> Option<&Observation> {
        let mut matches = self.entries.iter().filter(|e| {
            e.event.provider == provider
                && e.event.session_id == session_id
                && e.event.distro.as_deref() == distro
                && now.saturating_sub(e.phase_at_ms) <= MAX_OBSERVATION_AGE_MS
                && e.phase.is_some()
        });
        let first = matches.next()?;
        matches.next().is_none().then_some(first)
    }
}

fn same_conversation(a: &HookEvent, b: &HookEvent) -> bool {
    a.provider == b.provider
        && a.session_id == b.session_id
        && a.distro == b.distro
        && a.config_dir == b.config_dir
}
fn phase(event: &HookEvent) -> Option<HookPhase> {
    match event.event.as_str() {
        "SessionStart" if matches!(event.source.as_deref(), None | Some("startup" | "clear")) => {
            Some(HookPhase::Idle)
        }
        "SessionStart" if event.source.as_deref() == Some("compact") => Some(HookPhase::Running),
        "UserPromptSubmit" | "PreCompact" | "PostCompact" | "PostToolUse"
        | "PostToolUseFailure" | "ElicitationResult" => Some(HookPhase::Running),
        "PreToolUse" => Some(
            if matches!(
                event.tool_name.as_deref(),
                Some("AskUserQuestion" | "request_user_input")
            ) {
                HookPhase::Waiting
            } else {
                HookPhase::Running
            },
        ),
        "PermissionRequest" | "Elicitation" => Some(HookPhase::Waiting),
        "Stop" | "StopFailure" | "Interrupt" => Some(HookPhase::Ended),
        "Notification" => match event.notification_type.as_deref() {
            Some("permission_prompt" | "elicitation_dialog") => Some(HookPhase::Waiting),
            Some("idle_prompt") => Some(HookPhase::Idle),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn event(provider: &str, kind: &str, time: u64, turn: Option<&str>) -> HookEvent {
        let mut event = laymux_agent_hook::runtime::parse_event(
            provider,
            &json!({"session_id":"session-a", "hook_event_name":kind,"turn_id":turn}),
            "original-pane".into(),
            "old-token".into(),
        )
        .unwrap();
        event.emitted_at_ms = time;
        event.config_dir = Some("/tmp/agent".into());
        event
    }
    #[test]
    fn title_binding_resolves_full_identity_and_rejects_collisions_domains_expiry() {
        let full = "01a0ec06-451a-7e61-ac51-bd98fab4ed82";
        let prefix = &full[..29];
        for distro in [None, Some("Ubuntu-22.04")] {
            let mut registry = HookRegistry::default();
            let mut first = event("codex", "UserPromptSubmit", 100, None);
            first.session_id = full.into();
            first.distro = distro.map(str::to_owned);
            registry.observe(first.clone());
            assert_eq!(
                registry
                    .by_codex_title(prefix, distro, 101)
                    .unwrap()
                    .event
                    .session_id,
                full
            );
            assert!(registry
                .by_codex_title(prefix, Some("other-distro"), 101)
                .is_none());
            assert!(registry.by_codex_title(prefix, distro, 60_101).is_none());
            let mut other = first.clone();
            other.session_id = format!("{prefix}0000000");
            registry.observe(other);
            assert!(registry.by_codex_title(prefix, distro, 101).is_none());
            assert_eq!(
                registry
                    .by_codex_title(full, distro, 101)
                    .unwrap()
                    .event
                    .session_id,
                full
            );
            let mut other_root = first;
            other_root.config_dir = Some("/other/root".into());
            registry.observe(other_root);
            assert!(registry.by_codex_title(full, distro, 101).is_none());
        }
    }
    #[test]
    fn both_providers_keep_conversation_state_independent_of_original_pane() {
        for provider in ["claude", "codex"] {
            let mut registry = HookRegistry::default();
            registry.observe(event(provider, "UserPromptSubmit", 100, Some("turn-a")));
            let entry = registry.exact(provider, "session-a", None, 100).unwrap();
            assert_eq!(entry.phase, Some(HookPhase::Running));
            registry.observe(event(provider, "PermissionRequest", 101, Some("turn-a")));
            assert_eq!(
                registry
                    .exact(provider, "session-a", None, 101)
                    .unwrap()
                    .phase,
                Some(HookPhase::Waiting)
            );
            registry.observe(event(provider, "PostToolUse", 102, Some("turn-a")));
            registry.observe(event(provider, "Stop", 103, Some("turn-a")));
            assert_eq!(
                registry
                    .exact(provider, "session-a", None, 103)
                    .unwrap()
                    .phase,
                Some(HookPhase::Ended)
            );
            assert!(registry
                .exact(provider, "different-session", None, 103)
                .is_none());
            assert!(registry
                .exact(provider, "session-a", Some("Ubuntu"), 103)
                .is_none());
        }
    }
    #[test]
    fn old_turn_stop_compaction_and_subagent_do_not_finish_current_turn() {
        let mut registry = HookRegistry::default();
        registry.observe(event("codex", "UserPromptSubmit", 100, Some("old")));
        registry.observe(event("codex", "UserPromptSubmit", 101, Some("new")));
        registry.observe(event("codex", "Stop", 102, Some("old")));
        let mut compact = event("codex", "SessionStart", 103, None);
        compact.source = Some("compact".into());
        registry.observe(compact);
        let mut child = event("codex", "Stop", 104, Some("new"));
        child.agent_id = Some("child".into());
        registry.observe(child);
        assert_eq!(
            registry
                .exact("codex", "session-a", None, 104)
                .unwrap()
                .phase,
            Some(HookPhase::Running)
        );
        registry.observe(event("codex", "Interrupt", 105, Some("new")));
        assert_eq!(
            registry
                .exact("codex", "session-a", None, 105)
                .unwrap()
                .result,
            Some(HookResult::Interrupted)
        );
    }
    #[test]
    fn exit_expiry_duplicate_config_and_late_delivery_are_not_usable() {
        let mut registry = HookRegistry::default();
        registry.observe(event("claude", "UserPromptSubmit", 100, None));
        registry.observe(event("claude", "Stop", 99, None));
        assert_eq!(
            registry
                .exact("claude", "session-a", None, 100)
                .unwrap()
                .phase,
            Some(HookPhase::Running)
        );
        assert!(registry
            .exact("claude", "session-a", None, MAX_OBSERVATION_AGE_MS + 101)
            .is_none());
        let mut copy = event("claude", "Stop", 101, None);
        copy.config_dir = Some("/other".into());
        registry.observe(copy);
        assert!(registry.exact("claude", "session-a", None, 101).is_none());
        let mut registry = HookRegistry::default();
        registry.observe(event("claude", "SessionEnd", 102, None));
        assert!(registry.exact("claude", "session-a", None, 102).is_none());
    }

    #[test]
    fn unrelated_notification_does_not_renew_a_phase_or_clear_its_result() {
        let mut registry = HookRegistry::default();
        registry.observe(event("claude", "StopFailure", 100, None));
        let mut notification = event("claude", "Notification", 60_000, None);
        notification.notification_type = Some("auth_success".into());
        registry.observe(notification);
        let observation = registry.exact("claude", "session-a", None, 60_000).unwrap();
        assert_eq!(observation.phase_at_ms, 100);
        assert_eq!(observation.result, Some(HookResult::Failure));
        assert!(registry
            .exact("claude", "session-a", None, 60_101)
            .is_none());
        assert_eq!(registry.diagnostic_events(400_001).count(), 0);
    }
}
