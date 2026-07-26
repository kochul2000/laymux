"""Safety policy for the dev-input helper. Nothing types without going through here.

Four layers, all mandatory:

1. Lease      — the user hands the PC over explicitly, with an expiry.
2. Target lock — resolve the dev instance by port 19281 and verify the
                 foreground window belongs to it before *every* event.
                 The release instance's pid is an explicit blacklist.
3. Dead man   — a real (non-injected) keystroke or mouse action from the human
                aborts instantly. Low-level hooks, not GetLastInputInfo, which
                counts synthetic input too.
4. Cleanup    — every modifier we pressed is released on any exit path.
"""

from __future__ import annotations

import ctypes
import json
import os
import re
import subprocess
import threading
import time
from ctypes import wintypes
from dataclasses import dataclass, field
from pathlib import Path

import win32

DEV_PORT = 19281
RELEASE_PORT = 19280
DEV_CONFIG_DIR = "laymux-dev"
RELEASE_CONFIG_DIR = "laymux"

# Real mouse travel (px, manhattan) tolerated before we call the human back.
MOUSE_MOVE_ABORT_PX = 40
LEASE_MAX_SECONDS = 60 * 60


class GuardError(RuntimeError):
    """Refusal to inject input. Never retry a GuardError — fix the cause."""


class AbortedByHuman(GuardError):
    pass


# -- lease ------------------------------------------------------------------


def lease_path() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "laymux-devinput" / "lease.json"


@dataclass
class Lease:
    expires_at: float
    granted_at: float
    note: str = ""

    @property
    def remaining(self) -> float:
        return self.expires_at - time.time()

    @property
    def alive(self) -> bool:
        return self.remaining > 0


def read_lease() -> Lease | None:
    path = lease_path()
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return Lease(
            expires_at=float(raw["expiresAt"]),
            granted_at=float(raw.get("grantedAt", 0)),
            note=str(raw.get("note", "")),
        )
    except (ValueError, KeyError, OSError):
        return None


def write_lease(seconds: float, note: str = "") -> Lease:
    if seconds <= 0 or seconds > LEASE_MAX_SECONDS:
        raise GuardError(f"lease must be 1..{LEASE_MAX_SECONDS}s, got {seconds:g}")
    now = time.time()
    lease = Lease(expires_at=now + seconds, granted_at=now, note=note)
    path = lease_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {"expiresAt": lease.expires_at, "grantedAt": now, "note": note}, indent=2
        ),
        encoding="utf-8",
    )
    return lease


def clear_lease() -> bool:
    path = lease_path()
    if path.exists():
        path.unlink()
        return True
    return False


def require_lease() -> Lease:
    if os.environ.get("LAYMUX_DEVINPUT_DISABLE") == "1":
        raise GuardError("LAYMUX_DEVINPUT_DISABLE=1 — input injection is turned off")
    lease = read_lease()
    if lease is None:
        raise GuardError(
            "no lease. The user must hand the machine over first:\n"
            "  uv run scripts/devinput/cli.py lease 15m"
        )
    if not lease.alive:
        raise GuardError(
            f"lease expired {abs(lease.remaining):.0f}s ago — ask for a new one"
        )
    return lease


# -- instance resolution ----------------------------------------------------


def _config_path(dirname: str) -> Path:
    base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
    return Path(base) / dirname / "automation.json"


def read_automation_json(dirname: str) -> dict | None:
    path = _config_path(dirname)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


_NETSTAT_LINE = re.compile(
    r"^\s*TCP\s+(?P<local>\S+)\s+\S+\s+(?P<state>\S+)\s+(?P<pid>\d+)\s*$"
)


def listening_pids(port: int) -> set[int]:
    """Pids owning a LISTENING socket on `port`, straight from netstat -ano."""
    try:
        out = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"],
            capture_output=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GuardError(f"cannot run netstat to verify port ownership: {exc}") from exc

    text = out.stdout.decode("utf-8", errors="replace")
    pids: set[int] = set()
    for line in text.splitlines():
        m = _NETSTAT_LINE.match(line)
        if not m or m.group("state").upper() != "LISTENING":
            continue
        local = m.group("local")
        if local.rsplit(":", 1)[-1] == str(port):
            pids.add(int(m.group("pid")))
    return pids


def process_alive(pid: int) -> bool:
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    handle = win32.kernel32.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION, False, wintypes.DWORD(pid)
    )
    if not handle:
        return False
    try:
        code = wintypes.DWORD(0)
        if not win32.kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        win32.kernel32.CloseHandle(handle)


@dataclass
class TargetLock:
    """The one pid we are allowed to type into, plus the pids we must never hit."""

    dev_pid: int
    dev_port: int
    dev_hwnd: int
    forbidden_pids: frozenset[int]
    checks: list[str] = field(default_factory=list)

    @classmethod
    def resolve(cls) -> TargetLock:
        """Identify the dev instance. Port ownership is the authority.

        `automation.json` is only advisory: any `cargo test` run rewrites and
        then deletes it (`write_and_remove_discovery_file`), so a live dev
        instance frequently has no discovery file at all. Deriving the pid from
        who actually LISTENs on 19281 cannot be fooled that way.
        """
        owners = listening_pids(DEV_PORT)
        if not owners:
            raise GuardError(
                f"nothing is listening on dev port {DEV_PORT} — "
                "is `cargo tauri dev` running?"
            )
        if len(owners) > 1:
            raise GuardError(
                f"port {DEV_PORT} has multiple owners {sorted(owners)} — "
                "refusing while the target is ambiguous"
            )
        pid = next(iter(owners))
        if not process_alive(pid):
            raise GuardError(f"dev pid {pid} vanished between checks")

        image = win32.process_image_path(pid)
        if Path(image).name.lower() != "laymux.exe":
            raise GuardError(
                f"pid {pid} on port {DEV_PORT} is {image or '<unknown>'}, not laymux.exe"
            )

        # Blacklist: whoever holds 19280, plus the release config's pid.
        forbidden = set(listening_pids(RELEASE_PORT))
        rel_cfg = read_automation_json(RELEASE_CONFIG_DIR)
        if rel_cfg and rel_cfg.get("pid"):
            forbidden.add(int(rel_cfg["pid"]))
        if pid in forbidden:
            raise GuardError(
                f"dev pid {pid} is also a release owner — refusing to type anywhere"
            )

        hwnds = win32.top_level_windows_of(pid)
        if not hwnds:
            raise GuardError(f"dev pid {pid} has no visible top-level window")

        cfg = read_automation_json(DEV_CONFIG_DIR)
        if cfg is None:
            cfg_note = "automation.json: absent (advisory only; cargo test deletes it)"
        elif int(cfg.get("pid", 0)) == pid and int(cfg.get("port", 0)) == DEV_PORT:
            cfg_note = f"automation.json: agrees (pid={pid}, port={DEV_PORT})"
        else:
            cfg_note = (
                f"automation.json: STALE (port={cfg.get('port')} pid={cfg.get('pid')}) "
                "— ignored, port ownership wins"
            )

        return cls(
            dev_pid=pid,
            dev_port=DEV_PORT,
            dev_hwnd=hwnds[0],
            forbidden_pids=frozenset(forbidden),
            checks=[
                f"port {DEV_PORT} owner: pid={pid} ({image})",
                cfg_note,
                f"forbidden (release) pids: {sorted(forbidden) or 'none found'}",
                f"dev window: hwnd=0x{hwnds[0]:X} title={win32.window_title(hwnds[0])!r}",
            ],
        )

    def foreground_state(self) -> tuple[int, int, str]:
        hwnd = win32.foreground_window()
        return hwnd, win32.window_pid(hwnd), win32.window_title(hwnd)

    def assert_foreground(self) -> None:
        """Cheap per-event check: is the dev instance still the input target?"""
        hwnd, pid, title = self.foreground_state()
        if pid in self.forbidden_pids:
            raise GuardError(
                f"foreground is a RELEASE window (pid {pid}, {title!r}) — aborted"
            )
        if pid != self.dev_pid:
            raise GuardError(
                f"foreground pid {pid} ({title!r}) != dev pid {self.dev_pid} — aborted"
            )
        if hwnd == 0:
            raise GuardError("no foreground window — aborted")


# -- dead man switch --------------------------------------------------------


class DeadMan:
    """Trips on the first non-injected keyboard/mouse event: the human is back."""

    def __init__(self, *, move_threshold_px: int = MOUSE_MOVE_ABORT_PX) -> None:
        self._move_threshold = move_threshold_px
        self._tripped = threading.Event()
        self._ready = threading.Event()
        self._reason = ""
        self._thread: threading.Thread | None = None
        self._thread_id = 0
        self._last_pt: tuple[int, int] | None = None
        self._travel = 0
        self._install_error: str | None = None
        # ctypes callbacks must outlive the hook.
        self._kb_proc = win32.HOOKPROC(self._on_keyboard)
        self._mouse_proc = win32.HOOKPROC(self._on_mouse)

    @property
    def tripped(self) -> bool:
        return self._tripped.is_set()

    @property
    def reason(self) -> str:
        return self._reason

    def _trip(self, reason: str) -> None:
        if not self._tripped.is_set():
            self._reason = reason
            self._tripped.set()

    def _on_keyboard(self, ncode, wparam, lparam):
        if ncode == 0:
            info = ctypes.cast(lparam, ctypes.POINTER(win32.KBDLLHOOKSTRUCT)).contents
            ours = info.dwExtraInfo == win32.DEVINPUT_SIGNATURE
            injected = bool(info.flags & win32.LLKHF_INJECTED)
            if not ours and not injected:
                self._trip(f"human pressed a key (vk=0x{info.vkCode:02X})")
        return win32.user32.CallNextHookEx(None, ncode, wparam, lparam)

    def _on_mouse(self, ncode, wparam, lparam):
        if ncode == 0:
            info = ctypes.cast(lparam, ctypes.POINTER(win32.MSLLHOOKSTRUCT)).contents
            ours = info.dwExtraInfo == win32.DEVINPUT_SIGNATURE
            injected = bool(info.flags & win32.LLMHF_INJECTED)
            if not ours and not injected:
                if wparam == win32.WM_MOUSEMOVE:
                    pt = (info.pt.x, info.pt.y)
                    if self._last_pt is not None:
                        self._travel += abs(pt[0] - self._last_pt[0]) + abs(
                            pt[1] - self._last_pt[1]
                        )
                    self._last_pt = pt
                    if self._travel >= self._move_threshold:
                        self._trip(f"human moved the mouse ({self._travel}px)")
                else:
                    self._trip(f"human used the mouse (msg=0x{wparam:04X})")
        return win32.user32.CallNextHookEx(None, ncode, wparam, lparam)

    def _pump(self) -> None:
        self._thread_id = win32.kernel32.GetCurrentThreadId()
        kb = win32.user32.SetWindowsHookExW(win32.WH_KEYBOARD_LL, self._kb_proc, None, 0)
        ms = win32.user32.SetWindowsHookExW(win32.WH_MOUSE_LL, self._mouse_proc, None, 0)
        if not kb or not ms:
            self._install_error = (
                f"SetWindowsHookExW failed (kb={kb}, mouse={ms}, "
                f"err={ctypes.get_last_error()})"
            )
            self._ready.set()
            return
        self._ready.set()
        msg = wintypes.MSG()
        try:
            while win32.user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                pass
        finally:
            win32.user32.UnhookWindowsHookEx(kb)
            win32.user32.UnhookWindowsHookEx(ms)

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._pump, name="devinput-deadman", daemon=True
        )
        self._thread.start()
        if not self._ready.wait(timeout=5):
            raise GuardError("dead-man hooks did not install within 5s")
        if self._install_error:
            raise GuardError(f"dead-man switch unavailable: {self._install_error}")

    def stop(self) -> None:
        if self._thread and self._thread_id:
            win32.user32.PostThreadMessageW(self._thread_id, win32.WM_QUIT, 0, 0)
            self._thread.join(timeout=2)
        self._thread = None

    def assert_ok(self) -> None:
        if self._tripped.is_set():
            raise AbortedByHuman(f"aborted: {self._reason}")


# -- session ----------------------------------------------------------------


class InputSession:
    """Context manager wrapping the four layers. `send.py` takes one of these."""

    def __init__(self, *, deadman: bool = True, event_delay: float = 0.012) -> None:
        self.lease = require_lease()
        self.lock = TargetLock.resolve()
        self.event_delay = event_delay
        self._deadman = DeadMan() if deadman else None
        self.pressed_vks: list[int] = []
        self.touched_modifiers: set[int] = set()
        self.events_sent = 0

    def __enter__(self) -> InputSession:
        if self._deadman:
            self._deadman.start()
        self.lock.assert_foreground()
        return self

    def __exit__(self, *_exc) -> None:
        try:
            self.release_all_modifiers()
        finally:
            if self._deadman:
                self._deadman.stop()

    def checkpoint(self) -> None:
        """Run before every single injected event. Cheap: 2 syscalls + a flag."""
        if not self.lease.alive:
            raise GuardError("lease expired mid-run — aborted")
        if self._deadman:
            self._deadman.assert_ok()
        self.lock.assert_foreground()

    def note_press(self, vk: int) -> None:
        self.pressed_vks.append(vk)
        if vk in win32.MODIFIER_VKS:
            self.touched_modifiers.add(vk)

    def note_release(self, vk: int) -> None:
        if vk in self.pressed_vks:
            self.pressed_vks.remove(vk)

    def release_all_modifiers(self) -> None:
        """Unconditional cleanup: a stuck Ctrl is the worst way to hand a PC back.

        Only keys *we* pressed are released, and we do it without checkpointing —
        cleanup must run even when the guard has already refused.
        """
        for vk in reversed(list(self.pressed_vks)):
            try:
                win32.send_inputs(
                    [win32.key_input(vk, up=True, extended=vk in win32.EXTENDED_VKS)]
                )
            except OSError:
                pass
        self.pressed_vks.clear()
        # Belt and braces, but only for modifiers this session actually pressed:
        # blasting KEYUP at a modifier the human is holding would break *their*
        # typing after the dead-man switch handed control back.
        for vk in self.touched_modifiers:
            if win32.user32.GetAsyncKeyState(vk) & 0x8000:
                try:
                    win32.send_inputs([win32.key_input(vk, up=True, extended=False)])
                except OSError:
                    pass

    @property
    def deadman_reason(self) -> str:
        return self._deadman.reason if self._deadman else ""
