use std::sync::atomic::Ordering;
use std::sync::Arc;

use super::Registry;

impl Registry {
    pub(super) fn prune(&mut self, now: u64) {
        self.challenges
            .retain(|_, challenge| now < challenge.response.challenge_expires_at);
        self.completed
            .retain(|_, completed| now < completed.challenge_expires_at);
        self.sessions.retain(|_, session| {
            Arc::strong_count(session) > 1 || now < session.expires_at.load(Ordering::Acquire)
        });
    }

    pub(super) fn replace_sessions_for_pairing(&mut self, instance_id: &str, revision: u64) {
        self.sessions.retain(|_, session| {
            let replace =
                session.instance_id == instance_id && session.pairing_revision == revision;
            if replace {
                session.revoked.store(true, Ordering::Release);
            }
            !replace
        });
    }
}
