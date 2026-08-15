import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ANDROID_ASSET_ROOT = path.resolve(process.cwd(), "../apps/android/app/src/main/assets");

describe("Android pairing bootstrap assets", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.innerHTML = "<head></head><body></body>";
    delete (window as Window & { LaymuxNative?: unknown }).LaymuxNative;
  });

  it("presents the connection step as a separate dashboard scene and bottom sheet", async () => {
    const html = await readFile(path.join(ANDROID_ASSET_ROOT, "index.html"), "utf8");

    expect(html).not.toContain(">Lx</div>");
    expect(html).toContain('class="connection-stage"');
    expect(html).toContain('class="dashboard-scene"');
    expect(html).toContain('id="dismissLayer"');
    expect(html).toContain('id="connectionSheet"');
    expect(html).toContain('class="sheet-handle"');
    expect(html).toContain('class="status-heading"');
    expect(html).toContain('class="primary-actions"');
    expect(html).toContain('class="connection-settings"');
    expect(html).not.toContain('class="app-header"');
    expect(html).not.toContain('class="security-note"');
  });

  it("animates the sheet out before returning to the unchanged Cloud dashboard path", async () => {
    vi.useFakeTimers();
    const [html, script] = await Promise.all([
      readFile(path.join(ANDROID_ASSET_ROOT, "index.html"), "utf8"),
      readFile(path.join(ANDROID_ASSET_ROOT, "app.js"), "utf8"),
    ]);
    document.open();
    document.write(html);
    document.close();

    const showCloudDashboard = vi.fn();
    (window as Window & { LaymuxNative: unknown }).LaymuxNative = {
      getPairingStatus: () =>
        JSON.stringify({
          selectedInstanceId: "desktop-7",
          paired: false,
          pairings: [],
          biometricRequired: false,
          biometricAvailable: true,
        }),
      showCloudDashboard,
    };
    window.eval(script);

    document.getElementById("dismissLayer")?.click();

    expect(document.getElementById("connectionSheet")).toHaveClass("is-closing");
    expect(showCloudDashboard).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(showCloudDashboard).toHaveBeenCalledOnce();
  });

  it("keeps the sheet open when its own content is touched", async () => {
    vi.useFakeTimers();
    const [html, script] = await Promise.all([
      readFile(path.join(ANDROID_ASSET_ROOT, "index.html"), "utf8"),
      readFile(path.join(ANDROID_ASSET_ROOT, "app.js"), "utf8"),
    ]);
    document.open();
    document.write(html);
    document.close();

    const showCloudDashboard = vi.fn();
    (window as Window & { LaymuxNative: unknown }).LaymuxNative = {
      getPairingStatus: () =>
        JSON.stringify({
          selectedInstanceId: "desktop-7",
          paired: false,
          pairings: [],
          biometricRequired: false,
          biometricAvailable: true,
        }),
      showCloudDashboard,
    };
    window.eval(script);

    document.getElementById("connectionSheet")?.click();
    await vi.runAllTimersAsync();

    expect(document.getElementById("connectionSheet")).not.toHaveClass("is-closing");
    expect(showCloudDashboard).not.toHaveBeenCalled();
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
