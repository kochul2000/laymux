//! Live Codex TUI title identity, never a task-state or restore authority.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TitleBinding {
    pub generation: u64,
    pub revision: u64,
    pub identity: Option<String>,
}

pub fn identity(title: &str) -> Option<String> {
    let title = title
        .strip_prefix("[ ! ] Action Required | ")
        .or_else(|| title.strip_prefix("[ . ] Action Required | "))
        .unwrap_or(title);
    let parts: Vec<_> = title.split(" | ").collect();
    if parts.first() != Some(&"codex") {
        return None;
    }
    let item = *parts.get(1)?;
    let mut words = item.split_whitespace();
    let value = words.next()?;
    // Both title generation and activity can append a spinner. Activity also
    // joins the following user item with a space, e.g. "ID... ⠸ project name".
    if let Some(spinner) = words.next() {
        if spinner.chars().count() != 1
            || !spinner
                .chars()
                .all(|c| ('\u{2800}'..='\u{28ff}').contains(&c))
        {
            return None;
        }
    }
    let (id, len) = if let Some(prefix) = value.strip_suffix("...") {
        (prefix, 29)
    } else {
        (value, 36)
    };
    if id.len() != len
        || !id.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit() && !c.is_ascii_uppercase()
            }
        })
    {
        return None;
    }
    Some(id.into())
}

impl TitleBinding {
    pub fn observe(&mut self, event: &crate::osc::OscEvent, generation: u64) {
        if event.code == 133 && matches!(event.param.as_deref(), Some("A" | "C" | "D" | "E")) {
            self.clear();
            self.generation = generation;
        } else if matches!(event.code, 0 | 2) {
            let next = identity(&event.data);
            if self.generation != generation || self.identity != next {
                self.revision = self.revision.wrapping_add(1);
                self.generation = generation;
                self.identity = next;
            }
        }
    }
    pub fn clear(&mut self) {
        self.identity = None;
        self.revision = self.revision.wrapping_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_osc_replaces_clears_and_rejects_aba_across_commands_and_generations() {
        let mut binding = TitleBinding::default();
        let title = b"\x1b]0;codex | 01a0ec06-451a-7e61-ac51-bd98f... | Ready\x07";
        for event in crate::osc::iter_osc_events(title) {
            binding.observe(&event, 1);
        }
        let before = binding.clone();
        assert!(before.identity.is_some());
        for boundary in [
            b"\x1b]0;\x07".as_slice(),
            b"\x1b]2;shell\x07",
            b"\x1b]133;C\x07",
            b"\x1b]133;A\x07",
        ] {
            for event in crate::osc::iter_osc_events(boundary) {
                binding.observe(&event, 1);
            }
            assert!(binding.identity.is_none());
            for event in crate::osc::iter_osc_events(title) {
                binding.observe(&event, 1);
            }
            assert_ne!(binding, before);
        }
        for event in crate::osc::iter_osc_events(title) {
            binding.observe(&event, 2);
        }
        assert_eq!(binding.generation, 2);
        assert_ne!(binding, before);
    }
    #[test]
    fn configured_titles_accept_uuid_and_codex_158_abbreviation_only() {
        let id = "01a0ec06-451a-7e61-ac51-bd98fab4ed82";
        let prefix = "01a0ec06-451a-7e61-ac51-bd98f";
        assert_eq!(identity(&format!("codex | {id} | Ready")), Some(id.into()));
        assert_eq!(
            identity(&format!("codex | {prefix}... ⠸ | Working")),
            Some(prefix.into())
        );
        assert_eq!(
            identity(&format!("codex | {prefix}... ⠸ project name")),
            Some(prefix.into())
        );
        assert_eq!(
            identity(&format!("codex | {prefix}... | codex")),
            Some(prefix.into())
        );
        assert_eq!(
            identity(&format!(
                "[ ! ] Action Required | codex | {prefix}... | project"
            )),
            Some(prefix.into())
        );
        assert_eq!(
            identity(&format!(
                "[ . ] Action Required | codex | {prefix}... | project"
            )),
            Some(prefix.into())
        );
        for title in [
            "",
            "codex | Ready",
            "project | codex | 01a0ec06-451a-7e61-ac51-bd98f...",
            "codex | 01a0ec06...",
            "codex | 01a0ec06-451a-7e61-ac51-bd98f",
            "codex | 01a0ec06-451a-7e61-ac51-bd98f...suffix",
        ] {
            assert_eq!(identity(title), None, "{title}");
        }
    }
}
