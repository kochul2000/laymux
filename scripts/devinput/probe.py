"""Automation API client (dev only).

Everything that HTTP can do is done here, not with SendInput — pane focus,
reading terminal output, posting the on-screen banner. Injection is reserved
for what the API physically cannot produce.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

from guard import DEV_PORT, GuardError


class ApiError(RuntimeError):
    pass


def _url(port: int, path: str) -> str:
    if port != DEV_PORT:
        raise GuardError(f"refusing to talk to port {port}; dev is {DEV_PORT}")
    return f"http://127.0.0.1:{port}{path}"


def request(
    port: int, path: str, *, method: str = "GET", body: dict | None = None, timeout=5.0
) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        _url(port, path),
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:400]
        raise ApiError(f"{method} {path} -> HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ApiError(f"{method} {path} -> {exc}") from exc
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except ValueError as exc:
        raise ApiError(f"{method} {path} -> non-JSON response: {raw[:200]}") from exc


def health(port: int) -> dict:
    return request(port, "/api/v1/health")


def terminals(port: int) -> list[dict]:
    return request(port, "/api/v1/terminals").get("instances", [])


def terminal_output(port: int, terminal_id: str, lines: int = 40) -> str:
    """Raw ring-buffer text — ANSI escapes included. Use `strip_ansi` to match."""
    payload = request(port, f"/api/v1/terminals/{terminal_id}/output?lines={lines}")
    return payload.get("output", "")


# CSI/OSC/two-char escapes. `/output` hands back unfiltered PTY bytes, and
# PSReadLine re-emits the input line with colour sequences *inside* a token, so
# substring matching on raw output gives false negatives.
_ANSI = re.compile(
    r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC ... BEL / ST
    r"|\x1b\[[0-9;:<=>?]*[ -/]*[@-~]"  # CSI
    r"|\x1b[()][0-9A-Za-z]"  # charset select
    r"|\x1b[=>NOc78]"  # misc two-char
)


def strip_ansi(text: str) -> str:
    """Drop escape sequences so a marker split by colour codes still matches."""
    return _ANSI.sub("", text)


def focused_terminal_id(port: int) -> str | None:
    """Terminal id of the pane that actually owns keyboard focus, or None.

    `/api/v1/grid` reports the focused pane of the *active* workspace, which is
    the pane keystrokes reach. `isFocused` on the terminal list is per-workspace
    and therefore true for several terminals at once — not usable here.
    """
    grid = request(port, "/api/v1/grid")
    index = grid.get("focusedPaneIndex")
    if not isinstance(index, int):
        return None
    for pane in grid.get("panes") or []:
        if pane.get("paneIndex") == index:
            return pane.get("terminalId")
    return None


def focus_terminal(port: int, terminal_id: str) -> dict:
    return request(port, f"/api/v1/terminals/{terminal_id}/focus", method="POST")


def notify(port: int, terminal: dict, message: str, level: str = "info") -> None:
    """Put the handover state on screen. Best-effort: never blocks the run."""
    try:
        request(
            port,
            "/api/v1/notifications",
            method="POST",
            body={
                "terminalId": terminal["id"],
                "workspaceId": terminal.get("workspaceId", ""),
                "message": message,
                "level": level,
            },
        )
    except ApiError:
        pass


def pick_shell_terminal(port: int, terminal_id: str | None = None) -> dict:
    """Choose a safe injection target: a plain shell, never a running agent.

    Typing into an `interactiveApp` pane (Claude, Codex, vim) would submit
    text to somebody else's session, so those are refused outright.
    """
    instances = terminals(port)
    if not instances:
        raise GuardError("dev has no terminals")

    if terminal_id:
        matches = [t for t in instances if t["id"] == terminal_id]
        if not matches:
            raise GuardError(f"no terminal {terminal_id!r} in dev")
        target = matches[0]
    else:
        shells = [
            t
            for t in instances
            if (t.get("activity") or {}).get("type") == "shell"
        ]
        if not shells:
            raise GuardError(
                "no idle shell pane in dev — every pane runs an interactive app. "
                "Open a fresh pane, or pass --terminal explicitly."
            )
        shells.sort(key=lambda t: (not t.get("isFocused", False), t.get("paneIndex", 0)))
        target = shells[0]

    activity = (target.get("activity") or {}).get("type")
    if activity != "shell":
        raise GuardError(
            f"terminal {target['id']} is running {activity!r} "
            f"({(target.get('activity') or {}).get('name', '?')}) — refusing to type "
            "into someone else's session"
        )
    return target
