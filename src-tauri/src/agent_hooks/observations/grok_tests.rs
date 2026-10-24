use super::tests::event;
use super::*;

#[test]
fn grok_session_compaction_does_not_reuse_a_previous_model_turn() {
    for kind in ["PreCompact", "PostCompact"] {
        let mut registry = HookRegistry::default();
        registry.observe(event("grok", "UserPromptSubmit", 100, Some("old-turn")));
        registry.observe(event("grok", "Stop", 200, Some("old-turn")));
        registry.observe(event("grok", kind, 300, None));
        let compacting = registry.exact("grok", "session-a", None, 300).unwrap();
        assert_eq!(compacting.phase, Some(HookPhase::Running));
        assert_eq!(compacting.turn, None, "{kind}");
    }
}

#[test]
fn grok_completion_gate_rebinds_a_turn_after_automatic_compaction() {
    let mut registry = HookRegistry::default();
    registry.observe(event("grok", "UserPromptSubmit", 100, Some("active-turn")));
    registry.observe(event("grok", "PreCompact", 200, None));
    registry.observe(event("grok", "PostCompact", 300, None));
    registry.observe(event("grok", "Stop", 400, Some("active-turn")));
    let observed = registry.exact("grok", "session-a", None, 400).unwrap();
    assert_eq!(observed.phase, Some(HookPhase::Running));
    assert_eq!(observed.turn.as_deref(), Some("active-turn"));
}
