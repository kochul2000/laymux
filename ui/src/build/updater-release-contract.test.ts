import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const UI_ROOT = process.cwd();
const REPOSITORY_ROOT = path.resolve(UI_ROOT, "..");

describe("desktop updater release contract", () => {
  it("pins the GitHub endpoint and public verification key", async () => {
    const config = JSON.parse(
      await readFile(path.join(REPOSITORY_ROOT, "src-tauri/tauri.conf.json"), "utf8"),
    ) as {
      bundle?: { createUpdaterArtifacts?: boolean };
      plugins?: { updater?: { pubkey?: string; endpoints?: string[] } };
    };

    expect(config.bundle?.createUpdaterArtifacts).toBe(true);
    expect(config.plugins?.updater?.endpoints).toEqual([
      "https://github.com/kochul2000/laymux/releases/latest/download/latest.json",
    ]);
    expect(config.plugins?.updater?.pubkey).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(config.plugins?.updater?.pubkey?.length).toBeGreaterThan(100);
  });

  it("signs serialized Windows and Linux updater artifacts without embedding a private key", async () => {
    const workflow = await readFile(
      path.join(REPOSITORY_ROOT, ".github/workflows/release.yml"),
      "utf8",
    );

    expect(workflow).toContain("max-parallel: 1");
    expect(workflow).toContain("target: x86_64-pc-windows-msvc");
    expect(workflow).toContain("target: x86_64-unknown-linux-gnu");
    expect(workflow).toContain(
      "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
    );
    expect(workflow).not.toMatch(/TAURI_SIGNING_PRIVATE_KEY:\s*[A-Za-z0-9+/]{40}/);
  });
});
