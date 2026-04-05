use std::time::Duration;

use axum::http::StatusCode;
use axum::Json;
use tauri::Emitter;

use crate::constants::*;
use crate::lock_ext::MutexExt;

use super::types::AutomationRequest;
use super::ServerState;

/// Send a request to the frontend via Tauri event and wait for the response.
pub async fn bridge_request(
    state: &ServerState,
    category: &str,
    target: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, (StatusCode, Json<serde_json::Value>)> {
    let request_id = uuid::Uuid::new_v4().to_string();

    let (tx, rx) = tokio::sync::oneshot::channel();

    // Store the channel
    {
        let mut channels = state
            .app_state
            .automation_channels
            .lock_or_err()
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(err_json("Lock error")),
                )
            })?;
        channels.insert(request_id.clone(), tx);
    }

    // Emit event to frontend
    let request = AutomationRequest {
        request_id: request_id.clone(),
        category: category.into(),
        target: target.into(),
        method: method.into(),
        params,
    };

    state
        .app_handle
        .emit(EVENT_AUTOMATION_REQUEST, &request)
        .map_err(|e| {
            // Clean up channel on emit failure
            if let Ok(mut channels) = state.app_state.automation_channels.lock_or_err() {
                channels.remove(&request_id);
            }
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(err_json(&format!("Event emit error: {e}"))),
            )
        })?;

    // Wait for response with timeout
    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(data)) => Ok(data),
        Ok(Err(_)) => {
            // Channel dropped without response — clean up orphaned entry
            if let Ok(mut channels) = state.app_state.automation_channels.lock_or_err() {
                channels.remove(&request_id);
            }
            Err((
                StatusCode::SERVICE_UNAVAILABLE,
                Json(err_json("Frontend bridge not connected")),
            ))
        }
        Err(_) => {
            // Timeout
            if let Ok(mut channels) = state.app_state.automation_channels.lock_or_err() {
                channels.remove(&request_id);
            }
            Err((
                StatusCode::GATEWAY_TIMEOUT,
                Json(err_json("Frontend response timeout")),
            ))
        }
    }
}

pub fn ok_json(msg: &str) -> serde_json::Value {
    serde_json::json!({ "success": true, "message": msg })
}

pub fn err_json(msg: &str) -> serde_json::Value {
    serde_json::json!({ "success": false, "error": msg })
}

/// Simple base64 decoder (no external crate needed).
pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    fn val(c: u8) -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("Invalid base64 char: {c}")),
        }
    }

    let input: Vec<u8> = input
        .bytes()
        .filter(|&b| b != b'\n' && b != b'\r' && b != b' ')
        .collect();
    let mut out = Vec::with_capacity(input.len() * 3 / 4);

    let chunks = input.chunks(4);
    for chunk in chunks {
        let len = chunk.iter().filter(|&&b| b != b'=').count();
        if len < 2 {
            break;
        }

        let a = val(chunk[0])?;
        let b = val(chunk[1])?;
        out.push((a << 2) | (b >> 4));

        if len > 2 {
            let c = val(chunk[2])?;
            out.push((b << 4) | (c >> 2));
            if len > 3 {
                let d = val(chunk[3])?;
                out.push((c << 6) | d);
            }
        }
    }

    let _ = TABLE; // suppress unused warning
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ok_json_format() {
        let j = ok_json("done");
        assert_eq!(j["success"], true);
        assert_eq!(j["message"], "done");
    }

    #[test]
    fn err_json_format() {
        let j = err_json("fail");
        assert_eq!(j["success"], false);
        assert_eq!(j["error"], "fail");
    }

    #[test]
    fn base64_decode_simple() {
        let encoded = "SGVsbG8="; // "Hello"
        let decoded = base64_decode(encoded).unwrap();
        assert_eq!(decoded, b"Hello");
    }

    #[test]
    fn base64_decode_no_padding() {
        let encoded = "SGk"; // "Hi"
        let decoded = base64_decode(encoded).unwrap();
        assert_eq!(decoded, b"Hi");
    }
}
