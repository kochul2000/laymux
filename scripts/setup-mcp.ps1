#Requires -Version 5.1
<#
.SYNOPSIS
    laymux 내장 MCP 서버 설정 스크립트 (Streamable HTTP) — Windows PowerShell 버전

.DESCRIPTION
    laymux가 실행 중이면 discovery 파일에서 port를 읽어
    Claude Code MCP 설정을 자동 등록한다. 별도 빌드 불필요.
    인증 불필요 — IP allowlist로 로컬 접근만 허용.
    JSON 처리에 Python을 사용한다 (PowerShell 5.1의 대용량 JSON 파싱 제한 회피).

.EXAMPLE
    .\setup-mcp.ps1                          # 전역 (~/.claude.json)
    .\setup-mcp.ps1 -Project C:\dev\myapp    # 프로젝트 (.mcp.json)
    .\setup-mcp.ps1 -Dev                     # dev 인스턴스 (포트 19281)
    .\setup-mcp.ps1 -Force                   # health check 실패해도 계속 진행
#>

param(
    [string]$Project,
    [switch]$Dev,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- 색상 헬퍼 ---
function Write-Ok    { param([string]$Msg) Write-Host "[OK] $Msg" -ForegroundColor Green }
function Write-Warn  { param([string]$Msg) Write-Host "[WARN] $Msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red; exit 1 }

# --- Python 확인 ---
$PythonCmd = $null
foreach ($cmd in @("python", "python3", "py")) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
        $PythonCmd = $cmd
        break
    }
}
if (-not $PythonCmd) {
    Write-Err "Python이 설치되어 있지 않습니다. JSON 처리에 Python이 필요합니다."
}

# --- 1. Port 결정 ---
Write-Host "=== laymux MCP 설정 (내장 HTTP) ==="
Write-Host ""

$McpName = if ($Dev) { "laymux-dev" } else { "laymux" }
$Port = if ($Dev) { 19281 } else { 19280 }
$Gateway = "127.0.0.1"
$McpUrl = "http://${Gateway}:${Port}/mcp"

Write-Ok "서버: $McpName"
Write-Ok "Port: $Port"
Write-Ok "Gateway: $Gateway"

# --- 2. Health check ---
$HealthUrl = "http://${Gateway}:${Port}/api/v1/health"

try {
    $null = Invoke-RestMethod -Uri $HealthUrl -Method Get -TimeoutSec 3
    Write-Ok "Health check 통과"
} catch {
    if ($Force) {
        Write-Warn "Health check 실패 (-Force로 계속 진행)"
    } else {
        Write-Err "Health check 실패. laymux가 실행 중인지 확인하세요.`n       -Force로 무시할 수 있습니다."
    }
}

# --- 3. MCP 설정 등록 (Python으로 JSON 안전 처리) ---
$Scope = if ($Project) { "project" } else { "global" }

if ($Scope -eq "global") {
    $Target = Join-Path $env:USERPROFILE ".claude.json"
} else {
    $ProjectDir = Resolve-Path $Project -ErrorAction Stop
    if (-not (Test-Path $ProjectDir -PathType Container)) {
        Write-Err "디렉토리가 존재하지 않습니다: $Project"
    }
    $Target = Join-Path $ProjectDir ".mcp.json"
}

$pyScript = @"
import json, sys, os

target = sys.argv[1]
name = sys.argv[2]
url = sys.argv[3]

if os.path.exists(target):
    with open(target, encoding='utf-8-sig') as f:
        data = json.load(f)
else:
    data = {}

if 'mcpServers' not in data:
    data['mcpServers'] = {}

data['mcpServers'][name] = {
    'type': 'http',
    'url': url,
}

with open(target, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)

print('ok')
"@

$result = & $PythonCmd -c $pyScript $Target $McpName $McpUrl 2>&1
if ($result -ne "ok") {
    Write-Err "MCP 설정 등록 실패: $result"
}

$scopeLabel = if ($Scope -eq "global") { "전역" } else { "프로젝트" }
Write-Ok "$scopeLabel 등록 완료: $Target ($McpName)"

# --- 4. 권한 설정 (Python으로 JSON 안전 처리) ---
$SettingsPath = Join-Path (Join-Path $env:USERPROFILE ".claude") "settings.json"
$PermissionRule = "mcp__${McpName}__*"

$pyPermScript = @"
import json, sys, os

target = sys.argv[1]
rule = sys.argv[2]

if not os.path.exists(target):
    print('no_file')
    sys.exit(0)

with open(target, encoding='utf-8-sig') as f:
    data = json.load(f)

perms = data.setdefault('permissions', {})
allow = perms.setdefault('allow', [])

if rule in allow:
    print('already')
    sys.exit(0)

allow.append(rule)

with open(target, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)

print('added')
"@

$permResult = & $PythonCmd -c $pyPermScript $SettingsPath $PermissionRule 2>&1

switch ($permResult) {
    "already" { Write-Ok "권한이 이미 설정되어 있습니다." }
    "added"   { Write-Ok "권한 추가 완료: $PermissionRule" }
    "no_file" {
        Write-Warn "$SettingsPath 파일이 없습니다. 수동으로 권한을 추가하세요:"
        Write-Host "  `"$PermissionRule`""
    }
    default {
        Write-Warn "권한 설정 실패: $permResult"
    }
}

# --- 완료 ---
Write-Host ""
Write-Host "=== 설정 완료 ==="
Write-Host "MCP URL: $McpUrl"
Write-Host "Claude Code를 재시작한 후 /mcp 명령으로 $McpName 이 보이는지 확인하세요."
Write-Host ""
Write-Host "인증이 필요 없으므로 laymux를 재시작해도 이 설정은 유효합니다."
