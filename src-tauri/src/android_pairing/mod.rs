mod keyring_store;

use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use qrcode::render::svg;
use qrcode::QrCode;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use url::{Host, Url};
use zeroize::{Zeroize, Zeroizing};

use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::settings::models::RemoteSettings;
use crate::state::AppState;

const PAIRING_VERSION: u8 = 2;
const ACK_VERSION: u8 = 1;
const PAIRING_SECRET_BYTES: usize = 32;
const PAIRING_ID_BYTES: usize = 16;
const CLIENT_NONCE_BYTES: usize = 16;
const PROOF_BYTES: usize = 32;
const PAIRING_TTL_SECONDS: u64 = 5 * 60;
const MAX_INSTANCE_ID_BYTES: usize = 128;
const QR_MIN_DIMENSION: u32 = 320;
const REQUEST_PROOF_DOMAIN: &[u8] = b"laymux.android-pair.request.v1";
const RESPONSE_PROOF_DOMAIN: &[u8] = b"laymux.android-pair.response.v1";

/// Serializes the Android seed lifecycle with cloud identity replacement.
/// The nested lock order is this mutex, Android E2E registry, then
/// `AppState.remote_access` -> `AppState.remote_control` (ADR-0208).
static PAIRING_LIFECYCLE: Mutex<()> = Mutex::new(());
static PAIRING_REVISION: AtomicU64 = AtomicU64::new(1);

pub(crate) struct ConfirmedPairingMaterial {
    pub(crate) seed: Zeroizing<Vec<u8>>,
    pub(crate) revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidPairingStatus {
    pub paired: bool,
    pub phase: AndroidPairingPhase,
    pub endpoint: Option<String>,
    pub instance_id: Option<String>,
    pub expires_at: Option<u64>,
    pub confirmed_at: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AndroidPairingPhase {
    None,
    Pending,
    Confirmed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidPairingQr {
    pub status: AndroidPairingStatus,
    pub qr_svg: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredPairingRecordRef<'a> {
    version: u8,
    endpoint: &'a str,
    instance_id: &'a str,
    pairing_id: &'a str,
    expires_at: u64,
    secret: &'a str,
    client_nonce: Option<&'a str>,
    confirmed_at: Option<u64>,
}

#[derive(Deserialize, Zeroize)]
#[zeroize(drop)]
#[serde(rename_all = "camelCase")]
struct StoredPairingRecord {
    version: u8,
    endpoint: String,
    instance_id: String,
    pairing_id: String,
    expires_at: u64,
    secret: String,
    client_nonce: Option<String>,
    confirmed_at: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AndroidPairingAckRequest {
    pub version: u8,
    pub instance_id: String,
    pub pairing_id: String,
    pub client_nonce: String,
    pub client_proof: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AndroidPairingAckResponse {
    pub version: u8,
    pub instance_id: String,
    pub pairing_id: String,
    pub client_nonce: String,
    pub confirmed_at: u64,
    pub server_proof: String,
}

#[derive(Debug)]
pub(crate) enum AndroidPairingAckError {
    Invalid,
    Expired,
    AlreadyConfirmed,
    Internal(AppError),
}

struct PairingSource {
    endpoint: String,
    instance_id: String,
}

pub async fn get_status() -> Result<AndroidPairingStatus, AppError> {
    tokio::task::spawn_blocking(|| with_lifecycle(get_status_inner))
        .await
        .map_err(|error| AppError::Other(format!("Android pairing status task failed: {error}")))?
}

pub async fn create(state: Arc<AppState>) -> Result<AndroidPairingQr, AppError> {
    tokio::task::spawn_blocking(move || {
        with_lifecycle(|| {
            let (result, _payload) = create_inner_locked(&state)?;
            state.android_e2e.clear()?;
            Ok(result)
        })
    })
    .await
    .map_err(|error| AppError::Other(format!("Android pairing create task failed: {error}")))?
}

/// Dev-only variant of [`create`] that also returns the QR payload text so an
/// emulator can be paired without a camera (the payload is injected into the
/// debug app via an adb deep link). The payload carries the pairing secret,
/// so release builds refuse this outright — the secret leaves the process
/// only as a QR image there.
pub async fn create_with_payload(
    state: Arc<AppState>,
) -> Result<(AndroidPairingQr, Zeroizing<String>), AppError> {
    if !cfg!(debug_assertions) {
        return Err(AppError::Other(
            "Pairing payload export is a dev-build-only capability".into(),
        ));
    }
    tokio::task::spawn_blocking(move || {
        with_lifecycle(|| {
            let result = create_inner_locked(&state)?;
            state.android_e2e.clear()?;
            Ok(result)
        })
    })
    .await
    .map_err(|error| AppError::Other(format!("Android pairing create task failed: {error}")))?
}

pub async fn revoke(state: Arc<AppState>) -> Result<AndroidPairingStatus, AppError> {
    tokio::task::spawn_blocking(move || {
        with_lifecycle(|| {
            let result = revoke_inner()?;
            state.android_e2e.clear()?;
            Ok(result)
        })
    })
    .await
    .map_err(|error| AppError::Other(format!("Android pairing revoke task failed: {error}")))?
}

pub(crate) async fn confirm(
    request: AndroidPairingAckRequest,
) -> Result<AndroidPairingAckResponse, AndroidPairingAckError> {
    tokio::task::spawn_blocking(move || {
        let _guard = PAIRING_LIFECYCLE
            .lock_or_err()
            .map_err(AndroidPairingAckError::Internal)?;
        let now = unix_time_now().map_err(AndroidPairingAckError::Internal)?;
        confirm_inner_at(&request, now)
    })
    .await
    .map_err(|error| {
        AndroidPairingAckError::Internal(AppError::Other(format!(
            "Android pairing ACK task failed: {error}"
        )))
    })?
}

pub(crate) fn with_lifecycle<T>(
    operation: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    let _guard = PAIRING_LIFECYCLE.lock_or_err()?;
    operation()
}

pub(crate) fn pairing_revision() -> u64 {
    PAIRING_REVISION.load(Ordering::Acquire)
}

pub(crate) fn load_confirmed_material(
    instance_id: &str,
    pairing_id: &str,
    client_nonce: &str,
) -> Result<ConfirmedPairingMaterial, AppError> {
    with_lifecycle(|| {
        let encoded_record = keyring_store::get_record()?
            .ok_or_else(|| AppError::Other("Android pairing is not confirmed".into()))?;
        let encoded_record = Zeroizing::new(encoded_record);
        let record: StoredPairingRecord = serde_json::from_str(&encoded_record)
            .map_err(|_| AppError::Other("Stored Android pairing is invalid".into()))?;
        validate_stored_record(&record)?;
        if record.confirmed_at.is_none()
            || record.instance_id != instance_id
            || record.pairing_id != pairing_id
            || record.client_nonce.as_deref() != Some(client_nonce)
        {
            return Err(AppError::Other("Android pairing is not confirmed".into()));
        }
        Ok(ConfirmedPairingMaterial {
            seed: decode_base64url_exact::<PAIRING_SECRET_BYTES>(&record.secret)?,
            revision: pairing_revision(),
        })
    })
}

fn advance_pairing_revision() {
    PAIRING_REVISION.fetch_add(1, Ordering::AcqRel);
}

pub(crate) fn get_status_inner() -> Result<AndroidPairingStatus, AppError> {
    get_status_inner_at(unix_time_now()?)
}

fn get_status_inner_at(now: u64) -> Result<AndroidPairingStatus, AppError> {
    let Some(encoded_record) = keyring_store::get_record()? else {
        return Ok(empty_status());
    };
    let encoded_record = Zeroizing::new(encoded_record);
    let record: StoredPairingRecord = serde_json::from_str(&encoded_record)
        .map_err(|_| AppError::Other("Stored Android pairing is invalid".into()))?;
    validate_stored_record(&record)?;
    if record.confirmed_at.is_none() && now >= record.expires_at {
        keyring_store::delete_record()?;
        advance_pairing_revision();
        return Ok(empty_status());
    }
    Ok(status_from_record(&record))
}

fn create_inner_locked(
    state: &AppState,
) -> Result<(AndroidPairingQr, Zeroizing<String>), AppError> {
    let settings =
        crate::remote_server::effective_remote_settings(state).map_err(AppError::Other)?;
    create_for_settings(&settings)
}

#[cfg(test)]
fn create_inner_with_hook(
    state: &AppState,
    after_settings_loaded: impl FnOnce(),
) -> Result<(AndroidPairingQr, Zeroizing<String>), AppError> {
    with_lifecycle(|| {
        let settings =
            crate::remote_server::effective_remote_settings(state).map_err(AppError::Other)?;
        after_settings_loaded();
        create_for_settings(&settings)
    })
}

fn create_for_settings(
    settings: &RemoteSettings,
) -> Result<(AndroidPairingQr, Zeroizing<String>), AppError> {
    let mut seed = [0_u8; PAIRING_SECRET_BYTES];
    let mut pairing_id = [0_u8; PAIRING_ID_BYTES];
    let result = (|| {
        getrandom::fill(&mut seed).map_err(|error| {
            AppError::Other(format!("Secure random generation failed: {error}"))
        })?;
        getrandom::fill(&mut pairing_id).map_err(|error| {
            AppError::Other(format!("Secure random generation failed: {error}"))
        })?;
        create_for_settings_with_material(settings, &seed, &pairing_id, unix_time_now()?)
    })();
    seed.zeroize();
    pairing_id.zeroize();
    result
}

#[cfg(test)]
fn create_for_settings_with_seed(
    settings: &RemoteSettings,
    seed: &[u8; PAIRING_SECRET_BYTES],
) -> Result<(AndroidPairingQr, Zeroizing<String>), AppError> {
    create_for_settings_with_material(settings, seed, &[42_u8; PAIRING_ID_BYTES], unix_time_now()?)
}

fn create_for_settings_with_material(
    settings: &RemoteSettings,
    seed: &[u8; PAIRING_SECRET_BYTES],
    pairing_id_bytes: &[u8; PAIRING_ID_BYTES],
    issued_at: u64,
) -> Result<(AndroidPairingQr, Zeroizing<String>), AppError> {
    let source = pairing_source(settings)?;
    let expires_at = issued_at
        .checked_add(PAIRING_TTL_SECONDS)
        .ok_or_else(|| AppError::Other("Android pairing expiry overflowed".into()))?;
    let secret = Zeroizing::new(URL_SAFE_NO_PAD.encode(seed));
    let pairing_id = URL_SAFE_NO_PAD.encode(pairing_id_bytes);
    let payload = Zeroizing::new(build_payload(&source, &pairing_id, expires_at, &secret));
    let qr_svg = render_qr_svg(&payload)?;
    let record = Zeroizing::new(serde_json::to_string(&StoredPairingRecordRef {
        version: PAIRING_VERSION,
        endpoint: &source.endpoint,
        instance_id: &source.instance_id,
        pairing_id: &pairing_id,
        expires_at,
        secret: &secret,
        client_nonce: None,
        confirmed_at: None,
    })?);

    keyring_store::set_record(&record)?;
    advance_pairing_revision();
    Ok((
        AndroidPairingQr {
            status: AndroidPairingStatus {
                paired: true,
                phase: AndroidPairingPhase::Pending,
                endpoint: Some(source.endpoint),
                instance_id: Some(source.instance_id),
                expires_at: Some(expires_at),
                confirmed_at: None,
            },
            qr_svg,
        },
        payload,
    ))
}

pub(crate) fn revoke_inner() -> Result<AndroidPairingStatus, AppError> {
    keyring_store::delete_record()?;
    advance_pairing_revision();
    Ok(empty_status())
}

#[cfg(test)]
pub(crate) fn seed_mock_pairing(settings: &RemoteSettings) -> Result<(), AppError> {
    keyring_store::reset_mock_store()?;
    create_for_settings_with_seed(settings, &[9; PAIRING_SECRET_BYTES])?;
    Ok(())
}

fn empty_status() -> AndroidPairingStatus {
    AndroidPairingStatus {
        paired: false,
        phase: AndroidPairingPhase::None,
        endpoint: None,
        instance_id: None,
        expires_at: None,
        confirmed_at: None,
    }
}

fn status_from_record(record: &StoredPairingRecord) -> AndroidPairingStatus {
    let phase = if record.confirmed_at.is_some() {
        AndroidPairingPhase::Confirmed
    } else {
        AndroidPairingPhase::Pending
    };
    AndroidPairingStatus {
        // Backward-compatible presence bit; `phase` distinguishes pending
        // from mutually confirmed.
        paired: true,
        phase,
        endpoint: Some(record.endpoint.clone()),
        instance_id: Some(record.instance_id.clone()),
        expires_at: Some(record.expires_at),
        confirmed_at: record.confirmed_at,
    }
}

fn pairing_source(settings: &RemoteSettings) -> Result<PairingSource, AppError> {
    if !settings.cloud_enabled {
        return Err(AppError::Other(
            "Cloud Remote must be paired before creating an Android pairing QR".into(),
        ));
    }
    let endpoint = settings
        .cloud_server_base_url
        .as_deref()
        .ok_or_else(|| AppError::Other("Cloud server origin is unavailable".into()))?;
    let instance_id = settings
        .cloud_instance_id
        .as_deref()
        .ok_or_else(|| AppError::Other("Cloud instance ID is unavailable".into()))?;
    let endpoint = validate_endpoint(endpoint, cfg!(debug_assertions))?;
    validate_instance_id(instance_id)?;
    Ok(PairingSource {
        endpoint,
        instance_id: instance_id.to_string(),
    })
}

fn validate_endpoint(raw: &str, allow_loopback_http: bool) -> Result<String, AppError> {
    let parsed =
        Url::parse(raw).map_err(|_| AppError::Other("Cloud server origin is invalid".into()))?;
    let host = parsed
        .host()
        .ok_or_else(|| AppError::Other("Cloud server origin has no host".into()))?;
    let loopback_host = match host {
        Host::Ipv4(address) => address == Ipv4Addr::LOCALHOST,
        Host::Ipv6(address) => address == Ipv6Addr::LOCALHOST,
        Host::Domain(_) => false,
    };
    let loopback_http = allow_loopback_http && parsed.scheme() == "http" && loopback_host;
    if (parsed.scheme() != "https" && !loopback_http)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        return Err(AppError::Other(
            "Cloud server must be an HTTPS origin".into(),
        ));
    }
    Ok(format!("{}/", parsed.origin().ascii_serialization()))
}

fn validate_instance_id(value: &str) -> Result<(), AppError> {
    let bytes = value.as_bytes();
    let valid = !bytes.is_empty()
        && bytes.len() <= MAX_INSTANCE_ID_BYTES
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(AppError::Other("Cloud instance ID is invalid".into()))
    }
}

fn build_payload(
    source: &PairingSource,
    pairing_id: &str,
    expires_at: u64,
    secret: &str,
) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("endpoint", &source.endpoint)
        .append_pair("instance", &source.instance_id)
        .append_pair("pairing", pairing_id)
        .append_pair("expires", &expires_at.to_string())
        .append_pair("secret", secret)
        .finish();
    format!("laymux://pair/v2?{query}")
}

fn render_qr_svg(payload: &str) -> Result<String, AppError> {
    let code = QrCode::new(payload.as_bytes())
        .map_err(|error| AppError::Other(format!("Pairing QR encoding failed: {error}")))?;
    Ok(code
        .render::<svg::Color>()
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .min_dimensions(QR_MIN_DIMENSION, QR_MIN_DIMENSION)
        .quiet_zone(true)
        .build())
}

fn validate_stored_record(record: &StoredPairingRecord) -> Result<(), AppError> {
    if record.version != PAIRING_VERSION {
        return Err(AppError::Other(
            "Stored Android pairing version is unsupported".into(),
        ));
    }
    validate_endpoint(&record.endpoint, cfg!(debug_assertions))?;
    validate_instance_id(&record.instance_id)?;
    decode_base64url_exact::<PAIRING_ID_BYTES>(&record.pairing_id)?;
    decode_base64url_exact::<PAIRING_SECRET_BYTES>(&record.secret)?;
    if record.expires_at == 0
        || record.client_nonce.is_some() != record.confirmed_at.is_some()
        || record
            .confirmed_at
            .is_some_and(|confirmed_at| confirmed_at == 0)
    {
        return Err(AppError::Other("Stored Android pairing is invalid".into()));
    }
    if let Some(client_nonce) = &record.client_nonce {
        decode_base64url_exact::<CLIENT_NONCE_BYTES>(client_nonce)?;
    }
    Ok(())
}

fn confirm_inner_at(
    request: &AndroidPairingAckRequest,
    now: u64,
) -> Result<AndroidPairingAckResponse, AndroidPairingAckError> {
    validate_ack_request(request)?;
    let encoded_record = keyring_store::get_record()
        .map_err(AndroidPairingAckError::Internal)?
        .ok_or(AndroidPairingAckError::Invalid)?;
    let encoded_record = Zeroizing::new(encoded_record);
    let mut record: StoredPairingRecord = serde_json::from_str(&encoded_record).map_err(|_| {
        AndroidPairingAckError::Internal(AppError::Other(
            "Stored Android pairing is invalid".into(),
        ))
    })?;
    validate_stored_record(&record).map_err(AndroidPairingAckError::Internal)?;
    if request.instance_id != record.instance_id || request.pairing_id != record.pairing_id {
        return Err(AndroidPairingAckError::Invalid);
    }
    if record.confirmed_at.is_none() && now >= record.expires_at {
        keyring_store::delete_record().map_err(AndroidPairingAckError::Internal)?;
        advance_pairing_revision();
        return Err(AndroidPairingAckError::Expired);
    }

    let seed = decode_base64url_exact::<PAIRING_SECRET_BYTES>(&record.secret)
        .map_err(AndroidPairingAckError::Internal)?;
    verify_request_proof(&seed, request)?;

    if let (Some(stored_nonce), Some(confirmed_at)) =
        (record.client_nonce.as_deref(), record.confirmed_at)
    {
        if stored_nonce != request.client_nonce {
            return Err(AndroidPairingAckError::AlreadyConfirmed);
        }
        return build_ack_response(&seed, request, confirmed_at)
            .map_err(AndroidPairingAckError::Internal);
    }

    record.client_nonce = Some(request.client_nonce.clone());
    record.confirmed_at = Some(now);
    let updated_record =
        Zeroizing::new(serialize_stored_record(&record).map_err(AndroidPairingAckError::Internal)?);
    keyring_store::set_record(&updated_record).map_err(AndroidPairingAckError::Internal)?;
    advance_pairing_revision();
    build_ack_response(&seed, request, now).map_err(AndroidPairingAckError::Internal)
}

fn validate_ack_request(request: &AndroidPairingAckRequest) -> Result<(), AndroidPairingAckError> {
    if request.version != ACK_VERSION {
        return Err(AndroidPairingAckError::Invalid);
    }
    validate_instance_id(&request.instance_id).map_err(|_| AndroidPairingAckError::Invalid)?;
    decode_base64url_exact::<PAIRING_ID_BYTES>(&request.pairing_id)
        .map_err(|_| AndroidPairingAckError::Invalid)?;
    decode_base64url_exact::<CLIENT_NONCE_BYTES>(&request.client_nonce)
        .map_err(|_| AndroidPairingAckError::Invalid)?;
    decode_base64url_exact::<PROOF_BYTES>(&request.client_proof)
        .map_err(|_| AndroidPairingAckError::Invalid)?;
    Ok(())
}

fn verify_request_proof(
    seed: &[u8],
    request: &AndroidPairingAckRequest,
) -> Result<(), AndroidPairingAckError> {
    let provided = decode_base64url_exact::<PROOF_BYTES>(&request.client_proof)
        .map_err(|_| AndroidPairingAckError::Invalid)?;
    let mac = proof_mac(
        seed,
        REQUEST_PROOF_DOMAIN,
        [
            &request.pairing_id,
            &request.instance_id,
            &request.client_nonce,
        ],
    )
    .map_err(AndroidPairingAckError::Internal)?;
    mac.verify_slice(&provided)
        .map_err(|_| AndroidPairingAckError::Invalid)
}

fn build_ack_response(
    seed: &[u8],
    request: &AndroidPairingAckRequest,
    confirmed_at: u64,
) -> Result<AndroidPairingAckResponse, AppError> {
    Ok(AndroidPairingAckResponse {
        version: ACK_VERSION,
        instance_id: request.instance_id.clone(),
        pairing_id: request.pairing_id.clone(),
        client_nonce: request.client_nonce.clone(),
        confirmed_at,
        server_proof: response_proof(
            seed,
            &request.pairing_id,
            &request.instance_id,
            &request.client_nonce,
            confirmed_at,
        )?,
    })
}

#[cfg(test)]
fn request_proof(
    seed: &[u8],
    pairing_id: &str,
    instance_id: &str,
    client_nonce: &str,
) -> Result<String, AppError> {
    Ok(URL_SAFE_NO_PAD.encode(
        proof_mac(
            seed,
            REQUEST_PROOF_DOMAIN,
            [pairing_id, instance_id, client_nonce],
        )?
        .finalize()
        .into_bytes(),
    ))
}

fn response_proof(
    seed: &[u8],
    pairing_id: &str,
    instance_id: &str,
    client_nonce: &str,
    confirmed_at: u64,
) -> Result<String, AppError> {
    let confirmed_at = confirmed_at.to_string();
    Ok(URL_SAFE_NO_PAD.encode(
        proof_mac(
            seed,
            RESPONSE_PROOF_DOMAIN,
            [pairing_id, instance_id, client_nonce, confirmed_at.as_str()],
        )?
        .finalize()
        .into_bytes(),
    ))
}

fn proof_mac<const N: usize>(
    seed: &[u8],
    domain: &[u8],
    fields: [&str; N],
) -> Result<Hmac<Sha256>, AppError> {
    let mut mac = Hmac::<Sha256>::new_from_slice(seed)
        .map_err(|_| AppError::Other("Android pairing HMAC key is invalid".into()))?;
    mac.update(domain);
    for field in fields {
        let bytes = field.as_bytes();
        let length = u32::try_from(bytes.len())
            .map_err(|_| AppError::Other("Android pairing HMAC field is too long".into()))?;
        mac.update(&length.to_be_bytes());
        mac.update(bytes);
    }
    Ok(mac)
}

fn decode_base64url_exact<const N: usize>(value: &str) -> Result<Zeroizing<Vec<u8>>, AppError> {
    let decoded = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| AppError::Other("Stored Android pairing is invalid".into()))?,
    );
    if decoded.len() != N || URL_SAFE_NO_PAD.encode(decoded.as_slice()) != value {
        return Err(AppError::Other("Stored Android pairing is invalid".into()));
    }
    Ok(decoded)
}

fn serialize_stored_record(record: &StoredPairingRecord) -> Result<String, AppError> {
    Ok(serde_json::to_string(&StoredPairingRecordRef {
        version: record.version,
        endpoint: &record.endpoint,
        instance_id: &record.instance_id,
        pairing_id: &record.pairing_id,
        expires_at: record.expires_at,
        secret: &record.secret,
        client_nonce: record.client_nonce.as_deref(),
        confirmed_at: record.confirmed_at,
    })?)
}

fn unix_time_now() -> Result<u64, AppError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| AppError::Other("System clock is before Unix epoch".into()))
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::path::Path;
    use std::sync::{mpsc, Barrier};
    use std::thread;
    use std::time::Duration;

    use serial_test::serial;

    use super::*;
    use crate::cloud::pairing::{persist_pairing_result, PairCompleteResponse};
    use crate::settings::{save_settings, Settings};

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvVarGuard {
        fn set_path(key: &'static str, value: &Path) -> Self {
            let previous = env::var(key).ok();
            env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                env::set_var(self.key, previous);
            } else {
                env::remove_var(self.key);
            }
        }
    }

    #[cfg(target_os = "windows")]
    fn isolate_settings_dir(dir: &Path) -> EnvVarGuard {
        EnvVarGuard::set_path("APPDATA", dir)
    }

    #[cfg(not(target_os = "windows"))]
    fn isolate_settings_dir(dir: &Path) -> EnvVarGuard {
        EnvVarGuard::set_path("HOME", dir)
    }

    fn paired_settings() -> RemoteSettings {
        RemoteSettings {
            cloud_enabled: true,
            cloud_instance_id: Some("desktop-7".into()),
            cloud_server_base_url: Some("https://relay.example.test".into()),
            ..RemoteSettings::default()
        }
    }

    fn assert_cloud_transition_waits_for_in_flight_create(
        transition: impl FnOnce(Arc<AppState>) -> Result<(), AppError> + Send + 'static,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let _env_guard = isolate_settings_dir(dir.path());
        keyring_store::reset_mock_store().unwrap();
        let settings = Settings {
            remote: paired_settings(),
            ..Settings::default()
        };
        save_settings(&settings).unwrap();
        let state = Arc::new(AppState::new());

        let (snapshot_tx, snapshot_rx) = mpsc::channel();
        let continue_create = Arc::new(Barrier::new(2));
        let create_state = state.clone();
        let create_barrier = continue_create.clone();
        let create_thread = thread::spawn(move || {
            create_inner_with_hook(&create_state, || {
                snapshot_tx.send(()).unwrap();
                create_barrier.wait();
            })
        });
        snapshot_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        let (transition_tx, transition_rx) = mpsc::channel();
        let transition_state = state.clone();
        thread::spawn(move || {
            transition_tx.send(transition(transition_state)).unwrap();
        });

        let early_transition = transition_rx.recv_timeout(Duration::from_millis(100)).ok();
        let transition_waited = early_transition.is_none();
        continue_create.wait();
        create_thread.join().unwrap().unwrap();
        let transition_result = match early_transition {
            Some(result) => result,
            None => transition_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        };
        transition_result.unwrap();

        assert!(
            transition_waited,
            "cloud identity transition must wait for the in-flight QR create"
        );
        assert!(!get_status_inner().unwrap().paired);
    }

    #[test]
    fn payload_matches_the_android_v2_contract_with_five_minute_expiry() {
        let source = PairingSource {
            endpoint: "https://relay.example.test/".into(),
            instance_id: "desktop-7".into(),
        };
        let secret = URL_SAFE_NO_PAD.encode([7_u8; PAIRING_SECRET_BYTES]);
        let pairing_id = URL_SAFE_NO_PAD.encode([8_u8; PAIRING_ID_BYTES]);

        let payload = build_payload(&source, &pairing_id, 1_786_500_300, &secret);

        assert_eq!(
            payload,
            format!(
                "laymux://pair/v2?endpoint=https%3A%2F%2Frelay.example.test%2F&instance=desktop-7&pairing={pairing_id}&expires=1786500300&secret={secret}"
            )
        );
    }

    #[test]
    fn hmac_proofs_match_the_cross_platform_test_vector() {
        let seed: Vec<u8> = (0_u8..32).collect();
        let pairing_id = "EBESExQVFhcYGRobHB0eHw";
        let client_nonce = "ICEiIyQlJicoKSorLC0uLw";

        assert_eq!(
            request_proof(&seed, pairing_id, "desktop-7", client_nonce).unwrap(),
            "VCLjMKeN3kuPYo0PZv1B_5u-reuVTjOjVBW9AFmZbD0"
        );
        assert_eq!(
            response_proof(&seed, pairing_id, "desktop-7", client_nonce, 1_786_500_000,).unwrap(),
            "uPqJodeWKRiXPi08V_o8JQznMtxtHZF6ZQNEKB0oL_g"
        );
    }

    #[test]
    #[serial]
    fn pending_invitation_expires_authoritatively_and_is_deleted() {
        keyring_store::reset_mock_store().unwrap();
        let seed = [5_u8; PAIRING_SECRET_BYTES];
        let pairing_id_bytes = [6_u8; PAIRING_ID_BYTES];
        let pairing_id = URL_SAFE_NO_PAD.encode(pairing_id_bytes);
        create_for_settings_with_material(&paired_settings(), &seed, &pairing_id_bytes, 1_000)
            .unwrap();
        let client_nonce = URL_SAFE_NO_PAD.encode([7_u8; CLIENT_NONCE_BYTES]);
        let request = AndroidPairingAckRequest {
            version: ACK_VERSION,
            instance_id: "desktop-7".into(),
            pairing_id,
            client_nonce: client_nonce.clone(),
            client_proof: request_proof(
                &seed,
                &URL_SAFE_NO_PAD.encode(pairing_id_bytes),
                "desktop-7",
                &client_nonce,
            )
            .unwrap(),
        };

        assert!(matches!(
            confirm_inner_at(&request, 1_300),
            Err(AndroidPairingAckError::Expired)
        ));
        assert_eq!(get_status_inner_at(1_300).unwrap(), empty_status());
        assert!(keyring_store::get_record().unwrap().is_none());
    }

    #[test]
    #[serial]
    fn first_client_nonce_wins_and_same_nonce_retry_is_idempotent() {
        keyring_store::reset_mock_store().unwrap();
        let seed = [11_u8; PAIRING_SECRET_BYTES];
        let pairing_id_bytes = [12_u8; PAIRING_ID_BYTES];
        let pairing_id = URL_SAFE_NO_PAD.encode(pairing_id_bytes);
        create_for_settings_with_material(&paired_settings(), &seed, &pairing_id_bytes, 1_000)
            .unwrap();
        let first_nonce = URL_SAFE_NO_PAD.encode([13_u8; CLIENT_NONCE_BYTES]);
        let first = ack_request(&seed, &pairing_id, &first_nonce);

        let confirmed = confirm_inner_at(&first, 1_100).unwrap();
        let retried = confirm_inner_at(&first, 1_250).unwrap();

        assert_eq!(confirmed, retried);
        assert_eq!(confirmed.confirmed_at, 1_100);
        assert_eq!(
            get_status_inner_at(1_400).unwrap().phase,
            AndroidPairingPhase::Confirmed
        );

        let second_nonce = URL_SAFE_NO_PAD.encode([14_u8; CLIENT_NONCE_BYTES]);
        let second = ack_request(&seed, &pairing_id, &second_nonce);
        assert!(matches!(
            confirm_inner_at(&second, 1_200),
            Err(AndroidPairingAckError::AlreadyConfirmed)
        ));
    }

    fn ack_request(
        seed: &[u8; PAIRING_SECRET_BYTES],
        pairing_id: &str,
        client_nonce: &str,
    ) -> AndroidPairingAckRequest {
        AndroidPairingAckRequest {
            version: ACK_VERSION,
            instance_id: "desktop-7".into(),
            pairing_id: pairing_id.into(),
            client_nonce: client_nonce.into(),
            client_proof: request_proof(seed, pairing_id, "desktop-7", client_nonce).unwrap(),
        }
    }

    #[test]
    fn production_contract_rejects_non_https_and_non_origin_endpoints() {
        assert!(validate_endpoint("http://relay.example.test", false).is_err());
        assert!(validate_endpoint("https://relay.example.test/path", false).is_err());
        assert!(validate_endpoint("https://user@relay.example.test", false).is_err());
        assert_eq!(
            validate_endpoint("https://relay.example.test", false).unwrap(),
            "https://relay.example.test/"
        );
    }

    #[test]
    fn debug_contract_only_allows_loopback_http() {
        assert_eq!(
            validate_endpoint("http://127.0.0.1:8000", true).unwrap(),
            "http://127.0.0.1:8000/"
        );
        assert_eq!(
            validate_endpoint("http://[::1]:8000", true).unwrap(),
            "http://[::1]:8000/"
        );
        assert!(validate_endpoint("http://192.168.0.2:8000", true).is_err());
    }

    #[test]
    #[serial]
    fn cloud_disconnect_cannot_be_overtaken_by_an_in_flight_qr_create() {
        assert_cloud_transition_waits_for_in_flight_create(|state| {
            crate::cloud::commands::cloud_disconnect_inner(&state).map(drop)
        });
    }

    #[test]
    #[serial]
    fn cloud_identity_replacement_cannot_be_overtaken_by_an_in_flight_qr_create() {
        assert_cloud_transition_waits_for_in_flight_create(|state| {
            persist_pairing_result(
                &state,
                "https://new.example.test",
                PairCompleteResponse {
                    instance_id: "desktop-8".into(),
                    device_token: "device-token-8".into(),
                    tunnel_url: "wss://new.example.test/tunnel/desktop-8".into(),
                    server_base_url: "https://new.example.test".into(),
                    device_token_expires_at: None,
                },
            )
            .map(drop)
        });
    }

    #[test]
    #[serial]
    fn create_rotates_keyring_record_and_returns_only_svg_and_metadata() {
        keyring_store::reset_mock_store().unwrap();
        let settings = paired_settings();

        let (first, first_payload) =
            create_for_settings_with_seed(&settings, &[1; PAIRING_SECRET_BYTES]).unwrap();
        let first_record = keyring_store::get_record().unwrap().unwrap();
        let (second, _second_payload) =
            create_for_settings_with_seed(&settings, &[2; PAIRING_SECRET_BYTES]).unwrap();
        let second_record = keyring_store::get_record().unwrap().unwrap();

        assert!(first.qr_svg.starts_with("<?xml"));
        assert!(first.qr_svg.contains("<svg"));
        assert!(!first.qr_svg.contains("laymux://pair/v1"));
        assert!(first_payload.starts_with("laymux://pair/v2?"));
        assert_eq!(first.status, second.status);
        assert_ne!(first_record, second_record);
        // The serialized QR result (what the Tauri command returns) must not
        // leak the secret; only the dev-only payload carries it.
        assert!(!serde_json::to_string(&second).unwrap().contains("secret"));
    }

    #[test]
    #[serial]
    fn revoke_is_idempotent_and_removes_pairing_status() {
        keyring_store::reset_mock_store().unwrap();
        create_for_settings_with_seed(&paired_settings(), &[3; PAIRING_SECRET_BYTES]).unwrap();
        assert!(get_status_inner().unwrap().paired);

        assert_eq!(revoke_inner().unwrap(), empty_status());
        assert_eq!(revoke_inner().unwrap(), empty_status());
        assert_eq!(get_status_inner().unwrap(), empty_status());
    }

    #[test]
    fn cloud_pairing_is_required_before_qr_generation() {
        let error =
            create_for_settings_with_seed(&RemoteSettings::default(), &[4; PAIRING_SECRET_BYTES])
                .unwrap_err();

        assert!(error.to_string().contains("Cloud Remote"));
    }
}
