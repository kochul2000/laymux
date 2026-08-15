mod crypto;
mod state;
mod validation;

use serde::{Deserialize, Serialize};

pub use state::AndroidE2eState;
pub(crate) use state::{AndroidE2eOutputCipher, AndroidE2eSession};

pub(crate) const PROTOCOL_VERSION: u8 = 1;
pub(crate) const CHALLENGE_ID_BYTES: usize = 16;
pub(crate) const CLIENT_SESSION_NONCE_BYTES: usize = 16;
pub(crate) const SERVER_NONCE_BYTES: usize = 32;
pub(crate) const SESSION_ID_BYTES: usize = 16;
pub(crate) const CHALLENGE_TTL_SECONDS: u64 = 60;
pub(crate) const SESSION_INACTIVITY_TIMEOUT_SECONDS: u64 = 15 * 60;
pub(crate) const OUTPUT_STREAM_NONCE_BYTES: usize = 32;
pub(crate) const OUTPUT_RECORD_OPEN: u8 = 1;
pub(crate) const OUTPUT_RECORD_TEXT: u8 = 2;
pub(crate) const OUTPUT_RECORD_BINARY: u8 = 3;

pub(crate) const CHALLENGE_RESPONSE_DOMAIN: &[u8] = b"laymux.android-e2e.challenge.response.v1";
pub(crate) const ESTABLISH_REQUEST_DOMAIN: &[u8] = b"laymux.android-e2e.establish.request.v1";
pub(crate) const ESTABLISH_RESPONSE_DOMAIN: &[u8] = b"laymux.android-e2e.establish.response.v1";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChallengeRequest {
    pub version: u8,
    pub instance_id: String,
    pub pairing_id: String,
    pub client_nonce: String,
    pub client_session_nonce: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChallengeResponse {
    pub version: u8,
    pub instance_id: String,
    pub pairing_id: String,
    pub client_nonce: String,
    pub client_session_nonce: String,
    pub challenge_id: String,
    pub server_nonce: String,
    pub challenge_expires_at: u64,
    pub server_proof: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EstablishRequest {
    pub version: u8,
    pub instance_id: String,
    pub pairing_id: String,
    pub client_nonce: String,
    pub client_session_nonce: String,
    pub challenge_id: String,
    pub client_proof: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EstablishResponse {
    pub version: u8,
    pub instance_id: String,
    pub pairing_id: String,
    pub client_nonce: String,
    pub client_session_nonce: String,
    pub challenge_id: String,
    pub server_nonce: String,
    pub session_id: String,
    pub expires_at: u64,
    pub server_proof: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CipherEnvelope {
    pub version: u8,
    pub instance_id: String,
    pub session_id: String,
    pub sequence: u64,
    pub ciphertext: String,
}

#[derive(Debug)]
pub(crate) enum E2eError {
    Invalid,
    Expired,
    Sequence,
    Internal(crate::error::AppError),
}

impl From<crate::error::AppError> for E2eError {
    fn from(error: crate::error::AppError) -> Self {
        Self::Internal(error)
    }
}

fn proof_fields_challenge(response: &ChallengeResponse) -> [String; 7] {
    [
        response.pairing_id.clone(),
        response.instance_id.clone(),
        response.client_nonce.clone(),
        response.client_session_nonce.clone(),
        response.challenge_id.clone(),
        response.server_nonce.clone(),
        response.challenge_expires_at.to_string(),
    ]
}

fn proof_fields_establish(
    request: &EstablishRequest,
    server_nonce: &str,
    challenge_expires_at: u64,
) -> [String; 7] {
    [
        request.pairing_id.clone(),
        request.instance_id.clone(),
        request.client_nonce.clone(),
        request.client_session_nonce.clone(),
        request.challenge_id.clone(),
        server_nonce.to_string(),
        challenge_expires_at.to_string(),
    ]
}

fn proof_fields_response(response: &EstablishResponse) -> [String; 8] {
    [
        response.pairing_id.clone(),
        response.instance_id.clone(),
        response.client_nonce.clone(),
        response.client_session_nonce.clone(),
        response.challenge_id.clone(),
        response.server_nonce.clone(),
        response.session_id.clone(),
        response.expires_at.to_string(),
    ]
}

fn key_fields(response: &EstablishResponse) -> [&str; 6] {
    [
        &response.pairing_id,
        &response.instance_id,
        &response.client_nonce,
        &response.client_session_nonce,
        &response.server_nonce,
        &response.session_id,
    ]
}

fn field_refs<const N: usize>(fields: &[String; N]) -> Vec<&str> {
    fields.iter().map(String::as_str).collect()
}
