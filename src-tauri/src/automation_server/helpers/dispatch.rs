use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use axum::{http::StatusCode, Json};
use futures_util::FutureExt;
use serde_json::Value;

use super::{bridge_request_once, err_json, ServerState};
use crate::automation_server::types::PaneCreationTarget;
use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::state::AppState;

// 회수 대기와 프런트엔드 예산의 합계는 최대 15초다 (ADR-0389).
pub(crate) const PANE_CREATION_ADMISSION_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) fn is_pane_creation(category: &str, target: &str, method: &str) -> bool {
    category == "action" && target == "panes" && matches!(method, "split" | "stack")
}

pub(super) struct BridgeBudget {
    pub(super) frontend: Duration,
    pub(super) admission: Duration,
}

impl BridgeBudget {
    pub(super) fn new(frontend: Duration) -> Self {
        Self {
            frontend,
            admission: PANE_CREATION_ADMISSION_TIMEOUT,
        }
    }
}

pub(super) async fn create_pane(
    state: &ServerState,
    method: &str,
    mut params: Value,
    mut interrupted: Pin<&mut impl Future<Output = AppError>>,
    budget: &mut BridgeBudget,
) -> Result<Value, (StatusCode, Json<Value>)> {
    loop {
        if let Some(reason) = interrupted.as_mut().now_or_never() {
            return Err((StatusCode::CONFLICT, Json(err_json(&reason.to_string()))));
        }
        let target = bridge_request_once(
            state,
            ("query", "panes", "resolveCreationTarget"),
            params.clone(),
            None,
            std::pin::pin!(std::future::pending()),
            budget,
        )
        .await?;
        if target.get("success").and_then(Value::as_bool) == Some(false) {
            return Ok(target);
        }
        let scope: PaneCreationTarget = serde_json::from_value(target).map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                Json(err_json("Invalid pane creation target from frontend")),
            )
        })?;
        // 이동한 인덱스나 활성 워크스페이스로 대상이 바뀌지 않게 슬롯 ID를 고정한다.
        let locator = params.as_object_mut().ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                Json(err_json("Invalid pane creation parameters")),
            )
        })?;
        locator.remove("paneIndex");
        locator.insert("paneId".into(), scope.slot_id.clone().into());
        locator.insert("workspaceId".into(), scope.workspace_id.clone().into());
        let result = bridge_request_once(
            state,
            ("action", "panes", method),
            params.clone(),
            Some(scope),
            interrupted.as_mut(),
            budget,
        )
        .await?;
        if result
            .get("retryPaneCreationTarget")
            .and_then(Value::as_bool)
            != Some(true)
        {
            return Ok(result);
        }
        // 슬롯 구성이 달라 실제 변경을 하지 않은 응답에서만 다시 승인한다.
    }
}

pub(crate) async fn bridge_interruption(
    state: &AppState,
    category: &str,
    target: &str,
    method: &str,
    cancelled: impl Future<Output = ()>,
) -> AppError {
    if !is_pane_creation(category, target, method) {
        return std::future::pending().await;
    }
    // 상태 검사 전에 구독해 종료가 시작됐다 취소되어도 기존 요청은 되살리지 않는다.
    let stopped = state.session_checkpoint.pane_creation_stopped.notified();
    if state.app_update.is_closing() || state.session_checkpoint.is_finalizing() {
        return AppError::SessionFinalizing;
    }
    tokio::select! {
        () = cancelled => AppError::PaneCreationCancelled,
        () = stopped => AppError::SessionFinalizing,
    }
}

pub(crate) async fn admit_bridge_mutation(
    runtime: &crate::session_checkpoint::SessionCheckpointRuntime,
    request_id: &str,
    (category, target, method): (&str, &str, &str),
    pane_scope: Option<(&[String], Duration)>,
    terminal_id: Option<&str>,
    interrupted: impl Future<Output = AppError>,
) -> Result<bool, String> {
    if category != "action" {
        return Ok(false);
    }
    // Exact allowlist: future structural/write actions keep the session fence.
    // Navigation is still tracked for updater drain through its frontend ACK.
    if let Some((ids, wait_budget)) = pane_scope {
        let admission = runtime.begin_pane_creation_after_eviction(request_id, ids, wait_budget);
        // 취소는 발행 전에만 적용한다. 전달된 action은 늦은 응답까지 추적한다.
        tokio::select! {
            biased;
            reason = interrupted => return Err(reason.into()),
            result = admission => result?,
        }
    } else if let ("terminals", "prepareForAutomation", Some(id)) = (target, method, terminal_id) {
        runtime.begin_detached_terminal_mutation(request_id, id)?;
    } else if matches!(
        (target, method),
        ("terminals", "setFocus")
            | ("workspaces", "switchActive")
            | ("grid", "focusPane")
            | (
                "navigation",
                "spatialStep" | "directionStep" | "notificationStep"
            )
            | ("notifications", "markRead" | "markTerminalRead")
    ) {
        runtime.begin_detached_navigation(request_id)?;
    } else {
        runtime.begin_detached_mutation(request_id)?;
    }
    Ok(true)
}

pub(super) fn emit_admitted_request(
    state: &AppState,
    request_id: &str,
    tracks_mutation: bool,
    interrupted: impl Future<Output = AppError>,
    emit: impl FnOnce() -> tauri::Result<()>,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    // 이 확인에서 발행이 시작된다. 전달된 요청은 늦은 응답까지 추적한다.
    let result = match interrupted.now_or_never() {
        Some(reason) => Err((StatusCode::CONFLICT, Json(err_json(&reason.to_string())))),
        None => emit().map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(err_json(&format!("Event emit error: {error}"))),
            )
        }),
    };
    if result.is_err() {
        if let Ok(mut channels) = state.automation_channels.lock_or_err() {
            channels.remove(request_id);
        }
        if tracks_mutation {
            let _ = state
                .session_checkpoint
                .finish_detached_mutation(request_id);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[tokio::test]
    async fn cancellation_after_admission_retires_both_registrations_before_emit() {
        let state = AppState::new();
        let id = "review-pane";
        let (cancel, signal) = tokio::sync::oneshot::channel();
        let cancelled = bridge_interruption(&state, "action", "panes", "stack", async {
            signal.await.unwrap()
        });
        tokio::pin!(cancelled);
        let tracked = admit_bridge_mutation(
            &state.session_checkpoint,
            id,
            ("action", "panes", "stack"),
            Some((&["source-terminal".into()], PANE_CREATION_ADMISSION_TIMEOUT)),
            None,
            cancelled.as_mut(),
        )
        .await
        .unwrap();
        let (reply, receiver) = tokio::sync::oneshot::channel();
        state
            .automation_channels
            .lock()
            .unwrap()
            .insert(id.into(), reply);
        cancel.send(()).unwrap();

        let emitted = Cell::new(false);
        let result = emit_admitted_request(&state, id, tracked, cancelled, || {
            emitted.set(true);
            Ok(())
        });
        assert!(
            !emitted.get(),
            "발행 직전에 취소한 pane 생성 요청이 전달됐다"
        );
        assert_eq!(result.unwrap_err().0, StatusCode::CONFLICT);
        assert!(!state.automation_channels.lock().unwrap().contains_key(id));
        assert!(receiver.await.is_err());
        assert!(!state
            .session_checkpoint
            .finish_detached_mutation(id)
            .unwrap());
    }
}
