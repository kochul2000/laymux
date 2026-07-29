use std::sync::{Mutex, MutexGuard, PoisonError};

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

    /// Recover a poisoned guard only to discard protected state or wake
    /// waiters while an owning resource is being irreversibly closed.
    ///
    /// Callers must not resume normal use of the protected value. This exists
    /// Callers must leave the mutex poisoned and must not publish, authorize,
    /// or resume normal operation from any recovered field.
    fn lock_or_recover_for_discard(&self, context: &'static str) -> MutexGuard<'_, T>;

    /// Mutable-owner variant for `Drop`, where no concurrent accessor exists
    /// and the protected resources are about to be irreversibly disposed.
    fn get_mut_or_recover_for_discard(&mut self, context: &'static str) -> &mut T;
}

/// Recover a poisoned guard returned by `Condvar::wait` under the same narrow
/// discard/wake policy as [`MutexExt::lock_or_recover_for_discard`].
pub fn recover_poison_for_discard<T>(poisoned: PoisonError<T>, context: &'static str) -> T {
    tracing::warn!(
        context,
        "recovering poisoned mutex for discard-only cleanup"
    );
    poisoned.into_inner()
}

impl<T> MutexExt<T> for Mutex<T> {
    fn lock_or_err(&self) -> Result<MutexGuard<'_, T>, AppError> {
        self.lock().map_err(|e| AppError::Lock(format!("{e}")))
    }

    fn lock_or_recover_for_discard(&self, context: &'static str) -> MutexGuard<'_, T> {
        match self.lock() {
            Ok(guard) => guard,
            Err(poisoned) => recover_poison_for_discard(poisoned, context),
        }
    }

    fn get_mut_or_recover_for_discard(&mut self, context: &'static str) -> &mut T {
        match self.get_mut() {
            Ok(value) => value,
            Err(poisoned) => recover_poison_for_discard(poisoned, context),
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

        assert_eq!(*mutex.lock_or_recover_for_discard("test cleanup"), 7);
        assert!(mutex.lock_or_err().is_err());
    }

    #[test]
    fn owner_drop_recovery_keeps_mutex_poisoned() {
        let mut mutex = Mutex::new(vec![1]);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = mutex.lock().unwrap();
            panic!("intentional poison");
        }));

        mutex
            .get_mut_or_recover_for_discard("test owner drop")
            .clear();
        assert!(mutex.lock_or_err().is_err());
    }
}
