use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

pub(super) fn valid_instance_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub(super) fn valid_base64url<const N: usize>(value: &str) -> bool {
    URL_SAFE_NO_PAD
        .decode(value)
        .is_ok_and(|decoded| decoded.len() == N && URL_SAFE_NO_PAD.encode(decoded) == value)
}
