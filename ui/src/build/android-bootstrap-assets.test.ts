import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ANDROID_ASSET_ROOT = path.resolve(process.cwd(), "../apps/android/app/src/main/assets");

describe("Android pairing bootstrap assets", () => {
  it("uses the launcher mark and separates status from primary actions", async () => {
    const html = await readFile(path.join(ANDROID_ASSET_ROOT, "index.html"), "utf8");

    expect(html).toContain('src="logo.svg"');
    expect(html).not.toContain(">Lx</div>");
    expect(html).toContain('class="app-header"');
    expect(html).toContain('class="status-heading"');
    expect(html).toContain('class="primary-actions"');
    expect(html).toContain('class="security-note"');
  });

  it("bundles the same colored arrow mark as the Android launcher", async () => {
    const logo = await readFile(path.join(ANDROID_ASSET_ROOT, "logo.svg"), "utf8");

    expect(logo).toContain('viewBox="0 0 120 120"');
    expect(logo).toContain("#f50a3c");
    expect(logo).toContain("#0af1f5");
    expect(logo).toContain("#ffffff");
    expect(logo).not.toContain("<text");
  });
});
