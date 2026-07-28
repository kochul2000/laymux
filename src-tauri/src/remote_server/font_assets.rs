//! Remote 터미널 폰트 서빙 (ADR-0077).
//!
//! 데스크톱 프로필의 터미널 face 를 시스템에서 해석해 sfnt 바이트 그대로 내려준다.
//! woff2 컨테이너 변환은 하지 않고 전송 압축은 HTTP `Content-Encoding: br` 이 맡는다.
//! 이 모듈이 face 해석·검증·토큰 발급·바이트 캐시를 단독 소유한다.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::{Arc, Mutex, OnceLock};

use axum::body::Bytes;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::lock_ext::MutexExt;
use crate::settings::models::Settings;

/// URL 경로 prefix. 라우트 등록(`routes.rs`)과 여기서 만드는 광고 URL 이 같아야 한다.
pub(super) const FONT_ROUTE_PREFIX: &str = "/remote/font/";
/// `routes.rs` 가 등록하는 경로. prefix 와 어긋나면 광고 URL 이 조용히 404 가 된다.
pub(super) const FONT_ROUTE_PATH: &str = "/remote/font/{file_name}";

/// 페이스 하나가 넘을 수 없는 원본 크기. 초과하면 이름-only 폴백으로 둔다.
const MAX_FONT_BYTES: usize = 8 * 1024 * 1024;
/// face 이름 → 광고 캐시 상한.
const MAX_CACHED_FACES: usize = 8;
/// 토큰 → 바이트 캐시 상한. face 하나가 최대 4 파일이므로 face 캐시의 두 배로 둔다.
/// 상주 바이트 천장은 이 값 × `MAX_FONT_BYTES`(+ brotli 본)이다.
const MAX_CACHED_FONT_FILES: usize = 16;
/// 콘텐츠 해시에서 URL 토큰으로 쓰는 hex 자리수.
const CONTENT_TOKEN_HEX_LEN: usize = 16;
/// CSS family 별칭에서 face 이름 해시로 쓰는 hex 자리수.
const FAMILY_TOKEN_HEX_LEN: usize = 12;
/// brotli 품질/윈도우. 품질 11 은 MB 급 폰트에서 수 초가 걸려 9 로 둔다.
const BROTLI_QUALITY: u32 = 9;
const BROTLI_WINDOW: u32 = 22;

/// Remote 클라이언트가 `@font-face` 로 등록할 폰트 묶음.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteFontAssets {
    /// `LxRemoteFont-<token>` 별칭. 실제 face 이름을 쓰지 않는 이유는 ADR-0077 참고 —
    /// 로컬 동명 폰트와 충돌하지 않고, 로드 완료 시점에 `fontFamily` 문자열이
    /// 실제로 달라져 xterm 이 셀 크기를 다시 재도록 만들기 위해서다.
    pub family: String,
    pub faces: Vec<RemoteFontFace>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteFontFace {
    pub url: String,
    pub weight: u16,
    pub style: &'static str,
}

/// 토큰으로 조회되는 서빙 대상 폰트 바이트.
#[derive(Debug)]
pub(super) struct ServedFont {
    pub bytes: Bytes,
    pub content_type: &'static str,
    /// brotli 본은 첫 요청에서 한 번 만들어 재사용한다.
    compressed: Mutex<Option<Bytes>>,
}

impl ServedFont {
    /// 캐시된 brotli 본을 주고, 없으면 만들어 캐시한다. 압축 실패는 원본 서빙으로 폴백.
    ///
    /// 압축하는 동안 락을 계속 쥔다 — 캐시가 채워지기 전에 도착한 동시 요청이
    /// 각자 MB 급 폰트를 압축하지 않도록 한 번만 돌리기 위해서다. 호출자는
    /// blocking pool 위에 있으므로 여기서 기다려도 async 런타임을 막지 않는다.
    pub fn brotli_bytes(&self) -> Option<Bytes> {
        let mut slot = self.compressed.lock_or_err().ok()?;
        if let Some(bytes) = slot.as_ref() {
            return Some(bytes.clone());
        }
        let compressed = compress_brotli(&self.bytes)?;
        *slot = Some(compressed.clone());
        Some(compressed)
    }
}

#[cfg(test)]
pub(super) fn served_font_for_test(bytes: Bytes, content_type: &'static str) -> ServedFont {
    ServedFont {
        bytes,
        content_type,
        compressed: Mutex::new(None),
    }
}

#[derive(Clone, Copy)]
struct SfntKind {
    content_type: &'static str,
    extension: &'static str,
}

const TTF_KIND: SfntKind = SfntKind {
    content_type: "font/ttf",
    extension: "ttf",
};
const OTF_KIND: SfntKind = SfntKind {
    content_type: "font/otf",
    extension: "otf",
};

fn served_fonts() -> &'static Mutex<HashMap<String, Arc<ServedFont>>> {
    static SERVED_FONTS: OnceLock<Mutex<HashMap<String, Arc<ServedFont>>>> = OnceLock::new();
    SERVED_FONTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn face_assets_cache() -> &'static Mutex<HashMap<String, Option<RemoteFontAssets>>> {
    static FACE_ASSETS: OnceLock<Mutex<HashMap<String, Option<RemoteFontAssets>>>> =
        OnceLock::new();
    FACE_ASSETS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 설정된 face 의 서빙 자산. 토글이 꺼져 있거나 서빙할 수 없으면 `None` —
/// 그 경우 Remote 는 기존 이름-only 폰트 스택으로 폴백한다.
///
/// 디스크 I/O 를 탈 수 있으므로 호출자는 락을 쥔 채로 부르지 않는다.
pub(super) fn resolve_font_assets(face: &str, settings: &Settings) -> Option<RemoteFontAssets> {
    if !settings.remote.serve_terminal_font {
        return None;
    }
    let face = face.trim();
    if face.is_empty() {
        return None;
    }

    if let Some(cached) = cached_face_assets(face) {
        return cached;
    }

    let resolved = load_face_assets(face);
    if let Ok(mut cache) = face_assets_cache().lock_or_err() {
        evict_until_below(&mut cache, MAX_CACHED_FACES);
        cache.insert(face.to_string(), resolved.clone());
    }
    resolved
}

/// 캐시된 광고는 그 토큰이 아직 서빙 가능할 때만 유효하다. 바이트 캐시는 광고
/// 캐시와 따로 evict 되므로, 검증 없이 돌려주면 404 나는 URL 을 계속 광고하게 된다.
fn cached_face_assets(face: &str) -> Option<Option<RemoteFontAssets>> {
    let cached = {
        let cache = face_assets_cache().lock_or_err().ok()?;
        cache.get(face).cloned()?
    };
    let Some(assets) = cached else {
        // 서빙 불가로 판정된 face 는 재확인할 바이트가 없다.
        return Some(None);
    };
    if assets.faces.iter().all(|face| {
        token_from_url(&face.url)
            .map(|token| served_font(token).is_some())
            .unwrap_or(false)
    }) {
        return Some(Some(assets));
    }
    if let Ok(mut cache) = face_assets_cache().lock_or_err() {
        cache.remove(face);
    }
    None
}

fn token_from_url(url: &str) -> Option<&str> {
    parse_font_token(url.strip_prefix(FONT_ROUTE_PREFIX)?)
}

/// 상한을 넘으면 통째로 비우지 않고 넘치는 만큼만 버린다. clear-all 은 face 가
/// 상한보다 많을 때 매 요청이 전체를 다시 해석하는 thrash 로 이어진다.
fn evict_until_below<V>(cache: &mut HashMap<String, V>, limit: usize) {
    while cache.len() >= limit {
        let Some(victim) = cache.keys().next().cloned() else {
            return;
        };
        cache.remove(&victim);
    }
}

/// 토큰으로 서빙 대상 폰트를 찾는다. 앱 재시작 후 첫 요청처럼 캐시가 비어 있으면 `None`
/// — 클라이언트는 404 를 받고 폴백 폰트로 계속 동작한다.
pub(super) fn served_font(token: &str) -> Option<Arc<ServedFont>> {
    served_fonts().lock_or_err().ok()?.get(token).cloned()
}

fn load_face_assets(face: &str) -> Option<RemoteFontAssets> {
    use font_kit::family_name::FamilyName;
    use font_kit::properties::{Properties, Style, Weight};
    use font_kit::source::SystemSource;

    let source = SystemSource::new();
    let mut faces = Vec::new();
    let mut seen_tokens = HashSet::new();

    // regular 를 먼저 본다: bold/italic 이 같은 파일로 해석되면 그 규칙을 만들지 않고
    // 브라우저 합성에 맡긴다(ADR-0077).
    let variants = [
        (400u16, "normal", Weight::NORMAL, Style::Normal),
        (700, "normal", Weight::BOLD, Style::Normal),
        (400, "italic", Weight::NORMAL, Style::Italic),
        (700, "italic", Weight::BOLD, Style::Italic),
    ];

    for (css_weight, css_style, weight, style) in variants {
        let properties = Properties {
            weight,
            style,
            ..Properties::new()
        };
        let handle =
            match source.select_best_match(&[FamilyName::Title(face.to_string())], &properties) {
                Ok(handle) => handle,
                Err(err) => {
                    tracing::debug!("remote font: face '{face}' has no match: {err}");
                    continue;
                }
            };
        let font = match handle.load() {
            Ok(font) => font,
            Err(err) => {
                tracing::debug!("remote font: face '{face}' failed to load: {err}");
                continue;
            }
        };
        let Some(data) = font.copy_font_data() else {
            tracing::debug!("remote font: face '{face}' exposes no font data");
            continue;
        };
        let Some(kind) = sfnt_kind(&data) else {
            tracing::debug!(
                "remote font: face '{face}' is not a servable sfnt (collection or unknown tag)"
            );
            continue;
        };
        if data.len() > MAX_FONT_BYTES {
            tracing::debug!(
                "remote font: face '{face}' is {} bytes, over the {MAX_FONT_BYTES} serve cap",
                data.len()
            );
            continue;
        }

        let token = content_token(&data);
        if !seen_tokens.insert(token.clone()) {
            continue;
        }
        let bytes = Bytes::from(data.as_ref().clone());
        register_served_font(token.clone(), bytes, kind);
        faces.push(RemoteFontFace {
            url: format!("{FONT_ROUTE_PREFIX}{token}.{}", kind.extension),
            weight: css_weight,
            style: css_style,
        });
    }

    if faces.is_empty() {
        // 토글을 켠 사용자는 폰트가 바뀌기를 기대하고 있다. 아무것도 못 내보내는
        // 사유는 기본 로그 레벨에서 보여야 "왜 안 바뀌지"를 추적할 수 있다.
        tracing::warn!(
            "remote font: face '{face}' is not servable; falling back to the name-only stack"
        );
        return None;
    }
    Some(RemoteFontAssets {
        family: family_alias(face),
        faces,
    })
}

fn register_served_font(token: String, bytes: Bytes, kind: SfntKind) {
    let Ok(mut fonts) = served_fonts().lock_or_err() else {
        return;
    };
    // 토큰이 콘텐츠 해시이므로 같은 토큰은 같은 바이트다. 재삽입할 이유가 없고,
    // 재삽입하면 이미 만들어 둔 brotli 본만 버리게 된다.
    if fonts.contains_key(&token) {
        return;
    }
    evict_until_below(&mut fonts, MAX_CACHED_FONT_FILES);
    fonts.insert(
        token,
        Arc::new(ServedFont {
            bytes,
            content_type: kind.content_type,
            compressed: Mutex::new(None),
        }),
    );
}

fn sfnt_kind(data: &[u8]) -> Option<SfntKind> {
    let tag: [u8; 4] = data.get(..4)?.try_into().ok()?;
    match &tag {
        b"OTTO" => Some(OTF_KIND),
        // 폰트 컬렉션은 브라우저 `@font-face` 가 읽지 못한다.
        b"ttcf" => None,
        b"true" => Some(TTF_KIND),
        [0x00, 0x01, 0x00, 0x00] => Some(TTF_KIND),
        _ => None,
    }
}

fn content_token(data: &[u8]) -> String {
    hex_prefix(&Sha256::digest(data), CONTENT_TOKEN_HEX_LEN)
}

fn family_alias(face: &str) -> String {
    format!(
        "LxRemoteFont-{}",
        hex_prefix(&Sha256::digest(face.as_bytes()), FAMILY_TOKEN_HEX_LEN)
    )
}

fn hex_prefix(digest: &[u8], hex_len: usize) -> String {
    use std::fmt::Write as _;

    let mut hex = String::with_capacity(hex_len);
    for byte in digest.iter().take(hex_len.div_ceil(2)) {
        let _ = write!(hex, "{byte:02x}");
    }
    hex.truncate(hex_len);
    hex
}

/// 요청 경로의 `<token>.<ext>` 에서 토큰만 뽑는다. 캐시 조회 키로 쓰이므로
/// hex 형태와 길이를 여기서 확정한다.
pub(super) fn parse_font_token(file_name: &str) -> Option<&str> {
    let (token, extension) = file_name.rsplit_once('.')?;
    if extension != TTF_KIND.extension && extension != OTF_KIND.extension {
        return None;
    }
    if token.len() != CONTENT_TOKEN_HEX_LEN
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return None;
    }
    Some(token)
}

fn compress_brotli(data: &[u8]) -> Option<Bytes> {
    let mut out = Vec::new();
    {
        let mut writer =
            brotli::CompressorWriter::new(&mut out, 4096, BROTLI_QUALITY, BROTLI_WINDOW);
        if writer.write_all(data).is_err() {
            return None;
        }
        if writer.flush().is_err() {
            return None;
        }
    }
    Some(Bytes::from(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    use serial_test::serial;

    #[test]
    fn advertised_urls_live_under_the_registered_route() {
        assert!(FONT_ROUTE_PATH.starts_with(FONT_ROUTE_PREFIX));
        assert_eq!(FONT_ROUTE_PATH, format!("{FONT_ROUTE_PREFIX}{{file_name}}"));
        assert_eq!(
            token_from_url("/remote/font/0123456789abcdef.ttf"),
            Some("0123456789abcdef")
        );
        assert_eq!(token_from_url("/elsewhere/0123456789abcdef.ttf"), None);
    }

    #[test]
    fn eviction_drops_only_the_overflow() {
        let mut cache: HashMap<String, u8> = (0..10).map(|i| (i.to_string(), i)).collect();
        evict_until_below(&mut cache, 8);
        // Room for the caller's insert, and the rest survives — a clear-all here
        // would re-resolve every face on the next request.
        assert_eq!(cache.len(), 7);
    }

    #[test]
    fn rejects_font_collections_and_unknown_tags() {
        assert!(sfnt_kind(b"ttcf\x00\x01\x00\x00").is_none());
        assert!(sfnt_kind(b"RIFF").is_none());
        assert!(sfnt_kind(b"\x00").is_none());
        assert_eq!(sfnt_kind(b"OTTO....").unwrap().extension, "otf");
        assert_eq!(sfnt_kind(b"\x00\x01\x00\x00....").unwrap().extension, "ttf");
        assert_eq!(sfnt_kind(b"true....").unwrap().extension, "ttf");
    }

    #[test]
    fn content_token_is_stable_hex_of_fixed_length() {
        let token = content_token(b"laymux");
        assert_eq!(token.len(), CONTENT_TOKEN_HEX_LEN);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(token, content_token(b"laymux"));
        assert_ne!(token, content_token(b"laymuy"));
    }

    #[test]
    fn family_alias_is_a_css_identifier_derived_from_the_face() {
        let alias = family_alias("Cascadia Mono");
        assert!(alias.starts_with("LxRemoteFont-"));
        assert_eq!(alias.len(), "LxRemoteFont-".len() + FAMILY_TOKEN_HEX_LEN);
        assert_eq!(alias, family_alias("Cascadia Mono"));
        assert_ne!(alias, family_alias("Consolas"));
    }

    #[test]
    fn parses_only_well_formed_font_file_names() {
        let token = content_token(b"laymux");
        assert_eq!(
            parse_font_token(&format!("{token}.ttf")),
            Some(token.as_str())
        );
        assert_eq!(
            parse_font_token(&format!("{token}.otf")),
            Some(token.as_str())
        );
        assert_eq!(parse_font_token(&format!("{token}.woff2")), None);
        assert_eq!(parse_font_token(&token), None);
        assert_eq!(parse_font_token("../../etc/passwd.ttf"), None);
        assert_eq!(parse_font_token("ZZZZZZZZZZZZZZZZ.ttf"), None);
        assert_eq!(
            parse_font_token(&format!("{}.ttf", token.to_uppercase())),
            None
        );
    }

    #[test]
    fn disabled_toggle_serves_nothing() {
        let settings = Settings::default();
        assert!(!settings.remote.serve_terminal_font);
        assert_eq!(resolve_font_assets("Cascadia Mono", &settings), None);
        assert_eq!(resolve_font_assets("", &settings), None);
    }

    /// Consolas ships with every Windows install, so this exercises the real
    /// resolve -> validate -> register -> serve path instead of a stub.
    #[cfg(windows)]
    #[test]
    #[serial(remote_font_cache)]
    fn windows_system_face_resolves_to_servable_faces() {
        let mut settings = Settings::default();
        settings.remote.serve_terminal_font = true;

        let assets =
            resolve_font_assets("Consolas", &settings).expect("Consolas ships with Windows");
        assert!(assets.family.starts_with("LxRemoteFont-"));
        assert!(!assets.faces.is_empty());

        for face in &assets.faces {
            let file_name = face
                .url
                .strip_prefix("/remote/font/")
                .expect("advertised url must use the font route");
            let token = parse_font_token(file_name).expect("advertised url must carry a token");
            let font = served_font(token).expect("advertised font must be registered");
            assert!(!font.bytes.is_empty());
            assert!(sfnt_kind(&font.bytes).is_some());
            assert!(font.bytes.len() <= MAX_FONT_BYTES);
        }

        // Same face resolves from cache to the same advertisement.
        assert_eq!(resolve_font_assets("Consolas", &settings), Some(assets));
    }

    #[test]
    fn brotli_round_trips_and_shrinks_repetitive_bytes() {
        let data = b"laymux remote font payload ".repeat(500);
        let compressed = compress_brotli(&data).expect("brotli should compress");
        assert!(compressed.len() < data.len());

        let mut decompressed = Vec::new();
        brotli::BrotliDecompress(&mut compressed.as_ref(), &mut decompressed)
            .expect("brotli should round-trip");
        assert_eq!(decompressed, data);
    }

    #[test]
    #[serial(remote_font_cache)]
    fn served_font_lookup_returns_registered_bytes_and_caches_compression() {
        let bytes = Bytes::from_static(b"\x00\x01\x00\x00 laymux test face payload");
        let token = content_token(&bytes);
        register_served_font(token.clone(), bytes.clone(), TTF_KIND);

        let font = served_font(&token).expect("registered font should resolve");
        assert_eq!(font.bytes, bytes);
        assert_eq!(font.content_type, "font/ttf");

        let first = font
            .brotli_bytes()
            .expect("brotli bytes should be produced");
        let second = font.brotli_bytes().expect("brotli bytes should be cached");
        assert_eq!(first, second);

        assert!(served_font("0123456789abcdef").is_none());
    }
}
