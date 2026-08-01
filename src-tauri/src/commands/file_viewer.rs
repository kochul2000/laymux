//! Content classification for the built-in file viewer (ADR-0109).
//!
//! This module owns the `kind` axis of the viewer: what a file *is*, decided
//! from bytes. The `previewKind` axis — whether a text file is JSON, CSV, a
//! diff and so on — belongs to the frontend and is decided from the path, so it
//! deliberately has no counterpart here.

use crate::commands::archive_listing::{archive_format, read_archive_listing, ArchiveEntry};
use crate::commands::file_ops::base64_encode;
use crate::constants::{DEFAULT_FILE_VIEWER_BYTES, MAX_INLINE_PDF_BYTES};
use crate::path_utils;

/// Content type classification for file viewer.
///
/// `rename_all` on an enum renames the *variants*; struct-variant fields need
/// `rename_all_fields`. Without it `total_entries` reached the frontend under
/// its snake_case name and read as `undefined`, crashing the archive renderer.
/// The key names are pinned by a test below because the TypeScript mirror in
/// `ui/src/lib/tauri-api.ts` is maintained by hand.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum FileViewerContent {
    /// Text file — content included inline.
    Text { content: String, truncated: bool },
    /// Image file — inline data URL (base64).
    Image { data_url: String },
    /// PDF — inline data URL handed to the host WebView's own PDF viewer.
    Pdf { data_url: String },
    /// Archive — entry metadata only; nothing is extracted.
    Archive {
        /// `"zip" | "tar" | "tar.gz"`.
        format: String,
        entries: Vec<ArchiveEntry>,
        total_entries: usize,
        truncated: bool,
    },
    /// Binary/unsupported — show info only.
    Binary { size: u64 },
}

pub(crate) const IMAGE_EXTENSIONS: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico", ".avif",
];

/// Extensions read as text regardless of size.
///
/// This is a classification gate, not a display hint: an extension missing here
/// is reported as `Binary` the moment the file crosses the byte limit, and the
/// frontend's preview renderers never see it. So every extension a preview
/// renderer claims has to appear in this list too.
const TEXT_EXTENSIONS: &[&str] = &[
    // Plain text and docs
    ".txt",
    ".md",
    ".markdown",
    ".rst",
    ".adoc",
    ".asciidoc",
    ".tex",
    ".bib",
    ".log",
    ".srt",
    ".vtt",
    // Structured data
    ".json",
    ".jsonc",
    ".json5",
    ".jsonl",
    ".ndjson",
    ".toml",
    ".yaml",
    ".yml",
    ".xml",
    ".plist",
    ".csv",
    ".tsv",
    ".tab",
    ".ron",
    // Patches
    ".diff",
    ".patch",
    // Web
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".styl",
    ".vue",
    ".svelte",
    ".astro",
    ".pug",
    ".hbs",
    ".ejs",
    // JS/TS
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    // Systems
    ".rs",
    ".go",
    ".c",
    ".h",
    ".cc",
    ".cpp",
    ".cxx",
    ".hpp",
    ".hh",
    ".hxx",
    ".zig",
    ".nim",
    ".d",
    ".asm",
    ".s",
    // Managed / scripting
    ".py",
    ".pyi",
    ".rb",
    ".php",
    ".java",
    ".kt",
    ".kts",
    ".scala",
    ".groovy",
    ".cs",
    ".fs",
    ".vb",
    ".swift",
    ".m",
    ".mm",
    ".dart",
    ".lua",
    ".pl",
    ".pm",
    ".r",
    ".jl",
    ".ex",
    ".exs",
    ".erl",
    ".hrl",
    ".hs",
    ".ml",
    ".mli",
    ".clj",
    ".cljs",
    ".edn",
    ".scm",
    ".lisp",
    ".el",
    ".tcl",
    ".vim",
    // Shells
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".nu",
    ".bat",
    ".cmd",
    ".ps1",
    ".psm1",
    ".psd1",
    ".awk",
    // Query / schema / IDL
    ".sql",
    ".graphql",
    ".gql",
    ".proto",
    ".thrift",
    ".avsc",
    // Build and infra
    ".mk",
    ".cmake",
    ".gradle",
    ".sbt",
    ".bazel",
    ".bzl",
    ".just",
    ".tf",
    ".tfvars",
    ".hcl",
    ".jsonnet",
    ".dockerfile",
    ".containerfile",
    // Config and dotfiles
    ".env",
    ".ini",
    ".cfg",
    ".conf",
    ".properties",
    ".lock",
    ".gitignore",
    ".gitattributes",
    ".gitmodules",
    ".editorconfig",
    ".npmrc",
    ".nvmrc",
    ".prettierrc",
    ".eslintrc",
    ".babelrc",
];

/// Read a file and classify it for the file viewer.
#[tauri::command]
pub fn read_file_for_viewer(
    path: String,
    max_bytes: Option<usize>,
) -> Result<FileViewerContent, String> {
    // Resolve WSL/Windows paths with the shared inference rule (#282), following
    // WSL symlinks so a linked file actually opens (#363).
    let resolved = path_utils::resolve_address_path_following_symlinks(&path, None);
    let file_path = std::path::Path::new(&resolved);
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()))
        .unwrap_or_default();
    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();

    // Archives are classified from the whole file name because `.tar.gz` is a
    // pair, not an extension.
    if let Some(format) = archive_format(file_name) {
        // A file that merely ends in `.zip` may not be one. Listing failure is
        // not viewer failure: fall through to the binary placeholder so the
        // user still sees the size and can open it in the host app.
        if let Ok(listing) = read_archive_listing(&resolved, format) {
            return Ok(FileViewerContent::Archive {
                format: listing.format.as_str().to_string(),
                entries: listing.entries,
                total_entries: listing.total_entries,
                truncated: listing.truncated,
            });
        }
    }

    if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        let bytes = read_bounded_binary(&resolved, max_bytes, "image")?;
        let mime = match ext.as_str() {
            ".png" => "image/png",
            ".jpg" | ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".svg" => "image/svg+xml",
            ".webp" => "image/webp",
            ".bmp" => "image/bmp",
            ".ico" => "image/x-icon",
            ".avif" => "image/avif",
            _ => "application/octet-stream",
        };
        let b64 = base64_encode(&bytes);
        return Ok(FileViewerContent::Image {
            data_url: format!("data:{mime};base64,{b64}"),
        });
    }

    if ext == ".pdf" {
        // Remote asks for a hard byte bound and needs an error it can map to
        // 413. The desktop has no transport limit but still refuses to inline a
        // huge PDF, and degrades to the binary card's "open externally" path
        // instead of erroring.
        if max_bytes.is_none() {
            let size = std::fs::metadata(&resolved)
                .map_err(|e| format!("Cannot stat file: {e}"))?
                .len();
            if size > MAX_INLINE_PDF_BYTES {
                return Ok(FileViewerContent::Binary { size });
            }
        }
        let bytes = read_bounded_binary(&resolved, max_bytes, "PDF")?;
        let b64 = base64_encode(&bytes);
        return Ok(FileViewerContent::Pdf {
            data_url: format!("data:application/pdf;base64,{b64}"),
        });
    }

    let metadata = std::fs::metadata(&resolved).map_err(|e| format!("Cannot stat file: {e}"))?;
    let size = metadata.len();
    let limit = max_bytes.unwrap_or(DEFAULT_FILE_VIEWER_BYTES) as u64;

    // Treat known text extensions or small files as text
    let is_text_ext = TEXT_EXTENSIONS.contains(&ext.as_str()) || ext.is_empty();
    if !is_text_ext && size > limit {
        return Ok(FileViewerContent::Binary { size });
    }

    // Read only up to limit bytes (avoid loading entire large files into memory)
    let read_limit = std::cmp::min(size, limit) as usize;
    let truncated = size > limit;
    let mut buf = vec![0u8; read_limit];
    {
        use std::io::Read;
        let mut f = std::fs::File::open(&resolved).map_err(|e| format!("Cannot open file: {e}"))?;
        f.read_exact(&mut buf)
            .map_err(|e| format!("Cannot read file: {e}"))?;
    }

    match std::str::from_utf8(&buf) {
        Ok(text) => Ok(FileViewerContent::Text {
            content: text.to_string(),
            truncated,
        }),
        Err(_) if is_text_ext => {
            // Lossy conversion for known text extensions
            Ok(FileViewerContent::Text {
                content: String::from_utf8_lossy(&buf).into_owned(),
                truncated,
            })
        }
        Err(_) => Ok(FileViewerContent::Binary { size }),
    }
}

/// Read a whole file that will be inlined as a base64 data URL.
///
/// A metadata-only check has a TOCTOU gap: the file can grow between stat and
/// read. Bound the read itself when a remote caller supplies a limit, keeping
/// the desktop's existing unbounded behavior otherwise (`convertFileSrc` cannot
/// handle WSL UNC paths, so inlining is the only option there).
fn read_bounded_binary(
    resolved: &str,
    max_bytes: Option<usize>,
    label: &str,
) -> Result<Vec<u8>, String> {
    let Some(limit) = max_bytes else {
        return std::fs::read(resolved).map_err(|e| format!("Cannot read {label}: {e}"));
    };
    use std::io::Read;
    let file = std::fs::File::open(resolved).map_err(|e| format!("Cannot open {label}: {e}"))?;
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Cannot read {label}: {e}"))?;
    if bytes.len() > limit {
        return Err(format!("File exceeds the {limit} byte viewer limit"));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("laymux_file_viewer_{}_{name}", std::process::id()));
        path
    }

    /// The TypeScript `FileViewerContent` union is written by hand, so a field
    /// renamed on one side and not the other only shows up at runtime — as an
    /// `undefined` read, which is how `total_entries` once crashed the archive
    /// renderer. Pin every wire key here.
    #[test]
    fn every_variant_serializes_with_the_key_names_the_frontend_reads() {
        let cases = [
            (
                FileViewerContent::Text {
                    content: "x".into(),
                    truncated: false,
                },
                vec!["kind", "content", "truncated"],
                "text",
            ),
            (
                FileViewerContent::Image {
                    data_url: "data:image/png;base64,".into(),
                },
                vec!["kind", "dataUrl"],
                "image",
            ),
            (
                FileViewerContent::Pdf {
                    data_url: "data:application/pdf;base64,".into(),
                },
                vec!["kind", "dataUrl"],
                "pdf",
            ),
            (
                FileViewerContent::Archive {
                    format: "zip".into(),
                    entries: vec![ArchiveEntry {
                        name: "a.txt".into(),
                        size: 1,
                        compressed_size: 1,
                        is_directory: false,
                    }],
                    total_entries: 1,
                    truncated: false,
                },
                vec!["kind", "format", "entries", "totalEntries", "truncated"],
                "archive",
            ),
            (
                FileViewerContent::Binary { size: 1 },
                vec!["kind", "size"],
                "binary",
            ),
        ];

        for (content, expected_keys, expected_kind) in cases {
            let value = serde_json::to_value(&content).expect("serialize");
            let object = value.as_object().expect("variant serializes as an object");
            let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
            let mut expected = expected_keys;
            keys.sort_unstable();
            expected.sort_unstable();
            assert_eq!(keys, expected, "wire keys drifted for {expected_kind}");
            assert_eq!(object["kind"], expected_kind);
        }

        let entry = serde_json::to_value(ArchiveEntry {
            name: "a.txt".into(),
            size: 2,
            compressed_size: 1,
            is_directory: true,
        })
        .expect("serialize entry");
        let mut entry_keys: Vec<&str> = entry
            .as_object()
            .expect("entry object")
            .keys()
            .map(String::as_str)
            .collect();
        entry_keys.sort_unstable();
        assert_eq!(
            entry_keys,
            vec!["compressedSize", "isDirectory", "name", "size"]
        );
    }

    #[test]
    fn read_file_for_viewer_rejects_an_image_over_the_requested_limit() {
        let file = temp_path("limit.png");
        std::fs::write(&file, [0_u8; 32]).expect("write temp image");

        let result = read_file_for_viewer(file.to_string_lossy().into_owned(), Some(16));

        assert_eq!(
            result.expect_err("oversized image must be rejected"),
            "File exceeds the 16 byte viewer limit"
        );
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn read_file_for_viewer_accepts_an_image_at_the_requested_limit() {
        let file = temp_path("exact_limit.png");
        std::fs::write(&file, [0_u8; 16]).expect("write temp image");

        let result = read_file_for_viewer(file.to_string_lossy().into_owned(), Some(16));

        assert!(matches!(result, Ok(FileViewerContent::Image { .. })));
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn a_pdf_is_inlined_as_an_application_pdf_data_url() {
        let file = temp_path("doc.pdf");
        std::fs::write(&file, b"%PDF-1.7 minimal").expect("write temp pdf");

        let result = read_file_for_viewer(file.to_string_lossy().into_owned(), None);

        match result.expect("pdf must classify") {
            FileViewerContent::Pdf { data_url } => {
                assert!(
                    data_url.starts_with("data:application/pdf;base64,"),
                    "unexpected data url prefix: {data_url}"
                );
            }
            other => panic!("expected Pdf, got {other:?}"),
        }
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn a_remote_pdf_over_the_requested_limit_reports_the_viewer_limit() {
        let file = temp_path("remote_limit.pdf");
        std::fs::write(&file, [0_u8; 64]).expect("write temp pdf");

        // Remote must get an error string the route can map to 413, not a
        // silent downgrade to the binary placeholder.
        let result = read_file_for_viewer(file.to_string_lossy().into_owned(), Some(16));

        assert_eq!(
            result.expect_err("oversized remote pdf must be rejected"),
            "File exceeds the 16 byte viewer limit"
        );
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn a_zip_classifies_as_an_archive_listing() {
        let path = temp_path("bundle.zip");
        let file = std::fs::File::create(&path).expect("create zip");
        let mut writer = zip::ZipWriter::new(file);
        let options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        writer.start_file("inner.txt", options).expect("start file");
        writer.write_all(b"hello").expect("write body");
        writer.finish().expect("finish zip");

        let result = read_file_for_viewer(path.to_string_lossy().into_owned(), None);

        match result.expect("zip must classify") {
            FileViewerContent::Archive {
                format,
                entries,
                total_entries,
                truncated,
            } => {
                assert_eq!(format, "zip");
                assert_eq!(total_entries, 1);
                assert!(!truncated);
                assert_eq!(entries[0].name, "inner.txt");
                assert_eq!(entries[0].size, 5);
            }
            other => panic!("expected Archive, got {other:?}"),
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_file_that_only_looks_like_a_zip_falls_back_to_binary() {
        let path = temp_path("liar.zip");
        // Big enough to exceed the default limit so the text branch cannot
        // claim it either — this must land on the binary placeholder.
        std::fs::write(&path, vec![0_u8; DEFAULT_FILE_VIEWER_BYTES + 1]).expect("write fake zip");

        let result = read_file_for_viewer(path.to_string_lossy().into_owned(), None);

        assert!(
            matches!(result, Ok(FileViewerContent::Binary { .. })),
            "a corrupt archive must degrade, not error"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn newly_previewable_extensions_stay_text_past_the_size_limit() {
        // These extensions gained frontend renderers; if the gate forgets them,
        // a large file is reported as binary and the renderer never runs.
        for ext in [".jsonl", ".ndjson", ".diff", ".patch", ".tsv", ".rs", ".py"] {
            let path = temp_path(&format!("large{ext}"));
            std::fs::write(&path, vec![b'a'; DEFAULT_FILE_VIEWER_BYTES + 10])
                .expect("write large text file");

            let result = read_file_for_viewer(path.to_string_lossy().into_owned(), None);

            match result.expect("must classify") {
                FileViewerContent::Text { truncated, .. } => {
                    assert!(truncated, "{ext} over the limit must report truncation");
                }
                other => panic!("{ext} must stay text, got {other:?}"),
            }
            let _ = std::fs::remove_file(&path);
        }
    }
}
