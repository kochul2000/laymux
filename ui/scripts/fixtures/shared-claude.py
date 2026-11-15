"""격리 dev용: 네트워크 없이 PID별 Claude 세션 파일과 생존 프로세스를 만든다."""
import ctypes
import json
import os
from pathlib import Path
import sys
import time

ctypes.CDLL(None).prctl(15, b"claude", 0, 0, 0)
directory = Path.home() / ".claude" / "sessions"
directory.mkdir(parents=True, exist_ok=True)
path = directory / f"{os.getpid()}.json"
path.write_text(json.dumps({
    "pid": os.getpid(), "sessionId": sys.argv[1],
    "startedAt": int(time.time() * 1000), "status": sys.argv[2] if len(sys.argv) > 2 else "idle",
}))
print(f"SHARED_CLAUDE_READY {os.getpid()}", flush=True)
try:
    tick = 0
    while True:
        time.sleep(1)
        tick += 1
        print(f"SHARED_CLAUDE_TICK {os.getpid()} {tick}", flush=True)
finally:
    path.unlink(missing_ok=True)
