mod keyring_store;

use std::sync::Arc;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use qrcode::render::svg;
use qrcode::QrCode;
use serde::{Deserialize, Serialize};
use url::Url;
use zeroize::{Zeroize, Zeroizing};

use crate::error::AppError;
use crate::settings::models::RemoteSettings;
use crate::state::AppState;

const PAIRING_VERSION: u8 = 1;
const PAIRING_SECRET_BYTES: usize = 32;
const MAX_INSTANCE_ID_BYTES: usize = 128;
const QR_MIN_DIMENSION: u32 = 320;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidPairingStatus {
    pub paired: bool,
    pub endpoint: Option<String>,
    pub instance_id: Option<String>,
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
    secret: &'a str,
}

#[derive(Deserialize, Zeroize)]
#[zeroize(drop)]
#[serde(rename_all = "camelCase")]
struct StoredPairingRecord {
    version: u8,
    endpoint: String,
    instance_id: String,
    secret: String,
}

struct PairingSource {
    endpoint: String,
    instance_id: String,
}

pub async fn get_status() -> Result<AndroidPairingStatus, AppError> {
    tokio::task::spawn_blocking(get_status_inner)
        .await
        .map_err(|error| AppError::Other(format!("Android pairing status task failed: {error}")))?
}

pub async fn create(state: Arc<AppState>) -> Result<AndroidPairingQr, AppError> {
    let settings =
        crate::remote_server::effective_remote_settings(&state).map_err(AppError::Other)?;
    tokio::task::spawn_blocking(move || create_for_settings(&settings))
        .await
        .map_err(|error| AppError::Other(format!("Android pairing create task failed: {error}")))?
}

pub async fn revoke() -> Result<AndroidPairingStatus, AppError> {
    tokio::task::spawn_blocking(revoke_inner)
        .await
        .map_err(|error| AppError::Other(format!("Android pairing revoke task failed: {error}")))?
}

pub(crate) fn get_status_inner() -> Result<AndroidPairingStatus, AppError> {
    let Some(encoded_record) = keyring_store::get_record()? else {
        return Ok(empty_status());
    };
    let encoded_record = Zeroizing::new(encoded_record);
    let record: StoredPairingRecord = serde_json::from_str(&encoded_record)
        .map_err(|_| AppError::Other("Stored Android pairing is invalid".into()))?;
    validate_stored_record(&record)?;
    Ok(AndroidPairingStatus {
        paired: true,
        endpoint: Some(record.endpoint.clone()),
        instance_id: Some(record.instance_id.clone()),
    })
}

fn create_for_settings(settings: &RemoteSettings) -> Result<AndroidPairingQr, AppError> {
    let mut seed = [0_u8; PAIRING_SECRET_BYTES];
    getrandom::fill(&mut seed)
        .map_err(|error| AppError::Other(format!("Secure random generation failed: {error}")))?;
    let result = create_for_settings_with_seed(settings, &seed);
    seed.zeroize();
    result
}

fn create_for_settings_with_seed(
    settings: &RemoteSettings,
    seed: &[u8; PAIRING_SECRET_BYTES],
) -> Result<AndroidPairingQr, AppError> {
    let source = pairing_source(settings)?;
    let secret = Zeroizing::new(URL_SAFE_NO_PAD.encode(seed));
    let payload = Zeroizing::new(build_payload(&source, &secret));
    let qr_svg = render_qr_svg(&payload)?;
    let record = Zeroizing::new(serde_json::to_string(&StoredPairingRecordRef {
        version: PAIRING_VERSION,
        endpoint: &source.endpoint,
        instance_id: &source.instance_id,
        secret: &secret,
    })?);

    keyring_store::set_record(&record)?;
    Ok(AndroidPairingQr {
        status: AndroidPairingStatus {
            paired: true,
            endpoint: Some(source.endpoint),
            instance_id: Some(source.instance_id),
        },
        qr_svg,
    })
}

pub(crate) fn revoke_inner() -> Result<AndroidPairingStatus, AppError> {
    keyring_store::delete_record()?;
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
        endpoint: None,
        instance_id: None,
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
        .host_str()
        .ok_or_else(|| AppError::Other("Cloud server origin has no host".into()))?;
    let loopback_http =
        allow_loopback_http && parsed.scheme() == "http" && matches!(host, "127.0.0.1" | "::1");
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

fn build_payload(source: &PairingSource, secret: &str) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("endpoint", &source.endpoint)
        .append_pair("instance", &source.instance_id)
        .append_pair("secret", secret)
        .finish();
    format!("laymux://pair/v1?{query}")
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
    let secret = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(&record.secret)
            .map_err(|_| AppError::Other("Stored Android pairing is invalid".into()))?,
    );
    if secret.len() != PAIRING_SECRET_BYTES {
        return Err(AppError::Other("Stored Android pairing is invalid".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serial_test::serial;

    use super::*;

    fn paired_settings() -> RemoteSettings {
        RemoteSettings {
            cloud_enabled: true,
            cloud_instance_id: Some("desktop-7".into()),
            cloud_server_base_url: Some("https://relay.example.test".into()),
            ..RemoteSettings::default()
        }
    }

    #[test]
    fn payload_matches_the_android_v1_contract() {
        let source = PairingSource {
            endpoint: "https://relay.example.test/".into(),
            instance_id: "desktop-7".into(),
        };
        let secret = URL_SAFE_NO_PAD.encode([7_u8; PAIRING_SECRET_BYTES]);

        let payload = build_payload(&source, &secret);

        assert_eq!(
            payload,
            format!(
                "laymux://pair/v1?endpoint=https%3A%2F%2Frelay.example.test%2F&instance=desktop-7&secret={secret}"
            )
        );
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
        assert!(validate_endpoint("http://192.168.0.2:8000", true).is_err());
    }

    #[test]
    #[serial]
    fn create_rotates_keyring_record_and_returns_only_svg_and_metadata() {
        keyring_store::reset_mock_store().unwrap();
        let settings = paired_settings();

        let first = create_for_settings_with_seed(&settings, &[1; PAIRING_SECRET_BYTES]).unwrap();
        let first_record = keyring_store::get_record().unwrap().unwrap();
        let second = create_for_settings_with_seed(&settings, &[2; PAIRING_SECRET_BYTES]).unwrap();
        let second_record = keyring_store::get_record().unwrap().unwrap();

        assert!(first.qr_svg.starts_with("<?xml"));
        assert!(first.qr_svg.contains("<svg"));
        assert!(!first.qr_svg.contains("laymux://pair/v1"));
        assert_eq!(first.status, second.status);
        assert_ne!(first_record, second_record);
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
