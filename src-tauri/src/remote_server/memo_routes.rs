use axum::extract::{Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use super::lease::require_active_lease;
use super::{internal_error, json_error};
use crate::automation_server::ServerState;
use crate::settings::{load_shared_memos, save_shared_memo, MemoWriteError};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct MemoSaveRequest {
    lease_id: String,
    key: String,
    content: String,
    expected_content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct MemoListQuery {
    lease_id: String,
}

pub(super) async fn remote_memos(
    State(server): State<ServerState>,
    Query(query): Query<MemoListQuery>,
) -> Response {
    if let Err(response) = require_active_lease(&server.app_state, Some(&query.lease_id)) {
        return response;
    }
    match tokio::task::spawn_blocking(load_shared_memos).await {
        Ok(Ok(memos)) => {
            no_store(crate::automation_server::handlers_backend::build_memos_list_payload(memos))
        }
        Ok(Err(error)) => internal_error(error),
        Err(error) => internal_error(error.to_string()),
    }
}

pub(super) async fn remote_memo_save(
    State(server): State<ServerState>,
    Json(body): Json<MemoSaveRequest>,
) -> Response {
    if let Err(response) = require_active_lease(&server.app_state, Some(&body.lease_id)) {
        return response;
    }
    if !valid_memo_key(&body.key) {
        return json_error(StatusCode::BAD_REQUEST, "invalid memo key");
    }
    match tokio::task::spawn_blocking(move || {
        save_shared_memo(&body.key, &body.content, &body.expected_content)
    })
    .await
    {
        Ok(Ok(())) => no_store(serde_json::json!({"ok": true})),
        Ok(Err(MemoWriteError::Conflict)) => json_error(
            StatusCode::CONFLICT,
            "Memo changed on the PC. Copy your draft, then reload.",
        ),
        Ok(Err(MemoWriteError::Storage(error))) => internal_error(error),
        Err(error) => internal_error(error.to_string()),
    }
}

fn valid_memo_key(key: &str) -> bool {
    key.starts_with("memo-")
        && key.len() > 5
        && key.len() <= 256
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn no_store(value: serde_json::Value) -> Response {
    let mut response = Json(value).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memo_wire_requires_baseline_and_scoped_key() {
        assert!(valid_memo_key("memo-pane-123"));
        for key in ["memo-", "../settings", "memo-../path", "other", "memo-x/y"] {
            assert!(!valid_memo_key(key));
        }
        assert!(serde_json::from_value::<MemoSaveRequest>(
            serde_json::json!({"leaseId":"lease", "key":"memo-pane", "content":"new"})
        )
        .is_err());
        assert_eq!(
            no_store(serde_json::json!({})).headers()[header::CACHE_CONTROL],
            "no-store"
        );
    }
}
