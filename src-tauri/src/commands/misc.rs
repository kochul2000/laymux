use std::sync::Arc;
use tauri::State;

use crate::activity;
use crate::automation_server::AutomationResponse;
use crate::constants::*;
use crate::lock_ext::MutexExt;
use crate::state::AppState;
use crate::terminal::{TerminalActivity, TerminalNotification, TerminalStateInfo};

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to Laymux.", name)
}

#[tauri::command]
pub fn get_automation_info(state: State<Arc<AppState>>) -> Result<serde_json::Value, String> {
    let port = state.automation_port.lock_or_err()?.unwrap_or(0);

    Ok(serde_json::json!({
        "port": port,
    }))
}

#[tauri::command]
pub fn get_sync_group_terminals(
    group_name: String,
    state: State<Arc<AppState>>,
) -> Result<Vec<String>, String> {
    let groups = state.sync_groups.lock_or_err()?;

    Ok(groups
        .get(&group_name)
        .map(|g| g.terminal_ids.clone())
        .unwrap_or_default())
}

/// Checks whether a font is monospace by reading the `post` table's `isFixedPitch` field.
/// Falls back to comparing advance widths of 'i' and 'M'.
/// CJK-aware monospace fonts (e.g. JetBrainsMonoBigHangul) may set isFixedPitch=0
/// because they use half-width/full-width proportions, so we always verify with advance widths.
fn is_monospace(font: &font_kit::font::Font) -> bool {
    // Quick accept: if the post table says it's fixed-pitch, trust it
    if let Some(post_data) = font.load_font_table(u32::from_be_bytes(*b"post")) {
        let post: &[u8] = post_data.as_ref();
        if post.len() >= 16 {
            let is_fixed = u32::from_be_bytes([post[12], post[13], post[14], post[15]]);
            if is_fixed != 0 {
                return true;
            }
        }
    }
    // Fallback / CJK-aware check: compare advance widths of narrow vs wide Latin characters
    let glyphs: Vec<f32> = ['i', 'M']
        .iter()
        .filter_map(|&c| {
            let gid = font.glyph_for_char(c)?;
            font.advance(gid).ok().map(|v| v.x())
        })
        .collect();
    glyphs.len() == 2 && (glyphs[0] - glyphs[1]).abs() < 1.0
}

#[tauri::command]
pub fn list_system_monospace_fonts() -> Result<Vec<String>, String> {
    use font_kit::source::SystemSource;
    let source = SystemSource::new();
    let families = source
        .all_families()
        .map_err(|e| format!("Failed to enumerate system fonts: {e}"))?;

    let mut result: Vec<String> = families
        .into_iter()
        .filter(|name| {
            source
                .select_family_by_name(name)
                .ok()
                .and_then(|fh| fh.fonts().first().cloned())
                .and_then(|h| h.load().ok())
                .map(|f| is_monospace(&f))
                .unwrap_or(false)
        })
        .collect();

    result.sort_unstable_by_key(|a| a.to_lowercase());
    result.dedup();
    Ok(result)
}

#[tauri::command]
pub fn load_settings() -> Result<crate::settings::Settings, String> {
    Ok(crate::settings::load_settings())
}

#[tauri::command]
pub fn load_settings_validated() -> Result<crate::settings::SettingsLoadResult, String> {
    Ok(crate::settings::load_settings_validated())
}

#[tauri::command]
pub fn reset_settings() -> Result<crate::settings::Settings, String> {
    let default_settings = crate::settings::Settings::default();
    crate::settings::save_settings(&default_settings)?;
    Ok(default_settings)
}

#[tauri::command]
pub fn get_settings_path() -> Result<String, String> {
    Ok(crate::settings::settings_path().display().to_string())
}

#[tauri::command]
pub fn save_settings(settings: crate::settings::Settings) -> Result<(), String> {
    crate::settings::save_settings(&settings)
}

#[tauri::command]
pub fn load_memo(key: String) -> Result<String, String> {
    Ok(crate::settings::load_memo(&key))
}

#[tauri::command]
pub fn save_memo(key: String, content: String) -> Result<(), String> {
    crate::settings::save_memo(&key, &content)
}

/// Split an `issueReporter.shell` prefix into tokens, respecting single and double quotes.
/// Unmatched trailing quotes treat the rest of the string as one token.
/// Note: backslash escapes (e.g. `\"`) are NOT supported.
fn split_shell_prefix(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut chars = input.chars().peekable();
    while let Some(&ch) = chars.peek() {
        match ch {
            ' ' | '\t' => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
                chars.next();
            }
            '"' | '\'' => {
                let quote = ch;
                chars.next(); // consume opening quote
                while let Some(&c) = chars.peek() {
                    if c == quote {
                        chars.next(); // consume closing quote
                        break;
                    }
                    current.push(c);
                    chars.next();
                }
            }
            _ => {
                current.push(ch);
                chars.next();
            }
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// Build a `std::process::Command` for `gh`, optionally wrapped by a shell prefix.
/// When `shell_prefix` is empty, gh is invoked directly.
/// When set (e.g. `wsl.exe -d "My Distro" --`), gh is invoked as:
///   `wsl.exe -d "My Distro" -- gh {args...}`
/// Supports single/double-quoted arguments in the prefix.
fn build_gh_command(shell_prefix: &str) -> std::process::Command {
    let parts = split_shell_prefix(shell_prefix);
    if parts.is_empty() {
        crate::process::headless_command("gh")
    } else {
        let mut cmd = crate::process::headless_command(&parts[0]);
        for part in &parts[1..] {
            cmd.arg(part);
        }
        cmd.arg("gh");
        cmd
    }
}

/// Build a `gh` CLI command that runs without a visible console window on Windows.
fn gh_command(shell_prefix: &str) -> std::process::Command {
    build_gh_command(shell_prefix)
}

/// Upload a screenshot to the GitHub repo via the contents API.
/// Returns the raw download URL of the uploaded image.
fn upload_screenshot_to_github(
    path: &std::path::Path,
    shell_prefix: &str,
) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read screenshot: {e}"))?;
    let b64 = super::base64_encode(&bytes);

    let filename = path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "screenshot.png".to_string());

    // Get repo name
    let repo_out = gh_command(shell_prefix)
        .args([
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "-q",
            ".nameWithOwner",
        ])
        .output()
        .map_err(|e| format!("gh repo view failed: {e}"))?;
    if !repo_out.status.success() {
        return Err("Not in a GitHub repo or gh not configured".into());
    }
    let repo = String::from_utf8_lossy(&repo_out.stdout).trim().to_string();

    // Write JSON body to temp file (avoids command-line length limits)
    let json_body = format!(r#"{{"message":"Upload issue screenshot","content":"{b64}"}}"#);
    let temp_path = std::env::temp_dir().join("laymux_gh_upload.json");
    std::fs::write(&temp_path, &json_body)
        .map_err(|e| format!("Failed to write temp file: {e}"))?;

    // Upload via GitHub contents API
    let api_path = format!("repos/{repo}/contents/.github/issue-screenshots/{filename}");
    let upload_out = gh_command(shell_prefix)
        .args([
            "api",
            &api_path,
            "-X",
            "PUT",
            "--input",
            &temp_path.to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("gh api upload failed: {e}"))?;

    let _ = std::fs::remove_file(&temp_path);

    if !upload_out.status.success() {
        let stderr = String::from_utf8_lossy(&upload_out.stderr)
            .trim()
            .to_string();
        return Err(format!("GitHub upload failed: {stderr}"));
    }

    // Use github.com/raw/ URL format — works for both public and private repos
    // (authenticated users who have repo access can view the image)
    Ok(format!(
        "https://github.com/{repo}/raw/main/.github/issue-screenshots/{filename}"
    ))
}

#[tauri::command]
pub async fn submit_github_issue(
    title: String,
    body: String,
    screenshot_path: Option<String>,
    issue_number: Option<u64>,
) -> Result<String, String> {
    let settings = crate::settings::load_settings();
    let shell_prefix = &settings.issue_reporter.shell;
    let mut full_body = body;

    // Upload screenshot to GitHub and embed the image in the body
    if let Some(ref path_str) = screenshot_path {
        let p = std::path::Path::new(path_str);
        if p.exists() {
            match upload_screenshot_to_github(p, shell_prefix) {
                Ok(image_url) => {
                    full_body = format!("{full_body}\n\n![Screenshot]({image_url})");
                }
                Err(e) => {
                    full_body = format!("{full_body}\n\n_Screenshot upload failed: {e}_");
                }
            }
        }
    }

    if let Some(num) = issue_number {
        // Update existing issue
        let num_str = num.to_string();
        let output = gh_command(shell_prefix)
            .args([
                "issue", "edit", &num_str, "--title", &title, "--body", &full_body,
            ])
            .output()
            .map_err(|e| {
                format!("Failed to run gh CLI: {e}. Is gh installed and authenticated?")
            })?;

        if output.status.success() {
            // gh issue edit outputs the issue URL to stdout
            let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if url.is_empty() {
                // Some gh versions don't output URL on edit; construct it
                let repo_url = get_repo_url(shell_prefix).unwrap_or_default();
                Ok(format!("{repo_url}/issues/{num}"))
            } else {
                Ok(url)
            }
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(format!("gh issue edit failed: {stderr}"))
        }
    } else {
        // Create new issue
        let output = gh_command(shell_prefix)
            .args(["issue", "create", "--title", &title, "--body", &full_body])
            .output()
            .map_err(|e| {
                format!("Failed to run gh CLI: {e}. Is gh installed and authenticated?")
            })?;

        if output.status.success() {
            let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(url)
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(format!("gh issue create failed: {stderr}"))
        }
    }
}

/// Get the GitHub repo URL (e.g., https://github.com/owner/repo)
fn get_repo_url(shell_prefix: &str) -> Result<String, String> {
    let output = gh_command(shell_prefix)
        .args(["repo", "view", "--json", "url", "-q", ".url"])
        .output()
        .map_err(|e| format!("gh repo view failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err("Failed to get repo URL".into())
    }
}

#[tauri::command]
pub fn get_listening_ports() -> Vec<crate::port_detect::ListeningPort> {
    crate::port_detect::get_listening_ports()
}

#[tauri::command]
pub fn get_git_branch(working_dir: String) -> Option<String> {
    let path = std::path::Path::new(&working_dir);
    let git_dir = crate::git_watcher::find_git_dir(path)?;
    crate::git_watcher::read_git_branch(&git_dir)
}

#[tauri::command]
pub fn send_os_notification(title: String, body: String) -> Result<(), String> {
    // OS notification via the system's built-in mechanism.
    // On Windows, uses tauri notification or powershell toast.
    #[cfg(target_os = "windows")]
    {
        let _ = crate::process::headless_command("powershell")
            .args([
                "-Command",
                &format!(
                    "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; \
                     $n = New-Object System.Windows.Forms.NotifyIcon; \
                     $n.Icon = [System.Drawing.SystemIcons]::Information; \
                     $n.Visible = $true; \
                     $n.ShowBalloonTip(5000, '{}', '{}', 'Info'); \
                     Start-Sleep -Seconds 5; \
                     $n.Dispose()",
                    title.replace('\'', "''"),
                    body.replace('\'', "''"),
                ),
            ])
            .spawn();
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("notify-send")
            .args([&title, &body])
            .spawn();
        Ok(())
    }
}

#[tauri::command]
pub fn automation_response(
    response_json: String,
    state: State<Arc<AppState>>,
) -> Result<(), String> {
    let response: AutomationResponse =
        serde_json::from_str(&response_json).map_err(|e| format!("Parse error: {e}"))?;

    let tx = {
        let mut channels = state.automation_channels.lock_or_err()?;
        channels.remove(&response.request_id)
    };

    if let Some(tx) = tx {
        let value = if response.success {
            response.data.unwrap_or(serde_json::Value::Null)
        } else {
            serde_json::json!({
                "success": false,
                "error": response.error.unwrap_or_default(),
            })
        };
        let _ = tx.send(value);
    }

    Ok(())
}

/// Tauri command: get terminal state for all terminals.
#[tauri::command]
pub fn get_terminal_states(
    state: State<Arc<AppState>>,
) -> std::collections::HashMap<String, TerminalStateInfo> {
    activity::detect_all_terminal_states(&state)
}

/// Tauri command: get CWD for all terminals from backend (single source of truth).
/// Returns a map of terminal_id → normalized CWD path.
#[tauri::command]
pub fn get_terminal_cwds(
    state: State<Arc<AppState>>,
) -> Result<std::collections::HashMap<String, String>, String> {
    get_terminal_cwds_inner(&state)
}

pub fn get_terminal_cwds_inner(
    state: &AppState,
) -> Result<std::collections::HashMap<String, String>, String> {
    let terminals = state.terminals.lock_or_err()?;
    let mut result = std::collections::HashMap::new();
    for (id, session) in terminals.iter() {
        if let Some(ref cwd) = session.cwd {
            result.insert(id.clone(), cwd.clone());
        }
    }
    Ok(result)
}

/// Response for a single terminal in `get_terminal_summaries`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSummaryResponse {
    pub id: String,
    pub profile: String,
    pub title: String,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub last_command: Option<String>,
    pub last_exit_code: Option<i32>,
    pub last_command_at: Option<u64>,
    pub command_running: bool,
    pub activity: TerminalActivity,
    pub is_claude: bool,
    pub claude_message: Option<String>,
    pub unread_notification_count: u32,
    pub latest_notification: Option<TerminalNotification>,
}

/// Tauri command: get comprehensive summary for requested terminals (single source of truth).
/// Returns all data needed to render WorkspaceSelectorView for the given terminal IDs.
///
/// Lock order: terminals → output_buffers → known_claude_terminals → notifications
/// (see `AppState` doc for the canonical ordering).
#[tauri::command]
pub fn get_terminal_summaries(
    terminal_ids: Vec<String>,
    state: State<Arc<AppState>>,
) -> Result<Vec<TerminalSummaryResponse>, String> {
    get_terminal_summaries_inner(&terminal_ids, &state)
}

/// Core implementation of `get_terminal_summaries` without Tauri State wrapper.
/// Used by both the Tauri command and tests.
///
/// Lock order: terminals → output_buffers → known_claude_terminals → notifications
/// (see `AppState` doc for the canonical ordering).
pub fn get_terminal_summaries_inner(
    terminal_ids: &[String],
    state: &AppState,
) -> Result<Vec<TerminalSummaryResponse>, String> {
    let terminals = state.terminals.lock_or_err()?;
    let buffers = state.output_buffers.lock_or_err()?;
    let known_claude = state.known_claude_terminals.lock_or_err()?;
    let notifications = state.notifications.lock_or_err()?;

    let mut result = Vec::with_capacity(terminal_ids.len());

    for tid in terminal_ids {
        let Some(session) = terminals.get(tid.as_str()) else {
            continue;
        };
        let state_info =
            activity::detect_terminal_state(state, tid.as_str(), buffers.get(tid.as_str()));
        let is_claude = known_claude.contains(tid.as_str());
        let term_notifs: Vec<&TerminalNotification> = notifications
            .iter()
            .filter(|n| n.terminal_id == *tid)
            .collect();
        let unread_count = term_notifs.iter().filter(|n| n.read_at.is_none()).count() as u32;
        let latest_unread = term_notifs
            .iter()
            .filter(|n| n.read_at.is_none())
            .max_by_key(|n| n.created_at)
            .map(|n| (*n).clone());

        result.push(TerminalSummaryResponse {
            id: tid.clone(),
            profile: session.config.profile.clone(),
            title: session.title.clone(),
            cwd: session.cwd.clone(),
            branch: session.branch.clone(),
            last_command: session.last_command.clone(),
            last_exit_code: session.last_exit_code,
            last_command_at: session.last_command_at,
            command_running: session.command_running,
            activity: state_info.activity,
            is_claude,
            claude_message: session.claude_message.clone(),
            unread_notification_count: unread_count,
            latest_notification: latest_unread,
        });
    }

    Ok(result)
}

/// Tauri command: mark notifications as read for the given terminal IDs.
#[tauri::command]
pub fn mark_notifications_read(
    terminal_ids: Vec<String>,
    state: State<Arc<AppState>>,
) -> Result<u32, String> {
    mark_notifications_read_inner(Ok(terminal_ids), &state)
}

pub fn mark_notifications_read_inner(
    terminal_ids: Result<Vec<String>, String>,
    state: &AppState,
) -> Result<u32, String> {
    let terminal_ids = terminal_ids?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let mut count = 0u32;
    if let Ok(mut notifs) = state.notifications.lock_or_err() {
        for n in notifs.iter_mut() {
            if terminal_ids.contains(&n.terminal_id) && n.read_at.is_none() {
                n.read_at = Some(now_ms);
                count += 1;
            }
        }
    }
    Ok(count)
}

/// Evict oldest read notifications when the list exceeds MAX_NOTIFICATIONS.
/// Unread notifications are never evicted. Only read (already consumed) entries are removed.
pub(crate) fn evict_old_notifications(notifs: &mut Vec<crate::terminal::TerminalNotification>) {
    if notifs.len() <= MAX_NOTIFICATIONS {
        return;
    }
    // Remove oldest read notifications first (smallest created_at with read_at set)
    let over = notifs.len() - MAX_NOTIFICATIONS;
    let mut read_indices: Vec<usize> = notifs
        .iter()
        .enumerate()
        .filter(|(_, n)| n.read_at.is_some())
        .map(|(i, _)| i)
        .collect();
    // Already sorted by insertion order (oldest first), take the first `over` entries
    read_indices.truncate(over);
    // Remove in reverse order to keep indices stable
    for &i in read_indices.iter().rev() {
        notifs.remove(i);
    }
}

/// Tauri command: smart paste — resolve clipboard files/images into paths.
#[tauri::command]
pub fn smart_paste(
    image_dir: String,
    profile: String,
) -> Result<crate::clipboard::SmartPasteResult, String> {
    crate::clipboard::smart_paste(&image_dir, &profile)
}

/// Tauri command: write text to the system clipboard.
#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    clipboard_write_text_platform(&text)
}

#[cfg(target_os = "windows")]
fn clipboard_write_text_platform(text: &str) -> Result<(), String> {
    clipboard_win::set_clipboard(clipboard_win::formats::Unicode, text)
        .map_err(|e| format!("Clipboard write failed: {e}"))
}

#[cfg(not(target_os = "windows"))]
fn clipboard_write_text_platform(_text: &str) -> Result<(), String> {
    Err("Clipboard write not implemented on this platform".into())
}

fn sanitize_filename(s: &str) -> String {
    let sanitized: String = s
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    // Prevent path traversal via ".." components (use "__" to preserve length and avoid collisions)
    sanitized.replace("..", "__")
}

/// Inner implementation for saving terminal output cache, testable with arbitrary path.
fn save_terminal_output_cache_to(
    cache_dir: &std::path::Path,
    pane_id: &str,
    data: &str,
) -> Result<(), String> {
    if pane_id.is_empty() {
        return Err("Empty pane ID".into());
    }
    let dir = cache_dir.join("terminal-output");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create cache dir: {e}"))?;
    let path = dir.join(format!("{}.dat", sanitize_filename(pane_id)));
    std::fs::write(&path, data.as_bytes()).map_err(|e| format!("Failed to write cache: {e}"))
}

/// Inner implementation for loading terminal output cache, testable with arbitrary path.
fn load_terminal_output_cache_from(
    cache_dir: &std::path::Path,
    pane_id: &str,
) -> Result<String, String> {
    if pane_id.is_empty() {
        return Err("Empty pane ID".into());
    }
    let dir = cache_dir.join("terminal-output");
    let path = dir.join(format!("{}.dat", sanitize_filename(pane_id)));
    let bytes = std::fs::read(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("Cache not found: {}", path.display()),
        _ => format!("Failed to read cache: {e}"),
    })?;
    String::from_utf8(bytes).map_err(|e| format!("Invalid UTF-8 in cache: {e}"))
}

/// Inner implementation for cleaning orphaned cache files, testable with arbitrary path.
fn clean_terminal_output_cache_in(
    cache_dir: &std::path::Path,
    active_pane_ids: &[String],
) -> Result<u32, String> {
    let dir = cache_dir.join("terminal-output");
    if !dir.exists() {
        return Ok(0);
    }
    let active_set: std::collections::HashSet<String> = active_pane_ids
        .iter()
        .filter(|id| !id.is_empty())
        .map(|id| format!("{}.dat", sanitize_filename(id)))
        .collect();
    let mut removed = 0u32;
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("Read dir: {e}"))? {
        let entry = entry.map_err(|e| format!("Dir entry: {e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".dat")
            && !active_set.contains(&name)
            && std::fs::remove_file(entry.path()).is_ok()
        {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Save terminal output to the cache directory.
/// Accepts a string (xterm.js SerializeAddon output) and writes as UTF-8 bytes.
#[tauri::command]
pub fn save_terminal_output_cache(pane_id: String, data: String) -> Result<(), String> {
    let cache_dir = crate::settings::cache_dir_path().ok_or("Cannot determine cache directory")?;
    save_terminal_output_cache_to(&cache_dir, &pane_id, &data)
}

/// Load terminal output from the cache directory.
/// Returns a string (to be written back via terminal.write()).
#[tauri::command]
pub fn load_terminal_output_cache(pane_id: String) -> Result<String, String> {
    let cache_dir = crate::settings::cache_dir_path().ok_or("Cannot determine cache directory")?;
    load_terminal_output_cache_from(&cache_dir, &pane_id)
}

/// Remove orphaned cache files that don't correspond to any active pane.
#[tauri::command]
pub fn clean_terminal_output_cache(active_pane_ids: Vec<String>) -> Result<u32, String> {
    let cache_dir = crate::settings::cache_dir_path().ok_or("Cannot determine cache directory")?;
    clean_terminal_output_cache_in(&cache_dir, &active_pane_ids)
}

/// Window geometry to persist across restarts.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct WindowGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

fn window_geometry_path() -> Result<std::path::PathBuf, String> {
    let cache_dir = crate::settings::cache_dir_path().ok_or("Cannot determine cache directory")?;
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("Failed to create cache dir: {e}"))?;
    Ok(cache_dir.join("window-geometry.json"))
}

/// Save window geometry to cache.
#[tauri::command]
pub fn save_window_geometry(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
) -> Result<(), String> {
    let geo = WindowGeometry {
        x,
        y,
        width,
        height,
        maximized,
    };
    let json = serde_json::to_string(&geo).map_err(|e| format!("Serialize: {e}"))?;
    let path = window_geometry_path()?;
    std::fs::write(&path, json.as_bytes()).map_err(|e| format!("Write: {e}"))
}

/// Load window geometry from cache. Returns null if not found.
#[tauri::command]
pub fn load_window_geometry() -> Result<Option<WindowGeometry>, String> {
    let path = match window_geometry_path() {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };
    match std::fs::read(&path) {
        Ok(bytes) => {
            let s = String::from_utf8(bytes).map_err(|e| format!("UTF-8: {e}"))?;
            let geo: WindowGeometry =
                serde_json::from_str(&s).map_err(|e| format!("Deserialize: {e}"))?;
            Ok(Some(geo))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Read: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::{TerminalConfig, TerminalSession};

    #[test]
    fn greet_returns_message() {
        let result = greet("Laymux");
        assert_eq!(result, "Hello, Laymux! Welcome to Laymux.");
    }

    #[test]
    fn build_gh_command_direct_invocation() {
        let cmd = build_gh_command("");
        assert_eq!(cmd.get_program(), "gh");
        assert_eq!(cmd.get_args().collect::<Vec<_>>().len(), 0);
    }

    #[test]
    fn build_gh_command_with_shell_prefix() {
        let cmd = build_gh_command("wsl.exe -d Ubuntu --");
        assert_eq!(cmd.get_program(), "wsl.exe");
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, vec!["-d", "Ubuntu", "--", "gh"]);
    }

    #[test]
    fn build_gh_command_whitespace_only_prefix() {
        let cmd = build_gh_command("   ");
        assert_eq!(cmd.get_program(), "gh");
        assert_eq!(cmd.get_args().collect::<Vec<_>>().len(), 0);
    }

    #[test]
    fn build_gh_command_simple_shell() {
        let cmd = build_gh_command("bash");
        assert_eq!(cmd.get_program(), "bash");
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, vec!["gh"]);
    }

    #[test]
    fn build_gh_command_double_quoted_arg() {
        let cmd = build_gh_command(r#"wsl.exe -d "My Distro" --"#);
        assert_eq!(cmd.get_program(), "wsl.exe");
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, vec!["-d", "My Distro", "--", "gh"]);
    }

    #[test]
    fn build_gh_command_single_quoted_arg() {
        let cmd = build_gh_command("wsl.exe -d 'My Distro' --");
        assert_eq!(cmd.get_program(), "wsl.exe");
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, vec!["-d", "My Distro", "--", "gh"]);
    }

    #[test]
    fn split_shell_prefix_basic() {
        assert_eq!(split_shell_prefix(""), Vec::<String>::new());
        assert_eq!(split_shell_prefix("   "), Vec::<String>::new());
        assert_eq!(split_shell_prefix("a b c"), vec!["a", "b", "c"]);
    }

    #[test]
    fn split_shell_prefix_quotes() {
        assert_eq!(split_shell_prefix(r#""hello world""#), vec!["hello world"]);
        assert_eq!(split_shell_prefix("'hello world'"), vec!["hello world"]);
        assert_eq!(
            split_shell_prefix(r#"cmd "arg one" 'arg two' plain"#),
            vec!["cmd", "arg one", "arg two", "plain"]
        );
    }

    #[test]
    fn split_shell_prefix_unclosed_quote() {
        // Unclosed quote: rest of string is one token
        assert_eq!(
            split_shell_prefix(r#"cmd "unclosed arg"#),
            vec!["cmd", "unclosed arg"]
        );
    }

    #[test]
    fn sanitize_filename_alphanumeric_preserved() {
        assert_eq!(sanitize_filename("pane-abc123"), "pane-abc123");
        assert_eq!(sanitize_filename("dp_test_1"), "dp_test_1");
    }

    #[test]
    fn sanitize_filename_special_chars_replaced() {
        assert_eq!(sanitize_filename("pane/../../etc"), "pane_______etc");
        assert_eq!(sanitize_filename("a b.c"), "a_b.c");
    }

    #[test]
    fn sanitize_filename_rejects_dot_dot_traversal() {
        assert_eq!(sanitize_filename(".."), "__");
        assert_eq!(sanitize_filename("foo..bar"), "foo__bar");
    }

    #[test]
    fn terminal_output_cache_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let data = "Hello terminal output \x1b[32mgreen\x1b[0m";
        save_terminal_output_cache_to(dir.path(), "pane-test123", data).unwrap();
        let loaded = load_terminal_output_cache_from(dir.path(), "pane-test123").unwrap();
        assert_eq!(loaded, data);
    }

    #[test]
    fn save_cache_rejects_empty_pane_id() {
        let dir = tempfile::tempdir().unwrap();
        let result = save_terminal_output_cache_to(dir.path(), "", "data");
        assert_eq!(result.unwrap_err(), "Empty pane ID");
    }

    #[test]
    fn load_cache_rejects_empty_pane_id() {
        let dir = tempfile::tempdir().unwrap();
        let result = load_terminal_output_cache_from(dir.path(), "");
        assert_eq!(result.unwrap_err(), "Empty pane ID");
    }

    #[test]
    fn clean_terminal_output_cache_removes_orphans() {
        let dir = tempfile::tempdir().unwrap();
        save_terminal_output_cache_to(dir.path(), "pane-keep", "data").unwrap();
        save_terminal_output_cache_to(dir.path(), "pane-orphan", "data").unwrap();
        save_terminal_output_cache_to(dir.path(), "pane-also-orphan", "data").unwrap();

        let removed = clean_terminal_output_cache_in(dir.path(), &["pane-keep".into()]).unwrap();
        assert_eq!(removed, 2);
        // Verify via load
        assert!(load_terminal_output_cache_from(dir.path(), "pane-keep").is_ok());
        assert!(load_terminal_output_cache_from(dir.path(), "pane-orphan").is_err());
    }

    #[test]
    fn clean_cache_skips_non_dat_files() {
        let dir = tempfile::tempdir().unwrap();
        save_terminal_output_cache_to(dir.path(), "pane-keep", "data").unwrap();
        // Create a non-.dat file in the terminal-output directory
        let non_dat = dir.path().join("terminal-output").join("readme.txt");
        std::fs::write(&non_dat, "do not delete").unwrap();

        let removed = clean_terminal_output_cache_in(dir.path(), &["pane-keep".into()]).unwrap();
        assert_eq!(removed, 0);
        // Non-.dat file should still exist
        assert!(non_dat.exists());
    }

    #[test]
    fn clean_cache_filters_empty_pane_ids() {
        let dir = tempfile::tempdir().unwrap();
        save_terminal_output_cache_to(dir.path(), "pane-a", "data").unwrap();
        // Empty string in active list should not match everything
        let removed =
            clean_terminal_output_cache_in(dir.path(), &["".into(), "pane-a".into()]).unwrap();
        assert_eq!(removed, 0);
    }

    // IPC dispatch tests moved to ipc_dispatch.rs
    // Remaining tests below are for functions that stay in mod.rs

    #[test]
    fn is_monospace_detects_consolas() {
        use font_kit::source::SystemSource;
        let source = SystemSource::new();
        // Consolas is always present on Windows
        if let Ok(family) = source.select_family_by_name("Consolas") {
            if let Some(handle) = family.fonts().first() {
                if let Ok(font) = handle.load() {
                    assert!(
                        is_monospace(&font),
                        "Consolas should be detected as monospace"
                    );
                }
            }
        }
    }

    #[test]
    fn is_monospace_rejects_arial() {
        use font_kit::source::SystemSource;
        let source = SystemSource::new();
        // Arial is always present on Windows and is proportional
        if let Ok(family) = source.select_family_by_name("Arial") {
            if let Some(handle) = family.fonts().first() {
                if let Ok(font) = handle.load() {
                    assert!(
                        !is_monospace(&font),
                        "Arial should not be detected as monospace"
                    );
                }
            }
        }
    }

    #[test]
    fn is_monospace_detects_cjk_monospace_font() {
        use font_kit::source::SystemSource;
        let source = SystemSource::new();
        // JetBrainsMonoBigHangul has isFixedPitch=0 in post table (CJK double-width)
        // but Latin chars 'i' and 'M' share the same advance width — it IS monospace
        if let Ok(family) = source.select_family_by_name("JetBrainsMonoBigHangul") {
            if let Some(handle) = family.fonts().first() {
                if let Ok(font) = handle.load() {
                    assert!(
                        is_monospace(&font),
                        "JetBrainsMonoBigHangul should be detected as monospace"
                    );
                }
            }
        }
    }

    #[test]
    fn list_system_monospace_fonts_returns_known_fonts() {
        let result = list_system_monospace_fonts().expect("should enumerate fonts");
        // Should contain at least one well-known monospace font per platform
        #[cfg(windows)]
        assert!(
            result.iter().any(|f| f == "Consolas"),
            "System monospace fonts should include Consolas, got: {:?}",
            &result[..result.len().min(10)]
        );
        #[cfg(not(windows))]
        assert!(
            result
                .iter()
                .any(|f| f.contains("Mono") || f.contains("mono")),
            "System monospace fonts should include at least one *Mono* font, got: {:?}",
            &result[..result.len().min(10)]
        );
        // Should NOT contain proportional fonts
        assert!(
            !result.iter().any(|f| f == "Arial"),
            "System monospace fonts should not include Arial"
        );
        // JetBrainsMonoBigHangul may not be installed on all systems
        #[cfg(windows)]
        assert!(
            result.iter().any(|f| f == "JetBrainsMonoBigHangul"),
            "System monospace fonts should include JetBrainsMonoBigHangul"
        );
    }

    // --- cwd_receive initialization tests ---

    #[test]
    fn terminal_session_defaults_cwd_receive_true() {
        let session = TerminalSession::new("t1".into(), TerminalConfig::default());
        assert!(
            session.cwd_receive,
            "New terminal should default to cwd_receive=true"
        );
    }

    // (moved tests removed — see ipc_dispatch.rs)

    // -- get_terminal_summaries tests --

    #[test]
    fn get_terminal_summaries_empty_ids() {
        let state = AppState::new();
        let result = get_terminal_summaries_inner(&[], &state).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn get_terminal_summaries_returns_session_data() {
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            let mut session = TerminalSession::new("t1".into(), TerminalConfig::default());
            session.cwd = Some("/home/user".into());
            session.branch = Some("main".into());
            session.last_command = Some("cargo test".into());
            session.last_exit_code = Some(0);
            session.last_command_at = Some(12345);
            terminals.insert("t1".into(), session);
        }
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            buffers.insert(
                "t1".into(),
                crate::output_buffer::TerminalOutputBuffer::default(),
            );
        }

        let result = get_terminal_summaries_inner(&["t1".into()], &state).unwrap();
        assert_eq!(result.len(), 1);
        let t = &result[0];
        assert_eq!(t.id, "t1");
        assert_eq!(t.cwd.as_deref(), Some("/home/user"));
        assert_eq!(t.branch.as_deref(), Some("main"));
        assert_eq!(t.last_command.as_deref(), Some("cargo test"));
        assert_eq!(t.last_exit_code, Some(0));
        assert_eq!(t.last_command_at, Some(12345));
        assert_eq!(t.profile, "PowerShell");
    }

    #[test]
    fn get_terminal_summaries_skips_missing_ids() {
        let state = AppState::new();
        let result = get_terminal_summaries_inner(&["nonexistent".into()], &state).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn get_terminal_summaries_includes_claude_detection() {
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            terminals.insert(
                "t1".into(),
                TerminalSession::new("t1".into(), TerminalConfig::default()),
            );
        }
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            buffers.insert(
                "t1".into(),
                crate::output_buffer::TerminalOutputBuffer::default(),
            );
        }
        state
            .known_claude_terminals
            .lock()
            .unwrap()
            .insert("t1".into());

        let result = get_terminal_summaries_inner(&["t1".into()], &state).unwrap();
        assert!(result[0].is_claude);
    }

    #[test]
    fn get_terminal_summaries_includes_notifications() {
        let state = AppState::new();
        {
            let mut terminals = state.terminals.lock().unwrap();
            terminals.insert(
                "t1".into(),
                TerminalSession::new("t1".into(), TerminalConfig::default()),
            );
        }
        {
            let mut buffers = state.output_buffers.lock().unwrap();
            buffers.insert(
                "t1".into(),
                crate::output_buffer::TerminalOutputBuffer::default(),
            );
        }
        // Add 2 unread + 1 read notification
        {
            let mut notifs = state.notifications.lock().unwrap();
            notifs.push(TerminalNotification {
                id: 1,
                terminal_id: "t1".into(),
                message: "old".into(),
                level: "info".into(),
                created_at: 100,
                read_at: Some(200),
            });
            notifs.push(TerminalNotification {
                id: 2,
                terminal_id: "t1".into(),
                message: "unread1".into(),
                level: "error".into(),
                created_at: 300,
                read_at: None,
            });
            notifs.push(TerminalNotification {
                id: 3,
                terminal_id: "t1".into(),
                message: "unread2".into(),
                level: "warning".into(),
                created_at: 400,
                read_at: None,
            });
        }

        let result = get_terminal_summaries_inner(&["t1".into()], &state).unwrap();
        assert_eq!(result[0].unread_notification_count, 2);
        let latest = result[0].latest_notification.as_ref().unwrap();
        assert_eq!(latest.message, "unread2");
        assert_eq!(latest.created_at, 400);
    }

    // -- mark_notifications_read tests --

    #[test]
    fn mark_notifications_read_sets_read_at() {
        let state = AppState::new();
        {
            let mut notifs = state.notifications.lock().unwrap();
            notifs.push(TerminalNotification {
                id: 1,
                terminal_id: "t1".into(),
                message: "test".into(),
                level: "info".into(),
                created_at: 100,
                read_at: None,
            });
            notifs.push(TerminalNotification {
                id: 2,
                terminal_id: "t2".into(),
                message: "other".into(),
                level: "info".into(),
                created_at: 200,
                read_at: None,
            });
        }

        // Mark t1 as read
        let now_ms = 999u64;
        {
            let mut notifs = state.notifications.lock().unwrap();
            for n in notifs.iter_mut() {
                if n.terminal_id == "t1" && n.read_at.is_none() {
                    n.read_at = Some(now_ms);
                }
            }
        }

        let notifs = state.notifications.lock().unwrap();
        assert!(notifs[0].read_at.is_some()); // t1 marked
        assert!(notifs[1].read_at.is_none()); // t2 untouched
    }

    // -- evict_old_notifications tests --

    #[test]
    fn evict_removes_oldest_read_notifications() {
        let mut notifs: Vec<TerminalNotification> = Vec::new();
        // Fill with MAX_NOTIFICATIONS + 5 notifications, all read
        for i in 0..(MAX_NOTIFICATIONS + 5) {
            notifs.push(TerminalNotification {
                id: i as u64,
                terminal_id: "t1".into(),
                message: format!("msg-{i}"),
                level: "info".into(),
                created_at: i as u64,
                read_at: Some(1000),
            });
        }
        assert_eq!(notifs.len(), MAX_NOTIFICATIONS + 5);
        evict_old_notifications(&mut notifs);
        assert_eq!(notifs.len(), MAX_NOTIFICATIONS);
        // Oldest 5 should be removed
        assert_eq!(notifs[0].id, 5);
    }

    #[test]
    fn evict_preserves_unread_notifications() {
        let mut notifs: Vec<TerminalNotification> = Vec::new();
        // Fill with MAX_NOTIFICATIONS + 3: first 3 are unread, rest are read
        for i in 0..(MAX_NOTIFICATIONS + 3) {
            notifs.push(TerminalNotification {
                id: i as u64,
                terminal_id: "t1".into(),
                message: format!("msg-{i}"),
                level: "info".into(),
                created_at: i as u64,
                read_at: if i < 3 { None } else { Some(1000) },
            });
        }
        evict_old_notifications(&mut notifs);
        // All 3 unread should survive; 3 oldest read removed
        let unread_count = notifs.iter().filter(|n| n.read_at.is_none()).count();
        assert_eq!(unread_count, 3);
        assert_eq!(notifs.len(), MAX_NOTIFICATIONS);
    }

    #[test]
    fn evict_noop_under_limit() {
        let mut notifs: Vec<TerminalNotification> = vec![TerminalNotification {
            id: 1,
            terminal_id: "t1".into(),
            message: "msg".into(),
            level: "info".into(),
            created_at: 100,
            read_at: Some(200),
        }];
        evict_old_notifications(&mut notifs);
        assert_eq!(notifs.len(), 1);
    }

    // -- close_terminal cleans up notifications --

    #[test]
    fn close_terminal_removes_notifications() {
        let state = AppState::new();
        {
            let mut notifs = state.notifications.lock().unwrap();
            notifs.push(TerminalNotification {
                id: 1,
                terminal_id: "t1".into(),
                message: "test".into(),
                level: "info".into(),
                created_at: 100,
                read_at: None,
            });
            notifs.push(TerminalNotification {
                id: 2,
                terminal_id: "t2".into(),
                message: "other".into(),
                level: "info".into(),
                created_at: 200,
                read_at: None,
            });
        }
        // Simulate close_terminal_session cleanup for t1
        {
            let mut notifs = state.notifications.lock().unwrap();
            notifs.retain(|n| n.terminal_id != "t1");
        }
        let notifs = state.notifications.lock().unwrap();
        assert_eq!(notifs.len(), 1);
        assert_eq!(notifs[0].terminal_id, "t2");
    }

    // file_ops tests (FileViewerContent, list_directory) moved to file_ops.rs
}
