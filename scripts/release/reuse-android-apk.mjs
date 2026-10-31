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
  { repository, tag, manifest, outputDir, allowPublished = false },
  run = gh,
) {
  const plan = planAndroidReuse(manifest, { repository, tag });
  const apiPath = `repos/${repository}/releases/tags/`;
  const source = JSON.parse(
    run(["api", `${apiPath}${encodeURIComponent(plan.sourceTag)}`]),
  );
  const target = JSON.parse(
    run(["api", `${apiPath}${encodeURIComponent(tag)}`]),
  );
  if (
    source.draft ||
    source.tag_name !== plan.sourceTag ||
    (plan.channel === "stable" && source.prerelease)
  )
    throw new Error("APK 원본은 공개된 릴리스여야 한다");
  if (target.tag_name !== tag || (!target.draft && !allowPublished))
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
  const current = JSON.parse(
    run(["api", `${apiPath}${encodeURIComponent(tag)}`]),
  );
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
    const notes = `${current.body ?? ""}\n\n${noteMarker}\n### Android APK\n\nAndroid **${manifest.version}** APK를 재빌드 없이 원본 그대로 재첨부했습니다.\n원본: [${plan.sourceTag}](${manifest.releaseUrl}) · SHA-256: \`${hash}\`\n`;
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
      ["--tag", "--repository", "--manifest", "--output-dir"].includes(key) &&
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
        manifest,
        outputDir: options["output-dir"],
        allowPublished: options.allowPublished,
      }),
      null,
      2,
    ),
  );
}
