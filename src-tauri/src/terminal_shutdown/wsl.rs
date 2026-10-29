use std::collections::BTreeMap;
use std::time::Duration;

use crate::constants::{
    ENV_TERMINAL_CLOSE_TOKEN, ENV_WSLENV, PTY_DAEMON_METADATA_AGENT_HOOK_TOKEN,
    PTY_DAEMON_METADATA_CLOSE_DISTRO, PTY_DAEMON_METADATA_CLOSE_USER,
    TERMINAL_CLOSE_HELPER_TIMEOUT_MS,
};
use crate::terminal::TerminalSession;

#[derive(Clone)]
pub(super) struct Target {
    distro: String,
    user: Option<String>,
    terminal_id: String,
    token: String,
}

impl Target {
    pub(super) fn for_session(
        session: &TerminalSession,
        command_line: &str,
        adopted: Option<&BTreeMap<String, String>>,
    ) -> Result<Self, String> {
        let stored = adopted
            .and_then(|m| m.get(PTY_DAEMON_METADATA_CLOSE_DISTRO))
            .map(String::as_str)
            .or(session.wsl_distro.as_deref());
        let (distro, _) = crate::wsl_probe::terminal_distro_target(stored, command_line)?;
        let distro = distro
            .or_else(|| {
                crate::path_utils::get_default_wsl_distro_with_timeout(Duration::from_secs(2))
            })
            .ok_or("WSL shutdown distribution is unavailable")?;
        let user = match adopted.and_then(|m| m.get(PTY_DAEMON_METADATA_CLOSE_USER)) {
            Some(user) => (!user.is_empty()).then(|| user.clone()),
            None => profile_user(command_line)?,
        };
        let token = adopted
            .and_then(|m| m.get(PTY_DAEMON_METADATA_AGENT_HOOK_TOKEN))
            .unwrap_or(&session.agent_hook_token)
            .clone();
        if token.is_empty() || token.contains(['\0', '\r', '\n']) {
            return Err("WSL shutdown ownership token is unavailable".into());
        }
        Ok(Self {
            distro,
            user,
            terminal_id: session.id.clone(),
            token,
        })
    }

    pub(super) fn metadata(&self) -> BTreeMap<String, String> {
        BTreeMap::from([
            (PTY_DAEMON_METADATA_CLOSE_DISTRO.into(), self.distro.clone()),
            (
                PTY_DAEMON_METADATA_CLOSE_USER.into(),
                self.user.clone().unwrap_or_default(),
            ),
        ])
    }

    pub(super) fn request(&self) -> Result<(), String> {
        let mut command = crate::process::headless_wsl_command();
        command.args(["-d", &self.distro]);
        if let Some(user) = &self.user {
            command.args(["--user", user]);
        }
        command.args([
            "--exec",
            "bash",
            "-c",
            include_str!("wsl_signal.sh"),
            "laymux-graceful-close",
            &self.terminal_id,
        ]);
        // Carry the existing proof only in the helper environment, never in argv/logs.
        let inherited = std::env::var(ENV_WSLENV).unwrap_or_default();
        let mut entries = inherited
            .split(':')
            .filter(|v| {
                !v.is_empty()
                    && !v
                        .split('/')
                        .next()
                        .is_some_and(|key| key.eq_ignore_ascii_case(ENV_TERMINAL_CLOSE_TOKEN))
            })
            .collect::<Vec<_>>();
        entries.push(ENV_TERMINAL_CLOSE_TOKEN);
        command
            .env(ENV_TERMINAL_CLOSE_TOKEN, &self.token)
            .env(ENV_WSLENV, entries.join(":"));
        let output = crate::process::output_with_timeout(
            &mut command,
            Duration::from_millis(TERMINAL_CLOSE_HELPER_TIMEOUT_MS),
        )
        .map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "WSL foreground shutdown failed: {}",
                String::from_utf8_lossy(&output.stdout).trim()
            ))
        }
    }
}

fn profile_user(command_line: &str) -> Result<Option<String>, String> {
    let words = command_line.split_whitespace().collect::<Vec<_>>();
    let mut iter = words.iter().skip(1);
    let mut selected: Option<String> = None;
    while let Some(word) = iter.next() {
        let word = *word;
        if matches!(word, "--" | "-e" | "--exec") {
            break;
        }
        let user = if matches!(word, "-u" | "--user") {
            Some(*iter.next().ok_or("WSL user flag has no value")?)
        } else {
            word.strip_prefix("--user=")
        };
        if let Some(user) = user {
            let user = user.trim_matches(['\'', '"']);
            if user.is_empty() || user.len() > 128 || user.contains(['\0', '\n', '\r', '\'', '"']) {
                return Err("WSL shutdown user is unsupported".into());
            }
            if selected.as_deref().is_some_and(|old| old != user) {
                return Err("WSL profile selects conflicting users".into());
            }
            selected = Some(user.into());
        }
    }
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adoption_uses_the_old_generation_proof_without_new_metadata() {
        let mut session = TerminalSession::new(
            "pane-old-generation".into(),
            crate::terminal::TerminalConfig::default(),
        );
        session.wsl_distro = Some("Ubuntu-22.04".into());
        let old = BTreeMap::from([(
            PTY_DAEMON_METADATA_AGENT_HOOK_TOKEN.into(),
            "proof-owned-by-old-daemon".into(),
        )]);
        let target = Target::for_session(&session, "wsl.exe --user root", Some(&old)).unwrap();
        assert_eq!(target.token, "proof-owned-by-old-daemon");
        assert_ne!(target.token, session.agent_hook_token);
        assert_eq!(target.distro, "Ubuntu-22.04");
        assert_eq!(target.user.as_deref(), Some("root"));
    }

    #[test]
    fn adoption_keeps_the_original_distro_and_default_user_selection() {
        let session = TerminalSession::new(
            "pane-old-profile".into(),
            crate::terminal::TerminalConfig::default(),
        );
        let old = BTreeMap::from([
            (
                PTY_DAEMON_METADATA_AGENT_HOOK_TOKEN.into(),
                "original-proof".into(),
            ),
            (
                PTY_DAEMON_METADATA_CLOSE_DISTRO.into(),
                "OriginalDistro".into(),
            ),
            (PTY_DAEMON_METADATA_CLOSE_USER.into(), String::new()),
        ]);
        let target =
            Target::for_session(&session, "wsl.exe -d NewDistro -u root", Some(&old)).unwrap();
        assert_eq!(target.distro, "OriginalDistro");
        assert_eq!(target.user, None);
    }
    #[test]
    fn user_target_is_explicit_and_does_not_parse_the_guest_command() {
        assert_eq!(
            profile_user("wsl.exe -d Ubuntu -u root -- bash")
                .unwrap()
                .as_deref(),
            Some("root")
        );
        assert_eq!(
            profile_user("wsl.exe --exec app --user other").unwrap(),
            None
        );
        assert!(profile_user("wsl.exe --user").is_err());
        assert!(profile_user("wsl.exe -u a --user=b").is_err());
    }
}
