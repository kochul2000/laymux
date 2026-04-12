#Requires -Version 5.1
<#
.SYNOPSIS
    laymux 내장 MCP 서버 설정 스크립트 (claude mcp add-json 사용) — Windows PowerShell 버전

.DESCRIPTION
    scripts/mcp/ 의 JSON 정의를 claude mcp add-json 으로 등록한다.
    인증 불필요 — IP allowlist로 로컬 접근만 허용.

.EXAMPLE
    .\setup-mcp.ps1                   # user scope (전역)
    .\setup-mcp.ps1 -Project          # project scope (현재 프로젝트)
    .\setup-mcp.ps1 -Dev              # dev 인스턴스 (포트 19281)
    .\setup-mcp.ps1 -Force            # health check 실패해도 계속 진행
#>

param(
    [switch]$Project,
    [switch]$Dev,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- 색상 헬퍼 ---
function Write-Ok    { param([string]$Msg) Write-Host "[OK] $Msg" -ForegroundColor Green }
function Write-Warn  { param([string]$Msg) Write-Host "[WARN] $Msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red; exit 1 }

# --- claude CLI 확인 ---
if (-not (Get-Command "claude" -ErrorAction SilentlyContinue)) {
    Write-Err "claude CLI가 설치되어 있지 않습니다."
}

# --- 1. 서버 결정 ---
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Scope = if ($Project) { "project" } else { "user" }

if ($Dev) {
    $McpName = "laymux-dev"
    $Port = 19281
    $JsonFile = Join-Path $ScriptDir "mcp\laymux-dev.json"
} else {
    $McpName = "laymux"
    $Port = 19280
    $JsonFile = Join-Path $ScriptDir "mcp\laymux.json"
}

if (-not (Test-Path $JsonFile)) {
    Write-Err "JSON 파일을 찾을 수 없습니다: $JsonFile"
}

Write-Host "=== laymux MCP 설정 (claude mcp add-json) ==="
Write-Host ""
Write-Ok "서버: $McpName"
Write-Ok "Port: $Port"
Write-Ok "Scope: $Scope"

$Gateway = "127.0.0.1"
Write-Ok "Gateway: $Gateway"

$McpJson = Get-Content $JsonFile -Raw -Encoding UTF8

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

# --- 3. claude mcp add-json 으로 등록 ---
& claude mcp add-json -s $Scope $McpName $McpJson
if ($LASTEXITCODE -ne 0) {
    Write-Err "claude mcp add-json 실패"
}
Write-Ok "MCP 등록 완료: $McpName (scope: $Scope)"

# --- 완료 ---
$McpUrl = "http://${Gateway}:${Port}/mcp"
Write-Host ""
Write-Host "=== 설정 완료 ==="
Write-Host "MCP URL: $McpUrl"
Write-Host "Claude Code를 재시작한 후 /mcp 명령으로 $McpName 이 보이는지 확인하세요."
