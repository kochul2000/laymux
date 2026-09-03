use std::fs;

use tempfile::tempdir;

use super::*;

fn default_policy() -> AttachmentPolicy {
    AttachmentPolicy::from_settings(&RemoteSettings::default())
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
    let policy = AttachmentPolicy::from_settings(&settings);
    assert_eq!(
        policy.max_bytes,
        MAX_REMOTE_ATTACHMENT_MIB as usize * 1024 * 1024
    );
    assert_eq!(policy.extra_extensions, vec!["xlsx".to_string()]);
    assert_eq!(
        policy.cache_quota_bytes(),
        policy.max_bytes * REMOTE_TERMINAL_ATTACHMENT_CACHE_FILES_OF_MAX_SIZE
    );

    settings.attachment_max_mib = 0;
    assert_eq!(
        AttachmentPolicy::from_settings(&settings).max_bytes,
        1024 * 1024
    );
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
        Err(AttachmentError::TooLarge(1))
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
        MAX_REMOTE_ATTACHMENT_MIB as usize * 1024 * 1024,
    ] {
        let bytes = vec![0u8; max_bytes];
        assert_eq!(
            BASE64.encode(bytes).len(),
            encoded_attachment_limit(max_bytes)
        );
    }
}

#[test]
fn transport_bounds_cover_the_largest_configurable_attachment() {
    let max_bytes = MAX_REMOTE_ATTACHMENT_MIB as usize * 1024 * 1024;
    let request_limit = attachment_request_limit(max_bytes);
    assert!(request_limit > encoded_attachment_limit(max_bytes));
    // The attachment JSON is sealed and base64url-encoded once more inside
    // the Android E2E RPC envelope.
    assert!(android_e2e_rpc_body_limit() >= request_limit.div_ceil(3) * 4);
}

#[cfg(target_os = "windows")]
#[test]
fn wsl_profiles_receive_a_guest_visible_path() {
    assert_eq!(
        terminal_visible_path(Path::new(r"C:\Users\test\file.txt"), "Ubuntu (WSL)"),
        "/mnt/c/Users/test/file.txt"
    );
}
