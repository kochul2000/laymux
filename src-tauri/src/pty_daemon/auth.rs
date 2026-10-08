//! Private daemon authentication and exclusive GUI attachment authority.
use crate::error::AppError;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use zeroize::Zeroizing;

pub(crate) const PROTOCOL_VERSION: u32 = 1;
pub(crate) const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub(crate) const CONNECTION_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);

/// Not Debug/Serialize: authentication secrets must never become diagnostics.
pub(crate) struct Capability(Zeroizing<[u8; 32]>);

impl Capability {
    pub(crate) fn generate() -> Result<Self, AppError> {
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes)
            .map_err(|_| AppError::Other("daemon entropy unavailable".into()))?;
        Ok(Self(Zeroizing::new(bytes)))
    }

    pub(crate) fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(Zeroizing::new(bytes))
    }

    pub(crate) fn bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub(crate) fn proof(&self, challenge: &Challenge) -> Result<Vec<u8>, AppError> {
        self.role_proof(challenge, b"laymux-daemon-client-v1")
    }

    pub(crate) fn server_proof(&self, challenge: &Challenge) -> Result<Vec<u8>, AppError> {
        self.role_proof(challenge, b"laymux-daemon-server-v1")
    }

    fn role_proof(&self, challenge: &Challenge, role: &[u8]) -> Result<Vec<u8>, AppError> {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.bytes())
            .map_err(|_| AppError::Other("daemon authentication key invalid".into()))?;
        mac.update(role);
        mac.update(&serde_json::to_vec(challenge)?);
        Ok(mac.finalize().into_bytes().to_vec())
    }

    pub(crate) fn verify(&self, challenge: &Challenge, proof: &[u8]) -> Result<(), AppError> {
        self.verify_role(challenge, proof, b"laymux-daemon-client-v1")
    }

    pub(crate) fn verify_server(
        &self,
        challenge: &Challenge,
        proof: &[u8],
    ) -> Result<(), AppError> {
        self.verify_role(challenge, proof, b"laymux-daemon-server-v1")
    }

    fn verify_role(
        &self,
        challenge: &Challenge,
        proof: &[u8],
        role: &[u8],
    ) -> Result<(), AppError> {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.bytes())
            .map_err(|_| AppError::Other("daemon authentication key invalid".into()))?;
        mac.update(role);
        mac.update(&serde_json::to_vec(challenge)?);
        mac.verify_slice(proof)
            .map_err(|_| AppError::Other("daemon authentication rejected".into()))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Challenge {
    pub protocol: u32,
    pub scope: String,
    pub incarnation: String,
    pub runtime: String,
    pub nonce: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AttachmentStamp {
    pub incarnation: String,
    pub epoch: u64,
    pub connection: String,
}

/// Owned behind one async operation gate. Replacing a live owner is forbidden.
pub(crate) struct AttachmentAuthority {
    incarnation: String,
    epoch: u64,
    current: Option<(AttachmentStamp, Arc<AtomicBool>)>,
}

impl AttachmentAuthority {
    pub(crate) fn new(incarnation: String) -> Self {
        Self {
            incarnation,
            epoch: 0,
            current: None,
        }
    }

    pub(crate) fn attach(&mut self, connection: String) -> Result<AttachmentStamp, AppError> {
        self.attach_live(connection, Arc::new(AtomicBool::new(true)))
    }

    pub(crate) fn attach_live(
        &mut self,
        connection: String,
        live: Arc<AtomicBool>,
    ) -> Result<AttachmentStamp, AppError> {
        if self
            .current
            .as_ref()
            .is_some_and(|(_, live)| live.load(Ordering::Acquire))
        {
            return Err(AppError::Other("daemon GUI is already attached".into()));
        }
        self.epoch = self
            .epoch
            .checked_add(1)
            .ok_or_else(|| AppError::Other("daemon attachment epoch exhausted".into()))?;
        let stamp = AttachmentStamp {
            incarnation: self.incarnation.clone(),
            epoch: self.epoch,
            connection,
        };
        self.current = Some((stamp.clone(), live));
        Ok(stamp)
    }

    pub(crate) fn validate(&self, stamp: &AttachmentStamp) -> Result<(), AppError> {
        if self
            .current
            .as_ref()
            .is_some_and(|(current, live)| current == stamp && live.load(Ordering::Acquire))
            && stamp.incarnation == self.incarnation
        {
            Ok(())
        } else {
            Err(AppError::Other(
                "daemon attachment authority expired".into(),
            ))
        }
    }

    pub(crate) fn detach(&mut self, stamp: &AttachmentStamp) -> Result<(), AppError> {
        self.validate(stamp)?;
        self.current = None;
        Ok(())
    }

    pub(crate) fn disconnected(&mut self, connection: &str) {
        if self
            .current
            .as_ref()
            .is_some_and(|(stamp, _)| stamp.connection == connection)
        {
            self.current = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn challenge() -> Challenge {
        Challenge {
            protocol: PROTOCOL_VERSION,
            scope: "dev/profile/worktree/logon".into(),
            incarnation: "daemon-one".into(),
            runtime: "bundle-one".into(),
            nonce: "nonce-one".into(),
        }
    }

    #[test]
    fn capability_is_bound_to_every_handshake_field() {
        let key = Capability::from_bytes([7; 32]);
        let hello = challenge();
        let proof = key.proof(&hello).unwrap();
        key.verify(&hello, &proof).unwrap();
        assert!(Capability::from_bytes([8; 32])
            .verify(&hello, &proof)
            .is_err());
        assert!(key.verify(&hello, &proof[..31]).is_err());
        for field in ["protocol", "scope", "incarnation", "runtime", "nonce"] {
            let mut changed = serde_json::to_value(&hello).unwrap();
            changed[field] = if field == "protocol" {
                serde_json::json!(2)
            } else {
                serde_json::json!("other")
            };
            let changed: Challenge = serde_json::from_value(changed).unwrap();
            assert!(key.verify(&changed, &proof).is_err(), "{field}");
        }
    }

    #[test]
    fn handoff_revokes_old_authority_before_new_gui_attaches() {
        let mut authority = AttachmentAuthority::new("daemon-one".into());
        let old = authority.attach("old-gui".into()).unwrap();
        authority.validate(&old).unwrap();
        assert!(authority.attach("new-gui".into()).is_err());
        authority.detach(&old).unwrap();
        assert!(authority.validate(&old).is_err());
        let new = authority.attach("new-gui".into()).unwrap();
        assert!(new.epoch > old.epoch);
        assert!(authority.validate(&old).is_err());
        assert!(authority.detach(&old).is_err());
        authority.validate(&new).unwrap();
    }

    #[test]
    fn delayed_disconnect_cannot_revoke_the_next_attachment() {
        let mut authority = AttachmentAuthority::new("daemon-one".into());
        let old = authority.attach("old-gui".into()).unwrap();
        authority.disconnected("old-gui");
        let new = authority.attach("new-gui".into()).unwrap();
        authority.disconnected("old-gui");
        assert!(authority.validate(&old).is_err());
        authority.validate(&new).unwrap();
    }

    #[test]
    fn matching_epoch_from_another_incarnation_or_connection_is_rejected() {
        let mut authority = AttachmentAuthority::new("daemon-one".into());
        let stamp = authority.attach("gui".into()).unwrap();
        let mut other = stamp.clone();
        other.incarnation = "daemon-two".into();
        assert!(authority.validate(&other).is_err());
        other = stamp;
        other.connection = "another-gui".into();
        assert!(authority.validate(&other).is_err());
    }
}
