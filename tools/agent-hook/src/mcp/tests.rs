use super::*;

const URL: &str = "http://127.0.0.1:19280/mcp";

fn fixture(name: &str, content: Option<&str>) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(name);
    if let Some(content) = content {
        std::fs::write(&path, content).unwrap();
    }
    (dir, path)
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

#[test]
fn claude_install_preserves_key_order_and_foreign_servers_then_removes_only_owned() {
    let original = "{\n  \"numStartups\": 3,\n  \"mcpServers\": {\n    \"other\": {\n      \"command\": \"npx\"\n    }\n  },\n  \"aardvark\": {\n    \"z\": 1,\n    \"a\": 2\n  }\n}";
    let (_dir, path) = fixture(".claude.json", Some(original));

    let status = manage_at(&path, "claude", "status", "laymux", Some(URL)).unwrap();
    assert_eq!(status["state"], "missing");

    let status = manage_at(&path, "claude", "install", "laymux", Some(URL)).unwrap();
    assert_eq!(status["state"], "installed");
    // Key order, indentation and the missing trailing newline all survive.
    let installed = original.replace(
        "\"npx\"\n    }\n",
        &format!("\"npx\"\n    }},\n    \"laymux\": {{\n      \"type\": \"http\",\n      \"url\": \"{URL}\"\n    }}\n"),
    );
    assert_eq!(read(&path), installed);
    let backup = path.with_file_name(".claude.json.laymux-backup");
    assert_eq!(read(&backup), original);

    let status = manage_at(&path, "claude", "remove", "laymux", Some(URL)).unwrap();
    assert_eq!(status["state"], "missing");
    assert_eq!(read(&path), original);
}

#[test]
fn claude_creates_missing_file_and_replaces_stdio_or_stale_entry() {
    let (_dir, path) = fixture(".claude.json", None);
    manage_at(&path, "claude", "install", "laymux-dev", Some(URL)).unwrap();
    assert!(read(&path).ends_with('\n'));

    let (_dir, path) = fixture(
        ".claude.json",
        Some(r#"{"mcpServers":{"laymux":{"command":"proxy","args":["x"],"timeout":5}}}"#),
    );
    let status = manage_at(&path, "claude", "status", "laymux", Some(URL)).unwrap();
    assert_eq!(status["state"], "different");
    manage_at(&path, "claude", "install", "laymux", Some(URL)).unwrap();
    let value: Value = serde_json::from_str(&read(&path)).unwrap();
    assert_eq!(
        value["mcpServers"]["laymux"],
        json!({"type":"http","url":URL,"timeout":5})
    );
}

#[test]
fn codex_install_updates_url_and_keeps_tool_approvals_and_comments() {
    let original = "# user comment\nmodel = \"gpt\"\n\n[mcp_servers.laymux]\nurl = \"http://172.20.0.1:19280/mcp\"\n\n[mcp_servers.laymux.tools.get_grid_state]\napproval_mode = \"approve\"\n\n[mcp_servers.other]\ncommand = \"npx\"\n";
    let (_dir, path) = fixture("config.toml", Some(original));
    let status = manage_at(&path, "codex", "status", "laymux", Some(URL)).unwrap();
    assert_eq!(status["state"], "different");
    assert_eq!(status["currentUrl"], "http://172.20.0.1:19280/mcp");

    manage_at(&path, "codex", "install", "laymux", Some(URL)).unwrap();
    let text = read(&path);
    assert_eq!(text, original.replace("172.20.0.1", "127.0.0.1"));

    manage_at(&path, "codex", "remove", "laymux", Some(URL)).unwrap();
    assert_eq!(
        read(&path),
        "# user comment\nmodel = \"gpt\"\n\n[mcp_servers.other]\ncommand = \"npx\"\n"
    );
}

#[test]
fn toml_install_appends_new_server_without_empty_parent_header() {
    let (_dir, path) = fixture("config.toml", Some("[models]\ndefault = \"grok\"\n"));
    let status = manage_at(&path, "grok", "install", "laymux", Some(URL)).unwrap();
    assert_eq!(status["installed"], true);
    assert_eq!(
        read(&path),
        format!("[models]\ndefault = \"grok\"\n\n[mcp_servers.laymux]\nurl = \"{URL}\"\n")
    );

    let (_dir, path) = fixture(
        "config.toml",
        Some("mcp_servers = { laymux = { command = \"x\" } }\n"),
    );
    manage_at(&path, "codex", "install", "laymux", Some(URL)).unwrap();
    assert_eq!(
        read(&path),
        format!("mcp_servers = {{ laymux = {{ url = \"{URL}\" }} }}\n")
    );
}

#[test]
fn disabled_servers_are_reported_but_not_changed() {
    let original =
        format!("disabled_mcp_servers = [\"laymux\"]\n\n[mcp_servers.laymux]\nurl = \"{URL}\"\n");
    let (_dir, path) = fixture("config.toml", Some(&original));
    let status = manage_at(&path, "grok", "install", "laymux", Some(URL)).unwrap();
    assert_eq!(status["installed"], true);
    assert_eq!(status["disabled"], true);
    assert_eq!(read(&path), original);

    let (_dir, path) = fixture(
        "config.toml",
        Some(&format!(
            "[mcp_servers.laymux]\nurl = \"{URL}\"\nenabled = false\n"
        )),
    );
    let status = manage_at(&path, "codex", "status", "laymux", Some(URL)).unwrap();
    assert_eq!(status["disabled"], true);
}

#[test]
fn unreachable_or_malformed_configs_are_never_written() {
    let (_dir, path) = fixture("config.toml", Some("model = \"x\"\n"));
    let error = manage_at(&path, "codex", "install", "laymux", None).unwrap_err();
    assert!(error.contains("not reachable"));
    assert_eq!(read(&path), "model = \"x\"\n");

    for (name, provider, content) in [
        (".claude.json", "claude", "{broken"),
        (".claude.json", "claude", "[]"),
        (".claude.json", "claude", r#"{"mcpServers":[]}"#),
        ("config.toml", "codex", "mcp_servers = 1\n"),
        ("config.toml", "grok", "[broken\n"),
    ] {
        let (_dir, path) = fixture(name, Some(content));
        assert!(manage_at(&path, provider, "install", "laymux", Some(URL)).is_err());
        assert_eq!(read(&path), content);
    }
    let (_dir, path) = fixture("config.toml", None);
    for name in ["", "Laymux", "1x", "a b", "x\"y"] {
        assert!(manage_at(&path, "codex", "install", name, Some(URL)).is_err());
    }
}

#[test]
fn wsl_gateway_is_parsed_from_the_route_table() {
    let table = "Iface\tDestination\tGateway \tFlags\nveth\tAC140000\t00000000\t0001\neth0\t00000000\t0100A8C0\t0003\n";
    assert_eq!(
        parse_default_gateway(table),
        Some(Ipv4Addr::new(192, 168, 0, 1))
    );
    assert_eq!(parse_default_gateway("Iface\tDestination\tGateway\n"), None);
}

#[test]
fn codex_stdio_only_fields_are_removed_because_codex_rejects_them_on_http() {
    let original = format!(
        "[mcp_servers.laymux]\nurl = \"{URL}\"\ncwd = \"C:/x\"\nenv_vars = [\"A\"]\nstartup_timeout_sec = 9\n"
    );
    let (_dir, path) = fixture("config.toml", Some(&original));
    let status = manage_at(&path, "codex", "status", "laymux", Some(URL)).unwrap();
    assert_eq!(status["state"], "different");
    manage_at(&path, "codex", "install", "laymux", Some(URL)).unwrap();
    assert_eq!(
        read(&path),
        format!("[mcp_servers.laymux]\nurl = \"{URL}\"\nstartup_timeout_sec = 9\n")
    );
}

#[test]
fn claude_entry_must_be_http_typed_object() {
    for server in [
        format!(r#"{{"url":"{URL}"}}"#),
        format!(r#"{{"type":"sse","url":"{URL}"}}"#),
    ] {
        let (_dir, path) = fixture(
            ".claude.json",
            Some(&format!(r#"{{"mcpServers":{{"laymux":{server}}}}}"#)),
        );
        let status = manage_at(&path, "claude", "status", "laymux", Some(URL)).unwrap();
        assert_eq!(status["state"], "different", "{server}");
        let status = manage_at(&path, "claude", "install", "laymux", Some(URL)).unwrap();
        assert_eq!(status["installed"], true);
        let value: Value = serde_json::from_str(&read(&path)).unwrap();
        assert_eq!(value["mcpServers"]["laymux"]["type"], "http");
    }

    let original = r#"{"mcpServers":{"laymux":"oops"}}"#;
    let (_dir, path) = fixture(".claude.json", Some(original));
    assert!(manage_at(&path, "claude", "install", "laymux", Some(URL))
        .unwrap_err()
        .contains("must be an object"));
    assert_eq!(read(&path), original);
}

#[test]
fn unreachable_laymux_keeps_registered_entry_unverified_and_removable() {
    let original = format!("[mcp_servers.laymux]\nurl = \"{URL}\"\n");
    let (_dir, path) = fixture("config.toml", Some(&original));
    let status = manage_at(&path, "grok", "status", "laymux", None).unwrap();
    assert_eq!(status["state"], "unverified");
    assert_eq!(status["currentUrl"], URL);
    let status = manage_at(&path, "grok", "remove", "laymux", None).unwrap();
    assert_eq!(status["state"], "missing");
    assert_eq!(read(&path), "");
}

#[test]
fn toml_writes_share_the_hook_installer_lock() {
    let (dir, path) = fixture("config.toml", Some("model = \"x\"\n"));
    let lock = crate::install::lock_config_dir(dir.path()).unwrap();
    assert!(manage_at(&path, "codex", "install", "laymux", Some(URL))
        .unwrap_err()
        .contains("in progress"));
    assert_eq!(read(&path), "model = \"x\"\n");
    drop(lock);
    manage_at(&path, "codex", "install", "laymux", Some(URL)).unwrap();
}

#[test]
fn explicit_config_directory_overrides_environment_defaults() {
    let dir = Path::new(if cfg!(windows) { "C:/agent" } else { "/agent" });
    assert_eq!(
        config_path("claude", Some(dir)).unwrap(),
        dir.join(".claude.json")
    );
    assert_eq!(
        config_path("codex", Some(dir)).unwrap(),
        dir.join("config.toml")
    );
    assert_eq!(
        config_path("grok", Some(dir)).unwrap(),
        dir.join("config.toml")
    );
    assert!(manage("codex", "status", "laymux", 1, Some(Path::new("relative"))).is_err());
}

#[test]
fn refused_replacement_keeps_file_and_previous_backup() {
    let (_dir, path) = fixture("config.toml", Some("model = \"new\"\n"));
    let backup = path.with_file_name("config.toml.laymux-backup");
    std::fs::write(&backup, "previous backup").unwrap();
    // Rendered from an original that is no longer on disk.
    let error = replace_if_unchanged(&path, Some(b"model = \"old\"\n"), b"x").unwrap_err();
    assert!(error.contains("concurrently"));
    assert_eq!(read(&path), "model = \"new\"\n");
    assert_eq!(read(&backup), "previous backup");
    let leftovers = std::fs::read_dir(path.parent().unwrap()).unwrap().count();
    assert_eq!(leftovers, 2, "staged temp files must be cleaned up");
}
