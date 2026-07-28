#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$REPO_ROOT/scripts/kill-dev.sh"
FIXTURE=""
SYSTEM_POWERSHELL=$(command -v powershell.exe 2>/dev/null || true)

cleanup_fixture() {
  if [[ -n "$FIXTURE" && -d "$FIXTURE" ]]; then
    rm -rf "$FIXTURE"
  fi
}
trap cleanup_fixture EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local haystack=$1 needle=$2
  [[ "$haystack" == *"$needle"* ]] || fail "expected output to contain '$needle', got: $haystack"
}

assert_file_contains() {
  local file=$1 needle=$2
  grep -F -- "$needle" "$file" >/dev/null || fail "expected $file to contain '$needle'"
}

make_fixture() {
  cleanup_fixture
  FIXTURE=$(mktemp -d)
  mkdir -p "$FIXTURE/appdata/laymux-dev" "$FIXTURE/bin"

  cat >"$FIXTURE/bin/uname" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-o" ]]; then
  echo Msys
else
  echo MINGW64_NT
fi
EOF
  cat >"$FIXTURE/bin/taskkill" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$KILL_DEV_TEST_TASKKILL_LOG"
EOF
  cat >"$FIXTURE/bin/netstat" <<'EOF'
#!/usr/bin/env bash
printf '  TCP    0.0.0.0:19281    0.0.0.0:0    LISTENING    %s\n' "${KILL_DEV_TEST_PORT_PID:-7777}"
EOF
  cat >"$FIXTURE/bin/powershell.exe" <<'EOF'
#!/usr/bin/env bash
if [[ "$#" -ne 4 || "$1" != "-NoProfile" || "$2" != "-NonInteractive" || "$3" != "-Command" ]]; then
  echo "mock PowerShell 5.1: arguments after the command text are parsed as command text" >&2
  exit 64
fi
if [[ "$4" != *'$env:LAYMUX_KILL_DEV_TARGET_PID'* ]]; then
  echo "mock PowerShell 5.1: command must read the one-shot PID environment variable" >&2
  exit 65
fi
pid=${LAYMUX_KILL_DEV_TARGET_PID:?missing one-shot PID environment variable}
printf 'D:\\trees\\pid-%s\\target\\debug\\laymux.exe\n' "$pid"
EOF
  chmod +x "$FIXTURE/bin/uname" "$FIXTURE/bin/taskkill" "$FIXTURE/bin/netstat" "$FIXTURE/bin/powershell.exe"
  export KILL_DEV_TEST_TASKKILL_LOG="$FIXTURE/taskkill.log"
  export PATH="$FIXTURE/bin:$PATH"
}

test_real_powershell_51_reads_the_one_shot_pid_when_available() {
  if [[ -z "$SYSTEM_POWERSHELL" ]]; then
    return
  fi

  output=$(LAYMUX_KILL_DEV_TARGET_PID=4242 "$SYSTEM_POWERSHELL" \
    -NoProfile -NonInteractive -Command \
    '$processId = [int]$env:LAYMUX_KILL_DEV_TARGET_PID; Write-Output $processId' | tr -d '\r')

  [[ "$output" == "4242" ]] || fail "real Windows PowerShell did not receive one-shot PID: $output"
}

test_discovery_pid_reports_its_executable() {
  make_fixture
  printf '{"port":19281,"pid":4242}\n' >"$FIXTURE/appdata/laymux-dev/automation.json"

  output=$(APPDATA="$FIXTURE/appdata" bash "$SCRIPT" 2>&1)

  assert_contains "$output" "Dev (PID 4242) killed (automation.json)"
  assert_contains "$output" 'D:\trees\pid-4242\target\debug\laymux.exe'
  assert_file_contains "$KILL_DEV_TEST_TASKKILL_LOG" "//PID 4242 //F //T"
  if grep -F -- "7777" "$KILL_DEV_TEST_TASKKILL_LOG" >/dev/null; then
    fail "valid discovery pid must win over the port fallback"
  fi
}

test_wrong_port_discovery_falls_back_and_reports_port_owner() {
  make_fixture
  printf '{"port":19280,"pid":4242}\n' >"$FIXTURE/appdata/laymux-dev/automation.json"

  output=$(APPDATA="$FIXTURE/appdata" KILL_DEV_TEST_PORT_PID=7777 bash "$SCRIPT" 2>&1)

  assert_contains "$output" "Dev (PID 7777) killed (port 19281)"
  assert_contains "$output" 'D:\trees\pid-7777\target\debug\laymux.exe'
  assert_file_contains "$KILL_DEV_TEST_TASKKILL_LOG" "//PID 7777 //F //T"
  if grep -F -- "4242" "$KILL_DEV_TEST_TASKKILL_LOG" >/dev/null; then
    fail "a discovery file for the release port must never select its pid"
  fi
}

test_real_powershell_51_reads_the_one_shot_pid_when_available
test_discovery_pid_reports_its_executable
test_wrong_port_discovery_falls_back_and_reports_port_owner
echo "kill-dev tests passed"
