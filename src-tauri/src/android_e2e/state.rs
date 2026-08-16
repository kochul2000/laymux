use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex as AsyncMutex;
use zeroize::Zeroizing;

use crate::android_pairing::ConfirmedPairingMaterial;
use crate::error::AppError;
use crate::lock_ext::MutexExt;

use super::crypto::{
    decrypt_output_request, decrypt_request, derive_output_keys, derive_session_keys,
    encrypt_output_response, encrypt_response, proof, verify_proof, OutputKeys, SessionKeys,
    MAX_SEQUENCE,
};
#[cfg(test)]
use super::crypto::{decrypt_output_response, encrypt_output_request};
use super::validation::{valid_base64url, valid_instance_id};
use super::{
    field_refs, key_fields, proof_fields_challenge, proof_fields_establish, proof_fields_response,
    ChallengeRequest, ChallengeResponse, CipherEnvelope, E2eError, EstablishRequest,
    EstablishResponse, CHALLENGE_ID_BYTES, CHALLENGE_RESPONSE_DOMAIN, CHALLENGE_TTL_SECONDS,
    CLIENT_SESSION_NONCE_BYTES, ESTABLISH_REQUEST_DOMAIN, ESTABLISH_RESPONSE_DOMAIN,
    OUTPUT_STREAM_NONCE_BYTES, PROTOCOL_VERSION, SERVER_NONCE_BYTES, SESSION_ID_BYTES,
    SESSION_INACTIVITY_TIMEOUT_SECONDS,
};

const MAX_CHALLENGES: usize = 16;
const MAX_SESSIONS: usize = 8;
const MAX_OUTPUT_STREAM_NONCES: usize = 1024;
const RANDOM_ID_ATTEMPTS: usize = 4;
const PAIRING_ID_BYTES: usize = 16;
const CLIENT_NONCE_BYTES: usize = 16;
// Leaves room for bounded Remote resources after inner encoding while keeping
// the decrypted allocation below the public 6 MiB envelope limit.
const MAX_PLAINTEXT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Default)]
pub struct AndroidE2eState {
    registry: Mutex<Registry>,
}

#[derive(Default)]
struct Registry {
    challenges: HashMap<String, Challenge>,
    completed: HashMap<String, CompletedEstablish>,
    sessions: HashMap<String, Arc<AndroidE2eSession>>,
}

#[derive(Clone)]
struct Challenge {
    request: ChallengeRequest,
    response: ChallengeResponse,
}

#[derive(Clone)]
struct CompletedEstablish {
    request_proof: String,
    response: EstablishResponse,
    challenge_expires_at: u64,
}

pub(crate) struct AndroidE2eSession {
    pub(crate) instance_id: String,
    pub(crate) session_id: String,
    pairing_revision: u64,
    expires_at: AtomicU64,
    revoked: AtomicBool,
    state: AsyncMutex<SessionState>,
}

struct SessionState {
    keys: SessionKeys,
    used_output_nonces: HashSet<String>,
    next_sequence: u64,
    last_request_digest: Option<[u8; 32]>,
    last_response: Option<CipherEnvelope>,
}

impl AndroidE2eState {
    pub(crate) fn issue_challenge(
        &self,
        request: ChallengeRequest,
        material: &ConfirmedPairingMaterial,
        now: u64,
    ) -> Result<ChallengeResponse, E2eError> {
        validate_challenge_request(&request)?;
        let mut registry = self.registry.lock_or_err().map_err(E2eError::Internal)?;
        registry.prune(now);

        if let Some(existing) = registry.challenges.values().find(|challenge| {
            challenge.request.instance_id == request.instance_id
                && challenge.request.pairing_id == request.pairing_id
                && challenge.request.client_nonce == request.client_nonce
                && challenge.request.client_session_nonce == request.client_session_nonce
        }) {
            return Ok(existing.response.clone());
        }
        if registry.challenges.len() >= MAX_CHALLENGES {
            return Err(E2eError::Invalid);
        }

        for _ in 0..RANDOM_ID_ATTEMPTS {
            let mut challenge_id = [0_u8; CHALLENGE_ID_BYTES];
            getrandom::fill(&mut challenge_id).map_err(|error| {
                E2eError::Internal(AppError::Other(format!(
                    "Android E2E challenge random generation failed: {error}"
                )))
            })?;
            let encoded_challenge_id = URL_SAFE_NO_PAD.encode(challenge_id);
            if registry.challenges.contains_key(&encoded_challenge_id)
                || registry.completed.contains_key(&encoded_challenge_id)
            {
                continue;
            }
            let mut server_nonce = [0_u8; SERVER_NONCE_BYTES];
            getrandom::fill(&mut server_nonce).map_err(|error| {
                E2eError::Internal(AppError::Other(format!(
                    "Android E2E server nonce generation failed: {error}"
                )))
            })?;
            return self.issue_challenge_with_material(
                request,
                material,
                now,
                challenge_id,
                server_nonce,
                &mut registry,
            );
        }
        Err(E2eError::Internal(AppError::Other(
            "Android E2E challenge id generation collided repeatedly".into(),
        )))
    }

    fn issue_challenge_with_material(
        &self,
        request: ChallengeRequest,
        material: &ConfirmedPairingMaterial,
        now: u64,
        challenge_id: [u8; CHALLENGE_ID_BYTES],
        server_nonce: [u8; SERVER_NONCE_BYTES],
        registry: &mut Registry,
    ) -> Result<ChallengeResponse, E2eError> {
        let encoded_challenge_id = URL_SAFE_NO_PAD.encode(challenge_id);
        if registry.challenges.contains_key(&encoded_challenge_id)
            || registry.completed.contains_key(&encoded_challenge_id)
        {
            return Err(E2eError::Internal(AppError::Other(
                "Android E2E challenge id collided".into(),
            )));
        }
        let challenge_expires_at = now
            .checked_add(CHALLENGE_TTL_SECONDS)
            .ok_or_else(|| E2eError::Internal(AppError::Other("E2E expiry overflowed".into())))?;
        let mut response = ChallengeResponse {
            version: PROTOCOL_VERSION,
            instance_id: request.instance_id.clone(),
            pairing_id: request.pairing_id.clone(),
            client_nonce: request.client_nonce.clone(),
            client_session_nonce: request.client_session_nonce.clone(),
            challenge_id: encoded_challenge_id,
            server_nonce: URL_SAFE_NO_PAD.encode(server_nonce),
            challenge_expires_at,
            server_proof: String::new(),
        };
        let fields = proof_fields_challenge(&response);
        response.server_proof = proof(
            &material.seed,
            CHALLENGE_RESPONSE_DOMAIN,
            &field_refs(&fields),
        )?;
        registry.challenges.insert(
            response.challenge_id.clone(),
            Challenge {
                request,
                response: response.clone(),
            },
        );
        Ok(response)
    }

    pub(crate) fn establish(
        &self,
        request: EstablishRequest,
        material: &ConfirmedPairingMaterial,
        now: u64,
    ) -> Result<EstablishResponse, E2eError> {
        validate_establish_request(&request)?;
        let mut registry = self.registry.lock_or_err().map_err(E2eError::Internal)?;
        registry.prune(now);

        if let Some(completed) = registry.completed.get(&request.challenge_id) {
            return if completed.request_proof == request.client_proof {
                Ok(completed.response.clone())
            } else {
                Err(E2eError::Invalid)
            };
        }
        let challenge = registry
            .challenges
            .get(&request.challenge_id)
            .cloned()
            .ok_or(E2eError::Invalid)?;
        if now >= challenge.response.challenge_expires_at {
            registry.challenges.remove(&request.challenge_id);
            return Err(E2eError::Expired);
        }
        if !challenge_matches(&challenge, &request) {
            return Err(E2eError::Invalid);
        }
        let fields = proof_fields_establish(
            &request,
            &challenge.response.server_nonce,
            challenge.response.challenge_expires_at,
        );
        if !verify_proof(
            &material.seed,
            ESTABLISH_REQUEST_DOMAIN,
            &field_refs(&fields),
            &request.client_proof,
        )? {
            return Err(E2eError::Invalid);
        }
        registry.replace_sessions_for_pairing(&request.instance_id, material.revision);
        if registry.sessions.len() >= MAX_SESSIONS {
            return Err(E2eError::Invalid);
        }

        let session_id = (0..RANDOM_ID_ATTEMPTS)
            .find_map(|_| {
                let mut bytes = [0_u8; SESSION_ID_BYTES];
                getrandom::fill(&mut bytes)
                    .map(|()| URL_SAFE_NO_PAD.encode(bytes))
                    .ok()
                    .filter(|candidate| !registry.sessions.contains_key(candidate))
            })
            .ok_or_else(|| {
                E2eError::Internal(AppError::Other(
                    "Android E2E session id generation failed or collided repeatedly".into(),
                ))
            })?;
        let expires_at = now
            .checked_add(SESSION_INACTIVITY_TIMEOUT_SECONDS)
            .ok_or_else(|| E2eError::Internal(AppError::Other("E2E expiry overflowed".into())))?;
        let mut response = EstablishResponse {
            version: PROTOCOL_VERSION,
            instance_id: request.instance_id.clone(),
            pairing_id: request.pairing_id.clone(),
            client_nonce: request.client_nonce.clone(),
            client_session_nonce: request.client_session_nonce.clone(),
            challenge_id: request.challenge_id.clone(),
            server_nonce: challenge.response.server_nonce.clone(),
            session_id,
            expires_at,
            server_proof: String::new(),
        };
        let keys = derive_session_keys(&material.seed, &key_fields(&response))?;
        let response_fields = proof_fields_response(&response);
        response.server_proof = proof(
            &material.seed,
            ESTABLISH_RESPONSE_DOMAIN,
            &field_refs(&response_fields),
        )?;

        let session = Arc::new(AndroidE2eSession {
            instance_id: response.instance_id.clone(),
            session_id: response.session_id.clone(),
            pairing_revision: material.revision,
            expires_at: AtomicU64::new(expires_at),
            revoked: AtomicBool::new(false),
            state: AsyncMutex::new(SessionState {
                keys,
                used_output_nonces: HashSet::new(),
                next_sequence: 0,
                last_request_digest: None,
                last_response: None,
            }),
        });
        registry
            .sessions
            .insert(response.session_id.clone(), session);
        registry.challenges.remove(&request.challenge_id);
        registry.completed.insert(
            request.challenge_id.clone(),
            CompletedEstablish {
                request_proof: request.client_proof,
                response: response.clone(),
                challenge_expires_at: challenge.response.challenge_expires_at,
            },
        );
        Ok(response)
    }

    pub(crate) fn session(
        &self,
        instance_id: &str,
        session_id: &str,
        now: u64,
    ) -> Result<Arc<AndroidE2eSession>, E2eError> {
        let mut registry = self.registry.lock_or_err().map_err(E2eError::Internal)?;
        registry.prune(now);
        let session = registry
            .sessions
            .get(session_id)
            .filter(|session| session.instance_id == instance_id)
            .cloned()
            .ok_or(E2eError::Invalid)?;
        if session.pairing_revision != crate::android_pairing::pairing_revision() {
            session.revoked.store(true, Ordering::Release);
            registry.sessions.remove(session_id);
            return Err(E2eError::Invalid);
        }
        Ok(session)
    }

    pub(crate) fn clear(&self) -> Result<(), AppError> {
        let mut registry = self.registry.lock_or_err()?;
        registry.challenges.clear();
        registry.completed.clear();
        let sessions = registry
            .sessions
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>();
        drop(registry);
        for session in sessions {
            session.revoked.store(true, Ordering::Release);
        }
        Ok(())
    }
}

impl AndroidE2eSession {
    pub(crate) async fn open_output_cipher(
        &self,
        stream_nonce: &str,
        now: u64,
    ) -> Result<AndroidE2eOutputCipher, E2eError> {
        if !valid_base64url::<OUTPUT_STREAM_NONCE_BYTES>(stream_nonce) {
            return Err(E2eError::Invalid);
        }
        let mut state = self.state.lock().await;
        self.ensure_active(now)?;
        if state.used_output_nonces.len() >= MAX_OUTPUT_STREAM_NONCES {
            // Forgetting an accepted nonce would make its encrypted OPEN
            // replayable, so roll the session instead of recycling entries.
            self.revoked.store(true, Ordering::Release);
            return Err(E2eError::Expired);
        }
        if !state.used_output_nonces.insert(stream_nonce.to_string()) {
            return Err(E2eError::Invalid);
        }
        let keys = derive_output_keys(
            &state.keys,
            &self.instance_id,
            &self.session_id,
            stream_nonce,
        )?;
        Ok(AndroidE2eOutputCipher {
            instance_id: self.instance_id.clone(),
            session_id: self.session_id.clone(),
            stream_nonce: stream_nonce.to_string(),
            keys,
            next_request_sequence: 0,
            next_response_sequence: 0,
        })
    }

    pub(crate) fn ensure_active(&self, now: u64) -> Result<(), E2eError> {
        if self.is_revoked() {
            return Err(E2eError::Invalid);
        }
        if now >= self.expires_at.load(Ordering::Acquire) {
            return Err(E2eError::Expired);
        }
        Ok(())
    }

    pub(crate) async fn process<C, F, Fut>(
        &self,
        envelope: CipherEnvelope,
        clock: C,
        dispatch: F,
    ) -> Result<CipherEnvelope, E2eError>
    where
        C: FnOnce() -> Result<u64, E2eError>,
        F: FnOnce(Value) -> Fut,
        Fut: Future<Output = Result<Value, AppError>>,
    {
        if envelope.version != PROTOCOL_VERSION
            || envelope.instance_id != self.instance_id
            || envelope.session_id != self.session_id
            || envelope.sequence > MAX_SEQUENCE
        {
            return Err(E2eError::Invalid);
        }
        let mut state = self.state.lock().await;
        if self.is_revoked() {
            return Err(E2eError::Invalid);
        }
        let now = clock()?;
        if now >= self.expires_at.load(Ordering::Acquire) {
            return Err(E2eError::Expired);
        }

        let digest: [u8; 32] = Sha256::digest(envelope.ciphertext.as_bytes()).into();
        if envelope.sequence < state.next_sequence {
            if envelope.sequence.checked_add(1) == Some(state.next_sequence)
                && state.last_request_digest == Some(digest)
            {
                return state.last_response.clone().ok_or(E2eError::Sequence);
            }
            return Err(E2eError::Sequence);
        }
        if envelope.sequence != state.next_sequence {
            return Err(E2eError::Sequence);
        }

        let plaintext = decrypt_request(
            &state.keys.a2d,
            &self.instance_id,
            &self.session_id,
            envelope.sequence,
            &envelope.ciphertext,
        )
        .map_err(|_| E2eError::Invalid)?;
        if plaintext.len() > MAX_PLAINTEXT_BYTES {
            return Err(E2eError::Invalid);
        }
        let request: Value = serde_json::from_slice(&plaintext).map_err(|_| E2eError::Invalid)?;
        let candidate_expires_at = now
            .checked_add(SESSION_INACTIVITY_TIMEOUT_SECONDS)
            .ok_or_else(|| E2eError::Internal(AppError::Other("E2E expiry overflowed".into())))?;
        if self.is_revoked() {
            return Err(E2eError::Invalid);
        }
        let response = dispatch(request).await?;
        if self.is_revoked() {
            return Err(E2eError::Invalid);
        }
        let previous_expires_at = self
            .expires_at
            .fetch_max(candidate_expires_at, Ordering::AcqRel);
        let refreshed_expires_at = previous_expires_at.max(candidate_expires_at);
        let response_bytes = serde_json::to_vec(&serde_json::json!({
            "version": PROTOCOL_VERSION,
            "expiresAt": refreshed_expires_at,
            "response": response,
        }))
        .map_err(AppError::from)?;
        if response_bytes.len() > MAX_PLAINTEXT_BYTES {
            return Err(E2eError::Internal(AppError::Other(
                "Android E2E response exceeded plaintext limit".into(),
            )));
        }
        let response_envelope = CipherEnvelope {
            version: PROTOCOL_VERSION,
            instance_id: self.instance_id.clone(),
            session_id: self.session_id.clone(),
            sequence: envelope.sequence,
            ciphertext: encrypt_response(
                &state.keys.d2a,
                &self.instance_id,
                &self.session_id,
                envelope.sequence,
                &response_bytes,
            )?,
        };
        state.next_sequence = state
            .next_sequence
            .checked_add(1)
            .ok_or(E2eError::Sequence)?;
        state.last_request_digest = Some(digest);
        state.last_response = Some(response_envelope.clone());
        Ok(response_envelope)
    }

    fn is_revoked(&self) -> bool {
        self.revoked.load(Ordering::Acquire)
            || self.pairing_revision != crate::android_pairing::pairing_revision()
    }
}

pub(crate) struct AndroidE2eOutputCipher {
    instance_id: String,
    session_id: String,
    stream_nonce: String,
    keys: OutputKeys,
    next_request_sequence: u64,
    next_response_sequence: u64,
}

impl AndroidE2eOutputCipher {
    pub(crate) fn decrypt_request(
        &mut self,
        record: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, E2eError> {
        let plaintext = decrypt_output_request(
            &self.keys.a2d,
            &self.instance_id,
            &self.session_id,
            &self.stream_nonce,
            self.next_request_sequence,
            record,
        )
        .map_err(|_| E2eError::Invalid)?;
        self.next_request_sequence = self
            .next_request_sequence
            .checked_add(1)
            .ok_or(E2eError::Sequence)?;
        Ok(plaintext)
    }

    pub(crate) fn encrypt_response(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, E2eError> {
        let record = encrypt_output_response(
            &self.keys.d2a,
            &self.instance_id,
            &self.session_id,
            &self.stream_nonce,
            self.next_response_sequence,
            plaintext,
        )?;
        self.next_response_sequence = self
            .next_response_sequence
            .checked_add(1)
            .ok_or(E2eError::Sequence)?;
        Ok(record)
    }
}

#[cfg(test)]
pub(crate) struct AndroidE2eOutputTestPeer {
    instance_id: String,
    session_id: String,
    stream_nonce: String,
    keys: OutputKeys,
    next_request_sequence: u64,
    next_response_sequence: u64,
}

#[cfg(test)]
impl AndroidE2eOutputTestPeer {
    pub(crate) fn encrypt_request(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, AppError> {
        let record = encrypt_output_request(
            &self.keys.a2d,
            &self.instance_id,
            &self.session_id,
            &self.stream_nonce,
            self.next_request_sequence,
            plaintext,
        )?;
        self.next_request_sequence += 1;
        Ok(record)
    }

    pub(crate) fn decrypt_response(
        &mut self,
        record: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, AppError> {
        let plaintext = decrypt_output_response(
            &self.keys.d2a,
            &self.instance_id,
            &self.session_id,
            &self.stream_nonce,
            self.next_response_sequence,
            record,
        )?;
        self.next_response_sequence += 1;
        Ok(plaintext)
    }
}

#[cfg(test)]
pub(crate) async fn test_output_cipher_pair(
    now: u64,
    expires_at: u64,
) -> (
    Arc<AndroidE2eSession>,
    AndroidE2eOutputCipher,
    AndroidE2eOutputTestPeer,
) {
    let instance_id = "desktop-7".to_string();
    let session_id = URL_SAFE_NO_PAD.encode([9_u8; SESSION_ID_BYTES]);
    let stream_nonce = URL_SAFE_NO_PAD.encode([5_u8; OUTPUT_STREAM_NONCE_BYTES]);
    let key_fields = [
        "pairing",
        instance_id.as_str(),
        "client",
        "client-session",
        "server",
        session_id.as_str(),
    ];
    let server_session_keys = derive_session_keys(&[7_u8; 32], &key_fields).unwrap();
    let client_session_keys = derive_session_keys(&[7_u8; 32], &key_fields).unwrap();
    let client_output_keys = derive_output_keys(
        &client_session_keys,
        &instance_id,
        &session_id,
        &stream_nonce,
    )
    .unwrap();
    let session = Arc::new(AndroidE2eSession {
        instance_id: instance_id.clone(),
        session_id: session_id.clone(),
        pairing_revision: crate::android_pairing::pairing_revision(),
        expires_at: AtomicU64::new(expires_at),
        revoked: AtomicBool::new(false),
        state: AsyncMutex::new(SessionState {
            keys: server_session_keys,
            used_output_nonces: HashSet::new(),
            next_sequence: 0,
            last_request_digest: None,
            last_response: None,
        }),
    });
    let cipher = session
        .open_output_cipher(&stream_nonce, now)
        .await
        .unwrap();
    let peer = AndroidE2eOutputTestPeer {
        instance_id,
        session_id,
        stream_nonce,
        keys: client_output_keys,
        next_request_sequence: 0,
        next_response_sequence: 0,
    };
    (session, cipher, peer)
}

fn challenge_matches(challenge: &Challenge, request: &EstablishRequest) -> bool {
    challenge.request.version == request.version
        && challenge.request.instance_id == request.instance_id
        && challenge.request.pairing_id == request.pairing_id
        && challenge.request.client_nonce == request.client_nonce
        && challenge.request.client_session_nonce == request.client_session_nonce
}

fn validate_challenge_request(request: &ChallengeRequest) -> Result<(), E2eError> {
    if request.version != PROTOCOL_VERSION
        || !valid_instance_id(&request.instance_id)
        || !valid_base64url::<PAIRING_ID_BYTES>(&request.pairing_id)
        || !valid_base64url::<CLIENT_NONCE_BYTES>(&request.client_nonce)
        || !valid_base64url::<CLIENT_SESSION_NONCE_BYTES>(&request.client_session_nonce)
    {
        return Err(E2eError::Invalid);
    }
    Ok(())
}

fn validate_establish_request(request: &EstablishRequest) -> Result<(), E2eError> {
    validate_challenge_request(&ChallengeRequest {
        version: request.version,
        instance_id: request.instance_id.clone(),
        pairing_id: request.pairing_id.clone(),
        client_nonce: request.client_nonce.clone(),
        client_session_nonce: request.client_session_nonce.clone(),
    })?;
    if !valid_base64url::<CHALLENGE_ID_BYTES>(&request.challenge_id)
        || !valid_base64url::<32>(&request.client_proof)
    {
        return Err(E2eError::Invalid);
    }
    Ok(())
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;

#[path = "state_registry.rs"]
mod registry_impl;
