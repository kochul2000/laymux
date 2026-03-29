use std::env;
use std::io::{BufRead, Write};

use super::{LxMessage, LxResponse};

/// Parse command-line args into an LxMessage.
pub fn parse_args(args: &[String]) -> Result<LxMessage, String> {
    if args.is_empty() {
        return Err("No command provided. Usage: lx <command> [args...]".into());
    }

    let terminal_id = env::var("LX_TERMINAL_ID").unwrap_or_default();
    let group_id = env::var("LX_GROUP_ID").unwrap_or_default();

    match args[0].as_str() {
        "sync-cwd" => {
            let path = args.get(1).cloned().unwrap_or_else(|| {
                env::current_dir()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default()
            });
            let all = args.contains(&"--all".to_string());
            let target_group = args
                .iter()
                .position(|a| a == "--group")
                .and_then(|i| args.get(i + 1))
                .cloned();

            Ok(LxMessage::SyncCwd {
                path,
                terminal_id,
                group_id,
                all,
                target_group,
            })
        }
        "sync-branch" => {
            let branch = args.get(1).cloned().unwrap_or_default();
            Ok(LxMessage::SyncBranch {
                branch,
                terminal_id,
                group_id,
            })
        }
        "notify" => {
            let level_pos = args.iter().position(|a| a == "--level");
            let level = level_pos
                .and_then(|i| args.get(i + 1))
                .cloned();
            // Collect message parts, skipping --level and its value
            let message_parts: Vec<&str> = args[1..]
                .iter()
                .enumerate()
                .filter(|(i, _)| {
                    let abs = i + 1; // offset from original args
                    if let Some(lp) = level_pos {
                        abs != lp && abs != lp + 1
                    } else {
                        true
                    }
                })
                .map(|(_, s)| s.as_str())
                .collect();
            let message = message_parts.join(" ");
            Ok(LxMessage::Notify {
                message,
                terminal_id,
                level,
            })
        }
        "set-tab-title" => {
            let title = args[1..].join(" ");
            Ok(LxMessage::SetTabTitle {
                title,
                terminal_id,
            })
        }
        "get-cwd" => Ok(LxMessage::GetCwd { terminal_id }),
        "get-branch" => Ok(LxMessage::GetBranch { terminal_id }),
        "get-terminal-id" => {
            // This is a local command, no IPC needed
            println!("{terminal_id}");
            std::process::exit(0);
        }
        "send-command" => {
            let command = args.get(1).cloned().unwrap_or_default();
            let group = args
                .iter()
                .position(|a| a == "--group")
                .and_then(|i| args.get(i + 1))
                .cloned()
                .unwrap_or(group_id);

            Ok(LxMessage::SendCommand { command, group })
        }
        "open-file" => {
            let path = args.get(1).cloned().unwrap_or_default();
            Ok(LxMessage::OpenFile {
                path,
                terminal_id,
            })
        }
        "set-command-status" => {
            let command_pos = args.iter().position(|a| a == "--command");
            let command = command_pos
                .and_then(|i| args.get(i + 1))
                .cloned();

            let exit_code_pos = args.iter().position(|a| a == "--exit-code");
            let exit_code = exit_code_pos
                .and_then(|i| args.get(i + 1))
                .and_then(|v| v.parse::<i32>().ok());

            Ok(LxMessage::SetCommandStatus {
                terminal_id,
                command,
                exit_code,
            })
        }
        other => Err(format!("Unknown command: {other}")),
    }
}

/// Send a message to the IDE via the IPC socket and return the response.
pub fn send_message<R: BufRead, W: Write>(
    message: &LxMessage,
    reader: &mut R,
    writer: &mut W,
) -> Result<LxResponse, String> {
    let json = serde_json::to_string(message).map_err(|e| format!("Serialize error: {e}"))?;
    writeln!(writer, "{json}").map_err(|e| format!("Write error: {e}"))?;
    writer.flush().map_err(|e| format!("Flush error: {e}"))?;

    let mut response_line = String::new();
    reader
        .read_line(&mut response_line)
        .map_err(|e| format!("Read error: {e}"))?;

    serde_json::from_str(response_line.trim())
        .map_err(|e| format!("Response parse error: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    #[test]
    fn parse_sync_cwd() {
        let args = vec!["sync-cwd".into(), "/home/user".into()];
        let msg = parse_args(&args).unwrap();
        match msg {
            LxMessage::SyncCwd { path, all, .. } => {
                assert_eq!(path, "/home/user");
                assert!(!all);
            }
            _ => panic!("Expected SyncCwd"),
        }
    }

    #[test]
    fn parse_sync_cwd_all() {
        let args = vec!["sync-cwd".into(), "/tmp".into(), "--all".into()];
        let msg = parse_args(&args).unwrap();
        match msg {
            LxMessage::SyncCwd { all, .. } => assert!(all),
            _ => panic!("Expected SyncCwd"),
        }
    }

    #[test]
    fn parse_sync_cwd_group() {
        let args = vec![
            "sync-cwd".into(),
            "/tmp".into(),
            "--group".into(),
            "mygroup".into(),
        ];
        let msg = parse_args(&args).unwrap();
        match msg {
            LxMessage::SyncCwd { target_group, .. } => {
                assert_eq!(target_group, Some("mygroup".into()));
            }
            _ => panic!("Expected SyncCwd"),
        }
    }

    #[test]
    fn parse_sync_branch() {
        let args = vec!["sync-branch".into(), "main".into()];
        let msg = parse_args(&args).unwrap();
        match msg {
            LxMessage::SyncBranch { branch, .. } => assert_eq!(branch, "main"),
            _ => panic!("Expected SyncBranch"),
        }
    }

    #[test]
    fn parse_notify() {
        let args = vec!["notify".into(), "Build".into(), "done".into()];
        let msg = parse_args(&args).unwrap();
        match msg {
            LxMessage::Notify { message, .. } => assert_eq!(message, "Build done"),
            _ => panic!("Expected Notify"),
        }
    }

    #[test]
    fn parse_notify_with_level() {
        let args = vec![
            "notify".into(),
            "--level".into(),
            "error".into(),
            "Build".into(),
            "failed".into(),
        ];
        let msg = parse_args(&args).unwrap();
        match msg {
            LxMessage::Notify { message, level, .. } => {
                assert_eq!(message, "Build failed");
                assert_eq!(level, Some("error".into()));
            }
            _ => panic!("Expected Notify"),
        }
    }

    #[test]
    fn parse_notify_without_level() {
        let args = vec!["notify".into(), "Build".into(), "done".into()];
        let msg = parse_args(&args).unwrap();
        match msg {
            LxMessage::Notify { message, level, .. } => {
                assert_eq!(message, "Build done");
                assert_eq!(level, None);
            }
            _ => panic!("Expected Notify"),
        }
    }

    #[test]
    fn parse_notify_level_at_end() {
        let args = vec![
            "notify".into(),
            "Build".into(),
            "failed".into(),
            "--level".into(),
            "error".into(),
        ];
        let msg = parse_args(&args).unwrap();
        match msg {
            LxMessage::Notify { message, level, .. } => {
                assert_eq!(message, "Build failed");
                assert_eq!(level, Some("error".into()));
            }
            _ => panic!("Expected Notify"),
        }
    }

    #[test]
    fn parse_set_tab_title() {
        let args = vec!["set-tab-title".into(), "My".into(), "Terminal".into()];
        let msg = parse_args(&args).unwrap();
        match msg {
            LxMessage::SetTabTitle { title, .. } => assert_eq!(title, "My Terminal"),
            _ => panic!("Expected SetTabTitle"),
        }
    }

    #[test]
    fn parse_get_cwd() {
        let args = vec!["get-cwd".into()];
        let msg = parse_args(&args).unwrap();
        assert!(matches!(msg, LxMessage::GetCwd { .. }));
    }

    #[test]
    fn parse_get_branch() {
        let args = vec!["get-branch".into()];
        let msg = parse_args(&args).unwrap();
        assert!(matches!(msg, LxMessage::GetBranch { .. }));
    }

    #[test]
    fn parse_send_command() {
        let args = vec![
            "send-command".into(),
            "ls -la".into(),
            "--group".into(),
            "dev".into(),
        ];
        let msg = parse_args(&args).unwrap();
        match msg {
            LxMessage::SendCommand { command, group } => {
                assert_eq!(command, "ls -la");
                assert_eq!(group, "dev");
            }
            _ => panic!("Expected SendCommand"),
        }
    }

    #[test]
    fn parse_open_file() {
        let args = vec!["open-file".into(), "/home/user/main.rs".into()];
        let msg = parse_args(&args).unwrap();
        match msg {
            LxMessage::OpenFile { path, .. } => assert_eq!(path, "/home/user/main.rs"),
            _ => panic!("Expected OpenFile"),
        }
    }

    #[test]
    fn parse_set_command_status_with_command() {
        let args = vec![
            "set-command-status".into(),
            "--command".into(),
            "npm test".into(),
        ];
        let msg = parse_args(&args).unwrap();
        match msg {
            LxMessage::SetCommandStatus { command, exit_code, .. } => {
                assert_eq!(command, Some("npm test".into()));
                assert_eq!(exit_code, None);
            }
            _ => panic!("Expected SetCommandStatus"),
        }
    }

    #[test]
    fn parse_set_command_status_with_exit_code() {
        let args = vec![
            "set-command-status".into(),
            "--exit-code".into(),
            "0".into(),
        ];
        let msg = parse_args(&args).unwrap();
        match msg {
            LxMessage::SetCommandStatus { command, exit_code, .. } => {
                assert_eq!(command, None);
                assert_eq!(exit_code, Some(0));
            }
            _ => panic!("Expected SetCommandStatus"),
        }
    }

    #[test]
    fn parse_set_command_status_both() {
        let args = vec![
            "set-command-status".into(),
            "--command".into(),
            "npm build".into(),
            "--exit-code".into(),
            "1".into(),
        ];
        let msg = parse_args(&args).unwrap();
        match msg {
            LxMessage::SetCommandStatus { command, exit_code, .. } => {
                assert_eq!(command, Some("npm build".into()));
                assert_eq!(exit_code, Some(1));
            }
            _ => panic!("Expected SetCommandStatus"),
        }
    }

    #[test]
    fn parse_unknown_command() {
        let args = vec!["foobar".into()];
        assert!(parse_args(&args).is_err());
    }

    #[test]
    fn parse_empty_args() {
        let args: Vec<String> = vec![];
        assert!(parse_args(&args).is_err());
    }

    #[test]
    fn send_message_round_trip() {
        use std::io::Cursor;

        let message = LxMessage::Notify {
            message: "test".into(),
            terminal_id: "t1".into(),
            level: None,
        };

        let response = LxResponse::ok(Some("ok".into()));
        let response_json = serde_json::to_string(&response).unwrap();

        let mut reader = BufReader::new(Cursor::new(format!("{response_json}\n")));
        let mut writer = Vec::new();

        let result = send_message(&message, &mut reader, &mut writer).unwrap();
        assert!(result.success);
        assert_eq!(result.data, Some("ok".into()));

        // Verify what was written
        let written = String::from_utf8(writer).unwrap();
        let parsed: LxMessage = serde_json::from_str(written.trim()).unwrap();
        assert!(matches!(parsed, LxMessage::Notify { .. }));
    }
}
