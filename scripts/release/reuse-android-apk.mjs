// ADR-0367: 검증된 기존 APK를 버전·이름·바이트 변경 없이 새 릴리스에 첨부한다.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  androidApkAssetName,
  validateAndroidChannelManifest,
} from "./android-channel-manifest.mjs";
import { parseReleaseVersion } from "./release-version.mjs";

const provenanceName = "android-apk-source.json";
const noteMarker = "<!-- laymux-android-apk-reuse -->";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function formatAndroidReuseNote({ repository, tag, manifest, hash }) {
  const plan = planAndroidReuse(manifest, { repository, tag });
  const pcVersion = parseReleaseVersion(tag).version;
  const assets = `https://github.com/${repository}/releases/download/${tag}/`;
  return [
    noteMarker,
    "### Android용 Laymux 앱 설치 안내",
    "",
    `이번 **PC용 Laymux ${pcVersion}** 릴리스에는 Android용 Laymux 앱 자체의 변경이 없어 APK를 새로 빌드하지 않았습니다. 최신 릴리스에서도 설치 파일을 쉽게 찾을 수 있도록, 현재 Android용 Laymux 앱 **${manifest.version}**의 APK를 함께 제공합니다.`,
    "",
    `첨부된 APK는 [원본 ${plan.sourceTag}](${manifest.releaseUrl})에서 배포한 것과 동일한 파일입니다. PC용 Laymux와 Android용 Laymux 앱의 버전은 다를 수 있으며, 이 APK를 설치한 뒤 Laymux 앱 버전이 **${manifest.version}**으로 표시되는 것이 정상입니다.`,
    "",
    `- **이미 Android용 Laymux 앱 ${manifest.version} 또는 더 최신 Laymux 앱 버전을 사용 중이라면 재설치할 필요가 없습니다.** 이번 PC용 Laymux 업데이트를 적용하기 위해 APK를 다시 설치하지 않아도 됩니다.`,
    `- **Laymux 앱을 처음 설치하거나 더 오래된 Laymux 앱을 업데이트하려면** [Android용 Laymux 앱 ${manifest.version} APK 다운로드](${assets}${plan.apkName})를 사용하세요.`,
    "",
    `<details>\n<summary>다운로드 파일 검증 정보</summary>\n\n[SHA-256 체크섬 다운로드](${assets}${plan.checksumName})\n\nSHA-256: \`${hash}\`\n\n</details>`,
    "",
  ].join("\n");
}

export function planAndroidReuse(manifest, { repository, tag }) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository))
    throw new Error("잘못된 저장소 이름");
  const [owner, repo] = repository.split("/");
  const channel = parseReleaseVersion(tag).beta === null ? "stable" : "beta";
  const prefix = `https://github.com/${repository}/releases/tag/`;
  if (!manifest?.releaseUrl?.startsWith(prefix))
    throw new Error("APK 원본이 같은 저장소의 릴리스가 아니다");
  const sourceTag = manifest.releaseUrl.slice(prefix.length);
  validateAndroidChannelManifest(manifest, {
    tag: sourceTag,
    owner,
    repo,
    channel,
  });
  if (sourceTag === tag)
    throw new Error("대상 릴리스에서 자기 APK를 재사용할 수 없다");
  const apkName = androidApkAssetName(manifest.version);
  return { channel, sourceTag, apkName, checksumName: `${apkName}.sha256` };
}

export function verifyApkChecksum(bytes, text, apkName) {
  const checksum = text.trim().match(/^([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)$/);
  if (
    !checksum ||
    checksum[2] !== apkName ||
    checksum[1].toLowerCase() !== sha256(bytes)
  ) {
    throw new Error("APK 체크섬 또는 체크섬의 파일명이 원본과 다르다");
  }
  return sha256(bytes);
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

// 호출자는 이 매니페스트의 원본 태그 이후 Android 입력이 바뀌지 않았음을 먼저 검사한다.
export function reuseAndroidApk(
  { repository, tag, releaseId, manifest, outputDir, allowPublished = false },
  run = gh,
) {
  const plan = planAndroidReuse(manifest, { repository, tag });
  if (!/^[1-9][0-9]*$/.test(String(releaseId)))
    throw new Error("생성 응답의 유효한 release ID가 필요하다");
  const apiPath = `repos/${repository}/releases/tags/`;
  // Draft는 REST tag 조회에 나타나지 않는다. 생성 응답의 ID를 계속 사용한다.
  const targetPath = `repos/${repository}/releases/${releaseId}`;
  const source = JSON.parse(
    run(["api", `${apiPath}${encodeURIComponent(plan.sourceTag)}`]),
  );
  const target = JSON.parse(run(["api", targetPath]));
  if (
    source.draft ||
    source.tag_name !== plan.sourceTag ||
    (plan.channel === "stable" && source.prerelease)
  )
    throw new Error("APK 원본은 공개된 릴리스여야 한다");
  if (String(target.id) !== String(releaseId) || target.tag_name !== tag)
    throw new Error("대상 릴리스 ID 또는 태그가 요청과 다르다");
  if (!target.draft && !allowPublished)
    throw new Error("공개 릴리스 보충에는 --allow-published가 필요하다");
  const dir =
    outputDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "laymux-apk-reuse-"));
  fs.mkdirSync(dir, { recursive: true });
  for (const name of [plan.apkName, plan.checksumName]) {
    if (!source.assets?.some((asset) => asset.name === name))
      throw new Error(`원본 첨부 누락: ${name}`);
  }
  run([
    "release",
    "download",
    plan.sourceTag,
    "--repo",
    repository,
    "--pattern",
    plan.apkName,
    "--pattern",
    plan.checksumName,
    "--dir",
    dir,
    "--clobber",
  ]);
  const apk = fs.readFileSync(path.join(dir, plan.apkName));
  const checksum = fs.readFileSync(path.join(dir, plan.checksumName));
  const hash = verifyApkChecksum(apk, checksum.toString("utf8"), plan.apkName);
  for (const [name, bytes] of [
    [plan.apkName, apk],
    [plan.checksumName, checksum],
  ]) {
    const asset = source.assets.find((item) => item.name === name);
    if (
      asset.size !== bytes.length ||
      (asset.digest && asset.digest !== `sha256:${sha256(bytes)}`)
    ) {
      throw new Error(`원본 GitHub 첨부와 다운로드가 다르다: ${name}`);
    }
  }
  const provenance = {
    schemaVersion: 1,
    releaseTag: tag,
    sourceTag: plan.sourceTag,
    androidVersion: manifest.version,
    sha256: hash,
    sourceManifest: manifest,
  };
  fs.writeFileSync(
    path.join(dir, provenanceName),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  // 부분 업로드 재시도도 허용하되, 기존 공개 바이트는 덮어쓰지 않는다.
  const pending = [];
  for (const name of [plan.checksumName, provenanceName, plan.apkName]) {
    const file = path.join(dir, name);
    const bytes = fs.readFileSync(file);
    const existing = target.assets?.find((asset) => asset.name === name);
    if (
      existing &&
      (existing.size !== bytes.length ||
        existing.digest !== `sha256:${sha256(bytes)}`)
    ) {
      throw new Error(`대상 릴리스에 내용이 다른 동명 첨부가 있다: ${name}`);
    }
    if (!existing) pending.push(file);
  }
  if (pending.length)
    run(["release", "upload", tag, "--repo", repository, ...pending]);
  const current = JSON.parse(run(["api", targetPath]));
  for (const name of [plan.apkName, plan.checksumName, provenanceName]) {
    const bytes = fs.readFileSync(path.join(dir, name));
    const uploaded = current.assets?.find((asset) => asset.name === name);
    if (
      !uploaded ||
      uploaded.size !== bytes.length ||
      uploaded.digest !== `sha256:${sha256(bytes)}`
    ) {
      throw new Error(`업로드한 첨부의 검증 실패: ${name}`);
    }
  }
  if (!(current.body ?? "").includes(noteMarker)) {
    const notes = `${current.body ?? ""}\n\n${formatAndroidReuseNote({ repository, tag, manifest, hash })}`;
    const notesPath = path.join(dir, "release-notes.md");
    fs.writeFileSync(notesPath, notes);
    run([
      "release",
      "edit",
      tag,
      "--repo",
      repository,
      "--notes-file",
      notesPath,
    ]);
  }
  return {
    ...plan,
    sha256: hash,
    releaseUrl: `https://github.com/${repository}/releases/tag/${tag}`,
    uploaded: pending.map((file) => path.basename(file)),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (key === "--allow-published") options.allowPublished = true;
    else if (
      [
        "--tag",
        "--release-id",
        "--repository",
        "--manifest",
        "--output-dir",
      ].includes(key) &&
      args.length
    )
      options[key.slice(2)] = args.shift();
    else throw new Error(`잘못된 인자: ${key}`);
  }
  const manifest = JSON.parse(fs.readFileSync(options.manifest, "utf8"));
  console.log(
    JSON.stringify(
      reuseAndroidApk({
        repository: options.repository,
        tag: options.tag,
        releaseId: options["release-id"],
        manifest,
        outputDir: options["output-dir"],
        allowPublished: options.allowPublished,
      }),
      null,
      2,
    ),
  );
}
