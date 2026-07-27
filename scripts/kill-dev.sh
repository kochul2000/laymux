#!/usr/bin/env bash
# kill-dev.sh — dev 인스턴스만 안전하게 종료한다. release(19280)는 절대 건드리지 않는다.
#
# 1순위: automation.json PID (단, port == 19281 인 파일만 신뢰)
# 2순위: 포트 19281 LISTENING 프로세스
# 3순위: 없으면 아무것도 안 함

set -euo pipefail

APPDATA_DIR="${APPDATA:-$HOME/AppData/Roaming}"
CONFIG="$APPDATA_DIR/laymux-dev/automation.json"
DEV_PORT=19281
FILE_PORT=""

# discovery 파일은 평평한 JSON(api-contracts §12.2)이라 숫자 필드는 sed 로 충분하다.
# python 에 의존하지 않는다 — 없는 환경에서 1순위가 조용히 죽는다.
json_num() {
  local file=$1 key=$2
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$file" 2>/dev/null | head -1
}

# 성공하면 0, 대상이 없으면 1 — 호출자가 다음 순위로 넘어갈지 판단한다.
kill_pid() {
  local pid=$1
  local source=$2
  if [[ "$(uname -o 2>/dev/null)" == "Msys" || "$(uname -s)" == MINGW* || "$(uname -s)" == CYGWIN* ]]; then
    if taskkill //PID "$pid" //F //T >/dev/null 2>&1; then
      echo "Dev (PID $pid) killed ($source)"
      return 0
    fi
  else
    if kill -9 "$pid" 2>/dev/null; then
      echo "Dev (PID $pid) killed ($source)"
      return 0
    fi
  fi
  echo "PID $pid not running ($source)"
  return 1
}

# 1순위: automation.json에서 port + PID 읽기
# port 를 반드시 검증한다 — dev 디렉터리에 있어도 19281 을 주장하지 않는 파일은
# dev 인스턴스의 것이 아니다(예: 테스트가 남긴 잔재). 신뢰하면 엉뚱한 프로세스를 죽인다.
if [ -f "$CONFIG" ]; then
  FILE_PORT=$(json_num "$CONFIG" port || true)
  PID=$(json_num "$CONFIG" pid || true)
  if [ "$FILE_PORT" = "$DEV_PORT" ] && [ -n "$PID" ]; then
    # PID 가 죽어 있으면(=stale 파일) 여기서 멈추지 않고 2순위로 넘어간다.
    if kill_pid "$PID" "automation.json"; then
      rm -f "$CONFIG"
      exit 0
    fi
  fi
  if [ -n "$FILE_PORT" ] && [ "$FILE_PORT" != "$DEV_PORT" ]; then
    echo "automation.json claims port $FILE_PORT (expected $DEV_PORT) — skipping, falling back to port lookup" >&2
  fi
fi

# 2순위: 포트 19281 소유 프로세스 찾기
if command -v netstat &>/dev/null; then
  DEV_PID=$(netstat -ano 2>/dev/null | grep ":${DEV_PORT} .*LISTENING" | awk '{print $NF}' | head -1 || true)
  if [ -n "$DEV_PID" ]; then
    kill_pid "$DEV_PID" "port $DEV_PORT"
    # dev 인스턴스가 쓴 파일만 정리한다. 남의 포트를 주장하는 파일은 우리 것이 아니다.
    if [ -z "$FILE_PORT" ] || [ "$FILE_PORT" = "$DEV_PORT" ]; then
      rm -f "$CONFIG"
    fi
    exit 0
  fi
fi

# dev 도 없고 파일의 PID 도 죽어 있다 — 남은 discovery 파일은 stale 이므로 치운다.
if [ -f "$CONFIG" ] && [ "$FILE_PORT" = "$DEV_PORT" ]; then
  rm -f "$CONFIG"
  echo "Removed stale automation.json"
fi

echo "No dev instance found"
