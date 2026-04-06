//! OSC hook system — declarative matching of OSC events to IDE actions.
//!
//! Replaces the frontend's `osc-presets.ts` + `useOscHooks.ts` pipeline.
//! All 12 built-in presets are defined here as Rust constants.

use crate::osc::OscEvent;

// ── Condition model ──

/// Declarative condition for hook matching (replaces frontend JS `when` expressions).
#[derive(Debug, Clone, PartialEq)]
pub enum OscCondition {
    /// Always matches.
    Always,
    /// Matches when exit code equals the given value.
    ExitCodeEq(String),
    /// Matches when exit code does NOT equal the given value.
    ExitCodeNotEq(String),
    /// Matches when the command starts with any of the given prefixes.
    CommandStartsWith(Vec<String>),
    /// Matches when the command does NOT start with any of the given prefixes.
    CommandDoesNotStartWith(Vec<String>),
}

impl OscCondition {
    /// Evaluate this condition against an OSC event.
    pub fn evaluate(&self, event: &OscEvent) -> bool {
        match self {
            OscCondition::Always => true,
            OscCondition::ExitCodeEq(val) => {
                // OSC 133;D — data is the exit code
                event.code == 133 && event.param.as_deref() == Some("D") && event.data == *val
            }
            OscCondition::ExitCodeNotEq(val) => {
                event.code == 133 && event.param.as_deref() == Some("D") && event.data != *val
            }
            OscCondition::CommandStartsWith(prefixes) => {
                // OSC 133;E — data is the command text
                event.code == 133
                    && event.param.as_deref() == Some("E")
                    && prefixes.iter().any(|p| event.data.starts_with(p))
            }
            OscCondition::CommandDoesNotStartWith(prefixes) => {
                // OSC 133;E — matches only when command does NOT start with any prefix.
                event.code == 133
                    && event.param.as_deref() == Some("E")
                    && !prefixes.iter().any(|p| event.data.starts_with(p))
            }
        }
    }
}

// ── Action model ──

/// Which field to update for SetCommandStatus.
#[derive(Debug, Clone, PartialEq)]
pub enum CommandStatusField {
    /// Set the command text (from OSC 133;E data).
    Command,
    /// Set the exit code (from OSC 133;D data).
    ExitCode,
    /// Mark command start (preexec, from OSC 133;C).
    Preexec,
}

/// Action dispatched when a hook matches.
#[derive(Debug, Clone, PartialEq)]
pub enum OscAction {
    /// Sync CWD across terminal group.
    SyncCwd,
    /// Sync git branch across terminal group.
    SyncBranch,
    /// Send a notification.
    Notify { level: Option<String> },
    /// Set the tab title.
    SetTabTitle,
    /// Set WSL distro from OSC 9;9 path.
    SetWslDistro,
    /// Update command status (command text, exit code, or preexec marker).
    SetCommandStatus(CommandStatusField),
}

// ── Hook definition ──

/// Parameter matching mode for hooks.
#[derive(Debug, Clone, PartialEq)]
pub enum ParamMatch {
    /// Match any param (including None).
    Any,
    /// Match only when param is exactly this value.
    Exact(&'static str),
    /// Match only when param is None (no sub-parameter).
    NoneOnly,
}

/// A single OSC hook: when an OSC event matches, dispatch the action.
#[derive(Debug, Clone)]
pub struct OscHookDef {
    /// OSC code to match (7, 9, 133, 777, etc.)
    pub osc: u16,
    /// Parameter matching mode.
    pub param: ParamMatch,
    /// Condition that must be true for the hook to fire.
    pub when: OscCondition,
    /// Action to dispatch when matched.
    pub action: OscAction,
}

// ── Preset definitions (mirrors frontend osc-presets.ts) ──

/// All 12 built-in presets.
pub fn default_presets() -> Vec<OscHookDef> {
    vec![
        // sync-cwd: OSC 7 → lx sync-cwd
        OscHookDef {
            osc: 7,
            param: ParamMatch::Any,
            when: OscCondition::Always,
            action: OscAction::SyncCwd,
        },
        // set-wsl-distro: OSC 9 with sub-code "9" (ConEmu CWD)
        OscHookDef {
            osc: 9,
            param: ParamMatch::Exact("9"),
            when: OscCondition::Always,
            action: OscAction::SetWslDistro,
        },
        // sync-branch: OSC 133;E when command starts with git switch/checkout
        OscHookDef {
            osc: 133,
            param: ParamMatch::Exact("E"),
            when: OscCondition::CommandStartsWith(vec![
                "git switch".to_string(),
                "git checkout".to_string(),
            ]),
            action: OscAction::SyncBranch,
        },
        // notify-on-fail: OSC 133;D when exitCode !== "0"
        OscHookDef {
            osc: 133,
            param: ParamMatch::Exact("D"),
            when: OscCondition::ExitCodeNotEq("0".to_string()),
            action: OscAction::Notify {
                level: Some("error".to_string()),
            },
        },
        // notify-on-complete: OSC 133;D when exitCode === "0"
        OscHookDef {
            osc: 133,
            param: ParamMatch::Exact("D"),
            when: OscCondition::ExitCodeEq("0".to_string()),
            action: OscAction::Notify {
                level: Some("success".to_string()),
            },
        },
        // set-title-cwd (OSC 7): set tab title from CWD path
        OscHookDef {
            osc: 7,
            param: ParamMatch::Any,
            when: OscCondition::Always,
            action: OscAction::SetTabTitle,
        },
        // set-title-cwd (OSC 9;9): set tab title from ConEmu CWD
        OscHookDef {
            osc: 9,
            param: ParamMatch::Exact("9"),
            when: OscCondition::Always,
            action: OscAction::SetTabTitle,
        },
        // notify-osc9: regular OSC 9 notifications (exclude ConEmu CWD "9;")
        OscHookDef {
            osc: 9,
            param: ParamMatch::NoneOnly,
            when: OscCondition::Always,
            action: OscAction::Notify { level: None },
        },
        // notify-osc99
        OscHookDef {
            osc: 99,
            param: ParamMatch::Any,
            when: OscCondition::Always,
            action: OscAction::Notify { level: None },
        },
        // notify-osc777
        OscHookDef {
            osc: 777,
            param: ParamMatch::Any,
            when: OscCondition::Always,
            action: OscAction::Notify { level: None },
        },
        // track-command: OSC 133;E → set command text (skip propagated commands)
        OscHookDef {
            osc: 133,
            param: ParamMatch::Exact("E"),
            when: OscCondition::CommandDoesNotStartWith(vec![
                "LX_PROPAGATED=1 ".to_string(),
                "$env:LX_PROPAGATED".to_string(),
            ]),
            action: OscAction::SetCommandStatus(CommandStatusField::Command),
        },
        // track-command-result: OSC 133;D → set exit code
        OscHookDef {
            osc: 133,
            param: ParamMatch::Exact("D"),
            when: OscCondition::Always,
            action: OscAction::SetCommandStatus(CommandStatusField::ExitCode),
        },
        // track-command-start: OSC 133;C → mark preexec
        OscHookDef {
            osc: 133,
            param: ParamMatch::Exact("C"),
            when: OscCondition::Always,
            action: OscAction::SetCommandStatus(CommandStatusField::Preexec),
        },
    ]
}

/// Match an OSC event against a list of hooks, returning all matched hooks.
pub fn match_hooks<'a>(event: &OscEvent, hooks: &'a [OscHookDef]) -> Vec<&'a OscHookDef> {
    hooks
        .iter()
        .filter(|hook| {
            // Match OSC code
            if hook.osc != event.code {
                return false;
            }

            // Match param
            match &hook.param {
                ParamMatch::Any => {}
                ParamMatch::Exact(required) => match &event.param {
                    Some(event_param) if event_param == required => {}
                    _ => return false,
                },
                ParamMatch::NoneOnly => {
                    if event.param.is_some() {
                        return false;
                    }
                }
            }

            // Evaluate condition
            hook.when.evaluate(event)
        })
        .collect()
}

/// Check if an OSC event should arm the notify gate.
/// The gate is armed when a user command is observed (OSC 133;C preexec or 133;E command text).
pub fn should_arm_notify_gate(event: &OscEvent) -> bool {
    event.code == 133 && matches!(event.param.as_deref(), Some("C") | Some("E"))
}

/// Check if a hook action is a notification that should be gated.
pub fn is_notify_action(action: &OscAction) -> bool {
    matches!(action, OscAction::Notify { .. })
}

/// Extract the notification message from an OSC event payload.
/// OSC 777 format: "notify;title;body" → returns "title;body" (or full data).
/// OSC 9/99: returns data directly.
pub fn extract_notify_message(event: &OscEvent) -> String {
    if event.code == 777 {
        // Strip "notify;" prefix if present
        if let Some(rest) = event.data.strip_prefix("notify;") {
            return rest.to_string();
        }
    }
    event.data.clone()
}

/// Extract git branch from a git switch/checkout command.
/// e.g., "git switch main" → "main", "git checkout -b feature" → "feature"
/// Ignores file paths after `--` (e.g., "git checkout -- file.txt" → None).
pub fn extract_branch_from_command(command: &str) -> Option<String> {
    let parts: Vec<&str> = command.split_whitespace().collect();
    // "git checkout -- file.txt" is a file restore, not a branch switch
    if parts.contains(&"--") {
        return None;
    }
    parts.last().map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::osc::OscEvent;

    fn make_event(code: u16, param: Option<&str>, data: &str) -> OscEvent {
        OscEvent {
            code,
            param: param.map(|s| s.to_string()),
            data: data.to_string(),
        }
    }

    // ── OscCondition tests ──

    #[test]
    fn condition_always() {
        let event = make_event(7, None, "/home/user");
        assert!(OscCondition::Always.evaluate(&event));
    }

    #[test]
    fn condition_exit_code_eq() {
        let event = make_event(133, Some("D"), "0");
        assert!(OscCondition::ExitCodeEq("0".into()).evaluate(&event));
        assert!(!OscCondition::ExitCodeEq("1".into()).evaluate(&event));
    }

    #[test]
    fn condition_exit_code_not_eq() {
        let event = make_event(133, Some("D"), "1");
        assert!(OscCondition::ExitCodeNotEq("0".into()).evaluate(&event));

        let success = make_event(133, Some("D"), "0");
        assert!(!OscCondition::ExitCodeNotEq("0".into()).evaluate(&success));
    }

    #[test]
    fn condition_command_starts_with() {
        let event = make_event(133, Some("E"), "git switch main");
        let cond =
            OscCondition::CommandStartsWith(vec!["git switch".into(), "git checkout".into()]);
        assert!(cond.evaluate(&event));

        let checkout = make_event(133, Some("E"), "git checkout -b feature");
        assert!(cond.evaluate(&checkout));

        let other = make_event(133, Some("E"), "cargo build");
        assert!(!cond.evaluate(&other));
    }

    #[test]
    fn condition_command_does_not_start_with() {
        let cond = OscCondition::CommandDoesNotStartWith(vec![
            "LX_PROPAGATED=1 ".into(),
            "$env:LX_PROPAGATED".into(),
        ]);

        // Normal command → matches
        let normal = make_event(133, Some("E"), "cargo build");
        assert!(cond.evaluate(&normal));

        // Propagated bash command → does NOT match
        let propagated_bash = make_event(133, Some("E"), "LX_PROPAGATED=1 cd /home/user");
        assert!(!cond.evaluate(&propagated_bash));

        // Propagated PowerShell command → does NOT match
        let propagated_ps = make_event(133, Some("E"), "$env:LX_PROPAGATED='1';cd C:\\Users");
        assert!(!cond.evaluate(&propagated_ps));

        // Wrong OSC code → does NOT match (condition requires 133;E)
        let wrong_osc = make_event(7, None, "cargo build");
        assert!(!cond.evaluate(&wrong_osc));
    }

    #[test]
    fn track_command_skips_propagated() {
        let presets = default_presets();

        // Normal command → track-command fires
        let normal = make_event(133, Some("E"), "npm test");
        let matched = match_hooks(&normal, &presets);
        let actions: Vec<_> = matched.iter().map(|h| &h.action).collect();
        assert!(actions.contains(&&OscAction::SetCommandStatus(CommandStatusField::Command)));

        // Propagated bash cd → track-command does NOT fire
        let propagated = make_event(133, Some("E"), "LX_PROPAGATED=1 cd /foo");
        let matched = match_hooks(&propagated, &presets);
        let actions: Vec<_> = matched.iter().map(|h| &h.action).collect();
        assert!(!actions.contains(&&OscAction::SetCommandStatus(CommandStatusField::Command)));

        // Propagated PowerShell cd → track-command does NOT fire
        let propagated_ps = make_event(133, Some("E"), "$env:LX_PROPAGATED='1';cd C:\\foo");
        let matched = match_hooks(&propagated_ps, &presets);
        let actions: Vec<_> = matched.iter().map(|h| &h.action).collect();
        assert!(!actions.contains(&&OscAction::SetCommandStatus(CommandStatusField::Command)));
    }

    #[test]
    fn condition_exit_code_wrong_osc_code() {
        // ExitCodeEq only works for OSC 133;D
        let event = make_event(7, None, "0");
        assert!(!OscCondition::ExitCodeEq("0".into()).evaluate(&event));
    }

    // ── match_hooks tests ──

    #[test]
    fn match_sync_cwd_preset() {
        let presets = default_presets();
        let event = make_event(7, None, "file://localhost/home/user");
        let matched = match_hooks(&event, &presets);
        let actions: Vec<_> = matched.iter().map(|h| &h.action).collect();
        assert!(actions.contains(&&OscAction::SyncCwd));
        assert!(actions.contains(&&OscAction::SetTabTitle));
    }

    #[test]
    fn match_osc9_subcode_9() {
        let presets = default_presets();
        let event = make_event(9, Some("9"), "C:\\Users\\test");
        let matched = match_hooks(&event, &presets);
        let actions: Vec<_> = matched.iter().map(|h| &h.action).collect();
        assert!(actions.contains(&&OscAction::SetWslDistro));
        assert!(actions.contains(&&OscAction::SetTabTitle));
        // Should NOT match the notify-osc9 hook (which requires param=None)
        assert!(!actions.contains(&&OscAction::Notify { level: None }));
    }

    #[test]
    fn match_osc9_notification() {
        let presets = default_presets();
        let event = make_event(9, None, "Build complete");
        let matched = match_hooks(&event, &presets);
        let actions: Vec<_> = matched.iter().map(|h| &h.action).collect();
        assert!(actions.contains(&&OscAction::Notify { level: None }));
        // Should NOT match set-wsl-distro (requires param="9")
        assert!(!actions.contains(&&OscAction::SetWslDistro));
    }

    #[test]
    fn match_osc133_d_failure() {
        let presets = default_presets();
        let event = make_event(133, Some("D"), "1");
        let matched = match_hooks(&event, &presets);
        let actions: Vec<_> = matched.iter().map(|h| &h.action).collect();
        // Should match notify-on-fail + track-command-result
        assert!(actions.contains(&&OscAction::Notify {
            level: Some("error".into())
        }));
        assert!(actions.contains(&&OscAction::SetCommandStatus(CommandStatusField::ExitCode)));
        // Should NOT match notify-on-complete
        assert!(!actions.contains(&&OscAction::Notify {
            level: Some("success".into())
        }));
    }

    #[test]
    fn match_osc133_d_success() {
        let presets = default_presets();
        let event = make_event(133, Some("D"), "0");
        let matched = match_hooks(&event, &presets);
        let actions: Vec<_> = matched.iter().map(|h| &h.action).collect();
        assert!(actions.contains(&&OscAction::Notify {
            level: Some("success".into())
        }));
        assert!(actions.contains(&&OscAction::SetCommandStatus(CommandStatusField::ExitCode)));
    }

    #[test]
    fn match_osc133_e_git_switch() {
        let presets = default_presets();
        let event = make_event(133, Some("E"), "git switch main");
        let matched = match_hooks(&event, &presets);
        let actions: Vec<_> = matched.iter().map(|h| &h.action).collect();
        assert!(actions.contains(&&OscAction::SyncBranch));
        assert!(actions.contains(&&OscAction::SetCommandStatus(CommandStatusField::Command)));
    }

    #[test]
    fn match_osc133_e_non_git() {
        let presets = default_presets();
        let event = make_event(133, Some("E"), "cargo build");
        let matched = match_hooks(&event, &presets);
        let actions: Vec<_> = matched.iter().map(|h| &h.action).collect();
        // Should match track-command but NOT sync-branch
        assert!(actions.contains(&&OscAction::SetCommandStatus(CommandStatusField::Command)));
        assert!(!actions.contains(&&OscAction::SyncBranch));
    }

    #[test]
    fn match_osc133_c_preexec() {
        let presets = default_presets();
        let event = make_event(133, Some("C"), "");
        let matched = match_hooks(&event, &presets);
        let actions: Vec<_> = matched.iter().map(|h| &h.action).collect();
        assert!(actions.contains(&&OscAction::SetCommandStatus(CommandStatusField::Preexec)));
    }

    #[test]
    fn match_osc777() {
        let presets = default_presets();
        let event = make_event(777, None, "notify;Build;Success");
        let matched = match_hooks(&event, &presets);
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].action, OscAction::Notify { level: None });
    }

    #[test]
    fn match_osc99() {
        let presets = default_presets();
        let event = make_event(99, None, "Custom notification");
        let matched = match_hooks(&event, &presets);
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].action, OscAction::Notify { level: None });
    }

    #[test]
    fn no_match_for_unknown_osc() {
        let presets = default_presets();
        let event = make_event(42, None, "unknown");
        let matched = match_hooks(&event, &presets);
        assert!(matched.is_empty());
    }

    // ── Helper function tests ──

    #[test]
    fn extract_notify_osc777() {
        let event = make_event(777, None, "notify;Build;Success");
        assert_eq!(extract_notify_message(&event), "Build;Success");
    }

    #[test]
    fn extract_notify_osc777_no_prefix() {
        let event = make_event(777, None, "raw message");
        assert_eq!(extract_notify_message(&event), "raw message");
    }

    #[test]
    fn extract_notify_osc9() {
        let event = make_event(9, None, "Build complete");
        assert_eq!(extract_notify_message(&event), "Build complete");
    }

    #[test]
    fn extract_branch() {
        assert_eq!(
            extract_branch_from_command("git switch main"),
            Some("main".into())
        );
        assert_eq!(
            extract_branch_from_command("git checkout -b feature/login"),
            Some("feature/login".into())
        );
    }

    #[test]
    fn extract_branch_ignores_file_restore() {
        // "git checkout -- file.txt" is a file restore, not a branch switch
        assert_eq!(
            extract_branch_from_command("git checkout -- file.txt"),
            None
        );
        assert_eq!(
            extract_branch_from_command("git checkout -- src/main.rs"),
            None
        );
    }

    #[test]
    fn all_presets_count() {
        assert_eq!(default_presets().len(), 13);
    }
}
