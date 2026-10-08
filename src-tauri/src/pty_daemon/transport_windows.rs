use crate::daemon_protocol::CONNECTION_DEADLINE;
use crate::error::AppError;
use std::io;
use std::os::windows::io::AsRawHandle;
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenGroups, SECURITY_ATTRIBUTES, SID_AND_ATTRIBUTES, TOKEN_GROUPS,
    TOKEN_QUERY,
};
use windows_sys::Win32::System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Read the actual logon group SID. AuthenticationId can differ under UAC;
/// synthesizing S-1-5-5 from it denies valid clients in linked-token sessions.
fn logon_identity(process: HANDLE) -> io::Result<String> {
    let mut token = std::ptr::null_mut();
    // SAFETY: process is a live borrowed process handle; token is an out parameter.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut written = 0;
    // SAFETY: the first call only asks for the required buffer size.
    unsafe { GetTokenInformation(token, TokenGroups, std::ptr::null_mut(), 0, &mut written) };
    if written == 0 || written > 65536 {
        unsafe { CloseHandle(token) };
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "daemon token groups rejected",
        ));
    }
    let size = written;
    // usize storage supplies alignment for both TOKEN_GROUPS and SID pointers.
    let mut storage = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    let success = unsafe {
        GetTokenInformation(
            token,
            TokenGroups,
            storage.as_mut_ptr().cast(),
            size,
            &mut written,
        )
    };
    let error = (success == 0).then(io::Error::last_os_error);
    // SAFETY: only this function owns the returned token handle.
    unsafe { CloseHandle(token) };
    if let Some(error) = error {
        return Err(error);
    }
    let offset = std::mem::offset_of!(TOKEN_GROUPS, Groups);
    // SAFETY: GetTokenInformation initialized this aligned TOKEN_GROUPS buffer.
    let groups = unsafe { &*storage.as_ptr().cast::<TOKEN_GROUPS>() };
    let count = groups.GroupCount as usize;
    if offset.saturating_add(count.saturating_mul(std::mem::size_of::<SID_AND_ATTRIBUTES>()))
        > written as usize
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "daemon token groups rejected",
        ));
    }
    // SAFETY: count and alignment validated above; all SID storage remains live.
    let entries = unsafe {
        std::slice::from_raw_parts(
            storage
                .as_ptr()
                .cast::<u8>()
                .add(offset)
                .cast::<SID_AND_ATTRIBUTES>(),
            count,
        )
    };
    const SE_GROUP_LOGON_ID: u32 = 0xc0000000;
    let entry = entries
        .iter()
        .find(|entry| entry.Attributes & SE_GROUP_LOGON_ID == SE_GROUP_LOGON_ID)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "daemon interactive logon unavailable",
            )
        })?;
    let mut sid_text = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(entry.Sid, &mut sid_text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut length = 0;
    // SAFETY: conversion returns a valid NUL-terminated LocalAlloc UTF-16 string.
    while unsafe { *sid_text.add(length) } != 0 {
        length += 1;
    }
    let identity =
        String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(sid_text, length) });
    unsafe { LocalFree(sid_text.cast()) };
    Ok(identity)
}

pub(crate) fn private_directory(path: &std::path::Path) -> Result<(), AppError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, GetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
    use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
    let logon = logon_identity(unsafe { GetCurrentProcess() })?;
    let sddl: Vec<u16> = format!("D:P(A;OICI;FA;;;{logon})")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut expected = std::ptr::null_mut();
    // SAFETY: conversion initializes an owned descriptor from NUL-terminated SDDL.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut expected,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error().into());
    }
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let attrs = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: expected,
        bInheritHandle: 0,
    };
    let created = unsafe { CreateDirectoryW(name.as_ptr(), &attrs) };
    let create_error = (created == 0).then(io::Error::last_os_error);
    unsafe { LocalFree(expected) };
    if let Some(error) = create_error {
        if error.raw_os_error() != Some(183) {
            return Err(error.into());
        }
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(AppError::Other("daemon private directory rejected".into()));
    }
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: GetNamedSecurityInfo initializes a LocalAlloc descriptor for this path.
    let status = unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(status as i32).into());
    }
    let mut text = std::ptr::null_mut();
    let mut length = 0;
    let converted = unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            1,
            DACL_SECURITY_INFORMATION,
            &mut text,
            &mut length,
        )
    };
    let error = (converted == 0).then(io::Error::last_os_error);
    unsafe { LocalFree(descriptor) };
    if let Some(error) = error {
        return Err(error.into());
    }
    // SAFETY: conversion produced length UTF-16 units including the trailing NUL.
    let actual = String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(text, length.saturating_sub(1) as usize)
    });
    unsafe { LocalFree(text.cast()) };
    if actual != format!("D:P(A;OICI;FA;;;{logon})") {
        return Err(AppError::Other(
            "daemon private directory permissions rejected".into(),
        ));
    }
    Ok(())
}

pub(crate) fn current_identity() -> Result<String, AppError> {
    // SAFETY: GetCurrentProcess returns a borrowed pseudo-handle.
    Ok(format!(
        "windows-logon:{}",
        logon_identity(unsafe { GetCurrentProcess() })?
    ))
}

fn verify_peer(pid: u32) -> io::Result<()> {
    // SAFETY: request query-only access to the PID supplied by the pipe kernel.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    let peer = logon_identity(process);
    // SAFETY: this function owns this real process handle.
    unsafe { CloseHandle(process) };
    // SAFETY: current process pseudo-handle is borrowed.
    if peer? != logon_identity(unsafe { GetCurrentProcess() })? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "daemon peer logon rejected",
        ));
    }
    Ok(())
}

fn create_pipe(name: &str, first: bool) -> io::Result<NamedPipeServer> {
    // Grant access only to the current logon SID. Default named-pipe ACLs also
    // admit other accounts; a capability alone is not the OS permission boundary.
    let logon = logon_identity(unsafe { GetCurrentProcess() })?;
    let sddl: Vec<u16> = format!("D:P(A;;GA;;;{logon})")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: NUL-terminated UTF-16 and valid descriptor out parameter.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    // SAFETY: descriptor/attributes remain valid for CreateNamedPipeW; the OS
    // copies them before this call returns. Handles are non-inheritable.
    let result = unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(
                name,
                (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
            )
    };
    // SAFETY: LocalAlloc storage returned by the conversion is owned here.
    unsafe { LocalFree(descriptor) };
    result
}

pub(crate) struct Listener {
    name: String,
    next: NamedPipeServer,
}

impl Listener {
    pub(crate) fn bind(name: &str) -> Result<Self, AppError> {
        if !name.starts_with(r"\\.\pipe\laymux-") || name.len() > 240 {
            return Err(AppError::Other("daemon pipe name rejected".into()));
        }
        Ok(Self {
            name: name.into(),
            next: create_pipe(name, true)?,
        })
    }

    pub(crate) async fn accept(&mut self) -> Result<NamedPipeServer, AppError> {
        self.next.connect().await?;
        // Keep one listening instance present while the connected instance is
        // handled, preventing both ERROR_FILE_NOT_FOUND and endpoint takeover.
        let stream = std::mem::replace(&mut self.next, create_pipe(&self.name, false)?);
        let mut pid = 0;
        // SAFETY: stream owns a live connected named-pipe handle.
        if unsafe { GetNamedPipeClientProcessId(stream.as_raw_handle().cast(), &mut pid) } == 0 {
            return Err(io::Error::last_os_error().into());
        }
        verify_peer(pid)?;
        Ok(stream)
    }
}

pub(crate) async fn connect(name: &str) -> Result<NamedPipeClient, AppError> {
    if !name.starts_with(r"\\.\pipe\laymux-") || name.len() > 240 {
        return Err(AppError::Other("daemon pipe name rejected".into()));
    }
    let stream = tokio::time::timeout(CONNECTION_DEADLINE, async {
        loop {
            match ClientOptions::new().open(name) {
                Ok(stream) => break Ok::<_, io::Error>(stream),
                Err(error) if error.raw_os_error() == Some(231) => {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await
                }
                Err(error) => break Err(error),
            }
        }
    })
    .await
    .map_err(|_| AppError::Other("daemon connection deadline exceeded".into()))??;
    let mut pid = 0;
    // SAFETY: stream owns a live connected named-pipe handle.
    if unsafe { GetNamedPipeServerProcessId(stream.as_raw_handle().cast(), &mut pid) } == 0 {
        return Err(io::Error::last_os_error().into());
    }
    verify_peer(pid)?;
    Ok(stream)
}
