"""Guard-layer regression tests (Windows only — the modules bind user32 at import)."""

from __future__ import annotations

import ctypes
import sys

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Win32-only helper")

import guard  # noqa: E402
import win32  # noqa: E402


# -- cleanup: extended flag -------------------------------------------------


def test_belt_and_braces_pass_keeps_the_extended_flag(monkeypatch):
    """LWIN's scancode is E0 5B: a KEYUP without EXTENDEDKEY never reaches Win."""
    sent: list[tuple[int, int]] = []

    def fake_send(inputs):
        for ev in inputs:
            sent.append((ev.ki.wVk, ev.ki.dwFlags))
        return len(inputs)

    monkeypatch.setattr(win32, "send_inputs", fake_send)
    monkeypatch.setattr(win32.user32, "GetAsyncKeyState", lambda vk: -32768)

    session = guard.InputSession.__new__(guard.InputSession)
    session.pressed_vks = []
    session.touched_modifiers = {win32.VK_LWIN}
    session._deadman = None
    session.release_all_modifiers()

    assert sent, "cleanup sent nothing"
    for vk, flags in sent:
        assert vk == win32.VK_LWIN
        assert flags & win32.KEYEVENTF_EXTENDEDKEY, "LWIN KEYUP lost EXTENDEDKEY"
        assert flags & win32.KEYEVENTF_KEYUP


def test_non_extended_modifier_stays_non_extended(monkeypatch):
    sent: list[int] = []
    monkeypatch.setattr(
        win32, "send_inputs", lambda inputs: sent.extend(e.ki.dwFlags for e in inputs)
    )
    monkeypatch.setattr(win32.user32, "GetAsyncKeyState", lambda vk: -32768)

    session = guard.InputSession.__new__(guard.InputSession)
    session.pressed_vks = []
    session.touched_modifiers = {win32.VK_SHIFT}
    session._deadman = None
    session.release_all_modifiers()

    assert sent and not any(f & win32.KEYEVENTF_EXTENDEDKEY for f in sent)


# -- lease is re-read on every checkpoint -----------------------------------


def _session_with_lease(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.delenv("LAYMUX_DEVINPUT_DISABLE", raising=False)
    guard.write_lease(600, note="test")
    session = guard.InputSession.__new__(guard.InputSession)
    session.lease = guard.read_lease()
    session._deadman = None
    session.lock = type("L", (), {"assert_foreground": lambda self: None})()
    return session


def test_checkpoint_aborts_when_the_lease_file_is_deleted(monkeypatch, tmp_path):
    session = _session_with_lease(monkeypatch, tmp_path)
    session.checkpoint()  # lease alive -> no raise

    guard.clear_lease()
    with pytest.raises(guard.GuardError, match="no lease"):
        session.checkpoint()


def test_checkpoint_aborts_when_disable_env_is_set_mid_run(monkeypatch, tmp_path):
    session = _session_with_lease(monkeypatch, tmp_path)
    session.checkpoint()

    monkeypatch.setenv("LAYMUX_DEVINPUT_DISABLE", "1")
    with pytest.raises(guard.GuardError, match="DISABLE"):
        session.checkpoint()


def test_checkpoint_still_aborts_on_expiry(monkeypatch, tmp_path):
    session = _session_with_lease(monkeypatch, tmp_path)
    guard.write_lease(1)
    monkeypatch.setattr(guard.time, "time", lambda: 1e12)
    with pytest.raises(guard.GuardError, match="expired"):
        session.checkpoint()


# -- foreground check ordering ---------------------------------------------


def _lock(hwnd: int, pid: int) -> guard.TargetLock:
    lock = guard.TargetLock(
        dev_pid=4242, dev_port=guard.DEV_PORT, dev_hwnd=1, forbidden_pids=frozenset({99})
    )
    lock.foreground_state = lambda: (hwnd, pid, "title")  # type: ignore[method-assign]
    return lock


def test_missing_foreground_window_is_reported_as_such():
    with pytest.raises(guard.GuardError, match="no foreground window"):
        _lock(0, 0).assert_foreground()


def test_release_foreground_is_still_named_first():
    with pytest.raises(guard.GuardError, match="RELEASE window"):
        _lock(5, 99).assert_foreground()


def test_matching_dev_pid_passes():
    _lock(5, 4242).assert_foreground()


# -- dead man: synthetic input that is not ours -----------------------------


def _feed_key(
    dead: guard.DeadMan, *, injected: bool, ours: bool, msg: int = win32.WM_KEYDOWN
) -> None:
    info = win32.KBDLLHOOKSTRUCT(
        vkCode=0x41,
        scanCode=0x1E,
        flags=win32.LLKHF_INJECTED if injected else 0,
        time=0,
        dwExtraInfo=win32.DEVINPUT_SIGNATURE if ours else 0,
    )
    dead._on_keyboard(0, msg, ctypes.addressof(info))


def test_real_keystroke_trips_immediately():
    dead = guard.DeadMan()
    _feed_key(dead, injected=False, ours=False)
    assert dead.tripped and "human pressed a key" in dead.reason


def test_our_own_injection_never_trips():
    dead = guard.DeadMan()
    for _ in range(20):
        _feed_key(dead, injected=True, ours=True)
    assert not dead.tripped


def test_foreign_synthetic_keys_trip_after_the_tolerance():
    """RDP/Parsec deliver human keystrokes with LLKHF_INJECTED set."""
    dead = guard.DeadMan(foreign_key_limit=3)
    _feed_key(dead, injected=True, ours=False)
    _feed_key(dead, injected=True, ours=False)
    assert not dead.tripped
    _feed_key(dead, injected=True, ours=False)
    assert dead.tripped and "not ours" in dead.reason


def test_the_tolerance_counts_presses_not_events():
    """Every key yields KEYDOWN+KEYUP; counting both would halve the tolerance."""
    dead = guard.DeadMan(foreign_key_limit=3)
    for _ in range(2):
        _feed_key(dead, injected=True, ours=False, msg=win32.WM_KEYDOWN)
        _feed_key(dead, injected=True, ours=False, msg=0x0101)  # WM_KEYUP
    assert not dead.tripped
    _feed_key(dead, injected=True, ours=False, msg=win32.WM_KEYDOWN)
    assert dead.tripped


def test_syskeydown_counts_too():
    dead = guard.DeadMan(foreign_key_limit=1)
    _feed_key(dead, injected=True, ours=False, msg=win32.WM_SYSKEYDOWN)
    assert dead.tripped


# -- lease writes are atomic ------------------------------------------------


def test_write_lease_replaces_atomically_and_leaves_no_temp(monkeypatch, tmp_path):
    """checkpoint() reads this file per event — a half-written file would abort a run."""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.delenv("LAYMUX_DEVINPUT_DISABLE", raising=False)
    guard.write_lease(300, note="first")
    guard.write_lease(600, note="second")

    lease_dir = guard.lease_path().parent
    assert [p.name for p in lease_dir.iterdir()] == ["lease.json"]
    assert guard.read_lease().note == "second"


def test_write_lease_keeps_the_old_lease_if_the_new_one_fails(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    guard.write_lease(300, note="kept")
    with pytest.raises(guard.GuardError):
        guard.write_lease(guard.LEASE_MAX_SECONDS + 1)
    assert guard.read_lease().note == "kept"
