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
    lease = guard.write_lease(seconds, note=args.note or "")
    print(f"{OK}lease granted for {fmt_remaining(lease.remaining)}")
    print(f"{INFO}stored at {guard.lease_path()}")
    print(f"{INFO}any real keypress or {guard.MOUSE_MOVE_ABORT_PX}px of mouse travel aborts a run")

    try:
        lock = guard.TargetLock.resolve()
    except guard.GuardError as exc:
        print(f"{BAD}dev not usable yet: {exc}")
        return 1

    if args.focus_dev:
        if win32.force_foreground(lock.dev_hwnd):
            print(f"{OK}dev window brought to the foreground")
        else:
            print(f"{BAD}could not focus dev — click its window once, then run doctor")
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
        print(f"{OK}focused target pane over HTTP")
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
    before = probe.terminal_output(lock.dev_port, target["id"], lines=10)

    try:
        with guard.InputSession() as session:
            print(f"{OK}dead-man switch armed (real input aborts)")
            send.type_ascii(session, marker)
            print(f"{OK}injected {session.events_sent} key events "
                  f"(marker {marker!r}, no Enter sent)")

            time.sleep(0.35)
            after = probe.terminal_output(lock.dev_port, target["id"], lines=10)
            landed = marker in after and marker not in before
            if landed:
                print(f"{OK}marker echoed back through the PTY — SendInput reaches WebView2")
            else:
                failures += 1
                print(f"{BAD}marker never showed up in the terminal buffer.")
                print(f"{INFO}  likely UIPI: is dev running elevated while this script is not?")
                print(f"{INFO}  (also check the pane really had keyboard focus)")

            for _ in range(len(marker)):
                send.tap(session, "backspace")
            print(f"{OK}marker erased ({len(marker)} backspaces)")
    except guard.AbortedByHuman as exc:
        print(f"{BAD}{exc}")
        return 2
    except guard.GuardError as exc:
        print(f"{BAD}guard refused: {exc}")
        return 1
    except OSError as exc:
        print(f"{BAD}SendInput failed: {exc}")
        return 1

    held = win32.modifier_held_physically()
    if held:
        failures += 1
        print(f"{BAD}modifiers left down after cleanup: {', '.join(held)}")
    else:
        print(f"{OK}no modifier left stuck")

    print()
    print("doctor: PASS" if failures == 0 else f"doctor: {failures} FAILURE(S)")
    return 0 if failures == 0 else 1


def cmd_keys(args: argparse.Namespace) -> int:
    try:
        guard.require_lease()
        lock = guard.TargetLock.resolve()
        target = probe.pick_shell_terminal(lock.dev_port, args.terminal)
        if args.focus:
            probe.focus_terminal(lock.dev_port, target["id"])
            time.sleep(0.1)
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
