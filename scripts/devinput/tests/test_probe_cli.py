"""probe/cli tests: ANSI-safe marker matching, focus resolution, --no-focus refusal."""

from __future__ import annotations

import sys

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Win32-only helper")

import cli  # noqa: E402
import guard  # noqa: E402
import probe  # noqa: E402


# -- strip_ansi -------------------------------------------------------------


def test_marker_survives_colour_codes_inside_the_token():
    """PSReadLine re-emits the input line with SGR runs mid-token."""
    raw = "PS D:\\> \x1b[93mdvpro\x1b[0m\x1b[93mbe12345\x1b[0m\x1b[K"
    assert "dvprobe12345" not in raw
    assert "dvprobe12345" in probe.strip_ansi(raw)


def test_strip_ansi_removes_osc_and_cursor_sequences():
    raw = "\x1b]0;pwsh\x07\x1b[?25labc\x1b[2Kdef\x1b(B"
    assert probe.strip_ansi(raw) == "abcdef"


def test_strip_ansi_keeps_plain_text_untouched():
    assert probe.strip_ansi("plain text 42") == "plain text 42"


# -- focused_terminal_id ----------------------------------------------------


def _grid(monkeypatch, payload):
    monkeypatch.setattr(probe, "request", lambda port, path, **kw: payload)


def test_focused_terminal_id_uses_the_resolved_field(monkeypatch):
    """Both focus axes (grid pane, dock pane) are resolved frontend-side."""
    _grid(
        monkeypatch,
        {
            "focusedPaneIndex": 0,
            "focusedDock": "bottom",
            "focusedTerminalId": "terminal-dp-1",
            "panes": [{"paneIndex": 0, "terminalId": "terminal-g1"}],
        },
    )
    assert probe.focused_terminal_id(guard.DEV_PORT) == "terminal-dp-1"


def test_focused_terminal_id_is_none_without_focus(monkeypatch):
    _grid(monkeypatch, {"focusedPaneIndex": None, "focusedTerminalId": None, "panes": []})
    assert probe.focused_terminal_id(guard.DEV_PORT) is None


def test_focused_terminal_id_refuses_a_dev_build_without_the_field(monkeypatch):
    """Falling back to focusedPaneIndex would be blind to dock focus — refuse."""
    _grid(monkeypatch, {"focusedPaneIndex": 0, "panes": [{"paneIndex": 0, "terminalId": "t0"}]})
    with pytest.raises(guard.GuardError, match="predates it"):
        probe.focused_terminal_id(guard.DEV_PORT)


# -- wait_for_focus ---------------------------------------------------------


def test_wait_for_focus_returns_once_the_pane_takes_focus(monkeypatch):
    answers = iter(["t-other", "t-other", "t-target"])
    monkeypatch.setattr(probe, "focused_terminal_id", lambda port: next(answers))
    monkeypatch.setattr(probe.time, "sleep", lambda _s: None)
    assert probe.wait_for_focus(guard.DEV_PORT, "t-target", timeout=5) is True


def test_wait_for_focus_gives_up_on_a_stalled_ui(monkeypatch):
    """`focus_terminal` only queues the change; a frozen frontend never applies it."""
    monkeypatch.setattr(probe, "focused_terminal_id", lambda port: "t-other")
    monkeypatch.setattr(probe.time, "sleep", lambda _s: None)
    clock = iter([0.0, 0.1, 0.2, 0.3, 99.0, 99.0])
    monkeypatch.setattr(probe.time, "monotonic", lambda: next(clock))
    assert probe.wait_for_focus(guard.DEV_PORT, "t-target", timeout=1.0) is False


# -- keys --no-focus --------------------------------------------------------


class _Lock:
    dev_pid = 1
    dev_port = guard.DEV_PORT
    dev_hwnd = 1


def _patch_keys(monkeypatch, *, focused, picked=None, seen=None):
    monkeypatch.setattr(guard, "require_lease", lambda: None)
    monkeypatch.setattr(guard.TargetLock, "resolve", classmethod(lambda cls: _Lock()))
    monkeypatch.setattr(probe, "focused_terminal_id", lambda port: focused)
    monkeypatch.setattr(probe, "focus_terminal", lambda port, tid: {})
    monkeypatch.setattr(probe, "wait_for_focus", lambda port, tid, timeout=2.0: tid == focused)

    def _pick(port, terminal_id=None):
        if seen is not None:
            seen.append(terminal_id)
        if picked is None:
            raise guard.GuardError(f"terminal {terminal_id} is running 'interactiveApp'")
        return picked

    monkeypatch.setattr(probe, "pick_shell_terminal", _pick)

    def _boom(*_a, **_kw):
        raise AssertionError("InputSession must not be created when the target is unsafe")

    monkeypatch.setattr(guard, "InputSession", _boom)


def _args(**over):
    ns = cli.argparse.Namespace(
        tokens=["text:hi"], terminal=None, focus=False, delay=0.0
    )
    for k, v in over.items():
        setattr(ns, k, v)
    return ns


def test_no_focus_refuses_when_dev_reports_no_focused_pane(monkeypatch, capsys):
    _patch_keys(monkeypatch, focused=None, picked={"id": "t9"})
    assert cli.cmd_keys(_args()) == 1
    assert "no focused terminal pane" in capsys.readouterr().out


def test_no_focus_refuses_when_focus_is_not_the_requested_terminal(monkeypatch, capsys):
    _patch_keys(monkeypatch, focused="t-claude", picked={"id": "t-shell"})
    assert cli.cmd_keys(_args(terminal="t-shell")) == 1
    assert "focus is on t-claude" in capsys.readouterr().out


def test_no_focus_refuses_when_the_focused_pane_runs_an_agent(monkeypatch, capsys):
    """The vetted pane must be the pane that receives the keys, not a nicer one."""
    _patch_keys(monkeypatch, focused="t-claude", picked=None)
    assert cli.cmd_keys(_args()) == 1
    assert "interactiveApp" in capsys.readouterr().out


def test_no_focus_vets_the_focused_pane_not_an_arbitrary_shell(monkeypatch):
    seen: list[str | None] = []
    _patch_keys(monkeypatch, focused="t-shell", picked={"id": "t-shell"}, seen=seen)
    monkeypatch.setattr(
        guard, "InputSession", lambda **kw: (_ for _ in ()).throw(_Done())
    )
    with pytest.raises(_Done):
        cli.cmd_keys(_args())
    assert seen == ["t-shell"]


# -- keys --focus: the focus change must actually land ----------------------


def test_focus_path_refuses_when_focus_never_lands(monkeypatch, capsys):
    """A stalled UI accepts the focus request and keeps the old pane focused."""
    _patch_keys(monkeypatch, focused="t-old", picked={"id": "t-target"})
    assert cli.cmd_keys(_args(focus=True, terminal="t-target")) == 1
    out = capsys.readouterr().out
    assert "focus did not land on t-target" in out


def test_focus_path_proceeds_once_focus_lands(monkeypatch):
    _patch_keys(monkeypatch, focused="t-target", picked={"id": "t-target"})
    monkeypatch.setattr(
        guard, "InputSession", lambda **kw: (_ for _ in ()).throw(_Done())
    )
    with pytest.raises(_Done):
        cli.cmd_keys(_args(focus=True, terminal="t-target"))


class _Done(BaseException):
    """Escape hatch: we only care about what happened before injection starts."""
