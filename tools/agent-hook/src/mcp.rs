//! Laymux MCP server registration in agent CLI user configuration (ADR-0325).
//! The server name is the ownership boundary: only that entry is written or
//! removed, and every other byte of the configuration is preserved.
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use indexmap::IndexMap;
use serde_json::value::RawValue;
use serde_json::{json, Value};
use toml_edit::{DocumentMut, InlineTable, Item, Table};

use crate::install::{atomic_write, lock_config_dir, read_limited};

// `.claude.json` keeps per-project history and can grow far beyond hook files.
const MAX_CONFIG_BYTES: u64 = 64 * 1024 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_millis(700);
// Codex refuses to load any config whose HTTP server keeps stdio-only fields.
const STDIO_FIELDS: &[&str] = &["command", "args", "env", "env_vars", "cwd"];

type RawMap = IndexMap<String, Box<RawValue>>;

/// Config file for `provider`. `dir` is the CLI configuration folder with the
/// same meaning as `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`GROK_HOME`; when absent the
/// variable of this process, then the user default, is used.
pub fn config_path(provider: &str, dir: Option<&Path>) -> Result<PathBuf, String> {
    let (key, default, file) = match provider {
        "claude" => ("CLAUDE_CONFIG_DIR", "", ".claude.json"),
        "codex" => ("CODEX_HOME", ".codex", "config.toml"),
        "grok" => ("GROK_HOME", ".grok", "config.toml"),
        _ => return Err("Unsupported MCP provider".into()),
    };
    let env = |key: &str| {
        std::env::var_os(key)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    let dir = match dir.map(Path::to_path_buf).or_else(|| env(key)) {
        Some(dir) => dir,
        None => env(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .ok_or("User home unavailable")?
            .join(default),
    };
    Ok(dir.join(file))
}

pub fn is_valid_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    name.len() <= 32
        && bytes.next().is_some_and(|b| b.is_ascii_lowercase())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Resolve the Laymux URL reachable from this environment. Native hosts use
/// loopback; WSL tries loopback (mirrored networking) and the Windows host.
pub fn resolve_url(port: u16) -> Option<String> {
    if !is_wsl() {
        return Some(url_for("127.0.0.1", port));
    }
    let mut hosts = vec![Ipv4Addr::LOCALHOST];
    hosts.extend(default_gateway());
    hosts.extend(nameserver());
    hosts.dedup();
    hosts
        .into_iter()
        .find(|host| probe(*host, port))
        .map(|host| url_for(&host.to_string(), port))
}

fn url_for(host: &str, port: u16) -> String {
    format!("http://{host}:{port}/mcp")
}

fn is_wsl() -> bool {
    cfg!(target_os = "linux")
        && (std::env::var_os("WSL_DISTRO_NAME").is_some()
            || std::fs::read_to_string("/proc/sys/kernel/osrelease")
                .is_ok_and(|s| s.to_ascii_lowercase().contains("microsoft")))
}

fn default_gateway() -> Option<Ipv4Addr> {
    parse_default_gateway(&std::fs::read_to_string("/proc/net/route").ok()?)
}

fn parse_default_gateway(table: &str) -> Option<Ipv4Addr> {
    table.lines().skip(1).find_map(|line| {
        let fields: Vec<_> = line.split_whitespace().collect();
        (fields.get(1) == Some(&"00000000"))
            .then(|| u32::from_str_radix(fields.get(2)?, 16).ok())
            .flatten()
            .filter(|gateway| *gateway != 0)
            .map(|gateway| Ipv4Addr::from(gateway.to_le_bytes()))
    })
}

fn nameserver() -> Option<Ipv4Addr> {
    std::fs::read_to_string("/etc/resolv.conf")
        .ok()?
        .lines()
        .find_map(|line| line.trim().strip_prefix("nameserver")?.trim().parse().ok())
}

fn probe(host: Ipv4Addr, port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&SocketAddr::from((host, port)), PROBE_TIMEOUT)
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(PROBE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(PROBE_TIMEOUT));
    let request = format!("GET /api/v1/health HTTP/1.0\r\nHost: {host}:{port}\r\n\r\n");
    let mut head = [0u8; 16];
    stream.write_all(request.as_bytes()).is_ok()
        && stream.read(&mut head).is_ok_and(|n| {
            let head = &head[..n];
            head.starts_with(b"HTTP/1.") && head.get(9..12) == Some(b"200")
        })
}

#[derive(Debug, Default, PartialEq)]
struct Entry {
    url: Option<String>,
    /// Not a plain HTTP registration: stdio fields remain or Claude's `type`
    /// is not `http`. Installing rewrites it even when the URL matches.
    mismatch: bool,
    disabled: bool,
}

enum Config {
    Claude(RawMap),
    Toml(DocumentMut),
}

fn strip_bom(raw: &[u8]) -> &[u8] {
    raw.strip_prefix(b"\xef\xbb\xbf").unwrap_or(raw)
}

fn parse(provider: &str, raw: Option<&[u8]>) -> Result<Config, String> {
    let raw = strip_bom(raw.unwrap_or_default());
    if provider == "claude" {
        if raw.iter().all(u8::is_ascii_whitespace) {
            return Ok(Config::Claude(RawMap::new()));
        }
        let map: RawMap =
            serde_json::from_slice(raw).map_err(|e| format!("Invalid .claude.json: {e}"))?;
        claude_servers(&map)?;
        return Ok(Config::Claude(map));
    }
    let text = std::str::from_utf8(raw).map_err(|e| e.to_string())?;
    let doc: DocumentMut = text
        .parse()
        .map_err(|e| format!("Invalid config.toml: {e}"))?;
    if let Some(servers) = doc.get("mcp_servers") {
        if !servers.is_table_like() {
            return Err("mcp_servers must be a table".into());
        }
    }
    Ok(Config::Toml(doc))
}

fn claude_servers(map: &RawMap) -> Result<RawMap, String> {
    match map.get("mcpServers") {
        None => Ok(RawMap::new()),
        Some(raw) => {
            serde_json::from_str(raw.get()).map_err(|_| "mcpServers must be an object".into())
        }
    }
}

fn entry(config: &Config, name: &str) -> Result<Option<Entry>, String> {
    match config {
        Config::Claude(map) => {
            let Some(raw) = claude_servers(map)?.shift_remove(name) else {
                return Ok(None);
            };
            let value: Value = serde_json::from_str(raw.get()).map_err(|e| e.to_string())?;
            let server = value
                .as_object()
                .ok_or("MCP server entry must be an object")?;
            Ok(Some(Entry {
                url: server.get("url").and_then(Value::as_str).map(Into::into),
                // Claude treats an entry without `type` as stdio.
                mismatch: server.get("type").and_then(Value::as_str) != Some("http")
                    || STDIO_FIELDS.iter().any(|key| server.contains_key(*key)),
                disabled: false,
            }))
        }
        Config::Toml(doc) => {
            let Some(item) = doc.get("mcp_servers").and_then(|s| s.get(name)) else {
                return Ok(None);
            };
            let server = item
                .as_table_like()
                .ok_or("MCP server entry must be a table")?;
            let listed_disabled = doc
                .get("disabled_mcp_servers")
                .and_then(Item::as_array)
                .is_some_and(|names| names.iter().any(|v| v.as_str() == Some(name)));
            Ok(Some(Entry {
                url: server.get("url").and_then(Item::as_str).map(Into::into),
                mismatch: STDIO_FIELDS.iter().any(|key| server.contains_key(key)),
                disabled: listed_disabled
                    || server.get("enabled").and_then(Item::as_bool) == Some(false),
            }))
        }
    }
}

fn set_entry(config: &mut Config, name: &str, url: &str) -> Result<(), String> {
    match config {
        Config::Claude(map) => {
            let mut servers = claude_servers(map)?;
            let mut server: RawMap = servers
                .get(name)
                .map(|raw| serde_json::from_str(raw.get()))
                .transpose()
                .map_err(|_| "MCP server entry must be an object")?
                .unwrap_or_default();
            for key in STDIO_FIELDS {
                server.shift_remove(*key);
            }
            server.insert("type".into(), raw_json(&json!("http"))?);
            server.insert("url".into(), raw_json(&json!(url))?);
            servers.insert(name.into(), render_object(&server, 2)?);
            map.insert("mcpServers".into(), render_object(&servers, 1)?);
            Ok(())
        }
        Config::Toml(doc) => {
            if doc.get("mcp_servers").is_none() {
                let mut servers = Table::new();
                servers.set_implicit(true);
                doc.insert("mcp_servers", Item::Table(servers));
            }
            let servers = &mut doc["mcp_servers"];
            if let Some(servers) = servers.as_table_mut() {
                let server = servers
                    .entry(name)
                    .or_insert_with(|| Item::Table(Table::new()));
                let server = server
                    .as_table_like_mut()
                    .ok_or("MCP server entry must be a table")?;
                for key in STDIO_FIELDS {
                    server.remove(key);
                }
                server.insert("url", toml_edit::value(url));
            } else {
                let servers = servers
                    .as_inline_table_mut()
                    .ok_or("mcp_servers must be a table")?;
                let server = servers
                    .entry(name)
                    .or_insert_with(|| InlineTable::new().into());
                let server = server
                    .as_inline_table_mut()
                    .ok_or("MCP server entry must be a table")?;
                for key in STDIO_FIELDS {
                    server.remove(key);
                }
                server.insert("url", url.into());
            }
            Ok(())
        }
    }
}

fn remove_entry(config: &mut Config, name: &str) -> Result<(), String> {
    match config {
        Config::Claude(map) => {
            let mut servers = claude_servers(map)?;
            servers.shift_remove(name);
            map.insert("mcpServers".into(), render_object(&servers, 1)?);
            Ok(())
        }
        Config::Toml(doc) => {
            if let Some(servers) = doc.get_mut("mcp_servers").and_then(Item::as_table_like_mut) {
                servers.remove(name);
            }
            Ok(())
        }
    }
}

fn raw_json(value: &Value) -> Result<Box<RawValue>, String> {
    RawValue::from_string(value.to_string()).map_err(|e| e.to_string())
}

/// Render an object at `depth` of a two-space pretty document, as Claude Code
/// writes it. Raw members are emitted verbatim, keeping their original layout.
fn render_object(map: &RawMap, depth: usize) -> Result<Box<RawValue>, String> {
    if map.is_empty() {
        return raw_json(&json!({}));
    }
    let pad = "  ".repeat(depth + 1);
    let members = map
        .iter()
        .map(|(key, value)| format!("{pad}{}: {}", Value::from(key.as_str()), value.get()))
        .collect::<Vec<_>>();
    RawValue::from_string(format!(
        "{{\n{}\n{}}}",
        members.join(",\n"),
        "  ".repeat(depth)
    ))
    .map_err(|e| e.to_string())
}

fn render(config: &Config, original: Option<&[u8]>) -> Result<Vec<u8>, String> {
    match config {
        Config::Claude(map) => {
            let mut bytes = serde_json::to_vec_pretty(map).map_err(|e| e.to_string())?;
            if original.is_none_or(|raw| raw.ends_with(b"\n")) {
                bytes.push(b'\n');
            }
            Ok(bytes)
        }
        Config::Toml(doc) => Ok(doc.to_string().into_bytes()),
    }
}

fn status(
    path: &Path,
    provider: &str,
    name: &str,
    url: Option<&str>,
    entry: Option<Entry>,
) -> Value {
    let current = entry.as_ref().and_then(|e| e.url.as_deref());
    let state = match (&entry, url) {
        (None, _) => "missing",
        // Laymux is unreachable right now, so the address cannot be judged.
        (Some(_), None) => "unverified",
        (Some(e), Some(url)) if current == Some(url) && !e.mismatch => "installed",
        _ => "different",
    };
    json!({
        "provider": provider,
        "configPath": path,
        "name": name,
        "url": url,
        "currentUrl": current,
        "state": state,
        "installed": state == "installed",
        "disabled": entry.as_ref().is_some_and(|e| e.disabled),
        "reachable": url.is_some(),
    })
}

pub fn manage(
    provider: &str,
    operation: &str,
    name: &str,
    port: u16,
    dir: Option<&Path>,
) -> Result<Value, String> {
    if dir.is_some_and(|dir| !dir.is_absolute()) {
        return Err("Configuration folder must be an absolute path".into());
    }
    let path = config_path(provider, dir)?;
    manage_at(
        &path,
        provider,
        operation,
        name,
        resolve_url(port).as_deref(),
    )
}

pub fn manage_at(
    path: &Path,
    provider: &str,
    operation: &str,
    name: &str,
    url: Option<&str>,
) -> Result<Value, String> {
    if !matches!(provider, "claude" | "codex" | "grok")
        || !matches!(operation, "status" | "install" | "remove")
        || !is_valid_name(name)
        || !path.is_absolute()
    {
        return Err("Invalid MCP registration request".into());
    }
    let original = read_limited(path, MAX_CONFIG_BYTES)?;
    let mut config = parse(provider, original.as_deref())?;
    let before = entry(&config, name)?;
    let current = status(path, provider, name, url, before);
    let changed = match operation {
        "install" if current["installed"] == true => false,
        "install" => {
            let url = url.ok_or("Laymux is not reachable from this environment")?;
            set_entry(&mut config, name, url)?;
            true
        }
        "remove" => {
            let present = current["state"] != "missing";
            if present {
                remove_entry(&mut config, name)?;
            }
            present
        }
        _ => false,
    };
    if !changed {
        return Ok(current);
    }
    let bytes = render(&config, original.as_deref())?;
    // Prove the rendered document parses and carries the change before writing.
    let result = status(
        path,
        provider,
        name,
        url,
        entry(&parse(provider, Some(&bytes))?, name)?,
    );
    let applied = match operation {
        "install" => result["installed"] == true,
        _ => result["state"] == "missing",
    };
    if !applied {
        return Err("Rendered settings did not apply the change; nothing was written".into());
    }
    let parent = path.parent().ok_or("Missing config parent")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    // `config.toml` folders are shared with the hook installer (Codex title
    // binding). Claude Code rewrites `.claude.json` without any lock, so the
    // comparison right before the replacement is its only guard.
    let _lock = if provider == "claude" {
        None
    } else {
        Some(lock_config_dir(parent)?)
    };
    if let Some(original) = &original {
        let mut backup = path.as_os_str().to_owned();
        backup.push(".laymux-backup");
        atomic_write(Path::new(&backup), original)?;
    }
    if read_limited(path, MAX_CONFIG_BYTES)? != original {
        return Err("Agent settings changed concurrently; retry".into());
    }
    atomic_write(path, &bytes)?;
    Ok(result)
}

#[cfg(test)]
mod tests;
