# Byte transport only: no shell, credentials, process scan, or public listener.
import os
import socket
import sys
import threading

path = sys.argv[1]
if not path.startswith('/') or not path.endswith('/app-server-control/app-server-control.sock'):
    raise SystemExit('Invalid Codex control socket')
connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
connection.settimeout(5)
connection.connect(path)
connection.settimeout(None)

def receive():
    try:
        while True:
            data = connection.recv(8192)
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    except (OSError, BrokenPipeError):
        pass
    finally:
        os._exit(0)

threading.Thread(target=receive, daemon=True).start()
try:
    while True:
        data = sys.stdin.buffer.read1(8192)
        if not data:
            break
        connection.sendall(data)
finally:
    connection.close()
