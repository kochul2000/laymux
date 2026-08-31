import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const UI_ROOT = process.cwd();
const REPOSITORY_ROOT = path.resolve(UI_ROOT, "..");

describe("desktop updater release contract", () => {
  it("pins the stable channel manifest and public verification key", async () => {
    const config = JSON.parse(
      await readFile(path.join(REPOSITORY_ROOT, "src-tauri/tauri.conf.json"), "utf8"),
    ) as {
      bundle?: { createUpdaterArtifacts?: boolean };
      plugins?: { updater?: { pubkey?: string; endpoints?: string[] } };
    };

    expect(config.bundle?.createUpdaterArtifacts).toBe(true);
    // The static endpoint is the stable channel manifest; the channel decides at
    // runtime (ADR-0190). Leaving the old `releases/latest` value here would
    // make the config disagree with what a channel-aware build actually reads.
    expect(config.plugins?.updater?.endpoints).toEqual([
      "https://raw.githubusercontent.com/kochul2000/laymux/release-channels/desktop-stable.json",
    ]);
    expect(config.plugins?.updater?.pubkey).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(config.plugins?.updater?.pubkey?.length).toBeGreaterThan(100);
  });

  it("publishes signed desktop artifacts only after a validated draft release succeeds", async () => {
    const workflow = await readFile(
      path.join(REPOSITORY_ROOT, ".github/workflows/release.yml"),
      "utf8",
    );

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("publish_android:");
    expect(workflow).toContain("default: false");
    expect(workflow).not.toContain("types: [published]");
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).toContain('release_json="$(gh api --method POST');
    expect(workflow).toContain('release_id="$(jq -er \'.id\' <<<"$release_json")"');
    expect(workflow).toContain('--arg tag "$RELEASE_TAG"');
    expect(workflow).toContain("select(.tag_name == $tag)");
    expect(workflow).not.toContain("gh release create");
    expect(workflow).not.toContain("/releases/tags/$RELEASE_TAG");
    expect(workflow).toContain("releaseDraft: true");
    // build, android and the channel bootstrap all fan out from prepare.
    expect(workflow.match(/needs: prepare$/gm)).toHaveLength(3);
    expect(workflow).toContain("ref: ${{ needs.prepare.outputs.commit_sha }}");
    expect(workflow).toContain("needs: [prepare, build, android, channel_bootstrap]");
    expect(workflow).toContain("make_latest");
    expect(workflow).toContain("max-parallel: 1");
    expect(workflow).toContain("target: x86_64-pc-windows-msvc");
    expect(workflow).toContain("target: x86_64-unknown-linux-gnu");
    expect(workflow).toMatch(/tauri-apps\/tauri-action@[0-9a-f]{40}/);
    expect(workflow).not.toContain("tauri-apps/tauri-action@v0");
    expect(workflow).toContain(
      "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
    );
    expect(workflow).not.toMatch(/TAURI_SIGNING_PRIVATE_KEY:\s*[A-Za-z0-9+/]{40}/);
  });

  it("publishes channel manifests only from a fully published release", async () => {
    const workflow = await readFile(
      path.join(REPOSITORY_ROOT, ".github/workflows/release.yml"),
      "utf8",
    );

    // The channel branch is what the app reads, so it must never be written
    // from a draft or a partial artifact set (ADR-0190).
    expect(workflow).toContain("needs: [prepare, publish]");
    expect(workflow).toContain("scripts/release/channel-manifest.mjs");
    expect(workflow).toContain("BRANCH: release-channels");
    // Android may be intentionally omitted, but a requested Android artifact is
    // still a hard publish gate.
    expect(workflow).toContain("needs.android.result == 'skipped'");
    expect(workflow).toContain("needs.prepare.outputs.publish_android == 'false'");
    expect(workflow).toContain("needs.prepare.outputs.publish_android == 'true'");
    expect(workflow).not.toContain("needs.prepare.outputs.prerelease == 'false'");
    // General tag grammar is independent of Android's tighter versionCode
    // bounds; the encoder runs only for an Android publication.
    expect(workflow).toContain("release-version.mjs --validate");
    expect(workflow).toContain("scripts/release/android-version-code.mjs");
    expect(workflow).toContain('--publish-android "$PUBLISH_ANDROID"');
    expect(workflow).toContain("Android release inputs changed since");
    expect(workflow).toContain("src-tauri/Cargo.toml version");
    // Neither channel may be a 404 by the time a channel-aware build is latest,
    // so seeding gates publish instead of trailing it.
    expect(workflow).toContain("--seed-stable true");
    expect(workflow).toContain("needs: [prepare, build, android, channel_bootstrap]");
    // Forwardness is refused before publish, not after the release went latest.
    expect(workflow).toContain("release-version.mjs");
    // The branch is written through the API, never a clone carrying a credential.
    expect(workflow).toContain("publish-channel-commit.sh");
    expect(workflow).not.toContain("x-access-token:$GH_TOKEN@github.com");
  });
});
