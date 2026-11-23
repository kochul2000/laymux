use std::future::Future;
use std::time::Duration;

use axum::{http::StatusCode, Json};
use futures_util::FutureExt;

use super::err_json;
use crate::error::AppError;
use crate::lock_ext::MutexExt;
use crate::state::AppState;

// 승인 대기와 전달 후 응답을 합친 예산은 최대 15초다 (ADR-0388).
const PANE_CREATION_ADMISSION_TIMEOUT: Duration = Duration::from_secs(10);

fn is_pane_creation(category: &str, target: &str, method: &str) -> bool {
    category == "action" && target == "panes" && matches!(method, "split" | "stack")
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
    category: &str,
    target: &str,
    method: &str,
    interrupted: impl Future<Output = AppError>,
) -> Result<bool, String> {
    if category != "action" {
        return Ok(false);
    }
    // Exact allowlist: future structural/write actions keep the session fence.
    // Navigation is still tracked for updater drain through its frontend ACK.
    if is_pane_creation(category, target, method) {
        let admission =
            runtime.begin_pane_creation_after_eviction(request_id, PANE_CREATION_ADMISSION_TIMEOUT);
        // 취소는 발행 전에만 적용한다. 전달된 action은 늦은 응답까지 추적한다.
        tokio::select! {
            biased;
            reason = interrupted => return Err(reason.into()),
            result = admission => result?,
        }
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
            "action",
            "panes",
            "stack",
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
