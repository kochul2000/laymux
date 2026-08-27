use super::*;
use crate::constants::MAX_ARCHIVE_ENTRIES;
use std::io::{Cursor, Write};

fn temp_path(name: &str) -> std::path::PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!("laymux_archive_{}_{name}", std::process::id()));
    path
}

/// Build a zip with stored entries so the fixture does not depend on the
/// crate's optional deflate codecs.
fn write_zip(path: &std::path::Path, files: &[(&str, &[u8])]) {
    let file = std::fs::File::create(path).expect("create zip");
    let mut writer = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, body) in files {
        writer.start_file(*name, options).expect("start file");
        writer.write_all(body).expect("write body");
    }
    writer.finish().expect("finish zip");
}

fn write_empty_zip_entries(path: &std::path::Path, count: usize) {
    let file = std::fs::File::create(path).expect("create zip");
    let mut writer = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for index in 0..count {
        writer
            .start_file(format!("f{index}"), options)
            .expect("start empty file");
    }
    writer.finish().expect("finish zip");
}

fn append_trailing_directory(bytes: &mut Vec<u8>, fake_name: &[u8], extra: &[u8]) {
    let fake_central_offset = u32::try_from(bytes.len()).expect("small zip fixture");
    bytes.extend_from_slice(b"PK\x01\x02");
    bytes.extend_from_slice(&20_u16.to_le_bytes());
    bytes.extend_from_slice(&20_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    bytes.extend_from_slice(&(fake_name.len() as u16).to_le_bytes());
    bytes.extend_from_slice(&(extra.len() as u16).to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    bytes.extend_from_slice(&0_u32.to_le_bytes());
    bytes.extend_from_slice(fake_name);
    bytes.extend_from_slice(extra);
    let fake_central_size = u32::try_from(ZIP_CENTRAL_HEADER_LEN + fake_name.len() + extra.len())
        .expect("small central directory fixture");

    bytes.extend_from_slice(b"PK\x05\x06");
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&fake_central_size.to_le_bytes());
    bytes.extend_from_slice(&fake_central_offset.to_le_bytes());
    bytes.extend_from_slice(&0_u16.to_le_bytes());
}

fn append_semantically_invalid_trailing_directory(bytes: &mut Vec<u8>) {
    // Structurally valid CDFH whose Unicode Path field is semantically
    // truncated. ZipArchive rejects it and searches for an older EOCD; the
    // bounded reader must report this newest directory's own error.
    let invalid_unicode_extra = [0x75, 0x70, 0x01, 0x00, 0x01];
    append_trailing_directory(bytes, b"fake", &invalid_unicode_extra);
}

fn unicode_path_extra(version: u8, crc_basis: &[u8], name: &[u8]) -> Vec<u8> {
    let field_len = 5_usize.checked_add(name.len()).expect("small zip fixture");
    let mut extra = Vec::with_capacity(4 + field_len);
    extra.extend_from_slice(&0x7075_u16.to_le_bytes());
    extra.extend_from_slice(&(field_len as u16).to_le_bytes());
    extra.push(version);
    extra.extend_from_slice(&crc32fast::hash(crc_basis).to_le_bytes());
    extra.extend_from_slice(name);
    extra
}

#[test]
fn bounded_zip_preflight_rejects_before_the_parser_entry_scan() {
    let path = temp_path("bounded_scan.zip");
    write_zip(&path, &[("a.txt", b"a"), ("b.txt", b"b")]);
    let bytes = std::fs::read(&path).expect("read zip fixture");

    let error = enforce_bounded_zip_metadata(&bytes, 1)
        .expect_err("preflight must reject before ZipArchive parses the directory");

    assert_eq!(
        error,
        "Archive entry count exceeds the 1 entry viewer limit"
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn bounded_zip_rejects_an_actual_archive_over_the_viewer_entry_limit() {
    let path = temp_path("bounded_actual_limit.zip");
    write_empty_zip_entries(&path, MAX_ARCHIVE_ENTRIES + 1);
    let source_len = std::fs::metadata(&path).expect("zip metadata").len() as usize;
    assert!(
        source_len <= 2 * 1024 * 1024,
        "fixture must exercise the entry-count limit, not the source limit"
    );

    let error = super::super::read_archive_listing_bounded(
        &path.to_string_lossy(),
        ArchiveFormat::Zip,
        source_len,
        source_len as u64,
    )
    .expect_err("bounded viewer must reject 5,001 central-directory entries");

    assert_eq!(
        error,
        format!("Archive entry count exceeds the {MAX_ARCHIVE_ENTRIES} entry viewer limit")
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn bounded_zip_never_backtracks_from_a_semantically_invalid_trailing_directory() {
    let path = temp_path("bounded_fake_trailing_eocd.zip");
    write_empty_zip_entries(&path, MAX_ARCHIVE_ENTRIES + 1);
    let mut bytes = std::fs::read(&path).expect("read zip fixture");
    append_semantically_invalid_trailing_directory(&mut bytes);
    std::fs::write(&path, &bytes).expect("write forged zip fixture");

    let parser_error =
        super::super::read_zip_listing(Cursor::new(bytes.clone()), Some(MAX_ARCHIVE_ENTRIES))
            .expect_err("zip parser fixture must backtrack to the older large directory");
    assert_eq!(
        parser_error,
        format!("Archive entry count exceeds the {MAX_ARCHIVE_ENTRIES} entry viewer limit")
    );

    let bounded_error = super::super::read_archive_listing_bounded(
        &path.to_string_lossy(),
        ArchiveFormat::Zip,
        bytes.len(),
        bytes.len() as u64,
    )
    .expect_err("bounded reader must reject the exact newest directory");
    assert_eq!(
        bounded_error,
        "Cannot read zip archive: Unicode path field 0 is truncated"
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn bounded_zip_preserves_eocd_signature_bytes_in_a_file_name() {
    let path = temp_path("bounded_filename_signature.zip");
    let name = "PK\u{5}\u{6}.txt";
    write_zip(&path, &[(name, b"x")]);
    let source_len = std::fs::metadata(&path).expect("zip metadata").len() as usize;

    let listing = super::super::read_archive_listing_bounded(
        &path.to_string_lossy(),
        ArchiveFormat::Zip,
        source_len,
        source_len as u64,
    )
    .expect("metadata signatures inside file names must remain untouched");

    assert_eq!(listing.total_entries, 1);
    assert_eq!(listing.entries[0].name, name);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn bounded_zip_decodes_names_without_a_recovery_parser() {
    assert_eq!(decode_zip_name(b"Cura\x87ao.txt", 0), "Curaçao.txt");
    assert_eq!(
        decode_zip_name(b"PK\x05\x06\xff.txt", 1 << 11),
        "PK\u{5}\u{6}\u{fffd}.txt"
    );
}

#[test]
fn bounded_zip_rejects_duplicate_unicode_path_fields() {
    let path = temp_path("bounded_duplicate_unicode_path.zip");
    write_zip(&path, &[("raw.txt", b"x")]);
    let mut bytes = std::fs::read(&path).expect("read zip fixture");
    let first_name = b"first.txt";
    let mut extra = unicode_path_extra(1, b"raw.txt", first_name);
    extra.extend_from_slice(&unicode_path_extra(1, first_name, b"second.txt"));
    append_trailing_directory(&mut bytes, b"raw.txt", &extra);
    std::fs::write(&path, &bytes).expect("write forged zip fixture");

    let error = super::super::read_archive_listing_bounded(
        &path.to_string_lossy(),
        ArchiveFormat::Zip,
        bytes.len(),
        bytes.len() as u64,
    )
    .expect_err("a Unicode path override must remain bound to the raw central name");

    assert_eq!(
        error,
        "Cannot read zip archive: duplicate Unicode path field 0"
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn bounded_zip_rejects_unsupported_unicode_path_version() {
    let path = temp_path("bounded_unicode_path_version.zip");
    write_zip(&path, &[("raw.txt", b"x")]);
    let mut bytes = std::fs::read(&path).expect("read zip fixture");
    let extra = unicode_path_extra(2, b"raw.txt", b"unicode.txt");
    append_trailing_directory(&mut bytes, b"raw.txt", &extra);
    std::fs::write(&path, &bytes).expect("write forged zip fixture");

    let error = super::super::read_archive_listing_bounded(
        &path.to_string_lossy(),
        ArchiveFormat::Zip,
        bytes.len(),
        bytes.len() as u64,
    )
    .expect_err("only Unicode path extra version 1 is supported");

    assert_eq!(
        error,
        "Cannot read zip archive: Unicode path field 0 uses unsupported version 2"
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn bounded_zip_can_list_an_entry_whose_payload_contains_an_eocd_signature() {
    let path = temp_path("bounded_payload_signature.zip");
    write_zip(&path, &[("nested.bin", b"before PK\x05\x06 after")]);
    let source_len = std::fs::metadata(&path).expect("zip metadata").len() as usize;

    let listing = super::super::read_archive_listing_bounded(
        &path.to_string_lossy(),
        ArchiveFormat::Zip,
        source_len,
        source_len as u64,
    )
    .expect("payload signatures must not affect metadata listing");

    assert_eq!(listing.total_entries, 1);
    assert_eq!(listing.entries[0].name, "nested.bin");
    let _ = std::fs::remove_file(&path);
}
