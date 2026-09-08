use super::*;
use std::io::Write;

fn temp_path(name: &str) -> std::path::PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!("laymux_archive_{}_{name}", std::process::id()));
    path
}

/// Build a zip with stored entries so the fixture does not depend on the
/// crate's optional deflate codecs.
fn write_zip(path: &std::path::Path, files: &[(&str, &[u8])], dirs: &[&str]) {
    let file = std::fs::File::create(path).expect("create zip");
    let mut writer = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for dir in dirs {
        writer.add_directory(*dir, options).expect("add dir");
    }
    for (name, body) in files {
        writer.start_file(*name, options).expect("start file");
        writer.write_all(body).expect("write body");
    }
    writer.finish().expect("finish zip");
}

fn write_tar(path: &std::path::Path, files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for (name, body) in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, *name, *body)
            .expect("append tar entry");
    }
    let bytes = builder.into_inner().expect("finish tar");
    std::fs::write(path, &bytes).expect("write tar");
    bytes
}

#[test]
fn archive_format_needs_the_whole_name_for_double_extensions() {
    assert_eq!(archive_format("bundle.tar.gz"), Some(ArchiveFormat::TarGz));
    assert_eq!(archive_format("bundle.TGZ"), Some(ArchiveFormat::TarGz));
    assert_eq!(archive_format("bundle.tar"), Some(ArchiveFormat::Tar));
    assert_eq!(archive_format("app.jar"), Some(ArchiveFormat::Zip));
    assert_eq!(archive_format("pkg.whl"), Some(ArchiveFormat::Zip));
    // Formats with no decoder in this build must not claim to be listable.
    assert_eq!(archive_format("bundle.tar.xz"), None);
    assert_eq!(archive_format("bundle.7z"), None);
    assert_eq!(archive_format("notes.txt"), None);
}

#[test]
fn zip_listing_reports_names_sizes_and_directories() {
    let path = temp_path("listing.zip");
    write_zip(
        &path,
        &[("src/main.rs", b"fn main() {}"), ("README.md", b"hi")],
        &["src/"],
    );

    let listing =
        read_archive_listing(&path.to_string_lossy(), ArchiveFormat::Zip).expect("zip must list");

    assert_eq!(listing.format, ArchiveFormat::Zip);
    assert_eq!(listing.total_entries, 3);
    assert!(!listing.truncated);
    let dir = listing
        .entries
        .iter()
        .find(|e| e.is_directory)
        .expect("directory entry");
    assert_eq!(dir.name, "src/");
    let main = listing
        .entries
        .iter()
        .find(|e| e.name == "src/main.rs")
        .expect("file entry");
    assert_eq!(main.size, 12);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn tar_listing_reports_every_entry() {
    let path = temp_path("listing.tar");
    write_tar(&path, &[("a.txt", b"aaa"), ("nested/b.txt", b"bbbb")]);

    let listing =
        read_archive_listing(&path.to_string_lossy(), ArchiveFormat::Tar).expect("tar must list");

    assert_eq!(listing.format, ArchiveFormat::Tar);
    assert_eq!(listing.total_entries, 2);
    assert_eq!(listing.entries[0].name, "a.txt");
    assert_eq!(listing.entries[0].size, 3);
    // Tar has no per-entry compression, so both sizes are the same number.
    assert_eq!(listing.entries[0].compressed_size, 3);
    assert_eq!(listing.entries[1].name, "nested/b.txt");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn tar_gz_listing_inflates_only_the_headers() {
    let raw = {
        let path = temp_path("source.tar");
        let bytes = write_tar(&path, &[("only.txt", b"payload")]);
        let _ = std::fs::remove_file(&path);
        bytes
    };
    let path = temp_path("listing.tar.gz");
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&raw).expect("gzip write");
    std::fs::write(&path, encoder.finish().expect("gzip finish")).expect("write tgz");

    let listing = read_archive_listing(&path.to_string_lossy(), ArchiveFormat::TarGz)
        .expect("tar.gz must list");

    assert_eq!(listing.format, ArchiveFormat::TarGz);
    assert_eq!(listing.total_entries, 1);
    assert_eq!(listing.entries[0].name, "only.txt");
    assert_eq!(listing.entries[0].size, 7);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn bounded_tar_gz_stops_at_the_inflate_budget() {
    let raw = {
        let path = temp_path("bounded_source.tar");
        let bytes = write_tar(
            &path,
            &[("first.txt", &[b'a'; 4096]), ("second.txt", &[b'b'; 4096])],
        );
        let _ = std::fs::remove_file(&path);
        bytes
    };
    let path = temp_path("bounded_listing.tar.gz");
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&raw).expect("gzip write");
    let compressed = encoder.finish().expect("gzip finish");
    std::fs::write(&path, &compressed).expect("write tgz");

    let listing = read_archive_listing_bounded(
        &path.to_string_lossy(),
        ArchiveFormat::TarGz,
        compressed.len(),
        4_900,
    )
    .expect("bounded tar.gz keeps the completed prefix");

    assert!(listing.truncated);
    assert_eq!(listing.entries.len(), 1);
    assert_eq!(listing.entries[0].name, "first.txt");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn the_size_total_covers_entries_the_listing_cap_dropped() {
    // The frontend pairs `total_bytes` with `total_entries` in one summary
    // line. If the total only counted listed entries, a capped archive would
    // advertise its full entry count next to a fraction of its size.
    let over_cap = MAX_ARCHIVE_ENTRIES + 5;
    let bodies: Vec<(String, Vec<u8>)> = (0..over_cap)
        .map(|index| (format!("f{index}.bin"), vec![b'x'; 10]))
        .collect();
    let refs: Vec<(&str, &[u8])> = bodies
        .iter()
        .map(|(name, body)| (name.as_str(), body.as_slice()))
        .collect();
    let path = temp_path("capped.tar");
    write_tar(&path, &refs);

    let listing =
        read_archive_listing(&path.to_string_lossy(), ArchiveFormat::Tar).expect("tar must list");

    assert!(listing.truncated);
    assert_eq!(listing.entries.len(), MAX_ARCHIVE_ENTRIES);
    assert_eq!(listing.total_entries, over_cap);
    assert_eq!(listing.total_bytes, over_cap as u64 * 10);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_corrupt_archive_errors_instead_of_panicking() {
    let path = temp_path("corrupt.zip");
    std::fs::write(&path, b"PK\x03\x04 this is not a real central directory")
        .expect("write corrupt zip");

    let result = read_archive_listing(&path.to_string_lossy(), ArchiveFormat::Zip);

    assert!(result.is_err(), "corrupt zip must not list");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_missing_archive_errors() {
    let path = temp_path("definitely_missing.zip");
    let _ = std::fs::remove_file(&path);

    let result = read_archive_listing(&path.to_string_lossy(), ArchiveFormat::Zip);

    assert!(result.is_err(), "missing archive must not list");
}

#[test]
fn a_stream_that_ends_mid_entry_keeps_the_entries_it_already_read() {
    // Cutting an uncompressed tar is deterministic: entry one occupies blocks
    // 0..4608 and entry two's header needs 4608..5120, so a cut at 4900 leaves
    // that header incomplete. This is the same branch a bounded `.tar.gz`
    // reaches when it hits the inflate limit.
    let raw = {
        let path = temp_path("source_trunc.tar");
        let bytes = write_tar(
            &path,
            &[("first.txt", &[b'a'; 4096]), ("second.txt", &[b'b'; 4096])],
        );
        let _ = std::fs::remove_file(&path);
        bytes
    };
    let mut cut = raw;
    cut.truncate(4_900);
    let path = temp_path("truncated.tar");
    std::fs::write(&path, &cut).expect("write truncated tar");

    let listing = read_archive_listing(&path.to_string_lossy(), ArchiveFormat::Tar)
        .expect("a partial stream still lists what it read");

    assert!(listing.truncated, "a cut stream must report truncation");
    assert_eq!(
        listing.entries.len(),
        1,
        "the entry completed before the cut must survive"
    );
    assert_eq!(listing.entries[0].name, "first.txt");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_stream_cut_before_its_first_entry_errors() {
    // Nothing was read, so there is nothing honest to show; the caller
    // degrades to the binary placeholder instead of an empty listing.
    let path = temp_path("headless.tar");
    std::fs::write(&path, [0_u8; 100]).expect("write partial header");

    let result = read_archive_listing(&path.to_string_lossy(), ArchiveFormat::Tar);

    assert!(result.is_err(), "a header-less stream must not list");
    let _ = std::fs::remove_file(&path);
}
