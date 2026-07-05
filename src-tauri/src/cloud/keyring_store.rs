use crate::error::AppError;

const DEVICE_TOKEN_ACCOUNT: &str = "device-token";
const KEYRING_SERVICE: &str = "laymux";
const KEYRING_SERVICE_DEV: &str = "laymux-dev";

fn service_name() -> &'static str {
    if cfg!(debug_assertions) {
        KEYRING_SERVICE_DEV
    } else {
        KEYRING_SERVICE
    }
}

fn keyring_error(error: keyring::Error) -> AppError {
    AppError::Other(format!("Keyring error: {error}"))
}

enum KeyringStoreError {
    Keyring(keyring::Error),
    #[cfg(test)]
    App(AppError),
}

impl KeyringStoreError {
    fn into_app_error(self) -> AppError {
        match self {
            Self::Keyring(error) => keyring_error(error),
            #[cfg(test)]
            Self::App(error) => error,
        }
    }
}

#[cfg(not(test))]
fn with_device_token_entry<T>(
    operation: impl FnOnce(&keyring::Entry) -> keyring::Result<T>,
) -> Result<T, KeyringStoreError> {
    let entry = keyring::Entry::new(service_name(), DEVICE_TOKEN_ACCOUNT)
        .map_err(KeyringStoreError::Keyring)?;
    operation(&entry).map_err(KeyringStoreError::Keyring)
}

#[cfg(test)]
mod test_entry {
    use std::sync::{Mutex, OnceLock};

    use crate::error::AppError;

    static MOCK_ENTRY: OnceLock<Mutex<keyring::Entry>> = OnceLock::new();

    fn new_mock_entry() -> Result<keyring::Entry, AppError> {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        keyring::Entry::new(super::service_name(), super::DEVICE_TOKEN_ACCOUNT)
            .map_err(super::keyring_error)
    }

    pub fn reset_mock_store() -> Result<(), AppError> {
        let next = new_mock_entry()?;
        if let Some(entry) = MOCK_ENTRY.get() {
            let mut guard = entry
                .lock()
                .map_err(|e| AppError::Lock(format!("cloud keyring mock: {e}")))?;
            *guard = next;
            return Ok(());
        }

        match MOCK_ENTRY.set(Mutex::new(next)) {
            Ok(()) => Ok(()),
            Err(next) => {
                let entry = MOCK_ENTRY
                    .get()
                    .ok_or_else(|| AppError::Other("Keyring mock initialization failed".into()))?;
                let mut guard = entry
                    .lock()
                    .map_err(|e| AppError::Lock(format!("cloud keyring mock: {e}")))?;
                *guard = next
                    .into_inner()
                    .map_err(|e| AppError::Lock(format!("cloud keyring mock: {e}")))?;
                Ok(())
            }
        }
    }

    pub fn with_entry<T>(
        operation: impl FnOnce(&keyring::Entry) -> keyring::Result<T>,
    ) -> Result<T, super::KeyringStoreError> {
        if MOCK_ENTRY.get().is_none() {
            reset_mock_store().map_err(super::KeyringStoreError::App)?;
        }
        let entry = MOCK_ENTRY
            .get()
            .ok_or_else(|| AppError::Other("Keyring mock is not initialized".into()))
            .map_err(super::KeyringStoreError::App)?;
        let guard = entry
            .lock()
            .map_err(|e| AppError::Lock(format!("cloud keyring mock: {e}")))
            .map_err(super::KeyringStoreError::App)?;
        operation(&guard).map_err(super::KeyringStoreError::Keyring)
    }

    pub fn set_error(error: keyring::Error) -> Result<(), AppError> {
        if MOCK_ENTRY.get().is_none() {
            reset_mock_store()?;
        }
        let entry = MOCK_ENTRY
            .get()
            .ok_or_else(|| AppError::Other("Keyring mock is not initialized".into()))?;
        let guard = entry
            .lock()
            .map_err(|e| AppError::Lock(format!("cloud keyring mock: {e}")))?;
        let mock = guard
            .get_credential()
            .downcast_ref::<keyring::mock::MockCredential>()
            .ok_or_else(|| AppError::Other("Keyring mock credential is unavailable".into()))?;
        mock.set_error(error);
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn reset_mock_store() -> Result<(), AppError> {
    test_entry::reset_mock_store()
}

#[cfg(test)]
pub(crate) fn set_mock_error(error: keyring::Error) -> Result<(), AppError> {
    test_entry::set_error(error)
}

#[cfg(test)]
fn with_device_token_entry<T>(
    operation: impl FnOnce(&keyring::Entry) -> keyring::Result<T>,
) -> Result<T, KeyringStoreError> {
    test_entry::with_entry(operation)
}

pub fn get_device_token() -> Result<Option<String>, AppError> {
    match with_device_token_entry(|entry| entry.get_password()) {
        Ok(token) => Ok(Some(token)),
        Err(KeyringStoreError::Keyring(keyring::Error::NoEntry)) => Ok(None),
        Err(error) => Err(error.into_app_error()),
    }
}

pub fn set_device_token(token: &str) -> Result<(), AppError> {
    with_device_token_entry(|entry| entry.set_password(token))
        .map_err(KeyringStoreError::into_app_error)
}

pub fn delete_device_token() -> Result<(), AppError> {
    match with_device_token_entry(|entry| entry.delete_credential()) {
        Ok(()) => Ok(()),
        Err(KeyringStoreError::Keyring(keyring::Error::NoEntry)) => Ok(()),
        Err(error) => Err(error.into_app_error()),
    }
}

#[cfg(test)]
mod tests {
    use serial_test::serial;

    use super::*;

    #[test]
    #[serial]
    fn device_token_round_trip_uses_mock_keyring() {
        reset_mock_store().unwrap();

        assert_eq!(get_device_token().unwrap(), None);
        set_device_token("device-token-123").unwrap();
        assert_eq!(
            get_device_token().unwrap().as_deref(),
            Some("device-token-123")
        );
        delete_device_token().unwrap();
        assert_eq!(get_device_token().unwrap(), None);
    }

    #[test]
    #[serial]
    fn delete_device_token_is_idempotent_for_missing_token() {
        reset_mock_store().unwrap();

        delete_device_token().unwrap();
        assert_eq!(get_device_token().unwrap(), None);
    }
}
