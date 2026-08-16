#!/usr/bin/env node
// scripts/sweep-target.mjs 회귀 테스트. 실행: node scripts/tests/sweep-target.test.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'sweep-target.mjs');
const STAMP_NAME = '.laymux-sweep-stamp';
const DAY_MS = 86_400_000;

let failures = 0;

function check(name, condition) {
  if (condition) {
    console.log(`ok - ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${name}`);
  }
}

function ageDir(dir, days) {
  const t = new Date(Date.now() - days * DAY_MS);
  fs.utimesSync(dir, t, t);
}

/** target/debug/incremental 에 오래된/최근 캐시가 섞인 픽스처를 만든다. */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'laymux-sweep-'));
  const incremental = path.join(root, 'debug', 'incremental');
  const stale = path.join(incremental, 'laymux-stale');
  const fresh = path.join(incremental, 'laymux-fresh');
  fs.mkdirSync(stale, { recursive: true });
  fs.mkdirSync(fresh, { recursive: true });
  fs.writeFileSync(path.join(stale, 'blob'), 'x');
  fs.writeFileSync(path.join(fresh, 'blob'), 'x');
  ageDir(stale, 30);
  return { root, stale, fresh };
}

function run(target, { args = [], env = {} } = {}) {
  return spawnSync(process.execPath, [SCRIPT, '--target', target, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LAYMUX_SWEEP_USE_CARGO: '0', ...env },
  });
}

function testSweepsStaleKeepsFresh() {
  const { root, stale, fresh } = makeFixture();
  const result = run(root, { args: ['--force'] });
  check('sweep exits 0', result.status === 0);
  check('오래된 incremental 제거', !fs.existsSync(stale));
  check('최근 incremental 유지', fs.existsSync(fresh));
  check('스탬프 생성', fs.existsSync(path.join(root, STAMP_NAME)));
  fs.rmSync(root, { recursive: true, force: true });
}

function testThrottle() {
  const { root, stale } = makeFixture();
  fs.writeFileSync(path.join(root, STAMP_NAME), 'recent\n');
  const result = run(root);
  check('throttle 중에는 exit 0', result.status === 0);
  check('throttle 중에는 정리하지 않음', fs.existsSync(stale));
  fs.rmSync(root, { recursive: true, force: true });
}

function testThrottleExpires() {
  const { root, stale } = makeFixture();
  const stamp = path.join(root, STAMP_NAME);
  fs.writeFileSync(stamp, 'old\n');
  const old = new Date(Date.now() - 2 * DAY_MS);
  fs.utimesSync(stamp, old, old);
  run(root);
  check('간격이 지나면 정리 수행', !fs.existsSync(stale));
  fs.rmSync(root, { recursive: true, force: true });
}

function testDisabled() {
  const { root, stale } = makeFixture();
  run(root, { args: ['--force'], env: { LAYMUX_SWEEP_TARGET: '0' } });
  check('LAYMUX_SWEEP_TARGET=0 이면 정리하지 않음', fs.existsSync(stale));
  fs.rmSync(root, { recursive: true, force: true });
}

function testDaysOverride() {
  const { root, stale, fresh } = makeFixture();
  run(root, { args: ['--force'], env: { LAYMUX_SWEEP_DAYS: '60' } });
  check('LAYMUX_SWEEP_DAYS 초과분만 제거', fs.existsSync(stale) && fs.existsSync(fresh));
  fs.rmSync(root, { recursive: true, force: true });
}

function testMissingTarget() {
  const result = run(path.join(os.tmpdir(), 'laymux-sweep-does-not-exist'), { args: ['--force'] });
  check('target 이 없어도 exit 0', result.status === 0);
}

testSweepsStaleKeepsFresh();
testThrottle();
testThrottleExpires();
testDisabled();
testDaysOverride();
testMissingTarget();

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log('all sweep-target tests passed');
