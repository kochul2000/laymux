use std::sync::{Mutex, MutexGuard};

use crate::error::AppError;

/// Mutex 락 획득 보일러플레이트를 제거하는 확장 트레이트.
///
/// ```rust,ignore
/// // ❌ 기존 — 반복적인 map_err
/// state.terminals.lock().map_err(|e| format!("Lock error: {e}"))?;
///
/// // ✅ 개선
/// use crate::lock_ext::MutexExt;
/// state.terminals.lock_or_err()?;
/// ```
pub trait MutexExt<T> {
    fn lock_or_err(&self) -> Result<MutexGuard<'_, T>, AppError>;

    /// Recover a poisoned guard only for fail-stop cleanup/liveness state.
    ///
    /// Callers must not resume normal use of the protected value. This exists
    /// for terminal-generation retirement and condvar gates whose sole job is
    /// to wake blocked threads while the poisoned generation is discarded.
    fn lock_or_recover_for_cleanup(&self, context: &'static str) -> MutexGuard<'_, T>;
}

impl<T> MutexExt<T> for Mutex<T> {
    fn lock_or_err(&self) -> Result<MutexGuard<'_, T>, AppError> {
        self.lock().map_err(|e| AppError::Lock(format!("{e}")))
    }

    fn lock_or_recover_for_cleanup(&self, context: &'static str) -> MutexGuard<'_, T> {
        match self.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                tracing::warn!(context, "recovering poisoned mutex for fail-stop cleanup");
                poisoned.into_inner()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_or_err_succeeds() {
        let mutex = Mutex::new(42);
        let guard = mutex.lock_or_err().unwrap();
        assert_eq!(*guard, 42);
    }

    #[test]
    fn lock_or_err_returns_app_error_on_poison() {
        let mutex = Mutex::new(0);
        // Poison the mutex
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = mutex.lock().unwrap();
            panic!("intentional poison");
        }));
        let result = mutex.lock_or_err();
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().starts_with("Lock poisoned:"));
    }

    #[test]
    fn cleanup_recovery_returns_poisoned_value_without_clearing_normal_failure() {
        let mutex = Mutex::new(7);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = mutex.lock().unwrap();
            panic!("intentional poison");
        }));

        assert_eq!(*mutex.lock_or_recover_for_cleanup("test cleanup"), 7);
        assert!(mutex.lock_or_err().is_err());
    }
}
