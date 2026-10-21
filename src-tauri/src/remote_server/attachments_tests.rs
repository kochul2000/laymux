use std::fs;

use tempfile::tempdir;

use super::*;

fn default_policy() -> AttachmentPolicy {
    AttachmentPolicy::from_settings(&RemoteSettings::default(), None)
}

fn policy_with(allow_all: bool, extra: &[&str]) -> AttachmentPolicy {
    AttachmentPolicy {
        allow_all_extensions: allow_all,
        extra_extensions: extra.iter().map(|value| value.to_string()).collect(),
        ..default_policy()
    }
}

#[test]
fn accepts_signature_checked_images_and_uses_the_detected_extension() {
    let directory = tempdir().unwrap();
    let path = save_attachment_to_dir(
        directory.path(),
        "camera.bin",
        "application/octet-stream",
        b"\x89PNG\r\n\x1a\n",
        &default_policy(),
        1024,
        usize::MAX,
    )
    .unwrap();

    assert_eq!(
        path.extension().and_then(|value| value.to_str()),
        Some("png")
    );
    assert_eq!(fs::read(path).unwrap(), b"\x89PNG\r\n\x1a\n");
}

#[test]
fn accepts_utf8_text_and_sanitizes_the_caller_file_name() {
    let directory = tempdir().unwrap();
    let path = save_attachment_to_dir(
        directory.path(),
        "../bad path/프롬프트.md",
        "text/markdown",
        "한글 prompt".as_bytes(),
        &default_policy(),
        1024,
        usize::MAX,
    )
    .unwrap();
    let file_name = path.file_name().unwrap().to_string_lossy();

    assert!(file_name.starts_with("remote-"));
    assert!(file_name.ends_with("-attachment.md"));
    assert!(!file_name.contains(".."));
    assert_eq!(fs::read_to_string(path).unwrap(), "한글 prompt");
}

#[test]
fn rejects_binary_content_disguised_as_text() {
    let error = classify_attachment("notes.txt", "text/plain", &[0xff, 0x00], &default_policy())
        .unwrap_err();
    assert!(matches!(error, AttachmentError::Invalid(_)));
}

#[test]
fn rejects_unsupported_binary_content() {
    let error = classify_attachment(
        "archive.zip",
        "application/zip",
        b"PK\x03\x04binary",
        &default_policy(),
    )
    .unwrap_err();
    assert_eq!(
        error,
        AttachmentError::Invalid(
            "only image, text, PDF, DOCX, PPTX and host-allowed extensions are supported".into()
        )
    );
}

#[test]
fn accepts_signature_checked_documents_and_ignores_the_caller_extension() {
    assert_eq!(
        classify_attachment(
            "report.bin",
            "application/octet-stream",
            b"%PDF-1.7\n%binary",
            &default_policy(),
        ),
        Ok(AttachmentKind::Document("pdf"))
    );
    let docx = [
        b"PK\x03\x04".as_slice(),
        b"\x00zip\x00word/document.xml\x00",
    ]
    .concat();
    assert_eq!(
        classify_attachment("memo.bin", "", &docx, &default_policy()),
        Ok(AttachmentKind::Document("docx"))
    );
    let pptx = [
        b"PK\x03\x04".as_slice(),
        b"\x00zip\x00ppt/presentation.xml\x00",
    ]
    .concat();
    assert_eq!(
        classify_attachment(
            "deck.docx",
            "application/octet-stream",
            &pptx,
            &default_policy()
        ),
        Ok(AttachmentKind::Document("pptx"))
    );
}

#[test]
fn rejects_zip_archives_renamed_as_office_documents() {
    let error = classify_attachment(
        "fake.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        b"PK\x03\x04\x00not-an-office-package\x00",
        &default_policy(),
    )
    .unwrap_err();
    assert!(matches!(error, AttachmentError::Invalid(_)));
}

#[test]
fn host_allowed_extensions_are_stored_as_opaque_binary() {
    let policy = policy_with(false, &["xlsx"]);
    assert_eq!(
        classify_attachment("Budget.XLSX", "application/zip", b"PK\x03\x04\x00", &policy),
        Ok(AttachmentKind::Opaque("xlsx".into()))
    );
    // Only the listed extension is opened up; everything else keeps the
    // signature/text rules.
    assert!(classify_attachment("data.bin", "", b"\x00\x01", &policy).is_err());
}

#[test]
fn allow_all_accepts_anything_and_falls_back_to_bin() {
    let policy = policy_with(true, &[]);
    assert_eq!(
        classify_attachment("blob", "application/octet-stream", b"\x00\x01", &policy),
        Ok(AttachmentKind::Opaque("bin".into()))
    );
    assert_eq!(
        classify_attachment("weird.t@r", "", b"\x00", &policy),
        Ok(AttachmentKind::Opaque("bin".into()))
    );
    // A text-declared file with invalid UTF-8 is no longer rejected: the host
    // asked for everything, so it is kept under its own extension.
    assert_eq!(
        classify_attachment("notes.txt", "text/plain", &[0xff, 0x00], &policy),
        Ok(AttachmentKind::Opaque("txt".into()))
    );
    // Signature-checked kinds still win so the stored extension stays honest.
    assert_eq!(
        classify_attachment("photo.dat", "", b"\x89PNG\r\n\x1a\n", &policy),
        Ok(AttachmentKind::Image("png"))
    );
}

#[test]
fn policy_from_settings_clamps_the_limit_and_drops_invalid_extensions() {
    let mut settings = RemoteSettings {
        attachment_max_mib: 99,
        attachment_extra_extensions: vec!["xlsx".into(), ".zip".into(), "TAR".into(), "".into()],
        ..RemoteSettings::default()
    };
    let policy = AttachmentPolicy::from_settings(&settings, None);
    assert_eq!(
        policy.max_bytes,
        REMOTE_TERMINAL_ATTACHMENT_MAX_MIB as usize * 1024 * 1024
    );
    assert_eq!(policy.extra_extensions, vec!["xlsx".to_string()]);
    assert_eq!(
        policy.cache_quota_bytes(),
        policy.max_bytes * REMOTE_TERMINAL_ATTACHMENT_CACHE_FILES_OF_MAX_SIZE
    );

    settings.attachment_max_mib = 0;
    assert_eq!(
        AttachmentPolicy::from_settings(&settings, None).max_bytes,
        1024 * 1024
    );
}

#[test]
fn default_settings_allow_the_16_mib_maximum_with_a_256_mib_cache_quota() {
    // ADR-0353: the default is the 16 MiB maximum, and the cache keeps 16
    // maximum-size attachments (256 MiB) instead of 64 (1 GiB).
    assert_eq!(RemoteSettings::default().attachment_max_mib, 16);
    assert_eq!(REMOTE_TERMINAL_ATTACHMENT_MAX_MIB, 16);
    let policy = default_policy();
    assert_eq!(policy.max_bytes, 16 * MIB);
    assert_eq!(policy.host_max_bytes, 16 * MIB);
    assert_eq!(REMOTE_TERMINAL_ATTACHMENT_CACHE_FILES_OF_MAX_SIZE, 16);
    assert_eq!(policy.cache_quota_bytes(), 256 * MIB);
    assert_eq!(REMOTE_TERMINAL_ATTACHMENT_CACHE_MAX_FILES, 1024);
    assert_eq!(crate::constants::REMOTE_TERMINAL_ATTACHMENT_MAX_AGE_DAYS, 7);
}

#[test]
fn enforces_file_and_cache_size_bounds() {
    let directory = tempdir().unwrap();
    let policy = default_policy();
    let oversized = vec![b'a'; policy.max_bytes + 1];
    assert_eq!(
        save_attachment_to_dir(
            directory.path(),
            "large.txt",
            "text/plain",
            &oversized,
            &policy,
            usize::MAX,
            usize::MAX,
        ),
        Err(AttachmentError::TooLarge)
    );

    fs::write(directory.path().join("existing.txt"), b"12345678").unwrap();
    assert_eq!(
        save_attachment_to_dir(
            directory.path(),
            "next.txt",
            "text/plain",
            b"1234",
            &policy,
            10,
            usize::MAX,
        ),
        Err(AttachmentError::QuotaExceeded)
    );
}

#[test]
fn enforces_cache_file_count_bound_for_empty_attachments() {
    let directory = tempdir().unwrap();
    fs::write(directory.path().join("first.txt"), b"").unwrap();
    fs::write(directory.path().join("second.txt"), b"").unwrap();

    assert_eq!(
        save_attachment_to_dir(
            directory.path(),
            "third.txt",
            "text/plain",
            b"",
            &default_policy(),
            usize::MAX,
            2,
        ),
        Err(AttachmentError::QuotaExceeded)
    );
}

#[test]
fn attachment_directory_is_nested_under_the_user_cache() {
    let cache = Path::new("user-cache");
    assert_eq!(
        attachment_dir_under(cache),
        cache.join("remote-attachments")
    );
}

#[cfg(unix)]
#[test]
fn attachment_directory_is_private() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempdir().unwrap();
    let directory = root.path().join("attachments");
    save_attachment_to_dir(
        &directory,
        "empty.txt",
        "text/plain",
        b"",
        &default_policy(),
        usize::MAX,
        usize::MAX,
    )
    .unwrap();

    assert_eq!(
        fs::metadata(directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[test]
fn cleanup_removes_only_regular_files_older_than_the_cutoff() {
    let directory = tempdir().unwrap();
    let old_file = directory.path().join("old.txt");
    let nested = directory.path().join("nested");
    fs::write(&old_file, b"old").unwrap();
    fs::create_dir(&nested).unwrap();

    let removed = cleanup_stale_attachments_in(directory.path(), 0).unwrap();

    assert_eq!(removed, 1);
    assert!(!old_file.exists());
    assert!(nested.exists());
}

#[test]
fn encoded_limit_covers_exact_decoded_maximum() {
    for max_bytes in [
        1024 * 1024,
        REMOTE_TERMINAL_ATTACHMENT_MAX_MIB as usize * 1024 * 1024,
    ] {
        let bytes = vec![0u8; max_bytes];
        assert_eq!(
            BASE64.encode(bytes).len(),
            remote_attachment_encoded_limit(max_bytes)
        );
    }
}

#[test]
fn transport_bounds_cover_the_largest_configurable_attachment() {
    let max_bytes = REMOTE_TERMINAL_ATTACHMENT_MAX_MIB as usize * 1024 * 1024;
    let request_limit = remote_attachment_request_limit(max_bytes);
    assert!(request_limit > remote_attachment_encoded_limit(max_bytes));
    // The decrypted inner request must hold that JSON plus the PlainRequest wrapper.
    let plaintext = crate::constants::ANDROID_E2E_MAX_REQUEST_PLAINTEXT_BYTES;
    assert!(plaintext > request_limit);
    // The binary envelope (ADR-0351) seals that plaintext raw: 31 B prefix +
    // ciphertext + 16 B tag, with no base64 layer.
    let largest_envelope = ANDROID_E2E_RPC_ENVELOPE_PREFIX_BYTES + plaintext + 16;
    let desktop_limit = crate::constants::android_e2e_rpc_body_limit(max_bytes);
    assert_eq!(desktop_limit, largest_envelope);
    // ...which fits under the relay's 24 MiB streamed cap and the desktop
    // tunnel's own per-stream bound (ADR-0353).
    assert!(largest_envelope <= CLOUD_RELAY_ANDROID_E2E_RPC_BODY_LIMIT);
    assert_eq!(CLOUD_RELAY_ANDROID_E2E_RPC_BODY_LIMIT, 24 * MIB);
    assert_eq!(CLOUD_RELAY_HTTP_REQUEST_BYTES_LIMIT, 24 * MIB);
    assert!(desktop_limit < CLOUD_RELAY_HTTP_REQUEST_BYTES_LIMIT);
    // 16 MiB decoded: 22,369,624 B base64, 22,386,008 B JSON (about 21.35 MiB)
    // on the browser path and a 22,402,439 B envelope (about 21.36 MiB) on the
    // Android binary path; both clear 24 MiB with room for format changes.
    assert_eq!(max_bytes, 16 * MIB);
    assert_eq!(remote_attachment_encoded_limit(max_bytes), 22_369_624);
    assert_eq!(request_limit, 22_386_008);
    assert_eq!(desktop_limit, 22_402_439);
    assert!(request_limit < 22 * MIB && desktop_limit < 22 * MIB);
    // A 1 MiB host keeps the envelope at the 2 MiB the route always allowed.
    assert_eq!(crate::constants::android_e2e_rpc_body_limit(MIB), 2 * MIB);
    // Every host setting yields a bound between the floor and the max-host bound.
    for mib in 1..=REMOTE_TERMINAL_ATTACHMENT_MAX_MIB as usize {
        let limit = crate::constants::android_e2e_rpc_body_limit(mib * MIB);
        assert!((2 * MIB..=desktop_limit).contains(&limit), "{mib} MiB");
    }
}

#[test]
fn android_cloud_relay_cap_is_the_floored_binary_inverse_of_24_mib() {
    // 24 MiB - 31 B prefix - 16 B tag - 16 KiB wrapper - 16 KiB attachment
    // slack, then one base64 layer stripped: about 17.98 MiB, floored to 17.
    let cap = relay_attachment_cap(RemoteTransport::AndroidE2e {
        via_cloud_relay: true,
    });
    assert_eq!(cap, Some(17 * MIB));
    // The floored cap's attachment must really fit the relay bound once sealed.
    assert!(
        crate::constants::android_e2e_rpc_body_limit(17 * MIB)
            <= CLOUD_RELAY_ANDROID_E2E_RPC_BODY_LIMIT
    );
    assert!(
        crate::constants::android_e2e_rpc_body_limit(18 * MIB)
            > CLOUD_RELAY_ANDROID_E2E_RPC_BODY_LIMIT
    );
}

#[test]
fn browser_cloud_relay_cap_is_the_floored_base64_inverse_of_24_mib() {
    // 24 MiB - 16 KiB attachment slack, base64 stripped: about 17.99 MiB,
    // floored to 17 (ADR-0353).
    let cap = relay_attachment_cap(RemoteTransport::CloudRelayBrowser);
    assert_eq!(cap, Some(17 * MIB));
    assert!(remote_attachment_request_limit(17 * MIB) <= CLOUD_RELAY_HTTP_REQUEST_BYTES_LIMIT);
    assert!(remote_attachment_request_limit(18 * MIB) > CLOUD_RELAY_HTTP_REQUEST_BYTES_LIMIT);
    // Neither relay path binds the 16 MiB host maximum.
    assert!(cap.is_some_and(|relay| relay > REMOTE_TERMINAL_ATTACHMENT_MAX_MIB as usize * MIB));
}

#[cfg(target_os = "windows")]
#[test]
fn wsl_profiles_receive_a_guest_visible_path() {
    assert_eq!(
        terminal_visible_path(Path::new(r"C:\Users\test\file.txt"), "Ubuntu (WSL)"),
        "/mnt/c/Users/test/file.txt"
    );
}

#[test]
fn cloud_relay_paths_cap_the_policy_and_name_tailscale_in_the_message() {
    let settings = RemoteSettings {
        attachment_max_mib: REMOTE_TERMINAL_ATTACHMENT_MAX_MIB,
        ..RemoteSettings::default()
    };
    let host = REMOTE_TERMINAL_ATTACHMENT_MAX_MIB as usize * MIB;

    let direct = AttachmentPolicy::from_settings(&settings, None);
    assert_eq!((direct.max_bytes, direct.relay_max_bytes), (host, None));
    assert!(!direct.relay_limited());
    assert_eq!(
        direct.too_large_message(),
        "attachment exceeds the 16 MiB limit"
    );

    let direct_e2e = AttachmentPolicy::from_settings(
        &settings,
        Some(RemoteTransport::AndroidE2e {
            via_cloud_relay: false,
        }),
    );
    assert_eq!(
        (direct_e2e.max_bytes, direct_e2e.relay_max_bytes),
        (host, None)
    );

    // The relay forwards up to 24 MiB of browser request body, which carries
    // 17 MiB of attachment, so the 16 MiB host maximum still fits; the relay
    // bound is reported but not binding (ADR-0353).
    let browser =
        AttachmentPolicy::from_settings(&settings, Some(RemoteTransport::CloudRelayBrowser));
    assert_eq!(
        (browser.max_bytes, browser.relay_max_bytes),
        (host, Some(17 * MIB))
    );
    assert!(!browser.relay_limited());

    // The relay streams the binary Android E2E RPC body up to 24 MiB
    // (ADR-0351, ADR-0353), which carries 17 MiB of attachment: the 16 MiB
    // host maximum still binds, so no Tailscale hint is shown.
    let android = AttachmentPolicy::from_settings(
        &settings,
        Some(RemoteTransport::AndroidE2e {
            via_cloud_relay: true,
        }),
    );
    assert_eq!(
        (android.max_bytes, android.relay_max_bytes),
        (host, Some(17 * MIB))
    );
    assert_eq!(android.host_max_bytes, host);
    assert!(!android.relay_limited());
    let message = android.too_large_message();
    assert_eq!(message, "attachment exceeds the 16 MiB limit");
    assert!(!message.contains("Tailscale"), "{message}");
    // Quota follows the host maximum, not the path the request took.
    assert_eq!(android.cache_quota_bytes(), direct.cache_quota_bytes());
}

#[test]
fn relay_limited_message_still_names_tailscale_when_the_relay_binds() {
    let policy = AttachmentPolicy {
        max_bytes: MIB,
        host_max_bytes: 10 * MIB,
        relay_max_bytes: Some(MIB),
        ..default_policy()
    };
    assert!(policy.relay_limited());
    let message = policy.too_large_message();
    assert!(
        message.contains("Cloud relay payload limit of 1 MiB"),
        "{message}"
    );
    assert!(message.contains("Tailscale"), "{message}");
    assert!(message.contains("10 MiB"), "{message}");
}
