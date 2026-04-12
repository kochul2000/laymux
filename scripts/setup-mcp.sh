#!/usr/bin/env bash
set -euo pipefail

# laymux 내장 MCP 서버 설정 스크립트 (claude mcp add-json 사용)
#
# scripts/mcp/ 의 JSON 정의를 claude mcp add-json 으로 등록한다.
# 인증 불필요 — IP allowlist로 로컬 접근만 허용.
#
# 사용법:
#   ./setup-mcp.sh                    # user scope (전역)
#   ./setup-mcp.sh --project          # project scope (현재 프로젝트)
#   ./setup-mcp.sh --dev              # dev 인스턴스 (포트 19281)
#   ./setup-mcp.sh --force            # health check 실패해도 계속 진행

# --- 색상 ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# --- claude CLI 확인 ---
command -v claude >/dev/null 2>&1 || error "claude CLI가 설치되어 있지 않습니다."

# --- 인자 파싱 ---
SCOPE="user"
USE_DEV=false
FORCE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --project)
            SCOPE="project"
            shift
            ;;
        --dev)
            USE_DEV=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        *)
            error "알 수 없는 옵션: $1\n사용법: $0 [--project] [--dev] [--force]"
            ;;
    esac
done

# --- 1. 서버 결정 ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$USE_DEV" = true ]; then
    MCP_NAME="laymux-dev"
    PORT=19281
    JSON_FILE="$SCRIPT_DIR/mcp/laymux-dev.json"
else
    MCP_NAME="laymux"
    PORT=19280
    JSON_FILE="$SCRIPT_DIR/mcp/laymux.json"
fi

[ -f "$JSON_FILE" ] || error "JSON 파일을 찾을 수 없습니다: $JSON_FILE"

echo "=== laymux MCP 설정 (claude mcp add-json) ==="
echo
info "서버: $MCP_NAME"
info "Port: $PORT"
info "Scope: $SCOPE"

# --- 2. Gateway IP 결정 (WSL이면 Windows 호스트 IP 탐색) ---
if [ -d "/mnt/c" ]; then
    # WSL 감지 — 여러 후보를 시도하여 실제 연결 가능한 IP를 찾는다.
    # WSL2 미러링 네트워킹: 127.0.0.1로 Windows에 직접 접근 가능
    # WSL2 NAT 모드: Hyper-V 게이트웨이 IP (보통 172.x.x.x) 필요
    WSL_GATEWAY=$(ip route show default 2>/dev/null | awk '{print $3}' || echo "")
    WSL_NAMESERVER=$(grep -m1 nameserver /etc/resolv.conf 2>/dev/null | awk '{print $2}' || echo "")

    GATEWAY=""
    for candidate in "127.0.0.1" "$WSL_GATEWAY" "$WSL_NAMESERVER"; do
        [ -z "$candidate" ] && continue
        if command -v curl >/dev/null 2>&1; then
            if curl -sf --max-time 2 "http://$candidate:$PORT/api/v1/health" >/dev/null 2>&1; then
                GATEWAY="$candidate"
                break
            fi
        fi
    done

    # 모두 실패하면 게이트웨이 IP를 기본값으로 사용 (--force 시 나중에 연결)
    if [ -z "$GATEWAY" ]; then
        GATEWAY="${WSL_GATEWAY:-127.0.0.1}"
        warn "WSL에서 laymux에 연결할 수 없었습니다. 기본값 사용: $GATEWAY"
    else
        info "WSL 감지 — 연결 확인된 IP: $GATEWAY"
    fi
else
    GATEWAY="127.0.0.1"
fi

info "Gateway: $GATEWAY"

# --- 3. JSON 읽기 & 필요 시 URL 치환 ---
MCP_JSON=$(cat "$JSON_FILE")
if [ "$GATEWAY" != "127.0.0.1" ]; then
    MCP_JSON=$(printf '%s' "$MCP_JSON" | sed "s/127\\.0\\.0\\.1/$GATEWAY/g")
    info "URL을 $GATEWAY 로 치환"
fi

# --- 4. Health check (WSL 게이트웨이 탐색에서 이미 통과했으면 스킵) ---
HEALTH_URL="http://$GATEWAY:$PORT/api/v1/health"
HEALTH_PASSED=false

if command -v curl >/dev/null 2>&1; then
    if curl -sf --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
        info "Health check 통과"
        HEALTH_PASSED=true
    else
        if [ "$FORCE" = true ]; then
            warn "Health check 실패 (--force로 계속 진행)"
        else
            error "Health check 실패. laymux가 실행 중인지 확인하세요.\n       --force로 무시할 수 있습니다."
        fi
    fi
else
    warn "curl이 없어 health check를 건너뜁니다."
fi

# --- 5. claude mcp add-json 으로 등록 ---
claude mcp add-json -s "$SCOPE" "$MCP_NAME" "$MCP_JSON"
info "MCP 등록 완료: $MCP_NAME (scope: $SCOPE)"

# --- 완료 ---
echo
echo "=== 설정 완료 ==="
echo "MCP URL: http://$GATEWAY:$PORT/mcp"
echo "Claude Code를 재시작한 후 /mcp 명령으로 $MCP_NAME 이 보이는지 확인하세요."
