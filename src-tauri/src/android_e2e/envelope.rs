//! Binary Android E2E RPC request envelope (ADR-0351).
//!
//! `[format u8][sessionId 22 ASCII base64url][sequence u64 BE][ciphertext‖tag]`.
//! The format byte is not authenticated, but only one value is accepted, so
//! tampering can only make the request fail. `instanceId` is not on the wire:
//! the desktop binds the AAD to the instance of the session the `sessionId`
//! names.

use crate::constants::{ANDROID_E2E_AEAD_TAG_BYTES, ANDROID_E2E_RPC_ENVELOPE_PREFIX_BYTES};

use super::crypto::MAX_SEQUENCE;
use super::validation::valid_base64url;
use super::{E2eError, RPC_REQUEST_ENVELOPE_FORMAT, SESSION_ID_BYTES};

pub(crate) const RPC_ENVELOPE_PREFIX_BYTES: usize = ANDROID_E2E_RPC_ENVELOPE_PREFIX_BYTES;
const SESSION_ID_CHARS: usize = 22;
const SESSION_ID_OFFSET: usize = 1;
const SEQUENCE_OFFSET: usize = SESSION_ID_OFFSET + SESSION_ID_CHARS;

const _: () = assert!(SEQUENCE_OFFSET + 8 == RPC_ENVELOPE_PREFIX_BYTES);
const _: () = assert!(SESSION_ID_BYTES.div_ceil(3) * 4 - 2 == SESSION_ID_CHARS);
const _: () = assert!(super::crypto::TAG_BYTES == ANDROID_E2E_AEAD_TAG_BYTES);

/// Why a request envelope or its prefix was refused before AEAD.
#[derive(Debug)]
pub(crate) enum EnvelopeRejection {
    /// Wrong format byte, malformed `sessionId`, out-of-range sequence or a
    /// body too short to hold a tag. Not a session verdict.
    Malformed,
    /// The prefix named no live session, an expired one, or a sequence the
    /// session can no longer accept.
    Session(E2eError),
}

#[cfg(test)]
impl PartialEq for EnvelopeRejection {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Malformed, Self::Malformed) => true,
            (Self::Session(left), Self::Session(right)) => {
                std::mem::discriminant(left) == std::mem::discriminant(right)
            }
            _ => false,
        }
    }
}

/// Routing fields of the 31-byte prefix. Checking them is not authentication
/// (the relay sees `sessionId` too); AEAD remains the final verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RpcEnvelopePrefix {
    pub(crate) session_id: String,
    pub(crate) sequence: u64,
}

impl RpcEnvelopePrefix {
    /// Parse the first `RPC_ENVELOPE_PREFIX_BYTES` of a request body. Returns
    /// `None` while fewer bytes have arrived.
    pub(crate) fn parse(bytes: &[u8]) -> Option<Result<Self, EnvelopeRejection>> {
        let prefix = bytes.get(..RPC_ENVELOPE_PREFIX_BYTES)?;
        Some(Self::parse_complete(prefix))
    }

    fn parse_complete(prefix: &[u8]) -> Result<Self, EnvelopeRejection> {
        if prefix[0] != RPC_REQUEST_ENVELOPE_FORMAT {
            return Err(EnvelopeRejection::Malformed);
        }
        let session_id = std::str::from_utf8(&prefix[SESSION_ID_OFFSET..SEQUENCE_OFFSET])
            .ok()
            .filter(|value| valid_base64url::<SESSION_ID_BYTES>(value))
            .ok_or(EnvelopeRejection::Malformed)?
            .to_string();
        let mut sequence = [0_u8; 8];
        sequence.copy_from_slice(&prefix[SEQUENCE_OFFSET..RPC_ENVELOPE_PREFIX_BYTES]);
        let sequence = u64::from_be_bytes(sequence);
        if sequence > MAX_SEQUENCE {
            return Err(EnvelopeRejection::Malformed);
        }
        Ok(Self {
            session_id,
            sequence,
        })
    }
}

/// A complete binary request: prefix fields plus the raw ciphertext‖tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RpcRequestEnvelope {
    pub(crate) session_id: String,
    pub(crate) sequence: u64,
    pub(crate) ciphertext: Vec<u8>,
}

impl RpcRequestEnvelope {
    pub(crate) fn parse(body: &[u8]) -> Result<Self, EnvelopeRejection> {
        let prefix = RpcEnvelopePrefix::parse(body).ok_or(EnvelopeRejection::Malformed)??;
        let ciphertext = &body[RPC_ENVELOPE_PREFIX_BYTES..];
        if ciphertext.len() < ANDROID_E2E_AEAD_TAG_BYTES {
            return Err(EnvelopeRejection::Malformed);
        }
        Ok(Self {
            session_id: prefix.session_id,
            sequence: prefix.sequence,
            ciphertext: ciphertext.to_vec(),
        })
    }
}

#[cfg(test)]
pub(crate) fn encode_rpc_request(session_id: &str, sequence: u64, ciphertext: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(RPC_ENVELOPE_PREFIX_BYTES + ciphertext.len());
    body.push(RPC_REQUEST_ENVELOPE_FORMAT);
    body.extend_from_slice(session_id.as_bytes());
    body.extend_from_slice(&sequence.to_be_bytes());
    body.extend_from_slice(ciphertext);
    body
}

#[cfg(test)]
mod tests {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;

    use super::*;

    fn session_id() -> String {
        URL_SAFE_NO_PAD.encode([9_u8; SESSION_ID_BYTES])
    }

    #[test]
    fn byte_layout_matches_the_adr_table() {
        let body = encode_rpc_request(&session_id(), 0x0001_0203_0405_0607, &[0xAA; 16]);
        assert_eq!(body[0], 2);
        assert_eq!(&body[1..23], session_id().as_bytes());
        assert_eq!(&body[23..31], &[0, 1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(&body[31..], &[0xAA; 16]);
        assert_eq!(
            RpcRequestEnvelope::parse(&body).unwrap(),
            RpcRequestEnvelope {
                session_id: session_id(),
                sequence: 0x0001_0203_0405_0607,
                ciphertext: vec![0xAA; 16],
            }
        );
    }

    #[test]
    fn prefix_waits_for_31_bytes_then_decides() {
        let body = encode_rpc_request(&session_id(), 7, &[]);
        for len in 0..RPC_ENVELOPE_PREFIX_BYTES {
            assert_eq!(RpcEnvelopePrefix::parse(&body[..len]), None, "{len}");
        }
        assert_eq!(
            RpcEnvelopePrefix::parse(&body),
            Some(Ok(RpcEnvelopePrefix {
                session_id: session_id(),
                sequence: 7,
            }))
        );
    }

    #[test]
    fn only_format_two_is_accepted() {
        for format in [0_u8, 1, 3, b'{', 0xFF] {
            let mut body = encode_rpc_request(&session_id(), 0, &[0; 16]);
            body[0] = format;
            assert_eq!(
                RpcEnvelopePrefix::parse(&body),
                Some(Err(EnvelopeRejection::Malformed)),
                "{format}"
            );
            assert_eq!(
                RpcRequestEnvelope::parse(&body),
                Err(EnvelopeRejection::Malformed)
            );
        }
    }

    #[test]
    fn session_id_must_be_canonical_16_byte_base64url() {
        let mut non_canonical = session_id().into_bytes();
        // The final char of 16 bytes carries 4 padding bits; 'B' sets them.
        non_canonical[21] = b'B';
        let mut padded = session_id().into_bytes();
        padded[21] = b'=';
        let mut non_ascii = session_id().into_bytes();
        non_ascii[0] = 0xC3;
        for candidate in [non_canonical, padded, non_ascii, vec![b'.'; 22]] {
            let mut body = vec![RPC_REQUEST_ENVELOPE_FORMAT];
            body.extend_from_slice(&candidate);
            body.extend_from_slice(&0_u64.to_be_bytes());
            body.extend_from_slice(&[0; 16]);
            assert_eq!(
                RpcEnvelopePrefix::parse(&body),
                Some(Err(EnvelopeRejection::Malformed))
            );
        }
        // A shorter id shifts the sequence into the id field and fails the same way.
        let short = encode_rpc_request(&session_id()[..21], 0, &[0; 17]);
        assert_eq!(
            RpcEnvelopePrefix::parse(&short),
            Some(Err(EnvelopeRejection::Malformed))
        );
    }

    #[test]
    fn sequence_above_the_safe_integer_range_is_refused() {
        let at_max = encode_rpc_request(&session_id(), MAX_SEQUENCE, &[0; 16]);
        assert!(matches!(RpcEnvelopePrefix::parse(&at_max), Some(Ok(_))));
        let above = encode_rpc_request(&session_id(), MAX_SEQUENCE + 1, &[0; 16]);
        assert_eq!(
            RpcEnvelopePrefix::parse(&above),
            Some(Err(EnvelopeRejection::Malformed))
        );
    }

    #[test]
    fn complete_envelope_requires_at_least_a_tag() {
        let short = encode_rpc_request(&session_id(), 0, &[0; 15]);
        assert_eq!(
            RpcRequestEnvelope::parse(&short),
            Err(EnvelopeRejection::Malformed)
        );
        assert_eq!(
            RpcRequestEnvelope::parse(&short[..10]),
            Err(EnvelopeRejection::Malformed)
        );
        let tag_only = encode_rpc_request(&session_id(), 0, &[0; 16]);
        assert!(RpcRequestEnvelope::parse(&tag_only).is_ok());
    }

    #[test]
    fn legacy_json_envelope_is_refused() {
        let json = br#"{"version":1,"instanceId":"desktop-7","sessionId":"CQkJCQkJCQkJCQkJCQkJCQ","sequence":0,"ciphertext":"AAAA"}"#;
        assert_eq!(
            RpcRequestEnvelope::parse(json),
            Err(EnvelopeRejection::Malformed)
        );
    }
}
