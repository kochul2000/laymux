"""Key injection primitives. Every event passes `session.checkpoint()` first.

Phase 1 scope: physical keys, modifier chords, ASCII typing. IME composition,
clipboard and focus-out land in later phases (see README).
"""

from __future__ import annotations

import time

import win32
from guard import InputSession

MODIFIER_ALIASES = {
    "ctrl": win32.VK_CONTROL,
    "control": win32.VK_CONTROL,
    "alt": win32.VK_MENU,
    "shift": win32.VK_SHIFT,
    "win": win32.VK_LWIN,
    "meta": win32.VK_LWIN,
}


def _emit(session: InputSession, event) -> None:
    session.checkpoint()
    win32.send_inputs([event])
    session.events_sent += 1
    if session.event_delay:
        time.sleep(session.event_delay)


def press(session: InputSession, vk: int) -> None:
    _emit(session, win32.key_input(vk, up=False, extended=vk in win32.EXTENDED_VKS))
    session.note_press(vk)


def release(session: InputSession, vk: int) -> None:
    _emit(session, win32.key_input(vk, up=True, extended=vk in win32.EXTENDED_VKS))
    session.note_release(vk)


def tap(session: InputSession, key: str | int, *, hold: float = 0.02) -> None:
    vk = key if isinstance(key, int) else win32.vk_for(key)
    press(session, vk)
    if hold:
        time.sleep(hold)
    release(session, vk)


def chord(session: InputSession, spec: str) -> None:
    """Send a real modifier combo, e.g. `chord(s, "ctrl+alt+m")`.

    Modifiers go down in order and come up in reverse — the order xterm's
    keydown handler and the OS hotkey table both expect.
    """
    parts = [p for p in spec.strip().lower().split("+") if p]
    if not parts:
        raise ValueError("empty chord")
    *mods, base = parts
    mod_vks = []
    for name in mods:
        if name not in MODIFIER_ALIASES:
            raise ValueError(f"{name!r} is not a modifier (in {spec!r})")
        mod_vks.append(MODIFIER_ALIASES[name])

    for vk in mod_vks:
        press(session, vk)
    try:
        tap(session, base)
    finally:
        for vk in reversed(mod_vks):
            release(session, vk)


def type_ascii(session: InputSession, text: str) -> None:
    """Type printable ASCII as physical keys, so `event.code` is real.

    Shifted characters use a genuine Shift press. Non-ASCII raises — use the
    IME path (phase 5) or `type_unicode` and know what you are giving up.
    """
    shift_map = {
        "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7",
        "*": "8", "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]",
        "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`",
    }
    plain_map = {
        "-": 0xBD, "=": 0xBB, "[": 0xDB, "]": 0xDD, "\\": 0xDC, ";": 0xBA,
        "'": 0xDE, ",": 0xBC, ".": 0xBE, "/": 0xBF, "`": 0xC0,
    }

    for ch in text:
        if ch == "\n":
            tap(session, "enter")
            continue
        if ch == "\t":
            tap(session, "tab")
            continue
        if ch == " ":
            tap(session, "space")
            continue
        if ch.isupper():
            press(session, win32.VK_SHIFT)
            try:
                tap(session, ch.lower())
            finally:
                release(session, win32.VK_SHIFT)
            continue
        if ch in shift_map:
            base = shift_map[ch]
            vk = plain_map.get(base) or win32.vk_for(base)
            press(session, win32.VK_SHIFT)
            try:
                tap(session, vk)
            finally:
                release(session, win32.VK_SHIFT)
            continue
        if ch in plain_map:
            tap(session, plain_map[ch])
            continue
        if ch.isascii() and (ch.isalnum()):
            tap(session, ch)
            continue
        raise ValueError(
            f"{ch!r} is not typeable as a physical key — "
            "use the IME path for composed text"
        )


def type_unicode(session: InputSession, text: str) -> None:
    """Deliver text as WM_CHAR. NOT an IME repro: no composition events fire."""
    for ch in text:
        for code_unit in _utf16_units(ch):
            _emit(session, win32.unicode_input(code_unit, up=False))
            _emit(session, win32.unicode_input(code_unit, up=True))


def _utf16_units(ch: str) -> list[int]:
    raw = ch.encode("utf-16-le")
    return [int.from_bytes(raw[i : i + 2], "little") for i in range(0, len(raw), 2)]


def run_spec(session: InputSession, tokens: list[str]) -> list[str]:
    """Execute CLI-style tokens. Returns a log of what was sent.

    - `ctrl+alt+m`, `enter`, `f5`  -> key / chord
    - `text:hello world`           -> ASCII typing
    - `wait:0.5`                   -> sleep (still checkpoints afterwards)
    """
    log: list[str] = []
    for token in tokens:
        if token.startswith("text:"):
            payload = token[len("text:") :]
            type_ascii(session, payload)
            log.append(f"text {payload!r}")
        elif token.startswith("wait:"):
            seconds = float(token[len("wait:") :])
            time.sleep(seconds)
            session.checkpoint()
            log.append(f"wait {seconds}s")
        elif "+" in token:
            chord(session, token)
            log.append(f"chord {token}")
        else:
            tap(session, token)
            log.append(f"key {token}")
    return log
