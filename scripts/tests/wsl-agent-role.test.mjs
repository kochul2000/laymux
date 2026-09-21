#!/usr/bin/env node
// 실제 프로덕션 sh 프로브를 격리한 /proc 픽스처에 실행한다.
// Windows: LAYMUX_TEST_WSL_DISTRO를 지정하거나 기본 Ubuntu-22.04 사용.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const marker = 'terminal-role-regression';

function rustScript(relativePath, constant) {
  const source = readFileSync(path.join(repo, relativePath), 'utf8');
  const match = source.match(new RegExp(`const ${constant}: &str = r#"([\\s\\S]*?)"#;`));
  assert.ok(match, `${constant}의 프로덕션 스크립트를 찾을 수 없음`);
  return match[1];
}

const probes = {
  attribution: rustScript('src-tauri/src/commands/wsl_agent_session.rs', 'WSL_PROCESS_PROBE'),
  liveness: rustScript('src-tauri/src/wsl_liveness.rs', 'WSL_LIVENESS_PROBE'),
};
const helperPath = path.join(repo, 'src-tauri/src/wsl_probe/agent-role.sh');
const helper = existsSync(helperPath) ? readFileSync(helperPath, 'utf8') : '';

function processFixture(pid, ppid, name, args = [name], hasMarker = true) {
  return { pid, ppid, name, args, hasMarker };
}

function ancestorFixtures() {
  return [
    processFixture(10, 0, 'Relay', ['Relay'], false),
    processFixture(11, 10, 'bash'),
    processFixture(12, 10, 'chrome'),
  ];
}

// NUL·개행·셸 메타문자를 코드로 해석하지 않고 원래 바이트 그대로 쓴다.
function octal(value) {
  return [...Buffer.from(value)].map((byte) => `\\${byte.toString(8).padStart(3, '0')}`).join('');
}

function fixtureScript(entries) {
  const commands = [];
  for (const entry of entries) {
    assert.ok(Number.isSafeInteger(entry.pid) && entry.pid > 0);
    assert.ok(Number.isSafeInteger(entry.ppid) && entry.ppid >= 0);
    const directory = `"$fixture_root/${entry.pid}"`;
    commands.push(`mkdir -p ${directory}/fd`);
    const files = {
      environ: `${entry.hasMarker ? `LX_TERMINAL_ID=${marker}\0` : ''}HOME=/home/test\0`,
      comm: `${entry.name}\n`,
      status: `Name:\t${entry.name}\nPPid:\t${entry.ppid}\n`,
    };
    if (entry.args !== null) files.cmdline = `${entry.args.join('\0')}\0`;
    for (const [name, value] of Object.entries(files)) {
      commands.push(`printf '%b' '${octal(value)}' > ${directory}/${name}`);
    }
  }
  return commands.join('\n');
}

function runProbe(kind, entries) {
  // 실제 /proc를 접근하지 않도록 두 프로브의 절대 경로를 모두 치환한다.
  const probe = probes[kind].replaceAll('/proc/', '${fixture_root}/');
  assert.ok(!probe.includes('/proc/'));
  const script = `
set -e
fixture_root=$(mktemp -d /tmp/laymux-agent-role-test.XXXXXXXX)
cleanup() {
  case "$fixture_root" in
    /tmp/laymux-agent-role-test.*) rm -rf -- "$fixture_root" ;;
    *) printf 'unexpected fixture path\\n' >&2; return 1 ;;
  esac
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
${fixtureScript(entries)}
${helper}
${probe}
`;
  const executable = process.platform === 'win32' ? 'wsl.exe' : 'sh';
  const args = process.platform === 'win32'
    ? ['-d', process.env.LAYMUX_TEST_WSL_DISTRO || 'Ubuntu-22.04', '--exec', 'sh']
    : [];
  const result = spawnSync(executable, args, {
    input: script,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${kind} 프로브 실패: ${result.stderr}`);
  const lines = result.stdout.trim().split(/\r?\n/);
  const prefix = kind === 'attribution' ? 'LAYMUX_WSL_AGENT_PROBE' : 'LAYMUX_WSL_LIVENESS_PROBE';
  assert.match(lines[0], new RegExp(`^${prefix}_V\\d+$`));
  assert.equal(lines.at(-1), `${prefix}_END`);
  return lines.slice(1, -1).filter(Boolean).map((line) => line.split('\t'));
}

function attributionRows(entries) {
  return runProbe('attribution', entries).filter((row) => row[0] === 'P');
}

function livePids(entries) {
  return runProbe('liveness', entries)
    .filter((row) => row[0] === 'A')
    .map((row) => Number(row[2]))
    .sort((a, b) => a - b);
}

function assertRole(rows, pid, expected) {
  const row = rows.find((item) => Number(item[2]) === pid);
  assert.ok(row, `PID ${pid}의 부모 연결 행이 사라짐`);
  assert.equal(row.length, 9, 'V3 P 행에는 마지막 helper 역할 필드가 필요함');
  assert.equal(row[8], expected, `PID ${pid}의 helper 역할`);
}

test('같은 깊이의 대화 Claude와 Chrome helper를 역할로 구별한다', () => {
  const entries = [
    ...ancestorFixtures(),
    processFixture(20, 11, 'claude', ['claude', '--dangerously-skip-permissions']),
    processFixture(30, 12, 'claude', ['/home/test/.local/bin/claude', '--chrome-native-host']),
  ];
  assert.deepEqual(livePids(entries), [20]);
  const rows = attributionRows(entries);
  assertRole(rows, 20, '0');
  assertRole(rows, 30, '1');
  assert.equal(rows.find((row) => row[2] === '30')[3], '12');
});

test('Chrome helper만 남으면 Claude liveness를 유지하지 않는다', () => {
  const entries = [
    ...ancestorFixtures(),
    processFixture(30, 12, 'claude', ['claude', '--chrome-native-host']),
  ];
  assert.deepEqual(livePids(entries), []);
  assertRole(attributionRows(entries), 30, '1');
});

test('helper를 경유하는 자손의 PPID 연결은 보존한다', () => {
  const entries = [
    ...ancestorFixtures(),
    processFixture(30, 12, 'claude', ['claude', '--chrome-native-host']),
    processFixture(40, 30, 'bash'),
    processFixture(50, 40, 'codex'),
  ];
  const rows = attributionRows(entries);
  assertRole(rows, 30, '1');
  assert.equal(rows.find((row) => row[2] === '40')[3], '30');
  assert.equal(rows.find((row) => row[2] === '50')[3], '40');
  assert.deepEqual(livePids(entries), [50]);
});

test('실제 대화 Claude 두 개는 모두 남겨 모호성 검사를 유지한다', () => {
  const entries = [
    ...ancestorFixtures(),
    processFixture(20, 11, 'claude', ['claude', '--dangerously-skip-permissions']),
    processFixture(30, 12, 'claude', ['claude', '--resume', 'another-session']),
  ];
  assert.deepEqual(livePids(entries), [20, 30]);
  const rows = attributionRows(entries);
  assertRole(rows, 20, '0');
  assertRole(rows, 30, '0');
});

for (const [description, name, args] of [
  ['Chrome 사용 옵션', 'claude', ['claude', '--chrome']],
  ['비슷한 옵션 이름', 'claude', ['claude', '--chrome-native-host-extra']],
  ['개행을 포함한 첫 인자', 'claude', ['claude', '--chrome-native-host\nnot-a-role']],
  ['프롬프트 값', 'claude', ['claude', '-p', '--chrome-native-host']],
  ['옵션 종료 뒤 문자열', 'claude', ['claude', '--', '--chrome-native-host']],
  ['읽을 수 없는 cmdline', 'claude', null],
  ['다른 provider의 같은 인자', 'codex', ['codex', '--chrome-native-host']],
]) {
  test(`${description}는 helper로 추측하지 않는다`, () => {
    const entries = [...ancestorFixtures(), processFixture(20, 11, name, args)];
    assert.deepEqual(livePids(entries), [20]);
    assertRole(attributionRows(entries), 20, '0');
  });
}
