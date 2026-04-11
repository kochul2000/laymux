#!/usr/bin/env bash
set -euo pipefail

# laymux 내장 MCP 서버 설정 스크립트 (Streamable HTTP)
#
# laymux가 실행 중이면 discovery 파일에서 port/key를 읽어
# Claude Code MCP 설정을 자동 등록한다. 별도 빌드 불필요.
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

# --- 1. Discovery 파일 찾기 ---
echo "=== laymux MCP 설정 (내장 HTTP) ==="
echo

# Determine discovery file path
if [ "$USE_DEV" = true ]; then
    APP_DIR="laymux-dev"
else
    APP_DIR="laymux"
fi

# Try WSL path first (Windows %APPDATA% via /mnt/c)
DISCOVERY=""

if [ -d "/mnt/c" ]; then
    # WSL: resolve current Windows user via cmd.exe, not glob
    WIN_USER=$(cmd.exe /C "echo %USERNAME%" 2>/dev/null | tr -d '\r\n' || echo "")
    if [ -n "$WIN_USER" ]; then
        candidate="/mnt/c/Users/$WIN_USER/AppData/Roaming/$APP_DIR/automation.json"
        if [ -f "$candidate" ]; then
            DISCOVERY="$candidate"
        fi
    fi

    # Fallback: glob (single-user machines)
    if [ -z "$DISCOVERY" ]; then
        for user_dir in /mnt/c/Users/*/AppData/Roaming; do
            candidate="$user_dir/$APP_DIR/automation.json"
            if [ -f "$candidate" ]; then
                DISCOVERY="$candidate"
                break
            fi
        done
    fi
fi

# Fallback: Linux native
if [ -z "$DISCOVERY" ] && [ -f "$HOME/.config/$APP_DIR/automation.json" ]; then
    DISCOVERY="$HOME/.config/$APP_DIR/automation.json"
fi

[ -z "$DISCOVERY" ] && error "automation.json을 찾을 수 없습니다. laymux가 실행 중인지 확인하세요."
info "Discovery 파일: $DISCOVERY"

# --- 2. Port / Key 읽기 ---
command -v jq >/dev/null 2>&1 || error "jq가 설치되어 있지 않습니다. (sudo apt install jq)"

PORT=$(jq -r '.port' "$DISCOVERY")
KEY=$(jq -r '.key' "$DISCOVERY")

[ -z "$PORT" ] || [ "$PORT" = "null" ] && error "discovery 파일에서 port를 읽을 수 없습니다."
[ -z "$KEY" ] || [ "$KEY" = "null" ] && error "discovery 파일에서 key를 읽을 수 없습니다."

info "Port: $PORT"
info "Key: ${KEY:0:8}...${KEY: -4}"

# --- 3. Gateway IP 결정 ---
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

# --- 4. Health check ---
MCP_URL="http://$GATEWAY:$PORT/mcp"
HEALTH_URL="http://$GATEWAY:$PORT/api/v1/health"

HEALTH_OK=false
if command -v curl >/dev/null 2>&1; then
    if curl -sf --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
        info "Health check 통과"
        HEALTH_OK=true
    else
        if [ "$FORCE" = true ]; then
            warn "Health check 실패 (--force로 계속 진행)"
        else
            error "Health check 실패. laymux가 실행 중인지 확인하세요.\n       stale automation.json일 수 있습니다. --force로 무시할 수 있습니다."
        fi
    fi
else
    warn "curl이 없어 health check를 건너뜁니다."
fi

# --- 5. .mcp.json 생성 ---
MCP_CONFIG=$(cat <<EOF
{
  "mcpServers": {
    "laymux": {
      "type": "http",
      "url": "$MCP_URL",
      "headers": {
        "Authorization": "Bearer $KEY"
      }
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
        echo "$EXISTING" | jq --arg url "$MCP_URL" --arg key "Bearer $KEY" \
            '.mcpServers.laymux = { "type": "http", "url": $url, "headers": { "Authorization": $key } }' \
            > "$TARGET.tmp"
        mv "$TARGET.tmp" "$TARGET"
    else
        echo "$MCP_CONFIG" > "$TARGET"
    fi
    info "전역 등록 완료: $TARGET"
else
    PROJECT_DIR="$(realpath "$PROJECT_DIR")"
    [ -d "$PROJECT_DIR" ] || error "디렉토리가 존재하지 않습니다: $PROJECT_DIR"
    TARGET="$PROJECT_DIR/.mcp.json"

    if [ -f "$TARGET" ]; then
        jq --arg url "$MCP_URL" --arg key "Bearer $KEY" \
            '.mcpServers.laymux = { "type": "http", "url": $url, "headers": { "Authorization": $key } }' \
            "$TARGET" > "$TARGET.tmp"
        mv "$TARGET.tmp" "$TARGET"
    else
        echo "$MCP_CONFIG" > "$TARGET"
    fi
    info "프로젝트 등록 완료: $TARGET"
fi

# --- 6. 권한 설정 ---
SETTINGS="$HOME/.claude/settings.json"
PERMISSION_RULE="mcp__laymux__*"

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
echo "Claude Code를 재시작한 후 /mcp 명령으로 laymux가 보이는지 확인하세요."
echo
echo "참고: laymux를 재시작하면 Bearer key가 변경됩니다."
echo "      그 때 이 스크립트를 다시 실행하세요."
