#!/usr/bin/env node
// scripts/release/*.mjs 회귀 테스트 (ADR-0189). 실행: node scripts/tests/release-channels.test.mjs

import {
  androidReleaseVersion,
  ANDROID_VERSION_CODE_MAX,
} from "../release/android-version-code.mjs";
import {
  compareReleaseVersions,
  parseReleaseVersion,
  planChannelWrites,
  validateChannelManifest,
} from "../release/channel-manifest.mjs";

let failures = 0;

function check(name, condition) {
  if (condition) {
    console.log(`ok - ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${name}`);
  }
}

function throws(name, fn, messagePart) {
  try {
    fn();
    failures += 1;
    console.error(`FAIL - ${name} (에러가 발생하지 않았다)`);
  } catch (error) {
    if (messagePart && !String(error.message).includes(messagePart)) {
      failures += 1;
      console.error(`FAIL - ${name} (메시지 불일치: ${error.message})`);
      return;
    }
    console.log(`ok - ${name}`);
  }
}

// ---------------------------------------------------------------- 버전 파싱

check(
  "stable 버전은 beta 슬롯이 없다",
  (() => {
    const parsed = parseReleaseVersion("v0.11.0");
    return parsed.version === "0.11.0" && parsed.beta === null;
  })(),
);

check(
  "beta 버전은 슬롯 번호를 준다",
  (() => {
    const parsed = parseReleaseVersion("0.11.0-beta.3");
    return parsed.version === "0.11.0-beta.3" && parsed.beta === 3;
  })(),
);

throws(
  "alpha 라벨은 거절",
  () => parseReleaseVersion("v0.11.0-alpha.1"),
  "v?x.y.z",
);
throws("rc 라벨은 거절", () => parseReleaseVersion("v0.11.0-rc.1"), "v?x.y.z");
throws(
  "build metadata 는 거절",
  () => parseReleaseVersion("0.11.0+build"),
  "v?x.y.z",
);
throws(
  "beta 슬롯 0 은 거절",
  () => parseReleaseVersion("0.11.0-beta.0"),
  "v?x.y.z",
);
throws(
  "beta 슬롯 선행 0 은 거절",
  () => parseReleaseVersion("0.11.0-beta.01"),
  "v?x.y.z",
);
throws("성분 선행 0 은 거절", () => parseReleaseVersion("0.011.0"), "v?x.y.z");
throws(
  "임의 문자열 태그는 거절",
  () => parseReleaseVersion("nightly-2026-08-21"),
  "v?x.y.z",
);

// ---------------------------------------------------------------- 버전 비교

check(
  "정식은 같은 버전의 beta 보다 크다",
  compareReleaseVersions("0.11.0", "0.11.0-beta.8") > 0,
);
check(
  "beta 슬롯은 숫자로 비교한다",
  compareReleaseVersions("0.11.0-beta.10", "0.11.0-beta.9") > 0,
);
check("patch 가 우선한다", compareReleaseVersions("0.10.19", "0.10.18") > 0);
check(
  "같은 버전은 0",
  compareReleaseVersions("0.11.0-beta.1", "0.11.0-beta.1") === 0,
);
check(
  "낮은 stable 은 높은 beta 보다 작다",
  compareReleaseVersions("0.10.19", "0.11.0-beta.1") < 0,
);

// ---------------------------------------------------------------- Android versionCode

check(
  "기존 스킴 발행값보다 항상 크다",
  (() => {
    const legacy = 10 * 1000 + 18; // 0.10.18 의 옛 versionCode
    return androidReleaseVersion("v0.10.18").versionCode > legacy;
  })(),
);

check(
  "stable 슬롯은 9",
  androidReleaseVersion("v0.11.0").versionCode === 110009,
);
check(
  "beta 슬롯은 N",
  androidReleaseVersion("v0.11.0-beta.1").versionCode === 110001,
);
check(
  "같은 버전에서 stable > beta",
  (() => {
    const beta = androidReleaseVersion("0.11.0-beta.8").versionCode;
    const stable = androidReleaseVersion("0.11.0").versionCode;
    return stable > beta;
  })(),
);
check(
  "다음 patch beta 는 이전 stable 보다 크다",
  (() => {
    const previousStable = androidReleaseVersion("0.10.18").versionCode;
    const nextBeta = androidReleaseVersion("0.10.19-beta.1").versionCode;
    return nextBeta > previousStable;
  })(),
);
check(
  "versionName 은 태그 버전 그대로",
  androidReleaseVersion("v0.11.0-beta.2").versionName === "0.11.0-beta.2",
);

check(
  "상한 major 는 인코딩 한계 안에 있다",
  androidReleaseVersion("200.999.999").versionCode <= ANDROID_VERSION_CODE_MAX,
);
throws(
  "major 상한 초과는 거절",
  () => androidReleaseVersion("201.0.0"),
  "versionCode",
);
throws(
  "patch 상한 초과는 거절",
  () => androidReleaseVersion("0.0.1000"),
  "versionCode",
);
throws(
  "beta 슬롯 9 는 거절",
  () => androidReleaseVersion("0.11.0-beta.9"),
  "beta 슬롯",
);

// ---------------------------------------------------------------- 매니페스트 검증

const OWNER = "kochul2000";
const REPO = "laymux";

function manifestFor(tag, version) {
  const base = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}`;
  return {
    version,
    notes: "",
    pub_date: "2026-08-21T00:00:00.000Z",
    platforms: {
      "windows-x86_64": {
        signature: "sig",
        url: `${base}/Laymux_${version}_x64-setup.exe`,
      },
      "windows-x86_64-nsis": {
        signature: "sig",
        url: `${base}/Laymux_${version}_x64-setup.exe`,
      },
      "linux-x86_64": {
        signature: "sig",
        url: `${base}/Laymux_${version}_amd64.AppImage`,
      },
      "linux-x86_64-appimage": {
        signature: "sig",
        url: `${base}/Laymux_${version}_amd64.AppImage`,
      },
    },
  };
}

check(
  "정상 stable 매니페스트는 통과",
  (() => {
    validateChannelManifest(manifestFor("v0.11.0", "0.11.0"), {
      tag: "v0.11.0",
      owner: OWNER,
      repo: REPO,
    });
    return true;
  })(),
);

check(
  "정상 beta 매니페스트는 통과",
  (() => {
    validateChannelManifest(manifestFor("v0.11.0-beta.1", "0.11.0-beta.1"), {
      tag: "v0.11.0-beta.1",
      owner: OWNER,
      repo: REPO,
    });
    return true;
  })(),
);

throws(
  "태그와 매니페스트 버전 불일치는 거절",
  () =>
    validateChannelManifest(manifestFor("v0.11.0", "0.11.1"), {
      tag: "v0.11.0",
      owner: OWNER,
      repo: REPO,
    }),
  "매니페스트 버전",
);

throws(
  "필수 플랫폼 키 누락은 거절",
  () => {
    const manifest = manifestFor("v0.11.0", "0.11.0");
    delete manifest.platforms["linux-x86_64"];
    validateChannelManifest(manifest, {
      tag: "v0.11.0",
      owner: OWNER,
      repo: REPO,
    });
  },
  "linux-x86_64",
);

throws(
  "저장소 밖 URL 은 거절",
  () => {
    const manifest = manifestFor("v0.11.0", "0.11.0");
    manifest.platforms["windows-x86_64"].url =
      "https://evil.example.com/Laymux.exe";
    validateChannelManifest(manifest, {
      tag: "v0.11.0",
      owner: OWNER,
      repo: REPO,
    });
  },
  "releases/download",
);

throws(
  "다른 태그 하위 URL 은 거절",
  () => {
    const manifest = manifestFor("v0.11.0", "0.11.0");
    manifest.platforms["linux-x86_64"].url =
      `https://github.com/${OWNER}/${REPO}/releases/download/v0.11.1/Laymux_0.11.1_amd64.AppImage`;
    validateChannelManifest(manifest, {
      tag: "v0.11.0",
      owner: OWNER,
      repo: REPO,
    });
  },
  "releases/download",
);

throws(
  "서명 없는 항목은 거절",
  () => {
    const manifest = manifestFor("v0.11.0", "0.11.0");
    manifest.platforms["windows-x86_64"].signature = "";
    validateChannelManifest(manifest, {
      tag: "v0.11.0",
      owner: OWNER,
      repo: REPO,
    });
  },
  "signature",
);

// ---------------------------------------------------------------- 채널 쓰기 계획

check(
  "prerelease 는 beta 파일만 갱신한다",
  (() => {
    const writes = planChannelWrites({
      version: "0.11.0-beta.1",
      prerelease: true,
      currentBetaVersion: "0.10.18",
    });
    return writes.length === 1 && writes[0] === "desktop-beta.json";
  })(),
);

check(
  "stable 은 두 파일을 함께 갱신한다",
  (() => {
    const writes = planChannelWrites({
      version: "0.11.0",
      prerelease: false,
      currentBetaVersion: "0.11.0-beta.3",
    });
    return (
      writes.length === 2 &&
      writes.includes("desktop-stable.json") &&
      writes.includes("desktop-beta.json")
    );
  })(),
);

check(
  "beta 가 더 높으면 stable 발행이 beta 를 후퇴시키지 않는다",
  (() => {
    const writes = planChannelWrites({
      version: "0.10.19",
      prerelease: false,
      currentBetaVersion: "0.11.0-beta.2",
    });
    return writes.length === 1 && writes[0] === "desktop-stable.json";
  })(),
);

check(
  "beta 파일이 없으면 stable 발행이 시딩한다",
  (() => {
    const writes = planChannelWrites({
      version: "0.11.0",
      prerelease: false,
      currentBetaVersion: null,
    });
    return writes.length === 2;
  })(),
);

throws(
  "현재 beta 보다 낮은 prerelease 는 거절",
  () =>
    planChannelWrites({
      version: "0.11.0-beta.1",
      prerelease: true,
      currentBetaVersion: "0.11.0-beta.3",
    }),
  "후퇴",
);

if (failures > 0) {
  console.error(`\n${failures} 개 실패`);
  process.exit(1);
}
console.log("\n모두 통과");
