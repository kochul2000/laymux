# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""dev-input helper — OS-level input for repro cases the Automation API cannot make.

Phase 1: lease + target lock + dead-man switch + doctor + physical keys.
Clipboard, focus-out and IME composition come later (see README.md).

Usage:
    uv run scripts/devinput/cli.py status
    uv run scripts/devinput/cli.py lease 15m --focus-dev
    uv run scripts/devinput/cli.py doctor
    uv run scripts/devinput/cli.py keys ctrl+alt+m "text:hi" enter
    uv run scripts/devinput/cli.py unlease
"""

from __future__ import annotations

import argparse
import re
import sys
import time

import guard
import probe
import send
import win32

OK = "[ok]  "
BAD = "[FAIL]"
INFO = "      "

_DURATION = re.compile(r"^(\d+(?:\.\d+)?)([smh]?)$")


def parse_duration(text: str) -> float:
    m = _DURATION.match(text.strip().lower())
    if not m:
        raise argparse.ArgumentTypeError(f"bad duration {text!r} (try 30s, 15m, 1h)")
    value, unit = float(m.group(1)), m.group(2) or "s"
    return value * {"s": 1, "m": 60, "h": 3600}[unit]


def fmt_remaining(seconds: float) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds // 60}m{seconds % 60:02d}s"


# -- commands ---------------------------------------------------------------


def cmd_status(_args: argparse.Namespace) -> int:
    lease = guard.read_lease()
    if lease is None:
        print(f"{INFO}lease: none (input injection refused)")
    elif lease.alive:
        print(f"{OK}lease: {fmt_remaining(lease.remaining)} left  note={lease.note!r}")
    else:
        print(f"{INFO}lease: expired {fmt_remaining(-lease.remaining)} ago")

    try:
        lock = guard.TargetLock.resolve()
    except guard.GuardError as exc:
        print(f"{BAD}target: {exc}")
        return 1

    for line in lock.checks:
        print(f"{OK}{line}")
    hwnd, pid, title = lock.foreground_state()
    marker = OK if pid == lock.dev_pid else INFO
    print(f"{marker}foreground: pid={pid} hwnd=0x{hwnd:X} title={title!r}")
    if pid != lock.dev_pid:
        print(f"{INFO}  -> dev is not focused; injection would abort right now")
    held = win32.modifier_held_physically()
    if held:
        print(f"{INFO}modifiers currently down: {', '.join(held)}")
    return 0


def cmd_lease(args: argparse.Namespace) -> int:
    seconds = parse_duration(args.duration)

    # Resolve *before* granting: a command that reports failure must not leave the
    # keyboard handed over. Otherwise the user reads `[FAIL]` and still has a live
    # lease sitting in %LOCALAPPDATA%.
    try:
        lock = guard.TargetLock.resolve()
    except guard.GuardError as exc:
        print(f"{BAD}dev not usable yet: {exc}")
        print(f"{INFO}no lease granted")
        return 1

    try:
        lease = guard.write_lease(seconds, note=args.note or "")
    except guard.GuardError as exc:
        print(f"{BAD}{exc}")
        return 1
    print(f"{OK}lease granted for {fmt_remaining(lease.remaining)}")
    print(f"{INFO}stored at {guard.lease_path()}")
    print(f"{INFO}any real keypress or {guard.MOUSE_MOVE_ABORT_PX}px of mouse travel aborts a run")

    if args.focus_dev:
        if win32.force_foreground(lock.dev_hwnd):
            print(f"{OK}dev window brought to the foreground")
        else:
            # Same rule as the resolve failure above: a command that reports
            # failure hands the keyboard back instead of leaving it delegated.
            guard.clear_lease()
            print(f"{BAD}could not focus dev — click its window once, then re-run lease")
            print(f"{INFO}lease revoked (nothing is delegated right now)")
            return 1
    try:
        target = probe.pick_shell_terminal(lock.dev_port)
        probe.notify(
            lock.dev_port,
            target,
            f"DEV INPUT ACTIVE — automation holds the keyboard for {fmt_remaining(lease.remaining)}",
            "warn",
        )
    except (guard.GuardError, probe.ApiError) as exc:
        print(f"{INFO}banner skipped: {exc}")
    return 0


def cmd_unlease(_args: argparse.Namespace) -> int:
    removed = guard.clear_lease()
    print(f"{OK}lease cleared" if removed else f"{INFO}no lease to clear")
    try:
        lock = guard.TargetLock.resolve()
        target = probe.pick_shell_terminal(lock.dev_port)
        probe.notify(lock.dev_port, target, "dev input released — keyboard is yours", "info")
    except (guard.GuardError, probe.ApiError):
        pass
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    """Prove the whole chain end to end before trusting any repro scenario.

    Types a unique marker into an idle shell (never Enter, so nothing runs),
    reads it back out of the PTY buffer, then erases it with backspaces.
    """
    failures = 0

    try:
        lease = guard.require_lease()
        print(f"{OK}lease alive ({fmt_remaining(lease.remaining)} left)")
    except guard.GuardError as exc:
        print(f"{BAD}{exc}")
        return 1

    try:
        lock = guard.TargetLock.resolve()
    except guard.GuardError as exc:
        print(f"{BAD}target lock: {exc}")
        return 1
    for line in lock.checks:
        print(f"{OK}{line}")

    try:
        info = probe.health(lock.dev_port)
        print(f"{OK}dev API healthy: {info}")
    except probe.ApiError as exc:
        print(f"{BAD}dev API unreachable: {exc}")
        return 1

    try:
        target = probe.pick_shell_terminal(lock.dev_port, args.terminal)
    except guard.GuardError as exc:
        print(f"{BAD}{exc}")
        return 1
    print(f"{OK}probe target: {target['id']} (pane {target.get('paneNumber')}, "
          f"{target.get('label')}, activity=shell)")

    try:
        probe.focus_terminal(lock.dev_port, target["id"])
        if not probe.wait_for_focus(lock.dev_port, target["id"]):
            print(f"{BAD}focus request accepted but the pane never took focus "
                  f"(dev reports {probe.focused_terminal_id(lock.dev_port)!r})")
            return 1
        print(f"{OK}focused target pane over HTTP (confirmed)")
    except probe.ApiError as exc:
        print(f"{BAD}focus failed: {exc}")
        return 1

    hwnd, pid, title = lock.foreground_state()
    if pid != lock.dev_pid:
        print(f"{BAD}dev is not foreground (pid={pid} {title!r}). "
              "Click the dev window, or use `lease --focus-dev`.")
        return 1
    print(f"{OK}dev window is foreground (hwnd=0x{hwnd:X})")

    marker = f"dvprobe{int(time.time()) % 100000}"
    before = probe.strip_ansi(probe.terminal_output(lock.dev_port, target["id"], lines=10))
    # Modifiers the user is already holding are not ours to release, so they must
    # not be counted as "left stuck" either (guard.release_all_modifiers agrees).
    held_before = set(win32.modifier_held_physically())

    try:
        with guard.InputSession() as session:
            print(f"{OK}dead-man switch armed (real input aborts)")
            send.type_ascii(session, marker)
            print(f"{OK}injected {session.events_sent} key events "
                  f"(marker {marker!r}, no Enter sent)")

            time.sleep(0.35)
            after = probe.strip_ansi(
                probe.terminal_output(lock.dev_port, target["id"], lines=10)
            )
            landed = marker in after and marker not in before
            if landed:
                print(f"{OK}marker echoed back through the PTY — SendInput reaches WebView2")
            else:
                failures += 1
                print(f"{BAD}marker never showed up in the terminal buffer.")
                print(f"{INFO}  likely UIPI: is dev running elevated while this script is not?")
                print(f"{INFO}  (also check the pane really had keyboard focus)")

            # Only erase what we can prove we typed. Blind backspaces would eat
            # whatever the user had already typed at the prompt.
            if landed:
                for _ in range(len(marker)):
                    send.tap(session, "backspace")
                print(f"{OK}marker erased ({len(marker)} backspaces)")
            else:
                print(f"{INFO}no backspaces sent — check the prompt and clear it yourself")
    except guard.AbortedByHuman as exc:
        print(f"{BAD}{exc}")
        return 2
    except guard.GuardError as exc:
        print(f"{BAD}guard refused: {exc}")
        return 1
    except OSError as exc:
        print(f"{BAD}SendInput failed: {exc}")
        return 1

    stuck = [n for n in win32.modifier_held_physically() if n not in held_before]
    if stuck:
        failures += 1
        print(f"{BAD}modifiers left down after cleanup: {', '.join(stuck)}")
    else:
        print(f"{OK}no modifier left stuck")
        if held_before:
            print(f"{INFO}  (you were already holding {', '.join(sorted(held_before))} — ignored)")

    print()
    print("doctor: PASS" if failures == 0 else f"doctor: {failures} FAILURE(S)")
    return 0 if failures == 0 else 1


def cmd_keys(args: argparse.Namespace) -> int:
    try:
        guard.require_lease()
        lock = guard.TargetLock.resolve()
        if args.focus:
            target = probe.pick_shell_terminal(lock.dev_port, args.terminal)
            probe.focus_terminal(lock.dev_port, target["id"])
            # The HTTP call only queues the focus change. Confirm it landed —
            # a stalled UI (one of the defects this tool reproduces) would
            # otherwise leave the keys going to the previously focused pane.
            if not probe.wait_for_focus(lock.dev_port, target["id"]):
                raise guard.GuardError(
                    f"focus did not land on {target['id']} within 2s "
                    f"(dev reports {probe.focused_terminal_id(lock.dev_port)!r}) — "
                    "refusing; is the UI stalled?"
                )
        else:
            # Without the focus step the keys land in whatever pane already has
            # focus, so that is the pane we must vet — picking a nice-looking
            # shell elsewhere would validate one pane and type into another.
            focused = probe.focused_terminal_id(lock.dev_port)
            if focused is None:
                raise guard.GuardError(
                    "--no-focus: dev reports no focused terminal pane — "
                    "refusing to type blind (drop --no-focus, or focus a shell pane)"
                )
            if args.terminal and args.terminal != focused:
                raise guard.GuardError(
                    f"--no-focus: focus is on {focused}, not --terminal {args.terminal} — "
                    "refusing (drop --no-focus to move focus first)"
                )
            # Raises unless the focused pane is a plain shell.
            probe.pick_shell_terminal(lock.dev_port, focused)
        with guard.InputSession(event_delay=args.delay) as session:
            for line in send.run_spec(session, args.tokens):
                print(f"{OK}{line}")
            print(f"{INFO}{session.events_sent} events sent")
    except guard.AbortedByHuman as exc:
        print(f"{BAD}{exc}")
        return 2
    except (guard.GuardError, probe.ApiError) as exc:
        print(f"{BAD}{exc}")
        return 1
    except (OSError, ValueError) as exc:
        print(f"{BAD}{exc}")
        return 1
    return 0


# -- entry ------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="devinput", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("status", help="show lease, dev/release resolution, foreground").set_defaults(
        func=cmd_status
    )

    p_lease = sub.add_parser("lease", help="hand the keyboard over for a bounded time")
    p_lease.add_argument("duration", help="e.g. 30s, 15m, 1h (max 1h)")
    p_lease.add_argument("--note", help="what it is for, shown in status")
    p_lease.add_argument(
        "--focus-dev", action="store_true", help="bring the dev window to the foreground"
    )
    p_lease.set_defaults(func=cmd_lease)

    sub.add_parser("unlease", help="revoke the lease now").set_defaults(func=cmd_unlease)

    p_doctor = sub.add_parser("doctor", help="verify the injection chain end to end")
    p_doctor.add_argument("--terminal", help="terminal id to probe (default: an idle shell)")
    p_doctor.set_defaults(func=cmd_doctor)

    p_keys = sub.add_parser("keys", help="send keys/chords/text to the dev instance")
    p_keys.add_argument(
        "tokens",
        nargs="+",
        help="`ctrl+alt+m`, `enter`, `f5`, `text:hello`, `wait:0.5`",
    )
    p_keys.add_argument("--terminal", help="focus this terminal first")
    p_keys.add_argument(
        "--no-focus", dest="focus", action="store_false", help="skip the HTTP focus step"
    )
    p_keys.add_argument("--delay", type=float, default=0.012, help="seconds between events")
    p_keys.set_defaults(func=cmd_keys, focus=True)

    return parser


def main(argv: list[str] | None = None) -> int:
    if sys.platform != "win32":
        print(f"{BAD}dev-input is Windows-only (SendInput/IMM32)")
        return 1
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        print(f"\n{INFO}interrupted — modifiers released")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
