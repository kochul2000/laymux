//! Windows: restrict a file to the current user (ADR-0305).
//!
//! An AF_UNIX socket on Windows is a file, and connecting to it needs write
//! access to that file. Giving the socket file a protected DACL that grants
//! only the current user and SYSTEM therefore keeps every other local
//! account from connecting at all — the boundary a loopback TCP port lacks.

use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr;

use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
    ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW,
    SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    GetSecurityDescriptorDacl, GetTokenInformation, TokenUser, ACL, DACL_SECURITY_INFORMATION,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// Replace `path`'s DACL with one that grants full access to the current user
/// and SYSTEM only, and stops inheriting entries from the parent directory.
pub fn restrict_to_current_user(path: &Path) -> io::Result<()> {
    let sid = current_user_sid()?;
    let sddl = wide(&format!("D:P(A;;FA;;;{sid})(A;;FA;;;SY)"));
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: `sddl` is NUL-terminated; on success the API allocates
    // `descriptor`, which `LocalGuard` frees.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let _descriptor = LocalGuard(descriptor);
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl: *mut ACL = ptr::null_mut();
    // SAFETY: `descriptor` is a valid self-relative descriptor; `dacl`
    // points into it and lives as long as `_descriptor`.
    if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    let target = wide_path(path);
    // SAFETY: `target` is NUL-terminated and `dacl` is valid (see above).
    let status = unsafe {
        SetNamedSecurityInfoW(
            target.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            dacl,
            ptr::null(),
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    Ok(())
}

/// The DACL of `path` in SDDL form, e.g. `D:P(A;;FA;;;S-1-5-...)(A;;FA;;;SY)`.
pub fn dacl_sddl(path: &Path) -> io::Result<String> {
    let target = wide_path(path);
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: `target` is NUL-terminated; on success the API allocates
    // `descriptor`, which `LocalGuard` frees.
    let status = unsafe {
        GetNamedSecurityInfoW(
            target.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let _descriptor = LocalGuard(descriptor);
    let mut text: *mut u16 = ptr::null_mut();
    // SAFETY: `descriptor` is valid; on success `text` is allocated and freed
    // by `LocalGuard`.
    if unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            SDDL_REVISION_1,
            DACL_SECURITY_INFORMATION,
            &mut text,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let _text = LocalGuard(text.cast());
    // SAFETY: `text` is a NUL-terminated wide string owned by `_text`.
    Ok(unsafe { from_wide_ptr(text) })
}

/// The current process user's SID, e.g. `S-1-5-21-...`.
pub fn current_user_sid() -> io::Result<String> {
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: the pseudo handle needs no closing; `token` is closed below.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let result = token_user_sid(token);
    // SAFETY: `token` was opened above and is closed exactly once.
    unsafe { CloseHandle(token) };
    result
}

fn token_user_sid(token: HANDLE) -> io::Result<String> {
    let mut needed = 0u32;
    // SAFETY: a size query with a null buffer; failure is expected.
    unsafe { GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut needed) };
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }
    // u64 storage keeps the TOKEN_USER header suitably aligned.
    let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
    // SAFETY: `buffer` holds at least `needed` bytes.
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the API filled `buffer` with a TOKEN_USER.
    let sid = unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let mut text: *mut u16 = ptr::null_mut();
    // SAFETY: `sid` points into `buffer`, alive for this call.
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _text = LocalGuard(text.cast());
    // SAFETY: `text` is a NUL-terminated wide string owned by `_text`.
    Ok(unsafe { from_wide_ptr(text) })
}

struct LocalGuard(HLOCAL);

impl Drop for LocalGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the pointer came from an API that allocates with
            // LocalAlloc and is freed exactly once here.
            unsafe { LocalFree(self.0) };
        }
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// # Safety
/// `text` must be a valid NUL-terminated UTF-16 string.
unsafe fn from_wide_ptr(text: *const u16) -> String {
    let mut len = 0;
    while *text.add(len) != 0 {
        len += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(text, len))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_restricted_file_admits_only_the_current_user_and_system() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("restricted");
        std::fs::write(&path, b"x").unwrap();
        restrict_to_current_user(&path).unwrap();

        let sid = current_user_sid().unwrap();
        assert!(sid.starts_with("S-1-"), "{sid}");
        let dacl = dacl_sddl(&path).unwrap();
        // Protected (no inherited entries) and exactly two grants.
        assert!(dacl.starts_with("D:P"), "{dacl}");
        assert_eq!(dacl.matches("(A;").count(), 2, "{dacl}");
        assert!(dacl.contains(&sid), "{dacl}");
        assert!(dacl.contains(";SY)"), "{dacl}");
        for broad in [";WD)", ";BU)", ";AU)", ";AN)", ";IU)"] {
            assert!(!dacl.contains(broad), "{dacl} grants {broad}");
        }
    }
}
