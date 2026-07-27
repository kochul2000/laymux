"""`doctor` tests: erase only what landed, ignore modifiers the human already holds."""

from __future__ import annotations

import sys

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Win32-only helper")

import cli  # noqa: E402
import guard  # noqa: E402
import probe  # noqa: E402
import send  # noqa: E402
import win32  # noqa: E402


class _Lock:
    dev_pid = 7
    dev_port = guard.DEV_PORT
    dev_hwnd = 0x10
    checks = ["port: pid=7"]

    def foreground_state(self):
        return (0x10, self.dev_pid, "laymux dev")


class _FakeSession:
    events_sent = 0
    event_delay = 0.0

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def _patch_doctor(monkeypatch, *, output: str, held: list[str]):
    """Wire doctor to a fake dev instance. Returns the key log it produces."""
    typed: list[str] = []

    monkeypatch.setattr(guard, "require_lease", lambda: guard.Lease(1e12, 0))
    monkeypatch.setattr(guard.TargetLock, "resolve", classmethod(lambda cls: _Lock()))
    monkeypatch.setattr(probe, "health", lambda port: {"status": "ok"})
    monkeypatch.setattr(
        probe,
        "pick_shell_terminal",
        lambda port, terminal_id=None: {"id": "t1", "paneNumber": 1, "label": "pwsh"},
    )
    monkeypatch.setattr(probe, "focus_terminal", lambda port, tid: {})
    monkeypatch.setattr(probe, "terminal_output", lambda port, tid, lines=40: output)
    monkeypatch.setattr(win32, "modifier_held_physically", lambda: list(held))
    monkeypatch.setattr(guard, "InputSession", lambda **kw: _FakeSession())
    monkeypatch.setattr(cli.time, "sleep", lambda _s: None)
    monkeypatch.setattr(send, "type_ascii", lambda s, text: typed.append(f"text:{text}"))
    monkeypatch.setattr(send, "tap", lambda s, key, **kw: typed.append(f"key:{key}"))
    return typed


def _run_doctor():
    return cli.cmd_doctor(cli.argparse.Namespace(terminal=None))


def test_doctor_sends_no_backspaces_when_the_marker_never_landed(monkeypatch, capsys):
    """Blind backspaces would delete text the user had already typed at the prompt."""
    typed = _patch_doctor(monkeypatch, output="PS D:\\> ", held=[])
    assert _run_doctor() == 1
    out = capsys.readouterr().out
    assert "marker never showed up" in out
    assert "clear it yourself" in out
    assert not [t for t in typed if t == "key:backspace"]


def test_doctor_erases_the_marker_once_it_is_confirmed(monkeypatch, capsys):
    marker_output: dict[str, str] = {}

    def _output(port, tid, lines=40):
        # First call is the "before" snapshot; later calls echo the typed marker.
        if "marker" not in marker_output:
            marker_output["marker"] = ""
            return "PS D:\\> "
        return f"PS D:\\> {marker_output['marker']}"

    typed = _patch_doctor(monkeypatch, output="", held=[])
    monkeypatch.setattr(probe, "terminal_output", _output)
    monkeypatch.setattr(
        send,
        "type_ascii",
        lambda s, text: (marker_output.__setitem__("marker", text), typed.append(f"text:{text}")),
    )

    assert _run_doctor() == 0
    marker = marker_output["marker"]
    assert marker.startswith("dvprobe")
    assert typed.count("key:backspace") == len(marker)
    assert "doctor: PASS" in capsys.readouterr().out


def test_doctor_matches_the_marker_through_ansi_noise(monkeypatch, capsys):
    """`/output` is raw PTY bytes; colour codes must not read as a UIPI block."""
    state: dict[str, str] = {}

    def _output(port, tid, lines=40):
        if "marker" not in state:
            state["marker"] = ""
            return "PS D:\\> "
        m = state["marker"]
        return f"PS D:\\> \x1b[93m{m[:3]}\x1b[0m\x1b[93m{m[3:]}\x1b[0m\x1b[K"

    typed = _patch_doctor(monkeypatch, output="", held=[])
    monkeypatch.setattr(probe, "terminal_output", _output)
    monkeypatch.setattr(
        send,
        "type_ascii",
        lambda s, text: (state.__setitem__("marker", text), typed.append(f"text:{text}")),
    )

    assert _run_doctor() == 0
    assert "marker echoed back" in capsys.readouterr().out
    assert typed.count("key:backspace") == len(state["marker"])


def test_doctor_does_not_blame_cleanup_for_a_modifier_the_user_holds(monkeypatch, capsys):
    """Shift held since before the session is not ours to release, nor to fail on."""
    state: dict[str, str] = {}

    def _output(port, tid, lines=40):
        if "marker" not in state:
            state["marker"] = ""
            return ""
        return state["marker"]

    typed = _patch_doctor(monkeypatch, output="", held=["shift"])
    monkeypatch.setattr(probe, "terminal_output", _output)
    monkeypatch.setattr(
        send,
        "type_ascii",
        lambda s, text: (state.__setitem__("marker", text), typed.append(f"text:{text}")),
    )

    assert _run_doctor() == 0
    out = capsys.readouterr().out
    assert "no modifier left stuck" in out
    assert "you were already holding shift" in out


def test_doctor_still_fails_on_a_modifier_we_left_down(monkeypatch, capsys):
    state: dict[str, str] = {}

    def _output(port, tid, lines=40):
        if "marker" not in state:
            state["marker"] = ""
            return ""
        return state["marker"]

    typed = _patch_doctor(monkeypatch, output="", held=[])
    monkeypatch.setattr(probe, "terminal_output", _output)
    monkeypatch.setattr(
        send,
        "type_ascii",
        lambda s, text: (state.__setitem__("marker", text), typed.append(f"text:{text}")),
    )
    # Snapshot is taken before injection; ctrl only appears afterwards.
    calls = {"n": 0}

    def _held():
        calls["n"] += 1
        return [] if calls["n"] == 1 else ["ctrl"]

    monkeypatch.setattr(win32, "modifier_held_physically", _held)

    assert _run_doctor() == 1
    assert "modifiers left down after cleanup: ctrl" in capsys.readouterr().out
