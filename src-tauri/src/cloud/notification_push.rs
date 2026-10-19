//! ADR-0344: provider credentials stay in Cloud; the PC publishes typed transitions.
use std::time::Duration;

use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::AppState;

const PREFERENCES_PATH: &str = "/api/push/preferences";
const EVENTS_PATH: &str = "/api/push/events";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Waiting,
    Failure,
    Complete,
    General,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationPushEvent {
    notification_id: uuid::Uuid,
    revision: u8,
    category: Category,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    include_details: bool,
}

fn server_url(base: &str) -> Result<Url, AppError> {
    let url = Url::parse(base).map_err(|_| AppError::Other("Invalid Cloud origin".into()))?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && local))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(AppError::Other("Invalid Cloud origin".into()));
    }
    Ok(url)
}

async fn send_event(
    base: &str,
    token: &str,
    mut event: NotificationPushEvent,
) -> Result<(), AppError> {
    if !matches!(event.revision, 1 | 2) {
        return Err(AppError::Other("Invalid notification revision".into()));
    }
    let base = server_url(base)?;
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|_| AppError::Other("Push HTTP client unavailable".into()))?;
    // Never put the body on the wire until an opted-in receiver is confirmed.
    let body = event
        .body
        .take()
        .map(|body| body.chars().take(500).collect::<String>());
    if event.revision == 1 {
        let preferences = client
            .get(
                base.join(PREFERENCES_PATH)
                    .map_err(|_| AppError::Other("Invalid push route".into()))?,
            )
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| AppError::Other("Push preferences unavailable".into()))?;
        if preferences.status().is_success() {
            let preferences = preferences
                .json::<Preferences>()
                .await
                .map_err(|_| AppError::Other("Invalid push preferences".into()))?;
            if preferences.include_details {
                event.body = body;
            }
        } else if preferences.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(()); // Older Cloud version; keep the existing PC behavior.
        } else {
            return Err(AppError::Other("Push preferences refused".into()));
        }
    }
    let endpoint = base
        .join(EVENTS_PATH)
        .map_err(|_| AppError::Other("Invalid push route".into()))?;
    for attempt in 0..3 {
        let response = client
            .post(endpoint.clone())
            .bearer_auth(token)
            .json(&event)
            .send()
            .await;
        match response {
            Ok(response)
                if response.status().is_success()
                    || response.status() == reqwest::StatusCode::NOT_FOUND =>
            {
                return Ok(())
            }
            Ok(response)
                if response.status().is_client_error()
                    && response.status() != reqwest::StatusCode::TOO_MANY_REQUESTS =>
            {
                break
            }
            _ => {}
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(250 * (attempt + 1))).await;
        }
    }
    Err(AppError::Other(
        "Cloud notification delivery unavailable".into(),
    ))
}

pub async fn publish_notification_push_inner(
    state: &AppState,
    event: NotificationPushEvent,
) -> Result<(), AppError> {
    let remote = crate::remote_server::effective_remote_settings(state).map_err(AppError::Other)?;
    if !remote.enabled || !remote.cloud_enabled {
        return Ok(());
    }
    let Some(base) = remote.cloud_server_base_url else {
        return Ok(());
    };
    let token = tokio::task::spawn_blocking(super::keyring_store::get_device_token)
        .await
        .map_err(|_| AppError::Other("Cloud credential read failed".into()))??;
    let Some(token) = token else {
        return Ok(());
    };
    send_event(&base, &token, event).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        routing::{get, post},
        Json, Router,
    };
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn generic_mode_never_sends_body_and_read_has_no_body() {
        let received = Arc::new(Mutex::new(Vec::<Value>::new()));
        let records = received.clone();
        let app = Router::new()
            .route(
                PREFERENCES_PATH,
                get(|| async { Json(json!({"includeDetails":false})) }),
            )
            .route(
                EVENTS_PATH,
                post(move |Json(event): Json<Value>| {
                    let records = records.clone();
                    async move {
                        records.lock().unwrap().push(event);
                        axum::http::StatusCode::ACCEPTED
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        for revision in [1, 2] {
            send_event(
                &base,
                "test-only",
                NotificationPushEvent {
                    notification_id: uuid::Uuid::new_v4(),
                    revision,
                    category: Category::Waiting,
                    body: Some("private /repo".into()),
                },
            )
            .await
            .unwrap();
        }
        assert_eq!(received.lock().unwrap().len(), 2);
        assert!(received
            .lock()
            .unwrap()
            .iter()
            .all(|event| event.get("body").is_none()));
        task.abort();
    }

    #[test]
    fn token_cannot_be_redirected_or_sent_to_insecure_remote_host() {
        for origin in [
            "http://evil.test/",
            "https://user:pass@example.com/",
            "https://example.com/path",
            "https://example.com/?q=1",
        ] {
            assert!(server_url(origin).is_err());
        }
    }
}
