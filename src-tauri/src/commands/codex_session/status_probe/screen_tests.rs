use super::*;
use crate::terminal_output::TerminalGeometry;

const ID: &str = "01a0e103-7bcb-7a20-89c0-2dc0472f2957";
const NEW_ID: &str = "01a0e103-7bcb-7a20-89c0-2dc0472f2958";

fn checkpoint(data: String) -> TerminalRenderCheckpoint {
    TerminalRenderCheckpoint {
        generation: 3,
        seq: 100,
        geometry: TerminalGeometry {
            revision: 2,
            cols: 96,
            rows: 45,
        },
        data,
    }
}

fn card(id: &str) -> String {
    format!("/status\r\n╭────────╮\r\n│ >_ OpenAI Codex (v0.157.1) │\r\n│ Session: {id} │\r\n╰────────╯\r\n")
}

#[test]
fn reads_last_current_card_and_never_falls_back_to_an_older_card() {
    let previous = card(ID);
    let suffix = "\r\n› Ask Codex to do anything\r\n\r\n  Context 100% left";
    assert_eq!(
        parse_status_screen(&checkpoint(format!("{previous}{}{suffix}", card(NEW_ID)))),
        Some(NEW_ID.into())
    );
    for pending in [
        "/status\r\n╭─────╮\r\n│ >_ OpenAI Codex │\r\n",
        "› /status      show current session configuration\r\n\r\n› /statu\r\n",
        "Select Model and Effort\r\n› 1. model\r\n  enter select · esc cancel\r\n",
        "• Could not run /status\r\n",
    ] {
        assert_eq!(
            parse_status_screen(&checkpoint(format!("{previous}{pending}{suffix}"))),
            None,
            "{pending}"
        );
    }
    assert_eq!(
        parse_status_screen(&checkpoint(format!("{}{suffix}", card("01a0e103…")))),
        None
    );
    assert_eq!(
        parse_status_screen(&checkpoint(format!(
            "{}{suffix}",
            card(&format!("{ID} │\r\n│ Session: {NEW_ID}"))
        ))),
        None
    );
}

#[test]
fn rejects_pre_submit_stale_future_and_different_generation_or_geometry() {
    let mut screen = checkpoint(card(ID));
    let mut current = TerminalRenderCheckpointTarget {
        generation: 3,
        seq: 100,
        geometry: screen.geometry,
    };
    assert!(!is_current_screen(&screen, &current, 3, 100).unwrap());
    assert!(is_current_screen(&screen, &current, 3, 99).unwrap());
    current.seq = 101;
    assert!(!is_current_screen(&screen, &current, 3, 99).unwrap());
    current.seq = 99;
    assert!(is_current_screen(&screen, &current, 3, 98).is_err());
    current.seq = 100;
    assert!(is_current_screen(&screen, &current, 4, 99).is_err());
    screen.geometry.revision += 1;
    assert!(is_current_screen(&screen, &current, 3, 99).is_err());
    screen.geometry = current.geometry;
    screen.data = "x".repeat(MAX_SCREEN_BYTES + 1);
    assert!(is_current_screen(&screen, &current, 3, 99).is_err());
}

#[test]
fn captured_differential_response_keeps_the_id_in_the_current_screen() {
    for fixture in [
        include_str!("fixtures/native-status-current-screen.json"),
        include_str!("fixtures/wsl-status-current-screen.json"),
    ] {
        let fixture: serde_json::Value = serde_json::from_str(fixture).unwrap();
        let response: Vec<u8> = serde_json::from_value(fixture["response"].clone()).unwrap();
        assert_eq!(super::super::output::parse_status_session(&response), None);
        let mut selected = String::new();
        for (index, row) in fixture["selected"].as_array().unwrap().iter().enumerate() {
            selected.push_str(&format!("\x1b[{};1H{}", index + 1, row.as_str().unwrap()));
        }
        assert_eq!(parse_status_screen(&checkpoint(selected.clone())), None);
        selected.push_str(std::str::from_utf8(&response).unwrap());
        assert_eq!(
            parse_status_screen(&checkpoint(selected)),
            fixture["id"].as_str().map(str::to_owned)
        );
    }
}

#[test]
fn reads_the_actual_xterm_alternate_buffer_checkpoint() {
    let screen: TerminalRenderCheckpoint =
        serde_json::from_str(include_str!("fixtures/wsl-render-checkpoint.json")).unwrap();
    assert!(screen.data.contains("\x1b[?1049h"));
    assert_eq!(
        parse_status_screen(&screen),
        Some("01a0e6cb-9db1-7042-98bb-393800b4b7dd".into())
    );
}

#[test]
fn reads_codex_160_borderless_current_screen_in_native_and_wsl() {
    for fixture in [
        include_str!("fixtures/native-160-render-checkpoint.json"),
        include_str!("fixtures/wsl-160-render-checkpoint.json"),
        include_str!("fixtures/native-160-completed-render-checkpoint.json"),
        include_str!("fixtures/wsl-160-completed-render-checkpoint.json"),
    ] {
        let fixture: serde_json::Value = serde_json::from_str(fixture).unwrap();
        let screen: TerminalRenderCheckpoint =
            serde_json::from_value(fixture["screen"].clone()).unwrap();
        assert_eq!(
            parse_status_screen(&screen),
            fixture["id"].as_str().map(str::to_owned)
        );
    }
}

#[test]
fn reads_actual_codex_1601_background_server_status_response() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/native-1601-server-render-checkpoint.json"
    ))
    .unwrap();
    let screen: TerminalRenderCheckpoint =
        serde_json::from_value(fixture["screen"].clone()).unwrap();
    assert_eq!(
        parse_status_screen(&screen),
        fixture["id"].as_str().map(str::to_owned)
    );
}

#[test]
fn borderless_status_ignores_nonidentity_field_formatting() {
    let body = format!("/status\r\n>_ OpenAI Codex (v0.160.1)\r\nServer:              Local background server\r\nModel:               gpt\r\nDirectory:           /a/long/project/\r\n                     continued:directory\r\nPermissions:         Workspace (Ask for approval)\r\nThread name:         A long name\r\n                     continues here\r\nCollaboration mode:  Default\r\nSession:             {ID}\r\n");
    let suffix = "\r\n› Ask Codex to do anything\r\n\r\n? for shortcuts";
    assert_eq!(
        parse_status_screen(&checkpoint(format!("{body}{suffix}"))),
        Some(ID.into())
    );
    for invalid in [
        body.replace(
            "                     continues here",
            "Unexpected response after status",
        ),
        body.replace(
            "                     continues here",
            &format!("Session:             {NEW_ID}"),
        ),
    ] {
        assert_eq!(
            parse_status_screen(&checkpoint(format!("{invalid}{suffix}"))),
            None
        );
    }
    for compatible in [
        body.replace("Thread name:", "Future transport field:"),
        body.replace(
            "                     continues here",
            "                      differently aligned metadata",
        ),
    ] {
        assert_eq!(
            parse_status_screen(&checkpoint(format!("{compatible}{suffix}"))),
            Some(ID.into())
        );
    }
}

#[test]
fn borderless_card_rejects_ambiguous_identity_and_messages_after_response() {
    let body = format!("/status\r\n\r\n>_ OpenAI Codex (v0.160.0)\r\nModel: gpt\r\nDirectory: /project\r\nPermissions: Full Access\r\nCollaboration mode: Default\r\nSession: {ID}\r\nWeekly limit: unavailable\r\n");
    let suffix = "\r\n› Ask Codex to do anything\r\n\r\n? for shortcuts";
    assert_eq!(
        parse_status_screen(&checkpoint(format!("{body}{suffix}"))),
        Some(ID.into())
    );
    for invalid in [
        body.replace(
            &format!("Session: {ID}"),
            &format!("Session: {ID}\r\nSession: {NEW_ID}"),
        ),
        format!("{body}• Unexpected message\r\n"),
        format!("{} /status\r\nSession: {NEW_ID}\r\n", card(ID)),
    ] {
        assert_eq!(
            parse_status_screen(&checkpoint(format!("{invalid}{suffix}"))),
            None
        );
    }
}

#[test]
fn borderless_identity_is_independent_of_optional_fields_and_their_order() {
    let suffix = "\r\n› Ask Codex to do anything\r\n\r\n? for shortcuts";
    for fields in [
        format!("Session: {ID}\r\n"),
        format!("Transport: future mode\r\nSession: {ID}\r\nOptional diagnostic: \r\n"),
        format!("Collaboration mode: Default\r\nSession: {ID}\r\nPermissions: Full Access\r\nDirectory: /project\r\nModel: gpt\r\n"),
        format!("New field: first\r\nNew field: second\r\nSession: {ID}\r\n"),
        format!("Thread name: quoted Session: {NEW_ID}\r\nSession: {ID}\r\n"),
    ] {
        let body = format!("/status\r\n>_ OpenAI Codex (v0.170.0)\r\n{fields}{suffix}");
        assert_eq!(parse_status_screen(&checkpoint(body)), Some(ID.into()));
    }
}

#[test]
fn tolerant_metadata_never_relaxes_session_identity_or_current_response_scope() {
    let suffix = "\r\n› Ask Codex to do anything\r\n\r\n? for shortcuts";
    for fields in [
        format!("Session: {ID}\r\nSession: {ID}\r\n"),
        format!("Session: {ID}\r\nSession: {NEW_ID}\r\n"),
        "Session: 01a0e103…\r\n".into(),
        format!("Session: {ID} trailing text\r\n"),
        format!("Session: {ID}\r\n>_ OpenAI Codex (v0.170.0)\r\n"),
        format!("Session: {ID}\r\n• Could not run /status\r\n"),
    ] {
        let body = format!("/status\r\n>_ OpenAI Codex (v0.170.0)\r\n{fields}{suffix}");
        assert_eq!(parse_status_screen(&checkpoint(body)), None);
    }
}
