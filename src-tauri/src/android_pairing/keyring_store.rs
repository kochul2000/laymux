use crate::error::AppError;

#[cfg(not(test))]
use crate::constants::{ANDROID_PAIRING_KEYRING_ACCOUNT, KEYRING_SERVICE, KEYRING_SERVICE_DEV};

#[cfg(not(test))]
fn service_name() -> &'static str {
    if cfg!(debug_assertions) {
        KEYRING_SERVICE_DEV
    } else {
        KEYRING_SERVICE
    }
}

#[cfg(not(test))]
fn keyring_error(error: keyring::Error) -> AppError {
    AppError::Other(format!("Android pairing keyring error: {error}"))
}

#[cfg(not(test))]
pub fn get_record() -> Result<Option<String>, AppError> {
    let entry = keyring::Entry::new(service_name(), ANDROID_PAIRING_KEYRING_ACCOUNT)
        .map_err(keyring_error)?;
    match entry.get_password() {
        Ok(record) => Ok(Some(record)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(keyring_error(error)),
    }
}

#[cfg(not(test))]
pub fn set_record(record: &str) -> Result<(), AppError> {
    keyring::Entry::new(service_name(), ANDROID_PAIRING_KEYRING_ACCOUNT)
        .map_err(keyring_error)?
        .set_password(record)
        .map_err(keyring_error)
}

#[cfg(not(test))]
pub fn delete_record() -> Result<(), AppError> {
    let entry = keyring::Entry::new(service_name(), ANDROID_PAIRING_KEYRING_ACCOUNT)
        .map_err(keyring_error)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(keyring_error(error)),
    }
}

#[cfg(test)]
pub use mock::{delete_record, get_record, set_record};

#[cfg(test)]
pub fn reset_mock_store() -> Result<(), AppError> {
    mock::reset()
}

#[cfg(test)]
mod mock {
    use std::sync::Mutex;

    use crate::error::AppError;
    use crate::lock_ext::MutexExt;

    static RECORD: Mutex<Option<String>> = Mutex::new(None);

    pub fn get_record() -> Result<Option<String>, AppError> {
        Ok(RECORD.lock_or_err()?.clone())
    }

    pub fn set_record(record: &str) -> Result<(), AppError> {
        *RECORD.lock_or_err()? = Some(record.to_string());
        Ok(())
    }

    pub fn delete_record() -> Result<(), AppError> {
        *RECORD.lock_or_err()? = None;
        Ok(())
    }

    pub fn reset() -> Result<(), AppError> {
        delete_record()
    }
}
