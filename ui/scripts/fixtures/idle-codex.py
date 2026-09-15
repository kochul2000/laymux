"""Dev-only WSL attribution fixture: no session files, no provider/API calls."""
import ctypes
import os
from pathlib import Path
import sqlite3
import sys

assert sys.argv[1:] == ["resume", "saved-unvisited-session"]
root = Path(os.environ["CODEX_SQLITE_HOME"])
assert str(root).startswith("/tmp/laymux-unvisited-attribution-")
root.mkdir(parents=True, exist_ok=True)
# Model an initialized diagnostic store without a selected conversation.
# A missing DB/incarnation is an I/O failure, not an idle restore (ADR-0238).
with sqlite3.connect(root / "logs_2.sqlite") as db:
    db.execute("CREATE TABLE logs(id INTEGER PRIMARY KEY, process_uuid TEXT, thread_id TEXT, feedback_log_body TEXT)")
    db.execute("INSERT INTO logs VALUES(1, ?, NULL, 'fixture initialization')", (f"pid:{os.getpid()}:fixture",))
assert ctypes.CDLL(None).prctl(15, b"codex", 0, 0, 0) == 0
print("IDLE_CODEX_RESTORE_READY", flush=True)
for line in sys.stdin:
    print("IDLE_CODEX_INPUT_RECEIVED", flush=True)
