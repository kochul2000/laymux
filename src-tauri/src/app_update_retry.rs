use std::future::Future;

/// Keep a manifest check in flight until its retry also has an answer.
pub(super) async fn check<T, F>(mut request: impl FnMut() -> F) -> tauri_plugin_updater::Result<T>
where
    F: Future<Output = tauri_plugin_updater::Result<T>>,
{
    match request().await {
        Ok(value) => Ok(value),
        Err(error) => {
            tracing::debug!(%error, "retrying application update manifest check");
            tokio::time::sleep(crate::constants::UPDATE_CHECK_RETRY_DELAY).await;
            request().await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_update::{UpdateChannel, UpdateManager, UpdateOperation};
    use std::future::ready;
    use tauri_plugin_updater::Error;

    #[tokio::test]
    async fn successful_check_is_not_repeated() {
        let mut attempts = 0;
        let result = check(|| {
            attempts += 1;
            ready(Ok::<_, Error>(None::<()>))
        })
        .await;
        assert_eq!(result.unwrap(), None);
        assert_eq!(attempts, 1);
    }

    #[tokio::test]
    async fn first_failure_stays_checking_and_retry_success_does_not_surface_an_error() {
        let manager = UpdateManager::default();
        manager.status.lock().unwrap().enabled = true;
        assert!(manager.begin_check(UpdateChannel::Beta).unwrap());
        let mut attempts = 0;
        let result = check(|| {
            attempts += 1;
            let status = manager.snapshot().unwrap();
            assert_eq!(status.operation, UpdateOperation::Checking);
            assert!(status.last_error.is_none());
            assert!(!manager.begin_check(UpdateChannel::Beta).unwrap());
            ready(if attempts == 1 {
                Err(Error::ReleaseNotFound)
            } else {
                Ok(None)
            })
        })
        .await;
        let status = manager.finish_check(result.unwrap()).unwrap();
        assert_eq!(attempts, 2);
        assert_eq!(status.operation, UpdateOperation::Idle);
        assert!(status.last_error.is_none());
    }

    #[tokio::test]
    async fn second_failure_is_returned_without_a_third_attempt() {
        let mut attempts = 0;
        let error = check(|| {
            attempts += 1;
            ready(Err::<(), _>(Error::Network(format!("failure {attempts}"))))
        })
        .await
        .unwrap_err();
        assert_eq!(attempts, 2);
        assert!(matches!(error, Error::Network(message) if message == "failure 2"));
    }
}
