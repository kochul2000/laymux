use portable_pty::CommandBuilder;

use crate::constants::{
    COLORTERM_TRUECOLOR, ENV_COLORTERM, ENV_LX_GROUP_ID, ENV_LX_TERMINAL_ID, ENV_TERM_PROGRAM,
    ENV_TERM_PROGRAM_VERSION, ENV_WSLENV, ENV_WT_PROFILE_ID, ENV_WT_SESSION, TERM_PROGRAM_LAYMUX,
};

/// Environment mutations owned by one PTY spawn.
///
/// The plan intentionally contains only keys laymux must set or remove. The
/// target process keeps its own base environment; WSL receives the same
/// mutations through its generated init script rather than a Windows env dump.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalEnvPlan {
    set: Vec<(String, String)>,
    unset: Vec<String>,
}

impl TerminalEnvPlan {
    pub(crate) fn for_session(
        session_env: &[(String, String)],
        terminal_id: &str,
        group_id: &str,
        advertise_true_color: bool,
        is_wsl: bool,
        inherited_wslenv: Option<&str>,
    ) -> Self {
        let mut plan = Self::set_only(session_env);

        plan.upsert_owned(ENV_LX_TERMINAL_ID, terminal_id);
        plan.upsert_owned(ENV_LX_GROUP_ID, group_id);
        plan.upsert_owned(ENV_TERM_PROGRAM, TERM_PROGRAM_LAYMUX);
        plan.upsert_owned(ENV_TERM_PROGRAM_VERSION, env!("CARGO_PKG_VERSION"));

        if advertise_true_color {
            plan.upsert_owned(ENV_COLORTERM, COLORTERM_TRUECOLOR);
        } else {
            plan.remove_set_key(ENV_COLORTERM);
            plan.push_unset(ENV_COLORTERM);
        }

        for key in [ENV_WT_SESSION, ENV_WT_PROFILE_ID] {
            plan.remove_set_key(key);
            plan.push_unset(key);
        }

        if is_wsl {
            plan.sanitize_wslenv(inherited_wslenv);
        }

        plan
    }

    pub(crate) fn set_only(env: &[(String, String)]) -> Self {
        let mut plan = Self {
            set: Vec::new(),
            unset: Vec::new(),
        };
        for (key, value) in env {
            if let Some(existing) = plan.set.iter_mut().find(|(candidate, _)| candidate == key) {
                existing.1.clone_from(value);
            } else {
                plan.set.push((key.clone(), value.clone()));
            }
        }
        plan
    }

    pub(crate) fn set(&self) -> &[(String, String)] {
        &self.set
    }

    pub(crate) fn unset(&self) -> &[String] {
        &self.unset
    }

    pub(crate) fn apply_to_command(&self, command: &mut CommandBuilder) {
        for (key, value) in &self.set {
            remove_ascii_case_variants(command, key);
            command.env(key, value);
        }
        for key in &self.unset {
            remove_ascii_case_variants(command, key);
        }
    }

    fn upsert_owned(&mut self, key: &str, value: &str) {
        self.remove_set_key(key);
        self.unset
            .retain(|candidate| !candidate.eq_ignore_ascii_case(key));
        self.set.push((key.to_string(), value.to_string()));
    }

    fn remove_set_key(&mut self, key: &str) {
        self.set
            .retain(|(candidate, _)| !candidate.eq_ignore_ascii_case(key));
    }

    fn push_unset(&mut self, key: &str) {
        if !self
            .unset
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(key))
        {
            self.unset.push(key.to_string());
        }
    }

    fn sanitize_wslenv(&mut self, inherited_wslenv: Option<&str>) {
        let explicit = self
            .set
            .iter()
            .rev()
            .find(|(key, _)| key.eq_ignore_ascii_case(ENV_WSLENV))
            .map(|(_, value)| value.clone());
        let source = explicit.as_deref().or(inherited_wslenv);
        let Some(source) = source else {
            return;
        };

        let (sanitized, changed) = sanitize_wslenv_value(source);
        if !changed && explicit.is_none() {
            return;
        }

        self.remove_set_key(ENV_WSLENV);
        if sanitized.is_empty() {
            self.push_unset(ENV_WSLENV);
        } else {
            self.upsert_owned(ENV_WSLENV, &sanitized);
        }
    }
}

fn sanitize_wslenv_value(value: &str) -> (String, bool) {
    let mut changed = false;
    let kept = value
        .split(':')
        .filter(|part| {
            let name = part.split('/').next().unwrap_or(part);
            let remove = [ENV_WT_SESSION, ENV_WT_PROFILE_ID]
                .iter()
                .any(|target| name.eq_ignore_ascii_case(target));
            changed |= remove;
            !remove
        })
        .collect::<Vec<_>>()
        .join(":");
    (kept, changed)
}

fn remove_ascii_case_variants(command: &mut CommandBuilder, key: &str) {
    let variants = command
        .iter_full_env_as_str()
        .filter(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
        .map(|(candidate, _)| candidate.to_string())
        .collect::<Vec<_>>();
    for variant in variants {
        command.env_remove(variant);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{ENV_FORCE_COLOR, ENV_NO_COLOR, ENV_TERM};
    use std::ffi::OsStr;

    fn value<'a>(plan: &'a TerminalEnvPlan, key: &str) -> Option<&'a str> {
        plan.set
            .iter()
            .find(|(candidate, _)| candidate == key)
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn reserved_values_override_case_insensitive_collisions() {
        let plan = TerminalEnvPlan::for_session(
            &[
                ("term_program".into(), "foreign".into()),
                ("Term_Program_Version".into(), "old".into()),
                ("colorTerm".into(), "ansi16".into()),
                (ENV_TERM.into(), "xterm-custom".into()),
                (ENV_NO_COLOR.into(), "1".into()),
                (ENV_FORCE_COLOR.into(), "2".into()),
            ],
            "terminal-1",
            "group-1",
            true,
            false,
            None,
        );

        assert_eq!(value(&plan, ENV_TERM_PROGRAM), Some(TERM_PROGRAM_LAYMUX));
        assert_eq!(
            value(&plan, ENV_TERM_PROGRAM_VERSION),
            Some(env!("CARGO_PKG_VERSION"))
        );
        assert_eq!(value(&plan, ENV_COLORTERM), Some(COLORTERM_TRUECOLOR));
        assert_eq!(value(&plan, ENV_TERM), Some("xterm-custom"));
        assert_eq!(value(&plan, ENV_NO_COLOR), Some("1"));
        assert_eq!(value(&plan, ENV_FORCE_COLOR), Some("2"));
        assert_eq!(value(&plan, ENV_LX_TERMINAL_ID), Some("terminal-1"));
        assert_eq!(value(&plan, ENV_LX_GROUP_ID), Some("group-1"));
        assert_eq!(
            plan.set
                .iter()
                .filter(|(key, _)| key.eq_ignore_ascii_case(ENV_COLORTERM))
                .count(),
            1
        );
    }

    #[test]
    fn opt_out_unsets_colorterm_and_upstream_terminal_identity() {
        let plan = TerminalEnvPlan::for_session(
            &[
                ("colorTerm".into(), "truecolor".into()),
                ("wt_session".into(), "stale".into()),
                ("WT_PROFILE_ID".into(), "stale-profile".into()),
            ],
            "terminal-1",
            "group-1",
            false,
            false,
            None,
        );

        assert_eq!(value(&plan, ENV_COLORTERM), None);
        for key in [ENV_COLORTERM, ENV_WT_SESSION, ENV_WT_PROFILE_ID] {
            assert!(plan.unset.iter().any(|candidate| candidate == key));
            assert!(!plan
                .set
                .iter()
                .any(|(candidate, _)| candidate.eq_ignore_ascii_case(key)));
        }
        assert_eq!(value(&plan, ENV_TERM_PROGRAM), Some(TERM_PROGRAM_LAYMUX));
    }

    #[test]
    fn wsl_sanitizes_target_entries_with_flags_case_and_duplicates() {
        let plan = TerminalEnvPlan::for_session(
            &[],
            "terminal-1",
            "group-1",
            true,
            true,
            Some("KEEP/u:wt_session/p:WT_PROFILE_ID:KeepTwo/l:WT_SESSION:KEEP/u"),
        );

        assert_eq!(value(&plan, ENV_WSLENV), Some("KEEP/u:KeepTwo/l:KEEP/u"));
    }

    #[test]
    fn wsl_unsets_wslenv_when_it_only_contains_removed_entries() {
        let plan = TerminalEnvPlan::for_session(
            &[],
            "terminal-1",
            "group-1",
            true,
            true,
            Some("WT_SESSION:wt_profile_id/u"),
        );

        assert_eq!(value(&plan, ENV_WSLENV), None);
        assert!(plan.unset.iter().any(|key| key == ENV_WSLENV));
    }

    #[test]
    fn non_wsl_plan_does_not_rewrite_wslenv() {
        let plan = TerminalEnvPlan::for_session(
            &[],
            "terminal-1",
            "group-1",
            true,
            false,
            Some("KEEP:WT_SESSION"),
        );

        assert_eq!(value(&plan, ENV_WSLENV), None);
        assert!(!plan.unset.iter().any(|key| key == ENV_WSLENV));
    }

    #[test]
    fn command_adapter_removes_case_variants_before_apply() {
        let mut command = CommandBuilder::new("ignored");
        command.env("colorTerm", "ansi16");
        command.env("wt_session", "stale");
        let plan = TerminalEnvPlan::for_session(&[], "terminal-1", "group-1", false, false, None);

        plan.apply_to_command(&mut command);

        assert_eq!(command.get_env(ENV_COLORTERM), None);
        assert_eq!(command.get_env(ENV_WT_SESSION), None);
        assert_eq!(
            command.get_env(ENV_TERM_PROGRAM),
            Some(OsStr::new(TERM_PROGRAM_LAYMUX))
        );
    }
}
