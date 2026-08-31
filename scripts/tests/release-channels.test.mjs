#!/usr/bin/env node
// scripts/release/*.mjs 회귀 테스트 (ADR-0190). 실행: node scripts/tests/release-channels.test.mjs

import {
  androidReleaseVersion,
  ANDROID_VERSION_CODE_MAX,
} from "../release/android-version-code.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  ALL_CHANNEL_FILES,
  ANDROID_BETA_CHANNEL_FILE,
  ANDROID_STABLE_CHANNEL_FILE,
  buildAndroidChannelManifest,
  compareReleaseVersions,
  parseReleaseVersion,
  planAndroidChannelWrites,
  planChannelWrites,
  planReleaseChannelWrites,
  validateAndroidChannelManifest,
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
      currentStableVersion: "0.10.18",
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
      currentStableVersion: "0.10.18",
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
      currentStableVersion: "0.10.18",
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
      currentStableVersion: "0.10.18",
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
      currentStableVersion: "0.10.18",
    }),
  "후퇴",
);

check(
  "prerelease 는 beta 파일만 갱신한다 (stable 존재)",
  (() => {
    const writes = planChannelWrites({
      version: "0.11.0-beta.1",
      prerelease: true,
      currentBetaVersion: "0.10.18",
      currentStableVersion: "0.10.18",
    });
    return writes.length === 1 && writes[0] === "desktop-beta.json";
  })(),
);

throws(
  "stable 파일이 없으면 prerelease 발행을 거절한다",
  () =>
    planChannelWrites({
      version: "0.11.0-beta.1",
      prerelease: true,
      currentBetaVersion: "0.10.18",
      currentStableVersion: null,
    }),
  "시딩",
);

throws(
  "낮은 stable 재발행은 stable 채널을 후퇴시키지 못한다",
  () =>
    planChannelWrites({
      version: "0.10.18",
      prerelease: false,
      currentBetaVersion: null,
      currentStableVersion: "0.10.19",
    }),
  "후퇴",
);

check(
  "같은 stable 재실행은 no-op",
  (() => {
    const writes = planChannelWrites({
      version: "0.10.19",
      prerelease: false,
      currentBetaVersion: "0.10.19",
      currentStableVersion: "0.10.19",
    });
    return writes.length === 0;
  })(),
);

throws(
  "stable 채널 파일에 beta 매니페스트는 거절",
  () =>
    validateChannelManifest(manifestFor("v0.11.0-beta.1", "0.11.0-beta.1"), {
      tag: "v0.11.0-beta.1",
      owner: OWNER,
      repo: REPO,
      channel: "stable",
    }),
  "stable 채널 파일",
);

check(
  "같은 beta 재실행은 no-op",
  (() => {
    const writes = planChannelWrites({
      version: "0.11.0-beta.3",
      prerelease: true,
      currentBetaVersion: "0.11.0-beta.3",
      currentStableVersion: "0.10.18",
    });
    return writes.length === 0;
  })(),
);

check(
  "Android 미발행 릴리스는 데스크톱만 전진시킨다",
  (() => {
    const plan = planReleaseChannelWrites({
      version: "0.12.5",
      prerelease: false,
      seedStable: false,
      publishAndroid: false,
      currentDesktopBetaVersion: "0.12.4",
      currentDesktopStableVersion: "0.12.4",
      currentAndroidBetaVersion: "0.12.4",
      currentAndroidStableVersion: "0.12.4",
    });
    return (
      plan.desktop.length === 2 &&
      plan.android.length === 0 &&
      plan.desktop.includes("desktop-stable.json") &&
      plan.desktop.includes("desktop-beta.json")
    );
  })(),
);

check(
  "Android 발행 릴리스는 두 계열을 함께 전진시킨다",
  (() => {
    const plan = planReleaseChannelWrites({
      version: "0.12.5",
      prerelease: false,
      seedStable: false,
      publishAndroid: true,
      currentDesktopBetaVersion: "0.12.4",
      currentDesktopStableVersion: "0.12.4",
      currentAndroidBetaVersion: "0.12.4",
      currentAndroidStableVersion: "0.12.4",
    });
    return plan.desktop.length === 2 && plan.android.length === 2;
  })(),
);

check(
  "부트스트랩은 발견한 마지막 Android APK로 채널을 시딩한다",
  (() => {
    const plan = planReleaseChannelWrites({
      version: "0.12.4",
      prerelease: false,
      seedStable: true,
      publishAndroid: true,
      currentDesktopBetaVersion: null,
      currentDesktopStableVersion: null,
      currentAndroidBetaVersion: null,
      currentAndroidStableVersion: null,
    });
    return plan.desktop.length === 2 && plan.android.length === 2;
  })(),
);

check(
  "Android 미발행 CLI는 기존 Android 매니페스트를 그대로 보존한다",
  (() => {
    const directory = mkdtempSync(path.join(tmpdir(), "laymux-channels-"));
    try {
      const manifestPath = path.join(directory, "latest.json");
      const androidStablePath = path.join(
        directory,
        ANDROID_STABLE_CHANNEL_FILE,
      );
      const androidBetaPath = path.join(directory, ANDROID_BETA_CHANNEL_FILE);
      const oldAndroid = `${JSON.stringify(
        buildAndroidChannelManifest({
          tag: "v0.12.4",
          owner: OWNER,
          repo: REPO,
          pubDate: "2026-08-30T00:00:00Z",
        }),
        null,
        2,
      )}\n`;
      writeFileSync(
        manifestPath,
        JSON.stringify(manifestFor("v0.12.5", "0.12.5")),
      );
      writeFileSync(
        path.join(directory, "desktop-stable.json"),
        JSON.stringify(manifestFor("v0.12.4", "0.12.4")),
      );
      writeFileSync(
        path.join(directory, "desktop-beta.json"),
        JSON.stringify(manifestFor("v0.12.4", "0.12.4")),
      );
      writeFileSync(androidStablePath, oldAndroid);
      writeFileSync(androidBetaPath, oldAndroid);

      const script = fileURLToPath(
        new URL("../release/channel-manifest.mjs", import.meta.url),
      );
      const result = spawnSync(
        process.execPath,
        [
          script,
          "--tag",
          "v0.12.5",
          "--prerelease",
          "false",
          "--publish-android",
          "false",
          "--manifest",
          manifestPath,
          "--channel-dir",
          directory,
        ],
        { encoding: "utf8" },
      );
      return (
        result.status === 0 &&
        readFileSync(androidStablePath, "utf8") === oldAndroid &&
        readFileSync(androidBetaPath, "utf8") === oldAndroid &&
        JSON.parse(
          readFileSync(path.join(directory, "desktop-stable.json"), "utf8"),
        ).version === "0.12.5"
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  })(),
);

// ------------------------------------------------ Android 채널 매니페스트

const PUB_DATE = "2026-08-24T00:00:00Z";

function androidManifestFor(tag) {
  return buildAndroidChannelManifest({
    tag,
    owner: OWNER,
    repo: REPO,
    pubDate: PUB_DATE,
  });
}

check(
  "Android 매니페스트는 태그에서 버전·코드·URL 을 파생한다",
  (() => {
    const manifest = androidManifestFor("v0.11.1");
    return (
      manifest.version === "0.11.1" &&
      manifest.versionCode === 110019 &&
      manifest.releaseUrl ===
        `https://github.com/${OWNER}/${REPO}/releases/tag/v0.11.1` &&
      manifest.apkUrl ===
        `https://github.com/${OWNER}/${REPO}/releases/download/v0.11.1/Laymux-Android-0.11.1.apk` &&
      manifest.apkSha256Url === `${manifest.apkUrl}.sha256` &&
      manifest.pubDate === PUB_DATE
    );
  })(),
);

check(
  "beta 태그의 Android 매니페스트는 beta 슬롯 코드를 쓴다",
  (() => {
    const manifest = androidManifestFor("v0.12.0-beta.3");
    return (
      manifest.version === "0.12.0-beta.3" &&
      manifest.versionCode === 120003 &&
      manifest.apkUrl.endsWith("/Laymux-Android-0.12.0-beta.3.apk")
    );
  })(),
);

check(
  "파생한 Android 매니페스트는 자기 검증을 통과한다",
  (() => {
    validateAndroidChannelManifest(androidManifestFor("v0.11.1"), {
      tag: "v0.11.1",
      owner: OWNER,
      repo: REPO,
      channel: "stable",
    });
    validateAndroidChannelManifest(androidManifestFor("0.12.0-beta.2"), {
      tag: "0.12.0-beta.2",
      owner: OWNER,
      repo: REPO,
      channel: "beta",
    });
    return true;
  })(),
);

throws(
  "Android stable 채널 파일에 beta 버전은 거절",
  () =>
    validateAndroidChannelManifest(androidManifestFor("v0.11.1-beta.1"), {
      tag: "v0.11.1-beta.1",
      owner: OWNER,
      repo: REPO,
      channel: "stable",
    }),
  "stable 채널 파일",
);

throws(
  "Android 매니페스트 버전이 태그와 다르면 거절",
  () =>
    validateAndroidChannelManifest(androidManifestFor("v0.11.1"), {
      tag: "v0.11.2",
      owner: OWNER,
      repo: REPO,
      channel: "stable",
    }),
  "태그",
);

throws(
  "다른 저장소의 릴리스 페이지는 거절",
  () =>
    validateAndroidChannelManifest(
      {
        ...androidManifestFor("v0.11.1"),
        releaseUrl: "https://github.com/someone/else/releases/tag/v0.11.1",
      },
      { tag: "v0.11.1", owner: OWNER, repo: REPO, channel: "stable" },
    ),
  "releaseUrl",
);

throws(
  "versionCode 가 인코딩 결과와 다르면 거절",
  () =>
    validateAndroidChannelManifest(
      { ...androidManifestFor("v0.11.1"), versionCode: 110018 },
      { tag: "v0.11.1", owner: OWNER, repo: REPO, channel: "stable" },
    ),
  "versionCode",
);

throws(
  "체크섬 URL 이 APK URL 과 짝이 아니면 거절",
  () =>
    validateAndroidChannelManifest(
      {
        ...androidManifestFor("v0.11.1"),
        apkSha256Url: `https://github.com/${OWNER}/${REPO}/releases/download/v0.11.1/other.sha256`,
      },
      { tag: "v0.11.1", owner: OWNER, repo: REPO, channel: "stable" },
    ),
  "apkSha256Url",
);

throws(
  "pubDate 가 시각이 아니면 거절",
  () =>
    validateAndroidChannelManifest(
      { ...androidManifestFor("v0.11.1"), pubDate: "어제" },
      { tag: "v0.11.1", owner: OWNER, repo: REPO, channel: "stable" },
    ),
  "pubDate",
);

check(
  "Android 쓰기 계획은 데스크톱과 같은 규칙을 쓴다",
  (() => {
    const writes = planAndroidChannelWrites({
      version: "0.12.0",
      prerelease: false,
      currentBetaVersion: "0.12.0-beta.4",
      currentStableVersion: "0.11.1",
    });
    return (
      writes.length === 2 &&
      writes[0] === ANDROID_STABLE_CHANNEL_FILE &&
      writes[1] === ANDROID_BETA_CHANNEL_FILE
    );
  })(),
);

check(
  "Android 계열이 뒤처졌으면 데스크톱 no-op 과 무관하게 전진한다",
  (() => {
    // 이 결정 이전에 시딩된 브랜치: 데스크톱은 최신, Android 파일은 없다.
    const desktop = planChannelWrites({
      version: "0.11.1",
      prerelease: false,
      currentBetaVersion: "0.11.1",
      currentStableVersion: "0.11.1",
    });
    const android = planAndroidChannelWrites({
      version: "0.11.1",
      prerelease: false,
      currentBetaVersion: null,
      currentStableVersion: null,
    });
    return desktop.length === 0 && android.length === 2;
  })(),
);

check(
  "같은 릴리스 재실행은 Android 파일도 no-op",
  (() => {
    const writes = planAndroidChannelWrites({
      version: "0.11.1",
      prerelease: false,
      currentBetaVersion: "0.11.1",
      currentStableVersion: "0.11.1",
    });
    return writes.length === 0;
  })(),
);

check(
  "모든 채널 파일 목록은 네 개다",
  ALL_CHANNEL_FILES.length === 4 &&
    ALL_CHANNEL_FILES.includes(ANDROID_STABLE_CHANNEL_FILE) &&
    ALL_CHANNEL_FILES.includes(ANDROID_BETA_CHANNEL_FILE),
);

check(
  "발행 스크립트는 모든 채널 파일을 트리에 담는다",
  (() => {
    const script = readFileSync(
      new URL("../release/publish-channel-commit.sh", import.meta.url),
      "utf8",
    );
    // 트리를 통째로 만들므로 목록에서 빠진 파일은 브랜치에서 사라진다.
    return ALL_CHANNEL_FILES.every((file) => script.includes(file));
  })(),
);

if (failures > 0) {
  console.error(`\n${failures} 개 실패`);
  process.exit(1);
}
console.log("\n모두 통과");
