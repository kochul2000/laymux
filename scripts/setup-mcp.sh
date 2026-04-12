#!/usr/bin/env bash
set -euo pipefail

# laymux 내장 MCP 서버 설정 스크립트 (Streamable HTTP)
#
# laymux의 고정 포트를 사용하여 Claude Code MCP 설정을 자동 등록한다.
# 인증 불필요 — IP allowlist로 로컬 접근만 허용.
# 기본: 전역 등록 (~/.claude.json), --project: 프로젝트별 (.mcp.json)
#
# 사용법:
#   ./setup-mcp.sh                    # 전역 (~/.claude.json)
#   ./setup-mcp.sh --project /path    # 프로젝트 (.mcp.json)
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

# --- jq 확인 ---
command -v jq >/dev/null 2>&1 || error "jq가 설치되어 있지 않습니다. (sudo apt install jq)"

# --- 인자 파싱 ---
SCOPE="global"
PROJECT_DIR=""
USE_DEV=false
FORCE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --project)
            SCOPE="project"
            PROJECT_DIR="${2:-}"
            [ -z "$PROJECT_DIR" ] && error "--project 뒤에 경로를 지정하세요."
            shift 2
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
            error "알 수 없는 옵션: $1\n사용법: $0 [--project /path] [--dev] [--force]"
            ;;
    esac
done

# --- 1. Port 결정 ---
echo "=== laymux MCP 설정 (내장 HTTP) ==="
echo

if [ "$USE_DEV" = true ]; then
    MCP_NAME="laymux-dev"
    PORT=19281
else
    MCP_NAME="laymux"
    PORT=19280
fi

info "서버: $MCP_NAME"
info "Port: $PORT"

# --- 2. Gateway IP 결정 ---
if [ -d "/mnt/c" ]; then
    # WSL: Windows host IP
    GATEWAY=$(ip route show default 2>/dev/null | awk '{print $3}' || echo "")
    if [ -z "$GATEWAY" ]; then
        # Fallback: /etc/resolv.conf nameserver
        GATEWAY=$(grep -m1 nameserver /etc/resolv.conf | awk '{print $2}' || echo "127.0.0.1")
    fi
else
    GATEWAY="127.0.0.1"
fi

info "Gateway: $GATEWAY"

# --- 3. Health check ---
MCP_URL="http://$GATEWAY:$PORT/mcp"
HEALTH_URL="http://$GATEWAY:$PORT/api/v1/health"

if command -v curl >/dev/null 2>&1; then
    if curl -sf --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
        info "Health check 통과"
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

# --- 4. .mcp.json 생성 ---
MCP_CONFIG=$(cat <<EOF
{
  "mcpServers": {
    "$MCP_NAME": {
      "type": "http",
      "url": "$MCP_URL"
    }
  }
}
EOF
)

if [ "$SCOPE" = "global" ]; then
    TARGET="$HOME/.claude.json"

    if [ -f "$TARGET" ]; then
        # Merge into existing file
        EXISTING=$(cat "$TARGET")
        echo "$EXISTING" | jq --arg name "$MCP_NAME" --arg url "$MCP_URL" \
            '.mcpServers[$name] = { "type": "http", "url": $url }' \
            > "$TARGET.tmp"
        mv "$TARGET.tmp" "$TARGET"
    else
        echo "$MCP_CONFIG" > "$TARGET"
    fi
    info "전역 등록 완료: $TARGET ($MCP_NAME)"
else
    PROJECT_DIR="$(realpath "$PROJECT_DIR")"
    [ -d "$PROJECT_DIR" ] || error "디렉토리가 존재하지 않습니다: $PROJECT_DIR"
    TARGET="$PROJECT_DIR/.mcp.json"

    if [ -f "$TARGET" ]; then
        jq --arg name "$MCP_NAME" --arg url "$MCP_URL" \
            '.mcpServers[$name] = { "type": "http", "url": $url }' \
            "$TARGET" > "$TARGET.tmp"
        mv "$TARGET.tmp" "$TARGET"
    else
        echo "$MCP_CONFIG" > "$TARGET"
    fi
    info "프로젝트 등록 완료: $TARGET ($MCP_NAME)"
fi

# --- 5. 권한 설정 ---
SETTINGS="$HOME/.claude/settings.json"
PERMISSION_RULE="mcp__${MCP_NAME}__*"

if [ -f "$SETTINGS" ]; then
    if jq -e --arg rule "$PERMISSION_RULE" '.permissions.allow | index($rule)' "$SETTINGS" >/dev/null 2>&1; then
        info "권한이 이미 설정되어 있습니다."
    else
        jq --arg rule "$PERMISSION_RULE" '.permissions.allow += [$rule]' "$SETTINGS" > "$SETTINGS.tmp"
        mv "$SETTINGS.tmp" "$SETTINGS"
        info "권한 추가 완료: $PERMISSION_RULE"
    fi
else
    warn "$SETTINGS 파일이 없습니다. 수동으로 권한을 추가하세요:"
    echo "  \"$PERMISSION_RULE\""
fi

# --- 완료 ---
echo
echo "=== 설정 완료 ==="
echo "MCP URL: $MCP_URL"
echo "Claude Code를 재시작한 후 /mcp 명령으로 $MCP_NAME 이 보이는지 확인하세요."
echo
echo "인증이 필요 없으므로 laymux를 재시작해도 이 설정은 유효합니다."
