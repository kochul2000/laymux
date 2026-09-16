"""Linux counterpart of the native Node SQLite fixture; isolated databases only."""
import json
import re
from pathlib import Path
import sqlite3
import sys

root = Path(sys.argv[1]).resolve()
assert str(root).startswith('/tmp/laymux-attribution-matrix/')
retention = sys.argv[2] if len(sys.argv) > 2 else 'inspect'
path = max(root.glob('logs_*.sqlite'), key=lambda p: int(p.stem.split('_')[1]))
db = sqlite3.connect(path, timeout=2)
db.row_factory = sqlite3.Row
identity = sys.argv[3] if len(sys.argv) > 3 else db.execute("SELECT process_uuid FROM logs WHERE process_uuid LIKE 'pid:%' ORDER BY id DESC LIMIT 1").fetchone()[0]
assert re.fullmatch(r'pid:\d+:[a-zA-Z0-9-]+', identity)
backup = root / ('threadless-' + identity.replace(':', '-') + '.json')
if retention != 'inspect':
    with db:
        db.execute('BEGIN IMMEDIATE')
        rows = [dict(r) for r in db.execute('SELECT * FROM logs WHERE process_uuid=? AND thread_id IS NULL ORDER BY id', (identity,))]
        if not backup.exists():
            backup.write_text(json.dumps(rows))
        original = json.loads(backup.read_text())
        assert original
        keys = list(original[0])
        sql = 'INSERT OR IGNORE INTO logs (' + ','.join(keys) + ') VALUES (' + ','.join('?' for _ in keys) + ')'
        db.executemany(sql, [[row[k] for k in keys] for row in original])
        keys.remove('id')
        late = dict(original[-1], feedback_log_body='retention matrix late threadless diagnostic')
        last = db.execute('INSERT INTO logs (' + ','.join(keys) + ') VALUES (' + ','.join('?' for _ in keys) + ')', [late[k] for k in keys]).lastrowid
        predicate = {'intact': '0', 'initial': f'id={original[0]["id"]}', 'partial': f'id<={original[len(original)//2]["id"]}', 'all': '1', 'late_only': f'id<{last}'}[retention]
        db.execute('DELETE FROM logs WHERE process_uuid=? AND thread_id IS NULL AND (' + predicate + ')', (identity,))
print(json.dumps({'identity': identity, 'file': str(path), 'retention': retention, 'counts': dict(db.execute('SELECT COUNT(*) AS total, MIN(id) AS first, MIN(CASE WHEN thread_id IS NULL THEN id END) AS firstThreadless FROM logs WHERE process_uuid=?', (identity,)).fetchone()), 'lifecycle': [dict(r) for r in db.execute('SELECT id,thread_id,substr(feedback_log_body,1,2048) AS body FROM logs WHERE process_uuid=? AND (feedback_log_body LIKE \'app_server.request{%rpc.method="thread/%\' OR feedback_log_body LIKE \'session_loop{%\') ORDER BY id', (identity,))]}))
