#!/usr/bin/env node
// Android versionName/versionCode 인코딩 (ADR-0190).
//
//   versionCode = (major*1_000_000 + minor*1_000 + patch) * 10 + slot
//   slot: beta N -> N (1..8), stable -> 9
//
// 옛 스킴(`major*1_000_000 + minor*1_000 + patch`)이 발행한 모든 값보다 크고,
// 같은 x.y.z 에서 stable(9) 이 모든 beta 보다 크다. 따라서 기존 설치의
// 업그레이드와 beta -> stable 승격 설치가 모두 성립한다. 한 번 발행한 코드보다
// 낮은 값으로는 갱신할 수 없으므로 이 인코딩은 되돌릴 수 없다.
//
// 사용: node scripts/release/android-version-code.mjs v0.11.0-beta.1
//       -> versionName=0.11.0-beta.1
//          versionCode=110001

import { pathToFileURL } from "node:url";

import { parseReleaseVersion } from "./release-version.mjs";

/** Android 가 받는 versionCode 상한. */
export const ANDROID_VERSION_CODE_MAX = 2_100_000_000;

/**
 * 인코딩이 감당하는 실제 최대 major 는 209 다(209_999_999*10+9 = 2_099_999_999).
 * 여유를 두어 200 에서 끊는다.
 */
const MAX_MAJOR = 200;

/** stable 이 차지하는 슬롯. beta 는 1..STABLE_SLOT-1 을 쓴다. */
const STABLE_SLOT = 9;

/**
 * @param {string} tag 릴리스 태그 또는 버전 (`v0.11.0`, `0.11.0-beta.1`)
 * @returns {{versionName: string, versionCode: number}}
 */
export function androidReleaseVersion(tag) {
  const parsed = parseReleaseVersion(tag);
  const slot = parsed.beta === null ? STABLE_SLOT : parsed.beta;
  if (parsed.beta !== null && parsed.beta >= STABLE_SLOT) {
    throw new Error(
      `beta 슬롯은 1..${STABLE_SLOT - 1} 이어야 한다(정식이 ${STABLE_SLOT} 을 쓴다): ${parsed.version}`,
    );
  }
  if (parsed.minor > 999 || parsed.patch > 999) {
    throw new Error(
      `minor/patch 가 999 를 넘어 versionCode 를 인코딩할 수 없다: ${parsed.version}`,
    );
  }
  if (parsed.major > MAX_MAJOR) {
    throw new Error(
      `major 가 ${MAX_MAJOR} 을 넘어 versionCode 를 인코딩할 수 없다: ${parsed.version}`,
    );
  }
  const base = parsed.major * 1_000_000 + parsed.minor * 1_000 + parsed.patch;
  const versionCode = base * 10 + slot;
  if (versionCode <= 0 || versionCode > ANDROID_VERSION_CODE_MAX) {
    throw new Error(
      `versionCode 가 Android 한계(${ANDROID_VERSION_CODE_MAX})를 벗어난다: ${parsed.version} -> ${versionCode}`,
    );
  }
  return { versionName: parsed.version, versionCode };
}

function main(argv) {
  const tag = argv[0];
  if (!tag) {
    console.error("사용: node scripts/release/android-version-code.mjs <tag>");
    process.exit(2);
  }
  const { versionName, versionCode } = androidReleaseVersion(tag);
  console.log(`versionName=${versionName}`);
  console.log(`versionCode=${versionCode}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
