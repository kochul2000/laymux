//! A real synchronous Win32 write must be cancelled, not merely marked stale.
use super::{StartupColorReplies, StartupColorResponder};
use crate::pty::PtyHandle;
use std::ffi::c_void;
use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::ptr;

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreatePipe(
        read: *mut *mut c_void,
        write: *mut *mut c_void,
        attributes: *const c_void,
        size: u32,
    ) -> i32;
    fn PeekNamedPipe(
        pipe: *mut c_void,
        buffer: *mut c_void,
        size: u32,
        read: *mut u32,
        available: *mut u32,
        left: *mut u32,
    ) -> i32;
}

#[test]
fn active_snapshot_write_is_cancelled_before_a_full_native_pipe_drains() {
    let mut read_handle = ptr::null_mut();
    let mut write_handle = ptr::null_mut();
    // SAFETY: valid output pointers, no inheritable handles, requested buffer.
    assert_ne!(
        unsafe { CreatePipe(&mut read_handle, &mut write_handle, ptr::null(), 4096) },
        0
    );
    // SAFETY: CreatePipe returned two distinct owned handles, adopted once each.
    let mut reader = unsafe { File::from_raw_handle(read_handle) };
    let mut writer = unsafe { File::from_raw_handle(write_handle) };
    writer.write_all(&[0; 4096]).unwrap();
    let handle = PtyHandle::from_test_writer(Box::new(writer));
    let mut responder = StartupColorResponder::new(StartupColorReplies {
        foreground: "\x1b]10;rgb:ffff/ffff/ffff\x1b\\".into(),
        background: "\x1b]11;rgb:0000/0000/0000\x1b\\".into(),
    });
    responder.respond(b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\", &handle);
    assert!(
        handle.checkpoint_input_healthy(),
        "native cancellation must acknowledge without faulting"
    );
    reader.read_exact(&mut [0; 4096]).unwrap();
    // This FIFO barrier would follow the stale color bytes if an active write
    // survived the timeout and completed when the pipe became writable again.
    handle.write_protocol_reply(b"done").unwrap();
    let mut available = 0;
    // SAFETY: reader handle remains alive; only the available count is requested.
    assert_ne!(
        unsafe {
            PeekNamedPipe(
                reader.as_raw_handle(),
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                &mut available,
                ptr::null_mut(),
            )
        },
        0
    );
    assert_eq!(
        available, 4,
        "only the subsequent marker may enter the drained pipe"
    );
    let mut marker = [0; 4];
    reader.read_exact(&mut marker).unwrap();
    assert_eq!(&marker, b"done");
    handle.terminate().unwrap();
}
