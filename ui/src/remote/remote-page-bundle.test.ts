import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// The Rust remote server serves the committed minified artifacts, so an edit
// to the readable sources without `npm run build:remote-page` would silently
// ship a stale client (ADR-0169). The build stamps the source hashes into the
// artifact banner; this test recomputes them.
const ASSETS_DIR = path.resolve(__dirname, "../../../src-tauri/src/remote_server/assets");
const PAGE_PATH = path.resolve(ASSETS_DIR, "../page.html");
const APP_SOURCE_PATH = path.resolve(ASSETS_DIR, "remote-app.js");
const ICON_SOURCE_PATH = path.resolve(__dirname, "./remote-icons.js");
const CODEX_TRANSCRIPT_WHEEL_SOURCE_PATH = path.resolve(
  __dirname,
  "../lib/codex-transcript-wheel.ts",
);
const PACKAGE_LOCK_PATH = path.resolve(__dirname, "../../package-lock.json");

const sourceHash = (file: string): string =>
  createHash("sha256")
    .update(readFileSync(path.join(ASSETS_DIR, file)))
    .digest("hex")
    .slice(0, 16);

const fileHash = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);

interface PackageLock {
  packages: Record<string, { version?: string; resolved?: string; integrity?: string } | undefined>;
}

const packageInputHash = (lock: PackageLock, packageName: string): string => {
  const input = lock.packages[`node_modules/${packageName}`];
  if (!input?.version || !input.integrity) throw new Error(`Missing ${packageName} lock input`);
  return createHash("sha256")
    .update(JSON.stringify([input.version, input.resolved, input.integrity]))
    .digest("hex")
    .slice(0, 16);
};

describe("remote page bundle", () => {
  it("committed minified artifacts match the sources", () => {
    const banner = readFileSync(path.join(ASSETS_DIR, "remote-app.min.js"), "utf8").split("\n", 8);
    const stamp = banner.find((line) => line.startsWith("// Source-SHA256:"));
    const lock = JSON.parse(readFileSync(PACKAGE_LOCK_PATH, "utf8")) as PackageLock;
    expect(stamp).toBe(
      `// Source-SHA256: remote-app.js=${sourceHash("remote-app.js")}` +
        ` remote-app.css=${sourceHash("remote-app.css")}` +
        ` remote-icons.js=${fileHash(ICON_SOURCE_PATH)}` +
        ` codex-transcript-wheel.ts=${fileHash(CODEX_TRANSCRIPT_WHEEL_SOURCE_PATH)}` +
        ` lucide-package=${packageInputHash(lock, "lucide")}`,
    );
  });

  it("artifacts carry the do-not-edit banner", () => {
    const js = readFileSync(path.join(ASSETS_DIR, "remote-app.min.js"), "utf8");
    expect(js.startsWith("// GENERATED FILE - DO NOT EDIT.")).toBe(true);
  });

  it("does not paint the browser focus outline on the initial navigation menu button", () => {
    const css = readFileSync(path.join(ASSETS_DIR, "remote-app.css"), "utf8");
    const bundledCss = readFileSync(path.join(ASSETS_DIR, "remote-app.min.css"), "utf8");

    expect(css).toMatch(/\.menu-button:focus\s*\{[^}]*outline:\s*none;/s);
    expect(bundledCss).toContain(".menu-button:focus{outline:none}");
  });

  it("routes every generic Remote pictogram through the Lucide icon boundary", () => {
    const page = readFileSync(PAGE_PATH, "utf8");
    const app = readFileSync(APP_SOURCE_PATH, "utf8");
    const icons = readFileSync(ICON_SOURCE_PATH, "utf8");

    expect(icons).toContain('from "lucide"');
    expect(page).not.toMatch(/<svg\b/);
    expect(app).not.toMatch(/<svg\b/);
    expect(app).not.toContain('dot.textContent = "●"');
    expect(app).not.toContain("status.textContent = pane.selectorStatus.icon");
    expect(app).not.toContain('"✓ Signed in');
    expect(app).not.toContain('"✓ 로그인 성공');
    expect(app).toContain('setRemoteIcon(icon, "Check", { size: 12 });');
    const shell = new DOMParser().parseFromString(page, "text/html");

    for (const id of [
      "navToggle",
      "copyPaneId",
      "statusSpinner",
      "fileExplorerHeader",
      "spatialExclusion",
      "newWorkspace",
      "hiddenWorkspaceToggle",
      "drawerNotificationsButton",
      "drawerConnectionButton",
      "drawerSettingsButton",
      "drawerBack",
      "scrollToBottom",
      "attachFile",
      "composerSend",
      "fileViewerBack",
      "fileViewerZoomOut",
      "fileViewerZoomIn",
      "fileViewerClose",
    ]) {
      expect(shell.getElementById(id)?.querySelector("[data-remote-icon]")).not.toBeNull();
    }
  });

  it("keeps the desktop and Remote Lucide packages on the same icon version", () => {
    const lock = JSON.parse(readFileSync(PACKAGE_LOCK_PATH, "utf8")) as PackageLock;

    expect(lock.packages["node_modules/lucide"]?.version).toBe(
      lock.packages["node_modules/lucide-react"]?.version,
    );
  });
});
