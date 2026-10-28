//! Default distribution lookup without launching a guest or wsl.exe.

#[cfg(windows)]
pub(super) fn read() -> Option<String> {
    let base = crate::constants::WSL_USER_REGISTRY_KEY;
    let id = read_string(base, crate::constants::WSL_DEFAULT_DISTRIBUTION_VALUE)?;
    uuid::Uuid::parse_str(id.trim_matches(['{', '}'])).ok()?;
    let name = read_string(
        &format!("{base}\\{id}"),
        crate::constants::WSL_DISTRIBUTION_NAME_VALUE,
    )?;
    super::is_safe_distro_name(&name).then_some(name)
}

#[cfg(windows)]
fn read_string(key: &str, value: &str) -> Option<String> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (key, value) = (wide(key), wide(value));
    let query = |data: *mut u16, size: &mut u32| {
        // SAFETY: strings are terminated; data is null for a size query or
        // points to a buffer of the byte length passed in size.
        unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                data.cast(),
                size,
            )
        }
    };
    let mut size = 0;
    if query(std::ptr::null_mut(), &mut size) != ERROR_SUCCESS || size > 65_536 {
        return None;
    }
    let mut data = vec![0; (size as usize).div_ceil(2)];
    if query(data.as_mut_ptr(), &mut size) != ERROR_SUCCESS {
        return None;
    }
    let end = data.iter().position(|c| *c == 0).unwrap_or(data.len());
    String::from_utf16(&data[..end])
        .ok()
        .filter(|name| !name.is_empty())
}
