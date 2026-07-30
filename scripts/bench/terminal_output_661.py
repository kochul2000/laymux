#!/usr/bin/env python3
"""Issue #661 deterministic multi-pane flood benchmark (dev port 19281 only)."""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


PORT = 19281
BASE = f"http://127.0.0.1:{PORT}/api/v1"


class BenchmarkError(RuntimeError):
    pass


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
    except (HTTPError, URLError, TimeoutError) as error:
        raise BenchmarkError(f"{method} {path}: {error}") from error
    return json.loads(raw) if raw else {}


def git_head(worktree: Path) -> str:
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=worktree, text=True, encoding="utf-8"
    ).strip()


def normalized_path(value: str | Path) -> str:
    return os.path.normcase(str(Path(value).resolve()))


def assert_dev_identity(expected_worktree: Path) -> dict[str, Any]:
    health = api("GET", "/health")
    instance = health.get("instance") or {}
    expected_head = git_head(expected_worktree)
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


def wait_until(description: str, predicate, timeout: float = 30.0, interval: float = 0.1):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = predicate()
            if last:
                return last
        except BenchmarkError as error:
            last = str(error)
        time.sleep(interval)
    raise BenchmarkError(f"timeout waiting for {description}; last={last!r}")


def active_workspace() -> dict[str, Any]:
    return api("GET", "/workspaces/active")["workspace"]


def create_workspace(name: str) -> str:
    created = api("POST", "/workspaces", {"name": name})
    workspace_id = created["workspace"]["id"]
    api("POST", "/workspaces/active", {"id": workspace_id})
    wait_until("workspace activation", lambda: active_workspace().get("id") == workspace_id)
    return workspace_id


def normalize_active_workspace(total_panes: int) -> list[str]:
    while len(active_workspace()["panes"]) > total_panes:
        api("DELETE", f"/panes/{len(active_workspace()['panes']) - 1}")
    while len(active_workspace()["panes"]) < total_panes:
        count = len(active_workspace()["panes"])
        api(
            "POST",
            "/panes/split",
            {"paneIndex": max(0, count - 1), "direction": "vertical" if count % 2 else "horizontal"},
        )
    workspace = active_workspace()
    for index, pane in enumerate(workspace["panes"]):
        if (pane.get("view") or {}).get("type") != "TerminalView":
            api("PUT", f"/panes/{index}/view", {"type": "TerminalView"})
    workspace_id = workspace["id"]

    def ready_terminals():
        instances = api("GET", "/terminals").get("instances", [])
        matching = [item for item in instances if item.get("workspaceId") == workspace_id]
        if len(matching) != total_panes or any(item.get("sessionReady") is False for item in matching):
            return None
        return [item["id"] for item in sorted(matching, key=lambda item: item.get("paneIndex", 0))]

    return wait_until("terminal sessions", ready_terminals, timeout=60.0)


def shell_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def terminal_write(terminal_id: str, data: str) -> None:
    api("POST", f"/terminals/{quote(terminal_id, safe='')}/write", {"data": data})


def terminal_output(terminal_id: str, lines: int = 8) -> str:
    result = api("GET", f"/terminals/{quote(terminal_id, safe='')}/output?lines={lines}")
    return str(result.get("output", ""))


def buffer_contains(terminal_id: str, marker: str) -> bool:
    result = api("GET", f"/terminals/{quote(terminal_id, safe='')}/buffer?limit=40")
    return marker in json.dumps(result, ensure_ascii=False)


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


def longest_backlog_service_gaps(
    samples: list[dict[str, Any]], terminal_ids: list[str]
) -> dict[str, float]:
    longest = {terminal_id: 0.0 for terminal_id in terminal_ids}
    last_progress_ms = {terminal_id: 0.0 for terminal_id in terminal_ids}
    last_parsed: dict[str, int | None] = {terminal_id: None for terminal_id in terminal_ids}
    for sample in samples:
        if not sample.get("ok"):
            continue
        at_ms = float(sample["atMs"])
        for terminal_id, entry in terminal_diagnostics(sample["result"]).items():
            if terminal_id not in last_parsed:
                continue
            parsed = entry.get("parsedAck")
            if parsed != last_parsed[terminal_id]:
                last_parsed[terminal_id] = parsed
                last_progress_ms[terminal_id] = at_ms
            if entry.get("writeSeq", 0) > (parsed or 0):
                longest[terminal_id] = max(longest[terminal_id], at_ms - last_progress_ms[terminal_id])
    return longest


def run(args: argparse.Namespace) -> dict[str, Any]:
    expected_worktree = Path(args.expected_worktree).resolve()
    identity = assert_dev_identity(expected_worktree)
    run_id = args.run_id or f"r{int(time.time())}"
    root_name = f"bench-661-{run_id}"
    created_workspaces: list[str] = []
    temp_root = Path(tempfile.gettempdir()) / "laymux-661" / run_id
    temp_root.mkdir(parents=True, exist_ok=True)
    barrier = temp_root / "go"
    if barrier.exists():
        barrier.unlink()

    hot_workspace = create_workspace(f"{root_name}-hot")
    created_workspaces.append(hot_workspace)
    hot_terminals = normalize_active_workspace(args.hot_panes)
    if args.scenario == "active":
        api("POST", "/panes/split", {"paneIndex": len(hot_terminals) - 1, "direction": "horizontal"})
        terminals = normalize_active_workspace(args.hot_panes + 1)
        hot_terminals, control_terminal = terminals[:-1], terminals[-1]
    else:
        control_workspace = create_workspace(f"{root_name}-control")
        created_workspaces.append(control_workspace)
        control_terminal = normalize_active_workspace(1)[0]

    api("POST", f"/terminals/{quote(control_terminal, safe='')}/focus")
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

    initial_diag = api("GET", "/diagnostics/frontend")
    stop = threading.Event()
    diagnostics_samples: list[dict[str, Any]] = []
    bridge_samples: list[dict[str, Any]] = []
    screenshot_samples: list[dict[str, Any]] = []
    control_samples: list[dict[str, Any]] = []

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
            )
            buffer_at = wait_until(
                "control xterm echo",
                lambda: time.monotonic() if buffer_contains(control_terminal, marker) else None,
                timeout=15.0,
                interval=0.02,
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
            screenshot_samples.append(timed_request("POST", "/screenshot", {}))

    flood_started = time.monotonic()
    workers = [
        threading.Thread(target=diagnostics_loop, daemon=True),
        threading.Thread(target=bridge_loop, daemon=True),
        threading.Thread(target=control_probe, daemon=True),
        threading.Thread(target=screenshot_probe, daemon=True),
    ]
    for worker in workers:
        worker.start()
    barrier.write_text("go", encoding="utf-8")

    completed_at: dict[str, float] = {}
    deadline = flood_started + args.timeout
    while len(completed_at) < len(hot_terminals) and time.monotonic() < deadline:
        for terminal_id, marker in final_markers.items():
            if terminal_id not in completed_at and marker in terminal_output(terminal_id):
                completed_at[terminal_id] = time.monotonic()
        time.sleep(0.1)
    if len(completed_at) != len(hot_terminals):
        missing = sorted(set(hot_terminals) - set(completed_at))
        raise BenchmarkError(f"flood timed out; missing FINAL for {missing}")

    def all_frontiers_settled():
        snapshot = api("GET", "/diagnostics/frontend")
        backend = terminal_diagnostics(snapshot)
        frontend = (snapshot.get("frontend") or {}).get("terminalOutputV3") or {}
        for terminal_id in hot_terminals:
            back = backend.get(terminal_id) or {}
            front = frontend.get(terminal_id) or {}
            if not (
                back.get("desktopOutputState") == "active"
                and back.get("reason") is None
                and back.get("parsedAck") == back.get("writeSeq") == back.get("ringEndSeq")
                and back.get("deliveryObservedSeq") == back.get("writeSeq")
                and front.get("state") == "active"
                and front.get("reason") is None
                and front.get("admittedSeq") == front.get("parsedSeq") == back.get("writeSeq")
            ):
                return None
        return snapshot

    final_diag = wait_until("all parser frontiers", all_frontiers_settled, timeout=30.0)
    buffer_final = {
        terminal_id: buffer_contains(terminal_id, final_markers[terminal_id])
        for terminal_id in hot_terminals
    }
    stop.set()
    for worker in workers:
        worker.join(timeout=8.0)

    longest_service_gap_ms = longest_backlog_service_gaps(diagnostics_samples, hot_terminals)

    successful_diag = [sample["result"] for sample in diagnostics_samples if sample.get("ok")]
    report_ages = [float(item.get("lastReportAgeMs") or 0) for item in successful_diag]
    pipeline = (final_diag.get("frontend") or {}).get("pipeline") or {}
    frontend_v3 = (final_diag.get("frontend") or {}).get("terminalOutputV3") or {}
    final_backend = terminal_diagnostics(final_diag)
    initial_frontend = initial_diag.get("frontend") or {}
    final_frontend = final_diag.get("frontend") or {}
    summary = {
        "runId": run_id,
        "identity": identity,
        "scenario": args.scenario,
        "hotPanes": args.hot_panes,
        "controlTerminal": control_terminal,
        "linesPerHotPane": args.lines,
        "flushEvery": args.flush_every,
        "elapsedToLastFinalMs": round((max(completed_at.values()) - flood_started) * 1000, 3),
        "perPaneFinalMs": {
            terminal_id: round((completed - flood_started) * 1000, 3)
            for terminal_id, completed in completed_at.items()
        },
        "aggregateLinesPerSecond": round(
            args.lines * len(hot_terminals) / (max(completed_at.values()) - flood_started), 3
        ),
        "bridge": latency_summary(bridge_samples),
        "diagnostics": latency_summary(diagnostics_samples),
        "screenshot": latency_summary(screenshot_samples),
        "control": control_samples,
        "maxFrontendReportAgeMs": round(max(report_ages), 3) if report_ages else None,
        "stallDelta": (final_frontend.get("stalls") or 0) - (initial_frontend.get("stalls") or 0),
        "bridgeTimeoutDelta": (final_diag.get("bridge") or {}).get("requestTimeouts", 0)
        - (initial_diag.get("bridge") or {}).get("requestTimeouts", 0),
        "longestBacklogServiceGapMs": {
            key: round(value, 3) for key, value in longest_service_gap_ms.items()
        },
        "bufferFinalMarker": buffer_final,
        "backendFinal": {terminal_id: final_backend.get(terminal_id) for terminal_id in hot_terminals},
        "frontendFinal": {terminal_id: frontend_v3.get(terminal_id) for terminal_id in hot_terminals},
        "pipelineFinal": {terminal_id: pipeline.get(terminal_id) for terminal_id in hot_terminals},
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

    if args.cleanup:
        current = api("GET", "/workspaces")["activeWorkspaceId"]
        if current in created_workspaces:
            all_workspaces = api("GET", "/workspaces")["workspaces"]
            fallback = next(item["id"] for item in all_workspaces if item["id"] not in created_workspaces)
            api("POST", "/workspaces/active", {"id": fallback})
        for workspace_id in reversed(created_workspaces):
            api("DELETE", f"/workspaces/{quote(workspace_id, safe='')}")
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-worktree", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--scenario", choices=["active", "background"], default="background")
    parser.add_argument("--hot-panes", type=int, choices=[2, 4, 7, 8], required=True)
    parser.add_argument("--lines", type=int, default=150_000)
    parser.add_argument("--flush-every", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=300.0)
    parser.add_argument("--run-id")
    parser.add_argument("--cleanup", action="store_true")
    args = parser.parse_args()
    if args.lines < 1 or args.flush_every < 1:
        parser.error("--lines and --flush-every must be positive")
    try:
        summary = run(args)
    except BenchmarkError as error:
        parser.exit(2, f"benchmark failed: {error}\n")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
