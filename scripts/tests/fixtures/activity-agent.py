"""Deterministic dev-only WSL fixture; no provider, credentials or user files."""
import ctypes
import json
import os
from pathlib import Path
import sqlite3
import sys
import time

provider, session_id, root_arg = sys.argv[1:]
root = Path(root_arg)
assert str(root).startswith('/tmp/laymux-activity-')
ctypes.CDLL(None).prctl(15, provider.lower().encode(), 0, 0, 0)
directory = root / 'sessions/2026/10/27'
directory.mkdir(parents=True, exist_ok=True)
rollout = directory / f'rollout-dev-{session_id}.jsonl'
def append(kind):
    with rollout.open('a') as file:
        file.write(json.dumps({'type':'event_msg','payload':{'type':kind,'turn_id':'fixture-turn'}})+'\n')
if provider == 'Codex':
    rollout.write_text(json.dumps({'type':'session_meta','payload':{'id':session_id,'source':'cli','cwd':'/tmp'}})+'\n')
    append('task_complete')
    with sqlite3.connect(root / 'logs_2.sqlite') as db:
        db.execute('CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY,process_uuid TEXT,thread_id TEXT,feedback_log_body TEXT)')
        db.execute('INSERT OR REPLACE INTO logs VALUES(1,?,NULL,?)',(f'pid:{os.getpid()}:fixture','fixture initialization'))
    print(f'\x1b]0;codex | {session_id} | dev fixture\x07',end='')
else:
    sessions = Path(os.environ['HOME']) / '.claude/sessions'
    sessions.mkdir(parents=True, exist_ok=True)
    (sessions / f'{os.getpid()}.json').write_text(json.dumps({'pid':os.getpid(),'sessionId':session_id,'startedAt':int(time.time()*1000),'status':'idle'}))
    print('\x1b]0;Claude Code\x07\x1b]0;✳ dev fixture\x07',end='')
print(f'ACTIVITY_FIXTURE_READY:{os.getpid()}',flush=True)
for line in sys.stdin:
    command = line.strip()
    if command == 'flood': print('x'*32768,flush=True)
    elif command == 'title-reset': print('\x1b]0;dev fixture cwd\x07',end='',flush=True)
    elif command == 'restore-title':
        print(f'\x1b]0;codex | {session_id} | dev fixture\x07' if provider == 'Codex' else '\x1b]0;Claude Code\x07\x1b]0;✳ dev fixture\x07',end='',flush=True)
    elif command in ('busy','done') and provider == 'Codex': append('task_started' if command=='busy' else 'task_complete')
    elif command == 'exit': break
