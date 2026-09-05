"""Dev-only WSL attribution fixture: no session files, no provider/API calls."""
import ctypes
import sys

assert sys.argv[1:] == ["resume", "saved-unvisited-session"]
assert ctypes.CDLL(None).prctl(15, b"codex", 0, 0, 0) == 0
print("IDLE_CODEX_RESTORE_READY", flush=True)
for line in sys.stdin:
    print("IDLE_CODEX_INPUT_RECEIVED", flush=True)
