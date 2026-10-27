use super::{
    collect_rollout_paths_checked, parse_rollout_identity_checked, CodexSessionStore,
    RolloutIdentity,
};
use crate::constants::CODEX_SESSION_DIRECTORY_DEPTH;

impl CodexSessionStore {
    /// Only called for the current process domain's live, managed OSC identity.
    /// File age and CWD never select a conversation. Duplicate paths also fail.
    pub(in crate::commands::codex_session) fn session_for_live_title(
        &self,
        identity: &str,
    ) -> Result<Option<String>, String> {
        let mut paths = Vec::new();
        collect_rollout_paths_checked(
            &self.sessions_dir(),
            CODEX_SESSION_DIRECTORY_DEPTH,
            identity,
            &mut paths,
        )?;
        if paths.len() != 1 {
            return Ok(None);
        }
        match parse_rollout_identity_checked(&paths[0], None)? {
            RolloutIdentity::TopLevel(id) if id.starts_with(identity) => Ok(Some(id)),
            _ => Ok(None),
        }
    }
}
