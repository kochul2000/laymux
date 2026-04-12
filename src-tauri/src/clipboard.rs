use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[cfg(target_os = "windows")]
use crate::path_utils::windows_to_wsl_path;

/// Result of a smart paste operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartPasteResult {
    /// "path" if a file/image path was resolved, "none" if no special content.
    pub paste_type: String,
    /// The path string (Windows or WSL format depending on profile), empty if paste_type is "none".
    pub content: String,
}

/// Image file extensions (case-insensitive match).
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico", "tiff", "tif",
];

/// Check if a file path has an image extension.
pub fn is_image_file(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| IMAGE_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Check if a terminal profile uses WSL.
pub fn is_wsl_profile(profile: &str) -> bool {
    let lower = profile.to_lowercase();
    lower.contains("wsl")
        || lower.contains("ubuntu")
        || lower.contains("debian")
        || lower.contains("linux")
}

/// Get the default paste image directory.
pub fn default_paste_image_dir() -> PathBuf {
    let base = dirs_config_path().unwrap_or_else(|| PathBuf::from("."));
    base.join("paste-images")
}

/// Resolve the paste image directory from settings value.
/// Empty string means use default.
pub fn resolve_paste_image_dir(configured: &str) -> PathBuf {
    if configured.is_empty() {
        default_paste_image_dir()
    } else {
        PathBuf::from(configured)
    }
}

/// Clean up paste images older than max_age_days.
pub fn cleanup_old_paste_images(dir: &Path, max_age_days: u64) -> Result<u32, String> {
    if !dir.exists() {
        return Ok(0);
    }
    let max_age = std::time::Duration::from_secs(max_age_days * 24 * 60 * 60);
    let now = SystemTime::now();
    let mut removed = 0u32;

    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read dir: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("png") {
            continue;
        }
        if let Ok(metadata) = entry.metadata() {
            if let Ok(modified) = metadata.modified() {
                if let Ok(age) = now.duration_since(modified) {
                    if age > max_age {
                        let _ = fs::remove_file(&path);
                        removed += 1;
                    }
                }
            }
        }
    }
    Ok(removed)
}

/// Save RGBA image data as PNG to the given directory.
/// Returns the full path of the saved file.
pub fn save_rgba_as_png(
    dir: &Path,
    width: u32,
    height: u32,
    rgba_data: &[u8],
) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create dir: {e}"))?;

    let timestamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let filename = format!("paste_{timestamp}.png");
    let path = dir.join(&filename);

    let file = fs::File::create(&path).map_err(|e| format!("Failed to create file: {e}"))?;
    let buf_writer = std::io::BufWriter::new(file);
    let mut encoder = png::Encoder::new(buf_writer, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|e| format!("PNG header error: {e}"))?;
    writer
        .write_image_data(rgba_data)
        .map_err(|e| format!("PNG write error: {e}"))?;

    Ok(path)
}

/// Perform smart paste: check clipboard for files or images.
/// Returns the resolved path or "none" if clipboard has only text.
pub fn smart_paste(image_dir: &str, profile: &str) -> Result<SmartPasteResult, String> {
    smart_paste_platform(image_dir, profile)
}

fn dirs_config_path() -> Option<PathBuf> {
    crate::settings::dirs_config_path()
}

// -- Platform-specific implementation --

#[cfg(target_os = "windows")]
fn smart_paste_platform(image_dir: &str, profile: &str) -> Result<SmartPasteResult, String> {
    use clipboard_win::{formats, get_clipboard};

    // 1. Check for file paths (CF_HDROP)
    if let Ok(files) = get_clipboard::<Vec<String>, _>(formats::FileList) {
        if let Some(first) = files.first() {
            let path = if is_wsl_profile(profile) {
                windows_to_wsl_path(first)
            } else {
                first.clone()
            };
            return Ok(SmartPasteResult {
                paste_type: "path".into(),
                content: path,
            });
        }
    }

    // 2. Check for bitmap image (CF_DIB)
    if let Ok(dib_data) = get_clipboard::<Vec<u8>, _>(formats::Bitmap) {
        if dib_data.len() > 40 {
            // Parse DIB header to get dimensions and pixel data
            if let Some((width, height, rgba)) = parse_dib_to_rgba(&dib_data) {
                let dir = resolve_paste_image_dir(image_dir);
                let saved_path = save_rgba_as_png(&dir, width, height, &rgba)?;
                let path_str = saved_path.to_string_lossy().to_string();
                let content = if is_wsl_profile(profile) {
                    windows_to_wsl_path(&path_str)
                } else {
                    path_str
                };
                return Ok(SmartPasteResult {
                    paste_type: "path".into(),
                    content,
                });
            }
        }
    }

    // 3. Read clipboard text as fallback
    if let Ok(text) = get_clipboard::<String, _>(formats::Unicode) {
        if !text.is_empty() {
            return Ok(SmartPasteResult {
                paste_type: "text".into(),
                content: text,
            });
        }
    }

    // 4. Nothing in clipboard
    Ok(SmartPasteResult {
        paste_type: "none".into(),
        content: String::new(),
    })
}

#[cfg(not(target_os = "windows"))]
fn smart_paste_platform(_image_dir: &str, _profile: &str) -> Result<SmartPasteResult, String> {
    // Linux: not yet implemented (WSL runs within Windows host)
    Ok(SmartPasteResult {
        paste_type: "none".into(),
        content: String::new(),
    })
}

/// Parse CF_DIB or BMP data into RGBA bytes.
/// clipboard-win's formats::Bitmap returns data with a 14-byte BMP file header ("BM"...).
#[cfg(target_os = "windows")]
fn parse_dib_to_rgba(data: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    if data.len() < 40 {
        return None;
    }

    // Skip BMP file header if present (clipboard-win prepends it)
    let dib = if data.len() >= 14 && data[0] == b'B' && data[1] == b'M' {
        &data[14..]
    } else {
        data
    };

    if dib.len() < 40 {
        return None;
    }

    // BITMAPINFOHEADER fields
    let header_size = u32::from_le_bytes([dib[0], dib[1], dib[2], dib[3]]) as usize;
    let width = i32::from_le_bytes([dib[4], dib[5], dib[6], dib[7]]);
    let height = i32::from_le_bytes([dib[8], dib[9], dib[10], dib[11]]);
    let bit_count = u16::from_le_bytes([dib[14], dib[15]]);
    let compression = u32::from_le_bytes([dib[16], dib[17], dib[18], dib[19]]);

    if width <= 0 {
        return None;
    }
    let abs_height = height.unsigned_abs();
    let top_down = height < 0;

    // We support 32-bit (BGRA) and 24-bit (BGR) uncompressed bitmaps
    // compression 0 = BI_RGB, 3 = BI_BITFIELDS
    if compression != 0 && compression != 3 {
        return None;
    }
    if bit_count != 24 && bit_count != 32 {
        return None;
    }

    let w = width as u32;
    let h = abs_height;
    let bytes_per_pixel = (bit_count / 8) as usize;
    let row_stride = (w as usize * bytes_per_pixel).div_ceil(4) * 4; // 4-byte aligned

    // Pixel data starts after the header (and optional color masks for BI_BITFIELDS)
    let pixel_offset = if compression == 3 && header_size <= 40 {
        header_size + 12 // 3 DWORD color masks
    } else {
        header_size
    };

    let expected_size = pixel_offset + row_stride * h as usize;
    if dib.len() < expected_size {
        return None;
    }

    let mut rgba = vec![0u8; (w * h * 4) as usize];

    for y in 0..h {
        let src_y = if top_down { y } else { h - 1 - y };
        let src_offset = pixel_offset + src_y as usize * row_stride;
        let dst_offset = y as usize * w as usize * 4;

        for x in 0..w as usize {
            let src_px = src_offset + x * bytes_per_pixel;
            let dst_px = dst_offset + x * 4;

            let b = dib[src_px];
            let g = dib[src_px + 1];
            let r = dib[src_px + 2];
            let a = if bit_count == 32 {
                dib[src_px + 3]
            } else {
                255
            };

            rgba[dst_px] = r;
            rgba[dst_px + 1] = g;
            rgba[dst_px + 2] = b;
            // If 32-bit but alpha is all zeros, treat as fully opaque
            rgba[dst_px + 3] = if a == 0 && bit_count == 32 { 255 } else { a };
        }
    }

    Some((w, h, rgba))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path_utils::windows_to_wsl_path;

    #[test]
    fn test_is_image_file() {
        assert!(is_image_file("photo.png"));
        assert!(is_image_file("photo.PNG"));
        assert!(is_image_file("photo.jpg"));
        assert!(is_image_file("photo.JPEG"));
        assert!(is_image_file("photo.gif"));
        assert!(is_image_file("photo.bmp"));
        assert!(is_image_file("photo.webp"));
        assert!(is_image_file("photo.svg"));
        assert!(!is_image_file("document.txt"));
        assert!(!is_image_file("script.py"));
        assert!(!is_image_file("no_extension"));
        assert!(!is_image_file(""));
    }

    #[test]
    fn test_is_wsl_profile() {
        assert!(is_wsl_profile("WSL"));
        assert!(is_wsl_profile("wsl"));
        assert!(is_wsl_profile("Ubuntu"));
        assert!(is_wsl_profile("Debian"));
        assert!(is_wsl_profile("WSL - Ubuntu"));
        assert!(!is_wsl_profile("PowerShell"));
        assert!(!is_wsl_profile("PowerShell"));
        assert!(!is_wsl_profile("Git Bash"));
    }

    #[test]
    fn test_windows_to_wsl_path() {
        assert_eq!(
            windows_to_wsl_path(r"C:\Users\foo\bar.png"),
            "/mnt/c/Users/foo/bar.png"
        );
        assert_eq!(
            windows_to_wsl_path(r"D:\Projects\test"),
            "/mnt/d/Projects/test"
        );
        assert_eq!(
            windows_to_wsl_path(r"c:\lowercase\drive"),
            "/mnt/c/lowercase/drive"
        );
        // Already a unix path
        assert_eq!(
            windows_to_wsl_path("/mnt/c/already/unix"),
            "/mnt/c/already/unix"
        );
        // UNC or relative path — just replace backslashes
        assert_eq!(windows_to_wsl_path(r"relative\path"), "relative/path");
    }

    #[test]
    fn test_resolve_paste_image_dir_default() {
        let dir = resolve_paste_image_dir("");
        assert!(dir.to_string_lossy().contains("paste-images"));
    }

    #[test]
    fn test_resolve_paste_image_dir_custom() {
        let dir = resolve_paste_image_dir(r"C:\my\custom\dir");
        assert_eq!(dir, PathBuf::from(r"C:\my\custom\dir"));
    }

    #[test]
    fn test_save_rgba_as_png() {
        let dir = tempfile::tempdir().unwrap();
        // 2x2 red image (RGBA)
        let rgba = vec![
            255, 0, 0, 255, 0, 255, 0, 255, // row 1: red, green
            0, 0, 255, 255, 255, 255, 255, 255, // row 2: blue, white
        ];
        let path = save_rgba_as_png(dir.path(), 2, 2, &rgba).unwrap();
        assert!(path.exists());
        assert_eq!(path.extension().unwrap(), "png");
        // Verify file is not empty
        let size = fs::metadata(&path).unwrap().len();
        assert!(size > 0);
    }

    #[test]
    fn test_cleanup_old_paste_images() {
        let dir = tempfile::tempdir().unwrap();
        // Create a test PNG file
        let file_path = dir.path().join("test.png");
        fs::write(&file_path, b"fake png").unwrap();
        // With max_age_days=0 and a recently created file, it should NOT be removed
        // (age < 0 days is impossible, but the file was just created so age < 1 day)
        let removed = cleanup_old_paste_images(dir.path(), 1).unwrap();
        assert_eq!(removed, 0);
        assert!(file_path.exists());
    }

    #[test]
    fn test_cleanup_skips_non_png() {
        let dir = tempfile::tempdir().unwrap();
        let txt_path = dir.path().join("notes.txt");
        fs::write(&txt_path, b"hello").unwrap();
        let removed = cleanup_old_paste_images(dir.path(), 0).unwrap();
        assert_eq!(removed, 0);
        assert!(txt_path.exists());
    }

    #[test]
    fn test_cleanup_nonexistent_dir() {
        let result = cleanup_old_paste_images(Path::new("/nonexistent/dir"), 7);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 0);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_parse_dib_to_rgba_32bit() {
        // Construct a minimal 2x1 32-bit BGRA DIB
        let mut dib = vec![0u8; 40 + 8]; // header + 2 pixels
                                         // BITMAPINFOHEADER
        dib[0..4].copy_from_slice(&40u32.to_le_bytes()); // biSize
        dib[4..8].copy_from_slice(&2i32.to_le_bytes()); // biWidth
        dib[8..12].copy_from_slice(&1i32.to_le_bytes()); // biHeight (bottom-up)
        dib[12..14].copy_from_slice(&1u16.to_le_bytes()); // biPlanes
        dib[14..16].copy_from_slice(&32u16.to_le_bytes()); // biBitCount
        dib[16..20].copy_from_slice(&0u32.to_le_bytes()); // biCompression = BI_RGB
                                                          // Pixel data (BGRA): blue pixel, then red pixel
        dib[40] = 255;
        dib[41] = 0;
        dib[42] = 0;
        dib[43] = 255; // B=255 G=0 R=0 A=255
        dib[44] = 0;
        dib[45] = 0;
        dib[46] = 255;
        dib[47] = 255; // B=0 G=0 R=255 A=255

        let (w, h, rgba) = parse_dib_to_rgba(&dib).unwrap();
        assert_eq!(w, 2);
        assert_eq!(h, 1);
        // BGRA → RGBA: first pixel should be R=0,G=0,B=255,A=255
        assert_eq!(&rgba[0..4], &[0, 0, 255, 255]);
        // Second pixel: R=255,G=0,B=0,A=255
        assert_eq!(&rgba[4..8], &[255, 0, 0, 255]);
    }
}
