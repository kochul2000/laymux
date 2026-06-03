use crate::path_utils;

/// Content type classification for file viewer.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum FileViewerContent {
    /// Text file — content included inline.
    Text { content: String, truncated: bool },
    /// Image file — inline data URL (base64).
    Image {
        #[serde(rename = "dataUrl")]
        data_url: String,
    },
    /// Binary/unsupported — show info only.
    Binary { size: u64 },
}

pub(crate) const IMAGE_EXTENSIONS: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico", ".avif",
];

const TEXT_EXTENSIONS: &[&str] = &[
    ".txt",
    ".md",
    ".json",
    ".jsonc",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".rs",
    ".py",
    ".go",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".toml",
    ".yaml",
    ".yml",
    ".xml",
    ".html",
    ".css",
    ".scss",
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".bat",
    ".ps1",
    ".log",
    ".env",
    ".gitignore",
    ".editorconfig",
    ".conf",
    ".cfg",
    ".ini",
    ".csv",
];

/// Read a file and classify it for the file viewer.
#[tauri::command]
pub fn read_file_for_viewer(
    path: String,
    max_bytes: Option<usize>,
) -> Result<FileViewerContent, String> {
    // Resolve WSL/Windows paths with the shared inference rule (#282).
    let resolved = path_utils::resolve_address_path(&path, None);
    let file_path = std::path::Path::new(&resolved);
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()))
        .unwrap_or_default();

    if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        // Read image and return as data URL (convertFileSrc can't handle WSL UNC paths)
        let bytes = std::fs::read(&resolved).map_err(|e| format!("Cannot read image: {e}"))?;
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

    let metadata = std::fs::metadata(&resolved).map_err(|e| format!("Cannot stat file: {e}"))?;
    let size = metadata.len();
    let limit = max_bytes.unwrap_or(1_048_576) as u64; // 1MB default

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

/// Filesystem facts about a path, used by the File Explorer address bar (#278)
/// to decide whether a typed/pasted path should navigate (directory) or open a
/// file (navigate to parent + open in the shared viewer).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
    pub exists: bool,
    pub is_directory: bool,
}

/// Resolve an address-bar path (handling WSL/Windows translation the same way as
/// `list_directory`) and report whether it exists and is a directory.
///
/// Never errors on a missing path — a non-existent path simply returns
/// `{ exists: false, is_directory: false }` so the frontend can show feedback
/// without treating "not found" as a hard error.
#[tauri::command]
pub fn stat_path(path: String, wsl_distro: Option<String>) -> PathInfo {
    let resolved = path_utils::resolve_address_path(&path, wsl_distro.as_deref());
    match std::fs::metadata(&resolved) {
        Ok(meta) => PathInfo {
            exists: true,
            is_directory: meta.is_dir(),
        },
        Err(_) => PathInfo {
            exists: false,
            is_directory: false,
        },
    }
}

/// Resolve the current user's home directory as a path string.
///
/// Used by the File Explorer as a fallback CWD when no syncGroup CWD or
/// restored `lastCwd` is available, so the explorer is never stuck showing
/// "..." with an empty listing.
pub fn home_directory() -> Option<String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|s| !s.is_empty())
}

/// Return the current user's home directory path.
#[tauri::command]
pub fn get_home_directory() -> Result<String, String> {
    home_directory().ok_or_else(|| "Could not determine home directory".to_string())
}

/// A single directory entry returned by `list_directory`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub is_executable: bool,
    pub size: u64,
}

/// List directory contents and return structured metadata for each entry.
#[tauri::command]
pub fn list_directory(path: String, wsl_distro: Option<String>) -> Result<Vec<DirEntry>, String> {
    // Resolve WSL/Windows paths with the shared inference rule (#282).
    let resolved = path_utils::resolve_address_path(&path, wsl_distro.as_deref());
    let dir_path = std::path::Path::new(&resolved);
    let entries = std::fs::read_dir(dir_path).map_err(|e| format!("Cannot read directory: {e}"))?;

    let mut result = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // skip unreadable entries
        };
        let name = entry.file_name().to_string_lossy().into_owned();

        // Use symlink_metadata to detect symlinks (metadata follows symlinks)
        let sym_meta = entry.path().symlink_metadata();
        let is_symlink = sym_meta.as_ref().map(|m| m.is_symlink()).unwrap_or(false);

        // Follow symlinks for the actual file type and size
        let meta = entry.path().metadata();
        let is_directory = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);

        // Check executable bit (Unix only)
        #[cfg(unix)]
        let is_executable = {
            use std::os::unix::fs::PermissionsExt;
            meta.as_ref()
                .map(|m| !m.is_dir() && (m.permissions().mode() & 0o111) != 0)
                .unwrap_or(false)
        };
        #[cfg(not(unix))]
        let is_executable = {
            // On Windows, check common executable extensions
            let ext = entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_lowercase())
                .unwrap_or_default();
            !is_directory && matches!(ext.as_str(), "exe" | "cmd" | "bat" | "ps1" | "com")
        };

        result.push(DirEntry {
            name,
            is_directory,
            is_symlink,
            is_executable,
            size,
        });
    }

    // Sort: directories first, then alphabetically (case-insensitive)
    result.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

/// Simple base64 encoder (no external crate needed).
pub(crate) fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let combined = (b0 << 16) | (b1 << 8) | b2;
        result.push(TABLE[((combined >> 18) & 0x3F) as usize] as char);
        result.push(TABLE[((combined >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(TABLE[((combined >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(TABLE[(combined & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

#[tauri::command]
pub fn open_settings_file() -> Result<(), String> {
    let path = crate::settings::settings_path();
    #[cfg(target_os = "windows")]
    {
        crate::process::headless_command("cmd")
            .args(["/C", "start", "", &path.to_string_lossy()])
            .spawn()
            .map_err(|e| format!("Failed to open settings.json: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open settings.json: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_encode_empty() {
        assert_eq!(base64_encode(b""), "");
    }

    #[test]
    fn base64_encode_hello() {
        assert_eq!(base64_encode(b"Hello"), "SGVsbG8=");
    }

    #[test]
    fn home_directory_resolves_to_existing_path() {
        // The home directory must resolve to a non-empty, existing path so the
        // File Explorer always has a valid fallback CWD (issue #274).
        let home = home_directory().expect("home directory should resolve in test env");
        assert!(!home.is_empty());
        assert!(
            std::path::Path::new(&home).exists(),
            "resolved home dir should exist: {home}"
        );
    }

    #[test]
    fn stat_path_reports_directory() {
        let dir = std::env::temp_dir();
        let info = stat_path(dir.to_string_lossy().into_owned(), None);
        assert!(info.exists, "temp dir should exist");
        assert!(info.is_directory, "temp dir should be a directory");
    }

    #[test]
    fn stat_path_reports_file() {
        let mut file = std::env::temp_dir();
        file.push(format!("laymux_stat_path_test_{}.txt", std::process::id()));
        std::fs::write(&file, b"hi").expect("write temp file");
        let info = stat_path(file.to_string_lossy().into_owned(), None);
        assert!(info.exists, "temp file should exist");
        assert!(!info.is_directory, "temp file should not be a directory");
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn stat_path_missing_is_not_an_error() {
        let mut missing = std::env::temp_dir();
        missing.push("laymux_stat_path_definitely_missing_xyz_123");
        let info = stat_path(missing.to_string_lossy().into_owned(), None);
        assert!(!info.exists, "missing path should report exists=false");
        assert!(!info.is_directory);
    }

    #[test]
    fn base64_encode_roundtrip() {
        let original = b"screenshot data \x00\xff\x80";
        let encoded = base64_encode(original);
        let decoded = crate::automation_server::base64_decode(&encoded).unwrap();
        assert_eq!(decoded, original);
    }
}
