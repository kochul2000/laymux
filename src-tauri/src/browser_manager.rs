use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

/// Information about a CDP-enabled browser instance.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CdpInfo {
    pub id: String,
    pub cdp_port: u16,
    pub cdp_ws_url: String,
    pub target_url: String,
    pub pid: u32,
}

/// A running browser instance with CDP enabled.
pub struct BrowserInstance {
    pub process: Child,
    pub info: CdpInfo,
    pub user_data_dir: std::path::PathBuf,
}

/// Thread-safe container for all active CDP browser instances.
pub type BrowserInstances = Mutex<HashMap<String, BrowserInstance>>;

/// Create a new empty browser instances map.
pub fn new_browser_instances() -> BrowserInstances {
    Mutex::new(HashMap::new())
}

/// Parse the CDP WebSocket URL from a browser stderr line.
///
/// Chromium-based browsers print a line like:
///   DevTools listening on ws://127.0.0.1:PORT/devtools/browser/UUID
pub fn parse_cdp_ws_url(line: &str) -> Option<(String, u16)> {
    if !line.contains("DevTools listening on") {
        return None;
    }
    let url_start = line.find("ws://")?;
    let url = line[url_start..].trim();
    // Extract port from ws://127.0.0.1:PORT/...
    let after_host = url.strip_prefix("ws://127.0.0.1:")?;
    let port_str = after_host.split('/').next()?;
    let port: u16 = port_str.parse().ok()?;
    Some((url.to_string(), port))
}

/// Find a Chromium-based browser executable on the system.
pub fn find_browser_executable() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let candidates = [
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ];
        for path in &candidates {
            if std::path::Path::new(path).exists() {
                return Some(path.to_string());
            }
        }
        None
    }
    #[cfg(not(target_os = "windows"))]
    {
        let candidates = [
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
            "microsoft-edge",
        ];
        for name in &candidates {
            if Command::new("which")
                .arg(name)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
            {
                return Some(name.to_string());
            }
        }
        None
    }
}

/// Launch a Chromium-based browser with CDP (Chrome DevTools Protocol) enabled.
///
/// Returns a `BrowserInstance` containing the CDP connection info.
/// The browser is launched with `--remote-debugging-port=0` so the OS assigns a free port.
/// The CDP WebSocket URL is parsed from the browser's stderr output.
pub fn launch_cdp_browser(url: &str) -> Result<BrowserInstance, String> {
    let exe = find_browser_executable().ok_or("No Chromium-based browser found on system")?;

    let id = uuid::Uuid::new_v4().to_string();
    let prefix = crate::config_dir::temp_prefix();
    let user_data_dir = std::env::temp_dir().join(format!("{prefix}-cdp-{id}"));
    std::fs::create_dir_all(&user_data_dir)
        .map_err(|e| format!("Failed to create user-data-dir: {e}"))?;

    let mut child = Command::new(&exe)
        .args([
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            &format!("--user-data-dir={}", user_data_dir.display()),
            url,
        ])
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to launch browser ({exe}): {e}"))?;

    let pid = child.id();

    // Read stderr in a background thread to find the CDP WebSocket URL.
    let stderr = child
        .stderr
        .take()
        .ok_or("Failed to capture browser stderr")?;
    let (tx, rx) = std::sync::mpsc::channel();

    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(result) = parse_cdp_ws_url(&line) {
                let _ = tx.send(result);
                // Keep reading to prevent pipe buffer from filling up,
                // but we no longer need to send anything.
            }
        }
    });

    let (ws_url, cdp_port) = rx
        .recv_timeout(Duration::from_secs(15))
        .map_err(|_| {
            // Kill the orphaned browser process so it doesn't linger.
            // On Windows, dropping a Child does NOT kill the process.
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_dir_all(&user_data_dir);
            "Timeout (15s) waiting for browser CDP endpoint"
        })?;

    Ok(BrowserInstance {
        process: child,
        info: CdpInfo {
            id,
            cdp_port,
            cdp_ws_url: ws_url,
            target_url: url.to_string(),
            pid,
        },
        user_data_dir,
    })
}

/// Close a CDP browser instance by killing the process and cleaning up.
pub fn close_browser_instance(instance: &mut BrowserInstance) {
    let _ = instance.process.kill();
    let _ = instance.process.wait();
    let _ = std::fs::remove_dir_all(&instance.user_data_dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_cdp_ws_url_valid_line() {
        let line =
            "DevTools listening on ws://127.0.0.1:9222/devtools/browser/abc-def-123";
        let result = parse_cdp_ws_url(line);
        assert!(result.is_some());
        let (url, port) = result.unwrap();
        assert_eq!(url, "ws://127.0.0.1:9222/devtools/browser/abc-def-123");
        assert_eq!(port, 9222);
    }

    #[test]
    fn parse_cdp_ws_url_random_port() {
        let line =
            "DevTools listening on ws://127.0.0.1:41567/devtools/browser/550e8400-e29b";
        let (url, port) = parse_cdp_ws_url(line).unwrap();
        assert_eq!(
            url,
            "ws://127.0.0.1:41567/devtools/browser/550e8400-e29b"
        );
        assert_eq!(port, 41567);
    }

    #[test]
    fn parse_cdp_ws_url_ignores_unrelated_lines() {
        assert!(parse_cdp_ws_url("Starting browser...").is_none());
        assert!(parse_cdp_ws_url("").is_none());
        assert!(parse_cdp_ws_url("Some error message").is_none());
    }

    #[test]
    fn parse_cdp_ws_url_malformed() {
        // Has the trigger text but no ws:// URL
        assert!(parse_cdp_ws_url("DevTools listening on http://localhost:9222").is_none());
    }

    #[test]
    fn new_browser_instances_is_empty() {
        let instances = new_browser_instances();
        let locked = instances.lock().unwrap();
        assert!(locked.is_empty());
    }

    #[test]
    fn find_browser_executable_returns_option() {
        // Just check it doesn't panic — result depends on system
        let _ = find_browser_executable();
    }
}
