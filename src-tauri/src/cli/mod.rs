pub mod cli;

use serde::{Deserialize, Serialize};

/// Represents a message sent from the `lx` CLI to the IDE backend via socket.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "action")]
pub enum LxMessage {
    #[serde(rename = "sync-cwd")]
    SyncCwd {
        path: String,
        terminal_id: String,
        group_id: String,
        #[serde(default)]
        all: bool,
        #[serde(default)]
        target_group: Option<String>,
    },
    #[serde(rename = "sync-branch")]
    SyncBranch {
        branch: String,
        terminal_id: String,
        group_id: String,
    },
    #[serde(rename = "notify")]
    Notify {
        message: String,
        terminal_id: String,
        #[serde(default)]
        level: Option<String>,
    },
    #[serde(rename = "set-tab-title")]
    SetTabTitle { title: String, terminal_id: String },
    #[serde(rename = "get-cwd")]
    GetCwd { terminal_id: String },
    #[serde(rename = "get-branch")]
    GetBranch { terminal_id: String },
    #[serde(rename = "send-command")]
    SendCommand { command: String, group: String },
    #[serde(rename = "open-file")]
    OpenFile { path: String, terminal_id: String },
    #[serde(rename = "set-command-status")]
    SetCommandStatus {
        terminal_id: String,
        #[serde(default)]
        command: Option<String>,
        #[serde(default)]
        exit_code: Option<i32>,
    },
    #[serde(rename = "set-wsl-distro")]
    SetWslDistro { path: String, terminal_id: String },
}

/// Response from the IDE to the `lx` CLI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LxResponse {
    pub success: bool,
    pub data: Option<String>,
    pub error: Option<String>,
}

impl LxResponse {
    pub fn ok(data: Option<String>) -> Self {
        Self {
            success: true,
            data,
            error: None,
        }
    }

    pub fn err(message: String) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_sync_cwd_message() {
        let msg = LxMessage::SyncCwd {
            path: "/home/user/project".into(),
            terminal_id: "t1".into(),
            group_id: "g1".into(),
            all: false,
            target_group: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"action\":\"sync-cwd\""));
        assert!(json.contains("\"path\":\"/home/user/project\""));
    }

    #[test]
    fn deserialize_sync_cwd_message() {
        let json =
            r#"{"action":"sync-cwd","path":"/foo","terminal_id":"t1","group_id":"g1","all":false}"#;
        let msg: LxMessage = serde_json::from_str(json).unwrap();
        match msg {
            LxMessage::SyncCwd {
                path,
                terminal_id,
                group_id,
                all,
                target_group,
            } => {
                assert_eq!(path, "/foo");
                assert_eq!(terminal_id, "t1");
                assert_eq!(group_id, "g1");
                assert!(!all);
                assert!(target_group.is_none());
            }
            _ => panic!("Expected SyncCwd"),
        }
    }

    #[test]
    fn serialize_notify_message() {
        let msg = LxMessage::Notify {
            message: "Build complete".into(),
            terminal_id: "t1".into(),
            level: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"action\":\"notify\""));
        assert!(json.contains("\"message\":\"Build complete\""));
    }

    #[test]
    fn serialize_notify_with_level() {
        let msg = LxMessage::Notify {
            message: "Build failed".into(),
            terminal_id: "t1".into(),
            level: Some("error".into()),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"level\":\"error\""));
    }

    #[test]
    fn deserialize_notify_with_level() {
        let json = r#"{"action":"notify","message":"fail","terminal_id":"t1","level":"error"}"#;
        let msg: LxMessage = serde_json::from_str(json).unwrap();
        match msg {
            LxMessage::Notify { message, level, .. } => {
                assert_eq!(message, "fail");
                assert_eq!(level, Some("error".into()));
            }
            _ => panic!("Expected Notify"),
        }
    }

    #[test]
    fn deserialize_notify_without_level() {
        let json = r#"{"action":"notify","message":"ok","terminal_id":"t1"}"#;
        let msg: LxMessage = serde_json::from_str(json).unwrap();
        match msg {
            LxMessage::Notify { level, .. } => {
                assert_eq!(level, None);
            }
            _ => panic!("Expected Notify"),
        }
    }

    #[test]
    fn serialize_send_command_message() {
        let msg = LxMessage::SendCommand {
            command: "cd /foo".into(),
            group: "project-a".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"action\":\"send-command\""));
    }

    #[test]
    fn response_ok() {
        let resp = LxResponse::ok(Some("done".into()));
        assert!(resp.success);
        assert_eq!(resp.data, Some("done".into()));
        assert!(resp.error.is_none());
    }

    #[test]
    fn response_err() {
        let resp = LxResponse::err("not found".into());
        assert!(!resp.success);
        assert!(resp.data.is_none());
        assert_eq!(resp.error, Some("not found".into()));
    }

    #[test]
    fn round_trip_all_message_types() {
        let messages = vec![
            LxMessage::SyncCwd {
                path: "/p".into(),
                terminal_id: "t".into(),
                group_id: "g".into(),
                all: true,
                target_group: Some("other".into()),
            },
            LxMessage::SyncBranch {
                branch: "main".into(),
                terminal_id: "t".into(),
                group_id: "g".into(),
            },
            LxMessage::Notify {
                message: "hi".into(),
                terminal_id: "t".into(),
                level: None,
            },
            LxMessage::SetTabTitle {
                title: "Tab".into(),
                terminal_id: "t".into(),
            },
            LxMessage::GetCwd {
                terminal_id: "t".into(),
            },
            LxMessage::GetBranch {
                terminal_id: "t".into(),
            },
            LxMessage::SendCommand {
                command: "ls".into(),
                group: "g".into(),
            },
            LxMessage::OpenFile {
                path: "/foo/bar.rs".into(),
                terminal_id: "t".into(),
            },
            LxMessage::SetCommandStatus {
                terminal_id: "t".into(),
                command: Some("npm test".into()),
                exit_code: Some(0),
            },
            LxMessage::SetCommandStatus {
                terminal_id: "t".into(),
                command: Some("npm build".into()),
                exit_code: None,
            },
            LxMessage::SetCommandStatus {
                terminal_id: "t".into(),
                command: None,
                exit_code: Some(1),
            },
        ];

        for msg in messages {
            let json = serde_json::to_string(&msg).unwrap();
            let parsed: LxMessage = serde_json::from_str(&json).unwrap();
            assert_eq!(msg, parsed);
        }
    }

    #[test]
    fn serialize_open_file_message() {
        let msg = LxMessage::OpenFile {
            path: "/home/user/main.rs".into(),
            terminal_id: "t1".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"action\":\"open-file\""));
        assert!(json.contains("\"path\":\"/home/user/main.rs\""));
    }

    #[test]
    fn serialize_set_command_status() {
        let msg = LxMessage::SetCommandStatus {
            terminal_id: "t1".into(),
            command: Some("npm test".into()),
            exit_code: Some(0),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"action\":\"set-command-status\""));
        assert!(json.contains("\"command\":\"npm test\""));
        assert!(json.contains("\"exit_code\":0"));
    }

    #[test]
    fn deserialize_set_command_status_partial() {
        let json = r#"{"action":"set-command-status","terminal_id":"t1","command":"npm build"}"#;
        let msg: LxMessage = serde_json::from_str(json).unwrap();
        match msg {
            LxMessage::SetCommandStatus {
                command, exit_code, ..
            } => {
                assert_eq!(command, Some("npm build".into()));
                assert_eq!(exit_code, None);
            }
            _ => panic!("Expected SetCommandStatus"),
        }
    }

    #[test]
    fn deserialize_set_command_status_exit_only() {
        let json = r#"{"action":"set-command-status","terminal_id":"t1","exit_code":1}"#;
        let msg: LxMessage = serde_json::from_str(json).unwrap();
        match msg {
            LxMessage::SetCommandStatus {
                command, exit_code, ..
            } => {
                assert_eq!(command, None);
                assert_eq!(exit_code, Some(1));
            }
            _ => panic!("Expected SetCommandStatus"),
        }
    }

    #[test]
    fn deserialize_open_file_message() {
        let json = r#"{"action":"open-file","path":"/foo.rs","terminal_id":"t1"}"#;
        let msg: LxMessage = serde_json::from_str(json).unwrap();
        match msg {
            LxMessage::OpenFile { path, terminal_id } => {
                assert_eq!(path, "/foo.rs");
                assert_eq!(terminal_id, "t1");
            }
            _ => panic!("Expected OpenFile"),
        }
    }
}
