/// 통합 에러 타입.
/// Tauri command 경계에서 `String`으로 변환하여 반환한다.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Lock poisoned: {0}")]
    Lock(String),
    #[error("Session '{0}' not found")]
    SessionNotFound(String),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

/// Tauri command에서 `Result<T, String>` 반환을 위한 변환
impl From<AppError> for String {
    fn from(e: AppError) -> Self {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_error_display() {
        let err = AppError::Lock("terminals".to_string());
        assert_eq!(err.to_string(), "Lock poisoned: terminals");
    }

    #[test]
    fn session_not_found_display() {
        let err = AppError::SessionNotFound("term-123".to_string());
        assert_eq!(err.to_string(), "Session 'term-123' not found");
    }

    #[test]
    fn io_error_conversion() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file not found");
        let err: AppError = io_err.into();
        assert!(err.to_string().contains("file not found"));
    }

    #[test]
    fn json_error_conversion() {
        let json_err = serde_json::from_str::<serde_json::Value>("invalid").unwrap_err();
        let err: AppError = json_err.into();
        assert!(err.to_string().starts_with("JSON:"));
    }

    #[test]
    fn other_error_display() {
        let err = AppError::Other("something went wrong".to_string());
        assert_eq!(err.to_string(), "something went wrong");
    }

    #[test]
    fn app_error_to_string_conversion() {
        let err = AppError::Lock("test".to_string());
        let s: String = err.into();
        assert_eq!(s, "Lock poisoned: test");
    }

    #[test]
    fn error_trait_source() {
        let io_err = std::io::Error::new(std::io::ErrorKind::Other, "test");
        let err = AppError::Io(io_err);
        assert!(std::error::Error::source(&err).is_some());

        let err = AppError::Lock("test".to_string());
        assert!(std::error::Error::source(&err).is_none());
    }
}
