use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use axum::body::to_bytes;
use axum::extract::{Path as AxumPath, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::automation_server::ServerState;
use crate::constants::{
    CLOUD_RELAY_ANDROID_E2E_RPC_BODY_LIMIT, CLOUD_RELAY_HTTP_REQUEST_BYTES_LIMIT,
    REMOTE_TERMINAL_ATTACHMENT_CACHE_FILES_OF_MAX_SIZE, REMOTE_TERMINAL_ATTACHMENT_CACHE_MAX_FILES,
    REMOTE_TERMINAL_ATTACHMENT_REQUEST_SLACK_BYTES,
};
use crate::lock_ext::MutexExt;
use crate::settings::models::{RemoteSettings, MAX_REMOTE_ATTACHMENT_MIB};

use super::access::effective_remote_settings;
use super::lease::begin_remote_lease_mutation;
use super::routes::lease_id_from_headers;
use super::{internal_error, json_error, RemoteTransport};

const MIB: usize = 1024 * 1024;

const ATTACHMENT_DIR_NAME: &str = "remote-attachments";
const MAX_FILE_NAME_CHARS: usize = 160;
const MAX_MIME_TYPE_CHARS: usize = 128;
const MAX_STEM_CHARS: usize = 64;
const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "json", "jsonl", "yaml", "yml", "toml", "xml", "csv", "log", "ts",
    "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "kt", "kts", "c", "h", "cpp",
    "hpp", "cc", "cs", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "css", "scss",
    "html", "htm", "ini", "conf", "cfg", "env",
];
const TEXT_APPLICATION_MIME_TYPES: &[&str] = &[
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/toml",
    "application/javascript",
    "application/sql",
];

static ATTACHMENT_STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteTerminalAttachmentRequest {
    file_name: String,
    mime_type: String,
    data: String,
    lease_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTerminalAttachmentResponse {
    path: String,
    byte_length: usize,
}

#[derive(Debug, PartialEq, Eq)]
enum AttachmentError {
    Invalid(String),
    TooLarge,
    QuotaExceeded,
    Io(String),
}

impl From<std::io::Error> for AttachmentError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

#[derive(Debug, PartialEq, Eq)]
enum AttachmentKind {
    Image(&'static str),
    Document(&'static str),
    Text(String),
    /// Stored as-is because the host opted in by extension or allow-all.
    Opaque(String),
}

/// Host attachment policy derived from `remote.*` settings (ADR-0227), capped
/// to what the transport that carried the request can relay. The same shape
/// is published to Remote clients in the claim/status answers so the browser
/// sizes its own checks, messages and file chooser to this host and path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentPolicy {
    /// Effective bound for this request path: `min(host, relay)`.
    pub max_bytes: usize,
    /// The host's configured bound, reachable over Direct/Tailscale Remote.
    pub host_max_bytes: usize,
    /// Cloud relay payload bound for this path, when the request came through it.
    pub relay_max_bytes: Option<usize>,
    pub allow_all_extensions: bool,
    pub extra_extensions: Vec<String>,
}

impl AttachmentPolicy {
    pub(crate) fn from_settings(
        settings: &RemoteSettings,
        transport: Option<RemoteTransport>,
    ) -> Self {
        let host_max_bytes = settings
            .attachment_max_mib
            .clamp(1, MAX_REMOTE_ATTACHMENT_MIB) as usize
            * MIB;
        let relay_max_bytes = transport.and_then(relay_attachment_cap);
        Self {
            max_bytes: relay_max_bytes.map_or(host_max_bytes, |relay| relay.min(host_max_bytes)),
            host_max_bytes,
            relay_max_bytes,
            allow_all_extensions: settings.attachment_allow_all_extensions,
            extra_extensions: settings
                .attachment_extra_extensions
                .iter()
                .filter(|extension| is_valid_attachment_extension(extension))
                .cloned()
                .collect(),
        }
    }

    fn cache_quota_bytes(&self) -> usize {
        self.host_max_bytes * REMOTE_TERMINAL_ATTACHMENT_CACHE_FILES_OF_MAX_SIZE
    }

    /// Whether the Cloud relay, not the host setting, is the binding bound.
    fn relay_limited(&self) -> bool {
        self.relay_max_bytes
            .is_some_and(|relay| relay < self.host_max_bytes)
    }

    fn too_large_message(&self) -> String {
        if self.relay_limited() {
            format!(
                "attachment exceeds the Cloud relay payload limit of {} MiB. Connect through Tailscale (direct Remote) to use this host's {} MiB limit.",
                self.max_bytes / MIB,
                self.host_max_bytes / MIB
            )
        } else {
            format!("attachment exceeds the {} MiB limit", self.max_bytes / MIB)
        }
    }

    fn permits_opaque(&self, extension: Option<&str>) -> bool {
        self.allow_all_extensions
            || extension.is_some_and(|extension| {
                self.extra_extensions
                    .iter()
                    .any(|allowed| allowed == extension)
            })
    }
}

/// Extensions are stored into a file name, so only lowercase ASCII
/// alphanumerics of bounded length are accepted from settings or callers.
pub(crate) fn is_valid_attachment_extension(extension: &str) -> bool {
    (1..=16).contains(&extension.len())
        && extension
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

pub(super) async fn remote_terminal_attachment(
    State(server): State<ServerState>,
    AxumPath(id): AxumPath<String>,
    transport: Option<axum::Extension<RemoteTransport>>,
    request: Request,
) -> Response {
    let transport = transport.map(|axum::Extension(transport)| transport);
    let policy = match effective_remote_settings(&server.app_state) {
        Ok(settings) => AttachmentPolicy::from_settings(&settings, transport),
        Err(error) => return no_store(internal_error(error)),
    };
    let (parts, raw_body) = request.into_parts();
    // The body bound follows the configured maximum, so the route itself
    // disables axum's static default limit.
    let raw = match to_bytes(raw_body, attachment_request_limit(policy.max_bytes)).await {
        Ok(raw) => raw,
        Err(_) => {
            return no_store(json_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                &policy.too_large_message(),
            ))
        }
    };
    let body: RemoteTerminalAttachmentRequest = match serde_json::from_slice(&raw) {
        Ok(body) => body,
        Err(_) => {
            return no_store(json_error(
                StatusCode::BAD_REQUEST,
                "attachment request body is not valid JSON",
            ))
        }
    };
    drop(raw);

    let lease_id = body
        .lease_id
        .as_deref()
        .or_else(|| lease_id_from_headers(&parts.headers));
    let permit = match begin_remote_lease_mutation(&server.app_state, lease_id) {
        Ok(permit) => permit,
        Err(response) => return no_store(response),
    };

    if body.file_name.chars().count() > MAX_FILE_NAME_CHARS {
        return no_store(json_error(
            StatusCode::BAD_REQUEST,
            "attachment file name is too long",
        ));
    }
    if body.mime_type.chars().count() > MAX_MIME_TYPE_CHARS {
        return no_store(json_error(
            StatusCode::BAD_REQUEST,
            "attachment MIME type is too long",
        ));
    }
    if body.data.len() > encoded_attachment_limit(policy.max_bytes) {
        return no_store(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            &policy.too_large_message(),
        ));
    }

    let bytes = match BASE64.decode(body.data.as_bytes()) {
        Ok(bytes) => bytes,
        Err(_) => {
            return no_store(json_error(
                StatusCode::BAD_REQUEST,
                "attachment data is not valid base64",
            ))
        }
    };
    if bytes.len() > policy.max_bytes {
        return no_store(json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            &policy.too_large_message(),
        ));
    }

    let profile = match terminal_profile(&server.app_state, &id) {
        Ok(Some(profile)) => profile,
        Ok(None) => {
            return no_store(json_error(
                StatusCode::NOT_FOUND,
                "terminal session was not found",
            ))
        }
        Err(error) => return no_store(internal_error(error)),
    };
    let byte_length = bytes.len();
    let file_name = body.file_name;
    let mime_type = body.mime_type;
    let attachment_dir = match default_attachment_dir() {
        Ok(directory) => directory,
        Err(error) => return no_store(internal_error(error)),
    };
    let worker_policy = policy.clone();
    let saved = tokio::task::spawn_blocking(move || {
        save_attachment_to_dir(
            &attachment_dir,
            &file_name,
            &mime_type,
            &bytes,
            &worker_policy,
            worker_policy.cache_quota_bytes(),
            REMOTE_TERMINAL_ATTACHMENT_CACHE_MAX_FILES,
        )
        .map(|path| terminal_visible_path(&path, &profile))
    })
    .await;
    drop(permit);

    match saved {
        Ok(Ok(path)) => {
            no_store(Json(RemoteTerminalAttachmentResponse { path, byte_length }).into_response())
        }
        Ok(Err(error)) => attachment_error_response(error, &policy),
        Err(error) => no_store(internal_error(format!(
            "attachment storage worker failed: {error}"
        ))),
    }
}

fn terminal_profile(
    app_state: &crate::state::AppState,
    terminal_id: &str,
) -> Result<Option<String>, String> {
    Ok(app_state
        .terminals
        .lock_or_err()?
        .get(terminal_id)
        .map(|session| session.config.profile.clone()))
}

fn attachment_error_response(error: AttachmentError, policy: &AttachmentPolicy) -> Response {
    let response = match error {
        AttachmentError::Invalid(message) => {
            json_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, &message)
        }
        AttachmentError::TooLarge => {
            json_error(StatusCode::PAYLOAD_TOO_LARGE, &policy.too_large_message())
        }
        AttachmentError::QuotaExceeded => json_error(
            StatusCode::INSUFFICIENT_STORAGE,
            "remote attachment cache is full",
        ),
        AttachmentError::Io(message) => internal_error(message),
    };
    no_store(response)
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Largest decoded attachment the Cloud relay can carry on this path, floored
/// to whole MiB so the bound reads cleanly in messages. Direct/Tailscale paths
/// have no relay in between and return `None`.
fn relay_attachment_cap(transport: RemoteTransport) -> Option<usize> {
    let request_limit = match transport {
        RemoteTransport::CloudRelayBrowser => CLOUD_RELAY_HTTP_REQUEST_BYTES_LIMIT,
        RemoteTransport::AndroidE2e {
            via_cloud_relay: true,
        } => {
            // Invert `android_e2e_rpc_body_limit`: strip the envelope slack and
            // the outer base64url layer to get the inner attachment JSON bound.
            (CLOUD_RELAY_ANDROID_E2E_RPC_BODY_LIMIT
                - REMOTE_TERMINAL_ATTACHMENT_REQUEST_SLACK_BYTES)
                / 4
                * 3
                - REMOTE_TERMINAL_ATTACHMENT_REQUEST_SLACK_BYTES
        }
        RemoteTransport::AndroidE2e {
            via_cloud_relay: false,
        } => return None,
    };
    // Invert `attachment_request_limit`: strip the JSON slack and the base64 layer.
    let decoded = (request_limit - REMOTE_TERMINAL_ATTACHMENT_REQUEST_SLACK_BYTES) / 4 * 3;
    Some((decoded / MIB).max(1) * MIB)
}

/// Base64 length of the largest decoded attachment the policy allows.
const fn encoded_attachment_limit(max_bytes: usize) -> usize {
    max_bytes.div_ceil(3) * 4
}

/// JSON body bound for one attachment request at the given decoded maximum.
pub(crate) const fn attachment_request_limit(max_bytes: usize) -> usize {
    encoded_attachment_limit(max_bytes) + REMOTE_TERMINAL_ATTACHMENT_REQUEST_SLACK_BYTES
}

/// Body bound for the Android E2E RPC envelope. The attachment JSON rides
/// inside the plaintext RPC record, which is AEAD-sealed and base64url-encoded
/// once more, so the bound is sized for the largest configurable attachment.
pub(crate) const fn android_e2e_rpc_body_limit() -> usize {
    let max_bytes = MAX_REMOTE_ATTACHMENT_MIB as usize * 1024 * 1024;
    (attachment_request_limit(max_bytes) + REMOTE_TERMINAL_ATTACHMENT_REQUEST_SLACK_BYTES)
        .div_ceil(3)
        * 4
        + REMOTE_TERMINAL_ATTACHMENT_REQUEST_SLACK_BYTES
}

fn attachment_dir_under(cache_dir: &Path) -> PathBuf {
    cache_dir.join(ATTACHMENT_DIR_NAME)
}

pub(crate) fn default_attachment_dir() -> Result<PathBuf, String> {
    crate::settings::cache_dir_path()
        .map(|cache_dir| attachment_dir_under(&cache_dir))
        .ok_or_else(|| "Cannot determine the user-specific Remote attachment cache".into())
}

fn save_attachment_to_dir(
    directory: &Path,
    original_name: &str,
    mime_type: &str,
    bytes: &[u8],
    policy: &AttachmentPolicy,
    quota_bytes: usize,
    quota_files: usize,
) -> Result<PathBuf, AttachmentError> {
    if bytes.len() > policy.max_bytes {
        return Err(AttachmentError::TooLarge);
    }
    let kind = classify_attachment(original_name, mime_type, bytes, policy)?;
    let output_name = attachment_file_name(original_name, &kind);
    let _store_guard = ATTACHMENT_STORE_LOCK
        .lock_or_err()
        .map_err(|error| AttachmentError::Io(error.to_string()))?;
    ensure_private_attachment_directory(directory)?;
    let usage = attachment_cache_usage(directory)?;
    if usage.bytes.saturating_add(bytes.len()) > quota_bytes || usage.files >= quota_files {
        return Err(AttachmentError::QuotaExceeded);
    }

    let path = directory.join(output_name);
    let mut file = create_attachment_file(&path)?;
    if let Err(error) = file.write_all(bytes) {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(error.into());
    }
    Ok(path)
}

fn ensure_private_attachment_directory(directory: &Path) -> Result<(), AttachmentError> {
    fs::create_dir_all(directory)?;
    let metadata = fs::symlink_metadata(directory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AttachmentError::Io(
            "Remote attachment cache path is not a private directory".into(),
        ));
    }
    set_private_directory_permissions(directory)?;
    Ok(())
}

#[cfg(unix)]
fn set_private_directory_permissions(directory: &Path) -> Result<(), std::io::Error> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_directory: &Path) -> Result<(), std::io::Error> {
    Ok(())
}

#[cfg(unix)]
fn create_attachment_file(path: &Path) -> Result<std::fs::File, std::io::Error> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn create_attachment_file(path: &Path) -> Result<std::fs::File, std::io::Error> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

#[derive(Debug, Default, PartialEq, Eq)]
struct AttachmentCacheUsage {
    bytes: usize,
    files: usize,
}

fn attachment_cache_usage(directory: &Path) -> Result<AttachmentCacheUsage, AttachmentError> {
    let mut usage = AttachmentCacheUsage::default();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if !file_type.is_file() {
            continue;
        }
        usage.bytes = usage.bytes.saturating_add(entry.metadata()?.len() as usize);
        usage.files = usage.files.saturating_add(1);
    }
    Ok(usage)
}

fn classify_attachment(
    original_name: &str,
    mime_type: &str,
    bytes: &[u8],
    policy: &AttachmentPolicy,
) -> Result<AttachmentKind, AttachmentError> {
    if let Some(extension) = sniff_image_extension(bytes) {
        return Ok(AttachmentKind::Image(extension));
    }
    if let Some(extension) = sniff_document_extension(bytes) {
        return Ok(AttachmentKind::Document(extension));
    }

    let mime_type = mime_type.trim().to_ascii_lowercase();
    let original_extension = file_extension(original_name);
    let text_declared = mime_type.starts_with("text/")
        || TEXT_APPLICATION_MIME_TYPES.contains(&mime_type.as_str())
        || original_extension
            .as_deref()
            .is_some_and(|extension| TEXT_EXTENSIONS.contains(&extension));
    let text_valid = !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok();
    if text_declared && text_valid {
        let extension = original_extension
            .filter(|extension| TEXT_EXTENSIONS.contains(&extension.as_str()))
            .unwrap_or_else(|| "txt".into());
        return Ok(AttachmentKind::Text(extension));
    }
    if policy.permits_opaque(original_extension.as_deref()) {
        let extension = original_extension
            .filter(|extension| is_valid_attachment_extension(extension))
            .unwrap_or_else(|| "bin".into());
        return Ok(AttachmentKind::Opaque(extension));
    }
    if text_declared {
        return Err(AttachmentError::Invalid(
            "text attachments must contain valid UTF-8 without NUL bytes".into(),
        ));
    }
    Err(AttachmentError::Invalid(
        "only image, text, PDF, DOCX, PPTX and host-allowed extensions are supported".into(),
    ))
}

fn sniff_image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else if bytes.starts_with(b"BM") {
        Some("bmp")
    } else {
        None
    }
}

/// PDF by header, DOCX/PPTX by their OOXML package structure. OOXML is a ZIP
/// archive whose central directory lists part names in plain text, so the
/// package type is readable from the bytes without walking the archive. The
/// caller's file name and MIME type are not trusted for the extension.
fn sniff_document_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"%PDF-") {
        return Some("pdf");
    }
    if !bytes.starts_with(b"PK\x03\x04") {
        return None;
    }
    let contains = |needle: &[u8]| bytes.windows(needle.len()).any(|window| window == needle);
    if contains(b"word/document.xml") {
        Some("docx")
    } else if contains(b"ppt/presentation.xml") {
        Some("pptx")
    } else {
        None
    }
}

fn attachment_file_name(original_name: &str, kind: &AttachmentKind) -> String {
    let base_name = original_name
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("attachment");
    let stem = base_name
        .rsplit_once('.')
        .map_or(base_name, |(stem, _)| stem);
    let mut safe_stem: String = stem
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(MAX_STEM_CHARS)
        .collect();
    safe_stem = safe_stem.trim_matches('_').to_string();
    if safe_stem.is_empty() {
        safe_stem.push_str("attachment");
    }
    let extension = match kind {
        AttachmentKind::Image(extension) | AttachmentKind::Document(extension) => *extension,
        AttachmentKind::Text(extension) | AttachmentKind::Opaque(extension) => extension.as_str(),
    };
    format!("remote-{}-{safe_stem}.{extension}", Uuid::new_v4())
}

fn file_extension(file_name: &str) -> Option<String> {
    file_name
        .rsplit(['/', '\\'])
        .next()?
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .filter(|extension| !extension.is_empty())
}

fn terminal_visible_path(path: &Path, profile: &str) -> String {
    let path = path.to_string_lossy().into_owned();
    #[cfg(target_os = "windows")]
    if crate::clipboard::is_wsl_profile(profile) {
        return crate::path_utils::windows_to_wsl_path(&path);
    }
    let _ = profile;
    path
}

pub(crate) fn cleanup_stale_attachments(max_age_days: u64) -> Result<u32, String> {
    cleanup_stale_attachments_in(&default_attachment_dir()?, max_age_days)
}

fn cleanup_stale_attachments_in(directory: &Path, max_age_days: u64) -> Result<u32, String> {
    if !directory.exists() {
        return Ok(0);
    }
    let _store_guard = ATTACHMENT_STORE_LOCK
        .lock_or_err()
        .map_err(|error| error.to_string())?;
    ensure_private_attachment_directory(directory).map_err(|error| match error {
        AttachmentError::Io(message) | AttachmentError::Invalid(message) => message,
        AttachmentError::TooLarge => "Remote attachment is too large".into(),
        AttachmentError::QuotaExceeded => "Remote attachment cache is full".into(),
    })?;
    let max_age = Duration::from_secs(max_age_days.saturating_mul(24 * 60 * 60));
    let now = SystemTime::now();
    let mut removed = 0u32;
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if !file_type.is_file() {
            continue;
        }
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age > max_age {
            fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
#[path = "attachments_tests.rs"]
mod tests;
