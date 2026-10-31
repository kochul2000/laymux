use super::*;

fn u16_at(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}
fn u32_at(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

// Two read-only PE sections, a CodeView record and a second debug record.
fn pe_helper() -> Vec<u8> {
    let mut bytes = vec![0; 1536];
    bytes[..2].copy_from_slice(b"MZ");
    u32_at(&mut bytes, 0x3c, 0x80);
    bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
    u16_at(&mut bytes, 0x84, 0x8664);
    u16_at(&mut bytes, 0x86, 2);
    u16_at(&mut bytes, 0x94, 240);
    u16_at(&mut bytes, 0x98, 0x20b);
    u32_at(&mut bytes, 0x98 + 60, 512);
    u32_at(&mut bytes, 0x98 + 108, 16);
    u32_at(&mut bytes, 0x98 + 112 + 6 * 8, 0x2000);
    u32_at(&mut bytes, 0x98 + 112 + 6 * 8 + 4, 56);
    for (i, (rva, raw, flags)) in [(0x1000, 512, 0x60000020), (0x2000, 1024, 0x40000040)]
        .into_iter()
        .enumerate()
    {
        let section = 0x188 + i * 40;
        u32_at(&mut bytes, section + 8, 512);
        u32_at(&mut bytes, section + 12, rva);
        u32_at(&mut bytes, section + 16, 512);
        u32_at(&mut bytes, section + 20, raw);
        u32_at(&mut bytes, section + 36, flags);
    }
    bytes[512..1024].fill(0x90);
    u32_at(&mut bytes, 1024 + 12, 2);
    u32_at(&mut bytes, 1024 + 16, 33);
    u32_at(&mut bytes, 1024 + 20, 0x2080);
    u32_at(&mut bytes, 1024 + 24, 1152);
    bytes[1152..1156].copy_from_slice(b"RSDS");
    bytes[1156..1172].fill(0x11);
    u32_at(&mut bytes, 1172, 1);
    bytes[1176..1185].copy_from_slice(b"hook.pdb\0");
    u32_at(&mut bytes, 1052 + 12, 12);
    u32_at(&mut bytes, 1052 + 16, 4);
    u32_at(&mut bytes, 1052 + 20, 0x20c0);
    u32_at(&mut bytes, 1052 + 24, 1216);
    bytes
}

fn inspect_pair(provider: &str, installed: &[u8], bundled: &[u8]) -> Value {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("config");
    let source = dir.path().join("bundle");
    fs::write(&source, installed).unwrap();
    manage(&root, provider, "install", &source).unwrap();
    fs::write(&source, bundled).unwrap();
    let config = root.join(config_name(provider).unwrap());
    let before = fs::read(&config).unwrap();
    let result = manage(&root, provider, "status", &source).unwrap();
    assert_eq!(fs::read(&config).unwrap(), before);
    assert_eq!(fs::read(helper_path(&root)).unwrap(), installed);
    assert_eq!(fs::read(source).unwrap(), bundled);
    result
}

#[test]
fn metadata_only_windows_rebuild_does_not_request_a_hook_update() {
    let installed = pe_helper();
    let mut bundled = installed.clone();
    for offset in [0x88, 1028, 1056, 1156, 1172] {
        u32_at(&mut bundled, offset, 123);
    }
    for provider in ["claude", "codex", "grok"] {
        let status = inspect_pair(provider, &installed, &bundled);
        assert_eq!(status["helperCurrent"], true, "{provider}: {status}");
        assert_eq!(status["updateRequired"], false, "{provider}: {status}");
    }
}

#[test]
fn executable_constants_paths_and_headers_still_request_updates() {
    let bundled = pe_helper();
    for offset in [512, 1280, 1176, 0x98 + 16, 1024 + 24] {
        let mut installed = bundled.clone();
        installed[offset] ^= 1;
        let status = inspect_pair("claude", &installed, &bundled);
        assert_eq!(status["updateRequired"], true, "offset {offset}: {status}");
        assert_eq!(status["updateReasons"], json!(["helper_outdated"]));
    }
}

#[test]
fn unsupported_or_malformed_bundle_falls_back_to_exact_bytes() {
    for (offset, value) in [
        (0, 0),
        (0x80, 0),
        (0x98, 0x10b),
        (0x86, 97),
        (0x94, 1),
        (0x98 + 108, 17),
        (0x98 + 112 + 6 * 8, 0x1000),
        (0x98 + 112 + 6 * 8, u32::MAX - 8),
        (0x98 + 112 + 6 * 8 + 4, 55),
        (0x98 + 112 + 6 * 8 + 4, 28 * 65),
        (0x188 + 40 + 20, 512),
        (0x188 + 40 + 12, 0x1000),
        (0x188 + 40 + 12, u32::MAX - 8),
        (0x188 + 40 + 36, 0x60000040),
        (0x188 + 40 + 36, 0xc0000040),
        (1024 + 24, 512),
        (1024 + 16, u32::MAX),
        (1152, 0),
        (1184, 1),
    ] {
        let mut bundled = pe_helper();
        u32_at(&mut bundled, offset, value);
        let mut installed = bundled.clone();
        installed[0x88] ^= 1;
        let status = inspect_pair("claude", &installed, &bundled);
        assert_eq!(status["helperCurrent"], false, "offset {offset}: {status}");
    }
}

#[test]
fn debug_payload_overlap_and_truncation_keep_exact_comparison() {
    let mut overlap = pe_helper();
    u32_at(&mut overlap, 1052 + 20, 0x2080);
    u32_at(&mut overlap, 1052 + 24, 1152);
    let mut old = overlap.clone();
    old[0x88] ^= 1;
    assert_eq!(
        inspect_pair("claude", &old, &overlap)["helperCurrent"],
        false
    );
    let bytes = pe_helper();
    for end in [0x89, 0x98, 0x100, 512, 1024, 1155, 1184, 1535] {
        let bundled = &bytes[..end];
        let mut installed = bundled.to_vec();
        installed[0x88] ^= 1;
        assert_eq!(
            inspect_pair("claude", &installed, bundled)["helperCurrent"],
            false,
            "length {end}"
        );
    }
}

#[test]
fn absent_debug_directory_only_exempts_the_coff_timestamp() {
    let mut bundled = pe_helper();
    u32_at(&mut bundled, 0x98 + 108, 0);
    let mut installed = bundled.clone();
    installed[0x88] ^= 1;
    assert_eq!(
        inspect_pair("claude", &installed, &bundled)["helperCurrent"],
        true
    );
    installed[1156] ^= 1;
    assert_eq!(
        inspect_pair("claude", &installed, &bundled)["helperCurrent"],
        false
    );
}

#[test]
fn elf_and_other_files_keep_exact_byte_comparison() {
    let mut bundled = pe_helper();
    bundled[..4].copy_from_slice(b"\x7fELF");
    let mut installed = bundled.clone();
    installed[0x88] ^= 1;
    assert_eq!(
        inspect_pair("claude", &installed, &bundled)["helperCurrent"],
        false
    );
    assert_eq!(
        inspect_pair("claude", &bundled, &bundled)["helperCurrent"],
        true
    );
}
