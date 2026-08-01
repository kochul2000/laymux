//! Archive listing for the built-in file viewer (ADR-0109).
//!
//! Listing means metadata only: zip is read from its central directory and tar
//! from its 512-byte headers. Nothing is extracted, so a listing costs the same
//! whether the archive holds one file or a gigabyte of them. `.tar.gz` is the
//! one exception — the gzip layer has to be inflated to reach the headers at
//! all — and that path is bounded so a crafted stream cannot inflate forever.

use crate::constants::{MAX_ARCHIVE_ENTRIES, MAX_ARCHIVE_INFLATE_BYTES};
use std::io::Read;

/// One entry of an archive as the viewer shows it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    /// Path inside the archive, exactly as stored.
    pub name: String,
    /// Uncompressed size. Tar entries report this as their only size.
    pub size: u64,
    /// Stored size. Equals `size` for tar, which does not compress per entry.
    pub compressed_size: u64,
    pub is_directory: bool,
}

/// The metadata a viewer needs to draw an archive without extracting it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveListing {
    pub format: ArchiveFormat,
    pub entries: Vec<ArchiveEntry>,
    /// Entries in the archive, which exceeds `entries.len()` when capped.
    pub total_entries: usize,
    /// Uncompressed bytes across **every** entry, not only the listed ones.
    /// Summing `entries` in the frontend would pair a whole-archive count with
    /// a partial size and read as though the archive were far smaller than it
    /// is; both walks below already visit every header, so the real total costs
    /// nothing extra.
    pub total_bytes: u64,
    pub truncated: bool,
}

/// Container formats the viewer can enumerate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    Zip,
    Tar,
    TarGz,
}

impl ArchiveFormat {
    /// Stable wire name for the frontend.
    pub fn as_str(self) -> &'static str {
        match self {
            ArchiveFormat::Zip => "zip",
            ArchiveFormat::Tar => "tar",
            ArchiveFormat::TarGz => "tar.gz",
        }
    }
}

/// Extensions that are zip containers under a different name. Listing them is
/// identical to listing a `.zip`, and a developer opening a `.jar` or a `.whl`
/// wants the same file list they would get from `unzip -l`.
const ZIP_EXTENSIONS: &[&str] = &[
    ".zip", ".jar", ".war", ".ear", ".whl", ".egg", ".nupkg", ".vsix", ".xpi", ".apk", ".aar",
    ".crx", ".ipa", ".zipx",
];

/// Classify a file **name** — not an extension — because `.tar.gz` only makes
/// sense as a pair. Compression formats the viewer cannot enumerate (`.tar.xz`,
/// `.tar.bz2`, `.7z`, `.rar`) deliberately return `None` and fall back to the
/// binary placeholder rather than pulling in a decoder per format.
pub fn archive_format(file_name: &str) -> Option<ArchiveFormat> {
    let lower = file_name.to_lowercase();
    if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        return Some(ArchiveFormat::TarGz);
    }
    if lower.ends_with(".tar") {
        return Some(ArchiveFormat::Tar);
    }
    if ZIP_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        return Some(ArchiveFormat::Zip);
    }
    None
}

/// Enumerate an archive's entries.
///
/// Every failure mode — unreadable file, wrong magic, corrupt central
/// directory, gzip stream that ends mid-header — surfaces as `Err`, and the
/// caller degrades to the binary placeholder. Nothing here may panic: the input
/// is an untrusted file the user merely clicked on.
pub fn read_archive_listing(path: &str, format: ArchiveFormat) -> Result<ArchiveListing, String> {
    match format {
        ArchiveFormat::Zip => read_zip_listing(path),
        ArchiveFormat::Tar => {
            let file =
                std::fs::File::open(path).map_err(|e| format!("Cannot open archive: {e}"))?;
            read_tar_listing(file, ArchiveFormat::Tar)
        }
        ArchiveFormat::TarGz => {
            let file =
                std::fs::File::open(path).map_err(|e| format!("Cannot open archive: {e}"))?;
            let decoder = flate2::read::GzDecoder::new(file);
            read_tar_listing(
                decoder.take(MAX_ARCHIVE_INFLATE_BYTES),
                ArchiveFormat::TarGz,
            )
        }
    }
}

fn read_zip_listing(path: &str) -> Result<ArchiveListing, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Cannot open archive: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Cannot read zip archive: {e}"))?;

    let total_entries = archive.len();
    let listed = total_entries.min(MAX_ARCHIVE_ENTRIES);
    let mut entries = Vec::with_capacity(listed);
    let mut total_bytes = 0_u64;
    // Walk every entry for the size total even when the listing is capped; the
    // central directory is already parsed, so this is a loop over memory.
    for index in 0..total_entries {
        // `by_index_raw` reads the header without preparing a decompressor, so
        // an entry compressed with a method this build does not support (the
        // crate is pulled in without its optional codecs) still lists.
        let entry = archive
            .by_index_raw(index)
            .map_err(|e| format!("Cannot read zip entry {index}: {e}"))?;
        total_bytes = total_bytes.saturating_add(entry.size());
        if index >= listed {
            continue;
        }
        entries.push(ArchiveEntry {
            name: entry.name().to_string(),
            size: entry.size(),
            compressed_size: entry.compressed_size(),
            is_directory: entry.is_dir(),
        });
    }

    Ok(ArchiveListing {
        format: ArchiveFormat::Zip,
        entries,
        total_entries,
        total_bytes,
        truncated: total_entries > listed,
    })
}

fn read_tar_listing<R: Read>(reader: R, format: ArchiveFormat) -> Result<ArchiveListing, String> {
    let mut archive = tar::Archive::new(reader);
    let iter = archive
        .entries()
        .map_err(|e| format!("Cannot read tar archive: {e}"))?;

    let mut entries = Vec::new();
    let mut total_entries = 0_usize;
    let mut total_bytes = 0_u64;
    let mut truncated = false;
    for entry in iter {
        // A tar stream is walked sequentially, so a read error partway through
        // still leaves the entries already collected valid. Report those and
        // mark the listing truncated instead of discarding the whole file —
        // this is also how a gzip stream hitting the inflate bound lands here.
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) if total_entries > 0 => {
                truncated = true;
                break;
            }
            Err(e) => return Err(format!("Cannot read tar archive: {e}")),
        };
        total_entries += 1;
        let header = entry.header();
        let size = header.size().unwrap_or(0);
        total_bytes = total_bytes.saturating_add(size);
        // Keep walking past the cap rather than stopping: the count and the
        // size total are only honest if every header is visited, and a listing
        // that under-reports both is worse than one that reads a few more
        // headers. The gzip path is bounded separately by the inflate limit.
        if entries.len() >= MAX_ARCHIVE_ENTRIES {
            truncated = true;
            continue;
        }
        let name = entry
            .path()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| String::from_utf8_lossy(&entry.path_bytes()).into_owned());
        entries.push(ArchiveEntry {
            name,
            size,
            compressed_size: size,
            is_directory: header.entry_type().is_dir(),
        });
    }

    Ok(ArchiveListing {
        format,
        entries,
        total_entries,
        total_bytes,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("laymux_archive_{}_{name}", std::process::id()));
        path
    }

    /// Build a zip with stored (uncompressed) entries so the fixture does not
    /// depend on the crate's optional deflate codecs.
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

        let listing = read_archive_listing(&path.to_string_lossy(), ArchiveFormat::Zip)
            .expect("zip must list");

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

        let listing = read_archive_listing(&path.to_string_lossy(), ArchiveFormat::Tar)
            .expect("tar must list");

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
    fn the_size_total_covers_entries_the_listing_cap_dropped() {
        // The frontend pairs `total_bytes` with `total_entries` in one summary
        // line. If the total only counted listed entries, a capped archive
        // would advertise its full entry count next to a fraction of its size.
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

        let listing = read_archive_listing(&path.to_string_lossy(), ArchiveFormat::Tar)
            .expect("tar must list");

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
        // Cutting an uncompressed tar is deterministic: entry one occupies
        // blocks 0..4608 (512 header + 4096 data) and entry two's header needs
        // 4608..5120, so a cut at 4900 leaves that header incomplete. Only
        // headers are read here, so the cut has to land inside one to stop the
        // walk. This is the same `Err` branch a `.tar.gz` reaches when it hits
        // the inflate bound, tested without depending on how well a given
        // payload happens to compress.
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
        // Nothing was read, so there is nothing honest to show — the caller
        // degrades to the binary placeholder rather than an empty listing that
        // would read as "this archive is empty".
        let path = temp_path("headless.tar");
        std::fs::write(&path, [0_u8; 100]).expect("write partial header");

        let result = read_archive_listing(&path.to_string_lossy(), ArchiveFormat::Tar);

        assert!(result.is_err(), "a header-less stream must not list");
        let _ = std::fs::remove_file(&path);
    }
}
