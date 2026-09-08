// Android 채널 매니페스트 스키마와 검증 (ADR-0223, ADR-0197 계승).
//
// 파일은 `release-channels` 브랜치의 `android-stable.json`·`android-beta.json`
// 이며 채널 브랜치의 데스크톱 매니페스트와 같은 트리 커밋에 보존된다. APK를
// 발행하지 않은 릴리스에서는 내용이 전진하지 않는다. Tauri updater manifest 가
// 아니라 이 결정이 정의하는 스키마다 — 폰이 실제로 필요한 것은 서명 검증
// 대상이 아니라 "어느 릴리스 페이지로 보내는가" 이기 때문이다.
//
// 매니페스트 내용은 전부 실제 APK를 발행한 tag 에서 파생한다. 손으로 채우는 필드를 두면
// 버전과 URL 이 어긋난 매니페스트를 만들 자유도가 생긴다.

import { androidReleaseVersion } from "./android-version-code.mjs";
import { parseReleaseVersion } from "./release-version.mjs";

export const ANDROID_STABLE_CHANNEL_FILE = "android-stable.json";
export const ANDROID_BETA_CHANNEL_FILE = "android-beta.json";

/** 릴리스에 올라가는 APK asset 이름. workflow 의 스테이징 단계와 같은 규칙이다. */
export function androidApkAssetName(versionName) {
  return `Laymux-Android-${versionName}.apk`;
}

/**
 * 발행 tag 하나로 Android 채널 매니페스트를 만든다.
 * @param {{tag: string, owner: string, repo: string, pubDate: string}} input
 */
export function buildAndroidChannelManifest({ tag, owner, repo, pubDate }) {
  const { versionName, versionCode } = androidReleaseVersion(tag);
  if (typeof pubDate !== "string" || pubDate.length === 0) {
    throw new Error("pubDate 가 필요하다");
  }
  const trimmedTag = tag.trim();
  const apkUrl =
    `https://github.com/${owner}/${repo}/releases/download/${trimmedTag}/` +
    androidApkAssetName(versionName);
  return {
    version: versionName,
    versionCode,
    releaseUrl: `https://github.com/${owner}/${repo}/releases/tag/${trimmedTag}`,
    apkUrl,
    apkSha256Url: `${apkUrl}.sha256`,
    pubDate,
  };
}

/**
 * 채널에 올려도 되는 매니페스트인지 검증한다. 데스크톱 매니페스트와 같은
 * 등급의 방어선이다 — 여기서 막지 않으면 폰은 존재하지 않는 릴리스 페이지나
 * 저장소 밖 주소를 후보로 받는다.
 * @param {object} manifest
 * @param {{tag: string, owner: string, repo: string, channel: string}} context
 * @returns {{version: string}}
 */
export function validateAndroidChannelManifest(
  manifest,
  { tag, owner, repo, channel },
) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Android 매니페스트가 객체가 아니다");
  }
  const expected = parseReleaseVersion(tag);
  if (manifest.version !== expected.version) {
    throw new Error(
      `Android 매니페스트 버전 ${manifest.version} 이 태그 ${tag} 의 버전 ${expected.version} 과 다르다`,
    );
  }
  // stable 파일을 읽는 클라이언트는 prerelease 접미사를 거절한다. 잘못 들어가면
  // 오류도 후보도 없이 채널이 멈추므로 구조적으로 막는다.
  if (channel === "stable" && expected.beta !== null) {
    throw new Error(
      `stable 채널 파일에는 x.y.z 만 올릴 수 있다: ${expected.version}`,
    );
  }
  const { versionCode } = androidReleaseVersion(tag);
  if (manifest.versionCode !== versionCode) {
    throw new Error(
      `Android 매니페스트 versionCode ${manifest.versionCode} 가 인코딩 결과 ${versionCode} 와 다르다`,
    );
  }

  const trimmedTag = tag.trim();
  const releaseUrl = `https://github.com/${owner}/${repo}/releases/tag/${trimmedTag}`;
  if (manifest.releaseUrl !== releaseUrl) {
    throw new Error(
      `Android 매니페스트 releaseUrl 이 이 릴리스의 페이지가 아니다: ${manifest.releaseUrl}`,
    );
  }
  const apkUrl =
    `https://github.com/${owner}/${repo}/releases/download/${trimmedTag}/` +
    androidApkAssetName(expected.version);
  if (manifest.apkUrl !== apkUrl) {
    throw new Error(
      `Android 매니페스트 apkUrl 이 이 릴리스의 APK asset 이 아니다: ${manifest.apkUrl}`,
    );
  }
  if (manifest.apkSha256Url !== `${apkUrl}.sha256`) {
    throw new Error(
      `Android 매니페스트 apkSha256Url 이 apkUrl 의 체크섬이 아니다: ${manifest.apkSha256Url}`,
    );
  }
  if (
    typeof manifest.pubDate !== "string" ||
    Number.isNaN(Date.parse(manifest.pubDate))
  ) {
    throw new Error(
      `Android 매니페스트 pubDate 가 시각이 아니다: ${manifest.pubDate}`,
    );
  }

  return { version: expected.version };
}
