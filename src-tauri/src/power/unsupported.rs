use super::InhibitBackend;
use crate::error::AppError;

pub struct PlatformBackend;

impl PlatformBackend {
    pub fn new() -> Self {
        Self
    }
}

impl InhibitBackend for PlatformBackend {
    fn apply(&mut self, enabled: bool) -> Result<(), AppError> {
        if enabled {
            return Err(AppError::Other(
                "sleep prevention is not supported on this platform".into(),
            ));
        }
        Ok(())
    }
}
