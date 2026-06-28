use std::net::SocketAddr;

use axum::extract::ConnectInfo;
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Redirect, Response};

use crate::settings::models::RemoteSettings;

use super::auth::{is_remote_ip_allowed, normalize_ip};
use super::json_error;

pub(crate) async fn remote_page_redirect(ConnectInfo(addr): ConnectInfo<SocketAddr>) -> Response {
    let settings = crate::settings::load_settings().remote;
    if let Some(response) = remote_page_access_error(&settings, addr) {
        return response;
    }

    Redirect::temporary("/remote/").into_response()
}

pub(crate) async fn remote_page(ConnectInfo(addr): ConnectInfo<SocketAddr>) -> Response {
    let settings = crate::settings::load_settings().remote;
    if let Some(response) = remote_page_access_error(&settings, addr) {
        return response;
    }

    Html(remote_page_html()).into_response()
}

fn remote_page_access_error(settings: &RemoteSettings, addr: SocketAddr) -> Option<Response> {
    if !settings.enabled {
        return Some(json_error(
            StatusCode::FORBIDDEN,
            "direct remote mode is disabled",
        ));
    }
    if settings.auth_token.is_empty() {
        return Some(json_error(
            StatusCode::UNAUTHORIZED,
            "direct remote mode requires remote.authToken",
        ));
    }
    let remote_ip = normalize_ip(addr.ip());
    if !is_remote_ip_allowed(&remote_ip, &settings.allowed_ips) {
        tracing::warn!(
            remote_addr = %addr,
            remote_ip = %remote_ip,
            allowed_ips = ?settings.allowed_ips,
            "remote page client IP denied"
        );
        return Some(json_error(
            StatusCode::FORBIDDEN,
            "remote client IP is not allowed",
        ));
    }

    None
}

fn remote_page_html() -> &'static str {
    REMOTE_PAGE_HTML
}

const REMOTE_PAGE_HTML: &str = r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Laymux Remote</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #111318;
        --panel: #1b2028;
        --panel-2: #252b35;
        --border: #394150;
        --text: #ecf0f8;
        --muted: #9aa5b5;
        --accent: #68a7ff;
        --danger: #ff6b7a;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: var(--bg);
        color: var(--text);
        font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      button, input, select {
        font: inherit;
      }
      .app {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        min-height: 100vh;
      }
      header, footer {
        display: flex;
        gap: 8px;
        align-items: center;
        padding: 10px 12px;
        border-color: var(--border);
        background: var(--panel);
      }
      header {
        border-bottom: 1px solid var(--border);
        flex-wrap: wrap;
      }
      footer {
        border-top: 1px solid var(--border);
      }
      h1 {
        margin: 0 10px 0 0;
        font-size: 15px;
        font-weight: 700;
      }
      label {
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--muted);
      }
      input, select {
        min-width: 0;
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 7px 8px;
        background: #0d1015;
        color: var(--text);
      }
      input[type="password"] {
        width: 180px;
      }
      select {
        width: min(360px, 100%);
      }
      button {
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 7px 10px;
        background: var(--panel-2);
        color: var(--text);
        cursor: pointer;
      }
      button.primary {
        border-color: #3d7dd1;
        background: #1f5fa8;
      }
      button.danger {
        border-color: #8b3440;
        background: #6a2230;
      }
      button:disabled {
        cursor: default;
        opacity: 0.55;
      }
      main {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        min-height: 0;
      }
      .status {
        min-height: 36px;
        padding: 8px 12px;
        color: var(--muted);
        border-bottom: 1px solid var(--border);
      }
      .status.error {
        color: var(--danger);
      }
      pre {
        margin: 0;
        min-height: 0;
        overflow: auto;
        padding: 12px;
        white-space: pre-wrap;
        word-break: break-word;
        font: 13px/1.35 "Cascadia Mono", Consolas, monospace;
      }
      .input-line {
        flex: 1;
      }
      .input-line input {
        width: 100%;
      }
      @media (max-width: 720px) {
        header {
          display: grid;
          grid-template-columns: 1fr;
        }
        h1 {
          margin-right: 0;
        }
        label {
          display: grid;
          grid-template-columns: 72px minmax(0, 1fr);
        }
        input[type="password"], select {
          width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <div class="app">
      <header>
        <h1>Laymux Remote</h1>
        <label>Token <input id="token" type="password" autocomplete="current-password" /></label>
        <label>Name <input id="clientName" autocomplete="nickname" value="browser" /></label>
        <button id="connect" class="primary">Connect</button>
        <button id="release" class="danger" disabled>Release</button>
        <select id="terminals" disabled></select>
      </header>
      <main>
        <div id="status" class="status">Enter the remote token, then connect.</div>
        <pre id="output" aria-label="Terminal output"></pre>
      </main>
      <footer>
        <button id="ctrlC" disabled>Ctrl+C</button>
        <form id="inputForm" class="input-line">
          <input id="input" autocomplete="off" placeholder="Type command and press Enter" disabled />
        </form>
        <button id="send" disabled>Send</button>
      </footer>
    </div>
    <script>
      (() => {
        const $ = (id) => document.getElementById(id);
        const tokenInput = $("token");
        const clientNameInput = $("clientName");
        const connectButton = $("connect");
        const releaseButton = $("release");
        const terminalsSelect = $("terminals");
        const statusEl = $("status");
        const outputEl = $("output");
        const inputForm = $("inputForm");
        const inputEl = $("input");
        const sendButton = $("send");
        const ctrlCButton = $("ctrlC");
        const decoder = new TextDecoder();
        const tokenKey = "laymux.remote.token";
        let leaseId = null;
        let heartbeatTimer = null;
        let socket = null;
        let outputText = "";
        let activeTerminalId = null;

        const params = new URLSearchParams(location.search);
        tokenInput.value = params.get("token") || localStorage.getItem(tokenKey) || "";

        function setStatus(message, error = false) {
          statusEl.textContent = message;
          statusEl.classList.toggle("error", error);
        }

        function token() {
          return tokenInput.value.trim();
        }

        function authHeaders() {
          return {
            "authorization": `Bearer ${token()}`,
            "content-type": "application/json",
          };
        }

        async function remoteFetch(path, options = {}) {
          const response = await fetch(path, {
            ...options,
            headers: { ...authHeaders(), ...(options.headers || {}) },
          });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || `${response.status} ${response.statusText}`);
          }
          return response.json();
        }

        function setConnected(connected) {
          releaseButton.disabled = !connected;
          terminalsSelect.disabled = !connected;
          inputEl.disabled = !connected || !activeTerminalId;
          sendButton.disabled = !connected || !activeTerminalId;
          ctrlCButton.disabled = !connected || !activeTerminalId;
          connectButton.disabled = connected;
        }

        function appendOutput(text) {
          outputText += stripAnsi(text);
          if (outputText.length > 200000) outputText = outputText.slice(-160000);
          outputEl.textContent = outputText;
          outputEl.scrollTop = outputEl.scrollHeight;
        }

        function stripAnsi(text) {
          return text
            .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
            .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
            .replace(/\x1b[=>]/g, "")
            .replace(/\r/g, "");
        }

        function stopSocket() {
          if (socket) {
            const closingSocket = socket;
            socket = null;
            closingSocket.onclose = null;
            closingSocket.onerror = null;
            closingSocket.close();
          }
        }

        function stopHeartbeat() {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
        }

        async function heartbeat() {
          if (!leaseId) return;
          await remoteFetch("/remote/v1/session/heartbeat", {
            method: "POST",
            body: JSON.stringify({ leaseId }),
          });
        }

        function startHeartbeat(timeoutSeconds) {
          stopHeartbeat();
          const intervalMs = Math.max(1000, Math.floor(timeoutSeconds * 333));
          heartbeatTimer = setInterval(() => {
            heartbeat().catch((err) => {
              setStatus(`Heartbeat failed: ${err.message}`, true);
              disconnect(false);
            });
          }, intervalMs);
        }

        async function loadTerminals() {
          const data = await remoteFetch("/remote/v1/terminals");
          terminalsSelect.innerHTML = "";
          for (const terminal of data.terminals || []) {
            const option = document.createElement("option");
            option.value = terminal.id;
            option.textContent = [terminal.title || terminal.id, terminal.profile || "", terminal.cwd || ""]
              .filter(Boolean)
              .join(" - ");
            terminalsSelect.append(option);
          }
          activeTerminalId = terminalsSelect.value || null;
          setConnected(Boolean(leaseId));
          if (activeTerminalId) openOutput(activeTerminalId);
        }

        function wsBaseUrl() {
          const protocol = location.protocol === "https:" ? "wss:" : "ws:";
          return `${protocol}//${location.host}`;
        }

        function openOutput(terminalId) {
          stopSocket();
          outputText = "";
          outputEl.textContent = "";
          const url = `${wsBaseUrl()}/remote/v1/terminals/${encodeURIComponent(terminalId)}/output?leaseId=${encodeURIComponent(leaseId)}&token=${encodeURIComponent(token())}`;
          const outputSocket = new WebSocket(url);
          socket = outputSocket;
          outputSocket.binaryType = "arraybuffer";
          outputSocket.onopen = () => {
            if (socket === outputSocket) setStatus(`Connected to ${terminalId}`);
          };
          outputSocket.onmessage = (event) => {
            if (socket !== outputSocket) return;
            if (event.data instanceof ArrayBuffer) appendOutput(decoder.decode(event.data));
            else appendOutput(String(event.data));
          };
          outputSocket.onclose = () => {
            if (socket === outputSocket) {
              socket = null;
              if (leaseId) setStatus("Output stream closed.", true);
            }
          };
          outputSocket.onerror = () => {
            if (socket === outputSocket) setStatus("Output stream error.", true);
          };
        }

        async function connect() {
          if (!token()) {
            setStatus("Remote token is required.", true);
            return;
          }
          localStorage.setItem(tokenKey, token());
          setStatus("Claiming remote control...");
          try {
            const status = await remoteFetch("/remote/v1/session/claim", {
              method: "POST",
              body: JSON.stringify({ clientName: clientNameInput.value.trim() || "browser" }),
            });
            leaseId = status.leaseId;
            setConnected(true);
            startHeartbeat(status.heartbeatTimeoutSeconds || 15);
            await loadTerminals();
          } catch (err) {
            const failedLease = leaseId;
            disconnect(false);
            if (failedLease) await releaseLease(failedLease).catch(() => {});
            setStatus(err.message, true);
          }
        }

        async function write(data) {
          if (!leaseId || !activeTerminalId) return;
          await remoteFetch(`/remote/v1/terminals/${encodeURIComponent(activeTerminalId)}/write`, {
            method: "POST",
            body: JSON.stringify({ leaseId, data }),
          });
        }

        async function release() {
          if (!leaseId) return;
          const currentLease = leaseId;
          await releaseLease(currentLease);
          disconnect(false);
          setStatus("Released remote control.");
        }

        async function releaseLease(id) {
          await remoteFetch("/remote/v1/session/release", {
            method: "POST",
            body: JSON.stringify({ leaseId: id }),
          });
        }

        function disconnect(clearStatus = true) {
          stopSocket();
          stopHeartbeat();
          leaseId = null;
          activeTerminalId = null;
          setConnected(false);
          if (clearStatus) setStatus("Disconnected.");
        }

        connectButton.addEventListener("click", () => connect().catch((err) => setStatus(err.message, true)));
        releaseButton.addEventListener("click", () => release().catch((err) => setStatus(`Release failed: ${err.message}`, true)));
        terminalsSelect.addEventListener("change", () => {
          activeTerminalId = terminalsSelect.value || null;
          setConnected(Boolean(leaseId));
          if (activeTerminalId) openOutput(activeTerminalId);
        });
        inputForm.addEventListener("submit", (event) => {
          event.preventDefault();
          const value = inputEl.value;
          inputEl.value = "";
          write(`${value}\r`).catch((err) => setStatus(err.message, true));
        });
        sendButton.addEventListener("click", () => inputForm.requestSubmit());
        ctrlCButton.addEventListener("click", () => write("\x03").catch((err) => setStatus(err.message, true)));
        window.addEventListener("beforeunload", () => {
          stopSocket();
          stopHeartbeat();
        });
      })();
    </script>
  </body>
</html>
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_page_html_contains_remote_bootstrap() {
        let html = remote_page_html();
        assert!(html.contains("Laymux Remote"));
        assert!(html.contains("/remote/v1/session/claim"));
        assert!(html.contains("/remote/v1/terminals"));
        assert!(html.contains("new WebSocket"));
    }
}
