//! Refresh interval policy.
//!
//! Anthropic rate-limits `/usage`, so the normal interval has a hard floor that
//! settings cannot lower ([ADR-0102]). Failures get a shorter interval but a
//! bounded number of fast attempts, so a persistently broken probe settles back
//! to the normal cadence instead of hammering.

use std::time::Duration;

/// Hard floor for the normal refresh interval. Not user-adjustable.
pub const MIN_REFRESH_SECS: u64 = 600;
/// Ceiling offered to users; beyond this the display is too stale to be useful.
pub const MAX_REFRESH_SECS: u64 = 3600;
/// Interval used while retrying after a failed query.
pub const RETRY_REFRESH_SECS: u64 = 60;
/// How many consecutive failures may use the short interval.
pub const MAX_FAST_RETRIES: u32 = 3;

/// Clamp a requested refresh interval into the allowed range.
pub fn sanitize_refresh_seconds(requested: u64) -> u64 {
    requested.clamp(MIN_REFRESH_SECS, MAX_REFRESH_SECS)
}

/// Delay before the next query.
///
/// `consecutive_failures` counts failures including the one just observed, so
/// the first failure is `1`.
pub fn next_delay(refresh_secs: u64, consecutive_failures: u32) -> Duration {
    let normal = Duration::from_secs(sanitize_refresh_seconds(refresh_secs));
    if consecutive_failures == 0 || consecutive_failures > MAX_FAST_RETRIES {
        normal
    } else {
        Duration::from_secs(RETRY_REFRESH_SECS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_floor_cannot_be_lowered() {
        assert_eq!(sanitize_refresh_seconds(0), MIN_REFRESH_SECS);
        assert_eq!(sanitize_refresh_seconds(1), MIN_REFRESH_SECS);
        assert_eq!(sanitize_refresh_seconds(599), MIN_REFRESH_SECS);
        assert_eq!(sanitize_refresh_seconds(600), 600);
    }

    #[test]
    fn refresh_is_capped() {
        assert_eq!(sanitize_refresh_seconds(u64::MAX), MAX_REFRESH_SECS);
        assert_eq!(sanitize_refresh_seconds(900), 900);
    }

    #[test]
    fn success_uses_the_normal_interval() {
        assert_eq!(next_delay(900, 0), Duration::from_secs(900));
    }

    #[test]
    fn early_failures_retry_quickly() {
        for failures in 1..=MAX_FAST_RETRIES {
            assert_eq!(
                next_delay(900, failures),
                Duration::from_secs(RETRY_REFRESH_SECS),
                "failure {failures} should retry fast"
            );
        }
    }

    #[test]
    fn persistent_failure_falls_back_to_the_normal_interval() {
        // The invariant that matters: a permanently broken probe must not keep
        // querying every minute forever.
        assert_eq!(
            next_delay(900, MAX_FAST_RETRIES + 1),
            Duration::from_secs(900)
        );
        assert_eq!(next_delay(900, 99), Duration::from_secs(900));
    }

    /// A retry interval at or above the normal one would make failure handling
    /// pointless. Enforced at compile time.
    const _RETRY_IS_SHORTER: () = assert!(RETRY_REFRESH_SECS < MIN_REFRESH_SECS);
}
