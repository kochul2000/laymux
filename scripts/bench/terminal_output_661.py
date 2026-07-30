#!/usr/bin/env python3
"""Issue #661 deterministic multi-pane flood benchmark (dev port 19281 only)."""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


PORT = 19281
BASE = f"http://127.0.0.1:{PORT}/api/v1"
RUN_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
DEV_RUNTIME_ARTIFACTS = {
    "src-tauri/automation.json",
    "src-tauri/settings.json",
}
CATCHUP_MIN_BACKLOG_BYTES = 64 * 1024


class BenchmarkError(RuntimeError):
    pass


@dataclass
class BenchmarkResources:
    original_active_workspace_id: str | None = None
    original_focused_terminal_id: str | None = None
    created_workspace_ids: list[str] = field(default_factory=list)
    failure_context: dict[str, Any] = field(default_factory=dict)


def api(method: str, path: str, payload: Any | None = None, timeout: float = 7.0) -> Any:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(
        f"{BASE}{path}",
        data=body,
        method=method,
        headers={"Content-Type": "application/json"} if body is not None else {},
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except (HTTPError, URLError, TimeoutError, OSError) as error:
        raise BenchmarkError(f"{method} {path}: {error}") from error
    return json.loads(raw) if raw else {}


def git_head(worktree: Path) -> str:
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=worktree, text=True, encoding="utf-8"
    ).strip()


def git_root(path: Path) -> Path:
    return Path(
        subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=path,
            text=True,
            encoding="utf-8",
        ).strip()
    ).resolve()


def git_source_changes(worktree: Path) -> list[str]:
    status = subprocess.check_output(
        ["git", "status", "--porcelain"], cwd=worktree, text=True, encoding="utf-8"
    )
    changes = []
    for line in status.splitlines():
        path = line[3:].replace("\\", "/")
        if path not in DEV_RUNTIME_ARTIFACTS:
            changes.append(line)
    return changes


def normalized_path(value: str | Path) -> str:
    return os.path.normcase(str(Path(value).resolve()))


def harness_identity() -> dict[str, Any]:
    script_path = Path(__file__).resolve()
    root = git_root(script_path.parent)
    source_changes = git_source_changes(root)
    if source_changes:
        raise BenchmarkError(f"benchmark harness worktree has source changes: {source_changes}")
    flood_script = script_path.with_name("terminal-output-flood.ps1")
    return {
        "worktreeRoot": str(root),
        "gitCommit": git_head(root),
        "script": str(script_path.relative_to(root)).replace("\\", "/"),
        "floodScriptSha256": hashlib.sha256(flood_script.read_bytes()).hexdigest(),
    }


def runtime_profile_facts() -> dict[str, Any]:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise BenchmarkError("APPDATA is required to identify dev runtime settings")
    settings_path = Path(appdata) / "laymux-dev" / "settings.json"
    if not settings_path.exists():
        return {"settingsPath": str(settings_path), "settingsFilePresent": False}
    raw = settings_path.read_bytes()
    try:
        settings = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BenchmarkError(
            f"cannot parse dev runtime settings {settings_path}: {error}"
        ) from error
    profile = next(
        (item for item in settings.get("profiles", []) if item.get("name") == "PowerShell"),
        None,
    )
    if profile is None:
        raise BenchmarkError("dev runtime settings has no PowerShell profile")
    relevant_profile_keys = (
        "name",
        "commandLine",
        "scrollbackLines",
        "antialiasingMode",
        "stabilizeInteractiveCursor",
        "maxOutputCacheKB",
        "font",
    )
    defaults = settings.get("profileDefaults") or {}
    return {
        "settingsPath": str(settings_path),
        "settingsFilePresent": True,
        "settingsSha256BeforeSetup": hashlib.sha256(raw).hexdigest(),
        "profile": {key: profile.get(key) for key in relevant_profile_keys if key in profile},
        "profileDefaults": {
            key: defaults.get(key) for key in relevant_profile_keys if key in defaults
        },
        "appearanceFont": ((settings.get("appearance") or {}).get("font")),
    }


def assert_dev_identity(expected_worktree: Path) -> dict[str, Any]:
    health = api("GET", "/health")
    instance = health.get("instance") or {}
    expected_head = git_head(expected_worktree)
    source_changes = git_source_changes(expected_worktree)
    if source_changes:
        raise BenchmarkError(f"expected worktree has source changes: {source_changes}")
    facts = {
        "status": health.get("status"),
        "port": health.get("port"),
        "buildKind": instance.get("buildKind"),
        "worktreeRoot": instance.get("worktreeRoot"),
        "gitCommit": instance.get("gitCommit"),
        "pid": instance.get("pid"),
    }
    if facts["status"] != "ok" or facts["port"] != PORT or facts["buildKind"] != "dev":
        raise BenchmarkError(f"not the dev 19281 instance: {facts}")
    if not facts["worktreeRoot"] or normalized_path(facts["worktreeRoot"]) != normalized_path(
        expected_worktree
    ):
        raise BenchmarkError(f"worktree identity mismatch: {facts}")
    if facts["gitCommit"] != expected_head:
        raise BenchmarkError(f"commit identity mismatch: expected {expected_head}, got {facts}")
    return facts


def wait_until(
    description: str,
    predicate,
    timeout: float = 30.0,
    interval: float = 0.1,
    cancel: threading.Event | None = None,
):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        if cancel is not None and cancel.is_set():
            raise BenchmarkError(f"cancelled while waiting for {description}")
        try:
            last = predicate()
            if last:
                return last
        except BenchmarkError as error:
            last = str(error)
        if cancel is not None:
            cancel.wait(interval)
        else:
            time.sleep(interval)
    raise BenchmarkError(f"timeout waiting for {description}; last={last!r}")


def active_workspace() -> dict[str, Any]:
    return api("GET", "/workspaces/active")["workspace"]


def select_source_layout() -> str:
    layouts = api("GET", "/layouts").get("layouts", [])
    if not layouts:
        raise BenchmarkError("no layout is available for a disposable benchmark workspace")
    preferred = next((item for item in layouts if item.get("id") == "default-layout"), layouts[0])
    layout_id = preferred.get("id")
    if not isinstance(layout_id, str) or not layout_id:
        raise BenchmarkError(f"selected layout has no valid id: {preferred!r}")
    return layout_id


def create_workspace(name: str, layout_id: str, resources: BenchmarkResources) -> str:
    # The saved layout is only a bootstrap. normalize_active_workspace reduces
    # it to one root pane before constructing deterministic benchmark geometry.
    created = api("POST", "/workspaces", {"name": name, "layoutId": layout_id})
    workspace_id = created["workspace"]["id"]
    resources.created_workspace_ids.append(workspace_id)
    api("POST", "/workspaces/active", {"id": workspace_id})
    wait_until("workspace activation", lambda: active_workspace().get("id") == workspace_id)
    return workspace_id


def cleanup_created_workspaces(resources: BenchmarkResources) -> None:
    snapshot = api("GET", "/workspaces")
    existing_ids = {item["id"] for item in snapshot["workspaces"]}
    targets = [
        workspace_id
        for workspace_id in resources.created_workspace_ids
        if workspace_id in existing_ids
    ]
    if not targets:
        return
    restore = resources.original_active_workspace_id
    if restore not in existing_ids or restore in targets:
        restore = next(
            (item["id"] for item in snapshot["workspaces"] if item["id"] not in targets),
            None,
        )
    if snapshot["activeWorkspaceId"] != restore:
        if restore is None:
            raise BenchmarkError("cannot clean benchmark workspaces without a fallback workspace")
        api("POST", "/workspaces/active", {"id": restore})
    for workspace_id in reversed(targets):
        api("DELETE", f"/workspaces/{quote(workspace_id, safe='')}")
    if resources.original_focused_terminal_id is not None:
        api(
            "POST",
            f"/terminals/{quote(resources.original_focused_terminal_id, safe='')}/focus",
        )


def ready_terminal_ids(
    instances: list[dict[str, Any]], workspace_id: str, total_panes: int
) -> list[str] | None:
    matching = [item for item in instances if item.get("workspaceId") == workspace_id]
    if (
        len(matching) != total_panes
        or any(item.get("sessionReady") is False for item in matching)
        or any(item.get("profile") != "PowerShell" for item in matching)
    ):
        return None
    return [item["id"] for item in sorted(matching, key=lambda item: item.get("paneIndex", 0))]


def normalize_active_workspace(total_panes: int) -> list[str]:
    # Reduce every disposable benchmark workspace to the same full-size root
    # before splitting. Merely matching pane count would preserve a user's
    # layout geometry and could turn some panes into 0 px background owners.
    while len(active_workspace()["panes"]) > 1:
        api("DELETE", f"/panes/{len(active_workspace()['panes']) - 1}")
    if not active_workspace()["panes"]:
        raise BenchmarkError("benchmark source layout has no pane to split")
    while len(active_workspace()["panes"]) < total_panes:
        panes = active_workspace()["panes"]
        pane_index, pane = max(
            enumerate(panes),
            key=lambda item: (
                float(item[1].get("w") or 0) * float(item[1].get("h") or 0),
                -item[0],
            ),
        )
        api(
            "POST",
            "/panes/split",
            {
                "paneIndex": pane_index,
                "direction": "vertical"
                if float(pane.get("w") or 0) >= float(pane.get("h") or 0)
                else "horizontal",
            },
        )
    workspace = active_workspace()
    for index, pane in enumerate(workspace["panes"]):
        view = pane.get("view") or {}
        if view.get("type") != "TerminalView" or view.get("profile") != "PowerShell":
            api(
                "PUT",
                f"/panes/{index}/view",
                {"type": "TerminalView", "profile": "PowerShell"},
            )
    workspace_id = workspace["id"]

    def ready_terminals():
        instances = api("GET", "/terminals").get("instances", [])
        return ready_terminal_ids(instances, workspace_id, total_panes)

    return wait_until("terminal sessions", ready_terminals, timeout=60.0)


def shell_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def terminal_write(terminal_id: str, data: str) -> None:
    api("POST", f"/terminals/{quote(terminal_id, safe='')}/write", {"data": data})


def terminal_output(terminal_id: str, lines: int = 8) -> str:
    result = api("GET", f"/terminals/{quote(terminal_id, safe='')}/output?lines={lines}")
    return str(result.get("output", ""))


def buffer_logical_text(terminal_id: str) -> str:
    result = api("GET", f"/terminals/{quote(terminal_id, safe='')}/buffer?limit=40")
    logical_lines: list[str] = []
    current = ""
    for line in result.get("lines", []):
        text = str(line.get("text", ""))
        if line.get("isWrapped"):
            current += text
        else:
            if current:
                logical_lines.append(current)
            current = text
    if current:
        logical_lines.append(current)
    return "\n".join(logical_lines)


def buffer_contains(terminal_id: str, marker: str) -> bool:
    return marker in buffer_logical_text(terminal_id)


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(fraction * len(ordered)) - 1))
    return round(ordered[index], 3)


def latency_summary(samples: list[dict[str, Any]]) -> dict[str, Any]:
    ok = [sample["latencyMs"] for sample in samples if sample.get("ok")]
    return {
        "samples": len(samples),
        "successes": len(ok),
        "timeoutsOrErrors": len(samples) - len(ok),
        "p50Ms": percentile(ok, 0.50),
        "p95Ms": percentile(ok, 0.95),
        "p99Ms": percentile(ok, 0.99),
        "maxMs": round(max(ok), 3) if ok else None,
    }


def timed_request(method: str, path: str, payload: Any | None = None) -> dict[str, Any]:
    started = time.monotonic()
    try:
        result = api(method, path, payload)
        return {"ok": True, "latencyMs": (time.monotonic() - started) * 1000, "result": result}
    except BenchmarkError as error:
        return {
            "ok": False,
            "latencyMs": (time.monotonic() - started) * 1000,
            "error": str(error),
        }


def terminal_diagnostics(snapshot: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        entry["terminalId"]: entry
        for entry in snapshot.get("terminalOutput", [])
        if isinstance(entry, dict) and isinstance(entry.get("terminalId"), str)
    }


def settled_frontiers(
    snapshot: dict[str, Any], terminal_ids: list[str]
) -> dict[str, Any] | None:
    backend = terminal_diagnostics(snapshot)
    frontend = (snapshot.get("frontend") or {}).get("terminalOutputV3") or {}
    for terminal_id in terminal_ids:
        back = backend.get(terminal_id) or {}
        front = frontend.get(terminal_id) or {}
        if not (
            back.get("desktopOutputState") == "healthy"
            and back.get("reason") is None
            and back.get("parsedAck") == back.get("writeSeq") == back.get("ringEndSeq")
            and back.get("deliveryObservedSeq") == back.get("writeSeq")
            and front.get("state") == "active"
            and front.get("reason") is None
            and front.get("admittedSeq") == front.get("parsedSeq") == back.get("writeSeq")
        ):
            return None
    return snapshot


def has_minimum_parser_backlog(
    snapshot: dict[str, Any],
    terminal_ids: list[str],
    minimum_bytes: int = CATCHUP_MIN_BACKLOG_BYTES,
) -> bool:
    backend = terminal_diagnostics(snapshot)
    return all(
        int((backend.get(terminal_id) or {}).get("writeSeq") or 0)
        - int((backend.get(terminal_id) or {}).get("parsedAck") or 0)
        >= minimum_bytes
        for terminal_id in terminal_ids
    )


def pipeline_counters_unchanged(
    initial: dict[str, dict[str, Any]],
    final: dict[str, dict[str, Any]],
    terminal_ids: list[str],
    counters: list[str],
) -> bool:
    if any(terminal_id not in initial or terminal_id not in final for terminal_id in terminal_ids):
        return False
    if any(
        counter not in initial[terminal_id] or counter not in final[terminal_id]
        for terminal_id in terminal_ids
        for counter in counters
    ):
        return False
    return all(
        int(final[terminal_id][counter]) == int(initial[terminal_id][counter])
        for terminal_id in terminal_ids
        for counter in counters
    )


def longest_backlog_service_gaps(
    samples: list[dict[str, Any]], terminal_ids: list[str]
) -> dict[str, float]:
    longest = {terminal_id: 0.0 for terminal_id in terminal_ids}
    last_progress_ms = {terminal_id: 0.0 for terminal_id in terminal_ids}
    last_parsed: dict[str, int | None] = {terminal_id: None for terminal_id in terminal_ids}
    backlogged = {terminal_id: False for terminal_id in terminal_ids}
    for sample in samples:
        if not sample.get("ok"):
            continue
        at_ms = float(sample["atMs"])
        for terminal_id, entry in terminal_diagnostics(sample["result"]).items():
            if terminal_id not in last_parsed:
                continue
            parsed = entry.get("parsedAck")
            has_backlog = entry.get("writeSeq", 0) > (parsed or 0)
            if parsed != last_parsed[terminal_id] or (has_backlog and not backlogged[terminal_id]):
                last_parsed[terminal_id] = parsed
                last_progress_ms[terminal_id] = at_ms
            if has_backlog:
                longest[terminal_id] = max(
                    longest[terminal_id], at_ms - last_progress_ms[terminal_id]
                )
            else:
                last_progress_ms[terminal_id] = at_ms
            backlogged[terminal_id] = has_backlog
    return longest


def run(args: argparse.Namespace, resources: BenchmarkResources) -> dict[str, Any]:
    if os.name != "nt":
        raise BenchmarkError("issue #661 flood benchmark is Windows-only")
    expected_worktree = Path(args.expected_worktree).resolve()
    identity = assert_dev_identity(expected_worktree)
    harness = harness_identity()
    runtime_profile = runtime_profile_facts()
    resources.failure_context = {
        "appIdentity": identity,
        "harnessIdentity": harness,
        "runtimeProfile": runtime_profile,
    }
    run_id = args.run_id
    root_name = f"bench-661-{run_id}"
    workspace_snapshot = api("GET", "/workspaces")
    resources.original_active_workspace_id = workspace_snapshot.get("activeWorkspaceId")
    original_terminals = api("GET", "/terminals").get("instances", [])
    resources.original_focused_terminal_id = next(
        (
            item["id"]
            for item in original_terminals
            if item.get("workspaceId") == resources.original_active_workspace_id
            and item.get("isFocused")
        ),
        None,
    )
    temp_root = Path(tempfile.gettempdir()) / "laymux-661" / run_id
    temp_root.mkdir(parents=True, exist_ok=True)
    barrier = temp_root / "go"
    if barrier.exists():
        barrier.unlink()

    source_layout_id = select_source_layout()
    existing_names = {item.get("name") for item in workspace_snapshot.get("workspaces", [])}
    requested_names = {f"{root_name}-hot", f"{root_name}-control"}
    collisions = sorted(existing_names & requested_names)
    if collisions:
        raise BenchmarkError(f"run-id workspace names already exist: {collisions}")
    create_workspace(f"{root_name}-hot", source_layout_id, resources)
    if args.scenario == "active":
        terminals = normalize_active_workspace(args.hot_panes + 1)
        hot_terminals, control_terminal = terminals[:-1], terminals[-1]
    else:
        hot_terminals = normalize_active_workspace(args.hot_panes)
        create_workspace(f"{root_name}-control", source_layout_id, resources)
        control_terminal = normalize_active_workspace(1)[0]
    measured_terminals = hot_terminals + [control_terminal]

    api("POST", f"/terminals/{quote(control_terminal, safe='')}/focus")
    wait_until(
        "initial v3 attach and idle frontiers",
        lambda: settled_frontiers(
            api("GET", "/diagnostics/frontend"), measured_terminals
        ),
        timeout=60.0,
    )
    flood_script = Path(__file__).with_name("terminal-output-flood.ps1").resolve()
    armed_markers: dict[str, str] = {}
    final_markers: dict[str, str] = {}
    for terminal_id in hot_terminals:
        armed = f"ARMED-{run_id}-{terminal_id}"
        final = f"FINAL-{run_id}-{terminal_id}-{args.lines}"
        armed_markers[terminal_id] = armed
        final_markers[terminal_id] = final
        command = (
            "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "
            f"{shell_quote(str(flood_script))} -Lines {args.lines} "
            f"-RunId {shell_quote(run_id)} -TerminalId {shell_quote(terminal_id)} "
            f"-BarrierPath {shell_quote(str(barrier))} -FlushEvery {args.flush_every}\r"
        )
        terminal_write(terminal_id, command)
    for terminal_id, marker in armed_markers.items():
        wait_until(
            f"armed marker {terminal_id}",
            lambda terminal_id=terminal_id, marker=marker: marker in terminal_output(terminal_id),
            timeout=60.0,
        )
    armed_diag = wait_until(
        "armed v3 idle frontiers",
        lambda: settled_frontiers(api("GET", "/diagnostics/frontend"), measured_terminals),
        timeout=60.0,
    )
    setup_workspaces = api("GET", "/workspaces")
    setup_terminals = api("GET", "/terminals").get("instances", [])
    setup_surfaces = {
        terminal_id: {
            key: value
            for key, value in api(
                "GET", f"/terminals/{quote(terminal_id, safe='')}/buffer?limit=1"
            ).items()
            if key in {"cols", "rows"}
        }
        for terminal_id in measured_terminals
    }

    stop = threading.Event()
    diagnostics_samples: list[dict[str, Any]] = []
    bridge_samples: list[dict[str, Any]] = []
    screenshot_samples: list[dict[str, Any]] = []
    control_samples: list[dict[str, Any]] = []
    frontier_catchup_samples: list[dict[str, Any]] = []
    resources.failure_context.update({
        "hotTerminals": hot_terminals,
        "controlTerminal": control_terminal,
        "workspaceGeometry": setup_workspaces,
        "terminalSurfaces": setup_surfaces,
        "samples": {
            "diagnostics": diagnostics_samples,
            "bridge": bridge_samples,
            "screenshot": screenshot_samples,
            "control": control_samples,
            "checkpointTargetCatchup": frontier_catchup_samples,
        },
    })

    def diagnostics_loop() -> None:
        while not stop.is_set():
            sample = timed_request("GET", "/diagnostics/frontend")
            sample["atMs"] = round((time.monotonic() - flood_started) * 1000, 3)
            diagnostics_samples.append(sample)
            stop.wait(0.1)

    def bridge_loop() -> None:
        paths = ["/workspaces/active", "/grid"]
        index = 0
        while not stop.is_set():
            sample = timed_request("GET", paths[index % len(paths)])
            sample["path"] = paths[index % len(paths)]
            sample["atMs"] = round((time.monotonic() - flood_started) * 1000, 3)
            bridge_samples.append(sample)
            index += 1
            stop.wait(0.2)

    def control_probe() -> None:
        stop.wait(0.5)
        if stop.is_set():
            return
        try:
            marker = f"CONTROL-{run_id}"
            started = time.monotonic()
            write_sample = timed_request(
                "POST",
                f"/terminals/{quote(control_terminal, safe='')}/write",
                {"data": f"echo {marker}\r"},
            )
            backend_at = wait_until(
                "control PTY echo",
                lambda: time.monotonic() if marker in terminal_output(control_terminal) else None,
                timeout=15.0,
                interval=0.02,
                cancel=stop,
            )
            buffer_at = wait_until(
                "control xterm echo",
                lambda: time.monotonic() if buffer_contains(control_terminal, marker) else None,
                timeout=15.0,
                interval=0.02,
                cancel=stop,
            )
            control_samples.append(
                {
                    "write": write_sample,
                    "backendEchoMs": round((backend_at - started) * 1000, 3),
                    "xtermEchoMs": round((buffer_at - started) * 1000, 3),
                }
            )
        except BenchmarkError as error:
            control_samples.append({"error": str(error)})

    def screenshot_probe() -> None:
        stop.wait(1.0)
        if not stop.is_set():
            sample = timed_request("POST", "/screenshot", {})
            result = sample.get("result")
            if isinstance(result, dict) and isinstance(result.get("dataUrl"), str):
                data_url = result.pop("dataUrl")
                sample["dataUrlBytes"] = len(data_url)
            screenshot_samples.append(sample)

    def frontier_catchup_probe() -> None:
        stop.wait(0.5)
        if stop.is_set():
            return
        try:
            backlog_deadline = time.monotonic() + 5.0
            target_snapshot = None
            target_capture_started = None
            target_capture_ms = None
            while not stop.is_set() and time.monotonic() < backlog_deadline:
                capture_started = time.monotonic()
                candidate = api("GET", "/diagnostics/frontend")
                capture_finished = time.monotonic()
                if has_minimum_parser_backlog(
                    candidate, hot_terminals, args.catchup_min_backlog_bytes
                ):
                    target_snapshot = candidate
                    target_capture_started = capture_started
                    target_capture_ms = (capture_finished - capture_started) * 1000
                    break
                time.sleep(0.02)
            if target_snapshot is None:
                raise BenchmarkError(
                    "benchmark precondition unmet: no single diagnostics response contained "
                    f"at least {args.catchup_min_backlog_bytes} parser-backlog bytes on every "
                    "hot pane"
                )
            assert target_capture_started is not None
            started = target_capture_started
            target_backend = terminal_diagnostics(target_snapshot)
            targets = {
                terminal_id: int((target_backend.get(terminal_id) or {}).get("writeSeq") or 0)
                for terminal_id in hot_terminals
            }
            starting_parsed = {
                terminal_id: int((target_backend.get(terminal_id) or {}).get("parsedAck") or 0)
                for terminal_id in hot_terminals
            }
            reached_at: dict[str, float] = {}
            deadline = started + 5.0
            while (
                not stop.is_set()
                and len(reached_at) < len(targets)
                and time.monotonic() < deadline
            ):
                snapshot = api("GET", "/diagnostics/frontend")
                backend = terminal_diagnostics(snapshot)
                now = time.monotonic()
                for terminal_id, target in targets.items():
                    if terminal_id in reached_at:
                        continue
                    if int((backend.get(terminal_id) or {}).get("parsedAck") or 0) >= target:
                        reached_at[terminal_id] = now
                if len(reached_at) < len(targets):
                    time.sleep(0.02)
            missing = sorted(set(targets) - set(reached_at))
            frontier_catchup_samples.append(
                {
                    "ok": not missing,
                    # The backend collects per-terminal entries sequentially.
                    # Start the bound before that entire response so a pane
                    # that drains early cannot make the result optimistic.
                    "targetCaptureResponseMs": round(float(target_capture_ms or 0), 3),
                    "targetSeq": targets,
                    "startingParsedSeq": starting_parsed,
                    "backlogBytes": {
                        terminal_id: targets[terminal_id] - starting_parsed[terminal_id]
                        for terminal_id in hot_terminals
                    },
                    "perTerminalMs": {
                        terminal_id: round((reached - started) * 1000, 3)
                        for terminal_id, reached in reached_at.items()
                    },
                    "maxMs": round(
                        max((reached - started) * 1000 for reached in reached_at.values()), 3
                    )
                    if reached_at
                    else None,
                    "missing": missing,
                }
            )
        except BenchmarkError as error:
            frontier_catchup_samples.append({"ok": False, "error": str(error)})

    flood_started = time.monotonic()
    workers = [
        threading.Thread(target=diagnostics_loop, daemon=True),
        threading.Thread(target=bridge_loop, daemon=True),
        threading.Thread(target=control_probe, daemon=True),
        threading.Thread(target=screenshot_probe, daemon=True),
        threading.Thread(target=frontier_catchup_probe, daemon=True),
    ]
    completed_at: dict[str, float] = {}
    started_workers: list[threading.Thread] = []
    try:
        for worker in workers:
            worker.start()
            started_workers.append(worker)
        barrier.write_text("go", encoding="utf-8")

        deadline = flood_started + args.timeout
        while len(completed_at) < len(hot_terminals) and time.monotonic() < deadline:
            for terminal_id, marker in final_markers.items():
                if terminal_id not in completed_at and marker in terminal_output(terminal_id):
                    completed_at[terminal_id] = time.monotonic()
            time.sleep(0.1)
        if len(completed_at) != len(hot_terminals):
            missing = sorted(set(hot_terminals) - set(completed_at))
            raise BenchmarkError(f"flood timed out; missing FINAL for {missing}")

        final_diag = wait_until(
            "all parser frontiers",
            lambda: settled_frontiers(api("GET", "/diagnostics/frontend"), measured_terminals),
            timeout=30.0,
        )
        frontiers_settled_at = time.monotonic()
        final_buffer_text = {
            terminal_id: buffer_logical_text(terminal_id) for terminal_id in hot_terminals
        }
        buffer_final = {
            terminal_id: final_buffer_text[terminal_id].count(final_markers[terminal_id]) == 1
            and all(
                foreign_marker not in final_buffer_text[terminal_id]
                for foreign_id, foreign_marker in final_markers.items()
                if foreign_id != terminal_id
            )
            for terminal_id in hot_terminals
        }
    finally:
        stop.set()
        for worker in started_workers:
            worker.join(timeout=8.0)
        resources.failure_context["workersAliveAfterJoin"] = [
            worker.name for worker in started_workers if worker.is_alive()
        ]
        if resources.failure_context["workersAliveAfterJoin"]:
            alive = resources.failure_context["workersAliveAfterJoin"]
            raise BenchmarkError(f"benchmark workers did not stop: {alive}")

    longest_service_gap_ms = longest_backlog_service_gaps(diagnostics_samples, hot_terminals)

    successful_diag = [sample["result"] for sample in diagnostics_samples if sample.get("ok")]
    report_ages = [
        float(item["lastReportAgeMs"])
        for item in successful_diag
        if isinstance(item.get("lastReportAgeMs"), (int, float))
    ]
    pipeline = (final_diag.get("frontend") or {}).get("pipeline") or {}
    frontend_v3 = (final_diag.get("frontend") or {}).get("terminalOutputV3") or {}
    final_backend = terminal_diagnostics(final_diag)
    initial_frontend = armed_diag.get("frontend") or {}
    final_frontend = final_diag.get("frontend") or {}
    initial_pipeline = initial_frontend.get("pipeline") or {}
    bridge_by_path = {
        path: latency_summary([sample for sample in bridge_samples if sample.get("path") == path])
        for path in ["/workspaces/active", "/grid"]
    }
    max_service_gap = max(longest_service_gap_ms.values(), default=0.0)
    control_ok = bool(control_samples) and all("error" not in item for item in control_samples)
    catchup_ok = bool(frontier_catchup_samples) and all(
        sample.get("ok") and float(sample.get("maxMs") or 0) < 3_000
        for sample in frontier_catchup_samples
    )
    acceptance = {
        "workersStopped": not resources.failure_context["workersAliveAfterJoin"],
        "frontiersSettled": True,
        "allFinalMarkersRendered": all(buffer_final.values()),
        "backgroundServiceGapUnder3s": max_service_gap < 3_000,
        "bridgeHadNoErrors": bool(bridge_samples)
        and all(sample.get("ok") for sample in bridge_samples)
        and all(
            any(sample.get("path") == path for sample in bridge_samples)
            for path in bridge_by_path
        ),
        "diagnosticsHadNoErrors": bool(diagnostics_samples)
        and all(sample.get("ok") for sample in diagnostics_samples),
        "screenshotSucceeded": bool(screenshot_samples)
        and all(sample.get("ok") for sample in screenshot_samples),
        "automationControlEchoSucceeded": control_ok,
        "checkpointTargetCatchupUnder3s": catchup_ok,
        "noRepairWasNeeded": all(
            (frontend_v3.get(terminal_id) or {}).get("repairCount") == 0
            and (frontend_v3.get(terminal_id) or {}).get("lastRepairReason") is None
            for terminal_id in measured_terminals
        ),
        "noWriteCallbackFailed": all(
            terminal_id in pipeline
            and "writeCallbackFailures" in pipeline[terminal_id]
            and all(
                not key.endswith("Failures") or value == 0
                for key, value in pipeline[terminal_id].items()
            )
            for terminal_id in measured_terminals
        ),
        "noFullReattachDuringFlood": pipeline_counters_unchanged(
            initial_pipeline,
            pipeline,
            measured_terminals,
            ["attaches", "attachReplayBytes"],
        ),
    }
    acceptance["passed"] = all(acceptance.values())
    summary = {
        "runId": run_id,
        "identity": identity,
        "harnessIdentity": harness,
        "scenario": args.scenario,
        "hotPanes": args.hot_panes,
        "controlTerminal": control_terminal,
        "linesPerHotPane": args.lines,
        "flushEvery": args.flush_every,
        "catchupMinBacklogBytes": args.catchup_min_backlog_bytes,
        "environment": {
            "platform": platform.platform(),
            "processor": platform.processor(),
            "python": platform.python_version(),
            "shellProfile": "PowerShell",
            "sourceLayoutId": source_layout_id,
            "workspaceGeometry": {
                item["id"]: [
                    {
                        key: pane.get(key)
                        for key in ("id", "x", "y", "w", "h")
                    }
                    for pane in item.get("panes", [])
                ]
                for item in setup_workspaces.get("workspaces", [])
                if item.get("id") in resources.created_workspace_ids
            },
            "terminalSurfaces": setup_surfaces,
            "terminalProfiles": {
                item["id"]: item.get("profile")
                for item in setup_terminals
                if item.get("id") in measured_terminals
            },
            "runtimeProfile": runtime_profile,
        },
        "elapsedToLastFinalMs": round((max(completed_at.values()) - flood_started) * 1000, 3),
        "elapsedToSettledFrontiersMs": round(
            (frontiers_settled_at - flood_started) * 1000, 3
        ),
        "perPaneFinalMs": {
            terminal_id: round((completed - flood_started) * 1000, 3)
            for terminal_id, completed in completed_at.items()
        },
        "aggregateLinesPerSecond": round(
            args.lines * len(hot_terminals) / (max(completed_at.values()) - flood_started), 3
        ),
        "bridge": latency_summary(bridge_samples),
        "bridgeByPath": bridge_by_path,
        "diagnostics": latency_summary(diagnostics_samples),
        "screenshot": latency_summary(screenshot_samples),
        "control": control_samples,
        "checkpointTargetCatchup": frontier_catchup_samples,
        "maxFrontendReportAgeMs": round(max(report_ages), 3) if report_ages else None,
        "stallDelta": (final_frontend.get("stalls") or 0) - (initial_frontend.get("stalls") or 0),
        "bridgeTimeoutDelta": (final_diag.get("bridge") or {}).get("requestTimeouts", 0)
        - (armed_diag.get("bridge") or {}).get("requestTimeouts", 0),
        "longestBacklogServiceGapMs": {
            key: round(value, 3) for key, value in longest_service_gap_ms.items()
        },
        "bufferFinalMarker": buffer_final,
        "backendFinal": {
            terminal_id: final_backend.get(terminal_id) for terminal_id in measured_terminals
        },
        "frontendFinal": {
            terminal_id: frontend_v3.get(terminal_id) for terminal_id in measured_terminals
        },
        "pipelineFinal": {
            terminal_id: pipeline.get(terminal_id) for terminal_id in measured_terminals
        },
        "acceptance": acceptance,
    }
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(
            {
                "summary": summary,
                "samples": {
                    "diagnostics": diagnostics_samples,
                    "bridge": bridge_samples,
                    "screenshot": screenshot_samples,
                },
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-worktree", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--scenario", choices=["active", "background"], default="background")
    parser.add_argument("--hot-panes", type=int, choices=[2, 4, 7, 8], required=True)
    parser.add_argument("--lines", type=int, default=150_000)
    parser.add_argument("--flush-every", type=int, default=256)
    parser.add_argument(
        "--catchup-min-backlog-bytes", type=int, default=CATCHUP_MIN_BACKLOG_BYTES
    )
    parser.add_argument("--timeout", type=float, default=300.0)
    parser.add_argument("--run-id")
    parser.add_argument("--cleanup", action="store_true")
    args = parser.parse_args()
    if args.lines < 1 or args.flush_every < 1:
        parser.error("--lines and --flush-every must be positive")
    if args.catchup_min_backlog_bytes < CATCHUP_MIN_BACKLOG_BYTES:
        parser.error(
            f"--catchup-min-backlog-bytes must be at least {CATCHUP_MIN_BACKLOG_BYTES}"
        )
    if args.run_id is None:
        args.run_id = f"r{int(time.time() * 1000)}-{os.getpid()}"
    if not RUN_ID_PATTERN.fullmatch(args.run_id):
        parser.error("--run-id must match [A-Za-z0-9][A-Za-z0-9_.-]{0,63}")
    summary: dict[str, Any] | None = None
    resources = BenchmarkResources()
    primary_error: BaseException | None = None
    report_error: BaseException | None = None
    cleanup_error: BaseException | None = None
    try:
        summary = run(args, resources)
    except BaseException as error:
        primary_error = error
        if isinstance(error, BenchmarkError):
            try:
                try:
                    failure_snapshot = api("GET", "/diagnostics/frontend")
                except BenchmarkError as snapshot_error:
                    failure_snapshot = {"error": str(snapshot_error)}
                output = Path(args.output).resolve()
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_text(
                    json.dumps(
                        {
                            "error": str(error),
                            "runId": args.run_id,
                            "finalDiagnostics": failure_snapshot,
                            "partialRun": resources.failure_context,
                        },
                        ensure_ascii=False,
                        indent=2,
                    ),
                    encoding="utf-8",
                )
            except BaseException as error_writing_report:
                report_error = error_writing_report
    finally:
        if args.cleanup:
            try:
                cleanup_created_workspaces(resources)
            except BaseException as error_cleaning_up:
                cleanup_error = error_cleaning_up

    if primary_error is not None:
        details = [f"benchmark failed: {primary_error}"]
        if report_error is not None:
            details.append(f"failure report write failed: {report_error}")
        if cleanup_error is not None:
            details.append(f"cleanup failed: {cleanup_error}")
        if isinstance(primary_error, BenchmarkError):
            parser.exit(2, "; ".join(details) + "\n")
        if report_error is not None or cleanup_error is not None:
            print("; ".join(details), file=sys.stderr)
        raise primary_error
    if cleanup_error is not None:
        raise cleanup_error
    assert summary is not None
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary.get("acceptance", {}).get("passed") else 3


if __name__ == "__main__":
    raise SystemExit(main())
