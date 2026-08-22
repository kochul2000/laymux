#!/usr/bin/env node
// 채널 매니페스트 검증과 쓰기 계획 (ADR-0189).
//
// 채널 파일은 `release-channels` 브랜치의 `desktop-stable.json`·`desktop-beta.json`
// 이며 각 파일은 해당 채널 최신 릴리스의 Tauri updater manifest 전문이다.
// 커밋 전에 여기서 검증한다 — 부분 매니페스트나 저장소 밖 URL 이 채널에 노출되면
// 서명 검증 이전 단계에서 이미 사용자를 엉뚱한 릴리스로 보낸다.
//
// 불변식: beta 채널은 항상 stable 이상을 가리킨다. stable 발행은 beta 파일을
// 더 높은 버전으로만 전진시키고, prerelease 는 beta 파일을 후퇴시킬 수 없다.
//
// 사용: node scripts/release/channel-manifest.mjs \
//         --tag v0.11.0-beta.1 --prerelease true \
//         --manifest latest.json --channel-dir ./channels
//       -> 갱신한 파일명을 한 줄씩 출력

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  compareReleaseVersions,
  parseReleaseVersion,
} from "./release-version.mjs";

export { compareReleaseVersions, parseReleaseVersion };

export const STABLE_CHANNEL_FILE = "desktop-stable.json";
export const BETA_CHANNEL_FILE = "desktop-beta.json";

/** 클라이언트가 실제로 소비하는 플랫폼 키. 번들 접미사 키는 있으면 함께 검증한다. */
const REQUIRED_PLATFORMS = ["windows-x86_64", "linux-x86_64"];

/**
 * 발행 tag 로 만든 updater manifest 가 채널에 올려도 되는지 검증한다.
 * @param {object} manifest tauri-action 이 만든 `latest.json` 전문
 * @param {{tag: string, owner: string, repo: string}} context
 * @returns {{version: string}}
 */
export function validateChannelManifest(
  manifest,
  { tag, owner, repo, channel },
) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("매니페스트가 객체가 아니다");
  }
  const expected = parseReleaseVersion(tag);
  if (manifest.version !== expected.version) {
    throw new Error(
      `매니페스트 버전 ${manifest.version} 이 태그 ${tag} 의 버전 ${expected.version} 과 다르다`,
    );
  }
  // stable 파일을 읽는 클라이언트는 prerelease 접미사를 거절하므로, 잘못
  // 들어가면 오류도 후보도 없이 채널이 멈춘다. 여기서 구조적으로 막는다.
  if (channel === "stable" && expected.beta !== null) {
    throw new Error(
      `stable 채널 파일에는 x.y.z 만 올릴 수 있다: ${expected.version}`,
    );
  }

  const platforms = manifest.platforms;
  if (!platforms || typeof platforms !== "object") {
    throw new Error("매니페스트에 platforms 가 없다");
  }
  for (const key of REQUIRED_PLATFORMS) {
    if (!platforms[key]) {
      throw new Error(`매니페스트에 필수 플랫폼 키 ${key} 가 없다`);
    }
  }

  const prefix = `https://github.com/${owner}/${repo}/releases/download/${tag}/`;
  for (const [key, entry] of Object.entries(platforms)) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`플랫폼 ${key} 항목이 객체가 아니다`);
    }
    if (typeof entry.signature !== "string" || entry.signature.length === 0) {
      throw new Error(`플랫폼 ${key} 에 signature 가 없다`);
    }
    if (typeof entry.url !== "string" || !entry.url.startsWith(prefix)) {
      throw new Error(
        `플랫폼 ${key} 의 url 이 이 릴리스의 releases/download/${tag}/ 하위가 아니다: ${entry.url}`,
      );
    }
  }

  return { version: expected.version };
}

/**
 * 이번 발행이 갱신할 채널 파일을 정한다.
 * @param {{version: string, prerelease: boolean, currentBetaVersion: string|null}} input
 * @returns {string[]} 갱신할 파일명
 */
export function planChannelWrites({
  version,
  prerelease,
  currentBetaVersion,
  currentStableVersion,
}) {
  const released = parseReleaseVersion(version).version;
  if (prerelease) {
    if (!currentStableVersion) {
      // stable 파일이 없는 채로 beta 만 커밋하면 기본 채널이 404 가 되어
      // 모든 설치본이 다음 정식 릴리스까지 확인 오류만 본다. 부트스트랩은
      // 호출자가 현재 정식 매니페스트로 먼저 시딩해야 한다.
      throw new Error(
        `stable 채널 파일이 없다. prerelease 발행 전에 현재 정식 매니페스트로 시딩해야 한다`,
      );
    }
    if (currentBetaVersion) {
      const ordering = compareReleaseVersions(released, currentBetaVersion);
      if (ordering < 0) {
        throw new Error(
          `prerelease ${released} 가 현재 beta 채널 ${currentBetaVersion} 을 후퇴시킨다`,
        );
      }
      if (ordering === 0) {
        // 같은 릴리스로 job 을 다시 돌리는 것은 멱등이어야 한다. ref 갱신은
        // 성공했는데 응답이 유실돼 job 이 실패한 경우, 재실행이 여기서 또
        // 막히면 workflow 를 정상 완료시킬 방법이 없다.
        return [];
      }
    }
    return [BETA_CHANNEL_FILE];
  }

  // stable 도 전진만 허용한다. 버전을 되돌린 재발행이나 옛 릴리스로 job 을
  // 재실행하면 채널이 조용히 후퇴하고, 클라이언트는 다운그레이드를 제안하지
  // 않으므로 그 시점부터 stable 사용자가 정지한다.
  if (currentStableVersion) {
    const ordering = compareReleaseVersions(released, currentStableVersion);
    if (ordering < 0) {
      throw new Error(
        `stable ${released} 가 현재 stable 채널 ${currentStableVersion} 을 후퇴시킨다`,
      );
    }
    if (ordering === 0) {
      // 같은 릴리스로 job 을 다시 돌리는 것은 안전한 no-op 이어야 한다.
      return [];
    }
  }

  const writes = [STABLE_CHANNEL_FILE];
  if (
    !currentBetaVersion ||
    compareReleaseVersions(released, currentBetaVersion) > 0
  ) {
    writes.push(BETA_CHANNEL_FILE);
  }
  return writes;
}

/** 채널 디렉터리에서 현재 beta 매니페스트 버전을 읽는다. 없으면 null. */
export function readChannelVersion(channelDir, file) {
  const target = path.join(channelDir, file);
  if (!fs.existsSync(target)) return null;
  const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  if (typeof parsed.version !== "string") {
    throw new Error(`${file} 에 version 이 없다`);
  }
  return parsed.version;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  // `prerelease` is required, not defaulted: a missing or misspelled flag would
  // otherwise silently take the stable path and overwrite the stable channel.
  const required = ["tag", "manifest", "channel-dir", "prerelease"];
  for (const key of required) {
    if (!args[key]) {
      console.error(
        `사용: node scripts/release/channel-manifest.mjs --tag <tag> --prerelease <true|false> --manifest <path> --channel-dir <dir> [--owner o --repo r] [--seed-stable]`,
      );
      process.exit(2);
    }
  }
  if (args.prerelease !== "true" && args.prerelease !== "false") {
    console.error(
      `--prerelease 는 true 또는 false 여야 한다: ${args.prerelease}`,
    );
    process.exit(2);
  }
  const owner = args.owner ?? "kochul2000";
  const repo = args.repo ?? "laymux";
  const prerelease = args.prerelease === "true";
  const channelDir = args["channel-dir"];
  // Bootstrap: write the current stable manifest into both channel files so
  // neither channel is ever a 404 (ADR-0189).
  const seedStable = args["seed-stable"] === "true";

  const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
  const { version } = validateChannelManifest(manifest, {
    tag: args.tag,
    owner,
    repo,
    channel: prerelease ? "beta" : "stable",
  });
  const currentBetaVersion = readChannelVersion(channelDir, BETA_CHANNEL_FILE);
  const currentStableVersion = readChannelVersion(
    channelDir,
    STABLE_CHANNEL_FILE,
  );
  if (seedStable && prerelease) {
    console.error("--seed-stable 은 정식 매니페스트로만 쓸 수 있다");
    process.exit(2);
  }
  // Seeding ignores the missing stable file (that is the point) but still must
  // not pull a beta channel that is already ahead back to stable.
  const writes = planChannelWrites({
    version,
    prerelease,
    currentBetaVersion,
    currentStableVersion: seedStable ? null : currentStableVersion,
  });

  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  for (const file of writes) {
    fs.writeFileSync(path.join(channelDir, file), serialized, "utf8");
    console.log(file);
  }
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
