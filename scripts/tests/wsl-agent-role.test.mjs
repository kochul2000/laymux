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
    processFixture(1, 0, 'init', ['init'], false),
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
      status: `Name:\t${entry.name}\n${entry.state === null ? '' : `State:\t${entry.state ?? 'S (sleeping)'}\n`}PPid:\t${entry.ppid}\n`,
    };
    if (entry.args !== null) files.cmdline = `${entry.args.join('\0')}\0`;
    for (const [name, value] of Object.entries(files)) {
      commands.push(`printf '%b' '${octal(value)}' > ${directory}/${name}`);
    }
    if (entry.rollout) {
      commands.push(`ln -s /home/test/.codex/sessions/2026/09/29/rollout-test.jsonl ${directory}/fd/9`);
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

test('더 얕은 Claude daemon이 실제 Codex TUI를 가리지 않는다', () => {
  const entries = [
    ...ancestorFixtures(),
    processFixture(30, 10, 'claude', ['/home/test/.local/bin/claude', 'daemon']),
    processFixture(20, 11, 'codex', ['codex', '--yolo', '--no-daemon']),
  ];
  assert.deepEqual(livePids(entries), [20]);
  const rows = attributionRows(entries);
  assertRole(rows, 20, '0');
  assertRole(rows, 30, '1');
});

test('Claude daemon만 남으면 대화 liveness를 유지하지 않는다', () => {
  const entries = [...ancestorFixtures(), processFixture(30, 10, 'claude', ['claude', 'daemon'])];
  assert.deepEqual(livePids(entries), []);
  assertRole(attributionRows(entries), 30, '1');
});

test('Claude daemon을 경유하는 실제 대화 자손은 보존한다', () => {
  const entries = [
    ...ancestorFixtures(),
    processFixture(30, 10, 'claude', ['claude', 'daemon', 'start']),
    processFixture(40, 30, 'bash'),
    processFixture(50, 40, 'claude', ['claude', '--resume', 'conversation']),
  ];
  assert.deepEqual(livePids(entries), [50]);
  const rows = attributionRows(entries);
  assertRole(rows, 30, '1');
  assertRole(rows, 50, '0');
  assert.equal(rows.find((row) => row[2] === '40')[3], '30');
});

for (const args of [
  ['claude', 'daemon-extra'],
  ['claude', 'daemon\nnot-a-role'],
  ['claude', '-p', 'daemon'],
  ['claude', '--', 'daemon'],
  ['claude', '--resume', 'daemon'],
]) {
  test(`daemon 역할이 아닌 Claude 인자는 유지: ${JSON.stringify(args)}`, () => {
    const entries = [...ancestorFixtures(), processFixture(20, 11, 'claude', args)];
    assert.deepEqual(livePids(entries), [20]);
    assertRole(attributionRows(entries), 20, '0');
  });
}

test('Codex TUI 종료 뒤 남은 app-server 두 개는 대화가 아니다', () => {
  const entries = [
    ...ancestorFixtures(),
    processFixture(30, 1, 'codex', ['/opt/codex', 'app-server', '--listen', 'unix:///tmp/codex.sock']),
    processFixture(31, 30, 'codex', ['/opt/codex', 'app-server']),
  ];
  assert.deepEqual(livePids(entries), []);
  const rows = attributionRows(entries);
  assertRole(rows, 30, '1');
  assertRole(rows, 31, '1');
});

for (const provider of ['codex', 'claude', 'grok']) {
  for (const state of ['Z (zombie)', 'X (dead)']) {
    test(`${provider}의 ${state} 프로세스는 실행 및 세션 후보가 아니다`, () => {
      const dead = { ...processFixture(40, 30, provider, []), state };
      const entries = [
        ...ancestorFixtures(),
        processFixture(20, 11, provider),
        processFixture(30, 1, 'codex', ['codex', 'app-server']),
        dead,
      ];
      assert.deepEqual(livePids(entries), [20]);
      assert.ok(!attributionRows(entries).some((row) => row[2] === '40'));
      // 실제 좀비는 자신의 환경과 cmdline이 비고 부모 marker만 남는다.
      dead.hasMarker = false;
      assert.deepEqual(livePids(entries), [20]);
    });
  }
}

for (const state of ['R (running)', 'S (sleeping)', 'D (disk sleep)', 'T (stopped)', 't (tracing stop)', null, 'Z-not-a-state']) {
  test(`종료가 증명되지 않은 프로세스 상태는 유지: ${state}`, () => {
    const entries = [
      ...ancestorFixtures(),
      { ...processFixture(20, 11, 'codex', null), state },
    ];
    assert.deepEqual(livePids(entries), [20]);
    assertRole(attributionRows(entries), 20, '0');
  });
}

test('Codex 서버와 함께 실행한 실제 TUI는 유지한다', () => {
  const entries = [
    ...ancestorFixtures(),
    processFixture(20, 11, 'codex', ['codex', 'resume', 'session-id']),
    processFixture(30, 1, 'codex', ['codex', 'app-server']),
  ];
  assert.deepEqual(livePids(entries), [20]);
  const rows = attributionRows(entries);
  assertRole(rows, 20, '0');
  assertRole(rows, 30, '1');
});

test('서버의 rollout FD는 읽지 않고 실제 TUI의 FD만 귀속에 제공한다', () => {
  const entries = [
    ...ancestorFixtures(),
    { ...processFixture(20, 11, 'codex'), rollout: true },
    { ...processFixture(30, 1, 'codex', ['codex', 'app-server']), rollout: true },
  ];
  const rows = runProbe('attribution', entries);
  assertRole(rows.filter((row) => row[0] === 'P'), 30, '1');
  assert.deepEqual(rows.filter((row) => row[0] === 'R').map((row) => Number(row[2])), [20]);
});

for (const args of [
  ['codex', 'app-server-extra'],
  ['codex', 'app-server\nnot-a-role'],
  ['codex', '--', 'app-server'],
  ['codex', '-c', 'app-server'],
  ['codex', 'resume', 'app-server'],
  null,
]) {
  test(`명시적인 서버 역할이 아닌 Codex 인자는 유지: ${JSON.stringify(args)}`, () => {
    const entries = [...ancestorFixtures(), processFixture(20, 11, 'codex', args)];
    assert.deepEqual(livePids(entries), [20]);
    assertRole(attributionRows(entries), 20, '0');
  });
}

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
