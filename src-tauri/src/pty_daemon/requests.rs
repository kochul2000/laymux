use crate::daemon_protocol::AttachmentStamp;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Authentication {
    pub proof: Vec<u8>,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    Attach,
    Read {
        request_id: u64,
        stamp: AttachmentStamp,
        query: ReadCommand,
    },
    Call {
        request_id: u64,
        stamp: AttachmentStamp,
        command: Command,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ReadCommand {
    CancelPhysical {
        operation_id: String,
    },
    Ping,
    Catalog,
    Checkpoint {
        terminal_id: String,
        generation: u64,
    },
    Output {
        terminal_id: String,
        generation: u64,
        since_seq: Option<u64>,
        geometry_revision: Option<u64>,
    },
    Drained,
    Attributions {
        claude_max_age_hours: Option<u64>,
        codex_max_age_hours: Option<u64>,
        grok_max_age_hours: Option<u64>,
    },
    #[cfg(test)]
    Delay {
        milliseconds: u64,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Command {
    Configure {
        settings: Box<crate::settings::Settings>,
    },
    Physical {
        operation_id: String,
        terminal_id: String,
        generation: u64,
        expires_at: u64,
        action: PhysicalAction,
    },
    Ping,
    Catalog,
    Create {
        spec: CreateTerminal,
    },
    Write {
        terminal_id: String,
        generation: u64,
        data: Vec<u8>,
    },
    Resize {
        terminal_id: String,
        generation: u64,
        cols: u16,
        rows: u16,
    },
    Checkpoint {
        terminal_id: String,
        generation: u64,
    },
    Close {
        terminal_id: String,
        generation: u64,
    },
    Detach,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum PhysicalAction {
    Write { data: Vec<u8>, submit: bool },
    Resize { cols: u16, rows: u16 },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateTerminal {
    pub id: String,
    pub profile: String,
    pub cols: u16,
    pub rows: u16,
    pub sync_group: String,
    pub cwd_send: Option<bool>,
    pub cwd_receive: Option<bool>,
    pub cwd: Option<String>,
    pub startup_command_override: Option<String>,
    pub viewer: Option<crate::commands::ViewerStartupRequest>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Response {
    pub request_id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
