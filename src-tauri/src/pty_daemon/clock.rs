//! Cross-process deadlines use a host monotonic clock, never wall-clock time.
use crate::error::AppError;
use std::time::{Duration, Instant};

#[cfg(windows)]
pub(crate) fn uptime_millis() -> Result<u64, AppError> {
    // SAFETY: GetTickCount64 has no preconditions and never fails.
    Ok(unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() })
}

#[cfg(target_os = "linux")]
pub(crate) fn uptime_millis() -> Result<u64, AppError> {
    let mut time: libc::timespec = unsafe { std::mem::zeroed() };
    // SAFETY: valid aligned out storage for a monotonic clock read.
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let seconds = u64::try_from(time.tv_sec)
        .map_err(|_| AppError::Other("daemon monotonic clock rejected".into()))?;
    let nanos = u64::try_from(time.tv_nsec)
        .map_err(|_| AppError::Other("daemon monotonic clock rejected".into()))?;
    seconds
        .checked_mul(1000)
        .and_then(|value| value.checked_add(nanos / 1_000_000))
        .ok_or_else(|| AppError::Other("daemon monotonic clock overflow".into()))
}

pub(crate) fn export_deadline(deadline: Instant) -> Result<u64, AppError> {
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .as_millis();
    let remaining = u64::try_from(remaining)
        .map_err(|_| AppError::Other("daemon control deadline overflow".into()))?;
    uptime_millis()?
        .checked_add(remaining)
        .ok_or_else(|| AppError::Other("daemon control deadline overflow".into()))
}

pub(crate) fn import_deadline(expiry: u64) -> Result<Instant, AppError> {
    let remaining = expiry
        .checked_sub(uptime_millis()?)
        .filter(|value| *value > 0 && *value <= crate::constants::PTY_CONTROL_JOB_TIMEOUT_MS)
        .ok_or_else(|| {
            AppError::Other("daemon control request expired or deadline rejected".into())
        })?;
    Instant::now()
        .checked_add(Duration::from_millis(remaining))
        .ok_or_else(|| AppError::Other("daemon control deadline overflow".into()))
}
