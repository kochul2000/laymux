#!/usr/bin/env bash
set -euo pipefail

# laymux-mcp 설치 스크립트
# 사용법: ./setup.sh [--project /path/to/project]
#   옵션 없이 실행하면 전역(user scope)으로 등록한다.
#   --project 옵션을 주면 해당 프로젝트에만 등록한다.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="$SCRIPT_DIR/../target/release/laymux-mcp"
SETTINGS="$HOME/.claude/settings.json"
PERMISSION_RULE="mcp__laymux__*"

# --- 색상 ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# --- 인자 파싱 ---
SCOPE="user"
PROJECT_DIR=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --project)
            SCOPE="project"
            PROJECT_DIR="${2:-}"
            [ -z "$PROJECT_DIR" ] && error "--project 뒤에 경로를 지정하세요."
            shift 2
            ;;
        *)
            error "알 수 없는 옵션: $1\n사용법: $0 [--project /path/to/project]"
            ;;
    esac
done

# --- 1. 전제 조건 확인 ---
echo "=== laymux-mcp 설치 ==="
echo

command -v cargo >/dev/null 2>&1 || error "cargo가 설치되어 있지 않습니다. https://rustup.rs 에서 설치하세요."
command -v claude >/dev/null 2>&1 || error "Claude Code CLI가 설치되어 있지 않습니다."

# --- 2. 빌드 ---
echo "1) 빌드 중..."
(cd "$SCRIPT_DIR" && cargo build --release --quiet)
BINARY="$(realpath "$SCRIPT_DIR/../target/release/laymux-mcp")"
info "빌드 완료: $BINARY"

# --- 3. MCP 서버 등록 ---
echo "2) MCP 서버 등록 중... (scope: $SCOPE)"

if [ "$SCOPE" = "user" ]; then
    # 전역 등록: claude mcp add --scope user
    claude mcp remove laymux --scope user 2>/dev/null || true
    claude mcp add --transport stdio laymux --scope user "$BINARY"
    info "전역 등록 완료 (모든 프로젝트에서 사용 가능)"
else
    # 프로젝트 등록: .mcp.json
    PROJECT_DIR="$(realpath "$PROJECT_DIR")"
    [ -d "$PROJECT_DIR" ] || error "디렉토리가 존재하지 않습니다: $PROJECT_DIR"

    command -v jq >/dev/null 2>&1 || error "jq가 설치되어 있지 않습니다. (sudo apt install jq)"

    MCP_JSON="$PROJECT_DIR/.mcp.json"

    if [ -f "$MCP_JSON" ]; then
        if jq -e '.mcpServers.laymux' "$MCP_JSON" >/dev/null 2>&1; then
            warn "$MCP_JSON 에 이미 laymux가 등록되어 있습니다. 덮어씁니다."
        fi
        jq --arg cmd "$BINARY" '.mcpServers.laymux = {"command": $cmd, "args": []}' "$MCP_JSON" > "$MCP_JSON.tmp"
        mv "$MCP_JSON.tmp" "$MCP_JSON"
    else
        cat > "$MCP_JSON" <<EOF
{
  "mcpServers": {
    "laymux": {
      "command": "$BINARY",
      "args": []
    }
  }
}
EOF
    fi
    info "프로젝트 등록 완료: $MCP_JSON"
fi

# --- 4. Claude Code 권한 설정 ---
echo "3) 도구 권한 설정 중..."

if [ -f "$SETTINGS" ]; then
    command -v jq >/dev/null 2>&1 || { warn "jq가 없어 권한 설정을 건너뜁니다. 수동으로 추가하세요."; exit 0; }

    if jq -e --arg rule "$PERMISSION_RULE" '.permissions.allow | index($rule)' "$SETTINGS" >/dev/null 2>&1; then
        info "권한이 이미 설정되어 있습니다."
    else
        jq --arg rule "$PERMISSION_RULE" '.permissions.allow += [$rule]' "$SETTINGS" > "$SETTINGS.tmp"
        mv "$SETTINGS.tmp" "$SETTINGS"
        info "권한 추가 완료: $PERMISSION_RULE"
    fi
else
    warn "$SETTINGS 파일이 없습니다. 수동으로 권한을 추가하세요."
fi

# --- 완료 ---
echo
echo "=== 설치 완료 ==="
echo "Claude Code를 재시작한 후 /mcp 명령으로 laymux가 보이는지 확인하세요."
