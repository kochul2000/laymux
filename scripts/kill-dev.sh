#!/usr/bin/env bash
# kill-dev.sh — dev 인스턴스만 안전하게 종료한다. release(19280)는 절대 건드리지 않는다.
#
# 1순위: automation.json PID
# 2순위: 포트 19281 LISTENING 프로세스
# 3순위: 없으면 아무것도 안 함

set -euo pipefail

APPDATA_DIR="${APPDATA:-$HOME/AppData/Roaming}"
CONFIG="$APPDATA_DIR/laymux-dev/automation.json"
DEV_PORT=19281

kill_pid() {
  local pid=$1
  local source=$2
  if [[ "$(uname -o 2>/dev/null)" == "Msys" || "$(uname -s)" == MINGW* || "$(uname -s)" == CYGWIN* ]]; then
    taskkill //PID "$pid" //F //T 2>/dev/null && echo "Dev (PID $pid) killed ($source)" || echo "PID $pid not running"
  else
    kill -9 "$pid" 2>/dev/null && echo "Dev (PID $pid) killed ($source)" || echo "PID $pid not running"
  fi
}

# 1순위: automation.json에서 PID 읽기
if [ -f "$CONFIG" ]; then
  PID=$(python -c "import sys,json; print(json.load(open(sys.argv[1]))['pid'])" "$CONFIG" 2>/dev/null || true)
  if [ -n "$PID" ] && [ "$PID" != "None" ]; then
    kill_pid "$PID" "automation.json"
    rm -f "$CONFIG"
    exit 0
  fi
fi

# 2순위: 포트 19281 소유 프로세스 찾기
if command -v netstat &>/dev/null; then
  DEV_PID=$(netstat -ano 2>/dev/null | grep ":${DEV_PORT} .*LISTENING" | awk '{print $NF}' | head -1 || true)
  if [ -n "$DEV_PID" ]; then
    kill_pid "$DEV_PID" "port $DEV_PORT"
    rm -f "$CONFIG"
    exit 0
  fi
fi

echo "No dev instance found"
