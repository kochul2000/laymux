use std::fs;

use tempfile::tempdir;

use super::*;

#[test]
fn accepts_signature_checked_images_and_uses_the_detected_extension() {
    let directory = tempdir().unwrap();
    let path = save_attachment_to_dir(
        directory.path(),
        "camera.bin",
        "application/octet-stream",
        b"\x89PNG\r\n\x1a\n",
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
    let error = classify_attachment("notes.txt", "text/plain", &[0xff, 0x00]).unwrap_err();
    assert!(matches!(error, AttachmentError::Invalid(_)));
}

#[test]
fn rejects_unsupported_binary_content() {
    let error =
        classify_attachment("archive.zip", "application/zip", b"PK\x03\x04binary").unwrap_err();
    assert_eq!(
        error,
        AttachmentError::Invalid("only image and text attachments are supported".into())
    );
}

#[test]
fn enforces_file_and_cache_size_bounds() {
    let directory = tempdir().unwrap();
    let oversized = vec![b'a'; REMOTE_TERMINAL_ATTACHMENT_MAX_BYTES + 1];
    assert_eq!(
        save_attachment_to_dir(
            directory.path(),
            "large.txt",
            "text/plain",
            &oversized,
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
    let bytes = vec![0u8; REMOTE_TERMINAL_ATTACHMENT_MAX_BYTES];
    assert_eq!(BASE64.encode(bytes).len(), encoded_attachment_limit());
}

#[cfg(target_os = "windows")]
#[test]
fn wsl_profiles_receive_a_guest_visible_path() {
    assert_eq!(
        terminal_visible_path(Path::new(r"C:\Users\test\file.txt"), "Ubuntu (WSL)"),
        "/mnt/c/Users/test/file.txt"
    );
}
