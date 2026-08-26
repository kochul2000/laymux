//! Archive listing for the built-in file viewer (ADR-0109).
//!
//! Listing means metadata only: zip is read from its central directory and tar
//! from its 512-byte headers. Nothing is extracted, so a listing costs the same
//! whether the archive holds one file or a gigabyte of them. `.tar.gz` is the
//! one exception — the gzip layer has to be inflated to reach the headers at
//! all — and that path is bounded so a crafted stream cannot inflate forever.

use crate::constants::{MAX_ARCHIVE_ENTRIES, MAX_ARCHIVE_INFLATE_BYTES};
use std::io::{Cursor, Read, Seek};

mod bounded_zip;

use bounded_zip::read_bounded_zip_listing;

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
        ArchiveFormat::Zip => {
            let file =
                std::fs::File::open(path).map_err(|e| format!("Cannot open archive: {e}"))?;
            read_zip_listing(file, None)
        }
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

/// Enumerate an archive for a transport-bound viewer. The compressed source is
/// read at most `max_source_bytes + 1`, gzip expansion is independently capped,
/// and ZIP central-directory traversal is rejected above the visible entry
/// budget. The unbounded desktop viewer keeps the legacy whole-archive totals.
pub fn read_archive_listing_bounded(
    path: &str,
    format: ArchiveFormat,
    max_source_bytes: usize,
    max_inflate_bytes: u64,
) -> Result<ArchiveListing, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Cannot open archive: {e}"))?;
    let read_limit = max_source_bytes.saturating_add(1);
    let mut bytes = Vec::with_capacity(read_limit.min(64 * 1024));
    file.take(read_limit as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Cannot read archive: {e}"))?;
    if bytes.len() > max_source_bytes {
        return Err(format!(
            "File exceeds the {max_source_bytes} byte viewer limit"
        ));
    }

    match format {
        ArchiveFormat::Zip => read_bounded_zip_listing(&bytes, MAX_ARCHIVE_ENTRIES),
        ArchiveFormat::Tar => read_tar_listing(Cursor::new(bytes), ArchiveFormat::Tar),
        ArchiveFormat::TarGz => {
            let decoder = flate2::read::GzDecoder::new(Cursor::new(bytes));
            read_tar_listing(decoder.take(max_inflate_bytes), ArchiveFormat::TarGz)
        }
    }
}

fn read_zip_listing<R: Read + Seek>(
    reader: R,
    max_scanned_entries: Option<usize>,
) -> Result<ArchiveListing, String> {
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("Cannot read zip archive: {e}"))?;

    let total_entries = archive.len();
    if let Some(limit) = max_scanned_entries {
        if total_entries > limit {
            return Err(format!(
                "Archive entry count exceeds the {limit} entry viewer limit"
            ));
        }
    }
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
mod tests;
