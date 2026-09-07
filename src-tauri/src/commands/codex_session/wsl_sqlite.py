"""Read-only Codex diagnostics probe; stdout is one complete JSON document."""
import json
import pathlib
import sqlite3
import sys

pid = int(sys.argv[1])
with open(f"/proc/{pid}/environ", "rb") as stream:
    env = dict(part.decode().split("=", 1) for part in stream.read().split(b"\0") if b"=" in part)
if env.get("LX_TERMINAL_ID") != bytes.fromhex(sys.argv[2]).decode():
    raise ValueError("Codex pane ownership changed")
with open(f"/proc/{pid}/comm") as stream:
    if stream.read().strip() != "codex":
        raise ValueError("Codex process changed")
home = pathlib.Path(env.get("CODEX_SQLITE_HOME") or env.get("CODEX_HOME") or (env["HOME"] + "/.codex"))
if not home.is_absolute():
    raise ValueError("relative Codex database root")
paths = [(int(p.stem[5:]), p) for p in home.glob("logs_*.sqlite") if p.stem[5:].isdigit()]
if not paths:
    raise FileNotFoundError("Codex diagnostics database missing")
db = sqlite3.connect(max(paths)[1].as_uri() + "?mode=ro", uri=True, timeout=0.2)
db.row_factory = sqlite3.Row
with db:
    db.execute("BEGIN")
    identity = db.execute("SELECT process_uuid FROM logs INDEXED BY idx_logs_process_uuid_threadless_ts WHERE thread_id IS NULL AND process_uuid GLOB ? ORDER BY id DESC LIMIT 1", (f"pid:{pid}:*",)).fetchone()
    if identity is None:
        raise ValueError("Codex process incarnation not recorded")
    first = db.execute("SELECT MIN(id) FROM logs INDEXED BY idx_logs_process_uuid_threadless_ts WHERE thread_id IS NULL AND process_uuid=?", (identity[0],)).fetchone()[0]
    rows = db.execute("SELECT id,thread_id,substr(feedback_log_body,1,2048) AS feedback_log_body FROM logs WHERE id>=? AND process_uuid=? AND (feedback_log_body LIKE 'app_server.request{%rpc.method=\"thread/%' OR feedback_log_body LIKE 'session_loop{%') ORDER BY id", (first,identity[0]))
    print(json.dumps([dict(row) for row in rows]))
