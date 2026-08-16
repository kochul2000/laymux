#!/usr/bin/env node
// cargo target 디렉터리의 오래된 빌드 산출물을 정리한다.
//
// 빌드마다(`cargo tauri dev|build` → beforeDevCommand/beforeBuildCommand) 자동 실행되며,
// 하루 한 번만 실제 정리를 수행한다(스탬프 파일로 throttle).
//
// - cargo-sweep 이 설치돼 있으면 그걸 쓴다(툴체인 인지 정리).
// - 없으면 incremental 캐시만 mtime 기준으로 지운다. incremental 은 순수 캐시라
//   지워도 재컴파일 비용만 들고, 세션마다 새 디렉터리가 쌓여 용량의 주범이다.
//
// 절대 빌드를 실패시키지 않는다 — 무슨 일이 있어도 exit 0.
//
// 옵션/환경변수:
//   --force                     throttle 무시하고 즉시 정리
//   --target <dir>              대상 target 디렉터리 지정
//   LAYMUX_SWEEP_TARGET=0       정리 비활성화
//   LAYMUX_SWEEP_USE_CARGO=0    cargo-sweep 을 쓰지 않고 incremental 만 정리
//   LAYMUX_SWEEP_DAYS=10        이 일수보다 오래된 산출물 제거
//   LAYMUX_SWEEP_INTERVAL_HOURS=24  자동 실행 간격

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAMP_NAME = '.laymux-sweep-stamp';
const DEFAULT_DAYS = 10;
const DEFAULT_INTERVAL_HOURS = 24;

function parseArgs(argv) {
  const args = { force: false, target: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--target') {
      args.target = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return args;
}

function positiveNumber(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveTargetDir(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.CARGO_TARGET_DIR) return path.resolve(process.env.CARGO_TARGET_DIR);
  return path.join(REPO_ROOT, 'target');
}

function shouldRun(stampPath, intervalHours, force) {
  if (force) return true;
  try {
    const age = Date.now() - fs.statSync(stampPath).mtimeMs;
    return age >= intervalHours * 3600_000;
  } catch {
    return true; // 스탬프가 없으면 첫 실행
  }
}

function touchStamp(stampPath) {
  fs.writeFileSync(stampPath, `${new Date().toISOString()}\n`);
}

function hasCargoSweep() {
  if (process.env.LAYMUX_SWEEP_USE_CARGO === '0') return false;
  const probe = spawnSync('cargo', ['sweep', '--version'], { stdio: 'ignore', shell: false });
  return probe.status === 0;
}

function runCargoSweep(targetDir, days) {
  // --installed: 현재 설치되지 않은 툴체인의 산출물 제거
  // --time: 지정 일수보다 오래된 산출물 제거
  const result = spawnSync(
    'cargo',
    ['sweep', '--installed', '--time', String(days), targetDir],
    { stdio: 'inherit', shell: false },
  );
  return result.status === 0;
}

/** target/<profile>/incremental 아래에서 오래된 캐시 디렉터리를 지운다. */
function sweepIncremental(targetDir, days) {
  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;

  for (const profile of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (!profile.isDirectory()) continue;
    const incremental = path.join(targetDir, profile.name, 'incremental');
    let entries;
    try {
      entries = fs.readdirSync(incremental, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(incremental, entry.name);
      try {
        if (fs.statSync(entryPath).mtimeMs >= cutoff) continue;
        fs.rmSync(entryPath, { recursive: true, force: true });
        removed += 1;
      } catch {
        // 사용 중이거나 권한이 없으면 건너뛴다
      }
    }
  }
  return removed;
}

function main() {
  if (process.env.LAYMUX_SWEEP_TARGET === '0') return;

  const args = parseArgs(process.argv.slice(2));
  const targetDir = resolveTargetDir(args.target);
  if (!fs.existsSync(targetDir)) return;

  const days = positiveNumber(process.env.LAYMUX_SWEEP_DAYS, DEFAULT_DAYS);
  const intervalHours = positiveNumber(
    process.env.LAYMUX_SWEEP_INTERVAL_HOURS,
    DEFAULT_INTERVAL_HOURS,
  );
  const stampPath = path.join(targetDir, STAMP_NAME);
  if (!shouldRun(stampPath, intervalHours, args.force)) return;

  // 정리가 실패하더라도 매 빌드마다 재시도하지 않도록 스탬프를 먼저 찍는다.
  touchStamp(stampPath);

  if (hasCargoSweep()) {
    console.log(`[sweep-target] cargo sweep --installed --time ${days} (${targetDir})`);
    if (runCargoSweep(targetDir, days)) return;
    console.warn('[sweep-target] cargo sweep 실패 — incremental 정리로 폴백');
  }

  const removed = sweepIncremental(targetDir, days);
  console.log(
    `[sweep-target] incremental 캐시 ${removed}개 제거 (${days}일 초과). ` +
      '더 강하게 정리하려면 `cargo install cargo-sweep`.',
  );
}

try {
  main();
} catch (err) {
  console.warn(`[sweep-target] 건너뜀: ${err?.message ?? err}`);
}
