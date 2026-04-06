//! Integration tests for smart paste using the actual Windows clipboard.
//! Run with: cargo test --test clipboard_integration -- --nocapture

#[cfg(target_os = "windows")]
mod windows_tests {
    use clipboard_win::{formats, get_clipboard, set_clipboard};
    use laymux_lib::clipboard::smart_paste;
    use serial_test::serial;
    use std::path::Path;

    #[test]
    #[serial]
    fn clipboard_read_text() {
        // 1. Put text on clipboard
        set_clipboard(formats::Unicode, "hello from test").unwrap();

        // 2. Read it back to verify clipboard-win works at all
        let text: String = get_clipboard(formats::Unicode).unwrap();
        assert_eq!(text, "hello from test");
        eprintln!("[PASS] clipboard-win can read/write text");
    }

    #[test]
    #[serial]
    fn smart_paste_with_text() {
        // 1. Put text on clipboard
        set_clipboard(formats::Unicode, "test paste text").unwrap();

        // 2. Call smart_paste
        let result = smart_paste("", "PowerShell").unwrap();
        eprintln!(
            "[INFO] smart_paste returned: type={}, content={}",
            result.paste_type, result.content
        );

        assert_eq!(result.paste_type, "text");
        assert_eq!(result.content, "test paste text");
        eprintln!("[PASS] smart_paste returns text correctly");
    }

    #[test]
    #[serial]
    fn smart_paste_with_text_wsl_profile() {
        set_clipboard(formats::Unicode, "wsl test").unwrap();

        let result = smart_paste("", "WSL").unwrap();
        eprintln!(
            "[INFO] smart_paste WSL returned: type={}, content={}",
            result.paste_type, result.content
        );

        // Text should be returned as-is (no path conversion for text)
        assert_eq!(result.paste_type, "text");
        assert_eq!(result.content, "wsl test");
        eprintln!("[PASS] smart_paste text with WSL profile works");
    }

    /// Diagnostic: print what's currently on the clipboard.
    /// Run after copying from Paint: cargo test --test clipboard_integration diagnostic -- --nocapture --test-threads=1
    #[test]
    #[serial]
    fn diagnostic_clipboard_state() {
        eprintln!("\n=== Clipboard Diagnostic ===");

        // Check available formats
        for (id, name) in &[
            (1, "CF_TEXT"),
            (2, "CF_BITMAP"),
            (7, "CF_OEMTEXT"),
            (8, "CF_DIB"),
            (13, "CF_UNICODETEXT"),
            (15, "CF_HDROP"),
            (17, "CF_DIBV5"),
        ] {
            let available = clipboard_win::raw::is_format_avail(*id);
            eprintln!(
                "  Format {} ({}): {}",
                id,
                name,
                if available { "YES" } else { "no" }
            );
        }

        // Try reading text
        match get_clipboard::<String, _>(formats::Unicode) {
            Ok(text) => eprintln!(
                "  Unicode text: {:?} ({} chars)",
                &text[..text.len().min(100)],
                text.len()
            ),
            Err(e) => eprintln!("  Unicode text: ERROR {:?}", e),
        }

        // Try reading file list
        match get_clipboard::<Vec<String>, _>(formats::FileList) {
            Ok(files) => eprintln!("  File list: {:?}", files),
            Err(e) => eprintln!("  File list: ERROR {:?}", e),
        }

        // Try reading bitmap
        match get_clipboard::<Vec<u8>, _>(formats::Bitmap) {
            Ok(data) => {
                eprintln!("  Bitmap: {} bytes", data.len());
                if data.len() >= 40 {
                    let header_size = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
                    let width = i32::from_le_bytes([data[4], data[5], data[6], data[7]]);
                    let height = i32::from_le_bytes([data[8], data[9], data[10], data[11]]);
                    let bit_count = u16::from_le_bytes([data[14], data[15]]);
                    let compression = u32::from_le_bytes([data[16], data[17], data[18], data[19]]);
                    eprintln!(
                        "    header_size={} width={} height={} bits={} compression={}",
                        header_size, width, height, bit_count, compression
                    );
                }
            }
            Err(e) => eprintln!("  Bitmap: ERROR {:?}", e),
        }

        // Now try smart_paste
        let tmp = tempfile::tempdir().unwrap();
        let result = smart_paste(tmp.path().to_str().unwrap(), "PowerShell").unwrap();
        eprintln!(
            "  smart_paste result: type={} content={}",
            result.paste_type,
            &result.content[..result.content.len().min(200)]
        );
        eprintln!("=== End Diagnostic ===\n");
    }

    #[test]
    #[serial]
    fn smart_paste_with_bitmap() {
        // Construct a minimal 2x2 32-bit BGRA bitmap
        let mut dib = vec![0u8; 40 + 16];
        dib[0..4].copy_from_slice(&40u32.to_le_bytes()); // biSize
        dib[4..8].copy_from_slice(&2i32.to_le_bytes()); // biWidth
        dib[8..12].copy_from_slice(&2i32.to_le_bytes()); // biHeight
        dib[12..14].copy_from_slice(&1u16.to_le_bytes()); // biPlanes
        dib[14..16].copy_from_slice(&32u16.to_le_bytes()); // biBitCount
        dib[16..20].copy_from_slice(&0u32.to_le_bytes()); // biCompression = BI_RGB
                                                          // Pixel data
        dib[40..56].copy_from_slice(&[
            255, 0, 0, 255, 0, 255, 0, 255, // row 0
            0, 0, 255, 255, 255, 255, 255, 255, // row 1
        ]);

        // Use Win32 API to set CF_DIB on clipboard
        set_clipboard_dib(&dib);

        // Verify bitmap is on clipboard and dump header
        let bmp_data: Vec<u8> = get_clipboard(formats::Bitmap).unwrap();
        eprintln!("[INFO] Bitmap on clipboard: {} bytes", bmp_data.len());
        eprintln!(
            "[INFO] First 20 bytes: {:?}",
            &bmp_data[..20.min(bmp_data.len())]
        );
        // Check if starts with "BM" (BMP file header)
        if bmp_data.len() >= 2 {
            eprintln!(
                "[INFO] Starts with BM? {} (0x{:02X} 0x{:02X})",
                bmp_data[0] == b'B' && bmp_data[1] == b'M',
                bmp_data[0],
                bmp_data[1]
            );
        }
        if bmp_data.len() >= 40 {
            let hs = u32::from_le_bytes([bmp_data[0], bmp_data[1], bmp_data[2], bmp_data[3]]);
            let w = i32::from_le_bytes([bmp_data[4], bmp_data[5], bmp_data[6], bmp_data[7]]);
            let h = i32::from_le_bytes([bmp_data[8], bmp_data[9], bmp_data[10], bmp_data[11]]);
            let planes = u16::from_le_bytes([bmp_data[12], bmp_data[13]]);
            let bits = u16::from_le_bytes([bmp_data[14], bmp_data[15]]);
            let comp = u32::from_le_bytes([bmp_data[16], bmp_data[17], bmp_data[18], bmp_data[19]]);
            let img_size =
                u32::from_le_bytes([bmp_data[20], bmp_data[21], bmp_data[22], bmp_data[23]]);
            eprintln!(
                "[INFO] DIB header: size={} w={} h={} planes={} bits={} comp={} img_size={}",
                hs, w, h, planes, bits, comp, img_size
            );
            let pixel_offset = if comp == 3 && hs <= 40 {
                hs as usize + 12
            } else {
                hs as usize
            };
            let row_stride = ((w as usize * (bits as usize / 8) + 3) / 4) * 4;
            let expected = pixel_offset + row_stride * h.unsigned_abs() as usize;
            eprintln!(
                "[INFO] pixel_offset={} row_stride={} expected_total={} actual={}",
                pixel_offset,
                row_stride,
                expected,
                bmp_data.len()
            );
        }
        assert!(bmp_data.len() >= 40, "Bitmap data too small");

        // Use temp dir for image saving
        let tmp = tempfile::tempdir().unwrap();
        let result = smart_paste(tmp.path().to_str().unwrap(), "PowerShell").unwrap();
        eprintln!(
            "[INFO] smart_paste bitmap returned: type={}, content={}",
            result.paste_type, result.content
        );

        assert_eq!(result.paste_type, "path");
        assert!(
            Path::new(&result.content).exists(),
            "Saved PNG should exist: {}",
            result.content
        );
        eprintln!("[PASS] smart_paste saves bitmap as PNG: {}", result.content);
    }

    #[test]
    #[serial]
    fn smart_paste_with_bitmap_wsl_path() {
        let mut dib = vec![0u8; 40 + 8];
        dib[0..4].copy_from_slice(&40u32.to_le_bytes());
        dib[4..8].copy_from_slice(&2i32.to_le_bytes());
        dib[8..12].copy_from_slice(&1i32.to_le_bytes());
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&32u16.to_le_bytes());
        dib[16..20].copy_from_slice(&0u32.to_le_bytes());
        dib[40..48].copy_from_slice(&[255, 0, 0, 255, 0, 255, 0, 255]);

        set_clipboard_dib(&dib);

        let tmp = tempfile::tempdir().unwrap();
        let result = smart_paste(tmp.path().to_str().unwrap(), "WSL").unwrap();
        eprintln!(
            "[INFO] smart_paste bitmap WSL returned: type={}, content={}",
            result.paste_type, result.content
        );

        assert_eq!(result.paste_type, "path");
        assert!(
            result.content.starts_with("/mnt/"),
            "WSL path should start with /mnt/, got: {}",
            result.content
        );
        eprintln!("[PASS] smart_paste bitmap WSL: {}", result.content);
    }

    /// Set CF_DIB on clipboard using raw Win32 API.
    fn set_clipboard_dib(dib: &[u8]) {
        use std::ptr;

        extern "system" {
            fn OpenClipboard(hwnd: *mut core::ffi::c_void) -> i32;
            fn CloseClipboard() -> i32;
            fn EmptyClipboard() -> i32;
            fn SetClipboardData(
                format: u32,
                hmem: *mut core::ffi::c_void,
            ) -> *mut core::ffi::c_void;
            fn GlobalAlloc(flags: u32, bytes: usize) -> *mut core::ffi::c_void;
            fn GlobalLock(hmem: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
            fn GlobalUnlock(hmem: *mut core::ffi::c_void) -> i32;
        }

        unsafe {
            // OpenClipboard can fail transiently when another process holds the
            // clipboard (clipboard viewer, manager, etc.). Retry a few times.
            let mut opened = false;
            for _ in 0..20 {
                if OpenClipboard(ptr::null_mut()) != 0 {
                    opened = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            assert!(opened, "OpenClipboard failed after retries");
            EmptyClipboard();

            let hmem = GlobalAlloc(0x0002, dib.len()); // GMEM_MOVEABLE
            assert!(!hmem.is_null(), "GlobalAlloc failed");

            let lock = GlobalLock(hmem);
            assert!(!lock.is_null(), "GlobalLock failed");
            ptr::copy_nonoverlapping(dib.as_ptr(), lock as *mut u8, dib.len());
            GlobalUnlock(hmem);

            let result = SetClipboardData(8, hmem); // CF_DIB = 8
            assert!(!result.is_null(), "SetClipboardData failed");

            CloseClipboard();
        }
    }
}
