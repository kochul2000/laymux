use super::{helpers::err_json, ServerState};
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use laymux_agent_hook::runtime::HookEvent;

pub async fn hook_states(State(state): State<ServerState>) -> impl IntoResponse {
    match tokio::task::spawn_blocking(move || {
        let settings = crate::settings::load_settings();
        let mut providers = Vec::new();
        if settings.claude.state_detection == crate::settings::AgentStateDetection::Hooks {
            providers.push("claude".into());
        }
        if settings.codex.state_detection == crate::settings::AgentStateDetection::Hooks {
            providers.push("codex".into());
        }
        crate::commands::get_agent_hook_states_impl(&providers, &state.app_state, &state.app_handle)
    })
    .await
    {
        Ok(Ok(value)) => (StatusCode::OK, Json(ok_json_data(serde_json::json!(value)))),
        result => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(err_json(&format!("{result:?}"))),
        ),
    }
}

fn ok_json_data(value: serde_json::Value) -> serde_json::Value {
    serde_json::json!({"success":true,"data":value})
}

pub async fn hook_updates(State(state): State<ServerState>) -> impl IntoResponse {
    match tokio::task::spawn_blocking(move || {
        crate::agent_hooks::updates::audit(&state.app_state, &state.app_handle)
    })
    .await
    {
        Ok(Ok(value)) => (StatusCode::OK, Json(ok_json_data(value))),
        result => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(err_json(&format!("{result:?}"))),
        ),
    }
}

pub async fn hook_event(
    State(state): State<ServerState>,
    Json(event): Json<HookEvent>,
) -> impl IntoResponse {
    match crate::agent_hooks::accept(&state.app_state, event) {
        Ok(()) => (StatusCode::OK, Json(ok_json_data(serde_json::json!({})))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(err_json(&e.to_string()))),
    }
}

pub async fn hook_connections(State(state): State<ServerState>) -> impl IntoResponse {
    match crate::agent_hooks::connections(&state.app_state) {
        Ok(value) => (StatusCode::OK, Json(ok_json_data(serde_json::json!(value)))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(err_json(&e.to_string())),
        ),
    }
}

pub async fn hook_environments() -> impl IntoResponse {
    match tokio::task::spawn_blocking(crate::agent_hooks::environments).await {
        Ok(Ok(value)) => (StatusCode::OK, Json(ok_json_data(serde_json::json!(value)))),
        result => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(err_json(&format!("{result:?}"))),
        ),
    }
}

pub async fn hook_manage(
    State(state): State<ServerState>,
    Json(request): Json<crate::agent_hooks::ManageRequest>,
) -> impl IntoResponse {
    match tokio::task::spawn_blocking(move || {
        crate::agent_hooks::manage(&request, &state.app_handle)
    })
    .await
    {
        Ok(Ok(value)) => (StatusCode::OK, Json(ok_json_data(value))),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, Json(err_json(&e.to_string()))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(err_json(&e.to_string())),
        ),
    }
}
