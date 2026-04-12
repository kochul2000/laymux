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

    Ok(out)
}

/// Strip ANSI escape sequences from terminal output, returning plain text.
///
/// Removes CSI sequences (`\x1b[...X`), OSC sequences (`\x1b]...ST`),
/// and other escape sequences. Preserves printable text content.
pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // ESC
            match chars.peek() {
                Some('[') => {
                    // CSI sequence: ESC [ ... (final byte 0x40-0x7E)
                    chars.next();
                    loop {
                        match chars.next() {
                            Some(c) if ('@'..='~').contains(&c) => break,
                            None => break,
                            _ => {}
                        }
                    }
                }
                Some(']') => {
                    // OSC sequence: ESC ] ... (terminated by BEL or ST)
                    chars.next();
                    loop {
                        match chars.next() {
                            Some('\x07') => break,        // BEL
                            Some('\x1b') => {              // possible ST (ESC \)
                                if chars.peek() == Some(&'\\') {
                                    chars.next();
                                }
                                break;
                            }
                            None => break,
                            _ => {}
                        }
                    }
                }
                Some('(' | ')' | '*' | '+') => {
                    // Designate character set: ESC ( X
                    chars.next();
                    chars.next(); // skip the charset designator
                }
                Some(_) => {
                    // Other two-char escape: ESC X
                    chars.next();
                }
                None => {}
            }
        } else if c < '\x20' && c != '\n' && c != '\r' && c != '\t' {
            // Skip other control characters (but keep newline, CR, tab)
        } else {
            out.push(c);
        }
    }

    out
}

/// Process C-style escape sequences in a string into actual control characters.
///
/// MCP clients pass tool parameters as literal text, so `\r\n` arrives as the
/// four characters `\`, `r`, `\`, `n` rather than CR+LF.  This function converts
/// common escape sequences to their real byte values before writing to the PTY.
///
/// Supported sequences: `\\`, `\r`, `\n`, `\t`, `\0`, `\uXXXX` (4-digit hex).
pub fn unescape_terminal_input(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();

    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('\\') => out.push('\\'),
                Some('r') => out.push('\r'),
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('0') => out.push('\0'),
                Some('u') => {
                    let hex: String = chars.by_ref().take(4).collect();
                    if hex.len() == 4 {
                        if let Ok(code) = u32::from_str_radix(&hex, 16) {
                            if let Some(ch) = char::from_u32(code) {
                                out.push(ch);
                                continue;
                            }
                        }
                    }
                    // Invalid sequence — emit as-is
                    out.push('\\');
                    out.push('u');
                    out.push_str(&hex);
                }
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
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

    #[test]
    fn unescape_cr_lf() {
        assert_eq!(unescape_terminal_input(r"ls\r\n"), "ls\r\n");
    }

    #[test]
    fn unescape_tab_and_null() {
        assert_eq!(unescape_terminal_input(r"a\tb\0c"), "a\tb\0c");
    }

    #[test]
    fn unescape_backslash() {
        assert_eq!(unescape_terminal_input(r"path\\file"), "path\\file");
    }

    #[test]
    fn unescape_unicode() {
        // \u0003 = ETX (Ctrl+C)
        assert_eq!(unescape_terminal_input(r"\u0003"), "\u{0003}");
    }

    #[test]
    fn unescape_unicode_korean() {
        assert_eq!(unescape_terminal_input(r"\uD55C"), "한");
    }

    #[test]
    fn unescape_no_escapes() {
        assert_eq!(unescape_terminal_input("hello world"), "hello world");
    }

    #[test]
    fn unescape_trailing_backslash() {
        assert_eq!(unescape_terminal_input(r"end\"), "end\\");
    }

    #[test]
    fn unescape_unknown_sequence_preserved() {
        assert_eq!(unescape_terminal_input(r"\x41"), "\\x41");
    }

    #[test]
    fn unescape_mixed() {
        assert_eq!(
            unescape_terminal_input(r"echo hello\r\n"),
            "echo hello\r\n"
        );
    }

    #[test]
    fn unescape_real_control_chars_pass_through() {
        // If the string already contains real CR+LF (from JSON deserialization),
        // they should pass through unchanged.
        assert_eq!(unescape_terminal_input("ls\r\n"), "ls\r\n");
    }

    #[test]
    fn strip_ansi_plain_text() {
        assert_eq!(strip_ansi("hello world"), "hello world");
    }

    #[test]
    fn strip_ansi_csi_sequences() {
        // Color codes, cursor movement
        assert_eq!(strip_ansi("\x1b[32mgreen\x1b[0m"), "green");
        assert_eq!(strip_ansi("\x1b[14;3Htext"), "text");
        assert_eq!(strip_ansi("\x1b[Kcleared"), "cleared");
    }

    #[test]
    fn strip_ansi_osc_sequences() {
        // Title setting (BEL terminated)
        assert_eq!(strip_ansi("\x1b]0;title\x07text"), "text");
        // ST terminated
        assert_eq!(strip_ansi("\x1b]0;title\x1b\\text"), "text");
    }

    #[test]
    fn strip_ansi_preserves_newlines() {
        assert_eq!(strip_ansi("line1\nline2\r\n"), "line1\nline2\r\n");
    }

    #[test]
    fn strip_ansi_mode_sequences() {
        assert_eq!(strip_ansi("\x1b[?25h\x1b[?2026hvisible"), "visible");
    }

    #[test]
    fn strip_ansi_utf8_korean() {
        assert_eq!(strip_ansi("안녕하세요"), "안녕하세요");
    }

    #[test]
    fn strip_ansi_utf8_with_escapes() {
        assert_eq!(strip_ansi("\x1b[32m한글\x1b[0m텍스트"), "한글텍스트");
    }

    #[test]
    fn strip_ansi_utf8_mixed() {
        assert_eq!(
            strip_ansi("hello \x1b[1m世界\x1b[0m 🌍"),
            "hello 世界 🌍"
        );
    }
}
