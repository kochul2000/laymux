use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use crate::error::AppError;

pub(super) const KEY_BYTES: usize = 32;
pub(super) const PROOF_BYTES: usize = 32;
pub(super) const TAG_BYTES: usize = 16;
pub(super) const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;

const HKDF_SALT_DOMAIN: &[u8] = b"laymux.android-e2e.hkdf.salt.v1";
const A2D_INFO: &[u8] = b"laymux.android-e2e.a2d.v1";
const D2A_INFO: &[u8] = b"laymux.android-e2e.d2a.v1";
const A2D_AAD_DOMAIN: &[u8] = b"laymux.android-e2e.a2d.aad.v1";
const D2A_AAD_DOMAIN: &[u8] = b"laymux.android-e2e.d2a.aad.v1";
const OUTPUT_SALT_DOMAIN: &[u8] = b"laymux.android-e2e.output.hkdf.salt.v1";
const OUTPUT_A2D_INFO: &[u8] = b"laymux.android-e2e.output.a2d.v1";
const OUTPUT_D2A_INFO: &[u8] = b"laymux.android-e2e.output.d2a.v1";
const OUTPUT_A2D_AAD_DOMAIN: &[u8] = b"laymux.android-e2e.output.a2d.aad.v1";
const OUTPUT_D2A_AAD_DOMAIN: &[u8] = b"laymux.android-e2e.output.d2a.aad.v1";
const OUTPUT_RECORD_HEADER_BYTES: usize = 9;

pub(super) struct SessionKeys {
    pub(super) a2d: Zeroizing<[u8; KEY_BYTES]>,
    pub(super) d2a: Zeroizing<[u8; KEY_BYTES]>,
}

pub(super) struct OutputKeys {
    pub(super) a2d: Zeroizing<[u8; KEY_BYTES]>,
    pub(super) d2a: Zeroizing<[u8; KEY_BYTES]>,
}

pub(super) fn derive_output_keys(
    keys: &SessionKeys,
    instance_id: &str,
    session_id: &str,
    stream_nonce: &str,
) -> Result<OutputKeys, AppError> {
    let mut salt_input = Vec::with_capacity(192);
    salt_input.extend_from_slice(OUTPUT_SALT_DOMAIN);
    append_framed(&mut salt_input, &[instance_id, session_id, stream_nonce])?;
    let salt = Zeroizing::new(Sha256::digest(&salt_input).to_vec());
    salt_input.zeroize();

    let mut a2d = Zeroizing::new([0_u8; KEY_BYTES]);
    let mut d2a = Zeroizing::new([0_u8; KEY_BYTES]);
    Hkdf::<Sha256>::new(Some(&salt), keys.a2d.as_slice())
        .expand(OUTPUT_A2D_INFO, a2d.as_mut())
        .map_err(|_| AppError::Other("Android E2E output request key derivation failed".into()))?;
    Hkdf::<Sha256>::new(Some(&salt), keys.d2a.as_slice())
        .expand(OUTPUT_D2A_INFO, d2a.as_mut())
        .map_err(|_| AppError::Other("Android E2E output response key derivation failed".into()))?;
    Ok(OutputKeys { a2d, d2a })
}

pub(super) fn encrypt_output_response(
    key: &[u8; KEY_BYTES],
    instance_id: &str,
    session_id: &str,
    stream_nonce: &str,
    sequence: u64,
    plaintext: &[u8],
) -> Result<Vec<u8>, AppError> {
    encrypt_output_record(
        key,
        OUTPUT_D2A_AAD_DOMAIN,
        instance_id,
        session_id,
        stream_nonce,
        sequence,
        plaintext,
    )
}

pub(super) fn decrypt_output_request(
    key: &[u8; KEY_BYTES],
    instance_id: &str,
    session_id: &str,
    stream_nonce: &str,
    expected_sequence: u64,
    record: &[u8],
) -> Result<Zeroizing<Vec<u8>>, AppError> {
    decrypt_output_record(
        key,
        OUTPUT_A2D_AAD_DOMAIN,
        instance_id,
        session_id,
        stream_nonce,
        expected_sequence,
        record,
    )
}

#[cfg(test)]
pub(super) fn encrypt_output_request(
    key: &[u8; KEY_BYTES],
    instance_id: &str,
    session_id: &str,
    stream_nonce: &str,
    sequence: u64,
    plaintext: &[u8],
) -> Result<Vec<u8>, AppError> {
    encrypt_output_record(
        key,
        OUTPUT_A2D_AAD_DOMAIN,
        instance_id,
        session_id,
        stream_nonce,
        sequence,
        plaintext,
    )
}

#[cfg(test)]
pub(super) fn decrypt_output_response(
    key: &[u8; KEY_BYTES],
    instance_id: &str,
    session_id: &str,
    stream_nonce: &str,
    expected_sequence: u64,
    record: &[u8],
) -> Result<Zeroizing<Vec<u8>>, AppError> {
    decrypt_output_record(
        key,
        OUTPUT_D2A_AAD_DOMAIN,
        instance_id,
        session_id,
        stream_nonce,
        expected_sequence,
        record,
    )
}

fn encrypt_output_record(
    key: &[u8; KEY_BYTES],
    aad_domain: &[u8],
    instance_id: &str,
    session_id: &str,
    stream_nonce: &str,
    sequence: u64,
    plaintext: &[u8],
) -> Result<Vec<u8>, AppError> {
    validate_sequence(sequence)?;
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| AppError::Other("Android E2E output AES key is invalid".into()))?;
    let nonce = sequence_nonce(sequence);
    let aad = output_aad(aad_domain, instance_id, session_id, stream_nonce, sequence)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| AppError::Other("Android E2E output encryption failed".into()))?;
    let mut record = Vec::with_capacity(OUTPUT_RECORD_HEADER_BYTES + ciphertext.len());
    record.push(super::PROTOCOL_VERSION);
    record.extend_from_slice(&sequence.to_be_bytes());
    record.extend_from_slice(&ciphertext);
    Ok(record)
}

fn decrypt_output_record(
    key: &[u8; KEY_BYTES],
    aad_domain: &[u8],
    instance_id: &str,
    session_id: &str,
    stream_nonce: &str,
    expected_sequence: u64,
    record: &[u8],
) -> Result<Zeroizing<Vec<u8>>, AppError> {
    validate_sequence(expected_sequence)?;
    if record.len() < OUTPUT_RECORD_HEADER_BYTES + TAG_BYTES || record[0] != super::PROTOCOL_VERSION
    {
        return Err(AppError::Other(
            "Android E2E output record is invalid".into(),
        ));
    }
    let sequence = u64::from_be_bytes(
        record[1..OUTPUT_RECORD_HEADER_BYTES]
            .try_into()
            .map_err(|_| AppError::Other("Android E2E output record is invalid".into()))?,
    );
    if sequence != expected_sequence {
        return Err(AppError::Other(
            "Android E2E output record sequence is invalid".into(),
        ));
    }
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| AppError::Other("Android E2E output AES key is invalid".into()))?;
    let nonce = sequence_nonce(sequence);
    let aad = output_aad(aad_domain, instance_id, session_id, stream_nonce, sequence)?;
    cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &record[OUTPUT_RECORD_HEADER_BYTES..],
                aad: &aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| AppError::Other("Android E2E output authentication failed".into()))
}

fn output_aad(
    domain: &[u8],
    instance_id: &str,
    session_id: &str,
    stream_nonce: &str,
    sequence: u64,
) -> Result<Vec<u8>, AppError> {
    let mut aad = Vec::with_capacity(192);
    aad.extend_from_slice(domain);
    aad.push(super::PROTOCOL_VERSION);
    append_framed(&mut aad, &[instance_id, session_id, stream_nonce])?;
    aad.extend_from_slice(&sequence.to_be_bytes());
    Ok(aad)
}

pub(super) fn proof(seed: &[u8], domain: &[u8], fields: &[&str]) -> Result<String, AppError> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(seed)
        .map_err(|_| AppError::Other("Android E2E proof key is invalid".into()))?;
    mac.update(domain);
    update_framed(&mut mac, fields)?;
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

pub(super) fn verify_proof(
    seed: &[u8],
    domain: &[u8],
    fields: &[&str],
    provided: &str,
) -> Result<bool, AppError> {
    let decoded = match URL_SAFE_NO_PAD.decode(provided) {
        Ok(decoded)
            if decoded.len() == PROOF_BYTES && URL_SAFE_NO_PAD.encode(&decoded) == provided =>
        {
            Zeroizing::new(decoded)
        }
        _ => return Ok(false),
    };
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(seed)
        .map_err(|_| AppError::Other("Android E2E proof key is invalid".into()))?;
    mac.update(domain);
    update_framed(&mut mac, fields)?;
    Ok(mac.verify_slice(&decoded).is_ok())
}

pub(super) fn derive_session_keys(seed: &[u8], fields: &[&str]) -> Result<SessionKeys, AppError> {
    let mut salt_input = Vec::with_capacity(256);
    salt_input.extend_from_slice(HKDF_SALT_DOMAIN);
    append_framed(&mut salt_input, fields)?;
    let salt = Zeroizing::new(Sha256::digest(&salt_input).to_vec());
    salt_input.zeroize();

    let hkdf = Hkdf::<Sha256>::new(Some(&salt), seed);
    let mut a2d = Zeroizing::new([0_u8; KEY_BYTES]);
    let mut d2a = Zeroizing::new([0_u8; KEY_BYTES]);
    hkdf.expand(A2D_INFO, a2d.as_mut())
        .map_err(|_| AppError::Other("Android E2E request key derivation failed".into()))?;
    hkdf.expand(D2A_INFO, d2a.as_mut())
        .map_err(|_| AppError::Other("Android E2E response key derivation failed".into()))?;
    Ok(SessionKeys { a2d, d2a })
}

pub(super) fn encrypt_response(
    key: &[u8; KEY_BYTES],
    instance_id: &str,
    session_id: &str,
    sequence: u64,
    plaintext: &[u8],
) -> Result<String, AppError> {
    encrypt(
        key,
        D2A_AAD_DOMAIN,
        instance_id,
        session_id,
        sequence,
        plaintext,
    )
}

#[cfg(test)]
pub(super) fn encrypt_request(
    key: &[u8; KEY_BYTES],
    instance_id: &str,
    session_id: &str,
    sequence: u64,
    plaintext: &[u8],
) -> Result<String, AppError> {
    encrypt(
        key,
        A2D_AAD_DOMAIN,
        instance_id,
        session_id,
        sequence,
        plaintext,
    )
}

pub(super) fn decrypt_request(
    key: &[u8; KEY_BYTES],
    instance_id: &str,
    session_id: &str,
    sequence: u64,
    ciphertext: &str,
) -> Result<Zeroizing<Vec<u8>>, AppError> {
    decrypt(
        key,
        A2D_AAD_DOMAIN,
        instance_id,
        session_id,
        sequence,
        ciphertext,
    )
}

#[cfg(test)]
pub(super) fn decrypt_response(
    key: &[u8; KEY_BYTES],
    instance_id: &str,
    session_id: &str,
    sequence: u64,
    ciphertext: &str,
) -> Result<Zeroizing<Vec<u8>>, AppError> {
    decrypt(
        key,
        D2A_AAD_DOMAIN,
        instance_id,
        session_id,
        sequence,
        ciphertext,
    )
}

fn encrypt(
    key: &[u8; KEY_BYTES],
    aad_domain: &[u8],
    instance_id: &str,
    session_id: &str,
    sequence: u64,
    plaintext: &[u8],
) -> Result<String, AppError> {
    validate_sequence(sequence)?;
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| AppError::Other("Android E2E AES key is invalid".into()))?;
    let nonce = sequence_nonce(sequence);
    let aad = envelope_aad(aad_domain, instance_id, session_id, sequence)?;
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| AppError::Other("Android E2E encryption failed".into()))?;
    Ok(URL_SAFE_NO_PAD.encode(encrypted))
}

fn decrypt(
    key: &[u8; KEY_BYTES],
    aad_domain: &[u8],
    instance_id: &str,
    session_id: &str,
    sequence: u64,
    ciphertext: &str,
) -> Result<Zeroizing<Vec<u8>>, AppError> {
    validate_sequence(sequence)?;
    let encrypted = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(ciphertext)
            .map_err(|_| AppError::Other("Android E2E ciphertext is invalid".into()))?,
    );
    if encrypted.len() < TAG_BYTES || URL_SAFE_NO_PAD.encode(encrypted.as_slice()) != ciphertext {
        return Err(AppError::Other("Android E2E ciphertext is invalid".into()));
    }
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| AppError::Other("Android E2E AES key is invalid".into()))?;
    let nonce = sequence_nonce(sequence);
    let aad = envelope_aad(aad_domain, instance_id, session_id, sequence)?;
    cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: encrypted.as_slice(),
                aad: &aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| AppError::Other("Android E2E authentication failed".into()))
}

fn envelope_aad(
    domain: &[u8],
    instance_id: &str,
    session_id: &str,
    sequence: u64,
) -> Result<Vec<u8>, AppError> {
    let mut aad = Vec::with_capacity(128);
    aad.extend_from_slice(domain);
    aad.push(1);
    append_framed(&mut aad, &[instance_id, session_id])?;
    aad.extend_from_slice(&sequence.to_be_bytes());
    Ok(aad)
}

fn sequence_nonce(sequence: u64) -> [u8; 12] {
    let mut nonce = [0_u8; 12];
    nonce[4..].copy_from_slice(&sequence.to_be_bytes());
    nonce
}

fn validate_sequence(sequence: u64) -> Result<(), AppError> {
    if sequence > MAX_SEQUENCE {
        return Err(AppError::Other(
            "Android E2E sequence exceeds the JSON safe integer range".into(),
        ));
    }
    Ok(())
}

fn update_framed(mac: &mut Hmac<Sha256>, fields: &[&str]) -> Result<(), AppError> {
    for field in fields {
        let bytes = field.as_bytes();
        let length = u32::try_from(bytes.len())
            .map_err(|_| AppError::Other("Android E2E proof field is too long".into()))?;
        mac.update(&length.to_be_bytes());
        mac.update(bytes);
    }
    Ok(())
}

fn append_framed(target: &mut Vec<u8>, fields: &[&str]) -> Result<(), AppError> {
    for field in fields {
        let bytes = field.as_bytes();
        let length = u32::try_from(bytes.len())
            .map_err(|_| AppError::Other("Android E2E key field is too long".into()))?;
        target.extend_from_slice(&length.to_be_bytes());
        target.extend_from_slice(bytes);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directions_use_distinct_keys_and_authenticated_metadata() {
        let keys = derive_session_keys(
            &[7_u8; 32],
            &[
                "pair",
                "desktop-7",
                "owner",
                "client-session",
                "server",
                "session",
            ],
        )
        .unwrap();
        assert_ne!(keys.a2d.as_slice(), keys.d2a.as_slice());

        let request =
            encrypt_request(&keys.a2d, "desktop-7", "session", 0, br#"{"kind":"http"}"#).unwrap();
        assert_eq!(
            decrypt_request(&keys.a2d, "desktop-7", "session", 0, &request)
                .unwrap()
                .as_slice(),
            br#"{"kind":"http"}"#
        );
        assert!(decrypt_request(&keys.a2d, "desktop-8", "session", 0, &request).is_err());
        assert!(decrypt_request(&keys.a2d, "desktop-7", "session", 1, &request).is_err());
    }

    #[test]
    fn response_direction_cannot_decrypt_as_request() {
        let keys = derive_session_keys(&[1_u8; 32], &["p", "i", "c", "cs", "sn", "s"]).unwrap();
        let response = encrypt_response(&keys.d2a, "i", "s", 0, b"ok").unwrap();
        assert_eq!(
            decrypt_response(&keys.d2a, "i", "s", 0, &response)
                .unwrap()
                .as_slice(),
            b"ok"
        );
        assert!(decrypt_request(&keys.d2a, "i", "s", 0, &response).is_err());
    }

    #[test]
    fn output_records_are_binary_directional_and_bind_the_stream_nonce() {
        let session_keys =
            derive_session_keys(&[3_u8; 32], &["p", "desktop-7", "c", "cs", "sn", "s"]).unwrap();
        let stream_nonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
        let output_keys =
            derive_output_keys(&session_keys, "desktop-7", "s", stream_nonce).unwrap();
        assert_eq!(
            hex(output_keys.a2d.as_slice()),
            "e5df689e823e95d6a84af57c73af53e006598abd39838cc04c1c4057b13939e5"
        );
        assert_eq!(
            hex(output_keys.d2a.as_slice()),
            "3ea5a2e48f7b8a53e1c6369b6f3b560bc0bfa47c1ef92e50eef2c0d6f7e5ec76"
        );
        let request =
            encrypt_output_request(&output_keys.a2d, "desktop-7", "s", stream_nonce, 0, b"open")
                .unwrap();
        assert_eq!(request[0], super::super::PROTOCOL_VERSION);
        assert_eq!(&request[1..9], &0_u64.to_be_bytes());
        assert_eq!(
            decrypt_output_request(
                &output_keys.a2d,
                "desktop-7",
                "s",
                stream_nonce,
                0,
                &request,
            )
            .unwrap()
            .as_slice(),
            b"open"
        );
        assert!(decrypt_output_request(
            &output_keys.a2d,
            "desktop-7",
            "s",
            "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
            0,
            &request,
        )
        .is_err());

        let response = encrypt_output_response(
            &output_keys.d2a,
            "desktop-7",
            "s",
            stream_nonce,
            0,
            b"delta",
        )
        .unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(&request),
            "AQAAAAAAAAAAgeMMonNSHkfsnOec8CoqaqX6zbc"
        );
        assert_eq!(
            decrypt_output_response(
                &output_keys.d2a,
                "desktop-7",
                "s",
                stream_nonce,
                0,
                &response,
            )
            .unwrap()
            .as_slice(),
            b"delta"
        );
        assert!(decrypt_output_request(
            &output_keys.a2d,
            "desktop-7",
            "s",
            stream_nonce,
            0,
            &response,
        )
        .is_err());
    }

    #[test]
    fn matches_the_android_cross_platform_vector() {
        let seed: Vec<u8> = (0_u8..32).collect();
        let pairing_id = "AAECAwQFBgcICQoLDA0ODw";
        let instance_id = "desktop-7";
        let client_nonce = "EBESExQVFhcYGRobHB0eHw";
        let client_session_nonce = "ICEiIyQlJicoKSorLC0uLw";
        let challenge_id = "MDEyMzQ1Njc4OTo7PD0-Pw";
        let server_nonce = "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8";
        let session_id = "YGFiY2RlZmdoaWprbG1ubw";
        let challenge_fields = [
            pairing_id,
            instance_id,
            client_nonce,
            client_session_nonce,
            challenge_id,
            server_nonce,
            "1786500060",
        ];
        assert_eq!(
            proof(
                &seed,
                super::super::CHALLENGE_RESPONSE_DOMAIN,
                &challenge_fields,
            )
            .unwrap(),
            "wxWeT6f_QTcAE2z5QX5ZRJlbkekabc6q0w69JCQqMu8"
        );
        assert_eq!(
            proof(
                &seed,
                super::super::ESTABLISH_REQUEST_DOMAIN,
                &challenge_fields,
            )
            .unwrap(),
            "RRAE-GKCcgI3wsHoCJm1CiDR_QOQueTsl8SkCsyp6KU"
        );
        assert_eq!(
            proof(
                &seed,
                super::super::ESTABLISH_RESPONSE_DOMAIN,
                &[
                    pairing_id,
                    instance_id,
                    client_nonce,
                    client_session_nonce,
                    challenge_id,
                    server_nonce,
                    session_id,
                    "1786500900",
                ],
            )
            .unwrap(),
            "P6F7cZb9EgEcr5aSv3Rjs2joBZ_2DKQePB2vAvjCiGg"
        );
        let keys = derive_session_keys(
            &seed,
            &[
                pairing_id,
                instance_id,
                client_nonce,
                client_session_nonce,
                server_nonce,
                session_id,
            ],
        )
        .unwrap();
        assert_eq!(
            hex(keys.a2d.as_slice()),
            "79c2fc79d9701cb486b4c9210bd791dab19c98acd75e636aac50f732e96b9845"
        );
        assert_eq!(
            hex(keys.d2a.as_slice()),
            "d950a4153cbf38c88f83a6137fb7a502c33decaa9f064d94cde70ae57de859e2"
        );
        let plaintext =
            br#"{"kind":"http","method":"GET","path":"/remote/v1/terminals","body":null}"#;
        assert_eq!(
            encrypt_request(
                &keys.a2d,
                instance_id,
                session_id,
                0,
                plaintext,
            )
            .unwrap(),
            "6CTwoMBqwF3Hxw_Wl2PztwWSgH2AfeiT-NNpxoI1fjJz0wn0qLVsXbHwf98WpAjnFJOV9gQsr6pCaWMqCVlT7jGGLNwyAqv08KWyYuJVrAfzcd95fBkLOg"
        );
    }

    fn hex(bytes: &[u8]) -> String {
        use std::fmt::Write;

        let mut output = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            write!(&mut output, "{byte:02x}").unwrap();
        }
        output
    }
}
