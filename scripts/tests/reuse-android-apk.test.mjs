import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { buildAndroidChannelManifest } from "../release/android-channel-manifest.mjs";
import {
  planAndroidReuse,
  reuseAndroidApk,
  verifyApkChecksum,
} from "../release/reuse-android-apk.mjs";

const repository = "acme/laymux";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = (tag = "v3.1.0") =>
  buildAndroidChannelManifest({
    tag,
    owner: "acme",
    repo: "laymux",
    pubDate: "2026-10-21T12:48:03Z",
  });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laymux-apk-test-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert(path.basename(dir).startsWith("laymux-apk-test-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const f = {
    dir,
    apk: Buffer.from("unchanged signed APK bytes"),
    checksum: null,
    calls: [],
    source: { tag_name: "v3.1.0", draft: false, prerelease: false, assets: [] },
    target: {
      id: 42,
      tag_name: "v3.8.2",
      draft: true,
      body: "Existing release notes",
      assets: [],
    },
    tamperUpload: false,
  };
  f.checksum = Buffer.from(`${hash(f.apk)}  Laymux-Android-3.1.0.apk\n`);
  const asset = (name, bytes) => ({
    name,
    size: bytes.length,
    digest: `sha256:${hash(bytes)}`,
  });
  f.source.assets = [
    asset("Laymux-Android-3.1.0.apk", f.apk),
    asset("Laymux-Android-3.1.0.apk.sha256", f.checksum),
  ];
  f.run = (args) => {
    f.calls.push(args);
    if (args[0] === "api") {
      if (args[1].endsWith("/tags/v3.8.2") && f.target.draft) {
        throw new Error("HTTP 404: draft는 tag REST 조회를 지원하지 않는다");
      }
      if (args[1].endsWith("/tags/v3.1.0")) return JSON.stringify(f.source);
      assert.equal(args[1], `repos/${repository}/releases/42`);
      return JSON.stringify(f.target);
    }
    if (args[1] === "download") {
      assert.equal(args[2], "v3.1.0");
      const destination = args[args.indexOf("--dir") + 1];
      fs.writeFileSync(
        path.join(destination, "Laymux-Android-3.1.0.apk"),
        f.apk,
      );
      fs.writeFileSync(
        path.join(destination, "Laymux-Android-3.1.0.apk.sha256"),
        f.checksum,
      );
      return "";
    }
    if (args[1] === "upload") {
      assert(!args.includes("--clobber"));
      for (const file of args.slice(5)) {
        const uploaded = asset(path.basename(file), fs.readFileSync(file));
        if (f.tamperUpload) uploaded.digest = "sha256:wrong";
        f.target.assets.push(uploaded);
      }
      return "";
    }
    if (args[1] === "edit") {
      f.target.body = fs.readFileSync(
        args[args.indexOf("--notes-file") + 1],
        "utf8",
      );
      return "";
    }
    throw Error(`예상하지 않은 gh 명령: ${args}`);
  };
  f.options = {
    releaseId: "42",
    repository,
    tag: "v3.8.2",
    manifest: manifest(),
    outputDir: dir,
  };
  return f;
}

test("원본 Android 버전과 파일명을 유지하고 데스크톱 버전으로 바꾸지 않는다", () => {
  const plan = planAndroidReuse(manifest(), { repository, tag: "v3.8.2" });
  assert.deepEqual(plan, {
    channel: "stable",
    sourceTag: "v3.1.0",
    apkName: "Laymux-Android-3.1.0.apk",
    checksumName: "Laymux-Android-3.1.0.apk.sha256",
  });
});

test("beta 원본을 허용하되 stable에 beta APK를 복사하지 않는다", () => {
  assert.equal(
    planAndroidReuse(manifest("v3.2.0-beta.1"), {
      repository,
      tag: "v3.9.0-beta.1",
    }).channel,
    "beta",
  );
  assert.throws(() =>
    planAndroidReuse(manifest("v3.2.0-beta.1"), { repository, tag: "v3.8.2" }),
  );
});

test("다른 저장소·다른 파일 URL·자기 릴리스의 원본은 거부한다", () => {
  for (const changed of [
    { releaseUrl: "https://github.com/evil/laymux/releases/tag/v3.1.0" },
    {
      apkUrl:
        "https://github.com/acme/laymux/releases/download/v3.1.0/else.apk",
    },
    { apkSha256Url: "https://example.com/checksum" },
    { versionCode: 1 },
  ])
    assert.throws(() =>
      planAndroidReuse(
        { ...manifest(), ...changed },
        { repository, tag: "v3.8.2" },
      ),
    );
  assert.throws(() =>
    planAndroidReuse(manifest(), { repository, tag: "v3.1.0" }),
  );
});

test("체크섬은 실제 바이트와 정확한 APK 파일명을 검증한다", () => {
  const bytes = Buffer.from("original");
  assert.equal(
    verifyApkChecksum(bytes, `${hash(bytes)} *original.apk\n`, "original.apk"),
    hash(bytes),
  );
  for (const text of [
    `${hash(bytes)} other.apk`,
    `${"0".repeat(64)} original.apk`,
    `${hash(bytes)} ../original.apk`,
    "truncated",
  ]) {
    assert.throws(() => verifyApkChecksum(bytes, text, "original.apk"));
  }
});

test("APK·체크섬의 원본 바이트를 복사하고 버전·원본·SHA 안내를 남긴다", (t) => {
  const f = fixture(t);
  const result = reuseAndroidApk(f.options, f.run);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, result.apkName)), f.apk);
  assert.deepEqual(
    fs.readFileSync(path.join(f.dir, result.checksumName)),
    f.checksum,
  );
  assert.equal(result.sha256, hash(f.apk));
  assert.equal(f.target.assets.length, 3);
  assert(!f.target.assets.some((a) => a.name.includes("Android-3.8.2")));
  const source = JSON.parse(
    fs.readFileSync(path.join(f.dir, "android-apk-source.json"), "utf8"),
  );
  assert.equal(source.androidVersion, "3.1.0");
  assert.equal(source.sourceManifest.releaseUrl, manifest().releaseUrl);
  assert.match(f.target.body, /Existing release notes/);
  assert.match(f.target.body, /Android용 Laymux 앱 \*\*3.1.0\*\*/);
  assert(f.target.body.includes(hash(f.apk)));
  assert(
    f.calls.every(
      (args) =>
        args[0] !== "api" || !args.some((arg) => arg.includes("contents/")),
    ),
  );
});

test("tag REST 조회가 404인 draft도 생성 응답 ID로 복사와 최종 검증을 한다", (t) => {
  const f = fixture(t);
  assert.equal(reuseAndroidApk(f.options, f.run).uploaded.length, 3);
  assert.equal(
    f.calls.filter(
      (args) =>
        args[0] === "api" && args[1] === `repos/${repository}/releases/42`,
    ).length,
    2,
  );
  assert(
    !f.calls.some(
      (args) => args[0] === "api" && args[1].endsWith("/tags/v3.8.2"),
    ),
  );
});

test("잘못된 release ID와 ID·태그가 어긋난 대상은 변경 전에 거부한다", (t) => {
  const f = fixture(t);
  for (const releaseId of [undefined, "", "-1", "42/other"]) {
    assert.throws(
      () => reuseAndroidApk({ ...f.options, releaseId }, f.run),
      /release ID/,
    );
  }
  f.target.id = 99;
  assert.throws(() => reuseAndroidApk(f.options, f.run), /대상 릴리스 ID/);
  assert(!f.calls.some((args) => args[1] === "upload"));
});

test("손상된 APK·체크섬은 업로드 전에 거부한다", (t) => {
  const f = fixture(t);
  f.apk = Buffer.from("changed");
  assert.throws(() => reuseAndroidApk(f.options, f.run), /체크섬/);
  assert(!f.calls.some((args) => args[1] === "upload"));
});

test("원본 첨부 누락과 GitHub digest 불일치를 거부한다", (t) => {
  const f = fixture(t);
  f.source.assets[0].digest = "sha256:wrong";
  assert.throws(() => reuseAndroidApk(f.options, f.run), /원본 GitHub/);
  f.source.assets = [];
  assert.throws(() => reuseAndroidApk(f.options, f.run), /누락/);
  assert(!f.calls.some((args) => args[1] === "upload"));
});

test("대상 동명 충돌을 모두 검사한 뒤에만 업로드하고 덮어쓰지 않는다", (t) => {
  const f = fixture(t);
  f.target.assets.push({ ...f.source.assets[0], digest: "sha256:other" });
  assert.throws(() => reuseAndroidApk(f.options, f.run), /다른 동명/);
  assert(!f.calls.some((args) => args[1] === "upload" || args[1] === "edit"));
});

test("부분 업로드와 동일한 재실행은 기존 첨부·설명을 중복하지 않는다", (t) => {
  const f = fixture(t);
  f.target.assets.push(f.source.assets[1]);
  assert.equal(reuseAndroidApk(f.options, f.run).uploaded.length, 2);
  const calls = f.calls.length;
  assert.deepEqual(reuseAndroidApk(f.options, f.run).uploaded, []);
  assert(
    !f.calls
      .slice(calls)
      .some((args) => args[1] === "upload" || args[1] === "edit"),
  );
  assert.equal(f.target.assets.length, 3);
});

test("공개 릴리스 보충은 명시적 옵션이 있어야 한다", (t) => {
  const f = fixture(t);
  f.target.draft = false;
  assert.throws(() => reuseAndroidApk(f.options, f.run), /allow-published/);
  assert.equal(
    reuseAndroidApk({ ...f.options, allowPublished: true }, f.run).uploaded
      .length,
    3,
  );
});

test("stable에는 비공개 또는 prerelease로 표시된 원본을 복사하지 않는다", (t) => {
  const f = fixture(t);
  f.source.prerelease = true;
  assert.throws(() => reuseAndroidApk(f.options, f.run), /공개된 릴리스/);
  f.source.prerelease = false;
  f.source.draft = true;
  assert.throws(() => reuseAndroidApk(f.options, f.run), /공개된 릴리스/);
  assert(
    !f.calls.some((args) => args[1] === "download" || args[1] === "upload"),
  );
});

test("업로드 후 바이트 검증이 실패하면 성공으로 보고하거나 설명을 쓰지 않는다", (t) => {
  const f = fixture(t);
  f.tamperUpload = true;
  assert.throws(() => reuseAndroidApk(f.options, f.run), /업로드한 첨부/);
  assert(!f.calls.some((args) => args[1] === "edit"));
});

test("Android 미변경 재사용은 기존 입력 변경 검사 뒤 prepare에서 실행한다", () => {
  const workflow = fs.readFileSync(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const guard = workflow.indexOf("Android release inputs changed since");
  const reuse = workflow.indexOf("node scripts/release/reuse-android-apk.mjs");
  assert(guard >= 0 && reuse > guard, "입력 검증 뒤 APK 복사 단계가 필요하다");
  assert.match(workflow, /if:.*inputs\.publish_android == false/);
  assert(
    workflow.includes("RELEASE_ID: ${{ steps.release.outputs.release_id }}"),
  );
  assert(workflow.includes('--release-id "$RELEASE_ID"'));
  assert(
    workflow.includes('"Laymux-Android-" + $version + ".apk"'),
    "bootstrap은 태그와 같은 버전의 원본 APK만 고른다",
  );
  assert(
    workflow.includes(
      'printf \'%s\' "$android_manifest" >"$RUNNER_TEMP/laymux-android-reuse.json"',
    ),
  );
});
